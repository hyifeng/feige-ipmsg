import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { closeModal } from './modals.js';
import { MIN_PASSWORD_LENGTH } from './lock.js';

function openChangePasswordModal(onDone = () => {}) {
  if (!window.feige) return;
  state.modal = { type: 'change-pass', onDone };
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal change-password-modal" role="dialog" aria-modal="true" aria-label="${t('password.title.change')}">
        <div class="modal-head">
          <div>
            <h3>${t('password.title.change')}</h3>
            <p>${t('password.subtitle')}</p>
          </div>
          <button class="modal-close" data-close-modal title="${t('common.close')}">${icon('x', 17)}</button>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span>${t('password.label.current')}</span>
            <input class="input" id="oldLocalPass" type="password" autocomplete="current-password" spellcheck="false" placeholder="${t('password.placeholder.current')}" />
          </label>
          <label class="field">
            <span>${t('password.label.new')}</span>
            <input class="input" id="newLocalPass" type="password" autocomplete="new-password" spellcheck="false" placeholder="${t('password.placeholder.minLength', { count: MIN_PASSWORD_LENGTH })}" />
          </label>
          <label class="field">
            <span>${t('password.label.confirmNew')}</span>
            <input class="input" id="confirmLocalPass" type="password" autocomplete="new-password" spellcheck="false" placeholder="${t('password.placeholder.confirmNew')}" />
          </label>
          <div class="form-error" id="changePassError" role="alert" aria-live="assertive"></div>
          <p class="change-pass-note">${t('password.note.afterChange')}</p>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" id="changePassCancel">${t('common.cancel')}</button>
          <button class="btn primary" id="changePassSubmit">${icon('lock', 15)} ${t('password.action.change')}</button>
        </div>
      </div>
    </div>`;

  const oldInput = dom.modalRoot.querySelector('#oldLocalPass');
  const newInput = dom.modalRoot.querySelector('#newLocalPass');
  const confirmInput = dom.modalRoot.querySelector('#confirmLocalPass');
  const error = dom.modalRoot.querySelector('#changePassError');
  const submit = dom.modalRoot.querySelector('#changePassSubmit');
  const cancel = dom.modalRoot.querySelector('#changePassCancel');

  const setError = (message) => {
    if (error) error.textContent = message || '';
  };
  for (const input of [oldInput, newInput, confirmInput]) {
    input.addEventListener('input', () => setError(''));
  }

  cancel.addEventListener('click', () => closeModal());

  const submitChange = async () => {
    const oldPass = oldInput.value;
    const newPass = newInput.value;
    if (!oldPass) {
      setError(t('password.error.currentRequired'));
      oldInput.focus();
      return;
    }
    if ([...newPass].length < MIN_PASSWORD_LENGTH) {
      setError(t('password.error.tooShort', { count: MIN_PASSWORD_LENGTH }));
      newInput.focus();
      return;
    }
    if (newPass !== confirmInput.value) {
      setError(t('password.error.mismatch'));
      confirmInput.focus();
      return;
    }

    setError('');
    submit.disabled = true;
    submit.textContent = t('password.action.changing');
    try {
      const result = await window.feige.changeLocalPass({ oldPass, newPass });
      if (!result || !result.ok) {
        submit.disabled = false;
        submit.innerHTML = `${icon('lock', 15)} ${t('password.action.change')}`;
        setError((result && result.message) || t('password.error.changeFailed'));
        if (result && result.code === 'wrong-password') oldInput.select();
        return;
      }
      closeModal();
      toast(t('password.toast.changed'), 'success');
    } catch (err) {
      submit.disabled = false;
      submit.innerHTML = `${icon('lock', 15)} ${t('password.action.change')}`;
      setError(t('common.mainProcessUnavailable'));
      console.error('[feige] 修改本地密码失败', err);
    }
  };

  submit.addEventListener('click', submitChange);
  confirmInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      submitChange();
    }
  });

  setTimeout(() => oldInput.focus(), 50);
}

export { openChangePasswordModal };
