//! 崩溃处理 + 自动重连缝（#317 批次二 ④ 自 mod.rs 主泵内联闭包迁入）。
//!
//! 原 `handle_crash` 闭包（R7/A7/ISSUE-17）改为准共享 `&self` 方法：闭包每次
//! 调用对全部捕获再克隆入 future——本结构等价改写为按字段克隆，语义逐位一致。
//! 幂等设计：`auto_reconnect_active` 防重入，双通道（broadcast/watch）都送达时
//! 最多多发一次同 payload 状态事件。

use pylon_foundations::await_guard::HeldAcrossAwait;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::reactions::KernelReactionSink;
use crate::agent::runtime::AgentLifecycleStatus;
use crate::runtime::AgentRuntime;
use crate::{emit_event, AppStateHandles};

/// 崩溃处理 + 自动重连权威。字段与原闭包捕获一一对应（见 mod.rs setup 克隆段）。
/// `reactions` 为产品反应订阅缝（#416 W2 步骤③）——原 `pet::on_agent_crashed`
/// 直呼点改经 sink（独立方法，非 PetEvent 变体；R2 修正）。
/// `agent_id` 是**本 runtime 自身**的注册身份（泵以 `Arc::ptr_eq` 解析，见
/// `NotificationPump::new`）——#680：不再从全局 `active_agent` 反推。
pub(crate) struct CrashReconnectHandler<R: tauri::Runtime> {
    handles: AppStateHandles,
    agent_id: String,
    agent_runtime: Arc<std::sync::Mutex<crate::agent::runtime::AgentRuntimeState>>,
    window: tauri::Window<R>,
    runtime_for_reconnect: Arc<AgentRuntime>,
    reconnect_epoch: Arc<AtomicU64>,
    reactions: Arc<dyn KernelReactionSink>,
}

impl<R: tauri::Runtime> CrashReconnectHandler<R> {
    pub(crate) fn new(
        handles: AppStateHandles,
        agent_id: String,
        agent_runtime: Arc<std::sync::Mutex<crate::agent::runtime::AgentRuntimeState>>,
        window: tauri::Window<R>,
        runtime_for_reconnect: Arc<AgentRuntime>,
        reconnect_epoch: Arc<AtomicU64>,
        reactions: Arc<dyn KernelReactionSink>,
    ) -> Self {
        Self {
            handles,
            agent_id,
            agent_runtime,
            window,
            runtime_for_reconnect,
            reconnect_epoch,
            reactions,
        }
    }

    /// 崩溃通知入口（broadcast 分支 / watch 订阅即查 / watch changed 三路共用）。
    /// `reason` 为稳定 code（transport.rs CrashReason::as_str）。
    // R9：自动重连是 LifecycleOp 状态机一环，agent_lifecycle 跨 await 与 switch/reconnect 串行
    pub(crate) async fn handle(&self, reason: String) {
        // ISSUE-17 目标行为 2：保留原始 code 生成用户可读文案（不覆盖诊断字段）
        let last_error = format!("ACP 进程崩溃（{reason}）");
        // B4：崩溃以统一 cause DTO 入日志（与 preflight/连接测试同形；
        // 未知 code 不写 cause 字段，不猜）。
        if let Some(crash_reason) = crate::acp::cause::crash_reason_from_code(&reason) {
            let cause = crate::acp::cause::crash_reason_cause(crash_reason);
            self.handles.runtime_logs.push(
                crate::time::Timestamp::now(),
                "error",
                "agent-crash",
                None,
                &cause.summary,
                serde_json::Map::from_iter([
                    (
                        "causeCode".to_string(),
                        serde_json::Value::String(cause.code.clone()),
                    ),
                    (
                        "causeLevel".to_string(),
                        serde_json::Value::String(cause.level.to_string()),
                    ),
                    (
                        "action".to_string(),
                        serde_json::Value::String(cause.action.unwrap_or_default().to_string()),
                    ),
                ]),
            );
        }
        match self.agent_runtime.lock() {
            Ok(mut runtime_state) => {
                runtime_state.status = AgentLifecycleStatus::Crashed;
                runtime_state.last_error = Some(last_error);
            }
            Err(poison) => {
                tracing::warn!(
                    agent_id = %self.agent_id,
                    "agent_runtime lock poisoned on crash; recovering state"
                );
                let mut runtime_state = poison.into_inner();
                runtime_state.status = AgentLifecycleStatus::Crashed;
                runtime_state.last_error = Some(last_error);
            }
        }
        // 崩溃感知经订阅缝（原 `pet::on_agent_crashed` 直呼点；调用位置不变——
        // 状态置 Crashed 之后、AGENT_STATUS 事件之前；sink 实现内单次锁 +
        // 中毒吸收，与原 `let _ = pet.lock()` 逐位一致）。
        self.reactions.on_agent_crashed();
        // P2-4：崩溃 payload 复用 agent_status_payload（状态已置 Crashed，
        // 读出的形状与旧手工构造一致：status=crashed/available=false/
        // crashed=true/lastError 注入），不再双份维护同一形状。
        // #680：身份用本 runtime 的注册 id 显式注入——非 active runtime 的
        // 崩溃事件不得被标成当前 active agent。
        let reconnect_handles = self.handles.clone_handles();
        emit_event(
            &self.window,
            crate::event_names::AGENT_STATUS,
            reconnect_handles.agent_status_payload_for(
                Some(self.runtime_for_reconnect.as_ref()),
                Some(&self.agent_id),
            ),
        );
        // R7：每次崩溃通知推进 reconnect_epoch（防重入标志无论是否持有）——
        // 被吸收的重复通知也会改变 epoch，重连循环据此感知"新一轮崩溃到来"。
        self.reconnect_epoch.fetch_add(1, Ordering::AcqRel);
        // 自动重连：崩溃后指数退避自动拉起（最多 5 次，~62s）。
        // 防重入：多次崩溃通知只调度一次（auto_reconnect_active）。
        // per-runtime 语义：只重连本 runtime 绑定的 agent；用户手动
        // reconnect 会置状态非 Crashed、手动 switch 会改变 active_agent，
        // 循环内每轮复查后放弃。切换 agent 不会串扰其他 runtime。
        if !self
            .runtime_for_reconnect
            .auto_reconnect_active
            .swap(true, Ordering::AcqRel)
        {
            let reconnect_runtime = self.runtime_for_reconnect.clone();
            let window_for_reconnect = self.window.clone();
            let epoch_for_reconnect = self.reconnect_epoch.clone();
            // #680：身份来自本 runtime 的注册 id（pump 以 Arc::ptr_eq 解析），
            // 不再是全局 active_agent 的快照。
            let reconnect_agent_id = self.agent_id.clone();
            // 调度时读当前 epoch：本循环的 ticket。
            let mut scheduled_epoch = self.reconnect_epoch.load(Ordering::Acquire);
            tokio::spawn(async move {
                // 手动 switch 会 abort 本 runtime 的 dispatcher，但不会
                // cancel 自动重连闭包——每轮复查 active_agent 是否仍是本
                // runtime 的 agent，防止重连成功后把 active_agent 顶回本 agent。
                // R7：remaining_attempts 局部预算 + attempt 退避指数。
                // G2-07：重连策略参数化（默认值 = 现值 5/2000/30000，行为零变化）。
                let mut remaining_attempts =
                    crate::agent::runtime::ReconnectPolicy::default().max_attempts;
                let mut attempt: u32 = 1;
                // O-4：退出闸门（外层循环）——内层循环因成功复查通过/提前放弃/
                // 预算耗尽退出时，期间可能恰有一轮崩溃通知被处理（epoch 已变，
                // 防重入 swap 被吞）：其"重连意图"未消费，若此刻释放标志则该
                // 崩溃不再调度新循环。闸门复查 epoch——未变才退出消费 ticket
                // 并释放标志；已变则重新武装（预算与退避重置）继续重连（标志
                // 持续持有，本循环仍是唯一重连权威，对齐 R7 每轮复查语义）。
                'auto_reconnect: loop {
                    loop {
                        if remaining_attempts == 0 {
                            break;
                        }
                        // R7：每轮复查 epoch——重连期间到来新一轮崩溃通知（含被防重入
                        // 标志吸收的）→ 本循环已失效：放弃旧 ticket、以最新 epoch 重新
                        // 武装（预算与退避重置），本循环仍是唯一重连权威（标志持续持有）。
                        if epoch_for_reconnect.load(Ordering::Acquire) != scheduled_epoch {
                            tracing::info!(
                                "auto-reconnect superseded by a newer crash; re-arming from attempt 1"
                            );
                            // 放弃旧 ticket：以最新 epoch 重新武装。
                            scheduled_epoch = epoch_for_reconnect.load(Ordering::Acquire);
                            remaining_attempts =
                                crate::agent::runtime::ReconnectPolicy::default().max_attempts;
                            attempt = 1;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(
                            crate::agent::runtime::ReconnectPolicy::default().backoff_ms(attempt),
                        ))
                        .await;
                        // 用户已手动 reconnect（状态非 Crashed）或已 switch（active_agent
                        // 已换）→ 放弃自动重连。两读在同一锁持有期内完成，消除
                        // "已复查 stale、尚未复查 active"之间的切换窗口。
                        let (still_stale, still_active) = {
                            let runtime_guard = reconnect_runtime
                                .agent_runtime
                                .lock()
                                .unwrap_or_else(|poison| poison.into_inner());
                            let active_guard = reconnect_handles
                                .active_agent
                                .lock()
                                .unwrap_or_else(|poison| {
                                    tracing::warn!(
                                        agent_id = %reconnect_agent_id,
                                        "active_agent lock poisoned during auto-reconnect; recovering"
                                    );
                                    poison.into_inner()
                                });
                            (
                                runtime_guard.status == AgentLifecycleStatus::Crashed,
                                active_guard.as_str() == reconnect_agent_id,
                            )
                        };
                        if !(still_stale && still_active) {
                            // 核验修复：提前放弃也必须释放防重入标志，
                            // 否则后续崩溃将永远不再自动重连。
                            break;
                        }
                        // #680：AgentDef 按本 runtime 的 agent id 取（reload 可能
                        // 已删除该 agent）；取不到时不再裸 break，见 abandon_reconnect。
                        let agent = match reconnect_handles.agents.lock() {
                            Ok(agents) => agents.get(&reconnect_agent_id).cloned(),
                            Err(poison) => {
                                tracing::warn!(
                                    agent_id = %reconnect_agent_id,
                                    "agents lock poisoned during auto-reconnect; recovering registry view"
                                );
                                poison.into_inner().get(&reconnect_agent_id).cloned()
                            }
                        };
                        let Some(agent) = agent else {
                            abandon_reconnect(
                                &reconnect_handles,
                                &reconnect_agent_id,
                                &reconnect_runtime,
                                &window_for_reconnect,
                                "agent 已不在注册表（配置 reload 删除？）",
                            );
                            break;
                        };
                        let _lifecycle_guard =
                            HeldAcrossAwait::new(reconnect_runtime.agent_lifecycle.lock().await);
                        // R9：自动重连是 LifecycleOp 状态机的一环——经本 runtime 的
                        // agent_lifecycle 与 switch/reconnect/平台懒启动串行（无 kill，
                        // 不持 switch_lock；状态机定义见 lifecycle.rs 模块文档）。
                        // P2-1：拿到生命周期锁后重查"仍然需要连接"——复查 stale 与
                        // 拿锁之间，用户手动 reconnect 可能已把状态置非 Crashed 并完成
                        // 连接；此时再 do_connect_and_replace 会连续第二次连接。
                        // 手动操作（switch/reconnect）同样在锁内改状态，锁串行后
                        // 此处必能看到其结果。
                        // #680：同样要复查 active——排队等锁期间用户可能已 switch 到
                        // 别的 agent（改 active 不要求本 runtime 的生命周期锁先到手），
                        // 此时重连成功会把 active 顶回本 agent。
                        let (still_stale, still_active) = {
                            let runtime_guard = reconnect_runtime
                                .agent_runtime
                                .lock()
                                .unwrap_or_else(|poison| {
                                    tracing::warn!(
                                        agent_id = %reconnect_agent_id,
                                        "agent_runtime lock poisoned after lifecycle lock; recovering"
                                    );
                                    poison.into_inner()
                                });
                            let active_guard = reconnect_handles
                                .active_agent
                                .lock()
                                .unwrap_or_else(|poison| {
                                    tracing::warn!(
                                        agent_id = %reconnect_agent_id,
                                        "active_agent lock poisoned after lifecycle lock; recovering"
                                    );
                                    poison.into_inner()
                                });
                            (
                                runtime_guard.status == AgentLifecycleStatus::Crashed,
                                active_guard.as_str() == reconnect_agent_id,
                            )
                        };
                        if !(still_stale && still_active) {
                            break;
                        }
                        match crate::lifecycle::do_connect_and_replace(
                            &reconnect_handles,
                            &reconnect_runtime,
                            &window_for_reconnect,
                            &agent,
                            None,
                            AgentLifecycleStatus::Reconnecting,
                            "auto-reconnect",
                            crate::agent::runtime::SessionContinuity::Unknown,
                            true,
                        )
                        .await
                        {
                            Ok(()) => {
                                // 连接成功后又立即崩溃时，新 dispatcher 的崩溃通知会被
                                // "已重连"防重入标志吞掉（标志仍持有）——成功分支复查，
                                // 仍 Crashed 则继续退避重连，避免 agent 永久下线。
                                let still_stale = reconnect_runtime
                                    .agent_runtime
                                    .lock()
                                    .map(|r| r.status == AgentLifecycleStatus::Crashed)
                                    .unwrap_or(false);
                                if still_stale {
                                    attempt += 1;
                                    remaining_attempts -= 1;
                                    continue;
                                }
                                // Publish completion of the successful reconnect before
                                // leaving the worker. Callers observe Connected and the
                                // guard as one settled state; keeping the flag set here
                                // creates a race where a caller sees stale re-entry state.
                                reconnect_runtime
                                    .auto_reconnect_active
                                    .store(false, Ordering::Release);
                                break;
                            }
                            Err(error) => {
                                tracing::warn!("auto-reconnect attempt {attempt} failed: {error}");
                                attempt += 1;
                                remaining_attempts -= 1;
                            }
                        }
                    }
                    if epoch_for_reconnect.load(Ordering::Acquire) == scheduled_epoch {
                        break 'auto_reconnect;
                    }
                    tracing::info!(
                        "auto-reconnect ended but a newer crash arrived; re-arming from attempt 1"
                    );
                    scheduled_epoch = epoch_for_reconnect.load(Ordering::Acquire);
                    remaining_attempts =
                        crate::agent::runtime::ReconnectPolicy::default().max_attempts;
                    attempt = 1;
                }
                // R7：成功/放弃消费 ticket——循环结束（成功、提前放弃或预算耗尽）
                // 统一推进 epoch，使后续通知的计数严格单调。
                epoch_for_reconnect.fetch_add(1, Ordering::AcqRel);
                reconnect_runtime
                    .auto_reconnect_active
                    .store(false, Ordering::Release);
            });
        }
    }
}

/// #680：放弃自动重连的显式出口——warn + 一条 agent-status 诊断。
///
/// 背景：循环里的提前退出（用户 reconnect/switch）是正常语义；但「注册表里
/// 找不到本 runtime 的 agent」属于异常，如果只 `break`，会出现「承诺 5 次
/// 自动重连、实际一次没跑且无痕」。此出口把原因写进日志与 lastError/事件，
/// 事件身份同样显式用本 runtime 的 agent id（不是 active）。
fn abandon_reconnect<R: tauri::Runtime>(
    handles: &AppStateHandles,
    agent_id: &str,
    runtime: &AgentRuntime,
    window: &tauri::Window<R>,
    reason: &str,
) {
    tracing::warn!(agent_id, "auto-reconnect abandoned: {reason}");
    handles.emit_agent_status_for(
        runtime,
        window,
        Some(agent_id),
        AgentLifecycleStatus::Crashed,
        Some(format!("自动重连已放弃：{reason}")),
    );
}
