//! 权限请求的钩子缝正身（#486 项3 自 handle_permission_request 拆出；行为不变）。
//!
//! API 1.3（#37）：先把 ACP 远端 sessionId 规范化为本地 source，再依次派发
//! tool.beforeCall（gate）与 permission.request（allow/deny/modify）。
//! 不可映射 = 可诊断跳过（fail-open 至常规审批流）；桥故障/超时/未注册不阻断。
//! modify 仅接受原选项的过滤/重排（interpret 侧校验），后续 bypass/auto 与
//! 前端事件均使用过滤后的选项集。

use super::super::{acp_snapshot, AcpLock};
use crate::hook_bridge::HookBridge;
use crate::permission::PendingPermission;
use crate::permission::{permission_response, pick_allow_option, pick_reject_option};
use crate::runtime::AgentRuntimeManager;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// 钩子缝结果：`Terminated` = 钩子已应答或决策被代际复核丢弃（调用方直接返回）；
/// `Proceed` = 走常规审批流（options 已按 modify 过滤/重排）。
pub(super) enum PermissionHookOutcome {
    Terminated,
    Proceed {
        effective_permission: PendingPermission,
    },
}

/// 依次派发 tool.beforeCall 与 permission.request。语句次序与拆分前逐字一致；
/// 各早退分支映射为 `Terminated`。
#[allow(clippy::too_many_arguments)]
pub(super) async fn dispatch_permission_hooks<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    client_generation: &AtomicU64,
    hook_bridge: &Arc<HookBridge>,
    runtimes: &AgentRuntimeManager,
    provider: &str,
    agent_id: &str,
    permission: &PendingPermission,
    request_id: &crate::acp::RequestId,
) -> PermissionHookOutcome {
    let mut effective_permission = permission.clone();
    if let Some(local_source) =
        crate::hook_bridge::resolve_local_source(runtimes, Some(agent_id), &permission.session_id)
    {
        let tool_payload = serde_json::json!({
            "source": local_source,
            "toolCallId": permission.tool_call_id,
            "title": permission.title,
            "prompt": permission.prompt,
            "options": permission.options,
        });
        if let crate::hook_bridge::HookDispatchOutcome::Answered(response) = hook_bridge
            .dispatch(
                Some(window),
                crate::hook_bridge::HOOK_TOOL_BEFORE_CALL,
                &local_source,
                tool_payload,
            )
            .await
        {
            if response.get("action").and_then(serde_json::Value::as_str) == Some("cancel") {
                let reason = response
                    .get("reason")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("denied by tool.beforeCall hook");
                tracing::info!(
                    source = %local_source,
                    tool_call_id = %permission.tool_call_id,
                    reason = %reason,
                    "tool.beforeCall hook denied tool call"
                );
                // 钩子驱动的拒绝用严格 reject 选择（无 first() 回退）：请求不含
                // reject 语义项时不伪造 optionId（ACP-04 §5.6），落回常规流程。
                if let Some(option_id) = pick_reject_option(&permission.options) {
                    if client_generation.load(Ordering::Acquire) != permission.client_generation {
                        // C4：钩子派发窗口（最长 ~3s）内客户端已换代——旧决策不得
                        // 写到新进程同 id 请求，丢弃应答交由 agent 侧超时收敛。
                        tracing::warn!(
                            request_id = %request_id,
                            "hook deny decision dropped: client generation advanced during hook dispatch"
                        );
                        return PermissionHookOutcome::Terminated;
                    }
                    let responder = { acp_snapshot(acp).responder() };
                    responder
                        .respond(request_id.clone(), permission_response(option_id))
                        .await;
                    return PermissionHookOutcome::Terminated;
                }
                tracing::warn!("tool.beforeCall 拒绝但请求无 reject 选项，跳过应答交回常规流程");
            }
        }
        let permission_payload = serde_json::json!({
            "source": local_source,
            "provider": provider,
            "agentId": agent_id,
            "requestId": request_id.to_string(),
            "toolCallId": permission.tool_call_id,
            "title": permission.title,
            "prompt": permission.prompt,
            "options": permission.options,
        });
        if let crate::hook_bridge::HookDispatchOutcome::Answered(response) = hook_bridge
            .dispatch(
                Some(window),
                crate::hook_bridge::HOOK_PERMISSION_REQUEST,
                &local_source,
                permission_payload,
            )
            .await
        {
            match crate::hook_bridge::interpret_permission_hook_response(
                &response,
                &permission.options,
            ) {
                crate::hook_bridge::PermissionHookDecision::Allow => {
                    // 钩子驱动的批准用严格 allow 选择 + C4 代际复核（同 deny 路径）。
                    if let Some(option_id) = pick_allow_option(&permission.options) {
                        if client_generation.load(Ordering::Acquire) != permission.client_generation
                        {
                            tracing::warn!(
                                request_id = %request_id,
                                "hook allow decision dropped: client generation advanced during hook dispatch"
                            );
                            return PermissionHookOutcome::Terminated;
                        }
                        let responder = { acp_snapshot(acp).responder() };
                        responder
                            .respond(request_id.clone(), permission_response(option_id))
                            .await;
                        return PermissionHookOutcome::Terminated;
                    }
                    tracing::warn!(
                        "permission.request 钩子允许但请求无 allow 语义项，跳过应答交回常规流程"
                    );
                }
                crate::hook_bridge::PermissionHookDecision::Deny => {
                    if let Some(option_id) = pick_reject_option(&permission.options) {
                        if client_generation.load(Ordering::Acquire) != permission.client_generation
                        {
                            tracing::warn!(
                                request_id = %request_id,
                                "hook deny decision dropped: client generation advanced during hook dispatch"
                            );
                            return PermissionHookOutcome::Terminated;
                        }
                        let responder = { acp_snapshot(acp).responder() };
                        responder
                            .respond(request_id.clone(), permission_response(option_id))
                            .await;
                        return PermissionHookOutcome::Terminated;
                    }
                    tracing::warn!(
                        "permission.request 钩子拒绝但请求无 reject 语义项，跳过应答交回常规流程"
                    );
                }
                crate::hook_bridge::PermissionHookDecision::Modify(options) => {
                    tracing::info!(
                        source = %local_source,
                        option_count = options.len(),
                        "permission.request hook modified permission options"
                    );
                    effective_permission.options = options;
                }
                crate::hook_bridge::PermissionHookDecision::Pass => {}
            }
        }
    } else {
        tracing::warn!(
            session_id = %permission.session_id,
            agent_id = %agent_id,
            request_id = %request_id,
            "Pylon hook bridge: permission request sessionId not mappable to a local session; hooks skipped"
        );
    }
    PermissionHookOutcome::Proceed {
        effective_permission,
    }
}
