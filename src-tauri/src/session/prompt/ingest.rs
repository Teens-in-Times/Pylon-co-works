//! Prompt 域 · journal 写入（域 C）：prompt 生成事件与失败事件的 canonical ingest
//! （draft 终态屏障 + EventService 单轨写入）。
//! W3 重构批次 S1 纯搬移自 session/prompt.rs（行为零变化）。

use super::*;

/// Additive failure provenance carried by `pylon:error`.  The legacy top-level
/// `error` string remains the user-facing compatibility field; this structure
/// lets the renderer distinguish a provider response from a local timeout or
/// transport failure without parsing prose.
#[derive(Debug, Clone, Default)]
pub(super) struct PromptFailureMetadata {
    pub(super) source: &'static str,
    pub(super) timeout_kind: Option<&'static str>,
    pub(super) configured_timeout_secs: Option<u64>,
    pub(super) triggered_timeout_secs: Option<u64>,
    pub(super) actual_elapsed_ms: Option<u64>,
    pub(super) provider_message: Option<String>,
}

impl PromptFailureMetadata {
    pub(super) fn to_json(&self) -> serde_json::Value {
        let mut value = serde_json::Map::new();
        value.insert(
            "source".to_string(),
            serde_json::Value::String(self.source.to_string()),
        );
        if let Some(kind) = self.timeout_kind {
            value.insert(
                "timeoutKind".to_string(),
                serde_json::Value::String(kind.to_string()),
            );
        }
        if let Some(seconds) = self.configured_timeout_secs {
            value.insert(
                "configuredTimeoutSecs".to_string(),
                serde_json::Value::from(seconds),
            );
        }
        if let Some(seconds) = self.triggered_timeout_secs {
            value.insert(
                "triggeredTimeoutSecs".to_string(),
                serde_json::Value::from(seconds),
            );
        }
        if let Some(elapsed) = self.actual_elapsed_ms {
            value.insert(
                "actualElapsedMs".to_string(),
                serde_json::Value::from(elapsed),
            );
        }
        if let Some(message) = self.provider_message.as_deref() {
            value.insert(
                "providerMessage".to_string(),
                serde_json::Value::String(message.to_string()),
            );
        }
        serde_json::Value::Object(value)
    }

    /// S3（W3 重构批次）：failure 元数据构造收口——各终态臂不再散落字面量，
    /// 由下列构造函数装配（字段值与原字面量逐位一致）。
    /// 校验/装配错误发生在 ACP 边界之前时的稳定内部来源。
    pub(super) fn internal() -> Self {
        Self {
            source: "internal",
            ..Default::default()
        }
    }

    /// 连接关闭终态（settle_prompt_connection_closed 臂）。
    pub(super) fn connection(started_at: std::time::Instant) -> Self {
        Self {
            source: "connection",
            actual_elapsed_ms: Some(elapsed_millis(started_at)),
            ..Default::default()
        }
    }

    /// Response 错误臂：provider 错误与传输级连接关闭共用——`connection_closed`
    /// 决定 source 归属与是否透传 provider 文本（连接关闭不透传远端文本）。
    pub(super) fn provider_failure(
        connection_closed: bool,
        provider_error: &str,
        started_at: std::time::Instant,
    ) -> Self {
        Self {
            source: if connection_closed {
                "connection"
            } else {
                "provider"
            },
            actual_elapsed_ms: Some(elapsed_millis(started_at)),
            provider_message: (!connection_closed).then(|| provider_error.to_string()),
            ..Default::default()
        }
    }

    /// cancel-settle 超时终态（settle_prompt_cancelled_after_timeout 臂）。
    pub(super) fn timeout(
        timeout_kind: &'static str,
        configured_timeout_secs: u64,
        triggered_timeout_secs: u64,
        actual_elapsed_ms: u64,
    ) -> Self {
        Self {
            source: "prompt-timeout",
            timeout_kind: Some(timeout_kind),
            configured_timeout_secs: Some(configured_timeout_secs),
            triggered_timeout_secs: Some(triggered_timeout_secs),
            actual_elapsed_ms: Some(actual_elapsed_ms),
            ..Default::default()
        }
    }
}

pub(super) fn elapsed_millis(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis().min(u64::MAX as u128) as u64
}

/// Prompt-generated event 与 dispatcher ACP update 共用 EventService ingest；不持有
/// 独立 sequence/normalizer。平台会话无 GUI Profile，明确跳过本地 journal。
pub(super) async fn ingest_prompt_event(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    remote_session_id: Option<String>,
    generation: u64,
    raw_payload: serde_json::Value,
) -> Result<Option<CanonicalEventRow>, PylonError> {
    let owner = {
        let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions
            .get(source)
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()))?;
        let Some(agent_id) = state.agent_id_for_runtime(runtime) else {
            if session.profile_id.is_some() {
                return Err(PylonError::AgentRuntimeUnavailable {
                    agent_id: "unknown".to_string(),
                });
            }
            return Ok(None);
        };
        session.durable_owner(&agent_id, source)?
    };
    let Some(owner) = owner else {
        return Ok(None);
    };
    if raw_payload
        .pointer("/update/sessionUpdate")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| matches!(kind, "done" | "error" | "cancelled"))
    {
        runtime
            .flush_draft_before_terminal(source, generation)
            .await
            .map_err(PylonError::Protocol)?;
    }
    let result = event_service_of(state)?
        .ingest_event(owner, remote_session_id, generation, raw_payload)
        .await?;
    Ok(result.events.into_iter().next())
}

/// 终帧 additive `turnId` 经独立出参进入本函数（#442 Step2；与
/// `settle_prompt_response` 的 allow 同款——参数列是既有收尾路径形态的顺延）。
#[allow(clippy::too_many_arguments)]
pub(super) async fn publish_prompt_failure<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    ctx: &PromptContext,
    error: &PylonError,
    failure: Option<&PromptFailureMetadata>,
    // #442 Step2：本回合身份（账本 begin 之后发生的错误终态 Some；回合未建立
    // None——帧缺省该字段，不伪造）。
    turn_id: Option<u64>,
) -> Result<(), PylonError> {
    // #420/ADR-0034：错误终态路径的防御纵深——无条件收敛该会话的在途 turn。
    // 正常时终态臂的 report_settle 已结算（active 为空，此处 no-op）；覆盖等待
    // future 被取消等未经终态臂的残余。Published = 真结算了滞留在途（诊断）；
    // cause 取 ProtocolError（RPC error 族），detail 携带错误原文。
    let defensive_settle = runtime.sessions.lock().ok().and_then(|sessions| {
        sessions
            .get(&ctx.source)
            .map(|session| (session.peri_id.clone(), session.generation))
    });
    if let Some((peri_id, generation)) = defensive_settle {
        // #442 Step3：候选回合身份先于防御结算读取（与 settle_active_for_session
        // 同一选择序）；Published 时广播 turn-settled——未经终态臂的残余同样要给
        // 前端一个内核事实主轨的收敛点。
        let defensive_turn_key = runtime
            .turn_ledger
            .active_turn_id_for_session(&ctx.source, &peri_id, generation)
            .map(|turn_id| crate::acp::TurnKey {
                local_session_id: ctx.source.clone(),
                remote_session_id: peri_id.clone(),
                generation,
                turn_id,
            });
        // #707-C：账本写路径单点（session::prompt::ledger）。
        let defensive_outcome = super::ledger::settle_active_for_session_defensively(
            runtime,
            &ctx.source,
            &peri_id,
            generation,
            Some(error.to_string()),
        );
        if let crate::acp::SettleOutcome::Published = defensive_outcome {
            tracing::warn!(
                source = %ctx.source,
                code = %error.code(),
                "prompt failure path defensively settled a residual in-flight turn; \
                 a terminal arm should have settled it (diagnostic)"
            );
        }
        if let Some(turn_key) = defensive_turn_key {
            super::ledger::emit_turn_settled(
                window,
                gateway,
                runtime,
                &ctx.source,
                &turn_key,
                &defensive_outcome,
            );
        }
    }
    let mut error_payload = serde_json::json!({
        "source": ctx.source,
        "code": error.code(),
        "error": error.to_string(),
    });
    // #442 Step2：终帧 additive turnId——前端 stamps 猜测在字段可用时退役
    // （精确归属本回合；回合未建立时缺省）。
    if let Some(turn_id) = turn_id {
        error_payload["turnId"] = serde_json::json!(turn_id);
    }
    if let Some(failure) = failure {
        error_payload["failure"] = failure.to_json();
    }
    if let Some(profile_id) = ctx.profile_id.as_deref() {
        let agent_id = state.agent_id_for_runtime(runtime).ok_or_else(|| {
            PylonError::AgentRuntimeUnavailable {
                agent_id: "unregistered-runtime".to_string(),
            }
        })?;
        let (owner, remote_session_id) = {
            let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
            if let Some(session) = sessions.get(&ctx.source) {
                (
                    session
                        .durable_owner(&agent_id, &ctx.source)?
                        .ok_or_else(|| {
                            PylonError::Protocol(format!(
                                "profile-backed prompt for source {} has no durable owner \
                                 (session profile binding missing)",
                                ctx.source
                            ))
                        })?,
                    Some(session.peri_id.clone()),
                )
            } else {
                let owner = DurableSessionOwner::new(profile_id, &agent_id, &ctx.source);
                owner.validate()?;
                (owner, None)
            }
        };
        let mut update = serde_json::json!({
            "sessionUpdate": "error",
            "errorCode": error.code(),
            "error": error.to_string(),
        });
        if let Some(failure) = failure {
            update["failure"] = failure.to_json();
        }
        let event_service = event_service_of(state)?;
        let connection_lost_with_draft = failure
            .is_some_and(|failure| failure.source == "connection")
            && !event_service
                .list_draft_fragments(
                    owner
                        .key()
                        .map_err(|error| PylonError::Protocol(error.to_string()))?,
                )
                .await?
                .is_empty();
        if !connection_lost_with_draft {
            runtime
                .flush_draft_before_terminal(&ctx.source, state.current_generation(runtime))
                .await
                .map_err(PylonError::Protocol)?;
            let result = event_service
                .ingest_event(
                    owner,
                    remote_session_id,
                    state.current_generation(runtime),
                    serde_json::json!({
                        "source": ctx.source,
                        "update": update,
                    }),
                )
                .await?;
            if let Some(committed_event) = result.events.into_iter().next() {
                error_payload["canonicalEvent"] = serde_json::to_value(committed_event)?;
            }
        } else {
            error_payload["draftInterrupted"] = serde_json::Value::Bool(true);
        }
    }
    if let Some(window) = window {
        emit_event_all(
            window,
            gateway,
            &ctx.source,
            crate::event_names::SESSION_ERROR,
            error_payload.clone(),
        );
    }
    send_channel_terminal(
        state,
        runtime,
        &ctx.source,
        crate::event_names::SESSION_ERROR,
        error_payload,
    );
    Ok(())
}
