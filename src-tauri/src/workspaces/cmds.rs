//! Workspace/Git commands resolved from an explicit persisted-session target.
use crate::{error::PylonError, git, session::UserDataKey, workspace, AppState};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceTargetWire {
    session_id: String,
    agent_id: String,
    source: String,
    workspace_id: Option<String>,
    legacy_workdir: Option<String>,
}

fn required(value: &str, field: &str) -> Result<(), PylonError> {
    if value.trim().is_empty() {
        Err(PylonError::Workspace(format!(
            "workspace target {field} is empty"
        )))
    } else {
        Ok(())
    }
}

async fn validate_persisted_owner(
    state: &AppState,
    target: &WorkspaceTargetWire,
) -> Result<(), PylonError> {
    let service = state
        .user_data_service
        .lock()
        .map_err(|_| PylonError::Workspace("user data service lock poisoned".into()))?
        .clone();
    let Some(service) = service else {
        return Err(PylonError::Workspace(
            "user data service unavailable".into(),
        ));
    };
    let envelope = service
        .load(UserDataKey::Sessions)
        .await
        .map_err(|error| PylonError::Workspace(error.to_string()))?;
    let sessions = envelope
        .as_ref()
        .and_then(|value| value.payload.get("sessions"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| PylonError::SessionNotFound(target.session_id.clone()))?;
    let session = sessions
        .iter()
        .find(|session| {
            session.get("id").and_then(serde_json::Value::as_str)
                == Some(target.session_id.as_str())
        })
        .ok_or_else(|| PylonError::SessionNotFound(target.session_id.clone()))?;
    if session.get("agentId").and_then(serde_json::Value::as_str) != Some(target.agent_id.as_str())
        || session.get("source").and_then(serde_json::Value::as_str) != Some(target.source.as_str())
    {
        return Err(PylonError::Workspace(format!(
            "workspace target owner mismatch for session {}",
            target.session_id
        )));
    }
    Ok(())
}

async fn workspace_root_for_target(
    state: &AppState,
    target: &WorkspaceTargetWire,
) -> Result<std::path::PathBuf, PylonError> {
    required(&target.session_id, "sessionId")?;
    required(&target.agent_id, "agentId")?;
    required(&target.source, "source")?;
    validate_persisted_owner(state, target).await?;
    let root = if let Some(workspace_id) = target
        .workspace_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
    {
        state
            .workspace_root_path(workspace_id)
            .ok_or_else(|| PylonError::Workspace(format!("workspace not found: {workspace_id}")))?
    } else {
        target
            .legacy_workdir
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| {
                PylonError::Workspace(
                    "workspace target has neither workspaceId nor legacyWorkdir".into(),
                )
            })?
            .to_string()
    };
    let path = std::path::PathBuf::from(root);
    if path.is_relative() {
        return Err(PylonError::Workspace(
            "workspace target root must be absolute".into(),
        ));
    }
    Ok(path)
}

#[tauri::command]
pub(crate) async fn get_workspace_root(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
) -> Result<workspace::WorkspaceRoot, PylonError> {
    let root = workspace_root_for_target(state.inner(), &target).await?;
    Ok(workspace::workspace_root(target.source, &root))
}

#[tauri::command]
pub(crate) async fn list_workspace_entries(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    relative_path: Option<String>,
    include_hidden: Option<bool>,
) -> Result<Vec<workspace::WorkspaceEntry>, PylonError> {
    let root = workspace_root_for_target(state.inner(), &target).await?;
    let relative_path = relative_path.unwrap_or_else(|| ".".to_string());
    let include_hidden = include_hidden.unwrap_or(false);
    // #488 批④：目录枚举是走盘的阻塞 fs，与 workspace_search 同口径经
    // spawn_blocking 移出 async 运行时。
    tokio::task::spawn_blocking(move || {
        workspace::list_entries(&root, &relative_path, include_hidden)
    })
    .await
    .map_err(|error| PylonError::Workspace(error.to_string()))?
    .map_err(|error| PylonError::Workspace(error.to_string()))
}

#[tauri::command]
pub(crate) async fn read_workspace_text(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    relative_path: String,
    max_bytes: Option<usize>,
) -> Result<workspace::WorkspaceTextPreview, PylonError> {
    let root = workspace_root_for_target(state.inner(), &target).await?;
    workspace::read_text(&root, &relative_path, max_bytes)
        .map_err(|error| PylonError::Workspace(error.to_string()))
}

#[tauri::command]
pub(crate) async fn write_workspace_text(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    relative_path: String,
    content: String,
    expected_baseline: Option<String>,
    force: Option<bool>,
) -> Result<workspace::WorkspaceTextPreview, PylonError> {
    let root = workspace_root_for_target(state.inner(), &target).await?;
    workspace::write_text(
        &root,
        &relative_path,
        &content,
        expected_baseline.as_deref(),
        force.unwrap_or(false),
    )
    .map_err(|error| PylonError::Workspace(error.to_string()))
}

#[tauri::command]
pub(crate) async fn workspace_search(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<workspace::WorkspaceSearchResult>, PylonError> {
    let root = workspace_root_for_target(state.inner(), &target).await?;
    let limits = workspace::default_search_limits(max_results);
    tokio::task::spawn_blocking(move || workspace::search(&root, &query, limits))
        .await
        .map_err(|error| PylonError::Workspace(error.to_string()))?
        .map_err(|error| PylonError::Workspace(error.to_string()))
}

/// 0-C1：quick open 文件名索引——全仓文件枚举（有界），spawn_blocking 走盘。
#[tauri::command]
pub(crate) async fn list_workspace_files(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    max_entries: Option<usize>,
) -> Result<workspace::WorkspaceFileIndexPage, PylonError> {
    let root = workspace_root_for_target(state.inner(), &target).await?;
    tokio::task::spawn_blocking(move || workspace::list_workspace_files(&root, max_entries))
        .await
        .map_err(|error| PylonError::Workspace(error.to_string()))?
        .map_err(|error| PylonError::Workspace(error.to_string()))
}

/// 0-C2：单文件两版本全文（diff 前端化/冲突流数据面）。rev 白名单：hash/HEAD(~N)/:0-:3。
#[tauri::command]
pub(crate) async fn git_show_file(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    rev: String,
    path: String,
) -> Result<String, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_show_file(&root, &rev, &path)
        .await
        .map_err(PylonError::Git)
}

/// 0-C2：merge/rebase/cherry-pick 进行态 + 冲突文件清单。
#[tauri::command]
pub(crate) async fn git_sequence_state(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
) -> Result<git::GitSequenceState, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_sequence_state(&root)
        .await
        .map_err(PylonError::Git)
}

async fn git_workspace_root(
    state: &AppState,
    target: &WorkspaceTargetWire,
) -> Result<std::path::PathBuf, PylonError> {
    workspace_root_for_target(state, target)
        .await
        .map_err(|error| PylonError::Git(error.to_string()))
}

#[tauri::command]
pub(crate) async fn git_status(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
) -> Result<Vec<git::GitStatusEntry>, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    Ok(git::git_status(&root)
        .await
        .map_err(PylonError::Git)?
        .entries)
}

#[tauri::command]
pub(crate) async fn git_status_with_branch(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
) -> Result<git::GitStatusResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_status(&root).await.map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_diff(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_diff(&root, path.as_deref(), staged.unwrap_or(false))
        .await
        .map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_history(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    limit: Option<usize>,
) -> Result<Vec<git::GitCommit>, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_history(&root, limit)
        .await
        .map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_stage(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    paths: Vec<String>,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_stage(&root, &paths).await.map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_unstage(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    paths: Vec<String>,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_unstage(&root, &paths)
        .await
        .map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_commit(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    message: String,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_commit(&root, &message)
        .await
        .map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_create_branch(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    name: String,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_create_branch(&root, &name)
        .await
        .map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_switch_branch(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    name: String,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_switch_branch(&root, &name)
        .await
        .map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_pull(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_pull(&root).await.map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_push(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_push(&root).await.map_err(PylonError::Git)
}

/// #368：stash 清单（git_stash_list）。
#[tauri::command]
pub(crate) async fn git_stash_list(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
) -> Result<Vec<git::GitStashEntry>, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_stash_list(&root).await.map_err(PylonError::Git)
}

/// #368：贮藏工作区（git_stash_push；message/include_untracked 可选）。
#[tauri::command]
pub(crate) async fn git_stash_push(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_stash_push(
        &root,
        message.as_deref(),
        include_untracked.unwrap_or(false),
    )
    .await
    .map_err(PylonError::Git)
}

/// #368：弹出指定 stash（git_stash_pop；index=0 为栈顶）。
#[tauri::command]
pub(crate) async fn git_stash_pop(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    index: usize,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_stash_pop(&root, index)
        .await
        .map_err(PylonError::Git)
}

/// #368：删除本地分支（git_delete_branch；后端带未落地工作保护与比较删除）。
#[tauri::command]
pub(crate) async fn git_delete_branch(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    name: String,
) -> Result<git::GitOperationResult, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_delete_branch(&root, &name)
        .await
        .map_err(PylonError::Git)
}

/// #368：结构化 log 图分页（git_log_graph；parents/refs 交前端算 lane）。
#[tauri::command]
pub(crate) async fn git_log_graph(
    state: tauri::State<'_, AppState>,
    target: WorkspaceTargetWire,
    skip: Option<usize>,
    limit: Option<usize>,
    first_parent: Option<bool>,
    path: Option<String>,
) -> Result<git::GitLogGraphPage, PylonError> {
    let root = git_workspace_root(state.inner(), &target).await?;
    git::git_log_graph(
        &root,
        skip,
        limit,
        first_parent.unwrap_or(false),
        path.as_deref(),
    )
    .await
    .map_err(PylonError::Git)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target(root: &str) -> WorkspaceTargetWire {
        WorkspaceTargetWire {
            session_id: "session-a".into(),
            agent_id: "agent-a".into(),
            source: "source-a".into(),
            workspace_id: None,
            legacy_workdir: Some(root.into()),
        }
    }
    async fn state_with_session() -> AppState {
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let service = std::sync::Arc::new(crate::session::UserDataService::in_memory().unwrap());
        service.save(UserDataKey::Sessions, serde_json::json!({ "version": 2, "sessions": [{ "id": "session-a", "agentId": "agent-a", "source": "source-a" }] }), None).await.unwrap();
        *state.user_data_service.lock().unwrap() = Some(service);
        state
    }

    #[tokio::test]
    async fn explicit_legacy_target_does_not_require_active_agent() {
        let state = state_with_session().await;
        let root = if cfg!(windows) {
            r"C:\workspace"
        } else {
            "/workspace"
        };
        assert_eq!(
            workspace_root_for_target(&state, &target(root))
                .await
                .unwrap(),
            std::path::PathBuf::from(root)
        );
    }

    #[tokio::test]
    async fn relative_legacy_target_is_rejected() {
        let state = state_with_session().await;
        assert_eq!(
            workspace_root_for_target(&state, &target("relative/path"))
                .await
                .unwrap_err()
                .code(),
            "workspace_error"
        );
    }

    #[tokio::test]
    async fn persisted_owner_mismatch_is_rejected() {
        let state = state_with_session().await;
        let mut mismatched = target(if cfg!(windows) {
            r"C:\workspace"
        } else {
            "/workspace"
        });
        mismatched.agent_id = "agent-b".into();
        assert!(workspace_root_for_target(&state, &mismatched)
            .await
            .unwrap_err()
            .to_string()
            .contains("owner mismatch"));
    }
}
