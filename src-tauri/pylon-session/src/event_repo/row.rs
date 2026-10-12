//! canonical 事件行：行结构、存储行编解码（列 ↔ wire 字段）与 wire DTO。

use serde::Serialize;

use super::provenance::{derive_raw_metadata, owner_triple, provenance_parts};
use super::EventError;
use crate::owner::DurableSessionOwner;

/// canonical 事件行（canonical_events 表）。camelCase wire 与 EVT-01 schema 对齐；
/// identity/typed_payload/raw_payload 以 JSON 文本存取，回读原样还原。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalEventRow {
    pub event_id: String,
    pub owner_key: String,
    pub profile_id: String,
    pub agent_id: String,
    pub local_session_id: String,
    pub remote_session_id: Option<String>,
    pub client_generation: i64,
    pub sequence: i64,
    pub occurred_at: String,
    pub received_at: String,
    pub event_type: String,
    pub payload_version: i64,
    pub identity: Option<serde_json::Value>,
    pub typed_payload: Option<serde_json::Value>,
    pub raw_payload: serde_json::Value,
    pub created_at: i64,
    pub schema_version: i64,
    pub provenance_origin: String,
    pub provenance_trust: String,
    pub provenance_provider: Option<String>,
    pub provenance_import_id: Option<String>,
    pub raw_truncated: bool,
    pub raw_original_bytes: i64,
    pub raw_retained_bytes: i64,
    pub raw_omitted_bytes: i64,
    pub raw_truncation_reason: Option<String>,
    /// raw_payload 的入库序列化文本（与 `raw_payload.to_string()` 逐字节相等）。
    /// 写路径由 retain_raw_payload 直接产出复用（INSERT 免二次序列化）；
    /// 读路径承接 raw_payload_json 列原文。不入 wire（serde skip）。
    #[serde(skip)]
    pub raw_payload_json: String,
    /// #81 L2/L3：turn.unit 行的覆盖跨度（其余事件为 NULL）。裁剪迁移的查询列。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollup_seq_start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollup_seq_end: Option<i64>,
}

pub(super) struct StoredCanonicalEventRow {
    event: CanonicalEventRow,
    identity_json: Option<String>,
    typed_payload_json: Option<String>,
    raw_payload_json: String,
}

impl StoredCanonicalEventRow {
    pub(super) fn decode(mut self) -> Result<CanonicalEventRow, EventError> {
        let event_id = self.event.event_id.clone();
        self.event.identity = self
            .identity_json
            .map(|json| decode_event_json(&event_id, "identity", &json))
            .transpose()?;
        self.event.typed_payload = self
            .typed_payload_json
            .map(|json| decode_event_json(&event_id, "typed_payload", &json))
            .transpose()?;
        self.event.raw_payload =
            decode_event_json(&event_id, "raw_payload", &self.raw_payload_json)?;
        // 承接列原文作为入库文本缓存（读路径不重新序列化）。
        self.event.raw_payload_json = std::mem::take(&mut self.raw_payload_json);
        Ok(self.event)
    }
}

fn decode_event_json(
    event_id: &str,
    column: &str,
    json: &str,
) -> Result<serde_json::Value, EventError> {
    serde_json::from_str(json).map_err(|error| {
        EventError::Corrupt(format!(
            "event={event_id} column={column} invalid JSON ({} bytes): {error}",
            json.len()
        ))
    })
}

/// append 结果：实际写入事件（跳过 event_id 去重）+ 该 owner 最新 sequence（revision）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventAppendResult {
    pub events: Vec<CanonicalEventRow>,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayJournalIngestResult {
    pub events: Vec<CanonicalEventRow>,
    pub revision: i64,
    pub status: &'static str,
}

/// #364 外部 CLI 历史导入结果。status 词表（前端按此分支，不得改拼写）：
/// `imported`（本批已落库）/ `already-imported`（同 (agent_id, remote_session_id)
/// 已存在且未 force，0 写入）。force 分叉由调用方先行生成新 local_session_id，
/// 对本层只是普通导入。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHistoryImportResult {
    pub events: Vec<CanonicalEventRow>,
    pub revision: i64,
    pub status: &'static str,
}

/// 事件写入来源的三值判别（#364 前是 `recovery_import: bool`）：决定
/// `normalize_kernel_event` 落的 provenance 组合——`Live` 是 kernel 单写者的
/// local-observed/authoritative；两个导入变体恒 unverified（`external-import`
/// 永不为 authoritative，见 provenance 编码表）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EventImportOrigin {
    Live,
    RecoveryImport,
    ExternalImport,
}

/// Kernel ingest 输入。owner 来自已证明的 runtime session 绑定；remote id 仅是
/// 当前 binding，raw payload 永久保留。sequence 由 EventRepo 事务内分配。
#[derive(Debug, Clone)]
pub(super) struct KernelEventInput {
    pub(super) owner: DurableSessionOwner,
    pub(super) remote_session_id: Option<String>,
    pub(super) client_generation: i64,
    pub(super) received_at: String,
    /// 事件真实发生时间（RFC3339）。live/replay 路径恒 None（＝ received_at，
    /// 内核观察时刻）；#364 外部导入给源文件时间戳——occurred_at 保留原生会话
    /// 的时序事实，received_at 才是「何时导入」。
    pub(super) occurred_at: Option<String>,
    /// #334/P2：dispatcher 逐帧热路径把同一份 payload 以 `Arc<Value>` 共享给
    /// ingest 与 publish（ingest 先行、publish 随后取回唯一引用），故此处共享
    /// 传入而非消费式拥有；normalize 取 redact 所有权时才解包（计数非 1 再克隆）。
    pub(super) raw_payload: std::sync::Arc<serde_json::Value>,
    pub(super) import_origin: EventImportOrigin,
}

/// 事件页（游标分页，升序）：事件 + 下一页游标（None = 已到最早，无更旧事件）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<CanonicalEventRow>,
    pub next_before_sequence: Option<i64>,
}

/// #376-b：compact 读的一页（升序）。游标是**前向**的（`after_sequence`），因为冷装载按
/// 「由旧到新」续折；`None` = 已到最新，装载可以收尾。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactEventPage {
    pub events: Vec<CanonicalEventRow>,
    pub next_after_sequence: Option<i64>,
}

/// evt_search 命中行（#445）：内容命中 canonical_events 的行定位 + owner 三元组。
/// 前端只对命中行定向拉行（`evt_load_compact`）后投影复核，不再按候选 owner 全量
/// 拉事件流——匹配与命中同源，IPC 载荷从「候选 owner 全量行」降为「命中行集」。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchHit {
    pub profile_id: String,
    pub agent_id: String,
    pub local_session_id: String,
    pub remote_session_id: Option<String>,
    pub sequence: i64,
    pub event_type: String,
    pub occurred_at: String,
    /// `instr(lower(列), lower(query))` 首偏移（1-based）；None = 命中列上按字面
    /// 定位不到（仅 event_type 列命中时）。#488 批③起 query 的 LIKE 通配符按
    /// 字面量转义（`ESCAPE '\'`），不再出现「LIKE 命中而 instr 找不到字面量」的
    /// 通配符分叉。advisory：前端 v1 不消费，定位与 snippet 一律以投影文本为准。
    pub match_offset: Option<i64>,
}

/// Forensic export deliberately bypasses JSON decoding so one corrupt row can be isolated without
/// making the rest of the owner stream appear healthy or leaking payload text into error logs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalEventRawExport {
    pub event_id: String,
    pub owner_key: String,
    pub sequence: i64,
    pub event_type: String,
    pub identity_json: Option<String>,
    pub typed_payload_json: Option<String>,
    pub raw_payload_json: String,
}

/// 事件行映射（v15 EVENT_COLUMNS 列序 → StoredCanonicalEventRow；list/compact/trim 共用）。
/// 派生字段（event_id/owner 三元组/provenance 四字段/raw_* 计数）在此还原。
pub(super) fn map_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredCanonicalEventRow> {
    let owner_key: String = row.get(0)?;
    let sequence: i64 = row.get(2)?;
    let identity: Option<String> = row.get(8)?;
    let typed: Option<String> = row.get(9)?;
    let raw: String = row.get(10)?;
    let (profile_id, agent_id, local_session_id) = owner_triple(&owner_key);
    let (provenance_origin, provenance_trust, provenance_provider, provenance_import_id) =
        provenance_parts(row.get(12)?, &agent_id, &local_session_id);
    let (
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
        raw_truncation_reason,
    ) = derive_raw_metadata(&raw);
    Ok(StoredCanonicalEventRow {
        event: CanonicalEventRow {
            event_id: pylon_canonical_types::canonical_event_id(&owner_key, sequence),
            owner_key,
            profile_id,
            agent_id,
            local_session_id,
            remote_session_id: row.get(1)?,
            client_generation: row.get(3)?,
            sequence,
            occurred_at: row.get(4)?,
            received_at: row.get(5)?,
            event_type: row.get(6)?,
            payload_version: row.get(7)?,
            identity: None,
            typed_payload: None,
            raw_payload: serde_json::Value::Null,
            raw_payload_json: String::new(),
            created_at: row.get(11)?,
            schema_version: 1,
            provenance_origin,
            provenance_trust,
            provenance_provider,
            provenance_import_id,
            raw_truncated,
            raw_original_bytes,
            raw_retained_bytes,
            raw_omitted_bytes,
            raw_truncation_reason,
            rollup_seq_start: row.get(13)?,
            rollup_seq_end: row.get(14)?,
        },
        identity_json: identity,
        typed_payload_json: typed,
        raw_payload_json: raw,
    })
}
