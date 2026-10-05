//! Claude Code 原生历史解析（`~/.claude/projects/<munged-cwd>/<uuid>.jsonl`）。
//!
//! 逐行 JSON（JSONL）；按行内 `sessionId` 变化切段（`/clear` 滚动链：同一文件
//! 里 CLI 换新 sessionId 继续写，旧版行为），每段一个导入会话。行→`session/update`
//! 载荷的映射表见 `tests/fixtures/`（golden 基线锁形状）。
//!
//! 容错纪律：`isSidechain`（子代理侧链）、`isMeta`（命令回显）、`type:"system"`
//! 与不可识别行**跳过并计数**（`skipped_line_count`，unknown 不静默）；结构性
//! 失败（文件不可读）才冒泡。
//!
//! usage 去重（#364：不去重会 2.4× 虚增）：同一 `message.id` 会落盘多行流式
//! 快照（content 累积、usage 累计）。文本/工具事件**延迟到该 id 的终态行**
//! （带 `stop_reason` 的行即最后一行）才产出——终态行的 content 是完整快照；
//! usage 同理按 id 只留终值，仅在 `done` 事件带出一次。

use std::path::Path;

use serde_json::{json, Value};

use crate::{
    ExternalEvent, ExternalHistoryError, ExternalHistoryParser, ExternalSessionRecord,
    ExternalSessionSummary,
};

/// 本解析器产出的事件同时是 canonical owner 的 agent_id 段。
const AGENT_ID: &str = "claude-code";

/// Claude Code 会话根（相对 home）：`~/.claude/projects`。
pub const CLAUDE_CODE_PROJECTS_DIR: &str = ".claude/projects";

pub struct ClaudeCodeParser;

impl ExternalHistoryParser for ClaudeCodeParser {
    fn agent_id(&self) -> &'static str {
        AGENT_ID
    }

    fn discover(&self, projects_root: &Path) -> Vec<ExternalSessionSummary> {
        let mut summaries = Vec::new();
        for file in jsonl_files(projects_root) {
            for segment in parse_file(&file) {
                summaries.push(segment.summary);
            }
        }
        summaries.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        summaries
    }

    fn read(
        &self,
        projects_root: &Path,
        external_id: &str,
    ) -> Result<ExternalSessionRecord, ExternalHistoryError> {
        for file in jsonl_files(projects_root) {
            for segment in parse_file(&file) {
                if segment.summary.external_id == external_id {
                    return Ok(ExternalSessionRecord {
                        summary: segment.summary,
                        events: segment.events,
                    });
                }
            }
        }
        Err(ExternalHistoryError::SessionNotFound(external_id.to_string()))
    }
}

/// 会话根下的 `*/*.jsonl` 两层布局（一层 munged-cwd 目录 + 一层会话文件）。
/// `read` 按 external_id 精确匹配，遍历顺序不影响正确性。
fn jsonl_files(projects_root: &Path) -> Vec<std::path::PathBuf> {
    let Ok(project_dirs) = std::fs::read_dir(projects_root) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for project_dir in project_dirs.flatten() {
        let Ok(entries) = std::fs::read_dir(project_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                files.push(path);
            }
        }
    }
    files
}

/// 段（一个 `sessionId` 链）的解析产物。
struct Segment {
    summary: ExternalSessionSummary,
    events: Vec<ExternalEvent>,
}

/// 同一 `message.id` 的流式快照暂存：content/usage 每行覆盖，终态行产出。
struct PendingMessage {
    message: Value,
    timestamp: String,
}

struct SegmentBuilder {
    external_id: String,
    source_path: String,
    title: Option<String>,
    started_at: Option<String>,
    last_activity_at: Option<String>,
    skipped: u64,
    events: Vec<ExternalEvent>,
    first_user_text: Option<String>,
    /// 按 id 保序的未终结 assistant 消息（换 id 前与段尾 flush）。
    pending: Vec<(String, PendingMessage)>,
}

impl SegmentBuilder {
    fn new(external_id: &str, source_path: &str) -> Self {
        Self {
            external_id: external_id.to_string(),
            source_path: source_path.to_string(),
            title: None,
            started_at: None,
            last_activity_at: None,
            skipped: 0,
            events: Vec::new(),
            first_user_text: None,
            pending: Vec::new(),
        }
    }

    fn push_event(&mut self, update: Value, timestamp: &str) {
        self.note_activity(timestamp);
        self.events.push(ExternalEvent {
            occurred_at: timestamp.to_string(),
            payload: json!({ "update": update }),
        });
    }

    fn note_activity(&mut self, timestamp: &str) {
        if timestamp.is_empty() {
            return;
        }
        if self.started_at.is_none() {
            self.started_at = Some(timestamp.to_string());
        }
        self.last_activity_at = Some(timestamp.to_string());
    }

    /// assistant 消息的 content 块 → 事件（text/thinking/tool_use）。
    fn emit_message_blocks(&mut self, message: &Value, timestamp: &str) {
        let Some(blocks) = message.get("content").and_then(Value::as_array) else {
            self.skipped += 1;
            return;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.is_empty() {
                        continue;
                    }
                    self.push_event(
                        json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": text } }),
                        timestamp,
                    );
                }
                Some("thinking") => {
                    let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                    if text.is_empty() {
                        continue;
                    }
                    self.push_event(
                        json!({ "sessionUpdate": "agent_thought_chunk", "content": { "text": text } }),
                        timestamp,
                    );
                }
                Some("tool_use") => {
                    let tool_call_id = block.get("id").and_then(Value::as_str).unwrap_or("");
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                    if tool_call_id.is_empty() || name.is_empty() {
                        continue;
                    }
                    self.push_event(
                        json!({
                            "sessionUpdate": "tool_call",
                            "toolCallId": tool_call_id,
                            "title": name,
                            "kind": "call",
                            "rawInput": block.get("input").cloned().unwrap_or(Value::Null),
                        }),
                        timestamp,
                    );
                }
                _ => {}
            }
        }
    }

    /// 段收尾：标题兜底 + 未终结 assistant 消息 flush（只产内容事件，无 done——
    /// 没有 stop_reason 证据，不虚构终态）。
    fn finish(mut self) -> Segment {
        let pending = std::mem::take(&mut self.pending);
        for (_, message) in pending {
            let timestamp = message.timestamp.clone();
            self.emit_message_blocks(&message.message, &timestamp);
        }
        let title = self.title.or_else(|| {
            self.first_user_text
                .as_deref()
                .map(truncate_title)
        });
        Segment {
            summary: ExternalSessionSummary {
                agent_id: AGENT_ID.to_string(),
                external_id: self.external_id,
                title,
                started_at: self.started_at.unwrap_or_default(),
                last_activity_at: self.last_activity_at.unwrap_or_default(),
                event_count: self.events.len() as u64,
                source_path: self.source_path,
                skipped_line_count: self.skipped,
            },
            events: self.events,
        }
    }
}

fn truncate_title(text: &str) -> String {
    const TITLE_LIMIT: usize = 60;
    let trimmed = text.trim();
    if trimmed.chars().count() <= TITLE_LIMIT {
        return trimmed.to_string();
    }
    trimmed.chars().take(TITLE_LIMIT).collect()
}

/// 解析单个 JSONL 文件为段列表（`/clear` 滚动链 ⇒ 多段）。
/// summary 行的标题记为 pending，赋给其后换出的首个段（文件级摘要语义）。
fn parse_file(path: &Path) -> Vec<Segment> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let source_path = path.to_string_lossy().to_string();
    let mut segments: Vec<Segment> = Vec::new();
    let mut builder: Option<SegmentBuilder> = None;
    let mut pending_title: Option<String> = None;
    // 同一 message.id 的最新 usage（流式累计快照，取终值）。
    let mut usage_by_message: std::collections::HashMap<String, Value> =
        std::collections::HashMap::new();

    for line in content.lines() {
        let line = match serde_json::from_str::<Value>(line) {
            Ok(line) => line,
            Err(_) => {
                if let Some(builder) = builder.as_mut() {
                    builder.skipped += 1;
                }
                continue;
            }
        };
        // 滚动链：sessionId 变化即换段（旧段封存、新段以 pending 标题开局）。
        let session_id = line.get("sessionId").and_then(Value::as_str);
        if let (Some(current), Some(id)) = (&builder, session_id) {
            if current.external_id != id {
                if let Some(finished) = builder.take() {
                    segments.push(finished.finish());
                }
            }
        }
        // summary 行是文件级元数据（无 sessionId，通常在文件头）：只记 pending
        // 标题，不得开出占位空段。
        if line.get("type").and_then(Value::as_str) == Some("summary") {
            if let Some(text) = line.get("summary").and_then(Value::as_str) {
                pending_title = Some(truncate_title(text));
            }
            if let Some(builder) = builder.as_mut() {
                let timestamp = line
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                builder.note_activity(timestamp);
            }
            continue;
        }
        if builder.is_none() {
            let id = session_id
                .map(str::to_string)
                .unwrap_or_else(|| fallback_segment_id(&segments));
            let mut fresh = SegmentBuilder::new(&id, &source_path);
            if let Some(title) = pending_title.take() {
                fresh.title = Some(title);
            }
            builder = Some(fresh);
        }
        let Some(builder) = builder.as_mut() else {
            continue;
        };
        let timestamp = line
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            builder.skipped += 1;
            continue;
        }
        match line.get("type").and_then(Value::as_str).unwrap_or("") {
            "user" => {
                // isMeta 在行根与 message 内两种落位都出现过（版本差异），双查。
                let is_meta = [line.get("isMeta"), line.pointer("/message/isMeta")]
                    .into_iter()
                    .flatten()
                    .any(|flag| flag.as_bool() == Some(true));
                if is_meta {
                    builder.skipped += 1;
                    continue;
                }
                parse_user_line(&line, &timestamp, builder);
            }
            "assistant" => {
                parse_assistant_line(&line, &timestamp, builder, &mut usage_by_message);
            }
            // system / 未知类型：跳过计数（unknown 不静默）。
            _ => {
                builder.skipped += 1;
            }
        }
    }
    if let Some(finished) = builder {
        segments.push(finished.finish());
    }
    segments
}

/// 无 sessionId 的行（早期格式）：以文件内段序生成稳定占位 id，段仍可寻址。
fn fallback_segment_id(existing: &[Segment]) -> String {
    format!("{AGENT_ID}#unlabeled-{}", existing.len())
}

fn parse_user_line(line: &Value, timestamp: &str, builder: &mut SegmentBuilder) {
    let Some(message) = line.get("message") else {
        builder.skipped += 1;
        return;
    };
    match message.get("content") {
        Some(Value::String(text)) => {
            if builder.first_user_text.is_none() {
                builder.first_user_text = Some(text.clone());
            }
            builder.push_event(
                json!({ "sessionUpdate": "user_message_chunk", "content": { "text": text } }),
                timestamp,
            );
        }
        Some(Value::Array(blocks)) => {
            let mut produced = false;
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if text.is_empty() {
                            continue;
                        }
                        if builder.first_user_text.is_none() {
                            builder.first_user_text = Some(text.to_string());
                        }
                        builder.push_event(
                            json!({ "sessionUpdate": "user_message_chunk", "content": { "text": text } }),
                            timestamp,
                        );
                        produced = true;
                    }
                    Some("tool_result") => {
                        let tool_call_id =
                            block.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                        if tool_call_id.is_empty() {
                            continue;
                        }
                        builder.push_event(
                            json!({
                                "sessionUpdate": "tool_call_update",
                                "toolCallId": tool_call_id,
                                "status": "completed",
                                "rawOutput": block.get("content").cloned().unwrap_or(Value::Null),
                            }),
                            timestamp,
                        );
                        produced = true;
                    }
                    _ => {}
                }
            }
            if !produced {
                builder.skipped += 1;
            }
        }
        _ => {
            builder.skipped += 1;
        }
    }
}

fn parse_assistant_line(
    line: &Value,
    timestamp: &str,
    builder: &mut SegmentBuilder,
    usage_by_message: &mut std::collections::HashMap<String, Value>,
) {
    let Some(message) = line.get("message") else {
        builder.skipped += 1;
        return;
    };
    builder.note_activity(timestamp);
    let message_id = message.get("id").and_then(Value::as_str);
    let Some(message_id) = message_id else {
        // 无 id 的老格式：无流式快照可去重，直接产出（stop_reason 存在则补 done）。
        emit_terminal_message(message, timestamp, message.get("usage"), builder);
        return;
    };
    if let Some(usage) = message.get("usage") {
        // 流式快照后行覆盖前行：同 id 只留终值（usage 去重，#364）。
        usage_by_message.insert(message_id.to_string(), usage.clone());
    }
    let has_stop = message
        .get("stop_reason")
        .is_some_and(|reason| !reason.is_null());
    if has_stop {
        // 终态行即该 id 的最后一行：移除同 id 暂存（被终态快照取代），
        // flush 其余未决消息（按入列序）后立即产出。
        builder.pending.retain(|(id, _)| id != message_id);
        let pending = std::mem::take(&mut builder.pending);
        for (_, earlier) in pending {
            let earlier_timestamp = earlier.timestamp.clone();
            builder.emit_message_blocks(&earlier.message, &earlier_timestamp);
        }
        emit_terminal_message(message, timestamp, usage_by_message.get(message_id), builder);
        return;
    }
    // 流式中途行：覆盖暂存快照（或首见入列）。
    match builder.pending.iter_mut().find(|(id, _)| id == message_id) {
        Some((_, pending_message)) => {
            pending_message.message = message.clone();
            pending_message.timestamp = timestamp.to_string();
        }
        None => builder.pending.push((
            message_id.to_string(),
            PendingMessage {
                message: message.clone(),
                timestamp: timestamp.to_string(),
            },
        )),
    }
}

/// 终态 assistant 消息：content 块事件 + `done`（带去重后的终值 usage 与模型）。
fn emit_terminal_message(
    message: &Value,
    timestamp: &str,
    usage: Option<&Value>,
    builder: &mut SegmentBuilder,
) {
    builder.emit_message_blocks(message, timestamp);
    if let Some(stop_reason) = message.get("stop_reason").and_then(Value::as_str) {
        let mut done = json!({ "sessionUpdate": "done", "stopReason": stop_reason });
        if let Some(usage) = usage.map(translate_usage) {
            done["usage"] = usage;
        }
        if let Some(model) = message.get("model").and_then(Value::as_str) {
            done["model"] = Value::String(model.to_string());
        }
        builder.push_event(done, timestamp);
    }
}

/// Claude Code 的 snake_case usage → Pylon 前端消费的 camelCase 词表
/// （`sessionSurface`：inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens）。
/// 未知键原样保留（下游 raw 兜底）。
fn translate_usage(usage: &Value) -> Value {
    let Some(source) = usage.as_object() else {
        return usage.clone();
    };
    let mut out = serde_json::Map::new();
    for (key, value) in source {
        let mapped = match key.as_str() {
            "input_tokens" => "inputTokens",
            "output_tokens" => "outputTokens",
            "cache_read_input_tokens" => "cacheReadTokens",
            "cache_creation_input_tokens" => "cacheWriteTokens",
            other => other,
        };
        out.insert(mapped.to_string(), value.clone());
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root(name: &str) -> std::path::PathBuf {
        std::path::Path::new("tests/fixtures").join(name)
    }

    #[test]
    fn discover_returns_segments_sorted_by_start() {
        let summaries = ClaudeCodeParser.discover(&fixture_root("clear-rollover"));
        assert_eq!(summaries.len(), 2, "滚动链拆两段");
        assert!(summaries[0].started_at <= summaries[1].started_at);
    }

    #[test]
    fn read_missing_session_reports_not_found() {
        let error = ClaudeCodeParser
            .read(&fixture_root("clear-rollover"), "no-such-id")
            .unwrap_err();
        assert!(matches!(error, ExternalHistoryError::SessionNotFound(_)));
    }

    #[test]
    fn usage_dedupe_emits_one_done_with_final_snapshot_only() {
        let record = ClaudeCodeParser
            .read(
                &fixture_root("usage-dedupe"),
                "33333333-3333-4333-8333-333333333333",
            )
            .expect("fixture session");
        let text_events = record
            .events
            .iter()
            .filter(|event| {
                event.payload["update"]["sessionUpdate"] == "agent_message_chunk"
            })
            .count();
        assert_eq!(text_events, 1, "流式快照行只产一次文本事件");
        let done = record
            .events
            .iter()
            .find(|event| event.payload["update"]["sessionUpdate"] == "done")
            .expect("done 事件存在");
        assert_eq!(done.payload["update"]["usage"]["outputTokens"], 25);
    }

    #[test]
    fn sidechain_meta_system_and_bad_lines_are_counted_not_silent() {
        let record = ClaudeCodeParser
            .read(
                &fixture_root("skip-noise"),
                "44444444-4444-4444-8444-444444444444",
            )
            .expect("fixture session");
        // sidechain + meta + system + 坏 JSON 各一。
        assert_eq!(record.summary.skipped_line_count, 4);
    }
}
