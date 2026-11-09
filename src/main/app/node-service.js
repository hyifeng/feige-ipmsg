'use strict';

const os = require('node:os');

const { FeigeNode } = require('../network');
const { emit, selfInfo, contactInfo, decorateContact, friendlyNetworkError } = require('./info');
const { notify } = require('./shell');
const {
  persistMessage,
  incomingFileMessage,
  transferMessageId,
  fileStateFromTransfer,
  imageStatusPatch,
  sendPathsWithHistory,
} = require('./history-messages');

class NodeService {
  constructor(ctx) {
    this.ctx = ctx;
    this.transferStatusSeen = new Map();
  }

  display(peerKey, claimed = '') {
    const live = this.ctx.node && this.ctx.node.peers.get(peerKey);
    return contactInfo(this.ctx, peerKey, live && live.user ? live.user : claimed);
  }

  displayName(peerKey, claimed = '') {
    return this.display(peerKey, claimed).label;
  }

  decorate(event) {
    if (!event || !event.peerKey) return event;
    return { ...event, display: this.display(event.peerKey, event.peerName) };
  }

  async start() {
    const ctx = this.ctx;
    if (ctx.node) {
      const previous = ctx.node;
      ctx.node = null;
      await previous.stop().catch(() => {});
    }

    const current = new FeigeNode({
      port: ctx.settings.port,
      discoveryPort: ctx.discoveryPort,
      user: ctx.settings.nickname,
      host: os.hostname().split('.')[0],
      identityKey: ctx.identity,
      secureStore: ctx.secureStore,
      downloadDir: ctx.settings.downloadDir,
      autoAccept: ctx.settings.autoAccept,
      online: ctx.settings.online,
      lanEnabled: ctx.settings.lanEnabled !== false,
      hubUrl: ctx.settings.hubEnabled ? ctx.settings.hubUrl : '',
      stunUrl: ctx.settings.hubStunUrl || '',
    });
    ctx.node = current;
    this.wire(current);

    try {
      await current.start();
    } catch (err) {
      ctx.node = null;
      await current.stop().catch(() => {});
      throw err;
    }
    return current;
  }

  networkChanged() {
    if (this.ctx.node && typeof this.ctx.node.networkChanged === 'function') {
      this.ctx.node.networkChanged();
    }
  }

  async stop() {
    const current = this.ctx.node;
    this.ctx.node = null;
    if (current && current.started) await current.stop().catch(() => {});
  }

  wire(current) {
    const ctx = this.ctx;
    current.on('peers', (peers) => emit(ctx, 'peers', peers.map((peer) => decorateContact(ctx, peer))));
    current.on('self', () => emit(ctx, 'self', selfInfo(ctx)));
    current.on('message', (message) => {
      const decorated = this.decorate(message);
      persistMessage(ctx, message);
      emit(ctx, 'message', decorated);
      if (message.direction === 'in') {
        const body = message.kind === 'image' ? '发送了一张图片' : String(message.text || '').slice(0, 120);
        notify(ctx, this.displayName(message.peerKey, message.peerName), body);
      }
    });
    current.on('ack', (ack) => {
      if (ctx.history) {
        ctx.history.patch(ack.peerKey, ack.messageId, { status: 'read' })
          .catch((error) => console.error('[feige] 更新聊天回执失败', error));
      }
      emit(ctx, 'ack', ack);
    });
    current.on('offer', (offer) => {
      if (ctx.history) {
        ctx.history.append(incomingFileMessage(offer), offer.peer)
          .catch((error) => console.error('[feige] 保存文件消息失败', error));
      }
      emit(ctx, 'offer', this.decorate(offer));
      const count = offer.totalFiles || offer.files.filter((file) => !file.dir).length;
      notify(ctx, '收到文件', `${this.displayName(offer.peerKey, offer.peerName)} 发来 ${count} 个文件`);
    });
    current.on('offer-closed', (info) => {
      if (ctx.history) {
        ctx.history.patch(info.peerKey, `offer:${info.id}`, {
          fileState: { status: info.reason === 'declined' ? 'declined' : 'canceled' },
        }).catch((error) => console.error('[feige] 更新文件状态失败', error));
      }
      emit(ctx, 'offer-closed', info);
    });
    current.on('transfer', (transfer) => {
      if (ctx.history) {
        const previous = this.transferStatusSeen.get(transfer.id);
        if (previous !== transfer.status) {
          this.transferStatusSeen.set(transfer.id, transfer.status);
          if (transfer.image) {
            const imageId = `${transfer.direction === 'in' ? 'image-in' : 'image-out'}:${transfer.id}`;
            const patch = imageStatusPatch(transfer);
            ctx.history.patch(transfer.peerKey, imageId, patch)
              .catch((error) => console.error('[feige] 更新图片状态失败', error));
            emit(ctx, 'image-update', { peerKey: transfer.peerKey, messageId: imageId, patch });
          } else {
            ctx.history.patch(transfer.peerKey, transferMessageId(transfer), {
              fileState: fileStateFromTransfer(transfer),
            }).catch((error) => console.error('[feige] 更新文件状态失败', error));
          }
        }
      }
      emit(ctx, 'transfer', this.decorate(transfer));
    });
    current.on('transfer-done', (info) => {
      emit(ctx, 'transfer-done', this.decorate(info));
      if (info.direction === 'in' && !info.image) {
        notify(ctx, '文件已接收', `${this.displayName(info.peerKey, info.peerName)} 发来的文件已保存到 ${info.root || ctx.settings.downloadDir}`);
      }
    });
    current.on('transfer-closed', (info) => emit(ctx, 'transfer-closed', info));
    current.on('transfer-error', (info) => emit(ctx, 'transfer-error', info));
    current.on('secure-pending', (info) => emit(ctx, 'secure-pending', info));
    current.on('secure-sas', (info) => {
      emit(ctx, 'secure-sas', info);
      if (!info || !info.temporary) {
        notify(ctx, '认证请求', `${this.displayName(info.peerKey, info.peerName)} 请求认证身份，请核对安全码`);
      }
    });
    current.on('secure-peer-confirmed', (info) => emit(ctx, 'secure-peer-confirmed', info));
    current.on('secure-authenticated', (info) => {
      emit(ctx, 'secure-authenticated', info);
      notify(ctx, '身份认证完成', `已与 ${this.displayName(info.peerKey, info.peerName)} 完成身份认证`);
    });
    current.on('secure-up', (info) => {
      emit(ctx, 'secure-up', info);
      if (info && info.mode === 'resume') {
        notify(ctx, '身份认证已恢复', `已恢复与 ${this.displayName(info.peerKey, info.peerName)} 的身份认证`);
      }
    });
    current.on('secure-down', (info) => {
      emit(ctx, 'secure-down', info);
      if (info && info.wasActive) {
        if (!info.temporary) {
          notify(ctx, '会话已断开', `${this.displayName(info.peerKey, info.peerName)}：${info.reason || '连接已断开'}`);
        }
      } else if (info && info.pairingRemoved) {
        notify(ctx, '认证校验失败', `${this.displayName(info.peerKey, info.peerName)}：${info.reason || '认证密钥无效，会话已断开'}`);
      } else if (info && info.auto) {
        notify(ctx, '认证恢复失败', `${this.displayName(info.peerKey, info.peerName)}：${info.reason || '自动恢复认证失败'}`);
      }
    });
    current.on('secure-warning', (info) => {
      emit(ctx, 'secure-warning', info);
      if (info && info.code === 'no-pairing') {
        notify(ctx, '认证恢复失败', `${this.displayName(info.peerKey, info.peerName)}：本机没有认证密钥，无法自动恢复身份认证`);
      }
    });
    current.on('discovery-status', (info) => emit(ctx, 'discovery-status', info));
    current.on('error', (err) => emit(ctx, 'error', { message: friendlyNetworkError(ctx, err) }));
  }

  sendPathsWithHistory(peerKey, paths, caption = '') {
    return sendPathsWithHistory(this.ctx, peerKey, paths, caption);
  }
}

module.exports = { NodeService };
