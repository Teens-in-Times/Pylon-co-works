//! SDK 出站与装配观测层（原 engine.rs 的 B 段，A1c 后拆分归位；行为零变化）。
//!
//! 承载 [`SdkBackend`] 传输状态、出站枚举 [`SdkOutbound`]、prepared RPC 的
//! SDK 半区（[`SdkPreparedRpc`]）与 wire 观测桥（[`run_wire_bridge`]）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::{ByteStreams, Channel, Responder};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::PreparedRpc;
use super::RawMessage;
use super::{InboundRelay, InboundTelemetry, PublishOutcome};
use crate::client::{ClassifiedMessage, NotificationInbox};
use crate::error::AcpError;
use crate::wire_trace::{AcpWireHub, WireDirection};

/// SDK 后端（官方 `agent-client-protocol` 连接）的传输状态。
///
/// 出站经有界 `outbound` 队列交给 `cx.spawn` 泵；入站直接产出
/// [`ClassifiedMessage`]，与 legacy 共用同一条 Kernel inbox 语义。
pub struct SdkBackend {
    pub outbound: mpsc::Sender<SdkOutbound>,
    /// D12：Pylon 相关 id 的本地计数器（wire id 永不暴露）。
    pub next_id: Arc<AtomicU64>,
    /// #548：入站 inbox 一次性移交——`Some` 只在宿主首次 `take_notification_inbox`
    /// 前存在；std 锁仅护 take 的短窗，锁内无 await。
    pub inbound: std::sync::Mutex<Option<NotificationInbox>>,
    /// #99：入站投递遥测（ingress 序列 cursor / spill / 过载 gap 计数）。
    pub telemetry: Arc<InboundTelemetry>,
    /// A1b：入站帧的 replay 观察扇出（legacy `rx` 的对应物）。
    pub replay_events: broadcast::Sender<ClassifiedMessage>,
    /// A1b：进行中的 replay 采集（Pylon id → sessionId），用于把匹配通知标记为 Replay。
    pub active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
    /// A1b：agent 发来的请求应答器（Pylon request id → Responder），供
    /// `ResponderHandle::Sdk` 在锁外应答。
    pub pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
    pub shutdown: watch::Sender<bool>,
    /// #549：kill 需 abort 引擎任务，而 kill 已 `&self` 化——`take` 的 `&mut`
    /// 收进 std 互斥（仅 kill 的短窗触碰）。
    pub join:
        std::sync::Mutex<Option<tokio::task::JoinHandle<Result<(), agent_client_protocol::Error>>>>,
    // A1c：`None` = 断开态（`AcpClient::disconnected()`），无引擎任务可 abort。
}

/// D11：后端中立应答句柄（在锁外使用，避免持锁等待写通道）。
///
/// A1c：legacy 写通道实现已删除；应答统一经引擎登记的 `Responder` 完成。
pub struct ResponderHandle {
    pub pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
}

impl ResponderHandle {
    /// 应答 agent 发来的 JSON-RPC 请求。
    pub async fn respond(self, request_id: super::RequestId, response: serde_json::Value) -> bool {
        let responder = self
            .pending_requests
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id));
        match responder {
            Some(responder) => responder.respond(response).is_ok(),
            None => false,
        }
    }

    /// 以 JSON-RPC error 应答 agent 发来的请求。
    /// #316：错误码由官方 `ErrorCode` 枚举收口（魔数词表消除；wire 数值不变）。
    pub async fn respond_error(
        self,
        request_id: super::RequestId,
        code: agent_client_protocol_schema::v1::ErrorCode,
        message: &str,
    ) -> bool {
        let responder = self
            .pending_requests
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id));
        match responder {
            Some(responder) => responder
                .respond_with_error(agent_client_protocol::Error::new(i32::from(code), message))
                .is_ok(),
            None => false,
        }
    }
}

/// 引擎连接配置（仅用于日志/诊断，不参与 canonical 身份）。
#[derive(Debug, Clone)]
pub struct SdkEngineConfig {
    /// 连接名（SDK 日志用）。
    pub name: String,
    pub wire: Arc<AcpWireHub>,
}

/// D12：`PreparedRpc` 的 SDK 专属状态（`id` 由 facade 持有）。
///
/// `id` 是 **Pylon 相关 id**（本地计数器）；wire id 永不暴露。
pub struct SdkPreparedRpc {
    pub outbound: mpsc::Sender<SdkOutbound>,
    pub method: String,
    pub params: serde_json::Value,
    pub rpc_timeout: std::time::Duration,
}

/// 发送请求行，成功时返回响应接收器。
pub async fn send_keep_rx_prepared(
    prepared: PreparedRpc,
) -> Result<oneshot::Receiver<RawMessage>, AcpError> {
    let pylon_id = prepared.id;
    let sdk = prepared.sdk;
    // A1b：把 SDK 的响应回调转回 `oneshot::Receiver<RawMessage>`，
    // 让 `wait_prompt_with_recovery` 的双超时/cancel/settle 机制原样复用。
    let (ready_tx, ready_rx) = oneshot::channel();
    sdk.outbound
        .send(SdkOutbound::RequestKeepRx {
            method: sdk.method,
            params: sdk.params,
            ready: ready_tx,
        })
        .await
        .map_err(|_| AcpError::ConnectionClosed)?;
    let response_rx = ready_rx.await.map_err(|_| AcpError::ConnectionClosed)??;
    let (out_tx, out_rx) = oneshot::channel();
    tokio::spawn(async move {
        let raw = match response_rx.await {
            Ok(Ok(value)) => RawMessage {
                id: Some(super::RequestId::Number(pylon_id)),
                method: None,
                kind: crate::AcpKind::Response,
                result: Some(value),
                params: None,
                error: None,
            },
            Ok(Err(error)) => RawMessage {
                id: Some(super::RequestId::Number(pylon_id)),
                method: None,
                kind: crate::AcpKind::Response,
                result: None,
                params: None,
                error: Some(serde_json::json!(error.to_string())),
            },
            Err(_) => return,
        };
        let _ = out_tx.send(raw);
    });
    Ok(out_rx)
}

/// 发送 + 等待匹配响应（SDK 走 outbound 泵）。
pub async fn complete_prepared(prepared: PreparedRpc) -> Result<serde_json::Value, AcpError> {
    let sdk = prepared.sdk;
    let (reply_tx, reply_rx) = oneshot::channel();
    sdk.outbound
        .send(SdkOutbound::Request {
            method: sdk.method,
            params: sdk.params,
            reply: reply_tx,
        })
        .await
        .map_err(|_| AcpError::ConnectionClosed)?;
    match tokio::time::timeout(sdk.rpc_timeout, reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(AcpError::ConnectionClosed),
        Err(_) => Err(AcpError::RpcTimeout),
    }
}

/// D12：SDK 后端的 `PreparedRpc` 构造（本地计数器分配 Pylon id，wire id 永不暴露）。
pub fn prepared_sdk_rpc(
    sdk: &SdkBackend,
    method: &str,
    params: serde_json::Value,
    rpc_timeout_secs: u64,
) -> Result<PreparedRpc, AcpError> {
    let id = sdk.next_id.fetch_add(1, Ordering::Relaxed);
    Ok(PreparedRpc {
        id,
        sdk: SdkPreparedRpc {
            outbound: sdk.outbound.clone(),
            method: method.to_string(),
            params,
            rpc_timeout: std::time::Duration::from_secs(rpc_timeout_secs),
        },
    })
}

/// 一条出站请求/通知（由 Pylon 既有 `prepare_rpc`/`prepare_prompt` 语义产生）。
///
/// SDK 的 dispatch loop 是单任务串行，因此出站一律经 `cx.spawn` 在独立任务中发送；
/// 本类型只承载「方法 + 参数 + 应答通道」，不复制 Pylon 的 pending 表。
pub enum SdkOutbound {
    /// 需要响应的 JSON-RPC 请求（非类型化）。
    Request {
        method: String,
        params: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<Result<serde_json::Value, AcpError>>,
    },
    /// A1b：发送后把响应接收器交回调用方（prompt 等待/取消语义复用 legacy 机制）。
    RequestKeepRx {
        method: String,
        params: serde_json::Value,
        ready: tokio::sync::oneshot::Sender<
            Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, AcpError>>, AcpError>,
        >,
    },
    /// 不需要响应的 JSON-RPC 通知。
    Notification {
        method: String,
        params: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<Result<(), AcpError>>,
    },
}

/// SDK 错误 → Pylon `AcpError`。
///
/// 四个 Pylon 独有变体（`ReplayTimeout`/`ReplayLagged`/`ReplayStreamClosed`/
/// `ReplayLoadInProgress`）由 Pylon 侧合成，不由 SDK 映射而来（施工书 A1-C6）。
pub fn map_sdk_error(error: agent_client_protocol::Error) -> AcpError {
    if agent_client_protocol::is_incoming_transport_closed(&error) {
        return AcpError::ConnectionClosed;
    }
    // 与 legacy 一致：把 JSON-RPC error 对象序列化为文本，下游
    // `AgentConnectFailure::initialize` 才能提取 `code`/`message`（远端 code 不丢）。
    match serde_json::to_string(&error) {
        Ok(raw) => AcpError::Rpc(raw),
        Err(_) => AcpError::Rpc(error.to_string()),
    }
}

/// SDK wire request id → Pylon `RequestId`（null/absent → None）。
pub(super) fn sdk_request_id_to_pylon(
    id: &agent_client_protocol::schema::v1::RequestId,
) -> Option<super::RequestId> {
    match id {
        agent_client_protocol::schema::v1::RequestId::Number(number) => {
            u64::try_from(*number).ok().map(super::RequestId::Number)
        }
        agent_client_protocol::schema::v1::RequestId::Str(text) => {
            Some(super::RequestId::String(text.clone()))
        }
        agent_client_protocol::schema::v1::RequestId::Null => None,
    }
}

/// A1b：标记 replay 分类并投递（broadcast 扇出 + 可靠中继）。
///
/// #99 变更：ingress ordinal 分配与投递全部收敛在 [`InboundRelay::relay`]——
/// inbox 满转入有界 spill 续投，spill 溢出以显式过载终态收敛连接。禁止
/// `try_send` 失败后仅打日志继续运行（旧行为会静默丢帧，已被本函数取代）。
pub(super) fn publish_inbound(
    mut classified: ClassifiedMessage,
    replay_events: &broadcast::Sender<ClassifiedMessage>,
    active_replay_requests: &Arc<Mutex<HashMap<u64, String>>>,
    relay: &InboundRelay,
) -> PublishOutcome {
    // ordinal 在 clone/broadcast 之前分配：broadcast（replay 观察扇出）副本与
    // inbox 帧携带同一序号，live/replay/boundary 共用同一序列模型（评审 E10）。
    // relay 内的 assign-if-zero 只兜底直调路径（测试/过载崩溃帧）。
    if classified.ingress_seq == 0 {
        classified.ingress_seq = relay.telemetry.allocate_seq();
    }
    // A replay response is the deterministic boundary of the load operation.
    // Keep this classification on the transport message itself so observers
    // do not have to infer it from the response channel.
    // (#260-B4) 两次读取合并为一次持锁：boundary 与 replay 两判定共享同一份
    // 快照，判定顺序不变；锁中毒时两判定都跳过，与旧「各自 if let Ok」一致。
    if let Ok(active) = active_replay_requests.lock() {
        if let Some(super::RequestId::Number(id)) = classified.raw.id.as_ref() {
            if active.contains_key(id) {
                classified.classification =
                    crate::ReplayClassification::Boundary { request_id: *id };
            }
        }
        if let Some(session_id) = classified
            .raw
            .params
            .as_ref()
            .and_then(|params| params.get("sessionId"))
            .and_then(serde_json::Value::as_str)
        {
            if classified.classification == crate::ReplayClassification::Live {
                if let Some((request_id, _)) =
                    active.iter().find(|(_, id)| id.as_str() == session_id)
                {
                    classified.classification = crate::ReplayClassification::Replay {
                        request_id: *request_id,
                    };
                }
            }
        }
    }
    // (#260-B4) 零订阅者跳过整帧深克隆：broadcast send 对无接收者本就是被吞的
    // no-op。不变量：replay.rs 的 subscribe 严格先于 session/load 发出，故
    // rc==0 时被跳过的帧必在 load 点之前，journal 重放会覆盖。
    if replay_events.receiver_count() > 0 {
        let _ = replay_events.send(classified.clone());
    }
    relay.relay(classified)
}

/// 构造 SDK 侧 transport 与观测桥之间的四端 `Channel` 拓扑。
///
/// 拓扑：`sdk_end <-> inspect_left  ==bridge==  inspect_right <-> child_end`。
/// `child_end` 由调用方接到子进程字节流（`ConnectTo`）。
/// 仅测试消费：生产拓扑（`spawn_sdk_engine`）的 child 侧不走独立 duplex 通道，
/// 由 `ConnectTo::into_channel_and_future` 直接给出。
#[cfg(test)]
pub fn bridge_channels() -> (Channel, Channel, Channel, Channel) {
    let (sdk_end, inspect_left) = Channel::duplex();
    let (inspect_right, child_end) = Channel::duplex();
    (sdk_end, inspect_left, inspect_right, child_end)
}

/// 运行观测桥：两个方向逐帧写入 `AcpWireHub`，原帧原样转发。
///
/// 使用 SDK 的 `bridge_with_inspection`，在 SDK 与子进程之间原样转发帧并
/// 记录 wire capture。该 API 对 batch 内每条消息调用 observer，因此保留
/// `RequestId` 的 number/string/null 形态。
pub async fn run_wire_bridge(
    inspect_left: Channel,
    inspect_right: Channel,
    hub: Arc<AcpWireHub>,
) -> Result<(), agent_client_protocol::Error> {
    let outbound = hub.clone();
    let inbound = hub;
    Channel::bridge_with_inspection(
        inspect_left,
        inspect_right,
        move |message| {
            observe_message(message, &outbound, WireDirection::PylonToAgent);
            Ok(())
        },
        move |message| {
            observe_message(message, &inbound, WireDirection::AgentToPylon);
            Ok(())
        },
    )
    .await
}

fn observe_message(
    message: &agent_client_protocol::RawJsonRpcMessage,
    hub: &AcpWireHub,
    direction: WireDirection,
) {
    if let Ok(value) = serde_json::to_value(message) {
        match direction {
            WireDirection::PylonToAgent => hub.capture_request(&value),
            WireDirection::AgentToPylon => hub.capture_agent_message(&value),
        }
    }
}

/// 观测一条传输帧内的全部有效消息（batch 逐条）。
/// 用 `tokio_util::compat::Compat` 把 tokio 读写半流适配成 SDK 需要的 futures 字节流。
pub fn byte_streams<R, W>(read: R, write: W) -> ByteStreams<Compat<W>, Compat<R>>
where
    R: tokio::io::AsyncRead + Send + 'static,
    W: tokio::io::AsyncWrite + Send + 'static,
{
    ByteStreams::new(write.compat_write(), read.compat())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::fake_acp_agent_stub;
    use super::*;
    use agent_client_protocol::schema::v1::RequestId;
    use agent_client_protocol::{RawJsonRpcMessage, TransportFrame};
    use std::time::Duration;

    /// A1a 步骤 3 证据：观测桥逐帧写入 `AcpWireHub`（两个方向、id 形态保持）。
    #[tokio::test]
    async fn wire_bridge_records_both_directions_with_id_kind() {
        let (mut sdk_end, inspect_left, inspect_right, child_end) = bridge_channels();
        let agent = fake_acp_agent_stub("fake-acp-bridge");
        let hub = AcpWireHub::for_agent(&agent, 1);
        let bridge = tokio::spawn(run_wire_bridge(inspect_left, inspect_right, hub.clone()));

        // agent → pylon：string id 请求帧（形态必须原样保留）
        let inbound = RawJsonRpcMessage::request(
            "session/request_permission".to_string(),
            serde_json::json!({"sessionId": "s-1"}),
            RequestId::Str("str-1".to_string()),
        )
        .expect("inbound request frame");
        child_end
            .tx
            .unbounded_send(TransportFrame::Single(inbound))
            .expect("child send");
        let forwarded = tokio::time::timeout(Duration::from_secs(5), sdk_end.rx.recv())
            .await
            .expect("bridge must forward frame")
            .expect("sdk side must stay open");
        assert!(matches!(forwarded, TransportFrame::Single(_)));

        // pylon → agent：number id 请求帧
        let outbound = RawJsonRpcMessage::request(
            "session/prompt".to_string(),
            serde_json::json!({"sessionId": "s-1"}),
            RequestId::Number(7),
        )
        .expect("outbound request frame");
        sdk_end
            .tx
            .unbounded_send(TransportFrame::Single(outbound))
            .expect("sdk send");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let records = loop {
            let records = hub.snapshot();
            if records.len() >= 2 {
                break records;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "wire hub must record both frames"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].direction, WireDirection::AgentToPylon);
        assert_eq!(records[0].id_kind, crate::wire_trace::WireIdKind::String);
        assert_eq!(records[1].direction, WireDirection::PylonToAgent);
        assert_eq!(records[1].id_kind, crate::wire_trace::WireIdKind::Number);

        bridge.abort();
        let _ = bridge.await;
    }
}
