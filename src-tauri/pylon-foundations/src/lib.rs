//! Pylon 纯逻辑地基 crate（阶段一拆分）：零 tauri / 零 AppState / 零主 lib 内部依赖的模块。
//! 依赖方向铁律：本 crate 只依赖第三方，绝不依赖回主 lib（防循环依赖）。
//!
//! 模块随拆分提交逐个迁入；审计否决留档（2026-09-07）：`correlation`（依赖
//! agent_config::AgentDef）、`error`（#[from] session/plugin_cmds/agent_config/gateway
//! 错误源）、`cwd`/`paths`（AppState / tauri::command）、`runtime_log`（依赖
//! correlation，待其摆脱 agent_config 后可随阶段二迁入）。

pub mod atomic_write;
pub mod await_guard;
pub mod child_command;
pub mod event_names;
pub mod git;
pub mod home;
pub mod job_object;
pub mod sanitize;
pub mod time;
pub mod workspace;
