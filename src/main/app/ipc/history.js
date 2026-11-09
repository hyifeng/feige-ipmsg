'use strict';

const { ipcMain } = require('electron');
const { decorateContact, contactInfo } = require('../info');
const { isIdentity, identityOfPeerKey } = require('../../../shared/protocol/identity');

function registerHistoryIpc(ctx) {
  ipcMain.handle('feige:history-contacts', async () => {
    if (!ctx.history) return [];
    return (await ctx.history.contacts())
      .filter((peer) => isIdentity(identityOfPeerKey(peer.key)))
      .map((peer) => decorateContact(ctx, peer));
  });

  ipcMain.handle('feige:history-load', async (_event, payload = {}) => {
    if (!ctx.history) return { messages: [], hasMore: false };
    const peerKey = String(payload.peerKey || '');
    if (!peerKey) throw new Error('缺少联系人');
    return ctx.history.loadMessages(peerKey, {
      limit: payload.limit,
      before: payload.before == null ? null : Number(payload.before),
    });
  });

  ipcMain.handle('feige:history-search', async (_event, query) => {
    if (!ctx.history) return [];
    const items = await ctx.history.search(String(query || ''));
    return items
      .filter((item) => isIdentity(identityOfPeerKey(item.peerKey)))
      .map((item) => ({
        ...item,
        peer: item.peer
          ? { ...item.peer, ...contactInfo(ctx, item.peerKey, item.peer.user) }
          : item.peer,
      }));
  });

  ipcMain.handle('feige:history-clear', async () => {
    if (!ctx.history) return false;
    await ctx.history.clearAll();
    return true;
  });
}

module.exports = { registerHistoryIpc };
