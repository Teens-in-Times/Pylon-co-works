use super::*;
#[cfg(test)]
use crate::agent_config::McpServersMode;
use crate::agent_config::{DEFAULT_MAX_ATTACHMENTS, DEFAULT_MAX_ATTACHMENT_BYTES};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::oneshot;

use std::sync::atomic::{AtomicBool, Ordering};

/// 测试辅助：经 prepare_rpc + complete 创建会话（生产调用点已锁外化）。
async fn new_session_rpc(client: &AcpClient) -> Result<serde_json::Value, AcpError> {
    client
        .prepare_rpc(
            METHOD_SESSION_NEW,
            serde_json::json!({"cwd": ".", "mcpServers": []}),
        )?
        .complete()
        .await
}

/// 测试辅助：经 prepare_rpc + complete 关闭会话。
async fn close_session_rpc(client: &AcpClient, session_id: &str) -> Result<(), AcpError> {
    client
        .prepare_rpc(
            METHOD_SESSION_CLOSE,
            serde_json::json!({"sessionId": session_id}),
        )?
        .complete()
        .await?;
    Ok(())
}

fn response() -> RawMessage {
    RawMessage {
        id: Some(RequestId::Number(1)),
        method: None,
        kind: AcpKind::Response,
        result: Some(serde_json::json!({"stopReason": "cancelled"})),
        params: None,
        error: None,
    }
}

#[test]
fn acp_kind_classification_is_stable() {
    // B1：wire method 字符串 → 类型化分类契约（dispatcher 匹配依赖）。
    assert_eq!(AcpKind::from_method(None), AcpKind::Response);
    assert_eq!(
        AcpKind::from_method(Some(NOTIF_SESSION_UPDATE)),
        AcpKind::SessionUpdate
    );
    assert_eq!(
        AcpKind::from_method(Some(METHOD_SESSION_REQUEST_PERMISSION)),
        AcpKind::PermissionRequest
    );
    assert_eq!(
        AcpKind::from_method(Some(NOTIF_AGENT_CRASHED)),
        AcpKind::Crashed
    );
    assert_eq!(
        AcpKind::from_method(Some("unknown/method")),
        AcpKind::OtherNotification
    );
}

#[test]
fn disconnected_client_is_not_marked_as_crashed() {
    assert!(!AcpClient::disconnected().is_crashed());
    // #451：占位即死连接——is_dead() 如实为 true（发送路径「无主 Crashed」
    // 接管触发集据此识别全新 runtime 的预算超时残留）。
    assert!(AcpClient::disconnected().is_dead());
}

#[tokio::test]
async fn intentional_stop_is_not_reported_as_crashed() {
    // #163：主动 kill 引发的进程退出与意外崩溃共享同一信号（exit watcher/EOF），
    // 主动停必须有「这是主动停」的证词——kill 后 is_crashed 恒 false（即使
    // exit watcher 随后把 crashed 原始标志置位），is_dead 恒 true，发送守卫拒绝。
    let agent =
        crate::test_utils::fake_acp_agent("fake-acp-intentional-stop", &["--scenario", "alive"]);
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("alive fake ACP must initialize");
    assert!(!client.is_crashed(), "存活连接不得判 crashed");
    assert!(!client.is_dead(), "存活连接不得判死");
    client.kill().expect("kill must succeed");
    assert!(
        !client.is_crashed(),
        "主动 stop 不得判 crashed（#163：被切走的 Agent 不是崩溃）"
    );
    assert!(client.is_dead(), "主动 stop 后连接已不可用");
    assert!(
        client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .is_err(),
        "主动 stop 后发送守卫必须立即拒绝"
    );
}

/// G1-06：close 降级判定类型化——-32601 信封（code 优先）与字符串兜底。
#[test]
fn method_not_found_detection() {
    // code 优先解析：-32601 信封命中
    assert!(
        AcpError::Rpc(r#"{"code":-32601,"message":"Method not found"}"#.into())
            .is_method_not_found()
    );
    assert!(AcpError::Rpc(r#"{"code":-32601}"#.into()).is_method_not_found());
    // 字符串兜底：纯文案 / 无 code 信封
    assert!(AcpError::Rpc("RPC error: Method not found".into()).is_method_not_found());
    assert!(AcpError::Rpc("RPC error: -32601".into()).is_method_not_found());
    assert!(AcpError::Rpc(r#"{"message":"Method not found"}"#.into()).is_method_not_found());
    // 非 -32601 错误 → false
    assert!(
        !AcpError::Rpc(r#"{"code":-32602,"message":"Invalid params"}"#.into())
            .is_method_not_found()
    );
    assert!(
        !AcpError::Rpc(r#"{"code":-32000,"message":"session missing"}"#.into())
            .is_method_not_found()
    );
    assert!(!AcpError::Rpc("RPC error: connection closed".into()).is_method_not_found());
    assert!(!AcpError::Rpc("ACP write timeout".into()).is_method_not_found());
    // 非 Rpc 变体 → false
    assert!(!AcpError::ConnectionClosed.is_method_not_found());
    assert!(!AcpError::RpcTimeout.is_method_not_found());
    assert!(!AcpError::WriteTimeout.is_method_not_found());
}

#[test]
fn session_update_variant_wire_strings_are_stable() {
    // 契约锁定：wire 字符串 ↔ 变体映射（前端/平台依赖这些字符串，勿改拼写）。
    assert_eq!(
        SessionUpdateVariant::from_str("agent_message_chunk"),
        Some(SessionUpdateVariant::AgentMessageChunk)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("user_message_chunk"),
        Some(SessionUpdateVariant::UserMessageChunk)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("usage_update"),
        Some(SessionUpdateVariant::UsageUpdate)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("tool_call"),
        Some(SessionUpdateVariant::ToolCall)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("tool_call_update"),
        Some(SessionUpdateVariant::ToolCallUpdate)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("session_info_update"),
        Some(SessionUpdateVariant::SessionInfoUpdate)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("config_option_update"),
        Some(SessionUpdateVariant::ConfigOptionUpdate)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("available_commands_update"),
        Some(SessionUpdateVariant::AvailableCommandsUpdate)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("current_mode_update"),
        Some(SessionUpdateVariant::CurrentModeUpdate)
    );
    // #316：官方 agent_thought_chunk + Peri 私有别名 + plan 入契约表。
    assert_eq!(
        SessionUpdateVariant::from_str("agent_thought_chunk"),
        Some(SessionUpdateVariant::AgentThoughtChunk)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("agent_reasoning_chunk"),
        Some(SessionUpdateVariant::AgentThoughtChunk)
    );
    assert_eq!(
        SessionUpdateVariant::from_str("plan"),
        Some(SessionUpdateVariant::Plan)
    );
    assert_eq!(SessionUpdateVariant::from_str("unknown_variant"), None);
}

#[test]
fn prompt_stop_outcome_rejects_malformed_stop_reasons() {
    // #316 审查边界：空白 stopReason 归畸形（不享宽松降级）；非字符串归畸形。
    let error = prompt_stop_outcome(&serde_json::json!({"stopReason": "   "}))
        .expect_err("blank stop reason must be rejected");
    assert!(error
        .to_string()
        .contains("invalid session/prompt response"));
    let error = prompt_stop_outcome(&serde_json::json!({"stopReason": 42}))
        .expect_err("non-string stop reason must be rejected");
    assert!(error
        .to_string()
        .contains("invalid session/prompt response"));
}

#[test]
fn validate_protocol_version_accepts_numeric_string_and_rejects_mismatch() {
    // 数字字符串 = 同一信息的非合规格式：比对不放过（可过则过，不合即 fail）。
    assert_eq!(
        validate_protocol_version(&serde_json::json!({"protocolVersion": "1"}), 1),
        Ok(())
    );
    assert!(validate_protocol_version(&serde_json::json!({"protocolVersion": "2"}), 1).is_err());
    assert!(
        validate_protocol_version(&serde_json::json!({"protocolVersion": "abc"}), 1).is_err(),
        "不可解析的 protocolVersion 必须 fail-closed"
    );
}

#[test]
fn classify_session_update_tolerates_peri_lenient_usage_shape() {
    // Peri 残缺 usage：typed（used 必填 size 缺失）失败 → fallback 仍归
    // UsageUpdate——fallback 设计的存在理由（#316 审查点名用例）。
    assert_eq!(
        classify_session_update(&serde_json::json!({
            "sessionUpdate": "usage_update",
            "used": 123,
            "value": 456
        })),
        Some(SessionUpdateVariant::UsageUpdate)
    );
}

#[test]
fn load_params_include_mcp_servers_field() {
    assert_eq!(
        load_params(
            "session-1",
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::Always
        )
        .unwrap(),
        serde_json::json!({
            "sessionId": "session-1",
            "cwd": "G:/workspace",
            "mcpServers": [],
        })
    );
}

/// G1-07a：OmitIfEmpty 且空数组 → params 无 mcpServers 键（v2 语义）；
/// 非空数组 → 照常插入。new/load 双路径。
#[test]
fn omit_if_empty_mode_omits_empty_field() {
    let params = crate::acp::session_new_params(
        "G:/workspace",
        Vec::new(),
        crate::agent_config::McpServersMode::OmitIfEmpty,
    )
    .unwrap();
    assert!(
        params.get("mcpServers").is_none(),
        "OmitIfEmpty + 空数组必须省略 mcpServers 键: {params}"
    );
    let params = crate::acp::session_new_params(
        "G:/workspace",
        vec![serde_json::json!({"name": "mcp-1"})],
        crate::agent_config::McpServersMode::OmitIfEmpty,
    )
    .unwrap();
    assert_eq!(params["mcpServers"][0]["name"], "mcp-1");
    // load 路径同语义
    let params = load_params(
        "session-1",
        "G:/workspace",
        Vec::new(),
        crate::agent_config::McpServersMode::OmitIfEmpty,
    )
    .unwrap();
    assert!(
        params.get("mcpServers").is_none(),
        "load OmitIfEmpty + 空数组必须省略 mcpServers 键: {params}"
    );
    let params = load_params(
        "session-1",
        "G:/workspace",
        vec![serde_json::json!({"name": "mcp-1"})],
        crate::agent_config::McpServersMode::OmitIfEmpty,
    )
    .unwrap();
    assert_eq!(params["mcpServers"][0]["name"], "mcp-1");
}

/// G1-07a：Always = 现状 wire——空数组恒发 mcpServers 字段（new/load 双路径）。
#[test]
fn always_mode_keeps_field() {
    let params =
        crate::acp::session_new_params("G:/workspace", Vec::new(), McpServersMode::Always).unwrap();
    assert_eq!(params["mcpServers"], serde_json::json!([]));
    let params = crate::acp::session_new_params(
        "G:/workspace",
        Vec::new(),
        crate::agent_config::McpServersMode::Always,
    )
    .unwrap();
    assert_eq!(params["mcpServers"], serde_json::json!([]));
    let params = load_params(
        "session-1",
        "G:/workspace",
        Vec::new(),
        crate::agent_config::McpServersMode::Always,
    )
    .unwrap();
    assert_eq!(params["mcpServers"], serde_json::json!([]));
}

#[test]
fn rejects_empty_and_error_session_ids() {
    for session_id in ["", "   ", "error", "ERROR"] {
        let response = serde_json::json!({"sessionId": session_id});
        assert!(session_id_from(&response).is_err());
    }
}

#[test]
fn accepts_valid_session_id_after_trimming_whitespace() {
    let response = serde_json::json!({"sessionId": "  session-42  "});
    assert_eq!(session_id_from(&response).unwrap(), "session-42");
}

#[test]
fn validates_prompt_stop_reasons() {
    // #316：typed 判定表——max_tokens 转正为合法终态，未知值 warn 降级 end_turn。
    assert_eq!(
        prompt_stop_outcome(&serde_json::json!({"stopReason": "end_turn"})),
        Ok(PromptStopOutcome::EndTurn)
    );
    assert_eq!(
        prompt_stop_outcome(&serde_json::json!({"stopReason": "max_turn_requests"})),
        Ok(PromptStopOutcome::MaxTurnRequests)
    );
    assert_eq!(
        prompt_stop_outcome(&serde_json::json!({"stopReason": "max_tokens"})),
        Ok(PromptStopOutcome::MaxTokens)
    );
    assert_eq!(
        prompt_stop_outcome(&serde_json::json!({"stopReason": "cancelled"}))
            .expect_err("cancelled must not complete normally")
            .to_string(),
        "prompt cancelled"
    );
    assert_eq!(
        prompt_stop_outcome(&serde_json::json!({"stopReason": "refusal"}))
            .expect_err("refusal must not complete normally")
            .to_string(),
        "prompt refused by agent"
    );
    // 行为变化（#316 已批准）：未知 stopReason 不再硬错——宽松降级 end_turn。
    assert_eq!(
        prompt_stop_outcome(&serde_json::json!({"stopReason": "paused"})),
        Ok(PromptStopOutcome::EndTurn)
    );
    assert_eq!(
        prompt_stop_outcome(&serde_json::json!({}))
            .expect_err("missing stop reason must be rejected")
            .to_string(),
        "invalid session/prompt response: {}"
    );
}

#[test]
fn validates_initialize_protocol_version_echo() {
    // 一致 → 放行；缺字段 → lenient 放行（存量 agent 兼容）；不一致 → fail-closed。
    assert_eq!(
        validate_protocol_version(&serde_json::json!({"protocolVersion": 1}), 1),
        Ok(())
    );
    assert_eq!(
        validate_protocol_version(&serde_json::json!({"agentCapabilities": {}}), 1),
        Ok(())
    );
    let mismatch = validate_protocol_version(&serde_json::json!({"protocolVersion": 2}), 1)
        .expect_err("version mismatch must fail");
    assert!(mismatch.contains("requested 1"), "{mismatch}");
    assert!(mismatch.contains("answered 2"), "{mismatch}");
}

#[test]
fn classify_session_update_prefers_typed_and_falls_back_to_aliases() {
    use crate::acp::SessionUpdateVariant as V;
    // typed-first：官方形状（含未消费字段）直接命中。
    assert_eq!(
        classify_session_update(&serde_json::json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": "thinking"}
        })),
        Some(V::AgentThoughtChunk)
    );
    assert_eq!(
        classify_session_update(&serde_json::json!({
            "sessionUpdate": "plan",
            "entries": [{"content": "step", "priority": "high", "status": "pending"}]
        })),
        Some(V::Plan)
    );
    // raw-fallback：Peri 私有别名（typed 解析不认识 agent_reasoning_chunk）。
    assert_eq!(
        classify_session_update(&serde_json::json!({"sessionUpdate": "agent_reasoning_chunk"})),
        Some(V::AgentThoughtChunk)
    );
    // 未知变体 → None（raw 照常 publish，与旧 `_ => {}` 一致）。
    assert_eq!(
        classify_session_update(&serde_json::json!({"sessionUpdate": "banana"})),
        None
    );
    assert_eq!(classify_session_update(&serde_json::json!({})), None);
}

#[test]
fn prompt_without_attachments_contains_one_text_block() {
    let blocks = prompt_blocks(
        "hello".to_string(),
        &[],
        crate::agent_config::AttachmentLimits::default(),
    )
    .unwrap();
    assert_eq!(
        blocks,
        vec![serde_json::json!({"type": "text", "text": "hello"})]
    );
}

#[test]
fn prompt_rejects_more_than_maximum_attachments() {
    let attachments = vec!["missing.txt".to_string(); DEFAULT_MAX_ATTACHMENTS + 1];
    let error = prompt_blocks(
        "hello".to_string(),
        &attachments,
        crate::agent_config::AttachmentLimits::default(),
    )
    .expect_err("attachment count limit must be enforced before file access");
    assert_eq!(
        error,
        format!("too many attachments: maximum is {DEFAULT_MAX_ATTACHMENTS}")
    );
}

#[test]
fn prompt_rejects_missing_attachment_with_explicit_error() {
    let error = prompt_blocks(
        "hello".to_string(),
        &["definitely-missing-pylon-attachment.txt".to_string()],
        crate::agent_config::AttachmentLimits::default(),
    )
    .expect_err("missing attachment must fail");
    assert!(error
        .starts_with("attachment metadata failed for definitely-missing-pylon-attachment.txt:"));
}

#[test]
fn prompt_rejects_directory_attachment() {
    let directory = crate::test_utils::unique_temp("attachment-dir");
    std::fs::create_dir_all(&directory).unwrap();
    let error = prompt_blocks(
        "hello".to_string(),
        &[directory.to_string_lossy().into_owned()],
        crate::agent_config::AttachmentLimits::default(),
    )
    .expect_err("directory attachment must fail");
    std::fs::remove_dir_all(&directory).unwrap();
    assert_eq!(
        error,
        format!("attachment is not a file: {}", directory.display())
    );
}

#[test]
fn prompt_rejects_unknown_binary_attachment() {
    let path = std::env::temp_dir().join(format!(
        "pylon-attachment-binary-{}.bin",
        std::process::id()
    ));
    std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
    let error = prompt_blocks(
        "hello".to_string(),
        &[path.to_string_lossy().into_owned()],
        crate::agent_config::AttachmentLimits::default(),
    )
    .expect_err("unknown binary attachment must fail");
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        error,
        format!("unsupported attachment type: {}", path.display())
    );
}

#[test]
fn prompt_rejects_attachment_grown_beyond_limit_after_metadata_check() {
    // A9：metadata 校验与读取间文件被增长（TOCTOU）时必须拒绝，不能无上限读取。
    let path = std::env::temp_dir().join(format!(
        "pylon-attachment-toctou-{}.bin",
        std::process::id()
    ));
    std::fs::write(&path, vec![0u8; DEFAULT_MAX_ATTACHMENT_BYTES as usize + 1]).unwrap();
    let error = prompt_blocks(
        "hello".to_string(),
        &[path.to_string_lossy().into_owned()],
        crate::agent_config::AttachmentLimits::default(),
    )
    .expect_err("oversized attachment must fail");
    std::fs::remove_file(&path).unwrap();
    assert!(
        error.starts_with("attachment too large:"),
        "must reject with the bounded-read too-large message, got: {error}"
    );
}

/// G1-04：缩小附件限制后边界拒绝——数量上限先行、大小上限按自定义值生效。
#[test]
fn custom_attachment_limits_apply() {
    let limits = crate::agent_config::AttachmentLimits {
        max_attachments: 1,
        max_attachment_bytes: 1024,
    };
    // 数量上限：2 个附件在文件访问前即拒绝（数量检查先行）
    let error = prompt_blocks(
        "hello".to_string(),
        &["a.txt".to_string(), "b.txt".to_string()],
        limits,
    )
    .expect_err("超过自定义数量上限必须拒绝");
    assert_eq!(error, "too many attachments: maximum is 1");
    // 大小上限：1KB 限制下 2KB 文本拒绝；默认限制（10MB）下通过
    let path = std::env::temp_dir().join(format!(
        "pylon-attachment-custom-{}.txt",
        std::process::id()
    ));
    std::fs::write(&path, "x".repeat(2048)).unwrap();
    let error = prompt_blocks(
        "hello".to_string(),
        &[path.to_string_lossy().into_owned()],
        limits,
    )
    .expect_err("超过自定义大小上限必须拒绝");
    assert!(error.starts_with("attachment too large:"));
    let blocks = prompt_blocks(
        "hello".to_string(),
        &[path.to_string_lossy().into_owned()],
        crate::agent_config::AttachmentLimits::default(),
    )
    .expect("默认限制下必须通过");
    assert_eq!(blocks.len(), 2, "text + attachment 两个块");
    std::fs::remove_file(&path).unwrap();
}

#[tokio::test]
async fn timeout_sends_cancel_and_waits_for_final_response() {
    let (tx, mut rx) = oneshot::channel();
    let cancel_called = Arc::new(AtomicBool::new(false));
    let cancel_called_for_task = cancel_called.clone();

    let outcome = wait_prompt_with_recovery(
        &mut rx,
        std::time::Duration::from_millis(200),
        std::time::Duration::from_millis(10),
        std::time::Duration::from_millis(10),
        || None,
        || false,
        move || async move {
            cancel_called_for_task.store(true, Ordering::SeqCst);
            tx.send(response())
                .map_err(|_| "receiver closed".to_string())
        },
        || async {},
    )
    .await;

    assert!(cancel_called.load(Ordering::SeqCst));
    match outcome {
        PromptWaitOutcome::CancelledAfterTimeout {
            response,
            cancel_error,
            timeout_kind,
            timeout_bound,
            elapsed,
            settle,
        } => {
            assert!(cancel_error.is_none());
            // #99：settle 窗口内回的终态胜出——Responded 必须与 response 成对。
            assert_eq!(settle, crate::acp::CancelSettleResolution::Responded);
            assert_eq!(timeout_kind, PromptTimeoutKind::FirstToken);
            assert_eq!(timeout_bound, std::time::Duration::from_millis(10));
            assert!(elapsed >= timeout_bound);
            assert_eq!(
                response
                    .and_then(|raw| raw.result)
                    .and_then(|value| value.get("stopReason").cloned()),
                Some(serde_json::json!("cancelled"))
            );
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[tokio::test]
async fn recovery_callback_runs_only_when_cancel_does_not_settle() {
    let (_tx, mut rx) = oneshot::channel();
    let force_called = Arc::new(AtomicBool::new(false));
    let force_called_for_task = force_called.clone();

    let outcome = wait_prompt_with_recovery(
        &mut rx,
        std::time::Duration::from_millis(5),
        std::time::Duration::from_millis(5),
        std::time::Duration::from_millis(5),
        || None,
        || false,
        || async { Ok(()) },
        move || async move {
            force_called_for_task.store(true, Ordering::SeqCst);
        },
    )
    .await;

    assert!(force_called.load(Ordering::SeqCst));
    assert!(matches!(
        outcome,
        PromptWaitOutcome::CancelledAfterTimeout { response: None, .. }
    ));
}

#[tokio::test]
async fn response_before_timeout_does_not_send_cancel() {
    let (tx, mut rx) = oneshot::channel();
    tx.send(response()).expect("receiver must be open");
    let cancel_called = Arc::new(AtomicBool::new(false));
    let cancel_called_for_task = cancel_called.clone();

    let outcome = wait_prompt_with_recovery(
        &mut rx,
        std::time::Duration::from_millis(10),
        std::time::Duration::from_secs(1),
        std::time::Duration::from_secs(1),
        || None,
        || false,
        move || async move {
            cancel_called_for_task.store(true, Ordering::SeqCst);
            Ok(())
        },
        || async {},
    )
    .await;

    assert!(!cancel_called.load(Ordering::SeqCst));
    assert!(matches!(outcome, PromptWaitOutcome::Response(_)));
}

#[tokio::test]
async fn sustained_activity_is_not_limited_by_prompt_total_timeout() {
    let (_tx, mut rx) = tokio::sync::oneshot::channel();
    let wait = wait_prompt_with_recovery(
        &mut rx,
        std::time::Duration::from_millis(5),
        std::time::Duration::from_millis(20),
        std::time::Duration::from_millis(20),
        // A real dispatcher updates this value for every thinking/tool/output step.
        // Returning now on every poll models an indefinitely active turn.
        || Some(std::time::Instant::now()),
        || false,
        || async { Ok(()) },
        || async {},
    );

    // The whole turn must remain alive despite prompt_timeout being shorter than
    // this observation window; only a quiet step may trigger cancellation.
    let result = tokio::time::timeout(std::time::Duration::from_millis(80), wait).await;
    assert!(
        result.is_err(),
        "持续活动不得受 prompt total timeout 截断，实际结果: {result:?}"
    );
}

// #352：用户 cancel 是一等判死输入——即使 agent 在 cancel 后持续产出（liveness
// 不断刷新、闲置判死被无限续命），flag 命中后也必须在一个轮询周期内判死并进入
// settle 窗口。以下三例分别钉：flag 初始置位直接判死、窗口内终态胜出、flag 迟到
// 置位仍能收敛（对修复前「永不收敛」的回归）。
#[tokio::test]
async fn user_cancel_flag_fires_immediately_despite_sustained_activity() {
    let (_tx, mut rx) = tokio::sync::oneshot::channel();
    let outcome = wait_prompt_with_recovery(
        &mut rx,
        std::time::Duration::from_millis(40),
        std::time::Duration::from_secs(30),
        std::time::Duration::from_secs(30),
        || Some(std::time::Instant::now()),
        || true,
        || async { Ok(()) },
        || async {},
    )
    .await;
    match outcome {
        PromptWaitOutcome::CancelledAfterTimeout {
            timeout_kind,
            timeout_bound,
            settle,
            elapsed,
            ..
        } => {
            assert_eq!(timeout_kind, PromptTimeoutKind::UserCancel);
            // 判死边界 = settle 窗口配置（flag 路径没有墙钟边界）。
            assert_eq!(timeout_bound, std::time::Duration::from_millis(40));
            assert_eq!(settle, crate::acp::CancelSettleResolution::SettleTimeout);
            assert!(
                elapsed < std::time::Duration::from_secs(5),
                "flag 初始置位必须立即判死，实际 elapsed = {elapsed:?}"
            );
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[tokio::test]
async fn user_cancel_settle_window_terminal_wins() {
    let (tx, mut rx) = oneshot::channel();
    let outcome = wait_prompt_with_recovery(
        &mut rx,
        std::time::Duration::from_millis(500),
        std::time::Duration::from_millis(50),
        std::time::Duration::from_millis(50),
        || Some(std::time::Instant::now()),
        || true,
        move || async move {
            tx.send(response())
                .map_err(|_| "receiver closed".to_string())
        },
        || async {},
    )
    .await;
    match outcome {
        PromptWaitOutcome::CancelledAfterTimeout {
            response,
            timeout_kind,
            settle,
            ..
        } => {
            assert_eq!(timeout_kind, PromptTimeoutKind::UserCancel);
            assert_eq!(settle, crate::acp::CancelSettleResolution::Responded);
            assert!(response.and_then(|raw| raw.result).is_some());
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[tokio::test]
async fn user_cancel_flag_converges_sustained_turn_after_late_set() {
    let (_tx, mut rx) = tokio::sync::oneshot::channel();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel_flag_for_task = cancel_flag.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        cancel_flag_for_task.store(true, Ordering::SeqCst);
    });
    let wait = wait_prompt_with_recovery(
        &mut rx,
        std::time::Duration::from_millis(60),
        std::time::Duration::from_millis(20),
        std::time::Duration::from_millis(20),
        // 持续活动：没有 cancel 输入时该回合不会被闲置/首 token 判死。
        || Some(std::time::Instant::now()),
        || cancel_flag.load(Ordering::SeqCst),
        || async { Ok(()) },
        || async {},
    );
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(2), wait)
        .await
        .expect("用户 cancel 后回合必须收敛（不被持续活动续命拖住）");
    match outcome {
        PromptWaitOutcome::CancelledAfterTimeout {
            timeout_kind,
            settle,
            ..
        } => {
            assert_eq!(timeout_kind, PromptTimeoutKind::UserCancel);
            assert_eq!(settle, crate::acp::CancelSettleResolution::SettleTimeout);
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[tokio::test]
async fn fake_acp_subprocess_completes_initialize_new_and_prompt_wire() {
    let agent = crate::test_utils::fake_acp_agent("fake-acp", &["--scenario", "alive"]);
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let child_id = client.child_id().expect("fake ACP child must exist");
    let new_response = client
        .prepare_rpc(
            METHOD_SESSION_NEW,
            serde_json::json!({"cwd": ".", "mcpServers": []}),
        )
        .expect("session/new must prepare")
        .complete()
        .await
        .expect("session/new must succeed");
    assert_eq!(session_id_from(&new_response).unwrap(), "fake-session-1");

    let rpc = client
        .prepare_prompt(
            "fake-session-1",
            vec![serde_json::json!({"type":"text","text":"hello"})],
        )
        .expect("prompt must serialize");
    assert!(rpc.id > 0);
    let mut response_rx = rpc
        .send_keep_rx()
        .await
        .expect("fake child stdin must remain open");
    let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut response_rx)
        .await
        .expect("fake ACP prompt response must arrive")
        .expect("fake ACP prompt pending must settle");
    // D12：`rpc.id` 是 Pylon 相关 id，不等于 wire id（SDK 用 string id）——
    // 只断言响应到达且 stopReason 正确。
    assert!(
        response.id.is_some(),
        "prompt response must carry a wire id"
    );
    assert_eq!(
        prompt_stop_outcome(&response.result.unwrap()).unwrap(),
        crate::acp::PromptStopOutcome::EndTurn
    );

    client.kill().expect("explicit child cleanup must succeed");
    assert!(
        !process_exists(child_id),
        "fake ACP child must exit after kill_and_wait"
    );
}

#[tokio::test]
async fn wire_trace_preserves_id_kinds_and_full_sequence() {
    // OBS-01 验收：fake ACP 发送 number/string/null/无 id 四类报文，trace 保留
    // 四类差异；一次 permission 闭环按 seq 排出完整顺序；方向/身份逐条保留。
    let agent = crate::test_utils::fake_acp_agent("fake-acp-trace", &["--scenario", "id-kinds"]);
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let trace = client
        .wire_trace()
        .expect("connected client must expose wire trace");
    assert!(trace.is_enabled());

    let new_response = client
        .prepare_rpc(
            METHOD_SESSION_NEW,
            serde_json::json!({"cwd": ".", "mcpServers": []}),
        )
        .expect("session/new must prepare")
        .complete()
        .await
        .expect("session/new must succeed");
    assert_eq!(session_id_from(&new_response).unwrap(), "fake-session-1");

    let rpc = client
        .prepare_prompt(
            "fake-session-1",
            vec![serde_json::json!({"type":"text","text":"hello"})],
        )
        .expect("prompt must serialize");
    let mut response_rx = rpc
        .send_keep_rx()
        .await
        .expect("fake child stdin must remain open");
    let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut response_rx)
        .await
        .expect("fake ACP prompt response must arrive")
        .expect("fake ACP prompt pending must settle");
    assert_eq!(
        prompt_stop_outcome(&response.result.unwrap()).unwrap(),
        crate::acp::PromptStopOutcome::EndTurn
    );

    // 轮询等待 writer/reader 线程把全部 wire 记录落进 ring buffer。
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let snap = loop {
        let snap = trace.snapshot();
        if snap.len() >= 11 {
            break snap;
        }
        if tokio::time::Instant::now() >= deadline {
            break snap;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };

    // 四条 id 形态必须全部保留（number/string/null/absent）——只针对 agent→pylon 方向；
    // pylon→agent 的 id 由引擎生成（legacy number / SDK string），不属本断言。
    let kinds: Vec<WireIdKind> = snap
        .iter()
        .filter(|record| record.direction == WireDirection::AgentToPylon)
        .map(|record| record.id_kind)
        .collect();
    assert!(
        kinds.contains(&WireIdKind::Number),
        "number id 必须保留，实际 {kinds:?}"
    );
    assert!(
        kinds.contains(&WireIdKind::String),
        "string id 必须保留，实际 {kinds:?}"
    );
    assert!(
        kinds.contains(&WireIdKind::Null),
        "null id 必须保留，实际 {kinds:?}"
    );
    assert!(
        kinds.contains(&WireIdKind::Absent),
        "absent id 必须保留，实际 {kinds:?}"
    );

    // monotonicSeq 严格单调（CR-003 命名；CR-001 snapshot 已排齐）。
    let seqs: Vec<u64> = snap.iter().map(|record| record.monotonic_seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(seqs, sorted, "seq 必须可排出完整顺序");
    assert!(
        seqs.windows(2).all(|pair| pair[1] > pair[0]),
        "seq 严格递增"
    );

    // string-id request_permission（P1 场景）必须按原样记录。
    let permission = snap
        .iter()
        .find(|record| record.method.as_deref() == Some("session/request_permission"))
        .expect("request_permission 必须在 trace 中");
    assert_eq!(permission.id_kind, WireIdKind::String);
    assert_eq!(permission.id_value, Some(serde_json::json!("perm-1")));
    assert_eq!(permission.direction, WireDirection::AgentToPylon);
    assert_eq!(permission.tool_call_id.as_deref(), Some("tc-1"));
    assert_eq!(
        permission.remote_session_id.as_deref(),
        Some("fake-session-1")
    );
    assert_eq!(
        permission.request_id.as_deref(),
        Some("perm-1"),
        "OBS-02：request_permission 的 wire id 必须记为 requestId"
    );

    // 方向/状态：至少存在 outbound 与 inbound 记录，状态与方向一致。
    assert!(
        snap.iter().any(|record| {
            record.direction == WireDirection::PylonToAgent && record.status == "sent"
        }),
        "必须存在 outbound(sent) 记录"
    );
    assert!(
        snap.iter().any(|record| {
            record.direction == WireDirection::AgentToPylon && record.status == "received"
        }),
        "必须存在 inbound(received) 记录"
    );
    // 身份逐条保留。
    for record in &snap {
        assert_eq!(&*record.agent_id, "fake-acp-trace");
        assert_eq!(&*record.source, "subprocess");
    }

    client.kill().expect("explicit child cleanup must succeed");
}

#[tokio::test]
async fn fake_acp_initialize_stores_agent_capabilities() {
    // P1（能力协商暴露）：initialize 响应里的 agentCapabilities 必须存进
    // AcpClient——前端能力驱动 UI（agent_status.capabilities）依赖此存储。
    let agent = crate::test_utils::fake_acp_agent("fake-acp-caps", &["--scenario", "caps"]);
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let caps = client
        .agent_capabilities()
        .expect("agentCapabilities 必须从握手响应存储");
    assert_eq!(caps["loadSession"], true);
    assert_eq!(caps["promptCapabilities"]["image"], true);
    // 断开态无 capabilities
    assert!(AcpClient::disconnected().agent_capabilities().is_none());
}

#[tokio::test]
async fn connect_failures_have_typed_preflight_and_spawn_stages() {
    let mut missing = crate::test_utils::fake_acp_agent_stub("missing");
    missing.exe = std::env::temp_dir()
        .join("definitely-missing-pylon-agent")
        .to_string_lossy()
        .to_string();
    let error = AcpClient::connect_with_logs(&missing, None)
        .await
        .err()
        .expect("missing executable path must fail preflight");
    let AcpError::Connect(failure) = error else {
        panic!("expected typed connect failure")
    };
    assert_eq!(failure.stage, AgentConnectStage::Preflight);
    assert_eq!(failure.code, "agent_executable_missing");
    assert!(!failure.retryable);

    let mut spawn = crate::test_utils::fake_acp_agent_stub("spawn");
    spawn.exe = format!("pylon-command-that-does-not-exist-{}", std::process::id());
    let error = AcpClient::connect_with_logs(&spawn, None)
        .await
        .err()
        .expect("unknown PATH command must fail spawn");
    let AcpError::Connect(failure) = error else {
        panic!("expected typed spawn failure")
    };
    assert_eq!(failure.stage, AgentConnectStage::Spawn);
    assert_eq!(failure.code, "agent_spawn_failed");
    assert!(failure.io_kind.is_some());
}

#[tokio::test]
async fn initialize_rpc_failure_keeps_safe_remote_summary() {
    let agent = crate::test_utils::fake_acp_agent(
        "typed-init-error",
        &[
            "--scenario",
            "error-echo",
            "--error-code",
            "-32041",
            "--error-message",
            "profile invalid",
            "--error-data",
            r#"{"token":"must-not-leak","attempt":1}"#,
        ],
    );
    let error = AcpClient::connect_with_logs(&agent, None)
        .await
        .err()
        .expect("initialize RPC error must fail connect");
    let AcpError::Connect(failure) = error else {
        panic!("expected typed initialize failure")
    };
    assert_eq!(failure.stage, AgentConnectStage::Initialize);
    assert_eq!(failure.code, "agent_initialize_failed");
    assert_eq!(failure.remote_code, Some(-32041));
    assert_eq!(
        failure.remote_data_summary.as_deref(),
        Some("object(2 keys)")
    );
    assert!(!failure.message.contains("must-not-leak"));
}

#[tokio::test]
async fn malformed_capabilities_have_capability_stage() {
    let agent =
        crate::test_utils::fake_acp_agent("typed-capability-error", &["--scenario", "bad-caps"]);
    let error = AcpClient::connect_with_logs(&agent, None)
        .await
        .err()
        .expect("non-object capabilities must fail connect");
    let AcpError::Connect(failure) = error else {
        panic!("expected typed capability failure")
    };
    assert_eq!(failure.stage, AgentConnectStage::Capability);
    assert_eq!(failure.code, "agent_capability_invalid");
    assert!(!failure.retryable);
}

#[test]
fn rpc_failure_kind_distinguishes_missing_session_from_method_and_transient_errors() {
    // #354 契约修正：文本/data 启发式的载体改用非保留码——-32000 已是协议级
    // authRequired（按结构化 code 一票判定，见下方 AuthRequired 断言）。
    for raw in [
        r#"{"code":-32602,"message":"session not found: s-1"}"#,
        r#"{"code":-32602,"message":"invalid session: s-1"}"#,
        r#"{"code":-32602,"message":"request rejected","data":{"kind":"session_missing"}}"#,
    ] {
        assert_eq!(
            AcpError::Rpc(raw.into()).rpc_failure_kind(),
            Some(RpcFailureKind::SessionMissing),
            "{raw}"
        );
    }
    // #354：协议级 authRequired 先于文本启发式——即使 message 像 session 缺失，
    // -32000 的协议语义（需要登录）优先。
    for raw in [
        r#"{"code":-32000,"message":"authentication required"}"#,
        r#"{"code":-32000,"message":"invalid session: s-1"}"#,
    ] {
        assert_eq!(
            AcpError::Rpc(raw.into()).rpc_failure_kind(),
            Some(RpcFailureKind::AuthRequired),
            "{raw}"
        );
    }
    for raw in [
        r#"{"code":-32601,"message":"Method not found"}"#,
        r#"{"code":-32602,"message":"invalid params: missing content"}"#,
        r#"{"code":-32001,"message":"rate limited"}"#,
    ] {
        assert_ne!(
            AcpError::Rpc(raw.into()).rpc_failure_kind(),
            Some(RpcFailureKind::SessionMissing),
            "{raw}"
        );
    }
}

#[tokio::test]
async fn fake_acp_eof_drains_pending_requests() {
    let agent =
        crate::test_utils::fake_acp_agent("fake-acp-eof", &["--scenario", "exit-immediately"]);
    let client = AcpClient::connect_with_logs(&agent, None).await;
    assert!(
        client.is_err(),
        "initialize must fail when fake ACP closes without a response"
    );
}

#[tokio::test]
async fn crashed_watch_signals_eof_after_broadcast_overflow() {
    // A7：洪泛 300 条（> BROADCAST_CAP=256）后 EOF——NOTIF_AGENT_CRASHED 广播
    // 必然被 Lagged 丢弃；崩溃信号必须经独立 watch 通道仍可靠送达（watch 保留
    // 最新值：订阅晚于崩溃时 has_changed 直接可读，订阅早于崩溃时 changed 触发）。
    let agent = crate::test_utils::fake_acp_agent("fake-acp-flood-crash", &["--scenario", "flood"]);
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("flood fake ACP must initialize");
    let mut crashed_rx = client.crashed_receiver();
    if *crashed_rx.borrow() {
        // 崩溃发生在订阅之前（connect 成功后立刻 EOF）——watch 保留最新值，直接可读
        // （`has_changed()` 对新订阅者恒为 false，不能用于此判定）。
    } else {
        tokio::time::timeout(std::time::Duration::from_secs(5), crashed_rx.changed())
            .await
            .expect("watch must signal crash within 5s")
            .expect("watch channel must stay open");
    }
    assert!(
        *crashed_rx.borrow_and_update(),
        "crashed watch value must be true after EOF"
    );
    assert!(client.is_crashed());
}

#[tokio::test]
async fn fake_acp_session_load_collects_replay_before_response() {
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-replay",
        &[
            "--scenario",
            "replay-history",
            "--load-chunks",
            r#"["history-1","history-2"]"#,
        ],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP replay agent must initialize");
    let (response, replay) = load_session_with_replay(
        client
            .begin_replay_capture("fake-session-replay")
            .expect("replay capture"),
        "fake-session-replay",
        ".",
        Vec::new(),
        McpServersMode::Always,
    )
    .await
    .expect("session/load must return after replay response");
    assert_eq!(response, serde_json::json!({"loaded": true}));
    assert_eq!(replay.events.len(), 2);
    assert_eq!(replay.events[0]["update"]["content"]["text"], "history-1");
    assert_eq!(replay.events[1]["update"]["content"]["text"], "history-2");
    assert!(replay.metadata.complete);
    assert!(!replay.metadata.truncated);
    assert_eq!(replay.metadata.dropped_count, 0);
    assert_eq!(replay.metadata.boundary.observed_count, 2);
    assert_eq!(replay.metadata.boundary.retained_start_ordinal, Some(1));
    assert_eq!(replay.metadata.boundary.retained_end_ordinal, Some(2));
}

/// G1-02：rpc_timeout 参数化——配置短 rpc_timeout 的 client 在 fake 慢响应上
/// 必须按配置超时返回 RpcTimeout（而非默认 30s 等待）。
#[tokio::test]
async fn rpc_timeout_from_config_is_used() {
    let mut agent =
        crate::test_utils::fake_acp_agent("fake-acp-rpc-timeout", &["--scenario", "silent"]);
    agent.acp = Some(crate::agent_config::AcpProtocolConfig {
        rpc_timeout_secs: Some(1),
        ..Default::default()
    });
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let start = std::time::Instant::now();
    let result = client
        .prepare_rpc(
            METHOD_SESSION_NEW,
            serde_json::json!({"cwd": ".", "mcpServers": []}),
        )
        .expect("session/new must prepare")
        .complete()
        .await;
    assert!(
        matches!(result, Err(AcpError::RpcTimeout)),
        "慢响应必须按配置短超时超时，实际: {result:?}"
    );
    assert!(
        start.elapsed() < std::time::Duration::from_secs(10),
        "必须用配置的短超时（1s）而非默认 30s，实际耗时 {:?}",
        start.elapsed()
    );
}

/// G1-02：replay_max 参数化——回放超过配置上限时截断且继续等响应（响应不得丢）。
#[tokio::test]
async fn replay_max_truncation_respects_config() {
    let mut agent = crate::test_utils::fake_acp_agent(
        "fake-acp-replay-cap",
        &[
            "--scenario",
            "replay-history",
            "--load-chunks",
            r#"["h0","h1","h2"]"#,
        ],
    );
    agent.acp = Some(crate::agent_config::AcpProtocolConfig {
        replay_max_events: Some(2),
        ..Default::default()
    });
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP replay cap agent must initialize");
    let (response, replay) = load_session_with_replay(
        client
            .begin_replay_capture("target-cap")
            .expect("replay capture"),
        "target-cap",
        ".",
        Vec::new(),
        McpServersMode::Always,
    )
    .await
    .expect("session/load must return after replay response");
    assert_eq!(response, serde_json::json!({"loaded": true}));
    assert_eq!(
        replay.events.len(),
        2,
        "回放必须按 replay_max=2 截断（3 条 fake 事件）"
    );
    assert_eq!(replay.events[0]["update"]["content"]["text"], "h1");
    assert_eq!(replay.events[1]["update"]["content"]["text"], "h2");
    assert!(!replay.metadata.complete);
    assert!(replay.metadata.truncated);
    assert_eq!(replay.metadata.dropped_count, 1);
    assert_eq!(replay.metadata.boundary.kind, "session-load-response");
    assert_eq!(replay.metadata.boundary.observed_count, 3);
    assert_eq!(replay.metadata.boundary.retained_start_ordinal, Some(2));
    assert_eq!(replay.metadata.boundary.retained_end_ordinal, Some(3));
    assert_eq!(
        serde_json::to_value(&replay.metadata).expect("replay metadata serializes"),
        serde_json::json!({
            "complete": false,
            "truncated": true,
            "droppedCount": 1,
            "boundary": {
                "kind": "session-load-response",
                "observedCount": 3,
                "retainedStartOrdinal": 2,
                "retainedEndOrdinal": 3
            }
        })
    );
}

#[tokio::test]
async fn fake_acp_cancel_and_close_send_expected_notifications() {
    let trace_path = crate::test_utils::unique_temp("acp-control").with_extension("jsonl");
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-control",
        &[
            "--scenario",
            "control-echo",
            "--trace-file",
            &trace_path.to_string_lossy(),
            "--trace-mode",
            "all",
        ],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP control agent must initialize");
    client
        .cancel_session("fake-session-control")
        .await
        .expect("cancel notification must write");
    close_session_rpc(&client, "fake-session-control")
        .await
        .expect("close request must respond");
    let trace =
        std::fs::read_to_string(&trace_path).expect("fake ACP must record control requests");
    std::fs::remove_file(&trace_path).ok();
    let requests: Vec<serde_json::Value> = trace
        .lines()
        .map(|line| serde_json::from_str(line).expect("trace line must be JSON"))
        .collect();
    assert!(requests.iter().any(|request| {
        request.get("method").and_then(|value| value.as_str()) == Some(METHOD_SESSION_CANCEL)
            && request.get("id").is_none()
            && request["params"]["sessionId"] == "fake-session-control"
    }));
    assert!(requests.iter().any(|request| {
        request.get("method").and_then(|value| value.as_str()) == Some(METHOD_SESSION_CLOSE)
            && request.get("id").is_some()
            && request["params"]["sessionId"] == "fake-session-control"
    }));
}
#[tokio::test]
async fn fake_acp_eof_wakes_pending_request_after_initialize() {
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-eof-after-init",
        &["--scenario", "crash-after-init"],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("initialize response must arrive before EOF");
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if client.is_crashed() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fake child EOF must be observed");
    let error = tokio::time::timeout(std::time::Duration::from_secs(2), new_session_rpc(&client))
        .await
        .expect("pending request must settle after EOF")
        .expect_err("EOF must reject a new request");
    assert!(error.to_string().contains("ACP connection closed"));
}

#[tokio::test]
async fn fake_acp_malformed_json_does_not_break_following_response() {
    let agent =
        crate::test_utils::fake_acp_agent("fake-acp-malformed", &["--scenario", "malformed-echo"]);
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("malformed line must not break initialize");
    let response = new_session_rpc(&client)
        .await
        .expect("response after malformed line must arrive");
    assert_eq!(session_id_from(&response).unwrap(), "after-malformed");
}

#[tokio::test]
async fn fake_acp_stderr_is_drained_into_safe_runtime_log() {
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-stderr",
        &[
            "--scenario",
            "alive",
            "--stderr-marker",
            "fake stderr diagnostic",
        ],
    );
    let logs = crate::runtime_log::RuntimeLogHub::new(16);
    let client = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
        .await
        .expect("stderr fake ACP must initialize");
    let _ = client;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let entries = logs.list(&crate::runtime_log::RuntimeLogQuery::default());
            if entries.iter().any(|entry| entry.source == "agent-stderr") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("stderr reader must publish runtime log");
    let entry = logs
        .list(&crate::runtime_log::RuntimeLogQuery::default())
        .into_iter()
        .find(|entry| entry.source == "agent-stderr")
        .expect("agent stderr log must exist");
    // LOG-01：message 必须是真实行文本（原占位 "Agent stderr output" 改为真实行，
    // 真实错误可检索）；同一 stderr 行只进 hub 一次（A 型 tracing 回声已被 target 跳过）。
    assert_eq!(entry.message, "fake stderr diagnostic");
    // LOG-02：普通 stderr 行不再默认 error——非结构化、无致命信号的普通行 → info。
    assert_eq!(entry.level, "info", "LOG-02：普通 stderr 行不得默认 error");
    assert_eq!(
        entry.fields.get("agent").and_then(|value| value.as_str()),
        Some("fake-acp-stderr")
    );
    let entries = logs.list(&crate::runtime_log::RuntimeLogQuery::default());
    let stderr_line_entries = entries
        .iter()
        .filter(|entry| {
            entry.source == "agent-stderr" || entry.message.contains("fake stderr diagnostic")
        })
        .count();
    // LOG-01 CR-001 消化（玉衡 MINOR）：本断言只守护"stderr reader 显式 push 恰好
    // 一次"（读线程是 `logs` 唯一来源）；A/B 双写中 A 型（tracing layer 捕获回声）
    // 在本测试 harness 下不可达——connect 未把 RuntimeLogLayer 绑定到本 hub，
    // tracing 事件到不了 `logs`。A/B 去重由 runtime_log 层单测
    // layer_skips_agent_stderr_echo_target_but_keeps_other_errors 真实兜底
    // （旧代码该测试必失败，非 vacuous）。
    assert_eq!(
        stderr_line_entries, 1,
        "stderr 行显式 push 恰好一次（A/B 去重另由 layer 单测守护）"
    );
}

#[tokio::test]
async fn fake_acp_delayed_response_stays_pending_until_response() {
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-delayed",
        &[
            "--scenario",
            "alive",
            "--session-id",
            "delayed-session",
            "--new-delay-ms",
            "150",
        ],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("delayed fake ACP must initialize");
    let response =
        tokio::time::timeout(std::time::Duration::from_secs(2), new_session_rpc(&client))
            .await
            .expect("delayed response must not hit test timeout")
            .expect("delayed response must succeed");
    assert_eq!(session_id_from(&response).unwrap(), "delayed-session");
}
#[tokio::test]
async fn fake_acp_prompt_timeout_sends_cancel_and_waits_for_cancelled_response() {
    let trace_path = crate::test_utils::unique_temp("acp-prompt").with_extension("jsonl");
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-prompt-timeout",
        &[
            "--scenario",
            "prompt-hang",
            "--trace-file",
            &trace_path.to_string_lossy(),
            "--trace-mode",
            "all",
        ],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("timeout fake ACP must initialize");
    let rpc = client
        .prepare_prompt(
            "fake-session-timeout",
            vec![serde_json::json!({"type":"text","text":"hello"})],
        )
        .expect("prompt must serialize");
    let request_id = rpc.id;
    let mut response_rx = rpc.send_keep_rx().await.expect("prompt must write");
    let outcome = wait_prompt_with_recovery(
        &mut response_rx,
        std::time::Duration::from_millis(200),
        std::time::Duration::from_millis(20),
        std::time::Duration::from_millis(20),
        || None,
        || false,
        || async {
            client
                .cancel_session("fake-session-timeout")
                .await
                .map_err(|error| error.to_string())
        },
        || async {},
    )
    .await;
    assert!(matches!(
        outcome,
        PromptWaitOutcome::CancelledAfterTimeout {
            response: None,
            cancel_error: None,
            ..
        }
    ));
    client.remove_pending(request_id);
    let trace =
        std::fs::read_to_string(&trace_path).expect("fake ACP must record prompt and cancel");
    std::fs::remove_file(&trace_path).ok();
    assert!(trace.lines().any(|line| {
        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        value.get("method").and_then(|method| method.as_str()) == Some(METHOD_SESSION_CANCEL)
            && value["params"]["sessionId"] == "fake-session-timeout"
    }));
}
#[tokio::test]
async fn writer_failure_signals_watch_and_pending_settles() {
    // 方案 2A 测试门：writer 写失败（broken pipe）必须统一结算——crashed=true、
    // watch 发 true、pending waiter 立即 Err，不再只置 crashed 等下次 EOF
    // （agent 僵死时 EOF 永不来）。
    // #157 确定性构造：close-stdin-after-init 场景应答 initialize 后**关闭自身
    // stdin 读端并驻留**——进程不退出，exit watcher / stdout EOF 不参与竞争，
    // prepare_rpc 的守卫必然放行；写失败的结算信号只能来自写失败本身。
    // （旧 crash-after-init 子进程即刻退出，全量并行下崩溃信号与 prepare_rpc
    // 竞争，守卫先行拒绝导致本测试偶发 panic。）
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-writer-fail",
        &["--scenario", "close-stdin-after-init"],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("initialize 应成功（首行写入正常）");
    let mut crashed_rx = client.crashed_receiver();
    // 子进程存活但 stdin 读端已关，writer 下次写必 broken pipe → 统一结算。
    let rpc = client
        .prepare_rpc(
            METHOD_SESSION_NEW,
            serde_json::json!({"cwd": ".", "mcpServers": []}),
        )
        .expect("prepare_rpc 不依赖进程状态（子进程存活）");
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), rpc.complete())
        .await
        .expect("写失败必须在 5s 内收敛（不得悬挂）");
    assert!(outcome.is_err(), "写失败必须返回 Err");
    assert!(client.is_crashed(), "crashed 必须置位");
    // watch 通道必须送达 true（dispatcher 依赖它触发自动重连）
    let watch_hit = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        if *crashed_rx.borrow_and_update() {
            return true;
        }
        crashed_rx.changed().await.is_ok() && *crashed_rx.borrow_and_update()
    })
    .await
    .unwrap_or(false);
    assert!(watch_hit, "writer failure 必须经 watch 信号送达");
    client.kill().expect("cleanup");
}
#[tokio::test]
async fn fake_acp_session_load_ignores_updates_from_other_sessions() {
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-update-isolation",
        &["--scenario", "update-isolation"],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("update isolation fake ACP must initialize");
    let (_response, replay) = load_session_with_replay(
        client
            .begin_replay_capture("target-session")
            .expect("replay capture"),
        "target-session",
        ".",
        Vec::new(),
        McpServersMode::Always,
    )
    .await
    .expect("target session load must succeed");
    let texts: Vec<&str> = replay
        .events
        .iter()
        .filter_map(|params| params["update"]["content"]["text"].as_str())
        .collect();
    assert_eq!(texts, vec!["target-1", "target-2"]);
    assert!(!texts.contains(&"must-not-leak"));
}

#[tokio::test]
async fn fake_acp_session_load_replay_eof_returns_connection_closed() {
    // 优化 3：回放期间 EOF（崩溃）——每轮复检 crashed 立即 ConnectionClosed，
    // 而非依赖 NOTIF_AGENT_CRASHED 广播被跳过（非目标 session/update）后
    // 挂满 30s 假超时。
    let agent =
        crate::test_utils::fake_acp_agent("fake-acp-replay-eof", &["--scenario", "replay-eof"]);
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP replay EOF agent must initialize");
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        load_session_with_replay(
            client
                .begin_replay_capture("fake-session-replay-eof")
                .expect("replay capture"),
            "fake-session-replay-eof",
            ".",
            Vec::new(),
            McpServersMode::Always,
        ),
    )
    .await
    .expect("replay EOF must fail fast, not hang until the 30s timeout");
    assert!(matches!(result, Err(AcpError::ConnectionClosed)));
    assert!(client.is_crashed(), "EOF must mark the connection crashed");
}

#[tokio::test]
async fn fake_acp_prompt_cancel_returns_final_cancelled_response() {
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-cancel-response",
        &["--scenario", "prompt-cancel-respond"],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("cancel-response fake ACP must initialize");
    let rpc = client
        .prepare_prompt(
            "fake-session-cancel-response",
            vec![serde_json::json!({"type":"text","text":"hello"})],
        )
        .expect("prompt must serialize");
    let mut response_rx = rpc.send_keep_rx().await.expect("prompt must write");
    let outcome = wait_prompt_with_recovery(
        &mut response_rx,
        std::time::Duration::from_millis(200),
        std::time::Duration::from_millis(20),
        std::time::Duration::from_millis(20),
        || None,
        || false,
        || async {
            client
                .cancel_session("fake-session-cancel-response")
                .await
                .map_err(|error| error.to_string())
        },
        || async {},
    )
    .await;
    match outcome {
        PromptWaitOutcome::CancelledAfterTimeout {
            response: Some(raw),
            cancel_error,
            timeout_kind,
            timeout_bound,
            elapsed,
            settle,
        } => {
            assert!(cancel_error.is_none());
            assert_eq!(settle, crate::acp::CancelSettleResolution::Responded);
            assert_eq!(timeout_kind, PromptTimeoutKind::FirstToken);
            assert_eq!(timeout_bound, std::time::Duration::from_millis(20));
            assert!(elapsed >= timeout_bound);
            assert_eq!(
                raw.result
                    .and_then(|value| value.get("stopReason").cloned()),
                Some(serde_json::json!("cancelled"))
            );
        }
        other => panic!("expected final cancelled response, got {other:?}"),
    }
}

#[tokio::test]
async fn send_response_writes_result_with_matching_id() {
    let trace_path =
        std::env::temp_dir().join(format!("pylon-acp-response-{}.jsonl", std::process::id()));
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-response",
        &[
            "--scenario",
            "permission-proactive",
            "--permission-id",
            "42",
            "--permission-params",
            r#"{"sessionId":"s-1","toolCallId":"tc-1","options":[]}"#,
            "--trace-file",
            &trace_path.to_string_lossy(),
            "--trace-mode",
            "all",
        ],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    // agent 先发一条 id=42 的请求；等它进入 Kernel inbox 后用后端中立 responder 应答。
    // #99 行为变化：agent JSON-RPC 请求走控制 lane（recv_control），不再与
    // session/update 同队——控制帧优先，通知洪泛不饿死交互请求。
    let mut inbox = client
        .take_notification_inbox()
        .expect("inbox available exactly once");
    let request = tokio::time::timeout(std::time::Duration::from_secs(5), inbox.recv_control())
        .await
        .expect("agent request must arrive")
        .expect("inbox must stay open");
    assert_eq!(
        request.raw.method.as_deref(),
        Some("session/request_permission")
    );
    let result = serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}});
    assert!(
        client
            .responder()
            .respond(RequestId::Number(42), result.clone())
            .await,
        "responder must write the response"
    );
    // 等待写通道 flush（fake 脚本逐行写 trace）
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let trace = std::fs::read_to_string(&trace_path).expect("read trace");
    std::fs::remove_file(&trace_path).ok();
    let lines: Vec<serde_json::Value> = trace
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let response = lines
        .iter()
        .find(|line| line.get("id").and_then(|v| v.as_u64()) == Some(42))
        .expect("response line must exist");
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["result"]["outcome"]["outcome"], "selected");
    assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");
    client.kill().expect("cleanup");
}

#[tokio::test]
async fn fake_acp_initialize_uses_configured_client_capabilities() {
    let trace_path =
        std::env::temp_dir().join(format!("pylon-acp-caps-{}.jsonl", std::process::id()));
    let agent = crate::agent_config::AgentDef {
        name: "fake-acp-caps".to_string(),
        provider: None,
        transport: "subprocess".to_string(),
        exe: crate::test_utils::fake_agent_bin()
            .to_string_lossy()
            .into_owned(),
        args: vec![
            "--scenario".to_string(),
            "trace-all".to_string(),
            "--trace-file".to_string(),
            trace_path.to_string_lossy().into_owned(),
            "--trace-mode".to_string(),
            "all".to_string(),
        ],
        cwd: None,
        env: HashMap::new(),
        default: false,
        set_model_api: false,
        model: None,
        hermes_profile: None,
        acp_args: Vec::new(),
        acp: Some(crate::agent_config::AcpProtocolConfig {
            initialize_caps: Some(serde_json::json!({
                "fs": {},
                "auth": {},
                "_meta": {"peri.skillNames": true}
            })),
            ..Default::default()
        }),
    };
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP with configured caps must initialize");
    client.kill().expect("cleanup");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let trace = std::fs::read_to_string(&trace_path).expect("read trace");
    std::fs::remove_file(&trace_path).ok();
    let request: serde_json::Value = trace
        .lines()
        .map(|line| serde_json::from_str(line).expect("trace line"))
        .find(|value: &serde_json::Value| {
            value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
        })
        .expect("initialize must be traced");
    assert_eq!(
        request["params"]["clientCapabilities"]["fs"],
        serde_json::json!({})
    );
    assert_eq!(
        request["params"]["clientCapabilities"]["_meta"]["peri.skillNames"],
        serde_json::json!(true)
    );
    assert!(
        request["params"]["clientCapabilities"]
            .get("tokenStats")
            .is_none(),
        "覆盖后不再带统一默认 caps"
    );
    // G1-03：未配置的 protocolVersion/clientInfo 保持默认现值（wire 不变）
    assert_eq!(request["params"]["protocolVersion"], serde_json::json!(1));
    assert_eq!(
        request["params"]["clientInfo"],
        serde_json::json!({"name": "Pylon", "version": "1.0.0"})
    );
}

#[tokio::test]
async fn fake_acp_initialize_defaults_to_unified_capabilities() {
    let trace_path = std::env::temp_dir().join(format!(
        "pylon-acp-caps-default-{}.jsonl",
        std::process::id()
    ));
    let agent = crate::test_utils::fake_acp_agent(
        "fake-acp-caps-default",
        &[
            "--scenario",
            "trace-all",
            "--trace-file",
            &trace_path.to_string_lossy(),
            "--trace-mode",
            "all",
        ],
    );
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP with default caps must initialize");
    client.kill().expect("cleanup");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let trace = std::fs::read_to_string(&trace_path).expect("read trace");
    std::fs::remove_file(&trace_path).ok();
    let request: serde_json::Value = trace
        .lines()
        .map(|line| serde_json::from_str(line).expect("trace line"))
        .find(|value: &serde_json::Value| {
            value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
        })
        .expect("initialize must be traced");
    assert_eq!(
        request["params"]["clientCapabilities"]["tokenStats"],
        serde_json::json!(true)
    );
    assert_eq!(
        request["params"]["clientCapabilities"]["_meta"]["peri.replay"],
        serde_json::json!(true)
    );
    // G1-03：默认路径 protocolVersion/clientInfo 为现状现值（wire 逐字节不变）
    assert_eq!(request["params"]["protocolVersion"], serde_json::json!(1));
    assert_eq!(
        request["params"]["clientInfo"],
        serde_json::json!({"name": "Pylon", "version": "1.0.0"})
    );
}

/// G1-03：声明 protocol_version/client_info 后按声明进 wire（覆盖路径）。
/// #348 A6 白名单（`SUPPORTED_PROTOCOL_VERSIONS = &[1]`）落地后，版本这一半
/// 的声明值只能取 1——与缺省同值，**不再具备区分度**；本用例真正区分缺省的
/// 是 client_info（9.9.9）。集合外值（如 2）的拒绝见下一条 connect 级用例。
#[tokio::test]
async fn custom_protocol_version_and_client_info_reach_wire() {
    let trace_path =
        std::env::temp_dir().join(format!("pylon-acp-handshake-{}.jsonl", std::process::id()));
    let agent = crate::agent_config::AgentDef {
        name: "fake-acp-handshake".to_string(),
        provider: None,
        transport: "subprocess".to_string(),
        exe: crate::test_utils::fake_agent_bin()
            .to_string_lossy()
            .into_owned(),
        args: vec![
            "--scenario".to_string(),
            "trace-all".to_string(),
            "--trace-file".to_string(),
            trace_path.to_string_lossy().into_owned(),
            "--trace-mode".to_string(),
            "all".to_string(),
        ],
        cwd: None,
        env: HashMap::new(),
        default: false,
        set_model_api: false,
        model: None,
        hermes_profile: None,
        acp_args: Vec::new(),
        acp: Some(crate::agent_config::AcpProtocolConfig {
            protocol_version: Some(1),
            client_info: Some(serde_json::json!({"name": "Pylon", "version": "9.9.9"})),
            ..Default::default()
        }),
    };
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP with custom handshake must initialize");
    client.kill().expect("cleanup");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let trace = std::fs::read_to_string(&trace_path).expect("read trace");
    std::fs::remove_file(&trace_path).ok();
    let request: serde_json::Value = trace
        .lines()
        .map(|line| serde_json::from_str(line).expect("trace line"))
        .find(|value: &serde_json::Value| {
            value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
        })
        .expect("initialize must be traced");
    // 与缺省同值（白名单内仅 1），此断言只守「声明值原样进 wire」的通路。
    assert_eq!(
        request["params"]["protocolVersion"],
        serde_json::json!(1),
        "声明的 protocol_version 必须进 wire"
    );
    assert_eq!(
        request["params"]["clientInfo"],
        serde_json::json!({"name": "Pylon", "version": "9.9.9"}),
        "声明的 client_info 必须进 wire"
    );
    // caps 未声明 → 默认统一 caps 不受影响
    assert_eq!(
        request["params"]["clientCapabilities"]["tokenStats"],
        serde_json::json!(true)
    );
}

/// #348 A6：集合外 protocol_version（2）在真实 connect 级 fail-closed——
/// `build_initialize_plan` 在发送 initialize **之前**拒绝，错误码为
/// `agent_client_capabilities_invalid`，且该次运行的 trace 里不出现
/// `initialize` 行（声明值未落 wire）。
#[tokio::test]
async fn unsupported_protocol_version_fails_connect_before_wire() {
    let trace_path =
        std::env::temp_dir().join(format!("pylon-acp-pv2-reject-{}.jsonl", std::process::id()));
    let agent = crate::agent_config::AgentDef {
        name: "fake-acp-pv2-reject".to_string(),
        provider: None,
        transport: "subprocess".to_string(),
        exe: crate::test_utils::fake_agent_bin()
            .to_string_lossy()
            .into_owned(),
        args: vec![
            "--scenario".to_string(),
            "trace-all".to_string(),
            "--trace-file".to_string(),
            trace_path.to_string_lossy().into_owned(),
            "--trace-mode".to_string(),
            "all".to_string(),
        ],
        cwd: None,
        env: HashMap::new(),
        default: false,
        set_model_api: false,
        model: None,
        hermes_profile: None,
        acp_args: Vec::new(),
        acp: Some(crate::agent_config::AcpProtocolConfig {
            protocol_version: Some(2),
            ..Default::default()
        }),
    };
    let error = AcpClient::connect_with_logs(&agent, None)
        .await
        .err()
        .expect("protocol_version 2 must fail connect");
    let AcpError::Connect(failure) = error else {
        panic!("expected typed connect failure for protocol_version 2")
    };
    assert_eq!(failure.code, "agent_client_capabilities_invalid");
    assert!(!failure.retryable);
    // fake agent 启动即创建 trace 文件；给子进程留出落盘时间。
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let initialize_reached_wire = std::fs::read_to_string(&trace_path)
        .map(|trace| {
            trace.lines().any(|line| {
                serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("method")
                            .and_then(|m| m.as_str())
                            .map(str::to_string)
                    })
                    .as_deref()
                    == Some(METHOD_INITIALIZE)
            })
        })
        // 文件不存在同样证明 initialize 未发出（fake agent 未收到任何帧）。
        .unwrap_or(false);
    assert!(
        !initialize_reached_wire,
        "被拒绝的 initialize 不得出现在 wire trace 中"
    );
    std::fs::remove_file(&trace_path).ok();
}

/// 方案 G 演进：hermes_profile 绝对路径 → 子进程 HERMES_HOME 注入。
/// fake 脚本把 HERMES_HOME 写入 trace 文件，回读断言注入生效。
#[tokio::test]
async fn hermes_profile_injects_hermes_home_env() {
    let profile_dir = std::env::temp_dir().join(format!("pylon-profile-{}", std::process::id()));
    std::fs::create_dir_all(&profile_dir).unwrap();
    let trace_path =
        std::env::temp_dir().join(format!("pylon-hermes-env-{}.jsonl", std::process::id()));
    let mut agent = crate::agent_config::AgentDef {
        name: "fake-hermes".to_string(),
        provider: None,
        transport: "subprocess".to_string(),
        exe: crate::test_utils::fake_agent_bin()
            .to_string_lossy()
            .into_owned(),
        args: vec![
            "--scenario".to_string(),
            "env-probe".to_string(),
            "--env-var".to_string(),
            "HERMES_HOME".to_string(),
            "--trace-file".to_string(),
            trace_path.to_string_lossy().into_owned(),
        ],
        cwd: None,
        env: HashMap::new(),
        default: false,
        set_model_api: true,
        model: None,
        hermes_profile: Some(profile_dir.to_string_lossy().into_owned()),
        acp_args: Vec::new(),
        acp: None,
    };
    // 绝对路径形态不需要 Hermes home 探测，测试不依赖本机环境。
    agent.hermes_profile = Some(profile_dir.to_string_lossy().into_owned());
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake hermes must initialize");
    client.kill().expect("cleanup");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let trace = std::fs::read_to_string(&trace_path).expect("read env trace");
    std::fs::remove_file(&trace_path).ok();
    std::fs::remove_dir_all(&profile_dir).ok();
    assert_eq!(
        trace.trim(),
        profile_dir.to_string_lossy(),
        "HERMES_HOME 必须注入为 hermes_profile 解析目录"
    );
}

/// 方案 G 演进：未配置 hermes_profile 时不注入 HERMES_HOME（现状行为不回归）。
#[tokio::test]
async fn unset_hermes_profile_does_not_inject_env() {
    let trace_path =
        std::env::temp_dir().join(format!("pylon-hermes-noenv-{}.jsonl", std::process::id()));
    let agent = crate::agent_config::AgentDef {
        name: "fake-hermes-plain".to_string(),
        provider: None,
        transport: "subprocess".to_string(),
        exe: crate::test_utils::fake_agent_bin()
            .to_string_lossy()
            .into_owned(),
        args: vec![
            "--scenario".to_string(),
            "env-probe".to_string(),
            "--env-var".to_string(),
            "HERMES_HOME".to_string(),
            "--trace-file".to_string(),
            trace_path.to_string_lossy().into_owned(),
        ],
        cwd: None,
        env: HashMap::new(),
        default: false,
        set_model_api: true,
        model: None,
        hermes_profile: None,
        acp_args: Vec::new(),
        acp: None,
    };
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake hermes must initialize");
    client.kill().expect("cleanup");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let trace = std::fs::read_to_string(&trace_path).expect("read env trace");
    std::fs::remove_file(&trace_path).ok();
    // 子进程默认继承 Pylon 进程环境——测试进程若本身有 HERMES_HOME 则透传。
    // 断言只能区分"显式注入的 profile 路径"与"未注入"两种：未配置时子进程
    // 读到的是进程环境原值（非注入产物），不可能等于临时 profile 目录。
    assert_ne!(
        trace.trim(),
        format!(
            "{}",
            std::env::temp_dir()
                .join(format!("pylon-profile-{}", std::process::id()))
                .to_string_lossy()
        ),
        "未配置 hermes_profile 时不得注入临时 profile 路径"
    );
}

fn process_exists(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

/// A5① 连接 fixture：wrapper provider 的连接必须走适配器本体，且子进程收到的
/// argv/env 与 `LaunchPlan` 一致——vendor CLI 只作为探测证据，绝不出现在 argv 中。
///
/// codex 的 catalog recipe 是「路径 `codex-acp`，无参数」，adapterRelation 指向
/// vendor CLI `codex`。本测试用 fake ACP agent 充当适配器：先把自己真实收到的
/// argv 与标记 env 写进文件，再完成一次 initialize。
#[tokio::test]
async fn codex_wrapper_connects_through_the_adapter_not_the_vendor_cli() {
    let trace_path =
        std::env::temp_dir().join(format!("pylon-codex-wrapper-{}.jsonl", std::process::id()));
    let mut env = HashMap::new();
    env.insert(
        "PYLON_WRAPPER_MARKER".to_string(),
        "adapter-side".to_string(),
    );
    let agent = crate::agent_config::AgentDef {
        name: "codex".to_string(),
        // provider 决定 catalog profile：codex 是 wrapper（adapterRelation.nativeCmd = codex）。
        provider: Some("codex".to_string()),
        transport: "subprocess".to_string(),
        exe: crate::test_utils::fake_agent_bin()
            .to_string_lossy()
            .into_owned(),
        args: vec![
            "--scenario".to_string(),
            "argv-probe".to_string(),
            "--env-var".to_string(),
            "PYLON_WRAPPER_MARKER".to_string(),
            "--trace-file".to_string(),
            trace_path.to_string_lossy().into_owned(),
        ],
        cwd: None,
        env,
        default: false,
        set_model_api: false,
        model: None,
        hermes_profile: None,
        acp_args: Vec::new(),
        acp: None,
    };
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("wrapper 适配器必须能完成 initialize");
    client.kill().expect("cleanup");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let trace = std::fs::read_to_string(&trace_path).expect("read argv trace");
    std::fs::remove_file(&trace_path).ok();
    let observed: serde_json::Value = serde_json::from_str(trace.trim()).expect("trace 是 JSON");
    let argv: Vec<String> = observed["argv"]
        .as_array()
        .expect("argv 是数组")
        .iter()
        .map(|item| item.as_str().unwrap_or_default().to_string())
        .collect();
    // 适配器只收到自己的场景参数（假 bin 本体 + argv-probe 旗标）；catalog recipe
    // 的 args 为空，未追加任何参数。P1 后适配器本体 = pylon-fake-agent bin，
    // 原断言的「解释器参数」形态随之更新为「场景旗标在 argv」。
    assert!(
        argv.windows(2)
            .any(|window| window == ["--scenario", "argv-probe"]),
        "argv 应包含适配器自身的场景参数: {argv:?}"
    );
    assert!(
        !argv
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("codex") || arg.eq_ignore_ascii_case("codex-acp")),
        "vendor CLI 与适配器名都不得作为参数注入: {argv:?}"
    );
    // per-agent env 经 plan 一路到达子进程。
    assert_eq!(
        observed["marker"].as_str(),
        Some("adapter-side"),
        "per-agent env 必须到达适配器进程"
    );
}

/// A5① Claude 侧连接 fixture：catalog 声明的 client capabilities 必须**真实出现在
/// `initialize` 请求里**，而不只是存在于目录中。
///
/// 与 Codex 的 fixture（vendor CLI 不进 argv）互补：Claude 是唯一同时声明了
/// `clientCapabilities` 与带下限版本 gate 的 provider，所以这里断言的是「声明
/// 落到 wire」，并同时证明该声明是 **provider 作用域**的——没有声明的 provider
/// 只拿到 Pylon 默认 caps。
#[tokio::test]
async fn claude_wrapper_puts_declared_client_capabilities_on_the_wire() {
    /// 用给定 provider 连接一次 fake 适配器，返回它真实收到的 `initialize` params。
    async fn capture_initialize_params(provider: &str, tag: &str) -> serde_json::Value {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-{tag}-init-{}.jsonl", std::process::id()));
        let agent = crate::agent_config::AgentDef {
            name: tag.to_string(),
            provider: Some(provider.to_string()),
            transport: "subprocess".to_string(),
            exe: crate::test_utils::fake_agent_bin()
                .to_string_lossy()
                .into_owned(),
            args: vec![
                "--scenario".to_string(),
                "init-params-probe".to_string(),
                "--trace-file".to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        };
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake 适配器必须完成 initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let raw = std::fs::read_to_string(&trace_path).expect("read initialize params");
        std::fs::remove_file(&trace_path).ok();
        serde_json::from_str(raw.trim()).expect("initialize params 是 JSON")
    }

    let claude = capture_initialize_params("claude-code", "claude-caps").await;
    let caps = &claude["clientCapabilities"];
    // Pylon 默认 caps 仍在（声明是合并，不是替换）。
    assert_eq!(caps["tokenStats"], serde_json::json!(true));
    assert_eq!(caps["_meta"]["peri.replay"], serde_json::json!(true));
    // catalog 声明抵达 wire：`_meta` 内嵌的布尔与嵌套对象都逐字段一致。
    assert_eq!(
        caps["_meta"]["subagent-transcript"],
        serde_json::json!(true)
    );
    assert_eq!(
        caps["_meta"]["jetbrains.air"],
        serde_json::json!({"version": 1, "capabilities": ["sessionFailure"]})
    );
    // 握手另外两段仍来自协议配置（protocolVersion 是数值，不是字符串）。
    assert_eq!(claude["clientInfo"]["name"], serde_json::json!("Pylon"));
    assert!(claude["protocolVersion"].is_u64());

    // provider 作用域：未声明 caps 的 provider 拿到的只有默认 `_meta` 键。
    let hermes = capture_initialize_params("hermes", "hermes-caps").await;
    let hermes_meta = hermes["clientCapabilities"]["_meta"]
        .as_object()
        .expect("_meta 是对象");
    assert!(
        !hermes_meta.contains_key("subagent-transcript"),
        "未声明的 provider 不得继承他人声明: {hermes_meta:?}"
    );
    assert!(!hermes_meta.contains_key("jetbrains.air"));
    assert!(hermes_meta.contains_key("peri.replay"));
}

#[test]
fn acp_kind_classifies_elicitation_complete_notification() {
    // #316：elicitation/complete 归控制帧通知（URL 模式外带交互完成）。
    assert_eq!(
        crate::acp::AcpKind::from_method(Some("elicitation/complete")),
        crate::acp::AcpKind::ElicitationComplete
    );
    assert_eq!(
        crate::acp::AcpKind::from_method(Some("session/update")),
        crate::acp::AcpKind::SessionUpdate
    );
    assert_eq!(
        crate::acp::AcpKind::from_method(Some("peri/agent_event")),
        crate::acp::AcpKind::ProviderExtension
    );
}

#[test]
fn prompt_image_attachment_block_matches_official_wire_shape() {
    // #316 审查 P2：typed ContentBlock::Image 的 mimeType rename 是幂等批次
    // 最脆的一环——钉住官方形状 {"type":"image","mimeType","data"}。
    use base64::Engine as _;
    let dir = crate::test_utils::unique_temp("attachment-png");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pixel.png");
    // 最小合法 PNG：8 字节签名 + IHDR（infer 按签名识别，无需完整解码）。
    // 字节串字面量：无数组折行宽度歧义（rustfmt 跨版本稳定）。
    let bytes: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89";
    std::fs::write(&path, bytes).unwrap();
    let blocks = prompt_blocks(
        "看图".to_string(),
        &[path.to_string_lossy().into_owned()],
        crate::agent_config::AttachmentLimits::default(),
    )
    .expect("png attachment must serialize");
    assert_eq!(blocks.len(), 2);
    assert_eq!(
        blocks[1],
        serde_json::json!({
            "type": "image",
            "mimeType": "image/png",
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
