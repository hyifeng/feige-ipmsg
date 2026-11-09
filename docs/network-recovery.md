# 网络状态变化恢复设计

## 1. 问题本质

旧实现把三件事混在一起：

1. **发现来源**：怎么知道对方存在（LAN 广播 / Hub 广播 / P2P 控制包）。
2. **承载路径**：消息和加密流实际走哪条链路（LAN TCP / WebRTC DataChannel）。
3. **安全会话**：加密握手建立在哪条链路上，以及这条链路消失后怎么办。

结果是：

- LAN 已经物理断开，但 LAN 发现来源还要等 30 秒超时，UI 才从“局域网”变成“公网直连”。
- 加密会话绑定在 LAN TCP 上。LAN TCP 立即断了，但 peer 仍通过 Hub/Direct 在线，所以不会触发“peer 上线”事件，也不会自动 resume。
- Direct 路径可能仍然健康，但路径选择没有“健康状态”，只看到 LAN 来源在线，继续优先 LAN。
- 双方同时检测到断链时可能同时发起握手，互相覆盖。

因此不能继续用“来源 lastSeen 超时”充当路径故障检测，也不能把加密会话当成与路径无关的长连接。

## 2. 分层模型

```text
Discovery    回答“对方是谁、在哪里”
    │
    ▼
PeerRegistry 合并来源，维护 online / sources / 端点
    │
    ▼
PathSelector 回答“现在这条消息走哪条链路”
    │
    ▼
Transport    LAN / Direct(WebRTC)
    │
    ▼
Secure      加密会话；绑定当前传输，但可迁移
```

核心原则：

- **来源在线 ≠ 路径健康**。
- **路径健康由该路径自己的失败信号决定**，而不是由发现超时决定。
- **加密会话属于 peer，不属于路径**；路径失败后会话可以重新建立。
- **服务器只提供发现、信令和 STUN**，不承载任何消息、文件、回执或加密握手。

## 3. 路径状态机

每个 peer 的每条路径独立维护：

```text
unknown -> healthy -> suspect -> failed -> cooldown -> healthy
```

当前实现中的触发条件：

| 事件 | 动作 |
| --- | --- |
| LAN TCP/加密流 close | 立即把 LAN 标为 failed（45 秒冷却），选择 Direct |
| LAN 发现来源超时 | 只影响来源显示，不再作为快速故障检测手段 |
| Direct DataChannel close | 交给 DirectTransport 做 ICE 清理/重连，不封禁 Direct |
| 本地网络签名变化 | 清空路径失败状态，关闭旧流，重新发现和恢复 |
| Hub WebSocket 断开 | refresh 立即重连；心跳发现 closed/error 也重连 |
| 对端 instance 变化 | 关闭旧 P2P/加密会话，按新实例重新建立 |

为什么 Direct 故障不直接封禁：

- Direct 的恢复依赖 Hub 信令重新打洞；封禁 Direct 会挡住“对方重启后重新连接”的正常路径。
- DirectTransport 自己维护 45 秒建连超时、15 秒 disconnected 清理和 stale setup 清理。
- 如果 LAN 仍健康，Direct 连接关闭后 `hasPeer()` 变 false，路径选择自然会回到 LAN。

## 4. 路径选择

选择顺序：

1. LAN 来源在线且 LAN 路径健康，并且 Direct 尚未建立 -> LAN。
2. Direct 路径健康 -> Direct。
3. LAN 来源在线且 LAN 健康 -> LAN。
4. 没有可用路径 -> 不发送，等待下一次发现/心跳/网络变化。

LAN 健康时始终优先 LAN。Direct 可能只是 Hub 心跳提前建立，不能因为 Direct 已存在就把实际承载路径切到公网。只有 LAN 缺失或被标记为 unhealthy 后才使用 Direct。

路径变化通过 `path` 事件写入 `PeerRegistry`，UI 显示**实际承载路径**：

- `lan` -> 局域网
- `direct` -> 公网直连

不再用 `sources.includes('lan')` 推断 UI 标签。

## 5. 加密会话恢复

**原则：只重置失联的那个 peer，其他仍然连通的通道不受影响。**

A-B 的 LAN 路径断开时：

1. 只关闭 A 与 B 的旧加密会话和旧 P2P，不广播 `BR_EXIT`。
2. 只把 A-B 的 LAN 路径标记为 unhealthy，选择 A-B 的 Direct。
3. 重建 A-B 的 Direct ICE；旧 ICE 记录和旧 ufrag 候选被丢弃。
4. 通过 Direct 发起跨传输 resume。
5. B 的旧 A-B 会话仍然 active 时，先建立新会话；新会话通过 pairing + transcript proof 后，才替换旧会话。
6. A-C、A-D 以及 A 与 Hub 其他联系人的会话完全不动。

不采用“广播 EXIT/ENTRY 重置”的原因：那会让所有联系人同时把 A 标记离线，影响仍然健康的连接。广播退出只用于真实的节点停止，不用于单条路径故障恢复。

补充：

- identity 较小的一侧 3 秒后优先发起；identity 较大的一侧 6 秒后也允许发起，避免只有一侧发现断链时永久等待。
- 如果握手在 LAN 上失败，也标记 LAN 路径不可用并切 Direct，不再反复打失效 LAN。
- 最多重试 5 次；成功后清零重试计数。
- 对方主动重启/关闭、用户显式关闭、节点停止不触发网络重试。

## 6. 在线状态与 Hub 来源

- peer 只要还有任一来源在线，就保持在线。
- ALIVE 仍是单播，不广播。
- Direct 路径失效但 peer 仍通过 Hub/LAN 在线时，1 秒后主动重新广播 `BR_ENTRY`，让对端刷新 Hub 来源，避免 30 秒后才恢复。
- Hub WebSocket 断开时，刷新和心跳都会触发重连；连接成功后自动发送 `BR_ENTRY`。
- 不引入在线列表、online/offline 广播、房间、鉴权、消息中继或 TURN。

## 7. 故障矩阵

| 故障 | 恢复路径 |
| --- | --- |
| LAN 网线断开 | secure LAN close -> 立即切 Direct -> resume |
| 关闭本地 VPN，公网 IP 变化 | Direct 断开 -> 刷新 Hub 来源；Hub 重连后重新打洞 |
| Hub 服务器短暂不可达 | refresh/心跳重连；LAN 继续可用 |
| 对端进程重启 | instance 变化 -> 关旧 P2P/会话 -> 新实例重新发现/resume |
| LAN 和 Hub 都断 | peer 超时离线；网络恢复后重新发现 |
| Direct 打洞失败 | 明确失败，不静默中继，不回退服务器传数据 |

## 8. 测试

- `test/transport.test.js`：来源合并、路径健康、LAN -> Direct 快速切换、UI 路径覆盖。
- `test/failover.test.js`：LAN + Hub 同时在线，加密会话走 LAN，关闭 LAN 后 15 秒内切 Direct 并恢复加密。
- `test/migration.test.js`：只有一侧发现 A-B LAN 断链时，通过跨传输 resume 迁移恢复，不广播退出。
- `test/switch.test.js`：LAN -> Hub、对端单独重启后的会话恢复。
- `test/app-e2e.js`：真实 App 的 Hub 发现、消息、文件、加密。
- `test/app-switch-e2e.js`：真实 App LAN -> Hub 切换与 resume。

后续可以增加：

- 路径主动探测（LAN TCP ping / Direct 控制探针）；
- 多路径同时发送的快速故障转移；
- 更细的 RTT/丢包指标驱动路径选择。
