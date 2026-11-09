'use strict';

const { MAX_FRAME_BYTES } = require('./constants');

class FrameSocket {
  constructor(socket, onFrame, initial = null) {
    this.socket = socket;
    this.onFrame = onFrame;
    this.buffer = initial && initial.length ? Buffer.from(initial) : Buffer.alloc(0);
    this.closed = false;
    this.paused = false;
    this.writeQueue = Promise.resolve();

    socket.on('data', (chunk) => this.push(chunk));
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
    if (this.buffer.length) setImmediate(() => this._parse());
  }

  push(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._parse();
  }

  _parse() {
    if (this.closed) return;
    while (!this.paused && this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        this.destroy();
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const raw = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let frame;
      try {
        frame = JSON.parse(raw.toString('utf8'));
      } catch {
        this.destroy();
        return;
      }
      try {
        this.onFrame(frame);
      } catch {
        this.destroy();
        return;
      }
    }
  }

  send(value) {
    if (this.closed) return Promise.reject(new Error('加密连接已关闭'));
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > MAX_FRAME_BYTES) return Promise.reject(new Error('加密帧过大'));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const frame = Buffer.concat([length, data]);

    const write = async () => {
      if (this.closed) throw new Error('加密连接已关闭');
      const ok = this.socket.write(frame);
      if (!ok) {
        await new Promise((resolve, reject) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            reject(new Error('加密连接已关闭'));
          };
          const cleanup = () => {
            this.socket.removeListener('drain', onDrain);
            this.socket.removeListener('close', onClose);
          };
          this.socket.once('drain', onDrain);
          this.socket.once('close', onClose);
        });
      }
    };

    const run = this.writeQueue.then(write, write);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  pause() {
    if (this.closed) return;
    this.paused = true;
    this.socket.pause();
  }

  resume() {
    if (this.closed) return;
    this.paused = false;
    this.socket.resume();
    this._parse();
  }

  destroy() {
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
}


module.exports = { FrameSocket };
