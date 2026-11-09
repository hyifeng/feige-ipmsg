'use strict';

/**
 * 只有一侧发现 LAN 断链时的恢复测试。
 * A（identity 较大）先发现，B 仍认为旧 LAN 会话有效；A 延迟发起
 * 跨传输 resume，B 必须通过迁移替换旧会话，而不是一直 busy。
 */

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { FeigeNode } = require('../src/main/network');
const { createHubServer } = require('../server/src/hub');
const { createIdentity } = require('../src/shared/protocol');

const HUB_PORT = 27087;
const STUN_PORT = 27080;
const PORT_A = 27051;
const PORT_B = 27052;
const DISCOVERY = 27050;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

function waitEvent(emitter, event, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`等待事件超时：${event}`));
    }, timeout);
    const handler = (payload) => {
      clearTimeout(timer);
      emitter.removeListener(event, handler);
      resolve(payload);
    };
    emitter.on(event, handler);
  });
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-migration-test-'));
  const hub = createHubServer({
    port: HUB_PORT,
    host: '127.0.0.1',
    stunPort: STUN_PORT,
    stunHost: '127.0.0.1',
    logger: { log() {}, error: console.error },
  });
  await hub.start();

  let aId = createIdentity();
  let bId = createIdentity();
  if (aId.id < bId.id) [aId, bId] = [bId, aId]; // A identity 更大，是非首选发起方
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
  const a = makeNode(aId, PORT_A, 'migration-a');
  const b = makeNode(bId, PORT_B, 'migration-b');

  try {
    await a.start();
    await b.start();
    await waitFor(() => a.peers.get(bKey)?.online && b.peers.get(aKey)?.online, '双方发现');
    a.transport.markPathUnhealthy(bKey, 'direct', 60000);
    const sasA = waitEvent(a, 'secure-sas');
    const sasB = waitEvent(b, 'secure-sas');
    a.secure.start(bKey);
    const [infoA, infoB] = await Promise.all([sasA, sasB]);
    a.secure.confirm(infoA.sessionId);
    b.secure.confirm(infoB.sessionId);
    await waitFor(() => a.secure.isActive(bKey) && b.secure.isActive(aKey), 'LAN 加密会话');
    assert.equal(a.secure.getSession(bKey).transport, 'lan');

    // 只让 A 发现断链；B 的旧 socket close/error 不处理，模拟单方向物理断链。
    const bOld = b.secure.getSession(aKey);
    bOld.socket.removeAllListeners('close');
    bOld.socket.removeAllListeners('error');
    a.transport.clearPathFailure(bKey, 'direct');
    // 物理链路不可用：A 的 LAN 监听也一起消失；B 的 LAN 重试必须失败，
    // 才能验证它会降级到 Direct。
    await a.transport.lan.stop();
    const aOld = a.secure.getSession(bKey);
    a.secure._failSession(aOld, '加密连接已断开', { pairingKeep: true });

    const started = Date.now();
    await waitFor(
      () => a.secure.getActiveSessions().find((s) => s.peerKey === bKey)?.transport === 'direct'
        && b.secure.getActiveSessions().find((s) => s.peerKey === aKey)?.transport === 'direct',
      '单侧发现断链后跨传输 resume',
      15000,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15000, `恢复耗时过长：${elapsed}ms`);
    console.log(`✓ 单侧发现 LAN 断链，${elapsed}ms 内通过跨传输迁移恢复`);
    console.log('\n加密会话迁移测试通过 ✅');
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
    await hub.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\n加密会话迁移测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
