# Dev Record — #266 CC-13 刀3 · 工位开闸（位置键空间 + 拖动/编辑列 + 卸载即清）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/266-cc-13-knife3-placement-rail.md`

## 元信息

- issue：#561（CC-13 线）；总账 #266
- 分支：`feat/cc-13-plugin-channel.1`（开工先 `git fetch` → `git merge origin/main @ 867cdcdc`）
- 提交范围：未 commit（等用户发话）；改动面 = 15 改 + 4 新增（见下）
- 日期：2026-10-05 晚 ~ 2026-10-06 凌晨

## 目标与范围

**目标**：插件元件从「画出来了」变成「能像内置件一样站位」——
① 位置键空间放开（`Record<string, CcWidgetPlacement>`）；② `normalizeCcLayout` 改「保留未知键」（本单最关键：
读盘早于插件登记，读盘丢 = 每次重启误删插件位置）；③ 名单收口（编辑列 / 拖动 / 碰撞障碍集由活名单派生）；
④ 卸载即清（新命令 `clear-cc-placement`，热替换不误清）；⑤ 窄窗样式与内置件同款（不可压缩）。

**不做**：属性面板（刀4）；显隐同权与最小高宽计数（刀5，插件件本单仍不进计数）；`rail` / `CC_WIDGET_IDS` 重构；
隔离面 I/O 改动；后端 / IPC；#410 域重设计；**不消费**插件 contribution 的 `defaultPlacement`（用户口径：
默认永远排最后）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/ccLayoutState.ts` | 键类型降级为 `string` 别名；`normalizeCcLayout` 改「补内置默认 + 逐键 clamp + 保留未知键」；`clampCcPlacement` 抽出；`updateCcPlacementState` 撤「未知 id = no-op」（插件首写要落得下去）；新增 `clearCcPlacementState` | 修改 |
| `src/domains/cc/ccWidgetRoster.ts` | 新增工位三件：`resolveCcDraggableWidgetIds`（可拖派生）/ `resolvePluginWidgetPlacement`（状态区末尾 + 登记序）/ `resolveCcWidgetPlacements`（位置兜底解析） | 修改 |
| `src/domains/appearance/appearance.ts` | `AppearanceCommand` 增 `clear-cc-placement` | 修改 |
| `src/domains/appearance/workbenchAppearanceStore.ts` | 纯 reducer 落点（记录不存在 ⇒ 原样返回同一份 theme） | 修改 |
| `src/domains/appearance/themeProjectedWorkbenchAppearanceStore.ts` | 派发到 themeStore action | 修改 |
| `src/domains/theme/themeStore.ts` | 新 action `clearCcPlacement`（幂等；**不**置 zone custom） | 修改 |
| `src/renderers/solid-workbench/input/createCcDragController.ts` | 删 `CC_EDIT_TOOLBAR_IDS`；`CcDragPorts` 增 `draggableIds()`，障碍集改读它 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 活名单 / 可拖派生 / 位置兜底解析三个 memo；插件件包装补位置样式 + 拖动接线 + 编辑态类名；编辑列改读派生名单与自报 label；卸载清理 effect（微任务复查） | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css` | 新增一条：`.cc-widget.cc-plugin-widget { flex:0 0 auto }`（窄窗不可压缩；逐条理由见回单） | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照重拍（仅 `generatedAt`） | 修改 |
| `src/domains/cc/__tests__/ccLayoutV8.test.ts` | 点名改：normalize 语义改后的期望值 | 修改 |
| `src/renderers/solid-workbench/input/__tests__/ccVisibilityCollisionGuard.solid.test.tsx` | 点名改：障碍集改读派生 + 插件件正控 2 例 | 修改 |
| `src/renderers/solid-workbench/input/__tests__/createCcDragController.test.ts` | 点名改（§7-3「以 grep 为准」）：常量改读派生；ports 补 `draggableIds`；新增「障碍集取自端口」例 | 修改 |
| `src/domains/theme/__tests__/structuralAlignment.test.ts` | **未点名**改：旧「多余项忽略」期望值 → 未知键保留（§4.2 的直接后果） | 修改 |
| `src/domains/theme/__tests__/themeSchemaV8Backfill.test.ts` | **未点名**改：`pct` 不再被读盘丢弃（同 §4.2） | 修改 |
| `src/domains/cc/__tests__/ccLayoutWidgetSpace.test.ts` | 新增：键空间 / clamp / 别名 / 兜底解析 / 读盘往返 | 新增 |
| `src/domains/appearance/__tests__/clearCcPlacement.test.ts` | 新增：命令三段接线 + 幂等 + 两路等价 | 新增 |
| `src/renderers/solid-workbench/__tests__/ccPluginWidgetPlacement.solid.test.tsx` | 新增：集成（默认末尾 / 编辑列 / 拖动落盘 / 顺序数据驱动） | 新增 |
| `src/renderers/solid-workbench/__tests__/ccPluginWidgetCleanup.solid.test.tsx` | 新增：集成（撤下清 / 同帧复查 / shadow 不误清 / 幂等） | 新增 |

## 方案要点

1. **键空间**：`CcLayoutWidgetId` 降级为 `string` 别名（§4.1 允许；保留名字让「位置表的键」这层意思留在类型里）。
   合法性改由运行时承担：写侧逐键 clamp、读侧兜底。
2. **归一化**：遍历**持久化数据里的每一个键**（不再是"只遍历内置全集"），补内置默认 + 逐键 clamp + 未知键保留；
   legacy `send` 仍按别名并入 `cc-send-button`（真名优先），不以 `send` 为键残留。
3. **插件件默认落点**：状态区（与 model/reasoning/… 同一落脚处），`order = 该落脚处内置最大 order(6) + 1 + 登记序`，
   偏移 0/0；**不写进数据**（用户没动过就没有记录）。
4. **位置读取唯一入口** `resolveCcWidgetPlacements(layout, pluginIds)`：排序 / 拖动起点 / 编辑列三输入框 /
   渲染内联样式 / 首写补齐全走它 ⇒ 插件件未落盘也不会 `undefined.order`。
5. **卸载即清**：宿主比对活名单插件 id 集，消失者延迟一个**微任务后复查**（同帧撤下+重登记不误清），
   先查 `placements[id]` 存在才派发 `clear-cc-placement`（幂等）。
6. **拖动**：插件件走既有 `update-cc-placement` 全链路（阈值 3px + 占区守卫），**提交前用兜底解析补齐**
   （首写把计算默认 order 一并落盘，否则一次拖动就把"排最后"毁成 0）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（lint / build:example-plugin / build / check:solid / test） | 全 `EXIT=0`；`Test Files 674 passed \| 1 skipped`；`Tests 5259 passed \| 1 skipped` |
| 契约快照重拍 | diff **仅 `generatedAt`** |
| 拖动与持久化（实机） | 拖 beta ⇒ `placements['probe.cc-beta'] = {order:8, offsetX:20, offsetY:8}`（store + localStorage 同值）+ 内联 `translate(20px, 8px)` |
| 重启后仍在（实机刷新） | 刷新后 store（读盘归一化已跑）仍带两条插件记录；重装插件 ⇒ beta 仍渲染 `translate(20px, 8px)`，且 DOM 先后被**数据**改写为 `[beta(8), alpha(9)]`（登记序是 alpha 先） |
| 卸载即清（实机） | 撤下 beta ⇒ 它的键消失、alpha 的键保留；DOM 只剩 alpha |
| 重装 ⇒ 排最后（实机） | 重装后 beta `transform` 为空（不带旧位移），数据里没有它的键，DOM `[beta, alpha]` |
| 热替换不误清（实机 shadow） | 同 id 换实例后 alpha 的键 / 值 / DOM 顺序一字未动 |
| 窄窗不被压扁（实机 900px） | 插件件 `flex: 0 0 auto`，宽 132 / 48（自然宽）；行 `flex-wrap: nowrap`、`scrollWidth 687 > 行宽 306`（溢出而不压扁/不折行） |
| 对照读数（规则撤掉） | 把规则覆盖成 `flex-shrink: 1` ⇒ 两个插件件宽度塌到 **0**；同排的"刀3 前包装形状"对照件被压到 33px |
| 页面零报错（实机） | 全流程 `errors: []` |
| 开发记录 | 本文件 |

## 测试处置

- **新增（4 个文件 / 20 例）**：`ccLayoutWidgetSpace.test.ts`（8）、`clearCcPlacement.test.ts`（4）、
  `ccPluginWidgetPlacement.solid.test.tsx`（4）、`ccPluginWidgetCleanup.solid.test.tsx`（4）。
- **点名改（3 个文件）**：`ccLayoutV8.test.ts`（v7 用例里「已删 id 自然丢弃」两条断言 → 未知键保留）；
  `ccVisibilityCollisionGuard.solid.test.tsx`（障碍集改读 `resolveCcDraggableWidgetIds` + 新增插件件正控 2 例）；
  `createCcDragController.test.ts`（§7-3「以 grep 为准」：常量 → 派生；ports 补 `draggableIds()`；新增端口驱动障碍集 1 例）。
- **未点名改（2 处，已上报）**：`structuralAlignment.test.ts` 的「多余项忽略」用例、
  `themeSchemaV8Backfill.test.ts` 的 `pct` 断言 —— 两者都是 §4.2「未知键保留」的直接后果（详见回单「阻断与新增」）。
- **反向验证（7 个变异，全部改回）**：见报告文件 §三（含红行与 `文件:行号`）。

## 证据

- commit：无（等用户发话）
- 测试：`bun run test` → `674 passed | 1 skipped`，`5259 passed | 1 skipped`，`EXIT=0`
- 门禁：`lint` / `build:example-plugin` / `build`（`✓ built in 9.44s`）/ `check:solid`（字段 178 零读取 0；
  CSS 类名 1255 不可达 0；ZONE_FIELDS 175）/ `test` 全绿
- 手工验证（浏览器预览 + 页面内探针，`localhost:5173`）：位置链 / 刷新 / 装卸往返 / shadow / 窄窗对照读数，
  全部数值见报告文件 `E:\Acode\FILES\任务\工作台优化\报告等\04-施工单-刀3-工位开闸\`

## 与 spec 的偏差

1. **插件件不进状态组容器**（保持刀2 的 `.cc-status-row > .cc-widget` 形状）⇒ 插件件的 `order` 只决定
   **插件件之间**的先后，不能插到内置件中间。原因：进组会让未点名的 `ccPluginWidgets.solid.test.tsx` 的
   `parentElement` 断言变红（§7 ★ 禁区）。**待裁决**（见回单「阻断与新增」）。
2. **`updateCcPlacementState` 撤掉"未知 id = no-op"**：键空间放开后插件 id 与错字在这一层不可区分，
   插件件首写必须落得下去（后果：对任意 id 的 placement 写入都会建记录）。
3. **`clear-cc-placement` 不置 zone custom**：撤下是插件侧事件、不是用户手改该区域（口径见类型注释）。
4. **§4.6 的「槽内可换行」未实现**：现口径是 `flex-wrap: nowrap`（行数恒 1 是高度算式的前提），
   「与内置件同款」= 不可压缩 + 横向溢出 + 不折行；折行会让内置件行为回归（§6.5 零回归红线）。

## 未解问题

1. 插件件的 `order` 能否插到内置件之间 ⇒ **待用户/翻译裁决**（要的话把插件件移进 `.cc-status-group`，
   并同步更新 `ccPluginWidgets.solid.test.tsx` 的 DOM 结构断言）。
2. 跨运行边界（应用外删掉插件包）留下的位置记录不做检测（单子 §4.4 明确）：不可见、不影响行为；
   数据里会积累（与"未知键一律保留"同源）。
3. 显隐开关在插件件行上可用（会写数据）但渲染侧本刀不消费 —— 刀5 同权后生效（已知限制）。

## 并行交集

- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css`：仅新增 1 条
  `.cc-plugin-widget` 规则，未动既有规则（#410 声明域，用户 10-05 口径「暂不动」）。
- 未碰 `src-tauri/**`、未碰 `docs/说明书/`、未碰 `.agents/` 下他人文件。
