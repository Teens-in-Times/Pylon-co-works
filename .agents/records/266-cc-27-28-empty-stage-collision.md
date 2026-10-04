# Dev Record — #266 CC-27+28 空态拆词同源 + 障碍集报警守卫

## 元信息

- issue：#266（CC-27 显隐↔碰撞箱 + CC-28 空态定位，合成一单）
- 分支：`feat/cc-2728-empty-stage.1`（基于 origin/main @ b089c026，未 commit / 未 push / 未开 PR）
- 提交范围：工作树改动（未 commit，单子约定不 commit）
- 日期：2026-10-04

## 目标与范围

①「空态」拆词：`hasNoSession`（无会话）与 `sessionEntering()`（进场 360ms）分离，名单门与草稿态只认前者（进场期元件在场，用户拍板）；②堵 CSS 暗道（空态藏显只认两层名单）；③删除已关闭的「空态工作区选择器」UI 壳全族 + 模型瘦身搬家；④新增测试层报警守卫「可见名单 ⊆ 量得到盒子」。

**不做**：两层名单结构（`ccHidden`/`ccHiddenEmpty`）不动；`.is-empty` 样式段与 `is-empty`/`is-session-entering`/`is-session-creating` 类挂载条件不动；动画/缓动/过渡不调；`src-tauri/` 不碰；`mountSolidWorkbench.solid.test.tsx` 一字不动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 信号拆词（`hasNoSession`/`emptyVisual`）、名单门实参、草稿态三控件、工作区模型 import 与实例化段、:553 状态行壳分支 | 修改 |
| `src/renderers/solid-workbench/input/createCcWorkspaceSelection.solid.tsx` | 模型瘦身落点：workspaceId 值管理 + 空态预选（唯一就选/最近活跃/未知清空）+ `pylon:new-session` 监听 + `dispose` | 新增 |
| `src/renderers/solid-workbench/input/CcWorkspacePicker.solid.tsx` | 整文件（UI 壳：组件本体 + `SHOW_EMPTY_WORKSPACE_CONTROL` 常量） | 删除 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css` | `:419` tokens 空态 `display:none` 暗道行；`.cc-empty-workspace-*` 整段；两处 `:is()` 复合选择器死成分 | 修改 |
| `src/domains/events/pylonCustomEvents.ts` | `'pylon:workspace-folder-picked'`、`'pylon:pick-workspace-folder'` 两条契约条目 | 修改 |
| `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.solid.tsx` | `:4` `open` import + `onMount` 死服务监听段（选目录服务，两端已随壳/模型拆除） | 修改 |
| `src/renderers/solid-workbench/input/__tests__/ControlCenter.solid.test.tsx` | CcWorkspacePicker 直挂段（3 条壳测试）+ 相关 import 与头注释 | 修改 |
| `src/renderers/solid-workbench/input/__tests__/ccVisibilityCollisionGuard.solid.test.tsx` | 守卫测试（常态/空态/暗道场景 3 条） | 新增 |
| `.agents/records/266-cc-27-28-empty-stage-collision.md` | 本记录 | 新增 |

## 方案要点

- **拆词**（CC-28 Q1）：`hasNoSession = () => !input().sessionId` 为会话真值；`emptyVisual = hasNoSession() || sessionEntering()` 只服务视觉挂载（`is-empty` 类、`showStatusSlots`），条件不变。名单门 `hiddenWidgetIdsFor(hasNoSession())` —— 进场 360ms 名单不再生效 ⇒ 元件在场（用户 2026-10-04 认可的新口径）；草稿态（model/reasoning/mode 的 draft/forceDropdown）同改 `hasNoSession()`。`hiddenWidgetIds` 全部消费方（画布 `visibleIds`、最小宽 `resolveCcWidthGroups`、编辑清单 chip `＋/●`）随门翻转，语义自洽，无需单独适配。
- **同源**（CC-28 Q2）：两层名单（`resolveCcHiddenWidgetIds`）成为空态藏显唯一权威；删掉绕过名单的 CSS 写死藏显（tokens 暗道行）。
- **死控件族**（CC-28 Q3，两次拍板收口）：UI 壳死、模型活的判定升级后按 C 方案执行——壳全删，模型瘦身搬家（`choose`/`registerSelect`/`draft`/`editDraft`/`pickFolder`/`create` 及 `pylon:workspace-folder-picked` 监听、select DOM 修复 effect、`workspaceSelectionTouched` 恒假分支随 UI 入口一并退场）。侧栏「带工作区建会话」与空态预选两条活链路保全，验收线 = mount 3 条用例原样绿。
- **守卫**（CC-27 Q2=(c)）：测试层复刻生产量法的取件（`CC_EDIT_TOOLBAR_IDS` ∩ 可见 − 悬浮件，`[data-widget-id]` 选择器），「量不到」= 节点缺席或 `display:none`；jsdom 无布局 ⇒ 几何留实机验收，测试判据在回单注明。
- **教训（已写进单子附记）**：判「死代码」前追运行时事件链（window 广播不经过 import 图）；grep 不许 head 截断。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `git diff --numstat` 只含改动清单文件 | ✓（6 改 + 2 增 + 1 删 + 记录；`mountSolidWorkbench.solid.test.tsx` 零改动） |
| 死控件族符号 grep 0 命中 | △ 仅剩 `mountSolidWorkbench.solid.test.tsx` 注释 2 处（:1355/:1449，内容已失真）——该文件单子钉「明确不动」，矛盾待翻译定夺 |
| 两条死事件名 grep（src/ shared/）0 命中 | ✓ |
| `AgentRendererSuiteWorkbench.solid.tsx` 内死事件名 0 命中 | ✓（diff 仅 :4 import + 监听段，numstat 0/9） |
| WorkbenchChrome.css `data-widget-id='tokens'` 0 命中 | ✓ |
| `hiddenWidgetIdsFor` 门处实参 | ✓ `hasNoSession()` |
| 守卫两态绿 + 暗道场景抓到 | ✓（3 passed；暗道用例断言差集含 tokens，即「守卫红」被点亮） |
| 反向验证（§八） | ✓ 守卫改坏 → 暗道用例红（见证据）→ 改回复绿 |
| mount 3 条验收线用例（:1348/:1368/:1413）原样绿 | ✓（-t "工作区" 点名 4 passed） |
| 门禁五步 | ✓ 全 EXIT=0（见证据） |
| 全量用例数对账 | ✓ 基线 5196 − 直挂段 3 + 守卫 3 = 5196 passed（实跑一致；5198 总 = 5196+1 skipped+1 todo） |
| 契约快照 | ✓ `--write` 后 baseline diff 仅 `generatedAt` 一行（无规则内容变更），已 `git restore` 还原 |

## 测试处置

| 文件 | 处置 |
| --- | --- |
| `ControlCenter.solid.test.tsx` CcWorkspacePicker 直挂段 | 删 3 条（被测 UI 壳已删；模型行为由 mount 3 条锁） |
| `ccVisibilityCollisionGuard.solid.test.tsx` | 新增 3 条（守卫） |
| `mountSolidWorkbench.solid.test.tsx` | 零改动（验收线） |
| `pylonCustomEvents.test.ts` | 零改动（不钉具体条目，实测不受影响） |
| 「进场期名单生效」类候选用例 | 全量两跑未见受影响用例红，未动 |

## 证据

- commit：未 commit（单子约定）。
- 测试（名称 + 退出码）：门禁五步 `lint` / `build:example-plugin` / `build` / `check:solid` / `test` 全 EXIT=0；全量 `Tests 5196 passed | 1 skipped | 1 todo (5198)`。守卫文件单独跑 `3 passed (3)`。反向验证红：用例「暗道场景：名单放出 tokens 后注入 display:none ⇒ 守卫必须红（抓到 tokens）」`AssertionError: expected [] to include 'tokens'` @ `ccVisibilityCollisionGuard.solid.test.tsx:122:64`（守卫被临时改坏期间），改回后复绿。
- 手工验证：实机四项（视觉对照 / 进场 360ms 元件在场 / tokens 放出显示 / 拖动行为）属翻译复验范围，本单未做。

## 与 spec 的偏差

- 模型落点文件名：单子写 `createCcWorkspaceSelection.ts`，实际 `createCcWorkspaceSelection.solid.tsx`——`check-solid-workbench-boundaries.mjs` 规定 solid-workbench/ 下 import `solid-js` 的文件必须用 `.solid.tsx`（无 JSX 也然），无第二解。
- 契约条目删除范围扩大一条：`'pylon:pick-workspace-folder'`（单子二次修订已授权，死服务段同批删除）。
- 回带判据「死控件族符号 0 命中」存在 2 处 mount 注释命中（见「未解问题」）。

## 未解问题

1. **mount 注释 2 处命中 vs 回带 0 命中判据**（单子内部矛盾）：`mountSolidWorkbench.solid.test.tsx:1355/:1449` 注释里的 `SHOW_EMPTY_WORKSPACE_CONTROL` 提法已失真（常量已删，「置 true 即恢复」的能力不存在）。处置二选一：改这 2 行注释（需解除「明确不动」）或放宽回带判据。**工作者未动该文件。**
2. **`createCcSources.createWorkspace` 聚合项生产侧悬空**：模型瘦身删掉 `deps.createWorkspace` 后，`createCcSources.ts:32/:48` 的 `createWorkspace` 无生产消费方（底层 `useWorkspaceEntityStore.createWorkspace` 仍被侧栏使用，活的）。`createCcSources.ts` 在改动面外未动，建议并入下一单清理。
3. **CSS 死成分残留**：`WorkbenchChrome.css` 空态段还有一条 `.cc-widget[data-widget-id='workspace']` 选择器成分（`workspace` 控件刀4 已从定义表移除）——不含单子 grep 词、不在点名范围，未动，建议并入下一单。
4. 全量 test 曾出现 1 例计时 flake（`agentWorkbenchSession.terminalDelivery.test.ts:82` `elapsedMs` 期望 >0 实得 0）：单独跑绿、全量重跑绿、与本单改动面零 import 交集，判定为环境性 flake，未处理。

## 并行交集

- `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.solid.tsx`：ACh 线域文件（CC-04 同文件先例），本单仅删 :4 import 与 :280-287 死服务段，经用户授权。
- `src/domains/events/pylonCustomEvents.ts`：契约公共文件，删 2 条死条目（`pylon:new-session` 保留未动）。
- 分支 `feat/cc-2728-empty-stage.1` 未 commit；共享工作树提交时按 pathspec 收敛。
