'use strict';

/**
 * 网络状态变化恢复测试：
 * LAN + Hub 同时在线且加密会话走 LAN 时，物理切断 LAN 后必须立刻
 * 切到 Hub/WebRTC 并自动恢复加密，而不是等 30 秒发现超时。
 */

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { FeigeNode } = require('../src/main/network');
const { createHubServer } = require('../server/src/hub');
const { createIdentity } = require('../src/shared/protocol');

const HUB_PORT = 26987;
const STUN_PORT = 26980;
const PORT_A = 26951;
const PORT_B = 26952;
const DISCOVERY = 26950;

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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-failover-test-'));
  const hub = createHubServer({
    port: HUB_PORT,
    host: '127.0.0.1',
    stunPort: STUN_PORT,
    stunHost: '127.0.0.1',
    logger: { log() {}, error: console.error },
  });
  await hub.start();

  // 固定 A 的 identity 更小，保证 LAN 断开后由 A 主动重新发起 resume。
  let aId = createIdentity();
  let bId = createIdentity();
  if (aId.id > bId.id) [aId, bId] = [bId, aId];
  const aKey = `id:${aId.id}`;
  const bKey = `id:${bId.id}`;

  const makeNode = (identity, port, user) => new FeigeNode({
    port,
    discoveryPort: DISCOVERY,
    lanEnabled: true,
    user,
    host: user,
    identityKey: identity,
    hubUrl: `ws://127.0.0.1:${HUB_PORT}`,
    stunUrl: `stun:127.0.0.1:${STUN_PORT}`,
    downloadDir: path.join(root, user),
  });
  const a = makeNode(aId, PORT_A, 'failover-a');
  const b = makeNode(bId, PORT_B, 'failover-b');
  const errors = [];
  a.on('error', (error) => errors.push(`A: ${error.message}`));
  b.on('error', (error) => errors.push(`B: ${error.message}`));

  try {
    await a.start();
    await b.start();

    await waitFor(
      () => a.peers.get(bKey)?.online && b.peers.get(aKey)?.online,
      'LAN + Hub 双方发现',
    );
    const bob = a.peers.get(bKey);
    const alice = b.peers.get(aKey);
    assert.ok(bob.sources.lan?.online && alice.sources.lan?.online, '应同时有 LAN 来源');

    // Direct 已经提前建立（Hub 心跳/信令），但 LAN 健康时仍必须优先 LAN。
    a.transport.direct.sendControl(bKey, Buffer.from('prewarm-direct'));
    assert.equal(a.transport.direct.hasPeer(bKey), true, 'Direct 连接应已提前存在');
    const sasA = waitEvent(a, 'secure-sas');
    const sasB = waitEvent(b, 'secure-sas');
    a.secure.start(bKey);
    const [infoA, infoB] = await Promise.all([sasA, sasB]);
    assert.equal(infoA.code, infoB.code);
    a.secure.confirm(infoA.sessionId);
    b.secure.confirm(infoB.sessionId);
    await waitFor(() => a.secure.isActive(bKey) && b.secure.isActive(aKey), 'LAN 加密会话');
    assert.equal(
      a.secure.getActiveSessions().find((session) => session.peerKey === bKey)?.transport,
      'lan',
      '加密会话应建立在 LAN 上',
    );
    console.log('✓ LAN + Hub 同时在线，加密会话走 LAN');

    const before = Date.now();
    // 物理断开 LAN：关闭 A 的 LAN UDP/TCP 监听与活动 TCP 流。
    // Hub/WebRTC 不受影响，这是本测试要覆盖的故障域。
    await a.transport.lan.stop();
    const secureTransport = (node, peerKey) => node.secure.getActiveSessions()
      .find((session) => session.peerKey === peerKey)?.transport;
    await waitFor(
      () => secureTransport(a, bKey) === 'direct' && secureTransport(b, aKey) === 'direct',
      'LAN 断开后通过 Direct 自动恢复加密',
      15000,
    );
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 15000, `恢复耗时过长：${elapsed}ms`);

    const sessionA = a.secure.getActiveSessions().find((session) => session.peerKey === bKey);
    const sessionB = b.secure.getActiveSessions().find((session) => session.peerKey === aKey);
    assert.equal(sessionA?.transport, 'direct');
    assert.equal(sessionB?.transport, 'direct');
    assert.equal(
      a.registry.list().find((peer) => peer.key === bKey)?.path,
      'direct',
      'UI 路径应立刻变成公网直连',
    );
    assert.deepEqual(errors, []);
    console.log(`✓ 切断 LAN 后 ${elapsed}ms 内自动切 Direct 并恢复加密`);

    a.sendText(bKey, 'secure-after-lan-failover');
    await waitFor(
      () => [...b.peers.values()].some((peer) => peer.key === aKey),
      'failover 后联系人仍在',
    );
    console.log('\n网络状态变化恢复测试通过 ✅');
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
    await hub.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\n网络状态变化恢复测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
