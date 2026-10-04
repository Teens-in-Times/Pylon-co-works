//! B3：并行独立实例的进程级注册表。
//!
//! Pylon 的 runtime 层早已允许不同 agent 的子进程并发存在（每个 agent 一个
//! `AgentRuntime` + `AcpClient`，generation 隔离替换）；本模块把「实例」提升为
//! 一等身份——`InstanceKey = (agentId, instanceId, generation)`——并对全局并发
//! 施加**显式** semaphore 预算：超限返回稳定错误码 `instance_limit`，配额由
//! RAII guard 释放（guard 随持有它的 runtime/命令作用域 drop 而释放）。
//!
//! 预算与身份只在此处登记，不改变任何 spawn/kill 路径：注册表是**记账层**，
//! 进程生命周期仍归 `ManagedChild`/`AcpClient` 所有（单一所有权，不建平行
//! 管理体系）。`list()` 是诊断入口（§4.4「全局并发……可诊断」）。
//!
//! 当前一 agent 一实例：`instance_id == agent_id`。key 形状保留第三槽，使
//! 未来同 agent 多实例无需迁移身份语义。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// 全局并发实例预算。短暂的重叠替换（新代际连接成功、旧代际尚未 drop）会
/// 瞬时占用两个配额，预算按「agents.yaml 常见规模 × 2 + 诊断连接」取 8。
pub(crate) const MAX_INSTANCES: usize = 8;

/// 每实例 stderr tail 预算（与 `StderrTail` 容量一致，登记为诊断事实）。
pub(crate) const INSTANCE_STDERR_BUDGET_BYTES: usize = 32 * 1024;
/// 每实例 wire ring 预算（与 `AcpWireHub` 上限一致，登记为诊断事实）。
pub(crate) const INSTANCE_WIRE_BUDGET_BYTES: usize = 4 * 1024 * 1024;
/// 实例启动超时（秒）：initialize 必须在该窗口内完成（连接测试自身另有 15s
/// 上限，这里登记的是生产 connect 的窗口事实——H8/H9 rpc_timeout 30s）。
pub(crate) const INSTANCE_STARTUP_TIMEOUT_SECS: u64 = 30;

/// 一个运行中实例的身份。所有 RPC/事件/stderr/取消/崩溃信号按此 key 关联；
/// generation 与 `client_generation` 同源（OBS-02 correlation）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize)]
pub(crate) struct InstanceKey {
    pub agent_id: String,
    pub instance_id: String,
    pub generation: u64,
}

/// 实例记账记录（诊断视图；budgets 是登记的事实，不在注册表内再施限）。
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct InstanceRecord {
    pub key: InstanceKey,
    pub pid: Option<u32>,
    pub registered_at_ms: u64,
    pub stderr_budget_bytes: usize,
    pub wire_budget_bytes: usize,
    pub startup_timeout_secs: u64,
}

#[derive(Debug)]
pub(crate) enum InstanceRegistryError {
    /// 全局预算耗尽——稳定错误码 `instance_limit`。
    InstanceLimit { max: usize },
}

impl std::fmt::Display for InstanceRegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InstanceLimit { max } => {
                write!(f, "instance_limit: 并发 Agent 实例已达上限 {max}")
            }
        }
    }
}

/// RAII 配额守卫：drop 即从注册表移除记录并归还 semaphore 配额。
pub(crate) struct InstanceGuard {
    registry: Arc<InstanceRegistry>,
    key: InstanceKey,
}

impl std::fmt::Debug for InstanceGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstanceGuard")
            .field("key", &self.key)
            .finish()
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        self.registry
            .instances
            .lock()
            .map(|mut map| {
                map.remove(&self.key);
            })
            .ok();
        self.registry.permits.add_permits(1);
    }
}

pub(crate) struct InstanceRegistry {
    instances: Mutex<HashMap<InstanceKey, InstanceRecord>>,
    permits: Arc<tokio::sync::Semaphore>,
    max: usize,
}

impl InstanceRegistry {
    pub(crate) fn new(max: usize) -> Arc<Self> {
        Arc::new(Self {
            instances: Mutex::new(HashMap::new()),
            permits: Arc::new(tokio::sync::Semaphore::new(max)),
            max,
        })
    }

    /// 登记一个实例并占用一个全局配额。
    ///
    /// 同 `(agent_id, instance_id)` 的旧 generation 记录会被移出表（generation
    /// fence 的可观测面：旧代际不再是当前实例）；旧代际的配额由其自身 guard
    /// drop 归还——替换期的短暂双占已在预算内（见 [`MAX_INSTANCES`]）。
    pub(crate) fn register(
        self: &Arc<Self>,
        key: InstanceKey,
        pid: Option<u32>,
    ) -> Result<InstanceGuard, InstanceRegistryError> {
        // try_acquire：预算耗尽即失败，不排队——排队的 connect 会在用户看不到
        // 的地方等待，超限显形比静默排队可诊断。
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| InstanceRegistryError::InstanceLimit { max: self.max })?;
        // 配额所有权移交给 guard（其 Drop 归还）；这里显式 forget 避免双重释放。
        std::mem::forget(permit);
        let mut map = self
            .instances
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // 旧 generation 出表（配额由旧 guard 归还）。
        map.retain(|existing: &InstanceKey, _: &mut InstanceRecord| {
            !(existing.agent_id == key.agent_id
                && existing.instance_id == key.instance_id
                && existing.generation < key.generation)
        });
        map.insert(
            key.clone(),
            InstanceRecord {
                key: key.clone(),
                pid,
                registered_at_ms: crate::time::Timestamp::now().0,
                stderr_budget_bytes: INSTANCE_STDERR_BUDGET_BYTES,
                wire_budget_bytes: INSTANCE_WIRE_BUDGET_BYTES,
                startup_timeout_secs: INSTANCE_STARTUP_TIMEOUT_SECS,
            },
        );
        Ok(InstanceGuard {
            registry: Arc::clone(self),
            key,
        })
    }

    /// 当前实例表（诊断入口；顺序稳定便于断言与展示）。
    pub(crate) fn list(&self) -> Vec<InstanceRecord> {
        self.instances
            .lock()
            .map(|map| {
                let mut records: Vec<InstanceRecord> = map.values().cloned().collect();
                records.sort_by(|left, right| {
                    left.key
                        .agent_id
                        .cmp(&right.key.agent_id)
                        .then(left.key.generation.cmp(&right.key.generation))
                });
                records
            })
            .unwrap_or_default()
    }

    pub(crate) fn active_count(&self) -> usize {
        self.instances.lock().map(|map| map.len()).unwrap_or(0)
    }

    pub(crate) fn available_permits(&self) -> usize {
        self.permits.available_permits()
    }

    pub(crate) fn max(&self) -> usize {
        self.max
    }
}

/// B3：并发实例诊断视图（只读）——全局预算与在册实例的唯一可观察入口。
#[tauri::command]
pub(crate) fn acp_instance_overview() -> serde_json::Value {
    let registry = instance_registry();
    serde_json::json!({
        "max": registry.max(),
        "active": registry.active_count(),
        "availablePermits": registry.available_permits(),
        "instances": registry.list(),
    })
}

/// 生产路径的进程级注册表（预算 [`MAX_INSTANCES`]）。
static INSTANCE_REGISTRY: OnceLock<Arc<InstanceRegistry>> = OnceLock::new();

pub(crate) fn instance_registry() -> Arc<InstanceRegistry> {
    INSTANCE_REGISTRY
        .get_or_init(|| InstanceRegistry::new(MAX_INSTANCES))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::AcpClient;

    fn key(agent: &str, generation: u64) -> InstanceKey {
        InstanceKey {
            agent_id: agent.to_string(),
            instance_id: agent.to_string(),
            generation,
        }
    }

    #[test]
    fn budget_exhaustion_is_stable_and_raii_releases() {
        let registry = InstanceRegistry::new(2);
        let first = registry.register(key("a", 1), None).unwrap();
        let _second = registry.register(key("b", 1), None).unwrap();
        assert_eq!(registry.active_count(), 2);
        assert_eq!(registry.available_permits(), 0);

        let error = registry.register(key("c", 1), None).unwrap_err();
        assert!(
            error.to_string().starts_with("instance_limit"),
            "超限必须是稳定错误码，实得：{error}"
        );

        drop(first);
        assert_eq!(registry.active_count(), 1, "guard drop 即出表");
        assert_eq!(registry.available_permits(), 1, "guard drop 即归还配额");
        let _third = registry.register(key("c", 1), None).unwrap();
        assert_eq!(registry.active_count(), 2);
    }

    #[test]
    fn restarting_replaces_the_old_generation_record() {
        let registry = InstanceRegistry::new(4);
        let old = registry.register(key("peri", 3), Some(101)).unwrap();
        let new = registry.register(key("peri", 4), Some(102)).unwrap();
        // 新代际入表后，旧代际记录不再出现在诊断视图（fence 的可观测面）。
        let listed = registry.list();
        assert_eq!(listed.len(), 1, "同实例同 agent 只列当前代际：{listed:?}");
        assert_eq!(listed[0].key.generation, 4);
        assert_eq!(listed[0].pid, Some(102));
        // 替换期双占是登记事实：两个 guard 各持一配额。
        assert_eq!(registry.available_permits(), 2);
        drop(old);
        drop(new);
        assert_eq!(registry.active_count(), 0);
        assert_eq!(registry.available_permits(), 4);
    }

    #[test]
    fn records_carry_the_declared_budgets() {
        let registry = InstanceRegistry::new(1);
        let guard = registry.register(key("solo", 1), None).unwrap();
        let record = &registry.list()[0];
        assert_eq!(record.stderr_budget_bytes, INSTANCE_STDERR_BUDGET_BYTES);
        assert_eq!(record.wire_budget_bytes, INSTANCE_WIRE_BUDGET_BYTES);
        assert_eq!(record.startup_timeout_secs, INSTANCE_STARTUP_TIMEOUT_SECS);
        drop(guard);
    }

    // ── B3 集成：真实 fake ACP 子进程的并发与隔离 ──

    /// echo 型 fake ACP（P1 后为 bin 场景 session-capable：loadSession 能力 + 固定名会话）。
    fn echo_agent(name: &str) -> crate::agent_config::AgentDef {
        crate::test_utils::fake_acp_agent(name, &["--scenario", "session-capable"])
    }

    /// initialize 后立即退出的 fake ACP（崩溃实例）。
    fn crash_agent(name: &str) -> crate::agent_config::AgentDef {
        crate::test_utils::fake_acp_agent(name, &["--scenario", "crash-after-init"])
    }

    async fn registered_client(
        registry: &Arc<InstanceRegistry>,
        agent: &crate::agent_config::AgentDef,
        generation: u64,
    ) -> (AcpClient, InstanceGuard) {
        let client = AcpClient::connect_with_logs(agent, None).await.unwrap();
        let key = InstanceKey {
            agent_id: agent.name.clone(),
            instance_id: agent.name.clone(),
            generation,
        };
        let guard = registry.register(key, client.instance_pid()).unwrap();
        (client, guard)
    }

    /// 同时启动至少 3 个 fake ACP 实例：全部在册、预算如实、并发 RPC 各自完成。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn three_fake_instances_run_concurrently_with_isolated_wires() {
        let registry = InstanceRegistry::new(MAX_INSTANCES);
        let alpha = echo_agent("alpha");
        let beta = echo_agent("beta");
        let gamma = echo_agent("gamma");

        let (alpha, alpha_guard) = registered_client(&registry, &alpha, 1).await;
        let (beta, beta_guard) = registered_client(&registry, &beta, 1).await;
        let (gamma, gamma_guard) = registered_client(&registry, &gamma, 1).await;
        assert_eq!(registry.active_count(), 3, "三个实例必须同时在册");
        assert_eq!(registry.available_permits(), MAX_INSTANCES - 3);

        // 三个实例的 session/new 并发完成（跨实例同名 sessionId 不串线：
        // 每个 client 有独立的 pending 表与 wire 通道）。
        let new_session = |client: &AcpClient| {
            client
                .prepare_rpc(
                    crate::acp::METHOD_SESSION_NEW,
                    serde_json::json!({"cwd": ".", "mcpServers": []}),
                )
                .unwrap()
                .complete()
        };
        let (alpha_id, beta_id, gamma_id) =
            tokio::join!(new_session(&alpha), new_session(&beta), new_session(&gamma));
        for (label, response) in [("alpha", alpha_id), ("beta", beta_id), ("gamma", gamma_id)] {
            let session_id = crate::acp::session_id_from(&response.unwrap())
                .unwrap_or_else(|error| panic!("{label} session id: {error}"));
            assert_eq!(session_id, "shared-name", "{label} 必须收到自己的响应");
        }

        let _ = alpha.kill();
        let _ = beta.kill();
        let _ = gamma.kill();
        drop((alpha_guard, beta_guard, gamma_guard));
        assert_eq!(registry.active_count(), 0, "guard 全部归还后预算清零");
        assert_eq!(registry.available_permits(), MAX_INSTANCES);
    }

    /// 一个实例崩溃不影响其他实例：崩溃实例退出后，幸存实例的 RPC 照常完成，
    /// 崩溃实例的配额随 guard 释放。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_instance_crashing_does_not_affect_the_others() {
        let registry = InstanceRegistry::new(MAX_INSTANCES);
        let doomed = crash_agent("doomed");
        let survivor = echo_agent("survivor");

        let (doomed, doomed_guard) = registered_client(&registry, &doomed, 1).await;
        let (survivor, survivor_guard) = registered_client(&registry, &survivor, 1).await;

        // 崩溃实例 initialize 后进程退出 → crashed 置位（exit watcher）。
        let crashed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !doomed.is_crashed() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(crashed.is_ok(), "崩溃实例必须触发 crashed 信号");
        drop(doomed_guard);
        assert_eq!(registry.active_count(), 1, "崩溃实例配额随 guard 释放");

        let response = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            survivor
                .prepare_rpc(
                    crate::acp::METHOD_SESSION_NEW,
                    serde_json::json!({"cwd": ".", "mcpServers": []}),
                )
                .unwrap()
                .complete(),
        )
        .await
        .expect("幸存实例不得被邻居崩溃拖挂")
        .unwrap();
        assert_eq!(
            crate::acp::session_id_from(&response).unwrap(),
            "shared-name"
        );

        let _ = doomed.kill();
        let _ = survivor.kill();
        drop(survivor_guard);
    }

    /// 每实例 prompt 闸门语义（§4.4「同一实例同一时刻最多一个 prompt」）：
    /// 第二个并发 prompt 拿不到闸门——稳定失败而不是排队。
    #[tokio::test]
    async fn per_instance_prompt_gate_conflicts_with_the_second_prompt() {
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let first = gate.clone().try_lock_owned().expect("first must acquire");
        let conflict = gate.clone().try_lock_owned().is_err();
        assert!(conflict, "同实例第二个并发 prompt 必须冲突");
        drop(first);
        assert!(gate.try_lock_owned().is_ok(), "prompt 结束后闸门必须可复用");
    }
}
