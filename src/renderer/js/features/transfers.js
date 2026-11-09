import { escapeHtml, fileInfo, formatBytes, progressOf, relativeTime, transferDetails, transferShortState } from '../core/format.js';
import { displayFor } from '../core/contacts.js';
import { icon } from '../core/icons.js';
import { dom, state } from '../core/state.js';

function fileMessageHtml(message) {
  const transfer = message.transferId ? state.transfers.get(message.transferId) : null;
  const offer = message.offerId ? state.offers.get(message.offerId) : null;
  const files = transfer && transfer.files && transfer.files.length ? transfer.files : (message.files || []);
  const totalFiles = transfer ? transfer.totalFiles : offer ? offer.totalFiles : message.totalFiles;
  const totalDirs = transfer ? transfer.totalDirs : offer ? offer.totalDirs : message.totalDirs;
  const totalEntries = transfer ? transfer.totalEntries : offer ? offer.totalEntries : message.totalEntries;
  const totalBytes = transfer ? transfer.totalBytes : offer ? offer.totalBytes : message.totalBytes;
  const fileState = message.fileState;

  const first = files[0] || {};
  const firstTop = String(first.relPath || first.name || '文件').split('/')[0];
  const isFolder = transfer ? !!transfer.isFolder : offer ? !!offer.isFolder : !!message.isFolder;
  const rootName = (transfer && transfer.rootName)
    || (offer && offer.rootName)
    || message.rootName
    || firstTop;
  const title = isFolder
    ? rootName
    : (totalEntries > 1 ? `${first.name || '文件'} 等 ${totalEntries} 项` : (first.name || '文件'));
  const info = fileInfo(title, isFolder);

  let percent = 0;
  let stateLabel = '待接收';
  let sub = `${totalFiles} 个文件${totalDirs ? ` · ${totalDirs} 个空文件夹` : ''} · ${formatBytes(totalBytes)}`;
  let error = false;
  let pending = false;

  if (transfer) {
    percent = progressOf(transfer);
    stateLabel = transferShortState(transfer);
    sub = transferDetails(transfer);
    error = transfer.status === 'error';
  } else if (offer && !offer.accepted) {
    pending = true;
    stateLabel = '待接收';
  } else if (fileState) {
    const status = fileState.status;
    percent = status === 'done'
      ? 100
      : fileState.totalBytes > 0
        ? Math.min(99, Math.round(((fileState.doneBytes || 0) / fileState.totalBytes) * 100))
        : 0;
    error = status === 'error';
    if (status === 'done') {
      stateLabel = message.direction === 'out' ? '已发送' : '已接收';
      sub = `${formatBytes(fileState.totalBytes)} · ${fileState.totalFiles || 0} 个文件`;
    } else if (status === 'pending') {
      stateLabel = '未接收';
      sub = '传输请求未处理';
    } else if (status === 'waiting') {
      stateLabel = '未完成';
      sub = '等待接收';
    } else if (status === 'active') {
      stateLabel = '已中断';
      sub = '上次传输中断';
    } else if (status === 'declined') {
      stateLabel = message.direction === 'out' ? '被拒绝' : '已拒绝';
      sub = '传输请求被拒绝';
    } else if (status === 'canceled') {
      stateLabel = '已取消';
      sub = '传输已取消';
    } else if (status === 'error') {
      stateLabel = '失败';
      sub = fileState.error || '传输失败';
    } else {
      stateLabel = '历史记录';
      sub = formatBytes(fileState.totalBytes);
    }
  } else if (message.canceled) {
    stateLabel = '已取消';
    sub = '对方取消了传输请求';
  } else if (message.declined) {
    stateLabel = '已拒绝';
    sub = '传输请求已拒绝';
  }

  const infoLabel = info.svg ? icon('folder', 19) : escapeHtml(info.label);
  const pendingActions = pending ? `
    <div class="offer-actions" data-offer-actions>
      <button class="mini-btn primary" data-accept-offer="${escapeHtml(offer.id)}">接收</button>
      <button class="mini-btn" data-decline-offer="${escapeHtml(offer.id)}">拒绝</button>
    </div>` : '';
  const historyRoot = !transfer && !offer && fileState
    && fileState.status === 'done' && message.direction === 'in'
    ? fileState.root
    : null;
  const openRoot = transfer && transfer.status === 'done' && transfer.direction === 'in' && transfer.root
    ? transfer.root
    : historyRoot;
  const openAction = openRoot
    ? `<div class="offer-actions"><button class="mini-btn" data-open-root="${escapeHtml(openRoot)}">${icon('folder', 13)}<span>打开文件夹</span></button></div>`
    : '';

  return `
    <div class="file-msg" data-file-msg="${escapeHtml(message.id)}" data-transfer-id="${transfer ? escapeHtml(transfer.id) : ''}">
      <div class="file-card">
        <div class="file-icon ${info.cls}">${infoLabel}</div>
        <div class="file-main">
          <div class="file-name" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          <div class="file-sub" data-file-sub>${escapeHtml(sub)}</div>
          <div class="file-bar ${error ? 'error' : ''}"><i data-file-bar style="width:${percent}%"></i></div>
        </div>
        <div class="file-side">
          <span class="file-pct" data-file-pct>${transfer || fileState ? `${percent}%` : '—'}</span>
          <span class="file-state" data-file-state>${escapeHtml(stateLabel)}</span>
        </div>
      </div>
      ${pendingActions}
      ${openAction}
    </div>`;
}

function updateFileCards(transfer) {
  if (!transfer || !transfer.id) return;
  const nodes = document.querySelectorAll(`[data-transfer-id="${transfer.id}"]`);
  for (const card of nodes) {
    const sub = card.querySelector('[data-file-sub]');
    const bar = card.querySelector('[data-file-bar]');
    const pct = card.querySelector('[data-file-pct]');
    const label = card.querySelector('[data-file-state]');
    if (sub) sub.textContent = transferDetails(transfer);
    if (bar) bar.style.width = `${progressOf(transfer)}%`;
    if (pct) pct.textContent = `${progressOf(transfer)}%`;
    if (label) label.textContent = transferShortState(transfer);
    card.querySelector('.file-bar')?.classList.toggle('error', transfer.status === 'error');
    card.querySelector('[data-offer-actions]')?.remove();
  }
}

function renderTransfers() {
  renderTransferBadge();
  if (!state.panelOpen) return;

  const transfers = [...state.transfers.values()];
  const pendingOffers = [...state.offers.values()].filter((offer) => !offer.accepted);
  const active = transfers
    .filter((transfer) => transfer.status === 'active' || transfer.status === 'waiting')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const finished = transfers
    .filter((transfer) => !(transfer.status === 'active' || transfer.status === 'waiting'))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 24);

  const cards = [
    ...pendingOffers.map(pendingOfferCard),
    ...active.map(transferCard),
  ];

  let html = '';
  if (cards.length) {
    html += `<div class="transfer-section">进行中 · ${cards.length}</div>${cards.join('')}`;
  }
  if (finished.length) {
    html += `<div class="transfer-section">最近完成</div>${finished.map(transferCard).join('')}`;
  }
  if (!html) {
    html = `
      <div class="panel-empty">
        <span class="ico">${icon('inbox', 24)}</span>
        <b>暂无传输任务</b>
        <small>发送或接收的文件会出现在这里<br>支持文件与整个文件夹</small>
      </div>`;
  }

  dom.transferList.innerHTML = html;
  dom.transferSummary.textContent = cards.length || finished.length
    ? `${cards.length} 个进行中 · ${finished.length} 个已完成`
    : '暂无传输';
}

function pendingOfferCard(offer) {
  const files = offer.files || [];
  const first = files[0] || {};
  const top = String(first.relPath || first.name || '文件').split('/')[0];
  const title = offer.isFolder
    ? (offer.rootName || top)
    : (offer.totalEntries > 1 ? `${first.name || top} 等 ${offer.totalEntries} 项` : (first.name || top));
  const total = offer.totalBytes;
  return `
    <div class="transfer-card">
      <div class="tc-head">
        <span class="tc-icon in">${icon('download', 16)}</span>
        <div class="tc-main">
          <div class="tc-title">${escapeHtml(title)}</div>
          <div class="tc-sub">${escapeHtml(displayFor(offer.peerKey, offer.peerName).label)} · 传输请求</div>
        </div>
        <button class="tc-action" data-tc-action="offer" data-id="${escapeHtml(offer.id)}" title="接收">${icon('check', 15)}</button>
        <button class="tc-action" data-tc-action="decline" data-id="${escapeHtml(offer.id)}" title="拒绝">${icon('x', 15)}</button>
      </div>
      <div class="tc-bar"><i style="width:0%"></i></div>
      <div class="tc-meta"><span>${offer.totalFiles} 个文件 · ${formatBytes(offer.totalBytes)}</span><span>待确认</span></div>
    </div>`;
}

function transferCard(transfer) {
  const files = transfer.files || [];
  const first = files[0] || {};
  const title = transfer.isFolder && transfer.rootName
    ? transfer.rootName
    : (transfer.totalEntries > 1
      ? `${first.name || '文件'} 等 ${transfer.totalEntries} 项`
      : (first.name || transfer.rootName || '文件'));
  const percent = progressOf(transfer);
  const error = transfer.status === 'error';
  const canCancel = transfer.status === 'waiting' || transfer.status === 'active';
  const canOpen = transfer.direction === 'in' && transfer.status === 'done' && transfer.root;

  let action = '';
  if (canOpen) {
    action = `<button class="tc-action" data-tc-action="open" data-path="${escapeHtml(transfer.root)}" title="打开文件夹">${icon('folder', 15)}</button>`;
  } else if (canCancel) {
    action = `<button class="tc-action" data-tc-action="cancel" data-id="${escapeHtml(transfer.id)}" title="取消传输">${icon('x', 15)}</button>`;
  }

  const metaRight = transfer.status === 'done'
    ? `100% · ${formatBytes(transfer.totalBytes)}`
    : `${percent}% · ${formatBytes(transfer.doneBytes)} / ${formatBytes(transfer.totalBytes)}`;
  let metaLeft = '';
  if (transfer.status === 'done') metaLeft = transfer.direction === 'in' ? '已接收' : '已发送';
  else if (transfer.status === 'active') metaLeft = transfer.speed ? `${formatBytes(transfer.speed)}/s` : '传输中…';
  else if (transfer.status === 'waiting') metaLeft = transfer.direction === 'out' ? '等待对方接收…' : '等待接收';
  else if (transfer.status === 'declined') metaLeft = transfer.direction === 'in' ? '已拒绝' : '对方已拒绝';
  else if (transfer.status === 'canceled') metaLeft = '已取消';
  else if (transfer.status === 'error') metaLeft = transfer.error || '传输失败';
  const metaClass = transfer.status === 'done' ? 'ok' : (error || transfer.status === 'declined') ? 'bad' : '';

  return `
    <div class="transfer-card">
      <div class="tc-head">
        <span class="tc-icon ${transfer.direction === 'in' ? 'in' : ''}">${icon(transfer.direction === 'in' ? 'download' : 'upload', 16)}</span>
        <div class="tc-main">
          <div class="tc-title">${escapeHtml(title)}</div>
          <div class="tc-sub">${escapeHtml(displayFor(transfer.peerKey, transfer.peerName).label)} · ${escapeHtml(relativeTime(transfer.updatedAt || transfer.createdAt))}</div>
        </div>
        ${action}
      </div>
      <div class="tc-bar ${error ? 'error' : ''}"><i style="width:${percent}%"></i></div>
      <div class="tc-meta">
        <span class="${metaClass}">${escapeHtml(metaLeft)}</span>
        <span>${escapeHtml(metaRight)}</span>
      </div>
    </div>`;
}

function renderTransferBadge() {
  const active = [...state.transfers.values()].filter((transfer) => transfer.status === 'active' || transfer.status === 'waiting').length;
  const pending = [...state.offers.values()].filter((offer) => !offer.accepted).length;
  const count = active + pending;
  dom.transferBadge.textContent = count > 99 ? '99+' : String(count);
  dom.transferBadge.classList.toggle('is-hidden', count === 0);
  dom.chatTransferBtn?.classList.toggle('active', state.panelOpen);
}

function openPanel() {
  state.panelOpen = true;
  dom.transferPanel.classList.add('open');
  dom.panelScrim.classList.add('open');
  dom.chatTransferBtn?.classList.add('active');
  renderTransfers();
}

function closePanel() {
  state.panelOpen = false;
  dom.transferPanel.classList.remove('open');
  dom.panelScrim.classList.remove('open');
  dom.chatTransferBtn?.classList.remove('active');
}

export { fileMessageHtml, updateFileCards, renderTransfers, pendingOfferCard, transferCard, renderTransferBadge, openPanel, closePanel };
