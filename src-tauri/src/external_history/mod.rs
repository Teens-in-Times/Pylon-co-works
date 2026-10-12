//! #364：外部 CLI 历史导入的宿主接线——`pylon-agent-history` 解析 IR，
//! 经 `EventService::ingest_external_history` 落 canonical journal。
//!
//! 零 runtime 路由（同 evt_* 家族：本地 SQLite 直查，无 ACP wire）；owner 是
//! 保留字三元组（`profile_id="external-import"`），幂等键 = (agent_id, 原生
//! external_id)，force 分叉按 `#N` 后缀找空 journal。首版 tracer 只挂
//! Claude Code 一家；第二家（Codex）接入时在本模块注册解析器即可（trait 同构）。

use std::path::PathBuf;
use std::sync::Arc;

use pylon_agent_history::{ClaudeCodeParser, ExternalHistoryParser, ExternalSessionSummary};
use pylon_session::event_repo::{EventService, ExternalHistoryImportResult};
use pylon_session::owner::DurableSessionOwner;
use serde::Serialize;

use crate::error::PylonError;
use crate::AppState;

/// home 解析（与 pylon-core `resolved_home_dir` 同语义：USERPROFILE 优先、HOME
/// 兜底——Windows / Unix 各取其一）。
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// 首版 tracer：Claude Code（第二家接入时换成 Vec<dyn ExternalHistoryParser>）。
fn parser() -> ClaudeCodeParser {
    ClaudeCodeParser
}

fn projects_root() -> Result<PathBuf, PylonError> {
    let home =
        home_dir().ok_or_else(|| PylonError::Protocol("home directory unavailable".into()))?;
    Ok(home.join(pylon_agent_history::CLAUDE_CODE_PROJECTS_DIR))
}

/// 单会话导入结果（前端按 status 分支：`imported` / `already-imported` /
/// `not-found` / 失败经 PylonError code）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionImportOutcome {
    pub external_id: String,
    pub title: Option<String>,
    pub status: &'static str,
    pub imported_event_count: usize,
}

/// 扫描本机 Claude Code 历史，返回会话摘要（不写库）。
#[tauri::command]
pub(crate) async fn external_history_scan() -> Result<Vec<ExternalSessionSummary>, PylonError> {
    let root = projects_root()?;
    let summaries = tokio::task::spawn_blocking(move || parser().discover(&root))
        .await
        .map_err(|error| PylonError::Protocol(format!("scan task failed: {error}")))?;
    Ok(summaries)
}

/// 导入会话：`external_ids = None` 表示全部扫描结果。`force = true` 时对已导入
/// 会话生成分叉副本（`#N` 后缀找空 journal，原快照封存不动）。
#[tauri::command]
pub(crate) async fn external_history_import(
    state: tauri::State<'_, AppState>,
    external_ids: Option<Vec<String>>,
    force: bool,
) -> Result<Vec<SessionImportOutcome>, PylonError> {
    let service = crate::session::event_service_of(state.inner()).map_err(PylonError::from)?;
    let root = projects_root()?;
    let summaries = tokio::task::spawn_blocking(move || parser().discover(&root))
        .await
        .map_err(|error| PylonError::Protocol(format!("scan task failed: {error}")))?;
    let wanted: Option<Vec<String>> = external_ids;
    let mut outcomes = Vec::new();
    for summary in summaries {
        if let Some(ids) = &wanted {
            if !ids.contains(&summary.external_id) {
                continue;
            }
        }
        let outcome = import_one(&service, &summary, force).await?;
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

async fn import_one(
    service: &Arc<EventService>,
    summary: &ExternalSessionSummary,
    force: bool,
) -> Result<SessionImportOutcome, PylonError> {
    let root = projects_root()?;
    let external_id = summary.external_id.clone();
    let record = tokio::task::spawn_blocking(move || parser().read(&root, &external_id))
        .await
        .map_err(|error| PylonError::Protocol(format!("read task failed: {error}")))?
        .map_err(|error| PylonError::Protocol(format!("external history read: {error}")))?;
    let events: Vec<(String, std::sync::Arc<serde_json::Value>)> = record
        .events
        .into_iter()
        .map(|event| (event.occurred_at, std::sync::Arc::new(event.payload)))
        .collect();
    // force 分叉：#2/#3… 找空 journal；普通导入 owner 无后缀（service 幂等探针
    // 会拦下已导入会话）。
    let mut result: Option<ExternalHistoryImportResult> = None;
    let mut suffixes: Vec<String> = vec![String::new()];
    if force {
        suffixes.extend((2..=99).map(|n| format!("#{n}")));
    }
    for suffix in &suffixes {
        let local_session_id = format!("{}:{}{}", summary.agent_id, summary.external_id, suffix);
        let owner = DurableSessionOwner::new(
            pylon_canonical_types::EXTERNAL_IMPORT_PROFILE_ID,
            &summary.agent_id,
            &local_session_id,
        );
        let owner_key = owner
            .key()
            .map_err(|error| PylonError::Protocol(format!("owner key: {error}")))?;
        if service.revision(owner_key).await? > 0 {
            continue;
        }
        result = Some(
            service
                .ingest_external_history(
                    owner,
                    summary.external_id.clone(),
                    force && !suffix.is_empty(),
                    events.clone(),
                )
                .await?,
        );
        break;
    }
    let result = result
        .ok_or_else(|| PylonError::Protocol("no free journal slot for external import".into()))?;
    Ok(SessionImportOutcome {
        external_id: summary.external_id.clone(),
        title: summary.title.clone(),
        status: result.status,
        imported_event_count: result.events.len(),
    })
}
