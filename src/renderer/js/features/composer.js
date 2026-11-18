import { t } from '../i18n/index.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { addSentFileMessage } from './messages.js';
import { activePeer, applyTheme, peerByKey, renderChatHead, renderSelf } from './peers.js';
import { renderTransfers } from './transfers.js';

async function sendCurrentText() {
  if (!state.self.online) {
    toast(t('composer.offline.sendMessages'), 'warn');
    return;
  }
  const text = dom.messageInput.value.trim();
  if (!text || !state.active) return;
  const peer = peerByKey(state.active);
  if (!peer || !peer.online) {
    toast(t('composer.peerIsOfflineCannotSend'), 'warn');
    return;
  }
  dom.messageInput.value = '';
  autoGrow();
  try {
    await window.feige.sendText(state.active, text);
  } catch (error) {
    toast(error.message || t('chat.sendFailed'), 'error');
    dom.messageInput.value = text;
    autoGrow();
  }
}

async function pickAndSend(kind) {
  if (!state.self.online) {
    toast(t('composer.offline.sendFiles'), 'warn');
    return;
  }
  const peer = peerByKey(state.active);
  if (!peer || !peer.online) {
    toast(t('composer.peerIsOffline'), 'warn');
    return;
  }
  try {
    const snapshot = await window.feige.pickSend(peer.key, kind);
    if (!snapshot) return;
    addSentFileMessage(peer.key, snapshot);
    renderTransfers();
    toast(t('composer.transferRequestSent'), 'success');
  } catch (error) {
    toast(error.message || t('chat.sendFailed'), 'error');
  }
}

async function sendPathsToActive(paths) {
  if (!state.self.online) {
    toast(t('composer.offline.sendFiles'), 'warn');
    return;
  }
  const peer = peerByKey(state.active);
  if (!peer || !peer.online) {
    toast(t('common.selectOnlinePeer'), 'warn');
    return;
  }
  if (!paths || !paths.length) {
    toast(t('common.noFilesToSend'), 'warn');
    return;
  }
  try {
    const snapshot = await window.feige.sendPaths(peer.key, paths);
    if (!snapshot) return;
    addSentFileMessage(peer.key, snapshot);
    renderTransfers();
    toast(t('composer.transferRequestSent'), 'success');
  } catch (error) {
    toast(error.message || t('chat.sendFailed'), 'error');
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
