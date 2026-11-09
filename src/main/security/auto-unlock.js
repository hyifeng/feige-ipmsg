'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readJsonSync, writeJsonAtomicSync } = require('./local-crypto');

const FILE_NAME = 'auto-unlock.json';
const PREF_FILE_NAME = 'auto-unlock-pref.json';
const VERSION = 1;
const KEY_BYTES = 32;
const SECURE_LINUX_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);

/**
 * 下次免密令牌。
 *
 * 这里保存的是用系统钥匙串（Electron safeStorage）加密后的 DEK，
 * 而不是 Local pass。Linux 上 basic_text 后端不具备真正的保护能力，
 * 因此不会启用免密，也不会写入令牌。
 */
class AutoUnlockStore {
  constructor(directory, options = {}) {
    this.file = path.join(directory, FILE_NAME);
    this.prefFile = path.join(directory, PREF_FILE_NAME);
    this.safeStorage = options.safeStorage || null;
    this.platform = options.platform || process.platform;
  }

  backendName() {
    if (!this.safeStorage) return 'unknown';
    if (this.platform !== 'linux') return this.platform;
    try {
      return this.safeStorage.getSelectedStorageBackend() || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  isBackendSecure() {
    if (this.platform !== 'linux') return true;
    return SECURE_LINUX_BACKENDS.has(this.backendName());
  }

  unavailableReason() {
    if (!this.safeStorage) return '当前环境不支持系统钥匙串';
    if (!this.isBackendSecure()) {
      return `当前桌面使用的 ${this.backendName()} 后端不是安全的系统钥匙串`;
    }
    return '系统钥匙串当前不可用';
  }

  async isAvailable() {
    if (!this.safeStorage || !this.isBackendSecure()) return false;
    try {
      if (typeof this.safeStorage.isAsyncEncryptionAvailable === 'function') {
        return await this.safeStorage.isAsyncEncryptionAvailable();
      }
      if (typeof this.safeStorage.isEncryptionAvailable === 'function') {
        return !!this.safeStorage.isEncryptionAvailable();
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  hasToken() {
    return fs.existsSync(this.file);
  }

  /**
   * 用户是否希望下次免密。令牌被删除后这个偏好仍保留，
   * 避免用户关闭免密后，下次手动解锁时又被默认重新开启。
   */
  preferenceEnabled() {
    try {
      const raw = readJsonSync(this.prefFile);
      if (raw && raw.v === VERSION && typeof raw.enabled === 'boolean') return raw.enabled;
    } catch {
      /* 首次使用或文件损坏 */
    }
    return true;
  }

  setPreference(enabled) {
    writeJsonAtomicSync(this.prefFile, {
      v: VERSION,
      enabled: !!enabled,
      updatedAt: Date.now(),
    }, 0o600);
  }

  async save(key) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      return { ok: false, reason: 'invalid-key', message: '无效的本地数据密钥' };
    }
    if (!(await this.isAvailable())) {
      return { ok: false, reason: 'unavailable', message: this.unavailableReason() };
    }

    let encrypted;
    try {
      encrypted = await this.safeStorage.encryptStringAsync(key.toString('base64'));
    } catch (error) {
      console.error('[feige] 系统钥匙串加密免密令牌失败', error);
      return { ok: false, reason: 'encrypt-failed', message: '无法使用系统钥匙串保存免密令牌' };
    }
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) {
      return { ok: false, reason: 'encrypt-failed', message: '系统钥匙串返回了无效数据' };
    }

    try {
      writeJsonAtomicSync(this.file, {
        v: VERSION,
        backend: this.backendName(),
        data: encrypted.toString('base64'),
        createdAt: Date.now(),
      }, 0o600);
    } catch (error) {
      console.error('[feige] 保存免密令牌失败', error);
      return { ok: false, reason: 'write-failed', message: '无法保存免密令牌' };
    }
    try {
      this.setPreference(true);
    } catch (error) {
      // 令牌已经保存成功，偏好写入失败不应把免密判定为失败。
      console.error('[feige] 保存免密偏好失败', error);
    }
    return { ok: true };
  }

  async load() {
    if (!this.hasToken()) return { ok: false, reason: 'missing', message: '未启用免密登录' };
    if (!(await this.isAvailable())) {
      return { ok: false, reason: 'unavailable', message: this.unavailableReason() };
    }

    let raw;
    try {
      raw = readJsonSync(this.file);
    } catch {
      return { ok: false, reason: 'invalid', message: '免密令牌已损坏' };
    }
    if (!raw || raw.v !== VERSION || typeof raw.data !== 'string') {
      return { ok: false, reason: 'invalid', message: '免密令牌格式无效' };
    }

    let text;
    try {
      const result = await this.safeStorage.decryptStringAsync(Buffer.from(raw.data, 'base64'));
      text = typeof result === 'string' ? result : (result && result.result);
    } catch (error) {
      console.error('[feige] 系统钥匙串解密免密令牌失败', error);
      return { ok: false, reason: 'failed', message: '系统钥匙串无法解密免密令牌' };
    }
    if (typeof text !== 'string') {
      return { ok: false, reason: 'failed', message: '系统钥匙串返回了无效数据' };
    }

    let key;
    try {
      key = Buffer.from(text, 'base64');
    } catch {
      return { ok: false, reason: 'invalid', message: '免密令牌内容无效' };
    }
    if (key.length !== KEY_BYTES) {
      key.fill(0);
      return { ok: false, reason: 'invalid', message: '免密令牌内容无效' };
    }
    return { ok: true, key, backend: raw.backend || '' };
  }

  clear() {
    try {
      fs.rmSync(this.file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  disable() {
    this.clear();
    try {
      this.setPreference(false);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { AutoUnlockStore };
