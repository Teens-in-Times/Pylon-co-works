# Dev Record — #728 聊天、中控与右侧上下文生产化

## 元信息
- issue：#728
- 分支：feat/chat-modern-ui
- 基准提交：4d64e138（主线汇总最终提交范围）
- 日期：2026-11-12
- 署名：Codex

## 目标与范围
用户要求全面增强前端、覆盖全部页面、保留插件化、清偿历史包袱、不留下脆弱测试、不滥用圆角。本分路负责聊天/代码/工具/推理呈现、输入、中控异步控件、右栏；不改 ACP、会话文档结构、消息持久化、虚拟化、插件 contribution id 或主题存储契约；实机发现的显式消息分段错误在主线授权后扩展到 projector 修复。

## 改动清单
| 文件域 | 职责 | 性质 |
| --- | --- | --- |
| renderers/solid-workbench/input/InputBar.solid.tsx | 附件请求归属、单飞、卸载/异常；IME、选择文本复制；命令 aria 关联 | 修改 |
| renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx | 模型/模式/推理 selector 异常与 generation 防陈旧回填；停止失败回写原会话 | 修改 |
| renderers/solid-workbench/chat/{MessageRow,CodeBlock}.solid.tsx、utils/copyFeedback.ts | 复制等待成功再反馈、失败可重试、复用计时清理并移除过期注释 | 修改 |
| components/right-panel/**、plugin-runtime/context-panel/contextPanelSelection.ts | 可点击消息摘要结果、分批显示、索引复位；无 Sheet 仅显式 global 面板；统一实际 shell context | 修改 |
| builtin.pylon-renderers/styles/components/{ControlCenter.css,chat/ChatView.modern.css,chat/InputBar.css} | 阅读层次、克制边界、现代编辑表面、焦点/状态分区、窄窗；删除死 composer 规则 | 修改 |
| builtin.pylon-workspace/styles/components/right-panel/ContextPanel.css | 双行搜索布局、连续摘要结果列表、当前项/键盘焦点、现代右栏留白 | 修改 |
| 对应行为测试 | 见下文 | 修改 |

## 可见页面覆盖
| 表面 | 最终变化 |
| --- | --- |
| 现代聊天 | 24px 方角角色标记；用户与助手统一左侧身份/时间基线，问题保留轻底4px阅读面，助手正文78ch；分组28px/组内8px节奏；推理与工具收为连续执行轨；长词不撑宽 |
| 终端聊天 | 保留连续终端结构，工具头26px、用户行紧凑间距；复制错误可见 |
| 代码内容 | 原有高亮与折叠保留；复制等待实际成功，失败允许重试，完整正文复制不受折叠影响 |
| 输入/中控 | 现代模式是一张编辑器表面加紧凑工具栏，主发送/停止就在输入右下角，整体单一键盘聚焦边界；自然流适应附件/长草稿，窄窗工具栏换行；经典/战术/编辑画布保留插件控件定位与主题字段 |
| 命令建议/队列/附件 | 活动候选 aria-controls/aria-activedescendant；附件按钮单飞且失败可恢复，移除目标至少24px；队列长文本约束 |
| 右侧搜索 | 两模式均使用上下两行搜索（避免260px栏内输入仅剩数像素）；结果摘要可点击定位，默认50条、继续展示；查询改变归零，键盘越过已呈现范围时扩展列表 |
| 右侧关系/插件面板 | 连续列表和清晰分区，原有插件隔离生命周期保留；无活动Sheet不铺上下文空壳，显式global面板仍可用且收到真实null上下文 |

## 方案要点
- 输入附件在打开系统选择器时捕获原会话 UI scope，迟到结果不会串到当前会话；卸载后丢弃结果。取消命令异常同样回写发起会话。
- IME组合中的候选/取消键先交给输入法；textarea存在选区时Ctrl+C保留复制行为，不取消生成。
- 三类中控selector使用请求generation，切会话和卸载使旧请求失效，旧结果不能关闭新菜单或显示旧错误。
- 对确认不存在的非CLI输入CSS整段删除，不保留测试证明死规则仍在。现代/终端共享恒CLI的实际输入，模式样式只在存量插件资产内维护。
- CSS triage：ChatView.modern、InputBar、ControlCenter及ContextPanel具有模式/媒体查询/变量级联，继续由插件持有；新增局部错误文案使用utilities，不新增样式资产或ownership豁免。

## 测试处置
- InputBar.solid.test.tsx：新增5条行为用例（延迟附件跨会话与单飞、异常保草稿、卸载丢弃、IME/选区复制/取消异常、候选ARIA）；移除测试helper不再使用的cli/composer参数。
- WorkbenchWidgets.solid.test.tsx：新增3条（throw可恢复、A→B→A旧请求失效、停止异常回写）。
- MessageRow.solid.test.tsx：新增复制失败重试用例。
- TextBlocks.solid.test.tsx：成功断言改等待真实复制完成；新增异步拒绝不假报成功用例。
- MessageSearchBar.solid.test.tsx：新增IME与无匹配键盘导航2条。
- ContextPanelHost.solid.test.tsx：扩展真实Host Port用例验证摘要定位与查询复位。
- RightRailHost.solid.test.tsx：新增无Sheet上下文不挂载、global保留且真实null上下文2条。
- 删除 InputBar.css.test.ts 全部4条：源码正则锁字体/队列类名/已退役变体，不能验证视觉。
- 删除 composerVisualContract.test.ts 全部5条：只锁已不可达的:not(.cli-mode)材质selector，实际输入恒cli-mode。
- inputFontContract.test.ts 删除2条CSS源码断言，保留5条字段归属、派生同值与变量契约；字体实际跟随/独立/字体加载重测继续由InputBar行为测试覆盖，最终像素由主线WebView2验证。

## 验证证据
- `node node_modules/vitest/vitest.mjs run src/renderers src/components/right-panel src/domains/theme/__tests__/inputFontContract.test.ts`：退出0；92文件通过、1文件跳过；982用例通过、1用例跳过；20.51秒（22:21运行）。既有跳过保留。
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：退出0（主线统一后的全前端配置）。
- 改动组件与测试定向ESLint：退出0。
- 改动域 `git diff --check`：退出0。
- 实机：由主线从最终源码构建并记录，不能将上述jsdom测试当作像素/IPC验收。

## 与 spec 的偏差及并行交集
后续核查追加了selector旧请求、代码复制和无Sheet右栏问题。主线授权扩展ContextPanel.css、字体契约测试；App右栏按钮可用性由主线同步。新增shellContext属性向后兼容，不改插件组件参数。没有提交/暂存其他代理文件。

## 未解问题
最终源码实机布局、不同主题与窗宽的几何验收由主线汇总；未宣称外部Agent IPC在本分路得到实测。


## 最终实机回馈后的收口（22:43）
- 现代样式真正生效层：遗留 `data-msg-style=bubble` 在 `.term-row` 外层又添加16px气泡，造成内层已4px但thought仍像胶囊。现代模式现在清除外层背景/边框/圆角，用户消息只保留单一4px阅读表面；reasoning头28px平面短行，展开正文只保留左细线；工具以底分隔线代替完整描边。没有依据颜色猜测并覆写用户已保存设置。
- 中控默认材质：经主线授权，唯一跨 #607 例外是 `themeFieldDefs.ts` 的 `modelBgColor`、`reasoningBgColor`、`permissionBgColor` 三个默认值由白色改透明；已有显式色值全部保留。`ccControlColorFreePick.test.ts` 改为验证缺省透明与显式白色保留，原有旧枚举迁移等价行为测试继续保留。skin baseline只同步这三字段及生成时间，没有混入生成器发现的其他历史baseline漂移。范围记入L。
- 右栏适用性：`builtinPylonWorkspace.ts` 内置贡献经 `when` 只在匹配agent/file工作区可用；Overview/Runtime/Gateway即使仍有activeSession也不带入旧会话搜索。注册表通用选择器不锁死第三方跨工作区面板，显式global在无Sheet时仍保留；6种上下文的实际selector测试覆盖。
- Markdown吞后文是真实投影错误，非fixture格式：snapshot bridge依次发started/delta/completed，但projector把下一条完整助手消息继续append。现在只有“已完成段之后、sequence更新的显式message.started”开新段；同stream轮换messageId、迟到delta吸收栅栏、乱序和reopen逻辑保留。新3组身份情形（相同/不同/缺席）在live与批量投影都验证原文逐字相等、独立parts、唯一segment、最终非running；snapshot围栏紧贴消息末尾用例验证后文不会进入代码块。
- 消息角色：renderer原来把provider当所有角色sender，用户回显也显示Agent名；现在human sender为user，仍由外观自定义名优先。snapshot通过会话Agent标识显示助手来源，仍保留browser-demo/unverified迁移provenance，不提高历史可信度；DOM挂载测试验证两者名称独立。
- 扩展文件域：`domains/workbench/workbenchProjectorReducer.ts`及测试、`application/agent-workbench/{messageSnapshotProjection,agentWorkbenchSession}.ts`及snapshot回归，由主线明确授权；并行代理无交集。

### 补充验证
- `node node_modules/vitest/vitest.mjs run src/renderers src/components/right-panel src/domains/workbench/__tests__ src/__tests__/replay/agentWorkbenchSession.snapshotBridge.test.ts src/application/agent-workbench/__tests__/agentWorkbenchSession.test.ts src/domains/theme/__tests__/inputFontContract.test.ts src/domains/theme/__tests__/ccControlColorFreePick.test.ts src/plugins/product/__tests__/builtinProductPlugins.test.ts`：退出0；127文件通过、1文件跳过；1308用例通过、1用例跳过；21.11秒（22:42运行）。
- 追加改动全量TypeScript：退出0；追加文件ESLint：退出0；本分路全部文件diff-check：退出0。
- `bun scripts/check-workbench-theme-contract.mts --write`：10内置预设、0自定义、177字段、88变量、15fixtures，验证通过。生成后仅保留授权三默认字段，其他旧fixture漂移未纳入本次。
- 最终WebView2/Vite computed样式、全前端门禁及Clippy由主线统一汇总；本记录不将jsdom当作真实像素验收。


### 深浅色默认最后补充（主线授权）
透明背景搭配旧默认黑字会使深色主题失去对比度，主线授权额外将 `modelTextColor`、`reasoningTextColor` 两个出厂默认改 `var(--text)`；现存gui/terminal预设的显式白底黑字搭配保留，任意用户已保存black/white色值不重写。L、默认契约、skin fixture同步这五个授权字段，其余主题数据不动。

- 最后定向验证：`node node_modules/vitest/vitest.mjs run src/domains/theme src/renderers/solid-workbench/input/__tests__/WorkbenchWidgets.solid.test.tsx src/renderers/solid-workbench/__tests__/settingsPreviewControlCenter.solid.test.tsx`：42文件、294用例全部通过，13.07秒（22:46）。全量 `tsc --noEmit -p tsconfig.json` 退出0；末次授权文件 `git diff --check` 退出0。本分路代码在此冻结。


## 首跑真实Agent与输入焦点截图追加（23:02）
- 主线Tauri实机发现首个新建Agent配置已经active，但runtime尚未启动；Launcher/TabStrip仅按identity相同直接打开，首发报 `agent runtime unavailable`。现所有Agent打开统一经过activateAgentSheet：只有同identity且运行快照connected才直接打开；否则走原有switch事务，等成功再开放，失败保留launcher。同目标并行激活单飞，避免重复启动；不修改后端生命周期。已核实Rust switch_agent对缺失runtime懒建并启动、对已连接同名Agent幂等。
- plugin分路协同将SheetLayout冷恢复判据改为同一个isAgentSheetRuntimeReady，保留只恢复一次语义。Launcher/TabStrip仅修改激活函数，不回退主线ARIA/焦点改动。
- 新行为测试覆盖：零Agent后首个配置自动active但runtime未知、同名启动失败保留启动面板、已连接不发switch、并发同目标只有一次启动、tab同名无runtime先启动。4文件20用例通过。
- 查看用户实际输入截图，蓝色内胶囊来自全局focus-visible的box-shadow与textarea遗留20px半径，旧:focus只清outline没有清shadow。现在textarea所有焦点态为radius0/outline none/shadow none；唯一4px input-row接收键盘可见边界，terminal同样在行边界显示焦点。modern空态外层透明/radius0并隐藏独立投影层，只留输入面。删除互相矛盾的插入光标/光环历史注释及不可达textarea焦点边框规则。
- 无模型时显示「未提供模型」及完整原因，不暴露unconfigured-model；长模型名以实际文本span省略并提供完整title。新增缺能力禁用/提示/不发命令行为测试。
- 最终定向：3文件35用例全通过（23:02，3.21秒）；前一轮InputBar/mount/激活等185用例通过，新增无模型fixture未清预览catalog造成的失败已通过真实空catalog修正。统一tsc退出0，追加源码ESLint退出0，diff-check退出0。
- workspace全域测试发现标题栏并行变动与冷恢复测试fixture两项失败，分别交主线/plugin分路修复；不加console白名单绕过。最终像素与原生首次启动由主线重构建实测。

## 用户要求继续提升设计后的现代工作台重构（23:31）
- 本轮依据用户明确允许界面与交互大幅优化，替换现代聊天及编辑器结构，而非继续叠加圆角补丁。经典/战术语义和插件装载/Host Port不变。
- 现代消息：用户、助手沿同一头像/身份/时间基线；用户问题采用浅阅读面，助手直接进入78ch正文；分组与连续文本分别使用28px/8px间距。推理行与工具执行状态降为安静的连续轨道，工具展开指示与复制状态使用小图标；虚拟化分组标记与layoutPort仍是真值。
- 现代编辑器：一张4px表面内上文下工具栏，内置主操作根据运行/草稿状态分别发送、排队、停止；复用原有send/enqueue/cancel所有权。旧cc-send-button仍注册并由经典/战术与编辑画布使用，modern常态隐藏避免重复主操作。原主题值未迁移或清空。
- 正文与附件自然流：现代正文最低60px、按主题静态高度至少三倍封顶；多行增长后内部滚动，附件与工具栏无绝对定位挤压。ResizeObserver仅在宽度/布局模式改变时重测，卸载解绑；经典固定槽高路径不变。输入焦点唯一边界从旧input-row迁至整个现代control-center，textarea所有焦点态仍radius0/outline none/shadow none。
- 共享WorkbenchSelector只拥有呈现/键盘操作，三个controller保留请求generation与会话命令所有权。触发器显示provider可读名称，模式/思考原始ID转可理解标签；命令仍传原始ID。菜单包含当前选中项并打勾，选择当前仅关闭与回焦；上下/首尾键导航，Escape关闭回焦，Tab从触发器继续正常顺序。未宣告模型不伪造候选。
- 确认LucideIcon按Pascal名称静态解析；复制成功/生成停止/推理开合图标用条件重挂，避免同组件更换name而图案不更新。
- 测试变更：原3条模型菜单测试不再断言隐藏当前项/空盒，占位契约调整为可读标签、当前项aria-selected、点击当前不发命令；保留未宣告不造模型和协商权威断言。新增选择器键盘测试、主操作发/停/排队测试、自然流测高与封顶行为测试。删除ChatView.modern.css.test.ts共2条CSS格式/源字符串断言，由主线CDP读取真实阅读列与输入几何。
- 定向验证：13文件308用例全部通过（23:29，15.78s）；统一TypeScript退出0；新增与修改组件/测试定向ESLint退出0。随后扩大运行1001用例通过/1跳过，失败的两条现代CSS测试已按上述退役；另一条右栏Browser资源的新实现文本预期由其在途owner处理。最终更大范围结果与真实WebView2布局由主线汇总。
- 本轮最终渲染器/字体/默认色验证：`bun run test -- src/renderers src/domains/theme/__tests__/inputFontContract.test.ts src/domains/theme/__tests__/ccControlColorFreePick.test.ts`：88文件通过/1跳过，977用例通过/1跳过（23:32，35.80s）。统一tsc、ESLint、第一方CSS owner检查（20资产/renderer7资产）、本域diff-check均退出0。现代工具栏在任意实际剩余列宽可换行，不依赖整个窗口断点；避免左右栏打开后中间变窄却不换行。

## 实看后的连续工具栏、富内容与终端补齐（23:54）
- 现代toolbar仍出现白cells不是新默认失效，而是已有预设/保存的逐控件背景通过inline写到最终button。现在controller把原背景/字色作为每控件样式参数传入，经典/战术与编辑画布按原值消费；modern非编辑toolbar按一个表面统一透明并跟随全局文字色。不按white/black猜用户意图，不重写任何持久值；这是现代界面呈现规则的明确取舍。usage控件同样统一，移除互相矛盾的旧机器值/inline优先注释。
- 连续助手段落原来隐藏avatar用visibility:hidden，仍占第一grid行24px，叠加组内间距与段落边距形成60–80px空白；现在续行直接使用单正文grid区域并不布局avatar/meta，保留共享左边线与原分组时间契约。
- 富内容实际缺陷：messageSnapshotToWorkbenchEnvelopes仅读取content字符串，semanticParts与contentBlocks全部丢弃。Message现正式声明typed semanticParts，snapshot bridge优先保留并校验typed parts，否则走既有wire block normalizer；legacy标题与parts同时存在时保留标题，镜像纯文本不重复；损坏/未知结构转unknown保留证据，完成空assistant不建空p。两个renderer intersection cast移除。无Tauri journal数据修改，migration/unverified provenance保留。
- 原demo的7种structured内容确实没有成果kind，成果0不能通过位置字段或rawOutput伪造成非0。现在同一demo富内容消息增加真实artifact/document/resource三项，带类型、URI、正文；正文和成果栏都沿snapshot→canonical document读同一份内容，无UI硬编码数量/假状态。
- 双模式验证矩阵：modern/terminal各以真实MOCK_MESSAGES富内容通过生产mount验证list/progress/artifact/document/resource；额外media-only完整消息证明空content不会让媒体消失；快照单测验证原文分界、typed/wire解析、损坏证据与空完成消息处理。workspace分路进一步以相同fixture跑双模式成果投影/预览测试，5例绿。
- 终端具体提升：共享selector可读标签与selected勾，键盘Arrow/Home/End/Escape完整；加轻chevron提示可展开，类别装饰图标仍仅modern。推理折叠箭头、复制完成勾、工具状态单行和富内容都共享。保留mono、26px工具头、命令行输入与既有颜色自定义，不套现代卡片。终端原生视觉及键盘由主线统一实看。
- 再退役workbenchChromeCss.solid.test.ts全部14条过渡CSS字符串门禁：它锁首个规则文本、旧check:solid迁移结构、强制不换行、类名不能出现、旧color表达式；modern实际覆盖后仍多数假绿。替代依据是生产mount行为、布局CDP与样式owner/变量消费门禁，不为新CSS重写字面断言。
- 中间验证3文件147例通过；统一tsc通过，ESLint0错误，CSS变量消费通过（105注入/341消费/365声明，死注入/悬空均0）。最后渲染全域复验结果见后续。
- 最终复验（23:53）：`bun run test -- src/renderers src/__tests__/replay/agentWorkbenchSession.snapshotBridge.test.ts src/domains/theme/__tests__/ccControlColorFreePick.test.ts` 87文件通过/1跳过，973用例通过/1跳过，68.70秒；最后统一tsc退出0。本轮源码冻结，等待主线实机反馈。

## 最后富内容实看与演示重置修正（00:18）
- 实看富内容仍为旧7项并非visualQaData有第二套独立数据；该会话直接复用MOCK_MESSAGES。真实缺口是standard场景忽略demo-reset，仅在sessions为空时种入，导致旧visual会话快照一直留存。现standard与visual共享Sheet重置函数，显式reset重建标准会话/消息/Sheets，普通reload保留编辑；主题与interfaceMode不重置。runtime的首会话也从更新后store读取。新增2条真实seed/store/localStorage行为测试，不另造fixture镜像断言。
- 由真实typed富内容浮出的卡片问题：文件/文档/资源卡以前继承用户消息radius（默认18px）、操作按钮仅声明高度、Markdown正文统一pre原文。现卡片modern4px/terminal2px，预览2px，统一28px按钮/hover/disabled/keyboard focus；沿用既有前景/背景/边框/密度设置与Host capability。图标换现有Lucide线图标，用户消息气泡radius未改。
- document/resource只对声明text/markdown或text/x-markdown的正文复用已有MarkdownContent（含现有安全与代码处理），纯文本与file-selection仍保留字面文本；previewLines/maxHeight仍生效。新增两种kind的真实heading/strong DOM行为及plain文本不误解释行为3例。
- 验证：`bun run test -- src/renderers/solid-workbench/chat/content/__tests__/FileReference.solid.test.tsx src/demo/__tests__/visualQaData.test.ts src/demo/__tests__/chatMockData.test.ts`：3文件24用例全部通过，15.75秒（00:16）。统一TypeScript、上述源码/测试ESLint及本轮diff-check全部退出0。最终构建/全门禁与原生验收由主线汇总；本线冻结。

## 最终原生多Agent恢复回归（00:45）
- 主线真实Tauri在两个Agent各有会话、重启后经Browser返回再切界面模式时，发现二号Sheet正文绑定一号会话。实际链路有两处错误：Browser返回仅focusSheet，SheetLayout随后把旧全局会话写入新owner记忆；switch事务先setActiveAgent触发App聚焦，再广播agent-switched，而App监听无条件清null，抹掉刚恢复的选择。未隐藏binding错误，也未伪造连接状态。
- Browser返回现记录并使用固定resourceReturnSessionId，先activateAgentSheet启动/切换真实运行时，再经openOwnedSessionTransaction复查目标session owner，恢复目标profile并选择后聚焦。失败保持Browser与原选择，按钮单飞且允许重试。旧metadata回落有效owner记忆；已被旧bug污染的跨owner记忆过滤，不根据标题或唯一会话猜恢复对象。Browser已过时React同构/CSS字符串门禁头注释清理。
- App广播监听收敛到registerAgentSessionSelection：只恢复activeAgent+activeProfile双重匹配的有效记忆，没有则null；监听卸载对称。SheetLayout在hydrate与Agent页签归属变化时恢复，只向与runtime身份一致的Agent页签写回同owner/profile的选择。保活正文、左栏、右栏共用经过归属校验的上下文，避免文件资源与正文短暂错配。未水合的未知会话不被误判为其他profile并清除；没有猜测其owner或执行命令。
- workspace分路同时修FileContextPanel关联会话的同类直通路径，采用相同activation/openOwned/profile契约，并补source按AgentContextKey消歧；metadata在离开源页签前捕获，避免同步focus改变取值。
- 行为证据：真实activateAgentSheet/switchAgentTransaction与App事件监听、SheetLayout一起运行，模拟setActiveAgent先聚焦再广播的实际顺序，断言两个Agent会话记忆、正文/左右栏一致；Browser返回与模式变化后再重挂仍不串线，已连接同owner不重复启动。另测跨owner/跨profile坏记忆、Browser异步等待/失败保留/错误上报，以及响应式延迟水合。沿用原测试文件，新增源码仅src/app/agentSessionSelection.ts；无新console白名单。
- 验证：`bun run test -- src/workspace-sheets src/sheets/browser/__tests__ src/components/right-panel/__tests__/FileContextPanel.solid.test.tsx src/application/transactions/__tests__/openOwnedSessionTransaction.test.ts src/application/transactions/__tests__/createSwitchAgentRunner.test.ts`：36文件159例通过，27.27秒（00:43）。完整tsc退出0、上述自有源码/测试ESLint退出0、本域diff-check退出0；File分路另2文件14例/tsc/lint绿。主线负责从最终源码重建原生并复验相同场景。

## 隐藏Agent冷恢复时序最后收口（01:31）
- 主线原生冷启动确认：仅A运行时已连接，隐藏B工作台仍报两次恢复失败，诊断为B runtime unavailable。宿主虽以活动Sheet的Show挂生命周期，但旧isCurrent只比会话id、卸载后仍为true；reloadRef也是永不更新的局部值，不能废止旧重载。
- 最小生产修正仅在AgentRendererSuiteWorkbench：桌面远端生命周期/选择器探测要求活动Sheet、identity owner一致、runtime明确connected；本地sessionRuntime.bind独立保留，隐藏Sheet仍读取并展示canonical journal，不隐式启动Agent。每次激活effect cleanup立即置旧任务失效，isCurrent同时校验当前会话及最新reloadToken；迟到本地读/远端失败不再恢复或安排重试。generic AgentWorkbenchLifecycle缺失status视ready的历史兼容规则、非Tauri生命周期均未改。
- 新原生宿主行为测试不替换Lifecycle或sessionRuntime：使用真实Host Port和canonical仓储边界，通过简单测试Suite消费实际文档。3例验证隐藏B本地正文可读、unknown/connecting不请求ACP、活动且connected仅恢复B一次；隐藏后迟到canonical读不发恢复；隐藏后迟到远端失败不报当前错误/不自动重试。未新增console白名单。
- 定向2文件10例通过；扩大`bun run test -- src/application/agent-workbench src/sheets/__tests__/AgentSheetView.rendererMode.solid.test.tsx src/sheets/__tests__/AgentSheetView.solid.test.tsx src/workspace-sheets/__tests__/sheetLayoutContextLifetime.solid.test.tsx`：13文件143例通过（01:29，22.71秒）。完整tsc退出0，新增测试与宿主ESLint退出0。本轮说明同步《Pylon-模块维护地图》“会话与渲染边界”；最终原生冷启动、A/B切换、B续发与双模式验收由主线汇总。
