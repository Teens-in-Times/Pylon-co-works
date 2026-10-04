//! A1a：官方 SDK 连接引擎（D1=①）。
//!
//! 本模块是 SDK 唯一后端的**装配根**：把 `agent-client-protocol 2.2.0` 的连接、
//! 字节桥与 wire 观测接到 Pylon 既有的 `AcpWireHub` 上。Pylon 的业务纪律
//! （canonical 单一写者、owner/generation 校验、commit-before-publish）仍由
//! dispatcher/session 层负责，本模块不复制第二套状态。
//!
//! 模块布局（原 engine.rs 巨石拆分，行为零变化）：
//! - 本文件（mod.rs）：装配根 [`spawn_sdk_engine`]/`spawn_sdk_client`、容量常量、
//!   `RequestId`/`PreparedRpc` 共享词表，与对各子模块的 re-export（lib.rs 的
//!   `pub use engine::{...}` 公开面逐字不变）；
//! - [`inbound`]：#99 入站背压（`InboundRelay`/spill/续投泵/崩溃控制帧）；
//! - [`outbound`]：SDK 出站与观测（`SdkBackend`/`SdkOutbound`/wire 观测桥）；
//! - [`prompt_wait`]：prompt 等待/判死/cancel-settle 状态机与 `CrashReason` 词表。
//!
//! 进程 spawn 入口 `spawn_agent_child` 不在本模块：它与 `ManagedChild` 同域，
//! 住在 `process.rs`。
//!
//! 接缝要点（对应施工书 §4/A1a 步骤 2–4）：
//!
//! 1. 进程归属不变：子进程仍由 `ManagedChild`（Windows Job Object）持有，SDK 只做协议；
//! 2. 字节桥：`tokio_util::compat::Compat` 把 tokio 流适配为 futures 流后交给 `ByteStreams`；
//! 3. wire capture：在 SDK 与字节流之间插 `Channel`，用 `Channel::bridge_with_inspection`
//!    逐帧观测后**原样转发**，因此 `id` 的 number/string/null 形态不会被改写
//!    （施工书写作 `Channel::bridge`，实名为 `bridge_with_inspection`，已记台账勘误）；
//! 4. 入站分发走**非类型化** `Dispatch<UntypedMessage, UntypedMessage>`：handler 内
//!    只做转发，不做同步阻塞（施工书 §3 第 9 条）。
//!
//! A1a 步骤 5–7 已接线：`AcpClient::connect_with_generation`（client.rs）经
//! [`spawn_sdk_engine`] 把本模块接入生产路径——SDK 是唯一后端，legacy 传输
//! 已删除（原「接线前仅供测试」的模块级 `allow(dead_code)` 已随之摘除）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::{
    Channel, Client, ConnectTo, Dispatch, Handled, Responder, UntypedMessage,
};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use super::client::{ClassifiedMessage, NotificationInbox};
use super::error::AcpError;
use super::wire_trace::AcpWireCapture;
use super::RawMessage;

mod inbound;
mod outbound;
mod prompt_wait;
#[cfg(test)]
mod test_support;

use inbound::{crash_control_frame, transport_failure_reason, SpillState};
pub(crate) use inbound::{spawn_inbound_pump, InboundRelay, InboundTelemetry, PublishOutcome};
use outbound::{
    byte_streams, complete_prepared, map_sdk_error, publish_inbound, run_wire_bridge,
    sdk_request_id_to_pylon, send_keep_rx_prepared, SdkEngineConfig, SdkPreparedRpc,
};
pub(crate) use outbound::{prepared_sdk_rpc, ResponderHandle, SdkBackend, SdkOutbound};
pub use prompt_wait::{
    wait_prompt_with_recovery, CancelSettleResolution, CrashReason, PromptTimeoutKind,
    PromptWaitOutcome,
};

/// 入站 broadcast 容量（Kernel/replay 扇出；A1c 从 transport.rs 迁入）。
pub const BROADCAST_CAP: usize = 256;
/// 单消费者 Kernel inbox 容量（慢 dispatcher 施加背压而非丢帧）。
pub const NOTIFICATION_CHAN_CAP: usize = 4096;
/// 取消等待超时（秒）——只包住 `wait_prompt_with_recovery` 判死截断后
/// cancel 请求的队列等待，**不保护物理 stdin 写**（SDK Channel 无界、物理写
/// 无超时；#348 A1 词表勘误：原注释「agent 忙碌不读 stdin 时防止无限挂起」
/// 夸大了保护范围）。
pub const DEFAULT_WRITE_TIMEOUT_SECS: u64 = 10;
/// #99：控制帧 inbox 容量（agent 请求/崩溃广播走优先级通道，不被通知洪泛饿死）。
pub const CONTROL_INBOX_CAP: usize = 64;
/// #99：入站 spill 缓冲容量（inbox 满时的有界溢出区；溢出 = 显式过载终态）。
/// inbox(4096) + spill(8192) 构成有界总内存，禁止用无限队列掩盖慢消费者。
pub const INBOUND_SPILL_CAP: usize = 8192;

/// 启动 SDK 客户端连接任务：非类型化 dispatch → 可靠入站中继（有界 inbox +
/// 有界 spill + 过载显式终态 + 控制帧优先通道），`on_close` 置关闭信号；
/// `shutdown` 触发时 `main_fn` 返回、连接收敛。
#[allow(
    clippy::too_many_arguments,
    reason = "装配函数：参数量随 A1b replay 扇出增加；A1c 收敛后端后合并为结构体"
)]
pub fn spawn_sdk_client(
    config: SdkEngineConfig,
    relay: InboundRelay,
    mut outbound_rx: tokio::sync::mpsc::Receiver<SdkOutbound>,
    transport: impl ConnectTo<Client> + 'static,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    crashed: Arc<AtomicBool>,
    crashed_watch: watch::Sender<bool>,
    replay_events: broadcast::Sender<ClassifiedMessage>,
    active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
    pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
) -> tokio::task::JoinHandle<Result<(), agent_client_protocol::Error>> {
    let crashed_eof = crashed.clone();
    let crashed_watch_eof = crashed_watch.clone();
    let wire = config.wire.clone();
    // #99：spill 续投泵（inbox 满时的续投者；过载后退出）。
    let _pump = spawn_inbound_pump(relay.clone());
    tokio::spawn(async move {
        let result = Client
            .builder()
            .name(config.name)
            .on_receive_dispatch(
                move |message: Dispatch<UntypedMessage, UntypedMessage>, _cx| {
                    let relay = relay.clone();
                    let replay_events = replay_events.clone();
                    let active_replay_requests = active_replay_requests.clone();
                    let pending_requests = pending_requests.clone();
                    let wire = wire.clone();
                    async move {
                        match message {
                            // 响应必须交回 SDK 的 SentRequest：若被 handler 认领而不路由，
                            // ResponseRouter 被丢弃，等响应的请求会以 oneshot canceled 失败。
                            Dispatch::Response(result, router) => {
                                router.route_with_result(result)?;
                            }
                            Dispatch::Request(request, responder) => {
                                // A1b：登记 Responder 供 `ResponderHandle::Sdk` 锁外应答。
                                let id = sdk_request_id_to_pylon(responder.id());
                                if let Some(id) = &id {
                                    if let Ok(mut pending) = pending_requests.lock() {
                                        pending.insert(id.clone(), responder);
                                    }
                                }
                                let mut classified = ClassifiedMessage::live(RawMessage {
                                    id,
                                    kind: super::AcpKind::from_method(Some(request.method())),
                                    method: Some(request.method().to_string()),
                                    result: None,
                                    params: Some(request.params().clone()),
                                    error: None,
                                });
                                classified.wire_ordinal = wire.take_inbound_ordinal();
                                publish_inbound(
                                    classified,
                                    &replay_events,
                                    &active_replay_requests,
                                    &relay,
                                );
                            }
                            Dispatch::Notification(notification) => {
                                let mut classified = ClassifiedMessage::live(RawMessage {
                                    id: None,
                                    kind: super::AcpKind::from_method(Some(notification.method())),
                                    method: Some(notification.method().to_string()),
                                    result: None,
                                    params: Some(notification.params().clone()),
                                    error: None,
                                });
                                classified.wire_ordinal = wire.take_inbound_ordinal();
                                publish_inbound(
                                    classified,
                                    &replay_events,
                                    &active_replay_requests,
                                    &relay,
                                );
                            }
                        }
                        Ok(Handled::Yes)
                    }
                },
                agent_client_protocol::on_receive_dispatch!(),
            )
            .on_close(move |_cx| {
                let crashed = crashed.clone();
                async move {
                    crashed.store(true, Ordering::Release);
                    let _ = crashed_watch.send(true);
                    Ok(())
                }
            })
            .connect_with(transport, async move |cx| {
                // 出站泵：每个请求在独立任务中发送，绝不阻塞 dispatch loop。
                loop {
                    tokio::select! {
                        _ = shutdown.changed() => break,
                        // 入站 EOF（子进程退出）等价 legacy reader 的崩溃信号：
                        // SDK 的 on_close 只在错误关闭时回调，干净 EOF 需在此显式置位。
                        _ = cx.incoming_closed() => {
                            crashed_eof.store(true, Ordering::Release);
                            let _ = crashed_watch_eof.send(true);
                            break;
                        }
                        outbound = outbound_rx.recv() => {
                            let Some(outbound) = outbound else { break };
                            let spawn_cx = cx.clone();
                            let task_cx = cx.clone();
                            let _ = spawn_cx.spawn(async move {
                                match outbound {
                                    SdkOutbound::Request { method, params, reply } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            task_cx.send_request(message).block_task().await
                                                .map_err(map_sdk_error)
                                        }
                                        .await;
                                        let _ = reply.send(result);
                                    }
                                    SdkOutbound::Notification { method, params, reply } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            task_cx.send_notification(message).map_err(map_sdk_error)
                                        }
                                        .await;
                                        let _ = reply.send(result);
                                    }
                                    SdkOutbound::RequestKeepRx { method, params, ready } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            let (resp_tx, resp_rx) = oneshot::channel();
                                            task_cx.send_request(message).on_receiving_result(
                                                move |response| {
                                                    let mapped = response.map_err(map_sdk_error);
                                                    async move {
                                                        let _ = resp_tx.send(mapped);
                                                        Ok(())
                                                    }
                                                },
                                            )
                                            .map_err(map_sdk_error)?;
                                            Ok(resp_rx)
                                        }
                                        .await;
                                        let _ = ready.send(result);
                                    }
                                }
                                Ok(())
                            });
                        }
                    }
                }
                Ok(())
            })
            .await;
        result
    })
}

/// 出站队列容量（有界；满时调用方拿到 `ConnectionClosed` 而不是无限堆积）。
const OUTBOUND_CHAN_CAP: usize = 256;

/// 用 SDK 连接已由 Pylon spawn 的子进程（D1=①）。
///
/// 进程归属不变：子进程仍由 `ManagedChild`（Windows Job Object）持有；本函数只接
/// 协议栈：std 管道 → `tokio::process::ChildStdin/Stdout::from_std`（非阻塞 + 注册
/// runtime）→ `compat` → `ByteStreams` → 观测桥 → SDK client。
/// client 代际由调用方在 `wire`（`AcpWireCapture` correlation）内携带，不再单独传参。
pub fn spawn_sdk_engine(
    agent: &pylon_core::agent_config::AgentDef,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
    wire: Arc<AcpWireCapture>,
    crashed: Arc<AtomicBool>,
    crashed_watch: watch::Sender<bool>,
) -> Result<SdkBackend, AcpError> {
    let stdin = tokio::process::ChildStdin::from_std(stdin)
        .map_err(|error| AcpError::Child(format!("sdk engine stdin setup failed: {error}")))?;
    let stdout = tokio::process::ChildStdout::from_std(stdout)
        .map_err(|error| AcpError::Child(format!("sdk engine stdout setup failed: {error}")))?;

    let (sdk_end, sdk_bridge_side) = Channel::duplex();

    // 子进程字节流 → Channel（自持 relay，避免 SDK `Channel::connect_to` 的
    // `try_join!` 在单向 EOF 时不传播关闭）。
    let transport = byte_streams(stdout, stdin);
    let (child_channel, child_future) =
        <_ as ConnectTo<Client>>::into_channel_and_future(transport);

    // 观测桥：逐帧写入 wire hub，原帧原样转发；任一方向结束即返回。
    let bridge_wire = wire.clone();
    tokio::spawn(async move {
        let _ = run_wire_bridge(sdk_bridge_side, child_channel, bridge_wire).await;
    });

    let (updates_tx, updates_rx) = mpsc::channel(super::NOTIFICATION_CHAN_CAP);
    // #99：控制帧通道（agent 请求/崩溃广播走优先级 lane）+ 可靠中继。
    let (control_tx, control_rx) = mpsc::channel(CONTROL_INBOX_CAP);
    let (outbound_tx, outbound_rx) = mpsc::channel(OUTBOUND_CHAN_CAP);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (replay_events, _) = broadcast::channel(super::BROADCAST_CAP);
    let active_replay_requests: Arc<Mutex<HashMap<u64, String>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let telemetry = Arc::new(InboundTelemetry::new());
    let relay = InboundRelay {
        updates_tx,
        control_tx,
        spill: Arc::new(Mutex::new(SpillState {
            control: std::collections::VecDeque::new(),
            updates: std::collections::VecDeque::new(),
            capacity: INBOUND_SPILL_CAP,
        })),
        wake: Arc::new(tokio::sync::Notify::new()),
        telemetry: telemetry.clone(),
        shutdown: shutdown_tx.clone(),
        crashed: crashed.clone(),
        crashed_watch: crashed_watch.clone(),
    };

    // 子侧传输收尾（#348 A1：区分正常关闭与物理传输失败）。干净关闭 =
    // child_future 返回 `Ok`——不进 Err 分支、不发崩溃控制帧；crashed 信号
    // 照常置位：子进程退出（含 EOF）是权威崩溃信号，等价 legacy reader，
    // 不依赖 SDK 的 EOF 语义（`incoming_closed` 在洪泛/批量场景未必及时完成）。
    // Err 时非 SDK 关闭标记的由 [`transport_failure_reason`] 判为
    // `WriterFailed`，经既有 InboundRelay 控制帧通道发崩溃帧补全终因。已收敛
    // 的连接（过载等已发过崩溃帧）不再竞争修正 reason（watch 缺省
    // `stdout_closed` / 既有控制帧 last-write-wins 不被覆盖）。
    let child_crashed = crashed.clone();
    let child_crashed_watch = crashed_watch.clone();
    let child_end_relay = relay.clone();
    tokio::spawn(async move {
        let outcome = child_future.await;
        if let Err(error) = &outcome {
            if !child_crashed.load(Ordering::Acquire) {
                match transport_failure_reason(error) {
                    Some(reason) => {
                        tracing::warn!(
                            error = %error,
                            reason = reason.as_str(),
                            "acp child transport failed; broadcasting crash control frame"
                        );
                        let _ = child_end_relay.relay(crash_control_frame(reason));
                    }
                    None => {
                        tracing::debug!(error = %error, "acp child transport closed cleanly");
                    }
                }
            }
        }
        child_crashed.store(true, Ordering::Release);
        let _ = child_crashed_watch.send(true);
    });

    let join = spawn_sdk_client(
        SdkEngineConfig {
            name: agent.name.clone(),
            wire,
        },
        relay,
        outbound_rx,
        sdk_end,
        shutdown_rx,
        crashed,
        crashed_watch,
        replay_events.clone(),
        active_replay_requests.clone(),
        pending_requests.clone(),
    );

    Ok(SdkBackend {
        outbound: outbound_tx,
        next_id: Arc::new(AtomicU64::new(1)),
        inbound: std::sync::Mutex::new(Some(NotificationInbox::new(updates_rx, control_rx))),
        telemetry,
        replay_events,
        active_replay_requests,
        pending_requests,
        shutdown: shutdown_tx,
        join: std::sync::Mutex::new(Some(join)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire_trace::AcpWireHub;
    use pylon_core::correlation::RuntimeCorrelation;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    pub(crate) fn engine_config() -> SdkEngineConfig {
        SdkEngineConfig {
            name: "pylon-engine-test".to_string(),
            wire: AcpWireHub::new(
                RuntimeCorrelation {
                    agent_id: "test".into(),
                    provider: None,
                    source: "test".into(),
                    local_session_id: None,
                    remote_session_id: None,
                    peri_id: None,
                    client_generation: 1,
                    request_id: None,
                    tool_call_id: None,
                },
                8,
            ),
        }
    }

    /// #348 A1（真实路径）：干净关闭 = 传输 future 返回 `Ok`（SDK `try_join!`
    /// 两个传输 actor 正常收尾）。生产收尾任务靠「Ok 不发帧」防误报——
    /// `transport_failure_reason` 只在 Err 时出场，本用例不构造不可达的
    /// 带标记 Err，而是断言真实传输 future 在干净 EOF 下的 Ok 收敛。
    #[tokio::test]
    async fn clean_child_transport_close_completes_ok_without_failure() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let transport = byte_streams(client_read, client_write);
        let (child_channel, child_future) =
            <_ as ConnectTo<Client>>::into_channel_and_future(transport);
        drop(child_channel); // 出站侧无帧：outgoing actor 输入排空即完成
        drop(agent_io); // 对端整体关闭 = 入站侧干净 EOF（整体 drop 才会传播
                        // EOF；split 半关闭不触及底层管道状态）
        let outcome = tokio::time::timeout(Duration::from_secs(5), child_future)
            .await
            .expect("干净关闭必须收敛，不得挂起");
        assert!(
            outcome.is_ok(),
            "干净关闭必须是 Ok（try_join 两 actor 正常收尾），实际 {outcome:?}"
        );
    }

    /// A1a 步骤 2/4 证据：SDK 客户端连上字节流并**非类型化**收到 agent 通知。
    #[tokio::test]
    async fn sdk_engine_dispatches_untyped_notification() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (_, mut agent_write) = tokio::io::split(agent_io);

        let (relay, mut updates_rx, _control_rx, _shutdown_rx) =
            InboundRelay::for_test_with_receivers(8, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let crashed = Arc::new(AtomicBool::new(false));
        let (crashed_watch, mut crashed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            crashed.clone(),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        );

        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk"}}
        });
        agent_write
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        let inbound = tokio::time::timeout(Duration::from_secs(5), updates_rx.recv())
            .await
            .expect("inbound notification must arrive")
            .expect("inbound channel must stay open");
        assert_eq!(inbound.raw.method.as_deref(), Some("session/update"));
        assert_eq!(
            inbound.raw.params,
            Some(serde_json::json!({
                "sessionId": "s-1",
                "update": {"sessionUpdate": "agent_message_chunk"}
            }))
        );

        // A1a 步骤 4 证据：agent 端关闭 → SDK on_close 置位。
        drop(agent_write);
        tokio::time::timeout(Duration::from_secs(5), crashed_rx.changed())
            .await
            .expect("on_close must fire after transport EOF")
            .expect("crashed watch must stay open");
        assert!(*crashed_rx.borrow());
        assert!(crashed.load(Ordering::Acquire));

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1a 步骤 5 证据：出站非类型化请求经 `cx.spawn` 发送并拿回响应。
    #[tokio::test]
    async fn sdk_engine_outbound_request_returns_response() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        let (relay, _updates_rx, _control_rx, _relay_shutdown_rx) =
            InboundRelay::for_test_with_receivers(8, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        );

        // agent 端：读一条请求，按原 id 回一条 result；保持写端存活直到测试拿到响应，
        // 避免 EOF 与响应处理竞态。
        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel::<()>();
        let agent_task = tokio::spawn(async move {
            let mut reader = BufReader::new(agent_read);
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .expect("agent must receive outbound request")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(line.trim()).expect("request json");
            assert_eq!(request["method"], "session/new");
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"sessionId": "outbound-session"}
            });
            agent_write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .expect("agent write");
            agent_write.flush().await.expect("agent flush");
            let _ = hold_rx.await;
        });

        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        outbound_tx
            .send(SdkOutbound::Request {
                method: "session/new".to_string(),
                params: serde_json::json!({"cwd": "."}),
                reply: reply_tx,
            })
            .await
            .expect("outbound queue");
        let response = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .expect("outbound reply must arrive")
            .expect("reply channel must stay open")
            .expect("outbound request must succeed");
        assert_eq!(response["sessionId"], "outbound-session");

        let _ = hold_tx.send(());
        agent_task.await.expect("agent task");
        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1b 步骤 7：agent 请求经 `ResponderHandle::Sdk` 在锁外应答（原值 id 回写）。
    #[tokio::test]
    async fn sdk_responder_answers_agent_request() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        let (relay, _updates_rx, _control_rx, _relay_shutdown_rx) =
            InboundRelay::for_test_with_receivers(8, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let pending: Arc<Mutex<HashMap<super::super::RequestId, Responder>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            Arc::new(Mutex::new(HashMap::new())),
            pending.clone(),
        );

        // agent 发一条 string-id 的 permission 请求。
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "perm-1",
            "method": "session/request_permission",
            "params": {"sessionId": "s-1", "toolCallId": "tc-1", "options": []}
        });
        agent_write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        // 等引擎登记 Responder（Pylon id 为 String("perm-1")）。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if pending
                .lock()
                .unwrap()
                .contains_key(&super::super::RequestId::String("perm-1".to_string()))
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "engine must register the agent responder"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let responder = ResponderHandle {
            pending_requests: pending,
        };
        assert!(
            responder
                .respond(
                    super::super::RequestId::String("perm-1".to_string()),
                    serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}}),
                )
                .await,
            "sdk responder must answer"
        );

        // agent 读到同 id 的响应。
        let mut reader = BufReader::new(agent_read);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .expect("agent must receive response")
            .expect("agent read must succeed");
        let response: serde_json::Value = serde_json::from_str(line.trim()).expect("response json");
        assert_eq!(response["id"], "perm-1");
        assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1b 步骤 4 前置：进行中 replay 采集的 session 通知必须被标记为 Replay。
    #[tokio::test]
    async fn sdk_inbound_replay_notification_is_classified() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (_, mut agent_write) = tokio::io::split(agent_io);

        let (relay, _updates_rx, _control_rx, _relay_shutdown_rx) =
            InboundRelay::for_test_with_receivers(8, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let (replay_tx, mut replay_rx) = tokio::sync::broadcast::channel(8);
        let active: Arc<Mutex<HashMap<u64, String>>> = Arc::new(Mutex::new(HashMap::new()));
        active.lock().unwrap().insert(42, "s-1".to_string());

        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            replay_tx,
            active,
            Arc::new(Mutex::new(HashMap::new())),
        );

        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "x"}}}
        });
        agent_write
            .write_all(
                format!(
                    "{frame}
"
                )
                .as_bytes(),
            )
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        let classified = tokio::time::timeout(Duration::from_secs(5), replay_rx.recv())
            .await
            .expect("broadcast must deliver")
            .expect("broadcast must stay open");
        assert!(matches!(
            classified.classification,
            super::super::ReplayClassification::Replay { request_id: 42 }
        ));

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1b 步骤 3 前置：SDK 的 `SentRequest` 被 drop 会自动发 `$/cancel_request`
    /// （与 Pylon「丢弃 pending 不发取消」不同——A1b 必须显式审计并锁定该差异）。
    #[tokio::test]
    async fn sent_request_drop_sends_cancel_request() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, _agent_write) = tokio::io::split(agent_io);

        let agent_task = tokio::spawn(async move {
            let mut reader = BufReader::new(agent_read);
            let mut request_line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut request_line))
                .await
                .expect("agent must receive request")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(request_line.trim()).expect("request json");
            assert_eq!(request["method"], "session/prompt");

            let mut cancel_line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut cancel_line))
                .await
                .expect("drop must send $/cancel_request")
                .expect("agent read must succeed");
            let cancel: serde_json::Value =
                serde_json::from_str(cancel_line.trim()).expect("cancel json");
            assert_eq!(cancel["method"], "$/cancel_request");
        });

        let transport = byte_streams(client_read, client_write);
        let handle = tokio::spawn(async move {
            Client
                .builder()
                .name("drop-cancel-probe")
                .connect_with(transport, async |cx| {
                    let request = UntypedMessage::new(
                        "session/prompt",
                        serde_json::json!({"sessionId": "s-1"}),
                    )?;
                    // 立即 drop：SDK 契约 = 自动发 $/cancel_request。
                    drop(cx.send_request(request));
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    Ok(())
                })
                .await
        });

        agent_task.await.expect("agent task");
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }
}

// ── JSON-RPC request id（原 acp/request_id.rs，A1c 收敛）──

use std::fmt;

/// JSON-RPC 请求 id 的原始形态（数字或字符串）。
///
/// `#[serde(untagged)]`：序列化时 `Number(n)` → JSON number、`String(s)` → JSON string，
/// 天然满足"响应用原始 variant 回写"。
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

impl RequestId {
    /// 从 wire JSON value 原样解析（保留 variant）；null/absent/布尔/浮点 → None。
    ///
    /// 测试与 wire 回放断言消费（#228/#247：宿主 golden_trace_tests 跨 crate 使用，
    /// 故为常态 pub；生产 legacy stdout reader 已于 A1c 删除）。
    pub fn from_json_value(value: &serde_json::Value) -> Option<RequestId> {
        match value {
            serde_json::Value::Number(n) => n.as_u64().map(RequestId::Number),
            serde_json::Value::String(s) => Some(RequestId::String(s.clone())),
            _ => None,
        }
    }

    /// 从前端回显字符串还原候选 id（ACP-01）：数字形态 → `Number`（命中原 numeric
    /// 请求），否则 `String`。不把 string 强转 number、不把 null/空串当 0——
    /// 最终 variant 由 pending 命中决定（见 `permission::canonical_pending_key`）。
    pub fn from_echo_string(value: &str) -> RequestId {
        match value.parse::<u64>() {
            Ok(n) => RequestId::Number(n),
            Err(_) => RequestId::String(value.to_string()),
        }
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Number(n) => write!(f, "{n}"),
            RequestId::String(s) => write!(f, "{s}"),
        }
    }
}

// ── JSON-RPC pending / PreparedRpc / prompt 等待（原 acp/jsonrpc.rs，A1c 收敛）──

/// 准备好的 JSON-RPC 请求（D12：后端专属状态封在 [`SdkPreparedRpc`]，
/// `line`/`write_tx`/`rx` 不出现在公开面）。
pub struct PreparedRpc {
    /// Pylon 相关 id（本地计数器）；wire id 永不暴露。
    pub id: u64,
    pub sdk: SdkPreparedRpc,
}

impl PreparedRpc {
    /// 发送请求行，返回响应接收器。
    pub async fn send_keep_rx(self) -> Result<oneshot::Receiver<RawMessage>, AcpError> {
        super::engine::send_keep_rx_prepared(self).await
    }

    /// 发送 + 等待匹配响应（超时值来自协议配置）。
    pub async fn complete(self) -> Result<serde_json::Value, AcpError> {
        super::engine::complete_prepared(self).await
    }
}
