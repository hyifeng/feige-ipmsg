'use strict';

const { ipcMain } = require('electron');

const { validatePass } = require('../../security/local-pass');
const { activateRuntime } = require('../bootstrap');
const { buildStateSnapshot } = require('../snapshot');

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
            autoUnlockError = '免密自动解锁失败，请输入本地密码';
          }
        } else {
          ctx.autoUnlock.clear();
          autoUnlockError = '免密令牌已失效，请输入本地密码';
        }
      } else if (loaded.reason === 'invalid') {
        ctx.autoUnlock.clear();
        autoUnlockError = loaded.message || '免密令牌已损坏，请输入本地密码';
      } else if (loaded.reason === 'failed') {
        autoUnlockError = loaded.message || '系统钥匙串无法解密免密令牌，请输入本地密码';
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
    if (ctx.demo) return { ok: false, code: 'demo', message: '演示模式不需要本地密码' };
    if (ctx.unlocked) return { ok: true, snapshot: await buildStateSnapshot(ctx) };
    if (ctx.localPass.isConfigured()) {
      return { ok: false, code: 'already-configured', message: '本地密码已设置，请输入本地密码解锁' };
    }

    const { pass, remember } = passPayload(payload);
    const validation = validatePass(pass);
    if (!validation.ok) return { ok: false, code: 'invalid-pass', message: validation.message };

    try {
      ctx.localPass.setup(pass);
      ctx.autoUnlock.clear();
    } catch (error) {
      return { ok: false, code: 'setup-failed', message: error.message || '无法设置本地密码' };
    }

    try {
      await activateRuntime(ctx);
    } catch (error) {
      console.error('[feige] 本地密码设置后初始化失败', error);
      return {
        ok: false,
        code: 'activate-failed',
        message: '无法初始化加密资料，请检查本地数据是否损坏',
      };
    }

    const autoUnlock = await applyRemember(ctx, remember);
    return { ok: true, autoUnlock, snapshot: await buildStateSnapshot(ctx) };
  });

  ipcMain.handle('feige:local-pass-unlock', async (_event, payload) => {
    if (ctx.demo) return { ok: false, code: 'demo', message: '演示模式不需要本地密码' };
    if (ctx.unlocked) return { ok: true, snapshot: await buildStateSnapshot(ctx) };
    if (!ctx.localPass.isConfigured()) {
      return { ok: false, code: 'not-configured', message: '尚未设置本地密码' };
    }

    const { pass, remember } = passPayload(payload);
    let unlocked = false;
    try {
      unlocked = ctx.localPass.unlock(pass);
    } catch (error) {
      return {
        ok: false,
        code: 'corrupted',
        message: error.message || '本地密码配置已损坏，无法解锁',
      };
    }

    if (!unlocked) {
      await sleep(450);
      return {
        ok: false,
        code: 'wrong-password',
        message: '本地密码错误，无法解密本机资料',
      };
    }

    try {
      await activateRuntime(ctx);
    } catch (error) {
      console.error('[feige] 本地密码正确但资料解密失败', error);
      return {
        ok: false,
        code: 'decrypt-failed',
        message: '本地资料无法解密，数据可能已损坏',
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
      return { ok: false, code: 'locked', message: '请先解锁本地资料' };
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
      return { ok: false, code: 'locked', message: '请先解锁本地资料' };
    }

    const oldPass = typeof payload.oldPass === 'string' ? payload.oldPass : '';
    const newPass = typeof payload.newPass === 'string' ? payload.newPass : '';
    const validation = validatePass(newPass);
    if (!validation.ok) return { ok: false, code: 'invalid-pass', message: validation.message };

    let changed = false;
    try {
      changed = ctx.localPass.changePass(oldPass, newPass);
    } catch (error) {
      return { ok: false, code: 'change-failed', message: error.message || '无法修改本地密码' };
    }

    if (!changed) {
      await sleep(450);
      return { ok: false, code: 'wrong-password', message: '原密码错误' };
    }

    // 修改密码后默认取消下次免密，要求用户用新密码重新确认一次。
    ctx.autoUnlock.disable();
    return { ok: true, autoUnlockEnabled: false, message: '本地密码已修改' };
  });
}

module.exports = { registerLocalPassIpc };
