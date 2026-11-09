'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');

const { OutgoingNode } = require('./node-outgoing');
const { isSecureFileOfferData } = require('../../shared/protocol');
const {
  MAX_PARALLEL_FILES,
  MAX_ATTACH_FILES,
} = require('./constants');
const { now } = require('./utils');
const { safeRelPath, topSegment, normalizeFiles, uniqueTopNames, replaceTopSegment } = require('./files');

class IncomingNode extends OutgoingNode {
  async acceptOffer(offerId, saveDir = '') {
    if (!this.online) throw new Error('已下线，上线后才能接收文件');
    const offer = this.incomingOffers.get(offerId);
    if (!offer) throw new Error('传输请求不存在或已失效');
    if (offer.accepted) {
      const existing = this.incomingTransfers.get(offerId);
      return existing ? this._snapshot(existing) : null;
    }
    offer.accepted = true;

    try {
      if (!this.secure.isActive(offer.peerKey)) throw new Error('加密会话已断开，请重新建立加密会话');
      // 大目录的完整清单也走当前加密通道。
      let sourceFiles = offer.files;
      if (offer.needsManifest) {
        const manifest = await this._fetchSecureManifest(offer);
        sourceFiles = normalizeFiles(manifest, MAX_ATTACH_FILES);
      }
      if (!sourceFiles.length) throw new Error('文件列表为空');

      const totalBytes = sourceFiles.reduce((sum, file) => sum + (file.dir ? 0 : file.size), 0);
      const totalFiles = sourceFiles.filter((file) => !file.dir).length;
      const totalDirs = sourceFiles.filter((file) => file.dir).length;
      const totalEntries = sourceFiles.length;
      const rootName = String(offer.rootName || '文件').slice(0, 255);
      const isFolder = !!offer.isFolder;

      const root = path.resolve(saveDir || this.downloadDir);
      await fsp.mkdir(root, { recursive: true });

      const nameMap = await uniqueTopNames(root, sourceFiles.map((file) => file.relPath));
      const record = {
        id: offer.id,
        direction: 'in',
        peerKey: offer.peerKey,
        peerName: offer.peer.user,
        peerIp: offer.peer.ip,
        peerPort: offer.peer.port,
        files: [],
        totalBytes,
        totalFiles,
        totalDirs,
        totalEntries,
        rootName,
        isFolder,
        image: !!offer.image,
        secure: true,
        doneBytes: 0,
        completedFiles: 0,
        status: 'active',
        error: null,
        root,
        createdAt: now(),
        updatedAt: now(),
        samples: [],
        lastEmit: 0,
        activeCount: 0,
        queue: [],
      };

      const usedRelPaths = new Set();
      for (const file of sourceFiles) {
        const safe = safeRelPath(file.relPath);
        if (!safe) continue;
        const top = topSegment(safe);
        let mapped = replaceTopSegment(safe, nameMap.get(top) || top);
        if (usedRelPaths.has(mapped)) {
          const parts = mapped.split('/');
          const base = parts.pop();
          const dot = base.lastIndexOf('.');
          const stem = dot > 0 ? base.slice(0, dot) : base;
          const ext = dot > 0 ? base.slice(dot) : '';
          let index = 1;
          let candidate;
          do {
            candidate = [...parts, `${stem} (${index})${ext}`].join('/');
            index += 1;
          } while (usedRelPaths.has(candidate));
          mapped = candidate;
        }
        usedRelPaths.add(mapped);

        const rootResolved = path.resolve(root);
        const target = path.resolve(root, mapped);
        if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) continue;

        record.files.push({
          id: file.id,
          name: file.name,
          relPath: mapped,
          size: file.size,
          dir: !!file.dir,
          received: 0,
          done: !!file.dir,
          target,
          stream: null,
          socket: null,
          started: false,
        });
        if (file.dir) record.completedFiles += 1;
      }

      if (!record.files.length) throw new Error('文件列表为空');

      for (const file of record.files) {
        if (file.dir) {
          await fsp.mkdir(file.target, { recursive: true }).catch(() => {});
        } else {
          await fsp.mkdir(path.dirname(file.target), { recursive: true });
        }
      }

      record.queue = record.files.filter((file) => !file.dir && !file.done);
      this.incomingTransfers.set(record.id, record);
      this._emitTransfer(record);
      this._pumpIncoming(record);
      return this._snapshot(record);
    } catch (err) {
      offer.accepted = false;
      throw err;
    }
  }

  declineOffer(offerId) {
    const offer = this.incomingOffers.get(offerId);
    if (!offer) return false;
    this.incomingOffers.delete(offerId);
    this._sendRelease(offer.peerKey, offerId);
    this.emit('offer-closed', { id: offerId, peerKey: offer.peerKey, reason: 'declined' });
    return true;
  }

  cancelTransfer(transferId) {
    const pendingOffer = this.incomingOffers.get(transferId);
    if (pendingOffer && !pendingOffer.accepted) {
      this.incomingOffers.delete(transferId);
      this.emit('offer-closed', { id: transferId, peerKey: pendingOffer.peerKey, reason: 'canceled' });
    }

    const outgoing = this.outgoingTransfers.get(transferId);
    if (outgoing && outgoing.status !== 'done' && outgoing.status !== 'canceled') {
      outgoing.status = 'canceled';
      outgoing.error = '已取消';
      this._sendRelease(outgoing.peerKey, transferId);
      for (const file of outgoing.files) {
        try {
          file.socket && file.socket.destroy();
        } catch {
          /* ignore */
        }
        try {
          file.readStream && file.readStream.destroy();
        } catch {
          /* ignore */
        }
      }
      this._emitTransfer(outgoing, true);
      return true;
    }

    const incoming = this.incomingTransfers.get(transferId);
    if (incoming && incoming.status !== 'done' && incoming.status !== 'canceled') {
      incoming.status = 'canceled';
      incoming.error = '已取消';
      this._sendRelease(incoming.peerKey, transferId);
      for (const file of incoming.files) {
        try {
          file.socket && file.socket.destroy();
        } catch {
          /* ignore */
        }
        try {
          file.stream && file.stream.destroy();
        } catch {
          /* ignore */
        }
        if (!file.done && file.target) fsp.unlink(file.target).catch(() => {});
      }
      incoming.activeCount = 0;
      incoming.queue = [];
      if (incoming.secure) this.secure.resume(incoming.peerKey);
      this._emitTransfer(incoming, true);
      this.incomingOffers.delete(transferId);
      return true;
    }
    return false;
  }

  _createIncomingOffer(key, peer, text, meta) {
    const source = meta && typeof meta === 'object' ? meta : {};
    if (!isSecureFileOfferData(source)) return false;
    const files = normalizeFiles(source.files);
    const needsManifest = source.manifest;
    if (!files.length && !needsManifest) return false;
    const rawTransferId = source.transferId;
    const totalFiles = source.totalFiles;
    const totalDirs = source.totalDirs;
    const totalEntries = source.totalEntries;
    const totalBytes = source.totalBytes;
    const rootName = source.rootName.trim().slice(0, 255);
    const safePeer = peer || {
      key,
      user: source.peerName || '未知联系人',
      host: '',
      ip: '',
      port: 0,
      online: true,
    };
    const offer = {
      id: rawTransferId,
      peerKey: key,
      peerName: safePeer.user,
      peer: { ...safePeer },
      text: text || '',
      files,
      totalBytes,
      totalFiles,
      totalDirs,
      totalEntries,
      rootName,
      isFolder: source.isFolder,
      image: source.image,
      thumb: typeof source.thumb === 'string' ? source.thumb.slice(0, 40000) : '',
      needsManifest,
      secure: true,
      at: source.at,
      accepted: false,
    };
    this.incomingOffers.set(offer.id, offer);
    if (offer.image) {
      const first = offer.files.find((file) => !file.dir) || offer.files[0];
      this.emit('message', {
        id: `image-in:${offer.id}`,
        peerKey: key,
        peerName: safePeer.user,
        direction: 'in',
        kind: 'image',
        at: offer.at,
        text: offer.text,
        name: first ? first.name : '图片',
        size: first ? first.size : 0,
        thumb: offer.thumb,
        transferId: offer.id,
        secure: offer.secure,
        imageState: {
          status: 'waiting',
          doneBytes: 0,
          totalBytes: offer.totalBytes,
          totalFiles: 1,
          completedFiles: 0,
          error: null,
          root: null,
        },
      });
      // 图片属于聊天消息，自动接收并显示；普通文件仍然需要确认。
      if (this.online) {
        setTimeout(() => {
          this.acceptOffer(offer.id).catch((err) => {
            this.emit('transfer-error', { id: offer.id, message: err.message || String(err) });
          });
        }, 30);
      }
      return true;
    }
    this.emit('offer', {
      ...offer,
      peer: { ...offer.peer },
      files: offer.files.map((file) => ({ ...file })),
    });
    if (this.autoAccept && this.online) {
      setTimeout(() => {
        this.acceptOffer(offer.id).catch((err) => {
          this.emit('transfer-error', { id: offer.id, message: err.message || String(err) });
        });
      }, 30);
    }
    return true;
  }

  _fetchSecureManifest(offer) {
    if (!this.secure.isActive(offer.peerKey)) {
      return Promise.reject(new Error('加密会话已断开'));
    }
    return new Promise((resolve, reject) => {
      const id = offer.id;
      if (this.secureManifestWaiters.has(id)) {
        reject(new Error('文件清单请求重复'));
        return;
      }
      const timer = setTimeout(() => {
        this.secureManifestWaiters.delete(id);
        reject(new Error('获取加密文件清单超时'));
      }, 60000);
      const waiter = {
        peerKey: offer.peerKey,
        transferId: id,
        files: [],
        resolve: (files) => resolve(files),
        reject,
        timer,
      };
      this.secureManifestWaiters.set(id, waiter);
      this.secure.send(offer.peerKey, { type: 'manifest-request', transferId: id }).catch((error) => {
        clearTimeout(timer);
        this.secureManifestWaiters.delete(id);
        reject(error);
      });
    });
  }

  _ensureSecureFileStream(record, file) {
    if (file.stream) return file.stream;
    const stream = fs.createWriteStream(file.target, { flags: 'w' });
    file.stream = stream;
    stream.on('error', (error) => this._failIncoming(record, error));
    stream.on('drain', () => this.secure.resume(record.peerKey));
    stream.on('finish', () => {
      if (record.status !== 'active' || file.done) return;
      if (file.received !== file.size) {
        this._failIncoming(record, new Error('文件大小校验失败'));
        return;
      }
      this._completeIncomingFile(record, file);
    });
    return stream;
  }

  _onSecureFileChunk(peerKey, payload) {
    const record = this.incomingTransfers.get(String(payload.transferId || ''));
    if (!record || record.status !== 'active') return;
    const file = record.files.find((item) => item.id === String(payload.fileId || '') && !item.dir);
    if (!file || file.done) return;
    const sequence = Number(payload.seq);
    if (!Number.isInteger(sequence) || sequence !== (file.secureSeq || 0)) {
      this._failIncoming(record, new Error('加密文件分块顺序错误'));
      return;
    }
    file.secureSeq = sequence + 1;
    const chunk = Buffer.from(String(payload.data || ''), 'base64');
    if (file.received + chunk.length > file.size) {
      this._failIncoming(record, new Error('加密文件大小超出声明'));
      return;
    }
    record.secure = true;
    const stream = this._ensureSecureFileStream(record, file);
    if (chunk.length) {
      file.received += chunk.length;
      record.doneBytes += chunk.length;
      if (!stream.write(chunk)) this.secure.pause(peerKey);
      this._touch(record);
    }
  }

  _onSecureFileEnd(peerKey, payload) {
    const record = this.incomingTransfers.get(String(payload.transferId || ''));
    if (!record || record.status !== 'active') return;
    const file = record.files.find((item) => item.id === String(payload.fileId || '') && !item.dir);
    if (!file || file.done || file.secureEnded) return;
    if (file.received !== file.size) {
      this._failIncoming(record, new Error('加密文件大小不完整'));
      return;
    }
    file.secureEnded = true;
    record.secure = true;
    const stream = this._ensureSecureFileStream(record, file);
    stream.end();
  }

  _pumpIncoming(record) {
    if (record.status !== 'active') return;
    record.activeCount = record.activeCount || 0;

    while (record.activeCount < MAX_PARALLEL_FILES && record.queue && record.queue.length) {
      const file = record.queue.shift();
      if (!file || file.done || file.started) continue;
      file.started = true;
      record.activeCount += 1;
      try {
        this._requestFile(record, file);
      } catch (err) {
        this._failIncoming(record, err);
        return;
      }
    }

    this._maybeFinishIncoming(record);
  }

  _requestFile(record, file) {
    const peer = this.peers.get(record.peerKey);
    if (!peer || !peer.online) throw new Error('对方已离线');

    if (!this.secure.isActive(record.peerKey)) throw new Error('加密会话已断开');
    this.secure.send(record.peerKey, {
      type: 'file-request',
      transferId: record.id,
      fileId: file.id,
      offset: 0,
    }).catch((error) => this._failIncoming(record, error));
  }

  _completeIncomingFile(record, file) {
    if (file.done) return;
    file.done = true;
    file.received = file.size;
    record.completedFiles = record.files.filter((item) => item.done).length;
    record.activeCount = Math.max(0, (record.activeCount || 0) - 1);
    this._emitTransfer(record, true);
    this._pumpIncoming(record);
    this._maybeFinishIncoming(record);
  }

  _maybeFinishIncoming(record) {
    if (record.status !== 'active') return;
    if (record.files.every((file) => file.done)) {
      record.status = 'done';
      record.finishedAt = now();
      this._emitTransfer(record, true);
      this.emit('transfer-done', {
        id: record.id,
        direction: 'in',
        peerKey: record.peerKey,
        peerName: record.peerName,
        root: record.root,
        fileCount: record.totalFiles,
        image: !!record.image,
      });
      this.incomingOffers.delete(record.id);
    }
  }

  _failIncoming(record, err) {
    if (!record || record.status === 'done' || record.status === 'canceled' || record.status === 'error') return;
    record.status = 'error';
    record.error = err && err.message ? err.message : String(err);
    for (const file of record.files) {
      try {
        file.socket && file.socket.destroy();
      } catch {
        /* ignore */
      }
      try {
        file.stream && file.stream.destroy();
      } catch {
        /* ignore */
      }
      if (!file.done && file.target) fsp.unlink(file.target).catch(() => {});
    }
    record.activeCount = 0;
    record.queue = [];
    if (record.secure) this.secure.resume(record.peerKey);
    this._emitTransfer(record, true);
    this.emit('transfer-error', { id: record.id, direction: 'in', message: record.error });
  }
}

module.exports = { IncomingNode };
