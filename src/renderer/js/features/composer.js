import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { addSentFileMessage } from './messages.js';
import { activePeer, applyTheme, peerByKey, renderChatHead, renderSelf } from './peers.js';
import { renderTransfers } from './transfers.js';

async function sendCurrentText() {
  if (!state.self.online) {
    toast('已下线，上线后才能发送消息', 'warn');
    return;
  }
  const text = dom.messageInput.value.trim();
  if (!text || !state.active) return;
  const peer = peerByKey(state.active);
  if (!peer || !peer.online) {
    toast('对方已离线，无法发送', 'warn');
    return;
  }
  dom.messageInput.value = '';
  autoGrow();
  try {
    await window.feige.sendText(state.active, text);
  } catch (error) {
    toast(error.message || '发送失败', 'error');
    dom.messageInput.value = text;
    autoGrow();
  }
}

async function pickAndSend(kind) {
  if (!state.self.online) {
    toast('已下线，上线后才能发送文件', 'warn');
    return;
  }
  const peer = peerByKey(state.active);
  if (!peer || !peer.online) {
    toast('对方不在线', 'warn');
    return;
  }
  try {
    const snapshot = await window.feige.pickSend(peer.key, kind);
    if (!snapshot) return;
    addSentFileMessage(peer.key, snapshot);
    renderTransfers();
    toast('已发出传输请求，等待对方接收', 'success');
  } catch (error) {
    toast(error.message || '发送失败', 'error');
  }
}

async function sendPathsToActive(paths) {
  if (!state.self.online) {
    toast('已下线，上线后才能发送文件', 'warn');
    return;
  }
  const peer = peerByKey(state.active);
  if (!peer || !peer.online) {
    toast('请先选择一位在线同事', 'warn');
    return;
  }
  if (!paths || !paths.length) {
    toast('没有可发送的文件', 'warn');
    return;
  }
  try {
    const snapshot = await window.feige.sendPaths(peer.key, paths);
    if (!snapshot) return;
    addSentFileMessage(peer.key, snapshot);
    renderTransfers();
    toast('已发出传输请求，等待对方接收', 'success');
  } catch (error) {
    toast(error.message || '发送失败', 'error');
  }
}

function autoGrow() {
  const input = dom.messageInput;
  input.style.height = 'auto';
  input.style.height = `${Math.min(132, Math.max(38, input.scrollHeight))}px`;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  state.settings.theme = next;
  window.feige?.updateSettings({ theme: next }).catch(() => {});
}

export { sendCurrentText, pickAndSend, sendPathsToActive, autoGrow, toggleTheme };
