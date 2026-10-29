//! GUI-side agent runtime detection adapter.
//!
//! Pure discovery logic lives in `pylon-core::agent_detection` (standalone
//! binaries link only pylon-core). This module owns the stateful half the pure
//! library must not: the B0 `DetectionSnapshotStore` (TTL cache keyed by
//! provider selection / search roots / catalog revision, single-flight
//! coalescing, cancellation, and the generation fence that keeps a stale scan
//! from overwriting a newer snapshot), plus the Tauri command that matches
//! detected candidates against the running `agents.yaml` state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use crate::{error::PylonError, AppState};
use pylon_core::agent_detection as detection_core;

pub use pylon_core::agent_detection::*;

type ConfiguredRuntimes = HashMap<String, (String, String, Vec<String>)>;

/// A4/B0：设置页消费的检测结果 = 不可变 DetectionSnapshot（候选 + 每 provider
/// 双证据 + preflight 结论 + 时间戳/catalog revision/搜索指纹）+ 本次响应是否
/// 命中缓存。preflight 与 `pylon-detect` CLI 走同一份 `from_detection` 映射，
/// 所以面板与 CLI 不会各自算出不同的结论。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeDetectionView {
    #[serde(flatten)]
    pub snapshot: DetectionSnapshot,
    /// True when the snapshot was served from the TTL cache without running a
    /// scan for this request (a request that joined an in-flight scan counts
    /// as scanned, not cached).
    pub cached: bool,
    /// How long the scan that produced this snapshot took, in milliseconds
    /// (carried through cache hits as recorded evidence, not re-measured).
    pub probe_ms: u64,
}

// ── B0：DetectionSnapshotStore ──────────────────────────────────────────────

/// Cache identity of a detection request: which providers were selected, what
/// the machine's `agents.yaml` looked like (candidates carry
/// `alreadyImportedAgentId` markers derived from it), which roots were
/// searched, and which catalog revision the evidence was recorded against.
/// Any change in one of these is a different question and must be re-scanned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DetectionCacheKey {
    pub detector_ids: Option<Vec<String>>,
    pub configured_fingerprint: String,
    pub search_fingerprint: String,
    pub catalog_revision: String,
}

enum SnapshotEntry {
    Ready(Arc<DetectionSnapshot>),
    Failed(String),
}

struct CachedSnapshot {
    key: DetectionCacheKey,
    outcome: DetectionOutcome,
    recorded_at: Instant,
    probe_ms: u64,
    entry: SnapshotEntry,
}

struct InFlight {
    generation: u64,
    key: DetectionCacheKey,
    cancel: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
struct DetectionState {
    generation: u64,
    in_flight: Option<InFlight>,
    latest: Option<CachedSnapshot>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DetectionRefreshError {
    /// The refresh was superseded by a newer request or explicitly cancelled;
    /// no snapshot was stored.
    Cancelled,
    Scan(String),
}

/// What a satisfied detection request returns: the immutable snapshot, whether
/// it came from the TTL cache, and how long the scan that produced it took
/// (served alongside cache hits too, so "this evidence cost N ms" stays
/// observable after the scan that measured it).
#[derive(Debug)]
pub(crate) struct DetectionRefreshHit {
    pub snapshot: Arc<DetectionSnapshot>,
    pub cached: bool,
    pub probe_ms: u64,
}

/// Process-wide snapshot cache. Pure by injection: the scan future, the TTL
/// clock, and the wall-clock timestamp are all supplied by the caller, so the
/// store's behavior is fully testable without touching the filesystem.
pub(crate) struct DetectionSnapshotStore {
    state: Mutex<DetectionState>,
    completed: tokio::sync::Notify,
}

enum RefreshTicket {
    /// An in-flight scan for the same key exists: join it.
    Wait,
    /// This request owns the scan; `generation` is its fence token.
    Run {
        generation: u64,
        cancel: tokio::sync::watch::Receiver<bool>,
    },
}

impl DetectionSnapshotStore {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(DetectionState::default()),
            completed: tokio::sync::Notify::new(),
        }
    }

    /// Resolve a detection request against the cache.
    ///
    /// - Fresh cache entry for the same key → served without scanning.
    /// - In-flight scan for the same key → join it (single-flight; concurrent
    ///   requests never duplicate a scan).
    /// - Otherwise → cancel any in-flight scan for a different key, take the
    ///   next generation, and run `scan`.
    ///
    /// The generation fence: a completion stores its result only when it still
    /// owns the current generation, so an older or cancelled scan can never
    /// overwrite a newer snapshot.
    ///
    /// `now` is the TTL clock reading taken when the request arrived; tests
    /// inject a controlled value, production passes `Instant::now()`.
    pub(crate) async fn refresh<F, Fut>(
        &self,
        key: DetectionCacheKey,
        force: bool,
        now: Instant,
        scan: F,
    ) -> Result<DetectionRefreshHit, DetectionRefreshError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<AgentDetectionReport, String>>,
    {
        let mut scan = Some(scan);
        let mut joined = false;
        loop {
            // Register for completion before inspecting state: a completion
            // that lands after our check is guaranteed to wake this future.
            let notified = self.completed.notified();
            let ticket = {
                let mut state = self.lock();
                if !force {
                    if let Some(latest) = &state.latest {
                        if latest.key == key && now < latest.recorded_at + latest.outcome.ttl() {
                            match &latest.entry {
                                // A pure cache hit reports cached=true; a caller
                                // that joined an in-flight scan was served by a
                                // real scan, so it reports cached=false.
                                SnapshotEntry::Ready(snapshot) => {
                                    return Ok(DetectionRefreshHit {
                                        snapshot: snapshot.clone(),
                                        cached: !joined,
                                        probe_ms: latest.probe_ms,
                                    });
                                }
                                SnapshotEntry::Failed(message) => {
                                    return Err(DetectionRefreshError::Scan(message.clone()));
                                }
                            }
                        }
                    }
                }
                match &state.in_flight {
                    Some(in_flight) if in_flight.key == key => RefreshTicket::Wait,
                    in_flight => {
                        if let Some(in_flight) = in_flight {
                            // Different key: the newer request wins. Cancel the
                            // old scan; its completion will fail the fence.
                            let _ = in_flight.cancel.send(true);
                        }
                        state.generation += 1;
                        let generation = state.generation;
                        let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
                        state.in_flight = Some(InFlight {
                            generation,
                            key: key.clone(),
                            cancel,
                        });
                        RefreshTicket::Run {
                            generation,
                            cancel: cancel_rx,
                        }
                    }
                }
            };
            match ticket {
                RefreshTicket::Wait => {
                    joined = true;
                    notified.await;
                }
                RefreshTicket::Run {
                    generation,
                    mut cancel,
                } => {
                    let scan_started = Instant::now();
                    let result = tokio::select! {
                        result = (scan.take().expect("scan consumed once"))() => result,
                        _ = cancel.changed() => {
                            self.clear_in_flight(generation);
                            return Err(DetectionRefreshError::Cancelled);
                        }
                    };
                    let probe_ms =
                        scan_started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                    let outcome = DetectionOutcome::classify(&result);
                    match result {
                        Ok(report) => {
                            let snapshot = Arc::new(detection_core::assemble_detection_snapshot(
                                report,
                                detection_core::unix_epoch_ms(),
                                None,
                            ));
                            if self.store_completion(
                                generation,
                                key,
                                outcome,
                                probe_ms,
                                now,
                                SnapshotEntry::Ready(snapshot.clone()),
                            ) {
                                return Ok(DetectionRefreshHit {
                                    snapshot,
                                    cached: false,
                                    probe_ms,
                                });
                            }
                            return Err(DetectionRefreshError::Cancelled);
                        }
                        Err(message) => {
                            self.store_completion(
                                generation,
                                key,
                                outcome,
                                probe_ms,
                                now,
                                SnapshotEntry::Failed(message.clone()),
                            );
                            return Err(DetectionRefreshError::Scan(message));
                        }
                    }
                }
            }
        }
    }

    /// Cancel the in-flight refresh, if any. The cancelled scan's result is
    /// discarded by the generation fence; the next request scans again.
    pub(crate) fn cancel_active(&self) -> bool {
        let mut state = self.lock();
        state.generation += 1;
        let Some(in_flight) = state.in_flight.take() else {
            return false;
        };
        let _ = in_flight.cancel.send(true);
        self.completed.notify_waiters();
        true
    }

    fn clear_in_flight(&self, generation: u64) {
        let mut state = self.lock();
        if state
            .in_flight
            .as_ref()
            .is_some_and(|in_flight| in_flight.generation == generation)
        {
            state.in_flight = None;
        }
        self.completed.notify_waiters();
    }

    /// Fence-checked completion store. Returns false (and stores nothing) when
    /// a newer refresh superseded this one.
    fn store_completion(
        &self,
        generation: u64,
        key: DetectionCacheKey,
        outcome: DetectionOutcome,
        probe_ms: u64,
        recorded_at: Instant,
        entry: SnapshotEntry,
    ) -> bool {
        let mut state = self.lock();
        let still_current = state
            .in_flight
            .as_ref()
            .is_some_and(|in_flight| in_flight.generation == generation);
        if still_current {
            state.in_flight = None;
            state.latest = Some(CachedSnapshot {
                key,
                outcome,
                recorded_at,
                probe_ms,
                entry,
            });
        }
        self.completed.notify_waiters();
        still_current
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, DetectionState> {
        // A poisoned lock means a panic while holding app-wide detection state;
        // failing closed to a fresh (empty) state keeps the command alive and
        // simply re-scans.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// #684：检测快照缓存按**进程**单例——产品语义即"整个应用共享一份探测结果"
/// （TTL 缓存 + 单飞，见 [`DetectionSnapshotStore`]）。这是显式的进程级产品状态，
/// 不是遗漏的全局注册表；单元测试不读本单例，而是各自构造
/// [`DetectionSnapshotStore`]（同一进程并行测试互不共享缓存）。
static SNAPSHOT_STORE: OnceLock<DetectionSnapshotStore> = OnceLock::new();

fn snapshot_store() -> &'static DetectionSnapshotStore {
    SNAPSHOT_STORE.get_or_init(DetectionSnapshotStore::new)
}

/// Fingerprint the running `agents.yaml` view: candidates carry
/// `alreadyImportedAgentId` markers derived from it, so a config change must
/// invalidate the snapshot cache even though providers and roots are equal.
fn configured_fingerprint(configured: &ConfiguredRuntimes) -> String {
    let mut lines: Vec<String> = configured
        .iter()
        .map(|(id, (provider, executable, args))| {
            format!(
                "{id}\u{0}{provider}\u{0}{executable}\u{0}{}",
                args.join(" ")
            )
        })
        .collect();
    lines.sort();
    pylon_core::fnv1a::fnv1a_64_prefixed(lines.join("\n").as_bytes())
}

#[tauri::command]
pub(crate) async fn detect_agent_runtimes(
    state: tauri::State<'_, AppState>,
    detector_ids: Option<Vec<String>>,
    force: Option<bool>,
) -> Result<AgentRuntimeDetectionView, PylonError> {
    let configured: ConfiguredRuntimes = state
        .agents
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))?
        .iter()
        .map(|(id, agent)| {
            (
                id.clone(),
                (
                    agent.provider.clone().unwrap_or_default().to_lowercase(),
                    detection_core::configured_executable_key(&agent.exe),
                    agent.args.clone(),
                ),
            )
        })
        .collect();
    let detector_ids = detector_ids.map(|ids| {
        let mut seen = std::collections::HashSet::new();
        ids.into_iter()
            .filter(|id| seen.insert(id.clone()))
            .collect()
    });
    let key = DetectionCacheKey {
        detector_ids: detector_ids.clone(),
        configured_fingerprint: configured_fingerprint(&configured),
        search_fingerprint: detection_core::search_roots_fingerprint(None),
        catalog_revision: pylon_core::agent_catalog::catalog_revision().to_string(),
    };
    let options = detection_core::AgentDetectionOptions {
        detector_ids,
        ..detection_core::AgentDetectionOptions::default()
    };
    let scan_configured = configured.clone();
    let hit = snapshot_store()
        .refresh(key, force.unwrap_or(false), Instant::now(), move || {
            let options = options.clone();
            async move {
                detection_core::detect_agent_runtime_candidates_inner(options, &scan_configured)
                    .await
            }
        })
        .await
        .map_err(|error| match error {
            DetectionRefreshError::Cancelled => {
                PylonError::Protocol("agent_detection_refresh_cancelled".into())
            }
            DetectionRefreshError::Scan(message) => PylonError::Protocol(message),
        })?;
    Ok(AgentRuntimeDetectionView {
        snapshot: (*hit.snapshot).clone(),
        cached: hit.cached,
        probe_ms: hit.probe_ms,
    })
}

/// B0：取消进行中的探测刷新（设置页离开/切 agent 时调用）；无在途刷新时为
/// no-op。被取消的扫描结果不落地（generation fence）。
#[tauri::command]
pub(crate) fn cancel_detection_refresh() -> bool {
    snapshot_store().cancel_active()
}

// ── B0：store 行为测试（注入 scan/ttl 时钟，不触盘） ──

#[cfg(test)]
mod store_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn key(label: &str) -> DetectionCacheKey {
        DetectionCacheKey {
            detector_ids: Some(vec![label.to_string()]),
            configured_fingerprint: "cfg".into(),
            search_fingerprint: "search".into(),
            catalog_revision: "rev".into(),
        }
    }

    fn clean_report() -> AgentDetectionReport {
        AgentDetectionReport {
            candidates: Vec::new(),
            providers: Vec::new(),
            diagnostics: Vec::new(),
            elapsed_ms: 1,
            truncated: false,
        }
    }

    fn counter() -> Arc<AtomicUsize> {
        Arc::new(AtomicUsize::new(0))
    }

    #[tokio::test]
    async fn success_is_served_from_cache_within_ttl() {
        let store = DetectionSnapshotStore::new();
        let now = Instant::now();
        let scans = counter();
        let first = store
            .refresh(key("a"), false, now, || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Ok(clean_report()) }
            })
            .await
            .unwrap();
        assert!(!first.cached, "首次必须真实扫描");

        let within_ttl = now + Duration::from_secs(599);
        let second = store
            .refresh(key("a"), false, within_ttl, || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Ok(clean_report()) }
            })
            .await
            .unwrap();
        assert!(second.cached, "TTL 内必须命中缓存");
        assert_eq!(
            second.probe_ms, first.probe_ms,
            "缓存命中必须携带记录过的探测耗时，而不是重新测量"
        );
        assert_eq!(scans.load(Ordering::SeqCst), 1, "命中缓存不得再次扫描");

        let expired = now + Duration::from_secs(601);
        let third = store
            .refresh(key("a"), false, expired, || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Ok(clean_report()) }
            })
            .await
            .unwrap();
        assert!(!third.cached, "TTL 过期必须重新扫描");
        assert_eq!(scans.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failure_is_cached_with_a_short_ttl() {
        let store = DetectionSnapshotStore::new();
        let now = Instant::now();
        let scans = counter();
        let first = store
            .refresh(key("f"), false, now, || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Err("catalog broken".to_string()) }
            })
            .await;
        assert_eq!(
            first.unwrap_err(),
            DetectionRefreshError::Scan("catalog broken".into())
        );

        let within = now + Duration::from_secs(14);
        let second = store
            .refresh(key("f"), false, within, || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Err("catalog broken".to_string()) }
            })
            .await;
        assert_eq!(
            second.unwrap_err(),
            DetectionRefreshError::Scan("catalog broken".into()),
            "失败在短 TTL 内同样被缓存，重试风暴不得变成扫描风暴"
        );
        assert_eq!(scans.load(Ordering::SeqCst), 1);

        let expired = now + Duration::from_secs(16);
        let third = store
            .refresh(key("f"), false, expired, || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Ok(clean_report()) }
            })
            .await;
        assert!(third.is_ok(), "失败过期后必须重新扫描");
        assert_eq!(scans.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn degraded_unknown_outcome_uses_the_middle_ttl() {
        let store = DetectionSnapshotStore::new();
        let now = Instant::now();
        let degraded = || {
            let mut report = clean_report();
            report.truncated = true;
            async move { Ok(report) }
        };
        store.refresh(key("u"), false, now, degraded).await.unwrap();

        let at_59s = now + Duration::from_secs(59);
        let still = store
            .refresh(key("u"), false, at_59s, degraded)
            .await
            .unwrap();
        assert!(still.cached, "Unknown 在 60s TTL 内命中缓存");

        let at_61s = now + Duration::from_secs(61);
        let rescan = store
            .refresh(key("u"), false, at_61s, degraded)
            .await
            .unwrap();
        assert!(!rescan.cached, "Unknown 过 60s 必须重新扫描");
    }

    #[tokio::test]
    async fn a_different_key_supersedes_and_the_stale_result_never_lands() {
        let store = Arc::new(DetectionSnapshotStore::new());
        let slow_started = Arc::new(tokio::sync::Notify::new());
        let slow_key = key("slow");
        let started_signal = slow_started.clone();
        let slow = {
            let store = store.clone();
            tokio::spawn(async move {
                store
                    .refresh(slow_key, false, Instant::now(), move || {
                        Box::pin(async move {
                            started_signal.notify_one();
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            Ok(clean_report())
                        })
                    })
                    .await
            })
        };
        slow_started.notified().await;

        let fast = store
            .refresh(key("fast"), false, Instant::now(), || async {
                Ok(clean_report())
            })
            .await
            .unwrap();
        assert!(!fast.cached);
        let stale = slow.await.unwrap().unwrap_err();
        assert_eq!(stale, DetectionRefreshError::Cancelled);

        // 被抢占的旧 key 后续读取必须重新扫描（旧结果没有落地为缓存）。
        let scans = counter();
        let fresh = store
            .refresh(key("slow"), false, Instant::now(), || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Ok(clean_report()) }
            })
            .await
            .unwrap();
        assert!(!fresh.cached);
        assert_eq!(scans.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancel_active_discards_the_in_flight_scan() {
        let store = Arc::new(DetectionSnapshotStore::new());
        let started = Arc::new(tokio::sync::Notify::new());
        let started_signal = started.clone();
        let cancel_key = key("c");
        let scan = {
            let store = store.clone();
            tokio::spawn(async move {
                store
                    .refresh(cancel_key, false, Instant::now(), move || {
                        Box::pin(async move {
                            started_signal.notify_one();
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            Ok(clean_report())
                        })
                    })
                    .await
            })
        };
        started.notified().await;
        assert!(store.cancel_active());
        assert_eq!(
            scan.await.unwrap().unwrap_err(),
            DetectionRefreshError::Cancelled
        );
        assert!(!store.cancel_active(), "无在途刷新时取消是 no-op");
    }

    #[tokio::test]
    async fn same_key_requests_join_one_scan() {
        let store = Arc::new(DetectionSnapshotStore::new());
        let scan_started = Arc::new(tokio::sync::Notify::new());
        let scan_release = Arc::new(tokio::sync::Notify::new());
        let scans = counter();
        let first = {
            let store = store.clone();
            let scans = scans.clone();
            let started = scan_started.clone();
            let release = scan_release.clone();
            let join_key = key("join");
            tokio::spawn(async move {
                store
                    .refresh(join_key, false, Instant::now(), move || {
                        scans.fetch_add(1, Ordering::SeqCst);
                        Box::pin(async move {
                            started.notify_one();
                            release.notified().await;
                            Ok(clean_report())
                        })
                    })
                    .await
            })
        };
        // 首个请求已注册在途扫描并挂起，此时第二个同 key 请求必然走 Wait 加入。
        scan_started.notified().await;
        let second = {
            let store = store.clone();
            let join_key = key("join");
            tokio::spawn(async move {
                store
                    .refresh(join_key, false, Instant::now(), || async {
                        unreachable!("同 key 在途时不得再次扫描")
                    })
                    .await
            })
        };
        // 让出调度，使第二个任务完成 Wait 注册并挂起。
        tokio::time::sleep(Duration::from_millis(50)).await;
        scan_release.notify_one();

        let (a, b) = tokio::join!(first, second);
        let (a, b) = (a.unwrap().unwrap(), b.unwrap().unwrap());
        assert_eq!(
            scans.load(Ordering::SeqCst),
            1,
            "同 key 并发请求必须合并为一次扫描"
        );
        assert!(!a.cached, "首个请求经真实扫描");
        assert!(!b.cached, "加入者由真实扫描服务，而非 TTL 缓存");
    }

    #[tokio::test]
    async fn force_bypasses_the_ttl_cache() {
        let store = DetectionSnapshotStore::new();
        let now = Instant::now();
        let scans = counter();
        store
            .refresh(key("force"), false, now, || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Ok(clean_report()) }
            })
            .await
            .unwrap();

        let forced = store
            .refresh(key("force"), true, now, || {
                scans.fetch_add(1, Ordering::SeqCst);
                async { Ok(clean_report()) }
            })
            .await
            .unwrap();
        assert!(!forced.cached, "force 必须绕过 TTL 缓存");
        assert_eq!(scans.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn configured_fingerprint_tracks_the_configured_set() {
        let mut configured = ConfiguredRuntimes::new();
        configured.insert(
            "a".into(),
            ("peri".into(), "C:/bin/peri.exe".into(), vec!["acp".into()]),
        );
        let base = configured_fingerprint(&configured);
        assert_eq!(base, configured_fingerprint(&configured));

        configured.insert(
            "b".into(),
            ("hermes".into(), "C:/bin/hermes.exe".into(), vec![]),
        );
        assert_ne!(base, configured_fingerprint(&configured));
    }

    /// L8 FNV 收编保值断言：哈希值进入 DetectionCacheKey（进而影响缓存命中），
    /// `fnv1a-` 前缀 + 16 位十六进制是既有输出契约；本字面量与收编前手写循环
    /// 的输出逐位一致（独立参考实现复核）。
    #[test]
    fn configured_fingerprint_keeps_the_verbatim_fnv1a_output() {
        let mut configured = ConfiguredRuntimes::new();
        configured.insert(
            "a".into(),
            ("peri".into(), "C:/bin/peri.exe".into(), vec!["acp".into()]),
        );
        assert_eq!(
            configured_fingerprint(&configured),
            "fnv1a-03141af6f159a796"
        );
    }
}
