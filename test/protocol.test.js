'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  APP_TAG,
  PROTOCOL_VERSION,
  CMD,
  OPT,
  encodePacket,
  parsePacket,
  encodeBody,
  decodeBody,
  makeCommand,
  isExtensionEnvelope,
  isEntryExtension,
  isFileEntry,
  isFileOfferData,
  createIdentity,
  signPayload,
  verifyPayload,
} = require('../src/shared/protocol');

function expectNoThrow(fn) {
  assert.doesNotThrow(fn);
}

// 1. 当前信封与扩展段
const identity = createIdentity();
const entryBase = {
  app: APP_TAG,
  v: PROTOCOL_VERSION,
  kind: 'entry',
  id: identity.id,
  instance: 'i',
  user: '张三',
  host: 'pc-1',
  port: 24250,
  online: true,
  addrs: ['127.0.0.1'],
  ts: Date.now(),
  nonce: 'nonce-00000001',
};
const entry = { ...entryBase, sig: signPayload(identity.privateKey, entryBase) };
const packet = encodePacket({
  packetNo: 42,
  user: '张三:测试',
  host: 'pc-1',
  command: makeCommand(CMD.BR_ENTRY, 0),
  message: encodeBody('', entry),
});
const parsed = parsePacket(Buffer.from(packet));
assert.equal(parsed.packetNo, 42);
assert.equal(parsed.user, '张三 测试');
assert.equal(parsed.base, CMD.BR_ENTRY);
const body = decodeBody(parsed.message);
assert.equal(body.ext.app, APP_TAG);
assert.equal(isEntryExtension(body.ext), true);

// 2. 严格版本
assert.equal(parsePacket(Buffer.from(packet.replace(new RegExp(`^${PROTOCOL_VERSION}:`), '3:'))), null);
assert.equal(parsePacket('1:not-a-number:u:h:1:x'), null);
assert.equal(parsePacket(null), null);

// 3. 损坏扩展段 / 超长字段 / 超长扩展都不抛异常
assert.deepEqual(decodeBody('hello\0{broken'), { text: 'hello', ext: null });
assert.deepEqual(decodeBody('hello\0[]'), { text: 'hello', ext: null });
const oversizedExt = 'x'.repeat(49 * 1024);
assert.equal(decodeBody(`hello\0${oversizedExt}`).ext, null);
assert.equal(parsePacket(Buffer.alloc(70000, 0x31)), null);
expectNoThrow(() => parsePacket(crypto.randomBytes(1024)));
expectNoThrow(() => decodeBody(crypto.randomBytes(4096).toString('utf8')));

// 4. 当前文件条目 / 报价字段验证
const file = { id: 'f1', name: 'a.txt', relPath: 'a.txt', size: 1, dir: false, mtime: 1 };
assert.equal(isFileEntry(file), true);
assert.equal(isFileEntry({ ...file, id: '' }), false);
assert.equal(isFileEntry({ ...file, relPath: '' }), false);
const offerBase = {
  app: APP_TAG,
  v: PROTOCOL_VERSION,
  kind: 'files',
  id: identity.id,
  instance: 'i',
  user: '张三',
  host: 'pc-1',
  port: 24250,
  recipient: createIdentity().id,
  msgId: 'msg-1',
  seq: 1,
  ts: Date.now(),
  nonce: 'nonce-00000002',
  transferId: 't1',
  manifest: false,
  totalFiles: 1,
  totalDirs: 0,
  totalEntries: 1,
  totalBytes: 1,
  rootName: 'a.txt',
  isFolder: false,
  image: false,
  files: [file],
  at: Date.now(),
};
const offer = { ...offerBase, sig: signPayload(identity.privateKey, { ...offerBase, text: '' }) };
assert.equal(isExtensionEnvelope(offer), true);
assert.equal(isFileOfferData(offer), true);
assert.equal(isFileOfferData({ ...offer, transferId: '' }), false);
const offerPayload = (() => {
  const { sig, ...rest } = offer;
  return { ...rest, text: '' };
})();
assert.equal(verifyPayload(offer.id, offerPayload, offer.sig), true);
assert.equal(verifyPayload(offer.id, { ...offerPayload, totalBytes: 999 }, offer.sig), false);

// 5. UDP 损坏包进入节点入口也不应影响节点状态
const { FeigeNode } = require('../src/main/network');
const node = new FeigeNode({ port: 25361, discoveryPort: 25360, identityKey: createIdentity() });
const rinfo = { address: '203.0.113.9', port: 25361 };
const before = node.peers.size;
for (let i = 0; i < 50; i += 1) {
  expectNoThrow(() => node._onUdp(crypto.randomBytes(64 + i), rinfo));
}
expectNoThrow(() => node._onUdp(Buffer.from(packet.replace(new RegExp(`^${PROTOCOL_VERSION}:`), '3:')), rinfo));
assert.equal(node.peers.size, before);

console.log('协议健壮性 / 严格校验测试通过 ✅');
