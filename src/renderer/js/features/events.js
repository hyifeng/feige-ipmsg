import { t } from '../i18n/index.js';
import { autoGrow, pickAndSend, sendCurrentText, sendPathsToActive, toggleTheme } from './composer.js';
import { toast } from '../core/notifications.js';
import { icon } from '../core/icons.js';
import { dom, mergeSelf, playNotificationSound, state } from '../core/state.js';
import { openAliasModal } from './alias.js';
import { openHistoryModal } from './history.js';
import { chooseImageForActive, handleImagePaste, openImageLightbox, openImageMenu, updateImageCards } from './images.js';
import { addSystemMessage, appendMessage, appendMessageToDom, findMessageById, loadOlderMessages, markOfferMessage, refreshMessageNode, renderMessages, updateMessageMetaDom } from './messages.js';
import { closeModal } from './modals.js';
import { displayName } from '../core/contacts.js';
import { secureReasonText } from '../core/secure-reasons.js';
import { activePeer, applyTheme, clearActiveUnread, peerByKey, renderAll, renderChatHead, renderPeers, renderSelf, selectPeer } from './peers.js';
import { onSecureButton, onSecureWarningButton, openSecureModal, showSecureInfo, startSecure } from './secure.js';
import { openSettings } from './settings.js';
import { closePanel, openPanel, renderTransferBadge, renderTransfers, updateFileCards } from './transfers.js';

function removeSecurePrompt(peerKey, sessionId) {
  if (!sessionId) return;
  state.securePrompts.delete(sessionId);
  const id = `secure-prompt:${sessionId}`;
  const list = state.messages.get(peerKey);
  if (!list) return;
  const index = list.findIndex((message) => message.id === id);
  if (index === -1) return;
  list.splice(index, 1);
  if (state.active === peerKey) renderMessages(false);
}

function handleEvent(event) {
  if (!event || !event.type) return;
  const payload = event.payload;
  if (state.demo) return;

  switch (event.type) {
    case 'ready': {
      state.fatal = '';
      if (payload?.self) mergeSelf(payload.self);
      if (payload?.settings) state.settings = { ...state.settings, ...payload.settings };
      if (Array.isArray(payload?.contacts)) {
        state.contacts = new Map(payload.contacts.map((contact) => [contact.peerKey, contact]));
      }
      if (Array.isArray(payload?.securePairings)) {
        state.securePairings = new Set(payload.securePairings.map((pairing) => pairing.peerKey));
      }
      if (Array.isArray(payload?.secureSessions)) {
        state.securePeers = new Map(payload.secureSessions.map((session) => [session.peerKey, session]));
      }
      state.securePending.clear();
      state.secureWarnings.clear();
      state.securePaused.clear();
      state.secureQueue = [];
      applyTheme(state.settings.theme, false);
      renderAll();
      break;
    }
    case 'self': {
      mergeSelf(payload);
      renderSelf();
      const currentPeer = activePeer();
      if (currentPeer) renderChatHead(currentPeer);
      break;
    }
    case 'settings': {
      state.settings = { ...state.settings, ...payload };
      applyTheme(state.settings.theme, false);
      renderSelf();
      break;
    }
    case 'contacts': {
      if (Array.isArray(payload?.contacts)) {
        state.contacts = new Map(payload.contacts.map((contact) => [contact.peerKey, contact]));
      }
      renderPeers();
      renderTransfers();
      const current = activePeer();
      if (current) renderChatHead(current);
      break;
    }
    case 'peers': {
      state.peers = Array.isArray(payload) ? payload : [];
      if (state.active) {
        const updated = peerByKey(state.active);
        if (updated) {
          state.activePeer = { ...updated };
          renderChatHead(updated);
        }
      }
      renderPeers();
      break;
    }
    case 'message': {
      if (!payload || !payload.peerKey) break;
      const incomingMessage = { ...payload, kind: payload.kind || 'text' };
      appendMessage(payload.peerKey, incomingMessage);
      const isActive = state.active === payload.peerKey;
      if (payload.direction === 'in') {
        playNotificationSound();
        if (!isActive || !document.hasFocus()) {
          state.unread.set(payload.peerKey, (state.unread.get(payload.peerKey) || 0) + 1);
        }
      }
      renderPeers();
      if (isActive) appendMessageToDom(incomingMessage, true);
      break;
    }
    case 'ack': {
      const list = state.messages.get(payload?.peerKey) || [];
      const message = list.find((item) => item.id === payload.messageId);
      if (message) {
        message.status = 'read';
        if (state.active === payload.peerKey) updateMessageMetaDom(message);
      }
      break;
    }
    case 'offer': {
      if (!payload || !payload.id) break;
      playNotificationSound();
      state.offers.set(payload.id, payload);
      const message = {
        id: `offer:${payload.id}`,
        direction: 'in',
        kind: 'files',
        text: payload.text || '',
        files: payload.files,
        totalBytes: payload.totalBytes,
        totalFiles: payload.totalFiles,
        totalDirs: payload.totalDirs,
        totalEntries: payload.totalEntries,
        rootName: payload.rootName || '',
        isFolder: !!payload.isFolder,
        transferId: payload.id,
        offerId: payload.id,
        at: payload.at || Date.now(),
      };
      appendMessage(payload.peerKey, message);
      if (state.active === payload.peerKey) appendMessageToDom(message, true);
      else {
        state.unread.set(payload.peerKey, (state.unread.get(payload.peerKey) || 0) + 1);
      }
      renderPeers();
      renderTransfers();
      if (state.settings.autoAccept) {
        toast(t('event.transfer.autoReceived', { name: displayName(payload.peerKey, payload.peerName) }), 'success');
      } else if (state.active !== payload.peerKey || !document.hasFocus()) {
        // 不抢占当前界面，只在消息列表和系统通知中提示，由用户主动接收。
        toast(t('event.transfer.requestFrom', { name: displayName(payload.peerKey, payload.peerName) }), 'info', {
          label: t('common.view'),
          onClick: () => selectPeer(payload.peerKey),
        });
      }
      break;
    }
    case 'offer-closed': {
      const offer = state.offers.get(payload?.id);
      state.offers.delete(payload?.id);
      markOfferMessage(payload?.id, payload?.reason === 'canceled' ? { canceled: true } : { declined: true });
      if (state.modal && state.modal.type === 'offer' && state.modal.id === payload?.id) closeModal();
      if (state.active) {
        const list = state.messages.get(state.active) || [];
        for (const message of list) {
          if (message.offerId === payload?.id) refreshMessageNode(message);
        }
      }
      renderTransfers();
      if (offer && payload.reason === 'declined') {
        // 本地主动拒绝时由按钮反馈，这里只处理对方取消
      } else if (payload?.reason === 'canceled') {
        toast(t('transfer.requestCanceledByPeer'), 'info');
      }
      break;
    }
    case 'transfer': {
      if (!payload || !payload.id) break;
      const matchingOffer = state.offers.get(payload.id);
      if (matchingOffer) matchingOffer.accepted = true;
      const previous = state.transfers.get(payload.id);
      const statusChanged = !previous || previous.status !== payload.status;
      state.transfers.set(payload.id, payload);
      renderTransferBadge();
      if (state.panelOpen) renderTransfers();
      const list = state.messages.get(state.active) || [];
      if (list.some((message) => message.transferId === payload.id)) {
        if (statusChanged) {
          for (const message of list) {
            if (message.transferId !== payload.id) continue;
            if (message.kind === 'image') updateImageCards(payload);
            else refreshMessageNode(message);
          }
        } else {
          updateFileCards(payload);
          updateImageCards(payload);
        }
      }
      break;
    }
    case 'transfer-done': {
      if (!payload) break;
      if (!payload.image) {
        if (payload.direction === 'in') {
          toast(t('event.transfer.receivedCount', { count: payload.fileCount || 0 }), 'success', payload.root ? {
            label: t('common.openFolder'),
            onClick: () => window.feige.openPath(payload.root),
          } : null);
        } else {
          toast(t('event.transfer.sentTo', { name: payload.peerName || t('common.peer') }), 'success');
        }
      }
      renderTransfers();
      break;
    }
    case 'transfer-error': {
      toast(payload?.message || t('transfer.failed'), 'error');
      renderTransferBadge();
      if (state.panelOpen) renderTransfers();
      break;
    }
    case 'transfer-closed': {
      if (payload?.direction === 'out') {
        toast(t(payload.reason === 'declined' ? 'event.transfer.peerDeclined' : 'common.transferCanceled'), payload.reason === 'declined' ? 'warn' : 'info');
      }
      renderTransfers();
      break;
    }
    case 'fatal': {
      state.fatal = payload?.message || t('event.fatal.networkStart');
      state.self.ready = false;
      renderSelf();
      toast(state.fatal, 'error', { label: t('common.openSettings'), onClick: openSettings });
      break;
    }
    case 'error': {
      toast(payload?.message || t('event.error.generic'), 'error');
      break;
    }
    case 'image-update': {
      if (!payload || !payload.messageId) break;
      const message = findMessageById(payload.messageId);
      if (!message) break;
      Object.assign(message, payload.patch || {});
      if (state.active === payload.peerKey) {
        const transfer = state.transfers.get(message.transferId);
        if (transfer) updateImageCards(transfer);
        else refreshMessageNode(message);
      }
      break;
    }
    case 'secure-pending': {
      if (!payload?.peerKey) break;
      state.securePending.set(payload.peerKey, payload);
      renderPeers();
      const pendingPeer = peerByKey(payload.peerKey);
      if (pendingPeer && state.active === pendingPeer.key) renderChatHead(pendingPeer);
      break;
    }
    case 'secure-sas': {
      if (!payload?.sessionId || !payload?.peerKey) break;
      // 临时会话不要求核对 6 位码；直接等 secure-up 启用加密即可。
      // 用户之后仍可在加密详情里主动发起身份认证。
      if (payload.temporary) break;
      state.securePending.set(payload.peerKey, payload);
      state.secureWarnings.delete(payload.peerKey);
      const sasPeer = peerByKey(payload.peerKey);

      if (payload.incoming) {
        // 对方发起的认证不自动弹窗，只在会话中留下可点击通知。
        state.securePrompts.set(payload.sessionId, payload);
        const prompt = {
          id: `secure-prompt:${payload.sessionId}`,
          direction: 'in',
          kind: 'system',
          action: 'open-secure',
          secureSessionId: payload.sessionId,
          i18nKey: 'event.secure.requestSystem',
          text: t('event.secure.requestSystem'),
          at: Date.now(),
        };
        const added = appendMessage(payload.peerKey, prompt);
        if (added && state.active === payload.peerKey) appendMessageToDom(prompt, true);
        if (added && (state.active !== payload.peerKey || !document.hasFocus())) {
          state.unread.set(payload.peerKey, (state.unread.get(payload.peerKey) || 0) + 1);
        }
        renderPeers();
        if (sasPeer && state.active === payload.peerKey) renderChatHead(sasPeer);
        break;
      }

      renderPeers();
      if (sasPeer && state.active === payload.peerKey) renderChatHead(sasPeer);
      if (state.modal) {
        if (!state.secureQueue.some((item) => item.sessionId === payload.sessionId)) {
          state.secureQueue.push(payload);
        }
        toast(t('event.secure.requestBusy'), 'info');
      } else {
        openSecureModal(payload);
      }
      break;
    }
    case 'secure-peer-confirmed': {
      if (!state.modal || state.modal.type !== 'secure' || state.modal.id !== payload?.sessionId) break;
      state.modal.peerConfirmed = true;
      const status = dom.modalRoot.querySelector('#secureModalStatus');
      if (status) {
        status.textContent = t(state.modal.localConfirmed ? 'secure.status.bothConfirmed' : 'event.secure.peerConfirmed');
        status.classList.remove('warn');
      }
      break;
    }
    case 'secure-up': {
      if (!payload?.peerKey) break;
      const peerKey = payload.peerKey;
      const peerName = payload.peerName || (peerByKey(peerKey) && peerByKey(peerKey).user) || t('common.peer');
      state.securePeers.set(peerKey, payload);
      if (!payload.temporary) state.securePairings.add(peerKey);
      state.securePending.delete(peerKey);
      state.secureWaiting.delete(peerKey);
      state.secureWarnings.delete(peerKey);
      state.securePaused.delete(peerKey);
      state.secureQueue = state.secureQueue.filter((item) => item.sessionId !== payload.sessionId);
      removeSecurePrompt(peerKey, payload.sessionId);
      if (state.modal && state.modal.type === 'secure' && state.modal.id === payload.sessionId) {
        state.modal.settled = true;
        closeModal();
      }
      if (payload.temporary) {
        addSystemMessage(peerKey, 'event.secure.temporarySystem');
        toast(t('event.secure.sessionUnverified', { name: peerName }), 'info');
      } else {
        addSystemMessage(peerKey, payload.mode === 'resume'
          ? 'event.secure.identityRestoredSystem'
          : 'event.secure.identitySavedSystem');
        toast(
          t(payload.mode === 'resume' ? 'event.secure.identityRestoredWith' : 'event.secure.identityVerifiedWith', { name: peerName }),
          'success',
        );
      }
      renderPeers();
      const upPeer = peerByKey(peerKey);
      if (upPeer && state.active === peerKey) renderChatHead(upPeer);
      break;
    }
    case 'secure-down': {
      if (!payload?.peerKey) break;
      const peerKey = payload.peerKey;
      const wasActive = state.securePeers.has(peerKey) || !!payload.wasActive;
      const temporary = !!payload.temporary || !!(state.securePeers.get(peerKey) && state.securePeers.get(peerKey).temporary);
      state.securePeers.delete(peerKey);
      state.securePending.delete(peerKey);
      removeSecurePrompt(peerKey, payload.sessionId);
      if (payload.pairingRemoved) state.securePairings.delete(peerKey);
      state.secureQueue = state.secureQueue.filter((item) => item.sessionId !== payload.sessionId);
      if (state.modal && state.modal.type === 'secure' && state.modal.id === payload.sessionId) {
        state.modal.settled = true;
        closeModal();
      }
      const reason = String(payload.reason || t('secure.reason.sessionClosed'));
      const peerRevoked = reason === '对方已解除认证';
      const selfOffline = reason === '用户下线' || reason === '节点停止';
      const localCancel = reason === '用户取消';
      const peerCancel = reason.includes('对方取消');
      const offline = selfOffline || reason.includes('离线') || reason === '连接超时';
      if (temporary && wasActive && !payload.pairingRemoved) {
        // 临时会话本就不持久化；断开后下一次发送会自动重建，不需要
        // 显示“认证恢复失败”或暂停状态。
        state.secureWarnings.delete(peerKey);
        state.securePaused.delete(peerKey);
      } else if (peerRevoked) {
        state.secureWarnings.set(peerKey, {
          kind: 'revoked',
          title: t('secure.reason.peerRevoked'),
          text: t('event.secure.peerRevoked.text'),
          actionLabel: t('event.secure.resolveAction'),
          canReset: true,
        });
        state.securePaused.delete(peerKey);
        addSystemMessage(peerKey, 'event.secure.peerRevoked.system');
      } else if (payload.pairingRemoved) {
        state.securePaused.delete(peerKey);
        const warning = {
          kind: 'key',
          title: t('event.secure.failedTitle'),
          text: t('event.secure.keyCheckFailed'),
          actionLabel: t('secure.action.reverify'),
        };
        state.secureWarnings.set(peerKey, warning);
        addSystemMessage(peerKey, 'event.secure.warningText', { text: warning.text });
        toast(warning.text, 'error');
      } else if (offline) {
        // 对方离线不是认证失败：暂停会话，等待自动恢复；对方丢失配对时会停止重试。
        state.secureWarnings.delete(peerKey);
        if (wasActive || state.securePairings.has(peerKey)) {
          state.securePaused.set(peerKey, {
            kind: 'offline',
            reason: selfOffline ? 'self-offline' : 'peer-offline',
          });
        }
      } else if (payload.auto && !wasActive) {
        const text = t('event.secure.autoRestoreFailedWithReason', { reason });
        if (!state.secureWarnings.has(peerKey)) {
          state.secureWarnings.set(peerKey, {
            kind: 'resume',
            title: t('event.secure.autoRestoreFailed'),
            text,
            actionLabel: t('secure.action.reverify'),
            canReset: true,
          });
        }
        addSystemMessage(peerKey, 'event.secure.warningText', { text });
        toast(text, 'warn');
      } else if (wasActive) {
        state.secureWarnings.delete(peerKey);
        state.securePaused.set(peerKey, { kind: 'interrupted', reason });
      } else if (peerCancel) {
        toast(t('event.secure.peerCanceled'), 'info');
      } else if (!localCancel) {
        toast(secureReasonText(reason), 'info');
      }
      renderPeers();
      const downPeer = peerByKey(peerKey);
      if (downPeer && state.active === peerKey) renderChatHead(downPeer);
      break;
    }
    case 'secure-authenticated': {
      if (!payload?.peerKey) break;
      const peerKey = payload.peerKey;
      state.securePairings.add(peerKey);
      state.securePending.delete(peerKey);
      state.secureWarnings.delete(peerKey);
      state.securePaused.delete(peerKey);
      state.secureWaiting.delete(peerKey);
      state.secureQueue = state.secureQueue.filter((item) => item.sessionId !== payload.sessionId);
      const active = state.securePeers.get(peerKey);
      if (active) {
        state.securePeers.set(peerKey, {
          ...active,
          temporary: false,
          authenticated: true,
          code: payload.code || active.code,
        });
      }
      removeSecurePrompt(peerKey, payload.sessionId);
      if (state.modal && state.modal.type === 'secure' && state.modal.id === payload.sessionId) {
        state.modal.settled = true;
        closeModal();
      }
      const peerName = payload.peerName || (peerByKey(peerKey) && peerByKey(peerKey).user) || t('common.peer');
      addSystemMessage(peerKey, 'event.secure.identitySavedSystem');
      toast(t('event.secure.identityVerifiedWith', { name: peerName }), 'success');
      renderPeers();
      const authPeer = peerByKey(peerKey);
      if (authPeer && state.active === peerKey) renderChatHead(authPeer);
      break;
    }
    case 'secure-warning': {
      const info = payload || {};
      if (info.peerKey && state.secureWaiting.has(info.peerKey)) break;
      const code = info.code;
      if (info.peerKey && ['no-pairing', 'auth-failed', 'pairing-exists'].includes(code)) {
        const defaults = {
          'no-pairing': {
            title: t('event.secure.restoreUnavailableTitle'),
            text: t('event.secure.noPairingHelp'),
          },
          'auth-failed': {
            title: t('event.secure.failedTitle'),
            text: t('event.secure.pairingMismatchHelp'),
          },
          'pairing-exists': {
            title: t('event.secure.reverifyRequestedTitle'),
            text: t('event.secure.pairingExistsHelp'),
          },
        };
        const revoked = code === 'no-pairing';
        const fallback = revoked
          ? {
            title: t('secure.reason.peerRevoked'),
            text: t('event.secure.peerRevoked.text'),
          }
          : defaults[code];
        const text = revoked ? fallback.text : (info.message || fallback.text);
        const canReset = info.canReset !== false;
        const previous = state.secureWarnings.get(info.peerKey);
        const kind = revoked ? 'revoked' : 'resume';
        const duplicate = !!previous && previous.kind === kind && previous.text === text;
        state.secureWarnings.set(info.peerKey, {
          kind,
          title: code === 'pairing-exists' && !canReset ? t('event.secure.waitingReverify') : fallback.title,
          text,
          actionLabel: canReset ? t('event.secure.resolveAction') : '',
          canReset,
        });
        if (revoked) state.securePaused.delete(info.peerKey);
        if (!duplicate) {
          addSystemMessage(info.peerKey, revoked ? 'event.secure.peerRevoked.system' : 'event.secure.warningText', { text });
          if (!revoked) toast(text, 'error');
        }
        renderPeers();
        const warningPeer = peerByKey(info.peerKey);
        if (warningPeer && state.active === info.peerKey) renderChatHead(warningPeer);
      } else {
        toast(info.message || t('event.secure.warning'), 'warn');
        if (info.peerKey) addSystemMessage(info.peerKey, 'event.secure.warningText', { text: info.message || t('event.secure.warning') });
      }
      break;
    }
    default:
      break;
  }
}

let peerMenuElement = null;
let peerMenuCleanup = null;

function closePeerMenu() {
  if (peerMenuCleanup) {
    peerMenuCleanup();
    peerMenuCleanup = null;
  }
  if (peerMenuElement) {
    peerMenuElement.remove();
    peerMenuElement = null;
  }
}

function openPeerMenu(event) {
  closePeerMenu();
  const menu = document.createElement('div');
  menu.className = 'image-menu peer-menu';
  menu.innerHTML = `<button type="button" data-peer-refresh>${icon('refresh', 15)}<span>${t('event.peerMenu.refresh')}</span></button>`;
  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  peerMenuElement = menu;

  const onPointer = (pointerEvent) => {
    if (!menu.contains(pointerEvent.target)) closePeerMenu();
  };
  const onKey = (keyEvent) => {
    if (keyEvent.key === 'Escape') closePeerMenu();
  };
  const onScroll = () => closePeerMenu();
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', onScroll);
  window.addEventListener('scroll', onScroll, true);
  peerMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', onScroll);
    window.removeEventListener('scroll', onScroll, true);
  };

  menu.addEventListener('click', async (clickEvent) => {
    if (!clickEvent.target.closest('[data-peer-refresh]')) return;
    closePeerMenu();
    try {
      await window.feige.refreshDiscovery();
      toast(t('event.peerMenu.refreshed'), 'success');
    } catch (error) {
      toast(error.message || t('event.peerMenu.refreshFailed'), 'error');
    }
  });
}

async function acceptOfferFromList(offerId, button = null) {
  const offer = state.offers.get(offerId);
  if (!offer || offer.accepted) return;
  const original = button ? button.innerHTML : '';
  if (button) {
    button.disabled = true;
    button.textContent = t('event.offer.receiving');
  }
  try {
    const snapshot = await window.feige.acceptOffer(offer.id);
    offer.accepted = true;
    if (snapshot) state.transfers.set(snapshot.id, snapshot);
    refreshMessagesByTransfer(offer.id);
    renderTransfers();
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
    toast(error.message || t('transfer.receiveFailed'), 'error');
  }
}

function bindStaticEvents() {
  dom.peerSearch.addEventListener('input', () => {
    state.filter = dom.peerSearch.value;
    renderPeers();
  });

  dom.peerList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-peer]');
    if (item) selectPeer(item.dataset.peer);
  });

  dom.peerList.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openPeerMenu(event);
  });

  dom.selfCard.addEventListener('click', openSettings);
  dom.settingsBtn.addEventListener('click', openSettings);
  dom.historyBtn.addEventListener('click', openHistoryModal);
  dom.themeBtn.addEventListener('click', toggleTheme);
  dom.transferToggle.addEventListener('click', () => (state.panelOpen ? closePanel() : openPanel()));
  dom.chatTransferBtn.addEventListener('click', () => (state.panelOpen ? closePanel() : openPanel()));
  dom.closeTransfers.addEventListener('click', closePanel);
  dom.panelScrim.addEventListener('click', closePanel);

  dom.chatAliasBtn.addEventListener('click', () => openAliasModal(activePeer()));

  dom.secureBtn.addEventListener('click', onSecureButton);
  dom.secureBannerBtn.addEventListener('click', () => {
    const peer = activePeer();
    if (!peer) return;
    const warning = state.secureWarnings.get(peer.key);
    if (warning) {
      onSecureWarningButton(peer.key);
      return;
    }
    if (state.securePeers.has(peer.key)) showSecureInfo(peer.key);
    else startSecure(peer.key);
  });

  dom.sendBtn.addEventListener('click', sendCurrentText);
  dom.attachImageBtn.addEventListener('click', chooseImageForActive);
  dom.attachFileBtn.addEventListener('click', () => pickAndSend('files'));
  dom.attachFolderBtn.addEventListener('click', () => pickAndSend('folder'));
  dom.sendFileBtn.addEventListener('click', () => pickAndSend('files'));
  dom.sendFolderBtn.addEventListener('click', () => pickAndSend('folder'));

  dom.messageInput.addEventListener('input', autoGrow);
  dom.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendCurrentText();
    }
  });

  dom.chat.addEventListener('paste', handleImagePaste);

  dom.messages.addEventListener('contextmenu', (event) => {
    const image = event.target.closest('[data-image-open]');
    if (!image || state.demo) return;
    event.preventDefault();
    const row = image.closest('[data-message-id]');
    const message = findMessageById(row && row.dataset.messageId);
    if (message) openImageMenu(event, message);
  });

  dom.messages.addEventListener('click', async (event) => {
    const securePrompt = event.target.closest('[data-open-secure]');
    if (securePrompt) {
      const sessionId = securePrompt.dataset.openSecure;
      const info = state.securePrompts.get(sessionId);
      if (!info) {
        toast(t('event.verificationRequestExpired'), 'warn');
        return;
      }
      openSecureModal(info);
      return;
    }
    const imageTarget = event.target.closest('[data-image-open]');
    if (imageTarget) {
      const row = imageTarget.closest('[data-message-id]');
      const message = findMessageById(row && row.dataset.messageId);
      if (message) {
        openImageLightbox(message);
        return;
      }
    }
    const earlier = event.target.closest('[data-load-earlier]');
    if (earlier) {
      loadOlderMessages();
      return;
    }
    const link = event.target.closest('a[data-external]');
    if (link) {
      event.preventDefault();
      window.feige.openExternal?.(link.dataset.external);
      return;
    }
    const accept = event.target.closest('[data-accept-offer]');
    if (accept) {
      await acceptOfferFromList(accept.dataset.acceptOffer, accept);
      return;
    }
    const decline = event.target.closest('[data-decline-offer]');
    if (decline) {
      const id = decline.dataset.declineOffer;
      try {
        await window.feige.declineOffer(id);
        state.offers.delete(id);
        markOfferMessage(id, { declined: true });
        renderMessages(false);
        renderTransfers();
      } catch (error) {
        toast(error.message || t('event.error.operationFailed'), 'error');
      }
      return;
    }
    const open = event.target.closest('[data-open-root]');
    if (open) {
      window.feige.openPath(open.dataset.openRoot);
    }
  });

  dom.transferList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-tc-action]');
    if (!button) return;
    const action = button.dataset.tcAction;
    if (action === 'open') {
      window.feige.openPath(button.dataset.path);
    } else if (action === 'cancel') {
      try {
        await window.feige.cancelTransfer(button.dataset.id);
      } catch (error) {
        toast(error.message || t('event.error.cancelFailed'), 'error');
      }
    } else if (action === 'offer') {
      await acceptOfferFromList(button.dataset.id, button);
    } else if (action === 'decline') {
      const id = button.dataset.id;
      try {
        await window.feige.declineOffer(id);
        state.offers.delete(id);
        markOfferMessage(id, { declined: true });
        renderTransfers();
        if (state.active) renderMessages(false);
      } catch (error) {
        toast(error.message || t('event.error.operationFailed'), 'error');
      }
    }
  });

  dom.modalRoot.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) {
      closeModal();
      return;
    }
    if (event.target.matches('[data-modal-backdrop]')) closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.modal) closeModal();
      else if (state.panelOpen) closePanel();
      return;
    }
    if (event.key === '/' && !isTyping(event.target) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      dom.peerSearch.focus();
    }
  });

  window.addEventListener('focus', clearActiveUnread);

  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    const peer = peerByKey(state.active);
    if (!peer || !peer.online) return;
    state.sidebarDragDepth += 1;
    dom.dropOverlay.classList.remove('is-hidden');
    dom.dropText.textContent = t('event.drop.target', { name: peer.user });
  });
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    state.sidebarDragDepth = Math.max(0, state.sidebarDragDepth - 1);
    if (!state.sidebarDragDepth) dom.dropOverlay.classList.add('is-hidden');
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    state.sidebarDragDepth = 0;
    dom.dropOverlay.classList.add('is-hidden');
    const peer = peerByKey(state.active);
    if (!peer || !peer.online) {
      toast(t('common.selectOnlinePeer'), 'warn');
      return;
    }
    const files = [...(event.dataTransfer?.files || [])];
    const paths = files.map((file) => window.feige.pathForFile(file)).filter(Boolean);
    if (!paths.length) {
      toast(t('event.drop.noPaths'), 'warn');
      return;
    }
    await sendPathsToActive(paths);
  });
}

function isTyping(element) {
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable;
}

export { handleEvent, bindStaticEvents, isTyping };
