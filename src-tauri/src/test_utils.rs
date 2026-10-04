//! 共享测试基建（R5c + G5-1）：fake ACP 子进程 agent 构造 + AppState 测试构造 builder。
//!
//! 消除 acp.rs 测试（14 块 AgentDef 字面量）与 lib.rs 集成测试（auto_reconnect /
//! b11 inject / gateway 平台测试）之间的重复构造；AppState 字面量（10 处）与
//! build_state_with 包装（4 份）收敛到 TestStateBuilder。仅 cfg(test) 编译。
//!
//! #106 P1：fake agent 一律为 `pylon-fake-agent` member crate 的 bin（feature
//! `test-agent`；#382 起独立成 crate，见其 manifest），内嵌 Python 脚本与解释器
//! 探测链已删除——测试不再依赖宿主解释器与 locale（cp1252 surrogate escape 问题
//! 随之消失）。场景旗标见 `src-tauri/pylon-fake-agent/src/main.rs` 模块文档。

use crate::acp::AcpClient;
use crate::agent_config::AgentDef;
use crate::gateway::GatewayCore;
use crate::prism::PrismClient;
use crate::runtime::{AgentRuntime, AgentRuntimeManager};
use crate::AppState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

/// P70/P91（批 C1 横切 §3）：同型临时路径的唯一命名（pid + nanos）。
/// pid 隔离跨进程并发，nanos 隔离同进程内先后/并发调用——上次崩溃残留的
/// 同名路径不会被 create_dir_all 静默复用（纯 pid 命名的缺陷）。调用方需要
/// 带扩展名的文件路径时对返回值 `.with_extension(...)`（本命名不含 `.`）。
pub(crate) fn unique_temp(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("pylon-{label}-{}-{nanos}", std::process::id()))
}

/// 定位 `pylon-fake-agent` bin：`PYLON_FAKE_AGENT_BIN` 显式覆盖 →
/// `current_exe()` 祖先目录找 `target/<profile>/pylon-fake-agent(.exe)`。
/// 找不到即 panic 并提示构建命令（测试环境缺 bin 属配置错误，早失败优于静默）。
pub(crate) fn fake_agent_bin() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("PYLON_FAKE_AGENT_BIN") {
        if !path.trim().is_empty() {
            return std::path::PathBuf::from(path);
        }
    }
    let exe = std::env::current_exe().expect("current_exe must resolve");
    let bin_names: &[&str] = if cfg!(windows) {
        &["pylon-fake-agent.exe"]
    } else {
        &["pylon-fake-agent"]
    };
    for ancestor in exe.ancestors() {
        for name in bin_names {
            let candidate = ancestor.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    panic!(
        "pylon-fake-agent bin not found（先构建：cargo build -p pylon-fake-agent \
         --features test-agent；或设 PYLON_FAKE_AGENT_BIN 指向已有 bin）"
    )
}

/// 构造 fake ACP 子进程 agent：`pylon-fake-agent <args...>`（场景旗标）。
/// `args` 形如 `["--scenario", "alive"]`；场景清单见 bin 模块文档。
pub(crate) fn fake_acp_agent(name: &str, args: &[&str]) -> AgentDef {
    let owned: Vec<String> = args.iter().map(|value| value.to_string()).collect();
    AgentDef {
        name: name.to_string(),
        provider: None,
        transport: "subprocess".to_string(),
        exe: fake_agent_bin().to_string_lossy().into_owned(),
        args: owned,
        cwd: None,
        env: HashMap::new(),
        default: false,
        set_model_api: false,
        model: None,
        hermes_profile: None,
        acp_args: Vec::new(),
        acp: None,
    }
}

/// 便捷别名：占位 agent（旧 `print('x')` 脚本形态）——进程内测试从不 spawn，
/// 只需要一个合法 AgentDef 字面量。
pub(crate) fn fake_acp_agent_stub(name: &str) -> AgentDef {
    fake_acp_agent(name, &["--scenario", "alive"])
}

// ── AppState 测试构造 builder（G5-1）──

/// AppState 测试构造 builder（G5-1）：收敛 10 处测试字面量 + 4 份 build_state_with。
///
/// # 默认值纪律（E18）
/// 本 builder 的默认值 = `lib.rs run()` 生产构造现值（lib.rs:2602-2616）与既有
/// 测试字面量并集：runtimes 空表 / agents 空表 / active_agent="ghost-agent" /
/// pet=PetState::default() / runtime_logs 新建 / runtime_mcp=None /
/// prism=PrismClient::unavailable("test") / gateway=GatewayCore::new() /
/// approval_mode="default" / 三把锁新建（G6-07b：pet_last_persist_ms 已删，写盘自愈归后台任务）。
/// **AppState 增加字段时必须同步本 builder**——字面量构造点会编译失败强制同步，
/// 而 builder 需手工同步（纪律登记：后端手册 §2.1；E18 封闭）。
pub(crate) struct TestStateBuilder {
    runtimes: Arc<AgentRuntimeManager>,
    agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    active_agent: String,
    prism: PrismClient,
    gateway: Arc<GatewayCore>,
    startup: Arc<RwLock<crate::startup::StartupDiagnostics>>,
    approval_mode: String,
    user_data_service: Option<Arc<crate::session::UserDataService>>,
    workspaces: Arc<Mutex<HashMap<String, crate::workspaces::Workspace>>>,
    data_dirs: Arc<OnceLock<crate::paths::DataDirs>>,
}

impl TestStateBuilder {
    /// 裸状态：空 runtimes/agents，active_agent="ghost-agent"
    /// （替代 session.rs:1911 / workspace_cmds.rs:112 / lib.rs:1966 字面量；
    /// lib.rs:1966 用 `.with_active_agent("")` 覆盖）。
    pub(crate) fn bare() -> Self {
        Self {
            runtimes: Arc::new(AgentRuntimeManager::new()),
            agents: Arc::new(Mutex::new(HashMap::new())),
            active_agent: "ghost-agent".to_string(),
            prism: PrismClient::unavailable("test".to_string()),
            gateway: Arc::new(GatewayCore::new()),
            startup: Arc::new(RwLock::new(
                crate::startup::StartupDiagnostics::test_default(),
            )),
            approval_mode: "default".to_string(),
            user_data_service: None,
            workspaces: Arc::new(Mutex::new(HashMap::new())),
            data_dirs: Arc::new(OnceLock::new()),
        }
    }

    pub(crate) fn with_active_agent(mut self, id: impl Into<String>) -> Self {
        self.active_agent = id.into();
        self
    }

    /// 入 agents 表（键 = AgentDef.name，与 `test_state_with_acp` 同语义）。
    pub(crate) fn with_agent(self, def: AgentDef) -> Self {
        self.agents.lock().unwrap().insert(def.name.clone(), def);
        self
    }

    pub(crate) fn with_runtime(self, id: impl Into<String>, runtime: Arc<AgentRuntime>) -> Self {
        self.runtimes.insert(id.into(), runtime);
        self
    }

    pub(crate) fn with_prism(mut self, prism: PrismClient) -> Self {
        self.prism = prism;
        self
    }

    pub(crate) fn with_gateway(mut self, gateway: Arc<GatewayCore>) -> Self {
        self.gateway = gateway;
        self
    }

    /// CWD-03：注入 Workspace 实体（root 解析链迁移测试用）。
    pub(crate) fn with_workspace(self, workspace: crate::workspaces::Workspace) -> Self {
        self.workspaces
            .lock()
            .unwrap()
            .insert(workspace.id.clone(), workspace);
        self
    }

    pub(crate) fn with_approval_mode(mut self, mode: impl Into<String>) -> Self {
        self.approval_mode = mode.into();
        self
    }

    /// #448 PR3：注入 user data service（approval-mode 写穿路径测试用）；
    /// 缺省 None（service 未就绪 → 写穿降级 warn 的既有默认行为）。
    pub(crate) fn with_user_data_service(
        mut self,
        service: Arc<crate::session::UserDataService>,
    ) -> Self {
        self.user_data_service = Some(service);
        self
    }

    /// 施工文档 §2.3：注入本次启动的 DataDirs（路径消费者测试用）。
    pub(crate) fn with_data_dirs(self, dirs: crate::paths::DataDirs) -> Self {
        let _ = self.data_dirs.set(dirs);
        self
    }

    /// 同步构造（AppState 无 async 字段）；未覆盖字段经 build_app_state 与 run()
    /// 同源（P3a：E18 人肉同步退役——AppState 增字段时编译失败点仅 build_app_state）。
    pub(crate) fn build(self) -> AppState {
        let startup = self
            .startup
            .read()
            .expect("startup diagnostics lock")
            .clone();
        let state = crate::build_app_state(crate::AppStateParts {
            runtimes: self.runtimes,
            agents: Arc::into_inner(self.agents)
                .expect("agents Arc must be unique")
                .into_inner()
                .expect("agents lock"),
            active_agent: self.active_agent,
            runtime_logs: crate::runtime_log::RuntimeLogHub::default(),
            prism: self.prism,
            gateway: self.gateway,
            startup,
        });
        // 测试专属字段覆盖（build_app_state 只承载 run() 生产语义的公共部分）：
        *state.approval_mode.lock().expect("approval lock") = self.approval_mode;
        if let Some(service) = self.user_data_service {
            *state
                .user_data_service
                .lock()
                .expect("user data service lock") = Some(service);
        }
        *state.workspaces.lock().expect("workspaces lock") = Arc::into_inner(self.workspaces)
            .expect("workspaces Arc must be unique")
            .into_inner()
            .expect("workspaces lock");
        if let Some(dirs) = self.data_dirs.get() {
            let _ = state.data_dirs.set(dirs.clone());
        }
        state
    }
}

/// 带已连接 ACP 客户端的 state（替代 4 份 build_state_with）：
/// agent 入表（键 = agent.name）+ runtime(acp=initial_acp) 入 runtimes +
/// active_agent=agent.name；其余字段全默认。
/// async 原因：acp 注入需要 tokio Mutex（`runtime.acp`）。
pub(crate) async fn test_state_with_acp(
    agent: AgentDef,
    initial_acp: AcpClient,
    gateway: Arc<GatewayCore>,
    prism: PrismClient,
) -> AppState {
    // P3a（#106）：run() 同一注册入口（幂等）——手工镜像退役。
    crate::install_process_registrations();
    let runtime = AgentRuntime::new_disconnected();
    runtime.install_acp(initial_acp);
    TestStateBuilder::bare()
        .with_agent(agent.clone())
        .with_runtime(agent.name.clone(), runtime)
        .with_active_agent(agent.name)
        .with_gateway(gateway)
        .with_prism(prism)
        .build()
}

/// Connected 状态 runtime（替代 lifecycle.rs:621-625 / 686-689 内联状态赋值）。
pub(crate) fn connected_runtime() -> Arc<AgentRuntime> {
    let runtime = AgentRuntime::new_disconnected();
    *runtime.agent_runtime.lock().unwrap() = crate::agent::runtime::AgentRuntimeState {
        status: crate::agent::runtime::AgentLifecycleStatus::Connected,
        last_error: None,
        last_connected_at: None,
        activated_config_fingerprint: None,
    };
    runtime
}

/// 通用 HTTP 测试桩：绑定随机端口，按序消费响应字节序列。
///
/// 收敛 prism.rs / gateway/qq/send.rs / b10 / b11 等测试中重复的
/// `TcpListener::bind(127.0.0.1:0) → thread::spawn(accept → read → write_all)`
/// 样板。返回 `(socket_addr, 请求字节捕获 channel, 服务线程 join handle)`。
///
/// 语义：
/// - 按 `responses` 顺序每个请求回一个响应；响应耗尽后其余请求收到空响应（测试
///   不应依赖，计数断言用请求 channel）。
/// - 每个已接受连接读到请求头声明（大小写不敏感）的 Content-Length 完整为止
///   （b11 注入请求可达数 KB，截半关连接会夭折客户端请求——历史 b11 桩语义）；
///   头完结但无长度声明则首读即整包（历史 qq 单读语义）。请求字节原文通过
///   `request_rx` 捕获（供断言请求形状），连接数即请求数。
/// - 非阻塞 accept + 5s 整体截止（P91 批 D1 自 b11 自拷桩收敛）：「不应有请求」
///   的负向测试里服务线程到点自退，`join()` 不死锁；accept 出的连接显式切回
///   阻塞模式（Windows 继承监听口非阻塞模式，首读 WouldBlock 会被误判 EOF）。
pub(crate) fn spawn_http_stub(
    responses: &'static [&'static [u8]],
) -> (
    std::net::SocketAddr,
    std::sync::mpsc::Receiver<Vec<u8>>,
    std::thread::JoinHandle<()>,
) {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    listener
        .set_nonblocking(true)
        .expect("nonblocking listener");
    let address = listener.local_addr().expect("listener address");
    let (request_tx, request_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        for response in responses {
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(accepted) => break accepted,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() > deadline {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => return,
                }
            };
            // Windows 上 accept 出的 socket 继承监听口的非阻塞模式——显式切回阻塞，
            // 否则首读 WouldBlock 会被误判为 EOF（请求体丢失、客户端收到空响应）。
            stream.set_nonblocking(false).expect("blocking stream");
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            // 读到请求头声明（大小写不敏感）的 Content-Length 完整为止——b11 注入
            // 请求可达数 KB，截半即关连接会让客户端请求中途夭折（历史 b11 桩语义）；
            // 头完结但无长度声明 → 首读即整包（历史 qq 单读语义）；头未完结则继续读。
            let expected = loop {
                if bytes.len() >= 64 * 1024 {
                    break None;
                }
                if let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&bytes[..headers_end]);
                    let declared = headers.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.trim().eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    });
                    break declared.map(|length| headers_end + 4 + length);
                }
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break None,
                    Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                }
            };
            if let Some(total) = expected {
                while bytes.len() < total {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                    }
                }
            }
            let _ = request_tx.send(bytes);
            let _ = stream.write_all(response);
        }
    });
    (address, request_rx, server)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn builder_bare_defaults_match_run_construction() {
        let state = TestStateBuilder::bare().build();
        assert_eq!(&*state.active_agent.lock().unwrap(), "ghost-agent");
        assert!(state.agents.lock().unwrap().is_empty());
        assert!(state.runtimes.all().is_empty());
        assert_eq!(&*state.approval_mode.lock().unwrap(), "default");
        assert!(state.runtime_mcp.lock().unwrap().is_none());
        assert_eq!(
            state.prism.status().await["status"],
            "configuration_error",
            "默认 prism 必须为 unavailable(\"test\")（与既有测试字面量一致）"
        );
    }

    #[test]
    fn builder_with_chain_registers_agent_runtime_and_overrides() {
        let def = fake_acp_agent_stub("peri");
        let runtime = connected_runtime();
        let gateway = Arc::new(GatewayCore::new());
        let state = TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(def)
            .with_runtime("peri", runtime.clone())
            .with_gateway(gateway.clone())
            .with_approval_mode("auto")
            .build();
        assert_eq!(&*state.active_agent.lock().unwrap(), "peri");
        assert_eq!(&*state.approval_mode.lock().unwrap(), "auto");
        assert!(Arc::ptr_eq(&state.gateway, &gateway));
        assert!(state.agents.lock().unwrap().contains_key("peri"));
        assert!(Arc::ptr_eq(&state.runtimes.get("peri").unwrap(), &runtime));
        assert_eq!(
            state
                .runtimes
                .get("peri")
                .unwrap()
                .agent_runtime
                .lock()
                .unwrap()
                .status,
            crate::agent::runtime::AgentLifecycleStatus::Connected,
            "connected_runtime 必须置 Connected"
        );
    }

    #[tokio::test]
    async fn test_state_with_acp_injects_client_and_sets_active() {
        let agent = fake_acp_agent_stub("fake-acp");
        let initial_acp = AcpClient::disconnected();
        initial_acp
            .crashed
            .store(true, std::sync::atomic::Ordering::Release);
        let gateway = Arc::new(GatewayCore::new());
        let state = test_state_with_acp(
            agent.clone(),
            initial_acp,
            gateway.clone(),
            PrismClient::unavailable("test".to_string()),
        )
        .await;
        assert_eq!(&*state.active_agent.lock().unwrap(), "fake-acp");
        assert!(state.agents.lock().unwrap().contains_key("fake-acp"));
        assert!(Arc::ptr_eq(&state.gateway, &gateway));
        let runtime = state.runtimes.get("fake-acp").expect("runtime 必须注册");
        assert!(
            runtime.snapshot_acp().is_crashed(),
            "注入的 AcpClient 必须挂在 runtime.acp 上（新建 disconnected 默认未崩溃）"
        );
    }

    /// P3a（#106）：单一构造点证明——TestStateBuilder::build() 与 run() 生产装配
    /// 同源（build_app_state），测试默认值不再人肉同步（E18 退役回归锁）。
    #[tokio::test]
    async fn build_app_state_single_construction_point_defaults() {
        let state = TestStateBuilder::bare().build();
        assert_eq!(&*state.active_agent.lock().unwrap(), "ghost-agent");
        assert_eq!(&*state.approval_mode.lock().unwrap(), "default");
        assert!(state.runtime_mcp.lock().unwrap().is_none());
        assert!(state.event_service.lock().unwrap().is_none());
        assert!(state.data_dirs.get().is_none());
        assert_eq!(
            state.prism.status().await["status"],
            "configuration_error",
            "默认 prism 必须为 unavailable（与 run() 无配置路径一致）"
        );
    }

    /// P3a（#106）：install_process_registrations 幂等——重复调用不 panic，
    /// 协议适配器仍可按 provider 解析（run() 与测试装配共用的前提）。
    #[test]
    fn install_process_registrations_is_idempotent() {
        crate::install_process_registrations();
        crate::install_process_registrations();
        assert!(
            crate::protocol_adapter::get_protocol_adapter("peri").is_some(),
            "peri adapter must resolve after install"
        );
        assert!(
            crate::protocol_adapter::get_protocol_adapter("hermes").is_some(),
            "hermes adapter must resolve after install"
        );
    }
}
