'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function friendlyIpcError(error) {
  const raw = error && error.message ? error.message : String(error || '');
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || '操作失败';
}

// IPC 抛出的原始错误会带上 “Error invoking remote method ...” 前缀。
// 在 preload 边界统一清理，避免实现细节出现在用户提示中。
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    throw new Error(friendlyIpcError(error));
  });
}

contextBridge.exposeInMainWorld('feige', {
  localPassStatus: () => invoke('feige:local-pass-status'),
  localPassSetup: (payload) => invoke('feige:local-pass-setup', payload),
  localPassUnlock: (payload) => invoke('feige:local-pass-unlock', payload),
  localPassSecurity: () => invoke('feige:local-pass-security'),
  setAutoUnlock: (enabled) => invoke('feige:set-auto-unlock', enabled),
  changeLocalPass: (payload) => invoke('feige:local-pass-change', payload),

  state: () => invoke('feige:state'),

  sendText: (peerKey, text) => invoke('feige:send-text', { peerKey, text }),
  pickSend: (peerKey, kind) => invoke('feige:pick-send', { peerKey, kind }),
  sendPaths: (peerKey, paths, caption = '') => invoke('feige:send-paths', { peerKey, paths, caption }),

  acceptOffer: (id, saveDir = '') => invoke('feige:accept-offer', { id, saveDir }),
  declineOffer: (id) => invoke('feige:decline-offer', id),
  cancelTransfer: (id) => invoke('feige:cancel-transfer', id),

  updateSettings: (patch) => invoke('feige:update-settings', patch),
  refreshDiscovery: () => invoke('feige:refresh-discovery'),
  chooseDir: (defaultPath) => invoke('feige:choose-dir', defaultPath),

  contactsList: () => invoke('feige:contacts-list'),
  setAlias: (peerKey, alias, claimed = '') => invoke('feige:contacts-set-alias', { peerKey, alias, claimed }),
  removeAlias: (peerKey, claimed = '') => invoke('feige:contacts-remove-alias', { peerKey, claimed }),

  historyContacts: () => invoke('feige:history-contacts'),
  loadHistory: (peerKey, before = null, limit = 100) => invoke('feige:history-load', { peerKey, before, limit }),
  searchHistory: (query) => invoke('feige:history-search', query),
  clearHistory: () => invoke('feige:history-clear'),

  secureStart: (peerKey) => invoke('feige:secure-start', peerKey),
  secureConfirm: (sessionId) => invoke('feige:secure-confirm', sessionId),
  secureCancel: (sessionId) => invoke('feige:secure-cancel', sessionId),
  secureRevoke: (peerKey) => invoke('feige:secure-revoke', peerKey),
  secureReset: (peerKey) => invoke('feige:secure-reset', peerKey),

  pickImage: () => invoke('feige:pick-image'),
  savePastedImage: (payload) => invoke('feige:save-pasted-image', payload),
  sendImage: (payload) => invoke('feige:send-image', payload),
  readImage: (target) => invoke('feige:read-image', target),
  saveFileCopy: (payload) => invoke('feige:save-file-copy', payload),

  openPath: (target) => invoke('feige:open-path', target),
  openExternal: (url) => invoke('feige:open-external', url),
  showInFolder: (target) => invoke('feige:show-in-folder', target),
  getVersion: () => invoke('feige:version'),

  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  onEvent: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch (err) {
        console.error('[feige] renderer event handler error', err);
      }
    };
    ipcRenderer.on('feige:event', listener);
    return () => ipcRenderer.removeListener('feige:event', listener);
  },
});
