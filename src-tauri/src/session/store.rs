//! SessionStore 薄 façade（方案 8）：把 session 映射的 destructive mutation
//! 收拢为带 generation 纪律的 API 边界。内部仍为 `runtime.sessions` 的
//! `Mutex<HashMap<String, SessionInfo>>`（不引入 actor/DB/新容器）。
//!
//! 首批方法对应现有 helper（replace_session_slot / with_session_if_matches /
//! remove_session_if_matches），现有函数委托本模块——行为封闭，逐步切换。
//! 锁序纪律：sessions → prompt_locks 单向；mapping_ready 通知在 insert 成功后。

use crate::agent::runtime::session_mapping_matches;
use crate::agent::runtime::{ClientActivation, SessionBindingHealth, SessionContinuity};
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::session::SessionInfo;

/// 会话映射操作错误（方案 8；与 PylonError::Protocol 文案兼容）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionStoreError {
    /// 映射不存在或 (peri_id, generation) 与当前映射不符（客户端已替换/会话已迁移）。
    Stale(String),
    /// 会话数达到上限。
    MaxSessions,
    /// 锁中毒。
    LockPoisoned(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionProbeCandidate {
    pub(crate) source: String,
    pub(crate) peri_id: String,
    pub(crate) cwd: String,
    pub(crate) from_generation: u64,
}

/// 插入会话映射（方案 8，对应 replace_session_slot）：满额策略 +
/// 同 source 替换 + mapping_ready 通知。返回被替换的旧映射（如有）。
pub(crate) fn insert(
    runtime: &AgentRuntime,
    source: &str,
    session: SessionInfo,
    allow_same_source_replace: bool,
    max_sessions: usize,
) -> Result<Option<SessionInfo>, SessionStoreError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
    if sessions.len() >= max_sessions
        && !(allow_same_source_replace && sessions.contains_key(source))
    {
        return Err(SessionStoreError::MaxSessions);
    }
    let replaced = sessions.insert(source.to_string(), session);
    drop(sessions);
    runtime.mapping_ready.notify_waiters();
    Ok(replaced)
}

/// Applies the remote-continuity meaning of a newly activated client. All fallible locks are
/// acquired before either map is mutated, so callers can still keep process activation atomic.
pub(crate) fn apply_client_activation(
    runtime: &AgentRuntime,
    activation: ClientActivation,
) -> Result<Vec<SessionProbeCandidate>, SessionStoreError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|error| SessionStoreError::LockPoisoned(error.to_string()))?;
    let mut health = runtime
        .binding_health
        .lock()
        .map_err(|error| SessionStoreError::LockPoisoned(error.to_string()))?;
    let target_generation = activation.epoch.0;
    match activation.continuity {
        SessionContinuity::Preserved => {
            for (source, session) in sessions.iter_mut() {
                session.generation = target_generation;
                health.insert(
                    source.clone(),
                    SessionBindingHealth::Attached {
                        generation: target_generation,
                    },
                );
            }
            Ok(Vec::new())
        }
        SessionContinuity::Invalidated => {
            let stale = sessions
                .keys()
                .map(|source| SessionProbeCandidate {
                    source: source.clone(),
                    peri_id: sessions[source].peri_id.clone(),
                    cwd: sessions[source].cwd.clone(),
                    from_generation: sessions[source].generation,
                })
                .collect::<Vec<_>>();
            sessions.clear();
            for candidate in &stale {
                health.insert(
                    candidate.source.clone(),
                    SessionBindingHealth::Detached {
                        target_generation,
                        reason: "client activation invalidated the remote session binding".into(),
                        retryable: true,
                    },
                );
            }
            Ok(stale)
        }
        SessionContinuity::Unknown => {
            let candidates = sessions
                .iter()
                .map(|(source, session)| SessionProbeCandidate {
                    source: source.clone(),
                    peri_id: session.peri_id.clone(),
                    cwd: session.cwd.clone(),
                    from_generation: session.generation,
                })
                .collect::<Vec<_>>();
            for candidate in &candidates {
                health.insert(
                    candidate.source.clone(),
                    SessionBindingHealth::Probing {
                        from_generation: candidate.from_generation,
                        target_generation,
                    },
                );
            }
            Ok(candidates)
        }
    }
}

pub(crate) fn mark_attached_if_current(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    expected_generation: u64,
    attached_generation: u64,
) -> Result<bool, SessionStoreError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|error| SessionStoreError::LockPoisoned(error.to_string()))?;
    let mut health = runtime
        .binding_health
        .lock()
        .map_err(|error| SessionStoreError::LockPoisoned(error.to_string()))?;
    let Some(session) = sessions.get_mut(source) else {
        return Ok(false);
    };
    if !session_mapping_matches(
        &session.peri_id,
        session.generation,
        peri_id,
        expected_generation,
    ) {
        return Ok(false);
    }
    session.generation = attached_generation;
    health.insert(
        source.to_string(),
        SessionBindingHealth::Attached {
            generation: attached_generation,
        },
    );
    drop(health);
    drop(sessions);
    runtime.mapping_ready.notify_waiters();
    Ok(true)
}

// clippy 2026-09-22：8 参均为独立 detach 判定/报告入参（runtime/source/peri_id/
// 新旧 generation/reason/retryable/remove_mapping），语义互不分组，保持显式签名。
#[allow(clippy::too_many_arguments)]
pub(crate) fn mark_detached_if_current(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    expected_generation: u64,
    target_generation: u64,
    reason: String,
    retryable: bool,
    remove_mapping: bool,
) -> Result<bool, SessionStoreError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|error| SessionStoreError::LockPoisoned(error.to_string()))?;
    let mut health = runtime
        .binding_health
        .lock()
        .map_err(|error| SessionStoreError::LockPoisoned(error.to_string()))?;
    let current = sessions.get(source).is_some_and(|session| {
        session_mapping_matches(
            &session.peri_id,
            session.generation,
            peri_id,
            expected_generation,
        )
    });
    if !current {
        return Ok(false);
    }
    if remove_mapping {
        sessions.remove(source);
    }
    health.insert(
        source.to_string(),
        SessionBindingHealth::Detached {
            target_generation,
            reason,
            retryable,
        },
    );
    drop(health);
    drop(sessions);
    if remove_mapping {
        runtime.remove_prompt_lock(source);
    }
    Ok(true)
}

/// 条件更新（方案 8，对应 with_session_if_matches）：generation 复核 +
/// (peri_id, generation) 匹配才更新。
pub(crate) fn update_if_current<T>(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    update: impl FnOnce(&mut SessionInfo) -> T,
) -> Result<T, SessionStoreError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
    let session = sessions.get_mut(source).ok_or_else(|| {
        SessionStoreError::Stale(format!("stale session mapping for source: {source}"))
    })?;
    if !session_mapping_matches(&session.peri_id, session.generation, peri_id, generation) {
        return Err(SessionStoreError::Stale(format!(
            "stale session mapping for source: {source}"
        )));
    }
    Ok(update(session))
}

/// 条件删除（方案 8，对应 remove_session_if_matches）：(peri_id, generation)
/// 匹配才删除，且锁外收敛 prompt 锁（锁序单向）。返回是否删除。
pub(crate) fn remove_if_current(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
) -> Result<bool, SessionStoreError> {
    let removed = {
        let mut sessions = runtime
            .sessions
            .lock()
            .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
        if sessions.get(source).map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true)
        {
            sessions.remove(source).is_some()
        } else {
            false
        }
    };
    if removed {
        if let Ok(mut health) = runtime.binding_health.lock() {
            health.remove(source);
        }
        runtime.remove_prompt_lock(source);
    }
    Ok(removed)
}

/// 条件删除（方案 8 步骤 4，expiry 场景）：(peri_id, generation) 匹配 + 锁内
/// updated_at 复核——快照值与删除时点之间新消息到达会刷新 updated_at，不得
/// 误杀刚活跃的会话。复核函数由调用方传入（expiry 域的 session_expired 纯函数），
/// store 保持无域依赖；锁外收敛 prompt 锁（锁序单向）。
pub(crate) fn remove_if_current_expired<F>(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    still_expired: F,
) -> Result<bool, SessionStoreError>
where
    F: FnOnce(&SessionInfo) -> bool,
{
    let removed = {
        let mut sessions = runtime
            .sessions
            .lock()
            .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
        let current = sessions.get(source);
        let matches = current.map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true);
        if matches && current.is_some_and(still_expired) {
            sessions.remove(source).is_some()
        } else {
            false
        }
    };
    if removed {
        if let Ok(mut health) = runtime.binding_health.lock() {
            health.remove(source);
        }
        runtime.remove_prompt_lock(source);
    }
    Ok(removed)
}

pub(crate) fn snapshot(
    runtime: &AgentRuntime,
) -> Result<Vec<(String, SessionInfo)>, SessionStoreError> {
    let sessions = runtime
        .sessions
        .lock()
        .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
    Ok(sessions
        .iter()
        .map(|(source, info)| (source.clone(), info.clone()))
        .collect())
}

/// 供 lib.rs（replace_agent_client）用：生成状态消息文案。
impl std::fmt::Display for SessionStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stale(msg) => write!(f, "{msg}"),
            Self::MaxSessions => write!(f, "max sessions reached"),
            Self::LockPoisoned(msg) => write!(f, "{msg}"),
        }
    }
}

// ── #707-B：prompt 管线散点锁收敛（锁序纪律从注释约束升级为容器方法约束）──

/// prompt 管线的映射触碰（G2-08 锁合并读面收敛单点）——profile 附着 +
/// updated_at 刷新 + `(peri_id, generation, is_first)` 读取在锁内一次完成。
/// 原 `ensure_session_mapping` 内联锁段收口；返回 `None` = 无映射（调用方走
/// revive/create）。generation 供 #702 的发送前代际复核。
pub(crate) fn touch_for_prompt(
    runtime: &AgentRuntime,
    source: &str,
    profile_id: Option<&str>,
) -> Result<Option<(String, u64, bool)>, PylonError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|e| PylonError::Protocol(e.to_string()))?;
    Ok(match sessions.get_mut(source) {
        Some(session) => {
            session.attach_profile_id(profile_id, source)?;
            session.updated_at = Some(crate::time::Timestamp::now());
            Some((
                session.peri_id.clone(),
                session.generation,
                !session.has_first_prompt,
            ))
        }
        None => None,
    })
}

/// 回合起点的会话状态推进（R33b advance_round + #352 cancel 判死输入清除，
/// 「新回合开始」的两点会话态变更合并为单次锁内完成）。
///
/// fail-closed（#331 例外一，#706）：锁中毒/映射缺失一律 `Err`——调用方在
/// 出站发送**之前**传播（此时 `PreparedRpc` 未发送即丢弃，无 wire 副作用），
/// 替代旧 `advance_round` 的 `if let Ok` 静默跳过。
///
/// 行为注记：cancel 清除点由「出站成功 + 账本 begin 之后」前移到发送前——
/// prompt_gate 串行化保证本回合开始时上一回合等待循环已收敛（无并发消费者），
/// 两位置可观察行为等价；发送失败路径多清一次陈旧标志（无观察者）。
pub(crate) fn begin_turn_state(runtime: &AgentRuntime, source: &str) -> Result<(), PylonError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|e| PylonError::Protocol(e.to_string()))?;
    let session = sessions.get_mut(source).ok_or_else(|| {
        PylonError::Protocol(format!("session mapping vanished for source: {source}"))
    })?;
    session.inject_round = session.inject_round.saturating_add(1);
    // B11.2：先标记收集回合（dispatcher 据此绑定流式收集），再清空文本。
    session.last_response_round = session.inject_round;
    session.last_response_text.clear();
    // R-t5：上一回合的 activity 不能被当前 prompt 当成“已经收到首个 token”。
    session.last_activity = None;
    // #352：清除旧回合的 cancel 判死输入（generation 键化见 mark_cancel_requested）。
    session.clear_cancel_requested_for_new_turn();
    Ok(())
}

/// prompt 管线的注入轮次读（R33a `message_round`；无映射 = 0，与原实现一致）。
pub(crate) fn inject_round(runtime: &AgentRuntime, source: &str) -> Result<u64, PylonError> {
    let sessions = runtime
        .sessions
        .lock()
        .map_err(|e| PylonError::Protocol(e.to_string()))?;
    Ok(sessions.get(source).map(|s| s.inject_round).unwrap_or(0))
}

/// liveness 探针读（R-t5）——本会话最近一次 ACP 活动时刻。锁中毒按 None +
/// warn（dev 下维持原退化语义：判为无活动；release `panic = "abort"` 下不可达）。
pub(crate) fn last_activity(runtime: &AgentRuntime, source: &str) -> Option<std::time::Instant> {
    match runtime.sessions.lock() {
        Ok(sessions) => sessions.get(source).and_then(|s| s.last_activity),
        Err(_) => {
            tracing::warn!("sessions lock poisoned; liveness probe reads no activity");
            None
        }
    }
}

/// 建会话槽位上限预检（`create_session_slot` 的存在性读取；满额文案与原实现
/// 逐字一致，由 `replace_session_slot`/`insert` 的写入侧复核兜底）。
pub(crate) fn slot_headroom(runtime: &AgentRuntime, max_sessions: usize) -> Result<(), PylonError> {
    let sessions = runtime
        .sessions
        .lock()
        .map_err(|e| PylonError::Protocol(e.to_string()))?;
    if sessions.len() >= max_sessions {
        return Err(PylonError::Protocol("max sessions reached".to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::runtime::{
        ClientActivation, ClientEpoch, SessionBindingHealth, SessionContinuity,
    };
    use std::sync::Arc;

    fn runtime() -> Arc<AgentRuntime> {
        AgentRuntime::new_disconnected()
    }

    fn session(id: &str, generation: u64) -> SessionInfo {
        SessionInfo::new(
            id.to_string(),
            "persona".to_string(),
            ".".to_string(),
            true,
            generation,
        )
    }

    #[test]
    fn insert_replaces_same_source_and_notifies_mapping_ready() {
        let rt = runtime();
        let replaced =
            insert(rt.as_ref(), "src", session("peri-1", 0), true, 100).expect("first insert");
        assert!(replaced.is_none(), "首次插入无旧映射");
        let replaced = insert(rt.as_ref(), "src", session("peri-2", 0), true, 100)
            .expect("same source replace");
        assert_eq!(
            replaced.unwrap().peri_id,
            "peri-1",
            "同 source 替换返回旧映射"
        );
        assert_eq!(
            snapshot(rt.as_ref()).unwrap().len(),
            1,
            "同 source 替换不增加条目"
        );
    }

    #[test]
    fn insert_enforces_max_sessions_without_same_source_override() {
        let rt = runtime();
        insert(rt.as_ref(), "a", session("p-a", 0), false, 1).expect("first");
        let err = insert(rt.as_ref(), "b", session("p-b", 0), false, 1)
            .err()
            .expect("满额必须拒绝");
        assert_eq!(err, SessionStoreError::MaxSessions);
        // 同 source 覆盖在满额时允许
        insert(rt.as_ref(), "a", session("p-a2", 0), true, 1).expect("同 source 覆盖允许");
    }

    #[test]
    fn update_if_current_rejects_stale_key() {
        let rt = runtime();
        insert(rt.as_ref(), "src", session("peri-1", 1), true, 100).unwrap();
        // 旧 peri_id + 旧 generation：stale
        let err = update_if_current(rt.as_ref(), "src", "peri-old", 0, |_| ())
            .expect_err("stale 必须拒绝");
        assert!(matches!(err, SessionStoreError::Stale(_)));
        // 匹配则更新
        update_if_current(rt.as_ref(), "src", "peri-1", 1, |s| s.model = "m".into()).unwrap();
        let snap = snapshot(rt.as_ref()).unwrap();
        assert_eq!(snap[0].1.model, "m");
    }

    #[test]
    fn remove_if_current_does_not_remove_newer_key() {
        let rt = runtime();
        insert(rt.as_ref(), "src", session("peri-1", 1), true, 100).unwrap();
        // 旧 generation 的 remove 不得删除新映射
        let removed = remove_if_current(rt.as_ref(), "src", "peri-1", 0).unwrap();
        assert!(!removed, "旧 generation 不得删除");
        assert_eq!(snapshot(rt.as_ref()).unwrap().len(), 1, "映射必须保留");
        // 匹配则删除
        let removed = remove_if_current(rt.as_ref(), "src", "peri-1", 1).unwrap();
        assert!(removed);
        assert!(snapshot(rt.as_ref()).unwrap().is_empty());
    }

    #[test]
    fn stale_attach_cannot_rebind_replaced_owner() {
        let rt = runtime();
        insert(rt.as_ref(), "src", session("peri-old", 1), true, 100).unwrap();
        insert(rt.as_ref(), "src", session("peri-new", 2), true, 100).unwrap();
        let attached = mark_attached_if_current(rt.as_ref(), "src", "peri-old", 1, 1).unwrap();
        assert!(!attached);
        assert_eq!(snapshot(rt.as_ref()).unwrap()[0].1.peri_id, "peri-new");
    }

    #[test]
    fn unknown_activation_marks_old_bindings_probing_without_migrating_them() {
        let rt = runtime();
        insert(rt.as_ref(), "a", session("p-a", 7), true, 100).unwrap();
        insert(rt.as_ref(), "b", session("p-b", 7), true, 100).unwrap();
        let activation = ClientActivation {
            epoch: ClientEpoch(8),
            continuity: SessionContinuity::Unknown,
        };

        let candidates = apply_client_activation(rt.as_ref(), activation).expect("activation");

        assert_eq!(candidates.len(), 2);
        assert!(snapshot(rt.as_ref())
            .unwrap()
            .iter()
            .all(|(_, session)| session.generation == 7));
        let health = rt.binding_health.lock().unwrap();
        assert!(health.values().all(|value| matches!(
            value,
            SessionBindingHealth::Probing {
                from_generation: 7,
                target_generation: 8
            }
        )));
    }

    #[test]
    fn explicitly_preserved_activation_migrates_and_attaches_bindings() {
        let rt = runtime();
        insert(rt.as_ref(), "src", session("peri-1", 7), true, 100).unwrap();
        let activation = ClientActivation {
            epoch: ClientEpoch(8),
            continuity: SessionContinuity::Preserved,
        };

        let candidates = apply_client_activation(rt.as_ref(), activation).expect("activation");

        assert!(candidates.is_empty());
        assert_eq!(snapshot(rt.as_ref()).unwrap()[0].1.generation, 8);
        assert!(matches!(
            rt.binding_health.lock().unwrap().get("src"),
            Some(SessionBindingHealth::Attached { generation: 8 })
        ));
    }
    // ── #707-B：prompt 管线散点锁收敛（含 #706 fail-closed）──

    /// touch_for_prompt：无映射返回 None；有映射返回 (peri, generation, is_first)
    /// 并刷新 updated_at（G2-08 语义）+ profile 附着（#702 的代际复核数据源）。
    #[test]
    fn touch_for_prompt_reads_mapping_and_refreshes() {
        let rt = runtime();
        assert!(
            touch_for_prompt(rt.as_ref(), "src", None).unwrap().is_none(),
            "无映射必须返回 None"
        );
        insert(rt.as_ref(), "src", session("peri-7", 3), true, 100).unwrap();
        let touched = touch_for_prompt(rt.as_ref(), "src", None)
            .expect("有映射必须成功")
            .expect("映射必须存在");
        assert_eq!(touched.0, "peri-7");
        assert_eq!(touched.1, 3, "generation 必须随映射透出（#702 复核输入）");
        assert!(!touched.2, "fixture has_first_prompt=true → is_first=false");
    }

    /// begin_turn_state：成功路径推进 inject_round/收集标记/清空文本/activity/
    /// cancel 判死输入；映射缺失 fail-closed Err（#706：不再静默跳过）。
    #[test]
    fn begin_turn_state_advances_and_fails_closed() {
        let rt = runtime();
        assert!(begin_turn_state(rt.as_ref(), "src").is_err(), "映射缺失必须 Err");
        insert(rt.as_ref(), "src", session("peri-7", 3), true, 100).unwrap();
        {
            let mut sessions = rt.sessions.lock().unwrap();
            let s = sessions.get_mut("src").unwrap();
            s.inject_round = 4;
            s.last_response_text.push_str("stale");
            s.last_activity = Some(std::time::Instant::now());
            s.mark_cancel_requested(3, std::time::Instant::now());
        }
        begin_turn_state(rt.as_ref(), "src").expect("推进必须成功");
        let sessions = rt.sessions.lock().unwrap();
        let s = sessions.get("src").unwrap();
        assert_eq!(s.inject_round, 5, "inject_round 必须 +1");
        assert_eq!(s.last_response_round, 5, "收集回合必须标记为最新");
        assert!(s.last_response_text.is_empty(), "上一回合文本必须清空");
        assert!(s.last_activity.is_none(), "activity 必须清空（R-t5）");
        assert!(s.cancel_requested.is_none(), "cancel 判死输入必须清除（#352）");
    }

    /// inject_round（无映射 = 0）与 slot_headroom（满额 Err 文案逐字）契约。
    #[test]
    fn inject_round_and_slot_headroom_contract() {
        let rt = runtime();
        assert_eq!(inject_round(rt.as_ref(), "src").unwrap(), 0, "无映射 = 0");
        insert(rt.as_ref(), "src", session("peri-1", 0), true, 100).unwrap();
        assert_eq!(inject_round(rt.as_ref(), "src").unwrap(), 0);
        assert!(
            insert(rt.as_ref(), "src2", session("peri-2", 0), true, 1).is_err(),
            "预检与写入侧同口径满额拒绝（len=1 >= max=1 且非同源替换）"
        );
        let err = slot_headroom(rt.as_ref(), 1).unwrap_err();
        assert_eq!(err.raw_message(), "max sessions reached", "文案逐字一致");
        assert!(slot_headroom(rt.as_ref(), 100).is_ok());
    }
}
