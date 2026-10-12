//! #155 T3: compare committed rows and cumulative WAL for equal 600-chunk input.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::{DraftFragmentInput, EventRepo, KernelEventInput};
use crate::owner::DurableSessionOwner;

fn bench_path(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "pylon-t3-{label}-{}-{}.db",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn wal_bytes(path: &Path) -> u64 {
    std::fs::metadata(format!("{}-wal", path.display()))
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn main_db_bytes(repo: &EventRepo) -> u64 {
    let conn = repo.conn.lock().unwrap();
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .unwrap();
    let pages: i64 = conn
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap();
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .unwrap();
    (pages * page_size) as u64
}

fn input(owner: &DurableSessionOwner, raw_payload: serde_json::Value) -> KernelEventInput {
    KernelEventInput {
        owner: owner.clone(),
        remote_session_id: Some("remote-1".into()),
        client_generation: 5,
        received_at: "2026-09-25T00:00:00.000Z".into(),
        occurred_at: None,
        raw_payload: Arc::new(raw_payload),
        import_origin: super::row::EventImportOrigin::Live,
    }
}

#[test]
fn cross_window_draft_storage_bench() {
    let raw = (0..600)
        .map(|index| {
            serde_json::json!({
                "source": "local:s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"text": format!("chunk {index:04}: {}", "流式样例".repeat(4))}
                }
            })
        })
        .collect::<Vec<_>>();
    let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
    let owner_key = owner.key().unwrap();
    let window_path = bench_path("window");
    let draft_path = bench_path("draft");

    let window = EventRepo::open(&window_path).expect("window repo");
    window
        .conn
        .lock()
        .unwrap()
        .execute_batch("PRAGMA wal_autocheckpoint=0")
        .unwrap();
    let window_started = std::time::Instant::now();
    for batch in raw.chunks(32) {
        window
            .ingest_kernel_events(
                batch
                    .iter()
                    .cloned()
                    .map(|raw| input(&owner, raw))
                    .collect(),
            )
            .expect("window ingest");
    }
    let window_elapsed = window_started.elapsed();
    let window_wal = wal_bytes(&window_path);
    let window_rows: i64 = window
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
            row.get(0)
        })
        .unwrap();
    let window_db = main_db_bytes(&window);

    let draft = EventRepo::open(&draft_path).expect("draft repo");
    draft
        .conn
        .lock()
        .unwrap()
        .execute_batch("PRAGMA wal_autocheckpoint=0")
        .unwrap();
    let draft_started = std::time::Instant::now();
    for (index, batch) in raw.chunks(4).enumerate() {
        draft
            .append_draft_fragment(DraftFragmentInput {
                owner: owner.clone(),
                draft_id: "bench-run".into(),
                fragment_index: index as i64,
                client_generation: 5,
                remote_session_id: Some("remote-1".into()),
                event_type: "assistant.text.delta".into(),
                identity: None,
                raw_payload: batch.to_vec(),
                first_received_at: "2026-09-25T00:00:00.000Z".into(),
            })
            .expect("draft append");
    }
    let recovery_started = std::time::Instant::now();
    let recovered = draft
        .list_draft_fragments(&owner_key)
        .expect("draft recovery");
    let recovery_elapsed = recovery_started.elapsed();
    assert_eq!(recovered.len(), 150);
    draft
        .commit_draft_events(
            raw.iter().cloned().map(|raw| input(&owner, raw)).collect(),
            "bench-run",
        )
        .expect("draft commit");
    let draft_elapsed = draft_started.elapsed();
    let draft_wal = wal_bytes(&draft_path);
    let draft_rows: i64 = draft
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
            row.get(0)
        })
        .unwrap();
    let draft_db = main_db_bytes(&draft);
    println!(
        "#155 T3 600 chunk: window rows={window_rows} wal={window_wal} db={window_db} elapsed={window_elapsed:?}; draft rows={draft_rows} wal={draft_wal} db={draft_db} elapsed={draft_elapsed:?}; recovery fragments={} read={recovery_elapsed:?}",
        recovered.len()
    );
    assert!(
        draft_rows < window_rows,
        "cross-window history should use fewer rows"
    );
    assert!(
        draft_rows <= 3,
        "600 chunks should split within the fold budget"
    );
    for fragment_chunks in [8, 16, 32] {
        let path = bench_path(&format!("draft-{fragment_chunks}"));
        let repo = EventRepo::open(&path).expect("draft repo");
        repo.conn
            .lock()
            .unwrap()
            .execute_batch("PRAGMA wal_autocheckpoint=0")
            .unwrap();
        let started = std::time::Instant::now();
        for (index, batch) in raw.chunks(fragment_chunks).enumerate() {
            repo.append_draft_fragment(DraftFragmentInput {
                owner: owner.clone(),
                draft_id: "bench-run".into(),
                fragment_index: index as i64,
                client_generation: 5,
                remote_session_id: Some("remote-1".into()),
                event_type: "assistant.text.delta".into(),
                identity: None,
                raw_payload: batch.to_vec(),
                first_received_at: "2026-09-25T00:00:00.000Z".into(),
            })
            .expect("draft append");
        }
        repo.commit_draft_events(
            raw.iter().cloned().map(|raw| input(&owner, raw)).collect(),
            "bench-run",
        )
        .expect("draft commit");
        let elapsed = started.elapsed();
        let wal = wal_bytes(&path);
        let db = main_db_bytes(&repo);
        println!(
            "#155 T3 {fragment_chunks} chunk fragments: wal={wal} db={db} elapsed={elapsed:?}"
        );
        drop(repo);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }
    drop(window);
    drop(draft);
    for path in [&window_path, &draft_path] {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }
}
