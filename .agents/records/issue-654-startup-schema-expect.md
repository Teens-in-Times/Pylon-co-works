# Dev Record — #654 启动期 schema 校验 pk 清点去 expect

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-654-startup-schema-expect.md`

## 元信息

- issue：[#654 bug(session): 启动期 schema 校验用 expect——消息库损坏时闪退，用户拿不到任何诊断](https://github.com/Teens-in-Times/Pylon-co-works/issues/654)
- 分支：`fix/startup-schema-panic`（基于 `github/main` = `e1eced0c`）
- 提交范围：`5cdad119`（L.md 单行登记）→ 本提交（`migrations.rs` + 本 record）
- 日期：2026-10-28
- 施工署名：Qoder（L.md 已登记）
- 关联：#653（同批 panic 源清理）、#655/#656/#657（同批后端体检登记）

## 目标与范围

**做**：`primary_key_columns` 返回 `Result<Vec<String>, SessionError>`，`PRAGMA` 的 prepare / query_map / 逐行读取全部经 `repo_err` 上抛；三个调用点加 `?`；新增坏库回归用例。

**不做**：迁移链语义、`validate_quick_check` / `validate_db_header`（本就返回 `Result`）、上层错误展示策略（只保证「不再 panic、错误能上抛」）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-session/src/msg_repo/migrations.rs` | `primary_key_columns` 签名与错误处理；`validate_schema_objects` 三处 `?`；文件尾新增 `#[cfg(test)] mod tests`（坏库用例） | 修改 |
| `.agents/records/issue-654-startup-schema-expect.md` | 本记录 | 新增 |

## 方案要点

1. **根因**：`connect()`（启动路径）= `validate_quick_check → migrate → validate_schema_objects → validate_db_header`。后者三兄弟都返回 `Result`，唯独 pk 清点用 `expect`；坏库/占用/IO 错误时在 release（`panic = "abort"`）直接把进程带走，且发生在 UI 起来之前。
2. **错误分类**：沿既有 `repo_err`（`msg_repo/mod.rs:374`，`SessionError::Generic("message repo: …")`），与同文件其余 SQL 失败同一条码路径；不新增错误变体，避免改动前端/上层对错误码的分支。
3. **为什么三处一起改**：prepare 失败、query_map 失败、迭代中单行 `get` 失败是同一条「库读不出来」语义；只改一处仍留 panic 面。`collect::<Result<Vec<_>, _>>()` 把逐行错误收敛到一次映射。
4. **用例选型**：`PRAGMA table_info` 在正常库上几乎不失败，故用「非 SQLite 内容 + `Connection::open`」造真实的可读但不可查库——`open` 是惰性的，错误落在第一条语句（实测返回 `SqliteFailure(NotADatabase)`），正好覆盖 prepare 分支。临时文件路径沿用仓库既有 `temp_dir + pid + 时间戳 + 计数` 写法。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `primary_key_columns` 返回 `Result`，无 `expect` | ✅ |
| 三处调用点经 `?` 上抛 | ✅ |
| 新增用例：不可查询库返回 `Err` 而非 panic | ✅ `primary_key_inventory_reports_unreadable_db` |
| `cargo test -p pylon-session` 全绿 | ✅ `223 passed; 0 failed` |
| `cargo fmt --check` | ✅ EXIT=0 |
| clippy | ✅ `bun run check:clippy` EXIT=0（`pylon-session` 新增 0，基线未改） |

## 测试处置

- 新增：`msg_repo::migrations::tests::primary_key_inventory_reports_unreadable_db`——把非 SQLite 文本写进临时 `.db` 后打开，断言 `primary_key_columns` 返回 `SessionError::Generic` 且消息带 `message repo` 前缀。
- 既有用例无改动；`migrate_*` 系列（正常库路径）全部保持绿。

## 证据

- commit：`5cdad119`（L.md）→ 本提交
- 单测：`cargo test -p pylon-session` → `test result: ok. 223 passed; 0 failed`，EXIT=0
- 新用例：`cargo test -p pylon-session primary_key_inventory_reports_unreadable_db` → `1 passed; 222 filtered out`
- fmt：`cargo fmt --all --manifest-path src-tauri/Cargo.toml --check` → EXIT=0
- clippy：`bun run check:clippy` → EXIT=0（`pylon-session` current 0 / baseline 1 未变；`check-await-holding` 17 文件 / 55 处）
- 反向验证：旧实现等价语句为 `conn.prepare(...).expect("prepare pk inventory")`；新用例能拿到 `Err` 即证明同一语句在该连接上确实报错，旧路径必然 panic。未回改代码复跑（回改后新签名无法编译，需另写一份临时 expect 链，收益低）。

## 与 spec 的偏差

无。

## 未解问题

本次只保证错误能上抛到 `MsgRepo::open` 调用方。上游（`persistence_bootstrap` / `runtime`）在收到 `SessionError::Generic` 时是否给出「库损坏，已备份重建」一类可操作诊断，属 UI/启动错误页范畴，未在本 issue 范围内核对。

## 并行交集

只碰 `src-tauri/pylon-session/src/msg_repo/migrations.rs` 与 `.agents/L.md`。与 #653（`pylon-acp`）、#655/#656（`src/plugin_process`、`src/lib.rs`）、#657（`plugin_cmds`/`export`/`agent_diagnostics`）文件域不重叠。
