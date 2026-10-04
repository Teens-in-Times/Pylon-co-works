//! registry 读侧命令与查询助手（自 mod.rs 拆分；独立命令各拿各的锁，无跨 await 持锁）。
use std::collections::HashMap;

use super::summary::{agent_summary_payload, agent_summary_payload_with_activation};
use crate::agent::runtime::AgentLifecycleStatus;
use crate::agent_config::{AgentDef, ToolDictEntry};
use crate::error::PylonError;
use crate::{AppState, AppStateHandles};

/// registry 是否包含指定 agent（switch 前置存在性检查用，不克隆）。
pub(crate) fn agent_exists_in_registry(state: &AppState, agent_id: &str) -> bool {
    state
        .agents
        .lock()
        .map(|agents| agents.contains_key(agent_id))
        .unwrap_or(false)
}

/// 从 registry 读取指定 agent 定义（克隆）；不存在报 unknown agent（多处命令共用）。
pub(crate) fn agent_from_registry(
    state: &AppState,
    agent_id: &str,
) -> Result<AgentDef, PylonError> {
    state
        .agents
        .lock()
        .map_err(|error| error.to_string())?
        .get(agent_id)
        .cloned()
        .ok_or_else(|| PylonError::Protocol(format!("unknown agent: {agent_id}")))
}

#[tauri::command]
pub(crate) async fn list_agents(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, PylonError> {
    let active_id = state
        .active_agent
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let active_status = state
        .active_runtime()
        .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.status))
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    Ok(state
        .agents
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|(id, a)| {
            // O11：crashed 感知——per-agent runtime 的 acp 是否已死
            // （try_read：读路径不等待换装写锁；写锁占用或中毒时视为未崩溃）。
            let runtime = state.runtimes.get(id);
            let crashed = runtime.as_ref().is_some_and(|runtime| {
                runtime
                    .acp
                    .try_read()
                    .map(|acp| acp.is_crashed())
                    .unwrap_or(false)
            });
            let activated_fingerprint = runtime.as_ref().and_then(|runtime| {
                runtime
                    .agent_runtime
                    .lock()
                    .ok()
                    .and_then(|state| state.activated_config_fingerprint.clone())
            });
            agent_summary_payload_with_activation(
                id,
                a,
                Some(&active_id),
                Some(active_status),
                crashed,
                activated_fingerprint.as_deref(),
            )
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn set_session_state(
    owner: crate::session::DurableSessionOwner,
    remote_session_id: Option<String>,
    state: serde_json::Value,
    app_state: tauri::State<'_, crate::AppState>,
) -> Result<(), PylonError> {
    // #317 批次二：错误经 PylonError::MessagePersistence 委托，wire code 逐字不变。
    let service = crate::session::message_service_of(&app_state)?;
    service
        .set_session_state(owner, remote_session_id, state)
        .await
        .map_err(PylonError::from)
}

#[tauri::command]
pub(crate) async fn list_tool_dictionary() -> Result<HashMap<String, Vec<ToolDictEntry>>, PylonError>
{
    Ok(crate::agent_config::load_tool_dictionary()?)
}

#[tauri::command]
pub(crate) async fn validate_agents() -> Result<serde_json::Value, PylonError> {
    let agents = crate::agent_config::load()?;
    let default_agent_id = crate::agent_config::default_agent_id(&agents)?;
    let summaries = agents
        .iter()
        .map(|(id, agent)| agent_summary_payload(id, agent, None, None, false))
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "valid": true,
        "defaultAgentId": default_agent_id,
        "agents": summaries,
    }))
}

#[tauri::command]
pub(crate) async fn agent_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    // P2-3：崩溃检测显式前置（acp 已死 → 记录 Crashed + lastError），
    // 随后 getter 只读构造 payload——响应形状（status/lastError/recentError/error）
    // 是前端契约，保持不变。
    let runtime = inner.active_runtime();
    AppStateHandles::detect_and_record_crashes(runtime.as_deref());
    Ok(inner.agent_status_payload())
}

/// OBS-01/OBS-02 读取端：返回当前 active agent 的 ACP wire 记录快照。
/// 记录器在 transport 边界持续写入（脱敏、环形 4096 条有界）；此前只有写没有读。
/// 本命令把读取路径接通，供 devtools/诊断面板后续消费。
#[tauri::command]
pub(crate) async fn acp_wire_trace_snapshot(
    state: tauri::State<'_, AppState>,
    format: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    let runtime = inner.active_runtime().ok_or(PylonError::NoActiveAgent)?;
    let acp = runtime.snapshot_acp();
    let trace = acp
        .wire_trace()
        .ok_or_else(|| PylonError::Acp("wire trace unavailable".to_string()))?;
    if format.as_deref() == Some("jsonl") {
        const MAX_BYTES: usize = 4 * 1024 * 1024;
        return serde_json::to_value(trace.snapshot_jsonl(MAX_BYTES))
            .map_err(|error| PylonError::Acp(format!("wire JSONL export failed: {error}")));
    }
    let records = trace.snapshot();
    // #260-A2：单次持锁批量 correlate，替代逐条记录各取一次锁的旧路径；输出不变。
    let ordinals: Vec<u64> = records.iter().map(|record| record.monotonic_seq).collect();
    let correlations = trace.correlate_many(&ordinals);
    let canonical_correlations: Vec<_> = records
        .iter()
        .zip(correlations)
        .filter_map(|(record, correlation)| {
            correlation.map(|correlation| {
                serde_json::json!({
                    "ordinal": record.monotonic_seq,
                    "correlation": correlation,
                })
            })
        })
        .collect();
    Ok(serde_json::json!({
        "traceId": trace.trace_id(),
        "length": trace.len(),
        "records": records,
        "canonicalCorrelations": canonical_correlations,
    }))
}
