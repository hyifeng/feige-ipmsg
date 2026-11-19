'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeLocale } = require('../i18n');

const SYSTEM_PREFERENCE = 'system';

function languagePath(app) {
  return path.join(app.getPath('userData'), 'language.json');
}

function normalizePreference(value) {
  return String(value || '').trim().toLowerCase() === SYSTEM_PREFERENCE
    ? SYSTEM_PREFERENCE
    : normalizeLocale(value);
}

function systemLocale(app) {
  try {
    const value = String(app.getLocale() || '');
    return /^zh(?:[-_]|$)/i.test(value) ? 'zh-CN' : 'en';
  } catch {
    return 'en';
  }
}

function readLanguagePreference(app) {
  if (process.env.FEIGE_LANG) return normalizePreference(process.env.FEIGE_LANG);
  try {
    const raw = JSON.parse(fs.readFileSync(languagePath(app), 'utf8'));
    if (raw && raw.language) return normalizePreference(raw.language);
  } catch {
    /* 首次运行或文件损坏时跟随系统语言 */
  }
  return SYSTEM_PREFERENCE;
}

function resolveLanguage(app, preference = readLanguagePreference(app)) {
  return preference === SYSTEM_PREFERENCE ? systemLocale(app) : preference;
}

function writeLanguage(app, preference) {
  const value = normalizePreference(preference);
  try {
    const target = languagePath(app);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ language: value }), { mode: 0o600 });
  } catch (error) {
    console.error('[feige] failed to save language preference', error);
  }
  return value;
}

module.exports = {
  SYSTEM_PREFERENCE,
  languagePath,
  normalizePreference,
  readLanguagePreference,
  resolveLanguage,
  writeLanguage,
};
