'use strict';

/**
 * 传输层接口（由 NodeCore 使用）：
 *
 * - await start() / stop()
 * - sendControl(peerKey, packet) -> boolean
 * - connectStream(peerKey, purpose, meta) -> Duplex-like stream
 *     必须支持 on('connect' | 'data' | 'end' | 'close' | 'error')
 *     write / end / destroy，以及可选的 pause / resume / setTimeout /
 *     setNoDelay / setKeepAlive。
 * - 事件：
 *     'datagram' (buffer, rinfo, channel)  原始数据报来源，例如局域网 UDP
 *     'control'  (peerKey, packet, meta)   已绑定 peerKey 的控制包
 *     'stream'   (stream, meta)            入站可靠字节流
 *     'error' / 'warn'
 *
 * LanTransport 是当前实现；未来 WebRTC / 其他传输只需要实现同一接口。
 */
const { LanTransport } = require('./lan-transport');
const { DirectTransport } = require('./direct-transport');
const { CompositeTransport } = require('./composite-transport');
const { DataChannelStream } = require('./data-channel-stream');

module.exports = { LanTransport, DirectTransport, CompositeTransport, DataChannelStream };
