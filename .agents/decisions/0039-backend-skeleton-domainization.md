# ADR-0039 后端骨架优化——写序锁域化 + session 散点锁收敛 + turn 账本宿主单点门

- **日期**：2026-10-31
- **状态**：已采用（用户拍板「ABC 你都做了」，2026-10-31 会话；提案 issue #707，修复批次 #702~#706）

## 背景与约束

2026-10-30 全后端对抗性审查（产出 issue #702~#706）确认三个骨架级问题：

1. **写序锁与域状态分离平铺**：`AppState` 顶层平铺 6 把 tokio 写序锁与各自域的槽位/缓存；#488 宏只保证「AppState↔Handles 字段子集」编译期互钉，不保证域内不变量——「同锁写两槽」靠人肉配对，#703（`wire_mcp_servers` 读回填绕过 `mcp_write_lock`，并发 set 后缓存被旧值覆写）是实际产物。
2. **session 域散点锁**：`send_prompt_core_impl`/`ensure_session_mapping`/`advance_round` 等直接 `sessions.lock()`，锁序纪律靠注释 + 部分容器方法；#706 点名 `advance_round` 静默跳过违反 #331 例外一。
3. **turn 账本宿主直呼点分散**：begin/defensive settle/note_session_activity/drop_generation/turn_in_flight 散在 wait/ingest/dispatcher/expiry，与 `session/prompt/ledger.rs` 既有结算门并存两套口径。

约束：不动 wire/IPC 命令面/事件名/既有错误码；不动 SQLite schema；不动 `AgentRuntimeManager`/DashMap；不动 crate 依赖方向；#488 宏机制保留；不新增 `HeldAcrossAwait` 使用点（INVENTORY 对账）；域化为锁的归属移动而非锁行为改变。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| AppState 物理拆分（按域拆结构体） | #488 宏已控字段子集风险，物理拆分收益不足、churn 全仓；本 ADR 的域对象形态已把「锁+槽+缓存」收进单一所有者 |
| config_write_lock 一并域化（包 agents/active_agent） | agents/active_agent 读面横跨全仓（50+ 触点 + 测试夹具），收益/风险比不划算；写序锁留守顶层并在 #707 评论说明，供仓库主复议 |
| clippy.toml 新增 std 锁卫 await-holding-invalid-types 条目 | #414 起默认 warn 的 `await_holding_lock` 已在基线棘轮内，重复登记不新增判定力；本批散点收敛后现有清单已足够 |
| 账本门用可见性收窄到 pub(super) 强制 | TurnLedger 类型与字段分属两 crate/两模块层级，跨 crate 收窄会破坏 pylon-acp 自身测试面；采用「字段 pub(crate) + 宿主单点门 + grep 证据」的可行形态 |

## 决定

1. **A · 写序锁域化**：`McpDomain`（write_lock + persist_order + runtime/wire 双槽；miss 重算与 commit 共享单一 slots 锁——#703 竞态结构性不可表达）、`ApprovalModeDomain`（mode + persisted + write_lock）、`PetDomain`（state + write_lock）三域落位；AppState 顶层平铺字段 9→3。config_write_lock 留守（理由如上）。
2. **B · session 散点锁收敛**：prompt 管线的映射触碰/回合推进/注入轮次读/liveness 读/槽位预检收敛进 `session/store.rs`（`touch_for_prompt`/`begin_turn_state`/`inject_round`/`last_activity`/`slot_headroom`）；`begin_turn_state` 合并 R33b 推进与 #352 cancel 清除并 **fail-closed**（#706），cancel 清除点前移至出站发送前（prompt_gate 串行化保证可观察行为等价）。
3. **C · turn 账本宿主单点门**：宿主对账本的写路径与跨域读收口 `session/prompt/ledger.rs`（`begin_turn`/`settle_active_for_session_defensively`/`note_session_activity`/`drop_generation`/`turn_in_flight`），`AgentRuntime.turn_ledger` 字段 pub → pub(crate)；prompt 等待循环 cancel 闭包与映射复用→prepare_prompt 增加代际自校验（#702）。

## 后果

- 正面：#703 类「绕锁读写」竞态在域方法内结构性不可表达（附并发压力测试）；新增横切域只需实现域对象；锁序纪律的 prompt 管线面由容器方法约束；账本访问 grep 可证单点；#702 两处代际窗口以结构化 stale 错误拒绝。
- 负面：`wire_servers` miss 路径在 slots 锁内做有界重算（≤32 server 校验+序列化，与原回填同成本，不再有覆写窗口）；`begin_turn_state` 失败使「锁中毒/映射消失」从静默降级变为该次 prompt 报错（#331 例外一的正确形态）。
- 风险：域访问器（`mode()`/`inner()` 等）仍返回 Arc，域内并发纪律靠方法契约维持；后续若引入更多域，建议连同 config 域一并复审。

## 证据

- 域化：`src-tauri/src/lifecycle/mcp.rs`（McpDomain）、`src-tauri/src/permission.rs`（ApprovalModeDomain）、`src-tauri/src/pet/mod.rs`（PetDomain）、`src-tauri/src/lib.rs`（declare_app_state 字段 9→3）。
- 散点收敛：`src-tauri/src/session/store.rs`（五个容器方法 + 测试）、`src/session/create/mod.rs`、`src/session/prompt/wait.rs`。
- 账本门：`src-tauri/src/session/prompt/ledger.rs`（门函数集）、`src/dispatcher/mod.rs`、`src/session/expiry.rs`、`src/session/prompt/{wait,ingest}.rs`、`src/runtime.rs`（字段收窄）。
- 代际门：`src/session/prompt/wait.rs`（`cancel_targets_snapshot_generation` + 映射 generation 复核）、`src/session/create/mod.rs`（SessionMapping.generation）。
- 测试：#703 并发交错（mcp_domain_tests）、#704 spill 清点（inbound.rs）、#705 4 键序列化（error.rs）、#706 中毒恢复/幽灵拒绝（lib.rs）、门 roundtrip（prompt/tests.rs）。
