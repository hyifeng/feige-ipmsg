'use strict';

const { EntryDiscovery } = require('./entry-discovery');
const { CMD, encodeBody } = require('../../../shared/protocol');

/**
 * 局域网通道：UDP 广播 + UDP 单播。
 * 协议逻辑全部在 EntryDiscovery，这里只提供通道和来源元数据。
 */
class LanDiscovery extends EntryDiscovery {
  constructor(options = {}) {
    const discoveryPort = Number(options.discoveryPort) || 0;
    const sendDatagram = options.sendDatagram || (() => false);
    const broadcast = options.broadcast || (() => false);
    super({
      source: 'lan',
      sources: ['lan'],
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
        broadcast: (packet) => broadcast(packet, discoveryPort),
        unicast: (packet, target) => {
          const lan = target.sources && target.sources.lan;
          const ip = (lan && lan.ip) || target.ip;
          const port = (lan && lan.port) || target.port;
          return ip && port ? sendDatagram(packet, ip, port, 'service') : false;
        },
      },
    });
    this.discoveryPort = discoveryPort;
    this.sendDatagram = sendDatagram;
  }

  handleDatagram(buffer, meta = {}) {
    // 不能把 Hub/P2P 进来的 ANSENTRY/ALIVE 误当成 LAN 来源。
    // Hub 通道由 HubDiscovery 处理；LAN 通道只接受 source=lan。
    if (meta.source && meta.source !== 'lan') return false;
    return super.handleDatagram(buffer, {
      source: 'lan',
      address: meta.address,
      port: meta.port,
    });
  }

  announceTo(address, port) {
    if (!this.online || !address) return false;
    const { packet } = this.makePacket(CMD.BR_ENTRY, encodeBody('', this.buildProfile(true)));
    return this.sendDatagram(packet, address, Number(port) || this.discoveryPort, 'service');
  }
}

module.exports = { LanDiscovery };
