'use strict';

function previewOf(message) {
  if (message.kind === 'image') {
    return `[图片] ${String(message.name || '图片').slice(0, 80)}`;
  }
  if (message.kind === 'files') {
    const name = message.rootName || (message.files && message.files[0] && message.files[0].name) || '文件';
    return `${message.isFolder ? '[文件夹]' : '[文件]'} ${name}`.slice(0, 90);
  }
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  return (text || '[消息]').slice(0, 80);
}

function normalizeMessage(raw) {
  const kind = raw.kind === 'files' ? 'files' : raw.kind === 'image' ? 'image' : 'text';
  const message = {
    id: String(raw.id || ''),
    peerKey: String(raw.peerKey || ''),
    peerName: String(raw.peerName || '').slice(0, 64),
    direction: raw.direction === 'out' ? 'out' : 'in',
    kind,
    at: Number(raw.at) || Date.now(),
    text: String(raw.text || ''),
  };

  if (!message.id || !message.peerKey) {
    throw new Error('历史消息缺少 id 或 peerKey');
  }

  if (raw.status) message.status = String(raw.status).slice(0, 24);

  if (kind === 'image') {
    message.name = String(raw.name || '图片').slice(0, 255);
    message.size = Math.max(0, Math.floor(Number(raw.size) || 0));
    message.thumb = typeof raw.thumb === 'string' && raw.thumb.length <= 80000 ? raw.thumb : '';
    message.localPath = raw.localPath ? String(raw.localPath) : null;
    message.transferId = String(raw.transferId || '');
    if (raw.imageState && typeof raw.imageState === 'object') {
      message.imageState = {
        status: String(raw.imageState.status || 'waiting').slice(0, 24),
        doneBytes: Math.max(0, Math.floor(Number(raw.imageState.doneBytes) || 0)),
        totalBytes: Math.max(0, Math.floor(Number(raw.imageState.totalBytes) || 0)),
        completedFiles: Math.max(0, Math.floor(Number(raw.imageState.completedFiles) || 0)),
        totalFiles: Math.max(0, Math.floor(Number(raw.imageState.totalFiles) || 0)),
        error: raw.imageState.error ? String(raw.imageState.error).slice(0, 500) : null,
        root: raw.imageState.root ? String(raw.imageState.root) : null,
      };
    }
  }

  if (kind === 'files') {
    for (const key of ['totalBytes', 'totalFiles', 'totalDirs', 'totalEntries']) {
      message[key] = Math.max(0, Math.floor(Number(raw[key]) || 0));
    }
    message.rootName = String(raw.rootName || '文件').slice(0, 255);
    message.isFolder = !!raw.isFolder;
    message.transferId = String(raw.transferId || '');
    if (raw.offerId) message.offerId = String(raw.offerId);
    message.files = Array.isArray(raw.files)
      ? raw.files.slice(0, 8).map((file) => ({
          id: String(file.id || ''),
          name: String(file.name || '').slice(0, 255),
          relPath: String(file.relPath || file.name || '').slice(0, 512),
          size: Math.max(0, Math.floor(Number(file.size) || 0)),
          dir: !!file.dir,
        }))
      : [];
    if (raw.fileState && typeof raw.fileState === 'object') {
      message.fileState = {
        status: String(raw.fileState.status || 'pending').slice(0, 24),
        doneBytes: Math.max(0, Math.floor(Number(raw.fileState.doneBytes) || 0)),
        totalBytes: Math.max(0, Math.floor(Number(raw.fileState.totalBytes) || 0)),
        completedFiles: Math.max(0, Math.floor(Number(raw.fileState.completedFiles) || 0)),
        totalFiles: Math.max(0, Math.floor(Number(raw.fileState.totalFiles) || 0)),
        error: raw.fileState.error ? String(raw.fileState.error).slice(0, 500) : null,
        root: raw.fileState.root ? String(raw.fileState.root) : null,
      };
    }
  }

  return message;
}

module.exports = { previewOf, normalizeMessage };
