'use strict';

const { ipcMain } = require('electron');

const { validatePass } = require('../../security/local-pass');
const { activateRuntime } = require('../bootstrap');
const { buildStateSnapshot } = require('../snapshot');
const { t } = require('../../i18n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function passPayload(payload) {
  if (typeof payload === 'string') return { pass: payload, remember: undefined };
  if (!payload || typeof payload !== 'object') return { pass: '', remember: undefined };
  return {
    pass: payload.pass,
    remember: typeof payload.remember === 'boolean' ? payload.remember : undefined,
  };
}

async function autoUnlockInfo(ctx) {
  const available = await ctx.autoUnlock.isAvailable();
  const preferred = ctx.autoUnlock.preferenceEnabled();
  // 偏好关闭时，任何残留令牌都视为无效。
  if (!preferred && ctx.autoUnlock.hasToken()) ctx.autoUnlock.clear();
  return {
    autoUnlockAvailable: available,
    autoUnlockEnabled: ctx.autoUnlock.hasToken(),
    autoUnlockPreferred: preferred,
    autoUnlockBackend: ctx.autoUnlock.backendName(),
    autoUnlockMessage: available ? '' : ctx.autoUnlock.unavailableReason(),
  };
}

async function applyRemember(ctx, remember) {
  if (remember === true) {
    const saved = await ctx.autoUnlock.save(ctx.localKey);
    return {
      enabled: saved.ok,
      saved: saved.ok,
      message: saved.ok ? '' : saved.message,
    };
  }
  if (remember === false) {
    ctx.autoUnlock.disable();
    return { enabled: false, saved: true, message: '' };
  }
  return { enabled: ctx.autoUnlock.hasToken(), saved: false, message: '' };
}

function registerLocalPassIpc(ctx) {
  ipcMain.handle('feige:local-pass-status', async () => {
    if (ctx.demo) {
      return {
        demo: true,
        configured: false,
        corrupted: false,
        unlocked: true,
        autoUnlockAvailable: false,
        autoUnlockEnabled: false,
        autoUnlockPreferred: false,
        autoUnlockMessage: '',
        autoUnlockError: '',
        snapshot: null,
      };
    }

    const configured = ctx.localPass.isConfigured();
    let unlocked = !!(ctx.unlocked && ctx.settings);
    let autoUnlockError = '';

    // 用户关闭免密后，即使令牌因异常没有被删除，也绝不能自动解锁。
    if (!ctx.autoUnlock.preferenceEnabled() && ctx.autoUnlock.hasToken()) {
      ctx.autoUnlock.clear();
    }

    if (!unlocked && configured && !ctx.localPass.isCorrupted()
      && !ctx.autoUnlockTried && ctx.autoUnlock.preferenceEnabled()
      && ctx.autoUnlock.hasToken()) {
      ctx.autoUnlockTried = true;
      const loaded = await ctx.autoUnlock.load();
      if (loaded.ok) {
        const valid = ctx.localPass.unlockWithKey(loaded.key);
        loaded.key.fill(0);
        if (valid) {
          try {
            await activateRuntime(ctx);
            unlocked = true;
          } catch (error) {
            console.error('[feige] 免密自动解锁失败', error);
            ctx.autoUnlock.clear();
            autoUnlockError = t('main.localPass.autoUnlockFailed');
          }
        } else {
          ctx.autoUnlock.clear();
          autoUnlockError = t('main.localPass.tokenExpired');
        }
      } else if (loaded.reason === 'invalid') {
        ctx.autoUnlock.clear();
        autoUnlockError = loaded.message || t('main.localPass.tokenDamaged');
      } else if (loaded.reason === 'failed') {
        autoUnlockError = loaded.message || t('main.localPass.tokenDecryptFailed');
      }
    }

    const auto = await autoUnlockInfo(ctx);
    return {
      demo: false,
      configured,
      corrupted: ctx.localPass.isCorrupted(),
      unlocked,
      ...auto,
      autoUnlockError,
      snapshot: unlocked ? await buildStateSnapshot(ctx) : null,
    };
  });

  ipcMain.handle('feige:local-pass-setup', async (_event, payload) => {
    if (ctx.demo) return { ok: false, code: 'demo', message: t('main.localPass.demo') };
    if (ctx.unlocked) return { ok: true, snapshot: await buildStateSnapshot(ctx) };
    if (ctx.localPass.isConfigured()) {
      return { ok: false, code: 'already-configured', message: t('main.localPass.alreadyConfigured') };
    }

    const { pass, remember } = passPayload(payload);
    const validation = validatePass(pass);
    if (!validation.ok) return { ok: false, code: 'invalid-pass', message: validation.message };

    try {
      ctx.localPass.setup(pass);
      ctx.autoUnlock.clear();
    } catch (error) {
      return { ok: false, code: 'setup-failed', message: error.message || t('main.localPass.setupFailed') };
    }

    try {
      await activateRuntime(ctx);
    } catch (error) {
      console.error('[feige] 本地密码设置后初始化失败', error);
      return {
        ok: false,
        code: 'activate-failed',
        message: t('main.localPass.activateFailed'),
      };
    }

    const autoUnlock = await applyRemember(ctx, remember);
    return { ok: true, autoUnlock, snapshot: await buildStateSnapshot(ctx) };
  });

  ipcMain.handle('feige:local-pass-unlock', async (_event, payload) => {
    if (ctx.demo) return { ok: false, code: 'demo', message: t('main.localPass.demo') };
    if (ctx.unlocked) return { ok: true, snapshot: await buildStateSnapshot(ctx) };
    if (!ctx.localPass.isConfigured()) {
      return { ok: false, code: 'not-configured', message: t('main.localPass.notConfigured') };
    }

    const { pass, remember } = passPayload(payload);
    let unlocked = false;
    try {
      unlocked = ctx.localPass.unlock(pass);
    } catch (error) {
      return {
        ok: false,
        code: 'corrupted',
        message: error.message || t('main.localPass.corrupted'),
      };
    }

    if (!unlocked) {
      await sleep(450);
      return {
        ok: false,
        code: 'wrong-password',
        message: t('main.localPass.wrongPassword'),
      };
    }

    try {
      await activateRuntime(ctx);
    } catch (error) {
      console.error('[feige] 本地密码正确但资料解密失败', error);
      return {
        ok: false,
        code: 'decrypt-failed',
        message: t('main.localPass.decryptFailed'),
      };
    }

    const autoUnlock = await applyRemember(ctx, remember);
    return { ok: true, autoUnlock, snapshot: await buildStateSnapshot(ctx) };
  });

  ipcMain.handle('feige:local-pass-security', async () => ({
    unlocked: !!ctx.unlocked,
    ...(await autoUnlockInfo(ctx)),
  }));

  ipcMain.handle('feige:set-auto-unlock', async (_event, enabled) => {
    if (!ctx.unlocked || !ctx.localKey) {
      return { ok: false, code: 'locked', message: t('main.localPass.locked') };
    }

    if (enabled) {
      const saved = await ctx.autoUnlock.save(ctx.localKey);
      const auto = await autoUnlockInfo(ctx);
      return saved.ok
        ? { ok: true, enabled: true, ...auto }
        : { ok: false, code: saved.reason, message: saved.message, ...auto };
    }

    ctx.autoUnlock.disable();
    return { ok: true, enabled: false, ...(await autoUnlockInfo(ctx)) };
  });

  ipcMain.handle('feige:local-pass-change', async (_event, payload = {}) => {
    if (!ctx.unlocked || !ctx.localKey) {
      return { ok: false, code: 'locked', message: t('main.localPass.locked') };
    }

    const oldPass = typeof payload.oldPass === 'string' ? payload.oldPass : '';
    const newPass = typeof payload.newPass === 'string' ? payload.newPass : '';
    const validation = validatePass(newPass);
    if (!validation.ok) return { ok: false, code: 'invalid-pass', message: validation.message };

    let changed = false;
    try {
      changed = ctx.localPass.changePass(oldPass, newPass);
    } catch (error) {
      return { ok: false, code: 'change-failed', message: error.message || t('main.localPass.changeFailed') };
    }

    if (!changed) {
      await sleep(450);
      return { ok: false, code: 'wrong-password', message: t('main.localPass.oldPasswordWrong') };
    }

    // 修改密码后默认取消下次免密，要求用户用新密码重新确认一次。
    ctx.autoUnlock.disable();
    return { ok: true, autoUnlockEnabled: false, message: t('main.localPass.changed') };
  });
}

module.exports = { registerLocalPassIpc };
