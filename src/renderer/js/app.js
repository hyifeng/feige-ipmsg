import { hydrateIcons } from './core/icons.js';
import { dom, forcedTheme, isDemo, mergeSelf, state, wantPanel } from './core/state.js';
import { bindStaticEvents, handleEvent } from './features/events.js';
import { hideLockScreen, mountLockScreen, mountLockUnavailable } from './features/lock.js';
import { renderMessages } from './features/messages.js';
import { applyTheme, renderAll } from './features/peers.js';
import { openPanel } from './features/transfers.js';

function cacheDom() {
  dom.chat = document.getElementById('chat');
  dom.welcome = document.getElementById('welcome');
  dom.welcomeHint = document.getElementById('welcomeHint');
  dom.selfCard = document.getElementById('selfCard');
  dom.selfAvatar = document.getElementById('selfAvatar');
  dom.selfName = document.getElementById('selfName');
  dom.selfMeta = document.getElementById('selfMeta');
  dom.brandPulse = document.getElementById('brandPulse');
  dom.peerSearch = document.getElementById('peerSearch');
  dom.peerList = document.getElementById('peerList');
  dom.transferToggle = document.getElementById('transferToggle');
  dom.transferBadge = document.getElementById('transferBadge');
  dom.historyBtn = document.getElementById('historyBtn');
  dom.themeBtn = document.getElementById('themeBtn');
  dom.settingsBtn = document.getElementById('settingsBtn');
  dom.chatAvatar = document.getElementById('chatAvatar');
  dom.chatName = document.getElementById('chatName');
  dom.chatStatus = document.getElementById('chatStatus');
  dom.chatMeta = document.getElementById('chatMeta');
  dom.chatAliasBtn = document.getElementById('chatAliasBtn');
  dom.sendFileBtn = document.getElementById('sendFileBtn');
  dom.sendFolderBtn = document.getElementById('sendFolderBtn');
  dom.chatTransferBtn = document.getElementById('chatTransferBtn');
  dom.secureBtn = document.getElementById('secureBtn');
  dom.secureBtnLabel = document.getElementById('secureBtnLabel');
  dom.secureBanner = document.getElementById('secureBanner');
  dom.secureBannerIcon = document.getElementById('secureBannerIcon');
  dom.secureBannerTitle = document.getElementById('secureBannerTitle');
  dom.secureBannerText = document.getElementById('secureBannerText');
  dom.secureBannerBtn = document.getElementById('secureBannerBtn');
  dom.messages = document.getElementById('messages');
  dom.composer = document.getElementById('composer');
  dom.messageInput = document.getElementById('messageInput');
  dom.sendBtn = document.getElementById('sendBtn');
  dom.attachImageBtn = document.getElementById('attachImageBtn');
  dom.attachFileBtn = document.getElementById('attachFileBtn');
  dom.attachFolderBtn = document.getElementById('attachFolderBtn');
  dom.composerHint = document.getElementById('composerHint');
  dom.peerAddress = document.getElementById('peerAddress');
  dom.transferPanel = document.getElementById('transferPanel');
  dom.transferList = document.getElementById('transferList');
  dom.transferSummary = document.getElementById('transferSummary');
  dom.panelScrim = document.getElementById('panelScrim');
  dom.closeTransfers = document.getElementById('closeTransfers');
  dom.dropOverlay = document.getElementById('dropOverlay');
  dom.dropText = document.getElementById('dropText');
  dom.modalRoot = document.getElementById('modalRoot');
  dom.toastRoot = document.getElementById('toastRoot');
}

async function init() {
  cacheDom();
  hydrateIcons();
  bindStaticEvents();
  applyTheme(localStorage.getItem('feige-theme') || 'dark', false);
  renderAll();

  if (!window.feige) {
    mountLockUnavailable('预加载脚本未就绪，请重启应用。');
    return;
  }

  window.feige.onEvent(handleEvent);

  if (isDemo) {
    hideLockScreen();
    state.demo = true;
    seedDemo();
    if (forcedTheme) {
      state.settings.theme = forcedTheme === 'light' ? 'light' : 'dark';
      applyTheme(state.settings.theme, false);
    }
    if (wantPanel) setTimeout(() => openPanel(), 160);
    return;
  }

  try {
    const status = await window.feige.localPassStatus();
    if (status.unlocked) {
      hideLockScreen();
      await finishUnlock(status.snapshot || await window.feige.state());
      return;
    }
    mountLockScreen({
      configured: !!status.configured,
      corrupted: !!status.corrupted,
      autoUnlockAvailable: !!status.autoUnlockAvailable,
      autoUnlockEnabled: !!status.autoUnlockEnabled,
      autoUnlockPreferred: status.autoUnlockPreferred !== false,
      autoUnlockMessage: status.autoUnlockMessage || '',
      autoUnlockError: status.autoUnlockError || '',
      onUnlocked: finishUnlock,
    });
  } catch (error) {
    mountLockUnavailable(`无法读取本地资料：${error.message || error}`);
  }
}

async function finishUnlock(snapshot) {
  applySnapshot(snapshot);
  try {
    state.version = await window.feige.getVersion();
  } catch {
    /* 版本号只用于设置页展示 */
  }
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.self) mergeSelf(snapshot.self);
  if (snapshot.settings) state.settings = { ...state.settings, ...snapshot.settings };
  state.peers = Array.isArray(snapshot.peers) ? snapshot.peers : [];
  state.historyPeers = Array.isArray(snapshot.historyPeers) ? snapshot.historyPeers : [];
  state.contacts = new Map((snapshot.contacts || []).map((contact) => [contact.peerKey, contact]));
  state.securePairings = new Set((snapshot.securePairings || []).map((pairing) => pairing.peerKey));
  state.securePeers = new Map((snapshot.secureSessions || []).map((session) => [session.peerKey, session]));
  if (Array.isArray(snapshot.transfers)) {
    for (const transfer of snapshot.transfers) state.transfers.set(transfer.id, transfer);
  }
  applyTheme(state.settings.theme, false);
  renderAll();
}

function seedDemo() {
  const now = Date.now();
  state.self = {
    id: 'demo-self',
    nickname: '飞鸽用户',
    host: 'spirit-linux',
    port: 24250,
    addresses: ['192.168.31.42'],
    online: true,
    ready: true,
  };
  state.settings = {
    nickname: '飞鸽用户',
    port: 24250,
    downloadDir: '/home/spirithuang/Downloads/飞鸽接收',
    autoAccept: false,
    sound: true,
    theme: 'dark',
    online: true,
  };
  state.peers = [
    { key: 'id:demo-lin', ip: '192.168.31.18', port: 24250, user: '林小满', host: 'lin-macbook', online: true, lastSeen: now },
    { key: 'id:demo-chen', ip: '192.168.31.27', port: 24250, user: '陈一鸣', host: 'chen-pc', online: true, lastSeen: now },
    { key: 'id:demo-zhou', ip: '192.168.31.35', port: 24250, user: '周可盈', host: 'zhou-notebook', online: true, lastSeen: now },
    { key: 'id:demo-design', ip: '192.168.31.33', port: 24250, user: '设计部 · iMac', host: 'design-imac', online: false, lastSeen: now - 3600000 },
    { key: 'id:demo-nas', ip: '192.168.31.9', port: 24250, user: 'NAS 存储', host: 'nas-01', online: false, lastSeen: now - 86400000 },
    { key: 'id:pk1_25M7ED7DRODXICBZLIYUTPECCM3LUDAS2ER6HBJCDROLZPKXP4SA', ip: '192.168.31.66', port: 24250, user: 'Alice', host: 'unknown-pc', online: true, lastSeen: now },
  ];

  state.contacts = new Map([
    ['id:demo-lin', { peerKey: 'id:demo-lin', identity: 'demo-lin', alias: '林小满', fingerprint: 'DEMO-0001' }],
    ['id:demo-chen', { peerKey: 'id:demo-chen', identity: 'demo-chen', alias: '陈一鸣', fingerprint: 'DEMO-0002' }],
    ['id:demo-zhou', { peerKey: 'id:demo-zhou', identity: 'demo-zhou', alias: '周可盈', fingerprint: 'DEMO-0003' }],
    ['id:demo-design', { peerKey: 'id:demo-design', identity: 'demo-design', alias: '设计部 · iMac', fingerprint: 'DEMO-0004' }],
    ['id:demo-nas', { peerKey: 'id:demo-nas', identity: 'demo-nas', alias: 'NAS 存储', fingerprint: 'DEMO-0005' }],
  ]);
  state.securePairings = new Set(['id:demo-lin', 'id:demo-chen', 'id:demo-zhou', 'id:demo-design', 'id:demo-nas']);
  state.securePeers = new Map([
    ['id:demo-lin', { peerKey: 'id:demo-lin', peerName: '林小满', mode: 'pair', sessionId: 'demo-secure' }],
  ]);

  state.messages.set('id:demo-lin', [
    { id: 'demo-m1', direction: 'in', kind: 'text', text: '早上好！新版的品牌素材整理好了吗？', at: now - 1000 * 60 * 60 * 25 },
    { id: 'demo-m2', direction: 'out', kind: 'text', text: '整理好了，源文件和导出图都在，我直接把整个文件夹发你。', at: now - 1000 * 60 * 60 * 24.8, status: 'read' },
    { id: 'demo-m3', direction: 'in', kind: 'text', text: '太好了，顺便把字体授权说明也带上～', at: now - 1000 * 60 * 60 * 24.6 },
    {
      id: 'demo-m4',
      direction: 'out',
      kind: 'files',
      text: '都在这里了，目录结构已保留，直接解压就能用。',
      at: now - 1000 * 60 * 4,
      transferId: 'demo-transfer-1',
      totalBytes: 7284000,
      totalFiles: 3,
      totalDirs: 1,
      totalEntries: 4,
      rootName: '品牌素材 2026',
      isFolder: true,
      files: [
        { id: 'df0', name: '品牌素材 2026', relPath: '品牌素材 2026', size: 0, dir: true, done: true },
        { id: 'df1', name: 'logo.svg', relPath: '品牌素材 2026/logo.svg', size: 284000, dir: false, done: true },
        { id: 'df2', name: 'banner@2x.png', relPath: '品牌素材 2026/banner@2x.png', size: 5760000, dir: false, done: true },
        { id: 'df3', name: '字体授权.pdf', relPath: '品牌素材 2026/字体授权.pdf', size: 1240000, dir: false, done: true },
      ],
    },
    { id: 'demo-m5', direction: 'in', kind: 'text', text: '收到，速度好快 👍  下午评审直接用这版。', at: now - 1000 * 60 * 2.5 },
  ]);

  state.transfers.set('demo-transfer-1', {
    id: 'demo-transfer-1',
    direction: 'out',
    peerKey: 'id:demo-lin',
    peerName: '林小满',
    peerIp: '192.168.31.18',
    status: 'done',
    totalBytes: 7284000,
    doneBytes: 7284000,
    totalFiles: 3,
    totalDirs: 1,
    totalEntries: 4,
    rootName: '品牌素材 2026',
    isFolder: true,
    completedFiles: 3,
    speed: 0,
    root: null,
    error: null,
    createdAt: now - 1000 * 60 * 4,
    updatedAt: now - 1000 * 60 * 3.6,
    files: [
      { id: 'df0', name: '品牌素材 2026', relPath: '品牌素材 2026', size: 0, dir: true, received: 0, done: true },
      { id: 'df1', name: 'logo.svg', relPath: '品牌素材 2026/logo.svg', size: 284000, dir: false, received: 284000, done: true },
      { id: 'df2', name: 'banner@2x.png', relPath: '品牌素材 2026/banner@2x.png', size: 5760000, dir: false, received: 5760000, done: true },
      { id: 'df3', name: '字体授权.pdf', relPath: '品牌素材 2026/字体授权.pdf', size: 1240000, dir: false, received: 1240000, done: true },
    ],
  });

  state.transfers.set('demo-transfer-2', {
    id: 'demo-transfer-2',
    direction: 'in',
    peerKey: 'id:demo-chen',
    peerName: '陈一鸣',
    peerIp: '192.168.31.27',
    status: 'active',
    totalBytes: 1288490188,
    doneBytes: 486539264,
    totalFiles: 1,
    totalDirs: 0,
    totalEntries: 1,
    rootName: '产品演示 4K.mp4',
    isFolder: false,
    completedFiles: 0,
    speed: 12.4 * 1024 * 1024,
    root: '/home/spirithuang/Downloads/飞鸽接收',
    error: null,
    createdAt: now - 1000 * 48,
    updatedAt: now,
    files: [
      { id: 'df4', name: '产品演示 4K.mp4', relPath: '产品演示 4K.mp4', size: 1288490188, dir: false, received: 486539264, done: false },
    ],
  });

  state.unread.set('id:demo-chen', 2);
  state.active = 'id:demo-lin';
  state.activePeer = state.peers[0];
  state.version = '1.7.0';
  renderAll();
  renderMessages(true);
}

document.addEventListener('DOMContentLoaded', init);
