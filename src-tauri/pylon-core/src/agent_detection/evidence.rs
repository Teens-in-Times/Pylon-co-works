//! provider 证据 / config 证据 / 候选排序与身份合并纯函数（#67B 合并口径所在）。
use super::locate::{
    controlled_roots, executable_names, locate_command, locate_command_path, path_key,
    resolve_roots, resolve_stdio_executable, scan_roots, shared_config_present, FoundVia,
    LauncherResolution, LocatedRuntime,
};
use super::probe_cache::version_probe;
use super::types::{
    AgentDetectionEvidence, AgentEvidenceHit, AgentProviderEvidence, AgentRuntimeAlternative,
    AgentRuntimeCandidate, IdentityConfidence, ProtocolAvailability, Startability,
};
use crate::agent_catalog::{AgentDetectionProfile, CatalogConfigEvidence, CatalogConfigFormat};
use crate::agent_preflight::ToolVersion;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Measure one required runtime tool (Node.js / uv).
///
/// Bounded and read-only: a plain executable lookup plus the same managed
/// version probe the provider search uses (timeout, output cap, process-tree
/// cleanup). No install, no cache write, no environment mutation.
///
/// The three outcomes are deliberately distinct — a missing tool is `Absent`
/// (a real, fixable failure) while an unreadable version is `Unknown` (never
/// reported as a violation).
pub(crate) async fn probe_tool_version(
    command: &str,
    version_args: &[String],
    roots: &[PathBuf],
    budget: Duration,
) -> ToolVersion {
    let Some(path) = locate_command_path(command, roots) else {
        return ToolVersion::Absent;
    };
    if budget.is_zero() {
        return ToolVersion::Unknown;
    }
    let outcome = version_probe("builtin.tool", path, version_args, budget).await;
    match outcome.version {
        Some(version) => ToolVersion::Known(version),
        None => ToolVersion::Unknown,
    }
}

/// ACP + vendor-CLI evidence for one provider. The native side is probed only
/// when the catalog declares an adapter relation, which is the only case where
/// a second CLI is part of the story.
pub(crate) fn provider_evidence(
    rule: &AgentDetectionProfile,
    search_roots: Option<&[PathBuf]>,
    explicit_home: Option<&Path>,
) -> AgentProviderEvidence {
    let include_registry = search_roots.is_none();
    let roots = resolve_roots(rule, search_roots);
    let mut acp_commands: Vec<AgentEvidenceHit> = Vec::new();
    let mut seen = HashSet::new();
    for invocation in &rule.invocations {
        for hit in locate_command(&invocation.command, &roots, include_registry) {
            let key = format!("{}|", hit.path);
            if seen.insert(key) {
                acp_commands.push(AgentEvidenceHit {
                    kind: "acp-command".into(),
                    ..hit
                });
            }
        }
    }
    let native_commands = rule
        .adapter_relation
        .as_ref()
        .map(|relation| locate_command(&relation.native_cmd, &roots, include_registry))
        .unwrap_or_default();
    AgentProviderEvidence {
        provider: rule.provider.clone(),
        detector_id: rule.detector_id.clone(),
        adapter_relation_declared: rule.adapter_relation.is_some(),
        acp_commands,
        native_commands,
        shared_config_present: shared_config_present(rule.adapter_relation.as_ref(), explicit_home),
        // Runtime tools and the provider package version are machine facts that
        // need an async probe (and an npm query). This sync scan phase leaves
        // them at "not measured"; the caller fills them in.
        node: ToolVersion::default(),
        uv: ToolVersion::default(),
        adapter_version: None,
        path_gap: crate::agent_diagnostics::PathGapReport::default(),
    }
}

/// 候选排序元组：产出、身份合并与排序三步共用（候选本体 / rule.priority / 身份可信度 /
/// alias 序号 / 是否在 PATH 外 / 规范化路径键 / 原始来源标记）。
pub(crate) type RankedCandidate = (
    AgentRuntimeCandidate,
    i32,
    IdentityConfidence,
    usize,
    bool,
    String,
    String,
);

pub(crate) fn identity_rank(confidence: IdentityConfidence) -> u8 {
    match confidence {
        IdentityConfidence::High => 0,
        IdentityConfidence::Medium => 1,
    }
}

/// 已测试过的 ACP 握手是最强证据；未测试次之（未知）；握手失败最弱。
pub(crate) fn protocol_rank(availability: ProtocolAvailability) -> u8 {
    match availability {
        ProtocolAvailability::Verified => 0,
        ProtocolAvailability::NotTested => 1,
        ProtocolAvailability::Failed => 2,
    }
}

pub(crate) fn startability_rank(startability: Startability) -> u8 {
    match startability {
        Startability::Verified => 0,
        Startability::NotTested => 1,
        Startability::Failed => 2,
    }
}

/// 证据强度序（小者强）：身份可信度 → ACP 可用性 → 可启动性 → 既有稳定序
/// （rule.priority / alias 序号 / PATH 内优先 / 路径键 / args）。与调用方排序同源，
/// 保证合并结果确定且与既有候选排序口径一致。
pub(crate) fn compare_candidate_strength(
    left: &RankedCandidate,
    right: &RankedCandidate,
) -> std::cmp::Ordering {
    identity_rank(left.2)
        .cmp(&identity_rank(right.2))
        .then(
            protocol_rank(left.0.protocol_availability)
                .cmp(&protocol_rank(right.0.protocol_availability)),
        )
        .then(startability_rank(left.0.startability).cmp(&startability_rank(right.0.startability)))
        .then(right.1.cmp(&left.1))
        .then(left.3.cmp(&right.3))
        .then(left.4.cmp(&right.4))
        .then(left.5.cmp(&right.5))
        .then(left.0.args.cmp(&right.0.args))
}

pub(crate) fn candidate_version(candidate: &AgentRuntimeCandidate) -> Option<String> {
    candidate
        .evidence
        .iter()
        .find(|item| item.kind == "version")
        .map(|item| item.detail.clone())
}

/// issue #67B（Codeg 口径）：同一 agent 的多重证据合并为**一条**候选。
///
/// 身份由 `detector_id` / provider 决定，与安装路径无关（Codeg `registry.rs::registry_id_for`）；
/// vendor CLI 与 ACP 适配器是同一 agent 的两个证据面（`acp_adapter_relation`），不是两个实例。
///
/// 合并取最强证据作代表，但被折叠的形式**不静默丢弃**：写入 `evidence`
/// （kind=`folded-runtime`）、`alternatives` 与 `warnings`，并在版本不一致时显式告警；已导入的变体优先
/// 当代表，否则"已导入"会在合并后丢失并诱导重复导入。
pub(crate) fn merge_candidates_by_identity(ranked: Vec<RankedCandidate>) -> Vec<RankedCandidate> {
    let mut groups: Vec<(String, Vec<RankedCandidate>)> = Vec::new();
    for entry in ranked {
        let identity = entry.0.detector_id.clone();
        match groups.iter_mut().find(|(key, _)| *key == identity) {
            Some((_, bucket)) => bucket.push(entry),
            None => groups.push((identity, vec![entry])),
        }
    }
    let mut merged = Vec::with_capacity(groups.len());
    for (_, mut bucket) in groups {
        if bucket.len() == 1 {
            if let Some(entry) = bucket.pop() {
                merged.push(entry)
            }
            continue;
        }
        bucket.sort_by(compare_candidate_strength);
        let winner_index = bucket
            .iter()
            .position(|entry| entry.0.already_imported_agent_id.is_some())
            .unwrap_or(0);
        let mut winner = bucket.remove(winner_index);
        let winner_version = candidate_version(&winner.0);
        for variant in bucket {
            winner.0.alternatives.push(AgentRuntimeAlternative {
                candidate_id: variant.0.candidate_id.clone(),
                executable: variant.0.executable.clone(),
                args: variant.0.args.clone(),
                startability: variant.0.startability,
            });
            let variant_version = candidate_version(&variant.0);
            if let (Some(winner_version), Some(variant_version)) =
                (&winner_version, &variant_version)
            {
                if winner_version != variant_version {
                    winner.0.warnings.push(format!(
                        "同一 Agent 的多个安装版本不一致：{winner_version} / {variant_version}"
                    ));
                }
            }
            winner.0.warnings.push(format!(
                "同一 Agent 另有可执行形式：{} {}（可选择为启动入口）",
                variant.0.executable,
                variant.0.args.join(" ")
            ));
            winner.0.evidence.push(AgentDetectionEvidence {
                kind: "folded-runtime".into(),
                detail: format!(
                    "{} {} · 来源 {} · alias #{} · 版本 {}",
                    variant.0.executable,
                    variant.0.args.join(" "),
                    variant.6,
                    variant.3,
                    variant_version.unwrap_or_else(|| "未知".into())
                ),
            });
            if winner.0.already_imported_agent_id.is_none() {
                winner.0.already_imported_agent_id = variant.0.already_imported_agent_id.clone();
            }
        }
        merged.push(winner);
    }
    merged
}

pub(crate) fn dedup_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(path_key(root)))
        .collect()
}

pub(crate) fn find_rule(
    rule: &AgentDetectionProfile,
    search_roots: Option<&[PathBuf]>,
) -> Vec<LocatedRuntime> {
    let include_platform_roots = search_roots.is_none();
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let roots = resolve_roots(rule, search_roots);
    for (alias_index, invocation) in rule.invocations.iter().enumerate() {
        for (candidate, via) in scan_roots(&roots, &invocation.command, include_platform_roots) {
            // `FoundVia` is moved into the match, so each arm must produce an
            // owned label — borrowing the registry's `source` would dangle.
            let source = match via {
                FoundVia::Root { on_path: true } => "path".to_string(),
                FoundVia::Root { on_path: false } => "known-path".to_string(),
                FoundVia::Registry { source } => source,
            };
            let original = candidate.clone();
            let (executable, launcher_evidence, warnings) =
                match resolve_stdio_executable(&candidate) {
                    LauncherResolution::Direct => (candidate, Vec::new(), Vec::new()),
                    LauncherResolution::Resolved(target) => {
                        let evidence = vec![AgentDetectionEvidence {
                            kind: "stdio-launcher-target".into(),
                            detail: target.to_string_lossy().into_owned(),
                        }];
                        let warnings = vec![
                            "检测到会新开窗口的 launcher；已改用其真实可执行文件以保留 ACP stdio"
                                .into(),
                        ];
                        (target, evidence, warnings)
                    }
                    LauncherResolution::Incompatible => continue,
                };
            if !seen.insert((path_key(&executable), invocation.args.clone())) {
                continue;
            }
            let mut evidence = vec![AgentDetectionEvidence {
                kind: source,
                detail: original.to_string_lossy().into_owned(),
            }];
            evidence.extend(launcher_evidence);
            found.push(LocatedRuntime {
                executable,
                source: evidence[0].kind.clone(),
                args: invocation.args.clone(),
                alias_index,
                evidence,
                warnings,
            });
        }
    }
    found
}

pub fn configured_executable_key(executable: &str) -> String {
    let path = Path::new(executable);
    if path.is_absolute() || path.components().count() > 1 {
        return match resolve_stdio_executable(path) {
            LauncherResolution::Resolved(target) => path_key(&target),
            _ => path_key(path),
        };
    }
    for root in controlled_roots(None) {
        for name in executable_names(executable) {
            let candidate = root.join(name);
            if candidate.is_file() {
                return match resolve_stdio_executable(&candidate) {
                    LauncherResolution::Resolved(target) => path_key(&target),
                    _ => path_key(&candidate),
                };
            }
        }
    }
    path_key(path)
}

/// #685：home 解析收敛到 `pylon-foundations::home` 单一实现（与宿主
/// `external_history` 共用；本函数保留为检测域的薄别名）。
pub(crate) fn resolved_home_dir(explicit: Option<&Path>) -> Option<PathBuf> {
    pylon_foundations::home::resolve_home_dir(explicit)
}

pub(crate) fn field_present(value: &serde_json::Value, field_path: &str) -> bool {
    let mut current = value;
    for segment in field_path.split('.') {
        let Some(next) = current.get(segment) else {
            return false;
        };
        current = next;
    }
    match current {
        serde_json::Value::Null => false,
        serde_json::Value::String(value) => !value.trim().is_empty(),
        serde_json::Value::Array(value) => !value.is_empty(),
        serde_json::Value::Object(value) => !value.is_empty(),
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => true,
    }
}

pub(crate) fn structured_config_evidence(
    config_dir: &Path,
    rule: &CatalogConfigEvidence,
) -> Option<AgentDetectionEvidence> {
    let path = config_dir.join(&rule.relative_path);
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let document: serde_json::Value = match rule.format {
        CatalogConfigFormat::Json => serde_json::from_str(&content).ok()?,
        CatalogConfigFormat::Yaml => serde_yml::from_str(&content).ok()?,
    };
    let matched = rule
        .fields
        .iter()
        .filter(|field| field_present(&document, field))
        .cloned()
        .collect::<Vec<_>>();
    if matched.is_empty() {
        return None;
    }
    // Deliberately report field names only. Values may contain credentials and
    // must never cross the detector boundary into GUI/CLI output.
    Some(AgentDetectionEvidence {
        kind: "config-fields".into(),
        detail: format!("{} [{}]", path.to_string_lossy(), matched.join(", ")),
    })
}

pub(crate) fn config_evidence(
    rule: &AgentDetectionProfile,
    explicit_home: Option<&Path>,
) -> Vec<AgentDetectionEvidence> {
    let mut dirs = Vec::new();
    if let Some(home) = resolved_home_dir(explicit_home) {
        dirs.extend(rule.config_dirs.iter().map(|name| home.join(name)));
    }
    if explicit_home.is_none() && rule.provider == "hermes" {
        if let Some(value) = std::env::var_os("HERMES_HOME") {
            dirs.push(PathBuf::from(value))
        }
    }
    let mut seen = HashSet::new();
    dirs.retain(|path| seen.insert(path_key(path)));
    let mut evidence = Vec::new();
    for path in dirs.into_iter().filter(|path| path.is_dir()) {
        evidence.push(AgentDetectionEvidence {
            kind: "config-directory".into(),
            detail: path.to_string_lossy().to_string(),
        });
        evidence.extend(
            rule.config_evidence
                .iter()
                .filter_map(|config_rule| structured_config_evidence(&path, config_rule)),
        );
    }
    evidence
}
