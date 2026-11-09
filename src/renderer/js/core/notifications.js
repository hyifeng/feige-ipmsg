import { escapeHtml } from './format.js';
import { icon } from './icons.js';
import { dom } from './state.js';

function toast(message, type = 'info', action = null) {
  if (!dom.toastRoot || !message) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  const iconName = type === 'error' || type === 'warn' ? 'alert' : type === 'success' ? 'check' : 'info';
  element.innerHTML = `<span class="toast-ico">${icon(iconName, 14)}</span><span class="toast-text">${escapeHtml(message)}</span>`;
  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      try {
        action.onClick();
      } finally {
        dismiss();
      }
    });
    element.appendChild(button);
  }

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!element.isConnected) return;
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 220);
  };
  timer = setTimeout(dismiss, type === 'error' ? 5600 : 3800);

  dom.toastRoot.appendChild(element);
  while (dom.toastRoot.children.length > 4) dom.toastRoot.firstElementChild.remove();
}

export { toast };
