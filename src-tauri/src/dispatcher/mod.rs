//! 通知分发器：ACP 事件广播 → 前端/平台 + 崩溃处理 + 自动重连调度 + B9 权限挂起。
//! R1 拆分自 lib.rs（行为零变化）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::acp::AcpClient;
use crate::agent::runtime::{session_mapping_matches, source_for_peri_id_in_generation};
use crate::runtime::AgentRuntime;
use crate::session::SessionInfo;
// #317 批次二 ④：flush 正身迁 canonical_flush.rs。
use crate::emit_event;
#[cfg(test)]
use crate::session::DurableSessionOwner;
use crate::AppStateHandles;

mod routing;
mod session_update;

// #317 批次二 ④：主泵六缝提取——决策归子模块、副作用适配归调用点（同 routing 惯例）。
mod canonical_flush;
mod draft_flush;
// #331/U4：逐帧热路径基准（cfg(test)，--nocapture 读数）。
mod crash_reconnect;
mod fallback_route;
#[cfg(test)]
mod frame_path_bench;
mod host_tools_gate;
mod interaction_route;
mod permission_route;
mod publish_route;
// #416 W2 步骤③：产品反应订阅缝（PetEvent/derive + KernelReactionSink）。
// pub(crate)：session/prompt 收尾分位点（wave2 步骤 3-余）经本模块消费 sink。
pub(crate) mod reactions;

#[cfg(test)]
use canonical_flush::flush_pending_canonical;
use canonical_flush::{
    should_flush_batch, CanonicalFlushContext, PendingCanonicalPublish,
    PENDING_CANONICAL_FLUSH_INTERVAL,
};
use crash_reconnect::CrashReconnectHandler;
use draft_flush::{
    absorb_window, commit_open_draft, publish_due_draft, DraftRun, DRAFT_PERSIST_INTERVAL,
};
use fallback_route::route_unknown_notification;
use host_tools_gate::{route_fs_request, route_terminal_request};
use interaction_route::{route_elicitation_complete, route_private_interaction};
use permission_route::route_permission_request;
use reactions::{derive_session_reactions, KernelReactionSink, PetEvent, PetReactionSink};

/// Canonical ingest failure policy for a live ACP update.
///
/// A `SessionDeleted` result is an expected outcome when a delete transaction
/// wins the race with an update that was already in the ACP inbox. The
/// tombstone gate must still reject the event (so the session cannot be
/// resurrected), but reporting that expected rejection at error level creates
/// a misleading user-facing runtime error. Keep it at debug level while
/// retaining error-level visibility for actual persistence failures.
fn log_canonical_ingest_error(error: &crate::session::EventError, agent_id: &str, source: &str) {
    if matches!(error, crate::session::EventError::SessionDeleted(_)) {
        tracing::debug!(
            code = error.code(),
            agent_id,
            source,
            error = %error,
            "late ACP update ignored for deleted session"
        );
    } else {
        tracing::error!(
            code = error.code(),
            agent_id,
            source,
            error = %error,
            "canonical ingest failed; event was not published"
        );
    }
}

// R8：拆 handler 后共享状态经显式参数传递（闭包捕获收敛）——别名收敛复杂签名。
/// #549/ADR-0037：acp 单元是「短窗换装位」——读侧快照 clone 即放锁，锁内无
/// await；cancel/kill 的代际原子性由快照客户端的 `client_generation()` 自校验。
type AcpLock = std::sync::RwLock<Arc<AcpClient>>;

/// #549：acp 单元快照（与 `runtime::AgentRuntime::snapshot_acp` 同语义）。
fn acp_snapshot(acp: &AcpLock) -> Arc<AcpClient> {
    acp.read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}
type SessionsLock = std::sync::Mutex<std::collections::HashMap<String, SessionInfo>>;

/// provider 解析正身已迁 interaction_route.rs（#416 W2 步骤①）；permission.rs
/// 仍经本路径消费，保留 crate 内再导出。
pub(crate) use interaction_route::resolve_agent_provider;

/// 剥离 replay 的 user 消息 persona/session_prompt 前缀（验收回归 D3）。
/// Pylon 首条消息发送"{effective_persona}\n\n---\n\n{content}"给 Hermes（prompt.rs
/// 的 effective_persona = session_prompt 优先于 persona），Hermes 持久化该完整
/// prompt;load 重放时 content 带前缀,与前端 live 的原文不一致导致内容签名去重
/// 失效（每次回到会话消息累积）。
///
/// 剥离策略：不依赖精确 persona 匹配（session_prompt 场景 persona 不匹配），
/// 而是检测 `\n\n---\n\n` 分隔符——它是 Pylon 发送首条消息时的固定分隔。存在
/// 则取分隔符后的原文；不存在（后续轮次消息无前缀）原样返回。用户原文若自身
/// 含该分隔符会误剥，但概率极低且仅影响重放去重。
pub(crate) fn strip_persona_prefix(text: &str, _persona: &str) -> String {
    const SEP: &str = "\n\n---\n\n";
    match text.find(SEP) {
        Some(idx) => {
            let content = &text[idx + SEP.len()..];
            if content.is_empty() {
                text.to_string()
            } else {
                content.to_string()
            }
        }
        None => text.to_string(),
    }
}

/// NOTIF_SESSION_UPDATE 处理（R8 自主循环拆分）：source 解析（重试循环）→ 代际
/// 复核 → session 状态 + 宠物感知应用（C11 回放守卫 / O7 锁外应用）→ 前端+平台
/// 转发（B10.1）。返回 false 表示本代已结束（主循环应退出）。
// clippy 2026-09-22：参数为各锁/上下文的按引用透传（window/gateway/sessions/
// binding_health/pet/update_channels/generation），20 参为 kernel seam 入口形态
// （#335 曾以「与 flush_pending_canonical 同形态」为据，后者已结构体化；本函数
// 的结构体收口属 #331/U2b 后续另一案，届时摘除）。
#[allow(clippy::too_many_arguments)]
async fn handle_session_update<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    gateway: &crate::gateway::GatewayCore,
    sessions: &SessionsLock,
    binding_health: &std::sync::Mutex<
        std::collections::HashMap<String, crate::agent::runtime::SessionBindingHealth>,
    >,
    reactions: &dyn KernelReactionSink,
    update_channels: &crate::runtime::UpdateChannelMap,
    client_generation: &AtomicU64,
    generation: u64,
    mapping_ready: &tokio::sync::Notify,
    agent_id: &str,
    event_service: Option<&Arc<crate::session::EventService>>,
    message_service: Option<&Arc<crate::session::MessageService>>,
    classification: crate::acp::ReplayClassification,
    wire_ordinal: Option<u64>,
    turn_ledger: &Arc<crate::acp::TurnLedger>,
    probe_sessions: &crate::runtime::ProbeSessionRegistry,
    ingress_seq: u64,
    wire: Option<Arc<crate::acp::AcpWireCapture>>,
    pending_batch: Option<&mut Vec<PendingCanonicalPublish>>,
    payload: serde_json::Value,
) -> bool {
    let Some(resolved) = session_update::resolve_session_update_target(
        sessions,
        binding_health,
        mapping_ready,
        client_generation,
        generation,
        probe_sessions,
        payload,
    )
    .await
    else {
        return true;
    };
    let payload = resolved.payload;
    let peri_id = resolved.peri_id;
    let source = resolved.source;
    // source_for_peri_id_in_generation 已按代过滤（返回的映射
    // generation 必等于本 dispatcher 代），此处仅复核客户端未替换。
    if client_generation.load(Ordering::Acquire) != generation {
        tracing::warn!("ACP notification rejected for stale session {}", peri_id);
        return true;
    }
    let Some(update) = payload.get("update") else {
        tracing::warn!("ACP session/update missing update payload");
        return true;
    };
    // R4→#316：sessionUpdate 变体经官方 schema typed-first 分类
    // （classify_session_update；解析失败落 from_str 宽容别名，未知 → None，
    // 与旧 `_ => {}` 忽略一致）。
    let variant = crate::acp::classify_session_update(update);
    // Replay/live is decided once at the transport boundary and passed through
    // the Kernel seam. Provider `_meta.periReplay` is compatibility metadata,
    // never an authority for side-effect policy.
    let is_replay = routing::classification_is_replay(classification);
    // G3 §2.2.1 锁收敛：单一临界区取代原 mapping_is_current 预检（锁 2）、
    // received_round 读取（锁 3）、collect_response_chunk（锁 4）、mutation（锁 5）四段。
    // early return 语义逐一保持：stale → return true（保持主循环）；user_message_chunk
    // → 回显后 return true（不转发 emit_event_all）；mutation 后 generation 变化 →
    // return false（结束主循环）。副作用顺序不变：FirstChunk → CodeSeen →
    // apply_update_event 产出（收集顺序 = 应用顺序，锁外统一 apply）。
    // 良性竞态修正：received_round 读取与 collect 合锁原子（原两次独立锁间
    // advance_round 可能推进回合——collect 内 round 比对兜底，行为只会更保守）。
    // C11：回放（is_replay）事件不触发宠物感知也不流式收集回复文本，事件照常转发。
    let mut pet_events: Vec<PetEvent> = Vec::new();
    let mut user_echo: Option<String> = None; // replay user_message_chunk 文本，锁外 emit
    let mut is_user_chunk = false;
    let mut session_state_to_persist: Option<(
        crate::session::DurableSessionOwner,
        serde_json::Value,
    )> = None;
    let routing_input: routing::RoutingInput;
    let routing_decision: routing::RoutingDecision;
    let durable_owner;
    {
        let Ok(mut items) = sessions.lock() else {
            // 锁中毒：丢弃本事件（原 mapping_is_current 同语义）
            return true;
        };
        if client_generation.load(Ordering::Acquire) != generation {
            tracing::warn!("ACP notification rejected for stale session {}", peri_id);
            return true;
        }
        // 单次查表替代「is_some_and 校验后再 expect 取值」：None 与映射不匹配
        // 一样按过期通知拒绝（原 expect("current mapping checked")，锁内无
        // TOCTOU，语义不变）。
        let Some(session) = items.get(&source) else {
            tracing::warn!("ACP notification rejected for stale session {}", peri_id);
            return true;
        };
        if !session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation) {
            tracing::warn!("ACP notification rejected for stale session {}", peri_id);
            return true;
        }
        durable_owner = match session.durable_owner(agent_id, &source) {
            Ok(owner) => owner,
            Err(error) => {
                tracing::error!(
                    code = "event_owner_invalid",
                    agent_id,
                    source,
                    error = %error,
                    "canonical ingest rejected an invalid durable owner"
                );
                return true;
            }
        };
        let replay_loading = session.replay_loading;
        let input = routing::RoutingInput {
            source: source.clone(),
            remote_session_id: peri_id.clone(),
            generation,
            owner: durable_owner.clone(),
            classification,
            variant,
            replay_loading,
            // P2（#334）：Arc 引用计数共享，原整份 payload 深拷贝已拆除；
            // 原件继续由本函数持有，发布侧消费。
            payload: Arc::clone(&payload),
            wire_ordinal,
        };
        let decision = routing::decide(&input);
        routing_input = input;
        routing_decision = decision;
        // R-t5：任意被接受的 live ACP update 都刷新 liveness（活动即续命）。
        // 仅跳过回放事件（历史重放不是本回合的实时产出，不应当作活动信号）。
        if !is_replay {
            if let Some(session) = items.get_mut(&source) {
                session.last_activity = Some(std::time::Instant::now());
            }
        }
        if decision.collect_response {
            let effects = routing::agent_message_chunk_effects(update, decision);
            // #99：live 活动 → turn 账本推进（Streaming 阶段 + ingress cursor +
            // 文本标志）；回合未登记或已终态时为迟到活动，仅计诊断，不产生终态。
            let _ = turn_ledger.note_session_activity(
                &source,
                &peri_id,
                generation,
                ingress_seq,
                crate::acp::ActivityFlags {
                    saw_text: effects.text.is_some(),
                    saw_tool: false,
                    saw_thinking: false,
                },
            );
            if effects.first_chunk {
                pet_events.push(PetEvent::FirstChunk);
            }
            if effects.code_seen {
                pet_events.push(PetEvent::CodeSeen);
            }
            // B11.2：流式收集当前回合回复文本（完成持久化 POST /persist 用）。
            // 回合绑定与截断逻辑仍由 SessionInfo 持有；routing 只决定该 chunk
            // 是否属于 live response，避免 replay 事件进入 live collector。
            if let Some(text) = effects.text.as_deref() {
                if let Some(session) = items.get_mut(&source) {
                    let received_round = session.inject_round;
                    session.collect_response_chunk(text, received_round);
                }
            }
        }
        if variant == Some(crate::acp::SessionUpdateVariant::UserMessageChunk) {
            is_user_chunk = true;
            if is_replay {
                // session/load 的历史由 load_persisted_session command 原子返回，
                // dispatcher 不再把 replay 事件广播给前端，避免与 snapshot 双写。
                let text = update
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                user_echo = if items
                    .get(&source)
                    .is_some_and(|session| session.replay_loading)
                {
                    None
                } else {
                    text.map(|text| {
                        let persona = items
                            .get(&source)
                            .map(|session| session.persona.clone())
                            .unwrap_or_default();
                        strip_persona_prefix(&text, &persona)
                    })
                };
            }
        } else if let Some(session) = items.get_mut(&source) {
            if !decision.mutate_session {
                return true;
            }
            // #99（评审 E3）：live 工具活动同样喂给账本——saw_tool 是
            // empty-turn 判定（tool-only vs agent-empty）的输入；文本 chunk
            // 与工具调用都会在 dispatcher 处理瞬间写入账本，settle 侧以此
            // 为判定源（残余窗口见 refine_empty_turn 注释）。
            if !is_replay
                && matches!(
                    variant,
                    Some(
                        crate::acp::SessionUpdateVariant::ToolCall
                            | crate::acp::SessionUpdateVariant::ToolCallUpdate
                    )
                )
            {
                let _ = turn_ledger.note_session_activity(
                    &source,
                    &peri_id,
                    generation,
                    ingress_seq,
                    crate::acp::ActivityFlags {
                        saw_text: false,
                        saw_tool: true,
                        saw_thinking: false,
                    },
                );
            }
            // #316：live 思考流喂账本 saw_thinking——thinking-only 回合
            // （长推理无正文无工具）empty-turn 判定算有产出，不再误报
            // agent-empty。思考文本本身不进 collect（与旧行为一致）。
            if !is_replay && variant == Some(crate::acp::SessionUpdateVariant::AgentThoughtChunk) {
                let _ = turn_ledger.note_session_activity(
                    &source,
                    &peri_id,
                    generation,
                    ingress_seq,
                    crate::acp::ActivityFlags {
                        saw_text: false,
                        saw_tool: false,
                        saw_thinking: true,
                    },
                );
            }
            // 感知派生（O7/C11）：live 门控 = sink.wants_live_reactions(class)——
            // PetEvent 收集仍在 sessions 锁内、按序产出（收集顺序 = 应用顺序），
            // 应用在锁外经 sink（reactions.rs 三表征文档钉住）。
            pet_events.extend(derive_session_reactions(
                session,
                update,
                variant,
                reactions.wants_live_reactions(decision.class),
            ));
            // Agents may advertise commands or mode changes asynchronously after
            // session/new or session/load. Persist the merged session snapshot so
            // a later reload retains those capabilities.
            if !is_replay
                && matches!(
                    variant,
                    Some(
                        crate::acp::SessionUpdateVariant::AvailableCommandsUpdate
                            | crate::acp::SessionUpdateVariant::CurrentModeUpdate
                    )
                )
            {
                if let Some(owner) = durable_owner.clone() {
                    let mut snapshot = serde_json::Map::new();
                    if let Some(commands) = &session.commands_snapshot {
                        snapshot.insert("commands".into(), commands.clone());
                    }
                    if let Some(usage) = &session.usage_snapshot {
                        snapshot.insert("usage".into(), usage.clone());
                    }
                    if let Some(mode) = &session.mode {
                        snapshot.insert("mode".into(), serde_json::Value::String(mode.clone()));
                    }
                    let snapshot = serde_json::Value::Object(snapshot);
                    session_state_to_persist = Some((owner, snapshot));
                }
            }
            // 原 :417-433
        }
    }
    match session_update::finalize_session_update(
        window,
        gateway,
        update_channels,
        reactions,
        agent_id,
        &peri_id,
        &source,
        event_service,
        message_service,
        client_generation,
        generation,
        pending_batch,
        routing_input,
        routing_decision,
        pet_events,
        session_state_to_persist,
        is_user_chunk,
        user_echo,
        payload,
        wire,
    )
    .await
    {
        session_update::UpdateFinalizeOutcome::KeepPumping => true,
        session_update::UpdateFinalizeOutcome::EndGeneration => false,
    }
}

/// 单帧泵取的失败/跳过策略（#336/U2b：select! 封装为具名函数后，循环骨架凭此
/// 分流）。Frame = 产出本帧进入路由分支；Skipped = 本迭代副作用已完成（崩溃
/// watch 触发处理 / 窗口 flush 完成），跳过路由直接下一轮；Stop = 主循环退出
/// （inbox 关闭 / 窗口 flush 失败）。
// Frame 变体按值携带整帧 ClassifiedMessage（含 raw payload，与其他变体的
// 尺寸差超过 lint 的 200 字节阈值）——Box 化需每帧一次堆分配，与 #334 逐帧
// 热路径降分配目标相悖；本枚举是泵取流程控制面，值语义保留属有意取舍，
// 故定点豁免本 lint。
#[allow(
    clippy::large_enum_variant,
    reason = "Frame 按值携带整帧以避免每帧堆分配；Box 化与 #334 降分配方向相悖"
)]
enum PumpStep {
    Frame(crate::acp::ClassifiedMessage),
    Skipped,
    Stop,
}

/// 启动（或重启）通知分发器：消费 ACP 单消费者无损通知 inbox，把事件路由到
/// 前端（WebView 事件）与平台（gateway deliver_all），并处理崩溃/权限/宠物感知。
///
/// #336/U2b：本函数降为「复位旧任务 + 装配 + spawn」编排入口；句柄克隆/
/// agent_id 解析/崩溃处理器装配收敛进 [`NotificationPump::new`]，主循环骨架在
/// [`NotificationPump::run`]，泵取与路由分支各为具名方法（失败/跳过策略见
/// [`PumpStep`] 与 `route_frame` 返回值文档）。语句次序、锁获取点、generation
/// 校验点与拆分前逐一对照保持。
pub(crate) fn start_notification_dispatcher<R: tauri::Runtime>(
    handles: &AppStateHandles,
    runtime: &Arc<AgentRuntime>,
    window: tauri::Window<R>,
) {
    // O8：锁中毒（panic 时持有者遗弃）也恢复重启——into_inner 取出 guard，
    // 否则 dispatcher 永久静默下线，自动重连/崩溃通知全部失效。
    let mut task = runtime
        .notification_task
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(handle) = task.take() {
        handle.abort();
    }
    // 装配在 spawn 前同步完成（new 仅克隆字段，原克隆段同样在任务复位后、
    // 首次 poll 前执行，无可观察时序差异）；pump 所有权移入任务。
    let pump = NotificationPump::new(handles, runtime, window);
    *task = Some(tokio::spawn(async move {
        pump.run().await;
    }));
}

/// 通知泵主循环的共享环境束（#336/U2b：原 spawn 闭包捕获的局部变量逐一收敛为
/// 字段，分支具名方法经 `self` 访问，消除逐参手抄传递）。字段与原克隆段一一
/// 对应。`handle_crash`/reconnect_epoch 原在任务内构造——纯字段装配无副作用、
/// 无 await，提前到 `new()`（spawn 前）不改变任何可观察时序（首个 await 仍是
/// `run()` 内的 inbox 获取）。
// flush 环境上下文（#335/U1b 收敛面）：字段清单唯一处（原多调用点手抄的去重
// 靠本宏）。以宏而非 `&self` 方法装配是刻意的——方法接收者会把借用覆盖到整个
// self，与 draft 路径（#155 T3）的 `&mut self.draft_run` 无法并存；宏展开成
// 字段级表达式，8 个字段引用与 draft_run/pending_batch 天然不相交，同一函数
// 体内可并列借用。
macro_rules! pump_flush_context {
    ($self:expr) => {
        CanonicalFlushContext {
            window: &$self.window,
            gateway: &$self.gateway,
            update_channels: &$self.runtime.update_channels,
            reactions: $self.reactions.as_ref(),
            client_generation: &$self.client_generation,
            agent_id: &$self.agent_id,
            event_service: $self.event_service.as_ref(),
            message_service: $self.message_service.as_ref(),
        }
    };
}

struct NotificationPump<R: tauri::Runtime> {
    acp: Arc<AcpLock>,
    sessions: Arc<std::sync::Mutex<std::collections::HashMap<String, SessionInfo>>>,
    binding_health: Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, crate::agent::runtime::SessionBindingHealth>,
        >,
    >,
    /// 产品反应订阅缝（#416 W2 步骤③）：宿主装配的 pet sink；泵只持 trait
    /// 对象，不再点名 pet 状态（装配点见 `NotificationPump::new`）。
    reactions: Arc<dyn KernelReactionSink>,
    /// 本 dispatcher 代际（构造时刻快照；每轮循环与 client_generation 复核）。
    generation: u64,
    client_generation: Arc<std::sync::atomic::AtomicU64>,
    agent_id: String,
    agents: Arc<std::sync::Mutex<std::collections::HashMap<String, crate::agent_config::AgentDef>>>,
    runtimes: Arc<crate::runtime::AgentRuntimeManager>,
    gateway: Arc<crate::gateway::GatewayCore>,
    approval_mode: Arc<std::sync::Mutex<String>>,
    event_service: Option<Arc<crate::session::EventService>>,
    message_service: Option<Arc<crate::session::MessageService>>,
    hook_bridge: Arc<crate::hook_bridge::HookBridge>,
    terminal_registry: Arc<crate::acp::terminal_runtime::TerminalRegistry>,
    host_tools_policy: Arc<std::sync::Mutex<crate::acp::host_tools::HostToolsPolicy>>,
    /// 本泵所属 runtime（重连/update_channels/mapping_ready/账本等 per-agent 状态入口）。
    runtime: Arc<AgentRuntime>,
    window: tauri::Window<R>,
    handle_crash: CrashReconnectHandler<R>,
    /// 任务启动时从 acp 一次性捕获（需 async 锁，`run()` 开头赋值；时序与
    /// 原任务内获取一致——inbox/crashed_receiver 之后、进循环之前）。
    wire_trace: Option<Arc<crate::acp::AcpWireCapture>>,
    /// 在途 canonical 批次（窗口未 flush 的 durable+publish 待办）。
    pending_batch: Vec<PendingCanonicalPublish>,
    /// #155 T3：prompt 终态屏障请求接收端（`install_draft_flush_channel` 装配，
    /// 本代际 dispatcher 独占；重新 install 会替换发送端，旧接收端随之作废）。
    draft_flush_rx: tokio::sync::mpsc::UnboundedReceiver<crate::runtime::DraftFlushRequest>,
    /// #155 T3：在途跨窗口 draft run（None = 当前无聚合中的助手消息）。
    draft_run: Option<DraftRun>,
}

impl<R: tauri::Runtime> NotificationPump<R> {
    /// 原主循环前置克隆段（O8 复位之后的句柄准备）原样收敛：字段逐一对应原
    /// 局部变量；agent_id 解析、CrashReconnectHandler 装配原样保留。
    fn new(
        handles: &AppStateHandles,
        runtime: &Arc<AgentRuntime>,
        window: tauri::Window<R>,
    ) -> Self {
        let acp = runtime.acp.clone();
        let sessions = runtime.sessions.clone();
        let binding_health = runtime.binding_health.clone();
        let pet = handles.pet.clone();
        // #416 W2 步骤③：宿主装配——pet 状态包成 KernelReactionSink 唯一实现；
        // 泵/崩溃处理器/handle_session_update 全走 trait 对象（kernel 不点名 pet）。
        let reactions: Arc<dyn KernelReactionSink> = Arc::new(PetReactionSink::new(pet.clone()));
        let generation = runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire);
        let client_generation = runtime.client_generation.clone();
        let agents = handles.agents.clone();
        let active_agent = handles.active_agent.clone();
        let agent_runtime = runtime.agent_runtime.clone();
        let runtime_logs = handles.runtime_logs.clone();
        let runtimes = handles.runtimes.clone();
        let gateway = handles.gateway.clone();
        let approval_mode = handles.approval_mode.clone();
        let approval_mode_persisted = handles.approval_mode_persisted.clone();
        let event_service_slot = handles.event_service.clone();
        let event_service = event_service_slot.lock().ok().and_then(|slot| slot.clone());
        let message_service_slot = handles.message_service.clone();
        let message_service = handles
            .message_service
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        let hook_bridge = handles.hook_bridge.clone();
        let terminal_registry = runtime.terminal_registry.clone();
        let host_tools_policy = runtime.host_tools_policy.clone();
        let agent_id = handles
            .runtimes
            .all_with_ids()
            .into_iter()
            .find(|(_, candidate)| Arc::ptr_eq(candidate, runtime))
            .map(|(id, _)| id)
            .unwrap_or_else(|| "unknown".to_string());
        // P1-3（R2-WI03）：provider 不再启动时捕获——每次 PermissionRequest 从活配置解析
        // （见主循环对应分支），reload 修改实例 provider 后新请求即用新 provider。
        let runtime_for_reconnect = runtime.clone();
        // R7：自动重连状态组（reconnect_epoch / remaining_attempts / pending_reconnect）。
        // - reconnect_epoch：本 dispatcher 实例（=本 runtime 代际）的崩溃通知计数，
        //   每次 handle 通知 +1（含被防重入标志吸收的重复/新一轮通知——被吸收
        //   的通知以 epoch 变化表达"重连意图待消费"，不再被静默吞掉）。
        // - remaining_attempts：重连循环内的局部尝试计数（预算），epoch 变化时重置。
        // - pending_reconnect 概念：epoch 变化即"新一轮崩溃在重连循环期间到来"——
        //   重连循环每轮复查 epoch 未变；变了则旧循环放弃（消费旧 ticket），以最新
        //   epoch 重新武装（退避从 attempt 1 重新开始）。A5 的"成功分支复查"窄窗口
        //   由此结构性覆盖（不再依赖单一复查点）。
        let reconnect_epoch = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        // A7：崩溃处理提取为 CrashReconnectHandler（#317 批次二 ④，原内联闭包），
        // broadcast 分支与 watch 分支共用。幂等设计：auto_reconnect_active 防重入，
        // 双通道都送达时最多多发一次同 payload 状态事件。
        // ISSUE-17 W1（LR2-WI06）：handle 接收 crash reason（稳定 code，transport.rs
        // CrashReason::as_str）——不再硬编码 stdout closed；用户可读文案保留原始 code
        // （不覆盖诊断字段）。
        let handle_crash = CrashReconnectHandler::new(
            AppStateHandles {
                runtimes: runtimes.clone(),
                agents: agents.clone(),
                active_agent,
                pet,
                runtime_logs,
                gateway: gateway.clone(),
                approval_mode: approval_mode.clone(),
                approval_mode_persisted,
                event_service: event_service_slot,
                message_service: message_service_slot,
                hook_bridge: hook_bridge.clone(),
            },
            agent_runtime,
            window.clone(),
            runtime_for_reconnect,
            reconnect_epoch,
            reactions.clone(),
        );
        // #155 T3：prompt 终态写路径经本通道请求 dispatcher 先收口在途 draft
        // 再分配终态序列。装配时点与拆分前一致（任务复位后、spawn 前）。
        let draft_flush_rx = runtime.install_draft_flush_channel(generation);
        Self {
            acp,
            sessions,
            binding_health,
            reactions,
            generation,
            client_generation,
            agent_id,
            agents,
            runtimes,
            gateway,
            approval_mode,
            event_service,
            message_service,
            hook_bridge,
            terminal_registry,
            host_tools_policy,
            runtime: runtime.clone(),
            window,
            handle_crash,
            wire_trace: None,
            pending_batch: Vec::new(),
            draft_flush_rx,
            draft_run: None,
        }
    }

    /// 主循环骨架（#336/U2b）：代际复核 → 泵取一帧 → 代际复核 → 路由分支；
    /// 循环后为退出统一收口（兜底 flush + 账本代际清理）。
    async fn run(mut self) {
        // #549：装配三连取收进一次快照（同一代连接的一致视图）。
        let client = acp_snapshot(&self.acp);
        // #548：inbox 一次性移交——泵是每代连接的唯一生产消费者；取到 None =
        // 同一代被装配了第二个泵（编程错误），fail-fast 退出并留诊断日志。
        let Some(mut notification_inbox) = client.take_notification_inbox() else {
            tracing::error!(
                agent_id = %self.agent_id,
                generation = self.generation,
                "notification inbox already taken: pump double-spawned for one connection generation"
            );
            return;
        };
        // A7：崩溃信号独立 watch 通道——broadcast 洪泛 Lagged 时 NOTIF_AGENT_CRASHED
        // 会丢，自动重连依赖本通道（主循环 select! 双路监听，见下）。
        let mut crashed_rx = client.crashed_receiver();
        // 订阅即查现值：崩溃发生在订阅之前（connect 成功后立刻 EOF、dispatcher
        // 尚未启动）时 changed() 不会触发，只能靠 watch 保留的最新值兜底。
        if *crashed_rx.borrow_and_update() {
            // watch 通道只携带 bool 不携带 reason → 缺省 stdout_closed（订阅前 EOF 场景）
            self.handle_crash
                .handle(crate::acp::CrashReason::StdoutClosed.as_str().to_string())
                .await;
        }
        self.wire_trace = client.wire_trace();
        // #155 T3：draft 片段持久化节流时钟——interval 需要 tokio 定时器上下文，
        // 在 run()（async）内构造而非 new()（spawn 前同步装配）；首次 tick 立即
        // 消费，与拆分前任务体内的构造时序一致。
        let mut draft_interval = tokio::time::interval(DRAFT_PERSIST_INTERVAL);
        draft_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        draft_interval.tick().await;
        loop {
            if self.client_generation.load(Ordering::Acquire) != self.generation {
                // #99：代际失配退出（清理统一在循环结束后收口，评审 E6）。
                break;
            }
            match self
                .pump_step(
                    &mut notification_inbox,
                    &mut crashed_rx,
                    &mut draft_interval,
                )
                .await
            {
                PumpStep::Frame(classified) => {
                    let crate::acp::ClassifiedMessage {
                        raw,
                        classification,
                        wire_ordinal,
                        ingress_seq,
                    } = classified;
                    if self.client_generation.load(Ordering::Acquire) != self.generation {
                        break;
                    }
                    // 路由分支链：false = 主循环退出（flush 失败 / 代际结束）。
                    if !self
                        .route_frame(raw, classification, wire_ordinal, ingress_seq)
                        .await
                    {
                        break;
                    }
                }
                PumpStep::Skipped => continue,
                PumpStep::Stop => break,
            }
            if self.draft_run.is_some() && !self.pending_batch.is_empty() {
                // 在途 run 的下一帧立即判同质/预算；非 delta 与 owner 切换不可等 8 ms。
                let batch = std::mem::take(&mut self.pending_batch);
                if !absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await {
                    break;
                }
            }
            if self.draft_run.is_none() && self.pending_batch.len() == 1 {
                // 首个可折 delta 立即占位，关上外部 evt_append 的到达顺序竞态。
                let first = &self.pending_batch[0];
                if first
                    .input
                    .owner
                    .as_ref()
                    .and_then(|owner| {
                        crate::session::draft_candidate(owner, first.input.payload.clone())
                    })
                    .is_some()
                {
                    let batch = std::mem::take(&mut self.pending_batch);
                    if !absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await
                    {
                        break;
                    }
                }
            }
        }
        if !self.pending_batch.is_empty() {
            let batch = std::mem::take(&mut self.pending_batch);
            let _ = absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await;
        }
        // 无终态退出时保留可恢复的片段，不把残缺消息冒充正式历史。
        let _ = publish_due_draft(&pump_flush_context!(self), &mut self.draft_run).await;
        // #99（评审 E6）：dispatcher 退出统一收口——循环后的单点清理覆盖全部
        // break 路径（代际失配 / inbox 关闭 / handle_session_update false）。
        // 旧代际 turn 条目整体收敛；此后旧代际的迟到结算归 UnknownTurn
        // （可观测，且永远无法改写新代际状态）。
        let dropped = self.runtime.turn_ledger.drop_generation(self.generation);
        if dropped > 0 {
            tracing::info!(
                dropped,
                generation = self.generation,
                "stale-generation turn entries dropped by turn ledger"
            );
        }
    }

    /// 泵取一步（#336/U2b 迁入主干 + #155 T3 两个 draft 臂）：biased 优先级 =
    /// 崩溃 watch > 控制帧（agent 请求/崩溃广播）> 普通通知 > prompt 终态 draft
    /// 收口请求 > 窗口 flush 定时（仅在途批次非空时参与竞争）> draft 片段节流
    /// 时钟（仅在途 run 存在时参与竞争）；每帧携带 ingress_seq，优先级不改变
    /// 同一连接的序列语义。
    async fn pump_step(
        &mut self,
        inbox: &mut crate::acp::NotificationInbox,
        crashed_rx: &mut tokio::sync::watch::Receiver<bool>,
        draft_interval: &mut tokio::time::Interval,
    ) -> PumpStep {
        tokio::select! {
            biased;
            changed = crashed_rx.changed() => {
                if changed.is_ok() && *crashed_rx.borrow_and_update() {
                    // #155 T3：崩溃信号先收口在途 draft（未消费批次吸收 + 已落盘
                    // 片段发布，保留为可恢复中断片段），再处理崩溃/重连。
                    if !self.pending_batch.is_empty() {
                        let batch = std::mem::take(&mut self.pending_batch);
                        if !absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await
                        {
                            return PumpStep::Stop;
                        }
                    }
                    if !publish_due_draft(&pump_flush_context!(self), &mut self.draft_run).await {
                        return PumpStep::Stop;
                    }
                    // watch 通道只携带 bool → 缺省 stdout_closed（reason 经 broadcast params 携带）
                    self.handle_crash
                        .handle(crate::acp::CrashReason::StdoutClosed.as_str().to_string())
                        .await;
                }
                PumpStep::Skipped
            }
            // #548：biased 优先级下沉进 `recv_biased`（控制帧 > 普通通知，
            // 任一 lane 关闭即 Stop——与旧双分支语义逐点一致）。
            raw = inbox.recv_biased() => match raw {
                Some(classified) => PumpStep::Frame(classified),
                None => PumpStep::Stop,
            },
            // Lower priority than queued ACP updates: the response task
            // must not overtake delta notifications preceding its response.
            request = self.draft_flush_rx.recv() => {
                if let Some(request) = request {
                    tracing::debug!(source = %request.source, "closing canonical draft before prompt terminal");
                    if !self.pending_batch.is_empty() {
                        let batch = std::mem::take(&mut self.pending_batch);
                        if !absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await
                        {
                            let _ = request.reply.send(Err("draft window flush failed".into()));
                            return PumpStep::Stop;
                        }
                    }
                    if !commit_open_draft(&pump_flush_context!(self), &mut self.draft_run).await {
                        let _ = request.reply.send(Err("draft commit failed".into()));
                        return PumpStep::Stop;
                    }
                    let _ = request.reply.send(Ok(()));
                }
                PumpStep::Skipped
            }
            _ = tokio::time::sleep(PENDING_CANONICAL_FLUSH_INTERVAL), if !self.pending_batch.is_empty() => {
                let batch = std::mem::take(&mut self.pending_batch);
                if !absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await {
                    PumpStep::Stop
                } else {
                    PumpStep::Skipped
                }
            }
            _ = draft_interval.tick(), if self.draft_run.is_some() => {
                if !self.pending_batch.is_empty() {
                    let batch = std::mem::take(&mut self.pending_batch);
                    if !absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await {
                        return PumpStep::Stop;
                    }
                }
                if !publish_due_draft(&pump_flush_context!(self), &mut self.draft_run).await {
                    return PumpStep::Stop;
                }
                PumpStep::Skipped
            }
        }
    }

    /// 路由分支链（原主循环体内联分支逐一迁入，次序不变）：ProviderExtension
    /// 包络 → 窗口 flush 判定 → 崩溃 / elicitation 完成 / 权限请求 / terminal /
    /// fs / 私有交互 / 未知通知 / session/update 内核路径 → 终态边界补 flush。
    /// 每分支副作用完成后返回 true（继续下一帧）；返回 false = 主循环退出，
    /// 共出自本函数内 **4 处**：① 预 flush `absorb_window` 失败；② Crashed
    /// 分支 `publish_due_draft` 失败；③ `handle_session_update` 返回 false
    /// （mutation 后本代结束/锁异常等该函数自身的退出判定，见其文档）；
    /// ④ 终态边界补 flush `absorb_window` 失败。循环内定时 flush（8ms 窗口 /
    /// draft 片段节流 / prompt 终态收口）的失败不经本函数，由 `pump_step`
    /// 以 `PumpStep::Stop` 表达。
    async fn route_frame(
        &mut self,
        mut raw: crate::acp::RawMessage,
        classification: crate::acp::ReplayClassification,
        wire_ordinal: Option<u64>,
        ingress_seq: u64,
    ) -> bool {
        // #315：provider 私有扩展通知（peri/agent_event 等）就地包络为
        // session/update 形状——载荷字段原样保留，只补通道判别符；此后与本
        // 批窗口内的标准 update 完全同质（durable canonical + publish 共用
        // 通路，routing 对未知 sessionUpdate 变体照常 publish/persist）。
        if !wrap_provider_extension_frame(&mut raw) {
            return true;
        }
        let flush_batch = should_flush_batch(
            &self.pending_batch,
            &raw,
            &classification,
            &self.sessions,
            self.generation,
            &self.agent_id,
        );
        if flush_batch && !self.pending_batch.is_empty() {
            let batch = std::mem::take(&mut self.pending_batch);
            if !absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await {
                return false;
            }
        }
        if raw.kind == crate::acp::AcpKind::Crashed {
            // #155 T3：崩溃收尾先把已落盘的在途片段发布出来（保留为可恢复中断
            // 片段，不冒充正式历史），再走崩溃/重连处理。
            if !publish_due_draft(&pump_flush_context!(self), &mut self.draft_run).await {
                return false;
            }
            // ISSUE-17 W1：broadcast 携带 reason（params.reason，稳定 code）——
            // dispatcher 保留原始 code 生成用户可读文案；缺省 stdout_closed
            let reason = crash_reason_from_params(raw.params.as_ref());
            self.handle_crash.handle(reason).await;
            return true;
        }
        if raw.kind == crate::acp::AcpKind::ElicitationComplete {
            // #316：elicitation/complete —— URL 模式外带交互完成通知（form 模式
            // 同步应答不产生本通知）。官方契约：客户端忽略未知/已完成 id。
            // 收敛匹配中的 pending elicitation 卡（URL 模式 UI 本期不做）。
            route_elicitation_complete(
                &self.window,
                &self.runtimes,
                &self.agent_id,
                raw.params.as_ref(),
            )
            .await;
            return true;
        }
        if raw.kind == crate::acp::AcpKind::PermissionRequest {
            // B9 权限审批：agent 主动 request_permission（带 id 请求，客户端必须应答）。
            // ACP-01：id 为原始 variant（number/string）——string-id agent 请求不再丢弃。
            route_permission_request(
                &self.window,
                &self.acp,
                &self.client_generation,
                &self.approval_mode,
                &self.sessions,
                &self.hook_bridge,
                &self.runtimes,
                &self.agents,
                &self.agent_id,
                raw,
            )
            .await;
            return true;
        }
        if matches!(
            raw.method.as_deref(),
            Some("terminal/create")
                | Some("terminal/output")
                | Some("terminal/wait_for_exit")
                | Some("terminal/waitForExit")
                | Some("terminal/kill")
                | Some("terminal/release")
        ) {
            route_terminal_request(
                &self.acp,
                &self.terminal_registry,
                &self.host_tools_policy,
                raw,
            )
            .await;
            return true;
        }
        if matches!(
            raw.method.as_deref(),
            Some("fs/read_text_file") | Some("fs/write_text_file")
        ) {
            route_fs_request(
                &self.acp,
                &self.host_tools_policy,
                &self.sessions,
                self.generation,
                raw,
            )
            .await;
            return true;
        }
        // Providers may expose a new approval/question/oauth method before a
        // dedicated AcpKind/adapter exists.  Do not silently drop an identified
        // request: answer it with Method Not Found and surface a diagnostic event.
        if crate::protocol_adapter::looks_like_interaction_method(raw.method.as_deref()) {
            route_private_interaction(
                &self.window,
                &self.acp,
                &self.agents,
                &self.runtimes,
                &self.agent_id,
                self.generation,
                raw,
            )
            .await;
            return true;
        }
        if raw.kind != crate::acp::AcpKind::SessionUpdate {
            route_unknown_notification(&self.acp, &raw).await;
            return true;
        }
        let payload = match raw.params {
            Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
            _ => {
                tracing::warn!("ACP session/update missing object params");
                return true;
            }
        };
        let terminal_boundary = payload
            .get("update")
            .and_then(|update| update.get("sessionUpdate"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|kind| matches!(kind, "done" | "error" | "cancelled"));
        if !handle_session_update(
            &self.window,
            &self.gateway,
            &self.sessions,
            &self.binding_health,
            self.reactions.as_ref(),
            &self.runtime.update_channels,
            &self.client_generation,
            self.generation,
            &self.runtime.mapping_ready,
            &self.agent_id,
            self.event_service.as_ref(),
            self.message_service.as_ref(),
            classification,
            wire_ordinal,
            &self.runtime.turn_ledger,
            &self.runtime.probe_sessions,
            ingress_seq,
            self.wire_trace.clone(),
            Some(&mut self.pending_batch),
            payload,
        )
        .await
        {
            return false;
        }
        if terminal_boundary && !self.pending_batch.is_empty() {
            let batch = std::mem::take(&mut self.pending_batch);
            if !absorb_window(&pump_flush_context!(self), &mut self.draft_run, batch).await {
                return false;
            }
        }
        true
    }
}

/// #315：provider 私有扩展通知就地包络（原主循环内联分支抽出）。载荷字段原样
/// 保留，只补通道判别符，包络为 session/update 形状；返回 false = 缺 object
/// params/sessionId（帧丢弃，仅告警）。
fn wrap_provider_extension_frame(raw: &mut crate::acp::RawMessage) -> bool {
    if raw.kind != crate::acp::AcpKind::ProviderExtension {
        return true;
    }
    let method = raw.method.clone().unwrap_or_default();
    match crate::acp::wrap_provider_extension_notification(&method, raw.params.take()) {
        Some(wrapped) => {
            tracing::debug!("provider 扩展通知 {} 已包络为 session/update", method);
            raw.kind = crate::acp::AcpKind::SessionUpdate;
            raw.params = Some(wrapped);
            true
        }
        None => {
            tracing::warn!(
                "provider 扩展通知 {} 缺 object params/sessionId，丢弃",
                method
            );
            false
        }
    }
}

/// Crashed 帧的 reason 提取（ISSUE-17 W1）：broadcast 携带 reason（params.reason，
/// 稳定 code）；缺省 stdout_closed。
fn crash_reason_from_params(params: Option<&serde_json::Value>) -> String {
    params
        .and_then(|p| p.get("reason"))
        .and_then(|v| v.as_str())
        .unwrap_or(crate::acp::CrashReason::StdoutClosed.as_str())
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use reactions::{apply_pet_event, apply_update_event};
    use tracing_subscriber::layer::Layer as _;

    #[test]
    fn deleted_session_ingest_failure_is_not_logged_as_user_error() {
        // The tombstone gate remains authoritative; only the presentation of
        // its expected late-write rejection changes from error to debug.
        let logs = crate::runtime_log::RuntimeLogHub::new(16);
        let dispatch = tracing::Dispatch::new(
            crate::runtime_log::RuntimeLogLayer::with_hub(logs.clone()).with_subscriber(
                tracing_subscriber::fmt()
                    .with_max_level(tracing::Level::TRACE)
                    .finish(),
            ),
        );
        let _guard = tracing::dispatcher::set_default(&dispatch);

        log_canonical_ingest_error(
            &crate::session::EventError::SessionDeleted("owner tombstone".to_string()),
            "agent",
            "local:session",
        );
        log_canonical_ingest_error(
            &crate::session::EventError::Unavailable("database unavailable".to_string()),
            "agent",
            "local:session",
        );

        let entries = logs.list(&crate::runtime_log::RuntimeLogQuery::default());
        assert!(
            entries.iter().all(|entry| !entry
                .message
                .contains("late ACP update ignored for deleted session")),
            "deleted-session race must stay below the runtime-log visibility threshold"
        );
        assert!(
            entries.iter().any(|entry| {
                entry.level == "error"
                    && entry
                        .message
                        .contains("canonical ingest failed; event was not published")
            }),
            "non-tombstone ingest failures must remain visible at error level"
        );
    }

    /// 验收回归 D3：replay 的 user 消息 persona 前缀剥离（基于分隔符）。
    #[test]
    fn strip_persona_prefix_removes_separator_prefix() {
        let persona = "你是测试 Agent，用于验收 persona 前缀剥离。";
        let text = format!("{persona}\n\n---\n\n你好");
        assert_eq!(strip_persona_prefix(&text, persona), "你好");
    }

    #[test]
    fn strip_persona_prefix_works_for_session_prompt_too() {
        // session_prompt 场景：persona 不匹配 session_prompt，但分隔符剥离不依赖 persona
        let persona = "profile persona";
        let session_prompt = "自定义会话提示";
        let text = format!("{session_prompt}\n\n---\n\n你好");
        assert_eq!(strip_persona_prefix(&text, persona), "你好");
    }

    #[test]
    fn strip_persona_prefix_keeps_non_prefixed_text() {
        // 后续轮次消息无前缀（无分隔符）→ 原样返回
        assert_eq!(strip_persona_prefix("你好", "persona"), "你好");
        // persona 为空也剥离分隔符（分隔符才是依据）
        assert_eq!(strip_persona_prefix("p\n\n---\n\n你好", ""), "你好");
    }

    #[test]
    fn strip_persona_prefix_keeps_text_with_trailing_separator() {
        // 分隔符后为空 → 原样返回（防误剥成空串）
        assert_eq!(
            strip_persona_prefix("persona\n\n---\n\n", "persona"),
            "persona\n\n---\n\n"
        );
    }

    /// A3 验收：source 已注册通道 → update 帧走 Channel（信封格式），不落广播。
    /// 用 Arc<Mutex<Vec>> 捕获 send 闭包收到的帧序。
    #[tokio::test]
    async fn dispatcher_channel_receives_update_frames() {
        let runtime = crate::test_utils::connected_runtime();
        let sent: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = sent;
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        runtime.register_update_channel("local:s1", channel);
        assert!(runtime
            .update_channels
            .lock()
            .unwrap()
            .contains_key("local:s1"));

        // 注册表语义：take 后不再持有（终帧注销路径依赖）。
        assert!(runtime.take_update_channel("local:s1").is_some());
        assert!(!runtime
            .update_channels
            .lock()
            .unwrap()
            .contains_key("local:s1"));

        // clear 语义（C7/generation bump 清理）。
        runtime.register_update_channel("local:s1", tauri::ipc::Channel::new(|_| Ok(())));
        runtime.register_update_channel("local:s2", tauri::ipc::Channel::new(|_| Ok(())));
        runtime.clear_update_channels();
        assert!(runtime.update_channels.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn pending_batch_commits_rows_before_ordered_channel_publish() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window");
        let frames: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = frames.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        let update_channels = crate::runtime::UpdateChannelMap::new(
            std::collections::HashMap::from([("local:s1".to_string(), channel)]),
        );
        let gateway = crate::gateway::GatewayCore::new();
        let event_service = Arc::new(crate::session::EventService::in_memory().expect("events"));
        let owner = DurableSessionOwner::new("profile", "agent", "local:s1");
        let wire = crate::acp::AcpWireHub::new(
            crate::correlation::RuntimeCorrelation {
                agent_id: "agent".to_string(),
                provider: None,
                source: "local:s1".to_string(),
                local_session_id: Some("local:s1".to_string()),
                remote_session_id: Some("peri-s1".to_string()),
                peri_id: Some("peri-s1".to_string()),
                client_generation: 1,
                request_id: None,
                tool_call_id: None,
            },
            16,
        );
        let decision = routing::RoutingDecision {
            class: routing::RoutingClass::Live,
            variant: Some(crate::acp::SessionUpdateVariant::AgentMessageChunk),
            mutate_session: true,
            collect_response: true,
            persist_canonical: true,
            publish: true,
        };
        let pending = (1_u64..=3)
            .map(|ordinal| PendingCanonicalPublish {
                input: routing::RoutingInput {
                    source: "local:s1".to_string(),
                    remote_session_id: "peri-s1".to_string(),
                    generation: 1,
                    owner: Some(owner.clone()),
                    classification: crate::acp::ReplayClassification::Live,
                    variant: Some(crate::acp::SessionUpdateVariant::AgentMessageChunk),
                    replay_loading: false,
                    payload: std::sync::Arc::new(serde_json::json!({
                        "sessionId": "peri-s1",
                        "update": {
                            "sessionUpdate": if ordinal == 3 {"done"} else {"agent_message_chunk"},
                            "content": {"text": if ordinal == 1 {"a"} else {"b"}}
                        }
                    })),
                    wire_ordinal: Some(ordinal),
                },
                decision,
                pet_events: if ordinal == 1 {
                    vec![PetEvent::FirstChunk]
                } else {
                    Vec::new()
                },
                session_state_to_persist: None,
                wire: Some(wire.clone()),
            })
            .collect();
        // #335/U1b：上下文结构体化后，测试侧的临时值需具名绑定（结构体字段
        // 借用不能指向语句级临时）。#416 W2：flush 上下文的 pet 字段改为
        // 订阅缝 sink（装配与生产路径同形：PetReactionSink 包 pet 状态）。
        let flush_reactions = PetReactionSink::new(std::sync::Arc::new(std::sync::Mutex::new(
            crate::pet::PetState::default(),
        )));
        let flush_generation = AtomicU64::new(1);
        let flush_window = window.as_ref().window();
        let flush_context = CanonicalFlushContext {
            window: &flush_window,
            gateway: &gateway,
            update_channels: &update_channels,
            reactions: &flush_reactions,
            client_generation: &flush_generation,
            agent_id: "agent",
            event_service: Some(&event_service),
            message_service: None,
        };
        assert!(flush_pending_canonical(&flush_context, pending).await);
        assert_eq!(
            event_service.revision(owner.key().unwrap()).await.unwrap(),
            4
        );
        let frames = frames.lock().unwrap().clone();
        assert_eq!(
            frames.len(),
            3,
            "每个输入帧仍然各发一条（配对按跨度展开，不合并发布）"
        );
        // ADR-0016：前两条是相邻同类 delta，写侧折成**一行**（span [1,2]，行落在跨度末位）。
        // 两条 wire 帧的 durable 事实都是这一行 ⇒ canonicalEvent.sequence 都是 2，相关性亦指向同一行。
        // 第三条终态行不受折叠影响（编号 3），单元在同事务占 4。
        assert_eq!(frames[0]["payload"]["canonicalEvent"]["sequence"], 2);
        assert_eq!(frames[1]["payload"]["canonicalEvent"]["sequence"], 2);
        assert_eq!(frames[2]["payload"]["canonicalEvent"]["sequence"], 3);
        assert_eq!(wire.correlate(1).unwrap().sequence, 2);
        assert_eq!(wire.correlate(2).unwrap().sequence, 2);
        assert_eq!(wire.correlate(3).unwrap().sequence, 3);
        assert_eq!(wire.correlate(1).unwrap().revision, 4);
    }

    /// C11：带 `_meta.periReplay=true` 的事件不产生宠物感知事件——pet xp/bond/
    /// recent_events 快照不变（回放不刷宠物状态）。覆盖 usage/tool 全部门控 +
    /// config_option（model/mode 感知，S2 补全）。对照：同事件不带回放标志 →
    /// 仍产出宠物事件（证明事件本身具备刷宠物状态的能力，守卫生效而非静默失效）。
    #[test]
    fn replay_updates_do_not_pollute_pet_state() {
        let snapshot = |state: &crate::pet::PetState| -> serde_json::Value {
            serde_json::json!({
                "xp": state.xp,
                "bond": state.bond,
                "recent_events": state.recent_events,
            })
        };
        let cases: Vec<(&str, serde_json::Value, crate::acp::SessionUpdateVariant)> = vec![
            (
                "usage_update",
                serde_json::json!({
                    "sessionUpdate": "usage_update",
                    "used": 12345,
                    "size": 32000,
                    "_meta": {"inputTokens": 9000, "outputTokens": 3345},
                }),
                crate::acp::SessionUpdateVariant::UsageUpdate,
            ),
            (
                "tool_call",
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "title": "write_file",
                    "rawInput": "{\"path\":\"a.rs\"}",
                }),
                crate::acp::SessionUpdateVariant::ToolCall,
            ),
            (
                "tool_call_update completed",
                serde_json::json!({"sessionUpdate": "tool_call_update", "status": "completed"}),
                crate::acp::SessionUpdateVariant::ToolCallUpdate,
            ),
            (
                "tool_call_update failed",
                serde_json::json!({"sessionUpdate": "tool_call_update", "status": "failed"}),
                crate::acp::SessionUpdateVariant::ToolCallUpdate,
            ),
            (
                "tool_call_update cancelled",
                serde_json::json!({"sessionUpdate": "tool_call_update", "status": "cancelled"}),
                crate::acp::SessionUpdateVariant::ToolCallUpdate,
            ),
            (
                "config_option model",
                serde_json::json!({
                    "sessionUpdate": "config_option",
                    "id": "model",
                    "currentValue": "deepseek-v4-flash",
                }),
                crate::acp::SessionUpdateVariant::ConfigOptionUpdate,
            ),
            (
                "config_option mode",
                serde_json::json!({
                    "sessionUpdate": "config_option",
                    "id": "mode",
                    "currentValue": "code",
                }),
                crate::acp::SessionUpdateVariant::ConfigOptionUpdate,
            ),
        ];
        for (label, update, variant) in cases {
            let mut session = crate::session::SessionInfo::new(
                "peri-c11".to_string(),
                String::new(),
                "cwd".to_string(),
                true,
                1,
            );
            let events = apply_update_event(&mut session, &update, Some(variant), true);
            assert!(
                events.is_empty(),
                "{label}: replay must not emit pet events, got {events:?}"
            );
            let mut pet = crate::pet::PetState::default();
            let before = snapshot(&pet);
            for event in events {
                apply_pet_event(&mut pet, event);
            }
            assert_eq!(
                before,
                snapshot(&pet),
                "{label}: replay must not change pet xp/bond/recent_events"
            );

            let mut live_session = crate::session::SessionInfo::new(
                "peri-c11".to_string(),
                String::new(),
                "cwd".to_string(),
                true,
                1,
            );
            let live_events = apply_update_event(&mut live_session, &update, Some(variant), false);
            assert!(
                !live_events.is_empty(),
                "{label}: live event must still emit pet events"
            );
        }
    }

    #[test]
    fn asynchronous_commands_and_mode_updates_refresh_session_state() {
        let mut session = crate::session::SessionInfo::new(
            "peri-async".to_string(),
            String::new(),
            "cwd".to_string(),
            true,
            1,
        );
        let commands = serde_json::json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [{"name": "compact", "description": "Compact context"}],
        });
        let events = apply_update_event(
            &mut session,
            &commands,
            Some(crate::acp::SessionUpdateVariant::AvailableCommandsUpdate),
            false,
        );
        assert!(
            events.is_empty(),
            "command advertisement is not a pet event"
        );
        assert_eq!(
            session.commands_snapshot.as_ref().unwrap()[0]["name"],
            serde_json::json!("compact")
        );

        let mode = serde_json::json!({
            "sessionUpdate": "current_mode_update",
            "currentModeId": "high",
        });
        let events = apply_update_event(
            &mut session,
            &mode,
            Some(crate::acp::SessionUpdateVariant::CurrentModeUpdate),
            false,
        );
        assert_eq!(session.mode.as_deref(), Some("high"));
        assert!(matches!(events.as_slice(), [PetEvent::ModeChanged(value)] if value == "high"));

        // Replay restores the same state but never emits pet side effects.
        let replay_commands = serde_json::json!({
            "sessionUpdate": "available_commands_update",
            "commands": [{"name": "reload"}],
        });
        let replay_events = apply_update_event(
            &mut session,
            &replay_commands,
            Some(crate::acp::SessionUpdateVariant::AvailableCommandsUpdate),
            true,
        );
        assert!(replay_events.is_empty());
        assert_eq!(
            session.commands_snapshot.as_ref().unwrap()[0]["name"],
            serde_json::json!("reload")
        );

        let replay_mode = serde_json::json!({
            "sessionUpdate": "current_mode_update",
            "modeId": "balanced",
        });
        let replay_mode_events = apply_update_event(
            &mut session,
            &replay_mode,
            Some(crate::acp::SessionUpdateVariant::CurrentModeUpdate),
            true,
        );
        assert!(replay_mode_events.is_empty());
        assert_eq!(session.mode.as_deref(), Some("balanced"));

        let mut restored = serde_json::json!({});
        let snapshot_only = session.clone();
        crate::session::restore_session_state(&snapshot_only, &mut restored);
        assert_eq!(
            restored["modes"]["currentModeId"],
            serde_json::json!("balanced")
        );
    }

    #[test]
    fn acp_reducer_is_updated_without_emitting_ui_side_effects() {
        let mut session = crate::session::SessionInfo::new(
            "peri-reducer".to_string(),
            String::new(),
            "cwd".to_string(),
            true,
            1,
        );
        let update = serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"text": "hello"}
        });
        let events = apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::AgentMessageChunk),
            false,
        );
        assert!(events.is_empty(), "text chunks do not create pet events");
        assert_eq!(
            session.acp_state.apply(&crate::acp::RawMessage {
                id: None,
                method: Some(crate::acp::NOTIF_SESSION_UPDATE.to_string()),
                kind: crate::acp::AcpKind::SessionUpdate,
                result: None,
                params: Some(serde_json::json!({"update": update})),
                error: None,
            }),
            vec![crate::acp::AcpStateDelta::Text {
                text: "hello".into()
            }]
        );

        let usage = serde_json::json!({
            "sessionUpdate": "usage_update",
            "used": 7,
            "size": 100,
            "_meta": {"inputTokens": 5, "outputTokens": 2},
        });
        let events = apply_update_event(
            &mut session,
            &usage,
            Some(crate::acp::SessionUpdateVariant::UsageUpdate),
            false,
        );
        assert!(matches!(events.as_slice(), [PetEvent::UsageUpdate(7)]));
        assert_eq!(session.acp_state.usage, Some((7, Some(100))));
        assert_eq!(session.acp_state.usage_input, Some(5));
        assert_eq!(session.acp_state.usage_output, Some(2));
        assert_eq!(session.tokens_total, 7);
        assert_eq!(session.context_size, 100);
        assert_eq!(session.tokens_in, 5);
        assert_eq!(session.tokens_out, 2);
    }

    // ── P56/D2：单值 config_option_update 键归一化 + session_info_update models 消费 ──

    fn dispatcher_session() -> crate::session::SessionInfo {
        crate::session::SessionInfo::new(
            "peri-p56".to_string(),
            String::new(),
            "cwd".to_string(),
            true,
            1,
        )
    }

    /// 验收 7：单值 config_option_update 以 `configId`（camelCase）推送 → 更新
    /// session.model；snake_case `config_id` 与归一化别名同效。
    #[test]
    fn config_option_update_reads_config_id_key_and_normalizes() {
        for key in ["configId", "config_id"] {
            let mut session = dispatcher_session();
            let update = serde_json::json!({
                "sessionUpdate": "config_option_update",
                key: "model",
                "currentValue": "nous:hermes-4",
            });
            let events = apply_update_event(
                &mut session,
                &update,
                Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
                false,
            );
            assert_eq!(session.model, "nous:hermes-4", "key {key} must be read");
            assert!(
                matches!(events.as_slice(), [PetEvent::ModelChanged(model)] if model == "nous:hermes-4"),
                "model change must stay a pet event"
            );
        }
        // 归一化：model_selection / MODEL 均精确命中 model 语义键。
        for key in ["model_selection", "MODEL"] {
            let mut session = dispatcher_session();
            let update = serde_json::json!({
                "sessionUpdate": "config_option_update",
                "configId": key,
                "currentValue": "m-1",
            });
            apply_update_event(
                &mut session,
                &update,
                Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
                false,
            );
            assert_eq!(session.model, "m-1", "normalized key {key} must match");
        }
        // 无语义键的 update 不误写 model。
        let mut session = dispatcher_session();
        session.model = "keep".to_string();
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configId": "reasoning_effort",
            "currentValue": "low",
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "keep");
    }

    /// P56/D2.3：session_info_update 带 models.currentModelId（camel/snake）→
    /// 更新 session.model（对齐 usage _meta.model 现状；hermes 未来推此通道即消费）。
    #[test]
    fn session_info_update_consumes_models_current_model() {
        for (wire, expected) in [
            (
                serde_json::json!({"currentModelId": "nous:hermes-4"}),
                "nous:hermes-4",
            ),
            (
                serde_json::json!({"current_model_id": "nous:hermes-3"}),
                "nous:hermes-3",
            ),
        ] {
            let mut session = dispatcher_session();
            let update = serde_json::json!({
                "sessionUpdate": "session_info_update",
                "models": wire,
            });
            apply_update_event(
                &mut session,
                &update,
                Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate),
                false,
            );
            assert_eq!(session.model, expected);
        }
        // 显示名-only 的 current 不得进入 typed 字段（machine-id-only）。
        let mut session = dispatcher_session();
        session.model = "keep".to_string();
        let update = serde_json::json!({
            "sessionUpdate": "session_info_update",
            "models": {"currentModelId": {"name": "Display Only"}},
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate),
            false,
        );
        assert_eq!(session.model, "keep");
    }

    /// #97/D97-3：session_info_update 的完整模型列表同步刷新 choices/current
    /// （验收 4），并清除客户端 requested 未确认态。
    #[test]
    fn session_info_update_refreshes_full_model_catalog_and_clears_pending() {
        let mut session = dispatcher_session();
        session.model = "m-old".to_string();
        session.model_pending = Some("m-old".to_string());
        let update = serde_json::json!({
            "sessionUpdate": "session_info_update",
            "models": {
                "currentModelId": "m-new",
                "availableModels": [{"modelId": "m-new", "name": "New"}, {"modelId": "m-legacy"}],
            },
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate),
            false,
        );
        assert_eq!(session.model, "m-new");
        assert_eq!(
            session.model_choices,
            vec!["m-new".to_string(), "m-legacy".to_string()]
        );
        assert_eq!(session.model_pending, None);
    }

    /// #97/D97-4：完全相同的 models push 重复两次只提交一次状态；丢弃计数留在
    /// 诊断字段，且不产生第二次 model 变更。
    #[test]
    fn duplicate_session_info_push_is_deduplicated_with_diagnostic_count() {
        let mut session = dispatcher_session();
        let update = serde_json::json!({
            "sessionUpdate": "session_info_update",
            "models": {
                "currentModelId": "m-new",
                "availableModels": [{"modelId": "m-new"}, {"modelId": "m-legacy"}],
            },
        });
        for _ in 0..2 {
            apply_update_event(
                &mut session,
                &update,
                Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate),
                false,
            );
        }
        assert_eq!(session.model, "m-new");
        assert_eq!(session.selector_duplicate_pushes, 1);
        assert_eq!(
            session.model_choices,
            vec!["m-new".to_string(), "m-legacy".to_string()]
        );
    }

    /// #97/D97-4：config_option_update 的超限 configOptions envelope 被拒绝入库，
    /// 已知 selector 状态保持不变。
    #[test]
    fn oversized_config_option_envelope_does_not_corrupt_session_catalog() {
        use crate::session::SELECTOR_ENVELOPE_MAX_BYTES;
        let mut session = dispatcher_session();
        let known = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{
                "id": "model-selection",
                "category": "model",
                "options": [{"valueId": "m-a"}],
                "currentValue": "m-a"
            }],
        });
        apply_update_event(
            &mut session,
            &known,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-a");
        let blob = "x".repeat(SELECTOR_ENVELOPE_MAX_BYTES + 1);
        let oversized = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{"id": "future-kind", "payload": blob}],
        });
        apply_update_event(
            &mut session,
            &oversized,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.selector_envelope_dropped, 1);
        assert_eq!(session.model, "m-a");
        assert_eq!(
            session.model_surface,
            crate::session::ModelSurface::ConfigOption {
                config_id: "model-selection".to_string()
            }
        );
    }

    /// #97/D97-7（评审补强）：config_option_update 全量数组同时含已知 model 选项与
    /// 未知 kind 时，已知 selector 照常刷新，未知 kind 不降级已知面。
    #[test]
    fn config_option_update_with_unknown_kind_preserves_known_selector() {
        let mut session = dispatcher_session();
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [
                {
                    "id": "model-selection",
                    "category": "model",
                    "options": [{"valueId": "m-b"}],
                    "currentValue": "m-b"
                },
                {"id": "future-kind", "payload": {"opaque": true}}
            ],
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-b");
        assert_eq!(
            session.model_surface,
            crate::session::ModelSurface::ConfigOption {
                config_id: "model-selection".to_string()
            }
        );
        assert_eq!(session.config_options.len(), 2, "未知 kind 原样保留");
    }

    /// #97/D97-3（评审补强）：usage _meta.model 是权威 current 通道——清除客户端
    /// requested 未确认态，与单值 config_option_update 分支同契约。
    #[test]
    fn usage_meta_model_clears_pending_state() {
        let mut session = dispatcher_session();
        session.model_pending = Some("m-old".to_string());
        let update = serde_json::json!({"_meta": {"model": "usage-channel-model"}});
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::UsageUpdate),
            false,
        );
        assert_eq!(session.model, "usage-channel-model");
        assert_eq!(session.model_pending, None);
    }

    /// #97/N1（第二轮评审回归）：config_option_update 全量数组携带可提取 model
    /// currentValue 时清除 pending（权威回显的 model 维度）；无 model 维度的数组
    /// 不构成确认，pending 保留——pending 生命周期在全量数组分支无漏口。
    #[test]
    fn config_option_update_full_array_clears_pending_only_with_model_dimension() {
        // 有 model 维度：current + pending 一致收敛，pending 清除。
        let mut session = dispatcher_session();
        session.model_pending = Some("m-stale".to_string());
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{
                "id": "model-selection",
                "category": "model",
                "options": [{"valueId": "m-b"}],
                "currentValue": "m-b"
            }],
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-b");
        assert_eq!(session.model_pending, None);

        // 无 model 维度（仅 reasoning 选项）：model 与 pending 均不动。
        let mut session = dispatcher_session();
        session.model = "m-keep".to_string();
        session.model_pending = Some("m-keep".to_string());
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{
                "id": "reasoning_effort",
                "category": "thought_level",
                "options": [{"valueId": "low"}, {"valueId": "high"}],
                "currentValue": "high"
            }],
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-keep");
        assert_eq!(session.model_pending.as_deref(), Some("m-keep"));
    }

    /// #97/N4（第二轮评审回归）：单值 config_option_update 的 model 值走
    /// machine-id-only 提取——显示名不得进入 session.model（与 models-state
    /// 通道同一不变量）；mode 通道保持宽容提取不受影响。
    #[test]
    fn single_value_model_push_is_machine_id_only() {
        let mut session = dispatcher_session();
        session.model = "m-keep".to_string();
        session.model_pending = Some("m-keep".to_string());
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configId": "model",
            "currentValue": {"name": "Display Only"},
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-keep", "显示名不得当 model id");
        assert_eq!(session.model_pending.as_deref(), Some("m-keep"));

        // machine id 照常消费。
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configId": "model",
            "currentValue": {"modelId": "m-real"},
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-real");
        assert_eq!(session.model_pending, None);
    }
}
