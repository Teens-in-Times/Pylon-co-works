//! Unknown continuity 的有界会话探针收敛（自 mod.rs 拆分；独立 async 编排，
//! 由 do_connect_and_replace 尾部在锁外调用）。
use std::sync::Arc;

use futures_util::{stream, StreamExt};

use crate::acp::AcpError;
use crate::agent_config::AgentDef;
use crate::runtime::AgentRuntime;

const SESSION_PROBE_CONCURRENCY: usize = 4;
use super::budgets::SESSION_PROBE_HARD_CAP_SECS;

pub(crate) async fn probe_unknown_session_continuity(
    runtime: &Arc<AgentRuntime>,
    agent: &AgentDef,
    candidates: Vec<crate::session::store::SessionProbeCandidate>,
    target_generation: u64,
) {
    if candidates.is_empty() {
        return;
    }
    // #98：探针与 session 建立/revive 消费同一份协商快照——不再用根级
    // `loadSession` 裸路径判断（旧实现与标准嵌套 `sessionCapabilities.loadSession`
    // 不一致：同一 Agent 可能在建立时被判支持 load、重连探针却判不支持）。
    // 快照读取失败按 fail-closed 处理（等价不支持 load → 全部 detached 收敛）。
    let load_supported = crate::acp::capture_negotiated_snapshot(runtime)
        .await
        .map(|snapshot| {
            tracing::debug!(
                target: "capability",
                generation = snapshot.generation,
                "continuity probe consumes the negotiated capability snapshot"
            );
            snapshot.load_supported()
        })
        .unwrap_or(false);
    if !load_supported {
        for candidate in candidates {
            let _ = crate::session::store::mark_detached_if_current(
                runtime,
                &candidate.source,
                &candidate.peri_id,
                candidate.from_generation,
                target_generation,
                "session-load-capability-unavailable".into(),
                false,
                false,
            );
        }
        return;
    }

    let budget = std::time::Duration::from_secs(
        agent
            .protocol()
            .rpc_timeout()
            .min(SESSION_PROBE_HARD_CAP_SECS),
    );
    let deadline = tokio::time::Instant::now() + budget;
    let mode = agent.protocol().mcp_servers;
    let results = stream::iter(candidates)
        .map(|candidate| {
            let runtime = runtime.clone();
            async move {
                let handles = runtime
                    .snapshot_acp()
                    .begin_replay_capture(&candidate.peri_id);
                let handles = match handles {
                    Ok(handles) => handles,
                    Err(error) => return (candidate, Ok(Err(error))),
                };
                let probe = tokio::time::timeout_at(
                    deadline,
                    crate::acp::load_session_with_replay(
                        handles,
                        &candidate.peri_id,
                        &candidate.cwd,
                        Vec::new(),
                        mode,
                    ),
                )
                .await;
                (candidate, probe)
            }
        })
        .buffer_unordered(SESSION_PROBE_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    for (candidate, result) in results {
        match result {
            Ok(Ok((response, _replay))) => {
                let returned_id = response
                    .get("sessionId")
                    .or_else(|| response.get("session_id"))
                    .and_then(serde_json::Value::as_str);
                if returned_id.is_some_and(|id| id != candidate.peri_id) {
                    let _ = crate::session::store::mark_detached_if_current(
                        runtime,
                        &candidate.source,
                        &candidate.peri_id,
                        candidate.from_generation,
                        target_generation,
                        "session-probe-identity-mismatch".into(),
                        false,
                        false,
                    );
                } else {
                    let _ = crate::session::store::mark_attached_if_current(
                        runtime,
                        &candidate.source,
                        &candidate.peri_id,
                        candidate.from_generation,
                        target_generation,
                    );
                }
            }
            Ok(Err(error))
                if error.rpc_failure_kind() == Some(crate::acp::RpcFailureKind::SessionMissing) =>
            {
                let _ = crate::session::store::mark_detached_if_current(
                    runtime,
                    &candidate.source,
                    &candidate.peri_id,
                    candidate.from_generation,
                    target_generation,
                    "remote-session-missing".into(),
                    false,
                    true,
                );
            }
            Ok(Err(error)) => {
                let retryable = error.is_retryable_transport_failure()
                    || error.rpc_failure_kind() == Some(crate::acp::RpcFailureKind::Other);
                let reason = match error.rpc_failure_details() {
                    Some(details) => details
                        .code
                        .map(|code| format!("session-probe-rpc-{code}"))
                        .unwrap_or_else(|| "session-probe-rpc-error".into()),
                    None if matches!(error, AcpError::ConnectionClosed) => {
                        "session-probe-connection-closed".into()
                    }
                    None => "session-probe-transport-error".into(),
                };
                let _ = crate::session::store::mark_detached_if_current(
                    runtime,
                    &candidate.source,
                    &candidate.peri_id,
                    candidate.from_generation,
                    target_generation,
                    reason,
                    retryable,
                    false,
                );
            }
            Err(_) => {
                let _ = crate::session::store::mark_detached_if_current(
                    runtime,
                    &candidate.source,
                    &candidate.peri_id,
                    candidate.from_generation,
                    target_generation,
                    "session-probe-timeout".into(),
                    true,
                    false,
                );
            }
        }
    }
}
