'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const { previewOf, normalizeMessage } = require('./message');
const {
  AAD,
  isEnvelope,
  encryptJson,
  decryptJson,
  readJson,
  writeJsonAtomic,
} = require('../security/local-crypto');

const INDEX_VERSION = 1;
const DEFAULT_LIMIT = 100;
const MAX_LOAD_LIMIT = 500;
const MAX_SEARCH_RESULTS = 200;
const MAX_MESSAGES_PER_PEER = 5000;
const COMPACT_THRESHOLD = MAX_MESSAGES_PER_PEER + 500;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function fileForPeer(dir, peerKey) {
  const raw = String(peerKey).replace(/^id:/, '');
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'peer';
  return path.join(dir, `${safe}.jsonl`);
}

/**
 * 本地聊天记录：每个联系人一个 append-only JSONL 文件。
 *
 * 消息记录：{ t:'msg', ...message }
 * 状态补丁：{ t:'patch', id, patch }
 *
 * 补丁允许出现在消息之前，加载时会统一应用，避免传输事件比持久化先到。
 * 索引文件只保存联系人摘要，启动时无需读取所有会话。
 *
 * 设置本地密码后，每一行记录和索引都使用 AES-256-GCM 单独加密；
 * 旧的明文文件会在首次解锁时原地迁移。
 */
class HistoryStore {
  constructor(directory, options = {}) {
    this.dir = directory;
    this.indexPath = path.join(directory, 'index.json');
    this.key = options.key || null;
    this.peers = new Map();
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    if (this.key) await this._migratePlaintextFiles();
    await this._loadIndex();
    await this._reconcileIndex();
    if (this.key) await this._saveIndex();
    this.initialized = true;
    return this;
  }

  async flush() {
    await this.queue;
  }

  append(message, peer = null) {
    let normalized;
    try {
      normalized = normalizeMessage(message);
    } catch (error) {
      return Promise.reject(error);
    }

    return this._enqueue(async () => {
      const contact = this._touchContact(normalized, peer);
      const record = {
        t: 'msg',
        ...normalized,
        peerInfo: {
          user: contact.user,
          host: contact.host,
          ip: contact.ip,
          port: contact.port,
        },
      };
      await fsp.appendFile(
        fileForPeer(this.dir, normalized.peerKey),
        `${this._encodeRecord(record)}\n`,
        'utf8',
      );
      await this._saveIndex();
      if (contact.count > COMPACT_THRESHOLD) {
        await this._compact(normalized.peerKey);
      }
      return normalized;
    });
  }

  patch(peerKey, messageId, patch) {
    if (!peerKey || !messageId || !patch || typeof patch !== 'object') {
      return Promise.reject(new Error('无效的历史补丁'));
    }
    return this._enqueue(async () => {
      const record = { t: 'patch', id: String(messageId), patch, at: Date.now() };
      await fsp.appendFile(
        fileForPeer(this.dir, peerKey),
        `${this._encodeRecord(record)}\n`,
        'utf8',
      );
    });
  }

  async loadMessages(peerKey, options = {}) {
    await this.queue;
    const limit = clamp(options.limit, 1, MAX_LOAD_LIMIT, DEFAULT_LIMIT);
    const before = options.before == null
      ? null
      : (Number.isFinite(Number(options.before)) ? Number(options.before) : null);
    let messages = await this._materialize(peerKey);
    if (before != null) messages = messages.filter((message) => message.at < before);
    const hasMore = messages.length > limit;
    return {
      messages: hasMore ? messages.slice(messages.length - limit) : messages,
      hasMore,
    };
  }

  async contacts() {
    await this.queue;
    return [...this.peers.values()]
      .map((peer) => ({ ...peer, online: false, history: true }))
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  }

  async search(query, limit = MAX_SEARCH_RESULTS) {
    await this.queue;
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    const max = clamp(limit, 1, MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const found = [];

    for (const contact of this.peers.values()) {
      const messages = await this._materialize(contact.key);
      for (const message of messages) {
        const haystack = [
          contact.user,
          message.text,
          message.name,
          message.rootName,
          ...(message.files || []).map((file) => `${file.name} ${file.relPath}`),
        ].join(' ').toLowerCase();
        if (!haystack.includes(needle)) continue;
        found.push({ ...message, peer: { ...contact, online: false, history: true } });
      }
    }

    found.sort((a, b) => b.at - a.at);
    return found.slice(0, max);
  }

  clearAll() {
    return this._enqueue(async () => {
      let entries = [];
      try {
        entries = await fsp.readdir(this.dir);
      } catch {
        entries = [];
      }
      await Promise.all(entries
        .filter((name) => name.endsWith('.jsonl') || name === 'index.json' || name.includes('.tmp'))
        .map((name) => fsp.rm(path.join(this.dir, name), { force: true })));
      this.peers.clear();
    });
  }

  // ------------------------------------------------------------ 内部

  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  _encodeRecord(record) {
    return this.key
      ? JSON.stringify(encryptJson(this.key, record, AAD.HISTORY))
      : JSON.stringify(record);
  }

  async _writeLines(file, lines) {
    const text = lines.length ? `${lines.join('\n')}\n` : '';
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    try {
      await fsp.chmod(tmp, 0o600);
    } catch {
      /* ignore */
    }
    await fsp.rename(tmp, file);
  }

  async _migratePlaintextFiles() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return;
    }

    for (const name of entries.filter((entry) => entry.endsWith('.jsonl'))) {
      const file = path.join(this.dir, name);
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (!text.trim()) continue;

      const lines = [];
      let changed = false;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          changed = true;
          continue;
        }
        if (isEnvelope(event)) {
          lines.push(line);
          continue;
        }
        lines.push(JSON.stringify(encryptJson(this.key, event, AAD.HISTORY)));
        changed = true;
      }
      if (changed) await this._writeLines(file, lines);
    }
  }

  _touchContact(message, peer) {
    let contact = this.peers.get(message.peerKey);
    if (!contact) {
      contact = {
        key: message.peerKey,
        user: message.peerName || '未知联系人',
        host: '',
        ip: '',
        port: 0,
        online: false,
        history: true,
        lastAt: 0,
        lastText: '',
        lastKind: 'text',
        lastDirection: 'in',
        count: 0,
      };
      this.peers.set(message.peerKey, contact);
    }

    if (peer) {
      if (peer.user) contact.user = String(peer.user).slice(0, 64);
      if (peer.host) contact.host = String(peer.host).slice(0, 64);
      if (peer.ip) contact.ip = String(peer.ip).slice(0, 64);
      if (peer.port) contact.port = Number(peer.port) || 0;
    } else if (message.peerName) {
      contact.user = message.peerName;
    }

    contact.lastAt = message.at;
    contact.lastText = previewOf(message);
    contact.lastKind = message.kind;
    contact.lastDirection = message.direction;
    contact.count += 1;
    return contact;
  }

  async _materialize(peerKey) {
    const messages = await this._materializeFile(fileForPeer(this.dir, peerKey));
    return messages.filter((message) => message.peerKey === peerKey);
  }

  async _materializeFile(file) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return [];
    }

    const messages = new Map();
    const patches = new Map();

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isEnvelope(event)) {
        if (!this.key) throw new Error('聊天记录已加密，请先输入本地密码');
        event = decryptJson(this.key, event, AAD.HISTORY);
      }
      if (event.t === 'msg' && event.id) {
        const { t, ...message } = event;
        messages.set(message.id, message);
      } else if (event.t === 'patch' && event.id && event.patch && typeof event.patch === 'object') {
        if (!patches.has(event.id)) patches.set(event.id, []);
        patches.get(event.id).push(event.patch);
      }
    }

    for (const [id, message] of messages) {
      const list = patches.get(id);
      if (!list) continue;
      for (const patch of list) {
        const { fileState, imageState, ...rest } = patch;
        Object.assign(message, rest);
        if (fileState && typeof fileState === 'object') {
          message.fileState = { ...(message.fileState || {}), ...fileState };
        }
        if (imageState && typeof imageState === 'object') {
          message.imageState = { ...(message.imageState || {}), ...imageState };
        }
      }
    }

    return [...messages.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
  }

  async _loadIndex() {
    let raw;
    try {
      raw = await readJson(this.indexPath);
    } catch {
      /* 索引缺失/损坏时从会话文件重建 */
      return;
    }
    if (raw == null) return;

    let data = raw;
    if (isEnvelope(raw)) {
      if (!this.key) throw new Error('聊天记录索引已加密，请先输入本地密码');
      data = decryptJson(this.key, raw, AAD.HISTORY_INDEX);
    }
    if (!data || data.v !== INDEX_VERSION || !Array.isArray(data.peers)) return;

    for (const peer of data.peers) {
      if (!peer || !peer.key) continue;
      this.peers.set(peer.key, {
        key: String(peer.key),
        user: String(peer.user || '未知联系人'),
        host: String(peer.host || ''),
        ip: String(peer.ip || ''),
        port: Number(peer.port) || 0,
        online: false,
        history: true,
        lastAt: Number(peer.lastAt) || 0,
        lastText: String(peer.lastText || ''),
        lastKind: peer.lastKind === 'files' ? 'files' : 'text',
        lastDirection: peer.lastDirection === 'out' ? 'out' : 'in',
        count: Math.max(0, Math.floor(Number(peer.count) || 0)),
      });
    }
  }

  async _reconcileIndex() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    const files = entries.filter((name) => name.endsWith('.jsonl'));
    const expected = new Set(
      [...this.peers.keys()].map((key) => path.basename(fileForPeer(this.dir, key))),
    );
    const mismatch = files.length !== expected.size || files.some((name) => !expected.has(name));
    if (mismatch) await this._rebuildIndex();
  }

  async _rebuildIndex() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return;
    }

    this.peers.clear();
    for (const name of entries.filter((entry) => entry.endsWith('.jsonl'))) {
      const file = path.join(this.dir, name);
      const messages = await this._materializeFile(file);
      if (!messages.length) {
        await fsp.rm(file, { force: true });
        continue;
      }
      const first = messages[0];
      const last = messages[messages.length - 1];
      if (!first.peerKey) continue;
      const info = last.peerInfo || first.peerInfo || {};
      this.peers.set(first.peerKey, {
        key: first.peerKey,
        user: info.user || last.peerName || first.peerName || '未知联系人',
        host: info.host || '',
        ip: info.ip || '',
        port: Number(info.port) || 0,
        online: false,
        history: true,
        lastAt: last.at || 0,
        lastText: previewOf(last),
        lastKind: last.kind,
        lastDirection: last.direction,
        count: messages.length,
      });
    }
    await this._saveIndex();
  }

  async _saveIndex() {
    const peers = [...this.peers.values()].map((peer) => ({
      key: peer.key,
      user: peer.user,
      host: peer.host,
      ip: peer.ip,
      port: peer.port,
      lastAt: peer.lastAt,
      lastText: peer.lastText,
      lastKind: peer.lastKind,
      lastDirection: peer.lastDirection,
      count: peer.count,
    }));
    const payload = { v: INDEX_VERSION, peers };
    await writeJsonAtomic(
      this.indexPath,
      this.key ? encryptJson(this.key, payload, AAD.HISTORY_INDEX) : payload,
      0o600,
    );
  }

  async _compact(peerKey) {
    const messages = await this._materialize(peerKey);
    if (messages.length <= MAX_MESSAGES_PER_PEER) return;
    const kept = messages.slice(messages.length - MAX_MESSAGES_PER_PEER);
    const file = fileForPeer(this.dir, peerKey);
    const lines = kept.map((message) => this._encodeRecord({ t: 'msg', ...message }));
    await this._writeLines(file, lines);
    const contact = this.peers.get(peerKey);
    if (contact) {
      contact.count = kept.length;
      await this._saveIndex();
    }
  }
}

module.exports = { HistoryStore };
