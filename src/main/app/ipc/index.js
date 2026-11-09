'use strict';

const { registerStateIpc } = require('./state');
const { registerTransferIpc } = require('./transfers');
const { registerHistoryIpc } = require('./history');
const { registerSecureIpc } = require('./secure');
const { registerSystemIpc } = require('./system');
const { registerImageIpc } = require('./images');
const { registerContactsIpc } = require('./contacts');

function registerIpc(ctx) {
  registerStateIpc(ctx);
  registerTransferIpc(ctx);
  registerHistoryIpc(ctx);
  registerSecureIpc(ctx);
  registerSystemIpc(ctx);
  registerImageIpc(ctx);
  registerContactsIpc(ctx);
}

module.exports = { registerIpc };
