//! 私有交互路由缝（#317 批次二 ④ 自 mod.rs 主泵分支迁入）：
//! elicitation/complete 收敛（#316）与 provider 私有方法桥接（grok/pi/elicitation，
//! #98/AC11）。两个分支在主泵中均为纯 `continue` 语义——所有路径都在本模块内终结。
//! #416 W2 步骤①：交互域共享 helper（`reject_interaction_request` 拒绝面 /
//! `match_pending_elicitation` 匹配 / `resolve_agent_provider` provider 解析）
//! 自 mod.rs 正身迁入，本模块自足。

use super::{acp_snapshot, AcpLock};
use crate::emit_event;
use crate::runtime::AgentRuntimeManager;
use agent_client_protocol_schema::v1::ErrorCode as WireErrorCode;

/// Reject an interaction request at the protocol boundary.  Every rejection is both
/// observable (a redacted Tauri event/runtime log) and, when the wire supplied an id,
/// answered with a JSON-RPC error so the provider cannot wait until its own timeout.
/// The helper intentionally accepts only summary fields; params are never emitted back
/// to the UI because interaction payloads may contain commands, paths, or credentials.
// clippy 2026-09-22：10 参均为独立拒绝摘要入参（window/acp/provider/agent_id/method/
// request_id/params/reason_code/rpc_code/message），语义互不分组，结构体重构收益低。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reject_interaction_request<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    provider: &str,
    agent_id: &str,
    method: Option<&str>,
    request_id: Option<crate::acp::RequestId>,
    params: Option<&serde_json::Value>,
    reason_code: &str,
    rpc_code: WireErrorCode,
    message: &str,
) {
    let request_id_text = request_id.as_ref().map(ToString::to_string);
    let response_sent = if let Some(id) = request_id {
        let responder = { acp_snapshot(acp).responder() };
        responder.respond_error(id, rpc_code, message).await
    } else {
        false
    };
    let session_id = params.and_then(|value| {
        value.as_object().and_then(|object| {
            object
                .get("sessionId")
                .or_else(|| object.get("session_id"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
    });
    tracing::warn!(
        provider,
        agent_id,
        method = ?method,
        request_id = ?request_id_text,
        reason_code,
        response_sent,
        "ACP interaction request rejected: {message}"
    );
    emit_event(
        window,
        crate::event_names::INTERACTION_REJECTED,
        serde_json::json!({
            "provider": provider,
            "agentId": agent_id,
            "sessionId": session_id,
            "requestId": request_id_text,
            "method": method,
            "reasonCode": reason_code,
            "message": message,
            "rpcCode": rpc_code,
            "responseSent": response_sent,
        }),
    );
}

/// #316：在私有交互快照中按 elicitationId 匹配挂起的 URL elicitation
/// （method 必须是 elicitation/create 且 params.elicitationId 相等）。纯函数
/// 便于测试（官方契约：未知/已完成 id 忽略）。
pub(crate) fn match_pending_elicitation(
    snapshot: &[(
        crate::acp::RequestId,
        crate::private_interaction::PendingPrivateInteraction,
    )],
    elicitation_id: &str,
) -> Option<(
    crate::acp::RequestId,
    crate::private_interaction::PendingPrivateInteraction,
)> {
    snapshot
        .iter()
        .find(|(_, pending)| {
            pending.method == "elicitation/create"
                && pending.params.get("elicitationId").and_then(|v| v.as_str())
                    == Some(elicitation_id)
        })
        .map(|(id, pending)| (id.clone(), pending.clone()))
}

/// P1-3（R2-WI03）：从活 agents 配置解析 agent 的 provider（reload 修改实例 provider
/// 后新请求即用新 provider，不再依赖 dispatcher 启动时捕获的快照）。
/// permission.rs 经 `crate::dispatcher::resolve_agent_provider` 再导出消费。
pub(crate) fn resolve_agent_provider(
    agents: &std::collections::HashMap<String, crate::agent_config::AgentDef>,
    agent_id: &str,
) -> Option<String> {
    agents
        .get(agent_id)
        .and_then(|agent| agent.provider.clone())
}

/// #316：elicitation/complete —— URL 模式外带交互完成通知（form 模式
/// 同步应答不产生本通知）。官方契约：客户端忽略未知/已完成 id。当前
/// 只做两件事：可观测日志 + 收敛匹配中的 pending elicitation 卡
/// （URL 模式 UI 本期不做，但队列里的挂起条目必须能被终态）。
pub(crate) async fn route_elicitation_complete<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    runtimes: &AgentRuntimeManager,
    agent_id: &str,
    params: Option<&serde_json::Value>,
) {
    let note = params.and_then(|params| {
        serde_json::from_value::<agent_client_protocol_schema::v1::CompleteElicitationNotification>(
            params.clone(),
        )
        .ok()
    });
    let Some(note) = note else {
        tracing::debug!("elicitation/complete unparseable; ignoring per spec");
        return;
    };
    let elicitation_id: &str = note.elicitation_id.0.as_ref();
    let Some(runtime) = runtimes.get(agent_id) else {
        tracing::debug!(elicitation_id, "elicitation/complete: no runtime; ignored");
        return;
    };
    let matched = match_pending_elicitation(&runtime.ledger.private().snapshot(), elicitation_id);
    if let Some((request_id, pending)) = matched {
        // P2-2（#316 审查）：take 成功（Some）才 settle+emit——
        // 并发 respond_interaction 抢先收口时不再发 spurious 事件。
        if runtime.ledger.take_private(&request_id).is_some() {
            let request_id_text = request_id.to_string();
            let _ = runtime.ledger.settle(
                &request_id_text,
                crate::acp::interaction_queue::InteractionTerminalReason::Answered,
            );
            emit_event(
                window,
                crate::event_names::INTERACTION,
                // #488 批⑤：收敛到 permission::resolved_interaction_payload 单一构造点
                //（原 elicitation 完成手拼变体；形状与其余终态来源同构）。
                crate::permission::resolved_interaction_payload(
                    crate::permission::ResolvedInteractionEvent::Interaction {
                        kind: "elicitation",
                    },
                    agent_id,
                    &pending.session_id,
                    &request_id_text,
                    pending.client_generation,
                    "completed",
                ),
            );
        }
    } else {
        tracing::debug!(
            elicitation_id,
            "elicitation/complete for unknown id; ignored per spec"
        );
    }
}

/// Providers may expose a new approval/question/oauth method before a
/// dedicated AcpKind/adapter exists.  Do not silently drop an identified
/// request: answer it with Method Not Found and surface a diagnostic event.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn route_private_interaction<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    agents: &std::sync::Mutex<std::collections::HashMap<String, crate::agent_config::AgentDef>>,
    runtimes: &AgentRuntimeManager,
    agent_id: &str,
    generation: u64,
    raw: crate::acp::RawMessage,
) {
    let provider = agents
        .lock()
        .ok()
        .and_then(|agents| resolve_agent_provider(&agents, agent_id))
        .unwrap_or_else(|| "unknown".to_string());
    let private_validation = raw.method.as_deref().map(|method| {
        crate::protocol_adapter::private_ext::validate_request(
            method,
            raw.params.as_ref().unwrap_or(&serde_json::Value::Null),
        )
    });
    if let (Some(request_id), Some(method), Ok(())) = (
        raw.id.clone(),
        raw.method.as_deref(),
        private_validation.clone().unwrap_or(Ok(())),
    ) {
        let bridge = match method {
            "_x.ai/ask_user_question" => {
                Some(crate::protocol_adapter::private_ext::PrivateBridge::GrokExtQuestions)
            }
            "pi/select_ask" => {
                Some(crate::protocol_adapter::private_ext::PrivateBridge::PiSelectAsk)
            }
            "_x.ai/exit_plan_mode" => {
                Some(crate::protocol_adapter::private_ext::PrivateBridge::GrokExitPlan)
            }
            // #98: elicitation/create generic protocol bridge - routed
            // by method name, no provider match required (AC11).
            "elicitation/create" => {
                Some(crate::protocol_adapter::private_ext::PrivateBridge::Elicitation)
            }
            _ => None,
        };
        if let Some(bridge) = bridge {
            let params = raw.params.clone().unwrap_or(serde_json::Value::Null);
            let question_specs = match bridge {
                crate::protocol_adapter::private_ext::PrivateBridge::GrokExtQuestions
                | crate::protocol_adapter::private_ext::PrivateBridge::PiSelectAsk => {
                    crate::protocol_adapter::private_ext::parse_questions(bridge, &params).ok()
                }
                crate::protocol_adapter::private_ext::PrivateBridge::GrokExitPlan
                | crate::protocol_adapter::private_ext::PrivateBridge::Elicitation => None,
            };
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            // #356：官方 CreateElicitationRequest 不含 sessionId——scope 可为
            // Request（会话外 auth/config 阶段 elicitation 合法）。空 sessionId
            // 时不再一律 fallthrough 到 -32601：elicitation 桥走 typed scope
            // 投影（Request → 空串入队；Session → 取回投影 id；解析失败 /
            // 显式空 sessionId → 参数类错误 fail-closed）。非 elicitation 桥
            // 维持 -32601（规格未授权其无会话形态）。
            enum Admission {
                /// 会话内（含投影出非空 id 的 Session scope）。
                Session(String),
                /// request-scoped elicitation（session_id 空串入队）。
                RequestScoped,
            }
            let admission = if !session_id.is_empty() {
                Some(Admission::Session(session_id))
            } else if bridge == crate::protocol_adapter::private_ext::PrivateBridge::Elicitation {
                match crate::protocol_adapter::private_ext::project_elicitation_scope(&params) {
                    Ok(
                        crate::protocol_adapter::private_ext::ElicitationScopeProjection::Session {
                            session_id,
                        },
                    ) => Some(Admission::Session(session_id)),
                    Ok(
                        crate::protocol_adapter::private_ext::ElicitationScopeProjection::Request,
                    ) => Some(Admission::RequestScoped),
                    Err(error) => {
                        reject_interaction_request(
                            window,
                            acp,
                            &provider,
                            agent_id,
                            raw.method.as_deref(),
                            raw.id,
                            raw.params.as_ref(),
                            "invalid_private_payload",
                            WireErrorCode::InvalidParams,
                            &error,
                        )
                        .await;
                        return;
                    }
                }
            } else {
                None
            };
            if let Some(admission) = admission {
                let admitted_session_id = match admission {
                    Admission::Session(session_id) => session_id,
                    Admission::RequestScoped => String::new(),
                };
                let pending = crate::private_interaction::PendingPrivateInteraction {
                    provider: provider.clone(),
                    agent_id: agent_id.to_string(),
                    session_id: admitted_session_id,
                    method: method.to_string(),
                    bridge,
                    params: params.clone(),
                    question_specs,
                    client_generation: generation,
                    enqueued_at: crate::time::Timestamp::now(),
                };
                // #423：登记面单点——store 写 + queue admit（deadline 注入 +
                // 问题桥 specs id 回写事件 payload）+ 事件 json 一次完成
                //（#98: unified interaction queue admission——drain 终态与冷挂载
                // 快照数据源）。
                if let Some(runtime) = runtimes.get(agent_id) {
                    match runtime.ledger.admit_private(
                        &provider,
                        agent_id,
                        &request_id,
                        &pending,
                        method,
                    ) {
                        Ok((_, interaction_event)) => {
                            emit_event(window, crate::event_names::INTERACTION, interaction_event);
                        }
                        Err(error) => {
                            tracing::warn!("interaction queue admit failed: {error}");
                        }
                    }
                } else {
                    // runtime 缺席（结构性不可达）——整体不登记（store 与 queue
                    // 恒一致，杜绝单边写入）。
                    tracing::warn!(
                        agent_id = %agent_id,
                        request_id = %request_id,
                        "private interaction admit skipped: runtime not found"
                    );
                }
                return;
            }
        }
    }
    // A request-shaped interaction without an id cannot receive a
    // JSON-RPC response, but it is still surfaced as a malformed
    // interaction so the UI/runtime log explains why no card can
    // be acted on.  Do not silently drop official client requests.
    let (reason_code, rpc_code, message) = if let Some(Err(error)) = private_validation {
        (
            "invalid_private_payload",
            WireErrorCode::InvalidParams,
            format!("invalid private interaction payload: {error}"),
        )
    } else if raw.id.is_none() {
        (
            "missing_request_id",
            WireErrorCode::InvalidRequest,
            "invalid request: interaction request requires a JSON-RPC id".to_string(),
        )
    } else {
        // #98: provider name is no longer a dispatch gate - unknown
        // client requests report a stable method-level unsupported
        // (raw diagnostics kept on the rejection event).
        let reason = "method_unsupported";
        (
            reason,
            WireErrorCode::MethodNotFound,
            format!(
                "interaction {} unsupported",
                raw.method.as_deref().unwrap_or("method")
            ),
        )
    };
    reject_interaction_request(
        window,
        acp,
        &provider,
        agent_id,
        raw.method.as_deref(),
        raw.id,
        raw.params.as_ref(),
        reason_code,
        rpc_code,
        &message,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::RawMessage;
    use crate::private_interaction::PendingPrivateInteraction;
    use crate::runtime::AgentRuntime;
    use std::collections::HashMap;

    /// mock 窗口 + INTERACTION/INTERACTION_REJECTED 事件捕获（与 test_harness
    /// boot 同源监听形态），返回 (window, webview, 事件接收端)。webview 与 app
    /// 必须在被调方存活期间留在作用域内。
    fn mock_window_with_events() -> (
        tauri::Window<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
        tauri::App<tauri::test::MockRuntime>,
        std::sync::mpsc::Receiver<serde_json::Value>,
    ) {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock webview must build");
        let (tx, rx) = std::sync::mpsc::channel();
        for event in [
            crate::event_names::INTERACTION,
            crate::event_names::INTERACTION_REJECTED,
        ] {
            let tx = tx.clone();
            let _ = tauri::Listener::listen(&webview, event, move |e| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                    let _ = tx.send(payload);
                }
            });
        }
        let window = webview.as_ref().window();
        (window, webview, app, rx)
    }

    fn elicitation_request(id: u64, params: serde_json::Value) -> RawMessage {
        RawMessage {
            id: Some(crate::acp::RequestId::Number(id)),
            method: Some("elicitation/create".to_string()),
            kind: crate::acp::AcpKind::from_method(Some("elicitation/create")),
            result: None,
            params: Some(params),
            error: None,
        }
    }

    fn raw_request(id: u64, method: &str, params: serde_json::Value) -> RawMessage {
        RawMessage {
            id: Some(crate::acp::RequestId::Number(id)),
            method: Some(method.to_string()),
            kind: crate::acp::AcpKind::from_method(Some(method)),
            result: None,
            params: Some(params),
            error: None,
        }
    }

    fn empty_agents() -> std::sync::Mutex<HashMap<String, crate::agent_config::AgentDef>> {
        std::sync::Mutex::new(HashMap::new())
    }

    /// #356：request-scoped elicitation（无 sessionId、官方 scope 为
    /// `ElicitationRequestScope{requestId}`）必须入桥入队——store 条目
    /// session_id 为空串、事件 sessionId 为显式空串、eventType elicitation.request。
    /// （#349 B2 回退期本用例断言 -32601 拒绝，是该回归注释预告的完整修法。）
    #[tokio::test]
    async fn request_scoped_elicitation_is_admitted_with_empty_session() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        runtimes.insert("a1".to_string(), runtime.clone());
        let raw = elicitation_request(
            7,
            serde_json::json!({
                "mode": "form",
                "message": "auth configuration needed",
                "requestedSchema": {"type": "object"},
                "requestId": 7
            }),
        );
        route_private_interaction(&window, &runtime.acp, &agents, &runtimes, "a1", 3, raw).await;
        let snapshot = runtime.ledger.private().snapshot();
        assert_eq!(
            snapshot.len(),
            1,
            "request-scoped elicitation must be enqueued"
        );
        assert_eq!(
            snapshot[0].1.session_id, "",
            "request-scoped elicitation carries an empty session_id"
        );
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("interaction event must be emitted");
        assert_eq!(event["eventType"], "elicitation.request");
        assert_eq!(event["sessionId"], "");
        assert_eq!(event["requestId"], "7");
    }

    /// #356：无 sessionId 且官方 scope 也无法解析（既无 sessionId 也无
    /// requestId 等）= 参数缺失，按 invalid_private_payload / -32602 拒绝，
    /// 不入队。
    #[tokio::test]
    async fn elicitation_without_any_scope_is_rejected_invalid_params() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        runtimes.insert("a1".to_string(), runtime.clone());
        let raw = elicitation_request(
            7,
            serde_json::json!({
                "mode": "form",
                "message": "auth configuration needed",
                "requestedSchema": {"type": "object"}
            }),
        );
        route_private_interaction(&window, &runtime.acp, &agents, &runtimes, "a1", 3, raw).await;
        assert!(
            runtime.ledger.private().snapshot().is_empty(),
            "scope-less elicitation must not be enqueued"
        );
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("rejection event must be emitted");
        assert_eq!(event["reasonCode"], "invalid_private_payload");
        assert_eq!(event["rpcCode"], -32602);
    }

    /// #356：显式 `"sessionId": ""` 的 Session scope 不得入队（fail-closed）——
    /// 空串在前后端三道门均当缺失，入队只会让 agent 挂等一个永不来的响应。
    #[tokio::test]
    async fn elicitation_with_explicit_empty_session_id_is_rejected_invalid_params() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        runtimes.insert("a1".to_string(), runtime.clone());
        let raw = elicitation_request(
            7,
            serde_json::json!({
                "mode": "form",
                "sessionId": "",
                "message": "auth configuration needed",
                "requestedSchema": {"type": "object"}
            }),
        );
        route_private_interaction(&window, &runtime.acp, &agents, &runtimes, "a1", 3, raw).await;
        assert!(
            runtime.ledger.private().snapshot().is_empty(),
            "empty-string session scope must not be enqueued"
        );
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("rejection event must be emitted");
        assert_eq!(event["reasonCode"], "invalid_private_payload");
        assert_eq!(event["rpcCode"], -32602);
    }

    /// 回归（#349 B2 回退）：非 elicitation 桥（grok/pi/exit_plan）+ 空
    /// sessionId 同样必须落 -32601——准入宽化曾让这些桥在 sessionId 缺失
    /// 时也入队（规格未授权），回退后恢复既有守卫。
    #[tokio::test]
    async fn non_elicitation_bridge_without_session_id_is_rejected_method_not_found() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        runtimes.insert("a1".to_string(), runtime.clone());
        let raw = raw_request(
            11,
            "_x.ai/ask_user_question",
            serde_json::json!({
                "questions": [{
                    "question": "Pick",
                    "header": "Choice",
                    "options": [{"label": "A"}, {"label": "B"}]
                }]
            }),
        );
        route_private_interaction(&window, &runtime.acp, &agents, &runtimes, "a1", 3, raw).await;
        assert!(
            runtime.ledger.private().snapshot().is_empty(),
            "sessionless ask-user must not be enqueued"
        );
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("rejection event must be emitted");
        assert_eq!(event["reasonCode"], "method_unsupported");
        assert_eq!(event["rpcCode"], -32601);
    }

    /// 回归守卫：session-scoped elicitation（带 sessionId）正常入桥入队。
    #[tokio::test]
    async fn session_scoped_elicitation_keeps_session_id_projection() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        runtimes.insert("a1".to_string(), runtime.clone());
        let raw = elicitation_request(
            8,
            serde_json::json!({
                "sessionId": "peri-s1",
                "message": "pick one",
                "requestedSchema": {"type": "object"}
            }),
        );
        route_private_interaction(&window, &runtime.acp, &agents, &runtimes, "a1", 3, raw).await;
        let snapshot = runtime.ledger.private().snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].1.session_id, "peri-s1");
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("interaction event must be emitted");
        assert_eq!(event["sessionId"], "peri-s1");
    }

    /// #349 B2：未广告的 `mode:"url"` 必须按参数类错误拒绝
    /// （invalid_private_payload / -32602），不伪造入队。
    #[tokio::test]
    async fn unadvertised_url_mode_is_rejected_as_invalid_params() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        runtimes.insert("a1".to_string(), runtime.clone());
        let raw = elicitation_request(
            9,
            serde_json::json!({
                "sessionId": "peri-s1",
                "mode": "url",
                "elicitationId": "el-1",
                "url": "https://example.com/auth"
            }),
        );
        route_private_interaction(&window, &runtime.acp, &agents, &runtimes, "a1", 3, raw).await;
        assert!(
            runtime.ledger.private().snapshot().is_empty(),
            "url-mode elicitation must not be enqueued"
        );
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("rejection event must be emitted");
        assert_eq!(event["reasonCode"], "invalid_private_payload");
        assert_eq!(event["rpcCode"], -32602);
    }

    // ── 共享 helper characterization（#416 W2 步骤①随正身迁入）──

    fn pending_elicitation(elicitation_id: &str) -> PendingPrivateInteraction {
        PendingPrivateInteraction {
            provider: "peri".into(),
            agent_id: "a1".into(),
            session_id: "peri-s1".into(),
            method: "elicitation/create".into(),
            bridge: crate::protocol_adapter::private_ext::PrivateBridge::Elicitation,
            params: serde_json::json!({
                "sessionId": "peri-s1",
                "elicitationId": elicitation_id,
                "url": "https://example.com/auth",
                "message": "完成登录",
            }),
            question_specs: None,
            client_generation: 1,
            enqueued_at: crate::time::Timestamp::now(),
        }
    }

    /// #316：elicitation/complete 按 elicitationId 匹配 pending 私有交互。
    #[test]
    fn match_pending_elicitation_finds_only_exact_id_and_method() {
        let a = crate::acp::RequestId::Number(11);
        let b = crate::acp::RequestId::Number(12);
        let snapshot = vec![
            (a, pending_elicitation("el-1")),
            (b.clone(), pending_elicitation("el-2")),
        ];
        let (hit, pending) = match_pending_elicitation(&snapshot, "el-2").expect("el-2 必须命中");
        assert_eq!(hit, b);
        assert_eq!(pending.session_id, "peri-s1");
        // 未知 id → None（官方契约：忽略）
        assert!(match_pending_elicitation(&snapshot, "el-404").is_none());
    }

    #[test]
    fn match_pending_elicitation_ignores_other_methods_and_malformed_params() {
        let mut other_method = pending_elicitation("el-1");
        other_method.method = "session/request_permission".into();
        let mut malformed = pending_elicitation("el-1");
        malformed.params = serde_json::json!({"message": "form 模式无 elicitationId"});
        let snapshot = vec![
            (crate::acp::RequestId::Number(21), other_method),
            (crate::acp::RequestId::Number(22), malformed),
        ];
        assert!(
            match_pending_elicitation(&snapshot, "el-1").is_none(),
            "方法不符或缺 elicitationId 的条目不得命中"
        );
    }

    #[test]
    fn runtime_store_roundtrip_supports_complete_matching() {
        let runtime = crate::test_utils::connected_runtime();
        let request_id = crate::acp::RequestId::Number(31);
        runtime
            .ledger
            .private()
            .insert(request_id.clone(), pending_elicitation("el-9"))
            .expect("insert 必须成功");
        let matched = match_pending_elicitation(&runtime.ledger.private().snapshot(), "el-9")
            .expect("inserted pending must match");
        assert_eq!(matched.0, request_id);
        assert!(
            runtime
                .ledger
                .private()
                .take(&request_id)
                .map(|taken| taken.is_some())
                .unwrap_or(false),
            "take 成功才 settle+emit（P2-2 守卫的数据前提）"
        );
        assert!(match_pending_elicitation(&runtime.ledger.private().snapshot(), "el-9").is_none());
    }

    /// P1-3（R2-WI03）：provider 从活配置解析——reload 修改实例 provider 后立即生效。
    #[test]
    fn resolve_agent_provider_follows_live_config() {
        use std::collections::HashMap;
        let mut agents = HashMap::new();
        let mut peri = crate::test_utils::fake_acp_agent_stub("peri");
        peri.provider = Some("peri".to_string());
        agents.insert("peri-copy".to_string(), peri);
        assert_eq!(
            resolve_agent_provider(&agents, "peri-copy").as_deref(),
            Some("peri"),
            "活配置解析 provider"
        );
        // reload 把该实例 provider 改为 hermes → 新请求即用新 provider
        let mut reloaded = crate::test_utils::fake_acp_agent_stub("peri");
        reloaded.provider = Some("hermes".to_string());
        agents.insert("peri-copy".to_string(), reloaded);
        assert_eq!(
            resolve_agent_provider(&agents, "peri-copy").as_deref(),
            Some("hermes"),
            "reload 后 provider 变更必须生效"
        );
        assert_eq!(
            resolve_agent_provider(&agents, "missing"),
            None,
            "未知 agent 无 provider"
        );
    }
}
