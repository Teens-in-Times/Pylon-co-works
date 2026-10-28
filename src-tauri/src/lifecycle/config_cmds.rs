//! Agent 配置事务命令（自 mod.rs 拆分；行为零变化）。
//!
//! reload / snapshot / update_agents_config / initialize_agents_config：
//! 写序锁 → lease → 候选生成 + 双域校验 → 原子写盘 → 内存提交 → 幽灵 runtime 清理。

use super::*;
use crate::error::PylonError;
use crate::AppState;
use pylon_foundations::await_guard::HeldAcrossAwait;

#[tauri::command]
// agent_lifecycle 跨 await：reload 全程与连接状态机串行，防 reload 撕裂在途连接
// L13/锁面例外：reload 是 registry 操作，只持 active runtime 的 agent_lifecycle、
// 不持 switch_lock（R9 锁序表外的 C6 例外，见 lifecycle/mod.rs 模块文档）——清理集合与 switch 不相交。
pub(crate) async fn reload_agents(
    state: tauri::State<'_, AppState>,
    config_path: Option<String>,
) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _lifecycle_guard = HeldAcrossAwait::new(runtime.agent_lifecycle.lock().await);
    // #683：config 文件读 + 解析是同步 IO——移到 spawn_blocking，不占 async 运行时。
    let new_agents = tokio::task::spawn_blocking(move || {
        if let Some(path) = config_path {
            crate::agent_config::load_from_path(std::path::Path::new(&path))
        } else {
            crate::agent_config::load()
        }
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    crate::agent_config::default_agent_id(&new_agents)?;
    // O12：config 读（read_to_string + parse）在锁外完成（load_from_path/load
    // 在取得 agents 锁之前执行）；active 存在性检查 + 新旧表 diff + 原子替换
    // 合并为单次持锁操作——无"检查通过但替换未完成"的中间态。
    let agent_count = new_agents.len();
    let removed: Vec<String> = {
        let active_agent = state
            .active_agent
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
        if !active_agent.is_empty() && !new_agents.contains_key(&active_agent) {
            return Err(PylonError::Protocol(format!(
                "agent config cannot remove active agent: {active_agent}"
            )));
        }
        // C6：reload 删除 agent 时清理幽灵 runtime——新旧表 diff，删除且非 active 的
        // agent 在注册表替换后 abort notification_task + kill acp（防旧进程继续
        // 运行/崩溃通知复活；与 switch_agent 清理旧 runtime 同款操作）。
        let removed = agents
            .keys()
            .filter(|id| !new_agents.contains_key(*id) && **id != active_agent)
            .cloned()
            .collect();
        *agents = new_agents;
        removed
    };
    remove_stale_runtimes(state.inner(), removed).await;
    state.inner().log_runtime_summary(
        "info",
        "agent",
        None,
        "Agent registry reloaded",
        serde_json::Map::from_iter([(
            "agentCount".to_string(),
            serde_json::Value::from(agent_count),
        )]),
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn agent_config_snapshot(
    _state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let path = crate::agent_config::effective_config_path().ok_or(PylonError::Config(
        crate::agent_config::ConfigError::ReadOnly,
    ))?;
    let (revision, agents) =
        tokio::task::spawn_blocking(move || crate::agent_config::read_config_snapshot(&path))
            .await
            .map_err(|error| PylonError::Io(error.to_string()))??;
    let summaries = agents
        .iter()
        .map(|(id, agent)| agent_summary_payload(id, agent, None, None, false))
        .collect::<Vec<_>>();
    let diagnostics = crate::agent_config::config_diagnostics(&agents);
    Ok(serde_json::json!({
        "revision": revision,
        "agents": summaries,
        "diagnostics": diagnostics,
    }))
}

/// Phase 3：update_agents_config（意见稿 §5.1 显式 scope 契约，用户拍板）。
///
/// scope="agent"：config 为 agent 整块 YAML 字符串（agentId 必填）；
/// scope="gateway"：config 为 `{ gateway: { routes: [...] } }` JSON。
/// 事务（§5.3.B）：写序锁 → embedded 只读检查 → 读当前 → 生成候选 → 双域校验 +
/// active agent 保护（写盘前）→ 原子写盘 → 内存提交（agents 域刷新 + 幽灵 runtime
/// 清理对齐 reload_agents；gateway 域 reload，失败报 config_not_applied）。
#[tauri::command]
pub(crate) async fn update_agents_config(
    state: tauri::State<'_, AppState>,
    scope: String,
    agent_id: Option<String>,
    config: serde_json::Value,
    expected_revision: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    update_agents_config_via(state, scope, agent_id, config, expected_revision, None).await
}

/// P91 批 C1（横切 §4）：配置路径参数化入口——生产恒走
/// `effective_config_path()`（`config_path_override=None`，行为不变）；测试注入
/// 临时配置路径，不再 `set_var` 进程全局 `PYLON_AGENTS_CONFIG`（进程级 env 变异
/// 与并行测试竞态）。
// config_write_lock 跨 await：串行「读→校验→写盘→提交」全窗口，防基于旧版本互相覆盖
pub(crate) async fn update_agents_config_via(
    state: tauri::State<'_, AppState>,
    scope: String,
    agent_id: Option<String>,
    config: serde_json::Value,
    expected_revision: Option<String>,
    config_path_override: Option<std::path::PathBuf>,
) -> Result<serde_json::Value, PylonError> {
    use crate::agent_config::ConfigError;
    let inner = state.inner();
    // 写序锁：读当前→生成候选→校验→写盘→内存提交全程串行，防基于旧版本互相覆盖
    let _write_guard = HeldAcrossAwait::new(inner.config_write_lock.lock().await);
    // 1. 来源检查：embedded 无外部写入目标 → config_read_only（绝不 fallback 当前目录）
    let path = match config_path_override {
        Some(path) => path,
        None => crate::agent_config::effective_config_path()
            .ok_or(PylonError::Config(ConfigError::ReadOnly))?,
    };
    let expected_revision =
        expected_revision.ok_or(PylonError::Config(ConfigError::RevisionRequired))?;
    // 跨进程 lease 覆盖“重读 baseline → 生成/校验候选 → 提交”整个窗口。
    // 进程内 config_write_lock 只负责当前 AppState，不能代替文件级互斥。
    let config_lease = crate::agent_config::ConfigLease::acquire(&path)?;
    // 2. 读当前原文（tokio::fs 异步读，不阻塞 async 运行时）
    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        PylonError::Config(ConfigError::Read(format!(
            "读取 {} 失败: {error}",
            path.display()
        )))
    })?;
    let actual = crate::agent_config::config_revision_for_bytes(content.as_bytes());
    if actual != expected_revision {
        return Err(PylonError::Config(ConfigError::Conflict {
            expected: expected_revision,
            actual,
        }));
    }
    // 3. 生成候选 + 双域校验 + 解析 agents（同步 YAML/fs，spawn_blocking；base_dir 绝对化）
    let scope_owned = scope.clone();
    let agent_id_owned = agent_id.clone();
    let config_owned = config.clone();
    let base_dir = path.parent().map(|p| p.to_path_buf());
    let candidate = tokio::task::spawn_blocking(move || {
        let candidate = build_scope_candidate(
            &content,
            &scope_owned,
            agent_id_owned.as_deref(),
            &config_owned,
        )?;
        let agents = crate::agent_config::validate_candidate(&candidate, base_dir.as_deref())?;
        Ok::<
            (
                String,
                std::collections::HashMap<String, crate::agent_config::AgentDef>,
            ),
            ConfigError,
        >((candidate, agents))
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    let (candidate, new_agents) = candidate;
    crate::agent_config::default_agent_id(&new_agents)?;
    // 4. active agent 保护（写盘前，只读不写）：候选不得删除当前 active agent；
    // 同时计算 removed diff，供写盘成功后再清理（施工文档 §2.1）。
    let removed: Vec<String> = {
        let active = inner.active_agent.lock().map_err(|e| e.to_string())?;
        let agents = inner.agents.lock().map_err(|e| e.to_string())?;
        removed_agents_guard(&agents, &new_agents, &active)?
    };
    // 4.5 #422 连接测试凭证门禁（写盘前，fail-closed）：编辑类 scope 的候选若
    // 变更了目标 agent 的 launch 指纹，必须持有该指纹通过 test_agent_candidate
    // 的凭证（B1 前端三道门的后端强制面——绕过 UI 的 CLI/直连 IPC 同样受限）。
    {
        let agents = inner.agents.lock().map_err(|e| e.to_string())?;
        enforce_connection_voucher(
            &scope,
            agent_id.as_deref(),
            &agents,
            &new_agents,
            &inner.verified_agent_fingerprints,
        )?;
    }
    // 5. 原子写盘（替换语义）。先落盘、后提交内存：写盘失败时 registry 不变
    // （施工文档 §2.1 必测失败链）。
    let write_content = candidate.clone();
    let write_path = path.clone();
    let expected_for_write = expected_revision.clone();
    tokio::task::spawn_blocking(move || {
        crate::agent_config::write_config_transaction_under_lease(
            &config_lease,
            &write_path,
            &expected_for_write,
            write_content.as_bytes(),
        )
        .map(|_| ())
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    // 6. 磁盘成功后提交内存 registry（与 reload_agents 的原子替换同语义）。
    {
        let mut agents = inner.agents.lock().map_err(|e| e.to_string())?;
        *agents = new_agents;
    }
    // 7. 幽灵 runtime 清理（与 reload_agents 同款：abort + kill + 移除）
    remove_stale_runtimes(inner, removed).await;
    // 8. gateway 域提交（scope=gateway 才需要；失败=磁盘已写但未生效 → config_not_applied）
    if scope == "gateway" {
        let gateway_config = crate::gateway::route::parse_config(&candidate).map_err(|e| {
            PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
        })?;
        inner.gateway.reload(gateway_config).map_err(|e| {
            PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
        })?;
    }
    inner.log_runtime_summary(
        "info",
        "config",
        None,
        &format!("Config updated (scope={scope})"),
        serde_json::Map::from_iter([(
            "scope".to_string(),
            serde_json::Value::String(scope.clone()),
        )]),
    );
    // 9. 返回摘要（不返回完整敏感配置）
    let agent_count = inner.agents.lock().map(|a| a.len()).unwrap_or(0);
    let revision = crate::agent_config::config_revision_for_path(&path)?;
    let config_activation_state = agent_id
        .as_deref()
        .and_then(|agent_id| stored_agent_activation(inner, agent_id));
    Ok(serde_json::json!({
        "applied": true,
        "scope": scope,
        "agentCount": agent_count,
        "revision": revision,
        "configActivationState": config_activation_state,
    }))
}

// ── 施工文档 Phase 2：首次外部配置初始化 + 连接测试 ──

/// embedded → exe 旁 `agents.yaml` 的首次外部配置初始化（施工文档 §4.6）。
/// 只允许当前 source 为 Embedded 时执行；目标固定 exe 同目录 `agents.yaml`，
/// 不写 `data/agents.yaml`，不写 AppData。走与 `update_agents_config` 相同的
/// 候选校验、原子写盘、内存提交与 gateway reload。
#[tauri::command]
// 同 update_agents_config_via：config_write_lock 串行初始化事务全窗口
pub(crate) async fn initialize_agents_config(
    state: tauri::State<'_, AppState>,
    agent_id: Option<String>,
    config: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    use crate::agent_config::ConfigError;
    let inner = state.inner();
    let _write_guard = HeldAcrossAwait::new(inner.config_write_lock.lock().await);

    // 1. 仅 embedded source 允许初始化（已有外部配置时直接走 update_agents_config）
    if crate::agent_config::effective_config_path().is_some() {
        return Err(PylonError::Config(ConfigError::ReadOnly));
    }
    let exe_dir = std::env::current_exe()
        .map_err(|error| PylonError::Io(format!("resolve current_exe failed: {error}")))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| PylonError::Io("current_exe has no parent".to_string()))?;
    let target = exe_dir.join("agents.yaml");
    let config_lease = crate::agent_config::ConfigLease::acquire(&target)?;
    if target.exists() {
        return Err(PylonError::Config(ConfigError::Conflict {
            expected: "<missing>".to_string(),
            actual: crate::agent_config::config_revision_for_path(&target)?,
        }));
    }

    // 2. 候选生成 + 双域校验（base_dir = exe 目录；同步 YAML/fs 移出 async 运行时）
    let content_owned = if config.get("agents").is_some() {
        crate::agent_config::serialize_agents_document(&config)?
    } else if config.is_object() {
        let requested_id = agent_id.as_deref().ok_or_else(|| {
            PylonError::Config(ConfigError::Invalid("结构化初始化缺少 agentId".to_string()))
        })?;
        let current = crate::agent_config::read_config_document()?;
        crate::agent_config::apply_agent_field_patch(&current.content, requested_id, &config)?
    } else {
        return Err(PylonError::Config(ConfigError::Invalid(
            "initialize_agents_config 的 config 必须为结构化 agents document 或字段 patch"
                .to_string(),
        )));
    };
    let base_dir = exe_dir.clone();
    let candidate = tokio::task::spawn_blocking(move || {
        let agents = crate::agent_config::validate_candidate(&content_owned, Some(&base_dir))?;
        Ok::<
            (
                String,
                std::collections::HashMap<String, crate::agent_config::AgentDef>,
            ),
            ConfigError,
        >((content_owned, agents))
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    let (candidate, new_agents) = candidate;
    let default_agent_id = crate::agent_config::default_agent_id(&new_agents)?.unwrap_or_default();
    if let Some(requested_id) = agent_id.as_deref() {
        if !new_agents.contains_key(requested_id) {
            return Err(PylonError::Config(ConfigError::Invalid(format!(
                "初始化配置不包含 agentId: {requested_id}"
            ))));
        }
    }

    // 3. 原子写盘（先磁盘）
    let write_content = candidate.clone();
    let write_path = target.clone();
    let revision = tokio::task::spawn_blocking(move || {
        crate::agent_config::write_new_config_under_lease(
            &config_lease,
            &write_path,
            write_content.as_bytes(),
        )
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;

    // 4. 磁盘成功后提交内存（embedded → external；active 不在新配置时切到新默认）
    let removed: Vec<String> = {
        let mut agents = inner.agents.lock().map_err(|e| e.to_string())?;
        let mut active = inner.active_agent.lock().map_err(|e| e.to_string())?;
        let removed = agents
            .keys()
            .filter(|id| !new_agents.contains_key(*id))
            .cloned()
            .collect();
        *agents = new_agents;
        if !agents.contains_key(&*active) {
            *active = default_agent_id.clone();
        }
        removed
    };
    // 5. 清理被移除的旧 runtime（与 reload_agents 同款）
    remove_stale_runtimes(inner, removed).await;
    // 6. gateway 域提交（配置文档已通过双域校验；reload 失败 → config_not_applied）
    let gateway_config = crate::gateway::route::parse_config(&candidate).map_err(|e| {
        PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
    })?;
    inner.gateway.reload(gateway_config).map_err(|e| {
        PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
    })?;

    inner.log_runtime_summary(
        "info",
        "config",
        None,
        "Agent config initialized to external file",
        serde_json::Map::from_iter([
            (
                "scope".to_string(),
                serde_json::Value::String("initialize".to_string()),
            ),
            (
                "agentCount".to_string(),
                serde_json::Value::from(inner.agents.lock().map(|a| a.len()).unwrap_or(0)),
            ),
        ]),
    );
    Ok(serde_json::json!({
        "applied": true,
        "scope": "initialize",
        "agentCount": inner.agents.lock().map(|a| a.len()).unwrap_or(0),
        "defaultAgentId": inner.active_agent.lock().map(|a| a.clone()).unwrap_or_default(),
        "revision": revision,
    }))
}

/// #422：连接测试凭证门禁（纯函数，写盘前只读判定）。
///
/// 只作用于编辑既有 agent 的 scope（`agent` YAML 整块 / `agent_fields` 结构化
/// patch——`apply_agent_patch`/`apply_agent_field_patch` 已保证目标 agent 必在
/// 当前配置中）。判据 = [`AgentDef::runtime_fingerprint`]（launch 投影，排除
/// name/default 显示字段）：
///
/// - 候选指纹 == 当前指纹：放行（未变更——只改 name/default 的保存不引入新
///   launch 风险，不强制在线探测）；
/// - 候选指纹 != 当前指纹：需该指纹经 `test_agent_candidate` 成功握手的凭证，
///   无则 [`ConfigError::VerificationRequired`]（fail-closed）。
///
/// create/delete/gateway scope 不校验：create 的「未验证导入」是产品功能
/// （#425 件5），delete/gateway 不改 launch 指纹。
fn enforce_connection_voucher(
    scope: &str,
    agent_id: Option<&str>,
    current: &std::collections::HashMap<String, crate::agent_config::AgentDef>,
    candidate: &std::collections::HashMap<String, crate::agent_config::AgentDef>,
    vouchers: &super::verification::VerificationVouchers,
) -> Result<(), crate::agent_config::ConfigError> {
    use crate::agent_config::ConfigError;
    if scope != "agent" && scope != "agent_fields" {
        return Ok(());
    }
    let Some(agent_id) = agent_id else {
        return Ok(()); // 编辑类 scope 缺 agentId 在候选生成阶段已被拒
    };
    let Some(next) = candidate.get(agent_id) else {
        return Ok(()); // 候选不含目标 agent = 无 launch 定义可校验（防御）
    };
    let next_fingerprint = next.runtime_fingerprint();
    if current
        .get(agent_id)
        .is_some_and(|current| current.runtime_fingerprint() == next_fingerprint)
    {
        return Ok(());
    }
    if vouchers.contains(agent_id, &next_fingerprint) {
        return Ok(());
    }
    Err(ConfigError::VerificationRequired(format!(
        "agent {agent_id} 的 launch 配置有变更，保存前需先对该配置通过一次连接测试（test_agent_candidate）"
    )))
}

/// scope 分派 → 候选文档（纯函数：不经 env / 文件系统，可直接单测）。
///
/// 只做"读当前原文 → 造候选"；双域校验、active 保护、写盘与内存提交仍在调用方，
/// 候选生成与提交链路的边界不变。
fn build_scope_candidate(
    content: &str,
    scope: &str,
    agent_id: Option<&str>,
    config: &serde_json::Value,
) -> Result<String, crate::agent_config::ConfigError> {
    use crate::agent_config::ConfigError;
    match scope {
        "agent" => {
            let agent_id = agent_id
                .ok_or_else(|| ConfigError::Invalid("scope=agent 缺少 agentId".to_string()))?;
            let patch_yaml = config.as_str().ok_or_else(|| {
                ConfigError::Invalid("scope=agent 的 config 必须为 YAML 字符串".to_string())
            })?;
            crate::agent_config::apply_agent_patch(content, agent_id, patch_yaml)
        }
        "agent_fields" => {
            let agent_id = agent_id.ok_or_else(|| {
                ConfigError::Invalid("scope=agent_fields 缺少 agentId".to_string())
            })?;
            crate::agent_config::apply_agent_field_patch(content, agent_id, config)
        }
        "agent_create" => {
            let agent_id = agent_id.ok_or_else(|| {
                ConfigError::Invalid("scope=agent_create 缺少 agentId".to_string())
            })?;
            crate::agent_config::apply_agent_create(content, agent_id, config)
        }
        // issue #67A：删除单个 agent 配置条目（仅摘配置，会话/记录数据不动）。
        // runtime 停止、active agent 保护、空表拒绝、revision/lease 全部复用下游既有链路。
        "agent_delete" => {
            let agent_id = agent_id.ok_or_else(|| {
                ConfigError::Invalid("scope=agent_delete 缺少 agentId".to_string())
            })?;
            crate::agent_config::apply_agent_delete(content, agent_id)
        }
        "gateway" => crate::agent_config::apply_gateway_patch(content, config),
        other => Err(ConfigError::Invalid(format!("未知 scope: {other}"))),
    }
}

/// active agent 保护 + removed diff（纯函数，写盘前只读判定）。
///
/// 候选不得删除当前 active agent——那会让界面失去"当前"目标，必须先显式切换；
/// 返回的 removed 供写盘成功后清理幽灵 runtime（施工文档 §2.1）。
fn removed_agents_guard(
    current: &std::collections::HashMap<String, crate::agent_config::AgentDef>,
    candidate: &std::collections::HashMap<String, crate::agent_config::AgentDef>,
    active: &str,
) -> Result<Vec<String>, crate::agent_config::ConfigError> {
    use crate::agent_config::ConfigError;
    // Zero-agent startup uses the empty string as the absence of an active agent.
    if !active.is_empty() && !candidate.contains_key(active) {
        return Err(ConfigError::ActiveAgentProtected(format!(
            "候选配置删除了当前 active agent: {active}"
        )));
    }
    Ok(current
        .keys()
        .filter(|id| !candidate.contains_key(*id) && id.as_str() != active)
        .cloned()
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_AGENTS: &str = "agents:\n  keep:\n    name: keep\n    transport: subprocess\n    exe: keep-agent\n  doomed:\n    name: doomed\n    transport: subprocess\n    exe: doomed-agent\n";
    const ONE_AGENT: &str =
        "agents:\n  only:\n    name: only\n    transport: subprocess\n    exe: only-agent\n";

    fn parsed(content: &str) -> std::collections::HashMap<String, crate::agent_config::AgentDef> {
        crate::agent_config::validate_candidate(content, None).expect("fixture 必须合法")
    }

    #[test]
    fn first_agent_import_does_not_treat_empty_active_as_an_agent_to_delete() {
        let candidate = build_scope_candidate(
            "agents: {}\n",
            "agent_create",
            Some("hermes"),
            &serde_json::json!({"name":"Hermes", "transport":"subprocess", "exe":"hermes", "args":["acp"], "default":true}),
        )
        .unwrap();
        let new_agents = parsed(&candidate);
        assert!(
            removed_agents_guard(&std::collections::HashMap::new(), &new_agents, "")
                .unwrap()
                .is_empty()
        );
        assert!(removed_agents_guard(&new_agents, &new_agents, "missing-active").is_err());
    }

    fn delete_candidate(agent_id: &str) -> String {
        build_scope_candidate(
            TWO_AGENTS,
            "agent_delete",
            Some(agent_id),
            &serde_json::Value::Null,
        )
        .expect("删除候选必须生成")
    }

    #[test]
    fn scope_dispatch_builds_an_agent_delete_candidate_for_existing_agents_only() {
        let candidate = delete_candidate("doomed");
        let agents = parsed(&candidate);
        assert!(!agents.contains_key("doomed"), "目标条目必须消失");
        assert!(agents.contains_key("keep"), "其它 agent 不受影响");
        assert!(
            build_scope_candidate(
                TWO_AGENTS,
                "agent_delete",
                Some("ghost"),
                &serde_json::Value::Null
            )
            .is_err(),
            "幂等删除不算成功"
        );
    }

    #[test]
    fn scope_dispatch_requires_an_agent_id_and_rejects_unknown_scopes() {
        let missing =
            build_scope_candidate(TWO_AGENTS, "agent_delete", None, &serde_json::Value::Null)
                .expect_err("缺少 agentId 必须拒绝");
        assert!(missing.to_string().contains("缺少 agentId"), "{missing}");
        assert!(build_scope_candidate(
            TWO_AGENTS,
            "agent_purge",
            Some("doomed"),
            &serde_json::Value::Null
        )
        .is_err());
    }

    #[test]
    fn deleting_the_last_agent_leaves_an_empty_table_that_validation_rejects() {
        let candidate = build_scope_candidate(
            ONE_AGENT,
            "agent_delete",
            Some("only"),
            &serde_json::Value::Null,
        )
        .expect("纯函数层允许生成空表候选");
        assert!(
            crate::agent_config::validate_candidate(&candidate, None).is_err(),
            "空 agents 表必须在命令层校验被拒"
        );
    }

    #[test]
    fn active_agent_guard_rejects_deleting_the_active_agent_and_reports_removed() {
        let current = parsed(TWO_AGENTS);
        let delete_active = parsed(&delete_candidate("keep"));
        let error = removed_agents_guard(&current, &delete_active, "keep")
            .expect_err("删除 active agent 必须被拒");
        assert!(
            matches!(
                error,
                crate::agent_config::ConfigError::ActiveAgentProtected(_)
            ),
            "{error}"
        );

        let delete_other = parsed(&delete_candidate("doomed"));
        assert_eq!(
            removed_agents_guard(&current, &delete_other, "keep").unwrap(),
            vec!["doomed".to_string()],
            "removed diff 必须只含被删除的非 active agent"
        );
        assert!(
            removed_agents_guard(&current, &current, "keep")
                .unwrap()
                .is_empty(),
            "无变化时候选不产生清理名单"
        );
    }

    /// #422：构造 args 变更后的 keep 候选（其余字段与 TWO_AGENTS 中 keep 一致）。
    fn keep_with_args(
        args: &[&str],
    ) -> std::collections::HashMap<String, crate::agent_config::AgentDef> {
        let mut candidate = parsed(TWO_AGENTS);
        if let Some(keep) = candidate.get_mut("keep") {
            keep.args = args.iter().map(|value| value.to_string()).collect();
        }
        candidate
    }

    #[test]
    fn voucher_gate_binds_only_edit_scopes_and_only_changed_fingerprints() {
        use crate::agent_config::ConfigError;
        let vouchers = super::super::verification::VerificationVouchers::new();
        let current = parsed(TWO_AGENTS);

        // 非 launch 字段（name）变更：指纹未变，无凭证放行——不强制在线探测。
        let mut renamed = current.clone();
        if let Some(keep) = renamed.get_mut("keep") {
            keep.name = "renamed".to_string();
        }
        assert!(
            enforce_connection_voucher("agent", Some("keep"), &current, &renamed, &vouchers)
                .is_ok(),
            "指纹未变更的保存无需凭证"
        );

        // 编辑 scope + 指纹变更 + 无凭证 → fail-closed 拒绝。
        let changed = keep_with_args(&["--scenario", "alive"]);
        let error =
            enforce_connection_voucher("agent_fields", Some("keep"), &current, &changed, &vouchers)
                .expect_err("指纹变更且无凭证必须拒绝");
        assert!(
            matches!(error, ConfigError::VerificationRequired(_)),
            "{error}"
        );

        // 非编辑 scope（create/delete/gateway 不改 launch 语义或属产品豁免）不受门禁。
        assert!(enforce_connection_voucher(
            "agent_create",
            Some("fresh"),
            &current,
            &changed,
            &vouchers
        )
        .is_ok());
        assert!(enforce_connection_voucher(
            "agent_delete",
            Some("doomed"),
            &current,
            &changed,
            &vouchers
        )
        .is_ok());
        assert!(enforce_connection_voucher("gateway", None, &current, &changed, &vouchers).is_ok());

        // 持有候选指纹凭证 → 放行（按候选 def 指纹记账）。
        vouchers.record("keep", &changed["keep"].runtime_fingerprint());
        assert!(
            enforce_connection_voucher("agent_fields", Some("keep"), &current, &changed, &vouchers)
                .is_ok(),
            "凭证对应候选指纹时必须放行"
        );
    }

    #[test]
    fn voucher_gate_is_defensive_when_agent_id_or_entry_missing() {
        let vouchers = super::super::verification::VerificationVouchers::new();
        let current = parsed(TWO_AGENTS);
        let changed = keep_with_args(&["--flag"]);
        assert!(
            enforce_connection_voucher("agent", None, &current, &changed, &vouchers).is_ok(),
            "缺 agentId 在候选生成阶段已被拒，此处防御性放行"
        );
        assert!(
            enforce_connection_voucher("agent", Some("ghost"), &current, &changed, &vouchers)
                .is_ok(),
            "候选不含目标 agent = 无 launch 定义可校验（防御性放行）"
        );
    }
}
