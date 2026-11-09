'use strict';

const path = require('node:path');
const { app, BrowserWindow, powerMonitor, safeStorage } = require('electron');

const { APP_NAME, DISCOVERY_PORT, DEMO } = require('./app/config');
const { defaultSettings } = require('./app/settings');
const { showMainWindow, destroyTray } = require('./app/shell');
const { createWindow } = require('./app/window');
const { registerLocalPassIpc } = require('./app/ipc/local-pass');
const { LocalPass } = require('./security/local-pass');
const { AutoUnlockStore } = require('./security/auto-unlock');
const { createIdentity } = require('../shared/protocol/identity');

app.setName(APP_NAME);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ctx = {
  app,
  demo: DEMO,
  discoveryPort: DISCOVERY_PORT,
  win: null,
  tray: null,
  node: null,
  nodeService: null,
  identity: null,
  contacts: null,
  settings: null,
  settingsPath: '',
  history: null,
  secureStore: null,
  localPass: null,
  localKey: null,
  unlocked: false,
  activation: null,
  autoUnlock: null,
  autoUnlockTried: false,
  ipcRegistered: false,
  quitting: false,
};

function announceNodeOffline() {
  const node = ctx.node;
  if (!node || !node.online) return;
  try {
    node.setOnline(false);
  } catch (error) {
    console.error('[feige] 退出前广播下线失败', error);
  }
}

async function initialize() {
  const userData = app.getPath('userData');
  ctx.settingsPath = path.join(userData, 'settings.json');

  if (ctx.demo) {
    // 演示模式只用于界面预览，不读写加密资料，也不启动网络服务。
    ctx.identity = createIdentity();
    ctx.settings = defaultSettings(ctx);
    createWindow(ctx);
    return;
  }

  ctx.localPass = new LocalPass(userData);
  ctx.autoUnlock = new AutoUnlockStore(userData, { safeStorage });
  registerLocalPassIpc(ctx);
  createWindow(ctx);
}

function registerLifecycle() {
  // 系统关机 / 用户注销时尽量先发出 BR_EXIT；硬断电仍由心跳超时兜底。
  process.on('SIGTERM', () => {
    announceNodeOffline();
    app.quit();
  });
  process.on('SIGINT', () => {
    announceNodeOffline();
    app.quit();
  });

  app.on('second-instance', () => showMainWindow(ctx));

  app.whenReady().then(async () => {
    await initialize();
    powerMonitor.on('resume', () => {
      if (ctx.nodeService) ctx.nodeService.networkChanged();
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(ctx);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    destroyTray(ctx);
    if (ctx.localPass) ctx.localPass.destroy();
  });

  app.on('before-quit', (event) => {
    if (ctx.quitting) return;
    if (!ctx.node && !ctx.history) {
      ctx.quitting = true;
      return;
    }
    event.preventDefault();
    ctx.quitting = true;
    const stop = ctx.nodeService ? ctx.nodeService.stop() : Promise.resolve();
    const flush = ctx.history ? ctx.history.flush() : Promise.resolve();
    Promise.race([
      Promise.all([stop, flush]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).finally(() => app.quit());
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerLifecycle();
}
