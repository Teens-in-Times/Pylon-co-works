//! Prompt 域 · ACP 等待管线（域 A）：send_message IPC 命令、PromptFlow 载体、
//! prompt 阶段函数（prepare/advance）、send_prompt_core 公共发送管线与等待分派。
//! W3 重构批次 S1 纯搬移自 session/prompt.rs（行为零变化）。

use super::*;
use pylon_foundations::await_guard::HeldAcrossAwait;
// #425 件6：发起路径两位点（ensure 失败 / 用户消息送出）经感知 sink。
use crate::dispatcher::reactions::KernelReactionSink;

#[tauri::command(rename_all = "camelCase")]
// clippy 2026-08-02：8 参含 2 个 Tauri 注入（state/window）+ 6 个业务参数（source/content/
// persona/session_prompt/attachments/mcp_servers），send_message 为 IPC 契约签名不可折叠。
// OWNER-02（§5.8）：新增 agent_id 显式路由（9 参，含 3 个 Tauri 注入 + 6 业务参数）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_message<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::Window<R>,
    agent_id: String,
    source: String,
    profile_id: Option<String>,
    content: String,
    persona: String,
    session_prompt: Option<String>,
    attachments: Option<Vec<String>>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
    peri_id: Option<String>,
) -> Result<String, PylonError> {
    // OWNER-02（§5.8）：显式 agentId 路由到 owner runtime——只要求 agent runtime 存在，
    // 不要求会话已存在（send_message 允许自动创建会话）；不存在 owner runtime →
    // agent_runtime_unavailable，绝不 fallback active runtime。
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    // #379：发送前懒重连——Disconnected 的连接先重建再发送（失败如实上抛；
    // 三灯 connecting/回落 + lastError 由 do_connect_and_replace 播报）。
    state
        .inner()
        .ensure_connected_for_send(&runtime, &agent_id, &window)
        .await
        .map_err(PylonError::from)?;
    // G2-05：PromptContext 内联构造（IPC 签名锁定；字段全部 move，零 clone）。
    // peri_id：前端持久化的远端会话 id——内存映射缺失时优先 session/load 复活。
    let ctx = PromptContext {
        source,
        profile_id,
        content,
        persona,
        session_prompt,
        attachments,
        mcp_servers,
        cwd: None,
        known_peri_id: peri_id,
    };
    send_prompt_core(state.inner(), &runtime, Some(&window), &state.gateway, &ctx).await
}

/// A2：流式版本 send_message——前端必携 Channel（on_update），注册后走 Channel
/// 推送（A3 跳过广播）。其余语义与 send_message 完全一致；旧命令 send_message
/// 保留为非流式兼容路径（无 Channel 参数）。
// clippy 2026-09-22：send_message 流式变体，同为 IPC 契约签名（2 Tauri 注入 +
// 9 业务参数 + on_update Channel），不可折叠。
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn send_message_streaming<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::Window<R>,
    agent_id: String,
    source: String,
    profile_id: Option<String>,
    content: String,
    persona: String,
    session_prompt: Option<String>,
    attachments: Option<Vec<String>>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
    peri_id: Option<String>,
    on_update: tauri::ipc::Channel<serde_json::Value>,
) -> Result<String, PylonError> {
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    // #379：同 send_message——懒重连须在 register_update_channel 之前，
    // 重建失败时命令直接拒绝，不留无主 channel 注册。
    state
        .inner()
        .ensure_connected_for_send(&runtime, &agent_id, &window)
        .await
        .map_err(PylonError::from)?;
    runtime.register_update_channel(&source, on_update);
    let ctx = PromptContext {
        source,
        profile_id,
        content,
        persona,
        session_prompt,
        attachments,
        mcp_servers,
        cwd: None,
        known_peri_id: peri_id,
    };
    // 终帧/注销由收尾两路（finalize_response → DONE 帧 / publish_prompt_failure →
    // ERROR 帧）经 send_channel_terminal 完成，不绑本函数生命周期。
    send_prompt_core(state.inner(), &runtime, Some(&window), &state.gateway, &ctx).await
}

/// G2-06：管线运行期载体——阶段函数（ensure_session/prepare/send/finalize）不再
/// 逐参重传。输入借用（state/runtime/window/gateway/ctx），派生产物（peri_id/
/// generation/is_first/message_round/inject_activated/prompt_blocks/request_id）
/// 在管线内逐步填充。
pub(crate) struct PromptFlow<'a, R: tauri::Runtime> {
    pub(crate) state: &'a AppState,
    pub(crate) runtime: &'a Arc<AgentRuntime>,
    pub(crate) window: Option<&'a tauri::Window<R>>,
    pub(crate) gateway: &'a GatewayCore,
    /// B11.1/B11.2 产品缝（#416 W2 wave2 步骤 4）：Prism 回合钩子 port——
    /// 装配点 `send_prompt_core_impl`（`PrismTurnHooks::new(state)`，owned
    /// clone 自 state），prompt 主体不再点名 PrismClient。
    pub(crate) hooks: &'a dyn PromptTurnHooks,
    pub(crate) ctx: &'a PromptContext,
    /// ensure_session 后确定。
    pub(crate) peri_id: String,
    /// prompt_generation（ensure 后快照）。
    pub(crate) generation: u64,
    /// ensure 后确定。
    pub(crate) is_first: bool,
    /// prepare 后确定（inject 回合）。
    pub(crate) message_round: u64,
    /// prepare 后确定（注入命中的来源列表）。
    pub(crate) inject_activated: Vec<String>,
    /// prepare 后确定（prompt blocks，prepare_prompt 消费）。
    pub(crate) prompt_blocks: Vec<serde_json::Value>,
    /// prepare_prompt 后捕获（取消/清理用）。
    pub(crate) request_id: u64,
}

/// R33a：prompt 阶段纯函数——content 构造 + persona 拼接 + B11.1 注入（经
/// `flow.hooks` port，#416 W2 wave2 步骤 4）+ attachments 块构建。G2-06：9 参
/// 收敛为 (&mut PromptFlow) 单参；prompt_blocks/inject_activated/message_round
/// 写入 flow。注入日志（activated/empty/failed）在实现内按原顺序发出；
/// pet/用户事件由调用方在返回后触发——wire/事件顺序不变。
pub(super) async fn prepare_prompt_blocks<R: tauri::Runtime>(
    flow: &mut PromptFlow<'_, R>,
) -> Result<(), PylonError> {
    let state = flow.state;
    let runtime = flow.runtime;
    let source = &flow.ctx.source;
    let content = &flow.ctx.content;
    let is_first = flow.is_first;
    let attachment_paths = flow.ctx.attachments.as_deref().unwrap_or_default();
    let effective_persona = flow
        .ctx
        .session_prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&flow.ctx.persona);

    let prompt_content =
        if is_first && !effective_persona.is_empty() && !content.trim_start().starts_with('/') {
            format!("{}\n\n---\n\n{}", effective_persona, content)
        } else {
            content.to_string()
        };

    // B11.1：发送前置注入钩子（GUI 与平台 ingest 统一入口）——Prism 可用 +
    // gateway 配置开启 + 非命令消息 → POST /inject 拿 context 前置拼进 prompt。
    // Prism 不可用/请求失败 → 降级为不注入（消息照发，fail-open）。
    let message_round = {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(source).map(|s| s.inject_round).unwrap_or(0)
    };
    // B11.1：发送前置注入钩子（GUI 与平台 ingest 统一入口）——#416 W2 wave2
    // 步骤 4 起 prism/gateway 判断、/inject 请求与三分支日志都在 PromptTurnHooks
    // 实现内（本文件不再点名 PrismClient）；fail-open 语义由实现承担，调用点
    // await 至完成。
    let InjectedPrompt {
        prompt_text,
        activated: inject_activated,
    } = flow
        .hooks
        .before_send(source, content, &prompt_content, message_round)
        .await;
    // G1-04 + E-11：附件限制按 runtime 归属 agent 协议配置解析（平台 ingest 绑定
    // agent ≠ GUI active agent 时精确归属，缺省 = 现状 8/10MB，wire 不变）；
    // 未注册 runtime（测试直构形态）回退 active agent（原 G1-04 行为）。
    let limits = match state.agent_for_runtime(runtime) {
        Some(agent) => crate::agent_config::AttachmentLimits::from_agent(&agent),
        None => crate::agent_config::AttachmentLimits::from_agent(&state.get_active_agent()?),
    };
    let prompt_blocks = crate::acp::prompt_blocks(prompt_text, attachment_paths, limits)?;
    flow.message_round = message_round;
    flow.inject_activated = inject_activated;
    flow.prompt_blocks = prompt_blocks;
    Ok(())
}

/// R33b：回合推进纯函数——该 session 用户回合 +1、标记收集回合（dispatcher
/// 据此绑定流式收集）、清空上一回合回复文本（本轮回复由 dispatcher 重新收集）。
/// 必须在发送（send_keep_rx）之前完成（P2-8：发送成功后清空会与 dispatcher
/// 的并行追加竞态：agent 极快响应时本轮回复文本会被清掉）。
pub(super) fn advance_round<R: tauri::Runtime>(flow: &mut PromptFlow<'_, R>) {
    if let Ok(mut sessions) = flow.runtime.sessions.lock() {
        if let Some(session) = sessions.get_mut(&flow.ctx.source) {
            session.inject_round = session.inject_round.saturating_add(1);
            // B11.2：先标记收集回合（dispatcher 据此绑定流式收集），再清空文本。
            session.last_response_round = session.inject_round;
            session.last_response_text.clear();
            // R-t5：上一回合的 activity 不能被当前 prompt 当成“已经收到首个
            // token”。清空后，wait_prompt_with_recovery 会从本次 outbound
            // request 重新等待 first-token 边界；本回合的第一条 update 再写回
            // `last_activity` 续命 idle budget。
            session.last_activity = None;
        }
    }
}

/// G2-05：一次 prompt 发送的不可变输入（来源无关：GUI send_message / 平台 ingest 共用）。
/// 字段 = 原 send_prompt_core 8 个业务参数一对一搬运，零语义变化。
/// E8 封闭：纯 owned 字段（不持 &AppState 引用）——derive Clone/Default 无冲突；
/// 构造点 send_message 全部 move 无 clone，ingest 调用点 source 需 clone（回滚仍用）。
#[derive(Clone, Default)]
pub(crate) struct PromptContext {
    pub(crate) source: String,
    /// GUI owner profile；平台 ingest 没有 UI Profile，保持 None，不做默认猜测。
    pub(crate) profile_id: Option<String>,
    pub(crate) content: String,
    pub(crate) persona: String,
    pub(crate) session_prompt: Option<String>,
    pub(crate) attachments: Option<Vec<String>>,
    pub(crate) mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
    pub(crate) cwd: Option<String>,
    /// 持久化的远端会话 id（GUI send_message 透传；平台 ingest 无）。内存映射
    /// 缺失时用于 ACP session/load 复活原会话，避免静默新建导致上下文丢失。
    pub(crate) known_peri_id: Option<String>,
}

/// 公共发送管线（GUI `send_message` 与 gateway 平台 ingest 共用，B10.3）：
/// per-runtime 会话创建/映射/prompt 锁/等待/cancel/事件广播。
/// 平台 ingest 经 handler 路由到绑定 agent 的 runtime 后调用本函数。
/// `ctx.cwd`：自动建会话时的工作目录——平台路由必须传绑定 agent 的 cwd
/// （绑定 agent ≠ GUI active agent 时 agent_cwd() 会读错）；None 回退 active agent。
/// G2-05：11 参 → 5 参（state/runtime/window/gateway + ctx 上下文对象，E8 封闭）。
pub(crate) async fn send_prompt_core<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    ctx: &PromptContext,
) -> Result<String, PylonError> {
    let mut failure = None;
    // #442 Step2：回合建立后的错误终态帧携带 turn 身份（前端精确归属；回合未
    // 建立 = None，帧缺省该字段）。
    let mut attempted_turn_id = None;
    let result = send_prompt_core_impl(
        state,
        runtime,
        window,
        gateway,
        ctx,
        &mut failure,
        &mut attempted_turn_id,
    )
    .await;
    if let Err(error) = &result {
        // Every known ACP boundary records its own provenance.  A validation
        // or setup error may happen before that boundary; preserve a stable
        // internal source rather than making the UI infer one from prose.
        if failure.is_none() {
            failure = Some(PromptFailureMetadata::internal());
        }
        if let Err(persistence_error) = publish_prompt_failure(
            state,
            runtime,
            window,
            gateway,
            ctx,
            error,
            failure.as_ref(),
            attempted_turn_id,
        )
        .await
        {
            tracing::error!(
                code = persistence_error.code(),
                source = ctx.source,
                original_error = %error,
                persistence_error = %persistence_error,
                "prompt failure could not be committed; failure event was not published"
            );
            return Err(persistence_error);
        }
    }
    result
}

// prompt_lock/prompt_gate 单飞（B3）：同 source/同实例同时刻最多一个 prompt；cancel 闭包同持 acp 锁（方案 5）
async fn send_prompt_core_impl<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    ctx: &PromptContext,
    failure: &mut Option<PromptFailureMetadata>,
    // #442 Step2：回合建立后的错误终态经此透出 turn 身份（回合未建立保持 None，
    // error 帧缺省不伪造）。
    attempted_turn_id: &mut Option<u64>,
) -> Result<String, PylonError> {
    // 解构 ctx 业务参数（引用形态，管线内只读；session_prompt 由 prepare_prompt_blocks
    // 经 flow.ctx 直接读取，不在本函数体内消费）。
    let PromptContext {
        source,
        profile_id,
        content,
        persona,
        attachments,
        mcp_servers,
        cwd,
        ..
    } = ctx;
    // B1：GUI source 不得冒名平台源——is_platform_source（注册适配器 OR 绑定命中）
    // 且无 binding → 拒绝（防冒名出站投递到 QQ）。平台 ingest 的 qq:* 必带 binding
    // （绑定命中），不受影响。G4 §3-9（C4）：E14 语义——QQ 适配器未注册时 qq:*
    // 未绑定源放行（无注册 = 无投递路径，安全等价）。
    if gateway.is_platform_source(source) && gateway.binding(source).is_none() {
        return Err(PylonError::Protocol(format!(
            "invalid GUI source: {source}"
        )));
    }
    state.log_runtime_summary(
        "info",
        "prompt",
        Some(source.to_string()),
        "Prompt started",
        serde_json::Map::from_iter([
            (
                "contentLength".to_string(),
                serde_json::Value::from(content.len()),
            ),
            (
                "attachmentCount".to_string(),
                serde_json::Value::from(attachments.as_deref().map_or(0, <[String]>::len)),
            ),
        ]),
    );
    // P1（E10）：GUI 显式 mcp_servers（前端每消息下发）直校验；None（平台 ingest
    // 路径）走 mcp_wire 缓存——命中零重算，miss 回退全量重算并回填（E3 自愈）。
    let requested_mcp_servers = match mcp_servers {
        Some(servers) => mcp::validate_and_serialize(Some(servers.clone()))?,
        None => state.wire_mcp_servers()?,
    };
    let prompt_lock = prompt_lock_for(&runtime.prompt_locks, source);
    let _prompt_guard = HeldAcrossAwait::new(prompt_lock.lock().await);
    // B3（§4.4）：同一实例同一时刻最多一个 prompt——跨 source 的第二个并发
    // prompt 立即失败（稳定码），不排队：排队会让两条对话在用户看不到的地
    // 方互相阻塞，超限显形比静默串行可诊断。
    let _instance_prompt_gate =
        HeldAcrossAwait::new(runtime.prompt_gate.clone().try_lock_owned().map_err(|_| {
            PylonError::Protocol("prompt_in_progress: 该 Agent 实例已有进行中的 prompt".to_string())
        })?);

    // G2-08 锁合并：updated_at 刷新移入 ensure_session_mapping 的存在性读取
    // （guard 内一次 sessions.lock() 完成"刷新 + 存在性读取 + is_first"）——
    // E10 拍板接受的行为差异：crashed 早退路径不再刷新 updated_at（发送失败的
    // 消息不再计为活动，仅崩溃路径可见，语义更正确）。

    if runtime.snapshot_acp().is_crashed() {
        return Err(PylonError::AgentCrashed);
    }

    // G2-04：会话建立/复用收敛——ensure_session_mapping（复用优先）→
    // create_session_slot（自动建会话，E7 拍板 close_replaced=true）。
    // P1-1：会话 cwd 优先取调用方显式绑定（平台路由 = 绑定 agent 的 cwd，
    // 可能 ≠ GUI active agent）；无则回退 active agent cwd。
    let session_cwd = cwd
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| state.agent_cwd());
    let (peri_id, is_first) = {
        // 方案 I：session/new（建会话/复用）失败必须立即向前端广播 pylon:error，
        // 不能静默传播 Err——否则用户看到的是"消息滞留 + 生成指示器空转"而非明确错误
        // （Hermes 无 provider/401 等均在此时失败）。错误同时进 runtime 日志带上下文。
        // 持久化 peri_id（Pylon 重启后内存映射为空）：优先 ACP session/load 复活
        // 原会话；仅当复活失败（远端会话已死）才新建，并向前端广播新会话事实。
        let revived_peri_id = ctx.known_peri_id.clone().filter(|id| !id.is_empty());
        // Recreated-session notice is emitted after ensure returns (holding a
        // &dyn callback across the await would make the command future
        // non-Send); the callback is replaced by a plain Option<String> out.
        let mut recreated_peri_id: Option<String> = None;
        // #335/U1b：装配参数收敛为结构体；具名绑定（借用须跨 await 存活，
        // 语句级临时不可用）。
        let assembly = SessionAssembly {
            state,
            runtime,
            source,
            profile_id: profile_id.as_deref(),
            persona,
            session_cwd: &session_cwd,
            wire_mcp_servers: &requested_mcp_servers,
        };
        let mapping = match ensure_session_mapping(
            &assembly,
            revived_peri_id.as_deref(),
            &mut recreated_peri_id,
        )
        .await
        {
            Ok(mapping) => mapping,
            Err(error) => {
                let message = error.to_string();
                // #425 件6：发起路径错误位点经 sink（原 `pet::on_error` 直呼点）。
                crate::dispatcher::reactions::PetReactionSink::new(state.pet.clone())
                    .on_prompt_error();
                state.log_runtime_summary(
                    "error",
                    "prompt",
                    Some(source.to_string()),
                    "Prompt session ensure failed",
                    serde_json::Map::from_iter([(
                        "error".to_string(),
                        serde_json::Value::String(message.clone()),
                    )]),
                );
                return Err(PylonError::Protocol(message));
            }
        };
        if let Some(new_peri_id) = &recreated_peri_id {
            if let Some(window) = window {
                crate::emit_event(
                    window,
                    "pylon:session-recreated",
                    serde_json::json!({
                        "source": source,
                        "periId": new_peri_id,
                    }),
                );
            }
        }
        (mapping.peri_id, mapping.is_first)
    };

    // G2-06：管线阶段载体（PromptFlow）——派生字段由阶段函数逐步填充。
    // #416 W2 wave2 步骤 4：Prism 回合钩子随 flow 注入（owned clone 自 state，
    // 借用生命周期覆盖 flow 全部阶段；不新增全局态、不 spawn）。
    let turn_hooks = PrismTurnHooks::new(state);
    let mut flow = PromptFlow {
        state,
        runtime,
        window,
        gateway,
        ctx,
        hooks: &turn_hooks,
        peri_id,
        generation: state.current_generation(runtime),
        is_first,
        message_round: 0,
        inject_activated: Vec::new(),
        prompt_blocks: Vec::new(),
        request_id: 0,
    };

    let committed_user_event = ingest_prompt_event(
        state,
        runtime,
        source,
        Some(flow.peri_id.clone()),
        flow.generation,
        serde_json::json!({
            "source": source,
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "text": content },
            }
        }),
    )
    .await?;

    // R33a：content 构造 + persona 拼接 + B11.1 注入 + attachments 块构建。
    // API 1.3：context.beforeBuild 观察锚点（构建前，spawn 不阻塞发送链）。
    crate::hook_bridge::spawn_notification_hook(
        state.hook_bridge.clone(),
        window.cloned(),
        crate::hook_bridge::HOOK_CONTEXT_BEFORE_BUILD,
        source.to_string(),
        serde_json::json!({ "source": source, "phase": "before" }),
    );
    prepare_prompt_blocks(&mut flow).await?;

    // API 1.3：context.afterBuild 观察锚点（构建成功后，携带块数）。
    crate::hook_bridge::spawn_notification_hook(
        state.hook_bridge.clone(),
        window.cloned(),
        crate::hook_bridge::HOOK_CONTEXT_AFTER_BUILD,
        source.to_string(),
        serde_json::json!({
            "source": source,
            "phase": "after",
            "blockCount": flow.prompt_blocks.len(),
        }),
    );

    // #425 件6：用户消息已送出位点经 sink（原 `pet::on_user_sent` 直呼点）。
    crate::dispatcher::reactions::PetReactionSink::new(state.pet.clone()).on_user_sent();
    {
        let mut user_payload = serde_json::json!({ "source": source, "content": content });
        if !flow.inject_activated.is_empty() {
            user_payload["injectActivated"] = serde_json::Value::Array(
                flow.inject_activated
                    .iter()
                    .map(|item| serde_json::Value::String(item.clone()))
                    .collect(),
            );
        }
        if let Some(committed_event) = committed_user_event {
            user_payload["canonicalEvent"] = serde_json::to_value(committed_event)?;
        }
        // B1（传输收敛）：已注册 Channel 的 GUI 会话走信封帧单轨；未注册
        // （平台 ingest / 未升级前端）保留广播。user echo 与 update 同构。
        // 注意：必须用非破坏性 send_update_frame——此处会话尚未结束，take 注销
        // 会让后续 update/done 流失去通道（前端 C2 已拆广播 listen → 断流）。
        let frame = serde_json::json!({
            "event": crate::event_names::USER_ECHO,
            "payload": user_payload,
        });
        if !runtime.send_update_frame(source, frame) {
            if let Some(window) = window {
                emit_event(window, crate::event_names::USER_ECHO, user_payload);
            }
        }
    }
    // Start the monotonic prompt clock immediately before the outbound ACP
    // request.  Setup/validation time is not presented as provider waiting
    // time, while transport failures still retain a useful elapsed sample.
    // P55-D1 #1：message.user.beforeSend 钩子缝（prepare_prompt_blocks 之后、
    // 出站之前）。transform → 只改写 wire 出站 prompt_blocks（journal 原文行
    // 已在上方 ingest_prompt_event 落库，B7 双轨）；gate → 返回拒绝错误；
    // 超时/桥未就绪/前端无应答 → 放行原文（fail-open，对齐 Prism inject 先例）。
    match crate::hook_bridge::before_send_hook_outcome(
        state,
        window,
        source,
        content,
        &flow.prompt_blocks,
    )
    .await
    {
        crate::hook_bridge::BeforeSendDecision::PassThrough => {}
        crate::hook_bridge::BeforeSendDecision::Transformed(blocks) => {
            state.log_runtime_summary(
                "info",
                "hook",
                Some(source.to_string()),
                "message.user.beforeSend hook rewired outbound prompt",
                serde_json::Map::from_iter([(
                    "blockCount".to_string(),
                    serde_json::Value::from(blocks.len()),
                )]),
            );
            flow.prompt_blocks = blocks;
        }
        crate::hook_bridge::BeforeSendDecision::Blocked(reason) => {
            return Err(PylonError::Protocol(format!(
                "message.user.beforeSend hook blocked message: {reason}"
            )));
        }
    }
    let prompt_started_at = std::time::Instant::now();
    let rpc = {
        let acp = runtime.snapshot_acp();
        acp.prepare_prompt(&flow.peri_id, std::mem::take(&mut flow.prompt_blocks))?
    };
    // 取消/连接关闭分支清理 pending 仍需 request_id（send_keep_rx 会消费 rpc）。
    flow.request_id = rpc.id;
    // R33b：回合推进（该 session 用户回合 +1、标记收集回合、清空回复文本）。
    // P2-8：必须在发送（send_keep_rx）之前完成，见 advance_round 说明。
    advance_round(&mut flow);
    // R3：send_keep_rx 统一 10s 写超时（对齐 complete 路径；原裸 write_tx.send 在
    // writer 阻塞 + 队列满时会无限挂起），失败已清理 pending，只收敛会话映射。
    let mut rx = match rpc.send_keep_rx().await {
        Ok(rx) => rx,
        Err(error) => {
            *failure = Some(failure_for_acp_error(
                &error,
                Some(elapsed_millis(prompt_started_at)),
            ));
            let _ =
                state.remove_session_if_matches(runtime, source, &flow.peri_id, flow.generation);
            return Err(PylonError::from(error));
        }
    };
    // #99：出站成功即回合在账本登记（Prompting 起点）；后续每条路径都必须
    // 收敛到唯一终态（CAS 保证重复结算只计诊断）。
    let turn_key = TurnKey {
        local_session_id: source.to_string(),
        remote_session_id: flow.peri_id.clone(),
        generation: flow.generation,
        turn_id: flow.request_id,
    };
    // #442 Step2：终帧 additive turnId 的事实来源——回合已建立后发生的任何错误
    // 终态，error 帧都携带本回合身份（前端 stamps 猜测在字段可用时退役）。
    *attempted_turn_id = Some(turn_key.turn_id);
    if let crate::acp::BeginOutcome::AlreadyActive =
        runtime.turn_ledger.begin(turn_key.clone(), now_ms())
    {
        tracing::warn!(
            turn_id = flow.request_id,
            "duplicate turn begin in ledger; keeping original registration"
        );
    }
    // #420/ADR-0034：在途事实由上方 ledger.begin 单源承载（SessionInfo 不再镜像）；
    // 此处只保留 mark 的幸存职责——#352 新回合起点清除旧回合的 cancel 判死输入。
    if let Ok(mut sessions) = runtime.sessions.lock() {
        if let Some(session) = sessions.get_mut(source) {
            session.clear_cancel_requested_for_new_turn();
        }
    }
    let acp_for_cancel = runtime.acp.clone();
    let peri_id_for_cancel = flow.peri_id.clone();
    // API 1.3：turn.started 观察锚点——出站成功即回合开始（spawn 不阻塞响应等待）。
    crate::hook_bridge::spawn_notification_hook(
        state.hook_bridge.clone(),
        window.cloned(),
        crate::hook_bridge::HOOK_TURN_STARTED,
        source.to_string(),
        serde_json::json!({ "source": source, "periId": flow.peri_id }),
    );
    // G2-06：超时参数化（per-agent 协议配置，缺省 300/30 = 现状常量值）。
    let protocol = state.protocol_for_runtime(runtime);
    let cancel_settle_timeout_secs = protocol.cancel_settle_timeout();
    let idle_timeout_secs = protocol.idle_timeout();
    let first_token_timeout_secs = protocol.first_token_timeout();
    // Only the Hermes/Windows runtime owns the force-recovery path.  The
    // generic ACP transport keeps its historical cancel-only behavior for
    // Peri and custom agents.
    let hermes_force_recovery = state
        .agent_for_runtime(runtime)
        .is_some_and(|agent| crate::hermes::runtime::should_apply(&agent));
    let runtime_for_recovery = runtime.clone();
    let expected_generation = flow.generation;
    // #352：用户 cancel 一等判死输入——cancel_prompt 置位后，等待循环跳过
    // 闲置/首 token 评估直接进入 cancel-settle 窗口；agent cancel 后继续产出
    // 刷新 last_activity 不再能推迟收敛（flag 命中后完全绕开 liveness 评估）。
    // 探针只认本代际置位（构造器内注释详述锁形态与键化）。
    let cancel_requested =
        cancel_requested_probe(runtime.clone(), source.to_string(), expected_generation);
    // R-t5：liveness 探针——读本会话最近一次 ACP 活动时刻（dispatcher 刷新）。
    // 用作"闲置超时"判据：活动即续命，只有持续无输出才截。
    let source_for_liveness = source.to_string();
    let liveness_activity = move || {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string()).ok()?;
        sessions
            .get(&source_for_liveness)
            .and_then(|s| s.last_activity)
    };
    let result = acp::wait_prompt_with_recovery(
        &mut rx,
        Duration::from_secs(cancel_settle_timeout_secs),
        Duration::from_secs(idle_timeout_secs),
        Duration::from_secs(first_token_timeout_secs),
        liveness_activity,
        cancel_requested,
        move || async move {
            // R6e：cancel 闭包契约是 Result<(), String>（wait_prompt_with_recovery 泛型边界）
            // #549/ADR-0037：cancel 走快照客户端的私有通道，写入只可能落在被解析
            // 的这一连接；replacement 换装后旧客户端被 kill，通道关闭即失败返回。
            // 快照先绑定——读守卫不得活过下方 await（std 守卫非 Send，跨 await
            // 会直接编译失败）。
            let acp = acp_for_cancel
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            acp.cancel_session(&peri_id_for_cancel)
                .await
                .map_err(|e| e.to_string())
        },
        move || async move {
            if !hermes_force_recovery {
                return;
            }
            // #549/ADR-0037：快照解析 + 客户端自带 generation 自校验——要杀的就是
            // 快照里这个客户端。即使 reconnect 在快照后换装，杀的也是旧连接
            //（新连接不受影响）；「reconnect 赢了就不杀」由代际自校验保留。
            let acp = runtime_for_recovery.snapshot_acp();
            let current_generation = acp.client_generation();
            if current_generation != expected_generation {
                tracing::debug!(
                    expected_generation,
                    current_generation,
                    "skip Hermes force recovery for stale prompt generation"
                );
                return;
            }
            if acp.is_crashed() {
                return;
            }
            if let Err(error) = acp.kill() {
                tracing::warn!("Hermes force recovery could not kill ACP child: {error}");
            } else {
                tracing::warn!(
                    expected_generation,
                    "Hermes ACP child force-killed after cancel did not settle"
                );
            }
        },
    )
    .await;

    match result {
        PromptWaitOutcome::Response(raw) => {
            settle_prompt_response(
                state,
                runtime,
                source,
                &mut flow,
                &turn_key,
                raw,
                prompt_started_at,
                failure,
            )
            .await
        }
        PromptWaitOutcome::ConnectionClosed => {
            settle_prompt_connection_closed(
                state,
                runtime,
                source,
                &flow,
                &turn_key,
                prompt_started_at,
                failure,
            )
            .await
        }
        PromptWaitOutcome::CancelledAfterTimeout {
            response,
            cancel_error,
            timeout_kind,
            timeout_bound,
            elapsed,
            settle,
        } => {
            settle_prompt_cancelled_after_timeout(
                state,
                runtime,
                source,
                &flow,
                &turn_key,
                response,
                cancel_error,
                timeout_kind,
                timeout_bound,
                elapsed,
                settle,
                cancel_settle_timeout_secs,
                protocol.prompt_timeout(),
                failure,
            )
            .await
        }
    }
}
