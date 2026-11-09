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
    toast('请先完成身份认证，再设置本地别名', 'warn');
    return;
  }
  const claimed = display.claimed || peer.user || '';
  dom.modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal alias-modal" role="dialog" aria-modal="true" aria-label="命名设备">
        <div class="modal-head">
          <div>
            <h3>${display.alias ? '修改本地别名' : '设置本地别名'}</h3>
            <p>别名只保存在本机，不会发送给对方</p>
          </div>
          <button class="modal-close" data-close-modal title="关闭">${icon('x', 17)}</button>
        </div>

        <div class="alias-body">
          <div class="alias-fingerprint-row">
            <span class="alias-fingerprint-label">身份指纹</span>
            <code class="alias-fingerprint">${escapeHtml(display.fingerprint)}</code>
          </div>
          <div class="alias-verify-hint">该设备已通过 6 位码完成身份认证。别名只保存在本机，不会发送给对方。</div>
          ${claimed ? `<div class="alias-claimed">对方自称：<b>${escapeHtml(claimed)}</b></div>` : ''}

          <label class="field">
            <span>本地别名</span>
            <input class="input" id="aliasInput" maxlength="32" value="${escapeHtml(display.alias || claimed)}" placeholder="例如：张三 · 设计部" />
            <small>留空则自动使用对方自称；同名不同指纹会分别提示。</small>
          </label>
        </div>

        <div class="modal-actions">
          <button class="btn ghost alias-clear" id="aliasClear" ${display.alias ? '' : 'disabled'}>清除别名</button>
          <span class="alias-hint">保存后仅影响当前设备的显示</span>
          <button class="btn ghost" data-close-modal>取消</button>
          <button class="btn primary" id="aliasSave">保存</button>
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
        toast(`“${alias}”已用于另一台设备（${duplicate[1].fingerprint || '未知指纹'}），请核对指纹`, 'warn');
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
          label: alias || display.claimed || '已验证设备',
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
      toast(alias ? `已设置本地别名“${alias}”` : '已清除本地别名，将显示对方自称的名字', 'success');
    } catch (error) {
      saveBtn.disabled = false;
      clearBtn.disabled = false;
      toast(error.message || '保存别名失败', 'error');
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
