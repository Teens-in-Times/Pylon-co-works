//! #98：`session/fork` 通用消费者。
//!
//! Pylon 此前只能读 `sessionCapabilities.fork` 广告（展示型 ghost capability），
//! 没有执行链。本模块补齐消费者：仅当协商快照判定 fork **usable**（广告 ∩
//! 消费者注册）时才发送 raw `session/fork` RPC；协议没有标准 typed struct，
//! 使用受限 untyped envelope（params 仅 `sessionId`；response 校验大小与
//! sessionId 合法性，未知扩展字段原样保留供诊断，不因未知字段失败）。
//!
//! 身份契约（spec §5）：
//! - 成功 → 产生**新的 remote session identity**，child 本地槽位绑定它，
//!   parent/child 关系登记在 [`fork_link`]（parent 槽位不被复用/污染）；
//! - 失败 → 不创建 child 槽位、不登记关系，parent 映射原样保留（回滚 =
//!   「从未发生」，测试断言）；
//! - 能力不可用 → 稳定错误 `session_fork_unavailable`，不伪造成功。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::time::Timestamp;
use crate::AppState;

/// 官方 typed 常量与 `ForkSessionRequest` 在 `unstable_session_fork` feature
/// 之后（schema 1.9.1 仍默认关闭）；Pylon 未启用该 feature，故保持手写常量
/// + bounded raw envelope（wire 方法名为协议级拼写）。
pub(crate) const METHOD_SESSION_FORK: &str = "session/fork";

/// bounded raw envelope：fork response 上限（session/new/load 响应量级）。
const MAX_FORK_RESPONSE_BYTES: usize = 1_048_576;

/// parent/child fork 关系（运行期契约 + 诊断）。持久化权威仍是 identity/journal
/// 层——这里只承载本进程内 fork 链路与 snapshot 断言素材。
static FORK_LINKS: OnceLock<RwLock<HashMap<String, ForkRecord>>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForkRecord {
    pub parent_source: String,
    pub parent_peri_id: String,
    pub child_peri_id: String,
    pub generation: u64,
    pub created_at: Timestamp,
}

fn fork_links() -> &'static RwLock<HashMap<String, ForkRecord>> {
    FORK_LINKS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// 查询 child source 的 fork 关系（wire trace/snapshot 断言与诊断用）。
pub(crate) fn fork_link(child_source: &str) -> Option<ForkRecord> {
    fork_links()
        .read()
        .ok()
        .and_then(|links| links.get(child_source).cloned())
}

fn record_fork_link(child_source: &str, record: ForkRecord) {
    if let Ok(mut links) = fork_links().write() {
        links.insert(child_source.to_string(), record);
    }
}

/// 受限 raw envelope 校验：response 必须 object、含合法 `sessionId`、大小受限。
/// 未知扩展字段不参与校验（不因未来字段失败），由调用方保留原文供诊断。
pub(crate) fn forked_session_id_from(response: &serde_json::Value) -> Result<String, String> {
    if !response.is_object() {
        return Err(format!(
            "session/fork 响应必须是 object（实际 {}）",
            match response {
                serde_json::Value::Null => "null",
                serde_json::Value::Bool(_) => "boolean",
                serde_json::Value::Number(_) => "number",
                serde_json::Value::String(_) => "string",
                serde_json::Value::Array(_) => "array",
                serde_json::Value::Object(_) => "object",
            }
        ));
    }
    if response.to_string().len() > MAX_FORK_RESPONSE_BYTES {
        return Err("session/fork 响应超过大小上限（bounded raw envelope）".to_string());
    }
    crate::acp::session_id_from(response).map_err(|_| {
        "session/fork 响应缺少合法 sessionId（fail-closed，不伪造 child identity）".to_string()
    })
}

/// fork 主体：能力 gate → generation-checked raw RPC → child 槽位 + 关系登记。
/// `child_source` 由调用方（前端 identity 层）提供——source 命名权属于本地身份层。
pub(crate) async fn fork_session_slot(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    child_source: &str,
) -> Result<serde_json::Value, PylonError> {
    if child_source.is_empty() {
        return Err(PylonError::Protocol(
            "session fork requires a non-empty childSource".to_string(),
        ));
    }
    // parent 必须是本 runtime 上的既有会话（fork 语义的前提）。
    let (parent_peri_id, parent_profile_id, parent_cwd) = {
        let sessions = runtime
            .sessions
            .lock()
            .map_err(|error| PylonError::Protocol(error.to_string()))?;
        let parent = sessions.get(source).ok_or_else(|| {
            PylonError::SessionNotFound(format!("fork parent session not found: {source}"))
        })?;
        (
            parent.peri_id.clone(),
            parent.profile_id.clone(),
            parent.cwd.clone(),
        )
    };
    let generation = state.current_generation(runtime);
    // 能力 gate（AC7）：fork 必须协商通过且消费者已注册（usable），否则稳定
    // unsupported——不因远端广告 true 就执行。
    let snapshot = crate::acp::capture_negotiated_snapshot(runtime)
        .await
        .map_err(PylonError::Protocol)?;
    if !snapshot.fork_usable() {
        let reason = snapshot
            .decision("fork")
            .map(|decision| {
                // fork 无声明维度：advertised ⇒ negotiated 恒成立，可用性缺口
                // 只可能是「未广告」或「消费者未注册」两种。
                if decision.advertised == Some(true) {
                    "fork advertised but consumer not registered"
                } else {
                    "fork capability not advertised"
                }
            })
            .unwrap_or("fork capability unknown");
        return Err(PylonError::Protocol(format!(
            "session_fork_unavailable: {reason}"
        )));
    }
    // 受限 raw RPC：generation-checked（旧连接不得写新 ACP），params 仅 sessionId。
    let params = serde_json::json!({ "sessionId": parent_peri_id });
    let response = state
        .acp_rpc_generation_checked(runtime, METHOD_SESSION_FORK, params, generation)
        .await
        .map_err(|error| PylonError::Protocol(format!("session/fork rpc failed: {error}")))?;
    // 失败回滚：以下任何一步失败都不得留下 child 槽位/关系；parent 槽位在本
    // 函数内只读——RPC 失败即「从未发生」。
    let child_peri_id = forked_session_id_from(&response).map_err(PylonError::Protocol)?;
    let mut child = crate::session::SessionInfo::new(
        child_peri_id.clone(),
        String::new(),
        parent_cwd,
        false,
        generation,
    );
    child.profile_id = parent_profile_id;
    // fork 响应可能携带 child 会话的 mode/config 等宣告面，与 session/new 同路消费。
    child.apply_session_response(&response);
    crate::session::replace_session_slot(
        runtime,
        child_source,
        child,
        true,
        crate::agent::runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    record_fork_link(
        child_source,
        ForkRecord {
            parent_source: source.to_string(),
            parent_peri_id: parent_peri_id.clone(),
            child_peri_id: child_peri_id.clone(),
            generation,
            created_at: Timestamp::now(),
        },
    );
    state.log_runtime_summary(
        "info",
        "session",
        Some(source.to_string()),
        "Session forked via raw session/fork RPC",
        serde_json::Map::from_iter([
            (
                "parentPeriId".to_string(),
                serde_json::Value::String(parent_peri_id.clone()),
            ),
            (
                "childSource".to_string(),
                serde_json::Value::String(child_source.to_string()),
            ),
            (
                "periId".to_string(),
                serde_json::Value::String(child_peri_id.clone()),
            ),
            (
                "generation".to_string(),
                serde_json::Value::from(generation),
            ),
        ]),
    );
    Ok(serde_json::json!({
        "parentSource": source,
        "parentPeriId": parent_peri_id,
        "childSource": child_source,
        "periId": child_peri_id,
        "generation": generation,
        "fork": fork_link(child_source),
        "rawResponse": response,
    }))
}

/// Tauri 命令：fork 指定本地会话。成功后发 `pylon:session-forked`（含
/// parent/child identity + generation），前端可据此登记新本地会话。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn session_fork(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    source: String,
    child_source: String,
) -> Result<serde_json::Value, PylonError> {
    // 解析 parent 所属 runtime（fork 按会话归属路由，不按 active agent 猜测）。
    // 注意：本遍历是 source → runtime 的反向扫描，形态上即 owner.rs 契约宣布移除的
    // ACP-05 `find_runtime_for_source`（双 Agent 同名 source 时取首个命中、归属不定）。
    // 此处豁免保留的依据：fork 的 source 由前端 identity 层保证跨 agent 唯一；且
    // 找不到时显式报 SessionNotFound，不存在「串线静默投递」后果。若 source 唯一性
    // 前提变化，此处须改走显式 agentId 路由（resolve_agent_runtime）。
    let resolved = state
        .runtimes
        .all_with_ids()
        .into_iter()
        .find(|(_, runtime)| {
            runtime
                .sessions
                .lock()
                .map(|sessions| sessions.contains_key(&source))
                .unwrap_or(false)
        });
    let (_agent_id, runtime) = resolved.ok_or_else(|| {
        PylonError::SessionNotFound(format!("fork parent session not found: {source}"))
    })?;
    let payload = fork_session_slot(&state, &runtime, &source, &child_source).await?;
    crate::emit_event(&window, crate::event_names::SESSION_FORKED, payload.clone());
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 受限 envelope：合法响应提取 sessionId；未知扩展字段不破坏提取（AC12）。
    #[test]
    fn forked_session_id_extracts_from_bounded_envelope() {
        let response = serde_json::json!({
            "sessionId": "remote-child",
            "_vendorExtension": {"future": ["fields"]},
            "configOptions": [{"kind": "model", "id": "m1"}]
        });
        assert_eq!(
            forked_session_id_from(&response).unwrap(),
            "remote-child".to_string()
        );
    }

    /// 受限 envelope：缺 sessionId / 非 object / 超大响应都 fail-closed，
    /// 不伪造 child identity。
    #[test]
    fn forked_session_id_fails_closed_on_invalid_envelopes() {
        assert!(forked_session_id_from(&serde_json::json!({})).is_err());
        assert!(forked_session_id_from(&serde_json::json!(null)).is_err());
        assert!(forked_session_id_from(&serde_json::json!("session-1")).is_err());
        let oversized = serde_json::Value::String("x".repeat(MAX_FORK_RESPONSE_BYTES + 1));
        assert!(forked_session_id_from(&oversized).is_err());
    }

    // ── P1-2（评审修复）：fork 执行链 wire 级测试——gate/RPC 形状/child 槽位/
    // parent 只读/失败回滚全部落证据（`pylon-fake-agent --scenario fork`，与
    // revive_tests 同款 harness；不依赖真实 provider 名称，fixture 只描述
    // ACP wire 形状）。──

    async fn fork_runtime(
        name: &str,
        fail: bool,
    ) -> (std::sync::Arc<AgentRuntime>, crate::agent_config::AgentDef) {
        // 场景 `fork` 复刻原 FORK_SCRIPT 的 wire：initialize 宣告 fork+loadSession、
        // session/fork 回 child id 与未知扩展字段、其余方法回 parent id；
        // 失败注入用 `--outcome error`（等价于原 PYLON_FORK_FAIL=1）。
        let mut args = vec!["--scenario", "fork"];
        if fail {
            args.extend(["--outcome", "error"]);
        }
        let agent = crate::test_utils::fake_acp_agent(name, &args);
        let runtime = AgentRuntime::new_disconnected();
        runtime.install_acp(
            crate::acp::AcpClient::connect_with_logs(&agent, None)
                .await
                .unwrap(),
        );
        (runtime, agent)
    }

    fn seed_parent(runtime: &AgentRuntime, source: &str) {
        let parent = crate::session::SessionInfo::new(
            "remote-parent".to_string(),
            String::new(),
            ".".to_string(),
            false,
            0,
        );
        runtime
            .sessions
            .lock()
            .expect("test sessions 锁")
            .insert(source.to_string(), parent);
    }

    /// AC8：fork usable ⇒ 实发 raw `session/fork`（params 仅 sessionId），返回的
    /// 新 remote identity 绑定 child 槽位 + ForkRecord；parent 槽位只读不污染；
    /// 未知扩展字段不破坏 sessionId 提取（raw 原文随事件回传）。
    #[tokio::test]
    async fn fork_session_slot_sends_raw_rpc_and_creates_child_with_link() {
        crate::acp::negotiated::register_capability_consumer(
            crate::acp::CapabilityConsumer::SessionFork,
        );
        let (runtime, agent) = fork_runtime("fork-ok", false).await;
        seed_parent(&runtime, "local:parent");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("fork-ok")
            .with_agent(agent)
            .with_runtime("fork-ok", runtime.clone())
            .build();
        let payload = fork_session_slot(&state, &runtime, "local:parent", "local:child")
            .await
            .unwrap();
        assert_eq!(
            payload.get("periId"),
            Some(&serde_json::json!("remote-child"))
        );
        assert_eq!(
            payload.pointer("/rawResponse/_vendorExtension"),
            Some(&serde_json::json!({"future": true})),
            "未知扩展字段原样保留（raw envelope 保真）"
        );
        let sessions = runtime.sessions.lock().expect("test sessions 锁");
        assert_eq!(
            sessions.get("local:child").expect("child 槽位已建").peri_id,
            "remote-child"
        );
        assert_eq!(
            sessions
                .get("local:parent")
                .expect("parent 槽位不变")
                .peri_id,
            "remote-parent",
            "失败回滚前提：parent 映射只读"
        );
        drop(sessions);
        let record = fork_link("local:child").expect("fork 关系已登记");
        assert_eq!(record.parent_source, "local:parent");
        assert_eq!(record.parent_peri_id, "remote-parent");
        assert_eq!(record.child_peri_id, "remote-child");
    }

    /// AC8 回滚：RPC 失败 ⇒ 稳定错误、无 child 槽位、无 fork 关系、parent 原样。
    #[tokio::test]
    async fn fork_failure_rolls_back_without_child_slot_or_link() {
        // P1-2 修复（CI 顺序依赖）：消费者注册是进程级全局
        // （`negotiated::CAPABILITY_CONSUMERS`），注册只在成功用例里做过——
        // 本用例不能依赖「它先跑」这种调度偶然：runner 上并行调度一变，就会
        // 提前被 gate 拦成 `fork advertised but consumer not registered`，
        // 走不到 RPC 失败路径（实测单跑必红）。独立注册，与成功用例对齐。
        crate::acp::negotiated::register_capability_consumer(
            crate::acp::CapabilityConsumer::SessionFork,
        );
        let (runtime, agent) = fork_runtime("fork-fail", true).await;
        seed_parent(&runtime, "local:parent");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("fork-fail")
            .with_agent(agent)
            .with_runtime("fork-fail", runtime.clone())
            .build();
        // 独立 child source：FORK_LINKS 是进程级全局注册表，避免与成功用例串名。
        let error = fork_session_slot(&state, &runtime, "local:parent", "local:child-fail")
            .await
            .expect_err("RPC 失败必须传播");
        assert!(
            error.to_string().contains("session/fork rpc failed"),
            "实际: {error}"
        );
        let sessions = runtime.sessions.lock().expect("test sessions 锁");
        assert!(
            sessions.get("local:child-fail").is_none(),
            "失败不得创建 child 槽位"
        );
        assert_eq!(
            sessions.get("local:parent").unwrap().peri_id,
            "remote-parent"
        );
        drop(sessions);
        assert!(
            fork_link("local:child-fail").is_none(),
            "失败不得登记 fork 关系"
        );
    }

    /// AC7：能力不可用（未广告/消费者未注册）⇒ 稳定 session_fork_unavailable，
    /// 不发 RPC、不建 child。
    #[tokio::test]
    async fn fork_gate_stable_unsupported_without_negotiated_capability() {
        // 不注册 SessionFork 消费者、连接为 disconnected（无广告）。
        let runtime = AgentRuntime::new_disconnected();
        seed_parent(&runtime, "local:parent");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("fork-gate")
            .with_runtime("fork-gate", runtime.clone())
            .build();
        let error = fork_session_slot(&state, &runtime, "local:parent", "local:child")
            .await
            .expect_err("不可用必须稳定拒绝");
        assert!(
            error.to_string().contains("session_fork_unavailable"),
            "实际: {error}"
        );
        assert!(runtime
            .sessions
            .lock()
            .expect("锁")
            .get("local:child")
            .is_none());
    }

    /// fork 关系登记/查询：child → parent 链路可断言（wire trace/snapshot 素材）。
    #[test]
    fn fork_link_registry_round_trips() {
        let child = format!("local:fork-test-{}", std::process::id());
        record_fork_link(
            &child,
            ForkRecord {
                parent_source: "local:parent".into(),
                parent_peri_id: "remote-parent".into(),
                child_peri_id: "remote-child".into(),
                generation: 4,
                created_at: Timestamp::now(),
            },
        );
        let record = fork_link(&child).expect("fork 关系已登记");
        assert_eq!(record.parent_source, "local:parent");
        assert_eq!(record.parent_peri_id, "remote-parent");
        assert_eq!(record.child_peri_id, "remote-child");
        assert_eq!(record.generation, 4);
    }
}
