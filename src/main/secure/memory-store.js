'use strict';

function createMemoryStore() {
  const map = new Map();
  return {
    get: (peerKey) => map.get(peerKey) || null,
    set: (peerKey, value) => map.set(peerKey, value),
    delete: (peerKey) => map.delete(peerKey),
    list: () => [...map.entries()].map(([peerKey, value]) => ({ peerKey, user: value.user || '未知联系人' })),
  };
}


module.exports = { createMemoryStore };
