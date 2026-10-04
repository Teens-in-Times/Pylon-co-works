//! host 工具路由缝（#317 批次二 ④ 自 mod.rs 主泵分支迁入；#416 W2 步骤①
//! 门与执行正身同域收口）：terminal/* 与 fs/* 的 host_tools_policy 门 +
//! 沙箱/registry 委派，及 `FsToolError`、fs/terminal 错误映射与
//! `respond_tool_error` 工具错误应答正身。两个分支在主泵中均为纯
//! `continue` 语义。

use super::{acp_snapshot, AcpLock, SessionsLock};
use agent_client_protocol_schema::v1::ErrorCode as WireErrorCode;
use pylon_acp::fs_policy::FsFailure;

/// #354：fs 请求错误面——runtime 分类错误（NotFound/Denied/Other）与参数/
/// 序列化错误分开承载，wire 映射见 `host_fs_error_response`。
enum FsToolError {
    Runtime(FsFailure),
    Message(String),
    UnsupportedMethod,
}

/// #354：fs 负路径 → wire 三元组（code, data, message）。`NotFound` → 官方
/// `resource_not_found`（-32002）+ `data:{uri}`；沙箱拒绝 → 保持 `-32602` 但
/// message 加 `sandbox:` 稳定前缀（agent 可区分「参数本身坏」与「沙箱拒绝」）；
/// 参数缺失/序列化失败维持 `-32602` 裸消息（wire 逐字不变）；不支持的方法按
/// 官方基线回 `-32601`（host 工具门按前缀放行，未知子方法会到达该臂）。
fn host_fs_error_response(
    error: &FsToolError,
) -> (WireErrorCode, Option<serde_json::Value>, String) {
    match error {
        FsToolError::Runtime(FsFailure::NotFound { uri }) => (
            WireErrorCode::ResourceNotFound,
            Some(serde_json::json!({ "uri": uri })),
            format!("resource not found: {uri}"),
        ),
        FsToolError::Runtime(FsFailure::SandboxDenied { message }) => (
            WireErrorCode::InvalidParams,
            None,
            format!("sandbox: {message}"),
        ),
        FsToolError::Runtime(FsFailure::Other(message)) => {
            (WireErrorCode::InvalidParams, None, message.clone())
        }
        FsToolError::Message(message) => (WireErrorCode::InvalidParams, None, message.clone()),
        FsToolError::UnsupportedMethod => (
            WireErrorCode::MethodNotFound,
            None,
            "unsupported filesystem method".to_string(),
        ),
    }
}

/// #354：terminal 负路径 → wire 三元组。registry（`pylon-acp`，#363 在途域）
/// 返回裸 `String`，这里按其稳定文案做最小分类：`terminal {id} not found` →
/// `-32002`（终端是资源，无 uri 载荷）；不支持的方法 → `-32601`；其余（如
/// `does not belong to session`）维持 `-32602` 裸消息。
fn host_terminal_error_response(error: &str) -> (WireErrorCode, Option<serde_json::Value>, String) {
    if error.contains(" not found") {
        (WireErrorCode::ResourceNotFound, None, error.to_string())
    } else if error == "unsupported terminal method" {
        (WireErrorCode::MethodNotFound, None, error.to_string())
    } else {
        (WireErrorCode::InvalidParams, None, error.to_string())
    }
}

/// #354：带 `data` 的 wire 错误应答（官方 `resource_not_found` 携带 `data:{uri}`）。
/// `ResponderHandle::respond_error` 不携带 data；经 pub 的 `pending_requests`
/// 取官方 SDK `Responder` 直发，不为单个调用点扩 pylon-acp 引擎面（#363 在途，
/// engine.rs 避让）。
async fn respond_tool_error(
    acp: &AcpLock,
    request_id: crate::acp::RequestId,
    (code, data, message): (WireErrorCode, Option<serde_json::Value>, String),
) {
    let responder = { acp_snapshot(acp).responder() };
    let pending = responder
        .pending_requests
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&request_id));
    let mut wire_error = agent_client_protocol::Error::new(i32::from(code), message);
    if let Some(data) = data {
        wire_error = wire_error.data(data);
    }
    if let Some(pending) = pending {
        let _ = pending.respond_with_error(wire_error);
    }
}

/// #316：strict fs 沙箱根解析——按 periId+generation 查会话工作区
/// （`SessionInfo.cwd`），不信任 agent 自报参数。查无映射/代际不符/cwd 为空
/// → None（调用方以 -32602 拒绝）。
fn session_workspace_root(
    sessions: &SessionsLock,
    peri_session: &str,
    generation: u64,
) -> Option<std::path::PathBuf> {
    sessions.lock().ok().and_then(|items| {
        items
            .values()
            .find(|session| session.peri_id == peri_session && session.generation == generation)
            .map(|session| std::path::PathBuf::from(&session.cwd))
            .filter(|cwd| !cwd.as_os_str().is_empty())
    })
}

async fn handle_terminal_request(
    acp: &AcpLock,
    registry: &crate::acp::terminal_runtime::TerminalRegistry,
    method: &str,
    request_id: crate::acp::RequestId,
    params: Option<&serde_json::Value>,
) {
    let object = params.and_then(serde_json::Value::as_object);
    let session_id = object
        .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let result = match method {
        "terminal/create" => {
            let command = match object
                .and_then(|p| p.get("command"))
                .and_then(serde_json::Value::as_str)
            {
                Some(command) => command,
                None => {
                    return {
                        let responder = { acp_snapshot(acp).responder() };
                        let _ = responder
                            .respond_error(
                                request_id,
                                WireErrorCode::InvalidParams,
                                "terminal/create requires command",
                            )
                            .await;
                    }
                }
            };
            let args = object
                .and_then(|p| p.get("args"))
                .and_then(serde_json::Value::as_array)
                .map(|args| {
                    args.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let line = shell_words::join(std::iter::once(command.to_owned()).chain(args));
            let cwd = object
                .and_then(|p| p.get("cwd"))
                .and_then(serde_json::Value::as_str)
                .map(std::path::Path::new);
            let limit = object
                .and_then(|p| p.get("outputByteLimit"))
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| usize::try_from(value).ok());
            registry
                .create_shell(session_id.to_owned(), None, &line, cwd, limit)
                .await
                .and_then(|terminal_id| {
                    // #316：响应由官方 Response 类型构造（wire 与手写 json!
                    // 逐字节一致）。序列化失败显式入 Err 走 -32602 应答路径，
                    // 不静默回 null（#316 审查 P2-1）。
                    serde_json::to_value(
                        agent_client_protocol_schema::v1::CreateTerminalResponse::new(terminal_id),
                    )
                    .map_err(|error| format!("serialize terminal/create response: {error}"))
                })
        }
        "terminal/output" => registry
            .snapshot(
                object
                    .and_then(|p| p.get("terminalId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                session_id,
            )
            .await
            .and_then(|snapshot| {
                serde_json::to_value(
                    agent_client_protocol_schema::v1::TerminalOutputResponse::new(
                        snapshot.output,
                        snapshot.truncated,
                    ),
                )
                .map_err(|error| format!("serialize terminal/output response: {error}"))
            }),
        "terminal/wait_for_exit" | "terminal/waitForExit" => registry
            .wait_for_exit(
                object
                    .and_then(|p| p.get("terminalId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                session_id,
            )
            .await
            .map(|status| serde_json::json!({"exitStatus": status})),
        "terminal/kill" => registry
            .kill(
                object
                    .and_then(|p| p.get("terminalId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                session_id,
            )
            .await
            .and_then(|_| {
                serde_json::to_value(agent_client_protocol_schema::v1::KillTerminalResponse::new())
                    .map_err(|error| format!("serialize terminal/kill response: {error}"))
            }),
        "terminal/release" => registry
            .release(
                object
                    .and_then(|p| p.get("terminalId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                session_id,
            )
            .await
            .and_then(|_| {
                serde_json::to_value(
                    agent_client_protocol_schema::v1::ReleaseTerminalResponse::new(),
                )
                .map_err(|error| format!("serialize terminal/release response: {error}"))
            }),
        _ => Err("unsupported terminal method".to_string()),
    };
    match result {
        Ok(value) => {
            let responder = { acp_snapshot(acp).responder() };
            let _ = responder.respond(request_id, value).await;
        }
        Err(error) => {
            respond_tool_error(acp, request_id, host_terminal_error_response(&error)).await;
        }
    }
}

async fn handle_filesystem_request(
    acp: &AcpLock,
    method: &str,
    request_id: crate::acp::RequestId,
    params: Option<&serde_json::Value>,
    runtime: crate::acp::file_system_runtime::FileSystemRuntime,
) {
    let object = params.and_then(serde_json::Value::as_object);
    let result: Result<serde_json::Value, FsToolError> = match method {
        "fs/read_text_file" => {
            match object
                .and_then(|p| p.get("path"))
                .and_then(serde_json::Value::as_str)
            {
                Some(path) => runtime
                    .read_text_file(std::path::Path::new(path))
                    .await
                    .map_err(FsToolError::Runtime)
                    .and_then(|content| {
                        serde_json::to_value(
                            agent_client_protocol_schema::v1::ReadTextFileResponse::new(content),
                        )
                        .map_err(|error| {
                            FsToolError::Message(format!(
                                "serialize fs/read_text_file response: {error}"
                            ))
                        })
                    }),
                None => Err(FsToolError::Message(
                    "fs/read_text_file requires path".to_string(),
                )),
            }
        }
        "fs/write_text_file" => {
            match (
                object
                    .and_then(|p| p.get("path"))
                    .and_then(serde_json::Value::as_str),
                object
                    .and_then(|p| p.get("content"))
                    .and_then(serde_json::Value::as_str),
            ) {
                (Some(path), Some(content)) => runtime
                    .write_text_file(std::path::Path::new(path), content)
                    .await
                    .map_err(FsToolError::Runtime)
                    .and_then(|_| {
                        serde_json::to_value(
                            agent_client_protocol_schema::v1::WriteTextFileResponse::new(),
                        )
                        .map_err(|error| {
                            FsToolError::Message(format!(
                                "serialize fs/write_text_file response: {error}"
                            ))
                        })
                    }),
                (None, _) => Err(FsToolError::Message(
                    "fs/write_text_file requires path".to_string(),
                )),
                (_, None) => Err(FsToolError::Message(
                    "fs/write_text_file requires content".to_string(),
                )),
            }
        }
        _ => Err(FsToolError::UnsupportedMethod),
    };
    let responder = { acp_snapshot(acp).responder() };
    match result {
        Ok(value) => {
            let _ = responder.respond(request_id, value).await;
        }
        Err(error) => {
            drop(responder);
            respond_tool_error(acp, request_id, host_fs_error_response(&error)).await;
        }
    }
}

/// terminal/* 请求（host_tools_policy 门；禁用回 Method Not Found）。
pub(crate) async fn route_terminal_request(
    acp: &AcpLock,
    terminal_registry: &crate::acp::terminal_runtime::TerminalRegistry,
    host_tools_policy: &std::sync::Mutex<crate::acp::host_tools::HostToolsPolicy>,
    raw: crate::acp::RawMessage,
) {
    if let Some(request_id) = raw.id {
        if host_tools_policy
            .lock()
            .map(|policy| policy.allows_terminal_request(raw.method.as_deref().unwrap_or_default()))
            .unwrap_or(false)
        {
            handle_terminal_request(
                acp,
                terminal_registry,
                raw.method.as_deref().unwrap_or_default(),
                request_id,
                raw.params.as_ref(),
            )
            .await;
        } else {
            let responder = { acp_snapshot(acp).responder() };
            let _ = responder
                .respond_error(
                    request_id,
                    WireErrorCode::MethodNotFound,
                    "host terminal tools are disabled for this agent",
                )
                .await;
        }
    }
}

/// fs/read_text_file | fs/write_text_file 请求（host_tools_policy 门 + strict 沙箱根）。
pub(crate) async fn route_fs_request(
    acp: &AcpLock,
    host_tools_policy: &std::sync::Mutex<crate::acp::host_tools::HostToolsPolicy>,
    sessions: &SessionsLock,
    generation: u64,
    raw: crate::acp::RawMessage,
) {
    if let Some(request_id) = raw.id {
        let allowed = host_tools_policy
            .lock()
            .map(|policy| policy.allows_fs_request(raw.method.as_deref().unwrap_or_default()))
            .unwrap_or(false);
        if allowed {
            // #316（P0 修复）：strict = fs 门为 host 档。沙箱根取自
            // **Pylon 会话工作区**（按 params.sessionId 查 peri_id 映射
            // 的 SessionInfo.cwd）——不取 agent 自报 cwd：官方 fs 请求
            // 形状本无 cwd 字段，且沙箱根若由 agent 声明即可被
            // prompt 注入逃逸（声明 `cwd: "C:\\"` 放大沙箱到全盘）。
            // unrestricted = 不设根限制（语义与门名对齐）。
            let strict = host_tools_policy
                .lock()
                .map(|p| p.fs == crate::agent_config::HostToolsMode::Host)
                .unwrap_or(false);
            let filesystem = if strict {
                let peri_session = raw
                    .params
                    .as_ref()
                    .and_then(|v| v.get("sessionId").or_else(|| v.get("session_id")))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let workspace = session_workspace_root(sessions, peri_session, generation);
                match workspace {
                    Some(workspace) => {
                        match crate::acp::file_system_runtime::FileSystemRuntime::new_strict(
                            &workspace,
                        ) {
                            Ok(filesystem) => filesystem,
                            Err(_) => {
                                let responder = { acp_snapshot(acp).responder() };
                                let _ = responder
                                    .respond_error(
                                        request_id,
                                        WireErrorCode::InvalidParams,
                                        "host filesystem workspace is inaccessible",
                                    )
                                    .await;
                                return;
                            }
                        }
                    }
                    None => {
                        let responder = { acp_snapshot(acp).responder() };
                        let _ = responder
                            .respond_error(
                                request_id,
                                WireErrorCode::InvalidParams,
                                "host filesystem sandbox unavailable: session workspace unknown",
                            )
                            .await;
                        return;
                    }
                }
            } else {
                crate::acp::file_system_runtime::FileSystemRuntime::new(Vec::new())
            };
            handle_filesystem_request(
                acp,
                raw.method.as_deref().unwrap_or_default(),
                request_id,
                raw.params.as_ref(),
                filesystem,
            )
            .await;
        } else {
            let responder = { acp_snapshot(acp).responder() };
            let _ = responder
                .respond_error(
                    request_id,
                    WireErrorCode::MethodNotFound,
                    "host filesystem tools are disabled for this agent",
                )
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SessionsLock;
    use super::{
        host_fs_error_response, host_terminal_error_response, session_workspace_root, FsToolError,
    };
    use crate::session::SessionInfo;
    use pylon_acp::fs_policy::FsFailure;

    /// #354：fs 负路径 → 官方 wire 语义（纯函数映射）。
    #[test]
    fn host_fs_errors_map_to_official_wire_semantics() {
        let (code, data, message) =
            host_fs_error_response(&FsToolError::Runtime(FsFailure::NotFound {
                uri: r"C:\w\missing.txt".into(),
            }));
        assert_eq!(i32::from(code), -32002);
        assert_eq!(
            data,
            Some(serde_json::json!({ "uri": r"C:\w\missing.txt" }))
        );
        assert_eq!(message, r"resource not found: C:\w\missing.txt");

        let (code, data, message) =
            host_fs_error_response(&FsToolError::Runtime(FsFailure::SandboxDenied {
                message: "path is outside allowed write roots: X".into(),
            }));
        assert_eq!(i32::from(code), -32602);
        assert!(data.is_none());
        assert!(message.starts_with("sandbox: "));

        // 其余失败 wire 逐字不变：-32602 裸消息、无 data。
        for error in [
            FsToolError::Runtime(FsFailure::Other("filesystem read timed out".into())),
            FsToolError::Message("fs/read_text_file requires path".into()),
        ] {
            let (code, data, message) = host_fs_error_response(&error);
            assert_eq!(i32::from(code), -32602);
            assert!(data.is_none());
            assert!(!message.starts_with("sandbox: "));
        }

        let (code, data, message) = host_fs_error_response(&FsToolError::UnsupportedMethod);
        assert_eq!(i32::from(code), -32601);
        assert!(data.is_none());
        assert_eq!(message, "unsupported filesystem method");
    }

    /// #354：terminal 负路径映射——registry 稳定文案的最小分类。
    #[test]
    fn host_terminal_errors_map_not_found_and_unsupported_method() {
        let (code, data, message) = host_terminal_error_response("terminal t-1 not found");
        assert_eq!(i32::from(code), -32002);
        assert!(data.is_none());
        assert_eq!(message, "terminal t-1 not found");

        let (code, _, _) = host_terminal_error_response("unsupported terminal method");
        assert_eq!(i32::from(code), -32601);

        for raw in [
            "terminal t-1 does not belong to session s-1",
            "serialize terminal/output response: x",
        ] {
            let (code, data, message) = host_terminal_error_response(raw);
            assert_eq!(i32::from(code), -32602, "{raw}");
            assert!(data.is_none(), "{raw}");
            assert_eq!(message, raw);
        }
    }

    #[test]
    fn session_workspace_root_resolves_by_peri_id_and_generation() {
        let sessions: SessionsLock = std::sync::Mutex::new(std::collections::HashMap::new());
        let mut s1 = SessionInfo::new("peri-1".into(), String::new(), "G:/ws/one".into(), true, 1);
        s1.generation = 1;
        let mut s2 = SessionInfo::new("peri-1".into(), String::new(), "G:/ws/two".into(), true, 2);
        s2.generation = 2;
        sessions.lock().unwrap().insert("local:1".into(), s1);
        sessions.lock().unwrap().insert("local:2".into(), s2);

        // 命中：periId + generation 双键，各代各归其工作区
        assert_eq!(
            session_workspace_root(&sessions, "peri-1", 1),
            Some(std::path::PathBuf::from("G:/ws/one"))
        );
        assert_eq!(
            session_workspace_root(&sessions, "peri-1", 2),
            Some(std::path::PathBuf::from("G:/ws/two"))
        );
        // 代际不符 → None（旧代际请求不进新代际沙箱）
        assert_eq!(session_workspace_root(&sessions, "peri-1", 3), None);
        // 未知 periId → None
        assert_eq!(session_workspace_root(&sessions, "peri-404", 1), None);
    }

    #[test]
    fn session_workspace_root_rejects_empty_cwd() {
        let sessions: SessionsLock = std::sync::Mutex::new(std::collections::HashMap::new());
        sessions.lock().unwrap().insert(
            "local:1".into(),
            SessionInfo::new("peri-empty".into(), String::new(), String::new(), true, 1),
        );
        assert_eq!(session_workspace_root(&sessions, "peri-empty", 1), None);
    }
}
