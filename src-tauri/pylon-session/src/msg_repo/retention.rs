//! 保留策略的 SQLite 边界。预览只读，清理在同一事务内校验策略版本、统计并删除。

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use super::{lock_err, now_millis, repo_err, MsgRepo, SessionError};
use crate::retention::{RetentionMode, RetentionPolicy};

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

impl MsgRepo {
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

    /// 原子写入 RetentionService 校验过的策略，推进单行策略版本。
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
        let current = current_policy_revision(&tx)?;
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

    /// 统计将删除的 canonical 事件，按 durable owner 汇总。
    pub fn retention_candidates(
        &self,
        policy: &RetentionPolicy,
    ) -> Result<RetentionPreview, SessionError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        Selection::from_policy(policy, now_millis()).preview(&conn)
    }

    /// 在版本校验后的事务快照上重新统计，用同一组边界执行删除。
    pub fn prune_by_policy(
        &self,
        policy: &RetentionPolicy,
        expected_policy_revision: Option<i64>,
    ) -> Result<RetentionPreview, SessionError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        let actual = current_policy_revision(&tx)?;
        if let Some(expected) = expected_policy_revision {
            if expected != actual {
                return Err(SessionError::StalePreview { expected, actual });
            }
        }
        let selection = Selection::from_policy(policy, now_millis());
        let preview = selection.preview(&tx)?;
        selection.delete(&tx, &preview.per_session)?;
        tx.commit().map_err(repo_err)?;
        Ok(preview)
    }
}

fn current_policy_revision(conn: &Connection) -> Result<i64, SessionError> {
    conn.query_row(
        "SELECT COALESCE(MAX(revision), 0) FROM retention_policy WHERE singleton = 1",
        [],
        |row| row.get(0),
    )
    .map_err(repo_err)
}

/// 一次操作只计算一次截止时间，使统计、删除与报告共用同一边界。
enum Selection {
    Permanent,
    Before(i64),
    KeepPerOwner(i64),
}

impl Selection {
    fn from_policy(policy: &RetentionPolicy, now: i64) -> Self {
        match policy.mode {
            RetentionMode::Permanent => Self::Permanent,
            RetentionMode::ByTime => {
                Self::Before(now - i64::from(policy.days.unwrap_or(0)) * 86_400_000)
            }
            RetentionMode::ByCount => Self::KeepPerOwner(i64::from(policy.count.unwrap_or(0))),
        }
    }

    fn preview(&self, conn: &Connection) -> Result<RetentionPreview, SessionError> {
        let (per_session, cutoff) = match *self {
            Self::Permanent => (Vec::new(), None),
            Self::Before(cutoff) => (
                candidate_counts(
                    conn,
                    "SELECT owner_key, COUNT(*) FROM canonical_events
                     WHERE created_at < ?1 GROUP BY owner_key",
                    cutoff,
                )?,
                Some(cutoff),
            ),
            Self::KeepPerOwner(limit) => (
                candidate_counts(
                    conn,
                    "SELECT owner_key, COUNT(*) - ?1 FROM canonical_events
                     GROUP BY owner_key HAVING COUNT(*) > ?1",
                    limit,
                )?,
                None,
            ),
        };
        Ok(RetentionPreview {
            total_candidates: per_session.iter().map(|owner| owner.count).sum(),
            affected_sessions: per_session.len() as i64,
            oldest_deleted_at: cutoff,
            per_session,
        })
    }

    fn delete(
        &self,
        tx: &Transaction<'_>,
        candidates: &[SessionCandidateCount],
    ) -> Result<(), SessionError> {
        match *self {
            Self::Permanent => {}
            Self::Before(cutoff) => {
                // 即使没有已提交事件，草稿片段也可能单独过期。
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
            Self::KeepPerOwner(_) => {
                // 在 (owner_key, sequence) 主键内按条数寻找最后一个候选，支持稀疏序号。
                // 子查询只绑定当前 owner 的参数，一次删除只计算一次边界。
                let mut delete = tx
                    .prepare(
                        "DELETE FROM canonical_events WHERE owner_key = ?1 AND sequence <= (
                         SELECT sequence FROM canonical_events WHERE owner_key = ?1
                         ORDER BY sequence ASC LIMIT 1 OFFSET ?2
                     )",
                    )
                    .map_err(repo_err)?;
                for owner in candidates {
                    delete
                        .execute(params![owner.session_id, owner.count - 1])
                        .map_err(repo_err)?;
                }
            }
        }
        Ok(())
    }
}

fn candidate_counts(
    conn: &Connection,
    sql: &str,
    bound: i64,
) -> Result<Vec<SessionCandidateCount>, SessionError> {
    let mut stmt = conn.prepare(sql).map_err(repo_err)?;
    let counts = stmt
        .query_map([bound], |row| {
            Ok(SessionCandidateCount {
                session_id: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(repo_err)?;
    counts.collect::<Result<_, _>>().map_err(repo_err)
}
