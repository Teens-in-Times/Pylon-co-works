# Dev Record — #663 acp cancel trace 断言等待

> 入库保留。产出路径：`.agents/records/issue-663-acp-cancel-trace-wait.md`

## 元信息

- issue：[#663 test(acp): cancel trace 断言在 fake agent 落盘前读取，CI 上间歇性红灯](https://github.com/Teens-in-Times/Pylon-co-works/issues/663)
- 分支：`fix/startup-schema-panic`（#654 的 PR #659；该分支 CI 正好红在此测试，合批修复）
- 日期：2026-10-28
- 施工署名：Qoder

## 根因

`fake_acp_prompt_timeout_sends_cancel_and_waits_for_cancelled_response`（`src/acp/tests.rs`）
在 `wait_prompt_with_recovery` 返回后**立即**读 trace 文件，断言其中出现 `session/cancel`。
但 `cancel_session().await` 只保证帧写进子进程 stdin；fake agent 的 stdin 读循环
（`for line in stdin.lock().lines()` → `write_trace`）在其后异步执行。CI 负载下这个
间隙足以让「读 trace」早于「agent 落盘」。

两次独立 PR 的全量作业命中同一行断言（#659 run 40715414765、#660 run 40711150174），
本地单跑不复现——典型的「断言 agent 侧效果但不等它发生」。

## 修复

- `test_utils::wait_for_trace_line(path, predicate)`：10ms 间隔、2s 上界轮询 trace，
  逐行 `serde_json` 解析时**跳过解析失败的行**（文件正在追加时尾部可能是半行，
  原实现 `from_str(line).unwrap()` 在这里会直接 panic）。
- 测试改为 `wait_for_trace_line` 断言，失败消息保持可读。

没有放宽任何 `wait_prompt_with_recovery` 预算，也没有加固定 sleep——等的是条件本身。

## 验证

- `cargo test -p pylon --lib acp::tests::fake_acp_prompt_timeout_sends_cancel_and_waits_for_cancelled_response`
  → 1 passed（0.26s）
- CI：`Rust（fmt + 测试 + 构建）` 全量（986 用例）复核。

## 说明

本修复挂在 PR #659（#654）上，原因是该 PR 的 CI 正红于此测试、阻塞合并队列；
PR 描述已追加 `Closes #663` 与该问题的说明。若需独立回溯，本记录与 issue #663 是入口。
