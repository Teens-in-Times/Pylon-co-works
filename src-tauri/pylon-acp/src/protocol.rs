//! ACP 协议层：wire 请求构造器 + 响应解析（R13/P3-4 拆分自 acp.rs；行为零变化）。
//!
//! 核心字段（sessionId/cwd/configId/value/modeId/prompt）用官方
//! agent-client-protocol-schema v1 Request 类型构造，wire 格式由 schema 保证；
//! 扩展字段（mcpServers）保持 Value 直传——Pylon 的 MCP 配置格式（stdio 无
//! name）与官方 McpServer 不兼容，不能强转。

use base64::Engine;
use std::io::Read;

use agent_client_protocol_schema::v1::{
    CloseSessionRequest, ContentBlock, DeleteSessionRequest, LoadSessionRequest, NewSessionRequest,
    PromptRequest, ResumeSessionRequest, SessionConfigOptionValue, SetSessionConfigOptionRequest,
    SetSessionModeRequest,
};

use super::AcpError;
use pylon_core::agent_config::McpServersMode;
use serde::Deserialize as _;

/// session/update 变体（dispatcher/export 分支依据）。
///
/// #316：分类真源改为官方 schema `SessionUpdate` typed-first
/// （[`classify_session_update`]），本枚举退化为宿主路由投影；`from_str`
/// 仅作为 typed 失败后的 raw-fallback（保留 Peri/Hermes 私有别名宽容语义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionUpdateVariant {
    AgentMessageChunk,
    UserMessageChunk,
    AgentThoughtChunk,
    Plan,
    UsageUpdate,
    ToolCall,
    ToolCallUpdate,
    SessionInfoUpdate,
    ConfigOptionUpdate,
    AvailableCommandsUpdate,
    CurrentModeUpdate,
}

impl SessionUpdateVariant {
    /// wire 字符串 → 变体；未知变体返回 None（调用方按忽略处理，与旧 `_ => {}` 一致）。
    /// #316：仅作 [`classify_session_update`] 的 raw-fallback，生产调用方不再直连。
    // #247：固有关联函数（非 FromStr trait——这里不消费 Err 形态），名称沿用原实现。
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "agent_message_chunk" => Some(Self::AgentMessageChunk),
            "user_message_chunk" => Some(Self::UserMessageChunk),
            // Peri 私有别名 agent_reasoning_chunk 与官方 agent_thought_chunk 同义
            // （state.rs 同表维护）。
            "agent_thought_chunk" | "agent_reasoning_chunk" => Some(Self::AgentThoughtChunk),
            "plan" => Some(Self::Plan),
            "usage_update" => Some(Self::UsageUpdate),
            "tool_call" => Some(Self::ToolCall),
            "tool_call_update" => Some(Self::ToolCallUpdate),
            "session_info_update" => Some(Self::SessionInfoUpdate),
            "config_option_update" => Some(Self::ConfigOptionUpdate),
            "available_commands_update" => Some(Self::AvailableCommandsUpdate),
            "current_mode_update" => Some(Self::CurrentModeUpdate),
            _ => None,
        }
    }

    /// 官方 typed 变体 → 宿主路由投影。`#[non_exhaustive]` 通配臂只接住
    /// 编译进二进制的 unstable 变体（当前 feature 集下不可达）——归 None，
    /// 与「未知变体按忽略处理」同一结论。
    fn from_typed(update: &agent_client_protocol_schema::v1::SessionUpdate) -> Option<Self> {
        use agent_client_protocol_schema::v1::SessionUpdate as S;
        Some(match update {
            S::UserMessageChunk(_) => Self::UserMessageChunk,
            S::AgentMessageChunk(_) => Self::AgentMessageChunk,
            S::AgentThoughtChunk(_) => Self::AgentThoughtChunk,
            S::Plan(_) => Self::Plan,
            S::UsageUpdate(_) => Self::UsageUpdate,
            S::ToolCall(_) => Self::ToolCall,
            S::ToolCallUpdate(_) => Self::ToolCallUpdate,
            S::SessionInfoUpdate(_) => Self::SessionInfoUpdate,
            S::ConfigOptionUpdate(_) => Self::ConfigOptionUpdate,
            S::AvailableCommandsUpdate(_) => Self::AvailableCommandsUpdate,
            S::CurrentModeUpdate(_) => Self::CurrentModeUpdate,
            _ => return None,
        })
    }
}

/// session/update 变体分类（#316 单一入口）：官方 schema typed-first，
/// 解析失败落 raw-fallback（`from_str` 宽容别名）。未知变体返回 None
/// （调用方按忽略处理——raw payload 照常 publish，与既有行为一致）。
pub fn classify_session_update(update: &serde_json::Value) -> Option<SessionUpdateVariant> {
    // 先按判别串分类：internally-tagged 枚举的成功条件正是该 tag 命中已知变体，
    // 且既有逻辑在 typed 失败时本就会落到 `from_str`——两条路径的结论集相同
    // （已知 tag 恒 Some、未知/缺失 tag 恒 None）。逐 chunk 省一次整树反序列化
    // （typed 值拥有 text 字符串，#666）。
    let tag = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if let Some(variant) = SessionUpdateVariant::from_str(tag) {
        return Some(variant);
    }
    // 未知判别串仍走官方 typed：未来 schema 新增变体（tag 不在本枚举）在此得到
    // 与 typed 一致的 None 结论；保留原 typed-first 的兼容面。
    agent_client_protocol_schema::v1::SessionUpdate::deserialize(update)
        .ok()
        .and_then(|typed| SessionUpdateVariant::from_typed(&typed))
}

fn to_params<T: serde::Serialize>(req: &T, what: &str) -> Result<serde_json::Value, String> {
    serde_json::to_value(req).map_err(|e| format!("serialize {what} params: {e}"))
}

fn content_blocks_from_values(values: Vec<serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    values
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| format!("invalid prompt block: {e}")))
        .collect()
}

/// session/new 参数（G1-07a mode 参数化）：Always = 恒发 mcpServers 字段
/// （现状 wire）；OmitIfEmpty = 空数组时省略字段（v2 语义，07 文档 §8.2）。
/// E4 警告：OmitIfEmpty 与 agent 能力匹配——声明 omit_if_empty 且无配置时省字段，
/// Hermes（Pydantic 必填）会拒绝 session/new；配置与 agent 能力匹配是用户责任。
/// 调用方经 `agent.protocol().mcp_servers` 传 mode（session.rs 统一接线）。
pub fn session_new_params(
    cwd: &str,
    mcp_servers: Vec<serde_json::Value>,
    mode: McpServersMode,
) -> Result<serde_json::Value, String> {
    let req = NewSessionRequest::new(cwd.to_string());
    let mut params = to_params(&req, "session/new")?;
    if let Some(obj) = params.as_object_mut() {
        match mode {
            McpServersMode::Always => {
                obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
            }
            McpServersMode::OmitIfEmpty => {
                // schema 类型恒序列化 mcpServers（v1 必填无 skip）——省略需显式删键
                if mcp_servers.is_empty() {
                    obj.remove("mcpServers");
                } else {
                    obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
                }
            }
        }
    }
    Ok(params)
}

/// session/set_mode 参数。
pub fn session_set_mode_params(session_id: &str, mode: &str) -> Result<serde_json::Value, String> {
    let req = SetSessionModeRequest::new(session_id.to_string(), mode.to_string());
    to_params(&req, "session/set_mode")
}

/// session/set_config_option 参数。ACP 1.4 只允许 ValueId string 或 Boolean；
/// 其他 JSON 值必须在 Host 边界拒绝，不能 stringify 后改变 provider 配置语义。
pub fn session_set_config_option_params(
    session_id: &str,
    key: &str,
    value: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let value = match value {
        serde_json::Value::String(value) => SessionConfigOptionValue::value_id(value.clone()),
        serde_json::Value::Bool(value) => SessionConfigOptionValue::boolean(*value),
        _ => {
            return Err(format!(
                "unsupported session config value for {key}: ACP accepts only string or boolean"
            ));
        }
    };
    let req = SetSessionConfigOptionRequest::new(session_id.to_string(), key.to_string(), value);
    to_params(&req, "session/set_config_option")
}

#[cfg(test)]
mod config_option_tests {
    use super::session_set_config_option_params;
    use serde_json::json;

    #[test]
    fn config_option_params_preserve_boolean_and_value_id_wire_shapes() {
        assert_eq!(
            session_set_config_option_params("session-1", "model", &json!("gpt-5")).unwrap(),
            json!({ "sessionId": "session-1", "configId": "model", "value": "gpt-5" }),
        );
        assert_eq!(
            session_set_config_option_params("session-1", "thinking", &json!(true)).unwrap(),
            json!({ "sessionId": "session-1", "configId": "thinking", "type": "boolean", "value": true }),
        );
    }

    #[test]
    fn config_option_params_reject_values_not_supported_by_acp() {
        let error = session_set_config_option_params("session-1", "temperature", &json!(0.4))
            .expect_err("numeric config values are not representable by ACP 1.4");
        assert!(error.contains("unsupported session config value"));
    }
}

#[cfg(test)]
mod session_mode_tests {
    use super::session_set_mode_params;
    use serde_json::json;

    #[test]
    fn session_mode_params_use_acp_mode_id_wire_shape() {
        assert_eq!(
            session_set_mode_params("remote-1", "auto").unwrap(),
            json!({ "sessionId": "remote-1", "modeId": "auto" }),
        );
    }
}

#[cfg(test)]
mod session_delete_tests {
    use super::session_delete_params;
    use serde_json::json;

    /// #398：官方 DeleteSessionRequest wire 形状——params 仅 sessionId（_meta 缺省不发射）。
    #[test]
    fn session_delete_params_use_official_wire_shape() {
        assert_eq!(
            session_delete_params("remote-1").unwrap(),
            json!({ "sessionId": "remote-1" }),
        );
    }
}

/// session/prompt 参数。仅被 `AcpClient::prepare_prompt` 内部使用。
pub fn session_prompt_params(
    session_id: &str,
    prompt: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let req = PromptRequest::new(session_id.to_string(), content_blocks_from_values(prompt)?);
    to_params(&req, "session/prompt")
}

/// session/close 参数。
pub fn session_close_params(session_id: &str) -> Result<serde_json::Value, String> {
    let req = CloseSessionRequest::new(session_id.to_string());
    to_params(&req, "session/close")
}

/// session/delete 参数（#398：官方 DeleteSessionRequest，响应无载荷）。
pub fn session_delete_params(session_id: &str) -> Result<serde_json::Value, String> {
    let req = DeleteSessionRequest::new(session_id.to_string());
    to_params(&req, "session/delete")
}

/// session/set_model 参数（Hermes unstable 扩展，字段与官方 SetSessionModelRequest 一致）。
pub fn session_set_model_params(
    session_id: &str,
    model_id: &str,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "sessionId": session_id,
        "modelId": model_id,
    }))
}

/// Extract and validate sessionId from a session/new response.
///
/// #316：typed-first（`NewSessionResponse`）；typed 失败落 raw 路径。三件
/// 手写守卫**必须保留**——`SessionId` 是透明 String 不做 trim/空串校验，而
/// Pylon 契约拒绝 trim 后为空与字面 "error" 的回显。
pub fn session_id_from(response: &serde_json::Value) -> Result<String, AcpError> {
    let invalid = |session_id: &str| {
        AcpError::Child(format!(
            "session/new failed: invalid sessionId {session_id:?}"
        ))
    };
    if let Ok(typed) = serde_json::from_value::<agent_client_protocol_schema::v1::NewSessionResponse>(
        response.clone(),
    ) {
        let session_id = typed.session_id.0.as_ref().trim();
        if session_id.is_empty() || session_id.eq_ignore_ascii_case("error") {
            return Err(invalid(session_id));
        }
        return Ok(session_id.to_string());
    }
    let session_id = response
        .get("sessionId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AcpError::Child(format!("invalid session/new response: {response}")))?
        .trim();
    if session_id.is_empty() || session_id.eq_ignore_ascii_case("error") {
        return Err(invalid(session_id));
    }
    Ok(session_id.to_string())
}

/// session/prompt 响应的合法成功终态（#316 闭式判定表）。
///
/// 行为变化（#316 已批准）：`max_tokens` 从 unsupported 错误转正为合法终态；
/// 未知 stopReason 从硬错误转为 warn + 宽松降级 `EndTurn`（官方规范未来新增
/// 值不再炸成用户可见失败）。`cancelled`/`refusal` 维持 Err（文案不变）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptStopOutcome {
    /// end_turn：模型正常收尾。
    EndTurn,
    /// max_tokens：达到 token 上限（UI 应提示，非故障）。
    MaxTokens,
    /// max_turn_requests：单回合模型请求次数达上限。
    MaxTurnRequests,
}

/// Validate a session/prompt response and classify its stop reason.
///
/// typed-first：官方 `StopReason` 五变体；解析失败（未知值/非字符串）落
/// raw-fallback 宽松降级。缺 `stopReason` 字段仍按畸形响应拒绝（文案不变）。
pub fn prompt_stop_outcome(response: &serde_json::Value) -> Result<PromptStopOutcome, AcpError> {
    let raw = response
        .get("stopReason")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .ok_or_else(|| AcpError::Child(format!("invalid session/prompt response: {response}")))?;
    if raw.is_empty() {
        // 空白/空串归畸形（#316 审查裁定：非「未知值」，不享宽松降级）。
        return Err(AcpError::Child(format!(
            "invalid session/prompt response: {response}"
        )));
    }
    use agent_client_protocol_schema::v1::StopReason as S;
    if let Ok(typed) = serde_json::from_value::<S>(serde_json::Value::String(raw.to_string())) {
        return match typed {
            S::EndTurn => Ok(PromptStopOutcome::EndTurn),
            S::MaxTokens => Ok(PromptStopOutcome::MaxTokens),
            S::MaxTurnRequests => Ok(PromptStopOutcome::MaxTurnRequests),
            S::Refusal => Err(AcpError::Child("prompt refused by agent".to_string())),
            S::Cancelled => Err(AcpError::Child("prompt cancelled".to_string())),
            _ => {
                tracing::warn!(
                    stop_reason = raw,
                    "unknown prompt stopReason (typed); treating as end_turn"
                );
                Ok(PromptStopOutcome::EndTurn)
            }
        };
    }
    tracing::warn!(
        stop_reason = raw,
        "unknown prompt stopReason; treating as end_turn"
    );
    Ok(PromptStopOutcome::EndTurn)
}

/// 校验 initialize 响应的 protocolVersion 回显（#316）。
///
/// 官方契约：agent 回显所支持的版本，或返回自己的最新版；不一致时客户端必须
/// 断连并告知用户。缺字段按 lenient 放行（warn）——存量非合规 agent 不因
/// 本校验新增失败；存在且不一致 → 结构化失败（稳定码
/// `protocol_version_mismatch`，由调用方包装为 `AgentConnectFailure`）。
pub fn validate_protocol_version(
    response: &serde_json::Value,
    requested: u16,
) -> Result<(), String> {
    let actual = match response.get("protocolVersion") {
        None | Some(serde_json::Value::Null) => {
            tracing::warn!(
                requested,
                "initialize response missing protocolVersion; assuming negotiated version"
            );
            return Ok(());
        }
        // 官方 wire 是整数；数字字符串视为同一信息的非合规格式，比对不放过。
        Some(serde_json::Value::Number(number)) => number.as_u64(),
        Some(serde_json::Value::String(text)) => text.trim().parse::<u64>().ok(),
        Some(_) => None,
    };
    match actual {
        Some(actual) if actual == u64::from(requested) => Ok(()),
        Some(actual) => Err(format!(
            "protocol version mismatch: Pylon requested {requested}, agent answered {actual}"
        )),
        None => Err(format!(
            "protocol version mismatch: Pylon requested {requested}, agent sent unparseable protocolVersion"
        )),
    }
}

/// Build prompt blocks (text + attachments) for session/prompt.
/// G1-04：附件限制来自 AttachmentLimits（缺省 = 现状 8 / 10MB，wire 文案不变）。
pub fn prompt_blocks(
    text: String,
    attachments: &[String],
    limits: pylon_core::agent_config::AttachmentLimits,
) -> Result<Vec<serde_json::Value>, String> {
    if attachments.len() > limits.max_attachments {
        return Err(format!(
            "too many attachments: maximum is {}",
            limits.max_attachments
        ));
    }
    // #316：ContentBlock typed 构造（出站形状由 schema 保证，wire 与手写
    // json! 逐字节一致：{"type":"text","text":..}）。
    let mut blocks =
        vec![
            serde_json::to_value(agent_client_protocol_schema::v1::ContentBlock::Text(
                agent_client_protocol_schema::v1::TextContent::new(text),
            ))
            .map_err(|error| format!("serialize text block: {error}"))?,
        ];
    for raw_path in attachments {
        let path = std::path::Path::new(raw_path);
        let metadata = std::fs::metadata(path).map_err(|error| {
            format!("attachment metadata failed for {}: {error}", path.display())
        })?;
        if !metadata.is_file() {
            return Err(format!("attachment is not a file: {}", path.display()));
        }
        if metadata.len() > limits.max_attachment_bytes {
            return Err(format!(
                "attachment too large: {} is {} bytes, maximum is {} bytes",
                path.display(),
                metadata.len(),
                limits.max_attachment_bytes
            ));
        }
        // A9：metadata 校验后不能直接 std::fs::read 无上限读取——校验与读取间
        // 文件可被替换/增长（TOCTOU），超大文件导致 OOM。改为上限读取
        // （MAX + 1 字节探测超限），读后再校验一次。
        let file = std::fs::File::open(path)
            .map_err(|error| format!("attachment read failed for {}: {error}", path.display()))?;
        let mut bytes = Vec::new();
        file.take(limits.max_attachment_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("attachment read failed for {}: {error}", path.display()))?;
        if bytes.len() as u64 > limits.max_attachment_bytes {
            return Err(format!(
                "attachment too large: {} is {} bytes, maximum is {} bytes",
                path.display(),
                bytes.len(),
                limits.max_attachment_bytes
            ));
        }
        let mime = infer::get(&bytes).map(|kind| kind.mime_type());
        match mime {
            Some(mime)
                if matches!(
                    mime,
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                ) =>
            {
                blocks.push(
                    serde_json::to_value(agent_client_protocol_schema::v1::ContentBlock::Image(
                        agent_client_protocol_schema::v1::ImageContent::new(
                            base64::engine::general_purpose::STANDARD.encode(bytes),
                            mime,
                        ),
                    ))
                    .map_err(|error| format!("serialize image block: {error}"))?,
                );
            }
            Some(mime) if mime.starts_with("text/") => {
                let content = String::from_utf8(bytes).map_err(|error| {
                    format!(
                        "attachment is not valid UTF-8 text {}: {error}",
                        path.display()
                    )
                })?;
                blocks.push(
                    serde_json::to_value(agent_client_protocol_schema::v1::ContentBlock::Text(
                        agent_client_protocol_schema::v1::TextContent::new(content),
                    ))
                    .map_err(|error| format!("serialize text block: {error}"))?,
                );
            }
            None => {
                let content = String::from_utf8(bytes)
                    .map_err(|_| format!("unsupported attachment type: {}", path.display()))?;
                blocks.push(
                    serde_json::to_value(agent_client_protocol_schema::v1::ContentBlock::Text(
                        agent_client_protocol_schema::v1::TextContent::new(content),
                    ))
                    .map_err(|error| format!("serialize text block: {error}"))?,
                );
            }
            Some(mime) => {
                return Err(format!(
                    "unsupported attachment MIME {mime}: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(blocks)
}

/// session/load 参数（G1-07a mode 参数化，语义同 session/new）。schema 的
/// mcpServers 字段必须存在；Peri 的 DefaultOnError 容忍缺失/空。无配置时传空
/// 数组而非缺字段。E4 警告：OmitIfEmpty 与 agent 能力匹配（同 session/new）。
pub fn load_params(
    session_id: &str,
    cwd: &str,
    mcp_servers: Vec<serde_json::Value>,
    mode: McpServersMode,
) -> Result<serde_json::Value, String> {
    let req = LoadSessionRequest::new(session_id.to_string(), cwd.to_string());
    let mut params = to_params(&req, "session/load")?;
    if let Some(obj) = params.as_object_mut() {
        match mode {
            McpServersMode::Always => {
                obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
            }
            McpServersMode::OmitIfEmpty => {
                // schema 类型恒序列化 mcpServers（v1 必填无 skip）——省略需显式删键
                if mcp_servers.is_empty() {
                    obj.remove("mcpServers");
                } else {
                    obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
                }
            }
        }
    }
    Ok(params)
}

#[cfg(test)]
mod resume_tests {
    use super::resume_params;
    use serde_json::json;

    #[test]
    fn resume_params_use_standard_session_id_and_cwd() {
        assert_eq!(
            resume_params("remote-1", "C:/work").unwrap(),
            json!({"sessionId":"remote-1", "cwd":"C:/work"}),
        );
    }
}

/// session/resume parameters. Resume carries only standard identity and cwd;
/// Pylon-specific MCP JSON is deliberately not sent through this schema.
pub fn resume_params(session_id: &str, cwd: &str) -> Result<serde_json::Value, String> {
    let req = ResumeSessionRequest::new(session_id.to_string(), cwd.to_string());
    to_params(&req, "session/resume")
}

pub fn resume_capability_advertised(capabilities: &serde_json::Value) -> bool {
    // #316：typed 视图（object → Some、非 object → DefaultOnError → None 拒绝）
    // 与 raw 判定逐例一致；raw 路径保留为 fallback（registry 原文可能非合规格式）。
    if let Ok(caps) = serde_json::from_value::<agent_client_protocol_schema::v1::AgentCapabilities>(
        capabilities.clone(),
    ) {
        return caps.session_capabilities.resume.is_some();
    }
    capabilities
        .get("sessionCapabilities")
        .and_then(|session| session.get("resume"))
        .is_some_and(serde_json::Value::is_object)
}

#[cfg(test)]
mod resume_capability_tests {
    use super::resume_capability_advertised;
    use serde_json::json;

    #[test]
    fn accepts_only_object_valued_resume_capability() {
        assert!(resume_capability_advertised(
            &json!({"sessionCapabilities":{"resume":{}}})
        ));
        assert!(!resume_capability_advertised(
            &json!({"sessionCapabilities":{"resume":true}})
        ));
        assert!(!resume_capability_advertised(
            &json!({"sessionCapabilities":{}})
        ));
        assert!(!resume_capability_advertised(
            &json!({"sessionCapabilities":{"resume":null}})
        ));
    }
}

#[cfg(test)]
mod classify_tests {
    use super::{classify_session_update, SessionUpdateVariant as Variant};
    use serde_json::json;

    #[test]
    fn classifies_known_tags_without_typed_payload() {
        // 判别串命中即可分类：body 缺失/畸形不改变结论（与 typed-first + raw-fallback
        // 的既有结论集一致，#666）。
        assert_eq!(
            classify_session_update(&json!({"sessionUpdate": "agent_message_chunk"})),
            Some(Variant::AgentMessageChunk)
        );
        assert_eq!(
            classify_session_update(&json!({"sessionUpdate": "tool_call"})),
            Some(Variant::ToolCall)
        );
    }

    #[test]
    fn keeps_peri_alias_and_unknown_tag_semantics() {
        assert_eq!(
            classify_session_update(&json!({"sessionUpdate": "agent_reasoning_chunk"})),
            Some(Variant::AgentThoughtChunk)
        );
        assert_eq!(
            classify_session_update(&json!({"sessionUpdate": "brand_new_thing"})),
            None
        );
        assert_eq!(classify_session_update(&json!({"noTag": true})), None);
    }
}
