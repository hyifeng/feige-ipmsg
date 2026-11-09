'use strict';

const { EventEmitter } = require('node:events');

const { AliveSession } = require('./alive');

const {
  CMD,
  encodeBody,
  decodeBody,
  isExtensionEnvelope,
  isEntryExtension,
  parsePacket,
  verifyPayload,
} = require('../../../shared/protocol');

function unsigned(ext) {
  const { sig, ...rest } = ext || {};
  return rest;
}

/**
 * 飞鸽 LAN 发现协议本身：BR_ENTRY / ANSENTRY / BR_EXIT 的编解码、签名、
 * 来源校验、重放校验和 peer/offline 事件。
 *
 * 它不关心底层是 LAN 还是 Hub。底层只通过 OriginContext 提供：
 * - source: 'lan' | 'hub' | 'direct'
 * - sender: 传输层声明的来源 identity（可选）
 * - address: 观测到的源 IP（可选，LAN 使用）
 *
 * 以及两个发送动作：
 * - broadcast(packet)
 * - unicast(packet, target)
 */
class EntryDiscovery extends EventEmitter {
  constructor(options = {}) {
    super();
    this.source = options.source || 'lan';
    this.sources = Array.isArray(options.sources) ? options.sources : [this.source];
    this.identity = options.identity;
    this.instanceId = options.instanceId;
    this.online = options.online !== false;
    this.started = false;
    this.replay = options.replay;
    this.makePacket = options.makePacket;
    this.buildProfile = options.buildProfile;
    this.channel = options.channel || {};
    this.alive = options.alive || new AliveSession();
    this.makeAlivePacket = options.makeAlivePacket || options.makePacket;
    this.listPeers = options.listPeers || (() => []);
    this.aliveSessions = new Map();
    this.peerAlive = new Map();
    this.peerInstance = new Map();
  }

  accepts(meta = {}) {
    return this.sources.includes(meta.source || this.source);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (this.online) this._announce(CMD.BR_ENTRY);
  }

  async stop() {
    if (!this.started) return;
    if (this.online) {
      this.online = false;
      this._announce(CMD.BR_EXIT);
    }
    this.started = false;
  }

  setOnline(online) {
    const next = !!online;
    if (this.online === next) return;
    this.online = next;
    if (this.started) this._announce(next ? CMD.BR_ENTRY : CMD.BR_EXIT);
  }

  refresh() {
    if (this.started && this.online) this._announce(CMD.BR_ENTRY);
  }

  heartbeat() {
    if (!this.started || !this.online) return;
    if (!this.alive || typeof this.makeAlivePacket !== 'function') return;
    if (!this.channel || typeof this.channel.unicast !== 'function') return;
    const { packet } = this.makeAlivePacket(CMD.BR_ALIVE, this.alive.nextToken());
    for (const peer of this._sourcePeers()) {
      this.channel.unicast(packet, { ...peer, key: peer.key });
    }
  }

  updateProfile() {
    if (!this.started || !this.online) return;
    if (!this.channel || typeof this.channel.unicast !== 'function') return;
    const { packet } = this.makePacket(CMD.BR_UPDATE, encodeBody('', this.buildProfile(true)));
    for (const peer of this._sourcePeers()) {
      this.channel.unicast(packet, { ...peer, key: peer.key });
    }
  }

  _sourcePeers() {
    const result = [];
    for (const peer of this.listPeers() || []) {
      if (!peer || !peer.online || peer.key === `id:${this.identity}`) continue;
      const onSource = this.sources.some((source) => (
        peer.sources && peer.sources[source] && peer.sources[source].online
      ));
      if (onSource) result.push(peer);
    }
    return result;
  }

  handleDatagram(buffer, meta = {}) {
    if (!this.accepts(meta)) return false;
    const packet = parsePacket(buffer);
    if (!packet) return false;
    if (packet.base === CMD.BR_ALIVE) {
      this._handleAlive(packet.message, meta);
      return true;
    }
    if (packet.base !== CMD.BR_ENTRY && packet.base !== CMD.ANSENTRY
      && packet.base !== CMD.BR_UPDATE && packet.base !== CMD.BR_EXIT) {
      return false;
    }

    const { ext } = decodeBody(packet.message);
    if (!ext) return true;
    if (!isExtensionEnvelope(ext)) return true;
    if (ext.id === this.identity || ext.instance === this.instanceId) return true;
    if (!this._verifyEntry(ext, meta)) return true;

    const source = meta.source || this.source;
    const key = `id:${ext.id}`;
    if (packet.base === CMD.BR_EXIT) {
      const knownInstance = this.peerInstance.get(key);
      if (knownInstance && ext.instance && knownInstance !== ext.instance) return true;
      if (ext.online === false) {
        // 保留最后一次 instance，便于识别“退出后重新启动”的新实例。
        this._unregisterAlive(key);
        this.emit('offline', { source, key });
      }
      return true;
    }
    const previousInstance = this.peerInstance.get(key);
    this.peerInstance.set(key, ext.instance);
    this._registerAlive(ext, key);
    if (ext.online !== true) return true;

    const info = this._peerInfo(ext, meta, source, previousInstance);
    this.emit('peer', info);

    if (packet.base === CMD.BR_ENTRY && this.online && typeof this.channel.unicast === 'function') {
      const reply = this.makePacket(CMD.ANSENTRY, encodeBody('', this.buildProfile(true)));
      this.channel.unicast(reply.packet, { ...info, meta });
    }
    return true;
  }

  _registerAlive(ext, peerKey) {
    const id = typeof ext.aliveId === 'string' ? ext.aliveId : '';
    const key = typeof ext.aliveKey === 'string' ? ext.aliveKey : '';
    if (!id || !key) return;
    let raw;
    try {
      raw = Buffer.from(key, 'base64url');
    } catch {
      return;
    }
    if (raw.length !== 32) return;
    const existing = this.aliveSessions.get(id);
    if (existing && existing.peerKey !== peerKey) return;
    // 同一个会话重复收到 BR_ENTRY 时不能把序号清零，否则旧 ALIVE 可被重放。
    const lastSeq = existing && existing.publicKey === key ? existing.lastSeq : 0;
    const previous = this.peerAlive.get(peerKey);
    if (previous && previous !== id) this.aliveSessions.delete(previous);
    this.peerAlive.set(peerKey, id);
    this.aliveSessions.set(id, { peerKey, publicKey: key, lastSeq });
  }

  _unregisterAlive(peerKey) {
    const id = this.peerAlive.get(peerKey);
    if (!id) return;
    this.peerAlive.delete(peerKey);
    this.aliveSessions.delete(id);
  }

  _handleAlive(token, meta) {
    const parsed = AliveSession.parse(token);
    if (!parsed || !parsed.seq) return;
    const session = this.aliveSessions.get(parsed.id);
    if (!session) return;
    if (parsed.seq <= session.lastSeq) return;
    if (!AliveSession.verify(parsed, session.publicKey)) return;
    session.lastSeq = parsed.seq;
    this.emit('alive', {
      source: meta.source || this.source,
      key: session.peerKey,
      seq: parsed.seq,
    });
  }

  _announce(command) {
    if (!this.channel || typeof this.channel.broadcast !== 'function') return false;
    const { packet } = this.makePacket(
      command,
      encodeBody('', this.buildProfile(command === CMD.BR_ENTRY)),
    );
    return this.channel.broadcast(packet);
  }

  _peerInfo(ext, meta, source, previousInstance = null) {
    const info = {
      source,
      key: `id:${ext.id}`,
      identity: ext.id,
      instance: ext.instance,
      reset: !!previousInstance && previousInstance !== ext.instance,
      user: ext.user,
      host: ext.host,
      online: true,
    };
    if (meta.address) {
      info.ip = meta.address;
      info.port = ext.port;
    }
    return info;
  }

  _verifyEntry(ext, meta) {
    if (!isEntryExtension(ext)) return false;
    if (!verifyPayload(ext.id, unsigned(ext), ext.sig)) return false;
    // 通用来源规则：有 sender 就必须与签名身份一致。
    if (meta.sender && meta.sender !== ext.id) return false;
    // 通用来源规则：有观测源 IP 时，必须在 entry 声明的 addrs 中。
    if (meta.address && !ext.addrs.includes(meta.address)) return false;
    if (!this.replay.checkNonce(ext.id, ext.nonce, ext.ts)) return false;
    return true;
  }
}

module.exports = { EntryDiscovery };
