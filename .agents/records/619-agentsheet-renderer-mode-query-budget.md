# Dev Record — #619 AgentSheetView.rendererMode 空态恢复用例的消息查询预算

## 元信息

- issue：#619 `bug(test): AgentSheetView.rendererMode 空态恢复用例的消息查询只用默认 1s 预算（同用例挂载查询给 5s），争用下偶发红`
- 署名：Qoder
- 分支：`kumo/prometheus`
- 提交范围：`e74e5359..9a34e8fa`（`5b22a35a` 为 `L.md` 在途声明；本记录随记录提交追加）
- 日期：2026-10-28

## 目标与范围

**目标**：消除该用例在并行全量下的偶发红，且不以单纯放大预算为唯一手段。

用户裁决原话：「这地方能避免时序问题嘛，有没有更巧妙的解法」；选定方案：**预热 + 对齐预算**。

**不做**：不改 `vitest.setup.ts` / `vitest.config.ts`（不引入全局 `asyncUtilTimeout`）；不动任何产品代码；
不减该用例的挂载次数或断言集；不清扫同文件其余 33 处 `{ timeout: 5_000 }`。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/sheets/__tests__/AgentSheetView.rendererMode.solid.test.tsx` | 顶部 import、`beforeAll` 钩子、`从空态选择浏览器 mock 会话…` 用例的两处 `findByText` | 修改 |

产品代码零改动。

## 方案要点

### 判读纠正：问题不在恢复链路，在断言窗口内的一次性冷加载

隔离跑插桩实测（Windows 本机，`-t` 单用例）：

| 观测点 | 耗时 |
| --- | --- |
| `render()` 首次挂载 | 47ms |
| 首个 `findByLabelText` 等到挂载完成（5s 预算） | **3825ms** |
| 第 2 次挂载后取正文（原 1s 默认预算） | 292ms |
| 第 4 次挂载后取正文（原 1s 默认预算） | 102ms |

3.8s 落在 `factory.prepare` 的懒加载上：`src/renderers/solid-workbench/builtinSolidRendererSuite.ts`
的 `await loadSolidWorkbench()`（动态 import 整个工作台模块图）冷载 **3030ms**；
`whenStreamingComputeReady()` 由 `scripts/wasmPreload.ts` 预初始化，实测 0ms。同文件第二例挂载同一组件只需
43ms（已热）。

因此 issue 正文的 **(b) 假设不成立**——「1s 已是合理上界、恢复链路在争用下超出」并不成立：恢复链路本身
100–300ms，预算是被一次性模块 transform 挤爆的。

### 做法

1. `beforeAll` 中、`activateBuiltinPlugin` 之前 `await loadSolidWorkbench()` 预热。冷载成本移入钩子
   （`hookTimeout` 10s 兜底），不再落在断言语义窗口内。
2. 两处 `findByText` 补 `{ timeout: 5_000 }`，与该用例挂载查询及同文件既有约定一致。

不抽文件级常量/helper：同文件 35 处均为内联字面量，为两处单独立名会引入第二种写法。

预热前后同文件对照（同机、连续两次运行）：

| | 首例耗时 | `tests` 项时长 |
| --- | --- | --- |
| 预热前 | 3824ms | 10.25s |
| 预热后 | **456ms**（复跑 570ms） | 8.13s |

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 该文件 36 用例全绿 | 通过：`Tests 36 passed (36)` |
| 首例 < 1500ms | 通过：456ms（预热前 3824ms） |
| 四段断言一条不减 | 通过：diff 仅触及两处 timeout 实参与一条预热语句，断言集未动 |
| 产品代码零改动 | 通过：`git diff` 命中文件仅该测试文件 |
| ESLint 无新增告警 | 通过：`bunx eslint <该文件>` 无输出（退出 0） |

## 测试处置

- 新增测试：无。
- 修改/删除既有行为测试：无（只改等待预算与 `beforeAll` 预热钩子，断言与挂载结构不变）。

## 证据

- commit：`9a34e8fa`（代码）、`5b22a35a`（`L.md` 在途声明）
- 目标文件：`bunx vitest run src/sheets/__tests__/AgentSheetView.rendererMode.solid.test.tsx`
  → `Tests 36 passed (36)`；verbose 逐例：首例 456ms，其余 14–531ms。
- 同域回归：`bunx vitest run src/renderers/solid-workbench`
  → `Test Files 89 passed | 1 skipped (90)`，`Tests 948 passed | 1 skipped (949)`。
- 类型与边界：`bun run check:solid` → 退出 0（`tsc -p tsconfig.solid.json` + 15 项边界脚本；
  运行时边界 33 条遗留白名单仅报告、无新增，CSS 死注入/悬空引用均为 0，177 主题字段一致性通过）。
- clippy：**未跑**——本次零 Rust 改动，`cargo clippy` 输入面与基线完全一致，新增诊断数为 0 由构造保证。
  如需机械证据，可在合并前补一条 `bun run check:clippy`。
- 未跑 `bun run check:frontend` 全链与全量 `bun run test`：改动面为单个测试文件，已用目标文件 + 同域
  948 例回归覆盖；全量链留给 PR CI。

## 与 spec 的偏差

- spec 的「门禁」列出 `check:frontend`、全量测试为「时间允许则跑」；实际未跑，理由同上，已在证据节注明。
- spec 未决问题之一（同族文件同样付冷载成本）未处理，维持「另立 issue」口径。

## 未解问题

- 同族隐患：其它 `.solid.test.tsx` 在各自 worker 的首例同样付一次 `loadSolidWorkbench()` 冷载（每文件一次）。
  本条只收口 #619 点名的用例；文件级/worker 级预热属基础设施决策，未登记 issue（待用户决定是否登记）。
- 极端争用下 5s 仍有理论余量不足的可能；预热后挂载回到 ~50ms 量级，风险面已显著收窄。
- 未取得原报告中的「全量并行下偶发红」复现；本次结论建立在机制实测（冷载 3.8s + 预算 1s）而非复现之上。

## 并行交集

- `src/sheets/__tests__/AgentSheetView.rendererMode.solid.test.tsx`（独占，无他人声明）
- `.agents/L.md`（按规范只追加一行；该文件是已知合并冲突点，已单独提交）
