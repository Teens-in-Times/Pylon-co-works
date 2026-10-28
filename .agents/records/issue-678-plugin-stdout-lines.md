# Dev Record — #678 插件 stdout 分行

> 入库保留。产出路径：`.agents/records/issue-678-plugin-stdout-lines.md`

## 元信息

- issue：[#678 perf(plugin-process): stdout 分行逐行 drain + allocate，长输出按行数放大成 O(n²)](https://github.com/Teens-in-Times/Pylon-co-works/issues/678)
- 分支：`perf/plugin-stdout-lines`
- 日期：2026-10-29
- 施工署名：Qoder

## 根因

`process_stdout_lines` 每取一行都 `buffer.drain(..=index).collect::<Vec<_>>()`：

- `drain` 前移剩余整段缓冲 ⇒ 一块 8KB 输出（143 行）就是 143 次 8KB memmove；
- `collect` 每行一次堆分配。

行协议 / JSON 行 / JSON-RPC 三类插件都逐帧走这条路。

## 修改

- 新增 `next_line_bounds(buffer, start) -> Option<(行尾, 下一行起点)>`：定位第一个 `\n`，
  并把行尾的 `\r` 一并回退（等价于旧实现 drain 掉 `\n` 后再 `pop` 终止符）。
- 主循环改为游标切片：处理完所有完整行后一次性 `drain(..start)`；不再有每行 Vec。
- 16MiB 上限判定保持在处理前、口径不变。

## 验证

- 新增 `next_line_bounds_strips_terminators_and_keeps_partial_line`：`alpha\r\r\nbeta\n`
  两行边界 + 无换行尾巴 + 空行。
- `cargo test -p pylon --lib plugin_process`：10 passed（含 JSON-RPC 往返与并发流排空）。
- `cargo test -p pylon --lib`：986 passed / 4 ignored。
- 基准（仓外脚本）：16MB JSON 行 46.9ms → 13.2ms（3.5×）；长行跨块 24.5ms → 14.8ms。
- `cargo fmt --check`、`bun run check:clippy`（await-holding 17/55 不变）。

## 说明

同一文件里 `emit_bytes` 仍按块转发原始字节到前端（供终端面板），本次不动——它没有
按行放大问题。
