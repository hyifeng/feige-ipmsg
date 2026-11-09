'use strict';

const { ipcMain, dialog } = require('electron');

function requireNode(ctx) {
  if (!ctx.node) throw new Error('网络尚未就绪');
  return ctx.node;
}

function registerTransferIpc(ctx) {
  ipcMain.handle('feige:send-text', (_event, payload = {}) => {
    const node = requireNode(ctx);
    return node.sendText(String(payload.peerKey || ''), String(payload.text == null ? '' : payload.text));
  });

  ipcMain.handle('feige:pick-send', async (_event, payload = {}) => {
    requireNode(ctx);
    const kind = payload.kind === 'folder' ? 'folder' : 'files';
    const result = await dialog.showOpenDialog(ctx.win, {
      title: kind === 'folder' ? '选择要发送的文件夹' : '选择要发送的文件',
      buttonLabel: '发送',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return ctx.nodeService.sendPathsWithHistory(String(payload.peerKey || ''), result.filePaths);
  });

  ipcMain.handle('feige:send-paths', (_event, payload = {}) => {
    requireNode(ctx);
    const paths = Array.isArray(payload.paths)
      ? payload.paths.filter((item) => typeof item === 'string' && item.length < 4096).slice(0, 200)
      : [];
    return ctx.nodeService.sendPathsWithHistory(
      String(payload.peerKey || ''),
      paths,
      String(payload.caption || ''),
    );
  });

  ipcMain.handle('feige:accept-offer', async (_event, payload = {}) => {
    const node = requireNode(ctx);
    return node.acceptOffer(String(payload.id || ''), typeof payload.saveDir === 'string' ? payload.saveDir : '');
  });

  ipcMain.handle('feige:decline-offer', (_event, offerId) => {
    if (!ctx.node) return false;
    return ctx.node.declineOffer(String(offerId || ''));
  });

  ipcMain.handle('feige:cancel-transfer', (_event, transferId) => {
    if (!ctx.node) return false;
    return ctx.node.cancelTransfer(String(transferId || ''));
  });
}

module.exports = { registerTransferIpc };
