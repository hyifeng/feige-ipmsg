'use strict';

const path = require('node:path');

const { loadOrCreateIdentity } = require('./identity');
const { loadSettings, saveSettings } = require('./settings');
const { ContactsStore } = require('../contacts');
const { HistoryStore } = require('../history');
const { SecurePairingStore } = require('../secure/pairing-store');
const { NodeService } = require('./node-service');
const { registerIpc } = require('./ipc');
const { emit, friendlyNetworkError } = require('./info');

async function doActivateRuntime(ctx) {
  if (ctx.unlocked) return;
  const key = ctx.localPass.getKey();
  ctx.localKey = key;

  let settings;
  let contacts;
  let history;
  let secureStore;
  try {
    const userData = ctx.app.getPath('userData');
    ctx.identity = loadOrCreateIdentity(userData, { key });
    settings = loadSettings(ctx);
    contacts = new ContactsStore(userData, { key });
    history = new HistoryStore(path.join(userData, 'history'), { key });
    await history.init();
    secureStore = new SecurePairingStore(userData, { key });
  } catch (error) {
    ctx.localKey = null;
    ctx.localPass.lock();
    throw error;
  }

  ctx.settings = settings;
  ctx.contacts = contacts;
  ctx.history = history;
  ctx.secureStore = secureStore;
  saveSettings(ctx);

  ctx.nodeService = new NodeService(ctx);
  if (!ctx.ipcRegistered) {
    registerIpc(ctx);
    ctx.ipcRegistered = true;
  }
  ctx.unlocked = true;

  try {
    await ctx.nodeService.start();
  } catch (error) {
    console.error('[feige] 网络服务启动失败', error);
    emit(ctx, 'fatal', { message: friendlyNetworkError(ctx, error) });
  }
}

/**
 * 本地密码验证通过后，才加载受保护的资料并启动网络服务。
 *
 * 这样在锁定界面阶段：
 * - 不读取昵称、联系人、聊天记录和加密配对；
 * - 不广播上线，也不会接收或持久化任何消息。
 */
function activateRuntime(ctx) {
  if (ctx.unlocked) return Promise.resolve();
  if (ctx.activation) return ctx.activation;
  ctx.activation = doActivateRuntime(ctx).finally(() => {
    ctx.activation = null;
  });
  return ctx.activation;
}

module.exports = { activateRuntime };
