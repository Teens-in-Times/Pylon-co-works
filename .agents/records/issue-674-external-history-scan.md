# Dev Record — #674 外部历史扫描与单会话读取

> 入库保留。产出路径：`.agents/records/issue-674-external-history-scan.md`

## 元信息

- issue：[#674 perf(agent-history): 扫描列表先物化全部事件载荷再丢弃，导入每个会话都把整段历史重新解析一遍](https://github.com/Teens-in-Times/Pylon-co-works/issues/674)
- 分支：`perf/external-history-scan`
- 日期：2026-10-29
- 施工署名：Qoder

## 根因

- `discover` 用完整解析产摘要：每行都构 `ExternalEvent` 载荷（`tool_result` 的
  `rawOutput`、`tool_use` 的 `rawInput` 都是整段 `cloned()`），拿 `events.len()`
  之后整包丢弃。`lib.rs` 的契约注释写的是「`discover` 丢弃事件体」，实现上却是
  「先构出来再丢」。
- `read` 从第一个 JSONL 起逐个全解析直到命中 id；`external_history_import` 对每个
  待导入会话各调一次，导入全部即 O(会话数 × 历史字节)。

合成 300 会话 / 105MB 的基线：`discover` 613ms，`read` 全部 **99.6s**。

## 修改

`src-tauri/pylon-agent-history/src/claude_code.rs`：

- `SegmentBuilder` 增 `emit_events` 与 `event_count`；`push_event(timestamp, impl FnOnce() -> Value)`
  先计数、仅全量模式求值载荷。所有 `json!` 站点改为闭包，扫描时 `cloned()` 不执行。
  `event_count` 供 `summary.event_count`；usage 暂存仅在全量模式做。
- `read`：先按 `file_stem == external_id` 直达文件（文件名即首段 sessionId），
  未命中再用原始字节 `contains(id)` 过滤滚动链/改名文件。
- `parse_file` 拆出 `parse_content(path, content, emit_events)` 复用已读内容。

`tests/golden.rs`：新增 `discover_summaries_match_read_summaries`——5 个夹具场景
逐段比对两个 API 的摘要（覆盖滚动链与跳过计数），锁住只计数路径与全量路径的等价。

## 验证

- `cargo test -p pylon-agent-history`：单元 4 + golden 6 全绿（baseline 未改）。
- 基准（release，best of 3，同数据）：`discover` 612.8ms → 278.6ms（2.2×）；
  `read` 全部 300 会话 99,634ms → 748ms（133×）。
- `cargo check -p pylon --tests`、`cargo fmt --check`、`bun run check:clippy`
  （await-holding 基线 17/55 不变）。

## 说明

- `read` 的「先 stem 后字节过滤」只在「同一 id 出现在多个文件」时改变胜出文件；
  id 是 CLI 生成的 uuid，且 stem 命中的文件就是它的规范落点。
- 基准驱动脚本在仓外（`/g/TEMP/pylon-perf/gen_claude_history.py`），未入库。
