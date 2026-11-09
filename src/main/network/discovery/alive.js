'use strict';

const crypto = require('node:crypto');

const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
const RAW_KEY_BYTES = 32;
const ID_BYTES = 8;
const SEQ_BYTES = 4;
const SIG_BYTES = 64;
const TOKEN_BYTES = ID_BYTES + SEQ_BYTES + SIG_BYTES;

function rawPublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return der.subarray(ED25519_SPKI_HEADER.length);
}

function publicKeyFromRaw(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_HEADER, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * 轻量在线证明。
 *
 * BR_ENTRY 里携带一个会话公钥；之后每 10 秒只广播一个紧凑的 BR_ALIVE：
 *   id(8) + seq(4) + Ed25519 签名(64)
 *
 * id 由会话公钥哈希派生，不包含昵称、主机、地址或完整身份。
 * 只有已经通过签名 BR_ENTRY/ANSENTRY 拿到会话公钥的 peer 才能验证。
 */
class AliveSession {
  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    const raw = rawPublicKey(publicKey);
    this.id = crypto.createHash('sha256').update(raw).digest().subarray(0, ID_BYTES).toString('base64url');
    this.publicKeyToken = raw.toString('base64url');
    this.seq = 0;
    this.idBuffer = Buffer.from(this.id, 'base64url');
  }

  profileFields() {
    return {
      aliveId: this.id,
      aliveKey: this.publicKeyToken,
    };
  }

  nextToken() {
    this.seq = (this.seq + 1) >>> 0;
    if (this.seq === 0) this.seq = 1;
    const seq = Buffer.alloc(SEQ_BYTES);
    seq.writeUInt32BE(this.seq, 0);
    const data = Buffer.concat([this.idBuffer, seq]);
    const signature = crypto.sign(null, data, this.privateKey);
    return Buffer.concat([data, signature]).toString('base64url');
  }

  static parse(token) {
    let buffer;
    try {
      buffer = Buffer.from(String(token || ''), 'base64url');
    } catch {
      return null;
    }
    if (buffer.length !== TOKEN_BYTES) return null;
    return {
      id: buffer.subarray(0, ID_BYTES).toString('base64url'),
      seq: buffer.readUInt32BE(ID_BYTES),
      data: buffer.subarray(0, ID_BYTES + SEQ_BYTES),
      signature: buffer.subarray(ID_BYTES + SEQ_BYTES),
    };
  }

  static verify(parsed, publicKeyToken) {
    if (!parsed || !parsed.signature || !parsed.data) return false;
    try {
      const raw = Buffer.from(String(publicKeyToken || ''), 'base64url');
      if (raw.length !== RAW_KEY_BYTES) return false;
      return crypto.verify(null, parsed.data, publicKeyFromRaw(raw), parsed.signature);
    } catch {
      return false;
    }
  }
}

module.exports = { AliveSession };
