# Dev Record — #653 终端注册表插入后二次查找的 panic

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-653-terminal-registry-panic.md`

## 元信息

- issue：[#653 bug(acp): 终端注册表插入后二次查找用 expect——与 clear() 竞态时 panic，release 下整进程退出](https://github.com/Teens-in-Times/Pylon-co-works/issues/653)
- 分支：`fix/terminal-registry-panic`（基于 `github/main` = `e1eced0c`）
- 提交范围：`a9fb289a`（L.md 单行登记）→ 本提交（`terminal_runtime.rs` + 本 record）
- 日期：2026-10-28
- 施工署名：Qoder（L.md 已登记）
- 关联：#414（id 计数锁不跨 `terminals` 锁的既有约束）、#655/#656/#657（同批后端体检登记）

## 目标与范围

**做**：`TerminalRegistry::insert` 在插入的同时交回实例；`create_shell` 用返回值，删掉二次查找与 `expect`。

**不做**：`clear()` 语义、dispatcher 侧 `create_shell → String` 的契约、竞态另一半（见「未解问题」）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-acp/src/terminal_runtime.rs` | `insert` 返回值改 `(String, Arc<TerminalInstance>)`，可见性收紧为模块内私有（无外部调用者）；`create_shell` 用返回值替换二次 `get + expect`；两条既有用例适配解构；新增 `insert_returns_registered_instance` | 修改 |
| `.agents/records/issue-653-terminal-registry-panic.md` | 本记录 | 新增 |

## 方案要点

1. **根因**：`create_shell` 在 `insert(...).await` 之后再次 `terminals.lock().await.get(&id)`。两次 await 之间 `clear()`（`lifecycle/stop.rs:35`，切 Agent / reload / 空闲回收）可以把刚插入的终端摘走，`expect` 落空；release `panic = "abort"` ⇒ 整进程退出，且没有任何用户可见错误。
2. **修法**：`insert` 内部构造实例后自己 clone 一份入表、把原 Arc 交回。这既是「插入即持有」，也顺手把 `insert` 的 id 生成与入表压成一段（id 计数锁仍不跨 `terminals` 锁的 await，#414）。
3. **为什么仍返回 id**：`create_shell` 对 dispatcher 的返回契约是 `Result<String, String>`（`host_tools_gate.rs:157` 用它做 host terminal 标识），所以返回 `(id, Arc)` 而不是只返回 Arc。
4. **测试助手顺带简化**：`insert_exited` 原来靠 `find(...).unwrap()` 拿实例，现在直接用返回值——同一个 bug 模式在测试里也不该留。
5. **可见性收紧**：`insert` 没有模块外调用者（`create_shell` 与测试都在本模块），却因为返回值带出私有的 `TerminalInstance` 触发 clippy `private_interfaces`。改为私有即可消除，不扩大 crate 公开面。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 无 `expect("terminal inserted before readers start")`，`create_shell` 无二次 `get` | ✅ |
| `cargo test -p pylon-acp` 全绿 | ✅ `188 passed; 0 failed`（含 `create_shell_drains_output_and_publishes_exit`、`kill_routes_through_owner_and_release_removes_terminal`、`clear_removes_all_terminals_and_reports_count`） |
| 新增用例：`insert` 交出的就是注册表里的实例 | ✅ `insert_returns_registered_instance` → `1 passed; 187 filtered out` |
| 格式 | ✅ `cargo fmt --all --check` EXIT=0 |
| clippy | ✅ `bun run check:clippy` EXIT=0（workspace 全量，见「证据」） |

## 测试处置

- 新增：`terminal_runtime::tests::insert_returns_registered_instance`（`Arc::ptr_eq` 断言插入返回值与 `find` 结果是同一实例）。
- 修改（仅签名适配，断言不变）：
  - 测试助手 `insert_exited`：改为解构 `(id, terminal)`，不再 `find().unwrap()`；
  - `registry_confines_operations_to_session_owner`：改为 `let (id, _) = insert(...)`。

## 证据

- commit：`a9fb289a`（L.md）→ 本提交
- 单测：`cargo test -p pylon-acp` → `test result: ok. 188 passed; 0 failed`，EXIT=0
  - 首次运行为 `187 passed; 1 failed`，唯一红是 `engine::outbound::tests::wire_bridge_records_both_directions_with_id_kind`，原因是缺 `pylon-fake-agent` 产物（`check:rust` 的既有前置）；按 `cargo build -p pylon-fake-agent --features test-agent` 补齐后全绿，与本次改动无关。
- 新增用例：`cargo test -p pylon-acp insert_returns_registered_instance` → `1 passed`，EXIT=0
- fmt：`cargo fmt --all --manifest-path src-tauri/Cargo.toml --check` → EXIT=0
- clippy：`bun run check:clippy` → EXIT=0
  - 首次运行为 EXIT=1：`pylon-acp | private_interfaces | src-tauri/pylon-acp/src/terminal_runtime.rs | type 'terminal_runtime::TerminalInstance' is more private than the item 'terminal_runtime::TerminalRegistry::insert'`（`new-fingerprint`，count 1）。`insert` 改私有后复跑 EXIT=0，基线未动。

## 与 spec 的偏差

无。

## 未解问题

竞态的**另一半**未处理：`clear()` 先快照 id 再逐个 remove，若 `insert` 落在这两步之间，该终端不会被清（进程留在旧 runtime 名下，直到下一次 `stop_agent_runtime` 才被清）。它不会 panic，只是一个有界的漏清窗口。要彻底收口需要给注册表加 closed/代际闸门（`clear` 置位、新 runtime 复位），属独立改动，未纳入本次范围。

## 并行交集

只碰 `src-tauri/pylon-acp/src/terminal_runtime.rs` 与 `.agents/L.md`。与 #655/#656（`src/plugin_process`、`src/lib.rs`）、#657（`plugin_cmds`/`export`/`agent_diagnostics`）文件域不重叠。
