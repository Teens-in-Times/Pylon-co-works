# Dev Record — #656 切 Agent 时 acp 写锁内同步 kill

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-656-acp-kill-outside-write-lock.md`

## 元信息

- issue：[#656 bug(agent): 切换/重载 Agent 时持 acp 写锁执行同步 kill，状态快照与命令全部排队](https://github.com/Teens-in-Times/Pylon-co-works/issues/656)
- 分支：`fix/acp-kill-outside-write-lock`（基于 `github/main` = `e1eced0c`）
- 提交范围：`d941e27f`（L.md 单行登记）→ 本提交（`lib.rs`、`lifecycle/stop.rs`、`session/prompt/wait.rs` + 本 record）
- 日期：2026-10-28
- 施工署名：Qoder（L.md 已登记）
- 关联：#655（同批「同步 kill 占住调用线程」清理）、#657（同批残余同步 IO）、#653/#654（同批 panic 清理）

## 目标与范围

**做**：`replace_agent_client` 把 `old_acp.kill()` 移出 acp 写锁，锁释放后 `spawn_blocking` 回收旧进程；`stop_agent_runtime` 与 Hermes force-recovery 两处 async 内同步 kill 一并改 `spawn_blocking`。

**不做**：`AcpClient::kill` / `ManagedChild::kill_and_wait` 实现与 Job Object 语义；给 kill 加超时；测试域的同步 kill。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/lib.rs` | 写锁块返回 `old_acp`，锁内删除 `kill()`，块后 `spawn_blocking(kill).await`（位于 dispatcher 启动前）；三处注释同步（含「锁内无 await」的既有断言） | 修改 |
| `src-tauri/src/lifecycle/stop.rs` | `snapshot_acp()` 后 `spawn_blocking(kill).await`，kill 在顺序契约中的位置不变 | 修改 |
| `src-tauri/src/session/prompt/wait.rs` | force-recovery 闭包改 `spawn_blocking`，按 Ok(Ok)/Ok(Err)/Err(JoinError) 记日志 | 修改 |
| `.agents/records/issue-656-acp-kill-outside-write-lock.md` | 本记录 | 新增 |

## 方案要点

1. **为什么不能「先 kill 再发布」**：原实现把 kill 放在发布新连接之前，是为了「旧进程死透再暴露新代际」。但 `kill_and_wait` 无超时（job 关闭 / `taskkill /T /F` + `wait()`），在写锁里等待会把所有 acp 读方（状态快照、`list_agents`、会话命令）一起排住。改为「退役为 `disconnected` 占位（锁内，fail-closed）→ 发布新连接（锁内）→ 锁外 kill」：中间态没有任何读方能拿到旧连接，旧 dispatcher 已在更早处 abort（旧 stdout 无消费者），因此「两个活连接同时可见」这一原注释所防的竞赛并未重现。
2. **为什么仍然在 dispatcher 启动之前完成 kill**：`start_notification_dispatcher` 移到 kill 之后调用，保留「旧进程先死、新 dispatcher 后起」的既有顺序，减少行为面变化。
3. **为什么不给 kill 加超时**：这是强杀/回收路径，超时只会让「进程还活着」变成静默遗留（且 Job Object 关闭本身很快）；问题的根因是**在哪等**（锁内/async worker），不是**等多久**。
4. **另外两处**：`stop_agent_runtime` 是 async 且不持 acp 写锁，但同步 `kill_and_wait` 仍会占住一个 tokio worker（同一类「阻塞调用出现在 async 上下文」）；Hermes force-recovery 的闭包同理。两处都改 `spawn_blocking`，语义与顺序不变。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 写锁块内不再出现 `kill()` | ✅ 锁内只留退役/发布/代际/状态/ledger；kill 在块后 |
| 同类 async 内同步 kill 移出 worker | ✅ `stop.rs`、`wait.rs` 均 `spawn_blocking` |
| `cargo test -p pylon` | ✅ `983 passed; 0 failed; 4 ignored` |
| lifecycle 子集（switch/reload/ghost 清理） | ✅ `45 passed; 0 failed` |
| `cargo fmt --check` | ✅ EXIT=0 |
| clippy | ✅ `bun run check:clippy` EXIT=0（`pylon` current 1 == baseline 1，未新增） |

## 测试处置

- 无新增用例，无既有用例改动。
- 既有覆盖：`lifecycle::` 45 条（含 `switch_to_same_agent_already_connected_is_idempotent`、`switch_to_non_active_agent_already_connected_skips_reconnect`、`reload_agents_cleans_up_ghost_runtimes_of_deleted_agents`）与全量 983 条通过。

## 证据

- commit：`d941e27f`（L.md）→ 本提交
- 全量：`cargo test -p pylon` → `983 passed; 0 failed; 4 ignored`，7.18s
- lifecycle：`cargo test -p pylon lifecycle::` → `45 passed; 0 failed`
- fmt：`cargo fmt --all --manifest-path src-tauri/Cargo.toml --check` → EXIT=0
- clippy：`bun run check:clippy` → EXIT=0（`check-await-holding` 17 文件 / 55 处，未新增裸 allow）
- 结构证据（改动前）：`src/lib.rs:585` 位于 `runtime.acp.write()`（:547–:638）块内；改动后该块内无 `.kill()`。

## 与 spec 的偏差

无。

## 未解问题

1. **「读方不被阻塞」无专项计时用例**：`kill_and_wait` 在正常环境是毫秒级（job 关闭 / taskkill），无法在不改 `AcpClient` 的前提下造出「足够长的 kill」来稳定观测锁等待；本次以「kill 不在锁内」这一结构性事实保证，并靠既有 lifecycle 用例守住行为不变。若后续要量化，需要给 `AcpClient` 注入可观测的 kill 钩子。
2. `kill_and_wait` 依旧无超时上限（进程在 D 状态等极端情况下 `wait()` 可长期不返回）。本次把它移出锁与 worker；超时/放弃语义属单独决策（放弃 wait 会留下僵尸句柄）。

## 并行交集

碰 `src-tauri/src/lib.rs`、`src-tauri/src/lifecycle/stop.rs`、`src-tauri/src/session/prompt/wait.rs` 与 `.agents/L.md`。与 #655（`src/plugin_process`，同为同步 kill 但文件域不同）、#653（`pylon-acp`）、#654（`pylon-session`）、#657（`plugin_cmds`/`export`/`agent_diagnostics`）不重叠。
