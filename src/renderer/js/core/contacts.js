import { state } from './state.js';

function fingerprintOf(peerKey) {
  const identity = String(peerKey || '').replace(/^id:/, '').replace(/^pk1_/, '');
  if (identity.length < 12) return identity;
  return `${identity.slice(0, 4)}-${identity.slice(4, 8)}-${identity.slice(8, 12)}`;
}

function contactFor(peerKey) {
  return state.contacts.get(peerKey) || null;
}

/** 在线设备的最新自称优先于调用方持有的历史快照。 */
function currentClaimed(peerKey, fallback = '') {
  const live = state.peers.find((peer) => peer.key === peerKey);
  if (live && live.user) return String(live.user);
  return String(fallback || '');
}

function isVerified(peerKey) {
  // 临时加密会话只保证传输加密，不代表身份已经认证。
  return state.securePairings.has(peerKey);
}

/**
 * 显示名规则：
 * - 已认证联系人优先显示本地别名，其次显示对方自称。
 * - 未认证联系人也正常显示对方自称；信任状态由卡片配色和徽标表达，
 *   本地别名仍然不生效。
 */
function displayFor(peerKey, claimed = '') {
  const contact = contactFor(peerKey);
  const alias = contact && contact.alias ? contact.alias : '';
  const claimedName = currentClaimed(peerKey, claimed).trim();
  const fingerprint = (contact && contact.fingerprint) || fingerprintOf(peerKey);
  const verified = isVerified(peerKey);

  if (verified) {
    return {
      peerKey,
      alias,
      verified: true,
      unnamed: false,
      autoName: !alias,
      label: alias || claimedName || '已验证设备',
      fingerprint,
      claimed: claimedName,
    };
  }

  return {
    peerKey,
    alias: '',
    verified: false,
    // unnamed 只表示“连自称名字都没有”，不是“未认证”。
    unnamed: !claimedName,
    autoName: true,
    label: claimedName || '未认证设备',
    fingerprint,
    claimed: claimedName,
  };
}

function displayName(peerKey, claimed = '') {
  return displayFor(peerKey, claimed).label;
}

export { contactFor, currentClaimed, displayFor, displayName, fingerprintOf, isVerified };
