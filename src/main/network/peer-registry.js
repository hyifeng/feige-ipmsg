'use strict';

const { now } = require('./utils');

const DEFAULT_SOURCE_TIMEOUTS = Object.freeze({
  lan: 30000,
  hub: 45000,
});

/**
 * 按 identity 合并多个发现来源。
 *
 * - 联系人只按 key 保存一份；
 * - 每个来源独立维护 online / lastSeen / 端点；
 * - 任一来源在线即在线；
 * - 只有全部来源离线才真正离线。
 *
 * 传输层只通过 peer.lan / peer.hub 取自己需要的端点，业务层仍然只读
 * peer.key、peer.user、peer.online 等兼容字段。
 */
class PeerRegistry {
  constructor(options = {}) {
    this.peers = new Map();
    this.pathOverrides = new Map();
    this.sourceTimeouts = { ...DEFAULT_SOURCE_TIMEOUTS, ...(options.sourceTimeouts || {}) };
  }

  upsert(source, data = {}) {
    const key = data.key;
    if (!key) return { peer: null, changed: false, becameOnline: false };

    let peer = this.peers.get(key);
    let changed = false;
    if (!peer) {
      peer = {
        key,
        ip: data.ip || '',
        port: Number(data.port) || 0,
        user: data.user || '未知联系人',
        host: data.host || '',
        online: false,
        firstSeen: now(),
        lastSeen: now(),
        sources: {},
      };
      this.peers.set(key, peer);
      changed = true;
    }

    const previousOnline = peer.online;
    const previousSource = peer.sources[source];
    const sourceOnline = data.online !== false;
    const nextSource = {
      ...(previousSource || {}),
      online: sourceOnline,
      lastSeen: now(),
    };
    if (data.ip) nextSource.ip = String(data.ip);
    if (data.port) nextSource.port = Number(data.port) || 0;
    if (data.user) nextSource.user = String(data.user);
    if (data.host) nextSource.host = String(data.host);
    if (data.profile !== undefined) nextSource.profile = data.profile;
    peer.sources[source] = nextSource;

    if (!previousSource || previousSource.online !== sourceOnline) changed = true;
    const hasEndpoint = source === 'lan' || data.endpoint === true;
    if (hasEndpoint && data.ip && peer.ip !== data.ip) {
      peer.ip = String(data.ip);
      changed = true;
    }
    if (hasEndpoint && data.port && peer.port !== Number(data.port)) {
      peer.port = Number(data.port) || 0;
      changed = true;
    }
    if (data.user && peer.user !== data.user) {
      peer.user = String(data.user);
      changed = true;
    }
    if (data.host && peer.host !== data.host) {
      peer.host = String(data.host);
      changed = true;
    }

    peer.online = this._anyOnline(peer);
    peer.lastSeen = now();
    if (peer.online !== previousOnline) changed = true;

    return {
      peer,
      changed,
      becameOnline: peer.online && !previousOnline,
    };
  }

  touch(source, key) {
    const peer = this.peers.get(key);
    if (!peer) return { peer: null, changed: false, becameOnline: false };
    const record = peer.sources[source];
    if (!record) return { peer, changed: false, becameOnline: false };
    const wasOnline = peer.online;
    record.online = true;
    record.lastSeen = now();
    peer.online = this._anyOnline(peer);
    peer.lastSeen = now();
    return {
      peer,
      changed: peer.online !== wasOnline,
      becameOnline: peer.online && !wasOnline,
    };
  }

  markSourceOffline(key, source) {
    const peer = this.peers.get(key);
    if (!peer) return { peer: null, changed: false, offline: false };
    const record = peer.sources[source];
    if (!record || !record.online) return { peer, changed: false, offline: false };

    record.online = false;
    record.lastSeen = now();
    const wasOnline = peer.online;
    peer.online = this._anyOnline(peer);
    peer.lastSeen = now();

    return {
      peer,
      changed: true,
      offline: wasOnline && !peer.online,
    };
  }

  markOffline(key) {
    const peer = this.peers.get(key);
    if (!peer) return { peer: null, changed: false, offline: false };
    const wasOnline = peer.online;
    let changed = false;
    for (const record of Object.values(peer.sources)) {
      if (record.online) {
        record.online = false;
        record.lastSeen = now();
        changed = true;
      }
    }
    if (wasOnline) {
      peer.online = false;
      peer.lastSeen = now();
      changed = true;
      this.pathOverrides.delete(key);
    }
    return { peer, changed, offline: wasOnline };
  }

  sweep(timestamp = now()) {
    let changed = false;
    const offline = [];

    for (const peer of this.peers.values()) {
      const wasOnline = peer.online;
      let sourceChanged = false;
      for (const [source, record] of Object.entries(peer.sources)) {
        if (!record.online) continue;
        const timeout = Number(this.sourceTimeouts[source]) || 30000;
        // 兼容旧测试：允许直接改 peer.lastSeen 模拟超时。
        const effectiveLastSeen = Math.min(record.lastSeen || 0, peer.lastSeen || record.lastSeen || 0);
        if (effectiveLastSeen < timestamp - timeout) {
          record.online = false;
          sourceChanged = true;
        }
      }
      peer.online = this._anyOnline(peer);
      if (sourceChanged || peer.online !== wasOnline) changed = true;
      if (peer.online) {
        peer.lastSeen = Math.max(...Object.values(peer.sources).map((record) => record.lastSeen || 0));
      }
      if (wasOnline && !peer.online) offline.push(this.snapshotPeer(peer));
    }

    return { changed, offline };
  }

  setPath(key, path) {
    if (!key || !path) return;
    if (this.pathOverrides.get(key) === path) return;
    this.pathOverrides.set(key, path);
  }

  clearPath(key) {
    this.pathOverrides.delete(key);
  }

  get(key) {
    return this.peers.get(key) || null;
  }

  values() {
    return this.peers.values();
  }

  list() {
    return [...this.peers.values()].map((peer) => this.snapshotPeer(peer));
  }

  clear() {
    this.peers.clear();
    this.pathOverrides.clear();
  }

  snapshotPeer(peer) {
    const sources = Object.keys(peer.sources).filter((source) => peer.sources[source].online);
    return {
      ...peer,
      sources,
      path: this.pathOverrides.get(peer.key)
        || (peer.sources.lan && peer.sources.lan.online ? 'lan' : (sources.length ? 'direct' : 'none')),
      sourceDetails: peer.sources,
    };
  }

  _anyOnline(peer) {
    return Object.values(peer.sources).some((record) => record.online);
  }
}

module.exports = { PeerRegistry };
