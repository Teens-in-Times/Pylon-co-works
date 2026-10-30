//! MCP 配置命令与持久化（自 mod.rs 拆分；行为零变化）。
//!
//! - `get/set_mcp_servers`：runtime 配置读写（C8 写序锁 + E10 wire 缓存）。
//! - B4.2 持久化：原子写（唯一 temp + rename）、启动恢复加载（校验失败静默降级）。

use crate::error::PylonError;
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

// ── #707-A：MCP 域对象 ──

/// #707-A：MCP 域——写序锁、落盘序号、内存配置与 wire 缓存收进单一所有者，
/// 不再平铺 AppState 顶层四字段。域内不变量：`commit` 与 `wire_servers` 的
/// miss 回填共享同一把 `slots` 锁——「同锁写两槽」（#683 C8）从人肉约定变为
/// 结构事实，#703（读回填绕过写序锁、并发 set 后缓存被旧值覆写）在此
/// 结构性不可表达。
pub(crate) struct McpDomain {
    /// C8：写序锁——commit 全程持锁（内存提交 + 落盘序号登记），并发 set 的
    /// 内存提交与序号顺序一致（磁盘必为最后一次 commit；#683：磁盘 IO 本体
    /// 在锁外 spawn_blocking）。
    write_lock: Arc<tokio::sync::Mutex<()>>,
    /// #683：落盘序号与串行闸。
    persist_order: Arc<McpPersistOrder>,
    /// 内存两槽（runtime 配置 + wire 序列化缓存）同锁互斥。
    slots: std::sync::Mutex<McpSlots>,
}

#[derive(Default)]
struct McpSlots {
    runtime: Option<Vec<crate::mcp::McpServerConfig>>,
    wire: Option<Vec<serde_json::Value>>,
}

impl Default for McpDomain {
    fn default() -> Self {
        Self::new()
    }
}

impl McpDomain {
    pub(crate) fn new() -> Self {
        Self {
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
            persist_order: Arc::new(McpPersistOrder::default()),
            slots: std::sync::Mutex::new(McpSlots::default()),
        }
    }

    /// 当前内存 MCP 配置（原 `AppState.runtime_mcp` 读面；get_mcp_servers 消费）。
    pub(crate) fn current_servers(
        &self,
    ) -> Result<Vec<crate::mcp::McpServerConfig>, String> {
        let slots = self.slots.lock().map_err(|e| e.to_string())?;
        Ok(slots.runtime.clone().unwrap_or_default())
    }

    /// wire 载荷读路径（P1/E10 + #703 修复）：命中直接返回；miss 在**同一把
    /// slots 锁内**从 runtime 槽重算并回填——重算与并发 `commit` 互斥，
    /// 「按旧 runtime 算出、覆写新缓存」的窗口不存在。计算成本有界
    /// （≤32 server 校验 + 序列化），持锁可接受。
    pub(crate) fn wire_servers(&self) -> Result<Vec<serde_json::Value>, String> {
        let mut slots = self.slots.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = slots.wire.clone() {
            return Ok(cached);
        }
        let values =
            crate::mcp::serialize_for_session(&slots.runtime.clone().unwrap_or_default())?;
        slots.wire = Some(values.clone());
        Ok(values)
    }

    /// 提交（原 set_mcp_servers 锁内段）：写序锁内两槽同锁提交 + 落盘序号登记。
    /// `persist_path` 由调用方预先解析（None = 路径不可解析，只提交内存不落盘，
    /// 与原行为一致）。返回 Some((version, path)) = 需要落盘（调用方
    /// spawn_blocking 执行，不持本锁等待磁盘）。
    pub(crate) async fn commit(
        &self,
        servers: Option<Vec<crate::mcp::McpServerConfig>>,
        serialized: Vec<serde_json::Value>,
        persist_path: Option<std::path::PathBuf>,
    ) -> Option<(u64, std::path::PathBuf)> {
        let write_guard = self.write_lock.lock().await;
        {
            let mut slots = self
                .slots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            slots.runtime = servers;
            slots.wire = Some(serialized);
        }
        persist_path.map(|path| (self.persist_order.begin(&write_guard), path))
    }

    /// 启动恢复直写 runtime 槽（原 setup_restore_mcp_config 直写 runtime_mcp）。
    /// wire 槽保持 None——恢复后首次读取在 `wire_servers` 内回填（E3 自愈，
    /// 语义与原实现一致）。
    pub(crate) fn restore(&self, servers: Vec<crate::mcp::McpServerConfig>) {
        let mut slots = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slots.runtime = Some(servers);
        slots.wire = None;
    }

    /// 落盘序号句柄（spawn_persist_mcp_servers 消费）。
    pub(crate) fn persist_order(&self) -> Arc<McpPersistOrder> {
        self.persist_order.clone()
    }
}

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
    // O13：单次 clone（validate 消耗 clone，原值 move 进域槽位；
    // 落盘快照在锁外 clone 一次，无二次序列化）。
    let serialized =
        crate::mcp::validate_and_serialize(servers.clone()).map_err(PylonError::Command)?;
    let persist_servers = servers.clone().unwrap_or_default();
    // C8/#707-A：两槽同锁提交 + 登记落盘序号全程持写序锁（McpDomain::commit）——
    // 并发 set_mcp_servers 的内存提交与序号顺序一致（磁盘必为最后一次设置）。
    // #683：磁盘 IO 不在锁内——序号登记后立即释放锁，写盘在 spawn_blocking。
    // 落盘路径预先解析（失败只 warn 不阻断，与原实现一致）。
    let persist_path = match mcp_persist_path(state.inner()) {
        Ok(path) => Some(path),
        Err(error) => {
            tracing::warn!("resolve MCP persist path failed: {}", error.raw_message());
            None
        }
    };
    let persist = state
        .inner()
        .mcp
        .commit(servers, serialized.clone(), persist_path)
        .await;
    // B4.2：配置落盘（重启不丢）。写失败只 warn，不阻断本次设置。
    if let Some((version, path)) = persist {
        spawn_persist_mcp_servers(
            state.inner().mcp.persist_order(),
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

#[cfg(test)]
mod mcp_domain_tests {
    use super::*;

    /// #707-A：读路径契约——miss（启动恢复 restore 形态）回填、命中短路、
    /// commit 后读取一致。
    #[tokio::test]
    async fn wire_read_miss_backfills_hit_short_circuits_and_commit_converges() {
        let domain = McpDomain::new();
        // miss：restore 直写 runtime 槽（wire None）→ 首读回填。
        domain.restore(vec![]);
        let first = domain.wire_servers().expect("miss 回退必须成功");
        assert!(first.is_empty(), "空配置 → 空 wire 数组");
        assert_eq!(
            domain.wire_servers().expect("回填后读取"),
            first,
            "回填后读取与首次一致"
        );
        // commit：两槽同锁提交 → 读路径返回新值。
        let serialized = vec![serde_json::json!({"name": "committed-mcp"})];
        let persist = domain.commit(Some(vec![]), serialized.clone(), None).await;
        assert!(persist.is_none(), "persist_path=None 不登记落盘");
        assert_eq!(
            domain.wire_servers().expect("commit 后读取"),
            serialized,
            "读路径必须反映最后一次 commit"
        );
        assert!(
            domain.current_servers().unwrap().is_empty(),
            "runtime 槽与 wire 槽同锁提交"
        );
    }

    /// #703：并发 commit 与 wire 读交错——最终读必须等于最后一次 commit。
    /// 单一 slots 锁下「按旧值算出、覆写新缓存」的窗口结构性不存在；本测试
    /// 以压力交错做回归证据（旧实现下该断言可被读回填竞态打破）。
    #[tokio::test]
    async fn concurrent_commit_and_wire_read_converge_to_last_commit() {
        let domain = std::sync::Arc::new(McpDomain::new());
        let rounds = 64u64;
        let mut tasks = Vec::new();
        for writer in 0..4u64 {
            let domain = domain.clone();
            tasks.push(tokio::spawn(async move {
                for round in 0..rounds {
                    let value = writer * rounds + round;
                    let serialized = vec![serde_json::json!({"name": format!("m{value}")})];
                    domain.commit(Some(vec![]), serialized, None).await;
                }
            }));
        }
        let mut readers = Vec::new();
        for _ in 0..4 {
            let domain = domain.clone();
            readers.push(tokio::spawn(async move {
                for _ in 0..128 {
                    let _ = domain.wire_servers().expect("并发读不得失败");
                }
            }));
        }
        for task in tasks.into_iter().chain(readers) {
            task.await.expect("task must not panic");
        }
        let wire = domain.wire_servers().expect("final read");
        let last_name = wire[0]["name"].as_str().expect("marker").to_string();
        assert_eq!(
            last_name,
            format!("m{}", 3 * rounds + (rounds - 1)),
            "最终读必须等于最后一次 commit（无旧值覆写）"
        );
    }
}
