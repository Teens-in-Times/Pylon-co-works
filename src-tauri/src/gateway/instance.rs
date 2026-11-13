//! Adapter Instance：Bot 实例身份层（I12-A-BE-01 契约冻结；D-01 实例 identity）。
//!
//! 实例以稳定 instanceId 为主键（route 引用它；不以 platform key 代替实例身份）。
//! 凭据只暴露 credentialRef + 脱敏状态（D-02）：wire DTO 无任何凭据值字段，
//! 内部态经 [`InstanceState::to_dto`] 映射时 secret 一律丢弃。
//! [`InstanceState`] 有意不实现 Serialize——杜绝内部凭据值误序列化的路径。

/// 实例状态机（BE-02 生命周期收敛的目标态；本卡只冻结契约与 wire 形状）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstanceStatus {
    /// 已创建未启动 / 已停止。
    Stopped,
    /// 启动中（连接未就绪）。
    Starting,
    /// 已连接（可 ingest/deliver）。
    Connected,
    /// 启动/运行错误（last_error 携带结构化原因）。
    Error,
}

/// 凭据脱敏状态（secret 不回传；前端只看到是否配置/缺失/错误）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStatus {
    /// 未配置（创建后未填凭据）。
    Missing,
    /// 已配置（凭据引用有效）。
    Configured,
    /// 凭据存在但校验失败/损坏。
    #[allow(dead_code)] // 校验失败态由诊断流消费
    Invalid,
}

/// Adapter Instance DTO（只读 wire 快照；无凭据值字段）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInstance {
    /// 稳定主键（route 引用它）。
    pub id: String,
    /// 所属平台 key（catalog.platform）。
    pub platform: String,
    /// 用户展示名。
    pub label: String,
    pub enabled: bool,
    /// D-06：独立 autoStart（仅应用重启后的自动启动策略；手动启停不受影响）。
    pub auto_start: bool,
    pub status: InstanceStatus,
    /// status=Error 时的结构化原因（不得包含 secret）。
    pub last_error: Option<String>,
    pub credential_status: CredentialStatus,
    /// 凭据引用 id（指向加密凭据文件；D-02）。缺失 = null。
    pub credential_ref: Option<String>,
}

/// 内部实例状态（BE-02 生命周期将维护真实实例；本卡冻结 DTO 映射规则）。
/// 内部态允许持有凭据值；映射为 wire DTO 时只保留 credential_ref + credential_status，
/// secret 一律不携带（D-02 冻结）。**本类型刻意不实现 Serialize**——内部凭据值
/// 不可能经本类型直接序列化（编译期即排除泄露路径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceState {
    pub id: String,
    pub platform: String,
    pub label: String,
    pub enabled: bool,
    pub auto_start: bool,
    pub status: InstanceStatus,
    pub last_error: Option<String>,
    pub credential_ref: Option<String>,
    pub credential_status: CredentialStatus,
    /// 内部凭据值（secret）——仅内部持有，[`Self::to_dto`] 丢弃。
    pub credential_secret: Option<String>,
}

impl InstanceState {
    /// 内部态 → 只读 DTO：secret 永不进入 wire（D-02 冻结）。
    pub fn to_dto(&self) -> AdapterInstance {
        AdapterInstance {
            id: self.id.clone(),
            platform: self.platform.clone(),
            label: self.label.clone(),
            enabled: self.enabled,
            auto_start: self.auto_start,
            status: self.status,
            last_error: self.last_error.clone(),
            credential_ref: self.credential_ref.clone(),
            credential_status: self.credential_status,
        }
    }
}

// ============================================================================
// I12-W1：instance registry 与状态机（纯业务层；不接 command/UI）。
// 参考 ISSUE-12 方案 A：GatewayInstanceService + factory registry + generation
// guard + lifecycle_lock 串行化状态迁移。
// 状态权威是内部 [`InstanceLifecycle`]（含 Stopping 中间态）；wire 4 态契约
// （[`InstanceStatus`]）经 [`InstanceLifecycle::to_wire`] 折叠，前端不变。
// 凭据校验委托给 [`AdapterFactory`]（W2/W3 接线真实凭据存储）；service 层
// 不预检凭据，避免 W1 无凭据存储时状态机不可测。
// ============================================================================

use pylon_foundations::await_guard::HeldAcrossAwait;
use std::collections::HashMap;
use std::sync::{Arc, RwLock as StdRwLock};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, RwLock as AsyncRwLock};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::instance_store::StoredInstance;
use super::PlatformAdapter;

/// 后台运行 future（平台连接循环）。由服务端 spawn 并 await；收到 cancel 后
/// 应尽快收敛退出。W1 由测试 fake 提供；W2 由 QQ factory 提供。
pub(crate) type BoxRunFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'static>>;

/// 结构化错误（I12 命令契约错误码；`adapter_unavailable` 为 W1 扩展——
/// registry 尚无 factory 注册时 start 必须显式报错，不能静默）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GatewayInstanceError {
    #[error("adapter instance 不存在: {0}")]
    NotFound(String),
    #[error("非法状态迁移: {0}")]
    InvalidTransition(String),
    #[error("凭据缺失: {0}")]
    CredentialMissing(String),
    #[error("route 正在使用该 instance: {0}")]
    RouteInUse(String),
    #[error("adapter factory 不可用: {0}")]
    AdapterUnavailable(String),
    /// I12-W4：实例配置持久化失败（mutation 已生效于内存，但未落盘——重启会丢，
    /// 必须如实报错可见，不得静默）。
    #[error("实例配置持久化失败: {0}")]
    Store(String),
    /// I12-W5：凭据存储错误（读/写/解密失败；消息含内部 code，如 credential_io）。
    #[error("凭据存储错误: {0}")]
    Credentials(String),
}

impl GatewayInstanceError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "instance_not_found",
            Self::InvalidTransition(_) => "invalid_transition",
            Self::CredentialMissing(_) => "credential_missing",
            Self::RouteInUse(_) => "route_in_use",
            Self::AdapterUnavailable(_) => "adapter_unavailable",
            Self::Store(_) => "instance_store_write_failed",
            Self::Credentials(_) => "credential_store_error",
        }
    }
}

// B1.2：结构化错误 wire `{ code, message }`（typed IPC——Tauri command 直接返回
// `Result<T, GatewayInstanceError>`，前端按 code 分支，message 仅展示）。
// 与 MessageError/UserDataError 同形（#317 批次二：实现单源化到共享宏）。
crate::error::impl_wire_code_message_serialize!(GatewayInstanceError);

/// 内部生命周期状态机：在 wire [`InstanceStatus`]（4 态）之上补充 `Stopping`
/// 中间态。wire 由 [`Self::to_wire`] 折叠（Stopping → Stopped），前端契约不变。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstanceLifecycle {
    Stopped,
    Starting,
    Connected,
    Error,
    /// 停止中（stop 已受理、后台 task 收敛中）；wire 折叠为 Stopped。
    Stopping,
}

impl InstanceLifecycle {
    fn to_wire(self) -> InstanceStatus {
        match self {
            Self::Stopped | Self::Stopping => InstanceStatus::Stopped,
            Self::Starting => InstanceStatus::Starting,
            Self::Connected => InstanceStatus::Connected,
            Self::Error => InstanceStatus::Error,
        }
    }
}

/// 运行期句柄：adapter（W4 route 分发用）+ cancel（stop/restart/remove 触发）
/// + 后台任务（平台连接循环 + 退出收敛 watchdog）。
pub(crate) struct InstanceRuntime {
    /// W4 route 分发经它 deliver；stop/finalize 摘注册（`notify_adapter_registry`）也用它。
    pub(crate) adapter: Arc<dyn PlatformAdapter>,
    pub(crate) cancel: CancellationToken,
    /// 暂无消费点：stop 收敛现依赖 cancel + generation 校验的 finalize（见
    /// `stop`/`finalize_runtime`），不经 join；JoinHandle drop 仅 detach 不取消任务，
    /// 字段保留给未来带超时的 stop 收敛（await join）。
    #[allow(dead_code)] // 预留：带超时的 stop 收敛（await join）落地时摘除
    pub(crate) join: JoinHandle<()>,
}

/// registry 内的被管实例：冻结身份态 + 生命周期 + generation + 运行句柄。
pub(crate) struct ManagedInstance {
    state: InstanceState,
    lifecycle: InstanceLifecycle,
    /// 每次 start 递增；后台 task 退出写状态前校验，防旧 task 覆盖新实例。
    generation: u64,
    runtime: Option<InstanceRuntime>,
}

impl ManagedInstance {
    fn dto(&self) -> AdapterInstance {
        self.state.to_dto()
    }

    /// 唯一状态写入口：lifecycle 与 state.status 同步折叠（Stopping → wire Stopped）。
    fn set_lifecycle(&mut self, lifecycle: InstanceLifecycle) {
        self.lifecycle = lifecycle;
        self.state.status = lifecycle.to_wire();
    }
}

/// 运行任务 → 服务 的状态上报句柄（连接就绪/运行期错误）。
/// W2 的 QQ 连接循环经它通知 Connected/Error；W1 fake 手动触发验证状态机。
#[derive(Clone)]
pub(crate) struct InstanceNotifier {
    service: GatewayInstanceService,
    id: String,
    generation: u64,
}

impl InstanceNotifier {
    /// 连接就绪 → Connected（仅当 generation 仍有效时生效）。
    pub(crate) async fn connected(&self) {
        self.service.mark_connected(&self.id, self.generation).await;
    }

    /// 运行期结构化错误 → Error（仅当 generation 仍有效时生效）。
    pub(crate) async fn failed(&self, message: String) {
        self.service
            .mark_failed(&self.id, self.generation, message)
            .await;
    }
}

/// 平台 adapter factory：W2 起由各平台实现（QQ factory 接真实连接循环）；
/// W1 以测试 fake 驱动状态机。凭据校验委托给 factory（W3 接线凭据存储）。
pub(crate) trait AdapterFactory: Send + Sync {
    fn platform_key(&self) -> &str;
    /// 依据实例状态构造运行期 (adapter, 连接循环 future)。
    /// Err 由调用方原样透出为结构化错误（如 CredentialMissing）。
    fn create(
        &self,
        state: &InstanceState,
        cancel: CancellationToken,
        notifier: InstanceNotifier,
    ) -> Result<(Arc<dyn PlatformAdapter>, BoxRunFuture), GatewayInstanceError>;
}

/// route 占用检查：给定 instance id 返回是否已被 route 绑定。
/// W4 接线真实 route 查找；W1 默认为 None（无 route 层 → 视为未占用）。
pub(crate) type RouteGuard = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// 创建入参（身份字段不可变；wire camelCase——autoStart）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateInstanceInput {
    pub(crate) id: String,
    pub(crate) platform: String,
    pub(crate) label: String,
    pub(crate) enabled: bool,
    pub(crate) auto_start: bool,
}

/// 更新入参（仅可改展示/策略字段；id/platform/凭据不可经此变更；wire camelCase）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInstanceInput {
    pub(crate) label: Option<String>,
    pub(crate) enabled: Option<bool>,
    pub(crate) auto_start: Option<bool>,
}

/// instance registry 与状态机（I12-W1）。
/// 内部状态全部 Arc 化，服务本身 Clone——后台 watchdog/notifier 可持有句柄。
#[derive(Clone)]
pub(crate) struct GatewayInstanceService {
    registry: Arc<AsyncRwLock<HashMap<String, ManagedInstance>>>,
    factories: Arc<StdRwLock<HashMap<String, Arc<dyn AdapterFactory>>>>,
    lifecycle_lock: Arc<AsyncMutex<()>>,
    route_guard: Arc<StdRwLock<Option<RouteGuard>>>,
    /// I12-W5：凭据解析器（platform, instance_id → 凭据明文）。命令/启动接线——
    /// start_impl 在 factory.create 前解析 secret 填入 state；None = 未配置。
    credential_resolver: Arc<StdRwLock<Option<CredentialResolver>>>,
    /// P78：适配器注册表挂钩——start 成功 → (platform, adapter, true) 注册进
    /// GatewayCore（出站 deliver_all 按 source 前缀查注册表）；stop/finalize 清
    /// runtime → (platform, adapter, false) 注销（ptr_eq 所有权判定，只摘自己）。
    /// 未接线 = 实例适配器不进 GatewayCore（入站仍通，出站被丢）。
    adapter_registry: Arc<StdRwLock<Option<AdapterRegistryHook>>>,
}

/// 适配器注册表挂钩：register=true 注册（可覆盖 legacy env 注册），false 注销。
/// adapter 一律传运行句柄里的 Arc——注销侧据此做 ptr_eq 所有权判定。
pub(crate) type AdapterRegistryHook =
    Arc<dyn Fn(&str, &Arc<dyn PlatformAdapter>, bool) + Send + Sync>;

/// 凭据解析器：给定 (platform, instance_id) 返回凭据明文（None = 未配置）。
pub(crate) type CredentialResolver = Arc<dyn Fn(&str, &str) -> Option<String> + Send + Sync>;

impl Default for GatewayInstanceService {
    fn default() -> Self {
        Self::new()
    }
}

impl GatewayInstanceService {
    pub(crate) fn new() -> Self {
        Self {
            registry: Arc::new(AsyncRwLock::new(HashMap::new())),
            factories: Arc::new(StdRwLock::new(HashMap::new())),
            lifecycle_lock: Arc::new(AsyncMutex::new(())),
            route_guard: Arc::new(StdRwLock::new(None)),
            credential_resolver: Arc::new(StdRwLock::new(None)),
            adapter_registry: Arc::new(StdRwLock::new(None)),
        }
    }

    pub(crate) fn register_factory(&self, factory: Arc<dyn AdapterFactory>) {
        if let Ok(mut slot) = self.factories.write() {
            slot.insert(factory.platform_key().to_string(), factory);
        }
    }

    pub(crate) fn set_route_guard(&self, guard: RouteGuard) {
        if let Ok(mut slot) = self.route_guard.write() {
            *slot = Some(guard);
        }
    }

    /// I12-W5：接线凭据解析器（set_credentials 命令/启动时注册）。
    pub(crate) fn set_credential_resolver(&self, resolver: CredentialResolver) {
        if let Ok(mut slot) = self.credential_resolver.write() {
            *slot = Some(resolver);
        }
    }

    /// P78：接线适配器注册表挂钩（lib.rs setup 注入，桥接 GatewayCore 注册表）。
    pub(crate) fn set_adapter_registry(&self, hook: AdapterRegistryHook) {
        if let Ok(mut slot) = self.adapter_registry.write() {
            *slot = Some(hook);
        }
    }

    fn notify_adapter_registry(
        &self,
        platform: &str,
        adapter: &Arc<dyn PlatformAdapter>,
        register: bool,
    ) {
        if let Ok(slot) = self.adapter_registry.read() {
            if let Some(hook) = slot.as_ref() {
                hook(platform, adapter, register);
            }
        }
    }

    /// I12-W5：更新实例凭据状态（set_credentials 命令落盘后调用）。
    pub(crate) async fn set_credential_state(
        &self,
        id: &str,
        status: CredentialStatus,
    ) -> Result<(), GatewayInstanceError> {
        let mut registry = self.registry.write().await;
        let managed = registry
            .get_mut(id)
            .ok_or_else(|| GatewayInstanceError::NotFound(id.to_string()))?;
        managed.state.credential_status = status;
        managed.state.credential_ref = Some(format!("cred-{id}"));
        Ok(())
    }

    /// I12-W5：启动恢复——按凭据解析器刷新各实例 credential_ref/status（重启后
    /// credential_ref 不丢；secret 不载入内存，仅标记 Configured）。
    pub(crate) async fn refresh_credential_states(&self, resolve: impl Fn(&str, &str) -> bool) {
        let mut registry = self.registry.write().await;
        for managed in registry.values_mut() {
            if resolve(&managed.state.platform, &managed.state.id) {
                managed.state.credential_ref = Some(format!("cred-{}", managed.state.id));
                managed.state.credential_status = CredentialStatus::Configured;
            } else {
                managed.state.credential_ref = None;
                managed.state.credential_status = CredentialStatus::Missing;
            }
        }
    }

    pub(crate) async fn get(&self, id: &str) -> Result<AdapterInstance, GatewayInstanceError> {
        let registry = self.registry.read().await;
        registry
            .get(id)
            .map(ManagedInstance::dto)
            .ok_or_else(|| GatewayInstanceError::NotFound(id.to_string()))
    }

    pub(crate) async fn list(&self) -> Vec<AdapterInstance> {
        let registry = self.registry.read().await;
        let mut instances: Vec<AdapterInstance> =
            registry.values().map(ManagedInstance::dto).collect();
        instances.sort_by(|a, b| a.id.cmp(&b.id));
        instances
    }

    /// 只读查询实例 wire 状态（route→instance 解析用；None = 实例不存在）。
    pub(crate) async fn status_of(&self, id: &str) -> Option<InstanceStatus> {
        let registry = self.registry.read().await;
        registry.get(id).map(|managed| managed.state.status)
    }

    /// I12-W4 启动恢复：从持久化配置批量创建实例（幂等——同 id 已存在则跳过，
    /// 不覆盖现有/手动创建；同 id 不同 platform 的陈旧 store 条目同样跳过）。
    /// 统一置 Stopped——旧 Connected 状态不直接恢复；`enabled && autoStart` 的
    /// 启动由调用方（setup）按策略显式触发。
    pub(crate) async fn load_instances(&self, instances: Vec<StoredInstance>) {
        let mut registry = self.registry.write().await;
        for input in instances {
            if registry.contains_key(&input.id) {
                continue;
            }
            let state = InstanceState {
                id: input.id,
                platform: input.platform,
                label: input.label,
                enabled: input.enabled,
                auto_start: input.auto_start,
                status: InstanceStatus::Stopped,
                last_error: None,
                credential_ref: None,
                credential_status: CredentialStatus::Missing,
                credential_secret: None,
            };
            registry.insert(
                state.id.clone(),
                ManagedInstance {
                    state,
                    lifecycle: InstanceLifecycle::Stopped,
                    generation: 0,
                    runtime: None,
                },
            );
        }
    }

    /// I12-W4 启动恢复的自动启动策略（AC2）：仅 `enabled && autoStart` 的实例显式启动；
    /// 单实例失败可见（tracing::error）且不阻断其余实例（D-06：autoStart 仅重启后生效，
    /// 手动启停不受影响）。
    pub(crate) async fn auto_start_instances(&self) {
        for dto in self.list().await {
            if dto.enabled && dto.auto_start {
                let service = self.clone();
                let id = dto.id;
                tokio::spawn(async move {
                    match service.start(&id).await {
                        Ok(_) => tracing::info!("gateway 实例 {id} 已自动启动"),
                        Err(error) => tracing::error!(
                            "gateway 实例 {id} 自动启动失败（可见，不静默）：{error}"
                        ),
                    }
                });
            }
        }
    }

    /// create：同 id 同 platform 重放幂等（返回现有）；同 id 不同 platform 拒绝。
    pub(crate) async fn create(
        &self,
        input: CreateInstanceInput,
    ) -> Result<AdapterInstance, GatewayInstanceError> {
        let mut registry = self.registry.write().await;
        if let Some(existing) = registry.get(&input.id) {
            if existing.state.platform == input.platform {
                return Ok(existing.dto());
            }
            return Err(GatewayInstanceError::InvalidTransition(format!(
                "instance id '{}' 已被 platform '{}' 占用，无法以 '{}' 创建",
                input.id, existing.state.platform, input.platform
            )));
        }
        let state = InstanceState {
            id: input.id,
            platform: input.platform,
            label: input.label,
            enabled: input.enabled,
            auto_start: input.auto_start,
            status: InstanceStatus::Stopped,
            last_error: None,
            credential_ref: None,
            credential_status: CredentialStatus::Missing,
            credential_secret: None,
        };
        let managed = ManagedInstance {
            state,
            lifecycle: InstanceLifecycle::Stopped,
            generation: 0,
            runtime: None,
        };
        let dto = managed.dto();
        registry.insert(dto.id.clone(), managed);
        Ok(dto)
    }

    /// update：仅改 label/enabled/auto_start；任意状态可用（不影响生命周期）。
    pub(crate) async fn update(
        &self,
        id: &str,
        input: UpdateInstanceInput,
    ) -> Result<AdapterInstance, GatewayInstanceError> {
        let mut registry = self.registry.write().await;
        let managed = registry
            .get_mut(id)
            .ok_or_else(|| GatewayInstanceError::NotFound(id.to_string()))?;
        if let Some(label) = input.label {
            managed.state.label = label;
        }
        if let Some(enabled) = input.enabled {
            managed.state.enabled = enabled;
        }
        if let Some(auto_start) = input.auto_start {
            managed.state.auto_start = auto_start;
        }
        Ok(managed.dto())
    }

    /// remove：route 占用 → route_in_use；运行中（Starting/Connected/Stopping）
    /// → invalid_transition（须先 stop）；Stopped/Error 直接移除（残余 runtime 取消）。
    // lifecycle_lock 跨 await：实例生命周期迁移必须整体串行
    pub(crate) async fn remove(&self, id: &str) -> Result<(), GatewayInstanceError> {
        let _guard = HeldAcrossAwait::new(self.lifecycle_lock.lock().await);
        let in_use = self
            .route_guard
            .read()
            .map(|guard| guard.as_ref().is_some_and(|guard| guard(id)))
            .unwrap_or(false);
        if in_use {
            return Err(GatewayInstanceError::RouteInUse(id.to_string()));
        }
        let mut registry = self.registry.write().await;
        let managed = registry
            .get_mut(id)
            .ok_or_else(|| GatewayInstanceError::NotFound(id.to_string()))?;
        match managed.lifecycle {
            InstanceLifecycle::Stopped | InstanceLifecycle::Error => {
                if let Some(runtime) = managed.runtime.take() {
                    runtime.cancel.cancel();
                }
                registry.remove(id);
                Ok(())
            }
            _ => Err(GatewayInstanceError::InvalidTransition(
                "运行中的 instance 必须先 stop 再 remove".to_string(),
            )),
        }
    }

    /// start：Starting/Connected 幂等返回；Stopping 拒绝；Stopped/Error 启动新任务。
    // lifecycle_lock 跨 await：start 序列整体串行
    pub(crate) async fn start(&self, id: &str) -> Result<AdapterInstance, GatewayInstanceError> {
        let _guard = HeldAcrossAwait::new(self.lifecycle_lock.lock().await);
        self.start_impl(id, false).await
    }

    /// restart：Stopped/Connected/Error 重启（取消旧 runtime、递增 generation）；
    /// Starting/Stopping 拒绝。
    // lifecycle_lock 跨 await：restart 序列整体串行
    pub(crate) async fn restart(&self, id: &str) -> Result<AdapterInstance, GatewayInstanceError> {
        let _guard = HeldAcrossAwait::new(self.lifecycle_lock.lock().await);
        self.start_impl(id, true).await
    }

    async fn start_impl(
        &self,
        id: &str,
        restart: bool,
    ) -> Result<AdapterInstance, GatewayInstanceError> {
        // Phase 1：校验 + 预置 Starting + generation 预递增（写锁内原子完成，
        // 防旧 task 在新任务构造窗口内写状态）。
        let (state, generation, prior, had_runtime) = {
            let mut registry = self.registry.write().await;
            let managed = registry
                .get_mut(id)
                .ok_or_else(|| GatewayInstanceError::NotFound(id.to_string()))?;
            let mut had_runtime = false;
            match managed.lifecycle {
                InstanceLifecycle::Starting => {
                    if restart {
                        return Err(GatewayInstanceError::InvalidTransition(
                            "instance 正在启动中，无法 restart".to_string(),
                        ));
                    }
                    // 重复 start 幂等：不重复 spawn task
                    return Ok(managed.dto());
                }
                InstanceLifecycle::Connected => {
                    if restart {
                        if let Some(runtime) = managed.runtime.take() {
                            runtime.cancel.cancel();
                            had_runtime = true;
                        }
                    } else {
                        // 重复 start 幂等：不重复 spawn task
                        return Ok(managed.dto());
                    }
                }
                InstanceLifecycle::Stopping => {
                    return Err(GatewayInstanceError::InvalidTransition(
                        "instance 正在停止中，无法启动/重启".to_string(),
                    ));
                }
                InstanceLifecycle::Stopped | InstanceLifecycle::Error => {
                    // Error 可能仍挂着未退出 task（mark_failed 保留 runtime）：
                    // start/restart 一律先取消清残留，防旧 task 继续存活。
                    if let Some(runtime) = managed.runtime.take() {
                        runtime.cancel.cancel();
                        had_runtime = true;
                    }
                }
            }
            let prior = managed.lifecycle;
            let generation = managed.generation + 1;
            managed.generation = generation;
            managed.set_lifecycle(InstanceLifecycle::Starting);
            (managed.state.clone(), generation, prior, had_runtime)
        };
        // Phase 2：解析凭据（I12-W5——凭据解析器接线后，start 前把 secret 填入 state，
        // factory.create 据此校验；未配置 → None，factory 报 CredentialMissing）。
        let mut state = state;
        if state.credential_secret.is_none() {
            if let Some(resolver) = self
                .credential_resolver
                .read()
                .ok()
                .and_then(|slot| slot.clone())
            {
                state.credential_secret = resolver(&state.platform, &state.id);
            }
        }
        // Phase 2：解析 factory + 构造运行句柄（锁外；凭据校验由 factory 承担）。
        let factory = self
            .factories
            .read()
            .map(|slot| slot.get(&state.platform).cloned())
            .ok()
            .flatten();
        let Some(factory) = factory else {
            self.rollback_start(
                id,
                prior,
                had_runtime,
                format!("adapter factory 未注册: {}", state.platform),
            )
            .await;
            return Err(GatewayInstanceError::AdapterUnavailable(state.platform));
        };
        let cancel = CancellationToken::new();
        let notifier = InstanceNotifier {
            service: self.clone(),
            id: id.to_string(),
            generation,
        };
        let (adapter, run) = match factory.create(&state, cancel.clone(), notifier) {
            Ok(pair) => pair,
            Err(error) => {
                self.rollback_start(id, prior, had_runtime, error.to_string())
                    .await;
                return Err(error);
            }
        };
        // Phase 3：spawn watchdog（run → finalize，带 generation guard）+ 登记 runtime。
        let service = self.clone();
        let id_owned = id.to_string();
        let join = tokio::spawn(async move {
            let outcome = run.await;
            service
                .finalize_runtime(id_owned, generation, outcome)
                .await;
        });
        {
            let mut registry = self.registry.write().await;
            let managed = registry
                .get_mut(id)
                .ok_or_else(|| GatewayInstanceError::NotFound(id.to_string()))?;
            // lifecycle_lock 串行化迁移，此处 generation/lifecycle 必与预置一致
            //（防御性校验，防未来并发路径回归）。
            if managed.generation == generation && managed.lifecycle == InstanceLifecycle::Starting
            {
                managed.state.last_error = None;
                managed.runtime = Some(InstanceRuntime {
                    adapter: adapter.clone(),
                    cancel,
                    join,
                });
            }
            let dto = managed.dto();
            // P78：登记成功即注册进 GatewayCore 适配器注册表（出站 deliver_all
            // 按 source 前缀路由依赖注册表；hook 只碰 core 锁，registry 写锁内
            // 调用无锁序风险）。restart 代际替换时 replace 语义覆盖旧注册。
            self.notify_adapter_registry(&state.platform, &adapter, true);
            Ok(dto)
        }
    }

    /// start 前置失败回滚：restart 已取消旧连接 → 诚实落 Stopped 并保留原因；
    /// 未触碰旧运行态 → 恢复原状。
    async fn rollback_start(
        &self,
        id: &str,
        prior: InstanceLifecycle,
        had_runtime: bool,
        message: String,
    ) {
        let mut registry = self.registry.write().await;
        let Some(managed) = registry.get_mut(id) else {
            return;
        };
        if managed.lifecycle != InstanceLifecycle::Starting {
            return;
        }
        // I12-W4（CR-002）：fresh start 的前置失败（factory create Err，如凭据缺失/
        // adapter 不可用）同样记录 last_error——auto-start 是后台任务，调用方只看到
        // 日志；实例状态必须携带失败原因才"可见"（UI 实例卡片可呈现）。
        if had_runtime {
            managed.state.last_error = Some(message);
            managed.set_lifecycle(InstanceLifecycle::Stopped);
        } else {
            managed.state.last_error = Some(message);
            managed.set_lifecycle(prior);
        }
    }

    /// stop：Stopped/Stopping 幂等返回；其余状态取消 runtime 后落 Stopped。
    /// W1 不 await join（收敛验证属 W2）；后台 task 退出经 finalize 清理，
    /// generation guard 防旧覆盖。
    // lifecycle_lock 跨 await：stop 序列整体串行
    pub(crate) async fn stop(&self, id: &str) -> Result<AdapterInstance, GatewayInstanceError> {
        let _guard = HeldAcrossAwait::new(self.lifecycle_lock.lock().await);
        let mut registry = self.registry.write().await;
        let managed = registry
            .get_mut(id)
            .ok_or_else(|| GatewayInstanceError::NotFound(id.to_string()))?;
        match managed.lifecycle {
            InstanceLifecycle::Stopped | InstanceLifecycle::Stopping => Ok(managed.dto()),
            InstanceLifecycle::Starting
            | InstanceLifecycle::Connected
            | InstanceLifecycle::Error => {
                if let Some(runtime) = managed.runtime.take() {
                    runtime.cancel.cancel();
                    // P78：stop 在此摘 GatewayCore 注册（finalize 时 runtime 已被
                    // 本处取走；ptr_eq 判定只摘自己，不影响并存的其他注册）。
                    let platform = managed.state.platform.clone();
                    self.notify_adapter_registry(&platform, &runtime.adapter, false);
                }
                // Stopping 是瞬态：锁内即收敛为 Stopped（wire 折叠 Stopping→Stopped）。
                managed.set_lifecycle(InstanceLifecycle::Stopping);
                managed.set_lifecycle(InstanceLifecycle::Stopped);
                Ok(managed.dto())
            }
        }
    }

    /// 后台 task 退出收敛：仅当 generation 仍有效时写状态，防旧 task 覆盖。
    async fn finalize_runtime(&self, id: String, generation: u64, outcome: Result<(), String>) {
        let mut registry = self.registry.write().await;
        let Some(managed) = registry.get_mut(&id) else {
            return;
        };
        if managed.generation != generation {
            return;
        }
        // P78：runtime 清理时摘掉 GatewayCore 注册（ptr_eq 判定只摘自己那份，
        // 代际替换后旧 task finalize 不会拔掉新 adapter 的注册）。
        let retiring = managed.runtime.take();
        let platform = managed.state.platform.clone();
        match managed.lifecycle {
            // 主动 stop/remove 后残响：状态已收敛，仅清 runtime
            InstanceLifecycle::Stopped | InstanceLifecycle::Stopping => {}
            InstanceLifecycle::Starting | InstanceLifecycle::Connected => match outcome {
                Ok(()) => {
                    managed.set_lifecycle(InstanceLifecycle::Stopped);
                }
                Err(message) => {
                    managed.state.last_error = Some(message);
                    managed.set_lifecycle(InstanceLifecycle::Error);
                }
            },
            InstanceLifecycle::Error => {
                // 已 Error（mark_failed 等）；task 退出仅清 runtime
            }
        }
        drop(registry);
        if let Some(runtime) = retiring {
            self.notify_adapter_registry(&platform, &runtime.adapter, false);
        }
    }

    /// 连接就绪上报（W2 QQ ws ready；W1 fake 手动触发）。旧 generation 忽略。
    pub(crate) async fn mark_connected(&self, id: &str, generation: u64) {
        let mut registry = self.registry.write().await;
        let Some(managed) = registry.get_mut(id) else {
            return;
        };
        if managed.generation != generation {
            return;
        }
        if managed.lifecycle == InstanceLifecycle::Starting {
            managed.set_lifecycle(InstanceLifecycle::Connected);
        }
    }

    /// 运行期错误上报。旧 generation 忽略；Error 保留 runtime（task 可能存活）。
    pub(crate) async fn mark_failed(&self, id: &str, generation: u64, message: String) {
        let mut registry = self.registry.write().await;
        let Some(managed) = registry.get_mut(id) else {
            return;
        };
        if managed.generation != generation {
            return;
        }
        if matches!(
            managed.lifecycle,
            InstanceLifecycle::Starting | InstanceLifecycle::Connected
        ) {
            managed.state.last_error = Some(message);
            managed.set_lifecycle(InstanceLifecycle::Error);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn sample_state() -> InstanceState {
        InstanceState {
            id: "qq-bot-1".into(),
            platform: "qq".into(),
            label: "主 QQ Bot".into(),
            enabled: true,
            auto_start: true,
            status: InstanceStatus::Connected,
            last_error: None,
            credential_ref: Some("cred-qq-bot-1".into()),
            credential_status: CredentialStatus::Configured,
            credential_secret: Some("sk-super-secret".into()),
        }
    }

    #[test]
    fn instance_dto_wire_shape_pinned_no_secret_fields() {
        let dto = sample_state().to_dto();
        let value = serde_json::to_value(&dto).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "id": "qq-bot-1",
                "platform": "qq",
                "label": "主 QQ Bot",
                "enabled": true,
                "autoStart": true,
                "status": "connected",
                "lastError": null,
                "credentialStatus": "configured",
                "credentialRef": "cred-qq-bot-1",
            }),
            "instance wire 形状必须固定（camelCase，无凭据值字段）: {value}"
        );
    }

    #[test]
    fn to_dto_drops_credential_secret_never_serialized() {
        // D-02：内部 secret 值经 to_dto 映射后必须消失；只留 credentialRef + credentialStatus
        let dto = sample_state().to_dto();
        let text = serde_json::to_string(&dto).unwrap();
        assert!(
            !text.contains("sk-super-secret"),
            "secret 不得序列化回前端: {text}"
        );
        assert_eq!(dto.credential_ref.as_deref(), Some("cred-qq-bot-1"));
        assert_eq!(dto.credential_status, CredentialStatus::Configured);
    }

    #[test]
    fn status_enums_serialize_stable_wire_values() {
        for (status, wire) in [
            (InstanceStatus::Stopped, "stopped"),
            (InstanceStatus::Starting, "starting"),
            (InstanceStatus::Connected, "connected"),
            (InstanceStatus::Error, "error"),
        ] {
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                serde_json::json!(wire)
            );
        }
        for (status, wire) in [
            (CredentialStatus::Missing, "missing"),
            (CredentialStatus::Configured, "configured"),
            (CredentialStatus::Invalid, "invalid"),
        ] {
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                serde_json::json!(wire)
            );
        }
    }

    #[test]
    fn error_status_carries_structured_last_error_without_secret() {
        let mut state = sample_state();
        state.status = InstanceStatus::Error;
        state.last_error = Some("连接超时（认证失败）".into());
        let dto = state.to_dto();
        let value = serde_json::to_value(&dto).unwrap();
        assert_eq!(value["status"], "error");
        assert_eq!(value["lastError"], "连接超时（认证失败）");
        let text = serde_json::to_string(&dto).unwrap();
        assert!(
            !text.contains("sk-super-secret"),
            "错误状态下 secret 同样不得泄露"
        );
    }

    // ---- I12-W1：registry 与状态机（纯业务层并发/幂等测试） ----

    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::gateway::PlatformAdapter;

    pub(crate) struct StubAdapter {
        pub(crate) platform: &'static str,
    }

    impl PlatformAdapter for StubAdapter {
        fn platform_key(&self) -> &str {
            self.platform
        }
        fn max_message_len(&self) -> usize {
            100
        }
        fn deliver_text(&self, _source: &str, _text: &str) -> Result<(), String> {
            Ok(())
        }
        fn deliver_event(
            &self,
            _source: &str,
            _event: &str,
            _payload: &serde_json::Value,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    /// 测试工厂的创建闭包签名（把 `AdapterFactory::create` 的三参形态装箱为可共享闭包）。
    type FakeCreateFn = dyn Fn(
            &InstanceState,
            CancellationToken,
            InstanceNotifier,
        ) -> Result<(Arc<dyn PlatformAdapter>, BoxRunFuture), GatewayInstanceError>
        + Send
        + Sync;

    pub(crate) struct FakeFactory {
        platform: &'static str,
        calls: Arc<AtomicUsize>,
        create: Arc<FakeCreateFn>,
    }

    impl AdapterFactory for FakeFactory {
        fn platform_key(&self) -> &str {
            self.platform
        }
        fn create(
            &self,
            state: &InstanceState,
            cancel: CancellationToken,
            notifier: InstanceNotifier,
        ) -> Result<(Arc<dyn PlatformAdapter>, BoxRunFuture), GatewayInstanceError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            (self.create)(state, cancel, notifier)
        }
    }

    pub(crate) fn factory_with(
        calls: Arc<AtomicUsize>,
        create: impl Fn(
                &InstanceState,
                CancellationToken,
                InstanceNotifier,
            )
                -> Result<(Arc<dyn PlatformAdapter>, BoxRunFuture), GatewayInstanceError>
            + Send
            + Sync
            + 'static,
    ) -> Arc<FakeFactory> {
        Arc::new(FakeFactory {
            platform: "qq",
            calls,
            create: Arc::new(create),
        })
    }

    async fn create_instance(service: &GatewayInstanceService, id: &str) -> AdapterInstance {
        service
            .create(CreateInstanceInput {
                id: id.to_string(),
                platform: "qq".to_string(),
                label: format!("实例 {id}"),
                enabled: true,
                auto_start: true,
            })
            .await
            .expect("create ok")
    }

    async fn wait_for_status(service: &GatewayInstanceService, id: &str, expected: InstanceStatus) {
        for _ in 0..200 {
            match service.get(id).await {
                Ok(dto) if dto.status == expected => return,
                _ => tokio::time::sleep(std::time::Duration::from_millis(5)).await,
            }
        }
        panic!("等待超时: {id} -> {expected:?}");
    }

    #[tokio::test]
    async fn create_returns_stopped_dto_and_list_sorted() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "b").await;
        create_instance(&service, "a").await;
        let list = service.list().await;
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[1].id, "b");
        for dto in &list {
            assert_eq!(dto.status, InstanceStatus::Stopped);
            assert_eq!(dto.credential_status, CredentialStatus::Missing);
            assert!(dto.credential_ref.is_none());
            assert!(dto.last_error.is_none());
        }
        let text = serde_json::to_string(&list).unwrap();
        assert!(!text.contains("secret"));
    }

    #[tokio::test]
    async fn create_duplicate_id_is_idempotent_same_platform() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let dto = create_instance(&service, "a").await;
        assert_eq!(dto.id, "a");
        assert_eq!(service.list().await.len(), 1);
    }

    #[tokio::test]
    async fn create_duplicate_id_conflicting_platform_rejected() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let err = service
            .create(CreateInstanceInput {
                id: "a".to_string(),
                platform: "wechat".to_string(),
                label: "x".into(),
                enabled: true,
                auto_start: false,
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_transition");
        let dto = service.get("a").await.unwrap();
        assert_eq!(dto.platform, "qq");
    }

    #[tokio::test]
    async fn update_changes_config_fields_only() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let dto = service
            .update(
                "a",
                UpdateInstanceInput {
                    label: Some("新名字".into()),
                    enabled: Some(false),
                    auto_start: Some(false),
                },
            )
            .await
            .unwrap();
        assert_eq!(dto.label, "新名字");
        assert!(!dto.enabled);
        assert!(!dto.auto_start);
        assert_eq!(dto.status, InstanceStatus::Stopped);
        assert_eq!(dto.platform, "qq");
        let err = service
            .update("missing", UpdateInstanceInput::default())
            .await
            .unwrap_err();
        assert_eq!(err.code(), "instance_not_found");
    }

    #[tokio::test]
    async fn remove_stopped_instance_ok() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        service.remove("a").await.unwrap();
        let err = service.get("a").await.unwrap_err();
        assert_eq!(err.code(), "instance_not_found");
        let err = service.remove("a").await.unwrap_err();
        assert_eq!(err.code(), "instance_not_found");
    }

    #[tokio::test]
    async fn remove_running_instance_rejected() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let factory = factory_with(
            Arc::new(AtomicUsize::new(0)),
            |_state, _cancel, _notifier| {
                Ok((
                    Arc::new(StubAdapter { platform: "qq" }),
                    Box::pin(async {
                        std::future::pending::<()>().await;
                        Ok(())
                    }),
                ))
            },
        );
        service.register_factory(factory);
        service.start("a").await.unwrap();
        let err = service.remove("a").await.unwrap_err();
        assert_eq!(err.code(), "invalid_transition");
        service.stop("a").await.unwrap();
    }

    #[tokio::test]
    async fn remove_reports_route_in_use_when_bound() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        service.set_route_guard(Arc::new(|id| id == "a"));
        let err = service.remove("a").await.unwrap_err();
        assert_eq!(err.code(), "route_in_use");
        create_instance(&service, "b").await;
        service.remove("b").await.unwrap();
    }

    #[tokio::test]
    async fn start_unknown_instance_not_found() {
        let service = GatewayInstanceService::new();
        let err = service.start("missing").await.unwrap_err();
        assert_eq!(err.code(), "instance_not_found");
    }

    #[tokio::test]
    async fn start_without_factory_reports_adapter_unavailable() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let err = service.start("a").await.unwrap_err();
        assert_eq!(err.code(), "adapter_unavailable");
        let dto = service.get("a").await.unwrap();
        assert_eq!(dto.status, InstanceStatus::Stopped);
    }

    #[tokio::test]
    async fn factory_credential_error_maps_to_credential_missing_and_rolls_back() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let factory = factory_with(
            Arc::new(AtomicUsize::new(0)),
            |_state, _cancel, _notifier| {
                Err(GatewayInstanceError::CredentialMissing(
                    "未配置 qq 凭据".to_string(),
                ))
            },
        );
        service.register_factory(factory);
        let err = service.start("a").await.unwrap_err();
        assert_eq!(err.code(), "credential_missing");
        let dto = service.get("a").await.unwrap();
        assert_eq!(dto.status, InstanceStatus::Stopped);
        // I12-W4（CR-002）：fresh start 前置失败也记录 last_error——auto-start 为后台
        // 任务，实例状态必须携带失败原因才"可见"（UI 卡片可呈现），不静默。
        assert!(
            dto.last_error.is_some(),
            "失败原因必须可见（last_error）: {dto:?}"
        );
    }

    #[tokio::test]
    async fn run_failure_sets_error_state_with_last_error() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let factory = factory_with(
            Arc::new(AtomicUsize::new(0)),
            |_state, _cancel, _notifier| {
                Ok((
                    Arc::new(StubAdapter { platform: "qq" }),
                    Box::pin(async { Err("连接超时（认证失败）".to_string()) }),
                ))
            },
        );
        service.register_factory(factory);
        service.start("a").await.unwrap();
        wait_for_status(&service, "a", InstanceStatus::Error).await;
        let dto = service.get("a").await.unwrap();
        assert_eq!(dto.status, InstanceStatus::Error);
        assert_eq!(dto.last_error.as_deref(), Some("连接超时（认证失败）"));
        let text = serde_json::to_string(&dto).unwrap();
        assert!(!text.contains("secret"), "错误状态不得泄密");
    }

    #[tokio::test]
    async fn start_connects_then_clean_exit_stops() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let (hold_tx, hold_rx) = tokio::sync::watch::channel(true);
        let factory = factory_with(
            Arc::new(AtomicUsize::new(0)),
            move |_state, _cancel, notifier| {
                let mut hold = hold_rx.clone();
                Ok((
                    Arc::new(StubAdapter { platform: "qq" }),
                    Box::pin(async move {
                        notifier.connected().await;
                        let _ = hold.changed().await;
                        Ok(())
                    }),
                ))
            },
        );
        service.register_factory(factory);
        let dto = service.start("a").await.unwrap();
        assert_eq!(dto.status, InstanceStatus::Starting);
        wait_for_status(&service, "a", InstanceStatus::Connected).await;
        let _ = hold_tx.send(false);
        wait_for_status(&service, "a", InstanceStatus::Stopped).await;
        let dto = service.get("a").await.unwrap();
        assert_eq!(dto.status, InstanceStatus::Stopped);
        assert!(dto.last_error.is_none());
    }

    #[tokio::test]
    async fn repeated_start_is_idempotent_single_task() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let calls = Arc::new(AtomicUsize::new(0));
        let factory = factory_with(calls.clone(), |_state, _cancel, _notifier| {
            Ok((
                Arc::new(StubAdapter { platform: "qq" }),
                Box::pin(async {
                    std::future::pending::<()>().await;
                    Ok(())
                }),
            ))
        });
        service.register_factory(factory);
        service.start("a").await.unwrap();
        let dto2 = service.start("a").await.unwrap();
        assert_eq!(dto2.status, InstanceStatus::Starting);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "不得重复 spawn task");
        service.stop("a").await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_start_spawns_single_task() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let calls = Arc::new(AtomicUsize::new(0));
        let factory = factory_with(calls.clone(), |_state, _cancel, _notifier| {
            Ok((
                Arc::new(StubAdapter { platform: "qq" }),
                Box::pin(async {
                    std::future::pending::<()>().await;
                    Ok(())
                }),
            ))
        });
        service.register_factory(factory);
        let mut handles = Vec::new();
        for _ in 0..10 {
            let service = service.clone();
            handles.push(tokio::spawn(async move {
                service.start("a").await.expect("start ok")
            }));
        }
        for handle in handles {
            handle.await.expect("join");
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "并发 start 只能 spawn 一个 task"
        );
        service.stop("a").await.unwrap();
    }

    #[tokio::test]
    async fn stop_is_idempotent_and_clears_runtime() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let (hold_tx, hold_rx) = tokio::sync::watch::channel(true);
        let factory = factory_with(
            Arc::new(AtomicUsize::new(0)),
            move |_state, _cancel, _notifier| {
                let mut hold = hold_rx.clone();
                Ok((
                    Arc::new(StubAdapter { platform: "qq" }),
                    Box::pin(async move {
                        let _ = hold.changed().await;
                        Ok(())
                    }),
                ))
            },
        );
        service.register_factory(factory);
        service.start("a").await.unwrap();
        let dto = service.stop("a").await.unwrap();
        assert_eq!(dto.status, InstanceStatus::Stopped);
        let dto2 = service.stop("a").await.unwrap();
        assert_eq!(dto2.status, InstanceStatus::Stopped);
        let _ = hold_tx.send(false);
        wait_for_status(&service, "a", InstanceStatus::Stopped).await;
    }

    #[tokio::test]
    async fn restart_while_starting_rejected() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let (hold_tx, hold_rx) = tokio::sync::watch::channel(true);
        let factory = factory_with(
            Arc::new(AtomicUsize::new(0)),
            move |_state, _cancel, _notifier| {
                let mut hold = hold_rx.clone();
                Ok((
                    Arc::new(StubAdapter { platform: "qq" }),
                    Box::pin(async move {
                        let _ = hold.changed().await;
                        Ok(())
                    }),
                ))
            },
        );
        service.register_factory(factory);
        service.start("a").await.unwrap();
        let err = service.restart("a").await.unwrap_err();
        assert_eq!(err.code(), "invalid_transition");
        service.stop("a").await.unwrap();
        let _ = hold_tx.send(false);
    }

    #[tokio::test]
    async fn restart_reconnects_with_fresh_generation() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let (hold_tx, hold_rx) = tokio::sync::watch::channel(true);
        let calls = Arc::new(AtomicUsize::new(0));
        let factory = factory_with(calls.clone(), move |_state, _cancel, notifier| {
            let mut hold = hold_rx.clone();
            Ok((
                Arc::new(StubAdapter { platform: "qq" }),
                Box::pin(async move {
                    notifier.connected().await;
                    let _ = hold.changed().await;
                    Ok(())
                }),
            ))
        });
        service.register_factory(factory);
        service.start("a").await.unwrap();
        wait_for_status(&service, "a", InstanceStatus::Connected).await;
        service.restart("a").await.unwrap();
        wait_for_status(&service, "a", InstanceStatus::Connected).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        service.stop("a").await.unwrap();
        let _ = hold_tx.send(false);
    }

    #[tokio::test]
    async fn stale_task_cannot_overwrite_after_restart() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let (release_tx, release_rx) = tokio::sync::watch::channel(true);
        let calls = Arc::new(AtomicUsize::new(0));
        let call_index = Arc::new(AtomicUsize::new(0));
        let factory = factory_with(calls.clone(), move |_state, _cancel, notifier| {
            let mut release = release_rx.clone();
            let n = call_index.fetch_add(1, Ordering::SeqCst);
            let run: BoxRunFuture = if n == 0 {
                // gen1：连接就绪后挂起；restart 后迟到退出并上报旧错误
                Box::pin(async move {
                    notifier.connected().await;
                    let _ = release.changed().await;
                    notifier.failed("stale-old-task".to_string()).await;
                    Err("stale-old-task".to_string())
                })
            } else {
                // gen2：立即 clean exit
                Box::pin(async { Ok(()) })
            };
            Ok((Arc::new(StubAdapter { platform: "qq" }), run))
        });
        service.register_factory(factory);
        service.start("a").await.unwrap();
        wait_for_status(&service, "a", InstanceStatus::Connected).await;
        service.restart("a").await.unwrap();
        let _ = release_tx.send(false);
        wait_for_status(&service, "a", InstanceStatus::Stopped).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "restart 应生成新 task");
        let dto = service.get("a").await.unwrap();
        assert_eq!(dto.status, InstanceStatus::Stopped);
        assert!(dto.last_error.is_none(), "旧 task 不得覆盖状态: {dto:?}");
    }

    #[tokio::test]
    async fn start_from_error_cleans_lingering_task() {
        let service = GatewayInstanceService::new();
        create_instance(&service, "a").await;
        let (hold_tx, hold_rx) = tokio::sync::watch::channel(true);
        let calls = Arc::new(AtomicUsize::new(0));
        let call_index = Arc::new(AtomicUsize::new(0));
        let factory = factory_with(calls.clone(), move |_state, _cancel, notifier| {
            let mut hold = hold_rx.clone();
            let n = call_index.fetch_add(1, Ordering::SeqCst);
            let run: BoxRunFuture = if n == 0 {
                // gen1：连接 → 保持 Connected → 释放#1 后 failed（runtime 仍保留）
                // → 再保持挂起 → 释放#2 后退出
                Box::pin(async move {
                    notifier.connected().await;
                    let _ = hold.changed().await;
                    notifier.failed("boom".to_string()).await;
                    let _ = hold.changed().await;
                    Err("boom".to_string())
                })
            } else {
                Box::pin(async { Ok(()) })
            };
            Ok((Arc::new(StubAdapter { platform: "qq" }), run))
        });
        service.register_factory(factory);
        service.start("a").await.unwrap();
        wait_for_status(&service, "a", InstanceStatus::Connected).await;
        let _ = hold_tx.send(false);
        wait_for_status(&service, "a", InstanceStatus::Error).await;
        let dto = service.get("a").await.unwrap();
        assert_eq!(dto.last_error.as_deref(), Some("boom"));
        // Error 状态下再次 start：应取消残留 task（runtime 仍 Some）并生成全新任务
        service.start("a").await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let _ = hold_tx.send(true);
        wait_for_status(&service, "a", InstanceStatus::Stopped).await;
        let dto = service.get("a").await.unwrap();
        assert_eq!(dto.status, InstanceStatus::Stopped);
        assert!(dto.last_error.is_none(), "新 start 应清除旧错误: {dto:?}");
    }

    // ── I12-W4：启动恢复（load_instances / status_of） ──

    #[tokio::test]
    async fn load_instances_creates_all_stopped_and_skips_existing() {
        let service = GatewayInstanceService::new();
        service
            .create(CreateInstanceInput {
                id: "a".into(),
                platform: "qq".into(),
                label: "手动".into(),
                enabled: true,
                auto_start: false,
            })
            .await
            .unwrap();
        service
            .load_instances(vec![
                StoredInstance {
                    id: "a".into(),
                    platform: "qq".into(),
                    label: "旧a".into(),
                    enabled: false,
                    auto_start: false,
                },
                StoredInstance {
                    id: "b".into(),
                    platform: "wechat".into(),
                    label: "b".into(),
                    enabled: true,
                    auto_start: true,
                },
            ])
            .await;
        let instances = service.list().await;
        assert_eq!(instances.len(), 2, "a 已存在跳过（不覆盖），b 新增");
        let a = service.get("a").await.unwrap();
        assert_eq!(a.label, "手动", "已存在实例不被 store 覆盖");
        assert!(a.enabled);
        let b = service.get("b").await.unwrap();
        assert_eq!(
            b.status,
            InstanceStatus::Stopped,
            "加载后统一 Stopped，不恢复旧 Connected"
        );
        assert!(b.auto_start);
        assert_eq!(b.credential_status, CredentialStatus::Missing);
        assert_eq!(b.credential_ref, None);
    }

    #[tokio::test]
    async fn status_of_reports_known_and_unknown() {
        let service = GatewayInstanceService::new();
        assert_eq!(service.status_of("missing").await, None);
        service
            .create(CreateInstanceInput {
                id: "a".into(),
                platform: "qq".into(),
                label: "a".into(),
                enabled: true,
                auto_start: false,
            })
            .await
            .unwrap();
        assert_eq!(service.status_of("a").await, Some(InstanceStatus::Stopped));
    }

    #[tokio::test]
    async fn adapter_registry_hook_fires_on_start_and_finalize() {
        // P78：start 成功 → hook(true)（GatewayCore 注册，出站路由依赖）；
        // stop → finalize 清 runtime → hook(false) 注销。hook 未接线时实例
        // 入站仍通但出站被丢——本测试锁定接线后的事件序列。
        let service = GatewayInstanceService::new();
        let events: Arc<StdRwLock<Vec<(String, bool)>>> = Arc::new(StdRwLock::new(Vec::new()));
        let events_for_hook = events.clone();
        service.set_adapter_registry(Arc::new(move |key, _adapter, register| {
            events_for_hook
                .write()
                .unwrap()
                .push((key.to_string(), register));
        }));
        let calls = Arc::new(AtomicUsize::new(0));
        service.register_factory(factory_with(calls, |_state, _cancel, notifier| {
            let run: BoxRunFuture = Box::pin(async move {
                notifier.connected().await;
                std::future::pending::<()>().await;
                Ok(())
            });
            Ok((Arc::new(StubAdapter { platform: "qq" }), run))
        }));
        service
            .create(CreateInstanceInput {
                id: "a".into(),
                platform: "qq".into(),
                label: "a".into(),
                enabled: true,
                auto_start: false,
            })
            .await
            .unwrap();
        service.start("a").await.unwrap();
        wait_for_status(&service, "a", InstanceStatus::Connected).await;
        assert_eq!(
            events.read().unwrap().as_slice(),
            &[("qq".to_string(), true)],
            "start 必须触发注册"
        );
        service.stop("a").await.unwrap();
        for _ in 0..200 {
            if events.read().unwrap().len() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            events.read().unwrap().as_slice(),
            &[("qq".to_string(), true), ("qq".to_string(), false)],
            "stop 经 finalize 必须触发注销"
        );
    }

    #[tokio::test]
    async fn auto_start_instances_only_starts_enabled_and_auto_start() {
        // AC2：启动恢复的自动启动策略——仅 enabled && autoStart 显式启动；
        // 其余不启动；autoStart 成功 → Connected。
        let service = GatewayInstanceService::new();
        let calls = Arc::new(AtomicUsize::new(0));
        service.register_factory(factory_with(calls.clone(), |_state, _cancel, notifier| {
            // run 挂起不退出：实例保持 Connected（退出即 finalize 回 Stopped）
            let run: BoxRunFuture = Box::pin(async move {
                notifier.connected().await;
                std::future::pending::<()>().await;
                Ok(())
            });
            Ok((Arc::new(StubAdapter { platform: "qq" }), run))
        }));
        for (id, enabled, auto) in [("a", true, true), ("b", true, false), ("c", false, true)] {
            service
                .create(CreateInstanceInput {
                    id: id.into(),
                    platform: "qq".into(),
                    label: id.into(),
                    enabled,
                    auto_start: auto,
                })
                .await
                .unwrap();
        }
        service.auto_start_instances().await;
        // 等待 a（唯一 enabled && autoStart）到达 Connected；b/c 不被 start
        for _ in 0..200 {
            let a = service.get("a").await.unwrap();
            if a.status == InstanceStatus::Connected {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "仅 enabled && autoStart 的实例触发 start"
        );
        let a = service.get("a").await.unwrap();
        assert_eq!(
            a.status,
            InstanceStatus::Connected,
            "autoStart 成功 → Connected"
        );
        let b = service.get("b").await.unwrap();
        assert_eq!(b.status, InstanceStatus::Stopped, "未 autoStart 不启动");
        let c = service.get("c").await.unwrap();
        assert_eq!(c.status, InstanceStatus::Stopped, "disabled 不启动");
    }

    #[tokio::test]
    async fn auto_start_failure_is_visible_and_does_not_block_others() {
        // 单实例 autoStart 失败（factory 对指定实例报 credential_missing）→ 该实例落
        // Stopped（回滚，last_error 可见），不 panic、不影响其余实例（tracing::error）。
        let service = GatewayInstanceService::new();
        let calls = Arc::new(AtomicUsize::new(0));
        service.register_factory(factory_with(calls.clone(), |state, _cancel, notifier| {
            if state.id == "nofactory" {
                return Err(GatewayInstanceError::CredentialMissing(
                    "测试无凭据".to_string(),
                ));
            }
            // run 挂起不退出：good 保持 Connected
            let run: BoxRunFuture = Box::pin(async move {
                notifier.connected().await;
                std::future::pending::<()>().await;
                Ok(())
            });
            Ok((Arc::new(StubAdapter { platform: "qq" }), run))
        }));
        for id in ["good", "nofactory"] {
            service
                .create(CreateInstanceInput {
                    id: id.into(),
                    platform: "qq".into(),
                    label: id.into(),
                    enabled: true,
                    auto_start: true,
                })
                .await
                .unwrap();
        }
        service.auto_start_instances().await;
        // 等待异步 start 收敛：good → Connected；nofactory → Stopped（回滚）
        for _ in 0..200 {
            let good = service.get("good").await.unwrap();
            let failed = service.get("nofactory").await.unwrap();
            if good.status == InstanceStatus::Connected && failed.status == InstanceStatus::Stopped
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let failed = service.get("nofactory").await.unwrap();
        assert_eq!(failed.status, InstanceStatus::Stopped, "失败实例落 Stopped");
        assert!(
            failed.last_error.is_some(),
            "失败原因必须可见（last_error），不静默: {failed:?}"
        );
        let good = service.get("good").await.unwrap();
        assert_eq!(good.status, InstanceStatus::Connected, "其余实例不受影响");
    }

    #[tokio::test]
    async fn finalize_outcome_ok_goes_stopped_err_goes_error_with_last_error() {
        // I12 W8（LR2-WI04）：run future 退出收敛——Ok（主动 stop）→ Stopped 且 last_error 清空；
        // Err（如重连耗尽，ws.rs 退避耗尽返回 Err）→ Error 且 last_error 可见（ISSUE-12 目标行为 5）。
        let service = GatewayInstanceService::new();
        service
            .create(CreateInstanceInput {
                id: "qq-1".into(),
                platform: "qq".into(),
                label: "a".into(),
                enabled: true,
                auto_start: false,
            })
            .await
            .expect("create");
        // 预置 Starting（create 初始 generation=0），直接驱动 finalize_runtime
        {
            let mut registry = service.registry.write().await;
            registry
                .get_mut("qq-1")
                .expect("instance exists")
                .set_lifecycle(InstanceLifecycle::Starting);
        }
        service
            .finalize_runtime(
                "qq-1".into(),
                0,
                Err("QQ WS: 重连耗尽（超过最大尝试次数），连接终止".into()),
            )
            .await;
        let dto = service.get("qq-1").await.expect("get");
        assert_eq!(
            dto.status,
            InstanceStatus::Error,
            "重连耗尽必须进入 Error 而非 Stopped"
        );
        assert_eq!(
            dto.last_error.as_deref(),
            Some("QQ WS: 重连耗尽（超过最大尝试次数），连接终止"),
            "lastError 必须可见（实例卡片呈现）"
        );
        // Ok 路径：重置为 Starting 后 finalize(Ok) → Stopped（主动 stop 收敛）
        {
            let mut registry = service.registry.write().await;
            let managed = registry.get_mut("qq-1").expect("instance exists");
            managed.set_lifecycle(InstanceLifecycle::Starting);
            managed.state.last_error = None;
        }
        service.finalize_runtime("qq-1".into(), 0, Ok(())).await;
        let dto = service.get("qq-1").await.expect("get");
        assert_eq!(
            dto.status,
            InstanceStatus::Stopped,
            "主动 stop（Ok）收敛 Stopped"
        );
        assert_eq!(dto.last_error, None, "Ok 收敛不得残留 last_error");
    }
}
