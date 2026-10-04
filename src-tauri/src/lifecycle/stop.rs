//! runtime 停止与幽灵 runtime 清理（自 mod.rs 拆分；lifecycle/config_cmds/session/expiry
//! 三方共享的清理口，kill 顺序为契约：abort → clear channels → clear terminals →
//! kill → 归还实例预算 → Disconnected）。
use crate::agent::runtime::AgentLifecycleStatus;
use crate::AppState;

/// 清理被移除 agent 的幽灵 runtime（abort 通知任务 + kill + 从注册表移除）。
/// reload/update/initialize 三条配置提交路径共用（同款清理语义）。
pub(crate) async fn remove_stale_runtimes(inner: &AppState, removed: Vec<String>) {
    for id in removed {
        stop_agent_runtime(&id, inner).await;
        inner.runtimes.remove(&id);
    }
}

/// C7：停掉旧 runtime 的进程——先 abort notification_task（防 kill 触发的崩溃
/// 通知被旧 dispatcher 处理并调度自动重连）再 kill acp，状态置 Disconnected。
/// switch 换目标 / reload 删除 agent 共用。
///
/// #363-4：`pub(crate)` 开放给空闲回收 watcher（`session/expiry.rs`）——回收零会话的
/// 闲置连接必须走**同一条** kill 路径（Job Object 杀进程树 + 归还实例预算槽），
/// 不在回收侧另写一份清理。
pub(crate) async fn stop_agent_runtime(agent_id: &str, inner: &AppState) {
    if let Some(old) = inner.runtimes.get(agent_id) {
        if let Ok(mut task) = old.notification_task.lock() {
            if let Some(handle) = task.take() {
                handle.abort();
            }
        }
        // A4：清空流式通道注册——旧 runtime 的 channel 随 dispatcher 一起失效，
        // 防 kill 后残留帧投递到已被前端废弃的通道对象。
        old.clear_update_channels();
        // #316：清空宿主终端注册表——旧 runtime 的 terminal/* 子进程不再跨代
        // 泄漏（registry 本体随 runtime 保留复用，仅清终端）。
        let cleared = old.terminal_registry.clear().await;
        if cleared > 0 {
            tracing::debug!(agent_id, cleared, "host terminals cleared on runtime stop");
        }
        // #549：kill 走快照——杀的是解析出的这一连接；stop 序列期间即使有并发
        // 换装（正常不会：stop 持 lifecycle 锁），也只影响旧连接本身。
        let _ = old.snapshot_acp().kill();
        // B3：实例停止即归还全局预算配额（runtime 仍留在表中，槽位显式清空）。
        if let Ok(mut slot) = old.instance_guard.lock() {
            *slot = None;
        }
        if let Ok(mut state) = old.agent_runtime.lock() {
            state.status = AgentLifecycleStatus::Disconnected;
        }
    }
}
