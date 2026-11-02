//! Prompt 域：消息发送 / PromptFlow / prompt 编排。
//! 方案 11 机械拆分自 session/mod.rs；W3 重构批次 S1 再目录化为四子模块
//! （纯搬移，行为零变化）：[`ingest`] journal 写入 / [`ledger`] turn 账本 /
//! [`wait`] ACP 等待管线 / [`settle`] 终态结算。
//!
//! glob 链重建（S1 前提①）：子模块 `use super::*` 的 `super` 现为本模块；
//! 本模块经 `use super::*` 透传 session 的符号面，并 `use <子模块>::*` 把四个
//! 兄弟域的符号汇入本模块命名空间——子模块间互相可见、tests 整体共享。
//!
//! 跨文件 re-export（S1 前提②）：`session/mod.rs` 的 `pub(crate) use prompt::*`
//! 与外部消费方（lib.rs / dispatcher / gateway / test_harness）路径不变。

mod hooks;
mod ingest;
mod ledger;
mod settle;
mod wait;

use super::*;
// 原 prompt.rs 文件头的 acp 显式导入集（S1 随模块根上移：子模块的私有 use 绑定
// 不随 `use <子模块>::*` 上浮，经本根命名空间向全体子模块与 tests 透传）。
use crate::acp::{
    terminal_cause_from_prompt_result, AcpError, CancelSettleResolution, PromptTimeoutKind,
    TurnKey, TurnTerminalCause,
};

// 子模块符号汇入（私有导入：可见面 = 本模块子树，等价拆分前的单文件私有域）。
use hooks::{InjectedPrompt, PrismTurnHooks, PromptTurnHooks};
use ingest::*;
use ledger::*;
use settle::*;

// 跨文件消费面 re-export（与拆分前的 pub(crate) 集合逐一对应；域内私有符号
// 经上方私有 glob 汇入本子树，不外扩可见面）。
// wait 用 glob 再导出：`#[tauri::command]` 生成的隐藏 `__cmd__*` 垫片须随符号面
// 一并 re-export，generate_handler 经 `session::*` 才能解析（拆分前由单文件 +
// 上层 glob 链承担）。
pub(crate) use wait::*;
// `cancel_requested_probe` 的 crate 内使用点在 wait.rs（经本命名空间解析）。
pub(crate) use ledger::cancel_requested_probe;
// #707-C：turn 账本宿主侧单点门——跨域消费面（dispatcher/expiry 经 `session::*`
// 消费）；begin_turn/settle_active_for_session_defensively 仅 prompt 域内使用
// （走上方私有 glob），不外扩 re-export。
pub(crate) use ledger::{drop_generation, note_session_activity, turn_in_flight};
// cleanup/prompt_error 的 crate 内消费点仅在 cfg(test)（session/mod.rs 测试），
// 非 test 构建下本 re-export 无 traced 使用点，属预期（同 event_repo::EventRepo 先例）。
#[allow(unused_imports)]
pub(crate) use settle::{cleanup_ghost_session_mapping, prompt_error_indicates_missing_session};

#[cfg(test)]
mod tests;
