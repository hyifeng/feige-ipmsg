'use strict';

const { ipcMain } = require('electron');
const { writeLanguage } = require('../language');
const { getLocale, setLocale } = require('../../i18n');
const { refreshShellLanguage } = require('../shell');

function registerLanguageIpc(ctx) {
  ipcMain.handle('feige:get-language', () => getLocale());

  ipcMain.handle('feige:set-language', (_event, language) => {
    const value = setLocale(language);
    writeLanguage(ctx.app, value);
    refreshShellLanguage(ctx);
    return value;
  });
}

module.exports = { registerLanguageIpc };
