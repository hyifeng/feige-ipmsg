'use strict';

const { selfInfo, peerList, decorateContact } = require('./info');
const { isIdentity, identityOfPeerKey } = require('../../shared/protocol/identity');

async function buildStateSnapshot(ctx) {
  const historyPeers = ctx.history
    ? (await ctx.history.contacts())
      .filter((peer) => isIdentity(identityOfPeerKey(peer.key)))
      .map((peer) => decorateContact(ctx, peer))
    : [];

  return {
    locked: false,
    self: selfInfo(ctx),
    peers: peerList(ctx),
    settings: ctx.settings,
    transfers: ctx.node ? ctx.node.getTransfers() : [],
    historyPeers,
    contacts: ctx.contacts ? ctx.contacts.list() : [],
    securePairings: ctx.node && ctx.node.secure ? ctx.node.secure.listPairings() : [],
    secureSessions: ctx.node && ctx.node.secure ? ctx.node.secure.getActiveSessions() : [],
  };
}

module.exports = { buildStateSnapshot };
