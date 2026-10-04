//! ACP 宿主适配层（#247 起）：协议引擎核已抽至 `pylon-acp` crate，本目录
//! 只保留实例注册表与依赖宿主 harness（test_utils / AppState）的表征测试。
//!
//! 路径保活：下方 glob 重导出维持 `crate::acp::{AcpClient, engine, negotiated,
//! error, …}` 全部既有调用点（消费者迁移另立期）；`From<AcpError> for
//! PylonError` 与 `capture_negotiated_snapshot` 因涉及宿主类型而留在此处。
pub use pylon_acp::*;

pub(crate) mod instance_registry;

#[cfg(test)]
mod catalog_driven_tests;
#[cfg(test)]
mod golden_trace_tests;
#[cfg(test)]
mod p1_wire_regression_tests;
#[cfg(test)]
mod real_acp_smoke;
#[cfg(test)]
mod tests;

// #247：原 pylon-acp::error 内的实现随宿主类型（PylonError）留驻——
// 孤儿规则要求本 impl 与 PylonError 同 crate。
// #317 批次二 2c：边界区分度保留——除既有 ReplayLoadInProgress→Storage 特判外，
// 其余变体整包委托 PylonError::AcpDomain（细分 code 经 AcpError::code 委托，
// 词汇表与 persist.rs 回放契约逐字一致）；protocol_error 不再吞 ACP 域失败。
impl From<pylon_acp::AcpError> for crate::error::PylonError {
    fn from(error: pylon_acp::AcpError) -> Self {
        if let pylon_acp::AcpError::ReplayLoadInProgress = error {
            return crate::error::PylonError::Storage(
                pylon_session::SessionError::ReplayLoadInProgress,
            );
        }
        crate::error::PylonError::AcpDomain(error)
    }
}

/// Q3 共享辅助（W1 R.4 PR-2，#416 W2 wave2 步骤 8）：negotiated 快照的
/// declared+consumers 收集与 `from_parts` 拼装单点化。双构造入口各自保留锁
/// 形态与 generation 装载位——`capture_negotiated_snapshot`（await 持锁）与
/// lib.rs agent_status 快照（try_lock 同步）——拼装面收敛本函数防漂移；
/// 四参输入与两入口原拼写逐点等值。
pub(crate) fn negotiated_snapshot_from_client(
    acp: &AcpClient,
    generation: u64,
) -> NegotiatedCapabilitySnapshot {
    let declared: Vec<String> = acp.establishment_order().to_vec();
    let consumers = negotiated::registered_capability_consumers();
    NegotiatedCapabilitySnapshot::from_parts(acp.capabilities(), &declared, generation, &consumers)
}

/// 从运行时现场捕获能力协商快照（#247 自 pylon-acp::negotiated 迁入——
/// 它持有 &AgentRuntime 的锁序约定，属宿主编排面）。
pub async fn capture_negotiated_snapshot(
    runtime: &crate::runtime::AgentRuntime,
) -> Result<NegotiatedCapabilitySnapshot, String> {
    let generation = runtime
        .client_generation
        .load(std::sync::atomic::Ordering::Acquire);
    let acp = runtime.snapshot_acp();
    Ok(negotiated_snapshot_from_client(&acp, generation))
}
