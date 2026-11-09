'use strict';

const { EntryDiscovery } = require('../discovery/entry-discovery');
const { CMD } = require('../../../shared/protocol');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hub 通道：
 * - broadcast -> HubClient 广播不透明帧
 * - unicast   -> DirectTransport P2P 控制通道
 *
 * BR_ENTRY / BR_EXIT 走 server 广播；
 * ANSENTRY 等飞鸽单播走 P2P。
 */
class HubDiscovery extends EntryDiscovery {
  constructor(options = {}) {
    const client = options.client;
    const direct = options.direct;
    super({
      source: 'hub',
      sources: ['hub', 'direct'],
      identity: options.identity,
      instanceId: options.instanceId,
      online: options.online,
      replay: options.replay,
      alive: options.alive,
      makePacket: options.makePacket,
      makeAlivePacket: options.makeAlivePacket,
      listPeers: options.listPeers,
      buildProfile: options.buildProfile,
      channel: {
        broadcast: (packet) => (client ? client.broadcast(packet) : false),
        unicast: (packet, target) => {
          if (!direct || !target || !target.key) return false;
          return direct.sendControl(target.key, packet);
        },
      },
    });
    this.client = client;
    this.direct = direct;

    if (client && typeof client.on === 'function') {
      client.on('open', () => {
        if (this.started && this.online) this._announce(CMD.BR_ENTRY);
      });
      client.on('broadcast', (frame) => {
        this.handleDatagram(frame.payload, { source: 'hub', sender: frame.from });
      });
      client.on('status', (status) => this.emit('status', { source: 'hub', ...status }));
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (this.client) await this.client.start();
    if (this.online && this.client && this.client.status === 'open') {
      this._announce(CMD.BR_ENTRY);
    }
  }

  async stop() {
    if (!this.started) return;
    if (this.online) {
      this.online = false;
      this._announce(CMD.BR_EXIT);
      // 给 WebSocket 一点时间把 BR_EXIT 发出去。
      await delay(80);
    }
    this.started = false;
    if (this.client) await this.client.stop();
  }

  refresh() {
    if (this.client && this.client.status !== 'open') {
      if (typeof this.client.reconnect === 'function') this.client.reconnect();
      return;
    }
    super.refresh();
  }

  heartbeat() {
    if (this.online && this.client && (this.client.status === 'closed' || this.client.status === 'error')) {
      if (typeof this.client.reconnect === 'function') this.client.reconnect();
      return;
    }
    super.heartbeat();
  }

  networkChanged() {
    if (this.client && typeof this.client.reconnect === 'function') this.client.reconnect();
  }

  announceTo() {}
}

module.exports = { HubDiscovery };
