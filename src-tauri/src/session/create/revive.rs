//! ACP 原生会话复活（#486 项3 自 create.rs 拆出；行为不变——resume/load 两通道臂
//! 原文搬移为子函数，编排次序、日志键序与槽位回滚时序逐字保留）。
//!
//! #349 B1：load 与 persist/lifecycle/export 同构走 replay capture——先插
//! loading 槽（replay_loading=true）再 `begin_replay_capture`，回放帧在传输
//! 边界被分类为 Replay 并随映射立即解析（不再逐条 100ms 未知会话等待），
//! 既不进 canonical journal（persist_canonical=false），也不做本地导入：
//! journal 是唯一 durable 权威，回放内容丢弃，load 响应只用于挂载判定。
//! resume 通道保持既有裸 RPC（resume 语义是挂靠在途会话，其后帧属 live）。

use super::super::{persist, AppState};
use super::{
    ingest_established_config_options_event, replace_session_slot, response_projection_options,
    SessionAssembly, SessionMapping,
};
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::session::model::SessionInfo;
use std::sync::Arc;

/// resume 通道臂（原文 :1193-1235）：RPC 成功 → Some(response)；失败 → 代际复核后
/// 带typed reason 记 fallback，返回 None 交给 load 臂。
#[allow(clippy::too_many_arguments)]
async fn resume_channel_response(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    generation: u64,
    peri_id: &str,
    session_cwd: &str,
) -> Result<Option<serde_json::Value>, PylonError> {
    let resume_params =
        crate::acp::resume_params(peri_id, session_cwd).map_err(PylonError::Protocol)?;
    match state
        .acp_rpc_generation_checked(
            runtime,
            crate::acp::METHOD_SESSION_RESUME,
            resume_params,
            generation,
        )
        .await
    {
        Ok(response) => {
            tracing::info!(
                target: "replay_trace",
                owner = source,
                runtime_generation = generation,
                recovery_method = "resume",
                result = "success",
                response_boundary = "observed",
                canonical_import = "none",
                "session/resume recovery attempt"
            );
            Ok(Some(response))
        }
        Err(error) => {
            state.ensure_generation(runtime, generation)?;
            tracing::info!(
                target: "replay_trace",
                owner = source,
                runtime_generation = generation,
                recovery_method = "resume",
                result = "fallback",
                failure_class = ?error.recovery_failure_class(),
                response_boundary = "error",
                "session/resume recovery attempt"
            );
            Ok(None)
        }
    }
}

// 与 persist::ReplayLoadOutcome 同形的三终态臂枚举：Loaded 按值携带响应与
// 旧槽位（单值语义、 immediate 消费），Box 化徒增一次堆搬运；同 PumpStep 先例
// 定点豁免。
#[allow(
    clippy::large_enum_variant,
    reason = "Loaded 臂按值携带 load 响应与旧槽位，与 ReplayLoadOutcome 同形；单值即消费，Box 化与热路径降分配方向相悖"
)]
enum LoadArmOutcome {
    /// capture 被拒 / load 失败（槽位回滚与 fallback 日志已在本臂内完成）→
    /// 调用方降级 new（Ok(None)）。
    Fallback,
    Loaded {
        response: serde_json::Value,
        previous: Option<SessionInfo>,
    },
}

/// load 通道臂（原文 :1266-1413 的 `None =>` 内层）：replay capture 骨架 +
/// 三终态臂。capture 被拒/load 失败 → `Fallback`（错误策略保持原样：降级
/// Ok(None)）；Loaded 先做内层代际复核（失配撤销临时槽后按 Err 传播，检查
/// 先于 load 错误消费——既有次序）。
#[allow(clippy::too_many_arguments)]
async fn load_channel_outcome(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    generation: u64,
    peri_id: &str,
    session_cwd: &str,
    profile_id: Option<&str>,
    wire_mcp_servers: &[serde_json::Value],
) -> Result<LoadArmOutcome, PylonError> {
    // #349 B1：与 persist.rs（load_persisted_session）同构——loading 槽
    // 先入（回放帧经映射立即解析，不再走未知会话 100ms 等待；replay 分
    // 类帧被 replay_loading 抑制流式转发），capture 锁内原子登记后锁外
    // 等待。回放帧在传输边界命中 active replay 登记被分类为 Replay，
    // 不进 canonical journal（persist_canonical=false）。
    let mut loading_session = SessionInfo::new(
        peri_id.to_string(),
        String::new(),
        session_cwd.to_string(),
        true,
        generation,
    );
    loading_session.profile_id = profile_id.map(str::to_string);
    loading_session.replay_loading = true;
    // P3（W3 重构批次）：loading 槽插入 → capture → 锁外 load 收敛到共享
    // helper（persist.rs load_persisted_session 同构骨架）；revive 侧错误
    // 策略保持原样——capture 被拒/load 失败均降级 Ok(None)（capture 被拒
    // 的槽位回滚 + 失败日志在 helper 内，域标签 revive）；load 失败的回滚
    // 时序（内层 generation 检查之后）由下方各臂自持。
    let outcome = persist::run_load_with_replay_capture(persist::ReplayLoadArgs {
        runtime,
        source,
        peri_id,
        generation,
        cwd: session_cwd,
        mcp_servers: wire_mcp_servers.to_vec(),
        mode: state.protocol_for_runtime(runtime).mcp_servers,
        loading_session,
        log_label: "revive",
    })
    .await?;
    match outcome {
        persist::ReplayLoadOutcome::CaptureRejected { error } => {
            // 同 owner 已有 load（如 continuity probe 抢先登记）：槽位已由
            // helper 回滚（失败仅记录）后按 revive 失败降级 new（无副作用
            // 拒绝路径，同 persist）。
            tracing::info!(
                target: "replay_trace",
                owner = source,
                runtime_generation = generation,
                recovery_method = "new",
                result = "fallback",
                failed_method = "load",
                failure_class = ?error.recovery_failure_class(),
                response_boundary = "error",
                canonical_import = "none",
                "session/new recovery fallback"
            );
            state.log_runtime_summary(
                "info",
                "session",
                Some(source.to_string()),
                "Session revive via session/load failed; falling back to session/new",
                serde_json::Map::from_iter([
                    (
                        "periId".to_string(),
                        serde_json::Value::String(peri_id.to_string()),
                    ),
                    (
                        "error".to_string(),
                        serde_json::Value::String(error.to_string()),
                    ),
                ]),
            );
            Ok(LoadArmOutcome::Fallback)
        }
        persist::ReplayLoadOutcome::LoadFailed { error, previous } => {
            // 内层 generation 失配保持既有 Err 传播语义（revive_tests 断言
            // 失败后不留槽位），传播前先撤销临时 loading 槽（既有 `let _`
            // 忽略回滚错误）；该检查先于 load 错误消费（既有次序）。
            if let Err(generation_error) = state.ensure_generation(runtime, generation) {
                let _ =
                    super::restore_previous_slot(runtime, source, peri_id, generation, previous);
                return Err(generation_error.into());
            }
            if let Err(restore_error) =
                super::restore_previous_slot(runtime, source, peri_id, generation, previous)
            {
                tracing::error!(
                    source,
                    error = %restore_error,
                    "failed to roll back failed revive load slot"
                );
            }
            // A3：回退到 `new` 也是回退，必须与 resume 分支一样带上 typed reason；
            // 旧行为在此丢弃了 load 错误，使 `resume -> load -> new` 链条中
            // 最后一次回退没有可诊断的原因。
            tracing::info!(
                target: "replay_trace",
                owner = source,
                runtime_generation = generation,
                recovery_method = "new",
                result = "fallback",
                failed_method = "load",
                failure_class = ?error.recovery_failure_class(),
                response_boundary = "error",
                canonical_import = "none",
                "session/new recovery fallback"
            );
            state.log_runtime_summary(
                "info",
                "session",
                Some(source.to_string()),
                "Session revive via session/load failed; falling back to session/new",
                serde_json::Map::from_iter([
                    (
                        "periId".to_string(),
                        serde_json::Value::String(peri_id.to_string()),
                    ),
                    (
                        "error".to_string(),
                        serde_json::Value::String(error.to_string()),
                    ),
                ]),
            );
            Ok(LoadArmOutcome::Fallback)
        }
        persist::ReplayLoadOutcome::Loaded {
            response,
            replay,
            previous,
        } => {
            // 内层 generation 失配：同上（既有检查先于 load 结果消费）。
            if let Err(generation_error) = state.ensure_generation(runtime, generation) {
                let _ =
                    super::restore_previous_slot(runtime, source, peri_id, generation, previous);
                return Err(generation_error.into());
            }
            // #349 B1：回放内容丢弃（canonical journal 是唯一 durable 权威，与
            // persist/lifecycle/export 一致）；仅以响应做挂载判定，观测计数留痕。
            tracing::info!(
                target: "replay_trace",
                owner = source,
                runtime_generation = generation,
                recovery_method = "load",
                result = "success",
                response_boundary = "observed",
                capture_lp = "active-replay-registry",
                observed_count = replay.metadata.boundary.observed_count,
                dropped_count = replay.metadata.dropped_count,
                canonical_import = "none",
                "session/load recovery attempt"
            );
            Ok(LoadArmOutcome::Loaded { response, previous })
        }
    }
}

/// ACP 原生会话复活：session/load 成功后重建本地槽位并 Attached。
/// 返回 Ok(None) = 复活不可行/失败，调用方降级新建；不返回 Err（load 失败
/// 留给新建路径统一报告，避免双重报错；generation 失配仍按 Err 传播）。
pub(super) async fn revive_session_slot(
    assembly: &SessionAssembly<'_>,
    peri_id: &str,
) -> Result<Option<SessionMapping>, PylonError> {
    let SessionAssembly {
        state,
        runtime,
        source,
        profile_id,
        session_cwd,
        wire_mcp_servers,
        ..
    } = *assembly;
    let generation = state.current_generation(runtime);
    // B2/#98：建立通道 = catalog 声明顺序 ∩ 服务端能力广告，真源是协商快照
    // （与 continuity probe、agent_status 消费同一份）。声明侧是 connect 时按
    // provider 解析的 establishment_order（无 profile = 默认 resume→load→new，
    // 与旧行为一致）；广告侧 canonical 嵌套 object 优先、根级 alias 仅兼容表
    // 登记（load）生效。resume/load 任一不满足即跳过该通道，new 恒备。
    let capability_snapshot = crate::acp::capture_negotiated_snapshot(runtime)
        .await
        .map_err(PylonError::Protocol)?;
    let establishment_channels = capability_snapshot
        .establishment_channels()
        .map_err(PylonError::Protocol)?;
    // resume 通道 gate = 协商（广告 ∧ catalog 声明，与 load 对称）；纯广告视图
    // 只用于下面的 raw 平价断言。
    let resume_negotiated = capability_snapshot.negotiated("resume");
    {
        // Keep the protocol projection as a parity assertion while the typed
        // snapshot is the actual decision source.
        let acp = runtime.snapshot_acp();
        debug_assert_eq!(
            capability_snapshot.advertised("resume"),
            crate::acp::resume_capability_advertised(
                acp.capabilities().raw().unwrap_or(&serde_json::Value::Null)
            )
        );
    }
    let response = if resume_negotiated {
        resume_channel_response(state, runtime, source, generation, peri_id, session_cwd).await?
    } else {
        None
    };
    // #349 B1：load 臂预插的临时 loading 槽在**外层** generation 检查失败时
    // 也必须撤销——内层检查（load 响应返回处）与外层检查之间存在多线程交叉
    // 窗口，Err 从外层 `?` 传播时槽位尚未恢复会持续抑制该 source 的 live 投影。
    // 故把 `previous` 带出 match，供外层失败路径恢复。
    let (response, pending_restore) = match response {
        Some(response) => (response, None),
        None if !establishment_channels
            .contains(&crate::acp::initialize_plan::EstablishmentChannel::Load) =>
        {
            // B2：服务端未广告 loadSession（或声明不含 load）——跳过 load，typed
            // reason 记录后直接走 new 回退。
            tracing::info!(
                target: "replay_trace",
                owner = source,
                runtime_generation = generation,
                recovery_method = "load",
                result = "skipped_not_advertised",
                response_boundary = "not-sent",
                canonical_import = "none",
                "session/load skipped: channel not in declared∩advertised intersection"
            );
            state.log_runtime_summary(
                "info",
                "session",
                Some(source.to_string()),
                "Session load not advertised; falling back to session/new",
                serde_json::Map::new(),
            );
            return Ok(None);
        }
        None => {
            match load_channel_outcome(
                state,
                runtime,
                source,
                generation,
                peri_id,
                session_cwd,
                profile_id,
                wire_mcp_servers,
            )
            .await?
            {
                LoadArmOutcome::Fallback => return Ok(None),
                LoadArmOutcome::Loaded { response, previous } => (response, Some(previous)),
            }
        }
    };
    if let Err(error) = state.ensure_generation(runtime, generation) {
        // 外层 generation 失配：先撤销预插的 loading 槽（若有）再传播——
        // Err 语义与既有外层 `?` 一致，差异只在槽位恢复。
        if let Some(previous) = pending_restore {
            let _ = super::restore_previous_slot(runtime, source, peri_id, generation, previous);
        }
        return Err(error.into());
    }
    let revived_peri_id =
        crate::acp::session_id_from(&response).unwrap_or_else(|_| peri_id.to_string());
    let mut session = SessionInfo::new(
        revived_peri_id.clone(),
        String::new(),
        session_cwd.to_string(),
        false,
        generation,
    );
    session.profile_id = profile_id.map(str::to_string);
    session.apply_session_response(&response);
    let _replaced = replace_session_slot(
        runtime,
        source,
        session,
        true,
        crate::agent::runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    let attached = crate::session::store::mark_attached_if_current(
        runtime,
        source,
        &revived_peri_id,
        generation,
        generation,
    )
    .map_err(|error| PylonError::Protocol(error.to_string()))?;
    if !attached {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    state.log_runtime_summary(
        "info",
        "session",
        Some(source.to_string()),
        "Session revived via ACP session/load",
        serde_json::Map::from_iter([(
            "periId".to_string(),
            serde_json::Value::String(revived_peri_id.clone()),
        )]),
    );
    // #51：revive 槽位的 new_response 为 None（不向调用方回传响应），前端 document
    // 因此拿不到选择器面——把 load/resume 响应里的 configOptions 写进 journal，
    // 经 live/replay 同通道收敛到 document.session.options。
    let revived_options = response_projection_options(&response);
    let _ = ingest_established_config_options_event(
        state,
        runtime,
        source,
        &revived_peri_id,
        generation,
        &revived_options,
    )
    .await;
    Ok(Some(SessionMapping {
        peri_id: revived_peri_id,
        is_first: false,
        new_response: None,
    }))
}
