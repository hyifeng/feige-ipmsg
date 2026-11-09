'use strict';

/**
 * 真实 Electron App 端到端测试。
 *
 * - 启动真实 Hub（WSS + STUN）
 * - 启动两个隔离 userData 的真实 App 进程
 * - 关闭 LAN，只保留 Hub 来源
 * - 验证：发现 -> 文本 -> 图片 -> 文件
 *
 * 运行：node test/app-e2e.js
 * 需要图形环境（Linux 下可用 Xvfb 或 DISPLAY）。
 */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { createHubServer } = require('../server/src/hub');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join('/tmp', `feige-app-e2e-${Date.now()}`);
const HUB_PORT = 28987;
const STUN_PORT = 28980;
const PASSWORD = 'feige-e2e-password';

const A = {
  name: 'Real Alice',
  debugPort: 29222,
  base: path.join(RUN, 'a'),
  downloads: path.join(RUN, 'a-downloads'),
};
const B = {
  name: 'Real Bob',
  debugPort: 29223,
  base: path.join(RUN, 'b'),
  downloads: path.join(RUN, 'b-downloads'),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, label, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

class Cdp {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    const deadline = Date.now() + 30000;
    let target = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/list`);
        const list = await response.json();
        target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        /* App 还没起来 */
      }
      await sleep(250);
    }
    if (!target) throw new Error(`无法连接 DevTools: ${this.port}`);
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
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
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Runtime.evaluate 异常';
      throw new Error(text);
    }
    return result.result.value;
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
  }
}

function startApp(label, config) {
  const electron = require('electron');
  const logPath = path.join(config.base, 'app.log');
  fs.mkdirSync(config.base, { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: config.base,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    FEIGE_LAN_ENABLED: '0',
  };
  const child = spawn(electron, [
    '.',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${config.debugPort}`,
    `--user-data-dir=${path.join(config.base, 'chromium')}`,
  ], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return { child, logPath, log };
}

async function setupApp(app, config, peerName) {
  app.cdp = new Cdp(config.debugPort);
  await app.cdp.connect();
  const status = await app.cdp.eval('window.feige.localPassStatus()');
  if (!status.unlocked) {
    // 通过真实锁屏表单完成设置/解锁，确保 renderer 的 onUnlocked 流程也执行。
    await waitFor(async () => app.cdp.eval(
      '!!document.getElementById("localPassSubmit")',
    ), `${peerName} 锁屏表单`);
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
    await waitFor(async () => app.cdp.eval(
      'document.getElementById("lockScreen")?.classList.contains("is-hidden") === true',
    ), `${peerName} 解锁`);
  }
  const settings = await app.cdp.eval(`window.feige.updateSettings(${JSON.stringify({
    nickname: peerName,
    lanEnabled: false,
    hubEnabled: true,
    hubUrl: `ws://127.0.0.1:${HUB_PORT}`,
    hubStunUrl: `stun:127.0.0.1:${STUN_PORT}`,
    autoAccept: true,
    downloadDir: config.downloads,
    sound: false,
  })})`);
  assert.equal(settings.lanEnabled, false, `${peerName}: LAN 应该关闭`);
  await waitFor(async () => {
    const state = await app.cdp.eval('window.feige.state()');
    return state.self.ready && state.self.online && state.settings.lanEnabled === false;
  }, `${peerName} 网络启动`);
  return app.cdp;
}

async function state(app) {
  return app.cdp.eval('window.feige.state()');
}

async function history(app, peerKey) {
  return app.cdp.eval(`window.feige.loadHistory(${JSON.stringify(peerKey)})`);
}

async function main() {
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    throw new Error('需要图形环境：请设置 DISPLAY 或使用 xvfb-run 运行');
  }

  await fsp.rm(RUN, { recursive: true, force: true });
  await fsp.mkdir(RUN, { recursive: true });
  await fsp.mkdir(A.base, { recursive: true });
  await fsp.mkdir(B.base, { recursive: true });

  const text = `real-app-text-${crypto.randomBytes(6).toString('hex')}`;
  const fileContent = `real-app-file-${crypto.randomBytes(64).toString('hex')}\n`;
  const filePath = path.join(RUN, 'real-file.txt');
  const imagePath = path.join(RUN, 'real-image.png');
  await fsp.writeFile(filePath, fileContent);
  await fsp.writeFile(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nK0AAAAASUVORK5CYII=',
    'base64',
  ));

  const hub = createHubServer({
    port: HUB_PORT,
    host: '127.0.0.1',
    stunPort: STUN_PORT,
    stunHost: '127.0.0.1',
    logger: { log() {}, error: console.error },
  });
  await hub.start();

  let a = null;
  let b = null;
  try {
    a = startApp('A', A);
    await setupApp(a, A, A.name);
    assert.equal((await state(a)).self.lanEnabled, false);
    assert.equal(await a.cdp.eval('!!document.getElementById("onlineBtn")'), false, '隐身按钮应已移除');
    console.log('✓ App A 以 Server-only 模式启动 / 隐身入口已移除');

    b = startApp('B', B);
    await setupApp(b, B, B.name);
    assert.equal((await state(b)).self.lanEnabled, false);
    console.log('✓ App B 以 Server-only 模式启动');

    await waitFor(async () => {
      const snapshot = await state(a);
      return snapshot.peers.some((peer) => peer.user === B.name && peer.online);
    }, 'A 发现 B');
    await waitFor(async () => {
      const snapshot = await state(b);
      return snapshot.peers.some((peer) => peer.user === A.name && peer.online);
    }, 'B 发现 A');
    console.log('✓ 真实 App 通过 Hub 发现');

    const aStateForB = await state(b);
    const bStateForA = await state(a);
    const aPeerForB = aStateForB.peers.find((peer) => peer.user === A.name);
    const bPeerForA = bStateForA.peers.find((peer) => peer.user === B.name);
    assert.ok(aPeerForB && bPeerForA, '应能拿到对端 peerKey');

    const aSources = bPeerForA.sources || [];
    assert.ok(aSources.includes('hub'), 'A 侧应记录 Hub 来源');
    assert.ok(!aSources.includes('lan'), '关闭 LAN 后不应出现 LAN 来源');
    await waitFor(async () => a.cdp.eval(
      `document.querySelector('#peerList')?.innerText.includes(${JSON.stringify(B.name)}) === true`,
    ), 'A 联系人 UI 显示 B');
    console.log('✓ 联系人 UI 渲染 / 来源只有 Hub');

    // 设置页只显示服务器状态 + 启动/编辑/关闭，具体配置在二级 Popup。
    await a.cdp.eval("document.getElementById('settingsBtn').click()");
    await waitFor(async () => a.cdp.eval('!!document.getElementById("saveSettings")'), '设置弹窗');
    const hubUi = await a.cdp.eval(`({
      inlineUrl: !!document.getElementById('setHubUrl') || !!document.getElementById('setHubStunUrl'),
      switchChecked: document.getElementById('setHubEnabled')?.checked === true,
      hasEdit: !!document.querySelector('[data-hub-action="edit"]'),
      editText: document.querySelector('[data-hub-action="edit"]')?.textContent || '',
      hasStartStop: !!document.querySelector('[data-hub-action="start"], [data-hub-action="stop"]'),
      separateRow: !!document.querySelector('.hub-row'),
      inlineHidden: document.getElementById('hubInline')?.hidden === true,
      detail: document.getElementById('hubDetail')?.textContent || '',
      hasTheme: !!document.getElementById('themeSeg'),
    })`);
    assert.equal(hubUi.inlineUrl, false, '设置页不应直接显示服务器地址输入框');
    assert.equal(hubUi.hasTheme, false, '设置页不应显示外观主题');
    assert.equal(hubUi.switchChecked, true, '服务器开关应为开启状态');
    assert.equal(hubUi.hasEdit, true, '服务器配置行应有更改按钮');
    assert.equal(hubUi.editText, '更改');
    assert.equal(hubUi.hasStartStop, false, '服务器开关不应再使用启动/关闭按钮');
    assert.equal(hubUi.separateRow, false, '编辑按钮不应独占一行');
    assert.equal(hubUi.inlineHidden, false, '启用后应显示配置小字');
    assert.ok(hubUi.detail.includes(`ws://127.0.0.1:${HUB_PORT}`), '应显示服务器配置内容');

    await a.cdp.eval("document.querySelector('[data-hub-action=\"edit\"]').click()");
    await waitFor(async () => a.cdp.eval('!!document.querySelector("[data-hub-backdrop] #hubModalUrl")'), '服务器编辑 Popup');
    const modalUrl = await a.cdp.eval("document.getElementById('hubModalUrl').value");
    assert.equal(modalUrl, `ws://127.0.0.1:${HUB_PORT}`);
    await a.cdp.eval("document.querySelector('[data-hub-cancel]').click()");
    await waitFor(async () => a.cdp.eval('!document.querySelector("[data-hub-backdrop]")'), '关闭服务器编辑 Popup');
    await a.cdp.eval("document.querySelector('.modal-head [data-close-modal]').click()");
    await waitFor(async () => a.cdp.eval('!document.getElementById("saveSettings")'), '关闭设置弹窗');
    console.log('✓ 设置页服务器开关 + 配置内容 + 二级 Popup');

    await a.cdp.eval("document.getElementById('peerList').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 120 }))");
    await waitFor(async () => a.cdp.eval('!!document.querySelector("[data-peer-refresh]")'), '联系人右键刷新菜单');
    assert.equal(await a.cdp.eval("document.querySelector('[data-peer-refresh]').textContent.trim()"), '刷新列表');
    await a.cdp.eval("document.querySelector('[data-peer-refresh]').click()");
    await waitFor(async () => a.cdp.eval('!document.querySelector("[data-peer-refresh]")'), '刷新菜单关闭');
    console.log('✓ 联系人右键刷新菜单');

    await a.cdp.eval(`window.feige.sendText(${JSON.stringify(bPeerForA.key)}, ${JSON.stringify(text)})`);
    await waitFor(async () => {
      const result = await history(b, aPeerForB.key);
      return result.messages.some((message) => message.text === text);
    }, 'B 收到文本');
    console.log('✓ 真实 App 文本');

    await a.cdp.eval(`window.feige.sendImage(${JSON.stringify({
      peerKey: bPeerForA.key,
      path: imagePath,
      name: 'real-image.png',
      thumb: '',
      caption: 'real-image',
    })})`);
    await waitFor(async () => {
      try {
        const stat = await fsp.stat(path.join(B.downloads, 'real-image.png'));
        return stat.isFile() && stat.size > 0;
      } catch {
        return false;
      }
    }, 'B 收到图片');
    console.log('✓ 真实 App 图片');

    await a.cdp.eval(`window.feige.sendPaths(${JSON.stringify(bPeerForA.key)}, ${JSON.stringify([filePath])}, 'real-file')`);
    await waitFor(async () => {
      try {
        return await fsp.readFile(path.join(B.downloads, 'real-file.txt'), 'utf8') === fileContent;
      } catch {
        return false;
      }
    }, 'B 收到文件');
    console.log('✓ 真实 App 文件');

    // 通过设置页按钮关闭/启动服务器，并确认重连后仍能发消息。
    await a.cdp.eval("document.getElementById('settingsBtn').click()");
    await waitFor(async () => a.cdp.eval('!!document.getElementById("saveSettings")'), '重新打开设置');
    await a.cdp.eval("document.getElementById('setHubEnabled').checked = false; document.getElementById('setHubEnabled').dispatchEvent(new Event('change', { bubbles: true }))");
    await waitFor(async () => (await state(a)).settings.hubEnabled === false, '关闭 Hub');
    await waitFor(async () => a.cdp.eval("document.getElementById('setHubEnabled').checked === false"), '设置页开关关闭');
    await waitFor(async () => a.cdp.eval("document.getElementById('hubInline')?.hidden === true"), '关闭后隐藏配置小字');
    await a.cdp.eval("document.getElementById('setHubEnabled').checked = true; document.getElementById('setHubEnabled').dispatchEvent(new Event('change', { bubbles: true }))");
    await waitFor(async () => (await state(a)).settings.hubEnabled === true, '启动 Hub');
    await waitFor(async () => a.cdp.eval("document.getElementById('setHubEnabled').checked === true"), '设置页开关开启');
    await waitFor(async () => a.cdp.eval(
      `document.getElementById('hubInline')?.hidden === false && document.getElementById('hubDetail')?.textContent.includes(${JSON.stringify(`ws://127.0.0.1:${HUB_PORT}`)})`,
    ), '重新显示配置小字');
    await waitFor(async () => {
      const snapshot = await state(a);
      return snapshot.peers.some((peer) => peer.user === B.name && peer.online);
    }, '重启 Hub 后重新发现 B');
    const restartedB = (await state(a)).peers.find((peer) => peer.user === B.name);
    const reconnectText = `${text}-reconnect`;
    await a.cdp.eval(`window.feige.sendText(${JSON.stringify(restartedB.key)}, ${JSON.stringify(reconnectText)})`);
    await waitFor(async () => {
      const result = await history(b, aPeerForB.key);
      return result.messages.some((message) => message.text === reconnectText);
    }, 'Hub 重启后文本');
    await a.cdp.eval("document.querySelector('.modal-head [data-close-modal]').click()");
    console.log('✓ 设置页关闭/启动 Hub + 重连通讯');

    const finalA = await state(a);
    assert.equal(finalA.settings.lanEnabled, false);
    assert.ok(hub.routes.size >= 2, 'Hub 应有两条 bind 路由');
    console.log('✓ Server-only 配置 / Hub 路由');
    console.log('\n真实 App 端到端测试全部通过 ✅');
  } catch (error) {
    for (const [label, app] of [['A', a], ['B', b]]) {
      if (!app?.cdp) continue;
      try {
        const snapshot = await state(app);
        console.error(`App ${label} state: ${JSON.stringify({
          settings: { hubEnabled: snapshot.settings.hubEnabled, lanEnabled: snapshot.settings.lanEnabled },
          self: { ready: snapshot.self.ready, online: snapshot.self.online },
          peers: snapshot.peers.map((peer) => ({ user: peer.user, online: peer.online, sources: peer.sources })),
        })}`);
      } catch (stateError) {
        console.error(`App ${label} state unavailable: ${stateError.message}`);
      }
      try {
        const log = await fsp.readFile(app.logPath, 'utf8');
        console.error(`\n--- App ${label} log (tail) ---\n${log.split('\n').slice(-40).join('\n')}`);
      } catch {
        /* ignore */
      }
    }
    throw error;
  } finally {
    const killApp = (app, signal) => {
      if (!app) return;
      try {
        if (process.platform === 'win32') app.child.kill(signal);
        else process.kill(-app.child.pid, signal);
      } catch {
        /* 进程已经退出 */
      }
    };
    for (const app of [a, b]) {
      try {
        app?.cdp?.close();
      } catch {
        /* ignore */
      }
      killApp(app, 'SIGTERM');
    }
    await sleep(1200);
    for (const app of [a, b]) {
      killApp(app, 'SIGKILL');
      app?.log?.end();
    }
    await hub.stop().catch(() => {});
    if (process.env.FEIGE_E2E_KEEP !== '1') {
      await fsp.rm(RUN, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`保留测试目录：${RUN}`);
    }
  }
}

main().catch((error) => {
  console.error('\n真实 App 端到端测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
