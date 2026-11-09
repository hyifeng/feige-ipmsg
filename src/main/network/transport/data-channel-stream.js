'use strict';

const { Duplex } = require('node:stream');

const CHUNK_BYTES = 64 * 1024;
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;

/**
 * 把 WebRTC DataChannel 包装成 Node Duplex，供现有文件 / 清单 / 加密握手
 * 流代码直接复用。DataChannel 是消息语义，这里切成小块并做发送背压。
 */
class DataChannelStream extends Duplex {
  constructor(channel, options = {}) {
    super({ allowHalfOpen: false });
    this.channel = channel;
    this.peerKey = options.peerKey || '';
    this.purpose = options.purpose || '';
    this.transport = 'direct';
    this.connected = false;
    this.channelClosed = false;
    this.ending = false;
    this.queue = [];
    this.flushing = false;
    this.waitingLow = false;
    this.subscriptions = [];
    this.closeTimer = null;
    this.connectTimer = null;

    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    this._subscribe(channel.onMessage, (data) => {
      if (!this.destroyed) this.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    });
    this._subscribe(channel.stateChange, (state) => {
      if (state === 'open') this._markOpen();
      else if (state === 'closed' && !this.channelClosed) this._markClosed();
    });
    this._subscribe(channel.bufferedAmountLow, () => {
      this.waitingLow = false;
      this._flush();
    });
    this._subscribe(channel.error, (error) => this.destroy(error));

    if (channel.readyState === 'open') setImmediate(() => this._markOpen());
    else {
      this.connectTimer = setTimeout(() => {
        if (!this.connected && !this.channelClosed) this.destroy(new Error('直连通道建立超时'));
      }, 45000);
    }
  }

  _subscribe(event, handler) {
    if (!event || typeof event.subscribe !== 'function') return;
    const subscription = event.subscribe(handler);
    this.subscriptions.push(subscription);
  }

  _markOpen() {
    if (this.connected) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.connected = true;
    this.emit('connect');
    this._flush();
  }

  _markClosed() {
    if (this.channelClosed) return;
    this.channelClosed = true;
    this.push(null);
    if (!this.destroyed) this.destroy();
  }

  _read() {
    // DataChannel 没有读暂停语义；数据由 onMessage 推入 Duplex 缓冲。
  }

  _write(chunk, _encoding, callback) {
    if (this.channelClosed) {
      callback(new Error('加密连接已关闭'));
      return;
    }
    this.queue.push({ buffer: Buffer.from(chunk), callback });
    this._flush();
  }

  _flush() {
    if (!this.connected || this.channelClosed || this.flushing) return;
    this.flushing = true;
    while (this.queue.length) {
      if (this.channel.bufferedAmount > HIGH_WATER_BYTES) {
        this.waitingLow = true;
        this.flushing = false;
        return;
      }
      const item = this.queue[0];
      if (!item.buffer.length) {
        this.queue.shift();
        item.callback();
        continue;
      }
      const piece = item.buffer.subarray(0, CHUNK_BYTES);
      item.buffer = item.buffer.subarray(piece.length);
      try {
        this.channel.send(piece);
      } catch (error) {
        this.queue.shift();
        item.callback(error);
        this.destroy(error);
        this.flushing = false;
        return;
      }
      if (!item.buffer.length) {
        this.queue.shift();
        item.callback();
      }
    }
    this.flushing = false;
    if (this.ending && !this.queue.length) this._closeAfterDrain();
  }

  _final(callback) {
    this.ending = true;
    this.finalCallback = callback;
    this._flush();
    if (!this.queue.length && this.connected) this._closeAfterDrain();
  }

  _closeAfterDrain() {
    if (this.closeTimer || this.channelClosed) return;
    const wait = () => {
      this.closeTimer = null;
    this.connectTimer = null;
      if (this.channelClosed) return;
      if (this.channel.bufferedAmount > 0) {
        this.closeTimer = setTimeout(wait, 50);
        return;
      }
      const callback = this.finalCallback;
      this.finalCallback = null;
      if (callback) callback();
      try {
        this.channel.close();
      } catch {
        /* ignore */
      }
    };
    // 给 SCTP 一点时间把最后的数据交给 DTLS/ICE。
    this.closeTimer = setTimeout(wait, 120);
  }

  _destroy(error, callback) {
    this.channelClosed = true;
    this.queue = [];
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.connectTimer = null;
    const finalCallback = this.finalCallback;
    this.finalCallback = null;
    if (finalCallback) finalCallback(error || new Error('连接已关闭'));
    for (const subscription of this.subscriptions) {
      try {
        subscription.unSubscribe();
      } catch {
        /* ignore */
      }
    }
    this.subscriptions = [];
    try {
      this.channel.close();
    } catch {
      /* ignore */
    }
    callback(error || undefined);
  }

  setTimeout() {}
  setNoDelay() {}
  setKeepAlive() {}
}

module.exports = { DataChannelStream };
