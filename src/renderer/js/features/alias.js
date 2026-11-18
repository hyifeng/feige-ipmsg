import { t } from '../i18n/index.js';
import { escapeHtml } from '../core/format.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { displayFor } from '../core/contacts.js';
import { dom, state } from '../core/state.js';
import { closeModal } from './modals.js';
import { activePeer, renderChatHead, renderPeers } from './peers.js';

function applyDescriptor(peerKey, descriptor) {
  if (descriptor && descriptor.alias) state.contacts.set(peerKey, descriptor);
  else state.contacts.delete(peerKey);
}

function openAliasModal(peer) {
  if (!window.feige || !peer) return;
  const display = displayFor(peer.key, peer.user);
  if (!display.verified) {
    toast(t('alias.error.notVerified'), 'warn');
    return;
  }
  const claimed = display.claimed || peer.user || '';
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal alias-modal" role="dialog" aria-modal="true" aria-label="${t('alias.title.nameDevice')}">
        <div class="modal-head">
          <div>
            <h3>${t(display.alias ? 'alias.title.edit' : 'alias.action.set')}</h3>
            <p>${t('alias.hint.localOnly')}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>

        <div class="alias-body">
          <div class="alias-fingerprint-row">
            <span class="alias-fingerprint-label">${t('alias.label.fingerprint')}</span>
            <code class="alias-fingerprint">${escapeHtml(display.fingerprint)}</code>
          </div>
          <div class="alias-verify-hint">${t('alias.hint.verified')}</div>
          ${claimed ? `<div class="alias-claimed">${t('alias.claimedLabel')}<b>${escapeHtml(claimed)}</b></div>` : ''}

          <label class="field">
            <span>${t('alias.label.localAlias')}</span>
            <input class="input" id="aliasInput" maxlength="32" value="${escapeHtml(display.alias || claimed)}" placeholder="${t('alias.placeholder.example')}" />
            <small>${t('alias.hint.leaveBlank')}</small>
          </label>
        </div>

        <div class="modal-actions">
          <button class="btn ghost alias-clear" id="aliasClear" ${display.alias ? '' : 'disabled'}>${t('alias.action.clear')}</button>
          <span class="alias-hint">${t('alias.hint.saveScope')}</span>
          <button class="btn ghost" data-close-modal>${t('common.cancel')}</button>
          <button class="btn primary" id="aliasSave">${t('common.save')}</button>
        </div>
      </div>
    </div>`;

  state.modal = { type: 'alias', id: peer.key };

  const input = dom.modalRoot.querySelector('#aliasInput');
  const saveBtn = dom.modalRoot.querySelector('#aliasSave');
  const clearBtn = dom.modalRoot.querySelector('#aliasClear');

  const save = async (value) => {
    const alias = String(value || '').trim();
    if (alias) {
      const duplicate = [...state.contacts.entries()]
        .find(([key, contact]) => key !== peer.key && contact.alias === alias);
      if (duplicate) {
        toast(t('alias.error.duplicate', { alias, fingerprint: duplicate[1].fingerprint || t('common.unknownFingerprint') }), 'warn');
      }
    }
    saveBtn.disabled = true;
    clearBtn.disabled = true;
    try {
      let descriptor;
      if (state.demo) {
        descriptor = {
          peerKey: peer.key,
          identity: peer.key.replace(/^id:/, ''),
          alias,
          verified: true,
          unnamed: false,
          label: alias || display.claimed || t('common.verifiedDevice'),
          fingerprint: display.fingerprint,
          claimed: display.claimed,
        };
      } else {
        descriptor = await window.feige.setAlias(peer.key, alias, peer.user);
      }
      applyDescriptor(peer.key, descriptor);
      closeModal(false);
      renderPeers();
      renderChatHead(activePeer() || peer);
      toast(alias ? t('alias.toast.saved', { alias }) : t('alias.toast.cleared'), 'success');
    } catch (error) {
      saveBtn.disabled = false;
      clearBtn.disabled = false;
      toast(error.message || t('alias.error.saveFailed'), 'error');
    }
  };

  saveBtn.addEventListener('click', () => save(input.value));
  clearBtn.addEventListener('click', () => save(''));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      save(input.value);
    }
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
}

export { openAliasModal };
