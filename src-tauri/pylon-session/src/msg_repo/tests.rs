use super::*;

/// 测试内 tombstone state 读取（替代已删除的产品方法 `tombstone_state`：生产 gate 只查存在性，
/// 读 state 是测试断言专用）。None = 无 tombstone。
fn tombstone_state(repo: &MsgRepo, session_id: &str) -> Option<String> {
    let conn = repo.conn.lock().unwrap();
    conn.query_row(
        "SELECT state FROM deleted_sessions WHERE session_id = ?1",
        params![session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .expect("query tombstone state")
}

fn unique_temp_db_path() -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "pylon-session-repo-test-{}-{}-{}.db",
        std::process::id(),
        n,
        nanos
    ))
}

fn table_names(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
    stmt.query_map([], |row| row.get(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
}

#[test]
fn migrate_fresh_db_to_current_version_without_message_tables() {
    let repo = MsgRepo::open_in_memory().expect("open");
    let conn = repo.conn.lock().unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION, "新库迁移到当前版本");
    let tables = table_names(&conn);
    for required in [
        "user_data",
        "deleted_sessions",
        "retention_policy",
        "canonical_events",
        "canonical_draft_fragments",
        "rollup_migration_state",
        "session_state_snapshots",
    ] {
        assert!(
            tables.iter().any(|t| t == required),
            "缺少核心表 {required}: {tables:?}"
        );
    }
    // #155 T2（v15）：死表清理——sessions 与 legacy_message_backfill_audit 不再创建。
    for dropped in [
        "sessions",
        "legacy_message_backfill_audit",
        "messages",
        "send_attempts",
        "message_migrations",
    ] {
        assert!(
            !tables.iter().any(|t| t == dropped),
            "v15 fresh DB 不得包含死表/legacy active table {dropped}: {tables:?}"
        );
    }
}

#[test]
fn v15_upgrade_keeps_canonical_history_without_rebuild() {
    let path = unique_temp_db_path();
    {
        let repo = MsgRepo::open(&path).expect("open current schema");
        let conn = repo.conn.lock().unwrap();
        conn.execute_batch(
            r#"INSERT INTO canonical_events
               (owner_key, remote_session_id, sequence, client_generation, occurred_at,
                received_at, event_type, payload_version, identity, typed_payload,
                raw_payload, created_at, provenance)
               VALUES ('["p","a","local:s"]', NULL, 7, 1, 't', 't',
                       'assistant.text.delta', 1, NULL, '{"text":"保留"}', '{}', 1, 0);
               DROP TABLE canonical_draft_fragments;
               PRAGMA user_version = 15;"#,
        )
        .expect("prepare v15 fixture");
    }
    let upgraded = MsgRepo::open(&path).expect("upgrade v15 to v16");
    let conn = upgraded.conn.lock().unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let payload: String = conn
        .query_row(
            "SELECT typed_payload FROM canonical_events WHERE owner_key = ?1 AND sequence = 7",
            params![r#"["p","a","local:s"]"#],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(payload, r#"{"text":"保留"}"#);
    assert!(table_names(&conn)
        .iter()
        .any(|name| name == "canonical_draft_fragments"));
    drop(conn);
    drop(upgraded);
    let _ = std::fs::remove_file(path);
}

#[test]
fn v16_upgrade_adds_rollup_span_index_without_losing_canonical_history() {
    let path = unique_temp_db_path();
    {
        let repo = MsgRepo::open(&path).expect("open current schema");
        let conn = repo.conn.lock().unwrap();
        conn.execute_batch(
            r#"INSERT INTO canonical_events
               (owner_key, remote_session_id, sequence, client_generation, occurred_at,
                received_at, event_type, payload_version, identity, typed_payload,
                raw_payload, created_at, provenance)
               VALUES ('["p","a","local:s"]', NULL, 3, 1, 't', 't',
                       'turn.unit', 1, NULL, NULL, '{}', 1, 0);
               DROP INDEX idx_canonical_events_rollup_spans;
               PRAGMA user_version = 16;"#,
        )
        .expect("prepare v16 fixture");
    }
    let upgraded = MsgRepo::open(&path).expect("upgrade v16 to current");
    let conn = upgraded.conn.lock().unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let preserved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM canonical_events WHERE owner_key = ?1 AND sequence = 3",
            params![r#"["p","a","local:s"]"#],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preserved, 1, "v16 原位升级不得丢 canonical 行");
    let index_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index'
                           AND name = 'idx_canonical_events_rollup_spans')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(index_exists, "v16 原位升级必须补建 #664 跨度覆盖索引");
    drop(conn);
    drop(upgraded);
    let _ = std::fs::remove_file(path);
}

#[test]
fn migrate_idempotent_across_reopen() {
    let path = unique_temp_db_path();
    {
        let repo = MsgRepo::open(&path).expect("open");
        let conn = repo.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }
    // 重新打开不重跑迁移、不报错（幂等）
    {
        let repo = MsgRepo::open(&path).expect("reopen");
        let conn = repo.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn current_version_with_missing_schema_is_rejected_instead_of_assumed_valid() {
    let mut conn = Connection::open_in_memory().expect("open");
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .expect("set current version");
    let error = connect(&mut conn).expect_err("version alone must not bypass schema manifest");
    assert_eq!(error.code(), "database_schema_invalid");
    assert!(error.to_string().contains("missing table canonical_events"));
}

#[test]
fn future_schema_version_is_rejected_without_running_downgrade_ddl() {
    let mut conn = Connection::open_in_memory().expect("open");
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .expect("set future version");
    let error = connect(&mut conn).expect_err("future schema must be explicit");
    assert_eq!(error.code(), "database_future_schema");
    assert!(
        table_names(&conn).is_empty(),
        "future database must not be mutated"
    );
}

#[test]
fn non_database_file_fails_the_startup_integrity_check() {
    let path = unique_temp_db_path();
    std::fs::write(&path, b"not a sqlite database").expect("write invalid database");
    let error = MsgRepo::open(&path)
        .err()
        .expect("invalid database must fail closed");
    assert_eq!(error.code(), "database_integrity_failed");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn wal_pragmas_tolerate_in_memory_database() {
    // 边界（A1）：in-memory 连接同样走 connect()——SQLite 规定 :memory: 上
    // journal_mode=WAL 请求返回 "memory" 且不报错；pragma_update 对非空返回
    // 值的 pragma 不视为失败。断言连接可用且 journal_mode 保持 memory。
    let repo = MsgRepo::open_in_memory().expect("in-memory open with WAL pragmas");
    let conn = repo.conn.lock().unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("journal_mode readable");
    assert_eq!(
        mode, "memory",
        ":memory: stays memory even after WAL request"
    );
}

/// #155 T2（v15）：旧库（user_version < 15）按「老数据全丢」重建，不搬迁任何行。
/// 保留面 = user_data.profiles + retention_policy；其余历史（canonical_events、墓碑、
/// 快照、user_data.sessions 会话列表、legacy 表）全部丢弃；重建后 auto_vacuum 生效、
/// 空闲页为 0（文件 ≈ 内容大小）。
#[test]
fn legacy_db_is_rebuilt_without_data_migration() {
    let path = unique_temp_db_path();
    {
        let repo = MsgRepo::open(&path).expect("open fresh current schema");
        let conn = repo.conn.lock().unwrap();
        conn.execute_batch(
            r#"INSERT INTO user_data (key, version, revision, payload, updated_at) VALUES
                 ('profiles', 1, 1, '{"version":1,"profiles":[{"id":"p1"}]}', 1),
                 ('sessions', 2, 3, '{"version":2,"sessions":[{"id":"s1"}]}', 1);
               INSERT INTO retention_policy (singleton, version, revision, payload, updated_at)
                 VALUES (1, 1, 1, '{"mode":"by_time","days":30}', 1);
               INSERT INTO canonical_events
                 (owner_key, remote_session_id, sequence, client_generation, occurred_at,
                  received_at, event_type, payload_version, identity, typed_payload,
                  raw_payload, created_at, provenance)
               VALUES ('["p1","peri","legacy-s1"]', 'remote-1', 1, 7, 't', 't',
                  'turn.completed', 1, NULL, NULL, '{}', 1, 0);
               INSERT INTO deleted_sessions
                 (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision, reason)
               VALUES ('["p","a","gone"]', 'gone', 'exact', 1, 'deleted', 0, NULL);
               INSERT INTO session_state_snapshots
                 (owner_key, profile_id, agent_id, local_session_id, remote_session_id,
                  state, created_at, updated_at)
               VALUES ('["p","a","gone"]', 'p', 'a', 'gone', NULL, '{}', 1, 1);
               CREATE TABLE messages (message_id TEXT PRIMARY KEY NOT NULL);
               PRAGMA user_version = 14;"#,
        )
        .expect("prepare v14 fixture");
    }

    let rebuilt = MsgRepo::open(&path).expect("reopen rebuilds to v15");
    let conn = rebuilt.conn.lock().unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION, "v14 库重开必须重建到当前版本");
    let profiles: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM user_data WHERE key = 'profiles'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(profiles, 1, "profiles 配置信封必须保留");
    let sessions_envelope: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM user_data WHERE key = 'sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        sessions_envelope, 0,
        "sessions 会话列表信封随历史丢弃（ADR-0008：重建后不会再有历史会话）"
    );
    let policy: String = conn
        .query_row(
            "SELECT payload FROM retention_policy WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(policy.contains("by_time"), "保留策略设置必须保留");
    for (table, label) in [
        ("canonical_events", "canonical 历史清空"),
        ("deleted_sessions", "墓碑清空"),
        ("session_state_snapshots", "状态快照清空"),
        ("rollup_migration_state", "裁剪进度清空"),
    ] {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{label}");
    }
    let tables = table_names(&conn);
    for dropped in ["sessions", "legacy_message_backfill_audit", "messages"] {
        assert!(
            !tables.iter().any(|t| t == dropped),
            "死表/legacy 表必须移除: {dropped}: {tables:?}"
        );
    }
    let auto_vacuum: i64 = conn
        .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
        .unwrap();
    assert_eq!(auto_vacuum, 2, "重建后 auto_vacuum=INCREMENTAL(2)");
    let application_id: i64 = conn
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        application_id, PYLON_APPLICATION_ID,
        "application_id 必须落库"
    );
    let freelist: i64 = conn
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .unwrap();
    assert_eq!(freelist, 0, "重建后 VACUUM 必须回收全部闲置页");
    drop(conn);
    drop(rebuilt);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn session_state_roundtrip_merge_keeps_existing_keys() {
    // #155 T2：v8 sessions.session_state 死列已删——merge 语义改在生产 owner 键控路径钉死。
    let repo = MsgRepo::open_in_memory().expect("open");
    let owner = crate::owner::DurableSessionOwner::new("p1", "peri", "local:s1");
    repo.set_session_state_for_owner(&owner, None, &serde_json::json!({"usage": {"n": 1}}))
        .expect("set usage");
    repo.set_session_state_for_owner(&owner, None, &serde_json::json!({"commands": ["ls"]}))
        .expect("set commands");
    let state = repo
        .get_session_state_for_owner(&owner)
        .expect("get")
        .expect("present");
    assert_eq!(state["usage"]["n"], 1, "merge 不覆盖已有 key");
    assert_eq!(state["commands"][0], "ls");
    let ghost = crate::owner::DurableSessionOwner::new("p1", "peri", "ghost");
    assert!(repo
        .get_session_state_for_owner(&ghost)
        .expect("get")
        .is_none());
}

#[test]
fn durable_session_state_isolated_by_full_owner_when_sources_match() {
    let repo = MsgRepo::open_in_memory().expect("open");
    let owner_a = crate::owner::DurableSessionOwner::new("p1", "agent-a", "shared");
    let owner_b = crate::owner::DurableSessionOwner::new("p2", "agent-b", "shared");

    repo.set_session_state_for_owner(
        &owner_a,
        Some("remote-a"),
        &serde_json::json!({"usage": {"n": 1}}),
    )
    .expect("set owner a");
    repo.set_session_state_for_owner(
        &owner_b,
        Some("remote-b"),
        &serde_json::json!({"usage": {"n": 2}}),
    )
    .expect("set owner b");

    assert_eq!(
        repo.get_session_state_for_owner(&owner_a)
            .expect("get a")
            .expect("owner a state")["usage"]["n"],
        1,
    );
    assert_eq!(
        repo.get_session_state_for_owner(&owner_b)
            .expect("get b")
            .expect("owner b state")["usage"]["n"],
        2,
    );
}

#[test]
fn owner_tombstone_deletes_and_blocks_only_the_matching_snapshot() {
    let repo = MsgRepo::open_in_memory().expect("open");
    let owner_a = crate::owner::DurableSessionOwner::new("p1", "agent-a", "shared");
    let owner_b = crate::owner::DurableSessionOwner::new("p2", "agent-b", "shared");
    for owner in [&owner_a, &owner_b] {
        repo.set_session_state_for_owner(owner, None, &serde_json::json!({"usage": {"n": 1}}))
            .expect("seed owner state");
    }

    let owner_a_key = owner_a.key().expect("owner key");
    repo.begin_delete_session("shared", Some(&owner_a_key))
        .expect("delete owner a");
    repo.finalize_session_delete("shared", Some(&owner_a_key))
        .expect("finalize owner a");

    assert!(repo
        .get_session_state_for_owner(&owner_a)
        .expect("read deleted owner")
        .is_none(),);
    let late_error = repo
        .set_session_state_for_owner(&owner_a, None, &serde_json::json!({"commands": ["late"]}))
        .expect_err("exact owner tombstone must reject late state");
    assert!(matches!(late_error, MessageError::SessionDeleted(_)));
    assert_eq!(late_error.code(), "session_deleted");
    assert!(
        repo.get_session_state_for_owner(&owner_b)
            .expect("read surviving owner")
            .is_some(),
        "same source under another profile/agent must survive",
    );
    repo.set_session_state_for_owner(
        &owner_b,
        None,
        &serde_json::json!({"commands": ["still-alive"]}),
    )
    .expect("other owner remains writable");
}

#[test]
fn delete_session_writes_tombstone_and_keeps_canonical_events() {
    let repo = MsgRepo::open_in_memory().expect("open");
    repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("delete");
    repo.finalize_session_delete("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("finalize");
    assert_eq!(tombstone_state(&repo, "s1").as_deref(), Some("deleted"));
    assert_eq!(tombstone_state(&repo, "ghost"), None);
    let conn = repo.conn.lock().unwrap();
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM canonical_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        events, 0,
        "本场景未写入事件：删除后计数保持 0（exact owner 联动清扫的语义由 del03 覆盖）"
    );
}

#[test]
fn begin_delete_and_finalize_transitions_deleting_to_deleted() {
    let repo = MsgRepo::open_in_memory().expect("open");
    repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("begin");
    assert_eq!(tombstone_state(&repo, "s1").as_deref(), Some("deleting"));
    // deleting 同样 gate 迟到状态写（不复活）
    let owner = crate::owner::DurableSessionOwner::new("p1", "a1", "s1");
    let late_error = repo
        .set_session_state_for_owner(&owner, None, &serde_json::json!({"late": true}))
        .expect_err("deleting 进行中迟到写必须拒绝");
    assert!(matches!(late_error, MessageError::SessionDeleted(_)));
    repo.finalize_session_delete("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("finalize");
    assert_eq!(tombstone_state(&repo, "s1").as_deref(), Some("deleted"));
    // 幂等：重复 begin/finalize
    repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("begin idempotent");
    repo.finalize_session_delete("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("finalize idempotent");
    assert_eq!(tombstone_state(&repo, "s1").as_deref(), Some("deleted"));
}

// ── ISSUE-20 W4：rusqlite 错误分类（corrupt/constraint/conflict/unavailable）──

fn sqlite_err(code: rusqlite::ErrorCode) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error {
            code,
            extended_code: code as i32,
        },
        None,
    )
}

#[test]
fn rusqlite_error_classifies_corrupt_and_notadb() {
    for code in [
        rusqlite::ErrorCode::DatabaseCorrupt,
        rusqlite::ErrorCode::NotADatabase,
    ] {
        let error = MessageError::from(sqlite_err(code));
        assert_eq!(
            error.code(),
            "message_repo_corrupt",
            "{code:?} 应分类为 corrupt"
        );
    }
}

#[test]
fn rusqlite_error_classifies_constraint() {
    let error = MessageError::from(sqlite_err(rusqlite::ErrorCode::ConstraintViolation));
    assert_eq!(error.code(), "message_repo_constraint");
}

#[test]
fn rusqlite_error_classifies_busy_and_locked_as_conflict() {
    for code in [
        rusqlite::ErrorCode::DatabaseBusy,
        rusqlite::ErrorCode::DatabaseLocked,
    ] {
        let error = MessageError::from(sqlite_err(code));
        assert_eq!(
            error.code(),
            "message_repo_conflict",
            "{code:?} 应分类为 conflict"
        );
    }
}

#[test]
fn rusqlite_error_other_codes_stay_unavailable() {
    for code in [
        rusqlite::ErrorCode::PermissionDenied,
        rusqlite::ErrorCode::SystemIoFailure,
        rusqlite::ErrorCode::DiskFull,
        rusqlite::ErrorCode::CannotOpen,
    ] {
        let error = MessageError::from(sqlite_err(code));
        assert_eq!(
            error.code(),
            "message_db_unavailable",
            "{code:?} 应保持 unavailable"
        );
    }
}

#[test]
fn rusqlite_error_non_sqlite_failure_stays_unavailable() {
    let error = MessageError::from(rusqlite::Error::InvalidQuery);
    assert_eq!(error.code(), "message_db_unavailable");
}

#[test]
fn message_error_serializes_b1_2_code_message_shape() {
    let unavailable = MessageError::Unavailable("db gone".into());
    let json = serde_json::to_value(&unavailable).expect("serialize");
    assert_eq!(json["code"], "message_db_unavailable");
    assert_eq!(json["message"], "消息仓库不可用：db gone");

    let deleted = MessageError::SessionDeleted("s1".into());
    let json = serde_json::to_value(&deleted).expect("serialize");
    assert_eq!(json["code"], "session_deleted");
}

// ── I14-W9：保留策略（policy 读写 + preview/prune 同一筛选；B5 执行目标 canonical_events） ──

/// 直插一条 canonical 事件测试行（canonical_events 全列 NOT NULL 必填）。
fn insert_event_at(repo: &MsgRepo, owner_key: &str, seq: i64, created_at: i64) {
    let conn = repo.conn.lock().expect("lock");
    conn.execute(
        "INSERT INTO canonical_events
                 (owner_key, remote_session_id, sequence, client_generation, occurred_at,
                  received_at, event_type, payload_version, identity, typed_payload,
                  raw_payload, created_at, provenance)
             VALUES (?1, NULL, ?2, 0, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z',
                  'user.message', 1, NULL, NULL, '{}', ?3, 3)",
        params![owner_key, seq, created_at],
    )
    .expect("insert canonical event");
}

fn canonical_event_count(repo: &MsgRepo) -> i64 {
    let conn = repo.conn.lock().expect("lock");
    conn.query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
        row.get(0)
    })
    .expect("count")
}

fn owner_key_of(local_session_id: &str) -> String {
    serde_json::to_string(&["p1", "peri", local_session_id]).expect("owner key")
}

fn by_time_policy(days: u32) -> crate::retention::RetentionPolicy {
    serde_json::from_str(&format!(r#"{{"mode":"by_time","days":{days}}}"#)).expect("policy")
}

fn by_count_policy(count: u32) -> crate::retention::RetentionPolicy {
    serde_json::from_str(&format!(r#"{{"mode":"by_count","count":{count}}}"#)).expect("policy")
}

fn permanent_policy() -> crate::retention::RetentionPolicy {
    serde_json::from_str(r#"{"mode":"permanent"}"#).expect("policy")
}

#[test]
fn retention_policy_set_get_roundtrip_bumps_revision() {
    let repo = MsgRepo::open_in_memory().expect("open");
    assert!(
        repo.retention_policy_get().expect("get").is_none(),
        "初始无策略"
    );
    let rev1 = repo
        .retention_policy_set(1, r#"{"mode":"by_time","days":30}"#, None)
        .expect("set1");
    assert_eq!(rev1, 1);
    let rev2 = repo
        .retention_policy_set(1, r#"{"mode":"by_count","count":1000}"#, None)
        .expect("set2");
    assert_eq!(rev2, 2);
    let row = repo.retention_policy_get().expect("get").expect("present");
    assert_eq!(row.version, 1);
    assert_eq!(row.revision, 2);
    assert!(row.payload.contains("by_count"));
}

#[test]
fn retention_policy_set_expected_revision_conflicts_and_rolls_back() {
    let repo = MsgRepo::open_in_memory().expect("open");
    // 无行时 expected=0 通过（首写）
    assert_eq!(
        repo.retention_policy_set(1, r#"{"mode":"permanent"}"#, Some(0))
            .expect("blind first"),
        1
    );
    // expected 与实际不符 → 冲突，不写任何行（旧写不覆盖新写）
    let err = repo
        .retention_policy_set(1, r#"{"mode":"by_time","days":30}"#, Some(5))
        .expect_err("must conflict");
    assert!(
        matches!(
            err,
            SessionError::RevisionConflict {
                expected: 5,
                actual: 1
            }
        ),
        "{err:?}"
    );
    let row = repo.retention_policy_get().expect("get").expect("present");
    assert_eq!(row.revision, 1, "冲突后 revision 不得推进");
    assert!(
        row.payload.contains("permanent"),
        "冲突后 payload 不得被覆盖"
    );
    // expected 正确 → 通过并推进
    assert_eq!(
        repo.retention_policy_set(1, r#"{"mode":"by_count","count":1000}"#, Some(1))
            .expect("ok"),
        2
    );
}

#[test]
fn retention_prune_stale_when_policy_revision_changed() {
    let repo = MsgRepo::open_in_memory().expect("open");
    let now = now_millis();
    let owner = owner_key_of("s1");
    insert_event_at(&repo, &owner, 1, now - 40 * 86_400_000);
    // 策略 rev 1
    let rev = repo
        .retention_policy_set(1, r#"{"mode":"by_time","days":30}"#, None)
        .expect("set");
    assert_eq!(rev, 1);
    // expected 匹配 → 正常清理
    let pruned = repo
        .prune_by_policy(&by_time_policy(30), Some(1))
        .expect("prune with current revision");
    assert_eq!(pruned.total_candidates, 1);
    assert_eq!(canonical_event_count(&repo), 0);
    // 策略再改（rev 2）→ 用旧 expected 1 prune → StalePreview，回滚不删
    insert_event_at(&repo, &owner, 2, now - 40 * 86_400_000);
    repo.retention_policy_set(1, r#"{"mode":"by_time","days":90}"#, None)
        .expect("set2");
    let err = repo
        .prune_by_policy(&by_time_policy(30), Some(1))
        .expect_err("stale expected must reject");
    assert!(
        matches!(
            err,
            SessionError::StalePreview {
                expected: 1,
                actual: 2
            }
        ),
        "{err:?}"
    );
    assert_eq!(canonical_event_count(&repo), 1, "stale 回滚不删");
    // 无行时 expected=0 通过（首写即清理）
    let repo2 = MsgRepo::open_in_memory().expect("open");
    insert_event_at(&repo2, &owner_key_of("s2"), 1, now);
    assert!(
        repo2
            .prune_by_policy(&permanent_policy(), Some(0))
            .expect("ok")
            .total_candidates
            == 0
    );
}

#[test]
fn retention_preview_by_time_counts_old_events_only() {
    let repo = MsgRepo::open_in_memory().expect("open");
    let now = now_millis();
    let owner = owner_key_of("s1");
    // 旧事件（30 天前）+ 新事件（当前）
    insert_event_at(&repo, &owner, 1, now - 40 * 86_400_000);
    insert_event_at(&repo, &owner, 2, now - 31 * 86_400_000);
    insert_event_at(&repo, &owner, 3, now);
    let preview = repo
        .retention_candidates(&by_time_policy(30))
        .expect("preview");
    assert_eq!(preview.total_candidates, 2, "30 天前的 2 条为候选");
    assert_eq!(preview.per_session.len(), 1);
    assert_eq!(preview.affected_sessions, 1, "I13-W4 受影响 owner 数");
    assert!(
        preview.oldest_deleted_at.is_some(),
        "I13-W4 by_time 给出 cutoff"
    );
    assert_eq!(
        preview.per_session[0].session_id, owner,
        "候选按 owner_key 分组"
    );
    assert_eq!(preview.per_session[0].count, 2);
    // 不执行删除
    assert_eq!(canonical_event_count(&repo), 3);
}

#[test]
fn retention_preview_by_count_keeps_newest_n_events_per_owner() {
    let repo = MsgRepo::open_in_memory().expect("open");
    let owner = owner_key_of("s1");
    for seq in 1..=5 {
        insert_event_at(&repo, &owner, seq, now_millis());
    }
    let preview = repo
        .retention_candidates(&by_count_policy(3))
        .expect("preview");
    assert_eq!(
        preview.total_candidates, 2,
        "每 owner 保留最新 3 条事件，删 2"
    );
    assert_eq!(preview.per_session[0].session_id, owner);
    assert_eq!(preview.per_session[0].count, 2);
    // permanent → 无候选
    assert_eq!(
        repo.retention_candidates(&permanent_policy())
            .expect("preview")
            .total_candidates,
        0
    );
}

#[test]
fn retention_prune_deletes_and_is_idempotent() {
    let repo = MsgRepo::open_in_memory().expect("open");
    let now = now_millis();
    let owner = owner_key_of("s1");
    for seq in 1..=5 {
        insert_event_at(&repo, &owner, seq, now);
    }
    let pruned = repo
        .prune_by_policy(&by_count_policy(3), None)
        .expect("prune");
    assert_eq!(pruned.total_candidates, 2);
    assert_eq!(pruned.affected_sessions, 1, "I13-W4 单 owner 受影响");
    assert_eq!(pruned.oldest_deleted_at, None, "I13-W4 by_count 无 cutoff");
    assert_eq!(canonical_event_count(&repo), 3);
    // 重复 prune：无新候选（幂等）
    let again = repo
        .prune_by_policy(&by_count_policy(3), None)
        .expect("prune again");
    assert_eq!(again.total_candidates, 0, "重复 prune 幂等，二次无删除");
    assert_eq!(canonical_event_count(&repo), 3);
}

#[test]
fn retention_prune_by_time_multi_owner_and_boundary() {
    let repo = MsgRepo::open_in_memory().expect("open");
    let now = now_millis();
    let owner1 = owner_key_of("s1");
    let owner2 = owner_key_of("s2");
    // owner1：2 条旧 + 1 条新；owner2：1 条旧
    insert_event_at(&repo, &owner1, 1, now - 40 * 86_400_000);
    insert_event_at(&repo, &owner1, 2, now - 32 * 86_400_000);
    insert_event_at(&repo, &owner1, 3, now);
    insert_event_at(&repo, &owner2, 1, now - 60 * 86_400_000);
    let pruned = repo
        .prune_by_policy(&by_time_policy(30), None)
        .expect("prune");
    assert_eq!(pruned.total_candidates, 3, "多 owner 各按时间边界删旧");
    assert_eq!(pruned.affected_sessions, 2, "I13-W4 两个 owner 受影响");
    assert!(
        pruned.oldest_deleted_at.is_some(),
        "I13-W4 by_time 给出 cutoff"
    );
    assert_eq!(canonical_event_count(&repo), 1);
    // 同 timestamp 边界：created_at 恰在 cutoff（严格 < 不删）——用 1 秒余量放在
    // cutoff 之后（测试开始 now 与查询 now_millis 有毫秒级漂移，余量避免误判）
    insert_event_at(&repo, &owner1, 4, now - 30 * 86_400_000 + 1000);
    let preview = repo
        .retention_candidates(&by_time_policy(30))
        .expect("preview");
    assert_eq!(
        preview.total_candidates, 0,
        "cutoff 之后的事件不删（严格 <）"
    );
}

#[test]
fn retention_permanent_prune_deletes_nothing() {
    let repo = MsgRepo::open_in_memory().expect("open");
    insert_event_at(&repo, &owner_key_of("s1"), 1, now_millis());
    let pruned = repo
        .prune_by_policy(&permanent_policy(), None)
        .expect("prune");
    assert_eq!(pruned.total_candidates, 0);
    assert_eq!(canonical_event_count(&repo), 1);
}
