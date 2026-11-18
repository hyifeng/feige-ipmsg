import { t } from '../i18n/index.js';

// 主进程的断开原因目前是稳定的中文协议值；显示时映射到 i18n key。
const REASON_KEYS = {
  '用户取消': 'secure.reason.userCanceled',
  '用户下线': 'secure.reason.selfOffline',
  '节点停止': 'secure.reason.nodeStopped',
  '连接超时': 'secure.reason.timeout',
  '对方取消': 'secure.reason.peerCanceled',
  '对方已解除认证': 'secure.reason.peerRevoked',
  '加密连接已断开': 'secure.reason.encryptedClosed',
  '加密握手超时': 'secure.reason.handshakeTimeout',
  '加密握手格式错误': 'secure.reason.handshakeFormat',
  '加密握手模式无效': 'secure.reason.handshakeMode',
  '加密握手身份无效': 'secure.reason.handshakeIdentity',
  '双方同时建立加密会话': 'secure.reason.simultaneous',
  '已有加密会话正在建立': 'secure.reason.busy',
  '本机没有保存该联系人的加密密钥': 'secure.reason.noPairing',
  '本机已有该联系人的认证记录，请在本机选择重新认证': 'secure.reason.pairingExists',
  '加密协议版本不匹配': 'secure.reason.protocolMismatch',
  '加密消息校验失败': 'secure.reason.messageCheckFailed',
  '握手公钥无效': 'secure.reason.invalidHandshakeKey',
  '缺少对方承诺': 'secure.reason.missingCommitment',
  '哈希承诺校验失败': 'secure.reason.commitmentFailed',
  '认证前缺少握手签名': 'secure.reason.missingSignature',
  '加密认证模式不匹配': 'secure.reason.authModeMismatch',
  '加密密钥校验失败': 'secure.reason.keyCheckFailed',
  '应用离线': 'secure.reason.appOffline',
  '加密会话已断开': 'secure.reason.sessionClosedEncrypted',
  '加密会话未建立': 'secure.reason.sessionNotEstablished',
  '连接失败': 'secure.reason.connectionFailed',
  '握手发送失败': 'secure.reason.handshakeSendFailed',
  '确认发送失败': 'secure.reason.confirmSendFailed',
  '传输层未提供 connectStream': 'secure.reason.noConnectStream',
  '会话已断开': 'secure.reason.sessionClosed',
};

function secureReasonText(reason) {
  const value = String(reason || '');
  const key = REASON_KEYS[value];
  return key ? t(key) : value;
}

export { REASON_KEYS, secureReasonText };
