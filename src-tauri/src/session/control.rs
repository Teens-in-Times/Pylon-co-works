//! 会话控制域：set_mode / set_config_option / close / cancel。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;
use pylon_foundations::await_guard::HeldAcrossAwait;
#[tauri::command]
pub(crate) async fn set_mode(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    source: String,
    mode: String,
) -> Result<serde_json::Value, PylonError> {
    // OWNER-02（§5.8）：显式 agentId 正向 owner 路由（会话存在才可 set_mode）。
    let owner = SessionOwner::new(&agent_id, &source);
    let runtime = state.inner().resolve_owner_runtime(&owner)?;
    let generation = state.current_generation(&runtime);
    let (config_target, legacy_choices) = {
        let sessions = runtime
            .sessions
            .lock()
            .map_err(|e| PylonError::Protocol(e.to_string()))?;
        let session = sessions
            .get(&source)
            .ok_or_else(|| PylonError::SessionNotFound(source.clone()))?;
        (
            super::find_config_option(&session.config_options, "mode").cloned(),
            session.mode_choices.clone(),
        )
    };
    if let Some(option) = config_target {
        super::validate_advertised_choice(
            &mode,
            &super::config_option_choice_ids(&option),
            "mode_not_advertised",
        )?;
        let config_id = super::config_option_identity(&option)
            .ok_or_else(|| PylonError::Protocol("mode_config_id_missing".into()))?;
        return set_config_option(state, agent_id, source, config_id, serde_json::json!(mode))
            .await;
    }
    if legacy_choices.is_empty() {
        return Err(PylonError::Protocol(
            "mode_switching_unavailable: agent advertises no mode surface".into(),
        ));
    }
    super::validate_advertised_choice(&mode, &legacy_choices, "mode_not_advertised")?;
    let peri_id = state.get_peri_id(&runtime, &source)?;
    state
        .inner()
        .acp_rpc_generation_checked(
            &runtime,
            acp::METHOD_SESSION_SET_MODE,
            acp::session_set_mode_params(&peri_id, &mode)?,
            generation,
        )
        .await?;
    state.ensure_generation(&runtime, generation)?;
    state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
        session.mode = Some(mode.clone());
    })?;
    // The legacy method acknowledges the requested mode with an empty response.
    // Return only that dimension; never fabricate an availableModes catalogue.
    Ok(serde_json::json!({"modes": {"currentModeId": mode}}))
}

#[tauri::command]
pub(crate) async fn set_config_option(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    source: String,
    key: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    // OWNER-02（§5.8）：显式 agentId 正向 owner 路由（会话存在才可 set_config_option）。
    let owner = SessionOwner::new(&agent_id, &source);
    let runtime = state.inner().resolve_owner_runtime(&owner)?;
    let generation = state.current_generation(&runtime);
    // P56/D1：会话状态一次读取（peri_id + 模型面 + 宣告 choices）——surface 路由与
    // 发送校验都以「当次会话宣告」为准。#97/D97-6：依赖 option（reasoning 组）的
    // 宣告 choices 一并读出，供发送前校验。
    let (peri_id, model_surface, model_choices, reasoning_choices) = {
        let sessions = runtime
            .sessions
            .lock()
            .map_err(|e| PylonError::Protocol(e.to_string()))?;
        let session = sessions
            .get(&source)
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()))?;
        let reasoning_choices = super::find_config_option(&session.config_options, "reasoning")
            .map(super::config_option_choice_ids)
            .unwrap_or_default();
        (
            session.peri_id.clone(),
            session.model_surface.clone(),
            session.model_choices.clone(),
            reasoning_choices,
        )
    };
    // G2-03：D2 路由收敛——set_model_api 枚举三路（ConfigOption 默认 / SetModel /
    // Disabled）。方案 4：路由按 target runtime 归属 agent 的配置决定，而非 active
    // agent——多 runtime/agents 表与注册不同步时避免跨 runtime 读取错误协议策略。
    // P56/D1.3：显式 `set_model_api` 声明优先（现状行为，兼容优先；含 legacy 布尔
    // 迁移与 catalog 默认——load.rs parse() 已把三者合并进 agent.acp.set_model_api，
    // 该字段为 Some 即「声明态」）；未声明 → 按响应判定的 model_surface 路由
    // （ConfigOption{config_id} → set_config_option（宣告 configId）/ ModelsState →
    // set_model / None → model switching unavailable）。key != "model" 既有路径不变。
    let declared = state
        .agent_for_runtime(&runtime)
        .and_then(|agent| agent.acp)
        .and_then(|acp| acp.set_model_api);
    let (target, advertised_config_id) =
        resolve_model_switch_target(declared, &key, &model_surface)?;
    // #97/D97-5：model 键走 ConfigOption 通道但会话未宣告 config id——按显式兼容
    // 规则以语义键发送（现状行为，兼容优先），warn 留痕（Agent 广告不完整，
    // code=model_config_id_missing）。宣告了真实 id 时绝不允许降级成 `model`。
    // D97-8（评审修正）：model 判别与 reasoning 组一致用语义别名匹配（P56 路由的
    // `key != "model"` 特判保持不变——路由是现状行为，校验/诊断是本 issue 新增
    // 不变量，别名键不得绕过）。
    let is_model_key = super::config_option_key_matches(&key, "model");
    if is_model_key
        && matches!(target, crate::agent_config::ModelSwitchTarget::ConfigOption)
        && advertised_config_id.is_none()
    {
        tracing::warn!(
            source = source,
            code = "model_config_id_missing",
            "model config option route has no advertised config id; sending semantic key as-is"
        );
    }
    // P56/D1.4：发送不变量——目标 model 值必须 ∈ 当次会话宣告的 choices；
    // 不在列表 → 结构化错误（model_not_advertised + 宣告列表摘要），本地状态不变。
    // #97/D97-6：reasoning 组依赖 option 在会话宣告了 choices 时同样校验——模型
    // 切换刷新宣告后，失效的旧值在发送前被拒，不遗留旧模型状态。
    if is_model_key {
        if let Some(model_id) = value.as_str() {
            validate_model_advertised(model_id, &model_choices)?;
        }
    } else if super::config_option_key_matches(&key, "reason") {
        if let Some(reasoning) = value.as_str() {
            super::validate_advertised_choice(
                reasoning,
                &reasoning_choices,
                "reasoning_not_advertised",
            )?;
        }
    }
    let response = match target {
        crate::agent_config::ModelSwitchTarget::Disabled => {
            return Err(PylonError::Protocol("model switching disabled".to_string()));
        }
        crate::agent_config::ModelSwitchTarget::SetModel => {
            let model_id = value.as_str().ok_or_else(|| {
                PylonError::Protocol("model config value must be a string".to_string())
            })?;
            state
                .inner()
                .acp_rpc_generation_checked(
                    &runtime,
                    acp::METHOD_SESSION_SET_MODEL,
                    acp::session_set_model_params(&peri_id, model_id)?,
                    generation,
                )
                .await?
        }
        crate::agent_config::ModelSwitchTarget::ConfigOption => {
            // P56/D1.5：ConfigOption 通道统一使用宣告 configId（surface 路由给出）；
            // 显式声明路径保持现状（前端语义 key 原样作 configId）。
            let config_id = advertised_config_id.unwrap_or_else(|| key.clone());
            state
                .inner()
                .acp_rpc_generation_checked(
                    &runtime,
                    acp::METHOD_SESSION_SET_CONFIG_OPTION,
                    acp::session_set_config_option_params(&peri_id, &config_id, &value)?,
                    generation,
                )
                .await?
        }
    };
    state.ensure_generation(&runtime, generation)?;
    let settlement = state
        .with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
            // P56/D1.6：写回收敛——非空 configOptions 权威覆盖；空数组回声保护本地
            // 宣告；其余语义键乐观写回并标记 pending（未确认）。收敛结果结构化
            // 上抛，钳制/暂定在锁外发诊断（#97/D97-2）。
            session.apply_config_option_response(&response, &key, &value)
        })
        .map_err(PylonError::Protocol)?;
    match &settlement {
        super::ModelSwitchSettlement::Clamped { requested, settled } => {
            tracing::warn!(
                source = source,
                code = "model_switch_clamped",
                requested = requested,
                settled = settled,
                "agent settled the model switch to a different value; session state converged to the agent value"
            );
        }
        super::ModelSwitchSettlement::Pending { requested } => {
            tracing::info!(
                source = source,
                code = "model_switch_pending",
                requested = requested,
                "model switch acknowledged without authoritative echo; value kept as unconfirmed pending"
            );
        }
        _ => {}
    }
    if let Some(options) = response
        .get("configOptions")
        .or_else(|| response.get("config_options"))
        .and_then(serde_json::Value::as_array)
    {
        let _ = super::ingest_established_config_options_event(
            state.inner(),
            &runtime,
            &source,
            &peri_id,
            generation,
            options,
        )
        .await;
    }
    Ok(response)
}

/// 方案 6：统一 close RPC 发送入口（四处 close 路径复用）。
/// 统一：close_via_rpc 判定、params 构造、method-not-found 类型化降级、
/// generation-bound（方案 5，旧 periId 不进入新 ACP）、日志。
/// 保留差异：strict=true（close_session，RemoteFirst）普通 RPC 错误上抛；
/// strict=false（expiry/replaced/unsettled，LocalFirstBestEffort）吞错误
/// （失败不阻断本地清理）。返回 Ok(实际尝试了 RPC)。
pub(crate) async fn close_session_rpc(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    peri_id: &str,
    generation: u64,
    strict: bool,
) -> Result<bool, PylonError> {
    if !state.protocol_for_runtime(runtime).close_via_rpc() {
        return Ok(false); // 声明式配置跳过 RPC，仅本地清理
    }
    let close_params = acp::session_close_params(peri_id).map_err(PylonError::Protocol)?;
    let result = state
        .acp_rpc_generation_checked(runtime, acp::METHOD_SESSION_CLOSE, close_params, generation)
        .await;
    match result {
        Ok(_) => Ok(true),
        Err(error) if error.is_method_not_found() => {
            tracing::warn!("agent does not support session/close ({error}); local cleanup only");
            Ok(true)
        }
        Err(error) if error.to_string().contains("stale ACP client generation") => {
            // 客户端已替换：本地清理仍执行（本地映射迁移到新代际），远端旧
            // session 由新 client 的会话清单/替换流程处理，不再发旧 periId。
            tracing::warn!("close skipped: ACP client replaced (stale generation)");
            Ok(true)
        }
        Err(error) if strict => Err(error.into()),
        Err(error) => {
            tracing::warn!("close session {peri_id}: {error}");
            Ok(true)
        }
    }
}

#[tauri::command]
// session_creation 串行 close 与 create；cancel 在 acp 锁内发送（方案 5，防写入新 ACP）
pub(crate) async fn close_session(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    source: String,
) -> Result<(), PylonError> {
    // OWNER-02（§5.8）：显式 agentId 正向 owner 路由（会话存在才可 close）。
    let owner = SessionOwner::new(&agent_id, &source);
    let runtime = state.inner().resolve_owner_runtime(&owner)?;
    let _creation_guard = HeldAcrossAwait::new(runtime.session_creation.lock().await);
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source)?;
    // 若该 session 有在途 prompt，先发 cancel（fire-and-forget）让 Peri 侧 settle，
    // 否则 pending oneshot 会等到单步闲置超时才结束——close 后 prompt 可能长时卡住。
    // 方案 5（#549/ADR-0037 收口）：cancel 走快照客户端的私有通道——请求只可能
    // 写入被解析的这一连接，replacement 换装后旧客户端被 kill，通道关闭即失败，
    // 旧 periId 的 cancel 物理上不会写入新 ACP。
    {
        let acp = runtime.snapshot_acp();
        let _ = acp.cancel_session(&peri_id).await;
    }
    // 方案 6：统一 close RPC 入口（close_via_rpc 判定 + params + method-not-found
    // 降级 + generation-bound 隔离）。close_session 为 RemoteFirst：普通 RPC 错误
    // 上抛（strict=true）；-32601 / stale generation 降级为本地清理。
    close_session_rpc(&state, &runtime, &peri_id, generation, true).await?;
    // 显式关闭也是消息边界：先把同代际 dispatcher 中已排队的 delta 收口，
    // 再移除 session 映射。无终态崩溃则仍保留临时片段供用户处理。
    runtime
        .flush_draft_before_terminal(&source, generation)
        .await
        .map_err(PylonError::Protocol)?;
    // B9：close 时应答该 session 全部挂起的权限请求为 Cancelled
    crate::permission::respond_pending_permissions_cancelled(&runtime, &peri_id).await;
    // #316：回收该 session 名下的宿主终端（terminal registry 按 periId 归属），
    // 防 agent 会话关闭后终端进程跨代残留。
    let released = runtime.terminal_registry.release_session(&peri_id).await;
    if released > 0 {
        tracing::debug!(peri_id, released, "closed session host terminals released");
    }
    state.ensure_generation(&runtime, generation)?;
    if !state.session_matches(&runtime, &source, &peri_id, generation)? {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    let _ = state.remove_session_if_matches(&runtime, &source, &peri_id, generation)?;
    Ok(())
}

/// #398：agent 侧会话删除（`session/delete`，官方 DeleteSessionRequest）。
///
/// 删除链路语义：本地删除（`user_session_delete`）独立先行，本命令在其后的
/// close（停活跃工作）之后调用——目标是清 agent 侧持久会话记录，因此以**显式
/// periId** 为目标、按 agentId 路由（`resolve_agent_runtime` 不查 session 映射：
/// close 已移除映射后仍可路由）。
///
/// 结果分级（尽力而为，跳过是常态而非错误——多数 agent 尚未实现 delete）：
/// - `{"outcome":"deleted"}`：RPC 成功；
/// - `{"outcome":"skipped","reason":..}`：periId 缺失 / runtime 不存在 / 能力未
///   协商（fail-closed）/ stale generation / agent 报 -32601（广告了能力但未实现）；
/// - `Err`：能力协商通过但删除失败（agent 支持却失败是异常，上抛供前端报告）。
pub(crate) async fn delete_agent_session(
    state: &AppState,
    agent_id: &str,
    source: &str,
    peri_id: &str,
) -> Result<serde_json::Value, PylonError> {
    // source 仅用于日志关联（诊断对齐 close 的 source 维度）；路由与目标按显式参数。
    if peri_id.trim().is_empty() {
        return Ok(delete_outcome_skipped("no_remote_session"));
    }
    // OWNER-02 同款显式 agentId 路由，但删除目标会话此刻可能已无 runtime 映射
    // （close 先行移除），故用 resolve_agent_runtime（不要求会话存在）。
    let Ok(runtime) = state.resolve_agent_runtime(agent_id) else {
        return Ok(delete_outcome_skipped("agent_runtime_unavailable"));
    };
    // 能力 gate（#98 矩阵）：delete 必须 usable（广告 ∩ 消费者注册）才发送；
    // disconnected 客户端无广告，天然落此分支——不发注定失败的 RPC。
    let snapshot = crate::acp::capture_negotiated_snapshot(&runtime)
        .await
        .map_err(PylonError::Protocol)?;
    if !snapshot.usable("delete") {
        let reason = snapshot
            .decision("delete")
            .map(|decision| {
                if decision.advertised == Some(true) {
                    "delete_capability_consumer_unregistered"
                } else {
                    "delete_capability_unavailable"
                }
            })
            .unwrap_or("delete_capability_unavailable");
        return Ok(delete_outcome_skipped(reason));
    }
    let generation = state.current_generation(&runtime);
    let delete_params = acp::session_delete_params(peri_id).map_err(PylonError::Protocol)?;
    match state
        .acp_rpc_generation_checked(
            &runtime,
            acp::METHOD_SESSION_DELETE,
            delete_params,
            generation,
        )
        .await
    {
        Ok(_) => {
            tracing::info!(
                "agent_session_delete({source}): session/delete 已送达 (peri_id={peri_id}, generation={generation})"
            );
            Ok(serde_json::json!({"outcome": "deleted"}))
        }
        Err(error) if error.is_method_not_found() => {
            tracing::warn!(
                "agent_session_delete({source}): agent advertises delete but returns method-not-found ({error}); local delete already applied"
            );
            Ok(delete_outcome_skipped("method_not_found"))
        }
        Err(error) if error.to_string().contains("stale ACP client generation") => {
            // 客户端已替换：与 close 同款降级——本地删除已生效，旧代际 periId
            // 不写入新连接，agent 侧遗留由新代际的会话清单/替换流程处理。
            tracing::warn!(
                "agent_session_delete({source}): skipped, ACP client replaced (stale generation)"
            );
            Ok(delete_outcome_skipped("stale_generation"))
        }
        Err(error) => Err(PylonError::Protocol(format!(
            "session/delete rpc failed (peri_id={peri_id}, source={source}): {error}"
        ))),
    }
}

fn delete_outcome_skipped(reason: &str) -> serde_json::Value {
    serde_json::json!({"outcome": "skipped", "reason": reason})
}

/// `delete_agent_session` 的 Tauri 薄壳（参数 camelCase 直传）。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn agent_session_delete(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    source: String,
    peri_id: String,
) -> Result<serde_json::Value, PylonError> {
    delete_agent_session(state.inner(), &agent_id, &source, &peri_id).await
}

#[tauri::command]
// ACP-05：acp 锁内判 generation 再发 cancel，replacement 持同锁无法插入
pub(crate) async fn cancel_prompt(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    source: String,
) -> Result<(), PylonError> {
    // ACP-05（§5.7 step 1）：Session owner runtime。OWNER-02（§5.8）改为显式 agentId
    // 正向路由（ACP-05 的 find_runtime_for_source 跨全部 runtime 反向扫描，无法在
    // 双 Agent 同名 source 时确定归属，已移除）；owner runtime 不存在 →
    // agent_runtime_unavailable，绝不 fallback active runtime。
    let owner = SessionOwner::new(&agent_id, &source);
    let runtime = state.inner().resolve_owner_runtime(&owner)?;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source)?;
    // ACP-05（§5.7 step 2/3）：generation-bound 发送 session/cancel——发送前对
    // 快照客户端**自带**代际自校验（#549/ADR-0037：请求只入队被解析的这一连接，
    // replacement 换装后旧连接必被 kill，旧 periId 的 cancel 不会写入新 ACP）；
    // 发送失败返回结构化错误（cancel≠close：失败不清理会话
    // 映射，也不假装 agent 已处理——settle 由 prompt 路径异步收敛）。
    {
        let acp = runtime.snapshot_acp();
        if acp.client_generation() != generation {
            return Err(PylonError::Protocol(format!(
                "stale ACP client generation: expected {generation}"
            )));
        }
        acp.cancel_session(&peri_id).await.map_err(|error| {
            PylonError::Protocol(format!(
                "cancel_prompt({source}) session/cancel 发送失败 (peri_id={peri_id}): {error}"
            ))
        })?;
    }
    // 记录 cancel wire seq（OBS-01 wire_trace 已自动记录 outbound 原文，此处登记
    // 业务侧发生点，供追溯 cancel→settle 链路）。
    tracing::info!(
        "cancel_prompt({source}): session/cancel 已发送 (peri_id={peri_id}, generation={generation})"
    );
    // B9：cancel 时应答该 session 全部挂起的权限请求为 Cancelled（协议要求）。
    crate::permission::respond_pending_permissions_cancelled(&runtime, &peri_id).await;
    state.ensure_generation(&runtime, generation)?;
    if !state.session_matches(&runtime, &source, &peri_id, generation)? {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    // #352：把「用户 cancel 已发出」登记为本会话的一等判死输入——prompt 等待
    // 循环看到即直接进入 cancel-settle 窗口；不再依赖会被 agent 继续产出无限
    // 续命的闲置判死。置于发送成功 + 复核之后：发送失败的 cancel 不判死。
    // generation 随置位键化（原镜像 turn_in_flight 的键化纪律，#420 后在途事实
    // 归账本单源，cancel 仍按 generation 键控）：旧代际 cancel 不入新代际。
    // 锁形态：tauri command 错误边界，按 dev-standards #331 例外一 map_err 入域，
    // 中毒不得静默跳过置位。
    let mut sessions = runtime.sessions.lock().map_err(|error| {
        PylonError::Protocol(format!(
            "cancel_prompt({source}): sessions 锁不可用: {error}"
        ))
    })?;
    if let Some(session) = sessions.get_mut(&source) {
        session.mark_cancel_requested(generation, std::time::Instant::now());
    }
    Ok(())
}

#[cfg(test)]
mod delete_session_tests {
    use super::*;

    /// #398：`delete_agent_session` 执行链 wire 级测试（`pylon-fake-agent
    /// --scenario delete-session` + trace 断言；fork.rs 同款 harness）。
    /// 消费者注册是进程级全局，每个用例独立注册（fork 测试 CI 顺序教训）。
    fn register_delete_consumer() {
        crate::acp::negotiated::register_capability_consumer(
            crate::acp::CapabilityConsumer::SessionDelete,
        );
    }

    async fn delete_runtime(
        name: &str,
        outcome: Option<&str>,
    ) -> (
        std::sync::Arc<AgentRuntime>,
        crate::agent_config::AgentDef,
        std::path::PathBuf,
    ) {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-delete-{name}-{}.jsonl", std::process::id()));
        let trace_file = trace_path.to_string_lossy().into_owned();
        let mut args = vec![
            "--scenario",
            "delete-session",
            "--trace-file",
            &trace_file,
            "--trace-mode",
            "all",
        ];
        if let Some(outcome) = outcome {
            args.extend(["--outcome", outcome]);
        }
        let agent = crate::test_utils::fake_acp_agent(name, &args);
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            crate::acp::AcpClient::connect_with_logs(&agent, None)
                .await
                .expect("fake ACP must initialize"),
        );
        (runtime, agent, trace_path)
    }

    fn state_for(
        name: &str,
        agent: crate::agent_config::AgentDef,
        runtime: &std::sync::Arc<AgentRuntime>,
    ) -> AppState {
        crate::test_utils::TestStateBuilder::bare()
            .with_active_agent(name)
            .with_agent(agent)
            .with_runtime(name, runtime.clone())
            .build()
    }

    /// 能力协商通过 ⇒ 实发 `session/delete`（params 仅 sessionId），outcome=deleted；
    /// wire 原文经 fake agent trace 落证。
    #[tokio::test]
    async fn delete_sends_rpc_when_capability_usable() {
        register_delete_consumer();
        let (runtime, agent, trace_path) = delete_runtime("delete-ok", None).await;
        let state = state_for("delete-ok", agent, &runtime);
        let outcome = delete_agent_session(&state, "delete-ok", "local:x", "remote-peri-1")
            .await
            .expect("能力 usable 时删除必须成功");
        assert_eq!(outcome.get("outcome"), Some(&serde_json::json!("deleted")));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        assert!(
            trace.contains("\"method\":\"session/delete\"")
                && trace.contains("\"sessionId\":\"remote-peri-1\""),
            "wire 必须出现 session/delete 与目标 periId: {trace}"
        );
    }

    /// 能力未协商（disconnected runtime 无广告）⇒ 稳定 skipped、不发 RPC。
    #[tokio::test]
    async fn delete_skips_stably_without_negotiated_capability() {
        register_delete_consumer();
        let runtime = AgentRuntime::new_disconnected();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("delete-gate")
            .with_runtime("delete-gate", runtime.clone())
            .build();
        let outcome = delete_agent_session(&state, "delete-gate", "local:x", "remote-peri-1")
            .await
            .expect("能力不可用是跳过而非错误");
        assert_eq!(outcome.get("outcome"), Some(&serde_json::json!("skipped")));
        assert_eq!(
            outcome.get("reason"),
            Some(&serde_json::json!("delete_capability_unavailable"))
        );
    }

    /// agent 广告了能力但报 -32601（老 agent 广告面与实现面不一致）⇒ 降级
    /// skipped/method_not_found，本地删除（已先行）不受影响。
    #[tokio::test]
    async fn delete_downgrades_method_not_found_to_skipped() {
        register_delete_consumer();
        let (runtime, agent, _trace) = delete_runtime("delete-nf", Some("not-found")).await;
        let state = state_for("delete-nf", agent, &runtime);
        let outcome = delete_agent_session(&state, "delete-nf", "local:x", "remote-peri-1")
            .await
            .expect("-32601 必须降级而非报错");
        assert_eq!(outcome.get("outcome"), Some(&serde_json::json!("skipped")));
        assert_eq!(
            outcome.get("reason"),
            Some(&serde_json::json!("method_not_found"))
        );
    }

    /// 能力协商通过但 agent 删除失败 ⇒ Err 上抛（失败可见，前端 reportError）。
    #[tokio::test]
    async fn delete_failure_propagates_after_capability_gate() {
        register_delete_consumer();
        let (runtime, agent, _trace) = delete_runtime("delete-fail", Some("error")).await;
        let state = state_for("delete-fail", agent, &runtime);
        let error = delete_agent_session(&state, "delete-fail", "local:x", "remote-peri-1")
            .await
            .expect_err("RPC 失败必须上抛");
        assert!(
            error.to_string().contains("session/delete rpc failed"),
            "实际: {error}"
        );
    }

    /// periId 缺失（从未连接 agent 的本地会话）⇒ skipped/no_remote_session，
    /// 不解析 runtime。
    #[tokio::test]
    async fn delete_skips_when_no_remote_session() {
        register_delete_consumer();
        // 不注册任何 runtime：若尝试路由会返回 agent_runtime_unavailable 而非
        // no_remote_session——以此断言 periId 空分支先行短路。
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let outcome = delete_agent_session(&state, "ghost-agent", "local:x", "  ")
            .await
            .expect("periId 缺失是跳过而非错误");
        assert_eq!(outcome.get("outcome"), Some(&serde_json::json!("skipped")));
        assert_eq!(
            outcome.get("reason"),
            Some(&serde_json::json!("no_remote_session"))
        );
    }
}
