//! #155 T3 在途片段：独立于 canonical 历史的追加式暂存与恢复。
//!
//! 只保存已完成凭据脱敏的 raw。读取方不得把本表混入 evt_* 历史；正式 batch
//! 追加与对应片段删除由 ingest 的同一 transaction 完成（ADR-0027）。

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

use super::fold::{foldable_delta_base, raw_payload_bytes, MAX_FOLD_BYTES};
use super::normalize::{normalize_kernel_event, now_millis};
use super::redaction::redact_journal_credentials;
use super::repo::{EventRepo, TOMBSTONE_STATE_SQL};
use super::row::EventAppendResult;
use super::row::KernelEventInput;
use super::EventError;
use crate::owner::DurableSessionOwner;

#[derive(Debug, Clone)]
pub struct DraftFragmentInput {
    pub owner: DurableSessionOwner,
    pub draft_id: String,
    pub fragment_index: i64,
    pub client_generation: i64,
    pub remote_session_id: Option<String>,
    pub event_type: String,
    pub identity: Option<Value>,
    pub raw_payload: Vec<Value>,
    pub first_received_at: String,
}

#[derive(Debug, Clone)]
pub struct DraftCommitChunk {
    /// 与 #334 P2 的 payload Arc 共享一致：dispatcher 侧从在途批次零拷贝携带，
    /// 提交事务内仍按原样脱敏/写入。
    pub raw_payload: Arc<Value>,
    pub received_at: String,
}

#[derive(Debug, Clone)]
pub struct DraftCandidate {
    pub event_type: String,
    pub identity: Option<Value>,
    pub raw_bytes: usize,
}

/// 与正式写侧共用 normalize/fold 判据，避免 dispatcher 另写一套身份或预算规则。
/// 入参沿用 #334 P2 的 Arc 共享——调用方从在途批次零拷贝传入。
pub fn draft_candidate(owner: &DurableSessionOwner, raw: Arc<Value>) -> Option<DraftCandidate> {
    let row = normalize_kernel_event(
        KernelEventInput {
            owner: owner.clone(),
            remote_session_id: None,
            client_generation: 0,
            received_at: String::new(),
            occurred_at: None,
            raw_payload: raw,
            import_origin: super::row::EventImportOrigin::Live,
        },
        1,
    )
    .ok()?;
    foldable_delta_base(&row)?;
    let raw_bytes = raw_payload_bytes(&row);
    (raw_bytes + 2 <= MAX_FOLD_BYTES).then(|| DraftCandidate {
        event_type: row.event_type,
        identity: row.identity,
        raw_bytes,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftFragment {
    pub owner_key: String,
    pub draft_id: String,
    pub fragment_index: i64,
    pub client_generation: i64,
    pub remote_session_id: Option<String>,
    pub event_type: String,
    pub identity: Option<Value>,
    pub raw_payload: Vec<Value>,
    pub first_received_at: String,
    pub created_at: i64,
    /// Process-local status supplied by EventService. Stored fragments from a
    /// previous process default to interrupted; active runs are marked false.
    pub interrupted: bool,
}

fn decode_fragment(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(DraftFragment, String, Option<String>)> {
    let owner_key: String = row.get(0)?;
    let draft_id: String = row.get(1)?;
    let fragment_index: i64 = row.get(2)?;
    let client_generation: i64 = row.get(3)?;
    let remote_session_id: Option<String> = row.get(4)?;
    let event_type: String = row.get(5)?;
    let identity_json: Option<String> = row.get(6)?;
    let raw_json: String = row.get(7)?;
    let first_received_at: String = row.get(8)?;
    let created_at: i64 = row.get(9)?;
    // JSON 解码错误通过后续显式 Corrupt 转换传出；rusqlite 的列转换错误
    // 会掩盖片段身份，因此这里保留原文交给 decode_stored_fragment。
    Ok((
        DraftFragment {
            owner_key,
            draft_id,
            fragment_index,
            client_generation,
            remote_session_id,
            event_type,
            identity: None,
            raw_payload: Vec::new(),
            first_received_at,
            created_at,
            interrupted: true,
        },
        raw_json,
        identity_json,
    ))
}

fn decode_stored_fragment(
    (mut fragment, raw_json, identity_json): (DraftFragment, String, Option<String>),
) -> Result<DraftFragment, EventError> {
    let key = format!(
        "{}:{}:{}",
        fragment.owner_key, fragment.draft_id, fragment.fragment_index
    );
    fragment.raw_payload = serde_json::from_str(&raw_json).map_err(|error| {
        EventError::Corrupt(format!("draft={key} raw_payload invalid JSON: {error}"))
    })?;
    fragment.identity = identity_json
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                EventError::Corrupt(format!("draft={key} identity invalid JSON: {error}"))
            })
        })
        .transpose()?;
    Ok(fragment)
}

/// 正式收口前校验已落盘片段恰为输入前缀。否则删除片段会把未提交内容静默丢掉。
pub(super) fn verify_draft_commit_prefix(
    tx: &rusqlite::Transaction<'_>,
    owner_key: &str,
    draft_id: &str,
    inputs: &[KernelEventInput],
) -> Result<(), EventError> {
    let mut stmt = tx
        .prepare_cached(
            "SELECT owner_key, draft_id, fragment_index, client_generation,
                    remote_session_id, event_type, identity, raw_payload,
                    first_received_at, created_at
             FROM canonical_draft_fragments
             WHERE owner_key = ?1 AND draft_id = ?2 ORDER BY fragment_index",
        )
        .map_err(EventError::from)?;
    let rows = stmt
        .query_map(params![owner_key, draft_id], decode_fragment)
        .map_err(EventError::from)?;
    let mut offset = 0;
    let mut fragments = 0;
    for row in rows {
        let fragment = decode_stored_fragment(row.map_err(EventError::from)?)?;
        if fragment.fragment_index != fragments {
            return Err(EventError::Corrupt(
                "draft fragment indices are not contiguous".into(),
            ));
        }
        fragments += 1;
        for raw in fragment.raw_payload {
            let Some(input) = inputs.get(offset) else {
                return Err(EventError::Invalid(
                    "draft commit omits stored chunks".into(),
                ));
            };
            if fragment.client_generation != input.client_generation
                || fragment.remote_session_id != input.remote_session_id
                || redact_journal_credentials((*input.raw_payload).clone(), false) != raw
            {
                return Err(EventError::Invalid(format!(
                    "draft commit prefix diverges at chunk {offset}"
                )));
            }
            offset += 1;
        }
    }
    if fragments == 0 || offset == 0 {
        return Err(EventError::Invalid(
            "draft commit requires stored fragments".into(),
        ));
    }
    Ok(())
}

impl EventRepo {
    /// 用户确认把重启后的残留片段保留为正式历史；仍走同一个 ingest/fold 事务。
    pub fn keep_interrupted_draft(
        &self,
        owner_key: &str,
        draft_id: &str,
    ) -> Result<EventAppendResult, EventError> {
        let fragments = self.list_draft_fragments(owner_key)?;
        let fragments = fragments
            .into_iter()
            .filter(|row| row.draft_id == draft_id)
            .collect::<Vec<_>>();
        if fragments.is_empty() {
            return Err(EventError::Invalid("draft not found".into()));
        }
        let parts: Vec<String> = serde_json::from_str(owner_key)
            .map_err(|_| EventError::Invalid("owner_key invalid".into()))?;
        if parts.len() != 3 {
            return Err(EventError::Invalid(
                "owner_key must contain three fields".into(),
            ));
        }
        let owner = DurableSessionOwner::new(&parts[0], &parts[1], &parts[2]);
        let mut inputs = Vec::new();
        for fragment in fragments {
            for raw_payload in fragment.raw_payload {
                inputs.push(KernelEventInput {
                    owner: owner.clone(),
                    remote_session_id: fragment.remote_session_id.clone(),
                    client_generation: fragment.client_generation,
                    received_at: fragment.first_received_at.clone(),
                    occurred_at: None,
                    raw_payload: Arc::new(raw_payload),
                    import_origin: super::row::EventImportOrigin::Live,
                });
            }
        }
        self.commit_draft_events(inputs, draft_id)
    }

    /// 用户丢弃中断片段；仅清除指定 owner/run，不碰正式历史。
    pub fn discard_interrupted_draft(
        &self,
        owner_key: &str,
        draft_id: &str,
    ) -> Result<bool, EventError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let removed = tx
            .execute(
                "DELETE FROM canonical_draft_fragments WHERE owner_key = ?1 AND draft_id = ?2",
                params![owner_key, draft_id],
            )
            .map_err(EventError::from)?;
        tx.commit().map_err(EventError::from)?;
        Ok(removed > 0)
    }

    /// 一次持久化一个增量片段；同 index 同内容重试幂等，乱序或改写既存片段拒绝。
    pub fn append_draft_fragment(
        &self,
        input: DraftFragmentInput,
    ) -> Result<DraftFragment, EventError> {
        let owner_key = input
            .owner
            .key()
            .map_err(|error| EventError::Invalid(error.to_string()))?;
        if input.draft_id.is_empty() || input.draft_id.len() > 128 {
            return Err(EventError::Invalid("draft_id must be 1..128 bytes".into()));
        }
        if input.fragment_index < 0 || input.raw_payload.is_empty() {
            return Err(EventError::Invalid(
                "draft fragment index or payload invalid".into(),
            ));
        }
        if !matches!(
            input.event_type.as_str(),
            "assistant.text.delta" | "assistant.thinking.delta"
        ) {
            return Err(EventError::Invalid(
                "only assistant delta may enter draft".into(),
            ));
        }
        let raw_payload = input
            .raw_payload
            .into_iter()
            .map(|raw| redact_journal_credentials(raw, false))
            .collect::<Vec<_>>();
        let raw_json = serde_json::to_string(&raw_payload)
            .map_err(|error| EventError::Invalid(error.to_string()))?;
        if raw_json.len() > MAX_FOLD_BYTES {
            return Err(EventError::Invalid(
                "draft fragment exceeds 48 KiB budget".into(),
            ));
        }
        let identity_json = input.identity.as_ref().map(Value::to_string);
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let tombstone: Option<String> = tx
            .prepare_cached(TOMBSTONE_STATE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key, input.owner.local_session_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(EventError::from)?
            .flatten();
        if let Some(state) = tombstone {
            return Err(EventError::SessionDeleted(format!(
                "{owner_key}（tombstone state={state}）"
            )));
        }
        let other_draft: Option<String> = tx
            .query_row(
                "SELECT draft_id FROM canonical_draft_fragments WHERE owner_key = ?1 LIMIT 1",
                params![owner_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(EventError::from)?;
        if other_draft
            .as_deref()
            .is_some_and(|open| open != input.draft_id)
        {
            return Err(EventError::DraftPending(owner_key));
        }
        let existing = tx
            .query_row(
                "SELECT owner_key, draft_id, fragment_index, client_generation,
                        remote_session_id, event_type, identity, raw_payload,
                        first_received_at, created_at
                 FROM canonical_draft_fragments
                 WHERE owner_key = ?1 AND draft_id = ?2 AND fragment_index = ?3",
                params![owner_key, input.draft_id, input.fragment_index],
                decode_fragment,
            )
            .optional()
            .map_err(EventError::from)?;
        if let Some(existing) = existing {
            let existing = decode_stored_fragment(existing)?;
            if existing.client_generation == input.client_generation
                && existing.remote_session_id == input.remote_session_id
                && existing.event_type == input.event_type
                && existing.identity == input.identity
                && existing.raw_payload == raw_payload
                && existing.first_received_at == input.first_received_at
            {
                return Ok(existing);
            }
            return Err(EventError::Invalid(
                "draft fragment retry changed content".into(),
            ));
        }
        let next: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(fragment_index), -1) + 1
                 FROM canonical_draft_fragments WHERE owner_key = ?1 AND draft_id = ?2",
                params![owner_key, input.draft_id],
                |row| row.get(0),
            )
            .map_err(EventError::from)?;
        if input.fragment_index != next {
            return Err(EventError::Invalid(format!(
                "draft fragment out of order: expected {next}, got {}",
                input.fragment_index
            )));
        }
        let created_at = now_millis();
        tx.execute(
            "INSERT INTO canonical_draft_fragments
             (owner_key, draft_id, fragment_index, client_generation, remote_session_id,
              event_type, identity, raw_payload, first_received_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                owner_key,
                input.draft_id,
                input.fragment_index,
                input.client_generation,
                input.remote_session_id,
                input.event_type,
                identity_json,
                raw_json,
                input.first_received_at,
                created_at,
            ],
        )
        .map_err(EventError::from)?;
        tx.commit().map_err(EventError::from)?;
        Ok(DraftFragment {
            owner_key,
            draft_id: input.draft_id,
            fragment_index: input.fragment_index,
            client_generation: input.client_generation,
            remote_session_id: input.remote_session_id,
            event_type: input.event_type,
            identity: input.identity,
            raw_payload,
            first_received_at: input.first_received_at,
            created_at,
            interrupted: true,
        })
    }

    /// 只供 draft 恢复 seam；正式历史查询绝不调用本函数。
    pub fn list_draft_fragments(&self, owner_key: &str) -> Result<Vec<DraftFragment>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT owner_key, draft_id, fragment_index, client_generation,
                        remote_session_id, event_type, identity, raw_payload,
                        first_received_at, created_at
                 FROM canonical_draft_fragments WHERE owner_key = ?1
                 ORDER BY created_at, draft_id, fragment_index",
            )
            .map_err(EventError::from)?;
        let rows = stmt
            .query_map(params![owner_key], decode_fragment)
            .map_err(EventError::from)?;
        rows.map(|row| decode_stored_fragment(row.map_err(EventError::from)?))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(index: i64, text: &str) -> DraftFragmentInput {
        DraftFragmentInput {
            owner: DurableSessionOwner::new("p", "a", "local:s"),
            draft_id: "run-1".into(),
            fragment_index: index,
            client_generation: 2,
            remote_session_id: Some("remote-s".into()),
            event_type: "assistant.text.delta".into(),
            identity: Some(serde_json::json!({"messageId":"m1"})),
            raw_payload: vec![serde_json::json!({
                "update": {"sessionUpdate":"agent_message_chunk", "content":{"text":text}},
                "secret": "must-not-persist"
            })],
            first_received_at: "2026-09-25T00:00:00.000Z".into(),
        }
    }

    fn commit_chunk(text: &str) -> KernelEventInput {
        KernelEventInput {
            owner: DurableSessionOwner::new("p", "a", "local:s"),
            remote_session_id: Some("remote-s".into()),
            client_generation: 2,
            received_at: "2026-09-25T00:00:00.000Z".into(),
            occurred_at: None,
            raw_payload: Arc::new(serde_json::json!({
                "update": {"sessionUpdate":"agent_message_chunk", "content":{"text":text}},
                "secret": "must-not-persist"
            })),
            import_origin: crate::event_repo::row::EventImportOrigin::Live,
        }
    }

    #[test]
    fn external_append_reports_draft_pending_without_advancing_revision() {
        let repo = EventRepo::open_in_memory().expect("repo");
        let owner_key = DurableSessionOwner::new("p", "a", "local:s").key().unwrap();
        repo.append_draft_fragment(input(0, "甲")).expect("draft");
        let event = crate::event_repo::parse_canonical_event(&serde_json::json!({
            "eventId": format!("{owner_key}#1"),
            "owner": {"profileId":"p","agentId":"a","localSessionId":"local:s","remoteSessionId":"remote-s"},
            "clientGeneration": 2,
            "sequence": 1,
            "occurredAt": "2026-09-25T00:00:00.000Z",
            "receivedAt": "2026-09-25T00:00:00.000Z",
            "eventType": "unknown",
            "payloadVersion": 1,
            "rawPayload": {"test": true}
        })).expect("event");
        let error = repo
            .append_events(&[event], Some(0))
            .expect_err("pending gate");
        assert_eq!(error.code(), "draft_pending");
        assert_eq!(repo.revision(&owner_key).unwrap(), 0);
    }

    #[test]
    fn interrupted_draft_can_be_kept_or_discarded_explicitly() {
        let repo = EventRepo::open_in_memory().expect("repo");
        let owner_key = DurableSessionOwner::new("p", "a", "local:s").key().unwrap();
        repo.append_draft_fragment(input(0, "甲")).expect("first");
        repo.append_draft_fragment(input(1, "乙")).expect("second");
        let rejected = repo
            .ingest_kernel_events(vec![commit_chunk("后续")])
            .expect_err("pending gate");
        assert_eq!(rejected.code(), "draft_pending");
        let kept = repo
            .keep_interrupted_draft(&owner_key, "run-1")
            .expect("keep");
        assert_eq!(kept.events.len(), 1);
        assert_eq!(kept.events[0].event_type, "assistant.text.delta.batch");
        assert_eq!(repo.list_draft_fragments(&owner_key).unwrap().len(), 0);
        repo.append_draft_fragment(input(0, "丙"))
            .expect("new interrupted run");
        assert!(repo.discard_interrupted_draft(&owner_key, "run-1").unwrap());
        assert_eq!(repo.list_draft_fragments(&owner_key).unwrap().len(), 0);
        assert_eq!(repo.revision(&owner_key).unwrap(), 2, "discard 不改历史");
    }

    #[test]
    fn draft_fragments_are_durable_only_in_draft_seam_and_retries_are_idempotent() {
        let repo = EventRepo::open_in_memory().expect("repo");
        let owner_key = DurableSessionOwner::new("p", "a", "local:s").key().unwrap();
        let first = repo.append_draft_fragment(input(0, "甲")).expect("first");
        assert_eq!(first.fragment_index, 0);
        assert_eq!(
            repo.revision(&owner_key).unwrap(),
            0,
            "draft 不推进 canonical revision"
        );
        assert!(!first.raw_payload[0]
            .to_string()
            .contains("must-not-persist"));
        let retry = repo
            .append_draft_fragment(input(0, "甲"))
            .expect("idempotent retry");
        assert_eq!(first, retry);
        assert!(
            repo.append_draft_fragment(input(0, "乙")).is_err(),
            "改写已存片段拒绝"
        );
        assert!(
            repo.append_draft_fragment(input(2, "丙")).is_err(),
            "跳号拒绝"
        );
        repo.append_draft_fragment(input(1, "乙")).expect("next");
        let listed = repo.list_draft_fragments(&owner_key).expect("list");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].fragment_index, 0);
        assert_eq!(listed[1].fragment_index, 1);
        let conn = repo.conn.lock().unwrap();
        let canonical_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(canonical_rows, 0, "draft 不进入正式历史");
    }

    #[test]
    fn draft_tombstone_gate_blocks_late_fragments() {
        let repo = EventRepo::open_in_memory().expect("repo");
        let owner_key = DurableSessionOwner::new("p", "a", "local:s").key().unwrap();
        {
            let conn = repo.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO deleted_sessions
                 (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision)
                 VALUES (?1, 'local:s', 'exact', 1, 'deleted', 0)",
                params![owner_key],
            )
            .unwrap();
        }
        let error = repo.append_draft_fragment(input(0, "迟到")).unwrap_err();
        assert!(matches!(error, EventError::SessionDeleted(_)));
    }

    #[test]
    fn draft_commit_atomically_replaces_matching_fragments_with_one_batch_row() {
        let repo = EventRepo::open_in_memory().expect("repo");
        let owner_key = DurableSessionOwner::new("p", "a", "local:s").key().unwrap();
        repo.append_draft_fragment(input(0, "甲"))
            .expect("persist first");
        let result = repo
            .commit_draft_events(vec![commit_chunk("甲"), commit_chunk("乙")], "run-1")
            .expect("commit draft and memory tail");
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].event_type, "assistant.text.delta.batch");
        assert_eq!(result.events[0].sequence, 2);
        assert_eq!(
            result.events[0].typed_payload.as_ref().unwrap()["seqSpan"],
            serde_json::json!([1, 2])
        );
        assert_eq!(repo.revision(&owner_key).unwrap(), 2);
        assert!(repo.list_draft_fragments(&owner_key).unwrap().is_empty());
    }

    #[test]
    fn draft_commit_mismatch_rolls_back_and_keeps_recoverable_tail() {
        let repo = EventRepo::open_in_memory().expect("repo");
        let owner_key = DurableSessionOwner::new("p", "a", "local:s").key().unwrap();
        repo.append_draft_fragment(input(0, "甲"))
            .expect("persist first");
        let error = repo
            .commit_draft_events(vec![commit_chunk("错")], "run-1")
            .unwrap_err();
        assert!(matches!(error, EventError::Invalid(_)));
        assert_eq!(repo.revision(&owner_key).unwrap(), 0);
        assert_eq!(repo.list_draft_fragments(&owner_key).unwrap().len(), 1);
    }
}
