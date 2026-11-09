'use strict';

const dgram = require('node:dgram');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const { bindUdp, broadcastTargets } = require('../utils');

/**
 * 当前局域网传输实现。
 *
 * 对外只暴露：
 * - sendControl(peerKey, packet)
 * - connectStream(peerKey, purpose, meta)
 * - 事件 'datagram' / 'stream' / 'error' / 'warn'
 *
 * 业务层不直接接触 dgram / net / peer.ip / peer.port。
 */
class LanTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = Number(options.port) || 0;
    this.discoveryPort = Number(options.discoveryPort) || this.port;
    this.getPeer = options.getPeer || (() => null);
    this.started = false;
    this.udp = null;
    this.disco = null;
    this.tcp = null;
    this.sockets = new Set();
  }

  async start() {
    if (this.started) return;
    try {
      this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.udp.on('error', (err) => this.emit('error', err));
      this.udp.on('message', (msg, rinfo) => this.emit('datagram', msg, rinfo, 'service'));
      await bindUdp(this.udp, this.port);
      try {
        this.udp.setBroadcast(true);
      } catch {
        /* 某些环境不允许，退化为子网广播 */
      }

      if (this.discoveryPort !== this.port) {
        this.disco = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.disco.on('error', (err) => this.emit('error', err));
        this.disco.on('message', (msg, rinfo) => this.emit('datagram', msg, rinfo, 'discovery'));
        await bindUdp(this.disco, this.discoveryPort);
        try {
          this.disco.setBroadcast(true);
        } catch {
          /* ignore */
        }
      } else {
        this.disco = this.udp;
      }

      await this._listenTcp();
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  _listenTcp() {
    this.tcp = net.createServer((socket) => this._onSocket(socket));
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.tcp.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.tcp.removeListener('error', onError);
        resolve();
      };
      this.tcp.once('error', onError);
      this.tcp.once('listening', onListening);
      this.tcp.listen(this.port, '0.0.0.0');
    }).then(() => {
      this.tcp.on('error', (err) => this.emit('error', err));
    });
  }

  _onSocket(socket) {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(120000, () => socket.destroy(new Error('连接超时')));
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    socket.transport = 'lan';
    this.emit('stream', socket, { transport: 'lan' });
  }

  _endpoint(peer) {
    if (!peer) return null;
    const lan = peer.sources && peer.sources.lan && peer.sources.lan.online
      ? peer.sources.lan
      : null;
    const ip = (lan && lan.ip) || peer.ip;
    const port = (lan && lan.port) || peer.port;
    if (!ip || !port) return null;
    return { ip, port: Number(port) };
  }

  closePeer() {}

  sendControl(peerKey, packet) {
    const endpoint = this._endpoint(this.getPeer(peerKey));
    if (!endpoint) return false;
    return this.sendDatagram(packet, endpoint.ip, endpoint.port, 'service');
  }

  connectStream(peerKey, purpose, meta = {}) {
    const endpoint = this._endpoint(this.getPeer(peerKey));
    if (!endpoint) throw new Error('对方不在线');
    const port = Number(meta.port) || endpoint.port;
    const socket = net.connect({ host: endpoint.ip, port });
    socket.setNoDelay(true);
    if (meta.timeout !== 0) socket.setTimeout(Number(meta.timeout) || 60000);
    if (meta.keepAlive) socket.setKeepAlive(true, 30000);
    socket.on('error', () => {});
    socket.peerKey = peerKey;
    socket.transport = 'lan';
    socket.purpose = purpose;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    return socket;
  }

  networkChanged() {
    // 本地地址变化后，旧 TCP 流已经不可用；UDP/TCP 监听仍在 0.0.0.0 上，
    // 广播目标会在下一次发送时重新按当前网卡计算。
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
  }

  sendDatagram(buffer, address, port, channel = 'service') {
    const socket = channel === 'discovery' ? this.disco : this.udp;
    if (!socket || !address) return false;
    socket.send(Buffer.from(buffer), Number(port) || this.port, address, (err) => {
      if (err) this.emit('warn', err);
    });
    return true;
  }

  broadcast(buffer, port) {
    if (!this.disco) return false;
    const payload = Buffer.from(buffer);
    const targetPort = Number(port) || this.discoveryPort;
    for (const target of broadcastTargets()) {
      this.disco.send(payload, targetPort, target, (err) => {
        if (err) this.emit('warn', err);
      });
    }
    return true;
  }

  async stop() {
    this.started = false;

    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();

    if (this.tcp) {
      const server = this.tcp;
      this.tcp = null;
      try {
        await Promise.race([
          new Promise((resolve) => server.close(() => resolve())),
          new Promise((resolve) => setTimeout(resolve, 800)),
        ]);
      } catch {
        /* ignore */
      }
    }

    if (this.disco && this.disco !== this.udp) {
      try {
        this.disco.close();
      } catch {
        /* ignore */
      }
    }
    this.disco = null;

    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        /* ignore */
      }
    }
    this.udp = null;
  }
}

module.exports = { LanTransport };
