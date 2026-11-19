'use strict';

const { ipcMain } = require('electron');
const {
  normalizePreference,
  readLanguagePreference,
  resolveLanguage,
  writeLanguage,
} = require('../language');
const { setLocale } = require('../../i18n');
const { refreshShellLanguage } = require('../shell');

function registerLanguageIpc(ctx) {
  ipcMain.handle('feige:get-language', () => {
    const preference = readLanguagePreference(ctx.app);
    return { preference, locale: resolveLanguage(ctx.app, preference) };
  });

  ipcMain.handle('feige:set-language', (_event, language) => {
    const preference = normalizePreference(language);
    const locale = resolveLanguage(ctx.app, preference);
    setLocale(locale);
    writeLanguage(ctx.app, preference);
    refreshShellLanguage(ctx);
    return { preference, locale };
  });
}

module.exports = { registerLanguageIpc };
