/// #208 ④：全局分配器（mimalloc）。Rust 侧的热路径以「逐行 payload 解码 / 归一化 / 短命小对象」
/// 为主，系统分配器在这类形态上开销明显；换用 mimalloc 的收益必须由基准实测支持，
/// 未达阈值即回退（记录见 `.agents/records/`）。
#[global_allocator]
static PYLON_GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

// #245：家族成员归入专业子目录（browser/gateway/hermes/mcp/pet/prism/
// workspaces/agent/session/runtime_log），cmds 与兄弟测试模块随宿主目录；
// 根目录只留单一横切职责的单文件。原 `crate::X` 路径经纯机械重写，
// 行为零变更（issue #245）。
mod acp;
pub use pylon_core::agent_catalog;
pub mod agent;
mod agent_config;
pub mod browser;
// #247：correlation/hermes/provider_adapter 归位 pylon-core，路径经重导出保活。
pub(crate) use pylon_core::correlation;
mod cwd;
mod dispatcher;
mod docs_sheet;
mod error;
mod export;
mod external_history;
mod gateway;
pub(crate) use pylon_core::hermes;
mod commands;
/// P55：kernel hook 桥（Rust 锚点 → 前端 dispatcher 应答回路）。
pub mod hook_bridge;
/// #423：审批线三 store（queue + 权限 store + 私有交互 store）单一登记面。
mod interaction_ledger;
mod lifecycle;
/// #362：崩溃取证的落盘日志链（每日轮转 + 每日预算 + 同步 panic hook）。
/// 对 crate 内可见即可；`is_self_target` 供 `runtime_log` 的自反馈隔离复用。
pub(crate) mod logging;
mod mcp;
mod paths;
mod permission;
mod pet;
mod plugin_cmds;
mod plugin_process;
mod prism;
mod private_interaction;
mod protocol_adapter;
pub use pylon_core::provider_adapter;
pub mod pylon_cli;
mod runtime;
mod runtime_log;
mod session;
mod startup;
mod startup_timing;
// P5（#106）：harness 即门面——tests/ 集成目标经此消费产品表面；
// AppState 等内部类型不加 pub，门面只出窄值（spec P5 五类面）。
// cfg(test) 使既有 lib 内嵌测试不受 feature 影响；feature 使外部 test target 可见。
#[cfg(any(test, feature = "test-agent"))]
#[doc(hidden)]
pub mod test_harness;
#[cfg(any(test, feature = "test-agent"))]
#[doc(hidden)]
pub mod test_utils;
mod workspaces;

// P58 阶段一拆分：event_names/sanitize/time/workspace/git 迁入 pylon-foundations
// crate（纯逻辑：零 tauri / 零 AppState，只依赖第三方）。模块级重导出让既有
// `crate::time::` 等路径继续解析，调用点零改动；pub(crate) 使库外暴露面与
// 拆分前的私有 mod 一致。依赖方向铁律：foundations 不得引用回本 crate。
pub(crate) use pylon_foundations::{event_names, git, sanitize, time, workspace};

use acp::AcpClient;
use agent::runtime::AgentLifecycleStatus;
use agent_config::AgentDef;
use gateway::GatewayCore;
use prism::PrismClient;
use pylon_foundations::await_guard::HeldAcrossAwait;
use runtime::{AgentRuntime, AgentRuntimeManager};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime};

#[cfg(test)]
use crate::time::Timestamp;

#[cfg(test)]
use agent::runtime::AgentRuntimeState;
#[cfg(test)]
use session::SessionInfo;

// R1 拆分：子模块函数桥接。生产代码（setup/watcher/replace）裸引用；
// 测试模块经 `use super::*` 引入命令/工具函数（R5a：清理 R1 遗留的冗余
// cfg(test) 显式导入——测试模块实际引用集中在下列被保留的名字上）。
use crate::dispatcher::start_notification_dispatcher;
use crate::lifecycle::load_mcp_persisted;
use crate::permission::sweep_interaction_timeouts;
use crate::pet::cmds::persist_pet_if_possible;
use crate::session::{check_session_expiry, send_prompt_core};

#[cfg(test)]
use crate::export::{is_export_sensitive_key, sanitize_export_messages, write_export_atomically};
#[cfg(test)]
use crate::lifecycle::set_mcp_servers;
#[cfg(test)]
use crate::permission::{
    parse_permission_request, permission_response, permission_response_cancelled,
    resolve_permission,
};
#[cfg(test)]
use crate::session::{
    build_full_inspector_payload, config_option_current_value, session_expired,
    InspectorSessionRow, SessionListRow,
};

fn emit_event<R, W>(window: &W, event: &str, payload: serde_json::Value)
where
    R: Runtime,
    W: Emitter<R>,
{
    if let Err(error) = window.emit(event, payload) {
        tracing::warn!("emit {event} failed: {error}");
    }
}

/// 事件广播（B10.1）：WebView 始终接收；平台 source 同时经 gateway 投递平台适配器。
/// pylon:user 回显/agent-status/runtime-log 不投平台（仅 update/done/error）。
pub(crate) fn emit_event_all<R, W>(
    window: &W,
    gateway: &GatewayCore,
    source: &str,
    event: &str,
    payload: serde_json::Value,
) where
    R: Runtime,
    W: Emitter<R>,
{
    // 平台源判定前置：deliver_all 需要 &payload，emit 也消费 payload——平台源
    // 才 clone 给 emit，GUI 源直接 move 给 emit 且跳过 deliver_all（其内部对
    // GUI source 本就早退）。is_platform_source 为一次读锁 + 前缀查。
    if gateway.is_platform_source(source) {
        gateway.deliver_all(source, event, &payload);
        emit_event(window, event, payload);
    } else {
        emit_event(window, event, payload);
    }
}

/// #488 批①：AppState / AppStateHandles 单源字段表。此前两份清单（两个结构体
/// 定义 × `from_state` 拷贝清单）人肉同步，字段增删要三处一致且无机械保障；改为
/// 同一张表生成两个结构体与 `from_state`——共享字段增删只改这张表，漏改任何一侧
/// 即编译错误，「Handles 是 AppState 的字段子集」成为结构事实而非约定。
macro_rules! declare_app_state {
    (
        shared { $( $(#[$shared_meta:meta])* $shared_field:ident : $shared_ty:ty ),* $(,)? }
        app_only { $( $(#[$app_meta:meta])* $app_field:ident : $app_ty:ty ),* $(,)? }
    ) => {
        /// AppState：全局状态 = 全局配置 + per-agent 隔离运行时（B7a-2）+ gateway（B10.1）。
        /// per-agent 字段（acp/notification_task/session_creation/agent_lifecycle/
        /// client_generation/prompt_locks/sessions/agent_runtime/auto_reconnect_active）
        /// 全部收进 AgentRuntimeManager（runtime.rs），命令层按 active_agent 解析 runtime。
        /// R1 拆分：字段 pub(crate) 供子模块（session/dispatcher/lifecycle 等）访问。
        pub(crate) struct AppState {
            $( $(#[$shared_meta])* pub(crate) $shared_field: $shared_ty, )*
            $( $(#[$app_meta])* pub(crate) $app_field: $app_ty, )*
        }

        /// 供 async 闭包/静态辅助持有的 AppState 字段子集。
        /// Tauri manage 的 state 不能 move 进闭包，只能 clone 字段；
        /// start_notification_dispatcher / do_connect_and_replace / 自动重连共用。
        /// per-agent 状态经 [`Self::active_runtime`] / 参数传入的 runtime 访问。
        /// R1 拆分：字段 pub(crate)（dispatcher/lifecycle 子模块访问）。
        /// #488 批①：字段集与 AppState 同表生成（见 `declare_app_state`），子集关系
        /// 编译期互钉；`from_state` 一并生成，新增共享字段不可能漏拷贝。
        pub(crate) struct AppStateHandles {
            $( $(#[$shared_meta])* pub(crate) $shared_field: $shared_ty, )*
        }

        impl AppStateHandles {
            fn from_state(state: &AppState) -> Self {
                Self {
                    $( $shared_field: state.$shared_field.clone(), )*
                }
            }
        }
    };
}

declare_app_state! {
    shared {
        runtimes: Arc<AgentRuntimeManager>,
        agents: Arc<Mutex<HashMap<String, AgentDef>>>,
        active_agent: Arc<Mutex<String>>,
        pet: Arc<Mutex<pet::PetState>>,
        runtime_logs: Arc<runtime_log::RuntimeLogHub>,
        gateway: Arc<GatewayCore>,
        /// 权限审批模式（B9.3）：bypass/auto 自动批准；edit/default 挂起询问。
        approval_mode: Arc<Mutex<String>>,
        /// #463 审查项 3：approval-mode 落盘健康位——内存当前值是否已被 SQLite 持有
        /// （或从未偏离持久层）。set 落盘成功 / 启动回填成功 / 无持久值（默认即权威）
        /// → true；set 落盘失败 / 回填失败 / service 未就绪 → false。经 set/get 的
        /// ApprovalModeSnapshot.persisted 暴露给 CLI 消费方（degraded 外部可查）。
        approval_mode_persisted: Arc<std::sync::atomic::AtomicBool>,
        /// M3 EVT-02：canonical 事件仓库 service（与消息同库 canonical_events 表 v6，
        /// 方案书 §5.10 append-only 事件流）。与 message/user-data 作为同一 readiness
        /// unit 串行打开；生产 setup 返回后必为 Some。dispatcher 对有 durable owner 的
        /// 事件必须先 append 再发布（Option 仅保留测试构造兼容与防御性诊断）。
        event_service: Arc<Mutex<Option<Arc<crate::session::EventService>>>>,
        /// I14-W1：消息仓库 service（SQLite，app_data_dir/pylon-data-v1.sqlite3）。
        /// ACP session-level snapshots (commands/mode) share the message DB and
        /// are persisted when providers update them asynchronously. setup() readiness
        /// barrier 内创建目录 → open/migrate → 填入本槽；生产 setup 返回后必为
        /// Some，任一 service 失败会阻止半可用 Kernel 启动。None 仅用于构造期/测试，
        /// 命令层仍防御性返回 message_db_unavailable。
        message_service: Arc<Mutex<Option<Arc<crate::session::MessageService>>>>,
        /// P55：kernel hook 桥（pending oneshot 挂表 + ready 握手 + registry 闸）。
        hook_bridge: Arc<crate::hook_bridge::HookBridge>,
    }
    app_only {
        runtime_mcp: Mutex<Option<Vec<mcp::McpServerConfig>>>,
        /// issue #82：Agent 浏览器能力 hub（设置/claim/ref/CDP 状态）。
        browser_agent: Arc<crate::browser::agent::hub::BrowserAgentHub>,
        prism: PrismClient,
        /// R5（P1-3）：启动诊断快照（run() 构建主体；#482 起 storage 模式诊断已随
        /// AppData 双模式退役，快照只含配置来源与分域错误）。
        startup: Arc<RwLock<crate::startup::StartupDiagnostics>>,
        /// #463：approval-mode 写序锁（tokio Mutex）——set_approval_mode 的内存写与
        /// user_data 落盘全程持锁，并发 set（GUI 与 CLI 桥同进程）时磁盘必为最后一次
        /// set（重启不回退到较早值；与 mcp_write_lock 同型。最后一次 set 落盘失败除外
        /// ——降级路径见 set_approval_mode docstring，健康位经
        /// approval_mode_persisted 对外可查，#463 审查项 3 已落地）。
        approval_mode_write_lock: tokio::sync::Mutex<()>,
        /// R6a：宠物落盘写序锁（tokio Mutex）——序列化在临界区内执行，保证
        /// 后写状态 ≥ 先写状态（无乱序覆盖）；fs 写经 spawn_blocking 移出 async 运行时。
        pet_write_lock: tokio::sync::Mutex<()>,
        /// C7：switch/reconnect 串行锁——并发 switch 不交叉杀进程（一个 switch
        /// 未完成前另一个 switch 不得 kill 同一批旧进程）。
        switch_lock: tokio::sync::Mutex<()>,
        /// C8：MCP 写序锁（tokio Mutex）——set_mcp_servers 写 runtime_mcp + 落盘
        /// 全程持锁，并发设置时磁盘必为最后一次设置（重启不回滚到旧配置）。
        mcp_write_lock: tokio::sync::Mutex<()>,
        /// Phase 3：配置写序锁（tokio Mutex）——update_agents_config 读当前→生成候选→
        /// 校验→写盘→内存提交全程持锁，两个写请求不基于同一旧版本互相覆盖。
        config_write_lock: tokio::sync::Mutex<()>,
        /// Phase 4：浏览器会话管理（WebView 方案 §6.0；setup() 注入主窗口）。
        browser: Arc<browser::BrowserManager>,
        /// #371：文档 Sheet 管理（离线文档站子 WebView；setup() 注入主窗口）。
        docs_sheet: Arc<docs_sheet::DocsSheetManager>,
        /// P1（E10）：MCP wire 序列化缓存（Vec<Value>，session/new 的 mcpServers 载荷）。
        /// 每消息省一次全量 validate+serialize（≤32 server × 字段校验 + 一次 clone）。
        /// 写入 = set_mcp_servers 与 runtime_mcp 同 mcp_write_lock 下同步；读取
        /// （send_prompt_core None 路径）miss 时回退全量重算并回填（E3 自愈：启动
        /// 恢复路径直写 runtime_mcp 不经 set_mcp_servers，缓存为 None，首次读取即回填）。
        mcp_wire: Mutex<Option<Vec<serde_json::Value>>>,
        /// R8（P2-3）：前端日志限流窗口（每秒上限，超限丢弃）。
        frontend_log_throttle: Mutex<runtime_log::FrontendLogThrottle>,
        /// I14-W5：用户数据仓库 service（与消息同库 user_data 表，versioned
        /// Profile/Session/activeProfileId）。与 message/event 作为同一 readiness
        /// unit 串行打开；生产 setup 返回后必为 Some。
        user_data_service: Arc<Mutex<Option<Arc<crate::session::UserDataService>>>>,
        /// I12-W4：gateway 实例 registry 与状态机（W1 已建；setup 加载持久化配置、
        /// 注册 factory 与 route guard）。
        gateway_instances: crate::gateway::instance::GatewayInstanceService,
        /// I12-W4：实例配置持久化路径（app_data_dir/pylon-gateway-instances.json）；
        /// None（测试）→ 管理命令跳过持久化（内存态仍生效）。
        gateway_instance_store_path: Arc<Mutex<Option<std::path::PathBuf>>>,
        /// I12-W5：加密凭据存储（W3 已建；setup 打开，set_credentials 命令与 start 解析用）。
        /// None = 打开失败（blocked，命令报 credential_store_error）。
        gateway_credentials:
            Arc<Mutex<Option<Arc<crate::gateway::credentials::CredentialStore>>>>,
        /// CWD-03：Workspace 实体注册表（id → Workspace；跨 Agent 共享，owner 仅溯源）。
        workspaces: Arc<Mutex<HashMap<String, crate::workspaces::Workspace>>>,
        /// 施工文档 §2.3：本次启动的数据/配置目录（setup() 最前面解析一次）。
        /// 所有 SQLite/插件/MCP/gateway/pet 路径消费者必须经 `data_dirs()` 读取，
        /// 禁止在运行期重复 `resolve_data_dirs()`。
        data_dirs: Arc<OnceLock<crate::paths::DataDirs>>,
        /// Phase 8: plugin-owned subprocesses and JSON-RPC pending requests.
        plugin_processes: Arc<crate::plugin_process::PluginProcessSupervisor>,
        /// Stage 10: current-user local IPC bridge into the live Web Kernel.
        pylon_cli: Arc<crate::pylon_cli::PylonCliBridge>,
        /// #422：连接测试凭证登记（B1 保存门禁后端化）——test_agent_candidate
        /// 成功握手记录 (agent_id, launch 指纹)；update_agents_config 保存
        /// launch 指纹变更的候选前查表（无凭证 fail-closed 拒绝）。
        verified_agent_fingerprints: Arc<lifecycle::verification::VerificationVouchers>,
    }
}

impl AppState {
    /// 读取本次启动解析一次的数据目录（未初始化 = 启动时序缺陷，显式报错）。
    pub(crate) fn data_dirs(&self) -> Result<&crate::paths::DataDirs, String> {
        self.data_dirs
            .get()
            .ok_or_else(|| "data dirs not initialized".to_string())
    }

    /// DataDirs 克隆（路径消费者需要 owned 值跨 spawn_blocking/async 闭包时）。
    pub(crate) fn data_dirs_cloned(&self) -> Result<crate::paths::DataDirs, String> {
        self.data_dirs().cloned()
    }
}

/// acp 意外崩溃判定（P2-3 语义：try_read 失败视为未崩溃，读路径不等待换装写锁）。
/// #163：主动 stop（kill）不算崩溃——`is_crashed` 已区分「主动停」与「意外退出」，
/// 本函数只用于把意外崩溃写入状态；连接可用性判定请用 `AcpClient::is_dead`。
/// 收敛 detect_and_record_crashes 与 agent_status_payload 的双写点（G3 §2.2.4）。
fn acp_is_crashed(runtime: Option<&AgentRuntime>) -> bool {
    runtime
        .map(|runtime| {
            runtime
                .acp
                .try_read()
                .ok()
                .map(|acp| acp.is_crashed())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// P3-12 后处理（纯函数）：只在 payload 未报告崩溃时覆盖——payload 内
/// status/crashed 必须一致；lastError/recentError/error 三别名同步覆写。
/// 逻辑保留自 emit_agent_status（行为契约：announce 的状态/错误必定上事件）。
fn apply_announce_override(
    payload: &mut serde_json::Value,
    status: AgentLifecycleStatus,
    last_error: Option<String>,
) {
    if let serde_json::Value::Object(ref mut map) = payload {
        let payload_crashed = map.get("status").and_then(|value| value.as_str())
            == Some(AgentLifecycleStatus::Crashed.as_str());
        if !payload_crashed {
            map.insert(
                "status".to_string(),
                serde_json::Value::String(status.as_str().to_string()),
            );
            if let Some(error) = last_error {
                let error = serde_json::Value::String(error);
                map.insert("lastError".to_string(), error.clone());
                map.insert("recentError".to_string(), error.clone());
                map.insert("error".to_string(), error);
            }
        }
    }
}

impl AppStateHandles {
    /// 当前 active agent 的 runtime（无 active agent 时返回 None）。
    fn active_runtime(&self) -> Option<Arc<AgentRuntime>> {
        let id = self.active_agent.lock().ok()?.clone();
        self.runtimes.get(&id)
    }

    fn log_runtime_summary(
        &self,
        level: &str,
        source: &str,
        session: Option<String>,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        self.runtime_logs.push(
            crate::time::Timestamp::now(),
            level,
            source,
            session,
            message,
            fields,
        );
    }

    fn set_agent_runtime_status(
        &self,
        runtime: &AgentRuntime,
        status: AgentLifecycleStatus,
        last_error: Option<String>,
    ) {
        if let Ok(mut runtime) = runtime.agent_runtime.lock() {
            runtime.status = status;
            runtime.last_error = last_error;
            if status == AgentLifecycleStatus::Connected {
                runtime.last_connected_at = Some(crate::time::Timestamp::now());
            }
        }
    }

    /// 崩溃检测 + 记录（P2-3）：只做"acp 已死 → status=Crashed + 注入 last_error"的
    /// 记录性写入，必须在纯查询路径（agent_status_payload）之外显式调用——
    /// getter 不再有副作用。try_lock 失败（acp 锁正被占用）视为未崩溃（读路径不等待）。
    fn detect_and_record_crashes(runtime: Option<&AgentRuntime>) {
        let Some(runtime) = runtime else { return };
        if acp_is_crashed(Some(runtime)) {
            if let Ok(mut state) = runtime.agent_runtime.lock() {
                state.status = AgentLifecycleStatus::Crashed;
                if state.last_error.is_none() {
                    state.last_error = Some("ACP child process stdout closed".to_string());
                }
            }
        }
    }

    fn agent_status_payload(&self, runtime: Option<&AgentRuntime>) -> serde_json::Value {
        let (status, last_error, last_connected_at) = runtime
            .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.clone()))
            .map(|state| (state.status, state.last_error, state.last_connected_at))
            .unwrap_or((AgentLifecycleStatus::Disconnected, None, None));
        let active_agent_id = self
            .active_agent
            .lock()
            .ok()
            .map(|value| value.clone())
            .unwrap_or_default();
        let agent = self
            .agents
            .lock()
            .ok()
            .and_then(|agents| agents.get(&active_agent_id).cloned());
        let crashed = matches!(status, AgentLifecycleStatus::Crashed) || acp_is_crashed(runtime);
        // L7 共享判定（W4 R.6 步5，#416 W2 wave2 步骤 9）：「crashed 压过
        // Connected / available 只看有效 Connected」与 agent_summary_payload
        // 同一纯函数（lifecycle/summary.rs）；json! 构造与字段序保持本侧原样。
        let (effective_status, effective_connected) =
            crate::lifecycle::summary::effective_status_and_connected(crashed, Some(status));
        let status = effective_status.expect("输入恒为 Some——折叠不产出 None");
        let available = agent.is_some() && effective_connected;
        let generation = runtime
            .map(|runtime| runtime.client_generation.load(Ordering::Acquire))
            .unwrap_or(0);
        // P1（能力协商暴露）：agentCapabilities 原始 Value（try_lock 同步读 acp——
        // 与 acp_is_crashed 同模式；断开/未连接为 null）。前端能力驱动 UI 读此字段。
        let capabilities = runtime
            .and_then(|runtime| runtime.acp.try_read().ok())
            .and_then(|acp| acp.agent_capabilities().cloned());
        // #98：结构化能力快照（advertised/negotiated/usable 三层 + 诊断）。
        // 与 session 建立/重连探针消费同一矩阵（negotiated.rs from_parts）——
        // 前端只消费 usable，不再自行解析 raw capabilities（fail-closed 一致）。
        // W1 R.4 PR-2（#416 W2 wave2 步骤 8）：拼装经 acp/mod.rs 共享辅助；
        // generation 复用上方单次装载（原闭包内二次 Acquire 收敛为一）。
        let capability_snapshot = runtime.and_then(|runtime| {
            let acp = runtime.acp.try_read().ok()?;
            Some(crate::acp::negotiated_snapshot_from_client(&acp, generation).wire_value())
        });
        // #98：pending 交互摘要（含事件载荷全文）——前端冷挂载/刷新只凭本快照
        // + generation 即可恢复 active 卡与 queued 深度，不依赖一次性 live event。
        let pending_interactions =
            runtime.and_then(|runtime| {
                runtime.ledger.queue().snapshot().ok().map(|entries| {
                    crate::acp::interaction_queue::pending_interactions_wire(&entries)
                })
            });
        let mut session_bindings = runtime
            .and_then(|runtime| runtime.binding_health.lock().ok())
            .map(|health| {
                health
                    .iter()
                    .map(|(source, health)| health.wire_value(&active_agent_id, source))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        session_bindings.sort_by(|left, right| {
            left.get("source")
                .and_then(serde_json::Value::as_str)
                .cmp(&right.get("source").and_then(serde_json::Value::as_str))
        });
        // O2：三个别名（lastError/recentError/error）共用同一份引用（as_deref），
        // json! 序列化时各自转 Value——消除 3 次显式 clone（last_error 是
        // agent_runtime 锁内 state.clone() 的产物，自身 clone 是必须的）。
        let last_error_ref = last_error.as_deref();
        serde_json::json!({
            "agentId": active_agent_id,
            "agentName": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
            "agent": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
            "status": status.as_str(),
            "transport": agent.as_ref().map(|value| value.transport.clone()).unwrap_or_default(),
            "cwd": agent.as_ref().and_then(|value| value.cwd.clone()).unwrap_or_default(),
            "lastError": last_error_ref,
            "recentError": last_error_ref,
            "error": last_error_ref,
            "lastConnectedAt": last_connected_at,
            "generation": generation,
            "capabilities": capabilities,
            "capabilitySnapshot": capability_snapshot,
            "pendingInteractions": pending_interactions,
            "sessionBindings": session_bindings,
            "active": agent.is_some(),
            "available": available,
            "crashed": crashed,
        })
    }

    fn emit_agent_status<R: tauri::Runtime, W: tauri::Emitter<R>>(
        &self,
        runtime: &AgentRuntime,
        window: &W,
        status: AgentLifecycleStatus,
        last_error: Option<String>,
    ) {
        self.set_agent_runtime_status(runtime, status, last_error.clone());
        // P2-3：崩溃检测在状态写入之后执行——acp 已死时崩溃状态优先于本次
        // announce 的状态（避免"status=reconnecting 但 crashed=true"的自我矛盾）。
        Self::detect_and_record_crashes(Some(runtime));
        let mut payload = self.agent_status_payload(Some(runtime));
        // P3-12：announce 后处理（payload 未报告崩溃时按 announce 覆写状态/错误）
        apply_announce_override(&mut payload, status, last_error);
        emit_event(window, event_names::AGENT_STATUS, payload);
    }

    async fn replace_agent_client<R: tauri::Runtime>(
        &self,
        runtime: &Arc<AgentRuntime>,
        agent_id: Option<String>,
        new_acp: AcpClient,
        window: tauri::Window<R>,
        activation: crate::agent::runtime::ClientActivation,
    ) -> Result<Vec<crate::session::store::SessionProbeCandidate>, String> {
        if new_acp.is_crashed() {
            return Err("new ACP client crashed before activation".to_string());
        }

        // Retire the old dispatcher before touching the old client.  Aborting
        // and awaiting the task closes the consumer side of the old inbox, so
        // a kill-generated crash notification cannot schedule reconnect work
        // after this replacement has begun.  This is the task-level half of
        // the no-overlap invariant; the ACP process is synchronously killed
        // below before the replacement is published.
        let old_dispatcher = runtime
            .notification_task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(handle) = old_dispatcher {
            handle.abort();
            let _ = handle.await;
        }

        // 优化-1：keep=false（手动 switch/reconnect）映射清空后，旧 source 的 prompt
        // 锁条目必须同步收敛（O1 语义，与 remove_session_if_matches/check_session_expiry
        // 一致）——否则旧 source 条目随任意命名的 GUI source 无限累积。锁内先快照
        // 旧 source 键，映射清空后在锁外逐个清理（锁序单向：sessions → prompt_locks）。
        // 方案 8：sessions 迁移委托 SessionStore（migrate_or_clear 返回旧 source 键）。
        let (stale_sources, probe_candidates) = {
            // #549/ADR-0037：换装写锁——块内全为同步操作（激活应用/kill/赋值/
            // 代际落位），锁内无 await；检查→退役→暴露的整窗原子性由写锁承担，
            // 与旧 tokio 锁语义一致（std 写锁同样排斥全部快照读）。
            let mut acp = runtime
                .acp
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let new_generation = runtime
                .client_generation
                .load(Ordering::Acquire)
                .checked_add(1)
                .ok_or_else(|| "agent client generation exhausted".to_string())?;
            if activation.epoch.0 != new_generation {
                return Err(format!(
                    "stale client activation epoch: expected {new_generation}, got {}",
                    activation.epoch.0
                ));
            }
            let affected = crate::session::store::apply_client_activation(runtime, activation)
                .map_err(|error| error.to_string())?;
            let stale_sources =
                if activation.continuity == crate::agent::runtime::SessionContinuity::Invalidated {
                    affected
                        .iter()
                        .map(|candidate| candidate.source.clone())
                        .collect()
                } else {
                    Vec::new()
                };
            let probe_candidates =
                if activation.continuity == crate::agent::runtime::SessionContinuity::Unknown {
                    affected
                } else {
                    Vec::new()
                };
            // Retire the old process before exposing the replacement.  A plain
            // `mem::replace` followed by a later kill leaves two live ACP
            // instances during dispatcher startup and allows old stdout to
            // race into the new generation.  The disconnected placeholder
            // keeps the runtime fail-closed while the old process is drained.
            let old_acp = std::mem::replace(&mut *acp, Arc::new(AcpClient::disconnected()));
            if let Err(error) = old_acp.kill() {
                tracing::warn!("kill replaced agent before activation: {}", error);
            }
            *acp = Arc::new(new_acp);
            runtime
                .client_generation
                .store(new_generation, Ordering::Release);
            self.set_agent_runtime_status(runtime, AgentLifecycleStatus::Connected, None);
            if let Some(agent_id) = agent_id {
                if let Ok(mut active) = self.active_agent.lock() {
                    *active = agent_id;
                }
            }
            // 审查修复：客户端替换（switch/重连/自动重连）后旧进程的挂起权限请求
            // 全部失效——清空，避免 300s 超时把 reject 写到新进程（且可能撞新 id）。
            // #423：三 store 清理经 Ledger 单点（drain_disconnected）。
            // #98：断线/替换 drain——每个 waiter 拿到 Disconnected 终态（AC10），
            // 并向前端广播终态事件：permission 卡不再悬挂到 300s 超时。
            let (stale, stale_private, drained_interactions) = runtime.ledger.drain_disconnected();
            if stale > 0 {
                tracing::warn!("客户端替换：清理 {stale} 个挂起的权限请求（旧进程已失效）");
            }
            if stale_private > 0 {
                tracing::warn!("客户端替换：清理 {stale_private} 个挂起的私有交互（旧进程已失效）");
            }
            // #488 批⑤：终态事件载荷收敛到 permission::resolved_interaction_payload
            // 单一构造点（原两份手拼 json! 变体之一）。
            for entry in drained_interactions {
                let resolved = if entry.kind == "approval" {
                    crate::permission::resolved_interaction_payload(
                        crate::permission::ResolvedInteractionEvent::Permission { option_id: "" },
                        &entry.agent_id,
                        &entry.session_id,
                        &entry.request_id,
                        entry.client_generation,
                        "disconnected",
                    )
                } else {
                    crate::permission::resolved_interaction_payload(
                        crate::permission::ResolvedInteractionEvent::Interaction {
                            kind: &entry.kind,
                        },
                        &entry.agent_id,
                        &entry.session_id,
                        &entry.request_id,
                        entry.client_generation,
                        "disconnected",
                    )
                };
                emit_event(&window, crate::event_names::INTERACTION, resolved);
            }
            tracing::info!("ACP client activated; generation is now {}", new_generation);
            (stale_sources, probe_candidates)
        };
        // 优化-1：sessions 锁已释放——清理旧 source 的 prompt 锁条目。
        // G2-08：lib.rs 本地 drop_stale_prompt_locks 删除，收敛为 runtime 方法。
        runtime.drop_prompt_locks(&stale_sources);
        start_notification_dispatcher(self, runtime, window);
        Ok(probe_candidates)
    }
}

/// per-source prompt 锁表（source → 锁）。clippy 2026-08-02：复杂类型提取别名。
pub(crate) type PromptLockTable = Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>;

pub(crate) fn prompt_lock_for(
    locks: &PromptLockTable,
    source: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(source.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

// ── B11 注入钩子集成测试 ──

// ── B4.2 MCP 配置持久化测试 ──

// ── 会话过期平台判定测试（核验修复） ──

// ── B10.4 平台链路集成测试（fake QQ 事件 → ingest → 注入 → fake ACP → deliver 回发） ──

/// R18 + #362：初始化 tracing subscriber。
///
/// 三个 sink 共享一条订阅：
/// - **stderr**：`fmt` 层，INFO 上限（行为不变）。
/// - **落盘文件**（#362）：每日轮转 `<data_root>/logs/pylon.<date>.log`、保留 30 个、
///   每日 512 MiB 上限且**从当日既有文件尺寸续算**；debug 构建下这是多余的一份，
///   但 release 是 GUI 子系统（#361）——stderr 不可见，落盘是唯一活口。
/// - **RuntimeLogLayer**：tracing event → RuntimeLogHub（level/source/message/fields 形状不变）。
///
/// 另外安装 panic hook（同步写盘），见 [`logging::panic_hook`]。
///
/// 返回值必须由调用方（`main()`）绑定到进程生命周期：`WorkerGuard` 一 drop，
/// non_blocking 的 worker 线程就收摊，缓冲里的尾巴会丢。`main.rs` 里写成
/// `let _log_guard = ...`。
///
/// hub 由 `run()` 创建后经 `register_hub` 注册，Layer 按事件惰性读取，注册前的
/// event 直接丢弃（此前 log 宏本就无 sink）。
pub fn init_tracing() -> LogGuard {
    let file_sink = crate::paths::resolve_log_root().and_then(|root| {
        logging::file_sink::build_file_sink(logging::file_sink::LogFileSpec::new(root))
    });
    let (subscriber, worker) = build_subscriber(runtime_log::RuntimeLogLayer::new(), file_sink);
    // `set_global_default` 失败（例如同一进程里已装过 subscriber）不致命：日志链降级，
    // 应用照常启动。
    let _ = tracing::subscriber::set_global_default(subscriber);
    logging::panic_hook::install();
    LogGuard { _worker: worker }
}

/// #383：构造三个 sink 的 subscriber——**基底必须是 `Registry`**。
///
/// 曾经的写法把带 `.with_filter(...)` 的落盘层挂到 `fmt::Subscriber` 上
/// （`file_layer.with_subscriber(base)`）。`tracing-subscriber` 给 `fmt::Subscriber`
/// 实现的 `LookupSpan::register_filter` 是**默认实现、直接 panic**
/// （`registry/mod.rs`：`"{type} does not currently support filters"`），于是这条分支
/// 一被走到进程就启动即崩——触发条件只是「日志根可写」（事发时 portable 与 AppData
/// 两条路都满足，#482 起仅剩 portable 一条），**与 debug/release 无关**，于是从源码
/// 构建的发行包 100% 起不来。`Registry` 支持 per-layer filtering，三个 sink 平铺挂上去
/// 即可（各层的级别/目标过滤语义不变）。
///
/// 抽成独立函数是为了能被测试直接驱动：`set_global_default` 每进程只成功一次，而
/// 「构造这条订阅栈不 panic」正是 #383 的回归点。
fn build_subscriber(
    hub_layer: runtime_log::RuntimeLogLayer,
    file_sink: Option<(
        tracing_appender::non_blocking::NonBlocking,
        tracing_appender::non_blocking::WorkerGuard,
    )>,
) -> (
    Box<dyn tracing::Subscriber + Send + Sync>,
    Option<tracing_appender::non_blocking::WorkerGuard>,
) {
    use tracing_subscriber::layer::{Layer, SubscriberExt};

    // #383 的一处**已知语义差异**（评审实测，接受）：修前 stderr 是 `fmt::Subscriber` 自带的
    // 订阅者级 `LevelFilter::INFO`，全局 max level hint = INFO；换 registry 后各层各自过滤，
    // 全局 hint 落到 TRACE（`LevelFilter::current()` 实测 TRACE）。**可记录的可见输出不变**
    // （hub 层内部仍有 `level > INFO` 守卫、落盘层有 INFO 过滤、stderr 层也有），差别只是
    // debug!/trace! 调用不再被全局短路、每次多一次 enabled 走查（全仓 20 处、均在罕见错误分支）。
    // 若将来要把 hint 收紧回 INFO，在 registry 上再加一层 `LevelFilter::INFO` 即可。
    let base = tracing_subscriber::registry().with(hub_layer).with(
        tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_filter(tracing_subscriber::filter::LevelFilter::INFO),
    );
    match file_sink {
        Some((writer, worker_guard)) => {
            // 文件 sink 也限 INFO：debug/trace 只留在 stderr，不写盘也不冲 ring。
            // panic 记录由 hook 同步写过同一个文件（且带完整 backtrace），这里按
            // target 等值去重，避免每个 panic 在文件里出现两遍。
            let file_layer = tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer)
                .with_filter(tracing_subscriber::filter::filter_fn(|metadata| {
                    metadata.target() != logging::PANIC_TARGET
                }))
                .with_filter(tracing_subscriber::filter::LevelFilter::INFO);
            (Box::new(base.with(file_layer)), Some(worker_guard))
        }
        None => (Box::new(base), None),
    }
}

/// #362：落盘 sink 的存活守卫。
///
/// 只有绑定到进程生命周期才有意义（drop = 关闭 worker 线程并 flush），所以带
/// `#[must_use]`：漏绑会静默丢掉每一次缓冲未刷的日志，不会有编译错误提醒。
#[must_use = "绑定到进程生命周期（main 里 let _log_guard = ...），drop 会关掉落盘 worker"]
pub struct LogGuard {
    _worker: Option<tracing_appender::non_blocking::WorkerGuard>,
}

/// #269：进程侧启动相位打点（main.rs 在 t0 处调用；供 lib 外的入口 facade 使用）。
pub fn startup_mark(phase: &str) {
    crate::startup_timing::mark(phase);
}

/// 会话过期判定（B10.3b，参考 Hermes reset policy）：返回过期原因，None = 未过期。
///
/// - reset="off"：永不过期
/// - reset="daily"：按 UTC 日历天比较（updated_at 与 now 不同天 → 过期）
/// - 其他（默认 idle）：`now - updated_at > idle_minutes` → 过期
///   updated_at 缺失（历史数据）视为未过期（保守，防误杀）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
// P3a（#106）：进程级一次性注册提取（rustls provider + peri/hermes 协议适配器 +
// #98 能力消费者）。全部幂等——生产 run() 与测试装配走同一入口，消灭
// test_state_with_acp 对 run() 的手工镜像。
pub(crate) fn install_process_registrations() {
    // rustls 0.23 进程级 CryptoProvider：依赖树经 feature 统一同时启用
    // aws-lc-rs 与 ring（reqwest/hyper-rustls 与 tokio-tungstenite 各拉其一），
    // 自动探测必然失败——gateway QQ WSS 首次 TLS 握手即 panic（P78 真实平台
    // 验收暴露；stub 测试不走 TLS 故未覆盖）。启动最早期显式安装默认 provider。
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    // P0-3（R2-WI03）+ R2-WI06：注册协议适配器——Peri 与 Hermes 的审批 wire 逐字段
    // 一致（均走 ACP session/request_permission + RequestPermissionResponse，已源码实证），
    // 同一 request_permission 实现按 provider 注册；clarify/ask-user 无真实 wire 不注册。
    // #424：method 表 per-provider 槽保留这组双注册事实（诊断位据此投影为真值）。
    protocol_adapter::register_protocol_adapter(std::sync::Arc::new(
        protocol_adapter::RequestPermissionAdapter { provider: "peri" },
    ));
    protocol_adapter::register_protocol_adapter(std::sync::Arc::new(
        protocol_adapter::RequestPermissionAdapter { provider: "hermes" },
    ));
    // #98：能力消费者注册表——「声明—协商—消费者」矩阵第三列。只有注册了
    // 消费者的能力才会被协商快照投影为 usable（IPC/UI 可点击 gate）；fork 与
    // elicitation 的消费者在本切片落地（session/fork.rs / elicitation 桥）。
    use crate::acp::CapabilityConsumer as CC;
    for consumer in [
        CC::SessionEstablishment,
        CC::SessionClose,
        CC::SessionDelete,
        CC::SessionList,
        CC::SessionFork,
        CC::Elicitation,
        CC::PromptImage,
        CC::McpHttp,
        CC::McpSse,
    ] {
        crate::acp::negotiated::register_capability_consumer(consumer);
    }
}

/// P3a（#106）：config→AppState 组装的输入部件（run() 与 TestStateBuilder 同源）。
pub(crate) struct AppStateParts {
    pub(crate) runtimes: Arc<AgentRuntimeManager>,
    pub(crate) agents: HashMap<String, AgentDef>,
    pub(crate) active_agent: String,
    pub(crate) runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    pub(crate) prism: PrismClient,
    pub(crate) gateway: Arc<GatewayCore>,
    pub(crate) startup: crate::startup::StartupDiagnostics,
}

/// P3a（#106）：AppState 单一构造点——run() 生产装配与 TestStateBuilder 测试
/// 默认值同源；AppState 增字段时编译失败点仅此一处（E18 人肉同步纪律退役）。
pub(crate) fn build_app_state(parts: AppStateParts) -> AppState {
    let AppStateParts {
        runtimes,
        agents,
        active_agent,
        runtime_logs,
        prism,
        gateway,
        startup,
    } = parts;
    AppState {
        runtimes,
        agents: Arc::new(Mutex::new(agents)),
        active_agent: Arc::new(Mutex::new(active_agent)),
        pet: Arc::new(Mutex::new(pet::PetState::default())),
        runtime_logs,
        runtime_mcp: Mutex::new(None),
        prism,
        gateway,
        startup: Arc::new(RwLock::new(startup)),
        approval_mode: Arc::new(Mutex::new("default".to_string())),
        approval_mode_persisted: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        approval_mode_write_lock: tokio::sync::Mutex::new(()),
        browser_agent: Arc::new(crate::browser::agent::hub::BrowserAgentHub::new()),
        pet_write_lock: tokio::sync::Mutex::new(()),
        switch_lock: tokio::sync::Mutex::new(()),
        mcp_write_lock: tokio::sync::Mutex::new(()),
        config_write_lock: tokio::sync::Mutex::new(()),
        browser: Arc::new(browser::BrowserManager::new()),
        docs_sheet: Arc::new(docs_sheet::DocsSheetManager::new()),
        // P1（E10）：wire 缓存初始 None——启动恢复路径（setup load_mcp_persisted
        // 直写 runtime_mcp）后首次读取 miss 回退全量重算并回填（E3 自愈）。
        mcp_wire: Mutex::new(None),
        frontend_log_throttle: Mutex::new(runtime_log::FrontendLogThrottle::default()),
        // I14-W1：消息仓库槽位初始 None，setup() 启动时序填充（见 struct 注释）。
        message_service: Arc::new(Mutex::new(None)),
        // I14-W5：用户数据仓库槽位初始 None，setup() 启动时序填充（与消息同库）。
        user_data_service: Arc::new(Mutex::new(None)),
        // M3 EVT-02：canonical 事件仓库槽位初始 None，setup() 启动时序填充（同库）。
        event_service: Arc::new(Mutex::new(None)),
        // I12-W4：gateway 实例服务与持久化路径，setup() 启动时序填充。
        gateway_instances: crate::gateway::instance::GatewayInstanceService::new(),
        gateway_instance_store_path: Arc::new(Mutex::new(None)),
        // I12-W5：凭据存储槽位初始 None，setup() 打开填充。
        gateway_credentials: Arc::new(Mutex::new(None)),
        // CWD-03：Workspace 注册表初始空（测试经 TestStateBuilder 注入）。
        workspaces: Arc::new(Mutex::new(HashMap::new())),
        // 施工文档 §2.3：数据目录槽位初始空，setup() 最前面解析填入。
        data_dirs: Arc::new(OnceLock::new()),
        plugin_processes: Arc::new(crate::plugin_process::PluginProcessSupervisor::default()),
        pylon_cli: Arc::new(crate::pylon_cli::PylonCliBridge::default()),
        hook_bridge: Arc::new(crate::hook_bridge::HookBridge::default()),
        verified_agent_fingerprints: Arc::new(lifecycle::verification::VerificationVouchers::new()),
    }
}

// P3a（#106）：setup 管道提取——DataDirs 解析→workspace 恢复
// →浏览器/插件/Pet/MCP/Kernel 三服务→gateway 实例恢复→事件泵与 watcher。
// run() 的 setup 闭包改为一行调用；测试可用 mock app 驱动同一序列。
// #331/M2：阶段拆为具名 `setup_*` 函数，失败策略在编排处逐行标注——
// 〔致命〕Err 上抛中止启动；〔可见〕tracing 报错但不中止；〔静默〕warn 后继续。
// 阶段顺序即依赖顺序（施工文档 §2.3），不得重排。
// #482：portable 首启自动迁移（原阶段 3）与 storage 模式诊断（原阶段 5）随
// AppData 双模式一并退役——便携是唯一存储模式，无回退、无迁移。
pub(crate) fn run_setup_pipeline(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    crate::startup_timing::mark("setup_enter");
    let window = setup_open_main_window(app)?; // 〔致命〕主窗口缺失
    let dirs = setup_install_data_dirs(app)?; // 〔致命〕数据目录解析/安装失败——消费者禁止各自回退
    setup_hydrate_workspaces(app)?; // 〔致命〕workspace 注册表恢复失败
    setup_register_browser_host(app, &window, &dirs); // 无失败路径
    setup_register_docs_sheet_host(app, &window); // 无失败路径
    setup_ensure_plugin_dirs(app); // 〔静默〕插件目录树创建失败仅 warn
    setup_restore_pet(app, &dirs); // 〔静默〕宠物存档缺失/损坏保持新宠物
    setup_restore_mcp_config(app, &dirs); // 〔静默〕MCP 配置缺失/损坏/非法保持空配置
    setup_install_persistence_services(app, &dirs)?; // 〔致命〕Kernel 三 service 打开/安装失败（就绪屏障）
    setup_restore_approval_mode(app); // 〔可见〕#448 PR3：落盘值回填内存；失败保持默认 warn
    setup_restore_gateway_instances(app, &dirs); // 〔可见〕实例/凭据恢复失败保留原文件继续
    setup_wire_gateway_registry(app); // 无失败路径（HTTP client 构建失败降级默认 client）
    let connecting = setup_start_dispatchers(app, &window); // 无失败路径；返回默认 agent 是否 Connecting
    setup_spawn_default_agent_connect(app, connecting); // 〔可见〕后台初始连接失败仅 warn（窗口已可见）
    setup_install_gateway_ingest_handler(app); // 无失败路径（handler 内部自行报错/拒绝）
    setup_spawn_session_expiry_watcher(app); // 无失败路径（循环内自报错）
    setup_spawn_journal_maintenance_watcher(app); // 无失败路径（循环内自报错）
    setup_spawn_permission_timeout_watcher(app); // 无失败路径（循环内自报错）
    crate::startup_timing::mark("setup_complete");
    Ok(())
}

/// 阶段 1：取主窗口并设标题。标题失败仅 warn（不阻断）。
fn setup_open_main_window(
    app: &tauri::App,
) -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    if let Err(error) = window.set_title("Pylon") {
        tracing::warn!("set window title failed: {error}");
    }
    Ok(window)
}

/// 阶段 2：解析 DataDirs 并写入 AppState 一次性槽位。
/// 施工文档 §2.3：任何插件/Pet/MCP/SQLite/Gateway 路径消费者运行前，
/// 解析一次 DataDirs 并写入 AppState 一次性槽位。
/// 失败 = 启动中止（blocked），禁止消费者各自回退不同目录。
fn setup_install_data_dirs(
    app: &tauri::App,
) -> Result<crate::paths::DataDirs, Box<dyn std::error::Error>> {
    let data_dirs = crate::paths::resolve_data_dirs()
        .map_err(|error| format!("resolve data dirs failed: {error}"))?;
    app.state::<AppState>()
        .data_dirs
        .set(data_dirs)
        .map_err(|_| "data dirs already initialized".to_string())?;
    // 后续 setup 路径消费者统一使用这份一次性解析结果；跨 async/spawn_blocking
    // 时按需 clone（PathBuf 拷贝成本可忽略）。
    let dirs = app.state::<AppState>().data_dirs_cloned()?;
    // #362：日志目录在 `main()`（`init_tracing`）就已解析，早于这里的 DataDirs。
    // 两边应当落在同一个 data_root 下；不一致说明路径推理漂移了（用户会按说明书
    // 去错地方找日志），所以显式说出来而不是静默分叉。
    if let Some(log_root) = crate::logging::active_log_root() {
        let expected = dirs.data_root.join("logs");
        if log_root != expected {
            tracing::warn!(
                "日志目录与 data_root 不一致：日志在 {}，data_root 下的位置是 {}",
                log_root.display(),
                expected.display()
            );
        }
    }
    crate::startup_timing::mark("data_dirs_resolved");
    Ok(dirs)
}

/// 阶段 3：Workspace 注册表恢复。必须先于前端 hydrate；文件缺失即首次启动，返回空表。
fn setup_hydrate_workspaces(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    crate::workspaces::hydrate_workspaces(app.state::<AppState>().inner())
        .map_err(|error| format!("load workspaces failed: {error}").into())
}

/// 阶段 4：浏览器管理器注入主窗口（Phase 4，子 WebView add_child 需要）+
/// issue #82：Agent 浏览器设置加载 + ref 失效钩子（导航即整表失效）。
fn setup_register_browser_host(
    app: &tauri::App,
    window: &tauri::WebviewWindow,
    dirs: &crate::paths::DataDirs,
) {
    app.state::<AppState>()
        .browser
        .register_host(window.as_ref().window(), app.handle().clone());
    let state = app.state::<AppState>();
    state
        .browser_agent
        .init_settings_path(crate::paths::browser_agent_settings_path(dirs));
    let hub = state.browser_agent.clone();
    state
        .browser
        .register_page_load_hook(std::sync::Arc::new(move |tab_id| {
            if let Ok(mut registry) = hub.refs().lock() {
                registry.invalidate_tab(tab_id);
            }
        }));
}

/// 阶段 4b（#371）：文档 Sheet 管理器注入主窗口（子 WebView add_child 需要）。
fn setup_register_docs_sheet_host(app: &tauri::App, window: &tauri::WebviewWindow) {
    app.state::<AppState>()
        .docs_sheet
        .register_host(window.as_ref().window(), app.handle().clone());
}

/// 阶段 5：插件基建 v2——启动即创建用户插件目录树（installed/staging），
/// 让用户无需先安装也能在文件管理器里看到插件目录。
fn setup_ensure_plugin_dirs(app: &tauri::App) {
    if let Err(error) = crate::plugin_cmds::ensure_plugin_dirs(app.handle()) {
        tracing::warn!("create plugin dirs failed: {error}");
    }
}

/// 阶段 6：宠物状态落盘加载。文件缺失/损坏时保持新宠物（静默降级）。
fn setup_restore_pet(app: &tauri::App, dirs: &crate::paths::DataDirs) {
    let path = crate::paths::pet_persist_path(dirs);
    if let Some(saved) = pet::load_from_file(&path) {
        let pet_arc = app.state::<AppState>().pet.clone();
        if let Ok(mut pet) = pet_arc.lock() {
            pet::restore(&mut pet, saved);
        };
    }
}

/// 阶段 7：B4.2 MCP 配置落盘加载（重启不丢）。文件缺失/损坏/非法 → 保持空配置（静默降级）。
fn setup_restore_mcp_config(app: &tauri::App, dirs: &crate::paths::DataDirs) {
    let path = crate::paths::mcp_persist_path(dirs);
    if let Some(servers) = load_mcp_persisted(&path) {
        if let Ok(mut slot) = app.state::<AppState>().runtime_mcp.lock() {
            *slot = Some(servers);
            tracing::info!("MCP 配置已从 {} 恢复", path.display());
        }
    }
}

/// 阶段 8：Kernel persistence readiness barrier——三个 service 共用同一 SQLite 文件，
/// 但作为一个启动单元串行 open/migrate 并一次性安装。setup 返回后所有
/// command/dispatcher 都可依赖 service 已就绪；任一失败则 setup 失败，
/// 不运行半可用 Kernel，也不回退 localStorage/第二历史权威。
fn setup_install_persistence_services(
    app: &tauri::App,
    dirs: &crate::paths::DataDirs,
) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = crate::paths::message_db_path(dirs);
    let services = crate::session::PersistenceServices::open(&db_path)?;
    let state = app.state::<AppState>();
    *state
        .message_service
        .lock()
        .map_err(|_| "message service slot lock poisoned".to_string())? = Some(services.message);
    *state
        .user_data_service
        .lock()
        .map_err(|_| "user-data service slot lock poisoned".to_string())? =
        Some(services.user_data);
    *state
        .event_service
        .lock()
        .map_err(|_| "event service slot lock poisoned".to_string())? = Some(services.event);
    tracing::info!("Kernel persistence services ready: {}", db_path.display());
    crate::startup_timing::mark("persistence_ready");
    Ok(())
}

/// 阶段 8b（#448 PR3）：approval-mode 从 user_data 回填内存态（此前该值纯内存，
/// 跨重启持久化只在前端 localStorage——任何不经 webview 的 set（CLI 桥）重启后被
/// 前端旧值静默覆盖，#321 决议确认的漂移路径；现后端为权威：启动读回 + set 写穿）。
/// 语义与降级见 `permission::restore_persisted_approval_mode`（回填在 service 装好
/// 之后立刻做：任何 get/set 命令到达前内存态已就位）。
fn setup_restore_approval_mode(app: &tauri::App) {
    crate::permission::restore_persisted_approval_mode(app.state::<AppState>().inner());
}

/// 阶段 9：I12-W4 gateway 实例启动恢复——解析持久化路径 → 加载配置（spawn_blocking）
/// → 批量创建（统一 Stopped，旧 Connected 不直接恢复）→ 按 `enabled && autoStart`
/// 策略显式启动（失败可见，不静默）。损坏/IO 失败保留原文件，仅可见报错
/// （不阻断启动、不丢配置）。I12-W5：同块打开凭据存储（W3）→ 加载后刷新
/// 实例 credential_ref/status（重启不丢凭据引用）。
fn setup_restore_gateway_instances(app: &tauri::App, dirs: &crate::paths::DataDirs) {
    let state = app.state::<AppState>();
    let store_path_slot = state.gateway_instance_store_path.clone();
    let credentials_slot = state.gateway_credentials.clone();
    let path = crate::paths::gateway_instances_path(dirs);
    if let Ok(mut slot) = store_path_slot.lock() {
        *slot = Some(path.clone());
    }
    // I12-W5：打开加密凭据存储（密文/主密钥分目录；失败可见不阻断）。
    // 施工文档 §7.3：路径解析失败 → credentials 槽位保持 None，禁止
    // 回退 `PathBuf::new()`（避免相对当前目录误写 pylon-master.key）。
    let credentials = {
        let credentials_dir = crate::paths::credentials_dir(dirs);
        match crate::gateway::credentials::CredentialStore::open(&credentials_dir) {
            Ok(store) => Some(Arc::new(store)),
            Err(error) => {
                tracing::error!("凭据存储打开失败（set_credentials 不可用）：{error}");
                None
            }
        }
    };
    if let Ok(mut slot) = credentials_slot.lock() {
        *slot = credentials.clone();
    }
    let service = state.gateway_instances.clone();
    let path_for_task = path.clone();
    let credentials_for_refresh = credentials;
    tokio::spawn(async move {
        let loaded = tokio::task::spawn_blocking(move || {
            crate::gateway::instance_store::load_instances(&path_for_task)
        })
        .await;
        match loaded {
            Ok(Ok(instances)) => {
                service.load_instances(instances).await;
                tracing::info!("gateway 实例配置已加载：{}", path.display());
                // I12-W5：重启恢复凭据引用（secret 不载入内存，仅标记）
                if let Some(store) = credentials_for_refresh.as_ref() {
                    let store = store.clone();
                    service
                        .refresh_credential_states(move |platform, id| {
                            store.has_credentials(platform, id).unwrap_or(false)
                        })
                        .await;
                }
                // AC2：仅 enabled && autoStart 显式启动，失败可见（策略测试见
                // instance.rs auto_start_instances）
                service.auto_start_instances().await;
            }
            Ok(Err(error)) => {
                tracing::error!("gateway 实例配置加载失败（保留原文件不覆盖）：{error}")
            }
            Err(error) => {
                tracing::error!("gateway 实例配置加载 task 失败：{error}");
            }
        }
    });
}

/// 阶段 10：gateway 注册面接线——start 凭据解析器（I12-W5）、共用 HTTP client、
/// 平台注册表（P78）、适配器注册表挂钩（P78）与 route guard（W1）。均无失败路径；
/// HTTP client 构建失败降级默认 client。
fn setup_wire_gateway_registry(app: &tauri::App) {
    let state = app.state::<AppState>();
    // I12-W5：start 凭据解析器（factory.create 前从 CredentialStore 解析
    // secret 填入 state；未配置 → None → factory 报 CredentialMissing）
    {
        let credentials_slot = state.gateway_credentials.clone();
        state.gateway_instances.set_credential_resolver(Arc::new(
            move |platform: &str, instance_id: &str| {
                credentials_slot
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone())
                    .and_then(|store| store.get_credentials(platform, instance_id).ok().flatten())
                    .map(|secret| secret.to_string())
            },
        ));
    }
    // gateway 共用 HTTP client（平台 factory 连接循环共用；超时参数
    // 与 legacy env 路径一致）。
    let qq_http = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!("Pylon gateway HTTP client unavailable: {error}");
            reqwest::Client::new()
        }
    };
    // 平台注册表（P78）：一次注册全部带真实适配器的平台（当前仅 qq）；
    // auto-start/手动 start 的凭据校验与连接循环入口。新增平台 =
    // platform_registry.rs 加 entry，本文件零改动。
    crate::gateway::platform_registry::register_platform_factories(
        &state.gateway_instances,
        state.gateway.clone(),
        qq_http,
    );
    // 适配器注册表挂钩（P78）：实例 start/stop 同步注册/注销
    // GatewayCore 适配器——出站 deliver_all 按 source 前缀查注册表，
    // 未注册则平台出站被丢弃。与 legacy env 注册并存时取替换语义
    // （覆盖侧 warn 留痕）。
    {
        let gateway_for_hook = state.gateway.clone();
        state.gateway_instances.set_adapter_registry(Arc::new(
            move |key: &str, adapter: &Arc<dyn gateway::PlatformAdapter>, register: bool| {
                if register {
                    if gateway_for_hook.replace(adapter.clone()).is_some() {
                        tracing::warn!("gateway 适配器 {key} 注册覆盖既有注册（legacy env 并存）");
                    }
                } else if gateway_for_hook.unregister_if(key, adapter) {
                    tracing::info!("gateway 适配器 {key} 已注销（实例停止）");
                }
            },
        ));
    }
    // route guard（W1 remove 的 route_in_use 检查）：任何 route 绑定引用
    // 该 instance id → 拒绝 remove（D-04：route 保留 + disabled，不级联删除）。
    {
        let gateway = state.gateway.clone();
        state
            .gateway_instances
            .set_route_guard(Arc::new(move |instance_id: &str| {
                gateway
                    .routes()
                    .iter()
                    .any(|binding| binding.instance_id.as_deref() == Some(instance_id))
            }));
    }
}

/// 阶段 11：通知 dispatcher 与 runtime log dispatcher 启动。返回默认 agent 是否
/// 处于 Connecting（供阶段 12 判断是否后台初始连接）。
fn setup_start_dispatchers(app: &tauri::App, window: &tauri::WebviewWindow) -> bool {
    let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
    // #270：Connecting 状态的默认 agent runtime 由下方后台任务完成初始连接，其
    // 激活路径（replace_agent_client）自会启动 dispatcher；此处跳过，避免对
    // 占位 client 启动监听（并在激活前误报崩溃/断开）。
    let default_runtime_connecting = handles
        .active_runtime()
        .map(|runtime| {
            runtime
                .agent_runtime
                .lock()
                .map(|state| state.status == AgentLifecycleStatus::Connecting)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if let Some(runtime) = handles.active_runtime() {
        if !default_runtime_connecting {
            start_notification_dispatcher(&handles, &runtime, window.as_ref().window());
        }
    }
    app.state::<AppState>()
        .inner()
        .start_runtime_log_dispatcher(window.as_ref().window());
    default_runtime_connecting
}

/// 阶段 12：#270（ADR-0022）默认 agent 初始连接后台化——窗口先见。持 switch_lock →
/// agent_lifecycle 双锁（与 switch/reconnect 同序）串行化竞争窗口：后台连接
/// 期间用户手动 switch/reconnect 会排队至其完成，不会交叉杀进程或以旧代际
/// 覆盖新客户端（replace_agent_client 的 epoch 校验兜底）。announce=true 使
/// Connecting/Connected/失败回落均经 agent-status 事件广播；连接期间前端发送
/// 被 agentWorkbenchCommands 的 connecting 门控阻断（用户裁定：不做排队、
/// 不做自动触发连接）。
fn setup_spawn_default_agent_connect(app: &tauri::App, default_runtime_connecting: bool) {
    if !default_runtime_connecting {
        return;
    }
    let inner = app.state::<AppState>().inner();
    let active_id = inner
        .active_agent
        .lock()
        .map(|id| id.clone())
        .unwrap_or_default();
    let agent = inner
        .agents
        .lock()
        .ok()
        .and_then(|agents| agents.get(&active_id).cloned());
    let Some(agent) = agent else {
        return;
    };
    let app_handle = app.handle().clone();
    let connect_window = app.get_webview_window("main");
    let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
    crate::startup_timing::mark("default_agent_connect_started");
    // spawn 块内锁序 switch_lock→agent_lifecycle：后台初始连接须与手动 switch/reconnect 串行（同 reconnect_agent）。
    tokio::spawn(async move {
        let state = app_handle.state::<AppState>();
        // 锁序：switch_lock → agent_lifecycle（同 reconnect_agent/switch_agent）。
        let _switch_guard = HeldAcrossAwait::new(state.inner().switch_lock.lock().await);
        let runtime = match handles.active_runtime() {
            Some(runtime) => runtime,
            None => return,
        };
        let _lifecycle_guard = HeldAcrossAwait::new(runtime.agent_lifecycle.lock().await);
        let Some(connect_window) = connect_window else {
            tracing::warn!("主窗口不存在，跳过默认 agent 后台初始连接");
            return;
        };
        let result = state
            .inner()
            .connect_and_replace(
                &runtime,
                &connect_window.as_ref().window(),
                &agent,
                None,
                AgentLifecycleStatus::Connecting,
                "startup-connect",
            )
            .await;
        crate::startup_timing::mark("default_agent_connect_settled");
        match result {
            Ok(()) => tracing::info!("默认 agent 后台初始连接完成"),
            Err(error) => tracing::warn!("默认 agent 后台初始连接失败：{error}"),
        }
    });
}

/// 阶段 13：gateway ingest handler（B10.3）：平台消息 → 绑定/默认 agent runtime → 发送。
/// 平台消息路由不切换 GUI active agent；目标 agent 未连接时懒启动
/// （announce=false，不广播 GUI 状态）。
fn setup_install_gateway_ingest_handler(app: &tauri::App) {
    let app_handle = app.handle().clone();
    let main_webview = app.get_webview_window("main");
    let main_window = main_webview.as_ref().map(|w| w.as_ref().window());
    let state = app.state::<AppState>();
    state
        .gateway
        .set_ingest_handler(Arc::new(move |resolved: &gateway::ResolvedIngest| {
            let app = app_handle.clone();
            let webview = main_webview.clone();
            let window = main_window.clone();
            let resolved = resolved.clone();
            tokio::spawn(async move {
                let state = app.state::<AppState>();
                // I12-W4：route 绑定强制（决策纯函数 resolve_ingest_agent，
                // 正反用例见 route.rs 测试）——instance-bound route 必须指向
                // 已连接实例：InstanceMissing/InstanceNotConnected → 显式错误
                // + 丢弃，**禁止 fallback 到 active agent**（来源实例不可用却
                // 按默认 agent 路由会造成错位回复）。Unbound（legacy 无
                // instance_id）与无 binding 保持旧 fallback 行为（D-04）。
                let binding_ref = resolved.binding.as_ref();
                let bound_instance_id = binding_ref.and_then(|b| b.instance_id.as_deref());
                let instance_status = match bound_instance_id {
                    Some(instance_id) => {
                        state.inner().gateway_instances.status_of(instance_id).await
                    }
                    None => None,
                };
                let active_agent = state
                    .inner()
                    .active_agent
                    .lock()
                    .map(|v| v.clone())
                    .unwrap_or_default();
                // I12 W9：unbound_policy 传入决策（reject 时无 binding 消息显式拒绝，
                // 记录最小元数据，不进入 agent）
                let unbound_policy = state.inner().gateway.unbound_policy();
                let agent_id = match crate::gateway::route::resolve_ingest_agent(
                    binding_ref,
                    instance_status,
                    &active_agent,
                    unbound_policy,
                ) {
                    Ok(id) => id,
                    Err(reason) => {
                        tracing::error!(
                            "gateway ingest 拒绝：route {} 绑定实例 {} 状态不可用（{:?}），禁止 fallback",
                            resolved.source,
                            bound_instance_id.unwrap_or(""),
                            reason
                        );
                        return;
                    }
                };
                if agent_id.is_empty() {
                    tracing::warn!(
                        "gateway ingest 无路由目标（未绑定且无 active agent）: {}",
                        resolved.source
                    );
                    return;
                }
                let runtime = state.inner().runtimes.get_or_create(&agent_id);
                if let Some(webview) = webview.as_ref() {
                    if let Err(error) = state
                        .inner()
                        .ensure_runtime_ready(&runtime, &agent_id, &webview.as_ref().window())
                        .await
                    {
                        tracing::warn!("gateway ingest 目标 agent 连接失败 ({agent_id}): {error}");
                        return;
                    }
                }
                // P1-1：平台路由绑定 agent ≠ GUI active agent 时会话 cwd 必须用
                // 绑定 agent 的 cwd（而非 active agent）；无绑定 agent 定义时回退 None。
                let agent_cwd = state
                    .inner()
                    .agents
                    .lock()
                    .ok()
                    .and_then(|agents| agents.get(&agent_id).cloned())
                    .and_then(|agent| agent.cwd);
                // G2-05：PromptContext 构造（source 需 clone——失败回滚仍用）
                // P55-D1 #3：message.received 钩子缝（spawn 内可安全挂起，
                // 不在 dispatcher 主循环）。gate → 丢弃（helper 已对齐
                // 既有失败路径的 rollback_seen 语义）；transform → 改写
                // content 后继续；超时/桥未就绪 → 原文放行（fail-open）。
                let content = match crate::hook_bridge::message_received_hook_outcome(
                    state.inner(),
                    window.as_ref(),
                    &resolved,
                )
                .await
                {
                    crate::hook_bridge::MessageReceivedDecision::Continue { content } => content,
                    crate::hook_bridge::MessageReceivedDecision::Drop => return,
                };
                if let Err(error) = send_prompt_core(
                    state.inner(),
                    &runtime,
                    window.as_ref(),
                    &state.gateway,
                    &crate::session::PromptContext {
                        source: resolved.source.clone(),
                        profile_id: None,
                        content,
                        persona: String::new(),
                        session_prompt: None,
                        attachments: None,
                        mcp_servers: None,
                        cwd: agent_cwd,
                        known_peri_id: None,
                    },
                )
                .await
                {
                    tracing::warn!("gateway ingest 发送失败 ({}): {error}", resolved.source);
                    // C14：发送失败回滚去重 seen——故障期消息不占去重窗口，
                    // resume 重放可重新 ingest（防故障期消息永久丢失）。
                    // 经 PlatformAdapter::rollback_seen（trait 默认空实现，
                    // QQ 适配器覆盖为 dedup 回滚；未注册适配器时无操作）。
                    // G4 §3-9（C5）：统一入口 adapter_for_source（空 key 返回
                    // None，与旧 platform_key 判空等价；接入 wechat 等新平台
                    // 自动生效，未注册适配器无操作）。
                    if let Some(msg_id) = resolved.msg_id.as_deref() {
                        if let Some(adapter) = state.gateway.adapter_for_source(&resolved.source) {
                            adapter.rollback_seen(msg_id);
                        }
                    }
                }
            });
        }));
}

/// 阶段 14：会话过期 watcher（B10.3b）：每 60s 检查所有 runtime 的平台会话，
/// 按绑定 reset 策略（idle/daily/off）过期并重置（close + 平台通知）。
fn setup_spawn_session_expiry_watcher(app: &tauri::App) {
    let app_for_watcher = app.handle().clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let state = app_for_watcher.state::<AppState>();
            check_session_expiry(state.inner()).await;
        }
    });
}

/// 阶段 15：#110 F3 事件库维护 watcher——墓碑事件清扫（兜底历史垃圾）+ WAL checkpoint
/// （TRUNCATE）。启动即跑一次，此后每 10 分钟一次：流式回合每 chunk 一次事务，
/// 从不 checkpoint 时 WAL 只增不减（体检实证 WAL 66MB 反超主库 62MB）。
fn setup_spawn_journal_maintenance_watcher(app: &tauri::App) {
    let app_for_maintenance = app.handle().clone();
    tokio::spawn(async move {
        loop {
            let state = app_for_maintenance.state::<AppState>();
            match crate::session::message_service_of(state.inner()) {
                Ok(service) => {
                    match service
                        .run_journal_maintenance(crate::session::TOMBSTONE_EVENT_GRACE_DAYS)
                        .await
                    {
                        Ok(outcome) if outcome.events_deleted > 0 => {
                            tracing::info!(
                                tombstones = outcome.tombstones,
                                events_deleted = outcome.events_deleted,
                                "journal maintenance purged tombstoned events"
                            );
                        }
                        Ok(_) => {}
                        Err(error) => {
                            tracing::warn!("journal maintenance skipped: {error}");
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!("journal maintenance skipped: {error}");
                }
            }
            tokio::time::sleep(Duration::from_secs(600)).await;
        }
    });
}

/// 阶段 16：权限超时 watcher（ACP-03 §5.6）：每 5s 结算超时挂起请求并发出
/// permission.resolved terminal 事件——后端唯一计时/应答来源，前端
/// 只展示倒计时并提交选择，不自行宣称超时结果（invariant 5）。
/// #356：同一 watcher 附带私有交互（elicitation/ask-user/exit-plan）对等的
/// deadline drain + 向 agent 回包，并广播 interaction.resolved(timed_out)。
fn setup_spawn_permission_timeout_watcher(app: &tauri::App) {
    let app_for_watcher = app.handle().clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let state = app_for_watcher.state::<AppState>();
            // #423：两条超时 sweep 合一为 sweep_interaction_timeouts 单点
            // （deadline 归队列权威，判定经 drain_expired；广播次序不变：
            // 先 permission.resolved 后 interaction.resolved）。
            let (outcomes, private_outcomes) = sweep_interaction_timeouts(state.inner()).await;
            if outcomes.is_empty() && private_outcomes.is_empty() {
                continue;
            }
            let Some(window) = app_for_watcher.get_webview_window("main") else {
                continue;
            };
            for outcome in outcomes {
                emit_event(
                    &window,
                    crate::event_names::INTERACTION,
                    // #488 批⑤：收敛到单一构造点（原超时 sweep 手拼变体）。
                    crate::permission::resolved_interaction_payload(
                        crate::permission::ResolvedInteractionEvent::Permission {
                            option_id: &outcome.option_id,
                        },
                        &outcome.agent_id,
                        &outcome.session_id,
                        &outcome.request_id.to_string(),
                        outcome.client_generation,
                        "timed_out",
                    ),
                );
            }
            // #356：形状与断线 drain 的 interaction.resolved 同构（kind + reason），
            // workbench 交互条目与权限弹卡据此收敛。
            for outcome in private_outcomes {
                emit_event(
                    &window,
                    crate::event_names::INTERACTION,
                    crate::permission::resolved_interaction_payload(
                        crate::permission::ResolvedInteractionEvent::Interaction {
                            kind: &outcome.kind,
                        },
                        &outcome.agent_id,
                        &outcome.session_id,
                        &outcome.request_id.to_string(),
                        outcome.client_generation,
                        "timed_out",
                    ),
                );
            }
        }
    });
}
pub fn run() {
    // issue #82：浏览器 MCP 桥以 `pylon.exe browser-bridge` 子命令形态运行
    // （零发行包变更）。必须在 GUI 启动前分发：桥复用主二进制但不进 Tauri。
    if std::env::args().nth(1).as_deref() == Some("browser-bridge") {
        std::process::exit(crate::browser::bridge::run_stdio_bridge());
    }
    crate::startup_timing::mark("run_entry");
    install_process_registrations();
    // #363-3：node 版本管理器 PATH 修复。位置有两条硬约束：① `set_var` 会改**进程级**
    // PATH，非线程安全，必须在任何多线程工作之前；② 必须早于 agent 探测/preflight
    // （它们按 PATH 找 CLI，看不到版本管理器的目录就会报「未检测到该 Agent」）。
    // node 已在 PATH 上时本调用立即返回，不动用户自己配好的环境。
    pylon_core::node_path::ensure_node_in_path();
    // R1-R3（P1-1）：启动配置统一装载——同一份 YAML 文本分域解析
    // （Agent/Gateway 部分成功，互不绑定成败）。
    let loaded = agent_config::load_app_config();
    let agents_error = loaded.agents.as_ref().err().map(ToString::to_string);
    let gateway_error = loaded.gateway.as_ref().err().map(ToString::to_string);
    let config_source = loaded.source.clone();
    let gateway_result = loaded.gateway;
    let agents = match loaded.agents {
        Ok(agents) => agents,
        Err(error) => {
            // 启动失败兜底契约：不依赖 tracing subscriber（init_tracing 的 set_global_default 失败被 let _ = 吞掉），保证任何入口下 stderr 必达。
            crate::logging::note_to_stderr(&format!("Pylon agent configuration error: {error}"));
            HashMap::new()
        }
    };
    let default_agent_id = match agent_config::default_agent_id(&agents) {
        Ok(Some(id)) => id,
        Ok(None) => String::new(),
        Err(error) => {
            // 启动失败兜底契约：不依赖 tracing subscriber（init_tracing 的 set_global_default 失败被 let _ = 吞掉），保证任何入口下 stderr 必达。
            crate::logging::note_to_stderr(&format!("Pylon agent configuration error: {error}"));
            String::new()
        }
    };
    let default_agent = agents.get(&default_agent_id).cloned();
    let agents_for_state = agents;
    crate::startup_timing::mark("config_loaded");
    // R5（P1-3）：prism 构造为纯同步，移出 async 块以便诊断快照一次构建。
    let prism = match PrismClient::from_env() {
        Ok(client) => client,
        Err(error) => {
            // 启动失败兜底契约：不依赖 tracing subscriber（init_tracing 的 set_global_default 失败被 let _ = 吞掉），保证任何入口下 stderr 必达。
            crate::logging::note_to_stderr(&format!("Pylon Prism client unavailable: {error}"));
            PrismClient::unavailable(error)
        }
    };
    // Hermes profile 探测随 #271 移除（诊断链无消费依赖；连接期 HERMES_HOME
    // 注入保留在 launch_plan）。
    let startup = Arc::new(crate::startup::build_startup_diagnostics(
        config_source,
        agents_error,
        gateway_error,
        prism.has_valid_configuration(),
        (!default_agent_id.is_empty()).then(|| default_agent_id.clone()),
    ));
    crate::startup_timing::mark("startup_diagnostics_built");

    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(error) => {
            // 启动失败兜底契约：不依赖 tracing subscriber（init_tracing 的 set_global_default 失败被 let _ = 吞掉），保证任何入口下 stderr 必达。
            crate::logging::note_to_stderr(&format!(
                "Pylon runtime initialization failed: {error}"
            ));
            return;
        }
    };
    rt.block_on(async {
        let prism = prism;
        let runtime_logs = runtime_log::RuntimeLogHub::default();
        runtime_log::register_hub(runtime_logs.clone());
        // R3（P1-1）：Gateway 使用启动同源配置快照（不再各自 include_str 另一份）；
        // gateway 域失败 → 空配置 degraded 启动（诊断快照已记录原因）。
        let gateway = Arc::new(match gateway_result {
            Ok(config) => GatewayCore::from_config(config),
            Err(error) => {
                // 启动失败兜底契约：不依赖 tracing subscriber（init_tracing 的 set_global_default 失败被 let _ = 吞掉），保证任何入口下 stderr 必达。
                crate::logging::note_to_stderr(&format!("Pylon gateway configuration error: {error}"));
                GatewayCore::from_config(crate::gateway::route::GatewayConfig::empty())
            }
        });
        // 平台注册表（P78）：env-only 引导（legacy PYLON_QQ_* 路径）。平台清单
        // 与新增平台入口收敛在 gateway/platform_registry.rs，本文件保持平台无关。
        crate::gateway::platform_registry::bootstrap_env_adapters(&gateway);
        let runtimes = Arc::new(AgentRuntimeManager::new());
        let default_runtime = AgentRuntime::new_disconnected();
        // #270（ADR-0022）：窗口先见——初始连接移入 run_setup_pipeline 的后台任务
        // （复用 connect_and_replace 完整激活机器）。此处只声明 Connecting，窗口
        // 创建不再被 CLI spawn+握手托底；连接完成/失败经 agent-status 事件广播。
        if default_agent.is_some() {
            if let Ok(mut state) = default_runtime.agent_runtime.lock() {
                state.status = AgentLifecycleStatus::Connecting;
            }
        } else {
            // 启动失败兜底契约：不依赖 tracing subscriber（init_tracing 的 set_global_default 失败被 let _ = 吞掉），保证任何入口下 stderr 必达。
            // #326：零 Agent 是合法首跑状态（内嵌兜底即零 Agent），不是异常——故为中性提示。
            crate::logging::note_to_stderr(
                    "Pylon has no configured Agent; start in disconnected mode (create one in Settings → Agent)",
                );
        }
        if !default_agent_id.is_empty() {
            runtimes.insert(default_agent_id.clone(), default_runtime);
        }

        let app = tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .register_uri_scheme_protocol("pylon-plugin", |context, request| {
                crate::plugin_cmds::plugin_resource_response(context.app_handle(), request)
            })
            // #371：离线文档站（VitePress dist 随包分发，root = bundle 资源目录）。
            .register_uri_scheme_protocol("pylon-docs", |context, request| {
                crate::docs_sheet::resource::docs_resource_response(context.app_handle(), request)
            })
            .manage(build_app_state(AppStateParts {
                runtimes,
                agents: agents_for_state,
                active_agent: default_agent_id,
                runtime_logs,
                prism,
                gateway,
                startup: (*startup).clone(),
            }))
            .invoke_handler(crate::commands::invoke_handler())
            .setup(|app| run_setup_pipeline(app))
            // 关窗时不在此处 block_on kill——run() 由 rt.block_on 驱动，窗口回调在
            // 同一 runtime 栈内执行，嵌套 block_on 必 panic ("Cannot start a runtime
            // from within a runtime")。子进程清理依赖 AppState drop 链：
            // AcpClient → ManagedChild::drop → kill_and_wait（同步 std 操作，不依赖 tokio）。
            .build(tauri::generate_context!())
            .expect("error while building tauri application");
        crate::startup_timing::mark("windows_created");
        app.run(|app_handle: &tauri::AppHandle, event: tauri::RunEvent| {
            if let tauri::RunEvent::Exit = event {
                // R17：coalescing 有界 drain——清 dirty 防后台任务重复写盘，
                // 随后直接同步落盘兜底（后台任务在途写盘不受影响，R6a 尽力语义）。
                crate::pet::cmds::drain_pet_dirty();
                // 退出兜底：最后持久化一次（get_pet 12s 轮询已覆盖大部分变更）
                let pet_arc = app_handle.state::<AppState>().pet.clone();
                if let Ok(pet) = pet_arc.try_lock() {
                    persist_pet_if_possible(app_handle, &pet);
                };
            }
        });
    });
}

#[cfg(test)]
mod init_tracing_tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_log_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pylon-init-tracing-{tag}-{}", std::process::id()))
    }

    fn read_dir_text(dir: &std::path::Path) -> String {
        let mut text = String::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    text.push_str(&content);
                }
            }
        }
        text
    }

    fn messages(hub: &runtime_log::RuntimeLogHub) -> Vec<String> {
        hub.list(&runtime_log::RuntimeLogQuery {
            level: None,
            source: None,
            session: None,
            search: None,
            limit: None,
        })
        .into_iter()
        .map(|entry| entry.message)
        .collect()
    }

    /// #383 回归锁：带过滤层的落盘 sink 挂在新基底上必须**构造成功且可用**。
    /// 修前该断言以 panic 结束（`fmt::Subscriber does not currently support filters`）。
    #[test]
    fn file_sink_subscriber_builds_and_routes_without_panicking() {
        let dir = temp_log_dir("file");
        let _ = std::fs::remove_dir_all(&dir);
        let hub = runtime_log::RuntimeLogHub::new(64);
        let sink =
            logging::file_sink::build_file_sink(logging::file_sink::LogFileSpec::new(dir.clone()))
                .expect("系统临时目录必须可写");

        let (subscriber, guard) = build_subscriber(
            runtime_log::RuntimeLogLayer::with_hub(hub.clone()),
            Some(sink),
        );
        let worker = guard.expect("带落盘 sink 时必须交出 WorkerGuard");
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "pylon.init_tracing.test", session = "s1", "hello-383");
        });
        // 不 drop worker 就读不到盘上内容：non_blocking 的 flush 在 guard drop 里。
        drop(worker);

        let hub_messages = messages(&hub);
        assert!(
            hub_messages
                .iter()
                .any(|message| message.contains("hello-383")),
            "RuntimeLogLayer 未收到 INFO 事件：{hub_messages:?}"
        );
        let text = read_dir_text(&dir);
        assert!(text.contains("hello-383"), "落盘文件缺少 INFO 事件：{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同一栈的级别去重语义：#383 的修复不能把「panic 记录只由 hook 同步落盘」改掉。
    #[test]
    fn panic_target_events_stay_out_of_the_file_sink() {
        let dir = temp_log_dir("panic-target");
        let _ = std::fs::remove_dir_all(&dir);
        let hub = runtime_log::RuntimeLogHub::new(64);
        let sink =
            logging::file_sink::build_file_sink(logging::file_sink::LogFileSpec::new(dir.clone()))
                .expect("系统临时目录必须可写");

        let (subscriber, guard) =
            build_subscriber(runtime_log::RuntimeLogLayer::with_hub(hub), Some(sink));
        let worker = guard.expect("带落盘 sink 时必须交出 WorkerGuard");
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "pylon.init_tracing.test", "kept-383");
            tracing::warn!(target: logging::PANIC_TARGET, "panic-echo-383");
        });
        drop(worker);

        let text = read_dir_text(&dir);
        assert!(text.contains("kept-383"), "落盘文件缺少 INFO 事件：{text}");
        assert!(
            !text.contains("panic-echo-383"),
            "PANIC_TARGET 事件不该进落盘文件（panic hook 是它唯一的落盘者）：{text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无落盘 sink（日志根不可写）时仍要能起：只挂 hub + stderr，且不交 WorkerGuard。
    #[test]
    fn subscriber_without_file_sink_keeps_hub_and_stderr() {
        let hub = runtime_log::RuntimeLogHub::new(64);
        let (subscriber, guard) =
            build_subscriber(runtime_log::RuntimeLogLayer::with_hub(hub.clone()), None);
        assert!(guard.is_none(), "无落盘 sink 时不应交出 WorkerGuard");
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "pylon.init_tracing.test", "no-file-383");
        });
        let hub_messages = messages(&hub);
        assert!(
            hub_messages
                .iter()
                .any(|message| message.contains("no-file-383")),
            "RuntimeLogLayer 未收到 INFO 事件：{hub_messages:?}"
        );
    }

    /// 负向对照（#383 的**病因**锁）：把带 `.with_filter(...)` 的层挂到 `fmt::Subscriber`
    /// 基底上，`tracing-subscriber` 会**在运行时 panic**——这正是修复前 `init_tracing`
    /// 在「日志根可写」时的行为。这条用例存在是为了让病因本身留在 CI 里：谁若把
    /// 基底改回 `fmt::Subscriber`，上一条用例会红，而这一条解释了为什么。
    #[test]
    #[should_panic(expected = "does not currently support filters")]
    fn fmt_subscriber_base_panics_on_filtered_layer() {
        use tracing_subscriber::layer::Layer;

        let base = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_writer(std::io::stderr)
            .finish();
        let filtered = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(std::io::stderr)
            .with_filter(tracing_subscriber::filter::LevelFilter::INFO);
        let _ = filtered.with_subscriber(base);
    }
}
