//! MCP 配置命令与持久化（自 mod.rs 拆分；行为零变化）。
//!
//! - `get/set_mcp_servers`：runtime 配置读写（C8 写序锁 + E10 wire 缓存）。
//! - B4.2 持久化：原子写（唯一 temp + rename）、启动恢复加载（校验失败静默降级）。

use crate::error::PylonError;
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

// ── B4.2 MCP 配置持久化 ──

/// #683：MCP 落盘序号 + 串行闸。
///
/// 命令面只在内存临界区（`mcp_write_lock`）内登记序号（[`Self::begin`]），
/// 序列化与原子写移到 `spawn_blocking` 执行；[`Self::begin_write`] 取闸后复查
/// 序号——期间已有更晚的落盘登记时跳过本次写（磁盘最终 = 最后一次 set）。
#[derive(Default)]
pub(crate) struct McpPersistOrder {
    latest: AtomicU64,
    gate: std::sync::Mutex<()>,
}

impl McpPersistOrder {
    /// 登记一次落盘意图，返回单调序号。必须在 `mcp_write_lock` 临界区内调用
    /// （签名要求持有该锁的 guard，不再只是约定），使序号顺序等于内存提交顺序。
    pub(crate) fn begin(&self, _write_guard: &tokio::sync::MutexGuard<'_, ()>) -> u64 {
        self.latest.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// 磁盘写串行闸：仅当 `version` 仍是最新登记时放行；否则返回 None——
    /// 已有更晚的落盘在队列中，本次写可安全跳过。
    pub(crate) fn begin_write(&self, version: u64) -> Option<std::sync::MutexGuard<'_, ()>> {
        let guard = self
            .gate
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        (self.latest.load(Ordering::Acquire) == version).then_some(guard)
    }
}

/// MCP 配置落盘路径（统一从 AppState 的一次性 DataDirs 取）。
/// 注意：env/headers 可能含 secret，文件是本地用户配置（写盘是持久化目的），
/// 但不进任何日志/输出。
pub(crate) fn mcp_persist_path(state: &AppState) -> Result<std::path::PathBuf, PylonError> {
    Ok(crate::paths::mcp_persist_path(state.data_dirs()?))
}

/// 序列化 + 原子写（同步，供 `spawn_blocking` 调用）：唯一临时文件 + rename，
/// 中断不留半截 JSON。历史行为保留：不 fsync 临时文件（best-effort 持久化）。
/// 写失败只 warn，不阻断主流程。
fn persist_mcp_servers_at(path: &std::path::Path, servers: &[crate::mcp::McpServerConfig]) {
    let json = match serde_json::to_string(servers) {
        Ok(json) => json,
        Err(error) => {
            tracing::warn!("serialize MCP config failed: {error}");
            return;
        }
    };
    if let Err(error) = pylon_foundations::atomic_write::write_file_atomically(
        path,
        json.as_bytes(),
        pylon_foundations::atomic_write::AtomicWriteOptions::best_effort_data_file(),
    ) {
        tracing::warn!("persist MCP config failed: {error}");
    }
}

/// #683：把 MCP 配置的序列化 + 原子写移出 async 运行时（`spawn_blocking`），
/// 且调用方无需持有 `mcp_write_lock` 等磁盘。`version` 由
/// [`McpPersistOrder::begin`] 在内存临界区内登记；等待闸期间被更新的写入
/// 超越时直接跳过（最终磁盘内容 = 最后一次 set）。
pub(crate) async fn spawn_persist_mcp_servers(
    order: Arc<McpPersistOrder>,
    version: u64,
    path: std::path::PathBuf,
    servers: Vec<crate::mcp::McpServerConfig>,
) {
    let joined = tokio::task::spawn_blocking(move || {
        let Some(_gate) = order.begin_write(version) else {
            tracing::debug!("MCP persist #{version} superseded by a newer write; skipped");
            return;
        };
        persist_mcp_servers_at(&path, &servers);
    })
    .await;
    if let Err(error) = joined {
        tracing::warn!("persist MCP config task failed: {error}");
    }
}

/// 加载 MCP 持久化配置：文件缺失/损坏 → None（启动时静默降级为空配置）。
/// 内容过 validate_and_serialize（防手改文件注入非法配置）——校验失败视为损坏。
pub(crate) fn load_mcp_persisted(
    path: &std::path::Path,
) -> Option<Vec<crate::mcp::McpServerConfig>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let servers: Vec<crate::mcp::McpServerConfig> = serde_json::from_str(&raw).ok()?;
    match crate::mcp::validate_and_serialize(Some(servers.clone())) {
        Ok(_) => Some(servers),
        Err(error) => {
            tracing::warn!("loaded MCP config invalid; ignored: {error}");
            None
        }
    }
}

// ── B9 权限审批 commands ──
// ── Session persistence commands ──

/// 返回当前 agent 级暴露的 MCP server 配置（cwd 设置据此选择启用哪些）。
#[tauri::command]
pub(crate) async fn get_mcp_servers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::mcp::McpServerConfig>, PylonError> {
    state
        .inner()
        .current_mcp_servers()
        .map_err(PylonError::Protocol)
}

#[tauri::command]
pub(crate) async fn set_mcp_servers(
    state: tauri::State<'_, AppState>,
    servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<Vec<serde_json::Value>, PylonError> {
    // O13：单次 clone（validate 消耗 clone，原值 move 进 runtime_mcp；
    // 落盘快照也在锁外 clone 一次，无二次序列化）。
    let serialized =
        crate::mcp::validate_and_serialize(servers.clone()).map_err(PylonError::Command)?;
    let persist_servers = servers.clone().unwrap_or_default();
    // C8：写 runtime_mcp + wire 缓存 + 登记落盘序号全程持写序锁——并发
    // set_mcp_servers 的内存提交与序号顺序一致（磁盘必为最后一次设置）。
    // #683：磁盘 IO 不在锁内——序号登记后立即释放锁，写盘在 spawn_blocking。
    let persist = {
        let _mcp_write_guard = state.mcp_write_lock.lock().await;
        {
            let mut guard = state
                .runtime_mcp
                .lock()
                .map_err(|error| PylonError::Command(error.to_string()))?;
            *guard = servers;
            // P1（E10）：wire 缓存与 runtime_mcp 同锁写入（读路径 miss 时回退重算并回填）。
            if let Ok(mut cache) = state.mcp_wire.lock() {
                *cache = Some(serialized.clone());
            }
        }
        match mcp_persist_path(state.inner()) {
            Ok(path) => Some((state.mcp_persist_order.begin(&_mcp_write_guard), path)),
            Err(error) => {
                // 与原实现一致：路径不可解析只 warn，不阻断本次设置。
                tracing::warn!("resolve MCP persist path failed: {}", error.raw_message());
                None
            }
        }
    };
    // B4.2：配置落盘（重启不丢）。写失败只 warn，不阻断本次设置。
    if let Some((version, path)) = persist {
        spawn_persist_mcp_servers(
            state.mcp_persist_order.clone(),
            version,
            path,
            persist_servers,
        )
        .await;
    }
    Ok(serialized)
}

#[cfg(test)]
mod tests {
    use super::McpPersistOrder;

    /// #683：后登记的落盘会让先前登记跳过；最新登记总能拿到写闸。
    #[tokio::test]
    async fn persist_order_skips_superseded_versions() {
        let order = McpPersistOrder::default();
        let write_lock = tokio::sync::Mutex::new(());
        let write_guard = write_lock.lock().await;
        let first = order.begin(&write_guard);
        let second = order.begin(&write_guard);
        drop(write_guard);

        // 先到的写发现更新版本已登记 → 跳过（由最新版写盘收口）。
        assert!(order.begin_write(first).is_none());
        // 释放/放行顺序不影响最新版：仍能拿到写闸。
        let gate = order.begin_write(second);
        assert!(gate.is_some(), "最新版本必须拿到写闸");
        drop(gate);
        // 重复写同一版本仍被允许（串行调用方幂等重试）。
        assert!(order.begin_write(second).is_some());
    }
}
