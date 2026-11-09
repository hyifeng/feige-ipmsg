'use strict';

const { IncomingNode } = require('./node-incoming');
const { APP_TAG, PROTOCOL_VERSION } = require('../../shared/protocol');
const { now } = require('./utils');

class SecureNode extends IncomingNode {
  _onSecureData(peerKey, payload) {
    if (!payload || typeof payload.type !== 'string') return;
    const peer = this.peers.get(peerKey)
      || (this.secure.getSession(peerKey) && this.secure.getSession(peerKey).peer)
      || null;
    switch (payload.type) {
      case 'text': {
        if (!payload.id || typeof payload.text !== 'string' || !peer) return;
        if (!Number.isSafeInteger(payload.at) || payload.at <= 0) return;
        this.emit('message', {
          id: String(payload.id),
          peerKey,
          peerName: peer.user || '未知联系人',
          text: payload.text,
          at: payload.at,
          direction: 'in',
          secure: true,
        });
        this.secure.send(peerKey, { type: 'ack', id: payload.id }).catch(() => {});
        break;
      }
      case 'ack': {
        if (!payload.id) break;
        this.emit('ack', { peerKey, messageId: String(payload.id), at: now() });
        break;
      }
      case 'offer': {
        const offer = payload.offer;
        if (!offer || !offer.id) break;
        const meta = {
          app: APP_TAG,
          v: PROTOCOL_VERSION,
          kind: 'files',
          transferId: offer.id,
          manifest: !!offer.manifest,
          totalFiles: offer.totalFiles,
          totalDirs: offer.totalDirs,
          totalEntries: offer.totalEntries,
          totalBytes: offer.totalBytes,
          rootName: offer.rootName,
          isFolder: offer.isFolder,
          image: !!offer.image,
          thumb: typeof offer.thumb === 'string' ? offer.thumb : '',
          at: offer.at,
          files: offer.files,
          peerName: peer && peer.user,
        };
        this._createIncomingOffer(peerKey, peer, offer.text || '', meta);
        break;
      }
      case 'release': {
        if (typeof payload.transferId !== 'string' || !payload.transferId) break;
        this._applyRelease(payload.transferId);
        break;
      }
      case 'manifest-request': {
        this._serveSecureManifest(peerKey, String(payload.transferId || '')).catch((error) => {
          this.emit('error', error);
        });
        break;
      }
      case 'manifest-chunk': {
        const waiter = this.secureManifestWaiters.get(String(payload.transferId || ''));
        if (waiter && Array.isArray(payload.files)) waiter.files.push(...payload.files);
        break;
      }
      case 'manifest-end': {
        const id = String(payload.transferId || '');
        const waiter = this.secureManifestWaiters.get(id);
        if (waiter) {
          this.secureManifestWaiters.delete(id);
          clearTimeout(waiter.timer);
          waiter.resolve(waiter.files);
        }
        break;
      }
      case 'manifest-error': {
        const id = String(payload.transferId || '');
        const waiter = this.secureManifestWaiters.get(id);
        if (waiter) {
          this.secureManifestWaiters.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(new Error(payload.message || '获取加密文件清单失败'));
        }
        break;
      }
      case 'file-request': {
        this._serveSecureFile(peerKey, payload).catch((error) => {
          this.emit('error', error);
        });
        break;
      }
      case 'file-chunk': {
        this._onSecureFileChunk(peerKey, payload);
        break;
      }
      case 'file-end': {
        this._onSecureFileEnd(peerKey, payload);
        break;
      }
      default:
        break;
    }
  }

  _failSecureTransfersForPeer(peerKey, reason) {
    for (const record of this.outgoingTransfers.values()) {
      if (record.secure && record.peerKey === peerKey && (record.status === 'waiting' || record.status === 'active')) {
        this._failOutgoing(record, null, new Error(reason));
      }
    }
    for (const record of this.incomingTransfers.values()) {
      if (record.secure && record.peerKey === peerKey && record.status === 'active') {
        this._failIncoming(record, new Error(reason));
      }
    }
    for (const [id, waiter] of this.secureManifestWaiters) {
      if (waiter.peerKey === peerKey) {
        clearTimeout(waiter.timer);
        this.secureManifestWaiters.delete(id);
        waiter.reject(new Error(reason));
      }
    }
  }
}

module.exports = { SecureNode };
