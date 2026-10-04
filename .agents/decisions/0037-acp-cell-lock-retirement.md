# ADR-0037 宿主 acp 单元锁退役——短窗快照 + 客户端 generation 自校验

- **日期**：2026-10-04
- **状态**：已采用（用户拍板「①②推进」，2026-10-04 会话；施工 issue #549，姊妹 issue #548）

## 背景与约束

宿主以 `Arc<tokio::sync::Mutex<AcpClient>>`（`src-tauri/src/runtime.rs:115`）承载 ACP 连接，三处持锁跨 `.await`（`session/control.rs:285,433`、`session/prompt/wait.rs:657`，`HeldAcrossAwait` 收口）。锁的真实职责经核实不是 wire 串行化——出站本就是每客户端私有队列（`send_notification` 经 `backend.outbound` 入队 + oneshot 写入回执，`client.rs:438-455`；`prepare_rpc` 锁外发送）——而是：

1. 「解析客户端 → generation 检查 → 写入」对 `*acp.lock() = new` 替换动作的原子性（ACP-05 §5.7 契约：旧 periId 的 cancel 永不写入新 ACP）；
2. `kill(&mut self)` 的 `&mut` 独占。

约束：上述不变式与 stale generation 结构化错误面不得改变；kill 与在途 send 的现行为不主动变更；wire 格式与 engine outbound writer task 结构不动。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 完整出站命令化（跨客户端命令总线 + writer task 校验 expected generation） | 跨客户端总线是过度设计：每客户端出站通道已私有，原子性无需总线；契约级改动面大（engine/outbound、wire trace、replay parity 全部重钉），收益与轻量形态相同 |
| 维持现状（Mutex + `HeldAcrossAwait`） | acp 锁是宿主级全局串行点，cancel 写入回执 await 期间泵/prompt/遥测/快照全部排队；豁免面持续维护 |
| arc-swap 等无锁单元 | 引入新依赖，违反「不必要不加依赖」纪律；std RwLock 短窗（clone Arc 即放锁）已达同等效果 |

## 决定

1. `AcpClient` 全面 `&self` 化：`client_generation: u64` 落为客户端字段；`kill` 的 `join.take()` 收进 `std::sync::Mutex<Option<JoinHandle>>`。
2. 宿主单元改 `Arc<std::sync::RwLock<Arc<AcpClient>>>`：读侧 clone Arc 即放锁（短窗，锁内无 await），写侧仅替换赋值时持锁。
3. 原持锁点改「快照解析 → `client.client_generation() == expected` 自校验（不等则原样结构化错误）→ 入队该客户端自己的 outbound」。不变式由**通道所有权**保证：cancel 只进被解析客户端的私有通道，物理上不可能落到另一代的 wire；替换后旧客户端必被 kill（R4），通道死亡即 `ConnectionClosed`，settle 收敛路径不变。

## 后果

- 正面：acp 相关 `HeldAcrossAwait` 清零；宿主级锁尾延迟消失（锁内存活时间降到纳秒级）；`await_holding_invalid_type` 对 AcpClient 单元的豁免面退役。
- 负面：替换窗口内对濒死旧连接的 cancel 可观察行为有差——现行为=锁内检 generation 失败报结构化错；新行为=可能入队成功（写入回执先于 kill 落地）。对 Peri 侧 settle 收敛无影响（旧连接必死），接受。
- 风险：`kill` 经内部互斥后与在途 send 的交错窗口依赖「写入失败自行收尾」（R4 现状语义），未新增保证也未削减。

## 证据

- 锁职责核实：`pylon-acp/src/client.rs:438-455`（send_notification 入队式）、`client.rs:306-311`（prepare_rpc 锁外发送注释）。
- 替换写点：`src-tauri/src/session/control.rs:513`、`src-tauri/src/session/fork.rs:291`。
- 短读点全集：`runtime.rs:350`、`export.rs:171`、`acp/mod.rs:60`、`lifecycle/registry.rs:140`、`permission.rs:194,457,898`、`dispatcher/mod.rs:498,654-666`、`lifecycle/stop.rs:39`、`lib.rs:536`、`session/prompt/wait.rs:670`。
- 消费面与 INVENTORY 前置计数：`scripts/check-await-holding.mjs`（control.rs 4→2、`session/prompt/wait.rs` 4→3）。
