'use strict';

const os = require('node:os');
const { lanAddresses } = require('../network');
const { shortIdentity, identityOfPeerKey, peerKeyOf, isIdentity } = require('../../shared/protocol/identity');

function selfInfo(ctx) {
  const id = ctx.identity ? ctx.identity.id : (ctx.node ? ctx.node.identity : ctx.settings.identity);
  return {
    id,
    fingerprint: shortIdentity(id),
    nickname: ctx.settings.nickname,
    host: os.hostname().split('.')[0],
    port: ctx.settings.port,
    discoveryPort: ctx.discoveryPort,
    addresses: lanAddresses(),
    lanEnabled: ctx.settings ? ctx.settings.lanEnabled !== false : true,
    online: ctx.node ? ctx.node.online : ctx.settings.online,
    ready: !!(ctx.node && ctx.node.started),
  };
}

function isVerifiedPeer(ctx, peerKey) {
  const key = peerKeyOf(identityOfPeerKey(peerKey));
  try {
    if (ctx && ctx.secureStore && ctx.secureStore.get(key)) return true;
  } catch {
    /* ignore */
  }
  const node = ctx && ctx.node;
  if (!node || !node.secure) return false;
  try {
    // 加密会话不等于身份认证：临时加密会话不会出现在 pairing 列表中。
    // 未认证联系人仍显示自称名字，但会用次级配色和未认证徽标区分。
    return node.secure.listPairings().some((pairing) => pairing.peerKey === key);
  } catch {
    return false;
  }
}

function contactInfo(ctx, peerKey, claimedName = '') {
  const identity = identityOfPeerKey(peerKey);
  if (!isIdentity(identity)) {
    return {
      identity,
      peerKey: peerKeyOf(identity),
      alias: '',
      verified: false,
      unnamed: true,
      label: '旧身份记录',
      fingerprint: '—',
      claimed: claimedName,
    };
  }

  const base = ctx.contacts
    ? ctx.contacts.displayFor(identity, claimedName)
    : {
      identity,
      peerKey: peerKeyOf(identity),
      alias: '',
      fingerprint: shortIdentity(identity),
      claimed: claimedName,
    };
  const verified = isVerifiedPeer(ctx, identity);

  if (!verified) {
    const claimed = base.claimed || claimedName || '';
    return {
      ...base,
      alias: '',
      verified: false,
      unnamed: !claimed,
      label: claimed || '未认证设备',
    };
  }

  return {
    ...base,
    verified: true,
    unnamed: false,
    label: base.alias || base.claimed || '已验证设备',
  };
}

function decorateContact(ctx, item) {
  const identity = identityOfPeerKey(item.key || item.peerKey);
  return {
    ...item,
    claimedName: item.claimedName || item.user || '',
    ...contactInfo(ctx, peerKeyOf(identity), item.claimedName || item.user || ''),
  };
}

function peerList(ctx) {
  if (!ctx.node) return [];
  const peers = ctx.node.registry
    ? ctx.node.registry.list()
    : [...ctx.node.peers.values()];
  return peers.map((peer) => decorateContact(ctx, peer));
}

function emit(ctx, type, payload) {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  ctx.win.webContents.send('feige:event', { type, payload, at: Date.now() });
}

function friendlyNetworkError(ctx, err) {
  const code = err && err.code;
  if (code === 'EADDRINUSE') {
    return `端口 ${ctx.settings.port} 或发现端口 ${ctx.discoveryPort} 已被占用。请关闭占用该端口的程序后重试。`;
  }
  if (code === 'EACCES') return `没有权限监听端口 ${ctx.settings.port}，请改用 1024 以上的端口。`;
  return (err && err.message) || String(err);
}

module.exports = {
  selfInfo,
  peerList,
  contactInfo,
  decorateContact,
  isVerifiedPeer,
  emit,
  friendlyNetworkError,
};
