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
        toast(`已自动接收来自 ${displayName(payload.peerKey, payload.peerName)} 的文件`, 'success');
      } else if (state.active !== payload.peerKey || !document.hasFocus()) {
        // 不抢占当前界面，只在消息列表和系统通知中提示，由用户主动接收。
        toast(`收到 ${displayName(payload.peerKey, payload.peerName)} 的文件传输请求`, 'info', {
          label: '查看',
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
        toast('对方取消了传输请求', 'info');
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
          toast(`已接收 ${payload.fileCount || 0} 个文件`, 'success', payload.root ? {
            label: '打开文件夹',
            onClick: () => window.feige.openPath(payload.root),
          } : null);
        } else {
          toast(`已发送给 ${payload.peerName || '对方'}`, 'success');
        }
      }
      renderTransfers();
      break;
    }
    case 'transfer-error': {
      toast(payload?.message || '传输失败', 'error');
      renderTransferBadge();
      if (state.panelOpen) renderTransfers();
      break;
    }
    case 'transfer-closed': {
      if (payload?.direction === 'out') {
        toast(payload.reason === 'declined' ? '对方拒绝了传输' : '传输已取消', payload.reason === 'declined' ? 'warn' : 'info');
      }
      renderTransfers();
      break;
    }
    case 'fatal': {
      state.fatal = payload?.message || '网络启动失败';
      state.self.ready = false;
      renderSelf();
      toast(state.fatal, 'error', { label: '打开设置', onClick: openSettings });
      break;
    }
    case 'error': {
      toast(payload?.message || '发生错误', 'error');
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
          text: '对方请求认证身份。点击「打开认证」核对 6 位码。',
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
        toast('收到认证请求，请先处理当前弹窗', 'info');
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
        status.textContent = state.modal.localConfirmed ? '双方已确认，正在完成认证…' : '对方已确认，请核对后确认';
        status.classList.remove('warn');
      }
      break;
    }
    case 'secure-up': {
      if (!payload?.peerKey) break;
      const peerKey = payload.peerKey;
      const peerName = payload.peerName || (peerByKey(peerKey) && peerByKey(peerKey).user) || '对方';
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
        addSystemMessage(peerKey, '⚠ 身份未认证：消息会自动加密，可核对 6 位码完成认证');
        toast(`已与 ${peerName} 建立会话，身份尚未认证`, 'info');
      } else {
        addSystemMessage(peerKey, `🛡 ${payload.mode === 'resume' ? '已恢复身份认证' : '已完成身份认证'}`);
        toast(
          payload.mode === 'resume' ? `已恢复与 ${peerName} 的身份认证` : `已与 ${peerName} 完成身份认证`,
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
      const reason = String(payload.reason || '会话已断开');
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
          title: '对方已解除认证',
          text: '对方已解除本机认证。你可以重新认证，也可以只解除本机保存的旧认证。',
          actionLabel: '处理认证',
          canReset: true,
        });
        state.securePaused.delete(peerKey);
        addSystemMessage(peerKey, '🔓 对方已解除本机认证，请重新认证');
      } else if (payload.pairingRemoved) {
        state.securePaused.delete(peerKey);
        const warning = {
          kind: 'key',
          title: '身份认证失败',
          text: '认证密钥校验失败，会话已断开；请重新认证身份',
          actionLabel: '重新认证',
        };
        state.secureWarnings.set(peerKey, warning);
        addSystemMessage(peerKey, `⚠ ${warning.text}`);
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
        const text = `自动恢复身份认证失败：${reason}`;
        if (!state.secureWarnings.has(peerKey)) {
          state.secureWarnings.set(peerKey, {
            kind: 'resume',
            title: '自动恢复身份认证失败',
            text,
            actionLabel: '重新认证',
            canReset: true,
          });
        }
        addSystemMessage(peerKey, `⚠ ${text}`);
        toast(text, 'warn');
      } else if (wasActive) {
        state.secureWarnings.delete(peerKey);
        state.securePaused.set(peerKey, { kind: 'interrupted', reason });
      } else if (peerCancel) {
        toast('对方取消了身份认证', 'info');
      } else if (!localCancel) {
        toast(reason, 'info');
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
      const peerName = payload.peerName || (peerByKey(peerKey) && peerByKey(peerKey).user) || '对方';
      addSystemMessage(peerKey, '🛡 已完成身份认证，认证关系已保存');
      toast(`已与 ${peerName} 完成身份认证`, 'success');
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
            title: '无法恢复身份认证',
            text: '本机保存了配对，但对端没有；请选择重新认证。',
          },
          'auth-failed': {
            title: '身份认证失败',
            text: '双方配对密钥可能不一致；如双方都提示失败，请双方都在本机选择重新认证。',
          },
          'pairing-exists': {
            title: '对方请求重新认证',
            text: '本机仍保存旧认证。点击「重新认证」会先解除本机旧认证，再重新建立。',
          },
        };
        const revoked = code === 'no-pairing';
        const fallback = revoked
          ? {
            title: '对方已解除认证',
            text: '对方已解除本机认证。你可以重新认证，也可以只解除本机保存的旧认证。',
          }
          : defaults[code];
        const text = revoked ? fallback.text : (info.message || fallback.text);
        const canReset = info.canReset !== false;
        const previous = state.secureWarnings.get(info.peerKey);
        const kind = revoked ? 'revoked' : 'resume';
        const duplicate = !!previous && previous.kind === kind && previous.text === text;
        state.secureWarnings.set(info.peerKey, {
          kind,
          title: code === 'pairing-exists' && !canReset ? '等待对方重新认证' : fallback.title,
          text,
          actionLabel: canReset ? '处理认证' : '',
          canReset,
        });
        if (revoked) state.securePaused.delete(info.peerKey);
        if (!duplicate) {
          addSystemMessage(info.peerKey, revoked ? '🔓 对方已解除本机认证，请重新认证' : `⚠ ${text}`);
          if (!revoked) toast(text, 'error');
        }
        renderPeers();
        const warningPeer = peerByKey(info.peerKey);
        if (warningPeer && state.active === info.peerKey) renderChatHead(warningPeer);
      } else {
        toast(info.message || '身份认证警告', 'warn');
        if (info.peerKey) addSystemMessage(info.peerKey, `⚠ ${info.message || '身份认证警告'}`);
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
  menu.innerHTML = `<button type="button" data-peer-refresh>${icon('refresh', 15)}<span>刷新列表</span></button>`;
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
      toast('已广播刷新', 'success');
    } catch (error) {
      toast(error.message || '刷新失败', 'error');
    }
  });
}

async function acceptOfferFromList(offerId, button = null) {
  const offer = state.offers.get(offerId);
  if (!offer || offer.accepted) return;
  const original = button ? button.innerHTML : '';
  if (button) {
    button.disabled = true;
    button.textContent = '接收中…';
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
    toast(error.message || '接收失败', 'error');
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
        toast('认证请求已失效', 'warn');
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
        toast(error.message || '操作失败', 'error');
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
        toast(error.message || '取消失败', 'error');
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
        toast(error.message || '操作失败', 'error');
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
    dom.dropText.textContent = `文件将发送给 ${peer.user}`;
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
      toast('请先选择一位在线同事', 'warn');
      return;
    }
    const files = [...(event.dataTransfer?.files || [])];
    const paths = files.map((file) => window.feige.pathForFile(file)).filter(Boolean);
    if (!paths.length) {
      toast('没有读取到文件路径，请尝试使用“发送文件夹”按钮', 'warn');
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
