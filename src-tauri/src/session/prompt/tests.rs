//! Prompt 域内联测试（W3 重构批次 S1 自 session/prompt.rs 整体随迁，逐字未改；
//! 共享夹具经 `use super::*` 引四兄弟模块）。
use super::*;

#[test]
fn sdk_synthetic_closed_response_has_connection_semantics() {
    let raw = acp::RawMessage {
        id: None,
        method: None,
        kind: acp::AcpKind::Response,
        result: None,
        params: None,
        error: Some(serde_json::json!("ACP connection closed")),
    };
    assert!(is_closed_transport_response(&raw));
    let provider = acp::RawMessage {
        error: Some(serde_json::json!({"code": -32000, "message": "provider failed"})),
        ..raw
    };
    assert!(!is_closed_transport_response(&provider));
}

/// #324：拦截谓词只认精确 `stopReason: "cancelled"`——空白/大小写变体与
/// 缺失字段不享中性结算（仍走 #316 闭式表 fail-closed）。
#[test]
fn is_cancelled_stop_response_matches_exact_spelling_only() {
    assert!(is_cancelled_stop_response(
        &serde_json::json!({"stopReason": "cancelled"})
    ));
    assert!(is_cancelled_stop_response(&serde_json::json!({
        "stopReason": "cancelled",
        "usage": {"total": 3}
    })));
    assert!(!is_cancelled_stop_response(
        &serde_json::json!({"stopReason": " cancelled"})
    ));
    assert!(!is_cancelled_stop_response(
        &serde_json::json!({"stopReason": "Cancelled"})
    ));
    assert!(!is_cancelled_stop_response(
        &serde_json::json!({"stopReason": ""})
    ));
    assert!(!is_cancelled_stop_response(
        &serde_json::json!({"stopReason": 42})
    ));
    assert!(!is_cancelled_stop_response(&serde_json::json!({})));
}

/// #99（评审 E3 回归锁）：empty-turn 细分以账本活动标志为判定源——
/// dispatcher 在处理 chunk/工具调用的同一临界区写入账本，settle 侧据此
/// 判定 tool-only / agent-empty，不受响应直达路径先于 inbox 排空的影响。
#[test]
fn refine_empty_turn_uses_ledger_activity_flags() {
    let runtime = AgentRuntime::new_disconnected();
    let key = crate::acp::TurnKey {
        local_session_id: "local:r1".to_string(),
        remote_session_id: "peri-r1".to_string(),
        generation: 1,
        turn_id: 1,
    };
    runtime.turn_ledger.begin(key.clone(), 0);
    // 账本只见到工具活动 → tool-only
    runtime.turn_ledger.note_session_activity(
        "local:r1",
        "peri-r1",
        1,
        1,
        crate::acp::ActivityFlags {
            saw_tool: true,
            ..Default::default()
        },
    );
    assert_eq!(
        refine_empty_turn(&runtime, &key, TurnTerminalCause::Completed),
        TurnTerminalCause::EmptyTurn {
            cause: crate::acp::turn_ledger::EmptyTurnCause::ToolOnly
        }
    );
    // 账本随后见到文本 → 不再是空回合
    runtime.turn_ledger.note_session_activity(
        "local:r1",
        "peri-r1",
        1,
        2,
        crate::acp::ActivityFlags {
            saw_text: true,
            ..Default::default()
        },
    );
    assert_eq!(
        refine_empty_turn(&runtime, &key, TurnTerminalCause::Completed),
        TurnTerminalCause::Completed
    );
    // #316：只有思考流也算有产出（thinking-only 回合不再误报 agent-empty）。
    let thinking_key = crate::acp::TurnKey {
        local_session_id: "local:thinking".to_string(),
        remote_session_id: "peri-thinking".to_string(),
        generation: 1,
        turn_id: 1,
    };
    runtime.turn_ledger.begin(thinking_key.clone(), 0);
    runtime.turn_ledger.note_session_activity(
        "local:thinking",
        "peri-thinking",
        1,
        1,
        crate::acp::ActivityFlags {
            saw_thinking: true,
            ..Default::default()
        },
    );
    assert_eq!(
        refine_empty_turn(&runtime, &thinking_key, TurnTerminalCause::Completed),
        TurnTerminalCause::Completed
    );
    // 未登记 turn 且会话无活动 → agent-empty 保守归类
    let ghost = crate::acp::TurnKey {
        local_session_id: "local:ghost".to_string(),
        remote_session_id: "peri-ghost".to_string(),
        generation: 1,
        turn_id: 9,
    };
    assert_eq!(
        refine_empty_turn(&runtime, &ghost, TurnTerminalCause::Completed),
        TurnTerminalCause::EmptyTurn {
            cause: crate::acp::turn_ledger::EmptyTurnCause::AgentEmpty
        }
    );
}
use crate::acp::AcpClient;

/// B-02 / C0-OPT：prompt ingest 是 GUI user.message 的唯一 durable owner。
/// 该 characterization 不经过前端 sink，直接锁定 Rust ingest 的 owner、
/// identity、provenance 与单行提交语义，供 Solid runtime-local echo 对照。
#[tokio::test]
async fn ingest_prompt_event_commits_one_authoritative_user_row_for_gui_owner() {
    let source = "local:prompt-owner";
    let agent_id = "prompt-agent";
    let profile_id = "profile-prompt";
    let remote_session_id = "remote-prompt";
    let runtime = AgentRuntime::new_disconnected();
    let mut session = SessionInfo::new(
        remote_session_id.to_string(),
        String::new(),
        ".".to_string(),
        false,
        3,
    );
    session.profile_id = Some(profile_id.to_string());
    runtime
        .sessions
        .lock()
        .expect("sessions lock")
        .insert(source.to_string(), session);

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent(agent_id)
        .with_agent(crate::test_utils::fake_acp_agent_stub(agent_id))
        .with_runtime(agent_id, runtime.clone())
        .build();
    let event_service = Arc::new(EventService::in_memory().expect("event service"));
    *state.event_service.lock().expect("event service slot") = Some(event_service.clone());

    let row = ingest_prompt_event(
        &state,
        &runtime,
        source,
        Some(remote_session_id.to_string()),
        3,
        serde_json::json!({
            "source": source,
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "text": "hello from prompt" }
            }
        }),
    )
    .await
    .expect("prompt ingest")
    .expect("GUI owner must produce a canonical row");

    let owner_key = serde_json::to_string(&[profile_id, agent_id, source]).expect("owner key");
    assert_eq!(row.owner_key, owner_key);
    assert_eq!(row.profile_id, profile_id);
    assert_eq!(row.agent_id, agent_id);
    assert_eq!(row.local_session_id, source);
    assert_eq!(row.remote_session_id.as_deref(), Some(remote_session_id));
    assert_eq!(row.event_type, "user.message");
    assert_eq!(row.event_id, format!("{owner_key}#1"));
    assert_eq!(row.sequence, 1);
    assert_eq!(row.provenance_origin, "local-observed");
    assert_eq!(row.provenance_trust, "authoritative");
    assert_eq!(row.provenance_provider.as_deref(), Some(agent_id));
    assert_eq!(
        row.identity
            .as_ref()
            .and_then(|identity| identity.get("messageId")),
        None
    );

    let page = event_service
        .list_events(owner_key, None, 100, false)
        .await
        .expect("list canonical rows");
    assert_eq!(
        page.events.len(),
        1,
        "one successful prompt produces one authoritative user row"
    );
    assert_eq!(page.events[0], row);
}

#[tokio::test]
async fn prompt_terminal_waits_for_draft_commit_before_allocating_sequence() {
    let source = "local:draft-terminal";
    let agent_id = "prompt-agent";
    let runtime = AgentRuntime::new_disconnected();
    let mut session = SessionInfo::new("remote-draft".into(), String::new(), ".".into(), false, 3);
    session.profile_id = Some("profile-prompt".into());
    runtime
        .sessions
        .lock()
        .unwrap()
        .insert(source.into(), session);
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent(agent_id)
        .with_agent(crate::test_utils::fake_acp_agent_stub(agent_id))
        .with_runtime(agent_id, runtime.clone())
        .build();
    let service = Arc::new(EventService::in_memory().unwrap());
    *state.event_service.lock().unwrap() = Some(service.clone());
    let owner = DurableSessionOwner::new("profile-prompt", agent_id, source);
    let owner_key = owner.key().unwrap();
    let raw = serde_json::json!({
        "source": source,
        "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "draft text"}}
    });
    service
        .append_draft_fragment(crate::session::DraftFragmentInput {
            owner: owner.clone(),
            draft_id: "run".into(),
            fragment_index: 0,
            client_generation: 3,
            remote_session_id: Some("remote-draft".into()),
            event_type: "assistant.text.delta".into(),
            identity: None,
            raw_payload: vec![raw.clone()],
            first_received_at: "2026-09-25T00:00:00.000Z".into(),
        })
        .await
        .unwrap();
    let mut requests = runtime.install_draft_flush_channel(3);
    let terminal = ingest_prompt_event(
        &state,
        &runtime,
        source,
        Some("remote-draft".into()),
        3,
        serde_json::json!({"source": source, "update": {"sessionUpdate": "done"}}),
    );
    let close_draft = async {
        let request = requests.recv().await.unwrap();
        assert_eq!(request.source, source);
        let committed = service
            .commit_draft_events(
                owner,
                Some("remote-draft".into()),
                3,
                "run".into(),
                vec![crate::session::DraftCommitChunk {
                    raw_payload: std::sync::Arc::new(raw),
                    received_at: "2026-09-25T00:00:00.000Z".into(),
                }],
            )
            .await
            .unwrap();
        assert_eq!(committed.events[0].sequence, 1);
        request.reply.send(Ok(())).unwrap();
    };
    let (terminal, ()) = tokio::join!(terminal, close_draft);
    assert_eq!(terminal.unwrap().unwrap().sequence, 2);
    assert!(service
        .list_draft_fragments(owner_key)
        .await
        .unwrap()
        .is_empty());
}

/// B-02 / C0-OPT：完整 send_prompt_core 成功路径仍只为用户 prompt 产生一条
/// authoritative `user.message`；终态行可以另外存在，但不得再出现第二条用户事实。
#[tokio::test]
async fn send_prompt_core_success_has_one_authoritative_user_row() {
    let mut agent = crate::test_utils::fake_acp_agent(
        "prompt-success-agent",
        &[
            "--scenario",
            "alive",
            "--session-id",
            "prompt-success-session",
        ],
    );
    agent.acp = Some(crate::agent_config::AcpProtocolConfig {
        prompt_timeout_secs: Some(5),
        ..Default::default()
    });
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let gateway = Arc::new(GatewayCore::new());
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("prompt-success-agent")
        .with_agent(agent)
        .with_runtime("prompt-success-agent", runtime.clone())
        .with_gateway(gateway.clone())
        .build();
    let event_service = Arc::new(EventService::in_memory().expect("event service"));
    *state.event_service.lock().expect("event service slot") = Some(event_service.clone());

    let context = PromptContext {
        source: "local:prompt-success".to_string(),
        profile_id: Some("profile-success".to_string()),
        content: "hello from send".to_string(),
        known_peri_id: None,
        ..Default::default()
    };
    send_prompt_core::<tauri::test::MockRuntime>(&state, &runtime, None, &gateway, &context)
        .await
        .expect("prompt must succeed");

    let owner_key = serde_json::to_string(&[
        "profile-success",
        "prompt-success-agent",
        "local:prompt-success",
    ])
    .expect("owner key");
    let page = event_service
        .list_events(owner_key, None, 100, false)
        .await
        .expect("list canonical rows");
    let user_rows: Vec<_> = page
        .events
        .iter()
        .filter(|event| event.event_type == "user.message")
        .collect();
    assert_eq!(
        user_rows.len(),
        1,
        "successful send must commit one authoritative user row"
    );
    let user = user_rows[0];
    assert_eq!(user.provenance_origin, "local-observed");
    assert_eq!(user.provenance_trust, "authoritative");
    assert_eq!(
        user.provenance_provider.as_deref(),
        Some("prompt-success-agent")
    );
    assert_eq!(
        user.identity, None,
        "client correlation is not canonical identity"
    );
    // #420/ADR-0034：成功终态后，在途回合必须已收敛（settle 是账本单源的唯一
    // 终态出口）。
    let (peri_id, generation) = {
        let sessions = runtime.sessions.lock().expect("sessions");
        let session = sessions
            .get("local:prompt-success")
            .expect("session mapping");
        (session.peri_id.clone(), session.generation)
    };
    assert!(
        !runtime
            .turn_ledger
            .turn_in_flight("local:prompt-success", &peri_id, generation),
        "success terminal must converge the in-flight turn in the ledger"
    );
}

/// #420/ADR-0034：在途回合的完整生命周期（账本单源）——`prompt-silent` agent
/// 对 session/prompt 永不响应（回合挂起窗口可观测）；挂起期间账本在途为真，
/// first-token 超时走 cancel 收敛（CancelledAfterTimeout 臂 → report_settle）
/// 后账本必清。
#[tokio::test]
async fn in_flight_turn_ledger_tracks_hanging_prompt_until_timeout() {
    let mut agent = crate::test_utils::fake_acp_agent(
        "prompt-hang-agent",
        &[
            "--scenario",
            "prompt-silent",
            "--session-id",
            "prompt-hang-session",
        ],
    );
    agent.acp = Some(crate::agent_config::AcpProtocolConfig {
        first_token_timeout_secs: Some(1),
        cancel_settle_timeout_secs: Some(1),
        ..Default::default()
    });
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let gateway = Arc::new(GatewayCore::new());
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("prompt-hang-agent")
        .with_agent(agent)
        .with_runtime("prompt-hang-agent", runtime.clone())
        .with_gateway(gateway.clone())
        .build();

    let context = PromptContext {
        source: "local:prompt-hang".to_string(),
        // 不挂 profile：失败广播路径不依赖 event service，测试聚焦标记生命周期。
        profile_id: None,
        content: "hang forever".to_string(),
        known_peri_id: None,
        ..Default::default()
    };
    let send_fut =
        send_prompt_core::<tauri::test::MockRuntime>(&state, &runtime, None, &gateway, &context);
    tokio::pin!(send_fut);

    // 轮询等待置位：出站成功即账本 begin，此时回合仍挂起。
    let mark_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut marked = false;
    loop {
        tokio::select! {
            biased;
            _ = &mut send_fut => break,
            _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {
                let marked_now = runtime
                    .sessions
                    .lock()
                    .expect("sessions")
                    .get("local:prompt-hang")
                    .map(|session| {
                        runtime
                            .turn_ledger
                            .turn_in_flight("local:prompt-hang", &session.peri_id, session.generation)
                    })
                    .unwrap_or(false);
                if marked_now {
                    marked = true;
                    break;
                }
                if std::time::Instant::now() > mark_deadline {
                    break;
                }
            }
        }
    }
    assert!(
        marked,
        "hanging prompt must expose the in-flight turn in the ledger before its terminal"
    );

    // 等待超时终态收敛（first-token 1s → cancel settle 窗口内失败返回）。
    let outcome = send_fut.await;
    assert!(outcome.is_err(), "hang must converge to a timeout failure");
    // 终态后账本必清——两条形态都合法：settle 窗口内收敛则结算；窗口超时则
    // publish_prompt_failure 的防御结算收敛（或映射整体移除，会话级查询无从命中）。
    let mark_cleared = runtime
        .sessions
        .lock()
        .expect("sessions")
        .get("local:prompt-hang")
        .map(|session| {
            !runtime.turn_ledger.turn_in_flight(
                "local:prompt-hang",
                &session.peri_id,
                session.generation,
            )
        })
        // 映射被移除同样是清理形态（在途随条目结构性消失）。
        .unwrap_or(true);
    assert!(
        mark_cleared,
        "cancel/timeout terminal must converge the in-flight turn unconditionally"
    );
}

/// #420/ADR-0034：settle 路径（report_settle）即账本在途的唯一收敛点——结算后
/// active 不再有该回合、终态记录落 terminal 表；同会话在途查询必为假。滞留
/// （未经终态臂的残余）由 publish_prompt_failure 的防御结算与快照 anomaly
/// 读数显形（契约测试见 runtime.rs）。
#[test]
fn report_settle_converges_ledger_in_flight() {
    let runtime = AgentRuntime::new_disconnected();
    let session = crate::session::SessionInfo::new(
        "peri-mark-clear".to_string(),
        String::new(),
        ".".to_string(),
        true,
        4,
    );
    runtime
        .sessions
        .lock()
        .expect("sessions")
        .insert("local:mark-clear".to_string(), session);
    let turn_key = TurnKey {
        local_session_id: "local:mark-clear".to_string(),
        remote_session_id: "peri-mark-clear".to_string(),
        generation: 4,
        turn_id: 11,
    };
    runtime.turn_ledger.begin(turn_key.clone(), 0);
    assert!(
        runtime
            .turn_ledger
            .turn_in_flight("local:mark-clear", "peri-mark-clear", 4),
        "begin must register the in-flight turn in the ledger"
    );
    report_settle(&runtime, &turn_key, TurnTerminalCause::Completed, None);
    assert!(
        !runtime
            .turn_ledger
            .turn_in_flight("local:mark-clear", "peri-mark-clear", 4),
        "report_settle must converge the in-flight turn in the ledger"
    );
    assert!(
        runtime
            .turn_ledger
            .snapshot(&turn_key)
            .expect("settled turn must remain in the ledger")
            .terminal
            .is_some(),
        "settled turn must carry a terminal record"
    );
}

/// #352：用户 cancel 判死输入的载体语义——置位可见（键化 generation）；
/// 新回合起点（clear_cancel_requested_for_new_turn）清除，旧回合的 cancel
/// 不继承到新回合。
#[test]
fn cancel_requested_mark_is_set_and_cleared_on_new_turn() {
    let mut session = crate::session::SessionInfo::new(
        "local:cancel-flag".to_string(),
        String::new(),
        ".".to_string(),
        true,
        0,
    );
    assert!(
        session.cancel_requested.is_none(),
        "新会话不得携带 cancel 判死输入"
    );
    session.mark_cancel_requested(3, std::time::Instant::now());
    let mark = session.cancel_requested.expect("置位后判死输入必须可见");
    assert_eq!(mark.generation, 3, "标记必须携带置位时的会话代际");
    session.clear_cancel_requested_for_new_turn();
    assert!(
        session.cancel_requested.is_none(),
        "回合起点必须清除旧回合的 cancel 判死输入"
    );
}

/// #352：判死探针只认本代际置位——客户端替换（代际已换）后，旧代际的
/// 迟到置位不得把新代际等待循环拖进 cancel-settle 窗口（spec「本 generation
/// 本 session 已发出用户 cancel」钉死在探针构造器）。
#[test]
fn cancel_requested_probe_only_fires_for_current_generation() {
    let runtime = AgentRuntime::new_disconnected();
    let mut session = crate::session::SessionInfo::new(
        "local:cancel-gen".to_string(),
        String::new(),
        ".".to_string(),
        true,
        5,
    );
    session.mark_cancel_requested(5, std::time::Instant::now());
    runtime
        .sessions
        .lock()
        .expect("sessions")
        .insert("local:cancel-gen".to_string(), session);
    let probe = cancel_requested_probe(runtime, "local:cancel-gen".to_string(), 7);
    assert!(!probe(), "旧代际（5）置位不得触发新代际（7）的判死输入");
}

#[test]
fn prompt_failure_metadata_keeps_timeout_provenance_additive() {
    let metadata = PromptFailureMetadata {
        source: "prompt-timeout",
        timeout_kind: Some("first-token"),
        configured_timeout_secs: Some(180),
        triggered_timeout_secs: Some(2),
        actual_elapsed_ms: Some(2_041),
        provider_message: None,
    };
    let value = metadata.to_json();
    assert_eq!(value["source"], "prompt-timeout");
    assert_eq!(value["timeoutKind"], "first-token");
    assert_eq!(value["configuredTimeoutSecs"], 180);
    assert_eq!(value["triggeredTimeoutSecs"], 2);
    assert_eq!(value["actualElapsedMs"], 2_041);
    assert!(value.get("providerMessage").is_none());
}

/// 验收 D1-②：beforeSend transform 改写 wire 出站，但 journal 的
/// user.message 原文行不被改写（B7 双轨）。fake ACP 把收到的
/// session/prompt 请求原样写 trace 文件——wire 证据源。
#[tokio::test]
async fn before_send_hook_transform_rewrites_wire_but_journal_keeps_original() {
    use tauri::{Listener, Manager};
    let trace_path = std::env::temp_dir().join(format!(
        "pylon-hook-dual-track-{}-{}.jsonl",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0),
    ));
    let agent = crate::test_utils::fake_acp_agent(
        "hook-dual-agent",
        &[
            "--scenario",
            "stream",
            "--session-id",
            "hook-dual-session",
            "--trace-file",
            &trace_path.to_string_lossy(),
            "--trace-mode",
            "prompt-only",
        ],
    );
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let gateway = Arc::new(GatewayCore::new());
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("hook-dual-agent")
        .with_agent(agent)
        .with_runtime("hook-dual-agent", runtime.clone())
        .with_gateway(gateway.clone())
        .build();
    let event_service = Arc::new(EventService::in_memory().expect("event service"));
    *state.event_service.lock().expect("event service slot") = Some(event_service.clone());

    // mock app + 窗口：hook 桥事件经 Listener 捕获，应答经 bridge.respond 回程。
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app must build");
    app.manage(state);
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock webview must build");
    let window = webview.as_ref().window();
    let bridge = app.state::<AppState>().hook_bridge.clone();
    bridge.mark_started();
    bridge.sync_registry(&serde_json::json!({
        "hooks": ["message.user.beforeSend"]
    }));
    // 必须用 tokio 的无界通道：`#[tokio::test]` 默认 current_thread 运行时，
    // tokio::spawn 的任务与 send_prompt_core 共用同一个 worker 线程；
    // 若在此处对 std::sync::mpsc 做阻塞 recv，会占死该线程使 hook 事件永不发出（死锁）。
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    window.listen(crate::event_names::PYLON_HOOK_REQUEST, move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).expect("hook request payload");
        let _ = tx.send(payload);
    });
    let responder_bridge = bridge.clone();
    let responder = tokio::spawn(async move {
        let request = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("hook request timed out")
            .expect("hook request must arrive");
        let request_id = request["requestId"].as_str().unwrap().to_string();
        let mut event = request["payload"].clone();
        if let serde_json::Value::Object(ref mut map) = event {
            map.insert(
                "blocks".to_string(),
                serde_json::json!([{ "type": "text", "text": "改写后的出站文本" }]),
            );
        }
        responder_bridge
            .respond(
                &request_id,
                Ok(serde_json::json!({
                    "action": "continue",
                    "event": event,
                    "executed": 1,
                    "skipped": 0,
                })),
            )
            .expect("respond");
    });

    let context = PromptContext {
        source: "local:hook-dual".to_string(),
        profile_id: Some("profile-hook".to_string()),
        content: "用户原始消息".to_string(),
        known_peri_id: None,
        ..Default::default()
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        send_prompt_core::<tauri::test::MockRuntime>(
            app.state::<AppState>().inner(),
            &runtime,
            Some(&window),
            &gateway,
            &context,
        ),
    )
    .await
    .expect("hook transform prompt timed out")
    .expect("prompt must succeed");
    responder.await.expect("hook responder must succeed");

    // wire 证据：fake ACP 收到的 prompt 首块文本 = 改写后文本。
    let trace = std::fs::read_to_string(&trace_path).expect("read prompt trace");
    let _ = std::fs::remove_file(&trace_path);
    let wire_request: serde_json::Value = trace
        .lines()
        .next()
        .map(|line| {
            // 带原文的诊断：本测试此前在 CI 上只报"trace line JSON: lone leading
            // surrogate..."，看不到子进程实际写了什么（子进程 locale 相关），
            // 失败时把该行原文打出来，避免再次盲猜。
            serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("trace line JSON: {error}; raw={line}"))
        })
        .expect("trace must capture session/prompt");
    assert_eq!(
        wire_request["params"]["prompt"][0]["text"], "改写后的出站文本",
        "wire 出站必须携带 hook 改写产物"
    );
    // journal 证据：user.message 原文行不被改写（B7 rawPayload/typed 原文）。
    let owner_key = serde_json::to_string(&["profile-hook", "hook-dual-agent", "local:hook-dual"])
        .expect("owner key");
    let page = event_service
        .list_events(owner_key, None, 100, false)
        .await
        .expect("list canonical rows");
    let user_row = page
        .events
        .iter()
        .find(|event| event.event_type == "user.message")
        .expect("journal must contain the user.message row");
    assert_eq!(
        user_row
            .typed_payload
            .as_ref()
            .and_then(|payload| payload.get("text")),
        Some(&serde_json::json!("用户原始消息")),
        "journal 原文行必须保持用户原文（记原文契约）"
    );
    assert!(!trace.contains("用户原始消息"), "wire 不应再出现用户原文");
}

/// #425 件1：profile-backed prompt 的 durable owner 前提不成立（session 存在但
/// profile 未绑定）时，错误边界必须返回领域错误上抛，而不是 `expect` panic
/// （release `panic=abort` 下会直接杀进程）。原 panic 点见 ingest.rs owner 分支。
#[tokio::test]
async fn publish_prompt_failure_returns_domain_error_when_durable_owner_missing() {
    let runtime = AgentRuntime::new_disconnected();
    // SessionInfo::new 默认 profile_id=None——正是「durable owner 缺失」形态。
    let session = crate::session::SessionInfo::new(
        "peri-no-owner".to_string(),
        String::new(),
        ".".to_string(),
        true,
        4,
    );
    runtime
        .sessions
        .lock()
        .expect("sessions")
        .insert("local:no-owner".to_string(), session);
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("agent-no-owner")
        .with_agent(crate::test_utils::fake_acp_agent("agent-no-owner", &[]))
        .with_runtime("agent-no-owner", runtime.clone())
        .build();
    let gateway = Arc::new(GatewayCore::new());
    let ctx = PromptContext {
        source: "local:no-owner".to_string(),
        profile_id: Some("profile-x".to_string()),
        ..Default::default()
    };
    let error = PylonError::Protocol("synthetic failure".to_string());
    let outcome = publish_prompt_failure::<tauri::test::MockRuntime>(
        &state, &runtime, None, &gateway, &ctx, &error, None, None,
    )
    .await;
    match outcome {
        Err(PylonError::Protocol(message)) => assert!(
            message.contains("durable owner"),
            "unexpected protocol message: {message}"
        ),
        other => panic!("expected durable-owner domain error, got {other:?}"),
    }
}

/// #442 Step2: the error terminal frame carries an additive `turnId` once the
/// turn has begun; when no turn was begun (None) the key is omitted (never
/// fabricated). window=None skips the broadcast arm, so the registered IPC
/// channel is the only delivery path (same shape as the production GUI path).
#[tokio::test]
async fn prompt_failure_frame_carries_attempted_turn_id() {
    let runtime = AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("agent-turn-frame")
        .build();
    let gateway = Arc::new(GatewayCore::new());
    // profile_id=None skips the journal branch (durable owner resolution) so the
    // publish path goes straight to the terminal dual-send.
    let ctx = PromptContext {
        source: "local:turn-frame".to_string(),
        profile_id: None,
        ..Default::default()
    };
    let error = PylonError::Protocol("synthetic failure".to_string());

    let sent: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = sent.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                sink.lock().unwrap().push(value);
            }
        }
        Ok(())
    });
    runtime.register_update_channel("local:turn-frame", channel);

    publish_prompt_failure::<tauri::test::MockRuntime>(
        &state,
        &runtime,
        None,
        &gateway,
        &ctx,
        &error,
        None,
        Some(42),
    )
    .await
    .expect("failure publish");

    let frames = sent.lock().unwrap();
    assert_eq!(
        frames.len(),
        1,
        "exactly one frame through the registered channel"
    );
    assert_eq!(frames[0]["event"], crate::event_names::SESSION_ERROR);
    assert_eq!(
        frames[0]["payload"]["turnId"],
        serde_json::json!(42),
        "error frame must carry the turn identity"
    );
    assert_eq!(frames[0]["payload"]["code"], "protocol_error");
}

/// #442 Step2: when no turn was begun (`turn_id=None`) the error frame omits the
/// `turnId` key entirely — missing is never fabricated, the frontend keeps its
/// stamp-guess fallback track.
#[tokio::test]
async fn prompt_failure_frame_without_turn_omits_turn_id() {
    let runtime = AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("agent-turn-frame-none")
        .build();
    let gateway = Arc::new(GatewayCore::new());
    let ctx = PromptContext {
        source: "local:turn-frame-none".to_string(),
        profile_id: None,
        ..Default::default()
    };
    let error = PylonError::Protocol("synthetic failure".to_string());

    let sent: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = sent.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                sink.lock().unwrap().push(value);
            }
        }
        Ok(())
    });
    runtime.register_update_channel("local:turn-frame-none", channel);

    publish_prompt_failure::<tauri::test::MockRuntime>(
        &state, &runtime, None, &gateway, &ctx, &error, None, None,
    )
    .await
    .expect("failure publish");

    let frames = sent.lock().unwrap();
    assert_eq!(frames.len(), 1);
    assert!(
        frames[0]["payload"].get("turnId").is_none(),
        "turnId must not be fabricated when no turn was begun"
    );
}

/// #442 Step3：`pylon:turn-settled` 门控与载荷——仅 CAS `Published` 产出载荷
/// （至多一次，Late/UnknownTurn 静默）；载荷携带完整账本记录（终因/settledAtMs/
/// 回合身份 key）。窗口发射是薄壳，此处单测纯函数。
#[test]
fn turn_settled_broadcast_publishes_once_with_full_record() {
    let runtime = AgentRuntime::new_disconnected();
    let turn_key = crate::acp::TurnKey {
        local_session_id: "local:ts".to_string(),
        remote_session_id: "peri-ts".to_string(),
        generation: 2,
        turn_id: 11,
    };
    runtime.turn_ledger.begin(turn_key.clone(), 100);

    // 未登记的回合（UnknownTurn）不产出载荷。
    assert!(super::ledger::turn_settled_payload_if_published(
        &runtime,
        "local:ts",
        &turn_key,
        &crate::acp::SettleOutcome::UnknownTurn,
    )
    .is_none());

    let outcome = super::ledger::report_settle(
        &runtime,
        &turn_key,
        crate::acp::TurnTerminalCause::Completed,
        None,
    );
    let payload =
        super::ledger::turn_settled_payload_if_published(&runtime, "local:ts", &turn_key, &outcome)
            .expect("Published settle must produce the broadcast payload");
    assert_eq!(payload["source"], "local:ts");
    assert_eq!(payload["turn"]["phase"], "terminal");
    assert_eq!(payload["turn"]["terminal"]["cause"], "completed");
    assert_eq!(payload["turn"]["key"]["turnId"], serde_json::json!(11));
    assert!(payload["turn"]["terminal"]["settledAtMs"].is_u64());

    // 重复结算被 CAS 判 Late：不再产出载荷（至多一次）。
    let late = super::ledger::report_settle(
        &runtime,
        &turn_key,
        crate::acp::TurnTerminalCause::ProtocolError,
        None,
    );
    assert!(matches!(late, crate::acp::SettleOutcome::Late { .. }));
    assert!(super::ledger::turn_settled_payload_if_published(
        &runtime, "local:ts", &turn_key, &late,
    )
    .is_none());
}
