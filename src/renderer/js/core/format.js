import { getLocale, t } from '../i18n/index.js';

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const FILE_GROUPS = {
  img: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif', 'tif', 'tiff', 'psd'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'csv', 'pages', 'key', 'numbers'],
  zip: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'],
  media: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv'],
};

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPE[ch]);
}

function linkify(text) {
  return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" data-external="${url}">${url}</a>`);
}

function hueOf(text) {
  let hash = 0;
  for (const char of String(text || '?')) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

function avatarStyle(name) {
  const hue = hueOf(name);
  return `background:linear-gradient(135deg,hsl(${hue} 66% 52%),hsl(${(hue + 52) % 360} 72% 43%))`;
}

function initials(name) {
  const text = String(name || '?').trim();
  if (!text) return '?';
  if (/[\u3400-\u9fff]/.test(text[0])) return text.slice(0, 1);
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

function setAvatar(el, name) {
  if (!el) return;
  el.textContent = initials(name);
  el.setAttribute('style', avatarStyle(name));
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dayKey(timestamp) {
  return new Date(timestamp).toDateString();
}

function monthDayLabel(timestamp) {
  const locale = getLocale() === 'en' ? 'en-US' : 'zh-CN';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function dayLabel(timestamp) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(timestamp) === dayKey(today.getTime())) return t('common.time.today');
  if (dayKey(timestamp) === dayKey(yesterday.getTime())) return t('common.time.yesterday');
  return monthDayLabel(timestamp);
}

function relativeTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return t('common.time.justNow');
  if (diff < 60 * 60 * 1000) return t('common.time.minutesAgo', { count: Math.floor(diff / 60000) });
  if (diff < 24 * 60 * 60 * 1000) return t('common.time.hoursAgo', { count: Math.floor(diff / 3600000) });
  return monthDayLabel(timestamp);
}

function fileInfo(name, isDirectory) {
  if (isDirectory) return { label: 'DIR', cls: 'dir', svg: true };
  const extension = String(name || '').split('.').pop().toLowerCase();
  let cls = '';
  for (const [group, list] of Object.entries(FILE_GROUPS)) {
    if (list.includes(extension)) {
      cls = group;
      break;
    }
  }
  const label = extension && extension !== String(name).toLowerCase() ? extension.slice(0, 4).toUpperCase() : 'FILE';
  return { label, cls, svg: false };
}

function progressOf(transfer) {
  if (!transfer) return 0;
  if (transfer.status === 'done') return 100;
  if (!transfer.totalBytes) return 0;
  return Math.min(100, Math.max(0, Math.round(((transfer.doneBytes || 0) / transfer.totalBytes) * 100)));
}

function transferShortState(transfer) {
  if (!transfer) return '';
  switch (transfer.status) {
    case 'waiting':
      return t(transfer.direction === 'out' ? 'common.status.waitingToReceive' : 'common.status.pending');
    case 'active':
      return t('common.status.transferring');
    case 'done':
      return t(transfer.direction === 'out' ? 'common.status.sent' : 'common.status.received');
    case 'declined':
      return t(transfer.direction === 'out' ? 'common.status.rejected' : 'common.status.declined');
    case 'canceled':
      return t('common.status.canceled');
    case 'error':
      return t('common.status.failed');
    default:
      return '';
  }
}

function transferDetails(transfer) {
  if (!transfer) return '';
  switch (transfer.status) {
    case 'waiting':
      return `${formatBytes(transfer.totalBytes)} · ${t('common.status.waitingForPeer')}`;
    case 'active':
      return `${formatBytes(transfer.doneBytes)} / ${formatBytes(transfer.totalBytes)}${transfer.speed ? ` · ${formatBytes(transfer.speed)}/s` : ''}`;
    case 'done':
      return t('transfer.detail.done', { size: formatBytes(transfer.totalBytes), count: transfer.totalFiles || 0 });
    case 'declined':
      return t('transfer.peerDeclined');
    case 'canceled':
      return t('common.transferCanceled');
    case 'error':
      return transfer.error || t('transfer.failed');
    default:
      return '';
  }
}

export { ESCAPE, escapeHtml, linkify, hueOf, avatarStyle, initials, setAvatar, formatBytes, formatTime, dayKey, dayLabel, relativeTime, FILE_GROUPS, fileInfo, progressOf, transferShortState, transferDetails };
