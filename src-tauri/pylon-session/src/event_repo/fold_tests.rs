use super::*;

fn repo() -> EventRepo {
    EventRepo::open_in_memory().expect("open in-memory")
}

fn owner() -> DurableSessionOwner {
    DurableSessionOwner::new("p1", "peri", "local:s1")
}

fn owner_key() -> String {
    owner().key().expect("owner key")
}

fn thinking(text: &str) -> KernelEventInput {
    KernelEventInput {
        owner: owner(),
        remote_session_id: Some("remote-1".to_string()),
        client_generation: 1,
        received_at: "2026-09-20T00:00:00.000Z".to_string(),
        occurred_at: None,
        raw_payload: std::sync::Arc::new(serde_json::json!({
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "messageId": "thought-1",
                "content": { "type": "text", "text": text }
            }
        })),
        import_origin: super::row::EventImportOrigin::Live,
    }
}

/// ADR-0016 / #155 T3-1：同一窗口内的相邻同类 delta 折成**一行**，跨度占位。
#[test]
fn kernel_batch_ingest_folds_adjacent_deltas_into_one_span_row() {
    let repo = repo();
    let result = repo
        .ingest_kernel_events(vec![thinking("甲"), thinking("乙"), thinking("丙")])
        .expect("ingest");

    assert_eq!(result.events.len(), 1, "三条相邻同类 delta 折成一行");
    let row = &result.events[0];
    assert_eq!(row.event_type, "assistant.thinking.delta.batch");
    assert_eq!(row.sequence, 3, "跨度占位：行落在跨度末位");
    assert_eq!(result.revision, 3, "revision = max sequence，编号不重排");
    assert_eq!(
        row.typed_payload.as_ref().unwrap()["seqSpan"],
        serde_json::json!([1, 3])
    );
    assert_eq!(row.typed_payload.as_ref().unwrap()["foldedCount"], 3);
    assert_eq!(row.typed_payload.as_ref().unwrap()["text"], "甲乙丙");
    assert_eq!(row_input_span_width(row), 3, "承载三个输入");

    // span 中间的编号没有行（ADR-0016 明确允许的空洞）
    let compact = repo.load_events_compact(&owner_key()).expect("compact");
    assert_eq!(compact.len(), 1);
    assert_eq!(compact[0].sequence, 3);
}

/// 非 delta 行与 identity 变化都不得被并进同一行。
#[test]
fn kernel_batch_ingest_does_not_fold_across_boundaries() {
    let repo = repo();
    let identified = |text: &str, message_id: &str| KernelEventInput {
        owner: owner(),
        remote_session_id: Some("remote-1".to_string()),
        client_generation: 1,
        received_at: "2026-09-20T00:00:00.000Z".to_string(),
        occurred_at: None,
        raw_payload: std::sync::Arc::new(serde_json::json!({
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "messageId": message_id,
                "content": { "type": "text", "text": text }
            }
        })),
        import_origin: super::row::EventImportOrigin::Live,
    };
    let tool = KernelEventInput {
        owner: owner(),
        remote_session_id: Some("remote-1".to_string()),
        client_generation: 1,
        received_at: "2026-09-20T00:00:00.000Z".to_string(),
        occurred_at: None,
        raw_payload: std::sync::Arc::new(serde_json::json!({
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed" }
        })),
        import_origin: super::row::EventImportOrigin::Live,
    };

    let result = repo
        .ingest_kernel_events(vec![
            thinking("甲"),
            thinking("乙"),
            tool,
            identified("丙", "m2"),
            identified("丁", "m2"),
        ])
        .expect("ingest");

    assert_eq!(
        result.events.len(),
        3,
        "三类各成一行：span 行 + 工具行 + 另一个 span 行"
    );
    assert_eq!(
        result.events[0].event_type,
        "assistant.thinking.delta.batch"
    );
    assert_eq!(result.events[0].sequence, 2);
    assert_eq!(result.events[1].event_type, "tool.call.completed");
    assert_eq!(result.events[1].sequence, 3);
    assert_eq!(
        result.events[2].event_type,
        "assistant.thinking.delta.batch"
    );
    assert_eq!(result.events[2].sequence, 5);
    assert_eq!(result.revision, 5);
    assert_eq!(row_input_span_width(&result.events[1]), 1);
}

/// 窗口边界处 run 断开（每行自带跨度，跨窗口拆行不改变投影）。
#[test]
fn kernel_batch_ingest_folds_per_window_only() {
    let repo = repo();
    let first = repo
        .ingest_kernel_events(vec![thinking("甲"), thinking("乙")])
        .expect("w1");
    let second = repo
        .ingest_kernel_events(vec![thinking("丙"), thinking("丁")])
        .expect("w2");

    assert_eq!(first.events.len(), 1);
    assert_eq!(first.events[0].sequence, 2);
    assert_eq!(second.events.len(), 1);
    assert_eq!(second.events[0].sequence, 4);
    assert_eq!(
        second.events[0].typed_payload.as_ref().unwrap()["seqSpan"],
        serde_json::json!([3, 4])
    );
    assert_eq!(
        repo.load_events_compact(&owner_key())
            .expect("compact")
            .len(),
        2
    );
}

/// 终态行不被并入，且同一事务里仍能按库内行构建 turn.unit（含聚合行输入）。
#[test]
fn kernel_batch_ingest_terminal_still_builds_turn_unit() {
    let repo = repo();
    let done = KernelEventInput {
        owner: owner(),
        remote_session_id: Some("remote-1".to_string()),
        client_generation: 1,
        received_at: "2026-09-20T00:00:00.000Z".to_string(),
        occurred_at: None,
        raw_payload: std::sync::Arc::new(
            serde_json::json!({ "update": { "sessionUpdate": "done" } }),
        ),
        import_origin: super::row::EventImportOrigin::Live,
    };
    let result = repo
        .ingest_kernel_events(vec![thinking("甲"), thinking("乙"), done])
        .expect("ingest");

    assert_eq!(result.events.len(), 3, "span row + terminal + unit");
    assert_eq!(
        result.events[0].event_type,
        "assistant.thinking.delta.batch"
    );
    assert_eq!(result.events[0].sequence, 2);
    assert_eq!(result.events[1].event_type, "turn.completed");
    assert_eq!(result.events[1].sequence, 3);
    assert_eq!(result.events[2].event_type, "turn.unit");
    assert_eq!(
        result.revision, 4,
        "unit 在同事务内多占一个 sequence 并计入 revision"
    );
    let units = repo
        .latest_event_of_type(&owner_key(), "turn.unit")
        .expect("query")
        .expect("unit row");
    assert_eq!(
        units.sequence, result.revision,
        "单元行是本批最后写入的一行（revision 含单元）"
    );
    assert_eq!(
        repo.load_events_compact(&owner_key())
            .expect("compact")
            .len(),
        1
    );
}
