'use strict';

const path = require('node:path');

function fileStateFromTransfer(transfer) {
  return {
    status: String(transfer.status || 'waiting').slice(0, 24),
    doneBytes: Math.max(0, Math.floor(Number(transfer.doneBytes) || 0)),
    totalBytes: Math.max(0, Math.floor(Number(transfer.totalBytes) || 0)),
    completedFiles: Math.max(0, Math.floor(Number(transfer.completedFiles) || 0)),
    totalFiles: Math.max(0, Math.floor(Number(transfer.totalFiles) || 0)),
    error: transfer.error ? String(transfer.error).slice(0, 500) : null,
    root: transfer.root ? String(transfer.root) : null,
  };
}

function incomingFileMessage(offer) {
  return {
    id: `offer:${offer.id}`,
    peerKey: offer.peerKey,
    peerName: offer.peerName,
    direction: 'in',
    kind: 'files',
    text: offer.text || '',
    files: offer.files,
    totalBytes: offer.totalBytes,
    totalFiles: offer.totalFiles,
    totalDirs: offer.totalDirs,
    totalEntries: offer.totalEntries,
    rootName: offer.rootName,
    isFolder: offer.isFolder,
    transferId: offer.id,
    offerId: offer.id,
    at: offer.at || Date.now(),
    fileState: {
      status: 'pending',
      doneBytes: 0,
      totalBytes: offer.totalBytes || 0,
      completedFiles: 0,
      totalFiles: offer.totalFiles || 0,
      error: null,
      root: null,
    },
  };
}

function outgoingFileMessage(snapshot, peerKey, caption) {
  return {
    id: `file-out:${snapshot.id}`,
    peerKey,
    peerName: snapshot.peerName,
    direction: 'out',
    kind: 'files',
    text: caption || '',
    files: snapshot.files,
    totalBytes: snapshot.totalBytes,
    totalFiles: snapshot.totalFiles,
    totalDirs: snapshot.totalDirs,
    totalEntries: snapshot.totalEntries,
    rootName: snapshot.rootName,
    isFolder: snapshot.isFolder,
    transferId: snapshot.id,
    at: snapshot.createdAt || Date.now(),
    fileState: fileStateFromTransfer(snapshot),
  };
}

function transferMessageId(transfer) {
  return transfer.direction === 'in' ? `offer:${transfer.id}` : `file-out:${transfer.id}`;
}

function persistMessage(ctx, message) {
  if (!ctx.history) return;
  const peer = ctx.node ? ctx.node.peers.get(message.peerKey) : null;
  const kind = message.kind === 'image' ? 'image' : 'text';
  ctx.history.append({
    ...message,
    kind,
    peerName: message.peerName || (peer && peer.user) || '未知联系人',
    status: kind === 'text' && message.direction === 'out' ? (message.status || 'sent') : undefined,
  }, peer).catch((error) => console.error('[feige] 保存聊天记录失败', error));
}

async function sendPathsWithHistory(ctx, peerKey, paths, caption = '') {
  if (!ctx.node) throw new Error('网络尚未就绪');
  const snapshot = await ctx.node.sendPaths(peerKey, paths, caption);
  if (snapshot && ctx.history) {
    const peer = ctx.node.peers.get(peerKey) || null;
    try {
      await ctx.history.append(outgoingFileMessage(snapshot, peerKey, caption), peer);
    } catch (error) {
      console.error('[feige] 保存文件消息失败', error);
    }
  }
  return snapshot;
}

/** 图片转存/状态补丁统一在这里构造，避免 IPC 与事件层重复。 */
function imageStatusPatch(transfer) {
  const patch = { imageState: fileStateFromTransfer(transfer) };
  if (transfer.status === 'done' && transfer.direction === 'in' && transfer.root && transfer.files[0]) {
    patch.localPath = path.join(transfer.root, transfer.files[0].relPath);
  }
  return patch;
}

module.exports = {
  fileStateFromTransfer,
  incomingFileMessage,
  outgoingFileMessage,
  transferMessageId,
  persistMessage,
  sendPathsWithHistory,
  imageStatusPatch,
};
