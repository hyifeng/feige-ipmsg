'use strict';

const { t } = require('../i18n');

function createMemoryStore() {
  const map = new Map();
  return {
    get: (peerKey) => map.get(peerKey) || null,
    set: (peerKey, value) => map.set(peerKey, value),
    delete: (peerKey) => map.delete(peerKey),
    list: () => [...map.entries()].map(([peerKey, value]) => ({ peerKey, user: value.user || t('main.contact.unknown') })),
  };
}


module.exports = { createMemoryStore };
