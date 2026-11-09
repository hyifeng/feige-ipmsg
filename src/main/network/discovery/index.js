'use strict';

/**
 * 发现来源接口：
 *
 * - await start() / stop()
 * - setOnline(online)
 * - refresh() / heartbeat()
 * - 可选 announceTo(address, port)
 * - 可选 handleDatagram(buffer, OriginContext) -> boolean
 * - 事件：'peer' / 'offline' / 'error' / 'status'
 *
 * EntryDiscovery 负责共享的飞鸽发现协议；LanDiscovery 和 HubDiscovery
 * 只提供 OriginContext 与 broadcast/unicast 通道。
 */
const { DiscoveryManager } = require('./manager');
const { EntryDiscovery } = require('./entry-discovery');
const { LanDiscovery } = require('./lan-discovery');

module.exports = { DiscoveryManager, EntryDiscovery, LanDiscovery };
