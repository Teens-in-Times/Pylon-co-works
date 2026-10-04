use super::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use super::engine::{
    prepared_sdk_rpc, InboundTelemetry, ResponderHandle, SdkBackend, SdkOutbound, CONTROL_INBOX_CAP,
};

pub struct AcpClient {
    /// #549：互斥仅护 kill 的 `&mut` 内部态（take child / 关 job）；pid 读取与
    /// kill 并存时后者持锁阻塞，前者随之等待（终止期诊断延迟，可接受）。
    child: std::sync::Mutex<ManagedChild>,
    /// G1-02：per-agent 协议行为配置（connect_with_logs 从 agent.protocol() clone；
    /// disconnected() 用默认实例）。超时/限额/握手参数唯一读取点。
    pub protocol: pylon_core::agent_config::AcpProtocolConfig,
    /// P1（能力协商暴露）：initialize 握手返回的 agentCapabilities（原始 Value，
    /// 含 loadSession/promptCapabilities/sessionCapabilities/mcpCapabilities 及
    /// _meta 私有扩展）。连接成功才有；断开/未连接为 None。客户端替换时随新
    /// AcpClient 自然更新（generation 隔离保证旧客户端不污染）。
    capability_registry: CapabilityRegistry,
    /// A1c：SDK 引擎是唯一后端（legacy 传输 `AcpBackend::Legacy` 已删除）。
    /// 共享字段（child/protocol/capability_registry/stderr_tail/wire_trace/
    /// crashed/crashed_watch）保留在 facade。
    pub backend: SdkBackend,
    /// Set when the child process exits unexpectedly.
    pub crashed: Arc<AtomicBool>,
    /// #163：主动 stop 标记（[`Self::kill`] 在杀进程前置位）。子进程死亡本身
    /// 无法区分「主动停」与「意外崩溃」（同一 exit watcher / EOF 信号），凭本
    /// 标记判定：`is_crashed()` 只认意外退出，`is_dead()` 认一切连接死亡。
    /// #451：占位构造 [`Self::disconnected`] 同样置位——占位即死连接。
    stopped: AtomicBool,
    /// A7：EOF 崩溃信号独立 watch 通道（保留最新值，broadcast 洪泛 Lagged 丢消息
    /// 时 NOTIF_AGENT_CRASHED 可能丢失，本通道是自动重连的可靠信号源）。
    /// reader 线程 EOF 时 `send(true)`；dispatcher 经 [`Self::crashed_receiver`] 订阅。
    crashed_watch: watch::Sender<bool>,
    /// 保持通道开放的兜底接收端：reader 线程在外部订阅之前崩溃时，`send` 不会因
    /// "无接收者"失败——订阅方经 `has_changed`/`borrow` 仍能读到 true。
    _crashed_watch_rx: watch::Receiver<bool>,
    /// OBS-01：本连接的 ACP wire 只读记录器（transport 边界，infallible）。
    /// 断开态为 None；连接后始终存在（容量上限 ring buffer，可 set_enabled 关闭）。
    wire_trace: Option<Arc<AcpWireCapture>>,
    pub stderr_tail: Arc<StderrTail>,
    /// B2：initialize 是否完成。session/new 之前必须为 true——守卫在
    /// `session_ready()` 消费，禁止任何绕过握手的会话建立。
    session_ready: AtomicBool,
    /// B2：catalog 声明的会话建立顺序（connect 时按 provider 解析；无 catalog
    /// profile 时为默认 resume→load→new）。revive 链经协商快照
    /// `negotiated::NegotiatedCapabilitySnapshot::establishment_channels` 做
    /// 「声明 ∩ 服务端广告」交集。
    establishment_order: Vec<String>,
    /// OBS-02：本连接所属 client 代际（`connect_with_generation` 传入；断开态 0）。
    /// #549：客户端自知代际——宿主单元锁退役后，cancel/kill「落在哪一代」由
    /// 快照解析出的客户端自带 generation 判定（ADR-0037），不再借宿主原子量在锁内比对。
    client_generation: u64,
}

/// Default establishment order when no catalog profile declares one: the
/// pre-B2 behavior (resume → load → new), which every current catalog entry
/// also declares.
fn default_establishment_order() -> Vec<String> {
    ["resume", "load", "new"]
        .into_iter()
        .map(String::from)
        .collect()
}

/// Catalog-declared establishment order for a provider; unknown/absent
/// provider keeps the default (fail-open here is deliberate: an unknown
/// provider must not silently lose session revival — the server advertisement
/// side still gates every channel).
fn declared_establishment_order(provider: Option<&str>) -> Vec<String> {
    let Some(provider) = provider else {
        return default_establishment_order();
    };
    let Ok(Some(profile)) = pylon_core::agent_catalog::provider_profile(provider) else {
        return default_establishment_order();
    };
    let order: Vec<String> = profile
        .session_establishment
        .order
        .iter()
        .map(|method| match method {
            pylon_core::agent_catalog::CatalogSessionMethod::Resume => "resume",
            pylon_core::agent_catalog::CatalogSessionMethod::Load => "load",
            pylon_core::agent_catalog::CatalogSessionMethod::New => "new",
        })
        .map(String::from)
        .collect();
    if order.is_empty() {
        default_establishment_order()
    } else {
        order
    }
}

/// The connection's single-consumer Kernel notification streams（#548 一次性移交）。
///
/// #99：updates 与 control 双通道——控制帧（agent 请求/崩溃广播）走独立有界
/// 通道，dispatcher 以 `biased` select 优先消费，不被通知洪泛饿死。
///
/// 单消费者契约由所有权承载：inbox 只能从 [`AcpClient::take_notification_inbox`]
/// 取走一次，`recv` 需要 `&mut`——两个任务并发消费同一连接的 lane 在编译期不可表达。
pub struct NotificationInbox {
    updates: mpsc::Receiver<ClassifiedMessage>,
    control: mpsc::Receiver<ClassifiedMessage>,
}

impl NotificationInbox {
    pub fn new(
        updates: mpsc::Receiver<ClassifiedMessage>,
        control: mpsc::Receiver<ClassifiedMessage>,
    ) -> Self {
        Self { updates, control }
    }

    /// 普通通知 lane（session/update 等）。
    pub async fn recv(&mut self) -> Option<ClassifiedMessage> {
        self.updates.recv().await
    }

    /// 控制帧 lane（agent JSON-RPC 请求 / 崩溃广播；优先消费）。
    pub async fn recv_control(&mut self) -> Option<ClassifiedMessage> {
        self.control.recv().await
    }

    /// #99 biased 双 lane 消费：控制帧优先，通知洪泛不饿死交互请求。
    /// 任一 lane 返回 `None`（关闭且排空）即原样上抛——与旧泵「两分支各自
    /// `None => Stop`」语义逐点一致，借用上单点持有 `&mut self`。
    pub async fn recv_biased(&mut self) -> Option<ClassifiedMessage> {
        tokio::select! {
            biased;
            raw = self.control.recv() => raw,
            raw = self.updates.recv() => raw,
        }
    }
}
/// B1：消息类型化分类（reader 一次分类，dispatcher 枚举匹配——method 拼写错误
/// 编译期拦截；未知 method 归 OtherNotification，行为与旧 `_ => {}` 忽略一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpKind {
    /// 带 id 的 JSON-RPC 响应（method 为 None）。
    Response,
    /// session/update 通知（dispatcher 主通道）。
    SessionUpdate,
    /// session/request_permission 请求（B9 权限审批）。
    PermissionRequest,
    /// pylon:agent-crashed 崩溃广播。
    Crashed,
    /// #315 provider 私有扩展通知（peri/agent_event 等；dispatcher 包络为
    /// session/update 形状后走标准通路，见 [`wrap_provider_extension_notification`]）。
    ProviderExtension,
    /// #316：elicitation/complete —— URL 模式外带交互完成通知（agent→client；
    /// 官方契约：客户端忽略未知/已完成 id）。
    ElicitationComplete,
    /// 其他通知（透传忽略，dispatcher 不处理）。
    OtherNotification,
}

impl AcpKind {
    pub fn from_method(method: Option<&str>) -> Self {
        match method {
            None => Self::Response,
            Some(NOTIF_AGENT_CRASHED) => Self::Crashed,
            Some(super::NOTIF_ELICITATION_COMPLETE) => Self::ElicitationComplete,
            Some(METHOD_SESSION_REQUEST_PERMISSION) => Self::PermissionRequest,
            Some(NOTIF_SESSION_UPDATE) => Self::SessionUpdate,
            Some(
                NOTIF_PERI_AGENT_EVENT
                | NOTIF_PERI_AGENT_EVENT_DONE
                | NOTIF_PERI_UNSTABLE_EVENT
                | NOTIF_PERI_PREDICTION_READY,
            ) => Self::ProviderExtension,
            Some(_) => Self::OtherNotification,
        }
    }
}

/// #315：provider 私有扩展通知就地包络为 session/update 形状——provider 载荷
/// 字段**原样保留**，只补 `sessionUpdate` 判别符（取 wire method 原名，如
/// `peri/agent_event`）。下游 durable canonical + publish 与标准 update 共用
/// 同一通路；`peri/agent_event` 的 `event_json` 保持字符串形态，由前端
/// normalizer 单点解析（live/replay/restart 同一解析路径）。
///
/// 已知形状（peri-acp event_sink.rs / host/mod.rs）：
/// - `peri/agent_event`       `{sessionId, event_json}` → update 携带 `eventJson`
/// - `peri/agent_event_done`  `{sessionId, stopReason, requestId?}`
/// - `peri/unstable-event`    `{sessionId, event, data}`
/// - `peri/prediction_ready`  `{sessionId, text, actions}`
///
/// params 非 object 或缺 `sessionId` 字符串时返回 None（调用方丢弃并告警）；
/// host 级 OAuth 通知的 `sessionId` 为空串，照原样包络（无绑定会话，由
/// dispatcher 既有 stale-session 路径拒绝）。
pub fn wrap_provider_extension_notification(
    method: &str,
    params: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    let serde_json::Value::Object(mut map) = params? else {
        return None;
    };
    let session_id = map
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::to_owned)?;
    map.remove("sessionId");
    let mut update = serde_json::Map::new();
    update.insert("sessionUpdate".into(), serde_json::json!(method));
    for (key, value) in map {
        // `event_json` → `eventJson`（camelCase 投影，避免前端再适配蛇形）。
        update.insert(
            if key == "event_json" {
                "eventJson".into()
            } else {
                key
            },
            value,
        );
    }
    Some(serde_json::json!({ "sessionId": session_id, "update": update }))
}

#[derive(Debug, Clone)]
pub struct RawMessage {
    /// ACP-01：JSON-RPC id 原始形态（number/string）——response 必须用原 variant
    /// 回写；null/absent → None（不静默当 0）。Pylon outbound 自生成 id 恒为
    /// `RequestId::Number`。
    pub id: Option<RequestId>,
    pub method: Option<String>,
    pub kind: AcpKind,
    pub result: Option<serde_json::Value>,
    pub params: Option<serde_json::Value>,
    pub error: Option<serde_json::Value>,
}

/// Transport-owned classification produced once by the stdout reader and shared
/// by the Kernel inbox and replay observer. `_meta.periReplay` remains only a
/// compatibility projection of this decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayClassification {
    Live,
    Replay { request_id: u64 },
    Boundary { request_id: u64 },
}

#[derive(Debug, Clone)]
pub struct ClassifiedMessage {
    pub raw: RawMessage,
    pub classification: ReplayClassification,
    pub wire_ordinal: Option<u64>,
    /// #99：本连接入站帧的单调 ingress ordinal（1 起；publish_inbound 分配）。
    /// live/replay/boundary 共用同一序列模型；优先级 lane 不改写本序号。
    pub ingress_seq: u64,
}

impl ClassifiedMessage {
    pub fn live(raw: RawMessage) -> Self {
        Self {
            raw,
            classification: ReplayClassification::Live,
            wire_ordinal: None,
            ingress_seq: 0,
        }
    }
}

impl AcpClient {
    pub fn disconnected() -> Self {
        let (outbound, outbound_rx) = mpsc::channel(1);
        drop(outbound_rx);
        let (updates_tx, updates_rx) = mpsc::channel(NOTIFICATION_CHAN_CAP);
        drop(updates_tx);
        let (control_tx, control_rx) = mpsc::channel(CONTROL_INBOX_CAP);
        drop(control_tx);
        let (replay_events, _) = broadcast::channel(BROADCAST_CAP);
        let (shutdown, _) = watch::channel(false);
        let (crashed_watch, crashed_watch_rx) = watch::channel(false);
        Self {
            child: std::sync::Mutex::new(ManagedChild::empty()),
            protocol: pylon_core::agent_config::AcpProtocolConfig::default(),
            capability_registry: CapabilityRegistry::default(),
            session_ready: AtomicBool::new(false),
            establishment_order: default_establishment_order(),
            client_generation: 0,
            backend: SdkBackend {
                outbound,
                next_id: Arc::new(AtomicU64::new(1)),
                inbound: std::sync::Mutex::new(Some(NotificationInbox::new(
                    updates_rx, control_rx,
                ))),
                telemetry: Arc::new(InboundTelemetry::new()),
                replay_events,
                active_replay_requests: Arc::new(Mutex::new(HashMap::new())),
                pending_requests: Arc::new(Mutex::new(HashMap::new())),
                shutdown,
                join: std::sync::Mutex::new(None),
            },
            crashed: Arc::new(AtomicBool::new(false)),
            // #451：占位即死连接（无子进程、接收端全部已 drop），stopped 如实
            // 置位使 is_dead()=true——发送路径「无主 Crashed」接管触发集据此
            // 识别全新 runtime 的预算超时残留。is_crashed() 仍为 false（crashed
            // 标志未置位），崩溃通知机制不受扰。
            stopped: AtomicBool::new(true),
            crashed_watch,
            _crashed_watch_rx: crashed_watch_rx,
            wire_trace: None,
            stderr_tail: Arc::new(StderrTail::new()),
        }
    }

    /// D11：取后端中立应答句柄（锁内取、锁外 await）。
    pub fn responder(&self) -> ResponderHandle {
        ResponderHandle {
            pending_requests: self.backend.pending_requests.clone(),
        }
    }

    /// A1b：SDK 侧 pending 由 `SentRequest::cancel` / 响应路由自动清理，无需 facade 介入。
    pub fn remove_pending(&self, _id: u64) {}

    /// Send a JSON-RPC request and wait for the matching response.
    /// 同步准备一次 JSON-RPC 请求（登记 pending + 序列化），不写入 stdin。
    /// 调用方持锁只覆盖本方法；发送与等待经 [`PreparedRpc::complete`] 在锁外进行，
    /// 避免 Peri 卡顿时全局串行化（一个慢 RPC 阻塞所有其他命令）。
    pub fn prepare_rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<PreparedRpc, AcpError> {
        if self.is_dead() {
            return Err(AcpError::ConnectionClosed);
        }
        prepared_sdk_rpc(&self.backend, method, params, self.protocol.rpc_timeout())
    }

    async fn call_async(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, AcpError> {
        self.prepare_rpc(method, params)?.complete().await
    }

    /// Prepare a prompt request without writing to stdin.
    /// R3：与 [`Self::prepare_rpc`] 统一返回 [`PreparedRpc`]——发送经 `send_keep_rx`
    /// （含写超时与失败路径 pending 清理），等待经 [`wait_prompt_with_recovery`]。
    pub fn prepare_prompt(
        &self,
        session_id: &str,
        prompt: Vec<serde_json::Value>,
    ) -> Result<PreparedRpc, AcpError> {
        // 审查修复：与 prepare_rpc 一致，死亡连接立即拒绝（否则挂满 300s 假超时）
        if self.is_dead() {
            return Err(AcpError::ConnectionClosed);
        }
        // 先构造参数（可能因 block 格式失败），成功后再登记请求，避免泄漏。
        let params = session_prompt_params(session_id, prompt)?;
        prepared_sdk_rpc(
            &self.backend,
            METHOD_SESSION_PROMPT,
            params,
            self.protocol.rpc_timeout(),
        )
    }

    /// Kill the child process. Called before switching agents to prevent orphans.
    /// R4：同时 abort 引擎任务——替换时旧任务可能正阻塞在写通道，随后在子进程
    /// 终止、写失败后自行结束。
    /// #163：先置主动 stop 标记再杀——kill 引发的进程退出（exit watcher/EOF）
    /// 与意外崩溃共享同一信号，必须先立「这是主动停」的证词再动手。
    /// #549：`&self`——child/join 的 `&mut` 内部态收进 std 互斥（结构体注释），
    /// 宿主得以用 `Arc<AcpClient>` 快照持连接。
    pub fn kill(&self) -> Result<(), AcpError> {
        self.stopped.store(true, Ordering::Release);
        // (#260-B6) 语义等价的零分配判定（含「最新行超 512 字节即视为无证据」边界）。
        if !self.stderr_tail.has_recent_evidence(512) {
            tracing::debug!("ACP connection closing without stderr evidence");
        }
        let _ = self.backend.shutdown.send(true);
        if let Ok(mut join) = self.backend.join.lock() {
            if let Some(handle) = join.take() {
                handle.abort();
            }
        }
        let mut child = self
            .child
            .lock()
            .map_err(|_| AcpError::Child("acp child guard poisoned".to_string()))?;
        child.kill_and_wait()
    }

    /// Check if the child process has exited unexpectedly.
    /// #163：主动 stop（[`Self::kill`]）引发的进程退出**不算**崩溃——状态
    /// 消费方（list_agents / agent_status_payload / detect_and_record_crashes）
    /// 据此把「被切走的 Agent」报成 disconnected 而非 crashed。
    pub fn is_crashed(&self) -> bool {
        self.crashed.load(Ordering::Relaxed) && !self.stopped.load(Ordering::Relaxed)
    }

    /// 连接是否已不可用（意外崩溃**或**主动 stop）。
    /// 发送守卫（prepare_rpc / prepare_prompt / send_notification）与
    /// pending 清理（permission 超时）用本判定——主动停掉的连接同样无法送达。
    pub fn is_dead(&self) -> bool {
        self.crashed.load(Ordering::Relaxed) || self.stopped.load(Ordering::Relaxed)
    }

    /// P1：initialize 握手返回的 agentCapabilities（连接成功才有）。
    pub fn agent_capabilities(&self) -> Option<&serde_json::Value> {
        self.capabilities().raw()
    }

    /// Typed, fail-closed view of the initialize negotiation.
    pub fn capabilities(&self) -> &CapabilityRegistry {
        &self.capability_registry
    }

    /// B2：initialize 是否完成（session/new 守卫的数据源）。
    pub fn session_ready(&self) -> bool {
        self.session_ready
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// B2：catalog 声明的会话建立顺序（revive 链交集的声明侧）。
    pub fn establishment_order(&self) -> &[String] {
        &self.establishment_order
    }

    /// OBS-02：本连接所属 client 代际（#549：快照解析后的 generation 自校验数据源）。
    pub fn client_generation(&self) -> u64 {
        self.client_generation
    }

    /// OBS-01：本连接的 ACP wire 只读记录器（断开态为 None）。
    pub fn wire_trace(&self) -> Option<Arc<AcpWireCapture>> {
        self.wire_trace.clone()
    }

    /// A7：订阅崩溃信号（EOF 后为 true）。watch 保留最新值——订阅晚于崩溃时
    /// `has_changed`/`borrow` 仍能读到 true，不依赖时序。
    pub fn crashed_receiver(&self) -> watch::Receiver<bool> {
        self.crashed_watch.subscribe()
    }

    /// #247：宿主 real_acp_smoke/tests 跨 crate 消费，常态可见（与 instance_pid
    /// 同源的子进程 pid 诊断面）。
    pub fn child_id(&self) -> Option<u32> {
        self.child.lock().ok()?.pid()
    }

    /// B3：实例注册表登记用的子进程 pid（诊断关联，非安全边界）。
    pub fn instance_pid(&self) -> Option<u32> {
        self.child.lock().ok()?.pid()
    }

    /// Send a fire-and-forget notification (no id, no response expected).
    /// 仅被 [`Self::cancel_session`] 调用。
    async fn send_notification(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), AcpError> {
        if self.is_dead() {
            return Err(AcpError::ConnectionClosed);
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        self.backend
            .outbound
            .send(SdkOutbound::Notification {
                method: method.to_string(),
                params,
                reply: reply_tx,
            })
            .await
            .map_err(|_| AcpError::ConnectionClosed)?;
        reply_rx.await.unwrap_or(Err(AcpError::ConnectionClosed))
    }

    /// Cancel a running prompt. Fire-and-forget notification.
    /// #316：params 由官方 `CancelNotification` 构造（wire 与手写 json!
    /// 逐字节一致：{"sessionId":..}）。
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), AcpError> {
        let notification =
            agent_client_protocol_schema::v1::CancelNotification::new(session_id.to_string());
        let params = serde_json::to_value(notification)
            .map_err(|error| AcpError::Child(format!("serialize session/cancel: {error}")))?;
        self.send_notification(METHOD_SESSION_CANCEL, params).await
    }

    /// Connect from AgentDef with optional structured runtime log sink.
    /// OBS-02：client_generation 固定为 0（旧调用点/测试）。生产路径请用
    /// [`Self::connect_with_generation`] 传入连接所属真实代际。
    pub async fn connect_with_logs(
        agent: &pylon_core::agent_config::AgentDef,
        runtime_logs: Option<Arc<dyn crate::runtime_sink::RuntimeLogSink>>,
    ) -> Result<Self, AcpError> {
        Self::connect_with_generation(agent, runtime_logs, 0).await
    }

    /// 连接 ACP 子进程并指定连接所属 client 代际（OBS-02 correlation）。
    /// generation 在 runtime replacement 时递增（lifecycle::do_connect_and_replace
    /// 传 `runtime.client_generation + 1`），wire trace 据此区分代际记录。
    pub async fn connect_with_generation(
        agent: &pylon_core::agent_config::AgentDef,
        runtime_logs: Option<Arc<dyn crate::runtime_sink::RuntimeLogSink>>,
        client_generation: u64,
    ) -> Result<Self, AcpError> {
        let resolved_agent;
        let base_dir: Option<PathBuf> = pylon_core::agent_config::effective_config_path()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let agent = if let Some(base_dir) = &base_dir {
            resolved_agent = agent.resolve_paths(base_dir);
            &resolved_agent
        } else {
            agent
        };
        match agent.transport.as_str() {
            "subprocess" => {
                let mut child =
                    super::process::spawn_agent_child(agent, base_dir.as_deref()).await?;
                let (crashed_watch, crashed_watch_rx) = watch::channel(false);
                let crashed = Arc::new(AtomicBool::new(false));
                // OBS-02：hub 以连接级 correlation context（含 clientGeneration）构造。
                let wire_trace = AcpWireHub::for_agent(agent, client_generation);

                // Drain stderr（防管道缓冲死锁）
                let stderr = child
                    .take_stderr()
                    .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                let stderr_tail = Arc::new(StderrTail::new());
                spawn_stderr_reader(
                    stderr,
                    &agent.name,
                    &runtime_logs,
                    Some(wire_trace.correlation().clone()),
                    stderr_tail.clone(),
                );

                let stdin = child
                    .take_stdin()
                    .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                let stdout = child
                    .take_stdout()
                    .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                let pid = child.pid();
                let backend = super::engine::spawn_sdk_engine(
                    agent,
                    stdin,
                    stdout,
                    wire_trace.clone(),
                    crashed.clone(),
                    crashed_watch.clone(),
                )?;
                // 子进程退出是权威崩溃信号（SDK 的 EOF 语义在洪泛/批量场景不可靠）。
                if let Some(pid) = pid {
                    let crashed = crashed.clone();
                    let crashed_watch = crashed_watch.clone();
                    if !ManagedChild::spawn_exit_watcher(pid, move || {
                        crashed.store(true, std::sync::atomic::Ordering::Release);
                        let _ = crashed_watch.send(true);
                    }) {
                        tracing::warn!("acp sdk engine: exit watcher unavailable for pid {pid}");
                    }
                }

                let mut client = AcpClient {
                    child: std::sync::Mutex::new(child),
                    protocol: pylon_core::hermes::runtime::effective_protocol(agent),
                    capability_registry: CapabilityRegistry::default(),
                    backend,
                    crashed,
                    stopped: AtomicBool::new(false),
                    crashed_watch,
                    _crashed_watch_rx: crashed_watch_rx,
                    wire_trace: Some(wire_trace),
                    stderr_tail: stderr_tail.clone(),
                    session_ready: AtomicBool::new(false),
                    establishment_order: declared_establishment_order(agent.provider.as_deref()),
                    client_generation,
                };
                let stderr_mark = stderr_tail.mark();
                // #316：宿主门解析一次（YAML+env 单一来源）——结论同时喂
                // initialize 广告注入与 runtime 门禁（lifecycle 用同一 resolve），
                // 消除「广告 fs 但门禁拒答」的同源破窗。
                let host_env = agent
                    .env
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<std::collections::BTreeMap<_, _>>();
                let host_policy = crate::host_tools::HostToolsPolicy::resolve(
                    client.protocol.host_tools,
                    client.protocol.host_terminal,
                    &host_env,
                )
                .unwrap_or_else(|error| {
                    tracing::warn!("invalid host tools policy; using fail-closed gates: {error}");
                    crate::host_tools::HostToolsPolicy::closed()
                });
                // Initialize——B2：握手三段由纯函数 `build_initialize_plan` 成形
                // （G1-03 覆盖制语义不变：clientCapabilities D1 / protocolVersion H3 /
                // clientInfo H4，wire 逐字节不变），client 只消费计划。
                // A3：caps 合并/形状失败即连接失败（不静默用默认 caps 继续握手）。
                let initialize_plan = super::initialize_plan::build_initialize_plan(
                    &client.protocol,
                    agent.provider.as_deref(),
                    host_policy,
                )?;
                let initialize_response = match client
                    .call_async(METHOD_INITIALIZE, initialize_plan.params())
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        let exit_code = client
                            .child
                            .lock()
                            .ok()
                            .and_then(|mut child| child.try_wait().ok().flatten())
                            .and_then(|status| status.code());
                        let mut failure = AgentConnectFailure::initialize(error, exit_code);
                        let tail = stderr_tail.tail_since(stderr_mark, 8, 2048);
                        if !tail.lines.is_empty() {
                            failure.stderr_excerpt = Some(tail.lines.join("\n"));
                        }
                        return Err(failure.into());
                    }
                };
                // P1（能力协商暴露）：握手响应的 agentCapabilities 存起来——前端
                // 能力驱动 UI（loadSession/image/fork/resume/mcp）经 agent_status
                // 读取；未声明时保持 None。
                client.capability_registry =
                    match CapabilityRegistry::from_initialize_response(&initialize_response) {
                        Ok(registry) => registry,
                        Err(message) => {
                            let mut failure = AgentConnectFailure::capability(message);
                            let tail = stderr_tail.tail_since(stderr_mark, 8, 2048);
                            if !tail.lines.is_empty() {
                                failure.stderr_excerpt = Some(tail.lines.join("\n"));
                            }
                            return Err(failure.into());
                        }
                    };
                // #316：protocolVersion 回显校验——官方契约要求版本不一致时
                // 客户端断连并告知用户。缺字段 lenient 放行（存量非合规 agent
                // 不因本校验新增失败），存在且不一致 fail-closed。
                if let Err(message) = super::protocol::validate_protocol_version(
                    &initialize_response,
                    initialize_plan.protocol_version,
                ) {
                    let mut failure =
                        AgentConnectFailure::preflight("protocol_version_mismatch", message);
                    let tail = stderr_tail.tail_since(stderr_mark, 8, 2048);
                    if !tail.lines.is_empty() {
                        failure.stderr_excerpt = Some(tail.lines.join("\n"));
                    }
                    return Err(failure.into());
                }
                // B2：initialize 完成（能力协商成功）之后，session/new 才被允许。
                client
                    .session_ready
                    .store(true, std::sync::atomic::Ordering::Release);
                Ok(client)
            }
            other => Err(AgentConnectFailure::preflight(
                "agent_transport_unsupported",
                format!("unsupported transport: {other}"),
            )
            .into()),
        }
    }

    /// Take the one Kernel notification inbox for this connection generation
    /// （#548 一次性移交：第二次调用返回 `None`——单消费者契约的运行时可证形态）。
    pub fn take_notification_inbox(&self) -> Option<NotificationInbox> {
        self.backend.inbound.lock().ok()?.take()
    }
}

#[cfg(test)]
mod extension_wrap_tests {
    use super::*;

    #[test]
    fn notification_inbox_is_take_once() {
        let client = AcpClient::disconnected();
        assert!(
            client.take_notification_inbox().is_some(),
            "首次 take 必须拿到 inbox"
        );
        assert!(
            client.take_notification_inbox().is_none(),
            "#548：同一连接第二次 take 必须返回 None（单消费者契约）"
        );
    }

    #[test]
    fn peri_extension_methods_classify_as_provider_extension() {
        for method in [
            NOTIF_PERI_AGENT_EVENT,
            NOTIF_PERI_AGENT_EVENT_DONE,
            NOTIF_PERI_UNSTABLE_EVENT,
            NOTIF_PERI_PREDICTION_READY,
        ] {
            assert_eq!(
                AcpKind::from_method(Some(method)),
                AcpKind::ProviderExtension
            );
        }
        assert_eq!(
            AcpKind::from_method(Some(NOTIF_SESSION_UPDATE)),
            AcpKind::SessionUpdate
        );
        assert_eq!(
            AcpKind::from_method(Some("peri/other")),
            AcpKind::OtherNotification
        );
    }

    #[test]
    fn agent_event_wraps_with_verbatim_discriminator_and_camel_event_json() {
        let params = serde_json::json!({
            "sessionId": "s-1",
            "event_json": "{\"type\":\"subagent_started\",\"value\":{}}"
        });
        let wrapped = wrap_provider_extension_notification(NOTIF_PERI_AGENT_EVENT, Some(params))
            .expect("wrap succeeds");
        assert_eq!(wrapped["sessionId"], "s-1");
        assert_eq!(wrapped["update"]["sessionUpdate"], "peri/agent_event");
        assert!(wrapped["update"]["eventJson"].is_string());
        assert!(wrapped["update"].get("event_json").is_none());
    }

    #[test]
    fn done_and_unstable_payload_fields_are_preserved_verbatim() {
        let done = wrap_provider_extension_notification(
            NOTIF_PERI_AGENT_EVENT_DONE,
            Some(serde_json::json!({ "sessionId": "s-1", "stopReason": "end_turn", "requestId": "42" })),
        )
        .expect("wrap succeeds");
        assert_eq!(done["update"]["sessionUpdate"], "peri/agent_event_done");
        assert_eq!(done["update"]["stopReason"], "end_turn");
        assert_eq!(done["update"]["requestId"], "42");

        let unstable = wrap_provider_extension_notification(
            NOTIF_PERI_UNSTABLE_EVENT,
            Some(serde_json::json!({ "sessionId": "s-1", "event": "trace", "data": { "n": 1 } })),
        )
        .expect("wrap succeeds");
        assert_eq!(unstable["update"]["sessionUpdate"], "peri/unstable-event");
        assert_eq!(unstable["update"]["data"]["n"], 1);
    }

    #[test]
    fn missing_session_id_or_object_params_is_rejected() {
        assert!(wrap_provider_extension_notification(NOTIF_PERI_AGENT_EVENT, None).is_none());
        assert!(wrap_provider_extension_notification(
            NOTIF_PERI_AGENT_EVENT,
            Some(serde_json::json!({ "event_json": "{}" })),
        )
        .is_none());
        assert!(wrap_provider_extension_notification(
            NOTIF_PERI_AGENT_EVENT,
            Some(serde_json::json!([1, 2])),
        )
        .is_none());
    }
}
