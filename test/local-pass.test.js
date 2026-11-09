'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createIdentity, exportPrivateKey, DEFAULT_PORT } = require('../src/shared/protocol');
const { LocalPass, validatePass } = require('../src/main/security/local-pass');
const { AAD, isEnvelope, encryptJson } = require('../src/main/security/local-crypto');
const { AutoUnlockStore } = require('../src/main/security/auto-unlock');
const { loadOrCreateIdentity } = require('../src/main/app/identity');
const { defaultSettings, loadSettings, saveSettings } = require('../src/main/app/settings');
const { ContactsStore } = require('../src/main/contacts');
const { HistoryStore } = require('../src/main/history');
const { SecurePairingStore } = require('../src/main/secure/pairing-store');

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'new correct horse battery';
const ALIAS = '机密别名';
const SECRET = '这是一条不应出现在磁盘上的聊天内容';

function assertEncryptedFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(isEnvelope(parsed), true, `${path.basename(file)} 应为加密信封`);
  assert.equal(text.includes(ALIAS), false);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(PASSWORD), false);
  return parsed;
}

async function testLocalPass(root) {
  const account = new LocalPass(root);
  assert.equal(account.isConfigured(), false);
  assert.equal(validatePass('12345').ok, false);
  assert.throws(() => account.setup('12345'), /至少/);

  const key = account.setup(PASSWORD);
  assert.equal(key.length, 32);
  assert.equal(account.isConfigured(), true);
  assert.equal(account.isUnlocked(), true);
  assert.equal(account.getKey().equals(key), true);

  const passFile = path.join(root, 'local-pass.json');
  const meta = JSON.parse(fs.readFileSync(passFile, 'utf8'));
  assert.equal(meta.v, 2);
  assert.equal(meta.kdf.name, 'scrypt');
  assert.equal(isEnvelope(meta.wrap), true);
  assert.equal(isEnvelope(meta.keyCheck), true);
  assert.equal(meta.check, undefined);
  assert.equal(fs.statSync(passFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(passFile, 'utf8').includes(PASSWORD), false);

  account.lock();
  assert.equal(account.isUnlocked(), false);
  assert.equal(account.unlock('wrong password'), false);
  assert.equal(account.isUnlocked(), false);
  assert.equal(account.unlock(PASSWORD), true);

  const reopened = new LocalPass(root);
  assert.equal(reopened.isConfigured(), true);
  assert.equal(reopened.unlock('wrong password'), false);
  assert.equal(reopened.unlock(PASSWORD), true);
  assert.equal(reopened.getKey().equals(key), true);

  // safeStorage 免密路径：直接用 DEK 解锁，不执行 scrypt
  const byKey = new LocalPass(root);
  assert.equal(byKey.unlockWithKey(crypto.randomBytes(32)), false);
  assert.equal(byKey.unlockWithKey(key), true);
  assert.equal(byKey.getKey().equals(key), true);

  // 修改密码只重新包裹 DEK，DEK 本身不变
  assert.throws(() => reopened.changePass(PASSWORD, '123'), /至少/);
  assert.equal(reopened.changePass('wrong password', NEW_PASSWORD), false);
  assert.equal(reopened.changePass(PASSWORD, NEW_PASSWORD), true);
  assert.equal(reopened.getKey().equals(key), true);
  reopened.lock();
  assert.equal(reopened.unlock(PASSWORD), false);
  assert.equal(reopened.unlock(NEW_PASSWORD), true);
  assert.equal(reopened.getKey().equals(key), true);
  return Buffer.from(reopened.getKey());
}

function testV1Migration(root) {
  const dir = path.join(root, 'local-pass-v1');
  fs.mkdirSync(dir, { recursive: true });
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(PASSWORD, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const check = encryptJson(key, { magic: 'feige-local-pass-v1' }, AAD.LOCAL_PASS);
  fs.writeFileSync(path.join(dir, 'local-pass.json'), JSON.stringify({
    v: 1,
    kdf: {
      name: 'scrypt', N: 1 << 15, r: 8, p: 1, keylen: 32,
      salt: salt.toString('base64'),
    },
    check,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }), { mode: 0o600 });

  const legacy = new LocalPass(dir);
  assert.equal(legacy.unlock(PASSWORD), true);
  assert.equal(legacy.getKey().equals(key), true);
  const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'local-pass.json'), 'utf8'));
  assert.equal(migrated.v, 2);
  assert.equal(isEnvelope(migrated.wrap), true);
  assert.equal(isEnvelope(migrated.keyCheck), true);

  const reopened = new LocalPass(dir);
  assert.equal(reopened.unlock(PASSWORD), true);
  assert.equal(reopened.getKey().equals(key), true);

  // v1 升级后仍可修改密码，数据密钥不变
  assert.equal(reopened.changePass(PASSWORD, NEW_PASSWORD), true);
  reopened.lock();
  assert.equal(reopened.unlock(PASSWORD), false);
  assert.equal(reopened.unlock(NEW_PASSWORD), true);
  assert.equal(reopened.getKey().equals(key), true);
}

class FakeSafeStorage {
  constructor(backend = 'gnome_libsecret') {
    this.backend = backend;
  }

  async isAsyncEncryptionAvailable() {
    return true;
  }

  getSelectedStorageBackend() {
    return this.backend;
  }

  async encryptStringAsync(text) {
    return Buffer.from(`safe:${text}`, 'utf8');
  }

  async decryptStringAsync(buffer) {
    const text = buffer.toString('utf8');
    if (!text.startsWith('safe:')) throw new Error('bad token');
    return { result: text.slice(5) };
  }
}

async function testAutoUnlock(root) {
  const key = crypto.randomBytes(32);
  const dir = path.join(root, 'auto-unlock');
  const store = new AutoUnlockStore(dir, { safeStorage: new FakeSafeStorage() });
  assert.equal(await store.isAvailable(), true);
  assert.equal(store.hasToken(), false);
  assert.equal(store.preferenceEnabled(), true);

  const saved = await store.save(key);
  assert.equal(saved.ok, true);
  assert.equal(store.hasToken(), true);
  const file = path.join(dir, 'auto-unlock.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes(key.toString('base64')), false);

  const loaded = await store.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.key.equals(key), true);
  loaded.key.fill(0);

  assert.equal(store.clear(), true);
  assert.equal(store.hasToken(), false);
  assert.equal(store.preferenceEnabled(), true);

  const enabledAgain = await store.save(key);
  assert.equal(enabledAgain.ok, true);
  assert.equal(store.disable(), true);
  assert.equal(store.hasToken(), false);
  assert.equal(store.preferenceEnabled(), false);
  assert.equal(fs.statSync(path.join(dir, 'auto-unlock-pref.json')).mode & 0o777, 0o600);

  const insecure = new AutoUnlockStore(path.join(root, 'auto-unlock-insecure'), {
    safeStorage: new FakeSafeStorage('basic_text'),
  });
  assert.equal(await insecure.isAvailable(), false);
  const rejected = await insecure.save(key);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'unavailable');
  assert.equal(insecure.hasToken(), false);
}

function testSettings(root, key) {
  const app = {
    getPath: (name) => (name === 'downloads' ? path.join(root, 'Downloads') : root),
  };
  const identity = createIdentity();
  const ctx = {
    app,
    identity,
    demo: false,
    settingsPath: path.join(root, 'settings.json'),
    localKey: null,
    settings: null,
  };
  assert.equal(defaultSettings(ctx).port, DEFAULT_PORT);
  ctx.settings = { ...defaultSettings(ctx), nickname: ALIAS };
  ctx.localKey = key;
  saveSettings(ctx);
  assertEncryptedFile(ctx.settingsPath);
  assert.equal(loadSettings(ctx).nickname, ALIAS);
  assert.throws(() => loadSettings({ ...ctx, localKey: null }), /加密|密码/);

  // 旧版本明文配置可读取；写入时自动加密
  const legacyPath = path.join(root, 'settings-legacy.json');
  fs.writeFileSync(legacyPath, JSON.stringify({ nickname: '旧昵称', port: 2525 }), 'utf8');
  const legacyCtx = { ...ctx, settingsPath: legacyPath, localKey: null };
  assert.equal(loadSettings(legacyCtx).nickname, '旧昵称');
  legacyCtx.settings = loadSettings(legacyCtx);
  legacyCtx.localKey = ctx.localKey;
  saveSettings(legacyCtx);
  assertEncryptedFile(legacyPath);

  // 旧默认 2425 自动迁移；已经标记过版本的自定义 2425 保持不变
  const oldDefaultPath = path.join(root, 'settings-old-default.json');
  fs.writeFileSync(oldDefaultPath, JSON.stringify({ nickname: '旧默认端口', port: 2425 }), 'utf8');
  const migrated = loadSettings({ ...ctx, settingsPath: oldDefaultPath, localKey: null });
  assert.equal(migrated.port, DEFAULT_PORT);
  assert.equal(migrated.settingsVersion, 1);

  const explicitPath = path.join(root, 'settings-explicit-port.json');
  fs.writeFileSync(explicitPath, JSON.stringify({ nickname: '显式端口', port: 2425, settingsVersion: 1 }), 'utf8');
  const explicit = loadSettings({ ...ctx, settingsPath: explicitPath, localKey: null });
  assert.equal(explicit.port, 2425);
}

function testIdentity(root, key) {
  const dir = path.join(root, 'identity');
  const created = loadOrCreateIdentity(dir, { key });
  const file = path.join(dir, 'identity-key.json');
  assertEncryptedFile(file);
  assert.equal(loadOrCreateIdentity(dir, { key }).id, created.id);
  assert.throws(() => loadOrCreateIdentity(dir), /加密|密码/);
  assert.throws(() => loadOrCreateIdentity(dir, { key: crypto.randomBytes(32) }), /解密/);

  // 旧版本明文身份密钥迁移
  const legacyDir = path.join(root, 'identity-legacy');
  awaitMkdir(legacyDir);
  const legacyIdentity = createIdentity();
  fs.writeFileSync(path.join(legacyDir, 'identity-key.json'), JSON.stringify({
    v: 1,
    id: legacyIdentity.id,
    privateKey: exportPrivateKey(legacyIdentity.privateKey),
  }), { mode: 0o600 });
  const migrated = loadOrCreateIdentity(legacyDir, { key });
  assert.equal(migrated.id, legacyIdentity.id);
  assertEncryptedFile(path.join(legacyDir, 'identity-key.json'));
}

function testContacts(root, key) {
  const identity = createIdentity();
  const contactsDir = path.join(root, 'contacts');
  const store = new ContactsStore(contactsDir, { key });
  store.setAlias(identity.id, ALIAS);
  assertEncryptedFile(path.join(contactsDir, 'contacts.json'));

  const reloaded = new ContactsStore(contactsDir, { key });
  assert.equal(reloaded.aliasFor(identity.id), ALIAS);
  assert.throws(() => new ContactsStore(contactsDir, { key: crypto.randomBytes(32) }), /解密/);

  // 旧版本明文联系人迁移
  const legacyDir = path.join(root, 'contacts-legacy');
  const legacy = new ContactsStore(legacyDir);
  legacy.setAlias(identity.id, ALIAS);
  assert.equal(fs.readFileSync(path.join(legacyDir, 'contacts.json'), 'utf8').includes(ALIAS), true);
  const migrated = new ContactsStore(legacyDir, { key });
  assert.equal(migrated.aliasFor(identity.id), ALIAS);
  assertEncryptedFile(path.join(legacyDir, 'contacts.json'));
}

async function testHistory(root, key) {
  const dir = path.join(root, 'history');
  const peer = { key: 'id:alice', user: 'Alice', host: 'a', ip: '10.0.0.2', port: 24250 };
  const store = new HistoryStore(dir, { key });
  await store.init();
  await store.append({
    id: 'm1',
    peerKey: peer.key,
    peerName: peer.user,
    direction: 'in',
    kind: 'text',
    text: SECRET,
    at: 1000,
  }, peer);

  const peerFile = path.join(dir, 'alice.jsonl');
  const peerText = fs.readFileSync(peerFile, 'utf8');
  assert.equal(peerText.includes(SECRET), false);
  for (const line of peerText.trim().split('\n')) {
    assert.equal(isEnvelope(JSON.parse(line)), true);
  }
  const indexText = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  assert.equal(indexText.includes(SECRET), false);
  assert.equal(indexText.includes('Alice'), false);
  assert.equal(isEnvelope(JSON.parse(indexText)), true);

  const reopened = new HistoryStore(dir, { key });
  await reopened.init();
  const loaded = await reopened.loadMessages(peer.key);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].text, SECRET);
  assert.equal((await reopened.search('磁盘')).length, 1);
  await assert.rejects(async () => {
    const locked = new HistoryStore(dir);
    await locked.init();
  }, /加密|密码/);

  // 旧版本明文聊天记录 / 索引迁移
  const legacyDir = path.join(root, 'history-legacy');
  const legacy = new HistoryStore(legacyDir);
  await legacy.init();
  await legacy.append({
    id: 'old1',
    peerKey: peer.key,
    peerName: peer.user,
    direction: 'out',
    kind: 'text',
    text: SECRET,
    at: 2000,
  }, peer);
  assert.equal(fs.readFileSync(path.join(legacyDir, 'alice.jsonl'), 'utf8').includes(SECRET), true);

  const migrated = new HistoryStore(legacyDir, { key });
  await migrated.init();
  assert.equal(fs.readFileSync(path.join(legacyDir, 'alice.jsonl'), 'utf8').includes(SECRET), false);
  assert.equal(fs.readFileSync(path.join(legacyDir, 'index.json'), 'utf8').includes(SECRET), false);
  assert.equal((await migrated.loadMessages(peer.key)).messages[0].text, SECRET);
}

function testPairings(root, key) {
  const pairingKey = crypto.randomBytes(32);
  const dir = path.join(root, 'pairings');
  const store = new SecurePairingStore(dir, { key });
  store.set('id:alice', { key: pairingKey, user: ALIAS });
  assertEncryptedFile(path.join(dir, 'secure-pairings.json'));

  const reloaded = new SecurePairingStore(dir, { key });
  assert.equal(reloaded.get('id:alice').key.equals(pairingKey), true);
  assert.throws(() => new SecurePairingStore(dir, { key: crypto.randomBytes(32) }), /解密/);
}

function awaitMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-local-pass-'));
  try {
    const key = await testLocalPass(path.join(root, 'pass'));
    testV1Migration(root);
    await testAutoUnlock(root);

    // 复用本地密码派生的同一把密钥验证各存储的加密 / 迁移
    const settingsRoot = path.join(root, 'settings');
    awaitMkdir(settingsRoot);
    testSettings(settingsRoot, key);
    testIdentity(root, key);
    testContacts(root, key);
    await testHistory(root, key);
    testPairings(root, key);

    assert.equal(key.length, 32);
    console.log('✓ 本地密码设置 / 解锁 / 错误密码拒绝');
    console.log('✓ DEK + KEK 信封结构 / 修改密码不更换数据密钥');
    console.log('✓ v1 本地密码配置自动升级到 v2');
    console.log('✓ safeStorage 免密令牌 / basic_text 后端拒绝启用');
    console.log('✓ 设置、身份、联系人、聊天记录、加密配对均已加密落盘');
    console.log('✓ 旧版本明文资料自动迁移');
    console.log('本地密码测试通过 ✅');
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('本地密码测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
