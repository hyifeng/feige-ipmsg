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
  if (peer.path === 'direct') return '公网直连';
  if (peer.path === 'lan') return '局域网';
  const sources = Array.isArray(peer.sources) ? peer.sources : [];
  if (sources.includes('lan')) return '局域网';
  if (sources.includes('hub') || sources.includes('direct')) return '公网直连';
  return '';
}

function peerAddressLabel(peer) {
  if (peer.path === 'direct') return 'P2P 直连';
  if (peer.ip) return `${peer.ip}:${peer.port}`;
  const sources = Array.isArray(peer.sources) ? peer.sources : [];
  if (sources.includes('hub') || sources.includes('direct')) return 'P2P 直连';
  return '未知地址';
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
    dom.themeBtn.title = value === 'light' ? '切换到深色' : '切换到浅色';
  }
}

function renderAll() {
  renderSelf();
  renderPeers();
  renderChat();
  renderTransfers();
}

function renderSelf() {
  const nickname = state.self.nickname || '飞鸽用户';
  dom.selfName.textContent = nickname;
  setAvatar(dom.selfAvatar, nickname);
  const ip = state.self.addresses && state.self.addresses[0];
  if (!state.self.ready) {
    dom.selfMeta.textContent = '正在启动…';
  } else {
    dom.selfMeta.textContent = `${ip || '无网络'} · 在线`;
  }
  dom.brandPulse.classList.toggle('off', !state.self.ready);
  dom.brandPulse.title = '在线';
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
    dom.welcomeHint.textContent = '正在启动局域网服务…';
  } else if (!online) {
    dom.welcomeHint.textContent = historyCount
      ? `暂无在线设备 · 可从左侧历史联系人查看 ${historyCount} 段聊天记录`
      : '还没有发现设备 · 请确认在同一网段，并允许 24250 端口';
  } else {
    dom.welcomeHint.textContent = unverified
      ? `已发现 ${online} 台在线设备，其中 ${unverified} 台身份未认证 · 可核对 6 位码完成认证`
      : `已发现 ${online} 台在线设备，选择一位开始传送`;
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
        <b>${query ? '没有匹配的联系人' : '还没有发现设备'}</b>
        <small>${query ? '试试搜索别名、指纹、主机名、IP 或聊天内容' : '请确保大家在同一网段，并允许 UDP 24250 广播'}</small>
      </div>`;
    updateWelcomeHint();
    return;
  }

  const parts = [];
  if (namedOnline.length) {
    parts.push(`<div class="section-label">在线同事 <span class="count">${namedOnline.length}</span></div>`);
    parts.push(namedOnline.map((peer) => peerRowHtml(peer, false)).join(''));
  }
  if (unnamedLive.length || unnamedHistory.length) {
    const count = unnamedLive.length + unnamedHistory.length;
    parts.push(`<div class="section-label unnamed-label">${icon('alert', 12)} 未认证联系人 <span class="count">${count}</span></div>`);
    parts.push(unnamedLive.map((peer) => peerRowHtml(peer, false)).join(''));
    parts.push(unnamedHistory.map((peer) => peerRowHtml(peer, true)).join(''));
  }
  if (namedOffline.length) {
    parts.push(`<div class="section-label">离线同事 <span class="count">${namedOffline.length}</span></div>`);
    parts.push(namedOffline.map((peer) => peerRowHtml(peer, false)).join(''));
  }
  if (namedHistory.length) {
    parts.push(`<div class="section-label">历史联系人 <span class="count">${namedHistory.length}</span></div>`);
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
  const statusText = isHistory ? '历史' : peer.online ? '在线' : '离线';
  const securityText = warning ? '认证异常' : verified ? '已认证' : (pending ? '认证中' : '未认证');
  const sourceText = peerSourceLabel(peer);
  const sub = verified
    ? `${securityText} · ${statusText}${sourceText ? ` · ${sourceText}` : ''} · ${isHistory ? '历史记录' : (peer.host || peerAddressLabel(peer))}`
    : `${display.fingerprint} · ${statusText}${sourceText ? ` · ${sourceText}` : ''} · ${securityText}`;
  const title = [
    display.label,
    `指纹 ${display.fingerprint}`,
    statusText,
    verified ? securityText : `身份未认证${claimed ? ` · 自称“${claimed}”` : ''}`,
    sourceText,
    warning ? warning.title || '认证状态异常' : '',
    peerAddressLabel(peer),
  ].filter(Boolean).join(' · ');
  return `
    <button class="peer ${peer.online ? '' : 'offline'} ${isHistory ? 'history' : ''} ${verified ? 'verified-peer' : 'unverified-peer'} ${unnamed ? 'unnamed-peer' : ''} ${secureClass} ${isActive ? 'active' : ''}" data-peer="${escapeHtml(peer.key)}" title="${escapeHtml(title)}">
      <span class="avatar ${unnamed ? 'unnamed-avatar' : ''}" style="${unnamed ? '' : avatarStyle(display.label)}">${escapeHtml(unnamed ? '?' : initials(display.label))}
        ${paired ? `<span class="avatar-lock" title="身份已认证">${icon('shield', 9)}</span>` : ''}
        <i class="status-dot ${peer.online ? '' : 'offline'}"></i>
      </span>
      <span class="peer-body">
        <span class="peer-top">
          <span class="peer-name">${escapeHtml(display.label)}</span>
          ${warning
            ? `<span class="peer-secure-badge warn">${icon('alert', 10)}<span>认证异常</span></span>`
            : !verified
              ? `<span class="peer-secure-badge unnamed" title="身份未认证；消息仍会自动端到端加密">${icon('alert', 10)}<span>${securityText}</span></span>`
              : `<span class="peer-secure-badge">${icon('shield', 10)}<span>已认证</span></span>`}
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
    ? '认证异常'
    : display.verified ? '已认证' : (authPending ? '认证中' : '未认证');
  dom.chatStatus.classList.remove('offline');
  dom.chatStatus.classList.toggle('secure', display.verified && !authWarning);
  dom.chatStatus.classList.toggle('warn', !display.verified || !!authWarning);

  const base = isHistory
    ? `历史聊天 · ${relativeTime(peer.lastAt)}`
    : `${peer.online ? '在线' : '离线'} · ${peer.host || '未知主机'} · ${peerAddressLabel(peer)}`;
  dom.chatMeta.textContent = display.verified
    ? `指纹 ${display.fingerprint} · ${base}`
    : `指纹 ${display.fingerprint} · 未认证 · ${base}`;
  dom.peerAddress.textContent = isHistory ? '本地历史记录' : peerAddressLabel(peer);

  if (dom.chatAliasBtn) {
    dom.chatAliasBtn.classList.toggle('is-hidden', isHistory || !display.verified);
    const label = dom.chatAliasBtn.querySelector('span:last-child');
    if (label) label.textContent = '改名';
    dom.chatAliasBtn.title = display.alias
      ? '修改本地别名（只在当前设备生效）'
      : `设置本地别名（当前显示对方自称：${claimed || '未提供'}）`;
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
  dom.messageInput.placeholder = isHistory
    ? '历史联系人已离线，仅可查看聊天记录'
    : !peer.online
      ? '对方已离线，暂时无法发送'
      : waiting
        ? '本机认证已解除，等待对方重新认证'
        : (display.verified ? '写点什么…  Enter 发送，Shift + Enter 换行' : '身份未认证 · 消息仍会自动加密');
  dom.composerHint.textContent = isHistory
    ? '只读模式 · 聊天记录保存在本机'
    : !peer.online
      ? '等待对方重新上线…'
      : waiting
        ? '本机认证已解除 · 等待对方点击「重新认证」'
        : (display.verified
          ? 'Enter 发送 · Shift + Enter 换行 · 可直接拖入文件'
          : '身份未认证 · 可点击「认证身份」核对 6 位码');
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
