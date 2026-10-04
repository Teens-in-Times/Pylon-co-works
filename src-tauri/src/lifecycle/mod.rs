//! Agent 生命周期：连接/切换/registry 命令 + MCP 配置持久化（R1 拆分自 lib.rs；行为零变化）。
//!
//! # R9：LifecycleOp 状态机与统一串行化
//!
//! 生命周期操作（switch / reconnect / 自动重连 / 平台懒启动 / GUI 发送前懒重连）统一走
//! [`do_connect_and_replace`]，并按下表串行约束执行（C7 落地 switch_lock，
//! R9 复核全部入口后整理为显式状态机文档化）：
//!
//! | 入口 | switch_lock | agent_lifecycle | 锁后复查 | 清理 |
//! |------|------------|-----------------|---------|------|
//! | `switch_agent` | ✓ | ✓（目标 runtime） | ✓ 目标状态（C7） | ✓ stop_agent_runtime(旧 active) |
//! | `reconnect_agent` | ✓ | ✓（active runtime） | —（强制重连语义，锁已串行） | — |
//! | 自动重连（dispatcher.rs） | —（无 kill，无交叉清理面） | ✓（本 runtime） | ✓ P2-1 锁后 stale 复查 + 每轮 active 复查 | — |
//! | `ensure_runtime_ready`（平台懒启动，session.rs） | —（无 kill） | ✓（目标 runtime） | ✓ 双检查 | — |
//! | `ensure_connected_for_send`（GUI 发送/建会话懒重连，session.rs #379/#451） | —（无 kill） | ✓（目标 runtime） | ✓ 双检查（Disconnected；或「无主 Crashed」= ¬auto_reconnect_active ∧ acp.is_dead()，状态/标志/is_dead 锁后全重读） | — |
//!
//! 状态机（状态载体 = [`AgentLifecycleStatus`]；LifecycleOp 是操作视角的命名，
//! 不引入平行枚举——状态已由该字段承载，避免双份类型漂移）：
//! `Idle(Disconnected)` → `Connecting` → `Connected`；`Connected` →
//! `Reconnecting`（手动/自动重连）→ `Connected`；`Crashed`/`Error` 是
//! 崩溃/失败终态（崩溃通知、连接失败路径进入），自动重连在 `Crashed` 上以
//! 退避序列回到 `Reconnecting` → `Connected`。#451：无崩溃通知的「无主
//! Crashed」（connect 总预算超时残留、自动重连放弃残留）由发送路径
//! `ensure_connected_for_send` 按上述触发集接管回 `Connecting`。
//!
//! 统一序列：**取锁**（switch_lock 串行手动操作避免交叉杀进程；agent_lifecycle
//! 串行同一 runtime 的所有连接）→ **复查**（锁后按现状决策，不盲杀在途连接）→
//! **连接**（[`do_connect_and_replace`]，四入口共用）→ **清理**（switch 停旧
//! active 进程）。锁序一致：switch_lock 先于 agent_lifecycle（switch/reconnect），
//! 无锁序反转；无 kill 的入口（自动重连/懒启动）不持 switch_lock，与持锁入口
//! 仅共享 agent_lifecycle，无死锁环。`reload_agents` 是 C6 的 registry 操作
//! （持 active runtime 的 agent_lifecycle，仅杀被移除且非 active 的 runtime，
//! 与 switch 的清理集合不相交），不在 R9 的 switch_lock 串行范围内。

use pylon_foundations::await_guard::HeldAcrossAwait;
use std::sync::Arc;

use crate::acp::AcpClient;
use crate::agent::runtime::{
    status_after_connection_failure, AgentLifecycleStatus, ClientActivation, ClientEpoch,
    SessionContinuity,
};
use crate::agent_config::AgentDef;
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::AppState;
use crate::AppStateHandles;

/// 连接 + 原子替换客户端（手动/自动重连/平台懒启动共用）。
/// #421：connect 全程受 [`budgets::CONNECT_TOTAL_BUDGET_SECS`]（60s TotalDeadline）
/// 包裹，超时按既有 Crashed 收敛——见函数内预算分支注释。
// clippy 2026-08-02：9 参为连接全参数（handles/runtime/window/agent/agent_id/start_status/
// log_action/continuity/announce），跨 4 个调用点共享签名，保持显式（结构体重构收益低）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn do_connect_and_replace<R: tauri::Runtime>(
    handles: &AppStateHandles,
    runtime: &Arc<AgentRuntime>,
    window: &tauri::Window<R>,
    agent: &AgentDef,
    agent_id: Option<String>,
    start_status: AgentLifecycleStatus,
    log_action: &str,
    continuity: SessionContinuity,
    announce: bool,
) -> Result<(), String> {
    let previous_status = runtime
        .agent_runtime
        .lock()
        .map(|state| state.status)
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    if announce {
        handles.emit_agent_status(runtime, window, start_status, None);
    }
    handles.log_runtime_summary(
        "info",
        "agent",
        agent_id.clone(),
        &format!("Agent {log_action} started"),
        serde_json::Map::new(),
    );
    let next_generation = runtime
        .client_generation
        .load(std::sync::atomic::Ordering::Acquire)
        + 1;
    // #421：生产 connect 总预算（TotalDeadline，形状见 budgets.rs）——盖过
    // initialize 的 rpc_timeout（默认 30s、可配至 300s）作为外层上限；死 agent
    // 握手悬置时在此切断，switch_lock→agent_lifecycle 双锁持有期随之有界。
    // 超时取消 connect future 后，已 spawn 的子进程树由 `ManagedChild::drop` 的
    // kill_and_wait 兜底（Job Object / taskkill），与既有错误路径同语义。
    let connect_budget_secs = budgets::connect_budget_secs();
    let new_acp = match tokio::time::timeout(
        std::time::Duration::from_secs(connect_budget_secs),
        AcpClient::connect_with_generation(
            agent,
            Some(handles.runtime_logs.clone()),
            // OBS-02：新连接将激活为 current+1 代际（replace_agent_client 的
            // fetch_add(1)+1 一致），wire trace 据此记录 clientGeneration。
            next_generation,
        ),
    )
    .await
    {
        Ok(Ok(client)) => client,
        Ok(Err(error)) => {
            let fallback_status = status_after_connection_failure(previous_status);
            if announce {
                handles.emit_agent_status(
                    runtime,
                    window,
                    fallback_status,
                    Some(error.to_string()),
                );
            }
            handles.log_runtime_summary(
                "error",
                "agent",
                agent_id,
                &format!("Agent {log_action} failed"),
                serde_json::Map::new(),
            );
            return Err(error.into());
        }
        // #421：预算耗尽 = agent 无响应，按既有 Crashed 收敛路径处置（不发明
        // 新 runtime 状态）。调用方语义照旧：自动重连经 crash_reconnect 既有
        // Err 分支退避重试（机制复用；status 保持 Crashed 使其 still_stale 复查
        // 成立），手动 switch/reconnect/restart 在预算处释放双锁并向前端播报
        // crashed + lastError。
        Err(_elapsed) => {
            let message = format!(
                "connect total budget exceeded ({}s); agent unresponsive, treated as crashed",
                connect_budget_secs
            );
            if announce {
                handles.emit_agent_status(
                    runtime,
                    window,
                    AgentLifecycleStatus::Crashed,
                    Some(message.clone()),
                );
            }
            handles.log_runtime_summary(
                "error",
                "agent",
                agent_id,
                &format!("Agent {log_action} failed"),
                serde_json::Map::from_iter([(
                    "code".to_string(),
                    serde_json::Value::String("connect_budget_exceeded".to_string()),
                )]),
            );
            return Err(message);
        }
    };
    // B3：登记实例（InstanceKey = agentId/instanceId/generation）——全局并发
    // 预算 + 诊断表；超限即回收刚建立的连接并显形 `instance_limit`，不排队。
    // 调用方缺 agent id 时以 AgentDef.name 兜底——注册表身份要求稳定唯一，
    // 不要求等于 agents.yaml 键（诊断维度）。
    let instance_identity = agent_id.clone().unwrap_or_else(|| agent.name.clone());
    let instance_key = crate::acp::instance_registry::InstanceKey {
        agent_id: instance_identity.clone(),
        instance_id: instance_identity,
        generation: next_generation,
    };
    let instance_guard = match crate::acp::instance_registry::instance_registry()
        .register(instance_key, new_acp.instance_pid())
    {
        Ok(guard) => guard,
        Err(error) => {
            // 预算拒绝：新连接必须当场回收（RAII kill），状态回落。
            let message = error.to_string();
            drop(new_acp);
            if announce {
                handles.emit_agent_status(
                    runtime,
                    window,
                    status_after_connection_failure(previous_status),
                    Some(message.clone()),
                );
            }
            handles.log_runtime_summary(
                "error",
                "agent",
                agent_id,
                "Agent instance rejected by global budget",
                serde_json::Map::from_iter([(
                    "code".to_string(),
                    serde_json::Value::String("instance_limit".to_string()),
                )]),
            );
            return Err(message);
        }
    };
    if let Ok(mut slot) = runtime.instance_guard.lock() {
        *slot = Some(instance_guard);
    }
    let host_env = agent
        .env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<std::collections::BTreeMap<_, _>>();
    // #316：YAML 双门声明优先，env 兼容回退（见 HostToolsPolicy::resolve）。
    runtime.set_host_tools_policy(agent.protocol(), &host_env);
    // 本地 client epoch 与远端 Session continuity 分开表达。Unknown 不迁移旧映射；
    // replace 后由有界 probe 收敛，Invalidated 直接清除，Preserved 才直接迁移。
    let activation = ClientActivation {
        epoch: ClientEpoch(
            runtime
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire)
                .checked_add(1)
                .ok_or_else(|| "agent client generation exhausted".to_string())?,
        ),
        continuity,
    };
    tracing::debug!(
        "client activation: epoch={:?} continuity={:?} log_action={log_action}",
        activation.epoch.0,
        activation.continuity
    );
    let probe_candidates = match handles
        .replace_agent_client(runtime, agent_id, new_acp, window.clone(), activation)
        .await
    {
        Ok(candidates) => candidates,
        Err(error) => {
            // C7：replace 失败收敛——连接成功但客户端激活失败（如新 acp 已崩溃），
            // 不得停留在 start_status（Connecting/Reconnecting）卡死；广播失败
            // 状态 + 错误后返回（announce 路径才广播，事件次数不变）。
            if announce {
                handles.emit_agent_status(
                    runtime,
                    window,
                    status_after_connection_failure(previous_status),
                    Some(error.clone()),
                );
            }
            return Err(error);
        }
    };
    if let Ok(mut state) = runtime.agent_runtime.lock() {
        state.activated_config_fingerprint = Some(agent.runtime_fingerprint());
    }
    probe_unknown_session_continuity(runtime, agent, probe_candidates, activation.epoch.0).await;
    if announce {
        handles.emit_agent_status(runtime, window, AgentLifecycleStatus::Connected, None);
    }
    let _ = handles
        .pet
        .lock()
        .map(|mut p| crate::pet::on_agent_connected(&mut p));
    handles.log_runtime_summary(
        "info",
        "agent",
        None,
        &format!("Agent {log_action} succeeded"),
        serde_json::Map::new(),
    );
    Ok(())
}

#[tauri::command]
// C7/R9：switch_lock→agent_lifecycle 跨 await 串行是 LifecycleOp 状态机设计（模块文档）
pub(crate) async fn switch_agent<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::Window<R>,
    name: String,
) -> Result<(), PylonError> {
    let inner = state.inner();
    // C7：switch/reconnect 串行锁——并发 switch 不得交叉 kill 同一批旧进程。
    // R9：LifecycleOp 统一序列的"取锁"步（switch_lock → agent_lifecycle，见模块文档）。
    let _switch_guard = HeldAcrossAwait::new(inner.switch_lock.lock().await);
    // P3：先查 registry 确认 agent 存在，再 get_or_create——未知 agent 直接报错，
    // 不得留下幽灵 runtime（disconnected 且永不连接的空注册项）。
    if !agent_exists_in_registry(inner, &name) {
        return Err(PylonError::Protocol(format!("unknown agent: {name}")));
    }
    // 目标 runtime 懒启动（首次切换创建 disconnected runtime）
    let runtime = inner.runtimes.get_or_create(&name);
    let previous_active = inner
        .active_agent
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let _lifecycle_guard = HeldAcrossAwait::new(runtime.agent_lifecycle.lock().await);
    // C7：锁后复查——目标 runtime 的生命周期锁排队期间状态可能已推进（并发
    // 连接/自动重连完成），拿到锁后按现状决策，不得盲杀在途连接。
    let target_status = runtime
        .agent_runtime
        .lock()
        .map(|state| state.status)
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    let agent = agent_from_registry(inner, &name)?;
    if matches!(
        target_status,
        AgentLifecycleStatus::Connected
            | AgentLifecycleStatus::Connecting
            | AgentLifecycleStatus::Reconnecting
    ) {
        if previous_active == name {
            // 同 agent 幂等：已连接/连接中，无需重复连接。
            return Ok(());
        }
        if target_status == AgentLifecycleStatus::Connected {
            // 非 active 目标已连接：只更新 active_agent + 清理旧进程，
            // 跳过 connect_and_replace（不重复连接、不换客户端）。
            if let Ok(mut active) = inner.active_agent.lock() {
                *active = name;
            }
            stop_agent_runtime(&previous_active, inner).await;
            return Ok(());
        }
        // 目标 Connecting/Reconnecting（如自动重连在途）：继续走连接路径，
        // connect_and_replace 会在 lifecycle 锁下收敛为新客户端。
    }
    // 直接调泛型 do_connect_and_replace（与 AppState::connect_and_replace 包装器
    // 同一实现：continuity=Invalidated + announce=true）；窗口类型随调用方 Runtime。
    let handles = AppStateHandles::from_state(inner);
    do_connect_and_replace(
        &handles,
        &runtime,
        &window,
        &agent,
        Some(name.clone()),
        AgentLifecycleStatus::Connecting,
        "switch",
        SessionContinuity::Invalidated,
        true,
    )
    .await?;
    // 切到不同 agent 时：先停旧 dispatcher 再 kill 旧 acp，防止 kill 触发旧
    // runtime 的崩溃通知被旧 dispatcher 处理并调度自动重连；旧状态置 Disconnected。
    if previous_active != name {
        stop_agent_runtime(&previous_active, inner).await;
    }
    Ok(())
}

#[tauri::command]
// C7/R9：与 switch_agent 共用串行锁，防交叉杀进程
pub(crate) async fn reconnect_agent(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<(), PylonError> {
    let inner = state.inner();
    // C7：switch/reconnect 串行锁（与 switch_agent 共用，防交叉杀进程）。
    // R9：LifecycleOp 统一序列"取锁"步（switch_lock → agent_lifecycle，见模块文档）。
    let _switch_guard = HeldAcrossAwait::new(inner.switch_lock.lock().await);
    let active_id = inner
        .active_agent
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let runtime = inner.runtimes.get_or_create(&active_id);
    let _lifecycle_guard = HeldAcrossAwait::new(runtime.agent_lifecycle.lock().await);
    let agent = inner.get_active_agent()?;
    inner
        .connect_and_replace(
            &runtime,
            &window,
            &agent,
            None,
            AgentLifecycleStatus::Reconnecting,
            "reconnect",
        )
        .await
        .map_err(PylonError::from)
}

#[tauri::command]
// C7/R9：restart 属 LifecycleOp 统一序列，须与 switch/reconnect 串行
pub(crate) async fn restart_agent_runtime<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::Window<R>,
    agent_id: String,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    let _switch_guard = HeldAcrossAwait::new(inner.switch_lock.lock().await);
    let active_id = inner
        .active_agent
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if active_id != agent_id {
        return Err(PylonError::Protocol(format!(
            "agent runtime restart requires active agent: requested {agent_id}, active {active_id}"
        )));
    }
    let runtime = inner.runtimes.get_or_create(&agent_id);
    let _lifecycle_guard = HeldAcrossAwait::new(runtime.agent_lifecycle.lock().await);
    let agent = agent_from_registry(inner, &agent_id)?;
    let handles = AppStateHandles::from_state(inner);
    do_connect_and_replace(
        &handles,
        &runtime,
        &window,
        &agent,
        None,
        AgentLifecycleStatus::Reconnecting,
        "config-restart",
        SessionContinuity::Invalidated,
        true,
    )
    .await
    .map_err(PylonError::from)?;
    Ok(serde_json::json!({
        "agentId": agent_id,
        "generation": runtime.client_generation.load(std::sync::atomic::Ordering::Acquire),
        "configActivationState": stored_agent_activation(inner, &active_id),
    }))
}

pub(crate) mod budgets;
pub(crate) mod config_cmds;
pub(crate) mod connection_test;
pub(crate) mod mcp;
pub(crate) mod registry;
pub(crate) mod session_probe;
pub(crate) mod stop;
pub(crate) mod summary;
pub(crate) mod verification;

// 拆分后的命令/纯函数块经此 re-export：tauri::generate_handler、兄弟子模块
// `use super::*`（config_cmds/connection_test）、session/expiry 对
// stop_agent_runtime 的调用与测试的 `use super::*` 路径全部不变。
// `__cmd__*` 是 tauri::command 宏生成的隐藏项，必须一并 re-export 才能被 generate_handler 解析。
#[cfg(test)]
use crate::acp::{AcpError, AgentConnectFailure, AgentConnectStage};
#[allow(unused_imports)]
pub(crate) use registry::__cmd__acp_wire_trace_snapshot;
#[allow(unused_imports)]
pub(crate) use registry::__cmd__agent_status;
#[allow(unused_imports)]
pub(crate) use registry::__cmd__list_agents;
#[allow(unused_imports)]
pub(crate) use registry::__cmd__list_tool_dictionary;
#[allow(unused_imports)]
pub(crate) use registry::__cmd__set_session_state;
#[allow(unused_imports)]
pub(crate) use registry::__cmd__validate_agents;
pub(crate) use registry::__tauri_command_name_acp_wire_trace_snapshot;
pub(crate) use registry::__tauri_command_name_agent_status;
pub(crate) use registry::__tauri_command_name_list_agents;
pub(crate) use registry::__tauri_command_name_list_tool_dictionary;
pub(crate) use registry::__tauri_command_name_set_session_state;
pub(crate) use registry::__tauri_command_name_validate_agents;
pub(crate) use registry::{
    acp_wire_trace_snapshot, agent_exists_in_registry, agent_from_registry, agent_status,
    list_agents, list_tool_dictionary, set_session_state, validate_agents,
};
pub(crate) use session_probe::probe_unknown_session_continuity;
pub(crate) use stop::{remove_stale_runtimes, stop_agent_runtime};
// summary 块的 config_activation_state/AgentConfigActivationState 仅测试与块内消费。
#[cfg(test)]
use budgets::AGENT_VALIDATION_TIMEOUT_SECS;
#[allow(unused_imports)]
pub(crate) use config_cmds::__cmd__agent_config_snapshot;
#[allow(unused_imports)]
pub(crate) use config_cmds::__cmd__initialize_agents_config;
#[allow(unused_imports)]
pub(crate) use config_cmds::__cmd__reload_agents;
#[allow(unused_imports)]
pub(crate) use config_cmds::__cmd__update_agents_config;
pub(crate) use config_cmds::__tauri_command_name_agent_config_snapshot;
pub(crate) use config_cmds::__tauri_command_name_initialize_agents_config;
pub(crate) use config_cmds::__tauri_command_name_reload_agents;
pub(crate) use config_cmds::__tauri_command_name_update_agents_config;
pub(crate) use config_cmds::{
    agent_config_snapshot, initialize_agents_config, reload_agents, update_agents_config,
};
#[allow(unused_imports)]
pub(crate) use connection_test::__cmd__test_agent_candidate;
#[allow(unused_imports)]
pub(crate) use connection_test::__cmd__test_agent_connection;
pub(crate) use connection_test::__tauri_command_name_test_agent_candidate;
pub(crate) use connection_test::__tauri_command_name_test_agent_connection;
#[cfg(test)]
use connection_test::candidate_stderr;
#[cfg(test)]
use connection_test::connection_test_error_payload;
pub(crate) use connection_test::{test_agent_candidate, test_agent_connection};
#[allow(unused_imports)]
pub(crate) use mcp::__cmd__get_mcp_servers;
#[allow(unused_imports)]
pub(crate) use mcp::__cmd__set_mcp_servers;
pub(crate) use mcp::__tauri_command_name_get_mcp_servers;
pub(crate) use mcp::__tauri_command_name_set_mcp_servers;
pub(crate) use mcp::{get_mcp_servers, load_mcp_persisted, set_mcp_servers};
#[allow(unused_imports)]
pub(crate) use summary::{
    agent_summary_payload, agent_summary_payload_with_activation, config_activation_state,
    stored_agent_activation, AgentConfigActivationState,
};

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    fn agent() -> AgentDef {
        crate::test_utils::fake_acp_agent_stub("peri")
    }

    #[test]
    fn summary_marks_active_and_available_only_when_connected() {
        let a = agent();
        let disconnected = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Disconnected),
            false,
        );
        assert_eq!(disconnected["active"], true);
        assert_eq!(disconnected["available"], false, "未连接不算可用");
        let connected = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
            false,
        );
        assert_eq!(connected["available"], true, "连接后 available 才为 true");
    }

    #[test]
    fn summary_non_active_agent_is_neither_active_nor_available() {
        let a = agent();
        let payload = agent_summary_payload(
            "peri",
            &a,
            Some("hermes"),
            Some(AgentLifecycleStatus::Connected),
            false,
        );
        assert_eq!(payload["id"], "peri");
        assert_eq!(payload["name"], "peri");
        assert_eq!(payload["transport"], "subprocess");
        assert_eq!(payload["active"], false);
        assert_eq!(
            payload["available"], false,
            "非 active agent 即使有连接也不可用"
        );
    }

    #[test]
    fn summary_without_active_context_is_inactive() {
        let a = agent();
        let payload = agent_summary_payload("peri", &a, None, None, false);
        assert_eq!(payload["active"], false);
        assert_eq!(payload["available"], false);
    }

    #[test]
    fn summary_preserves_editable_args_and_reports_effective_command_args() {
        let mut a = agent();
        a.args = vec!["acp".to_string(), "work space".to_string(), String::new()];
        a.model = Some("demo".to_string());
        a.acp_args = vec!["--verbose".to_string()];

        let payload = agent_summary_payload("peri", &a, None, None, false);

        assert_eq!(
            payload["args"],
            serde_json::json!(["acp", "work space", ""])
        );
        assert_eq!(
            payload["effectiveArgs"],
            serde_json::json!(["acp", "work space", "", "--model", "demo", "--verbose"])
        );
        assert!(payload.get("env").is_none(), "summary 不得暴露环境变量");
    }

    #[test]
    fn config_activation_state_distinguishes_display_and_runtime_changes() {
        let stored = agent();
        let activated = stored.runtime_fingerprint();
        assert_eq!(
            config_activation_state(
                &stored,
                true,
                Some(AgentLifecycleStatus::Connected),
                Some(&activated),
            ),
            AgentConfigActivationState::Activated
        );

        let mut display_only = stored.clone();
        display_only.name = "renamed".into();
        display_only.default = !display_only.default;
        assert_eq!(
            config_activation_state(
                &display_only,
                true,
                Some(AgentLifecycleStatus::Connected),
                Some(&activated),
            ),
            AgentConfigActivationState::Activated
        );

        let mut changed = stored;
        changed.args.push("--new-runtime-option".into());
        assert_eq!(
            config_activation_state(
                &changed,
                true,
                Some(AgentLifecycleStatus::Connected),
                Some(&activated),
            ),
            AgentConfigActivationState::PendingRestart
        );
        assert_eq!(
            config_activation_state(
                &changed,
                false,
                Some(AgentLifecycleStatus::Connected),
                Some(&activated),
            ),
            AgentConfigActivationState::Stored
        );
    }

    /// P0-1：parse 推断出的 provider 必须进入 list_agents 摘要（旧配置无 provider 也能正确分类）。
    #[test]
    fn summary_reports_resolved_provider_from_parse() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-summary-provider-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri-copy:\n    name: Peri Copy\n    transport: subprocess\n    exe: peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = crate::agent_config::load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let agent = &agents["peri-copy"];
        assert_eq!(
            agent.provider.as_deref(),
            Some("peri"),
            "解析时须按 exe 类型推断 provider"
        );
        let payload = agent_summary_payload("peri-copy", agent, None, None, false);
        assert_eq!(
            payload["provider"], "peri",
            "list_agents 摘要必须携带解析后的 provider"
        );
    }

    #[test]
    fn summary_available_follows_effective_status() {
        // 方案 3（漂移修复）：crashed=true 时 status 有效值为 crashed、available=false
        // ——与 agent_status_payload 的推导一致（修复前 crashed=true, available=true
        // 的矛盾组合，前端状态灯会误判可用）。
        let a = agent();
        let payload = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
            true,
        );
        assert_eq!(payload["crashed"], true, "crashed 必须透传");
        assert_eq!(
            payload["available"], false,
            "process_crashed 时即使 lifecycle=Connected 也不可用"
        );
        let alive = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
            false,
        );
        assert_eq!(alive["available"], true, "未崩溃 + active + Connected 可用");
        let crashed_disconnected = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Disconnected),
            true,
        );
        assert_eq!(crashed_disconnected["available"], false);
        assert_eq!(crashed_disconnected["crashed"], true);
    }

    #[test]
    fn summary_matrix_matches_agent_status_semantics() {
        // 方案 3 一致性矩阵（与 agent_status_payload 的 effective_status/available
        // 语义一致）：lifecycle + process_crashed → (status 是否 crashed, available)。
        let a = agent();
        // (lifecycle, crashed, status 是否为 crashed —— 与 agent_status_payload
        // 的 effective_status 语义参照，list_agents wire 不输出 status 字段,
        // expected_available)
        let cases: &[(AgentLifecycleStatus, bool, bool, bool)] = &[
            (AgentLifecycleStatus::Connected, false, false, true),
            (AgentLifecycleStatus::Connected, true, true, false),
            (AgentLifecycleStatus::Reconnecting, false, false, false),
            (AgentLifecycleStatus::Disconnected, false, false, false),
            (AgentLifecycleStatus::Crashed, true, true, false),
        ];
        for (lifecycle, crashed, _status_crashed, available) in cases {
            let payload =
                agent_summary_payload("peri", &a, Some("peri"), Some(*lifecycle), *crashed);
            assert_eq!(
                payload["available"],
                serde_json::Value::Bool(*available),
                "lifecycle={lifecycle:?} crashed={crashed} available 不符"
            );
            assert_eq!(payload["crashed"], serde_json::Value::Bool(*crashed));
        }
    }

    async fn mock_window() -> tauri::Window<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window must build")
        .as_ref()
        .window()
    }

    #[tokio::test]
    async fn switch_to_same_agent_already_connected_is_idempotent() {
        let runtime = crate::test_utils::connected_runtime();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(crate::test_utils::fake_acp_agent_stub("peri"))
            .with_runtime("peri", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        switch_agent(
            app.state::<AppState>(),
            mock_window().await,
            "peri".to_string(),
        )
        .await
        .expect("同 agent 已连接时 switch 必须幂等成功");
        let state = app.state::<AppState>().inner();
        let runtime = state.runtimes.get("peri").expect("runtime must exist");
        assert_eq!(
            runtime
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            0,
            "幂等路径不得触发 connect_and_replace（generation 不变）"
        );
        assert_eq!(
            runtime.agent_runtime.lock().unwrap().status,
            AgentLifecycleStatus::Connected,
            "目标状态必须保持 Connected"
        );
    }

    #[tokio::test]
    async fn restart_runtime_success_activates_stored_fingerprint_and_advances_generation() {
        let agent = crate::test_utils::fake_acp_agent_stub("peri");
        let expected_fingerprint = agent.runtime_fingerprint();
        let runtime = crate::test_utils::connected_runtime();
        runtime
            .client_generation
            .store(4, std::sync::atomic::Ordering::Release);
        runtime
            .agent_runtime
            .lock()
            .unwrap()
            .activated_config_fingerprint = Some("old-definition".into());
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(agent.clone())
            .with_runtime("peri", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        let payload =
            restart_agent_runtime(app.state::<AppState>(), mock_window().await, "peri".into())
                .await
                .expect("restart succeeds");
        assert_eq!(payload["generation"], 5);
        assert_eq!(payload["configActivationState"], "activated");
        assert_eq!(
            runtime
                .agent_runtime
                .lock()
                .unwrap()
                .activated_config_fingerprint
                .as_deref(),
            Some(expected_fingerprint.as_str())
        );
    }

    #[tokio::test]
    async fn restart_runtime_failure_keeps_old_generation_and_pending_fingerprint() {
        let mut agent = crate::test_utils::fake_acp_agent_stub("peri");
        agent.exe = std::env::temp_dir()
            .join("missing-pylon-restart-agent")
            .to_string_lossy()
            .to_string();
        let runtime = crate::test_utils::connected_runtime();
        runtime
            .client_generation
            .store(7, std::sync::atomic::Ordering::Release);
        runtime
            .agent_runtime
            .lock()
            .unwrap()
            .activated_config_fingerprint = Some("old-definition".into());
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(agent)
            .with_runtime("peri", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        let error =
            restart_agent_runtime(app.state::<AppState>(), mock_window().await, "peri".into())
                .await
                .expect_err("restart must fail");
        assert_eq!(error.code(), "protocol_error");
        assert_eq!(
            runtime
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            7
        );
        let state = runtime.agent_runtime.lock().unwrap();
        assert_eq!(state.status, AgentLifecycleStatus::Connected);
        assert_eq!(
            state.activated_config_fingerprint.as_deref(),
            Some("old-definition")
        );
    }

    /// #421：生产 connect 总预算——hang 场景（驻留 3600s、永不应答 initialize）
    /// 在 TotalDeadline 处被切断，收敛走既有 Crashed 语义。判别证据：进入时
    /// 前一状态为 Disconnected，普通连接错误会经 `status_after_connection_failure`
    /// 回落 Disconnected——终态 Crashed 只能来自预算分支。预算经测试注入缝
    /// 取 2s（真子进程 + 真时钟；模拟时钟不可用的论证见 budgets.rs）。
    #[tokio::test]
    async fn connect_total_budget_cuts_hung_agent_and_converges_to_crashed() {
        assert_eq!(
            budgets::CONNECT_TOTAL_BUDGET_SECS,
            60,
            "预算常量 pin（#417 裁决值）"
        );
        assert_eq!(
            budgets::connect_budget_secs(),
            budgets::CONNECT_TOTAL_BUDGET_SECS,
            "未注入时解析口必须返回常量默认"
        );
        // #451：注入缝已是双消费者，与 session 侧预算链测试共用 INJECTION_LOCK
        // 串行（进程全局值，并行 set/clear 互相踩——见 budgets.rs 注入缝 doc）。
        // 锁卫有意跨 await 持有（串行化正是语义），经 HeldAcrossAwait 收口。
        let _injection_guard = HeldAcrossAwait::new(
            budgets::connect_budget_override::INJECTION_LOCK
                .lock()
                .unwrap_or_else(|p| p.into_inner()),
        );
        budgets::connect_budget_override::set(2);
        struct RestoreBudget;
        impl Drop for RestoreBudget {
            fn drop(&mut self) {
                budgets::connect_budget_override::clear();
            }
        }
        let _restore = RestoreBudget;
        let agent = crate::test_utils::fake_acp_agent("budget-hang", &["--scenario", "hang"]);
        let runtime = crate::runtime::AgentRuntime::new_disconnected();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_agent(agent.clone())
            .with_runtime("budget-hang", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
        let error = do_connect_and_replace(
            &handles,
            &runtime,
            &mock_window().await,
            &agent,
            Some("budget-hang".to_string()),
            AgentLifecycleStatus::Connecting,
            "switch",
            SessionContinuity::Invalidated,
            true,
        )
        .await
        .expect_err("hang agent 必须被总预算切断");
        assert!(
            error.contains("connect total budget exceeded"),
            "Err 必须携带预算标记，实际: {error}"
        );
        let state = runtime.agent_runtime.lock().unwrap();
        assert_eq!(
            state.status,
            AgentLifecycleStatus::Crashed,
            "预算超时按既有 Crashed 收敛（不发明新状态）"
        );
        assert!(
            state
                .last_error
                .as_deref()
                .is_some_and(|message| message.contains("connect total budget exceeded")),
            "lastError 必须携带预算标记，实际: {:?}",
            state.last_error
        );
    }

    #[tokio::test]
    async fn restart_runtime_session_migration_failure_is_atomic() {
        let agent = crate::test_utils::fake_acp_agent_stub("peri");
        let runtime = crate::test_utils::connected_runtime();
        runtime
            .client_generation
            .store(7, std::sync::atomic::Ordering::Release);
        runtime
            .agent_runtime
            .lock()
            .unwrap()
            .activated_config_fingerprint = Some("old-definition".into());
        let sessions = runtime.sessions.clone();
        let _ = std::thread::spawn(move || {
            let _guard = sessions.lock().expect("sessions lock starts healthy");
            panic!("poison sessions lock");
        })
        .join();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(agent)
            .with_runtime("peri", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        restart_agent_runtime(app.state::<AppState>(), mock_window().await, "peri".into())
            .await
            .expect_err("poisoned session migration must fail");

        assert_eq!(
            runtime
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            7,
            "failed migration must not activate the candidate client"
        );
        let state = runtime.agent_runtime.lock().unwrap();
        assert_eq!(state.status, AgentLifecycleStatus::Connected);
        assert_eq!(
            state.activated_config_fingerprint.as_deref(),
            Some("old-definition")
        );
    }

    #[tokio::test]
    async fn unknown_continuity_probes_each_session_and_converges_health() {
        let mut agent = crate::test_utils::fake_acp_agent("peri", &["--scenario", "probe"]);
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            rpc_timeout_secs: Some(1),
            ..Default::default()
        });
        let runtime = crate::test_utils::connected_runtime();
        runtime
            .client_generation
            .store(4, std::sync::atomic::Ordering::Release);
        for (source, remote) in [
            ("source-ok", "remote-ok"),
            ("source-missing", "remote-missing"),
            ("source-timeout", "remote-timeout"),
        ] {
            crate::session::store::insert(
                &runtime,
                source,
                crate::session::SessionInfo::new(remote.into(), String::new(), ".".into(), true, 4),
                true,
                100,
            )
            .unwrap();
        }
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(agent.clone())
            .with_runtime("peri", runtime.clone())
            .build();
        let handles = AppStateHandles::from_state(&state);
        let window = mock_window().await;

        do_connect_and_replace(
            &handles,
            &runtime,
            &window,
            &agent,
            None,
            AgentLifecycleStatus::Reconnecting,
            "auto-reconnect",
            SessionContinuity::Unknown,
            false,
        )
        .await
        .expect("client reconnect succeeds even when one binding probe times out");

        let sessions = runtime.sessions.lock().unwrap();
        assert_eq!(sessions["source-ok"].generation, 5);
        assert!(
            sessions["source-ok"].last_response_text.is_empty(),
            "probe replay must be rejected before the binding becomes Attached"
        );
        assert!(!sessions.contains_key("source-missing"));
        assert_eq!(sessions["source-timeout"].generation, 4);
        drop(sessions);
        let health = runtime.binding_health.lock().unwrap();
        assert!(matches!(
            health["source-ok"],
            crate::agent::runtime::SessionBindingHealth::Attached { generation: 5 }
        ));
        assert!(matches!(
            health["source-missing"],
            crate::agent::runtime::SessionBindingHealth::Detached {
                retryable: false,
                ..
            }
        ));
        assert!(matches!(
            health["source-timeout"],
            crate::agent::runtime::SessionBindingHealth::Detached {
                retryable: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn switch_to_non_active_agent_already_connected_skips_reconnect() {
        let runtime_a = crate::test_utils::connected_runtime();
        let runtime_b = crate::test_utils::connected_runtime();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("a")
            .with_agent(crate::test_utils::fake_acp_agent_stub("a"))
            .with_agent(crate::test_utils::fake_acp_agent_stub("b"))
            .with_runtime("a", runtime_a.clone())
            .with_runtime("b", runtime_b.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        switch_agent(
            app.state::<AppState>(),
            mock_window().await,
            "b".to_string(),
        )
        .await
        .expect("非 active 已连接目标 switch 必须成功");
        let state = app.state::<AppState>().inner();
        assert_eq!(
            &*state.active_agent.lock().unwrap(),
            "b",
            "active_agent 必须切到 b"
        );
        assert_eq!(
            runtime_b
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            0,
            "已连接目标不得被重新连接（generation 不变）"
        );
        assert_eq!(
            runtime_b.agent_runtime.lock().unwrap().status,
            AgentLifecycleStatus::Connected,
            "目标 b 必须保持 Connected"
        );
        assert_eq!(
            runtime_a.agent_runtime.lock().unwrap().status,
            AgentLifecycleStatus::Disconnected,
            "旧 active（a）必须被停掉并置 Disconnected"
        );
    }

    #[test]
    fn summary_includes_exe_and_default_for_structured_form() {
        let mut a = agent();
        a.exe = "F:/Agent/peri.exe".to_string();
        a.default = true;
        let payload = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Disconnected),
            false,
        );
        assert_eq!(payload["exe"], "F:/Agent/peri.exe");
        assert_eq!(payload["default"], true);
        assert_eq!(payload["active"], true);
    }

    #[test]
    fn connection_test_error_payload_maps_executable_missing() {
        let failure = |stage, code: &str, message: &str, retryable| {
            AcpError::Connect(Box::new(AgentConnectFailure {
                stage,
                code: code.into(),
                message: message.into(),
                exit_code: None,
                stderr_excerpt: None,
                retryable,
                io_kind: None,
                remote_code: None,
                remote_data_summary: None,
            }))
        };
        let payload = connection_test_error_payload(&failure(
            AgentConnectStage::Preflight,
            "agent_executable_missing",
            "missing",
            false,
        ));
        assert_eq!(payload["code"], "agent_executable_missing");
        assert_eq!(payload["action"], "select_executable");
        assert_eq!(payload["stage"], "preflight");
        assert!(payload["exitCode"].is_null());
        assert!(payload["stderr"].is_null());
        let timeout = connection_test_error_payload(&failure(
            AgentConnectStage::Initialize,
            "agent_connection_timeout",
            "timeout",
            true,
        ));
        assert_eq!(timeout["code"], "agent_connection_timeout");
        assert_eq!(timeout["stage"], "initialize");
        let spawn = connection_test_error_payload(&failure(
            AgentConnectStage::Spawn,
            "agent_spawn_failed",
            "spawn",
            false,
        ));
        assert_eq!(spawn["code"], "agent_spawn_failed");
        assert_eq!(AGENT_VALIDATION_TIMEOUT_SECS, 15);
    }

    /// B1：连接测试响应的 launchPlan 与真实 spawn 同源（同一 planner），env 值
    /// 一律掩码——计划数据可能包含凭据型环境变量，掩码发生在边界。
    #[test]
    fn launch_plan_payload_masks_env_values_and_shares_the_real_planner() {
        use connection_test::launch_plan_payload;
        let mut agent = crate::agent_config::AgentDef {
            name: "Peri".into(),
            provider: Some("peri".into()),
            transport: "subprocess".into(),
            exe: "peri".into(),
            args: vec!["acp".into()],
            cwd: None,
            env: std::collections::HashMap::from([(
                "PERI_TOKEN".to_string(),
                "sk-super-secret".to_string(),
            )]),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        };
        let payload = launch_plan_payload(&agent);
        assert_eq!(payload["executable"], "peri");
        assert_eq!(
            payload["argv"],
            serde_json::json!(["peri", "acp"]),
            "argv 必须与真实启动一致（同一 planner 计算）"
        );
        assert_eq!(payload["env"][0]["name"], "PERI_TOKEN");
        assert_eq!(payload["env"][0]["value"], "value withheld");
        assert!(
            !payload.to_string().contains("sk-super-secret"),
            "env 值不得以任何形式出现在响应里"
        );

        // 无 provider 的自定义 agent：显式配置即可计划，错误也不得是 panic。
        agent.provider = None;
        agent.exe = "my-agent.exe".into();
        agent.env.clear();
        let custom = launch_plan_payload(&agent);
        assert_eq!(custom["executable"], "my-agent.exe");
    }

    /// B1：error payload 携带 typed cause（closed vocabulary 视图，前端只渲染）。
    #[test]
    fn connection_test_error_payload_carries_typed_cause() {
        let failure = AcpError::Connect(Box::new(AgentConnectFailure {
            stage: AgentConnectStage::Spawn,
            code: "agent_spawn_failed".into(),
            message: "spawn failed".into(),
            exit_code: None,
            stderr_excerpt: None,
            retryable: false,
            io_kind: None,
            remote_code: None,
            remote_data_summary: None,
        }));
        let payload = connection_test_error_payload(&failure);
        assert_eq!(payload["cause"]["level"], "fail");
        assert_eq!(payload["cause"]["code"], "agent_spawn_failed");
        assert_eq!(payload["cause"]["summary"], "spawn failed");
        assert_eq!(payload["cause"]["action"], "open-runtime-log");
    }

    #[test]
    fn candidate_stderr_is_bounded_and_preserves_chronological_order() {
        let logs = crate::runtime_log::RuntimeLogHub::new(8);
        for line in ["first diagnostic", "second diagnostic"] {
            logs.push(
                crate::time::Timestamp::now(),
                "error",
                "agent-stderr",
                None,
                line,
                serde_json::Map::new(),
            );
        }
        assert_eq!(
            candidate_stderr(&logs).as_deref(),
            Some("first diagnostic\nsecond diagnostic")
        );
    }

    #[tokio::test]
    async fn test_agent_candidate_native_process_returns_failure_diagnostics() {
        let agent = crate::test_utils::fake_acp_agent(
            "candidate-native-failure",
            &[
                "--scenario",
                "exit-immediately",
                "--exit-code",
                "7",
                "--stderr-marker",
                "Provider profile was not selected",
            ],
        );
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        let payload = test_agent_candidate(
            app.state::<AppState>(),
            "candidate-native-failure".to_string(),
            agent,
            None,
        )
        .await
        .expect("candidate validation should return a diagnostic payload");

        assert_eq!(payload["ok"], false);
        assert_eq!(payload["error"]["code"], "agent_initialize_failed");
        assert_eq!(payload["error"]["stage"], "initialize");
        // exitCode 是「initialize 失败那个瞬间子进程是否已被回收」的**尽力观测**
        // （`acp/client.rs` 的 `child.try_wait()`）：已回收则必为真实退出码 7，尚未回收
        // 则为 null。该时序随负载浮动（隔离跑常为 7、全量并发跑常为 null），
        // 故不断言其存在性，只锁定「一旦捕获到，必须就是子进程的真实退出码」。
        if let Some(code) = payload["error"]["exitCode"].as_i64() {
            assert_eq!(
                code, 7,
                "captured exit code must be the child's real exit code"
            );
        }
        assert!(payload["error"]["stderr"]
            .as_str()
            .unwrap_or_default()
            .contains("Provider profile was not selected"));
        assert!(payload["durationMs"].as_u64().unwrap_or(u64::MAX) < 15_000);
    }

    #[tokio::test]
    async fn test_agent_connection_unknown_agent_reports_error() {
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let result = test_agent_connection(app.state::<AppState>(), "ghost".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn update_agents_config_write_failure_keeps_memory_and_disk_unchanged() {
        // 施工文档 §2.1 必测失败链：目标文件可读但 backup replace 失败
        // → 主文件与内存 registry 都不变。
        // P91 批 C1（横切 §4）：配置路径经 update_agents_config_via 参数注入，
        // 不再 set_var/remove_var 进程全局 PYLON_AGENTS_CONFIG（原 EnvGuard 是
        // 进程级 env 变异，与并行测试竞态）。
        let dir = crate::test_utils::unique_temp("config-write-fail");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        let original =
            "agents:\n  keep:\n    name: Keep\n    transport: subprocess\n    exe: keep-agent\n";
        std::fs::write(&path, original).unwrap();
        let backup_blocker = path.with_extension("yaml.bak");
        std::fs::create_dir_all(&backup_blocker).unwrap();
        let revision = crate::agent_config::config_revision_for_bytes(original.as_bytes());

        let agent = crate::test_utils::fake_acp_agent_stub("keep");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("keep")
            .with_agent(agent)
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        let result = config_cmds::update_agents_config_via(
            app.state::<AppState>(),
            "agent".to_string(),
            Some("keep".to_string()),
            serde_json::json!("name: Renamed\n  transport: subprocess\n  exe: keep-agent\n"),
            Some(revision),
            Some(path.clone()),
        )
        .await;
        assert!(result.is_err(), "写盘失败必须返回错误");

        let state = app.state::<AppState>().inner();
        let agents = state.agents.lock().unwrap();
        assert_eq!(
            agents.get("keep").map(|agent| agent.name.as_str()),
            Some("keep"),
            "写盘失败后内存 registry 必须不变"
        );
        let disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(disk, original, "写盘失败后磁盘内容必须不变");

        std::fs::remove_dir_all(&backup_blocker).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── #422：B1 保存门禁后端化——连接测试凭证行为测试 ──

    /// 测试用 def 字面量（字段全列 = parse_agents 反序列化缺省形态，
    /// 保证与候选侧指纹可比；exe 建议单组件或绝对路径，避开 resolve 差异）。
    fn voucher_test_def(name: &str, exe: &str, args: &[&str]) -> AgentDef {
        AgentDef {
            name: name.to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: exe.to_string(),
            args: args.iter().map(|value| value.to_string()).collect(),
            cwd: None,
            env: std::collections::HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        }
    }

    /// #422 夹具：临时 agents.yaml（与 registry 同初态）+ mock app。
    fn voucher_gate_setup(
        label: &str,
        yaml: &str,
        agent: AgentDef,
    ) -> (
        tauri::App<tauri::test::MockRuntime>,
        std::path::PathBuf,
        String,
    ) {
        let dir = crate::test_utils::unique_temp(label);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        std::fs::write(&path, yaml).unwrap();
        let revision = crate::agent_config::config_revision_for_bytes(yaml.as_bytes());
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent(&agent.name)
            .with_agent(agent)
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        (app, path, revision)
    }

    async fn voucher_gate_update(
        app: &tauri::App<tauri::test::MockRuntime>,
        scope: &str,
        agent_id: Option<&str>,
        config: serde_json::Value,
        revision: &str,
        path: std::path::PathBuf,
    ) -> Result<serde_json::Value, PylonError> {
        config_cmds::update_agents_config_via(
            app.state::<AppState>(),
            scope.to_string(),
            agent_id.map(str::to_string),
            config,
            Some(revision.to_string()),
            Some(path),
        )
        .await
    }

    #[tokio::test]
    async fn update_agents_config_rejects_launch_change_without_voucher() {
        let yaml =
            "agents:\n  keep:\n    name: keep\n    transport: subprocess\n    exe: keep-agent\n";
        let (app, path, revision) = voucher_gate_setup(
            "voucher-reject",
            yaml,
            voucher_test_def("keep", "keep-agent", &[]),
        );
        let error = voucher_gate_update(
            &app,
            "agent_fields",
            Some("keep"),
            serde_json::json!({ "exe": "renamed-agent" }),
            &revision,
            path.clone(),
        )
        .await
        .expect_err("launch 指纹变更且无凭证必须 fail-closed 拒绝");
        assert!(
            matches!(
                error,
                PylonError::Config(crate::agent_config::ConfigError::VerificationRequired(_))
            ),
            "错误必须是 VerificationRequired: {error}"
        );
        // fail-closed：写盘前拦截，磁盘与内存 registry 均不变。
        assert_eq!(std::fs::read_to_string(&path).unwrap(), yaml);
        let agents = app.state::<AppState>().inner().agents.lock().unwrap();
        assert_eq!(
            agents.get("keep").map(|def| def.exe.as_str()),
            Some("keep-agent")
        );
    }

    #[tokio::test]
    async fn update_agents_config_allows_launch_change_with_voucher() {
        let yaml =
            "agents:\n  keep:\n    name: keep\n    transport: subprocess\n    exe: keep-agent\n";
        let (app, path, revision) = voucher_gate_setup(
            "voucher-allow",
            yaml,
            voucher_test_def("keep", "keep-agent", &[]),
        );
        let next = voucher_test_def("keep", "renamed-agent", &[]);
        app.state::<AppState>()
            .inner()
            .verified_agent_fingerprints
            .record("keep", &next.runtime_fingerprint());
        let result = voucher_gate_update(
            &app,
            "agent_fields",
            Some("keep"),
            serde_json::json!({ "exe": "renamed-agent" }),
            &revision,
            path.clone(),
        )
        .await
        .expect("持有该指纹凭证的保存必须放行");
        assert_eq!(result["applied"], true);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(disk.contains("renamed-agent"), "磁盘必须写入新 exe：{disk}");
        let agents = app.state::<AppState>().inner().agents.lock().unwrap();
        assert_eq!(
            agents.get("keep").map(|def| def.exe.as_str()),
            Some("renamed-agent"),
            "内存 registry 必须提交"
        );
    }

    #[tokio::test]
    async fn update_agents_config_rejects_stale_voucher_for_changed_fingerprint() {
        let yaml =
            "agents:\n  keep:\n    name: keep\n    transport: subprocess\n    exe: keep-agent\n";
        let (app, path, revision) = voucher_gate_setup(
            "voucher-stale",
            yaml,
            voucher_test_def("keep", "keep-agent", &[]),
        );
        // 凭证对应指纹 A（exe=renamed-agent），保存提交指纹 B（exe=other-agent）→ 拒。
        let verified = voucher_test_def("keep", "renamed-agent", &[]);
        app.state::<AppState>()
            .inner()
            .verified_agent_fingerprints
            .record("keep", &verified.runtime_fingerprint());
        let error = voucher_gate_update(
            &app,
            "agent_fields",
            Some("keep"),
            serde_json::json!({ "exe": "other-agent" }),
            &revision,
            path.clone(),
        )
        .await
        .expect_err("指纹变更后旧凭证必须失效");
        assert!(
            matches!(
                error,
                PylonError::Config(crate::agent_config::ConfigError::VerificationRequired(_))
            ),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), yaml);
    }

    #[tokio::test]
    async fn update_agents_config_allows_unchanged_fingerprint_without_voucher() {
        // 只改显示字段 name（不参与 runtime_fingerprint）：无需凭证——
        // 「指纹变更才要求新凭证，未变更沿用」（issue #422 约束）。
        let yaml =
            "agents:\n  keep:\n    name: keep\n    transport: subprocess\n    exe: keep-agent\n";
        let (app, path, revision) = voucher_gate_setup(
            "voucher-unchanged",
            yaml,
            voucher_test_def("keep", "keep-agent", &[]),
        );
        voucher_gate_update(
            &app,
            "agent_fields",
            Some("keep"),
            serde_json::json!({ "name": "Renamed" }),
            &revision,
            path.clone(),
        )
        .await
        .expect("指纹未变更的保存不得强制在线探测");
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(disk.contains("Renamed"), "{disk}");
    }

    #[tokio::test]
    async fn agent_create_scope_does_not_require_voucher() {
        // 「未验证导入」是产品功能（#425 件5）：create 路径不走凭证门禁。
        let yaml =
            "agents:\n  keep:\n    name: keep\n    transport: subprocess\n    exe: keep-agent\n";
        let (app, path, revision) = voucher_gate_setup(
            "voucher-create",
            yaml,
            voucher_test_def("keep", "keep-agent", &[]),
        );
        voucher_gate_update(
            &app,
            "agent_create",
            Some("fresh"),
            serde_json::json!({ "name": "fresh", "transport": "subprocess", "exe": "fresh-agent" }),
            &revision,
            path.clone(),
        )
        .await
        .expect("agent_create 无凭证照常（既有行为）");
        let agents = app.state::<AppState>().inner().agents.lock().unwrap();
        assert!(agents.contains_key("fresh"));
    }

    #[tokio::test]
    async fn test_agent_candidate_alive_signs_voucher_consumed_by_update() {
        // 端到端：真实握手（pylon-fake-agent alive 场景）成功 → 签发凭证 →
        // 同指纹候选的 agent_fields 保存消费凭证放行。
        let fake_bin = crate::test_utils::fake_agent_bin()
            .to_string_lossy()
            .into_owned();
        let yaml = format!(
            "agents:\n  keepalive:\n    name: keepalive\n    transport: subprocess\n    exe: '{fake_bin}'\n"
        );
        let (app, path, revision) = voucher_gate_setup(
            "voucher-e2e",
            &yaml,
            voucher_test_def("keepalive", &fake_bin, &[]),
        );
        // 1) 候选测试：args 变更为 --scenario alive（结构化路径，签发时与
        //    registry base 合成 = 保存候选同构）。
        let tested = voucher_test_def("keepalive", &fake_bin, &["--scenario", "alive"]);
        let payload = connection_test::test_agent_candidate(
            app.state::<AppState>(),
            "keepalive".to_string(),
            tested,
            None,
        )
        .await
        .expect("candidate validation must return a payload");
        assert_eq!(payload["ok"], true, "alive 场景握手必须成功：{payload}");
        // 2) 消费凭证：patch 同 args → 候选指纹与凭证一致 → 放行。
        voucher_gate_update(
            &app,
            "agent_fields",
            Some("keepalive"),
            serde_json::json!({ "args": ["--scenario", "alive"] }),
            &revision,
            path.clone(),
        )
        .await
        .expect("真实握手签发的凭证必须能被同指纹保存消费");
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(disk.contains("--scenario"), "磁盘必须写入新 args：{disk}");
    }

    #[tokio::test]
    async fn reload_agents_cleans_up_ghost_runtimes_of_deleted_agents() {
        let dir = std::env::temp_dir().join(format!("pylon-reload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        std::fs::write(
            &path,
            "agents:\n  keep:\n    name: Keep\n    transport: subprocess\n    exe: keep-agent\n",
        )
        .unwrap();
        // G5-3：with_agent 以 AgentDef.name 为键——agents 键与 name 一致（"keep"/"remove-me"），
        // reload 后 agents 表整体替换为配置文件内容（name=Keep），断言不受影响。
        let doomed = AgentRuntime::new_disconnected();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("keep")
            .with_agent(crate::test_utils::fake_acp_agent_stub("keep"))
            .with_agent(crate::test_utils::fake_acp_agent_stub("remove-me"))
            .with_runtime("keep", AgentRuntime::new_disconnected())
            .with_runtime("remove-me", doomed.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(state);
        reload_agents(
            app.state::<AppState>(),
            Some(path.to_string_lossy().into_owned()),
        )
        .await
        .expect("reload must succeed");
        let state = app.state::<AppState>().inner();
        assert!(
            state.runtimes.get("keep").is_some(),
            "保留 agent 的 runtime 必须还在"
        );
        assert!(
            state.runtimes.get("remove-me").is_none(),
            "删除 agent 的幽灵 runtime 必须被清理"
        );
        assert_eq!(
            doomed.agent_runtime.lock().unwrap().status,
            AgentLifecycleStatus::Disconnected,
            "被清理 runtime 的状态必须置回 Disconnected"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
