//! Structured error types for Pylon backend.
//!
//! B1.2：错误 DTO 结构化——`{ "code": "...", "message": "..." }`，
//! 前端按 code 分支处理，message 仅供展示。内部仍以 Display 传播细节。

/// B1.2 结构化错误 wire 形状的单源实现：`{ "code", "message" }` 两键 map。
/// 命令边界错误类型共用（code 由各类型 `code()` 提供，message 走 Display）；
/// 序列化输出与既往手写 impl 逐字节一致（error.rs/gateway/pylon-session 六处去重）。
macro_rules! impl_wire_code_message_serialize {
    ($ty:ty) => {
        impl serde::Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("code", self.code())?;
                map.serialize_entry("message", &self.to_string())?;
                map.end()
            }
        }
    };
}
pub(crate) use impl_wire_code_message_serialize;

#[derive(Debug, thiserror::Error)]
pub enum PylonError {
    #[error("ACP error: {0}")]
    Acp(String),
    #[error("agent process crashed")]
    AgentCrashed,
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("session binding unavailable for {session_source}: {health}")]
    SessionBindingUnavailable {
        session_source: String,
        health: String,
    },
    /// OWNER-01（§5.8）：owner runtime 不存在（agent 未配置/未启动/未知）时返回，
    /// 禁止 fallback 到另一个 active runtime。agent_id 保留用于诊断（不落日志原文）。
    /// OWNER-02 已落地：`session::owner::resolve_agent_runtime` 构造（#228 摘过期豁免）。
    #[error("agent runtime unavailable for agent: {agent_id}")]
    AgentRuntimeUnavailable { agent_id: String },
    #[error("no active agent configured")]
    NoActiveAgent,
    #[error("serialization error: {0}")]
    Serialize(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("ACP protocol: {0}")]
    Protocol(String),
    /// canonical ingest 错误保留 EventError 的稳定机器码，避免 prompt 路径降级成
    /// 泛化 protocol_error 而丢失 recoverability 分类。
    #[error("Canonical event error: {0}")]
    CanonicalEvent(#[from] pylon_session::event_repo::EventError),
    /// session/load 会同时读取投影状态；保留 MessageError 的稳定机器码，便于前端
    /// 区分损坏、锁冲突、暂不可用与 tombstone，而不是统一降级为 protocol_error。
    #[error("Message persistence error: {0}")]
    MessagePersistence(#[from] pylon_session::msg_repo::MessageError),
    #[error("{0}")]
    Workspace(String),
    #[error("Prism error: {0}")]
    Prism(String),
    /// B5：Git 只读操作错误（非 git 仓库 / git 不可用 / 命令失败）。
    #[error("Git error: {0}")]
    Git(String),
    /// 插件目录/状态错误（细分 code 经 PluginError::code 委派）。
    #[error("Plugin error: {0}")]
    Plugin(#[from] crate::plugin_cmds::PluginError),
    /// R7（P2-1）：配置加载领域错误（细分 code 经 ConfigError::code 委派）。
    #[error("Config error: {0}")]
    Config(#[from] crate::agent_config::ConfigError),
    /// R4/R7（P1-2/P2-1）：Gateway 域错误（细分 code 经 GatewayError::code 委派）。
    #[error("Gateway error: {0}")]
    Gateway(#[from] crate::gateway::GatewayError),
    /// #247：会话存储核（pylon-session）错误整包委托——细分 code 经
    /// SessionError::code 委派，wire code 与拆分前逐字一致。
    #[error(transparent)]
    Storage(#[from] pylon_session::SessionError),
    /// 用户数据仓库错误（#317 批次二：原命令直返 UserDataError 收编）——
    /// 细分 code 经 UserDataError::code 委派，transparent 保 message 逐字不变。
    #[error(transparent)]
    UserData(#[from] pylon_session::user_data::UserDataError),
    /// 保留策略执行错误（#317 批次二：原命令直返 RetentionError 收编）——
    /// 细分 code 经 RetentionError::code 委派，transparent 保 message 逐字不变。
    #[error(transparent)]
    Retention(#[from] pylon_session::retention::RetentionError),
    /// 边界直述错误（#317 批次二：原 `Result<_, String>` 命令面收编——
    /// hook/cli 桥、窗口捕获、插件进程管理、MCP 落盘）。
    /// message 保留原文案；机器码统一 `command_error`（原裸 String 无码，此为净新增）。
    #[error("{0}")]
    Command(String),
    /// ACP 域错误整包委托（#317 批次二 2c：边界区分度保留）——细分 code 经
    /// AcpError::code 委派（persist.rs 回放词汇表单源化），message 为 Display 原文；
    /// ReplayLoadInProgress 仍由 acp/mod.rs 特判折入 Storage（既有契约）。
    #[error(transparent)]
    AcpDomain(pylon_acp::AcpError),
    /// #705（方案 A）：prompt 失败事件的持久化发布失败——持久层错误保持主导
    /// （fail-loud：前端照旧看到持久层稳定码，消费方分支不受扰），同时 additive
    /// 携带触发本次发布失败的**原始 prompt 错误**（稳定码 + Display 原文），
    /// 消除「真实失败原因对前端断头、只进日志」的可解释性缺口。
    /// 序列化见本文件底部手写 impl：`{code, message, originalCode, originalMessage}`。
    #[error("prompt failure could not be committed; failure event was not published: {publish}")]
    FailurePublish {
        original_code: String,
        original_message: String,
        publish: Box<PylonError>,
    },
}

impl PylonError {
    /// 机器可读错误码（前端分支依据；稳定，不改拼写）。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Acp(_) => "acp_error",
            Self::AgentCrashed => "agent_crashed",
            Self::SessionNotFound(_) => "session_not_found",
            Self::SessionBindingUnavailable { .. } => "session_binding_unavailable",
            Self::AgentRuntimeUnavailable { .. } => "agent_runtime_unavailable",
            Self::NoActiveAgent => "no_active_agent",
            Self::Serialize(_) => "serialize_error",
            Self::Io(_) => "io_error",
            Self::Protocol(_) => "protocol_error",
            Self::CanonicalEvent(error) => error.code(),
            Self::MessagePersistence(error) => error.code(),
            Self::Workspace(_) => "workspace_error",
            Self::Prism(_) => "prism_error",
            Self::Git(_) => "git_error",
            Self::Plugin(error) => error.code(),
            Self::Config(error) => error.code(),
            Self::Gateway(error) => error.code(),
            Self::Storage(error) => error.code(),
            Self::UserData(error) => error.code(),
            Self::Retention(error) => error.code(),
            Self::Command(_) => "command_error",
            Self::AcpDomain(error) => error.code(),
            // #705：持久层错误保持主导——wire code 与既有 persistence 失败路径
            // 一致（如 event_db_unavailable），前端分支不受新变体影响。
            Self::FailurePublish { publish, .. } => publish.code(),
        }
    }

    /// 变体载荷原文（不含统一前缀）。仅用于把错误嵌入既有字符串/日志时保持
    /// 历史文案逐字不变（如 `data_dirs` 未初始化的 message）；wire 序列化仍走
    /// Display（`{code, message}` 契约不变）。
    pub(crate) fn raw_message(&self) -> String {
        match self {
            Self::Acp(message)
            | Self::Serialize(message)
            | Self::Io(message)
            | Self::Protocol(message)
            | Self::Workspace(message)
            | Self::Prism(message)
            | Self::Git(message)
            | Self::Command(message) => message.clone(),
            other => other.to_string(),
        }
    }
}

// Display/Error 由 thiserror derive（R2）；错误文案与手写 impl 逐字一致（契约不变）。

// B1.2：结构化 DTO——`{ "code", "message" }`（前端按 code 分支，message 展示用）。
// #705：`FailurePublish` 变体在此之上 additive 追加 `originalCode`/`originalMessage`
// 两键（4 键 map）；其余变体保持 2 键逐字节不变，消费方兼容性不受扰。
impl serde::Serialize for PylonError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        if let Self::FailurePublish {
            original_code,
            original_message,
            publish,
        } = self
        {
            let mut map = serializer.serialize_map(Some(4))?;
            map.serialize_entry("code", publish.code())?;
            map.serialize_entry("message", &publish.to_string())?;
            map.serialize_entry("originalCode", original_code)?;
            map.serialize_entry("originalMessage", original_message)?;
            return map.end();
        }
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        map.end()
    }
}

/// 内部 String 错误 → Protocol（保持消息，语义细化留待各子系统错误类型）。
impl From<String> for PylonError {
    fn from(msg: String) -> Self {
        PylonError::Protocol(msg)
    }
}

// ── Auto-conversion from std/third-party errors ──

impl From<std::io::Error> for PylonError {
    fn from(e: std::io::Error) -> Self {
        PylonError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for PylonError {
    fn from(e: serde_json::Error) -> Self {
        PylonError::Serialize(e.to_string())
    }
}

impl From<tokio::sync::oneshot::error::RecvError> for PylonError {
    fn from(_: tokio::sync::oneshot::error::RecvError) -> Self {
        PylonError::Protocol("ACP connection closed".into())
    }
}

impl From<tokio::sync::broadcast::error::RecvError> for PylonError {
    fn from(e: tokio::sync::broadcast::error::RecvError) -> Self {
        PylonError::Protocol(format!("broadcast: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_dto_serializes_code_and_message() {
        let error = PylonError::SessionNotFound("source-a".to_string());
        let value = serde_json::to_value(&error).expect("serialize DTO");
        assert_eq!(value["code"], "session_not_found");
        assert_eq!(value["message"], "session not found: source-a");

        let unavailable = serde_json::to_value(PylonError::SessionBindingUnavailable {
            session_source: "source-a".into(),
            health: "probing".into(),
        })
        .expect("serialize binding error DTO");
        assert_eq!(unavailable["code"], "session_binding_unavailable");
        assert!(unavailable["message"].as_str().is_some_and(|message| {
            message.contains("source-a") && message.contains("probing")
        }));

        let truncated = serde_json::to_value(PylonError::Storage(
            pylon_session::SessionError::ReplayTruncated { dropped_count: 3 },
        ))
        .expect("serialize replay error DTO");
        assert_eq!(truncated["code"], "replay_truncated");
        assert!(truncated["message"]
            .as_str()
            .is_some_and(|message| message.contains('3')));
    }

    #[test]
    fn error_codes_are_stable_and_machine_readable() {
        assert_eq!(PylonError::Acp("x".into()).code(), "acp_error");
        assert_eq!(PylonError::Command("x".into()).code(), "command_error");
        // #317 批次二 2c：AcpDomain 细分码委托（词汇表 = persist.rs 回放契约）。
        assert_eq!(
            PylonError::AcpDomain(pylon_acp::AcpError::RpcTimeout).code(),
            "rpc_timeout"
        );
        assert_eq!(
            PylonError::AcpDomain(pylon_acp::AcpError::Connect(Box::new(
                pylon_acp::AgentConnectFailure::preflight("preflight", "unavailable".into())
            )))
            .code(),
            "connect_error"
        );
        assert_eq!(PylonError::AgentCrashed.code(), "agent_crashed");
        assert_eq!(PylonError::NoActiveAgent.code(), "no_active_agent");
        assert_eq!(PylonError::Serialize("x".into()).code(), "serialize_error");
        assert_eq!(PylonError::Io("x".into()).code(), "io_error");
        assert_eq!(PylonError::Protocol("x".into()).code(), "protocol_error");
        assert_eq!(
            PylonError::CanonicalEvent(pylon_session::event_repo::EventError::Unavailable(
                "x".into()
            ))
            .code(),
            "event_db_unavailable"
        );
        assert_eq!(
            PylonError::MessagePersistence(pylon_session::msg_repo::MessageError::Conflict(
                "x".into()
            ))
            .code(),
            "message_repo_conflict"
        );
        assert_eq!(
            PylonError::Storage(pylon_session::SessionError::DatabaseFutureSchema {
                found: 11,
                supported: 10,
            })
            .code(),
            "database_future_schema"
        );
        assert_eq!(
            PylonError::Storage(pylon_session::SessionError::DatabaseSchemaInvalid(
                "x".into()
            ))
            .code(),
            "database_schema_invalid"
        );
        assert_eq!(
            PylonError::Storage(pylon_session::SessionError::DatabaseIntegrity("x".into())).code(),
            "database_integrity_failed"
        );
        assert_eq!(
            PylonError::Storage(pylon_session::SessionError::ReplayTruncated { dropped_count: 3 })
                .code(),
            "replay_truncated"
        );
        assert_eq!(
            PylonError::Storage(pylon_session::SessionError::ReplayLoadInProgress).code(),
            "replay_load_in_progress"
        );
        assert_eq!(PylonError::Workspace("x".into()).code(), "workspace_error");
        assert_eq!(PylonError::Prism("x".into()).code(), "prism_error");
        assert_eq!(PylonError::Git("x".into()).code(), "git_error");
        assert_eq!(
            PylonError::Gateway(crate::gateway::GatewayError::ConfigLockPoisoned).code(),
            "gateway_config_lock_poisoned"
        );
        assert_eq!(
            PylonError::Storage(pylon_session::SessionError::RevisionConflict {
                expected: 3,
                actual: 1
            })
            .code(),
            "retention_revision_conflict"
        );
        assert_eq!(
            PylonError::Storage(pylon_session::SessionError::StalePreview {
                expected: 2,
                actual: 3
            })
            .code(),
            "retention_stale_preview"
        );
        assert_eq!(
            PylonError::Config(crate::agent_config::ConfigError::Parse("x".into())).code(),
            "config_parse_error"
        );
    }

    #[test]
    fn string_converts_to_protocol_error_preserving_message() {
        let error = PylonError::from("custom failure".to_string());
        assert_eq!(error.code(), "protocol_error");
        assert_eq!(error.to_string(), "ACP protocol: custom failure");
    }
}

#[cfg(test)]
mod failure_publish_tests {
    use super::*;

    /// #705（方案 A）：FailurePublish 序列化 = 4 键（持久层 code/message 保持主导
    /// + additive originalCode/originalMessage）；其余变体保持 2 键逐字节契约。
    #[test]
    fn failure_publish_carries_original_error_and_keeps_2_key_contract() {
        let original = PylonError::AgentCrashed;
        let publish = PylonError::CanonicalEvent(
            pylon_session::event_repo::EventError::Unavailable("db down".into()),
        );
        let error = PylonError::FailurePublish {
            original_code: original.code().to_string(),
            original_message: original.to_string(),
            publish: Box::new(publish),
        };
        // 持久层错误保持主导：wire code 与既有 persistence 失败路径一致。
        assert_eq!(error.code(), "event_db_unavailable");
        let value = serde_json::to_value(&error).expect("serialize");
        assert_eq!(value["code"], "event_db_unavailable");
        assert!(
            value["message"].as_str().is_some_and(|m| m.contains("db down")),
            "message = 持久层错误 Display：{value}"
        );
        assert_eq!(value["originalCode"], "agent_crashed");
        assert_eq!(value["originalMessage"], "agent process crashed");
        assert_eq!(value.as_object().unwrap().len(), 4, "FailurePublish = 4 键");

        // 其余变体保持 2 键（消费方兼容性不受新变体影响）。
        let plain = serde_json::to_value(PylonError::AgentCrashed).expect("serialize");
        assert_eq!(plain.as_object().unwrap().len(), 2);
        assert_eq!(plain["code"], "agent_crashed");
    }
}
