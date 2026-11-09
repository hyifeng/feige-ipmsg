'use strict';

const crypto = require('node:crypto');

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function hmac(key, ...parts) {
  const mac = crypto.createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), length));
}

function xorZero(buffer) {
  let value = 0;
  for (const byte of buffer) value |= byte;
  return value === 0;
}

function jsonBuffer(value) {
  return Buffer.from(JSON.stringify(value));
}

function encryptFrame(key, noncePrefix, counter, payload) {
  const plaintext = jsonBuffer(payload);
  const nonce = Buffer.alloc(12);
  noncePrefix.copy(nonce, 0);
  nonce.writeUInt32BE(counter >>> 0, 8);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const aad = Buffer.from(`${noncePrefix.toString('hex')}:${counter}`);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    t: 'enc',
    n: counter,
    d: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptFrame(key, noncePrefix, expectedCounter, frame) {
  const counter = Number(frame.n);
  if (counter !== expectedCounter) throw new Error('加密消息顺序错误');
  const nonce = Buffer.alloc(12);
  noncePrefix.copy(nonce, 0);
  nonce.writeUInt32BE(counter >>> 0, 8);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  const aad = Buffer.from(`${noncePrefix.toString('hex')}:${counter}`);
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(String(frame.tag || ''), 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(frame.d || ''), 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = {
  sha256,
  hmac,
  hkdf,
  xorZero,
  jsonBuffer,
  encryptFrame,
  decryptFrame,
};
