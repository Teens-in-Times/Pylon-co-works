//! 权限请求路由缝（#317 批次二 ④ 自 mod.rs 主泵分支迁入）：B9 权限审批分支。
//! #416 W2 步骤①：`handle_permission_request` 正身（370 行）自 mod.rs 迁入，
//! `PermissionLock` 句柄别名随迁——本模块自足（委派层 → 自足模块）。
//! 带-id 请求走审批正身（P1-3：provider 每次从活配置解析）；
//! 缺-id 畸形请求走可观测拒绝。分支在主泵中为纯 `continue` 语义。
//! #486 项3：钩子缝与挂起登记面拆 `hooks.rs` / `admit.rs`（语句次序不变）。

mod admit;
mod hooks;

use super::interaction_route::{reject_interaction_request, resolve_agent_provider};
use super::{acp_snapshot, AcpLock, SessionsLock};
use crate::hook_bridge::HookBridge;
use crate::permission::{permission_response, pick_option};
use crate::runtime::AgentRuntimeManager;
use agent_client_protocol_schema::v1::ErrorCode as WireErrorCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// B9 权限审批（R8 自主循环拆分）：agent 主动 request_permission（带 id 请求，
/// 客户端必须应答）。C4/C5 语义保持：代复核（应答不误写新代进程）+ 模式判定
/// （bypass/auto 自动批准；edit/default 挂起 + 前端事件）。
/// P0-3（R2-WI03）：provider-scoped adapter dispatch——未注册 provider 明确
/// unsupported + runtime log 可观察，不生成 RPC；classify 非 interaction 同样丢弃。
/// 参数多为各锁/上下文的按引用透传，故保留显式形参。
#[allow(clippy::too_many_arguments)]
async fn handle_permission_request<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    client_generation: &AtomicU64,
    approval_mode: &std::sync::Mutex<String>,
    sessions: &SessionsLock,
    hook_bridge: &Arc<HookBridge>,
    runtimes: &AgentRuntimeManager,
    provider: &str,
    agent_id: &str,
    method: Option<&str>,
    request_id: crate::acp::RequestId,
    params: Option<&serde_json::Value>,
) {
    // #98: method-driven dispatch - adapter lookup by ACP method, provider name
    // no longer a gate; unknown methods get a stable method_unsupported with the
    // raw params kept observable via the rejection event.
    let Some(adapter) =
        crate::protocol_adapter::get_protocol_adapter_for_method(method.unwrap_or(""))
    else {
        reject_interaction_request(
            window,
            acp,
            provider,
            agent_id,
            method,
            Some(request_id),
            params,
            "method_unsupported",
            WireErrorCode::MethodNotFound,
            &format!(
                "interaction method unsupported: {}",
                method.unwrap_or("<missing>")
            ),
        )
        .await;
        return;
    };
    if adapter.classify(method) != crate::protocol_adapter::InteractionClassification::Interaction {
        reject_interaction_request(
            window,
            acp,
            provider,
            agent_id,
            method,
            Some(request_id),
            params,
            "method_unsupported",
            WireErrorCode::MethodNotFound,
            &format!(
                "interaction method unsupported: {}",
                method.unwrap_or("<missing>")
            ),
        )
        .await;
        return;
    }
    // C4：记录到达时 client_generation——应答时复核，客户端替换后
    // 旧进程同 id 请求不得被旧审批决策误写。
    let Some(permission) =
        adapter.normalize_request(params, client_generation.load(Ordering::Acquire))
    else {
        // ACP-04（§5.6）：解析失败 = protocol error，不是可 approve/reject 的 pending
        // permission——**不伪造 optionId**（旧实现按拒绝兜底回 reject_once，OBS-03
        // 已证实协议缺陷），按 ACP 标准发 JSON-RPC error（-32602 Invalid params），
        // 让 agent 按标准错误处理。未挂起 pending，无需清理。
        // O9/G3 §2.2.2：锁内只克隆发送句柄，锁外发送；同时发出独立拒绝事件，
        // 让前端能解释“为什么没有弹出权限卡”。
        reject_interaction_request(
            window,
            acp,
            provider,
            agent_id,
            method,
            Some(request_id),
            params,
            "invalid_params",
            WireErrorCode::InvalidParams,
            // Keep the stable diagnostic phrase used by the OBS-03 evidence
            // surface while retaining the machine-readable invalid_params
            // reason code and JSON-RPC -32602 response above.
            "ACP request_permission 解析失败: invalid params",
        )
        .await;
        return;
    };
    // Reducer ownership is resolved by the protocol session id, never by the
    // request id alone (request ids may be reused across sessions).
    let remember_permission = |sessions: &SessionsLock| {
        let _ = sessions.lock().map(|mut sessions| {
            if let Some(session) = sessions.get_mut(&permission.session_id) {
                // R-t5 续命：**等用户答复不算沉默**。本回合此前只有 `session/update` 刷新
                // `last_activity`，于是 agent 发出权限请求后静默等待用户点击的那段时间被当成
                // "无输出"，闲置窗口到点即判死——真机实测一次 `elapsed 472535ms` 的截断正卡在
                // 等权限答复上，并留下一个无法关闭的悬空模态（#209）。用户答复后 agent 恢复产出
                // 会自然续命，故只在**收到请求**这一刻打点。
                session.last_activity = Some(std::time::Instant::now());
                let deltas = session.acp_state.apply(&crate::acp::RawMessage {
                    id: Some(request_id.clone()),
                    method: Some("session/request_permission".into()),
                    kind: crate::acp::AcpKind::PermissionRequest,
                    result: None,
                    params: params.cloned(),
                    error: None,
                });
                if let Some(depth) = deltas.iter().find_map(|delta| match delta {
                    crate::acp::AcpStateDelta::PermissionQueueDepth { depth } => Some(*depth),
                    _ => None,
                }) {
                    tracing::trace!(
                        session_id = %permission.session_id,
                        request_id = %request_id,
                        depth,
                        "ACP permission reducer queue updated"
                    );
                }
            }
        });
    };
    let mode = approval_mode
        .lock()
        .map(|m| m.clone())
        .unwrap_or_else(|_| "default".to_string());
    let effective_permission = match hooks::dispatch_permission_hooks(
        window,
        acp,
        client_generation,
        hook_bridge,
        runtimes,
        provider,
        agent_id,
        &permission,
        &request_id,
    )
    .await
    {
        hooks::PermissionHookOutcome::Terminated => return,
        hooks::PermissionHookOutcome::Proceed {
            effective_permission,
        } => effective_permission,
    };
    if matches!(mode.as_str(), "bypass" | "auto") {
        tracing::info!(
            "权限模式 {mode}：自动批准工具调用 {}",
            permission.tool_call_id
        );
        // C5：自动批准按请求选项选 allow 语义项（无匹配取首个）。ACP-04（§5.6）：
        // 解析层保证 options 非空（空集不可能进此分支），pick_option 恒返回 Some；
        // 防御分支不得伪造 optionId——如异常出现则跳过应答并告警（agent 侧自会
        // 超时收敛），绝不硬编码不存在的选项。
        let Some(option_id) = pick_option(&effective_permission.options, false) else {
            tracing::error!(
                "权限模式 {mode}：请求 options 为空（不应发生），跳过自动批准应答，不伪造 optionId"
            );
            reject_interaction_request(
                window,
                acp,
                provider,
                agent_id,
                method,
                Some(request_id),
                params,
                "invalid_options",
                WireErrorCode::InvalidParams,
                "invalid params: permission request options 为空",
            )
            .await;
            return;
        };
        // O9/G3 §2.2.2：无 pending 直接应答——锁外发送（同解析失败分支）。
        let responder = { acp_snapshot(acp).responder() };
        responder
            .respond(request_id, permission_response(option_id))
            .await;
    } else {
        remember_permission(sessions);
        admit::admit_pending_permission(
            window,
            runtimes,
            provider,
            agent_id,
            &request_id,
            &effective_permission,
        );
    }
}

/// B9 权限审批：agent 主动 request_permission（带 id 请求，客户端必须应答）。
/// ACP-01：id 为原始 variant（number/string）——string-id agent 请求不再丢弃。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn route_permission_request<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    client_generation: &AtomicU64,
    approval_mode: &std::sync::Mutex<String>,
    sessions: &SessionsLock,
    hook_bridge: &Arc<HookBridge>,
    runtimes: &AgentRuntimeManager,
    agents: &std::sync::Mutex<std::collections::HashMap<String, crate::agent_config::AgentDef>>,
    agent_id: &str,
    raw: crate::acp::RawMessage,
) {
    if let Some(request_id) = raw.id {
        // P1-3：provider 每次请求时从活 agents 配置解析（reload 生效）。
        let provider = agents
            .lock()
            .ok()
            .and_then(|agents| resolve_agent_provider(&agents, agent_id))
            .unwrap_or_else(|| "unknown".to_string());
        handle_permission_request(
            window,
            acp,
            client_generation,
            approval_mode,
            sessions,
            hook_bridge,
            runtimes,
            &provider,
            agent_id,
            raw.method.as_deref(),
            request_id,
            raw.params.as_ref(),
        )
        .await;
    } else {
        // ACP-01：null/absent id 的 request_permission 是畸形协议请求——
        // 不静默当 0（不臆造 id 应答），记录并发出不可提交的拒绝事件。
        let provider = agents
            .lock()
            .ok()
            .and_then(|agents| resolve_agent_provider(&agents, agent_id))
            .unwrap_or_else(|| "unknown".to_string());
        reject_interaction_request(
            window,
            acp,
            &provider,
            agent_id,
            raw.method.as_deref(),
            None,
            raw.params.as_ref(),
            "missing_request_id",
            WireErrorCode::InvalidRequest,
            "invalid request: interaction request requires a JSON-RPC id",
        )
        .await;
    }
}
