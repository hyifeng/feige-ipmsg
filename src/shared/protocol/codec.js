'use strict';

const {
  PROTOCOL_VERSION,
  MAX_UDP_PACKET_BYTES,
  MAX_EXT_BYTES,
  MAX_TEXT_CHARS,
  MAX_FIELD_CHARS,
} = require('./constants');
const { isPlainObject } = require('./validation');

function splitCommand(word) {
  const value = Number(word) >>> 0;
  return {
    base: value & 0x000000ff,
    options: value & 0xffffff00,
  };
}

function makeCommand(base, options = 0) {
  return ((Number(base) | Number(options)) >>> 0);
}

/** 昵称/主机名中不能出现冒号与 NUL，否则会破坏报文结构。 */
function sanitizeField(value, fallback = '') {
  const text = String(value == null ? '' : value)
    .replace(/[\0\r\n:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, MAX_FIELD_CHARS) || fallback;
}

function encodePacket({ packetNo, user, host, command, message = '' }) {
  return [
    PROTOCOL_VERSION,
    (Number(packetNo) >>> 0).toString(10),
    sanitizeField(user, 'unknown'),
    sanitizeField(host, 'unknown'),
    (Number(command) >>> 0).toString(10),
    String(message == null ? '' : message),
  ].join(':');
}

function parsePacket(buffer) {
  if (!buffer) return null;
  if (typeof buffer !== 'string' && !Buffer.isBuffer(buffer)) return null;
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer;
  if (!raw || Buffer.byteLength(raw) > MAX_UDP_PACKET_BYTES) return null;

  const parts = raw.split(':');
  if (parts.length < 6) return null;

  const version = Number(parts[0]);
  const packetNo = Number(parts[1]);
  const command = Number(parts[4]);
  if (version !== PROTOCOL_VERSION) return null;
  if (!Number.isSafeInteger(packetNo) || packetNo < 0) return null;
  if (!Number.isSafeInteger(command) || command < 0 || command > 0xffffffff) return null;

  return {
    version,
    packetNo,
    user: parts[2],
    host: parts[3],
    command,
    ...splitCommand(command),
    message: parts.slice(5).join(':'),
    raw,
  };
}

/** message 字段：<可读文本>\0<JSON>。 */
function encodeBody(text = '', ext = null) {
  const body = String(text == null ? '' : text);
  if (!ext) return body;
  return `${body}\0${JSON.stringify(ext)}`;
}

/**
 * 解析 message 字段。任何畸形/超长扩展都只返回 ext:null，绝不向调用方
 * 抛出异常；需要扩展段的命令会因此直接忽略该包。
 */
function decodeBody(message = '') {
  const raw = typeof message === 'string' ? message : '';
  if (!raw || raw.length > MAX_UDP_PACKET_BYTES) return { text: '', ext: null };
  const index = raw.indexOf('\0');
  if (index === -1) return { text: raw, ext: null };

  const text = raw.slice(0, index);
  if (text.length > MAX_TEXT_CHARS) return { text: '', ext: null };
  const rest = raw.slice(index + 1);
  if (!rest || Buffer.byteLength(rest) > MAX_EXT_BYTES) return { text, ext: null };
  try {
    const ext = JSON.parse(rest);
    return { text, ext: isPlainObject(ext) ? ext : null };
  } catch {
    return { text, ext: null };
  }
}

module.exports = {
  splitCommand,
  makeCommand,
  sanitizeField,
  encodePacket,
  parsePacket,
  encodeBody,
  decodeBody,
};
