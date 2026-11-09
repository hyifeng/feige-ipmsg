'use strict';

const crypto = require('node:crypto');

/**
 * 自证身份：identity = 'pk1_' + base32(ed25519 公钥原始 32 字节)。
 *
 * 32 字节 Base32 编码后正好 52 个字符，加前缀共 56 个字符，
 * 落在协议字段上限内，也不依赖大小写敏感的文件系统。
 */
const IDENTITY_PREFIX = 'pk1_';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
const RAW_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const IDENTITY_RE = /^pk1_[A-Z2-7]{52}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{80,96}$/;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(text || '')) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('无效的 Base32 身份编码');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  // 剩余填充位必须为 0，保证同一把钥匙只有一种合法编码
  if (bits > 0 && value !== 0) throw new Error('非规范的 Base32 身份编码');
  return Buffer.from(bytes);
}

function rawPublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (der.length !== ED25519_SPKI_HEADER.length + RAW_KEY_BYTES) {
    throw new Error('不是 Ed25519 公钥');
  }
  if (!der.subarray(0, ED25519_SPKI_HEADER.length).equals(ED25519_SPKI_HEADER)) {
    throw new Error('不是 Ed25519 公钥');
  }
  return der.subarray(ED25519_SPKI_HEADER.length);
}

function identityFromPublicKey(publicKey) {
  return `${IDENTITY_PREFIX}${base32Encode(rawPublicKey(publicKey))}`;
}

function publicKeyFromIdentity(identity) {
  if (!isIdentity(identity)) throw new Error('无效的身份公钥');
  const raw = base32Decode(identity.slice(IDENTITY_PREFIX.length));
  if (raw.length !== RAW_KEY_BYTES) throw new Error('无效的身份公钥长度');
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_HEADER, raw]),
    format: 'der',
    type: 'spki',
  });
}

function isIdentity(value) {
  if (typeof value !== 'string' || !IDENTITY_RE.test(value)) return false;
  try {
    const raw = base32Decode(value.slice(IDENTITY_PREFIX.length));
    if (raw.length !== RAW_KEY_BYTES) return false;
    // 全零不是合法的 Ed25519 公钥，也常被用作“空身份”攻击
    let nonZero = 0;
    for (const byte of raw) nonZero |= byte;
    return nonZero !== 0;
  } catch {
    return false;
  }
}

function createIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    id: identityFromPublicKey(publicKey),
    publicKey,
    privateKey,
  };
}

function exportPrivateKey(privateKey) {
  return privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

function importPrivateKey(encoded) {
  return crypto.createPrivateKey({
    key: Buffer.from(String(encoded || ''), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

/** 稳定的 JSON：对象 key 排序、忽略 undefined，保证签名两端一致。 */
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function signingPayload(ext) {
  if (!ext || typeof ext !== 'object') return '';
  const payload = {};
  for (const [key, value] of Object.entries(ext)) {
    if (key !== 'sig') payload[key] = value;
  }
  return payload;
}

function signPayload(privateKey, payload) {
  const data = Buffer.from(canonicalize(payload), 'utf8');
  return crypto.sign(null, data, privateKey).toString('base64url');
}

function verifyPayload(identity, payload, signature) {
  if (!isIdentity(identity) || typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return false;
  try {
    const data = Buffer.from(canonicalize(payload), 'utf8');
    return crypto.verify(
      null,
      data,
      publicKeyFromIdentity(identity),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

function shortIdentity(identity) {
  const body = typeof identity === 'string' && identity.startsWith(IDENTITY_PREFIX)
    ? identity.slice(IDENTITY_PREFIX.length)
    : String(identity || '');
  if (body.length < 12) return body;
  return `${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

function identityOfPeerKey(peerKey) {
  const value = String(peerKey || '');
  return value.startsWith('id:') ? value.slice(3) : value;
}

function peerKeyOf(identity) {
  return `id:${String(identity || '')}`;
}

module.exports = {
  IDENTITY_PREFIX,
  SIGNATURE_BYTES,
  isIdentity,
  createIdentity,
  identityFromPublicKey,
  publicKeyFromIdentity,
  exportPrivateKey,
  importPrivateKey,
  canonicalize,
  signingPayload,
  signPayload,
  verifyPayload,
  shortIdentity,
  identityOfPeerKey,
  peerKeyOf,
  base32Encode,
  base32Decode,
};
