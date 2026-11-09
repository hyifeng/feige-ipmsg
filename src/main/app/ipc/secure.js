'use strict';

const { ipcMain } = require('electron');

function registerSecureIpc(ctx) {
  ipcMain.handle('feige:secure-start', async (_event, peerKey) => {
    if (!ctx.node) throw new Error('网络尚未就绪');
    return ctx.node.secure.start(String(peerKey || ''));
  });

  ipcMain.handle('feige:secure-confirm', (_event, sessionId) => {
    if (!ctx.node) return false;
    return ctx.node.secure.confirm(String(sessionId || ''));
  });

  ipcMain.handle('feige:secure-cancel', (_event, sessionId) => {
    if (!ctx.node) return false;
    return ctx.node.secure.cancel(String(sessionId || ''), '用户取消');
  });

  ipcMain.handle('feige:secure-revoke', async (_event, peerKey) => {
    if (!ctx.node) return false;
    return ctx.node.secure.revokePairing(String(peerKey || ''));
  });

  ipcMain.handle('feige:secure-reset', (_event, peerKey) => {
    if (!ctx.node) return false;
    return ctx.node.secure.resetPairing(String(peerKey || ''));
  });
}

module.exports = { registerSecureIpc };
