//! Prompt 域 · 终态结算（域 D）：三条终态臂、finalize 收尾、failure 元数据映射、
//! 通道终帧与幽灵映射清理。
//! W3 重构批次 S1 纯搬移自 session/prompt.rs（行为零变化）。

use super::*;

// #416 W2 wave2 分位点接线：prompt 收尾的 pet 感知改经 KernelReactionSink
// 订阅缝（dispatcher/reactions.rs）。sink 实例从 state.pet 现地装配——与泵
// `NotificationPump::new` 的装配同源同 Arc，锁与中毒吸收语义逐位一致。
use crate::dispatcher::reactions::{KernelReactionSink, PetReactionSink, TurnFailureCause};

pub(super) fn failure_for_acp_error(
    error: &AcpError,
    elapsed_ms: Option<u64>,
) -> PromptFailureMetadata {
    let (source, timeout_kind, triggered_timeout_secs) = match error {
        AcpError::WriteTimeout => (
            "write-timeout",
            Some("write"),
            Some(crate::acp::DEFAULT_WRITE_TIMEOUT_SECS),
        ),
        AcpError::RpcTimeout => (
            "rpc",
            Some("rpc"),
            Some(crate::agent_config::DEFAULT_RPC_TIMEOUT_SECS),
        ),
        AcpError::ConnectionClosed => ("connection", None, None),
        _ => ("internal", None, None),
    };
    PromptFailureMetadata {
        source,
        timeout_kind,
        triggered_timeout_secs,
        actual_elapsed_ms: elapsed_ms,
        provider_message: None,
        ..Default::default()
    }
}

/// A2/A3：向 source 已注册的流式通道发送终帧（done/error 信封）并注销注册。
/// B1 扩展：user echo 也经此单轨化。未注册 → 返回 false（调用方走广播兜底）。
/// 发送失败仅告警，返回 true（注册已 take，广播会双投递——失败视为连接已断）。
/// payload 为完整终态载荷（含 canonicalEvent），前端按既有 done/error 分支处理。
/// 幂等：take 注销先行，重复调用安全（第二次返回 false）。
pub(super) fn send_channel_terminal(
    _state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    event: &str,
    mut payload: serde_json::Value,
) -> bool {
    if let Some(channel) = runtime.take_update_channel(source) {
        if let serde_json::Value::Object(ref mut map) = payload {
            map.entry("source".to_string())
                .or_insert_with(|| serde_json::Value::String(source.to_string()));
        }
        let frame = serde_json::json!({ "event": event, "payload": payload });
        if let Err(error) = channel.send(frame) {
            tracing::warn!("channel 终帧发送失败 event={event} source={source}: {error}");
        }
        true
    } else {
        false
    }
}

/// R33c：Response 成功路径收尾——stop reason 校验（M5 感知，#324 cancelled 跳过）、
/// generation 复核、首轮标记、pylon:done 广播、B11.2 完成持久化（cancelled 跳过）、
/// 完成日志。wire/事件顺序与拆分前内联路径完全一致（pylon:error 先于 pet 感知、
/// done 先于 persist）。G2-06：11 参收敛为 (flow, data) 两参；函数体经局部别名
/// 访问 flow 派生字段。
///
/// S2（W3 重构批次）：原 `finalize_cancelled_response` 镜像骨架并入本函数——
/// 入口精确拦截 `stopReason: "cancelled"`（#324）后按 `cancelled` 分参数化，
/// 五处差异簇逐一对账保持：① cancelled 完全跳过 #316 闭式表评估与 pet 感知
/// （闭式表拒绝 cancelled，不跳过会把中性结算变成 Err 路径）；② B11.2 persist
/// 跳过（与 CancelledAfterTimeout 臂口径一致）；③ 日志文案/result 字段分参；
/// ④ done_update 预置 `"stopReason": "cancelled"`；⑤ #324 拦截分支即本函数
/// 入口的分派点。ingest → emit → channel 三步顺序两侧逐位相同。
pub(super) async fn finalize_response<R: tauri::Runtime>(
    flow: &mut PromptFlow<'_, R>,
    data: serde_json::Value,
) -> Result<String, PylonError> {
    let state = flow.state;
    let runtime = flow.runtime;
    let window = flow.window;
    let gateway = flow.gateway;
    let source = &flow.ctx.source;
    let content = &flow.ctx.content;
    let peri_id = &flow.peri_id;
    let prompt_generation = flow.generation;
    let is_first = flow.is_first;
    let message_round = flow.message_round;
    // #324：用户主动停止的 wire 终态（stopReason=cancelled）不进错误呈现链。
    // #316 闭式表（protocol.rs）仍拒绝 cancelled 作为成功完成；此处在其之前
    // 拦截，改走 done 通道中性结算（账本侧 Cancelled 终因已由
    // settle_turn_from_response 先行落定，#99）。精确匹配：空白/大小写变体
    // 不享拦截（is_cancelled_stop_response 契约）。
    let cancelled = is_cancelled_stop_response(&data);
    // #316：stopReason 闭式判定表（typed-first）。max_tokens 转正为合法终态
    // （pet on_maxed + done 正常广播，UI 凭 stopReason 文案提示）；未知值在
    // 协议层已 warn 降级 end_turn；refusal/cancelled 维持 Err。
    // #324：cancelled 完全跳过本评估与 pet 感知（非自然完成也非失败）。
    if !cancelled {
        let stop = crate::acp::prompt_stop_outcome(&data).map_err(|error| {
            let error = error.to_string();
            // M5 感知：refusal 区分于普通失败（max_turn_requests 现走 Ok 终态，
            // 旧错误分支里的 max_turn 探测随之消亡）。#416 W2：失败侧位点经
            // sink（在 done 广播之前）。
            let reactions = PetReactionSink::new(state.pet.clone());
            if error.contains("refused") {
                reactions.on_turn_failed(TurnFailureCause::Refused);
            } else {
                reactions.on_turn_failed(TurnFailureCause::Erred);
            }
            error
        })?;
        if matches!(stop, crate::acp::PromptStopOutcome::MaxTokens) {
            // #416 W2：max_tokens 转正为合法终态但感知独立（on_maxed），
            // 仍在 done 广播之前的失败侧位点。
            PetReactionSink::new(state.pet.clone()).on_turn_failed(TurnFailureCause::Maxed);
        }
    }
    if let Err(error) = state.ensure_generation(runtime, prompt_generation) {
        let _ = state.remove_session_if_matches(runtime, source, peri_id, prompt_generation);
        return Err(error.into());
    }
    if is_first {
        state.mark_first_prompt_if_matches(runtime, source, peri_id, prompt_generation)?;
    }
    // #442 Step2：终帧 additive turnId——done 帧携带本回合身份（= 账本 key 的
    // turn_id，出站 request id），前端 stamps 猜测在字段可用时退役。
    let mut done_payload =
        serde_json::json!({"source": source, "turnId": flow.request_id, "data": data});
    // #324：cancelled 的 done_update 预置 stopReason（canonical 行 stopReason
    // 与 done 帧语义一致）；随后的三键覆写两侧相同。
    let mut done_update = if cancelled {
        serde_json::json!({ "sessionUpdate": "done", "stopReason": "cancelled" })
    } else {
        serde_json::json!({ "sessionUpdate": "done" })
    };
    if let Some(object) = data.as_object() {
        for key in ["stopReason", "usage", "model"] {
            if let Some(value) = object.get(key) {
                done_update[key] = value.clone();
            }
        }
    }
    if let Some(committed_event) = ingest_prompt_event(
        state,
        runtime,
        source,
        Some(peri_id.clone()),
        prompt_generation,
        serde_json::json!({
            "source": source,
            "update": done_update,
        }),
    )
    .await?
    {
        done_payload["canonicalEvent"] = serde_json::to_value(committed_event)?;
    }
    if let Some(window) = window {
        emit_event_all(
            window,
            gateway,
            source,
            crate::event_names::SESSION_DONE,
            done_payload.clone(),
        );
    }
    send_channel_terminal(
        state,
        runtime,
        source,
        crate::event_names::SESSION_DONE,
        done_payload,
    );
    // pet on_done 仅自然完成（cancelled 不感知——原 cancelled 镜像无 pet 调用）。
    // #416 W2：done 位点在 done 广播 + channel 终帧之后、B11.2 persist 之前（经 sink）。
    if !cancelled {
        PetReactionSink::new(state.pet.clone()).on_turn_done();
        // B11.2：完成持久化（gateway.inject.persist = "prism"）——把本回合
        // （用户消息 + 流式收集的回复文本）交 Prism /persist（LLM 摘要 +
        // recent.json + active.round 推进）。失败只告警，不阻断。
        // #324：cancelled 跳过（中断回合不落 Prism 摘要）。
        // #416 W2 wave2 步骤 4：HTTP 与 ok/失败日志经 flow.hooks port；
        // await 至完成（禁 spawn-off——「命令返回晚于 persist 完成」时序保留）。
        if gateway.inject_persist() == "prism" {
            let response_text = {
                let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
                sessions
                    .get(source)
                    .map(|s| s.last_response_text.clone())
                    .unwrap_or_default()
            };
            if !response_text.trim().is_empty() {
                flow.hooks
                    .on_turn_committed(source, content, &response_text, message_round)
                    .await;
            }
        }
    }
    state.log_runtime_summary(
        "info",
        "prompt",
        Some(source.to_string()),
        if cancelled {
            "Prompt cancelled; settled via done channel (#324)"
        } else {
            "Prompt completed"
        },
        serde_json::Map::from_iter([(
            "result".to_string(),
            serde_json::Value::String(if cancelled { "cancelled" } else { "success" }.to_string()),
        )]),
    );
    Ok(flow.peri_id.clone())
}

/// #324：精确匹配 `stopReason: "cancelled"`（空白/大小写变体不享拦截，仍走
/// #316 闭式表 fail-closed）。
pub(super) fn is_cancelled_stop_response(data: &serde_json::Value) -> bool {
    data.get("stopReason").and_then(|value| value.as_str()) == Some("cancelled")
}

/// S3：prompt Response 错误是否携带"会话不存在"语义（幽灵映射自动重建判定）。
/// agent 重启/会话回收后，本地映射的 peri_id 指向已死会话，prompt 会返回
/// "session not found" 类 RPC 错误。分类只读取 [`AcpError::Rpc`] 的结构化
/// code/data/message；method-not-found 与传输/超时错误不命中。
pub(crate) fn prompt_error_indicates_missing_session(error: &AcpError) -> bool {
    error.rpc_failure_kind() == Some(crate::acp::RpcFailureKind::SessionMissing)
}

/// S3：Response 错误分支的幽灵映射清理——错误含"会话不存在"语义时，按
/// (peri_id, generation) 复核删除本地映射（O1：锁表同步收敛），并保留 Detached
/// 健康快照，要求用户显式 load/retry/fork。返回是否删除了映射。事件与 pet 感知
/// 由调用方保持原顺序，本函数只负责映射收敛与日志。
pub(crate) fn cleanup_ghost_session_mapping(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    peri_id: &str,
    prompt_generation: u64,
    error: &AcpError,
) -> bool {
    if !prompt_error_indicates_missing_session(error) {
        return false;
    }
    match crate::session::store::mark_detached_if_current(
        runtime,
        source,
        peri_id,
        prompt_generation,
        prompt_generation,
        "remote-session-missing".into(),
        false,
        true,
    ) {
        Ok(true) => {
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source.to_string()),
                &format!("Agent session {peri_id} missing; removed stale mapping — explicit reload is required"),
                serde_json::Map::new(),
            );
            true
        }
        Ok(false) => false,
        Err(remove_error) => {
            tracing::warn!("remove stale session mapping failed: {remove_error}");
            false
        }
    }
}

/// #261 拆分：`send_prompt_core_impl` 的 `PromptWaitOutcome::Response` 终态臂
/// （原内联体逐行搬移，行为零变化）——账本结算 → generation/映射复核 →
/// provider 错误（failure 元数据 + 宠物感知 + S3 幽灵映射清理）或成功收尾
/// （R33c finalize_response）。
#[allow(clippy::too_many_arguments)]
pub(super) async fn settle_prompt_response<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    flow: &mut PromptFlow<'_, R>,
    turn_key: &TurnKey,
    raw: crate::acp::RawMessage,
    prompt_started_at: std::time::Instant,
    failure: &mut Option<PromptFailureMetadata>,
) -> Result<String, PylonError> {
    // #99：wire 终态判定先于展示/持久化——ensure_generation 等后续失败
    // 也不能让 turn 悬在账本外；一个 prompt 至多一个 terminal transition。
    // #442 Step3：CAS Published 时广播 pylon:turn-settled（内核事实主轨，
    // 先于 done/error 帧与持久化）。
    let settle_outcome = settle_turn_from_response(runtime, turn_key, &raw);
    emit_turn_settled(
        flow.window,
        flow.gateway,
        runtime,
        source,
        turn_key,
        &settle_outcome,
    );
    state.ensure_generation(runtime, flow.generation)?;
    if !state.session_matches(runtime, source, &flow.peri_id, flow.generation)? {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    let connection_closed = is_closed_transport_response(&raw);
    if let Some(error) = raw.error {
        let error = error.to_string();
        *failure = Some(PromptFailureMetadata::provider_failure(
            connection_closed,
            &error,
            prompt_started_at,
        ));
        let typed_error = if connection_closed {
            AcpError::ConnectionClosed
        } else {
            AcpError::Rpc(error.clone())
        };
        // #416 W2：provider 错误的失败侧感知经 sink（位点不变：账本结算与
        // failure 元数据落定后、幽灵映射清理与错误返回之前）。
        PetReactionSink::new(state.pet.clone()).on_turn_failed(TurnFailureCause::Erred);
        // S3：幽灵映射自动重建——agent 侧会话已不存在（重启/回收后映射滞留）
        // 时清理本地映射，下一条消息自动走会话重建路径；网络/临时错误不清理。
        cleanup_ghost_session_mapping(
            state,
            runtime,
            source,
            &flow.peri_id,
            flow.generation,
            &typed_error,
        );
        Err(PylonError::Protocol(error))
    } else {
        // R33c：成功路径收尾（stop reason 校验 / generation 复核 / 首轮标记 /
        // pylon:done 广播 / B11.2 完成持久化）委托阶段函数，顺序不变。
        let data = raw.result.unwrap_or(serde_json::Value::Null);
        finalize_response(flow, data).await
    }
}

/// #261 拆分：`send_prompt_core_impl` 的 `PromptWaitOutcome::ConnectionClosed`
/// 终态臂（原内联体逐行搬移，行为零变化）——#99 回合终态 ConnectionLost、
/// failure 元数据、pending 清理；崩溃不在此删除映射（自动重连先置 Probing
/// 再收敛，删除会丢待验证证据）。
pub(super) async fn settle_prompt_connection_closed<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    flow: &PromptFlow<'_, R>,
    turn_key: &TurnKey,
    prompt_started_at: std::time::Instant,
    failure: &mut Option<PromptFailureMetadata>,
) -> Result<String, PylonError> {
    // #99：连接关闭 = 回合终态 ConnectionLost（不再悬置）。
    // #442 Step3：CAS Published 时广播 turn-settled（内核事实主轨）。
    let settle_outcome = report_settle(runtime, turn_key, TurnTerminalCause::ConnectionLost, None);
    emit_turn_settled(
        flow.window,
        flow.gateway,
        runtime,
        source,
        turn_key,
        &settle_outcome,
    );
    *failure = Some(PromptFailureMetadata::connection(prompt_started_at));
    runtime.snapshot_acp().remove_pending(flow.request_id);
    // 崩溃不在此删除映射：自动重连会先置 Probing，再用无 prompt 的
    // session/load probe 收敛 Attached/Detached；删除会丢失待验证证据。
    // 方案 I：连接关闭日志携带 request/session/agent 上下文，便于
    // 对齐 ACP wire 时间线定位终态缺失点。
    state.log_runtime_summary(
        "error",
        "prompt",
        Some(source.to_string()),
        "Prompt connection closed",
        serde_json::Map::from_iter([
            (
                "requestId".to_string(),
                serde_json::Value::from(flow.request_id),
            ),
            (
                "sessionId".to_string(),
                serde_json::Value::String(flow.peri_id.clone()),
            ),
            (
                "agentId".to_string(),
                serde_json::Value::String(
                    state
                        .agent_for_runtime(runtime)
                        .map(|a| a.name)
                        .unwrap_or_default(),
                ),
            ),
        ]),
    );
    Err(PylonError::Protocol("ACP connection closed".to_string()))
}

/// #261 拆分：`send_prompt_core_impl` 的 `PromptWaitOutcome::CancelledAfterTimeout`
/// 终态臂（原内联体逐行搬移，行为零变化）——#99 settle 窗口解析映射稳定终态、
/// pending/权限请求收敛、B9 取消挂起权限、映射移除 + close RPC（方案 6）、
/// G2-06 超时文案（真触发边界）与 M5 宠物感知、方案 I 内容状态区分日志。
/// 14 参为 variant 载荷字段 + 等待期标量逐一传递，语义互不分组；结构体重构
/// 收益低（先例：dispatcher reject_interaction_request 的 clippy 备注口径）。
/// （CI 修复：`prompt_started_at` 在本臂未被消费，签名收窄。）
#[allow(clippy::too_many_arguments)]
pub(super) async fn settle_prompt_cancelled_after_timeout<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    flow: &PromptFlow<'_, R>,
    turn_key: &TurnKey,
    response: Option<crate::acp::RawMessage>,
    cancel_error: Option<String>,
    timeout_kind: PromptTimeoutKind,
    timeout_bound: std::time::Duration,
    elapsed: std::time::Duration,
    settle: CancelSettleResolution,
    cancel_settle_timeout_secs: u64,
    configured_prompt_timeout_secs: u64,
    failure: &mut Option<PromptFailureMetadata>,
) -> Result<String, PylonError> {
    // #99：settle 窗口解析映射到稳定终态——窗口内回的终态胜出（含空回合
    // 细分）；窗口超时 = CancelSettleTimeout（触发超时类别进 detail）；
    // 响应通道消失（引擎任务终止）= ConnectionLost。
    let (cause, settle_detail) = match (response.as_ref(), settle) {
        (Some(raw), CancelSettleResolution::Responded) => {
            let detail = raw.error.as_ref().map(|error| error.to_string());
            let cause = if raw.error.is_some() {
                TurnTerminalCause::ProtocolError
            } else {
                let data = raw.result.clone().unwrap_or(serde_json::Value::Null);
                terminal_cause_from_prompt_result(&data)
            };
            (refine_empty_turn(runtime, turn_key, cause), detail)
        }
        (None, CancelSettleResolution::SettleTimeout) => (
            TurnTerminalCause::CancelSettleTimeout,
            Some(format!("triggered_by:{}", timeout_kind.as_str())),
        ),
        (_, CancelSettleResolution::ResponderDropped) => (TurnTerminalCause::ConnectionLost, None),
        // 理论不可达（Responded 必有 response / SettleTimeout 必无）：
        // 保守按协议错误收敛，不猜。
        (Some(_), CancelSettleResolution::SettleTimeout)
        | (None, CancelSettleResolution::Responded) => (
            TurnTerminalCause::ProtocolError,
            Some("inconsistent cancel settle resolution".to_string()),
        ),
    };
    // #442 Step3：CAS Published 时广播 turn-settled（内核事实主轨）。
    let settle_outcome = report_settle(runtime, turn_key, cause, settle_detail);
    emit_turn_settled(
        flow.window,
        flow.gateway,
        runtime,
        source,
        turn_key,
        &settle_outcome,
    );
    runtime.snapshot_acp().remove_pending(flow.request_id);
    if let Some(cancel_error) = cancel_error {
        tracing::warn!("cancel timed-out prompt {}: {}", flow.peri_id, cancel_error);
    }
    // B9：cancel 后应答该 session 挂起的权限请求为 Cancelled
    crate::permission::respond_pending_permissions_cancelled(runtime, &flow.peri_id).await;
    if response.is_none() {
        match state.remove_session_if_matches(runtime, source, &flow.peri_id, flow.generation) {
            Ok(true) => {
                tracing::error!(
                    "cancelled prompt {} did not settle within {}s; removed local session mapping",
                    flow.peri_id,
                    cancel_settle_timeout_secs
                );
                // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
                let _ =
                    close_session_rpc(state, runtime, &flow.peri_id, flow.generation, false).await;
            }
            Ok(false) => {}
            Err(error) => return Err(error.into()),
        }
    }
    // G2-06：超时文案必须使用真正触发的边界，而不是把 prompt 总预算
    // 冒充成 idle/first-token 的实际等待时长。保留旧的前缀，兼容已有
    // provider/前端按 "timed out after Ns" 的轻量解析。
    // 方案 I：区分"流式内容已到、终态缺失"与"完全无输出"——本回合是否收到过
    // assistant 内容（dispatcher 经 collect_response_chunk 写入 last_response_text）。
    let has_streamed_content = {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(source)
            .map(|s| !s.last_response_text.trim().is_empty())
            .unwrap_or(false)
    };
    let timeout_label = match timeout_kind {
        PromptTimeoutKind::FirstToken => "first-token",
        PromptTimeoutKind::Idle => "idle",
        // #352：用户 cancel 判死——"超时"指的是 settle 窗口（等终态）超时。
        PromptTimeoutKind::UserCancel => "user-cancel",
    };
    let timeout_secs = timeout_bound.as_secs().max(1);
    let actual_elapsed_ms = elapsed.as_millis().min(u64::MAX as u128) as u64;
    *failure = Some(PromptFailureMetadata::timeout(
        timeout_label,
        configured_prompt_timeout_secs,
        timeout_secs,
        actual_elapsed_ms,
    ));
    let error = format!(
        "timed out after {timeout_secs}s ({timeout_label} timeout; elapsed {actual_elapsed_ms}ms)"
    );
    // M5 感知：超时 → 发呆（区别于普通失败）。#425 件6：超时位点经 sink
    // （原 `pet::on_timeout` 直呼点）。
    PetReactionSink::new(state.pet.clone()).on_timeout();
    // 方案 I：超时日志区分内容状态 + 携带 request/session/agent 上下文。
    state.log_runtime_summary(
        "error",
        "prompt",
        Some(source.to_string()),
        if has_streamed_content {
            "Prompt timed out (streamed content, missing final response)"
        } else {
            "Prompt timed out (no content streamed)"
        },
        serde_json::Map::from_iter([
            (
                "result".to_string(),
                serde_json::Value::String("timeout".to_string()),
            ),
            (
                "hasStreamedContent".to_string(),
                serde_json::Value::Bool(has_streamed_content),
            ),
            (
                "timeoutKind".to_string(),
                serde_json::Value::String(timeout_label.to_string()),
            ),
            (
                "timeoutBoundSecs".to_string(),
                serde_json::Value::from(timeout_secs),
            ),
            (
                "actualElapsedMs".to_string(),
                serde_json::Value::from(actual_elapsed_ms),
            ),
            (
                "requestId".to_string(),
                serde_json::Value::from(flow.request_id),
            ),
            (
                "sessionId".to_string(),
                serde_json::Value::String(flow.peri_id.clone()),
            ),
            (
                "agentId".to_string(),
                serde_json::Value::String(
                    state
                        .agent_for_runtime(runtime)
                        .map(|a| a.name)
                        .unwrap_or_default(),
                ),
            ),
        ]),
    );
    Err(PylonError::Protocol(error))
}
