'use strict';

const { EventEmitter } = require('node:events');

/**
 * 按 peer 的发现来源选择传输：
 * - LAN 来源在线 -> LanTransport（优先）
 * - 否则 -> DirectTransport（服务器信令 + WebRTC）
 *
 * 业务层仍然只看到 Transport 接口。
 */
class CompositeTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.getPeer = options.getPeer || (() => null);
    this.lan = options.lan || null;
    this.direct = options.direct || null;
    this.started = false;
    this.paths = new Map();
    this.pathFailures = new Map();
    this._wire(this.lan);
    this._wire(this.direct);
  }

  async start() {
    if (this.started) return;
    if (this.lan) await this.lan.start();
    if (this.direct) await this.direct.start();
    this.started = true;
  }

  async stop() {
    this.started = false;
    this.paths = new Map();
    this.pathFailures = new Map();
    if (this.direct) await this.direct.stop().catch(() => {});
    if (this.lan) await this.lan.stop().catch(() => {});
  }

  networkChanged() {
    this.pathFailures.clear();
    this.paths.clear();
    if (this.lan && typeof this.lan.networkChanged === 'function') this.lan.networkChanged();
    if (this.direct && typeof this.direct.networkChanged === 'function') this.direct.networkChanged();
  }

  markPathUnhealthy(peerKey, path, cooldownMs = 45000) {
    if (!peerKey || !path) return;
    this.pathFailures.set(`${peerKey}:${path}`, Date.now() + cooldownMs);
    this._updatePath(peerKey);
  }

  clearPathFailure(peerKey, path) {
    if (!peerKey || !path) return;
    this.pathFailures.delete(`${peerKey}:${path}`);
  }

  isPathHealthy(peerKey, path) {
    const until = this.pathFailures.get(`${peerKey}:${path}`);
    if (!until) return true;
    if (until > Date.now()) return false;
    this.pathFailures.delete(`${peerKey}:${path}`);
    return true;
  }

  activePath(peerKey) {
    return this._pathFor(peerKey) || 'none';
  }

  _pathFor(peerKey) {
    const peer = this.getPeer(peerKey);
    if (!peer || !peer.online) return null;
    const lanOnline = !!(peer.sources && peer.sources.lan && peer.sources.lan.online);
    const lanUsable = lanOnline && this.isPathHealthy(peerKey, 'lan');
    const directUsable = !!this.direct && this.isPathHealthy(peerKey, 'direct');
    // LAN 健康时始终优先 LAN。Direct 可能只是 Hub 心跳提前建立，
    // 不能因为 Direct 已存在就把实际承载路径切到公网。
    if (lanUsable) return 'lan';
    if (directUsable) return 'direct';
    return null;
  }

  _updatePath(peerKey) {
    const path = this._pathFor(peerKey);
    if (!path) return;
    if (this.paths.get(peerKey) === path) return;
    this.paths.set(peerKey, path);
    this.emit('path', { key: peerKey, path });
  }

  setOnline(online) {
    if (this.direct && typeof this.direct.setOnline === 'function') this.direct.setOnline(online);
  }

  closePeer(peerKey) {
    if (this.direct && typeof this.direct.closePeer === 'function') this.direct.closePeer(peerKey);
    if (this.lan && typeof this.lan.closePeer === 'function') this.lan.closePeer(peerKey);
  }

  restartPeer(peerKey) {
    if (this.direct && typeof this.direct.restartPeer === 'function') this.direct.restartPeer(peerKey);
    else if (this.direct && typeof this.direct.closePeer === 'function') this.direct.closePeer(peerKey);
  }

  sendControl(peerKey, packet) {
    const transport = this._transportFor(peerKey);
    if (!transport) return false;
    return transport.sendControl(peerKey, packet);
  }

  connectStream(peerKey, purpose, meta) {
    const transport = this._transportFor(peerKey);
    if (!transport) throw new Error('对方不在线');
    return transport.connectStream(peerKey, purpose, meta);
  }

  sendDatagram(buffer, address, port, channel) {
    return this.lan ? this.lan.sendDatagram(buffer, address, port, channel) : false;
  }

  broadcast(buffer, port) {
    return this.lan ? this.lan.broadcast(buffer, port) : false;
  }

  _transportFor(peerKey) {
    const path = this._pathFor(peerKey);
    if (!path) return null;
    this._updatePath(peerKey);
    if (path === 'lan') return this.lan;
    return this.direct || this.lan || null;
  }

  _wire(transport) {
    if (!transport || typeof transport.on !== 'function') return;
    for (const event of ['datagram', 'control', 'stream', 'peer', 'offline', 'error', 'warn']) {
      transport.on(event, (...args) => this.emit(event, ...args));
    }
  }
}

module.exports = { CompositeTransport };
