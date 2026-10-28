//! DEL-01：现有 schema/tombstone owner 化审计（方案书 §5.12、任务表 DEL-01）。
//!
//! 审计基线：以代码库当前 schema（SCHEMA_SQL + migrate）为唯一事实，直接 PRAGMA
//! 读库固化：表清单、列清单（owner 缺口）、索引、外键、tombstone 语义。本模块**只审计
//! 不迁移**；DEL-02 升级 tombstone 后本基线已同步演进（审计→迁移顺序门禁：迁移改动
//! schema 必使旧基线失败——M4 阶段目标"数据库 schema 必须先审计再迁移"）。
//!
//! 审计对象与演进：
//! - active 表（v12）：sessions / session_state_snapshots / user_data / deleted_sessions /
//!   retention_policy / canonical_events / legacy_message_backfill_audit。旧库升级时 v8 message
//!   三表仅改名为 forensic archive；fresh DB 不创建 archive，canonical_events 仍是唯一历史权威。
//! - owner 缺口（DEL-01 审计发现）：
//!   - `sessions` 仅 (session_id, created_at, updated_at, session_state)——无
//!     profile_id/agent_id/remote_session_id/source/generation/deletion_revision
//!     （缺口保留，session_records 化属后续卡，不在 DEL-02 tombstone 范围）；
//!   - `deleted_sessions` v12 以 owner_key 为主键，并以 owner_scope 区分 exact/legacy；
//!     session_id 只承担 legacy wildcard gate 与诊断，不再造成多 owner 冲突。
//!   - `canonical_events` 已携带 owner 列（profile_id/agent_id/local_session_id/
//!     remote_session_id/owner_key）——EVT-02 先行覆盖，作为 owner 化样板。
//! - 索引（v17）：idx_canonical_events_rollup_spans + DEL-02 新增
//!   idx_deleted_sessions_state_deleted_at（§5.12 建议——deleting/deleted 列表过滤与
//!   orphan cleanup 扫描）。无 (agent_id, profile_id, updated_at)（保留缺口）。
//! - FK：active schema 无 messages/send_attempts；canonical_events 不设 FK（§5.12 注释——事件流
//!   独立于 sessions 行，删除语义 DEL-02 处理，禁第二套）。
//! - tombstone 语义：delete_session 单事务（DELETE sessions + INSERT OR IGNORE 完整
//!   owner tombstone，DEL-02 起携带 owner_key/state/revision）；删除后 evt_append →
//!   EventError::SessionDeleted（event_session_deleted，不复活）；重复删除幂等（保留首次
//!   tombstone）；canonical_events 行不随 delete_session 删除（append-only）。

use rusqlite::Connection;

use super::event_repo::{parse_canonical_event, EventError, EventRepo};
use super::msg_repo::connect;
use super::msg_repo::MsgRepo;
use super::msg_repo::SCHEMA_VERSION;

/// 审计专用内存库：跑真实 migrate() 到当前版本（唯一事实源）。
fn audit_db() -> Connection {
    let mut conn = Connection::open_in_memory().expect("open in-memory audit db");
    connect(&mut conn).expect("migrate to current schema");
    conn
}

/// 全部表名（排除 sqlite_ 系统表），升序。
fn table_names(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .expect("prepare table inventory");
    stmt.query_map([], |row| row.get(0))
        .expect("query table inventory")
        .map(|row| row.expect("table name row"))
        .collect()
}

/// 表列名（PRAGMA table_info 顺序）。
fn column_names(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare column inventory");
    stmt.query_map([], |row| row.get::<_, String>(1))
        .expect("query column inventory")
        .map(|row| row.expect("column name row"))
        .collect()
}

/// 表索引名（PRAGMA index_list；含 sqlite_autoindex_*）。
fn index_names(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA index_list({table})"))
        .expect("prepare index inventory");
    stmt.query_map([], |row| row.get::<_, String>(1))
        .expect("query index inventory")
        .map(|row| row.expect("index name row"))
        .collect()
}

/// 外键清单 `(本表列, 目标表, ON DELETE)`（PRAGMA foreign_key_list）。
fn fk_targets(conn: &Connection, table: &str) -> Vec<(String, String, String)> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA foreign_key_list({table})"))
        .expect("prepare fk inventory");
    stmt.query_map([], |row| Ok((row.get(3)?, row.get(2)?, row.get(6)?)))
        .expect("query fk inventory")
        .map(|row| row.expect("fk row"))
        .collect()
}

/// 全库用户索引（非 sqlite_autoindex）。
fn user_index_names(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index'
             AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .expect("prepare user index inventory");
    stmt.query_map([], |row| row.get(0))
        .expect("query user index inventory")
        .map(|row| row.expect("index name row"))
        .collect()
}

#[test]
fn schema_version_is_v17_rollup_index_baseline() {
    let conn = audit_db();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read user_version");
    assert_eq!(
        version, SCHEMA_VERSION,
        "user_version 必须等于 SCHEMA_VERSION"
    );
    assert_eq!(
        version, 17,
        "审计基线 = v17（#664：compact 跨度部分覆盖索引 idx_canonical_events_rollup_spans；v15/v16 原位加索引保留历史，旧于 v15 的库仍重建）。后续迁移必须显式递增并更新本基线"
    );
}

#[test]
fn table_inventory_baseline() {
    let conn = audit_db();
    let mut tables = table_names(&conn);
    tables.sort();
    let expected = vec![
        "canonical_draft_fragments",
        "canonical_events",
        "deleted_sessions",
        "retention_policy",
        "rollup_migration_state",
        "session_state_snapshots",
        "user_data",
    ];
    assert_eq!(
        tables, expected,
        "DEL-01 审计：v16 active 表清单必须与 SCHEMA_SQL 一致；旧 messages/sessions active names 不得存在"
    );
}

#[test]
fn column_inventory_owner_gap_baseline() {
    let conn = audit_db();
    // #155 T2（v15）：sessions 死表已删除（生产会话行由 user_data envelope 维护）。
    // deleted_sessions：v12 owner_key 主键 + exact/legacy scope。
    assert_eq!(
        column_names(&conn, "deleted_sessions"),
        vec![
            "owner_key",
            "session_id",
            "owner_scope",
            "deleted_at",
            "state",
            "deletion_revision",
            "reason"
        ],
        "审计：deleted_sessions 必须是 v12 durable-owner keyed active schema"
    );
    assert_eq!(
        column_names(&conn, "session_state_snapshots"),
        vec![
            "owner_key",
            "profile_id",
            "agent_id",
            "local_session_id",
            "remote_session_id",
            "state",
            "created_at",
            "updated_at",
        ],
        "v10 state snapshot 必须以完整 durable owner 键控；remote id 仅为映射",
    );
    // canonical_events：#155 T2（v15）存储收窄——15 列 + (owner_key, sequence)
    // WITHOUT ROWID 聚簇主键；event_id/owner 分维列/provenance 四字段/raw_* 计数
    // 均为读侧派生，不得落库（wire 28 字段契约不变）。
    let ce = column_names(&conn, "canonical_events");
    let expected_ce = [
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
    ];
    assert_eq!(
        ce, expected_ce,
        "v15 canonical_events 列集必须与 SCHEMA_SQL 一致（存储 15 列）"
    );
    for derived in [
        "event_id",
        "profile_id",
        "agent_id",
        "local_session_id",
        "schema_version",
    ] {
        assert!(
            !ce.iter().any(|column| column == derived),
            "v15 派生列不得落库: {derived}；当前列 {ce:?}"
        );
    }
}

#[test]
fn index_inventory_baseline() {
    let conn = audit_db();
    // #155 T2（v15）：idx_canonical_events_session_seq 已删——(owner_key, sequence)
    // WITHOUT ROWID 聚簇主键本身就是 owner 前缀有序的访问路径，(local_session_id,
    // sequence) 无生产查询面。v17（#664）另加 compact 跨度部分覆盖索引。
    let ce_indexes = index_names(&conn, "canonical_events");
    assert!(
        ce_indexes
            .iter()
            .any(|index| index.starts_with("sqlite_autoindex")),
        "canonical_events 主键聚簇以 sqlite_autoindex 形式登记；当前 {ce_indexes:?}"
    );
    assert!(
        ce_indexes
            .iter()
            .any(|index| index == "idx_canonical_events_rollup_spans"),
        "canonical_events 缺少 #664 compact 跨度覆盖索引；当前 {ce_indexes:?}"
    );
    // DEL-02：deleted_sessions 已新增 §5.12 建议的 (state, deleted_at) 复合索引
    // （deleting/deleted 列表过滤与 orphan cleanup 扫描）。
    let ds_indexes = index_names(&conn, "deleted_sessions");
    assert!(
        ds_indexes.iter().any(|index| index == "idx_deleted_sessions_state_deleted_at"),
        "deleted_sessions 缺少 idx_deleted_sessions_state_deleted_at（DEL-02 应新增）；当前 {ds_indexes:?}"
    );
    assert!(
        ds_indexes
            .iter()
            .any(|index| index == "idx_deleted_sessions_session_id"),
        "deleted_sessions 缺少 legacy/diagnostic session_id index"
    );
    // 缺口（保留）：无 (agent_id, profile_id, updated_at) 会话活动索引（§5.12 建议；owner 化后按 agent 过滤会话列表需要）。
    let user_indexes = user_index_names(&conn);
    let mut expected_indexes = vec![
        "idx_canonical_events_rollup_spans".to_string(),
        "idx_deleted_sessions_state_deleted_at".to_string(),
        "idx_deleted_sessions_session_id".to_string(),
        "idx_session_state_snapshots_remote".to_string(),
    ];
    expected_indexes.sort();
    assert_eq!(
        user_indexes, expected_indexes,
        "审计：用户索引 = tombstone 两条 + state remote mapping + #664 跨度覆盖索引；新增/删除索引必须更新本基线"
    );
}

#[test]
fn fk_inventory_baseline() {
    let conn = audit_db();
    // canonical_events：不设 FK（§5.12 注释——事件流先于/独立于 sessions 行，
    // 删除语义由 DEL-02 在 M4 处理，禁止第二套删除语义）。
    assert_eq!(
        fk_targets(&conn, "canonical_events"),
        Vec::<(String, String, String)>::new(),
        "canonical_events 不设 FK（设计基线）；DEL-02 不得为其引入级联删除"
    );
    // v12 fresh/active schema：legacy message 表不参与运行态，因此无业务外键依赖。
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .expect("prepare table inventory");
    let tables: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .expect("query tables")
        .map(|row| row.unwrap())
        .collect();
    for table in tables {
        assert!(
            fk_targets(&conn, &table).is_empty(),
            "v11 审计：active 表 {table} 不应再有业务 FK（legacy archives 不参与运行态）"
        );
    }
}

#[test]
fn tombstone_gate_and_delete_semantics_baseline() {
    // 行为基线（§5.12 tombstone 规则 + B7 canonical 唯一数据源）：
    // 1) 删除单事务（DEL-03 两阶段）：DELETE snapshots + INSERT OR IGNORE tombstone；
    // 2) 删除后 evt_append → EventError::SessionDeleted（迟到写不复活）；
    // 3) 重复删除幂等（INSERT OR IGNORE，不报未知错误）；
    // 4) exact owner 删除联动清扫 canonical_events（#110 F3：append-only 契约已废）。
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open file repo");

    // 先写入一条 canonical_events 行（独立于 sessions 行的 owner 化事件流）。
    let evt = parse_canonical_event(&serde_json::json!({
        "eventId": "[\"p\",\"a\",\"s1\"]#1",
        "owner": { "profileId": "p", "agentId": "a", "localSessionId": "s1" },
        "clientGeneration": 7,
        "sequence": 1,
        "occurredAt": "2026-01-01T00:00:00.000Z",
        "receivedAt": "2026-01-01T00:00:00.000Z",
        "eventType": "user.message",
        "payloadVersion": 1,
        "rawPayload": {}
    }))
    .expect("parse canonical event");
    let evt_repo = EventRepo::open(&path).expect("open event repo");
    evt_repo.append_events(&[evt], None).expect("append e1");

    repo.begin_delete_session("s1", Some(r#"["p","a","s1"]"#))
        .expect("delete s1");
    repo.finalize_session_delete("s1", Some(r#"["p","a","s1"]"#))
        .expect("finalize s1");

    // 删除后 evt_append → EventError::SessionDeleted（tombstone gate，不复活）。
    let late = parse_canonical_event(&serde_json::json!({
        "eventId": "[\"p\",\"a\",\"s1\"]#2",
        "owner": { "profileId": "p", "agentId": "a", "localSessionId": "s1" },
        "clientGeneration": 7,
        "sequence": 2,
        "occurredAt": "2026-01-01T00:00:01.000Z",
        "receivedAt": "2026-01-01T00:00:01.000Z",
        "eventType": "user.message",
        "payloadVersion": 1,
        "rawPayload": {}
    }))
    .expect("parse late canonical event");
    let late_result = evt_repo.append_events(&[late], None);
    assert!(
        late_result.is_err(),
        "删除后 evt_append 必须被 tombstone 拒绝（不复活）"
    );
    match late_result.unwrap_err() {
        EventError::SessionDeleted(_) => {}
        other => panic!("期望 SessionDeleted，实际 {other:?}"),
    }

    // 重复删除幂等（INSERT OR IGNORE tombstone，不报未知错误）。
    repo.begin_delete_session("s1", Some(r#"["p","a","s1"]"#))
        .expect("repeat delete is idempotent");
    repo.finalize_session_delete("s1", Some(r#"["p","a","s1"]"#))
        .expect("repeat finalize is idempotent");
    // 释放写连接（Windows 上不 drop 无法删除文件）。
    drop(repo);
    drop(evt_repo);

    // tombstone 写入 + canonical_events 留存，逐项核验。
    let conn = Connection::open(&path).expect("open final inspect conn");
    let tombstone: i64 = conn
        .query_row("SELECT COUNT(*) FROM deleted_sessions", [], |row| {
            row.get(0)
        })
        .expect("count tombstone");
    assert_eq!(
        tombstone, 1,
        "删除必须写入 tombstone 且重复删除不产生第二行"
    );
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
            row.get(0)
        })
        .expect("count canonical events");
    assert_eq!(
        events, 0,
        "#110 F3：canonical_events 随 delete_session 联动清扫（旧「append-only 留存」契约让\
         已删会话的事件永久累积：体检实证 92,698/94,680 = 97.9% 是垃圾）。迟到写仍被 \
         tombstone 拒绝（见上），故清扫后计数为 0"
    );
    let legacy_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='table' AND name IN ('messages','send_attempts','message_migrations')",
            [],
            |row| row.get(0),
        )
        .expect("count legacy tables");
    assert_eq!(
        legacy_tables, 0,
        "v12 fresh DB：messages 三个 active name 不得存在"
    );
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

/// 独立临时库路径（审计行为基线用；同一文件可开第二读连接核验）。
fn unique_temp_db_path() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "del01-audit-{}-{}.sqlite3",
        std::process::id(),
        nonce
    ))
}
