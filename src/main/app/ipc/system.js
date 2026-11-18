'use strict';

const { ipcMain, shell } = require('electron');
const { t } = require('../../i18n');

function registerSystemIpc(ctx) {
  ipcMain.handle('feige:open-path', async (_event, target) => {
    if (typeof target !== 'string' || !target) return t('main.error.emptyPath');
    return shell.openPath(target);
  });

  ipcMain.handle('feige:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url).then(() => true).catch(() => false);
    }
    return false;
  });

  ipcMain.handle('feige:show-in-folder', (_event, target) => {
    if (typeof target === 'string' && target) {
      shell.showItemInFolder(target);
      return true;
    }
    return false;
  });

  ipcMain.handle('feige:version', () => ctx.app.getVersion());
}

module.exports = { registerSystemIpc };
