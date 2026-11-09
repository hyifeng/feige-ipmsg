'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  createIdentity,
  identityFromPublicKey,
  exportPrivateKey,
  importPrivateKey,
  isIdentity,
} = require('../../shared/protocol/identity');
const {
  AAD,
  isEnvelope,
  decryptJson,
  writeProtectedJsonSync,
} = require('../security/local-crypto');

const FILE_NAME = 'identity-key.json';

function identityFromRecord(raw) {
  if (!raw || raw.v !== 1 || typeof raw.privateKey !== 'string' || !isIdentity(raw.id)) return null;
  try {
    const privateKey = importPrivateKey(raw.privateKey);
    const publicKey = crypto.createPublicKey(privateKey);
    const id = identityFromPublicKey(publicKey);
    if (id !== raw.id) return null;
    return { id, publicKey, privateKey, record: raw };
  } catch {
    return null;
  }
}

function saveIdentity(directory, identity, key) {
  const file = path.join(directory, FILE_NAME);
  writeProtectedJsonSync(file, key, {
    v: 1,
    id: identity.id,
    privateKey: exportPrivateKey(identity.privateKey),
  }, AAD.IDENTITY, 0o600);
}

/**
 * 加载或创建本机长期 Ed25519 身份。
 *
 * 身份就是公钥，私钥只保存在本机：
 * - 文件权限固定 0600；
 * - 不写入 settings.json，避免被随意复制；
 * - 设置本地密码后，私钥文件使用 AES-256-GCM 加密；
 * - 私钥损坏/不匹配时重新生成（当前不兼容旧身份）。
 */
function loadOrCreateIdentity(directory, options = {}) {
  const key = options.key || null;
  const file = path.join(directory, FILE_NAME);
  let legacy = false;

  try {
    let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isEnvelope(raw)) {
      if (!key) throw new Error('身份密钥已加密，请先输入本地密码');
      raw = decryptJson(key, raw, AAD.IDENTITY);
    } else {
      legacy = true;
    }
    const parsed = identityFromRecord(raw);
    if (parsed) {
      if (key && legacy) saveIdentity(directory, parsed, key);
      return { id: parsed.id, publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
  } catch (error) {
    if (error && (error.code === 'LOCAL_DECRYPT_FAILED' || /已加密|本地密码/.test(error.message))) {
      throw error;
    }
    /* 首次运行或文件损坏 */
  }

  const identity = createIdentity();
  saveIdentity(directory, identity, key);
  return identity;
}

module.exports = { loadOrCreateIdentity };
