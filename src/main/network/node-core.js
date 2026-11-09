'use strict';

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { EventEmitter } = require('node:events');

const { SecureManager, createMemoryStore } = require('../secure');
const {
  APP_TAG,
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  DEFAULT_DISCOVERY_PORT,
  sanitizeField,
  encodePacket,
  isPlainObject,
  createIdentity,
  signPayload,
  identityOfPeerKey,
  shortIdentity,
} = require('../../shared/protocol');
const { ReplayGuard } = require('./replay');
const {
  HEARTBEAT_MS,
  PEER_TIMEOUT_MS,
  PEER_SWEEP_MS,
  PROGRESS_EMIT_MS,
  NETWORK_CHECK_MS,
  PREVIEW_FILES,
  MAX_TCP_HEADER_BYTES,
  SECURE_ENSURE_TIMEOUT_MS,
  SECURE_ENSURE_POLL_MS,
} = require('./constants');
const {
  now,
  uid,
  lanAddresses,
  profileAddresses,
  networkSignature,
  computeSpeed,
} = require('./utils');
const { PeerRegistry } = require('./peer-registry');
const { LanTransport, DirectTransport, CompositeTransport } = require('./transport');
const { DiscoveryManager, LanDiscovery } = require('./discovery');
const { HubClient, HubDiscovery } = require('./hub');
const { AliveSession } = require('./discovery/alive');

function stunUrlFromHub(hubUrl) {
  try {
    const url = new URL(hubUrl);
    if (!url.hostname) return '';
    return `stun:${url.hostname}:3478`;
  } catch {
    return '';
  }
}

class NodeCore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = Number(options.port) || DEFAULT_PORT;
    this.discoveryPort = Number(options.discoveryPort) || DEFAULT_DISCOVERY_PORT;
    this.user = sanitizeField(options.user, '飞鸽用户') || '飞鸽用户';
    this.host = sanitizeField(options.host || os.hostname(), 'linux') || 'linux';
    this.downloadDir = options.downloadDir || path.join(os.homedir(), 'Downloads', '飞鸽接收');
    this.autoAccept = !!options.autoAccept;
    // identity = Ed25519 公钥（自证身份）；instanceId 只用于过滤本进程的广播。
    this.identityKey = options.identityKey || createIdentity();
    if (!this.identityKey || !this.identityKey.id || !this.identityKey.privateKey) {
      throw new Error('缺少 Ed25519 身份密钥');
    }
    this.identity = this.identityKey.id;
    this.instanceId = options.instanceId || uid();
    this.messageSeq = 0;
    this.replay = new ReplayGuard();
    this.sessionId = options.sessionId || uid();
    this.online = options.online !== false;
    this.lanEnabled = options.lanEnabled !== false;
    this.alive = new AliveSession();

    this.started = false;
    this.packetNo = 1;

    this.registry = new PeerRegistry({
      sourceTimeouts: {
        lan: PEER_TIMEOUT_MS,
        hub: PEER_TIMEOUT_MS,
        direct: PEER_TIMEOUT_MS,
      },
    });
    this.peers = this.registry.peers;
    this.incomingOffers = new Map();
    this.outgoingTransfers = new Map();
    this.incomingTransfers = new Map();
    this.pendingAcks = new Map();
    this.intervals = new Set();
    this.secureManifestWaiters = new Map();
    this.networkSignature = '';
    this.networkTimer = null;
    this.networkEpoch = 0;
    this.secureRetryTimers = new Map();
    this.secureRetryCount = new Map();

    const getPeer = (peerKey) => this.peers.get(peerKey);
    const lanTransport = this.lanEnabled
      ? new LanTransport({
        port: this.port,
        discoveryPort: this.discoveryPort,
        getPeer,
      })
      : null;
    const hubUrl = String(options.hubUrl || '').trim();
    const stunUrl = String(options.stunUrl || '').trim() || stunUrlFromHub(hubUrl);
    let hubDiscovery = null;
    let defaultTransport = lanTransport || new CompositeTransport({ getPeer });
    if (hubUrl && !options.transport) {
      const hubClient = new HubClient({
        url: hubUrl,
        identity: this.identity,
        WebSocketImpl: options.WebSocketImpl,
      });
      const directTransport = new DirectTransport({
        identity: this.identity,
        getPeer,
        signaling: hubClient,
        stunUrl,
        online: this.online,
      });
      hubDiscovery = new HubDiscovery({
        client: hubClient,
        direct: directTransport,
        identity: this.identity,
        instanceId: this.instanceId,
        online: this.online,
        replay: this.replay,
        alive: this.alive,
        makePacket: (command, message) => this._makePacket(command, message),
        makeAlivePacket: (command, message) => this._makePacket(command, message, { user: '-', host: '-' }),
        listPeers: () => [...this.peers.values()],
        buildProfile: (online) => this._profile(online),
      });
      defaultTransport = new CompositeTransport({
        getPeer,
        lan: lanTransport,
        direct: directTransport,
      });
    }
    this.transport = options.transport || defaultTransport;
    this.hubDiscovery = hubDiscovery;

    const sources = [];
    if (this.lanEnabled) {
      sources.push(new LanDiscovery({
        identity: this.identity,
        instanceId: this.instanceId,
        discoveryPort: this.discoveryPort,
        online: this.online,
        replay: this.replay,
        alive: this.alive,
        makePacket: (command, message) => this._makePacket(command, message),
        makeAlivePacket: (command, message) => this._makePacket(command, message, { user: '-', host: '-' }),
        listPeers: () => [...this.peers.values()],
        buildProfile: (online) => this._profile(online),
        sendDatagram: (buffer, address, port, channel) => this.transport.sendDatagram(buffer, address, port, channel),
        broadcast: (buffer, port) => this.transport.broadcast(buffer, port),
      }));
    }
    if (hubDiscovery) sources.push(hubDiscovery);
    this.discovery = options.discovery || new DiscoveryManager({ sources });

    if (typeof this.transport.on === 'function') {
      this.transport.on('datagram', (buffer, rinfo) => this._onDatagram(buffer, rinfo));
      this.transport.on('control', (peerKey, packet, meta) => this._onTransportControl(peerKey, packet, meta));
      this.transport.on('stream', (stream, meta) => this._handleIncomingStream(stream, meta));
      this.transport.on('peer', (info) => this._onDiscoveryPeer(info));
      this.transport.on('offline', (info) => this._onDiscoveryOffline(info));
      this.transport.on('path', (info) => {
        if (!info || !info.key || !info.path) return;
        this.registry.setPath(info.key, info.path);
        this._emitPeers();
      });
      this.transport.on('error', (err) => this._netError(err));
      this.transport.on('warn', (err) => this.emit('warn', err));
    }
    if (typeof this.discovery.on === 'function') {
      this.discovery.on('peer', (info) => this._onDiscoveryPeer(info));
      this.discovery.on('offline', (info) => this._onDiscoveryOffline(info));
      this.discovery.on('alive', (info) => this._onDiscoveryAlive(info));
      this.discovery.on('error', (err) => this._netError(err));
      this.discovery.on('status', (info) => this.emit('discovery-status', info));
    }

    this.secure = new SecureManager({
      identity: this.identity,
      identityKey: this.identityKey,
      user: this.user,
      host: this.host,
      port: this.port,
      online: this.online,
      store: options.secureStore || createMemoryStore(),
      getPeer: (peerKey) => this.peers.get(peerKey),
      connectStream: (peerKey, purpose, meta) => this.transport.connectStream(peerKey, purpose, meta),
      onPeerSeen: (peer) => {
        // 发现来源负责 online/offline；这里只更新展示资料，不能凭空
        // 把对端标成 LAN 来源，否则公网 peer 会被错误路由到 LAN 传输。
        const existing = this.peers.get(peer.key);
        if (!existing) return;
        let changed = false;
        if (peer.user && existing.user !== peer.user) {
          existing.user = peer.user;
          changed = true;
        }
        if (peer.host && existing.host !== peer.host) {
          existing.host = peer.host;
          changed = true;
        }
        if (changed) this._emitPeers();
      },
    });
    this.secure.on('pending', (info) => this.emit('secure-pending', info));
    this.secure.on('sas', (info) => this.emit('secure-sas', info));
    this.secure.on('peer-confirmed', (info) => this.emit('secure-peer-confirmed', info));
    this.secure.on('up', (info) => {
      if (info && info.peerKey) {
        const retry = this.secureRetryTimers.get(info.peerKey);
        if (retry) clearTimeout(retry);
        this.secureRetryTimers.delete(info.peerKey);
        this.secureRetryCount.delete(info.peerKey);
        if (info.transport === 'lan' || info.transport === 'direct') {
          this.registry.setPath(info.peerKey, info.transport);
          this._emitPeers();
        }
      }
      this.emit('secure-up', info);
    });
    this.secure.on('down', (info) => {
      this.emit('secure-down', info);
      if (info && info.wasActive) {
        this._failSecureTransfersForPeer(info.peerKey, info.reason || '加密会话已断开');
      }
      // 握手失败（wasActive=false）同样说明这条路径不可用，
      // 必须降级后重试，否则会在失效的 LAN 上反复“恢复中”。
      this._markSecurePathFailed(info);
      this._scheduleSecureRetry(info);
    });
    this.secure.on('data', (peerKey, payload) => this._onSecureData(peerKey, payload));
    this.secure.on('authenticated', (info) => this.emit('secure-authenticated', info));
    this.secure.on('warning', (info) => this.emit('secure-warning', info));
  }

  get info() {
    return {
      id: this.identity,
      instance: this.instanceId,
      user: this.user,
      host: this.host,
      port: this.port,
      discoveryPort: this.discoveryPort,
      online: this.online,
      lanEnabled: this.lanEnabled,
      addresses: lanAddresses(),
      fingerprint: shortIdentity(this.identity),
    };
  }

  async start() {
    if (this.started) return this.info;

    try {
      await this.transport.start();
      this.started = true;
      await this.discovery.start();
    } catch (error) {
      this.started = false;
      try {
        await this.discovery.stop();
      } catch {
        /* ignore */
      }
      try {
        await this.transport.stop();
      } catch {
        /* ignore */
      }
      throw error;
    }

    this.networkSignature = networkSignature();
    // 网络配置重启（例如 LAN -> Hub）后，给发现和 P2P 建连一点时间，
    // 再主动尝试恢复已有配对，避免双方都在等对方触发。
    setTimeout(() => {
      if (!this.started || !this.online) return;
      this.secure.autoResumeAll([...this.peers.values()].filter((peer) => peer.online));
    }, 1500);

    this._interval(() => {
      if (typeof this.discovery.heartbeat === 'function') this.discovery.heartbeat();
      this._sweepPeers();
      this._checkNetworkChange();
    }, HEARTBEAT_MS);
    this._interval(() => this._sweepPeers(), PEER_SWEEP_MS);
    this._interval(() => this._checkNetworkChange(), NETWORK_CHECK_MS);

    this.emit('started', this.info);
    return this.info;
  }

  async stop() {
    if (!this.started && !(this.transport && this.transport.started)) return;

    this.started = false;
    this.online = false;
    try {
      await this.discovery.stop();
    } catch {
      /* ignore */
    }
    this.secure.closeAll('节点停止');
    this.secure.setOnline(false);

    for (const timer of this.intervals) clearInterval(timer);
    this.intervals.clear();
    if (this.networkTimer) clearTimeout(this.networkTimer);
    this.networkTimer = null;
    this.networkEpoch += 1;
    for (const timer of this.secureRetryTimers.values()) clearTimeout(timer);
    this.secureRetryTimers.clear();
    this.secureRetryCount.clear();

    try {
      await this.transport.stop();
    } catch {
      /* ignore */
    }

    this.registry.clear();
    this.incomingOffers.clear();
    this.outgoingTransfers.clear();
    this.incomingTransfers.clear();
    this.pendingAcks.clear();
    this.emit('peers', []);
  }

  setOnline(online) {
    const next = !!online;
    if (this.online === next) return;
    this.online = next;
    this.secure.setOnline(next);
    if (typeof this.discovery.setOnline === 'function') this.discovery.setOnline(next);
    if (this.transport && typeof this.transport.setOnline === 'function') this.transport.setOnline(next);
    if (!next) {
      // 下线期间不继续发送任何文件数据；不发送 release（保持完全静默）。
      for (const id of [...this.incomingOffers.keys()]) this.cancelTransfer(id);
      for (const id of [...this.outgoingTransfers.keys()]) this.cancelTransfer(id);
      for (const id of [...this.incomingTransfers.keys()]) this.cancelTransfer(id);
      this.secure.closeAll('用户下线');
      for (const timer of this.secureRetryTimers.values()) clearTimeout(timer);
      this.secureRetryTimers.clear();
      this.secureRetryCount.clear();
    } else {
      setImmediate(() => {
        this.secure.autoResumeAll([...this.peers.values()].filter((peer) => peer.online));
      });
    }
    this.emit('self', this.info);
  }

  refresh() {
    if (typeof this.discovery.refresh === 'function') this.discovery.refresh();
    this.emit('self', this.info);
  }

  updateProfile() {
    if (typeof this.discovery.updateProfile === 'function') this.discovery.updateProfile();
    this.emit('self', this.info);
  }

  announceTo(address, port = DEFAULT_DISCOVERY_PORT) {
    if (!this.started) throw new Error('节点尚未启动');
    if (!this.online) return;
    if (!address) throw new Error('地址为空');
    if (typeof this.discovery.announceTo === 'function') {
      this.discovery.announceTo(address, Number(port) || DEFAULT_DISCOVERY_PORT);
    }
  }

  getTransfers() {
    return [...this.outgoingTransfers.values(), ...this.incomingTransfers.values()]
      .map((record) => this._snapshot(record))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  networkChanged() {
    if (!this.started) return;
    if (this.networkTimer) clearTimeout(this.networkTimer);
    this.networkTimer = setTimeout(() => {
      this.networkTimer = null;
      this._handleNetworkChange();
    }, 300);
  }

  _checkNetworkChange() {
    if (!this.started) return;
    const next = networkSignature();
    if (next === this.networkSignature) return;
    this.networkSignature = next;
    this.networkChanged();
  }

  _handleNetworkChange() {
    if (!this.started) return;
    const epoch = ++this.networkEpoch;
    try {
      this.secure.closeAll('网络地址变化');
    } catch {
      /* ignore */
    }
    try {
      if (typeof this.transport.networkChanged === 'function') this.transport.networkChanged();
    } catch {
      /* ignore */
    }
    try {
      if (typeof this.discovery.networkChanged === 'function') this.discovery.networkChanged();
    } catch {
      /* ignore */
    }
    this.emit('network-change', { addresses: lanAddresses() });
    setTimeout(() => {
      if (!this.started || epoch !== this.networkEpoch) return;
      try {
        if (typeof this.discovery.refresh === 'function') this.discovery.refresh();
      } catch {
        /* ignore */
      }
      try {
        this.secure.autoResumeAll([...this.peers.values()].filter((peer) => peer.online));
      } catch {
        /* ignore */
      }
    }, 300);
  }

  _markSecurePathFailed(info) {
    if (!info || !info.peerKey || !info.transport) return;
    // 只有网络故障才降级路径。对方主动重启/关闭会由发现层重新建链，
    // 不能把一条仍然健康的 Direct 路径封禁 45 秒。
    if (!/超时|连接失败|已断开|直连/.test(String(info.reason || ''))) return;
    if (!this.registry.get(info.peerKey)) return;
    if (typeof this.transport.markPathUnhealthy !== 'function') return;
    if (!this.secure.hasPairing(info.peerKey)) return;
    // 路径故障后强制丢弃旧 ICE 记录。LAN 断链后旧 WebRTC 连接可能
    // 还停在 disconnected/仍持有 DataChannel，复用它会连续 resume 超时。
    if (typeof this.transport.restartPeer === 'function') {
      this.transport.restartPeer(info.peerKey);
    }
    // LAN 是共享介质，失败后由 Composite 降级到 Direct。
    // Direct 由 DirectTransport 自己重建 ICE；这里封禁 Direct 会挡住
    // “对方重启后通过 Hub 信令重新打洞”的正常恢复。
    if (info.transport !== 'lan') return;
    this.transport.markPathUnhealthy(info.peerKey, 'lan');
    const path = typeof this.transport.activePath === 'function'
      ? this.transport.activePath(info.peerKey)
      : 'none';
    if (path === 'lan' || path === 'direct') {
      this.registry.setPath(info.peerKey, path);
      this._emitPeers();
    }
  }

  _scheduleSecureRetry(info) {
    if (!info || (!info.auto && !info.wasActive) || !info.peerKey || !this.online) return;
    if (!/超时|连接失败|已断开|直连/.test(String(info.reason || ''))) return;
    if (this.secureRetryTimers.has(info.peerKey)) return;
    if (!this.secure.hasPairing(info.peerKey)) return;
    const peer = this.peers.get(info.peerKey);
    if (!peer || !peer.online) return;
    // 双方都检测到路径断开时，优先让 identity 较小的一侧发起，避免
    // 同时握手。但物理断链可能只有较大一侧先发现，所以较大一侧不能
    // 永久等待：延迟 6 秒后也允许发起，由 SecureManager 的跨传输
    // resume 迁移替换旧会话。
    const peerIdentity = String(info.peerKey).replace(/^id:/, '');
    const preferred = this.identity < peerIdentity;
    const attempts = this.secureRetryCount.get(info.peerKey) || 0;
    if (attempts >= 5) return;
    this.secureRetryCount.set(info.peerKey, attempts + 1);
    const timer = setTimeout(() => {
      this.secureRetryTimers.delete(info.peerKey);
      if (!this.started || !this.online) return;
      const current = this.peers.get(info.peerKey);
      if (!current || !current.online || this.secure.isActive(info.peerKey)) return;
      if (this.secure.hasPending(info.peerKey)) return;
      try {
        this.secure.start(info.peerKey, { auto: true });
      } catch {
        /* 下一次发现/ALIVE 再尝试 */
      }
    }, preferred ? 3000 : 6000);
    if (typeof timer.unref === 'function') timer.unref();
    this.secureRetryTimers.set(info.peerKey, timer);
  }

  _netError(err) {
    this.emit('error', err instanceof Error ? err : new Error(String(err)));
  }

  _onDatagram(buffer, rinfo) {
    this._onUdp(buffer, rinfo);
  }

  // 兼容旧测试/调用：先交给发现源，未处理的数据报再进入控制包。
  _onUdp(buffer, rinfo) {
    const meta = {
      source: 'lan',
      address: rinfo && rinfo.address,
      port: rinfo && rinfo.port,
    };
    try {
      if (typeof this.discovery.handleDatagram === 'function'
        && this.discovery.handleDatagram(buffer, meta)) return;
    } catch (err) {
      this.emit('error', err);
      return;
    }
    this._onControlPacket(buffer, rinfo, 'lan');
  }

  _onTransportControl(peerKey, packet, meta = {}) {
    const peer = this.peers.get(peerKey);
    const source = meta.source || 'direct';
    const buffer = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
    const identity = identityOfPeerKey(peerKey);
    try {
      if (typeof this.discovery.handleDatagram === 'function'
        && this.discovery.handleDatagram(buffer, { source, sender: identity })) return;
    } catch (err) {
      this.emit('error', err);
      return;
    }
    const rinfo = {
      address: (peer && peer.ip) || '',
      port: (peer && peer.port) || 0,
      source,
    };
    this._onControlPacket(buffer, rinfo, source);
  }

  _onControlPacket() {
    // 聊天、回执、文件报价、清单请求和文件流只允许走加密会话。
    // 明文控制包在这里一律丢弃；发现层数据在进入本方法前已经处理。
  }

  _sameHost(left, right) {
    if (!left || !right) return false;
    const normalize = (value) => (String(value).startsWith('::ffff:') ? String(value).slice(7) : String(value));
    return normalize(left) === normalize(right);
  }

  _streamMatchesPeer(stream, peerKey, peerIp) {
    if (!stream) return false;
    if (stream.peerKey) return stream.peerKey === peerKey;
    return this._sameHost(stream.remoteAddress, peerIp);
  }

  _sendRelease(peerKey, transferId) {
    if (!this.online) return;
    if (!this.secure.isActive(peerKey)) return;
    this.secure.send(peerKey, { type: 'release', transferId }).catch(() => {});
  }

  _applyRelease(transferId) {
    if (!transferId) return;

    const pendingOffer = this.incomingOffers.get(transferId);
    if (pendingOffer && !pendingOffer.accepted) {
      this.incomingOffers.delete(transferId);
      this.emit('offer-closed', { id: transferId, peerKey: pendingOffer.peerKey, reason: 'canceled' });
    }

    const outgoing = this.outgoingTransfers.get(transferId);
    if (outgoing && outgoing.status !== 'done' && outgoing.status !== 'canceled') {
      const wasWaiting = outgoing.status === 'waiting';
      for (const file of outgoing.files) {
        try {
          file.socket && file.socket.destroy();
        } catch {
          /* ignore */
        }
        try {
          file.readStream && file.readStream.destroy();
        } catch {
          /* ignore */
        }
      }
      outgoing.status = wasWaiting ? 'declined' : 'canceled';
      outgoing.error = wasWaiting ? '对方拒绝了传输' : '对方取消了传输';
      this._emitTransfer(outgoing, true);
      this.emit('transfer-closed', {
        id: outgoing.id,
        direction: 'out',
        peerKey: outgoing.peerKey,
        reason: outgoing.status,
      });
    }

    const incoming = this.incomingTransfers.get(transferId);
    if (incoming && incoming.status === 'active') {
      incoming.status = 'canceled';
      incoming.error = '对方取消了传输';
      for (const file of incoming.files) {
        try {
          file.socket && file.socket.destroy();
        } catch {
          /* ignore */
        }
        try {
          file.stream && file.stream.destroy();
        } catch {
          /* ignore */
        }
        if (!file.done && file.target) fsp.unlink(file.target).catch(() => {});
      }
      incoming.activeCount = 0;
      incoming.queue = [];
      this._emitTransfer(incoming, true);
      this.incomingOffers.delete(transferId);
    }
  }

  // 接收任意传输层交付的可靠字节流。TCP / DataChannel 都复用这里。
  _handleIncomingStream(stream) {
    let buffer = Buffer.alloc(0);
    const onHeader = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const headerLength = buffer.readUInt32BE(0);
      if (headerLength <= 0 || headerLength > MAX_TCP_HEADER_BYTES) {
        stream.destroy();
        return;
      }
      if (buffer.length < 4 + headerLength) return;

      stream.removeListener('data', onHeader);
      const headerRaw = buffer.subarray(4, 4 + headerLength);
      const rest = buffer.subarray(4 + headerLength);
      buffer = null;

      let header;
      try {
        header = JSON.parse(headerRaw.toString('utf8'));
      } catch {
        stream.destroy();
        return;
      }
      if (!isPlainObject(header)) {
        stream.destroy();
        return;
      }
      // 不兼容旧协议：TCP 头版本不一致时立即断开，不发送任何错误帧，
      // 避免旧客户端继续在当前连接上尝试降级流程。
      if (header.v !== PROTOCOL_VERSION) {
        stream.destroy();
        return;
      }
      if (header.kind === 'secure-handshake') {
        this.secure.handleIncoming(stream, header, rest);
        return;
      }
      // 明文文件清单 / 文件流已移除，只接受加密 TCP 控制通道。
      stream.destroy();
    };

    stream.on('data', onHeader);
  }

  _onDiscoveryPeer(info) {
    if (info && info.reset) {
      // 对端进程重启后 instance 变化：旧 P2P/加密会话必须丢弃，
      // 否则会继续在失效的 DataChannel 上恢复握手，最后超时。
      try {
        if (typeof this.transport.closePeer === 'function') this.transport.closePeer(info.key);
      } catch {
        /* ignore */
      }
      try {
        this.secure.closePeer(info.key, '对方已重启');
      } catch {
        /* ignore */
      }
    }
    this._upsertPeer(info);
  }

  _onDiscoveryOffline(info) {
    const source = info.source || 'lan';
    this._markSourceOffline(info.key, source);
  }

  _onDiscoveryAlive(info) {
    const result = this.registry.touch(info.source || 'lan', info.key);
    if (result.changed) this._emitPeers();
    if (result.becameOnline) setImmediate(() => this.secure.handlePeerOnline(result.peer, { force: true }));
  }

  _upsertPeer(data) {
    const source = data.source || 'lan';
    const result = this.registry.upsert(source, data);
    if (result.changed) this._emitPeers();
    if (result.peer && result.peer.online) {
      const force = !!result.becameOnline;
      setImmediate(() => this.secure.handlePeerOnline(result.peer, { force }));
    }
    return result.peer;
  }

  _markSourceOffline(key, source) {
    const result = this.registry.markSourceOffline(key, source);
    if (result.changed) this._emitPeers();
    if (result.offline) this._handlePeerOffline(result.peer, '对方已离线');
    return result;
  }

  _markOffline(key) {
    const result = this.registry.markOffline(key);
    if (result.changed) this._emitPeers();
    if (result.offline) this._handlePeerOffline(result.peer, '对方已离线');
  }

  _handlePeerOffline(peer, reason) {
    const retry = this.secureRetryTimers.get(peer.key);
    if (retry) clearTimeout(retry);
    this.secureRetryTimers.delete(peer.key);
    this.secureRetryCount.delete(peer.key);
    this.emit('peer-offline', { ...peer });
    try {
      this.secure.closePeer(peer.key, reason);
    } catch (error) {
      console.error('[feige] 关闭离线加密会话失败', error);
    }
    try {
      if (typeof this.transport.closePeer === 'function') this.transport.closePeer(peer.key);
    } catch (error) {
      console.error('[feige] 关闭离线传输失败', error);
    }
    try {
      this._failTransfersForPeer(peer.key, reason);
    } catch (error) {
      console.error('[feige] 清理离线传输失败', error);
    }
  }

  _sweepPeers() {
    const { changed, offline } = this.registry.sweep();
    if (changed) this._emitPeers();
    for (const peer of offline) this._handlePeerOffline(peer, '连接超时');

    const ackCutoff = now() - 60000;
    for (const [key, pending] of this.pendingAcks) {
      if (!pending || pending.at < ackCutoff) this.pendingAcks.delete(key);
    }
  }

  _failTransfersForPeer(peerKey, reason) {
    for (const [offerId, offer] of this.incomingOffers) {
      if (offer.peerKey === peerKey && !offer.accepted) {
        this.incomingOffers.delete(offerId);
        this.emit('offer-closed', { id: offerId, peerKey, reason: 'canceled' });
      }
    }
    for (const record of this.outgoingTransfers.values()) {
      if (record.peerKey === peerKey && (record.status === 'waiting' || record.status === 'active')) {
        this._failOutgoing(record, null, new Error(reason));
      }
    }
    for (const record of this.incomingTransfers.values()) {
      if (record.peerKey === peerKey && record.status === 'active') {
        this._failIncoming(record, new Error(reason));
      }
    }
  }

  _emitPeers() {
    const peers = this.registry.list()
      .sort((a, b) => Number(b.online) - Number(a.online) || a.user.localeCompare(b.user, 'zh-Hans-CN'));
    this.emit('peers', peers);
  }

  _requirePeer(peerKey) {
    const peer = this.peers.get(peerKey);
    if (!peer) throw new Error('对方不在线');
    if (!peer.online) throw new Error('对方已离线');
    return peer;
  }

  /**
   * 发送任何会话内容前确保存在加密会话。
   *
   * 没有持久认证的联系人会先建立一次性临时加密会话：双方完成
   * X25519 + transcript 签名后立即启用，不要求 6 位码确认，也不写入
   * 配对文件。已认证联系人则沿用 pairing key 自动恢复。
   */
  async _ensureSecure(peerKey) {
    if (!this.online) throw new Error('已下线，上线后才能发送消息');
    const peer = this._requirePeer(peerKey);
    if (this.secure.isActive(peerKey)) return this.secure.getSession(peerKey);
    if (this.secure.autoPaused.has(peerKey)) {
      throw new Error('请先重新认证后再继续');
    }

    const deadline = Date.now() + SECURE_ENSURE_TIMEOUT_MS;
    let nextStartAt = 0;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.secure.isActive(peerKey)) return this.secure.getSession(peerKey);
      if (this.secure.autoPaused.has(peerKey)) {
        throw new Error('请先重新认证后再继续');
      }
      if (!peer.online) throw new Error('对方已离线');
      if (!this.secure.hasPending(peerKey) && Date.now() >= nextStartAt) {
        nextStartAt = Date.now() + 1000;
        try {
          this.secure.start(peerKey, { auto: true });
        } catch (error) {
          lastError = error;
          if (/对方不在线|对方已离线|已下线/.test(String(error && error.message))) throw error;
        }
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, SECURE_ENSURE_POLL_MS);
        if (typeof timer.unref === 'function') timer.unref();
      });
    }
    const detail = lastError && lastError.message ? `：${lastError.message}` : '';
    throw new Error(`自动建立加密会话超时${detail}`);
  }

  _touch(record, force = false) {
    const timestamp = now();
    record.updatedAt = timestamp;
    const last = record.samples[record.samples.length - 1];
    if (!last || timestamp - last[0] > 300) {
      record.samples.push([timestamp, record.doneBytes]);
      while (record.samples.length > 2 && timestamp - record.samples[0][0] > 3000) {
        record.samples.shift();
      }
    }
    if (force || timestamp - (record.lastEmit || 0) >= PROGRESS_EMIT_MS) {
      this._emitTransfer(record);
    }
  }

  _emitTransfer(record) {
    record.updatedAt = now();
    record.lastEmit = record.updatedAt;
    this.emit('transfer', this._snapshot(record));
  }

  _snapshot(record) {
    // 只向前端发送预览，避免大目录在每次进度事件里重复传输数万条元数据。
    const files = record.files.slice(0, PREVIEW_FILES).map((file) => ({
      id: file.id,
      name: file.name,
      relPath: file.relPath,
      size: file.size,
      dir: !!file.dir,
      received: file.dir ? 0 : (file.received != null ? file.received : (file.sent || 0)),
      done: !!file.done,
    }));
    return {
      id: record.id,
      direction: record.direction,
      peerKey: record.peerKey,
      peerName: record.peerName,
      peerIp: record.peerIp,
      status: record.status,
      totalBytes: record.totalBytes,
      doneBytes: Math.min(record.doneBytes, record.totalBytes || record.doneBytes),
      totalFiles: record.totalFiles,
      totalDirs: record.totalDirs,
      totalEntries: record.totalEntries,
      rootName: record.rootName,
      isFolder: record.isFolder,
      image: !!record.image,
      completedFiles: record.files.filter((file) => file.done && !file.dir).length,
      files,
      speed: computeSpeed(record.samples),
      root: record.root || null,
      error: record.error || null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  _profile(online) {
    const base = {
      app: APP_TAG,
      v: PROTOCOL_VERSION,
      kind: 'entry',
      id: this.identity,
      instance: this.instanceId,
      user: this.user,
      host: this.host,
      port: this.port,
      online: !!online,
      addrs: profileAddresses(),
      ...this.alive.profileFields(),
      ts: now(),
      nonce: uid(),
    };
    return { ...base, sig: signPayload(this.identityKey.privateKey, base) };
  }

  _makePacket(command, message = '', meta = {}) {
    const packetNo = this.packetNo;
    this.packetNo = packetNo >= 0xffffffff ? 1 : packetNo + 1;
    return {
      packetNo,
      packet: encodePacket({
        packetNo,
        user: meta.user || this.user,
        host: meta.host || this.host,
        command,
        message,
      }),
    };
  }

  _sendControl(peerKey, packet) {
    return this.transport.sendControl(peerKey, packet);
  }

  _interval(fn, ms) {
    const timer = setInterval(fn, ms);
    if (typeof timer.unref === 'function') timer.unref();
    this.intervals.add(timer);
    return timer;
  }
}

module.exports = { NodeCore };
