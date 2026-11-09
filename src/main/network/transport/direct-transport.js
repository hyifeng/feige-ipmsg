'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { RTCPeerConnection } = require('werift');
const { identityOfPeerKey } = require('../../../shared/protocol');
const { DataChannelStream } = require('./data-channel-stream');

const MAX_CONTROL_QUEUE = 256;

/**
 * WebRTC 直连传输。
 *
 * 服务器只负责转发 offer / answer / ice；连接建立后数据不再经过服务器。
 */
class DirectTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.identity = String(options.identity || '');
    this.getPeer = options.getPeer || (() => null);
    this.signaling = options.signaling || null;
    this.stunUrl = options.stunUrl || '';
    this.online = options.online !== false;
    this.connections = new Map();
    this.pendingCandidates = new Map();
    this.started = false;
    this.heartbeatTimer = null;
    this.onSignal = (signal) => this._handleSignal(signal);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (this.signaling && typeof this.signaling.on === 'function') {
      this.signaling.on('signal', this.onSignal);
    }
    this.heartbeatTimer = setInterval(() => {
      if (!this.online) return;
      for (const [peerKey, record] of this.connections) {
        if (record.pc.connectionState === 'connected') {
          const peer = this.getPeer(peerKey) || {};
          this.emit('peer', {
            source: 'direct',
            key: peerKey,
            user: peer.user || '未知联系人',
            host: peer.host || '',
            online: true,
          });
        }
      }
    }, 10000);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  async stop() {
    this.started = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.signaling && typeof this.signaling.removeListener === 'function') {
      this.signaling.removeListener('signal', this.onSignal);
    }
    for (const peerKey of [...this.connections.keys()]) this._cleanup(peerKey, '本地停止');
  }

  closePeer(peerKey) {
    this._cleanup(peerKey, 'peer-closed');
  }

  // 路径故障后强制丢弃旧 ICE 记录。旧连接可能仍停在 disconnected，
  // 但 DataChannel 已不可用；直接复用会让后续 resume 反复超时。
  restartPeer(peerKey) {
    this._cleanup(peerKey, 'path-restart');
  }

  hasPeer(peerKey) {
    return this.connections.has(peerKey);
  }

  setOnline(online) {
    this.online = !!online;
    if (!this.online) {
      for (const peerKey of [...this.connections.keys()]) this._cleanup(peerKey, '用户下线');
    }
  }

  sendControl(peerKey, packet) {
    if (!this.online || packet == null) return false;
    const peer = this.getPeer(peerKey);
    if (!peer || !peer.online) return false;
    const record = this._ensureConnection(peerKey);
    if (!record) return false;
    if (record.control && record.control.readyState === 'open') {
      try {
        record.control.send(Buffer.from(packet));
        return true;
      } catch (error) {
        this.emit('warn', error);
        return false;
      }
    }
    if (record.controlQueue.length < MAX_CONTROL_QUEUE) {
      record.controlQueue.push(Buffer.from(packet));
    }
    return true;
  }

  connectStream(peerKey, purpose, meta = {}) {
    if (!this.online) throw new Error('已下线');
    const peer = this.getPeer(peerKey);
    if (!peer || !peer.online) throw new Error('对方不在线');
    const record = this._ensureConnection(peerKey);
    if (!record) throw new Error('无法建立直连');
    const id = crypto.randomBytes(6).toString('hex');
    const channel = record.pc.createDataChannel(`feige:stream:${purpose}:${id}`, { ordered: true });
    const stream = new DataChannelStream(channel, { peerKey, purpose });
    record.streams.set(id, stream);
    stream.once('close', () => record.streams.delete(id));
    return stream;
  }

  networkChanged() {
    for (const peerKey of [...this.connections.keys()]) {
      this._cleanup(peerKey, '网络地址变化');
    }
    this.pendingCandidates.clear();
  }

  _ensureConnection(peerKey, options = {}) {
    if (!this.online) return null;
    let record = this.connections.get(peerKey);
    if (record) {
      const state = record.pc.connectionState;
      const controlOpen = !!(record.control && record.control.readyState === 'open');
      const stale = state !== 'connected' && !controlOpen
        && Date.now() - (record.createdAt || 0) > 45000;
      if (state === 'failed' || state === 'closed' || stale) {
        this._cleanup(peerKey, state === 'failed' || state === 'closed' ? `retry-${state}` : 'stale-setup');
        record = null;
      } else {
        // 对端重启后旧连接可能停在 connecting/new。再次需要发送时，
        // 非发起方重发 connect，发起方重发 offer，避免旧记录把新连接卡死。
        if (!record.control) {
          if (!record.initiator) this._signal(peerKey, { kind: 'connect' });
          else if (!record.offerStarted) this._createOffer(record);
        }
        return record;
      }
    }
    const peer = this.getPeer(peerKey);
    if ((!peer || !peer.online) && !options.allowUnknown) return null;
    const initiator = this._isInitiator(peerKey);
    record = this._createPeer(peerKey, initiator);
    if (initiator) {
      this._createControl(record);
      this._createOffer(record);
    } else {
      this._signal(peerKey, { kind: 'connect' });
    }
    return record;
  }

  _createPeer(peerKey, initiator) {
    const pc = new RTCPeerConnection({
      iceServers: this.stunUrl ? [{ urls: this.stunUrl }] : [],
      iceUseIpv4: true,
      iceUseIpv6: true,
    });
    const record = {
      peerKey,
      pc,
      initiator,
      control: null,
      controlQueue: [],
      streams: new Map(),
      offerStarted: false,
      remoteOffer: false,
      remoteAnswer: false,
      closed: false,
      createdAt: Date.now(),
    };
    this.connections.set(peerKey, record);

    pc.onDataChannel.subscribe((channel) => this._onDataChannel(record, channel));
    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      this._signal(peerKey, { kind: 'ice', candidate: candidate.toJSON ? candidate.toJSON() : candidate });
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
        record.disconnectTimer = null;
        const peer = this.getPeer(peerKey) || {};
        this.emit('peer', {
          source: 'direct',
          key: peerKey,
          user: peer.user || '未知联系人',
          host: peer.host || '',
          online: true,
        });
      } else if (state === 'failed' || state === 'closed') {
        this._cleanup(peerKey, state);
      } else if (state === 'disconnected') {
        if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
        record.disconnectTimer = setTimeout(() => {
          if (!record.closed && record.pc.connectionState === 'disconnected') {
            this._cleanup(peerKey, 'disconnected-timeout');
          }
        }, 15000);
        if (typeof record.disconnectTimer.unref === 'function') record.disconnectTimer.unref();
      }
    });
    return record;
  }

  _createControl(record) {
    if (record.control || record.closed) return;
    const channel = record.pc.createDataChannel('feige:control', { ordered: true });
    this._attachControl(record, channel);
  }

  _attachControl(record, channel) {
    record.control = channel;
    channel.bufferedAmountLowThreshold = 64 * 1024;
    channel.onMessage.subscribe((data) => {
      this.emit('control', record.peerKey, Buffer.isBuffer(data) ? data : Buffer.from(String(data)), {
        source: 'direct',
      });
    });
    channel.stateChange.subscribe((state) => {
      if (state === 'open') this._flushControl(record);
      else if (state === 'closed') this._cleanup(record.peerKey, 'control-closed');
    });
    if (channel.readyState === 'open') setImmediate(() => this._flushControl(record));
  }

  _flushControl(record) {
    if (!record.control || record.control.readyState !== 'open') return;
    while (record.controlQueue.length) {
      const packet = record.controlQueue[0];
      try {
        record.control.send(packet);
        record.controlQueue.shift();
      } catch (error) {
        this.emit('warn', error);
        return;
      }
    }
  }

  _onDataChannel(record, channel) {
    if (record.closed) {
      try {
        channel.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (channel.label === 'feige:control') {
      if (record.control) {
        channel.close();
        return;
      }
      this._attachControl(record, channel);
      return;
    }
    const match = /^feige:stream:([^:]+):/.exec(String(channel.label || ''));
    if (!match) {
      channel.close();
      return;
    }
    const purpose = match[1];
    const stream = new DataChannelStream(channel, { peerKey: record.peerKey, purpose });
    this.emit('stream', stream, {
      transport: 'direct',
      peerKey: record.peerKey,
      purpose,
    });
  }

  async _createOffer(record) {
    if (record.offerStarted || record.closed) return;
    record.offerStarted = true;
    try {
      const offer = await record.pc.createOffer();
      await record.pc.setLocalDescription(offer);
      const local = record.pc.localDescription;
      if (!local || !local.sdp) throw new Error('创建 offer 失败');
      this._signal(record.peerKey, { kind: 'offer', sdp: local.sdp });
    } catch (error) {
      this.emit('warn', error);
      this._cleanup(record.peerKey, 'offer-failed');
    }
  }

  _handleSignal(signal) {
    if (!this.online) return;
    if (!signal || !signal.from || typeof signal.payload !== 'string') return;
    let payload;
    try {
      payload = JSON.parse(signal.payload);
    } catch {
      return;
    }
    if (!payload || typeof payload.kind !== 'string') return;
    const from = String(signal.from);
    const peerKey = from.startsWith('id:') ? from : `id:${from}`;
    this._handleSignalPayload(peerKey, payload).catch((error) => this.emit('warn', error));
  }

  async _handleSignalPayload(peerKey, payload) {
    if (!peerKey.startsWith('id:')) return;
    let record = this.connections.get(peerKey);

    if (payload.kind === 'connect') {
      if (!this._isInitiator(peerKey)) return;
      // 对端显式 connect 表示它那边没有可用连接（或刚刚重建）。
      // 旧的 offerStarted 记录不能继续复用，否则新 ICE 永远不会开始。
      if (record) {
        this._cleanup(peerKey, 'remote-connect');
        record = null;
      }
      record = this._ensureConnection(peerKey, { allowUnknown: true });
      return;
    }

    if (payload.kind === 'offer') {
      // 对端重启 DirectTransport（例如 LAN 断链后强制重建 ICE）会发送
      // 新的 offer。旧记录上的 remoteOffer 不能吞掉它，否则新连接永远
      // 建不起来，secure resume 会反复超时。
      if (record && record.remoteOffer) {
        this._cleanup(peerKey, 'remote-restart');
        record = null;
      }
      if (!record) record = this._createPeer(peerKey, false);
      record.remoteOffer = true;
      await record.pc.setRemoteDescription({ type: 'offer', sdp: String(payload.sdp || '') });
      const pending = this.pendingCandidates.get(peerKey) || [];
      this.pendingCandidates.delete(peerKey);
      for (const candidate of pending) {
        await this._addRemoteCandidate(record, candidate);
      }
      const answer = await record.pc.createAnswer();
      await record.pc.setLocalDescription(answer);
      const local = record.pc.localDescription;
      if (!local || !local.sdp) throw new Error('创建 answer 失败');
      this._signal(peerKey, { kind: 'answer', sdp: local.sdp });
      if (!record.control) {
        // 等待发起方的控制通道；若没有，DataChannel 仍可用于业务流。
      }
      return;
    }

    if (!record) {
      if (payload.kind === 'ice' && payload.candidate) {
        const pending = this.pendingCandidates.get(peerKey) || [];
        if (pending.length < 128) pending.push(payload.candidate);
        this.pendingCandidates.set(peerKey, pending);
      }
      return;
    }

    if (payload.kind === 'answer') {
      if (record.remoteAnswer) return;
      record.remoteAnswer = true;
      await record.pc.setRemoteDescription({ type: 'answer', sdp: String(payload.sdp || '') });
      const pending = this.pendingCandidates.get(peerKey) || [];
      this.pendingCandidates.delete(peerKey);
      for (const candidate of pending) {
        await this._addRemoteCandidate(record, candidate);
      }
      return;
    }

    if (payload.kind === 'ice' && payload.candidate) {
      if (!record.remoteOffer && !record.remoteAnswer) {
        const pending = this.pendingCandidates.get(peerKey) || [];
        if (pending.length < 128) pending.push(payload.candidate);
        this.pendingCandidates.set(peerKey, pending);
        return;
      }
      await this._addRemoteCandidate(record, payload.candidate);
    }
  }

  async _addRemoteCandidate(record, candidate) {
    if (!record || !candidate || record.closed) return;
    // 旧连接重启后仍可能有 ICE 候选在途。候选的 ufrag 与当前远端
    // SDP 不一致时直接丢弃，避免污染新连接。
    const remote = record.pc.remoteDescription;
    const sdp = remote && remote.sdp ? String(remote.sdp) : '';
    const match = /a=ice-ufrag:([^\r\n]+)/.exec(sdp);
    const expected = match ? match[1].trim() : '';
    const actual = candidate.usernameFragment || candidate.username_fragment || '';
    if (expected && actual && actual !== expected) return;
    await record.pc.addIceCandidate(candidate).catch(() => {});
  }

  _isInitiator(peerKey) {
    return this.identity < identityOfPeerKey(peerKey);
  }

  _signal(peerKey, payload) {
    if (!this.signaling || typeof this.signaling.sendSignal !== 'function') return;
    this.signaling.sendSignal(peerKey, JSON.stringify(payload));
  }

  _cleanup(peerKey, reason) {
    const record = this.connections.get(peerKey);
    if (!record) return;
    this.connections.delete(peerKey);
    this.pendingCandidates.delete(peerKey);
    record.closed = true;
    if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
    record.disconnectTimer = null;
    record.controlQueue = [];
    for (const stream of record.streams.values()) {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
    }
    record.streams.clear();
    try {
      record.pc.close().catch(() => {});
    } catch {
      /* ignore */
    }
    this.emit('offline', { source: 'direct', key: peerKey, reason });
  }
}

module.exports = { DirectTransport };
