'use strict';

const { ipcMain } = require('electron');
const { t } = require('../../i18n');
const { identityOfPeerKey, isIdentity } = require('../../../shared/protocol/identity');
const { emit, isVerifiedPeer } = require('../info');

function peerIdentity(ctx, value) {
  const identity = identityOfPeerKey(value);
  if (!isIdentity(identity)) throw new Error(t('main.error.invalidContactIdentity'));
  return identity;
}

function registerContactsIpc(ctx) {
  ipcMain.handle('feige:contacts-list', () => (ctx.contacts ? ctx.contacts.list() : []));

  ipcMain.handle('feige:contacts-set-alias', (_event, payload = {}) => {
    if (!ctx.contacts) throw new Error(t('main.error.contactsNotReady'));
    const identity = peerIdentity(ctx, payload.peerKey || payload.identity);
    const alias = String(payload.alias || '').trim();
    if (alias && !ctx.demo && !isVerifiedPeer(ctx, identity)) {
      throw new Error(t('main.error.verifyBeforeAlias'));
    }
    ctx.contacts.setAlias(identity, alias);
    const descriptor = ctx.contacts.displayFor(identity, payload.claimed || '');
    emit(ctx, 'contacts', { contacts: ctx.contacts.list(), changed: descriptor });
    return descriptor;
  });

  ipcMain.handle('feige:contacts-remove-alias', (_event, payload = {}) => {
    if (!ctx.contacts) throw new Error(t('main.error.contactsNotReady'));
    const identity = peerIdentity(ctx, payload.peerKey || payload.identity);
    const removed = ctx.contacts.remove(identity);
    const descriptor = ctx.contacts.displayFor(identity, payload.claimed || '');
    emit(ctx, 'contacts', { contacts: ctx.contacts.list(), changed: descriptor });
    return { removed, contact: descriptor };
  });
}

module.exports = { registerContactsIpc };
