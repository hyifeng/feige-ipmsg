'use strict';

/**
 * 真实 App：LAN 下建立加密会话 -> 双方先关 LAN、1 秒后开 Hub
 * 验证通过 Hub/P2P 自动恢复加密会话。
 */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { createHubServer } = require('../server/src/hub');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join('/tmp', `feige-switch-e2e-${Date.now()}`);
const HUB_PORT = 29087;
const STUN_PORT = 29080;
const DISCOVERY_PORT = 26560;
const PASSWORD = 'feige-switch-password';

const A = { name: 'Switch Alice', port: 26551, debug: 29322, base: path.join(RUN, 'a') };
const B = { name: 'Switch Bob', port: 26552, debug: 29323, base: path.join(RUN, 'b') };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`等待超时：${label}${last ? `（${last.message}）` : ''}`);
}

class Cdp {
  constructor(port) { this.port = port; this.socket = null; this.id = 0; this.pending = new Map(); }
  async connect() {
    let target = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* wait */ }
      await sleep(250);
    }
    if (!target) throw new Error(`无法连接 DevTools ${this.port}`);
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = message.id && this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    await this.call('Runtime.enable');
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { try { this.socket?.close(); } catch { /* ignore */ } }
}

function startApp(label, config) {
  const electron = require('electron');
  fs.mkdirSync(config.base, { recursive: true });
  const logPath = path.join(config.base, 'app.log');
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(electron, [
    '.', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${config.debug}`,
    `--user-data-dir=${path.join(config.base, 'chromium')}`,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: config.base,
      FEIGE_LAN_ENABLED: '1',
      FEIGE_PORT: String(config.port),
      FEIGE_DISCOVERY_PORT: String(DISCOVERY_PORT),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return { child, log, logPath };
}

async function state(app) { return app.cdp.eval('window.feige.state()'); }

async function setupApp(app, config) {
  app.cdp = new Cdp(config.debug);
  await app.cdp.connect();
  await waitFor(async () => app.cdp.eval('!!document.getElementById("localPassSubmit")'), `${config.name} 锁屏`);
  await app.cdp.eval(`(() => {
    const input = document.getElementById('localPassInput');
    const confirm = document.getElementById('localPassConfirm');
    const remember = document.getElementById('localPassRemember');
    input.value = ${JSON.stringify(PASSWORD)};
    if (confirm) confirm.value = ${JSON.stringify(PASSWORD)};
    if (remember) remember.checked = false;
    document.getElementById('localPassSubmit').click();
    return true;
  })()`);
  await waitFor(async () => app.cdp.eval('document.getElementById("lockScreen")?.classList.contains("is-hidden") === true'), `${config.name} 解锁`);
  await app.cdp.eval(`window.feige.updateSettings(${JSON.stringify({
    nickname: config.name,
    lanEnabled: true,
    hubEnabled: false,
    autoAccept: true,
    sound: false,
    downloadDir: path.join(config.base, 'downloads'),
  })})`);
  await waitFor(async () => {
    const snapshot = await state(app);
    return snapshot.self.ready && snapshot.self.online && snapshot.settings.lanEnabled === true;
  }, `${config.name} LAN 启动`);
  await app.cdp.eval(`(() => {
    window.__e2eSas = [];
    window.feige.onEvent((event) => {
      if (event && event.type === 'secure-sas') window.__e2eSas.push(event.payload);
    });
    return true;
  })()`);
}

async function peerByUser(app, user) {
  const snapshot = await state(app);
  return snapshot.peers.find((peer) => peer.user === user && peer.online) || null;
}

async function waitSecure(app, peerKey) {
  return waitFor(async () => {
    const snapshot = await state(app);
    return snapshot.secureSessions.some((session) => session.peerKey === peerKey);
  }, `secure session ${peerKey}`);
}

async function main() {
  if (process.platform === 'linux' && !process.env.DISPLAY) throw new Error('需要图形环境');
  await fsp.rm(RUN, { recursive: true, force: true });
  const hub = createHubServer({
    port: HUB_PORT, host: '127.0.0.1', stunPort: STUN_PORT, stunHost: '127.0.0.1',
    logger: { log() {}, error: console.error },
  });
  await hub.start();
  let a = null;
  let b = null;
  try {
    a = startApp('A', A);
    await setupApp(a, A);
    b = startApp('B', B);
    await setupApp(b, B);
    await waitFor(async () => (await peerByUser(a, B.name)) && (await peerByUser(b, A.name)), 'LAN 发现');
    const aPeerB = await peerByUser(a, B.name);
    const bPeerA = await peerByUser(b, A.name);
    console.log('✓ 真实 App LAN 发现');

    await a.cdp.eval(`window.feige.secureStart(${JSON.stringify(aPeerB.key)})`);
    await waitFor(async () => {
      const sasA = await a.cdp.eval('window.__e2eSas?.[0] || null');
      const sasB = await b.cdp.eval('window.__e2eSas?.[0] || null');
      return sasA && sasB;
    }, '双向 SAS');
    const sasA = await a.cdp.eval('window.__e2eSas[0]');
    const sasB = await b.cdp.eval('window.__e2eSas[0]');
    assert.equal(sasA.code, sasB.code);
    await a.cdp.eval(`window.feige.secureConfirm(${JSON.stringify(sasA.sessionId)})`);
    await b.cdp.eval(`window.feige.secureConfirm(${JSON.stringify(sasB.sessionId)})`);
    await waitFor(async () => {
      const sa = await state(a);
      const sb = await state(b);
      return sa.secureSessions.length === 1 && sb.secureSessions.length === 1;
    }, 'LAN 加密会话');
    console.log('✓ 真实 App LAN 加密会话');

    // A: 先关闭 LAN，1 秒后打开 Hub
    await a.cdp.eval("window.feige.updateSettings({ lanEnabled: false })");
    await waitFor(async () => (await state(a)).settings.lanEnabled === false, 'A 关闭 LAN');
    await sleep(1000);
    await a.cdp.eval(`window.feige.updateSettings(${JSON.stringify({
      lanEnabled: false,
      hubEnabled: true,
      hubUrl: `ws://127.0.0.1:${HUB_PORT}`,
      hubStunUrl: `stun:127.0.0.1:${STUN_PORT}`,
    })})`);
    await waitFor(async () => {
      const snapshot = await state(a);
      return snapshot.settings.hubEnabled === true && snapshot.settings.lanEnabled === false && snapshot.self.ready;
    }, 'A 打开 Hub');
    console.log('✓ A 切换为 Hub-only');

    // B: 先关闭 LAN，1 秒后打开 Hub
    await b.cdp.eval("window.feige.updateSettings({ lanEnabled: false })");
    await waitFor(async () => (await state(b)).settings.lanEnabled === false, 'B 关闭 LAN');
    await sleep(1000);
    await b.cdp.eval(`window.feige.updateSettings(${JSON.stringify({
      lanEnabled: false,
      hubEnabled: true,
      hubUrl: `ws://127.0.0.1:${HUB_PORT}`,
      hubStunUrl: `stun:127.0.0.1:${STUN_PORT}`,
    })})`);
    await waitFor(async () => {
      const snapshot = await state(b);
      return snapshot.settings.hubEnabled === true && snapshot.settings.lanEnabled === false && snapshot.self.ready;
    }, 'B 打开 Hub');
    console.log('✓ B 切换为 Hub-only');

    await waitFor(async () => (await peerByUser(a, B.name)) && (await peerByUser(b, A.name)), 'Hub 重新发现', 40000);
    const hubPeerA = await peerByUser(a, B.name);
    const hubPeerB = await peerByUser(b, A.name);
    await waitSecure(a, hubPeerA.key);
    await waitSecure(b, hubPeerB.key);
    const finalA = await state(a);
    const session = finalA.secureSessions.find((item) => item.peerKey === hubPeerA.key);
    assert.equal(session.mode, 'resume');
    console.log('✓ LAN -> Hub 自动恢复加密会话 (resume)');
    console.log('\n真实 App LAN -> Hub 切换测试通过 ✅');
  } catch (error) {
    for (const [label, app] of [['A', a], ['B', b]]) {
      if (!app) continue;
      try {
        const snapshot = await state(app);
        console.error(`${label} state: ${JSON.stringify({
          settings: { lanEnabled: snapshot.settings.lanEnabled, hubEnabled: snapshot.settings.hubEnabled },
          self: { ready: snapshot.self.ready, online: snapshot.self.online },
          peers: snapshot.peers.map((peer) => ({ user: peer.user, online: peer.online, sources: peer.sources })),
          secureSessions: snapshot.secureSessions,
        })}`);
      } catch { /* ignore */ }
      try {
        const log = await fsp.readFile(app.logPath, 'utf8');
        console.error(`--- ${label} log ---\n${log.split('\n').slice(-60).join('\n')}`);
      } catch { /* ignore */ }
    }
    throw error;
  } finally {
    const killApp = (app, signal) => {
      if (!app) return;
      try {
        if (process.platform === 'win32') app.child.kill(signal);
        else process.kill(-app.child.pid, signal);
      } catch { /* ignore */ }
    };
    for (const app of [a, b]) { try { app?.cdp?.close(); } catch { /* ignore */ } killApp(app, 'SIGTERM'); }
    await sleep(1200);
    for (const app of [a, b]) { killApp(app, 'SIGKILL'); app?.log?.end(); }
    await hub.stop().catch(() => {});
    await fsp.rm(RUN, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\n真实 App LAN -> Hub 切换测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
