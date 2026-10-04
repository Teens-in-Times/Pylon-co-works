// #245：文件自 crate 根迁入本目录；crate 根 glob 与原 `use super::*` 同名集。
use crate::*;
use pylon_foundations::await_guard::HeldAcrossAwait;
// `crate::*` 只给到 crate 根的绑定；#363-4 新增的超时可注入形态没有根绑定，
// 显式引入（`crate::session` 的 `pub(crate) use expiry::*` 会带出来）。
use crate::session::check_session_expiry_with;

fn echo_agent() -> AgentDef {
    crate::test_utils::fake_acp_agent(
        "fake-acp-echo",
        &["--scenario", "alive", "--session-id", "expiry-session"],
    )
}

async fn state_with_initial_acp() -> AppState {
    let agent = echo_agent();
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = Arc::new(gateway::GatewayCore::from_config(
        gateway::route::parse_config(
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
    ));
    crate::test_utils::test_state_with_acp(
        agent,
        initial_acp,
        gateway,
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await
}

/// #363-4 契约变更：GUI local 会话不再**无条件**豁免后台回收。
///
/// 旧行为（`is_platform_source` 守卫）下 `local` 键永远不动；新行为下它按可配的空闲
/// 超时参与回收，豁免改由「活跃信号」承担（在途回合 / 在场交互 / prompt 闸门 / prompt
/// 锁）。本条钉住「超时 + 无活跃信号 → 回收」，平台来源路径不变。
#[tokio::test]
async fn expiry_watcher_reclaims_idle_local_source_and_resets_platform_sources() {
    let state = state_with_initial_acp().await;
    let runtime = state.active_runtime().expect("active runtime");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        // 插入过期/平台两类会话
        sessions.clear();
        let mut local = SessionInfo::new("local-peri".into(), String::new(), ".".into(), true, 0);
        local.updated_at = Some(Timestamp::new(1)); // 1970 年，必然过期
        sessions.insert("local".to_string(), local);
        let mut platform =
            SessionInfo::new("platform-peri".into(), String::new(), ".".into(), true, 0);
        platform.updated_at = Some(Timestamp::new(1));
        sessions.insert("qq:group:123".to_string(), platform);
    }

    check_session_expiry_with(&state, Some(std::time::Duration::from_secs(60))).await;

    let sessions = runtime.sessions.lock().unwrap();
    assert!(
        !sessions.contains_key("local"),
        "GUI local 会话空闲超时后必须被回收（#363-4 收窄了原来的无条件豁免）"
    );
    assert!(
        !sessions.contains_key("qq:group:123"),
        "平台会话过期必须 close + 移除"
    );
}

/// #363-4：超时关闭（`PYLON_SESSION_IDLE_TIMEOUT_SECS=0` 的语义）时一个会话都不动。
/// 走可注入形态而不是改进程 env：env 是进程级的，测试里改它会与并行的其它用例竞态。
#[tokio::test]
async fn disabled_gui_timeout_reclaims_nothing() {
    let state = state_with_initial_acp().await;
    let runtime = state.active_runtime().expect("active runtime");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        sessions.clear();
        let mut local = SessionInfo::new("local-peri".into(), String::new(), ".".into(), true, 0);
        local.updated_at = Some(Timestamp::new(1));
        sessions.insert("local".to_string(), local);
    }

    check_session_expiry_with(&state, None).await;
    assert!(
        runtime.sessions.lock().unwrap().contains_key("local"),
        "超时关闭时不得回收任何 GUI 会话"
    );
}

/// 超时解析是纯函数：#490 起缺省 = 关闭；显式 `0` 关闭 / 显式正数生效 / 非法值回退
/// 默认（即同样落关闭——opt-in 只认合法正数，笔误不会误启回收）。
#[test]
fn gui_idle_timeout_parsing() {
    use crate::session::expiry::gui_idle_timeout_from;
    assert_eq!(
        gui_idle_timeout_from(None),
        None,
        "#490：缺省 = 关闭（回收是显式 opt-in，#379 懒重连使其失去必要性）"
    );
    assert_eq!(gui_idle_timeout_from(Some("0")), None, "0 关闭");
    assert_eq!(
        gui_idle_timeout_from(Some("300")),
        Some(std::time::Duration::from_secs(300)),
        "显式设值仍生效（opt-in 路径）"
    );
    assert_eq!(
        gui_idle_timeout_from(Some("  60  ")),
        Some(std::time::Duration::from_secs(60)),
        "两侧空白应被容忍"
    );
    assert_eq!(
        gui_idle_timeout_from(Some("不是数字")),
        None,
        "非法值回退默认 = 0 = 关闭"
    );
}

/// #363-4：在途回合是豁免信号——超时也不得回收（#420 起由账本 active 单源判定）。
#[tokio::test]
async fn session_with_an_in_flight_turn_is_exempt() {
    let state = state_with_initial_acp().await;
    let runtime = state.active_runtime().expect("active runtime");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        sessions.clear();
        let mut local = SessionInfo::new("local-peri".into(), String::new(), ".".into(), true, 0);
        local.updated_at = Some(Timestamp::new(1)); // 早已超时
        sessions.insert("local".to_string(), local);
    }
    // #420：在途事实登记进账本（remote = 会话 peri_id，generation = 0）。
    runtime.turn_ledger.begin(
        crate::acp::TurnKey {
            local_session_id: "local".to_string(),
            remote_session_id: "local-peri".to_string(),
            generation: 0,
            turn_id: 1,
        },
        0,
    );

    check_session_expiry_with(&state, Some(std::time::Duration::from_secs(60))).await;
    assert!(
        runtime.sessions.lock().unwrap().contains_key("local"),
        "有在途回合的会话必须豁免（ADR-0034 的账本在途事实）"
    );
}

/// #363-4：交互队列有在场条目时豁免——等用户点权限卡不算沉默。
#[tokio::test]
async fn session_with_a_pending_interaction_is_exempt() {
    let state = state_with_initial_acp().await;
    let runtime = state.active_runtime().expect("active runtime");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        sessions.clear();
        let mut local = SessionInfo::new("local-peri".into(), String::new(), ".".into(), true, 0);
        local.updated_at = Some(Timestamp::new(1));
        sessions.insert("local".to_string(), local);
    }
    runtime
        .ledger
        .queue()
        .admit(crate::acp::interaction_queue::InteractionQueueEntry {
            request_id: "req-1".into(),
            method: "session/request_permission".into(),
            kind: "approval".into(),
            session_id: "local-peri".into(),
            agent_id: String::new(),
            client_generation: 0,
            enqueued_at: Timestamp::now(),
            deadline_ms: None,
            event: serde_json::json!({}),
            state: crate::acp::interaction_queue::InteractionEntryState::Waiting,
        })
        .expect("admit");

    check_session_expiry_with(&state, Some(std::time::Duration::from_secs(60))).await;
    assert!(
        runtime.sessions.lock().unwrap().contains_key("local"),
        "交互队列里有该会话的在场条目时必须豁免"
    );
}

/// #363-4：prompt 闸门被占用时，该连接的全部会话本轮跳过。
// 测试本体：持 prompt_gate 模拟在途 prompt
#[tokio::test]
async fn sessions_of_a_busy_prompt_gate_are_exempt() {
    let state = state_with_initial_acp().await;
    let runtime = state.active_runtime().expect("active runtime");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        sessions.clear();
        let mut local = SessionInfo::new("local-peri".into(), String::new(), ".".into(), true, 0);
        local.updated_at = Some(Timestamp::new(1));
        sessions.insert("local".to_string(), local);
    }
    // 持有闸门（模拟在途 prompt）
    let _gate = HeldAcrossAwait::new(runtime.prompt_gate.clone().lock_owned().await);

    check_session_expiry_with(&state, Some(std::time::Duration::from_secs(60))).await;
    assert!(
        runtime.sessions.lock().unwrap().contains_key("local"),
        "prompt 闸门被占用时该连接的会话必须豁免"
    );
}

/// 与 [`state_with_initial_acp`] 同形，但 gateway 路由指向指定的 agent id
/// （用于验证「平台可能路由到该 agent 时不得回收连接」）。
async fn state_with_route_to(route_agent: &str) -> AppState {
    let agent = echo_agent();
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = Arc::new(gateway::GatewayCore::from_config(
        gateway::route::parse_config(&format!(
            r#"
gateway:
  routes:
    - source: qq:group:123
      agent: {route_agent}
      profile: trpg
      session: 战役1
"#
        ))
        .expect("合法配置"),
    ));
    crate::test_utils::test_state_with_acp(
        agent,
        initial_acp,
        gateway,
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await
}

/// #363-4 修正：**平台可能路由到该 agent 时，连接一律不回收**。
///
/// 连接回收把 runtime 置为 `Disconnected`，而该状态不会自愈（自动重连只管
/// `Crashed`；平台 ingest 对非 Connected 实例直接拒绝且无 fallback）。所以哪怕
/// 「零会话 + 闲置超时」全部命中，只要路由指向它就必须保活。
#[tokio::test]
async fn connection_routed_by_the_gateway_is_never_reclaimed() {
    use crate::agent::runtime::AgentLifecycleStatus;
    // 路由的 agent id 必须与 runtime 的键一致，才构成「平台能路由到它」。
    let probe = state_with_initial_acp().await;
    let (agent_id, _) = probe
        .runtimes
        .all_with_ids()
        .into_iter()
        .next()
        .expect("至少一个 runtime");

    let state = state_with_route_to(&agent_id).await;
    let (_, runtime) = state
        .runtimes
        .all_with_ids()
        .into_iter()
        .next()
        .expect("至少一个 runtime");
    runtime.sessions.lock().unwrap().clear();
    {
        let mut agent_state = runtime.agent_runtime.lock().unwrap();
        agent_state.status = AgentLifecycleStatus::Connected;
        agent_state.last_connected_at = Some(Timestamp::new(1));
    }

    check_session_expiry_with(&state, Some(std::time::Duration::from_secs(60))).await;

    assert!(
        !runtime.snapshot_acp().is_dead(),
        "gateway 路由指向该 agent 时不得回收连接（{agent_id}）"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected
    );
}

/// #363-4 连接级回收：**零会话**且闲置超时的 Connected runtime 必须走既有 stop
/// 路径释放 agent 子进程（issue 点名「一直挂着 agent 子进程」的落点）。
#[tokio::test]
async fn idle_connection_without_sessions_is_reclaimed() {
    use crate::agent::runtime::AgentLifecycleStatus;
    let state = state_with_initial_acp().await;
    let (agent_id, runtime) = state
        .runtimes
        .all_with_ids()
        .into_iter()
        .next()
        .expect("至少一个 runtime");
    runtime.sessions.lock().unwrap().clear();
    {
        let mut agent_state = runtime.agent_runtime.lock().unwrap();
        agent_state.status = AgentLifecycleStatus::Connected;
        // 1970 年 → 任何超时都算闲置
        agent_state.last_connected_at = Some(Timestamp::new(1));
    }
    assert!(!runtime.snapshot_acp().is_dead(), "前置：连接本来是活的");

    check_session_expiry_with(&state, Some(std::time::Duration::from_secs(60))).await;

    assert!(
        runtime.snapshot_acp().is_dead(),
        "零会话的闲置连接必须被回收（agent 子进程释放）"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Disconnected,
        "回收后状态必须回落 Disconnected（也因此下一轮不会再重复收）"
    );
    let _ = agent_id;
}

/// 连接级回收的豁免：交互队列有在场条目时不得收（用户在等着应答，不是闲置）。
#[tokio::test]
async fn idle_connection_with_a_pending_interaction_is_exempt() {
    use crate::agent::runtime::AgentLifecycleStatus;
    let state = state_with_initial_acp().await;
    let (_, runtime) = state
        .runtimes
        .all_with_ids()
        .into_iter()
        .next()
        .expect("至少一个 runtime");
    runtime.sessions.lock().unwrap().clear();
    {
        let mut agent_state = runtime.agent_runtime.lock().unwrap();
        agent_state.status = AgentLifecycleStatus::Connected;
        agent_state.last_connected_at = Some(Timestamp::new(1));
    }
    runtime
        .ledger
        .queue()
        .admit(crate::acp::interaction_queue::InteractionQueueEntry {
            request_id: "conn-req".into(),
            method: "session/request_permission".into(),
            kind: "approval".into(),
            session_id: "any-peri".into(),
            agent_id: String::new(),
            client_generation: 0,
            enqueued_at: Timestamp::now(),
            deadline_ms: None,
            event: serde_json::json!({}),
            state: crate::acp::interaction_queue::InteractionEntryState::Waiting,
        })
        .expect("admit");

    check_session_expiry_with(&state, Some(std::time::Duration::from_secs(60))).await;
    assert!(
        !runtime.snapshot_acp().is_dead(),
        "有在场交互的连接不得被回收"
    );
}

/// 连接级回收只作用于 **Connected**：Disconnected 的 runtime 没有进程可收，
/// 重复调用不得产生噪音或副作用。
#[tokio::test]
async fn disconnected_connection_is_not_reclaimed_again() {
    use crate::agent::runtime::AgentLifecycleStatus;
    let state = state_with_initial_acp().await;
    let (_, runtime) = state
        .runtimes
        .all_with_ids()
        .into_iter()
        .next()
        .expect("至少一个 runtime");
    runtime.sessions.lock().unwrap().clear();
    {
        let mut agent_state = runtime.agent_runtime.lock().unwrap();
        agent_state.status = AgentLifecycleStatus::Disconnected;
        agent_state.last_connected_at = Some(Timestamp::new(1));
    }
    check_session_expiry_with(&state, Some(std::time::Duration::from_secs(60))).await;
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Disconnected
    );
}

/// A4 TOCTOU 回归：快照（过期）与删除复核之间 updated_at 被新消息刷新
/// → watcher 不得误杀该会话（旧实现复核只查 peri_id/generation，会误删）。
#[tokio::test]
async fn expiry_watcher_keeps_session_refreshed_after_snapshot() {
    let state = Arc::new(state_with_initial_acp().await);
    let runtime = state.active_runtime().expect("active runtime");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        sessions.clear();
        let mut platform =
            SessionInfo::new("platform-peri".into(), String::new(), ".".into(), true, 0);
        platform.updated_at = Some(Timestamp::new(1)); // 1970 年，快照视角必然过期
        sessions.insert("qq:group:123".to_string(), platform);
        // 大量填充会话：拉长快照持锁窗口，主线程才能稳定观察到快照阶段。
        //
        // #363-4：填充会话的 updated_at 必须是**当下**——旧契约下非平台键天然豁免，
        // 新契约下它们按同一超时参与回收；给过期时间会让这一条同时测到无关的回收。
        for i in 0..50_000 {
            let mut filler = SessionInfo::new(
                format!("local-fill-{i}"),
                String::new(),
                ".".into(),
                true,
                0,
            );
            filler.updated_at = Some(Timestamp::now());
            sessions.insert(format!("local-fill-{i}"), filler);
        }
    }

    // 主线程先持有 prompt_locks：watcher 在快照后的生成中检查处必然被阻塞，
    // 期间刷新 updated_at 即可精确落在快照之后、删除复核之前（check_session_expiry）。
    let prompt_guard = runtime.prompt_locks.lock().unwrap();
    let state_for_thread = Arc::clone(&state);
    let watcher_thread = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("watcher runtime")
            .block_on(check_session_expiry_with(
                &state_for_thread,
                Some(std::time::Duration::from_secs(60)),
            ));
    });

    // 握手 1：等待 watcher 进入快照（短暂占用 sessions 锁，50k 填充使窗口足够长）
    let mut snapshot_started = false;
    for _ in 0..100_000_000 {
        if runtime.sessions.try_lock().is_err() {
            snapshot_started = true;
            break;
        }
    }
    assert!(snapshot_started, "watcher 必须已进入快照");
    // 握手 2：等待快照完成（sessions 锁释放；随后 watcher 阻塞在 prompt_locks 上）
    while runtime.sessions.try_lock().is_err() {
        std::thread::yield_now();
    }
    // 快照已取：此刻"新消息到达"刷新 updated_at（与 send_prompt_core 同语义）
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        let session = sessions.get_mut("qq:group:123").expect("目标会话存在");
        session.updated_at = Some(Timestamp::now());
    }
    drop(prompt_guard);
    watcher_thread.join().expect("watcher thread");

    let sessions = runtime.sessions.lock().unwrap();
    assert!(
        sessions.contains_key("qq:group:123"),
        "快照后已刷新的会话不得被 watcher 误杀"
    );
}
