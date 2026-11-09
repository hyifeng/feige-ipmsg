'use strict';

/**
 * 端到端网络测试：发现、消息/回执、文件、目录、离线。
 * 运行：node test/network.test.js
 *
 * 使用共享的发现端口 + 不同的服务端口，模拟两台局域网主机。
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { FeigeNode } = require('../src/main/network');
const {
  encodePacket,
  parsePacket,
  encodeBody,
  decodeBody,
  makeCommand,
  CMD,
  OPT,
  APP_TAG,
  PROTOCOL_VERSION,
  createIdentity,
} = require('../src/shared/protocol');

const DISCOVERY_PORT = 25250;
const PORT_A = 25251;
const PORT_B = 25252;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

function waitEvent(emitter, event, predicate = () => true, timeout = 15000) {
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

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  // 0. 协议编解码单元检查
  const pkt = encodePacket({
    packetNo: 42,
    user: '张三:测试',
    host: 'pc-1',
    command: makeCommand(CMD.SENDMSG, OPT.SENDCHECK | OPT.FILEATTACH),
    message: encodeBody('hello', { app: APP_TAG, v: PROTOCOL_VERSION, kind: 'files', files: [{ id: 'f1' }] }),
  });
  const parsed = parsePacket(Buffer.from(pkt));
  assert.equal(parsed.packetNo, 42);
  assert.equal(parsed.user, '张三 测试');
  assert.equal(parsed.base, CMD.SENDMSG);
  assert.equal(parsed.options, OPT.SENDCHECK | OPT.FILEATTACH);
  const body = decodeBody(parsed.message);
  assert.equal(body.text, 'hello');
  assert.equal(body.ext.files[0].id, 'f1');
  const wrongVersion = pkt.replace(new RegExp(`^${PROTOCOL_VERSION}:`), '3:');
  assert.equal(parsePacket(Buffer.from(wrongVersion)), null);
  console.log('✓ 协议编解码 / 版本严格校验');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-test-'));
  const sourceDir = path.join(root, 'source');
  const folder = path.join(sourceDir, '相册 MyFolder');
  await fsp.mkdir(path.join(folder, '子目录'), { recursive: true });
  await fsp.mkdir(path.join(folder, '空目录'), { recursive: true });
  await fsp.writeFile(path.join(folder, '说明.txt'), '飞鸽传书目录测试\n'.repeat(200));
  const binData = crypto.randomBytes(1536 * 1024 + 137);
  await fsp.writeFile(path.join(folder, '子目录', 'data.bin'), binData);
  await fsp.writeFile(path.join(folder, '子目录', '空文件.dat'), Buffer.alloc(0));
  const singleFile = path.join(sourceDir, '单文件 测试.txt');
  await fsp.writeFile(singleFile, 'single file payload\n'.repeat(1000));

  const largeFolder = path.join(sourceDir, '大量文件');
  await fsp.mkdir(path.join(largeFolder, '子目录'), { recursive: true });
  await fsp.mkdir(path.join(largeFolder, '空子目录'), { recursive: true });
  const largeFiles = [];
  for (let index = 0; index < 12; index += 1) {
    const rel = index % 2 === 1 ? `子目录/file-${index}.txt` : `file-${index}.txt`;
    const content = `large-file-${index}-${'x'.repeat(2048)}`;
    await fsp.writeFile(path.join(largeFolder, rel), content);
    largeFiles.push({ rel, content });
  }

  // 预先占位，验证接收端重名自动编号
  const downloadB = path.join(root, 'downloads-b');
  await fsp.mkdir(path.join(downloadB, '相册 MyFolder'), { recursive: true });
  await fsp.writeFile(path.join(downloadB, '相册 MyFolder', '旧文件.txt'), 'old');

  const errors = [];
  let b3 = null;
  let c = null;
  const aIdentity = createIdentity();
  const bIdentity = createIdentity();
  const a = new FeigeNode({
    port: PORT_A,
    discoveryPort: DISCOVERY_PORT,
    user: 'Alice',
    host: 'host-a',
    identityKey: aIdentity,
    downloadDir: path.join(root, 'downloads-a'),
  });
  const b = new FeigeNode({
    port: PORT_B,
    discoveryPort: DISCOVERY_PORT,
    user: 'Bob',
    host: 'host-b',
    identityKey: bIdentity,
    downloadDir: downloadB,
  });
  a.on('error', (err) => errors.push(`A: ${err.message}`));
  b.on('error', (err) => errors.push(`B: ${err.message}`));

  try {
    await a.start();
    await b.start();

    // 1. 自动发现
    await waitFor(() => [...a.peers.values()].some((p) => p.user === 'Bob' && p.online), 'A 发现 B');
    await waitFor(() => [...b.peers.values()].some((p) => p.user === 'Alice' && p.online), 'B 发现 A');
    const bob = [...a.peers.values()].find((p) => p.user === 'Bob');
    const alice = [...b.peers.values()].find((p) => p.user === 'Alice');
    assert.ok(bob);
    assert.ok(alice);
    console.log(`✓ 自动发现 (${bob.ip}:${bob.port} ↔ ${alice.ip}:${alice.port})`);

    // 旧扩展段（缺少 v/kind 等当前必填字段）必须被直接忽略
    const legacyEntry = encodePacket({
      packetNo: 90000,
      user: 'Legacy',
      host: 'legacy-host',
      command: CMD.BR_ENTRY,
      message: encodeBody('', {
        app: APP_TAG,
        kind: 'entry',
        id: 'legacy-node',
        instance: 'legacy-instance',
        port: PORT_B,
        online: true,
      }),
    });
    a._onUdp(Buffer.from(legacyEntry), { address: '203.0.113.9', port: PORT_B });
    assert.equal(a.peers.has('id:legacy-node'), false);
    console.log('✓ 旧扩展段被拒绝');

    // 2. 文本消息 + 已读回执
    const ackPromise = waitEvent(a, 'ack', (ack) => ack.peerKey === bob.key);
    const messagePromise = waitEvent(b, 'message', (msg) => msg.text === '你好，飞鸽');
    a.sendText(bob.key, '你好，飞鸽');
    const received = await messagePromise;
    assert.equal(received.peerKey, alice.key);
    await ackPromise;
    console.log('✓ 文本消息与回执');

    // 2.1 图片消息：自动接收，显示名与临时文件名解耦
    const plainImagePath = path.join(root, 'plain-image-source.png');
    const plainImageBytes = crypto.randomBytes(96 * 1024);
    await fsp.writeFile(plainImagePath, plainImageBytes);
    const imageMessagePromise = waitEvent(b, 'message', (msg) => msg.kind === 'image' && msg.name === '普通图片.png');
    const imageDonePromise = waitEvent(b, 'transfer-done', (info) => info.direction === 'in' && info.image === true);
    await a.sendImage(bob.key, plainImagePath, {
      name: '普通图片.png',
      thumb: 'data:image/png;base64,iVBORw0KGgo=',
      caption: '明文图片',
    });
    const plainImageMessage = await imageMessagePromise;
    assert.equal(plainImageMessage.text, '明文图片');
    assert.equal(plainImageMessage.thumb.startsWith('data:image/png'), true);
    const plainImageDone = await imageDonePromise;
    assert.ok(fs.existsSync(path.join(plainImageDone.root, '普通图片.png')));
    console.log('✓ 图片消息自动接收 / 显示名');

    // 3. 发送单个文件
    const doneAtB = waitEvent(b, 'transfer-done', (info) => info.direction === 'in' && info.peerName === 'Alice');
    const offerPromise = waitEvent(b, 'offer', (offer) => offer.files.some((f) => f.name === '单文件 测试.txt'));
    const sentSingle = await a.sendPaths(bob.key, [singleFile]);
    assert.equal(sentSingle.files.length, 1);
    const offer = await offerPromise;
    await b.acceptOffer(offer.id);
    const singleDone = await doneAtB;
    assert.ok(singleDone.root);
    const receivedSingle = path.join(singleDone.root, '单文件 测试.txt');
    assert.equal(sha256(receivedSingle), sha256(singleFile));
    console.log('✓ 文件传输（含中文文件名）');

    // 4. 发送目录（含子目录、空目录、空文件）
    const offerDirPromise = waitEvent(b, 'offer', (item) => item.files.length > 2);
    const doneDirPromise = waitEvent(b, 'transfer-done', (info) => info.direction === 'in' && info.fileCount > 2);
    const sentDir = await a.sendPaths(bob.key, [folder], '这是目录说明');
    assert.ok(sentDir.totalFiles >= 3);
    const dirOffer = await offerDirPromise;
    assert.ok(dirOffer.files.some((f) => f.dir));
    await b.acceptOffer(dirOffer.id);
    const dirDone = await doneDirPromise;

    const destRoot = path.join(dirDone.root, '相册 MyFolder (1)');
    assert.equal(
      sha256(path.join(destRoot, '子目录', 'data.bin')),
      crypto.createHash('sha256').update(binData).digest('hex'),
    );
    assert.equal(await fsp.readFile(path.join(destRoot, '说明.txt'), 'utf8'), '飞鸽传书目录测试\n'.repeat(200));
    assert.equal((await fsp.stat(path.join(destRoot, '子目录', '空文件.dat'))).size, 0);
    assert.ok((await fsp.stat(path.join(destRoot, '空目录'))).isDirectory());
    console.log(`✓ 目录传输（${dirOffer.files.length} 个条目，重名保存为“相册 MyFolder (1)”）`);

    // 5. 发送同样目录再检查一次重名不冲突（已占用 “(1)”）
    const offerDir2 = waitEvent(b, 'offer', (item) => item.files.length > 2);
    const doneDir2 = waitEvent(b, 'transfer-done', (info) => info.direction === 'in' && info.fileCount > 2);
    await a.sendPaths(bob.key, [folder]);
    const dirOffer2 = await offerDir2;
    await b.acceptOffer(dirOffer2.id);
    const dirDone2 = await doneDir2;
    assert.ok(fs.existsSync(path.join(dirDone2.root, '相册 MyFolder (2)')));
    console.log('✓ 连续重名目录自动编号');

    // 6. 大目录：报价只带预览，接收后经加密通道拉取完整清单
    const offerLargePromise = waitEvent(b, 'offer', (item) => item.rootName === '大量文件');
    const doneLargePromise = waitEvent(b, 'transfer-done', (info) => info.direction === 'in' && info.fileCount === 12);
    const sentLarge = await a.sendPaths(bob.key, [largeFolder], '大目录测试');
    assert.equal(sentLarge.totalFiles, 12);
    const largeOffer = await offerLargePromise;
    assert.equal(largeOffer.needsManifest, true);
    assert.equal(largeOffer.totalFiles, 12);
    assert.equal(largeOffer.totalEntries, 13);
    assert.ok(largeOffer.files.length <= 8);
    await b.acceptOffer(largeOffer.id);
    const largeDone = await doneLargePromise;
    for (const file of largeFiles) {
      const target = path.join(largeDone.root, '大量文件', file.rel);
      assert.equal(await fsp.readFile(target, 'utf8'), file.content);
    }
    assert.ok((await fsp.stat(path.join(largeDone.root, '大量文件', '空子目录'))).isDirectory());
    console.log(`✓ 大目录清单经 TCP 拉取（预览 ${largeOffer.files.length} 项 / 共 ${largeOffer.totalEntries} 项）`);

    // 7. 反向传输（B → A）
    const offerAtA = waitEvent(a, 'offer', (item) => item.peerName === 'Bob');
    const doneAtA = waitEvent(a, 'transfer-done', (info) => info.direction === 'in' && info.peerKey === bob.key);
    await b.sendPaths(alice.key, [singleFile]);
    const offerA = await offerAtA;
    await a.acceptOffer(offerA.id);
    const doneA = await doneAtA;
    assert.ok(fs.existsSync(path.join(doneA.root, '单文件 测试.txt')));
    console.log('✓ 反向文件传输');

    // 8. 离线 / 重新上线
    const offlineEvent = waitEvent(a, 'peer-offline', (peer) => peer.key === bob.key);
    b.setOnline(false);
    await offlineEvent;
    assert.ok(!a.peers.get(bob.key).online);
    await assert.rejects(b.sendText(alice.key, 'hidden msg'), /已下线/);
    await assert.rejects(b.sendPaths(alice.key, [singleFile]), /已下线/);
    await sleep(400);
    const onlineAgain = waitEvent(a, 'peers', (peers) => peers.some((p) => p.key === bob.key && p.online));
    b.setOnline(true);
    await onlineAgain;
    console.log('✓ 下线 / 重新上线广播');

    // 9. 拒绝传输
    const offerReject = waitEvent(b, 'offer', (item) => item.files.some((f) => f.name === '单文件 测试.txt'));
    const declined = waitEvent(a, 'transfer-closed', (info) => info.reason === 'declined');
    await a.sendPaths(bob.key, [singleFile]);
    const rejectOffer = await offerReject;
    b.declineOffer(rejectOffer.id);
    await declined;
    console.log('✓ 拒绝传输');

    // 10. 使用持久 identity 重启，联系人不应重复
    const stableKey = bob.key;
    assert.equal(stableKey, `id:${bIdentity.id}`);
    await b.stop();
    await waitFor(() => !a.peers.get(stableKey)?.online, 'Bob 下线');

    b3 = new FeigeNode({
      port: PORT_B,
      discoveryPort: DISCOVERY_PORT,
      user: 'Bob',
      host: 'host-b',
      identityKey: bIdentity,
      downloadDir: downloadB,
    });
    await b3.start();
    await waitFor(() => a.peers.get(stableKey)?.online, 'Bob 使用同一 identity 重新上线');
    assert.equal([...a.peers.values()].filter((peer) => peer.user === 'Bob').length, 1);

    await waitFor(
      () => [...b3.peers.values()].some((peer) => peer.user === 'Alice' && peer.online),
      'Bob 重新发现 Alice',
    );
    const aliceForB3 = [...b3.peers.values()].find((peer) => peer.user === 'Alice');
    const messageBack = waitEvent(a, 'message', (message) => message.text === '我回来了');
    b3.sendText(aliceForB3.key, '我回来了');
    await messageBack;
    console.log('✓ 重启后节点身份稳定，无重复在线/离线联系人');

    // 11. 隐身节点不应被新启动的客户端误判为在线
    b3.setOnline(false);
    await waitFor(() => !a.peers.get(stableKey)?.online, 'Bob 隐身');

    c = new FeigeNode({
      port: 25253,
      discoveryPort: DISCOVERY_PORT,
      user: 'Carol',
      host: 'host-c',
      identityKey: createIdentity(),
      downloadDir: path.join(root, 'downloads-c'),
    });
    await c.start();
    await waitFor(
      () => [...c.peers.values()].some((peer) => peer.user === 'Alice' && peer.online),
      'Carol 发现 Alice',
    );
    c.refresh();
    await sleep(1200);
    assert.equal(
      [...c.peers.values()].filter((peer) => peer.user === 'Bob').length,
      0,
      '隐身 Bob 不应出现在新客户端中',
    );

    b3.setOnline(true);
    await waitFor(() => c.peers.get(stableKey)?.online, 'Bob 上线后 Carol 发现 Bob');
    assert.equal([...c.peers.values()].filter((peer) => peer.user === 'Bob').length, 1);
    console.log('✓ 隐身节点不会被新客户端误判为在线');

    // 模拟对端直接断电：没有 BR_EXIT，只能依赖心跳超时。
    const timeoutOffline = waitEvent(a, 'peer-offline', (peer) => peer.key === stableKey);
    const timedOutPeer = a.peers.get(stableKey);
    timedOutPeer.lastSeen = Date.now() - 60000;
    a._sweepPeers();
    const timedOutInfo = await timeoutOffline;
    assert.equal(timedOutInfo.online, false);
    assert.equal(a.peers.get(stableKey).online, false);
    assert.equal(a.secure.isActive(stableKey), false);
    console.log('✓ 无 BR_EXIT 时心跳超时标记离线并触发 peer-offline');

    if (errors.length) {
      throw new Error(`网络错误：${errors.join(' | ')}`);
    }

    console.log('\n全部测试通过 ✅');
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
    if (b3) await b3.stop().catch(() => {});
    if (c) await c.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\n测试失败 ❌');
  console.error(err);
  process.exitCode = 1;
});
