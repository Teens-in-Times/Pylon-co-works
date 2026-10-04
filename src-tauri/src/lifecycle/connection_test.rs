//! 隔离连接测试命令（自 mod.rs 拆分；行为零变化）。
//!
//! test_agent_connection / test_agent_candidate：复用 ACP connect 做一次真实握手，
//! 成功即 kill；不修改 active agent、不写 runtimes registry、不触发事件广播。

use super::*;
use crate::acp::{AcpClient, AcpError, AgentConnectFailure, AgentConnectStage};
use crate::agent_config::AgentDef;
use crate::error::PylonError;
use crate::AppState;

use super::budgets::AGENT_VALIDATION_TIMEOUT_SECS;

pub(crate) fn connection_test_error_payload_with_diagnostics(
    error: &AcpError,
    stderr: Option<&str>,
    exit_code: Option<i32>,
) -> serde_json::Value {
    let fallback;
    let failure = match error {
        AcpError::Connect(failure) => failure,
        _ => {
            fallback = AgentConnectFailure {
                stage: AgentConnectStage::Initialize,
                code: "agent_initialize_failed".to_string(),
                message: error.to_string(),
                exit_code: None,
                stderr_excerpt: None,
                retryable: true,
                io_kind: None,
                remote_code: None,
                remote_data_summary: None,
            };
            &fallback
        }
    };
    let action = if failure.code == "agent_executable_missing" {
        "select_executable"
    } else {
        "open-runtime-log"
    };
    serde_json::json!({
        "code": failure.code,
        "message": failure.message,
        "action": action,
        "stage": failure.stage,
        "exitCode": exit_code.or(failure.exit_code),
        "stderr": stderr.or(failure.stderr_excerpt.as_deref()),
        "retryable": failure.retryable,
        "ioKind": failure.io_kind,
        "remoteCode": failure.remote_code,
        "remoteDataSummary": failure.remote_data_summary,
        // B4：统一 cause DTO（与 preflight/崩溃 cause 同形，封闭 code 词表）。
        "cause": crate::acp::cause::connect_failure_cause(failure),
    })
}

pub(crate) fn connection_test_error_payload(error: &AcpError) -> serde_json::Value {
    connection_test_error_payload_with_diagnostics(error, None, None)
}

/// 连接测试超时的 error payload（两处超时分支共用；字段与连接失败 payload 同形）。
pub(crate) fn connection_timeout_payload(
    timeout_secs: u64,
    stderr: Option<String>,
) -> serde_json::Value {
    serde_json::json!({
        "code": "agent_connection_timeout",
        "message": format!("连接测试超时（{timeout_secs}s）"),
        "action": "open-runtime-log",
        "stage": "timeout",
        "exitCode": null,
        "stderr": stderr,
        "retryable": true,
        "ioKind": null,
        "remoteCode": null,
        "remoteDataSummary": null,
        "cause": crate::acp::cause::DiagnosticCause {
            level: "fail",
            code: "agent_connection_timeout".to_string(),
            summary: format!("连接测试超时（{timeout_secs}s）"),
            action: Some("open-runtime-log"),
        },
    })
}

/// B1：连接测试响应携带的启动计划视图——与真实 spawn 走同一个 planner
/// （`acp::launch_plan::plan_for_agent`），所以「测试连接看到的」与「实际启动的」
/// 不可能漂移。env 只下发名称，值一律 `value withheld`：计划数据可能包含
/// 凭据型环境变量，掩码发生在边界而不是渲染端。
pub(crate) fn launch_plan_payload(agent: &AgentDef) -> serde_json::Value {
    let planned = crate::acp::plan_for_agent(
        agent,
        None,
        &pylon_core::agent_launch_plan::LaunchDetection::default(),
        Vec::new(),
    );
    match planned {
        Ok(plan) => {
            let mut argv = vec![plan.executable.clone()];
            argv.extend(plan.args.iter().cloned());
            serde_json::json!({
                "provider": plan.provider,
                "executable": plan.executable,
                "argv": argv,
                "cwd": plan.cwd,
                "env": plan.env.iter().map(|(name, _)| serde_json::json!({
                    "name": name,
                    "value": "value withheld",
                })).collect::<Vec<_>>(),
                "diagnostics": plan.diagnostics.iter().map(|diagnostic| serde_json::json!({
                    "code": diagnostic.code,
                    "stage": diagnostic.stage,
                    "message": diagnostic.message,
                })).collect::<Vec<_>>(),
            })
        }
        Err(error) => serde_json::json!({
            "error": error.to_string(),
        }),
    }
}

pub(crate) fn candidate_stderr(logs: &crate::runtime_log::RuntimeLogHub) -> Option<String> {
    let lines = logs
        .list(&crate::runtime_log::RuntimeLogQuery {
            source: Some("agent-stderr".to_string()),
            limit: Some(16),
            ..Default::default()
        })
        .into_iter()
        .rev()
        .map(|entry| entry.message)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let joined = lines.join("\n");
    Some(joined.chars().take(4096).collect())
}

async fn settle_candidate_stderr(started: std::time::Instant) {
    // stdout/RPC 关闭与 stderr reader 在不同异步任务中收敛。只使用握手总预算内
    // 尚未消耗的极短窗口，避免错误返回抢在最后一行安全诊断之前，同时保证命令
    // 从开始到返回仍不超过 15 秒的候选验证上限。
    let remaining = std::time::Duration::from_secs(AGENT_VALIDATION_TIMEOUT_SECS)
        .saturating_sub(started.elapsed());
    let settle = remaining.min(std::time::Duration::from_millis(50));
    if !settle.is_zero() {
        tokio::time::sleep(settle).await;
    }
}

/// 隔离连接测试（施工文档 §4.5）：复用 ACP connect 做一次真实握手，成功后立即
/// kill 子进程。不修改 active agent、不写 runtimes registry、不触发 agent-switched。
#[tauri::command]
pub(crate) async fn test_agent_connection(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    let agent = agent_from_registry(inner, &agent_id)?;

    // B3：连接测试也占全局实例预算（临时实例，独立 instance_id 命名空间，
    // 不与该 agent 的常驻实例互斥）；guard 随命令结束 RAII 归还。
    let test_instance_id = format!("{agent_id}:connection-test");
    let _instance_guard = crate::acp::instance_registry::instance_registry()
        .register(
            crate::acp::instance_registry::InstanceKey {
                agent_id: agent_id.clone(),
                instance_id: test_instance_id,
                generation: 0,
            },
            None,
        )
        .map_err(|error| PylonError::Protocol(error.to_string()))?;

    let started = std::time::Instant::now();
    // 施工文档 §4.5：后端用 tokio::time::timeout 包裹整个 connect；禁止无限等待。
    let timeout_secs = AGENT_VALIDATION_TIMEOUT_SECS;
    let launch_plan = launch_plan_payload(&agent);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        AcpClient::connect_with_generation(&agent, Some(inner.runtime_logs.clone()), 0),
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(client)) => {
            let _ = client.kill();
            Ok(serde_json::json!({
                "ok": true,
                "agentId": agent_id,
                "durationMs": duration_ms,
                "error": null,
                "launchPlan": launch_plan,
            }))
        }
        Ok(Err(error)) => Ok(serde_json::json!({
            "ok": false,
            "agentId": agent_id,
            "durationMs": duration_ms,
            "error": connection_test_error_payload(&error),
            "launchPlan": launch_plan,
        })),
        Err(_elapsed) => Ok(serde_json::json!({
            "ok": false,
            "agentId": agent_id,
            "durationMs": duration_ms,
            "error": connection_timeout_payload(timeout_secs, None),
            "launchPlan": launch_plan,
        })),
    }
}

/// Candidate validation is isolated like test_agent_connection, but consumes an ephemeral
/// definition and never writes agents.yaml or mutates the runtime registry.
///
/// #422：握手成功时签发保存门禁凭证——把「已验证的 launch 指纹」记入
/// `verified_agent_fingerprints`，供 `update_agents_config` 保存同指纹候选时消费。
/// 凭证 def 必须与保存候选**同构**（见 [`voucher_def`]），否则测试通过但保存被拒。
#[tauri::command]
pub(crate) async fn test_agent_candidate(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    agent: AgentDef,
    agent_yaml: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    // agent_yaml（scope=agent 的 YAML 整块入口）：整块替换语义，省略字段 = 默认值，
    // 与 apply_agent_patch 候选一致，直接反序列化为完整 def 测试。
    let agent = match agent_yaml.as_deref() {
        Some(yaml) => parse_agent_yaml_def(yaml)?,
        None => agent,
    };
    // B3：候选验证同样占全局实例预算（临时实例；guard 随命令 RAII 归还）。
    let test_instance_id = format!("{agent_id}:candidate-test");
    let _instance_guard = crate::acp::instance_registry::instance_registry()
        .register(
            crate::acp::instance_registry::InstanceKey {
                agent_id: agent_id.clone(),
                instance_id: test_instance_id,
                generation: 0,
            },
            None,
        )
        .map_err(|error| PylonError::Protocol(error.to_string()))?;

    let started = std::time::Instant::now();
    let timeout_secs = AGENT_VALIDATION_TIMEOUT_SECS;
    // 候选验证使用隔离日志池：既能返回该次握手的安全 stderr，又不污染运行时日志。
    let diagnostic_logs = crate::runtime_log::RuntimeLogHub::new(64);
    let launch_plan = launch_plan_payload(&agent);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        AcpClient::connect_with_generation(&agent, Some(diagnostic_logs.clone()), 0),
    )
    .await;
    match result {
        Ok(Ok(client)) => {
            let _ = client.kill();
            let duration_ms = started.elapsed().as_millis() as u64;
            record_verification_voucher(state.inner(), &agent_id, &agent, agent_yaml.is_none());
            Ok(
                serde_json::json!({ "ok": true, "agentId": agent_id, "durationMs": duration_ms, "error": null, "launchPlan": launch_plan }),
            )
        }
        Ok(Err(error)) => {
            settle_candidate_stderr(started).await;
            let duration_ms = started.elapsed().as_millis() as u64;
            let stderr = candidate_stderr(&diagnostic_logs);
            Ok(serde_json::json!({
                "ok": false,
                "agentId": agent_id,
                "durationMs": duration_ms,
                "error": connection_test_error_payload_with_diagnostics(&error, stderr.as_deref(), None),
                "launchPlan": launch_plan,
            }))
        }
        Err(_) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            Ok(serde_json::json!({
                "ok": false,
                "agentId": agent_id,
                "durationMs": duration_ms,
                "error": connection_timeout_payload(timeout_secs, candidate_stderr(&diagnostic_logs)),
                "launchPlan": launch_plan,
            }))
        }
    }
}

/// 单 agent 条目级 YAML（scope=agent 的 patch 形态）→ AgentDef。
/// 空 name/exe 防御：命令层尽早拒绝，不把必然非法的 def 拿去握手/签发。
fn parse_agent_yaml_def(yaml: &str) -> Result<AgentDef, PylonError> {
    use crate::agent_config::ConfigError;
    let def: AgentDef = serde_yml::from_str(yaml).map_err(|error| {
        PylonError::Config(ConfigError::Parse(format!("候选 YAML 解析失败: {error}")))
    })?;
    if def.name.trim().is_empty() || def.exe.trim().is_empty() {
        return Err(PylonError::Config(ConfigError::InvalidAgent(
            "候选 YAML 缺少 name 或 exe".to_string(),
        )));
    }
    Ok(def)
}

/// #422：测试通过后用于签发凭证的 def——必须与保存候选同构，指纹才可比。
///
/// 结构化（agent JSON）路径复刻 `apply_agent_field_patch` 的合成语义：registry
/// 当前 def 为 base，前端可编辑字段（name/provider/transport/exe/args）以测试值
/// 覆盖，高级字段（env/cwd/acp/model/hermes_profile…）保留原值——测试验证的
/// 就是「保存后将要启动的完整配置」，而不是裸字段 + 默认高级字段的漂移组合。
/// agent 不在 registry（新 id）时原样返回：其保存走 agent_create 路径，不消费凭证。
fn voucher_def(registry_base: Option<&AgentDef>, tested: &AgentDef) -> AgentDef {
    match registry_base {
        Some(base) => {
            let mut merged = base.clone();
            merged.name = tested.name.clone();
            merged.provider = tested.provider.clone();
            merged.transport = tested.transport.clone();
            merged.exe = tested.exe.clone();
            merged.args = tested.args.clone();
            merged
        }
        None => tested.clone(),
    }
}

/// 签发凭证：按候选同构 base 解析路径（与 parse_agents 的 resolve_paths 同一
/// base_dir = 外部配置目录）后计算 launch 指纹。embedded 无外部配置时不 resolve
/// ——该形态下 update 必然 config_read_only，凭证无消费点。
///
/// `compose_with_registry`：结构化（agent JSON）路径为 true（候选 = registry base
/// 叠加字段 patch）；agent_yaml 整块路径为 false（候选 = 测试 def 本身，省略字段
/// 两边都走默认）。
fn record_verification_voucher(
    inner: &AppState,
    agent_id: &str,
    tested: &AgentDef,
    compose_with_registry: bool,
) {
    let composed = if compose_with_registry {
        let registry_base = inner
            .agents
            .lock()
            .map(|agents| agents.get(agent_id).cloned())
            .unwrap_or(None);
        voucher_def(registry_base.as_ref(), tested)
    } else {
        tested.clone()
    };
    let base_dir = crate::agent_config::effective_config_path()
        .and_then(|path| path.parent().map(|dir| dir.to_path_buf()));
    let resolved = match base_dir {
        Some(dir) => composed.resolve_paths(&dir),
        None => composed,
    };
    inner
        .verified_agent_fingerprints
        .record(agent_id, &resolved.runtime_fingerprint());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_agent_yaml_def_accepts_entry_level_yaml_with_defaults() {
        let def = parse_agent_yaml_def("name: keep\ntransport: subprocess\nexe: keep-agent\n")
            .expect("合法条目 YAML 必须解析");
        assert_eq!(def.name, "keep");
        assert_eq!(def.exe, "keep-agent");
        assert!(def.args.is_empty(), "省略字段 = 默认值（整块替换语义）");
    }

    #[test]
    fn parse_agent_yaml_def_rejects_invalid_yaml_and_missing_launch_fields() {
        assert!(
            parse_agent_yaml_def("name: [broken\n").is_err(),
            "YAML 语法错误必须拒绝"
        );
        assert!(
            parse_agent_yaml_def("transport: subprocess\nexe: keep-agent\n").is_err(),
            "缺 name 必须拒绝"
        );
        assert!(
            parse_agent_yaml_def("name: keep\ntransport: subprocess\n").is_err(),
            "缺 exe 必须拒绝"
        );
    }

    #[test]
    fn voucher_def_merges_editable_fields_onto_registry_base() {
        // 结构化路径的合成语义 = apply_agent_field_patch 候选：registry base
        // 保留高级字段（env/hermes_profile…），前端可编辑五字段以测试值覆盖。
        let mut base = crate::test_utils::fake_acp_agent("keep", &[]);
        base.env
            .insert("API_TOKEN".to_string(), "secret".to_string());
        base.hermes_profile = Some("profile-a".to_string());
        let tested = crate::test_utils::fake_acp_agent("renamed", &["--scenario", "alive"]);
        let merged = voucher_def(Some(&base), &tested);
        assert_eq!(merged.name, "renamed", "name 以测试值覆盖");
        assert_eq!(merged.exe, tested.exe, "exe 以测试值覆盖");
        assert_eq!(merged.args, tested.args, "args 以测试值覆盖");
        assert_eq!(
            merged.env.get("API_TOKEN").map(String::as_str),
            Some("secret"),
            "env 保留 registry 原值（保存候选不丢高级字段）"
        );
        assert_eq!(merged.hermes_profile.as_deref(), Some("profile-a"));
    }
}
