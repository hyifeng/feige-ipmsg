'use strict';

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { HistoryStore } = require('../src/main/history');

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'feige-history-'));
  const dir = path.join(root, 'history');

  try {
    const store = new HistoryStore(dir);
    await store.init();

    const alice = { key: 'id:alice', user: 'Alice', host: 'host-a', ip: '10.0.0.2', port: 24250 };
    const bob = { key: 'id:bob', user: 'Bob', host: 'host-b', ip: '10.0.0.3', port: 24250 };

    await store.append({
      id: 'a1',
      peerKey: alice.key,
      peerName: alice.user,
      direction: 'out',
      kind: 'text',
      text: 'hello world',
      at: 1000,
      status: 'sent',
    }, alice);
    await store.patch(alice.key, 'a1', { status: 'read' });
    await store.append({
      id: 'a2',
      peerKey: alice.key,
      peerName: alice.user,
      direction: 'in',
      kind: 'text',
      text: 'ping',
      at: 2000,
    }, alice);
    await store.append({
      id: 'f1',
      peerKey: alice.key,
      peerName: alice.user,
      direction: 'in',
      kind: 'files',
      text: 'files here',
      files: [{ id: 'f', name: 'report.pdf', relPath: '报告/report.pdf', size: 1234, dir: false }],
      totalBytes: 1234,
      totalFiles: 1,
      totalDirs: 0,
      totalEntries: 1,
      rootName: '报告',
      isFolder: true,
      transferId: 't1',
      offerId: 't1',
      at: 3000,
      fileState: {
        status: 'pending',
        doneBytes: 0,
        totalBytes: 1234,
        completedFiles: 0,
        totalFiles: 1,
      },
    }, alice);
    await store.patch(alice.key, 'f1', {
      fileState: { status: 'done', doneBytes: 1234, root: '/tmp/received/报告' },
    });

    // patch 在消息之前到达也必须能生效
    await store.append({
      id: 'img1',
      peerKey: alice.key,
      peerName: alice.user,
      direction: 'in',
      kind: 'image',
      text: 'caption',
      name: 'photo.png',
      size: 2048,
      thumb: 'data:image/png;base64,AAAA',
      localPath: '/tmp/photo.png',
      transferId: 't2',
      at: 3500,
      imageState: { status: 'waiting', doneBytes: 0, totalBytes: 2048, totalFiles: 1 },
    }, alice);
    await store.patch(alice.key, 'img1', {
      imageState: { status: 'done', doneBytes: 2048 },
      localPath: '/tmp/photo.png',
    });

    await store.patch(bob.key, 'b1', { status: 'read' });
    await store.append({
      id: 'b1',
      peerKey: bob.key,
      peerName: bob.user,
      direction: 'out',
      kind: 'text',
      text: 'early patch',
      at: 4000,
    }, bob);

    const contacts = await store.contacts();
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].key, bob.key);
    assert.equal(contacts.find((item) => item.key === alice.key).count, 4);
    assert.ok(contacts.find((item) => item.key === alice.key).lastText.includes('photo.png'));

    const all = await store.loadMessages(alice.key);
    assert.deepEqual(all.messages.map((message) => message.id), ['a1', 'a2', 'f1', 'img1']);
    const allWithNullBefore = await store.loadMessages(alice.key, { before: null });
    assert.deepEqual(allWithNullBefore.messages.map((message) => message.id), ['a1', 'a2', 'f1', 'img1']);
    assert.equal(all.messages[0].status, 'read');
    assert.equal(all.messages[2].fileState.status, 'done');
    assert.equal(all.messages[2].fileState.root, '/tmp/received/报告');
    assert.equal(all.messages[3].kind, 'image');
    assert.equal(all.messages[3].thumb, 'data:image/png;base64,AAAA');
    assert.equal(all.messages[3].imageState.status, 'done');

    const page = await store.loadMessages(alice.key, { limit: 2 });
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.messages.map((message) => message.id), ['f1', 'img1']);

    const older = await store.loadMessages(alice.key, { limit: 10, before: 2000 });
    assert.deepEqual(older.messages.map((message) => message.id), ['a1']);

    const bobMessages = await store.loadMessages(bob.key);
    assert.equal(bobMessages.messages[0].status, 'read');

    const search = await store.search('world');
    assert.equal(search.length, 1);
    assert.equal(search[0].id, 'a1');
    assert.equal(search[0].peer.user, 'Alice');

    const reportSearch = await store.search('report.pdf');
    assert.equal(reportSearch.length, 1);
    assert.equal(reportSearch[0].id, 'f1');
    const imageSearch = await store.search('photo.png');
    assert.equal(imageSearch.length, 1);
    assert.equal(imageSearch[0].id, 'img1');

    // 重新打开，验证索引和会话文件已落盘
    const reopened = new HistoryStore(dir);
    await reopened.init();
    const reopenedContacts = await reopened.contacts();
    assert.equal(reopenedContacts.length, 2);
    assert.equal((await reopened.loadMessages(alice.key)).messages.length, 4);

    await reopened.clearAll();
    assert.equal((await reopened.contacts()).length, 0);
    assert.equal((await reopened.loadMessages(alice.key)).messages.length, 0);

    console.log('✓ 聊天记录持久化 / 分页 / 搜索 / 清空');
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('历史记录测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
