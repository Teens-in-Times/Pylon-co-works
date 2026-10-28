use super::*;

/// #155 T2（v15）：旧库（user_version < 15）重建时丢弃的历史/死表清单。
/// v8 message 三表与 v11/v12 archive 名一并列出——重建不区分「归档中」与「active」，
/// 旧数据一律不搬迁（ADR-0008「老数据我一个都不要了」）。
const LEGACY_DROP_TABLES: &[&str] = &[
    "canonical_events",
    "canonical_draft_fragments",
    "rollup_migration_state",
    "legacy_message_backfill_audit",
    "deleted_sessions",
    "session_state_snapshots",
    "sessions",
    "legacy_messages_v8_archive",
    "legacy_send_attempts_v8_archive",
    "legacy_message_migrations_v8_archive",
    "deleted_sessions_v11_archive",
    "messages",
    "send_attempts",
    "message_migrations",
];

/// 重建时保留的 user_data 键（配置面）；`sessions` 键（侧栏会话列表信封）随历史丢弃
/// ——ADR-0008 承认的可见行为变化：「重建后不会再有历史会话」。
const USER_DATA_PRESERVED_KEYS: &[&str] = &["profiles"];

/// #155 T2（v15）：原位升版来源的判别线——`user_version == LAST_IN_PLACE_VERSION`
/// 的库做原位增量迁移（如 v15→v16 加表，不触碰既有行）；其余旧版本（>0 且不等于
/// 本常量）一律走 ADR-0008「老数据全丢重建」。v15 是逐版本迁移链的最后一个原位
/// 升版源，其后无迁移链先例；v17 起延续该二分法，不复活逐版本迁移。
/// （与既往字面量 `current != 15` 逐位等价，仅显式化策略。）
const LAST_IN_PLACE_VERSION: i64 = 15;

const SCHEMA_MANIFEST: &[(&str, &[&str])] = &[
    (
        "canonical_events",
        &[
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
        ],
    ),
    (
        "canonical_draft_fragments",
        &[
            "owner_key",
            "draft_id",
            "fragment_index",
            "client_generation",
            "remote_session_id",
            "event_type",
            "identity",
            "raw_payload",
            "first_received_at",
            "created_at",
        ],
    ),
    (
        "session_state_snapshots",
        &[
            "owner_key",
            "profile_id",
            "agent_id",
            "local_session_id",
            "remote_session_id",
            "state",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "user_data",
        &["key", "version", "revision", "payload", "updated_at"],
    ),
    (
        "deleted_sessions",
        &[
            "owner_key",
            "session_id",
            "owner_scope",
            "deleted_at",
            "state",
            "deletion_revision",
            "reason",
        ],
    ),
    (
        "retention_policy",
        &["singleton", "version", "revision", "payload", "updated_at"],
    ),
    (
        "rollup_migration_state",
        &["owner_key", "unit_event_id", "state", "updated_at"],
    ),
];

const REQUIRED_INDEXES: &[&str] = &[
    "idx_session_state_snapshots_remote",
    "idx_deleted_sessions_state_deleted_at",
    "idx_deleted_sessions_session_id",
];

/// 读主键列序。**不得 expect**（#654）：库损坏 / 被占用 / 非法文件时 `PRAGMA` 会报错，
/// 而本函数处在启动路径上——release 的 `panic = "abort"` 会把「库读不出来」变成闪退。
fn primary_key_columns(conn: &Connection, table: &str) -> Result<Vec<String>, SessionError> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(repo_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
        })
        .map_err(repo_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(repo_err)?;
    let mut primary = rows
        .into_iter()
        .filter(|(_, order)| *order > 0)
        .collect::<Vec<_>>();
    primary.sort_by_key(|(_, order)| *order);
    Ok(primary.into_iter().map(|(name, _)| name).collect())
}

fn validate_schema_objects(conn: &Connection) -> Result<(), SessionError> {
    let mut problems = Vec::new();
    for (table, required_columns) in SCHEMA_MANIFEST {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(repo_err)?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(repo_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(repo_err)?;
        if columns.is_empty() {
            problems.push(format!("missing table {table}"));
            continue;
        }
        for column in *required_columns {
            if !columns.iter().any(|existing| existing == column) {
                problems.push(format!("missing column {table}.{column}"));
            }
        }
    }
    for index in REQUIRED_INDEXES {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1)",
                params![index],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        if !exists {
            problems.push(format!("missing index {index}"));
        }
    }
    // v15：主键形状钉死——(owner_key, sequence) WITHOUT ROWID 聚簇取代 v14 的
    // event_id 主键 + UNIQUE(owner_key, sequence) + idx_session_seq 三棵重复 btree。
    if primary_key_columns(conn, "canonical_events")? != ["owner_key", "sequence"] {
        problems.push("canonical_events primary key must be (owner_key, sequence)".into());
    }
    if primary_key_columns(conn, "canonical_draft_fragments")?
        != ["owner_key", "draft_id", "fragment_index"]
    {
        problems.push(
            "canonical_draft_fragments primary key must be (owner_key, draft_id, fragment_index)"
                .into(),
        );
    }
    if primary_key_columns(conn, "deleted_sessions")? != ["owner_key"] {
        problems.push("deleted_sessions primary key must be owner_key".into());
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(SessionError::DatabaseSchemaInvalid(problems.join("; ")))
    }
}

/// v15 头字段校验（application_id / auto_vacuum）。**只能在 migrate() 之后调用**：
/// auto_vacuum 是建库期标志，非空库上设置后须经同连接 VACUUM 才写入文件头——
/// 重建事务内读回仍是旧值，故与对象形状校验（事务内可跑）分开。
fn validate_db_header(conn: &Connection) -> Result<(), SessionError> {
    let mut problems = Vec::new();
    let application_id: i64 = conn
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(repo_err)?;
    if application_id != PYLON_APPLICATION_ID {
        problems.push(format!(
            "application_id must be {PYLON_APPLICATION_ID}, found {application_id}"
        ));
    }
    let auto_vacuum: i64 = conn
        .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
        .map_err(repo_err)?;
    if auto_vacuum != 2 {
        // 0=NONE 1=FULL 2=INCREMENTAL
        problems.push(format!(
            "auto_vacuum must be INCREMENTAL(2), found {auto_vacuum}"
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(SessionError::DatabaseSchemaInvalid(problems.join("; ")))
    }
}

fn validate_quick_check(conn: &Connection) -> Result<(), SessionError> {
    let integrity_error =
        |error: rusqlite::Error| SessionError::DatabaseIntegrity(error.to_string());
    let mut stmt = conn
        .prepare("PRAGMA quick_check(1)")
        .map_err(integrity_error)?;
    let results = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(integrity_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(integrity_error)?;
    if results.len() == 1 && results[0].eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(SessionError::DatabaseIntegrity(if results.is_empty() {
            "quick_check returned no result".to_string()
        } else {
            results.join("; ")
        }))
    }
}

/// v16 有三条路：建库、v15 原位加 draft 表、user_version < 15 重建（不搬迁
/// 旧历史）。v15→v16 不触碰已存在的 canonical 行（ADR-0026）。
///
/// 重建保留面：`user_data` 的 `profiles` 行（配置）与 `retention_policy` 行（设置）；
/// 其余历史（canonical_events、墓碑、状态快照、user_data.sessions 会话列表、
/// rollup 进度、legacy 归档）全部丢弃。重建后设置 `auto_vacuum=INCREMENTAL` 并
/// VACUUM 一次——全部闲置页归还操作系统，文件 ≈ 内容大小（v14 真实库 74% 是空闲页）。
fn migrate(conn: &mut Connection) -> Result<(), SessionError> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(repo_err)?;
    if current > SCHEMA_VERSION {
        return Err(SessionError::DatabaseFutureSchema {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    if current == SCHEMA_VERSION {
        return validate_schema_objects(conn);
    }
    let rebuilding = current > 0 && current != LAST_IN_PLACE_VERSION;
    if rebuilding {
        tracing::warn!(
            found_version = current,
            target_version = SCHEMA_VERSION,
            code = "legacy_db_rebuilt",
            "检测到旧版数据库：按 ADR-0008「老数据全丢」策略重建（不迁移历史；\
             profiles 配置与保留策略保留，会话历史丢弃）"
        );
    }
    // auto_vacuum 是建库期标志：空库直接生效；重建库（已有页）需随后的 VACUUM 落盘。
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")
        .map_err(repo_err)?;
    conn.pragma_update(None, "application_id", PYLON_APPLICATION_ID)
        .map_err(repo_err)?;
    let tx = conn.transaction().map_err(repo_err)?;
    if rebuilding {
        for table in LEGACY_DROP_TABLES {
            tx.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))
                .map_err(repo_err)?;
        }
        // 侧栏会话列表信封随历史丢弃；profiles/设置保留（见 USER_DATA_PRESERVED_KEYS）。
        // 极旧库可能尚无 user_data 表（v3 前引入）——守卫后跳过。
        let user_data_present: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_data')",
                [],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        if user_data_present {
            let mut drop_keys = String::new();
            for (index, key) in USER_DATA_PRESERVED_KEYS.iter().enumerate() {
                if index > 0 {
                    drop_keys.push_str(", ");
                }
                drop_keys.push_str(&format!("'{key}'"));
            }
            tx.execute_batch(&format!(
                "DELETE FROM user_data WHERE key NOT IN ({drop_keys})"
            ))
            .map_err(repo_err)?;
        }
    }
    tx.execute_batch(SCHEMA_SQL).map_err(repo_err)?;
    validate_schema_objects(&tx)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(repo_err)?;
    tx.commit().map_err(repo_err)?;
    if rebuilding {
        // 重建后的库：VACUUM 把 auto_vacuum 标志应用到全部现存页并回收重建让出的空间。
        // 必须在事务外执行（VACUUM 自成事务）。
        conn.execute_batch("VACUUM").map_err(repo_err)?;
    }
    Ok(())
}

/// 打开并迁移仓库；FK 开启（历史 ON DELETE CASCADE 依赖已随 messages 表移除，
/// 保留开启以维持 SQLite 外键一致性纪律）。
/// I14-W5：busy_timeout 序列化同文件多连接写（MessageService 与 UserDataService
/// 各自持连接，避免并发写 SQLITE_BUSY）。本函数 pub 供 user_data.rs 复用
/// 同一迁移链（user_data 表随 SCHEMA_SQL 一并创建/升级）。
pub fn connect(conn: &mut Connection) -> Result<(), SessionError> {
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(repo_err)?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(repo_err)?;
    validate_quick_check(conn)?;
    migrate(conn)?;
    // WAL：流式期间 canonical journal 经 dispatcher 批窗口聚合事务落盘，
    // delete 模式每事务两次 fsync + 写锁表；WAL + NORMAL 将提交降为一次 WAL append。
    // 置于完整性校验/迁移之后：损坏或非 SQLite 文件先走既定 fail-closed 路径，
    // 不得被 journal_mode pragma 的 protocol_error 抢先改变错误码。pragma 持久化
    // 于 DB 文件，重复设置幂等；synchronous=NORMAL 在 WAL 下仅可能丢最后一次
    // checkpoint 之前的落盘，事务完整性由 WAL 自身保证。
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(repo_err)?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(repo_err)?;
    validate_schema_objects(conn)?;
    validate_db_header(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_path() -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "pylon-session-pk-inventory-{}-{}-{}.db",
            std::process::id(),
            n,
            nanos
        ))
    }

    /// #654：读不出主键清单时必须上抛 `SessionError`，而不是在启动路径上 expect 掉进程。
    #[test]
    fn primary_key_inventory_reports_unreadable_db() {
        let path = unique_temp_path();
        std::fs::write(&path, b"this is not a sqlite database").expect("write corrupt db");
        let conn = Connection::open(&path).expect("open corrupt db");
        let error = primary_key_columns(&conn, "canonical_events")
            .expect_err("unreadable db must surface as Err");
        assert!(
            matches!(error, SessionError::Generic(ref message) if message.contains("message repo")),
            "expected repo_err wrapping, got {error:?}"
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
