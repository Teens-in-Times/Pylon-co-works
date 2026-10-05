//! 各 Agent CLI 原生历史会话的解析 IR（issue #364 首版：Claude Code tracer）。
//!
//! 职责边界：本 crate **只产 IR**——读 CLI 落盘的 transcript 文件、还原出
//! 「会话摘要 + `session/update` 线形状事件序列」。不写库、不读时钟、不发 IPC、
//! 不依赖 tauri/pylon-session；落库由宿主经
//! `pylon_session::EventService::ingest_external_history` 完成（事件载荷与
//! live/replay 走同一 normalize 管道，前端投影零改动）。
//!
//! 契约形状（吸收 Codeg 双方法 trait）：`discover` 列表摘要、`read` 详情。
//! 输出事件载荷是 `{update: {sessionUpdate: …}}` 线形状，判别符词表与
//! `pylon-canonical-types::canonical_event_type_for` 单源对齐——解析器不得
//! 发明词表外的判别符（CLI 升级出的新形状落 unknown 语义由下游记录，不丢弃）。
//!
//! 磁盘格式漂移的防线是 golden 夹具（`tests/fixtures/`）：CLI 升级改形状时
//! 基线测试先红，避免静默漏解析。

mod claude_code;

pub use claude_code::{ClaudeCodeParser, CLAUDE_CODE_PROJECTS_DIR};

use std::path::Path;

/// 解析失败（文件缺失 / 行形状非法）。逐行容错策略见各解析器：单行坏形状
/// 跳过并计数，只有结构性失败（整文件不可读、目标会话不存在）才报错。
#[derive(Debug)]
pub enum ExternalHistoryError {
    Io(std::io::Error),
    /// 目标 external_id 在给定根目录下不存在（或已不可读）。
    SessionNotFound(String),
}

impl std::fmt::Display for ExternalHistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExternalHistoryError::Io(error) => write!(f, "external history io error: {error}"),
            ExternalHistoryError::SessionNotFound(id) => {
                write!(f, "external session not found: {id}")
            }
        }
    }
}

impl std::error::Error for ExternalHistoryError {}

/// 会话摘要（列表用）。`external_id` 是幂等键的源（宿主将其同时作为
/// `remote_session_id` 与 `local_session_id` 的派生基）；`source_path` 仅供
/// 诊断展示，落库后不再参与任何行为——封存快照纪律（#364 裁决）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ExternalSessionSummary {
    /// 产出该会话的解析器标识（同时是 canonical owner 的 agent_id 段）。
    pub agent_id: String,
    /// CLI 侧原生会话 id（Claude Code 为 uuid；`/clear` 滚动链按段拆分后
    /// 为该段的 sessionId）。
    pub external_id: String,
    pub title: Option<String>,
    /// RFC3339（段内首行 timestamp；缺失时回退空串，由宿主兜底）。
    pub started_at: String,
    /// RFC3339（段内末行 timestamp）。
    pub last_activity_at: String,
    /// 解析产出的事件数（导入前展示规模用）。
    pub event_count: u64,
    /// 源文件绝对/相对路径（诊断展示）。
    pub source_path: String,
    /// 因形状不认识而跳过的行数（unknown 语义的计数面，不静默）。
    pub skipped_line_count: u64,
}

/// 会话详情 = 摘要 + 事件序列。
#[derive(Debug, Clone, PartialEq)]
pub struct ExternalSessionRecord {
    pub summary: ExternalSessionSummary,
    pub events: Vec<ExternalEvent>,
}

/// 单条导入事件：`occurred_at` 是源文件时间戳（RFC3339）；`payload` 是
/// `session/update` 线形状（`{update: {sessionUpdate: …}}`）。
#[derive(Debug, Clone, PartialEq)]
pub struct ExternalEvent {
    pub occurred_at: String,
    pub payload: serde_json::Value,
}

/// CLI 历史解析器契约：`discover` 扫描根目录产出摘要列表；`read` 按
/// external_id 全量解析。两方法共享同一逐行解析核（`discover` 丢弃事件体、
/// `read` 重读一次）——导入是用户显式触发的冷路径，双读换取无状态 API。
pub trait ExternalHistoryParser {
    /// 解析器标识 = canonical owner 的 agent_id 段（如 "claude-code"）。
    fn agent_id(&self) -> &'static str;
    /// 扫描根目录（各解析器自定义根布局；Claude Code 为 `~/.claude/projects`）。
    fn discover(&self, projects_root: &Path) -> Vec<ExternalSessionSummary>;
    /// 按 external_id 全量解析（摘要 + 事件）。
    fn read(
        &self,
        projects_root: &Path,
        external_id: &str,
    ) -> Result<ExternalSessionRecord, ExternalHistoryError>;
}
