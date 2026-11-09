const state = {
  self: {
    id: '',
    nickname: '飞鸽用户',
    host: 'linux',
    port: 24250,
    addresses: [],
    online: true,
    ready: false,
  },
  settings: {
    nickname: '飞鸽用户',
    port: 24250,
    downloadDir: '',
    autoAccept: false,
    sound: true,
    theme: 'dark',
    online: true,
  },
  peers: [],
  historyPeers: [],
  contacts: new Map(),
  messages: new Map(),
  historyLoaded: new Set(),
  historyLoading: new Set(),
  historyMore: new Map(),
  historySearchTimer: null,
  historyEpoch: 0,
  securePeers: new Map(),
  securePairings: new Set(),
  securePending: new Map(),
  securePrompts: new Map(),
  secureWaiting: new Set(),
  secureWarnings: new Map(),
  securePaused: new Map(),
  secureQueue: [],
  transfers: new Map(),
  offers: new Map(),
  unread: new Map(),
  active: null,
  activePeer: null,
  filter: '',
  panelOpen: false,
  modal: null,
  fatal: '',
  version: '1.0.0',
  demo: false,
  sidebarDragDepth: 0,
};

const dom = {};

let notificationAudio = null;

function playNotificationSound() {
  if (state.settings.sound === false) return;
  try {
    if (!notificationAudio) {
      notificationAudio = new Audio('../../assets/notify.wav');
      notificationAudio.preload = 'auto';
      notificationAudio.volume = 0.65;
    }
    if (notificationAudio.readyState > 0) notificationAudio.currentTime = 0;
    const result = notificationAudio.play();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* 没有可用的音频输出 */
  }
}

const params = new URLSearchParams(location.search);
const isDemo = params.has('demo');
const wantPanel = params.get('panel') === '1';
const forcedTheme = params.get('theme');

function mergeSelf(info) {
  if (!info) return;
  state.self = {
    ...state.self,
    id: info.id || state.self.id,
    fingerprint: info.fingerprint || state.self.fingerprint || '',
    nickname: info.nickname || info.user || state.self.nickname,
    host: info.host || state.self.host,
    port: info.port || state.self.port,
    addresses: Array.isArray(info.addresses) ? info.addresses : state.self.addresses,
    online: info.online !== false,
    ready: info.ready != null ? !!info.ready : (info.started != null ? !!info.started : state.self.ready),
  };
}

export { state, dom, playNotificationSound, params, isDemo, wantPanel, forcedTheme, mergeSelf };
