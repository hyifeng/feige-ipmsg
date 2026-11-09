'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { MessagingNode } = require('./node-messaging');
const {
  PREVIEW_FILES,
  MAX_ATTACH_FILES,
} = require('./constants');
const { now, uid } = require('./utils');
const { topSegment, walkDirectory } = require('./files');

class OutgoingNode extends MessagingNode {
  sendImage(peerKey, filePath, options = {}) {
    return this.sendPaths(peerKey, [filePath], options.caption || '', {
      image: true,
      thumb: options.thumb || '',
      imageName: options.name || '',
    });
  }

  async sendPaths(peerKey, paths, caption = '', options = {}) {
    if (!this.online) throw new Error('已下线，上线后才能发送文件');
    const peer = this._requirePeer(peerKey);
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('请选择要发送的文件或文件夹');

    // 文件报价、清单和文件内容都只走加密会话；没有会话时先自动建立
    // 临时加密会话。已认证联系人会走 pairing key 自动恢复。
    await this._ensureSecure(peerKey);

    const files = [];
    for (const input of paths) {
      files.push(...(await this._collectPath(input)));
    }
    if (!files.length) throw new Error('没有可发送的文件');
    if (files.length > MAX_ATTACH_FILES) {
      throw new Error(`单次传输最多支持 ${MAX_ATTACH_FILES} 个条目`);
    }
    if (options.image && files.length === 1) {
      const originalExt = path.extname(files[0].name);
      let desired = String(options.imageName || '').replace(/\\/g, '/');
      desired = path.posix.basename(desired).replace(/[\x00-\x1f]/g, '').trim().slice(0, 200);
      if (desired && desired !== '.' && desired !== '..') {
        if (!path.extname(desired) && originalExt) desired += originalExt;
        files[0].name = desired;
        files[0].relPath = desired;
      }
    }

    const transferId = uid();
    const totalBytes = files.reduce((sum, file) => sum + (file.dir ? 0 : file.size), 0);
    const totalFiles = files.filter((file) => !file.dir).length;
    const totalDirs = files.filter((file) => file.dir).length;
    const totalEntries = files.length;
    const tops = new Set(files.map((file) => topSegment(file.relPath)));
    const rootName = tops.size === 1 ? [...tops][0] : (files[0] && files[0].name) || '文件';
    const isFolder = tops.size === 1 && files.some((file) => file.dir || file.relPath.includes('/'));
    // 报价只放摘要 + 前 8 项预览；较大目录在接收方确认后经加密通道拉取完整清单。
    const useManifest = totalEntries > PREVIEW_FILES;
    const preview = files.slice(0, PREVIEW_FILES).map((file) => ({
      id: file.id,
      name: file.name,
      relPath: file.relPath,
      size: file.size,
      mtime: file.mtime,
      dir: file.dir,
    }));

    const captionText = String(caption == null ? '' : caption).replace(/\0/g, '');
    const createdAt = now();
    const isImage = options.image === true;
    const imageThumb = isImage && typeof options.thumb === 'string' ? options.thumb.slice(0, 40000) : '';

    const record = {
      id: transferId,
      direction: 'out',
      peerKey,
      peerName: peer.user,
      peerIp: peer.ip,
      peerPort: peer.port,
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        relPath: file.relPath,
        size: file.size,
        mtime: file.mtime,
        dir: file.dir,
        sent: 0,
        done: file.dir,
        socket: null,
        readStream: null,
      })),
      pathMap: new Map(files.map((file) => [file.id, file.absPath])),
      totalBytes,
      totalFiles,
      totalDirs,
      totalEntries,
      rootName,
      isFolder,
      image: isImage,
      secure: true,
      doneBytes: 0,
      completedFiles: totalDirs,
      status: 'waiting',
      error: null,
      createdAt,
      updatedAt: now(),
      samples: [],
      lastEmit: 0,
    };

    this.outgoingTransfers.set(transferId, record);

    try {
      await this.secure.send(peerKey, {
        type: 'offer',
        offer: {
          id: transferId,
          text: captionText,
          at: record.createdAt,
          files: preview,
          manifest: useManifest,
          totalFiles,
          totalDirs,
          totalEntries,
          totalBytes,
          rootName,
          isFolder,
          image: isImage,
          thumb: imageThumb,
        },
      });
    } catch (error) {
      this._failOutgoing(record, null, error);
      throw error;
    }
    this._emitTransfer(record);

    if (isImage) {
      const first = record.files.find((file) => !file.dir) || record.files[0];
      this.emit('message', {
        id: `image-out:${transferId}`,
        peerKey,
        peerName: peer.user,
        direction: 'out',
        kind: 'image',
        at: record.createdAt,
        text: captionText,
        name: first ? first.name : '图片',
        size: first ? first.size : 0,
        thumb: imageThumb,
        localPath: first ? record.pathMap.get(first.id) : null,
        transferId,
        secure: record.secure,
        imageState: {
          status: 'waiting',
          doneBytes: 0,
          totalBytes,
          totalFiles: 1,
          completedFiles: 0,
          error: null,
          root: null,
        },
      });
    }

    return this._snapshot(record);
  }

  async _serveSecureManifest(peerKey, transferId) {
    const record = this.outgoingTransfers.get(transferId);
    if (!record || !this.secure.isActive(peerKey)) return;
    record.secure = true;
    const files = record.files.map((file) => ({
      id: file.id,
      name: file.name,
      relPath: file.relPath,
      size: file.size,
      mtime: file.mtime || 0,
      dir: !!file.dir,
    }));
    const chunkSize = 200;
    for (let index = 0; index < files.length; index += chunkSize) {
      await this.secure.send(peerKey, {
        type: 'manifest-chunk',
        transferId,
        files: files.slice(index, index + chunkSize),
      });
    }
    await this.secure.send(peerKey, { type: 'manifest-end', transferId });
  }

  async _serveSecureFile(peerKey, request) {
    const record = this.outgoingTransfers.get(String(request.transferId || ''));
    if (!record || !this.secure.isActive(peerKey)) return;
    const file = record.files.find((item) => item.id === String(request.fileId || '') && !item.dir);
    if (!file || file.sendStarted) return;
    const absPath = record.pathMap.get(file.id);
    if (!absPath) return;
    const offset = request.offset;
    if (!Number.isSafeInteger(offset) || offset !== 0) return;

    file.sendStarted = true;
    record.secure = true;
    if (record.status === 'waiting') {
      record.status = 'active';
      record.startedAt = now();
      this._emitTransfer(record, true);
    }

    const stream = fs.createReadStream(absPath, { start: offset, highWaterMark: 64 * 1024 });
    file.readStream = stream;
    let sequence = 0;
    try {
      for await (const chunk of stream) {
        if (record.status === 'canceled' || record.status === 'error' || record.status === 'done') break;
        if (!this.secure.isActive(peerKey)) throw new Error('加密会话已断开');
        await this.secure.send(peerKey, {
          type: 'file-chunk',
          transferId: record.id,
          fileId: file.id,
          seq: sequence,
          data: chunk.toString('base64'),
        });
        sequence += 1;
        file.sent += chunk.length;
        record.doneBytes += chunk.length;
        this._touch(record);
      }
      if (record.status === 'canceled' || record.status === 'error') return;
      await this.secure.send(peerKey, {
        type: 'file-end',
        transferId: record.id,
        fileId: file.id,
      });
      file.done = true;
      record.completedFiles = record.files.filter((item) => item.done).length;
      this._emitTransfer(record, true);
      this._maybeFinishOutgoing(record);
    } catch (error) {
      if (record.status !== 'canceled' && record.status !== 'done') {
        this._failOutgoing(record, file, error);
      }
    }
  }

  _failOutgoing(record, file, err) {
    if (record.status === 'done' || record.status === 'canceled' || record.status === 'error') return;
    record.status = 'error';
    record.error = err && err.message ? err.message : String(err);
    if (file) file.error = record.error;
    for (const item of record.files) {
      try {
        item.socket && item.socket.destroy();
      } catch {
        /* ignore */
      }
      try {
        item.readStream && item.readStream.destroy();
      } catch {
        /* ignore */
      }
    }
    this._emitTransfer(record, true);
    this.emit('transfer-error', { id: record.id, direction: 'out', message: record.error });
  }

  _maybeFinishOutgoing(record) {
    if (record.status === 'done' || record.status === 'canceled') return;
    if (record.files.every((file) => file.done)) {
      record.status = 'done';
      record.finishedAt = now();
      this._emitTransfer(record, true);
      this.emit('transfer-done', {
        id: record.id,
        direction: 'out',
        peerKey: record.peerKey,
        peerName: record.peerName,
        fileCount: record.totalFiles,
        image: !!record.image,
      });
    }
  }

  async _collectPath(input) {
    const absPath = path.resolve(String(input));
    let stat;
    try {
      stat = await fsp.lstat(absPath);
    } catch {
      throw new Error(`无法读取：${path.basename(absPath)}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`不支持符号链接：${path.basename(absPath)}`);

    const base = path.basename(absPath);

    if (stat.isDirectory()) {
      const out = [];
      await walkDirectory(absPath, base, out);
      if (!out.length) {
        out.push({
          id: uid(),
          name: base,
          relPath: base,
          size: 0,
          mtime: stat.mtimeMs,
          dir: true,
          absPath,
        });
      }
      return out;
    }

    if (stat.isFile()) {
      return [{
        id: uid(),
        name: base,
        relPath: base,
        size: stat.size,
        mtime: stat.mtimeMs,
        dir: false,
        absPath,
      }];
    }

    throw new Error(`不支持的文件类型：${base}`);
  }
}

module.exports = { OutgoingNode };
