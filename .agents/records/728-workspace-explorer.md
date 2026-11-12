# Dev Record — 728 工作资源与会话导航

## 元信息

- issue：#728
- 分支：feat/chat-modern-ui
- 日期：2026-11-12
- 稳定署名：Codex workspace_explorer
- 提交范围：共享工作树分路，由主代理统一精确提交与开 PR；本分路未 stage/commit。

## 目标与范围

把聊天右栏从搜索与不可点击的关联文件列表扩展为实际可浏览的工作资源区；提供会话文件、结构化成果、内置浏览器和搜索。FileSheet 的去留仍由用户决定，本轮保留完整编辑器、保存冲突与脏态守卫。左栏突出当前会话与新建路径。

## 改动清单

| 文件或域 | 职责变化 |
| --- | --- |
| `components/right-panel/AgentContextPanel.solid.tsx` | 默认文件视图；文件/成果/网页/搜索切换；按会话记住资源标签；消费原有 `search-open/query/index` 定位入口 |
| `AgentFileResources.solid.tsx` | 复用 FileWorkbench provider 与 FileTree；聊天内只读预览；编辑进入现有 FileSheet；读取取消与迟到结果隔离 |
| `AgentArtifactResources.solid.tsx`、`AgentResourceMedia.solid.tsx`、`workspaceResources.ts` | 只投影已验证 canonical assistant/tool 输出中的 artifact/document/resource/media；最新版本去重；workspace 自有文字与安全媒体预览 |
| `AgentBrowserResources.solid.tsx` | 真实浏览器状态、标签、错误、网页文本快照及网址导航；复用 `browser.ensure`，不创建或关闭原生浏览器 |
| `ContextPanelHost.solid.tsx`、`builtinPylonWorkspace.ts` | 单贡献显示标题，多贡献保留 registry 切换器；内置 Agent 贡献标题为「工作资源」 |
| `sheets/browser/BrowserSheetView.solid.tsx` | 由聊天资源发起时提供返回对话入口；来源 Sheet 关闭即隐藏无效入口 |
| `sheets/file/FileTree.solid.tsx`、`FileSheetSidebar.solid.tsx` | 中文标题、真实加载/错误、活动分区可访问状态；目录请求返回后再次核对 owner generation |
| `components/sidebar/SessionsPanel.solid.tsx` | 常驻新会话动作跟随当前 workspace；选中语义、自动显露切换目标、折叠 inert、行内按键隔离、工作区弹窗焦点管理 |
| `workspace/.../Sidebar.css`、`ContextPanel.css` | 紧凑项目/会话层级、清楚的选中与动作；连续资源列表与受限宽度的预览 |
| `domains/workbench/sessionUiStore.ts` | 新增 `workspace-resource-mode` 类型键；状态仍由现有会话 UI store 拥有，不引入存储副本 |

## 方案要点

- 文件只读预览不写文件；点击编辑仍经 `openResourceInFileSheet`，完整工作台继续独占保存与切换守卫。当前工作区外的 touched path 不提供无效打开操作。
- 成果不扫描普通聊天正文猜文件名，不从 `rawOutput` 搜集资料，不把用户上传附件误标为 Agent 产物。媒体以 workspace 自有轻量组件呈现，复用现有 `mediaSourceResolver` 协议校验与受控 Tauri asset 转换，不依赖可卸载 renderer 插件的 CSS；HTML 以文字显示，不注入执行。
- Browser Sheet 是已有全局原生 WebView 的唯一 bounds/visibility/close owner。右栏提供浏览与导航入口，页面正文预览使用真实 snapshot。原生页面仍在 Browser 工作台中展示，未宣称把完整 WebView 嵌入聊天右栏。
- 新资源内容依然挂在内置插件的 context-panel contribution 中，第三方 panel/FileWorkbench provider、热替换与卸载沿用既有 registry/Scope。
- 主要布局使用 Tailwind utilities。现有 Sidebar/ContextPanel CSS 涉及主题背景、模式覆写和跨宿主选择器，保留在原第一方 workspace 样式资产随插件生命周期管理；未新增独立 CSS 资产。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 文件预览不写入；切换 owner 后旧请求不能回填 | 新增行为测试通过 |
| canonical 成果选择、版本去重、非成果排除 | 新增纯投影测试通过 |
| 消息快照经生产 bridge/projector 后可在成果栏浏览 | 使用真实 structured demo fixture，两种模式均得到三个成果并显示实际预览文本 |
| HTML 不执行、嵌套媒体复用安全 resolver | 新增 DOM 行为测试通过 |
| 浏览器真实标签/页面正文、合法网址导航、无第二原生宿主 | 新增行为测试通过 |
| Browser 返回来源与来源关闭后的退路 | BrowserSheet 行为测试通过 |
| 会话资源标签记忆、外部搜索联动、工作区新会话与键盘选择 | 行为测试通过 |
| 完整 FileSheet 文件编辑/Git/保存/关闭回归 | 定向完整 file 测试目录通过 |
| 真实截图与原生运行、全量门禁、Clippy | 由主代理统一运行并记录在本 issue 主开发记录；本分路不抢占主代理的浏览器/原生实例 |

## 测试处置与证据

### 模式适用矩阵

| 能力 | modern-gui | terminal-like |
| --- | --- | --- |
| 文件、成果、网页、搜索及会话模式记忆 | 同一组件与数据路径 | 同一组件与数据路径 |
| 资源预览与浏览器返回 | 连续列表、最小圆角动作 | 紧凑等宽列表、零圆角动作 |
| 新会话/当前项目/折叠与键盘交互 | 34px 会话行，浅色选中底与侧标 | 28px 会话行，等宽字体与 inset 侧标 |
| 文件编辑/Git/保存守卫 | 既有 FileSheet 共用 | 既有 FileSheet 共用 |
| 真实布局证据 | 主代理统一 IAB/native 验收 | 主代理统一 native 验收 |

- `vitest run` 覆盖 right-panel、SessionsPanel/Sidebar 行为、browser 与 file 全目录：39 个文件、222 个测试通过，退出码 0。
- 其后新增资源标签记忆、浏览器迟到快照隔离与富成果 DOM 覆盖：right-panel 全目录 + SessionsPanel 最终共 9 个文件、43 个测试通过（23:53:52 起跑），退出码 0；sessionUiStore/ContextPanelHost/纯资源投影另有 3 个文件、14 个测试通过。
- 成果测试从 `MOCK_MESSAGES` 经生产 `messageSnapshotToWorkbenchEnvelopes`、`projectWorkbench`、`collectWorkspaceResources` 进入右栏 DOM，modern/terminal 均断言三项成果及「正文与成果栏读取同一份类型化内容」预览文本。桥接保留 semantic parts 的修复由 chat_workbench 分路完成。
- 主代理已在 IAB 验证聊天内文件树与 README 只读预览；原生与跨模式截图证据归主记录，本分路不把 DOM 测试表述为真实原生页面验收。
- `tsc --noEmit --pretty false`：零错误；本分路源文件与新增测试的定向 ESLint：零诊断。
- 既有 ContextPanelHost 搜索测试改为显式打开搜索，保留 owner 隔离；FileSheet integration 将旧 `EXPLORER` 文案断言改为真实刷新动作出现；SessionsPanel 补新建归属、选中/折叠与按键隔离断言。
- 删除 `FileSheet.css.test.ts`、`BrowserSheet.css.test.ts`、`Sidebar.css.test.ts`、`Sidebar.blocks.css.test.ts` 的 CSS/源码字符串断言；不再把规则排列或具体 utility 拼写当作用户行为。编辑器、导航、焦点与插件生命周期的既有行为测试保留。

## 与 spec 的偏差与未解问题

- 没有删除 FileSheet。建议右栏承接轻量浏览、成果查看与网页上下文；多文件编辑、Git diff/提交、搜索替换与保存冲突适合继续放在完整工作台。用户尚未做删除决定。
- 成果只展示 Agent 实际返回的结构化资源；没有成果时明确空态，不生成演示资产或从文本猜测结果。
- 不支持在右栏执行任意 HTML artifact，也不复制原生 Browser viewport；这些不是本轮已交付能力。

## 并行交集

`builtinPylonWorkspace.ts` 只改 Agent context contribution label；`sessionUiStore.ts` 只加资源模式键。ContextPanel/Sidebar 与主代理初始样式改动共存，未覆盖主代理的 RightRail、全局布局与 SheetLayout 变更。说明书事实与 issue/PR 回写由主代理统一维护。

## 原生首跑补验修复（2026-11-13）

- 主代理 native 验收发现：有会话身份、没有 `workspaceId/legacyWorkdir` 时，右栏仍挂 FileTree 并触发无效目录请求，污染错误中心。`workspaceTargetFromSession` 的身份契约保持不变；仅在右栏把这种目标视为尚未绑定目录，显示正常空态，不挂文件树或开放关联文件读取。
- 绑定目录后正常请求，解除绑定时清除预览；实际有目录的 provider 错误继续由 FileTree 展示并上报。新增 workspaceId/legacyWorkdir 两种往返切换与真实错误保留共 3 例；AgentFileResources + ContextPanelHost 定向 2 文件、13 测试通过（最终 00:10:36，退出码 0）。完整 TypeScript 与两改动文件定向 ESLint 零诊断；主代理重建后补原生验收。

### Browser 状态广播与在途预览

- 主代理原生打开真实 Example Domain 后观察到预览请求结束却不显示正文。代码复核确认右栏把每条 status 广播都递增 generation，足以让同页在途结果失效。Rust `page_snapshot → eval_json_on` 本身不发 status；`set_visible/set_zoom/select_tab` 等会发完整状态，不能把任意 status 都当成导航。
- 仅在 instanceId、活动 tab、URL 变化或离开 ready 时作废快照。同页可见性/缩放/标题广播保持请求和已读正文；活动页面的真实 `BROWSER_PAGE` 加载事件仍作废旧内容，后台页面加载不影响当前预览。保持原生单宿主与 IPC 协议不变。
- `AgentBrowserResources` 定向 1 文件、8 测试通过（00:21:22）：请求中同状态广播后仍显示正文、后台页不干扰、身份/URL/phase 变更拒绝迟到结果、同 URL 活动页加载拒绝旧结果。完整 TypeScript、定向 ESLint 零诊断；实际原生恢复结果由主代理重建后记录。

### 跨 Agent 返回关联会话

- 原生 Browser 返回暴露 owner/会话恢复缺口后，主代理让本分路顺查 FileContextPanel。同类入口原先直接 `selectSession + openSheet`，没有等待目标 Agent 激活；现复用 `activateAgentSheet` 的真实运行时激活与 `openOwnedSessionTransaction` 复查事务，成功后恢复目标 Profile、选择 Session 并打开其 owner Sheet。失败保持文件页和原选择，显示可重试错误；配置选中但未 connected 的同 Agent 也会先激活，不伪造 connected 状态。
- 关联 Session 通过已有 `AgentContextKey` 匹配 touchedFiles，两个 Agent 的同名 source 不互相冒用。不存在本地归属的关联仍展示为外部会话，但不开启猜测性导航。
- 浏览器入口在 `openSheet` 前固定 `resourceReturnSheetId/resourceReturnSessionId/resourceReturnTitle`，避免同步切页改变上下文后记录错误来源；实际返回事务与 SheetLayout/App 恢复由 chat_workbench 分路实现。
- 新增 `FileContextPanel.solid.test.tsx`：跨 owner 等待、失败保留、同 Agent 未 ready 激活、已 connected 跨 Profile 恢复、未知 owner 禁开，共 5 例通过。ContextPanelHost 另补同步切页后返回 metadata 仍指向原会话的行为回归；最终合跑 2 文件、14 测试通过（00:42:22）。完整 TypeScript、四个改动源/测试文件的定向 ESLint 零诊断。
