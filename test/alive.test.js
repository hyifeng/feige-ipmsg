'use strict';

const assert = require('node:assert');

const {
  APP_TAG,
  PROTOCOL_VERSION,
  CMD,
  createIdentity,
  signPayload,
  encodePacket,
  encodeBody,
} = require('../src/shared/protocol');
const { AliveSession } = require('../src/main/network/discovery/alive');
const { EntryDiscovery } = require('../src/main/network/discovery/entry-discovery');
const { ReplayGuard } = require('../src/main/network/replay');

function makePacket(command, message = '') {
  return {
    packet: encodePacket({
      packetNo: 1,
      user: '-',
      host: '-',
      command,
      message,
    }),
  };
}

async function main() {
  const identity = createIdentity();
  const peerIdentity = createIdentity();
  const alive = new AliveSession();
  const peerAlive = new AliveSession();
  const peerKey = `id:${peerIdentity.id}`;

  // 1. 紧凑 token：8 字节 id + 4 字节 seq + 64 字节签名
  const token = alive.nextToken();
  const parsed = AliveSession.parse(token);
  assert.ok(parsed, 'ALIVE token 必须可解析');
  assert.equal(Buffer.from(token, 'base64url').length, 76);
  assert.equal(AliveSession.verify(parsed, alive.publicKeyToken), true);
  assert.equal(AliveSession.verify(parsed, new AliveSession().publicKeyToken), false);
  assert.equal(AliveSession.parse(token).seq, 1);
  console.log('✓ ALIVE token 结构 / 签名校验');

  const events = [];
  const channelPackets = [];
  const unicastPackets = [];
  const discovery = new EntryDiscovery({
    source: 'hub',
    sources: ['hub'],
    identity: identity.id,
    instanceId: 'alive-test',
    online: true,
    replay: new ReplayGuard(),
    alive,
    makePacket,
    makeAlivePacket: makePacket,
    listPeers: () => [{ key: peerKey, online: true, sources: { hub: { online: true } } }],
    buildProfile: () => ({ app: APP_TAG, v: PROTOCOL_VERSION, kind: 'entry', id: identity.id }),
    channel: {
      broadcast: (packet) => {
        channelPackets.push(packet);
        return true;
      },
      unicast: (packet) => {
        unicastPackets.push(packet);
        return true;
      },
    },
  });
  discovery.on('alive', (info) => events.push(info));

  // 先模拟收到完整 BR_ENTRY，注册 alive 会话
  const base = {
    app: APP_TAG,
    v: PROTOCOL_VERSION,
    kind: 'entry',
    id: peerIdentity.id,
    instance: 'alive-peer',
    user: 'Alive Peer',
    host: 'alive-host',
    port: 24250,
    online: true,
    addrs: ['127.0.0.1'],
    ts: Date.now(),
    nonce: 'alive-entry-nonce',
    ...peerAlive.profileFields(),
  };
  const entry = { ...base, sig: signPayload(peerIdentity.privateKey, base) };
  assert.equal(discovery.handleDatagram(
    Buffer.from(encodePacket({
      packetNo: 2,
      user: 'Alive Peer',
      host: 'alive-host',
      command: CMD.BR_ENTRY,
      message: encodeBody('', entry),
    })),
    { source: 'hub', sender: peerIdentity.id },
  ), true);

  // 2. 心跳必须是 BR_ALIVE，而不是完整 BR_ENTRY
  discovery.started = true;
  discovery.heartbeat();
  const alivePacket = unicastPackets.at(-1);
  const parsedAlivePacket = require('../src/shared/protocol').parsePacket(Buffer.from(alivePacket));
  assert.equal(parsedAlivePacket.base, CMD.BR_ALIVE);
  assert.ok(parsedAlivePacket.message.length <= 110, `ALIVE body 应该很小，实际 ${parsedAlivePacket.message.length}`);
  assert.ok(alivePacket.length <= 160, `ALIVE 总包应该很小，实际 ${alivePacket.length}`);

  // 3. 收到 ALIVE 只刷新 lastSeen，不携带/更新资料
  discovery.handleDatagram(
    Buffer.from(makePacket(CMD.BR_ALIVE, peerAlive.nextToken()).packet),
    { source: 'hub' },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].key, peerKey);

  // 4. 重放同一个 ALIVE 不重复触发
  const replayToken = peerAlive.nextToken();
  discovery.handleDatagram(Buffer.from(makePacket(CMD.BR_ALIVE, replayToken).packet), { source: 'hub' });
  discovery.handleDatagram(Buffer.from(makePacket(CMD.BR_ALIVE, replayToken).packet), { source: 'hub' });
  assert.equal(events.length, 2);

  // 4.1 重复 BR_ENTRY 不能把 same alive session 的 seq 清零
  const baseAgain = {
    ...base,
    ts: Date.now(),
    nonce: 'alive-entry-nonce-2',
  };
  const entryAgain = { ...baseAgain, sig: signPayload(peerIdentity.privateKey, baseAgain) };
  discovery.handleDatagram(
    Buffer.from(encodePacket({
      packetNo: 3,
      user: 'Alive Peer',
      host: 'alive-host',
      command: CMD.BR_ENTRY,
      message: encodeBody('', entryAgain),
    })),
    { source: 'hub', sender: peerIdentity.id },
  );
  discovery.handleDatagram(Buffer.from(makePacket(CMD.BR_ALIVE, replayToken).packet), { source: 'hub' });
  assert.equal(events.length, 2, '重复 BR_ENTRY 后旧 ALIVE 仍然必须被拒绝');
  discovery.handleDatagram(Buffer.from(makePacket(CMD.BR_ALIVE, peerAlive.nextToken()).packet), { source: 'hub' });
  assert.equal(events.length, 3);

  // 5. 手动刷新必须重新发送完整 BR_ENTRY
  discovery.refresh();
  const refreshPacket = require('../src/shared/protocol').parsePacket(Buffer.from(channelPackets.at(-1)));
  assert.equal(refreshPacket.base, CMD.BR_ENTRY);

  // 6. 改名走 BR_UPDATE 单播，不走广播
  const unicastBeforeUpdate = unicastPackets.length;
  const broadcastBeforeUpdate = channelPackets.length;
  discovery.updateProfile();
  assert.equal(channelPackets.length, broadcastBeforeUpdate, '改名不应产生广播');
  assert.equal(unicastPackets.length, unicastBeforeUpdate + 1, '改名应单播给已知 peer');
  const updatePacket = require('../src/shared/protocol').parsePacket(Buffer.from(unicastPackets.at(-1)));
  assert.equal(updatePacket.base, CMD.BR_UPDATE);

  // 收到 BR_UPDATE 只更新资料，不回 ANSENTRY
  const updateBase = {
    ...base,
    ts: Date.now(),
    nonce: 'alive-entry-update-nonce',
    user: 'Alive Peer Renamed',
  };
  const updateEntry = { ...updateBase, sig: signPayload(peerIdentity.privateKey, updateBase) };
  const unicastBeforeReceive = unicastPackets.length;
  discovery.handleDatagram(
    Buffer.from(encodePacket({
      packetNo: 4,
      user: 'Alive Peer Renamed',
      host: 'alive-host',
      command: CMD.BR_UPDATE,
      message: encodeBody('', updateEntry),
    })),
    { source: 'hub', sender: peerIdentity.id },
  );
  assert.equal(unicastPackets.length, unicastBeforeReceive, '收到 BR_UPDATE 不应回 ANSENTRY');
  console.log('✓ BR_ALIVE 心跳 / 改名 BR_UPDATE 单播 / 重放保护 / 手动 BR_ENTRY 刷新');
  console.log('\nALIVE 测试通过 ✅');
}

main().catch((error) => {
  console.error('\nALIVE 测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
