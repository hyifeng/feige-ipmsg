'use strict';

const https = require('node:https');
const { WebSocketServer } = require('ws');

const { StunServer } = require('./stun');

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_IDENTITY_CHARS = 128;
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function shortIdentity(identity) {
  const value = String(identity || '');
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function remoteOf(ws) {
  try {
    return ws && ws._socket ? ws._socket.remoteAddress || '-' : '-';
  } catch {
    return '-';
  }
}

/**
 * 虚拟 LAN Hub。
 *
 * 只有三个传输层动作：
 * - bind：注册 identity，供信令单播路由
 * - broadcast：把不透明帧扩散给其他客户端
 * - signal：把 WebRTC 信令单播给目标 identity
 *
 * 不解析飞鸽协议，不维护在线列表，不在断开时广播 offline。
 */
function createHubServer(options = {}) {
  const port = Number(options.port) || 8787;
  const host = options.host || '0.0.0.0';
  const stunPort = Number(options.stunPort) || 3478;
  const stunHost = options.stunHost || '0.0.0.0';
  const rawLogger = options.logger || console;
  const signalDelayMs = Math.max(0, Number(options.signalDelayMs) || 0);
  const levelName = String(options.logLevel || process.env.HUB_LOG_LEVEL || 'info').toLowerCase();
  const level = Object.prototype.hasOwnProperty.call(LOG_LEVELS, levelName) ? LOG_LEVELS[levelName] : LOG_LEVELS.info;
  const log = {
    error: (...args) => {
      if (level >= LOG_LEVELS.error) (rawLogger.error || rawLogger.log || (() => {})).call(rawLogger, ...args);
    },
    warn: (...args) => {
      if (level >= LOG_LEVELS.warn) (rawLogger.warn || rawLogger.log || (() => {})).call(rawLogger, ...args);
    },
    info: (...args) => {
      if (level >= LOG_LEVELS.info) (rawLogger.info || rawLogger.log || (() => {})).call(rawLogger, ...args);
    },
    debug: (...args) => {
      if (level >= LOG_LEVELS.debug) (rawLogger.debug || rawLogger.log || (() => {})).call(rawLogger, ...args);
    },
  };
  const routes = new Map(); // identity -> { ws, connectedAt }
  let wss = null;
  let httpServer = null;
  let heartbeat = null;
  let stun = null;

  function send(ws, value) {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(value));
      return true;
    } catch (error) {
      log.warn(`[feige-hub] send failed remote=${remoteOf(ws)} error=${error.message || error}`);
      return false;
    }
  }

  function closeWith(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  function reject(ws, code, reason) {
    log.warn(`[feige-hub] protocol reject remote=${remoteOf(ws)} identity=${shortIdentity(ws.identity)} code=${code} reason=${reason}`);
    closeWith(ws, code, reason);
  }

  function handleBind(ws, frame) {
    const identity = String(frame.identity || '');
    if (!identity || identity.length > MAX_IDENTITY_CHARS) {
      reject(ws, 1008, 'invalid-identity');
      return;
    }
    const previous = routes.get(identity);
    if (previous && previous.ws !== ws) {
      log.warn(`[feige-hub] identity replaced identity=${shortIdentity(identity)} oldRemote=${remoteOf(previous.ws)} newRemote=${remoteOf(ws)}`);
      closeWith(previous.ws, 1008, 'replaced');
    }
    if (ws.identity && ws.identity !== identity) routes.delete(ws.identity);
    const isNew = !ws.identity;
    ws.identity = identity;
    routes.set(identity, { ws, connectedAt: Date.now() });
    log.info(`[feige-hub] ${isNew ? 'bind' : 'rebind'} identity=${shortIdentity(identity)} remote=${remoteOf(ws)} routes=${routes.size}`);
  }

  function handleBroadcast(ws, frame) {
    if (!ws.identity) {
      reject(ws, 1008, 'bind-required');
      return;
    }
    const payload = typeof frame.payload === 'string' ? frame.payload : '';
    if (!payload || Buffer.byteLength(payload) > MAX_FRAME_BYTES) {
      log.warn(`[feige-hub] drop broadcast identity=${shortIdentity(ws.identity)} bytes=${Buffer.byteLength(payload)} reason=invalid-payload`);
      return;
    }
    let delivered = 0;
    for (const record of routes.values()) {
      if (record.ws === ws) continue;
      if (send(record.ws, { type: 'broadcast', from: ws.identity, payload })) delivered += 1;
    }
    log.debug(`[feige-hub] broadcast from=${shortIdentity(ws.identity)} bytes=${Buffer.byteLength(payload)} delivered=${delivered}`);
  }

  function handleSignal(ws, frame) {
    if (!ws.identity) {
      reject(ws, 1008, 'bind-required');
      return;
    }
    const to = String(frame.to || '');
    const payload = typeof frame.payload === 'string' ? frame.payload : '';
    if (!to || !payload || Buffer.byteLength(payload) > MAX_FRAME_BYTES) {
      log.warn(`[feige-hub] drop signal from=${shortIdentity(ws.identity)} to=${shortIdentity(to)} bytes=${Buffer.byteLength(payload)} reason=invalid-payload`);
      return;
    }
    const target = routes.get(to);
    if (!target || target.ws === ws) {
      log.debug(`[feige-hub] signal dropped from=${shortIdentity(ws.identity)} to=${shortIdentity(to)} reason=${target ? 'self' : 'offline'}`);
      return;
    }
    const deliver = () => {
      const delivered = send(target.ws, { type: 'signal', from: ws.identity, payload });
      log.debug(`[feige-hub] signal from=${shortIdentity(ws.identity)} to=${shortIdentity(to)} bytes=${Buffer.byteLength(payload)} delivered=${delivered}`);
    };
    if (signalDelayMs > 0) setTimeout(deliver, signalDelayMs);
    else deliver();
  }

  function onConnection(ws) {
    ws.isAlive = true;
    ws.identity = null;
    ws.connectedAt = Date.now();
    log.info(`[feige-hub] connect remote=${remoteOf(ws)} routes=${routes.size}`);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        reject(ws, 1008, 'invalid-json');
        return;
      }
      if (!isObject(frame)) {
        reject(ws, 1008, 'invalid-frame');
        return;
      }
      if (frame.type === 'bind') {
        handleBind(ws, frame);
        return;
      }
      if (frame.type === 'broadcast') {
        handleBroadcast(ws, frame);
        return;
      }
      if (frame.type === 'signal') {
        handleSignal(ws, frame);
        return;
      }
      reject(ws, 1008, 'unknown-type');
    });

    ws.on('close', (code, reason) => {
      const identity = ws.identity;
      if (!identity) {
        log.info(`[feige-hub] disconnect remote=${remoteOf(ws)} code=${code} reason=${String(reason || '')} routes=${routes.size}`);
        return;
      }
      const current = routes.get(identity);
      if (!current || current.ws !== ws) {
        log.info(`[feige-hub] disconnect stale identity=${shortIdentity(identity)} remote=${remoteOf(ws)} code=${code} routes=${routes.size}`);
        return;
      }
      routes.delete(identity);
      log.info(`[feige-hub] unbind identity=${shortIdentity(identity)} remote=${remoteOf(ws)} code=${code} reason=${String(reason || '')} routes=${routes.size}`);
    });

    ws.on('error', (error) => {
      log.warn(`[feige-hub] socket error remote=${remoteOf(ws)} identity=${shortIdentity(ws.identity)} error=${error.message || error}`);
    });
  }

  async function start() {
    if (wss) return;

    if (options.tls && options.tls.cert && options.tls.key) {
      httpServer = https.createServer({ cert: options.tls.cert, key: options.tls.key });
      await new Promise((resolve, rejectPromise) => {
        httpServer.once('error', rejectPromise);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', rejectPromise);
          resolve();
        });
      });
      wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_BYTES });
    } else {
      wss = new WebSocketServer({ port, host, maxPayload: MAX_FRAME_BYTES });
      await new Promise((resolve, rejectPromise) => {
        wss.once('listening', resolve);
        wss.once('error', rejectPromise);
      });
    }

    wss.on('connection', onConnection);
    wss.on('error', (error) => log.error(`[feige-hub] WSS error ${error.message || error}`));

    heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          log.warn(`[feige-hub] heartbeat timeout remote=${remoteOf(ws)} identity=${shortIdentity(ws.identity)}`);
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 15000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    stun = new StunServer({ port: stunPort, host: stunHost, logger: rawLogger });
    await stun.start();
    log.info(`[feige-hub] ready wss=${options.tls ? 'wss' : 'ws'}://${host}:${port} stun=udp://${stunHost}:${stunPort} logLevel=${levelName}`);
  }

  async function stop() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    for (const ws of wss ? wss.clients : []) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    routes.clear();
    if (wss) {
      const server = wss;
      wss = null;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (httpServer) {
      const server = httpServer;
      httpServer = null;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (stun) {
      await stun.stop();
      stun = null;
    }
    log.info('[feige-hub] stopped');
  }

  return { start, stop, get routes() { return routes; } };
}

module.exports = { createHubServer };
