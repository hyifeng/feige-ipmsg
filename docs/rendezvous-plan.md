# 公网发现与端到端直连方案

> 目标：在保留现有局域网自动发现的基础上，增加一个「公共服务器发现同事」的渠道；公共服务器只负责在线状态、信令和 NAT 穿透协助（STUN），同事之间建立直连后，消息、图片、文件和文件夹全部走点对点通道，不再经过服务器。

## 1. 结论与推荐路线

推荐采用：

- **公共服务器**：WSS 长连接，负责房间内在线状态、WebRTC 信令、STUN；默认不部署/不发放 TURN 中继凭证。
- **直连传输**：WebRTC DataChannel（ICE/STUN 打洞），每个对端一条 PeerConnection，按用途创建多条 DataChannel。
- **局域网优先**：现有 UDP 24250 广播和 TCP 直传保持不变；同一局域网内优先走原路径，服务器只作为补充发现渠道。
- **应用层身份不变**：继续使用现有 Ed25519 身份、签名消息、X25519 + SAS 认证加密；服务器不被信任。
- **失败策略**：没有中继时，对称 NAT / CGNAT / 企业防火墙下可能无法直连；必须给出明确失败提示，不能静默降级到服务器转发。

不推荐直接把现有 TCP 文件通道拿去做「TCP 打洞」：TCP 同时打开成功率受 NAT 实现影响大，企业网络和 CGNAT 下尤其不可靠，后续仍然要补可靠 UDP 传输。WebRTC 已经解决了 ICE、DTLS、可靠有序传输、背压和拥塞控制，工程量反而更小。

## 2. 现状与差距

当前实现的核心链路：

| 能力 | 当前实现 | 跨公网的问题 |
| --- | --- | --- |
| 发现 | UDP 广播 `BR_ENTRY` / `ANSENTRY` / `BR_EXIT`，见 `src/main/network/node-core.js` | 广播不出网段，跨路由器不可见 |
| 文本 / 回执 / 文件报价 / 文件请求 | UDP 24250，发往 `peer.ip:peer.port` | NAT 后没有可达的公网端点 |
| 认证加密握手 | TCP 连接 `peer.ip:peer.port`，见 `src/main/secure/manager.js` | 需要入站 TCP，NAT 默认拦截 |
| 文件清单 / 文件流 | 独立 TCP 连接，见 `src/main/network/node-outgoing.js` / `node-incoming.js` | 同上 |
| 身份与信任 | Ed25519 签名、X25519 认证加密、6 位 SAS | 可直接复用 |
| 协议版本 | `PROTOCOL_VERSION = 5`，字段校验严格 | 新增字段需考虑旧客户端兼容 |

现有代码里所有点对点通信都依赖 `peer.ip` 和 `peer.port`。只要引入一层「路径/传输抽象」，把“发 UDP 包”和“建 TCP 流”替换成可选的 LAN 或 WebRTC 实现，消息和文件业务代码可以大部分保留。

## 3. 总体架构

```text
┌──────────────────────────────┐
│ Renderer                     │
│ 设置 / 联系人来源 / 连接诊断  │
└──────────────┬───────────────┘
               │ IPC
┌──────────────┴───────────────┐
│ NodeService                  │
│  ├─ RendezvousClient (WSS)   │
│  ├─ FeigeNode                │
│  │   ├─ LAN 发现 UDP 24250   │
│  │   ├─ PathManager          │
│  │   │   ├─ LanTransport     │
│  │   │   └─ DirectTransport  │
│  │   ├─ SecureManager        │
│  │   └─ 消息 / 文件业务       │
│  └─ 设置 / 状态事件           │
└──────────────┬───────────────┘
               │ WSS 443（仅信令/在线状态）
               │ UDP 3478（STUN）
      ┌────────┴─────────┐
      │ 公共服务器        │
      │ 房间 / 在线状态   │
      │ 信令转发          │
      │ STUN              │
      └────────┬─────────┘
               │ 仅协助建立连接
      ┌────────┴─────────────────────────┐
      │  WebRTC DataChannel 直连          │
      │  （消息、图片、文件、加密握手）    │
      └──────────────────────────────────┘
```

### 3.1 路径优先级

1. **局域网 LAN**：如果通过 UDP 广播发现同一网段，优先使用现有 UDP + TCP 路径。
2. **公网直连 Direct**：同一房间、但 LAN 不可达时，通过 WebRTC ICE 建立直连。
3. **失败**：显示「已发现同事，但双方网络无法建立直连」，提供重试和诊断；默认不自动走中继。

不建议按“先试 LAN 再试直连”反复切换同一个传输。每个对端维护一个 `preferredPath`，LAN 在线时用 LAN；LAN 超时/失败后再切 Direct，切换时取消或挂起相关传输。

### 3.2 关键流程

```text
A 启动
  ├─ 启动 LAN 节点（原有逻辑）
  └─ 若启用公网发现：连接 WSS -> 挑战应答 -> 加入房间
        ├─ 服务器返回房间在线列表
        └─ 订阅 peer-join / peer-update / peer-leave

B 启动
  └─ 同上

A 看到 B（服务器 presence）
  ├─ 校验 B 的签名资料 / 房间密钥解密
  ├─ 若 LAN 已发现 B：标记 sources=[lan, rendezvous]，priority=lan
  └─ 否则：发起 WebRTC
        ├─ A 创建 offer（含 ICE candidates）
        ├─ 通过服务器转发给 B
        ├─ B 返回 answer，双方 trickle ICE
        ├─ ICE 成功：DataChannel 打开
        └─ 在 DataChannel 上做应用层 path-auth / 加密握手

数据阶段
  ├─ 文本/回执/报价/释放：控制 DataChannel
  ├─ 认证加密握手：独立 DataChannel，复用现有帧协议
  ├─ 文件清单：独立 DataChannel
  └─ 每个文件：独立 DataChannel（最多 3 个并发）

任一路径失效
  ├─ LAN 心跳超时：尝试 Direct
  ├─ Direct ICE 断开：尝试 ICE restart
  ├─ 服务器断线：保留已建立的直连；后台重连
  └─ 所有路径失效：标记离线并提示
```

## 4. 公共服务器设计

### 4.1 职责边界

服务器只做：

- 客户端身份挑战应答；
- 房间加入与在线状态；
- WebRTC offer/answer/ICE 信令转发；
- STUN Binding；
- 可选的房间审计/限流/指标。

服务器不做：

- 不存储聊天记录、文件、图片；
- 不转发业务数据；
- 默认不提供 TURN 中继；
- 不维护全局通讯录，只维护房间内在线状态。

### 4.2 房间与邀请

公共服务器不能是“谁连上就能看到所有人”的开放目录，需要房间/组织隔离。

建议模型：

- 管理员在服务器创建房间，得到 `roomId` 和 `roomToken`（或由管理员生成后注册 token 的哈希）。
- 邀请串包含：服务器地址、`roomId`、`roomToken`、可选的 `contentKey`。
- `roomToken` 只用于服务器鉴权；`contentKey` 只用于客户端加密在线资料和信令 payload，服务器不持有。
- 邀请串建议用高熵随机值，至少 128 bit；不要用“公司名/部门名”之类的可猜字符串。
- 支持过期时间、最大使用次数、手动吊销（后续增强）。

邀请串示例（仅示意）：

```text
feige://join?server=wss%3A%2F%2Frdv.example.com%2Fv1%2Fws
  &room=7f3c...
  &token=...
  &key=...
```

MVP 可以先做“粘贴房间码”，后续再做 `feige://` 深链和二维码。

### 4.3 鉴权

复用现有 Ed25519 身份，不新增账号密码：

```text
Server -> Client: { type: "challenge", nonce, ts }
Client -> Server: {
  type: "hello",
  v: 1,
  identity: "pk1_...",
  roomId,
  roomToken,
  challenge: nonce,
  ts,
  nonce,
  sig: Ed25519(payload)
}
Server -> Client: {
  type: "hello-ok",
  sessionId,
  presenceTtl,
  peers: [signedPresence...]
}
```

服务端校验：

- `sig` 对应 `identity`；
- `roomToken` 对应房间；
- `challenge` 未过期、未重放；
- 连接数/频率限制。

`roomToken` 通过 TLS 传输，服务端可只保存其哈希；不把 token 写日志。

### 4.4 在线状态

```text
Client -> Server: {
  type: "presence",
  identity,
  profile: { user, host, caps, ... },  // 可选：用 contentKey 加密
  ts, nonce, sig
}
Server -> Room: {
  type: "presence",
  identity,
  profile,
  lastSeen,
  ts
}
```

- 心跳 15s，服务端 TTL 45s。
- 服务端只广播“某 identity 在线/离线”，资料由客户端签名或加密，服务端不伪造。
- 客户端校验资料签名/解密，更新联系人。
- 离线：客户端显式 `leave`，或 TTL 到期；服务端广播 `peer-leave`。

### 4.5 信令

```text
Client -> Server: {
  type: "signal",
  from: identity,
  to: identity,
  sessionId,
  kind: "offer" | "answer" | "ice" | "bye" | "ice-restart",
  payload: <SDP/ICE，可选 contentKey 加密>,
  ts, nonce, sig
}
Server -> Client: {
  type: "signal",
  from: identity,
  to: identity,
  sessionId,
  kind,
  payload,
  ts
}
```

服务端只校验：发送者在房间内、签名有效、目标在房间内、帧大小/频率合法；然后按 `to` 转发。`from` 由服务端填写，不能信任客户端自报。

客户端必须校验：`to === 自己`、`from` 是房间成员、签名有效、`sessionId` 与当前连接匹配。即使服务器把 offer 转发给错误的人，应用层 `path-auth` 也会失败。

### 4.6 STUN

- 独立 UDP 3478 提供 STUN Binding。
- 可以用 coturn 只做 STUN，也可以实现一个最小 RFC 5389 STUN 服务。
- 不下发 TURN 凭证；如果部署了 coturn，通过配置/防火墙确保没有可用的 relay 分配。
- 客户端配置：`iceServers: [{ urls: "stun:rdv.example.com:3478" }]`。

### 4.7 服务端技术栈与部署

- Node.js + `ws`；单实例 MVP。
- WSS 由 Caddy/Nginx 终止 TLS，反代到本地 WS 端口。
- 在线状态、房间、连接全部内存保存；进程重启后客户端自动重连。
- Docker Compose：`rendezvous` + `caddy` + 可选 `coturn`。
- 健康检查 `/healthz`；指标 `/metrics`（连接数、房间数、信令数、拒绝数）。
- 日志只记录连接元数据、错误码；不记录 SDP 明文、消息内容、token。
- 限流：每 IP 连接数、每连接消息速率、每房间人数、SDP/ICE 帧大小、房间加入失败次数。
- 扩容：多实例时用 Redis Pub/Sub 或粘性路由；MVP 不做。

容量参考：纯信令 + STUN 的服务器很轻，1 vCPU / 1 GB 内存通常可支撑数百到上千在线客户端；实际取决于心跳频率、房间数和信令频率。数据不经过服务器，所以不需要大带宽。

## 5. 客户端改造

### 5.1 新增模块

```text
src/shared/rendezvous/
  constants.js       协议版本、消息类型、字段上限
  validation.js      消息结构校验
  keys.js            房间 token/内容密钥派生、邀请串编解码
  codec.js           JSON 信封 / 签名 payload

src/main/rendezvous/
  client.js          WSS 连接、重连、心跳、挑战应答
  presence.js        在线状态合并、TTL、离线判断
  signal.js          offer/answer/ICE 队列与转发
  status.js          连接状态、错误码、诊断信息

src/main/network/transport/
  path-manager.js    对端路径选择、优先级、故障切换
  lan-transport.js   现有 UDP/TCP 封装
  direct-transport.js WebRTC PeerConnection 管理
  datachannel-stream.js DataChannel -> Duplex/类 Socket 适配
  stream-session.js  数据流用途、会话绑定、path-auth
```

### 5.2 对端模型

现有 `peer` 结构需要扩展，但保留 `ip` / `port` / `user` / `host` / `online` 兼容字段：

```js
{
  key, identity,
  user, host,
  ip, port,                 // 兼容字段：指向当前首选路径
  online,
  sources: ['lan', 'rendezvous'],
  path: 'lan' | 'direct' | 'none',
  lan: { ip, port, lastSeen, online },
  direct: { state, lastSeen, rtt, iceState },
  lastSeen, firstSeen
}
```

合并原则：

- 按 `identity` 合并，不按昵称/IP；
- LAN 和服务器发现同一个 identity 时只保留一个联系人；
- LAN 资料优先用于显示；服务器资料作为补充；
- 任何一路在线都算在线；
- 显式离线（`BR_EXIT` / `leave`）才标记全局离线，单路超时只标记该来源离线。

### 5.3 传输抽象

目标接口（示意）：

```js
class PeerTransport {
  // 发一个控制包（文本、回执、报价、释放、文件请求）
  sendControl(peerKey, packet)

  // 建立一条可靠字节流
  // purpose: 'secure-handshake' | 'manifest' | 'file'
  connectStream(peerKey, purpose, meta)

  // 收到一条入站流
  onStream(callback) // callback(stream, peerKey)

  closePeer(peerKey)
}
```

`stream` 需要提供现有代码用到的子集：

- `on('data' | 'end' | 'close' | 'error')`
- `write` / `end` / `destroy`
- `pause` / `resume`（可选）
- `setNoDelay` / `setTimeout` / `setKeepAlive`（Direct 适配器可空实现）
- `remoteAddress`（Direct 路径可能没有，业务层不能再依赖它做安全判断）

### 5.4 代码改造点

| 文件 | 改造 |
| --- | --- |
| `src/main/network/node-core.js` | `_onUdp` 拆出 `_onPeerPacket`；`_sendRaw` 改为 `_sendToPeer`；`_onTcp` 拆出 `_handleIncomingStream`；`_upsertPeer` 支持多来源；`_sweepPeers` 按来源超时；`_verifyEntry` 只用于 LAN；新增 `verifyPresence` |
| `src/main/network/node-messaging.js` | `sendText` 的 ACK 等待逻辑保留；发送改走 `_sendToPeer`；`_onSendMessage` 的回执改走 `_sendToPeer` |
| `src/main/network/node-outgoing.js` | `_fetchManifest` 改用 `connectStream`；`_onGetFileData` 改用 `connectStream`；文件流头/尾增加哈希；`net.connect` 全部移除 |
| `src/main/network/node-incoming.js` | `_requestFile` 改走 `_sendToPeer`；`_startIncomingStream` 改用 `stream`；删除/改写 `_sameHost` 依赖；`_sendRelease` 改走路径层 |
| `src/main/network/node-secure.js` | 加密业务事件不变；确认文件/清单走 Direct 流 |
| `src/main/secure/manager.js` | 注入 `connectStream`，移除内部 `net.connect`；`handleIncoming` 接收通用流；`setKeepAlive` 等改为可选调用 |
| `src/main/secure/frame-socket.js` | 接受通用 Duplex；增加 Direct 适配器所需的事件/背压处理 |
| `src/main/app/node-service.js` | 创建/启动/停止 `RendezvousClient`、`DirectTransport`；合并 presence 与 LAN peers；转发状态事件 |
| `src/main/app/settings.js` | 新增 `rendezvous` 配置并加密落盘；sanitize/validate |
| `src/main/app/config.js` | 服务器 URL、STUN、功能开关、测试环境默认值 |
| `src/main/app/ipc/*` / `preload.js` | 新增状态、设置、测试连接、诊断 IPC |
| `src/renderer/features/settings.js` | 公网发现设置、邀请码、连接状态、测试按钮 |
| `src/renderer/features/peers.js` | 显示来源/路径徽标：局域网、公网直连、连接中、失败 |
| `src/renderer/features/events.js` | 处理 rendezvous 状态、路径切换、错误提示 |
| `src/main/contacts/store.js` / `history/store.js` | 可选保存 `lastSource` / `lastPath`，非必需 |

### 5.5 业务流改造细节

#### 文本 / 回执 / 报价 / 释放

- LAN：继续用现有 UDP 包。
- Direct：把同样的 `encodePacket` 字符串通过控制 DataChannel 发送。
- 接收端统一进入 `_onPeerPacket(packet, source)`：
  - LAN 来源：保留 `_addressAllowed` 等校验；
  - Direct 来源：跳过 `addrs` 匹配，但保留签名、recipient、时间戳、nonce、replay 校验。
- 由于控制 DataChannel 是可靠有序的，UDP 丢包/重传逻辑不需要在 Direct 路径上重复实现；现有 ACK 语义保留。

#### 认证加密握手

- `SecureManager.start` 不再直接 `net.connect`，而是 `transport.connectStream(peerKey, 'secure-handshake')`。
- Direct 路径下，发起方创建 label 为 `feige:secure:<sessionId>` 的 DataChannel；接收方在 `ondatachannel` 中拿到流，读取 4 字节头 + `secure-handshake` 头，再交给 `SecureManager.handleIncoming`。
- 现有 `FrameSocket` 的 4 字节长度帧协议不变。
- `session.socket.remoteAddress` 不再可靠；`peerInfo.ip` 使用 presence 资料或 Direct 连接元数据，不用于安全判断。

#### 文件清单

- `_fetchManifest` 在 LAN 下仍然 TCP 连接 `peer.ip:peer.port`；Direct 下创建 `feige:manifest:<transferId>` 数据通道。
- 用同一套 `manifest-request` / `manifest` 签名结构，接收端 `_serveManifest` 从通用流读写。
- `_serveManifest` 里的 `_sameHost(socket.remoteAddress, record.peerIp)` 改为：
  - LAN：保留 IP 校验；
  - Direct：使用流上绑定的 `peerKey` + 签名 header + transferId 校验。

#### 文件流

- 接收方 `_requestFile` 发送文件请求时，LAN 路径仍带 `port`；Direct 路径不需要端口，改为 `transport: 'direct'` 或由发送方根据 `peer.path` 选择。
- 发送方 `_onGetFileData` 用 `transport.connectStream(peerKey, 'file', { transferId, fileId })`，LAN 下连接 `peer.ip:peer.port`，Direct 下创建 `feige:file:<transferId>:<fileId>` 通道。
- 每个文件一条独立流，天然对应现有“最多 3 个并发文件”的模型。
- 流头仍是 4 字节长度 + 签名 JSON header；接收端继续用 `_startIncomingStream`。
- 文件结束时发送 signed `file-end`，带 SHA-256；接收端边写边算，`finish` 时比对，不一致删除文件并报错。

#### 下线 / 隐身

- `setOnline(false)` 时：
  - LAN 发 `BR_EXIT`；
  - WSS 发 `leave`；
  - 关闭 WebRTC PeerConnection；
  - 停止所有直连传输。
- 服务器断线不等于全局离线：保留已建立的 Direct 连接，后台重连。
- 对端收到 `BR_EXIT` / `leave` 才标记全局离线；单路超时只更新该来源。

## 6. 安全设计

### 6.1 威胁模型

公共服务器可能被攻击、被运营方查看、被中间人劫持；局域网内也可能有恶意节点。必须保证：

- 服务器不能冒充任何同事；
- 服务器不能篡改消息/文件而不被发现；
- 服务器不能读取聊天内容（认证加密后）；
- 非房间成员不能看到房间在线列表；
- 重放、跨房间、错误转发必须被拒绝。

### 6.2 关键措施

1. **身份复用**：继续用 Ed25519 公钥作为 identity；所有 presence、signal、消息、回执、文件信令签名。
2. **挑战应答**：服务器连接时用随机 challenge，客户端签名；防止重放和简单冒用。
3. **房间隔离**：服务端按 room 维护连接；信令只允许同房间转发；房间 token 高熵、可吊销。
4. **签名 presence**：服务器只转发签名资料；客户端校验 `ts`、`nonce`、签名；服务器无法伪造昵称/主机名。
5. **信令绑定**：signal 带 `from`、`to`、`sessionId`、`nonce`、`ts`、签名；接收端校验目标是自己；服务端填写 `from`。
6. **应用层 path-auth**：DataChannel 建立后，双方先交换签名的 `{peerKey, sessionId, nonce}`，确认对端身份后才发业务数据；已认证联系人继续走现有 X25519 + SAS 握手。
7. **文件完整性**：文件流结束发送签名 SHA-256；接收端校验失败则删除并报错。这补上了当前 README 中“文件内容未做哈希校验”的缺口。
8. **房间内容加密（建议）**：邀请串中的 `contentKey` 用于 AES-GCM 加密 presence profile 和 signal payload；服务器只看到 identity、房间、时间和密文。服务端不持有 contentKey。
9. **隐私最小化**：默认不把主机名、内网 IP 展示给非认证联系人；设置中说明服务器可见的元数据（identity、房间、在线时间、连接对端、流量大小）。
10. **限流/防滥用**：连接频率、消息频率、房间人数、SDP 大小、信令大小、失败次数；异常断开。

### 6.3 服务器可见 / 不可见

| 数据 | 服务器是否可见 |
| --- | --- |
| Ed25519 identity | 可见（路由必需） |
| 房间 ID | 可见 |
| 昵称 / 主机名 | 默认可见；启用 contentKey 加密后不可见 |
| 内网/公网 IP、ICE candidates | 默认可见；加密 signal payload 后不可见 |
| 在线状态、连接时间、流量大小 | 可见 |
| 聊天文本、图片、文件内容 | 不可见 |
| 认证加密后的消息 | 不可见 |

即使启用 contentKey，服务器仍能看到“谁和谁在什么时间建立连接、传了多大流量”，这是信令架构的固有限制，需要在隐私说明中写清楚。

## 7. 兼容性

现有 `PROTOCOL_VERSION = 5`，且校验严格。建议：

- **LAN 线协议保持 v5**，新增字段（如 `caps`、`path`）作为可选字段；旧客户端会忽略未知字段，签名仍覆盖全部字段。
- **公网发现使用独立协议** `RENDEZVOUS_VERSION = 1`，不混入 IPMsg 包版本。
- **Direct 数据通道内部复用 v5 包**，因此文本/回执/报价格式不变。
- 2.0.0 已将协议升级到 v5；后续若再改字段语义或强制新校验，需要继续提升协议大版本，并提供“对方版本过旧”的明确提示。
- 设置中增加功能开关；默认可以先关闭，灰度验证后默认开启。
- 旧客户端看不到公网同事，但不影响原有局域网功能。

## 8. 工作清单

预估按 1 名熟悉该代码库的工程师计算；WebRTC 技术验证结果可能影响后续估算。

### P0 决策与技术验证（3–5 人日）

- [ ] 明确产品策略：默认无中继；直连失败时是“报错”还是“可选 TURN 中继”。
- [ ] 明确房间模型：邀请码、token、contentKey、过期/吊销策略。
- [ ] 明确首版范围：只做消息，还是同时做图片/文件/文件夹。
- [ ] 技术 spike：在 Electron 45 主进程验证 `werift`（纯 JS）与 `node-datachannel`（原生）。
- [ ] 验证 DataChannel -> Duplex 适配、背压、关闭/错误事件。
- [ ] 两个进程回环直连；再在两个 NAT 后测试 ICE/STUN。
- [ ] 压测 1 GB 文件，记录吞吐、CPU、内存。
- [ ] 输出 ADR：传输库、协议版本、失败策略、兼容策略。

**交付物**：技术选型 ADR、Spike 报告、风险清单。

### P1 共享协议与服务端 MVP（6–9 人日）

- [ ] 新建 `src/shared/rendezvous/`：常量、消息类型、校验、邀请串编解码。
- [ ] 定义 challenge / hello / presence / signal / leave 的 JSON schema 与字段上限。
- [ ] 实现服务端 WSS 服务、TLS 反代配置。
- [ ] 实现 Ed25519 挑战应答、房间 token 校验、在线状态 TTL。
- [ ] 实现房间内 presence 广播、信令转发、`from` 重写。
- [ ] 实现限流、帧大小上限、连接数上限、错误码。
- [ ] 实现健康检查、指标、结构化日志。
- [ ] 部署 STUN（coturn 或最小 STUN 服务）。
- [ ] 编写 Docker Compose、Caddy 配置、systemd 示例、部署文档。
- [ ] 服务端单元/集成测试：鉴权、重放、跨房间、限流、断线。

**交付物**：可部署的 rendezvous 服务、协议文档、Docker 镜像、部署手册。

### P2 客户端发现与设置（5–7 人日）

- [ ] `RendezvousClient`：WSS 连接、指数退避重连、心跳、挑战应答。
- [ ] 房间加入、presence 解析、签名/解密校验。
- [ ] 与 LAN peers 合并：按 identity 去重、来源标记、优先级。
- [ ] 多来源在线判断、单路超时、显式离线处理。
- [ ] 服务器断线时保留直连、状态提示、自动重连。
- [ ] `settings` 增加 `rendezvous` 配置并加密落盘。
- [ ] IPC / preload：设置、状态、测试连接、诊断信息。
- [ ] 设置页：启用开关、服务器地址、房间邀请、连接状态、测试按钮。
- [ ] 联系人列表：来源/路径徽标。
- [ ] 错误提示：token 无效、房间满、服务器不可达、版本不兼容。

**交付物**：跨网发现可用；LAN 功能零回归。

### P3 传输抽象与 LAN 重构（5–7 人日）

- [ ] 定义 `PeerTransport` / `PeerPath` 接口。
- [ ] 把 `_sendRaw` 改为 `_sendToPeer`，LAN 实现保持现有 UDP。
- [ ] 把 `_onTcp` 的“读 4 字节头 + JSON”拆成 `_handleIncomingStream`。
- [ ] `SecureManager` 注入连接工厂，移除内部 `net.connect`。
- [ ] `_fetchManifest` / `_onGetFileData` / `_startIncomingStream` 改走传输层。
- [ ] 多来源 peer 合并、`_sweepPeers` 按来源超时。
- [ ] 保留 LAN `_sameHost` 校验；为 Direct 流增加 `peerKey` 绑定。
- [ ] 补齐 LAN 回归测试（现有测试必须全绿）。

**交付物**：LAN 路径行为不变，传输层可插拔。

### P4 WebRTC 直连（8–12 人日）

- [ ] `DirectTransport`：PeerConnection 生命周期、ICE 配置、deterministic initiator。
- [ ] offer/answer/ICE 队列、trickle ICE、ICE restart。
- [ ] DataChannel -> Duplex 适配器，支持背压、关闭、错误、半关闭。
- [ ] 控制通道：文本/回执/报价/释放/文件请求。
- [ ] secure-handshake 通道：复用 `FrameSocket` 协议。
- [ ] manifest 通道：复用现有清单签名结构。
- [ ] 每文件独立通道：复用现有文件流头。
- [ ] 应用层 path-auth：DataChannel 建立后签名确认对端 identity。
- [ ] 路径选择、切换、失败重试、状态事件。
- [ ] 连接诊断：ICE state、candidate pair、RTT、最后错误。
- [ ] 集成测试：回环、同 LAN、跨 NAT（可用 network namespace / Docker）。

**交付物**：跨网文本、回执、认证加密、图片、文件、文件夹直连可用。

### P5 安全与完整性加固（4–6 人日）

- [ ] presence / signal 重放防护、时间窗口、nonce 校验。
- [ ] 跨房间、错误目标、伪造 `from`、篡改 SDP 的测试。
- [ ] 文件 SHA-256 尾部校验；失败删除/隔离并提示。
- [ ] 可选：contentKey 加密 presence profile 与 signal payload。
- [ ] 房间 token 轮换/吊销（至少文档 + 服务端支持）。
- [ ] 限流、房间人数上限、异常连接断开。
- [ ] 隐私说明：服务器可见元数据、数据不经过服务器、TURN 关闭。
- [ ] 安全评审：签名 payload 是否覆盖所有可变字段；旧协议降级路径是否被堵住。

**交付物**：安全测试报告、隐私说明、文件完整性校验。

### P6 体验、运维与发布（5–7 人日）

- [ ] 首次使用引导：输入邀请码/导入邀请串。
- [ ] 设置页“公网发现”分区和状态说明。
- [ ] 联系人路径徽标：局域网 / 公网直连 / 连接中 / 失败。
- [ ] 失败提示与重试；不要把“服务器已发现”误显示成“可发送”。
- [ ] 诊断页：服务器连接、ICE 状态、NAT 类型提示、最后错误。
- [ ] README / 部署文档 / 常见问题更新。
- [ ] 服务端监控、告警、日志轮转、备份（无业务数据）。
- [ ] 灰度开关、回滚方案。
- [ ] Windows / Linux 打包验证；原生依赖 asarUnpack（如选 node-datachannel）。

**交付物**：可发布版本、运维手册、用户文档。

### P7 测试与验收（6–10 人日，可与 P6 并行）

- [ ] NAT 矩阵：全锥、受限锥、端口受限锥、对称 NAT、CGNAT、双重 NAT。
- [ ] 服务器重启、网络切换（Wi-Fi/有线）、休眠唤醒、IP 变化。
- [ ] 大文件、超大目录、空目录、中文名、并发 3 文件。
- [ ] 断线重连、ICE restart、传输中断恢复/失败提示。
- [ ] 安全：伪造 presence、重放 signal、跨房间、篡改文件、超长帧、洪泛。
- [ ] 性能：LAN vs Direct 吞吐、CPU、内存、连接建立时间。
- [ ] 兼容：旧客户端 LAN 互操作、关闭公网发现、回滚。
- [ ] 验收：服务器抓包/字节统计确认没有业务数据经过服务器。

**交付物**：测试报告、已知限制、发布检查清单。

### 总估算

| 阶段 | 人日 |
| --- | ---: |
| P0 决策/Spike | 3–5 |
| P1 服务端 MVP | 6–9 |
| P2 客户端发现 | 5–7 |
| P3 传输抽象/LAN 重构 | 5–7 |
| P4 WebRTC 直连 | 8–12 |
| P5 安全/完整性 | 4–6 |
| P6 体验/运维 | 5–7 |
| P7 测试/验收 | 6–10 |
| **合计** | **42–63 人日** |

单人约 9–13 周；两人并行约 5–7 周。P0 的 WebRTC Spike 是最大不确定性，建议先做。

## 9. 验收标准

1. **LAN 零回归**：关闭公网发现时，现有发现、消息、加密、文件、文件夹、图片、下线行为与当前版本一致。
2. **跨网发现**：同一房间、不同网络的两台设备，在 10 秒内互相出现在联系人列表。
3. **直连数据**：文本、回执、认证加密、图片、文件、文件夹均通过 Direct 路径完成；服务器侧字节统计/抓包看不到业务 payload。
4. **路径标识**：联系人卡片能显示“局域网 / 公网直连 / 连接中 / 失败”，用户能判断当前走哪条路。
5. **失败可解释**：对称 NAT/CGNAT 无法直连时，给出明确提示和重试入口，不无限转圈、不静默中继。
6. **服务器可运维**：服务重启后客户端自动重连；已有直连不被误断；健康检查、指标、日志可用。
7. **安全**：伪造 presence、重放信令、跨房间转发、篡改文件均被拒绝或检测。
8. **兼容**：旧客户端仍可局域网互通；关闭/回滚公网功能不影响原功能。
9. **性能**：1 GB 文件在典型 NAT 环境下完成传输，吞吐满足产品预期；内存不随文件大小线性增长。
10. **跨平台**：Linux 与 Windows 安装包可启动、可直连、防火墙提示可理解。

## 10. 风险与备选方案

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 对称 NAT / CGNAT 无法打洞 | 部分用户永远无法直连 | 明确失败提示；可选自建 TURN（数据经过服务器，需用户显式开启）；或建议同网段/公网 IP |
| 企业防火墙禁止 UDP/WebRTC | 直连失败 | 诊断提示；后续评估 ICE-TCP/中继，但不承诺 |
| WebRTC 库性能/打包问题 | 大文件吞吐低、安装包增大 | P0 Spike；优先 `werift` 纯 JS，性能不足再评估 `node-datachannel` 原生模块 |
| 服务器被滥用 | 房间被扫描、资源耗尽 | 高熵 token、房间隔离、限流、可吊销、监控 |
| 服务器可见元数据 | 隐私顾虑 | contentKey 加密 profile/SDP；隐私说明；支持自建服务器 |
| 协议分叉/旧客户端不兼容 | 用户升级不一致 | LAN 保持 v5；公网独立协议；能力协商；明确版本提示 |
| 文件内容被篡改 | 数据完整性 | 文件尾 SHA-256；认证加密模式本身已加密认证 |
| 公共服务器单点故障 | 新连接无法建立 | 已有直连不受影响；客户端重连；多实例/多域名后续 |
| 大目录/大文件内存/背压 | OOM、卡顿 | DataChannel 适配器做背压；保持 3 并发；压测 |
| 时钟偏差 | 签名消息被丢弃 | 沿用现有 ±5 分钟窗口；presence 用服务端 TTL 辅助；提示校时 |

### 备选方案对比

| 方案 | 优点 | 缺点 | 建议 |
| --- | --- | --- | --- |
| **A. WebRTC DataChannel（推荐）** | 标准 ICE/STUN、DTLS、可靠有序、背压、成熟 | 引入依赖；大文件吞吐需验证；SDP 元数据 | 首选 |
| B. UDP 打洞 + 自研可靠传输（KCP/QUIC） | 完全可控，无 WebRTC 依赖 | 可靠传输/拥塞/多路复用自研，工作量和风险高 | 仅在明确拒绝 WebRTC 时 |
| C. TCP 打洞 + UPnP/NAT-PMP | 复用现有 TCP 文件通道 | 成功率低，企业网/对称 NAT 不可用 | 仅作为 LAN 辅助，不作为主方案 |
| D. 服务器中继（TURN/WS 转发） | 100% 连通 | 违反“数据不过服务器”；带宽成本；隐私 | 仅作为用户显式开启的兜底 |
| E. 集成 Tailscale/ZeroTier 等 mesh VPN | 连通性最好，维护少 | 外部依赖、需安装/权限、不是自建公共服务器 | 企业内部可考虑 |

## 11. 需要先确认的决策

1. 公共服务器由谁运营？域名、TLS 证书、部署位置？
2. 发现范围是“一个公司一个房间”，还是支持多部门/多租户？邀请码如何分发和吊销？
3. 是否严格禁止任何中继？直连失败时产品行为是“报错”还是“可选开启 TURN”？
4. 首版是否必须支持跨网文件/文件夹，还是先只做文本和认证加密聊天？
5. 是否需要兼容已发布的旧客户端？旧客户端只需局域网互通，还是必须能看到新客户端？
6. 是否接受引入 WebRTC 运行时依赖（`werift` 或 `node-datachannel`）？
7. 目标规模：房间数、同时在线人数、单文件大小、期望吞吐？
8. 隐私要求：服务器是否允许看到昵称、主机名、IP、连接关系？是否需要 contentKey 加密？
9. 是否需要 IPv6 优先/双栈？
10. 发布方式：灰度开关、企业内网自建服务器、还是默认连接公共服务器？

## 12. 建议的实施顺序

1. 先做 P0 Spike，确认 WebRTC 在 Electron 45 主进程中的可用性、吞吐和打包。
2. 再做 P3 传输抽象 + LAN 回归，确保现有功能不被破坏。
3. 然后 P1 服务端 + P2 客户端发现，先实现“跨网能看到同事”。
4. 接着 P4 直连，按“文本/回执 -> 认证加密 -> 图片 -> 文件/文件夹”顺序推进。
5. 最后 P5/P6/P7 做安全、体验、运维和 NAT 矩阵测试。

这样每个阶段都有可演示的里程碑，且 LAN 路径始终可回退。
