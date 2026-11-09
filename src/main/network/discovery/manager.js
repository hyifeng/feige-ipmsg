'use strict';

const { EventEmitter } = require('node:events');

/**
 * 发现源聚合器。
 *
 * 每个 source 只需要实现自己关心的能力：
 * - start / stop / setOnline / refresh / heartbeat
 * - 事件 peer / offline
 * - 可选 handleDatagram（局域网 UDP 等基于数据报的来源）
 *
 * 未来增加服务器 presence 时，只需要 add 一个新的 source，不需要改
 * NodeCore 的发现逻辑。
 */
class DiscoveryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sources = [];
    for (const source of options.sources || []) this.add(source);
  }

  add(source) {
    if (!source || this.sources.includes(source)) return source;
    this.sources.push(source);
    if (typeof source.on === 'function') {
      source.on('peer', (info) => this.emit('peer', info));
      source.on('offline', (info) => this.emit('offline', info));
      source.on('alive', (info) => this.emit('alive', info));
      source.on('error', (error) => this.emit('error', error));
      source.on('status', (info) => this.emit('status', info));
    }
    return source;
  }

  async start() {
    for (const source of this.sources) {
      if (typeof source.start === 'function') await source.start();
    }
  }

  async stop() {
    for (const source of this.sources) {
      if (typeof source.stop === 'function') await source.stop();
    }
  }

  setOnline(online) {
    for (const source of this.sources) {
      if (typeof source.setOnline === 'function') source.setOnline(online);
    }
  }

  refresh() {
    for (const source of this.sources) {
      if (typeof source.refresh === 'function') source.refresh();
    }
  }

  networkChanged() {
    for (const source of this.sources) {
      if (typeof source.networkChanged === 'function') source.networkChanged();
    }
  }

  updateProfile() {
    for (const source of this.sources) {
      if (typeof source.updateProfile === 'function') source.updateProfile();
    }
  }

  heartbeat() {
    for (const source of this.sources) {
      if (typeof source.heartbeat === 'function') source.heartbeat();
    }
  }

  announceTo(address, port) {
    for (const source of this.sources) {
      if (typeof source.announceTo === 'function') source.announceTo(address, port);
    }
  }

  handleDatagram(buffer, rinfo) {
    for (const source of this.sources) {
      if (typeof source.handleDatagram !== 'function') continue;
      try {
        if (source.handleDatagram(buffer, rinfo)) return true;
      } catch (error) {
        this.emit('error', error);
        return true;
      }
    }
    return false;
  }
}

module.exports = { DiscoveryManager };
