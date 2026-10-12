//! #106 P5：#97 模型切换 wire 矩阵（自 lib 内嵌形态迁入 7/8 测，装配经
//! test_harness 门面，断言逐条保持——验收 8）。
//!
//! **回退条款记录**：`rebind_on_other_runtime_starts_with_clean_selector_snapshot`
//! （跨 runtime/Agent 重绑）保留在 lib `session::model_switch_wire_tests`——它需要
//! 同时持有两个 runtime 的会话快照做白盒比对，门面窄值视图无法承载（强迁等于
//! 暴露 AppState 字段级访问，违反 spec P5「一律不加 pub」约束）。
//!
//! agent 侧行为：`pylon-fake-agent --scenario set-config-option --mode <m>` +
//! `--trace-file/--trace-mode all` + `--barrier-ready/--barrier-release`。

use prism_desktop_lib::test_harness::{HarnessConfig, SetModelApiView, TestHarness};

/// trace 中 (method, params) 序列（wire 断言用）。
fn read_trace_methods(trace: &std::path::Path) -> Vec<(String, serde_json::Value)> {
    let content = std::fs::read_to_string(trace).expect("read trace");
    content
        .lines()
        .map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            (
                value
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string(),
                value
                    .get("params")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
        })
        .collect()
}

/// 标准装配：set-config-option agent（ConfigOption 协议声明 + trace + 可选屏障）。
/// 屏障/trace 路径必须在 boot 前拼进场景 args（bin 启动即解析）。
async fn boot_config_option_harness_via_path(
    label: &str,
    mode: &str,
    barrier: Option<(std::path::PathBuf, std::path::PathBuf)>,
    trace_path: &std::path::Path,
) -> TestHarness {
    let _ = label; // label 仅语义标注（trace 路径由调用方唯一化）
    let trace_arg = trace_path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec![
        "--scenario",
        "set-config-option",
        "--mode",
        mode,
        "--session-id",
        "ms-session",
        "--trace-file",
        Box::leak(trace_arg.into_boxed_str()),
        "--trace-mode",
        "all",
    ];
    if let Some((ready, release)) = barrier {
        args.push("--barrier-ready");
        args.push(Box::leak(
            ready.to_string_lossy().into_owned().into_boxed_str(),
        ));
        args.push("--barrier-release");
        args.push(Box::leak(
            release.to_string_lossy().into_owned().into_boxed_str(),
        ));
    }
    TestHarness::boot(
        HarnessConfig::new()
            .with_fake_agent("ms-agent", &args)
            .with_set_model_api(SetModelApiView::ConfigOption),
    )
    .await
}

#[tokio::test]
async fn runtime_switch_sends_advertised_config_id_and_keeps_pending_on_empty_echo() {
    let trace = TestHarness::temp_file("ms-adv-id").with_extension("jsonl");
    let harness =
        boot_config_option_harness_via_path("ms-adv-id", "echo-empty", None, &trace).await;
    harness
        .new_session("ms-agent", "local:ms", "profile-ms", "persona", Some("."))
        .await
        .expect("session must be created");

    let result = harness
        .set_config_option("ms-agent", "local:ms", "model", serde_json::json!("m-2"))
        .await
        .expect("switch must succeed on empty echo");

    // 空回声：命令返回的就是 agent 的空对象（精确相等，防止实现夹带合成状态）。
    assert_eq!(result, serde_json::json!({}));
    let session = harness
        .session_model_state("local:ms")
        .await
        .expect("session");
    assert_eq!(session.model.as_deref(), Some("m-2"), "空回声保留乐观值");
    assert_eq!(
        session.model_pending.as_deref(),
        Some("m-2"),
        "空回声必须保留可辨识的未确认态"
    );
    assert_eq!(
        session.surface_config_id.as_deref(),
        Some("model-selection")
    );
    assert_eq!(
        session.model_choices,
        vec!["m-1".to_string(), "m-2".to_string()]
    );

    let methods = read_trace_methods(&trace);
    let switches: Vec<&serde_json::Value> = methods
        .iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .map(|(_, params)| params)
        .collect();
    assert_eq!(switches.len(), 1, "{methods:?}");
    assert_eq!(
        switches[0].get("configId").and_then(|v| v.as_str()),
        Some("model-selection"),
        "广告的真实 config id 必须原样上 wire：{:?}",
        switches[0]
    );
    assert_eq!(switches[0].get("value"), Some(&serde_json::json!("m-2")));
}

#[tokio::test]
async fn unadvertised_model_id_is_rejected_before_any_rpc() {
    let trace = TestHarness::temp_file("ms-reject").with_extension("jsonl");
    let harness =
        boot_config_option_harness_via_path("ms-reject", "echo-empty", None, &trace).await;
    harness
        .new_session("ms-agent", "local:ms", "profile-ms", "persona", Some("."))
        .await
        .expect("session must be created");

    let error = harness
        .set_config_option(
            "ms-agent",
            "local:ms",
            "model",
            serde_json::json!("m-not-advertised"),
        )
        .await
        .expect_err("未广告 id 必须被拒");

    assert!(error.contains("model_not_advertised"));
    let session = harness
        .session_model_state("local:ms")
        .await
        .expect("session");
    assert_eq!(
        session.model.as_deref(),
        Some("m-1"),
        "拒绝后本地 current 不变"
    );
    assert_eq!(session.model_pending, None);
    let methods = read_trace_methods(&trace);
    assert!(
        !methods
            .iter()
            .any(|(method, _)| method == "session/set_config_option"),
        "被拒请求绝不能上 wire：{methods:?}"
    );
}

/// 验收（钳制收敛）：Agent 回显 adopted 列表把 requested 钳制为实际值时，
/// 会话状态一致收敛到 Agent 实际值，且不补发第二次 set-config RPC。
#[tokio::test]
async fn clamped_switch_converges_to_agent_settled_value() {
    let trace = TestHarness::temp_file("ms-clamp").with_extension("jsonl");
    let harness =
        boot_config_option_harness_via_path("ms-clamp", "echo-adopted:m-1", None, &trace).await;
    harness
        .new_session("ms-agent", "local:ms", "profile-ms", "persona", Some("."))
        .await
        .expect("session must be created");

    harness
        .set_config_option("ms-agent", "local:ms", "model", serde_json::json!("m-2"))
        .await
        .expect("钳制不是传输失败");

    let session = harness
        .session_model_state("local:ms")
        .await
        .expect("session");
    assert_eq!(
        session.model.as_deref(),
        Some("m-1"),
        "最终状态必须回到 Agent 实际值"
    );
    assert_eq!(session.model_pending, None, "权威回显清除未确认态");
    assert_eq!(
        session.model_choices,
        vec!["m-1".to_string(), "m-2".to_string()]
    );
    // 评审补强：钳制收敛后不得补发第二次 set-config（防 set-config loop）。
    let switches = read_trace_methods(&trace)
        .into_iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .count();
    assert_eq!(switches, 1, "钳制后禁止补偿 RPC");
}

/// 验收（Agent 拒绝）：set_config_option 被 Agent 以 JSON-RPC error 拒绝时，命令
/// 上抛错误、本地状态不变、不重试（trace 恰一次请求）。
#[tokio::test]
async fn agent_rejected_switch_propagates_error_without_state_change() {
    let trace = TestHarness::temp_file("ms-agent-reject").with_extension("jsonl");
    let harness =
        boot_config_option_harness_via_path("ms-agent-reject", "reject", None, &trace).await;
    harness
        .new_session("ms-agent", "local:ms", "profile-ms", "persona", Some("."))
        .await
        .expect("session must be created");

    let error = harness
        .set_config_option("ms-agent", "local:ms", "model", serde_json::json!("m-2"))
        .await
        .expect_err("Agent 拒绝必须上抛");

    assert!(error.contains("rejected"), "{error}");
    let session = harness
        .session_model_state("local:ms")
        .await
        .expect("session");
    assert_eq!(
        session.model.as_deref(),
        Some("m-1"),
        "拒绝后 current 保持 Agent 原值"
    );
    assert_eq!(session.model_pending, None, "失败不得留下未确认态");
    let switches = read_trace_methods(&trace)
        .into_iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .count();
    assert_eq!(switches, 1, "拒绝后不得重试");
}

/// 验收 8（依赖 option 发送校验接线）：reasoning 组在会话宣告 choices 时发送前
/// 校验——失效值被拒且不上 wire；仍被广告的值原样上 wire。
#[tokio::test]
async fn reasoning_switch_is_validated_against_advertised_choices() {
    let trace = TestHarness::temp_file("ms-reasoning").with_extension("jsonl");
    let harness =
        boot_config_option_harness_via_path("ms-reasoning", "echo-empty", None, &trace).await;
    harness
        .new_session("ms-agent", "local:ms", "profile-ms", "persona", Some("."))
        .await
        .expect("session must be created");

    // 失效值（宣告的 reasoning choices 只有 low/high）：发送前被拒。
    let error = harness
        .set_config_option(
            "ms-agent",
            "local:ms",
            "reasoning_effort",
            serde_json::json!("ultra"),
        )
        .await
        .expect_err("未广告 reasoning 值必须被拒");
    assert!(error.contains("reasoning_not_advertised"));

    // 仍被广告的值：放行并按语义键上 wire（reasoning 键即 config id，现状行为）。
    harness
        .set_config_option(
            "ms-agent",
            "local:ms",
            "reasoning_effort",
            serde_json::json!("high"),
        )
        .await
        .expect("广告内的 reasoning 值必须放行");

    let switches: Vec<serde_json::Value> = read_trace_methods(&trace)
        .into_iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .map(|(_, params)| params)
        .collect();
    assert_eq!(switches.len(), 1, "被拒请求不得上 wire，放行请求恰一次");
    assert_eq!(
        switches[0].get("configId").and_then(|v| v.as_str()),
        Some("reasoning_effort")
    );
    assert_eq!(switches[0].get("value"), Some(&serde_json::json!("high")));
    let session = harness
        .session_model_state("local:ms")
        .await
        .expect("session");
    assert_eq!(
        session.model.as_deref(),
        Some("m-1"),
        "reasoning 切换不影响 model 通道"
    );
}

/// 验收（generation 过期丢弃回写）：RPC 在途时 client generation 前进——响应
/// 到达后写回必须被整体丢弃（current/pending 不变），命令以 stale generation
/// 错误失败，且请求本身确实上过 wire。
#[tokio::test]
async fn stale_generation_discards_switch_write_back() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let ready = std::env::temp_dir().join(format!(
        "pylon-ms-gen-{}-{unique}.ready",
        std::process::id()
    ));
    let release = ready.with_extension("release");
    std::fs::remove_file(&ready).ok();
    std::fs::remove_file(&release).ok();
    let trace = TestHarness::temp_file("ms-stale-gen").with_extension("jsonl");
    let harness = boot_config_option_harness_via_path(
        "ms-stale-gen",
        "barrier",
        Some((ready.clone(), release.clone())),
        &trace,
    )
    .await;
    harness
        .new_session("ms-agent", "local:ms", "profile-ms", "persona", Some("."))
        .await
        .expect("session must be created");

    // 并发 racer：poll 线程等 agent 触 ready（set_config_option 已上 wire 且挂起）
    // → 主任务前进 client generation（模拟 RPC 在途期间客户端被替换）→ 放行响应。
    // join! 同任务并发借用 harness，无 'static 约束。
    let (result, ()) = tokio::join!(
        harness.set_config_option("ms-agent", "local:ms", "model", serde_json::json!("m-2")),
        async {
            let ready_for_poll = ready.clone();
            let poll = tokio::task::spawn_blocking(move || {
                let ready = ready_for_poll;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                while !ready.exists() {
                    if std::time::Instant::now() > deadline {
                        panic!("barrier ready timeout");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            });
            poll.await.expect("racer must not panic");
            harness.advance_client_generation();
            std::fs::write(&release, b"go").expect("write release");
        }
    );

    let error = result.expect_err("RPC 在途换代后写回必须被拒");
    assert!(error.contains("stale ACP client generation"), "{error}");
    let session = harness
        .session_model_state("local:ms")
        .await
        .expect("session");
    assert_eq!(
        session.model.as_deref(),
        Some("m-1"),
        "过期响应不得写回 current"
    );
    assert_eq!(session.model_pending, None, "过期响应不得留下未确认态");
    let switches = read_trace_methods(&trace)
        .into_iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .count();
    assert_eq!(switches, 1, "请求确实上过 wire（被测的是写回丢弃）");
    std::fs::remove_file(&ready).ok();
    std::fs::remove_file(&release).ok();
}

/// 验收（reconnect replay + 根级列表）：session/load 复活期不发任何 selector RPC，
/// 根级 availableModels 进入 SessionInfo 模型面。
#[tokio::test]
async fn load_revive_applies_root_level_catalog_without_selector_rpcs() {
    let trace = TestHarness::temp_file("ms-revive").with_extension("jsonl");
    let advertise = serde_json::json!({
        "sessionId": "remote-original",
        "availableModels": [
            {"modelId": "root:alpha", "name": "Alpha"},
            {"modelId": "root:beta", "name": "Beta"}
        ],
        "currentModelId": "root:beta",
        "configOptions": [{
            "id": "reasoning_effort", "category": "thought_level",
            "options": [{"valueId": "low"}, {"valueId": "high"}], "currentValue": "low"
        }]
    })
    .to_string();
    let harness = TestHarness::boot(HarnessConfig::new().with_fake_agent(
        "ms-revive-agent",
        &[
            "--scenario",
            "revive-load",
            "--advertise-models",
            &advertise,
            "--trace-file",
            &trace.to_string_lossy(),
            "--trace-mode",
            "all",
        ],
    ))
    .await;

    let (peri_id, recreated) = harness
        .ensure_mapping(
            "local:revive",
            Some("profile-revive"),
            "",
            ".",
            Some("remote-original"),
        )
        .await
        .expect("revive must succeed");
    assert_eq!(peri_id, "remote-original");
    assert_eq!(recreated, None, "复活成功不得重建会话");

    let session = harness
        .session_model_state("local:revive")
        .await
        .expect("session");
    // 根级 availableModels（无嵌套 models 键）等价进入模型面（验收 2 wire 侧）：
    // ModelsState 面（surface_config_id = None 且非 none）+ choices/model 值。
    assert!(!session.surface_is_none, "模型面必须为 ModelsState");
    assert_eq!(
        session.surface_config_id, None,
        "ModelsState 面无 config id"
    );
    assert_eq!(
        session.model_choices,
        vec!["root:alpha".to_string(), "root:beta".to_string()]
    );
    assert_eq!(session.model.as_deref(), Some("root:beta"));
    assert_eq!(session.mode, None);

    // replay 期 selector 零 RPC：模型状态来自 Agent 的 load 响应本身。
    let methods: Vec<String> = read_trace_methods(&trace)
        .into_iter()
        .map(|(method, _)| method)
        .collect();
    assert!(
        !methods
            .iter()
            .any(|m| m == "session/set_config_option" || m == "session/set_model"),
        "复活期不得自动补发 selector RPC：{methods:?}"
    );
}
