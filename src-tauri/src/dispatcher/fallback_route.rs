//! 未知帧兜底缝（#317 批次二 ④ 自 mod.rs 主泵分支迁入）：非 SessionUpdate 且
//! 无路由分支认识的帧——未知通知记日志（A1 探查修复），带 id+method 的 agent
//! 请求统一回 JSON-RPC Method Not Found（#99 评审 E4：Responder 不得永久滞留）。
//! 分支在主泵中为纯 `continue` 语义。

use super::{acp_snapshot, AcpLock};
use agent_client_protocol_schema::v1::ErrorCode as WireErrorCode;

/// 未知通知兜底：A1（探查修复）——未知通知不再静默丢弃——记 method，接新 agent 时
/// 从 runtime log 直接看到它发了哪些私有通道（如 peri/*），按需接入。
/// 正常响应（Response，method=None）已在 reader 经 pending 结算，不产生噪音。
/// #99（评审 E4）：带 id + method 的 agent 请求落到此处 = 没有任何
/// 分支认识它——spec 禁止静默丢弃（Responder 会永久滞留 pending
/// 表、agent 侧请求挂死）。统一回 JSON-RPC Method Not Found，
/// 应答同时消费 Responder、收敛 pending 条目。
pub(crate) async fn route_unknown_notification(acp: &AcpLock, raw: &crate::acp::RawMessage) {
    if raw.kind == crate::acp::AcpKind::OtherNotification {
        tracing::warn!(
            "ACP 收到未知通知 method={:?}（当前不处理，已丢弃）",
            raw.method
        );
    }
    if let (Some(request_id), Some(method)) = (raw.id.clone(), raw.method.as_deref()) {
        let responder = { acp_snapshot(acp).responder() };
        let _ = responder
            .respond_error(
                request_id,
                WireErrorCode::MethodNotFound,
                &format!("method not supported by client: {method}"),
            )
            .await;
    }
}
