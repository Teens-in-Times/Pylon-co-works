# Dev Record — #668 evt_search 无界物化

> 入库保留。产出路径：`.agents/records/issue-668-evt-search-bounded.md`

## 元信息

- issue：[#668 evt_search 无界物化：命中整库时把全部行与载荷读进 Rust 再截断到 50](https://github.com/Teens-in-Times/Pylon-co-works/issues/668)
- 分支：`perf/evt-search-bounded`
- 日期：2026-10-29
- 施工署名：Qoder

## 根因

`EventRepo::search_hits` 的 SQL 没有 `LIMIT`，SELECT 列表还带两列完整 payload 与两次
`instr(lower(...))`。整库命中（单字符查询）时全部命中行先物化进 Rust，`sort_by` 之后才
`truncate(limit)`——排序与载荷读取都只为取前 50 行服务。前端搜索面板逐键调用，等于每次
按键都做一次整库物化。

## 修复

- SQL 改为轻量投影（5 列）+ 精确元组序
  `json_extract(owner_key,'$[i]')` + `sequence`，并 `LIMIT ?3`：排序与截断下推到 SQLite。
- Rust 侧排序/截断保留为兜底（行数 ≤ limit），不改变「owner 内 sequence 升序」的稳定序。
- `matchOffset` 改为返回行按 PK 回查（≤ limit 次等值 seek），仍是 `raw.or(typed)`。
- 新增跨 profile 超限回归测试，同时断言截断顺序与回查得到的 `matchOffset`。

## 验证

- `cargo test -p pylon-session` → 224 passed
- `cargo fmt --all --manifest-path src-tauri/Cargo.toml --check` → 通过
- `bun run check:clippy` → 通过（await-holding 基线 17 文件 / 55 处不变）
- 合成 150k 行全命中：731.3 ms → 207.3 ms（50 行），结果与 Rust 元组序逐行一致；
  勘察与读数见 `.agents/spec/668-evt-search-bounded.md`。

## 边界

未引入 FTS、未改前端、未改 `limit` 默认值；LIKE 三列与转义规则一字未动，recall 不变。
