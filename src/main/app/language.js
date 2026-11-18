'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeLocale } = require('../i18n');

function languagePath(app) {
  return path.join(app.getPath('userData'), 'language.json');
}

function systemLocale(app) {
  try {
    const value = String(app.getLocale() || '');
    return /^zh(?:[-_]|$)/i.test(value) ? 'zh-CN' : 'en';
  } catch {
    return 'zh-CN';
  }
}

function readLanguage(app) {
  if (process.env.FEIGE_LANG) return normalizeLocale(process.env.FEIGE_LANG);
  let stored = '';
  try {
    const raw = JSON.parse(fs.readFileSync(languagePath(app), 'utf8'));
    if (raw && raw.language) stored = normalizeLocale(raw.language);
  } catch {
    /* 首次运行或文件损坏时使用系统语言 */
  }
  if (stored) return stored;
  return systemLocale(app);
}

function writeLanguage(app, language) {
  const value = normalizeLocale(language);
  try {
    const target = languagePath(app);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ language: value }), { mode: 0o600 });
  } catch (error) {
    console.error('[feige] failed to save language preference', error);
  }
  return value;
}

module.exports = { languagePath, readLanguage, writeLanguage };
