import { toast } from '../core/notifications.js';
import { dom, state } from '../core/state.js';
import { closeImageMenu } from './images.js';
import { applyTheme } from './peers.js';
import { maybeShowQueuedSecure } from './secure.js';

function closeModal(restoreTheme = true) {
  closeImageMenu();
  const secureModal = state.modal && state.modal.type === 'secure' ? state.modal : null;
  if (secureModal && !secureModal.settled) {
    secureModal.settled = true;
    if (!secureModal.activeSession) {
      window.feige?.secureCancel(secureModal.id).catch(() => {});
      toast('已取消身份认证', 'info');
    }
  }
  const wasSettings = state.modal && state.modal.type === 'settings';
  const onDone = state.modal && typeof state.modal.onDone === 'function' ? state.modal.onDone : null;
  dom.modalRoot.innerHTML = '';
  state.modal = null;
  if (restoreTheme && wasSettings) {
    applyTheme(state.settings.theme, false);
  }
  if (onDone) setTimeout(onDone, 0);
  setTimeout(maybeShowQueuedSecure, 0);
}

export { closeModal };
