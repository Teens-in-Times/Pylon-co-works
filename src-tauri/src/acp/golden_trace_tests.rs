//! A0：Pylon 现有 ACP 的 golden trace 基线生成器（test-only，不改运行路径）。
//!
//! 目的：在 A1a 换官方 `agent-client-protocol` 引擎之前，把当前手写 ACP 在
//! 8 个场景下的 wire 时序固化为**可重复生成**的基线，供 A1c / A9 的 parity 比较。
//!
//! 启用方式：
//!
//! ```text
//! PYLON_GOLDEN_TRACE_DIR=<dir> cargo test --lib acp::golden_trace_tests::golden_trace_baseline_generation
//! ```
//!
//! 未设置环境变量时该测试直接返回（no-op），因此不影响常规 `cargo test --lib acp::`。
//! 生成入口与确定性校验见 `scripts/generate-acp-golden-trace.mjs`（连跑两遍并
//! 逐字节比对）。
//!
//! 记录形状：`WireRecord` 去掉机器相关的 `traceId` / `timestamp`，补上三条身份轴
//! —— `owner`（durable session owner key）、`generation`（`clientGeneration`）、
//! `ordinal`（= `monotonicSeq`）——再加 `scenario` 列。

use std::path::PathBuf;
use std::time::Duration;

use super::wire_trace::{WireDirection, WireIdKind, WireRecord};
use super::{AcpClient, AcpError, METHOD_SESSION_LOAD, METHOD_SESSION_NEW};

/// A0 固定场景清单（顺序即基线文件生成顺序，对应施工书 §A0 步骤 4）。
pub(crate) const SCENARIOS: [&str; 10] = [
    "initialize",
    "new_load",
    "prompt",
    "tool",
    "permission",
    "done_error",
    "cancel",
    "reconnect",
    // A5①：wrapper provider 的基线。这两个场景带真实 `provider`，把
    // catalog 声明的 clientCapabilities 与实际启动路径一起钉进 wire 基线。
    "wrapper_claude",
    "wrapper_codex",
];

/// 施工书 §A0 步骤 4 点名的 8 个场景。与 [`SCENARIOS`] 的前缀断言对齐：
/// 新增场景只允许追加，不得删改这 8 个。
const CONSTRUCTION_BOOK_SCENARIOS: [&str; 8] = [
    "initialize",
    "new_load",
    "prompt",
    "tool",
    "permission",
    "done_error",
    "cancel",
    "reconnect",
];

/// A5① wrapper 场景 → catalog provider。`None` = 不带 provider 的基线场景。
fn scenario_provider(scenario: &str) -> Option<&'static str> {
    match scenario {
        "wrapper_claude" => Some("claude-code"),
        "wrapper_codex" => Some("codex"),
        _ => None,
    }
}

/// 基线使用的 durable owner（真实 `DurableSessionOwner`，不是占位字符串）。
const OWNER_PARTS: (&str, &str, &str) = ("golden-profile", "fake-acp-golden", "local:golden");
const SESSION_ID: &str = "golden-session";
/// permission 场景的 agent 请求 id（数字形态，便于测试用 responder 应答）。
const PERMISSION_REQUEST_ID: u64 = 9001;

/// 单一 fake agent（`pylon-fake-agent --scenario <名>`，P1 后不再有内嵌脚本）。
/// 场景名 = [`SCENARIOS`] 元素，bin 侧 `handle_golden` 逐行对照原 GOLDEN_AGENT_SCRIPT；
/// wrapper 两场景的 agent 侧行为与 `prompt` 完全一致（provider 是客户端身份，
/// 走 AgentDef.provider 注入，bin 无需感知）。
fn golden_agent(scenario: &str) -> crate::agent_config::AgentDef {
    let bin_scenario = match scenario {
        "wrapper_claude" | "wrapper_codex" => "prompt",
        other => other,
    };
    let mut agent =
        crate::test_utils::fake_acp_agent("fake-acp-golden", &["--scenario", bin_scenario]);
    // A5①：wrapper 场景带真实 provider，使 catalog 声明的 clientCapabilities 与
    // provider 身份一起进入 wire 基线；其余场景保持 provider = None（P60 基线不变）。
    agent.provider = scenario_provider(scenario).map(str::to_string);
    agent
}

fn trace_dir() -> Option<PathBuf> {
    std::env::var("PYLON_GOLDEN_TRACE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

/// A FIFO barrier proves that prompt processing has finished before cancel.
/// The fixture must withhold its reply until cancel, regardless of scheduling.
#[tokio::test]
async fn cancel_fixture_reply_waits_for_cancel() {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let mut child = tokio::process::Command::new(crate::test_utils::fake_agent_bin())
        .args(["--scenario", "cancel"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("fixture must start");
    let mut stdin = child.stdin.take().expect("fixture stdin");
    stdin
        .write_all(
            concat!(
                "{\"id\":1,\"method\":\"session/prompt\"}\n",
                "{\"id\":2,\"method\":\"fixture/barrier\"}\n",
                "{\"method\":\"session/cancel\"}\n",
            )
            .as_bytes(),
        )
        .await
        .expect("fixture input");
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .expect("fixture timeout")
        .expect("fixture output");
    assert!(output.status.success());
    let records: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .expect("UTF-8 output")
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON output"))
        .collect();
    assert_eq!(records.len(), 3);
    assert_eq!(
        records[0]["id"], 2,
        "reply must follow the pre-cancel barrier"
    );
    assert_eq!(records[1]["method"], "session/update");
    assert_eq!(records[2]["id"], 1);
    assert_eq!(records[2]["result"]["stopReason"], "cancelled");
}

fn owner_key() -> String {
    crate::session::DurableSessionOwner::new(OWNER_PARTS.0, OWNER_PARTS.1, OWNER_PARTS.2)
        .key()
        .expect("golden owner must be valid")
}

fn text_block() -> serde_json::Value {
    serde_json::json!({"type": "text", "text": "golden prompt"})
}

/// 归一化：丢弃机器相关字段，补 scenario/connection/owner/generation/ordinal。
/// `connections` 每个元素是一条连接的快照（reconnect 场景有两条）。
fn normalize(connections: &[Vec<WireRecord>], scenario: &str, owner: &str) -> String {
    connections
        .iter()
        .enumerate()
        .flat_map(|(index, records)| {
            // SDK 为出站请求生成 UUID，而 legacy 基线使用递增数字。将每条连接内
            // 首次出现的 wire id 映射到稳定序号，保留 idKind 与请求/响应关联，
            // 这样 golden trace 比较的是 id 语义和顺序，而不是机器随机 UUID。
            let mut id_numbers = std::collections::HashMap::<String, u64>::new();
            let mut next_id = 1_u64;
            records.iter().map(move |record| {
                let mut value =
                    serde_json::to_value(record).expect("wire record must serialize to JSON");
                let object = value
                    .as_object_mut()
                    .expect("wire record must serialize to a JSON object");
                object.remove("traceId");
                object.remove("timestamp");
                // 身份三轴：owner / generation / ordinal（施工书 §A0 步骤 4）。
                object.remove("clientGeneration");
                object.insert("scenario".into(), serde_json::json!(scenario));
                object.insert("connection".into(), serde_json::json!(index + 1));
                object.insert("owner".into(), serde_json::json!(owner));
                object.insert(
                    "generation".into(),
                    serde_json::json!(record.client_generation),
                );
                object.insert("ordinal".into(), serde_json::json!(record.monotonic_seq));
                if let Some(id) = object.get("idValue").cloned() {
                    if !id.is_null() {
                        let key = serde_json::to_string(&id).expect("wire id must serialize");
                        let stable_id = if let Some(existing) = id_numbers.get(&key) {
                            *existing
                        } else {
                            let assigned = next_id;
                            next_id += 1;
                            id_numbers.insert(key, assigned);
                            assigned
                        };
                        let normalized = match object.get("idKind").and_then(|kind| kind.as_str()) {
                            Some("number") => serde_json::json!(stable_id),
                            Some("string") => serde_json::json!(format!("wire-{stable_id}")),
                            _ => id,
                        };
                        object.insert("idValue".into(), normalized);
                    }
                }
                serde_json::to_string(&value).expect("normalized record must serialize")
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn new_session(client: &AcpClient) -> Result<(), AcpError> {
    client
        .prepare_rpc(
            METHOD_SESSION_NEW,
            serde_json::json!({"cwd": ".", "mcpServers": []}),
        )?
        .complete()
        .await?;
    Ok(())
}

async fn load_session(client: &AcpClient) -> Result<(), AcpError> {
    client
        .prepare_rpc(
            METHOD_SESSION_LOAD,
            serde_json::json!({"sessionId": SESSION_ID, "cwd": ".", "mcpServers": []}),
        )?
        .complete()
        .await?;
    Ok(())
}

async fn prompt(client: &AcpClient) -> Result<serde_json::Value, AcpError> {
    client
        .prepare_prompt(SESSION_ID, vec![text_block()])?
        .complete()
        .await
}

/// 轮询等待 agent 发出 `session/request_permission`，且 SDK 已登记对应 responder。
/// wire capture 与 dispatch handler 是两个异步观察点，不能只看到 capture 就立即应答。
async fn wait_for_permission_request(client: &AcpClient) -> super::RequestId {
    let trace = client
        .wire_trace()
        .expect("golden client must expose wire trace");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(record) = trace.snapshot().into_iter().find(|record| {
            record.method.as_deref() == Some("session/request_permission")
                && record.direction == WireDirection::AgentToPylon
        }) {
            let id = record
                .id_value
                .as_ref()
                .and_then(super::RequestId::from_json_value)
                .unwrap_or(super::RequestId::Number(PERMISSION_REQUEST_ID));
            let registered = client
                .backend
                .pending_requests
                .lock()
                .map(|pending| pending.contains_key(&id))
                .unwrap_or(false);
            if registered {
                return id;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "golden permission request must arrive within 5s"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 驱动一个场景，返回每条连接的 wire 记录（reconnect 场景含两代连接）。
async fn drive_scenario(scenario: &str) -> Result<Vec<Vec<WireRecord>>, AcpError> {
    let agent = golden_agent(scenario);
    let client = AcpClient::connect_with_generation(&agent, None, 1).await?;
    let trace = client
        .wire_trace()
        .expect("golden client must expose wire trace");

    match scenario {
        "initialize" => {}
        "new_load" => {
            new_session(&client).await?;
            load_session(&client).await?;
        }
        "prompt" | "tool" | "done_error" => {
            new_session(&client).await?;
            let _ = prompt(&client).await;
        }
        "permission" => {
            new_session(&client).await?;
            let mut rx = client
                .prepare_prompt(SESSION_ID, vec![text_block()])?
                .send_keep_rx()
                .await?;
            let request_id = wait_for_permission_request(&client).await;
            assert!(
                client
                    .responder()
                    .respond(
                        request_id,
                        serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}}),
                    )
                    .await,
                "golden trace responder must answer the permission request"
            );
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut rx).await;
        }
        "cancel" => {
            new_session(&client).await?;
            let mut rx = client
                .prepare_prompt(SESSION_ID, vec![text_block()])?
                .send_keep_rx()
                .await?;
            client.cancel_session(SESSION_ID).await?;
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut rx).await;
        }
        "reconnect" => {
            new_session(&client).await?;
            let _ = prompt(&client).await;
            client.kill()?;
            let second = AcpClient::connect_with_generation(&agent, None, 2).await?;
            let second_trace = second
                .wire_trace()
                .expect("golden client must expose wire trace");
            load_session(&second).await?;
            let mut records = vec![trace.snapshot()];
            records.push(second_trace.snapshot());
            second.kill()?;
            return Ok(records);
        }
        // A5①：wrapper provider 走完整的 initialize → session/new → prompt，
        // 与真实会话同一条路径（都经 `spawn_agent_child` 的 LaunchPlan）。
        "wrapper_claude" | "wrapper_codex" => {
            new_session(&client).await?;
            let _ = prompt(&client).await;
        }
        other => panic!("unknown golden scenario: {other}"),
    }

    let records = vec![trace.snapshot()];
    client.kill()?;
    Ok(records)
}

/// 生成基线：仅在 `PYLON_GOLDEN_TRACE_DIR` 设置时执行（否则 no-op）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn golden_trace_baseline_generation() {
    let Some(dir) = trace_dir() else {
        return;
    };
    std::fs::create_dir_all(&dir).expect("golden trace dir must be creatable");
    let owner = owner_key();
    for scenario in SCENARIOS {
        let records = tokio::time::timeout(Duration::from_secs(30), drive_scenario(scenario))
            .await
            .unwrap_or_else(|_| panic!("golden scenario {scenario} timed out"))
            .unwrap_or_else(|error| panic!("golden scenario {scenario} failed: {error:?}"));
        assert!(
            records.iter().any(|connection| !connection.is_empty()),
            "golden scenario {scenario} produced no wire records"
        );
        let jsonl = normalize(&records, scenario, &owner);
        std::fs::write(dir.join(format!("{scenario}.jsonl")), format!("{jsonl}\n"))
            .expect("golden trace must be writable");
    }
}

/// 场景清单与施工书 §A0 步骤 4 的 8 个场景逐项对齐（常驻断言，不依赖环境变量）。
///
/// A5① 追加了两个 wrapper 场景，所以这里断言的是「施工书 8 场景是 SCENARIOS 的
/// 前缀」而不是「SCENARIOS 就是这 8 个」——前缀断言仍然禁止删改/重排原 8 场景，
/// 只是允许向后追加（严格程度不降）。
/// B2 顺序锁定：任何建立会话的场景，wire 上 `initialize` 必须先于 `session/new`。
/// 这是「session/new 不得绕过 initialize」契约的可观测证据（守卫在
/// `AcpClient::session_ready`，这里是端到端的第二把锁）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wire_order_locks_initialize_before_session_new() {
    let records = tokio::time::timeout(Duration::from_secs(30), drive_scenario("prompt"))
        .await
        .expect("prompt scenario must not hang")
        .expect("prompt scenario must succeed");
    let sent_methods: Vec<&str> = records
        .iter()
        .flatten()
        .filter(|record| record.direction == WireDirection::PylonToAgent)
        .filter_map(|record| record.method.as_deref())
        .collect();
    let initialize_at = sent_methods
        .iter()
        .position(|method| *method == "initialize")
        .expect("initialize must be on the wire");
    let session_new_at = sent_methods
        .iter()
        .position(|method| *method == "session/new")
        .expect("session/new must be on the wire");
    assert!(
        initialize_at < session_new_at,
        "initialize must precede session/new on the wire, got {sent_methods:?}"
    );
    assert_eq!(initialize_at, 0, "initialize must be the first request");
}

#[test]
fn golden_trace_scenarios_match_construction_book() {
    assert_eq!(
        &SCENARIOS[..CONSTRUCTION_BOOK_SCENARIOS.len()],
        &CONSTRUCTION_BOOK_SCENARIOS[..]
    );
    assert_eq!(SCENARIOS.len(), CONSTRUCTION_BOOK_SCENARIOS.len() + 2);
}

/// A5① 验收：wrapper 场景必须带真实 provider，否则基线里就看不出声明是 provider
/// 作用域的（`initialize` 的 `clientCapabilities` 会与无 provider 场景同形）。
#[test]
fn wrapper_scenarios_carry_their_catalog_provider() {
    assert_eq!(scenario_provider("wrapper_claude"), Some("claude-code"));
    assert_eq!(scenario_provider("wrapper_codex"), Some("codex"));
    for scenario in CONSTRUCTION_BOOK_SCENARIOS {
        assert_eq!(
            scenario_provider(scenario),
            None,
            "{scenario} 必须保持无 provider"
        );
    }
    // 带 provider 的场景必须真的能在 catalog 里解析出 profile。
    for scenario in ["wrapper_claude", "wrapper_codex"] {
        let provider = scenario_provider(scenario).expect("wrapper 场景必须有 provider");
        assert!(
            crate::agent_catalog::provider_profile(provider)
                .expect("catalog 必须可解析")
                .is_some(),
            "{provider} 必须在 catalog 中"
        );
    }
}

/// 归一化必须去掉机器相关字段、保留身份轴。
#[test]
fn golden_trace_normalization_drops_volatile_fields() {
    let record = WireRecord {
        trace_id: "fake-acp-golden-42".into(),
        monotonic_seq: 7,
        timestamp: crate::time::Timestamp::new(1_700_000_000_000),
        agent_id: "fake-acp-golden".into(),
        provider: None,
        source: "acp".into(),
        local_session_id: None,
        remote_session_id: Some(SESSION_ID.to_string()),
        peri_id: None,
        client_generation: 1,
        request_id: None,
        direction: WireDirection::PylonToAgent,
        method: Some("session/prompt".to_string()),
        id_kind: WireIdKind::Number,
        id_value: Some(serde_json::json!(2)),
        params: None,
        result: None,
        error: None,
        tool_call_id: None,
        status: "sent".to_string(),
    };
    let line = normalize(&[vec![record]], "prompt", "owner-key");
    let value: serde_json::Value = serde_json::from_str(&line).expect("normalized JSON");
    assert!(value.get("traceId").is_none());
    assert!(value.get("timestamp").is_none());
    assert_eq!(value["scenario"], "prompt");
    assert_eq!(value["connection"], 1);
    assert_eq!(value["owner"], "owner-key");
    assert_eq!(value["ordinal"], 7);
    assert_eq!(value["generation"], 1);
    assert_eq!(value["idKind"], "number");
    assert_eq!(value["status"], "sent");
}

// ── #99：wire parity 与 replay 序列契约 ──

/// #99 验收：typed SDK engine 与 raw wire 观测对同一帧产生一致的
/// method/direction——inbox 帧的 `wire_ordinal` 必须能对上 wire capture 中
/// 同 method 的记录（raw/typed 双轨一致）；response 不进 inbox（SentRequest
/// 直达），但其 raw wire 记录必须存在（id 保真：Number 形态）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inbound_envelope_agrees_with_wire_capture() {
    let agent = golden_agent("prompt");
    let client = AcpClient::connect_with_generation(&agent, None, 1)
        .await
        .expect("connect");
    let mut inbox = client
        .take_notification_inbox()
        .expect("inbox available exactly once");
    new_session(&client).await.expect("session/new");
    let mut prompt_rx = client
        .prepare_prompt(SESSION_ID, vec![text_block()])
        .expect("prepare prompt")
        .send_keep_rx()
        .await
        .expect("send prompt");
    let response = tokio::time::timeout(Duration::from_secs(10), &mut prompt_rx)
        .await
        .expect("prompt response must arrive")
        .expect("prompt rx must stay open");

    // 收集 inbox 帧（typed lane），直到静默。
    let mut frames = Vec::new();
    while let Ok(Some(frame)) = tokio::time::timeout(Duration::from_millis(300), inbox.recv()).await
    {
        frames.push(frame);
    }

    // prompt 响应必须走 SentRequest 路径（不进 inbox），其 stopReason 可读。
    assert_eq!(
        response.result.as_ref().unwrap()["stopReason"],
        serde_json::json!("end_turn")
    );

    let trace = client.wire_trace().expect("client must expose wire trace");
    let records = trace.snapshot();
    assert!(
        !frames.is_empty(),
        "prompt scenario must deliver at least one session/update"
    );
    let mut seqs = Vec::new();
    for frame in &frames {
        let ordinal = frame.wire_ordinal.expect("inbox frame must carry ordinal");
        let record = records
            .iter()
            .find(|record| record.monotonic_seq == ordinal)
            .unwrap_or_else(|| panic!("wire ordinal {ordinal} must resolve to a raw wire record"));
        assert_eq!(
            record.method.as_deref(),
            frame.raw.method.as_deref(),
            "typed lane 与 raw lane 必须对同一帧报告同一 method"
        );
        assert_eq!(record.direction, WireDirection::AgentToPylon);
        seqs.push(frame.ingress_seq);
    }
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(
        seqs, sorted,
        "ingress 序列必须按投递顺序单调递增（无 gap / 无乱序）"
    );

    // 响应帧的 raw 证据：请求-响应 id 保真——响应记录的 id_kind/id_value 必须
    // 与出站 prompt 请求同形同值（SDK 出站 id 为 UUID 字符串，响应原样回带；
    // 禁止 null/absent 静默当 0 或形态改写）。
    let prompt_request = records
        .iter()
        .find(|record| {
            record.direction == WireDirection::PylonToAgent
                && record.method.as_deref() == Some("session/prompt")
        })
        .expect("prompt request must be on wire");
    let response_record = records
        .iter()
        .find(|record| {
            record.direction == WireDirection::AgentToPylon
                && record.method.is_none()
                && record
                    .result
                    .as_ref()
                    .is_some_and(|result| result.get("stopReason").is_some())
        })
        .expect("prompt response must be on wire");
    assert_eq!(
        response_record.id_kind, prompt_request.id_kind,
        "响应 id 形态必须与请求一致"
    );
    assert_eq!(
        response_record.id_value, prompt_request.id_value,
        "响应 id 值必须与请求一致（request-response correlation）"
    );

    let _ = client.kill();
}

/// #99 验收：session/load replay 的 begin/update/boundary/end 顺序可由
/// 单一序列（wire monotonicSeq + ingress_seq）重建；replay 帧的分类为
/// Replay（request id 绑定），不与 live 混淆。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_boundary_order_is_reconstructible_from_sequences() {
    use crate::agent_config::McpServersMode;

    let agent = golden_agent("new_load");
    let client = AcpClient::connect_with_generation(&agent, None, 1)
        .await
        .expect("connect");
    let mut inbox = client
        .take_notification_inbox()
        .expect("inbox available exactly once");
    new_session(&client).await.expect("session/new");

    let capture = client
        .begin_replay_capture(SESSION_ID)
        .expect("replay capture");
    let request_id = capture.request_id;
    let (_response, batch) = super::load_session_with_replay(
        capture,
        SESSION_ID,
        ".",
        Vec::new(),
        McpServersMode::Always,
    )
    .await
    .expect("load with replay");

    // replay 收集完整：2 条 history update（fake agent 脚本 new_load 分支）。
    assert_eq!(batch.events.len(), 2, "两条 history update 必须完整收集");
    assert!(batch.metadata.complete, "replay 不得静默截断");
    assert_eq!(batch.metadata.boundary.observed_count, 2);
    assert_eq!(
        batch.metadata.boundary.kind, "session-load-response",
        "边界 = load 响应（确定性边界）"
    );

    // wire 单序列重建：load 请求 → 2 条 update → load 响应。
    let trace = client.wire_trace().expect("client must expose wire trace");
    let records = trace.snapshot();
    let load_request = records
        .iter()
        .find(|record| {
            record.direction == WireDirection::PylonToAgent
                && record.method.as_deref() == Some(super::METHOD_SESSION_LOAD)
        })
        .expect("load request must be on wire");
    let load_request_seq = load_request.monotonic_seq;
    let load_request_id = load_request.id_value.clone();
    let load_response_seq = records
        .iter()
        .find(|record| {
            record.direction == WireDirection::AgentToPylon
                && record.method.is_none()
                // id 保真：响应 id 与请求 id 同形同值（request-response correlation）。
                && record.id_value == load_request_id
                && record.result.as_ref().is_some_and(|result| {
                    result
                        .get("loaded")
                        .is_some_and(|loaded| loaded.as_bool() == Some(true))
                })
        })
        .expect("load response boundary must be on wire")
        .monotonic_seq;
    let replay_update_seqs: Vec<u64> = records
        .iter()
        .filter(|record| {
            record.direction == WireDirection::AgentToPylon
                && record.method.as_deref() == Some(super::NOTIF_SESSION_UPDATE)
        })
        .map(|record| record.monotonic_seq)
        .collect();
    assert_eq!(
        replay_update_seqs.len(),
        2,
        "load 期间的 2 条 update 必须在 wire 上可见"
    );
    for seq in &replay_update_seqs {
        assert!(
            *seq > load_request_seq && *seq < load_response_seq,
            "replay update 必须落在 load 请求与响应边界之间（{load_request_seq} < {seq} < {load_response_seq}）"
        );
    }

    // typed lane：replay update 帧分类为 Replay（request id 绑定），ingress 序
    // 列严格递增，且落在 wire 边界之间。
    let mut replay_frames = Vec::new();
    while let Ok(Some(frame)) = tokio::time::timeout(Duration::from_millis(300), inbox.recv()).await
    {
        replay_frames.push(frame);
    }
    let classified: Vec<&crate::acp::ClassifiedMessage> = replay_frames
        .iter()
        .filter(|frame| frame.raw.method.as_deref() == Some(super::NOTIF_SESSION_UPDATE))
        .collect();
    assert_eq!(classified.len(), 2);
    for frame in classified {
        match frame.classification {
            crate::acp::ReplayClassification::Replay { request_id: id } => {
                assert_eq!(id, request_id, "replay 帧必须绑定本次 load 的 request id");
            }
            other => panic!("load 期间 update 必须分类为 Replay，got {other:?}"),
        }
        let ordinal = frame.wire_ordinal.expect("replay frame carries ordinal");
        assert!(
            ordinal > load_request_seq && ordinal < load_response_seq,
            "typed lane 与 raw lane 的序列必须可对齐"
        );
    }

    let _ = client.kill();
}
