'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_PORT } = require('../../shared/protocol');

// 旧版本使用 IPMsg 的 2425；升级后仅迁移仍停留在旧默认值的配置。
const LEGACY_DEFAULT_PORT = 2425;
const SETTINGS_VERSION = 1;
const {
  AAD,
  isEnvelope,
  decryptJson,
  writeProtectedJsonSync,
} = require('../security/local-crypto');

function clampPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

function cleanHubUrl(value) {
  const text = String(value == null ? '' : value).trim().slice(0, 512);
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? text : '';
  } catch {
    return '';
  }
}

function cleanStunUrl(value) {
  const text = String(value == null ? '' : value).trim().slice(0, 512);
  if (!text) return '';
  try {
    return new URL(text).protocol === 'stun:' ? text : '';
  } catch {
    return '';
  }
}

function defaultSettings(ctx) {
  const { app } = ctx;
  const downloads = app.getPath('downloads') || path.join(os.homedir(), 'Downloads');
  let username = '飞鸽用户';
  try {
    username = os.userInfo().username || username;
  } catch {
    /* ignore */
  }
  return {
    nickname: username,
    port: clampPort(process.env.FEIGE_PORT || DEFAULT_PORT),
    downloadDir: path.join(downloads, '飞鸽接收'),
    autoAccept: false,
    sound: true,
    theme: 'dark',
    online: true,
    lanEnabled: process.env.FEIGE_LAN_ENABLED !== '0',
    hubEnabled: false,
    hubUrl: '',
    hubStunUrl: '',
    identity: ctx.identity ? ctx.identity.id : '',
    settingsVersion: SETTINGS_VERSION,
  };
}

function normalizeSettings(ctx, raw = {}) {
  const defaults = defaultSettings(ctx);
  const version = Number(raw.settingsVersion) || 0;
  let port = raw.port == null ? defaults.port : clampPort(raw.port);
  if (version < SETTINGS_VERSION && Number(raw.port) === LEGACY_DEFAULT_PORT) {
    port = clampPort(DEFAULT_PORT);
  }
  return {
    nickname: typeof raw.nickname === 'string' && raw.nickname.trim()
      ? raw.nickname.replace(/[\0:\r\n]/g, ' ').trim().slice(0, 32)
      : defaults.nickname,
    port,
    downloadDir: typeof raw.downloadDir === 'string' && raw.downloadDir
      ? raw.downloadDir
      : defaults.downloadDir,
    autoAccept: !!raw.autoAccept,
    sound: raw.sound !== false,
    theme: raw.theme === 'light' ? 'light' : 'dark',
    online: true,
    lanEnabled: typeof raw.lanEnabled === 'boolean' ? raw.lanEnabled : defaults.lanEnabled,
    hubEnabled: raw.hubEnabled === true,
    hubUrl: cleanHubUrl(raw.hubUrl),
    hubStunUrl: cleanStunUrl(raw.hubStunUrl),
    identity: ctx.identity ? ctx.identity.id : defaults.identity,
    settingsVersion: SETTINGS_VERSION,
  };
}

function loadSettings(ctx) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(ctx.settingsPath, 'utf8'));
    if (isEnvelope(raw)) {
      if (!ctx.localKey) throw new Error('本地配置已加密，请先输入本地密码');
      raw = decryptJson(ctx.localKey, raw, AAD.SETTINGS);
    }
    if (!raw || typeof raw !== 'object') raw = {};
  } catch (error) {
    if (error && (error.code === 'LOCAL_DECRYPT_FAILED' || /已加密|本地密码/.test(error.message))) {
      throw error;
    }
    /* 首次运行或文件损坏时使用默认配置 */
    raw = {};
  }
  return normalizeSettings(ctx, raw);
}

function saveSettings(ctx) {
  if (!ctx.settingsPath) return;
  if (!ctx.localKey && !ctx.demo) {
    console.error('[feige] 拒绝在锁定状态保存设置');
    return;
  }
  try {
    writeProtectedJsonSync(ctx.settingsPath, ctx.localKey, ctx.settings, AAD.SETTINGS, 0o600);
  } catch (err) {
    console.error('[feige] 保存设置失败', err);
  }
}

function sanitizePatch(patch) {
  const clean = {};
  if (patch && typeof patch.nickname === 'string') {
    const nickname = patch.nickname.replace(/[\0:\r\n]/g, ' ').trim().slice(0, 32);
    if (nickname) clean.nickname = nickname;
  }
  if (patch && patch.port != null) clean.port = clampPort(patch.port);
  if (patch && typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) {
    clean.downloadDir = patch.downloadDir.trim();
  }
  if (patch && typeof patch.autoAccept === 'boolean') clean.autoAccept = patch.autoAccept;
  if (patch && typeof patch.sound === 'boolean') clean.sound = patch.sound;
  if (patch && (patch.theme === 'light' || patch.theme === 'dark')) clean.theme = patch.theme;
  if (patch && typeof patch.lanEnabled === 'boolean') clean.lanEnabled = patch.lanEnabled;
  if (patch && typeof patch.hubEnabled === 'boolean') clean.hubEnabled = patch.hubEnabled;
  if (patch && patch.hubUrl != null) {
    const url = cleanHubUrl(patch.hubUrl);
    if (String(patch.hubUrl || '').trim() && !url) throw new Error('服务器地址必须是 ws:// 或 wss://');
    clean.hubUrl = url;
  }
  if (patch && patch.hubStunUrl != null) {
    const url = cleanStunUrl(patch.hubStunUrl);
    if (String(patch.hubStunUrl || '').trim() && !url) throw new Error('STUN 地址必须是 stun://');
    clean.hubStunUrl = url;
  }
  return clean;
}

module.exports = { clampPort, defaultSettings, loadSettings, saveSettings, sanitizePatch };
