'use strict';

const fs = require('node:fs');
const { Menu, Notification, Tray, nativeImage } = require('electron');
const { APP_NAME, ICON_PATH } = require('./config');

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

function createTray(ctx) {
  if (ctx.tray) return;
  try {
    const image = nativeImage
      .createFromBuffer(fs.readFileSync(ICON_PATH))
      .resize({ width: 32, height: 32 });
    if (image.isEmpty()) return;
    const tray = new Tray(image);
    ctx.tray = tray;
    tray.setToolTip(`${APP_NAME} · 局域网快传`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => showMainWindow(ctx) },
      { type: 'separator' },
      { label: '退出飞鸽', click: () => ctx.app.quit() },
    ]));
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

module.exports = { showMainWindow, notify, createTray, destroyTray };
