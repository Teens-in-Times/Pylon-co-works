# Dev Record — #266 CC-13 刀1 · 内部收敛（渲染查表）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/266-cc-13-knife1-render-table.md`

## 元信息

- issue：#561（CC-13 线）；总账 #266
- 分支：`feat/cc-13-plugin-channel.1`（基于 `origin/main @ 04ebbc2c`）
- 提交范围：工作树未提交（`origin/main @ 04ebbc2c` → 工作树；按我方流程为本地存档点，等验收通过后落 commit）
- 日期：2026-10-05
- 施工单：`E:\Acode\FILES\任务\工作台优化\CC-13-插件化通道全通\01-施工单-刀1-内部收敛.md`（仓外）
- 施工规范：同目录 `00-施工规范-CC-13插件化通道全通-v1.0.md`（本单 = §5 刀 1；§3/§4/§6 必读）

## 目标与范围

**目标**：把中控 8 个内置件的渲染体，从「写死 `renderBody` switch + 两处特例内联 JSX」收敛为
**一张按「渲染标识」取用的表**（渲染标识 = 件 id），为刀 2「插件件走同一张表」铺路。
本刀**界面零变化**（硬底线）。

**做**：新增渲染层组件表；`ControlCenter.solid.tsx` 的 `renderBody` switch 退场改查表；
两个特例（`.cc-bg` 背景板 / `<SolidCcSendButton>` 发送按钮）的渲染体改从同表取。

**不做**：注册轨「在场门」与两个内置 contribution（退役留刀 2）；名单放开；布局键空间 /
`normalizeCcLayout` / 出厂数据；CSS / 类名 / DOM 结构 / 文案；定义表；后端；#410 域文件。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/input/createCcWidgetRenderers.solid.tsx` | 新增：`CcWidgetRenderContext` / `CcWidgetRendererTable` / `createCcWidgetRenderers()`；8 个渲染体（6 内置 + 背景板 + 发送按钮） | 新增 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | `renderBody` switch 删除 → 建表一次（`renderers`）；`renderWidget` 改 `renderers[id]()`；`.cc-bg` / 发送按钮两处改查表；清理 5 条不再使用的 import | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照按规范**主动重拍**（`bun scripts/check-workbench-theme-contract.mts --write`）——diff 仅 `generatedAt` 时间戳 | 修改（重拍产物） |

★ 文件名的偏差（施工单写 `createCcWidgetRenderers.tsx`，实际落 `.solid.tsx`）见「与 spec 的偏差」。

## 方案要点

1. **表键 = 定义表全部 8 行 id**（`Record<CcWidgetGroupId, () => JSX.Element | null>`）——编译期全覆盖：
   以后定义表加件忘了配渲染器 = 编译报错（取代原 `switch` 的穷尽性）。
2. **渲染体逐字搬迁**：8 段的 JSX / 逻辑 / 常量与注释原样搬运，只把「闭合在 ControlCenter
   作用域上的取值」改成 `ctx.<访问器>()`。
3. **ctx 纪律（Solid 响应性）**：一律传**访问器**（`appearance` / `runtime` / `hasNoSession` /
   `readonly` / `submitting` / `sendButtonMode` / `ccSurfaceRegistered` / `modelId` 等），
   `emptyComposer`（memo 本体）与 `predictionProvider`（值）直传；格式化函数与各 Solid 子组件
   直接 import、不进 ctx。
   **实证**：Vite 吐出的编译产物里全部 props 是惰性 getter
   （`get draftValue() { return _$memo(() => !!ctx.hasNoSession())() ? ctx.modelId : void 0 }`），
   与搬迁前的 Solid 编译形态一致（证据文件见报告目录 `after-编译形态-createCcWidgetRenderers.dev.js`）。
4. **调用位置零移动**：发送按钮的 `<Show when={ccSendButtonRegistered() && sendButtonMode()}>` 门
   与位置原样留在 `ControlCenter`（注册轨本刀不动；`ccSendButtonRegistered` 因此不进 ctx——
   表内不需要，避免死访问器）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（lint / build:example-plugin / build / check:solid / test） | 全 `EXIT=0`（见证据） |
| 全量测试计数与基线对账（允许 ±0） | 基线 667 passed \| 1 skipped（668）/ 5207 passed \| 1 skipped（5208）；改后**逐位相同**，无新增/删除用例 |
| 契约快照重拍 diff | 仅 `generatedAt` 时间戳一行（`2026-10-04T11:38:02.129Z` → `2026-10-05T12:09:38.233Z`） |
| 实机（Tauri）8 件 DOM / 属性 / 最小高宽 / 编辑列 / 属性面板 | 改前改后**逐项一致**（空态：在场 = input；`--cc-min-height=85px` / `--cc-min-width=0px`；input 矩形 250/384/720×40；编辑列 7 行 × 属性面板逐项一致） |
| 预览环境（`bun run dev`）8 件 | 改前改后**逐字节一致**（唯一差异 = `createUniqueId()` 生成的菜单 id 序号，每次挂载递增） |
| 源码自查 | `ControlCenter.solid.tsx` 内 `switch (id)` 0 命中；`.cc-bg` / `<SolidCcSendButton` 内联 JSX 均不在；查表调用点 3 处（`renderers[id]()` / `cc-surface` / `cc-send-button`） |
| 查表生效破坏演练 | `tokens` 渲染器临时置空 ⇒ 既有测试 3 例红（含 `mountSolidWorkbench.solid.test.tsx:1256`）⇒ 改回复绿 102/102 |

## 测试处置

- 新增测试：**无**（表覆盖由 `Record<CcWidgetGroupId, …>` 编译期强制；行为零变化由既有测试 + 实机对照承担）。与施工单 §7 一致。
- 改 / 删既有测试：**无**。

## 证据

- commit：**未提交**（工作树；新文件已按路径加入 git index 以使「git 追踪面」守卫可见，见下）
- 测试：
  - 基线 `bun run test` → `EXIT=0`；`Test Files 667 passed | 1 skipped (668)` / `Tests 5207 passed | 1 skipped (5208)`
  - 改后 `bun run test` → `EXIT=0`；同上计数逐位相同
  - 破坏演练：`bun run test src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` → `EXIT=1`，`Tests 3 failed | 99 passed (102)`；改回后 `EXIT=0`，`102 passed (102)`
- 手工验证（实机 Tauri，`src-tauri/target/debug/pylon.exe` + 9222 调试端口；产物按「当前源码」重建）：
  空态读数、编辑列 7 行、属性面板逐行（3 + 属性字段）、输入框交互后复原——与基线逐项一致；
  预览环境（Vite 6.4.3 / `http://localhost:5173/`）8 件在场性与属性一致。
- 报告与原始日志：`E:\Acode\FILES\任务\工作台优化\报告等\01-施工单-刀1-内部收敛\`（基线/改后两份，含 `after-编译形态-*.dev.js`、破坏演练红/绿日志）

## 与 spec 的偏差

1. **文件名**：施工单 §2/§4.1 写 `src/renderers/solid-workbench/input/createCcWidgetRenderers.tsx`；
   实际落 **`createCcWidgetRenderers.solid.tsx`**。原因：仓库把「Solid JSX 只在 `.solid.tsx`」立成
   硬门禁——`scripts/check-solid-workbench-boundaries.mjs:57-59` 对含 Solid JSX 的非 `.solid.tsx`
   文件直接判红；`vite.config.ts` / `vitest.config.ts` 的 Solid 编译面也是
   `/src\/.*\.solid(?:\.test)?\.tsx$/`（`.tsx` 会被 esbuild 的 automatic runtime 编译 ⇒ props 变
   即时求值 ⇒ 反应性丢失，直接违反「界面零变化」）。按施工单 §4.1「命名可微调，语义不得变」处理。
2. **ctx 访问器集合**：施工单 §4.2 表中列有 `ccSendButtonRegistered()`（谁在用 = "cc-send-button 调用处"）。
   该门留在 `ControlCenter`（调用位置不动），表内不需要 ⇒ **未**进 ctx（避免死访问器）。
   其余 14 项按表落位（`appearance` / `runtime` / `hasNoSession` / `modelId` / `setModelId` /
   `reasoningLevel` / `setReasoningLevel` / `mode` / `setMode` / `readonly` / `submitting` /
   `emptyComposer` / `predictionProvider` / `sendButtonMode` / `ccSurfaceRegistered`）。
3. **git index**：为让 CC-15 可达性守卫（扫描面 = `git ls-files`，见 `scripts/check-css-class-reachability.mts` 头注）
   把新文件的类名计入生产可达面，新文件已按**路径**加入索引（`git add -- <该文件>`）；**未 commit**。

## 未解问题

- 实机空态下 6 件状态件默认被 `ccHiddenEmpty` 隐藏（出厂默认），因此「8 件 DOM 在场性」在实机空态
  只能对 input 实测在场、其余 6 件实测不在场（改前改后一致）；**完整 8 件在场读数取自预览环境**
  （有会话态）。这是数据状态限制，不是本刀行为问题。
- 施工单 §5-4 表述「发送按钮在预览环境仍不出现」与实测不符：预览环境（有会话态）发送按钮**在场**
  （`data-mode=inline`）；它只在**空态**不出现。注册轨本刀未动 ⇒ 改前改后一致（证据见报告）。

## 并行交集

- `src/renderers/solid-workbench/input/ControlCenter.solid.tsx`（本单修改）
- `src/renderers/solid-workbench/input/createCcWidgetRenderers.solid.tsx`（本单新增）
- `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`（快照重拍，仅时间戳）
- **只读未写**：`src/renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx`（[kumo] #410 在途域文件）、
  `createCcSources.ts` / `domains/cc/*` / `plugins/core/cc/*`（本刀不动）
- `.agents/L.md` 未动（不在本单改动文件清单内；#410 与本单文件域的重叠已在回单「阻断与新增」报告）
