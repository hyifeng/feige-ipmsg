'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { FeigeNode } = require('../src/main/network');
const {
  APP_TAG,
  CMD,
  OPT,
  PROTOCOL_VERSION,
  createIdentity,
  signPayload,
  encodePacket,
  encodeBody,
  makeCommand,
} = require('../src/shared/protocol');
const { SecureManager, createMemoryStore } = require('../src/main/secure');

const DISCOVERY = 25350;
const PORT_A = 25351;
const PORT_B = 25352;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function memoryStore() {
  const map = new Map();
  return {
    get: (key) => map.get(key) || null,
    set: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
    list: () => [...map.entries()].map(([peerKey, value]) => ({ peerKey, user: value.user })),
    _map: map,
  };
}

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(60);
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
  // 加密握手版本/模式必须严格匹配当前协议
  const strictIdentity = createIdentity();
  const strictManager = new SecureManager({
    identity: strictIdentity.id,
    identityKey: strictIdentity,
    user: 'Strict A',
    store: createMemoryStore(),
    getPeer: () => null,
  });
  const rejected = [];
  let destroyed = 0;
  const fakeSocket = {
    end: (buffer) => rejected.push(JSON.parse(buffer.subarray(4).toString('utf8'))),
    destroy: () => { destroyed += 1; },
  };
  strictManager.handleIncoming(fakeSocket, {
    t: 'hs', step: 'hello', v: 99, mode: 'pair', sessionId: 's1', fromKey: 'strict-b',
  }, Buffer.alloc(0));
  strictManager.handleIncoming(fakeSocket, {
    t: 'hs', step: 'hello', v: PROTOCOL_VERSION, mode: 'legacy', sessionId: 's2', fromKey: 'strict-b',
  }, Buffer.alloc(0));
  assert.equal(destroyed, 1, '协议版本不匹配必须直接断开');
  assert.deepEqual(rejected.map((item) => item.code), ['bad-mode']);
  console.log('✓ 加密协议版本不匹配直接断开 / 模式严格校验');
  // 已有配对时，匿名 pair 必须被拒绝；无配对 resume 也必须被拒绝
  const guardIdentityA = createIdentity();
  const guardIdentityB = createIdentity();
  const guardStore = memoryStore();
  guardStore.set(`id:${guardIdentityB.id}`, { key: crypto.randomBytes(32), user: 'Guard B' });
  const guardA = new SecureManager({
    identity: guardIdentityA.id,
    identityKey: guardIdentityA,
    user: 'Guard A',
    store: guardStore,
    getPeer: () => null,
  });
  const guardErrors = [];
  const guardSocket = {
    end: (buffer) => guardErrors.push(JSON.parse(buffer.subarray(4).toString('utf8'))),
    destroy: () => {},
  };
  let guardPairingWarning = null;
  guardA.on('warning', (info) => {
    if (info.code === 'pairing-exists') guardPairingWarning = info;
  });
  guardA.handleIncoming(guardSocket, {
    t: 'hs', step: 'hello', v: PROTOCOL_VERSION, mode: 'pair', sessionId: 'g1',
    fromKey: guardIdentityB.id, commit: '00', nonce: '00',
  }, Buffer.alloc(0));
  assert.equal(guardErrors.at(-1).code, 'pairing-exists');
  assert.equal(guardPairingWarning.canReset, true, '已有配对的一方应收到可手动重新认证的提示');
  assert.equal(guardA.autoPaused.has(`id:${guardIdentityB.id}`), true, '对方主动发起 pair 后应停止自动重试');

  guardA.handleIncoming(guardSocket, {
    t: 'hs', step: 'hello', v: PROTOCOL_VERSION, mode: 'pair', sessionId: 'g2',
    fromKey: 'not-a-public-key', commit: '00', nonce: '00',
  }, Buffer.alloc(0));
  assert.equal(guardErrors.at(-1).code, 'bad-identity');

  const guardNoPair = new SecureManager({
    identity: guardIdentityA.id,
    identityKey: guardIdentityA,
    user: 'Guard A',
    store: memoryStore(),
    getPeer: () => null,
  });
  guardNoPair.handleIncoming(guardSocket, {
    t: 'hs', step: 'hello', v: PROTOCOL_VERSION, mode: 'resume', sessionId: 'g3',
    fromKey: guardIdentityB.id, commit: '00', nonce: '00',
  }, Buffer.alloc(0));
  assert.equal(guardErrors.at(-1).code, 'no-pairing');

  assert.equal(guardA.resetPairing(`id:${guardIdentityB.id}`), true);
  assert.equal(guardStore.get(`id:${guardIdentityB.id}`), null);
  console.log('✓ 已有配对拒绝匿名 pair / 身份校验 / 显式重置');
  // 伪造的会话错误帧不能删除配对
  const errManagerIdentity = createIdentity();
  const errPeer = createIdentity();
  const errStore = memoryStore();
  errStore.set(`id:${errPeer.id}`, { key: crypto.randomBytes(32), user: 'Err Peer' });
  const errManager = new SecureManager({
    identity: errManagerIdentity.id,
    identityKey: errManagerIdentity,
    store: errStore,
    getPeer: () => null,
  });
  const errSession = errManager._createSession({
    peerKey: `id:${errPeer.id}`,
    peer: { user: 'Err Peer' },
    role: 'responder',
    mode: 'resume',
    psk: crypto.randomBytes(32),
  });
  errSession.sessionId = 'err-session';
  errManager._handleHandshake(errSession, {
    t: 'hs', step: 'error', code: 'auth-failed', sessionId: 'err-session',
    fromKey: errPeer.id, ts: Date.now(), nonce: 'err-nonce-1',
  });
  assert.ok(errStore.get(`id:${errPeer.id}`), '未签名错误帧不能删除配对');

  const errBase = {
    t: 'hs', step: 'error', v: PROTOCOL_VERSION, sessionId: 'err-session',
    fromKey: errPeer.id, code: 'auth-failed', message: '认证失败',
    ts: Date.now(), nonce: 'err-nonce-2',
  };
  errManager._handleHandshake(errSession, {
    ...errBase,
    sig: signPayload(errPeer.privateKey, errBase),
  });
  assert.ok(errStore.get(`id:${errPeer.id}`), '已签名错误帧也不能删除配对');

  // 伪造的握手 proof 必须被拒绝
  const proofManagerIdentity = createIdentity();
  const proofPeer = createIdentity();
  const proofAttacker = createIdentity();
  const proofManager = new SecureManager({
    identity: proofManagerIdentity.id,
    identityKey: proofManagerIdentity,
    store: memoryStore(),
    getPeer: () => null,
  });
  const proofSession = proofManager._createSession({
    peerKey: `id:${proofPeer.id}`,
    peer: { user: 'Proof Peer' },
    role: 'responder',
    mode: 'pair',
    psk: null,
  });
  proofSession.sessionId = 'proof-session';
  proofSession.transcriptHash = crypto.randomBytes(32);
  proofSession.keys = {};
  const proofBase = {
    t: 'hs', step: 'proof', v: PROTOCOL_VERSION, sessionId: 'proof-session',
    fromKey: proofPeer.id, transcript: proofSession.transcriptHash.toString('hex'),
  };
  proofManager._handleHandshake(proofSession, {
    ...proofBase,
    sig: signPayload(proofAttacker.privateKey, proofBase),
  });
  assert.equal(proofSession.peerProof, false, '错误私钥签名的 proof 必须被拒绝');
  proofManager._handleHandshake(proofSession, {
    ...proofBase,
    sig: signPayload(proofPeer.privateKey, proofBase),
  });
  assert.equal(proofSession.peerProof, true, '正确私钥签名的 proof 必须通过');
  console.log('✓ 伪造错误帧 / 伪造握手签名被拒绝');



  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-secure-'));
  const source = path.join(root, 'secure-folder');
  await fsp.mkdir(path.join(source, 'sub'), { recursive: true });
  await fsp.mkdir(path.join(source, 'empty'), { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    const rel = index % 2 === 0 ? `文件-${index}.txt` : `sub/文件-${index}.bin`;
    await fsp.writeFile(path.join(source, rel), crypto.randomBytes(4096 + index));
  }
  const fileList = [];
  for (let index = 0; index < 12; index += 1) {
    const rel = index % 2 === 0 ? `文件-${index}.txt` : `sub/文件-${index}.bin`;
    fileList.push({ rel, hash: crypto.createHash('sha256').update(await fsp.readFile(path.join(source, rel))).digest('hex') });
  }
  const largeA = crypto.randomBytes(320 * 1024);
  const largeB = crypto.randomBytes(180 * 1024);
  await fsp.writeFile(path.join(source, 'large-a.bin'), largeA);
  await fsp.writeFile(path.join(source, 'large-b.bin'), largeB);
  fileList.push({ rel: 'large-a.bin', hash: crypto.createHash('sha256').update(largeA).digest('hex') });
  fileList.push({ rel: 'large-b.bin', hash: crypto.createHash('sha256').update(largeB).digest('hex') });

  const storeA = memoryStore();
  const storeB = memoryStore();
  // 自动恢复时由 identity 较小的一侧发起；让 A 始终是发起方，测试才有确定性
  let aIdentity = createIdentity();
  let bIdentity = createIdentity();
  while (aIdentity.id >= bIdentity.id) {
    aIdentity = createIdentity();
    bIdentity = createIdentity();
  }
  const a = new FeigeNode({
    port: PORT_A,
    discoveryPort: DISCOVERY,
    user: 'Secure A',
    host: 'host-a',
    identityKey: aIdentity,
    downloadDir: path.join(root, 'download-a'),
    secureStore: storeA,
  });
  const b = new FeigeNode({
    port: PORT_B,
    discoveryPort: DISCOVERY,
    user: 'Secure B',
    host: 'host-b',
    identityKey: bIdentity,
    downloadDir: path.join(root, 'download-b'),
    secureStore: storeB,
  });
  a.on('error', (error) => console.error('A error', error.message));
  b.on('error', (error) => console.error('B error', error.message));

  try {
    await a.start();
    await b.start();
    await waitFor(() => [...a.peers.values()].some((peer) => peer.user === 'Secure B'), 'A 发现 B');
    const bob = [...a.peers.values()].find((peer) => peer.user === 'Secure B');
    const alice = [...b.peers.values()].find((peer) => peer.user === 'Secure A');
    assert.ok(bob && alice);

    // 首次加密：SAS 双方一致，双方确认后激活
    const sasA = waitEvent(a, 'secure-sas');
    const sasB = waitEvent(b, 'secure-sas');
    a.secure.start(bob.key);
    const [codeA, codeB] = await Promise.all([sasA, sasB]);
    assert.equal(codeA.code, codeB.code);
    assert.match(codeA.code, /^\d{6}$/);
    assert.equal(codeA.incoming, false);
    assert.equal(codeB.incoming, true);
    const upA = waitEvent(a, 'secure-up');
    const upB = waitEvent(b, 'secure-up');
    assert.equal(a.secure.confirm(codeA.sessionId), true);
    assert.equal(b.secure.confirm(codeB.sessionId), true);
    await Promise.all([upA, upB]);
    assert.equal(a.secure.isActive(bob.key), true);
    assert.equal(b.secure.isActive(alice.key), true);
    assert.ok(storeA.get(bob.key));
    assert.ok(storeB.get(alice.key));
    console.log(`✓ 加密握手 + 6 位安全码 (${codeA.code})`);

    // 解除认证：A 通知 B 后只删除本机配对；B 保留旧配对并显示“重新认证”流程
    const oldPairA = Buffer.from(storeA.get(bob.key).key);
    const oldPairB = Buffer.from(storeB.get(alice.key).key);
    const revokedAtB = waitEvent(b, 'secure-down', (info) => info.reason === '对方已解除认证');
    assert.equal(await a.secure.revokePairing(bob.key), true);
    await revokedAtB;
    assert.equal(a.secure.hasPairing(bob.key), false);
    assert.equal(b.secure.hasPairing(alice.key), true, 'B 应保留旧配对待用户确认');
    assert.equal(a.secure.isActive(bob.key), false);
    assert.equal(b.secure.isActive(alice.key), false);
    assert.equal(b.secure.autoPaused.has(alice.key), true, 'B 应暂停自动恢复，等待用户重新认证');

    // B 执行“重新认证”：解除本机旧认证，再发起首次认证；A 不主动发起
    assert.equal(b.secure.resetPairing(alice.key), true);
    const reauthSasA = waitEvent(a, 'secure-sas');
    const reauthSasB = waitEvent(b, 'secure-sas');
    b.secure.start(alice.key);
    const [reauthA, reauthB] = await Promise.all([reauthSasA, reauthSasB]);
    assert.equal(reauthA.code, reauthB.code);
    const reauthUpA = waitEvent(a, 'secure-up');
    const reauthUpB = waitEvent(b, 'secure-up');
    a.secure.confirm(reauthA.sessionId);
    b.secure.confirm(reauthB.sessionId);
    await Promise.all([reauthUpA, reauthUpB]);
    assert.equal(a.secure.isActive(bob.key), true);
    assert.equal(b.secure.isActive(alice.key), true);
    assert.ok(storeA.get(bob.key));
    assert.ok(storeB.get(alice.key));
    assert.equal(storeA.get(bob.key).key.equals(oldPairA), false);
    assert.equal(storeB.get(alice.key).key.equals(oldPairB), false);
    assert.equal(b.secure.autoPaused.has(alice.key), false);
    console.log('✓ 解除认证通知 / B 重新认证流程');

    // 加密文本
    const incoming = waitEvent(b, 'message', (message) => message.text === 'secure text');
    const ack = waitEvent(a, 'ack');
    a.sendText(bob.key, 'secure text');
    await incoming;
    await ack;
    console.log('✓ 加密文本与回执');
    // 已认证联系人：加密会话暂停时禁止明文降级，且对端明文消息直接丢弃
    const pauseA = waitEvent(a, 'secure-down');
    const pauseB = waitEvent(b, 'secure-down');
    a.secure.closePeer(bob.key, '测试加密暂停');
    await Promise.all([pauseA, pauseB]);
    assert.ok(storeA.get(bob.key), '暂停加密后 pairing 必须保留');
    assert.ok(storeB.get(alice.key), '暂停加密后对端 pairing 必须保留');

    const blockedMessages = [];
    a.on('message', (message) => {
      if (message.text === 'paired-plaintext') blockedMessages.push(message);
    });
    const ts = Date.now();
    const plainBase = {
      app: APP_TAG,
      v: PROTOCOL_VERSION,
      kind: 'text',
      id: b.identity,
      instance: b.instanceId,
      user: b.user,
      host: b.host,
      port: b.port,
      recipient: a.identity,
      msgId: `${b.identity}:${ts}:blocked`,
      seq: 99999,
      ts,
      nonce: 'blocked-nonce-1',
    };
    const plainExt = {
      ...plainBase,
      sig: signPayload(b.identityKey.privateKey, { ...plainBase, text: 'paired-plaintext' }),
    };
    const plainPacket = encodePacket({
      packetNo: 99999,
      user: b.user,
      host: b.host,
      command: makeCommand(CMD.SENDMSG, OPT.SENDCHECK),
      message: encodeBody('paired-plaintext', plainExt),
    });
    a._onUdp(Buffer.from(plainPacket), { address: bob.ip, port: b.port });
    await sleep(120);
    assert.equal(blockedMessages.length, 0, '任何联系人都不得通过明文发送消息');

    // 已认证联系人发送时会自动恢复 pairing，不再要求用户先手动恢复。
    const resumePauseA = waitEvent(a, 'secure-up', (info) => info.mode === 'resume');
    const resumePauseB = waitEvent(b, 'secure-up', (info) => info.mode === 'resume');
    const resumedMessage = waitEvent(b, 'message', (message) => message.text === 'resume after pause');
    await a.sendText(bob.key, 'resume after pause');
    await Promise.all([resumePauseA, resumePauseB, resumedMessage]);
    assert.equal(a.secure.isActive(bob.key), true);
    assert.equal(b.secure.isActive(alice.key), true);
    console.log('✓ 加密暂停后自动恢复 / 明文消息始终丢弃');


    // 加密图片（自动接收，消息为 image）
    const imagePath = path.join(root, 'photo.png');
    const imageBytes = crypto.randomBytes(128 * 1024);
    await fsp.writeFile(imagePath, imageBytes);
    const imageMessagePromise = waitEvent(b, 'message', (message) => message.kind === 'image' && message.name === '旅行照片.png');
    const imageDonePromise = waitEvent(b, 'transfer-done', (info) => info.direction === 'in' && info.image === true);
    await a.sendImage(bob.key, imagePath, {
      thumb: 'data:image/png;base64,iVBORw0KGgo=',
      caption: '一张加密图片',
      name: '旅行照片.png',
    });
    const imageMessage = await imageMessagePromise;
    assert.equal(imageMessage.transferId !== undefined, true);
    assert.equal(imageMessage.thumb.startsWith('data:image/png'), true);
    const imageDone = await imageDonePromise;
    assert.ok(fs.existsSync(path.join(imageDone.root, '旅行照片.png')));
    console.log('✓ 加密图片消息与自动接收');

    // 加密目录（含 manifest 分块与文件分块）
    const offerPromise = waitEvent(b, 'offer', (offer) => offer.secure === true);
    const donePromise = waitEvent(b, 'transfer-done', (info) => info.direction === 'in' && info.fileCount === 14);
    await a.sendPaths(bob.key, [source]);
    const offer = await offerPromise;
    assert.equal(offer.secure, true);
    assert.equal(offer.needsManifest, true);
    await b.acceptOffer(offer.id);
    const done = await donePromise;
    for (const file of fileList) {
      const target = path.join(done.root, 'secure-folder', file.rel);
      const hash = crypto.createHash('sha256').update(await fsp.readFile(target)).digest('hex');
      assert.equal(hash, file.hash);
    }
    assert.ok((await fsp.stat(path.join(done.root, 'secure-folder', 'empty'))).isDirectory());
    console.log('✓ 加密目录 / 清单 / 文件分块');

    // 下线再上线，自动用保存的 pairing key 恢复
    const downA = waitEvent(a, 'secure-down');
    const downB = waitEvent(b, 'secure-down');
    b.setOnline(false);
    await Promise.all([downA, downB]);
    assert.throws(() => b.secure.start(alice.key), /已下线/);
    const resumeA = waitEvent(a, 'secure-up', (info) => info.mode === 'resume');
    const resumeB = waitEvent(b, 'secure-up', (info) => info.mode === 'resume');
    b.setOnline(true);
    await Promise.all([resumeA, resumeB]);
    assert.equal(a.secure.isActive(bob.key), true);
    assert.equal(b.secure.isActive(alice.key), true);
    console.log('✓ 下线/上线自动恢复加密会话');

    // 对端 pairing key 不一致：本次握手失败，但不再自动删除配对
    const downWrongA = waitEvent(a, 'secure-down');
    const downWrongB = waitEvent(b, 'secure-down');
    b.setOnline(false);
    await Promise.all([downWrongA, downWrongB]);
    storeB.set(alice.key, { key: crypto.randomBytes(32), user: 'Secure A' });
    const failWrongA = waitEvent(a, 'secure-down');
    const failWrongB = waitEvent(b, 'secure-down');
    b.setOnline(true);
    const [wrongA, wrongB] = await Promise.all([failWrongA, failWrongB]);
    // 双方 identity 随机，发起方可能是 A 也可能是 B
    assert.equal(wrongA.auto || wrongB.auto, true);
    assert.ok(storeA.get(bob.key), '认证失败后本机配对必须保留');
    assert.ok(storeB.get(alice.key), '认证失败后对端配对必须保留');
    assert.equal(a.secure.isActive(bob.key), false);
    assert.equal(b.secure.isActive(alice.key), false);
    console.log('✓ 配对密钥不一致：握手失败但不会删除配对');

    // 只有用户显式重置后才重新配对
    a.secure.resetPairing(bob.key);
    b.secure.resetPairing(alice.key);
    assert.equal(storeA.get(bob.key), undefined);
    assert.equal(storeB.get(alice.key), undefined);
    const sasAgainA = waitEvent(a, 'secure-sas');
    const sasAgainB = waitEvent(b, 'secure-sas');
    a.secure.start(bob.key);
    const [againA, againB] = await Promise.all([sasAgainA, sasAgainB]);
    assert.equal(againA.code, againB.code);
    const upAgainA = waitEvent(a, 'secure-up');
    const upAgainB = waitEvent(b, 'secure-up');
    a.secure.confirm(againA.sessionId);
    b.secure.confirm(againB.sessionId);
    await Promise.all([upAgainA, upAgainB]);

    // 对端 pairing 缺失：本机保留配对，对方给出 no-pairing 提示
    const downMissingA = waitEvent(a, 'secure-down');
    const downMissingB = waitEvent(b, 'secure-down');
    b.setOnline(false);
    await Promise.all([downMissingA, downMissingB]);
    storeB.delete(alice.key);
    const rejectMissingB = waitEvent(b, 'secure-warning', (info) => info.code === 'no-pairing');
    const failMissingA = waitEvent(a, 'secure-down');
    b.setOnline(true);
    const [missingWarning] = await Promise.all([rejectMissingB, failMissingA]);
    assert.equal(missingWarning.peerKey, alice.key);
    assert.ok(storeA.get(bob.key), '对端缺少配对时，本机不应自动删除配对');
    assert.equal(a.secure.isActive(bob.key), false);
    console.log('✓ 配对缺失时双方提示，本机配对保留');

    // 没有配对时，第一条消息自动建立临时加密会话；不要求确认，也不落盘
    a.secure.resetPairing(bob.key);
    const tempUpA = waitEvent(a, 'secure-up', (info) => info.temporary === true);
    const tempUpB = waitEvent(b, 'secure-up', (info) => info.temporary === true);
    const tempMessage = waitEvent(b, 'message', (message) => message.text === 'auto temporary');
    const tempResult = await a.sendText(bob.key, 'auto temporary');
    await Promise.all([tempUpA, tempUpB, tempMessage]);
    assert.equal(tempResult.secure, true);
    assert.equal(a.secure.isActive(bob.key), true);
    assert.equal(b.secure.isActive(alice.key), true);
    assert.equal(a.secure.hasPairing(bob.key), false, '临时加密会话不能持久化 pairing');
    assert.equal(b.secure.hasPairing(alice.key), false, '接收方也不能持久化临时配对');
    assert.equal(storeA.get(bob.key), undefined);
    assert.equal(storeB.get(alice.key), undefined);
    console.log('✓ 第一条消息自动建立临时加密会话（不认证、不落盘）');

    // 用户显式认证临时会话：双方核对 6 位码后才保存 pairing
    const tempAuthSasA = waitEvent(a, 'secure-sas', (info) => info.authRequested === true);
    const tempAuthSasB = waitEvent(b, 'secure-sas', (info) => info.authRequested === true);
    const tempAuthResult = a.secure.start(bob.key);
    assert.equal(tempAuthResult.status, 'active');
    assert.equal(tempAuthResult.temporary, true);
    const [tempSasA, tempSasB] = await Promise.all([tempAuthSasA, tempAuthSasB]);
    const tempAuthA = waitEvent(a, 'secure-authenticated');
    const tempAuthB = waitEvent(b, 'secure-authenticated');
    assert.equal(a.secure.confirm(tempSasA.sessionId), true);
    assert.equal(b.secure.confirm(tempSasB.sessionId), true);
    await Promise.all([tempAuthA, tempAuthB]);
    assert.ok(storeA.get(bob.key), '显式认证后应保存 pairing');
    assert.ok(storeB.get(alice.key), '双方显式认证后都应保存 pairing');
    assert.equal(a.secure.getSession(bob.key).temporary, false);
    console.log('✓ 临时会话可选升级为持久认证会话');

    // A 解除认证后，B 再发送消息不能反复触发“请重新认证”提示。
    const revokeWarningsB = [];
    b.on('secure-warning', (info) => revokeWarningsB.push(info));
    const revokedAgainAtB = waitEvent(b, 'secure-down', (info) => info.reason === '对方已解除认证');
    assert.equal(await a.secure.revokePairing(bob.key), true);
    await revokedAgainAtB;
    revokeWarningsB.length = 0;
    await assert.rejects(b.sendText(alice.key, 'after revoke'), /重新认证/);
    await sleep(1200);
    assert.equal(revokeWarningsB.length, 0, '解除认证后再次发送不应循环产生认证警告');
    assert.equal(b.secure.autoPaused.has(alice.key), true);
    assert.equal(a.secure.hasPairing(bob.key), false);
    assert.equal(b.secure.hasPairing(alice.key), true, '对方解除认证后本机配对仍保留，等待手动重新认证');

    // B 选择只解除本机认证后，可以回到未认证状态继续通信。
    assert.equal(b.secure.resetPairing(alice.key), true);
    assert.equal(b.secure.hasPairing(alice.key), false);
    assert.equal(b.secure.autoPaused.has(alice.key), false);
    const localRevokeTempA = waitEvent(a, 'secure-up', (info) => info.temporary === true);
    const localRevokeTempB = waitEvent(b, 'secure-up', (info) => info.temporary === true);
    const localRevokeMessage = waitEvent(a, 'message', (message) => message.text === 'after local revoke');
    await b.sendText(alice.key, 'after local revoke');
    await Promise.all([localRevokeTempA, localRevokeTempB, localRevokeMessage]);
    assert.equal(a.secure.hasPairing(bob.key), false);
    assert.equal(b.secure.hasPairing(alice.key), false);
    assert.equal(a.secure.isActive(bob.key), true);
    assert.equal(b.secure.isActive(alice.key), true);
    console.log('✓ 解除认证后发送消息不会循环提示；可仅解除本机认证后重新通信');

    console.log('\n加密测试全部通过 ✅');
  } finally {
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\n加密测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
