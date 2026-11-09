'use strict';

/**
 * 单条 LAN 链路故障隔离测试：
 * A-B 走 LAN，A-C 走 Hub/Direct。切断 A 的 LAN 后，只允许 A-B 重建，
 * A-C 的加密会话必须保持原样，不能被广播退出或全局重置影响。
 */

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { FeigeNode } = require('../src/main/network');
const { createHubServer } = require('../server/src/hub');
const { createIdentity } = require('../src/shared/protocol');

const HUB_PORT = 27287;
const STUN_PORT = 27280;
const PORT_A = 27251;
const PORT_B = 27252;
const PORT_C = 27253;
const DISCOVERY_AB = 27250;
const DISCOVERY_C = 27254;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

function waitEvent(emitter, event, predicate = () => true, timeout = 20000) {
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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-isolation-test-'));
  const hub = createHubServer({
    port: HUB_PORT,
    host: '127.0.0.1',
    stunPort: STUN_PORT,
    stunHost: '127.0.0.1',
    logger: { log() {}, error: console.error },
  });
  await hub.start();

  const makeNode = (identity, port, discoveryPort, lanEnabled, user) => new FeigeNode({
    port,
    discoveryPort,
    lanEnabled,
    user,
    host: user,
    identityKey: identity,
    hubUrl: `ws://127.0.0.1:${HUB_PORT}`,
    stunUrl: `stun:127.0.0.1:${STUN_PORT}`,
    downloadDir: path.join(root, user),
  });
  const a = makeNode(createIdentity(), PORT_A, DISCOVERY_AB, true, 'isolation-a');
  const b = makeNode(createIdentity(), PORT_B, DISCOVERY_AB, true, 'isolation-b');
  const c = makeNode(createIdentity(), PORT_C, DISCOVERY_C, false, 'isolation-c');
  const aKey = `id:${a.identity}`;

  try {
    await a.start();
    await b.start();
    await c.start();

    await waitFor(
      () => [...a.peers.values()].some((peer) => peer.user === 'isolation-b' && peer.online)
        && [...a.peers.values()].some((peer) => peer.user === 'isolation-c' && peer.online),
      'A 同时发现 B/C',
    );
    const bob = [...a.peers.values()].find((peer) => peer.user === 'isolation-b');
    const carol = [...a.peers.values()].find((peer) => peer.user === 'isolation-c');
    assert.ok(bob && carol);

    // 强制 A-B 的认证会话走 LAN。
    a.transport.markPathUnhealthy(bob.key, 'direct', 60000);
    let sasA = waitEvent(a, 'secure-sas', (info) => info.peerKey === bob.key);
    let sasB = waitEvent(b, 'secure-sas');
    a.secure.start(bob.key);
    const [infoA, infoB] = await Promise.all([sasA, sasB]);
    a.secure.confirm(infoA.sessionId);
    b.secure.confirm(infoB.sessionId);
    await waitFor(() => a.secure.isActive(bob.key) && b.secure.isActive(aKey), 'A-B LAN 加密');
    assert.equal(a.secure.getSession(bob.key).transport, 'lan');
    a.transport.clearPathFailure(bob.key, 'direct');

    // A-C 走 Hub/Direct。
    const cOffline = [];
    c.on('peer-offline', (peer) => cOffline.push(peer.key));

    // 只切断 A 的 LAN；A-C 的 Direct 必须保持。
    await a.transport.lan.stop();
    await waitFor(
      () => a.secure.getActiveSessions().find((s) => s.peerKey === bob.key)?.transport === 'direct',
      'A-B 切 Direct',
      20000,
    );

    await sleep(2000);
    assert.deepEqual(cOffline, [], 'A-C 不能被全局 EXIT 标记离线');
    assert.equal(c.peers.get(aKey)?.online, true, 'C 侧仍应看到 A 在线');
    assert.equal(a.registry.list().find((peer) => peer.key === carol.key)?.online, true);
    console.log('✓ A-B LAN 故障只重建 A-B，A-C 连接完全不受影响');
    console.log('\n单链路故障隔离测试通过 ✅');
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
    await c.stop().catch(() => {});
    await hub.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\n单链路故障隔离测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
