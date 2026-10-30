# Dev Record — #702~#707 后端对抗性审查修复批次（含 #707 骨架 A/B/C）

> spec（`.agents/spec/702-707-backend-review-batch.md`，一次性不入库）的目标、范围与验收结论在此承接。

## 元信息

- issue：#702 #703 #704 #705 #706 #707
- 分支：`fix/backend-review-702-707`（隔离工作树 `G:/Project/prism-team-workdir/prism-backend-review`）
- 提交范围：`afac773da..<head>`（基准 = github/main）
- 日期：2026-10-31

## 目标与范围

修复 2026-10-30 后端对抗性审查登记的四个缺陷（#702 代际自校验残余 / #704 spill 遥测缺口 / #705 错误顶替 / #706 三散点纪律），并实施 #707 骨架提案 A（写序锁域化）/ B（session 散点锁收敛）/ C（turn 账本宿主单点门）；#703 由 A 步结构性消化。

**不做**：wire/IPC 命令面/事件名/既有错误码词表、SQLite schema、AgentRuntimeManager/DashMap、crate 依赖方向、`.github/workflows/ci.yml`、`pylon-foundations`、config_write_lock 域化（理由见 #707 评论）、HeldAcrossAwait 新增使用点。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/prompt/wait.rs` | #702 cancel 闭包代际自校验（`cancel_targets_snapshot_generation`）；映射→发送间代际复核；#705 FailurePublish 构造；advance_round/取消清除/注入轮次读/liveness 读改走 store/ledger 门 | 修改 |
| `src-tauri/src/session/create/mod.rs` | `SessionMapping.generation`；ensure/create 复核；槽位预检收敛 `slot_headroom` | 修改 |
| `src-tauri/src/session/create/revive.rs` | SessionMapping 填 generation | 修改 |
| `src-tauri/src/session/store.rs` | #707-B 五容器方法（touch_for_prompt/begin_turn_state/inject_round/last_activity/slot_headroom）+ 测试 | 新增 |
| `src-tauri/src/session/prompt/ledger.rs` | #707-C 门函数集（begin_turn/settle_active_for_session_defensively/note_session_activity/drop_generation/turn_in_flight） | 新增 |
| `src-tauri/src/session/prompt/mod.rs` | 门函数 crate 级 re-export | 修改 |
| `src-tauri/src/session/prompt/ingest.rs` | defensive settle 走门 | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | handle_session_update 账本参数改 &AgentRuntime 走门；drop_generation 走门；pet 域访问器 | 修改 |
| `src-tauri/src/session/expiry.rs` | turn_in_flight 读走门 | 修改 |
| `src-tauri/src/runtime.rs` | `turn_ledger` 字段 pub → pub(crate)（#707-C） | 修改 |
| `src-tauri/src/lifecycle/mcp.rs` | #707-A `McpDomain`（write_lock+persist_order+双槽同锁）+ set_mcp_servers 域化 + 测试 | 新增/修改 |
| `src-tauri/src/permission.rs` | #707-A `ApprovalModeDomain` + set/get/restore 走域 + 测试 | 修改 |
| `src-tauri/src/pet/mod.rs`、`src/pet/cmds.rs` | #707-A `PetDomain` + persist/get/action 走域 + 测试 | 修改 |
| `src-tauri/src/lib.rs` | declare_app_state 字段 9→3（mcp/approval/pet 三域）；#706 active_runtime 例外二恢复、`ingest_agent_registered` 幽灵守卫；对应测试 | 修改 |
| `src-tauri/src/error.rs` | #705 `FailurePublish` 变体 + 手写 Serialize（FailurePublish 4 键、其余 2 键逐字节不变）+ 测试 | 修改 |
| `src-tauri/pylon-acp/src/engine/inbound.rs` | #704 pump shutdown 退出清点 spill 残留（`abandon_spill_leftovers`）+ 测试 | 修改 |
| `src-tauri/src/lifecycle/mod.rs` | pet 域访问器（on_agent_connected 位点） | 修改 |
| `src-tauri/src/test_utils.rs`、`src/test_harness.rs` | approval_mode→`approval.mode()`、runtime_mcp→`mcp.current_servers()` 断言等价改写（行为不变） | 修改 |
| `docs/说明书/Pylon-模块维护地图.md`、`Pylon-项目架构参考.md` | #352 清除点语义更新、#702/#705/#707-B/C 表述同步 | 修改 |
| `.agents/decisions/0039-backend-skeleton-domainization.md` | ADR | 新增 |

## 方案要点

1. **#702**：等待循环 cancel 闭包在发送前对快照客户端做 `client_generation()` 自校验（与 Hermes force-kill 闭包、cancel_prompt 命令同纪律）；`SessionMapping` 携带 mapping generation，prompt 管线在 ingest 用户消息**之前**复核「映射代际 == 当前代际」，失配以结构化 stale 错误拒绝（journal 不落错误配对行）。
2. **#704**：审查定位修正——`None` 分支退出时 spill 必空（attempt=None ⟺ 双 lane 空），真实缺口在 **Full 分支的 shutdown break**；修复为退出前 `abandon_spill_leftovers` 清点入 `closed_dropped`（与下游关闭分支同账）。
3. **#705（方案 A，代理决策）**：持久层错误保持主导（wire code 不变），手写 `PylonError::Serialize` 为 `FailurePublish` 变体 additive 追加 `originalCode`/`originalMessage` 两键；其余变体 2 键逐字节不变。方案 B（原始错误优先）备而未采，PR 中供复议。
4. **#706**：advance_round + cancel 清除合并 `begin_turn_state` fail-closed（#331 例外一）；`active_runtime` 中毒 `into_inner` 恢复（#331 例外二）；ingest 绑定目标注册表存在性守卫（未知 id 拒绝，不建幽灵 runtime——清理只挂在配置 diff，未配置 id 永不回收）。
5. **#707-A**：三域对象；MCP 读路径 miss 重算与 commit 共享单一 slots 锁（#703 竞态不可表达）；config_write_lock 留守顶层（agents/active_agent 读面横跨全仓，收益/风险比不划算，供复议）。
6. **#707-B**：prompt 管线 sessions 散点锁收敛 store 容器方法；cancel 清除点前移至发送前（prompt_gate 串行化下可观察行为等价，发送失败路径多清一次无消费者的陈旧标志）。
7. **#707-C**：账本写路径/跨域读单点门 `session::prompt::ledger`；`handle_session_update` 的 `turn_ledger` 参数改 `&AgentRuntime`；字段收窄 pub(crate)——grep 证据：src 非 test 代码 `turn_ledger` 直呼点仅剩 runtime.rs 构造/cold_mount_facts（字段宿主自身）与门内。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test --workspace --all-targets` 全绿，既有行为测试未改语义 | ✅ 1003 passed / 0 failed / 4 ignored（两轮：首轮 1002+1 处新测试自身算错修正后全绿） |
| `check:clippy` 相对基线零新增 | ✅（见下方证据输出） |
| #703 竞态以域方法不可表达 | ✅ McpDomain 单一 slots 锁 + 并发交错压力测试 |
| #702 代际门 | ✅ 纯函数用例 + SessionMapping.generation 贯通 |
| #704 shutdown 清点 | ✅ 确定性用例（closed_dropped=2，dropped_total=0） |
| #705 4 键序列化 | ✅（含其余变体 2 键回归断言） |
| #706 三处 | ✅ 中毒恢复 / fail-closed / 幽灵拒绝各有用例 |
| A 字段收敛 | ✅ app_only+shared 平铺 9→3（runtime_mcp/mcp_wire/mcp_write_lock/mcp_persist_order + approval_mode/approval_mode_persisted/approval_mode_write_lock + pet/pet_write_lock → mcp/approval/pet） |
| C 门 grep 清零 | ✅（证据见上方案要点 7） |
| 说明书同步 / ADR / 开发记录 | ✅ |

## 测试处置

修改的既有测试（均为域访问器等价改写，语义不变）：`test_utils.rs` builder_bare_defaults/build_app_state_single_construction_point（`runtime_mcp.is_none()` → `mcp.current_servers().is_empty()`；approval_mode 直读 → 域访问器）；`session/mod.rs` mcp_wire_cache 两用例（直写 mcp_wire/runtime_mcp → 域 commit/首读回填）；`test_harness.rs` approval_mode 置位一行。新增测试逐个：`failure_publish_carries_original_error_and_keeps_2_key_contract`、`cancel_targets_snapshot_generation_gates_stale_connections`、`turn_ledger_gate_begin_in_flight_and_drop_generation`、`shutdown_abandons_spill_leftovers_with_explicit_accounting`、`wire_read_miss_backfills_hit_short_circuits_and_commit_converges`、`concurrent_commit_and_wire_read_converge_to_last_commit`、`pet_domain_slot_is_shared_and_write_lock_is_exclusive`、`approval_mode_domain_defaults_match_production`、`touch_for_prompt_reads_mapping_and_refreshes`、`begin_turn_state_advances_and_fails_closed`、`inject_round_and_slot_headroom_contract`、`active_runtime_recovers_from_poisoned_active_agent`、`ingest_agent_registered_rejects_unknown_and_poisoned`。

## 证据

- commit：本 PR 提交列表（pathspec 分域提交）。
- 测试：`cargo test --workspace --all-targets` → 13 个 target 全部 `test result: ok`，合计 1003 passed / 0 failed / 4 ignored。
- clippy：`node scripts/check-clippy.mjs`（等价 `bun run check:clippy`，无 node_modules 环境直跑）→ 每 crate 零新增诊断。
- grep：`grep -rn "runtime.turn_ledger\." src --include=*.rs`（排除 cfg(test) 与门自身）→ 0 直呼点。

## 与 spec 的偏差

1. #704 审查定位修正：issue 描述的「None 分支 overloaded 退出」处 spill 必空，真实缺口在 Full 分支 shutdown break——按实际缺口修复并在 issue 评论更正。
2. #705 方案 A 为用户整体授权下的代理决策（spec 未决问题），PR 明示供复议。
3. config_write_lock 未域化（spec「不做什么」已预声明），#707 评论供挑战。
4. `handle_session_update` 参数 `turn_ledger: &Arc<TurnLedger>` → `&AgentRuntime`（spec 未点名，属 C 步收敛的必要连带）。

## 未解问题

- #705 方案 A/B 取舍待仓库主复核（当前实现 A）。
- config_write_lock 是否值得域化（agents/active_agent 读面 50+ 触点）留待 #707 讨论。

## 并行交集

- `src-tauri/src/test_utils.rs`（#602 声明域）：仅 4 行域访问器等价改写（258/415 区段），与 #602 的退出码治理（spawn 逻辑区段）无重叠。
- 共享 target 目录：本轮清理过 `target/debug/incremental`（17GB，磁盘满 os error 112；incremental 缓存无语义，双方下次构建略慢）。
- 隔离工作树施工，共享树前端（#699/#708）零接触。
