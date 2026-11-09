'use strict';

/**
 * LAN -> Hub 切换后，已认证加密会话应通过 Hub/P2P 自动恢复。
 */

const assert = require('node:assert');

const { FeigeNode } = require('../src/main/network');
const { createHubServer } = require('../server/src/hub');
const { createIdentity } = require('../src/shared/protocol');
const { createMemoryStore } = require('../src/main/secure');

const HUB_PORT = 28993;
const STUN_PORT = 28994;
const PORT_A = 26451;
const PORT_B = 26452;
const DISCOVERY = 26450;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

function makeNode(identity, port, user, store, hubUrl = '') {
  return new FeigeNode({
    port,
    discoveryPort: DISCOVERY,
    user,
    host: user,
    identityKey: identity,
    secureStore: store,
    downloadDir: `/tmp/feige-switch-${user}`,
    lanEnabled: !hubUrl,
    hubUrl,
    stunUrl: hubUrl ? `stun:127.0.0.1:${STUN_PORT}` : '',
  });
}

async function main() {
  const hub = createHubServer({
    port: HUB_PORT,
    host: '127.0.0.1',
    stunPort: STUN_PORT,
    stunHost: '127.0.0.1',
    logger: { log() {}, error: console.error },
  });
  await hub.start();

  const aId = createIdentity();
  const bId = createIdentity();
  const aKey = `id:${aId.id}`;
  const bKey = `id:${bId.id}`;
  const storeA = createMemoryStore();
  const storeB = createMemoryStore();
  let a = makeNode(aId, PORT_A, 'Switch A', storeA);
  let b = makeNode(bId, PORT_B, 'Switch B', storeB);

  try {
    await a.start();
    await b.start();
    await waitFor(
      () => [...a.peers.values()].some((peer) => peer.user === 'Switch B' && peer.online),
      'LAN 发现',
    );
    const bob = [...a.peers.values()].find((peer) => peer.user === 'Switch B');
    const alice = [...b.peers.values()].find((peer) => peer.user === 'Switch A');

    let sasA = null;
    let sasB = null;
    a.on('secure-sas', (info) => { sasA = info; });
    b.on('secure-sas', (info) => { sasB = info; });
    a.secure.start(bob.key);
    await waitFor(() => sasA && sasB, 'LAN SAS');
    a.secure.confirm(sasA.sessionId);
    b.secure.confirm(sasB.sessionId);
    await waitFor(() => a.secure.isActive(bob.key) && b.secure.isActive(alice.key), 'LAN 加密会话');
    console.log('✓ LAN 下建立已认证加密会话');

    // 模拟设置保存：双方关闭 LAN，启用 Hub，节点重启。
    await a.stop();
    await b.stop();
    a = makeNode(aId, PORT_A, 'Switch A', storeA, `ws://127.0.0.1:${HUB_PORT}`);
    b = makeNode(bId, PORT_B, 'Switch B', storeB, `ws://127.0.0.1:${HUB_PORT}`);
    await a.start();
    await b.start();

    await waitFor(
      () => [...a.peers.values()].some((peer) => peer.user === 'Switch B' && peer.online)
        && [...b.peers.values()].some((peer) => peer.user === 'Switch A' && peer.online),
      'Hub 重新发现',
    );
    await waitFor(() => a.secure.isActive(bKey) && b.secure.isActive(aKey), 'Hub 自动恢复加密会话', 30000);
    const sessions = a.secure.getActiveSessions();
    assert.ok(sessions.some((session) => session.peerKey === bKey && session.mode === 'resume'));
    console.log('✓ LAN -> Hub 后自动恢复加密会话 (resume)');

    // B 单独重启，A 保持运行：A 不能继续使用旧 P2P/旧会话。
    await b.stop();
    b = makeNode(bId, PORT_B, 'Switch B', storeB, `ws://127.0.0.1:${HUB_PORT}`);
    await b.start();
    await waitFor(
      () => [...a.peers.values()].some((peer) => peer.user === 'Switch B' && peer.online)
        && [...b.peers.values()].some((peer) => peer.user === 'Switch A' && peer.online),
      'B 重启后重新发现',
    );
    await waitFor(() => a.secure.isActive(bKey) && b.secure.isActive(aKey), 'B 重启后恢复加密会话', 30000);
    console.log('✓ 仅重启 B、A 保持运行时自动恢复加密会话');
    console.log('\nLAN -> Hub 切换测试通过 ✅');
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
    await hub.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error('\nLAN -> Hub 切换测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
