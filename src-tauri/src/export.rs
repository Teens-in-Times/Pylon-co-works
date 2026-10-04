//! 会话导出（markdown/json，脱敏管线；R1 拆分自 lib.rs；C1：值内容脱敏 + markdown 注入转义；
//! R21：脱敏实现统一到 crate::sanitize，此处 re-export 保持调用面；
//! #444 批次③：sanitize 后追加绝对路径收窄段，与前端取证导出脱敏强度对齐）。

use crate::agent::runtime::session_mapping_matches;
use crate::error::PylonError;
use crate::AppState;

#[cfg(test)]
pub(crate) use crate::sanitize::is_export_sensitive_key;
pub(crate) use crate::sanitize::{redact_export_absolute_paths, sanitize_export_messages};

/// C1：行内转义（title/status/peri_id 注入面）——换行折叠为空格，`#` 转义。
fn escape_inline(value: &str) -> String {
    value.replace('\n', " ").replace('#', "\\#")
}

/// C1：正文文本转义——以 `#` 开头的行加 `\#` 前缀，防用户文本注入 markdown 标题结构。
fn escape_text_lines(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.starts_with('#') {
                format!("\\{line}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn format_export_markdown(peri_id: &str, messages: &[serde_json::Value]) -> String {
    let mut markdown = format!("# Session {}\n\n", escape_inline(peri_id));
    for message in messages {
        let Some(update) = message.get("update") else {
            continue;
        };
        // R4→#316：变体经官方 schema typed-first 分类（fallback 宽容别名不变）。
        let variant = crate::acp::classify_session_update(update);
        match variant {
            Some(crate::acp::SessionUpdateVariant::UserMessageChunk) => {
                if let Some(text) = update
                    .get("content")
                    .and_then(|content| content.get("text"))
                    .and_then(|value| value.as_str())
                {
                    markdown.push_str("## User\n\n");
                    markdown.push_str(&escape_text_lines(text));
                    markdown.push_str("\n\n");
                }
            }
            Some(crate::acp::SessionUpdateVariant::AgentMessageChunk) => {
                if let Some(text) = update
                    .get("content")
                    .and_then(|content| content.get("text"))
                    .and_then(|value| value.as_str())
                {
                    markdown.push_str("## Assistant\n\n");
                    markdown.push_str(&escape_text_lines(text));
                    markdown.push_str("\n\n");
                }
            }
            Some(crate::acp::SessionUpdateVariant::ToolCall)
            | Some(crate::acp::SessionUpdateVariant::ToolCallUpdate) => {
                let title = update
                    .get("title")
                    .or_else(|| update.get("name"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("Tool");
                markdown.push_str(&format!("## Tool: {}\n\n", escape_inline(title)));
                let status = update
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                markdown.push_str(&format!("### Tool status ({})\n\n", escape_inline(status)));
            }
            _ => {}
        }
    }
    markdown
}

/// 导出路径父目录检查：裸文件名（`parent()` 为 `Some("")`）落在当前工作目录，
/// 跳过存在性检查——由 `write_export_atomically` 的 `create_new` 原子写兜底报错
/// （优化-10：修复裸文件名恒报"导出目录不存在"）。
fn check_export_parent(output: &std::path::Path) -> Result<(), PylonError> {
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(PylonError::Protocol(format!(
                "export output directory does not exist: {}",
                parent.display()
            )));
        }
    }
    Ok(())
}

/// 原子写导出文件：`create_new` 直接占用目标（已存在拒绝，防覆盖）。
/// C2：消除 exists 检查 + temp + rename 的 TOCTOU 窗口（Unix rename 覆盖已存在文件）。
pub(crate) fn write_export_atomically(
    path: &std::path::Path,
    content: &[u8],
) -> Result<(), String> {
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    format!("export output already exists: {}", path.display())
                } else {
                    format!("create export failed: {error}")
                }
            })?;
        let written = (|| {
            use std::io::Write;
            file.write_all(content)
                .map_err(|error| format!("write export failed: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("sync export failed: {error}"))?;
            Ok::<(), String>(())
        })();
        drop(file);
        if written.is_err() {
            let _ = std::fs::remove_file(path);
        }
        written
    })();
    result
}

#[tauri::command]
pub(crate) async fn export_session(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    peri_id: String,
    format: String,
    output_path: String,
) -> Result<(), PylonError> {
    if !matches!(format.as_str(), "markdown" | "json") {
        return Err(PylonError::Protocol(format!(
            "unsupported export format: {format}"
        )));
    }
    if peri_id.trim().is_empty() {
        return Err(PylonError::Protocol(
            "export requires a non-empty session id".to_string(),
        ));
    }
    if output_path.trim().is_empty() {
        return Err(PylonError::Protocol(
            "export requires a non-empty output path".to_string(),
        ));
    }
    let output = std::path::Path::new(&output_path);
    if output.is_dir() {
        return Err(PylonError::Protocol(format!(
            "export output path is a directory: {}",
            output.display()
        )));
    }
    check_export_parent(output)?;
    // OWNER-02（§5.8）：显式 agentId 路由到 owner runtime（export 以 periId 寻会话，
    // 归属 runtime 由 agent_id 确定）；不存在 owner runtime → agent_runtime_unavailable。
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    let (source, generation, cwd) = state.export_session_owner(&runtime, &peri_id)?;
    let mcp_servers =
        crate::mcp::validate_and_serialize(Some(state.inner().current_mcp_servers()?))?;
    // A-02：锁内原子建立 replay capture，等待在锁外进行——回放最长 30s，不阻塞其他命令。
    let handles = runtime.snapshot_acp().begin_replay_capture(&peri_id)?;
    let (_, replay) = crate::acp::load_session_with_replay(
        handles,
        &peri_id,
        &cwd,
        mcp_servers,
        state.protocol_for_runtime(&runtime).mcp_servers,
    )
    .await?;
    state.ensure_generation(&runtime, generation)?;
    let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
    if sessions.get(&source).map(|session| {
        session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
    }) != Some(true)
    {
        return Err(PylonError::Protocol(
            "export session became stale".to_string(),
        ));
    }
    drop(sessions);
    if replay.metadata.truncated {
        return Err(PylonError::Storage(
            pylon_session::SessionError::ReplayTruncated {
                dropped_count: replay.metadata.dropped_count,
            },
        ));
    }
    let messages = replay.events;
    // #444 批次③：两段式脱敏（Strip 敏感 key + 值内容检测 → 绝对路径收窄），
    // 与前端取证导出（sanitizeExportValue → 路径收窄）同构。
    let safe_messages = redact_export_absolute_paths(&sanitize_export_messages(&messages));
    let content = match format.as_str() {
        "markdown" => format_export_markdown(&peri_id, &safe_messages),
        _ => serde_json::to_string_pretty(&safe_messages)
            .map_err(|error| format!("serialize export failed: {error}"))?,
    };
    write_export_atomically(output, content.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(variant: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": "peri-1",
            "update": { "sessionUpdate": variant, "content": { "text": text } }
        })
    }

    #[test]
    fn markdown_formats_user_assistant_and_tool() {
        let messages = vec![
            chunk("user_message_chunk", "你好"),
            chunk("agent_message_chunk", "回复文本"),
            serde_json::json!({
                "sessionId": "peri-1",
                "update": { "sessionUpdate": "tool_call", "title": "edit_file" }
            }),
            serde_json::json!({
                "sessionId": "peri-1",
                "update": { "sessionUpdate": "tool_call_update", "title": "edit_file", "status": "completed" }
            }),
        ];
        let md = format_export_markdown("peri-1", &messages);
        assert!(md.starts_with("# Session peri-1"));
        assert!(md.contains("## User\n\n你好"));
        assert!(md.contains("## Assistant\n\n回复文本"));
        assert!(md.contains("## Tool: edit_file"));
        assert!(md.contains("### Tool status (completed)"));
    }

    #[test]
    fn markdown_skips_unknown_and_missing_content() {
        // 未知变体（透传的 agent_thought_chunk 等）不进入 markdown 正文
        let messages = vec![
            chunk("agent_thought_chunk", "思考过程不应导出为正文"),
            serde_json::json!({ "sessionId": "peri-1", "update": { "sessionUpdate": "usage_update", "used": 100 } }),
            serde_json::json!({ "sessionId": "peri-1", "update": {} }),
        ];
        let md = format_export_markdown("peri-1", &messages);
        assert!(!md.contains("思考过程"));
        assert!(!md.contains("usage_update"));
        assert_eq!(
            md.lines().filter(|line| line.starts_with("## ")).count(),
            0,
            "无正文变体不得产生段落"
        );
    }

    #[test]
    fn sanitizer_strips_nested_secrets_recursively() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": {
                "sessionUpdate": "tool_call",
                "title": "edit_file",
                "rawInput": "{\"path\":\"/tmp/x\",\"token\":\"sk-secret\"}",
                "headers": { "authorization": "Bearer abc" },
                "safe": { "nested": "kept", "apiKeyToken": "drop-me" }
            }
        })];
        let safe = sanitize_export_messages(&messages);
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains("sk-secret"));
        assert!(!text.contains("Bearer"));
        assert!(!text.contains("drop-me"));
        assert!(text.contains("kept"));
    }

    #[test]
    fn sanitizer_strips_password_api_key_cookie_and_credential() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": {
                "sessionUpdate": "tool_call",
                "password": "hunter2",
                "api_key": "sk-abcdef",
                "apiKey": "key-2",
                "cookie": "session=abc",
                "credential": "user:pass",
                "safe": "kept"
            }
        })];
        let safe = sanitize_export_messages(&messages);
        let text = serde_json::to_string(&safe).unwrap();
        for needle in ["hunter2", "sk-abcdef", "key-2", "session=abc", "user:pass"] {
            assert!(!text.contains(needle), "{needle} 必须被剔除");
        }
        assert!(text.contains("kept"));
    }

    #[test]
    fn sanitizer_redacts_secret_shapes_inside_non_sensitive_values() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": { "detail": "Bearer sk-abc", "path": "safe" }
        })];
        let safe = sanitize_export_messages(&messages);
        assert_eq!(safe[0]["update"]["detail"], "[REDACTED]");
        assert_eq!(safe[0]["update"]["path"], "safe");
    }

    #[test]
    fn export_pipeline_narrows_absolute_paths_after_strip() {
        // #444 批次③：export_session 的两段式脱敏接线表征——路径收窄必须跟随
        // sanitize 之后（本测试与命令体内的调用顺序逐字对应）。
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": {
                "sessionUpdate": "tool_call",
                "title": "read_file",
                "rawInput": "{\"path\":\"G:/ws/secret.txt\"}",
                "locations": [{ "path": "G:/ws/src/main.rs" }]
            }
        })];
        let safe = redact_export_absolute_paths(&sanitize_export_messages(&messages));
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains("rawInput"), "敏感 key 剔除先行");
        assert!(!text.contains("G:/ws"), "绝对路径不得整段外泄");
        assert!(text.contains("…/main.rs"), "幸存字段收窄为 …/末段");
    }

    #[test]
    fn markdown_escapes_heading_injection_in_text() {
        let messages = vec![chunk("user_message_chunk", "# 伪造标题\n正文第二行")];
        let md = format_export_markdown("peri-1", &messages);
        assert!(md.contains("## User\n\n\\# 伪造标题\n正文第二行"), "{md}");
        assert_eq!(
            md.lines().filter(|line| line.starts_with("## ")).count(),
            1,
            "注入行不得产生额外标题段"
        );
    }

    #[test]
    fn markdown_escapes_inline_title_status_and_session_id() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": { "sessionUpdate": "tool_call", "title": "edit\n#file", "status": "done\n#ok" }
        })];
        let md = format_export_markdown("peri\n#1", &messages);
        assert!(md.starts_with("# Session peri \\#1"), "{md}");
        assert!(md.contains("## Tool: edit \\#file"), "{md}");
        assert!(md.contains("### Tool status (done \\#ok)"), "{md}");
    }

    #[test]
    fn json_export_is_pretty_printed() {
        let messages = vec![chunk("agent_message_chunk", "x")];
        let content = serde_json::to_string_pretty(&sanitize_export_messages(&messages)).unwrap();
        assert!(content.contains('\n'), "pretty JSON 必须换行");
    }

    #[test]
    fn export_parent_check_skips_bare_filename() {
        // 裸文件名：parent() == Some("")，空父路径落在当前工作目录，必须跳过存在性检查
        assert!(check_export_parent(std::path::Path::new("export.md")).is_ok());
        // 真实存在的父目录：不报错
        let real_parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/dummy.md");
        assert!(check_export_parent(&real_parent).is_ok());
        // 不存在的父目录：报错
        let missing_parent =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("no_such_dir_xyz/dummy.md");
        let error = check_export_parent(&missing_parent).unwrap_err();
        assert!(
            matches!(error, PylonError::Protocol(message) if message.contains("does not exist"))
        );
    }
}
