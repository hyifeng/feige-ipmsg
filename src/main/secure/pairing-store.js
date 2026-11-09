'use strict';

const path = require('node:path');

const {
  AAD,
  isEnvelope,
  decryptJson,
  readJsonSync,
  writeProtectedJsonSync,
} = require('../security/local-crypto');

/**
 * 保存首次 SAS 验证通过后生成的高熵 pairing key。
 *
 * 与聊天记录一样使用本地密码派生的 AES-256-GCM 密钥加密后落盘，
 * 文件权限固定为 0600。
 */
class SecurePairingStore {
  constructor(directory, options = {}) {
    this.dir = directory;
    this.file = path.join(directory, 'secure-pairings.json');
    this.key = options.key || null;
    this.records = new Map();
    this._load();
  }

  _load() {
    let raw;
    let legacy = false;
    try {
      raw = readJsonSync(this.file);
      if (raw == null) return;
      if (isEnvelope(raw)) {
        if (!this.key) throw new Error('加密配对数据已锁定，请先输入本地密码');
        raw = decryptJson(this.key, raw, AAD.PAIRINGS);
      } else {
        legacy = true;
      }
      const peers = raw && raw.v === 1 && raw.peers && typeof raw.peers === 'object' ? raw.peers : {};
      for (const [peerKey, record] of Object.entries(peers)) {
        if (!record || typeof record.data !== 'string') continue;
        this.records.set(peerKey, {
          data: record.data,
          user: String(record.user || '未知联系人'),
          updatedAt: Number(record.updatedAt) || 0,
        });
      }
    } catch (error) {
      if (error && (error.code === 'LOCAL_DECRYPT_FAILED' || /已加密|本地密码|锁定/.test(error.message))) {
        throw error;
      }
      /* 首次运行或文件损坏 */
      return;
    }
    if (legacy && this.key) this._save();
  }

  get(peerKey) {
    const record = this.records.get(peerKey);
    if (!record) return null;
    try {
      const key = Buffer.from(record.data, 'base64');
      if (key.length !== 32) return null;
      return { key, user: record.user };
    } catch {
      return null;
    }
  }

  set(peerKey, value) {
    if (!value || !Buffer.isBuffer(value.key) || value.key.length !== 32) {
      throw new Error('无效的加密配对密钥');
    }
    this.records.set(peerKey, {
      data: value.key.toString('base64'),
      user: String(value.user || '未知联系人').slice(0, 64),
      updatedAt: Date.now(),
    });
    this._save();
  }

  delete(peerKey) {
    if (!this.records.delete(peerKey)) return false;
    this._save();
    return true;
  }

  list() {
    return [...this.records.entries()]
      .map(([peerKey, record]) => ({ peerKey, user: record.user }))
      .sort((a, b) => a.user.localeCompare(b.user, 'zh-Hans-CN'));
  }

  _save() {
    const peers = {};
    for (const [peerKey, record] of this.records) peers[peerKey] = record;
    writeProtectedJsonSync(this.file, this.key, { v: 1, peers }, AAD.PAIRINGS, 0o600);
  }
}

module.exports = { SecurePairingStore };
