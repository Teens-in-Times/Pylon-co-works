//! #106 P2：统一测试 harness——一步组装「无 UI 的整个产品运行」。
//!
//! boot(HarnessConfig) = mock App + mock window + TestStateBuilder AppState
//! （build_app_state 单一构造点）+ 假 agent AcpClient + 真实 dispatcher 事件泵
//! + in-memory EventService。证据收集三路：
//!
//! 1. `events()`——窗口 emit 捕获（前端可见事件面）
//! 2. `journal()`——in-memory EventService 回读（持久化事实面）
//! 3. `wire()`——AcpWireHub snapshot（raw wire 观测面）
//!
//! **temp 生存期**（决策 12）：[`TempPath`] 统一 pid+nanos 命名 + Drop 清理，
//! 断言失败路径不残留（回归锁 `temp_path_is_removed_on_drop`）。
//!
//! **时钟注入点**（决策 12 查证结论）：`Timestamp::now()` 在生产代码有 26 个
//! 散布调用点（session/dispatcher/pet 等），构造入口不收敛，强注入需改动生产
//! 代码——按 spec 预案**降级为编写约定**：新增涉及保留期/过期/重试间隔语义的
//! 测试优先注入 `Timestamp::new(毫秒)` 显式时刻（本模块 TempPath 同理），不调用
//! 真实时钟；确需真实时钟流逝的用 setInterval 轮询 + 显式 deadline。查证日期
//! 2026-09-16（`grep -c "Timestamp::now()"` = 26）。
//!
//! 仅 cfg(test) 编译；P5 抽离时经 `#[cfg(feature = "test-agent")] #[doc(hidden)]`
//! pub 门面暴露给 `tests/integration.rs`。

use crate::agent_config::AgentDef;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};

/// 统一临时路径守卫：唯一命名（复用 test_utils::unique_temp）+ Drop 无条件清理。
pub(crate) struct TempPath(PathBuf);

impl TempPath {
    pub(crate) fn new(label: &str) -> Self {
        Self(crate::test_utils::unique_temp(label))
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        if self.0.is_dir() {
            std::fs::remove_dir_all(&self.0).ok();
        } else {
            std::fs::remove_file(&self.0).ok();
        }
    }
}

/// harness 装配配置（builder 形态；未覆盖项 = TestStateBuilder 生产同源默认值）。
/// P5 门面：外部 `tests/` 目标经 `pub` 方法消费；字段一律私有（不出 crate 内部类型）。
pub struct HarnessConfig {
    agent: Option<AgentDef>,
    approval_mode: String,
    gateway: Option<Arc<crate::gateway::GatewayCore>>,
    /// YAML 文本（`route::parse_config` 形态）——外部测试经它注入 gateway 配置。
    gateway_yaml: Option<String>,
    /// P5 门面：Prism 测试客户端（桩 URL；None = unavailable("test")）。
    prism: Option<crate::prism::PrismClient>,
    /// P5 门面：模型切换协议声明（#97 set_config_option 矩阵）。
    set_model_api: Option<SetModelApiView>,
}

impl HarnessConfig {
    pub fn new() -> Self {
        Self {
            agent: None,
            approval_mode: "default".to_string(),
            gateway: None,
            gateway_yaml: None,
            prism: None,
            set_model_api: None,
        }
    }

    /// P5 门面：模型切换协议声明（#97 set_config_option 矩阵）。
    pub fn with_set_model_api(mut self, api: SetModelApiView) -> Self {
        self.set_model_api = Some(api);
        self
    }

    /// P5 门面：Prism 测试客户端（任意桩 URL，inject/persist 链路用）。
    pub fn with_prism_stub(mut self, url: &str, token: Option<&str>) -> Self {
        self.prism = Some(crate::prism::PrismClient::for_testing(
            url.to_string(),
            token.map(str::to_string),
        ));
        self
    }

    /// boot 内解析 prism：显式注入 > unavailable("test")。
    fn resolve_prism(&self) -> crate::prism::PrismClient {
        self.prism
            .clone()
            .unwrap_or_else(|| crate::prism::PrismClient::unavailable("test".to_string()))
    }

    /// 注入 agent 定义并作为 active agent（连接由 [`TestHarness::boot`] 完成）。
    /// lib 内嵌测试用（AgentDef 为 crate 类型）；外部测试用 [`Self::with_fake_agent`]。
    pub(crate) fn with_agent(mut self, agent: AgentDef) -> Self {
        self.agent = Some(agent);
        self
    }

    /// P5 门面：经假 agent bin 场景旗标注入 agent（外部测试可命名形态）。
    pub fn with_fake_agent(mut self, name: &str, args: &[&str]) -> Self {
        self.agent = Some(crate::test_utils::fake_acp_agent(name, args));
        self
    }

    /// P5 门面：gateway 配置以 YAML 文本注入（内部 route::parse_config + from_config）。
    pub fn with_gateway_yaml(mut self, yaml: &str) -> Self {
        self.gateway_yaml = Some(yaml.to_string());
        self
    }

    pub fn with_approval_mode(mut self, mode: impl Into<String>) -> Self {
        self.approval_mode = mode.into();
        self
    }

    #[allow(dead_code)]
    pub(crate) fn with_gateway(mut self, gateway: Arc<crate::gateway::GatewayCore>) -> Self {
        self.gateway = Some(gateway);
        self
    }

    /// 解析 gateway：显式实例 > YAML 文本 > None（boot 内再兜底 GatewayCore::new）。
    fn resolve_gateway(&self) -> Option<Arc<crate::gateway::GatewayCore>> {
        self.gateway.clone().or_else(|| {
            self.gateway_yaml.as_ref().map(|yaml| {
                Arc::new(crate::gateway::GatewayCore::from_config(
                    crate::gateway::route::parse_config(yaml).expect("gateway yaml must parse"),
                ))
            })
        })
    }
}

impl Default for HarnessConfig {
    fn default() -> Self {
        Self::new()
    }
}

/// 一步组装的产品运行现场：owned app + window + 三路证据收集器。
/// P5 门面：`tests/` 目标可直接构造与驱动；内部字段不出 crate。
pub struct TestHarness {
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    event_rx: std::sync::mpsc::Receiver<serde_json::Value>,
    /// agent 名 → wire hub（boot 时连接的 fake agent 注册于此）。
    wire_hubs: Arc<Mutex<std::collections::HashMap<String, Arc<crate::acp::AcpWireHub>>>>,
    /// P5 门面：register_qq_platform 注册的 QQ 适配器（handle_incoming 驱动用）。
    qq_adapter: Mutex<Option<Arc<crate::gateway::qq::QqAdapter>>>,
    _temp: Vec<TempPath>,
}

/// P5 门面：平台入站的窄值视图（只出值，不出 crate 内部类型引用）。
pub struct IngestView {
    pub source: String,
    pub agent_id: String,
    pub content: String,
}

/// P5 门面：挂起 permission 的窄值视图（字段与内部 PermissionOption 一一对应）。
pub struct PendingPermissionView {
    pub tool_call_id: String,
    pub options: Vec<PermissionOptionView>,
    pub prompt: String,
}

/// P5 门面：permission 选项窄值视图。
pub struct PermissionOptionView {
    pub option_id: String,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub raw: Option<serde_json::Value>,
}

/// P5 门面：模型切换协议声明的外部可命名形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetModelApiView {
    SetModel,
    ConfigOption,
}

impl SetModelApiView {
    fn to_internal(self) -> crate::agent_config::SetModelApi {
        match self {
            SetModelApiView::SetModel => crate::agent_config::SetModelApi::SetModel,
            SetModelApiView::ConfigOption => crate::agent_config::SetModelApi::ConfigOption,
        }
    }
}

/// P5 门面：生命周期状态的外部可命名形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleStatusView {
    Connected,
    Crashed,
    Reconnecting,
    Disconnected,
    Error,
}

impl LifecycleStatusView {
    fn to_internal(self) -> crate::agent::runtime::AgentLifecycleStatus {
        match self {
            LifecycleStatusView::Connected => {
                crate::agent::runtime::AgentLifecycleStatus::Connected
            }
            LifecycleStatusView::Crashed => crate::agent::runtime::AgentLifecycleStatus::Crashed,
            LifecycleStatusView::Reconnecting => {
                crate::agent::runtime::AgentLifecycleStatus::Reconnecting
            }
            LifecycleStatusView::Disconnected => {
                crate::agent::runtime::AgentLifecycleStatus::Disconnected
            }
            LifecycleStatusView::Error => crate::agent::runtime::AgentLifecycleStatus::Error,
        }
    }
}

impl TestHarness {
    /// boot：mock app → AppState（单一构造点）→ in-memory EventService →
    /// 假 agent 连接 → dispatcher 事件泵。任何一步失败即 panic（测试环境缺
    /// 前置属配置错误，早失败优于静默）。
    pub async fn boot(config: HarnessConfig) -> Self {
        let mut config = config;
        // P5：协议声明须在连接前落到 AgentDef（激活时随 fingerprint 记录）。
        if let (Some(agent), Some(api)) = (config.agent.as_mut(), config.set_model_api) {
            agent.acp = Some(crate::agent_config::AcpProtocolConfig {
                set_model_api: Some(api.to_internal()),
                ..Default::default()
            });
        }
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock webview must build");

        // 窗口事件捕获（证据一路）：boot 即挂关键事件面监听，先于任何驱动。
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        let captured_events = [
            crate::event_names::SESSION_UPDATE,
            crate::event_names::SESSION_DONE,
            crate::event_names::SESSION_ERROR,
            crate::event_names::USER_ECHO,
            crate::event_names::INTERACTION,
            crate::event_names::AGENT_STATUS,
            crate::event_names::AGENT_CRASHED,
        ];
        for event in captured_events {
            let event_tx = event_tx.clone();
            webview.listen(event, move |e| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                    let _ = event_tx.send(payload);
                }
            });
        }

        // run() 同源注册入口（协议适配器 + 能力消费者 + rustls provider）。
        crate::install_process_registrations();

        let mut wire_hubs = std::collections::HashMap::new();
        let state = if let Some(agent) = &config.agent {
            let client = crate::acp::AcpClient::connect_with_logs(agent, None)
                .await
                .expect("harness fake agent must initialize");
            wire_hubs.insert(
                agent.name.clone(),
                client
                    .wire_trace()
                    .expect("connected client exposes wire trace"),
            );
            // 与既有集成测试同语义：agent 入表 + runtime(acp=client) + active。
            let gateway = config
                .resolve_gateway()
                .unwrap_or_else(|| Arc::new(crate::gateway::GatewayCore::new()));
            crate::test_utils::test_state_with_acp(
                agent.clone(),
                client,
                gateway,
                config.resolve_prism(),
            )
            .await
        } else {
            let mut builder = crate::test_utils::TestStateBuilder::bare();
            if let Some(gateway) = config.resolve_gateway() {
                builder = builder.with_gateway(gateway);
            }
            builder = builder.with_prism(config.resolve_prism());
            builder.build()
        };
        // #379：夹具语义对齐——上方 connect 成功意味着 fake agent 已真实 initialize，
        // lifecycle status 必须如实置 Connected（test_state_with_acp 只热插 acp 不动
        // 状态）。否则命令入口的懒重连（ensure_connected_for_send）会在 harness 测试
        // 里触发真实二次 spawn：连接换代、wire trace hub 指向旧客户端、golden 断言漂移。
        if let Some(agent) = &config.agent {
            if let Some(runtime) = state.runtimes.get(&agent.name) {
                runtime
                    .agent_runtime
                    .lock()
                    .expect("runtime status lock")
                    .status = crate::agent::runtime::AgentLifecycleStatus::Connected;
            }
        }
        // approval_mode 覆盖在 build 之后（build_app_state 只承载生产默认值）。
        *state.approval.mode().lock().expect("approval mode lock") = config.approval_mode;
        {
            let event_service =
                crate::session::EventService::in_memory().expect("in-memory event service");
            *state.event_service.lock().expect("event service slot") =
                Some(Arc::new(event_service));
        }
        {
            // P5：消息仓库同步装配（replay 导入链路依赖；run() 同为 setup 串行打开）。
            let message_service =
                crate::session::MessageService::in_memory().expect("in-memory message service");
            *state.message_service.lock().expect("message service slot") =
                Some(Arc::new(message_service));
        }
        app.manage(state);

        // dispatcher 事件泵（真实产品路径：崩溃通知/权限/交互的事件源）。
        if config.agent.is_some() {
            let handles =
                crate::AppStateHandles::from_state(app.state::<crate::AppState>().inner());
            if let Some(runtime) = handles.active_runtime() {
                crate::dispatcher::start_notification_dispatcher(
                    &handles,
                    &runtime,
                    webview.as_ref().window(),
                );
            }
        }

        Self {
            app,
            window: webview,
            event_rx,
            wire_hubs: Arc::new(Mutex::new(wire_hubs)),
            qq_adapter: Mutex::new(None),
            _temp: Vec::new(),
        }
    }

    // ── P5 门面：外部 tests/ 目标的驱动与观测面 ─────────────────────────────

    /// HTTP 桩（`test_utils::spawn_http_stub` 门面）：随机端口 + 按序应答 +
    /// 请求字节捕获。返回 `(地址, 请求接收端, 服务线程)`。关联函数——boot 前即可用。
    pub fn http_stub(
        responses: &'static [&'static [u8]],
    ) -> (
        std::net::SocketAddr,
        std::sync::mpsc::Receiver<Vec<u8>>,
        std::thread::JoinHandle<()>,
    ) {
        crate::test_utils::spawn_http_stub(responses)
    }

    /// 注册 QQ 平台适配器（测试构造：token + 桩地址，真实 HTTP 客户端）。
    pub fn register_qq_platform(&self, api_base_url: &str, token: &str) {
        let gateway = {
            let state = self.app.state::<crate::AppState>();
            state.gateway.clone()
        };
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("http client");
        let auth = Arc::new(crate::gateway::qq::auth::QqAuth::for_testing(
            token.to_string(),
        ));
        let adapter = crate::gateway::qq::QqAdapter::for_testing(
            gateway.clone(),
            http,
            auth,
            api_base_url.to_string(),
        );
        gateway.register(adapter.clone()).expect("register qq");
        *self.qq_adapter.lock().expect("qq adapter lock") = Some(adapter);
    }

    /// 平台消息入站驱动（去重 + 白名单 + ingest 解析），返回窄值视图。
    pub fn qq_handle_incoming(
        &self,
        source: &str,
        msg_id: &str,
        content: &str,
        member_openid: Option<&str>,
    ) -> Result<Option<IngestView>, String> {
        let adapter = self
            .qq_adapter
            .lock()
            .expect("qq adapter lock")
            .clone()
            .expect("register_qq_platform must be called first");
        let resolved = adapter.handle_incoming(source, msg_id, content, member_openid, None)?;
        Ok(resolved.map(|resolved| IngestView {
            source: resolved.source,
            agent_id: resolved
                .binding
                .as_ref()
                .map(|binding| binding.agent_id.clone())
                .unwrap_or_default(),
            content: resolved.content,
        }))
    }

    /// 接线 gateway ingest handler（镜像 run() setup 的绑定路由 + 发送链路：
    /// ingest → agent runtime → send_prompt_core）。
    pub fn wire_gateway_ingest(&self) {
        use crate::session::send_prompt_core;
        let app_handle = self.app.handle().clone();
        let window = self.window.as_ref().window();
        let state = self.app.state::<crate::AppState>();
        state.gateway.set_ingest_handler(Arc::new(
            move |resolved: &crate::gateway::ResolvedIngest| {
                let app = app_handle.clone();
                let window = window.clone();
                let resolved = resolved.clone();
                tokio::spawn(async move {
                    let state = app.state::<crate::AppState>();
                    let agent_id = resolved
                        .binding
                        .as_ref()
                        .map(|binding| binding.agent_id.clone())
                        .unwrap_or_default();
                    let runtime = state.inner().runtimes.get_or_create(&agent_id);
                    if let Err(error) = send_prompt_core(
                        state.inner(),
                        &runtime,
                        Some(&window),
                        &state.gateway,
                        &crate::session::PromptContext {
                            source: resolved.source.clone(),
                            profile_id: None,
                            content: resolved.content.clone(),
                            persona: String::new(),
                            session_prompt: None,
                            attachments: None,
                            mcp_servers: None,
                            cwd: None,
                            known_peri_id: None,
                        },
                    )
                    .await
                    {
                        tracing::warn!("ingest send failed: {error}");
                    }
                });
            },
        ));
    }

    /// 轮询等待 active runtime 建立平台会话映射（ingest 链路通的证据）。
    pub async fn wait_for_platform_session(&self, source: &str, seconds: u64) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
        loop {
            let has = self
                .app
                .state::<crate::AppState>()
                .inner()
                .active_runtime()
                .map(|runtime| {
                    runtime
                        .sessions
                        .lock()
                        .map(|sessions| sessions.contains_key(source))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if has {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "平台会话 {source} 必须在 {seconds}s 内建立"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// 已连接 agent 的 runtime（状态检视：generation/status/sessions）。
    pub(crate) fn runtime(&self, agent_id: &str) -> Option<Arc<crate::runtime::AgentRuntime>> {
        self.state().runtimes.get(agent_id)
    }

    /// AppState 借用（生命周期由 self.app 持有）。
    pub(crate) fn state(&self) -> tauri::State<'_, crate::AppState> {
        self.app.state::<crate::AppState>()
    }

    /// 主窗口（驱动 command 所需的事件面参数）。
    pub(crate) fn window(&self) -> &tauri::WebviewWindow<tauri::test::MockRuntime> {
        &self.window
    }

    /// 证据一路：窗口事件捕获 channel 的当前快照（非阻塞 drain）。
    pub(crate) fn events(&self) -> Vec<serde_json::Value> {
        let mut drained = Vec::new();
        while let Ok(payload) = self.event_rx.try_recv() {
            drained.push(payload);
        }
        drained
    }

    /// 证据二路：in-memory journal 回读（owner key = 序列化后的身份三元组）。
    pub(crate) async fn journal(&self, owner_key: &str) -> Vec<crate::session::CanonicalEventRow> {
        let state = self.state();
        let service = state
            .event_service
            .lock()
            .expect("event service slot")
            .clone();
        let service = service.expect("boot installed in-memory event service");
        service
            .list_events(owner_key.to_string(), None, 100, false)
            .await
            .expect("journal readback")
            .events
    }

    /// 证据三路：AcpWireHub snapshot（raw wire 观测）。
    pub(crate) fn wire(&self, agent_id: &str) -> Vec<crate::acp::WireRecord> {
        self.wire_hubs
            .lock()
            .expect("wire hubs lock")
            .get(agent_id)
            .map(|hub| hub.snapshot())
            .unwrap_or_default()
    }

    /// temp 路径登记进 harness（Drop 随 harness 清理）。
    #[allow(dead_code)]
    pub(crate) fn temp_path(&mut self, label: &str) -> PathBuf {
        let temp = TempPath::new(label);
        let path = temp.path().to_path_buf();
        self._temp.push(temp);
        path
    }

    // ── P5 门面：生命周期 / 权限 / 运行时状态检视（auto_reconnect 切片）──────

    /// P5 门面：在 active runtime 预置平台会话映射（agent 归属测试的
    /// "崩溃前已有会话"现场；SessionInfo::new 同语义）。
    pub fn seed_session(
        &self,
        local_source: &str,
        remote_id: &str,
        persona: &str,
        cwd: &str,
        generation: u64,
    ) {
        let state = self.app.state::<crate::AppState>();
        let runtime = state
            .inner()
            .active_runtime()
            .expect("active runtime must exist for session seeding");
        runtime.sessions.lock().expect("sessions lock").insert(
            local_source.to_string(),
            crate::session::SessionInfo::new(
                remote_id.to_string(),
                persona.to_string(),
                cwd.to_string(),
                true,
                generation,
            ),
        );
    }

    /// P5 门面：改写 agents 表中指定 agent 的场景旗标（重连成功路径换 alive 等）。
    pub fn redefine_fake_agent(&self, name: &str, args: &[&str]) {
        let def = crate::test_utils::fake_acp_agent(name, args);
        self.app
            .state::<crate::AppState>()
            .agents
            .lock()
            .expect("agents lock")
            .insert(name.to_string(), def);
    }

    /// P5 门面：active agent 的 provider 覆盖（request_permission 需要
    /// provider-scoped 适配器； peri/hermes 已由 install_process_registrations 注册）。
    pub fn set_active_agent_provider(&self, name: &str, provider: &str) {
        let state = self.app.state::<crate::AppState>();
        let mut agents = state.agents.lock().expect("agents lock");
        if let Some(def) = agents.get_mut(name) {
            def.provider = Some(provider.to_string());
        }
    }

    /// P5 门面：手动重连（do_connect_and_replace 同参调用：Reconnecting /
    /// reconnect / Invalidated / announce）。
    pub async fn manual_reconnect(&self) -> Result<(), String> {
        let state = self.app.state::<crate::AppState>();
        let handles = crate::AppStateHandles::from_state(state.inner());
        let runtime = handles.active_runtime().expect("active runtime");
        let agent = state.inner().get_active_agent().expect("active agent");
        crate::lifecycle::do_connect_and_replace(
            &handles,
            &runtime,
            &self.window.as_ref().window(),
            &agent,
            None,
            crate::agent::runtime::AgentLifecycleStatus::Reconnecting,
            "reconnect",
            crate::agent::runtime::SessionContinuity::Invalidated,
            true,
        )
        .await
    }

    /// P5 门面：应答 active runtime 上挂起的 permission（number id 形态）。
    pub async fn resolve_permission(&self, id: u64, option_id: &str) -> Result<(), String> {
        let state = self.app.state::<crate::AppState>();
        let runtime = state
            .inner()
            .active_runtime()
            .expect("active runtime for permission");
        crate::permission::resolve_permission(
            &runtime,
            crate::acp::RequestId::Number(id),
            option_id,
        )
        .await
        .map_err(|error| error.to_string())
    }

    /// P5 门面：轮询等待挂起 permission 出现并返回窄值视图。
    pub async fn wait_for_pending_permission(
        &self,
        id: u64,
        seconds: u64,
    ) -> PendingPermissionView {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
        loop {
            let pending = self
                .app
                .state::<crate::AppState>()
                .inner()
                .active_runtime()
                .and_then(|runtime| {
                    runtime
                        .ledger
                        .permissions()
                        .lock()
                        .ok()
                        .map(|pending| pending.get(&crate::acp::RequestId::Number(id)).cloned())
                        .unwrap_or(None)
                });
            if let Some(pending) = pending {
                return PendingPermissionView {
                    tool_call_id: pending.tool_call_id,
                    options: pending
                        .options
                        .iter()
                        .map(|option| PermissionOptionView {
                            option_id: option.option_id.clone(),
                            kind: option.kind.clone(),
                            name: option.name.clone(),
                            raw: option.raw.clone(),
                        })
                        .collect(),
                    prompt: pending.prompt,
                };
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "挂起 permission {id} 必须在 {seconds}s 内出现"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// P5 门面：挂起 permission 应答后清理断言用。
    pub fn pending_permission_exists(&self, id: u64) -> bool {
        self.app
            .state::<crate::AppState>()
            .inner()
            .active_runtime()
            .map(|runtime| {
                runtime
                    .ledger
                    .permissions()
                    .lock()
                    .map(|pending| pending.contains_key(&crate::acp::RequestId::Number(id)))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    /// P5 门面：unique_temp 命名的临时文件路径（调用方自管清理，原 auto_reconnect
    /// permission 测试形态）。关联函数——boot 前即可取路径。
    pub fn temp_file(label: &str) -> PathBuf {
        crate::test_utils::unique_temp(label)
    }

    // ── 状态检视（窄值轮询）─────────────────────────────────────────────────

    /// 轮询等待生命周期状态达到目标。
    pub async fn wait_for_status(&self, status: LifecycleStatusView, seconds: u64) {
        let target = status.to_internal();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
        loop {
            let current = self
                .app
                .state::<crate::AppState>()
                .inner()
                .active_runtime()
                .map(|runtime| {
                    runtime
                        .agent_runtime
                        .lock()
                        .map(|state| state.status)
                        .unwrap_or(crate::agent::runtime::AgentLifecycleStatus::Disconnected)
                })
                .unwrap_or(crate::agent::runtime::AgentLifecycleStatus::Disconnected);
            if current == target {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "生命周期状态必须在 {seconds}s 内到达 {status:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// 当前 client generation。
    pub fn client_generation(&self) -> u64 {
        self.app
            .state::<crate::AppState>()
            .inner()
            .active_runtime()
            .map(|runtime| {
                runtime
                    .client_generation
                    .load(std::sync::atomic::Ordering::Acquire)
            })
            .unwrap_or(0)
    }

    /// 自动重连防重入标志当前值。
    pub fn auto_reconnect_active(&self) -> bool {
        self.app
            .state::<crate::AppState>()
            .inner()
            .active_runtime()
            .map(|runtime| {
                runtime
                    .auto_reconnect_active
                    .load(std::sync::atomic::Ordering::Acquire)
            })
            .unwrap_or(false)
    }

    /// 轮询等待自动重连标志置位。
    pub async fn wait_for_auto_reconnect_scheduled(&self, seconds: u64) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
        loop {
            if self.auto_reconnect_active() {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "自动重连必须在 {seconds}s 内被调度"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// 轮询等待自动重连标志释放。
    pub async fn wait_for_auto_reconnect_released(&self, seconds: u64) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
        loop {
            if !self.auto_reconnect_active() {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "自动重连标志必须在 {seconds}s 内释放"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// 轮询等待 client generation 达到下限。
    pub async fn wait_for_generation_at_least(&self, generation: u64, seconds: u64) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
        loop {
            if self.client_generation() >= generation {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "generation 必须在 {seconds}s 内到达 >= {generation}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// 平台会话映射中的 generation（None = 会话不存在）。
    pub fn session_generation(&self, source: &str) -> Option<u64> {
        self.app
            .state::<crate::AppState>()
            .inner()
            .active_runtime()
            .and_then(|runtime| {
                runtime
                    .sessions
                    .lock()
                    .ok()
                    .and_then(|sessions| sessions.get(source).map(|session| session.generation))
            })
    }

    /// 平台会话映射条数。
    pub fn sessions_len(&self) -> usize {
        self.app
            .state::<crate::AppState>()
            .inner()
            .active_runtime()
            .map(|runtime| {
                runtime
                    .sessions
                    .lock()
                    .map(|sessions| sessions.len())
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    // ── P5 门面：命令驱动（b11_inject 切片）─────────────────────────────────

    /// DurableSessionOwner 的 owner key 形态（journal 回读键）。
    pub fn owner_key(profile: &str, agent: &str, source: &str) -> String {
        serde_json::to_string(&[profile, agent, source]).expect("owner key serializes")
    }

    /// 驱动 `send_message` 命令（真实产品路径：journal + 事件 + wire）。
    pub async fn send_message(
        &self,
        agent_id: &str,
        source: &str,
        profile: Option<&str>,
        content: &str,
        persona: &str,
    ) -> Result<String, String> {
        crate::session::send_message(
            self.app.state::<crate::AppState>(),
            self.window.as_ref().window().clone(),
            agent_id.to_string(),
            source.to_string(),
            profile.map(str::to_string),
            content.to_string(),
            persona.to_string(),
            None,
            None,
            None,
            None,
        )
        .await
        .map_err(|error| error.to_string())
    }

    /// 驱动 `cancel_prompt` 命令（#324 中性结算切片：停止按钮的真实产品路径）。
    pub async fn cancel_prompt(&self, agent_id: &str, source: &str) -> Result<(), String> {
        crate::session::cancel_prompt(
            self.app.state::<crate::AppState>(),
            agent_id.to_string(),
            source.to_string(),
        )
        .await
        .map_err(|error| error.to_string())
    }

    /// 驱动 `new_session` 命令，返回会话创建响应 JSON。
    pub async fn new_session(
        &self,
        agent_id: &str,
        source: &str,
        profile: &str,
        persona: &str,
        cwd: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        crate::session::new_session(
            self.app.state::<crate::AppState>(),
            self.window.as_ref().window().clone(),
            agent_id.to_string(),
            source.to_string(),
            profile.to_string(),
            persona.to_string(),
            cwd.map(str::to_string),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .map_err(|error| error.to_string())
    }

    /// 驱动 `load_persisted_session` 命令（replay 导入链路），返回响应 JSON。
    pub async fn load_persisted_session(
        &self,
        profile: &str,
        agent: &str,
        source: &str,
        remote_session_id: &str,
        cwd: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let owner = crate::session::DurableSessionOwner::new(profile, agent, source);
        crate::session::load_persisted_session(
            self.app.state::<crate::AppState>(),
            owner,
            remote_session_id.to_string(),
            cwd.map(str::to_string),
            None,
            None,
        )
        .await
        .map_err(|error| error.to_string())
    }

    /// #53：驱动 `probe_agent_selectors` 命令（空态选择器探测，一次性会话即弃）。
    pub async fn probe_agent_selectors(&self, agent_id: &str) -> Result<serde_json::Value, String> {
        crate::session::probe_agent_selectors(
            self.app.state::<crate::AppState>(),
            agent_id.to_string(),
            None,
            None,
        )
        .await
        .map_err(|error| error.to_string())
    }

    /// 证据二路（JSON 形态）：journal 行序列化为 Value（eventType/sequence/
    /// typedPayload 均可按 serde camelCase 名取用）——外部测试可命名形态。
    pub async fn journal_json(&self, owner_key: &str, limit: u32) -> Vec<serde_json::Value> {
        let state = self.app.state::<crate::AppState>();
        let service = state
            .event_service
            .lock()
            .expect("event service slot")
            .clone()
            .expect("boot installed in-memory event service");
        service
            .list_events(owner_key.to_string(), None, limit, false)
            .await
            .expect("journal readback")
            .events
            .iter()
            .map(|row| serde_json::to_value(row).expect("canonical row serializes"))
            .collect()
    }

    // ── P5 门面：模型切换命令驱动（model_switch 切片）────────────────────────

    /// P5 门面：client generation 前进（stale generation 竞态测试的 racer 用）。
    pub fn advance_client_generation(&self) {
        if let Some(runtime) = self.app.state::<crate::AppState>().inner().active_runtime() {
            runtime
                .client_generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }
    }

    /// 驱动 `set_config_option` 命令，返回命令 JSON 响应。
    pub async fn set_config_option(
        &self,
        agent_id: &str,
        source: &str,
        key: &str,
        value: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        crate::session::set_config_option(
            self.app.state::<crate::AppState>(),
            agent_id.to_string(),
            source.to_string(),
            key.to_string(),
            value,
        )
        .await
        .map_err(|error| error.to_string())
    }

    /// P5 门面：会话模型面的窄值视图（#97 矩阵断言用）。
    pub async fn session_model_state(&self, source: &str) -> Option<ModelStateView> {
        let state = self.app.state::<crate::AppState>();
        let runtime = state.inner().active_runtime()?;
        let session = runtime.sessions.lock().ok()?.get(source).cloned()?;
        let (surface_config_id, surface_is_none) = match session.model_surface {
            crate::session::ModelSurface::ConfigOption { config_id } => (Some(config_id), false),
            crate::session::ModelSurface::None => (None, true),
            crate::session::ModelSurface::ModelsState => (None, false),
        };
        Some(ModelStateView {
            model: Some(session.model),
            model_pending: session.model_pending,
            surface_config_id,
            surface_is_none,
            model_choices: session.model_choices,
            mode: session.mode,
        })
    }

    /// P5 门面：ensure_session_mapping（load/resume/新建收敛入口）。
    /// 返回 `(peri_id, recreated)`。
    pub async fn ensure_mapping(
        &self,
        source: &str,
        profile_id: Option<&str>,
        persona: &str,
        session_cwd: &str,
        known_peri_id: Option<&str>,
    ) -> Result<(String, Option<String>), String> {
        let state = self.app.state::<crate::AppState>();
        let runtime = state
            .inner()
            .active_runtime()
            .expect("active runtime for mapping");
        let mut recreated = None;
        let mapping = crate::session::ensure_session_mapping(
            &crate::session::SessionAssembly {
                state: state.inner(),
                runtime: &runtime,
                source,
                profile_id,
                persona,
                session_cwd,
                wire_mcp_servers: &[],
            },
            known_peri_id,
            &mut recreated,
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok((mapping.peri_id, recreated))
    }
}

/// P5 门面：会话模型面窄值视图。
/// `surface_config_id` = ConfigOption 面的 config id；`surface_is_none` = 无模型面。
pub struct ModelStateView {
    pub model: Option<String>,
    pub model_pending: Option<String>,
    pub surface_config_id: Option<String>,
    pub surface_is_none: bool,
    pub model_choices: Vec<String>,
    pub mode: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验收 19（temp 生存期）：harness TempPath 清理后路径不存在。
    #[test]
    fn temp_path_is_removed_on_drop() {
        let path = {
            let temp = TempPath::new("harness-lifetime");
            std::fs::write(temp.path(), b"payload").expect("write temp");
            assert!(temp.path().exists());
            temp.path().to_path_buf()
        };
        assert!(!path.exists(), "Drop 必须清理 temp 路径");
    }

    /// 验收 7（harness 冒烟）：boot → 假 agent prompt → journal 落盘 +
    /// 窗口事件 + wire snapshot 三路断言贯通。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn boot_prompt_produces_journal_events_and_wire_evidence() {
        use crate::acp::METHOD_SESSION_NEW;

        let agent = crate::test_utils::fake_acp_agent(
            "harness-smoke",
            &["--scenario", "stream", "--session-id", "harness-session"],
        );
        let harness = TestHarness::boot(HarnessConfig::new().with_agent(agent)).await;
        let state = harness.state();
        let window = harness.window().clone();

        // 经真实 command 入口建会话（session/new 上 wire + SessionInfo 记账）。
        let created = crate::session::new_session(
            state.clone(),
            window.as_ref().window().clone(),
            "harness-smoke".to_string(),
            "local:harness-smoke".to_string(),
            "profile-harness".to_string(),
            "persona".to_string(),
            Some(".".to_string()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("session must be created");
        assert_eq!(
            created["sessionId"], "harness-session",
            "假 agent 的 sessionId 必须回显"
        );

        // 经 send_message 驱动一次完整 prompt（真实产品路径：journal + 事件 + wire）。
        crate::session::send_message(
            state.clone(),
            window.as_ref().window().clone(),
            "harness-smoke".to_string(),
            "local:harness-smoke".to_string(),
            Some("profile-harness".to_string()),
            "harness prompt".to_string(),
            String::new(),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("prompt must settle");

        // 证据三路·wire：session/new 与 session/prompt 都在 raw wire 上。
        let wire = harness.wire("harness-smoke");
        assert!(
            wire.iter()
                .any(|record| record.method.as_deref() == Some(METHOD_SESSION_NEW)),
            "session/new 必须出现在 wire 证据中"
        );
        assert!(
            wire.iter()
                .any(|record| record.method.as_deref() == Some("session/prompt")),
            "session/prompt 必须出现在 wire 证据中"
        );

        // 证据二路·journal：authoritative user 事实行落盘。
        let owner =
            serde_json::to_string(&["profile-harness", "harness-smoke", "local:harness-smoke"])
                .expect("owner key");
        let journal = harness.journal(&owner).await;
        assert!(
            journal
                .iter()
                .any(|event| event.event_type == "user.message"),
            "journal 必须含 user.message（实际: {:?}）",
            journal
                .iter()
                .map(|event| event.event_type.clone())
                .collect::<Vec<_>>()
        );

        // 证据一路·窗口事件：前端可见面已有捕获（stream 场景必有 chunk/done）。
        let events = harness.events();
        assert!(
            !events.is_empty(),
            "窗口事件证据不得为空（stream 场景至少发一条 chunk + done）"
        );

        // 状态检视面：runtime 仍挂 Harness 上可用。
        assert!(
            harness.runtime("harness-smoke").is_some(),
            "runtime 检视面必须可用"
        );
    }
}
