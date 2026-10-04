//! #379：GUI 发送/建会话前懒重连——`ensure_connected_for_send` 的触发集、
//! 幂等放行、失败传播与 `lastError` 落位回归。
//! #451：触发集放宽——「无主 Crashed」（¬auto_reconnect_active ∧ acp.is_dead()）
//! 由发送路径接管，continuity=Unknown；本文件同时钉住有主让路 / 活 client
//! 让路 / 占位与崩溃残留接管 / 预算超时链路自愈六类分支。
//! 场景锚点：#363 连接级空闲回收（`stop_agent_runtime` → Disconnected 且不自愈）
//! 后，GUI 下一次发送必须经本入口自愈，而非 `ConnectionClosed` 硬错误。
use super::*;

/// 与 lifecycle/mod.rs 测试同形的 mock 窗口（announce 播报目标）。
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

/// 触发集主案例：Disconnected runtime（真 fake agent）经懒重连拉起——
/// status=Connected、generation 前进（真实连接发生，非纸面放行）。
#[tokio::test]
async fn ensure_connected_for_send_rebuilds_disconnected_runtime() {
    let agent = crate::test_utils::fake_acp_agent("lazy-recv", &["--scenario", "alive"]);
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent.clone())
        .with_runtime("lazy-recv", runtime.clone())
        .build();
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-recv", &window)
        .await
        .expect("Disconnected runtime 必须被懒重连拉起");
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected,
        "重建成功后三灯必须收敛 Connected"
    );
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        1,
        "generation 必须前进（真实连接发生）"
    );
}

/// Connected 放行：不重连、不改 generation（幂等语义，与平台侧 ensure_runtime_ready 一致）。
#[tokio::test]
async fn ensure_connected_for_send_is_noop_when_connected() {
    let agent = crate::test_utils::fake_acp_agent_stub("lazy-keep");
    let runtime = crate::test_utils::connected_runtime();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-keep", runtime.clone())
        .build();
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-keep", &window)
        .await
        .expect("Connected 状态必须直接放行");
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        0,
        "Connected 不得触发重连（generation 不变）"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected
    );
}

/// #451 全新形态：Crashed + 无主（¬auto_reconnect_active）+ 占位 client
/// （构造即 stopped，is_dead=true）→ 发送路径接管重建。
/// 旧 #379 触发集对一切 Crashed 放行——正是 #451 的硬错误残留态；本用例的
/// 夹具（占位 client + 手工置 Crashed）即「新 agent 首发遇挂起 → 预算超时」
/// 收敛后的 runtime 形态。
#[tokio::test]
async fn ensure_connected_for_send_takes_over_unowned_crashed_placeholder() {
    let agent = crate::test_utils::fake_acp_agent("lazy-takeover", &["--scenario", "alive"]);
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    {
        let mut runtime_state = runtime.agent_runtime.lock().unwrap();
        runtime_state.status = AgentLifecycleStatus::Crashed;
        runtime_state.last_error = Some("connect total budget exceeded (60s)".to_string());
    }
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-takeover", runtime.clone())
        .build();
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-takeover", &window)
        .await
        .expect("无主 Crashed（占位已死）必须被发送路径接管重建");
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected,
        "接管成功后三灯必须收敛 Connected"
    );
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        1,
        "接管必须发生真实连接（generation 前进，非纸面放行）"
    );
}

/// #451 有主让路：Crashed + auto_reconnect_active=true（退避循环在途）→
/// 放行，不抢 agent_lifecycle；发送后续命中既有 `is_crashed → AgentCrashed`
/// 早退。防重入标志是「有主/无主」的权威判据。
#[tokio::test]
async fn ensure_connected_for_send_yields_while_auto_reconnect_active() {
    let agent = crate::test_utils::fake_acp_agent_stub("lazy-owned");
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    {
        let mut runtime_state = runtime.agent_runtime.lock().unwrap();
        runtime_state.status = AgentLifecycleStatus::Crashed;
        runtime_state.last_error = Some("ACP 进程崩溃（test）".to_string());
    }
    runtime
        .auto_reconnect_active
        .store(true, std::sync::atomic::Ordering::Release);
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-owned", runtime.clone())
        .build();
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-owned", &window)
        .await
        .expect("有主 Crashed 必须放行（交给退避循环）");
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        0,
        "有主 Crashed 不得在发送路径重连（generation 不变）"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Crashed,
        "状态必须保持 Crashed（自动重连的 still_stale 复查依据）"
    );
    assert!(
        runtime
            .auto_reconnect_active
            .load(std::sync::atomic::Ordering::Acquire),
        "放行路径不得触碰防重入标志"
    );
}

/// #451 变体 3（活 client 不杀）：手动 reconnect 对活 agent 预算超时——新 spawn
/// 被杀、replace 未发生、旧 client 还活着，状态却被收敛为 Crashed。发送照走
/// 既有路径打到活连接上（is_dead 闸：活连接不判死，不接管、不白白重建）。
#[tokio::test]
async fn ensure_connected_for_send_yields_when_live_client_survives_timeout() {
    let agent = crate::test_utils::fake_acp_agent("lazy-variant3", &["--scenario", "alive"]);
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-variant3", runtime.clone())
        .build();
    let window = mock_window().await;
    // 前置：真连一次得活 client（generation=1）。
    state
        .ensure_connected_for_send(&runtime, "lazy-variant3", &window)
        .await
        .expect("前置连接必须成功");
    // 模拟手动重连预算超时残留：状态面 Crashed、连接面仍活。
    runtime.agent_runtime.lock().unwrap().status = AgentLifecycleStatus::Crashed;
    state
        .ensure_connected_for_send(&runtime, "lazy-variant3", &window)
        .await
        .expect("活 client + Crashed 必须放行（发送打到活连接）");
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        1,
        "活连接不得被接管重建（generation 不变，不杀可用连接）"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Crashed
    );
}

/// #451 附带自愈：自动重连 5 次放弃后的残留——Crashed + client crashed 标志
/// 置位（真崩溃痕迹）+ 无主 → 下次发送接管重建。
#[tokio::test]
async fn ensure_connected_for_send_takes_over_auto_reconnect_giveup_residue() {
    let agent = crate::test_utils::fake_acp_agent("lazy-giveup", &["--scenario", "alive"]);
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-giveup", runtime.clone())
        .build();
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-giveup", &window)
        .await
        .expect("前置连接必须成功");
    // 模拟放弃残留：真崩溃标志（exit watcher / reader 线程置位的同一标志）
    // + 状态面 Crashed + 无主。
    runtime
        .acp
        .lock()
        .await
        .crashed
        .store(true, std::sync::atomic::Ordering::Release);
    runtime.agent_runtime.lock().unwrap().status = AgentLifecycleStatus::Crashed;
    state
        .ensure_connected_for_send(&runtime, "lazy-giveup", &window)
        .await
        .expect("放弃残留（崩溃标志 + 无主）必须被发送路径接管");
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected,
        "接管后三灯收敛 Connected"
    );
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        2,
        "接管发生真实替换（generation 1→2）"
    );
}

/// #451 主链路（issue 复现步骤）：hang agent 上懒重连 → 60s（注入 2s）预算
/// 耗尽 → Crashed 无主残留 → 再次发送**再次发起重建**（旧触发集此处放行返回
/// Ok、最终 ConnectionClosed 硬错误）。第二次 ensure 的 Err 预算标记即
/// 「重建确实发生了」的判别证据。
#[tokio::test]
async fn send_path_takes_over_after_connect_budget_timeout_residue() {
    // #451：注入缝双消费者之一，与 lifecycle 预算测试共用 INJECTION_LOCK 串行
    // （进程全局值，并行 set/clear 互相踩——见 budgets.rs 注入缝 doc）。
    // 锁卫有意跨 await 持有（串行化正是语义），经 HeldAcrossAwait 收口。
    let _injection_guard = HeldAcrossAwait::new(
        crate::lifecycle::budgets::connect_budget_override::INJECTION_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
    );
    crate::lifecycle::budgets::connect_budget_override::set(2);
    struct RestoreBudget;
    impl Drop for RestoreBudget {
        fn drop(&mut self) {
            crate::lifecycle::budgets::connect_budget_override::clear();
        }
    }
    let _restore = RestoreBudget;
    let agent = crate::test_utils::fake_acp_agent("lazy-budget-chain", &["--scenario", "hang"]);
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-budget-chain", runtime.clone())
        .build();
    let window = mock_window().await;
    let first = state
        .ensure_connected_for_send(&runtime, "lazy-budget-chain", &window)
        .await
        .expect_err("hang agent 首发必须被总预算切断");
    assert!(
        first.contains("connect total budget exceeded"),
        "首发错误必须携带预算标记，实际: {first}"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Crashed,
        "预算分支收敛 Crashed（#421 语义，不发明新状态）"
    );
    let second = state
        .ensure_connected_for_send(&runtime, "lazy-budget-chain", &window)
        .await
        .expect_err("#451：无主 Crashed 必须再次发起重建（旧触发集会放行返回 Ok）");
    assert!(
        second.contains("connect total budget exceeded"),
        "第二次发送必须真实重进 connect（预算标记为判别证据），实际: {second}"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Crashed
    );
}

/// #451 判据函数分支 pin：continuity 随判据带出——Disconnected → Invalidated
/// （既有 #379 语义）；「无主 Crashed」接管 → Unknown（镜像平台侧与自动重连
/// 先例）；其余 → None（放行）。
#[tokio::test]
async fn send_path_rebuild_continuity_picks_continuity_per_branch() {
    use crate::agent::runtime::SessionContinuity;
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    assert_eq!(
        AppState::send_path_rebuild_continuity(&runtime).await,
        Some(SessionContinuity::Invalidated),
        "Disconnected → Invalidated（#379 语义不变）"
    );
    runtime.agent_runtime.lock().unwrap().status = AgentLifecycleStatus::Connected;
    assert_eq!(
        AppState::send_path_rebuild_continuity(&runtime).await,
        None,
        "Connected → 放行"
    );
    runtime.agent_runtime.lock().unwrap().status = AgentLifecycleStatus::Crashed;
    runtime
        .auto_reconnect_active
        .store(true, std::sync::atomic::Ordering::Release);
    assert_eq!(
        AppState::send_path_rebuild_continuity(&runtime).await,
        None,
        "有主 Crashed → 放行"
    );
    runtime
        .auto_reconnect_active
        .store(false, std::sync::atomic::Ordering::Release);
    assert_eq!(
        AppState::send_path_rebuild_continuity(&runtime).await,
        Some(SessionContinuity::Unknown),
        "无主 Crashed（占位已死）→ 接管，continuity=Unknown"
    );
}

/// 失败传播：连接必然失败（exe 不存在）时 Err 原样上抛，status 回落
/// Disconnected（status_after_connection_failure）且 lastError 落位
/// （announce 面持久化，前端三灯 + 错误文本的数据源）。
#[tokio::test]
async fn ensure_connected_for_send_failure_propagates_and_records_last_error() {
    let mut agent = crate::test_utils::fake_acp_agent_stub("lazy-fail");
    agent.exe = std::env::temp_dir()
        .join("missing-pylon-lazy-reconnect-agent")
        .to_string_lossy()
        .to_string();
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-fail", runtime.clone())
        .build();
    let window = mock_window().await;
    let error = state
        .ensure_connected_for_send(&runtime, "lazy-fail", &window)
        .await
        .expect_err("连接失败必须如实上抛（不吞）");
    assert!(!error.is_empty(), "错误文本不得为空");
    let runtime_state = runtime.agent_runtime.lock().unwrap();
    assert_eq!(
        runtime_state.status,
        AgentLifecycleStatus::Disconnected,
        "失败必须回落 Disconnected（不发明新状态）"
    );
    assert!(
        runtime_state.last_error.is_some(),
        "lastError 必须落 runtime 状态（三灯语义）"
    );
}

/// #363 场景回归：连接级空闲回收（stop_agent_runtime → Disconnected）后，
/// GUI 下一次发送路径的懒重连把 runtime 拉回 Connected——回收对用户不再表现为
/// 一次发送失败。
#[tokio::test]
async fn send_path_recovers_after_idle_reclaim_disconnected_runtime() {
    let agent = crate::test_utils::fake_acp_agent("lazy-reclaim", &["--scenario", "alive"]);
    let runtime = crate::test_utils::connected_runtime();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("lazy-reclaim")
        .with_agent(agent.clone())
        .with_runtime("lazy-reclaim", runtime.clone())
        .build();
    // #363 回收路径：kill + 归还实例预算 + 状态置 Disconnected。
    crate::lifecycle::stop_agent_runtime("lazy-reclaim", &state).await;
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Disconnected,
        "前置：回收后 runtime 必须处于 Disconnected"
    );
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-reclaim", &window)
        .await
        .expect("回收后的 Disconnected runtime 必须能被发送路径懒重连拉起");
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected,
        "自愈后三灯必须收敛 Connected"
    );
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        1,
        "自愈必须发生真实连接（generation 前进）"
    );
}

/// 未知 agent：registry 查无此 agent 时报错，不得留下半途状态。
#[tokio::test]
async fn ensure_connected_for_send_unknown_agent_errors() {
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_runtime("ghost", runtime.clone())
        .build();
    let window = mock_window().await;
    let error = state
        .ensure_connected_for_send(&runtime, "ghost", &window)
        .await
        .expect_err("未知 agent 必须报错");
    assert!(error.contains("unknown agent"), "实际: {error}");
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Disconnected
    );
}
