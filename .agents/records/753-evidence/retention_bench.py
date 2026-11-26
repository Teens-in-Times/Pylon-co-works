"""Compare count-retention SQL on copies of the same in-memory journal.

    python .agents/records/753-evidence/retention_bench.py

The progress counter reports completed intervals of 1,000 SQLite VM instructions.
Only the transaction is timed. The fixture and survivor checks run outside it.
"""

import argparse
import re
import sqlite3
import statistics
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MSG_REPO = Path("src-tauri/pylon-session/src/msg_repo")
OWNERS = {"heavy": 2500, "medium": 1500, "exact": 1000, "small": 250}
KEEP = 1000


def query(source, prefix):
    match = re.search(r'"(' + re.escape(prefix) + r'[^"]*)"', source)
    if not match:
        raise ValueError(f"SQL string missing: {prefix}")
    return match[1]


def create_fixture(schema):
    fixture = sqlite3.connect(":memory:")
    fixture.executescript(schema)
    fixture.executemany(
        """INSERT INTO canonical_events
            (owner_key, sequence, client_generation, occurred_at, received_at,
             event_type, payload_version, raw_payload, created_at)
           VALUES (?, ?, 0, '', '', 'user.message', 1, '{}', 0)""",
        ((owner, 3 * n + 1) for owner, size in OWNERS.items() for n in range(size)),
    )
    fixture.commit()
    return fixture


def sample(fixture, counts_sql, revision_sql, delete_sql, per_owner, expected):
    db = sqlite3.connect(":memory:")
    try:
        fixture.backup(db)
        intervals = 0

        def record_interval():
            nonlocal intervals
            intervals += 1
            return 0

        db.set_progress_handler(record_interval, 1000)
        started = time.perf_counter()
        db.execute("BEGIN")
        revision = db.execute(revision_sql).fetchone()[0]
        if revision != 0:
            raise ValueError(f"unexpected fixture policy revision: {revision}")
        candidates = db.execute(counts_sql, (KEEP,)).fetchall()
        if per_owner:
            for owner, excess in candidates:
                db.execute(delete_sql, (owner, excess - 1))
        else:
            db.execute(delete_sql, (KEEP,))
        db.commit()
        elapsed_ms = (time.perf_counter() - started) * 1000
        db.set_progress_handler(None, 0)
        survivors = db.execute(
            "SELECT owner_key, sequence FROM canonical_events ORDER BY owner_key, sequence"
        ).fetchall()
        if survivors != expected:
            raise AssertionError("remaining (owner, sequence) pairs differ from the fixture oracle")
        return elapsed_ms, intervals
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="6bd9549c", help="pre-refactor Git revision")
    parser.add_argument("--rounds", default=5, type=int)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be positive")
    baseline = subprocess.check_output(
        ["git", "show", f"{args.base}:{MSG_REPO.as_posix()}/mod.rs"], cwd=ROOT, encoding="utf-8"
    )
    updated = (ROOT / MSG_REPO / "retention.rs").read_text(encoding="utf-8")
    schema = re.search(r'const SCHEMA_SQL: &str = r#"(.*?)"#;', baseline, re.DOTALL)
    if not schema:
        raise ValueError("baseline SCHEMA_SQL missing")
    variants = [
        ("before", baseline, "DELETE FROM canonical_events WHERE sequence NOT IN", False),
        ("after", updated, "DELETE FROM canonical_events WHERE owner_key = ?1", True),
    ]
    fixture = create_fixture(schema[1])
    expected = sorted(
        (owner, 3 * n + 1) for owner, size in OWNERS.items() for n in range(max(0, size - KEEP), size)
    )
    print(f"SQLite {sqlite3.sqlite_version}, {sum(OWNERS.values())} rows, {len(expected)} survivors")
    try:
        for label, source, delete_prefix, per_owner in variants:
            counts_sql = query(source, "SELECT owner_key, COUNT(*) -")
            revision_sql = query(source, "SELECT COALESCE(MAX(revision), 0) FROM retention_policy")
            delete_sql = query(source, delete_prefix)
            samples = [
                sample(fixture, counts_sql, revision_sql, delete_sql, per_owner, expected)
                for _ in range(args.rounds)
            ]
            times_ms, intervals = zip(*samples)
            print(f"{label}: median {statistics.median(times_ms):.2f} ms, "
                  f"VM intervals {list(intervals)}, ms {[round(ms, 2) for ms in times_ms]}")
    finally:
        fixture.close()


if __name__ == "__main__":
    main()
