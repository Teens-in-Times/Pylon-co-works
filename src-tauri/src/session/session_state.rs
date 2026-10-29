//! 会话级可恢复状态注册表。
//!
//! 统一把“会话切换后需要回填前端的状态量”声明在这里：
//! 每个状态项负责两件事——从会话响应捕获（capture）与回填到会话响应（restore）。
//! 以后新增状态量只需在 `SESSION_STATE_ENTRIES` 追加一项，无需改动 create/persist。

use super::model::SessionInfo;

pub(crate) struct SessionStateEntry {
    /// `None` = 该状态量在 `SessionInfo::apply_session_response` 的响应入口统一解析
    /// 并写入 typed 字段，这里无需重复捕获；restore 仍从 typed 字段回填。
    /// （#685：删除了两个只写 `let _ = session;` 的空捕获函数。）
    pub(crate) capture: Option<fn(&mut SessionInfo, &serde_json::Value)>,
    pub(crate) restore: fn(&SessionInfo, &mut serde_json::Value),
}

fn capture_usage(session: &mut SessionInfo, response: &serde_json::Value) {
    if let Some(usage) = response
        .get("usage")
        .or_else(|| {
            response
                .get("sessionInfo")
                .and_then(|info| info.get("usage"))
        })
        .cloned()
    {
        session.usage_snapshot = Some(usage);
    }
}

fn restore_usage(session: &SessionInfo, response: &mut serde_json::Value) {
    if response.get("usage").is_some() {
        return;
    }
    if let Some(usage) = session.usage_snapshot.as_ref() {
        if let Some(obj) = response.as_object_mut() {
            obj.insert("usage".to_string(), usage.clone());
        }
    }
}

fn capture_commands(session: &mut SessionInfo, response: &serde_json::Value) {
    let commands = response
        .get("commands")
        .or_else(|| response.get("availableCommands"))
        .cloned();
    if let Some(commands) = commands {
        session.commands_snapshot = Some(commands);
    }
}

fn restore_commands(session: &SessionInfo, response: &mut serde_json::Value) {
    if response.get("commands").is_some() || response.get("availableCommands").is_some() {
        return;
    }
    if let Some(commands) = session.commands_snapshot.as_ref() {
        if let Some(obj) = response.as_object_mut() {
            obj.insert("commands".to_string(), commands.clone());
        }
    }
}

fn restore_config_options(session: &SessionInfo, response: &mut serde_json::Value) {
    if response.get("configOptions").is_some() || session.config_options.is_empty() {
        return;
    }
    if let Some(obj) = response.as_object_mut() {
        obj.insert(
            "configOptions".to_string(),
            serde_json::json!(session.config_options),
        );
    }
}

fn restore_mode(session: &SessionInfo, response: &mut serde_json::Value) {
    if response.get("modes").is_some() {
        return;
    }
    let mode = session.mode.clone();
    if let Some(mode) = mode {
        if let Some(obj) = response.as_object_mut() {
            obj.insert(
                "modes".to_string(),
                serde_json::json!({ "currentModeId": mode }),
            );
        }
    }
}

pub(crate) static SESSION_STATE_ENTRIES: &[SessionStateEntry] = &[
    SessionStateEntry {
        capture: Some(capture_usage),
        restore: restore_usage,
    },
    SessionStateEntry {
        capture: Some(capture_commands),
        restore: restore_commands,
    },
    // configOptions / modes 由 apply_session_response 在入口解析，捕获为 None。
    SessionStateEntry {
        capture: None,
        restore: restore_config_options,
    },
    SessionStateEntry {
        capture: None,
        restore: restore_mode,
    },
];

pub(crate) fn capture_session_state(session: &mut SessionInfo, response: &serde_json::Value) {
    for entry in SESSION_STATE_ENTRIES {
        if let Some(capture) = entry.capture {
            capture(session, response);
        }
    }
}

pub(crate) fn restore_session_state(session: &SessionInfo, response: &mut serde_json::Value) {
    for entry in SESSION_STATE_ENTRIES {
        (entry.restore)(session, response);
    }
}
