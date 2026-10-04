//! P51（重启上下文复活）：ensure_session_mapping 的 ACP session/load 复活优先
//! 回归。用户决策——重启后发送消息必须先尝试复活远端原会话（原生 ACP 能力），
//! 失败才允许新建，且新建必须显式告知（recreated_peri_id out-param）。
//! 历史会话在 provider 端不再随每次重启膨胀。
use super::*;

#[tokio::test]
async fn generation_change_during_recovery_rejects_success_and_failure_without_fallback() {
    for method in ["session/resume", "session/load"] {
        for outcome in ["success", "error"] {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let ready = std::env::temp_dir().join(format!(
                "pylon-recovery-{}-{unique}.ready",
                std::process::id()
            ));
            let release = ready.with_extension("release");
            let agent = crate::test_utils::fake_acp_agent(
                "recovery-generation",
                &[
                    "--scenario",
                    "recovery-generation",
                    "--barrier-ready",
                    &ready.to_string_lossy(),
                    "--barrier-release",
                    &release.to_string_lossy(),
                    "--wait-method",
                    method,
                    "--outcome",
                    outcome,
                ],
            );
            let runtime = AgentRuntime::new_disconnected();
            runtime.install_acp(
                crate::acp::AcpClient::connect_with_logs(&agent, None)
                    .await
                    .unwrap(),
            );

            let state = crate::test_utils::TestStateBuilder::bare()
                .with_active_agent("recovery-generation")
                .with_agent(agent)
                .with_runtime("recovery-generation", runtime.clone())
                .build();
            let mut recreated = None;
            let assembly = SessionAssembly {
                state: &state,
                runtime: &runtime,
                source: "local:generation",
                profile_id: Some("profile"),
                persona: "",
                session_cwd: ".",
                wire_mcp_servers: &[],
            };
            let recover =
                ensure_session_mapping(&assembly, Some("remote-original"), &mut recreated);
            let change_generation = async {
                tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    while !ready.exists() {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("agent must receive recovery request");
                runtime
                    .client_generation
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                std::fs::write(&release, b"release").unwrap();
            };
            let (result, ()) = tokio::join!(recover, change_generation);
            let seen = state
                .acp_rpc(&runtime, "_test/seen", serde_json::json!({}))
                .await
                .unwrap();
            std::fs::remove_file(&ready).unwrap();
            std::fs::remove_file(&release).unwrap();
            let error = match result {
                Ok(_) => panic!("{method}/{outcome} unexpectedly succeeded"),
                Err(error) => error,
            };
            assert!(
                error.to_string().contains("stale ACP client generation"),
                "{method}/{outcome}: {error}"
            );
            assert_eq!(
                seen["methods"],
                serde_json::json!([method]),
                "no load/new fallback after generation changes"
            );
            assert!(recreated.is_none());
            assert!(!runtime
                .sessions
                .lock()
                .unwrap()
                .contains_key("local:generation"));
        }
    }
}

/// session/load 命中（返回已存在 sessionId）→ 复用，不新建。
#[tokio::test]
async fn ensure_session_mapping_revives_via_session_load_before_creating() {
    let agent = crate::test_utils::fake_acp_agent("revive-agent", &["--scenario", "revive-echo"]);
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("revive-agent")
        .with_agent(agent)
        .with_runtime("revive-agent", runtime.clone())
        .build();

    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:revive",
        profile_id: Some("profile-r"),
        persona: "persona",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, Some("peri-original"), &mut recreated)
        .await
        .expect("revive must succeed");

    assert_eq!(
        mapping.peri_id, "peri-original",
        "revived mapping keeps the persisted remote session id"
    );
    assert!(!mapping.is_first);
    assert!(
        recreated.is_none(),
        "no recreation notice when the remote session is revived"
    );
    assert_eq!(
        runtime
            .sessions
            .lock()
            .unwrap()
            .get("local:revive")
            .map(|s| s.peri_id.clone()),
        Some("peri-original".to_string()),
        "in-memory slot is re-attached to the revived session"
    );
}

/// Advertised object capability → resume is attempted and load is not used.
#[tokio::test]
async fn ensure_session_mapping_resumes_without_replay_or_recreation() {
    let agent = crate::test_utils::fake_acp_agent("resume-agent", &["--scenario", "resume-only"]);
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("resume-agent")
        .with_agent(agent)
        .with_runtime("resume-agent", runtime.clone())
        .build();
    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:resume",
        profile_id: Some("profile-r"),
        persona: "persona",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, Some("peri-resume"), &mut recreated)
        .await
        .expect("resume must succeed");
    assert_eq!(mapping.peri_id, "peri-resume");
    assert!(recreated.is_none());
}

#[tokio::test]
async fn ensure_session_mapping_resume_failure_falls_back_to_load() {
    let agent = crate::test_utils::fake_acp_agent(
        "resume-load-agent",
        &["--scenario", "resume-archived-load-echo"],
    );
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("resume-load-agent")
        .with_agent(agent)
        .with_runtime("resume-load-agent", runtime.clone())
        .build();
    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:resume-load",
        profile_id: Some("profile"),
        persona: "persona",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, Some("peri"), &mut recreated)
        .await
        .expect("load fallback must succeed");
    assert_eq!(mapping.peri_id, "peri");
    assert!(recreated.is_none());
}

#[tokio::test]
async fn ensure_session_mapping_resume_and_load_failure_creates_new_session() {
    let agent = crate::test_utils::fake_acp_agent(
        "resume-new-agent",
        &[
            "--scenario",
            "resume-load-error-new",
            "--session-id",
            "recreated-session",
        ],
    );
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("resume-new-agent")
        .with_agent(agent)
        .with_runtime("resume-new-agent", runtime.clone())
        .build();
    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:resume-new",
        profile_id: Some("profile"),
        persona: "persona",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, Some("peri"), &mut recreated)
        .await
        .expect("new fallback must succeed");
    assert_eq!(mapping.peri_id, "recreated-session");
    assert_eq!(recreated.as_deref(), Some("recreated-session"));
}

#[tokio::test]
async fn ensure_session_mapping_malformed_resume_capability_uses_load() {
    let agent = crate::test_utils::fake_acp_agent(
        "malformed-resume-agent",
        &["--scenario", "resume-bool-load-echo"],
    );
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("malformed-resume-agent")
        .with_agent(agent)
        .with_runtime("malformed-resume-agent", runtime.clone())
        .build();
    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:malformed",
        profile_id: Some("profile"),
        persona: "persona",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, Some("peri"), &mut recreated)
        .await
        .expect("load fallback must succeed");
    assert_eq!(mapping.peri_id, "peri");
    assert!(recreated.is_none());
}

/// session/load 失败（provider 端会话已死）→ 降级新建 + recreated 通知。
#[tokio::test]
async fn ensure_session_mapping_falls_back_to_new_with_notice_when_load_fails() {
    let agent = crate::test_utils::fake_acp_agent(
        "fallback-agent",
        &[
            "--scenario",
            "load-error-else-new",
            "--session-id",
            "fresh-session",
        ],
    );
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("fallback-agent")
        .with_agent(agent)
        .with_runtime("fallback-agent", runtime.clone())
        .build();

    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:fallback",
        profile_id: Some("profile-f"),
        persona: "persona",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, Some("peri-dead"), &mut recreated)
        .await
        .expect("fallback creation must succeed");

    assert_eq!(mapping.peri_id, "fresh-session");
    assert_eq!(
        recreated.as_deref(),
        Some("fresh-session"),
        "caller is told the session was recreated with a new remote id"
    );
}

/// 无持久化 peri_id（None）→ 直接新建，行为与旧版一致。
#[tokio::test]
async fn ensure_session_mapping_without_peri_id_creates_directly() {
    let agent = crate::test_utils::fake_acp_agent(
        "direct-agent",
        &["--scenario", "new-always", "--session-id", "direct-new"],
    );
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize"),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("direct-agent")
        .with_agent(agent)
        .with_runtime("direct-agent", runtime.clone())
        .build();

    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:direct",
        profile_id: None,
        persona: "",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, None, &mut recreated)
        .await
        .expect("direct creation must succeed");

    assert_eq!(mapping.peri_id, "direct-new");
    assert!(
        recreated.is_some(),
        "recreation notice is also emitted for the no-peri-id creation path"
    );
}

// ── #349 B1：revive 的 session/load 走 replay capture 治理 ──────────────────

/// #349 B1（机制断言）：revive load 在飞期间（barrier 阻塞 agent 响应）
/// ① loading 槽已预插入（回放帧可立即解析映射，不再逐条 100ms 未知会话等待）；
/// ② replay capture 已登记（同 owner 二次 capture 被 ReplayLoadInProgress
/// 确定性拒绝——回放帧将在传输边界被分类为 Replay 而非 Live）；
/// ③ 成功后临时槽位替换为最终槽位（replay_loading 清位）。
#[tokio::test]
async fn revive_load_registers_replay_capture_and_preinserts_loading_slot() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let ready = std::env::temp_dir().join(format!(
        "pylon-revive-capture-{}-{unique}.ready",
        std::process::id()
    ));
    let release = ready.with_extension("release");
    let agent = crate::test_utils::fake_acp_agent(
        "revive-capture-agent",
        &[
            "--scenario",
            "recovery-generation",
            "--barrier-ready",
            &ready.to_string_lossy(),
            "--barrier-release",
            &release.to_string_lossy(),
            "--wait-method",
            "session/load",
            "--outcome",
            "success",
        ],
    );
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .unwrap(),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("revive-capture-agent")
        .with_agent(agent)
        .with_runtime("revive-capture-agent", runtime.clone())
        .build();
    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:generation",
        profile_id: Some("profile"),
        persona: "",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let recover = ensure_session_mapping(&assembly, Some("remote-original"), &mut recreated);
    let observe_and_release = async {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !ready.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("agent must receive session/load");
        {
            let sessions = runtime.sessions.lock().unwrap();
            let slot = sessions
                .get("local:generation")
                .expect("loading slot must be pre-inserted before the load RPC");
            assert_eq!(slot.peri_id, "remote-original");
            assert!(
                slot.replay_loading,
                "pre-inserted slot must carry replay_loading for the load window"
            );
        }
        // 同 owner 二次 capture 必须被拒绝 = revive 的 load 已持有登记。
        let second = runtime
            .snapshot_acp()
            .begin_replay_capture("remote-original");
        assert!(
            matches!(second, Err(crate::acp::AcpError::ReplayLoadInProgress)),
            "revive load must hold the replay capture registration"
        );
        drop(second);
        std::fs::write(&release, b"release").unwrap();
    };
    let (result, ()) = tokio::join!(recover, observe_and_release);
    let mapping = result.expect("revive must succeed after release");
    assert_eq!(mapping.peri_id, "remote-original");
    assert!(recreated.is_none());
    {
        let sessions = runtime.sessions.lock().unwrap();
        let slot = sessions.get("local:generation").expect("final slot");
        assert_eq!(slot.peri_id, "remote-original");
        assert!(!slot.replay_loading, "final slot clears replay_loading");
    }
    std::fs::remove_file(&ready).unwrap();
    std::fs::remove_file(&release).unwrap();
}

/// #349 B1（journal 断言）：scenario `new_load` 对 session/load 先发两条回放
/// chunk（history-1/history-2）再响应——经真实 dispatcher 泵处理后，canonical
/// journal 不得出现回放帧产生的 durable 事件（journal 是唯一 durable 权威，
/// revive 对回放内容只丢弃不导入）。
#[tokio::test]
async fn revive_replay_frames_never_reach_canonical_journal() {
    let agent =
        crate::test_utils::fake_acp_agent("journal-revive-agent", &["--scenario", "new_load"]);
    let harness = crate::test_harness::TestHarness::boot(
        crate::test_harness::HarnessConfig::new().with_agent(agent),
    )
    .await;
    let state = harness.state();
    let runtime = harness
        .runtime("journal-revive-agent")
        .expect("harness boots an active runtime");
    let mut recreated = None;
    let assembly = SessionAssembly {
        state: state.inner(),
        runtime: &runtime,
        source: "local:journal",
        profile_id: Some("profile"),
        persona: "",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, Some("peri-journal"), &mut recreated)
        .await
        .expect("revive via load channel must succeed");
    assert_eq!(mapping.peri_id, "peri-journal");
    // 给 dispatcher 泵留出处理回放帧的窗口（分类已固定为 Replay，与处理时机无关）。
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let owner = crate::session::DurableSessionOwner::new(
        "profile",
        "journal-revive-agent",
        "local:journal",
    );
    let page = crate::session::event_service_of(state.inner())
        .expect("harness installs an in-memory event service")
        .list_events(owner.key().unwrap(), None, 100, false)
        .await
        .expect("journal read");
    let leaked: Vec<String> = page
        .events
        .iter()
        .filter_map(|row| {
            let text = row.raw_payload.to_string();
            (text.contains("history-1") || text.contains("history-2")).then_some(text)
        })
        .collect();
    assert!(
        leaked.is_empty(),
        "replay frames must not be durable-ingested as canonical events: {leaked:?} ({} events total)",
        page.events.len()
    );
}

// ── #98（P1-2 评审修复）：revive 成功但远端 identity 变化 ⇒ 显式 rebind——
// 复用 recreated_peri_id 出参通道广播（pylon:session-recreated），映射绑定新 id，
// 不静默复用旧映射。fixture 仅标准嵌套 `sessionCapabilities.loadSession: {}`，
// 同时覆盖「建立与复活消费同一协商快照」的 load 通道判定。──
#[tokio::test]
async fn revive_with_changed_remote_identity_rebinds_explicitly() {
    // 场景 `rebind` 复刻原 fixture 的 wire：只宣告 loadSession，session/load 回
    // 一个新 id（remote-rebound）——正是「远端 identity 变化」这一事件的触发源。
    let agent = crate::test_utils::fake_acp_agent("rebind-identity", &["--scenario", "rebind"]);
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(
        crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .unwrap(),
    );

    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("rebind-identity")
        .with_agent(agent)
        .with_runtime("rebind-identity", runtime.clone())
        .build();
    let mut recreated = None;
    let assembly = SessionAssembly {
        state: &state,
        runtime: &runtime,
        source: "local:rebind",
        profile_id: Some("profile"),
        persona: "",
        session_cwd: ".",
        wire_mcp_servers: &[],
    };
    let mapping = ensure_session_mapping(&assembly, Some("remote-original"), &mut recreated)
        .await
        .expect("load 通道在交集内，revive 必成功");
    assert_eq!(mapping.peri_id, "remote-rebound", "映射绑定远端返回的新 id");
    assert_eq!(
        recreated.as_deref(),
        Some("remote-rebound"),
        "identity 变化必须显式广播（recreated 事件通道）"
    );
    assert_eq!(
        runtime
            .sessions
            .lock()
            .unwrap()
            .get("local:rebind")
            .expect("槽位已重挂")
            .peri_id,
        "remote-rebound"
    );
}
