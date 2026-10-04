//! 会话持久化域：恢复历史会话 / 会话清单。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

mod load;

pub(crate) use load::{
    __cmd__load_persisted_session, __tauri_command_name_load_persisted_session,
    load_persisted_session,
};

use super::*;
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionLoadResult {
    response: serde_json::Value,
    replay: Vec<serde_json::Value>,
    replay_metadata: crate::acp::ReplayMetadata,
    canonical_revision: i64,
    replay_journal_status: &'static str,
    authority: &'static str,
    journal_coverage: &'static str,
    collection: ReplayCollection,
    import: Option<ReplayImport>,
    diagnostics: Vec<serde_json::Value>,
    /// #99：冷挂载 turn 快照（turnState/terminalCause/sequence/lastError/
    /// replayLoading）——前端恢复只凭本响应，不依赖一次性 Tauri event。
    turn: Option<serde_json::Value>,
    /// #442 Step1：最新回合边界（kind + 两端时间戳，camelCase wire
    /// `turnBoundary`）。账本有记录即权威（journal 终态行的落盘时序不再影响
    /// 结论——前端「或」判定的时序裂缝解法）；账本为空（重启后的历史会话）
    /// 走 journal tail 判据合成（照抄前端 `latestTurnBoundary`，ADR-0029）。
    /// None = 无会话映射或 journal 探测失败（前端回退现有判定轨）。
    turn_boundary: Option<pylon_session::TurnBoundary>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayCollection {
    complete: bool,
    truncated: bool,
    dropped_count: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayImport {
    import_id: String,
    status: &'static str,
    trust: &'static str,
}

/// Stable, machine-readable journal outcome used by the replay trace.  The
/// projection commit is performed by the frontend coordinator and is recorded
/// in its paired `load-commit` trace; this value describes the backend journal
/// stage only.
fn replay_journal_commit_outcome(status: &str) -> &'static str {
    match status {
        "imported" => "recovery-import-committed",
        "already-imported" => "recovery-import-already-present",
        "local-authoritative" => "local-journal-wins",
        "incomplete-not-imported" => "incomplete-preserved-runtime",
        "empty" => "empty",
        _ => "journal-observed",
    }
}

fn replay_load_error_code(error: &crate::acp::AcpError) -> &'static str {
    // #317 批次二 2c：词汇表单源化到 AcpError::code()（本函数保留为回放语义命名点）。
    error.code()
}

/// #442 Step1：账本记录 → `turnBoundary`（账本存在即权威：有 terminal 即收敛、
/// 无即在途，journal 终态行的落盘时序不参与结论——这正是前端跨源「或」判定
/// 被迫存在的时序裂缝，账本路径下按构造消除）。
fn ledger_turn_boundary(turn: &crate::acp::turn_ledger::TurnRecord) -> pylon_session::TurnBoundary {
    match &turn.terminal {
        Some(terminal) => pylon_session::TurnBoundary {
            kind: pylon_session::TurnBoundaryKind::Terminal,
            started_at_ms: Some(turn.started_at_ms),
            ended_at_ms: Some(terminal.settled_at_ms),
        },
        None => pylon_session::TurnBoundary {
            kind: pylon_session::TurnBoundaryKind::Open,
            started_at_ms: Some(turn.started_at_ms),
            ended_at_ms: None,
        },
    }
}

/// #442 Step1：journal tail 判据合成 `turnBoundary`（账本为空的回退数据面：
/// 重启后的历史会话、或本进程从未 prompt 过该 source）。查询失败降级为字段
/// 缺省（前端回退现有判定轨），不阻塞 load 响应。
async fn journal_turn_boundary(
    state: &AppState,
    owner_key: &str,
) -> Option<pylon_session::TurnBoundary> {
    let event_service = crate::session::event_service_of(state).ok()?;
    match event_service
        .turn_boundary_rows(
            owner_key.to_string(),
            pylon_session::turn_boundary::BOUNDARY_TAIL_CAP,
        )
        .await
    {
        Ok(rows) => pylon_session::turn_boundary::derive_turn_boundary(&rows),
        Err(error) => {
            tracing::warn!(
                owner = %owner_key,
                error = %error,
                "turnBoundary journal probe failed; omitting field (frontend keeps its fallback track)"
            );
            None
        }
    }
}

/// load_persisted_session 各失败臂共用的收敛：先回滚本次临时 slot，回滚成功
/// 返回原错误（调用方 `return Err(...)` 上抛），回滚自身失败则上抛回滚错误
/// （与原 `restore_previous_slot(...)?` 的传播序一致：回滚失败优先于原错误）。
/// #261：五处 `rollback + return` 样板收敛到单点。
fn rollback_load_slot_else(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    previous: Option<SessionInfo>,
    original: PylonError,
) -> PylonError {
    match restore_previous_slot(runtime, source, peri_id, generation, previous) {
        Ok(()) => original,
        Err(restore_error) => restore_error,
    }
}

/// P3（W3 重构批次）：persist / revive 两条 load 链共享骨架的载荷类型。
/// `LoadedReplay` 以同形字段（events/metadata）承接 `pylon_acp::replay::ReplayBatch`
/// （该类型未在 crate 边界再导出，不可命名），消费方字段路径不变。
pub(super) struct LoadedReplay {
    pub(super) events: Vec<serde_json::Value>,
    pub(super) metadata: crate::acp::ReplayMetadata,
}

/// [`run_load_with_replay_capture`] 的结果分类。`previous` 归还调用方，供各自
/// 的错误策略（persist = 回滚失败优先上抛；revive = `let _` 忽略回滚错误）消费。
pub(super) enum ReplayLoadOutcome {
    Loaded {
        response: serde_json::Value,
        replay: LoadedReplay,
        previous: Option<SessionInfo>,
    },
    /// 同 owner 已有 load（ReplayLoadInProgress 等无副作用拒绝）；槽位已由
    /// helper 回滚（失败仅记录日志）。
    CaptureRejected { error: crate::acp::AcpError },
    /// load 失败；**槽位未回滚**——两侧回滚时序不同（persist 在 trace 之后、
    /// revive 在内层 generation 检查之后），由调用方按既有次序自行回滚。
    LoadFailed {
        error: crate::acp::AcpError,
        previous: Option<SessionInfo>,
    },
}

/// [`run_load_with_replay_capture`] 入参装配。`log_label` 仅用于 capture 被拒时
/// 回滚失败日志的域标签（persist = "replay"、revive = "revive"，与拆分前逐字一致）。
pub(super) struct ReplayLoadArgs<'a> {
    pub(super) runtime: &'a AgentRuntime,
    pub(super) source: &'a str,
    pub(super) peri_id: &'a str,
    pub(super) generation: u64,
    pub(super) cwd: &'a str,
    pub(super) mcp_servers: Vec<serde_json::Value>,
    pub(super) mode: crate::agent_config::McpServersMode,
    pub(super) loading_session: SessionInfo,
    pub(super) log_label: &'a str,
}

/// P3（W3 重构批次）：persist（`load_persisted_session`）与 revive（create.rs
/// `revive_session_slot`）两条 load 链的同构骨架——「loading 临时槽插入 →
/// begin_replay_capture（锁内原子登记）→ 锁外 load_session_with_replay 等待」
/// 三步逐行等价收敛到单点。两侧**错误策略是契约差异，不在本 helper 内合并**：
/// - persist 侧：capture 被拒 → 上抛原错误；load 失败 → `rollback_load_slot_else`（回滚失败优先于原错误）。
/// - revive 侧：capture 被拒 / load 失败 → 降级 `Ok(None)` 新建；回滚失败仅记录，外层 generation 臂用 `let _` 忽略回滚错误（既有语义，非遗漏）。
///
/// capture 被拒的「回滚 + 失败日志」两侧逐字相同（仅域标签不同），由本 helper
/// 承担；slot 插入失败（`?`）两侧同为 Err 上抛。
pub(super) async fn run_load_with_replay_capture(
    args: ReplayLoadArgs<'_>,
) -> Result<ReplayLoadOutcome, PylonError> {
    let ReplayLoadArgs {
        runtime,
        source,
        peri_id,
        generation,
        cwd,
        mcp_servers,
        mode,
        loading_session,
        log_label,
    } = args;
    let previous = replace_session_slot(
        runtime,
        source,
        loading_session,
        true,
        crate::agent::runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    // A-02/#349 B1：锁内原子建立 replay capture，等待在锁外进行——回放最长 30s，
    // 不阻塞其他命令。若同 owner 已有 load，拒绝新请求并撤销本次临时 slot，避免
    // 失败请求覆盖首个 load 的绑定/状态（ReplayLoadInProgress 是无副作用的拒绝路径）。
    let handles = match runtime.snapshot_acp().begin_replay_capture(peri_id) {
        Ok(handles) => handles,
        Err(error) => {
            if let Err(restore_error) =
                restore_previous_slot(runtime, source, peri_id, generation, previous)
            {
                tracing::error!(
                    source,
                    error = %restore_error,
                    "failed to roll back rejected {log_label} load slot"
                );
            }
            return Ok(ReplayLoadOutcome::CaptureRejected { error });
        }
    };
    // 回放收集与响应等待在锁外进行：load 响应是确定性边界。
    let load_result =
        crate::acp::load_session_with_replay(handles, peri_id, cwd, mcp_servers, mode).await;
    Ok(match load_result {
        Ok((response, batch)) => ReplayLoadOutcome::Loaded {
            response,
            replay: LoadedReplay {
                events: batch.events,
                metadata: batch.metadata,
            },
            previous,
        },
        Err(error) => ReplayLoadOutcome::LoadFailed { error, previous },
    })
}

#[tauri::command]
pub(crate) async fn list_persisted_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let cwd = state.get_active_agent().ok().and_then(|a| a.cwd);
    let mut params = serde_json::json!({});
    if let Some(c) = cwd {
        params["cwd"] = serde_json::Value::String(c);
    }
    let response = state
        .inner()
        .acp_rpc(&runtime, acp::METHOD_SESSION_LIST, params)
        .await?;
    state.ensure_generation(&runtime, generation)?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::{replay_journal_commit_outcome, replay_load_error_code};

    #[test]
    fn replay_trace_journal_outcome_is_machine_readable() {
        assert_eq!(
            replay_journal_commit_outcome("imported"),
            "recovery-import-committed"
        );
        assert_eq!(
            replay_journal_commit_outcome("local-authoritative"),
            "local-journal-wins"
        );
        assert_eq!(
            // #425 件2：词表与 event_repo/service.rs 实际产出对齐——死词
            // `already-present`/`reconciled` 已摘，活词以 `already-imported` 断言。
            replay_journal_commit_outcome("already-imported"),
            "recovery-import-already-present"
        );
        assert_eq!(
            replay_journal_commit_outcome("incomplete-not-imported"),
            "incomplete-preserved-runtime"
        );
        assert_eq!(replay_journal_commit_outcome("empty"), "empty");
    }

    #[test]
    fn replay_trace_error_code_does_not_include_remote_error_text() {
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::Rpc(
                "{\"message\":\"secret\"}".to_string()
            )),
            "rpc_error"
        );
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::ConnectionClosed),
            "connection_closed"
        );
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::ReplayTimeout { seconds: 30 }),
            "replay_timeout"
        );
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::ReplayLagged { count: 7 }),
            "replay_lag"
        );
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::ReplayStreamClosed),
            "replay_transport_error"
        );
    }

    /// #442 Step1：账本记录 → `turnBoundary` 的 wire 映射契约——有 terminal 即
    /// `terminal`（两端时间戳 = 记录 startedAtMs + settledAtMs），无即在途
    /// `open`（只给起点）。账本存在即权威，journal 行不参与该分支。
    #[test]
    fn ledger_turn_boundary_maps_record_to_wire_boundary() {
        use crate::acp::turn_ledger::{
            TurnKey, TurnPhase, TurnRecord, TurnTerminal, TurnTerminalCause,
        };

        fn record(terminal: Option<TurnTerminal>) -> TurnRecord {
            TurnRecord {
                key: TurnKey {
                    local_session_id: "local:s".to_string(),
                    remote_session_id: "remote-1".to_string(),
                    generation: 1,
                    turn_id: 7,
                }
                .snapshot(),
                phase: if terminal.is_some() {
                    TurnPhase::Terminal
                } else {
                    TurnPhase::Prompting
                },
                started_at_ms: 100,
                terminal,
                last_ingress_seq: 0,
                saw_text: false,
                saw_tool: false,
                saw_thinking: false,
            }
        }

        let open = super::ledger_turn_boundary(&record(None));
        assert_eq!(
            serde_json::to_value(&open).unwrap(),
            serde_json::json!({"kind": "open", "startedAtMs": 100})
        );

        let settled = super::ledger_turn_boundary(&record(Some(TurnTerminal {
            cause: TurnTerminalCause::Completed,
            settled_at_ms: 250,
            detail: None,
        })));
        assert_eq!(
            serde_json::to_value(&settled).unwrap(),
            serde_json::json!({"kind": "terminal", "startedAtMs": 100, "endedAtMs": 250})
        );
    }
}
