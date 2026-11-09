'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  PROTOCOL_VERSION,
  HANDSHAKE_TIMEOUT_MS,
  AUTH_LABEL,
} = require('./constants');
const {
  isIdentity,
  identityOfPeerKey,
  sanitizeField,
  signPayload,
  verifyPayload,
} = require('../../shared/protocol');
const {
  sha256,
  hmac,
  hkdf,
  xorZero,
  encryptFrame,
  decryptFrame,
} = require('./crypto');
const { FrameSocket } = require('./frame-socket');
const { createMemoryStore } = require('./memory-store');

class SecureManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.identityKey = options.identityKey || null;
    if (!this.identityKey || !this.identityKey.id || !this.identityKey.privateKey) {
      throw new Error('SecureManager 需要 Ed25519 身份密钥');
    }
    this.identity = String(options.identity || this.identityKey.id);
    if (this.identity !== this.identityKey.id) {
      throw new Error('SecureManager 的 identity 与身份密钥不匹配');
    }
    this.user = String(options.user || '');
    this.host = String(options.host || '');
    this.port = Number(options.port) || 0;
    this.selfOnline = options.online !== false;
    this.getPeer = options.getPeer || (() => null);
    this.connectStream = options.connectStream || null;
    this.onPeerSeen = options.onPeerSeen || (() => {});
    this.store = options.store || createMemoryStore();
    this.sessions = new Map(); // peerKey -> session
    this.migrations = new Map(); // peerKey -> 正在替换旧会话的新会话
    this.byId = new Map(); // sessionId -> session
    this.lastAutoAttempt = new Map();
    this.autoPaused = new Set();
  }

  setOnline(online) {
    this.selfOnline = !!online;
    if (this.selfOnline) this.lastAutoAttempt.clear();
  }

  isActive(peerKey) {
    const session = this.sessions.get(peerKey);
    return !!(session && session.active);
  }

  getSession(peerKey) {
    return this.sessions.get(peerKey) || null;
  }

  hasPending(peerKey) {
    return this.sessions.has(peerKey) || this.migrations.has(peerKey);
  }

  getActiveSessions() {
    return [...this.sessions.values()]
      .filter((session) => session.active)
      .map((session) => ({
        peerKey: session.peerKey,
        peerName: session.peerName,
        sessionId: session.sessionId,
        mode: session.mode,
        transport: session.transport || null,
        temporary: !!session.temporary,
        authenticated: !!session.authenticated,
        code: session.mode === 'pair' ? (session.sas || null) : null,
      }));
  }

  listPairings() {
    try {
      return this.store.list();
    } catch {
      return [];
    }
  }

  hasPairing(peerKey) {
    return !!this._getPairing(peerKey);
  }

  start(peerKey, options = {}) {
    if (!this.selfOnline) throw new Error('当前已下线，上线后才能认证身份');
    if (peerKey === `id:${this.identity}`) throw new Error('不能与自己建立认证会话');
    const peer = this.getPeer(peerKey);
    if (!peer) throw new Error('对方不在线');
    if (!peer.online) throw new Error('对方已离线');
    const current = this.sessions.get(peerKey);
    if (current) {
      // 在已运行的临时会话上显式点击“认证加密”时，通知双方进入 6 位码
      // 核对流程；这不会中断已经启用的加密连接。
      if (current.active && current.temporary && current.mode === 'pair' && !options.auto) {
        // 延后一个事件循环，调用方可以在 start() 返回后先注册 sas 监听。
        setImmediate(() => this._requestAuthentication(current));
      }
      return {
        sessionId: current.sessionId,
        mode: current.mode,
        status: current.active ? 'active' : 'pending',
        temporary: !!current.temporary,
        authenticated: !!current.authenticated,
        code: current.mode === 'pair' ? (current.sas || null) : null,
      };
    }

    const pairing = this._getPairing(peerKey);
    const mode = pairing ? 'resume' : 'pair';
    const session = this._createSession({
      peerKey,
      peer,
      role: 'initiator',
      mode,
      psk: pairing ? pairing.key : null,
      auto: !!options.auto,
      temporary: mode === 'pair' && !!options.auto,
    });

    if (typeof this.connectStream !== 'function') {
      throw new Error('传输层未提供 connectStream');
    }
    const socket = this.connectStream(peerKey, 'secure-handshake', { timeout: 0, keepAlive: true });
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    if (typeof socket.setTimeout === 'function') socket.setTimeout(0);
    if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, 30000);
    session.socket = socket;
    session.transport = socket.transport || '';
    session.frame = new FrameSocket(socket, (frame) => this._handleFrame(session, frame));

    socket.once('connect', () => {
      try {
        session.frame.send({
          kind: 'secure-handshake',
          t: 'hs',
          step: 'hello',
          v: PROTOCOL_VERSION,
          sessionId: session.sessionId,
          mode,
          temporary: !!session.temporary,
          fromKey: this.identity,
          fromUser: this.user,
          fromHost: this.host,
          fromPort: this.port,
          commit: session.local.commit.toString('hex'),
          nonce: session.local.nonce.toString('hex'),
        }).catch((error) => this._failSession(session, error.message || '握手发送失败'));
      } catch (error) {
        this._failSession(session, error.message || '握手发送失败');
      }
    });
    socket.on('error', (error) => this._failSession(session, error.message || '连接失败'));
    socket.on('close', () => {
      if (!session.closed) this._failSession(session, '加密连接已断开', { pairingKeep: true });
    });

    session.timer = setTimeout(() => {
      this._failSession(session, '加密握手超时');
    }, HANDSHAKE_TIMEOUT_MS);
    if (typeof session.timer.unref === 'function') session.timer.unref();

    this.sessions.set(peerKey, session);
    this.byId.set(session.sessionId, session);
    this.emit('pending', {
      sessionId: session.sessionId,
      peerKey,
      peerName: peer.user,
      mode,
      temporary: !!session.temporary,
      auto: !!options.auto,
    });
    return {
      sessionId: session.sessionId,
      mode,
      status: 'pending',
      temporary: !!session.temporary,
      authenticated: false,
      code: null,
    };
  }

  handleIncoming(socket, header, initial) {
    if (!this.selfOnline) {
      // 下线时对外表现为“完全不在线”：不握手、不回应、不泄露在线状态。
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    const sessionId = String((header && header.sessionId) || '').slice(0, 64);
    if (!header || header.t !== 'hs' || header.step !== 'hello') {
      this._rejectSocket(socket, 'bad-hello', '加密握手格式错误', sessionId);
      return;
    }
    if (header.v !== PROTOCOL_VERSION) {
      // 协议版本不匹配时直接断开，不返回错误帧，也不尝试兼容旧握手。
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    if (header.mode !== 'pair' && header.mode !== 'resume') {
      this._rejectSocket(socket, 'bad-mode', '加密握手模式无效', sessionId);
      return;
    }
    const fromKey = String(header.fromKey || '');
    if (!sessionId || !isIdentity(fromKey) || fromKey === this.identity) {
      this._rejectSocket(socket, 'bad-identity', '加密握手身份无效', sessionId);
      return;
    }
    const peerKey = `id:${fromKey}`;
    const existingPeer = this.getPeer(peerKey);
    // 先使用 hello 里的自称资料，但不在 proof 通过前写入全局联系人表，
    // 防止未认证的 TCP 连接伪造在线状态/名称/端口。
    const peer = {
      ...(existingPeer || {}),
      key: peerKey,
      user: sanitizeField(header.fromUser, '未知联系人'),
      host: sanitizeField(header.fromHost, '未知主机'),
      port: Number(header.fromPort) || 0,
      ip: (existingPeer && existingPeer.ip) || socket.remoteAddress || socket.peerAddress || '',
      online: true,
    };
    let existing = this.sessions.get(peerKey);
    // 物理断链时可能只有一侧立即发现。允许对端用已配对密钥发起
    // 跨传输 resume 来替换旧会话；新握手完成前旧会话继续可用，
    // 未通过 proof 的攻击者无法借此中断现有会话。
    const migrating = !!(existing && existing.active
      && header.mode === 'resume'
      && this._getPairing(peerKey)
      && existing.transport
      && socket.transport
      && existing.transport !== socket.transport);
    const mode = header.mode;
    const pairing = this._getPairing(peerKey);
    const temporary = mode === 'pair' && header.temporary === true;
    // 双方同时发出第一条消息时可能同时发起临时加密握手。用 identity
    // 决定保留哪一侧的握手：较小一侧保留自己的主动连接，较大一侧
    // 丢弃自己的连接并接受对方，避免双方互相 busy 而永远建不起来。
    if (existing && !existing.active && existing.mode === mode && mode === 'pair'
      && this.identity > fromKey) {
      this._failSession(existing, '双方同时建立加密会话', { pairingKeep: true, quiet: true });
      existing = this.sessions.get(peerKey);
    }
    if ((existing && !migrating) || this.migrations.has(peerKey)) {
      this._rejectSocket(socket, 'busy', '已有加密会话正在建立', sessionId);
      return;
    }
    if (mode === 'resume' && !pairing) {
      this._rejectSocket(socket, 'no-pairing', '本机没有保存该联系人的加密密钥', sessionId);
      this.emit('warning', {
        peerKey,
        peerName: peer.user,
        code: 'no-pairing',
        message: '对方尝试恢复身份认证，但本机没有保存该联系人的认证密钥；请让对方在其本机选择重新认证。',
        canReset: false,
      });
      return;
    }
    if (mode === 'pair' && pairing) {
      // 已有认证记录时，不允许对端用新的 pair 握手覆盖旧配对。
      // 对方主动发起 pair 通常意味着对方已丢失旧配对；停止自动恢复，等待用户手动重新认证。
      this.autoPaused.add(peerKey);
      this._rejectSocket(socket, 'pairing-exists', '本机已有该联系人的认证记录，请在本机选择重新认证', sessionId);
      this.emit('warning', {
        peerKey,
        peerName: peer.user,
        code: 'pairing-exists',
        message: '对方发起认证，但本机仍保存旧认证。请点击「重新认证」解除本机旧认证并重新建立。',
        canReset: true,
      });
      return;
    }

    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    if (typeof socket.setTimeout === 'function') socket.setTimeout(0);
    if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, 30000);
    const session = this._createSession({
      peerKey,
      peer,
      role: 'responder',
      mode,
      psk: pairing ? pairing.key : null,
      auto: temporary,
      temporary,
    });
    session.sessionId = sessionId;
    session.migrating = migrating;
    session.socket = socket;
    session.transport = socket.transport || '';
    session.frame = new FrameSocket(socket, (frame) => this._handleFrame(session, frame), initial);
    session.local.commit = this._commit(session, session.local.pub, session.local.nonce);
    session.peer.commit = Buffer.from(String(header.commit || ''), 'hex');
    session.peer.nonce = Buffer.from(String(header.nonce || ''), 'hex');
    session.peer.claimedKey = fromKey;

    socket.on('error', (error) => this._failSession(session, error.message || '连接失败'));
    socket.on('close', () => {
      if (!session.closed) this._failSession(session, '加密连接已断开', { pairingKeep: true });
    });

    session.timer = setTimeout(() => {
      this._failSession(session, '加密握手超时');
    }, HANDSHAKE_TIMEOUT_MS);
    if (typeof session.timer.unref === 'function') session.timer.unref();

    this.byId.set(session.sessionId, session);
    if (migrating) this.migrations.set(peerKey, session);
    else this.sessions.set(peerKey, session);
    session.frame.send({
      t: 'hs',
      step: 'commit',
      sessionId: session.sessionId,
      commit: session.local.commit.toString('hex'),
      nonce: session.local.nonce.toString('hex'),
    }).catch((error) => this._failSession(session, error.message || '握手发送失败'));
    this.emit('pending', {
      sessionId: session.sessionId,
      peerKey,
      peerName: peer.user,
      mode,
      incoming: true,
    });
  }

  confirm(sessionId) {
    const session = this.byId.get(sessionId);
    if (!session || session.closed) return false;
    if (session.role !== 'initiator' && session.role !== 'responder') return false;
    if (session.mode !== 'pair') return false;
    // 临时会话已经加密运行，确认只用于升级为持久认证会话。
    if (session.active && !session.temporary) return true;
    if (!session.sasReady) return false;
    if (session.localConfirmed) return true;
    session.localConfirmed = true;
    this._sendEncrypted(session, { type: 'confirm' }).catch((error) => {
      this._failSession(session, error.message || '确认发送失败');
    });
    if (session.active) this._maybeMarkTemporaryAuthenticated(session);
    else this._maybeActivatePair(session);
    return true;
  }

  cancel(sessionId, reason = '用户取消') {
    const session = this.byId.get(sessionId);
    if (!session) return false;
    if (session.active) {
      this.closePeer(session.peerKey, reason);
      return true;
    }
    this._sendEncrypted(session, { type: 'cancel', reason }).catch(() => {});
    this._failSession(session, reason);
    return true;
  }

  closePeer(peerKey, reason = '加密会话已关闭') {
    const session = this.sessions.get(peerKey);
    const pending = this.migrations.get(peerKey);
    if (pending) this._failSession(pending, reason, { pairingKeep: true });
    if (!session) return;
    if (session.active) {
      this._sendEncrypted(session, { type: 'close', reason }).catch(() => {});
    }
    this._failSession(session, reason, { pairingKeep: true, notify: true });
  }

  closeAll(reason = '应用离线') {
    const keys = new Set([...this.sessions.keys(), ...this.migrations.keys()]);
    for (const peerKey of keys) {
      this.closePeer(peerKey, reason);
    }
  }

  pause(peerKey) {
    const session = this.sessions.get(peerKey);
    if (session && session.frame) session.frame.pause();
  }

  resume(peerKey) {
    const session = this.sessions.get(peerKey);
    if (session && session.frame) session.frame.resume();
  }

  async send(peerKey, payload) {
    const session = this.sessions.get(peerKey);
    if (!session || !session.active) throw new Error('加密会话未建立');
    return this._sendEncrypted(session, payload);
  }

  handlePeerOnline(peer, options = {}) {
    if (!this.selfOnline || !peer || !peer.online) return;
    if (this.sessions.has(peer.key)) return;
    if (this.autoPaused.has(peer.key)) return;
    if (options.force) this.lastAutoAttempt.delete(peer.key);
    const pairing = this._getPairing(peer.key);
    if (!pairing) return;
    const peerIdentity = String(peer.key).replace(/^id:/, '');
    // 双方同时上线时，由 identity 较小的一侧发起，避免重复握手。
    if (this.identity >= peerIdentity) return;
    const now = Date.now();
    if (!options.force && now - (this.lastAutoAttempt.get(peer.key) || 0) < 4000) return;
    this.lastAutoAttempt.set(peer.key, now);
    try {
      this.start(peer.key, { auto: true });
    } catch (error) {
      this.emit('warning', { peerKey: peer.key, message: error.message || String(error) });
    }
  }

  autoResumeAll(peers = []) {
    for (const peer of peers) {
      try {
        this.handlePeerOnline(peer);
      } catch (error) {
        this.emit('warning', { peerKey: peer.key, message: error.message || String(error) });
      }
    }
  }

  // ------------------------------------------------------------ handshake

  _createSession({ peerKey, peer, role, mode, psk, auto = false, temporary = false }) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' });
    const nonce = crypto.randomBytes(16);
    const session = {
      sessionId: crypto.randomBytes(12).toString('hex'),
      peerKey,
      peerName: peer.user || '未知联系人',
      peerInfo: peer,
      role,
      mode,
      psk,
      auto: !!auto,
      temporary: !!temporary,
      authenticated: false,
      local: { publicKey, privateKey, pub, nonce, commit: null },
      peer: { pub: null, nonce: null, commit: null, claimedKey: null },
      socket: null,
      frame: null,
      keys: null,
      transcript: null,
      transcriptHash: null,
      sendCounter: 0,
      recvCounter: 0,
      active: false,
      migrating: false,
      localConfirmed: false,
      peerConfirmed: false,
      localProof: false,
      peerProof: false,
      proofDone: false,
      peerSeen: false,
      sasReady: false,
      revealSent: false,
      authSent: false,
      peerAuthed: false,
      pairingKey: null,
      closed: false,
      timer: null,
    };
    session.local.commit = this._commit(session, pub, nonce);
    return session;
  }

  _commit(session, pub, nonce, role = session.role) {
    return sha256(Buffer.from('feige-commit'), Buffer.from(session.sessionId), Buffer.from(role), pub, nonce);
  }

  _handleFrame(session, frame) {
    if (!session || session.closed || !frame) return;
    if (frame.t === 'hs') {
      // commit/reveal 帧不带版本号；凡是带版本号的握手帧都必须严格匹配。
      if (frame.v != null && frame.v !== PROTOCOL_VERSION) {
        this._failSession(session, '加密协议版本不匹配');
        return;
      }
      this._handleHandshake(session, frame);
      return;
    }
    if (frame.t === 'enc') {
      if (!session.keys) return;
      let payload;
      try {
        payload = decryptFrame(session.keys.recvKey, session.keys.recvNoncePrefix, session.recvCounter, frame);
      } catch (error) {
        this._failSession(session, '加密消息校验失败');
        return;
      }
      session.recvCounter += 1;
      this._handleEncrypted(session, payload);
    }
  }

  _handleHandshake(session, frame) {
    const step = frame.step;
    if (step === 'error') {
      this._handleErrorFrame(session, frame);
      return;
    }
    if (step === 'commit') {
      if (session.peer.commit) return;
      session.peer.commit = Buffer.from(String(frame.commit || ''), 'hex');
      session.peer.nonce = Buffer.from(String(frame.nonce || ''), 'hex');
      session.frame.send({
        t: 'hs',
        step: 'reveal',
        sessionId: session.sessionId,
        pub: session.local.pub.toString('hex'),
        nonce: session.local.nonce.toString('hex'),
      }).catch((error) => this._failSession(session, error.message || '握手发送失败'));
      return;
    }
    if (step === 'reveal') {
      const pub = Buffer.from(String(frame.pub || ''), 'hex');
      const nonce = Buffer.from(String(frame.nonce || ''), 'hex');
      if (!pub.length || !nonce.length) {
        this._failSession(session, '握手公钥无效');
        return;
      }
      session.peer.pub = pub;
      session.peer.nonce = nonce;
      if (!session.peer.commit) {
        this._failSession(session, '缺少对方承诺');
        return;
      }
      const peerRole = session.role === 'initiator' ? 'responder' : 'initiator';
      const expected = this._commit(session, pub, nonce, peerRole);
      if (session.peer.commit.length !== expected.length || !crypto.timingSafeEqual(session.peer.commit, expected)) {
        this._failSession(session, '哈希承诺校验失败');
        return;
      }
      if (session.role === 'responder' && !session.revealSent) {
        session.revealSent = true;
        session.frame.send({
          t: 'hs',
          step: 'reveal',
          sessionId: session.sessionId,
          pub: session.local.pub.toString('hex'),
          nonce: session.local.nonce.toString('hex'),
        }).catch((error) => this._failSession(session, error.message || '握手发送失败'));
      }
      this._deriveKeys(session);
      return;
    }
    if (step === 'proof') {
      if (!session.transcriptHash || !session.keys) return;
      if (String(frame.sessionId || '') !== session.sessionId) return;
      if (frame.v !== PROTOCOL_VERSION) {
        this._failSession(session, '加密协议版本不匹配');
        return;
      }
      const expectedPeer = identityOfPeerKey(session.peerKey);
      if (String(frame.fromKey || '') !== expectedPeer) return;
      const { sig, ...payload } = frame;
      if (!verifyPayload(expectedPeer, payload, sig)) {
        // 未签名的 proof 直接忽略；真正的对端 proof 仍可继续到达。
        return;
      }
      if (session.peerProof) return;
      session.peerProof = true;
      this._maybeAfterProof(session);
      return;
    }
    if (step === 'auth') {
      if (!session.proofDone) {
        this._failSession(session, '认证前缺少握手签名', { pairingKeep: true });
        return;
      }
      if (session.mode !== 'resume' || !session.psk) {
        this._failSession(session, '加密认证模式不匹配', { pairingKeep: true });
        return;
      }
      const expected = this._authMac(session);
      const received = Buffer.from(String(frame.mac || ''), 'hex');
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        // 认证失败只结束本次握手，绝不自动删除已有配对。
        this._sendErrorFrame(session, 'auth-failed', '加密密钥校验失败');
        this.emit('warning', {
          peerKey: session.peerKey,
          peerName: session.peerName,
          code: 'auth-failed',
          message: '身份认证失败，可能是双方认证密钥不一致；如双方都提示失败，请双方都在本机选择重新认证。',
          canReset: true,
        });
        this._failSession(session, '加密密钥校验失败', { pairingKeep: true, graceful: true });
        return;
      }
      session.peerAuthed = true;
      this._maybeActivateResume(session);
      return;
    }
  }

  _handleErrorFrame(session, frame) {
    const expectedPeer = identityOfPeerKey(session.peerKey);
    if (String(frame.sessionId || '') !== session.sessionId) return;
    if (String(frame.fromKey || '') !== expectedPeer) return;
    const { sig, ...payload } = frame;
    if (!verifyPayload(expectedPeer, payload, sig)) {
      // 不信任未签名的错误帧，避免被第三方伪造“会话丢失”。
      return;
    }
    const code = String(frame.code || '');
    // 这些错误都说明双方认证状态不一致，继续自动重试只会反复提示。
    // 暂停自动恢复，等待用户显式「重新认证」。
    if (code === 'no-pairing' || code === 'pairing-exists' || code === 'auth-failed') {
      this.autoPaused.add(session.peerKey);
    }
    const messages = {
      'no-pairing': '对方没有保存配对密钥；本机仍保存配对，请选择重新认证。',
      'pairing-exists': '对方仍保存旧认证，已拒绝本次认证；请等待对方在本机点击「重新认证」。',
      'auth-failed': '身份认证失败；如双方都提示失败，请双方都在本机选择重新认证。',
    };
    const message = messages[code] || String(frame.message || code || '对方拒绝了身份认证');
    if (code === 'no-pairing' || code === 'auth-failed' || code === 'pairing-exists') {
      this.emit('warning', {
        peerKey: session.peerKey,
        peerName: session.peerName,
        code,
        message,
        pairingRemoved: false,
        // no-pairing: 本机仍保存配对，可以本机重置后重新认证；
        // pairing-exists: 本机没有配对，对端仍保存，必须由对端重置；
        // auth-failed: 双方都可能需要重置。
        canReset: code !== 'pairing-exists',
      });
    }
    // busy 是对端也在同时发起握手，属于正常的竞态；静默失败后
    // 自动发送会继续等待对端那条握手完成。
    this._failSession(session, message, { pairingKeep: true, quiet: code === 'busy' });
  }

  _proofPayload(session) {
    return {
      t: 'hs',
      step: 'proof',
      v: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      fromKey: this.identity,
      transcript: session.transcriptHash.toString('hex'),
    };
  }

  _sendProof(session) {
    if (session.proofSent) return;
    session.proofSent = true;
    const payload = this._proofPayload(session);
    const frame = { ...payload, sig: signPayload(this.identityKey.privateKey, payload) };
    session.localProof = true;
    session.frame.send(frame).catch((error) => {
      this._failSession(session, error.message || '握手签名发送失败', { pairingKeep: true });
    });
    this._maybeAfterProof(session);
  }

  _maybeAfterProof(session) {
    if (!session.localProof || !session.peerProof || session.proofDone) return;
    session.proofDone = true;
    if (!session.peerSeen) {
      session.peerSeen = true;
      try {
        this.onPeerSeen({
          key: session.peerKey,
          ip: session.peerInfo.ip,
          port: session.peerInfo.port,
          user: session.peerInfo.user,
          host: session.peerInfo.host,
          online: true,
        });
      } catch {
        /* ignore */
      }
    }
    if (session.mode === 'resume') {
      this._sendAuth(session);
      return;
    }
    session.sasReady = true;
    this.emit('sas', {
      sessionId: session.sessionId,
      peerKey: session.peerKey,
      peerName: session.peerName,
      code: session.sas,
      mode: 'pair',
      temporary: !!session.temporary,
      auto: !!session.auto,
      incoming: session.role === 'responder',
    });
    if (session.temporary) {
      // 临时会话不要求核对 6 位码；先立即启用加密，认证随后可选进行。
      this._activate(session, 'pair');
      this._maybeMarkTemporaryAuthenticated(session);
    }
  }

  _errorPayload(sessionId, code, message) {
    return {
      t: 'hs',
      step: 'error',
      v: PROTOCOL_VERSION,
      sessionId: String(sessionId || ''),
      fromKey: this.identity,
      code: String(code || ''),
      message: String(message || ''),
      ts: Date.now(),
      nonce: crypto.randomBytes(8).toString('hex'),
    };
  }

  _sendErrorFrame(session, code, message) {
    if (!session || !session.frame) return;
    const payload = this._errorPayload(session.sessionId, code, message);
    session.frame.send({
      ...payload,
      sig: signPayload(this.identityKey.privateKey, payload),
    }).catch(() => {});
  }

  _deriveKeys(session) {
    if (session.keys) return;
    if (!session.peer.pub) return;
    let peerPublic;
    try {
      peerPublic = crypto.createPublicKey({ key: session.peer.pub, format: 'der', type: 'spki' });
    } catch {
      this._failSession(session, '对方 DH 公钥无效');
      return;
    }
    let shared;
    try {
      shared = crypto.diffieHellman({ privateKey: session.local.privateKey, publicKey: peerPublic });
    } catch {
      this._failSession(session, 'DH 密钥协商失败');
      return;
    }
    if (!shared.length || xorZero(shared)) {
      this._failSession(session, 'DH 共享密钥无效');
      return;
    }

    const initiator = session.role === 'initiator'
      ? {
        id: this.identity,
        user: this.user,
        host: this.host,
        port: this.port,
        commit: session.local.commit,
        pub: session.local.pub,
        nonce: session.local.nonce,
      }
      : {
        id: session.peerKey.replace(/^id:/, ''),
        user: session.peerInfo.user,
        host: session.peerInfo.host,
        port: session.peerInfo.port,
        commit: session.peer.commit,
        pub: session.peer.pub,
        nonce: session.peer.nonce,
      };
    const responder = session.role === 'responder'
      ? { id: this.identity, commit: session.local.commit, pub: session.local.pub, nonce: session.local.nonce }
      : { id: session.peerKey.replace(/^id:/, ''), commit: session.peer.commit, pub: session.peer.pub, nonce: session.peer.nonce };

    session.transcript = Buffer.from(JSON.stringify({
      v: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      mode: session.mode,
      initiator: {
        id: initiator.id,
        user: initiator.user,
        host: initiator.host,
        port: initiator.port,
        commit: initiator.commit.toString('hex'),
        pub: initiator.pub.toString('hex'),
        nonce: initiator.nonce.toString('hex'),
      },
      responder: {
        id: responder.id,
        commit: responder.commit.toString('hex'),
        pub: responder.pub.toString('hex'),
        nonce: responder.nonce.toString('hex'),
      },
    }));
    const salt = sha256(session.transcript);
    const modeInfo = session.mode === 'resume' ? 'resume' : 'pair';
    const ikm = session.mode === 'resume' && session.psk
      ? Buffer.concat([shared, session.psk])
      : shared;
    const okm = hkdf(ikm, salt, `${AUTH_LABEL}:${modeInfo}`, 72);
    const initiatorToResponder = okm.subarray(0, 32);
    const responderToInitiator = okm.subarray(32, 64);
    const initiatorNonce = okm.subarray(64, 68);
    const responderNonce = okm.subarray(68, 72);
    session.keys = session.role === 'initiator'
      ? {
          sendKey: initiatorToResponder,
          recvKey: responderToInitiator,
          sendNoncePrefix: initiatorNonce,
          recvNoncePrefix: responderNonce,
        }
      : {
          sendKey: responderToInitiator,
          recvKey: initiatorToResponder,
          sendNoncePrefix: responderNonce,
          recvNoncePrefix: initiatorNonce,
        };
    session.transcriptHash = salt;
    session.sas = (() => {
      const value = hkdf(shared, salt, `${AUTH_LABEL}:sas`, 4).readUInt32BE(0) % 1000000;
      return String(value).padStart(6, '0');
    })();
    session.pairingKey = hkdf(shared, salt, `${AUTH_LABEL}:pairing`, 32);

    this._sendProof(session);
  }

  _authMac(session) {
    return hmac(session.psk, Buffer.from(`${AUTH_LABEL}:auth`), session.transcript);
  }

  _sendAuth(session) {
    if (!session.proofDone) return;
    if (session.authSent) return;
    session.authSent = true;
    session.frame.send({
      t: 'hs',
      step: 'auth',
      sessionId: session.sessionId,
      mac: this._authMac(session).toString('hex'),
    }).catch((error) => this._failSession(session, error.message || '认证发送失败'));
    this._maybeActivateResume(session);
  }

  _maybeActivateResume(session) {
    if (session.mode !== 'resume' || !session.proofDone || !session.authSent || !session.peerAuthed) return;
    if (session.active) return;
    this._activate(session, 'resume');
  }

  _handleEncrypted(session, payload) {
    if (!payload || typeof payload.type !== 'string') return;
    if (payload.type === 'auth-request') {
      if (session.active && session.temporary && session.sasReady) {
        this.emit('sas', {
          sessionId: session.sessionId,
          peerKey: session.peerKey,
          peerName: session.peerName,
          code: session.sas,
          mode: 'pair',
          temporary: false,
          active: true,
          authRequested: true,
          auto: false,
          incoming: true,
        });
      }
      return;
    }
    if (session.mode === 'pair') {
      if (payload.type === 'confirm') {
        const alreadyConfirmed = session.peerConfirmed;
        session.peerConfirmed = true;
        this.emit('peer-confirmed', {
          sessionId: session.sessionId,
          peerKey: session.peerKey,
          peerName: session.peerName,
        });
        if (session.active) {
          // 临时会话中一方主动发起身份认证时，另一方需要看到可点击的
          // 认证提示，才能核对 6 位码并完成双方确认。
          if (session.temporary && !session.localConfirmed && !alreadyConfirmed) {
            this.emit('sas', {
              sessionId: session.sessionId,
              peerKey: session.peerKey,
              peerName: session.peerName,
              code: session.sas,
              mode: 'pair',
              temporary: false,
              active: true,
              authRequested: true,
              auto: false,
              incoming: true,
            });
          }
          this._maybeMarkTemporaryAuthenticated(session);
        } else {
          this._maybeActivatePair(session);
        }
        return;
      }
      if (payload.type === 'cancel') {
        this._failSession(session, String(payload.reason || '对方取消了身份认证'));
        return;
      }
    }
    if (!session.active) return;
    if (payload.type === 'close') {
      const reason = String(payload.reason || '对方结束了认证会话');
      if (reason === '对方已解除认证') this.autoPaused.add(session.peerKey);
      this._failSession(session, reason, { pairingKeep: true });
      return;
    }
    this.emit('data', session.peerKey, payload);
  }

  _maybeActivatePair(session) {
    if (session.mode !== 'pair' || session.temporary) return;
    if (!session.sasReady || !session.localConfirmed || !session.peerConfirmed) return;
    if (session.active) return;
    this._activate(session, 'pair');
  }

  _requestAuthentication(session) {
    if (!session || !session.active || !session.temporary || !session.sasReady) return;
    this.emit('sas', {
      sessionId: session.sessionId,
      peerKey: session.peerKey,
      peerName: session.peerName,
      code: session.sas,
      mode: 'pair',
      temporary: false,
      active: true,
      authRequested: true,
      auto: false,
      incoming: session.role === 'responder',
    });
    this._sendEncrypted(session, { type: 'auth-request' }).catch(() => {});
  }

  _maybeMarkTemporaryAuthenticated(session) {
    if (!session || !session.active || !session.temporary) return;
    if (!session.localConfirmed || !session.peerConfirmed || !session.pairingKey) return;
    session.temporary = false;
    session.authenticated = true;
    try {
      this.store.set(session.peerKey, { key: session.pairingKey, user: session.peerName });
    } catch (error) {
      this.emit('warning', { peerKey: session.peerKey, message: `保存加密配对失败：${error.message || error}` });
    }
    this.emit('authenticated', {
      sessionId: session.sessionId,
      peerKey: session.peerKey,
      peerName: session.peerName,
      code: session.sas,
      mode: 'pair',
    });
  }

  _activate(session, mode) {
    if (session.mode === 'pair' && this._getPairing(session.peerKey)) {
      this._failSession(session, '本机已有认证记录，拒绝覆盖配对', { pairingKeep: true });
      return;
    }
    const previous = this.sessions.get(session.peerKey);
    if (previous && previous !== session) {
      // 新会话已经通过带 pairing 的 resume proof，才替换旧路径会话。
      this._failSession(previous, '加密会话已迁移', { pairingKeep: true });
    }
    this.migrations.delete(session.peerKey);
    this.sessions.set(session.peerKey, session);
    session.active = true;
    session.authenticated = mode === 'resume' || !session.temporary;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    // 只有用户显式认证的 pair 会话才持久化 pairing；自动临时会话
    // 只存在于当前连接期间，断开后下一次发送会重新建立临时加密。
    if (session.mode === 'pair' && !session.temporary && session.pairingKey) {
      try {
        this.store.set(session.peerKey, { key: session.pairingKey, user: session.peerName });
      } catch (error) {
        this.emit('warning', { peerKey: session.peerKey, message: `保存加密配对失败：${error.message || error}` });
      }
    }
    try {
      if (session.socket && typeof session.socket.setKeepAlive === 'function') {
        session.socket.setKeepAlive(true, 30000);
      }
    } catch {
      /* ignore */
    }
    this.autoPaused.delete(session.peerKey);
    this.emit('up', {
      sessionId: session.sessionId,
      peerKey: session.peerKey,
      peerName: session.peerName,
      mode,
      transport: session.transport || null,
      temporary: !!session.temporary,
      authenticated: !!session.authenticated,
      code: session.mode === 'pair' ? session.sas : null,
    });
  }

  _sendEncrypted(session, payload) {
    if (!session || !session.keys || !session.frame) {
      return Promise.reject(new Error('加密会话未就绪'));
    }
    const counter = session.sendCounter;
    const frame = encryptFrame(session.keys.sendKey, session.keys.sendNoncePrefix, counter, payload);
    session.sendCounter += 1;
    return session.frame.send(frame);
  }

  _getPairing(peerKey) {
    try {
      const value = this.store.get(peerKey);
      if (!value || !value.key) return null;
      return value;
    } catch {
      return null;
    }
  }

  _dropPairing(peerKey) {
    try {
      this.store.delete(peerKey);
    } catch {
      /* ignore */
    }
  }

  async revokePairing(peerKey) {
    const session = this.sessions.get(peerKey);
    if (session && session.active) {
      try {
        await this._sendEncrypted(session, { type: 'close', reason: '对方已解除认证' });
      } catch {
        /* 网络已断开时由对方下次恢复时的 no-pairing 兜底 */
      }
    }
    return this.resetPairing(peerKey);
  }

  resetPairing(peerKey) {
    this.autoPaused.delete(peerKey);
    const sessions = [this.sessions.get(peerKey), this.migrations.get(peerKey)].filter(Boolean);
    for (const session of sessions) {
      session.closed = true;
      session.active = false;
      if (session.timer) clearTimeout(session.timer);
      if (this.sessions.get(peerKey) === session) this.sessions.delete(peerKey);
      if (this.migrations.get(peerKey) === session) this.migrations.delete(peerKey);
      this.byId.delete(session.sessionId);
      try {
        session.frame && session.frame.destroy();
      } catch {
        /* ignore */
      }
      try {
        session.socket && session.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    let removed = false;
    try {
      removed = this.store.delete(peerKey);
    } catch {
      /* ignore */
    }
    this.emit('pairing-reset', { peerKey, removed });
    return removed;
  }

  _rejectSocket(socket, code, message, sessionId = '') {
    const base = this._errorPayload(sessionId, code, message);
    const payload = Buffer.from(JSON.stringify({
      ...base,
      sig: signPayload(this.identityKey.privateKey, base),
    }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    try {
      socket.end(Buffer.concat([length, payload]));
    } catch {
      socket.destroy();
    }
  }

  _failSession(session, reason, options = {}) {
    if (!session || session.closed) return;
    session.closed = true;
    if (session.timer) clearTimeout(session.timer);
    if (session.frame) {
      if (options.graceful && session.socket && !session.socket.destroyed) {
        try {
          session.socket.end();
        } catch {
          session.frame.destroy();
        }
      } else {
        session.frame.destroy();
      }
    } else if (session.socket) {
      session.socket.destroy();
    }
    const wasActive = session.active;
    session.active = false;
    if (this.sessions.get(session.peerKey) === session) this.sessions.delete(session.peerKey);
    if (this.migrations.get(session.peerKey) === session) this.migrations.delete(session.peerKey);
    this.byId.delete(session.sessionId);
    // 无论本地校验失败还是收到对端错误，都不自动删除配对。
    // 删除配对只能由用户显式 resetPairing() 触发。
    if (options.quiet) return;
    this.emit('down', {
      sessionId: session.sessionId,
      peerKey: session.peerKey,
      peerName: session.peerName,
      reason,
      wasActive,
      auto: !!session.auto,
      mode: session.mode,
      role: session.role,
      temporary: !!session.temporary,
      authenticated: !!session.authenticated,
      transport: session.transport || null,
      pairingRemoved: false,
    });
  }
}

module.exports = { SecureManager };
