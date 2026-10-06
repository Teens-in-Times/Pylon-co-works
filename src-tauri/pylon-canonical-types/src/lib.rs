//! WP1（issue #220）：canonical 事件 wire 契约的单源。
//!
//! 本 crate 只放**写入侧与投影侧都必须一致**的那部分事实，不依赖 Tauri、SQLite 或
//! 任何宿主能力，因此同一个 crate 能被 `src-tauri`（`session/event_repo.rs`）与
//! WASM 计算核（`pylon-compute`）同时依赖。**纯逻辑、无 IO、无时钟**。
//!
//! 单源化的对象：
//!
//! 1. **事件类型词表** —— 此前 TS（`src/domains/events/eventSchema.ts` 的
//!    `CANONICAL_EVENT_TYPES`）与 Rust（裸字符串字面量，`event_repo.rs` 等处 150+
//!    处）各持一份，且**没有任何门禁守着**。现在词表只在本文件声明一次，
//!    TS 侧由 `scripts/generate-canonical-event-types.mjs` 从本文件生成
//!    （`eventSchema.ts` 只做再导出）。
//! 2. **wire 判别符 → canonical 事件类型的映射** —— `sessionUpdate` 的 switch 此前
//!    在 TS `canonicalEventTypeFor` 与 Rust `normalize_kernel_event` 里各写一遍，
//!    是同一事实的两份手抄。
//! 3. **identity 推导** —— owner key 的 JSON 数组序列化纪律（禁冒号拼接）与
//!    `eventId = ownerKey#sequence`。
//!
//! 词表/映射的声明式单源由 `canonical_event_types!` 宏保证：enum、`as_str`、
//! `from_wire` 与 [`CANONICAL_EVENT_TYPES`] 全部由同一份 `Variant => "wire"` 列表
//! 展开，宏内不可能漂移。

use serde::{Deserialize, Serialize};

macro_rules! canonical_event_types {
    ($( $(#[$meta:meta])* $variant:ident => $wire:literal , )+) => {
        /// canonical 事件判别联合（wire 值见 [`CanonicalEventType::as_str`]）。
        ///
        /// 反序列化**只接受词表内的值**；存储层的未知字符串不走本类型（见
        /// `event_repo` 的 `CanonicalEventRow::event_type`，它按 `String` 原样保留，
        /// §5.10 原则 5 要求 unknown 不得静默丢弃、也不得改写历史行）。
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum CanonicalEventType {
            $( $(#[$meta])* #[serde(rename = $wire)] $variant, )+
        }

        /// 事件类型词表，**声明顺序即 wire 顺序**（与 TS 侧数组逐项对齐）。
        pub const CANONICAL_EVENT_TYPES: &[&str] = &[ $( $wire, )+ ];

        impl CanonicalEventType {
            /// 词表按声明顺序展开的类型数组。
            pub const ALL: &'static [CanonicalEventType] = &[
                $( CanonicalEventType::$variant, )+
            ];

            /// wire 字符串（与 TS 侧字面量逐字节一致）。
            pub const fn as_str(self) -> &'static str {
                match self {
                    $( CanonicalEventType::$variant => $wire, )+
                }
            }

            /// 由 wire 字符串还原；词表外的值返回 `None`（调用方决定归 unknown 还是报错）。
            pub fn from_wire(value: &str) -> Option<Self> {
                match value {
                    $( $wire => Some(CanonicalEventType::$variant), )+
                    _ => None,
                }
            }
        }
    };
}

canonical_event_types! {
    UserMessage => "user.message",
    AssistantTextDelta => "assistant.text.delta",
    AssistantThinkingDelta => "assistant.thinking.delta",
    /// sink 写入窗口聚合行（#81 L1）：typedPayload = { text, foldedCount, seqSpan }。
    AssistantTextDeltaBatch => "assistant.text.delta.batch",
    AssistantThinkingDeltaBatch => "assistant.thinking.delta.batch",
    ToolCallStarted => "tool.call.started",
    ToolCallUpdated => "tool.call.updated",
    ToolCallCompleted => "tool.call.completed",
    ToolCallFailed => "tool.call.failed",
    InteractionRequested => "interaction.requested",
    InteractionAnswered => "interaction.answered",
    TurnCompleted => "turn.completed",
    TurnFailed => "turn.failed",
    /// #81 L2：终结时追加的 turn 级单元行（保序 segment 数组 + content_sha256）。
    TurnUnit => "turn.unit",
    UsageUpdated => "usage.updated",
    PlanReplaced => "plan.replaced",
    SessionModeUpdated => "session.mode-updated",
    SessionModelUpdated => "session.model-updated",
    SessionConfigUpdated => "session.config-updated",
    SessionCommandsUpdated => "session.commands-updated",
    /// 完整 remote replay 的 append-only reconciliation checkpoint。
    HistorySnapshot => "history.snapshot",
    /// §5.10 原则 5：未识别判别符的归属，raw 恒保留。
    Unknown => "unknown",
}

impl CanonicalEventType {
    pub const fn is_unknown(self) -> bool {
        matches!(self, CanonicalEventType::Unknown)
    }
}

impl core::fmt::Display for CanonicalEventType {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 词表外的 wire 值（仅 [`CanonicalEventType::from_wire`] 之外的显式转换会用到）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownEventType(pub String);

impl core::fmt::Display for UnknownEventType {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "canonical 事件类型不在词表内: {}", self.0)
    }
}

impl std::error::Error for UnknownEventType {}

impl core::str::FromStr for CanonicalEventType {
    type Err = UnknownEventType;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::from_wire(value).ok_or_else(|| UnknownEventType(value.to_string()))
    }
}

/// wire `sessionUpdate` 判别符 → canonical 事件类型。
///
/// 这是 **TS `canonicalEventTypeFor` 与 Rust `normalize_kernel_event` 的同一个事实**，
/// 此前两处各写一份 switch。未识别 / 缺失判别符归 [`CanonicalEventType::Unknown`]
/// （不静默丢弃；调用方负责把 raw 保留下来）。
///
/// `tool_call_update` 按 `status` 细化：`completed` → 完成，`failed`/`error` → 失败，
/// 其余 → 更新中。`cancelled` 归入 `turn.failed` 这一族（终止性失败带显式 stopReason，
/// 不另发明第二种终态事件——语义桥消费不了）。
pub fn canonical_event_type_for(
    session_update: Option<&str>,
    status: Option<&str>,
) -> CanonicalEventType {
    match session_update {
        Some("user_message_chunk") => CanonicalEventType::UserMessage,
        Some("agent_message_chunk") => CanonicalEventType::AssistantTextDelta,
        Some("agent_thought_chunk") => CanonicalEventType::AssistantThinkingDelta,
        Some("tool_call") => CanonicalEventType::ToolCallStarted,
        Some("tool_call_update") if status == Some("completed") => {
            CanonicalEventType::ToolCallCompleted
        }
        Some("tool_call_update") if matches!(status, Some("failed" | "error")) => {
            CanonicalEventType::ToolCallFailed
        }
        Some("tool_call_update") => CanonicalEventType::ToolCallUpdated,
        Some("done") => CanonicalEventType::TurnCompleted,
        Some("error") => CanonicalEventType::TurnFailed,
        Some("cancelled") => CanonicalEventType::TurnFailed,
        Some("usage_update") => CanonicalEventType::UsageUpdated,
        Some("plan") => CanonicalEventType::PlanReplaced,
        Some("current_mode_update") => CanonicalEventType::SessionModeUpdated,
        Some("session_info_update") => CanonicalEventType::SessionModelUpdated,
        Some("config_option_update") => CanonicalEventType::SessionConfigUpdated,
        Some("available_commands_update") => CanonicalEventType::SessionCommandsUpdated,
        _ => CanonicalEventType::Unknown,
    }
}

/// owner key = `["profileId","agentId","localSessionId"]` 的 JSON 序列化。
///
/// 与 TS `toCanonicalOwnerKey` 同纪律：**JSON 数组，禁止冒号拼接**（source 可含冒号）。
/// 与 `DurableSessionOwner::key()` 逐字节等价。
pub fn canonical_owner_key(
    profile_id: &str,
    agent_id: &str,
    local_session_id: &str,
) -> Result<String, serde_json::Error> {
    serde_json::to_string(&[profile_id, agent_id, local_session_id])
}

/// #364：外部 CLI 历史导入会话的 profile 保留字。journal 的 owner 三元组要求
/// 三段非空，而导入会话没有 GUI Profile（「平台自动会话 profile=None」的既有
/// 纪律是 None ⇒ 不入 journal，不适用）——故引入保留字占位。与 provenance
/// origin `external-import` 同名同义（2026-10-05 用户裁决）；真实 Profile 的
/// id 空间不得使用该值（对应 provenance 组合恒 unverified，永不为 authoritative）。
pub const EXTERNAL_IMPORT_PROFILE_ID: &str = "external-import";

/// 事件唯一标识：`ownerKey#sequence`（确定性推导，与内容无关，禁 content 哈希）。
pub fn canonical_event_id(owner_key: &str, sequence: i64) -> String {
    format!("{owner_key}#{sequence}")
}

/// sequence 纯原语：`None` → 1（首事件），否则 +1。
pub const fn next_event_sequence(previous: Option<i64>) -> i64 {
    match previous {
        None => 1,
        Some(value) => value + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabulary_is_declared_in_wire_order() {
        // 词表顺序是 TS 生成物的对齐依据，改动即改变生成物——此处钉死。
        assert_eq!(
            CANONICAL_EVENT_TYPES,
            &[
                "user.message",
                "assistant.text.delta",
                "assistant.thinking.delta",
                "assistant.text.delta.batch",
                "assistant.thinking.delta.batch",
                "tool.call.started",
                "tool.call.updated",
                "tool.call.completed",
                "tool.call.failed",
                "interaction.requested",
                "interaction.answered",
                "turn.completed",
                "turn.failed",
                "turn.unit",
                "usage.updated",
                "plan.replaced",
                "session.mode-updated",
                "session.model-updated",
                "session.config-updated",
                "session.commands-updated",
                "history.snapshot",
                "unknown",
            ]
        );
    }

    #[test]
    fn all_agrees_with_vocabulary() {
        assert_eq!(CanonicalEventType::ALL.len(), CANONICAL_EVENT_TYPES.len());
        for (index, event_type) in CanonicalEventType::ALL.iter().enumerate() {
            assert_eq!(event_type.as_str(), CANONICAL_EVENT_TYPES[index]);
            assert_eq!(
                CanonicalEventType::from_wire(event_type.as_str()),
                Some(*event_type)
            );
        }
    }

    #[test]
    fn from_wire_rejects_values_outside_vocabulary() {
        assert_eq!(CanonicalEventType::from_wire("turn.started"), None);
        assert_eq!(CanonicalEventType::from_wire(""), None);
        assert_eq!(CanonicalEventType::from_wire("Unknown"), None);
        // 大小写敏感：wire 值不做归一化。
        assert_eq!(CanonicalEventType::from_wire("UNKNOWN"), None);
    }

    #[test]
    fn serde_round_trips_wire_strings() {
        for event_type in CanonicalEventType::ALL {
            let encoded = serde_json::to_string(event_type).expect("serialize");
            assert_eq!(encoded, format!("\"{}\"", event_type.as_str()));
            let decoded: CanonicalEventType = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, *event_type);
        }
    }

    #[test]
    fn discriminant_mapping_covers_every_wire_discriminator() {
        for (update, status, expected) in [
            (
                Some("user_message_chunk"),
                None,
                CanonicalEventType::UserMessage,
            ),
            (
                Some("agent_message_chunk"),
                None,
                CanonicalEventType::AssistantTextDelta,
            ),
            (
                Some("agent_thought_chunk"),
                None,
                CanonicalEventType::AssistantThinkingDelta,
            ),
            (Some("tool_call"), None, CanonicalEventType::ToolCallStarted),
            (
                Some("tool_call_update"),
                Some("completed"),
                CanonicalEventType::ToolCallCompleted,
            ),
            (
                Some("tool_call_update"),
                Some("failed"),
                CanonicalEventType::ToolCallFailed,
            ),
            (
                Some("tool_call_update"),
                Some("error"),
                CanonicalEventType::ToolCallFailed,
            ),
            (
                Some("tool_call_update"),
                Some("in_progress"),
                CanonicalEventType::ToolCallUpdated,
            ),
            (
                Some("tool_call_update"),
                None,
                CanonicalEventType::ToolCallUpdated,
            ),
            (Some("done"), None, CanonicalEventType::TurnCompleted),
            (Some("error"), None, CanonicalEventType::TurnFailed),
            (Some("cancelled"), None, CanonicalEventType::TurnFailed),
            (Some("usage_update"), None, CanonicalEventType::UsageUpdated),
            (Some("plan"), None, CanonicalEventType::PlanReplaced),
            (
                Some("current_mode_update"),
                None,
                CanonicalEventType::SessionModeUpdated,
            ),
            (
                Some("session_info_update"),
                None,
                CanonicalEventType::SessionModelUpdated,
            ),
            (
                Some("config_option_update"),
                None,
                CanonicalEventType::SessionConfigUpdated,
            ),
            (
                Some("available_commands_update"),
                None,
                CanonicalEventType::SessionCommandsUpdated,
            ),
            (Some("brand_new_kind"), None, CanonicalEventType::Unknown),
            (None, None, CanonicalEventType::Unknown),
        ] {
            assert_eq!(
                canonical_event_type_for(update, status),
                expected,
                "sessionUpdate={update:?} status={status:?}"
            );
        }
    }

    #[test]
    fn owner_key_matches_json_array_discipline() {
        // 冒号在 source 里合法，这正是禁止冒号拼接的理由。
        let key = canonical_owner_key("profile", "agent:with:colons", "local").expect("key");
        assert_eq!(key, r#"["profile","agent:with:colons","local"]"#);
    }

    #[test]
    fn owner_key_escapes_like_json() {
        let key = canonical_owner_key("p\"q", "a\\b", "l\nm").expect("key");
        assert_eq!(key, r#"["p\"q","a\\b","l\nm"]"#);
    }

    #[test]
    fn event_id_is_derived_from_owner_key_and_sequence() {
        let key = canonical_owner_key("p", "a", "l").expect("key");
        assert_eq!(
            canonical_event_id(&key, 3),
            format!("{key}#3"),
            "eventId 必须恒为 ownerKey#sequence"
        );
    }

    #[test]
    fn sequence_starts_at_one() {
        assert_eq!(next_event_sequence(None), 1);
        assert_eq!(next_event_sequence(Some(1)), 2);
        assert_eq!(next_event_sequence(Some(41)), 42);
    }
}
