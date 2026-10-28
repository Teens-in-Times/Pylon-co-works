//! #98：canonical 能力协商快照（声明—协商—消费者矩阵）。
//!
//! initialize 握手成功后的能力事实只有一份真源：[`NegotiatedCapabilitySnapshot`]。
//! session 建立（resume/load/new 排序）、重连 continuity probe、`agent_status`
//! 的结构化快照输出全部消费它——调用方不再各自拼接 capability path。
//!
//! 事实分层（spec §能力状态）：
//! - `Unknown`：未广告/类型错误，禁止调用；
//! - `Advertised`：Agent 明确广告，但 Pylon 尚未注册消费者；
//! - `Negotiated`：通过 catalog 声明 ∩ 服务端广告，满足调用前置条件；
//! - `Usable`：对应 wire/handler 已注册，调用链可执行。
//!
//! 兼容 alias 只在 [`CAPABILITY_MATRIX`] 显式登记的条目上生效（当前仅根级
//! `loadSession` 布尔——Peri 形状实证），canonical 嵌套路径恒优先；两者同时
//! 存在视为冲突，canonical 决定结论并产出诊断。object capability 只有 object
//! 值才算广告（`true`/`1`/字符串/null 均不算）；boolean capability 只有
//! 显式 `true`；双形状 capability（[`CapabilityKind::BooleanOrObject`]）两种
//! 合法形状皆算广告（#110 F2：ACP 标准把 `list`/`close` 定义为 object 形状，
//! 而线上存在显式 `true` 的旧广告，两者都必须接受）。未知路径/未知字段
//! fail-closed 且不影响其他条目。

use std::collections::{BTreeMap, BTreeSet};

use crate::capabilities::CapabilityRegistry;
use crate::initialize_plan::EstablishmentChannel;

/// 能力事实四态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityFact {
    Unknown,
    Advertised,
    Negotiated,
    Usable,
}

impl CapabilityFact {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Advertised => "advertised",
            Self::Negotiated => "negotiated",
            Self::Usable => "usable",
        }
    }
}

/// 广告值类型要求：boolean capability 只认 `true`；object capability 只认 object；
/// 双形状（`BooleanOrObject`）两者皆收。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityKind {
    Boolean,
    Object,
    /// #110 F2：ACP 标准形状是 object，线上又存在显式 `true` 的旧广告——两种形状
    /// 都算广告，其它值（`false`/`1`/字符串/null）仍 fail-closed。
    BooleanOrObject,
}

impl CapabilityKind {
    fn accepts(&self, value: &serde_json::Value) -> bool {
        match self {
            Self::Boolean => value.as_bool() == Some(true),
            Self::Object => value.is_object(),
            Self::BooleanOrObject => value.as_bool() == Some(true) || value.is_object(),
        }
    }

    fn describe(&self) -> &'static str {
        match self {
            Self::Boolean => "boolean true",
            Self::Object => "object",
            Self::BooleanOrObject => "object 或 boolean true",
        }
    }
}

/// 消费者（矩阵第三列）：没有注册消费者的能力不得对外 usable。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CapabilityConsumer {
    /// resume/load/new 排序与 continuity probe（revive 链）。
    SessionEstablishment,
    /// `session/close`（control.rs close_via_rpc）。
    SessionClose,
    /// `session/delete`（control.rs agent_session_delete，#398）。
    SessionDelete,
    /// `session/list`（persist.rs 会话枚举）。
    SessionList,
    /// `session/fork` raw RPC 消费者（session/fork.rs）。
    SessionFork,
    /// `elicitation/create` 通用交互桥（protocol_adapter）。
    Elicitation,
    /// prompt 携带 image block（protocol.rs 校验链）。
    PromptImage,
    /// MCP http/streamable-http 传输序列化（mcp.rs）。
    McpHttp,
    /// MCP sse 传输序列化（mcp.rs）。
    McpSse,
}

/// 广告来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilitySource {
    /// 标准 ACP 嵌套路径（真源）。
    Canonical,
    /// 根级兼容 alias（显式登记，计划弃用）。
    RootAlias,
    /// 宿主侧能力（无 agentCapabilities 广告维度，如 elicitation 方法桥）。
    Host,
    None,
}

impl CapabilitySource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Canonical => "canonical",
            Self::RootAlias => "root-alias",
            Self::Host => "host",
            Self::None => "none",
        }
    }
}

/// 矩阵条目：一条能力的路径、类型、alias 与消费者登记。
#[derive(Debug, Clone, Copy)]
pub struct CapabilityMatrixEntry {
    /// 稳定能力 id（wire 投影键）。
    pub id: &'static str,
    /// agentCapabilities 广告形状；`None` = 宿主侧能力（无广告维度）。
    pub advertisement: Option<(&'static [&'static str], CapabilityKind)>,
    /// 根级兼容 alias（仅在 canonical 缺失时读取；显式登记 + 弃用计划）。
    pub alias: Option<(&'static [&'static str], CapabilityKind)>,
    /// 是否要求 catalog 声明（establishment order）参与协商交集。
    pub requires_declaration: bool,
    /// 消费者；`None` = 尚无消费者（恒不可 usable）。
    pub consumer: Option<CapabilityConsumer>,
}

/// 声明—协商—消费者矩阵（#98 验收：新增能力只在这里登记 + 测试）。
pub const CAPABILITY_MATRIX: &[CapabilityMatrixEntry] = &[
    CapabilityMatrixEntry {
        id: "resume",
        advertisement: Some((&["sessionCapabilities", "resume"], CapabilityKind::Object)),
        alias: None,
        requires_declaration: true,
        consumer: Some(CapabilityConsumer::SessionEstablishment),
    },
    CapabilityMatrixEntry {
        id: "load",
        advertisement: Some((
            &["sessionCapabilities", "loadSession"],
            CapabilityKind::Object,
        )),
        // 根级 `loadSession: true`（Peri 形状实证）——兼容 alias，弃用计划见 ADR-0004。
        alias: Some((&["loadSession"], CapabilityKind::Boolean)),
        requires_declaration: true,
        consumer: Some(CapabilityConsumer::SessionEstablishment),
    },
    CapabilityMatrixEntry {
        id: "fork",
        advertisement: Some((&["sessionCapabilities", "fork"], CapabilityKind::Object)),
        alias: None,
        requires_declaration: false,
        consumer: Some(CapabilityConsumer::SessionFork),
    },
    CapabilityMatrixEntry {
        id: "close",
        advertisement: Some((
            &["sessionCapabilities", "close"],
            CapabilityKind::BooleanOrObject,
        )),
        alias: None,
        requires_declaration: false,
        consumer: Some(CapabilityConsumer::SessionClose),
    },
    CapabilityMatrixEntry {
        // #398：官方形状为 object（SessionDeleteCapabilities 空结构，schema 1.9.1）；
        // 与 list/close 同按双形状收（防线上显式 `true` 旧广告）。
        id: "delete",
        advertisement: Some((
            &["sessionCapabilities", "delete"],
            CapabilityKind::BooleanOrObject,
        )),
        alias: None,
        requires_declaration: false,
        consumer: Some(CapabilityConsumer::SessionDelete),
    },
    CapabilityMatrixEntry {
        id: "list",
        advertisement: Some((
            &["sessionCapabilities", "list"],
            CapabilityKind::BooleanOrObject,
        )),
        alias: None,
        requires_declaration: false,
        consumer: Some(CapabilityConsumer::SessionList),
    },
    CapabilityMatrixEntry {
        id: "promptImage",
        advertisement: Some((&["promptCapabilities", "image"], CapabilityKind::Boolean)),
        alias: None,
        requires_declaration: false,
        consumer: Some(CapabilityConsumer::PromptImage),
    },
    CapabilityMatrixEntry {
        id: "mcpHttp",
        advertisement: Some((&["mcpCapabilities", "http"], CapabilityKind::Boolean)),
        alias: None,
        requires_declaration: false,
        consumer: Some(CapabilityConsumer::McpHttp),
    },
    CapabilityMatrixEntry {
        id: "mcpSse",
        advertisement: Some((&["mcpCapabilities", "sse"], CapabilityKind::Boolean)),
        alias: None,
        requires_declaration: false,
        consumer: Some(CapabilityConsumer::McpSse),
    },
    CapabilityMatrixEntry {
        id: "elicitation",
        advertisement: None,
        alias: None,
        requires_declaration: false,
        consumer: Some(CapabilityConsumer::Elicitation),
    },
];

// #684：消费者集合是宿主产品配置，由 AppState 在启动时一次性注入
// （`NegotiatedCapabilitySnapshot::from_parts` 的 `consumers` 参数）——本 crate
// 不再持有进程级可变注册表，测试各自构造集合，互不影响。

/// 单条能力的协商结论。
#[derive(Debug, Clone, PartialEq)]
pub struct CapabilityDecision {
    pub fact: CapabilityFact,
    pub source: CapabilitySource,
    /// 三层布尔投影（与 fact 同源；advertised 对宿主侧能力为 None）。
    pub advertised: Option<bool>,
    pub negotiated: bool,
    pub usable: bool,
    /// 诊断（alias 来源、类型错误、冲突、缺消费者），随 wire 投影输出。
    pub diagnostics: Vec<String>,
}

/// 一次 initialize 协商的不可变快照：矩阵全条目结论 + 广告原文 + generation。
#[derive(Debug, Clone)]
pub struct NegotiatedCapabilitySnapshot {
    entries: BTreeMap<&'static str, CapabilityDecision>,
    /// 广告原文（诊断保留；未知扩展字段不丢失）。
    raw: Option<serde_json::Value>,
    /// 绑定的 connection generation（旧连接快照不得授权新连接调用）。
    pub generation: u64,
    /// catalog 声明序（establishment order，通道排序用）。
    declared: Vec<String>,
}

/// 按 literal key 逐段解析 raw agentCapabilities（点号是私有扩展名的一部分，
/// 不是路径分隔符——与 [`CapabilityRegistry::state`] 同约定）。
fn resolve_path<'a>(
    raw: Option<&'a serde_json::Value>,
    path: &[&str],
) -> Option<&'a serde_json::Value> {
    let mut value = raw;
    for key in path {
        value = value.and_then(serde_json::Value::as_object)?.get(*key);
    }
    value
}

fn describe_type(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

impl NegotiatedCapabilitySnapshot {
    /// 从 registry + catalog 声明 + 消费者集合计算快照（纯函数，测试可直构）。
    pub fn from_parts(
        registry: &CapabilityRegistry,
        declared: &[String],
        generation: u64,
        consumers: &BTreeSet<CapabilityConsumer>,
    ) -> Self {
        let raw = registry.raw().cloned();
        let mut entries = BTreeMap::new();
        for entry in CAPABILITY_MATRIX {
            let decision = match entry.advertisement {
                Some((path, kind)) => {
                    let canonical_value = resolve_path(registry.raw(), path);
                    let alias_value = entry
                        .alias
                        .and_then(|(alias_path, _)| resolve_path(registry.raw(), alias_path));
                    let mut diagnostics = Vec::new();
                    let (advertised, source) = match (canonical_value, alias_value) {
                        (Some(value), alias_present) => {
                            if alias_present.is_some() {
                                diagnostics.push(format!(
                                    "capability '{}': canonical 与根级 alias 同时存在，以 canonical 为准",
                                    entry.id
                                ));
                            }
                            if kind.accepts(value) {
                                (true, CapabilitySource::Canonical)
                            } else {
                                diagnostics.push(format!(
                                    "capability '{}': {} 类型错误（实际 {}，要求 {}），fail-closed",
                                    entry.id,
                                    path.join("."),
                                    describe_type(value),
                                    kind.describe()
                                ));
                                (false, CapabilitySource::Canonical)
                            }
                        }
                        (None, Some(value)) => {
                            let (alias_path, alias_kind) =
                                entry.alias.expect("alias_value 存在则 alias 已登记");
                            if alias_kind.accepts(value) {
                                diagnostics.push(format!(
                                    "capability '{}': 根级 alias {} 生效（兼容形状，计划弃用）",
                                    entry.id,
                                    alias_path.join(".")
                                ));
                                (true, CapabilitySource::RootAlias)
                            } else {
                                diagnostics.push(format!(
                                    "capability '{}': 根级 alias {} 类型错误（实际 {}，要求 {}），fail-closed",
                                    entry.id,
                                    alias_path.join("."),
                                    describe_type(value),
                                    alias_kind.describe()
                                ));
                                (false, CapabilitySource::RootAlias)
                            }
                        }
                        (None, None) => (false, CapabilitySource::None),
                    };
                    let declared_ok =
                        !entry.requires_declaration || declared.iter().any(|name| name == entry.id);
                    let negotiated = advertised && declared_ok;
                    let usable =
                        negotiated && entry.consumer.is_some_and(|c| consumers.contains(&c));
                    if advertised && !usable {
                        if !negotiated {
                            diagnostics.push(format!(
                                "capability '{}': 已广告但 catalog 未声明，不满足调用前置条件",
                                entry.id
                            ));
                        } else if entry.consumer.is_none() {
                            diagnostics.push(format!(
                                "capability '{}': 已广告但未落地消费者，不可 usable",
                                entry.id
                            ));
                        } else {
                            diagnostics.push(format!(
                                "capability '{}': 已广告但消费者未注册，不可 usable",
                                entry.id
                            ));
                        }
                    }
                    let fact = if usable {
                        CapabilityFact::Usable
                    } else if negotiated {
                        CapabilityFact::Negotiated
                    } else if advertised {
                        CapabilityFact::Advertised
                    } else {
                        CapabilityFact::Unknown
                    };
                    CapabilityDecision {
                        fact,
                        source,
                        advertised: Some(advertised),
                        negotiated,
                        usable,
                        diagnostics,
                    }
                }
                None => {
                    // 宿主侧能力：无广告维度，协商前置 = 消费者注册。
                    let usable = entry.consumer.is_some_and(|c| consumers.contains(&c));
                    let mut diagnostics = Vec::new();
                    if !usable {
                        diagnostics.push(format!(
                            "capability '{}': 宿主消费者未注册，不可 usable",
                            entry.id
                        ));
                    }
                    CapabilityDecision {
                        fact: if usable {
                            CapabilityFact::Usable
                        } else {
                            CapabilityFact::Unknown
                        },
                        source: if usable {
                            CapabilitySource::Host
                        } else {
                            CapabilitySource::None
                        },
                        advertised: None,
                        negotiated: usable,
                        usable,
                        diagnostics,
                    }
                }
            };
            entries.insert(entry.id, decision);
        }
        Self {
            entries,
            raw,
            generation,
            declared: declared.to_vec(),
        }
    }

    pub fn decision(&self, id: &str) -> Option<&CapabilityDecision> {
        self.entries.get(id)
    }

    /// 广告侧事实（canonical 或 alias 命中即 true）——create.rs 的 typed 平价断言消费。
    pub fn advertised(&self, id: &str) -> bool {
        self.decision(id)
            .is_some_and(|decision| decision.advertised.unwrap_or(false) || decision.usable)
    }

    /// 调用前置条件（协商通过）：probe / establishment 的 gate。
    pub fn negotiated(&self, id: &str) -> bool {
        self.decision(id)
            .is_some_and(|decision| decision.negotiated)
    }

    /// 可执行 gate（IPC/UI 投影）：消费者已注册。
    pub fn usable(&self, id: &str) -> bool {
        self.decision(id).is_some_and(|decision| decision.usable)
    }

    pub fn load_supported(&self) -> bool {
        self.negotiated("load")
    }

    pub fn resume_supported(&self) -> bool {
        self.negotiated("resume")
    }

    pub fn fork_usable(&self) -> bool {
        self.usable("fork")
    }

    /// establishment 通道 = catalog 声明序 ∩ 协商快照（与旧
    /// `session_establishment_channels(declared, registry)` 同结论，真源换成本快照）。
    /// 未知声明名 fail-closed：拼错的 policy 必须在计划层显形，而不是被静默丢弃。
    pub fn establishment_channels(&self) -> Result<Vec<EstablishmentChannel>, String> {
        let mut channels = Vec::new();
        for declared in &self.declared {
            match declared.as_str() {
                "resume" if self.resume_supported() => channels.push(EstablishmentChannel::Resume),
                "load" if self.load_supported() => channels.push(EstablishmentChannel::Load),
                "new" => channels.push(EstablishmentChannel::New),
                "resume" | "load" => {}
                other => {
                    return Err(format!(
                        "sessionEstablishment 声明了未知通道：{other}（合法值：resume/load/new）"
                    ))
                }
            }
        }
        Ok(channels)
    }

    /// 广告原文（AC12：raw envelope 保真——未知扩展字段可回放；测试/诊断消费，
    /// IPC 的原文仍由 agent_status.capabilities 独立携带，不在此重复投影）。
    #[allow(dead_code)]
    pub fn raw(&self) -> Option<&serde_json::Value> {
        self.raw.as_ref()
    }
    /// IPC 投影：三层布尔 + fact + source + diagnostics（AC13：Rust/IPC/TS 一致）。
    pub fn wire_value(&self) -> serde_json::Value {
        let capabilities = self
            .entries
            .iter()
            .map(|(id, decision)| {
                (
                    id.to_string(),
                    serde_json::json!({
                        "fact": decision.fact.as_str(),
                        "source": decision.source.as_str(),
                        "advertised": decision.advertised,
                        "negotiated": decision.negotiated,
                        "usable": decision.usable,
                        "diagnostics": decision.diagnostics,
                    }),
                )
            })
            .collect::<serde_json::Map<String, serde_json::Value>>();
        serde_json::json!({
            "generation": self.generation,
            "capabilities": capabilities,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn registry(capabilities: serde_json::Value) -> CapabilityRegistry {
        CapabilityRegistry::from_initialize_response(&json!({
            "protocolVersion": 1,
            "agentCapabilities": capabilities,
            "_unknownTopLevelExtension": {"future": true}
        }))
        .expect("合法 initialize 响应")
    }

    fn declared(order: &[&str]) -> Vec<String> {
        order.iter().map(|name| name.to_string()).collect()
    }

    fn consumers(set: &[CapabilityConsumer]) -> BTreeSet<CapabilityConsumer> {
        set.iter().copied().collect()
    }

    fn build_snapshot(
        capabilities: serde_json::Value,
        order: &[&str],
        set: &[CapabilityConsumer],
    ) -> NegotiatedCapabilitySnapshot {
        NegotiatedCapabilitySnapshot::from_parts(
            &registry(capabilities),
            &declared(order),
            7,
            &consumers(set),
        )
    }

    const ESTABLISHMENT: &[CapabilityConsumer] = &[CapabilityConsumer::SessionEstablishment];

    /// AC1：仅标准嵌套 `sessionCapabilities.loadSession: {}` —— 建立链与
    /// continuity probe 读同一快照得到同一结论（negotiated）。
    #[test]
    fn nested_load_session_is_negotiated_for_both_establishment_and_probe() {
        let snapshot = build_snapshot(
            json!({"sessionCapabilities": {"loadSession": {}}}),
            &["resume", "load", "new"],
            ESTABLISHMENT,
        );
        assert!(snapshot.load_supported());
        assert!(snapshot.negotiated("load"));
        assert_eq!(
            snapshot.establishment_channels().unwrap(),
            vec![EstablishmentChannel::Load, EstablishmentChannel::New]
        );
        assert_eq!(
            snapshot.decision("load").unwrap().source,
            CapabilitySource::Canonical
        );
    }

    /// AC2：仅根级兼容形状 —— 只有兼容表允许才生效，且诊断标记 alias 来源。
    #[test]
    fn root_alias_load_session_works_only_via_compat_table_with_diagnostics() {
        let root_alias = build_snapshot(
            json!({"loadSession": true}),
            &["resume", "load", "new"],
            ESTABLISHMENT,
        );
        assert!(root_alias.load_supported());
        let decision = root_alias.decision("load").unwrap();
        assert_eq!(decision.source, CapabilitySource::RootAlias);
        assert!(decision
            .diagnostics
            .iter()
            .any(|line| line.contains("alias") && line.contains("计划弃用")));

        // 未登记 alias 的能力不受根级形状影响（fail-closed）。
        let root_resume = build_snapshot(
            json!({"resume": true}),
            &["resume", "load", "new"],
            ESTABLISHMENT,
        );
        assert!(!root_resume.resume_supported());
        assert_eq!(
            root_resume.decision("resume").unwrap().fact,
            CapabilityFact::Unknown
        );
    }

    /// AC3：嵌套与根级冲突时标准嵌套优先；错误类型的 object capability 不算支持。
    #[test]
    fn canonical_wins_conflicts_and_wrong_types_fail_closed() {
        // 嵌套合法 + 根级同时存在：canonical 决定 + 冲突诊断。
        let conflict = build_snapshot(
            json!({"sessionCapabilities": {"loadSession": {}}, "loadSession": true}),
            &["load", "new"],
            ESTABLISHMENT,
        );
        let decision = conflict.decision("load").unwrap();
        assert_eq!(decision.source, CapabilitySource::Canonical);
        assert!(decision.negotiated);
        assert!(decision
            .diagnostics
            .iter()
            .any(|line| line.contains("以 canonical 为准")));

        // 嵌套类型错误（boolean）+ 根级合法：canonical 优先 ⇒ fail-closed，不回退 alias。
        let nested_wrong = build_snapshot(
            json!({"sessionCapabilities": {"loadSession": true}, "loadSession": true}),
            &["load", "new"],
            ESTABLISHMENT,
        );
        let decision = nested_wrong.decision("load").unwrap();
        assert!(!decision.negotiated);
        assert_eq!(decision.source, CapabilitySource::Canonical);
        assert!(decision
            .diagnostics
            .iter()
            .any(|line| line.contains("类型错误")));

        // object capability 的 boolean/string/null 值都不算广告。
        for wrong in [json!(true), json!("yes"), json!(null), json!(1)] {
            let snapshot = build_snapshot(
                json!({"sessionCapabilities": {"resume": wrong}}),
                &["resume", "load", "new"],
                ESTABLISHMENT,
            );
            assert!(!snapshot.resume_supported(), "{wrong} 不得判定为支持");
            assert_eq!(
                snapshot.decision("resume").unwrap().fact,
                CapabilityFact::Unknown
            );
        }
    }

    /// AC7：fork 广告 + 消费者注册 ⇒ usable；无消费者 ⇒ 协商通过但不可
    /// usable（fact=Negotiated + 诊断「消费者未注册」）；未广告 ⇒ Unknown。
    /// 其它能力不受影响。
    #[test]
    fn fork_requires_registered_consumer_to_be_usable() {
        let capabilities = json!({"sessionCapabilities": {"fork": {}}});
        let without_consumer = build_snapshot(capabilities.clone(), &["new"], &[]);
        let decision = without_consumer.decision("fork").unwrap();
        assert_eq!(decision.fact, CapabilityFact::Negotiated);
        assert!(decision.negotiated);
        assert!(!decision.usable);
        assert!(!without_consumer.fork_usable());
        assert!(decision
            .diagnostics
            .iter()
            .any(|line| line.contains("消费者未注册")));

        let with_consumer =
            build_snapshot(capabilities, &["new"], &[CapabilityConsumer::SessionFork]);
        let decision = with_consumer.decision("fork").unwrap();
        assert_eq!(decision.fact, CapabilityFact::Usable);
        assert!(with_consumer.fork_usable());

        let unadvertised = build_snapshot(json!({}), &["new"], &[CapabilityConsumer::SessionFork]);
        assert_eq!(
            unadvertised.decision("fork").unwrap().fact,
            CapabilityFact::Unknown
        );
        assert!(!unadvertised.fork_usable());
    }

    /// 宿主侧能力（elicitation）：消费者注册决定 usable，无广告维度。
    #[test]
    fn host_side_capability_follows_consumer_registration() {
        let unregistered = build_snapshot(json!({}), &["new"], &[]);
        let decision = unregistered.decision("elicitation").unwrap();
        assert!(!decision.usable);
        assert_eq!(decision.advertised, None);

        let registered = build_snapshot(json!({}), &["new"], &[CapabilityConsumer::Elicitation]);
        let decision = registered.decision("elicitation").unwrap();
        assert_eq!(decision.fact, CapabilityFact::Usable);
        assert_eq!(decision.source, CapabilitySource::Host);
    }

    /// 声明交集：广告了但 catalog 未声明 → 不协商（不产生通道、不可调用）。
    #[test]
    fn advertised_but_undeclared_stays_out_of_negotiation() {
        let snapshot = build_snapshot(
            json!({"sessionCapabilities": {"resume": {}, "loadSession": {}}}),
            &["load", "new"],
            ESTABLISHMENT,
        );
        assert!(!snapshot.resume_supported());
        assert!(snapshot.load_supported());
        assert_eq!(
            snapshot.establishment_channels().unwrap(),
            vec![EstablishmentChannel::Load, EstablishmentChannel::New]
        );
        let decision = snapshot.decision("resume").unwrap();
        assert_eq!(decision.fact, CapabilityFact::Advertised);
        assert!(decision
            .diagnostics
            .iter()
            .any(|line| line.contains("catalog 未声明")));
    }

    /// AC12：未知顶层/能力扩展字段不破坏任何已知判定，原文保留可回放。
    #[test]
    fn unknown_extension_fields_preserved_and_ignored() {
        let snapshot = build_snapshot(
            json!({
                "sessionCapabilities": {"loadSession": {}, "_vendorFastPath": true},
                "promptCapabilities": {"image": true},
                "_futureRoot": {"x": 1}
            }),
            &["load", "new"],
            ESTABLISHMENT,
        );
        assert!(snapshot.load_supported());
        assert!(!snapshot.usable("promptImage"), "未注册消费者不可 usable");
        let raw = snapshot.raw().expect("原文保留");
        assert_eq!(raw.get("_futureRoot"), Some(&json!({"x": 1})));
        assert_eq!(
            raw.pointer("/sessionCapabilities/_vendorFastPath"),
            Some(&json!(true))
        );
    }

    /// AC13：wire 投影三层一致（advertised/negotiated/usable + fact/source/diagnostics）。
    #[test]
    fn wire_value_projects_three_layers() {
        let snapshot = build_snapshot(
            json!({"sessionCapabilities": {"loadSession": {}, "fork": {}}}),
            &["load", "new"],
            ESTABLISHMENT,
        );
        let wire = snapshot.wire_value();
        assert_eq!(wire.get("generation"), Some(&json!(7)));
        let load = wire.pointer("/capabilities/load").unwrap();
        assert_eq!(load.get("advertised"), Some(&json!(true)));
        assert_eq!(load.get("negotiated"), Some(&json!(true)));
        assert_eq!(load.get("usable"), Some(&json!(true)));
        assert_eq!(load.get("fact"), Some(&json!("usable")));
        let fork = wire.pointer("/capabilities/fork").unwrap();
        assert_eq!(fork.get("advertised"), Some(&json!(true)));
        assert_eq!(fork.get("negotiated"), Some(&json!(true)));
        assert_eq!(fork.get("usable"), Some(&json!(false)));
        assert_eq!(fork.get("fact"), Some(&json!("negotiated")));
        let elicitation = wire.pointer("/capabilities/elicitation").unwrap();
        assert_eq!(
            elicitation.get("advertised"),
            Some(&serde_json::Value::Null)
        );
        assert_eq!(elicitation.get("usable"), Some(&json!(false)));
    }

    /// generation 绑定：快照携带捕获时的 connection generation。
    #[test]
    fn snapshot_binds_connection_generation() {
        let snapshot = build_snapshot(json!({}), &["new"], &[]);
        assert_eq!(snapshot.generation, 7);
    }

    /// #110 F2：`list`/`close` 双形状——ACP 标准 object 广告与线上显式 `true`
    /// 旧广告都算广告且不产类型错误诊断；其它值仍 fail-closed。
    #[test]
    fn list_and_close_accept_object_and_boolean_shapes() {
        const REGISTERED: &[CapabilityConsumer] = &[
            CapabilityConsumer::SessionList,
            CapabilityConsumer::SessionClose,
        ];

        // Hermes 实测形状：sessionCapabilities = {fork:{}, list:{}, resume:{}}。
        let object_shapes = build_snapshot(
            json!({"sessionCapabilities": {"fork": {}, "list": {}, "close": {}}}),
            &["new"],
            REGISTERED,
        );
        for id in ["list", "close"] {
            let decision = object_shapes.decision(id).unwrap();
            assert!(decision.negotiated, "object 形状必须协商通过：{id}");
            assert_eq!(decision.fact, CapabilityFact::Usable, "{id}");
            assert_eq!(decision.source, CapabilitySource::Canonical);
            assert!(
                decision
                    .diagnostics
                    .iter()
                    .all(|line| !line.contains("类型错误")),
                "{id} 不得产类型错误诊断：{:?}",
                decision.diagnostics
            );
        }

        // 旧显式 `true` 广告不回归。
        let boolean_shapes = build_snapshot(
            json!({"sessionCapabilities": {"list": true, "close": true}}),
            &["new"],
            REGISTERED,
        );
        assert!(boolean_shapes.usable("list"));
        assert!(boolean_shapes.usable("close"));

        // 其它值仍 fail-closed，诊断写实际接受集（object 或 boolean true）。
        for wrong in [json!(false), json!("yes"), json!(null), json!(1)] {
            let snapshot = build_snapshot(
                json!({"sessionCapabilities": {"list": wrong, "close": wrong}}),
                &["new"],
                REGISTERED,
            );
            for id in ["list", "close"] {
                let decision = snapshot.decision(id).unwrap();
                assert!(!decision.negotiated, "{wrong} 不得判定为 {id} 已广告");
                assert_eq!(decision.fact, CapabilityFact::Unknown, "{id} @ {wrong}");
                assert!(
                    decision.diagnostics.iter().any(|line| {
                        line.contains("类型错误") && line.contains("object 或 boolean true")
                    }),
                    "{id} @ {wrong} 必须报实际接受集：{:?}",
                    decision.diagnostics
                );
            }
        }
    }

    /// 未知声明名 fail-closed（继承旧 `session_establishment_channels` 的 Err 语义）。
    #[test]
    fn unknown_establishment_declaration_fails_closed() {
        let snapshot = build_snapshot(
            json!({"sessionCapabilities": {"resume": {}, "loadSession": {}}}),
            &["resume", "fork", "new"],
            ESTABLISHMENT,
        );
        let error = snapshot.establishment_channels().unwrap_err();
        assert!(error.contains("未知通道"), "实际: {error}");
    }

    /// #398：delete 双形状——官方 object 广告（SessionDeleteCapabilities 空结构）
    /// 与显式 `true` 旧广告都算广告；其它值 fail-closed 且诊断写实际接受集。
    /// 未注册消费者时协商通过但不可 usable（与 fork 同防线）。
    #[test]
    fn delete_accepts_object_and_boolean_shapes_and_requires_consumer() {
        const REGISTERED: &[CapabilityConsumer] = &[CapabilityConsumer::SessionDelete];

        let object_shape = build_snapshot(
            json!({"sessionCapabilities": {"delete": {}}}),
            &["new"],
            REGISTERED,
        );
        let decision = object_shape.decision("delete").unwrap();
        assert!(decision.negotiated);
        assert_eq!(decision.fact, CapabilityFact::Usable);
        assert_eq!(decision.source, CapabilitySource::Canonical);

        let boolean_shape = build_snapshot(
            json!({"sessionCapabilities": {"delete": true}}),
            &["new"],
            REGISTERED,
        );
        assert!(boolean_shape.usable("delete"));

        // 消费者未注册：广告与协商成立（delete 无声明维度）但不可 usable
        // （ghost capability 防线，与 fork AC7 同态——fact=Negotiated）。
        let unregistered = build_snapshot(
            json!({"sessionCapabilities": {"delete": {}}}),
            &["new"],
            &[],
        );
        let decision = unregistered.decision("delete").unwrap();
        assert_eq!(decision.fact, CapabilityFact::Negotiated);
        assert!(!unregistered.usable("delete"));
        assert!(
            decision
                .diagnostics
                .iter()
                .any(|line| line.contains("消费者未注册")),
            "诊断必须指明消费者缺口：{:?}",
            decision.diagnostics
        );

        // 其它值 fail-closed，诊断写实际接受集（object 或 boolean true）。
        for wrong in [json!(false), json!("yes"), json!(null), json!(1)] {
            let snapshot = build_snapshot(
                json!({"sessionCapabilities": {"delete": wrong}}),
                &["new"],
                REGISTERED,
            );
            let decision = snapshot.decision("delete").unwrap();
            assert!(!decision.negotiated, "{wrong} 不得判定为 delete 已广告");
            assert_eq!(decision.fact, CapabilityFact::Unknown, "@ {wrong}");
            assert!(
                decision.diagnostics.iter().any(|line| {
                    line.contains("类型错误") && line.contains("object 或 boolean true")
                }),
                "@ {wrong} 必须报实际接受集：{:?}",
                decision.diagnostics
            );
        }
    }
}
