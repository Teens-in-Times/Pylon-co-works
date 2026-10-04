//! B9 权限审批：挂起请求解析/应答/超时（R1 拆分自 lib.rs；行为零变化）。
//! ACP-01：挂起键从 `u64` 升级为 [`RequestId`]（number/string 原始形态），
//! 响应 id 用原始 variant 回写。
//! ACP-02：options 从 `Vec<String>` 升级为 [`PermissionOption`]（typed wire），
//! kind/name 宽容保留、optionId 原值不正规化（§5.5）。

use pylon_foundations::await_guard::HeldAcrossAwait;
use std::collections::HashMap;
use std::sync::atomic::Ordering;

use crate::acp::RequestId;
use crate::dispatcher::resolve_agent_provider;
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::time::Timestamp;
use crate::AppState;

// #416 W2 wave2 步骤 5（§4.4.4 第一步）：request_permission 的 wire 纯函数
// （parse/build 正身与 PendingPermission/PermissionOption 类型）已下沉引擎
// crate `pylon-acp/src/adapter/permission_wire.rs`——本模块经 `pub(crate) use`
// 再导出，全部既有 `crate::permission::` 消费路径不变（脱敏/时间戳经
// pylon-foundations 同一实现，逐字节同行为）。
pub(crate) use pylon_acp::adapter::permission_wire::{
    parse_permission_request_with_generation, permission_response, permission_response_cancelled,
    PendingPermission, PermissionOption,
};

/// 挂起的权限请求超时（B9.2：超时默认拒绝）。
const PERMISSION_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 兼容入口（仅 lib.rs 测试调用，无 runtime 上下文）：client_generation 置 0——
/// 生产路径（dispatcher）必须走 [`parse_permission_request_with_generation`]。
#[cfg(test)]
pub(crate) fn parse_permission_request(
    params: Option<&serde_json::Value>,
) -> Option<PendingPermission> {
    parse_permission_request_with_generation(params, 0)
}

/// C5：按请求提供选项选择应答 option_id（协议合规）——自动批准/超时默认拒绝不再
/// 硬编码 allow_once/reject_once，而是优先命中语义选项，否则取首个可用项。
/// 语义匹配（忽略大小写）作用于 option_id 与 kind（Hermes 兼容：kind=reject_once
/// 是语义类别）；**返回值永远是 option_id 原值**——kind 只参与选择不参与应答。
/// 语义优先级：
/// - prefer_reject（超时默认拒绝）：`reject_once` → 前缀 `reject` → 首个
/// - prefer_reject=false（自动批准）：`allow_once` → 首个
///
/// 无选项返回 None——调用方（dispatcher auto/bypass 分支与 check_pending_permission_timeouts
/// 超时默认拒绝路径）视为防御异常：跳过应答并告警（ACP-04 §5.6：绝不伪造 optionId，
/// 旧实现 unwrap_or("reject_once") 的伪造路径已移除；解析层保证 pending 恒非空）。
pub(crate) fn pick_option(options: &[PermissionOption], prefer_reject: bool) -> Option<&str> {
    let semantic = |option: &PermissionOption, needle: &str, prefix: bool| {
        std::iter::once(option.option_id.as_str())
            .chain(option.kind.iter().map(String::as_str))
            .any(|value| {
                // 语义归一：去下划线后比较——Hermes kind 用 camelCase（allowOnce/rejectOnce），
                // option_id 用 snake_case（allow_once/reject_once），视为同义。
                let value = value.to_ascii_lowercase().replace('_', "");
                let needle = needle.replace('_', "");
                if prefix {
                    value.starts_with(&needle)
                } else {
                    value == needle
                }
            })
    };
    let chosen = if prefer_reject {
        options
            .iter()
            .find(|option| semantic(option, "reject_once", false))
            .or_else(|| {
                options
                    .iter()
                    .find(|option| semantic(option, "reject", true))
            })
    } else {
        options
            .iter()
            .find(|option| semantic(option, "allow_once", false))
    }
    .or_else(|| options.first());
    // 返回值永远是 option_id 原值（kind 只参与选择不参与应答）。
    chosen.map(|option| option.option_id.as_str())
}

/// 严格 reject 选择：只匹配 reject_once / reject 前缀语义，**绝无 first() 回退**。
/// 供钩子驱动的拒绝路径（tool.beforeCall cancel / permission.request Deny）使用：
/// 请求不含 reject 语义选项时返回 None，调用方不得伪造应答、应交回常规流程
/// （对比 [`pick_option`] 的 first() 回退——那是超时/自动批准场景的既定约定，
/// 不适用于「钩子显式拒绝」：对一个 deny gate 回答 allow 语义项是 fail-open 缺陷）。
pub(crate) fn pick_reject_option(options: &[PermissionOption]) -> Option<&str> {
    let semantic = |option: &PermissionOption, needle: &str, prefix: bool| {
        std::iter::once(option.option_id.as_str())
            .chain(option.kind.iter().map(String::as_str))
            .any(|value| {
                let value = value.to_ascii_lowercase().replace('_', "");
                let needle = needle.replace('_', "");
                if prefix {
                    value.starts_with(&needle)
                } else {
                    value == needle
                }
            })
    };
    options
        .iter()
        .find(|option| semantic(option, "reject_once", false))
        .or_else(|| {
            options
                .iter()
                .find(|option| semantic(option, "reject", true))
        })
        .map(|option| option.option_id.as_str())
}

/// 严格 allow 选择（钩子驱动的批准路径）：只匹配 allow 前缀语义
/// （allow_once / allow_always），无 first() 回退——理由同 [`pick_reject_option`]。
pub(crate) fn pick_allow_option(options: &[PermissionOption]) -> Option<&str> {
    let semantic = |option: &PermissionOption, needle: &str, prefix: bool| {
        std::iter::once(option.option_id.as_str())
            .chain(option.kind.iter().map(String::as_str))
            .any(|value| {
                let value = value.to_ascii_lowercase().replace('_', "");
                let needle = needle.replace('_', "");
                if prefix {
                    value.starts_with(&needle)
                } else {
                    value == needle
                }
            })
    };
    options
        .iter()
        .find(|option| semantic(option, "allow", true))
        .map(|option| option.option_id.as_str())
}

/// 单临界区（P1-2 TOCTOU 修复）：acp 锁内查条目 + C4 generation 校验 +
/// tool_call_id 校验 + 选项校验 + claim；锁外发送（O9：10s 超时，语义对齐
/// acp::send_line），不再持 acp 锁 await。客户端替换（replace_agent_client）
/// 在 acp 锁内清空 pending——复核与 claim 同锁，替换瞬间旧审批决策不会写到
/// 新进程同 id 请求。
///
/// 参数：
/// - `expected_tool_call_id`：Some 时要求条目 tool_call_id 一致（cancel 路径按
///   收集时的原 id 校验，防同 id 被新工具调用复用后误 cancel）。
/// - `option_id`：空串 = Cancelled 应答（cancel/close 路径，无选项概念）；
///   非空必须 ∈ 条目的 options（C5 选项契约）。
///
/// 返回 true = 已应答并移除；false = 任一校验失败（跳过）或发送失败
/// （恢复 pending 供重试/超时/客户端替换清理）。
/// ACP-01（CR-001 修正）：候选 id → pending 规范键（resolve_pending / protocol_adapter
/// 共用）。精确命中优先；跨形态回退**双向**（CR-002）——Number 候选未命中回退 String
/// 形态（前端把 requestId 以字符串回显——原 numeric 请求以 "7" 回显，不能丢）；
/// String 候选未命中时若可解析为数字则回退 Number 形态（approve_tool_call 以字符串
/// 调用 numeric 请求）。两者并存时优先精确候选；均未命中返回 None。
pub(crate) fn canonical_pending_key(
    pending: &HashMap<RequestId, crate::permission::PendingPermission>,
    candidate: &RequestId,
) -> Option<RequestId> {
    if pending.contains_key(candidate) {
        return Some(candidate.clone());
    }
    match candidate {
        RequestId::Number(n) => {
            let alt = RequestId::String(n.to_string());
            if pending.contains_key(&alt) {
                return Some(alt);
            }
        }
        RequestId::String(s) => {
            if let Ok(n) = s.parse::<u64>() {
                let alt = RequestId::Number(n);
                if pending.contains_key(&alt) {
                    return Some(alt);
                }
            }
        }
    }
    None
}

async fn resolve_pending(
    runtime: &AgentRuntime,
    request_id: RequestId,
    expected_tool_call_id: Option<&str>,
    option_id: &str,
) -> bool {
    // 快照复核 + 取 responder 克隆 + claim（发送全部在锁外）。
    // #423：复核谓词与移除收进 Ledger 单临界区（canonical 键 + C4 generation
    // + tool_call_id + 选项契约，通过才 remove）。
    // #549/ADR-0037：身份复核以快照客户端自带代际为准——应答只会写进被解析的
    // 这一连接，替换后旧连接死亡，不会误写新进程同 id 请求。
    let (responder, claimed, canonical_id) = {
        let acp = runtime.snapshot_acp();
        let current_generation = acp.client_generation();
        let Some((canonical_id, permission)) =
            runtime.ledger.claim_permission(&request_id, |permission| {
                // C4：身份复核——客户端替换（generation 前进）后不误写新进程同 id 请求。
                if permission.client_generation != current_generation {
                    return false;
                }
                // tool_call_id 复核（cancel 路径用）。
                if let Some(expected) = expected_tool_call_id {
                    if permission.tool_call_id != expected {
                        return false;
                    }
                }
                // C5 选项契约：空 option_id = Cancelled；非空必须 ∈ options（option_id 原值）。
                if option_id.is_empty() {
                    true
                } else {
                    permission
                        .options
                        .iter()
                        .any(|option| option.option_id == option_id)
                }
            })
        else {
            return false;
        };
        (acp.responder(), permission, canonical_id)
    };
    // 锁外发送（G3 §2.2.2 收敛）：构造应答 → send_agent_response（信封 + 序列化 +
    // 10s 超时 + crashed 预检/置位）。失败恢复 pending（保留可重试）；原 :190-194
    // 的 crashed 预检分支自然落入 helper 返回 false → restore，行为一致。
    let outcome = if option_id.is_empty() {
        permission_response_cancelled()
    } else {
        permission_response(option_id)
    };
    if !responder.respond(canonical_id.clone(), outcome).await {
        runtime.ledger.restore_permission(&canonical_id, claimed);
        return false;
    }
    // #98：统一交互队列终态——成功送达即 settle（Answered/Cancelled）并晋升
    // 下一个 waiter（FIFO single-visible）。发送失败路径不入队终态（保留可重试）。
    let _ = runtime.ledger.settle(
        &canonical_id.to_string(),
        if option_id.is_empty() {
            crate::acp::interaction_queue::InteractionTerminalReason::Cancelled
        } else {
            crate::acp::interaction_queue::InteractionTerminalReason::Answered
        },
    );
    // The pending entry carries the only reliable session binding.  Update the
    // reducer only after the wire response commits, so a failed send remains
    // retryable and cannot prematurely drain state.
    {
        let permission = &claimed;
        if let Ok(mut sessions) = runtime.sessions.lock() {
            if let Some(session) = sessions.get_mut(&permission.session_id) {
                let _ = session
                    .acp_state
                    .resolve_permission(&canonical_id.to_string());
            }
        }
    }
    true
}

/// 应答并移除指定 session 的全部挂起权限请求（Cancelled）——cancel/close 路径调用。
/// （发送失败恢复已 claim 条目的语义收口在 `InteractionLedger::restore_permission`
/// 单点：O9 重试保留 + #98 P2-1 队列回灌 + provider/agentId 置空串的事件重建。）
pub(crate) async fn respond_pending_permissions_cancelled(
    runtime: &AgentRuntime,
    session_id: &str,
) {
    let pending: Vec<(RequestId, String)> = runtime
        .ledger
        .permissions()
        .lock()
        .map(|pending| {
            pending
                .iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(id, p)| (id.clone(), p.tool_call_id.clone()))
                .collect()
        })
        .unwrap_or_default();
    for (request_id, tool_call_id) in pending {
        // R34：统一走 resolve_pending（锁内复核身份 + tool_call_id，锁外发送）；
        // 空 option_id = Cancelled 应答。校验/发送失败时保留 pending（进程已死
        // 则由崩溃处理/客户端替换清理，不向新进程误写）。
        let _ = resolve_pending(runtime, request_id, Some(&tool_call_id), "").await;
    }
    // #98（P1-3 评审修复）：session close/expiry 的 drain 必须覆盖全部 waiter——
    // elicitation/ask-user 等非 approval 条目不经 resolve_pending，若不在此
    // 终结会滞留队列并被冷挂载快照复活成死交互（spec §6：cancel 必须 drain
    // 并给每个 waiter 一个终态）。
    let _ = runtime.ledger.drain_where_session(
        session_id,
        crate::acp::interaction_queue::InteractionTerminalReason::Cancelled,
    );
}

/// 应答挂起的权限请求（B9.4 契约）：option_id 必须是请求提供的选项之一。
/// 拒绝走同一命令（option_id = "reject_once" 等）。返回 Err = 未找到/选项非法/
/// 身份不匹配（C4）/发送失败。
/// R34：统一收敛到 resolve_pending——单一临界区（锁内查条目 + 校验选项 +
/// C4 generation 校验 + claim）+ 锁外发送（O9/O36 合并落点）。
pub(crate) async fn resolve_permission(
    runtime: &AgentRuntime,
    request_id: RequestId,
    option_id: &str,
) -> Result<(), PylonError> {
    if !resolve_pending(runtime, request_id.clone(), None, option_id).await {
        return Err(PylonError::Protocol(format!(
            "permission request not found: {request_id}"
        )));
    }
    tracing::info!("权限请求 {request_id} 已应答 {option_id}");
    Ok(())
}

/// 应答挂起的权限请求（命令入口，跨 runtime 定位）。
/// ACP-01：request_id 接受 number 或 string（untagged 反序列化），兼容新旧前端。
#[tauri::command]
pub(crate) async fn approve_tool_call(
    state: tauri::State<'_, AppState>,
    request_id: RequestId,
    option_id: String,
) -> Result<(), PylonError> {
    for runtime in state.inner().runtimes.all() {
        if resolve_permission(&runtime, request_id.clone(), &option_id)
            .await
            .is_ok()
        {
            return Ok(());
        }
    }
    Err(PylonError::Protocol(format!(
        "permission request not found: {request_id}"
    )))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionIdentityInput {
    pub provider: String,
    pub agent_id: String,
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: Option<String>,
    pub client_generation: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionAnswerInput {
    pub option_id: Option<String>,
    pub text: Option<String>,
    pub values: Option<serde_json::Value>,
}

/// 统一 Interaction response transport 的后端入口。
/// P0-3（R2-WI03）：协议适配器 dispatch。#98：私有桥/elicitation 先按
/// request id 路由（方法驱动，不要求 provider 名称匹配）；兜底路径按
/// method 查适配器（注册面是 method 表 per-provider 槽，#424——诊断投影
/// 自同表派生）——未注册 provider 的合法 ACP 交互不再被拒。
#[tauri::command]
pub(crate) async fn respond_interaction(
    state: tauri::State<'_, AppState>,
    identity: InteractionIdentityInput,
    kind: String,
    answer: InteractionAnswerInput,
) -> Result<(), PylonError> {
    let runtime = state.runtimes.get(&identity.agent_id).ok_or_else(|| {
        PylonError::Protocol(format!("agent runtime not found: {}", identity.agent_id))
    })?;
    let request_id = crate::acp::RequestId::from_echo_string(&identity.request_id);
    if let Some(pending) = runtime.ledger.private().get(&request_id).ok().flatten() {
        if pending.session_id != identity.session_id
            || pending.provider != identity.provider
            || pending.agent_id != identity.agent_id
            || pending.method.is_empty()
            || pending.client_generation != identity.client_generation
        {
            return Err(PylonError::Protocol("stale interaction identity".into()));
        }
        let response = match pending.bridge {
            crate::protocol_adapter::private_ext::PrivateBridge::GrokExtQuestions
            | crate::protocol_adapter::private_ext::PrivateBridge::PiSelectAsk => {
                let questions = pending.question_specs.ok_or_else(|| {
                    PylonError::Protocol("private question request lost validated specs".into())
                })?;
                let values = answer.values.clone().unwrap_or_default();
                let answers = questions
                    .iter()
                    .filter_map(|spec| {
                        values.get(&spec.id).map(|value| {
                            let labels = match value {
                                serde_json::Value::String(label) => vec![label.clone()],
                                serde_json::Value::Array(items) => items
                                    .iter()
                                    .filter_map(|item| item.as_str().map(str::to_owned))
                                    .collect(),
                                _ => Vec::new(),
                            };
                            crate::acp::question_policy::QuestionAnswerItem {
                                question_id: spec.id.clone(),
                                labels,
                            }
                        })
                    })
                    .collect();
                let answer = crate::acp::question_policy::QuestionAnswer {
                    answers,
                    declined: answer.option_id.as_deref() == Some("declined"),
                };
                crate::protocol_adapter::private_ext::build_question_response(
                    pending.bridge,
                    &questions,
                    &answer,
                )
                .map_err(PylonError::Protocol)?
            }
            crate::protocol_adapter::private_ext::PrivateBridge::GrokExitPlan => {
                let _ = crate::protocol_adapter::private_ext::parse_exit_plan(
                    pending.bridge,
                    &pending.params,
                )
                .map_err(PylonError::Protocol)?;
                crate::acp::plan_policy::approval_response(
                    answer.option_id.as_deref().unwrap_or("keep_planning"),
                    answer.text.as_deref().unwrap_or(""),
                )
            }
            crate::protocol_adapter::private_ext::PrivateBridge::Elicitation => {
                // #98：elicitation 应答 = ESM 风格 action 三值。decline/cancel
                // 由前端 optionId 表达；accept 携带 values/text 原样 content。
                // P2-3（评审修复）：optionId 白名单 fail-closed——未知值显式
                // 报错而非静默 accept（不伪造成功）。缺省 optionId + values/text
                // = 自由作答（accept）。
                let action = match answer.option_id.as_deref() {
                    None | Some("accept") => "accept",
                    Some("declined") => "decline",
                    Some("cancel") => "cancel",
                    Some(other) => {
                        return Err(PylonError::Protocol(format!(
                            "elicitation action unsupported: {other}"
                        )))
                    }
                };
                let content = match (&answer.values, &answer.text) {
                    (Some(values), _) if values.is_object() => Some(values.clone()),
                    (None, Some(text)) if !text.is_empty() => {
                        Some(serde_json::json!({ "text": text }))
                    }
                    _ => None,
                };
                crate::protocol_adapter::private_ext::build_elicitation_response(
                    action,
                    content.as_ref(),
                )
                .map_err(PylonError::Protocol)?
            }
        };
        let responder = { runtime.snapshot_acp().responder() };
        if !responder.respond(request_id.clone(), response).await {
            return Err(PylonError::Protocol(
                "private interaction response failed".into(),
            ));
        }
        let _ = runtime.ledger.take_private(&request_id);
        // #98：队列终态——私有桥/elicitation 应答同样 settle 并晋升下一个 waiter。
        let _ = runtime.ledger.settle(
            &request_id.to_string(),
            crate::acp::interaction_queue::InteractionTerminalReason::Answered,
        );
        return Ok(());
    }
    // 兜底：permission 应答路径（方法驱动——不再要求 provider 注册）。
    let adapter = crate::protocol_adapter::get_protocol_adapter_for_method(
        crate::acp::METHOD_SESSION_REQUEST_PERMISSION,
    )
    .ok_or_else(|| {
        PylonError::Protocol(
            "interaction response unsupported: no adapter for session/request_permission"
                .to_string(),
        )
    })?;
    adapter
        .respond_interaction(&runtime, &identity, &kind, &answer)
        .await
}

/// 设置权限审批模式（B9.3）：bypass/auto 自动批准；edit/default 挂起询问。
/// #448 PR3：后端为持久化权威——内存更新后写穿 user_data（approval-mode key）。
/// 落盘失败降级为「内存生效 + warn」（审批语义不因落盘失败被拒绝；代价是重启
/// 回到旧值）。#463 审查项 3（degraded 外部可查，已落地）：降级不再只可查后端
/// 日志——返回值与 get 均携带 `persisted` 健康位（内存值是否已被 SQLite 持有），
/// CLI 消费方可据此探测「set 成功但重启会回滚」。
/// #463 后端 C-1：内存写与落盘全程持 `approval_mode_write_lock`——并发 set
/// （GUI 与 CLI 桥同进程）串行化，磁盘必为最后一次 set（tokio Mutex 公平取锁，
/// 临界区内无基于旧值的读改写，故锁序即生效序）。
// approval_mode_write_lock 跨 await：串行「内存写→落盘」全窗口，防写完成序可逆（与 config_write_lock 同型）
#[tauri::command]
pub(crate) async fn set_approval_mode(
    state: tauri::State<'_, AppState>,
    mode: String,
) -> Result<ApprovalModeSnapshot, PylonError> {
    if !matches!(mode.as_str(), "bypass" | "auto" | "edit" | "default") {
        return Err(PylonError::Protocol(format!(
            "unknown approval mode: {mode}"
        )));
    }
    let _write_guard = HeldAcrossAwait::new(state.approval_mode_write_lock.lock().await);
    *state.approval_mode.lock().map_err(|e| e.to_string())? = mode.clone();
    let service = state
        .user_data_service
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    match service {
        Some(service) => {
            let payload = serde_json::json!({ "version": 1, "mode": mode });
            match service
                .save(
                    crate::session::user_data::UserDataKey::ApprovalMode,
                    payload,
                    None,
                )
                .await
            {
                Ok(_) => state.approval_mode_persisted.store(true, Ordering::Release),
                Err(error) => {
                    state
                        .approval_mode_persisted
                        .store(false, Ordering::Release);
                    tracing::warn!("approval mode 落盘失败（内存已生效，重启回退）：{error}");
                }
            }
        }
        None => {
            state
                .approval_mode_persisted
                .store(false, Ordering::Release);
            tracing::warn!("approval mode 落盘跳过：user data service 未就绪（内存已生效）");
        }
    }
    Ok(ApprovalModeSnapshot {
        persisted: state.approval_mode_persisted.load(Ordering::Acquire),
        mode,
    })
}

/// #463 审查项 3：approval-mode wire 快照。`persisted` = 内存当前值是否已被
/// SQLite 持有（或从未偏离持久层）——false 即 degraded（重启回退），外部可查。
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct ApprovalModeSnapshot {
    pub mode: String,
    pub persisted: bool,
}

/// CLI 增强（contract.bridge 前置）：读取当前全局审批模式 + 落盘健康位。
/// 此前只有 set 无 get——外部自动化无法确认模式即盲跑。
/// 已知窗口（#463 审查 CONCERN，随批承认）：本命令不持写锁，in-flight set 已写
/// 内存、save 未结算的毫秒级窗口内可读到 `{mode: 新值, persisted: 上次结论}` 的
/// 瞬时失配（stale-true），save 结算后自愈；权威消费路径（set 自身锁内返回的
/// 快照）不受影响。查询不值得为毫秒级窗口阻塞在在途 save 上，故不走写锁。
#[tauri::command]
pub(crate) async fn get_approval_mode(
    state: tauri::State<'_, AppState>,
) -> Result<ApprovalModeSnapshot, PylonError> {
    let mode = state
        .approval_mode
        .lock()
        .map(|mode| mode.clone())
        .map_err(|e| PylonError::Protocol(format!("approval mode lock poisoned: {e}")))?;
    Ok(ApprovalModeSnapshot {
        persisted: state.approval_mode_persisted.load(Ordering::Acquire),
        mode,
    })
}

/// #448 PR3：启动回填——从 user_data 读 approval-mode 覆盖内存默认值（"default"）。
/// 无持久化值保持默认（首次启动，前端种子兜底）；不可用 warn 不阻断启动（degraded：
/// 本次会话内 set 仍会写穿自愈）。mode 合法性由 validate_approval_mode 在写路径前置
/// 保证（save 拒绝非法/缺失 mode），回填处的枚举 filter 属纵深防御（手改 DB）。
/// 读走 load_sync 同步路径——调用方（setup 钩子）在 `rt.block_on` 的 runtime 栈内，
/// 不能嵌套 block_on。
/// #463 审查项 3：同步维护 `approval_mode_persisted` 健康位——回填成功/无持久值
/// （默认即权威）→ true；envelope 缺合法 mode / 读失败 / service 未就绪 → false
/// （内存默认值未被磁盘有效持有，degraded 外部可查）。
pub(crate) fn restore_persisted_approval_mode(state: &AppState) {
    let service = state
        .user_data_service
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let Some(service) = service else {
        state
            .approval_mode_persisted
            .store(false, Ordering::Release);
        tracing::warn!("approval-mode 恢复跳过：user data service 未就绪");
        return;
    };
    match service.load_sync(crate::session::user_data::UserDataKey::ApprovalMode) {
        Ok(Some(envelope)) => {
            let mode = envelope
                .payload
                .get("mode")
                .and_then(serde_json::Value::as_str)
                .filter(|mode| matches!(*mode, "bypass" | "auto" | "edit" | "default"));
            match mode {
                Some(mode) => {
                    if let Ok(mut slot) = state.approval_mode.lock() {
                        *slot = mode.to_string();
                        state.approval_mode_persisted.store(true, Ordering::Release);
                        tracing::info!("approval mode 已从 user_data 恢复：{mode}");
                    }
                }
                None => {
                    state
                        .approval_mode_persisted
                        .store(false, Ordering::Release);
                    tracing::warn!("approval-mode envelope 缺少合法 mode，保持默认");
                }
            }
        }
        Ok(None) => {
            // 无持久化值：保持 default，前端首次种子兜底——默认值与磁盘无偏离，健康。
            state.approval_mode_persisted.store(true, Ordering::Release);
        }
        Err(error) => {
            state
                .approval_mode_persisted
                .store(false, Ordering::Release);
            tracing::warn!("approval-mode 恢复失败（保持默认）：{error}");
        }
    }
}

/// CLI 增强：遍历全部 runtime 的挂起交互快照（含应答所需完整 identity）。
/// #423 快照面单源：不再遍历 pending_permissions / private_interactions 两
/// store，改读统一队列 `snapshot()` 输出 **wire 形状**（与 agent_status 的
/// `pendingInteractions` 同一投影 `pending_interactions_wire`，条目另含
/// `provider`/`deadlineMs`）。展示字段（title 虚拟值 / options 白名单 /
/// prompt 截断 / ask-user 摘要）与 respond 所需 identity 由 CLI 消费侧
/// normalize 重建（`src/cli/pylonCliService.ts`，配 parity 测试）——
/// provider 空串（restore 回灌条目）在此处反查回填。
#[tauri::command]
pub(crate) async fn interaction_list(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    for (agent_id, runtime) in state.runtimes.iter() {
        let provider = {
            let agents = state
                .agents
                .lock()
                .map_err(|e| PylonError::Protocol(format!("agents lock poisoned: {e}")))?;
            resolve_agent_provider(&agents, &agent_id).unwrap_or_else(|| agent_id.clone())
        };
        let entries = runtime
            .ledger
            .queue()
            .snapshot()
            .map_err(PylonError::Protocol)?;
        let mut wire = crate::acp::interaction_queue::pending_interactions_wire(&entries);
        let Some(list) = wire.as_array_mut() else {
            continue;
        };
        for entry in list {
            // restore 回灌条目的 provider 为空串——反查回填（应答 identity 复核用）。
            if entry.get("provider").and_then(serde_json::Value::as_str) == Some("") {
                if let Some(object) = entry.as_object_mut() {
                    object.insert("provider".to_string(), serde_json::json!(provider));
                }
            }
            items.push(entry.take());
        }
    }
    Ok(serde_json::json!({ "items": items }))
}

/// ACP-03（§5.6）：权限请求的展示截止时刻——deadline 由后端单一来源
/// （PERMISSION_REQUEST_TIMEOUT_SECS）给出，前端只做倒计时展示，不自行持有
/// 超时常量。返回 epoch-ms number（与 requestedAt 字符串区分的展示字段）。
pub(crate) fn permission_deadline_ms(requested_at: Timestamp) -> u64 {
    requested_at.as_u64() + PERMISSION_REQUEST_TIMEOUT_SECS * 1000
}

/// ACP-03（§5.6）：超时已结算的挂起请求（后端 watcher 发出的 permission.resolved
/// terminal 事件载荷）。前端据此 settle active/queued 请求——后端唯一计时/应答，
/// 前端不自行宣称超时结果（invariant 5）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TimeoutOutcome {
    pub agent_id: String,
    pub session_id: String,
    pub request_id: RequestId,
    pub client_generation: u64,
    pub option_id: String,
}

/// #356：私有交互超时结算的 outcome（watcher 据此广播
/// `interaction.resolved{reason:"timed_out"}`）。session_id 对 request-scoped
/// elicitation 为空串（前端 settle 按 agentId+requestId+clientGeneration 关卡，
/// 与 session 无关）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrivateInteractionTimeoutOutcome {
    pub agent_id: String,
    pub session_id: String,
    pub request_id: RequestId,
    pub client_generation: u64,
    pub kind: String,
}

/// #488 批⑤：`permission.resolved` / `interaction.resolved` 终态事件
/// （`event_names::INTERACTION` 频道）的**单一构造点**。收敛前是 5 处复制粘贴的
/// json! 变体（客户端替换 drain ×2 / 超时 sweep ×2 / elicitation 完成 ×1），字段
/// 集合各自手拼、易漂移；新增终态来源只改这里。字段口径以断线 drain 版为基准：
/// permission 变体带 `optionId`（无值传空串），interaction 变体带 `kind`；前端按
/// agentId+requestId+clientGeneration settle，与 session 无关。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolvedInteractionEvent<'a> {
    Permission { option_id: &'a str },
    Interaction { kind: &'a str },
}

pub(crate) fn resolved_interaction_payload(
    resolved: ResolvedInteractionEvent<'_>,
    agent_id: &str,
    session_id: &str,
    request_id: &str,
    client_generation: u64,
    reason: &str,
) -> serde_json::Value {
    match resolved {
        ResolvedInteractionEvent::Permission { option_id } => serde_json::json!({
            "eventType": "permission.resolved",
            "agentId": agent_id,
            "sessionId": session_id,
            "requestId": request_id,
            "clientGeneration": client_generation,
            "optionId": option_id,
            "reason": reason,
        }),
        ResolvedInteractionEvent::Interaction { kind } => serde_json::json!({
            "eventType": "interaction.resolved",
            "agentId": agent_id,
            "sessionId": session_id,
            "requestId": request_id,
            "clientGeneration": client_generation,
            "kind": kind,
            "reason": reason,
        }),
    }
}

/// #356：私有交互超时的默认回包（产品裁决落在这一处）。
/// 语义基准与各桥非承诺值表见同域正身
/// `protocol_adapter/interaction_bridge.rs::timeout_default_response`
/// （#416 下沉、#424 随 private_ext 迁宿主 protocol_adapter 域）。
fn private_interaction_timeout_response(
    pending: &crate::private_interaction::PendingPrivateInteraction,
) -> Result<serde_json::Value, PylonError> {
    crate::protocol_adapter::interaction_bridge::timeout_default_response(
        pending.bridge,
        pending.question_specs.as_deref(),
    )
    .map_err(PylonError::Protocol)
}

/// #423 超时 sweep 合一：原 `check_pending_permission_timeouts` 与
/// `check_pending_private_interaction_timeouts` 两条 sweep 的单点替代——
/// watcher 每 5s 调用一次（轮询粒度与广播次序不变：先 permission.resolved
/// 后 interaction.resolved，由调用方按返回二元组分序广播）。
///
/// - **deadline 归队列权威**：判定经 `InteractionLedger::drain_expired`
///   （#416 下沉的 `now > deadline` 严格边界，与原 store 级
///   `elapsed > 300_000ms` 判据逐 ms 等价）；admit 时注入的 `deadline_ms`
///   是唯一判据来源。
/// - 死亡 runtime（O37/#163：崩溃 ∨ 主动停）：`drain_disconnected` 单点清理
///   三 store（幂等），不出 outcome。
/// - 过期条目按 method 分流，各走原应答序：
///   - `session/request_permission`：队列先以 TimedOut 终结（drain 已完成），
///     `resolve_pending`（锁内复核 + 锁外发送 + 失败 restore——序不变），
///     多条 join_all 并行；仅成功结算收集 outcome（ACP-03 invariant 5）。
///   - 其余（私有桥）：take() 原子抢先 claim → 默认回包构造 → 锁外发送 →
///     失败 `restore_private` 回插重试；claim 落空 = 用户应答已抢先收口。
pub(crate) async fn sweep_interaction_timeouts(
    state: &AppState,
) -> (Vec<TimeoutOutcome>, Vec<PrivateInteractionTimeoutOutcome>) {
    let now_ms = Timestamp::now().as_u64();
    let mut outcomes = Vec::new();
    let mut private_outcomes = Vec::new();
    for (agent_id, runtime) in state.runtimes.all_with_ids() {
        let dead = runtime
            .acp
            .try_read()
            .map(|acp| acp.is_dead())
            .unwrap_or(false);
        if dead {
            // O37：已死 runtime 的挂起请求永久无法应答——三 store 单点清理。
            let (dropped, stale_private, _) = runtime.ledger.drain_disconnected();
            if dropped > 0 {
                tracing::warn!("runtime 已崩溃，清空 {dropped} 条挂起权限请求");
            }
            if stale_private > 0 {
                tracing::warn!("runtime 已崩溃，清空 {stale_private} 条挂起私有交互");
            }
            continue;
        }
        // deadline 权威 drain：一次队列操作终结全部过期条目（TimedOut）。
        let expired: Vec<crate::acp::interaction_queue::InteractionQueueEntry> = runtime
            .ledger
            .drain_expired(
                now_ms,
                crate::acp::interaction_queue::InteractionTerminalReason::TimedOut,
            )
            .unwrap_or_default();
        if expired.is_empty() {
            continue;
        }
        let mut permission_expired = Vec::new();
        let mut private_expired = Vec::new();
        for entry in expired {
            if entry.method == crate::acp::METHOD_SESSION_REQUEST_PERMISSION {
                permission_expired.push(entry);
            } else {
                private_expired.push(entry);
            }
        }
        if !permission_expired.is_empty() {
            // O37：多条超时应答互不依赖——join_all 并行，避免写通道阻塞时逐条
            // 串行放大整体耗时。R34：统一走 resolve_pending（锁内复核 + 锁外
            // 发送，防客户端替换竞态）；发送失败恢复 pending（restore 回灌
            // queue，deadline 已过线，下轮 drain_expired 重试或客户端替换清理）。
            // ACP-03：仅成功结算（应答送达）的请求收集 outcome。
            let responses = permission_expired.into_iter().map(|entry| {
                let runtime = runtime.clone();
                let agent_id = agent_id.clone();
                async move {
                    let request_id = crate::acp::RequestId::from_echo_string(&entry.request_id);
                    // 条目身份/选项从 store 只读复核取（claim 在 resolve_pending 内）；
                    // 查不到 = store 与队列失配（结构性不可达，防御告警跳过）。
                    let Some((_canonical, permission)) =
                        runtime.ledger.pending_permission(&request_id)
                    else {
                        tracing::warn!(
                            "权限请求 {} 超时但 store 无条目（队列与 store 失配），跳过结算",
                            entry.request_id
                        );
                        return None;
                    };
                    // ACP-04（§5.6 invariant 4）：超时只能选原 options 中的合法
                    // option——解析层保证 pending 恒非空、pick_option 必 Some；
                    // 防御分支不得伪造 optionId（旧 unwrap_or("reject_once") 是
                    // OBS-03 登记的伪造路径），如异常出现则跳过结算并告警。
                    let Some(option_id) = pick_option(&permission.options, true).map(str::to_string)
                    else {
                        tracing::error!(
                            "权限请求 {} 超时但 options 为空（不应发生），跳过结算，不伪造 optionId",
                            entry.request_id
                        );
                        return None;
                    };
                    // 队列已由 drain_expired 以 TimedOut 终结（超时事实先于默认
                    // 拒绝应答成立；resolve_pending 内部的 settle 对已终结条目
                    // 幂等让位）。
                    let resolved =
                        resolve_pending(&runtime, request_id.clone(), None, &option_id).await;
                    tracing::warn!(
                        "权限请求 {} 超时默认拒绝 {option_id}（{}）",
                        entry.request_id, permission.tool_call_id
                    );
                    resolved.then_some(TimeoutOutcome {
                        agent_id,
                        session_id: permission.session_id,
                        request_id,
                        client_generation: permission.client_generation,
                        option_id,
                    })
                }
            });
            outcomes.extend(
                futures_util::future::join_all(responses)
                    .await
                    .into_iter()
                    .flatten(),
            );
        }
        for entry in private_expired {
            let request_id = crate::acp::RequestId::from_echo_string(&entry.request_id);
            // take() 即原子 claim：None = 用户应答已抢先收口，跳过。
            let Some(claimed) = runtime.ledger.take_private(&request_id) else {
                continue;
            };
            let kind = entry.kind;
            let response = match private_interaction_timeout_response(&claimed) {
                Ok(response) => response,
                Err(error) => {
                    tracing::error!("私有交互 {request_id} 超时应答构造失败：{error}；回插重试");
                    runtime.ledger.restore_private(&request_id, claimed);
                    continue;
                }
            };
            let responder = { runtime.snapshot_acp().responder() };
            if !responder.respond(request_id.clone(), response).await {
                tracing::warn!("私有交互 {request_id} 超时回包发送失败；回插 pending 下轮重试");
                runtime.ledger.restore_private(&request_id, claimed);
                continue;
            }
            tracing::warn!(
                "私有交互 {request_id}（{kind}）超时，已按默认动作回包（session={}）",
                claimed.session_id
            );
            private_outcomes.push(PrivateInteractionTimeoutOutcome {
                agent_id: agent_id.clone(),
                session_id: claimed.session_id,
                request_id,
                client_generation: claimed.client_generation,
                kind,
            });
        }
    }
    (outcomes, private_outcomes)
}

#[cfg(test)]
mod tests {
    use super::ResolvedInteractionEvent;
    use crate::private_interaction::PendingPrivateInteraction;

    /// #488 批⑤：终态事件单一构造点的形状钉——两个变体的字段集合与既有
    /// wire 消费面（前端按 agentId+requestId+clientGeneration settle）互钉，
    /// 防收敛后新增来源时字段漂移。
    #[test]
    fn resolved_interaction_payload_pins_both_wire_shapes() {
        let permission = super::resolved_interaction_payload(
            ResolvedInteractionEvent::Permission { option_id: "allow" },
            "peri",
            "s1",
            "7",
            5,
            "timed_out",
        );
        assert_eq!(
            permission,
            serde_json::json!({
                "eventType": "permission.resolved",
                "agentId": "peri",
                "sessionId": "s1",
                "requestId": "7",
                "clientGeneration": 5,
                "optionId": "allow",
                "reason": "timed_out",
            })
        );
        let interaction = super::resolved_interaction_payload(
            ResolvedInteractionEvent::Interaction {
                kind: "elicitation",
            },
            "peri",
            "s1",
            "7",
            5,
            "completed",
        );
        assert_eq!(
            interaction,
            serde_json::json!({
                "eventType": "interaction.resolved",
                "agentId": "peri",
                "sessionId": "s1",
                "requestId": "7",
                "clientGeneration": 5,
                "kind": "elicitation",
                "reason": "completed",
            })
        );
    }

    fn private_elicitation_pending() -> PendingPrivateInteraction {
        PendingPrivateInteraction {
            provider: "peri".into(),
            agent_id: "a1".into(),
            session_id: "peri-s1".into(),
            method: "elicitation/create".into(),
            bridge: crate::protocol_adapter::private_ext::PrivateBridge::Elicitation,
            params: serde_json::json!({"sessionId": "peri-s1", "elicitationId": "el-1"}),
            question_specs: None,
            client_generation: 1,
            enqueued_at: crate::time::Timestamp::now(),
        }
    }

    /// #316：runtime 死亡分支必须连 private_interactions 一起清——否则崩溃后
    /// 残留条目会在 interaction_list 里悬挂到下次 generation 替换。
    /// #423：登记经 ledger admit（三 store 双写单点），sweep 走合一入口。
    #[tokio::test]
    async fn dead_runtime_clears_private_interactions() {
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime("a1", crate::runtime::AgentRuntime::new_disconnected())
            .build();
        let runtime = state.runtimes.get("a1").expect("runtime 已注入");
        let request_id = crate::acp::RequestId::Number(41);
        runtime
            .ledger
            .admit_private(
                "peri",
                "a1",
                &request_id,
                &private_elicitation_pending(),
                "elicitation/create",
            )
            .expect("admit 必须成功");

        // 置死：主动 stop 标记（disconnected client 的 kill 只置位、无真实子进程）。
        let _ = runtime.snapshot_acp().kill();
        assert!(runtime.snapshot_acp().is_dead());

        let (outcomes, _) = sweep_interaction_timeouts(&state).await;
        let _ = outcomes;
        assert!(
            runtime.ledger.private().snapshot().is_empty(),
            "死亡分支必须清空私有交互残留"
        );
        assert!(
            runtime
                .ledger
                .queue()
                .snapshot()
                .ok()
                .map(|entries| entries.is_empty())
                .unwrap_or(true),
            "统一交互队列必须全量 drain"
        );
    }

    use super::*;
    use crate::runtime::AgentRuntime;

    /// #36/#423：interaction_list 输出 wire 形状（queue snapshot 单源）——
    /// `kind` 恒为 "approval"（CLI respond 透传词项）；该字段被移除时此测试
    /// 必红（防契约回退）。
    #[test]
    fn interaction_list_projects_kind_for_cli_respond_passthrough() {
        use tauri::Manager;
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime("a1", AgentRuntime::new_disconnected())
            .build();
        let permission = parsed(2);
        state
            .runtimes
            .get("a1")
            .expect("runtime 已注入")
            .ledger
            .admit_permission("peri", "a1", &crate::acp::RequestId::Number(7), &permission)
            .expect("admit 必须成功");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let items = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(interaction_list(app.state::<crate::AppState>()))
            .expect("interaction_list 必须成功");
        let item = &items["items"][0];
        assert_eq!(item["kind"], "approval");
        assert_eq!(item["requestId"], "7");
        assert_eq!(item["clientGeneration"], 2);
        // wire 形状（快照面单源）：method/state/payload 全文 + provider/deadlineMs。
        assert_eq!(
            item["method"],
            crate::acp::METHOD_SESSION_REQUEST_PERMISSION
        );
        assert_eq!(item["state"], "active");
        assert_eq!(item["provider"], "peri");
        assert_eq!(
            item["deadlineMs"],
            serde_json::json!(permission_deadline_ms(permission.requested_at))
        );
        assert_eq!(item["payload"]["eventType"], "permission.request");
        assert_eq!(item["payload"]["toolCallId"], "call-1");
    }

    /// #230/#423：私有交互（elicitation / exit-plan）进 interaction_list 的
    /// wire 输出——kind 沿队列 canonical 值、payload 为事件信封原文
    /// （eventType/原始 params）；provider 空串回退配置反查值由 CLI normalize
    /// 消费（详测见 `src/cli/__tests__/interactionWireNormalize.test.ts`）。
    #[test]
    fn interaction_list_projects_private_interactions_wire_for_cli() {
        use crate::protocol_adapter::private_ext::PrivateBridge;
        use tauri::Manager;
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime("a1", AgentRuntime::new_disconnected())
            .build();
        let runtime = state.runtimes.get("a1").expect("runtime 已注入");
        let elicitation = PendingPrivateInteraction {
            provider: String::new(),
            agent_id: "a1".into(),
            session_id: "s1".into(),
            method: "elicitation/create".into(),
            bridge: PrivateBridge::Elicitation,
            params: serde_json::json!({"sessionId": "s1", "message": "issue230 验收"}),
            question_specs: None,
            client_generation: 4,
            enqueued_at: Timestamp::now(),
        };
        let exit_plan = PendingPrivateInteraction {
            provider: "peri".into(),
            method: "_x.ai/exit_plan_mode".into(),
            bridge: PrivateBridge::GrokExitPlan,
            params: serde_json::json!({"sessionId": "s1", "planContent": "step 1", "toolCallId": "tc-9"}),
            client_generation: 5,
            ..elicitation.clone()
        };
        runtime
            .ledger
            .admit_private(
                "",
                "a1",
                &crate::acp::RequestId::Number(11),
                &elicitation,
                "elicitation/create",
            )
            .unwrap();
        runtime
            .ledger
            .admit_private(
                "peri",
                "a1",
                &crate::acp::RequestId::String("e2".into()),
                &exit_plan,
                "_x.ai/exit_plan_mode",
            )
            .unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let items = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(interaction_list(app.state::<crate::AppState>()))
            .expect("interaction_list 必须成功");
        let items = items["items"].as_array().expect("items 数组");
        assert_eq!(items.len(), 2);
        for item in items {
            let payload = &item["payload"];
            match payload["eventType"].as_str() {
                Some("elicitation.request") => {
                    assert_eq!(item["kind"], "elicitation");
                    assert_eq!(item["method"], "elicitation/create");
                    assert_eq!(item["clientGeneration"], 4);
                    // store provider 缺省（空串）→ 反查回填。
                    assert_eq!(item["provider"], "a1");
                    assert_eq!(payload["payload"]["message"], "issue230 验收");
                    assert_eq!(
                        item["deadlineMs"],
                        serde_json::json!(permission_deadline_ms(elicitation.enqueued_at))
                    );
                }
                Some("approval.request") => {
                    assert_eq!(item["kind"], "approval");
                    assert_eq!(item["method"], "_x.ai/exit_plan_mode");
                    assert_eq!(item["provider"], "peri");
                    assert_eq!(item["clientGeneration"], 5);
                    assert_eq!(payload["payload"]["toolCallId"], "tc-9");
                    assert_eq!(payload["payload"]["planContent"], "step 1");
                }
                other => panic!("未知 eventType：{other:?}"),
            }
        }
    }

    fn request_params() -> serde_json::Value {
        serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "call-1", "title": "tool"},
            "options": [{"optionId": "allow_once"}, {"optionId": "reject_once"}]
        })
    }

    fn parsed(generation: u64) -> PendingPermission {
        parse_permission_request_with_generation(Some(&request_params()), generation)
            .expect("合法请求必须解析")
    }

    fn opts(items: &[&str]) -> Vec<PermissionOption> {
        items.iter().map(|s| PermissionOption::plain(*s)).collect()
    }

    /// 带 kind 的选项（kind 作为语义类别参与选择）。
    fn opts_kind(items: &[(&str, Option<&str>)]) -> Vec<PermissionOption> {
        items
            .iter()
            .map(|(id, kind)| PermissionOption {
                option_id: (*id).to_string(),
                kind: kind.map(|k| k.to_string()),
                name: None,
                raw: None,
            })
            .collect()
    }

    #[test]
    fn pick_reject_option_never_falls_back_to_first() {
        // 严格 reject：无 reject 语义项返回 None，绝不回退首个选项（评审 P1）。
        assert_eq!(
            pick_reject_option(&opts(&["allow_once", "ask_again"])),
            None
        );
        assert_eq!(
            pick_reject_option(&opts(&["allow_once", "reject_once"])),
            Some("reject_once")
        );
        // 前缀语义（reject_forever）与 kind 归一（rejectOnce）均命中。
        assert_eq!(
            pick_reject_option(&opts(&["allow_once", "reject_forever"])),
            Some("reject_forever")
        );
        assert_eq!(
            pick_reject_option(&opts_kind(&[("demand", Some("RejectOnce"))])),
            Some("demand")
        );
    }

    #[test]
    fn pick_allow_option_matches_allow_prefix_without_fallback() {
        assert_eq!(
            pick_allow_option(&opts(&["reject_once", "ask_again"])),
            None
        );
        assert_eq!(
            pick_allow_option(&opts(&["reject_once", "allow_always"])),
            Some("allow_always")
        );
        assert_eq!(
            pick_allow_option(&opts_kind(&[("ok", Some("AllowOnce"))])),
            Some("ok")
        );
    }

    #[test]
    fn pick_option_reject_prefers_reject_once_then_prefix_then_first() {
        // reject_once 优先（忽略大小写）
        assert_eq!(
            pick_option(&opts(&["allow_once", "REJECT_ONCE"]), true),
            Some("REJECT_ONCE")
        );
        // 无 reject_once 时前缀 reject 优先
        assert_eq!(
            pick_option(&opts(&["allow_once", "reject_forever"]), true),
            Some("reject_forever")
        );
        // 无 reject 语义项时取首个
        assert_eq!(
            pick_option(&opts(&["allow_once", "ask_again"]), true),
            Some("allow_once")
        );
        // ACP-02：kind=reject_once 是语义类别——optionId 非 reject 字面也命中
        assert_eq!(
            pick_option(
                &opts_kind(&[("allow_once", None), ("deny", Some("reject_once"))]),
                true
            ),
            Some("deny")
        );
        // Hermes camelCase kind（rejectOnce）与 snake_case 视为同义（下划线归一）
        assert_eq!(
            pick_option(
                &opts_kind(&[("allow_once", None), ("deny", Some("rejectOnce"))]),
                true
            ),
            Some("deny")
        );
        // kind 前缀 reject 同样命中；返回值恒为 option_id 原值
        assert_eq!(
            pick_option(
                &opts_kind(&[("allow_once", None), ("deny", Some("reject"))]),
                true
            ),
            Some("deny")
        );
        // 空集无兜底项
        assert_eq!(pick_option(&[], true), None);
    }

    #[test]
    fn pick_option_allow_prefers_allow_once_then_first() {
        assert_eq!(
            pick_option(&opts(&["allow_always", "ALLOW_ONCE"]), false),
            Some("ALLOW_ONCE")
        );
        assert_eq!(
            pick_option(&opts(&["allow_always", "reject_once"]), false),
            Some("allow_always")
        );
        // ACP-02：kind=allowOnce 语义类别同样命中 allow 分支
        assert_eq!(
            pick_option(
                &opts_kind(&[("allow_always", None), ("yes", Some("allowOnce"))]),
                false
            ),
            Some("yes")
        );
        assert_eq!(pick_option(&[], false), None);
    }

    #[test]
    fn parse_retains_kind_name_and_raw_acp02() {
        // ACP-02：typed options——kind/name/raw 必须宽容保留，optionId 原值不正规化。
        let params = serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "call-1", "title": "tool"},
            "options": [
                {"optionId": "ALLOW_ONCE", "kind": "allowOnce", "name": "Allow", "raw": {"x": 1}},
                {"optionId": "custom_approve", "kind": "UNKNOWN_KIND"}
            ]
        });
        let permission = parse_permission_request(Some(&params)).expect("合法请求必须解析");
        assert_eq!(permission.options.len(), 2);
        assert_eq!(
            permission.options,
            vec![
                PermissionOption {
                    option_id: "ALLOW_ONCE".to_string(),
                    kind: Some("allowOnce".to_string()),
                    name: Some("Allow".to_string()),
                    raw: Some(serde_json::json!({"x": 1})),
                },
                PermissionOption {
                    option_id: "custom_approve".to_string(),
                    kind: Some("UNKNOWN_KIND".to_string()),
                    name: None,
                    raw: None,
                },
            ]
        );
        // optionId 原样保存（ALLOW_ONCE 未被小写化）——事件序列化必须回写原值。
        assert_eq!(permission.options[0].option_id, "ALLOW_ONCE");
    }

    #[tokio::test]
    async fn respond_permission_rejects_stale_generation() {
        let runtime = AgentRuntime::new_disconnected();
        // 客户端替换场景：pending 记录的是旧 generation（1），当前 generation 为 0
        runtime
            .ledger
            .permissions()
            .lock()
            .unwrap()
            .insert(RequestId::Number(7), parsed(1));
        assert!(
            !resolve_pending(&runtime, RequestId::Number(7), None, "allow_once").await,
            "generation 不匹配必须拒绝应答"
        );
        assert!(
            runtime
                .ledger
                .permissions()
                .lock()
                .unwrap()
                .contains_key(&RequestId::Number(7)),
            "拒绝应答后 pending 保留（由客户端替换清理）"
        );
    }

    #[tokio::test]
    async fn respond_permission_stale_generation_never_reaches_client() {
        // A1c: SDK responder 只为真实 agent request 登记；代际拒绝保持 pending。
        let runtime = AgentRuntime::new_disconnected();
        runtime
            .ledger
            .permissions()
            .lock()
            .unwrap()
            .insert(RequestId::Number(7), parsed(1));
        assert!(!resolve_pending(&runtime, RequestId::Number(7), None, "allow_once").await);
        assert!(runtime
            .ledger
            .permissions()
            .lock()
            .unwrap()
            .contains_key(&RequestId::Number(7)));
    }

    #[test]
    fn canonical_pending_key_exact_hit_and_number_to_string_fallback() {
        // ACP-01：前端把 requestId 以字符串回显——原 string-id 请求（String("7")）
        // 经候选 Number(7) 回退命中；Number 与 String 并存时精确命中优先。
        let mut pending: HashMap<RequestId, PendingPermission> = HashMap::new();
        pending.insert(RequestId::String("7".to_string()), parsed(0));
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::Number(7)),
            Some(RequestId::String("7".to_string())),
            "Number 未命中必须回退 String 形态"
        );
        pending.insert(RequestId::Number(7), parsed(0));
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::Number(7)),
            Some(RequestId::Number(7)),
            "并存时精确命中优先"
        );
        // 并存时 String 候选精确命中 String 条目（不跨形态回退）。
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::String("7".to_string())),
            Some(RequestId::String("7".to_string())),
            "并存时精确候选优先"
        );
        // ACP-01 CR-002：String 候选（approve_tool_call 以字符串调用 numeric 请求）
        // 未命中时回退 Number 形态——双向归一。此时 pending 仅剩 Number(7)。
        pending.remove(&RequestId::String("7".to_string()));
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::String("7".to_string())),
            Some(RequestId::Number(7)),
            "String 候选必须回退 Number 形态"
        );
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::String("007".to_string())),
            Some(RequestId::Number(7)),
            "前导零数字串归一为 Number"
        );
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::String("perm-x".to_string())),
            None,
            "不存在返回 None"
        );
    }

    // String-id wire echo is covered by acp::engine::sdk_responder_answers_agent_request.
    /// ACP-03（§5.6）：后端唯一计时/应答——超时请求结算后返回 outcome（前端
    /// permission.resolved 事件载荷）。A1c：legacy 写通道已删除，改由真实 SDK
    /// 连接登记 Responder（fake agent 发 id=7 的 permission 请求）——应答送达才结算。
    #[tokio::test]
    async fn timeout_settles_and_reports_outcome_with_live_responder() {
        let agent = crate::test_utils::fake_acp_agent(
            "fake-acp-perm-timeout",
            &[
                "--scenario",
                "permission-proactive",
                "--permission-id",
                "7",
                "--post-init-respond",
                "--permission-params",
                r#"{"sessionId":"s1","toolCallId":"tc-1","options":[{"optionId":"allow_once"},{"optionId":"reject_once"}]}"#,
            ],
        );
        let acp = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        // 等引擎登记 id=7 的 Responder（Pylon id = Number(7)）。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if acp
                .backend
                .pending_requests
                .lock()
                .unwrap()
                .contains_key(&RequestId::Number(7))
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "engine must register the permission responder"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(acp);
        let agent_id = "timeout-agent";
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime(agent_id, runtime.clone())
            .build();
        // requested_at 早于 300s——超时命中。#423：登记经 ledger admit
        //（deadline admit 时注入，超时判定归队列权威）。
        let old = Timestamp::new(Timestamp::now().as_u64().saturating_sub(301_000));
        let mut pending = parsed(0);
        pending.requested_at = old;
        runtime
            .ledger
            .admit_permission("peri", agent_id, &RequestId::Number(7), &pending)
            .expect("admit 必须成功");

        let (outcomes, _) = sweep_interaction_timeouts(&state).await;

        assert_eq!(outcomes.len(), 1, "超时请求必须结算并报告 outcome");
        let outcome = &outcomes[0];
        assert_eq!(outcome.agent_id, agent_id);
        assert_eq!(outcome.session_id, "s1");
        assert_eq!(outcome.request_id, RequestId::Number(7));
        assert_eq!(outcome.client_generation, 0);
        assert_eq!(outcome.option_id, "reject_once");
        assert!(
            runtime.ledger.permissions().lock().unwrap().is_empty(),
            "结算后 pending 必须清空"
        );
        let _ = runtime.snapshot_acp().kill();
    }

    /// ACP-03：deadline 由后端单一来源（PERMISSION_REQUEST_TIMEOUT_SECS）——
    /// 展示截止 = requestedAt + 300s；前端只读该值做倒计时。
    #[test]
    fn permission_deadline_is_requested_at_plus_timeout() {
        let requested_at = Timestamp::new(1_722_500_000_000);
        assert_eq!(
            permission_deadline_ms(requested_at),
            1_722_500_000_000 + 300 * 1000
        );
    }

    /// #356：私有交互超时默认回包 = 各桥的非承诺值（超时 = 用户未应答）。
    /// 产品裁决集中在本函数——改语义只动一处。
    #[test]
    fn private_timeout_response_picks_the_non_committal_value_per_bridge() {
        use crate::protocol_adapter::private_ext::PrivateBridge;
        let mut elicitation = private_elicitation_pending();
        assert_eq!(
            private_interaction_timeout_response(&elicitation).unwrap(),
            serde_json::json!({"action": "cancel"}),
            "elicitation 超时 = cancel（未作答），不得伪造 decline"
        );

        elicitation.bridge = PrivateBridge::GrokExitPlan;
        assert_eq!(
            private_interaction_timeout_response(&elicitation).unwrap(),
            serde_json::json!({"outcome": "keep_planning", "feedback": ""}),
            "exit_plan 超时 = keep_planning（不批准也不代弃）"
        );

        let mut grok = elicitation;
        grok.bridge = PrivateBridge::GrokExtQuestions;
        grok.question_specs = Some(
            crate::acp::question_policy::parse_questions(&serde_json::json!({"questions": [{
                "question": "Pick", "header": "Choice",
                "options": [{"label": "A"}, {"label": "B"}]
            }]}))
            .unwrap(),
        );
        assert_eq!(
            private_interaction_timeout_response(&grok).unwrap(),
            serde_json::json!({"outcome": "skip_interview"}),
            "grok 问题桥超时 = 既有 declined 映射"
        );

        let mut pi = grok;
        pi.bridge = PrivateBridge::PiSelectAsk;
        assert_eq!(
            private_interaction_timeout_response(&pi).unwrap(),
            serde_json::json!({"cancelled": true}),
            "pi 问题桥超时 = cancelled:true"
        );

        // 问题桥丢 specs 的防御分支：报错而非伪造应答。
        pi.question_specs = None;
        assert!(private_interaction_timeout_response(&pi).is_err());
    }

    /// #356：到期私有交互经真实 SDK responder 回包（fake agent 发 id=71 的
    /// 请求，引擎登记 Responder）——store 清空、队列 TimedOut、outcome 收集。
    #[tokio::test]
    async fn private_interaction_timeout_sends_cancel_and_settles_with_live_responder() {
        let agent = crate::test_utils::fake_acp_agent(
            "fake-acp-private-timeout",
            &[
                "--scenario",
                "permission-proactive",
                "--permission-id",
                "71",
                "--post-init-respond",
                "--permission-params",
                r#"{"sessionId":"s1","toolCallId":"tc-1","options":[{"optionId":"allow_once"}]}"#,
            ],
        );
        let acp = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if acp
                .backend
                .pending_requests
                .lock()
                .unwrap()
                .contains_key(&RequestId::Number(71))
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "engine must register the private interaction responder"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(acp);
        let agent_id = "private-timeout-agent";
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime(agent_id, runtime.clone())
            .build();
        // enqueued_at 早于 300s——超时命中。#423：登记经 ledger admit
        //（deadline 归队列权威，判定走 drain_expired）。
        let mut pending = private_elicitation_pending();
        pending.enqueued_at = Timestamp::new(Timestamp::now().as_u64().saturating_sub(301_000));
        runtime
            .ledger
            .admit_private(
                "peri",
                agent_id,
                &RequestId::Number(71),
                &pending,
                "elicitation/create",
            )
            .expect("admit 必须成功");

        let (_, outcomes) = sweep_interaction_timeouts(&state).await;

        assert_eq!(outcomes.len(), 1, "到期私有交互必须结算并报告 outcome");
        let outcome = &outcomes[0];
        assert_eq!(outcome.agent_id, agent_id);
        assert_eq!(outcome.session_id, "peri-s1");
        assert_eq!(outcome.request_id, RequestId::Number(71));
        assert_eq!(outcome.kind, "elicitation");
        assert!(
            runtime.ledger.private().snapshot().is_empty(),
            "回包送达后 store 必须清空"
        );
        let entries = runtime.ledger.queue().snapshot().expect("queue snapshot");
        assert!(
            entries.is_empty(),
            "队列条目必须被 settle 收敛（settle = 移除 + 终态返回），不残留悬挂 waiter"
        );
        let _ = runtime.snapshot_acp().kill();
    }

    /// #356：未到期不动；到期但发送失败（disconnected client）→ 条目回插
    /// 供下轮重试，队列不终结、不产出 outcome。#423：回插经
    /// `restore_private`（store + queue 回灌——deadline 已过线，下轮
    /// drain_expired 可再命中）。
    #[tokio::test]
    async fn private_interaction_timeout_retains_entry_when_send_fails() {
        let runtime = AgentRuntime::new_disconnected();
        let agent_id = "private-timeout-retry-agent";
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime(agent_id, runtime.clone())
            .build();
        let fresh = private_elicitation_pending();
        let mut expired = private_elicitation_pending();
        expired.enqueued_at = Timestamp::new(Timestamp::now().as_u64().saturating_sub(301_000));
        runtime
            .ledger
            .admit_private(
                "peri",
                agent_id,
                &RequestId::Number(81),
                &expired,
                "elicitation/create",
            )
            .unwrap();
        runtime
            .ledger
            .admit_private(
                "peri",
                agent_id,
                &RequestId::Number(82),
                &fresh,
                "elicitation/create",
            )
            .unwrap();

        let (_, outcomes) = sweep_interaction_timeouts(&state).await;

        assert!(outcomes.is_empty(), "发送失败不得产出 outcome");
        let snapshot = runtime.ledger.private().snapshot();
        assert_eq!(
            snapshot.len(),
            2,
            "未到期保留；发送失败回插重试——两条都不丢"
        );
        assert!(snapshot.iter().any(|(id, _)| *id == RequestId::Number(81)));
        assert!(snapshot.iter().any(|(id, _)| *id == RequestId::Number(82)));
        // 回灌后的 queue：81（回插）与 82（未动）都在——下轮 sweep 可再命中 81。
        let entries = runtime.ledger.queue().snapshot().expect("queue snapshot");
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry.request_id == "81"));
        assert!(entries.iter().any(|entry| entry.request_id == "82"));
    }

    /// #448 PR3：set_approval_mode 写穿 user_data（后端权威）。内存与 SQLite 落盘
    /// 都生效；校验器拒绝垃圾 mode。#463 审查项 3：返回快照与 get 均带 persisted=true。
    #[test]
    fn set_approval_mode_persists_to_user_data() {
        use tauri::Manager;
        let shared = std::sync::Arc::new(
            crate::session::UserDataService::in_memory().expect("user service"),
        );
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_user_data_service(shared.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(async {
                let snapshot = set_approval_mode(app.state::<crate::AppState>(), "auto".into())
                    .await
                    .expect("set must succeed");
                assert_eq!(snapshot.mode, "auto");
                assert!(snapshot.persisted, "落盘成功必须健康位 true");
                let view = get_approval_mode(app.state::<crate::AppState>())
                    .await
                    .expect("get must succeed");
                assert_eq!(view.mode, "auto");
                assert!(view.persisted);
            });
        // 内存态生效
        assert_eq!(
            *app.state::<crate::AppState>().approval_mode.lock().unwrap(),
            "auto"
        );
        // 落盘生效（load_sync 直读——与启动回填同路径）
        let envelope = shared
            .load_sync(crate::session::user_data::UserDataKey::ApprovalMode)
            .expect("load")
            .expect("persisted");
        assert_eq!(envelope.payload["mode"], "auto");
    }

    /// #448 PR3：service 未就绪（启动极早期）→ 写穿降级 warn，内存仍生效；
    /// 非法 mode 仍然拒绝。#463 审查项 3：降级健康位 persisted=false 外部可查
    /// （set 返回值与 get 一致）。
    #[test]
    fn set_approval_mode_degrades_to_memory_without_service() {
        use tauri::Manager;
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let snapshot = set_approval_mode(app.state::<crate::AppState>(), "edit".into())
                .await
                .expect("set must succeed（降级不拒绝）");
            assert_eq!(snapshot.mode, "edit");
            assert!(
                !snapshot.persisted,
                "service 未就绪必须暴露 degraded（persisted=false）"
            );
            let error = set_approval_mode(app.state::<crate::AppState>(), "yolo".into())
                .await
                .expect_err("garbage mode must be rejected");
            assert!(error.to_string().contains("unknown approval mode"));
            let view = get_approval_mode(app.state::<crate::AppState>())
                .await
                .expect("get must succeed");
            assert_eq!(view.mode, "edit");
            assert!(!view.persisted, "get 健康位与 set 返回一致");
        });
        assert_eq!(
            *app.state::<crate::AppState>().approval_mode.lock().unwrap(),
            "edit"
        );
    }

    /// #448 PR3：启动回填——set 写穿落盘的值经 restore_persisted_approval_mode
    /// 回填内存（重启等价路径）；无持久化值保持默认；损坏 payload（手改 DB）不 panic。
    /// #463 审查项 3：回填成功/无持久值 → persisted=true。
    #[test]
    fn restore_persisted_approval_mode_reads_back_written_value() {
        use std::sync::atomic::Ordering;
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let shared = std::sync::Arc::new(
            crate::session::UserDataService::in_memory().expect("user service"),
        );
        // 预置落盘值（模拟上一会话 set 的写穿产物）
        rt.block_on(async {
            shared
                .save(
                    crate::session::user_data::UserDataKey::ApprovalMode,
                    serde_json::json!({ "version": 1, "mode": "bypass" }),
                    None,
                )
                .await
                .expect("seed save");
        });
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_user_data_service(shared)
            .build();
        restore_persisted_approval_mode(&state);
        assert_eq!(*state.approval_mode.lock().unwrap(), "bypass");
        assert!(
            state.approval_mode_persisted.load(Ordering::Acquire),
            "回填成功必须健康位 true"
        );

        // 无持久化值（空 service，模拟首次启动）→ 保持构造默认；默认即权威 → true
        let fresh = crate::test_utils::TestStateBuilder::bare()
            .with_user_data_service(std::sync::Arc::new(
                crate::session::UserDataService::in_memory().expect("user service"),
            ))
            .build();
        restore_persisted_approval_mode(&fresh);
        assert_eq!(*fresh.approval_mode.lock().unwrap(), "default");
        assert!(fresh.approval_mode_persisted.load(Ordering::Acquire));

        // 损坏 payload（非法/缺失 mode）分支在此不可测：validate_approval_mode 前置
        // 拒绝（approval_mode_rejects_unknown_mode_and_version 钉住），in_memory 基建
        // 无法绕过 save 种出非法行——restore 的 mode filter 属纵深防御（手改 DB 场景）。
    }

    /// #463 审查项 3：service 未就绪时启动回填 → persisted=false（内存默认值未被
    /// 磁盘有效持有，degraded 外部可查）；set 落盘 save-Err 分支同属 degraded，
    /// 但 in_memory 基建无法注入 save 失败（与 #448 审查 C-3 同口径：不可达分支
    /// 不硬造测试），该臂由 None-service 臂 + save Ok 臂夹逼语义。
    #[test]
    fn restore_without_service_marks_persisted_false() {
        use std::sync::atomic::Ordering;
        let state = crate::test_utils::TestStateBuilder::bare().build();
        restore_persisted_approval_mode(&state);
        assert_eq!(*state.approval_mode.lock().unwrap(), "default");
        assert!(
            !state.approval_mode_persisted.load(Ordering::Acquire),
            "service 未就绪必须暴露 degraded"
        );
    }

    /// #463 后端 C-1：并发 set 写穿串行——多轮两任务并发 set 不同 mode，join 后
    /// 磁盘终值 == 内存终值。锁窗口下确定性成立（后取锁者的内存值与其落盘值一致）；
    /// 修复前两个盲写 save 完成序可逆，磁盘可停在较早 set（本用例对该回归面敏感）。
    #[test]
    fn set_approval_mode_concurrent_writes_keep_disk_equal_to_memory() {
        use tauri::Manager;
        let shared = std::sync::Arc::new(
            crate::session::UserDataService::in_memory().expect("user service"),
        );
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_user_data_service(shared.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            for round in 0..16 {
                let (first, second) = if round % 2 == 0 {
                    ("auto", "bypass")
                } else {
                    ("bypass", "auto")
                };
                let app_ref = &app;
                tokio::join!(
                    async {
                        let snapshot =
                            set_approval_mode(app_ref.state::<crate::AppState>(), first.into())
                                .await
                                .expect("first set must succeed");
                        assert_eq!(snapshot.mode, first);
                        assert!(snapshot.persisted, "落盘全成功场景健康位必须 true");
                    },
                    async {
                        let snapshot =
                            set_approval_mode(app_ref.state::<crate::AppState>(), second.into())
                                .await
                                .expect("second set must succeed");
                        assert_eq!(snapshot.mode, second);
                        assert!(snapshot.persisted);
                    },
                );
                let memory = app
                    .state::<crate::AppState>()
                    .approval_mode
                    .lock()
                    .unwrap()
                    .clone();
                assert!(
                    memory == first || memory == second,
                    "内存终值必须是两次 set 之一：round {round}"
                );
                let envelope = shared
                    .load_sync(crate::session::user_data::UserDataKey::ApprovalMode)
                    .expect("load")
                    .expect("persisted");
                assert_eq!(
                    envelope.payload["mode"], memory,
                    "磁盘终值必须等于内存终值：round {round}"
                );
            }
        });
    }
}
