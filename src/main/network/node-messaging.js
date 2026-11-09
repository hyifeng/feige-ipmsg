'use strict';

const { NodeCore } = require('./node-core');
const { now, uid } = require('./utils');

class MessagingNode extends NodeCore {
  async sendText(peerKey, text) {
    if (!this.online) throw new Error('已下线，上线后才能发送消息');
    const peer = this._requirePeer(peerKey);
    const body = String(text == null ? '' : text).replace(/\0/g, '');
    if (!body.trim()) throw new Error('消息不能为空');
    if (Buffer.byteLength(body) > 6000) throw new Error('消息太长了');
    if (!peer.online) throw new Error('对方已离线');

    // 所有聊天内容都必须经过加密会话。没有会话时先建立临时会话，
    // 建立完成后再真正发送，绝不降级为签名明文。
    let sent = false;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !sent; attempt += 1) {
      await this._ensureSecure(peerKey);
      const message = {
        id: `${peerKey}:${this.sessionId}:${uid()}:out`,
        peerKey,
        text: body,
        at: now(),
        direction: 'out',
        status: 'sent',
        secure: true,
      };
      try {
        await this.secure.send(peerKey, {
          type: 'text',
          id: message.id,
          text: body,
          at: message.at,
        });
        sent = true;
        this.emit('message', message);
        return message;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('加密会话不可用');
  }
}

module.exports = { MessagingNode };
