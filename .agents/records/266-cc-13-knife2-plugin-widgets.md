# Dev Record — #266 CC-13 刀2 · 画面开闸（插件件上屏）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/266-cc-13-knife2-plugin-widgets.md`

## 元信息

- issue：#561（CC-13 线）；总账 #266
- 分支：`feat/cc-13-plugin-channel.1`
- 施工基线：`15b721a2`（刀1 存档点 `a07b7c0f` + `merge origin/main @ 42504d86`）
- 提交范围：工作树未提交（等验收通过后落本地存档点）
- 日期：2026-10-05
- 施工单：`E:\Acode\FILES\任务\工作台优化\CC-13-插件化通道全通\03-施工单-刀2-画面开闸.md`（仓外）
- 施工规范：同目录 `00-施工规范-CC-13插件化通道全通-v1.0.md`（本单 = §5 刀 2；§4 / §10-1 必读）
- 能力清单：同目录 `02-附-刀2-隔离面能力清单（待勾选）.md`（用户已勾 ① ② ③ ④ + a b c）

## 目标与范围

**目标**：插件登记的元件**第一次能画出来**——渲染循环接纳「活名单（内置 ∪ 已登记）」；
`host-renderer` 查刀1 组件表、`isolated-surface` 挂现成隔离面；插件件默认**排最后**；
内置两件（`cc-surface` / `cc-send-button` 的注册贡献与在场门）退役（清脚手架）。

**做**：活名单合成纯函数（∪ / 冲突拒绝 / 追加序）；ControlCenter 新增插件件渲染段（含诊断）；
隔离面 I/O 契约（往下递四段 / 往上收三类请求 + 拒绝诊断）；删内置两件与其测试；
`.cc-bg` 的 `data-cc-widget` 常量化。

**不做**：布局键空间 / 拖动 / 编辑列（刀 3）；属性面板（刀 4）；显隐同权与高宽计数（刀 5）；
CSS 与视觉（零改）；后端；刀 1 渲染表结构与内置件渲染循环；#410 域文件。

★ **唯一预期行为变化**：**预览 / 测试环境**的发送按钮从「无」变「有」（注册在场门退役）；
生产不变（本就渲染）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/ccWidgetRoster.ts` | 新增：`resolveCcWidgetRoster()`（活名单合成纯函数：内置 8 行按约定推导 render / 插件件原样透传 / id 冲突与缺 render 拒绝） | 新增 |
| `src/renderers/solid-workbench/input/CcIsolatedWidget.solid.tsx` | 新增：隔离面插件件的宿主接线（`createMemo` 组四段包 / `ResizeObserver` 量尺寸 / 事件分诊与拒绝诊断 / 挂 `IsolatedPluginSurface`） | 新增 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 建注册表信号 + 活名单 memo + 插件件列表；状态区末尾追加插件件渲染段（`.cc-widget` + `data-widget-id`）；`renderPluginWidget` 判别式分诊 + 未命中占位；两条诊断 effect；删两处门（`.cc-bg` 属性、发送按钮 `<Show>`） | 修改 |
| `src/renderers/solid-workbench/input/createCcSources.ts` | 删 `ccSurfaceRegistered` / `ccSendButtonRegistered` 两条读取与接口项（连带删 `getCcWidgetRegistry` import） | 修改 |
| `src/renderers/solid-workbench/input/createCcWidgetRenderers.solid.tsx` | `.cc-bg` 的 `data-cc-widget` 常量化；删 ctx 的 `ccSurfaceRegistered`；改一条描述在场门的过时注释（见「与 spec 的偏差」） | 修改 |
| `src/plugins/product/builtinPylonRenderers.ts` | 删 `registerBuiltinCcWidgets` 的 import 与激活行 | 修改 |
| `src/domains/cc/widgetCatalog.ts` | 整删（内置两件的目录视图/贡献本体） | 删除 |
| `src/plugins/core/cc/builtinCcWidgetPlugin.ts` | 整删（内置插件定义与激活函数；目录随之空置） | 删除 |
| `src/plugins/core/cc/__tests__/builtinCcWidgetPlugin.test.ts` | 整删（被测对象退役） | 删除 |
| `src/domains/cc/__tests__/ccWidgetRoster.test.ts` | 新增：纯函数不变量（∪ 合成 / 冲突拒绝 / 追加顺序 / 缺 render） | 新增 |
| `src/renderers/solid-workbench/__tests__/ccPluginWidgets.solid.test.tsx` | 新增：集成（登记即上屏 / 撤下消失 / 排最后 / 热替换 / 冲突拒绝 / 未命中占位 / 无插件零 DOM） | 新增 |
| `src/renderers/solid-workbench/__tests__/ccIsolatedWidget.solid.test.tsx` | 新增：I/O（四段 + 三类变化重发 / 三类请求生效 / 非法与无会话拒绝） | 新增 |
| `src/domains/cc/__tests__/ccDeadDataGuard.test.ts` | 删「两个内建贡献不带 propertyFields」用例（贡献退役，正控无处可断；其余不动） | 修改 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 两条 contribution 断言改为**定义表行**等价断言（标签 / 容器无 layout / 发送按钮贴输入栏右端+中线） | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 一处断言旧行为的用例按新行为改（预览发送按钮在场）；一处过时注释更新 | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照按规范主动重拍——diff 仅 `generatedAt` 时间戳 | 修改（重拍产物） |

## 方案要点

1. **活名单 = 纯函数**（`domains/cc/ccWidgetRoster.ts`）：输入注册表快照条目（只 type-import
   `plugin-runtime/cc-widget`），输出 `{ entries, rejected }`。内置 8 行的 `render` 由约定推导
   （`{ kind: 'host-renderer', rendererKey: id }`），插件件的 `render` 原样透传；顺序 = 表序 + 传入序。
   拒绝两类：**id 与内置件冲突**（不静默丢）/ **缺 `render`**。插件件之间不会重 id——注册表以
   `contributionId` = 元件 id 保证唯一（重复登记在注册表侧当场抛）。
2. **注册表 → 渲染跟随**：`createRegistrySignal(ccWidgetRegistry, …)`（既有外部 store→信号原语）
   ⇒ 登记 / 撤下 / shadow 热替换都重算名单 ⇒ `<For>` 跟随增删。
3. **插件件落在「状态区末尾」**：`.cc-status-row` 内、状态组之后追加一段
   `<For>`，每件一个最小包装 `<div class="cc-widget" data-widget-id=…>`，**无位置内联样式、不参与拖动**。
   选这里的理由：不加网格行、不挤压固定高度的中控带（`.cc-body` 高度固定，另起一行会从 1fr 里
   扣空间、窄窗有裁切风险）；且同时满足「状态区之后」与验收措辞「状态区**末尾**」。
   无插件登记时这一段**不产任何 DOM** ⇒ 内置件零回归。
4. **两条渲染路**：`host-renderer` 查刀1 组件表（键 = `rendererKey`；未命中 ⇒ `role="alert"` 占位 +
   诊断）；`isolated-surface` 挂 `CcIsolatedWidget`。
5. **隔离面 I/O（施工单 §4 定死）**：往下递四段包（`style` 内置件同源字段 / `size` ResizeObserver
   实测 / `session` 弱状态 / `editing`），`createMemo` ⇒ 任一段变化即产新对象 ⇒ 通道重发 `host:input`；
   往上收三类：`cc:insert` 追加进草稿（上限 2000 字符）、`cc:send` 走既有命令口（无会话 / 提交中 /
   只读 / 空文本拒绝）、`cc:open` 开外链（仅 http/https，大小写不敏感）。
6. **拒绝与未命中不静默**：全部经 `workbench.hostPort?.diagnostics.report`（带 code / message / phase）
   —— `cc-widget.roster.rejected` / `cc-widget.renderer.missing` / `cc-widget.surface.event-rejected`。
7. **非本件契约的事件名一律不认**（含宿主自己的 `host:input` 回灌）——与其它宿主分诊同款
   （`Sidebar.solid.tsx` / `ContextPanelHost.solid.tsx` 只认自己那几件）。见「与 spec 的偏差」第 3 条。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（lint / build:example-plugin / build / check:solid / test） | 全 `EXIT=0`（日志见报告目录 `门禁日志/`） |
| 全量测试计数 | `669 passed \| 1 skipped (670)`；`5229 passed \| 1 skipped (5230)` |
| 契约快照重拍 diff | 仅 `generatedAt` 一行（`2026-10-05T12:09:38.233Z` → `2026-10-05T14:18:46.061Z`） |
| 反向验证（三个新测试逐个改坏） | 3/3 变红并贴红、改回复跑绿（见证据） |
| 登记即上屏（预览实机读数） | 登记 ⇒ 出现在**状态区末尾**；撤下 ⇒ 消失；冲突照旧被拒（见证据） |
| 隔离面 I/O（预览实机读数） | 假 surface 挂载收到四段包；`cc:insert` 落草稿（追加）；`cc:open` 调 `window.open`；`ftp://` 被拒 |
| 无回归（无插件登记） | 状态区不产额外 DOM；内置件相关既有测试全绿（mountSolidWorkbench 102 例等） |

## 测试处置

- **新增**：`ccWidgetRoster.test.ts`（4 例）/ `ccPluginWidgets.solid.test.tsx`（6 例）/
  `ccIsolatedWidget.solid.test.tsx`（4 例）——三条都做了反向验证。
- **删除**：`src/plugins/core/cc/__tests__/builtinCcWidgetPlugin.test.ts`（被测对象退役，显式删除）。
- **修改（逐个点名）**：
  1. `ccDeadDataGuard.test.ts`——删「两个内建贡献不再带登记字段 propertyFields」用例（贡献本体已删，
     正控无处可断）；头注「五项」→「四项」；其余两个用例未动。
  2. `widgetDefinitionTable.test.ts`——两条 contribution 断言（label / defaultPlacement）改为定义表行
     等价断言；删 `widgetCatalog` import。
  3. `mountSolidWorkbench.solid.test.tsx`——「生产中控消费提交模式…」用例里三条断言旧行为的语句
     （预览无发送按钮）改为「预览已在场且 `data-mode="inline"`」；「占区相交的非悬浮件被挡」的说明注释
     按新行为重写（旧注释称预览不渲染发送按钮）。
- 除上述点名项外，无既有测试被改；全量 `5229 passed` 无红灯。

## 证据

- commit：（本单尚未落存档点——等验收）
- 测试：`bun run lint` EXIT=0；`bun run build:example-plugin` EXIT=0；`bun run build` EXIT=0；
  `bun run check:solid` EXIT=0（含两层可达性守卫、CSS 消费审计、边界门禁）；
  `bun run test` EXIT=0，`669 passed | 1 skipped (670)` / `5229 passed | 1 skipped (5230)`。
- 反向验证（红，原样）：
  1. 改坏 `ccWidgetRoster` 的冲突拒绝（改为静默丢）⇒
     `ccWidgetRoster.test.ts:69:29` — `AssertionError: expected [] to deeply equal [ { id: 'input', …(2) } ]`
     （用例：`冲突拒绝：插件用内置 id ⇒ 该登记被拒（不静默、不进名单），内置件逐行不受影响`）
  2. 改坏 ControlCenter 的插件件过滤（不产插件件）⇒
     `ccPluginWidgets.solid.test.tsx:95:96` — `AssertionError: expected null not to be null`
     （用例：`登记即上屏：host-renderer 件画在状态区末尾（查刀1 组件表）；撤下 ⇒ 消失`；另 3 例同红）
  3. 改坏 `CcIsolatedWidget` 的包（去掉 `editing` 段）⇒
     `ccIsolatedWidget.solid.test.tsx:145:41` — `AssertionError: expected [ 'session', 'size', 'style' ] to deeply equal [ 'editing', 'session', 'size', …(1) ]`
     （用例：`（往下递）挂载即收到 host:input 四段；尺寸 / hasSession / generating / editing 变化 ⇒ 重发`）
     三条改回后复跑：3 files / 14 tests 全绿。
- 预览实机读数（`bun run dev` :5173，In-app Browser 真渲染进程，读 DOM + 注册表探针）：
  - 注册表基线 `entries: []`（内置两件退役的直接证据）；`.cc-bg[data-cc-widget="cc-surface"]` 常量；
    发送按钮在场（预期变化）。
  - 登记探针件 `probe.cc-alpha`（`rendererKey: 'tokens'`）⇒ 首个中控状态区
    `['reasoning','mode','tokens','cc-command-hint','model','probe.cc-alpha']`（**末尾**）；
    包装 DOM = `<div class="cc-widget" data-widget-id="probe.cc-alpha"><span class="cc-usage-pill" style="height: 28px; …">`。
  - 冲突登记（id `input`）⇒ 首个中控名单不变、无多出的 input 节点。
  - 撤下（dispose）⇒ 节点消失（`widgetStillThere: false`）。
  - 隔离面探针：surface 挂载进 DOM；收到 15 包 `host:input`，末包 =
    `{ style: {bg:'#ffffff', text:'#000000', border:'transparent', fontSize:12, radius:0, height:28},
       size: {width:0, height:0}, session: {hasSession:true, generating:false}, editing:false }`；
    `cc:insert` ⇒ 输入框草稿变成 `［探针投递］［探针投递］`（**追加**语义）；`cc:open` https ⇒
    `window.open(url, '_blank', 'noopener,noreferrer')` 被调；`ftp://` ⇒ 未被调（拒绝）。
    ★ 该预览面板整体不参与布局（所有元素 rect 均 0×0）⇒ `size` 读到 0/0，属"无布局环境"口径；
    真实布局下的尺寸变化重发由 jsdom 的 ResizeObserver 替身用例覆盖。
- 手工验证：`git status` 改动集 = 上表 16 个文件（无越界、无连带）。

## 与 spec 的偏差

1. **动了 `createCcWidgetRenderers.solid.tsx`**（施工单 §5 边界写「不改」）：施工单 §2 目标 4 与交接话 3
   都要求「`.cc-bg` 的 `data-cc-widget` 常量化」，而该属性恰在这张表里生成 ⇒ 二者只能取其一。
   按「显式变更优先」做了**最小改动**：`.cc-bg` 行改常量、删已死的 ctx 成员 `ccSurfaceRegistered`、
   改一条描述在场门的过时注释；**未动**表结构、键集与内置件渲染循环。
2. **插件件的落点**：施工单 §5 写「状态区之后」，验收 §6-1 写「状态区末尾」；两点取交集 =
   在 `.cc-status-row` 内、状态组之后追加（DOM 顺序上即「末尾」，且不新起网格行）。
3. **非本件契约的事件名（含宿主 `host:input` 回灌）不报错**：初版实现把它当「未知事件」拒绝并诊断，
   被自己的隔离面用例抓到——`host:input` 是宿主经同一 bridge 的下行推送，每次推流都会回灌 ⇒ 会刷屏。
   改为「只认三件契约事件、其余放过」，与 `Sidebar.solid.tsx` / `ContextPanelHost.solid.tsx` 的分诊同款。
4. **`ccWidgetRoster` 多一个 `source: 'builtin' | 'plugin'` 判别字段**：施工单未点名，但渲染层需要
   「只取插件件」；拒绝项另带 `reason` 码（`id-collision` / `missing-render`）供诊断分诊。
5. **「登记先后」的落地口径**：注册表快照按 层/优先级/插件 id/贡献 id 确定性排序 ⇒ 同一插件的件
   天然连成一块，「后登记在更下」在**同一插件内**与传入序一致；跨插件的全局安装时序在纯函数里
   不可得（需要另加序号），本刀不做。若刀 3 需要「真·安装时序」，须显式加状态。
6. **新文件用 `git add -N` 登记意图**：CC-15 两层可达性守卫按 git 追踪面扫描，未跟踪文件不入面；
   为让新符号受守卫覆盖而登记意图（**未 commit、未 push**，索引里只有新增文件的 intent 条目；
   三个删除用 `git rm` 落在索引）。

## 未解问题

- **Tauri 真机未跑**（判断与理由）：本刀生产侧零行为变化（无插件登记时界面与刀 1 逐字节相同），
  而真机内无法注入探针（`dist` 是打包产物，没有 `/src/*.ts` 模块路径 ⇒ 页面拿不到 cc 注册表；
  现网也没有会登记中控元件的插件包）⇒ 真机只能复核「零回归」，已由全量测试 + 预览读数覆盖。
  若要真机复核插件件路径，需先造一个登记中控元件的测试插件包（超出本单文件域）。
- 窄窗下插件件是否被压扁**未实测**（预览面板不参与布局）：插件件不在 `flex: 0 0 auto` 不可压缩组
  （内置件口径），CSS 增规则属 #410 域、本刀不动；建议刀 3 与位置机制一起定。
- `src/domains/cc/widgetDefinitions.ts` 的两处注释仍提到已删的 `widgetCatalog.ts`（表头第 27 行附近
  与 `CC_WIDGET_LABELS` 上方）——施工单 §5 边界禁止改该文件，故未动；建议刀 3 或后续单独清理。
- 预览实机无法读到诊断口（workbench 的诊断端口不暴露给页面），冲突/未命中的**诊断**只在集成测试层
  验证；真机只验了「被拒 = 不出现在界面上」。

## 并行交集

- 本次碰过的共享文件（按我方 L.md 口径）：`src/renderers/solid-workbench/input/`（ControlCenter /
  createCcSources / createCcWidgetRenderers / 新增 CcIsolatedWidget）、`src/domains/cc/`、
  `src/plugins/product/builtinPylonRenderers.ts`、`src/renderers/solid-workbench/__fixtures__/
  workbench-skin-baseline.json`（快照重拍）。
- #410 声明域（`WorkbenchWidgets.solid.tsx` / `ControlCenter.css` / `InputBar.css`）**未碰**；
  L.md 现无 CC-13 条目（刀1 未留条），本刀亦未留条（该文件属公用交流板且需提交，见施工单边界）。
