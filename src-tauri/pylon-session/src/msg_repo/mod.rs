//! 会话仓库：SQLite 持久化（sessions / deleted_sessions / user_data /
//! retention_policy / canonical_events）。
//!
//! 契约：
//! - `canonical_events` 是唯一会话历史权威（A1-c + B7）。v11 升级不再物理删除
//!   v8 message 表：可证明部分回填到同一 journal，全部源表改名保留供取证。
//! - `canonical_events` append-only 事件流由 event_repo 读写；本模块负责统一
//!   schema 迁移与 sessions/tombstone/retention/user_data 同库持久化。
//! - 同步访问（`Mutex<Connection>`，SQLite 单写者）；上层须经 spawn_blocking
//!   调用，不得在 async 执行器线程上直接执行。

use crate::user_data::UserDataError;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::SessionError;

/// 当前 schema 版本（PRAGMA user_version）。新增迁移必须同步递增。
/// v3：I14-W5 增加 user_data 表（versioned Profile/Session/activeProfileId 后端存储）。
/// v4：I14-W7 增加 deleted_sessions 表（tombstone——删除的会话拒绝迟到写复活）。
/// v5：I14-W9 增加 retention_policy 表（versioned 保留策略 + revision 后端权威存储）。
/// v6：EVT-02 增加 canonical_events 表（canonical 事件流——方案书 §5.10 迁移原则 1：
///     新表先上线，旧 messages/MessageRecord 不删除；append-only + owner 维 sequence）。
/// v7：DEL-02 升级 deleted_sessions 为 owner/deletion state（方案书 §5.12——现有 tombstone
///     加 owner_key/state/deletion_revision/reason；兼容旧行视为 deleted；不重复建第二套）。
/// v8：会话级可恢复状态快照列 session_state（usage/commands 等）。
/// v9：历史版本曾删除 messages/send_attempts/message_migrations；v11 起旧库升级改为归档。
/// v10：会话状态快照改用完整 durable owner 键；旧 sessions.state 只做保留/可证明迁移。
/// v11：旧 message 表不再直接 DROP；可证明消息 backfill 为同 journal snapshot，原表
///      事务内改名为 forensic archive，并写 legacy_message_backfill_audit。
/// v12：deleted_sessions 原表迁移为 owner_key 主键；legacy tombstone 显式标 scope，
///      v11 源表保留为 forensic archive，避免同 source 多 owner 互相覆盖。
/// v13：canonical_events 增加 versioned envelope/provenance/raw 截断元数据；旧行
///      append-only 保留并默认标记 migration/unverified。
/// v14：#81 L2/L3 rollup 覆盖跨度列 + rollup_migration_state 进度表。
/// v15：#155 T2 破坏性重建（ADR-0008「老数据全丢」）——canonical_events 瘦身为 15 列、
///      (owner_key, sequence) WITHOUT ROWID 主键（event_id/owner 分维列/provenance 五组合/
///      raw_* 计数改为读侧派生，wire 28 字段契约不变）；删死表 sessions 与
///      legacy_message_backfill_audit；auto_vacuum=INCREMENTAL + application_id。旧库
///      （user_version < 15）不搬迁任何行：保留 user_data.profiles 与 retention_policy，
///      其余历史（canonical_events/墓碑/快照/user_data.sessions）丢弃重建。
/// v16：#155 T3 临时片段表；v15 升版只加表，既有 canonical 历史原样保留。
pub const SCHEMA_VERSION: i64 = 16;

/// Pylon 数据库头标识（PRAGMA application_id，'PYLN' 大端）。诊断用途：文件被误认成
/// 其他应用数据时可据此识别。
pub const PYLON_APPLICATION_ID: i64 = 0x5059_4C4E;

/// 当前 schema DDL（CREATE IF NOT EXISTS；v15→v16 仅加临时表，旧于 v15 仍重建）。
/// - session_state_snapshots：usage/commands 等可恢复快照（不是历史存储）。
/// - user_data：versioned Profile/Session/activeProfileId（与会话同库）。
/// - deleted_sessions：DEL-02 owner/deletion state tombstone（deleting/deleted）。
/// - retention_policy：保留策略后端权威存储（单行）。
/// - canonical_events：canonical 事件流（append-only；唯一会话历史权威）。
/// - canonical_draft_fragments：在途临时片段，不进入 evt_* 历史读。
/// - rollup_migration_state：#81 L3 裁剪迁移进度。
const SCHEMA_SQL: &str = r#"
-- v10：usage/commands 等可恢复快照。它不是历史存储；canonical_events 仍是唯一 durable
-- history。remote_session_id 仅记录最近映射，不参与 identity 或查询主键。
CREATE TABLE IF NOT EXISTS session_state_snapshots (
    owner_key TEXT PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    local_session_id TEXT NOT NULL,
    remote_session_id TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(profile_id, agent_id, local_session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_state_snapshots_remote
    ON session_state_snapshots(agent_id, remote_session_id);
-- I14-W5：用户数据仓库（versioned Profile/Session/activeProfileId）——与消息同库。
-- key ∈ {profiles, sessions}；version = envelope version；revision 单调递增（乐观并发）；
-- payload = 前端 envelope 原文（自描述含 version）；原子写/损坏报错见 user_data.rs。
CREATE TABLE IF NOT EXISTS user_data (
    key TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
-- I14-W7 + DEL-02（v7）：会话删除 tombstone——删除时写入本表；touch/append 先查本表，
-- 命中即拒绝（session_deleted），防止 controller/scheduler 迟到写复活已删会话。
-- DEL-02（方案书 §5.12）：升级为 owner/deletion state——owner_key（JSON 数组序列化，
-- [profileId, agentId, localSessionId]，与 event_repo 同纪律）、state（deleting/deleted，
-- 兼容旧行恒为 deleted）、deletion_revision（删除 revision 乐观并发）、reason（删除原因）。
-- v12 以 owner_key 为唯一 identity；session_id 仅供 legacy wildcard gate 与诊断。
-- owner_scope=exact 只 gate 该 owner；legacy gate 同 local_session_id 的所有 owner。
CREATE TABLE IF NOT EXISTS deleted_sessions (
    owner_key TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    owner_scope TEXT NOT NULL CHECK (owner_scope IN ('exact', 'legacy')),
    deleted_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'deleted',
    deletion_revision INTEGER NOT NULL DEFAULT 0,
    reason TEXT
);
-- DEL-02（§5.12 索引建议）：deleting/deleted 列表过滤与 legacy session_id 诊断扫描。
CREATE INDEX IF NOT EXISTS idx_deleted_sessions_state_deleted_at
    ON deleted_sessions (state, deleted_at);
CREATE INDEX IF NOT EXISTS idx_deleted_sessions_session_id
    ON deleted_sessions (session_id);
-- I14-W9：保留策略后端权威存储（单行；version + revision 乐观并发；payload 为
-- RetentionPolicy JSON——mode/days/count 档位契约见 retention.rs）。
CREATE TABLE IF NOT EXISTS retention_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
-- EVT-02（v6）+ B7（v9）+ #155 T2（v15 瘦身）：canonical 事件流表（方案书 §5.10
-- append-only 事件模型）。本表是唯一会话历史权威。
-- 原则 5：unknown event 不得静默丢弃——raw_payload 恒存。owner_key = JSON 数组序列化
-- （禁冒号拼接，与 toCanonicalOwnerKey 同纪律）；(owner_key, sequence) 为主键且
-- WITHOUT ROWID（聚簇即按 owner+sequence 排列，取代 v14 的 event_id 主键 +
-- UNIQUE(owner_key,sequence) 自动索引 + idx_session_seq 三棵重复 btree）。
-- 派生列契约（读侧 `derive` 不落库，wire 28 字段形状不变）：
--   event_id = owner_key#sequence（rule 1 确定性推导）；profile/agent/local_session_id =
--   解析 owner_key；schema_version 恒 1；provenance 列是 (origin,trust) 六组合的整数编码
--   （0=local-observed/authoritative，1=recovery-import/unverified，2=optimistic-local，
--   3=migration，4=plugin，5=external-import/unverified（#364 外部 CLI 历史导入，
--   永不为 authoritative）；provider=agent_id[0/1/5]，import_id=local_session_id[1/5]）；
--   raw_* 截断计数由 raw_payload 文本自描述重算（截断 stub 自带 _pylonTruncated/
--   originalBytes）。本表不设 FK（事件流独立于会话行；删除语义由 DEL-02 tombstone 承担）。
CREATE TABLE IF NOT EXISTS canonical_events (
    owner_key TEXT NOT NULL,
    remote_session_id TEXT,
    sequence INTEGER NOT NULL,
    client_generation INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_version INTEGER NOT NULL,
    identity TEXT,
    typed_payload TEXT,
    raw_payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    provenance INTEGER NOT NULL DEFAULT 3,
    -- #81 L2/L3：turn.unit 行的覆盖跨度（其余事件 NULL）。
    rollup_seq_start INTEGER,
    rollup_seq_end INTEGER,
    PRIMARY KEY (owner_key, sequence)
) WITHOUT ROWID;
-- #155 T3（ADR-0026）：仅供在途显示/恢复的追加片段。它们不是 canonical 历史，
-- 不推进 evt_revision，不参与 evt_list/evt_load_compact。正式行提交时同事务删除。
CREATE TABLE IF NOT EXISTS canonical_draft_fragments (
    owner_key TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    fragment_index INTEGER NOT NULL CHECK (fragment_index >= 0),
    client_generation INTEGER NOT NULL,
    remote_session_id TEXT,
    event_type TEXT NOT NULL,
    identity TEXT,
    raw_payload TEXT NOT NULL,
    first_received_at TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_key, draft_id, fragment_index)
) WITHOUT ROWID;
-- #81 L3：裁剪迁移进度（逐 turn 单事务；trimmed/mismatch 永久跳过 => 可暂停/续跑）。
CREATE TABLE IF NOT EXISTS rollup_migration_state (
    owner_key TEXT NOT NULL,
    unit_event_id TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_key, unit_event_id)
);
"#;

/// 会话仓库：单一 SQLite 连接 + 互斥（SQLite 单写者）。
pub struct MsgRepo {
    conn: Mutex<Connection>,
}

/// #110 F3：墓碑事件清扫的宽限期（天）——已终态墓碑超过该期限，其遗留事件即可回收。
/// 7 天给「误删取证/恢复」留窗口，同时不让垃圾无限累积。
pub const TOMBSTONE_EVENT_GRACE_DAYS: i64 = 7;

/// #110 F3：墓碑事件清扫结果（记账/断言用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TombstonePurgeOutcome {
    /// 本次纳入清扫的墓碑数（state='deleted' 且超过宽限期）。
    pub tombstones: i64,
    /// 实际删除的 canonical_events 行数。
    pub events_deleted: i64,
}

/// I14-W9：保留策略行（单行；version + revision + payload JSON；wire camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicyRow {
    pub version: i64,
    pub revision: i64,
    pub payload: String,
}

/// I14-W9：保留候选（preview）与执行结果（prune）的每会话计数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCandidateCount {
    pub session_id: String,
    pub count: i64,
}

/// I14-W9：保留 preview/prune 结果（preview 不删除；prune 返回实际删除计数）。
/// I13-W4：增 affected_sessions / oldest_deleted_at（by_time 为 cutoff，其余 None）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPreview {
    pub total_candidates: i64,
    pub affected_sessions: i64,
    /// by_time：最早将被删除的 cutoff（毫秒）；by_count/permanent：None。
    pub oldest_deleted_at: Option<i64>,
    pub per_session: Vec<SessionCandidateCount>,
}

/// MessageService 结构化错误（B1.2：前端按 code 分支，message 展示用）。
/// ISSUE-20 W4：rusqlite 错误不再全部折叠为 unavailable——按 SQLite 错误码区分
/// corrupt（库损坏/非库文件）/ constraint（约束冲突）/ conflict（并发锁）/
/// unavailable（其余不可用），前端可据 code 区分诊断与重试策略。
#[derive(Debug, thiserror::Error)]
pub enum MessageError {
    /// SQLITE_CORRUPT / SQLITE_NOTADB：数据库镜像损坏或非数据库文件。
    #[error("消息仓库损坏：{0}")]
    Corrupt(String),
    /// SQLITE_CONSTRAINT：唯一性/FK 等约束冲突。
    #[error("消息仓库约束冲突：{0}")]
    Constraint(String),
    /// SQLITE_BUSY / SQLITE_LOCKED：并发写锁冲突（可重试）。
    #[error("消息仓库并发锁冲突：{0}")]
    Conflict(String),
    /// DB 不可用（open/迁移/任务失败等其余 rusqlite 错误）；命令对 None/Err 报该码。
    #[error("消息仓库不可用：{0}")]
    Unavailable(String),
    /// I14-W7：会话已删除（tombstone）——迟到写被拒绝，不复活已删会话。
    #[error("会话已删除（tombstone）：{0}")]
    SessionDeleted(String),
}

impl MessageError {
    /// 机器可读错误码（稳定，不改拼写）。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Corrupt(_) => "message_repo_corrupt",
            Self::Constraint(_) => "message_repo_constraint",
            Self::Conflict(_) => "message_repo_conflict",
            Self::Unavailable(_) => "message_db_unavailable",
            Self::SessionDeleted(_) => "session_deleted",
        }
    }
}

// B1.2：结构化错误 wire `{ code, message }`（W2 IPC——Tauri command 直接返回
// `Result<T, MessageError>`，前端按 code 分支，message 仅展示）。与 SessionError 同形；
// #317 批次二：实现单源化到共享宏。
crate::impl_wire_code_message_serialize!(MessageError);

impl From<rusqlite::Error> for MessageError {
    fn from(error: rusqlite::Error) -> Self {
        // ISSUE-20 W4：按 SQLite 错误码分类，不再全部折叠为 unavailable
        if let rusqlite::Error::SqliteFailure(failure, _) = &error {
            return match failure.code {
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => {
                    Self::Corrupt(format!("message repo: {error}"))
                }
                rusqlite::ErrorCode::ConstraintViolation => {
                    Self::Constraint(format!("message repo: {error}"))
                }
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                    Self::Conflict(format!("message repo: {error}"))
                }
                _ => Self::Unavailable(format!("message repo: {error}")),
            };
        }
        Self::Unavailable(format!("message repo: {error}"))
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ensure_owner_not_deleted(
    conn: &Connection,
    owner: &crate::owner::DurableSessionOwner,
    owner_key: &str,
) -> Result<(), MessageError> {
    let deleted: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM deleted_sessions
                 WHERE owner_key = ?1
                    OR (session_id = ?2 AND owner_scope = 'legacy')
             )",
            params![owner_key, owner.local_session_id],
            |row| row.get(0),
        )
        .map_err(MessageError::from)?;
    if deleted {
        return Err(MessageError::SessionDeleted(owner_key.to_string()));
    }
    Ok(())
}

fn get_session_state_for_owner_inner(
    conn: &Connection,
    owner_key: &str,
) -> Result<Option<serde_json::Value>, MessageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT state FROM session_state_snapshots WHERE owner_key = ?1",
            params![owner_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(MessageError::from)?;
    value
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                MessageError::Corrupt(format!("session state snapshot owner={owner_key}: {error}"))
            })
        })
        .transpose()
}

/// DEL-03（§5.13 步骤 1）：校验 owner_key（JSON 数组序列化 [profileId, agentId,
/// localSessionId]——与 event_repo/eventSchema toCanonicalOwnerKey 同纪律，禁止冒号拼接
/// 与任意字符串污染 tombstone owner）。仅当前端显式传 owner_key 时校验（legacy 调用
/// None 走哨兵不校验）。
///
/// 双入口互引（W3 重构批次）：本函数是**核心校验**（上抛 `SessionError`）；命令层
/// 包装见 [`validate_delete_owner`]（Option 语义 + 错误映射为
/// `UserDataError::InvalidOwnerKey`）。两入口语义有意区分，不合并为单函数。
pub fn validate_owner_key(owner_key: &str) -> Result<(), SessionError> {
    let parsed: serde_json::Value = serde_json::from_str(owner_key)
        .map_err(|error| SessionError::from(format!("owner_key 不是合法 JSON：{error}")))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| SessionError::from("owner_key 必须是 JSON 数组".to_string()))?;
    if arr.len() != 3 {
        return Err(SessionError::from(format!(
            "owner_key 必须是 [profileId, agentId, localSessionId] 三元素数组，实际 {} 个",
            arr.len()
        )));
    }
    for (index, item) in arr.iter().enumerate() {
        match item.as_str() {
            Some(value) if !value.is_empty() => {}
            _ => {
                return Err(SessionError::from(format!(
                    "owner_key[{index}] 必须是非空字符串"
                )))
            }
        }
    }
    Ok(())
}

fn legacy_tombstone_owner_key(session_id: &str) -> Result<String, SessionError> {
    serde_json::to_string(&["*", "*", session_id]).map_err(|error| {
        SessionError::from(format!("legacy tombstone owner encode failed: {error}"))
    })
}

fn repo_err(error: rusqlite::Error) -> SessionError {
    SessionError::from(format!("message repo: {error}"))
}

fn lock_err<E>(_: E) -> SessionError {
    SessionError::from("message repo lock poisoned".to_string())
}

/// DEL-02（v6→v7）：deleted_sessions 升级为 owner/deletion state（方案书 §5.12）。
/// - 旧表（v6 及更早）无新列：ALTER ADD COLUMN 补齐（SQLite 不允许事务内中途 ALTER 后
///   再用旧列集合的语句——补齐后继续即可；NOT NULL 需 DEFAULT 兜底）。
/// - 回填：兼容旧行视为 deleted（DEFAULT）；owner_key 优先自 canonical_events 反查
///   （同 local_session_id 的最新事件 profile/agent），无则暂用固定 legacy 标记；
///   v12 再转换为唯一的会话作用域 legacy owner。
/// - 幂等门控：以列存在性判定（新库 SCHEMA_SQL 已建新列，跳过 ALTER；旧库执行）。
/// - 复合索引 INDEX(state, deleted_at) 不在本脚本（升版库在 ALTER 后由
///   DEL_02_TOMBSTONE_INDEX_SQL 统一补建——见 migrate()）。
mod migrations;
#[cfg(test)]
mod tests;

pub use migrations::connect;

impl MsgRepo {
    /// 打开（或创建）仓库并迁移到最新 schema（D-02 版本化迁移）。
    pub fn open(path: &Path) -> Result<MsgRepo, SessionError> {
        let mut conn = Connection::open(path).map_err(repo_err)?;
        connect(&mut conn)?;
        Ok(MsgRepo {
            conn: Mutex::new(conn),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存仓库
    pub fn open_in_memory() -> Result<MsgRepo, SessionError> {
        let mut conn = Connection::open_in_memory().map_err(repo_err)?;
        connect(&mut conn)?;
        Ok(MsgRepo {
            conn: Mutex::new(conn),
        })
    }

    /// Owner-keyed state write. The state snapshot is shallow-merged so usage
    /// and commands arriving in separate ACP updates do not clear each other.
    pub fn set_session_state_for_owner(
        &self,
        owner: &crate::owner::DurableSessionOwner,
        remote_session_id: Option<&str>,
        state: &serde_json::Value,
    ) -> Result<(), MessageError> {
        let owner_key = owner
            .key()
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| MessageError::Unavailable("message repo lock poisoned".to_string()))?;
        ensure_owner_not_deleted(&conn, owner, &owner_key)?;
        let mut merged = state.clone();
        if let Some(existing) = get_session_state_for_owner_inner(&conn, &owner_key)? {
            if let (Some(obj), Some(existing_obj)) = (merged.as_object_mut(), existing.as_object())
            {
                for (key, value) in existing_obj {
                    if !obj.contains_key(key) {
                        obj.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        let json = serde_json::to_string(&merged)
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
        let now = now_millis();
        conn.execute(
            "INSERT INTO session_state_snapshots
                 (owner_key, profile_id, agent_id, local_session_id, remote_session_id,
                  state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(owner_key) DO UPDATE SET
                 remote_session_id = COALESCE(excluded.remote_session_id, remote_session_id),
                 state = excluded.state,
                 updated_at = excluded.updated_at",
            params![
                owner_key,
                owner.profile_id,
                owner.agent_id,
                owner.local_session_id,
                remote_session_id,
                json,
                now,
            ],
        )
        .map_err(MessageError::from)?;
        Ok(())
    }

    pub fn get_session_state_for_owner(
        &self,
        owner: &crate::owner::DurableSessionOwner,
    ) -> Result<Option<serde_json::Value>, MessageError> {
        let owner_key = owner
            .key()
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| MessageError::Unavailable("message repo lock poisoned".to_string()))?;
        get_session_state_for_owner_inner(&conn, &owner_key)
    }

    /// DEL-03（§5.13 步骤 2-4）：本地优先删除开始——同一事务内写 state='deleting'
    /// tombstone 并删除会话行；前端随后远端 close best effort 并调
    /// `finalize_session_delete` 转终态 'deleted'。'deleting' 同样被迟到写 gate（不复活）。
    pub fn begin_delete_session(
        &self,
        session_id: &str,
        owner_key: Option<&str>,
    ) -> Result<(), SessionError> {
        self.delete_session_with_state(session_id, owner_key, "deleting")
    }

    /// DEL-03（§5.13）：删除终态化——deleting → deleted。幂等：不存在/已终态均为 no-op。
    /// 失败不阻断：tombstone 保持 'deleting' 仍被存在性 gate（迟到写不复活）。
    pub fn finalize_session_delete(
        &self,
        session_id: &str,
        owner_key: Option<&str>,
    ) -> Result<(), SessionError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        if let Some(owner_key) = owner_key {
            validate_owner_key(owner_key)?;
            conn.execute(
                "UPDATE deleted_sessions SET state = 'deleted'
                 WHERE owner_key = ?1 AND state = 'deleting'",
                params![owner_key],
            )
            .map_err(repo_err)?;
        } else {
            conn.execute(
                "UPDATE deleted_sessions SET state = 'deleted'
                 WHERE session_id = ?1 AND owner_scope = 'legacy' AND state = 'deleting'",
                params![session_id],
            )
            .map_err(repo_err)?;
        }
        Ok(())
    }

    /// tombstone 当前 state（None = 无 tombstone）。#484：仅测试断言可见（feature
    /// `test-support`，由消费方 dev-dependencies 启用）——生产 gate 只查存在性，
    /// 生产二进制不含本方法；本 crate 内测试用 SQL 直查。
    #[cfg(feature = "test-support")]
    pub fn tombstone_state(&self, session_id: &str) -> Result<Option<String>, SessionError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let state: Option<String> = conn
            .query_row(
                "SELECT state FROM deleted_sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(repo_err)?;
        Ok(state)
    }

    /// 事务删除实现（tombstone state 由调用方指定：'deleting' 两阶段 / 'deleted' 终态）。
    /// #155 T2 起 sessions 死表已删：本事务清扫快照 + 写 tombstone +（exact owner 时）
    /// 联动清扫 canonical_events。
    fn delete_session_with_state(
        &self,
        session_id: &str,
        owner_key: Option<&str>,
        state: &str,
    ) -> Result<(), SessionError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        if let Some(owner_key) = owner_key {
            validate_owner_key(owner_key)?;
        }
        if let Some(owner_key) = owner_key {
            tx.execute(
                "DELETE FROM session_state_snapshots WHERE owner_key = ?1",
                params![owner_key],
            )
            .map_err(repo_err)?;
        } else {
            tx.execute(
                "DELETE FROM session_state_snapshots WHERE local_session_id = ?1",
                params![session_id],
            )
            .map_err(repo_err)?;
        }
        // I14-W7 + DEL-02/03：tombstone——写入 owner/deletion state 完整行（deleting/deleted）；
        // 迟到写被拒绝（不复活）；INSERT OR IGNORE 幂等保留首次 tombstone。
        let legacy_owner;
        let (tombstone_owner, owner_scope) = if let Some(owner_key) = owner_key {
            (owner_key, "exact")
        } else {
            legacy_owner = legacy_tombstone_owner_key(session_id)?;
            (legacy_owner.as_str(), "legacy")
        };
        tx.execute(
            "INSERT OR IGNORE INTO deleted_sessions
                 (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL)",
            params![
                tombstone_owner,
                session_id,
                owner_scope,
                now_millis(),
                state
            ],
        )
        .map_err(repo_err)?;
        // #110 F3：删除会话联动清扫该 owner 的 canonical 事件（同事务，原子）。
        // 不清理则事件永久累积——体检实证 92,698/94,680（97.9%）是已删会话的孤儿行，
        // 主库 61MB 里绝大部分是垃圾。只有精确 owner（owner_scope='exact'）可安全清扫：
        // legacy 墓碑只有裸 session_id，同 source 多 owner 会互相误伤（DEL-02 隔离契约）。
        if owner_key.is_some() {
            tx.execute(
                "DELETE FROM canonical_events WHERE owner_key = ?1",
                params![tombstone_owner],
            )
            .map_err(repo_err)?;
            tx.execute(
                "DELETE FROM canonical_draft_fragments WHERE owner_key = ?1",
                params![tombstone_owner],
            )
            .map_err(repo_err)?;
        }
        tx.commit().map_err(repo_err)?;
        Ok(())
    }

    /// #110 F3：墓碑事件清扫——兜底回收「早于删除联动落地」的历史垃圾，以及删除时
    /// 因故未清干净的行。
    ///
    /// 只扫 `state='deleted'` 且 `owner_scope='exact'` 的墓碑：`deleting` 是两阶段
    /// 中间态（远端 close 尚未收尾，可能仍需取证），legacy 墓碑无 owner 维。
    /// **墓碑行本身不删**——迟到写 gate（ensure_owner_not_deleted 与 event_repo 追加 gate）依赖其存在性，
    /// 删墓碑等于允许已删会话复活。
    pub fn purge_tombstoned_events(
        &self,
        grace_days: i64,
    ) -> Result<TombstonePurgeOutcome, SessionError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        let cutoff = now_millis().saturating_sub(grace_days.max(0).saturating_mul(86_400_000));
        let tombstones: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM deleted_sessions
                 WHERE state = 'deleted' AND owner_scope = 'exact' AND deleted_at < ?1",
                params![cutoff],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        let events_deleted = tx
            .execute(
                "DELETE FROM canonical_events WHERE owner_key IN (
                     SELECT owner_key FROM deleted_sessions
                     WHERE state = 'deleted' AND owner_scope = 'exact' AND deleted_at < ?1
                 )",
                params![cutoff],
            )
            .map_err(repo_err)? as i64;
        tx.execute(
            "DELETE FROM canonical_draft_fragments WHERE owner_key IN (
                 SELECT owner_key FROM deleted_sessions
                 WHERE state = 'deleted' AND owner_scope = 'exact' AND deleted_at < ?1
             )",
            params![cutoff],
        )
        .map_err(repo_err)?;
        tx.commit().map_err(repo_err)?;
        Ok(TombstonePurgeOutcome {
            tombstones,
            events_deleted,
        })
    }

    /// #110 F3：WAL 定期 checkpoint（TRUNCATE）。
    ///
    /// 流式回合经 dispatcher 批窗口聚合事务落盘，从不主动 checkpoint 时 WAL 只增不减
    /// ——体检实证 WAL 66.4MB 反超主库 61.9MB。TRUNCATE 在无读者时把 WAL 文件本身收缩
    /// 回零。拿不到写锁时 SQLite 返回 busy 行而不是错误，按「本次跳过」处理（下一轮再来）。
    pub fn checkpoint_wal(&self) -> Result<(), SessionError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|_| ())
        .map_err(repo_err)
    }

    /// #155 T2：归还 `auto_vacuum=INCREMENTAL` 攒下的空闲页（无参 = 全量归还）。
    /// v15 前的库没有 ptrmap，此调用是 no-op——只在重建后的库上有实际效果。
    /// （PRAGMA incremental_vacuum 不返回行，须走 execute_batch。）
    pub fn release_free_pages(&self) -> Result<(), SessionError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        conn.execute_batch("PRAGMA incremental_vacuum")
            .map_err(repo_err)
    }

    // ── I14-W9：保留策略执行（policy 读写 + preview/prune 同一筛选） ──

    /// 读取保留策略行（单行；无 → None）。
    pub fn retention_policy_get(&self) -> Result<Option<RetentionPolicyRow>, SessionError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        conn.query_row(
            "SELECT version, revision, payload FROM retention_policy WHERE singleton = 1",
            [],
            |row| {
                Ok(RetentionPolicyRow {
                    version: row.get(0)?,
                    revision: row.get(1)?,
                    payload: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(repo_err)
    }

    /// 写入保留策略（upsert 单行，revision+1）。校验（档位契约）由调用方经
    /// RetentionPolicy::parse + is_valid 完成；本方法只负责原子落盘。
    /// I13-W3：expected_revision Some(e) 且与当前 revision 不匹配（无行 = 0）→
    /// RevisionConflict（旧写不覆盖新写，事务回滚）；None → 盲写（首写/import 用）。
    pub fn retention_policy_set(
        &self,
        version: i64,
        payload: &str,
        expected_revision: Option<i64>,
    ) -> Result<i64, SessionError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        let current: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(revision), 0) FROM retention_policy WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        if let Some(expected) = expected_revision {
            if expected != current {
                return Err(SessionError::RevisionConflict {
                    expected,
                    actual: current,
                });
            }
        }
        let new_revision = current + 1;
        tx.execute(
            "INSERT INTO retention_policy (singleton, version, revision, payload, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(singleton) DO UPDATE SET
                 version = excluded.version,
                 revision = excluded.revision,
                 payload = excluded.payload,
                 updated_at = excluded.updated_at",
            params![version, new_revision, payload, now_millis()],
        )
        .map_err(repo_err)?;
        tx.commit().map_err(repo_err)?;
        Ok(new_revision)
    }

    /// 每 owner 候选计数（preview 与 prune 共用同一筛选，D-11 语义）。
    /// A1-c/B5：执行目标 = canonical_events（canonical 事件流为唯一会话数据源）——
    /// - ByTime：created_at < cutoff（now - days 天，毫秒严格小于）；
    /// - ByCount：每 owner 按 sequence DESC 保留最新 count 条事件，其余为候选；
    /// - Permanent：无候选。
    ///
    /// per_session.session_id 使用 owner_key（canonical 事件流按 owner 键控）。
    ///
    /// CR-003：now 由调用方单次取时传入——统计与删除共用同一 cutoff，避免边界事件
    /// 计数与实际删除不一致。
    fn retention_candidate_counts(
        conn: &Connection,
        policy: &crate::retention::RetentionPolicy,
        now: i64,
    ) -> Result<Vec<SessionCandidateCount>, SessionError> {
        match policy.mode {
            super::retention::RetentionMode::Permanent => Ok(Vec::new()),
            super::retention::RetentionMode::ByTime => {
                let cutoff = now - policy.days.unwrap_or(0) as i64 * 86_400_000;
                let mut stmt = conn
                    .prepare(
                        "SELECT owner_key, COUNT(*) FROM canonical_events
                         WHERE created_at < ?1 GROUP BY owner_key",
                    )
                    .map_err(repo_err)?;
                let rows = stmt
                    .query_map([cutoff], |row| {
                        Ok(SessionCandidateCount {
                            session_id: row.get(0)?,
                            count: row.get(1)?,
                        })
                    })
                    .map_err(repo_err)?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(repo_err)?);
                }
                Ok(out)
            }
            super::retention::RetentionMode::ByCount => {
                let limit = policy.count.unwrap_or(0) as i64;
                let mut stmt = conn
                    .prepare(
                        "SELECT owner_key, COUNT(*) - ?1 FROM canonical_events
                         GROUP BY owner_key HAVING COUNT(*) > ?1",
                    )
                    .map_err(repo_err)?;
                let rows = stmt
                    .query_map([limit], |row| {
                        Ok(SessionCandidateCount {
                            session_id: row.get(0)?,
                            count: row.get(1)?,
                        })
                    })
                    .map_err(repo_err)?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(repo_err)?);
                }
                Ok(out)
            }
        }
    }

    /// preview：统计将删除的候选（不执行删除）。
    pub fn retention_candidates(
        &self,
        policy: &crate::retention::RetentionPolicy,
    ) -> Result<RetentionPreview, SessionError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let now = now_millis();
        let per_session = Self::retention_candidate_counts(&conn, policy, now)?;
        Ok(preview_result(policy, now, per_session))
    }

    /// prune：事务内统计候选 + 执行删除（与 preview 同一筛选）；返回删除结果。
    /// CR-003：now 单次取时——统计与删除共用同一 cutoff，边界计数一致。
    /// I13-W4：expected_policy_revision Some(e) 且与策略行当前 revision（无行 = 0）不匹配 →
    /// StalePreview（用户预览后策略被改，拒绝按旧统计执行清理，回滚不删）。
    pub fn prune_by_policy(
        &self,
        policy: &crate::retention::RetentionPolicy,
        expected_policy_revision: Option<i64>,
    ) -> Result<RetentionPreview, SessionError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        let policy_revision: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(revision), 0) FROM retention_policy WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        if let Some(expected) = expected_policy_revision {
            if expected != policy_revision {
                return Err(SessionError::StalePreview {
                    expected,
                    actual: policy_revision,
                });
            }
        }
        let now = now_millis();
        let per_session = Self::retention_candidate_counts(&tx, policy, now)?;
        match policy.mode {
            super::retention::RetentionMode::Permanent => {}
            super::retention::RetentionMode::ByTime => {
                let cutoff = now - policy.days.unwrap_or(0) as i64 * 86_400_000;
                tx.execute(
                    "DELETE FROM canonical_events WHERE created_at < ?1",
                    [cutoff],
                )
                .map_err(repo_err)?;
                tx.execute(
                    "DELETE FROM canonical_draft_fragments WHERE created_at < ?1",
                    [cutoff],
                )
                .map_err(repo_err)?;
            }
            super::retention::RetentionMode::ByCount => {
                let limit = policy.count.unwrap_or(0) as i64;
                // canonical_events 按 owner 键控：保留每 owner 最新 limit 条事件
                // （sequence DESC）。sequence 在 owner 范围内唯一（主键），相关子查询按
                // owner_key 圈定后 NOT IN sequence 与按行元组删除等价。
                tx.execute(
                    "DELETE FROM canonical_events WHERE sequence NOT IN (
                         SELECT sequence FROM canonical_events c2
                         WHERE c2.owner_key = canonical_events.owner_key
                         ORDER BY sequence DESC LIMIT ?1
                     )",
                    [limit],
                )
                .map_err(repo_err)?;
            }
        }
        tx.commit().map_err(repo_err)?;
        Ok(preview_result(policy, now, per_session))
    }
}

/// I13-W4：由候选计数构造 preview/prune 结果（affected_sessions + oldest_deleted_at）。
fn preview_result(
    policy: &crate::retention::RetentionPolicy,
    now: i64,
    per_session: Vec<SessionCandidateCount>,
) -> RetentionPreview {
    let total_candidates: i64 = per_session.iter().map(|c| c.count).sum();
    let oldest_deleted_at = match policy.mode {
        crate::retention::RetentionMode::ByTime => {
            Some(now - policy.days.unwrap_or(0) as i64 * 86_400_000)
        }
        _ => None,
    };
    RetentionPreview {
        total_candidates,
        affected_sessions: per_session.len() as i64,
        oldest_deleted_at,
        per_session,
    }
}

/// service 内每 Session 单 writer（Mutex 串行化）。active schema 中本 service 只承担
/// session_state / tombstone / retention 转发；canonical 事件流由 EventService 承担。
pub struct MessageService {
    repo: Arc<MsgRepo>,
}

impl MessageService {
    /// I14-W9：暴露底层 repo（RetentionService 复用同一连接；只读共享）。
    pub fn repo(&self) -> Arc<MsgRepo> {
        self.repo.clone()
    }

    pub async fn set_session_state(
        &self,
        owner: crate::owner::DurableSessionOwner,
        remote_session_id: Option<String>,
        state: serde_json::Value,
    ) -> Result<(), MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            repo.set_session_state_for_owner(&owner, remote_session_id.as_deref(), &state)
        })
        .await
        .map_err(|error| {
            MessageError::Unavailable(format!(
                "message repo set_session_state task failed: {error}"
            ))
        })?
    }

    pub async fn get_session_state(
        &self,
        owner: crate::owner::DurableSessionOwner,
    ) -> Result<Option<serde_json::Value>, MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.get_session_state_for_owner(&owner))
            .await
            .map_err(|error| {
                MessageError::Unavailable(format!(
                    "message repo get_session_state task failed: {error}"
                ))
            })?
    }

    /// 打开（或创建）生产仓库并迁移到最新 schema（D-02 版本化迁移）。
    /// 调用方须先创建 DB 父目录；失败返回 Err——启动路径不得静默回退
    /// localStorage 形成双主（ISSUE-14 W1：失败进入 blocked）。
    pub fn open_db(path: &Path) -> Result<MessageService, MessageError> {
        let repo =
            MsgRepo::open(path).map_err(|error| MessageError::Unavailable(error.to_string()))?;
        Ok(MessageService {
            repo: Arc::new(repo),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存服务
    pub fn in_memory() -> Result<MessageService, MessageError> {
        let repo = MsgRepo::open_in_memory()
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
        Ok(MessageService {
            repo: Arc::new(repo),
        })
    }

    /// DEL-03（§5.13 步骤 2-4）：本地优先删除开始——tombstone 写 'deleting' + 删除会话行。
    pub async fn begin_delete_session(
        &self,
        session_id: String,
        owner_key: Option<String>,
    ) -> Result<(), MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            repo.begin_delete_session(&session_id, owner_key.as_deref())
                .map_err(|error| MessageError::Unavailable(error.to_string()))
        })
        .await
        .map_err(|error| {
            MessageError::Unavailable(format!("message repo begin delete task failed: {error}"))
        })?
    }

    /// DEL-03（§5.13）：删除终态化——deleting → deleted（幂等；失败不阻断）。
    pub async fn finalize_session_delete(
        &self,
        session_id: String,
        owner_key: Option<String>,
    ) -> Result<(), MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            repo.finalize_session_delete(&session_id, owner_key.as_deref())
                .map_err(|error| MessageError::Unavailable(error.to_string()))
        })
        .await
        .map_err(|error| {
            MessageError::Unavailable(format!("message repo finalize delete task failed: {error}"))
        })?
    }

    /// #110 F3：事件库维护（墓碑事件清扫 + WAL checkpoint + 闲置页归还）——
    /// spawn_blocking 边界。
    ///
    /// 由启动/定时维护任务调用（`lib.rs` maintenance watcher）。整体失败只返回
    /// 结构化错误，调用方记 warn 不降级（维护是尽力而为，不得影响会话链路）。
    /// #155 T2：v15 起 `auto_vacuum=INCREMENTAL`——删除让出的页进 ptrmap 空闲池，
    /// `incremental_vacuum`（无参 = 全量归还）把已释放页交还操作系统，防止空闲页
    /// 重新累积（v14 真实库 74% 页是历史遗留空闲页）。
    pub async fn run_journal_maintenance(
        &self,
        grace_days: i64,
    ) -> Result<TombstonePurgeOutcome, MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let outcome = repo.purge_tombstoned_events(grace_days)?;
            repo.checkpoint_wal()?;
            repo.release_free_pages()?;
            Ok::<_, SessionError>(outcome)
        })
        .await
        .map_err(|error| {
            MessageError::Unavailable(format!("journal maintenance task failed: {error}"))
        })?
        .map_err(|error| MessageError::Unavailable(error.to_string()))
    }
}

/// DEL-03（§5.13 步骤 1）：命令层 owner_key 校验——Some 时校验格式（3 元素 JSON 数组），
/// 非法 → `UserDataError::InvalidOwnerKey`（B1.2 code=invalid_owner_key，前端可分支）；
/// None（legacy 调用）直接放行，走会话作用域 legacy owner。
///
/// 双入口互引（W3 重构批次）：本函数是 [`validate_owner_key`] 的**命令层 Option 包装**
/// （错误类型映射 + None 放行语义）；核心校验规则单点在彼处。两入口语义有意区分，
/// 不合并为单函数。
pub fn validate_delete_owner(owner_key: Option<String>) -> Result<Option<String>, UserDataError> {
    if let Some(ref key) = owner_key {
        crate::msg_repo::validate_owner_key(key)
            .map_err(|error| UserDataError::InvalidOwnerKey(error.to_string()))?;
    }
    Ok(owner_key)
}
