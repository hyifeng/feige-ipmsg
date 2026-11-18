import { getLocale, setLocale, t } from '../i18n/index.js';
import { escapeHtml } from '../core/format.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { closeModal } from './modals.js';
import { openChangePasswordModal } from './change-password.js';

async function openSettings() {
  if (!window.feige) return;
  let security = {
    autoUnlockAvailable: false,
    autoUnlockEnabled: false,
    autoUnlockMessage: '',
  };
  try {
    security = { ...security, ...(await window.feige.localPassSecurity()) };
  } catch {
    /* 旧版本或不支持时保持关闭状态 */
  }
  const settings = state.settings;
  const autoUnlockHint = security.autoUnlockAvailable
    ? t('settings.rememberTheLocalDataKeyInThe')
    : (security.autoUnlockMessage || t('password.autoUnlock.unavailable'));
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal" role="dialog" aria-modal="true" aria-label="${t('settings.title')}">
        <div class="modal-head">
          <div>
            <h3>${t('settings.title')}</h3>
            <p>${t('settings.description')}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span>${t('settings.nickname')}</span>
            <input class="input" id="setNickname" maxlength="32" value="${escapeHtml(settings.nickname)}" />
          </label>
          <div class="switch-row">
            <div class="hub-copy">
              <b>${t('settings.hub.enabled')}</b>
              <small>${t('settings.hub.enabledHint')}</small>
              <span class="hub-inline" id="hubInline" ${settings.hubEnabled ? '' : 'hidden'}>
                <small class="hub-detail" id="hubDetail"></small>
                <button class="hub-edit" type="button" data-hub-action="edit">${t('common.change')}</button>
              </span>
            </div>
            <span class="switch"><input type="checkbox" id="setHubEnabled" ${settings.hubEnabled ? 'checked' : ''} /><i></i></span>
          </div>
          <label class="switch-row">
            <div>
              <b>${t('settings.autoUnlock.label')}</b>
              <small>${escapeHtml(autoUnlockHint)}</small>
            </div>
            <span class="switch"><input type="checkbox" id="setAutoUnlock" ${security.autoUnlockEnabled ? 'checked' : ''} ${security.autoUnlockAvailable || security.autoUnlockEnabled ? '' : 'disabled'} /><i></i></span>
          </label>
          <div class="field">
            <span>${t('password.localPassword')}</span>
            <div class="dir-row">
              <button class="mini-action" id="changePassBtn" type="button">${t('password.title.change')}</button>
            </div>
            <small>${t('settings.passwordNote')}</small>
          </div>
          <div class="field">
            <span>${t('settings.downloadDir')}</span>
            <div class="dir-row">
              <input class="input" id="setDownloadDir" readonly value="${escapeHtml(settings.downloadDir)}" />
              <button class="mini-action" id="browseDir">${t('common.change')}</button>
            </div>
          </div>
          <label class="switch-row">
            <div>
              <b>${t('settings.autoAccept')}</b>
              <small>${t('settings.autoAcceptHint')}</small>
            </div>
            <span class="switch"><input type="checkbox" id="setAutoAccept" ${settings.autoAccept ? 'checked' : ''} /><i></i></span>
          </label>
          <label class="switch-row">
            <div>
              <b>${t('settings.sound')}</b>
              <small>${t('settings.soundHint')}</small>
            </div>
            <span class="switch"><input type="checkbox" id="setSound" ${settings.sound !== false ? 'checked' : ''} /><i></i></span>
          </label>
          <div class="language-row">
            <div class="language-copy">
              <b>${icon('globe', 13)}<span>${t('settings.language')}</span></b>
              <small>${t('settings.languageHint')}</small>
            </div>
            <div class="language-switch" role="group" aria-label="${t('settings.language')}">
              <button class="language-switch-option ${getLocale() === 'zh-CN' ? 'is-active' : ''}" type="button" data-language="zh-CN" aria-pressed="${getLocale() === 'zh-CN'}">中文</button>
              <button class="language-switch-option ${getLocale() === 'en' ? 'is-active' : ''}" type="button" data-language="en" aria-pressed="${getLocale() === 'en'}">English</button>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <span class="settings-about">${t('settings.about', { version: escapeHtml(state.version), fingerprint: escapeHtml(state.self.fingerprint || '—') })}</span>
          <button class="btn ghost" data-close-modal>${t('common.cancel')}</button>
          <button class="btn primary" id="saveSettings">${t('settings.save')}</button>
        </div>
      </div>
    </div>`;

  state.modal = { type: 'settings' };

  const nicknameInput = dom.modalRoot.querySelector('#setNickname');
  const dirInput = dom.modalRoot.querySelector('#setDownloadDir');
  const autoInput = dom.modalRoot.querySelector('#setAutoAccept');
  const soundInput = dom.modalRoot.querySelector('#setSound');
  const autoUnlockInput = dom.modalRoot.querySelector('#setAutoUnlock');
  const hubEnabledInput = dom.modalRoot.querySelector('#setHubEnabled');
  const languageButtons = [...dom.modalRoot.querySelectorAll('[data-language]')];

  for (const button of languageButtons) {
    button.addEventListener('click', async () => {
      const requested = button.dataset.language;
      if (requested === getLocale()) return;
      const previous = getLocale();
      for (const option of languageButtons) option.disabled = true;
      try {
        const saved = await window.feige.setLanguage(requested);
        setLocale(saved);
        openSettings();
      } catch (error) {
        setLocale(previous);
        for (const option of languageButtons) option.disabled = false;
        toast(error.message || t('settings.languageUpdateFailed'), 'error');
      }
    });
  }

  dom.modalRoot.querySelector('#browseDir').addEventListener('click', async () => {
    try {
      const chosen = await window.feige.chooseDir(dirInput.value);
      if (chosen) dirInput.value = chosen;
    } catch (error) {
      toast(error.message || t('common.selectFolderFailed'), 'error');
    }
  });

  autoUnlockInput?.addEventListener('change', async () => {
    const enabled = autoUnlockInput.checked;
    autoUnlockInput.disabled = true;
    try {
      const result = await window.feige.setAutoUnlock(enabled);
      if (!result || !result.ok) {
        autoUnlockInput.checked = !enabled;
        toast((result && result.message) || t('settings.autoUnlockUpdateFailed'), 'error');
      } else {
        toast(t(enabled ? 'settings.autoUnlockEnabled' : 'settings.autoUnlockDisabled'), 'success');
      }
    } catch (error) {
      autoUnlockInput.checked = !enabled;
      toast(error.message || t('settings.autoUnlockUpdateFailed'), 'error');
    } finally {
      autoUnlockInput.disabled = !security.autoUnlockAvailable && !autoUnlockInput.checked;
    }
  });

  dom.modalRoot.querySelector('#changePassBtn')?.addEventListener('click', () => {
    openChangePasswordModal(() => {
      openSettings();
    });
  });

  dom.modalRoot.querySelector('#saveSettings').addEventListener('click', async (event) => {
    const nickname = nicknameInput.value.trim();
    if (!nickname) {
      toast(t('settings.nicknameRequired'), 'warn');
      nicknameInput.focus();
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = t('settings.saving');
    const patch = {
      nickname,
      downloadDir: dirInput.value,
      autoAccept: autoInput.checked,
      sound: soundInput.checked,
    };
    try {
      await window.feige.updateSettings(patch);
      state.settings = { ...state.settings, ...patch };
      closeModal(false);
      toast(t('settings.saved'), 'success');
    } catch (error) {
      button.disabled = false;
      button.textContent = t('settings.save');
      toast(error.message || t('settings.saveFailed'), 'error');
    }
  });

  dom.modalRoot.querySelector('[data-hub-action="edit"]')?.addEventListener('click', () => openHubEditor());
  hubEnabledInput?.addEventListener('change', () => {
    toggleHub(hubEnabledInput.checked);
  });
  updateHubRow();

  setTimeout(() => nicknameInput.focus(), 60);
}


function cleanHubUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? text : '';
  } catch {
    return '';
  }
}

function cleanStunUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return new URL(text).protocol === 'stun:' ? text : '';
  } catch {
    return '';
  }
}

function updateHubRow() {
  const detailEl = dom.modalRoot.querySelector('#hubDetail');
  const inlineEl = dom.modalRoot.querySelector('#hubInline');
  const toggle = dom.modalRoot.querySelector('#setHubEnabled');
  if (!detailEl || !inlineEl) return;
  const enabled = !!state.settings.hubEnabled;
  const url = state.settings.hubUrl || '';
  const stun = state.settings.hubStunUrl || '';
  if (toggle) toggle.checked = enabled;
  inlineEl.hidden = !enabled;
  detailEl.textContent = url
    ? `${url}${stun ? ` · ${stun}` : ''}`
    : t('settings.hub.notConfigured');
  detailEl.title = detailEl.textContent;
}

function setHubRowBusy(busy) {
  const toggle = dom.modalRoot.querySelector('#setHubEnabled');
  const edit = dom.modalRoot.querySelector('[data-hub-action="edit"]');
  if (busy) {
    if (toggle) toggle.disabled = true;
    if (edit) edit.disabled = true;
    return;
  }
  if (toggle) toggle.disabled = false;
  if (edit) edit.disabled = false;
  updateHubRow();
}

async function applyHubPatch(patch, message) {
  setHubRowBusy(true);
  try {
    const settings = await window.feige.updateSettings(patch);
    state.settings = { ...state.settings, ...(settings || patch) };
    toast(message, 'success');
  } catch (error) {
    toast(error.message || t('settings.hub.updateFailed'), 'error');
  } finally {
    setHubRowBusy(false);
  }
}

async function toggleHub(enabled) {
  if (enabled && !state.settings.hubUrl) {
    updateHubRow();
    openHubEditor({ startAfterSave: true });
    return;
  }
  await applyHubPatch(
    { hubEnabled: !!enabled },
    t(enabled ? 'settings.hub.started' : 'settings.hub.stopped'),
  );
}

function closeHubEditor() {
  const overlay = dom.modalRoot.querySelector('[data-hub-backdrop]');
  if (overlay) overlay.remove();
  if (closeHubEditor.keyHandler) {
    document.removeEventListener('keydown', closeHubEditor.keyHandler, true);
    closeHubEditor.keyHandler = null;
  }
}

function openHubEditor(options = {}) {
  closeHubEditor();
  const startAfterSave = !!options.startAfterSave;
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop modal-backdrop-secondary';
  overlay.dataset.hubBackdrop = '';
  overlay.innerHTML = `
    <div class="modal modal-secondary" role="dialog" aria-modal="true" aria-label="${t('settings.hub.title')}">
      <div class="modal-head">
        <div>
          <h3>${t('settings.hub.title')}</h3>
          <p>${t('settings.hub.description')}</p>
        </div>
        <button class="modal-close" type="button" data-hub-cancel title="${t('common.close')}">${icon('x', 17)}</button>
      </div>
      <div class="settings-grid">
        <label class="field">
          <span>${t('settings.hub.urlLabel')}</span>
          <input class="input" id="hubModalUrl" maxlength="512" placeholder="wss://hub.example.com:8787" value="${escapeHtml(state.settings.hubUrl || '')}" />
          <small>${t('settings.hub.urlHint')}</small>
        </label>
        <label class="field">
          <span>${t('settings.hub.stunLabel')}</span>
          <input class="input" id="hubModalStun" maxlength="512" placeholder="${t('settings.hub.stunPlaceholder')}" value="${escapeHtml(state.settings.hubStunUrl || '')}" />
          <small>${t('settings.hub.stunHint')}</small>
        </label>
        <div class="form-error" id="hubModalError"></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" data-hub-cancel>${t('common.cancel')}</button>
        <button class="btn primary" type="button" id="hubModalSave">${t(startAfterSave ? 'settings.hub.saveAndStart' : 'common.save')}</button>
      </div>
    </div>`;
  dom.modalRoot.appendChild(overlay);

  const urlInput = overlay.querySelector('#hubModalUrl');
  const stunInput = overlay.querySelector('#hubModalStun');
  const errorEl = overlay.querySelector('#hubModalError');
  const saveButton = overlay.querySelector('#hubModalSave');

  const close = () => closeHubEditor();
  overlay.querySelectorAll('[data-hub-cancel]').forEach((button) => {
    button.addEventListener('click', close);
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  closeHubEditor.keyHandler = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', closeHubEditor.keyHandler, true);

  saveButton.addEventListener('click', async () => {
    const hubUrl = cleanHubUrl(urlInput.value);
    const hubStunUrl = cleanStunUrl(stunInput.value);
    if (urlInput.value.trim() && !hubUrl) {
      errorEl.textContent = t('settings.hub.urlInvalid');
      urlInput.focus();
      return;
    }
    if (stunInput.value.trim() && !hubStunUrl) {
      errorEl.textContent = t('settings.hub.stunInvalid');
      stunInput.focus();
      return;
    }
    if (!hubUrl) {
      errorEl.textContent = t('settings.hub.urlRequired');
      urlInput.focus();
      return;
    }
    errorEl.textContent = '';
    const patch = { hubUrl, hubStunUrl };
    if (startAfterSave) patch.hubEnabled = true;
    saveButton.disabled = true;
    saveButton.textContent = t('settings.saving');
    try {
      const settings = await window.feige.updateSettings(patch);
      state.settings = { ...state.settings, ...(settings || patch) };
      close();
      updateHubRow();
      toast(t(startAfterSave ? 'settings.hub.started' : 'settings.hub.saved'), 'success');
    } catch (error) {
      errorEl.textContent = error.message || t('settings.saveFailed');
      saveButton.disabled = false;
      saveButton.textContent = t(startAfterSave ? 'settings.hub.saveAndStart' : 'common.save');
    }
  });

  setTimeout(() => urlInput.focus(), 60);
}

export { openSettings };
