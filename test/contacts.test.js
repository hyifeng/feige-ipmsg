'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ContactsStore, cleanAlias } = require('../src/main/contacts');
const { createIdentity, peerKeyOf } = require('../src/shared/protocol');

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-contacts-'));
  const alice = createIdentity();
  const bob = createIdentity();
  const store = new ContactsStore(root);

  assert.equal(store.aliasFor(alice.id), '');
  assert.equal(store.displayFor(alice.id, '').unnamed, true);
  assert.equal(store.displayFor(alice.id, '').label, '未认证设备');
  assert.equal(store.displayFor(alice.id, '自称').unnamed, false);
  assert.equal(store.displayFor(alice.id, '自称').label, '自称');
  assert.equal(store.displayFor(alice.id, '自称').claimed, '自称');

  store.setAlias(alice.id, '  张三\u200b  ');
  assert.equal(store.aliasFor(alice.id), '张三');
  assert.equal(store.aliasForPeerKey(peerKeyOf(alice.id)), '张三');
  assert.equal(store.displayFor(alice.id, 'Alice').unnamed, false);
  assert.equal(store.displayFor(alice.id, 'Alice').label, '张三');

  // 同名不同 key 必须保留为两条独立记录
  store.setAlias(bob.id, '张三');
  assert.equal(store.list().length, 2);
  assert.equal(store.aliasFor(alice.id), '张三');
  assert.equal(store.aliasFor(bob.id), '张三');

  // 重新加载
  const reloaded = new ContactsStore(root);
  assert.equal(reloaded.aliasFor(alice.id), '张三');
  assert.equal(reloaded.aliasFor(bob.id), '张三');
  assert.equal(fs.statSync(path.join(root, 'contacts.json')).mode & 0o777, 0o600);

  reloaded.remove(alice.id);
  assert.equal(reloaded.aliasFor(alice.id), '');
  assert.equal(reloaded.aliasFor(bob.id), '张三');

  assert.equal(cleanAlias('正常\n名字'), '正常 名字');
  assert.throws(() => store.setAlias('not-an-identity', 'x'), /无效/);

  await fsp.rm(root, { recursive: true, force: true });
  console.log('联系人簿测试通过 ✅');
}

main().catch((error) => {
  console.error('联系人簿测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
