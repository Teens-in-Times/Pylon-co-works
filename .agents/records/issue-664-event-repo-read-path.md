# Dev Record — #664 event_repo 分页读路径 IO 放大

> 入库保留。spec 不保留（`.agents/spec/664-event-repo-read-path.md`），目标与验收在此承接。

## 元信息

- issue：[#664 refactor: event_repo 读路径 IO 放大](https://github.com/Teens-in-Times/Pylon-co-works/issues/664)
- 分支：`perf/event-repo-page-reads`（基于 `github/main` = `4497c318`，含 L.md 单行登记 `c0646dd3`）
- 日期：2026-10-29
- 施工署名：Qoder

## 问题

`pylon-session/src/event_repo/repo.rs` 两条分页 SQL 用 `(?N IS NULL OR sequence … ?N)` 把无游标/有游标揉进一条语句，SQLite 只能 `SEARCH … USING PRIMARY KEY (owner_key=?)`——每页从头扫到游标处；`load_events_compact_page` 另在每页重跑整 owner 的 turn.unit 跨度查询，而 `canonical_events` 没有任何 `(owner_key, event_type, …)` 索引。

合成库（130k 行单 owner、6.5k turn.unit）实测：

| 查询 | 改前 | 改后 |
| --- | --- | --- |
| `list_events` before=60000 | 40.1 ms | 0.09 ms |
| `list_events` before=5000 | 71.0 ms | 0.13 ms |
| compact 元数据 after=60000 | 32.4 ms | 0.68 ms |
| compact 元数据 after=120000 | 64.9 ms | 0.64 ms |
| 跨度全量 | 82.6 ms | 4.4 ms |
| 跨度 after=128000 | 79.2 ms | 0.07 ms |

## 实现

1. `list_events`：有/无游标两条 `prepare_cached` SQL（`sequence < ?2` / 无谓词），共用新增的 `collect_decoded_events` 收尾。
2. compact 元数据扫描：单条 `sequence > ?2`，游标 `unwrap_or(i64::MIN)`（sequence 恒 ≥ 1，与原无界分支等值）。
3. compact 跨度查询：`rollup_seq_end >= ?2`（同 i64::MIN 兜底）按游标剪枝；排序移到 Rust `sort_unstable()`——新覆盖索引不提供 sequence 序，SQL `ORDER BY` 会让 planner 退回主键扫表。
4. schema v17：`idx_canonical_events_rollup_spans(owner_key, event_type, rollup_seq_end, rollup_seq_start) WHERE rollup_seq_start IS NOT NULL AND rollup_seq_end IS NOT NULL`（部分覆盖索引，只收录 span 非空行）。
5. 迁移：`LAST_IN_PLACE_VERSION` → `IN_PLACE_UPGRADE_SOURCES = [15, 16]`（v15/v16 均原位；v14 及更旧仍重建）。`REQUIRED_INDEXES` 与 del01 审计基线同步；新增 v16→v17 原位升级测试与 EXPLAIN QUERY PLAN 回归测试。

## 验证

- `cargo test -p pylon-session`：225 passed / 0 failed（含新增 `v16_upgrade_adds_rollup_span_index_without_losing_canonical_history`、`paging_queries_use_primary_key_range_seek_and_span_index`；原有分页/折叠等价测试未改）。
- `cargo fmt --all --check`：通过。
- `bun run check:clippy`：无新增诊断（各 crate `added: []`），`check-await-holding` 17 文件 / 55 处一致。
- `EXPLAIN QUERY PLAN`：游标分支 `sequence<?` / `sequence>?` 主键范围；跨度查询 `COVERING INDEX idx_canonical_events_rollup_spans`。

## 风险与遗留

- v17 只 `CREATE INDEX IF NOT EXISTS`，不动行；升级时一次性建索引（6.5k 跨度行量级 < 100 ms）。
- 同文件 `search_hits` 仍是跨 owner 全表 LIKE、无 SQL LIMIT（结果集在 Rust 侧排序截断），属独立议题，未纳入本卡。
