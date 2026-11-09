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
      <div class="modal change-password-modal" role="dialog" aria-modal="true" aria-label="修改本地密码">
        <div class="modal-head">
          <div>
            <h3>修改本地密码</h3>
            <p>只重新包裹本地数据密钥，不会重新加密聊天记录</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span>原密码</span>
            <input class="input" id="oldLocalPass" type="password" autocomplete="current-password" spellcheck="false" placeholder="输入当前本地密码" />
          </label>
          <label class="field">
            <span>新密码</span>
            <input class="input" id="newLocalPass" type="password" autocomplete="new-password" spellcheck="false" placeholder="至少 ${MIN_PASSWORD_LENGTH} 位" />
          </label>
          <label class="field">
            <span>确认新密码</span>
            <input class="input" id="confirmLocalPass" type="password" autocomplete="new-password" spellcheck="false" placeholder="再次输入新密码" />
          </label>
          <div class="form-error" id="changePassError" role="alert" aria-live="assertive"></div>
          <p class="change-pass-note">修改后下次启动需要使用新密码。已启用的「下次免密进入」会被关闭，可重新在设置中开启。</p>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" id="changePassCancel">取消</button>
          <button class="btn primary" id="changePassSubmit">${icon('lock', 15)} 修改密码</button>
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
      setError('请输入原密码');
      oldInput.focus();
      return;
    }
    if ([...newPass].length < MIN_PASSWORD_LENGTH) {
      setError(`新密码至少需要 ${MIN_PASSWORD_LENGTH} 位`);
      newInput.focus();
      return;
    }
    if (newPass !== confirmInput.value) {
      setError('两次输入的新密码不一致');
      confirmInput.focus();
      return;
    }

    setError('');
    submit.disabled = true;
    submit.textContent = '修改中…';
    try {
      const result = await window.feige.changeLocalPass({ oldPass, newPass });
      if (!result || !result.ok) {
        submit.disabled = false;
        submit.innerHTML = `${icon('lock', 15)} 修改密码`;
        setError((result && result.message) || '修改失败，请重试');
        if (result && result.code === 'wrong-password') oldInput.select();
        return;
      }
      closeModal();
      toast('本地密码已修改，下次启动请使用新密码', 'success');
    } catch (err) {
      submit.disabled = false;
      submit.innerHTML = `${icon('lock', 15)} 修改密码`;
      setError('无法连接主进程，请重启应用后重试');
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
