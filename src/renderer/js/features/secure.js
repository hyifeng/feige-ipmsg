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

  let label = '认证身份';
  let iconName = 'shield';
  let title = '核对 6 位码，确认对方身份';
  if (active && authenticated) {
    label = '已认证';
    title = active.mode === 'resume' ? '身份已认证 · 配对密钥校验通过' : '身份已通过 6 位码认证';
  } else if (pending) {
    if (pending.incoming) {
      label = '认证请求';
      title = '收到身份认证请求，请点击会话中的通知打开';
    } else {
      label = pending.mode === 'resume' ? '恢复认证中…' : '认证中…';
      title = pending.mode === 'resume' ? '正在恢复身份认证' : '正在核对 6 位码';
    }
  } else if (active) {
    label = '认证身份';
    title = '对方身份尚未认证，可核对 6 位码完成认证';
  } else if (waiting) {
    label = '等待重新认证';
    title = '本机认证已解除，等待对方重新认证';
  } else if (warning) {
    label = warning.canReset === false ? '认证异常' : (warning.actionLabel || '重新认证');
    iconName = 'alert';
    title = warning.title || '身份认证异常';
  } else if (paused) {
    label = paired ? '已认证' : '认证身份';
    title = pausedOffline ? '身份已认证；对方离线' : '身份已认证；会话连接暂时中断';
  } else if (paired) {
    const online = peer.online && state.self.online;
    label = '已认证';
    title = online ? '身份已认证；发送消息时会自动恢复会话' : '身份已认证；对方离线';
  }

  dom.secureBtn.innerHTML = `${icon(iconName, 17)}<span>${label}</span>`;
  dom.secureBtn.title = waiting ? title : (canAct || active ? title : '对方已离线');
  dom.secureBtn.disabled = waiting || !state.self.online || (!canAct && !active);
  dom.secureBtn.classList.toggle('active', authenticated && !warning);
  dom.secureBtn.classList.toggle('pending', !authenticated && !warning && (!!pending || !!active));
  dom.secureBtn.classList.toggle('paired', authenticated && !active && !warning);
  dom.chat.classList.toggle('secure-active', authenticated && !warning);

  if (active && authenticated) {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'paused', 'unverified');
    dom.secureBannerIcon.innerHTML = icon('shield', 18);
    dom.secureBannerTitle.textContent = '身份已认证';
    dom.secureBannerText.textContent = active.mode === 'resume'
      ? '已恢复认证关系 · 配对密钥校验通过；消息与文件始终端到端加密'
      : '已核对 6 位码完成身份认证；消息与文件始终端到端加密';
    dom.secureBannerBtn.classList.remove('is-hidden');
    dom.secureBannerBtn.textContent = '详情';
    dom.secureBanner.dataset.action = 'info';
  } else if (pending) {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'paused');
    dom.secureBanner.classList.add('unverified');
    dom.secureBannerIcon.innerHTML = icon('shield', 18);
    dom.secureBannerTitle.textContent = pending.incoming
      ? '收到认证请求'
      : (pending.mode === 'resume' ? '正在恢复认证' : '正在认证身份');
    dom.secureBannerText.textContent = pending.incoming
      ? '请点击会话中的「打开认证」核对 6 位码'
      : (pending.mode === 'resume' ? '正在校验已保存的认证密钥…' : '请与对方核对 6 位码…');
    dom.secureBannerBtn.classList.add('is-hidden');
    dom.secureBanner.dataset.action = '';
  } else if (active) {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'paused');
    dom.secureBanner.classList.add('unverified');
    dom.secureBannerIcon.innerHTML = icon('alert', 18);
    dom.secureBannerTitle.textContent = '身份未认证';
    dom.secureBannerText.textContent = '消息与文件始终端到端加密，但无法确认对方身份；核对 6 位码即可完成认证';
    dom.secureBannerBtn.classList.remove('is-hidden');
    dom.secureBannerBtn.textContent = '认证身份';
    dom.secureBanner.dataset.action = 'info';
  } else if (waiting) {
    dom.secureBanner.classList.remove('is-hidden', 'paused', 'unverified');
    dom.secureBanner.classList.add('warning');
    dom.secureBannerIcon.innerHTML = icon('alert', 18);
    dom.secureBannerTitle.textContent = '本机认证已解除';
    dom.secureBannerText.textContent = '等待对方在其设备上点击「重新认证」；完成后会重新核对 6 位码';
    dom.secureBannerBtn.classList.add('is-hidden');
    dom.secureBanner.dataset.action = '';
  } else if (warning) {
    dom.secureBanner.classList.remove('is-hidden', 'paused', 'unverified');
    dom.secureBanner.classList.add('warning');
    dom.secureBannerIcon.innerHTML = icon('alert', 18);
    dom.secureBannerTitle.textContent = warning.title || '认证恢复失败';
    dom.secureBannerText.textContent = warning.text || '';
    dom.secureBannerBtn.classList.toggle('is-hidden', warning.canReset === false);
    dom.secureBannerBtn.textContent = warning.actionLabel || '重新认证';
    dom.secureBanner.dataset.action = warning.canReset === false ? '' : 'retry';
  } else if (paused) {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'unverified');
    dom.secureBanner.classList.add('paused');
    dom.secureBannerIcon.innerHTML = icon('shield', 18);
    dom.secureBannerTitle.textContent = pausedOffline ? '身份已认证 · 对方离线' : '身份已认证 · 会话恢复中';
    dom.secureBannerText.textContent = pausedOffline
      ? (state.self.online
        ? '认证关系已保存；对方重新上线后会自动恢复会话'
        : '当前处于离线状态；恢复网络后会自动恢复会话，认证状态保留')
      : '认证关系已保存，正在尝试自动恢复连接';
    dom.secureBannerBtn.classList.add('is-hidden');
    dom.secureBanner.dataset.action = '';
  } else if (!paired) {
    dom.secureBanner.classList.remove('is-hidden', 'paused', 'warning');
    dom.secureBanner.classList.add('unverified');
    dom.secureBannerIcon.innerHTML = icon('alert', 18);
    dom.secureBannerTitle.textContent = '身份未认证';
    dom.secureBannerText.textContent = peer.online
      ? '消息会自动加密，但无法确认对方身份；核对 6 位码即可完成认证'
      : '对方离线；上线后可核对 6 位码完成认证；消息始终会自动加密';
    dom.secureBannerBtn.classList.toggle('is-hidden', !peer.online);
    dom.secureBannerBtn.textContent = '认证身份';
    dom.secureBanner.dataset.action = 'start';
  } else {
    dom.secureBanner.classList.remove('is-hidden', 'warning', 'unverified');
    dom.secureBanner.classList.add('paused');
    dom.secureBannerIcon.innerHTML = icon('shield', 18);
    dom.secureBannerTitle.textContent = '身份已认证';
    dom.secureBannerText.textContent = peer.online
      ? '认证关系已保存；发送消息时会自动恢复会话'
      : '对方离线；上线后会自动恢复会话，认证状态保留';
    dom.secureBannerBtn.classList.toggle('is-hidden', !peer.online);
    dom.secureBannerBtn.textContent = '恢复会话';
    dom.secureBanner.dataset.action = 'start';
  }
}

async function startSecure(peerKey) {
  if (!state.self.online) {
    toast('已下线，上线后才能认证身份', 'warn');
    return;
  }
  const peer = peerByKey(peerKey);
  if (!peer || !peer.online) {
    toast('请先选择一位在线同事', 'warn');
    return;
  }
  if (!state.self.ready) {
    toast('网络服务尚未就绪', 'warn');
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
      toast(result.temporary ? '会话已建立，可核对 6 位码完成认证' : '身份认证已启用', 'success');
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
    toast(result.mode === 'resume' ? '正在恢复上次身份认证…' : '正在认证身份，请核对 6 位码…', 'info');
  } catch (error) {
    toast(error.message || '无法完成身份认证', 'error');
  }
}

async function restartSecure(peerKey) {
  if (!state.self.online) {
    toast('已下线，上线后才能认证身份', 'warn');
    return;
  }
  const peer = peerByKey(peerKey);
  if (!peer || !window.feige) return;
  try {
    await window.feige.secureReset(peerKey);
  } catch (error) {
    toast(error.message || '重置认证失败', 'error');
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
  toast('已取消身份认证', 'info');
}

function onSecureButton() {
  const peer = activePeer();
  if (!peer) return;
  const warning = state.secureWarnings.get(peer.key);
  if (state.secureWaiting.has(peer.key)) {
    toast('本机认证已解除，等待对方重新认证', 'info');
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
    ? `<div class="secure-info-row"><span>安全码</span><b class="secure-info-code">${escapeHtml(formatSecureCode(active.code))}</b></div>`
    : '';
  const authMethod = authenticated
    ? (active.mode === 'resume' ? '配对密钥 + transcript 签名自动恢复' : '6 位安全码人工核对 + transcript 签名')
    : '尚未认证（transcript 签名已校验，但未人工核对身份）';
  const pairingState = authenticated
    ? '已保存认证，下次上线自动恢复'
    : '未保存认证；断开后下次发送会重新建立临时会话';
  const help = authenticated
    ? '当前消息与文件始终通过加密会话传输；关闭本窗口不会影响加密和认证状态。'
    : '当前仍无法确认对方身份。核对 6 位码可以完成认证，并保存为持久的认证关系。';
  const verifyAction = authenticated
    ? ''
    : `<button class="btn primary" id="secureVerifyBtn">${icon('shield', 15)} 认证身份</button>`;
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal secure-modal" role="dialog" aria-modal="true" aria-label="身份认证详情">
        <div class="modal-head">
          <div>
            <h3>${authenticated ? '身份已认证' : '身份未认证'}</h3>
            <p>与 ${escapeHtml(display.label)} 的当前会话</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="secure-info-list">
          <div class="secure-info-row"><span>认证状态</span><b>${authenticated ? '已认证' : '未认证'}</b></div>
          <div class="secure-info-row"><span>消息加密</span><b>始终启用（AES-256-GCM）</b></div>
          <div class="secure-info-row"><span>密钥交换</span><b>X25519 临时 DH + 哈希承诺 + Ed25519 签名</b></div>
          <div class="secure-info-row"><span>认证方式</span><b>${authMethod}</b></div>
          ${codeRow}
          <div class="secure-info-row"><span>认证保存</span><b>${pairingState}</b></div>
        </div>
        <p class="secure-help">${help}</p>
        <div class="modal-actions">
          ${authenticated ? '<button class="btn danger" id="secureRevokeBtn">解除认证</button>' : verifyAction}
          <button class="btn ghost" data-close-modal>关闭</button>
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
    toast(warning.text || '请让对方在其本机重新认证', 'warn');
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
      <div class="modal secure-modal" role="dialog" aria-modal="true" aria-label="处理身份认证">
        <div class="modal-head">
          <div>
            <h3>${revoked ? '认证已解除' : (warning.title || '处理身份认证')}</h3>
            <p>与 ${escapeHtml(display.label)} 的本地认证记录</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="secure-info-list">
          <div class="secure-info-row"><span>当前状态</span><b>${revoked ? '对方已解除本机认证' : '双方认证状态不一致'}</b></div>
          <div class="secure-info-row"><span>本机记录</span><b>${state.securePairings.has(peerKey) ? '仍保存旧认证' : '没有认证记录'}</b></div>
        </div>
        <p class="secure-help">${escapeHtml(warning.text || '')}</p>
        <p class="secure-help">可以重新认证并建立新的认证关系，也可以只解除本机保存的旧认证，之后继续以未认证状态通信。</p>
        <div class="modal-actions">
          <button class="btn danger" id="warningLocalRevoke">${icon('unlock', 15)} 解除本机认证</button>
          <button class="btn primary" id="warningReauth">${icon('shield', 15)} 重新认证</button>
          <button class="btn ghost" data-close-modal>取消</button>
        </div>
      </div>
    </div>`;

  const localRevoke = dom.modalRoot.querySelector('#warningLocalRevoke');
  const reauth = dom.modalRoot.querySelector('#warningReauth');
  localRevoke.addEventListener('click', async () => {
    localRevoke.disabled = true;
    reauth.disabled = true;
    localRevoke.textContent = '解除中…';
    let removed = false;
    try {
      removed = await window.feige.secureReset(peerKey);
    } catch (error) {
      toast(error.message || '解除本机认证失败', 'error');
      localRevoke.disabled = false;
      reauth.disabled = false;
      localRevoke.innerHTML = `${icon('unlock', 15)} 解除本机认证`;
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
    toast(removed ? '已解除本机认证' : '本机没有可解除的认证记录', removed ? 'info' : 'warn');
    renderPeers();
    const current = peerByKey(peerKey);
    if (current && state.active === peerKey) renderChatHead(current);
  });
  reauth.addEventListener('click', async () => {
    reauth.disabled = true;
    localRevoke.disabled = true;
    reauth.textContent = '重新认证中…';
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
      <div class="modal secure-modal" role="dialog" aria-modal="true" aria-label="解除认证">
        <div class="modal-head">
          <div>
            <h3>解除认证</h3>
            <p>与 ${escapeHtml(display.label)} 的本地认证记录</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="secure-info-list">
          <div class="secure-info-row"><span>操作</span><b>仅解除本机认证</b></div>
          <div class="secure-info-row"><span>对方</span><b>仍保留旧认证，直到对方点击「重新认证」</b></div>
        </div>
        <p class="secure-help">解除后旧认证无法恢复。若当前会话在线，会先通知对方；对方随后可以点击「重新认证」来解除旧认证并建立新认证。本机不会主动发起认证。</p>
        <div class="secure-status warn">请确认对方在线或能收到通知</div>
        <div class="modal-actions">
          <button class="btn ghost" data-close-modal>取消</button>
          <button class="btn danger" id="confirmRevokeBtn">${icon('unlock', 15)} 解除认证</button>
        </div>
      </div>
    </div>`;

  const confirm = dom.modalRoot.querySelector('#confirmRevokeBtn');
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    confirm.textContent = '解除中…';
    let removed = false;
    try {
      removed = await window.feige.secureRevoke(peerKey);
    } catch (error) {
      toast(error.message || '解除认证失败', 'error');
      confirm.disabled = false;
      confirm.innerHTML = `${icon('unlock', 15)} 解除认证`;
      return;
    }
    if (!removed) {
      toast('本机没有可解除的认证记录', 'warn');
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
    toast('已解除本机认证，等待对方重新认证', 'info');
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
      toast('收到新的认证请求，请先处理当前窗口', 'info');
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
      <div class="modal secure-modal" role="dialog" aria-modal="true" aria-label="认证身份">
        <div class="modal-head">
          <div>
            <h3>认证身份</h3>
            <p>与 ${escapeHtml(info.peerName || '对方')} 核对 6 位码${alreadyActive ? '，确认对方身份' : '，确认对方身份'}</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>
        <div class="secure-code">${escapeHtml(formatSecureCode(info.code))}</div>
        <p class="secure-help">${alreadyActive
          ? '当前聊天内容始终加密。请与对方当面，或通过电话、另一个可信的聊天工具核对 6 位码；双方确认后会保存认证，下次上线自动恢复。关闭本窗口不会中断当前会话。'
          : '请与对方当面，或通过电话、另一个可信的聊天工具核对。只有两边数字完全一致时才确认；确认后会把对方标记为已认证，并允许设置本地别名。'}</p>
        <div class="secure-status" id="secureModalStatus">等待你确认</div>
        <div class="modal-actions">
          <button class="btn ghost" id="secureModalCancel">取消</button>
          <button class="btn primary" id="secureModalConfirm">${icon('shield', 15)} 数字一致</button>
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
    confirmBtn.textContent = '确认中…';
    try {
      const ok = await window.feige.secureConfirm(info.sessionId);
      if (!ok) throw new Error('认证会话已失效');
      state.modal.localConfirmed = true;
      confirmBtn.textContent = '等待对方确认…';
      setStatus(state.modal.peerConfirmed ? '双方已确认，正在完成认证…' : '等待对方确认…');
    } catch (error) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `${icon('shield', 15)} 数字一致`;
      setStatus(error.message || '确认失败', true);
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
