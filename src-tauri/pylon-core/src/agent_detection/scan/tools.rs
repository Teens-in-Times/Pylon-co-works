//! 段6+7：机器事实工具证据（node/uv/path_gap，每次扫描各探一次）+ catalog 声明
//! 版本下限 gate（#486 项6 自 scan 长函数拆出，行为不变）。
use super::super::evidence::{dedup_roots, probe_tool_version};
use super::super::locate::controlled_roots;
use super::super::probe::scan_diagnostic;
use super::super::probe_cache::{
    needs_npm_version_fallback, npm_global_package_version, requires_tool,
};
use super::super::types::{
    AgentDetectionDiagnostic, AgentDetectionLimits, AgentProviderEvidence, AgentRuntimeCandidate,
};
use crate::agent_catalog::AgentDetectionProfile;
use crate::agent_preflight::ToolVersion;
use std::path::PathBuf;
use std::time::Instant;

/// 给 provider 证据附上 node/uv/path_gap 三项机器事实，并对声明了版本下限的
/// gate 逐个核对候选版本（npm 全局元数据仅在 gate 真正消费时才补探）。
/// 语句次序与原长函数 :302-393 一致；providers 与 diagnostics 原地更新。
pub(crate) async fn attach_tool_evidence(
    rules: &[AgentDetectionProfile],
    providers: &mut [AgentProviderEvidence],
    candidates: &[AgentRuntimeCandidate],
    limits: &AgentDetectionLimits,
    deadline: Instant,
    tool_roots: Option<Vec<PathBuf>>,
    diagnostics: &mut Vec<AgentDetectionDiagnostic>,
) {
    // A version-gated provider whose declared minimum cannot be proven from the
    // discovered evidence is reported here rather than silently accepted.
    // Node.js / uv are machine facts, not per-provider ones: probe each at most
    // once per scan, and only when a detected provider actually declares a
    // requirement for it. A scan limited to providers needing neither spawns
    // nothing extra.
    let mut needs_node = false;
    let mut needs_uv = false;
    for provider in providers.iter() {
        let Some(rule) = rules.iter().find(|rule| rule.provider == provider.provider) else {
            continue;
        };
        needs_node |= requires_tool(&rule.requires.node);
        needs_uv |= requires_tool(&rule.requires.uv);
    }
    let tool_budget = limits
        .version_probe_budget
        .min(deadline.saturating_duration_since(Instant::now()));
    let tool_roots = match tool_roots.as_deref() {
        Some(roots) => dedup_roots(controlled_roots(Some(roots))),
        None => controlled_roots(None),
    };
    let node = if needs_node {
        probe_tool_version("node", &[], &tool_roots, tool_budget).await
    } else {
        ToolVersion::default()
    };
    let uv = if needs_uv {
        probe_tool_version("uv", &[], &tool_roots, tool_budget).await
    } else {
        ToolVersion::default()
    };
    // Read once per scan, like the runtime tools above: the PATH a new process
    // would see is a property of the machine and of when this process started,
    // not of any one provider. The reading itself lives in
    // `agent_diagnostics` — the module that already owns environment evidence —
    // rather than a second implementation here.
    // #657：Windows 下这次读取会同步跑两次 `reg.exe query`，放 spawn_blocking；
    // 任务失败按 `PathGapReport::default()`（observed=false = 未观测）处理，
    // 与「读不到就不报 gap」的既有语义一致。
    let path_gap =
        match tokio::task::spawn_blocking(crate::agent_diagnostics::persisted_path_gap).await {
            Ok(report) => report,
            Err(error) => {
                tracing::warn!("persisted PATH probe task failed: {error}");
                crate::agent_diagnostics::PathGapReport::default()
            }
        };
    for provider in providers.iter_mut() {
        provider.node = node.clone();
        provider.uv = uv.clone();
        // Machine fact: read once and attach to every provider, for the same
        // reason Node is. Only a diagnosis reads it, and it answers the question
        // a status name cannot — whether a located executable is somewhere this
        // process can actually reach.
        provider.path_gap = path_gap.clone();
    }
    for provider in providers.iter_mut() {
        let Some(rule) = rules.iter().find(|r| r.provider == provider.provider) else {
            continue;
        };
        let Some(minimum) = rule
            .version_gates
            .iter()
            .find(|gate| gate.min_version.is_some())
            .and_then(|gate| gate.min_version.as_deref())
        else {
            continue;
        };
        let candidate_version: Option<String> = candidates
            .iter()
            .filter(|candidate| candidate.provider == provider.provider)
            .find_map(|candidate| {
                candidate
                    .evidence
                    .iter()
                    .find(|item| item.kind == "version")
                    .map(|item| item.detail.clone())
            });
        // The direct executable probe is authoritative; npm global metadata is the
        // one source it cannot supply, and is consulted only when a gate actually
        // consumes the value.
        if needs_npm_version_fallback(rule, candidate_version.as_deref()) {
            provider.adapter_version = npm_global_package_version(rule).await;
        }
        let observed = candidate_version.or_else(|| provider.adapter_version.clone());
        if let Some(version) = observed {
            if !crate::agent_preflight::version_at_least(Some(&version), Some(minimum)) {
                diagnostics.push(scan_diagnostic(
                    "version",
                    Some(provider.detector_id.clone()),
                    "adapter_version_below_declared_minimum",
                    format!(
                        "{} 的版本 {version} 低于 catalog 声明的下限 {minimum}",
                        provider.provider
                    ),
                    true,
                ));
            }
        }
    }
}
