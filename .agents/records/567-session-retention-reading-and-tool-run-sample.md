# Dev Record — #567 会话级驻留读数 + tool-run 合成样本

> 入库保留。规格文档（`.agents/spec/567-session-retention-reading.md`）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#567（#380 遗留取证——会话级驻留读数 + tool-run 真实 provider 样本）
- 分支：`kumo/567-session-retention-reading`（独立 worktree，基于 github/main `867cdcdc`；共享树 `kumo/364-agent-history` 上有 #572 在途 PR，刻意避让）
- 提交范围：`867cdcdc..<head>`
- 日期：2026-10-05

## 目标与范围

**做什么**：把 #380 收工时如实登记的两项取证缺口落成读数——①会话口径（文档 + 面板 + 有界 pending）的驻留与拍数敏感性比值，对照 ≤1.2× / ≤1.5×；②tool-run 折叠收益的 journal/unit 字节与 compact 读下行数（开工评论定的分工：先走**合成累计式语料**并如实标注，真实 provider 接入后补测）。

**不做什么**：不改 `src/application/**`、`src/domains/**` 生产代码（探针只读 import）；不动 `src-tauri/**`（共享树在途冲突域）；不给会话宿主加测量缝（生产纯度优先，闭包态用建模项并如实声明）；不接真实 provider。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/perf-bench/suites/memorySuite.ts` | 新增 `session` 节（`SessionScopeSection` + `coldLoadThroughSession`/`pendingEntryBytes`）；**勘误**：`toWorkbenchEnvelopes` 断导入换 `readWorkbenchRow`；`buildMemorySuite` 转 async | 修改 |
| `scripts/perf-bench/memory-probe.mts` | await suite；打印会话口径两行 + 口径边界注；会话判据进退出码 | 修改 |
| `scripts/perf-bench/fixtures/memoryCorpus.ts` | 元数据快照信封构造删两个工厂不认的冗余键（`provider`/`sourceId` 顶层键，tsc 严格检查报错） | 修改 |
| `scripts/perf-bench/README.md` | memory 域「别读错」第 3 条改写（会话口径已有探针读数 + 三条口径边界）；读数阈值表与实测对照表补会话行 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 前端计算核行的 memory 域表述补 #567 半句 | 修改 |

## 方案要点

1. **会话口径的根是真实会话宿主，不是复刻**。实例化 `createAgentWorkbenchSessionRuntime`（组合根工厂），注入 `listJournalPages`（生产分页冷装载缝）+ `loadDrafts`/`subscribe`/`listenTerminalFallback` 全 no-op，`bind` 后量 `runtime.getSnapshot()`。尖刺先行验证纯 bun 可构造（`IS_TAURI` 假、`canonicalEventFeed` 等按环境守卫静默）。若有人往会话宿主里再加一份常驻载荷持有（fold.log 那样），这条比值会直接显形。
2. **口径边界如实声明**（写进 README 与探针输出）：根=runtime 快照（文档+生成态）；TurnClock/draft id/sessionUi 等闭包态是纯标量或冷装载后为空，静态可达图摸不到——有界项，不是被测项；乐观 pending（echo 闭包）用**真实信封工厂**按 `echo.project` 同一构造形状建模（4 条 × 2 KiB，声明的工作量假设）。
3. **会话节排在文档用例之后构建**：`bind` 会按生产口径全局重置 timeline 收窄开关（杀停开关读 DOM 属性，bun 下恒不生效），先跑会把 legacy 档的文档侧读数冲掉。故 `PERF_MEMORY_LEGACY` 对会话节无效（两种模式下会话读数相同），README 写明。
4. **tool-run 测量在独立 worktree 按 github/main `867cdcdc` 跑**（共享树 `event_repo/**` 属 #364 在途域），测量代码不入库，配方全文如下可复现：`EventRepo::open(temp.db)` → `ingest_kernel_events` 播种 1 回合 = user → [tool_call + 20 × 累计式 `tool_call_update`（逐拍扩到 60 KiB）] × 100 → usage → done（终态建 turn.unit，方案 v2）→ 量 `load_events_compact` 全量行 JSON 字节 vs `list_events` 全表行字节（逐拍形状 = v1/无折叠的读侧下行）→ `rollup_trim` 前后 DB 文件字节。

```rust
// 关键语料形状（正文必须走 raw update.content 数组，见「证据」第 3 条）：
inputs.push(measure_input(json!({
    "sessionUpdate": "tool_call_update",
    "toolCallId": format!("call-{call}"),
    "status": if beat == BEATS { "completed" } else { "in_progress" },
    "content": [{ "type": "text", "text": "x".repeat(size) }],  // 逐拍累计
})));
// 量法：compact = repo.load_events_compact(&owner_key)；逐拍形状 = repo.list_events 翻全表；
// 行字节 = serde_json::to_vec(row).len()；journal 文件 = std::fs::metadata(db).len()。
```

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 会话驻留比 ≤1.2× | **0.236× PASS**（快照 14.1 MB + pending 模型 4×5.6 KB = 14.2 MB / Σ载荷 60.1 MB） |
| 会话拍数敏感性 ≤1.5× | **1.34× PASS**（同终值 5 拍 1.0 MB → 40 拍 1.3 MB，纯冷装载口径） |
| 文档侧读数与历史记录逐位吻合（readWorkbenchRow 勘误不改变量） | **0.235× / 1.34× / 1.15×**，与 README 既有数字一致 |
| `PERF_MEMORY_LEGACY=1` 对照档 | 跑通：2.046× / 6.81×（FAIL = 对照档的预期形态），会话节同默认档 |
| tool-run compact 下行比 | **0.156×**（折叠后 1 行 24.2 MB vs 逐拍形状 2104 行 155.2 MB，6.4× 缩减） |
| tool-run journal 字节 | append 后 156.7 MB → trim 后 24.3 MB = **0.155×**；trim 报告 processed=1 / trimmed=1 / remaining=0（L3 sha 校验通过） |
| 判据进退出码 | `bun run perf-bench:memory` 退出码含会话两判据，全过 |

## 测试处置

无新增/修改行为测试（本任务为探针读数；探针自身判据即门禁）。

## 证据

- commit：见分支 `kumo/567-session-retention-reading`（`867cdcdc..head`）
- 测试：`bun run perf-bench:memory` → 退出码 0，`memory 域判据全过（743ms）`；`PERF_MEMORY_LEGACY=1` 同；针对性 `tsc --noEmit --strict`（两探针文件）0 错误
- tool-run 测量（worktree 内 `cargo test -p pylon-session --lib tool_run_measure -- --ignored --nocapture`，基准 `867cdcdc`，test profile）：
  1. **可折形状**（正文走 raw `update.content` 数组）：compact 1 行 24 224 038 B vs 逐拍 2104 行 155 190 775 B = **0.1561×**；journal 156 676 096 → 24 346 624 B = **0.1554×**；trim processed=1/trimmed=1。
  2. **反例（同一语料改 `rawOutput` 形状）**：`tool_run_at` 的正文判据读 raw `update/content`、读不到才回退 typed `tool/contentBlocks`，`rawOutput` 形状两处都没有 → **一拍不折**，单元只把每拍事件内联一份：compact 0.4996×。即前端 memory 语料的 `rawOutput` 形状（Hermes 形状）本来就不是折叠的目标形状——折叠目标是真实累计式 provider 的 content blocks 形状（与 `turn_rollup.rs` 既有测试的 wire 形状一致）。
  3. 边界观察：整回合被一个 turn.unit 覆盖 ⇒ compact 只回 1 行；「100 次工具 × 60 KiB 终值」的病理回合会产出 ~24 MB 单行（折叠后仍是回合内全部末拍之和）。真实累计式 provider 的回合粒度远小于此；若未来真实样本逼近该量级，属 #376-b 分页语义的已知形状，不在本 issue 处置。

## 与 spec 的偏差

- spec 写「tool-run 反事实用 v1 方案」——实际用「逐拍全表行」作反事实（对本语料与 v1 读侧形状等价：v1 只折 delta run，本语料无 text delta，逐拍行即 v1 读侧所见），理由与等价性在记录中写明。
- spec 的验收 1 允许「超标如实报 FAIL」——结果 PASS，未触发。
- 新增（spec 未写）：`toWorkbenchEnvelopes` 断导入勘误（见下）。

## 未解问题

1. **真实累计式 provider 样本**（issue ②的原口径）：合成读数已落地并标注；接入任一真实累计式 provider 后按同配方补测，#567 留开作追踪口。
2. **探针不进任何类型/测试门禁**：scripts/ 不在 eslint（`lint": "eslint src/"`）、vitest、tsc 项目内——这正是 `toWorkbenchEnvelopes` 断导入存活数日的原因（见下）。要不要给 scripts/perf-bench 一条轻量门禁（如 `tsc` 单文件检查并入 check:all），留给仓库主裁决。

## 勘误（本任务途中发现的既有破坏）

`bun run perf-bench:memory` 在 main 上**本来就是红的**：memorySuite 导入的 `toWorkbenchEnvelopes` 已在会话运行时拆分重构（#520 B/I 域）中删除，scripts 不在任何类型门禁内，无人察觉。本批换用现行生产读行缝 `readWorkbenchRow`（`agentWorkbenchReplay.collectRowsInto` 逐行同款，含 turn.unit/batch 展开），修复后文档侧读数与历史记录逐位吻合，证明修复保真。

## 并行交集

- 共享树（`kumo/364-agent-history`，#572 在途）：本任务只提交过 `.agents/L.md` 两条在途声明（`47b8a6fe`、`05df4658`）；`scripts/perf-bench/**` 的共享树未提交改动已在复制到本分支后还原，共享树保持 #364 原状。
- `src-tauri/**`：零触碰（tool-run 测量在独立 worktree，测量代码不入库）。
