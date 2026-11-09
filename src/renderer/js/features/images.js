import { escapeHtml, formatBytes } from '../core/format.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { findMessageById } from './messages.js';
import { closeModal } from './modals.js';
import { activePeer } from './peers.js';

function imagePath(message) {
  if (!message) return null;
  if (message.localPath) return message.localPath;
  if (message.direction === 'out' && message.path) return message.path;
  const transfer = state.transfers.get(message.transferId);
  if (transfer && transfer.direction === 'in' && transfer.root && transfer.files && transfer.files[0]) {
    return `${transfer.root}/${transfer.files[0].relPath}`;
  }
  return null;
}

function imageStatus(message) {
  const transfer = state.transfers.get(message.transferId);
  const stateValue = transfer ? transfer.status : (message.imageState && message.imageState.status) || 'waiting';
  const done = transfer ? transfer.doneBytes : (message.imageState && message.imageState.doneBytes) || 0;
  const total = transfer ? transfer.totalBytes : (message.imageState && message.imageState.totalBytes) || message.size || 0;
  const percent = stateValue === 'done' ? 100 : total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
  let label;
  let short;
  if (stateValue === 'done') {
    label = message.direction === 'out' ? '已发送' : '已接收';
    short = label;
  } else if (stateValue === 'active') {
    label = `接收中 ${percent}%`;
    short = '传输中';
  } else if (stateValue === 'waiting') {
    label = message.direction === 'out' ? '等待对方接收' : '准备接收';
    short = '等待接收';
  } else if (stateValue === 'error') {
    label = (message.imageState && message.imageState.error) || '图片传输失败';
    short = '失败';
  } else if (stateValue === 'declined') {
    label = '对方拒绝接收';
    short = '被拒绝';
  } else if (stateValue === 'canceled') {
    label = '图片传输已取消';
    short = '已取消';
  } else {
    label = '等待传输';
    short = '等待';
  }
  return { state: stateValue, percent, label, short, error: stateValue === 'error' };
}

function imageMessageHtml(message) {
  const status = imageStatus(message);
  const name = message.name || '图片';
  const size = Number(message.size) || (state.transfers.get(message.transferId)?.totalBytes) || 0;
  const thumb = typeof message.thumb === 'string' ? message.thumb : '';
  const canOpen = imagePath(message) || thumb;
  const openAttr = canOpen ? 'data-image-open="1"' : '';
  const active = status.state === 'active' || status.state === 'waiting';
  const imageTag = thumb
    ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" ${openAttr} loading="lazy" />`
    : `<div class="image-placeholder" ${openAttr}><span class="ico">${icon('image', 30)}</span><small>${imagePath(message) ? '点击查看图片' : '图片接收后显示'}</small></div>`;
  return `
    <div class="image-msg" data-image-transfer="${escapeHtml(message.transferId || '')}" data-image-status="${escapeHtml(status.state)}">
      <div class="image-card ${status.error ? 'error' : ''}" ${openAttr}>
        ${imageTag}
        <div class="image-progress ${active ? '' : 'is-hidden'}" data-image-progress><i style="width:${status.percent}%"></i></div>
        <span class="image-state-badge ${status.error ? 'error' : ''}" data-image-badge>${escapeHtml(status.short)}</span>
      </div>
      <div class="image-info">
        <span class="image-info-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="image-info-meta" data-image-meta>${escapeHtml(formatBytes(size))} · ${escapeHtml(status.label)}</span>
      </div>
    </div>`;
}

function updateImageCards(transfer) {
  if (!transfer || !transfer.id) return;
  const nodes = document.querySelectorAll(`[data-image-transfer="${CSS.escape(transfer.id)}"]`);
  for (const node of nodes) {
    const message = findMessageById(node.closest('[data-message-id]')?.dataset.messageId);
    if (!message) continue;
    const status = imageStatus(message);
    node.dataset.imageStatus = status.state;
    node.querySelector('.image-card')?.classList.toggle('error', status.error);
    const progress = node.querySelector('[data-image-progress]');
    if (progress) progress.classList.toggle('is-hidden', !(status.state === 'active' || status.state === 'waiting'));
    const bar = node.querySelector('[data-image-progress] i');
    if (bar) bar.style.width = `${status.percent}%`;
    const badge = node.querySelector('[data-image-badge]');
    if (badge) {
      badge.textContent = status.short;
      badge.classList.toggle('error', status.error);
    }
    const meta = node.querySelector('[data-image-meta]');
    if (meta) meta.textContent = `${formatBytes(Number(message.size) || transfer.totalBytes || 0)} · ${status.label}`;
    const image = node.querySelector('img[data-image-open]');
    if (image && !image.getAttribute('src') && message.thumb) image.src = message.thumb;
    if (status.state === 'done' && imagePath(message)) {
      node.querySelector('.image-card')?.setAttribute('data-image-open', '1');
      const placeholder = node.querySelector('.image-placeholder');
      if (placeholder) {
        placeholder.setAttribute('data-image-open', '1');
        const hint = placeholder.querySelector('small');
        if (hint) hint.textContent = '点击查看图片';
      }
    }
  }
}

let imageMenuElement = null;
let imageMenuCleanup = null;

function closeImageMenu() {
  if (imageMenuCleanup) {
    imageMenuCleanup();
    imageMenuCleanup = null;
  }
  if (imageMenuElement) {
    imageMenuElement.remove();
    imageMenuElement = null;
  }
}

async function saveImageMessage(message) {
  const source = imagePath(message);
  if (!source) {
    toast('原图文件不存在，可能已被移动或删除', 'warn');
    return;
  }
  try {
    const saved = await window.feige.saveFileCopy({
      path: source,
      name: message.name || '图片',
    });
    if (saved) toast('图片已转存', 'success');
  } catch (error) {
    toast(error.message || '转存失败', 'error');
  }
}

function openImageMenu(event, message) {
  closeImageMenu();
  const source = imagePath(message);
  const menu = document.createElement('div');
  menu.className = 'image-menu';
  menu.innerHTML = `
    <button data-image-save>${icon('download', 15)}<span>转存到…</span></button>
    ${source ? `<button data-image-folder>${icon('folder', 15)}<span>在文件夹中显示</span></button>` : ''}`;
  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  imageMenuElement = menu;

  const onPointer = (pointerEvent) => {
    if (!menu.contains(pointerEvent.target)) closeImageMenu();
  };
  const onKey = (keyEvent) => {
    if (keyEvent.key === 'Escape') closeImageMenu();
  };
  const onScroll = () => closeImageMenu();
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', onScroll);
  window.addEventListener('scroll', onScroll, true);
  imageMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', onScroll);
    window.removeEventListener('scroll', onScroll, true);
  };

  menu.addEventListener('click', async (clickEvent) => {
    if (clickEvent.target.closest('[data-image-save]')) {
      closeImageMenu();
      await saveImageMessage(message);
    } else if (clickEvent.target.closest('[data-image-folder]')) {
      closeImageMenu();
      if (source) window.feige.showInFolder(source);
    }
  });
}

async function openImageLightbox(message) {
  if (!message || state.modal) return;
  const source = imagePath(message);
  const thumb = typeof message.thumb === 'string' ? message.thumb : '';
  const status = imageStatus(message);
  if (message.direction === 'in' && status.state !== 'done' && !message.localPath) {
    toast(status.state === 'error' ? '图片传输失败，无法查看原图' : '原图还在接收中，请稍候再打开', 'info');
    return;
  }
  if (!source && !thumb) {
    toast('图片还未接收完成', 'warn');
    return;
  }
  state.modal = { type: 'image-view' };
  const title = message.name || '图片';
  dom.modalRoot.innerHTML = `
    <div class="image-view" data-modal-backdrop data-image-view>
      <button class="lightbox-close" data-close-modal title="关闭">${icon('x', 20)}</button>
      <button class="lightbox-zoom" data-lightbox-zoom>原始大小</button>
      <div class="lightbox-frame" data-lightbox-frame>
        <img id="lightboxImage" src="${escapeHtml(thumb)}" alt="${escapeHtml(title)}" />
        <div class="lightbox-caption">
          <span>${escapeHtml(title)}</span>
          <span class="mono">${formatBytes(message.size || 0)}</span>
          <span class="lightbox-hint" id="lightboxHint">${source ? '正在加载原图…' : '仅显示缩略图，原图文件不可用'}</span>
        </div>
      </div>
    </div>`;
  const view = dom.modalRoot.querySelector('.image-view');
  const image = dom.modalRoot.querySelector('#lightboxImage');
  const hint = dom.modalRoot.querySelector('#lightboxHint');
  const zoomButton = dom.modalRoot.querySelector('[data-lightbox-zoom]');
  const toggleActual = () => {
    const actual = view.classList.toggle('actual');
    zoomButton.textContent = actual ? '适应窗口' : '原始大小';
    view.scrollTop = 0;
    view.scrollLeft = 0;
  };
  image.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleActual();
  });
  zoomButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleActual();
  });
  if (source) {
    image.classList.add('loading');
    try {
      const full = await window.feige.readImage(source);
      if (image.isConnected) {
        image.src = full;
        image.classList.remove('loading');
        if (hint) hint.textContent = '点击图片切换原始大小';
      }
    } catch (error) {
      image.classList.remove('loading');
      if (hint) hint.textContent = '原图读取失败，当前为缩略图';
      toast(error.message || '原图读取失败', 'warn');
    }
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

function createImageThumbnail(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        let max = 420;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const scale = Math.min(1, max / Math.max(image.width || 1, image.height || 1));
          const width = Math.max(1, Math.round((image.width || 1) * scale));
          const height = Math.max(1, Math.round((image.height || 1) * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('无法创建缩略图');
          context.drawImage(image, 0, 0, width, height);
          const quality = [0.68, 0.56, 0.46][attempt];
          const thumb = canvas.toDataURL('image/webp', quality);
          if (thumb.length <= 26000) {
            resolve(thumb);
            return;
          }
          max = attempt === 0 ? 300 : 200;
        }
        resolve('');
      } catch {
        resolve(dataUrl.length <= 20000 ? dataUrl : '');
      }
    };
    image.onerror = () => resolve('');
    image.src = dataUrl;
  });
}

function openImagePreview(image) {
  if (!image || state.modal) return;
  const peer = activePeer();
  if (!peer || !peer.online) {
    toast('请先选择一位在线同事', 'warn');
    return;
  }
  if (!state.self.ready) {
    toast('网络服务尚未就绪', 'warn');
    return;
  }
  state.modal = { type: 'image-preview' };
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal image-send-modal" role="dialog" aria-modal="true" aria-label="发送图片">
        <div class="modal-head">
          <div>
            <h3>发送图片</h3>
            <p>发送给 ${escapeHtml(peer.user)}</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="image-preview-box">
          <img src="${escapeHtml(image.preview)}" alt="${escapeHtml(image.name)}" />
        </div>
        <div class="image-preview-meta">
          <span class="image-preview-name" title="${escapeHtml(image.name)}">${escapeHtml(image.name)}</span>
          <span class="mono">${formatBytes(image.size)}</span>
        </div>
        <input class="input image-caption-input" id="imageCaption" maxlength="500" placeholder="添加图片说明（可选）" />
        <div class="image-preview-note">${icon('lock', 12)} 图片会自动通过加密会话传输；接收后会直接显示在聊天中。</div>
        <div class="modal-actions">
          <button class="btn ghost" data-close-modal>取消</button>
          <button class="btn primary" id="imageSendBtn">${icon('send', 15)} 发送图片</button>
        </div>
      </div>
    </div>`;

  const sendButton = dom.modalRoot.querySelector('#imageSendBtn');
  const captionInput = dom.modalRoot.querySelector('#imageCaption');
  captionInput.focus();
  captionInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendButton.click();
    }
  });
  sendButton.addEventListener('click', async () => {
    sendButton.disabled = true;
    sendButton.textContent = '处理中…';
    try {
      const thumb = await createImageThumbnail(image.preview);
      await window.feige.sendImage({
        peerKey: peer.key,
        path: image.path,
        name: image.name,
        thumb,
        caption: captionInput.value.trim(),
      });
      closeModal();
      toast('正在发送图片…', 'success');
    } catch (error) {
      sendButton.disabled = false;
      sendButton.innerHTML = `${icon('send', 15)} 发送图片`;
      toast(error.message || '发送图片失败', 'error');
    }
  });
}

async function chooseImageForActive() {
  if (!state.self.online) {
    toast('已下线，上线后才能发送图片', 'warn');
    return;
  }
  const peer = activePeer();
  if (!peer || !peer.online) {
    toast('请先选择一位在线同事', 'warn');
    return;
  }
  try {
    const image = await window.feige.pickImage();
    if (image) openImagePreview(image);
  } catch (error) {
    toast(error.message || '无法选择图片', 'error');
  }
}

async function handleImagePaste(event) {
  if (!state.active || state.modal || !state.self.ready) return;
  if (!state.self.online) {
    toast('已下线，上线后才能发送图片', 'warn');
    return;
  }
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find((item) => item.type && item.type.startsWith('image/'));
  if (!imageItem) return;
  const peer = activePeer();
  if (!peer || !peer.online) return;
  event.preventDefault();
  try {
    const file = imageItem.getAsFile();
    if (!file) throw new Error('剪贴板中没有图片');
    const dataUrl = await blobToDataUrl(file);
    const image = await window.feige.savePastedImage({
      dataUrl,
      name: file.name || '粘贴的图片.png',
    });
    openImagePreview(image);
  } catch (error) {
    toast(error.message || '无法读取剪贴板图片', 'error');
  }
}

export { imagePath, imageStatus, imageMessageHtml, updateImageCards, closeImageMenu, saveImageMessage, openImageMenu, openImageLightbox, blobToDataUrl, createImageThumbnail, openImagePreview, chooseImageForActive, handleImagePaste };
