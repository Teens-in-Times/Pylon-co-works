//! EVT-02：canonical 事件仓库（SQLite 持久化，方案书 §5.10）。
//!
//! 与消息仓库共用同一 SQLite 文件（`pylon-data-v1.sqlite3`，schema 由 msg_repo 的
//! 统一迁移链管理——`SCHEMA_SQL` v6 新增 `canonical_events` 表，`connect()` 复用）；
//! 本模块持独立 Connection（busy_timeout 序列化同文件写）。
//!
//! 契约（§5.10 迁移原则）：
//! - 原则 1：新事件表先上线；B7（v9）起旧 messages/MessageRecord 已删除，
//!   `canonical_events` 是唯一会话数据源。
//! - 原则 5：unknown event 不得静默丢弃——`raw_payload` 恒存（NOT NULL）。
//! - rule 1：event_id = `owner_key#sequence` 确定性推导（禁 content 哈希）。
//! - rule 3：sequence 按 owner/session 范围分配——`UNIQUE(owner_key, sequence)`；
//!   owner_key 为 JSON 数组序列化（禁冒号拼接，与 `toCanonicalOwnerKey` 同纪律）。
//! - rule 4：payloadVersion 版本化；occurred_at/received_at 存原始 ISO 文本。
//! - append 输入按 unknown 处理（前端 EVT-01 schema 序列化 JSON；TS 类型在此失效），
//!   后端做结构校验（不抛异常，返回问题列表式错误），坏形状拒绝写入而非静默丢弃。
//! - 本表不设 FK（事件流先于/独立于 messages 会话行）；DEL-04 起 append 显式查
//!   deleted_sessions 做 tombstone gate（deleting/deleted 均拒绝，不复活已删会话）。
//!
//! 同步访问（`Mutex<Connection>`，SQLite 单写者）；上层须经 spawn_blocking 调用。
//!
//! 模块划分（#228 批次D 拆分，对外名称经本文件 re-export，消费路径不变）：
//! `row` 行结构与存储行编解码；`provenance` provenance 编码与读侧派生；
//! `redaction` 凭据脱敏策略单点（含 raw 截断保留）；`normalize` kernel/EVT-01
//! 归一化与 wire 序列化；`fold` delta 折叠/rollup 压缩；`repo` 仓库本体（打开/
//! 写入/查询/裁剪调度）；`service` spawn_blocking 门面；`error` 结构化错误。

#[cfg(test)]
use std::sync::Arc;

#[cfg(test)]
use rusqlite::{params, OptionalExtension};

#[cfg(test)]
use crate::owner::DurableSessionOwner;

mod draft;
mod error;
mod fold;
mod normalize;
mod provenance;
mod redaction;
mod repo;
mod row;
mod service;

pub use draft::{
    draft_candidate, DraftCandidate, DraftCommitChunk, DraftFragment, DraftFragmentInput,
};
pub use error::EventError;
pub use fold::{row_input_span_width, MAX_FOLDED_CHUNKS, MAX_FOLD_BYTES};
pub use normalize::{canonical_event_wire, parse_canonical_event};
// `EventRepo` 的 crate 内直接消费者（del01/03/05 审计模块）均为 cfg(test)，
// 非 test 构建下本 re-export 无使用点，属预期。
#[allow(unused_imports)]
pub use repo::EventRepo;
pub use repo::RollupTrimReport;
pub use row::{
    CanonicalEventRawExport, CanonicalEventRow, CompactEventPage, EventAppendResult, EventPage,
    EventSearchHit, ExternalHistoryImportResult,
};
pub use service::EventService;

#[cfg(test)]
use normalize::{mark_replay_import, now_millis};
#[cfg(test)]
use redaction::MAX_CANONICAL_RAW_BYTES;
#[cfg(test)]
use row::KernelEventInput;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod fold_tests;

#[cfg(test)]
mod draft_bench;
