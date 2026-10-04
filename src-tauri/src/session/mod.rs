//! 会话域：SessionInfo / AppState helpers / 会话命令 / 过期生命周期。
//! R1 拆分自 lib.rs（行为零变化）。

use pylon_foundations::await_guard::HeldAcrossAwait;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::acp::{self, PromptWaitOutcome};
use crate::agent::runtime::{session_mapping_matches, AgentLifecycleStatus, AgentRuntimeState};
use crate::agent_config::AgentDef;
use crate::error::PylonError;
use crate::gateway::GatewayCore;
use crate::mcp;
use crate::runtime::AgentRuntime;
use crate::time::Timestamp;
use crate::workspace;
use crate::{emit_event, emit_event_all, prompt_lock_for, AppState, AppStateHandles};

// 方案 11：模型层（SessionInfo/DTO/config option 纯函数）搬移至子模块。
mod model;
pub(crate) use model::*;
// 方案 11：inspector/会话清单域搬移至子模块。
mod inspector;
pub(crate) use inspector::*;
// 方案 11：会话创建域搬移至子模块。
mod create;
pub(crate) use create::*;
// #98：session/fork 通用消费者（能力 gate + 受限 raw envelope + parent/child）。
mod fork;
pub(crate) use fork::*;
// 方案 11：prompt 域搬移至子模块。
mod session_state;
pub(crate) use session_state::*;
mod prompt;
pub(crate) use prompt::*;
// 方案 11：会话控制域搬移至子模块。
mod control;
pub(crate) use control::*;
// OWNER-01：AgentSessionOwner contract（OwnerKey/正向 owner 解析原语；§5.8）。
mod owner;
pub(crate) use owner::*;
// 方案 11：会话过期域搬移至子模块。
mod expiry;
pub(crate) use expiry::*;
// 方案 11：会话持久化域搬移至子模块。
mod persist;
pub(crate) use persist::*;
// I06-A-DATA-01/B7：会话仓库域（SQLite 持久化：sessions/deleted_sessions/user_data/
// retention_policy/canonical_events；v9 已删除 messages/send_attempts/message_migrations）。
// I14-W1：service 化——MessageService/DTO/MessageError 经本层 re-export 供 AppState
// 注入与命令层使用；MsgRepo 的 Connection 保持私有（只暴露 service 与 DTO）。
// #247：msg_repo/event_repo/turn_rollup/retention/user_data/persistence_bootstrap
// 存储核下沉 pylon-session crate；模块重导出保活 crate::session:: 既有路径。
pub(crate) use msg_repo::*;
pub use pylon_session::msg_repo;
// I13-A-FE-02：消息历史保留策略契约（模式/档位/默认值/回退语义；不含删除逻辑）。
pub use pylon_session::retention;
// I14-W5：用户数据仓库（versioned Profile/Session/activeProfileId，与消息同库 user_data 表；
// 独立连接 + busy_timeout，service/DTO/错误经本层 re-export 供 AppState 与命令层使用）。
pub use pylon_session::user_data;
pub(crate) use user_data::*;
// M3 EVT-02：canonical 事件仓库（方案书 §5.10——append-only 事件流；与消息同库
// canonical_events 表 v6；独立连接 + busy_timeout；service/DTO/错误经本层 re-export）。
pub(crate) use event_repo::*;
pub use pylon_session::event_repo;
// #81 L2/L3：turn 单元行构建（kernel 终结时追加）与 L3 裁剪校验。
// Kernel persistence readiness barrier：三个同库 service 作为一个启动单元安装，
// setup 返回前全部 ready；禁止半初始化与备用历史权威。
pub(crate) use persistence_bootstrap::*;
pub use pylon_session::persistence_bootstrap;
// M4 DEL-01：现有 schema/tombstone owner 化审计（方案书 §5.12——表/索引/FK/owner 缺口
// 基线固化；只审计不迁移，DEL-02 升版时本基线断言必须同步演进）。
// M4 DEL-02：tombstone 升级 owner/deletion state 迁移与写路径测试（方案书 §5.12——
// v6→v7 兼容迁移 + delete_session 写 owner_key/state/deletion_revision 完整 tombstone）。
// M4 DEL-03：本地优先删除事务测试（方案书 §5.13——OwnerKey 校验、deleting→deleted
// 两阶段状态机、deleting tombstone 同样 gate 迟到写、finalize/重复 begin 幂等）。
#[cfg(test)]
mod del03_local_first_delete;
// M4 DEL-05：wire 错误码矩阵测试（方案书 §5.13/B1.2——MessageError/UserDataError/EventError
// 的 {code,message} 稳定序列化 + 删除后迟到 evt_append wire code=event_session_deleted）。
// #155 T2：存储写入基准（v15 vs v14 形态的 WAL/占用/空闲页数值证据）。
#[cfg(test)]
mod revive_tests;
// #379：GUI 发送/建会话前懒重连——ensure_connected_for_send 触发集/幂等/失败
// 传播 + #363 空闲回收后 GUI 发送恢复的场景回归。
#[cfg(test)]
mod lazy_reconnect_tests;
// #97：模型选择器切换闭环 wire 级集成测试（真实广告 config id、发送前拒绝、
// 钳制收敛、session/load 复活零 selector RPC）。
#[cfg(test)]
mod model_switch_wire_tests;

// #245：原 crate 根的 session_store.rs 与两个兄弟测试模块就近归入。
#[cfg(test)]
mod session_expiry_platform_tests;
#[cfg(test)]
mod session_info_tests;
pub(crate) mod store;

pub(crate) const MAX_SESSIONS: usize = 100;

/// B11.1 注入适用性：命令消息（`/` 开头，与 persona 拼接规则一致）不注入。
pub(crate) fn inject_applies_to(content: &str) -> bool {
    !content.trim_start().starts_with('/')
}

/// M5 感知：从 tool_call rawInput 中脱敏提取文件名（`"path":"..."` 形态）。
/// 安全红线（审查修复）：必须解析为 JSON 后取**顶层键**——纯子串匹配会被
/// 值内嵌的 `"path":<secret>` 骗过，把 secret 以文件名形态带进宠物状态并落盘。
pub(crate) fn extract_tool_file_name(raw: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    for key in ["path", "file", "filename", "file_path"] {
        if let Some(value) = parsed.get(key).and_then(|v| v.as_str()) {
            if !value.is_empty() && value.len() <= 256 {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// B11.1 prompt 拼装：注入 context 前置 + 双换行分隔；context 空白时原样返回。
pub(crate) fn compose_inject_prompt(context: &str, text: &str) -> String {
    let context = context.trim();
    if context.is_empty() {
        text.to_string()
    } else {
        format!("{context}\n\n{text}")
    }
}
// ── AppState helpers ──

impl AppState {
    /// 当前 active agent 的 runtime；无 active agent 时返回 None。
    pub(crate) fn active_runtime(&self) -> Option<Arc<AgentRuntime>> {
        AppStateHandles::from_state(self).active_runtime()
    }

    /// 当前 active agent 的 runtime；缺失时返回错误（命令层统一错误路径）。
    /// A10（2026-08-02）：直接返回 PylonError::NoActiveAgent（code=no_active_agent）——
    /// 此前经 String 折叠成 protocol_error，专用码永远发不出。
    pub(crate) fn require_runtime(&self) -> Result<Arc<AgentRuntime>, PylonError> {
        self.active_runtime().ok_or(PylonError::NoActiveAgent)
    }

    /// 锁外 RPC：同步准备（prepare_rpc）在快照上完成，发送与等待在锁外执行——
    /// Peri 卡顿时不阻塞其他命令（V14「锁外写 prompt」模式推广到全部 RPC）。
    /// #549：快照解析自「短窗换装位」，读锁仅护 Arc clone。
    pub(crate) async fn acp_rpc(
        &self,
        runtime: &AgentRuntime,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, crate::acp::AcpError> {
        let rpc = {
            let acp = runtime.snapshot_acp();
            acp.prepare_rpc(method, params)?
        };
        rpc.complete().await
    }

    /// 方案 5：generation-bound 控制 RPC——发送前断言 generation，
    /// stale（客户端已替换）时**不发送**直接返回错误。防止旧 periId 的
    /// session/close、session/cancel 等控制请求写入新 ACP（发送后复核只能
    /// "检测到"竞态，不能"隔离"竞态）。调用方在发送后仍需 ensure_generation
    /// 复核本地状态修改。正常路径（generation 匹配）行为与 acp_rpc 一致。
    /// #549/ADR-0037：断言对象是快照客户端**自带**的 `client_generation`——
    /// 请求只会入队被解析的这一连接，物理上不可能落到替换后的新 ACP。
    pub(crate) async fn acp_rpc_generation_checked(
        &self,
        runtime: &AgentRuntime,
        method: &str,
        params: serde_json::Value,
        expected_generation: u64,
    ) -> Result<serde_json::Value, crate::acp::AcpError> {
        let rpc = {
            let acp = runtime.snapshot_acp();
            if acp.client_generation() != expected_generation {
                return Err(crate::acp::AcpError::Rpc(format!(
                    "stale ACP client generation: expected {expected_generation}"
                )));
            }
            acp.prepare_rpc(method, params)?
        };
        rpc.complete().await
    }

    /// 按 runtime 实例解析归属 agent 的 AgentDef（per-agent 协议参数消费：
    /// 附件限制 / close_via_rpc / 超时 / mcp mode 等）。
    /// runtime 注册表按 agent id 键控；平台 ingest 的绑定 agent ≠ GUI active agent，
    /// 故不能取 active agent 的配置。未注册（测试直构形态）/agent 已移除时返回
    /// None——调用方按"缺省 = 现状常量值"处理（G2-03/05/06/07 参数化默认值）。
    pub(crate) fn agent_for_runtime(&self, runtime: &Arc<AgentRuntime>) -> Option<AgentDef> {
        let agent_id = self.agent_id_for_runtime(runtime)?;
        self.agents.lock().ok()?.get(&agent_id).cloned()
    }

    /// 按 runtime 实例解析注册表中的稳定 agent id。durable owner 与事件 journal
    /// 使用 registry key，不使用 AgentDef 展示名，也不回退 active agent。
    pub(crate) fn agent_id_for_runtime(&self, runtime: &Arc<AgentRuntime>) -> Option<String> {
        self.runtimes
            .all_with_ids()
            .into_iter()
            .find(|(_, registered)| Arc::ptr_eq(registered, runtime))
            .map(|(id, _)| id)
    }

    /// 按 runtime 解析协议配置（缺省实例 = 全部默认值 = 重构前全局常量行为）。
    pub(crate) fn protocol_for_runtime(
        &self,
        runtime: &Arc<AgentRuntime>,
    ) -> crate::agent_config::AcpProtocolConfig {
        self.agent_for_runtime(runtime)
            .map(|agent| crate::hermes::runtime::effective_protocol(&agent))
            .unwrap_or_default()
    }

    pub(crate) fn current_generation(&self, runtime: &AgentRuntime) -> u64 {
        runtime.client_generation.load(Ordering::Acquire)
    }

    pub(crate) fn ensure_generation(
        &self,
        runtime: &AgentRuntime,
        expected: u64,
    ) -> Result<(), String> {
        let current = self.current_generation(runtime);
        if current == expected {
            Ok(())
        } else {
            Err(format!(
                "stale ACP client generation: expected {expected}, current {current}"
            ))
        }
    }

    pub(crate) fn get_active_agent(&self) -> Result<AgentDef, PylonError> {
        let name = self
            .active_agent
            .lock()
            .map_err(|e| PylonError::Acp(e.to_string()))?;
        self.agents
            .lock()
            .map_err(|e| PylonError::Acp(e.to_string()))?
            .get(&*name)
            .cloned()
            .ok_or(PylonError::NoActiveAgent)
    }

    pub(crate) fn agent_cwd(&self) -> String {
        self.active_agent
            .lock()
            .ok()
            .and_then(|name| self.agents.lock().ok()?.get(&*name).cloned())
            .and_then(|a| a.cwd)
            .unwrap_or_else(|| ".".to_string())
    }

    pub(crate) fn current_mcp_servers(&self) -> Result<Vec<crate::mcp::McpServerConfig>, String> {
        Ok(self
            .runtime_mcp
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_default())
    }

    /// P1（E10）：读 MCP wire 缓存（send_prompt_core None 路径）——命中直接返回
    /// （零重算零校验）；miss（None，如启动恢复路径直写 runtime_mcp 后首次读取）
    /// 回退全量重算（校验 + 序列化，语义 = 现状 validate_and_serialize）并回填
    /// （E3 自愈）。写入侧 = lifecycle::set_mcp_servers（同 mcp_write_lock）。
    pub(crate) fn wire_mcp_servers(&self) -> Result<Vec<serde_json::Value>, String> {
        if let Some(cached) = self.mcp_wire.lock().map_err(|e| e.to_string())?.clone() {
            return Ok(cached);
        }
        let servers = self.current_mcp_servers().unwrap_or_default();
        let values = crate::mcp::serialize_for_session(&servers)?;
        if let Ok(mut slot) = self.mcp_wire.lock() {
            *slot = Some(values.clone());
        }
        Ok(values)
    }

    pub(crate) fn log_runtime_summary(
        &self,
        level: &str,
        source: &str,
        session: Option<String>,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        // P2-6：委托 handles 版本（唯一实现，避免双份逐字重复）。
        AppStateHandles::from_state(self)
            .log_runtime_summary(level, source, session, message, fields);
    }

    pub(crate) fn agent_status_payload(&self) -> serde_json::Value {
        let handles = AppStateHandles::from_state(self);
        handles.agent_status_payload(handles.active_runtime().as_deref())
    }

    pub(crate) fn get_peri_id(
        &self,
        runtime: &AgentRuntime,
        source: &str,
    ) -> Result<String, PylonError> {
        let sessions = runtime
            .sessions
            .lock()
            // A10（2026-08-02）：Mutex 中毒改 Protocol——Acp 变体只留给 ACP 客户端层。
            .map_err(|e| PylonError::Protocol(e.to_string()))?;
        sessions
            .get(source)
            .map(|s| s.peri_id.clone())
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()))
    }

    /// OWNER-01（§5.8）：正向 owner 解析——显式 agentId 路由到 owner runtime。
    /// OWNER-02 起命令层统一走本方法/`resolve_agent_runtime`：`agent_runtime_unavailable`/
    /// `SessionNotFound` 结构化错误，绝不 fallback active runtime。
    /// （ACP-05 的 source→owner 反向扫描 `find_runtime_for_source` 已在 OWNER-02 移除：
    /// 双 Agent 同名 source 时无法确定归属，显式 agentId 正向路由取代。）
    pub(crate) fn resolve_owner_runtime(
        &self,
        owner: &SessionOwner,
    ) -> Result<Arc<AgentRuntime>, PylonError> {
        crate::session::owner::resolve_owner_runtime(&self.runtimes, owner)
    }

    /// OWNER-02（§5.8）：按 agentId 解析 owner runtime（**不要求会话存在**）——
    /// send_message/new_session/load_persisted_session 等创建/恢复路径使用。
    /// 不存在 owner runtime → `agent_runtime_unavailable`，禁止 fallback active runtime。
    pub(crate) fn resolve_agent_runtime(
        &self,
        agent_id: &str,
    ) -> Result<Arc<AgentRuntime>, PylonError> {
        crate::session::owner::resolve_agent_runtime(&self.runtimes, agent_id)
    }

    pub(crate) fn export_session_owner(
        &self,
        runtime: &AgentRuntime,
        peri_id: &str,
    ) -> Result<(String, u64, String), String> {
        let generation = self.current_generation(runtime);
        // 方案 8 步骤 5：snapshot 锁内 clone、锁外组装（SessionStore 纪律）。
        let sessions =
            crate::session::store::snapshot(runtime).map_err(|error| error.to_string())?;
        let matches: Vec<(String, String)> = sessions
            .iter()
            .filter(|(_, session)| session.peri_id == peri_id && session.generation == generation)
            .map(|(source, session)| (source.clone(), session.cwd.clone()))
            .collect();
        match matches.as_slice() {
            [(source, cwd)] => Ok((source.clone(), generation, cwd.clone())),
            [] => Err("export session not found in the active generation".to_string()),
            _ => Err("export session owner is ambiguous".to_string()),
        }
    }

    pub(crate) fn session_matches(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
    ) -> Result<bool, String> {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        Ok(sessions.get(source).map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true))
    }

    pub(crate) fn with_session_if_matches<T>(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
        update: impl FnOnce(&mut SessionInfo) -> T,
    ) -> Result<T, String> {
        self.ensure_generation(runtime, generation)?;
        // 方案 8：委托 SessionStore（(peri_id, generation) 匹配 + 锁序纪律）。
        crate::session::store::update_if_current(runtime, source, peri_id, generation, update)
            .map_err(|e| e.to_string())
    }

    pub(crate) fn mark_first_prompt_if_matches(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        self.with_session_if_matches(runtime, source, peri_id, generation, |session| {
            session.has_first_prompt = true;
        })
    }

    pub(crate) fn remove_session_if_matches(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
    ) -> Result<bool, String> {
        // 方案 8：委托 SessionStore（匹配删除 + 锁外 prompt 锁收敛）。
        crate::session::store::remove_if_current(runtime, source, peri_id, generation)
            .map_err(|e| e.to_string())
    }

    pub(crate) fn start_runtime_log_dispatcher(&self, window: tauri::Window) {
        let mut events = self.runtime_logs.subscribe();
        let hub = Arc::clone(&self.runtime_logs);
        tokio::spawn(async move {
            // #362：lag 告警的前缘节流。这条 warn 会经 RuntimeLogLayer 回到**同一个**
            // hub，再由 hub 广播出去——消费者持续慢于生产者时，不节流就等于每 lag 一次
            // 就往刚排空一点的 channel 里再塞一条，channel 永不排空（RuntimeSheet 打开
            // 且窗口繁忙时触发）。前缘立即放行保证第一次一定看得见，窗口内的命中折叠成
            // 计数搭下一条的车，不静默丢弃。
            let mut lag_throttle = crate::logging::throttle::LeadingEdgeThrottle::new(
                crate::logging::throttle::LAG_LOG_WINDOW,
            );
            loop {
                match events.recv().await {
                    Ok(entry) => {
                        // B2：闸门关闭（RuntimeSheet 未挂载）时跳过 serialize + emit，
                        // 消除无消费者时的每条日志广播开销；ringbuffer 记录不受影响。
                        if !hub.live_enabled() {
                            continue;
                        }
                        match serde_json::to_value(entry) {
                            Ok(payload) => {
                                emit_event(&window, crate::event_names::RUNTIME_LOG, payload)
                            }
                            Err(error) => {
                                tracing::warn!("serialize runtime log event failed: {error}")
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        if let Some(summary) = lag_throttle.record(count) {
                            tracing::warn!(
                                "runtime log event dispatcher lagged: skipped {} entries across {} occurrence(s) in the last {}s",
                                summary.dropped,
                                summary.occurrences,
                                crate::logging::throttle::LAG_LOG_WINDOW.as_secs()
                            );
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    pub(crate) async fn connect_and_replace(
        &self,
        runtime: &Arc<AgentRuntime>,
        window: &tauri::Window,
        agent: &AgentDef,
        agent_id: Option<String>,
        start_status: AgentLifecycleStatus,
        log_action: &str,
    ) -> Result<(), String> {
        // 手动 switch/reconnect：跨 agent/全新进程语义，旧 remote binding 失效。
        let handles = AppStateHandles::from_state(self);
        crate::lifecycle::do_connect_and_replace(
            &handles,
            runtime,
            window,
            agent,
            agent_id,
            start_status,
            log_action,
            crate::agent::runtime::SessionContinuity::Invalidated,
            true,
        )
        .await
    }

    /// 平台 ingest 目标 runtime 就绪检查（B10.3）：未连接时懒启动连接。
    /// announce=false——平台消息路由不切换/不广播 GUI active agent 状态。
    // agent_lifecycle 跨 await：双检查模式，拿锁后重查状态防并发连接
    pub(crate) async fn ensure_runtime_ready(
        &self,
        runtime: &Arc<AgentRuntime>,
        agent_id: &str,
        window: &tauri::Window,
    ) -> Result<(), String> {
        let status = runtime
            .agent_runtime
            .lock()
            .map(|s| s.status)
            .unwrap_or(AgentLifecycleStatus::Disconnected);
        if matches!(
            status,
            AgentLifecycleStatus::Connected
                | AgentLifecycleStatus::Connecting
                | AgentLifecycleStatus::Reconnecting
        ) {
            return Ok(());
        }
        let agent = self
            .agents
            .lock()
            .map_err(|e| e.to_string())?
            .get(agent_id)
            .cloned()
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        let continuity = if matches!(status, AgentLifecycleStatus::Crashed) {
            crate::agent::runtime::SessionContinuity::Unknown
        } else {
            crate::agent::runtime::SessionContinuity::Invalidated
        };
        let _lifecycle_guard = HeldAcrossAwait::new(runtime.agent_lifecycle.lock().await);
        // 双检查：拿到生命周期锁后重查（防并发连接）
        let status = runtime
            .agent_runtime
            .lock()
            .map(|s| s.status)
            .unwrap_or(AgentLifecycleStatus::Disconnected);
        if matches!(
            status,
            AgentLifecycleStatus::Connected
                | AgentLifecycleStatus::Connecting
                | AgentLifecycleStatus::Reconnecting
        ) {
            return Ok(());
        }
        let handles = AppStateHandles::from_state(self);
        crate::lifecycle::do_connect_and_replace(
            &handles,
            runtime,
            window,
            &agent,
            None,
            AgentLifecycleStatus::Connecting,
            "platform-ingest",
            continuity,
            false,
        )
        .await
    }

    /// #379：GUI 发送/建会话前懒重连——runtime 处于 `Disconnected` 时先重建连接。
    /// 与平台侧 [`Self::ensure_runtime_ready`] 同形（首查 → agent_lifecycle 串行 →
    /// 锁后复查 → do_connect_and_replace），三处差异（issue #379 拍板）：
    /// 1. 只认 `Disconnected`——`Crashed` 不抢 `crash_reconnect` 的退避重连
    ///    （发送路径既有 `is_crashed → AgentCrashed` 早退语义不变）；
    /// 2. `announce=true`——重建期间三灯显示 connecting，失败回落 Disconnected +
    ///    `lastError` 如实播报并上抛（前端既有拒绝面：回滚乐观行 + 错误提示）；
    /// 3. `log_action="send"`——runtime 日志溯源区分于 platform-ingest。
    ///
    /// 会话映射：continuity=Invalidated（主动停止/回收后 agent 子进程已死，远端
    /// 会话必亡，不做 probe）——重连后 ensure_session_mapping 按 `known_peri_id`
    /// 走 session/load 复活，失败回退 session/new（既有语义，无额外前置）。
    /// agent_id=None：不接管 active_agent（owner 路由的非 active runtime 不抢位）。
    /// 调用点必须在 prompt 锁 / prompt_gate / session_creation 获取之前
    /// （无锁序反转；LifecycleOp 状态机表见 lifecycle/mod.rs 模块文档）。
    // agent_lifecycle 跨 await：双检查模式，拿锁后重查状态防并发连接（同 ensure_runtime_ready）
    pub(crate) async fn ensure_connected_for_send<R: tauri::Runtime>(
        &self,
        runtime: &Arc<AgentRuntime>,
        agent_id: &str,
        window: &tauri::Window<R>,
    ) -> Result<(), String> {
        let status = runtime
            .agent_runtime
            .lock()
            .map(|s| s.status)
            .unwrap_or(AgentLifecycleStatus::Disconnected);
        // 只认 Disconnected：Connected/Connecting/Reconnecting = 可用或在途；
        // Crashed = 交给 crash_reconnect 自动重连 + 既有 AgentCrashed 早退。
        if !matches!(status, AgentLifecycleStatus::Disconnected) {
            return Ok(());
        }
        let agent = self
            .agents
            .lock()
            .map_err(|e| e.to_string())?
            .get(agent_id)
            .cloned()
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        let _lifecycle_guard = HeldAcrossAwait::new(runtime.agent_lifecycle.lock().await);
        // 双检查：拿到生命周期锁后重查（并发连接/自动重连已推进状态则让路）
        let status = runtime
            .agent_runtime
            .lock()
            .map(|s| s.status)
            .unwrap_or(AgentLifecycleStatus::Disconnected);
        if !matches!(status, AgentLifecycleStatus::Disconnected) {
            return Ok(());
        }
        let handles = AppStateHandles::from_state(self);
        crate::lifecycle::do_connect_and_replace(
            &handles,
            runtime,
            window,
            &agent,
            None,
            AgentLifecycleStatus::Connecting,
            "send",
            crate::agent::runtime::SessionContinuity::Invalidated,
            true,
        )
        .await
    }
}

// ============================================================================
// MessageService 辅助：session_state / tombstone / retention 复用同一 SQLite 仓库。
// v9 起 messages 表与 msg_* 命令已删除，canonical 事件流由 evt_* 命令承担；
// 这里保留 MessageService 只读/删除/保留能力供 user_session_delete_finalize 与
// retention_* 使用。
// ============================================================================

/// 从 AppState 槽位取 MessageService；未就绪（启动失败/未填充）→ `message_db_unavailable`。
/// &AppState 变体（测试/核心函数共用）：从槽位取 MessageService。
pub(crate) fn message_service_of(state: &AppState) -> Result<Arc<MessageService>, MessageError> {
    state
        .message_service
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| MessageError::Unavailable("message db unavailable".into()))
}

fn require_message_service(
    state: &tauri::State<'_, AppState>,
) -> Result<Arc<MessageService>, MessageError> {
    message_service_of(state.inner())
}

// ============================================================================
// I14-W5：用户数据 typed IPC（W5 前端 UserDataRepository tauri adapter 经 invoke 调用）。
// user_data_load / user_data_save——versioned Profile/Session/activeProfileId 后端存储。
// 命令返回 `Result<T, UserDataError>`（B1.2 结构化错误：user_data_revision_conflict /
// user_data_unavailable / user_data_corrupt），前端按 code 分支。所有 SQLite 操作经
// UserDataService 的 spawn_blocking 边界。
// ============================================================================

/// &AppState 变体（测试/核心函数共用）：从槽位取 UserDataService。
pub(crate) fn user_data_service_of(
    state: &AppState,
) -> Result<Arc<UserDataService>, UserDataError> {
    state
        .user_data_service
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| UserDataError::Unavailable("user data db unavailable".into()))
}

/// 从 AppState 槽位取 UserDataService；未就绪（启动失败/未填充）→ `user_data_unavailable`。
fn require_user_data_service(
    state: &tauri::State<'_, AppState>,
) -> Result<Arc<UserDataService>, UserDataError> {
    user_data_service_of(state.inner())
}

/// 读取指定 key 的 envelope（无数据返回 None）；payload 损坏 → `user_data_corrupt`。
/// #317 批次二：错误经 PylonError::UserData 委托，wire code 逐字不变。
#[tauri::command]
pub(crate) async fn user_data_load(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<UserDataEnvelope>, PylonError> {
    let key = UserDataKey::parse(&key)
        .ok_or_else(|| UserDataError::Unavailable(format!("unknown user data key: {key}")))?;
    require_user_data_service(&state)?
        .load(key)
        .await
        .map_err(PylonError::from)
}

/// 原子保存（expected_revision 不匹配 → conflict；形状非法/超限 → corrupt）。
/// 返回新 revision（前端后续 expected_revision 基准）。
/// #463 绕锁面：approval-mode 为保留键——通用盲写不写内存、不持 approval_mode_write_lock，
/// 可致磁盘/内存静默分叉（重启回退盲写值）。拒绝（`user_data_reserved_key`）强制走
/// set_approval_mode（锁窗口内内存+落盘同演化）。load 不拦：读不产生分叉，且前端
/// approvalModeRestore 的持久层探询依赖它。service 层不拦：set_approval_mode 自身经
/// service.save 写穿；Rust 侧 service.save 调用方仅本命令与 permission.rs（grep 盘点）。
#[tauri::command]
pub(crate) async fn user_data_save(
    state: tauri::State<'_, AppState>,
    key: String,
    payload: serde_json::Value,
    expected_revision: Option<i64>,
) -> Result<UserDataSaveResult, PylonError> {
    let key = UserDataKey::parse(&key)
        .ok_or_else(|| UserDataError::Unavailable(format!("unknown user data key: {key}")))?;
    if matches!(key, UserDataKey::ApprovalMode) {
        return Err(UserDataError::ReservedKey {
            key: key.as_str().to_string(),
        }
        .into());
    }
    let revision = require_user_data_service(&state)?
        .save(key, payload, expected_revision)
        .await?;
    Ok(UserDataSaveResult { revision })
}

/// I14-W7：原子删除 Profile（跨 profiles/sessions envelope 单事务 fallback/重绑定/
/// activeProfileId）。返回 fallback 与两个 envelope 的新 revision（前端 expected 基准）。
#[tauri::command]
pub(crate) async fn user_profile_delete(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<ProfileDeleteResult, PylonError> {
    require_user_data_service(&state)?
        .delete_profile(profile_id)
        .await
        .map_err(PylonError::from)
}

/// I14-W7 + DEL-02 + DEL-03（§5.13）：删除会话核心（命令与测试共用，CR-09：非 Tauri 命令，
/// 无 #[tauri::command]）——顺序：用户记录删除 → 会话删除 tombstone（记录 owner）。
/// CR-01：幂等补删——首次调用"记录删除成功、会话删除失败"后，重试时 user_data delete_session
/// 命中 NotFound（记录已删）视为"已删除"继续会话删除补删（否则无 tombstone 保护可被迟到写复活）。
/// owner_key（DEL-02）：可选；None 时 tombstone 回退到会话作用域 legacy owner
/// （旧前端不传，DEL-03 起传真实 ownerKey）。
/// DEL-03：删除走 begin_delete_session——tombstone 先写 state='deleting'（本地优先删除
/// 的两阶段入口；远端 close best effort 后由 user_session_delete_finalize 转 'deleted'）。
/// v9：messages 表已删除，本路径不再级联消息行；canonical_events 行保留（append-only）。
pub(crate) async fn delete_session_core(
    state: &AppState,
    session_id: String,
    owner_key: Option<String>,
) -> Result<(), UserDataError> {
    match user_data_service_of(state)?
        .delete_session(session_id.clone())
        .await
    {
        Ok(_) | Err(UserDataError::NotFound(_)) => {}
        Err(error) => return Err(error),
    }
    message_service_of(state)
        .map_err(|error| UserDataError::Unavailable(error.to_string()))?
        .begin_delete_session(session_id, owner_key)
        .await
        .map_err(|error| UserDataError::Unavailable(format!("session delete failed: {error}")))?;
    Ok(())
}

// #247：validate_delete_owner 随存储核下沉 pylon-session::msg_repo，经上方
// `pub(crate) use msg_repo::*` 重导出，宿主调用点零改动。

#[tauri::command]
pub(crate) async fn user_session_delete(
    state: tauri::State<'_, AppState>,
    session_id: String,
    owner_key: Option<String>,
) -> Result<(), PylonError> {
    let owner_key = validate_delete_owner(owner_key)?;
    delete_session_core(state.inner(), session_id, owner_key)
        .await
        .map_err(PylonError::from)
}

/// DEL-03（§5.13）：删除终态化——deleting → deleted。本地删除成功且远端 close best effort
/// 后由前端调用；幂等（不存在/已终态均为 no-op），失败不阻断（tombstone 保持 'deleting'
/// 仍 gate 迟到写）。#317 批次二：错误经 PylonError::MessagePersistence 委托，
/// wire code 逐字不变。
#[tauri::command]
pub(crate) async fn user_session_delete_finalize(
    state: tauri::State<'_, AppState>,
    session_id: String,
    owner_key: Option<String>,
) -> Result<(), PylonError> {
    if let Some(ref key) = owner_key {
        crate::session::msg_repo::validate_owner_key(key)
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
    }
    require_message_service(&state)?
        .finalize_session_delete(session_id, owner_key)
        .await
        .map_err(PylonError::from)
}

// ============================================================================
// EVT-02（§5.10 / OWNER-02 决策）：evt_* 命令——canonical 事件流仓库。
// 本地 SQLite 命令，以 owner_key（JSON 数组序列化，与 toCanonicalOwnerKey 同纪律）
// 键控，经 require_event_service 直查本机持久化层，**不涉及任何 runtime 路由**
// （无 ACP wire、无 owner runtime 维度），故不需要 agentId/profileId 显式参数——
// owner 维内嵌在事件 payload（owner_key 由后端从 owner 字段推导）。所有 SQLite
// 操作经 EventService 的 spawn_blocking 边界；错误按 B1.2 code 分支。
// ============================================================================

/// &AppState 变体（测试/核心函数共用）：从槽位取 EventService。
pub(crate) fn event_service_of(state: &AppState) -> Result<Arc<EventService>, EventError> {
    state
        .event_service
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| EventError::Unavailable("event db unavailable".into()))
}

/// 从 AppState 槽位取 EventService；未就绪（启动失败/未填充）→ `event_db_unavailable`。
fn require_event_service(
    state: &tauri::State<'_, AppState>,
) -> Result<Arc<EventService>, EventError> {
    event_service_of(state.inner())
}

/// owner 当前 revision（MAX(sequence)，空 = 0；cursor seed/gap 补读的 revision 基线）。
#[tauri::command]
pub(crate) async fn evt_revision(
    state: tauri::State<'_, AppState>,
    owner_key: String,
) -> Result<i64, PylonError> {
    require_event_service(&state)?
        .revision(owner_key)
        .await
        .map_err(PylonError::from)
}

/// 游标分页读取（最新页 before_seq=null；limit 缺省 100；升序返回）。
///
/// #376：`cap_typed_payload`（缺省 true）是读出口载荷收口的杀停开关——前端发现页面上
/// 出现 `data-typed-payload-cap="off"` 即传 false，回到「原样下发 typed」。与
/// `data-highlight-lifecycle="off"` / `data-row-virtualization="off"` 同惯例，
/// 不需要回滚版本。
#[tauri::command]
pub(crate) async fn evt_list(
    state: tauri::State<'_, AppState>,
    owner_key: String,
    before_sequence: Option<i64>,
    limit: Option<u32>,
    cap_typed_payload: Option<bool>,
) -> Result<EventPage, PylonError> {
    require_event_service(&state)?
        .list_events(
            owner_key,
            before_sequence,
            limit.unwrap_or(100),
            cap_typed_payload.unwrap_or(true),
        )
        .await
        .map_err(PylonError::from)
}

/// #155 T3：独立读取已落盘的在途片段，供会话重启后标记为中断内容。
/// 片段不属于 canonical 历史，也不推进 revision。
#[tauri::command]
pub(crate) async fn evt_draft_list(
    state: tauri::State<'_, AppState>,
    owner_key: String,
) -> Result<Vec<DraftFragment>, PylonError> {
    require_event_service(&state)?
        .list_draft_fragments(owner_key)
        .await
        .map_err(PylonError::from)
}

#[tauri::command]
pub(crate) async fn evt_draft_keep(
    state: tauri::State<'_, AppState>,
    owner_key: String,
    draft_id: String,
) -> Result<EventAppendResult, PylonError> {
    require_event_service(&state)?
        .keep_interrupted_draft(owner_key, draft_id)
        .await
        .map_err(PylonError::from)
}

#[tauri::command]
pub(crate) async fn evt_draft_discard(
    state: tauri::State<'_, AppState>,
    owner_key: String,
    draft_id: String,
) -> Result<bool, PylonError> {
    require_event_service(&state)?
        .discard_interrupted_draft(owner_key, draft_id)
        .await
        .map_err(PylonError::from)
}

/// Corrupt-row forensic export: returns the exact stored JSON text without decoding it.
#[tauri::command]
pub(crate) async fn evt_export_raw(
    state: tauri::State<'_, AppState>,
    event_id: String,
) -> Result<Option<CanonicalEventRawExport>, PylonError> {
    require_event_service(&state)?
        .export_raw_event(event_id)
        .await
        .map_err(PylonError::from)
}

/// B6 / #445：跨 owner 内容搜索命中行（raw/typed payload + eventType LIKE，大小写
/// 不敏感）。返回命中行定位（owner 三元组 + sequence/eventType/occurredAt/matchOffset，
/// limit 缺省 50）——前端对命中行定向 `evt_load_compact` 拉行后投影复核，不再按候选
/// owner 全量拉事件流。
#[tauri::command]
pub(crate) async fn evt_search(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<EventSearchHit>, PylonError> {
    require_event_service(&state)?
        .search_hits(query, limit.unwrap_or(50))
        .await
        .map_err(PylonError::from)
}

/// #81 L2：compact 读——「turn.unit 单元 + 未覆盖行」升序（文档投影/搜索的读取
/// 入口；被单元覆盖的行不再传输/解析，读放大随单元粒度下降）。
///
/// #376-b：一次一页（前向游标 `after_sequence`；`next_after_sequence` 为 None 即到底）。
/// 冷装载据此逐页续折，装载期不再「整库行 + 整库信封 + 文档」三份并存；页边界落在
/// delta run 边界上，分页折叠与一次性折叠的切点因此逐位相同。
/// `cap_typed_payload` 语义同 `evt_list`（缺省 true）。
#[tauri::command]
pub(crate) async fn evt_load_compact(
    state: tauri::State<'_, AppState>,
    owner_key: String,
    after_sequence: Option<i64>,
    limit: Option<u32>,
    cap_typed_payload: Option<bool>,
) -> Result<CompactEventPage, PylonError> {
    require_event_service(&state)?
        .load_events_compact_page(
            owner_key,
            after_sequence,
            limit.unwrap_or(1000),
            cap_typed_payload.unwrap_or(true),
        )
        .await
        .map_err(PylonError::from)
}

/// #81 L3：裁剪迁移（应用关闭时调用）。budget_ms 控制单次预算（逐 turn 单事务，
/// 可暂停/续跑）；`trim_rolledup` 保留策略关闭时只报告不删行。全部完成后 VACUUM。
#[tauri::command]
pub(crate) async fn evt_rollup_trim(
    state: tauri::State<'_, AppState>,
    budget_ms: Option<u64>,
) -> Result<RollupTrimReport, PylonError> {
    let service = require_event_service(&state)?;
    let policy = require_retention_service(&state)
        .map_err(|error| EventError::Unavailable(error.to_string()))?
        .get_policy()
        .await
        .map_err(|error| EventError::Unavailable(error.to_string()))?;
    let policy_json = policy.map(|row| row.payload);
    if !crate::session::retention::trim_rolledup_enabled(policy_json.as_deref()) {
        let report = RollupTrimReport {
            policy_blocked: true,
            remaining_units: service.count_remaining_rollup_units().await?,
            ..Default::default()
        };
        return Ok(report);
    }
    service
        .rollup_trim(budget_ms)
        .await
        .map_err(PylonError::from)
}

// ============================================================================
// I14-W9：保留策略执行接口（为 ISSUE-13 提供 policy/preview/prune service）。
// 存储/执行经 MsgRepo（retention_policy 表 + 同一筛选的 preview/prune）。
// ============================================================================

/// 从 AppState 消息仓库槽位构造 RetentionService；未就绪 → `retention_unavailable`。
fn require_retention_service(
    state: &AppState,
) -> Result<retention::RetentionService, retention::RetentionError> {
    let repo = message_service_of(state)
        .map_err(|error| retention::RetentionError::Unavailable(error.to_string()))?
        .repo();
    Ok(retention::RetentionService::new(repo))
}

/// 读取保留策略行；无 → None（前端按默认永久保存处理，D-15）。
/// #317 批次二：错误经 PylonError::Retention 委托，wire code 逐字不变。
#[tauri::command]
pub(crate) async fn retention_policy_get(
    state: tauri::State<'_, AppState>,
) -> Result<Option<msg_repo::RetentionPolicyRow>, PylonError> {
    require_retention_service(state.inner())?
        .get_policy()
        .await
        .map_err(PylonError::from)
}

/// 写入保留策略（先校验档位契约，非法拒绝；合法 → revision+1 原子落盘）。
/// I13-W3：expected_revision 可选——与后端当前 revision 原子比对，不匹配 →
/// retention_revision_conflict（旧写不覆盖新写）；缺省盲写（首写）。
#[tauri::command]
pub(crate) async fn retention_policy_set(
    state: tauri::State<'_, AppState>,
    json: String,
    expected_revision: Option<i64>,
) -> Result<i64, PylonError> {
    require_retention_service(state.inner())?
        .set_policy(json, expected_revision)
        .await
        .map_err(PylonError::from)
}

/// preview：统计将删除的候选（不执行删除；与 prune 同一筛选）。
#[tauri::command]
pub(crate) async fn retention_preview(
    state: tauri::State<'_, AppState>,
    policy: retention::RetentionPolicy,
) -> Result<msg_repo::RetentionPreview, PylonError> {
    require_retention_service(state.inner())?
        .preview(policy)
        .await
        .map_err(PylonError::from)
}

/// prune：事务内统计候选 + 执行删除（与 preview 同一筛选）；返回实际删除计数。
/// I13-W4：expected_policy_revision 可选——与策略行当前 revision 比对，不匹配 →
/// retention_stale_preview（预览后策略被改，拒绝按旧统计执行清理）。
#[tauri::command]
pub(crate) async fn retention_prune(
    state: tauri::State<'_, AppState>,
    policy: retention::RetentionPolicy,
    expected_policy_revision: Option<i64>,
) -> Result<msg_repo::RetentionPreview, PylonError> {
    require_retention_service(state.inner())?
        .prune(policy, expected_policy_revision)
        .await
        .map_err(PylonError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::{AcpClient, AcpError};
    use tauri::Manager;

    #[tokio::test]
    async fn delete_session_core_idempotent_retry_after_partial_failure_cr01() {
        // CR-01：记录删除成功、会话删除失败后的重试——user_data NotFound 视为已删，
        // 继续会话删除补删并返回 Ok（幂等补删，不产生 user_data_not_found 提前返回）
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let user = Arc::new(crate::session::UserDataService::in_memory().expect("user service"));
        let msg = Arc::new(crate::session::MessageService::in_memory().expect("msg service"));
        *state.user_data_service.lock().unwrap() = Some(user.clone());
        *state.message_service.lock().unwrap() = Some(msg.clone());
        // 用户记录（sessions envelope 含 s1）
        let envelope = serde_json::json!({
            "version": 2,
            "sessions": [{ "id": "s1", "agentId": "peri", "name": "S", "source": "qq:g:1", "profileId": "p" }]
        });
        user.save(
            crate::session::user_data::UserDataKey::Sessions,
            envelope,
            None,
        )
        .await
        .expect("save sessions");
        // 第一次删除：用户记录 + 会话 tombstone（deleting 两阶段入口）
        delete_session_core(&state, "s1".into(), None)
            .await
            .expect("first delete");
        assert_eq!(
            msg.repo()
                .tombstone_state("s1")
                .expect("read state")
                .as_deref(),
            Some("deleting"),
            "delete_session_core 走 begin_delete_session"
        );
        // 第二次（重试）：记录已删 → 幂等补删 → Ok（而非 user_data_not_found）
        delete_session_core(&state, "s1".into(), None)
            .await
            .expect("idempotent retry must continue");
        // tombstone 保留首次（不报未知错误）
        assert_eq!(
            msg.repo()
                .tombstone_state("s1")
                .expect("read state")
                .as_deref(),
            Some("deleting")
        );
    }

    /// 测试桩适配器（G4 §3-9 适配）：platform_key="qq"——注册后 is_platform_source
    /// 对 qq:* 前缀命中（C3/C4 拒绝语义依赖注册态；E14 放行语义依赖未注册态）。
    struct QqFakeAdapter;

    impl crate::gateway::PlatformAdapter for QqFakeAdapter {
        fn platform_key(&self) -> &str {
            "qq"
        }
        fn max_message_len(&self) -> usize {
            4000
        }
        fn deliver_text(&self, _source: &str, _text: &str) -> Result<(), String> {
            Ok(())
        }
        fn deliver_event(
            &self,
            _source: &str,
            _event: &str,
            _payload: &serde_json::Value,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    /// A10：无 active agent 的裸状态（active_agent 指向不存在的 runtime）。
    /// E-9（G5-3 遗留）：字面量收敛为 TestStateBuilder::bare()——默认值逐字段 =
    /// run() 现值（active_agent="ghost-agent" 等，E18 纪律见 test_utils.rs doc）。
    fn state_without_active_runtime() -> AppState {
        crate::test_utils::TestStateBuilder::bare().build()
    }

    #[test]
    fn require_runtime_without_active_agent_returns_no_active_agent() {
        // A10：require_runtime 无 active agent 时返回专用错误码（不折叠成 protocol_error）。
        let state = state_without_active_runtime();
        match state.require_runtime() {
            Ok(_) => panic!("require_runtime must fail without an active runtime"),
            Err(error) => {
                assert_eq!(error.code(), "no_active_agent");
                assert_eq!(error.to_string(), "no active agent configured");
            }
        }
    }

    /// B1：GUI source 冒名平台源（qq:* 无 binding）必须在 send_prompt_core 入口被拒绝，
    /// 不得建立会话（与 deliver_all 出站白名单构成双防线）。
    /// G4 §3-9（C4）适配：判定改走 is_platform_source（注册适配器前缀 OR 绑定命中）——
    /// 测试注册 FakeAdapter("qq") 保持拒绝语义；E14 安全等价（无适配器注册时放行）
    /// 由本测试第三段单独钉住。
    #[tokio::test]
    async fn send_prompt_core_rejects_unbound_qq_gui_source() {
        let state = state_without_active_runtime();
        let runtime = AgentRuntime::new_disconnected();
        // gateway 只绑定 qq:group:123；qq:group:999 无 binding（GUI 冒名）。
        // C4 后需"注册适配器 OR 绑定"命中才判定平台源——注册 FakeAdapter("qq")。
        let gateway = GatewayCore::from_config(
            crate::gateway::route::parse_config(
                r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
            )
            .expect("合法配置"),
        );
        gateway
            .register(Arc::new(QqFakeAdapter))
            .expect("register fake qq adapter");
        let error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &gateway,
            &PromptContext {
                source: "qq:group:999".to_string(),
                content: "你好".to_string(),
                known_peri_id: None,
                ..Default::default()
            },
        )
        .await
        .expect_err("无 binding 的 qq:* source 必须被拒绝");
        assert_eq!(error.code(), "protocol_error");
        assert!(
            error
                .to_string()
                .contains("invalid GUI source: qq:group:999"),
            "错误信息必须指明非法 GUI source，实际: {error}"
        );
        // 正对照：绑定命中的 qq:* source 放行（后续失败来自未连接 ACP，而非 source 校验）
        let bound_error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &gateway,
            &PromptContext {
                source: "qq:group:123".to_string(),
                content: "你好".to_string(),
                known_peri_id: None,
                ..Default::default()
            },
        )
        .await
        .expect_err("绑定命中应放行 source 校验，继续管线直到连接层失败");
        assert!(
            !bound_error.to_string().contains("invalid GUI source"),
            "绑定命中的 qq:* source 不得被 source 校验拒绝，实际: {bound_error}"
        );
        // E14 语义钉住：无适配器注册 + 无 binding 的 qq:* GUI source 放行入口校验
        // （安全等价：无注册适配器 = 无 deliver_all 投递路径，gateway/mod.rs doc）。
        let bare_gateway = GatewayCore::from_config(
            crate::gateway::route::parse_config(
                r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
            )
            .expect("合法配置"),
        );
        let pass_error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &bare_gateway,
            &PromptContext {
                source: "qq:group:999".to_string(),
                content: "你好".to_string(),
                known_peri_id: None,
                ..Default::default()
            },
        )
        .await
        .expect_err("无适配器注册时 qq:* 应放行入口校验，继续管线直到连接层失败");
        assert!(
            !pass_error.to_string().contains("invalid GUI source"),
            "无适配器注册的 qq:* source 不得被入口校验拒绝（E14），实际: {pass_error}"
        );
    }

    /// P1（E10）：缓存未初始化（None，启动恢复路径形态）→ 回退全量重算
    /// （校验 + 序列化）并回填；行为与现状 validate_and_serialize(current_mcp_servers)
    /// 逐字一致（E3 自愈：首次读取即回填）。
    #[test]
    fn mcp_wire_cache_uninitialized_falls_back_and_backfills() {
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let values = state.wire_mcp_servers().expect("miss 回退必须成功");
        assert!(values.is_empty(), "空配置 → 空 wire 数组（现状语义）");
        assert_eq!(
            state.mcp_wire.lock().unwrap().as_ref().map(Vec::len),
            Some(0),
            "miss 后必须回填缓存"
        );
    }

    /// P1（E10）：缓存命中直接返回 wire 形态（零重算零校验）——runtime_mcp 即使
    /// 被置入非法数据（超限 server）也不触发校验，证明读路径短路。
    #[test]
    fn mcp_wire_cache_hit_short_circuits_recompute() {
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let cached = vec![serde_json::json!({"name": "cached-mcp"})];
        *state.mcp_wire.lock().unwrap() = Some(cached.clone());
        // 非法 runtime_mcp：33 个 server（> MAX_SERVERS=32，validate 必失败）
        let mut bad = Vec::new();
        for i in 0..(crate::mcp::MAX_SERVERS + 1) {
            bad.push(crate::mcp::McpServerConfig {
                id: Some(format!("s{i}")),
                name: None,
                transport: "stdio".into(),
                enabled: true,
                command: Some("cmd".into()),
                args: Vec::new(),
                env: HashMap::new(),
                url: None,
                headers: HashMap::new(),
                oauth: None,
                disabled: false,
            });
        }
        *state.runtime_mcp.lock().unwrap() = Some(bad);
        let values = state.wire_mcp_servers().expect("缓存命中不得触发校验");
        assert_eq!(values, cached, "命中必须返回缓存 wire 形态");
    }

    /// E-11：附件限制按 runtime 归属 agent 协议配置解析（非 active agent）——
    /// active agent 上限 1、runtime 归属 agent 上限 8 时，3 个附件必须放行
    /// （若仍按 active agent 解析会报 too many attachments: maximum is 1）。
    #[tokio::test]
    async fn attachment_limits_follow_runtime_agent_not_active_agent() {
        // active agent：max_attachments=1（若按 active agent 解析，3 附件必拒）
        let mut active_def = crate::test_utils::fake_acp_agent(
            "active-a",
            &["--scenario", "alive", "--session-id", "e11-session"],
        );
        active_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            max_attachments: Some(1),
            ..Default::default()
        });
        // runtime 归属 agent：max_attachments=8
        let mut runtime_def = crate::test_utils::fake_acp_agent(
            "runtime-b",
            &["--scenario", "alive", "--session-id", "e11-session"],
        );
        runtime_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            max_attachments: Some(8),
            ..Default::default()
        });
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            crate::acp::AcpClient::connect_with_logs(&runtime_def, None)
                .await
                .expect("fake ACP must initialize"),
        );

        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("active-a")
            .with_agent(active_def)
            .with_agent(runtime_def)
            .with_runtime("runtime-b", runtime.clone())
            .build();
        let gateway = Arc::new(GatewayCore::new());
        // 3 个真实临时附件文件（prompt_blocks 校验 metadata）
        let dir = std::env::temp_dir().join(format!("pylon-e11-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let attachments: Vec<String> = (0..3)
            .map(|i| {
                let path = dir.join(format!("att-{i}.txt"));
                std::fs::write(&path, b"x").unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();
        let ctx = PromptContext {
            source: "gui-e11".to_string(),
            profile_id: None,
            content: "你好".to_string(),
            persona: String::new(),
            session_prompt: None,
            attachments: Some(attachments),
            mcp_servers: None,
            cwd: None,
            known_peri_id: None,
        };
        let result =
            send_prompt_core::<tauri::test::MockRuntime>(&state, &runtime, None, &gateway, &ctx)
                .await;
        std::fs::remove_dir_all(&dir).ok();
        result
            .expect("3 附件必须按 runtime 归属 agent 的 8 上限放行（active agent 上限 1 被忽略）");
    }

    /// 方案 6：close_session_rpc 统一入口矩阵——close_via_rpc=false 不发 RPC、
    /// method-not-found 降级不报错、普通 RPC 错误按 strict 决定上抛/吞掉。
    #[tokio::test]
    async fn close_session_rpc_respects_policy_and_method_not_found() {
        let agent =
            crate::test_utils::fake_acp_agent("p6-agent", &["--scenario", "close-unsupported"]);
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            crate::acp::AcpClient::connect_with_logs(&agent, None)
                .await
                .expect("fake ACP must initialize"),
        );

        // close_via_rpc=false：跳过 RPC，返回 Ok(false)
        let mut no_rpc_def = agent.clone();
        no_rpc_def.name = "p6-no-rpc".to_string();
        no_rpc_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            session_close: Some(false),
            ..Default::default()
        });
        let no_rpc_runtime = AgentRuntime::new_disconnected();
        no_rpc_runtime.install_acp(
            crate::acp::AcpClient::connect_with_logs(&no_rpc_def, None)
                .await
                .expect("fake ACP must initialize"),
        );

        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("p6-agent")
            .with_agent(agent)
            .with_agent(no_rpc_def)
            .with_runtime("p6-agent", runtime.clone())
            .with_runtime("p6-no-rpc", no_rpc_runtime.clone())
            .build();
        // method-not-found：降级 Ok(true)，不报错（RemoteFirst 与 best-effort 同）。
        let attempted = close_session_rpc(&state, &runtime, "peri-1", 0, true)
            .await
            .expect("-32601 必须降级而非报错");
        assert!(attempted, "close_via_rpc=true 必须尝试 RPC");
        // close_via_rpc=false：跳过 RPC 仅本地清理。
        let attempted = close_session_rpc(&state, &no_rpc_runtime, "peri-1", 0, true)
            .await
            .expect("close_via_rpc=false 必须 Ok");
        assert!(!attempted, "close_via_rpc=false 不得尝试 RPC");
    }

    /// 方案 5：acp_rpc_generation_checked 在 generation 不匹配（客户端已替换）
    /// 时锁内拦截，不发送——旧 periId 的控制请求不进入新 ACP。
    #[tokio::test]
    async fn generation_checked_rpc_blocks_stale_control_request() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-p5-{}.jsonl", std::process::id()));
        let agent = crate::test_utils::fake_acp_agent(
            "p5-agent",
            &[
                "--scenario",
                "trace-all",
                "--trace-file",
                &trace_path.to_string_lossy(),
                "--trace-mode",
                "all",
            ],
        );
        let runtime = AgentRuntime::new_disconnected();
        // #549/ADR-0037 契约：generation 权威在客户端本体——连接即挂 gen-1 客户端，
        // expected_generation=0 的旧控制请求必须被拦截（不再借宿主原子量模拟替换）。
        runtime.install_acp(
            crate::acp::AcpClient::connect_with_generation(&agent, None, 1)
                .await
                .expect("fake ACP must initialize"),
        );

        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("p5-agent")
            .with_agent(agent)
            .with_runtime("p5-agent", runtime.clone())
            .build();
        let result = state
            .acp_rpc_generation_checked(
                &runtime,
                acp::METHOD_SESSION_CLOSE,
                acp::session_close_params("old-peri").expect("params"),
                0,
            )
            .await;
        assert!(result.is_err(), "generation 不匹配时必须拒绝（不发送）");
        // 短暂等待 writer 排空，确认 trace 无 session/close。
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        assert!(
            !trace.contains("session/close"),
            "stale 控制请求不得发送到 ACP: {trace}"
        );
    }

    /// 方案 4：set_config_option 的 RPC 路由必须按 target runtime 归属 agent 的
    /// protocol（protocol_for_runtime）决定，而非 get_active_agent() 的协议——
    /// 修复前按 active agent 读取，在 agents 表与 runtimes 注册不同步/多 runtime
    /// 场景会错发 RPC。此处验证：runtime 归属 agent 声明 ConfigOption 时走
    /// session/set_config_option，绝不走 session/set_model。
    #[tokio::test]
    async fn set_config_option_uses_runtime_agent_protocol_not_active_agent() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-p4-{}.jsonl", std::process::id()));
        // active agent A：set_model_api = SetModel（若误用其协议 → 走 session/set_model）
        let mut active_def = crate::test_utils::fake_acp_agent(
            "active-a",
            &[
                "--scenario",
                "set-config-option",
                "--mode",
                "legacy",
                "--session-id",
                "p4-session",
            ],
        );
        active_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            set_model_api: Some(crate::agent_config::SetModelApi::SetModel),
            ..Default::default()
        });
        // runtime 归属 agent B：set_model_api = ConfigOption（正确应走 set_config_option）
        let mut runtime_def = crate::test_utils::fake_acp_agent(
            "runtime-b",
            &[
                "--scenario",
                "set-config-option",
                "--mode",
                "legacy",
                "--session-id",
                "p4-session",
                "--trace-file",
                &trace_path.to_string_lossy(),
                "--trace-mode",
                "all",
            ],
        );
        runtime_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            set_model_api: Some(crate::agent_config::SetModelApi::ConfigOption),
            ..Default::default()
        });
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            crate::acp::AcpClient::connect_with_logs(&runtime_def, None)
                .await
                .expect("fake ACP must initialize"),
        );

        let state = crate::test_utils::TestStateBuilder::bare()
            // #97 评审修正：active agent 必须与 runtime 归属 agent **不同**——
            // 旧写法 with_active_agent("runtime-b") 使 active==runtime，即使实现
            // 回归成读 active agent 的协议，wire 结果也相同（测试无判别力）。
            // active-a 声明 SetModel：误读 active 协议 → wire 会出现 set_model。
            .with_active_agent("active-a")
            .with_agent(active_def)
            .with_agent(runtime_def)
            .with_runtime("runtime-b", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let state = app.state::<AppState>();
        // 预置会话映射（set_config_option 经 get_peri_id 查表；绕过 session/new
        // command 的完整注册流程，聚焦本测试的协议路由断言）。
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "p4-session".to_string(),
                SessionInfo::new(
                    "p4-peri".to_string(),
                    String::new(),
                    ".".to_string(),
                    false,
                    0,
                ),
            );
        }
        let result = set_config_option(
            state,
            "runtime-b".to_string(),
            "p4-session".to_string(),
            "model".to_string(),
            serde_json::json!("gpt-4"),
        )
        .await
        .expect("set_config_option 必须成功");
        assert_eq!(
            result["configOptions"][0]["value"], "gpt-4",
            "响应应含 configOptions"
        );
        // 回读 trace：必须出现 session/set_config_option，不得出现 session/set_model
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let methods: Vec<String> = trace
            .lines()
            .map(|line| {
                let value: serde_json::Value = serde_json::from_str(line).unwrap();
                value
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert!(
            methods.iter().any(|m| m == "session/set_config_option"),
            "必须按 runtime 归属 agent 走 set_config_option: {methods:?}"
        );
        assert!(
            !methods.iter().any(|m| m == "session/set_model"),
            "不得按 active agent 走 set_model: {methods:?}"
        );
    }

    /// P28：空态创建所选的 model/mode/reasoning 必须在 session/new 成功后、
    /// 本地映射发布前按真实 ACP wire 顺序应用。这个 fake agent 保留每一条
    /// 请求的完整参数，避免只测 helper 序列化而漏掉 command → runtime → ACP
    /// 的实际接缝。
    #[tokio::test]
    async fn new_session_applies_initial_options_in_wire_order_and_returns_merged_state() {
        let trace_path = std::env::temp_dir().join(format!(
            "pylon-p28-initial-options-{}.jsonl",
            std::process::id()
        ));
        let mut agent = crate::test_utils::fake_acp_agent(
            "p28-agent",
            &[
                "--scenario",
                "initial-options-echo",
                "--trace-file",
                &trace_path.to_string_lossy(),
                "--trace-mode",
                "all",
            ],
        );
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            set_model_api: Some(crate::agent_config::SetModelApi::SetModel),
            ..Default::default()
        });
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            AcpClient::connect_with_logs(&agent, None)
                .await
                .expect("fake ACP must initialize"),
        );

        // #379：已连接夹具如实置 Connected，避免命令入口懒重连在此二次 spawn。
        runtime.agent_runtime.lock().unwrap().status = AgentLifecycleStatus::Connected;
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("p28-agent")
            .with_agent(agent)
            .with_runtime("p28-agent", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let state = app.state::<AppState>();

        let response = new_session(
            state,
            // #379：命令入口新增 window 注入参（懒重连播报面）；直呼测试用 mock 窗。
            tauri::WebviewWindowBuilder::new(
                &app,
                "main",
                tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
            )
            .build()
            .expect("mock window must build")
            .as_ref()
            .window(),
            "p28-agent".to_string(),
            "local:p28".to_string(),
            "profile-p28".to_string(),
            "persona".to_string(),
            Some(".".to_string()),
            None,
            None,
            Some("provider:new".to_string()),
            Some("high".to_string()),
            Some("accept_edits".to_string()),
        )
        .await
        .expect("initial model/mode/reasoning must be applied");

        assert_eq!(response["sessionId"], "p28-session");
        assert_eq!(response["models"]["currentModelId"], "provider:new");
        assert_eq!(response["modes"]["currentModeId"], "accept_edits");
        assert_eq!(
            response["configOptions"]
                .as_array()
                .and_then(|options| options
                    .iter()
                    .find(|option| option["id"] == "reasoning_effort"))
                .and_then(|option| option.get("currentValue")),
            Some(&serde_json::json!("high"))
        );
        let mapped = runtime
            .sessions
            .lock()
            .unwrap()
            .get("local:p28")
            .cloned()
            .expect("local session mapping must publish after all settings");
        assert_eq!(mapped.model, "provider:new");
        assert_eq!(mapped.mode.as_deref(), Some("accept_edits"));

        // The connection handshake is intentionally ignored; the creation
        // transaction itself must be exactly new → model → mode → reasoning.
        let trace = std::fs::read_to_string(&trace_path).expect("read P28 wire trace");
        std::fs::remove_file(&trace_path).ok();
        let requests: Vec<serde_json::Value> = trace
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let methods: Vec<&str> = requests
            .iter()
            .filter_map(|request| request.get("method").and_then(|method| method.as_str()))
            .collect();
        let new_index = methods
            .iter()
            .position(|method| *method == "session/new")
            .expect("session/new must be sent");
        let model_index = methods
            .iter()
            .position(|method| *method == "session/set_model")
            .expect("session/set_model must be sent");
        let mode_index = methods
            .iter()
            .position(|method| *method == "session/set_mode")
            .expect("session/set_mode must be sent");
        let reasoning_index = methods
            .iter()
            .position(|method| *method == "session/set_config_option")
            .expect("reasoning config option must be sent");
        assert!(
            new_index < model_index && model_index < mode_index && mode_index < reasoning_index,
            "initial setting wire order must be new → model → mode → reasoning: {methods:?}"
        );
        let model_request = &requests[model_index];
        assert_eq!(model_request["params"]["sessionId"], "p28-session");
        assert_eq!(model_request["params"]["modelId"], "provider:new");
        let mode_request = &requests[mode_index];
        assert_eq!(mode_request["params"]["sessionId"], "p28-session");
        assert_eq!(mode_request["params"]["modeId"], "accept_edits");
        let reasoning_request = &requests[reasoning_index];
        assert_eq!(reasoning_request["params"]["sessionId"], "p28-session");
        assert_eq!(reasoning_request["params"]["configId"], "reasoning_effort");
        assert_eq!(reasoning_request["params"]["value"], "high");

        runtime.snapshot_acp().kill().expect("fake ACP cleanup");
    }

    /// A3：Round N 迟到 chunk 在 Round N+1 推进（clear）之后才被 dispatcher 追加
    /// → 必须被丢弃，不得污染 Round N+1 的 last_response_text（persist 落库依据）。
    #[test]
    fn stale_round_chunk_is_dropped_after_round_advance() {
        let mut session = SessionInfo::new(
            "peri-1".to_string(),
            "persona".to_string(),
            "cwd".to_string(),
            false,
            1,
        );
        // Round N 推进（send_message 内路径）：回合 +1、标记收集回合、清空文本。
        session.inject_round = session.inject_round.saturating_add(1);
        session.last_response_round = session.inject_round;
        // dispatcher 于 Round N 接收并收集 chunk（received_round = 1）。
        session.collect_response_chunk("回合N文本", 1);
        assert_eq!(session.last_response_text, "回合N文本");
        // Round N+1 推进：回合 +1、标记收集回合、清空文本。
        session.inject_round = session.inject_round.saturating_add(1);
        session.last_response_round = session.inject_round;
        session.last_response_text.clear();
        // Round N 迟到 chunk：接收于 Round N（received_round = 1），Round N+1
        // 推进之后才被 dispatcher 追加 → 丢弃，不污染 Round N+1 文本。
        session.collect_response_chunk("迟到文本", 1);
        assert!(
            !session.last_response_text.contains("迟到文本"),
            "Round N 迟到 chunk 不得混入 Round N+1 的回复文本"
        );
        // Round N+1 自身 chunk 正常收集。
        session.collect_response_chunk("回合N+1文本", 2);
        assert_eq!(session.last_response_text, "回合N+1文本");
    }

    /// O1：会话映射删除时 prompt 锁表条目必须同步收敛（映射删除 = 生命周期结束，
    /// 锁表不得无界增长）；映射不匹配时不删除也不清理。
    #[tokio::test]
    async fn remove_session_if_matches_drops_prompt_lock_entry() {
        let runtime = AgentRuntime::new_disconnected();
        let state = state_without_active_runtime();
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "source-a".to_string(),
                SessionInfo::new("peri-1".into(), String::new(), ".".into(), false, 1),
            );
        }
        prompt_lock_for(&runtime.prompt_locks, "source-a");
        assert_eq!(runtime.prompt_locks.lock().unwrap().len(), 1);
        let removed = state
            .remove_session_if_matches(&runtime, "source-a", "peri-1", 1)
            .unwrap();
        assert!(removed, "匹配映射必须被删除");
        assert!(
            runtime.prompt_locks.lock().unwrap().is_empty(),
            "锁表条目必须随映射删除收敛"
        );
        // 不匹配（peri_id 已更换）：不删除映射，也不清理锁表（新会话仍在使用）。
        prompt_lock_for(&runtime.prompt_locks, "source-b");
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "source-b".to_string(),
                SessionInfo::new("peri-2".into(), String::new(), ".".into(), false, 1),
            );
        }
        let removed = state
            .remove_session_if_matches(&runtime, "source-b", "peri-other", 1)
            .unwrap();
        assert!(!removed, "不匹配映射不得删除");
        assert_eq!(
            runtime.prompt_locks.lock().unwrap().len(),
            1,
            "映射未删除时锁表条目保留（生成中豁免仍依赖该条目）"
        );
    }

    /// G2-02：restore_previous_slot 失败恢复语义——映射匹配时恢复 previous 槽位
    /// （有 previous 则 insert 否则 remove）；映射不匹配（已被新会话接管）不动。
    #[tokio::test]
    async fn restore_previous_slot_restores_or_removes_on_match() {
        let runtime = AgentRuntime::new_disconnected();
        let insert = |runtime: &Arc<AgentRuntime>| {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "source-a".to_string(),
                SessionInfo::new("peri-1".into(), String::new(), ".".into(), false, 1),
            );
        };
        // 映射匹配 + previous → 恢复 previous 槽位（回滚到旧会话）
        insert(&runtime);
        let previous = SessionInfo::new("old-peri".into(), String::new(), "/old".into(), true, 1);
        restore_previous_slot(&runtime, "source-a", "peri-1", 1, Some(previous.clone()))
            .expect("restore must succeed");
        let sessions = runtime.sessions.lock().unwrap();
        assert_eq!(
            sessions.get("source-a").map(|s| s.peri_id.as_str()),
            Some("old-peri"),
            "previous 槽位必须恢复"
        );
        assert_eq!(
            sessions.get("source-a").map(|s| s.cwd.as_str()),
            Some("/old"),
            "previous 会话内容必须完整恢复"
        );
        drop(sessions);
        // 映射匹配 + 无 previous → remove（新建的临时槽位回滚删除）
        restore_previous_slot(&runtime, "source-a", "old-peri", 1, None)
            .expect("remove must succeed");
        assert!(
            runtime.sessions.lock().unwrap().is_empty(),
            "无 previous 时必须 remove 临时槽位"
        );
        // 映射不匹配（peri_id 已被新会话替换）→ 不恢复也不删除
        insert(&runtime);
        restore_previous_slot(&runtime, "source-a", "peri-dead", 1, Some(previous))
            .expect("mismatch must be a no-op");
        let sessions = runtime.sessions.lock().unwrap();
        assert_eq!(sessions.len(), 1, "不匹配时不得改动映射");
        assert_eq!(
            sessions.get("source-a").map(|s| s.peri_id.as_str()),
            Some("peri-1"),
            "不匹配时新映射必须原样保留"
        );
    }

    /// S3：prompt 错误"会话不存在"语义匹配——宽松子串匹配覆盖 agent 实际错误形态
    /// （JSON-RPC 错误对象序列化串 / 纯字符串），网络与临时/方法级错误不命中。
    ///
    /// #354 契约更新（清理陈旧样本）：`code == -32000` 现在**一票**判为
    /// `RpcFailureKind::AuthRequired`（协议已定义该码语义，agent 误用它表别的含义属
    /// 协议违规，不做文本竞猜，见 `pylon-acp/src/error.rs::rpc_failure_details`）。
    /// 因此原先挂在这里的 `{"code":-32000,"message":"session missing"}` 不再、也不应
    /// 命中 SessionMissing —— 它移到下面单独钉住「协议码优先于文本」这条。
    #[test]
    fn prompt_error_indicates_missing_session_matching() {
        let missing = [
            r#"{"code":-32602,"message":"session not found: session-42"}"#,
            r#"{"code":-32602,"message":"Invalid params: unknown session: session-42"}"#,
        ];
        for error in missing {
            assert!(
                prompt_error_indicates_missing_session(&AcpError::Rpc(error.into())),
                "必须命中会话不存在语义: {error}"
            );
        }
        let transient = [
            r#"{"code":-32601,"message":"Method not found"}"#,
            r#"{"code":-32602,"message":"invalid params: missing content"}"#,
            r#"{"code":-32000,"message":"rate limited"}"#,
            // #354：-32000 是协议级 authRequired，文本里写着 session missing 也不改判
            r#"{"code":-32000,"message":"session missing"}"#,
        ];
        for error in transient {
            assert!(
                !prompt_error_indicates_missing_session(&AcpError::Rpc(error.into())),
                "不得误伤网络/临时/方法级错误: {error}"
            );
        }
    }

    /// S3：幽灵映射自动重建——"会话不存在"语义的 prompt 错误清理本地映射（下次
    /// send 自动重建会话）；网络/临时错误与不匹配映射（已被新会话替换）不清理。
    #[tokio::test]
    async fn ghost_session_mapping_is_removed_on_missing_session_error() {
        let runtime = AgentRuntime::new_disconnected();
        let state = state_without_active_runtime();
        let insert = |runtime: &Arc<AgentRuntime>| {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "source-a".to_string(),
                SessionInfo::new("peri-1".into(), String::new(), ".".into(), false, 1),
            );
        };
        // "会话不存在"语义：清理映射（返回 true），且 O1 锁表同步收敛。
        insert(&runtime);
        prompt_lock_for(&runtime.prompt_locks, "source-a");
        let removed = cleanup_ghost_session_mapping(
            &state,
            &runtime,
            "source-a",
            "peri-1",
            1,
            &AcpError::Rpc(r#"{"code":-32602,"message":"session not found: peri-1"}"#.into()),
        );
        assert!(removed, "会话不存在错误必须清理幽灵映射");
        assert!(
            runtime.sessions.lock().unwrap().is_empty(),
            "幽灵映射必须被删除"
        );
        assert!(
            runtime.prompt_locks.lock().unwrap().is_empty(),
            "O1：锁表条目必须随映射删除收敛"
        );
        assert!(matches!(
            runtime.binding_health.lock().unwrap().get("source-a"),
            Some(crate::agent::runtime::SessionBindingHealth::Detached {
                retryable: false,
                ..
            })
        ));
        // 网络/临时错误：不清理映射。
        insert(&runtime);
        let removed = cleanup_ghost_session_mapping(
            &state,
            &runtime,
            "source-a",
            "peri-1",
            1,
            &AcpError::WriteTimeout,
        );
        assert!(!removed, "临时错误不得清理映射");
        assert_eq!(runtime.sessions.lock().unwrap().len(), 1);
        // 映射不匹配（peri_id 已被新会话替换）：错误含会话不存在语义也不得误删新映射。
        let removed = cleanup_ghost_session_mapping(
            &state,
            &runtime,
            "source-a",
            "peri-dead",
            1,
            &AcpError::Rpc(r#"{"code":-32602,"message":"session not found: peri-dead"}"#.into()),
        );
        assert!(!removed, "peri_id 不匹配不得误删新会话映射");
        assert_eq!(runtime.sessions.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn probing_binding_is_rejected_by_the_backend_send_gate() {
        let runtime = AgentRuntime::new_disconnected();
        crate::session::store::insert(
            &runtime,
            "source-a",
            SessionInfo::new("peri-1".into(), String::new(), ".".into(), true, 4),
            true,
            100,
        )
        .unwrap();
        runtime.binding_health.lock().unwrap().insert(
            "source-a".into(),
            crate::agent::runtime::SessionBindingHealth::Probing {
                from_generation: 4,
                target_generation: 5,
            },
        );
        let state = state_without_active_runtime();

        let error = ensure_session_mapping(
            &SessionAssembly {
                state: &state,
                runtime: &runtime,
                source: "source-a",
                profile_id: None,
                persona: "persona",
                session_cwd: ".",
                wire_mcp_servers: &[],
            },
            None,
            &mut None,
        )
        .await
        .err()
        .expect("probing binding must not be reused by any backend caller");

        assert_eq!(error.code(), "session_binding_unavailable");
        assert!(runtime.sessions.lock().unwrap().contains_key("source-a"));
    }

    /// 方案 I：session/new 失败时 send_prompt_core 必须返回 Err 且 runtime 日志
    /// 记录 "Prompt session ensure failed"（前端经 pylon:error 看到明确错误，
    /// 而非消息滞留 + 生成指示器空转 300s）。
    #[tokio::test]
    async fn session_new_failure_logs_ensure_failed_and_returns_error() {
        let agent = crate::test_utils::fake_acp_agent(
            "i1-fail-agent",
            &[
                "--scenario",
                "new-error",
                "--error-code",
                "-32603",
                "--error-message",
                "No LLM provider configured",
            ],
        );
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            AcpClient::connect_with_logs(&agent, None)
                .await
                .expect("fake ACP must initialize"),
        );

        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("i1-fail-agent")
            .with_agent(agent)
            .with_runtime("i1-fail-agent", runtime.clone())
            .build();
        let gateway = Arc::new(GatewayCore::new());
        let error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &gateway,
            &PromptContext {
                source: "i1-source".to_string(),
                content: "你好".to_string(),
                known_peri_id: None,
                ..Default::default()
            },
        )
        .await
        .expect_err("session/new 失败必须传播错误");
        assert!(
            error.to_string().contains("No LLM provider configured"),
            "错误必须透传 session/new 的 JSON-RPC error，实际: {error}"
        );
        // 方案 I：日志必须记录 ensure failed（前端错误可见性的日志侧证据）
        let entries = state
            .runtime_logs
            .list(&crate::runtime_log::RuntimeLogQuery::default());
        assert!(
            entries
                .iter()
                .any(|entry| entry.message == "Prompt session ensure failed"),
            "session/new 失败必须记 'Prompt session ensure failed' 日志"
        );
    }

    /// 方案 I：prompt 超时（无任何内容流式）→ 返回超时错误，日志区分
    /// "no content streamed" 且携带 requestId/sessionId/agentId 上下文。
    /// fake agent 对 session/prompt 永不响应（挂起），配 1s 超时 + 1s settle。
    #[tokio::test]
    async fn prompt_timeout_without_content_logs_distinguished_fields() {
        let mut agent = crate::test_utils::fake_acp_agent(
            "i2-hang-agent",
            &["--scenario", "prompt-silent", "--session-id", "i2-session"],
        );
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            // The configured prompt budget is intentionally much larger than
            // the first-token bound.  The surfaced error must name the bound
            // that actually fired, not blindly echo prompt_timeout_secs.
            prompt_timeout_secs: Some(180),
            first_token_timeout_secs: Some(1),
            cancel_settle_timeout_secs: Some(1),
            ..Default::default()
        });
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            AcpClient::connect_with_logs(&agent, None)
                .await
                .expect("fake ACP must initialize"),
        );

        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("i2-hang-agent")
            .with_agent(agent)
            .with_runtime("i2-hang-agent", runtime.clone())
            .build();
        let gateway = Arc::new(GatewayCore::new());
        let start = std::time::Instant::now();
        let error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &gateway,
            &PromptContext {
                source: "i2-source".to_string(),
                content: "你好".to_string(),
                known_peri_id: None,
                ..Default::default()
            },
        )
        .await
        .expect_err("prompt 挂起必须超时");
        assert!(
            error.to_string().contains("timed out after 1s"),
            "超时文案必须使用真正触发的 first-token 边界，而非 180s prompt 预算，实际: {error}"
        );
        assert!(
            start.elapsed().as_secs() < 10,
            "超时必须在参数化时长内返回（不应等 300s），实际 {:?}",
            start.elapsed()
        );
        let entries = state
            .runtime_logs
            .list(&crate::runtime_log::RuntimeLogQuery::default());
        let timeout_entry = entries
            .iter()
            .find(|entry| entry.message.starts_with("Prompt timed out"))
            .expect("超时必须记录 Prompt timed out 日志");
        assert_eq!(
            timeout_entry
                .fields
                .get("hasStreamedContent")
                .and_then(|v| v.as_bool()),
            Some(false),
            "无内容流式时必须标记 hasStreamedContent=false"
        );
        assert!(timeout_entry.fields.contains_key("requestId"));
        assert!(timeout_entry.fields.contains_key("sessionId"));
        assert!(timeout_entry.fields.contains_key("agentId"));
        assert_eq!(
            timeout_entry
                .fields
                .get("timeoutKind")
                .and_then(|v| v.as_str()),
            Some("first-token")
        );
        assert_eq!(
            timeout_entry
                .fields
                .get("timeoutBoundSecs")
                .and_then(|v| v.as_u64()),
            Some(1)
        );
        assert!(
            timeout_entry
                .fields
                .get("actualElapsedMs")
                .and_then(|v| v.as_u64())
                .is_some_and(|value| value >= 1_000),
            "必须记录实际单调等待时长"
        );
    }

    /// R-t5 回归（Bug 1）：agent 持续流式产出（agent_message_chunk）但迟迟不返回终态
    /// 响应时，回合【不得】因"已等待时长"被截——活动即续命。只有真正停止输出才设超时。
    /// fake agent 每 ~150ms 发一个 chunk、永不回 session/prompt 终态；配置
    /// idle=1s / first_token=2s（chunk 持续到达 → idle 永不触发）。2.5s 内不得超时。
    #[tokio::test]
    async fn prompt_sustained_by_streaming_activity_is_not_truncated() {
        let mut agent = crate::test_utils::fake_acp_agent(
            "i2-stream-agent",
            &[
                "--scenario",
                "stream-forever",
                "--session-id",
                "s2-stream",
                "--chunk-interval-ms",
                "150",
            ],
        );
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            // 关键：把"闲置超时"与"首 token 超时"设短，但仍在 chunk 持续到达下永不触发。
            idle_timeout_secs: Some(1),
            first_token_timeout_secs: Some(2),
            cancel_settle_timeout_secs: Some(1),
            ..Default::default()
        });
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            AcpClient::connect_with_logs(&agent, None)
                .await
                .expect("fake ACP must initialize"),
        );

        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("i2-stream-agent")
            .with_agent(agent)
            .with_runtime("i2-stream-agent", runtime.clone())
            .build();
        let gateway = Arc::new(GatewayCore::new());
        let prompt_ctx = PromptContext {
            source: "s2-source".to_string(),
            content: "hello".to_string(),
            known_peri_id: None,
            ..Default::default()
        };

        let prompt = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &gateway,
            &prompt_ctx,
        );
        // 让 prompt 跑 2.5s：chunk 持续到达（~150ms 一发），idle(1s)/first_token(2s) 都不该触发。
        // 通过带超时地 await 来观察它「仍在进行而非返回超时」。
        let outcome = tokio::time::timeout(std::time::Duration::from_millis(2500), prompt).await;
        // 2.5s 后仍在执行 = 未被截断（若旧语义把 2s 当总超时，此处早已返回 timed out）。
        assert!(
            outcome.is_err(),
            "持续流式产出的回合不得被截断：提前返回 = {:?}",
            outcome
        );
    }

    // ── #106 P5：自 b11_inject_integration_tests 迁入的纯逻辑单测（集成形态之外的
    // 组合/提取函数回归，留在 lib 靠近被测函数）──

    #[test]
    fn inject_prompt_composition_is_plain_and_conditional() {
        assert_eq!(
            compose_inject_prompt("世界书上下文", "用户消息"),
            "世界书上下文\n\n用户消息"
        );
        assert_eq!(compose_inject_prompt("", "用户消息"), "用户消息");
        assert_eq!(compose_inject_prompt("   ", "用户消息"), "用户消息");
        assert_eq!(compose_inject_prompt("上下文", ""), "上下文\n\n");
        assert!(inject_applies_to("普通消息"));
        assert!(inject_applies_to("  hello"));
        assert!(!inject_applies_to("/command"));
        assert!(!inject_applies_to("  /command"));
    }

    #[test]
    fn extract_tool_file_name_parses_sanitized_summary() {
        assert_eq!(
            extract_tool_file_name(r#"{"path": "G:/project/src/lib.rs"}"#).as_deref(),
            Some("G:/project/src/lib.rs")
        );
        assert_eq!(
            extract_tool_file_name(r#"{"file": "main.ts", "op": "edit"}"#).as_deref(),
            Some("main.ts")
        );
        assert_eq!(
            extract_tool_file_name(r#"{"command": "ls"}"#),
            None,
            "无文件名键不提取"
        );
        assert_eq!(
            extract_tool_file_name(r#"{"path": ""}"#),
            None,
            "空路径不提取"
        );
        assert_eq!(extract_tool_file_name("not json at all"), None);
        // 只取顶层 path 值，不把 rawInput（可能含 secret）带出
        let raw = r#"{"path": "src/x.rs", "token": "SECRET"}"#;
        assert_eq!(extract_tool_file_name(raw).as_deref(), Some("src/x.rs"));
    }

    #[test]
    fn extract_tool_file_name_ignores_embedded_path_fragments() {
        // 审查修复回归：值内嵌的 "path": 片段不得被当作文件名（防 secret 以文件名形态落盘）
        let embedded = r#"{"input": "config says \"path\":\"sk-abc123\""}"#;
        assert_eq!(
            extract_tool_file_name(embedded),
            None,
            "非顶层键的内嵌 path 片段必须忽略"
        );
        // 非 JSON 形态一律不提取
        assert_eq!(extract_tool_file_name(r#"{path: x}"#), None);
        assert_eq!(extract_tool_file_name(r#""path":"src/x.rs""#), None);
    }

    /// #463 绕锁面：user_data_save 对保留键 approval-mode 拒绝（user_data_reserved_key），
    /// 即使 service 在场也不落盘——磁盘值必须经 set_approval_mode 持锁演化。
    #[tokio::test]
    async fn user_data_save_rejects_reserved_approval_mode_key() {
        use crate::session::user_data::{UserDataError, UserDataKey};
        let shared = std::sync::Arc::new(
            crate::session::UserDataService::in_memory().expect("user service"),
        );
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_user_data_service(shared.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let error = user_data_save(
            app.state::<AppState>(),
            "approval-mode".to_string(),
            serde_json::json!({ "version": 1, "mode": "bypass" }),
            None,
        )
        .await
        .expect_err("reserved key must be rejected");
        match &error {
            PylonError::UserData(UserDataError::ReservedKey { key }) => {
                assert_eq!(key, "approval-mode");
            }
            other => panic!("expected reserved key error, got {other:?}"),
        }
        assert_eq!(error.code(), "user_data_reserved_key");
        // 拦截在 service 之前：磁盘无行
        assert!(shared
            .load_sync(UserDataKey::ApprovalMode)
            .expect("load")
            .is_none());
    }

    /// #463 绕锁面：load 不拦——读不产生分叉，且前端 approvalModeRestore
    /// 持久层探询（种子判定）依赖它。
    #[tokio::test]
    async fn user_data_load_still_allows_approval_mode_key() {
        let shared = std::sync::Arc::new(
            crate::session::UserDataService::in_memory().expect("user service"),
        );
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_user_data_service(shared)
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let loaded = user_data_load(app.state::<AppState>(), "approval-mode".to_string())
            .await
            .expect("load of approval-mode must remain allowed");
        assert!(loaded.is_none());
    }
}
