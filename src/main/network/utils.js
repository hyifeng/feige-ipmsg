'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

function now() {
  return Date.now();
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function computeSpeed(samples) {
  if (!samples || samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = (last[0] - first[0]) / 1000;
  if (seconds < 0.2) return 0;
  return Math.max(0, Math.round((last[1] - first[1]) / seconds));
}

function lanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const info of list || []) {
      const v4 = info.family === 'IPv4' || info.family === 4;
      if (v4 && !info.internal) addresses.push(info.address);
    }
  }
  return [...new Set(addresses)];
}

function profileAddresses() {
  const list = lanAddresses().slice(0, 16);
  // 只有回环环境的机器（以及测试）也要能完成签名校验
  if (!list.length) list.push('127.0.0.1');
  return list;
}

function ipv4Broadcast(address, netmask) {
  try {
    const ip = address.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
    const mask = String(netmask || '255.255.255.255')
      .split('.')
      .reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
    const broadcast = (ip | (~mask >>> 0)) >>> 0;
    return [broadcast >>> 24, (broadcast >>> 16) & 255, (broadcast >>> 8) & 255, broadcast & 255].join('.');
  } catch {
    return '255.255.255.255';
  }
}

function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const info of list || []) {
      const v4 = info.family === 'IPv4' || info.family === 4;
      if (!v4 || info.internal) continue;
      targets.add(ipv4Broadcast(info.address, info.netmask));
    }
  }
  return [...targets];
}

function bindUdp(socket, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      socket.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      socket.removeListener('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port, '0.0.0.0');
  });
}

function networkSignature() {
  const parts = [];
  const interfaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list || []) {
      const v4 = info.family === 'IPv4' || info.family === 4;
      if (!v4 || info.internal) continue;
      parts.push(`${name}:${info.address}:${info.netmask || ''}`);
    }
  }
  return parts.sort().join('|');
}

module.exports = {
  now,
  uid,
  computeSpeed,
  lanAddresses,
  profileAddresses,
  networkSignature,
  ipv4Broadcast,
  broadcastTargets,
  bindUdp,
};
