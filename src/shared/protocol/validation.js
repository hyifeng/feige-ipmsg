'use strict';

const { PROTOCOL_VERSION, APP_TAG, MAX_MSG_ID_CHARS } = require('./constants');
const { isIdentity } = require('./identity');

const TRANSFER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MSG_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{80,96}$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value, max = 255) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isSafeInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function isSafePort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isTimestamp(value) {
  return isSafeInteger(value, 1);
}

function isTransferId(value) {
  return typeof value === 'string' && TRANSFER_ID_RE.test(value);
}

function isFileId(value) {
  return typeof value === 'string' && FILE_ID_RE.test(value);
}

function isMsgId(value) {
  return typeof value === 'string' && value.length <= MAX_MSG_ID_CHARS && MSG_ID_RE.test(value);
}

function isNonce(value) {
  return typeof value === 'string' && NONCE_RE.test(value);
}

function isSignature(value) {
  return typeof value === 'string' && SIGNATURE_RE.test(value);
}

function isAddressList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return false;
  return value.every((item) => typeof item === 'string' && IPV4_RE.test(item));
}

/** 所有 UDP 扩展段都必须有当前协议标识和自证身份。 */
function isExtensionEnvelope(ext) {
  return isPlainObject(ext)
    && ext.app === APP_TAG
    && ext.v === PROTOCOL_VERSION
    && isIdentity(ext.id)
    && isNonEmptyString(ext.instance, 64)
    && isSafePort(ext.port)
    && (ext.kind === 'entry' || ext.kind === 'files' || ext.kind === 'text' || ext.kind === 'ack');
}

function isEntryExtension(ext) {
  return isExtensionEnvelope(ext)
    && ext.kind === 'entry'
    && typeof ext.online === 'boolean'
    && isNonEmptyString(ext.user, 64)
    && isNonEmptyString(ext.host, 64)
    && isAddressList(ext.addrs)
    && isTimestamp(ext.ts)
    && isNonce(ext.nonce)
    && isSignature(ext.sig);
}

/**
 * 文件条目是 UDP 预览、TCP 清单和加密清单共用的唯一格式。
 * 缺失任一字段都视为旧/损坏协议包。
 */
function isFileEntry(value) {
  if (!isPlainObject(value)) return false;
  return isFileId(value.id)
    && isNonEmptyString(value.name, 255)
    && isNonEmptyString(value.relPath, 512)
    && isSafeInteger(value.size)
    && typeof value.dir === 'boolean';
}

function isSignedMessageBase(ext) {
  return isExtensionEnvelope(ext)
    && isIdentity(ext.recipient)
    && isMsgId(ext.msgId)
    && isSafeInteger(ext.seq)
    && isTimestamp(ext.ts)
    && isNonce(ext.nonce)
    && isSignature(ext.sig);
}

function isTextMessageExtension(ext) {
  return isSignedMessageBase(ext) && ext.kind === 'text';
}

function isAckExtension(ext) {
  return isExtensionEnvelope(ext)
    && ext.kind === 'ack'
    && isIdentity(ext.recipient)
    && isMsgId(ext.msgId)
    && isTimestamp(ext.ts)
    && isNonce(ext.nonce)
    && isSignature(ext.sig);
}

function isFileOfferPayload(ext) {
  if (!isPlainObject(ext) || ext.app !== APP_TAG || ext.v !== PROTOCOL_VERSION || ext.kind !== 'files') return false;
  if (!isTransferId(ext.transferId)) return false;
  if (!isNonEmptyString(ext.rootName, 255)) return false;
  if (!isTimestamp(ext.at)) return false;
  if (typeof ext.manifest !== 'boolean' || typeof ext.isFolder !== 'boolean' || typeof ext.image !== 'boolean') {
    return false;
  }
  if (![ext.totalFiles, ext.totalDirs, ext.totalEntries, ext.totalBytes].every((value) => isSafeInteger(value))) {
    return false;
  }
  if (!Array.isArray(ext.files)) return false;
  if (ext.thumb !== undefined && typeof ext.thumb !== 'string') return false;
  return true;
}

/** 加密通道里的报价不依赖 UDP 签名，只需要结构性字段。 */
function isSecureFileOfferData(ext) {
  return isFileOfferPayload(ext);
}

function isFileOfferData(ext) {
  return isSignedMessageBase(ext) && isFileOfferPayload(ext);
}

function isFileOfferExtension(ext) {
  return isFileOfferData(ext);
}

function isReleaseData(value) {
  return isPlainObject(value)
    && value.app === APP_TAG
    && value.v === PROTOCOL_VERSION
    && value.kind === 'release'
    && isIdentity(value.id)
    && isIdentity(value.recipient)
    && isTransferId(value.transferId)
    && isTimestamp(value.ts)
    && isNonce(value.nonce)
    && isSignature(value.sig);
}

function isFileRequestData(value) {
  return isPlainObject(value)
    && value.app === APP_TAG
    && value.v === PROTOCOL_VERSION
    && value.kind === 'file-request'
    && isIdentity(value.id)
    && isIdentity(value.recipient)
    && isTransferId(value.transferId)
    && isFileId(value.fileId)
    && isSafeInteger(value.offset)
    && isSafePort(value.port)
    && isTimestamp(value.ts)
    && isNonce(value.nonce)
    && isSignature(value.sig);
}

function isManifestRequestData(value) {
  return isPlainObject(value)
    && value.app === APP_TAG
    && value.v === PROTOCOL_VERSION
    && value.kind === 'manifest-request'
    && isIdentity(value.id)
    && isIdentity(value.recipient)
    && isTransferId(value.transferId)
    && isTimestamp(value.ts)
    && isNonce(value.nonce)
    && isSignature(value.sig);
}

function isManifestResponseData(value) {
  return isPlainObject(value)
    && value.app === APP_TAG
    && value.v === PROTOCOL_VERSION
    && value.kind === 'manifest'
    && isIdentity(value.id)
    && isIdentity(value.recipient)
    && isTransferId(value.transferId)
    && Array.isArray(value.files)
    && isTimestamp(value.ts)
    && isNonce(value.nonce)
    && isSignature(value.sig);
}

function isFileStreamHeader(value) {
  return isPlainObject(value)
    && value.app === APP_TAG
    && value.v === PROTOCOL_VERSION
    && value.kind === 'file'
    && isIdentity(value.id)
    && isIdentity(value.recipient)
    && isTransferId(value.transferId)
    && isFileId(value.fileId)
    && isSafeInteger(value.offset)
    && isSafeInteger(value.size)
    && isTimestamp(value.ts)
    && isNonce(value.nonce)
    && isSignature(value.sig);
}

module.exports = {
  isPlainObject,
  isNonEmptyString,
  isSafeInteger,
  isSafePort,
  isTimestamp,
  isTransferId,
  isFileId,
  isMsgId,
  isNonce,
  isSignature,
  isExtensionEnvelope,
  isEntryExtension,
  isFileEntry,
  isTextMessageExtension,
  isAckExtension,
  isFileOfferData,
  isFileOfferExtension,
  isSecureFileOfferData,
  isReleaseData,
  isFileRequestData,
  isManifestRequestData,
  isManifestResponseData,
  isFileStreamHeader,
};
