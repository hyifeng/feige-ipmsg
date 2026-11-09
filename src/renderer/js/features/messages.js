import { dayKey, dayLabel, escapeHtml, formatTime, linkify } from '../core/format.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { imageMessageHtml } from './images.js';
import { fileMessageHtml } from './transfers.js';

function conversation(peerKey) {
  if (!state.messages.has(peerKey)) state.messages.set(peerKey, []);
  return state.messages.get(peerKey);
}

function appendMessage(peerKey, message) {
  if (!peerKey || !message) return false;
  const list = conversation(peerKey);
  if (list.some((item) => item.id === message.id)) return false;
  list.push(message);
  return true;
}

function mergeMessages(peerKey, messages) {
  if (!peerKey || !Array.isArray(messages) || !messages.length) return;
  const list = conversation(peerKey);
  const byId = new Map(list.map((message) => [message.id, message]));
  for (const message of messages) {
    if (!message || !message.id) continue;
    const existing = byId.get(message.id);
    if (!existing) {
      byId.set(message.id, message);
    } else if (!existing.fileState && message.fileState) {
      existing.fileState = message.fileState;
    }
  }
  state.messages.set(peerKey, [...byId.values()].sort((a, b) => (a.at || 0) - (b.at || 0)));
}

async function loadHistoryForPeer(peerKey, options = {}) {
  if (!peerKey || !window.feige) return;
  if (state.historyLoading.has(peerKey)) return;
  const prepend = !!options.prepend;
  const before = Number.isFinite(Number(options.before)) ? Number(options.before) : null;
  const box = dom.messages;
  const previousHeight = box.scrollHeight;
  const previousTop = box.scrollTop;
  const epoch = state.historyEpoch;

  state.historyLoading.add(peerKey);
  if (state.active === peerKey) renderMessages(false);

  try {
    const result = await window.feige.loadHistory(peerKey, before, 100);
    if (state.historyEpoch !== epoch) return;
    mergeMessages(peerKey, result && result.messages ? result.messages : []);
    state.historyLoaded.add(peerKey);
    state.historyMore.set(peerKey, !!(result && result.hasMore));
  } catch (error) {
    toast(`加载聊天记录失败：${error.message || error}`, 'error');
  } finally {
    state.historyLoading.delete(peerKey);
  }

  if (state.active !== peerKey) return;
  if (prepend) {
    renderMessages(false);
    box.scrollTop = box.scrollHeight - previousHeight + previousTop;
  } else {
    renderMessages(true, { instant: true });
  }
}

function ensureHistoryLoaded(peerKey) {
  if (!peerKey) return;
  if (state.historyLoaded.has(peerKey) || state.historyLoading.has(peerKey)) return;
  loadHistoryForPeer(peerKey);
}

function loadOlderMessages() {
  const peerKey = state.active;
  if (!peerKey || !state.historyMore.get(peerKey)) return;
  const list = state.messages.get(peerKey) || [];
  if (!list.length) return;
  loadHistoryForPeer(peerKey, { before: list[0].at, prepend: true });
}

function addSystemMessage(peerKey, text) {
  if (!peerKey || !text) return;
  const message = {
    id: `secure-system:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    direction: 'in',
    kind: 'system',
    text,
    at: Date.now(),
  };
  appendMessage(peerKey, message);
  if (state.active === peerKey) appendMessageToDom(message, true);
}

function appendMessageToDom(message, forceScroll = true) {
  if (!state.active || !message) return;
  const box = dom.messages;
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const empty = box.querySelector('.empty-chat');
  if (empty) empty.remove();
  const day = dayKey(message.at);
  const dividers = box.querySelectorAll('.day-divider[data-day]');
  const lastDay = dividers.length ? dividers[dividers.length - 1].dataset.day : '';
  if (day !== lastDay) {
    const divider = document.createElement('div');
    divider.className = 'day-divider';
    divider.dataset.day = day;
    divider.textContent = dayLabel(message.at);
    box.appendChild(divider);
  }
  const wrapper = document.createElement('div');
  wrapper.innerHTML = messageHtml(message);
  const node = wrapper.firstElementChild;
  if (!node) return;
  box.appendChild(node);
  if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
}

function refreshMessageNode(message) {
  if (!state.active || !message) return;
  const row = dom.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (!row) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = messageHtml(message);
  const node = wrapper.firstElementChild;
  if (node) row.replaceWith(node);
}

function refreshMessagesByTransfer(transferId) {
  if (!state.active) return;
  const list = state.messages.get(state.active) || [];
  for (const message of list) {
    if (message.transferId === transferId) refreshMessageNode(message);
  }
}

function updateMessageMetaDom(message) {
  if (!state.active || !message) return;
  const row = dom.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (!row) return;
  const meta = row.querySelector('.msg-meta');
  if (!meta) return;
  meta.innerHTML = `<span>${formatTime(message.at)}</span>${message.direction === 'out' ? messageStatusIcon(message) : ''}`;
}

function scrollToBottom(box, instant = false) {
  if (!box) return;
  if (!instant) {
    box.scrollTop = box.scrollHeight;
    return;
  }
  // CSS 里给 .messages 设了 scroll-behavior: smooth。打开会话时如果
  // 直接赋值 scrollTop，会从第一条平滑滚动到最后一条；这里临时切到
  // auto，先完成定位，再恢复平滑滚动给新消息使用。
  const previous = box.style.scrollBehavior;
  box.style.scrollBehavior = 'auto';
  box.scrollTop = box.scrollHeight;
  void box.scrollTop;
  box.style.scrollBehavior = previous;
}

function renderMessages(forceScroll = false, options = {}) {
  if (!state.active) return;
  const list = state.messages.get(state.active) || [];
  const box = dom.messages;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const loading = state.historyLoading.has(state.active);

  if (!list.length) {
    box.innerHTML = `
      <div class="empty-chat">
        <span class="ico">${icon(loading ? 'clock' : 'send', 24)}</span>
        <b>${loading ? '正在加载聊天记录…' : '还没有消息'}</b>
        <small>${loading ? '从本地历史中读取' : '打个招呼，或者直接拖入文件'}</small>
      </div>`;
    return;
  }

  const chunks = [];
  if (state.historyMore.get(state.active)) {
    chunks.push(`<div class="load-earlier-wrap"><button class="load-earlier" data-load-earlier>${icon('clock', 13)}<span>加载更早的聊天记录</span></button></div>`);
  }
  let lastDay = '';
  for (const message of list) {
    const key = dayKey(message.at);
    if (key !== lastDay) {
      chunks.push(`<div class="day-divider" data-day="${escapeHtml(key)}">${dayLabel(message.at)}</div>`);
      lastDay = key;
    }
    chunks.push(messageHtml(message));
  }
  box.innerHTML = chunks.join('');
  if (forceScroll || nearBottom) {
    scrollToBottom(box, !!options.instant);
  }
}

function messageHtml(message) {
  if (message.kind === 'system') {
    const action = message.action === 'open-secure' && message.secureSessionId
      ? `<button type="button" class="sys-note-action" data-open-secure="${escapeHtml(message.secureSessionId)}">${icon('shield', 13)}<span>打开认证</span></button>`
      : '';
    return `<div class="sys-note ${action ? 'action' : ''}"><span class="sys-note-text">${escapeHtml(message.text)}</span>${action}</div>`;
  }
  const out = message.direction === 'out';
  const meta = `<div class="msg-meta"><span>${formatTime(message.at)}</span>${out ? messageStatusIcon(message) : ''}</div>`;
  const body = message.kind === 'files'
    ? `${message.text ? `<div class="bubble">${linkify(message.text)}</div>` : ''}${fileMessageHtml(message)}`
    : message.kind === 'image'
      ? `${message.text ? `<div class="bubble">${linkify(message.text)}</div>` : ''}${imageMessageHtml(message)}`
      : `<div class="bubble">${linkify(message.text)}</div>`;
  return `<div class="msg-row ${out ? 'out' : ''}" data-message-id="${escapeHtml(message.id)}"><div class="msg-col">${body}${meta}</div></div>`;
}

function messageStatusIcon(message) {
  if (message.status === 'read') {
    return `<span class="msg-status read" title="对方已收到">${icon('check-check', 12)}</span>`;
  }
  if (message.status === 'error') {
    return `<span class="msg-status error" title="发送失败">${icon('alert', 12)}</span>`;
  }
  return `<span class="msg-status" title="已发送">${icon('check', 12)}</span>`;
}

function findMessageById(id) {
  if (!id) return null;
  for (const list of state.messages.values()) {
    const found = list.find((message) => message.id === id);
    if (found) return found;
  }
  return null;
}

function markOfferMessage(offerId, patch) {
  for (const list of state.messages.values()) {
    for (const message of list) {
      if (message.offerId === offerId) Object.assign(message, patch);
    }
  }
}

function addSentFileMessage(peerKey, snapshot) {
  if (!snapshot) return;
  const message = {
    id: `file-out:${snapshot.id}`,
    direction: 'out',
    kind: 'files',
    text: '',
    files: snapshot.files,
    totalBytes: snapshot.totalBytes,
    totalFiles: snapshot.totalFiles,
    totalDirs: snapshot.totalDirs,
    totalEntries: snapshot.totalEntries,
    rootName: snapshot.rootName || '',
    isFolder: !!snapshot.isFolder,
    transferId: snapshot.id,
    at: Date.now(),
  };
  if (appendMessage(peerKey, message)) {
    state.transfers.set(snapshot.id, snapshot);
    if (state.active === peerKey) appendMessageToDom(message, true);
  }
}

export { conversation, appendMessage, mergeMessages, loadHistoryForPeer, ensureHistoryLoaded, loadOlderMessages, addSystemMessage, appendMessageToDom, refreshMessageNode, refreshMessagesByTransfer, updateMessageMetaDom, renderMessages, messageHtml, messageStatusIcon, findMessageById, markOfferMessage, addSentFileMessage };
