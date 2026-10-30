//! 入站背压子系统（原 engine.rs 的 A 段，A1c 后拆分归位；行为零变化）。
//!
//! 承载 #99 可靠入站投递：[`InboundRelay`]（inbox 满转有界 spill、溢出 = 显式
//! 过载终态、lane 内 FIFO）与 [`spawn_inbound_pump`]（spill 续投泵）。装配
//! （通道构造与容量选择）仍在 [`super`]（engine/mod.rs 的 `spawn_sdk_engine`）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, watch};

use super::CrashReason;
use super::RawMessage;
use crate::client::ClassifiedMessage;

/// #99：入站投遥测（每连接一份）。
///
/// `next_seq` 是本连接入站帧的单调 ingress ordinal 分配器；spill/drop 计数是
/// 背压的可观测面——任何 drop 都必须显式记录（过载 gap 或下游关闭计数），
/// 禁止静默丢帧。
#[derive(Debug, Default)]
pub struct InboundTelemetry {
    next_seq: AtomicU64,
    spilled_total: AtomicU64,
    dropped_total: AtomicU64,
    closed_dropped: AtomicU64,
    overloaded: AtomicBool,
}

/// 遥测快照（冷挂载/诊断只读投影；serde camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundTelemetrySnapshot {
    pub last_ingress_seq: u64,
    pub spilled_total: u64,
    pub dropped_total: u64,
    pub closed_dropped: u64,
    pub overloaded: bool,
}

impl InboundTelemetry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 分配下一个 ingress ordinal（1 起单调递增；调度回调单线程串行调用）。
    pub(super) fn allocate_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn snapshot(&self) -> InboundTelemetrySnapshot {
        InboundTelemetrySnapshot {
            last_ingress_seq: self.next_seq.load(Ordering::Relaxed),
            spilled_total: self.spilled_total.load(Ordering::Relaxed),
            dropped_total: self.dropped_total.load(Ordering::Relaxed),
            closed_dropped: self.closed_dropped.load(Ordering::Relaxed),
            overloaded: self.overloaded.load(Ordering::Acquire),
        }
    }
}

/// 入站帧的目标通道：控制帧（agent 请求/崩溃广播）优先于普通通知。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InboundLane {
    Control,
    Updates,
}

/// spill 缓冲（有界；两个 lane 各自保序）。
#[derive(Debug)]
pub(super) struct SpillState {
    pub(super) control: std::collections::VecDeque<ClassifiedMessage>,
    pub(super) updates: std::collections::VecDeque<ClassifiedMessage>,
    pub(super) capacity: usize,
}

/// #99：可靠入站投递中继。
///
/// 入站帧必须经本中继进入 Kernel inbox：`try_send` 失败不再是可忽略的日志，
/// 而是转入有界 spill 缓冲由泵任务续投；spill 也满 = 显式过载终态（连接按
/// 崩溃收敛 + `dropped_total` 记录 gap），三选一策略取「spill + 过载终止」，
/// 杜绝静默丢帧（issue #99 方案不变量 §1）。
#[derive(Clone)]
pub struct InboundRelay {
    pub(super) updates_tx: mpsc::Sender<ClassifiedMessage>,
    pub(super) control_tx: mpsc::Sender<ClassifiedMessage>,
    pub(super) spill: Arc<Mutex<SpillState>>,
    pub(super) wake: Arc<tokio::sync::Notify>,
    pub telemetry: Arc<InboundTelemetry>,
    pub(super) shutdown: watch::Sender<bool>,
    pub(super) crashed: Arc<AtomicBool>,
    pub(super) crashed_watch: watch::Sender<bool>,
}

/// 单帧投递结果（可观测背压的机器可判定面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishOutcome {
    /// 已进入 inbox。
    Published,
    /// inbox 满已转入 spill（泵任务续投；消费端最终收到）。
    Spilled,
    /// spill 溢出：本帧被显式丢弃且已记录 gap，连接将以过载终态收敛。
    Overloaded,
    /// 下游通道已关闭（消费端消失）：帧无法投递，计入 `closed_dropped`
    /// 遥测。连接终止本身由既有 crash/shutdown 路径显式收敛（评审 E7）。
    DroppedClosed,
}

/// #348 A1：崩溃控制帧的唯一构造点——`reason` 走 [`CrashReason`] 稳定词表，
/// 禁止散落手拼 JSON（`terminate_overloaded` 与子侧传输收尾共用）。
pub(super) fn crash_control_frame(reason: CrashReason) -> ClassifiedMessage {
    ClassifiedMessage::live(RawMessage {
        id: None,
        kind: crate::AcpKind::Crashed,
        method: Some(crate::NOTIF_AGENT_CRASHED.to_string()),
        result: None,
        params: Some(serde_json::json!({
            "reason": reason.as_str()
        })),
        error: None,
    })
}

/// #348 A1：子侧传输 future 的 Err 分类——[`CrashReason::WriterFailed`]
/// 的唯一产生点。与官方 SDK 2.2.0 实现核对：**干净关闭时传输 future 返回
/// `Ok`**（`try_join!` 两个传输 actor 正常收尾），根本不进入 Err 分支——
/// 防误报的第一道防线是「Ok 不发帧」。SDK 的 `incoming_transport_closed`
/// 标记只为**挂起请求**合成（SentRequest 侧收尾），不会作为传输 future 的
/// Err 出现，故 `None` 臂是防御性代码（生产输入不可达，保留以对冲 SDK 行为
/// 变化）；`Some` 臂覆盖非 EOF 的物理传输错误（stdin 写 EPIPE / stdout 读
/// IO 错误）。
pub(super) fn transport_failure_reason(
    error: &agent_client_protocol::Error,
) -> Option<CrashReason> {
    if agent_client_protocol::is_incoming_transport_closed(error) {
        None
    } else {
        Some(CrashReason::WriterFailed)
    }
}

impl InboundRelay {
    fn lane_of(classified: &ClassifiedMessage) -> InboundLane {
        match classified.raw.kind {
            // 崩溃广播是控制帧（洪泛时不得被 session/update 饿死）。
            crate::AcpKind::Crashed => InboundLane::Control,
            // #316：elicitation/complete 同为控制帧（轻量、低频、语义关键）。
            crate::AcpKind::ElicitationComplete => InboundLane::Control,
            // 带 id 且带 method = agent 发来的 JSON-RPC 请求（permission/terminal/
            // fs/私有交互）——也是控制帧。Response 不经 inbox（SDK SentRequest 直达）。
            _ if classified.raw.id.is_some() && classified.raw.method.is_some() => {
                InboundLane::Control
            }
            _ => InboundLane::Updates,
        }
    }

    /// 投递一帧：先保证单调 ingress ordinal，再按 lane 入队。
    ///
    /// #99 不变量（结构性保证，调用方无法绕过）：每帧必有 ordinal；
    /// inbox 满转 spill；spill 溢出 = 显式过载终态，绝不静默丢帧。
    /// lane 内严格 FIFO：决策与入队在 spill 锁内原子完成——某 lane 存在
    /// 滞留帧时，该 lane 的新帧一律排到队尾（直发会越过滞留帧送达；
    /// 泵侧以「队首占位直到发送成功」配合，两侧无交错窗口）（评审 E1）。
    pub(super) fn relay(&self, mut classified: ClassifiedMessage) -> PublishOutcome {
        if classified.ingress_seq == 0 {
            classified.ingress_seq = self.telemetry.allocate_seq();
        }
        let lane = Self::lane_of(&classified);
        let mut spill = self
            .spill
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lane_has_backlog = match lane {
            InboundLane::Control => !spill.control.is_empty(),
            InboundLane::Updates => !spill.updates.is_empty(),
        };
        let (outcome, first_gap) = if lane_has_backlog {
            Self::spill_enqueue(&mut spill, &self.telemetry, classified, lane)
        } else {
            // 无滞留：锁内直发。`try_send` 非阻塞、不回调，持锁安全；
            // 持锁发送消除「泵已取帧未落通道 + 新帧直发越过」的窗口。
            let send_result = match lane {
                InboundLane::Control => self.control_tx.try_send(classified),
                InboundLane::Updates => self.updates_tx.try_send(classified),
            };
            match send_result {
                Ok(()) => (PublishOutcome::Published, false),
                Err(tokio::sync::mpsc::error::TrySendError::Full(classified)) => {
                    Self::spill_enqueue(&mut spill, &self.telemetry, classified, lane)
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    self.telemetry.closed_dropped.fetch_add(1, Ordering::AcqRel);
                    (PublishOutcome::DroppedClosed, false)
                }
            }
        };
        drop(spill);
        if first_gap {
            self.terminate_overloaded();
        }
        if outcome == PublishOutcome::Spilled {
            self.wake.notify_one();
        }
        outcome
    }

    /// 锁内入队 spill（容量检查 + 计数）。返回 `(结果, 是否首个过载 gap)`；
    /// 首个 gap 由调用方在**释放锁后**触发过载终态（std Mutex 不可重入，
    /// terminate 内部会再次 relay 崩溃帧）。
    fn spill_enqueue(
        spill: &mut SpillState,
        telemetry: &InboundTelemetry,
        classified: ClassifiedMessage,
        lane: InboundLane,
    ) -> (PublishOutcome, bool) {
        if spill.control.len() + spill.updates.len() >= spill.capacity {
            // 显式 gap：丢弃必须计数；首个 gap 触发过载终态收敛连接，
            // 后续溢出帧只计数（终止流程已启动，不再重复触发）。
            telemetry.dropped_total.fetch_add(1, Ordering::AcqRel);
            let first_gap = !telemetry.overloaded.swap(true, Ordering::AcqRel);
            return (PublishOutcome::Overloaded, first_gap);
        }
        match lane {
            InboundLane::Control => spill.control.push_back(classified),
            InboundLane::Updates => spill.updates.push_back(classified),
        }
        telemetry.spilled_total.fetch_add(1, Ordering::AcqRel);
        (PublishOutcome::Spilled, false)
    }

    /// 过载终态：携带原因的控制帧 + 崩溃信号 + 主动关闭连接。
    ///
    /// 控制帧让 dispatcher 以稳定 code `overloaded` 收敛 turn/UI；crashed 标志
    /// 阻断新出站请求；shutdown 结束 SDK 泵任务、触发传输关闭（EOF 路径随后
    /// 自然收敛）。**reason 修正是 best-effort**：watch 分支可能先以缺省
    /// `stdout_closed` 触发 handle_crash，控制帧随后到达通常会把 reason 修正
    /// 为 `overloaded`（last-write-wins）；极端拥塞下（控制通道 + spill 均满）
    /// 崩溃帧也可能被计入 gap，此时 reason 保持缺省——连接终止由
    /// watch/shutdown 保证，与 reason 无关（评审 E7/E12）。
    fn terminate_overloaded(&self) {
        tracing::error!(
            dropped_total = self.telemetry.dropped_total.load(Ordering::Acquire),
            spilled_total = self.telemetry.spilled_total.load(Ordering::Acquire),
            "acp inbound relay overloaded; terminating connection with explicit gap"
        );
        let _ = self.relay(crash_control_frame(CrashReason::Overloaded));
        self.crashed.store(true, Ordering::Release);
        let _ = self.crashed_watch.send(true);
        let _ = self.shutdown.send(true);
    }

    /// 测试构造：返回 (relay, updates_rx, control_rx, shutdown_rx)。
    /// 生产路径的构造在 `spawn_sdk_engine`（含真实 crash/shutdown 句柄）。
    #[cfg(test)]
    pub fn for_test_with_receivers(
        updates_cap: usize,
        control_cap: usize,
        spill_cap: usize,
    ) -> (
        Self,
        mpsc::Receiver<ClassifiedMessage>,
        mpsc::Receiver<ClassifiedMessage>,
        watch::Receiver<bool>,
    ) {
        let (updates_tx, updates_rx) = mpsc::channel(updates_cap);
        let (control_tx, control_rx) = mpsc::channel(control_cap);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (crashed_watch, _crashed_rx) = watch::channel(false);
        (
            Self {
                updates_tx,
                control_tx,
                spill: Arc::new(Mutex::new(SpillState {
                    control: std::collections::VecDeque::new(),
                    updates: std::collections::VecDeque::new(),
                    capacity: spill_cap,
                })),
                wake: Arc::new(tokio::sync::Notify::new()),
                telemetry: Arc::new(InboundTelemetry::new()),
                shutdown,
                crashed: Arc::new(AtomicBool::new(false)),
                crashed_watch,
            },
            updates_rx,
            control_rx,
            shutdown_rx,
        )
    }
}

/// #99：spill 续投泵。
///
/// inbox 满时帧进 spill；泵任务在 inbox 有空位后按「控制优先、各自保序」续投。
/// 保序机制（评审 E1）：锁内 **peek 队首并 clone 试发**——帧在成功发送前保持
/// 队首占位，生产者（relay）因此始终看到非空滞留、把新帧排到队尾；
/// 「取出-失败-放回」的重试窗口不复存在。
/// 退出条件（评审 E5/P2-3）：下游通道关闭、shutdown 触发（订阅 watch：空 spill
/// 时现值检查 + changed；重试等待中亦响应现值——连接收敛后不再向其投递滞留帧）、
/// 或过载终态后 spill 排空。#704：下游关闭与 shutdown 两条退出路径上的 spill
/// 滞留帧都显式清点计入 `closed_dropped`（「任何 drop 必须可观测」）。
pub fn spawn_inbound_pump(relay: InboundRelay) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut shutdown_rx = relay.shutdown.subscribe();
        let retry = std::time::Duration::from_millis(5);
        loop {
            let attempt = {
                let spill = relay
                    .spill
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let front = if let Some(message) = spill.control.front() {
                    Some((InboundLane::Control, message.clone()))
                } else {
                    spill
                        .updates
                        .front()
                        .map(|message| (InboundLane::Updates, message.clone()))
                };
                match front {
                    None => None,
                    Some((lane, message)) => {
                        // try_send 非阻塞、不回调，持 spill 锁调用安全；
                        // 与 relay 的锁内直发决策互斥，无交错窗口。
                        let result = match lane {
                            InboundLane::Control => relay.control_tx.try_send(message),
                            InboundLane::Updates => relay.updates_tx.try_send(message),
                        };
                        Some((lane, result))
                    }
                }
            };
            match attempt {
                None => {
                    if relay.telemetry.overloaded.load(Ordering::Acquire) {
                        break;
                    }
                    // shutdown 可能在泵首次运行前就已触发（subscribe 之后才
                    // 轮询）——现值检查兜底，changed() 只覆盖其后的变更。
                    if *shutdown_rx.borrow_and_update() {
                        break;
                    }
                    // 等 shutdown / 新 spill 入队；超时兜底重查过载与关闭。
                    tokio::select! {
                        _ = shutdown_rx.changed() => break,
                        _ = relay.wake.notified() => {}
                        _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
                    }
                }
                Some((lane, Ok(()))) => {
                    // 发送成功此刻才真正出队——队首在成功前始终占位，
                    // 生产者据此保持「滞留即排尾」的 FIFO 纪律。
                    let mut spill = relay
                        .spill
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    match lane {
                        InboundLane::Control => {
                            spill.control.pop_front();
                        }
                        InboundLane::Updates => {
                            spill.updates.pop_front();
                        }
                    }
                }
                Some((_, Err(tokio::sync::mpsc::error::TrySendError::Full(_)))) => {
                    // inbox 仍满：帧保持在队首占位，稍候重试（无取放窗口）。
                    // 重试等待同样响应 shutdown——过载终态置位 shutdown 后不再
                    // 把滞留帧继续投进正在收敛的连接（评审 P2-3）。
                    // #704：shutdown 退出与下游关闭同账——此刻 spill 仍滞留的帧
                    // 永远不会投出，必须显式清点计入 closed_dropped（「任何 drop
                    // 必须可观测」不变量；审查定位修正：None 分支退出时 spill 必空，
                    // 真实缺口在本分支 break）。
                    if *shutdown_rx.borrow_and_update() {
                        abandon_spill_leftovers(&relay, "shutdown");
                        break;
                    }
                    tokio::time::sleep(retry).await;
                }
                Some((_, Err(tokio::sync::mpsc::error::TrySendError::Closed(_)))) => {
                    // 下游关闭：spill 滞留帧无法投递——显式计数后退出（模块
                    // 不变量：任何 drop 必须可观测，评审 P2-3）。
                    abandon_spill_leftovers(&relay, "downstream closed");
                    break;
                }
            }
        }
    })
}

/// #704：清空 spill 并把滞留帧显式计入 `closed_dropped`（泵退出路径共用的
/// 「任何 drop 必须可观测」收口；reason 只进日志，便于区分退出通道）。
fn abandon_spill_leftovers(relay: &InboundRelay, reason: &str) {
    let mut spill = relay
        .spill
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let leftover = (spill.control.len() + spill.updates.len()) as u64;
    spill.control.clear();
    spill.updates.clear();
    drop(spill);
    if leftover > 0 {
        relay
            .telemetry
            .closed_dropped
            .fetch_add(leftover, Ordering::AcqRel);
        tracing::warn!(
            leftover,
            reason,
            "acp inbound pump: abandoning frames still in spill"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::engine_config;
    use super::super::{byte_streams, spawn_sdk_client, SdkOutbound};
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// #348 A1：分类器对 SDK 谓词的委托——`is_incoming_transport_closed`
    /// 标记不算传输失败，其余 Err 一律判 `WriterFailed`。
    /// 注意：手工构造标记错误喂分类器，锁定的是**委托关系**，不是生产输入
    /// （SDK 只为挂起请求合成该标记，不作为传输 future 的 Err 出现）；生产
    /// 路径的干净关闭走「Ok 不发帧」，由真实传输 future 用例覆盖。
    #[test]
    fn transport_failure_reason_delegates_to_the_sdk_closed_marker_predicate() {
        let closed_marker = agent_client_protocol::Error::internal_error()
            .data(serde_json::json!({"reason": "incoming_transport_closed"}));
        assert_eq!(transport_failure_reason(&closed_marker), None);

        let physical_error = agent_client_protocol::Error::internal_error();
        assert_eq!(
            transport_failure_reason(&physical_error),
            Some(CrashReason::WriterFailed)
        );
    }

    /// #348 A1：崩溃控制帧的唯一构造——reason 必须是稳定词表 wire code。
    #[test]
    fn crash_control_frame_carries_stable_reason_code() {
        let frame = crash_control_frame(CrashReason::WriterFailed);
        assert_eq!(frame.raw.kind, crate::AcpKind::Crashed);
        assert_eq!(
            frame.raw.params,
            Some(serde_json::json!({"reason": "writer_failed"}))
        );
    }

    /// A1a 步骤 6（**硬门**）+ #99 背压契约：入站队列满时**不丢帧**——溢出帧
    /// 进有界 spill 由泵任务续投（ingress 序列保序），同时 dispatch loop 保持
    /// 响应（出站请求在 inbox 满时仍被处理）。
    ///
    /// 预期行为变化（对比旧 `inbox_full_does_not_block_dispatch`）：旧契约断言
    /// 「容量 1 时后 2 帧被静默丢弃」；#99 禁止静默丢帧，本测试改为断言全部
    /// 3 帧按 ingress 序列完整送达。
    #[tokio::test]
    async fn inbox_full_spills_then_delivers_every_frame_in_order() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        // 入站队列容量 1：连发 3 条通知必有 2 条先入 spill，再由泵续投。
        let (relay, mut updates_rx, _control_rx, _shutdown_rx) =
            InboundRelay::for_test_with_receivers(1, 8, 64);
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

        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel::<()>();
        let agent_task = tokio::spawn(async move {
            for index in 0..3 {
                let frame = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "index": index}}
                });
                agent_write
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .expect("agent write");
            }
            agent_write.flush().await.expect("agent flush");
            // 入站队列已满仍必须能处理出站请求（否则 dispatch loop 被阻塞）。
            let mut reader = BufReader::new(agent_read);
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .expect("dispatch loop must stay responsive while inbox is full")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(line.trim()).expect("request json");
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"ok": true}
            });
            agent_write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .expect("agent response write");
            agent_write.flush().await.expect("agent response flush");
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
            .expect("outbound reply must arrive while inbox is full")
            .expect("reply channel must stay open")
            .expect("outbound request must succeed");
        assert_eq!(response["ok"], true);

        // #99：三帧全部送达（无静默丢帧），ingress 序列严格递增。
        let mut seqs = Vec::new();
        for index in 0..3 {
            let frame = tokio::time::timeout(Duration::from_secs(5), updates_rx.recv())
                .await
                .expect("spilled frame must be delivered by the pump")
                .expect("updates channel must stay open");
            assert_eq!(
                frame.raw.params.as_ref().unwrap()["update"]["index"],
                serde_json::json!(index),
                "帧必须按序送达（无记录的丢弃 = 门禁失败）"
            );
            seqs.push(frame.ingress_seq);
        }
        assert_eq!(seqs, vec![1, 2, 3], "ingress ordinal 必须单调递增且无 gap");

        let _ = hold_tx.send(());
        agent_task.await.expect("agent task");
        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// #99：spill 溢出 = 显式过载终态。丢弃必须计数（gap 可观测）、崩溃广播
    /// 携带稳定 code `overloaded`、shutdown 触发连接收敛；禁止静默继续运行。
    #[tokio::test]
    async fn spill_overflow_terminates_connection_with_explicit_overload() {
        let (relay, updates_rx, mut control_rx, shutdown_rx) =
            InboundRelay::for_test_with_receivers(1, 8, 1);

        let update = |index: u64| {
            ClassifiedMessage::live(RawMessage {
                id: None,
                kind: crate::AcpKind::SessionUpdate,
                method: Some(crate::NOTIF_SESSION_UPDATE.to_string()),
                result: None,
                params: Some(serde_json::json!({"sessionId": "s-1", "update": {"index": index}})),
                error: None,
            })
        };

        // 消费端不读 updates_rx：inbox(1) + spill(1) 后第 3 帧必须触发过载。
        assert_eq!(relay.relay(update(0)), PublishOutcome::Published);
        assert_eq!(relay.relay(update(1)), PublishOutcome::Spilled);
        assert_eq!(relay.relay(update(2)), PublishOutcome::Overloaded);

        let telemetry = relay.telemetry.snapshot();
        assert_eq!(
            telemetry.dropped_total, 1,
            "溢出帧必须显式计数（gap marker）"
        );
        assert_eq!(telemetry.spilled_total, 1);
        assert!(telemetry.overloaded, "过载位必须置上");

        // 崩溃广播走控制通道，reason = 稳定 code "overloaded"。
        let crash = tokio::time::timeout(Duration::from_secs(2), control_rx.recv())
            .await
            .expect("crash frame must be queued")
            .expect("control channel must stay open");
        assert_eq!(crash.raw.kind, crate::AcpKind::Crashed);
        assert_eq!(
            crash.raw.params.as_ref().unwrap()["reason"],
            serde_json::json!("overloaded")
        );
        // shutdown 已触发（连接收敛），且 updates_rx 未被消费过。
        assert!(
            *shutdown_rx.borrow(),
            "shutdown must be requested on overload"
        );
        drop(updates_rx);
    }

    /// #99：控制帧优先级——updates 通道满 + spill 非空时，agent 请求（带 id）
    /// 仍经控制通道立即被消费端读到；优先级不改写各帧 ingress 序列。
    #[tokio::test]
    async fn control_lane_delivers_requests_while_update_flood_is_queued() {
        let (relay, mut updates_rx, mut control_rx, _shutdown_rx) =
            InboundRelay::for_test_with_receivers(1, 8, 64);

        let update = |index: u64| {
            ClassifiedMessage::live(RawMessage {
                id: None,
                kind: crate::AcpKind::SessionUpdate,
                method: Some(crate::NOTIF_SESSION_UPDATE.to_string()),
                result: None,
                params: Some(serde_json::json!({"sessionId": "s-1", "update": {"index": index}})),
                error: None,
            })
        };
        assert_eq!(relay.relay(update(0)), PublishOutcome::Published);
        assert_eq!(relay.relay(update(1)), PublishOutcome::Spilled);

        // 洪泛未消费时，permission 请求必须立即可读（控制通道）。
        let request = ClassifiedMessage::live(RawMessage {
            id: Some(crate::RequestId::String("perm-1".to_string())),
            kind: crate::AcpKind::PermissionRequest,
            method: Some("session/request_permission".to_string()),
            result: None,
            params: Some(serde_json::json!({"sessionId": "s-1"})),
            error: None,
        });
        assert_eq!(relay.relay(request), PublishOutcome::Published);
        let control_frame = tokio::time::timeout(Duration::from_secs(2), control_rx.recv())
            .await
            .expect("control frame must bypass the update flood")
            .expect("control channel must stay open");
        assert_eq!(control_frame.raw.kind, crate::AcpKind::PermissionRequest);
        assert_eq!(control_frame.ingress_seq, 3, "优先级不改写 ingress 序列");

        // 普通 lane 数据未动：第一帧仍在 inbox。
        let first = tokio::time::timeout(Duration::from_secs(2), updates_rx.recv())
            .await
            .expect("update frame")
            .expect("updates channel");
        assert_eq!(first.ingress_seq, 1);
    }

    /// #99（评审 E1 回归锁，判别性构造由二审 P2-1 给出）：lane 存在滞留帧时，
    /// 新帧必须排到 spill 队尾（返回 `Spilled`）而不是直发越过滞留帧。
    ///
    /// 判别力设计：**relay 阶段不 spawn 泵**（旧实现的乱序窗口恰在泵重试等待
    /// 期间；无泵则无调度干扰，结果确定）。updates 容量 2：A、B 直发占满，
    /// C 进 spill（滞留期开始）；消费 A 腾出一格后 relay D——
    /// - 新实现：检测到滞留（C 占位）→ D 返回 `Spilled`，最终交付 [A,B,C,D]；
    /// - 旧实现：无滞留检查 → D 直发返回 `Published`，交付 [A,B,D,C]。
    /// 断言同时钉住 outcome 与交付序，对旧实现必红。
    #[tokio::test]
    async fn relay_with_lane_backlog_keeps_new_frames_behind_spilled() {
        let (relay, mut updates_rx, _control_rx, _shutdown_rx) =
            InboundRelay::for_test_with_receivers(2, 8, 64);
        let update = |index: u64| {
            ClassifiedMessage::live(RawMessage {
                id: None,
                kind: crate::AcpKind::SessionUpdate,
                method: Some(crate::NOTIF_SESSION_UPDATE.to_string()),
                result: None,
                params: Some(serde_json::json!({
                    "sessionId": "s-1", "update": {"index": index}
                })),
                error: None,
            })
        };
        // relay 阶段（无泵、无 await：结果确定，不受调度影响）。
        assert_eq!(relay.relay(update(0)), PublishOutcome::Published);
        assert_eq!(relay.relay(update(1)), PublishOutcome::Published);
        assert_eq!(relay.relay(update(2)), PublishOutcome::Spilled);
        // 消费 A 腾出一格——滞留 C 仍在 spill 占位。
        let first = updates_rx.recv().await.expect("first frame");
        assert_eq!(first.ingress_seq, 1);
        // 判别点：滞留存在时 D 禁止直发。
        assert_eq!(
            relay.relay(update(3)),
            PublishOutcome::Spilled,
            "滞留存在时新帧必须排尾（直发 = E1 旧实现回归）"
        );
        // 现在起泵续投：交付序必须 [A,B,C,D]（旧实现为 [A,B,D,C]）。
        let pump = spawn_inbound_pump(relay.clone());
        let mut seqs = vec![first.ingress_seq];
        for _ in 0..3 {
            let frame = tokio::time::timeout(Duration::from_secs(5), updates_rx.recv())
                .await
                .expect("frame must be delivered")
                .expect("updates channel must stay open");
            seqs.push(frame.ingress_seq);
        }
        assert_eq!(seqs, vec![1, 2, 3, 4], "交付序必须等于 ingress 序");
        pump.abort();
    }

    /// #99（评审 E5 回归锁）：shutdown 触发后泵任务必须退出，不残留
    /// 定时唤醒的僵尸任务。
    #[tokio::test]
    async fn inbound_pump_exits_on_shutdown() {
        let (updates_tx, updates_rx) = mpsc::channel(8);
        let (control_tx, control_rx) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let shutdown_tx = shutdown.clone();
        let (crashed_watch, _crashed_rx) = watch::channel(false);
        let relay = InboundRelay {
            updates_tx,
            control_tx,
            spill: Arc::new(Mutex::new(SpillState {
                control: std::collections::VecDeque::new(),
                updates: std::collections::VecDeque::new(),
                capacity: 64,
            })),
            wake: Arc::new(tokio::sync::Notify::new()),
            telemetry: Arc::new(InboundTelemetry::new()),
            shutdown,
            crashed: Arc::new(AtomicBool::new(false)),
            crashed_watch,
        };
        let pump = spawn_inbound_pump(relay);
        drop(updates_rx);
        drop(control_rx);
        let _ = shutdown_tx.send(true);
        tokio::time::timeout(Duration::from_secs(2), pump)
            .await
            .expect("pump must exit after shutdown")
            .expect("pump task must not panic");
    }
}

/// #704：shutdown 退出时 spill 滞留帧显式清点（closed_dropped）——「任何 drop
/// 必须可观测」在 shutdown 路径同样成立（与下游关闭分支同账）。
#[tokio::test]
async fn shutdown_abandons_spill_leftovers_with_explicit_accounting() {
    let (updates_tx, updates_rx) = mpsc::channel(1);
    let (control_tx, control_rx) = mpsc::channel(8);
    let (shutdown, _shutdown_rx) = watch::channel(false);
    let shutdown_tx = shutdown.clone();
    let (crashed_watch, _crashed_rx) = watch::channel(false);
    let relay = InboundRelay {
        updates_tx,
        control_tx,
        spill: Arc::new(Mutex::new(SpillState {
            control: std::collections::VecDeque::new(),
            updates: std::collections::VecDeque::new(),
            capacity: 64,
        })),
        wake: Arc::new(tokio::sync::Notify::new()),
        telemetry: Arc::new(InboundTelemetry::new()),
        shutdown,
        crashed: Arc::new(AtomicBool::new(false)),
        crashed_watch,
    };
    let update = |index: u64| {
        ClassifiedMessage::live(RawMessage {
            id: None,
            kind: crate::AcpKind::SessionUpdate,
            method: Some(crate::NOTIF_SESSION_UPDATE.to_string()),
            result: None,
            params: Some(serde_json::json!({"sessionId": "s-1", "update": {"index": index}})),
            error: None,
        })
    };
    // inbox(1) 占满且不消费 → 2 帧滞留 spill，泵卡在 Full 分支重试等待。
    assert_eq!(relay.relay(update(0)), PublishOutcome::Published);
    assert_eq!(relay.relay(update(1)), PublishOutcome::Spilled);
    assert_eq!(relay.relay(update(2)), PublishOutcome::Spilled);
    let pump = spawn_inbound_pump(relay.clone());
    let _ = shutdown_tx.send(true);
    tokio::time::timeout(std::time::Duration::from_secs(2), pump)
        .await
        .expect("pump must exit on shutdown")
        .expect("pump task must not panic");
    let telemetry = relay.telemetry.snapshot();
    assert_eq!(
        telemetry.closed_dropped, 2,
        "shutdown 退出的 spill 残留必须显式计数（#704）"
    );
    assert_eq!(telemetry.dropped_total, 0, "非溢出路径不得污染 gap 计数");
    drop(updates_rx);
    drop(control_rx);
}
