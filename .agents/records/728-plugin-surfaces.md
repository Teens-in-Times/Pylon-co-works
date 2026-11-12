# Dev Record — #728 插件呈现生命周期与恢复

## 元信息
- issue：#728
- 署名：Codex
- 分支：feat/chat-modern-ui
- 基准：4d64e138（最终提交由集成主线登记）
- 日期：2026-11-12

## 目标与范围
落实用户「保留插件化架构不变」「不要留下脆弱测试」要求。修复前端隔离面和 Renderer Suite 的 DOM、事件与异步生命周期；插件加载、缺失和失败均有清晰状态，默认失败面提供本地重试。未修改公开贡献 ID、mount/unmount 协议、Host Port、数据/后端及样式所有权。

## 改动清单
| 文件 | 范围 | 性质 |
| --- | --- | --- |
| src/plugin-runtime/ui/IsolatedPluginSurface.solid.tsx | keyed 注册条目、状态与 Solid 错误转交 | 重构 |
| src/plugin-runtime/ui/pluginSurfaceSession.ts | 每次挂载的 DOM/bridge/input/cleanup 所有权 | 新增 |
| src/plugin-runtime/ui/PluginContributionBoundary.solid.tsx | 默认错误态重试入口 | 修改 |
| src/plugin-runtime/ui/PluginContributionBody.solid.tsx | 装配缺失进入错误态、默认加载提示 | 修改 |
| src/plugin-runtime/ui/__tests__/IsolatedPluginSurface.lifecycle.solid.test.tsx | 异步生命周期行为 | 新增 |
| src/plugin-runtime/ui/__tests__/PluginContributionBody.solid.test.tsx | 装配缺失的可见错误行为 | 修改 |
| src/host/renderer-suite/rendererSuiteHost.ts | mount 根保留、过期结果保护 | 修复 |
| src/host/renderer-suite/__tests__/rendererSuiteHost.test.ts | 根容器更新与迟到失败 | 新增用例 |

## 方案要点
- 注册条目换身份即换 DOM 根，旧 mount/unmount 即使迟到也只能触及已脱离页面的旧根；桥在 dispose 时立即关闭，迟到事件不能修改宿主。
- mount 兑现前仅记住最新 input；兑现后交付一次，并持续响应后续输入，不因输入更新而重挂。
- 同步和异步挂载/输入回调失败经 Solid owner 进入既有贡献边界。清理失败单独进入 diagnostic，不成为未处理 rejection。
- 错误边界本地重试只重建贡献，不重新激活整个插件、不影响兄弟贡献。
- Renderer Suite 提交时保留原 mount 根，避免第三方更新原容器时写到脱离页面的 DOM；原根的 flex/min-size 约束承接工作台布局。
- 已过期请求的 prepare/mount 拒绝不再覆盖新 active 或 destroyed 状态。
- 本次新增样式均为布局/状态 utilities，无新增 CSS 资产、字面量颜色、卡片圆角或样式豁免。

## 验收标准与结果
| 项目 | 结果 |
| --- | --- |
| 定向测试 | 9 文件、46 用例通过；退出码 0 |
| ESLint（ui + renderer-suite） | No issues found，退出码 0 |
| check:types | tsc --noEmit，退出码 0（22:13 后一次） |
| diff whitespace | git diff --check 定向无输出，退出码 0 |
| 真机几何 | 留主线统一验收当前构建，尤其 Renderer Suite 根容器 |

## 测试处置
- 新增 IsolatedPluginSurface.lifecycle.solid.test.tsx：input 等待收敛、热替换迟到 mount、sync/async 失败重试、输入回调失败、async teardown 失败。全部用可控 Promise/可见 UI/事件断言，无固定睡眠或源码字符串断言。
- PluginContributionBody 两项原「缺少 props/surfaceId 静默空白」预期改为可恢复错误；原真实 bundle 隔离测试保留。
- RendererSuiteHost 新增挂载根更新、过期 prepare 拒绝、destroy 后迟到拒绝三项行为测试。
- 预期故障测试逐项断言 console diagnostic，不扩大测试全局白名单。

## 证据
```text
bun run test -- src/plugin-runtime/ui/__tests__ src/host/renderer-suite/__tests__
Test Files  9 passed (9)
Tests       46 passed (46)
Duration    3.91s

bunx eslint src/plugin-runtime/ui src/host/renderer-suite
ESLint: No issues found
```

## 与 spec 的偏差
额外修复 Suite 挂载容器被丢弃：旧实现把 children 搬走，插件保留的 mount 根失联；新增行为测试验证原根持续连接。无公开契约变化。

## 未解问题
第三方从 mount 返回 Promise 前自行创建的外部资源仍须插件自己负责；宿主无法取消插件内部任意异步操作。宿主在这些操作返回时保证回收，不宣称是恶意代码沙箱。

## 并行交集
仅上述 plugin-runtime/ui 与 host/renderer-suite 文件域。全量门禁、说明书同步和真机由 #728 集成主线合并记录。

## 追加：启动、恢复与全局通知页面

主线派发补齐全页面覆盖后，本线另接 `src/kernel/{KernelRoot,KernelRecoveryLayer,ApplicationMount}.solid.tsx`、`src/components/ErrorCenter.solid.tsx`、`src/components/kernel/SkinPreviewBar.solid.tsx` 及对应四个行为测试文件。未改 bootstrap/application runtime/错误存储与恢复协议。

- 启动、降级、安全模式、应用卸载与崩溃恢复统一为有标题、说明、细边界与明确动作的页面；替换 Prism 旧品牌与裸露实现术语。技术错误默认收进详情，失败扩展列表独立滚动、窄窗换行。
- lazy Application 载入时显示加载状态，消除空白；崩溃页只重新加载当前应用子树。
- ErrorCenter 的恢复动作在执行期间禁用并显示忙状态，阻止重复提交；Escape/关闭按钮把焦点送回通知入口，隐藏不改变错误事实。摘要与动作分行；App.css 的换行/高度约束由主线同步。
- 皮肤预览条改为可换行的小圆角工具栏，高级 JSON 编辑默认折叠，校验状态用中文；无效草稿禁止确认，提交失败留本地提示。
- 新增行为测试：恢复单飞、Escape 回焦、lazy 状态、崩溃重试。更新启动标题断言与高级详情展开操作，原 bootstrap startNormal 恰一次/先有恢复界面的时序断言保留。

验证：`bun run test -- src/components/__tests__/ErrorCenter.solid.test.tsx src/components/kernel/__tests__/SkinPreviewBar.solid.test.tsx src/kernel/__tests__/ApplicationMount.solid.test.tsx src/kernel/__tests__/KernelRoot.bootstrap.solid.test.tsx`，4 文件 / 22 用例通过，退出码 0。对应组件/测试 ESLint 与 `bun run check:types` 均退出码 0。最终视觉几何由集成主线实机统一验收。

## 实机告警取证（独立浏览器）

主线浏览器曾报告 4 条 Solid owner warning。本线在独立 headless Edge / 独立 user-data-dir / CDP 9338 对 `http://localhost:5173/?demo-scenario=standard` 捕获完整 `Runtime.consoleAPICalled`：冷启动 20 秒、terminal-like 模式、319×850 → 1280×850 resize、reload 后均未复现 warning，聊天与上下文实际渲染。只观察到 Vite 连接消息，证据 `target/qa-728/owner-probe.log` 和 `target/qa-728/owner-probe-terminal-resize.log`（仓外构建输出，不入库）。测试浏览器已关闭。该证据不宣称原浏览器的告警已修复；须由原告警堆栈继续定位，不通过压制 warning 或推测性增添 createRoot 处理。

### 后续定位与修复：keep-alive SheetContext 的 owner

主线从原浏览器取得实际堆栈：`createComputation → createMemo → solid-js/web memo → SheetLayout 的 ctx getter → SheetHost ctx → BrowserSheetView.syncBounds → browserSheetEffects callback`。独立 profile 没有保活 Browser 页，因此先前冷启动未复现。

根因是 `SheetLayout` 在 JSX `ctx` 属性里嵌套条件表达式与对象构造，编译后 getter 内含延迟 memo。原生 resize/定时器读取 `props.ctx` 时不在 Solid owner 内，从而反复新建不可回收 computation。

修复：每个 `<For>` keep-alive 槽位在其 owner 内创建 `sheetContext = createMemo(...)`，JSX 仅传 `ctx={sheetContext()}`。所有 agent/file/browser 共享正确所有权，未在 Browser 消费点压制告警或包无归属 root。

新增 `src/workspace-sheets/__tests__/sheetLayoutContextLifetime.solid.test.tsx`：异步 owner 外重复读取身份稳定、活动/背景切换和左栏折叠仍响应、unmount 后快照停止更新。定向联动 `sheetLayoutSidebarCollapsedReactive` / `sheetLayoutSidebarKindSwitch`，3 文件 / 5 用例通过；ESLint 与 diff whitespace 检查通过。原浏览器 reload 的最终无告警读数由集成主线登记。

主线已在原 IAB tab reload 后复验 `Runtime.consoleAPICalled`：warning / error 均 0 条，确认原 owner 堆栈问题消失。SheetLayout 同步删除已过期的 React 对照注释，保留当前 Solid 快照/保活所有权说明。

### 自审跟进：事件解订幂等

主线自审发现：旧事件组的 unsubscribe 被再次调用时，可能删除同事件名的新监听组。`pluginSurfaceSession` 的解订现为幂等，并在删除组前校验 registry 当前仍指向该组。新增行为用例执行「解订旧组 → 注册新组 → 再次调用旧解订 → emit」验证新监听仍收到事件；自身解订后不再收到事件。最终针对 UI 生命周期与 SheetContext 的 5 文件 / 20 用例通过，ESLint 与差异检查通过（22:42）。

## 追加：窄窗真实轨道预算

主线 IAB 实看发现 900×680 请求窗口在 120% 缩放后仅有 750 CSS px；左栏 250、正文最低 360、右栏 320 同时展开，右栏越出 viewport 被裁切。新增 `domains/workspace/railLayout.ts` 纯几何策略：按 CSS viewport 预留正文 360 与 shell 间距 32；两栏可共同容纳时按各自弹性部分收窄，否则保留当前优先栏，另一栏进入真实折叠态。默认左栏优先，用户点击自动收起栏的展开按钮会切换临时优先级。自动调整不改持久化展开偏好，放大自动恢复原宽度与展开状态。

App 统一派生 effective layout，传入 SheetLayout、标题栏与右栏；Skin 左轨道、SheetContext sidebarCollapsed、aria-expanded、inert 和拖拽手柄共用同一结果。无法容纳任何最小栏宽时按钮明确提示放大窗口。左右拖拽的起点使用实际显示宽度，上限扣除当前另一栏与正文预算，避免拖拽重新制造横向溢出。未加 CSS 伪隐藏规则。

行为验证覆盖 750 / 667 CSS px（900 / 800 物理窗口且 120% 缩放）、共同压缩、用户切换优先栏、放大恢复、无贡献不占轨道、拖拽上限、右栏 inert/Tab 序与标题栏按钮。定向 8 文件 / 39 用例通过（22:56），`bun run check:types`、全 src ESLint 与差异空白检查退出码均为 0。实际浏览器和重新构建后的 WebView2 几何由集成主线复验登记。

并行联动：接入 chat_workbench 提供的 `isAgentSheetRuntimeReady`，冷恢复时身份相同但 runtime 未连接仍走统一 activateAgentSheet；保留单次冷恢复护栏，避免将持久化身份误判为已启动会话。

主线 IAB 后续几何复验：750 / 667 / 1000 CSS px 均未越界；667 右栏优先时右宽 275、正文 368，1000 放大后恢复左右 250 / 320。

## 追加：界面与设置菜单标签消失

用户截图中的菜单是 WorkspaceTitlebar 的 app-menu。主线实际计算样式确认：modern-gui 下 domain-item 仅 31.992px 宽，grid 三列为 21.9922px / 0px / 11.9922px；item-copy 与 strong 均 0px，文字颜色与可见性正常。根因是窗口控制 `.workspace-window-controls button` 后代选择器命中嵌套弹出菜单，modern 模式将其宽度覆盖为 32px。

App.css 将窗口按钮规则限定为 `.workspace-window-native-controls > button`，既有 `.workspace-titlebar-icon` 继续负责应用图标；同步修正合并菜单后的最小宽度选择器为 `data-menu-kind="app-menu"`。保留现有菜单 TSX、焦点恢复与键盘行为，未添加 CSS 文本快照。修后主线 IAB 四个 domain row 宽 238.37px / 高 51.22px，copy 宽 173.36px，文字恢复；最终 native CDP 截图由主线统一登记。

会话恢复测试夹具同步说明真实前提：该套件测试 session hydration，先将 peri runtime 设为 connected，避免新冷启动就绪判据对不完整 fixture 发起实际激活并报 console.error。未压日志。菜单/标题栏与会话恢复 3 文件 / 21 用例通过（23:01），定向 ESLint 与 diff whitespace 检查退出码 0。

左栏可访问性检查：现有样式对折叠 `.sidebar` 及其全部后代明确设置 `visibility:hidden`，并非仅宽度归零或依赖继承。实际折叠控件 focus 探测交由主线同轮 native 验收；在未证明缺陷前，不引入观察器或改变插件侧栏 DOM 契约。

## 原生验收跟进：离线 Docs 资源路径与失败状态

2026-11-13 主线最终原生验收发现 Docs 子 WebView 返回 `docs asset not found`，外壳却报告就绪。核实 `tauri.conf.json` 的 bundle.resources、发行脚本与 `docs/说明书/Pylon-发行包清单.md` 均使用 `resources/docs-site/`；开发产物也实际位于 `src-tauri/target/debug/resources/docs-site/`。旧 resource.rs 直接将 `docs-site` 拼到 Tauri resource_dir，少了一层 resources。

修复只涉及 `src-tauri/src/docs_sheet/resource.rs` 与 `mod.rs`：按完整相对路径定位，不增加旧路径回退、不复制资源；start 在创建子 WebView 前验证首页可读且非空，失败写 Error 状态并返回现有前端加载失败/重试流程。检查仅在启动时运行，不对每个静态资产重复读取首页。说明书相应表述与本线规格已同步。

新增 Rust 行为测试构造 portable / target-debug 两种真实临时资源树并验证 HTML、JS 响应，放置旧顶层 docs-site 诱饵证明不会误读；另覆盖缺失、空入口失败与修复后重试。既有穿越、clean URL 与缓存策略测试保持。前端原有失败重试/导航恢复/原生可见性与尺寸同步测试 1 文件 / 4 用例通过；`cargo fmt --check -p pylon` 和 diff whitespace 检查退出码 0。定向 Rust 测试命令：`cargo test --manifest-path src-tauri/Cargo.toml -p pylon --lib docs_sheet -- --nocapture`；Clippy 与新二进制原生页面复验由主线统一运行。

Rust 定向结果（00:18）：12 passed，997 filtered out，执行 0.05s，退出码 0；上述资源路径与入口 preflight 两例均包含在内。

## 原生验收跟进：浏览器事件监听生命周期

主线在冷启动观察到两条 `unregisterListener` 读取 handlerId 失败；Agent 来回切换则出现 browser-status 的 callback id 丢失警告。核实当前 Tauri 2.11.6 源码：webview::listen_js 将页面注册脚本入队即返回 eventId，注册 Promise 完成不等于页面监听表已经落位；SDK unlisten 先读该条目的 handlerId 并移除回调，然后才调用后端 unlisten。前一窗口可能抛错并中断后端注销，后一窗口允许已排队事件访问已移除的回调。工具注入脚本只注册自己的回调，无覆盖 SDK 监听表的代码；本次只读取函数验证，不操作验收 UI。

应用侧重复注册来自两处：AgentBrowserResources 每次挂载独立订阅 status/page；browserSheetEffects 又把原生订阅放在依赖 isActive 的 effect 中，每次切 Sheet 重建。新增 `infrastructure/tauri/browserEventFeed.ts` 工厂与窗口单例：两个固定事件各一个原生监听，消费者只增删本地回调，没有消费者时不投递、也不注销原生监听；事件入口不保存 Agent/session 数据。BrowserSheet 的活动态状态探测与本地订阅分开，保留各 owner 请求代际和原生视图生命周期。单消费者异常送日志后继续其他消费者，显式 feed dispose 用于整个传输生命周期关闭，不由视图触发。

runtimeEventClient 同时消费 SDK 实际返回的异步 stop Promise，注销失败送 frontendLogSink，停止投递仍立即且幂等。此项是诊断完整性修复，不宣称修复 Tauri SDK；未吞错、未加时延、未读写生产环境私有监听表。其他事件的生命周期没有扩大重构。

验证：浏览器套件、Inspector、event client/feed 共 10 文件 / 36 用例通过；随后再补「原生注册未 settle 时视图退出」用例，feed 5 用例通过。覆盖固定 listen 计数、零消费者、重新订阅、多消费者独立退订、单消费者失败隔离、显式生命周期关闭后的迟到事件、两个 async-stop 拒绝分支和 Browser Sheet 活动切换不重订。`bun run check:types`、定向 ESLint、diff whitespace 检查退出码 0。最终新二进制冷启动/Agent切换的原生日志复验由主线统一执行。说明书浏览器资源段已同步该窗口级事件契约。

## 原生性能验收跟进：浏览器状态反馈回路

主线确认监听与冷恢复修复后，继续在 Browser 加载网页再返回 Chat 的路径捕获性能异常：MCP 请求从小于 1 秒增长到 10–25 秒，事件序号数分钟增长到约 12 万；原生网络中 browser_set_visible(false) 约每 2ms 重发。源码闭环为 set_visible 无条件 emit_status → applySnapshot 写入新对象 → effect 直接读取 snapshot().phase、追踪整份对象 → 再次 setVisible。set_bounds 不广播状态，但同样被状态对象更新重复触发；工具 inspectPage 的嵌套 snapshot 读取也会扩大 effect 依赖。

最小修复仅在 browserSheetEffects：将 phase、isActive、sidebarCollapsed、overlay 投影为标量 memo；副作用使用 on 显式依赖，隔离 syncBounds/inspectPage 内部读取。状态探测只响应真正的活动态变化，保持 undefined 与 false 的既有区别。界面仍消费完整状态，未吞事件、加延时或修改 Rust 广播语义。

新增 4 个行为用例以最多 8 次广播模拟原生命令回执，旧反馈环会使调用次数断言失败而不挂死测试；同时覆盖活动态/覆盖层/阶段改变、未指定活动态、无关 ctx 更新、真实 resize、侧栏折叠和工具快照刷新。浏览器与事件 feed 定向合计 9 文件 / 27 用例通过，`bun run check:types`、定向 ESLint 退出码 0。说明书已补充副作用精确依赖契约。完整门禁、重建和原生空闲 IPC 频率复验由主线统一执行。
