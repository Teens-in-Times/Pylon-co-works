# Dev Record — #666 pylon-acp 逐帧深拷贝

> 入库保留。spec 不保留（`.agents/spec/666-acp-per-frame-copies.md`）。

## 元信息

- issue：[#666 refactor: pylon-acp 逐帧深拷贝](https://github.com/Teens-in-Times/Pylon-co-works/issues/666)
- 分支：`perf/acp-per-frame-copies`（基于 `github/main` = `4497c318`）
- 日期：2026-10-29
- 施工署名：Qoder

## 问题

1. 入站：SDK 交来所有权消息，代码仍 `params().clone()` / `method().to_string()`。
2. 出站：`UntypedMessage::new` 内部 `serde_json::to_value(params)`，对已拥有的 `Value` 再深拷；三处（Request / Notification / RequestKeepRx）。
3. 分类：每 chunk `SessionUpdate::deserialize` 产出拥有 text 的 typed 值，仅为读判别变体。

## 实现

- `engine/mod.rs`：入站两臂改 `into_parts()`；出站三处改 `UntypedMessage { method, params }`。
- `protocol.rs`：`classify_session_update` 先 `from_str(tag)`，未命中再 typed。等价性论证见函数注释与 spec；新增 `classify_tests`（已知 tag + 畸形 body、Peri 别名、未知/缺失 tag）。

## 验证

- `cargo test -p pylon-acp`：190 passed / 0 failed（含新增 2 条分类等价测试）。
- `cargo fmt --all --check`：通过。
- `bun run check:clippy`：各 crate `added: []`；`check-await-holding` 17 文件 / 55 处一致。

## 遗留

- wire trace 的「运行期恒启用 + 捕获时整树脱敏」（`wire_trace.rs:181,268`）是逐帧第三处开销，变更默认值属产品决策，未纳入本卡。
