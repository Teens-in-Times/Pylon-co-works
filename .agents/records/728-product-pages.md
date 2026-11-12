# Dev Record — #728 工具页面与设置外壳生产化

## 元信息

- issue：[728](https://github.com/Teens-in-Times/Pylon-co-works/issues/728)
- 分支：feat/chat-modern-ui；基准：4d64e138；提交由主线统一处理。
- 日期：2026-11-12；署名：Codex。

## 目标与范围

响应「前端的所有页面都要被照顾到」「不要滥用圆角」，覆盖工具页和设置外壳的视觉、窄窗、异步状态与键盘操作。
保留现有插件贡献、sheet metadata、Host Port、主题字段与预设事务。第一轮避让#607设置子组件；后续按用户明确授权改造Agent导入与连接UI，主题数据实现仍未改。

## 页面覆盖矩阵

| 页面/分区 | 检查与最终改动 |
| --- | --- |
| Overview | 第二轮实机反馈后重写：零Agent显示「开始你的工作」、唯一配置入口与三步引导，取消空Agent卡/重复按钮；已有Agent显示68px工作行；最近会话/工作区开放分栏，无外框，空态90px；主区最多1080px；统计轻量文字；去英文装饰，620px容器内合成单列；保留战术模式专属场景。 |
| Runtime | 加正式页头、计数与说明；标注筛选控件名称；读取/失败重试/无日志/无匹配分开；日志详情公开 aria-expanded；重试只刷新快照，保持唯一live订阅，卸载清理；去modern附加圆角。 |
| Settings：模板、全局、侧栏、消息流、渲染器、中控、右栏 | 共享正文/分组/输入/实时预览重新排版；modern去嵌套卡片与投影，分组改分隔线；内容最小宽度归零；容器740px内收起预览，440px内字段换行；每实例预览ID唯一；设置搜索有可访问名称。现有字段与预设值不变。 |
| Settings：窗口、历史保留、配置备份 | 同一正文与表单视觉应用；保留业务组件和既有行为测试，未修改备份/导入/保留策略。 |
| Settings：Agent、会话、Gateway、输入预测 | SettingsCommon统一正文层次；后续重做Agent导入与管理流程、预测连接/高级分层和取消恢复、Gateway管理导航，详见追加记录。会话归属与主题预设事务保持。 |
| Settings：插件管理、Hook诊断、第三方贡献 | 共享设置外壳与region名称；插件管理加页头，用户插件/内置开关优先，运行诊断/进程/配额等收进原生details；延迟操作状态即时显示，拒绝重复操作。 |
| Search | 连续列表代替卡片套卡片；优先显示会话名；加载时不同时宣称无结果；清空/切换/卸载使旧请求失效；失败可原地重试；窄窗口结果两行。 |
| History | 连续列表与可折行元信息；加载、失败、真实空列表分开；失败可重新加载；分页/回放/导出契约保持。 |
| File | 编辑器融入主区，不再漂浮圆角卡片；树/活动/标签2px；标签进入键盘焦点序，左右/Home/End切换，Enter/Space选择，Delete关闭遵守saving禁用。审查FileTree/source guard、Git/编辑/搜索现有路径并跑全file行为测试。 |
| Browser | 工具条/标签条/原生viewport连续排布，移除浮层阴影与外边距；修复For项捕获active导致标签状态不响应；键盘左右/Home/End切换；空态区别启动/失败且使用产品语言，去掉内部WebView生命周期解释。 |
| Docs | 启动状态即时反馈，失败提供重试；单飞与卸载后不写状态；状态使用中文；去掉开发构建命令文案；保留bounds/可见性/模态让位契约。 |
| Gateway | 实例/路由分区2px，输入4px，去胶囊徽标和嵌套投影；表单行可换行；状态动画遵守减动效。实例/路由保存行为测试保持。 |

## 改动清单

- `src/sheets/tabNavigation.ts`：无状态键盘导航，File/Browser共享。
- `src/sheets/{browser,docs,file,gateway,history,search}/`：对应视图、Gateway样式词汇与行为测试。
- `src/sheets/RuntimeSheetView.solid.tsx` 与新测试：日志恢复/详情/筛选。
- `src/components/Settings.solid.tsx`：设置外壳可访问名称与实例ID，移除已过期迁移注释。
- `builtin.pylon-workspace/styles/{adaptive.css,sheets/**}`、`builtin.pylon-gateway/styles/adaptive.css`、`builtin.pylon-shell/styles/components/{Settings,SettingsCommon}.css`：原owner资产内直接调整；无新CSS资产/无新增全局样式入口。
- `builtin.pylon-plugin-manager/panel/pluginManagerPanel.ts` 及测试：布局层次、操作状态、重复提交防护。

## 测试处置与证据

新增行为测试：SearchSheetView.requests、HistorySheetView.loading、BrowserTabStrip、RuntimeSheetView；扩展FileTabBar键盘用例、DocsSheetView失败重试、pluginManagerPanel在途操作与初次加载失败。
未删除/降低既有测试断言；未添加源码字符串或类串快照。

- 工具页全域：`bun run test -- src/sheets/search src/sheets/history src/sheets/browser src/sheets/file src/sheets/docs src/sheets/gateway src/sheets/__tests__ src/plugins/product/packages/builtin.pylon-plugin-manager/__tests__/pluginManagerPanel.test.ts`：50文件、289用例通过，退出码0；本次Runtime新用例随后单独覆盖。
- 设置/Runtime：`bun run test -- src/sheets/__tests__/RuntimeSheetView.solid.test.tsx src/components/__tests__/Settings src/__tests__/settingsDomainNav.solid.test.tsx src/__tests__/settingsCcNavElements.solid.test.tsx`：13文件、44用例通过，退出码0。
- 后续Docs/管理器/File样式复核：3文件、28用例通过，退出码0。
- 类型检查 `bun x tsc --noEmit` 与定向ESLint均退出码0（最终集成门禁由主线记录）。
- 工具日志保存在不入库 `.agents/spec/728-{pages-tests,settings-tests,pages-types,pages-lint}.log`。
- 真实WebView2视觉/几何验收与整体门禁由主线统一执行，本记录不将jsdom结果充作实机证据。

## CSS triage

修改的现有CSS包含mode/容器/媒体查询与跨组件级联，保留在原插件所有权资产内；纯结构变化采用组件utility。没有新增utility覆盖既有CSS的同名属性；modern遗留装饰规则直接删除/调整。

## 并行交集与未解项

经主线授权独占workspace/styles/adaptive.css、styles/sheets/**与shell的Settings/SettingsCommon.css；其它shell/sidebar/global token由主线处理。
不改变#607主题/预设业务，不包含#700剪贴板落盘，不代替真实第三方插件/外部Agent生产验收。

## 实机反馈第二轮

查看主线 `target/qa-728/evidence/overview-modern-first-pass.png` 后确认第一轮仍有大空卡片、英文装饰与重复配置动作，不能作为最终视觉。按上述矩阵重排 Overview JSX 与非战术 CSS，并同步压缩 Search/History 虚线空态。

- 变更后 Overview/Search/History：8文件19用例通过（退出码0）。
- 新增首跑「唯一配置动作 + 三步引导 + 不渲染空Agent卡」行为用例；Overview共9用例通过（退出码0）。
- 本轮触及文件ESLint退出码0；最终截图/几何由主线重新构建后取证，不复用第一轮截图。

## 工具页最终视觉对齐

History/Search/Runtime 统一使用与 Overview 相同的 surface-raised 工作面，侧栏消费 surface-panel；移除 HISTORY/SEARCH/RUNTIME/OBSERVE 的无信息装饰标签与侧栏统计卡框。列表分隔统一 stroke-subtle，去掉 hover 强描边和上下双强线；控件保留独立边界，搜索空态图标去容器框。无根主题token修改。

- 三页回归：7文件11用例通过（退出码0），定向ESLint退出码0。
- 清理第二轮遗留 tactical overview-kicker 死样式；CSS类可达性门禁随后复核。

## Gateway 实机反馈收口

实机发现 Gateway 表单只有 `runtime-filter-input` 锚点而没有实际控件样式，原生 input/select 外观与应用脱节。本轮改为统一36px/13px控件、4px边角、可见label、focus/disabled，路由八字段和实例/凭据表单采用自适应网格。主区统一白工作面，移除 GATEWAY 装饰，统计改轻文字，路由/实例使用弱分线开放分区，空态压缩为简短引导。实例操作增加单飞锁；创建失败保留标识与名称供修正，不再清空草稿。

浏览器演示缺 `gateway_catalog` / `gateway_instances` / instance mutation cases，原 default 分支抛 `Command not found`，造成虚假的「无可用平台」。新增独立 `demo/gatewayMock.ts` 有状态内存模型并接入 mockTauri，仅修浏览器 transport；QQ/微信目录与现有后端契约对应，创建/编辑/停止/删除/凭据状态支持读回，启动返回明确的浏览器连接限制，不伪造真实联网。凭据只更新 configured 状态，不保留值。

- Gateway + mock：4文件22用例通过，退出码0（包含typed client端到端命令路由、CRUD快照、凭据不回传、不可用平台、忙碌防重入、失败保留草稿）。
- 本轮定向 ESLint、`bun x tsc --noEmit`、diff空白检查退出码0；CSS类可达性1264类、不可达0。实机最终视觉仍由主线统一取证。
- Settings.css 与 File 空态最后视觉收口已交主线，避免同文件并发修改。

## Overview 首跑实机错误修复

原 onMount 无条件调用 native `list_persisted_sessions`，零Agent首跑返回 `no_active_agent` 并误报红错。改为同一 identity snapshot 投影「真实agents目录含activeAgent」的请求key；初始占位 `peri` 不满足条件，不发IPC。ready key变化自动重载，清除上一Agent存档；effect cleanup忽略切换/卸载后的成功与失败。对当前ready Agent收到的所有真实错误仍报告，包括 `no_active_agent`，没有按错误码一概吞掉。

检查 scripts 当前门禁未发现 overview structure guard/token 消费方，删除专为该旧门禁保留的 `reportRuntimeError(action, err)` 注释及相关迁移历史注释。两个存档恢复测试补齐真实Agent目录fixture，既有恢复冲突与owner传递断言保持。

- Overview与生产owner接线回归：4文件20用例通过（新增7用例）。
- `bun x tsc --noEmit`、定向ESLint、`git diff --check`全部退出码0。

## 用户追加：Agent 导入任务流与连接设置

用户明确指出整个应用仍缺品味，重点要求改善导入Agent的逻辑和操作，授权导入相关settings源码覆盖原#607避让范围。此轮将原「当前大卡＋重复切换列表＋全部管理表单＋多层候选details」改成任务优先结构：零Agent直接进入添加；候选选择与单一准备面分栏，小于620px自动纵排；主面只显示名称和启动入口，配置/完整报告各独立展开，步骤为确认入口→验证并导入→开始对话。启动异常/待验证/失败/已添加只呈现一处主要状态；失败原因留在主动作旁，高置信未验证导入保留在失败恢复选项。保存后不会抢走当前对话，显式使用才激活。

已配置Agent后置为摘要行，打开对话与管理分开；管理展开状态由面板按id保存，刷新不重置。修复旧探测报告未带imported id时，UI按provider判已添加但激活动作无效的问题：激活同样使用当前注册表解析。手动添加拥有可见label、文件选择自动预填、高级参数按需展开；真实连接验证通过才写配置，失败保留草稿，卸载后的迟到成功不写盘。写盘成功但列表读取失败时保留已创建事实并给重新载入入口，避免重复创建。该GUI规则不改后端#425 agent_create豁免。

连接域其他分区：YAML编辑器原textarea/save没有样式定义，已补统一控件、空Agent说明、保存期间编辑/提交锁；Gateway连接设置增加到平台管理的真实导航；输入预测只默认显示连接字段，高级生成与上下文按需展开，连接测试单飞且字段变更/卸载取消旧请求。Session分区维持从具体会话进入编辑的已有归属契约，未构造第二套会话选择流程。主题/预设/transaction实现未修改。

- 原行为测试随用户实际路径调整：先展开管理/高级配置/扫描报告再编辑；没有删除保存、CAS、默认值、重启、删除、导入/激活分离等断言。
- 新增默认精简、展开入口、手动验证失败保草稿/不写盘、卸载隔离、provider映射激活，以及预测单飞/取消行为测试。
- 定向6文件65用例通过；扩大settings域37文件267用例通过（退出码0）。TypeScript与定向ESLint退出码0。
- 说明同步至 `docs/说明书/Pylon-Agent-检测器.md`；项目架构参考对应旧手动导入描述已告知主线窄改。
- CSS仍在shell原owner资产内：原agent专属块直接重排；候选选择/准备面同一容器响应式契约，无新增全局资产。删除重复切换列表对应死样式；其它工作线在途新类由主线完成扫描集成。

## Agent/连接跨模式矩阵

| 模式/配色 | 代码及行为检查结果 | 实际截图责任 |
| --- | --- | --- |
| modern-gui / light | 候选/准备/管理使用同一语义工作面，36px输入和32px动作；高级与失败恢复按需展开，无固定白色或第二套色板。 | 主线统一实机取证 |
| modern-gui / dark | 文本、输入、主操作、失败消息依赖text/bg-input/surface/danger语义token；既有dark表单适配继续生效。 | 主线统一实机取证 |
| terminal-like / light | 同一流程与字段；候选54px、管理14px纵留白、2px控件、无发光状态点；终端基础输入使用surface-sunken。 | 主线统一实机取证 |
| terminal-like / dark | 与终端浅色相同结构；沿用宿主明暗token，未硬编码亮色底或将现代模式背景复制入终端。 | 主线统一实机取证 |

终端增量直接落在agent专属样式，没有改变共享主题。输入预测的字段使用相同label/36px控件/focus结构，连接与高级分组在两模式里保持同一可操作DOM；YAML编辑器空Agent与保存锁同样不按模式分叉。以上是代码与行为验证，未冒称完成四种实机视觉验收。CSS类可达性审计：1285类、不可达0（退出码0）。

管理页同步修复取消/修改草稿后的旧验证响应竞态：旧结果不能覆盖新的成功/失败提示、启动计划或busy锁，卸载后不发布迟到错误；保存中fieldset禁用。新增两个真实延迟响应测试覆盖取消重测和修改入口重测，不使用样式字符串断言。

- 竞态修复后 `AgentRuntimePanel.default.solid.test.tsx`：40/40通过；TypeScript与定向ESLint退出码0。设置全域此前267/267，新增加的2用例在上述40例中通过；最终全域由主线集成复跑。
