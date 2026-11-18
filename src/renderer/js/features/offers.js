import { t } from '../i18n/index.js';
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
    toast(t('offer.busy'), 'info');
    return;
  }

  const preview = offer.files || [];
  const topFolder = offer.rootName || String(preview[0]?.relPath || preview[0]?.name || t('common.file')).split('/')[0];
  const isFolder = !!offer.isFolder;
  const display = displayFor(offer.peerKey, offer.peerName);
  const headline = isFolder
    ? t('offer.headlineFolder', { folder: topFolder, count: offer.totalFiles })
    : t('offer.headlineFiles', {
      count: offer.totalFiles,
      extra: offer.totalDirs ? t('offer.emptyFoldersSuffix', { count: offer.totalDirs }) : '',
    });
  const previewItems = preview.slice(0, 8);
  const remaining = Math.max(0, offer.totalEntries - previewItems.length);
  const rows = previewItems.length
    ? previewItems.map((file) => {
        const info = fileInfo(file.name, !!file.dir);
        return `
          <div class="offer-file">
            <span class="file-icon ${info.cls}">${info.svg ? icon('folder', 16) : escapeHtml(info.label)}</span>
            <span class="offer-file-name">${escapeHtml(file.relPath || file.name)}</span>
            <span class="offer-file-size">${file.dir ? t('common.folder') : formatBytes(file.size)}</span>
          </div>`;
      }).join('')
    : `<div class="offer-more">${t('offer.previewNote')}</div>`;

  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal" role="dialog" aria-modal="true" aria-label="${t('offer.title')}">
        <div class="modal-head">
          <div>
            <h3>${t('offer.heading')}</h3>
            <p>${escapeHtml(display.label)} ${escapeHtml(headline)}${!display.verified ? ` ${t('offer.unverifiedFingerprint', { fingerprint: escapeHtml(display.fingerprint) })}` : ''}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>
        <div class="offer-from">
          <span class="avatar ${display.unnamed ? 'unnamed-avatar' : ''}" style="${display.unnamed ? '' : avatarStyle(display.label)}">${escapeHtml(display.unnamed ? '?' : initials(display.label))}</span>
          <div>
            <div class="offer-from-name">${escapeHtml(display.label)}${!display.verified ? ` ${t('offer.unverifiedSuffix')}` : ''}</div>
            <div class="offer-from-sub">${!display.verified ? `${t('offer.fingerprint', { fingerprint: escapeHtml(display.fingerprint) })} · ` : ''}${escapeHtml(offer.peer?.host || '')} · ${escapeHtml(offer.peer?.ip || '')} · ${formatBytes(offer.totalBytes)}</div>
          </div>
        </div>
        ${!display.verified ? `<div class="alias-warning">${t('offer.unverifiedWarning')}</div>` : ''}
        <div class="offer-files">${rows}</div>
        ${remaining > 0 ? `<div class="offer-more">${t('offer.remainingNote', { count: remaining })}</div>` : ''}
        <div class="offer-save">
          <span class="label">${t('offer.saveTo')}</span>
          <span class="path" id="offerSavePath">${escapeHtml(state.settings.downloadDir)}</span>
          <button class="link-btn" id="offerChangeDir">${t('common.change')}</button>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" id="offerDecline">${t('common.decline')}</button>
          <button class="btn primary" id="offerAccept">${icon('download', 15)} ${t('common.receive')}</button>
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
      toast(error.message || t('common.selectFolderFailed'), 'error');
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
      toast(error.message || t('offer.declineFailed'), 'error');
    }
  });

  dom.modalRoot.querySelector('#offerAccept').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = t('offer.preparing');
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
      button.innerHTML = `${icon('download', 15)} ${t('common.receive')}`;
      toast(error.message || t('transfer.receiveFailed'), 'error');
    }
  });
}

export { openOfferModal };
