//! 会话过期域：过期判定与后台 expiry watcher。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。
//!
//! #363-4：**回收范围从「平台来源」推广到全部连接**。原实现的
//! `is_platform_source` 守卫让 GUI local（`local:<id>`）会话永不回收，注释写的是
//! 「GUI local 会话由前端/用户管理」——但被遗弃的 GUI 会话会一直挂着映射、prompt
//! 锁与 agent 侧会话状态。现在改成**按活跃信号豁免**（在途回合 / 在场交互 /
//! prompt 闸门 / prompt 锁），而不再按来源放行。
//!
//! 两条回收路径：
//!
//! | 对象 | 判据 | 动作 |
//! | --- | --- | --- |
//! | 会话 | 空闲超时 且 无活跃信号 | 删映射 + close ACP session（`remove_if_current_expired`）|
//! | 连接 | **零会话** 且闲置超时 且 无活跃信号 | `lifecycle::stop_agent_runtime`（杀子进程树）|
//!
//! 会话回收**不碰** journal 与前端 identity store（用户历史不丢，前端会话列表才是
//! 权威）；下次发消息走 `known_peri_id` → `session/load` 自愈。连接回收才真正释放
//! agent 子进程/文件句柄/内存——这是 issue 点名「一直挂着 agent 子进程」的落点。
//!
//! #490：**回收默认关闭**（[`DEFAULT_GUI_IDLE_TIMEOUT_SECS`] = `0`），显式 opt-in。
//! 维持 24 小时默认的核心论据——「GUI prompt 路径没有断线自动重连，回收之后用户要
//! 手动救」——已被 #379 推翻：会话回收只删映射，下次发送经 `known_peri_id` 自愈
//! （见上）；连接回收断掉的线，如今也由 `ensure_connected_for_send`（`session/mod.rs`）
//! 在发送/建会话前懒重建。自动回收由此失去必要性：默认让闲置会话与 agent 子进程
//! 常驻，「隔天回来继续用」是零成本路径；资源受限部署设 `PYLON_SESSION_IDLE_TIMEOUT_SECS`
//! 为正秒数即恢复本文件全部链路。零会话口径与 `platform_may_route_to` 保活守卫保留不动。

use super::*;

/// #363-4：GUI 本地（无 gateway binding）会话与连接的回收超时（秒）。
///
/// `0` 关闭本项；非法值回退默认。命名与语义对齐 Codeg `CODEG_ACP_IDLE_TIMEOUT_SECS`
/// （同样是「秒 + 0 关闭」）；#490 起默认值同为关闭（`0`），理由见
/// [`DEFAULT_GUI_IDLE_TIMEOUT_SECS`]。
pub(crate) const GUI_IDLE_TIMEOUT_ENV: &str = "PYLON_SESSION_IDLE_TIMEOUT_SECS";

/// #490：默认 `0`——**后台回收关闭**，回收是显式 opt-in。
///
/// 24 小时默认当年取「与无 binding 会话隐式默认（`idle_minutes` 缺省 1440 分钟）
/// 一致」的保守值，前提是 GUI 发送打到已回收的连接上是硬错误。#379 落地
/// `ensure_connected_for_send` 后该前提不再成立：连接被回收后首次发送会先懒重连
/// 再继续，「隔天回来继续用」不依赖后台回收。于是默认翻转——闲置会话与 agent 子进程常驻
/// （内存/句柄的常驻代价由用户显式承担），资源受限部署设正秒数换回自动释放。
/// 非法值回退本值同样落在「关闭」：opt-in 只认合法正数，笔误不会误启回收。
pub(crate) const DEFAULT_GUI_IDLE_TIMEOUT_SECS: u64 = 0;

/// 读 GUI 回收超时：env 覆盖 → 默认（#490 起即关闭）；`0` = 关闭（返回 `None`）。
fn gui_idle_timeout() -> Option<std::time::Duration> {
    gui_idle_timeout_from(std::env::var(GUI_IDLE_TIMEOUT_ENV).ok().as_deref())
}

/// [`gui_idle_timeout`] 的纯函数内核（可单测，不经进程 env）。
pub(crate) fn gui_idle_timeout_from(raw: Option<&str>) -> Option<std::time::Duration> {
    let seconds = match raw {
        Some(raw) => raw
            .trim()
            .parse::<u64>()
            .unwrap_or(DEFAULT_GUI_IDLE_TIMEOUT_SECS),
        None => DEFAULT_GUI_IDLE_TIMEOUT_SECS,
    };
    (seconds > 0).then(|| std::time::Duration::from_secs(seconds))
}

/// 空闲判据的毫秒形态（session_expired 的分钟口径是它的展示包装）。
fn idle_expired_reason(
    updated_at: Option<Timestamp>,
    now: Timestamp,
    idle_ms: u64,
) -> Option<String> {
    let updated = updated_at?;
    if now.elapsed_since(updated) > idle_ms {
        Some(format!("超过 {} 分钟无活动", (idle_ms / 60_000).max(1)))
    } else {
        None
    }
}

/// 统一的过期判定：`reset` 策略 + 空闲毫秒（空转口径的唯一实现）。
fn expired_reason(
    updated_at: Option<Timestamp>,
    now: Timestamp,
    reset: &str,
    idle_ms: u64,
) -> Option<String> {
    match reset {
        "off" => None,
        "daily" => match updated_at.map(Timestamp::day_number) {
            Some(updated_day) if updated_day != now.day_number() => Some("每日重置".to_string()),
            _ => None,
        },
        _ => idle_expired_reason(updated_at, now, idle_ms),
    }
}

/// 分钟口径的薄包装。生产只走 [`expired_reason`]（毫秒），本包装的消费者是既有
/// 单测（含 `session_info_tests`），所以按 `cfg(test)` 门控——否则非测试构建里它是
/// 死代码，会撞上 clippy「相对基线零新增」门禁。
#[cfg(test)]
pub(crate) fn session_expired(
    updated_at: Option<Timestamp>,
    now: Timestamp,
    reset: &str,
    idle_minutes: u64,
) -> Option<String> {
    expired_reason(updated_at, now, reset, idle_minutes.saturating_mul(60_000))
}

/// 一条会话的回收判定输入（快照；后续的删除复核仍在锁内重做，见 TOCTOU 纪律）。
/// #420：`turn_in_flight` 改由 turn_ledger.active 单源判定——采集闭包内就地
/// 查账本（账本是叶子锁：只做 HashMap 读写、不回调宿主、不取其他锁）。
struct SessionSnapshot {
    source: String,
    peri_id: String,
    updated_at: Option<Timestamp>,
    turn_in_flight: bool,
}

/// 交互队列里在场的条目所对应的 ACP session id 集合（settle 即出队，所以任何在场
/// 条目都是 Active 或 Waiting，没有终态残留）。
fn sessions_with_pending_interaction(runtime: &Arc<crate::runtime::AgentRuntime>) -> Vec<String> {
    runtime
        .ledger
        .queue()
        .snapshot()
        .map(|entries| entries.into_iter().map(|entry| entry.session_id).collect())
        .unwrap_or_default()
}

pub(crate) async fn check_session_expiry(state: &AppState) {
    check_session_expiry_with(state, gui_idle_timeout()).await
}

/// [`check_session_expiry`] 的超时可注入形态（测试直接喂值，避免改进程 env 的竞态）。
pub(crate) async fn check_session_expiry_with(
    state: &AppState,
    gui_timeout: Option<std::time::Duration>,
) {
    let now = Timestamp::now();
    for (agent_id, runtime) in state.runtimes.all_with_ids() {
        // 连接级活跃信号之一：per-runtime 的 prompt 闸门被占用（B3 §4.4：同一实例同一
        // 时刻至多一个 prompt），说明连接正忙——它的全部会话本轮都跳过。
        // `try_lock_owned` 不阻塞：拿不到就是「忙」，与 prompt.rs 的判定同形。
        let prompt_gate_held = runtime.prompt_gate.clone().try_lock_owned().is_err();
        // 连接级活跃信号之二：交互队列在场条目（等用户应答的权限/elicitation/提问卡）。
        let pending_interaction_sessions = sessions_with_pending_interaction(&runtime);
        let sessions: Vec<SessionSnapshot> = runtime
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .map(|(source, info)| SessionSnapshot {
                        source: source.clone(),
                        peri_id: info.peri_id.clone(),
                        updated_at: info.updated_at,
                        // #420：在途事实查账本 active 表（单源）。账本是叶子锁
                        // （内部只做 HashMap 读写、不回调宿主、不取其他锁），
                        // 在 sessions 锁内查询无锁序风险。
                        // #707-C：在途事实读经账本门（crate::session::turn_in_flight）。
                        turn_in_flight: crate::session::turn_in_flight(
                            &runtime,
                            source,
                            &info.peri_id,
                            info.generation,
                        ),
                    })
                    .collect()
            })
            .unwrap_or_default();
        for snapshot in sessions {
            let SessionSnapshot {
                source,
                peri_id,
                updated_at,
                turn_in_flight,
            } = snapshot;
            // 策略：平台来源走 gateway binding（reset/idle_minutes），GUI local 走
            // 全局可配的超时。两者都可能给出「不回收」。
            let (reset, idle_ms) = if state.gateway.is_platform_source(&source) {
                let binding = state.gateway.binding(&source);
                let reset = binding
                    .as_ref()
                    .and_then(|b| b.reset.clone())
                    .unwrap_or_else(|| "idle".to_string());
                let idle_minutes = binding
                    .as_ref()
                    .and_then(|b| b.idle_minutes)
                    .unwrap_or(1440);
                (reset, idle_minutes.saturating_mul(60_000))
            } else {
                let Some(timeout) = gui_timeout else {
                    continue;
                };
                (
                    "idle".to_string(),
                    u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
                )
            };
            // #363-4：活跃信号豁免（取代原来的「非平台来源一律跳过」）。
            if prompt_gate_held || turn_in_flight {
                continue;
            }
            if pending_interaction_sessions.contains(&peri_id) {
                continue;
            }
            // 活跃豁免：生成中（prompt 锁被占用）永不视为过期
            // I17 W3（LR2-WI07）：锁中毒 fail-closed——prompt_locks 无法读取时保守视为
            // 「生成中」跳过过期判定（不得清理可能仍在生成的会话），并输出显式诊断。
            let generating = match runtime.prompt_locks.lock() {
                Ok(locks) => locks
                    .get(&source)
                    .map(|lock| lock.try_lock().is_err())
                    .unwrap_or(false),
                Err(_) => {
                    tracing::error!(
                        "session expiry: prompt_locks 锁中毒，保守跳过过期判定 ({source})"
                    );
                    true
                }
            };
            if generating {
                continue;
            }
            let Some(reason) = expired_reason(updated_at, now, &reset, idle_ms) else {
                continue;
            };
            tracing::info!("会话过期 ({source}): {reason}");
            // 审查修复：删除前按 (peri_id, generation) 复核映射——close RPC 期间若
            // 同 source 新建了会话，不得把新映射误删（旧映射已被 new_session 替换）。
            // generation 提到循环体（close_session_rpc 复用；块内删除复核同值）。
            // 方案 8 步骤 4：删除委托 SessionStore（generation 匹配 + 锁内 updated_at
            // 复核防误杀刚活跃会话 + 锁外 prompt 锁收敛）。
            let generation = runtime.client_generation.load(Ordering::Acquire);
            let removed = crate::session::store::remove_if_current_expired(
                &runtime,
                &source,
                &peri_id,
                generation,
                // 锁内用最新 updated_at 复核——快照值与删除时点之间新消息到达会刷新
                // updated_at，不得误杀刚活跃的会话。
                |current| expired_reason(current.updated_at, now, &reset, idle_ms).is_some(),
            )
            .map_err(|e| {
                tracing::warn!("会话过期删除失败 ({source}): {e}");
                e
            })
            .unwrap_or(false);
            if !removed {
                // 映射已变更（新会话已接管 source）——不 close、不通知
                continue;
            }
            // close ACP session（失败不阻断本地清理；旧 peri_id 独立于映射）。
            // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
            let _ = close_session_rpc(state, &runtime, &peri_id, generation, false).await;
            // 审查修复：应答该 session 挂起的权限请求为 Cancelled（协议要求）
            crate::permission::respond_pending_permissions_cancelled(&runtime, &peri_id).await;
            // 平台通知（用户可见重置原因）：投递给 source 归属的适配器。
            // G4 §3-9（C2）：统一入口 adapter_for_source（None 跳过——空 key 与
            // 未注册适配器同语义，替代 split(':') + adapter(key) 样板）。
            if let Some(adapter) = state.gateway.adapter_for_source(&source) {
                let _ = adapter.deliver_text(&source, &format!("[会话已重置] {reason}"));
            }
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source),
                &format!("Session expired ({reason})"),
                serde_json::Map::new(),
            );
        }
        // 连接级回收：只有**零会话**且闲置超时的连接才收。
        //
        // 收到会话为止：连接上的子进程（`AgentRuntime.acp` 的 `ManagedChild`）不会因
        // 会话回收而释放，它属于连接。一个没有任何会话的连接，按定义不在给用户看任何
        // 对话，闲置超时后杀掉它的进程树才是 issue 点名的「回收子进程/句柄/内存」。
        // 保守边界：有会话的连接不走这条路径。#379 懒重连后，回收过的连接在下次发送
        // 时本可自愈，但拆掉仍带会话的连接只会换来无谓的重建延迟与代际失效——
        // 「零会话才收」的口径不变。
        reclaim_idle_connection(
            &agent_id,
            &runtime,
            state,
            gui_timeout,
            now,
            prompt_gate_held,
            &pending_interaction_sessions,
        )
        .await;
    }
}

/// 平台消息**可能**落到该 agent 时不得回收它的连接（#363-4 修正）。
///
/// 连接回收把 runtime 置为 `Disconnected`。#379（GUI 发送懒重连）与 B10.3（平台
/// ingest 的 `ensure_runtime_ready` 懒启动）落地后，该状态已能自愈，本守卫当年的
/// 「防静默不可恢复」论据随之弱化；但守卫保留——回收意味着秒级重建延迟与远端会话
/// 代际失效（`SessionContinuity::Invalidated`），对平台可能路由的 agent 做无谓拆除
/// 没有收益，保守保活的代价只是「零会话连接多活一阵」。
///
/// 两条路径：
/// 1. **显式路由绑定**：`gateway.routes()` 里 `agent_id` 命中该 agent。
/// 2. **未绑定消息的 active-agent 回退**：`unbound_policy` 缺省就是 `active-agent`，
///    未绑定来源的平台消息会落到 active agent —— 即使该 agent 没有显式路由。这一条只在
///    真有适配器注册（`adapter_keys()` 非空）时才成立：没有任何平台接入就谈不上平台流量。
///
/// 反向含义：**没有**平台路径能到该 agent 时回收是安全的——用户切到它或打开它的会话
/// 都会经 `switch_agent` / `do_connect_and_replace` 重新连上，不存在静默不可恢复。
fn platform_may_route_to(state: &AppState, agent_id: &str) -> bool {
    if state
        .gateway
        .routes()
        .iter()
        .any(|binding| binding.agent_id == agent_id)
    {
        return true;
    }
    // 锁中毒保守视为「就是 active」——宁可不回收，也不误杀平台连接。
    let is_active = state
        .active_agent
        .lock()
        .map(|active| active.as_str() == agent_id)
        .unwrap_or(true);
    is_active
        && !state.gateway.adapter_keys().is_empty()
        && state.gateway.unbound_policy() == crate::gateway::route::UnboundPolicy::ActiveAgent
}

/// 零会话且闲置超时的连接 → 走既有 stop 路径释放进程树。
async fn reclaim_idle_connection(
    agent_id: &str,
    runtime: &Arc<crate::runtime::AgentRuntime>,
    state: &AppState,
    gui_timeout: Option<std::time::Duration>,
    now: Timestamp,
    prompt_gate_held: bool,
    pending_interaction_sessions: &[String],
) {
    let Some(timeout) = gui_timeout else {
        return;
    };
    if prompt_gate_held || !pending_interaction_sessions.is_empty() {
        return;
    }
    if platform_may_route_to(state, agent_id) {
        // 每轮都命中，所以只在 debug：这是保活决定，不是异常。
        tracing::debug!(agent_id, "空闲连接回收跳过：平台可能路由到该 agent");
        return;
    }
    let session_count = runtime
        .sessions
        .lock()
        .map(|sessions| sessions.len())
        .unwrap_or(usize::MAX);
    if session_count != 0 {
        return;
    }
    // 注意闲置时钟是 `last_connected_at`（连接建立时刻）而不是「最后一次活动时刻」：
    // 对零会话的 runtime 两者等价（没有会话就没有会话级活动，连接级活动只有 prompt 与
    // 交互，二者都已在上面豁免），所以这里不需要再引入一个 runtime 级活动时间戳。
    let reclaimable = {
        let Ok(agent_state) = runtime.agent_runtime.lock() else {
            // 锁中毒：跟随 panic 会让下一次 lock 直接炸；这里的正确处置是保守跳过
            // （与 prompt_locks 的 fail-closed 同精神）。
            return;
        };
        // 只收 Connected：其余状态要么本来就没进程，要么正在重连（不该被打断）。
        agent_state.status == crate::agent::runtime::AgentLifecycleStatus::Connected
            && agent_state
                .last_connected_at
                .map(|connected_at| {
                    now.elapsed_since(connected_at)
                        > u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX)
                })
                .unwrap_or(false)
    };
    if !reclaimable {
        return;
    }
    tracing::info!(
        agent_id,
        "空闲连接回收：零会话且自连接起已超过 {} 秒，停止 agent 子进程",
        timeout.as_secs()
    );
    crate::lifecycle::stop_agent_runtime(agent_id, state).await;
    state.log_runtime_summary(
        "warn",
        "session",
        None,
        &format!(
            "Idle connection reclaimed ({agent_id}, no sessions for > {}s since connect)",
            timeout.as_secs()
        ),
        serde_json::Map::new(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::route::parse_config;
    use crate::gateway::GatewayCore;
    use crate::runtime::AgentRuntime;
    use crate::session::SessionInfo;
    use crate::test_utils::TestStateBuilder;
    use crate::time::Timestamp;

    #[tokio::test]
    async fn expiry_prompt_lock_poison_skips_session_conservatively() {
        // I17 W3（LR2-WI07）：prompt_locks 锁中毒 → fail-closed——保守视为「生成中」跳过
        // 过期判定，不得清理可能仍在生成的会话（旧实现 unwrap_or(false) → generating=false
        // → 会误清理过期判定的会话，RED 证据）。
        let gateway = GatewayCore::from_config(
            parse_config(
                "gateway:
  routes:
    - source: qq:user:x
      agent: peri
      profile: p
      session: s
",
            )
            .expect("config"),
        );
        let runtime = AgentRuntime::new_disconnected();
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            let mut info = SessionInfo::new("peri-1".into(), String::new(), ".".into(), true, 0);
            // 构造过期会话：updated_at 远古（idle 阈值 1440 分钟必超）
            info.updated_at = Some(Timestamp::new(0));
            sessions.insert("qq:user:x".into(), info);
        }
        // 毒化 prompt_locks（guard 持有期间 panic）
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = runtime.prompt_locks.lock().unwrap();
            panic!("intentional poison");
        }));
        let state = TestStateBuilder::bare()
            .with_runtime("peri", runtime)
            .with_gateway(std::sync::Arc::new(gateway))
            .build();
        check_session_expiry(&state).await;
        let runtimes = state.runtimes.all_with_ids();
        let (_, runtime_ref) = runtimes
            .iter()
            .find(|(id, _)| id == "peri")
            .expect("runtime 存在");
        let sessions = runtime_ref.sessions.lock().unwrap();
        assert!(
            sessions.contains_key("qq:user:x"),
            "prompt_locks 锁中毒必须保守跳过过期判定（不清理会话）"
        );
    }
}
