# Dev Record — #548/#549 acp 锁面退役批（NotificationInbox 一次性移交 + 宿主 acp 单元锁退役）

## 元信息

- issue：#548（inbox 一次性移交）、#549（单元锁退役）
- 分支：kumo/prometheus
- 提交范围：`560526b9..<head>`（单 PR 双 commit 域，见下方「改动清单」）
- 日期：2026-10-04/05
- 决策记录：`.agents/decisions/0037-acp-cell-lock-retirement.md`（#549）

## 目标与范围

用户拍板（2026-10-04 会话「①②推进吧」）：

- ② #548：`NotificationInbox` 从 `Arc<tokio::sync::Mutex<mpsc::Receiver>>` 双 lane 改为一次性移交的 owned Receiver——单消费者契约从注释升级为所有权 + 运行时可证。
- ① #549：宿主 acp 单元 `Arc<tokio::sync::Mutex<AcpClient>>` 退役为 `Arc<std::sync::RwLock<Arc<AcpClient>>>` 短窗换装位；三处 `HeldAcrossAwait` 的 acp 锁改「快照解析 + 客户端自带 `client_generation` 自校验」。

不做：engine outbound writer task 结构、其余有意持锁面（session_creation/prompt_lock/prompt_gate/switch_lock/agent_lifecycle/lifecycle_lock 等）、新依赖、wire 格式。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `pylon-acp/src/client.rs` | NotificationInbox owned 化（recv/recv_control/`recv_biased`）+ `take_notification_inbox`；AcpClient `&self` 化（`child`/`backend.join` 内部互斥、`client_generation` 字段与访问器、`kill(&self)`） | 修改 |
| `pylon-acp/src/engine/{mod,outbound}.rs` | SdkBackend `inbound: Mutex<Option<Inbox>>`、`join: Mutex<Option<JoinHandle>>` 构造随动 | 修改 |
| `src/runtime.rs` | 单元类型 + `snapshot_acp`/`install_acp` 助手 | 修改 |
| `src/dispatcher/{mod,fallback_route,interaction_route,permission_route/*,host_tools_gate}` | `AcpLock` 别名改形 + `acp_snapshot` 助手；全部 responder 短锁改快照；泵装配三连取收进一次快照；inbox take-once + fail-fast | 修改 |
| `src/session/{mod,control,fork}.rs`、`src/session/prompt/{wait,settle}.rs`、`src/session/persist/mod.rs`、`src/session/create/{mod,revive}.rs` | RPC 准备/取消/换装/快照读全部迁 snapshot；`acp_rpc_generation_checked` 与 control.rs cancel 改客户端自带代际自校验（结构化错误文案不变） | 修改 |
| `src/lifecycle/{stop,registry,session_probe,connection_test}.rs`、`src/lib.rs`、`src/export.rs`、`src/acp/mod.rs`、`src/permission.rs` | kill 走快照；`try_lock`→`try_read`（「不等待换装写锁」语义保留）；替换块改 std 写锁（锁内无 await）；审批身份复核改快照客户端自带代际 | 修改 |
| `src/{test_utils,acp/*,session/*}_test 文件` | `*acp.lock() = X` → `install_acp(X)`；读断言 → `snapshot_acp()` | 修改（机械） |
| `scripts/check-await-holding.mjs` | INVENTORY：client.rs 条目移除（3→0）、control.rs 4→2、prompt/wait.rs 4→3 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | negotiated 快照「async 持锁 / try_lock 双入口」表述同步为短窗快照读 | 修改 |

## 方案要点

1. **原子性从「锁窗口」移到「通道所有权」**：cancel/控制 RPC 只入队被快照解析出的那个客户端的私有出站通道，物理上不可能落到替换后的新连接；替换后旧客户端必被 kill（R4），通道死亡即 `ConnectionClosed`，settle 收敛路径不变。stale 判定改用客户端**自带** `client_generation`（宿主原子量与单元内容在生产中同窗更新，分离后客户端本体才是权威配对）。
2. **`kill(&mut self)` → `kill(&self)`**：`child.take()`/`join.take()` 的 `&mut` 内部态收进 std 互斥（kill 持锁阻塞期 pid 读取随之等待——终止期诊断延迟，可接受）；`KillOnCloseJob` 本为跨线程设计（isize 传递），`Mutex<ManagedChild>` 满足 `Sync`。
3. **std 守卫的编译期安全网**：非 Send 的 `RwLockReadGuard` 一旦被拖过 `.await` 直接编译失败（施工中真实拦截过一次 `x.read().clone().foo().await` 的临时守卫语句尾存活陷阱，改为先 `let` 绑定快照）。
4. **泵装配一致性**：run() 开头单次快照完成 inbox take / crashed 订阅 / wire_trace 三连取（原三次独立加锁），一致视图且更少同步点。
5. **②单消费者下沉 `recv_biased`**：#99 biased 双 lane 优先级从泵的两个 select 分支下沉进 `NotificationInbox::recv_biased`（`&mut self` 单点持借用），语义逐点一致（任一 lane 关闭即 Stop）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 全仓 grep `Mutex<AcpClient>` 零命中 | ✅ 0 命中 |
| 全仓 grep `tokio::sync::Mutex<mpsc::Receiver` 零命中 | ✅ 0 命中 |
| `cargo test --workspace --lib` 全绿 | ✅ 1672 passed / 0 failed / 4 ignored |
| `-p pylon-fake-agent --features test-agent` 测试 | ✅ 绿 |
| `bun run check:clippy`（基线零新增 + await-holding 对账） | ✅ 绿（16 文件 / 51 处，裸 allow 0） |
| `bun run check:acp-shadow` | ✅ 绿 |
| `cargo fmt --all --check` | ✅ 绿 |
| 既有行为测试未被修改 | ⚠️ 1 个例外，见「测试处置」 |

## 测试处置

- 新增：`pylon-acp/src/client.rs` `notification_inbox_is_take_once`（第二次 take 必须返回 None）。
- **契约变更型修改 1 处（需评审注意）**：`session::tests::generation_checked_rpc_blocks_stale_control_request`——旧夹具只 bump 宿主 `client_generation` 原子量来「模拟替换」（旧实现锁内比对原子量）；新契约下代际权威在客户端本体，原子量单独 bump 不再构成替换。改为 `connect_with_generation(&agent, None, 1)` 直挂 gen-1 客户端 + `expected=0`，断言「stale 必须拒绝且 trace 无 session/close」不变。
- 机械迁移（断言零变化）：test_utils / p1_wire_regression / golden_trace / revive_tests / model_switch_wire_tests / prompt tests / session_expiry_platform_tests / connection_test 的 `*acp.lock() = X` → `install_acp(X)`、读断言 → `snapshot_acp()`；`acp/tests.rs:1676`、`golden_trace_tests.rs:487,585` 改 `take_notification_inbox().expect(...)`。
- `kill(&mut self)`→`kill(&self)` 的机械余波（clippy 基线外新诊断，全部修掉）：10 处 `let mut client` 去 mut（golden_trace ×2、acp/tests ×1、instance_registry ×5、real_acp_smoke ×2）、p1_wire_regression 1 处 `logs.clone()` 冗余克隆摘除、`install_acp` 挂 `#[cfg(test)]`（调用方全在测试域；生产替换走 lib.rs 整窗写锁，不走单点赋值）。

## 证据

- 测试：`cargo test --workspace --lib` → 969 passed / 0 failed / 4 ignored（/d/pylon-tmp/gate-lib2.log）。`bun run check:clippy` exit 0（/d/pylon-tmp/gate-clippy3.log）；`check:acp-shadow`、`cargo fmt --check` exit 0。
- INVENTORY 对账输出：`check-await-holding: 通过（16 文件 / 51 处 HeldAcrossAwait，全部与清单一致；裸 allow 0 处）`。
- 结构判据：`grep -rc "Mutex<AcpClient>"` 与 `grep "tokio::sync::Mutex<mpsc::Receiver"` 均 0 命中。

## 与 spec 的偏差

- spec（549）写的是「宿主 `Arc<RwLock<Arc<AcpClient>>>`」：实现一致，但助手落位为 `AgentRuntime::{snapshot_acp,install_acp}` + dispatcher 本地 `acp_snapshot`（别名 `AcpLock` 保持 `&AcpLock` 签名不变，route 模块零签名改动）——比 spec 预估的侵入面更小。
- spec 未预写的两点：①`recv_biased` 下沉（select! 双 `&mut` 借用冲突的正解）；②generation 权威从宿主原子量移到客户端本体（ADR-0037 已记录）。

## 未解问题

- 环境：G 盘 99% 满（且本机 TEMP=/tmp 映射 G:\TEMP），门禁全程以会话级环境变量 `CARGO_TARGET_DIR=D:/pylon-target`、`TMP/TEMP/TMPDIR=D:/pylon-tmp` 在 D 盘完成；仓库配置零改动。首次全测的 142 个「失败」经查全部为 `pylon-fake-agent bin not found`（新 target 目录未按仓规先构建 test-agent bin），非语义回归；clippy 首跑 112 盘满错误同源于 G 盘 TEMP。后续本地跑门禁若磁盘同样紧张可复用该组变量。
- lib.rs:536 换装块持有 std 写锁跨越 kill 的阻塞等待期（与旧 tokio 锁行为一致，未放大）；若未来 kill 时长成为瓶颈，可在写锁内先 `mem::replace` 出旧客户端、放锁后 kill（语义不变，本轮不做）。

## 并行交集

本次碰过的共享文件：`scripts/check-await-holding.mjs`、`docs/说明书/Pylon-模块维护地图.md`、`src-tauri/src/lib.rs`、`src-tauri/src/dispatcher/**`、`src-tauri/src/session/**`、`src-tauri/src/runtime.rs`、`src-tauri/src/permission.rs`、`src-tauri/pylon-acp/**`。在途的 #545 前端批（cli/测试/0035/515/SettingsSheetSidebar）零交叠，全程 pathspec 隔离。
