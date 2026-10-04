//! 会话创建域：槽位替换 / session/new / 建立与复用。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

mod revive;

use super::*;
use pylon_foundations::await_guard::HeldAcrossAwait;
use revive::revive_session_slot;
/// R32：会话槽位替换——上限检查 + 插入新 SessionInfo +
/// 返回被替换的旧会话（None = 新槽位）。`allow_same_source_replace`：
/// true = 同 source 替换不占新名额（load_persisted_session 既有语义）；
/// false = 满额即拒绝，无论是否替换（new_session 既有语义）。
/// G2-07：上限参数化（E9 拍板 per-agent——调用方传 SessionSlotPolicy::default()
/// 解析值，每 runtime 100；G1 acp.max_sessions 落地后按 agent 解析覆盖）。
/// 检查与插入在同一写锁内完成；会话创建路径由 session_creation 串行化，
/// 与原先"读锁检查 + 写锁插入"行为等价。
pub(crate) fn replace_session_slot(
    runtime: &AgentRuntime,
    source: &str,
    session: SessionInfo,
    allow_same_source_replace: bool,
    max_sessions: usize,
) -> Result<Option<SessionInfo>, PylonError> {
    // 方案 8：委托 SessionStore（满额策略 + mapping_ready 通知 + 锁序纪律）。
    crate::session::store::insert(
        runtime,
        source,
        session,
        allow_same_source_replace,
        max_sessions,
    )
    .map_err(|e| PylonError::Protocol(e.to_string()))
}

/// G2-04：会话建立结果——peri_id + 是否首轮 + session/new 原始响应（new_session 命令回传前端）。
pub(crate) struct SessionMapping {
    pub(crate) peri_id: String,
    pub(crate) is_first: bool,
    pub(crate) new_response: Option<serde_json::Value>,
}

/// Return a non-empty string from the common ACP scalar/nested value shapes.
/// Providers disagree on whether a selected value is encoded as a plain
/// string, `{value: ...}`, or `{valueId: {value: ...}}`; initial-session
/// negotiation must understand all of them without stringifying objects.
fn response_string(value: &serde_json::Value) -> Option<String> {
    super::value_as_string(value)
}

fn option_identity(option: &serde_json::Value) -> Option<String> {
    let object = option.as_object()?;
    let keys = [
        "configId",
        "config_id",
        "optionId",
        "option_id",
        "id",
        "key",
        "name",
    ];
    keys.into_iter().find_map(|wanted| {
        object
            .iter()
            .find(|(key, _)| loose_normalized_key(key) == loose_normalized_key(wanted))
            .and_then(|(_, value)| response_string(value))
    })
}

fn option_text(option: &serde_json::Value) -> String {
    [
        "id",
        "key",
        "configId",
        "config_id",
        "optionId",
        "option_id",
        "name",
        "label",
        "title",
        "description",
        "category",
        "semantic",
        "valueType",
        "value_type",
    ]
    .into_iter()
    .filter_map(|key| option.get(key).and_then(response_string))
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
}

fn option_choices(option: &serde_json::Value) -> Vec<String> {
    // ACP implementations have used each of these names in the wild.  The
    // recursive walk also handles a JSON-schema `{schema: {enum: [...]}}`.
    // 递归骨架与 model.rs 的 P56/D1 machine-id 轨共享（collect_config_choice_values）；
    // 本轨宽容提取后排序去重，键序对输出无影响——共享骨架输出逐字节等价（#261）。
    let mut values = Vec::new();
    collect_config_choice_values(option, response_string, &mut values);
    values.sort();
    values.dedup();
    values
}

/// Locate a writable reasoning/thinking config option advertised by an ACP
/// agent.  `None` deliberately means "capability not advertised"; callers
/// must not turn the Hermes permission modes into a fake thinking setting.
/// When choices are advertised, the requested wire id must be one of them.
pub(crate) fn find_reasoning_option_id(
    options: &[serde_json::Value],
    requested: &str,
) -> Option<String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return None;
    }
    fn comparable(value: &str) -> String {
        value
            .chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    }
    fn score(option: &serde_json::Value) -> i32 {
        let object = match option.as_object() {
            Some(object) => object,
            None => return 0,
        };
        let mut score = 0;
        for key in [
            "configId",
            "config_id",
            "optionId",
            "option_id",
            "id",
            "key",
        ] {
            if let Some(value) = object.get(key).and_then(response_string) {
                let token = comparable(&value);
                if [
                    "reasoning",
                    "reasoningeffort",
                    "thinking",
                    "thought",
                    "thoughtlevel",
                    "effort",
                ]
                .iter()
                .any(|marker| token == *marker)
                {
                    score = score.max(100);
                } else if ["reason", "think", "thought", "effort"]
                    .iter()
                    .any(|marker| token.contains(marker))
                {
                    score = score.max(70);
                }
            }
        }
        for key in [
            "category",
            "name",
            "label",
            "title",
            "description",
            "semantic",
        ] {
            if let Some(value) = object.get(key).and_then(response_string) {
                let token = comparable(&value);
                if [
                    "reasoning",
                    "reasoningeffort",
                    "thinking",
                    "thought",
                    "thoughtlevel",
                    "effort",
                ]
                .iter()
                .any(|marker| token == *marker)
                {
                    score = score.max(80);
                } else if ["reason", "think", "thought", "effort"]
                    .iter()
                    .any(|marker| token.contains(marker))
                {
                    score = score.max(50);
                }
            }
        }
        // A temperature/tuning slider is not a thinking level even when its
        // presentation label happens to contain the word "reasoning".
        if object
            .iter()
            .filter_map(|(_, value)| value.as_str())
            .any(|value| comparable(value).contains("temperature"))
            && score < 100
        {
            score -= 30;
        }
        score
    }
    let mut candidates: Vec<(i32, usize, String)> = options
        .iter()
        .enumerate()
        .filter_map(|(index, option)| {
            let object = option.as_object()?;
            let semantic = option_text(option);
            let semantic_match = [
                "reason",
                "reasoning",
                "think",
                "thinking",
                "thought",
                "effort",
                "推理",
                "思考",
            ]
            .iter()
            .any(|marker| semantic.contains(marker));
            let rank = score(option);
            if !semantic_match && rank <= 0 {
                return None;
            }
            let read_only = ["readOnly", "readonly", "read_only"]
                .into_iter()
                .any(|key| object.get(key).and_then(serde_json::Value::as_bool) == Some(true))
                || object.get("editable").and_then(serde_json::Value::as_bool) == Some(false);
            if read_only {
                return None;
            }
            let id = option_identity(option)?;
            let choices = option_choices(option);
            if !choices.is_empty()
                && !choices
                    .iter()
                    .any(|choice| comparable(choice) == comparable(requested))
            {
                return None;
            }
            Some((rank.max(1), index, id))
        })
        .collect();
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    candidates.into_iter().next().map(|(_, _, id)| id)
}

fn merge_response_value(base: &mut serde_json::Value, patch: serde_json::Value) {
    let (Some(base_object), Some(patch_object)) = (base.as_object_mut(), patch.as_object()) else {
        *base = patch;
        return;
    };
    for (key, value) in patch_object {
        // An empty configOptions response is common for set_model/set_mode;
        // retaining the session/new catalogue avoids erasing selectors.
        if key == "configOptions"
            && value.as_array().is_some_and(|values| values.is_empty())
            && base_object
                .get(key)
                .and_then(serde_json::Value::as_array)
                .is_some_and(|values| !values.is_empty())
        {
            continue;
        }
        if let Some(existing) = base_object.get_mut(key) {
            if existing.is_object() && value.is_object() {
                merge_response_value(existing, value.clone());
                continue;
            }
        }
        base_object.insert(key.clone(), value.clone());
    }
}

fn set_response_current(response: &mut serde_json::Value, section: &str, key: &str, value: &str) {
    let Some(root) = response.as_object_mut() else {
        return;
    };
    let section_value = root
        .entry(section.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(section_object) = section_value.as_object_mut() {
        section_object.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
}

fn set_config_option_current(response: &mut serde_json::Value, key: &str, value: &str) {
    let options_value = if response.get("configOptions").is_some() {
        response.get_mut("configOptions")
    } else {
        response.get_mut("config_options")
    };
    let Some(options) = options_value.and_then(serde_json::Value::as_array_mut) else {
        return;
    };
    for option in options {
        let matches =
            option_identity(option).is_some_and(|candidate| candidate.eq_ignore_ascii_case(key));
        if matches {
            if let Some(object) = option.as_object_mut() {
                object.insert(
                    "currentValue".to_string(),
                    serde_json::Value::String(value.to_string()),
                );
            }
            break;
        }
    }
}

fn merge_setting_response(
    response: &mut serde_json::Value,
    setting_response: serde_json::Value,
    section: &str,
    current_key: &str,
    option_key: &str,
    value: &str,
) {
    // Inspect the *fresh* acknowledgement before merging it into the session/new
    // snapshot.  The snapshot may already contain the agent default (for Hermes,
    // often V4.1); treating that as an acknowledgement would discard the user's
    // requested V4 Flash when Hermes returns `{}`.
    let acknowledged = setting_response
        .get(section)
        .and_then(|section| section.get(current_key))
        .is_some_and(|current| !current.is_null())
        || setting_response
            .get("configOptions")
            .or_else(|| setting_response.get("config_options"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|options| {
                options.iter().any(|option| {
                    option_identity(option).is_some_and(|id| id.eq_ignore_ascii_case(option_key))
                        && ["currentValue", "current_value", "value"]
                            .iter()
                            .any(|key| option.get(*key).is_some_and(|value| !value.is_null()))
                })
            });
    merge_response_value(response, setting_response);

    // Empty acknowledgements have no authoritative value, so the requested
    // machine id is the confirmed value.  Keep the models and configOptions
    // projections converged for callers that read either representation.
    let confirmed = if acknowledged {
        response
            .get(section)
            .and_then(|section| section.get(current_key))
            .and_then(serde_json::Value::as_str)
            .unwrap_or(value)
    } else {
        value
    }
    .to_string();
    set_response_current(response, section, current_key, &confirmed);
    set_config_option_current(response, option_key, &confirmed);
}

fn merge_config_setting_response(
    response: &mut serde_json::Value,
    setting_response: serde_json::Value,
    option_key: &str,
    value: &str,
) {
    merge_response_value(response, setting_response);
    set_config_option_current(response, option_key, value);
}

/// #110 F5：会话建立时的「生效模型」解析（纯函数，便于定点测试）。
///
/// 优先级（用户裁决 2026-09-16）：`agents.yaml` 的 agent 显式 `model` > 建立请求携带的
/// `model`（profile 缺省）> 响应回显的权威 current model。全空/全空白 → `None`
/// （调用方不得伪造模型事实）。
pub(crate) fn resolve_established_model<'a>(
    agent_model: Option<&'a str>,
    requested_model: Option<&'a str>,
    response_model: Option<&'a str>,
) -> Option<&'a str> {
    [agent_model, requested_model, response_model]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
}

/// #110 F5：把建立期的生效模型写进 canonical journal（`session.model-updated`）。
///
/// 走 dispatcher 同一 ingest 通道（`EventService::ingest_event` + 同一 normalizer），
/// 因此 raw 形状就是标准 `session/update` 包——冷挂载重放与 live 消费读同一份事实。
/// 失败只记 warn：模型事实缺失不得让一个已经建立成功的会话失败。
async fn ingest_established_model_event(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    peri_id: &str,
    generation: u64,
    model: &str,
) -> Option<CanonicalEventRow> {
    let owner = {
        let agent_id = state.agent_id_for_runtime(runtime)?;
        let sessions = runtime.sessions.lock().ok()?;
        let session = sessions.get(source)?;
        session.durable_owner(&agent_id, source).ok()?
    }?;
    let raw_payload = serde_json::json!({
        "sessionId": peri_id,
        "update": {
            "sessionUpdate": "session_info_update",
            "model": model,
        },
    });
    match event_service_of(state) {
        Ok(service) => match service
            .ingest_event(owner, Some(peri_id.to_string()), generation, raw_payload)
            .await
        {
            Ok(result) => result.events.into_iter().next(),
            Err(error) => {
                tracing::warn!(
                    source = source,
                    model = model,
                    "建立期模型事实写入 journal 失败：{error}"
                );
                None
            }
        },
        Err(error) => {
            tracing::warn!(
                source = source,
                "建立期模型事实写入 journal 跳过（事件库不可用）：{error}"
            );
            None
        }
    }
}

/// #51：把建立/恢复期的完整 configOptions 选择器面写进 canonical journal
/// （`session.config-updated`）。
///
/// 与 [`ingest_established_model_event`] 同一模式：raw 形状是标准 `session/update`
/// 包，live 与冷挂载重放读同一份事实——重启后打开历史会话时，中控区选择器
/// （model choices / reasoning / mode）由此恢复。`options` 为空不写（空数组对
/// projector 是"广告了零项"，会与"尚未宣告"混淆）；超过 D97-4 envelope 上限不写，
/// 只告警。journal 已持有相同 configOptions 时跳过（#51 收口：重复 load/revive
/// 不得逐次追加膨胀 journal）；去重查询失败 fail-open 继续追加。失败仅记 warn：
/// 选择器事实缺失不得让已成功的建立/恢复失败。
pub(crate) async fn ingest_established_config_options_event(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    peri_id: &str,
    generation: u64,
    options: &[serde_json::Value],
) -> Option<CanonicalEventRow> {
    if options.is_empty() {
        return None;
    }
    // D97-4 同款有界原则：选择器 envelope 超 UPPER 时不入 journal，防止极端
    // agent 的大响应把 journal 行撑爆（raw 语义保真让位于 journal 健康）。
    let serialized = serde_json::to_string(options).ok()?;
    if serialized.len() > super::model::SELECTOR_ENVELOPE_MAX_BYTES {
        tracing::warn!(
            source = source,
            bytes = serialized.len(),
            "established configOptions envelope exceeds selector journal bound; skipped"
        );
        return None;
    }
    let owner = {
        let agent_id = state.agent_id_for_runtime(runtime)?;
        let sessions = runtime.sessions.lock().ok()?;
        let session = sessions.get(source)?;
        session.durable_owner(&agent_id, source).ok()?
    }?;
    let service = match event_service_of(state) {
        Ok(service) => service,
        Err(error) => {
            tracing::warn!(
                source = source,
                "建立期选择器事实写入 journal 跳过（事件库不可用）：{error}"
            );
            return None;
        }
    };
    // #51 收口：journal 已持有相同选择器面时不再重复追加。重复打开同一历史
    // 会话的每次 load / revive / 重建都会走到这里，逐次追加会让 journal 随
    // 打开次数线性膨胀；重放按「最后一次覆盖」消费选择器面，payload 相同即
    // 投影相同，跳过是安全的。查询失败按未命中处理（fail-open，退回追加）。
    match owner.key() {
        Ok(owner_key) => {
            match service
                .latest_event_of_type(owner_key, "session.config-updated")
                .await
            {
                Ok(Some(existing))
                    if established_options_unchanged(&existing.raw_payload, options) =>
                {
                    tracing::debug!(
                        source = source,
                        "configOptions unchanged; skip duplicate selector journal append"
                    );
                    return None;
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(source = source, "选择器面去重查询失败，继续追加：{error}")
                }
            }
        }
        Err(error) => tracing::warn!(
            source = source,
            "选择器面去重缺 owner key，继续追加：{error}"
        ),
    }
    let raw_payload = serde_json::json!({
        "sessionId": peri_id,
        "update": {
            "sessionUpdate": "config_option_update",
            "configOptions": options,
        },
    });
    match service
        .ingest_event(owner, Some(peri_id.to_string()), generation, raw_payload)
        .await
    {
        Ok(result) => result.events.into_iter().next(),
        Err(error) => {
            tracing::warn!(
                source = source,
                "建立期选择器事实写入 journal 失败：{error}"
            );
            None
        }
    }
}

/// #51 收口：journal 已存行与本次 `options` 的选择器面是否相同（结构相等）。
/// 只比 `update.configOptions` 数组本身；rawPayload 其余字段（sessionId、
/// sessionUpdate 判别符）是写入包装，不参与投影。解析不出 configOptions
/// 视为不同——宁可多写一条，不冒丢面风险。
fn established_options_unchanged(
    stored_raw: &serde_json::Value,
    options: &[serde_json::Value],
) -> bool {
    stored_raw
        .get("update")
        .and_then(|update| update.get("configOptions"))
        .is_some_and(|stored| stored == &serde_json::Value::Array(options.to_vec()))
}

/// 从建立/恢复响应里提取权威 configOptions envelope（camel/snake 双形）。
/// Journal projection only: retain legacy selector catalogues alongside standard
/// options. Do not use this synthesized list to infer outbound ACP methods.
pub(crate) fn response_projection_options(response: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut options = response_config_options(response);
    for (kind, state_key, choices_key, current_key) in [
        ("model", "models", "availableModels", "currentModelId"),
        ("mode", "modes", "availableModes", "currentModeId"),
    ] {
        if super::find_config_option(&options, kind).is_some() {
            continue;
        }
        let selection = response.get(state_key).unwrap_or(response);
        let snake_choices = if kind == "model" {
            "available_models"
        } else {
            "available_modes"
        };
        let snake_current = if kind == "model" {
            "current_model_id"
        } else {
            "current_mode_id"
        };
        let choices = selection
            .get(choices_key)
            .or_else(|| selection.get(snake_choices))
            .and_then(serde_json::Value::as_array);
        let current = selection
            .get(current_key)
            .or_else(|| selection.get(snake_current));
        if choices.is_none() && current.is_none() {
            continue;
        }
        let mut option = serde_json::json!({"id":kind,"name":kind,"category":kind,"type":"select",
            "options":choices.cloned().unwrap_or_default(),"_meta":{"pylonLegacySelector":true}});
        if let Some(value) = current {
            option["currentValue"] = value.clone();
        }
        options.push(option);
    }
    options
}

pub(crate) fn response_config_options(response: &serde_json::Value) -> Vec<serde_json::Value> {
    response
        .get("configOptions")
        .or_else(|| response.get("config_options"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// P56/D1：初值 model 下发计划（纯函数便于测试；执行侧见 apply_initial_session_options）。
#[derive(Debug)]
pub(crate) enum InitialModelAction {
    /// 走 session/set_config_option（configId 用宣告值，D1.5）。
    SendConfigOption { config_id: String },
    /// 走 session/set_model（hermes unstable 通道，原样回发宣告 id）。
    SendSetModel,
    /// 跳过下发（未宣告模型面 / 目标不在宣告列表），不阻断建会话（D1.4）。
    Skip { code: &'static str, message: String },
}

/// P56/D1.3/D1.4：初值 model 计划——显式 `set_model_api` 声明优先（现状通道语义；
/// Disabled 声明保留现状硬错），未声明按响应判定的 model_surface 路由；两条通道
/// 统一施加发送校验：目标 ∉ 宣告 choices（或无宣告面）→ Skip（warn 上报
/// `model_not_advertised`），不再把裸 id 发上 wire。
fn plan_initial_model(
    response: &serde_json::Value,
    model: &str,
    declared: Option<crate::agent_config::SetModelApi>,
) -> Result<InitialModelAction, PylonError> {
    use crate::agent_config::ModelSwitchTarget;
    // #97/D97-1：models 状态统一走 response_models_state——嵌套 `models` 与根级
    // availableModels/available_models 等价进入规划，与 SessionInfo 响应刷新、
    // 异步 session_info_update 共用同一套模型面解析规则（验收 1）。
    let model_surface = super::response_models_state(response);
    let info = super::determine_model_surface(
        response
            .get("configOptions")
            .or_else(|| response.get("config_options"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        model_surface,
    );
    let validate = |action: InitialModelAction| -> InitialModelAction {
        if info.choices.is_empty() || info.choices.iter().any(|choice| choice == model) {
            action
        } else {
            InitialModelAction::Skip {
                code: "model_not_advertised",
                message: format!(
                    "Initial model {model:?} is not advertised by the ACP agent; skipped (advertised: [{}])",
                    info.choices.join(", ")
                ),
            }
        }
    };
    if let Some(api) = declared {
        // 显式声明（现状行为，兼容优先）：Disabled 保留硬错；ConfigOption 声明在
        // 选项未宣告时不再断会话（D1.4：初值路径跳过下发）。
        return match api.route("model") {
            ModelSwitchTarget::SetModel => Ok(validate(InitialModelAction::SendSetModel)),
            ModelSwitchTarget::Disabled => Err(PylonError::Protocol(
                "model switching disabled by agent configuration".to_string(),
            )),
            ModelSwitchTarget::ConfigOption => match info.surface {
                super::ModelSurface::ConfigOption { config_id } => {
                    Ok(validate(InitialModelAction::SendConfigOption { config_id }))
                }
                _ => Ok(InitialModelAction::Skip {
                    code: "model_not_advertised",
                    message: format!(
                        "Initial model {model:?} skipped: model config option is not advertised by the ACP agent"
                    ),
                }),
            },
        };
    }
    // 未声明 → 按响应形状自适应路由。
    match info.surface {
        super::ModelSurface::ConfigOption { config_id } => {
            Ok(validate(InitialModelAction::SendConfigOption { config_id }))
        }
        super::ModelSurface::ModelsState => Ok(validate(InitialModelAction::SendSetModel)),
        super::ModelSurface::None => Ok(InitialModelAction::Skip {
            code: "model_not_advertised",
            message: format!(
                "Initial model {model:?} skipped: the ACP agent advertises no model surface"
            ),
        }),
    }
}

/// #335/U1b（期票兑现）：建会话装配参数的共享域——`apply_initial_session_options`
/// / `create_session_slot` / `ensure_session_mapping` / `revive_session_slot` 四个
/// 装配函数的公共参数面（state/runtime/source/profile/persona/cwd/mcp servers）
/// 收敛于此，取代原 9/12/9 参的逐参手抄。`new_session` 是 Tauri command（参数即
/// wire 面，契约不动），仅在命令体内装配本结构体后调用内部装配函数。
pub(crate) struct SessionAssembly<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) runtime: &'a Arc<AgentRuntime>,
    /// 本地会话源（sessions 映射键，runtime 内唯一）。
    pub(crate) source: &'a str,
    /// GUI profile 声明维（平台自动会话为 None）。
    pub(crate) profile_id: Option<&'a str>,
    pub(crate) persona: &'a str,
    pub(crate) session_cwd: &'a str,
    pub(crate) wire_mcp_servers: &'a [serde_json::Value],
}

/// 空态控制中心的初始可选值（model/reasoning/mode；全 None = 不下发任何选项）。
#[derive(Debug, Clone, Copy, Default)]
struct InitialSessionOptions<'a> {
    model: Option<&'a str>,
    reasoning: Option<&'a str>,
    mode: Option<&'a str>,
}

/// Apply the optional values selected in the empty-state control center.  The
/// operation is intentionally atomic from the caller's perspective: a failed
/// setting RPC is returned so the newly-created remote session can be closed
/// before any local mapping is published.
async fn apply_initial_session_options(
    assembly: &SessionAssembly<'_>,
    peri_id: &str,
    generation: u64,
    response: &mut serde_json::Value,
    options: InitialSessionOptions<'_>,
) -> Result<(), PylonError> {
    let SessionAssembly {
        state,
        runtime,
        source,
        ..
    } = *assembly;
    if let Some(model) = options
        .model
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        // P56/D1.3：显式 set_model_api 声明优先（含 legacy 布尔迁移与 catalog 默认
        // ——load.rs parse() 合并结果，agent.acp.set_model_api 为 Some 即声明态）；
        // 未声明按响应判定的 model_surface 路由。
        let declared = state
            .agent_for_runtime(runtime)
            .and_then(|agent| agent.acp)
            .and_then(|acp| acp.set_model_api);
        // P56/D1.4：目标 ∉ 宣告 choices（或无宣告面）→ 跳过下发 + warn（code=
        // model_not_advertised），不抛断会话（复用 reasoning_not_advertised 先例形状）。
        match plan_initial_model(response, model, declared)? {
            InitialModelAction::Skip { code, message } => {
                tracing::warn!(source = source, requested = model, "{message}");
                state.log_runtime_summary(
                    "warn",
                    "session",
                    Some(source.to_string()),
                    &message,
                    serde_json::Map::from_iter([
                        (
                            "requested".to_string(),
                            serde_json::Value::String(model.to_string()),
                        ),
                        (
                            "code".to_string(),
                            serde_json::Value::String(code.to_string()),
                        ),
                    ]),
                );
            }
            InitialModelAction::SendSetModel => {
                let setting_response = state
                    .acp_rpc_generation_checked(
                        runtime,
                        acp::METHOD_SESSION_SET_MODEL,
                        acp::session_set_model_params(peri_id, model)
                            .map_err(PylonError::Protocol)?,
                        generation,
                    )
                    .await
                    .map_err(PylonError::from)?;
                state
                    .ensure_generation(runtime, generation)
                    .map_err(PylonError::Protocol)?;
                merge_setting_response(
                    response,
                    setting_response,
                    "models",
                    "currentModelId",
                    "model",
                    model,
                );
            }
            InitialModelAction::SendConfigOption { config_id } => {
                let setting_response = state
                    .acp_rpc_generation_checked(
                        runtime,
                        acp::METHOD_SESSION_SET_CONFIG_OPTION,
                        acp::session_set_config_option_params(
                            peri_id,
                            &config_id,
                            &serde_json::Value::String(model.to_string()),
                        )
                        .map_err(PylonError::Protocol)?,
                        generation,
                    )
                    .await
                    .map_err(PylonError::from)?;
                state
                    .ensure_generation(runtime, generation)
                    .map_err(PylonError::Protocol)?;
                merge_setting_response(
                    response,
                    setting_response,
                    "models",
                    "currentModelId",
                    &config_id,
                    model,
                );
            }
        }
    }

    if let Some(mode) = options
        .mode
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let params = acp::session_set_mode_params(peri_id, mode).map_err(PylonError::Protocol)?;
        let setting_response = state
            .acp_rpc_generation_checked(runtime, acp::METHOD_SESSION_SET_MODE, params, generation)
            .await
            .map_err(PylonError::from)?;
        state
            .ensure_generation(runtime, generation)
            .map_err(PylonError::Protocol)?;
        merge_setting_response(
            response,
            setting_response,
            "modes",
            "currentModeId",
            "mode",
            mode,
        );
    }

    if let Some(reasoning) = options
        .reasoning
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let options = response
            .get("configOptions")
            .or_else(|| response.get("config_options"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if let Some(option_id) = find_reasoning_option_id(options, reasoning) {
            let params = acp::session_set_config_option_params(
                peri_id,
                &option_id,
                &serde_json::Value::String(reasoning.to_string()),
            )
            .map_err(PylonError::Protocol)?;
            let setting_response = state
                .acp_rpc_generation_checked(
                    runtime,
                    acp::METHOD_SESSION_SET_CONFIG_OPTION,
                    params,
                    generation,
                )
                .await
                .map_err(PylonError::from)?;
            state
                .ensure_generation(runtime, generation)
                .map_err(PylonError::Protocol)?;
            merge_config_setting_response(response, setting_response, &option_id, reasoning);
        } else {
            // Hermes currently exposes permission modes and model state, but
            // no ACP reasoning/thinking option.  Do not send a made-up config
            // id (which would look successful while changing nothing).
            tracing::warn!(
                source = source,
                requested = reasoning,
                "initial reasoning level is not advertised by the ACP agent; skipped"
            );
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source.to_string()),
                "Initial reasoning level was not advertised by the ACP agent; skipped",
                serde_json::Map::from_iter([
                    (
                        "requested".to_string(),
                        serde_json::Value::String(reasoning.to_string()),
                    ),
                    (
                        "code".to_string(),
                        serde_json::Value::String("reasoning_not_advertised".to_string()),
                    ),
                ]),
            );
        }
    }
    Ok(())
}

/// G2-04：无条件建会话——上限检查 + session/new RPC + ensure_generation +
/// SessionInfo 构造 + apply_session_response + replace_session_slot（notify 唯一出口）+
/// 可选 close 被替换旧会话（new_session 语义；E7 拍板：ensure 路径也传 true）。
/// 调用方必须持有 runtime.session_creation 锁（并发建会话串行化，覆盖"检查 +
/// RPC + 插入"全程；tokio Mutex 不可重入，本函数内部不取锁）；RPC await 期间
/// 不持 sessions 锁（V14），await 后 ensure_generation（RPC 后位置不变量）。
/// "Session creation failed" 日志在本函数内发出（唯一出口）。
async fn create_session_slot(
    assembly: &SessionAssembly<'_>,
    workspace_id: Option<String>,
    options: InitialSessionOptions<'_>,
    close_replaced: bool,
) -> Result<SessionMapping, PylonError> {
    let SessionAssembly {
        state,
        runtime,
        source,
        profile_id,
        persona,
        session_cwd,
        wire_mcp_servers,
    } = *assembly;
    {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= crate::agent::runtime::SessionSlotPolicy::default().max_sessions {
            return Err(PylonError::Protocol("max sessions reached".to_string()));
        }
    }
    let generation = state.current_generation(runtime);
    // B2：session/new 不得绕过 initialize——未完成握手的客户端直接拒绝（稳定
    // 错误码），而不是把一个注定失败的会话建立发给子进程。
    {
        let acp = runtime.snapshot_acp();
        if !acp.session_ready() {
            return Err(PylonError::Protocol(
                "session_new_before_initialize: ACP 握手未完成，禁止建立会话".to_string(),
            ));
        }
    }
    // G2-07：McpServersMode 消费（G1 入口，E4 警告语义见 pylon-core
    // agent_config/types.rs 的 McpServersMode doc）——
    // per-agent 协议配置解析，缺省 Always = 现状 wire；OmitIfEmpty 显式删键（v2 语义）。
    // B2：参数经 SessionNewPlan 纯函数成形（MCP 模式语义保持在 session_new_params）。
    let params = crate::acp::initialize_plan::build_session_new_plan(
        session_cwd.to_string(),
        wire_mcp_servers.to_vec(),
        state.protocol_for_runtime(runtime).mcp_servers,
    )
    .params()?;
    let mut response = match state
        .acp_rpc(runtime, acp::METHOD_SESSION_NEW, params)
        .await
    {
        Ok(response) => response,
        Err(error) => {
            state.log_runtime_summary(
                "error",
                "session",
                Some(source.to_string()),
                "Session creation failed",
                serde_json::Map::new(),
            );
            return Err(error.into());
        }
    };
    state.ensure_generation(runtime, generation)?;
    let peri_id = crate::acp::session_id_from(&response)?;
    if options.model.is_some() || options.reasoning.is_some() || options.mode.is_some() {
        if let Err(error) =
            apply_initial_session_options(assembly, &peri_id, generation, &mut response, options)
                .await
        {
            let _ = close_session_rpc(state, runtime, &peri_id, generation, false).await;
            return Err(error);
        }
    }
    let mut session = SessionInfo::new(
        peri_id.clone(),
        persona.to_string(),
        session_cwd.to_string(),
        false,
        generation,
    );
    session.profile_id = profile_id.map(str::to_string);
    // CWD-03：Workspace 绑定（方案 C；None = legacy 未绑定，root 解析回退 cwd）。
    session.workspace_id = workspace_id;
    session.apply_session_response(&response);
    restore_session_state(&session, &mut response);
    // #110 F5：模型解析链闭合——agent 显式 model > profile.model > 响应回显。
    // 解析结果在会话槽位落位后写入 journal（`session.model-updated`），使「当前
    // 模型」成为 journal 拥有的权威事实（与 sessionState provider 的分工一致）。
    let response_model = session.model.clone();
    let established_model = resolve_established_model(
        state
            .agent_for_runtime(runtime)
            .and_then(|agent| agent.model)
            .as_deref(),
        options.model,
        Some(response_model.as_str()),
    )
    .map(str::to_string);
    let replaced = replace_session_slot(
        runtime,
        source,
        session,
        false,
        crate::agent::runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    let attached = crate::session::store::mark_attached_if_current(
        runtime, source, &peri_id, generation, generation,
    )
    .map_err(|error| PylonError::Protocol(error.to_string()))?;
    if !attached {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    if let Some(model) = established_model.as_deref() {
        let _ = ingest_established_model_event(state, runtime, source, &peri_id, generation, model)
            .await;
    }
    // #51：建立期选择器面入 journal——重启后打开历史会话时中控区由此恢复
    // model choices / reasoning / mode 候选（空 envelope 不写，见 helper 文档）。
    let established_options = response_projection_options(&response);
    let _ = ingest_established_config_options_event(
        state,
        runtime,
        source,
        &peri_id,
        generation,
        &established_options,
    )
    .await;
    if close_replaced {
        if let Some(old) = replaced {
            // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
            let _ = close_session_rpc(state, runtime, &old.peri_id, generation, false).await;
        }
    }
    Ok(SessionMapping {
        peri_id,
        is_first: true,
        new_response: Some(response),
    })
}

/// G2-04：会话建立/复用——已有映射则复用（返回 is_first = !has_first_prompt）；
/// 内存无映射但调用方带持久化 peri_id 时，先尝试 ACP 原生 session/load 复活
/// 远端会话（用户决策：避免每次发送都新建导致 provider 会话列表臃肿、上下文
/// 丢失）；复活失败才走 create_session_slot（E7 拍板：自动建会话覆盖旧映射时
/// close 旧 peri，close_replaced 传 true——覆盖场景仅并发 replace 返回 Some 的
/// 幽灵映射），并以 pylon:session-recreated 广播告知前端新 peri_id。
/// 调用方须已持有该 source 的 prompt 锁（send_prompt_core 路径）。
// session_creation 跨 await：映射复活/建立与并发 create/close 串行（G2-04）
pub(crate) async fn ensure_session_mapping(
    assembly: &SessionAssembly<'_>,
    known_peri_id: Option<&str>,
    recreated_peri_id: &mut Option<String>,
) -> Result<SessionMapping, PylonError> {
    let SessionAssembly {
        state,
        runtime,
        source,
        profile_id,
        ..
    } = *assembly;
    let _creation_guard = HeldAcrossAwait::new(runtime.session_creation.lock().await);
    if let Some(health) = runtime
        .binding_health
        .lock()
        .map_err(|error| error.to_string())?
        .get(source)
        .cloned()
    {
        let unavailable = match health {
            crate::agent::runtime::SessionBindingHealth::Attached { .. } => None,
            crate::agent::runtime::SessionBindingHealth::Probing { .. } => Some("probing"),
            crate::agent::runtime::SessionBindingHealth::Detached { .. } => Some("detached"),
        };
        if let Some(health) = unavailable {
            return Err(PylonError::SessionBindingUnavailable {
                session_source: source.to_string(),
                health: health.to_string(),
            });
        }
    }
    // G2-08 锁合并：消息到达即活动（B10.3b 会话超时判定）——updated_at 刷新与
    // 存在性读取合并为 guard 内一次 sessions.lock()（每消息 7 处 sessions 锁降为
    // 6 处）。行为差异（E10 已拍板）：crashed 早退路径不再刷新 updated_at。
    let existing = {
        let mut sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get_mut(source) {
            session.attach_profile_id(profile_id, source)?;
            session.updated_at = Some(Timestamp::now());
            Some((session.peri_id.clone(), !session.has_first_prompt))
        } else {
            None
        }
    };
    if let Some((peri_id, is_first)) = existing {
        return Ok(SessionMapping {
            peri_id,
            is_first,
            new_response: None,
        });
    }
    // 内存无映射（Pylon 重启 / agent 重启清空）：优先用持久化 peri_id 走 ACP
    // 原生 session/load 复活远端会话。复活成功则本消息续用原会话上下文，
    // provider 会话列表不再因每次重启膨胀。
    if let Some(peri_id) = known_peri_id.filter(|id| !id.is_empty()) {
        if let Some(mapping) = revive_session_slot(assembly, peri_id).await? {
            // #98：revive 成功但远端 identity 变化（server 返回了不同的
            // sessionId）——不得静默复用旧映射。复用 recreated 事件通道显式
            // 广播新 id（前端回写持久化），runtime log 记录 rebind 细节。
            if mapping.peri_id != peri_id {
                *recreated_peri_id = Some(mapping.peri_id.clone());
                state.log_runtime_summary(
                    "info",
                    "session",
                    Some(source.to_string()),
                    "Remote session identity changed during revive; rebinding explicitly",
                    serde_json::Map::from_iter([
                        (
                            "previousPeriId".to_string(),
                            serde_json::Value::String(peri_id.to_string()),
                        ),
                        (
                            "periId".to_string(),
                            serde_json::Value::String(mapping.peri_id.clone()),
                        ),
                        (
                            "reason".to_string(),
                            serde_json::Value::String("rebound".into()),
                        ),
                    ]),
                );
            }
            return Ok(mapping);
        }
    }
    let mapping =
        create_session_slot(assembly, None, InitialSessionOptions::default(), true).await?;
    // 上下文已断（远端会话死亡，本轮起是新会话）：前端需要知道新 peri_id
    // 才能持久化并让后续 load 复活这条新会话。
    *recreated_peri_id = Some(mapping.peri_id.clone());
    Ok(mapping)
}

/// G2-02：load_persisted_session 失败恢复去重——锁 sessions → 复核映射
/// （(peri_id, generation) 匹配）→ 有 previous 则 insert 否则 remove。
/// 调用方不得持有 sessions 锁（E5 锁序纪律：sessions → prompt_locks 单向）。
/// 错误传播：锁错误经 String → PylonError::Protocol（与调用方原样语义一致）。
pub(crate) fn restore_previous_slot(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    previous: Option<SessionInfo>,
) -> Result<(), PylonError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|lock_error| lock_error.to_string())?;
    if sessions.get(source).map(|session| {
        session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
    }) == Some(true)
    {
        if let Some(previous) = previous {
            sessions.insert(source.to_string(), previous);
        } else {
            sessions.remove(source);
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
#[allow(
    clippy::too_many_arguments,
    reason = "IPC 契约签名：参数与 wire 面一一对应不可折叠；摘除条件 = 改为 payload 结构体并同步前端调用方"
)]
// session_creation 跨 await：会话建立序列（守卫/上限/RPC/插入/close 旧）整体串行
pub(crate) async fn new_session<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    // #379：懒重连的状态播报需要窗口（Tauri 注入，前端 wire 不变）。
    window: tauri::Window<R>,
    agent_id: String,
    source: String,
    profile_id: String,
    persona: String,
    cwd: Option<String>,
    workspace_id: Option<String>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
    model: Option<String>,
    reasoning_level: Option<String>,
    mode: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    DurableSessionOwner::new(&profile_id, &agent_id, &source).validate()?;
    // OWNER-02（§5.8）：显式 agentId 路由到 owner runtime——建会话前本地映射必不存在，
    // 故只要求 agent runtime 存在（不要求会话已存在）；不存在 owner runtime →
    // agent_runtime_unavailable，绝不 fallback active runtime。
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    // B1：GUI 不得冒名平台源——is_platform_source（注册适配器 OR 绑定命中）且
    // 无 binding → 拒绝（防会话建立后出站投递到 QQ）。G4 §3-9（C3）：E14 语义——
    // QQ 适配器未注册时 qq:* 未绑定源放行（无注册 = 无投递路径，安全等价，见
    // gateway/mod.rs is_platform_source doc）。
    if state.gateway.is_platform_source(&source) && state.gateway.binding(&source).is_none() {
        return Err(PylonError::Protocol(format!(
            "invalid GUI source: {source}"
        )));
    }
    // #379：建会话前懒重连——与 send_message 同一懒连接语义（详见
    // ensure_connected_for_send）；廉价校验先行，重建的慢路径在进入创建序列前完成。
    state
        .inner()
        .ensure_connected_for_send(&runtime, &agent_id, &window)
        .await
        .map_err(PylonError::from)?;
    state.inner().log_runtime_summary(
        "info",
        "session",
        Some(source.clone()),
        "Session creation started",
        serde_json::Map::new(),
    );
    let _creation_guard = HeldAcrossAwait::new(runtime.session_creation.lock().await);
    // CWD-03：Workspace 绑定优先（root_path 单一来源）；未绑定走 cwd 缺省链。
    let (session_cwd, workspace_id) =
        crate::workspaces::resolve_session_cwd(state.inner(), cwd, workspace_id)?;
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    // G2-04：会话建立收敛——守卫/上限/RPC/构造/插入（notify 唯一出口）/
    // close 旧会话全部收敛进 create_session_slot（close_replaced=true，new_session 语义）。
    // #335/U1b：命令 wire 签名不动，内部经装配结构体调用。
    let assembly = SessionAssembly {
        state: state.inner(),
        runtime: &runtime,
        source: &source,
        profile_id: Some(&profile_id),
        persona: &persona,
        session_cwd: &session_cwd,
        wire_mcp_servers: &mcp_servers,
    };
    let options = InitialSessionOptions {
        model: model.as_deref(),
        reasoning: reasoning_level.as_deref(),
        mode: mode.as_deref(),
    };
    let mapping = create_session_slot(&assembly, workspace_id, options, true).await?;
    state.inner().log_runtime_summary(
        "info",
        "session",
        Some(source.clone()),
        "Session creation succeeded",
        serde_json::Map::new(),
    );
    // Return full response so frontend gets modes + configOptions + sessionId
    Ok(mapping
        .new_response
        .expect("create_session_slot 必返回 session/new 原始响应"))
}

/// #53：空态选择器探测——起一次性会话读 Agent 广告的 configOptions/modes 后立即
/// close。codge `probe_agent_options` 的 Pylon 等价物：空态（无历史会话桶）的中控区
/// 模型候选由此获得数据源，不再依赖"该 agent 曾在本机跑过会话"。
///
/// 与用户会话完全隔离：合成 source 不落会话槽位、不写 journal、不做 initial 选项
/// 下发、gateway 语义不参与；关闭走 LocalFirstBestEffort（探测会话的 close 失败
/// 不产生用户可见错误）。runtime 未建立 → `agent_runtime_unavailable`（探测不
/// boot 进程）。空 `configOptions` 是合法结果（"本 agent 无可配置项"）。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn probe_agent_selectors(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    cwd: Option<String>,
    workspace_id: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    let generation = state.current_generation(&runtime);
    let (session_cwd, _workspace_id) =
        crate::workspaces::resolve_session_cwd(state.inner(), cwd, workspace_id)?;
    // 与 create_session_slot 同款前置：未握手直接拒绝（稳定错误码）；建立期串行化
    // 共用 session_creation 锁（探测与用户建会话不并发打同一个 agent 子进程）。
    {
        let acp = runtime.snapshot_acp();
        if !acp.session_ready() {
            return Err(PylonError::Protocol(
                "session_new_before_initialize: ACP 握手未完成，禁止建立会话".to_string(),
            ));
        }
    }
    let params = crate::acp::initialize_plan::build_session_new_plan(
        session_cwd.clone(),
        Vec::new(),
        state.protocol_for_runtime(&runtime).mcp_servers,
    )
    .params()?;
    let response = state
        .acp_rpc_generation_checked(&runtime, acp::METHOD_SESSION_NEW, params, generation)
        .await?;
    state.ensure_generation(&runtime, generation)?;
    let peri_id = crate::acp::session_id_from(&response)?;
    // #250：登记探测会话 peri_id——本会话不落会话槽位，建会话后 agent 迟到的
    // 元数据通知（available_commands_update 等）在 dispatcher 查无映射；登记后
    // dispatcher 将其按预期孤儿静默降级（debug），不再逐条 warn。只进不出，
    // TTL 自然失效（close 后迟到帧正是静音对象）。
    runtime.probe_sessions.register(&peri_id);
    let mut probe_session = SessionInfo::new(
        peri_id.clone(),
        String::new(),
        session_cwd,
        false,
        generation,
    );
    probe_session.apply_session_response(&response);
    let model_surface = match &probe_session.model_surface {
        ModelSurface::ConfigOption { config_id } => serde_json::json!({
            "kind": "config_option",
            "configId": config_id,
        }),
        ModelSurface::ModelsState => serde_json::json!({ "kind": "models_state" }),
        ModelSurface::None => serde_json::json!({ "kind": "none" }),
    };
    let mut options = response_config_options(&response);
    if serde_json::to_string(&options)
        .map(|text| text.len())
        .unwrap_or(0)
        > super::model::SELECTOR_ENVELOPE_MAX_BYTES
    {
        tracing::warn!(
            agent = agent_id,
            "probe configOptions envelope exceeds bound; returning surface only"
        );
        options = Vec::new();
    }
    let result = serde_json::json!({
        "configOptions": options,
        "modes": response.get("modes").cloned().unwrap_or(serde_json::Value::Null),
        "modelSurface": model_surface,
        "modelChoices": probe_session.model_choices,
        "currentModel": if probe_session.model.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(probe_session.model.clone())
        },
    });
    let _ = close_session_rpc(state.inner(), &runtime, &peri_id, generation, false).await;
    Ok(result)
}

#[cfg(test)]
mod initial_option_tests {
    use super::*;
    use serde_json::json;

    /// #110 F5：生效模型优先级 = agent 显式 > profile 请求 > 响应回显（用户裁决
    /// 2026-09-16）；全空/全空白 → None（不得伪造模型事实）。
    #[test]
    fn established_model_priority_is_agent_then_profile_then_response() {
        assert_eq!(
            resolve_established_model(Some("agent:id"), Some("profile:id"), Some("echo:id")),
            Some("agent:id"),
            "agent 显式 model 优先于 profile"
        );
        assert_eq!(
            resolve_established_model(None, Some("profile:id"), Some("echo:id")),
            Some("profile:id"),
            "无 agent 显式时 profile.model 作缺省"
        );
        assert_eq!(
            resolve_established_model(None, None, Some("echo:id")),
            Some("echo:id"),
            "无配置时退回响应回显的权威 current model"
        );
        assert_eq!(
            resolve_established_model(Some("  "), Some("\t"), Some("")),
            None,
            "全空白不得当成模型值"
        );
        assert_eq!(resolve_established_model(None, None, None), None);
        assert_eq!(
            resolve_established_model(Some(" agent:id "), None, None),
            Some("agent:id"),
            "取值两端空白裁剪"
        );
    }

    #[test]
    fn reasoning_option_requires_advertised_semantic_id_and_choice() {
        let options = vec![
            json!({
                "id": "temperature",
                "label": "Reasoning temperature",
                "type": "select",
                "options": [{"id": "0.2"}, {"id": "0.8"}]
            }),
            json!({
                "id": "reasoning_effort",
                "label": "Reasoning effort",
                "type": "select",
                "options": [{"id": "low"}, {"id": "high"}]
            }),
        ];
        assert_eq!(
            find_reasoning_option_id(&options, "high").as_deref(),
            Some("reasoning_effort")
        );
        assert_eq!(
            find_reasoning_option_id(&options, "medium"),
            None,
            "requested value outside provider choices must not be sent"
        );
    }

    #[test]
    fn reasoning_option_skips_unadvertised_or_read_only_values() {
        assert_eq!(
            find_reasoning_option_id(
                &[json!({"id": "reasoning", "label": "Thinking", "editable": false})],
                "high",
            ),
            None
        );
        assert_eq!(find_reasoning_option_id(&[], "high"), None);
    }

    #[test]
    fn reasoning_option_accepts_snake_case_config_catalog() {
        let response = json!({
            "config_options": [{
                "config_id": "thinking_level",
                "label": "Thinking level",
                "choices": [{"value": "low"}, {"value": "xhigh"}]
            }]
        });
        let options = response
            .get("configOptions")
            .or_else(|| response.get("config_options"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        assert_eq!(
            find_reasoning_option_id(options, "xhigh").as_deref(),
            Some("thinking_level")
        );
    }

    #[test]
    fn setting_response_merge_preserves_catalog_and_updates_current_values() {
        let mut response = json!({
            "sessionId": "session-1",
            "models": {
                "availableModels": [{"modelId": "openrouter:old", "name": "old"}],
                "currentModelId": "openrouter:old"
            },
            "modes": {
                "availableModes": [{"id": "default", "name": "Default"}],
                "currentModeId": "default"
            },
            "configOptions": [{"id": "model", "currentValue": "old"}]
        });
        merge_setting_response(
            &mut response,
            json!({"models": {"currentModelId": "openrouter:new"}}),
            "models",
            "currentModelId",
            "model",
            "openrouter:new",
        );
        merge_setting_response(
            &mut response,
            json!({}),
            "modes",
            "currentModeId",
            "mode",
            "accept_edits",
        );
        assert_eq!(response["models"]["currentModelId"], "openrouter:new");
        assert_eq!(response["modes"]["currentModeId"], "accept_edits");
        assert_eq!(
            response["models"]["availableModels"][0]["modelId"],
            "openrouter:old"
        );
        assert_eq!(
            response["configOptions"][0]["currentValue"],
            "openrouter:new"
        );
    }

    // ── P56/D1.4：初值 model 下发校验（非宣告值跳过）──

    #[test]
    fn initial_model_plan_skips_values_outside_advertised_choices() {
        // hermes 形态 fixture：宣告 choices=[nous:hermes-4]，profile.model=deepseek-v4-pro
        // → 跳过下发（验收 2），code=model_not_advertised。
        let response = json!({
            "sessionId": "session-1",
            "models": {
                "availableModels": [{"modelId": "nous:hermes-4", "name": "Nous · hermes-4"}],
                "currentModelId": "nous:hermes-4"
            }
        });
        let action = plan_initial_model(&response, "deepseek-v4-pro", None).unwrap();
        match action {
            InitialModelAction::Skip { code, message } => {
                assert_eq!(code, "model_not_advertised");
                assert!(message.contains("nous:hermes-4"), "{message}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
        // 宣告列表内的值照常下发 set_model（现状行为回归保护）。
        assert!(matches!(
            plan_initial_model(&response, "nous:hermes-4", None).unwrap(),
            InitialModelAction::SendSetModel
        ));
        // 未宣告任何模型面 → 直接跳过，不断会话。
        let bare = json!({"sessionId": "session-1"});
        assert!(matches!(
            plan_initial_model(&bare, "deepseek-v4-pro", None).unwrap(),
            InitialModelAction::Skip { .. }
        ));
    }

    #[test]
    fn initial_model_plan_routes_standard_config_option_channel() {
        // 标准 ACP 形态：category=="model" 选项的宣告 configId 胜出（干扰选项不得
        // 胜出，验收 3）；列表内的值走 set_config_option（宣告 configId）。
        let response = json!({
            "sessionId": "session-1",
            "configOptions": [
                {
                    "id": "reasoning-effort",
                    "description": "Reasoning effort for the model",
                    "options": [{"valueId": "low"}],
                    "currentValue": "low"
                },
                {
                    "id": "model-selection",
                    "category": "model",
                    "options": [{"valueId": "m-1", "name": "Model One"}],
                    "currentValue": "m-1"
                }
            ]
        });
        match plan_initial_model(&response, "m-1", None).unwrap() {
            InitialModelAction::SendConfigOption { config_id } => {
                assert_eq!(config_id, "model-selection");
            }
            other => panic!("expected SendConfigOption, got {other:?}"),
        }
        // 非宣告值跳过（两通道校验一致）。
        assert!(matches!(
            plan_initial_model(&response, "bare-model-x", None).unwrap(),
            InitialModelAction::Skip { .. }
        ));
    }

    #[test]
    fn initial_model_plan_keeps_explicit_declaration_semantics() {
        // 显式 set_model_api: true 声明：未宣告列表时照常下发（现状兼容，验收 8）。
        let bare = json!({"sessionId": "session-1"});
        assert!(matches!(
            plan_initial_model(
                &bare,
                "anything",
                Some(crate::agent_config::SetModelApi::SetModel)
            )
            .unwrap(),
            InitialModelAction::SendSetModel
        ));
        // 显式声明 + 有宣告列表：同样施加发送校验（通用不变量）。
        let response = json!({
            "sessionId": "session-1",
            "models": {
                "availableModels": [{"modelId": "nous:hermes-4", "name": "Nous · hermes-4"}],
                "currentModelId": "nous:hermes-4"
            }
        });
        assert!(matches!(
            plan_initial_model(
                &response,
                "deepseek-v4-pro",
                Some(crate::agent_config::SetModelApi::SetModel)
            )
            .unwrap(),
            InitialModelAction::Skip { .. }
        ));
        // 显式 none 声明：保留现状硬错。
        assert!(plan_initial_model(
            &bare,
            "anything",
            Some(crate::agent_config::SetModelApi::None)
        )
        .is_err());
    }

    #[test]
    fn initial_model_plan_reads_top_level_model_catalog() {
        let response = json!({
            "sessionId": "session-1",
            "currentModelId": "deepseek-v4.1-flash",
            "availableModels": [
                {"modelId": "deepseek-v4-flash", "name": "DeepSeek V4 Flash"},
                {"modelId": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash"}
            ]
        });
        assert!(matches!(
            plan_initial_model(&response, "deepseek-v4-flash", None).unwrap(),
            InitialModelAction::SendSetModel
        ));
    }

    /// #51 收口：payload 比对只认 `update.configOptions` 结构相等（对象键序
    /// 无关）；缺 configOptions 的行一律视为不同——宁多写一条，不冒丢面风险。
    #[test]
    fn established_options_unchanged_compares_config_options_only() {
        let options = json!([{ "id": "model-selection", "currentValue": "m-1" }]);
        let raw = |config: serde_json::Value| {
            json!({
                "sessionId": "peri",
                "update": { "sessionUpdate": "config_option_update", "configOptions": config }
            })
        };
        assert!(established_options_unchanged(
            &raw(options.clone()),
            options.as_array().unwrap()
        ));
        let reordered = json!([{ "currentValue": "m-1", "id": "model-selection" }]);
        assert!(established_options_unchanged(
            &raw(reordered),
            options.as_array().unwrap()
        ));
        let changed = json!([{ "id": "model-selection", "currentValue": "m-2" }]);
        assert!(!established_options_unchanged(
            &raw(changed),
            options.as_array().unwrap()
        ));
        assert!(!established_options_unchanged(
            &json!({ "update": {} }),
            options.as_array().unwrap()
        ));
    }
}
