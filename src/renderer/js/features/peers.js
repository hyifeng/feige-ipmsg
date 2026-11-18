import { t } from '../i18n/index.js';
import { avatarStyle, escapeHtml, initials, relativeTime, setAvatar } from '../core/format.js';
import { displayFor } from '../core/contacts.js';
import { icon } from '../core/icons.js';
import { dom, state } from '../core/state.js';
import { closeImageMenu } from './images.js';
import { ensureHistoryLoaded, renderMessages } from './messages.js';
import { renderSecure } from './secure.js';
import { renderTransfers } from './transfers.js';

function peerSourceLabel(peer) {
  // 显示实际承载路径，而不是发现来源。LAN 发现还在、但数据已经
  // 切到 P2P 时，不能继续显示“局域网”。
  if (peer.path === 'direct') return t('peer.source.direct');
  if (peer.path === 'lan') return t('peer.source.lan');
  const sources = Array.isArray(peer.sources) ? peer.sources : [];
  if (sources.includes('lan')) return t('peer.source.lan');
  if (sources.includes('hub') || sources.includes('direct')) return t('peer.source.direct');
  return '';
}

function peerAddressLabel(peer) {
  if (peer.path === 'direct') return t('peer.source.p2p');
  if (peer.ip) return `${peer.ip}:${peer.port}`;
  const sources = Array.isArray(peer.sources) ? peer.sources : [];
  if (sources.includes('hub') || sources.includes('direct')) return t('peer.source.p2p');
  return t('common.unknownAddress');
}

function peerByKey(key) {
  return state.peers.find((peer) => peer.key === key)
    || state.historyPeers.find((peer) => peer.key === key)
    || null;
}

function activePeer() {
  return peerByKey(state.active) || state.activePeer;
}

function applyTheme(theme, persist = true) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  if (persist) localStorage.setItem('feige-theme', value);
  if (dom.themeBtn) {
    dom.themeBtn.innerHTML = icon(value === 'light' ? 'moon' : 'sun', 18);
    dom.themeBtn.title = t(value === 'light' ? 'peer.switchToDarkTheme' : 'peer.switchToLightTheme');
  }
}

function renderAll() {
  renderSelf();
  renderPeers();
  renderChat();
  renderTransfers();
}

function renderSelf() {
  const nickname = state.self.nickname || t('app.defaultUserName');
  dom.selfName.textContent = nickname;
  setAvatar(dom.selfAvatar, nickname);
  const ip = state.self.addresses && state.self.addresses[0];
  if (!state.self.ready) {
    dom.selfMeta.textContent = t('app.starting');
  } else {
    dom.selfMeta.textContent = `${ip || t('common.noNetwork')} · ${t('common.status.online')}`;
  }
  dom.brandPulse.classList.toggle('off', !state.self.ready);
  dom.brandPulse.title = t('common.status.online');
  dom.peerSearch.disabled = false;
  updateWelcomeHint();
}

function updateWelcomeHint() {
  if (!dom.welcomeHint) return;
  if (state.fatal) {
    dom.welcomeHint.textContent = state.fatal;
    return;
  }
  const online = state.peers.filter((peer) => peer.online).length;
  const unverified = state.peers.filter((peer) => peer.online && !displayFor(peer.key, peer.user).verified).length;
  const historyCount = state.historyPeers.length;
  if (!state.self.ready) {
    dom.welcomeHint.textContent = t('peer.welcome.starting');
  } else if (!online) {
    dom.welcomeHint.textContent = historyCount
      ? t('peer.welcome.historyOnly', { count: historyCount })
      : t('peer.welcome.noDevices');
  } else {
    dom.welcomeHint.textContent = unverified
      ? t('peer.welcome.online', { count: online, unverified })
      : t('peer.welcome.onlinePick', { count: online });
  }
}

function renderPeers() {
  const query = state.filter.trim().toLowerCase();
  const matches = (peer) => {
    if (!query) return true;
    const display = displayFor(peer.key, peer.user);
    return [display.label, display.alias, display.fingerprint, peer.user, peer.host, peer.ip, peer.lastText]
      .some((value) => String(value || '').toLowerCase().includes(query));
  };

  const liveKeys = new Set(state.peers.map((peer) => peer.key));
  const all = [
    ...state.peers.map((peer) => ({ ...peer, history: false })),
    ...state.historyPeers.filter((peer) => !liveKeys.has(peer.key)).map((peer) => ({ ...peer, history: true })),
  ].filter(matches);

  const named = all.filter((peer) => displayFor(peer.key, peer.user).verified);
  const unnamed = all.filter((peer) => !displayFor(peer.key, peer.user).verified);
  const namedOnline = named.filter((peer) => peer.online && !peer.history);
  const namedOffline = named.filter((peer) => !peer.online && !peer.history);
  const namedHistory = named.filter((peer) => peer.history);
  const unnamedLive = unnamed.filter((peer) => !peer.history).sort((a, b) => Number(b.online) - Number(a.online));
  const unnamedHistory = unnamed.filter((peer) => peer.history).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  if (!all.length) {
    dom.peerList.innerHTML = `
      <div class="peer-empty">
        <span class="ico">${icon(query ? 'search' : 'radar', 21)}</span>
        <b>${query ? t('peer.empty.noMatches') : t('peer.empty.noDevices')}</b>
        <small>${query ? t('peer.empty.searchHint') : t('peer.empty.searchNetwork')}</small>
      </div>`;
    updateWelcomeHint();
    return;
  }

  const parts = [];
  if (namedOnline.length) {
    parts.push(`<div class="section-label">${t('peer.section.online')} <span class="count">${namedOnline.length}</span></div>`);
    parts.push(namedOnline.map((peer) => peerRowHtml(peer, false)).join(''));
  }
  if (unnamedLive.length || unnamedHistory.length) {
    const count = unnamedLive.length + unnamedHistory.length;
    parts.push(`<div class="section-label unnamed-label">${icon('alert', 12)} ${t('peer.section.unverified')} <span class="count">${count}</span></div>`);
    parts.push(unnamedLive.map((peer) => peerRowHtml(peer, false)).join(''));
    parts.push(unnamedHistory.map((peer) => peerRowHtml(peer, true)).join(''));
  }
  if (namedOffline.length) {
    parts.push(`<div class="section-label">${t('peer.section.offline')} <span class="count">${namedOffline.length}</span></div>`);
    parts.push(namedOffline.map((peer) => peerRowHtml(peer, false)).join(''));
  }
  if (namedHistory.length) {
    parts.push(`<div class="section-label">${t('peer.section.history')} <span class="count">${namedHistory.length}</span></div>`);
    parts.push(namedHistory.map((peer) => peerRowHtml(peer, true)).join(''));
  }
  dom.peerList.innerHTML = parts.join('');
  updateWelcomeHint();
}

function peerRowHtml(peer, isHistory = false) {
  const unread = state.unread.get(peer.key) || 0;
  const isActive = state.active === peer.key;
  const paired = state.securePairings.has(peer.key);
  const pending = state.securePending.get(peer.key);
  const warning = state.secureWarnings.get(peer.key);
  const secureClass = warning ? 'warning' : paired ? 'paired' : '';
  const display = displayFor(peer.key, peer.user);
  const verified = display.verified;
  const unnamed = !!display.unnamed;
  const claimed = display.claimed || peer.user || '';
  const statusText = isHistory ? t('common.status.history') : peer.online ? t('common.status.online') : t('common.status.offline');
  const securityText = warning ? t('common.status.verificationIssue') : verified ? t('common.status.verified') : (pending ? t('common.status.verifying') : t('common.status.unverified'));
  const sourceText = peerSourceLabel(peer);
  const sub = verified
    ? `${securityText} · ${statusText}${sourceText ? ` · ${sourceText}` : ''} · ${isHistory ? t('common.status.historyRecord') : (peer.host || peerAddressLabel(peer))}`
    : `${display.fingerprint} · ${statusText}${sourceText ? ` · ${sourceText}` : ''} · ${securityText}`;
  const title = [
    display.label,
    t('offer.fingerprint', { fingerprint: display.fingerprint }),
    statusText,
    verified ? securityText : `${t('common.status.identityUnverified')}${claimed ? ` · ${t('peer.claimSuffix', { claimed })}` : ''}`,
    sourceText,
    warning ? warning.title || t('peer.status.verificationStatusIssue') : '',
    peerAddressLabel(peer),
  ].filter(Boolean).join(' · ');
  return `
    <button class="peer ${peer.online ? '' : 'offline'} ${isHistory ? 'history' : ''} ${verified ? 'verified-peer' : 'unverified-peer'} ${unnamed ? 'unnamed-peer' : ''} ${secureClass} ${isActive ? 'active' : ''}" data-peer="${escapeHtml(peer.key)}" title="${escapeHtml(title)}">
      <span class="avatar ${unnamed ? 'unnamed-avatar' : ''}" style="${unnamed ? '' : avatarStyle(display.label)}">${escapeHtml(unnamed ? '?' : initials(display.label))}
        ${paired ? `<span class="avatar-lock" title="${t('common.status.identityVerified')}">${icon('shield', 9)}</span>` : ''}
        <i class="status-dot ${peer.online ? '' : 'offline'}"></i>
      </span>
      <span class="peer-body">
        <span class="peer-top">
          <span class="peer-name">${escapeHtml(display.label)}</span>
          ${warning
            ? `<span class="peer-secure-badge warn">${icon('alert', 10)}<span>${t('common.status.verificationIssue')}</span></span>`
            : !verified
              ? `<span class="peer-secure-badge unnamed" title="${t('peer.meta.unverifiedE2EE')}">${icon('alert', 10)}<span>${securityText}</span></span>`
              : `<span class="peer-secure-badge">${icon('shield', 10)}<span>${t('common.status.verified')}</span></span>`}
          ${unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : ''}
        </span>
        <span class="peer-sub">${escapeHtml(sub)}</span>
      </span>
    </button>`;
}

function renderChat() {
  const peer = activePeer();
  if (!peer) {
    dom.chat.classList.add('is-hidden');
    dom.chat.classList.remove('secure-active');
    dom.welcome.classList.remove('is-hidden');
    updateWelcomeHint();
    return;
  }
  dom.welcome.classList.add('is-hidden');
  dom.chat.classList.remove('is-hidden');
  renderChatHead(peer);
  renderMessages(false);
}

function renderChatHead(peer) {
  const isHistory = !!peer.history;
  const display = displayFor(peer.key, peer.user);
  const claimed = display.claimed || peer.user || '';

  setAvatar(dom.chatAvatar, display.label);
  dom.chatAvatar.classList.toggle('unnamed-avatar', !!display.unnamed);
  if (display.unnamed) {
    dom.chatAvatar.textContent = '?';
    dom.chatAvatar.setAttribute('style', '');
  }

  dom.chatName.textContent = display.label;
  const authWarning = state.secureWarnings.get(peer.key);
  const authPending = state.securePending.get(peer.key);
  dom.chatStatus.textContent = authWarning
    ? t('common.status.verificationIssue')
    : display.verified ? t('common.status.verified') : (authPending ? t('common.status.verifying') : t('common.status.unverified'));
  dom.chatStatus.classList.remove('offline');
  dom.chatStatus.classList.toggle('secure', display.verified && !authWarning);
  dom.chatStatus.classList.toggle('warn', !display.verified || !!authWarning);

  const base = isHistory
    ? t('peer.meta.historyChat', { time: relativeTime(peer.lastAt) })
    : t(peer.online ? 'peer.meta.onlineWithHost' : 'peer.meta.offlineWithHost', {
      host: peer.host || t('common.unknownHost'),
      address: peerAddressLabel(peer),
    });
  dom.chatMeta.textContent = display.verified
    ? t('peer.meta.fingerprintDetails', { fingerprint: display.fingerprint, details: base })
    : t('peer.meta.fingerprintUnverifiedDetails', { fingerprint: display.fingerprint, details: base });
  dom.peerAddress.textContent = isHistory ? t('peer.meta.localHistory') : peerAddressLabel(peer);

  if (dom.chatAliasBtn) {
    dom.chatAliasBtn.classList.toggle('is-hidden', isHistory || !display.verified);
    const label = dom.chatAliasBtn.querySelector('span:last-child');
    if (label) label.textContent = t('alias.action.rename');
    dom.chatAliasBtn.title = display.alias
      ? t('peer.aliasEditTitle')
      : t('peer.aliasTitle', { claimed: claimed || t('common.notProvided') });
  }

  const waiting = state.secureWaiting.has(peer.key) && !isHistory;
  const canSend = peer.online && state.self.ready && state.self.online && !waiting;
  dom.messageInput.disabled = !canSend;
  dom.sendBtn.disabled = !canSend;
  dom.attachImageBtn.disabled = !canSend;
  dom.attachFileBtn.disabled = !canSend;
  dom.attachFolderBtn.disabled = !canSend;
  dom.sendFileBtn.disabled = !canSend;
  dom.sendFolderBtn.disabled = !canSend;
  dom.composer.classList.toggle('is-disabled', !canSend);
  dom.messageInput.placeholder = t(isHistory
    ? 'peer.hint.historyOffline'
    : !peer.online
      ? 'peer.hint.peerOffline'
      : waiting
        ? 'secure.status.localRevokedWaiting'
        : (display.verified ? 'chat.composer.placeholder' : 'peer.meta.unverifiedEncrypted'));
  dom.composerHint.textContent = t(isHistory
    ? 'peer.hint.readOnly'
    : !peer.online
      ? 'peer.hint.waitingPeerOnline'
      : waiting
        ? 'peer.hint.localRevoked'
        : (display.verified
          ? 'chat.composer.hint'
          : 'peer.hint.unverifiedVerify'));
  renderSecure(peer);
}

function selectPeer(key) {
  const peer = peerByKey(key);
  if (!peer) return;
  closeImageMenu();
  state.active = key;
  state.activePeer = { ...peer };
  state.unread.delete(key);
  renderPeers();
  renderChat();
  // 打开会话直接定位到最后一条，不播放从顶部到底部的平滑滚动。
  renderMessages(true, { instant: true });
  if (!state.historyLoaded.has(key)) ensureHistoryLoaded(key);
  if (peer.online) dom.messageInput.focus();
}

function clearActiveUnread() {
  if (!state.active) return;
  if (state.unread.delete(state.active)) renderPeers();
}

export { peerByKey, activePeer, applyTheme, renderAll, renderSelf, updateWelcomeHint, renderPeers, peerRowHtml, renderChat, renderChatHead, selectPeer, clearActiveUnread };
