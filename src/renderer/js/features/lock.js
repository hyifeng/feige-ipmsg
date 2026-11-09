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
        <button type="button" class="lock-toggle" data-lock-toggle="${id}" aria-label="显示密码" title="显示密码">${icon('eye', 18)}</button>
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
  if (text) text.textContent = busy ? label : (button.dataset.label || '解锁');
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
  const title = setup ? '设置本地密码' : '解锁飞鸽';
  const subtitle = setup
    ? '首次使用，请先设置本地密码。它只会保存在本机，用于加密昵称、联系人、身份密钥与聊天记录。'
    : '输入本地密码以解密本机资料。密码错误将无法进入软件，也不会加载任何聊天记录。';
  const submitLabel = setup ? '创建并解锁' : '解锁';
  const hint = setup
    ? '密码不会被上传，也无法找回。忘记密码将永久失去本机聊天记录和已认证的加密配对。'
    : '本地密码只在本机用于解密，不会发送到局域网。连续输入错误不会泄露任何本地资料。';

  root.innerHTML = `
    <div class="lock-glow" aria-hidden="true"></div>
    <div class="lock-card" id="lockCard" role="dialog" aria-modal="true" aria-labelledby="lockTitle">
      ${lockEmblem(setup ? 'shield' : 'lock')}
      <div class="lock-brand">飞鸽 <span>LOCAL VAULT</span></div>
      <h1 id="lockTitle">${title}</h1>
      <p class="lock-subtitle">${subtitle}</p>
      <form class="lock-form" id="localPassForm" novalidate>
        ${passwordField({
          id: 'localPassInput',
          label: '本地密码',
          placeholder: setup ? '至少 6 位，建议使用长密码' : '输入本地密码',
          autocomplete: setup ? 'new-password' : 'current-password',
        })}
        ${setup ? passwordField({
          id: 'localPassConfirm',
          label: '确认密码',
          placeholder: '再次输入本地密码',
          autocomplete: 'new-password',
        }) : ''}
        ${autoUnlockAvailable ? `
          <label class="lock-remember">
            <input type="checkbox" id="localPassRemember" ${autoUnlockPreferred ? 'checked' : ''} />
            <span class="lock-remember-box" aria-hidden="true"></span>
            <span class="lock-remember-text">
              <b>下次免密进入</b>
              <small>使用系统钥匙串保存本地数据密钥，可在设置中随时关闭</small>
            </span>
          </label>` : ''}
        ${!autoUnlockAvailable ? `<div class="lock-note">${escapeHtml(autoUnlockMessage || '当前系统钥匙串不可用，无法启用免密登录')}</div>` : (autoUnlockEnabled ? '<div class="lock-note">免密登录已启用；如系统钥匙串不可用，本次仍需输入本地密码</div>' : '')}
        <div class="lock-error" id="localPassError" role="alert" aria-live="assertive"></div>
        <button class="btn primary lock-submit" id="localPassSubmit" type="submit" data-label="${submitLabel}">
          ${icon(setup ? 'shield' : 'unlock', 16)}<span>${submitLabel}</span>
        </button>
      </form>
      <div class="lock-hint">${icon('shield', 14)}<span>${hint}</span></div>
      <div class="lock-badges">
        <span class="lock-badge">AES-256-GCM</span>
        <span class="lock-badge">scrypt</span>
        <span class="lock-badge">仅本机</span>
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
      toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      toggle.title = show ? '隐藏密码' : '显示密码';
      target.focus();
    });
  }

  for (const field of [input, confirm]) {
    if (!field) continue;
    field.addEventListener('input', () => setLockError(''));
  }

  if (corrupted) setLockError('本地密码校验文件已损坏，无法解锁');
  else if (autoUnlockError) setLockError(autoUnlockError);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input || input.disabled) return;

    const pass = input.value;
    if (setup) {
      if ([...pass].length < MIN_PASSWORD_LENGTH) {
        setLockError(`本地密码至少需要 ${MIN_PASSWORD_LENGTH} 位`);
        shakeCard();
        input.focus();
        return;
      }
      if (confirm && pass !== confirm.value) {
        setLockError('两次输入的密码不一致');
        shakeCard();
        confirm.focus();
        return;
      }
    } else if (!pass) {
      setLockError('请输入本地密码');
      shakeCard();
      input.focus();
      return;
    }

    const rememberInput = root.querySelector('#localPassRemember');
    const remember = rememberInput ? rememberInput.checked : undefined;
    error.textContent = '';
    setBusy(true, setup ? '创建中…' : '验证中…');
    try {
      const result = setup
        ? await window.feige.localPassSetup({ pass, remember })
        : await window.feige.localPassUnlock({ pass, remember });
      if (!result || !result.ok) {
        setBusy(false, '');
        setLockError((result && result.message) || '无法解锁，请重试');
        shakeCard();
        if (result && result.code === 'wrong-password') input.select();
        else input.focus();
        return;
      }

      if (remember === true && result.autoUnlock && result.autoUnlock.saved === false) {
        toast(result.autoUnlock.message || '未能启用下次免密登录', 'warn');
      }
      const snapshot = result.snapshot || await window.feige.state();
      hideLockScreen();
      await onUnlocked(snapshot);
    } catch (err) {
      setBusy(false, '');
      setLockError('无法连接主进程，请重启应用后重试');
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
      <div class="lock-brand">飞鸽 <span>LOCAL VAULT</span></div>
      <h1>无法读取本地资料</h1>
      <p class="lock-subtitle">${escapeHtml(message || '主进程未就绪，请重启应用。')}</p>
      <div class="lock-form">
        <button class="btn primary lock-submit" id="lockReload" type="button">${icon('radar', 16)}<span>重新加载</span></button>
      </div>
      <div class="lock-hint">${icon('shield', 14)}<span>在解锁完成前，飞鸽不会加载配置、聊天记录，也不会启动网络广播。</span></div>
    </div>`;
  root.querySelector('#lockReload')?.addEventListener('click', () => location.reload());
}

export { mountLockScreen, mountLockUnavailable, hideLockScreen, MIN_PASSWORD_LENGTH };
