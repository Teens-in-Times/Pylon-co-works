# Dev Record — #680–#685 运行期身份与所有权收口

> 入库保留。spec 见 `.agents/spec/issue-680-685-runtime-identity-lifetime.md`（不入库）。

## 元信息

- issue：#680、#681、#682、#683、#684、#685
- 分支：`kumo/prometheus`
- 提交范围：`0a0fa4f0..<head>`（单 PR）
- 日期：2026-10-29

## 目标与范围

六条 issue 同属「运行期身份在错误时间/错误作用域解析」与骨架残留，合并为一批修复：

- #680：崩溃自动重连以本 runtime 注册 id 为身份，不再从全局 `active_agent` 反推。
- #681：启动默认连接在 `switch_lock` 内重取 `(active id, AgentDef, runtime)`，active 变化即放弃；dispatcher 解析不到 agent id 时 fail-closed，不再 `"unknown"` 落库。
- #682：draft flush 通道关闭 → 泵 `Stop`；换代以显式 supersede 信号立即收敛在途请求，不依赖 5s 超时。
- #683：`set_mcp_servers` / `reload_agents` 的同步文件 IO 移出 reactor，MCP 写序用版本门保证 last-write-wins。
- #684：fork 关系挂 per-runtime（有界、按创建时间淘汰）；capability consumers 与 protocol adapter registry 由 `AppState` 注入；`SNAPSHOT_STORE`/`INSTANCE_REGISTRY` 标注为进程级产品单例。
- #685：`data_dirs` typed 错误；home 解析单源到 `pylon-foundations`；删空 capture 表项；去掉 `strip_persona_prefix` 伪参数；compact key 预计算。

**不做**：wire 契约 / 诊断 payload 形状 / capability 协商语义 / 实例预算数值 / fail-closed 行为 / `restore_session_state` 输出 / 既有错误码拼写 / ACP 传输层 / 帧分类 / `OnceLock` 日志定时器；不重排 dispatcher 路由与 biased 优先级。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/dispatcher/crash_reconnect.rs` | handler 新增 `agent_id`；守卫改本 runtime 身份；AgentDef 缺失/锁中毒走 `abandon_reconnect` | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | `NotificationPump::new` 返回 `Option`；agent id 由 `Arc::ptr_eq` 解析后传入 handler；draft 通道关闭 → `Stop`；`strip_persona_prefix` 去伪参数 | 修改 |
| `src-tauri/src/lib.rs` | 启动默认连接锁内重取三元组；`AppState` 注入消费者/适配器；`data_dirs` typed 错误；`clone_handles()`；消费者集合默认值 | 修改 |
| `src-tauri/src/runtime.rs` | `draft_flush_supersede` 换代信号；per-runtime `fork_links`；supersede 测试 | 修改 |
| `src-tauri/src/lifecycle/mcp.rs` | `McpPersistOrder` 版本门；`spawn_persist_mcp_servers`（`spawn_blocking`）；`mcp_persist_path` typed；写序测试 | 修改 |
| `src-tauri/src/lifecycle/config_cmds.rs` | `reload_agents` 读配置改 `spawn_blocking` | 修改 |
| `src-tauri/src/session/fork.rs` | fork 关系 per-runtime + `MAX_FORK_LINKS` 淘汰；测试自建 runtime | 修改 |
| `src-tauri/src/session/session_state.rs` | `capture: Option<fn>`，删除两个空捕获 | 修改 |
| `src-tauri/src/protocol_adapter/mod.rs` | `ProtocolAdapterRegistry` 所有权化；compact key 预计算 | 修改 |
| `src-tauri/pylon-acp/src/negotiated.rs` | 删除进程级 `CAPABILITY_CONSUMERS` | 修改 |
| `src-tauri/src/acp/mod.rs` | 快照辅助接收 `consumers` 参数 | 修改 |
| `src-tauri/pylon-foundations/src/home.rs` | home 解析唯一实现 | 新增 |
| `src-tauri/pylon-foundations/src/lib.rs` | 注册 `home` 模块 | 修改 |
| `src-tauri/pylon-core/src/agent_detection/evidence.rs` | `resolved_home_dir` 委托 `pylon-foundations` | 修改 |
| `src-tauri/src/external_history/mod.rs` | 删除本地 `home_dir` 副本 | 修改 |
| `src-tauri/src/acp/{instance_registry,mod}.rs`、`src-tauri/src/agent/detection.rs` | 进程单例说明 / 消费者参数 | 修改 |
| `src-tauri/src/{lifecycle,session,dispatcher,permission}/*` | 消费者/适配器调用点改为 `AppState` 注入 | 修改 |
| `src-tauri/src/{browser/agent_cmds,pet/cmds,plugin_cmds/store}.rs` 等 | `data_dirs` typed 错误适配 | 修改 |
| `src-tauri/src/{test_utils,p1_wire_regression_tests}.rs` | 测试适配 per-test 注册表/注入 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md`、`Pylon-项目架构参考.md` | 同步所有权与重连/泵语义 | 修改 |

## 方案要点

### #680 崩溃重连身份

`NotificationPump::new` 已用 `Arc::ptr_eq` 找到 runtime 的注册 id，现在把它传入 `CrashReconnectHandler`。spawn 出的重连任务不再读 `active_agent` 当身份：

- 守卫：`active_agent == self.agent_id`（后台非 active runtime 不自动重连，交由 #379 懒连接自愈——issue 明示期望）；
- AgentDef：`agents.get(&self.agent_id)`；
- 事件身份：崩溃 `AGENT_STATUS` 走新增的 `agent_status_payload_for(runtime, Some(&agent_id))`，`agentId`/`agentName`/`sessionBindings` 都标本 runtime，不再被标成当前 active（非 active runtime 崩溃时旧实现会指错 agent）；
- 异常退出路径（锁中毒、AgentDef 被 reload 删除）不再裸 `break`：warn + `emit_agent_status_for(..., Some(agent_id), Crashed, lastError)` 诊断；
- 拿到 `agent_lifecycle` 后除复查 `status == Crashed` 外**再复查 `active_agent`**：排队等锁期间用户可能已 switch，避免重连成功后把 active 顶回本 agent；
- 三处 `agent_runtime` / `active_agent` 锁中毒均 warn 后 `into_inner`（不再静默 `.unwrap_or(false)` 把中毒当"不需要重连"）。

`AppStateHandles` 手写重建改 `clone_handles()`（宏按共享字段表生成，新增字段不会漏拷贝）。

### #681 启动连接与 dispatcher fail-closed

- setup 阶段只用 `active_id` 查注册表存在性决定是否 spawn；
- 任务内拿到 `switch_lock` 后重读 `active_id_now`，与 setup 值不等则 info 日志并放弃；再重取 AgentDef 与 runtime（缺失时 warn 放弃），最后取 `agent_lifecycle` 连接。锁序仍是 `switch_lock → agent_lifecycle`。
- `NotificationPump::new` 解析不到注册 id → `None`；`start_notification_dispatcher` 写 error 日志 + runtime log 后返回，不启动泵。

### #682 draft flush 收口

- `draft_flush_rx.recv()` 返回 `None` → `PumpStep::Stop`（通道关闭即停泵，不再恒 ready 空转）。
- `AgentRuntime` 新增 `watch::Sender<u64>`：`install_draft_flush_channel` 每次换装递增；`flush_draft_before_terminal` 在**同一把槽锁内**订阅换代信号并读 sender，再 `select!` 等回复 / supersede / 5s 兜底。换装即 `Err("superseded")`。
- 换代递增与订阅都收进槽锁（而非先解锁再 bump）：否则连续两次换装时，第一次的滞后 bump 可能落在「已订阅当前代」的 flush 之后，制造伪 `superseded`。

### #683 配置写盘出 reactor

- `McpPersistOrder { latest: AtomicU64, gate: Mutex<()> }`：`begin(&tokio::sync::MutexGuard<'_, ()>)` 在 `mcp_write_lock` 临界区内登记序号（签名强制持有写序锁，不再靠注释约定），序号顺序 = 内存提交顺序；`spawn_blocking` 内 `begin_write(version)` 取闸并复查 `latest == version`，被更晚写超越则跳过（磁盘最终 = 最后一次 set）。
- 磁盘 IO 不再持 tokio 锁；路径解析失败仍只 warn（与原实现行为一致）。`mcp_write_lock` 字段文档同步改为「锁内只做内存提交 + 序号登记」。
- `reload_agents` 的 `agent_config::load*` 包 `spawn_blocking`，`ConfigError` 分支不变。

### #684 注册表所有权

- fork：`AgentRuntime.fork_links`，`MAX_FORK_LINKS = 1024`，满额淘汰 `(created_at, child source)` 最小项（时间粒度相同时次序确定）；来件本身比现存全部更旧（时钟回拨）则不挤掉更晚记录。随 runtime 生命周期回收。
- capability consumers：`AppState.capability_consumers`，`NegotiatedCapabilitySnapshot::from_parts` 接收显式集合；`pylon-acp` 不再有可变全局表。`TestStateBuilder` 新增 `with_capability_consumers` 覆盖入口。
- protocol adapters：`ProtocolAdapterRegistry` 由 `AppState` 持有，`with_builtin_adapters()` 在构造时注册 peri/hermes；dispatch/catalog/应答都走注入实例。
- `SNAPSHOT_STORE`（检测 TTL 缓存）与 `INSTANCE_REGISTRY`（实例预算）保留进程单例（产品语义），文档如实说明：预算语义用例用独立构造，而走真实连接路径的用例仍共享全局 8 份配额。

### #685 骨架小批

- `data_dirs()`/`data_dirs_cloned()` → `Result<_, PylonError>`，未初始化映射 `PylonError::Protocol("data dirs not initialized")`（沿用 `protocol_error`，message 不变）。
- 新增 `PylonError::raw_message()`：把错误嵌入既有字符串/日志时用载荷原文，保持历史文案逐字不变（wire 序列化仍走 `Display`）；`browser`/`docs_sheet`/`plugin_cmds`/`pet`/MCP 路径等站点改用之——typed 化不造成用户可见文案漂移。
- home 解析：`pylon_foundations::home::{resolve_home_dir, home_dir}`；`pylon-core` 证据与 `external_history` 共用。
- `SessionStateEntry.capture` → `Option<fn>`，configOptions/modes 捕获为 `None`（来源在 `apply_session_response`）。
- `strip_persona_prefix(text)` 删除未使用参数（行为不变：只按 `\n\n---\n\n` 分隔符剥离）。
- `compact_supported_client_methods()` 以 `OnceLock<Vec<String>>` 启动时预计算，`looks_like_interaction_method` 不再逐帧构造约 10 个字符串。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| #680 后台 runtime 崩溃不再拿 active 的 AgentDef 重连；放弃路径有日志与状态诊断 | 通过（代码路径 + 编译期参数强制；无新增单测，见「测试处置」） |
| #681 active 变化时启动连接放弃；泵解析不到 id 不启动且有 error 诊断 | 通过（代码路径 + 编译期 `Option` 强制；无新增单测） |
| #682 通道关闭 → `Stop`；换代 ≤1s 收敛为 `superseded` | 通过（`draft_flush_request_is_superseded_when_channel_is_replaced`） |
| #683 写盘出 reactor；并发写 last-write-wins | 通过（`persist_order_skips_superseded_versions`） |
| #684 fork 有界；注册表 per-test；未新增白名单豁免 | 通过（`fork_link_registry_is_bounded_and_evicts_oldest`；clippy 基线外新增 0） |
| #685 IPC 错误仍 `{code,message}`；`restore_session_state` 逐字节不变；`strip_persona_prefix` 行为不变 | 通过（既有行为测试断言未改；`data_dirs` message 逐字保留） |
| `bun run check:clippy` 全绿 | 通过（见证据） |
| `cargo test --workspace --lib` 全绿 | **除 1 条既有环境 flake 外全绿**（`managed_probe_cleanup_kills_descendant_processes`，仓库外可复现的 `Start-Process` 30.06s 延迟；单跑 139/139 通过，见证据） |
| `bun run check:rust`（fake-agent / workspace lib / build / acp-shadow / fmt） | 上述 flake 导致整条脚本 exit 101；其余各步单独执行为绿（见证据） |

## 测试处置

- 新增：
  - `runtime::tests::draft_flush_request_is_superseded_when_channel_is_replaced`（#682）
  - `lifecycle::mcp::tests::persist_order_skips_superseded_versions`（#683）
  - `session::fork::tests::fork_link_registry_is_bounded_and_evicts_oldest`（#684）
  - `pylon_foundations::home::tests::explicit_home_wins_over_environment`（#685）
  - `test_utils::tests::builder_capability_consumers_injected_and_overridable`（#684，注入集合默认含 SessionFork + 可覆盖）
- 修改（契约/签名变更，断言不变）：
  - `dispatcher` 4 个 `strip_persona_prefix` 测试去掉 persona 参数；
  - `protocol_adapter` 注册表测试改为 per-test `ProtocolAdapterRegistry`；
  - `test_utils::install_process_registrations_is_idempotent` 改为检查内置注册表；
  - `p1_wire_regression_tests` 不再注册进程级 adapter；
  - `session::fork` 两个用例删除进程级消费者注册。
- 删除：无（仅删除两个空 capture 函数与进程级注册 API）。

## 证据

- 测试：
  - `bun run check:clippy`：exit 0；`pylon` crate `added: []`（current 1 = baseline 1）；其余 crate `added: []`；`check-await-holding: 通过（17 文件 / 55 处 HeldAcrossAwait，全部与清单一致；裸 allow 0 处）`。
  - `cargo test -p pylon-fake-agent --features test-agent`：11 passed。
  - `cargo test --workspace --lib`：`pylon` 991 passed（4 ignored）、`pylon-acp` 192、`pylon-agent-history` 4、`pylon-canonical-types` 9、`pylon-compute` 36、`pylon-core` 138 passed + 1 failed。
    唯一失败为既有环境型 flake `pylon-core agent_detection::tests::managed_probe_cleanup_kills_descendant_processes`（超时判据 30s；失败时该用例固定耗时 30.04–30.07s）。单独运行 `cargo test -p pylon-core --lib`：**139 passed / 1.17s**，同一用例连跑 3 次 0.47–0.55s。
  - 已定位为**仓库外环境因素**：在同一 shell 内 `powershell.exe -NoProfile -Command "Start-Process ping.exe -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru"` 在 `cargo test -p pylon --lib` 之后固定耗时 **30.06s**（干净 shell 首次测量 60.8s；无 pylon 测试前则为 0.78s 或 0.5s）。即 `Start-Process`（ShellExecuteEx）的启动延迟偶尔与用例 30s 就绪预算持平/超出，与本次改动无关（本 PR 未触碰 `pylon-core` 的进程探测代码，仅改了 home 解析）。
  - `cargo build`：exit 0（1m33s）。
  - `bun run check:acp-shadow`：exit 0。
  - `cargo fmt --all -- --check`：exit 0。
  - `bun run check:docs`：exit 0。
- 手工验证：未做 WebView2 实机验收（改动为后端身份/并发与骨架，单测与门禁覆盖；见「未解问题」）。

## 与 spec 的偏差

- 未做 WebView2 实机验收；本文改动集中在后端，UI 行为无变化。
- #680/#681 无新增专测：现有测试基建不容易稳定构造「后台 runtime 崩溃 + active 切换」的完整台架，靠编译期类型（`Option` 强制、`agent_id` 参数）与既有 dispatcher/lifecycle characterization 测试兜底。

## 未解问题

- #680 语义变更：后台非 active runtime 不再自动重连（issue 要求），改由 #379 懒连接在下次发送时自愈。若产品希望后台也保持热连接，需要另行设计。
- #683 残余同步 IO：`lifecycle/config_cmds.rs` 中 `config_revision_for_path` / `read_config_document` 等少量 `std::fs` 读取仍在命令线程（issue 只点名 `set_mcp_servers` 与 `reload_agents`，这些调用点位于同一层但不在验收范围）。建议另开 issue 统一收口到 `spawn_blocking` 或 `tokio::fs`。
- 既有测试环境 flake（非本 PR 引入）：`pylon-core` 的 `managed_probe_cleanup_kills_descendant_processes` 以 30s 为就绪预算，而本机 `powershell Start-Process ping.exe` 的实测启动延迟可达 30.06s（在 pylon 测试之后复现，仓库外直接测量）。它在 `cargo test --workspace --lib` 中稳定失败、单独运行稳定通过，导致 `bun run check:rust` 无法整体变绿。建议另开 issue：把探针用例的「后代进程」改为不依赖 ShellExecuteEx 的启动方式（如 `cmd /c start` 或原生双进程夹具），而不是继续上调超时。

## 并行交集

`src-tauri/src/lib.rs`、`dispatcher/mod.rs`、`runtime.rs`、`lifecycle/{mcp,config_cmds}.rs`、`session/{fork,session_state}.rs`、`protocol_adapter/mod.rs`、`pylon-acp/src/negotiated.rs`、`pylon-foundations/{lib,home}.rs`、`docs/说明书/*`。
