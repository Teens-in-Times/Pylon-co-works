//! provenance 编码与读侧派生（owner 三元组 / raw 截断元数据）。

// ── #155 T2（v15）存储收窄：15 列 + 读侧派生 ─────────────────────────────────
// wire/EVT-01 的 28 字段契约不变；event_id/owner 分维列/schema_version/provenance
// 四字段/raw_* 截断计数不落库，读侧由 `owner_triple`/`provenance_parts`/
// `derive_raw_metadata` 派生（推导依据与勘察记录见 .agents/spec/155-t2-schema-rebuild.md）。

/// v15：provenance (origin, trust) 合法的六组合整数编码。`parse_canonical_event`
/// 已把组合钉死为 local-observed ⇔ authoritative、其余 ⇔ unverified。
/// #364 起 5 = external-import/unverified（外部 CLI 历史导入，永不为 authoritative）。
const PROVENANCE_LOCAL_OBSERVED: i64 = 0;
const PROVENANCE_RECOVERY_IMPORT: i64 = 1;
const PROVENANCE_OPTIMISTIC_LOCAL: i64 = 2;
const PROVENANCE_MIGRATION: i64 = 3;
const PROVENANCE_PLUGIN: i64 = 4;
const PROVENANCE_EXTERNAL_IMPORT: i64 = 5;

pub(super) fn provenance_code(origin: &str, trust: &str) -> i64 {
    match (origin, trust) {
        ("local-observed", "authoritative") => PROVENANCE_LOCAL_OBSERVED,
        ("recovery-import", "unverified") => PROVENANCE_RECOVERY_IMPORT,
        ("optimistic-local", "unverified") => PROVENANCE_OPTIMISTIC_LOCAL,
        ("migration", "unverified") => PROVENANCE_MIGRATION,
        ("plugin", "unverified") => PROVENANCE_PLUGIN,
        ("external-import", "unverified") => PROVENANCE_EXTERNAL_IMPORT,
        // 不可达（写入前已验证）；防御性归入 migration/unverified 保持读侧枚举合法。
        _ => PROVENANCE_MIGRATION,
    }
}

/// 读侧还原 wire provenance 四字段。provider/import_id 按组合派生：kernel 写入
/// provider 恒为 agent_id、recovery-import 与 external-import 的 importId 恒为
/// local_session_id（全代码域唯一取值，2026-09-19 勘察；#364 沿用同一派生）。
pub(super) fn provenance_parts(
    code: i64,
    agent_id: &str,
    local_session_id: &str,
) -> (String, String, Option<String>, Option<String>) {
    match code {
        PROVENANCE_LOCAL_OBSERVED => (
            "local-observed".to_string(),
            "authoritative".to_string(),
            Some(agent_id.to_string()),
            None,
        ),
        PROVENANCE_RECOVERY_IMPORT => (
            "recovery-import".to_string(),
            "unverified".to_string(),
            Some(agent_id.to_string()),
            Some(local_session_id.to_string()),
        ),
        PROVENANCE_OPTIMISTIC_LOCAL => (
            "optimistic-local".to_string(),
            "unverified".to_string(),
            None,
            None,
        ),
        PROVENANCE_PLUGIN => ("plugin".to_string(), "unverified".to_string(), None, None),
        PROVENANCE_EXTERNAL_IMPORT => (
            "external-import".to_string(),
            "unverified".to_string(),
            Some(agent_id.to_string()),
            Some(local_session_id.to_string()),
        ),
        _ => (
            "migration".to_string(),
            "unverified".to_string(),
            None,
            None,
        ),
    }
}

/// owner 三元组自主键文本派生（owner_key = JSON 数组 [profile, agent, local]）。
/// 形状异常回退空串（与 TS `normalizeCanonicalEventRow` 对缺失 owner 的容错同向）。
pub(super) fn owner_triple(owner_key: &str) -> (String, String, String) {
    serde_json::from_str::<Vec<String>>(owner_key)
        .ok()
        .and_then(|parts| {
            if parts.len() == 3 {
                Some((parts[0].clone(), parts[1].clone(), parts[2].clone()))
            } else {
                None
            }
        })
        .unwrap_or_default()
}

/// raw 截断元数据自 raw_payload 文本重算（wire 注释既有纪律：「截断信息由 rawPayload
/// 重算」）——截断 stub 自带 `_pylonTruncated`/`originalBytes`，retained = 入库文本长度。
/// 返回 (truncated, original_bytes, retained_bytes, omitted_bytes, reason)。
pub(super) fn derive_raw_metadata(raw_payload_json: &str) -> (bool, i64, i64, i64, Option<String>) {
    let retained = raw_payload_json.len() as i64;
    let stub_original = serde_json::from_str::<serde_json::Value>(raw_payload_json)
        .ok()
        .filter(|value| {
            value
                .get("_pylonTruncated")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
        .and_then(|value| {
            value
                .get("originalBytes")
                .and_then(serde_json::Value::as_i64)
        });
    match stub_original {
        Some(original) => (
            true,
            original,
            retained,
            original.saturating_sub(retained),
            Some("size".to_string()),
        ),
        None => (false, retained, retained, 0, None),
    }
}
