'use strict';

/**
 * 发现来源 / 传输层可替换性测试。
 *
 * 不启动真实 UDP/TCP，只验证 NodeCore 是否只依赖抽象接口。
 */

const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { FeigeNode, PeerRegistry } = require('../src/main/network');
const { CompositeTransport } = require('../src/main/network/transport');
const { createIdentity } = require('../src/shared/protocol');

class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.started = false;
    this.controls = [];
    this.networkChanges = 0;
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  sendControl(peerKey, packet) {
    this.controls.push({ peerKey, packet });
    return true;
  }

  connectStream() {
    throw new Error('测试不建立真实流');
  }

  networkChanged() {
    this.networkChanges += 1;
  }
}

class FakeDiscovery extends EventEmitter {
  constructor() {
    super();
    this.started = false;
    this.online = true;
    this.networkChanges = 0;
    this.refreshes = 0;
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  setOnline(online) {
    this.online = !!online;
  }

  refresh() {
    this.refreshes += 1;
  }

  networkChanged() {
    this.networkChanges += 1;
  }

  heartbeat() {}

  announceTo() {}

  handleDatagram() {
    return false;
  }
}

async function main() {
  // 1. 多发现来源按 identity 合并
  const registry = new PeerRegistry({ sourceTimeouts: { lan: 1000, hub: 2000 } });
  const key = 'id:test-peer';
  let result = registry.upsert('lan', {
    key,
    ip: '192.168.1.10',
    port: 24250,
    user: 'Alice',
    host: 'pc-a',
    online: true,
  });
  assert.equal(result.peer.online, true);
  assert.equal(result.peer.ip, '192.168.1.10');

  result = registry.upsert('hub', {
    key,
    user: 'Alice',
    host: 'pc-a',
    online: true,
  });
  assert.equal(result.peer.online, true);
  assert.equal(result.peer.ip, '192.168.1.10', 'hub 来源不能覆盖 LAN 端点');
  assert.deepEqual(Object.keys(result.peer.sources).sort(), ['hub', 'lan']);

  result = registry.markSourceOffline(key, 'lan');
  assert.equal(result.peer.online, true, 'LAN 离线但 hub 在线时仍在线');
  result = registry.markSourceOffline(key, 'hub');
  assert.equal(result.offline, true, '所有来源离线才真正离线');
  assert.equal(result.peer.online, false);
  console.log('✓ 多发现来源合并 / 端点隔离 / 离线判定');

  // 1.1 实际路径健康：LAN 数据通道失败后立刻切到 Direct，不等发现超时
  const pathRegistry = new PeerRegistry({ sourceTimeouts: { lan: 1000, hub: 30000, direct: 30000 } });
  const pathKey = 'id:path-peer';
  pathRegistry.upsert('lan', {
    key: pathKey,
    ip: '192.168.1.20',
    port: 24250,
    user: 'Bob',
    host: 'pc-b',
    online: true,
  });
  pathRegistry.upsert('hub', { key: pathKey, user: 'Bob', host: 'pc-b', online: true });

  let lanSends = 0;
  let directSends = 0;
  const fakeLan = {
    sendControl() { lanSends += 1; return true; },
    connectStream() { throw new Error('not used'); },
  };
  const fakeDirect = {
    hasPeer() { return true; },
    sendControl() { directSends += 1; return true; },
    connectStream() { throw new Error('not used'); },
  };
  const composite = new CompositeTransport({
    getPeer: (peerKey) => pathRegistry.get(peerKey),
    lan: fakeLan,
    direct: fakeDirect,
  });
  const pathEvents = [];
  composite.on('path', (info) => pathEvents.push(info.path));

  composite.sendControl(pathKey, Buffer.from('a'));
  assert.equal(lanSends, 1, 'LAN 来源在线时优先 LAN');
  assert.equal(composite.activePath(pathKey), 'lan');

  composite.markPathUnhealthy(pathKey, 'lan');
  assert.equal(composite.activePath(pathKey), 'direct', 'LAN 实际链路失败后应立即切 Direct');
  composite.sendControl(pathKey, Buffer.from('b'));
  assert.equal(directSends, 1, 'LAN 健康失败后控制包应走 Direct');
  assert.ok(pathEvents.includes('direct'), '路径变化应通知上层更新 UI');

  pathRegistry.setPath(pathKey, 'direct');
  assert.equal(pathRegistry.list().find((peer) => peer.key === pathKey).path, 'direct', 'UI 路径应使用实际承载路径');
  console.log('✓ 路径健康 / LAN->Direct 快速切换 / UI 路径覆盖');

  // 2. NodeCore 可注入自定义发现源和传输层
  const transport = new FakeTransport();
  const discovery = new FakeDiscovery();
  const identity = createIdentity();
  const node = new FeigeNode({
    port: 25901,
    discoveryPort: 25900,
    user: 'Local',
    host: 'local-host',
    identityKey: identity,
    downloadDir: path.join('/tmp', 'feige-transport-test'),
    transport,
    discovery,
  });

  await node.start();
  assert.equal(transport.started, true);
  assert.equal(discovery.started, true);

  const peerKey = `id:${createIdentity().id}`;
  discovery.emit('peer', {
    source: 'hub',
    key: peerKey,
    user: 'Remote',
    host: 'remote-host',
    online: true,
  });
  assert.equal(node.peers.get(peerKey)?.online, true);
  assert.equal(node.peers.get(peerKey)?.user, 'Remote');

  discovery.emit('offline', { source: 'hub', key: peerKey });
  assert.equal(node.peers.get(peerKey)?.online, false);
  assert.equal(node.peers.get(peerKey)?.sources.hub.online, false);

  node._sendControl(peerKey, 'test-packet');
  assert.equal(transport.controls.length, 1);
  assert.equal(transport.controls[0].peerKey, peerKey);

  node.networkChanged();
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(transport.networkChanges, 1, '传输层应收到网络变化通知');
  assert.equal(discovery.networkChanges, 1, '发现层应收到网络变化通知');
  assert.ok(discovery.refreshes >= 1, '网络变化后应重新广播 BR_ENTRY');

  await node.stop();
  assert.equal(transport.started, false);
  assert.equal(discovery.started, false);
  console.log('✓ 发现源 / 传输层可注入，NodeCore 不依赖具体实现');

  console.log('\n传输抽象测试全部通过 ✅');
}

main().catch((error) => {
  console.error('\n传输抽象测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
