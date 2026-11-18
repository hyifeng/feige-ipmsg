import { t } from '../i18n/index.js';
import { escapeHtml } from '../core/format.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { closeModal } from './modals.js';
import { displayFor } from '../core/contacts.js';
import { activePeer, peerByKey, renderChatHead, renderPeers } from './peers.js';

function formatSecureCode(code) {
  const text = String(code || '').padStart(6, '0');
  return `${text.slice(0, 3)} ${text.slice(3)}`;
}

function renderSecure(peer) {
  if (!peer || !dom.secureBtn) return;
  const active = state.securePeers.get(peer.key);
  const pending = state.securePending.get(peer.key);
  const paired = state.securePairings.has(peer.key);
  const authenticated = paired || !!(active && active.authenticated);
  const waiting = state.secureWaiting.has(peer.key);
  const warning = state.secureWarnings.get(peer.key);
  const paused = state.securePaused.get(peer.key);
  const pausedOffline = !!paused && (!peer.online || !state.self.online || paused.kind === 'offline');
  const canAct = peer.online && state.self.ready && state.self.online;

  let label = t('secure.action.verify');
  let iconName = 'shield';
  let title = t('secure.action.verifyTitleHint');
  if (active && authenticated) {
    label = t('common.status.verified');
    title = t(active.mode === 'resume' ? 'secure.status.verifiedPairingOk' : 'secure.status.verifiedByCode');
  } else if (pending) {
    if (pending.incoming) {
      label = t('secure.status.request');
      title = t('secure.status.incomingPending');
    } else {
      label = t(pending.mode === 'resume' ? 'secure.pending.restoring' : 'secure.status.verifyingShort');
      title = t(pending.mode === 'resume' ? 'secure.status.restoringIdentity' : 'secure.status.comparingCode');
    }
  } else if (active) {
    label = t('secure.action.verify');
    title = t('secure.status.peerUnverifiedHint');
  } else if (waiting) {
    label = t('secure.status.waitingReverify');
    title = t('secure.status.localRevokedWaiting');
  } else if (warning) {
    label = warning.canReset === false ? t('common.status.verificationIssue') : (warning.actionLabel || t('secure.action.reverify'));
    iconName = 'alert';
    title = warning.title || t('secure.warning.issueTitle');
  } else if (paused) {
    label = t(paired ? 'common.status.verified' : 'secure.action.verify');
    title = t(pausedOffline ? 'secure.status.verifiedPeerOffline' : 'secure.status.verifiedInterrupted');
  } else if (paired) {
    const online = peer.online && state.self.online;
    label = t('common.status.verified');
    title = t(online ? 'secure.status.verifiedResumeOnSend' : 'secure.status.verifiedPeerOffline');
  }

  dom.secureBtn.innerHTML = `${icon(iconName, 17)}<span>${label}</span>`;
  dom.secureBtn.title = waiting ? title : (canAct || active ? title : t('secure.peerIsOffline'));
  dom.secureBtn.disabled = waiting || !state.self.online || (!canAct && !active);
  dom.secureBtn.classList.toggle('active', authenticated && !warning);
  dom.secureBtn.classList.toggle('pending', !authenticated && !warning && (!!pending || !!active));
  dom.secureBtn.classList.toggle('paired', authenticated && !active && !warning);
  dom.chat.classList.toggle('secure-active', authenticated && !warning);

  if (active && authenticated) {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'paused', 'unverified');
    dom.secureBannerIcon.innerHTML = icon('shield', 18);
    dom.secureBannerTitle.textContent = t('common.status.identityVerified');
    dom.secureBannerText.textContent = t(active.mode === 'resume'
      ? 'secure.banner.verified.resumeDetail'
      : 'secure.banner.verified.detail');
    dom.secureBannerBtn.classList.remove('is-hidden');
    dom.secureBannerBtn.textContent = t('common.details');
    dom.secureBanner.dataset.action = 'info';
  } else if (pending) {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'paused');
    dom.secureBanner.classList.add('unverified');
    dom.secureBannerIcon.innerHTML = icon('shield', 18);
    dom.secureBannerTitle.textContent = t(pending.incoming
      ? 'secure.banner.request.title'
      : (pending.mode === 'resume' ? 'secure.status.restoring' : 'secure.status.verifying'));
    dom.secureBannerText.textContent = t(pending.incoming
      ? 'secure.banner.request.hint'
      : (pending.mode === 'resume' ? 'secure.pending.checkingKey' : 'secure.pending.compareHint'));
    dom.secureBannerBtn.classList.add('is-hidden');
    dom.secureBanner.dataset.action = '';
  } else if (active) {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'paused');
    dom.secureBanner.classList.add('unverified');
    dom.secureBannerIcon.innerHTML = icon('alert', 18);
    dom.secureBannerTitle.textContent = t('common.status.identityUnverified');
    dom.secureBannerText.textContent = t('secure.banner.unverified.online');
    dom.secureBannerBtn.classList.remove('is-hidden');
    dom.secureBannerBtn.textContent = t('secure.action.verify');
    dom.secureBanner.dataset.action = 'info';
  } else if (waiting) {
    dom.secureBanner.classList.remove('is-hidden', 'paused', 'unverified');
    dom.secureBanner.classList.add('warning');
    dom.secureBannerIcon.innerHTML = icon('alert', 18);
    dom.secureBannerTitle.textContent = t('secure.banner.localRevoked.title');
    dom.secureBannerText.textContent = t('secure.banner.localRevoked.hint');
    dom.secureBannerBtn.classList.add('is-hidden');
    dom.secureBanner.dataset.action = '';
  } else if (warning) {
    dom.secureBanner.classList.remove('is-hidden', 'paused', 'unverified');
    dom.secureBanner.classList.add('warning');
    dom.secureBannerIcon.innerHTML = icon('alert', 18);
    dom.secureBannerTitle.textContent = warning.title || t('secure.warning.restoreFailedTitle');
    dom.secureBannerText.textContent = warning.text || '';
    dom.secureBannerBtn.classList.toggle('is-hidden', warning.canReset === false);
    dom.secureBannerBtn.textContent = warning.actionLabel || t('secure.action.reverify');
    dom.secureBanner.dataset.action = warning.canReset === false ? '' : 'retry';
  } else if (paused) {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'unverified');
    dom.secureBanner.classList.add('paused');
    dom.secureBannerIcon.innerHTML = icon('shield', 18);
    dom.secureBannerTitle.textContent = t(pausedOffline ? 'secure.banner.paused.titlePeerOffline' : 'secure.banner.paused.titleRestoring');
    dom.secureBannerText.textContent = t(pausedOffline
      ? (state.self.online
        ? 'secure.banner.paused.savedPeerOnline'
        : 'secure.banner.paused.selfOffline')
      : 'secure.banner.paused.restoringConnection');
    dom.secureBannerBtn.classList.add('is-hidden');
    dom.secureBanner.dataset.action = '';
  } else if (!paired) {
    dom.secureBanner.classList.remove('is-hidden', 'paused', 'warning');
    dom.secureBanner.classList.add('unverified');
    dom.secureBannerIcon.innerHTML = icon('alert', 18);
    dom.secureBannerTitle.textContent = t('common.status.identityUnverified');
    dom.secureBannerText.textContent = t(peer.online
      ? 'secure.banner.unverified.autoEncrypted'
      : 'secure.banner.unverifiedOffline');
    dom.secureBannerBtn.classList.toggle('is-hidden', !peer.online);
    dom.secureBannerBtn.textContent = t('secure.action.verify');
    dom.secureBanner.dataset.action = 'start';
  } else {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'unverified');
    dom.secureBanner.classList.add('paused');
    dom.secureBannerIcon.innerHTML = icon('shield', 18);
    dom.secureBannerTitle.textContent = t('common.status.identityVerified');
    dom.secureBannerText.textContent = t(peer.online
      ? 'secure.banner.paused.savedSend'
      : 'secure.banner.paused.offlineResume');
    dom.secureBannerBtn.classList.toggle('is-hidden', !peer.online);
    dom.secureBannerBtn.textContent = t('secure.action.resume');
    dom.secureBanner.dataset.action = 'start';
  }
}

async function startSecure(peerKey) {
  if (!state.self.online) {
    toast(t('secure.offline'), 'warn');
    return;
  }
  const peer = peerByKey(peerKey);
  if (!peer || !peer.online) {
    toast(t('common.selectOnlinePeer'), 'warn');
    return;
  }
  if (!state.self.ready) {
    toast(t('common.networkNotReady'), 'warn');
    return;
  }
  if (state.securePeers.has(peerKey)) {
    showSecureInfo(peerKey);
    return;
  }
  if (state.securePending.has(peerKey)) return;
  try {
    const result = await window.feige.secureStart(peerKey);
    if (!result) return;
    if (result.status === 'active') {
      toast(t(result.temporary ? 'secure.toast.sessionEstablished' : 'secure.toast.verifyEnabled'), 'success');
      return;
    }
    state.securePending.set(peerKey, {
      ...result,
      peerKey,
      peerName: peer.user,
    });
    state.secureWarnings.delete(peerKey);
    renderPeers();
    if (state.active === peerKey) renderChatHead(peer);
    toast(t(result.mode === 'resume' ? 'secure.pending.restoringLast' : 'secure.toast.verifying'), 'info');
  } catch (error) {
    toast(error.message || t('secure.toast.startFailed'), 'error');
  }
}

async function restartSecure(peerKey) {
  if (!state.self.online) {
    toast(t('secure.offline'), 'warn');
    return;
  }
  const peer = peerByKey(peerKey);
  if (!peer || !window.feige) return;
  try {
    await window.feige.secureReset(peerKey);
  } catch (error) {
    toast(error.message || t('secure.toast.resetFailed'), 'error');
    return;
  }
  state.securePairings.delete(peerKey);
  state.securePeers.delete(peerKey);
  state.securePending.delete(peerKey);
  state.secureWarnings.delete(peerKey);
  state.securePaused.delete(peerKey);
  state.secureWaiting.delete(peerKey);
  state.secureQueue = state.secureQueue.filter((item) => item.peerKey !== peerKey);
  renderPeers();
  if (state.active === peerKey) renderChatHead(peer);
  if (peer.online) await startSecure(peerKey);
}

async function cancelPendingSecure(peerKey) {
  const pending = state.securePending.get(peerKey);
  if (!pending) return;
  try {
    await window.feige.secureCancel(pending.sessionId);
  } catch {
    /* 会话可能已经结束 */
  }
  state.securePending.delete(peerKey);
  state.secureWarnings.delete(peerKey);
  const peer = activePeer();
  if (peer && peer.key === peerKey) renderChatHead(peer);
  renderPeers();
  toast(t('secure.status.canceled'), 'info');
}

function onSecureButton() {
  const peer = activePeer();
  if (!peer) return;
  const warning = state.secureWarnings.get(peer.key);
  if (state.secureWaiting.has(peer.key)) {
    toast(t('secure.status.localRevokedWaiting'), 'info');
    return;
  }
  if (warning) {
    onSecureWarningButton(peer.key);
    return;
  }
  if (state.securePeers.has(peer.key)) {
    showSecureInfo(peer.key);
    return;
  }
  if (state.securePending.has(peer.key)) {
    const pending = state.securePending.get(peer.key);
    if (pending.incoming) {
      openSecureModal(pending);
    } else {
      cancelPendingSecure(peer.key);
    }
    return;
  }
  startSecure(peer.key);
}

function showSecureInfo(peerKey) {
  const active = state.securePeers.get(peerKey);
  const peer = peerByKey(peerKey) || state.activePeer;
  if (!active || !peer) return;
  const authenticated = !!active.authenticated || state.securePairings.has(peerKey);
  state.modal = { type: 'secure-info' };
  const display = displayFor(peerKey, peer.user);
  const codeRow = active.code
    ? `<div class="secure-info-row"><span>${t('secure.info.securityCodeLabel')}</span><b class="secure-info-code">${escapeHtml(formatSecureCode(active.code))}</b></div>`
    : '';
  const authMethod = authenticated
    ? t(active.mode === 'resume' ? 'secure.info.authMethod.pairing' : 'secure.info.authMethod.code')
    : t('secure.info.authMethod.none');
  const pairingState = authenticated
    ? t('secure.info.pairingSaved')
    : t('secure.info.pairingNotSaved');
  const help = authenticated
    ? t('secure.info.verifiedHelp')
    : t('secure.info.unverifiedHelp');
  const verifyAction = authenticated
    ? ''
    : `<button class="btn primary" id="secureVerifyBtn">${icon('shield', 15)} ${t('secure.action.verify')}</button>`;
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal secure-modal" role="dialog" aria-modal="true" aria-label="${t('secure.info.title')}">
        <div class="modal-head">
          <div>
            <h3>${t(authenticated ? 'common.status.identityVerified' : 'common.status.identityUnverified')}</h3>
            <p>${t('secure.info.currentSessionWith', { name: escapeHtml(display.label) })}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>
        <div class="secure-info-list">
          <div class="secure-info-row"><span>${t('secure.info.statusLabel')}</span><b>${t(authenticated ? 'common.status.verified' : 'common.status.unverified')}</b></div>
          <div class="secure-info-row"><span>${t('secure.info.messageEncryptionLabel')}</span><b>${t('secure.info.encryption')}</b></div>
          <div class="secure-info-row"><span>${t('secure.info.keyExchangeLabel')}</span><b>${t('secure.info.keyExchange')}</b></div>
          <div class="secure-info-row"><span>${t('secure.info.authMethodLabel')}</span><b>${authMethod}</b></div>
          ${codeRow}
          <div class="secure-info-row"><span>${t('secure.info.pairingStorageLabel')}</span><b>${pairingState}</b></div>
        </div>
        <p class="secure-help">${help}</p>
        <div class="modal-actions">
          ${authenticated ? `<button class="btn danger" id="secureRevokeBtn">${t('secure.action.remove')}</button>` : verifyAction}
          <button class="btn ghost" data-close-modal>${t('common.close')}</button>
        </div>
      </div>
    </div>`;

  const revokeBtn = dom.modalRoot.querySelector('#secureRevokeBtn');
  revokeBtn?.addEventListener('click', () => {
    closeModal(false);
    openRevokeModal(peerKey);
  });
  const verifyBtn = dom.modalRoot.querySelector('#secureVerifyBtn');
  verifyBtn?.addEventListener('click', () => {
    closeModal(false);
    openSecureModal({
      ...active,
      peerKey,
      peerName: active.peerName || peer.user,
      sessionId: active.sessionId,
      mode: 'pair',
      temporary: false,
      active: true,
      incoming: false,
    });
  });
}

function onSecureWarningButton(peerKey) {
  const warning = state.secureWarnings.get(peerKey);
  if (!warning) return;
  if (warning.canReset === false) {
    toast(warning.text || t('secure.warning.askPeer'), 'warn');
    return;
  }
  openWarningActionModal(peerKey);
}

function openWarningActionModal(peerKey) {
  const warning = state.secureWarnings.get(peerKey);
  const peer = peerByKey(peerKey) || state.activePeer;
  if (!warning || !peer || !window.feige) return;
  const display = displayFor(peerKey, peer.user);
  const revoked = warning.kind === 'revoked';
  state.modal = { type: 'secure-warning', id: peerKey };
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal secure-modal" role="dialog" aria-modal="true" aria-label="${t('secure.warning.title')}">
        <div class="modal-head">
          <div>
            <h3>${revoked ? t('secure.warning.revokedTitle') : (warning.title || t('secure.warning.title'))}</h3>
            <p>${t('secure.info.localRecordWith', { name: escapeHtml(display.label) })}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>
        <div class="secure-info-list">
          <div class="secure-info-row"><span>${t('secure.warning.currentStatus')}</span><b>${t(revoked ? 'secure.status.peerRemovedLocal' : 'secure.warning.stateMismatch')}</b></div>
          <div class="secure-info-row"><span>${t('secure.warning.localRecord')}</span><b>${t(state.securePairings.has(peerKey) ? 'secure.warning.oldStillSaved' : 'secure.warning.noRecord')}</b></div>
        </div>
        <p class="secure-help">${escapeHtml(warning.text || '')}</p>
        <p class="secure-help">${t('secure.warning.resolveHelp')}</p>
        <div class="modal-actions">
          <button class="btn danger" id="warningLocalRevoke">${icon('unlock', 15)} ${t('secure.action.removeLocal')}</button>
          <button class="btn primary" id="warningReauth">${icon('shield', 15)} ${t('secure.action.reverify')}</button>
          <button class="btn ghost" data-close-modal>${t('common.cancel')}</button>
        </div>
      </div>
    </div>`;

  const localRevoke = dom.modalRoot.querySelector('#warningLocalRevoke');
  const reauth = dom.modalRoot.querySelector('#warningReauth');
  localRevoke.addEventListener('click', async () => {
    localRevoke.disabled = true;
    reauth.disabled = true;
    localRevoke.textContent = t('secure.action.removing');
    let removed = false;
    try {
      removed = await window.feige.secureReset(peerKey);
    } catch (error) {
      toast(error.message || t('secure.toast.removeLocalFailed'), 'error');
      localRevoke.disabled = false;
      reauth.disabled = false;
      localRevoke.innerHTML = `${icon('unlock', 15)} ${t('secure.action.removeLocal')}`;
      return;
    }
    state.securePairings.delete(peerKey);
    state.securePeers.delete(peerKey);
    state.securePending.delete(peerKey);
    state.secureWarnings.delete(peerKey);
    state.securePaused.delete(peerKey);
    state.secureWaiting.delete(peerKey);
    state.secureQueue = state.secureQueue.filter((item) => item.peerKey !== peerKey);
    closeModal();
    toast(t(removed ? 'secure.toast.localRemoved' : 'secure.toast.noLocalRecord'), removed ? 'info' : 'warn');
    renderPeers();
    const current = peerByKey(peerKey);
    if (current && state.active === peerKey) renderChatHead(current);
  });
  reauth.addEventListener('click', async () => {
    reauth.disabled = true;
    localRevoke.disabled = true;
    reauth.textContent = t('secure.action.reverifying');
    closeModal();
    await restartSecure(peerKey);
  });
}

function openRevokeModal(peerKey) {
  const peer = peerByKey(peerKey) || state.activePeer;
  if (!peer || !window.feige) return;
  const display = displayFor(peerKey, peer.user);
  state.modal = { type: 'revoke-secure' };
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal secure-modal" role="dialog" aria-modal="true" aria-label="${t('secure.action.remove')}">
        <div class="modal-head">
          <div>
            <h3>${t('secure.action.remove')}</h3>
            <p>${t('secure.info.localRecordWith', { name: escapeHtml(display.label) })}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>
        <div class="secure-info-list">
          <div class="secure-info-row"><span>${t('secure.revoke.actionLabel')}</span><b>${t('secure.revoke.onlyLocal')}</b></div>
          <div class="secure-info-row"><span>${t('common.peer')}</span><b>${t('secure.revoke.peerKeepsOld')}</b></div>
        </div>
        <p class="secure-help">${t('secure.revoke.help')}</p>
        <div class="secure-status warn">${t('secure.revoke.onlineWarning')}</div>
        <div class="modal-actions">
          <button class="btn ghost" data-close-modal>${t('common.cancel')}</button>
          <button class="btn danger" id="confirmRevokeBtn">${icon('unlock', 15)} ${t('secure.action.remove')}</button>
        </div>
      </div>
    </div>`;

  const confirm = dom.modalRoot.querySelector('#confirmRevokeBtn');
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    confirm.textContent = t('secure.action.removing');
    let removed = false;
    try {
      removed = await window.feige.secureRevoke(peerKey);
    } catch (error) {
      toast(error.message || t('secure.toast.removeFailed'), 'error');
      confirm.disabled = false;
      confirm.innerHTML = `${icon('unlock', 15)} ${t('secure.action.remove')}`;
      return;
    }
    if (!removed) {
      toast(t('secure.toast.noLocalRecord'), 'warn');
      closeModal();
      return;
    }

    state.secureWaiting.add(peerKey);
    state.securePairings.delete(peerKey);
    state.securePeers.delete(peerKey);
    state.securePending.delete(peerKey);
    state.secureWarnings.delete(peerKey);
    state.securePaused.delete(peerKey);
    state.secureQueue = state.secureQueue.filter((item) => item.peerKey !== peerKey);
    closeModal();
    toast(t('secure.toast.localRemovedWaiting'), 'info');
    renderPeers();
    const currentPeer = peerByKey(peerKey);
    if (currentPeer && state.active === peerKey) renderChatHead(currentPeer);
  });
}

function openSecureModal(info) {
  if (!info || !info.sessionId) return;
  state.securePending.set(info.peerKey, {
    ...info,
    mode: info.mode || 'pair',
  });
  if (state.modal) {
    if (!state.secureQueue.some((item) => item.sessionId === info.sessionId)) {
      state.secureQueue.push(info);
      toast(t('secure.toast.requestQueued'), 'info');
    }
    return;
  }
  const alreadyActive = !!info.active;
  state.modal = {
    type: 'secure',
    id: info.sessionId,
    peerKey: info.peerKey,
    peerName: info.peerName,
    code: info.code,
    mode: info.mode || 'pair',
    activeSession: alreadyActive,
    settled: false,
    localConfirmed: false,
    peerConfirmed: false,
  };
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal secure-modal" role="dialog" aria-modal="true" aria-label="${t('secure.action.verify')}">
        <div class="modal-head">
          <div>
            <h3>${t('secure.action.verify')}</h3>
            <p>${t('secure.modal.compareWith', { name: escapeHtml(info.peerName || t('common.peer')) })}${t('secure.modal.confirmIdentitySuffix')}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>
        <div class="secure-code">${escapeHtml(formatSecureCode(info.code))}</div>
        <p class="secure-help">${t(alreadyActive
          ? 'secure.modal.activeHelp'
          : 'secure.modal.idleHelp')}</p>
        <div class="secure-status" id="secureModalStatus">${t('secure.status.waitingLocalConfirm')}</div>
        <div class="modal-actions">
          <button class="btn ghost" id="secureModalCancel">${t('common.cancel')}</button>
          <button class="btn primary" id="secureModalConfirm">${icon('shield', 15)} ${t('secure.action.codesMatch')}</button>
        </div>
      </div>
    </div>`;

  const confirmBtn = dom.modalRoot.querySelector('#secureModalConfirm');
  const cancelBtn = dom.modalRoot.querySelector('#secureModalCancel');
  const setStatus = (text, warn = false) => {
    const element = dom.modalRoot.querySelector('#secureModalStatus');
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('warn', warn);
  };

  confirmBtn.addEventListener('click', async () => {
    if (!state.modal || state.modal.type !== 'secure') return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('secure.action.confirming');
    try {
      const ok = await window.feige.secureConfirm(info.sessionId);
      if (!ok) throw new Error(t('secure.error.sessionExpired'));
      state.modal.localConfirmed = true;
      confirmBtn.textContent = t('secure.status.waitingPeerConfirm');
      setStatus(t(state.modal.peerConfirmed ? 'secure.status.bothConfirmed' : 'secure.status.waitingPeerConfirm'));
    } catch (error) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `${icon('shield', 15)} ${t('secure.action.codesMatch')}`;
      setStatus(error.message || t('secure.action.confirmFailed'), true);
    }
  });

  cancelBtn.addEventListener('click', () => {
    closeModal();
  });
}

function maybeShowQueuedSecure() {
  if (state.modal || !state.secureQueue.length) return;
  const next = state.secureQueue.shift();
  if (next) openSecureModal(next);
}

export { formatSecureCode, renderSecure, startSecure, restartSecure, cancelPendingSecure, onSecureButton, onSecureWarningButton, showSecureInfo, openSecureModal, maybeShowQueuedSecure };
