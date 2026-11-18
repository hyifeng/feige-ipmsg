'use strict';

const fs = require('node:fs');
const { Menu, Notification, Tray, nativeImage } = require('electron');
const { ICON_PATH } = require('./config');
const { t } = require('../i18n');

function showMainWindow(ctx) {
  const { win } = ctx;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function notify(ctx, title, body) {
  const { win } = ctx;
  if (!win || win.isDestroyed() || win.isFocused()) return;
  try {
    const notification = new Notification({ title, body, icon: ICON_PATH, silent: true });
    notification.on('click', () => showMainWindow(ctx));
    notification.show();
  } catch {
    /* 通知中心不可用 */
  }
}

function trayMenu(ctx) {
  return Menu.buildFromTemplate([
    { label: t('main.tray.show'), click: () => showMainWindow(ctx) },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: () => ctx.app.quit() },
  ]);
}

function refreshShellLanguage(ctx) {
  if (ctx.win && !ctx.win.isDestroyed()) {
    ctx.win.setTitle(t('main.app.title'));
  }
  if (ctx.tray) {
    ctx.tray.setToolTip(t('main.app.title'));
    ctx.tray.setContextMenu(trayMenu(ctx));
  }
}

function createTray(ctx) {
  if (ctx.tray) return;
  try {
    const image = nativeImage
      .createFromBuffer(fs.readFileSync(ICON_PATH))
      .resize({ width: 32, height: 32 });
    if (image.isEmpty()) return;
    const tray = new Tray(image);
    ctx.tray = tray;
    tray.setToolTip(t('main.app.title'));
    tray.setContextMenu(trayMenu(ctx));
    tray.on('click', () => showMainWindow(ctx));
    tray.on('double-click', () => showMainWindow(ctx));
  } catch (error) {
    console.error('[feige] 系统托盘不可用', error);
    ctx.tray = null;
  }
}

function destroyTray(ctx) {
  if (!ctx.tray) return;
  ctx.tray.destroy();
  ctx.tray = null;
}

module.exports = { showMainWindow, notify, createTray, destroyTray, refreshShellLanguage };
