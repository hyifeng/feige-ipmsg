'use strict';

const { PROTOCOL_VERSION } = require('../../shared/protocol');

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 2 * 60 * 1000;
const AUTH_LABEL = 'feige-secure-v1';

module.exports = {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  HANDSHAKE_TIMEOUT_MS,
  AUTH_LABEL,
};
