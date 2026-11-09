'use strict';

const { CLOCK_SKEW_MS, REPLAY_CACHE_MS } = require('../../shared/protocol');

/**
 * 签名消息的防重放窗口。
 *
 * - 时间戳必须在允许的时钟偏差内；
 * - 同一个 msgId / nonce 只接受一次；
 * - 缓存按时间淘汰，并设置硬上限，避免内存被撑爆。
 *
 * 进程重启后缓存会清空。由于时间戳窗口只有 5 分钟，攻击者必须在重启
 * 后 5 分钟内重放一条刚抓到的包才可能成功；后续如需更强保证，可把
 * messages 落盘。
 */
class ReplayGuard {
  constructor(options = {}) {
    this.windowMs = options.windowMs || REPLAY_CACHE_MS;
    this.skewMs = options.skewMs || CLOCK_SKEW_MS;
    this.maxEntries = options.maxEntries || 20000;
    this.messages = new Map();
    this.nonces = new Map();
  }

  _fresh(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return false;
    return Math.abs(Date.now() - value) <= this.skewMs;
  }

  checkMessage(sender, msgId, timestamp) {
    if (!sender || !msgId || !this._fresh(timestamp)) return false;
    const key = `${sender}\u0000${msgId}`;
    if (this.messages.has(key)) return false;
    this.messages.set(key, Date.now());
    this._prune();
    return true;
  }

  checkNonce(sender, nonce, timestamp) {
    if (!sender || !nonce || !this._fresh(timestamp)) return false;
    const key = `${sender}\u0000${nonce}`;
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, Date.now());
    this._prune();
    return true;
  }

  _prune() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, at] of this.messages) {
      if (at >= cutoff) break;
      this.messages.delete(key);
    }
    for (const [key, at] of this.nonces) {
      if (at >= cutoff) break;
      this.nonces.delete(key);
    }
    while (this.messages.size > this.maxEntries) {
      this.messages.delete(this.messages.keys().next().value);
    }
    while (this.nonces.size > this.maxEntries) {
      this.nonces.delete(this.nonces.keys().next().value);
    }
  }
}

module.exports = { ReplayGuard };
