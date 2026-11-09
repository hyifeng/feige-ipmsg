'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ALG = 'aes-256-gcm';
const VERSION = 1;
const IV_BYTES = 12;

const AAD = {
  IDENTITY: 'feige:identity:v1',
  SETTINGS: 'feige:settings:v1',
  CONTACTS: 'feige:contacts:v1',
  HISTORY: 'feige:history:v1',
  HISTORY_INDEX: 'feige:history-index:v1',
  PAIRINGS: 'feige:secure-pairings:v1',
  LOCAL_PASS: 'feige:local-pass-check:v1',
  LOCAL_PASS_WRAP: 'feige:local-pass-wrap:v2',
  LOCAL_PASS_KEY_CHECK: 'feige:local-pass-key-check:v2',
};

class LocalCryptoError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LocalCryptoError';
    this.code = code;
  }
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new LocalCryptoError('无效的本地加密密钥', 'LOCAL_KEY_REQUIRED');
  }
}

function isEnvelope(value) {
  return !!(
    value
    && value.v === VERSION
    && value.alg === ALG
    && typeof value.iv === 'string'
    && typeof value.tag === 'string'
    && typeof value.data === 'string'
  );
}

function encryptJson(key, value, aad = '') {
  assertKey(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: VERSION,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptJson(key, envelope, aad = '') {
  assertKey(key);
  if (!isEnvelope(envelope)) throw new LocalCryptoError('无效的加密数据', 'LOCAL_DECRYPT_FAILED');

  const iv = Buffer.from(envelope.iv, 'base64');
  if (iv.length !== IV_BYTES) throw new LocalCryptoError('加密数据已损坏', 'LOCAL_DECRYPT_FAILED');

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new LocalCryptoError('本地数据解密失败', 'LOCAL_DECRYPT_FAILED');
  }

  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new LocalCryptoError('本地数据格式损坏', 'LOCAL_DECRYPT_FAILED');
  }
}

function writeJsonAtomicSync(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, file);
}

async function writeJsonAtomic(file, value, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(value), { mode });
  try {
    await fsp.chmod(tmp, mode);
  } catch {
    /* ignore */
  }
  await fsp.rename(tmp, file);
}

function writeProtectedJsonSync(file, key, value, aad, mode = 0o600) {
  writeJsonAtomicSync(file, key ? encryptJson(key, value, aad) : value, mode);
}

async function writeProtectedJson(file, key, value, aad, mode = 0o600) {
  await writeJsonAtomic(file, key ? encryptJson(key, value, aad) : value, mode);
}

function readJsonSync(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

async function readJson(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

function readProtectedJsonSync(file, key, aad) {
  const raw = readJsonSync(file);
  if (raw == null) return null;
  if (!isEnvelope(raw)) return raw;
  if (!key) throw new LocalCryptoError('本地数据已加密，请先输入本地密码', 'LOCAL_LOCKED');
  return decryptJson(key, raw, aad);
}

async function readProtectedJson(file, key, aad) {
  const raw = await readJson(file);
  if (raw == null) return null;
  if (!isEnvelope(raw)) return raw;
  if (!key) throw new LocalCryptoError('本地数据已加密，请先输入本地密码', 'LOCAL_LOCKED');
  return decryptJson(key, raw, aad);
}

module.exports = {
  ALG,
  AAD,
  LocalCryptoError,
  isEnvelope,
  encryptJson,
  decryptJson,
  readJsonSync,
  readJson,
  writeJsonAtomicSync,
  writeJsonAtomic,
  readProtectedJsonSync,
  readProtectedJson,
  writeProtectedJsonSync,
  writeProtectedJson,
};
