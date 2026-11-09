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

function dayLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(timestamp) === dayKey(today.getTime())) return '今天';
  if (dayKey(timestamp) === dayKey(yesterday.getTime())) return '昨天';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function relativeTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${new Date(timestamp).getMonth() + 1} 月 ${new Date(timestamp).getDate()} 日`;
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
      return transfer.direction === 'out' ? '等待接收' : '待接收';
    case 'active':
      return '传输中';
    case 'done':
      return transfer.direction === 'out' ? '已发送' : '已接收';
    case 'declined':
      return transfer.direction === 'out' ? '被拒绝' : '已拒绝';
    case 'canceled':
      return '已取消';
    case 'error':
      return '失败';
    default:
      return '';
  }
}

function transferDetails(transfer) {
  if (!transfer) return '';
  switch (transfer.status) {
    case 'waiting':
      return `${formatBytes(transfer.totalBytes)} · 等待对方确认`;
    case 'active':
      return `${formatBytes(transfer.doneBytes)} / ${formatBytes(transfer.totalBytes)}${transfer.speed ? ` · ${formatBytes(transfer.speed)}/s` : ''}`;
    case 'done':
      return `${formatBytes(transfer.totalBytes)} · ${transfer.totalFiles || 0} 个文件`;
    case 'declined':
      return '对方拒绝接收';
    case 'canceled':
      return '传输已取消';
    case 'error':
      return transfer.error || '传输失败';
    default:
      return '';
  }
}

export { ESCAPE, escapeHtml, linkify, hueOf, avatarStyle, initials, setAvatar, formatBytes, formatTime, dayKey, dayLabel, relativeTime, FILE_GROUPS, fileInfo, progressOf, transferShortState, transferDetails };
