'use strict';

const fs = require('node:fs');
const { BrowserWindow, Menu } = require('electron');
const {
  APP_NAME,
  IS_DEV,
  ICON_PATH,
  PRELOAD_PATH,
  RENDERER_INDEX,
} = require('./config');
const { createTray } = require('./shell');
const { emit, selfInfo } = require('./info');

function createWindow(ctx) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: `${APP_NAME} · 局域网快传`,
    backgroundColor: '#070b14',
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  ctx.win = win;

  Menu.setApplicationMenu(null);

  const query = {};
  if (ctx.demo) query.demo = '1';
  if (process.env.FEIGE_PANEL === '1') query.panel = '1';
  if (process.env.FEIGE_THEME === 'light' || process.env.FEIGE_THEME === 'dark') {
    query.theme = process.env.FEIGE_THEME;
  }
  win.loadFile(RENDERER_INDEX, Object.keys(query).length ? { query } : undefined);

  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (ctx.quitting || !ctx.tray) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    if (ctx.win === win) ctx.win = null;
  });

  // Windows 关机 / 注销：尽量在会话结束前广播 BR_EXIT。
  win.on('session-end', () => {
    if (!ctx.node || !ctx.node.online) return;
    try {
      ctx.node.setOnline(false);
    } catch (error) {
      console.error('[feige] 会话结束前广播下线失败', error);
    }
  });

  createTray(ctx);

  win.webContents.once('did-finish-load', () => {
    if (ctx.demo) {
      emit(ctx, 'ready', { self: selfInfo(ctx), settings: ctx.settings });
    }
    // 非演示模式：等本地密码验证通过后，由主进程启动网络并返回快照。
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  const shotPath = process.env.FEIGE_SHOT;
  if (shotPath) {
    const delay = Number(process.env.FEIGE_SHOT_DELAY) || 2200;
    setTimeout(async () => {
      try {
        if (ctx.win && !ctx.win.isDestroyed()) {
          const image = await ctx.win.webContents.capturePage();
          fs.writeFileSync(shotPath, image.toPNG());
          console.log(`[feige] screenshot saved: ${shotPath}`);
        }
      } catch (err) {
        console.error('[feige] screenshot failed', err);
      }
      ctx.app.quit();
    }, delay);
  }

  return win;
}

module.exports = { createWindow };
