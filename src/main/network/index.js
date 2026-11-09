'use strict';

const { FeigeNode } = require('./node');
const { PeerRegistry } = require('./peer-registry');
const { LanTransport, DirectTransport, CompositeTransport } = require('./transport');
const { DiscoveryManager, LanDiscovery } = require('./discovery');
const { HubClient, HubDiscovery } = require('./hub');
const {
  safeRelPath,
  normalizeFiles,
} = require('./files');
const {
  broadcastTargets,
  lanAddresses,
} = require('./utils');
const {
  HEARTBEAT_MS,
  PEER_TIMEOUT_MS,
} = require('./constants');

module.exports = {
  FeigeNode,
  PeerRegistry,
  LanTransport,
  DirectTransport,
  CompositeTransport,
  DiscoveryManager,
  LanDiscovery,
  HubClient,
  HubDiscovery,
  safeRelPath,
  normalizeFiles,
  broadcastTargets,
  lanAddresses,
  HEARTBEAT_MS,
  PEER_TIMEOUT_MS,
};
