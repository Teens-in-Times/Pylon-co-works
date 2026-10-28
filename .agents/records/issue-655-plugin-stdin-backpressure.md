# Dev Record — #655 插件 stdin 写入背压与 terminate 不被写入卡住

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-655-plugin-stdin-backpressure.md`

## 元信息

- issue：[#655 bug(plugin): 插件 stdin 写入无超时且持锁，terminate 抢同一把锁——插件可永久卡住且停不掉](https://github.com/Teens-in-Times/Pylon-co-works/issues/655)
- 分支：`fix/plugin-stdin-backpressure`（基于 `github/main` = `e1eced0c`）
- 提交范围：`3cd3fa6c`（L.md 单行登记）→ 本提交（`plugin_process/{mod,tests}.rs` + 本 record）
- 日期：2026-10-28
- 施工署名：Qoder（L.md 已登记）
- 关联：#656（同批 acp 写锁内同步 kill）、#657（同批残余同步 IO）、#653/#654（同批 expect/panic 清理）

## 目标与范围

**做**：stdin 写入改为「有界队列 + 专职写线程」，`write()` 不阻塞、队列满即报错；`terminate` 不再与写入争锁；`kill()` 的 `kill_and_wait` 移出 tokio worker；新增「子进程不读 stdin」回归用例。

**不做**：`ManagedChild` / Job Object 语义、pylon-acp 侧同步 kill（#656 另行处理）、按字节的队列预算、把写失败同步回报给当次 `write` 调用方。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/plugin_process/mod.rs` | `stdin` 字段改 `Mutex<Option<SyncSender<Vec<u8>>>>`；新增 `STDIN_QUEUE_DEPTH`、`spawn_stdin_writer`；`write` 改 `try_send`；`kill` 改 async + `spawn_blocking`；`terminate`/command 补 `.await` | 修改 |
| `src-tauri/src/plugin_process/tests.rs` | 三处 `kill(...)` 调用补 `.await`；新增 `stalled_stdin_writer_rejects_instead_of_blocking` | 修改 |
| `.agents/records/issue-655-plugin-stdin-backpressure.md` | 本记录 | 新增 |

## 方案要点

1. **根因分层**：写入阻塞只是表象，真正把「卡住」升级成「停不掉」的是 stdin 互斥被写调用长期占有；`terminate` 的 Stdin/Signal 分支和 `kill` 都要拿它。所以修法必须同时做到「写不阻塞调用线程」和「写不长期持锁」，只加超时不解决第二点（超时后线程仍卡在 `write_all` 上，锁仍在）。
2. **为什么是专职写线程而不是 `spawn_blocking`**：`spawn_blocking` 的超时只是让 await 返回，线程仍永久占住 blocking 池（默认上限 512）与 stdin 锁；`ChildStdin` 也不能在多次 `spawn_blocking` 之间安全搬来搬去。专职线程把阻塞隔离在进程自己的生命周期里：进程被杀 → 管道断开 → `write_all` 返回错误 → 线程退出。
3. **有界队列 + `try_send`**：队列深度 4（最坏驻留 4 × 16 MiB），`Full` 直接报错是明确背压信号，比「静默排队再超时」更早暴露下游不消费。锁只覆盖一次 `try_send`，`terminate` 拿锁不再可能被写卡住。
4. **EOF 语义保持**：`take()` 发送端 → 写线程排空队列后 drop `ChildStdin` → 子进程收到 EOF。与旧实现「直接 drop ChildStdin」对插件可见的行为一致，且排空保证已入队的 shutdown 帧不丢。
5. **kill 去同步**：先把 child 换成 `ManagedChild::empty()` 再 `spawn_blocking`；`empty().kill_and_wait()` 返回 `Ok(())`，因此重复 kill 仍幂等；monitor 看到空 child 直接退出，不与 kill 的 `finish_record` 抢状态。
6. **新用例**：fake agent `hang` 在读循环之前驻留、一个字节都不读 stdin；写 64 × 256 KiB。旧实现第一次写就会卡在 `write_all`（用例会以超时挂住而非快速失败），新实现数条之后即 `queue full`。随后 `terminate` 走默认 Stdin 关闭 → 2s 预算 → 强杀，断言 15s 内返回且状态 Exited。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 写入不阻塞调用线程，队列满即报错 | ✅ `stalled_stdin_writer_rejects_instead_of_blocking`（2.06s，含 2s shutdown 预算） |
| `terminate` 不被写入卡住、按时限完成 | ✅ 同上，15s 超时内返回并置 `Exited` |
| `kill_and_wait` 不在 async 上下文执行 | ✅ `spawn_blocking` |
| `cargo test -p pylon plugin_process::tests` | ✅ `9 passed; 0 failed` |
| `cargo fmt --check` | ✅ EXIT=0 |
| clippy | ✅ `bun run check:clippy` EXIT=0（`pylon` 新增 0，基线未改） |

## 测试处置

- 新增：`plugin_process::tests::stalled_stdin_writer_rejects_instead_of_blocking`。
- 修改（仅签名适配）：`cancellation_settles_pending_request`、`on_failure_restart_replaces_generation_and_recovers_rpc`、`job_object_kills_descendant_process_tree` 的 `kill(...)` 补 `.await`，断言不变。
- 既有 8 条 plugin_process 用例（JSON-RPC 往返、洪泛排空、候选包、取消、优雅关闭幂等、超时强杀、重启恢复、进程树回收、示例可运行）全绿。

## 证据

- commit：`3cd3fa6c`（L.md）→ 本提交
- 新用例单跑：`cargo test -p pylon stalled_stdin_writer_rejects_instead_of_blocking` → `1 passed`，2.06s
- 套件：`cargo test -p pylon plugin_process::tests` → `9 passed; 0 failed`，3.91s
- fmt：`cargo fmt --all --manifest-path src-tauri/Cargo.toml --check` → EXIT=0
- clippy：`bun run check:clippy` → EXIT=0（`pylon` current 1 == baseline 1；`check-await-holding` 17 文件 / 55 处）
- 反向验证：未回改复跑。旧实现在 hang 子进程上第一次 `write_all` 即阻塞（管道缓冲写满前的小写入会返回，随后永久阻塞），用例会挂住而不是断言失败；本次无法用「红/绿」对比，改以调用栈证据与用例行为说明（旧路径无队列，`write` 与 `terminate` 共用 `record.stdin` 互斥）。

## 与 spec 的偏差

无。

## 未解问题

1. **写失败改为异步可见**：`write` 现在只保证「已入队」，管道断开后调用方仍拿到 `Ok`，错误经 `stream-error`（stream=stdin）事件与后续请求超时/退出事件体现。前端若依赖同步写错误做插件健康判定，需要改为消费事件（本次未改前端）。
2. **队列满时的重试策略**由调用方决定（当前直接报错），未做自动退避重试。
3. `cancel()` / JSON-RPC shutdown 帧同样走队列；下游不消费时它们也会以 `queue full` 失败（非静默）。

## 并行交集

只碰 `src-tauri/src/plugin_process/{mod,tests}.rs` 与 `.agents/L.md`。与 #653（`pylon-acp`）、#654（`pylon-session`）、#656（`src/lib.rs` + acp 写锁）、#657（`plugin_cmds`/`export`/`agent_diagnostics`）文件域不重叠。
