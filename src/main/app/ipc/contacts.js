'use strict';

const { ipcMain } = require('electron');
const { identityOfPeerKey, isIdentity } = require('../../../shared/protocol/identity');
const { emit, isVerifiedPeer } = require('../info');

function peerIdentity(value) {
  const identity = identityOfPeerKey(value);
  if (!isIdentity(identity)) throw new Error('无效的联系人身份');
  return identity;
}

function registerContactsIpc(ctx) {
  ipcMain.handle('feige:contacts-list', () => (ctx.contacts ? ctx.contacts.list() : []));

  ipcMain.handle('feige:contacts-set-alias', (_event, payload = {}) => {
    if (!ctx.contacts) throw new Error('联系人簿未就绪');
    const identity = peerIdentity(payload.peerKey || payload.identity);
    const alias = String(payload.alias || '').trim();
    if (alias && !ctx.demo && !isVerifiedPeer(ctx, identity)) {
      throw new Error('请先完成身份认证，再设置本地别名');
    }
    ctx.contacts.setAlias(identity, alias);
    const descriptor = ctx.contacts.displayFor(identity, payload.claimed || '');
    emit(ctx, 'contacts', { contacts: ctx.contacts.list(), changed: descriptor });
    return descriptor;
  });

  ipcMain.handle('feige:contacts-remove-alias', (_event, payload = {}) => {
    if (!ctx.contacts) throw new Error('联系人簿未就绪');
    const identity = peerIdentity(payload.peerKey || payload.identity);
    const removed = ctx.contacts.remove(identity);
    const descriptor = ctx.contacts.displayFor(identity, payload.claimed || '');
    emit(ctx, 'contacts', { contacts: ctx.contacts.list(), changed: descriptor });
    return { removed, contact: descriptor };
  });
}

module.exports = { registerContactsIpc };
