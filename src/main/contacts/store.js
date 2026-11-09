'use strict';

const path = require('node:path');

const { isIdentity, identityOfPeerKey, peerKeyOf, shortIdentity } = require('../../shared/protocol/identity');
const {
  AAD,
  isEnvelope,
  decryptJson,
  readJsonSync,
  writeProtectedJsonSync,
} = require('../security/local-crypto');

const FILE_NAME = 'contacts.json';

function cleanAlias(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

/**
 * 本地联系人簿：别名只保存在本机，按完整公钥索引。
 *
 * - 远程昵称永远不参与“可信显示名”的判定；
 * - 没有别名的身份一律显示为“未认证设备”；
 * - 同名不同 key 不会合并，UI 会显式提示。
 */
class ContactsStore {
  constructor(directory, options = {}) {
    this.dir = directory;
    this.file = path.join(directory, FILE_NAME);
    this.key = options.key || null;
    this.entries = new Map();
    this._load();
  }

  _load() {
    let raw;
    let legacy = false;
    try {
      raw = readJsonSync(this.file);
      if (raw == null) return;
      if (isEnvelope(raw)) {
        if (!this.key) throw new Error('联系人簿已加密，请先输入本地密码');
        raw = decryptJson(this.key, raw, AAD.CONTACTS);
      } else {
        legacy = true;
      }
      const contacts = raw && raw.v === 1 && raw.contacts && typeof raw.contacts === 'object'
        ? raw.contacts
        : {};
      for (const [identity, record] of Object.entries(contacts)) {
        if (!isIdentity(identity) || !record) continue;
        const alias = cleanAlias(record.alias);
        if (!alias) continue;
        this.entries.set(identity, {
          alias,
          updatedAt: Number(record.updatedAt) || Date.now(),
        });
      }
    } catch (error) {
      if (error && (error.code === 'LOCAL_DECRYPT_FAILED' || /已加密|本地密码/.test(error.message))) {
        throw error;
      }
      /* 首次运行或文件损坏 */
      return;
    }
    if (legacy && this.key) this._save();
  }

  _save() {
    const contacts = {};
    for (const [identity, record] of this.entries) contacts[identity] = record;
    writeProtectedJsonSync(this.file, this.key, { v: 1, contacts }, AAD.CONTACTS, 0o600);
  }

  get(identity) {
    if (!isIdentity(identity)) return null;
    return this.entries.get(identity) || null;
  }

  aliasFor(identity) {
    const record = this.get(identity);
    return record ? record.alias : '';
  }

  aliasForPeerKey(peerKey) {
    return this.aliasFor(identityOfPeerKey(peerKey));
  }

  setAlias(identity, value) {
    if (!isIdentity(identity)) throw new Error('无效的身份公钥');
    const alias = cleanAlias(value);
    if (!alias) return this.remove(identity);
    this.entries.set(identity, { alias, updatedAt: Date.now() });
    this._save();
    return this.get(identity);
  }

  remove(identity) {
    if (!isIdentity(identity)) return false;
    const removed = this.entries.delete(identity);
    if (removed) this._save();
    return removed;
  }

  list() {
    return [...this.entries.entries()]
      .map(([identity, record]) => ({
        identity,
        peerKey: peerKeyOf(identity),
        alias: record.alias,
        updatedAt: record.updatedAt,
      }))
      .sort((a, b) => a.alias.localeCompare(b.alias, 'zh-Hans-CN'));
  }

  displayFor(identity, claimed = '') {
    const alias = this.aliasFor(identity);
    const claimedName = cleanAlias(claimed);
    return {
      identity,
      peerKey: peerKeyOf(identity),
      alias,
      unnamed: !(alias || claimedName),
      label: alias || claimedName || '未认证设备',
      fingerprint: shortIdentity(identity),
      claimed: claimedName,
    };
  }

  displayForPeerKey(peerKey, claimed = '') {
    return this.displayFor(identityOfPeerKey(peerKey), claimed);
  }
}

module.exports = { ContactsStore, cleanAlias };
