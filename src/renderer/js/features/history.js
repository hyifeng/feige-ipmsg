import { avatarStyle, dayLabel, escapeHtml, formatTime, initials, relativeTime } from '../core/format.js';
import { displayFor } from '../core/contacts.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { closeModal } from './modals.js';
import { activePeer, renderChat, renderPeers, selectPeer } from './peers.js';

function openHistoryModal() {
  if (!window.feige) return;
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal history-modal" role="dialog" aria-modal="true" aria-label="聊天记录">
        <div class="modal-head">
          <div>
            <h3>聊天记录</h3>
            <p>本地密码加密保存 · 仅当前设备可见</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="history-search">
          <span class="ico">${icon('search', 17)}</span>
          <input id="historySearchInput" type="text" placeholder="搜索聊天内容或文件名…" autocomplete="off" spellcheck="false" />
        </div>
        <div class="history-results" id="historyResults"></div>
        <div class="modal-actions history-actions">
          <button class="btn danger history-clear" id="historyClearBtn">清空全部记录</button>
          <span class="history-hint" id="historyHint">记录已由本地密码加密保存</span>
          <button class="btn ghost" data-close-modal>关闭</button>
        </div>
      </div>
    </div>`;

  state.modal = { type: 'history' };
  const input = dom.modalRoot.querySelector('#historySearchInput');
  const results = dom.modalRoot.querySelector('#historyResults');
  const hint = dom.modalRoot.querySelector('#historyHint');
  const clearBtn = dom.modalRoot.querySelector('#historyClearBtn');
  let searchTimer = null;
  let clearTimer = null;
  let clearArmed = false;

  const contactRow = (peer) => {
    const display = displayFor(peer.key, peer.user);
    const sub = display.verified
      ? (peer.lastText || '聊天记录')
      : `${display.fingerprint} · 未认证${peer.lastText ? ` · ${peer.lastText}` : ''}`;
    return `
    <button class="history-row" data-history-peer="${escapeHtml(peer.key)}">
      <span class="avatar avatar-sm ${display.unnamed ? 'unnamed-avatar' : ''}" style="${display.unnamed ? '' : avatarStyle(display.label)}">${escapeHtml(display.unnamed ? '?' : initials(display.label))}</span>
      <span class="history-row-main">
        <span class="history-row-name">${escapeHtml(display.label)}</span>
        <span class="history-row-sub">${escapeHtml(sub)}</span>
      </span>
      <span class="history-row-time">${escapeHtml(relativeTime(peer.lastAt))}</span>
    </button>`;
  };

  const messageRow = (message) => {
    const claimed = (message.peer && message.peer.user) || message.peerName || '';
    const display = displayFor(message.peerKey, claimed);
    const peerName = display.label;
    const prefix = message.direction === 'out' ? '我：' : '';
    const text = message.kind === 'files'
      ? (message.text || `[${message.isFolder ? '文件夹' : '文件'}] ${message.rootName || '文件'}`)
      : (message.text || '[消息]');
    return `
      <button class="history-result" data-history-peer="${escapeHtml(message.peerKey)}">
        <span class="history-result-head">
          <b>${escapeHtml(peerName)}</b>
          <span>${escapeHtml(`${dayLabel(message.at)} ${formatTime(message.at)}`)}</span>
        </span>
        <span class="history-result-text">${escapeHtml(`${prefix}${text}`)}</span>
      </button>`;
  };

  const renderRecent = () => {
    const peers = state.historyPeers;
    if (!peers.length) {
      results.innerHTML = `
        <div class="history-empty">
          <span class="ico">${icon('clock', 22)}</span>
          <b>还没有聊天记录</b>
          <small>发送或接收消息后，会自动保存在本机</small>
        </div>`;
      hint.textContent = '记录已由本地密码加密保存';
      return;
    }
    results.innerHTML = `<div class="history-section">最近聊天 · ${peers.length}</div>${peers.map(contactRow).join('')}`;
    hint.textContent = `共 ${peers.length} 位联系人 · 记录已由本地密码加密保存`;
  };

  const runSearch = async () => {
    const query = input.value.trim();
    if (!query) {
      renderRecent();
      return;
    }
    try {
      const items = await window.feige.searchHistory(query);
      if (!results.isConnected) return;
      if (!items.length) {
        results.innerHTML = `
          <div class="history-empty">
            <span class="ico">${icon('search', 22)}</span>
            <b>没有找到相关记录</b>
            <small>换个关键词试试，或搜索文件名</small>
          </div>`;
        hint.textContent = '没有匹配结果';
        return;
      }
      results.innerHTML = `<div class="history-section">搜索结果 · ${items.length}</div>${items.map(messageRow).join('')}`;
      hint.textContent = `共 ${items.length} 条匹配记录`;
    } catch (error) {
      if (results.isConnected) {
        results.innerHTML = `<div class="history-empty"><b>搜索失败</b><small>${escapeHtml(error.message || String(error))}</small></div>`;
      }
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 180);
    state.historySearchTimer = searchTimer;
  });

  results.addEventListener('click', (event) => {
    const row = event.target.closest('[data-history-peer]');
    if (!row) return;
    selectPeer(row.dataset.historyPeer);
    closeModal();
  });

  clearBtn.addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = '再次点击确认清空';
      clearBtn.classList.add('armed');
      hint.textContent = '此操作会永久删除本机全部聊天记录';
      clearTimer = setTimeout(() => {
        clearArmed = false;
        clearBtn.textContent = '清空全部记录';
        clearBtn.classList.remove('armed');
        hint.textContent = '记录已由本地密码加密保存';
      }, 4000);
      return;
    }
    clearTimeout(clearTimer);
    clearBtn.disabled = true;
    clearBtn.textContent = '正在清空…';
    try {
      await window.feige.clearHistory();
      state.historyEpoch += 1;
      state.messages.clear();
      state.historyPeers = [];
      state.historyLoaded.clear();
      state.historyMore.clear();
      if (state.active && !state.peers.some((peer) => peer.key === state.active)) {
        state.active = null;
        state.activePeer = null;
      }
      renderPeers();
      renderChat();
      closeModal();
      toast('聊天记录已清空', 'success');
    } catch (error) {
      clearBtn.disabled = false;
      clearBtn.textContent = '清空全部记录';
      toast(error.message || '清空失败', 'error');
    }
  });

  renderRecent();
  setTimeout(() => input.focus(), 50);

  window.feige.historyContacts().then((peers) => {
    if (!Array.isArray(peers) || !results.isConnected) return;
    state.historyPeers = peers;
    renderPeers();
    if (results.isConnected && !input.value.trim()) renderRecent();
  }).catch(() => {});
}

export { openHistoryModal };
