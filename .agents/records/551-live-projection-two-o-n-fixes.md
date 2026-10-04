# Dev Record — #551 live 归约两处 O(N) 收口

> 入库保留。issue：**#551**；规格（不入库）：`.agents/spec/551-live-projection-linearization.md`。

## 元信息

- 日期：2026-10-05
- 分支：`kumo/prometheus`（共享线）
- 起点：`dc9137f0`（L.md 施工声明）
- 定位手法：`bun --cpu-prof` + **调用树子树筛选**（不筛则夹具冷折叠占 48.5% 采样，live 热点被稀释）

## 目标与范围

清偿 `reduceWorkbenchEvent`（live 单事件折叠）在已折大文档上的两处与文档规模成正比的路径：

1. `terminalSessionSequence` 无 `index` 时全表扫 `document.timeline`
2. `insertBySequence` 中间插入路径三次分配

**不做**：`appliedEventIds` 的 Θ(N) 幂等判据（#440 已记录的遗留，见「未解问题」）、
timeline 收窄（M2 待裁决）、`WorkbenchDocument` 形状变更。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/workbenchProjectorReducer.ts` | 新增模块级 `terminalSequenceByTimeline: WeakMap<readonly WorkbenchTimelineEntry[], number>`（:1265）；`terminalSessionSequence` 读取侧查记忆（:1273-1290）；`reduceWorkbenchEvent` 插入点增量写入（:205-215）；`insertBySequence` 中间插入改 `slice()`+`splice()`（:1252-1257） | 修改 22+/2− |

无新增文件、无新增依赖、无行为契约变更。

## 方案要点

1. **记忆化的键取 timeline 数组引用，不取 document。** 回看全文件，`timeline` 只在两处被替换
   （`:205` 单事件插入、`:299` 批量插入），其余所有 `{...document}` 都保持同一引用；而 document
   本身会在 `reduceSemanticEvent` / `refreshOrphans` 里被重建多次 —— 用它做键会全程未命中。
2. **只加读取侧缓存 = 零收益，必须配套增量写入。** 单事件路径每帧都造新 timeline 数组，
   只缓存的话每个新数组首读仍要全表扫一次（就是每帧一次）。故在 `:205` 插入点用
   「旧值（O(1) 命中）+ 本条是否终态」直接算出新数组的值并写入，下一次读取恒为 O(1)。
3. **不改 `WorkbenchDocument` 形状。** 加派生字段需在十余处 `{...document}` 维护，漏一处即静默
   退化为全表扫描，且属对外 readonly 契约变更。
4. **不采纳 timeline 就地写**：单事件入口的 `document.timeline` 恒为冻结数组，要就地写就得先夺
   所有权 = 复制，收益归零且破坏 readonly 契约。
5. **`insertBySequence` 追加快路径本已存在**（`[...items, item]`），live 连拍走的正是它 ——
   故本次改动只作用于中间插入路径，且实测显示该路径不是 live 的主成本（见下）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 既有行为测试 | `vitest run src/domains/workbench/` → **48 文件 / 482 用例全绿**，既有断言零修改 |
| 类型检查 | `tsc --noEmit` → exit 0 |
| lint | `eslint src/domains/workbench/` → exit 0 |
| `bun run check:clippy` | 未改 Rust 文件，不适用（本批纯前端 TS） |
| perf-bench | 见下表 |

**读数对照**（同一台机、同一命令、同批次前后对照）：

| pair（case） | 改动前 | 改动后 | 倍数 |
| --- | --- | --- | --- |
| `reduceWorkbenchEvent(live) · live-s`（501 blocks） | 414.81 µs/事件 | **243.48 µs/事件** | 1.70× |
| `reduceWorkbenchEvent(live) · live-m`（5001 blocks） | 5812.84 µs/事件 | **1392.83 µs/事件** | **4.17×** |
| `reduceWorkbenchEvent(live) · live-m` 中位总时长 | 378.00 ms | **90.53 ms** | 4.18× |
| `projectWorkbench(fold) · mixed-m`（对照组，未改） | 21.85 µs/事件 | 19.87 µs/事件 | 负载噪声 |

**独立复采**（自建脚本：5001 blocks × 200 轮 = 65 帧/轮，同一脚本同参数）：

| | 改动前 | 改动后 |
| --- | --- | --- |
| 200 轮总时长 | 28294 ms | **8417 ms**（3.36×） |

**热点转移**（`bun --cpu-prof` 按 `reduceWorkbenchEvent` 子树筛出的 self time）：

| 改动前 | 份额 | 改动后 | 份额 |
| --- | --: | --- | --: |
| `terminalSessionSequence` | **72.17%** | —（跌出榜） | — |
| `insertBySequence` | 14.64% | `insertBySequence` | 47.77% |
| `includes`（appliedEventIds） | 4.26% | `includes` | 16.56% |
| — | — | `arrayIteratorNextHelper` | 10.75% |
| — | — | `isTerminalSessionEntry` | 5.45% |

子树总采样从 18254（占进程 40.8%）降到 4698（17.7%）——**绝对量降 3.9×**。
改动后 `insertBySequence` 的绝对成本基本持平（0.4777×8417 ≈ 4020 ms vs 0.1464×28294 ≈ 4142 ms）：
占比上升纯因分母变小，这也印证了它**是不可避免的 O(N) 数组复制**（见「未解问题」）。

## 与 spec 的偏差

1. spec 里 `insertBySequence` 曾考虑 `toSpliced` —— 实测 tsconfig `target: ES2022`，
   `toSpliced` 属 ES2023，**不可用**，改用 `slice()`+`splice()`。
2. spec 的「C. appliedEventIds」评估结论：**不并入本批**（理由见未解问题），改为留档。

## 未解问题

1. **`appliedEventIds` 的 Θ(N)（#440 遗留）现在成了 live 路径的首要剩余项**（`includes` 16.56%
   + 其 spread 复制计入 `arrayIteratorNextHelper` 的一部分）。简单记忆化**无效**：每帧
   `[...document.appliedEventIds, id]` 都产新数组，新数组首建 Set 仍是 O(N) 且比建数组更慢。
   真正解法是数据结构级（Set 化写进 document，或复用 #205 的区间机制）——涉及 `WorkbenchDocument`
   形状/契约，**超出本 issue 范围，建议另开**。
2. **`insertBySequence` 的 O(N) 数组复制**：wt 不可消除 —— 不可变 document 语义下每帧必须产出
   新 timeline。要根治需持久化数据结构（如 RRB-tree），量级与风险都远超本批。
3. `isTerminalSessionEntry`（5.45%）在增量写入处每帧调用一次，其中 `data.status.toLowerCase()`
   有字符串分配；与扫描路径相比已不是瓶颈，未优化。

## 证据

- 提交：`kumo/prometheus` 上的本批次提交（见 git log）
- 测试：`./node_modules/.bin/vitest run src/domains/workbench/` → `Test Files 48 passed (48)` / `Tests 482 passed (482)`
- 基准：`bun run perf-bench` → `projector` 域读数见上表；`bun run perf-bench:memory` 未跑（本批不涉内存面）
