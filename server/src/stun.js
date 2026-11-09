'use strict';

const dgram = require('node:dgram');

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

function ipv4ToInt(address) {
  return String(address).split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function attribute(type, value) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, value]);
}

function addressAttribute(type, address, port, xor = false) {
  const value = Buffer.alloc(8);
  value[0] = 0;
  value[1] = 0x01;
  const mappedPort = xor ? (Number(port) ^ (MAGIC_COOKIE >>> 16)) & 0xffff : Number(port) & 0xffff;
  const mappedAddress = xor ? (ipv4ToInt(address) ^ MAGIC_COOKIE) >>> 0 : ipv4ToInt(address);
  value.writeUInt16BE(mappedPort, 2);
  value[4] = (mappedAddress >>> 24) & 0xff;
  value[5] = (mappedAddress >>> 16) & 0xff;
  value[6] = (mappedAddress >>> 8) & 0xff;
  value[7] = mappedAddress & 0xff;
  return attribute(type, value);
}

function bindingResponse(request, rinfo) {
  const attrs = Buffer.concat([
    addressAttribute(ATTR_MAPPED_ADDRESS, rinfo.address, rinfo.port),
    addressAttribute(ATTR_XOR_MAPPED_ADDRESS, rinfo.address, rinfo.port, true),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(attrs.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  request.copy(header, 8, 8, 20);
  return Buffer.concat([header, attrs]);
}

class StunServer {
  constructor(options = {}) {
    this.port = Number(options.port) || 3478;
    this.host = options.host || '0.0.0.0';
    this.logger = options.logger || console;
    this.socket = null;
  }

  async start() {
    if (this.socket) return;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (error) => {
      const logger = this.logger || console;
      (logger.error || logger.log || console.error).call(logger, `[feige-hub] STUN error ${error.message || error}`);
    });
    this.socket.on('message', (message, rinfo) => {
      if (!Buffer.isBuffer(message) || message.length < 20) return;
      if (message.readUInt16BE(0) !== BINDING_REQUEST) return;
      if (message.readUInt32BE(4) !== MAGIC_COOKIE) return;
      const length = message.readUInt16BE(2);
      if (length + 20 > message.length) return;
      this.socket.send(bindingResponse(message, rinfo), rinfo.port, rinfo.address, () => {});
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.socket.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.socket.removeListener('error', onError);
        resolve();
      };
      this.socket.once('error', onError);
      this.socket.once('listening', onListening);
      this.socket.bind(this.port, this.host);
    });
  }

  async stop() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    await new Promise((resolve) => socket.close(() => resolve()));
  }
}

module.exports = { StunServer };
