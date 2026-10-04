//! 生命周期域时间预算常量归口（R.5-1 选项 b：宿主内落点，零行为变化的纯搬家）。
//!
//! # 三形状词法（新增预算必须声明形状与测量者）
//!
//! - **TotalDeadline**：绝对 deadline，测量含全部子阶段（如连接测试 15s 包裹全程）。
//! - **StageBudget**：每阶段 `min(声明预算, 剩余总预算)`（如检测版本探测 2s ∧ 剩余）。
//! - **Ttl**：缓存有效期（如检测快照 Success/Unknown/Failure = 600/60/15s）。
//!
//! # 归口边界（三类预算不同源，不假统一）
//!
//! - 本文件只收宿主 lifecycle 的 UX 上限秒数常量；
//! - 协议派生预算（`rpc_timeout`/prompt 族，agents.yaml 可配）的默认值唯一事实源在
//!   `pylon-core::agent_config`（`AgentDef` 值类型与协议默认值常量的既有归宿）；
//! - 检测预算（总预算 8s / 版本探测 2s / 并发 4）由 `AgentDetectionLimits` 注入，
//!   定义在 `pylon-core::agent_detection::types`；
//! - pylon-acp 域预算（EXEC_BUSY 退避 1s、replay deadline、CLI kernel 30s/300s）
//!   留在各自模块，不属于生命周期域。
//!
//! | 预算 | 值 | 形状 | 消费点 |
//! |---|---|---|---|
//! | `AGENT_VALIDATION_TIMEOUT_SECS` | 15s | TotalDeadline（tokio::timeout 包全程） | `connection_test` 两命令 |
//! | `SESSION_PROBE_HARD_CAP_SECS` | 30s | TotalDeadline（`min(rpc_timeout, 本值)`，全候选共享 deadline） | `session_probe` |
//! | `CONNECT_TOTAL_BUDGET_SECS` | 60s | TotalDeadline（tokio::timeout 包 `connect_with_generation` 全程） | `do_connect_and_replace`（四条生产 connect 路径） |

/// 隔离连接测试总预算（秒）：`test_agent_connection` / `test_agent_candidate`
/// 的 tokio::timeout 包裹值（「连接测试从开始到返回不超过 15 秒」的上限契约）。
pub(crate) const AGENT_VALIDATION_TIMEOUT_SECS: u64 = 15;

/// 会话 continuity probe 预算硬顶（秒）：实际预算 = `min(rpc_timeout, 本值)`，
/// 单一 deadline 由全部候选共享（并发 4 有界 probe）。
pub(crate) const SESSION_PROBE_HARD_CAP_SECS: u64 = 30;

/// 生产 connect 总预算（秒，#421）：`do_connect_and_replace` 对
/// `AcpClient::connect_with_generation` 的 TotalDeadline 包裹值——盖过 initialize
/// 的 `rpc_timeout`（默认 30s、可配至 300s）作为外层上限，死 agent 握手悬置时
/// 手动 switch/reconnect/restart 在此切断，双锁（switch_lock→agent_lifecycle）
/// 持有期随之有界。超时按既有 Crashed 收敛（不发明新 runtime 状态）。
pub(crate) const CONNECT_TOTAL_BUDGET_SECS: u64 = 60;

/// [`CONNECT_TOTAL_BUDGET_SECS`] 的解析口（#421）。生产恒取常量；单测经
/// `connect_budget_override` 短暂注入小预算以真子进程（hang 场景）驱动预算
/// 分支——引擎超时面混布 tokio 定时器与 std 线程，`start_paused` 模拟时钟
/// 对真实子进程 I/O 不可用（实测预算定时器不触发），故走注入而非模拟时钟。
pub(crate) fn connect_budget_secs() -> u64 {
    #[cfg(test)]
    {
        connect_budget_override::get()
    }
    #[cfg(not(test))]
    {
        CONNECT_TOTAL_BUDGET_SECS
    }
}

/// #421 测试注入缝：仅存在于本 crate 单测二进制。0 = 未注入（用默认常量）。
/// 消费者（set/Drop-clear 成对）**必须全程持有 [`connect_budget_override::INJECTION_LOCK`]**
/// ——注入值是进程全局，hang 场景测试并行时 set/clear 会互相踩（#451 批次
/// 实测：一方 clear 后另一方拿到 60s 预算，或对方「未注入」前置断言读到 2）。
#[cfg(test)]
pub(crate) mod connect_budget_override {
    use std::sync::atomic::{AtomicU64, Ordering};

    static OVERRIDE_SECS: AtomicU64 = AtomicU64::new(0);

    /// 注入互斥：消费者测试在 set 前锁住，Drop guard 里随 clear 一起释放
    /// （声明顺序：先锁后 RestoreBudget，逆序 drop 保证先清值再放锁）。
    pub(crate) static INJECTION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    pub(crate) fn set(secs: u64) {
        OVERRIDE_SECS.store(secs, Ordering::Release);
    }

    pub(crate) fn clear() {
        OVERRIDE_SECS.store(0, Ordering::Release);
    }

    pub(crate) fn get() -> u64 {
        let value = OVERRIDE_SECS.load(Ordering::Acquire);
        if value == 0 {
            super::CONNECT_TOTAL_BUDGET_SECS
        } else {
            value
        }
    }
}
