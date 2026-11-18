import en from './locales/en.mjs';
import zhCN from './locales/zh-CN.mjs';

const DEFAULT_LOCALE = 'zh-CN';
const SUPPORTED_LOCALES = ['zh-CN', 'en'];
const CATALOGS = {
  'zh-CN': zhCN,
  en,
};

let locale = DEFAULT_LOCALE;
let pluralRules = new Intl.PluralRules(locale);
const listeners = new Set();
const warned = new Set();

function normalizeLocale(value) {
  const text = String(value || '').trim();
  if (SUPPORTED_LOCALES.includes(text)) return text;
  if (/^zh(?:[-_]|$)/i.test(text)) return 'zh-CN';
  if (/^en(?:[-_]|$)/i.test(text)) return 'en';
  return 'en';
}

function getLocale() {
  return locale;
}

function setLocale(value) {
  const next = normalizeLocale(value);
  if (next === locale) return locale;
  locale = next;
  pluralRules = new Intl.PluralRules(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = 'ltr';
  for (const listener of listeners) {
    try {
      listener(locale);
    } catch (error) {
      console.error('[feige] locale listener failed', error);
    }
  }
  return locale;
}

function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function catalogValue(catalog, key) {
  return Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

function t(key, params = {}) {
  const primary = CATALOGS[locale];
  const fallback = CATALOGS[DEFAULT_LOCALE];
  let lookup = key;

  if (typeof params.count === 'number') {
    const category = pluralRules.select(params.count);
    const pluralKey = `${key}.${category}`;
    if (catalogValue(primary, pluralKey) != null || catalogValue(fallback, pluralKey) != null) {
      lookup = pluralKey;
    } else if (catalogValue(primary, `${key}.other`) != null || catalogValue(fallback, `${key}.other`) != null) {
      lookup = `${key}.other`;
    }
  }

  let template = catalogValue(primary, lookup);
  if (template == null) template = catalogValue(fallback, lookup);
  if (template == null && lookup !== key) {
    template = catalogValue(primary, key);
    if (template == null) template = catalogValue(fallback, key);
  }
  if (template == null) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[feige] missing i18n key: ${key}`);
    }
    return key;
  }
  return interpolate(String(template), params);
}

function applyStaticTranslations(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-title]')) {
    element.title = t(element.dataset.i18nTitle);
  }
  for (const element of root.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
  for (const element of root.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
  document.title = t('app.title');
}

function initI18n(value) {
  setLocale(value);
  applyStaticTranslations();
}

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  normalizeLocale,
  getLocale,
  setLocale,
  onLocaleChange,
  t,
  applyStaticTranslations,
  initI18n,
};
