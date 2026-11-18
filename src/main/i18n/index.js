'use strict';

const en = require('./locales/en');
const zhCN = require('./locales/zh-CN');

const DEFAULT_LOCALE = 'zh-CN';
const SUPPORTED_LOCALES = ['zh-CN', 'en'];
const CATALOGS = {
  'zh-CN': zhCN,
  en,
};

// 断开原因当前作为稳定的内部协议值传递；这里仅用于显示层映射。
const REASON_KEYS = {
  '用户取消': 'main.reason.userCanceled',
  '用户下线': 'main.reason.selfOffline',
  '节点停止': 'main.reason.nodeStopped',
  '连接超时': 'main.reason.timeout',
  '对方取消': 'main.reason.peerCanceled',
  '对方已解除认证': 'main.reason.peerRevoked',
  '加密连接已断开': 'main.reason.encryptedClosed',
  '加密握手超时': 'main.reason.handshakeTimeout',
  '加密握手格式错误': 'main.reason.handshakeFormat',
  '加密握手模式无效': 'main.reason.handshakeMode',
  '加密握手身份无效': 'main.reason.handshakeIdentity',
  '双方同时建立加密会话': 'main.reason.simultaneous',
  '已有加密会话正在建立': 'main.reason.busy',
  '本机没有保存该联系人的加密密钥': 'main.reason.noPairing',
  '本机已有该联系人的认证记录，请在本机选择重新认证': 'main.reason.pairingExists',
  '加密协议版本不匹配': 'main.reason.protocolMismatch',
  '加密消息校验失败': 'main.reason.messageCheckFailed',
  '握手公钥无效': 'main.reason.invalidHandshakeKey',
  '缺少对方承诺': 'main.reason.missingCommitment',
  '哈希承诺校验失败': 'main.reason.commitmentFailed',
  '认证前缺少握手签名': 'main.reason.missingSignature',
  '加密认证模式不匹配': 'main.reason.authModeMismatch',
  '加密密钥校验失败': 'main.reason.keyCheckFailed',
  '应用离线': 'main.reason.appOffline',
  '加密会话已关闭': 'main.reason.sessionClosed',
  '加密会话已断开': 'main.reason.sessionClosed',
  '加密会话未建立': 'main.reason.sessionNotEstablished',
  '连接失败': 'main.reason.connectionFailed',
  '握手发送失败': 'main.reason.handshakeSendFailed',
  '确认发送失败': 'main.reason.confirmSendFailed',
  '传输层未提供 connectStream': 'main.reason.noConnectStream',
  '连接已断开': 'main.reason.connectionClosed',
  '认证密钥无效，会话已断开': 'main.reason.invalidVerificationKey',
  '对方已离线': 'main.reason.peerOffline',
  '网络地址变化': 'main.reason.networkChanged',
  '对方已重启': 'main.reason.peerRestarted',
  '自动恢复认证失败': 'main.reason.autoRestoreFailed',
  '本机没有认证密钥，无法自动恢复身份认证': 'main.reason.noLocalVerificationKey',
};

let locale = DEFAULT_LOCALE;
let pluralRules = new Intl.PluralRules(locale);
const warned = new Set();

function normalizeLocale(value) {
  const text = String(value || '').trim();
  if (SUPPORTED_LOCALES.includes(text)) return text;
  if (/^zh(?:[-_]|$)/i.test(text)) return 'zh-CN';
  if (/^en(?:[-_]|$)/i.test(text)) return 'en';
  return DEFAULT_LOCALE;
}

function getLocale() {
  return locale;
}

function setLocale(value) {
  locale = normalizeLocale(value);
  pluralRules = new Intl.PluralRules(locale);
  return locale;
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
      console.warn(`[feige] missing main i18n key: ${key}`);
    }
    return key;
  }
  return interpolate(String(template), params);
}

function secureReasonText(reason) {
  const value = String(reason || '');
  const key = REASON_KEYS[value];
  return key ? t(key) : value;
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  normalizeLocale,
  getLocale,
  setLocale,
  t,
  secureReasonText,
};
