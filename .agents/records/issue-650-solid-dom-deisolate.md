# Dev Record — #650 solid-dom 去隔离（isolate: false）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-650-solid-dom-deisolate.md`

## 元信息

- issue：[#650 refactor(test): solid-dom 去隔离（isolate: false）——补跨文件环境收尾，隔离档 110s→34s](https://github.com/Teens-in-Times/Pylon-co-works/issues/650)
- 分支：`feat/solid-dom-deisolate`（基于 `github/main` = `f974ac5f`）
- 提交范围：`fd2021eb`（L.md 单行登记）→ 本提交（`vitest.config.ts` / `vitest.setup.ts` / 本 record）
- 日期：2026-10-28
- 施工署名：Qoder（L.md 已登记）
- 关联：#612（滚动几何夹具已关闭）、#619（查询预算，PR #649 独立分支，未触及用例面）

## 目标与范围

solid-dom 是五个 vitest project 里最大的一档（180 文件 / 1213 用例）。原先它和
`jsdom-mock` / `jsdom-shared` 一样逐文件销毁 jsdom 环境，代价是每文件重建一次环境；
改为与 `node-shared` 同构的「worker 复用 + 显式收尾」后，单文件环境成本从
1.00–1.05s 摊薄到整轮 1.05s。

**做**：`vitest.setup.ts` 补齐去隔离所需的逐文件收尾层；`vitest.config.ts` 把
solid-dom 从隔离档移出。**不做**：其余四个 project 的隔离策略、任何用例文件改写
（避让 #613/#619 的用例面）、任何 `testTimeout` / waitFor 预算调整。

## 现状问题（切换前的实测）

| 形态 | 墙钟 | environment 聚合 |
| --- | --- | --- |
| `--project solid-dom`（隔离，基线 `f974ac5f`） | 110.7s | ≈ 180 × 1.0s |
| 同一档位今日复测（`--isolate` 强制，含本次 setup 改动） | 112.14s | 442.19s |
| 裸切 `--no-isolate` 并行 | 30.3–33.6s | 440–470s（分摊到 9 worker） |
| 裸切 `--no-isolate --no-file-parallelism` | 80.4s | 1.05s（只建一次） |

裸切当场红 15 文件 / 53 用例。按「15 文件 → 1 文件 → 全绿」逐个剥，归到四类跨文件泄漏。

## 根因

`isolate: false` 下 vitest 在文件边界**什么都不复位**——runner 里那段
`if (config.isolate) { moduleRunner.mocker?.reset(); resetModules(evaluatedModules, true) }`
（vitest 4.1.11 `dist/chunks/base.B6Opl8PE.js`）整段被跳过。隔离环境原本靠「销毁
jsdom」隐式兑现的所有保证，现在必须由 setup 自己按文件补回来。

### 1. Tauri 运行时全局残留 → `IS_TAURI` 误判

`src/demo/mockTauri.ts:651-654` 往 window 上装 `__TAURI_INTERNALS__` 后从不撤销；
`src/infrastructure/tauri/env.ts:11` 的 `IS_TAURI` 是**模块求值时**的 const。后继文件
（本身没有 Tauri）复用了带 `__TAURI_INTERNALS__` 的 window，被判定成 Tauri 宿主，
走进真实 `invoke` 路径——这是 #228 白名单外 `console.error` 的整片来源。
`vi.unstubAllGlobals()` 不管直接赋值，必须显式删。

### 2. 原型 descriptor 残留

`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx:369`
用 `Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value })`
定义（`writable` 缺省 false）。后继
`src/renderers/solid-workbench/chat/__tests__/issue243.virtualization.solid.test.tsx:37`
再赋值时在严格模式下抛
`TypeError: Cannot assign to read only property 'scrollIntoView' of object '[object HTMLElement]'`。
`vi.restoreAllMocks` / `vi.unstubAllGlobals` 都不还原直接 defineProperty 的 descriptor。

### 3. 孤儿定时器 / rAF 与归属漂移

环境不销毁，上一文件的 rAF 循环与延时回调继续跑：既烧 CPU（把 `waitFor` 的预算挤爆），
又把自己的 `console.error` 与未处理 rejection 记到「当次在跑的文件」头上
（#542 记录过这种背锅漂移）。

### 4. 在飞模块 import 越过 teardown（真正的硬骨头）

先只补 1–3 后，串行全绿，并行仍有约 2/3 的轮次红，且失败点漂移：
`SessionsPanel`、`GatewayRiskPanel`、`sheetTabStripAgentSwitch`、
`BrowserSheetView.zoom` / `.snapshotSingleFlight`、`OverviewSheetView.resumeError`、
`Settings.a11y`——**全部是 mock `@tauri-apps/api/core` 的文件**。

失败形态有两层：直接层是 `TypeError: Cannot read properties of undefined (reading 'invoke')`
落在真实的 `@tauri-apps/api/core` 的 `core.js` 上（mock 已注册却不生效）；
连带层是产品走进真实错误路径，打出用例不该出现的 `console.error`
（如 `OverviewSheetView.resumeError` 的 `读取最近会话失败`），进而被 #228 白名单硬断言
拦下——这条 file 级失败是症状，不是归属失真。

机制：文件收尾时我只 `await` 了一个 0ms 宏任务就 `vi.resetModules()`。在飞的动态
import 链（多层嵌套、wasm 初始化）需要不止一个宏任务；它们在我方复位**之后**落地，
把自己的旧图重新写回 `evaluatedModules`（`evaluated = true` 且带着「真实
`@tauri-apps/api/core`」的绑定）。下一个文件 import 那个中间模块时拿到的是缓存
exports，它的 mock 只对新求值的图生效——于是 mock 被绕过。

证据：最小两文件对（真 import → mock 文件，同步/异步两种 factory）全绿，符合
「需要特定前驱的在飞链」而不是「任何真 import 都会污染」；
`mountSolidWorkbench`（真 import core，3435 行，排在前）＋受害文件串行也全绿。

## 方案

### `vitest.setup.ts`：逐文件收尾层（全部集中在 afterAll，幂等、可重复装载）

| 层 | 作用 | 对应根因 |
| --- | --- | --- |
| 定时器账本（`Symbol.for('pylon.vitest.timerLedger')`） | 包装真实 `setTimeout/setInterval/requestAnimationFrame`，按文件记账，afterAll 统一撤销 | 3 |
| `resetSharedBrowserGlobals()` | 删除 `__TAURI_INTERNALS__` / `__TAURI__` / `__TAURI_EVENT_PLUGIN_INTERNALS__` / `__PYLON_BROWSER_MOCK__`，清内存 localStorage，清 body | 1 |
| DOM 基线快照（`Symbol.for('pylon.vitest.domBaseline')`） | worker 首次装载时给 7 个原型（Node/Element/HTMLElement/HTMLMediaElement/HTMLImageElement/Range/Document）+ window 21 个垫片成员 + document 4 个成员拍 descriptor 基线，afterAll 回放：基线里没有的删掉、变过的还原 | 2 |
| `await vi.dynamicImportSettled()` → `vi.resetModules()` | 递归等在飞 import 全部落地再清图（替代原来的单个 0ms 宏任务） | 4 |

基线只拍一次（同 worker 内原型与 window 实例不变），用 well-known symbol 存在
`globalThis` 上，避免 setup 模块逐文件重估时把「已被污染的状态」当成基线。

### `vitest.config.ts`

```ts
isolate: name === 'node' || name === 'jsdom-mock' || name === 'jsdom-shared',
```

`node` / `node-shared` 划分沿用原注释的理由（node 档有刻意替换模块 mock 的
source-contract 测试）；`jsdom-mock` / `jsdom-shared` 不动——它们的用例直接替换
模块 mock，暂不承担同类改造成本。

## 验证

### solid-dom（本次改动的主战场）

| 轮次 | 形态 | 结果 |
| --- | --- | --- |
| 1–5 | `--project solid-dom --no-isolate`（并行） | 179 passed / 1 skipped，1212 passed / 1 skipped 用例，**5/5 绿** |
| 6–7 | `--project solid-dom --no-isolate --no-file-parallelism`（串行） | 同上，**2/2 绿** |
| 基线 | `--project solid-dom --isolate`（强制隔离，同 setup） | 179 passed / 1 skipped，112.14s |

耗时：112.14s → 33.97s / 35.85s（并行），约 3.3×；串行 78.69s（environment 聚合 1.05s）。

### 其余门禁

- 全量 `bunx vitest run`：**690 passed / 1 skipped**，exit 0（setup 文件改动对
  node / node-shared / jsdom-mock / jsdom-shared 无回归）。
- `bun run check:solid`：exit 0。
- `bun run lint`：exit 0。
- `bun run check:clippy`：**不适用**——本次无 Rust 改动（与 #619 同一判据）。

### 回归时的定位手法（留给后继）

去隔离下的失败很少在「本文件自己的逻辑」上，先看三处：文件级 `[ path ]` 失败是
setup 的收尾断言（console.error 白名单 / unhandledRejection），根因通常在上一个文件；
`Cannot assign to read only property` 是 descriptor 泄漏，往基线列表里补原型；
「mock 注册了却拿到真实实现」先怀疑在飞 import 越过 teardown，确认
`dynamicImportSettled` 是否仍在该文件的 afterAll 之前完成。

## 风险与回滚

- **回滚**：`isolate` 表达式恢复为 `name !== 'node-shared'` 即回到原状；setup 的收尾层
  在隔离档下是幂等 no-op（环境本就会销毁），不需要回滚。
- **新增泄漏面**：基线只覆盖实测存在的直接改写面（7 个原型 + window/document 成员）。
  用例若改写别的原型成员，需要把该原型加进 `BASELINE_PROTOTYPES`；白名单机制
  （#228）保持不变，仍会把「新增的意外 console.error」挡在门外。
- **在飞 import 的等待**：`dynamicImportSettled()` 无超时，若某模块的 import 永不落地，
  会以 afterAll 的 30s 测试预算收尸，是显式失败而非静默跳过。
