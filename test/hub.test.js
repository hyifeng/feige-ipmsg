'use strict';

/**
 * Hub 集成测试：服务器发现 + WebRTC 直连 + 文本 + 文件 + 加密会话。
 * 不使用局域网广播（两端 discoveryPort 不同），确保走服务器来源。
 */

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { FeigeNode } = require('../src/main/network');
const { createHubServer } = require('../server/src/hub');
const { createIdentity } = require('../src/shared/protocol');

const HUB_PORT = 25787;
const STUN_PORT = 25780;
const PORT_A = 25710;
const PORT_B = 25711;
const DISCOVERY_A = 25720;
const DISCOVERY_B = 25721;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

function waitEvent(emitter, event, predicate = () => true, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`等待事件超时：${event}`));
    }, timeout);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.removeListener(event, handler);
      resolve(payload);
    };
    emitter.on(event, handler);
  });
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-hub-test-'));
  const sourceFile = path.join(root, 'hub-file.txt');
  const content = 'hub-file-content\n'.repeat(500);
  await fsp.writeFile(sourceFile, content);

  const hub = createHubServer({
    port: HUB_PORT,
    host: '127.0.0.1',
    stunPort: STUN_PORT,
    stunHost: '127.0.0.1',
    logger: { log() {}, error: console.error },
  });
  await hub.start();

  const a = new FeigeNode({
    port: PORT_A,
    discoveryPort: DISCOVERY_A,
    lanEnabled: true,
    user: 'Hub Alice',
    host: 'host-a',
    identityKey: createIdentity(),
    hubUrl: `ws://127.0.0.1:${HUB_PORT}`,
    stunUrl: `stun:127.0.0.1:${STUN_PORT}`,
    downloadDir: path.join(root, 'a'),
  });
  const b = new FeigeNode({
    port: PORT_B,
    discoveryPort: DISCOVERY_B,
    lanEnabled: true,
    user: 'Hub Bob',
    host: 'host-b',
    identityKey: createIdentity(),
    hubUrl: `ws://127.0.0.1:${HUB_PORT}`,
    stunUrl: `stun:127.0.0.1:${STUN_PORT}`,
    downloadDir: path.join(root, 'b'),
    autoAccept: true,
  });

  const errors = [];
  a.on('error', (error) => errors.push(`A: ${error.message}`));
  b.on('error', (error) => errors.push(`B: ${error.message}`));
  const messages = [];
  b.on('message', (message) => messages.push(message));

  try {
    await a.start();
    await b.start();

    await waitFor(
      () => [...a.peers.values()].some((peer) => peer.user === 'Hub Bob' && peer.sources?.hub?.online),
      'A 通过 Hub 发现 B',
    );
    await waitFor(
      () => [...b.peers.values()].some((peer) => peer.user === 'Hub Alice' && peer.online),
      'B 通过 ANSENTRY/P2P 发现 A',
    );
    const alice = [...b.peers.values()].find((peer) => peer.user === 'Hub Alice');
    const bob = [...a.peers.values()].find((peer) => peer.user === 'Hub Bob');
    assert.ok(alice.sources.direct?.online || alice.sources.hub?.online, 'B 应通过 P2P 或 Hub 记录 A');
    assert.ok(bob.sources.hub.online, 'A 应记录 Hub 来源');
    assert.ok(!bob.sources.lan, '不同 discoveryPort 不应产生 LAN 来源');
    assert.ok(!alice.sources.lan, 'Hub/P2P 的 ANSENTRY 不应被误判为 LAN 来源');
    console.log('✓ Hub 上线广播 / 跨网发现');

    a.sendText(bob.key, 'hello-over-hub');
    await waitFor(() => messages.some((message) => message.text === 'hello-over-hub'), 'Hub 文本消息');
    console.log('✓ Hub 信令 + WebRTC 文本');

    const done = waitEvent(b, 'transfer-done', (info) => info.direction === 'in');
    await a.sendPaths(bob.key, [sourceFile]);
    await done;
    await waitFor(async () => {
      try {
        await fsp.access(path.join(root, 'b', 'hub-file.txt'));
        return true;
      } catch {
        return false;
      }
    }, 'Hub 文件落盘');
    assert.equal(await fsp.readFile(path.join(root, 'b', 'hub-file.txt'), 'utf8'), content);
    console.log('✓ Hub 信令 + WebRTC 文件');

    const sasA = waitEvent(a, 'secure-sas');
    const sasB = waitEvent(b, 'secure-sas');
    a.secure.start(bob.key);
    const [infoA, infoB] = await Promise.all([sasA, sasB]);
    assert.equal(infoA.code, infoB.code);
    a.secure.confirm(infoA.sessionId);
    b.secure.confirm(infoB.sessionId);
    await waitFor(() => a.secure.isActive(bob.key) && b.secure.isActive(alice.key), '加密会话激活');
    a.sendText(bob.key, 'secure-over-hub');
    await waitFor(() => messages.some((message) => message.text === 'secure-over-hub'), 'Hub 加密文本');
    console.log('✓ Hub 信令 + WebRTC 加密会话');

    assert.deepEqual(errors, []);
    console.log('\nHub 集成测试全部通过 ✅');
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
    await hub.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\nHub 集成测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
