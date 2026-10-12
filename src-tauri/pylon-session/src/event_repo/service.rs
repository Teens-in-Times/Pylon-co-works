//! 事件仓库 service：spawn_blocking 边界 + DTO 透传（镜像 MessageService）。

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use super::draft::{DraftCommitChunk, DraftFragment, DraftFragmentInput};
use super::normalize::{mark_replay_import, normalize_kernel_event, parse_canonical_event};
use super::repo::{EventRepo, RollupTrimReport};
use super::row::{
    CanonicalEventRawExport, CanonicalEventRow, CompactEventPage, EventAppendResult,
    EventImportOrigin, EventPage, EventSearchHit, ExternalHistoryImportResult, KernelEventInput,
    ReplayJournalIngestResult,
};
use super::EventError;
use crate::owner::DurableSessionOwner;

/// #376：读出口收口——IPC 边界专用。`turn.unit` **豁免**：单元行的载荷是整段历史
/// 的**唯一**副本（入库 raw 只是占位对象），收口即丢正文；被它覆盖的行本就已不下发，
/// 收口等于把这一回合从历史上抹掉。
fn cap_typed_payload_row(row: &mut CanonicalEventRow, enabled: bool) {
    if !enabled || row.event_type == crate::turn_rollup::TURN_UNIT_EVENT_TYPE {
        return;
    }
    if let Some(typed) = row.typed_payload.take() {
        row.typed_payload = Some(super::redaction::retain_typed_payload(typed));
    }
}

/// 事件仓库 service：spawn_blocking 边界 + DTO 透传（镜像 MessageService）。
pub struct EventService {
    pub(super) repo: Arc<EventRepo>,
    active_drafts: Arc<Mutex<HashSet<(String, String)>>>,
}

impl EventService {
    pub async fn keep_interrupted_draft(
        &self,
        owner_key: String,
        draft_id: String,
    ) -> Result<EventAppendResult, EventError> {
        let repo = self.repo.clone();
        let active = self.active_drafts.clone();
        tokio::task::spawn_blocking(move || {
            let active = active
                .lock()
                .map_err(|_| EventError::Unavailable("draft registry lock poisoned".into()))?;
            if active.contains(&(owner_key.clone(), draft_id.clone())) {
                return Err(EventError::DraftPending(owner_key));
            }
            repo.keep_interrupted_draft(&owner_key, &draft_id)
        })
        .await
        .map_err(|error| EventError::Unavailable(format!("draft keep task failed: {error}")))?
    }

    pub async fn discard_interrupted_draft(
        &self,
        owner_key: String,
        draft_id: String,
    ) -> Result<bool, EventError> {
        let repo = self.repo.clone();
        let active = self.active_drafts.clone();
        tokio::task::spawn_blocking(move || {
            let active = active
                .lock()
                .map_err(|_| EventError::Unavailable("draft registry lock poisoned".into()))?;
            if active.contains(&(owner_key.clone(), draft_id.clone())) {
                return Err(EventError::DraftPending(owner_key));
            }
            repo.discard_interrupted_draft(&owner_key, &draft_id)
        })
        .await
        .map_err(|error| EventError::Unavailable(format!("draft discard task failed: {error}")))?
    }

    /// 已存 draft 前缀与同 run 的内存尾部一起收口；正式历史和片段清理同事务。
    pub async fn commit_draft_events(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        draft_id: String,
        chunks: Vec<DraftCommitChunk>,
    ) -> Result<EventAppendResult, EventError> {
        let client_generation = i64::try_from(client_generation)
            .map_err(|_| EventError::Invalid("client generation exceeds i64".into()))?;
        let inputs = chunks
            .into_iter()
            .map(|chunk| KernelEventInput {
                owner: owner.clone(),
                remote_session_id: remote_session_id.clone(),
                client_generation,
                received_at: chunk.received_at,
                occurred_at: None,
                raw_payload: chunk.raw_payload,
                import_origin: EventImportOrigin::Live,
            })
            .collect();
        let repo = self.repo.clone();
        let active = self.active_drafts.clone();
        tokio::task::spawn_blocking(move || {
            let mut active = active
                .lock()
                .map_err(|_| EventError::Unavailable("draft registry lock poisoned".into()))?;
            let owner_key = owner
                .key()
                .map_err(|error| EventError::Invalid(error.to_string()))?;
            let result = repo.commit_draft_events(inputs, &draft_id)?;
            active.remove(&(owner_key, draft_id));
            Ok(result)
        })
        .await
        .map_err(|error| EventError::Unavailable(format!("draft commit task failed: {error}")))?
    }

    /// 在途片段独立持久化；返回经过落盘同款脱敏的片段供成功后发布。
    pub async fn append_draft_fragment(
        &self,
        input: DraftFragmentInput,
    ) -> Result<DraftFragment, EventError> {
        let repo = self.repo.clone();
        let active = self.active_drafts.clone();
        tokio::task::spawn_blocking(move || {
            let mut active = active
                .lock()
                .map_err(|_| EventError::Unavailable("draft registry lock poisoned".into()))?;
            let mut fragment = repo.append_draft_fragment(input)?;
            active.insert((fragment.owner_key.clone(), fragment.draft_id.clone()));
            fragment.interrupted = false;
            Ok(fragment)
        })
        .await
        .map_err(|error| EventError::Unavailable(format!("draft append task failed: {error}")))?
    }

    /// 专用冷挂载 seam；调用方不得把结果混进 evt_* 历史游标。
    pub async fn list_draft_fragments(
        &self,
        owner_key: String,
    ) -> Result<Vec<DraftFragment>, EventError> {
        let repo = self.repo.clone();
        let active = self.active_drafts.clone();
        tokio::task::spawn_blocking(move || {
            let active = active
                .lock()
                .map_err(|_| EventError::Unavailable("draft registry lock poisoned".into()))?;
            let mut fragments = repo.list_draft_fragments(&owner_key)?;
            for fragment in &mut fragments {
                fragment.interrupted =
                    !active.contains(&(fragment.owner_key.clone(), fragment.draft_id.clone()));
            }
            Ok(fragments)
        })
        .await
        .map_err(|error| EventError::Unavailable(format!("draft read task failed: {error}")))?
    }

    /// Dispatcher exited without committing this run (crash, generation switch).
    /// The stored fragments remain durable and become user-resolvable.
    pub fn abandon_draft(&self, owner_key: &str, draft_id: &str) {
        if let Ok(mut active) = self.active_drafts.lock() {
            active.remove(&(owner_key.to_owned(), draft_id.to_owned()));
        }
    }

    /// 打开（或创建）生产仓库并迁移到最新 schema。调用方须先创建 DB 父目录；
    /// 失败返回 Err——启动路径不得静默回退。
    pub fn open_db(path: &Path) -> Result<EventService, EventError> {
        let repo = EventRepo::open(path)?;
        Ok(EventService {
            repo: Arc::new(repo),
            active_drafts: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存服务
    pub fn in_memory() -> Result<EventService, EventError> {
        let repo = EventRepo::open_in_memory()?;
        Ok(EventService {
            repo: Arc::new(repo),
            active_drafts: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    /// 校验 + 批量 append（spawn_blocking 边界）。输入为前端 EVT-01 schema JSON。
    pub async fn append_events(
        &self,
        input: Vec<serde_json::Value>,
        expected_revision: Option<i64>,
    ) -> Result<EventAppendResult, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let events = input
                .iter()
                .map(parse_canonical_event)
                .collect::<Result<Vec<_>, _>>()?;
            repo.append_events(&events, expected_revision)
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("event repo append task failed: {error}"))
        })?
    }

    /// Kernel ingest boundary：sequence/revision 在 repository transaction 内分配，
    /// 返回 committed row，供 dispatcher 在 durable append 后发布 projection。
    ///
    /// #334/P2：payload 归一为 `Arc<Value>` 共享语义（`impl Into` 收口——dispatcher
    /// 热路径传 `Arc` 与发布侧共享同一份，冷路径调用方传 `Value` 原地包装）。
    pub async fn ingest_event(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_payload: impl Into<std::sync::Arc<serde_json::Value>>,
    ) -> Result<EventAppendResult, EventError> {
        self.ingest_events(
            owner,
            remote_session_id,
            client_generation,
            vec![raw_payload.into()],
        )
        .await
    }

    /// Kernel batch ingest boundary：同一 owner 的多条 live raw payload 共享一次
    /// repository transaction，仍逐条 normalize/append，并返回实际提交的行（含 terminal
    /// 触发的 turn.unit）。调用方负责在窗口/消息边界 flush；单事件入口委托到这里以保证
    /// 两条路径永远共享同一 sequence、tombstone 和 rollup 语义。
    pub async fn ingest_events(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_payloads: Vec<std::sync::Arc<serde_json::Value>>,
    ) -> Result<EventAppendResult, EventError> {
        let client_generation = i64::try_from(client_generation)
            .map_err(|_| EventError::Invalid("client generation exceeds i64".into()))?;
        let inputs = raw_payloads
            .into_iter()
            .map(|raw_payload| KernelEventInput {
                owner: owner.clone(),
                remote_session_id: remote_session_id.clone(),
                client_generation,
                received_at: chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                occurred_at: None,
                raw_payload,
                import_origin: EventImportOrigin::Live,
            })
            .collect();
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.ingest_kernel_events(inputs))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("kernel event ingest task failed: {error}"))
            })?
    }

    /// Import a complete session/load replay into the single owner journal. Only an empty journal
    /// may be imported. Any trusted local observation wins; a revision race is treated as local
    /// authority (or an idempotent unverified import), never as permission to append a snapshot.
    pub async fn ingest_complete_replay(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_events: Vec<serde_json::Value>,
    ) -> Result<ReplayJournalIngestResult, EventError> {
        let client_generation = i64::try_from(client_generation)
            .map_err(|_| EventError::Invalid("client generation exceeds i64".into()))?;
        let received_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let owner_key = owner
                .key()
                .map_err(|error| EventError::Invalid(error.to_string()))?;
            if repo.has_authoritative_local_events(&owner_key)? {
                return Ok(ReplayJournalIngestResult {
                    events: Vec::new(),
                    revision: repo.revision(&owner_key)?,
                    status: "local-authoritative",
                });
            }
            let replay_events = raw_events
                .into_iter()
                .map(|raw| mark_replay_import(&owner, raw))
                .collect::<Vec<_>>();
            if replay_events.is_empty() {
                let owner_key = owner
                    .key()
                    .map_err(|error| EventError::Invalid(error.to_string()))?;
                let revision = repo.revision(&owner_key)?;
                return Ok(ReplayJournalIngestResult {
                    events: Vec::new(),
                    revision,
                    status: if revision == 0 {
                        "empty"
                    } else {
                        "already-imported"
                    },
                });
            }
            let mut events = Vec::with_capacity(replay_events.len());
            for (index, raw_payload) in replay_events.into_iter().enumerate() {
                events.push(normalize_kernel_event(
                    KernelEventInput {
                        owner: owner.clone(),
                        remote_session_id: remote_session_id.clone(),
                        client_generation,
                        received_at: received_at.clone(),
                        occurred_at: None,
                        // 回放导入为冷路径，共享包装仅为对齐 KernelEventInput 契约。
                        raw_payload: std::sync::Arc::new(raw_payload),
                        import_origin: EventImportOrigin::RecoveryImport,
                    },
                    i64::try_from(index + 1).map_err(|_| {
                        EventError::Invalid("replay event count exceeds i64".into())
                    })?,
                )?);
            }
            match repo.append_events(&events, Some(0)) {
                Ok(result) => Ok(ReplayJournalIngestResult {
                    events: result.events,
                    revision: result.revision,
                    status: "imported",
                }),
                Err(EventError::RevisionConflict { .. }) => {
                    let local_authority = repo.has_authoritative_local_events(&owner_key)?;
                    Ok(ReplayJournalIngestResult {
                        events: Vec::new(),
                        revision: repo.revision(&owner_key)?,
                        status: if local_authority {
                            "local-authoritative"
                        } else {
                            "already-imported"
                        },
                    })
                }
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("replay event ingest task failed: {error}"))
        })?
    }

    /// #364：外部 CLI 原生历史导入（Claude Code 等的 transcript 快照）。
    ///
    /// 与 `ingest_complete_replay` 同为快照式冷导入，差异在 owner 与幂等键：
    /// owner 是保留字三元组（`profile_id="external-import"`），幂等键 =
    /// `(agent_id, remote_session_id)`（remote id 即原生会话 id）——已导入且未
    /// force 时 0 写入返回 `already-imported`。force 分叉（issue #364 裁决）：
    /// 调用方先生成带 `#N` 后缀的新 local_session_id（新 owner_key ⇒ 空
    /// journal），传 `force=true` 跳过幂等探针后照常落库——原快照封存不动。
    /// 事件 payload 是 `session/update` 线形状（与 live/replay 同一 normalize
    /// 管道），`occurred_at` 取源文件时间戳而非导入时刻。封存快照纪律：
    /// 导入后不 live 重解析源文件。
    pub async fn ingest_external_history(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: String,
        force: bool,
        events: Vec<(String, std::sync::Arc<serde_json::Value>)>,
    ) -> Result<ExternalHistoryImportResult, EventError> {
        let client_generation = 0i64;
        let received_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            if !force && repo.has_external_import(&owner.agent_id, &remote_session_id)? {
                return Ok(ExternalHistoryImportResult {
                    events: Vec::new(),
                    revision: 0,
                    status: "already-imported",
                });
            }
            let mut rows = Vec::with_capacity(events.len());
            let mut owner_key = String::new();
            for (index, (occurred_at, raw_payload)) in events.into_iter().enumerate() {
                let row = normalize_kernel_event(
                    KernelEventInput {
                        owner: owner.clone(),
                        remote_session_id: Some(remote_session_id.clone()),
                        client_generation,
                        received_at: received_at.clone(),
                        occurred_at: Some(occurred_at),
                        raw_payload,
                        import_origin: EventImportOrigin::ExternalImport,
                    },
                    i64::try_from(index + 1).map_err(|_| {
                        EventError::Invalid("external history event count exceeds i64".into())
                    })?,
                )?;
                owner_key = row.owner_key.clone();
                rows.push(row);
            }
            match repo.append_events(&rows, Some(0)) {
                Ok(result) => Ok(ExternalHistoryImportResult {
                    events: result.events,
                    revision: result.revision,
                    status: "imported",
                }),
                // 并发双击同一会话：后到者撞空 journal 预期即幂等跳过。
                Err(EventError::RevisionConflict { .. }) => Ok(ExternalHistoryImportResult {
                    events: Vec::new(),
                    revision: if owner_key.is_empty() {
                        0
                    } else {
                        repo.revision(&owner_key)?
                    },
                    status: "already-imported",
                }),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("external history ingest task failed: {error}"))
        })?
    }

    /// owner 当前 revision（MAX(sequence)，空 = 0）。
    pub async fn revision(&self, owner_key: String) -> Result<i64, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.revision(&owner_key))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo revision task failed: {error}"))
            })?
    }

    /// Read-only authority probe used before deciding how an incomplete replay may be surfaced.
    /// It deliberately ignores recovery-import rows: only durable local observations establish
    /// the local journal as the load authority.
    pub async fn has_authoritative_local_events(
        &self,
        owner_key: String,
    ) -> Result<bool, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.has_authoritative_local_events(&owner_key))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo authority task failed: {error}"))
            })?
    }

    /// 游标分页读取（最新页 before_seq=null；limit 缺省 100）。
    ///
    /// `cap_typed_payload` 为 #376 的读出口收口开关：true 时把 typed 载荷的字符串
    /// 叶子按 `MAX_CANONICAL_RAW_BYTES` 同一条线收缩（IPC 边界专用）。宿主内部读
    /// （证据回读、prompt 断言）传 false——它们要与入库行逐字段比对，且不经 IPC。
    pub async fn list_events(
        &self,
        owner_key: String,
        before_sequence: Option<i64>,
        limit: u32,
        cap_typed_payload: bool,
    ) -> Result<EventPage, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let mut page = repo.list_events(&owner_key, before_sequence, limit)?;
            for row in &mut page.events {
                cap_typed_payload_row(row, cap_typed_payload);
            }
            Ok(page)
        })
        .await
        .map_err(|error| EventError::Unavailable(format!("event repo list task failed: {error}")))?
    }

    /// #51 收口：写入侧幂等判定的读支撑——owner journal 里最新一条指定类型事件。
    pub async fn latest_event_of_type(
        &self,
        owner_key: String,
        event_type: &'static str,
    ) -> Result<Option<CanonicalEventRow>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.latest_event_of_type(&owner_key, event_type))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo latest task failed: {error}"))
            })?
    }

    /// #442 Step1：回合边界判据的 tail 行（升序；cap 由调用方给定，正常 ≤512）。
    /// 供 load 响应顶层 `turnBoundary` 的 journal 侧合成（账本为空时的回退数据面）。
    pub async fn turn_boundary_rows(
        &self,
        owner_key: String,
        cap: u32,
    ) -> Result<Vec<crate::turn_boundary::TurnBoundaryRow>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.turn_boundary_rows(&owner_key, cap))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo turn boundary task failed: {error}"))
            })?
    }

    /// #81 L2 / #376-b：compact 读**分页**（单元 + 未覆盖行；升序、前向游标）。
    /// `cap_typed_payload` 语义同 `list_events`。
    pub async fn load_events_compact_page(
        &self,
        owner_key: String,
        after_sequence: Option<i64>,
        limit: u32,
        cap_typed_payload: bool,
    ) -> Result<CompactEventPage, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let mut page = repo.load_events_compact_page(&owner_key, after_sequence, limit)?;
            for row in &mut page.events {
                cap_typed_payload_row(row, cap_typed_payload);
            }
            Ok(page)
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("event repo compact task failed: {error}"))
        })?
    }

    /// #81 L2：compact 读**一次性**（分页读的循环封装）。生产调用方为零
    /// （`evt_load_compact` 命令走 `load_events_compact_page`），随仓库侧一并
    /// `#[cfg(test)]` 化（W3 重构批次 P9 清偿；行为零变化）。
    /// `cap_typed_payload` 语义同 `list_events`。
    #[cfg(test)]
    pub async fn load_events_compact(
        &self,
        owner_key: String,
        cap_typed_payload: bool,
    ) -> Result<Vec<CanonicalEventRow>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let mut rows = repo.load_events_compact(&owner_key)?;
            for row in &mut rows {
                cap_typed_payload_row(row, cap_typed_payload);
            }
            Ok(rows)
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("event repo compact task failed: {error}"))
        })?
    }

    /// #81 L3：裁剪迁移（应用关闭时调用；budget_ms 控制单次预算，可续跑）。
    pub async fn rollup_trim(
        &self,
        budget_ms: Option<u64>,
    ) -> Result<RollupTrimReport, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.rollup_trim(budget_ms))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo trim task failed: {error}"))
            })?
    }

    /// #81 L3：剩余未裁剪单元数（策略关闭时的报告数据源）。
    pub async fn count_remaining_rollup_units(&self) -> Result<i64, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.count_remaining_rollup_units())
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo trim count task failed: {error}"))
            })?
    }

    pub async fn export_raw_event(
        &self,
        event_id: String,
    ) -> Result<Option<CanonicalEventRawExport>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.export_raw_event(&event_id))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event raw export task failed: {error}"))
            })?
    }

    /// B6 / #445：跨 owner 内容搜索命中行（前端定向拉行 + 投影复核的数据源）。
    pub async fn search_hits(
        &self,
        query: String,
        limit: u32,
    ) -> Result<Vec<EventSearchHit>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.search_hits(&query, limit))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo search task failed: {error}"))
            })?
    }
}

#[cfg(test)]
mod draft_status_tests {
    use super::*;

    #[tokio::test]
    async fn live_draft_cannot_be_resolved_until_dispatcher_abandons_it() {
        let service = EventService::in_memory().unwrap();
        let owner = DurableSessionOwner::new("p", "a", "local:s");
        let owner_key = owner.key().unwrap();
        service.append_draft_fragment(DraftFragmentInput {
            owner, draft_id: "run-1".into(), fragment_index: 0,
            client_generation: 1, remote_session_id: Some("remote-s".into()),
            event_type: "assistant.text.delta".into(), identity: None,
            raw_payload: vec![serde_json::json!({
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "partial"}}
            })],
            first_received_at: "2026-09-25T00:00:00.000Z".into(),
        }).await.unwrap();
        assert!(
            !service
                .list_draft_fragments(owner_key.clone())
                .await
                .unwrap()[0]
                .interrupted
        );
        assert_eq!(
            service
                .keep_interrupted_draft(owner_key.clone(), "run-1".into())
                .await
                .unwrap_err()
                .code(),
            "draft_pending",
        );
        service.abandon_draft(&owner_key, "run-1");
        assert!(
            service
                .list_draft_fragments(owner_key.clone())
                .await
                .unwrap()[0]
                .interrupted
        );
        assert_eq!(
            service
                .keep_interrupted_draft(owner_key, "run-1".into())
                .await
                .unwrap()
                .events
                .len(),
            1
        );
    }
}
