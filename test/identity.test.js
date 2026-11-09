'use strict';

const assert = require('node:assert');

const {
  APP_TAG,
  PROTOCOL_VERSION,
  CMD,
  OPT,
  createIdentity,
  signPayload,
  verifyPayload,
  isIdentity,
  canonicalize,
  shortIdentity,
  encodePacket,
  encodeBody,
  makeCommand,
} = require('../src/shared/protocol');
const { ReplayGuard } = require('../src/main/network/replay');
const { FeigeNode } = require('../src/main/network');

function unsigned(ext) {
  const { sig, ...rest } = ext;
  return rest;
}

function buildEntry(identity, { online = true, addrs = ['203.0.113.9'], nonce = 'entry-nonce-1', ts = Date.now() } = {}) {
  const base = {
    app: APP_TAG,
    v: PROTOCOL_VERSION,
    kind: 'entry',
    id: identity.id,
    instance: 'instance-1',
    user: 'Alice',
    host: 'host-a',
    port: 24250,
    online,
    addrs,
    ts,
    nonce,
  };
  return { ...base, sig: signPayload(identity.privateKey, base) };
}

function buildText(identity, { recipient, msgId = 'm1', text = 'hi', ts = Date.now(), nonce = 'msg-nonce-1' } = {}) {
  const base = {
    app: APP_TAG,
    v: PROTOCOL_VERSION,
    kind: 'text',
    id: identity.id,
    instance: 'instance-1',
    user: 'Alice',
    host: 'host-a',
    port: 24250,
    recipient: recipient.id,
    msgId,
    seq: 1,
    ts,
    nonce,
  };
  return { ...base, sig: signPayload(identity.privateKey, { ...base, text }) };
}

function sendTo(node, ext, from, text = '') {
  const packet = encodePacket({
    packetNo: 1,
    user: 'attacker',
    host: 'attacker',
    command: makeCommand(CMD.SENDMSG, OPT.SENDCHECK),
    message: encodeBody(text, ext),
  });
  node._onUdp(Buffer.from(packet), { address: from, port: 24250 });
}

function sendEntry(node, ext, from) {
  const packet = encodePacket({
    packetNo: 1,
    user: 'attacker',
    host: 'attacker',
    command: makeCommand(CMD.BR_ENTRY, 0),
    message: encodeBody('', ext),
  });
  node._onUdp(Buffer.from(packet), { address: from, port: 24250 });
}

async function main() {
  const alice = createIdentity();
  const bob = createIdentity();
  const attacker = createIdentity();

  assert.equal(alice.id.startsWith('pk1_'), true);
  assert.equal(alice.id.length, 56);
  assert.equal(isIdentity(alice.id), true);
  assert.equal(isIdentity('pk1_' + 'A'.repeat(52)), false);
  assert.equal(shortIdentity(alice.id).split('-').length, 3);
  console.log('✓ 自证身份格式 / 指纹');

  // 规范化与签名
  const p1 = { b: 1, a: { d: 2, c: 3 } };
  const p2 = { a: { c: 3, d: 2 }, b: 1 };
  assert.equal(canonicalize(p1), canonicalize(p2));
  const sig = signPayload(alice.privateKey, p1);
  assert.equal(verifyPayload(alice.id, p2, sig), true);
  assert.equal(verifyPayload(alice.id, { ...p1, b: 9 }, sig), false);
  console.log('✓ 规范化签名 / 篡改检测');

  // 用攻击者私钥伪造 Alice 的身份
  const forged = buildText(alice, { recipient: bob });
  forged.sig = signPayload(attacker.privateKey, { ...unsigned(forged), text: 'hi' });
  assert.equal(verifyPayload(forged.id, { ...unsigned(forged), text: 'hi' }, forged.sig), false);
  console.log('✓ 无法用他人身份伪造签名');

  // 消息签名覆盖收件人；换收件人即失效
  const message = buildText(alice, { recipient: bob });
  assert.equal(verifyPayload(alice.id, { ...unsigned(message), text: 'hi' }, message.sig), true);
  assert.equal(
    verifyPayload(alice.id, { ...unsigned({ ...message, recipient: attacker.id }), text: 'hi' }, message.sig),
    false,
  );
  console.log('✓ 签名绑定收件人');

  // 防重放
  const guard = new ReplayGuard();
  const now = Date.now();
  assert.equal(guard.checkMessage(alice.id, 'm1', now), true);
  assert.equal(guard.checkMessage(alice.id, 'm1', now), false);
  assert.equal(guard.checkMessage(alice.id, 'm2', now - 10 * 60 * 1000), false);
  assert.equal(guard.checkNonce(alice.id, 'n1', now), true);
  assert.equal(guard.checkNonce(alice.id, 'n1', now), false);
  console.log('✓ 重放窗口 / 过期时间戳');

  // 节点入口：伪造身份的报文不应进入联系人/消息
  const victim = new FeigeNode({
    port: 25401,
    discoveryPort: 25400,
    user: 'Bob',
    host: 'host-b',
    identityKey: bob,
    downloadDir: '/tmp/feige-identity-test',
  });
  const received = [];
  victim.on('message', (item) => received.push(item));

  sendEntry(victim, buildEntry(alice), '203.0.113.9');
  assert.equal(victim.peers.has(`id:${alice.id}`), true);
  console.log('✓ 合法广播可被发现');

  const impersonatedEntry = buildEntry(alice, { nonce: 'entry-nonce-2' });
  impersonatedEntry.sig = signPayload(attacker.privateKey, unsigned(impersonatedEntry));
  sendEntry(victim, impersonatedEntry, '203.0.113.10');
  assert.equal(victim.peers.get(`id:${alice.id}`).ip, '203.0.113.9');
  console.log('✓ 伪造广播无法替换联系人地址');

  const forgedMessage = buildText(alice, { recipient: bob, msgId: 'forged-1' });
  forgedMessage.sig = signPayload(attacker.privateKey, { ...unsigned(forgedMessage), text: 'hi' });
  sendTo(victim, forgedMessage, '203.0.113.10', 'hi');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(received.length, 0);
  console.log('✓ 伪造消息被丢弃');

  // 即使签名完全合法，明文 SENDMSG 也不再被接受；所有聊天内容
  // 必须通过加密会话传输。
  const validMessage = buildText(alice, { recipient: bob, msgId: 'valid-1', nonce: 'msg-nonce-2' });
  sendTo(victim, validMessage, '203.0.113.9', 'hi');
  sendTo(victim, validMessage, '203.0.113.9', 'hi');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(received.length, 0);
  console.log('✓ 合法签名的明文消息也不进入会话');

  await victim.stop().catch(() => {});
  console.log('\n身份签名测试全部通过 ✅');
}

main().catch((error) => {
  console.error('\n身份签名测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
