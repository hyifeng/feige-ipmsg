import { t } from '../i18n/index.js';
import { avatarStyle, dayLabel, escapeHtml, formatTime, initials, relativeTime } from '../core/format.js';
import { displayFor } from '../core/contacts.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { closeModal } from './modals.js';
import { activePeer, renderChat, renderPeers, selectPeer } from './peers.js';

function previewText(value) {
  return String(value || '')
    .replace(/^\[图片\]/, `[${t('common.image')}]`)
    .replace(/^\[文件夹\]/, `[${t('common.folder')}]`)
    .replace(/^\[文件\]/, `[${t('common.file')}]`)
    .replace(/^\[消息\]/, `[${t('common.message')}]`);
}

function openHistoryModal() {
  if (!window.feige) return;
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal history-modal" role="dialog" aria-modal="true" aria-label="${t('history.title')}">
        <div class="modal-head">
          <div>
            <h3>${t('history.title')}</h3>
            <p>${t('history.subtitle')}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>
        <div class="history-search">
          <span class="ico">${icon('search', 17)}</span>
          <input id="historySearchInput" type="text" placeholder="${t('history.searchPlaceholder')}" autocomplete="off" spellcheck="false" />
        </div>
        <div class="history-results" id="historyResults"></div>
        <div class="modal-actions history-actions">
          <button class="btn danger history-clear" id="historyClearBtn">${t('history.clearAction')}</button>
          <span class="history-hint" id="historyHint">${t('history.encryptedHint')}</span>
          <button class="btn ghost" data-close-modal>${t('common.close')}</button>
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
      ? previewText(peer.lastText) || t('history.title')
      : `${display.fingerprint} · ${t('common.status.unverified')}${peer.lastText ? ` · ${previewText(peer.lastText)}` : ''}`;
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
    const prefix = message.direction === 'out' ? t('history.mePrefix') : '';
    const text = message.kind === 'files'
      ? (previewText(message.text) || `[${t(message.isFolder ? 'common.folder' : 'common.file')}] ${message.rootName || t('common.file')}`)
      : (previewText(message.text) || `[${t('common.message')}]`);
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
          <b>${t('history.emptyTitle')}</b>
          <small>${t('history.emptyHint')}</small>
        </div>`;
      hint.textContent = t('history.encryptedHint');
      return;
    }
    results.innerHTML = `<div class="history-section">${t('history.recentTitle', { count: peers.length })}</div>${peers.map(contactRow).join('')}`;
    hint.textContent = t('history.contactsSummary', { count: peers.length });
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
            <b>${t('history.searchEmptyTitle')}</b>
            <small>${t('history.searchEmptyHint')}</small>
          </div>`;
        hint.textContent = t('history.searchNoMatches');
        return;
      }
      results.innerHTML = `<div class="history-section">${t('history.searchTitle', { count: items.length })}</div>${items.map(messageRow).join('')}`;
      hint.textContent = t('history.searchSummary', { count: items.length });
    } catch (error) {
      if (results.isConnected) {
        results.innerHTML = `<div class="history-empty"><b>${t('history.searchFailed')}</b><small>${escapeHtml(error.message || String(error))}</small></div>`;
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
      clearBtn.textContent = t('history.clearConfirm');
      clearBtn.classList.add('armed');
      hint.textContent = t('history.clearWarning');
      clearTimer = setTimeout(() => {
        clearArmed = false;
        clearBtn.textContent = t('history.clearAction');
        clearBtn.classList.remove('armed');
        hint.textContent = t('history.encryptedHint');
      }, 4000);
      return;
    }
    clearTimeout(clearTimer);
    clearBtn.disabled = true;
    clearBtn.textContent = t('history.clearing');
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
      toast(t('history.cleared'), 'success');
    } catch (error) {
      clearBtn.disabled = false;
      clearBtn.textContent = t('history.clearAction');
      toast(error.message || t('history.clearFailed'), 'error');
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
