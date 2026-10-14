# Dev Record — #613 agentWorkbenchSession.terminalDelivery 全量时序偶发红

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/613-terminal-delivery-wallclock-flake.md`
> 规格：`.agents/spec/613-terminal-delivery-wallclock-flake.md`（一次性，未入库）

## 元信息

- issue：[#613](https://github.com/Teens-in-Times/Pylon-co-works/issues/613)
- 分支：`kumo/prometheus`
- 提交范围：`7fbdeaa6`（开工基点，= `github/main`）→ 本批两提交：`4da83ef8`（L.md 开工声明）、本记录与其配套的测试修复提交
- 日期：2026-10-12

## 目标与范围

用户原话：

> fix issue 613

即消除 `src/application/agent-workbench/__tests__/agentWorkbenchSession.terminalDelivery.test.ts:82` 的偶发红（`AssertionError: expected 0 to be greater than 0`）。

**不做什么**：不改产品代码（`elapsedMs` 算法与时钟源都不动——缺陷在测试的判定方式）；不动 `emptyStateFirstPrompt.test.ts`（同类断言但已有承重睡）；不动 #613 正文「同族观察」里的 `AgentSheetView.rendererMode.solid.test.tsx`（机制不同、不可复现，已另立 #619）；不引入 mock `Date.now` 的改法。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/application/agent-workbench/__tests__/agentWorkbenchSession.terminalDelivery.test.ts` | 第一条用例：终帧投递前补承重睡 + 说明注释（只加等待，不改断言） | 修改 |
| `.agents/L.md` | 开工声明（单独提交） | 修改 |

净改动 11 行，其中 10 行注释、1 行 `await`。

## 方案要点

1. **先证伪「慢跑翻车」这个原始假设**。issue 里写「第 3 跑总耗时明显偏长（183s）——与『时序断言在慢跑下翻车』假设相符」。实测方向**相反**：`elapsedMs = Math.max(0, 终帧 Date.now() − 发送入口 Date.now())`（`agentWorkbenchTurnClock.ts:213`），两端都是 1ms 分辨率的 `Date.now()`（写入点 `agentWorkbenchOptimisticEcho.ts:87–88` 与 `agentWorkbenchTurnLifecycle.ts:52`）。**越慢越大，越快才越可能为 0**。慢的总耗时是争用的症状，不是成因。

2. **冷热两态解释了「只有全量跑才红」**。本文件属 `node-shared` 分组，而 `vitest.config.ts` 给该组 `isolate: false`——同组文件共享 worker 的 JIT 与模块注册表。于是同一段序列：

   | 状态 | 实测 `elapsedMs` | 断言 |
   | --- | --- | --- |
   | 冷（隔离进程单跑，该文件第一个用例） | 25 跑取值 `4`/`5`/`6`，无一为 0 | 过 |
   | 热（同进程重复 300 次） | **287/300 恰为 0**，max=3 | 红 |

   即失败概率取决于「该文件跑之前，同组其他文件是否已把这段代码预热」。这一条同时解释了 issue 里四个观察：隔离全绿、全量偶发红、频率偏高、复跑又绿。

3. **做的第一件事是把失败复现出来，而不是解释它**。构造「预热 60 轮 → 跑真实序列」的对照探针，两者只差承重睡：

   | 探针 | 结果 |
   | --- | --- |
   | A 热态 + 无承重睡 | `AssertionError: expected 0 to be greater than 0`（**精确复现 #613**） |
   | B 热态 + 承重睡 5ms | 通过 |

4. **分布级证据**（热态各 50 轮）：无睡 **45/50 为 0**；有睡 **0/50 为 0**（min 4 / max 8）。观察到一个样本为 4ms——`setTimeout(5)` 可略早于 5ms 触发，故这睡保证的是「>0」而非「≥5」；断言只需要前者，余量充足（min 4 ≫ 1）。

5. **修法跟仓内既有约定，而非新发明**。同类断言全仓共 2 处，另一处 `agentWorkbenchSession.emptyStateFirstPrompt.test.ts:99` **已带承重睡**，且注释把机制写全了（含「不能降级成纯微任务冲刷」）。也就是说这个坑作者知道、在隔壁文件修了、漏了本文件。本次补同一形状并把实测数字写进注释，保持一致。

6. **为何不用 mock `Date.now`**：可行，但该断言族已有成文约定；且 `Date.now` 同时被投影的其它回退路径消费，局部 mock 的副作用面大于收益。**为何不降级成 `toBeGreaterThanOrEqual(0)`**：会丢掉「摘要确实带上了一个真实 live 时长」的判别力，且违背隔壁文件已确立的意图。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 热态断言级红/绿对照（修复前红、修复后绿） | 通过（见「方案要点」3） |
| `bunx vitest run --project node-shared <该文件>` | 通过 |
| 该文件隔离复跑 ≥20 次 | 通过：**25 跑 0 失败** |
| 全量 `bunx vitest run`（#613 的规定判据本就是全量） | 通过：**684 文件通过 / 1 skipped，5367 用例通过 / 1 skipped，exit 0，158s**，日志零 FAIL |
| `bun run lint` | 通过（exit 0） |
| `bunx tsc -b` | 通过（exit 0） |
| `bun run check:frontend:static` | 通过（exit 0，54s） |
| `bun run check:solid` | 通过（exit 0，33s） |
| `bun run check:clippy` | 通过（exit 0，29s）：7 个 crate 全 `"added": []`，`check-await-holding` 通过 |

## 测试处置

- 新增：无。
- 修改：`terminalDelivery.test.ts` 第一条用例——**只加等待与注释，断言与断言对象均未改，被测行为未改**。
- 删除：无。
- 诊断期临时文件（`tmpElapsedProbe` / `tmpRealProbe` / `tmpRedGreen` / `tmpDist`）均已删除，工作树只剩上面一个改动文件。

## 证据

- commit：`4da83ef8`（L.md 声明）、本记录与其配套的测试修复提交
- 机制定位：`agentWorkbenchTurnClock.ts:213`（`Math.max(0, at - clock.generationStart)`）、`agentWorkbenchOptimisticEcho.ts:87–88`（起点 `Date.now()`）、`agentWorkbenchTurnLifecycle.ts:52`（终点 `Date.now()`）
- 冷态实测（真实用例副本插桩，25 跑）：`elapsedMs` 分布 `4:12 次 / 5:9 次 / 6:4 次`
- 热态实测（同进程 300 次）：`{"n":300,"zero":287,"max":3}`
- 分布对照（热态各 50 轮）：无睡 `zeros 45/50, max 1`；有睡 `zeros 0/50, min 4, max 8`
- 断言级红/绿：A（无睡）→ `AssertionError: expected 0 to be greater than 0`；B（有睡）→ 通过
- 门禁输出：全量 vitest `Test Files 684 passed | 1 skipped (685)`、`Tests 5367 passed | 1 skipped (5368)`、exit 0

## 与 spec 的偏差

无。spec 的范围、方案、验收标准均按原样执行；未出现预期外的改动面。

## 未解问题

1. **#613 正文「同族观察」的 `AgentSheetView.rendererMode.solid.test.tsx` 已另行登记为 [#619](https://github.com/Teens-in-Times/Pylon-co-works/issues/619)**，不在本批范围。实测其机制与 #613 **不同**：是异步查询预算问题，不是墙钟下界——同用例第 173 行挂载查询显式给了 `timeout: 5_000`，而第 178/186 行恢复正文的 `findByText` 落在 testing-library 默认 1000ms（已核查无全局 `asyncUtilTimeout`）。预算口径属该域决定，登记方不代为裁决。之所以单开而非留在 #613 评论区：#613 即将关闭，留在里面等于埋没。
2. **`durationSource: 'live-monotonic'` 名实不符**：实现用的是 `Date.now()`（非单调、1ms 粒度），字段名却叫 monotonic。改用 `performance.now()` 会影响 `elapsedMs` 的整数契约，属产品决策，本次不动，仅登记。
3. **根本的脆弱性未消除，只被绕过**：该断言仍依赖真实墙钟。若将来把这段序列进一步提速（或 `setTimeout` 被某处替换/伪造），承重睡这一层仍会失效。彻底的解法是给 TurnClock 注入可控时钟（`AgentWorkbenchTurnClockDeps` 已是一个天然注入缝），但那会牵动多条测试与产品接线，属独立议题——本次按仓内既有约定选择最小改动。

## 并行交集

- `src/application/agent-workbench/__tests__/agentWorkbenchSession.terminalDelivery.test.ts`（唯一代码改动，且只碰第一条用例）
- `.agents/L.md`（已按「只留在途」约定在合入后撤下本条目）
- 诊断期在同目录临时创建过 4 个 `tmp*.test.ts` 探针，均已删除；期间**未触碰**任何产品源码与其它测试文件
