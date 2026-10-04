# Dev Record — #451 发送路径接管「无主 Crashed」

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#451（bug/acp——connect 总预算超时后发送路径仍硬错误）
- 分支：`kumo/451-unowned-crashed`（自 `github/main` @ `a8825c52` 拉出；与 `kumo/prometheus` 上在途的 #548/#549 域严重交叠，依 §2.1 worktree 隔离施工）
- 提交范围：`a8825c52..76da2b14`（单提交）
- 日期：2026-10-05

## 目标与范围

issue 原话：「预算超时后的 Crashed 状态对发送路径可自愈或给出明确、可恢复的语义，而不是静默回到 #379 之前的硬错误。」

**做什么**（三头，均为仓库主 2026-10-04 裁决）：①发送路径精确接管「无主 Crashed」（方向 C）；②占位 client 构造即判死（补「全新形态」缺口）；③接管路径 continuity=Unknown。

**不做什么**：#421 预算分支语义/时长；`crash_reconnect.rs` 自动重连循环；平台侧 `ensure_runtime_ready`；前端。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-acp/src/client.rs` | `disconnected()` 占位构造 `stopped=true` + 字段 doc | 修改 |
| `src-tauri/src/session/mod.rs` | `ensure_connected_for_send` 触发集/continuity 重写 + 新增 `send_path_rebuild_continuity` 判据函数 + 函数 doc | 修改 |
| `src-tauri/src/lifecycle/mod.rs` | LifecycleOp 状态机文档（表行 + 状态机段）+ 预算测试注入锁收口 | 修改 |
| `src-tauri/src/lifecycle/budgets.rs` | `connect_budget_override::INJECTION_LOCK` 注入互斥 + 注入缝 doc | 修改 |
| `src-tauri/src/session/lazy_reconnect_tests.rs` | 旧「Crashed 让路」pin 重写为三分支 + 新增五用例 + 模块 doc | 修改 |
| `src-tauri/src/acp/tests.rs` | `disconnected_client_is_not_marked_as_crashed` 补 is_dead pin | 修改 |
| `src-tauri/src/test_utils.rs` | `test_state_with_acp_injects_client_and_sets_active` 注入身份断言改读原始 crashed 标志 | 修改 |
| `src-tauri/src/permission.rs` | sweep 死 runtime 定义 doc 补 #451 + 私有超时夹具 reframe 为死 runtime 清场 pin | 修改 |
| `scripts/check-await-holding.mjs` | INVENTORY：lifecycle/mod.rs 7→9，新增 lazy_reconnect_tests.rs（2） | 修改 |

## 方案要点

- **触发集**：`Disconnected ∨ (Crashed ∧ ¬auto_reconnect_active ∧ acp.is_dead())`。防重入标志区分「有主」（退避循环在途→让路，发送命中既有 `is_crashed → AgentCrashed` 早退）与「无主」（超时残留/自动重连放弃残留→接管）；`is_dead()` 闸保住「手动重连超时但旧 client 活着」变体（活连接不杀，发送照走既有路径）。
- **恰好一个连接权威**：崩溃通知入口 `CrashReconnectHandler::handle` 的 `swap(true)` 不经 agent_lifecycle，故判据在 agent_lifecycle 锁后全量重读（状态/标志/is_dead）。若标志先置位→本路径让路；若本路径先过复查→循环的 P2-1 复查看到 announce 的 `Connecting≠Crashed` 而放弃。
- **continuity 随判据带出**：接管=Unknown（镜像平台/自动重连先例，Probing 有界验证），Disconnected=Invalidated（#379 语义不变）。
- **占位即 dead**：`AcpClient::disconnected()` 构造置 `stopped=true`；`is_crashed()` 恒 false（crashed 标志未置），崩溃通知机制不受扰；内部守卫对占位提前 fail-fast（同一 `ConnectionClosed`）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 回收形态：预算超时残留后再次发送**再次重建** | ✅ `send_path_takes_over_after_connect_budget_timeout_residue`（二次 Err 预算标记=重建发生的判别证据；旧触发集此处返回 Ok） |
| 全新形态：占位 is_dead → 接管 | ✅ `ensure_connected_for_send_takes_over_unowned_crashed_placeholder` + acp pin（is_dead=true ∧ is_crashed=false） |
| 变体 3：活旧 client 让路不杀 | ✅ `ensure_connected_for_send_yields_when_live_client_survives_timeout`（generation 不变） |
| 自动重连在途让路 | ✅ `ensure_connected_for_send_yields_while_auto_reconnect_active`（标志不被触碰） |
| 自动重连放弃残留自愈 | ✅ `ensure_connected_for_send_takes_over_auto_reconnect_giveup_residue`（generation 1→2） |
| continuity 分支 | ✅ `send_path_rebuild_continuity_picks_continuity_per_branch`（Invalidated/None/None/Unknown 四分支，判据函数级） |
| 既有 #379/#421 pin 除点名变更外全绿 | ✅ workspace --lib 974+ 全绿 |
| clippy 基线外零新增 | ✅ check-clippy exit 0 |

## 测试处置

- **重写**：`ensure_connected_for_send_does_not_fight_crash_reconnect`（旧契约「一切 Crashed 放行」正是被 #451 变更的行为）→ 拆为「占位接管 / 有主让路 / 活 client 让路」三用例。
- **reframe**：`private_interaction_timeout_retains_entry_when_send_fails` → `private_interaction_dead_runtime_drains_pending_without_outcome`。原夹具（占位 is_dead=false 但写通道失败）在占位判死后不可达；sweep 对死 runtime 走 O37 清场成为新钉点，「发送失败→回插重试」语义由既有 `restore_private_requeues_for_retry`（interaction_ledger）单测继续覆盖。
- **修正**：`test_state_with_acp_injects_client_and_sets_active` 注入身份证明从 `is_crashed()` 改读原始 `crashed` 标志（#451 起 `is_crashed()` 对占位恒 false——这正是 #163/#451 想要的语义）。
- **新增**：session 层六用例（见验收表）+ acp 占位 is_dead pin + budgets `INJECTION_LOCK`。

## 证据

- commit：`76da2b14`（9 文件，+355/−62）
- 测试：`cargo test --workspace --lib` → 974+186+9+36+139+93+22+217 = **1676 passed / 0 failed**；fake-agent 11 passed；`cargo fmt --check` 干净；`check-acp-shadow` exit 0；`check-clippy` exit 0（基线外零新增）；`check-await-holding` 18 文件 / 61 处对账一致。
- 手工验证：未走 webview2 实机（纯后端状态机修复，集成测试以真子进程 fake-agent + 真时钟预算覆盖主链路）。

## 与 spec 的偏差

1. **AC6（Probing 在 binding_health 可观测）降级为判据函数级断言**：`SessionInfo` 夹具字段过多（构造脆），Probing 机制本身由 store.rs 既有测试钉住；continuity=Unknown 的选择已由 `send_path_rebuild_continuity_picks_continuity_per_branch` 精确 pin。
2. **spec 未预见的两处夹具回归**（占位判死的涟漪）：test_utils 注入身份断言、permission 私有超时夹具——处置见测试处置节。
3. **spec 未预见的测试基建修复**：`connect_budget_override` 全局注入从单消费者变双消费者，并行 set/clear 互踩（全量跑实测两个方向都炸过）——加 `INJECTION_LOCK` 串行化，两个 hang 测试经 `HeldAcrossAwait` 收口跨 await 持锁（await-holding INVENTORY 同步）。

## 未解问题

- **共享 target 双源根碰撞**（环境教训，非代码问题）：同一 cargo target 目录被两个 worktree 的同名 workspace crate 共用时，产物文件名按 crate 元数据派生、源根不同但指纹相容时**互相覆盖**——#548/#549 在共享树改 `client.rs` 期间，worktree 构建链接到他们的中间态产物而报 `no method notification_inbox`。worktree 构建必须用独立 `CARGO_TARGET_DIR`（本次以 `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0` 控制体积）。
- **G 盘空间**：主 target 32GB + incremental 14GB 曾把 76GB 盘打满（os error 112）。本次删除了 `target/debug/incremental`（14GB，纯缓存可再生）解锁构建；长期请仓库主考虑定期 `cargo sweep` 或迁移 target 盘。

## 并行交集

- `src-tauri/pylon-acp/src/client.rs`、`src-tauri/src/lifecycle/**`、`src-tauri/src/session/**`：与 **#548/#549 acp 锁面退役批**（L.md 在途）声明域交叠——本批全程在独立 worktree（`kumo/451-unowned-crashed`）施工，未触碰共享树；两批合并顺序后到者需 rebase，`client.rs` 的 `disconnected()` 一带冲突概率低（不同区段）。
- `scripts/check-await-holding.mjs`：#548/#549 亦声明修改（其锁面退役会增减 INVENTORY 条目）——两边都是 INVENTORY 表行编辑，合并冲突手工并表即可。
