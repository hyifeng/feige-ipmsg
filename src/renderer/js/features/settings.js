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
    ? '使用系统钥匙串记住本地数据密钥；关闭后下次启动需要输入本地密码'
    : (security.autoUnlockMessage || '当前系统钥匙串不可用，无法启用免密登录');
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal" role="dialog" aria-modal="true" aria-label="设置">
        <div class="modal-head">
          <div>
            <h3>设置</h3>
            <p>配置身份、网络、本地密码与文件接收方式</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span>我的昵称</span>
            <input class="input" id="setNickname" maxlength="32" value="${escapeHtml(settings.nickname)}" />
          </label>
          <label class="switch-row">
            <div>
              <b>启用局域网发现</b>
              <small>关闭后只通过 Hub 发现同事，本机不再监听局域网 UDP/TCP</small>
            </div>
            <span class="switch"><input type="checkbox" id="setLanEnabled" ${settings.lanEnabled !== false ? 'checked' : ''} /><i></i></span>
          </label>
          <div class="switch-row">
            <div class="hub-copy">
              <b>通过公网服务器发现同事</b>
              <small>服务器只扩散飞鸽广播帧、转发 P2P 信令；消息、图片和文件仍走直连</small>
              <span class="hub-inline" id="hubInline" ${settings.hubEnabled ? '' : 'hidden'}>
                <small class="hub-detail" id="hubDetail"></small>
                <button class="hub-edit" type="button" data-hub-action="edit">更改</button>
              </span>
            </div>
            <span class="switch"><input type="checkbox" id="setHubEnabled" ${settings.hubEnabled ? 'checked' : ''} /><i></i></span>
          </div>
          <label class="switch-row">
            <div>
              <b>下次免密进入</b>
              <small>${escapeHtml(autoUnlockHint)}</small>
            </div>
            <span class="switch"><input type="checkbox" id="setAutoUnlock" ${security.autoUnlockEnabled ? 'checked' : ''} ${security.autoUnlockAvailable || security.autoUnlockEnabled ? '' : 'disabled'} /><i></i></span>
          </label>
          <div class="field">
            <span>本地密码</span>
            <div class="dir-row">
              <button class="mini-action" id="changePassBtn" type="button">修改本地密码</button>
            </div>
            <small>修改密码只会重新包裹本地数据密钥，不会重新加密聊天记录；下次启动需使用新密码。</small>
          </div>
          <div class="field">
            <span>接收文件保存到</span>
            <div class="dir-row">
              <input class="input" id="setDownloadDir" readonly value="${escapeHtml(settings.downloadDir)}" />
              <button class="mini-action" id="browseDir">更改</button>
            </div>
          </div>
          <label class="switch-row">
            <div>
              <b>自动接收文件</b>
              <small>收到文件后直接保存到接收目录，不再逐个询问</small>
            </div>
            <span class="switch"><input type="checkbox" id="setAutoAccept" ${settings.autoAccept ? 'checked' : ''} /><i></i></span>
          </label>
          <label class="switch-row">
            <div>
              <b>消息提示音</b>
              <small>收到新消息或文件请求时播放提示音</small>
            </div>
            <span class="switch"><input type="checkbox" id="setSound" ${settings.sound !== false ? 'checked' : ''} /><i></i></span>
          </label>
        </div>
        <div class="modal-actions">
          <span class="settings-about">飞鸽 v${escapeHtml(state.version)} · 身份 ${escapeHtml(state.self.fingerprint || '—')} · UDP / TCP</span>
          <button class="btn ghost" data-close-modal>取消</button>
          <button class="btn primary" id="saveSettings">保存设置</button>
        </div>
      </div>
    </div>`;

  state.modal = { type: 'settings' };

  const nicknameInput = dom.modalRoot.querySelector('#setNickname');
  const dirInput = dom.modalRoot.querySelector('#setDownloadDir');
  const autoInput = dom.modalRoot.querySelector('#setAutoAccept');
  const soundInput = dom.modalRoot.querySelector('#setSound');
  const autoUnlockInput = dom.modalRoot.querySelector('#setAutoUnlock');
  const lanEnabledInput = dom.modalRoot.querySelector('#setLanEnabled');
  const hubEnabledInput = dom.modalRoot.querySelector('#setHubEnabled');

  dom.modalRoot.querySelector('#browseDir').addEventListener('click', async () => {
    try {
      const chosen = await window.feige.chooseDir(dirInput.value);
      if (chosen) dirInput.value = chosen;
    } catch (error) {
      toast(error.message || '无法选择目录', 'error');
    }
  });

  autoUnlockInput?.addEventListener('change', async () => {
    const enabled = autoUnlockInput.checked;
    autoUnlockInput.disabled = true;
    try {
      const result = await window.feige.setAutoUnlock(enabled);
      if (!result || !result.ok) {
        autoUnlockInput.checked = !enabled;
        toast((result && result.message) || '无法更新免密设置', 'error');
      } else {
        toast(enabled ? '已启用下次免密进入' : '已关闭下次免密进入', 'success');
      }
    } catch (error) {
      autoUnlockInput.checked = !enabled;
      toast(error.message || '无法更新免密设置', 'error');
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
      toast('昵称不能为空', 'warn');
      nicknameInput.focus();
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '保存中…';
    const lanEnabled = lanEnabledInput.checked;
    if (!lanEnabled && !state.settings.hubEnabled) {
      toast('至少启用局域网发现或 Hub 服务器之一', 'warn');
      button.disabled = false;
      button.textContent = '保存设置';
      return;
    }
    const patch = {
      nickname,
      downloadDir: dirInput.value,
      autoAccept: autoInput.checked,
      sound: soundInput.checked,
      lanEnabled,
    };
    try {
      await window.feige.updateSettings(patch);
      state.settings = { ...state.settings, ...patch };
      closeModal(false);
      toast('设置已保存', 'success');
    } catch (error) {
      button.disabled = false;
      button.textContent = '保存设置';
      toast(error.message || '保存失败', 'error');
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
    : '尚未配置服务器地址';
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
    toast(error.message || '服务器设置失败', 'error');
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
    enabled ? '公网服务器已启动' : '公网服务器已关闭',
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
    <div class="modal modal-secondary" role="dialog" aria-modal="true" aria-label="公网服务器">
      <div class="modal-head">
        <div>
          <h3>公网服务器</h3>
          <p>填写 Hub 地址；服务器只转发广播和 P2P 信令</p>
        </div>
        <button class="modal-close" type="button" data-hub-cancel title="关闭">${icon('x', 17)}</button>
      </div>
      <div class="settings-grid">
        <label class="field">
          <span>服务器地址</span>
          <input class="input" id="hubModalUrl" maxlength="512" placeholder="wss://hub.example.com:8787" value="${escapeHtml(state.settings.hubUrl || '')}" />
          <small>支持 ws:// / wss://。留空无法启动公网服务器。</small>
        </label>
        <label class="field">
          <span>STUN 地址（可选）</span>
          <input class="input" id="hubModalStun" maxlength="512" placeholder="留空使用服务器同主机 3478 端口" value="${escapeHtml(state.settings.hubStunUrl || '')}" />
          <small>只在公网直连需要反射公网 UDP 地址时使用；不配置 TURN 中继。</small>
        </label>
        <div class="form-error" id="hubModalError"></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" data-hub-cancel>取消</button>
        <button class="btn primary" type="button" id="hubModalSave">${startAfterSave ? '保存并启动' : '保存'}</button>
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
      errorEl.textContent = '服务器地址必须是 ws:// 或 wss://';
      urlInput.focus();
      return;
    }
    if (stunInput.value.trim() && !hubStunUrl) {
      errorEl.textContent = 'STUN 地址必须是 stun://';
      stunInput.focus();
      return;
    }
    if (!hubUrl) {
      errorEl.textContent = '请填写服务器地址';
      urlInput.focus();
      return;
    }
    errorEl.textContent = '';
    const patch = { hubUrl, hubStunUrl };
    if (startAfterSave) patch.hubEnabled = true;
    saveButton.disabled = true;
    saveButton.textContent = '保存中…';
    try {
      const settings = await window.feige.updateSettings(patch);
      state.settings = { ...state.settings, ...(settings || patch) };
      close();
      updateHubRow();
      toast(startAfterSave ? '公网服务器已启动' : '服务器配置已保存', 'success');
    } catch (error) {
      errorEl.textContent = error.message || '保存失败';
      saveButton.disabled = false;
      saveButton.textContent = startAfterSave ? '保存并启动' : '保存';
    }
  });

  setTimeout(() => urlInput.focus(), 60);
}

export { openSettings };
