import { displayFor } from '../core/contacts.js';
import { avatarStyle, escapeHtml, fileInfo, formatBytes, initials } from '../core/format.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { markOfferMessage, refreshMessagesByTransfer, renderMessages } from './messages.js';
import { closeModal } from './modals.js';
import { selectPeer } from './peers.js';
import { renderTransfers } from './transfers.js';

function openOfferModal(offer) {
  if (!offer || offer.accepted) return;
  if (state.modal) {
    if (state.modal.type === 'offer' && state.modal.id === offer.id) return;
    toast('请先处理当前弹窗，文件请求已保留在聊天中', 'info');
    return;
  }

  const preview = offer.files || [];
  const topFolder = offer.rootName || String(preview[0]?.relPath || preview[0]?.name || '文件').split('/')[0];
  const isFolder = !!offer.isFolder;
  const display = displayFor(offer.peerKey, offer.peerName);
  const headline = isFolder
    ? `想发送文件夹「${topFolder}」 · ${offer.totalFiles} 个文件`
    : `想发送 ${offer.totalFiles} 个文件${offer.totalDirs ? `、${offer.totalDirs} 个空文件夹` : ''}`;
  const previewItems = preview.slice(0, 8);
  const remaining = Math.max(0, offer.totalEntries - previewItems.length);
  const rows = previewItems.length
    ? previewItems.map((file) => {
        const info = fileInfo(file.name, !!file.dir);
        return `
          <div class="offer-file">
            <span class="file-icon ${info.cls}">${info.svg ? icon('folder', 16) : escapeHtml(info.label)}</span>
            <span class="offer-file-name">${escapeHtml(file.relPath || file.name)}</span>
            <span class="offer-file-size">${file.dir ? '文件夹' : formatBytes(file.size)}</span>
          </div>`;
      }).join('')
    : '<div class="offer-more">接收后将获取完整文件清单…</div>';

  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal" role="dialog" aria-modal="true" aria-label="接收文件">
        <div class="modal-head">
          <div>
            <h3>收到文件</h3>
            <p>${escapeHtml(display.label)} ${escapeHtml(headline)}${!display.verified ? `（未认证 · 指纹 ${escapeHtml(display.fingerprint)}）` : ''}</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="offer-from">
          <span class="avatar ${display.unnamed ? 'unnamed-avatar' : ''}" style="${display.unnamed ? '' : avatarStyle(display.label)}">${escapeHtml(display.unnamed ? '?' : initials(display.label))}</span>
          <div>
            <div class="offer-from-name">${escapeHtml(display.label)}${!display.verified ? ' · 未认证' : ''}</div>
            <div class="offer-from-sub">${!display.verified ? `指纹 ${escapeHtml(display.fingerprint)} · ` : ''}${escapeHtml(offer.peer?.host || '')} · ${escapeHtml(offer.peer?.ip || '')} · ${formatBytes(offer.totalBytes)}</div>
          </div>
        </div>
        ${!display.verified ? '<div class="alias-warning">该设备身份尚未认证。文件会自动加密传输，但无法确认来源身份，请谨慎接收。</div>' : ''}
        <div class="offer-files">${rows}</div>
        ${remaining > 0 ? `<div class="offer-more">还有 ${remaining} 项，接收后自动获取完整清单…</div>` : ''}
        <div class="offer-save">
          <span class="label">保存到</span>
          <span class="path" id="offerSavePath">${escapeHtml(state.settings.downloadDir)}</span>
          <button class="link-btn" id="offerChangeDir">更改</button>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" id="offerDecline">拒绝</button>
          <button class="btn primary" id="offerAccept">${icon('download', 15)} 接收</button>
        </div>
      </div>
    </div>`;

  state.modal = { type: 'offer', id: offer.id };
  let saveDir = state.settings.downloadDir;

  dom.modalRoot.querySelector('#offerChangeDir').addEventListener('click', async () => {
    try {
      const chosen = await window.feige.chooseDir(saveDir);
      if (chosen) {
        saveDir = chosen;
        dom.modalRoot.querySelector('#offerSavePath').textContent = chosen;
      }
    } catch (error) {
      toast(error.message || '无法选择目录', 'error');
    }
  });

  dom.modalRoot.querySelector('#offerDecline').addEventListener('click', async () => {
    try {
      await window.feige.declineOffer(offer.id);
      state.offers.delete(offer.id);
      markOfferMessage(offer.id, { declined: true });
      closeModal();
      renderMessages(false);
      renderTransfers();
    } catch (error) {
      toast(error.message || '拒绝失败', 'error');
    }
  });

  dom.modalRoot.querySelector('#offerAccept').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '准备中…';
    try {
      const snapshot = await window.feige.acceptOffer(offer.id, saveDir);
      offer.accepted = true;
      if (snapshot) state.transfers.set(snapshot.id, snapshot);
      closeModal();
      selectPeer(offer.peerKey);
      refreshMessagesByTransfer(offer.id);
      renderTransfers();
    } catch (error) {
      button.disabled = false;
      button.innerHTML = `${icon('download', 15)} 接收`;
      toast(error.message || '接收失败', 'error');
    }
  });
}

export { openOfferModal };
