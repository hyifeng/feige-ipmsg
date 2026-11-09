'use strict';

const { ipcMain, dialog } = require('electron');
const { saveSettings, sanitizePatch } = require('../settings');
const { selfInfo, emit, friendlyNetworkError } = require('../info');
const { buildStateSnapshot } = require('../snapshot');

function registerStateIpc(ctx) {
  ipcMain.handle('feige:state', async () => buildStateSnapshot(ctx));

  ipcMain.handle('feige:update-settings', async (_event, patch = {}) => {
    const clean = sanitizePatch(patch);
    const nicknameChanged = clean.nickname != null && clean.nickname !== ctx.settings.nickname;
    const portChanged = clean.port != null && clean.port !== ctx.settings.port;
    const hubChanged = (clean.lanEnabled != null && clean.lanEnabled !== ctx.settings.lanEnabled)
      || (clean.hubEnabled != null && clean.hubEnabled !== ctx.settings.hubEnabled)
      || (clean.hubUrl != null && clean.hubUrl !== ctx.settings.hubUrl)
      || (clean.hubStunUrl != null && clean.hubStunUrl !== ctx.settings.hubStunUrl);
    Object.assign(ctx.settings, clean);
    saveSettings(ctx);
    emit(ctx, 'settings', ctx.settings);

    if (ctx.node) {
      ctx.node.user = ctx.settings.nickname;
      ctx.node.downloadDir = ctx.settings.downloadDir;
      ctx.node.autoAccept = ctx.settings.autoAccept;
    }

    if (portChanged || hubChanged || !ctx.node) {
      try {
        await ctx.nodeService.start();
        emit(ctx, 'ready', {
          self: selfInfo(ctx),
          settings: ctx.settings,
          contacts: ctx.contacts ? ctx.contacts.list() : [],
          securePairings: ctx.node.secure.listPairings(),
          secureSessions: ctx.node.secure.getActiveSessions(),
        });
      } catch (err) {
        emit(ctx, 'fatal', { message: friendlyNetworkError(ctx, err) });
        throw new Error(friendlyNetworkError(ctx, err));
      }
    } else if (nicknameChanged) {
      ctx.node.updateProfile();
    }

    emit(ctx, 'self', selfInfo(ctx));
    return ctx.settings;
  });

  ipcMain.handle('feige:refresh-discovery', () => {
    if (!ctx.node) throw new Error('网络尚未就绪');
    ctx.node.refresh();
    return true;
  });

  ipcMain.handle('feige:choose-dir', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(ctx.win, {
      title: '选择保存位置',
      buttonLabel: '选择文件夹',
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : ctx.settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
}

module.exports = { registerStateIpc };
