# Dev Record — #672 终端输出有界缓冲

> 入库保留。产出路径：`.agents/records/issue-672-terminal-output-buffer.md`

## 元信息

- issue：[#672 perf(acp): 终端输出每来一块就 memmove 整个 1MB 窗口，reader 线程还逐块 block_on 回异步运行时](https://github.com/Teens-in-Times/Pylon-co-works/issues/672)
- 分支：`perf/terminal-output-buffer`
- 日期：2026-10-29
- 施工署名：Qoder

## 根因

`TerminalInstance::append_output` 每次追加后都用 `enforce_output_limit` 做
`text.drain(..start)`，把整个可见窗口（默认 1MB）前移一次。reader 每读 8KB 调一次，
于是每 8KB 输入换 1MB memmove（≈128× 写放大）。与此同时 reader 是 `spawn_blocking`
线程，每块都 `Handle::current().block_on(...)` 回异步运行时抢 tokio Mutex——输出越密，
blocking 线程往 reactor 里塞的任务越多。

截断只需要维持「可见窗口 ≤ limit」这一不变量，不需要每次移动全部字节。

## 修改

- `pylon-acp/src/terminal_policy.rs`：`enforce_output_limit` 换成
  `TerminalOutputBuffer`（`text/head/limit/base_offset/truncated`）。
  `append` 只推进 `head` 并顺延到 UTF-8 边界，`head >= limit` 时压缩一次；
  可见窗口 ≤ limit、内存上界 2×limit。
- `pylon-acp/src/terminal_runtime.rs`：
  - `TerminalState { output, exit_status }` 用 `std::sync::Mutex`（临界区内无 await），
    `append_output`/`mark_exited` 转同步，`snapshot()` 在锁内一次构造；
  - `spawn_reader` 去掉 `Handle::current()` 与逐块 `block_on`，直接同步追加；
  - 读写路径里真正需要 await 的（`child`、`reader_handles`）仍用 tokio Mutex。

## 验证

- 新增 `output_buffer_keeps_window_bounded_and_offsets_contiguous`：1000 × 16B 追加后
  可见窗口恒 ≤ limit、最终保留最新一块、`base_offset == 总字节 − limit`。
- 新增 `streaming_output_stays_bounded_and_offsets_advance`：64 × 8KB 追加进 8KB 窗口，
  快照恒 8KB、`output_base_offset == 63×8192`、`truncated` 置位。
- 既有 `output_keeps_newest_utf8_and_decoder_keeps_partial_bytes`、
  `registry_confines_operations_to_session_owner` 保持通过（UTF-8 边界与 baseOffset 语义不变）。
- 基准（`/g/TEMP/pylon-perf/terminal_buf_bench.rs`，256MB 输出）：limit 1MB 时
  761ms → 25ms（30×），limit 64KB 时 54ms → 14ms（4×）；`block_on` 往返 32,768 → 0。
- 门禁：`cargo test -p pylon-acp`（190 passed）、`cargo check -p pylon --tests`、
  `cargo fmt --check`、`bun run check:clippy`（await-holding 基线不变 17/55）。

## 说明

`enforce_output_limit` 是 `pub`，但仓内已无调用方（仅 `vendor/acp/ORIGIN.md` 的溯源
说明提到该名字，历史记录保留不改）。
