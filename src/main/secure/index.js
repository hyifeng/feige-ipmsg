'use strict';

const { SecureManager } = require('./manager');
const { FrameSocket } = require('./frame-socket');
const { createMemoryStore } = require('./memory-store');
const {
  sha256,
  hmac,
  hkdf,
  encryptFrame,
  decryptFrame,
} = require('./crypto');
const { SecurePairingStore } = require('./pairing-store');

module.exports = {
  SecureManager,
  SecurePairingStore,
  FrameSocket,
  createMemoryStore,
  sha256,
  hmac,
  hkdf,
  encryptFrame,
  decryptFrame,
};
