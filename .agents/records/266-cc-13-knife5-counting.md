# Dev Record — #266 CC-13 刀5 · 计数收尾（插件件进最小高 / 最小宽 / 显示前校验）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\CC-13-插件化通道全通\06-施工单-刀5-计数收尾.md`
> 规范：同目录 `00-施工规范-CC-13插件化通道全通-v1.0.md`（§5 刀5 / §10-4）
> 前一刀：`.agents/records/266-cc-13-knife4-properties.md`（其「未解问题」第二条 = 本刀收的口）

## 元信息

- issue：#561（CC-13 线）；总账 #266
- 分支：`feat/cc-13-plugin-channel.1`（开工 `git fetch` → `git merge origin/main` @ `c120dace` ⇒ **Already up to date**，无新提交、未产生合并提交）
- 提交范围：`d3c2f47e..工作树`（**本会话未 commit** —— 用户未授权提交，铁律）
- 日期：2026-10-06

## 目标与范围

插件件第一次进「最小高 / 最小宽 / 显示前校验」三处算式（三处共用同一套纯函数）：

1. **契约定形**：`CcWidgetContribution` 增可选 `sizing?: { width?; height? }`（px）；逐维校验，非法 ⇒ **忽略该维度** + 诊断（`cc-widget.sizing.rejected`），**不丢件、不丢另一维**；
2. **算式接入**：`resolveCcHeightGroups` / `resolveCcWidthGroups` / `resolveCcMinHeight` 的输入与 `ccShowVerdict` 各加一档**可选**「插件件」（缺省 `[]` ⇒ 既有行为逐位不变）；插件件按「落点 = **状态区**、可拖、不悬浮、无 `detachX`、无 `gap`」参与：高并入状态组**取 max**、宽并入状态队列**求和不带间距**；
3. **在场判据** = `isWidgetVisible(id, { hidden })`（与渲染同一谓词），且**由算式按每个切面逐条过滤**（不在调用方预筛）⇒ 隐藏不计数；「显示前校验」算的"改完之后"那一态才判得准；
4. **渲染层三处调用面**接上（`minHeight()` / `minWidth()` / 显示前校验的输入拼装）+ 尺寸拒绝走诊断口。

**不做**（逐条）：不做「实测尺寸 ⇒ 反哺算式」（声明式是本线统一口径，实测会引入渲染 ↔ 算式回环）；不改内置件任何算式口径（组高取 max / 宽求和 / 行高兜底 `ROW_MIN_HEIGHT` 全不动）；不改刀 1~4 已定的机制；不动 CSS 视觉；不动后端；不写仓外 `05-专项-中控区.md`（该件由翻译在验收后补）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugin-runtime/cc-widget/ccWidgetTypes.ts` | 契约：新 `CcWidgetSizing`（不导出给 SDK，与 `CcWidgetPropertyField` 同待遇）+ `CcWidgetContribution.sizing` + 注释指针 | 修改 |
| `src/domains/cc/ccHeightState.ts` | 新 `CcPluginWidgetSizing` 输入类型 / 插件件落点常量 / 维度取值防线；`resolveCcHeightGroups`、`resolveCcWidthGroups`、`CcMinHeightInput`、`resolveCcMinHeight`、`ccMinHeightInputOf` 各加可选插件件档 | 修改 |
| `src/domains/cc/ccShowVerdict.ts` | 输入增 `pluginWidgets?`，纵/横两条路一并递下去 | 修改 |
| `src/domains/cc/ccWidgetRoster.ts` | `resolvePluginWidgetSizing`（定形/校验/拒绝项）+ 条目携带 `sizing` + `resolveCcPluginWidgetSizings`（活名单 → 算式输入映射） | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 新 memo `ccPluginWidgetSizings`；三处调用面接入；尺寸拒绝诊断文案 + effect；刀4 的过期注释（"计数仍不算插件件"）同步 | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照重拍（**仅 `generatedAt`**） | 修改 |
| `src/domains/cc/__tests__/ccPluginSizing.test.ts` | 新增测试：定形与校验 + 算式纯函数 + 活名单映射 | 新增 |
| `src/renderers/solid-workbench/__tests__/ccPluginWidgetSizing.solid.test.tsx` | 新增测试：集成读数（真 `--cc-min-*`）+ 显示前校验 + 非法诊断 | 新增 |
| `.agents/records/266-cc-13-knife5-counting.md` | 本记录 | 新增 |

**§7 ★ 预列的登记型守卫（`settingsTraceability` / `effectivePresetTheme` / `widgetDefinitionTable`）逐条核过：全部未变红** —— 本刀不加主题字段（`ccEditMode` 那类 meta 字段与预设白名单都没动），快照 diff 仅 `generatedAt` 一行印证了这一点。**既有测试零改动、零删除**（见「测试处置」）。

## 方案要点

1. **声明式口径的落点**（本线的统一口径）：尺寸是**插件自己报的**，不实测、不回环。算式对"没报"的处理与内置「内容撑」件**同待遇** ⇒ 按 0 计，结果是**下界**（与 `--cc-min-width` 自 2.5 起的性质一致）。
2. **在场判据住在算式里，不搬去调用方**：`resolveCcHeightGroups` / `resolveCcWidthGroups` 都拿得到**该切面**的隐藏名单 ⇒ 逐条过 `isWidgetVisible`。这条决定了渲染层递进去的必须是**全量**插件件（不是 `visiblePluginWidgets`）：显示前校验要算"点下去之后"那一态，预筛会把"换个态才看不见的件"算错。渲染 memo 与算式 memo 因此各司其职（`visiblePluginWidgets` 只服务渲染）。
3. **不许凭空建组**（下界纪律）：只有"报了该维"的插件件才建组/加值 —— 否则一个没报尺寸的插件件会在状态区内置件全藏时凭空立起一个 28px 的行兜底组，把 64 抬到 120，直接违反"不报 = 与不登记逐位相同"。
4. **插件件不产生 `edgeGap` 声明**：它没有 `layout` 行 ⇒ 组已存在时**不动**该组的 `edgeGap`（沿用内置行声明）；组由它自己撑起来时 `edgeGap` 取 0（"无 gap"的直接读法，方向上偏**下界**）。这是单子没逐字写死的一处，按"缺项按 0"的既有算式纪律定，并在回单点名。
5. **契约复杂度对齐 `propertyFields`**：新增的是可选**形状**（`CcWidgetSizing`），保持不透明、不进 SDK 出口（`propertyFields` 的 `CcWidgetPropertyField` 同样不进）⇒ 契约定形处唯一，住在 `ccWidgetRoster.ts`，契约文件只留指针注释。
6. **两步防线**：定形处（`resolvePluginWidgetSizing`）拦非法值并给诊断；算式内部（`declaredDimension`）再拦一次非有限/≤0 —— 算式是纯函数，可能被测试或未来的新调用面直接喂原始值。
7. **渲染层接线**（刀4 留下的「已知限制」的收口处）：`minHeight()` / `minWidth()` / `showVerdictInputOf()` 三处各接同一份 `ccPluginWidgetSizings()`；诊断 effect 与刀4 的属性字段那两条同款（`cc-widget.sizing.rejected`，逐条点名元件与维度，不静默）。

## 验收标准与结果

| 验收项（施工单 §6） | 结果 |
| --- | --- |
| 1 报了就计（height 120 ⇒ ≥120；width 200 ⇒ 相应抬升） | ✅ 夹具：`--cc-min-height` **64 → 135**、`--cc-min-width` **384 → 584**；实机真浏览器同值（5 个挂载一致，CSS 实算 `min-height: 135px`） |
| 2 不报 = 下界（与不登记逐位相同） | ✅ 纯函数组表 `toEqual` + 集成读数 64/384（插件件仍上屏）；实机：报与不报分别 135/584 与 64/384 |
| 3 隐藏 ⇒ 不计（读数回落，取消 ⇒ 回升） | ✅ 集成用例（dispatch `set-cc-hidden`）；实机：隐藏后回落 64/384、取消回 135/584 |
| 4 显示前校验（装不下 ⇒ 拦；够装 ⇒ 放行） | ✅ 夹具：可用 100 ⇒ 拦（"还差 35px：需要 135px"）、可用 200 ⇒ 放行；实机：可用 150 而需要 4015 ⇒ 拦且**一条命令都没发**，换 200×40 ⇒ 放行上屏 |
| 5 非法 sizing（忽略该维 + 不丢件 + 诊断） | ✅ 纯函数 6 值 × 逐维 + 整条非对象；集成：该件仍在场、宽度维照收、两条诊断原文 |
| 6 内置件零回归 | ✅ 全量测试绿（5302 通过 / 1 跳过）、既有测试零改动；快照 diff 仅 `generatedAt` |
| 7 开发记录 | ✅ 本文件 |

## 测试处置

**新增（2 文件 / 19 例）**

1. `src/domains/cc/__tests__/ccPluginSizing.test.ts`（15 例）
   - 定形与校验：没报不诊断 / 两维各自可选 / 非法值六态（`-5`·`0`·`NaN`·`Infinity`·`'120'`·`null`）只丢该维 / 一维坏一维好 / 整条非对象（字符串·数组·`null`·数字）⇒ `dimension: 'both'`；
   - 算式：缺省入参逐位相同（组表 + 64 + 384）/ 报 height 取 max（64→135）/ 不高于内置最大高时不压低（仍 75）/ 内置全藏时插件件自己撑起那一组（120）/ 不报则一组建不起来（64）/ 报 width 求和（384→584，两件 634）/ 隐藏不计（含"只有一份切面藏了它"仍取另一份）/ 非法值按 0 计（组表 `toEqual`）；
   - 活名单：`sizing` 随条目带出、没报则键不出现、`sizingRejections` 两条形态、`resolveCcPluginWidgetSizings` 只取报了尺寸的件、`ccMinHeightInputOf` 第二参缺省逐位不变。
2. `src/renderers/solid-workbench/__tests__/ccPluginWidgetSizing.solid.test.tsx`（4 例）
   - 报了就计 + 隐藏回落 + 取消回升（读 `.control-center` 内联 `--cc-min-height` / `--cc-min-width`）；
   - 不报尺寸 ⇒ 逐位相同（64/384）而该件在场；
   - 显示前校验：给该元素造 `clientHeight = 100`（jsdom 无布局）⇒ 勾"显示"被拦、提示原文、主题一个字节不动；抬到 200 ⇒ 放行上屏；
   - 非法 sizing：两件都在场、宽度维照收 584、高度维按 0 计、两条诊断原文（去重后断言）。

**修改 / 删除（点名项）：无。** 新增入参一律**可选**（缺省 `[]`），既有测试的调用签名与期望值一个都没动；全量跑下来除新增文件外无红（含单子 §7 ★ 预列的三个登记型守卫）。

## 证据

- commit：**无**（未授权提交；改动全在工作树）
- 门禁（本机，日志 `E:\Acode\FILES\任务\工作台优化\报告等\06-施工单-刀5-计数收尾\门禁日志\`）：
  `bun run lint` **0** / `bun run build:example-plugin` **0** / `bun run build` **0**（`✓ built in 10.29s`）/ `bun run check:solid` **0** / `bun run test` **0**
  - 全量：**680 文件通过（1 跳过）/ 5302 用例通过（1 跳过）**，158.03s —— 对刀4 基线（678 / 5283）**恰为 +2 文件 / +19 用例**，无回归、无既有测试增删。
  - `check:solid` 关键读数：字段可达性 **179**（零读取 0）、CSS 类名 **1256**（不可达 0）、ZONE_FIELDS **176**、CSS 消费注入 104 / 消费 336 / 声明 356（死注入与悬空引用 0）、运行时边界 33 条遗留白名单（无新增）—— 与刀4 逐项相同（本刀不动主题字段）。
  - 本单不动后端 ⇒ 本地免跑 `check:rust` / `check:clippy`（`src-tauri/` 零改动，见 `git status`）。
  - 契约快照重拍：`bun scripts/check-workbench-theme-contract.mts --write` ⇒ `git diff` **仅 `generatedAt` 一行**（`05:08:24.595Z` → `06:40:31.940Z`）；字段 176 / 预设 10 未变。
- 反向验证（**6 个变体**：改坏 ⇒ 贴红 ⇒ 改回；除变体外无编辑，复绿 19/19、`EXIT=0`）：
  1. **A** 高度算式不接插件件（删合并循环）⇒ 7 红：`ccPluginSizing.test.ts:93:40`（`expected 64 to be 135`）、`:108:53`（`expected 64 to be 120`）、`:131:9`、`:185:93`、`:192:100`；`ccPluginWidgetSizing.solid.test.tsx:103:44`、`:141:80`（`expected null not to be null`）
  2. **B** 宽度算式不接插件件 ⇒ 3 红：`ccPluginSizing.test.ts:115:41`（`expected 384 to be 584`）；`ccPluginWidgetSizing.solid.test.tsx:103:44`、`:174:44`
  3. **C** 藏了的插件件照样计数（谓词固定 `hidden: []`）⇒ 2 红：`ccPluginSizing.test.ts:124:52`（`expected 135 to be 64`）；`ccPluginWidgetSizing.solid.test.tsx:108:44`
  4. **D** 定形不校验（收下任意数字）⇒ 3 红：`ccPluginSizing.test.ts:53:43`（`AssertionError: -5: expected { height: -5 } to be undefined`）、`:168:76`（`expected { width: 200, height: -5 } to deeply equal { width: 200 }`）；`ccPluginWidgetSizing.solid.test.tsx:181:49`（`expected [ Array(1) ] to deeply equal [ …(2) ]`）
  5. **E** 渲染层不把插件件递进算式（memo 恒空）⇒ 3 红：`ccPluginWidgetSizing.solid.test.tsx:103:44`、`:141:80`、`:174:44`（纯函数 15 例**全绿** ⇒ 证明这 3 条锁的正是"接线"）
  6. **F** 显示前校验的输入不接插件件 ⇒ **1 红**：`ccPluginWidgetSizing.solid.test.tsx:141:80`
  - 完整日志：报告目录 `反向验证-A..F-红.log` / `反向验证-复绿.log`。
- 数值读数（**夹具 = jsdom 集成用例**，真 DOM + 真 store dispatch）：
  | 态 | `--cc-min-height` | `--cc-min-width` |
  | --- | --- | --- |
  | 不登记插件件 | `64px` | `384px` |
  | 登记 `sizing {width:200, height:120}` | **`135px`** | **`584px`** |
  | 隐藏该件 | `64px` | `384px` |
  | 取消隐藏 | `135px` | `584px` |
  | 登记（不报 sizing） | `64px` | `384px`（与不登记逐位相同，且该件在 DOM） |
  | 非法 `{width:200, height:-5}` + `sizing:'x'` | `64px`（坏维按 0） | `584px`（好维照收） |
  - 显示前校验（夹具）：可用 `100×2000` ⇒ 拦（`还差 35px：需要 135px，当前 100px —— 先加高，或先藏别的`，`ccHidden` 未变、插件件未上屏）；可用 `200×2000` ⇒ 放行上屏、提示退场。
- 运行态读数（**实机 = `bun run dev` @5173 + In-app 浏览器**；探针件经 Vite 模块动态 import 登记进**真注册表**，隐藏/编辑态经主题 store 真字段写入，比例与刀4 的运行态取证同款）：
  | 态 | 第一个挂载的内联变量 | CSS 实算 `min-height` | 探针在 DOM |
  | --- | --- | --- | --- |
  | 基线（无探针） | `64px / 384px` | `64px` | — |
  | 探针 `sizing {width:200, height:120}` | **`135px / 584px`**（5 个挂载全一致） | **`135px`** | ✅ |
  | 隐藏（`ccHidden` 含探针） | **`64px / 384px`** | `64px` | ❌ |
  | 取消隐藏 | `135px / 584px` | `135px` | ✅ |
  | 卸载（dispose） | `64px / 384px` | `64px` | ❌ |
  | 再登记但**不报** sizing | `64px / 384px`（与不登记逐位相同） | `64px` | ✅ |
  - 显示前校验（实机，真元素真 click）：探针报 `{width:5000, height:4000}` + 隐藏 ⇒ 可用 `150×680`，点行内「显示」⇒ 提示 **`还差 3865px：需要 4015px，当前 150px —— 先加高，或先藏别的`**、探针**未上屏**、变量停在 64/384（= 被拦）；换成 `{width:200, height:40}` ⇒ 点「显示」放行、探针上屏、`--cc-min-width` 变 584、提示退场。
  - 附带印证（同一探针报巨大尺寸时）：`--cc-min-height` 真的被 CSS 消费 —— `.control-center` 的实测盒子被撑到 **4015px**（`min-height: var(--cc-min-height)` 生效），随后回落 150px。
- 说明书同步（仓内）：`docs/说明书/` 全文 grep「最小高 / 最小宽 / `--cc-min-height`」**零命中** ⇒ 仓内无表述需要跟随（仓外 `05-专项-中控区.md` 的补写按单子由翻译在验收后做）。

## 与 spec 的偏差

1. **槽位细节一处自行定死**（单子未逐字写死）：插件件自己撑起状态组时 `edgeGap = 0`；组已存在时**不改**该组的 `edgeGap`（沿用内置行声明）。依据 = 单子 §4.2「插件件一律按…无 `gap`」+ 算式既有的「缺项按 0」纪律，方向上偏**下界**（不会虚高）。已在代码注释与回单点名；如翻译认为应改（例如让插件件沿用状态行那一条 `ccMarginBottom`），改动面只有 `ccHeightState.ts` 两处 `?? { height: 0, edgeGap: 0 }`。
2. **实机取证用 `bun run dev` 预览 + 真浏览器，未跑 Tauri 真机**：与刀4 验收（其 §六-8，翻译**接受**）同款理由 —— 本刀全前端、无真实插件包可登记（真机里也登记不出带 sizing 的插件件），且本刀不改视觉；改为在真浏览器里登记探针件读**真 CSS 实算值**（见上表）。若翻译要求 Tauri 真机复验，请另开单。
3. **`CcWidgetSizing` 不进 SDK 出口**（`src/sdk/contract.ts` 未动）：与 `CcWidgetPropertyField` 同待遇（该不透明类型同样不在 SDK 出口里）；单子 §5 的文件清单亦未含 SDK。若希望插件作者能具名引用，另开小活。
4. **诊断 effect 会随名单重跑**（登记第二件时会把第一件的拒绝再报一遍）——既有写法（刀4 的属性字段诊断同款），本刀未改；集成用例因此按**去重后的消息集**断言，并在用例内注明了原因。

## 未解问题

- **显示前校验只算"声明口径"**：插件件自己不报尺寸（或不报该维）时，校验对它是**下界**——装得下"按声明"不等于装得下"按实际渲染"。这是本线的一致口径（不做实测回环），非缺陷；若将来要有精度的校验，需另立机制（会引入渲染 ↔ 算式回环）。
- **插件件不参与 `detachX` / 行级 `gap` / 悬浮**：算式里它们一律按"排队、无间距"计；渲染侧插件件也确实不挂 `cc-detach-x`（没有 `layout` 声明）。若将来允许插件声明脱离或间距，算式需同步加档。
- **状态区"全藏"时插件件自撑的组不带宽边距**（见「与 spec 的偏差」1）：现状只影响"内置件全被藏起来"的组合；默认口径下不可见。

## 并行交集

共享树内改动，按 pathspec 提交；本次碰过的共享文件（供他人避让）：

- 中控域：`src/domains/cc/{ccHeightState,ccShowVerdict,ccWidgetRoster}.ts`（**刀5 是本线最后一次动这三处**；计数算式的三处调用面已全部收口）
- 插件契约：`src/plugin-runtime/cc-widget/ccWidgetTypes.ts`（增 `CcWidgetSizing` 形状）
- 中控渲染层：`src/renderers/solid-workbench/input/ControlCenter.solid.tsx`（三处调用面 + 一条诊断 effect）
- 契约快照：`src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`（仅 `generatedAt`）
- 未碰：`src-tauri/**`、任何 CSS、`domains/theme/**`、`domains/appearance/**`（本刀不加字段、不改存储）
