//! 事件仓库本体：SQLite 连接管理、append/ingest 写路径与分页/compact/裁剪读路径。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use super::draft::verify_draft_commit_prefix;
use super::fold::{
    self, flush_delta_run, foldable_delta_base, identity_keys_equal, raw_payload_bytes,
    MAX_FOLDED_CHUNKS, MAX_FOLD_BYTES,
};
use super::normalize::{normalize_kernel_event, now_millis};
use super::provenance::{owner_triple, provenance_code};
use super::row::{
    map_event_row, CanonicalEventRawExport, CanonicalEventRow, CompactEventPage, EventAppendResult,
    EventPage, EventSearchHit, KernelEventInput,
};
use super::EventError;

// 高频 SQL 常量：append/ingest 热路径共用同一 SQL 文本，
// 配合 Connection::prepare_cached 让语句只编译一次（缓存随连接存活）。
// 主键 (owner_key, sequence) 即去重键（v15 起无 event_id 列；eventId 由 rule 1 推导）。
const INSERT_EVENT_SQL: &str = "INSERT INTO canonical_events
     (owner_key, remote_session_id, sequence, client_generation, occurred_at,
      received_at, event_type, payload_version, identity, typed_payload,
      raw_payload, created_at, provenance)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
 ON CONFLICT(owner_key, sequence) DO NOTHING";
pub(super) const TOMBSTONE_STATE_SQL: &str = "SELECT state FROM deleted_sessions
     WHERE owner_key = ?1 OR (session_id = ?2 AND owner_scope = 'legacy')
     LIMIT 1";
const MAX_SEQUENCE_SQL: &str = "SELECT MAX(sequence) FROM canonical_events WHERE owner_key = ?1";
/// #81 L2：终结边界查询（上一 turn 的 terminal/unit 最大 sequence）。
const LAST_TURN_BOUNDARY_SQL: &str = "SELECT COALESCE(MAX(sequence), 0) FROM canonical_events
     WHERE owner_key = ?1 AND event_type IN ('turn.completed', 'turn.failed', 'turn.unit') AND sequence < ?2";
/// v15 存储列序（list/compact/trim 三路共用；尾部 rollup 列为 turn.unit 专用）。
const EVENT_COLUMNS: &str = "owner_key, remote_session_id, sequence, client_generation, occurred_at, received_at, event_type, payload_version, identity, typed_payload, raw_payload, created_at, provenance, rollup_seq_start, rollup_seq_end";

/// v15 瘦身行写入（append/ingest/turn.unit 三路共用）：派生字段在 `map_event_row`
/// 读侧还原，这里只绑存储 15 列；rollup 覆盖跨度仅 turn.unit 行携带。
fn execute_insert_event(
    tx: &rusqlite::Transaction<'_>,
    event: &CanonicalEventRow,
    rollup: Option<(i64, i64)>,
) -> Result<usize, EventError> {
    let provenance = provenance_code(&event.provenance_origin, &event.provenance_trust);
    let identity = event.identity.as_ref().map(serde_json::Value::to_string);
    let typed_payload = event
        .typed_payload
        .as_ref()
        .map(serde_json::Value::to_string);
    match rollup {
        Some((rollup_seq_start, rollup_seq_end)) => tx
            .prepare_cached(
                "INSERT INTO canonical_events
                 (owner_key, remote_session_id, sequence, client_generation, occurred_at,
                  received_at, event_type, payload_version, identity, typed_payload,
                  raw_payload, created_at, provenance, rollup_seq_start, rollup_seq_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(owner_key, sequence) DO NOTHING",
            )
            .map_err(EventError::from)?
            .execute(params![
                event.owner_key,
                event.remote_session_id,
                event.sequence,
                event.client_generation,
                event.occurred_at,
                event.received_at,
                event.event_type,
                event.payload_version,
                identity,
                typed_payload,
                event.raw_payload_json,
                event.created_at,
                provenance,
                rollup_seq_start,
                rollup_seq_end,
            ])
            .map_err(EventError::from),
        None => tx
            .prepare_cached(INSERT_EVENT_SQL)
            .map_err(EventError::from)?
            .execute(params![
                event.owner_key,
                event.remote_session_id,
                event.sequence,
                event.client_generation,
                event.occurred_at,
                event.received_at,
                event.event_type,
                event.payload_version,
                identity,
                typed_payload,
                event.raw_payload_json,
                event.created_at,
                provenance,
            ])
            .map_err(EventError::from),
    }
}

fn query_events_by_sequence(
    conn: &Connection,
    owner_key: &str,
    sequences: &[i64],
) -> Result<Vec<CanonicalEventRow>, EventError> {
    if sequences.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (0..sequences.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT {EVENT_COLUMNS} FROM canonical_events
         WHERE owner_key = ?1 AND sequence IN ({placeholders})
         ORDER BY sequence ASC"
    );
    let mut stmt = conn.prepare_cached(&sql).map_err(EventError::from)?;
    let mut bind: Vec<&dyn rusqlite::ToSql> = vec![&owner_key];
    for sequence in sequences {
        bind.push(sequence);
    }
    let mut rows = Vec::with_capacity(sequences.len());
    for row in stmt
        .query_map(rusqlite::params_from_iter(bind.iter()), map_event_row)
        .map_err(EventError::from)?
    {
        rows.push(row.map_err(EventError::from)?.decode()?);
    }
    Ok(rows)
}

/// #376-b：compact 读单页行数上限。页内行数与单行体积共同决定一次 invoke 的载荷上界
/// （最坏 = 上限 × 单行 64 KiB），也是 `sequence IN (...)` 的绑定参数个数上限。
const MAX_COMPACT_PAGE_LIMIT: u32 = 2000;

/// 读取升序行集 [start, end]（含端点；ingest 单元构建与 trim 校验共用）。
fn query_event_rows(
    conn: &Connection,
    owner_key: &str,
    start: i64,
    end: i64,
) -> Result<Vec<CanonicalEventRow>, EventError> {
    let sql = format!(
        "SELECT {EVENT_COLUMNS} FROM canonical_events WHERE owner_key = ?1 AND sequence >= ?2 AND sequence <= ?3 ORDER BY sequence ASC"
    );
    let mut stmt = conn.prepare_cached(&sql).map_err(EventError::from)?;
    let rows = stmt
        .query_map(params![owner_key, start, end], map_event_row)
        .map_err(EventError::from)?;
    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(EventError::from)?.decode()?);
    }
    Ok(events)
}

/// #81 L3：裁剪迁移报告（wire camelCase）。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollupTrimReport {
    pub processed_units: i64,
    pub trimmed_units: i64,
    pub resumed_units: i64,
    pub mismatch_units: i64,
    pub remaining_units: i64,
    pub vacuumed: bool,
    pub policy_blocked: bool,
}

enum RollupUnitOutcome {
    Trimmed,
    AlreadyGone,
    ShaMismatch,
}

/// 事件仓库：单一 SQLite 连接 + 互斥（SQLite 单写者）。
pub struct EventRepo {
    pub(super) conn: Mutex<Connection>,
}

impl EventRepo {
    /// 打开（或创建）仓库并迁移到最新 schema（D-02 版本化迁移）。
    pub fn open(path: &Path) -> Result<EventRepo, EventError> {
        let mut conn = Connection::open(path).map_err(EventError::from)?;
        crate::connect(&mut conn).map_err(|error| EventError::Unavailable(error.to_string()))?;
        Ok(EventRepo {
            conn: Mutex::new(conn),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存仓库
    pub fn open_in_memory() -> Result<EventRepo, EventError> {
        let mut conn = Connection::open_in_memory().map_err(EventError::from)?;
        crate::connect(&mut conn).map_err(|error| EventError::Unavailable(error.to_string()))?;
        Ok(EventRepo {
            conn: Mutex::new(conn),
        })
    }

    /// owner 当前 revision = 该 owner 最大 sequence（空 = 0）。expected_revision 冲突
    /// 检测基准：单写者（Mutex）下 MAX(sequence) 单调递增，旧写落后即判定过期。
    pub fn revision(&self, owner_key: &str) -> Result<i64, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let max: Option<i64> = conn
            .prepare_cached(MAX_SEQUENCE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key], |row| row.get::<_, Option<i64>>(0))
            .optional()
            .map_err(EventError::from)?
            .flatten();
        Ok(max.unwrap_or(0))
    }

    /// 批量 append（单事务）：expected_revision（Some）与当前 revision 不匹配 →
    /// `RevisionConflict`，不写任何行（旧写不覆盖新写）。
    /// event_id 已存在（重启去重）跳过不重复写入、不消耗 sequence（事件 sequence 由
    /// 前端 allocateEventSequence 分配，rule 3）。返回实际写入事件与写入后 revision。
    pub fn append_events(
        &self,
        events: &[CanonicalEventRow],
        expected_revision: Option<i64>,
    ) -> Result<EventAppendResult, EventError> {
        if events.is_empty() {
            return Ok(EventAppendResult {
                events: Vec::new(),
                revision: 0,
            });
        }
        let owner_key = &events[0].owner_key;
        // 批量必须同属一个 owner（单事件流写入；跨 owner 混批视为输入非法）。
        if let Some(cross) = events.iter().find(|e| e.owner_key != *owner_key) {
            return Err(EventError::Invalid(format!(
                "append 批次跨 owner：{} 与 {}",
                owner_key, cross.owner_key
            )));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        // DEL-04：tombstone gate——owner 已删除（deleting/deleted）时拒绝迟到 append，
        // 不复活已删会话（canonical_events 无 FK 级联，必须显式查 deleted_sessions）。
        let tombstone_state: Option<String> = tx
            .prepare_cached(TOMBSTONE_STATE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key, events[0].local_session_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(EventError::from)?
            .flatten();
        if let Some(state) = tombstone_state {
            return Err(EventError::SessionDeleted(format!(
                "{owner_key}（tombstone state={state}）"
            )));
        }
        let draft_pending: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM canonical_draft_fragments WHERE owner_key = ?1)",
                params![owner_key],
                |row| row.get(0),
            )
            .map_err(EventError::from)?;
        if draft_pending {
            return Err(EventError::DraftPending(owner_key.clone()));
        }
        let current: i64 = tx
            .prepare_cached(MAX_SEQUENCE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key], |row| row.get::<_, Option<i64>>(0))
            .optional()
            .map_err(EventError::from)?
            .flatten()
            .unwrap_or(0);
        if let Some(expected) = expected_revision {
            if expected != current {
                return Err(EventError::RevisionConflict {
                    expected,
                    actual: current,
                });
            }
        }
        let mut inserted = Vec::new();
        let mut revision = current;
        for event in events {
            let changed = execute_insert_event(&tx, event, None)?;
            if changed > 0 {
                revision = revision.max(event.sequence);
                inserted.push(event.clone());
            }
        }
        tx.commit().map_err(EventError::from)?;
        Ok(EventAppendResult {
            events: inserted,
            revision,
        })
    }

    /// Kernel single-writer ingest：在同一 SQLite transaction 内读取 revision、分配
    /// sequence、normalize 并 append。调用方不持有第二份 sequence 状态。
    /// 仅测试便捷入口：生产单事件路径经 `ingest_event` → `ingest_events`（批量版）。
    #[cfg(test)]
    pub(super) fn ingest_kernel_event(
        &self,
        input: KernelEventInput,
    ) -> Result<EventAppendResult, EventError> {
        self.ingest_kernel_events(vec![input])
    }

    /// Kernel batch ingest：同一 owner 的输入共享一条 SQLite transaction。相邻同类
    /// delta 在本次调用内折成 batch 行；sequence 只在这里推进，terminal unit 同事务追加。
    pub(super) fn ingest_kernel_events(
        &self,
        inputs: Vec<KernelEventInput>,
    ) -> Result<EventAppendResult, EventError> {
        self.ingest_kernel_events_with_draft(inputs, None)
    }

    /// 跨窗口 run 收口：正式行追加与已存临时片段删除必须原子完成。
    pub(super) fn commit_draft_events(
        &self,
        inputs: Vec<KernelEventInput>,
        draft_id: &str,
    ) -> Result<EventAppendResult, EventError> {
        if draft_id.is_empty() {
            return Err(EventError::Invalid("draft_id must not be empty".into()));
        }
        self.ingest_kernel_events_with_draft(inputs, Some(draft_id))
    }

    fn ingest_kernel_events_with_draft(
        &self,
        inputs: Vec<KernelEventInput>,
        draft_id: Option<&str>,
    ) -> Result<EventAppendResult, EventError> {
        let Some(first) = inputs.first() else {
            return Ok(EventAppendResult {
                events: Vec::new(),
                revision: 0,
            });
        };
        let owner_key = first
            .owner
            .key()
            .map_err(|error| EventError::Invalid(error.to_string()))?;
        for input in &inputs {
            let input_owner_key = input
                .owner
                .key()
                .map_err(|error| EventError::Invalid(error.to_string()))?;
            if input_owner_key != owner_key {
                return Err(EventError::Invalid(format!(
                    "kernel ingest batch crosses owners: {owner_key} vs {input_owner_key}"
                )));
            }
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let tombstone_state: Option<String> = tx
            .prepare_cached(TOMBSTONE_STATE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key, first.owner.local_session_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(EventError::from)?
            .flatten();
        if let Some(state) = tombstone_state {
            return Err(EventError::SessionDeleted(format!(
                "{owner_key}（tombstone state={state}）"
            )));
        }
        let pending_draft: Option<String> = tx
            .query_row(
                "SELECT draft_id FROM canonical_draft_fragments WHERE owner_key = ?1 LIMIT 1",
                params![owner_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(EventError::from)?;
        if pending_draft
            .as_deref()
            .is_some_and(|open| Some(open) != draft_id)
        {
            return Err(EventError::DraftPending(owner_key));
        }
        let revision: i64 = tx
            .prepare_cached(MAX_SEQUENCE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key], |row| row.get::<_, Option<i64>>(0))
            .optional()
            .map_err(EventError::from)?
            .flatten()
            .unwrap_or(0);
        let mut final_revision = revision;
        if let Some(draft_id) = draft_id {
            verify_draft_commit_prefix(&tx, &owner_key, draft_id, &inputs)?;
        }
        let mut result_events = Vec::with_capacity(inputs.len());
        // ADR-0016（#155 T3-1）：写侧行聚合——**顺序流式**折叠（不是「先全归一化再折」）。
        //
        // 为什么必须顺序：终态行会在同一事务里追加 `turn.unit`（多占一个 sequence），若先把整窗
        // 归一化再折叠，终态之后那些行的编号会与新占的单元号冲突。顺序折叠下编号始终由「已写 +
        // 已保留」的最大 sequence 推出，单元的插入自然推进后续编号。
        //
        // run 判据与读侧 `fold_adjacent_delta_runs` 同一口径、同一预算；收口复用 `flush_delta_run`
        // （长度 < 2 原样、≥ 2 产 `*.delta.batch` 行），故不存在第二份规则。窗口边界处 run 自然
        // 断开（每行自带 seqSpan，消费方按跨度理解连续性）。
        let mut run: Vec<CanonicalEventRow> = Vec::new();
        let mut run_base: Option<&'static str> = None;
        let mut run_bytes: usize = 0;
        // 落盘一段 run，返回本段已落盘的最大 sequence（无 run 时 None）。**不在这里改
        // `final_revision`**：循环内的那次 flush 之后，当前事件的两条分支都会各自推进编号
        // （必然更大），在那里记账是死写；只有循环外的收口调用才需要这个返回值。
        // `run_bytes` 同理不清零——它与 `run` 同生共死：只在 run 非空时被读（见 extend 判据），
        // 新 run 在下方重新赋值。
        macro_rules! flush_run {
            () => {{
                let mut last_flushed: Option<i64> = None;
                if !run.is_empty() {
                    let chunks = std::mem::take(&mut run);
                    let base = run_base.take();
                    let mut flushed: Vec<CanonicalEventRow> = Vec::with_capacity(1);
                    flush_delta_run(&mut flushed, chunks, base);
                    for row in flushed {
                        execute_insert_event(&tx, &row, None)?;
                        last_flushed = Some(row.sequence);
                        result_events.push(row);
                    }
                }
                last_flushed
            }};
        }
        for input in inputs {
            let event = normalize_kernel_event(input, final_revision + 1)?;
            let base = foldable_delta_base(&event);
            let extend = match (base, run.last(), run_base) {
                (Some(base), Some(last), Some(current)) => {
                    current == base
                        && event.sequence == last.sequence + 1
                        && identity_keys_equal(&last.identity, &event.identity)
                        && run.len() < MAX_FOLDED_CHUNKS
                        && run_bytes + raw_payload_bytes(&event) <= MAX_FOLD_BYTES
                }
                _ => false,
            };
            if extend {
                run_bytes += raw_payload_bytes(&event);
                final_revision = event.sequence;
                run.push(event);
                continue;
            }
            // 返回值不读：下面两条分支都会用当前事件的编号推进 final_revision（必然更大）。
            let _ = flush_run!();
            match base {
                // 单条自身就超预算的 delta 不成批（不截断，原样落盘）。
                Some(base) if raw_payload_bytes(&event) <= MAX_FOLD_BYTES => {
                    run_bytes = raw_payload_bytes(&event);
                    run_base = Some(base);
                    final_revision = event.sequence;
                    run.push(event);
                }
                _ => {
                    execute_insert_event(&tx, &event, None)?;
                    final_revision = event.sequence;
                    result_events.push(event.clone());

                    // #81 L2：终结事件 → 同一事务追加 turn 单元行（只加不减；未终结不折叠）。
                    // 单元构建失败不阻塞终态事实落盘（best effort：无单元的 turn 不被 L3 裁剪）。
                    if crate::turn_rollup::is_turn_terminal(&event.event_type) {
                        let prev_boundary: i64 = tx
                            .prepare_cached(LAST_TURN_BOUNDARY_SQL)
                            .map_err(EventError::from)?
                            .query_row(params![owner_key, event.sequence], |row| row.get(0))
                            .optional()
                            .map_err(EventError::from)?
                            .flatten()
                            .unwrap_or(0);
                        let turn_rows =
                            query_event_rows(&tx, &owner_key, prev_boundary + 1, event.sequence)?;
                        match crate::turn_rollup::build_turn_unit_row(
                            &event,
                            &turn_rows,
                            event.sequence + 1,
                        ) {
                            Ok(unit) => {
                                let unit_sequence = unit.sequence;
                                let inserted = execute_insert_event(
                                    &tx,
                                    &unit,
                                    unit.rollup_seq_start.zip(unit.rollup_seq_end),
                                )?;
                                // ON CONFLICT DO NOTHING 下 kernel 路径冲突不可达（sequence 恒新分配）；
                                // 防御：真被跳过时不得虚报写入/推进 revision（审核 P2）。
                                if inserted > 0 {
                                    result_events.push(unit);
                                    final_revision = unit_sequence;
                                }
                            }
                            Err(error) => {
                                tracing::warn!(
                                    owner = %owner_key,
                                    error = %error,
                                    "turn.unit 构建失败，本轮不折叠"
                                );
                            }
                        }
                    }
                }
            }
        }
        // 收口最后一段 run（未终结的尾巴也必须落盘——draft 尾巴不豁免，ADR-0016 决定 4）。
        // 这里没有后续事件来推进编号，故必须读回本段的最大 sequence。
        if let Some(sequence) = flush_run!() {
            final_revision = sequence;
        }
        if let Some(draft_id) = draft_id {
            tx.execute(
                "DELETE FROM canonical_draft_fragments WHERE owner_key = ?1 AND draft_id = ?2",
                params![owner_key, draft_id],
            )
            .map_err(EventError::from)?;
        }
        tx.commit().map_err(EventError::from)?;
        Ok(EventAppendResult {
            events: result_events,
            revision: final_revision,
        })
    }

    /// Return whether this owner already has a trusted local observation. Replay is only a
    /// recovery source when the journal has no such row; recovery-import rows never establish
    /// local authority and therefore cannot make a later replay overwrite local facts.
    pub(super) fn has_authoritative_local_events(
        &self,
        owner_key: &str,
    ) -> Result<bool, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let exists: i64 = conn
            .prepare_cached(
                "SELECT EXISTS(
                SELECT 1 FROM canonical_events
                WHERE owner_key = ?1 AND provenance = 0
            )",
            )
            .map_err(EventError::from)?
            .query_row(params![owner_key], |row| row.get::<_, i64>(0))
            .map_err(EventError::from)?;
        Ok(exists != 0)
    }

    /// #364：外部 CLI 历史导入的幂等探针——同 (agent_id, remote_session_id) 的
    /// external-import 行已存在即视为「该原生会话已导入」。v15 收窄后 agent_id
    /// 不落库（owner_key 派生），故按 owner_key 前缀 LIKE 匹配；`[`/`"` 在 LIKE
    /// 中是普通字符，agent_id 内的 `%`/`_` 按 #488 纪律转义。全表扫（无该组合
    /// 索引），导入是用户显式触发的冷路径；若成为瓶颈随 FTS 子卡一并立索引。
    /// remote_session_id 对外部导入即原生会话 id。
    pub(super) fn has_external_import(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<bool, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let escaped = agent_id.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let owner_prefix =
            format!("[\"{}\",\"{}\",\"%", pylon_canonical_types::EXTERNAL_IMPORT_PROFILE_ID, escaped);
        let exists: i64 = conn
            .prepare_cached(
                "SELECT EXISTS(
                SELECT 1 FROM canonical_events
                WHERE remote_session_id = ?1 AND provenance = 5 AND owner_key LIKE ?2 ESCAPE '\\'
            )",
            )
            .map_err(EventError::from)?
            .query_row(params![remote_session_id, owner_prefix], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(EventError::from)?;
        Ok(exists != 0)
    }

    /// 游标分页：返回 sequence < before_seq 的最新 limit 条（升序，无 OFFSET）。
    /// before_seq = None 取最新一页；上页最旧一条的 sequence 为下一页游标。
    pub fn list_events(
        &self,
        owner_key: &str,
        before_sequence: Option<i64>,
        limit: u32,
    ) -> Result<EventPage, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let mut stmt = conn
            .prepare_cached(&format!(
                "SELECT {EVENT_COLUMNS} FROM canonical_events
                 WHERE owner_key = ?1 AND (?2 IS NULL OR sequence < ?2)
                 ORDER BY sequence DESC
                 LIMIT ?3"
            ))
            .map_err(EventError::from)?;
        let rows = stmt
            .query_map(
                params![owner_key, before_sequence, i64::from(limit)],
                map_event_row,
            )
            .map_err(EventError::from)?;
        let mut events: Vec<CanonicalEventRow> = Vec::new();
        for row in rows {
            events.push(row.map_err(EventError::from)?.decode()?);
        }
        // DESC 查询 → 升序返回（与历史消息仓库分页语义一致；v9 后为 canonical 唯一读路径）
        events.reverse();
        let next_before_sequence = events.first().map(|e| e.sequence);
        Ok(EventPage {
            events,
            next_before_sequence,
        })
    }

    /// #51 收口：owner journal 里 sequence 最大的指定类型事件行（无则 None）。
    /// (owner_key, sequence) 聚簇主键倒序走查 + event_type 谓词命中即停，
    /// 供写入侧做「payload 未变不重复追加」的幂等判定；不承担一般查询职责
    /// （一般读路径走 list_events / load_events_compact）。
    pub fn latest_event_of_type(
        &self,
        owner_key: &str,
        event_type: &str,
    ) -> Result<Option<CanonicalEventRow>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let mut stmt = conn
            .prepare_cached(&format!(
                "SELECT {EVENT_COLUMNS} FROM canonical_events
                 WHERE owner_key = ?1 AND event_type = ?2
                 ORDER BY sequence DESC LIMIT 1"
            ))
            .map_err(EventError::from)?;
        let stored = stmt
            .query_row(params![owner_key, event_type], map_event_row)
            .optional()
            .map_err(EventError::from)?;
        stored.map(|row| row.decode()).transpose()
    }

    /// #442 Step1：回合边界判据的 tail 行（**升序**返回）。只取四类边界行的四个
    /// 标量列——判据（`crate::turn_boundary`）只消费 sequence/event_type 与两个
    /// 时间戳，不触任何载荷列；DESC 查询 + reverse 与 `list_events` 同语义。
    pub(super) fn turn_boundary_rows(
        &self,
        owner_key: &str,
        cap: u32,
    ) -> Result<Vec<crate::turn_boundary::TurnBoundaryRow>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT sequence, event_type, occurred_at, received_at FROM canonical_events
                 WHERE owner_key = ?1
                   AND event_type IN ('user.message', 'turn.completed', 'turn.failed', 'turn.unit')
                 ORDER BY sequence DESC LIMIT ?2",
            )
            .map_err(EventError::from)?;
        let mut rows: Vec<crate::turn_boundary::TurnBoundaryRow> = stmt
            .query_map(params![owner_key, cap], |row| {
                Ok(crate::turn_boundary::TurnBoundaryRow {
                    sequence: row.get(0)?,
                    event_type: row.get(1)?,
                    occurred_at: row.get(2)?,
                    received_at: row.get(3)?,
                })
            })
            .map_err(EventError::from)?
            .collect::<Result<_, _>>()
            .map_err(EventError::from)?;
        rows.reverse();
        Ok(rows)
    }

    /// #81 L2：compact 读——返回「单元 + 未覆盖行」（升序）。被 turn.unit 覆盖的
    /// 行不再读取（L3 裁剪后这些行已删除），前端读/解析行数随单元粒度下降。
    ///
    /// #205：过滤**不**下推成按跨度内联的 SQL 谓词（跨度过千时表达式深度/参数个数越线），
    /// 而是先用一条只取 `sequence/event_type` 两列的元数据扫描判定「这一行要不要」，再按
    /// 要的 sequence 取整行——被覆盖的行**不被解码成 `serde_json::Value` 树**（那一步才是
    /// 内存与耗时的大头：生产库单 owner 13.6 万行时整读解析峰值数百 MB）。
    ///
    /// #376-b：一次一页（升序、前向游标）。冷装载据此逐页续折，装载期不再出现「整库行 +
    /// 整库信封 + 文档」三份并存。
    ///
    /// **页边界落在 delta run 边界上**：页尾那个 run 若还在继续（页内前瞻行仍在同一 run），
    /// 本页延长到它闭合为止——否则读侧折叠的切点会随页边界漂移，分页折叠与一次性折叠就
    /// 不再逐位等价。延长量有界：`accepts` 自带 48 KiB / 2000 chunk 预算，run 在折叠口径下
    /// 本就有界，故至多再多取一个预算长度的候选行。
    pub fn load_events_compact_page(
        &self,
        owner_key: &str,
        after_sequence: Option<i64>,
        limit: u32,
    ) -> Result<CompactEventPage, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let limit = usize::try_from(limit.clamp(1, MAX_COMPACT_PAGE_LIMIT)).unwrap_or(1);
        // 1) 覆盖跨度（只取两列，不碰任何载荷）。
        let mut ranges: Vec<(i64, i64)> = Vec::new();
        {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT rollup_seq_start, rollup_seq_end FROM canonical_events
                     WHERE owner_key = ?1 AND event_type = ?2
                       AND rollup_seq_start IS NOT NULL AND rollup_seq_end IS NOT NULL
                     ORDER BY sequence ASC",
                )
                .map_err(EventError::from)?;
            for row in stmt
                .query_map(
                    params![owner_key, crate::turn_rollup::TURN_UNIT_EVENT_TYPE],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .map_err(EventError::from)?
            {
                ranges.push(row.map_err(EventError::from)?);
            }
        }
        // 2) 元数据扫描状态：只读 (sequence, event_type)，按跨度指针剪掉被覆盖行。
        let mut cursor = after_sequence;
        let mut pointer = 0usize;
        // 两个计数各管一件事，别混：
        // - `scan_budget` 限的是**本次 invoke 的扫描量**（含被覆盖行），用尽只意味着「本页到此
        //   为止」，游标必须继续前进——绝不能因此返回 None（那等于静默截断装载，见下方守卫）；
        // - `extend_budget` 只给「页尾 run 收口」那次延长用，与被覆盖行的多寡无关，否则一段
        //   长覆盖区就能把 run 切断（分页折叠的切点随之与一次性折叠分叉）。
        let mut scan_budget: usize = limit * 8 + 1024;
        let mut extend_budget: usize = MAX_FOLDED_CHUNKS + 2;
        let mut scan_exhausted = false;
        let mut stmt = conn
            .prepare_cached(
                "SELECT sequence, event_type FROM canonical_events
                 WHERE owner_key = ?1 AND (?2 IS NULL OR sequence > ?2)
                 ORDER BY sequence ASC LIMIT ?3",
            )
            .map_err(EventError::from)?;

        // 把候选行补到 `target` 行为止（或扫描到 journal 末尾）。返回时 `cursor` 指向
        // 最后一个**被扫描过**的 sequence（含被覆盖行），`scan_exhausted` 表示到头。
        let mut rows: Vec<CanonicalEventRow> = Vec::new();
        let mut collect_until = |target: usize,
                                 rows: &mut Vec<CanonicalEventRow>,
                                 cursor: &mut Option<i64>,
                                 pointer: &mut usize,
                                 budget: &mut usize,
                                 scan_exhausted: &mut bool|
         -> Result<(), EventError> {
            while rows.len() < target && !*scan_exhausted && *budget > 0 {
                let window = i64::try_from(target.saturating_sub(rows.len()) + 1).unwrap_or(1);
                let batch: Vec<(i64, String)> = stmt
                    .query_map(params![owner_key, *cursor, window], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(EventError::from)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(EventError::from)?;
                if batch.is_empty() {
                    *scan_exhausted = true;
                    break;
                }
                let short_window = batch.len() < usize::try_from(window).unwrap_or(1);
                *budget = budget.saturating_sub(batch.len());
                let mut wanted: Vec<i64> = Vec::new();
                for (sequence, event_type) in batch {
                    *cursor = Some(sequence);
                    while *pointer < ranges.len() && ranges[*pointer].1 < sequence {
                        *pointer += 1;
                    }
                    let covered = event_type != crate::turn_rollup::TURN_UNIT_EVENT_TYPE
                        && *pointer < ranges.len()
                        && ranges[*pointer].0 <= sequence;
                    if !covered {
                        wanted.push(sequence);
                    }
                }
                if !wanted.is_empty() {
                    rows.extend(query_events_by_sequence(&conn, owner_key, &wanted)?);
                }
                if short_window {
                    *scan_exhausted = true;
                    break;
                }
            }
            Ok(())
        };

        collect_until(
            limit + 1,
            &mut rows,
            &mut cursor,
            &mut pointer,
            &mut scan_budget,
            &mut scan_exhausted,
        )?;
        // 3) 页尾可能仍在 delta run 中（最后一行可折叠）⇒ 用**独立**预算把 run 收到闭合为止。
        //    独立是关键：覆盖区的多寡不得影响 run 的切点，否则「分页折 == 一次性折」不成立。
        //    这里不做前瞻判定（`rows[limit]` 在短页上不存在）；多收一点无害——切点由
        //    `last_run_boundary_index` 决定，收不齐就整页交付。
        if !scan_exhausted
            && rows
                .last()
                .is_some_and(|row| fold::foldable_delta_base(row).is_some())
        {
            collect_until(
                rows.len() + MAX_FOLDED_CHUNKS + 2,
                &mut rows,
                &mut cursor,
                &mut pointer,
                &mut extend_budget,
                &mut scan_exhausted,
            )?;
        }
        // 4) 定页长：到头 → 整份交付（无游标）；否则取窗口内最后一个已闭合 run 的末行。
        //    短页（扫描预算所限）整页交付，不再切；闭合点落在本页起点之前时退回 limit。
        let mut page_len = rows.len();
        if !scan_exhausted {
            page_len = match fold::last_run_boundary_index(&rows) {
                Some(boundary) if boundary + 1 >= limit => boundary + 1,
                _ if rows.len() <= limit => rows.len(),
                _ => limit,
            };
        }
        rows.truncate(page_len);
        // 游标：只要没扫到 journal 末尾就必须是 `Some`。空页时退回「最后一个被扫描过的
        // sequence」（含被覆盖行）——那是本页唯一可用的前进点。写成 `rows.last()` 会让空页
        // 拿到 `None`，前端与 repo 的循环都判定「到底」而停住，整段历史静默丢失。
        let next_after_sequence = if scan_exhausted {
            None
        } else {
            rows.last().map(|row| row.sequence).or(cursor)
        };
        Ok(CompactEventPage {
            events: fold::fold_adjacent_delta_runs(rows),
            next_after_sequence,
        })
    }

    /// #376-b：按 sequence 清单取整行（compact 分页的第二步；只取要的，一次取完）。
    /// #81 L2：compact 读**一次性**（分页读的循环封装）。生产读口已全部走
    /// `load_events_compact_page`（#376），本封装现仅测试使用——`#[cfg(test)]` 化
    /// （W3 重构批次 P9 清偿；行为零变化，生产调用方为零）。
    #[cfg(test)]
    pub fn load_events_compact(
        &self,
        owner_key: &str,
    ) -> Result<Vec<CanonicalEventRow>, EventError> {
        let mut out: Vec<CanonicalEventRow> = Vec::new();
        let mut cursor: Option<i64> = None;
        loop {
            let page = self.load_events_compact_page(owner_key, cursor, MAX_COMPACT_PAGE_LIMIT)?;
            out.extend(page.events);
            match page.next_after_sequence {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(out)
    }

    /// #81 L3：破坏性裁剪迁移（可暂停 / 续跑；sha256 校验通过才删行）。
    /// 逐 turn 单事务；进度落 `rollup_migration_state`（trimmed/mismatch 永久跳过）。
    /// budget_ms 用尽即在 turn 边界暂停；全部完成后 VACUUM 回收（仅当本次有删行）。
    pub fn rollup_trim(&self, budget_ms: Option<u64>) -> Result<RollupTrimReport, EventError> {
        let started = std::time::Instant::now();
        let mut report = RollupTrimReport::default();
        loop {
            if let Some(budget) = budget_ms {
                if report.processed_units > 0 && started.elapsed().as_millis() as u64 >= budget {
                    break;
                }
            }
            let claimed = self.claim_next_rollup_unit()?;
            let Some((owner_key, unit)) = claimed else {
                break;
            };
            report.processed_units += 1;
            let outcome = self.trim_one_unit(&owner_key, &unit)?;
            match outcome {
                RollupUnitOutcome::Trimmed => report.trimmed_units += 1,
                RollupUnitOutcome::AlreadyGone => report.resumed_units += 1,
                RollupUnitOutcome::ShaMismatch => report.mismatch_units += 1,
            }
        }
        report.remaining_units = self.count_remaining_rollup_units()?;
        // resumed>0 也可能对应"此前运行删行未回收"的收尾（审核 P2：避免漏 VACUUM）
        if report.remaining_units == 0 && (report.trimmed_units > 0 || report.resumed_units > 0) {
            let conn = self
                .conn
                .lock()
                .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
            conn.execute_batch("VACUUM").map_err(EventError::from)?;
            report.vacuumed = true;
        }
        Ok(report)
    }

    /// 取下一个未处理单元（state 表无 trimmed/mismatch 记录；单事务内落 'verifying'）。
    fn claim_next_rollup_unit(&self) -> Result<Option<(String, CanonicalEventRow)>, EventError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM canonical_events e
             WHERE e.event_type = 'turn.unit'
               AND NOT EXISTS (SELECT 1 FROM rollup_migration_state s
                               WHERE s.owner_key = e.owner_key AND s.unit_event_id = e.owner_key || '#' || e.sequence
                                 AND s.state IN ('trimmed', 'mismatch'))
             ORDER BY e.sequence ASC LIMIT 1"
        );
        let mapped = tx
            .prepare_cached(&sql)
            .map_err(EventError::from)?
            .query_row([], map_event_row)
            .optional()
            .map_err(EventError::from)?;
        let Some(stored) = mapped else {
            return Ok(None);
        };
        let unit = stored.decode()?;
        let owner_key = unit.owner_key.clone();
        tx.prepare_cached(
            "INSERT OR IGNORE INTO rollup_migration_state (owner_key, unit_event_id, state, updated_at)
             VALUES (?1, ?2, 'verifying', ?3)",
        )
        .map_err(EventError::from)?
        .execute(params![owner_key, unit.event_id, now_millis()])
        .map_err(EventError::from)?;
        tx.commit().map_err(EventError::from)?;
        Ok(Some((owner_key, unit)))
    }

    /// 校验并裁剪单个单元（独立事务；行已被删/校验失败均不删行）。
    fn trim_one_unit(
        &self,
        owner_key: &str,
        unit: &CanonicalEventRow,
    ) -> Result<RollupUnitOutcome, EventError> {
        let span = match (unit.rollup_seq_start, unit.rollup_seq_end) {
            (Some(start), Some(end)) => (start, end),
            // 迁移回填前的防御分支：从 typedPayload JSON 解析
            _ => {
                // 与"缺 seqStart/seqEnd"同口径：防御分支一律保留行并永久跳过，
                // 不得让整个迁移卡死（审核 P1：缺 typedPayload 曾直接 Err）。
                let Some(typed) = unit.typed_payload.clone() else {
                    return Ok(RollupUnitOutcome::ShaMismatch);
                };
                let start = typed.get("seqStart").and_then(serde_json::Value::as_i64);
                let end = typed.get("seqEnd").and_then(serde_json::Value::as_i64);
                match (start, end) {
                    (Some(start), Some(end)) => (start, end),
                    _ => return Ok(RollupUnitOutcome::ShaMismatch),
                }
            }
        };
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let rows = query_event_rows(&tx, owner_key, span.0, span.1)?;
        if rows.is_empty() {
            // 续跑：行已删除（上次运行在标记前中断）→ 只补标记
            Self::mark_rollup_state(&tx, owner_key, &unit.event_id, "trimmed")?;
            tx.commit().map_err(EventError::from)?;
            return Ok(RollupUnitOutcome::AlreadyGone);
        }
        // #380-b：重折必须按**单元自己记录的方案**——方案一变，同一批行折出的 segments 就不同，
        // 认错方案会让旧单元永远 ShaMismatch（保留行、永久跳过，等于迁移停摆）。
        let scheme = unit
            .typed_payload
            .as_ref()
            .and_then(|typed| typed.get("foldScheme"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let rebuilt = crate::turn_rollup::fold_turn_rows_with_scheme(&rows, scheme.as_deref());
        let expected = unit
            .typed_payload
            .as_ref()
            .and_then(|typed| typed.get("contentSha256"))
            .and_then(serde_json::Value::as_str);
        if expected != Some(rebuilt.content_sha256.as_str()) {
            // 折叠前后文本等价校验失败：保留行（不丢弃），永久跳过并计入
            Self::mark_rollup_state(&tx, owner_key, &unit.event_id, "mismatch")?;
            tx.commit().map_err(EventError::from)?;
            return Ok(RollupUnitOutcome::ShaMismatch);
        }
        tx.prepare_cached("DELETE FROM canonical_events WHERE owner_key = ?1 AND sequence >= ?2 AND sequence <= ?3")
            .map_err(EventError::from)?
            .execute(params![owner_key, span.0, span.1])
            .map_err(EventError::from)?;
        Self::mark_rollup_state(&tx, owner_key, &unit.event_id, "trimmed")?;
        tx.commit().map_err(EventError::from)?;
        Ok(RollupUnitOutcome::Trimmed)
    }

    fn mark_rollup_state(
        tx: &rusqlite::Transaction<'_>,
        owner_key: &str,
        unit_event_id: &str,
        state: &str,
    ) -> Result<(), EventError> {
        tx.prepare_cached(
            "INSERT INTO rollup_migration_state (owner_key, unit_event_id, state, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(owner_key, unit_event_id) DO UPDATE SET state = ?3, updated_at = ?4",
        )
        .map_err(EventError::from)?
        .execute(params![owner_key, unit_event_id, state, now_millis()])
        .map_err(EventError::from)?;
        Ok(())
    }

    pub fn count_remaining_rollup_units(&self) -> Result<i64, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let remaining: i64 = conn
            .prepare_cached(
                "SELECT COUNT(*) FROM canonical_events e
                 WHERE e.event_type = 'turn.unit'
                   AND NOT EXISTS (SELECT 1 FROM rollup_migration_state s
                                   WHERE s.owner_key = e.owner_key AND s.unit_event_id = e.owner_key || '#' || e.sequence
                                     AND s.state IN ('trimmed', 'mismatch'))",
            )
            .map_err(EventError::from)?
            .query_row([], |row| row.get(0))
            .map_err(EventError::from)?;
        Ok(remaining)
    }

    pub fn export_raw_event(
        &self,
        event_id: &str,
    ) -> Result<Option<CanonicalEventRawExport>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        // v15 无 event_id 列：eventId = owner_key#sequence（rule 1），按最后一个 '#'
        // 拆分（owner_key 是 JSON 数组文本，串内可含 '#'，sequence 后缀不含）。
        let Some((owner_key, sequence_text)) = event_id.rsplit_once('#') else {
            return Ok(None);
        };
        let Ok(sequence) = sequence_text.parse::<i64>() else {
            return Ok(None);
        };
        let export = conn
            .prepare_cached(
                "SELECT event_type, identity, typed_payload, raw_payload
             FROM canonical_events WHERE owner_key = ?1 AND sequence = ?2",
            )
            .map_err(EventError::from)?
            .query_row(params![owner_key, sequence], |row| {
                Ok(CanonicalEventRawExport {
                    event_id: event_id.to_string(),
                    owner_key: owner_key.to_string(),
                    sequence,
                    event_type: row.get(0)?,
                    identity_json: row.get(1)?,
                    typed_payload_json: row.get(2)?,
                    raw_payload_json: row.get(3)?,
                })
            })
            .optional()
            .map_err(EventError::from)?;
        Ok(export)
    }

    /// B6 / #445：跨 owner 内容搜索——在 raw_payload / typed_payload / event_type 上做
    /// 大小写不敏感 LIKE，返回**命中行**定位（owner 三元组 + sequence/event_type/
    /// occurred_at + instr 偏移）。WHERE 三列与 pattern 构造与候选 owner 版一字不改
    /// （recall 不变）；`lower()` 是 ASCII 折叠，与 NOCASE 语义对齐。#488 批③：query
    /// 中的 LIKE 通配符（`%`/`_`）与转义符 `\` 一律按**字面量**匹配（`ESCAPE '\'`），
    /// 用户输入不再被解释成通配符；instr 定位仍用原 query，offset 语义不变。
    /// 前端对命中行定向拉行后投影复核（匹配与命中同源）。limit 为命中行上限。
    pub fn search_hits(&self, query: &str, limit: u32) -> Result<Vec<EventSearchHit>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        // #488 批③：先转义转义符本身，再转义 `%`/`_`——顺序不可换（否则转义引入的
        // 反斜杠会被二次转义）。
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        let mut stmt = conn
            .prepare_cached(
                "SELECT owner_key, remote_session_id, sequence, event_type, occurred_at,
                        NULLIF(instr(lower(raw_payload), lower(?2)), 0),
                        NULLIF(instr(lower(COALESCE(typed_payload, '')), lower(?2)), 0)
                 FROM canonical_events
                 WHERE event_type LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                    OR raw_payload LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                    OR COALESCE(typed_payload, '') LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                 ORDER BY owner_key, sequence",
            )
            .map_err(EventError::from)?;
        let rows = stmt
            .query_map(params![pattern, query], |row| {
                let owner_key: String = row.get(0)?;
                let (profile_id, agent_id, local_session_id) = owner_triple(&owner_key);
                Ok(EventSearchHit {
                    profile_id,
                    agent_id,
                    local_session_id,
                    remote_session_id: row.get(1)?,
                    sequence: row.get(2)?,
                    event_type: row.get(3)?,
                    occurred_at: row.get::<_, String>(4)?,
                    match_offset: row
                        .get::<_, Option<i64>>(5)?
                        .or(row.get::<_, Option<i64>>(6)?),
                })
            })
            .map_err(EventError::from)?;
        let mut hits = Vec::new();
        for row in rows {
            hits.push(row.map_err(EventError::from)?);
        }
        // 与候选 owner 版（v15）一致的排序截断语义：按 (profile, agent, local) 排序
        // 后截断；稳定排序保留 SQL 侧 owner 内 sequence 升序。
        hits.sort_by(|a, b| {
            (&a.profile_id, &a.agent_id, &a.local_session_id).cmp(&(
                &b.profile_id,
                &b.agent_id,
                &b.local_session_id,
            ))
        });
        hits.truncate(limit as usize);
        Ok(hits)
    }
}
