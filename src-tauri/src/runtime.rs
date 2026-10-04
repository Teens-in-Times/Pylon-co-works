//! AgentRuntimeManager：多 agent 运行时（B7a）。
//!
//! 单 active runtime 的机械抽取：每个 agent 拥有独立的
//! acp / client_generation / dispatcher / sessions / 状态 / 自动重连，
//! 事件永不跨 agent 串扰。gateway 平台适配器层（B10）依赖本模块做会话路由。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;

use crate::acp::AcpClient;
use crate::agent::runtime::{AgentRuntimeState, SessionBindingHealth};
use crate::session::SessionInfo;

/// Stable identity for a GUI/runtime session context.
///
/// `source` is only unique within one Agent runtime. Keeping `agent_id` as a
/// separate field prevents two agents that use the same source string from
/// being treated as the same workspace/session.
///
/// 仅测试消费（#228）：生产会话键即裸 `source`（`AgentRuntime.sessions`），
/// owner 维度路由由 `session::owner`（`SessionOwner`/`DurableSessionOwner`）
/// 承担；本类型仅剩 §5.8 互转测试（owner `as_context_key`）引用。生产重新
/// 采用 context key 或契约收敛裁除时落定去留并摘除 `#[cfg(test)]`。
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct AgentContextKey {
    pub(crate) agent_id: String,
    pub(crate) source: String,
}

#[cfg(test)]
impl AgentContextKey {
    pub(crate) fn new(agent_id: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            agent_id: agent_id.into(),
            source: source.into(),
        }
    }
}

/// 单个 agent 的运行时状态（per-agent 隔离）。
/// A3：per-source 流式更新通道注册表类型别名。
pub type UpdateChannelMap =
    std::sync::Mutex<HashMap<String, tauri::ipc::Channel<serde_json::Value>>>;

/// #250：#53 空态选择器探测会话登记簿（peri_id → 探测时刻）。
///
/// 探测会话「不落会话槽位」（`probe_agent_selectors`），其建会话后迟到的
/// 元数据通知（`available_commands_update` 等）在 dispatcher 查无映射，逐条
/// `warn!` 成噪音。登记簿只做一件事：让 dispatcher 能区分「探测会话的预期
/// 无映射通知」与「真未知会话」。只进不出——close 之后的迟到帧恰是静音
/// 对象，条目带 TTL 自然失效，FIFO 有界防泄漏。
pub struct ProbeSessionRegistry {
    entries: Mutex<std::collections::VecDeque<(String, std::time::Instant)>>,
}

impl ProbeSessionRegistry {
    const CAPACITY: usize = 32;
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);

    pub fn new() -> Self {
        Self {
            entries: Mutex::new(std::collections::VecDeque::new()),
        }
    }

    /// 登记一个探测会话 peri_id；超容量丢最旧（探测频率 ≤ 每 agent 每 TTL 一次，
    /// 正常远达不到上界，上界只为兜底）。
    pub fn register(&self, peri_id: &str) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        entries.push_back((peri_id.to_string(), std::time::Instant::now()));
        while entries.len() > Self::CAPACITY {
            entries.pop_front();
        }
    }

    /// 是否为 TTL 内登记过的探测会话；查询时顺带剪枝过期项。
    pub fn contains(&self, peri_id: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        while entries
            .front()
            .is_some_and(|(_, at)| at.elapsed() > Self::TTL)
        {
            entries.pop_front();
        }
        entries.iter().any(|(id, _)| id == peri_id)
    }
}

impl Default for ProbeSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) struct DraftFlushRequest {
    pub source: String,
    pub reply: tokio::sync::oneshot::Sender<Result<(), String>>,
}

/// #155 T3：prompt 终态 draft 收口请求的发送端槽位（代际 + 发送端）。抽别名是
/// clippy::type_complexity 的要求，同时给「代际不符即视为无 dispatcher」这条
/// 语义一个可命名处。
pub(crate) type DraftFlushSender =
    Arc<Mutex<Option<(u64, tokio::sync::mpsc::UnboundedSender<DraftFlushRequest>)>>>;

pub struct AgentRuntime {
    /// #549/ADR-0037：acp 单元是「短窗换装位」——std RwLock 锁内**无 await**，
    /// 读侧经 [`Self::snapshot_acp`] clone Arc 即放锁，写侧仅替换赋值时持锁。
    /// cancel/kill 等原子性由快照客户端自带的 `client_generation` 自校验承担，
    /// 不再靠跨 await 持锁。别名形态见 `dispatcher::AcpLock`。
    pub acp: Arc<std::sync::RwLock<Arc<AcpClient>>>,
    pub notification_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Prompt terminal writes ask the dispatcher to close the preceding
    /// cross-window draft before allocating the terminal sequence.
    pub(crate) draft_flush_tx: DraftFlushSender,
    pub session_creation: Arc<tokio::sync::Mutex<()>>,
    pub agent_lifecycle: Arc<tokio::sync::Mutex<()>>,
    pub client_generation: Arc<AtomicU64>,
    pub prompt_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    pub sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
    /// Runtime-only health of source -> remote-session bindings. SQLite owner metadata remains
    /// authoritative; this map only gates use of a binding across client generations.
    pub binding_health: Arc<Mutex<HashMap<String, SessionBindingHealth>>>,
    pub agent_runtime: Arc<Mutex<AgentRuntimeState>>,
    pub auto_reconnect_active: Arc<AtomicBool>,
    /// #423：审批线单一登记面——统一交互队列（排序、生命周期、deadline 权威）
    /// 加挂起权限请求 store 与私有交互 store（elicitation、ask-user、exit-plan）。
    /// 写路径（admit、settle、restore、drain、clear）只允许经 InteractionLedger
    /// 单点方法，三 store 双写收口，结构性杜绝 #98 P2-1 类队列与 store 失配；
    /// 读路径经 ledger 访问器。
    pub ledger: crate::interaction_ledger::InteractionLedger,
    /// 会话映射就绪通知（R6，吸收 O5）：new_session / send_prompt_core 自动建会话 /
    /// load_persisted_session 的 sessions 映射插入成功后 notify_waiters，dispatcher
    /// 对未知 periId 的等待由 20×5ms 轮询改为事件驱动（100ms 窗口语义不变）。
    pub mapping_ready: tokio::sync::Notify,
    /// per-source 流式更新通道（Channel 化重构 A1）：send_message 注册、终帧/C7/generation
    /// bump 注销。dispatcher 对已注册 source 走 Channel 推送并跳过 WebView 广播（A3）。
    pub update_channels: Arc<UpdateChannelMap>,
    pub terminal_registry: Arc<crate::acp::terminal_runtime::TerminalRegistry>,
    /// B3：当前实例的注册表守卫（全局并发预算的 RAII 槽）。connect 成功登记，
    /// 替换/停止时出槽归还；runtime 整体 drop 时兜底释放。
    pub instance_guard: Arc<Mutex<Option<crate::acp::instance_registry::InstanceGuard>>>,
    /// B3（§4.4）：同一实例同一时刻最多一个 prompt 的闸门——冲突立即失败
    /// （稳定码 `prompt_in_progress`），不排队。
    pub prompt_gate: Arc<tokio::sync::Mutex<()>>,
    pub host_tools_policy: Arc<Mutex<crate::acp::host_tools::HostToolsPolicy>>,
    /// #99：prompt/turn 终态账本——本 runtime 的 live turn 权威状态
    /// （CAS 单终态、generation 硬隔离、冷挂载快照数据源）。
    pub turn_ledger: Arc<crate::acp::TurnLedger>,
    /// #250：#53 选择器探测会话登记簿——dispatcher 对其无映射通知静默降级（debug）。
    pub probe_sessions: Arc<crate::runtime::ProbeSessionRegistry>,
    /// ADR-0017/#217：「在途回合标记为真而账本已无在途 turn」的失配计数。
    /// 由 `cold_mount_turn_snapshot` 查询时判定并累加（诊断读数：标记与终态事件
    /// 失配会造出更难自查的永久生成中，必须显形）。
    pub turn_in_flight_anomalies: AtomicU64,
}

impl AgentRuntime {
    pub(crate) fn install_draft_flush_channel(
        &self,
        generation: u64,
    ) -> tokio::sync::mpsc::UnboundedReceiver<DraftFlushRequest> {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        if let Ok(mut slot) = self.draft_flush_tx.lock() {
            *slot = Some((generation, sender));
        }
        receiver
    }

    pub(crate) async fn flush_draft_before_terminal(
        &self,
        source: &str,
        generation: u64,
    ) -> Result<(), String> {
        let sender = self
            .draft_flush_tx
            .lock()
            .map_err(|_| "draft flush channel lock poisoned".to_string())?
            .as_ref()
            .filter(|(current, _)| *current == generation)
            .map(|(_, sender)| sender.clone());
        let Some(sender) = sender else {
            // There may be no dispatcher for a prompt with no live updates.
            // A stored draft, if any, is still guarded by draft_pending.
            return Ok(());
        };
        let (reply, received) = tokio::sync::oneshot::channel();
        sender
            .send(DraftFlushRequest {
                source: source.to_owned(),
                reply,
            })
            .map_err(|_| "draft dispatcher is unavailable".to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(5), received)
            .await
            .map_err(|_| "draft dispatcher flush timed out".to_string())?
            .map_err(|_| "draft dispatcher closed before flush".to_string())?
    }

    /// 以 disconnected 状态新建一个空 runtime（启动/降级路径用）。
    pub fn new_disconnected() -> Arc<Self> {
        Arc::new(Self {
            acp: Arc::new(std::sync::RwLock::new(Arc::new(AcpClient::disconnected()))),
            notification_task: Arc::new(Mutex::new(None)),
            draft_flush_tx: Arc::new(Mutex::new(None)),
            session_creation: Arc::new(tokio::sync::Mutex::new(())),
            agent_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            client_generation: Arc::new(AtomicU64::new(0)),
            prompt_locks: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            binding_health: Arc::new(Mutex::new(HashMap::new())),
            agent_runtime: Arc::new(Mutex::new(AgentRuntimeState::default())),
            auto_reconnect_active: Arc::new(AtomicBool::new(false)),
            ledger: crate::interaction_ledger::InteractionLedger::default(),
            mapping_ready: tokio::sync::Notify::new(),
            update_channels: Arc::new(Mutex::new(HashMap::new())),
            terminal_registry: Arc::new(crate::acp::terminal_runtime::TerminalRegistry::default()),
            instance_guard: Arc::new(Mutex::new(None)),
            prompt_gate: Arc::new(tokio::sync::Mutex::new(())),
            host_tools_policy: Arc::new(Mutex::new(
                crate::acp::host_tools::HostToolsPolicy::closed(),
            )),
            turn_ledger: crate::acp::TurnLedger::new(),
            probe_sessions: Arc::new(crate::runtime::ProbeSessionRegistry::new()),
            turn_in_flight_anomalies: AtomicU64::new(0),
        })
    }

    /// #549/ADR-0037：acp 单元快照——读锁仅护 Arc clone（纳秒级，锁内无 await），
    /// 调用方持 `Arc<AcpClient>` 独立使用；cancel/kill 的代际原子性由快照客户端
    /// 的 `client_generation()` 自校验承担，不再靠跨 await 持锁。
    pub fn snapshot_acp(&self) -> Arc<AcpClient> {
        self.acp
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// #549：安装新客户端（替换赋值是本单元唯一的写窗口）。
    /// 生产替换不经本方法——`lib.rs::replace_agent_client` 需要「检查→退役→
    /// 暴露」整窗写锁（含旧进程 kill），语义比单点赋值宽；故本助手仅测试域使用。
    #[cfg(test)]
    pub fn install_acp(&self, client: AcpClient) {
        *self
            .acp
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(client);
    }

    /// #316：fs/terminal 分门控策略解析——YAML（`acp.host_tools` /
    /// `acp.host_terminal`）声明优先，未声明门回退旧环境变量（两门共用）；
    /// 环境变量非法值 fail-closed（双门全关 + warn）。
    pub fn set_host_tools_policy(
        &self,
        protocol: &pylon_core::agent_config::AcpProtocolConfig,
        runtime_env: &std::collections::BTreeMap<String, String>,
    ) {
        let policy = crate::acp::host_tools::HostToolsPolicy::resolve(
            protocol.host_tools,
            protocol.host_terminal,
            runtime_env,
        )
        .unwrap_or_else(|error| {
            tracing::warn!("invalid host tools policy; using fail-closed gates: {error}");
            crate::acp::host_tools::HostToolsPolicy::closed()
        });
        if let Ok(mut current) = self.host_tools_policy.lock() {
            *current = policy;
        }
    }

    /// A1：注册 source 的流式更新通道（send_message 携带 Channel 时调用）。
    /// 同 source 重复注册以新换旧（旧 channel 随前端对象废弃，无需显式关闭）。
    /// 锁序：不得在持有 sessions 锁时调用（sessions → update_channels 单向）。
    pub fn register_update_channel(
        &self,
        source: &str,
        channel: tauri::ipc::Channel<serde_json::Value>,
    ) {
        if let Ok(mut map) = self.update_channels.lock() {
            map.insert(source.to_string(), channel);
        }
    }

    /// A1：注销并取回 source 的通道（终帧发送后 / C7 清理 / generation bump 调用）。
    pub fn take_update_channel(
        &self,
        source: &str,
    ) -> Option<tauri::ipc::Channel<serde_json::Value>> {
        self.update_channels
            .lock()
            .ok()
            .and_then(|mut map| map.remove(source))
    }

    /// B1：非破坏性向 source 的通道发一帧（不移除注册）。user echo 在 prompt
    /// 发送前产生，会话仍在途——绝不能用 take 语义（注销后 update 流断轨）。
    /// 返回 false = 未注册（调用方走广播兜底）。
    pub fn send_update_frame(&self, source: &str, frame: serde_json::Value) -> bool {
        match self
            .update_channels
            .lock()
            .ok()
            .and_then(|map| map.get(source).cloned())
        {
            Some(channel) => {
                if let Err(error) = channel.send(frame) {
                    tracing::warn!("channel 帧发送失败 source={source}: {error}");
                }
                true
            }
            None => false,
        }
    }

    /// A1：清空全部通道（C7 stop_agent_runtime / generation bump 批量清理）。
    pub fn clear_update_channels(&self) {
        if let Ok(mut map) = self.update_channels.lock() {
            map.clear();
        }
    }

    /// #99：冷挂载/前端刷新可依赖的后端 turn 快照（camelCase JSON）。
    ///
    /// 数据面全部来自后端权威状态，不依赖一次性 Tauri event：
    /// - `turn`：turn 账本的单条记录（在途优先，否则最近终态——含 `turnState`/
    ///   `terminalCause`）；会话无已知 turn 时缺省；
    /// - `turnInFlight`：#420/ADR-0034 在途回合事实——「本进程已派发 prompt、
    ///   尚未收到终态」（进程内，不落盘），由 turn_ledger.active 单源承载
    ///   （`turn` 记录无 terminal 即在途，与账本「在途优先」同口径）；
    /// - `turnInFlightAnomaly` / `turnInFlightAnomalies`：该会话存在
    ///   **非当前代际**在途残留的诊断读数（本次查询是否命中 / 累计计数）——
    ///   单源化后旧的「标记与账本失配」按构造不可达，判据换轴为
    ///   drop_generation 漏清检测（旧代际在途漏过清理会以幽灵在途污染后续
    ///   会话事实）；
    /// - `sequence`：入站 ingress 序列 cursor（lastIngressSeq/spill/drop/overloaded）；
    /// - `lastError`：runtime 生命周期错误；
    /// - `replayLoading`：session/load 回放进行中标志（replay progress 输入）。
    ///
    /// 会话映射不存在时返回 None（调用方不得伪造空快照）。
    ///
    /// #442 Step1：本方法为**单次读取**，除 JSON 快照体外同时归还类型化最新
    /// 账本记录（load 顶层 `turnBoundary` 的账本侧合成输入）——两份事实出自
    /// 同一账本读，避免「快照说在途、边界说已收敛」的响应内自相矛盾（两次
    /// 读取之间发生 settle 的竞态）。仅要快照体的调用方（契约测试）取 `.0`。
    pub(crate) async fn cold_mount_facts(
        &self,
        source: &str,
    ) -> Option<(
        serde_json::Value,
        Option<crate::acp::turn_ledger::TurnRecord>,
    )> {
        let (peri_id, generation, replay_loading) = {
            let sessions = self.sessions.lock().ok()?;
            let session = sessions.get(source)?;
            (
                session.peri_id.clone(),
                session.generation,
                session.replay_loading,
            )
        };
        let last_error = self
            .agent_runtime
            .lock()
            .ok()
            .and_then(|state| state.last_error.clone());
        let sequence = self.snapshot_acp().backend.telemetry.snapshot();
        let ledger_turn = self
            .turn_ledger
            .latest_session_snapshot(source, &peri_id, generation);
        let turn = ledger_turn
            .as_ref()
            .and_then(|record| serde_json::to_value(record).ok());
        // #420/ADR-0034：在途事实单源化——`turn` 记录无 terminal 即在途
        // （与 latest_session_snapshot 的「在途优先」选择器同口径，无第二来源）。
        let turn_in_flight = turn
            .as_ref()
            .is_some_and(|value| value.get("terminal").is_none());
        // #420 诊断读数（判据换轴）：同会话存在 generation ≠ 当前的在途残留。
        // 正常路径客户端替换时 drop_generation 整体清理，此值恒 0；>0 即旧代际
        // 在途漏过了清理（幽灵在途），必须显形：告警 + 计数 + 快照字段。
        let stale_active = self
            .turn_ledger
            .stale_active_for_session(source, generation);
        let turn_in_flight_anomaly = stale_active > 0;
        if turn_in_flight_anomaly {
            let anomalies = self
                .turn_in_flight_anomalies
                .fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                source,
                peri_id,
                generation,
                stale_active,
                anomalies = anomalies + 1,
                "turn ledger holds active turns from a stale generation for this session; \
                 drop_generation should have cleared them (ADR-0034 diagnostic)"
            );
        }
        Some((
            serde_json::json!({
                "source": source,
                "periId": peri_id,
                "generation": generation,
                "turn": turn,
                "turnInFlight": turn_in_flight,
                "turnInFlightAnomaly": turn_in_flight_anomaly,
                "turnInFlightAnomalies": self.turn_in_flight_anomalies.load(Ordering::Relaxed),
                "sequence": serde_json::to_value(sequence).unwrap_or(serde_json::Value::Null),
                "replayLoading": replay_loading,
                "lastError": last_error,
            }),
            ledger_turn,
        ))
    }

    /// O1：prompt 锁表随会话生命周期收敛（单 key 移除）——映射删除 = 该 source
    /// 生命周期结束；生成中的 prompt 持有 Arc 守卫，条目移除不影响在途等待，
    /// 新会话 prompt_lock_for 按需重建。G2-08：session.rs 私有 drop_prompt_lock
    /// 收敛为本方法（锁序纪律从注释约束升级为容器方法约束）。
    /// 锁序：调用方不得持有 sessions 锁（sessions → prompt_locks 单向）。
    pub fn remove_prompt_lock(&self, source: &str) {
        if let Ok(mut locks) = self.prompt_locks.lock() {
            locks.remove(source);
        }
    }

    /// 优化-1：批量移除（keep=false 客户端替换后 prompt 锁表同步收敛；G2-08：
    /// lib.rs 原 drop_stale_prompt_locks 收敛为本方法，行为零变化）。同锁序纪律。
    pub fn drop_prompt_locks(&self, stale_sources: &[String]) {
        if stale_sources.is_empty() {
            return;
        }
        if let Ok(mut locks) = self.prompt_locks.lock() {
            for source in stale_sources {
                locks.remove(source);
            }
        }
    }
}

/// 多 agent 运行时注册表：agent_id → AgentRuntime。
///
/// DashMap 分片锁：entry 原子单实例创建、get/iter 免整表锁、
/// 无 std RwLock poison 面（W1-R1）。
pub struct AgentRuntimeManager {
    runtimes: DashMap<String, Arc<AgentRuntime>>,
}

impl AgentRuntimeManager {
    pub fn new() -> Self {
        Self {
            runtimes: DashMap::new(),
        }
    }

    pub fn insert(&self, agent_id: String, runtime: Arc<AgentRuntime>) {
        self.runtimes.insert(agent_id, runtime);
    }

    /// 获取或创建 agent 的 runtime（switch/reconnect 懒启动路径）。
    /// 并发重复调用只会创建一个实例（DashMap entry API 保证原子单实例）。
    pub fn get_or_create(&self, agent_id: &str) -> Arc<AgentRuntime> {
        self.runtimes
            .entry(agent_id.to_string())
            .or_insert_with(AgentRuntime::new_disconnected)
            .value()
            .clone()
    }

    pub fn get(&self, agent_id: &str) -> Option<Arc<AgentRuntime>> {
        self.runtimes.get(agent_id).map(|r| r.value().clone())
    }

    /// CLI 增强：遍历 (agent_id, runtime) 快照——interaction_list 等聚合命令用。
    pub fn iter(&self) -> Vec<(String, Arc<AgentRuntime>)> {
        self.runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect()
    }

    /// 移除 agent 的 runtime（C6：reload 删除 agent 时清理幽灵 runtime）。
    /// 返回被移除的 runtime（未注册时返回 None）。
    pub fn remove(&self, agent_id: &str) -> Option<Arc<AgentRuntime>> {
        self.runtimes.remove(agent_id).map(|(_, runtime)| runtime)
    }

    /// 全部 runtime（会话生命周期 watcher / gateway_status 遍历用）。
    pub fn all(&self) -> Vec<Arc<AgentRuntime>> {
        self.runtimes.iter().map(|r| r.value().clone()).collect()
    }

    /// 全部 runtime 带 agent_id（B2 Inspector 完整版 per-agent 聚合用）。
    pub fn all_with_ids(&self) -> Vec<(String, Arc<AgentRuntime>)> {
        self.runtimes
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect()
    }
}

impl Default for AgentRuntimeManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prompt_terminal_waits_for_dispatcher_draft_flush_ack() {
        let runtime = AgentRuntime::new_disconnected();
        let mut requests = runtime.install_draft_flush_channel(3);
        let waiting = {
            let runtime = runtime.clone();
            tokio::spawn(async move { runtime.flush_draft_before_terminal("local:s", 3).await })
        };
        let request = requests.recv().await.expect("flush request");
        assert_eq!(request.source, "local:s");
        assert!(!waiting.is_finished(), "terminal must wait for commit");
        request.reply.send(Ok(())).unwrap();
        waiting.await.unwrap().unwrap();
    }

    /// #99（评审 E2 回归锁）：冷挂载快照的真实 wire 形状——本测试钉住
    /// `turn.phase` / `turn.terminal.cause` / `sequence.lastIngressSeq` /
    /// `replayLoading` 的字段名，前端消费按此对接（防止文档与 payload 漂移）。
    #[tokio::test]
    async fn cold_mount_turn_snapshot_exposes_settled_turn_and_cursor() {
        let runtime = AgentRuntime::new_disconnected();
        let key = crate::acp::TurnKey {
            local_session_id: "local:c1".to_string(),
            remote_session_id: "peri-c1".to_string(),
            generation: 3,
            turn_id: 5,
        };
        runtime.turn_ledger.begin(key.clone(), 10);
        assert_eq!(
            runtime.turn_ledger.settle(
                &key,
                crate::acp::TurnTerminalCause::FirstTokenTimeout,
                20,
                Some("timeout detail".to_string()),
            ),
            crate::acp::SettleOutcome::Published
        );
        runtime.sessions.lock().unwrap().insert(
            "local:c1".to_string(),
            crate::session::SessionInfo::new(
                "peri-c1".to_string(),
                String::new(),
                "cwd".to_string(),
                true,
                3,
            ),
        );
        let (snapshot, _) = runtime
            .cold_mount_facts("local:c1")
            .await
            .expect("session mapping exists");
        assert_eq!(snapshot["periId"], serde_json::json!("peri-c1"));
        assert_eq!(snapshot["generation"], serde_json::json!(3));
        assert_eq!(snapshot["replayLoading"], serde_json::json!(false));
        assert_eq!(snapshot["sequence"]["lastIngressSeq"], serde_json::json!(0));
        assert_eq!(snapshot["turn"]["phase"], serde_json::json!("terminal"));
        assert_eq!(
            snapshot["turn"]["terminal"]["cause"],
            serde_json::json!("firstTokenTimeout")
        );
        assert_eq!(
            snapshot["turn"]["terminal"]["detail"],
            serde_json::json!("timeout detail")
        );
        assert_eq!(snapshot["turn"]["key"]["turnId"], serde_json::json!(5));
        assert_eq!(snapshot["lastError"], serde_json::Value::Null);
    }

    /// #420/ADR-0034：在途回合（账本单源）经快照暴露的三态契约——
    /// 在途 turn ⇒ `turnInFlight=true`（anomaly=false）；终态 ⇒ false；
    /// 非当前代际的在途残留 ⇒ anomaly=true + 诊断计数递增。
    /// 本测试钉住 `turnInFlight` / `turnInFlightAnomaly` / `turnInFlightAnomalies`
    /// 字段名，前端消费按此对接。
    #[tokio::test]
    async fn cold_mount_turn_snapshot_exposes_in_flight_mark_lifecycle() {
        let runtime = AgentRuntime::new_disconnected();
        runtime.sessions.lock().unwrap().insert(
            "local:c2".to_string(),
            crate::session::SessionInfo::new(
                "peri-c2".to_string(),
                String::new(),
                "cwd".to_string(),
                true,
                5,
            ),
        );
        let key = crate::acp::TurnKey {
            local_session_id: "local:c2".to_string(),
            remote_session_id: "peri-c2".to_string(),
            generation: 5,
            turn_id: 9,
        };

        // ① 在途：账本 begin 即单源事实，无 anomaly。
        runtime.turn_ledger.begin(key.clone(), 10);
        let (snapshot, _) = runtime
            .cold_mount_facts("local:c2")
            .await
            .expect("session mapping exists");
        assert_eq!(snapshot["turnInFlight"], serde_json::json!(true));
        assert_eq!(snapshot["turnInFlightAnomaly"], serde_json::json!(false));
        assert_eq!(snapshot["turnInFlightAnomalies"], serde_json::json!(0));
        assert_eq!(snapshot["turn"]["phase"], serde_json::json!("prompting"));

        // ② 终态：settle 收敛在途（单源，无第二标记需要同步）。
        assert_eq!(
            runtime
                .turn_ledger
                .settle(&key, crate::acp::TurnTerminalCause::Completed, 20, None,),
            crate::acp::SettleOutcome::Published
        );
        let (snapshot, _) = runtime
            .cold_mount_facts("local:c2")
            .await
            .expect("session mapping exists");
        assert_eq!(snapshot["turnInFlight"], serde_json::json!(false));
        assert_eq!(snapshot["turnInFlightAnomaly"], serde_json::json!(false));
        assert_eq!(snapshot["turnInFlightAnomalies"], serde_json::json!(0));

        // ③ 残留（模拟 drop_generation 漏清：旧代际在途绕过清理存活）
        //    ⇒ anomaly 读数显形 + 计数。
        let stale_key = crate::acp::TurnKey {
            local_session_id: "local:c2".to_string(),
            remote_session_id: "peri-c2".to_string(),
            generation: 4,
            turn_id: 3,
        };
        runtime.turn_ledger.begin(stale_key, 5);
        let (snapshot, _) = runtime
            .cold_mount_facts("local:c2")
            .await
            .expect("session mapping exists");
        assert_eq!(snapshot["turnInFlight"], serde_json::json!(false));
        assert_eq!(snapshot["turnInFlightAnomaly"], serde_json::json!(true));
        assert_eq!(snapshot["turnInFlightAnomalies"], serde_json::json!(1));
        // 连续查询累计计数单调。
        let _ = runtime.cold_mount_facts("local:c2").await;
        assert_eq!(
            runtime.turn_in_flight_anomalies.load(Ordering::Acquire),
            2,
            "每次残留命中查询都必须累加诊断计数"
        );
    }

    #[test]
    fn agent_context_key_keeps_agent_dimension() {
        let peri = AgentContextKey::new("peri", "local:shared");
        let hermes = AgentContextKey::new("hermes", "local:shared");
        assert_ne!(peri, hermes, "同名 source 必须按 agentId 隔离");
        assert_eq!(peri, AgentContextKey::new("peri", "local:shared"));
    }

    #[test]
    fn manager_insert_get_and_isolate_runtimes() {
        let manager = AgentRuntimeManager::new();
        assert!(manager.get("peri").is_none());
        let a = AgentRuntime::new_disconnected();
        let b = AgentRuntime::new_disconnected();
        manager.insert("peri".into(), a.clone());
        manager.insert("hermes".into(), b.clone());
        assert!(Arc::ptr_eq(&manager.get("peri").unwrap(), &a));
        assert!(Arc::ptr_eq(&manager.get("hermes").unwrap(), &b));
        assert!(manager.get("unknown").is_none());
    }

    #[test]
    fn runtime_fields_are_independent_per_agent() {
        let a = AgentRuntime::new_disconnected();
        let b = AgentRuntime::new_disconnected();
        a.client_generation
            .store(7, std::sync::atomic::Ordering::Release);
        assert_eq!(
            a.client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            7
        );
        assert_eq!(
            b.client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            0
        );
    }

    #[test]
    fn host_tools_policy_dual_gates_follow_yaml_and_env_fallback() {
        let runtime = AgentRuntime::new_disconnected();
        // 未连接初值 = 双门全关（连接时由 YAML/env 解析覆盖）。
        assert_eq!(
            *runtime.host_tools_policy.lock().unwrap(),
            crate::acp::host_tools::HostToolsPolicy::closed()
        );
        // #316：缺省（YAML 未声明 + env 未设）= fs Host / terminal Agent。
        let empty = std::collections::BTreeMap::new();
        runtime.set_host_tools_policy(&Default::default(), &empty);
        let policy = *runtime.host_tools_policy.lock().unwrap();
        assert!(policy.fs_hosts());
        assert!(!policy.terminal_hosts());
        // env 回退：未声明门随 env 开（host 档双开），非法值 fail-closed。
        let env = std::collections::BTreeMap::from([(
            crate::acp::host_tools::HOST_TOOLS_ENV.to_string(),
            "host".to_string(),
        )]);
        runtime.set_host_tools_policy(&Default::default(), &env);
        let policy = *runtime.host_tools_policy.lock().unwrap();
        assert!(policy.fs_hosts() && policy.terminal_hosts());
        runtime.set_host_tools_policy(
            &pylon_core::agent_config::AcpProtocolConfig {
                host_terminal: Some(pylon_core::agent_config::HostToolsMode::Agent),
                ..Default::default()
            },
            &env,
        );
        let policy = *runtime.host_tools_policy.lock().unwrap();
        assert!(policy.fs_hosts());
        assert!(
            !policy.terminal_hosts(),
            "YAML terminal 门声明压过 env host"
        );
        let invalid = std::collections::BTreeMap::from([(
            crate::acp::host_tools::HOST_TOOLS_ENV.to_string(),
            "typo".to_string(),
        )]);
        runtime.set_host_tools_policy(&Default::default(), &invalid);
        assert_eq!(
            *runtime.host_tools_policy.lock().unwrap(),
            crate::acp::host_tools::HostToolsPolicy::closed()
        );
    }

    #[test]
    fn session_creation_lock_is_independent_per_agent() {
        let a = AgentRuntime::new_disconnected();
        let b = AgentRuntime::new_disconnected();
        let guard = a.session_creation.try_lock();
        assert!(guard.is_ok(), "a 的 session_creation 应可独立获取");
        let b_guard = b.session_creation.try_lock();
        assert!(b_guard.is_ok(), "b 的 session_creation 不应被 a 的锁阻塞");
        drop(guard);
        drop(b_guard);
    }

    #[test]
    fn remove_drops_registered_runtime() {
        let manager = AgentRuntimeManager::new();
        let runtime = AgentRuntime::new_disconnected();
        manager.insert("peri".into(), runtime.clone());
        assert!(Arc::ptr_eq(&manager.remove("peri").unwrap(), &runtime));
        assert!(manager.get("peri").is_none(), "remove 后 get 必须为 None");
        assert!(
            manager.remove("peri").is_none(),
            "重复 remove 必须返回 None"
        );
    }

    #[test]
    fn get_or_create_returns_single_shared_instance() {
        let manager = AgentRuntimeManager::new();
        let first = manager.get_or_create("peri");
        let second = manager.get_or_create("peri");
        assert!(
            Arc::ptr_eq(&first, &second),
            "同一 agent 必须返回同一 runtime 实例"
        );
        assert!(
            Arc::ptr_eq(&manager.get("peri").unwrap(), &first),
            "注册表必须登记同一实例"
        );
    }

    #[test]
    fn probe_registry_reports_registered_ids_only() {
        // #250：探测会话登记后 contains 命中；未登记 id 不误伤——dispatcher 只对
        // 真探测会话静音，未知会话告警语义保持不变。
        let registry = ProbeSessionRegistry::new();
        assert!(!registry.contains("probe-a"), "空登记簿不得命中");
        registry.register("probe-a");
        registry.register("probe-b");
        assert!(registry.contains("probe-a"));
        assert!(registry.contains("probe-b"));
        assert!(!registry.contains("real-session"), "未登记 id 不得命中");
    }

    #[test]
    fn probe_registry_fifo_bound_discards_oldest() {
        let registry = ProbeSessionRegistry::new();
        for index in 0..ProbeSessionRegistry::CAPACITY as u32 {
            registry.register(&format!("probe-{index}"));
        }
        registry.register("probe-new");
        assert!(!registry.contains("probe-0"), "超容量必须丢最旧（FIFO）");
        assert!(
            registry.contains(&format!(
                "probe-{}",
                ProbeSessionRegistry::CAPACITY as u32 - 1
            )),
            "容量内最后一条必须保留"
        );
        assert!(registry.contains("probe-new"));
    }

    #[test]
    fn probe_registry_expires_entries_after_ttl() {
        let registry = ProbeSessionRegistry::new();
        registry.register("probe-stale");
        // 把登记时刻回拨到 TTL 之外（Instant 不可直接构造过去值，经 checked_sub
        // 得到）；contains 查询时顺带剪枝，命中必须转否。
        let expired = std::time::Instant::now()
            .checked_sub(ProbeSessionRegistry::TTL + std::time::Duration::from_secs(1))
            .expect("测试环境必须支持 Instant 回拨");
        {
            let mut entries = registry.entries.lock().unwrap();
            for (_, at) in entries.iter_mut() {
                *at = expired;
            }
        }
        assert!(!registry.contains("probe-stale"), "TTL 外条目必须失效");
        {
            let entries = registry.entries.lock().unwrap();
            assert!(entries.is_empty(), "查询必须顺带剪枝过期项");
        }
    }
}
