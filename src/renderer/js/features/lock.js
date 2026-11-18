import { t } from '../i18n/index.js';
import { escapeHtml } from '../core/format.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/notifications.js';

const MIN_PASSWORD_LENGTH = 6;

function lockEmblem(name) {
  return `<div class="lock-emblem" aria-hidden="true">${icon(name, 30)}</div>`;
}

function passwordField({ id, label, placeholder, autocomplete }) {
  return `
    <label class="lock-field">
      <span>${label}</span>
      <span class="lock-input-wrap">
        <input id="${id}" type="password" placeholder="${placeholder}" autocomplete="${autocomplete}" spellcheck="false" />
        <button type="button" class="lock-toggle" data-lock-toggle="${id}" aria-label="${t('lock.password.show')}" title="${t('lock.password.show')}">${icon('eye', 18)}</button>
      </span>
    </label>`;
}

function hideLockScreen() {
  const root = document.getElementById('lockScreen');
  if (root) {
    root.classList.add('is-hidden');
    root.innerHTML = '';
  }
  document.body.classList.remove('is-locked');
}

function setLockError(message) {
  const error = document.getElementById('localPassError');
  if (!error) return;
  error.textContent = message || '';
}

function shakeCard() {
  const card = document.getElementById('lockCard');
  if (!card) return;
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
}

function setBusy(busy, label) {
  const button = document.getElementById('localPassSubmit');
  const input = document.getElementById('localPassInput');
  const confirm = document.getElementById('localPassConfirm');
  const remember = document.getElementById('localPassRemember');
  if (!button) return;
  button.disabled = busy;
  if (input) input.disabled = busy;
  if (confirm) confirm.disabled = busy;
  if (remember) remember.disabled = busy;
  const text = button.querySelector('span:last-child');
  if (text) text.textContent = busy ? label : (button.dataset.label || t('lock.action.unlock'));
}

function mountLockScreen({
  configured,
  corrupted = false,
  autoUnlockAvailable = false,
  autoUnlockEnabled = false,
  autoUnlockPreferred = true,
  autoUnlockMessage = '',
  autoUnlockError = '',
  onUnlocked = () => {},
}) {
  const root = document.getElementById('lockScreen');
  if (!root) return;
  document.body.classList.add('is-locked');
  root.classList.remove('is-hidden');

  const setup = !configured;
  const title = t(setup ? 'lock.title.setup' : 'lock.title.unlock');
  const subtitle = t(setup
    ? 'lock.subtitle.setup'
    : 'lock.subtitle.unlock');
  const submitLabel = t(setup ? 'lock.action.create' : 'lock.action.unlock');
  const hint = t(setup
    ? 'lock.hint.unrecoverable'
    : 'lock.hint.localOnly');

  root.innerHTML = `
    <div class="lock-glow" aria-hidden="true"></div>
    <div class="lock-card" id="lockCard" role="dialog" aria-modal="true" aria-labelledby="lockTitle">
      ${lockEmblem(setup ? 'shield' : 'lock')}
      <div class="lock-brand"><span class="lock-brand-name">${t('app.name')}</span> <span>LOCAL VAULT</span></div>
      <h1 id="lockTitle">${title}</h1>
      <p class="lock-subtitle">${subtitle}</p>
      <form class="lock-form" id="localPassForm" novalidate>
        ${passwordField({
          id: 'localPassInput',
          label: t('password.localPassword'),
          placeholder: t(setup ? 'lock.placeholder.newPassword' : 'lock.placeholder.password'),
          autocomplete: setup ? 'new-password' : 'current-password',
        })}
        ${setup ? passwordField({
          id: 'localPassConfirm',
          label: t('lock.label.confirmPassword'),
          placeholder: t('lock.placeholder.confirmPassword'),
          autocomplete: 'new-password',
        }) : ''}
        ${autoUnlockAvailable ? `
          <label class="lock-remember">
            <input type="checkbox" id="localPassRemember" ${autoUnlockPreferred ? 'checked' : ''} />
            <span class="lock-remember-box" aria-hidden="true"></span>
            <span class="lock-remember-text">
              <b>${t('settings.autoUnlock.label')}</b>
              <small>${t('lock.autoUnlock.hint')}</small>
            </span>
          </label>` : ''}
        ${!autoUnlockAvailable ? `<div class="lock-note">${escapeHtml(autoUnlockMessage || t('password.autoUnlock.unavailable'))}</div>` : (autoUnlockEnabled ? '<div class="lock-note">' + t('lock.autoUnlock.enabledHint') + '</div>' : '')}
        <div class="lock-error" id="localPassError" role="alert" aria-live="assertive"></div>
        <button class="btn primary lock-submit" id="localPassSubmit" type="submit" data-label="${submitLabel}">
          ${icon(setup ? 'shield' : 'unlock', 16)}<span>${submitLabel}</span>
        </button>
      </form>
      <div class="lock-hint">${icon('shield', 14)}<span>${hint}</span></div>
      <div class="lock-badges">
        <span class="lock-badge">AES-256-GCM</span>
        <span class="lock-badge">scrypt</span>
        <span class="lock-badge">${t('lock.badge.localOnly')}</span>
      </div>
    </div>`;

  const form = root.querySelector('#localPassForm');
  const input = root.querySelector('#localPassInput');
  const confirm = root.querySelector('#localPassConfirm');
  const error = root.querySelector('#localPassError');

  for (const toggle of root.querySelectorAll('[data-lock-toggle]')) {
    toggle.addEventListener('click', () => {
      const target = root.querySelector(`#${toggle.dataset.lockToggle}`);
      if (!target) return;
      const show = target.type === 'password';
      target.type = show ? 'text' : 'password';
      toggle.innerHTML = icon(show ? 'eye-off' : 'eye', 18);
      toggle.setAttribute('aria-label', t(show ? 'lock.password.hide' : 'lock.password.show'));
      toggle.title = t(show ? 'lock.password.hide' : 'lock.password.show');
      target.focus();
    });
  }

  for (const field of [input, confirm]) {
    if (!field) continue;
    field.addEventListener('input', () => setLockError(''));
  }

  if (corrupted) setLockError(t('lock.error.corrupted'));
  else if (autoUnlockError) setLockError(autoUnlockError);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input || input.disabled) return;

    const pass = input.value;
    if (setup) {
      if ([...pass].length < MIN_PASSWORD_LENGTH) {
        setLockError(t('lock.error.tooShort', { count: MIN_PASSWORD_LENGTH }));
        shakeCard();
        input.focus();
        return;
      }
      if (confirm && pass !== confirm.value) {
        setLockError(t('lock.error.mismatch'));
        shakeCard();
        confirm.focus();
        return;
      }
    } else if (!pass) {
      setLockError(t('lock.error.required'));
      shakeCard();
      input.focus();
      return;
    }

    const rememberInput = root.querySelector('#localPassRemember');
    const remember = rememberInput ? rememberInput.checked : undefined;
    error.textContent = '';
    setBusy(true, t(setup ? 'lock.action.creating' : 'lock.action.verifying'));
    try {
      const result = setup
        ? await window.feige.localPassSetup({ pass, remember })
        : await window.feige.localPassUnlock({ pass, remember });
      if (!result || !result.ok) {
        setBusy(false, '');
        setLockError((result && result.message) || t('lock.error.unlockFailed'));
        shakeCard();
        if (result && result.code === 'wrong-password') input.select();
        else input.focus();
        return;
      }

      if (remember === true && result.autoUnlock && result.autoUnlock.saved === false) {
        toast(result.autoUnlock.message || t('lock.error.autoUnlockFailed'), 'warn');
      }
      const snapshot = result.snapshot || await window.feige.state();
      hideLockScreen();
      await onUnlocked(snapshot);
    } catch (err) {
      setBusy(false, '');
      setLockError(t('common.mainProcessUnavailable'));
      shakeCard();
      console.error('[feige] 本地密码解锁失败', err);
    }
  });

  setTimeout(() => input && input.focus(), 60);
}

function mountLockUnavailable(message) {
  const root = document.getElementById('lockScreen');
  if (!root) return;
  document.body.classList.add('is-locked');
  root.classList.remove('is-hidden');
  root.innerHTML = `
    <div class="lock-glow" aria-hidden="true"></div>
    <div class="lock-card" role="alertdialog" aria-modal="true">
      <div class="lock-emblem warn" aria-hidden="true">${icon('alert', 30)}</div>
      <div class="lock-brand"><span class="lock-brand-name">${t('app.name')}</span> <span>LOCAL VAULT</span></div>
      <h1>${t('app.error.readTitle')}</h1>
      <p class="lock-subtitle">${escapeHtml(message || t('lock.error.mainNotReady'))}</p>
      <div class="lock-form">
        <button class="btn primary lock-submit" id="lockReload" type="button">${icon('radar', 16)}<span>${t('lock.action.reload')}</span></button>
      </div>
      <div class="lock-hint">${icon('shield', 14)}<span>${t('lock.hint.locked')}</span></div>
    </div>`;
  root.querySelector('#lockReload')?.addEventListener('click', () => location.reload());
}

export { mountLockScreen, mountLockUnavailable, hideLockScreen, MIN_PASSWORD_LENGTH };
