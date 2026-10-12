//! kernel/EVT-01 事件归一化：typed payload 抽取、append 输入校验与 wire 序列化。

use super::redaction::{redact_journal_credentials, retain_raw_payload};
use super::row::{CanonicalEventRow, KernelEventInput};
use super::EventError;
use crate::owner::DurableSessionOwner;

pub(super) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn non_empty_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_string(
    record: Option<&serde_json::Map<String, serde_json::Value>>,
    aliases: &[&str],
) -> Option<String> {
    aliases
        .iter()
        .find_map(|alias| non_empty_string(record.and_then(|value| value.get(*alias))))
}

fn extract_update(raw: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    let root = raw.as_object()?;
    let params = root.get("params").and_then(serde_json::Value::as_object);
    params
        .and_then(|value| value.get("update"))
        .and_then(serde_json::Value::as_object)
        .or_else(|| root.get("update").and_then(serde_json::Value::as_object))
        .or_else(|| {
            root.get("sessionUpdate")
                .and_then(serde_json::Value::as_str)
                .map(|_| root)
        })
        .or_else(|| {
            params.and_then(|value| {
                value
                    .get("sessionUpdate")
                    .and_then(serde_json::Value::as_str)
                    .map(|_| value)
            })
        })
}

fn strip_replay_prompt_prefix(text: &str) -> &str {
    const SEPARATOR: &str = "\n\n---\n\n";
    text.rsplit_once(SEPARATOR)
        .map(|(_, content)| content)
        .filter(|content| !content.is_empty())
        .unwrap_or(text)
}

pub(super) fn mark_replay_import(
    owner: &DurableSessionOwner,
    mut raw_payload: serde_json::Value,
) -> serde_json::Value {
    if let serde_json::Value::Object(root) = &mut raw_payload {
        root.insert(
            "source".to_string(),
            serde_json::Value::String(owner.local_session_id.clone()),
        );
        if let Some(update) = replay_update_mut(root) {
            let meta = update
                .entry("_meta")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(meta) = meta.as_object_mut() {
                meta.insert(
                    "pylonReplayImport".to_string(),
                    serde_json::Value::Bool(true),
                );
            }
        }
    }
    raw_payload
}

fn replay_update_mut(
    root: &mut serde_json::Map<String, serde_json::Value>,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    if root.get("update").is_some() {
        return root
            .get_mut("update")
            .and_then(serde_json::Value::as_object_mut);
    }
    root.get_mut("params")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|params| params.get_mut("update"))
        .and_then(serde_json::Value::as_object_mut)
}

fn resolve_identity(
    update: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<serde_json::Value> {
    let root = update?;
    let content = root.get("content").and_then(serde_json::Value::as_object);
    let meta = root.get("_meta").and_then(serde_json::Value::as_object);
    let mut identity = serde_json::Map::new();
    for (field, aliases, root_first) in [
        (
            "toolCallId",
            &["toolCallId", "tool_call_id", "toolUseId", "tool_use_id"][..],
            true,
        ),
        ("messageId", &["messageId", "message_id"][..], false),
        ("turnId", &["turnId", "turn_id"][..], false),
        ("requestId", &["requestId", "request_id"][..], false),
    ] {
        let records = if root_first {
            [Some(root), content, meta]
        } else {
            [content, Some(root), meta]
        };
        if let Some(value) = records
            .into_iter()
            .find_map(|record| first_string(record, aliases))
        {
            identity.insert(field.to_string(), serde_json::Value::String(value));
        }
    }
    (!identity.is_empty()).then_some(serde_json::Value::Object(identity))
}

pub(super) fn normalize_kernel_event(
    input: KernelEventInput,
    sequence: i64,
) -> Result<CanonicalEventRow, EventError> {
    let provenance_provider = input.owner.agent_id.clone();
    let provenance_import_id = input.owner.local_session_id.clone();
    let owner_key = input
        .owner
        .key()
        .map_err(|error| EventError::Invalid(error.to_string()))?;
    // typed_payload/identity 提取必须看未脱敏原文（redact 只作用于入库 raw），
    // 因此先完成全部借用读取，再把 raw_payload move 进 redact（免整树 clone）。
    let update = extract_update(&input.raw_payload);
    let session_update = update
        .and_then(|value| value.get("sessionUpdate"))
        .and_then(serde_json::Value::as_str);
    let status = update
        .and_then(|value| value.get("status"))
        .and_then(serde_json::Value::as_str);
    // #220 WP1：判别符 → canonical 类型的映射是**同一个事实的两处手抄**（此处与 TS
    // `canonicalEventTypeFor`），现由 `pylon-canonical-types` 单源给出；本函数不再自带
    // switch（含过时即编译不过的口径）。
    let canonical_type = pylon_canonical_types::canonical_event_type_for(session_update, status);
    let event_type = canonical_type.as_str();
    // #110 F7：`unknown` 归因。原先只落一个 "unknown" 死账——体检时 830 行
    // unknown 无法从库内归因，只能逐条反查 raw。现在把未识别的判别符与 update
    // 键集合打点，新形状一出现即可定位；raw 仍按 §5.10 原则 5 完整保留
    // （unknown 不静默丢弃，也不改写历史行）。
    if canonical_type.is_unknown() {
        tracing::warn!(
            target: "canonical_event",
            owner = %owner_key,
            discriminator = session_update.unwrap_or("<missing-update>"),
            update_keys = %update
                .map(|map| map.keys().cloned().collect::<Vec<_>>().join(","))
                .unwrap_or_default(),
            "unrecognized session/update discriminator: event recorded as 'unknown' with raw preserved"
        );
    }

    let mut typed_payload = serde_json::Map::new();
    if let Some(update) = update {
        let text = update
            .get("content")
            .and_then(serde_json::Value::as_object)
            .and_then(|content| content.get("text"))
            .or_else(|| update.get("text"))
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.is_empty());
        if let Some(text) = text {
            let text = if session_update == Some("user_message_chunk")
                && update
                    .get("_meta")
                    .and_then(serde_json::Value::as_object)
                    .and_then(|meta| meta.get("pylonReplayImport"))
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
            {
                strip_replay_prompt_prefix(text)
            } else {
                text
            };
            typed_payload.insert(
                "text".to_string(),
                serde_json::Value::String(text.to_string()),
            );
        }
        if matches!(session_update, Some("tool_call" | "tool_call_update")) {
            let mut tool = serde_json::Map::new();
            for field in ["title", "kind", "status"] {
                if let Some(value) = non_empty_string(update.get(field)) {
                    tool.insert(field.to_string(), serde_json::Value::String(value));
                }
            }
            for (wire, canonical) in [
                ("rawInput", "rawInput"),
                ("rawOutput", "rawOutput"),
                ("content", "contentBlocks"),
            ] {
                if let Some(value) = update.get(wire) {
                    tool.insert(
                        canonical.to_string(),
                        redact_journal_credentials(value.clone(), false),
                    );
                }
            }
            typed_payload.insert("tool".to_string(), serde_json::Value::Object(tool));
        }
        if session_update == Some("error") || session_update == Some("cancelled") {
            if let Some(code) = non_empty_string(update.get("errorCode")) {
                typed_payload.insert("code".to_string(), serde_json::Value::String(code));
            }
            if let Some(error) = non_empty_string(update.get("error"))
                .or_else(|| non_empty_string(update.get("message")))
            {
                typed_payload.insert("error".to_string(), serde_json::Value::String(error));
            }
            if session_update == Some("cancelled") {
                typed_payload.insert(
                    "stopReason".to_string(),
                    serde_json::Value::String("cancelled".to_string()),
                );
            }
        }
        if session_update == Some("done") {
            for field in ["stopReason", "usage", "model"] {
                if let Some(value) = update.get(field) {
                    typed_payload.insert(field.to_string(), value.clone());
                }
            }
        }
        // #110 F5：`session_info_update` 的当前模型事实——`typed_payload.model` 是前端
        // `session.model-updated` 语义投影的唯一取值来源（与 P56/D2.3 同一组变体：
        // 嵌套 models.currentModelId camel/snake 优先，扁平 model 次之）。缺失则
        // journal 收不到模型事实，状态条只能退回兜底串。
        if session_update == Some("session_info_update") {
            let model = update
                .get("models")
                .and_then(serde_json::Value::as_object)
                .and_then(|models| {
                    [
                        "currentModelId",
                        "current_model_id",
                        "currentModel",
                        "current_model",
                        "current",
                    ]
                    .iter()
                    .find_map(|key| non_empty_string(models.get(*key)))
                })
                .or_else(|| non_empty_string(update.get("model")));
            if let Some(model) = model {
                typed_payload.insert("model".to_string(), serde_json::Value::String(model));
            }
            // ACP `SessionInfoUpdate.title/updatedAt` 是 `MaybeUndefined`：字段缺席 =
            // 不修改、显式 null = 清空、字符串 = 设置。三态不得压平——只在键存在时落
            // typed，且清空原样落 null。与 model 的「只收非空机器 id」口径不同：标题
            // 有清除语义，丢了清空信号界面就撤不回标题。
            for field in ["title", "updatedAt"] {
                match update.get(field) {
                    Some(serde_json::Value::Null) => {
                        typed_payload.insert(field.to_string(), serde_json::Value::Null);
                    }
                    Some(serde_json::Value::String(text)) => {
                        let trimmed = text.trim();
                        let value = if trimmed.is_empty() {
                            serde_json::Value::Null
                        } else {
                            serde_json::Value::String(trimmed.to_string())
                        };
                        typed_payload.insert(field.to_string(), value);
                    }
                    // 缺席 = 不修改；非字符串是上游形状漂移，不猜。
                    _ => {}
                }
            }
        }
    }

    let identity = resolve_identity(update);
    // 借用已结束：原树 move 进 redact（纯函数，等价于原先的 clone 后重建，少一次整树拷贝）。
    // #334/P2：raw_payload 为 Arc 共享传入——发布侧在 ingest 完成后才取回唯一
    // 引用，故此处计数通常为 2（pending 批次仍持有），解包失败即克隆保正确；
    // 消费顺序约定见 KernelEventInput.raw_payload 文档。
    let raw_for_storage = redact_journal_credentials(
        std::sync::Arc::try_unwrap(input.raw_payload).unwrap_or_else(|arc| (*arc).clone()),
        false,
    );
    let (
        raw_payload,
        raw_payload_json,
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
    ) = retain_raw_payload(raw_for_storage);
    Ok(CanonicalEventRow {
        event_id: pylon_canonical_types::canonical_event_id(&owner_key, sequence),
        owner_key,
        profile_id: input.owner.profile_id,
        agent_id: input.owner.agent_id,
        local_session_id: input.owner.local_session_id,
        remote_session_id: input.remote_session_id,
        client_generation: input.client_generation,
        sequence,
        occurred_at: input
            .occurred_at
            .clone()
            .unwrap_or_else(|| input.received_at.clone()),
        received_at: input.received_at,
        event_type: event_type.to_string(),
        payload_version: 1,
        identity,
        typed_payload: (!typed_payload.is_empty()).then_some(redact_journal_credentials(
            serde_json::Value::Object(typed_payload),
            false,
        )),
        raw_payload,
        raw_payload_json,
        created_at: now_millis(),
        schema_version: 1,
        provenance_origin: match input.import_origin {
            super::row::EventImportOrigin::Live => "local-observed",
            super::row::EventImportOrigin::RecoveryImport => "recovery-import",
            super::row::EventImportOrigin::ExternalImport => "external-import",
        }
        .to_string(),
        provenance_trust: if matches!(
            input.import_origin,
            super::row::EventImportOrigin::RecoveryImport
                | super::row::EventImportOrigin::ExternalImport
        ) {
            "unverified"
        } else {
            "authoritative"
        }
        .to_string(),
        provenance_provider: Some(provenance_provider),
        provenance_import_id: matches!(
            input.import_origin,
            super::row::EventImportOrigin::RecoveryImport
                | super::row::EventImportOrigin::ExternalImport
        )
        .then_some(provenance_import_id),
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
        raw_truncation_reason: raw_truncated.then(|| "size".to_string()),
        rollup_seq_start: None,
        rollup_seq_end: None,
    })
}

/// 从 EVT-01 前端 schema JSON 校验并提取事件行（append-only 完整性守卫）。
/// 不抛异常：坏形状返回问题列表（拼接为一条 Invalid 错误），空问题 = 合法。
/// 覆盖：eventId 非空、owner 五字段、generation/sequence 正整数域、eventType 非空、
/// payloadVersion 版本化、occurred_at/received_at 存在、raw_payload 恒存、
/// eventId 与 owner+sequence 推导一致性（rule 1）。unknown eventType 原样接受。
pub fn parse_canonical_event(value: &serde_json::Value) -> Result<CanonicalEventRow, EventError> {
    let mut problems: Vec<String> = Vec::new();
    let obj = match value.as_object() {
        Some(obj) => obj,
        None => return Err(EventError::Invalid("event 必须是对象".into())),
    };
    let get_str = |key: &str| obj.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    let get_i64 = |key: &str| obj.get(key).and_then(|v| v.as_i64());

    let event_id = get_str("eventId");
    let owner = obj.get("owner").and_then(|v| v.as_object());
    let profile_id = owner
        .and_then(|o| o.get("profileId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let agent_id = owner
        .and_then(|o| o.get("agentId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let local_session_id = owner
        .and_then(|o| o.get("localSessionId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let remote_session_id = owner
        .and_then(|o| o.get("remoteSessionId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let client_generation = get_i64("clientGeneration");
    let sequence = get_i64("sequence");
    let occurred_at = get_str("occurredAt");
    let received_at = get_str("receivedAt");
    let event_type = get_str("eventType");
    let payload_version = get_i64("payloadVersion");
    let provenance = obj.get("provenance").and_then(|value| value.as_object());
    let provenance_origin = provenance
        .and_then(|value| value.get("origin"))
        .and_then(|value| value.as_str())
        .unwrap_or("migration");
    let provenance_trust = provenance
        .and_then(|value| value.get("trust"))
        .and_then(|value| value.as_str())
        .unwrap_or("unverified");

    if event_id.is_none() {
        problems.push("eventId 必填".into());
    }
    if profile_id.is_none() || agent_id.is_none() || local_session_id.is_none() {
        problems.push("owner 必填 profileId/agentId/localSessionId".into());
    }
    if !client_generation.is_some_and(|v| v >= 0) {
        problems.push("clientGeneration 必须为非负整数".into());
    }
    if !sequence.is_some_and(|v| v >= 1) {
        problems.push("sequence 必须为正整数".into());
    }
    if occurred_at.is_none() {
        problems.push("occurredAt 必填".into());
    }
    if received_at.is_none() {
        problems.push("receivedAt 必填".into());
    }
    if event_type.is_none() {
        problems.push("eventType 必填".into());
    }
    if !payload_version.is_some_and(|v| v >= 1) {
        problems.push("payloadVersion 必须为正整数（schema 版本化）".into());
    }
    if !obj.contains_key("rawPayload") {
        problems.push("rawPayload 必填（unknown event 不得静默丢弃）".into());
    }
    if !matches!(
        provenance_origin,
        "local-observed"
            | "optimistic-local"
            | "recovery-import"
            | "migration"
            | "plugin"
            | "external-import"
    ) {
        problems.push("provenance.origin 非法".into());
    }
    if !matches!(provenance_trust, "authoritative" | "unverified") {
        problems.push("provenance.trust 非法".into());
    }
    if (provenance_origin == "local-observed") != (provenance_trust == "authoritative") {
        problems.push("local-observed 只能 authoritative，其他来源只能 unverified".into());
    }

    // 校验与提取在此收口：模式匹配本身是「全部必填字段都通过校验」的编译期
    // 证据——任一必填字段缺席，或存在不带 Option 的域校验问题（rawPayload/
    // provenance/正整数域），都会落入 `_` 分支携带完整问题列表；守卫
    // `problems.is_empty()` 保证 All-Some 但校验失败的输入同样走 Invalid。
    // 成功路径直接携带强类型值，不再有「校验通过后逐字段 expect 解包」的
    // 隐式耦合（原 11 处 `expect("checked")`）。
    let (
        event_id,
        profile_id,
        agent_id,
        local_session_id,
        client_generation,
        sequence,
        occurred_at,
        received_at,
        event_type,
        payload_version,
    ) = match (
        event_id,
        profile_id,
        agent_id,
        local_session_id,
        client_generation,
        sequence,
        occurred_at,
        received_at,
        event_type,
        payload_version,
    ) {
        (
            Some(event_id),
            Some(profile_id),
            Some(agent_id),
            Some(local_session_id),
            Some(client_generation),
            Some(sequence),
            Some(occurred_at),
            Some(received_at),
            Some(event_type),
            Some(payload_version),
        ) if problems.is_empty() => (
            event_id,
            profile_id,
            agent_id,
            local_session_id,
            client_generation,
            sequence,
            occurred_at,
            received_at,
            event_type,
            payload_version,
        ),
        _ => return Err(EventError::Invalid(problems.join("; "))),
    };

    // owner_key = JSON 数组序列化（禁冒号拼接——source 可含冒号，与 toCanonicalOwnerKey 同纪律）。
    let owner_key =
        pylon_canonical_types::canonical_owner_key(&profile_id, &agent_id, &local_session_id)
            .map_err(|e| EventError::Invalid(format!("owner_key 序列化失败: {e}")))?;
    // rule 1：event_id = owner_key#sequence 确定性推导（禁 content 哈希）。
    let expected_id = pylon_canonical_types::canonical_event_id(&owner_key, sequence);
    if event_id != expected_id {
        return Err(EventError::Invalid(format!(
            "eventId 与 owner+sequence 推导不一致: 期望 {expected_id}，实际 {event_id}"
        )));
    }

    let interaction_payload = event_type.starts_with("interaction.");
    let (
        raw_payload,
        raw_payload_json,
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
    ) = retain_raw_payload(redact_journal_credentials(
        obj.get("rawPayload")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        interaction_payload,
    ));

    Ok(CanonicalEventRow {
        event_id,
        owner_key,
        profile_id,
        agent_id,
        local_session_id,
        remote_session_id,
        client_generation,
        sequence,
        occurred_at,
        received_at,
        event_type,
        payload_version,
        identity: obj.get("identity").cloned(),
        typed_payload: obj
            .get("typedPayload")
            .cloned()
            .map(|value| redact_journal_credentials(value, interaction_payload)),
        raw_payload,
        raw_payload_json,
        created_at: now_millis(),
        schema_version: obj
            .get("schemaVersion")
            .and_then(|v| v.as_i64())
            .unwrap_or(1),
        provenance_origin: provenance_origin.to_string(),
        provenance_trust: provenance_trust.to_string(),
        provenance_provider: obj
            .get("provenance")
            .and_then(|p| p.get("provider"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        provenance_import_id: obj
            .get("provenance")
            .and_then(|p| p.get("importId"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
        raw_truncation_reason: raw_truncated.then(|| "size".to_string()),
        rollup_seq_start: None,
        rollup_seq_end: None,
    })
}

/// `CanonicalEventRow` → EVT-01 canonical 事件 JSON（`parse_canonical_event` 的逆）。
///
/// #81 回归修复：turn 单元行的整行 segment 必须嵌入 canonical 事件（嵌套
/// `owner`/`provenance`），而不是数据库扁平列形状——前端唯一契约是嵌套 owner 的
/// canonical 事件，嵌入扁平行会绕过读边界的归一化。载荷因此自描述：任何读者
/// （前端展开、证据导出、未来消费者）拿到它都无需再猜落盘形状。
///
/// 不变量（由 `canonical_event_wire_round_trips_through_parse` 锁定）：
/// `parse_canonical_event(&canonical_event_wire(row))` 与原行逐字段相等，例外是
/// `created_at`（重取 now）与 `raw_*` 截断元数据：截断信息由 `rawPayload` 重算，
/// 已裁剪的载荷很短 ⇒ 重解析会报「未截断」。故 wire 显式携带 `rawMetadata`
/// （前端取证所需），但不指望它经 `parse_canonical_event` 往返（见
/// `canonical_event_wire_keeps_truncation_metadata_in_payload`）。
/// rollup 覆盖列属行存储细节，不属 EVT-01，故不输出。
pub fn canonical_event_wire(row: &CanonicalEventRow) -> serde_json::Value {
    let mut owner = serde_json::Map::new();
    owner.insert("profileId".into(), serde_json::json!(row.profile_id));
    owner.insert("agentId".into(), serde_json::json!(row.agent_id));
    owner.insert(
        "localSessionId".into(),
        serde_json::json!(row.local_session_id),
    );
    if let Some(remote) = &row.remote_session_id {
        owner.insert("remoteSessionId".into(), serde_json::json!(remote));
    }
    let mut provenance = serde_json::Map::new();
    provenance.insert("origin".into(), serde_json::json!(row.provenance_origin));
    provenance.insert("trust".into(), serde_json::json!(row.provenance_trust));
    if let Some(provider) = &row.provenance_provider {
        provenance.insert("provider".into(), serde_json::json!(provider));
    }
    if let Some(import_id) = &row.provenance_import_id {
        provenance.insert("importId".into(), serde_json::json!(import_id));
    }
    let mut raw_metadata = serde_json::Map::new();
    raw_metadata.insert("truncated".into(), serde_json::json!(row.raw_truncated));
    raw_metadata.insert(
        "originalBytes".into(),
        serde_json::json!(row.raw_original_bytes),
    );
    raw_metadata.insert(
        "retainedBytes".into(),
        serde_json::json!(row.raw_retained_bytes),
    );
    raw_metadata.insert(
        "omittedBytes".into(),
        serde_json::json!(row.raw_omitted_bytes),
    );
    if let Some(reason) = &row.raw_truncation_reason {
        raw_metadata.insert("reason".into(), serde_json::json!(reason));
    }
    let mut event = serde_json::Map::new();
    event.insert("eventId".into(), serde_json::json!(row.event_id));
    event.insert("owner".into(), serde_json::Value::Object(owner));
    event.insert(
        "clientGeneration".into(),
        serde_json::json!(row.client_generation),
    );
    event.insert("sequence".into(), serde_json::json!(row.sequence));
    event.insert("occurredAt".into(), serde_json::json!(row.occurred_at));
    event.insert("receivedAt".into(), serde_json::json!(row.received_at));
    event.insert("eventType".into(), serde_json::json!(row.event_type));
    event.insert(
        "payloadVersion".into(),
        serde_json::json!(row.payload_version),
    );
    event.insert(
        "schemaVersion".into(),
        serde_json::json!(row.schema_version),
    );
    if let Some(identity) = &row.identity {
        event.insert("identity".into(), identity.clone());
    }
    if let Some(typed) = &row.typed_payload {
        event.insert("typedPayload".into(), typed.clone());
    }
    event.insert("rawPayload".into(), row.raw_payload.clone());
    event.insert("provenance".into(), serde_json::Value::Object(provenance));
    event.insert(
        "rawMetadata".into(),
        serde_json::Value::Object(raw_metadata),
    );
    serde_json::Value::Object(event)
}
