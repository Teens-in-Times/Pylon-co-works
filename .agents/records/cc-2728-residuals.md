# Dev Record — #266 CC-27/28 清尾两件（悬空聚合项 + 死选择器成分）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/cc-2728-residuals.md`

## 元信息

- issue：#266（总账跟踪；两件均为无行为影响的死面清理，不另立 issue）
- 分支：`chore/cc-2728-residuals.1`（基于 `origin/main` `8f4a1d6f`）
- 提交范围：未提交（工作者不 commit，待用户/翻译处置）
- 日期：2026-10-06
- 施工单：`E:\Acode\FILES\任务\工作台优化\CC-2728清尾两件\01-施工单-CC2728清尾两件.md`

## 目标与范围

删两处死面，预期**零行为变化**：

1. `createCcSources.ts` 的 `CcSources.createWorkspace` 聚合项（接口项 + 实现项 + 随之不再需要的 `useWorkspaceEntityStore` import）——单 22 删壳 popover 后生产侧 0 消费方。
2. `WorkbenchChrome.css` 空态 `max-width: 100%` 三成员选择器组里 `[data-widget-id='workspace']` 成分——workspace 控件已随刀4 从定义表移除，该成分零命中。

**不做**：不动底层 `useWorkspaceEntityStore.createWorkspace`（侧栏在用）；不动 `.cc-widget` 其它属性选择器与其它 CSS 规则；不动后端 / 契约 / 主题字段；无新增测试。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/input/createCcSources.ts` | `CcSources` 接口删 `createWorkspace` 成员；工厂返回值删对应实现；删 `useWorkspaceEntityStore` import；头注释追加一条 ★ 退役注记 | 修改（删除为主） |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css` | 空态段三成员选择器组摘除 `[data-widget-id='workspace']` 一行，`model` / `mode` 成分与规则体原样保留 | 修改（删 1 行） |

## 方案要点

- 复核先行：全仓 grep `createWorkspace`（ts/tsx/css，`src/`、`shared/`、`src-tauri/src/`）逐条分类——底层 store 定义/实现（活）、侧栏 `useSidebarContributionProps.ts` / `SessionsPanel.solid.tsx` 直读 store（活）、`createWorkspaceClient` 工厂为同名无关物、仅 `createCcSources.ts:30/40` 两行属本单；无测试引用该聚合项。
- 头注释按本文件既有维护模式（CC-13 刀2 先例）追加 ★ 注记说明建区聚合项退役、底层同名成员仍被侧栏使用；注记措辞避开了 `createWorkspace` 标识符本身，使单子「grep 归零」验收可按字面满足。
- CSS 只摘成分行，`model` / `mode` 两个成分与 `{ max-width: 100% }` 规则体不动。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| grep 归零：`createCcSources.ts` 内 `createWorkspace` 0 命中 | ✓（`grep -n "createWorkspace" …createCcSources.ts` → exit=1 无命中） |
| grep 归零：全仓（含 CSS）`data-widget-id='workspace'` 0 命中 | ✓（单引号形式 exit=1 无命中；另有 `mountSolidWorkbench.solid.test.tsx:1878` 的**双引号**形式 1 处，为「断言控件不存在」的活反向验证，不属于死面、按单不动） |
| 空态下 `.cc-widget[data-widget-id='model']` 的 `max-width` = 100% | ✓（:5173 预览实测 `"modelMaxWidth": "100%"`；`mode` 同为 `"100%"`；全文档 `data-widget-id='workspace'` 元素 0 个） |
| 门禁五步全绿 | ✓（lint / build:example-plugin / build / check:solid / test 均 EXIT=0；test 680 文件 5308 用例通过、1 skipped，两条已知 flake 未红） |
| 契约快照 diff 仅 `generatedAt` | ✓（`check-workbench-theme-contract.mts --write` 后 diff 仅 `generatedAt` 时间戳变化，随后已还原该文件，不入改动） |

## 测试处置

新增：无。修改 / 删除：无。既有测试零触碰。

## 证据

- commit：无（未提交）
- 测试（名称 + 退出码）：`bun run lint` EXIT=0 → `bun run build:example-plugin` EXIT=0 → `bun run build` EXIT=0（✓ built in 13.96s）→ `bun run check:solid` EXIT=0 → `bun run test` EXIT=0（Test Files 680 passed | 1 skipped (681)；Tests 5308 passed | 1 skipped (5309)）
- 手工验证：:5173 浏览器预览空态读数 `{"modelMaxWidth":"100%","modeMaxWidth":"100%","workspaceWidgetCountInDoc":0}`；验收用 localStorage 临时改 `ccHiddenEmpty` 放开 model/mode，读数后已恢复原值并刷新（环境零残留）

## 与 spec 的偏差

- 施工单「改动文件」未列头注释，本单按本文件刀2 先例追加了 ★ 退役注记（2 行）：原注释「四处直读 store」的历史列举保持完整，且描述被删成员的文字不留过时；注记措辞避开 `createWorkspace` 字样以字面满足 grep 归零。已在回单「总结」中报备。
- 单 22 遗留的台账卡 CSS 路径（`WorkbenchChrome.css:431`）已过时，现路径为 `styles/components/solid-workbench/WorkbenchChrome.css:428`（翻译已在单中更正，本次施工按更正后路径执行）。

## 未解问题

- 无。

## 并行交集

- 共享文件交集：无在途条目（`.agents/L.md` 开工时为空）。本单触碰 `createCcSources.ts` 与 `WorkbenchChrome.css`，其他在途任务请避让。
