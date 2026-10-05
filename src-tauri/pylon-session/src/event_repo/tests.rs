use super::*;

/// 构造一个合法的 canonical 事件 JSON（EVT-01 schema 形状）。
fn event_json(
    agent_id: &str,
    local_session_id: &str,
    sequence: i64,
    event_type: &str,
    raw: serde_json::Value,
) -> serde_json::Value {
    let owner_key = serde_json::to_string(&["p1", agent_id, local_session_id]).unwrap();
    serde_json::json!({
        "eventId": format!("{owner_key}#{sequence}"),
        "owner": {
            "profileId": "p1",
            "agentId": agent_id,
            "localSessionId": local_session_id,
            "remoteSessionId": "remote-1",
        },
        "clientGeneration": 5,
        "sequence": sequence,
        "occurredAt": "2026-08-14T00:00:00.000Z",
        "receivedAt": "2026-08-14T00:00:00.000Z",
        "eventType": event_type,
        "payloadVersion": 1,
        "rawPayload": raw,
    })
}

fn repo() -> EventRepo {
    EventRepo::open_in_memory().expect("open in-memory")
}

fn kernel_input(raw_payload: serde_json::Value) -> KernelEventInput {
    KernelEventInput {
        owner: DurableSessionOwner::new("p1", "peri", "local:s1"),
        remote_session_id: Some("remote-1".to_string()),
        client_generation: 5,
        received_at: "2026-08-20T00:00:00.000Z".to_string(),
        occurred_at: None,
        // #334/P2：KernelEventInput.raw_payload 归一为 Arc 共享语义，测试直传 Value。
        raw_payload: std::sync::Arc::new(raw_payload),
        import_origin: super::row::EventImportOrigin::Live,
    }
}

#[test]
fn kernel_ingest_normalizes_with_the_existing_canonical_contract() {
    let repo = repo();
    let raw = serde_json::json!({
        "source": "local:s1",
        "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "root-tool",
            "content": { "toolCallId": "content-tool" },
            "title": "Write",
            "kind": "edit",
            "status": "completed",
            "rawOutput": { "ok": true }
        }
    });

    let result = repo
        .ingest_kernel_event(kernel_input(raw.clone()))
        .expect("ingest");
    let event = &result.events[0];

    assert_eq!(result.revision, 1);
    assert_eq!(event.sequence, 1);
    assert_eq!(event.event_type, "tool.call.completed");
    assert_eq!(event.identity.as_ref().unwrap()["toolCallId"], "root-tool");
    assert_eq!(
        event.typed_payload.as_ref().unwrap()["tool"]["title"],
        "Write"
    );
    assert_eq!(
        event.typed_payload.as_ref().unwrap()["tool"]["rawOutput"]["ok"],
        true
    );
    assert_eq!(event.raw_payload, raw);
}

#[test]
fn kernel_batch_ingest_folds_adjacent_rows_and_advances_past_terminal_unit() {
    // ADR-0016（2026-09-20 已采用）改写本条判据：相邻同类 delta 现在折成**一行**（span 占位，
    // 幸存行落在跨度末位），不再逐 chunk 一行。编号语义未变——span 占位不重排后续行，
    // 故终态单元与终态之后那行的编号与旧契约逐字相同。
    let repo = repo();
    let delta = |text: &str| {
        serde_json::json!({
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": text }
            }
        })
    };
    let result = repo
        .ingest_kernel_events(vec![
            kernel_input(delta("a")),
            kernel_input(delta("b")),
            kernel_input(serde_json::json!({
                "update": { "sessionUpdate": "done" }
            })),
            kernel_input(delta("after")),
        ])
        .expect("batch ingest");

    assert_eq!(result.revision, 5);
    assert_eq!(
        result
            .events
            .iter()
            .map(|event| (event.sequence, event.event_type.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (2, "assistant.text.delta.batch"),
            (3, "turn.completed"),
            (4, "turn.unit"),
            (5, "assistant.text.delta"),
        ]
    );
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    assert_eq!(repo.revision(&owner_key).unwrap(), 5);
}

#[test]
fn kernel_batch_ingest_rejects_mixed_owners_before_writing() {
    let repo = repo();
    let mut other = kernel_input(serde_json::json!({
        "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "b" } }
    }));
    other.owner = DurableSessionOwner::new("p2", "peri", "local:s2");
    let error = repo
        .ingest_kernel_events(vec![
            kernel_input(serde_json::json!({
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "a" } }
            })),
            other,
        ])
        .expect_err("mixed owners must be rejected");
    assert!(matches!(error, EventError::Invalid(message) if message.contains("crosses owners")));
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    assert_eq!(repo.revision(&owner_key).unwrap(), 0);
}

#[test]
fn kernel_ingest_keeps_unknown_and_malformed_raw_payloads() {
    let repo = repo();
    let malformed = serde_json::json!({ "unexpected": [1, 2, 3] });

    let result = repo
        .ingest_kernel_event(kernel_input(malformed.clone()))
        .expect("ingest malformed raw");
    let event = &result.events[0];

    assert_eq!(event.event_type, "unknown");
    assert_eq!(event.typed_payload, None);
    assert_eq!(event.raw_payload, malformed);
}

#[test]
fn kernel_ingest_normalizes_extended_session_update_variants() {
    let cases = [
        ("cancelled", "turn.failed"),
        ("usage_update", "usage.updated"),
        ("plan", "plan.replaced"),
        ("current_mode_update", "session.mode-updated"),
        ("session_info_update", "session.model-updated"),
        ("config_option_update", "session.config-updated"),
        ("available_commands_update", "session.commands-updated"),
    ];
    for (variant, expected) in cases {
        let event = repo()
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "source": "local:s1",
                "update": { "sessionUpdate": variant }
            })))
            .expect("ingest")
            .events
            .remove(0);
        assert_eq!(event.event_type, expected, "variant {variant}");
    }
}

/// #110 F5：`session_info_update` 的模型事实必须进 typed_payload.model——
/// 前端 `session.model-updated` 语义投影只从这里取值；缺失则模型事实丢失。
#[test]
fn kernel_ingest_session_info_update_carries_model_fact() {
    for (payload, expected) in [
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "models": {"currentModelId": "nous:hermes-4"}}),
            Some("nous:hermes-4"),
        ),
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "models": {"current_model_id": "snake:id"}}),
            Some("snake:id"),
        ),
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "model": "flat:id"}),
            Some("flat:id"),
        ),
        // display name 不是 machine id：嵌套 current 为对象且无可提取机器值 → 不落 model。
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "model": "   "}),
            None,
        ),
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "title": "会话标题"}),
            None,
        ),
    ] {
        let event = repo()
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "source": "local:s1",
                "update": payload
            })))
            .expect("ingest")
            .events
            .remove(0);
        assert_eq!(
            event.event_type, "session.model-updated",
            "payload {payload}"
        );
        let model = event
            .typed_payload
            .as_ref()
            .and_then(|typed| typed.get("model"))
            .and_then(serde_json::Value::as_str);
        assert_eq!(model, expected, "payload {payload}");
    }
}

/// ACP `SessionInfoUpdate.title/updatedAt` 的三态（`MaybeUndefined`）必须原样进
/// typed_payload：缺席 = 不改（键不落）、null/空白 = 清空（落 null）、值 = 设置。
/// 压平任一侧都会让界面撤不回标题或把「不改」误当成「清空」。
#[test]
fn kernel_ingest_session_info_update_carries_title_tri_state() {
    for (payload, expected) in [
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "title": "Riccati 助手介绍"}),
            Some(serde_json::json!("Riccati 助手介绍")),
        ),
        // 官方语义：显式 null = 清空。必须落键（落 null），不能被当成缺席。
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "title": null}),
            Some(serde_json::Value::Null),
        ),
        // 空白标题当清空处理——空标题不是标题。
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "title": "   "}),
            Some(serde_json::Value::Null),
        ),
        // 缺席 = 不修改：键不落。
        (
            serde_json::json!({"sessionUpdate": "session_info_update", "mode": "build"}),
            None,
        ),
    ] {
        let event = repo()
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "source": "local:s1",
                "update": payload
            })))
            .expect("ingest")
            .events
            .remove(0);
        let title = event
            .typed_payload
            .as_ref()
            .and_then(|typed| typed.get("title"))
            .cloned();
        assert_eq!(title, expected, "payload {payload}");
    }
}

/// `updatedAt` 与 `title` 同一口径（都是 `MaybeUndefined`），单独钉一条防只改一半。
#[test]
fn kernel_ingest_session_info_update_carries_updated_at() {
    let event = repo()
        .ingest_kernel_event(kernel_input(serde_json::json!({
            "source": "local:s1",
            "update": {
                "sessionUpdate": "session_info_update",
                "updatedAt": "2026-09-27T11:08:35.935003600+00:00"
            }
        })))
        .expect("ingest")
        .events
        .remove(0);
    let updated_at = event
        .typed_payload
        .as_ref()
        .and_then(|typed| typed.get("updatedAt"))
        .and_then(serde_json::Value::as_str);
    assert_eq!(updated_at, Some("2026-09-27T11:08:35.935003600+00:00"));
}

/// #110 F7：体检时库内 31 行 `unknown` 的真实 raw 形状（camelCase `{sessionId,
/// update:{sessionUpdate}}` 通知包）必须被当前分类器正确识别——证明残留是旧构建的
/// 历史错标，而不是现行分类缺口。用例形状逐字节取自只读取证样本。
#[test]
fn kernel_ingest_recognizes_legacy_unknown_wire_shapes() {
    let cases = [
        (
            serde_json::json!({"sessionId": "99d58bd6", "update": {"size": 1000000, "used": 21793, "sessionUpdate": "usage_update"}}),
            "usage.updated",
        ),
        (
            serde_json::json!({"sessionId": "99d58bd6", "update": {"availableCommands": [{"name": "help", "description": "List available commands"}], "sessionUpdate": "available_commands_update"}}),
            "session.commands-updated",
        ),
        (
            serde_json::json!({"sessionId": "99d58bd6", "update": {"configOptions": [{"id": "model-selection", "category": "model"}], "sessionUpdate": "config_option_update"}}),
            "session.config-updated",
        ),
        (
            serde_json::json!({"sessionId": "99d58bd6", "update": {"_meta": {"periKind": "skill"}, "title": "会话标题", "updatedAt": "2026-09-01T00:00:00.000Z", "sessionUpdate": "session_info_update"}}),
            "session.model-updated",
        ),
    ];
    for (raw, expected) in cases {
        let event = repo()
            .ingest_kernel_event(kernel_input(raw.clone()))
            .expect("ingest")
            .events
            .remove(0);
        assert_eq!(event.event_type, expected, "raw {raw}");
        assert_eq!(event.raw_payload, raw, "raw 原文保真（不受分类影响）");
    }
}

/// #110 F7：真正未识别的判别符仍 fail-soft 成 `unknown` 且 raw 完整保留
/// （归因打点走 tracing，不改事件行契约）。
#[test]
fn kernel_ingest_truly_unknown_discriminator_keeps_raw() {
    let raw = serde_json::json!({
        "sessionId": "peri-1",
        "update": {"sessionUpdate": "vendor_future_update", "payload": {"x": 1}},
    });
    let event = repo()
        .ingest_kernel_event(kernel_input(raw.clone()))
        .expect("ingest")
        .events
        .remove(0);
    assert_eq!(event.event_type, "unknown");
    assert_eq!(event.typed_payload, None);
    assert_eq!(event.raw_payload, raw);
}

#[test]
fn kernel_ingest_done_keeps_additive_completion_fields() {
    let event = repo()
        .ingest_kernel_event(kernel_input(serde_json::json!({
            "source": "local:s1",
            "update": {
                "sessionUpdate": "done",
                "stopReason": "end_turn",
                "usage": {"inputTokens": 2, "outputTokens": 3},
                "model": "hermes-1"
            }
        })))
        .expect("ingest")
        .events
        .remove(0);
    assert_eq!(event.event_type, "turn.completed");
    let typed = event.typed_payload.expect("typed completion payload");
    assert_eq!(typed["stopReason"], "end_turn");
    assert_eq!(typed["usage"]["outputTokens"], 3);
    assert_eq!(typed["model"], "hermes-1");
    assert_eq!(event.payload_version, 1);
    assert!(!typed.as_object().unwrap().contains_key("durationMs"));
}

#[test]
fn kernel_ingest_redacts_secret_interaction_values_before_raw_retention() {
    let credential = "c12-kernel-secret-value";
    let result = repo()
        .ingest_kernel_event(kernel_input(serde_json::json!({
            "source": "local:s1",
            "update": {
                "sessionUpdate": "future_interaction",
                "request": { "kind": "secret", "value": credential },
                "response": { "value": credential }
            }
        })))
        .expect("ingest");
    let row = &result.events[0];
    let persisted = serde_json::to_string(row).unwrap();
    assert!(!persisted.contains(credential));
    assert_eq!(row.raw_payload["update"]["request"]["valueRedacted"], true);
    assert_eq!(row.raw_payload["update"]["response"]["valueRedacted"], true);
}

#[test]
fn kernel_ingest_does_not_accept_caller_provenance_spoof() {
    let repo = repo();
    let result = repo
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "source": "local:s1",
                "provenance": { "origin": "recovery-import", "trust": "authoritative", "provider": "spoof" },
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "live" } }
            })))
            .expect("ingest");
    let event = &result.events[0];
    assert_eq!(event.schema_version, 1);
    assert_eq!(event.provenance_origin, "local-observed");
    assert_eq!(event.provenance_trust, "authoritative");
    assert_eq!(event.provenance_provider.as_deref(), Some("peri"));
}

#[test]
fn kernel_ingest_records_raw_truncation_metadata_without_losing_event_identity() {
    let repo = repo();
    let large = "x".repeat(70 * 1024);
    let result = repo
        .ingest_kernel_event(kernel_input(serde_json::json!({
            "source": "local:s1",
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "kept" } },
            "large": large,
        })))
        .expect("ingest");
    let event = &result.events[0];
    assert!(event.raw_truncated);
    assert!(event.raw_original_bytes > event.raw_retained_bytes);
    assert_eq!(
        event.raw_omitted_bytes,
        event.raw_original_bytes - event.raw_retained_bytes
    );
    assert_eq!(event.raw_truncation_reason.as_deref(), Some("size"));
    assert_eq!(event.typed_payload.as_ref().unwrap()["text"], "kept");
    assert_eq!(event.event_id, "[\"p1\",\"peri\",\"local:s1\"]#1");
}

#[test]
fn kernel_ingest_allocates_after_existing_frontend_revision() {
    let repo = repo();
    let existing = parse_canonical_event(&event_json(
        "peri",
        "local:s1",
        5,
        "assistant.text.delta",
        serde_json::json!({ "old": true }),
    ))
    .unwrap();
    repo.append_events(&[existing], None).unwrap();

    let result = repo
        .ingest_kernel_event(kernel_input(serde_json::json!({
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "next" }
            }
        })))
        .expect("ingest after existing history");

    assert_eq!(result.revision, 6);
    assert_eq!(result.events[0].sequence, 6);
    assert_eq!(result.events[0].event_type, "assistant.text.delta");
    assert_eq!(
        result.events[0].typed_payload.as_ref().unwrap()["text"],
        "next"
    );
}

/// #81 L1：sink batch 行（跨度占用 sequence）在后端的落盘契约——
/// event_type 原样接受、raw 数组不变形、revision = MAX(sequence)（跨度中间
/// 编号不占用、无连续性假设）、expected_revision 语义不变。
#[test]
fn batch_row_occupies_span_tail_and_revision_follows_max_sequence() {
    let repo = repo();
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    let first = parse_canonical_event(&event_json(
        "peri",
        "local:s1",
        1,
        "user.message",
        serde_json::json!({ "text": "q" }),
    ))
    .unwrap();
    let chunk = parse_canonical_event(&event_json(
        "peri",
        "local:s1",
        2,
        "assistant.text.delta",
        serde_json::json!({ "update": { "sessionUpdate": "agent_message_chunk" } }),
    ))
    .unwrap();
    let mut batch = event_json(
        "peri",
        "local:s1",
        5,
        "assistant.text.delta.batch",
        serde_json::json!([
            { "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "a" } } },
            { "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "b" } } },
            { "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "c" } } },
        ]),
    );
    batch["typedPayload"] =
        serde_json::json!({ "text": "abc", "foldedCount": 3, "seqSpan": [3, 5] });
    let batch = parse_canonical_event(&batch).unwrap();
    repo.append_events(&[first, chunk], None).unwrap();
    let result = repo.append_events(&[batch], Some(2)).unwrap();
    assert_eq!(
        result.revision, 5,
        "revision = MAX(sequence)，跨度中间编号不影响"
    );
    assert_eq!(repo.revision(&owner_key).unwrap(), 5);

    // expected_revision 以 MAX(sequence) 为基准：5 可写，4 冲突
    let next = parse_canonical_event(&event_json(
        "peri",
        "local:s1",
        6,
        "turn.completed",
        serde_json::json!({ "update": { "sessionUpdate": "done" } }),
    ))
    .unwrap();
    assert!(repo
        .append_events(std::slice::from_ref(&next), Some(5))
        .is_ok());
    let late = parse_canonical_event(&event_json(
        "peri",
        "local:s1",
        7,
        "turn.completed",
        serde_json::json!({ "update": { "sessionUpdate": "done" } }),
    ))
    .unwrap();
    assert!(matches!(
        repo.append_events(std::slice::from_ref(&late), Some(4)),
        Err(EventError::RevisionConflict { .. })
    ));

    // 回读：batch 行原样保留（raw 数组 + typedPayload 不变形、不截断）
    let page = repo.list_events(&owner_key, None, 10).unwrap();
    let batch_row = page
        .events
        .iter()
        .find(|event| event.event_type == "assistant.text.delta.batch")
        .expect("batch row persisted");
    assert_eq!(batch_row.sequence, 5);
    assert_eq!(batch_row.raw_payload.as_array().map(Vec::len), Some(3));
    assert_eq!(batch_row.typed_payload.as_ref().unwrap()["seqSpan"][0], 3);
    assert_eq!(batch_row.typed_payload.as_ref().unwrap()["seqSpan"][1], 5);
    assert!(!batch_row.raw_truncated);
}

/// #81 L1：batch 行同样受 rule 1 约束——eventId 与 owner+sequence 推导一致。
#[test]
fn batch_row_enforces_event_id_consistency() {
    let mut ev = event_json(
        "peri",
        "local:s1",
        4,
        "assistant.thinking.delta.batch",
        serde_json::json!([
            { "update": { "sessionUpdate": "agent_thought_chunk", "content": { "text": "a" } } },
        ]),
    );
    ev["typedPayload"] = serde_json::json!({ "text": "a", "foldedCount": 1, "seqSpan": [4, 4] });
    ev["eventId"] = serde_json::json!("[\"p1\",\"peri\",\"local:s1\"]#3".to_string());
    assert!(matches!(
        parse_canonical_event(&ev),
        Err(EventError::Invalid(_))
    ));
}

/// #81 L2：kernel 终结写入 → 同一事务追加 turn.unit（segment 折叠 + sha256 +
/// rollup 列）；compact 读只返回单元 + 未覆盖行。
#[test]
fn terminal_ingest_appends_turn_unit_and_compact_read_skips_covered_rows() {
    let repo = repo();
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    let delta = |text: &str| {
        serde_json::json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": text } }
        })
    };
    repo.ingest_kernel_event(kernel_input(delta("你"))).unwrap();
    repo.ingest_kernel_event(kernel_input(delta("好"))).unwrap();
    repo.ingest_kernel_event(kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "tool_call", "toolCallId": "tool-1", "title": "Read", "kind": "read" }
        }))).unwrap();
    let terminal = repo
        .ingest_kernel_event(kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "done", "stopReason": "end_turn" }
        })))
        .expect("terminal ingest");

    // 终态事件 + 单元行原子追加
    assert_eq!(terminal.events.len(), 2, "terminal + turn.unit");
    let terminal_row = &terminal.events[0];
    let unit = &terminal.events[1];
    assert_eq!(terminal_row.sequence, 4);
    assert_eq!(unit.event_type, "turn.unit");
    assert_eq!(unit.sequence, 5);
    assert_eq!(terminal.revision, 5);
    assert_eq!(repo.revision(&owner_key).unwrap(), 5);

    // 单元 payload：跨度、折叠计数、segments 保序（delta-run / event 穿插）
    let typed = unit.typed_payload.as_ref().unwrap();
    assert_eq!(typed["aggregateKind"], "turn-rollup");
    assert_eq!(typed["seqStart"], 1);
    assert_eq!(typed["seqEnd"], 4);
    assert_eq!(typed["foldedCount"], 4);
    let segments = typed["segments"].as_array().unwrap();
    assert_eq!(segments.len(), 3);
    assert_eq!(segments[0]["kind"], "delta-run");
    assert_eq!(segments[0]["seqStart"], 1);
    assert_eq!(segments[0]["seqEnd"], 2);
    assert_eq!(segments[0]["text"], "你好");
    assert_eq!(segments[1]["kind"], "event");
    assert_eq!(segments[1]["event"]["eventType"], "tool.call.started");
    assert_eq!(segments[2]["kind"], "event");
    assert_eq!(segments[2]["event"]["eventType"], "turn.completed");
    // 回归（重启后无法重放）：嵌入事件必须是 EVT-01 canonical 事件（嵌套 owner），
    // 不得是数据库扁平列形状——前端 `canonicalRowToWorkbench` 以 `owner` 为门槛，
    // 扁平行会被判不可读而把整轮塔成 event.unknown。
    for segment in segments.iter().filter(|item| item["kind"] == "event") {
        assert!(
            segment["event"]["owner"].is_object(),
            "segment event 缺嵌套 owner: {segment}"
        );
        assert_eq!(segment["event"]["owner"]["agentId"], "peri");
        assert_eq!(segment["event"]["owner"]["localSessionId"], "local:s1");
        assert!(segment["event"]["provenance"].is_object());
        assert!(
            segment["event"]["profileId"].is_null(),
            "不得落数据库扁平列形状: {segment}"
        );
    }
    assert_eq!(typed["terminal"]["eventType"], "turn.completed");
    assert_eq!(unit.rollup_seq_start, Some(1));
    assert_eq!(unit.rollup_seq_end, Some(4));

    // compact 读：被单元覆盖的行不再返回；未覆盖新行保留
    let compact = repo.load_events_compact(&owner_key).unwrap();
    assert_eq!(compact.len(), 1);
    assert_eq!(compact[0].event_type, "turn.unit");

    repo.ingest_kernel_event(kernel_input(delta("后续")))
        .unwrap();
    let compact_after = repo.load_events_compact(&owner_key).unwrap();
    assert_eq!(compact_after.len(), 2);
    assert_eq!(compact_after[1].event_type, "assistant.text.delta");
    assert_eq!(compact_after[1].sequence, 6, "单元行占用 seq 5");
}

/// #81 回归修复：`CanonicalEventRow → EVT-01` 序列化器与 `parse_canonical_event` 互逆。
#[test]
fn canonical_event_wire_round_trips_through_parse() {
    let mut input = event_json(
        "peri",
        "local:s1",
        3,
        "tool.call.completed",
        serde_json::json!({ "update": { "sessionUpdate": "tool_call_update", "toolCallId": "tool-1" } }),
    );
    input["identity"] = serde_json::json!({ "toolCallId": "tool-1" });
    input["typedPayload"] = serde_json::json!({ "toolCallId": "tool-1", "status": "completed" });
    input["provenance"] = serde_json::json!({
        "origin": "local-observed",
        "trust": "authoritative",
        "provider": "peri",
    });
    let row = parse_canonical_event(&input).expect("canonical event parses");

    let wire = canonical_event_wire(&row);
    // 形状断言：嵌套 owner/provenance，不是扁平列。
    assert!(wire["owner"].is_object());
    assert!(wire["provenance"].is_object());
    assert!(wire["rawMetadata"].is_object());
    assert!(wire["profileId"].is_null());
    assert!(wire["ownerKey"].is_null());
    assert!(wire["rollupSeqStart"].is_null(), "rollup 列不属 EVT-01");

    let mut reparsed = parse_canonical_event(&wire).expect("wire reparses");
    // `created_at` 重取 now、`raw_payload_json` 是入库文本缓存 ⇒ 只归一这两项。
    reparsed.created_at = row.created_at;
    reparsed.raw_payload_json = row.raw_payload_json.clone();
    assert_eq!(reparsed, row, "wire 必须逐字段往返");
}

/// #81 回归修复：超限 rawPayload 的截断元数据由 wire 显式携带（重解析会按裁剪后
/// 的短载荷重算而不报截断）——此不对称是已知且刻意的。
#[test]
fn canonical_event_wire_keeps_truncation_metadata_in_payload() {
    let oversized = "x".repeat(MAX_CANONICAL_RAW_BYTES + 1024);
    let input = event_json(
        "peri",
        "local:s1",
        7,
        "tool.call.started",
        serde_json::json!({ "update": { "sessionUpdate": "tool_call", "blob": oversized } }),
    );
    let row = parse_canonical_event(&input).expect("oversized raw still parses");
    assert!(row.raw_truncated);

    let wire = canonical_event_wire(&row);
    assert_eq!(wire["rawMetadata"]["truncated"], true);
    assert_eq!(wire["rawMetadata"]["reason"], "size");
    assert_eq!(
        wire["rawMetadata"]["originalBytes"],
        serde_json::json!(row.raw_original_bytes)
    );
    // 已裁剪载荷很短 ⇒ 重解析报未截断：前端取证依赖 rawMetadata，而非重解析。
    let reparsed = parse_canonical_event(&wire).expect("wire reparses");
    assert!(!reparsed.raw_truncated);
    assert_eq!(reparsed.raw_payload, row.raw_payload);
}

/// #81 L2：非终结事件不折叠（未终结 turn 不产生单元行）。
#[test]
fn non_terminal_ingest_does_not_build_unit() {
    let repo = repo();
    let result = repo
        .ingest_kernel_event(kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "未终结" } }
        })))
        .unwrap();
    assert_eq!(result.events.len(), 1);
    let compact = repo
        .load_events_compact(&serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap())
        .unwrap();
    assert_eq!(compact.len(), 1);
    assert_eq!(compact[0].event_type, "assistant.text.delta");
}

/// #81 L3：预算暂停 / 续跑 / 幂等；sha256 校验通过才删行；完成后 VACUUM。
#[test]
fn rollup_trim_pauses_on_budget_and_resumes() {
    let repo = repo();
    let delta = |text: &str| {
        serde_json::json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": text } }
        })
    };
    // 两个 turn → 两个单元
    for text in ["a", "b"] {
        repo.ingest_kernel_event(kernel_input(delta(text))).unwrap();
        repo.ingest_kernel_event(kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "done" }
        })))
        .unwrap();
    }

    // 预算 0：单事务边界暂停——一次只裁剪一个单元
    let first = repo.rollup_trim(Some(0)).unwrap();
    assert_eq!(first.processed_units, 1);
    assert_eq!(first.trimmed_units, 1);
    assert_eq!(first.remaining_units, 1);

    // 续跑：剩余单元完成并 VACUUM
    let second = repo.rollup_trim(None).unwrap();
    assert_eq!(second.trimmed_units, 1);
    assert_eq!(second.remaining_units, 0);
    assert!(second.vacuumed);

    // 幂等：再跑无事可做、不 VACUUM
    let again = repo.rollup_trim(None).unwrap();
    assert_eq!(again.processed_units, 0);
    assert_eq!(again.remaining_units, 0);
    assert!(!again.vacuumed);
}

/// #81 L3：行已删除（claim 后崩溃 / 部分删除）→ 续跑只补标记，不重复不丢失。
#[test]
fn rollup_trim_resume_when_rows_already_gone() {
    let repo = repo();
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    repo.ingest_kernel_event(kernel_input(serde_json::json!({
        "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "ok" } }
    })))
    .unwrap();
    repo.ingest_kernel_event(kernel_input(serde_json::json!({
        "update": { "sessionUpdate": "done" }
    })))
    .unwrap();
    // 模拟"claim 后崩溃、行已被外部清理"：手工删除覆盖行
    {
        let conn = repo.conn.lock().unwrap();
        conn.execute("DELETE FROM canonical_events WHERE sequence <= 2", [])
            .unwrap();
    }
    let report = repo.rollup_trim(None).unwrap();
    assert_eq!(report.resumed_units, 1, "行已删路径只补标记");
    assert_eq!(report.trimmed_units, 0);
    let rows = repo.list_events(&owner_key, None, 100).unwrap();
    assert_eq!(rows.events.len(), 1, "只剩单元行");
}

/// #81 L3：sha256 不匹配 → 保留行（不丢弃）、永久跳过（不重试）。
/// （行经 append_events 直写——不经 kernel ingest，因此无真实单元干扰。）
#[test]
fn rollup_trim_keeps_rows_on_sha_mismatch() {
    let repo = repo();
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    let rows = vec![
            parse_canonical_event(&event_json(
                "peri",
                "local:s1",
                1,
                "assistant.text.delta",
                serde_json::json!({ "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "real" } } }),
            ))
            .unwrap(),
            parse_canonical_event(&event_json(
                "peri",
                "local:s1",
                2,
                "turn.completed",
                serde_json::json!({ "update": { "sessionUpdate": "done" } }),
            ))
            .unwrap(),
        ];
    repo.append_events(&rows, None).unwrap();
    let mut unit_value = event_json(
        "peri",
        "local:s1",
        3,
        "turn.unit",
        serde_json::json!({ "kind": "turn-unit" }),
    );
    unit_value["typedPayload"] = serde_json::json!({
        "aggregateKind": "turn-rollup",
        "seqStart": 1,
        "seqEnd": 2,
        "foldedCount": 2,
        "foldScheme": "adjacent-delta-fold-v1",
        "contentSha256": "deadbeef",
        "terminal": { "eventType": "turn.completed", "occurredAt": "2026-08-14T00:00:00.000Z" },
        "segments": [],
    });
    let unit_row = parse_canonical_event(&unit_value).unwrap();
    repo.append_events(&[unit_row], Some(2)).unwrap();

    let report = repo.rollup_trim(None).unwrap();
    assert_eq!(report.mismatch_units, 1, "sha 不匹配 → 保留行并跳过");
    let remaining = repo.list_events(&owner_key, None, 100).unwrap();
    let plain_rows = remaining
        .events
        .iter()
        .filter(|e| e.event_type != "turn.unit")
        .count();
    assert_eq!(plain_rows, 2, "行未被删除");
    let again = repo.rollup_trim(None).unwrap();
    assert_eq!(again.mismatch_units, 0, "mismatch 永久跳过不重试");
    assert_eq!(again.remaining_units, 0);
}

/// #81 L3：空 journal 上裁剪为 no-op（不 VACUUM）。
#[test]
fn rollup_trim_report_is_empty_on_fresh_journal() {
    let repo = repo();
    let report = repo.rollup_trim(None).unwrap();
    assert_eq!(report.processed_units, 0);
    assert_eq!(report.remaining_units, 0);
    assert!(!report.vacuumed);
}

#[tokio::test]
async fn complete_replay_imports_atomically_only_into_an_empty_journal() {
    let service = EventService::in_memory().expect("event service");
    let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
    let replay = vec![
        serde_json::json!({
            "sessionId": "remote-1",
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "text": "persona\n\n---\n\nquestion" }
            }
        }),
        serde_json::json!({
            "sessionId": "remote-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "answer" }
            }
        }),
    ];

    let imported = service
        .ingest_complete_replay(
            owner.clone(),
            Some("remote-1".to_string()),
            7,
            replay.clone(),
        )
        .await
        .expect("first import");
    assert_eq!(imported.revision, 2);
    assert_eq!(imported.status, "imported");
    assert_eq!(
        imported
            .events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["user.message", "assistant.text.delta"]
    );
    assert_eq!(
        imported.events[0].typed_payload.as_ref().unwrap()["text"],
        "question"
    );
    assert_eq!(imported.events[0].raw_payload["sessionId"], "remote-1");
    assert_eq!(
        imported.events[0].raw_payload["update"]["_meta"]["pylonReplayImport"],
        true
    );
    assert!(imported.events.iter().all(|event| {
        event.provenance_origin == "recovery-import" && event.provenance_trust == "unverified"
    }));
    let skipped = service
        .ingest_complete_replay(owner, Some("remote-1".to_string()), 7, replay)
        .await
        .expect("existing journal wins");
    assert!(skipped.events.is_empty());
    assert_eq!(skipped.revision, 2);
    assert_eq!(skipped.status, "already-imported");

    let empty_observation = service
        .ingest_complete_replay(
            DurableSessionOwner::new("p1", "peri", "local:s1"),
            Some("remote-1".to_string()),
            7,
            Vec::new(),
        )
        .await
        .expect("empty replay still reports the journal revision");
    assert!(empty_observation.events.is_empty());
    assert_eq!(empty_observation.revision, 2);
    assert_eq!(empty_observation.status, "already-imported");

    let empty_session = service
        .ingest_complete_replay(
            DurableSessionOwner::new("p1", "peri", "local:empty"),
            Some("remote-empty".to_string()),
            7,
            Vec::new(),
        )
        .await
        .expect("empty journal and replay");
    assert_eq!(empty_session.status, "empty");
    assert_eq!(empty_session.revision, 0);
    assert!(empty_session.events.is_empty());
}

#[tokio::test]
async fn complete_replay_does_not_reconcile_a_partial_local_journal() {
    let service = EventService::in_memory().expect("event service");
    let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
    service
            .ingest_event(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                serde_json::json!({
                    "source": "local:s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "partial" } }
                }),
            )
            .await
            .expect("partial live row");
    let replay = vec![serde_json::json!({
        "sessionId": "remote-1",
        "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "complete" } }
    })];

    let reconciled = service
        .ingest_complete_replay(
            owner.clone(),
            Some("remote-1".to_string()),
            7,
            replay.clone(),
        )
        .await
        .expect("reconcile partial journal");
    assert_eq!(reconciled.status, "local-authoritative");
    assert_eq!(reconciled.revision, 1);
    assert!(reconciled.events.is_empty());

    let repeated = service
        .ingest_complete_replay(owner, Some("remote-1".to_string()), 7, replay)
        .await
        .expect("same snapshot is idempotent");
    assert_eq!(repeated.status, "local-authoritative");
    assert_eq!(repeated.revision, 1);
    assert!(repeated.events.is_empty());
}

#[tokio::test]
async fn local_journal_authority_never_imports_replay_or_snapshot() {
    let service = EventService::in_memory().expect("event service");
    let owner = DurableSessionOwner::new("p1", "peri", "local:local-wins");
    service
        .ingest_event(
            owner.clone(),
            Some("remote-1".to_string()),
            7,
            serde_json::json!({
                "source": "local:local-wins",
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "local" } }
            }),
        )
        .await
        .expect("local row");

    let result = service
            .ingest_complete_replay(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                vec![serde_json::json!({
                    "sessionId": "remote-1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "replay" } }
                })],
            )
            .await
            .expect("local authority should short-circuit replay import");

    assert_eq!(result.status, "local-authoritative");
    assert!(result.events.is_empty());
    assert_eq!(result.revision, 1);

    let page = service
        .list_events(owner.key().expect("owner key"), None, 100, false)
        .await
        .expect("list local journal");
    assert_eq!(page.events.len(), 1);
    assert_eq!(
        page.events[0].typed_payload.as_ref().unwrap()["text"],
        "local"
    );
    assert!(page
        .events
        .iter()
        .all(|event| event.event_type != "history.snapshot"));
}

#[tokio::test]
async fn untrusted_existing_rows_never_trigger_snapshot_reconciliation() {
    let service = EventService::in_memory().expect("event service");
    let owner = DurableSessionOwner::new("p1", "peri", "local:untrusted");
    service
        .append_events(
            vec![event_json(
                "peri",
                "local:untrusted",
                1,
                "assistant.text.delta",
                serde_json::json!({ "text": "forensic" }),
            )],
            None,
        )
        .await
        .expect("existing untrusted row");

    let result = service
            .ingest_complete_replay(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                vec![serde_json::json!({
                    "sessionId": "remote-1",
                    "update": { "sessionUpdate": "assistant_message_chunk", "content": { "text": "replay" } }
                })],
            )
            .await
            .expect("replay must remain non-destructive");
    assert_eq!(result.status, "already-imported");
    assert_eq!(result.revision, 1);
    assert!(result.events.is_empty());

    let page = service
        .list_events(owner.key().expect("owner key"), None, 100, false)
        .await
        .expect("list journal");
    assert_eq!(page.events.len(), 1);
    assert!(page
        .events
        .iter()
        .all(|event| event.event_type != "history.snapshot"));
}

#[tokio::test]
async fn partial_replay_does_not_fill_missing_user_turns_when_local_rows_exist() {
    let service = EventService::in_memory().expect("event service");
    let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
    service
            .ingest_event(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                serde_json::json!({
                    "source": "local:s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "partial" } }
                }),
            )
            .await
            .expect("partial live row");
    let replay = vec![
        serde_json::json!({
            "sessionId": "remote-1",
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "text": "persona\n\n---\n\nquestion" }
            }
        }),
        serde_json::json!({
            "sessionId": "remote-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "answer" }
            }
        }),
    ];

    let reconciled = service
        .ingest_complete_replay(
            owner.clone(),
            Some("remote-1".to_string()),
            7,
            replay.clone(),
        )
        .await
        .expect("reconcile partial journal");
    assert_eq!(reconciled.status, "local-authoritative");
    assert_eq!(reconciled.revision, 1);
    assert!(reconciled.events.is_empty());
    let repeated = service
        .ingest_complete_replay(owner, Some("remote-1".to_string()), 7, replay)
        .await
        .expect("recovery is idempotent");
    assert_eq!(repeated.status, "local-authoritative");
    assert_eq!(repeated.revision, 1);
    assert!(repeated.events.is_empty());
}

#[tokio::test]
async fn existing_snapshot_only_journal_is_not_repaired_when_local_authority_exists() {
    let service = EventService::in_memory().expect("event service");
    let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
    service
            .ingest_event(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                serde_json::json!({
                    "source": "local:s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "answer" } }
                }),
            )
            .await
            .expect("partial live row");
    let replay = vec![
        serde_json::json!({
            "sessionId": "remote-1",
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "text": "question" }
            }
        }),
        serde_json::json!({
            "sessionId": "remote-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "answer" }
            }
        }),
    ];
    let marked_replay = replay
        .iter()
        .cloned()
        .map(|raw| mark_replay_import(&owner, raw))
        .collect::<Vec<_>>();
    let snapshot = parse_canonical_event(&event_json(
        "peri",
        "local:s1",
        2,
        "history.snapshot",
        serde_json::json!({
            "kind": "complete-session-replay",
            "replayEvents": marked_replay,
        }),
    ))
    .expect("snapshot row");
    service
        .repo
        .append_events(&[snapshot], Some(1))
        .expect("old snapshot-only row");

    let repaired = service
        .ingest_complete_replay(owner, Some("remote-1".to_string()), 7, replay)
        .await
        .expect("repair snapshot-only journal");
    assert_eq!(repaired.status, "local-authoritative");
    assert_eq!(repaired.revision, 2);
    assert!(repaired.events.is_empty());
}

#[tokio::test]
async fn concurrent_kernel_ingest_allocates_one_contiguous_sequence() {
    let service = Arc::new(EventService::in_memory().expect("service"));
    let mut tasks = Vec::new();
    for index in 0..20 {
        let service = service.clone();
        tasks.push(tokio::spawn(async move {
            service
                .ingest_event(
                    DurableSessionOwner::new("p1", "peri", "local:s1"),
                    Some("remote-1".to_string()),
                    5,
                    serde_json::json!({
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": { "text": index.to_string() }
                        }
                    }),
                )
                .await
                .expect("ingest")
                .revision
        }));
    }
    let mut revisions = Vec::new();
    for task in tasks {
        revisions.push(task.await.unwrap());
    }
    revisions.sort_unstable();

    assert_eq!(revisions, (1..=20).collect::<Vec<_>>());
    assert_eq!(
        service
            .revision(serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap())
            .await
            .unwrap(),
        20
    );
}

#[test]
fn fresh_db_has_canonical_events_table_and_version() {
    let repo = repo();
    let conn = repo.conn.lock().unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::msg_repo::SCHEMA_VERSION);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='canonical_events'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "v6 新库必须包含 canonical_events 表");
}

#[test]
fn tombstoned_owner_append_rejected_events_kept() {
    // DEL-04：删除（tombstone）后迟到 evt_append 拒绝且不复活；已落盘事件留存。
    let repo = repo();
    let first = parse_canonical_event(&event_json(
        "peri",
        "s1",
        1,
        "user.message",
        serde_json::json!({"text": "before delete"}),
    ))
    .unwrap();
    repo.append_events(std::slice::from_ref(&first), None)
        .expect("first append");
    let owner_key = first.owner_key;
    {
        let conn = repo.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO deleted_sessions
                     (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision)
                 VALUES (?1, 's1', 'exact', 1, 'deleted', 0)",
            params![owner_key],
        )
        .expect("insert tombstone");
    }
    let late = parse_canonical_event(&event_json(
        "peri",
        "s1",
        2,
        "user.message",
        serde_json::json!({"text": "late write"}),
    ))
    .unwrap();
    let error = repo
        .append_events(&[late], None)
        .expect_err("tombstone 必须拒绝迟到写");
    assert!(matches!(error, EventError::SessionDeleted(_)));
    assert_eq!(error.code(), "event_session_deleted");
    let page = repo.list_events(&owner_key, None, 10).unwrap();
    assert_eq!(page.events.len(), 1, "canonical_events 行不随删除清除");
    assert_eq!(page.events[0].sequence, 1);
    assert_eq!(repo.revision(&owner_key).unwrap(), 1);
}

#[test]
fn exact_tombstone_does_not_block_another_owner_with_same_source() {
    let repo = repo();
    let deleted_key = serde_json::to_string(&["p1", "peri", "shared"]).unwrap();
    {
        let conn = repo.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO deleted_sessions
                     (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision)
                 VALUES (?1, 'metadata-a', 'exact', 1, 'deleted', 0)",
            params![deleted_key],
        )
        .unwrap();
    }
    let other_owner = parse_canonical_event(&event_json(
        "vega",
        "shared",
        1,
        "user.message",
        serde_json::json!({"text": "independent"}),
    ))
    .unwrap();
    repo.append_events(&[other_owner], None)
        .expect("exact tombstone must not leak across owners");
}

#[test]
fn legacy_tombstone_conservatively_blocks_all_owners_for_same_source() {
    let repo = repo();
    {
        let conn = repo.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO deleted_sessions
                     (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision)
                 VALUES ('[\"*\",\"*\",\"shared\"]', 'shared', 'legacy', 1, 'deleted', 0)",
            [],
        )
        .unwrap();
    }
    let late = parse_canonical_event(&event_json(
        "vega",
        "shared",
        1,
        "user.message",
        serde_json::json!({"text": "late"}),
    ))
    .unwrap();
    assert!(matches!(
        repo.append_events(&[late], None),
        Err(EventError::SessionDeleted(_))
    ));
}

#[test]
fn search_hits_returns_hit_rows_case_insensitive_and_keeps_row_granularity() {
    let repo = repo();
    let hit_a = parse_canonical_event(&event_json(
        "peri",
        "s1",
        1,
        "user.message",
        serde_json::json!({"text": "Needle in raw payload"}),
    ))
    .unwrap();
    let hit_b = parse_canonical_event(&event_json(
        "peri",
        "s1",
        2,
        "user.message",
        serde_json::json!({"text": "second needle row"}),
    ))
    .unwrap();
    let miss = parse_canonical_event(&event_json(
        "peri",
        "s2",
        1,
        "user.message",
        serde_json::json!({"text": "nothing here"}),
    ))
    .unwrap();
    repo.append_events(&[hit_a, hit_b], None).expect("append");
    repo.append_events(&[miss], None).expect("append miss");

    let hits = repo.search_hits("NEEDLE", 10).unwrap();
    assert_eq!(hits.len(), 2, "命中行按行返回（不再去重到 owner）");
    assert_eq!(hits[0].profile_id, "p1");
    assert_eq!(hits[0].agent_id, "peri");
    assert_eq!(hits[0].local_session_id, "s1");
    assert_eq!(hits[0].remote_session_id.as_deref(), Some("remote-1"));
    assert_eq!(hits[0].sequence, 1);
    assert_eq!(hits[0].event_type, "user.message");
    assert_eq!(hits[0].occurred_at, "2026-08-14T00:00:00.000Z");
    assert_eq!(hits[1].sequence, 2);

    let none = repo.search_hits("absent-term", 10).unwrap();
    assert!(none.is_empty());
}

#[test]
fn search_hits_escapes_like_wildcards_to_literals() {
    let repo = repo();
    // #488 批③：`%`/`_`/`\` 是用户文本的一部分，不是通配符——只匹配字面出现。
    let percent_row = parse_canonical_event(&event_json(
        "peri",
        "s1",
        1,
        "user.message",
        serde_json::json!({"text": "进度 100% 完成"}),
    ))
    .unwrap();
    let underscore_row = parse_canonical_event(&event_json(
        "peri",
        "s1",
        2,
        "user.message",
        serde_json::json!({"text": "snake_case 命名"}),
    ))
    .unwrap();
    let bridge_row = parse_canonical_event(&event_json(
        "peri",
        "s1",
        3,
        "user.message",
        serde_json::json!({"text": "反斜杠 \\ 字面量"}),
    ))
    .unwrap();
    let plain_rows = [
        parse_canonical_event(&event_json(
            "peri",
            "s2",
            1,
            "user.message",
            serde_json::json!({"text": "普通文本没有任何特殊字符"}),
        ))
        .unwrap(),
        parse_canonical_event(&event_json(
            "peri",
            "s2",
            2,
            "user.message",
            serde_json::json!({"text": "axb 三个字母没有下划线"}),
        ))
        .unwrap(),
    ];
    repo.append_events(&[percent_row, underscore_row, bridge_row], None)
        .expect("append");
    repo.append_events(&plain_rows, None).expect("append plain");

    // `%` 只命中字面含 `%` 的行（修复前会匹配所有行）。
    let percent_hits = repo.search_hits("%", 10).unwrap();
    assert_eq!(percent_hits.len(), 1);
    assert_eq!(percent_hits[0].sequence, 1);

    // `_` 只命中字面含 `_` 的行（修复前 `a%`/`_` 会把 `axb` 一并拉进来）。
    let underscore_hits = repo.search_hits("_", 10).unwrap();
    assert_eq!(
        underscore_hits
            .iter()
            .map(|hit| hit.sequence)
            .collect::<Vec<_>>(),
        vec![2],
        "下划线按字面量匹配，snake_case 命中而 axb 不命中"
    );

    // 转义符本身也按字面量匹配。
    let backslash_hits = repo.search_hits("\\", 10).unwrap();
    assert_eq!(backslash_hits.len(), 1);
    assert_eq!(backslash_hits[0].sequence, 3);

    // 混合通配符的子串仍然按字面命中。
    let mixed = repo.search_hits("100% 完", 10).unwrap();
    assert_eq!(mixed.len(), 1);
    assert_eq!(mixed[0].sequence, 1);
}

#[test]
fn search_hits_matches_chinese_query_and_reports_exact_offsets() {
    let repo = repo();
    // raw_payload 序列化文本 = `{"text":"中文检索词在此"}`，"检索词" 首偏移 = 12
    //（1-based 字符位：`{"text":"` 占 9 位）。
    let chinese = parse_canonical_event(&event_json(
        "peri",
        "s1",
        1,
        "user.message",
        serde_json::json!({"text": "中文检索词在此"}),
    ))
    .unwrap();
    let ascii = parse_canonical_event(&event_json(
        "peri",
        "s1",
        2,
        "user.message",
        serde_json::json!({"text": "Needle in raw payload"}),
    ))
    .unwrap();
    repo.append_events(&[chinese], None).expect("append");
    repo.append_events(&[ascii], None).expect("append");

    let hits = repo.search_hits("检索词", 10).unwrap();
    assert_eq!(hits.len(), 1, "中文按 UTF-8 原文精确匹配");
    assert_eq!(hits[0].sequence, 1);
    assert_eq!(hits[0].match_offset, Some(12), "instr 偏移落在原文首字符");

    let folded = repo.search_hits("needle", 10).unwrap();
    assert_eq!(folded.len(), 1);
    assert_eq!(
        folded[0].match_offset,
        Some(10),
        "ASCII 折叠命中（lower+NOCASE 对齐）偏移非空"
    );

    // 仅 event_type 命中（payload 无该词）→ 行返回但 offset 为 None。
    let type_only = repo.search_hits("user.message", 10).unwrap();
    assert_eq!(type_only.len(), 2);
    assert!(type_only.iter().all(|hit| hit.match_offset.is_none()));
}

#[test]
fn search_hits_orders_by_owner_triple_then_sequence_and_truncates() {
    let repo = repo();
    let mut rows = Vec::new();
    for (agent, local, sequence) in [
        ("zeta", "s1", 5),
        ("alpha", "s2", 1),
        ("alpha", "s2", 2),
        ("alpha", "s1", 9),
    ] {
        rows.push(
            parse_canonical_event(&event_json(
                agent,
                local,
                sequence,
                "user.message",
                serde_json::json!({"text": format!("needle {sequence}")}),
            ))
            .unwrap(),
        );
    }
    // append 批次不允许跨 owner：按 (agent, local) 分组写入。
    rows.sort_by_key(|row| (row.agent_id.clone(), row.local_session_id.clone()));
    for group in
        rows.chunk_by(|a, b| a.agent_id == b.agent_id && a.local_session_id == b.local_session_id)
    {
        repo.append_events(group, None).expect("append");
    }

    let hits = repo.search_hits("needle", 3).unwrap();
    let seen: Vec<(String, i64)> = hits
        .iter()
        .map(|hit| (hit.local_session_id.clone(), hit.sequence))
        .collect();
    assert_eq!(
        seen,
        vec![("s1".into(), 9), ("s2".into(), 1), ("s2".into(), 2),],
        "按 (profile, agent, local) 排序后截断，owner 内 sequence 升序"
    );
}

/// #445 验收读数：单次搜索 IPC 载荷 = 命中行集，不再随会话行数线性放大——
/// 300 行会话命中 2 行时，搜索返回 2 行（全量 compact 读是 300 行）。
/// 行数是 IPC 载荷的代理读数（wire 载荷 ≈ 行数 × 单行大小），非字节级断言。
#[test]
fn search_hits_payload_is_hit_row_set_not_full_stream() {
    let repo = repo();
    let mut rows = Vec::new();
    for sequence in 1..=300 {
        let text = if sequence == 128 || sequence == 256 {
            "needle here".to_string()
        } else {
            format!("filler row {sequence}")
        };
        rows.push(
            parse_canonical_event(&event_json(
                "peri",
                "s1",
                sequence,
                "user.message",
                serde_json::json!({"text": text}),
            ))
            .unwrap(),
        );
    }
    repo.append_events(&rows, None).expect("append");
    let owner_key = serde_json::to_string(&["p1", "peri", "s1"]).unwrap();

    let hits = repo.search_hits("needle", 50).unwrap();
    let full_stream = repo.load_events_compact(&owner_key).unwrap();
    assert_eq!(hits.len(), 2, "IPC 行数 = 命中行数");
    assert_eq!(full_stream.len(), 300, "对照：全量读 = 会话总行数");
}

#[test]
fn append_and_list_roundtrip_preserves_fields() {
    let repo = repo();
    let ev = event_json(
        "peri",
        "local:同名",
        1,
        "user.message",
        serde_json::json!({"text": "hi"}),
    );
    let result = repo
        .append_events(&[parse_canonical_event(&ev).unwrap()], None)
        .unwrap();
    assert_eq!(result.revision, 1);
    assert_eq!(result.events.len(), 1);
    let page = repo
        .list_events(&result.events[0].owner_key, None, 10)
        .unwrap();
    assert_eq!(page.events.len(), 1);
    let row = &page.events[0];
    assert_eq!(row.event_type, "user.message");
    assert_eq!(row.sequence, 1);
    assert_eq!(row.raw_payload, serde_json::json!({"text": "hi"}));
    assert_eq!(row.local_session_id, "local:同名");
    assert_eq!(row.remote_session_id.as_deref(), Some("remote-1"));
    assert_eq!(row.client_generation, 5);
    assert_eq!(row.payload_version, 1);
    assert!(row.occurred_at.starts_with("2026-08-14"));
}

#[test]
fn unknown_event_type_accepted_raw_payload_kept() {
    let repo = repo();
    let ev = event_json(
        "peri",
        "s1",
        1,
        "unknown",
        serde_json::json!({"future": "thing"}),
    );
    let result = repo
        .append_events(&[parse_canonical_event(&ev).unwrap()], None)
        .unwrap();
    let page = repo
        .list_events(&result.events[0].owner_key, None, 10)
        .unwrap();
    assert_eq!(page.events[0].event_type, "unknown");
    assert_eq!(
        page.events[0].raw_payload,
        serde_json::json!({"future": "thing"})
    );
}

#[test]
fn interaction_credentials_are_redacted_before_canonical_journal_append() {
    let repo = repo();
    let credential = "c12-journal-credential";
    let mut ev = event_json(
        "peri",
        "s1",
        1,
        "interaction.requested",
        serde_json::json!({
            "request": {
                "kind": "sudo",
                "command": "apt update",
                "password": credential,
                "nested": { "clientSecret": credential }
            }
        }),
    );
    ev["typedPayload"] = serde_json::json!({
        "request": { "kind": "sudo", "password": credential }
    });

    let result = repo
        .append_events(&[parse_canonical_event(&ev).unwrap()], None)
        .unwrap();
    let row = &result.events[0];
    let persisted = serde_json::to_string(row).unwrap();
    assert!(!persisted.contains(credential));
    assert_eq!(row.raw_payload["request"]["command"], "apt update");
    assert_eq!(row.raw_payload["request"]["passwordRedacted"], true);
    assert_eq!(
        row.raw_payload["request"]["nested"]["clientSecretRedacted"],
        true
    );
    assert_eq!(
        row.typed_payload.as_ref().unwrap()["request"]["passwordRedacted"],
        true
    );
    let exported = repo
        .export_raw_event(&row.event_id)
        .expect("export")
        .expect("row");
    assert!(!exported.raw_payload_json.contains(credential));
    assert!(exported.raw_payload_json.contains("passwordRedacted"));
    assert!(!exported
        .typed_payload_json
        .as_deref()
        .unwrap_or_default()
        .contains(credential));
}

#[test]
fn corrupt_json_columns_fail_with_event_and_column_context() {
    for column in ["identity", "typed_payload", "raw_payload"] {
        let repo = repo();
        let row = parse_canonical_event(&event_json(
            "peri",
            "s1",
            1,
            "user.message",
            serde_json::json!({"text": "kept"}),
        ))
        .expect("event");
        repo.append_events(std::slice::from_ref(&row), None)
            .expect("append");
        repo.conn
                .lock()
                .unwrap()
                .execute(
                    &format!(
                        "UPDATE canonical_events SET {column} = '{{broken' WHERE owner_key = ?1 AND sequence = ?2"
                    ),
                    params![row.owner_key, row.sequence],
                )
                .expect("inject malformed JSON");

        let error = repo
            .list_events(&row.owner_key, None, 10)
            .expect_err("malformed JSON must not normalize to null/none");
        assert_eq!(error.code(), "event_repo_corrupt");
        let message = error.to_string();
        assert!(message.contains(&format!("event={}", row.event_id)));
        assert!(message.contains(&format!("column={column}")));
        assert!(
            !message.contains("kept"),
            "diagnostic must not leak payload content"
        );
        let exported = repo
            .export_raw_event(&row.event_id)
            .expect("raw export")
            .expect("corrupt row remains isolatable");
        let corrupt_value = match column {
            "identity" => exported.identity_json.as_deref(),
            "typed_payload" => exported.typed_payload_json.as_deref(),
            _ => Some(exported.raw_payload_json.as_str()),
        };
        assert_eq!(corrupt_value, Some("{broken"));
    }
}

#[test]
fn duplicate_event_id_idempotent() {
    let repo = repo();
    let ev = event_json(
        "peri",
        "s1",
        1,
        "user.message",
        serde_json::json!({"text": "x"}),
    );
    repo.append_events(&[parse_canonical_event(&ev).unwrap()], None)
        .unwrap();
    // 同 event_id 重复写入 → 跳过不报错、不新增行
    let result = repo
        .append_events(&[parse_canonical_event(&ev).unwrap()], Some(1))
        .unwrap();
    assert_eq!(result.events.len(), 0, "去重后无新增行");
    let page = repo
        .list_events(
            &result.events.first().map_or_else(
                || "[\"p1\",\"peri\",\"s1\"]".to_string(),
                |e| e.owner_key.clone(),
            ),
            None,
            10,
        )
        .unwrap();
    assert_eq!(page.events.len(), 1);
}

#[test]
fn double_agent_same_source_sequences_isolated() {
    let repo = repo();
    let a1 = event_json(
        "peri",
        "local:同名",
        1,
        "user.message",
        serde_json::json!({"a": 1}),
    );
    let b1 = event_json(
        "hermes",
        "local:同名",
        1,
        "user.message",
        serde_json::json!({"b": 1}),
    );
    let a_row = parse_canonical_event(&a1).unwrap();
    let b_row = parse_canonical_event(&b1).unwrap();
    assert_ne!(
        a_row.owner_key, b_row.owner_key,
        "双 Agent 同名 source → owner key 隔离"
    );
    repo.append_events(std::slice::from_ref(&a_row), None)
        .unwrap();
    repo.append_events(std::slice::from_ref(&b_row), None)
        .unwrap();
    let page_a = repo.list_events(&a_row.owner_key, None, 10).unwrap();
    let page_b = repo.list_events(&b_row.owner_key, None, 10).unwrap();
    assert_eq!(page_a.events.len(), 1);
    assert_eq!(page_b.events.len(), 1);
    assert_eq!(repo.revision(&a_row.owner_key).unwrap(), 1);
    assert_eq!(repo.revision(&b_row.owner_key).unwrap(), 1);
}

#[test]
fn sequence_monotonic_within_owner_revision_tracks_max() {
    let repo = repo();
    let e1 = event_json("peri", "s1", 1, "user.message", serde_json::json!({"n": 1}));
    let e2 = event_json(
        "peri",
        "s1",
        2,
        "tool.call.started",
        serde_json::json!({"n": 2}),
    );
    let r1 = parse_canonical_event(&e1).unwrap();
    let r2 = parse_canonical_event(&e2).unwrap();
    repo.append_events(std::slice::from_ref(&r1), None).unwrap();
    repo.append_events(std::slice::from_ref(&r2), None).unwrap();
    assert_eq!(repo.revision(&r1.owner_key).unwrap(), 2);
    let page = repo.list_events(&r1.owner_key, None, 10).unwrap();
    let seqs: Vec<i64> = page.events.iter().map(|e| e.sequence).collect();
    assert_eq!(seqs, vec![1, 2], "升序返回");
    // 旧 expected_revision 落后 → conflict，不写任何行
    let e3 = event_json("peri", "s1", 3, "turn.completed", serde_json::json!({}));
    let err = repo
        .append_events(&[parse_canonical_event(&e3).unwrap()], Some(1))
        .unwrap_err();
    assert!(matches!(
        err,
        EventError::RevisionConflict {
            expected: 1,
            actual: 2
        }
    ));
    let page = repo.list_events(&r1.owner_key, None, 10).unwrap();
    assert_eq!(page.events.len(), 2, "冲突后无新行写入");
}

#[test]
fn cursor_paging_no_offset() {
    let repo = repo();
    let mut rows = Vec::new();
    for i in 1..=5 {
        let ev = event_json("peri", "s1", i, "user.message", serde_json::json!({"i": i}));
        rows.push(parse_canonical_event(&ev).unwrap());
    }
    repo.append_events(&rows, None).unwrap();
    let owner = &rows[0].owner_key;
    // 最新一页：seq 4,5（升序）
    let page1 = repo.list_events(owner, None, 2).unwrap();
    let seqs1: Vec<i64> = page1.events.iter().map(|e| e.sequence).collect();
    assert_eq!(seqs1, vec![4, 5]);
    // 游标 = 上页最旧 seq（4）→ 翻旧一页 2,3
    let page2 = repo
        .list_events(owner, page1.next_before_sequence, 2)
        .unwrap();
    let seqs2: Vec<i64> = page2.events.iter().map(|e| e.sequence).collect();
    assert_eq!(seqs2, vec![2, 3]);
    // 再翻：仅剩 1
    let page3 = repo
        .list_events(owner, page2.next_before_sequence, 2)
        .unwrap();
    let seqs3: Vec<i64> = page3.events.iter().map(|e| e.sequence).collect();
    assert_eq!(seqs3, vec![1]);
    assert_eq!(page3.next_before_sequence, Some(1));
    let page4 = repo
        .list_events(owner, page3.next_before_sequence, 2)
        .unwrap();
    assert!(page4.events.is_empty());
    assert_eq!(page4.next_before_sequence, None);
}

#[test]
fn malformed_input_rejected_not_silently_dropped() {
    let repo = repo();
    // 非对象
    assert!(matches!(
        parse_canonical_event(&serde_json::json!("raw")),
        Err(EventError::Invalid(_))
    ));
    // 缺 owner
    let missing_owner = serde_json::json!({
        "eventId": "[\"p1\",\"peri\",\"s1\"]#1",
        "clientGeneration": 0, "sequence": 1,
        "occurredAt": "2026-08-14T00:00:00.000Z", "receivedAt": "2026-08-14T00:00:00.000Z",
        "eventType": "user.message", "payloadVersion": 1, "rawPayload": {}
    });
    assert!(matches!(
        parse_canonical_event(&missing_owner),
        Err(EventError::Invalid(msg)) if msg.contains("owner")
    ));
    // sequence 0
    let seq0 = event_json("peri", "s1", 0, "user.message", serde_json::json!({}));
    assert!(matches!(
        parse_canonical_event(&seq0),
        Err(EventError::Invalid(msg)) if msg.contains("sequence")
    ));
    // eventId 与推导不一致（改内容但同 id → 不依赖 content，但 id 本身错）
    let mut mismatched = event_json("peri", "s1", 2, "user.message", serde_json::json!({}));
    if let Some(id) = mismatched.get_mut("eventId") {
        *id = serde_json::json!("[\"p1\",\"peri\",\"s1\"]#9");
    }
    assert!(matches!(
        parse_canonical_event(&mismatched),
        Err(EventError::Invalid(msg)) if msg.contains("eventId")
    ));
    // 缺 rawPayload → 拒绝（不得静默丢弃）
    let mut no_raw = event_json("peri", "s1", 3, "unknown", serde_json::json!({}));
    if let serde_json::Value::Object(map) = &mut no_raw {
        map.remove("rawPayload");
    }
    assert!(matches!(
        parse_canonical_event(&no_raw),
        Err(EventError::Invalid(msg)) if msg.contains("rawPayload")
    ));
    // 跨 owner 混批拒绝
    let a = parse_canonical_event(&event_json(
        "peri",
        "s1",
        1,
        "user.message",
        serde_json::json!({}),
    ))
    .unwrap();
    let b = parse_canonical_event(&event_json(
        "hermes",
        "s1",
        1,
        "user.message",
        serde_json::json!({}),
    ))
    .unwrap();
    let err = repo.append_events(&[a, b], None).unwrap_err();
    assert!(matches!(err, EventError::Invalid(_)));
}

#[test]
fn fresh_db_migration_includes_table_after_reopen() {
    // 复用 msg_repo 的迁移链：打开内存仓库验证 v6 表存在（迁移测试见 msg_repo tests）
    let path = std::env::temp_dir().join(format!(
        "pylon-evt-test-{}-{}.db",
        std::process::id(),
        now_millis()
    ));
    {
        let repo = EventRepo::open(&path).expect("open");
        let conn = repo.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::msg_repo::SCHEMA_VERSION);
        // #155 T2（v15）：存储列收窄为 15 列；v13 的 envelope/provenance/raw_* 列
        // 已由读侧派生取代（wire 28 字段契约不变）。
        for column in [
            "owner_key",
            "remote_session_id",
            "sequence",
            "client_generation",
            "occurred_at",
            "received_at",
            "event_type",
            "payload_version",
            "identity",
            "typed_payload",
            "raw_payload",
            "created_at",
            "provenance",
            "rollup_seq_start",
            "rollup_seq_end",
        ] {
            let present: bool = conn
                .prepare("SELECT 1 FROM pragma_table_info('canonical_events') WHERE name = ?1")
                .unwrap()
                .query_row([column], |_| Ok(true))
                .optional()
                .unwrap()
                .unwrap_or(false);
            assert!(present, "v15 canonical_events 缺少列 {column}");
        }
        for derived in [
            "event_id",
            "profile_id",
            "agent_id",
            "local_session_id",
            "schema_version",
            "provenance_origin",
            "provenance_trust",
            "raw_truncated",
        ] {
            let present: bool = conn
                .prepare("SELECT 1 FROM pragma_table_info('canonical_events') WHERE name = ?1")
                .unwrap()
                .query_row([derived], |_| Ok(true))
                .optional()
                .unwrap()
                .unwrap_or(false);
            assert!(!present, "v15 派生列不得落库: {derived}");
        }
    }
    // 重开幂等
    {
        let repo = EventRepo::open(&path).expect("reopen");
        let conn = repo.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::msg_repo::SCHEMA_VERSION);
    }
    let _ = std::fs::remove_file(&path);
}

/// #51 收口：latest_event_of_type 取同类型最新 sequence 行、跨类型过滤、
/// 空结果返回 None——写入侧幂等判定的查询语义钉住。
#[test]
fn latest_event_of_type_returns_newest_matching_row() {
    let repo = repo();
    let selector = |value: &str| {
        serde_json::json!({
            "source": "local:s1",
            "update": {
                "sessionUpdate": "config_option_update",
                "configOptions": [{ "id": value }]
            }
        })
    };
    let owner_key = repo
        .ingest_kernel_event(kernel_input(selector("v1")))
        .expect("ingest v1")
        .events[0]
        .owner_key
        .clone();
    repo.ingest_kernel_event(kernel_input(serde_json::json!({
        "source": "local:s1",
        "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "root-tool",
            "content": { "toolCallId": "root-tool" },
            "title": "Write",
            "kind": "edit",
            "status": "completed",
            "rawOutput": { "ok": true }
        }
    })))
    .expect("ingest tool update");
    repo.ingest_kernel_event(kernel_input(selector("v2")))
        .expect("ingest v2");

    let latest = repo
        .latest_event_of_type(&owner_key, "session.config-updated")
        .expect("selector query")
        .expect("selector row exists");
    assert_eq!(latest.sequence, 3);
    assert_eq!(
        latest.raw_payload.pointer("/update/configOptions/0/id"),
        Some(&serde_json::json!("v2"))
    );

    let tool = repo
        .latest_event_of_type(&owner_key, "tool.call.completed")
        .expect("tool query")
        .expect("tool row exists");
    assert_eq!(tool.sequence, 2);

    assert!(repo
        .latest_event_of_type(&owner_key, "turn.completed")
        .expect("absent query")
        .is_none());
}

// ── #205：compact 读的尾部 delta 折叠 ───────────────────────────────────

/// 该 owner 的 owner key（测试内固定 profile=p1 / agent=peri / session=local:s1）。
fn owner_key() -> String {
    DurableSessionOwner::new("p1", "peri", "local:s1")
        .key()
        .expect("owner key")
}

fn text_delta(text: &str) -> serde_json::Value {
    serde_json::json!({
        "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": text } }
    })
}

fn thinking_delta(text: &str) -> serde_json::Value {
    serde_json::json!({
        "update": { "sessionUpdate": "agent_thought_chunk", "content": { "text": text } }
    })
}

#[test]
fn compact_read_folds_adjacent_uncovered_delta_run_into_batch_row() {
    let repo = repo();
    repo.ingest_kernel_events(vec![
        kernel_input(text_delta("甲")),
        kernel_input(text_delta("乙")),
        kernel_input(text_delta("丙")),
    ])
    .expect("ingest");

    let rows = repo.load_events_compact(&owner_key()).expect("compact");

    assert_eq!(rows.len(), 1, "三条相邻同类 delta 折成一行");
    let row = &rows[0];
    assert_eq!(row.event_type, "assistant.text.delta.batch");
    assert_eq!(row.sequence, 3, "跨度占用段末 sequence");
    assert_eq!(row.event_id, format!("{}#3", owner_key()));
    let typed = row.typed_payload.as_ref().expect("typed payload");
    assert_eq!(typed["text"], "甲乙丙");
    assert_eq!(typed["foldedCount"], 3);
    assert_eq!(typed["seqSpan"], serde_json::json!([1, 3]));
    assert_eq!(
        row.raw_payload.as_array().expect("raw chunk array").len(),
        3,
        "rawPayload 是原始 chunk 数组（长度 == foldedCount == 跨度宽度）"
    );
    assert_eq!(
        row.raw_payload_json,
        row.raw_payload.to_string(),
        "v15 不变量：raw_payload_json 与 raw_payload 序列化逐字节相等"
    );
    assert!(row.rollup_seq_start.is_none() && row.rollup_seq_end.is_none());
}

#[test]
fn compact_read_keeps_single_delta_unfolded() {
    let repo = repo();
    repo.ingest_kernel_events(vec![kernel_input(text_delta("独"))])
        .expect("ingest");

    let rows = repo.load_events_compact(&owner_key()).expect("compact");

    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].event_type, "assistant.text.delta",
        "单条 run 不合并"
    );
    assert_eq!(rows[0].sequence, 1);
}

#[test]
fn compact_read_breaks_run_on_non_delta_row() {
    let repo = repo();
    repo.ingest_kernel_events(vec![
        kernel_input(text_delta("甲")),
        kernel_input(serde_json::json!({
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "c1",
                "status": "completed"
            }
        })),
        kernel_input(text_delta("乙")),
    ])
    .expect("ingest");

    let rows = repo.load_events_compact(&owner_key()).expect("compact");

    assert_eq!(rows.len(), 3, "非 delta 行打断 run：两侧各剩单条");
    assert_eq!(rows[0].event_type, "assistant.text.delta");
    assert_eq!(rows[1].event_type, "tool.call.completed");
    assert_eq!(rows[2].event_type, "assistant.text.delta");
}

#[test]
fn compact_read_breaks_run_on_identity_change() {
    let repo = repo();
    let identified = |text: &str, message_id: &str| {
        serde_json::json!({
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "messageId": message_id,
                "content": { "text": text }
            }
        })
    };
    repo.ingest_kernel_events(vec![
        kernel_input(identified("甲", "m1")),
        kernel_input(identified("乙", "m1")),
        kernel_input(identified("丙", "m2")),
    ])
    .expect("ingest");

    let rows = repo.load_events_compact(&owner_key()).expect("compact");

    assert_eq!(rows.len(), 2, "identity 变化切断 run");
    assert_eq!(rows[0].event_type, "assistant.text.delta.batch");
    assert_eq!(rows[0].typed_payload.as_ref().unwrap()["text"], "甲乙");
    assert_eq!(rows[1].event_type, "assistant.text.delta");
}

#[test]
fn compact_read_keeps_delta_kinds_in_separate_runs() {
    let repo = repo();
    repo.ingest_kernel_events(vec![
        kernel_input(thinking_delta("思")),
        kernel_input(thinking_delta("考")),
        kernel_input(text_delta("答")),
        kernel_input(text_delta("案")),
    ])
    .expect("ingest");

    let rows = repo.load_events_compact(&owner_key()).expect("compact");

    assert_eq!(rows.len(), 2, "text 与 thinking 各自成 run");
    assert_eq!(rows[0].event_type, "assistant.thinking.delta.batch");
    assert_eq!(rows[1].event_type, "assistant.text.delta.batch");
    assert_eq!(rows[0].typed_payload.as_ref().unwrap()["text"], "思考");
    assert_eq!(rows[1].typed_payload.as_ref().unwrap()["text"], "答案");
}

#[test]
fn compact_read_cuts_run_at_fold_budget_without_losing_rows() {
    let repo = repo();
    // 48 KiB / 2000 chunk 两个预算里更紧的那个先触发（本用例是字节预算），
    // 契约是「切断成多行、跨段连续、不丢行」，不是具体切成几行。
    let total = MAX_FOLDED_CHUNKS + 1;
    let inputs = (1..=total)
        .map(|index| kernel_input(text_delta(&format!("{index},"))))
        .collect::<Vec<_>>();
    repo.ingest_kernel_events(inputs).expect("ingest");

    let rows = repo.load_events_compact(&owner_key()).expect("compact");

    assert!(rows.len() > 1, "预算用尽必须切断成多行（不截断）");
    let mut folded = 0usize;
    let mut expected_start = 1_i64;
    for row in &rows {
        if !row.event_type.ends_with(".batch") {
            assert_eq!(row.sequence, expected_start, "尾部单条按原序保留");
            folded += 1;
            expected_start += 1;
            continue;
        }
        let typed = row.typed_payload.as_ref().expect("typed payload");
        let span = typed["seqSpan"].as_array().expect("seqSpan");
        let count = typed["foldedCount"].as_i64().expect("foldedCount") as usize;
        assert_eq!(span[0].as_i64(), Some(expected_start), "跨度连续且不重叠");
        assert_eq!(
            span[1].as_i64(),
            Some(row.sequence),
            "跨度占用段末 sequence"
        );
        assert_eq!(row.raw_payload.as_array().expect("raw array").len(), count);
        assert!(count <= MAX_FOLDED_CHUNKS, "不得越 foldedCount 上限");
        assert!(count >= 2, "单条不成 batch 行");
        folded += count;
        expected_start = row.sequence + 1;
    }
    assert_eq!(folded, total, "切断不丢行");
}

// ============================================================================
// #376：读出口 typed 载荷收口（只在 service 层；repo 层与 turn_rollup 保持全文）
// ============================================================================

/// 400 KB 量级的工具载荷行——`typed.tool.rawOutput` 远超 64 KiB 线，标量面齐全。
fn oversized_tool_payload() -> serde_json::Value {
    serde_json::json!({
        "sessionId": "remote-1",
        "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "Bash",
            "kind": "execute",
            "status": "in_progress",
            "rawOutput": { "text": "x".repeat(400_000) },
        }
    })
}

fn typed_bytes(value: &serde_json::Value) -> usize {
    value.to_string().len()
}

#[test]
fn typed_payload_cap_is_byte_identical_within_budget() {
    let typed = serde_json::json!({
        "text": "small",
        "tool": {
            "title": "Bash",
            "status": "completed",
            "rawOutput": { "text": "ok" },
        },
    });
    let encoded = typed.to_string();
    assert!(encoded.len() <= redaction::MAX_CANONICAL_RAW_BYTES);
    let capped = redaction::retain_typed_payload(typed.clone());
    assert_eq!(capped, typed, "预算内必须逐字节不变（含键序与标量）");
    assert_eq!(capped.to_string(), encoded);
}

#[test]
fn typed_payload_cap_lands_within_budget_keeping_structure_and_scalars() {
    let typed = serde_json::json!({
        "text": "y".repeat(200_000),
        "count": 7,
        "ratio": 1.5,
        "flag": true,
        "absent": null,
        "tool": {
            "title": "Bash",
            "status": "in_progress",
            "rawOutput": { "text": "z".repeat(300_000), "truncated": false },
            "contentBlocks": [{ "type": "text", "text": "w".repeat(100_000) }],
        },
    });
    let original = typed_bytes(&typed);
    assert!(original > redaction::MAX_CANONICAL_RAW_BYTES);

    let capped = redaction::retain_typed_payload(typed);
    let retained = typed_bytes(&capped);
    assert!(
        retained <= redaction::MAX_CANONICAL_RAW_BYTES,
        "超预算必须落回 64 KiB 内，实测 {retained}"
    );

    // 结构与标量逐字节不动。
    assert_eq!(capped["count"], serde_json::json!(7));
    assert_eq!(capped["ratio"], serde_json::json!(1.5));
    assert_eq!(capped["flag"], serde_json::json!(true));
    assert!(capped["absent"].is_null());
    assert_eq!(capped["tool"]["title"], "Bash");
    assert_eq!(capped["tool"]["status"], "in_progress");
    assert_eq!(capped["tool"]["rawOutput"]["truncated"], false);
    assert_eq!(capped["tool"]["contentBlocks"][0]["type"], "text");
    assert!(
        capped["tool"]["contentBlocks"].as_array().unwrap().len() == 1,
        "数组长度与元素数不变，只收缩叶子"
    );

    // 截断事实可见（与 raw 的 `_pylonTruncated` 同取证口径）。
    let marker = &capped[redaction::TYPED_TRUNCATION_KEY];
    assert_eq!(marker["payloadOriginalBytes"], original as i64);
    assert_eq!(marker["reason"], "read-path-typed-cap");
    assert!(
        marker["trimmedStringLeaves"].as_i64().unwrap() >= 1,
        "至少收缩了一个字符串叶子"
    );
    // 载荷字符串被收缩，标量级字符串不收缩（低于 floor 的标题/状态不在收缩面内）。
    assert!(capped["text"].as_str().unwrap().len() < 200_000);
}

#[test]
fn typed_payload_cap_keeps_utf8_boundaries() {
    let typed = serde_json::json!({
        "text": "中文载荷".repeat(60_000),
        "tool": { "title": "标题", "rawOutput": { "text": "漢字かな".repeat(30_000) } },
    });
    assert!(typed_bytes(&typed) > redaction::MAX_CANONICAL_RAW_BYTES);

    let capped = redaction::retain_typed_payload(typed);
    assert!(
        typed_bytes(&capped) <= redaction::MAX_CANONICAL_RAW_BYTES,
        "多字节载荷同样必须落回预算内"
    );
    let retained = capped["text"].as_str().expect("retained text");
    assert!(
        retained
            .chars()
            .all(|character| "中文载荷".contains(character)),
        "截断必须落在字符边界上，不得从多字节字符中间切开"
    );
    assert_eq!(capped["tool"]["title"], "标题", "短标量字符串不参与收缩");
}

#[tokio::test]
async fn read_exit_cap_shrinks_tool_rows_but_exempts_turn_unit() {
    let service = EventService::in_memory().expect("event service");
    let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
    let owner_key = owner.key().expect("owner key");
    let mut events = vec![
        Arc::new(serde_json::json!({
            "sessionId": "remote-1",
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "text": "hi" },
            }
        })),
        Arc::new(oversized_tool_payload()),
        Arc::new(serde_json::json!({
            "sessionId": "remote-1",
            "update": { "sessionUpdate": "done", "stopReason": "end_turn" },
        })),
    ];
    events.insert(1, events[1].clone());
    service
        .ingest_events(owner, Some("remote-1".to_string()), 5, events)
        .await
        .expect("ingest");

    let stored = service
        .list_events(owner_key.clone(), None, 100, false)
        .await
        .expect("uncapped read")
        .events;
    let capped = service
        .list_events(owner_key, None, 100, true)
        .await
        .expect("capped read")
        .events;
    assert_eq!(stored.len(), capped.len(), "收口不改行数与顺序");

    let mut saw_tool = false;
    let mut saw_unit = false;
    for (before, after) in stored.iter().zip(capped.iter()) {
        assert_eq!(before.sequence, after.sequence);
        assert_eq!(before.event_type, after.event_type);
        assert_eq!(
            before.raw_payload, after.raw_payload,
            "raw 一份都不动（收口只作用于 typed）"
        );
        if before.event_type == "tool.call.started" {
            saw_tool = true;
            assert!(
                typed_bytes(before.typed_payload.as_ref().unwrap())
                    > redaction::MAX_CANONICAL_RAW_BYTES
            );
            assert!(
                typed_bytes(after.typed_payload.as_ref().unwrap())
                    <= redaction::MAX_CANONICAL_RAW_BYTES
            );
        }
        if before.event_type == crate::turn_rollup::TURN_UNIT_EVENT_TYPE {
            saw_unit = true;
            assert!(
                typed_bytes(before.typed_payload.as_ref().unwrap())
                    > redaction::MAX_CANONICAL_RAW_BYTES,
                "单元行的载荷就是整段历史，必须超预算"
            );
            assert_eq!(
                before.typed_payload, after.typed_payload,
                "turn.unit 豁免：单元行是历史正文的唯一副本，收口即丢历史"
            );
        }
        if before.event_type == "user.message" {
            assert_eq!(
                before.typed_payload, after.typed_payload,
                "预算内行逐字节不变"
            );
        }
    }
    assert!(saw_tool && saw_unit, "语料必须同时含工具行与单元行");
}

// ============================================================================
// #376-b：compact 读分页（升序前向游标；页边界落在 delta run 边界上）
// ============================================================================

/// 语料：一个已终结回合（含 10 条 delta run + 工具行）+ 一个进行中回合的尾部 delta run。
fn paged_compact_fixture(repo: &EventRepo, delta: impl Fn(&str) -> serde_json::Value) -> String {
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    for index in 0..10 {
        repo.ingest_kernel_event(kernel_input(delta(&format!("a{index}"))))
            .unwrap();
    }
    repo.ingest_kernel_event(kernel_input(serde_json::json!({
        "update": { "sessionUpdate": "tool_call", "toolCallId": "tool-1", "title": "Read", "kind": "read" }
    })))
    .unwrap();
    repo.ingest_kernel_event(kernel_input(serde_json::json!({
        "update": { "sessionUpdate": "done", "stopReason": "end_turn" }
    })))
    .unwrap();
    for index in 0..7 {
        repo.ingest_kernel_event(kernel_input(delta(&format!("b{index}"))))
            .unwrap();
    }
    owner_key
}

fn compact_delta(text: &str) -> serde_json::Value {
    serde_json::json!({
        "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": text } }
    })
}

/// 逐页走完整库，行集合（事件类型 + sequence + 折叠跨度）与一次性读逐位相同。
#[test]
fn compact_page_walk_equals_one_shot_read() {
    let repo = repo();
    let owner_key = paged_compact_fixture(&repo, compact_delta);
    let one_shot = repo.load_events_compact(&owner_key).unwrap();

    for limit in [1u32, 2, 3, 4, 7] {
        let mut paged: Vec<CanonicalEventRow> = Vec::new();
        let mut cursor: Option<i64> = None;
        let mut pages = 0usize;
        loop {
            let page = repo
                .load_events_compact_page(&owner_key, cursor, limit)
                .expect("page");
            pages += 1;
            // 页长契约：**至少**取到 limit 行（除非 journal 到头），必要时为「页尾 run 收口」
            // 多带一点（上限 = 折叠预算 MAX_FOLDED_CHUNKS + 2）。断言下界，是因为页边界必须
            // 落在 run 边界上——这比「页不超过 limit」重要。
            let page_len = page.events.len();
            let folded_extra = page_len.max(
                page.events
                    .iter()
                    .map(|row| {
                        row.typed_payload
                            .as_ref()
                            .and_then(|typed| typed.get("foldedCount"))
                            .and_then(serde_json::Value::as_i64)
                            .unwrap_or(1)
                    })
                    .sum::<i64>() as usize,
            );
            assert!(
                folded_extra >= usize::try_from(limit).unwrap_or(1).max(1),
                "页至少要覆盖 limit 行的量（limit={limit}, got={folded_extra}）"
            );
            paged.extend(page.events);
            match page.next_after_sequence {
                Some(next) => {
                    assert!(cursor.is_none_or(|current| next > current), "游标必须前进");
                    cursor = Some(next)
                }
                None => break,
            }
            assert!(pages < 200, "limit={limit} 时游标不收敛");
        }
        let shape = |rows: &[CanonicalEventRow]| {
            rows.iter()
                .map(|row| {
                    (
                        row.event_type.clone(),
                        row.sequence,
                        row.rollup_seq_start,
                        row.rollup_seq_end,
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            shape(&paged),
            shape(&one_shot),
            "limit={limit} 时逐页装载必须与一次性读逐位等价"
        );
    }
}

/// 页边界不得切进 delta run 中间：未被单元覆盖的 run 折叠出的跨度必须与一次性读相同
/// （切进 run 中间会让读侧折叠的切点随页边界漂移）。
#[test]
fn compact_page_keeps_delta_runs_whole_across_page_boundaries() {
    let repo = repo();
    let owner_key = paged_compact_fixture(&repo, compact_delta);
    let one_shot = repo.load_events_compact(&owner_key).unwrap();
    let span_of = |row: &CanonicalEventRow| -> Option<(i64, i64)> {
        let typed = row.typed_payload.as_ref()?;
        let span = typed.get("seqSpan")?.as_array()?;
        Some((span.first()?.as_i64()?, span.get(1)?.as_i64()?))
    };
    let one_shot_spans: Vec<_> = one_shot.iter().filter_map(span_of).collect();
    assert_eq!(one_shot_spans.len(), 1, "语料只有一个未覆盖 delta run");
    assert_eq!(
        one_shot_spans[0],
        (14, 20),
        "run span 覆盖 7 条尾部 delta（终态单元占 seq 13）"
    );

    // limit=3 必然落在 run 内部；折叠切点仍须与一次性读一致。
    let mut spans: Vec<(i64, i64)> = Vec::new();
    let mut cursor: Option<i64> = None;
    loop {
        let page = repo
            .load_events_compact_page(&owner_key, cursor, 3)
            .expect("page");
        spans.extend(page.events.iter().filter_map(span_of));
        match page.next_after_sequence {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(spans, one_shot_spans, "页边界不得把 run 切碎");
}

/// 分页读同样只在 service 层收口 typed 载荷（单元行仍豁免）。
#[tokio::test]
async fn compact_page_caps_tool_rows_and_exempts_unit_rows() {
    let service = EventService::in_memory().expect("event service");
    let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
    let owner_key = owner.key().unwrap();
    let mut events = vec![
        Arc::new(serde_json::json!({
            "sessionId": "remote-1",
            "update": { "sessionUpdate": "user_message_chunk", "content": { "text": "hi" } },
        })),
        Arc::new(oversized_tool_payload()),
        Arc::new(serde_json::json!({
            "sessionId": "remote-1",
            "update": { "sessionUpdate": "done", "stopReason": "end_turn" },
        })),
    ];
    events.insert(1, events[1].clone());
    service
        .ingest_events(owner, Some("remote-1".to_string()), 5, events)
        .await
        .expect("ingest");

    let mut capped: Vec<CanonicalEventRow> = Vec::new();
    let mut cursor: Option<i64> = None;
    loop {
        let page = service
            .load_events_compact_page(owner_key.clone(), cursor, 1, true)
            .await
            .expect("capped page");
        capped.extend(page.events);
        match page.next_after_sequence {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    let unit = capped
        .iter()
        .find(|row| row.event_type == crate::turn_rollup::TURN_UNIT_EVENT_TYPE)
        .expect("turn.unit row");
    assert!(
        typed_bytes(unit.typed_payload.as_ref().unwrap()) > redaction::MAX_CANONICAL_RAW_BYTES,
        "单元行是历史正文的唯一副本，分页收口同样必须豁免它"
    );
    assert!(
        capped
            .iter()
            .filter(|row| row.event_type != crate::turn_rollup::TURN_UNIT_EVENT_TYPE)
            .all(|row| typed_bytes(
                row.typed_payload
                    .as_ref()
                    .unwrap_or(&serde_json::Value::Null)
            ) <= redaction::MAX_CANONICAL_RAW_BYTES),
        "非单元行必须落回 64 KiB 内（limit=1 逐行走完每一页）"
    );
}

// ============================================================================
// #376-b 评审回归：游标落在长覆盖区前时不得静默截断；覆盖区不得把 run 切断
// ============================================================================

/// 语料：一个已终结回合把 **3900 行**（远超 `limit=64` 的扫描预算 64*8+1024=1536）覆盖掉，
/// 单元行落在这段之后。游标从最前面出发时，第一页的扫描预算会在覆盖区里用尽、一行都不产出。
fn long_covered_stretch_fixture(repo: &EventRepo) -> String {
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    for index in 0..3900 {
        repo.ingest_kernel_event(kernel_input(compact_delta(&format!("c{index}"))))
            .unwrap();
    }
    repo.ingest_kernel_event(kernel_input(serde_json::json!({
        "update": { "sessionUpdate": "done", "stopReason": "end_turn" }
    })))
    .unwrap();
    owner_key
}

/// 评审发现：`collect_until` 的扫描预算被**被覆盖行**吃光 ⇒ 空页 + `next_after_sequence=None`
/// ⇒ 前端与 repo 的循环都判定「到底」而停住，整段历史静默丢失（标志性会话形状：单元覆盖
/// 数千行）。本用例断言逐页走完必须与一次性读逐位等价，且游标永不返回 None 到中途。
#[test]
fn compact_page_walk_survives_scan_budget_exhausted_by_covered_rows() {
    let repo = repo();
    let owner_key = long_covered_stretch_fixture(&repo);
    let one_shot = repo.load_events_compact(&owner_key).unwrap();
    assert_eq!(one_shot.len(), 1, "语料只有一个单元行可见");
    assert_eq!(
        one_shot[0].event_type,
        crate::turn_rollup::TURN_UNIT_EVENT_TYPE
    );

    let mut paged: Vec<CanonicalEventRow> = Vec::new();
    let mut cursor: Option<i64> = None;
    let mut pages = 0usize;
    loop {
        let page = repo
            .load_events_compact_page(&owner_key, cursor, 64)
            .expect("page");
        pages += 1;
        paged.extend(page.events);
        match page.next_after_sequence {
            Some(next) => {
                assert!(
                    cursor.is_none_or(|current| next > current),
                    "游标必须前进（page {pages}）"
                );
                cursor = Some(next)
            }
            None => break,
        }
        assert!(
            pages < 100,
            "游标不收敛：覆盖区前被卡住（{pages} 页仍未到头）"
        );
    }
    let shape = |rows: &[CanonicalEventRow]| {
        rows.iter()
            .map(|row| (row.event_type.clone(), row.sequence))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        shape(&paged),
        shape(&one_shot),
        "扫描预算被覆盖行用尽时不得丢行（评审 BLOCKER 回归）"
    );
}

/// 评审发现：扫描预算用尽会连带切断 run（paged 折出两条 batch 行，一次性折出一条）。
/// 语料刻意让「覆盖区 + 未覆盖 run」跨过预算边界。
#[test]
fn compact_page_keeps_run_whole_when_budget_exhausts_before_it() {
    let repo = repo();
    let owner_key = long_covered_stretch_fixture(&repo);
    let tail: Vec<_> = (0..400)
        .map(|index| compact_delta(&format!("t{index}")))
        .collect();
    for wire in tail {
        repo.ingest_kernel_event(kernel_input(wire)).unwrap();
    }
    let one_shot = repo.load_events_compact(&owner_key).unwrap();
    let span_of = |row: &CanonicalEventRow| -> Option<(i64, i64)> {
        let typed = row.typed_payload.as_ref()?;
        let span = typed.get("seqSpan")?.as_array()?;
        Some((span.first()?.as_i64()?, span.get(1)?.as_i64()?))
    };
    let one_shot_spans: Vec<_> = one_shot.iter().filter_map(span_of).collect();
    assert_eq!(one_shot_spans.len(), 1, "尾部 400 行应折成一条 batch 行");

    let mut spans: Vec<(i64, i64)> = Vec::new();
    let mut cursor: Option<i64> = None;
    loop {
        let page = repo
            .load_events_compact_page(&owner_key, cursor, 64)
            .expect("page");
        spans.extend(page.events.iter().filter_map(span_of));
        match page.next_after_sequence {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(spans, one_shot_spans, "覆盖区之后的 run 不得被页边界切断");
}

/// 评审发现（#376-a）：`retain_typed_payload` 的 ≤64 KiB 保证在「把所有字符串清空也减不够」
/// 时会漏——超预算的部分在键名与结构本身。收不动必须整体退回 `retain_raw_payload`。
#[test]
fn typed_payload_cap_holds_when_structure_alone_exceeds_budget() {
    let huge_key = "k".repeat(80_000);
    let typed = serde_json::json!({ (huge_key): "x" });
    assert!(typed_bytes(&typed) > redaction::MAX_CANONICAL_RAW_BYTES);
    let capped = redaction::retain_typed_payload(typed);
    assert!(
        typed_bytes(&capped) <= redaction::MAX_CANONICAL_RAW_BYTES,
        "键名撑爆预算时必须整体退回截断，实测 {}",
        typed_bytes(&capped)
    );

    // 结构（大量小对象）自己就超预算、字符串只有几 KB
    let mut object = serde_json::Map::new();
    for index in 0..30_000 {
        object.insert(
            format!("n{index}"),
            serde_json::json!({ "a": index, "b": index }),
        );
    }
    object.insert("text".to_string(), serde_json::json!("y".repeat(5_000)));
    let typed = serde_json::Value::Object(object);
    assert!(typed_bytes(&typed) > redaction::MAX_CANONICAL_RAW_BYTES);
    let capped = redaction::retain_typed_payload(typed);
    assert!(
        typed_bytes(&capped) <= redaction::MAX_CANONICAL_RAW_BYTES,
        "结构撑爆预算时必须整体退回截断，实测 {}",
        typed_bytes(&capped)
    );
}

/// 评审发现：#4 的预览按字符切 ⇒ 非 ASCII 载荷「保留值 ≤ 64 KiB」失效。收口的两条退回支路
/// 都经过 `retain_raw_payload`，故这里一并钉住多字节形状。
#[test]
fn payload_retention_holds_for_multibyte_payloads() {
    let typed = serde_json::json!({ "text": "中".repeat(70_000) });
    let capped = redaction::retain_typed_payload(typed);
    assert!(
        typed_bytes(&capped) <= redaction::MAX_CANONICAL_RAW_BYTES,
        "多字节 typed 载荷收口后必须 ≤ 64 KiB，实测 {}",
        typed_bytes(&capped)
    );
    let oversized_raw = serde_json::json!({ "text": "中".repeat(70_000) });
    let (retained, encoded, truncated, ..) = redaction::retain_raw_payload(oversized_raw);
    assert!(truncated);
    assert!(
        encoded.len() <= redaction::MAX_CANONICAL_RAW_BYTES
            && typed_bytes(&retained) <= redaction::MAX_CANONICAL_RAW_BYTES,
        "raw 保留值必须按字节 ≤ 64 KiB（原实现按字符切 ⇒ 汉字放大 3×），实测 {}",
        encoded.len()
    );
}

/// #380-b：L3 裁剪必须按**单元自己记录的方案**重折。
///
/// 方案 v2 起，同一批累积式工具拍在 v1 下折不出 `tool-run`（字节不同）——若裁剪一律用当前
/// 方案重折，v1 单元会永远 `ShaMismatch`（保留行、永久跳过 ⇒ 迁移停摆）。这条用例锁两件事：
/// ①记 v1 + 按 v1 算的 sha ⇒ 正常裁剪；②记 v1 却拿着 v2 的 sha ⇒ mismatch 保行（不误删）。
#[test]
fn rollup_trim_refolds_with_the_scheme_recorded_on_the_unit() {
    let repo = repo();
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    let tool_beat = |sequence: i64, text: &str| {
        parse_canonical_event(&event_json(
            "peri",
            "local:s1",
            sequence,
            "tool.call.updated",
            serde_json::json!({ "update": { "sessionUpdate": "tool_call_update", "toolCallId": "call-1",
                "content": [{ "type": "text", "text": text }] } }),
        ))
        .unwrap()
    };
    let rows = vec![
        tool_beat(1, "aaa"),
        tool_beat(2, "aaaaaa"),
        parse_canonical_event(&event_json(
            "peri",
            "local:s1",
            3,
            "turn.completed",
            serde_json::json!({ "update": { "sessionUpdate": "done" } }),
        ))
        .unwrap(),
    ];
    repo.append_events(&rows, None).unwrap();

    let v1 = crate::turn_rollup::fold_turn_rows_with_scheme(&rows, Some("adjacent-delta-fold-v1"));
    let v2 = crate::turn_rollup::fold_turn_rows_with_scheme(&rows, Some("adjacent-delta-fold-v2"));
    assert_ne!(
        v1.content_sha256, v2.content_sha256,
        "该语料在两个方案下必须折出不同字节"
    );

    let unit_row = |sequence: i64, sha: &str, segments: serde_json::Value| {
        let mut unit_value = event_json(
            "peri",
            "local:s1",
            sequence,
            "turn.unit",
            serde_json::json!({ "kind": "turn-unit" }),
        );
        unit_value["typedPayload"] = serde_json::json!({
            "aggregateKind": "turn-rollup",
            "seqStart": 1,
            "seqEnd": 3,
            "foldedCount": 3,
            "foldScheme": "adjacent-delta-fold-v1",
            "contentSha256": sha,
            "terminal": { "eventType": "turn.completed", "occurredAt": "2026-08-14T00:00:00.000Z" },
            "segments": segments,
        });
        parse_canonical_event(&unit_value).unwrap()
    };

    // ②记 v1 但 sha 来自 v2 ⇒ 不匹配，保行（证明不是「认识 v1 就无脑放行」）
    repo.append_events(
        &[unit_row(4, v2.content_sha256.as_str(), v2.segments.clone())],
        Some(3),
    )
    .unwrap();
    let mismatched = repo.rollup_trim(None).unwrap();
    assert_eq!(mismatched.mismatch_units, 1, "方案与 sha 不符必须保行");

    // ①记 v1 且 sha 按 v1 算 ⇒ 按记录的方案重折通过，行被裁剪
    repo.append_events(
        &[unit_row(5, v1.content_sha256.as_str(), v1.segments.clone())],
        Some(4),
    )
    .unwrap();
    let report = repo.rollup_trim(None).unwrap();
    assert_eq!(report.trimmed_units, 1, "v1 单元按 v1 重折必须通过并裁剪");
    let remaining = repo.list_events(&owner_key, None, 100).unwrap();
    let plain_rows = remaining
        .events
        .iter()
        .filter(|e| e.event_type != "turn.unit")
        .count();
    assert_eq!(plain_rows, 0, "覆盖行已删除");
}

// ---- #442 Step1：turnBoundary journal 探测（tail 行投影 + 判据组合）----

fn user_chunk(text: &str) -> serde_json::Value {
    serde_json::json!({
        "update": { "sessionUpdate": "user_message_chunk", "content": { "text": text } }
    })
}

fn done_update() -> serde_json::Value {
    serde_json::json!({ "update": { "sessionUpdate": "done" } })
}

#[test]
fn turn_boundary_rows_keep_only_boundary_kinds_in_ascending_order() {
    let repo = repo();
    repo.ingest_kernel_events(vec![
        kernel_input(user_chunk("hi")),
        kernel_input(done_update()),
        kernel_input(user_chunk("second")),
    ])
    .expect("batch ingest");
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();

    let rows = repo
        .turn_boundary_rows(&owner_key, 512)
        .expect("boundary rows");
    let kinds: Vec<(i64, &str)> = rows
        .iter()
        .map(|r| (r.sequence, r.event_type.as_str()))
        .collect();
    // 只含判据四类型（user.message / turn.completed / turn.unit），升序；
    // 时间戳列随行返回（span 扫描的输入）。
    assert_eq!(
        kinds,
        vec![
            (1, "user.message"),
            (2, "turn.completed"),
            (3, "turn.unit"),
            (4, "user.message"),
        ]
    );
    assert!(rows
        .iter()
        .all(|r| r.occurred_at.is_some() && r.received_at.is_some()));
}

#[test]
fn journal_turn_boundary_open_when_latest_boundary_is_anchor() {
    let repo = repo();
    repo.ingest_kernel_events(vec![
        kernel_input(user_chunk("hi")),
        kernel_input(done_update()),
        kernel_input(user_chunk("second")),
    ])
    .expect("batch ingest");
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    let rows = repo.turn_boundary_rows(&owner_key, 512).unwrap();
    let boundary = crate::turn_boundary::derive_turn_boundary(&rows).unwrap();
    assert_eq!(boundary.kind, crate::turn_boundary::TurnBoundaryKind::Open);
    assert!(
        boundary.started_at_ms.is_some(),
        "open 回合必须给出当前起点"
    );
    assert_eq!(boundary.ended_at_ms, None);
}

#[test]
fn journal_turn_boundary_terminal_when_journal_ends_on_terminal_row() {
    let repo = repo();
    repo.ingest_kernel_events(vec![
        kernel_input(user_chunk("hi")),
        kernel_input(done_update()),
    ])
    .expect("batch ingest");
    let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
    let rows = repo.turn_boundary_rows(&owner_key, 512).unwrap();
    let boundary = crate::turn_boundary::derive_turn_boundary(&rows).unwrap();
    assert_eq!(
        boundary.kind,
        crate::turn_boundary::TurnBoundaryKind::Terminal
    );
    assert!(boundary.started_at_ms.is_some());
    assert!(boundary.ended_at_ms.is_some());
}

#[test]
fn journal_turn_boundary_unknown_on_empty_journal() {
    let repo = repo();
    let owner_key = serde_json::to_string(&["p1", "ghost", "local:none"]).unwrap();
    let rows = repo.turn_boundary_rows(&owner_key, 512).unwrap();
    assert!(rows.is_empty());
    let boundary = crate::turn_boundary::derive_turn_boundary(&rows).unwrap();
    assert_eq!(
        boundary.kind,
        crate::turn_boundary::TurnBoundaryKind::Unknown
    );
}

// ── #364：外部 CLI 历史导入（external-import provenance + 幂等 + 分叉） ──────

mod external_history_import {
    use super::*;
    use crate::event_repo::service::EventService;

    fn external_owner(suffix: &str) -> DurableSessionOwner {
        DurableSessionOwner::new(
            "external-import",
            "claude-code",
            format!("claude-code:abc-123{suffix}"),
        )
    }

    fn external_events() -> Vec<(String, std::sync::Arc<serde_json::Value>)> {
        vec![
            (
                "2026-10-01T10:00:00.000Z".to_string(),
                std::sync::Arc::new(serde_json::json!({
                    "update": { "sessionUpdate": "user_message_chunk", "content": { "text": "帮我看看这个仓库" } }
                })),
            ),
            (
                "2026-10-01T10:00:05.000Z".to_string(),
                std::sync::Arc::new(serde_json::json!({
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "好的，先看结构。" } }
                })),
            ),
            (
                "2026-10-01T10:00:09.000Z".to_string(),
                std::sync::Arc::new(serde_json::json!({
                    "update": { "sessionUpdate": "done", "stopReason": "end_turn", "model": "claude-sonnet-4" }
                })),
            ),
        ]
    }

    #[tokio::test]
    async fn external_import_lands_unverified_provenance_and_source_timestamps() {
        let service = EventService::in_memory().unwrap();
        let owner = external_owner("");
        let result = service
            .ingest_external_history(
                owner.clone(),
                "abc-123".to_string(),
                false,
                external_events(),
            )
            .await
            .unwrap();
        assert_eq!(result.status, "imported");
        assert_eq!(result.events.len(), 3);
        assert_eq!(result.revision, 3);

        let owner_key = owner.key().unwrap();
        let page = service
            .list_events(owner_key, None, 10, false)
            .await
            .unwrap();
        for event in &page.events {
            assert_eq!(event.provenance_origin, "external-import");
            assert_eq!(event.provenance_trust, "unverified");
            assert_eq!(event.provenance_provider.as_deref(), Some("claude-code"));
            assert_eq!(
                event.provenance_import_id.as_deref(),
                Some("claude-code:abc-123")
            );
        }
        // occurred_at 保留源时间戳；received_at 是导入时刻（二者不同源）。
        assert_eq!(page.events[0].occurred_at, "2026-10-01T10:00:00.000Z");
        assert_ne!(page.events[0].received_at, "2026-10-01T10:00:00.000Z");
        // external-import 行不构成 local authority（replay 覆盖判定不受影响）。
        assert!(!service
            .has_authoritative_local_events(owner.key().unwrap())
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn external_import_is_idempotent_per_agent_and_remote_id() {
        let service = EventService::in_memory().unwrap();
        let owner = external_owner("");
        let first = service
            .ingest_external_history(owner.clone(), "abc-123".to_string(), false, external_events())
            .await
            .unwrap();
        assert_eq!(first.status, "imported");

        // 同 (agent_id, remote_session_id) 二次导入：0 写入，journal 不变。
        let second = service
            .ingest_external_history(owner, "abc-123".to_string(), false, external_events())
            .await
            .unwrap();
        assert_eq!(second.status, "already-imported");
        assert!(second.events.is_empty());
        assert_eq!(
            service
                .revision(serde_json::to_string(&["external-import", "claude-code", "claude-code:abc-123"]).unwrap())
                .await
                .unwrap(),
            3
        );
    }

    #[tokio::test]
    async fn external_import_force_fork_lands_a_new_owner_journal() {
        // force 分叉由调用方生成 #N 后缀的新 local_session_id（issue #364 裁决），
        // service 层只按普通导入落库——新 owner_key ⇒ 空 journal。
        let service = EventService::in_memory().unwrap();
        let first = service
            .ingest_external_history(external_owner(""), "abc-123".to_string(), false, external_events())
            .await
            .unwrap();
        assert_eq!(first.status, "imported");

        let fork = service
            .ingest_external_history(external_owner("#2"), "abc-123".to_string(), true, external_events())
            .await
            .unwrap();
        assert_eq!(fork.status, "imported");
        assert_eq!(fork.revision, 3);
        // 两条 journal 并存：快照原样封存，分叉是新副本。
        for suffix in ["", "#2"] {
            let key = serde_json::to_string(&[
                "external-import",
                "claude-code",
                &format!("claude-code:abc-123{suffix}"),
            ])
            .unwrap();
            assert_eq!(service.revision(key).await.unwrap(), 3);
        }
    }

    #[test]
    fn parse_canonical_event_accepts_external_import_only_as_unverified() {
        let mut event = event_json("peri", "local:s1", 1, "user.message", serde_json::json!({"update": {}}));
        event["provenance"] = serde_json::json!({
            "origin": "external-import", "trust": "unverified"
        });
        let parsed = parse_canonical_event(&event).expect("external-import/unverified 合法");
        assert_eq!(parsed.provenance_origin, "external-import");
        assert_eq!(parsed.provenance_trust, "unverified");

        event["provenance"] = serde_json::json!({
            "origin": "external-import", "trust": "authoritative"
        });
        assert!(
            parse_canonical_event(&event).is_err(),
            "external-import 永不为 authoritative（不变式拒绝）"
        );
    }

    #[test]
    fn provenance_code_round_trips_external_import_as_five() {
        // 整数编码 5 的双向钉死（列不落 wire，编码漂移即历史行误读）。
        assert_eq!(
            super::super::provenance::provenance_code("external-import", "unverified"),
            5
        );
        let (origin, trust, provider, import_id) =
            super::super::provenance::provenance_parts(5, "claude-code", "claude-code:abc");
        assert_eq!(origin, "external-import");
        assert_eq!(trust, "unverified");
        assert_eq!(provider.as_deref(), Some("claude-code"));
        assert_eq!(import_id.as_deref(), Some("claude-code:abc"));
    }
}
