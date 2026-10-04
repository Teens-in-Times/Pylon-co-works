//! #97（通用 ACP 模型选择器与切换闭环）wire 级集成测试——**P5 回退保留片**。
//!
//! #106 P5 已将本文件 8 测中的 7 测迁入 `tests/model_switch/`（经 test_harness
//! 门面）；`rebind_on_other_runtime_starts_with_clean_selector_snapshot` 依 spec
//! 回退条款**保留 lib 内嵌**：它需要同时持有两个 runtime 的会话快照做白盒比对
//! （per-runtime sessions 的 model_surface/choices/config_options 逐字段断言），
//! 门面窄值视图无法承载——强迁等于暴露 AppState 字段级访问，违反 spec P5
//! 「内部一律不加 pub」约束（dev record 有同步记录）。

use super::*;
use crate::acp::AcpClient;
use crate::agent_config::{AcpProtocolConfig, SetModelApi};
use crate::test_utils::TestStateBuilder;
use tauri::Manager;

/// #379：new_session 命令入口的 window 注入参在直呼测试里的 MockRuntime 形态
/// （每测试恰好一窗，label 固定 "main"）。
fn mock_window(
    app: &tauri::App<tauri::test::MockRuntime>,
) -> tauri::Window<tauri::test::MockRuntime> {
    tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock window must build")
    .as_ref()
    .window()
}

#[tokio::test]
async fn mode_uses_advertised_config_id_and_validates_before_wire() {
    let trace = std::env::temp_dir().join(format!(
        "pylon-mode-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let trace_arg = trace.to_string_lossy().to_string();
    let agent = crate::test_utils::fake_acp_agent(
        "mode-agent",
        &[
            "--scenario",
            "initial-options-echo",
            "--trace-file",
            &trace_arg,
            "--trace-mode",
            "all",
        ],
    );
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(AcpClient::connect_with_logs(&agent, None).await.unwrap());
    // #379：client 已连接 → lifecycle status 如实置 Connected——否则命令入口的
    // 懒重连（ensure_connected_for_send）会在此真实二次 spawn，换代污染 wire trace。
    runtime.agent_runtime.lock().unwrap().status = AgentLifecycleStatus::Connected;
    let state = TestStateBuilder::bare()
        .with_active_agent("mode-agent")
        .with_agent(agent)
        .with_runtime("mode-agent", runtime.clone())
        .build();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(state);
    new_session(
        app.state::<AppState>(),
        mock_window(&app),
        "mode-agent".into(),
        "local:mode".into(),
        "profile".into(),
        "".into(),
        Some(".".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    runtime.sessions.lock().unwrap().get_mut("local:mode").unwrap().config_options.push(
        serde_json::json!({"id":"permissions-choice","category":"mode","type":"select","currentValue":"default",
            "options":[{"value":"default"},{"value":"acceptEdits"},{"value":"plan"}]}));
    set_mode(
        app.state::<AppState>(),
        "mode-agent".into(),
        "local:mode".into(),
        "acceptEdits".into(),
    )
    .await
    .unwrap();
    // The echo scenario replaces configOptions; restore the fixture declaration for rejection.
    runtime
        .sessions
        .lock()
        .unwrap()
        .get_mut("local:mode")
        .unwrap()
        .config_options = vec![
        serde_json::json!({"id":"permissions-choice","category":"mode","options":[{"value":"plan"}]}),
    ];
    let error = set_mode(
        app.state::<AppState>(),
        "mode-agent".into(),
        "local:mode".into(),
        "invented".into(),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("mode_not_advertised"));
    let frames: Vec<serde_json::Value> = std::fs::read_to_string(trace)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(frames
        .iter()
        .any(|frame| frame["method"] == "session/set_config_option"
            && frame["params"]["configId"] == "permissions-choice"
            && frame["params"]["value"] == "acceptEdits"));
    assert!(!frames
        .iter()
        .any(|frame| frame["method"] == "session/set_mode"));
    assert!(!frames
        .iter()
        .any(|frame| frame["params"]["value"] == "invented"));
}

/// 验收（跨 runtime/Agent 重绑不泄漏）：同一 source 在不同 Agent runtime 上重建
/// 会话时，新 selector snapshot 不得沿用旧 Agent 的 config id/model id/choices。
#[tokio::test]
async fn rebind_on_other_runtime_starts_with_clean_selector_snapshot() {
    let mut agent_a = crate::test_utils::fake_acp_agent(
        "rebind-a",
        &[
            "--scenario",
            "set-config-option",
            "--mode",
            "echo-empty",
            "--session-id",
            "ms-session",
        ],
    );
    agent_a.acp = Some(AcpProtocolConfig {
        set_model_api: Some(SetModelApi::ConfigOption),
        ..Default::default()
    });
    let agent_b = crate::test_utils::fake_acp_agent(
        "rebind-b",
        &["--scenario", "empty", "--session-id", "empty-session"],
    );
    let runtime_a = AgentRuntime::new_disconnected();
    runtime_a.install_acp(
        AcpClient::connect_with_logs(&agent_a, None)
            .await
            .expect("fake ACP must initialize"),
    );

    // #379：同上——已连接夹具如实置 Connected，避免命令入口懒重连二次 spawn。
    runtime_a.agent_runtime.lock().unwrap().status = AgentLifecycleStatus::Connected;
    let runtime_b = AgentRuntime::new_disconnected();
    runtime_b.install_acp(
        AcpClient::connect_with_logs(&agent_b, None)
            .await
            .expect("fake ACP must initialize"),
    );

    runtime_b.agent_runtime.lock().unwrap().status = AgentLifecycleStatus::Connected;
    let state = TestStateBuilder::bare()
        .with_active_agent("rebind-a")
        .with_agent(agent_a)
        .with_agent(agent_b)
        .with_runtime("rebind-a", runtime_a.clone())
        .with_runtime("rebind-b", runtime_b.clone())
        .build();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app must build");
    app.manage(state);

    // runtime A：带模型目录的会话。
    let window = mock_window(&app);
    new_session(
        app.state::<AppState>(),
        window.clone(),
        "rebind-a".to_string(),
        "local:rebind".to_string(),
        "profile-ms".to_string(),
        "persona".to_string(),
        Some(".".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("session must be created");
    // runtime B：同一 source 重建（不同 agent、无模型宣告）。
    new_session(
        app.state::<AppState>(),
        window,
        "rebind-b".to_string(),
        "local:rebind".to_string(),
        "profile-ms".to_string(),
        "persona".to_string(),
        Some(".".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("session must be created");

    let snapshot_b = runtime_b
        .sessions
        .lock()
        .unwrap()
        .get("local:rebind")
        .cloned()
        .unwrap();
    assert_eq!(
        snapshot_b.model_surface,
        ModelSurface::None,
        "新 owner 空面"
    );
    assert!(
        snapshot_b.model_choices.is_empty(),
        "旧 Agent choices 不得泄漏"
    );
    assert_eq!(snapshot_b.model, "", "旧 Agent model id 不得泄漏");
    assert!(
        !serde_json::to_string(&snapshot_b.config_options)
            .unwrap()
            .contains("model-selection"),
        "旧 Agent config id 不得泄漏：{:?}",
        snapshot_b.config_options
    );
    // runtime A 的会话不受影响（per-runtime sessions 隔离）。
    let snapshot_a = runtime_a
        .sessions
        .lock()
        .unwrap()
        .get("local:rebind")
        .cloned()
        .unwrap();
    assert_eq!(
        snapshot_a.model_surface,
        ModelSurface::ConfigOption {
            config_id: "model-selection".to_string()
        }
    );
}
