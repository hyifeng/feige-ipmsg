# 飞鸽 Hub

独立运行的虚拟 LAN Hub：只负责广播帧扩散、P2P 信令转发和 STUN。

不保存消息、不转发文件、不维护在线列表、不解析飞鸽协议、不提供 TURN。

## 运行

```bash
cd server
npm install
npm start
```

默认监听：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| `8787` | TCP | WebSocket 广播 / P2P 信令 |
| `3478` | UDP | STUN Binding |

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HUB_PORT` | `8787` | WebSocket 端口 |
| `HUB_HOST` | `0.0.0.0` | 监听地址 |
| `STUN_PORT` | `3478` | STUN 端口 |
| `STUN_HOST` | `0.0.0.0` | STUN 监听地址 |
| `HUB_TLS_CERT` | 空 | 可选 TLS 证书路径（直接提供 WSS） |
| `HUB_TLS_KEY` | 空 | 可选 TLS 私钥路径 |
| `HUB_LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

日志只记录连接、bind/unbind、广播/信令的路由结果和错误；不会打印 SDP、ICE、飞鸽报文内容。

生产环境建议把 `8787` 放在 Caddy/Nginx 后面提供 `wss://`，或直接配置 `HUB_TLS_CERT` / `HUB_TLS_KEY`。

## 构建单文件可执行程序

```bash
cd server
npm install
npm run build:win     # ../dist/feige-hub.exe
npm run build:linux   # ../dist/feige-hub
```

Windows 版是控制台程序，双击或在终端运行 `feige-hub.exe` 即可。

## Hub 协议

客户端到服务器：

```json
{ "type": "bind", "identity": "pk1_..." }
{ "type": "broadcast", "payload": "<不透明飞鸽广播帧>" }
{ "type": "signal", "to": "pk1_...", "payload": "<不透明 WebRTC 信令>" }
```

服务器到客户端：

```json
{ "type": "broadcast", "from": "pk1_...", "payload": "..." }
{ "type": "signal", "from": "pk1_...", "payload": "..." }
```

规则：

- `broadcast` 原样转发给除发送者外的所有已 bind 客户端；
- `signal` 原样转发给目标 identity；
- `payload` 不解析、不保存；
- 连接关闭只删除 identity 路由表项，不广播 offline；
- 谁在线由客户端的 `BR_ENTRY` 心跳和超时判断；
- 谁下线由客户端的 `BR_EXIT` 或超时判断。

Hub 内部只有一张 `identity -> WebSocket` 的路由表，类似交换机的 MAC 表，不是在线列表。

## App 配置

在 App 设置里填写：

- 服务器地址：`wss://你的域名:8787`，本地测试可用 `ws://127.0.0.1:8787`
- STUN 地址：留空时自动使用服务器主机的 `3478` 端口，也可以显式填写 `stun:你的域名:3478`

启用后：

- 飞鸽 `BR_ENTRY` / `BR_EXIT` 广播经 Hub 扩散；
- 飞鸽单播 `ANSENTRY` / 文本 / 文件只在 P2P 建立后走 DataChannel；
- Hub 只转发 WebRTC offer/answer/ICE，不接触飞鸽单播；
- 局域网广播仍然保留；
- 不配置 TURN，打洞失败时无法连接。

> 当前 Hub 没有鉴权、房间和限流：能连上来的客户端都在同一个 Hub 里。公开部署前请自行决定是否放在内网、VPN 或反向代理访问控制之后。
