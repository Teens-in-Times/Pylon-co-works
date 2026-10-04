# Dev Record — #535 游标层聚合 gap todo 退役（恢复为真实断言）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/535-cursor-aggregate-gap-todo-retirement.md`

## 元信息

- issue：#535（bug(replay): 游标层聚合 gap——聚合形态与逐 chunk 形态推进不一致）
- 分支：`kumo/prometheus`（基于 `b089c026` = `github/main`）
- 提交范围：`b089c026..HEAD`
- 日期：2026-10-04

## 目标与范围

`src/__tests__/replay/crossLayerComposition.test.ts` 的 `it.todo`（「聚合形态应与逐 chunk 形态推进到同一位置（现状抛 gap）」）按 issue 验收二选一：恢复为真实断言并转绿，或裁决 gap 为预期行为。

**不做什么**：不动游标/批处理生产代码（`canonicalEventCursor.ts`、`canonicalEventBatch.ts` 均零改动）；不碰他人在途域（`canonicalEventFeed.ts`、`vitest.setup.ts`，见「并行交集」）。

## 根因定位（验收项 1）

**gap 是真实的，但已被修复，`it.todo` 是修复落地后未退役的过时占位。**

- todo 随测试文件于 2026-09-18（46a971f1）入库。当时游标连续性判据是「下一号 == 该行 sequence」；聚合行按 ADR-0016 前的形态下，batch 行只携带跨度末位 sequence（如 seqSpan [2,4] 的行 sequence=4），跟在游标 1 后被判 `canonical_gap_unrecoverable`——游标层的逐行连续性假设与聚合层的**跨度占用**语义不一致。这是推进语义差异，不是真实丢数据：跨度中间编号本就由该行承载。
- 2026-09-20，72b92499 落地 **ADR-0016 方案 D**（`.agents/decisions/0016-span-occupancy-in-committed-sequence.md`，#155 T3-1/#208 ③）：`canonicalEventCursor` 的判据放宽为「`*.delta.batch` 行的 `seqSpan` 覆盖游标下一号」即可推进（`spanStartOf`/`coversNext`），严格单行判据对非 batch 行保留，`turn.unit` 覆盖仍不得当占用。**这恰好修复了 todo 指认的缺口，但占位没被同步退役**，遂由 #520 残留复查（`.agents/records/520-retirement-residue-sweep.md`）侦察发现并登记为 #535。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/__tests__/replay/crossLayerComposition.test.ts` | 文件头「已知的分歧」段改写为「分歧已由 ADR-0016 收口」；`it.todo` 恢复为真实断言用例 | 修改 |

## 方案要点

恢复的用例（「游标层：聚合形态与逐 chunk 形态推进到同一位置（无 gap）」）：

1. 前置断言聚合真实发生（merged 行集中存在 `.batch` 行），防等价断言空转；
2. 两种形态各自独立过一套 `CanonicalEventCursor`，逐行 `accept`；
3. 断言三件事：聚合路径 `applied` 逐行等于 merged 行序列（每行恰消费一次，applied 记跨度末位 sequence）；聚合路径终位 == 逐 chunk 路径终位；终位 == 原始 wire 数（5）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 定位 gap 根因 | ✅ 跨度占用语义 vs 逐行连续性判据的推进语义差异；已由 ADR-0016（72b92499）修复 |
| `it.todo` 恢复为真实断言并转绿 | ✅ 4 用例全绿（含恢复的用例） |

## 测试处置

- `crossLayerComposition.test.ts`：`it.todo` → 真实断言用例（本 issue 主体）；文件头过时表述同步改写。无删除、无既有断言改动。

## 证据

- 测试：
  - `npx vitest run src/__tests__/replay/crossLayerComposition.test.ts` → **4 passed**（exit 0）
  - `npx vitest run src/__tests__/replay/canonicalEventCursor.test.ts` → **4 passed**
  - `npx vitest run src/__tests__/replay/{rowSemantics,granularityIndependence,inFlightBaseline}.test.ts` → **17 passed**
  - 复现探针（修复前跑）：聚合形态（seq 1 → batch[2,4] → seq 5）过游标 `applied=[1,4,5]`、cursor=5，**无 gap**——证实 todo 指认的缺口已被 ADR-0016 修复
- clippy：本次纯前端测试文件改动，未触碰 Rust crate，clippy 门禁不受影响
- 全 replay 目录跑（27 文件 492 用例）：490 passed / 2 failed——2 个红灯全在 `canonicalEventFeed.test.ts`，归属他人在途改动（见下），与本 issue 文件零交集

## 与 spec 的偏差

未落 spec 文档：改动为单测试文件的占位退役，根因与方案在记录与本文件头注释中自洽承载。

## 未解问题

无。

## 并行交集

- **[L3 在途批（L.md 2026-10-04）]**：会话中途工作树出现 `canonicalEventFeed.ts` 修改（守卫 `typeof window` → `IS_TAURI`，#542）与其新测试文件。该在途改动使 `canonicalEventFeed.test.ts` 2 用例在 `jsdom-mock` 项目下红灯（listener 不再注册）——属该批的语义变更收口范围，本 issue 不处置。本次按 §2.1 未 stage/未 commit 对方文件，提交一律 pathspec。
- 共享树上先存的 `src-tauri/Cargo.toml` 幻影改动（内容 diff 为空）：未触碰。
