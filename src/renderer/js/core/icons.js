const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7h.03A1.7 1.7 0 0 0 10.06 3.14V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.3 9v.03a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
  send: '<path d="M21.5 2.5 10.8 13.2"/><path d="M21.5 2.5 14.8 21l-4-7.8-7.8-4 18.5-6.7Z"/>',
  paperclip: '<path d="m20.5 11.5-8.9 8.9a5.5 5.5 0 0 1-7.8-7.8l9.3-9.3a3.7 3.7 0 0 1 5.2 5.2l-9.3 9.3a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2.2h7.8A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-10Z"/>',
  'folder-plus': '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2.2h7.8A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-10Z"/><path d="M12 11v6M9 14h6"/>',
  inbox: '<path d="M4.5 4h15l2 10.5a2 2 0 0 1-2 2.5h-4l-1.5 2.5h-4L8.5 17h-4a2 2 0 0 1-2-2.5L4.5 4Z"/><path d="M4.8 12h4.4l1.3 2.2h3l1.3-2.2h4.4"/>',
  download: '<path d="M12 3v12"/><path d="m7 10.5 5 5 5-5"/><path d="M4 20h16"/>',
  upload: '<path d="M12 21V9"/><path d="m7 13.5 5-5 5 5"/><path d="M4 4h16"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  'check-check': '<path d="m2.5 12.5 4 4L15 8"/><path d="m9.5 15.5 1 1L21.5 6"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  moon: '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  power: '<path d="M12 3v9"/><path d="M6.2 6.2a8 8 0 1 0 11.6 0"/>',
  alert: '<path d="M12 8v5"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  radar: '<path d="M19.1 4.9A10 10 0 1 1 4.9 19.1"/><path d="M12 12 5 5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  zap: '<path d="M13 2 4.5 13H11l-1 9L19.5 11H13l0-9Z"/>',
  users: '<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="3.5"/><path d="M17 4a3.5 3.5 0 0 1 0 6.8"/><path d="M22 20v-1.5a4 4 0 0 0-3-3.85"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 13.5a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 5.4"/><path d="M14 10.5a5 5 0 0 0-7.1 0L4.5 12.9a5 5 0 0 0 7.1 7.1l1.4-1.4"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/><path d="M12 14v2"/>',
  unlock: '<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 7.2-2.4"/><path d="M12 14v2"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m3.5 3.5 17 17"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a18.4 18.4 0 0 1-3.2 4.4"/><path d="M6.6 6.6A18.1 18.1 0 0 0 2.5 12s3.5 7 9.5 7a10.9 10.9 0 0 0 4.3-.9"/>',
  shield: '<path d="M12 3 4.5 6v5.3c0 4.8 3.2 8 7.5 9.7 4.3-1.7 7.5-4.9 7.5-9.7V6L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-4.8"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m3.5 17 5-5 4 4 3-3 5 5"/>',
};

function icon(name, size = 18) {
  const body = ICONS[name] || ICONS.info;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.hydrated === '1') continue;
    el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
    el.dataset.hydrated = '1';
  }
}

export { ICONS, icon, hydrateIcons };
