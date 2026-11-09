'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  AAD,
  isEnvelope,
  encryptJson,
  decryptJson,
  writeJsonAtomicSync,
} = require('./local-crypto');

const FILE_NAME = 'local-pass.json';
const FILE_VERSION = 2;
const LEGACY_VERSION = 1;
const MIN_LENGTH = 6;
const MAX_LENGTH = 256;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAGIC_V1 = 'feige-local-pass-v1';
const MAGIC_DEK = 'feige-dek-v1';

const KDF = {
  name: 'scrypt',
  N: 1 << 15,
  r: 8,
  p: 1,
};

function validatePass(pass) {
  if (typeof pass !== 'string') return { ok: false, message: '请输入本地密码' };
  if (!pass.trim()) return { ok: false, message: '本地密码不能全部为空格' };
  const length = [...pass].length;
  if (length < MIN_LENGTH) return { ok: false, message: `本地密码至少需要 ${MIN_LENGTH} 位` };
  if (length > MAX_LENGTH) return { ok: false, message: `本地密码不能超过 ${MAX_LENGTH} 位` };
  return { ok: true };
}

function validKdf(raw) {
  if (!raw || raw.name !== KDF.name) return false;
  const N = Number(raw.N);
  const r = Number(raw.r);
  const p = Number(raw.p);
  const keylen = Number(raw.keylen);
  const salt = typeof raw.salt === 'string' ? Buffer.from(raw.salt, 'base64') : null;
  return Number.isInteger(N)
    && [1 << 14, 1 << 15, 1 << 16, 1 << 17].includes(N)
    && Number.isInteger(r)
    && r >= 1
    && r <= 16
    && Number.isInteger(p)
    && p >= 1
    && p <= 4
    && keylen === KEY_BYTES
    && !!salt
    && salt.length >= 16
    && salt.length <= 64;
}

function normalizeKdf(raw) {
  return {
    name: KDF.name,
    N: Number(raw.N),
    r: Number(raw.r),
    p: Number(raw.p),
    keylen: KEY_BYTES,
    salt: Buffer.from(raw.salt, 'base64'),
  };
}

function serializeKdf(params) {
  return {
    name: KDF.name,
    N: params.N,
    r: params.r,
    p: params.p,
    keylen: KEY_BYTES,
    salt: params.salt.toString('base64'),
  };
}

function deriveKey(pass, salt, params) {
  const N = params.N;
  const r = params.r;
  const p = params.p;
  const maxmem = Math.max(64 * 1024 * 1024, 128 * N * r + 2 * 1024 * 1024);
  return crypto.scryptSync(pass, salt, KEY_BYTES, { N, r, p, maxmem });
}

/**
 * 本地密码使用 DEK + KEK 信封结构：
 *
 * - DEK：随机数据密钥，真正加密 settings / history / contacts 等本地资料；
 * - KEK：由本地密码通过 scrypt 派生，只用于包裹 DEK；
 * - 修改密码只重新包裹 DEK，不需要重新加密聊天记录；
 * - 免密登录时由 safeStorage 保存 DEK，再用 keyCheck 验证。
 *
 * v1 旧文件仍兼容：旧的数据密钥会直接作为 DEK 包裹进 v2，数据文件无需改动。
 */
class LocalPass {
  constructor(directory) {
    this.dir = directory;
    this.file = path.join(directory, FILE_NAME);
    this.key = null;
    this.meta = null;
    this.metaError = null;
    this.fileExists = fs.existsSync(this.file);
    this._load();
  }

  _load() {
    if (!this.fileExists) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.v === FILE_VERSION) {
        if (!validKdf(raw.kdf) || !isEnvelope(raw.wrap) || !isEnvelope(raw.keyCheck)) {
          throw new Error('本地密码配置格式无效');
        }
        this.meta = {
          v: FILE_VERSION,
          kdf: normalizeKdf(raw.kdf),
          wrap: raw.wrap,
          keyCheck: raw.keyCheck,
          createdAt: Number(raw.createdAt) || Date.now(),
          updatedAt: Number(raw.updatedAt) || 0,
        };
        return;
      }

      if (raw && raw.v === LEGACY_VERSION) {
        if (!validKdf(raw.kdf) || !isEnvelope(raw.check)) {
          throw new Error('本地密码配置格式无效');
        }
        this.meta = {
          v: LEGACY_VERSION,
          kdf: normalizeKdf(raw.kdf),
          check: raw.check,
          createdAt: Number(raw.createdAt) || Date.now(),
          updatedAt: Number(raw.updatedAt) || 0,
        };
        return;
      }

      throw new Error('本地密码配置格式无效');
    } catch (error) {
      this.metaError = error;
    }
  }

  isConfigured() {
    return this.fileExists;
  }

  isUnlocked() {
    return !!this.key;
  }

  isCorrupted() {
    return this.fileExists && !this.meta;
  }

  setup(pass) {
    if (this.fileExists) throw new Error('本地密码已设置，请输入本地密码解锁');
    const validation = validatePass(pass);
    if (!validation.ok) throw new Error(validation.message);

    const dek = crypto.randomBytes(KEY_BYTES);
    try {
      this._writeV2(pass, dek, Date.now());
    } catch (error) {
      dek.fill(0);
      throw error;
    }
    this.key = dek;
    return Buffer.from(dek);
  }

  unlock(pass) {
    if (!this.meta) {
      throw new Error(this.isCorrupted() ? '本地密码配置已损坏，无法解锁' : '尚未设置本地密码');
    }
    if (typeof pass !== 'string' || !pass) return false;

    if (this.meta.v === FILE_VERSION) {
      const dek = this._unwrapV2(pass);
      if (!dek) return false;
      this.key = dek;
      return true;
    }

    // v1：原来的密码派生密钥就是数据密钥，直接把它升级为 v2 的 DEK。
    let oldKey;
    try {
      oldKey = deriveKey(pass, this.meta.kdf.salt, this.meta.kdf);
      const check = decryptJson(oldKey, this.meta.check, AAD.LOCAL_PASS);
      if (!check || check.magic !== MAGIC_V1) {
        oldKey.fill(0);
        return false;
      }
    } catch {
      if (oldKey) oldKey.fill(0);
      return false;
    }

    try {
      this._writeV2(pass, oldKey, this.meta.createdAt || Date.now());
    } catch (error) {
      // 升级失败时仍允许本次使用 v1；下次解锁会再次尝试升级。
      console.error('[feige] 本地密码 v1 升级失败', error);
    }

    this.key = oldKey;
    return true;
  }

  /**
   * 用已经拿到的 DEK 解锁，供系统钥匙串免密登录使用。
   * 通过 keyCheck 验证，不重新执行 scrypt。
   */
  unlockWithKey(key) {
    if (!this.meta) {
      throw new Error(this.isCorrupted() ? '本地密码配置已损坏，无法解锁' : '尚未设置本地密码');
    }
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) return false;

    try {
      const check = this.meta.v === FILE_VERSION
        ? decryptJson(key, this.meta.keyCheck, AAD.LOCAL_PASS_KEY_CHECK)
        : decryptJson(key, this.meta.check, AAD.LOCAL_PASS);
      const magic = this.meta.v === FILE_VERSION ? MAGIC_DEK : MAGIC_V1;
      if (!check || check.magic !== magic) return false;
    } catch {
      return false;
    }

    this.key = Buffer.from(key);
    return true;
  }

  /**
   * 修改本地密码：只重新包裹现有 DEK，不重新加密任何本地资料。
   * 旧密码错误返回 false；新密码格式非法时抛错。
   */
  changePass(oldPass, newPass) {
    if (!this.meta) {
      throw new Error(this.isCorrupted() ? '本地密码配置已损坏，无法修改' : '尚未设置本地密码');
    }
    const validation = validatePass(newPass);
    if (!validation.ok) throw new Error(validation.message);
    if (typeof oldPass !== 'string' || !oldPass) return false;

    let dek = null;
    if (this.meta.v === FILE_VERSION) {
      dek = this._unwrapV2(oldPass);
    } else {
      let oldKey;
      try {
        oldKey = deriveKey(oldPass, this.meta.kdf.salt, this.meta.kdf);
        const check = decryptJson(oldKey, this.meta.check, AAD.LOCAL_PASS);
        if (check && check.magic === MAGIC_V1) dek = oldKey;
        else oldKey.fill(0);
      } catch {
        if (oldKey) oldKey.fill(0);
      }
    }
    if (!dek) return false;

    try {
      this._writeV2(newPass, dek, this.meta.createdAt || Date.now());
    } finally {
      dek.fill(0);
    }
    return true;
  }

  getKey() {
    if (!this.key) throw new Error('本地密码尚未解锁');
    return this.key;
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
  }

  destroy() {
    this.lock();
    this.meta = null;
    this.metaError = null;
  }

  _writeV2(pass, dek, createdAt) {
    if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) {
      throw new Error('无效的本地数据密钥');
    }

    const salt = crypto.randomBytes(SALT_BYTES);
    const params = { ...KDF, keylen: KEY_BYTES, salt };
    let wrap;
    let keyCheck;
    const kek = deriveKey(pass, salt, params);
    try {
      wrap = encryptJson(kek, { dek: dek.toString('base64') }, AAD.LOCAL_PASS_WRAP);
      keyCheck = encryptJson(dek, { magic: MAGIC_DEK }, AAD.LOCAL_PASS_KEY_CHECK);
    } finally {
      kek.fill(0);
    }

    const now = Date.now();
    const created = Number(createdAt) || now;
    const payload = {
      v: FILE_VERSION,
      kdf: serializeKdf(params),
      wrap,
      keyCheck,
      createdAt: created,
      updatedAt: now,
    };

    writeJsonAtomicSync(this.file, payload, 0o600);
    this.fileExists = true;
    this.metaError = null;
    this.meta = {
      v: FILE_VERSION,
      kdf: params,
      wrap,
      keyCheck,
      createdAt: created,
      updatedAt: now,
    };
    return this.meta;
  }

  _unwrapV2(pass) {
    let kek;
    try {
      kek = deriveKey(pass, this.meta.kdf.salt, this.meta.kdf);
    } catch {
      return null;
    }

    let dek = null;
    try {
      const wrapped = decryptJson(kek, this.meta.wrap, AAD.LOCAL_PASS_WRAP);
      if (!wrapped || typeof wrapped.dek !== 'string') return null;
      dek = Buffer.from(wrapped.dek, 'base64');
      if (dek.length !== KEY_BYTES) {
        dek.fill(0);
        return null;
      }
      const check = decryptJson(dek, this.meta.keyCheck, AAD.LOCAL_PASS_KEY_CHECK);
      if (!check || check.magic !== MAGIC_DEK) {
        dek.fill(0);
        return null;
      }
      return dek;
    } catch {
      if (dek) dek.fill(0);
      return null;
    } finally {
      kek.fill(0);
    }
  }
}

module.exports = {
  LocalPass,
  validatePass,
  MIN_LENGTH,
  MAX_LENGTH,
};
