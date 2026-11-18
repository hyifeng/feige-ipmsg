'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, nativeImage } = require('electron');
const { t } = require('../../i18n');
const {
  IMAGE_EXTENSIONS,
  IMAGE_MIME,
  MAX_IMAGE_BYTES,
  MAX_READ_IMAGE_BYTES,
} = require('../config');

function ensureImageExt(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(t('main.error.unsupportedImage'));
  return extension;
}

async function ensureImageSize(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error(t('main.error.imageTooLarge'));
  return stat;
}

function registerImageIpc(ctx) {
  ipcMain.handle('feige:pick-image', async () => {
    const result = await dialog.showOpenDialog(ctx.win, {
      title: t('main.dialog.chooseImage'),
      buttonLabel: t('main.dialog.preview'),
      properties: ['openFile'],
      filters: [{ name: t('main.dialog.imageFilter'), extensions: [...IMAGE_EXTENSIONS] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    const extension = ensureImageExt(filePath);
    const stat = await ensureImageSize(filePath);
    let preview = '';
    try {
      const image = nativeImage.createFromPath(filePath);
      if (!image.isEmpty()) {
        const size = image.getSize();
        const scale = Math.min(1, 720 / Math.max(size.width, size.height));
        preview = image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: 'good',
        }).toDataURL();
      }
    } catch {
      /* fallback below */
    }
    if (!preview) {
      preview = `data:${IMAGE_MIME[extension]};base64,${(await fs.promises.readFile(filePath)).toString('base64')}`;
    }
    return { path: filePath, name: path.basename(filePath), size: stat.size, preview };
  });

  ipcMain.handle('feige:save-pasted-image', async (_event, payload = {}) => {
    const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : '';
    const match = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!match) throw new Error(t('main.error.clipboardImageUnsupported'));
    const mime = match[1];
    const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error(t('main.error.imageTooLarge'));
    const dir = path.join(ctx.app.getPath('temp'), 'feige-pasted');
    await fs.promises.mkdir(dir, { recursive: true });
    const filename = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
    const filePath = path.join(dir, filename);
    await fs.promises.writeFile(filePath, buffer);
    return {
      path: filePath,
      name: String(payload.name || t('main.image.pastedName', { ext: extension })).slice(0, 120),
      size: buffer.length,
      preview: dataUrl,
    };
  });

  ipcMain.handle('feige:send-image', async (_event, payload = {}) => {
    if (!ctx.node) throw new Error(t('main.error.networkNotReady'));
    const filePath = String(payload.path || '');
    ensureImageExt(filePath);
    await ensureImageSize(filePath);
    return ctx.node.sendImage(String(payload.peerKey || ''), filePath, {
      thumb: typeof payload.thumb === 'string' ? payload.thumb : '',
      caption: String(payload.caption || '').slice(0, 500),
      name: String(payload.name || path.basename(filePath)).slice(0, 200),
    });
  });

  ipcMain.handle('feige:read-image', async (_event, target) => {
    const filePath = String(target || '');
    const extension = ensureImageExt(filePath);
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_READ_IMAGE_BYTES) throw new Error(t('main.error.imageMissingOrTooLarge'));
    return `data:${IMAGE_MIME[extension]};base64,${(await fs.promises.readFile(filePath)).toString('base64')}`;
  });

  ipcMain.handle('feige:save-file-copy', async (_event, payload = {}) => {
    const source = String(payload.path || '');
    const stat = await fs.promises.stat(source).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(t('main.error.sourceMissing'));
    const suggested = String(payload.name || path.basename(source)).slice(0, 180);
    const result = await dialog.showSaveDialog(ctx.win, {
      title: t('main.dialog.saveImageCopy'),
      buttonLabel: t('main.dialog.save'),
      defaultPath: path.join(ctx.app.getPath('downloads'), suggested),
    });
    if (result.canceled || !result.filePath) return null;
    if (path.resolve(result.filePath) !== path.resolve(source)) {
      await fs.promises.copyFile(source, result.filePath);
    }
    return result.filePath;
  });
}

module.exports = { registerImageIpc };
