'use strict';

const { EventEmitter } = require('node:events');

const MAX_QUEUE = 256;

/**
 * 与虚拟 LAN Hub 的底层连接。
 *
 * 只做三件传输层的事：
 * - bind：注册自己的 identity，供信令路由
 * - broadcast：广播不透明帧
 * - signal：把 WebRTC 信令转发给目标 identity
 *
 * 不解析飞鸽协议，不维护在线列表。
 */
class HubClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = String(options.url || '');
    this.identity = String(options.identity || '');
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.stopped = true;
    this.socket = null;
    this.status = 'closed';
    this.attempts = 0;
    this.retryTimer = null;
    this.queue = [];
  }

  async start() {
    if (!this.url) return;
    this.stopped = false;
    this._connect();
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.queue = [];
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    this._setStatus('closed');
  }

  reconnect() {
    if (this.stopped) return;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    this.attempts = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this._connect();
  }

  broadcast(payload) {
    if (typeof payload !== 'string') return false;
    if (!this._isOpen()) return false;
    return this._send({ type: 'broadcast', payload });
  }

  sendSignal(to, payload) {
    if (!to || typeof payload !== 'string') return false;
    const target = String(to).startsWith('id:') ? String(to).slice(3) : String(to);
    const frame = { type: 'signal', to: target, payload };
    if (this._isOpen()) {
      this._send(frame);
      return true;
    }
    if (this.queue.length < MAX_QUEUE) this.queue.push(frame);
    return false;
  }

  _connect() {
    if (this.stopped || !this.url) return;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    if (typeof this.WebSocketImpl !== 'function') {
      this._setStatus('error', '当前运行环境不支持 WebSocket');
      return;
    }

    this._setStatus('connecting');
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this._setStatus('error', error.message || String(error));
      this._scheduleReconnect();
      return;
    }
    this.socket = socket;

    const onOpen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this._setStatus('open');
      this._send({ type: 'bind', identity: this.identity });
      this.emit('open');
      const queued = this.queue.splice(0);
      for (const frame of queued) this._send(frame);
    };
    const onMessage = (event) => {
      if (this.socket !== socket) return;
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'broadcast') {
        this.emit('broadcast', { from: frame.from, payload: frame.payload });
      } else if (frame.type === 'signal') {
        this.emit('signal', { from: frame.from, payload: frame.payload });
      }
    };
    const onError = () => {
      if (this.socket !== socket) return;
      this._setStatus('error');
    };
    const onClose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const reason = String(event.reason || '');
      if (event.code === 1008 && reason === 'replaced') {
        this.stopped = true;
        this._setStatus('replaced', '同一身份已在其他地方上线');
        return;
      }
      this._setStatus('closed');
      if (!this.stopped) this._scheduleReconnect();
    };

    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    } else {
      socket.onopen = onOpen;
      socket.onmessage = onMessage;
      socket.onerror = onError;
      socket.onclose = onClose;
    }
  }

  _scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(this.attempts, 5)));
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._connect();
    }, delay);
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  _send(frame) {
    if (!this._isOpen()) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  _isOpen() {
    return !!this.socket && this.socket.readyState === 1;
  }

  _setStatus(status, message = '') {
    if (this.status === status && !message) return;
    this.status = status;
    this.emit('status', { status, message, url: this.url });
  }
}

module.exports = { HubClient };
