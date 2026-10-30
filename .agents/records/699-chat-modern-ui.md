# Dev Record — #699 现代模式聊天界面生产化

> 入库保留。规格文档（`.agents/spec/699-chat-modern-ui.md`）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#699
- 分支：`feat/chat-modern-ui`
- 提交范围：`9358efbc..06b84544`（`5f7556eb` L.md 声明 + `06b84544` 实现）
- 日期：2026-10-30
- 署名：Miyaki Kumo

## 目标与范围

把 modern-gui 模式的聊天界面从「终端行样式直接复用」提升到生产可用：

- 消息视觉层次：发送者 / 时间 / 同角色连续分组 / 用户气泡 vs 助手阅读列；
- 输入区真实附件能力：文件选择、拖放、chips、移除、发送回填；
- terminal-like 只做小幅改良（间距与按钮对比度），不改行式结构；
- 保留插件化 / 主题 / 虚拟化 / 流式 / 工具卡 / 搜索 / 滚动跟随等既有架构成果。

**不做**：不改 `messagePipeline` 的合并语义与持久化格式；不改 ACP `attachments`（路径数组）线上形状；不动权限弹窗、计划/目标卡、右栏搜索；不在 terminal-like 引入气泡/头像；图片粘贴落盘（需新后端命令，留待后续 issue）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/chat/chatRowPipeline.ts` | `chatRowDescriptorsOf` 增加 `groupStart`/`groupEnd` | 修改 |
| `src/domains/chat/messageTime.ts` | 新增：解析 `message.time`（ISO / `toLocaleTimeString` 文本）→ 本地 `HH:MM` 与时间戳 | 新增 |
| `src/domains/chat/__tests__/chatRowPipeline.test.ts` | 分组断点用例 | 修改 |
| `src/domains/chat/__tests__/messageTime.test.ts` | 解析用例 | 新增 |
| `src/domains/chat/__tests__/displayChainMemo.test.ts` | 描述符新字段的 memo 输入 | 修改 |
| `src/domains/workbench/__tests__/messageListPort.test.ts` | 描述符夹具补齐新字段 | 修改 |
| `src/renderers/solid-workbench/chat/MessageRow.solid.tsx` | 用户行 `.term-user-avatar` / `.term-user-meta` / `.term-user-bubble` / `time.term-row-time`；助手行 `.term-assistant-meta` | 修改 |
| `src/renderers/solid-workbench/chat/PlainMessageList.solid.tsx` | 行容器输出 `data-group-start` / `data-group-end` | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/*` | meta/时间/分组 DOM 断言；虚拟化夹具补齐字段 | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.modern.css` | 新增：modern-gui 专属样式层 + terminal-like 两处微调 | 新增 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css` | 行包装的可选 meta/bubble 基础规则 | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css` | `.input-attachments` / `.input-attachment*` / `.input-attach-btn` | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styleAssets.ts` | 引入 `ChatView.modern.css`（在 `ChatView.css` 之后） | 修改 |
| `src/plugins/product/firstPartyStyleOwnership.ts` | 登记 `ChatView.modern.css`（plugin-scope，`?inline` 随插件回收） | 修改 |
| `src/infrastructure/tauri/attachmentPicker.ts` | 新增：dialog 选择 + drag-drop 订阅端口（Tauri 访问只在此层） | 新增 |
| `src/infrastructure/tauri/__tests__/attachmentPicker.test.ts` | 纯函数与端口降级用例 | 新增 |
| `src/application/agent-workbench/agentWorkbenchCommands.ts` | `pickAttachments` 依赖 + `attach()` 由空实现改为调用端口 | 修改 |
| `src/renderers/solid-workbench/input/InputBar.solid.tsx` | 附件按钮、chips、移除、拖放命中检测、清理 | 修改 |
| `src/renderers/solid-workbench/input/__tests__/InputBar.solid.test.tsx` | chips / 去重 / 发送回填用例 | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 空态断言改为保留附件按钮 | 修改 |

## 方案要点

### 分组与时间

- `chatRowDescriptorsOf` 对 user/assistant/reasoning 行判定：前一行同角色、且时间差 ≤ 5 分钟、且中间无 system/error ⇒ `groupStart=false`；其余行恒为 `groupStart=groupEnd=true`。
- 时间统一走 `messageTime.ts`：真实 `Message.time` 多为 `toLocaleTimeString()` 产物（如 `10:38:05 PM`），也接受 ISO；解析失败则不渲染时间。
- `PlainMessageList` 仅在行容器加 `data-group-start` / `data-group-end`，不改变行内容、不进入滚动锚点与虚拟行几何。

### 行标记

- 保留终端 DOM（`display:contents` 包装）以免终端模式回归；现代模式的盒模型全部由 `ChatView.modern.css` 用 `.app[data-interface-mode="modern-gui"]` 前缀覆盖。
- 用户行改为 grid `"meta avatar" / "bubble avatar"`，气泡右对齐；助手行 `.has-dot` grid `"avatar meta" / "avatar body"`。
- 连续消息（`data-group-start` 缺席）隐藏用户头像、去掉重复 meta。

### 样式层

- 行间距由「行包装 padding」而非 `.term-row` margin 承担：先 `:is(.term-row, .term-row + .term-row){margin-block:0}` 再按 `[data-group-start]` 施加 `--modern-row-gap:20px` / `--modern-inline-gap:8px`，避免与 `--chat-row-gap` 叠加。
- `ChatView.css` 对 `.term-user-meta` / `.term-user-bubble` 设了 `display:contents`，现代规则必须显式恢复 `display`（flex / block），否则 `grid-area` 与气泡盒不生效。
- 附件 chip 在现代模式为 999px 胶囊；工具卡 10px 圆角 + 状态 pill；推理块左 2px 强调边。

### 附件

- 端口 `attachmentPicker.ts`：`pickAttachments()` 动态 import `@tauri-apps/plugin-dialog`；`subscribeAttachmentDrop()` 动态 import `@tauri-apps/api/webview` 的 `onDragDropEvent`，无 Tauri 时返回空清理函数。放在 `infrastructure/tauri` 内以满足 `check-solid-workbench-boundaries` 的禁止 import 规则。
- 拖放落点按 `devicePixelRatio` 缩放后与 `.input-bar` 的 `getBoundingClientRect` 比较，未落在输入区则忽略。
- chips 采用 `mergeAttachments` 按 `id`（即路径）去重；移除与选择后都把焦点还给 textarea。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 同角色 ≤5min 连续消息 `data-group-start=false`；>5min 或中间插 system 为 true | 通过（`chatRowPipeline.test.ts` 分组用例） |
| modern 下用户行含气泡/meta/时间；terminal 下不显示 | 通过（单测 DOM 断言 + 实机计算样式：terminal avatar `display:none`、meta/bubble `contents`；modern avatar 28×28，bubble `display:block`，时间可见） |
| 附件：两个路径 → chips 恰 2；移除 → 1；发送 payload `.attachments` 一致 | 通过（`InputBar.solid.test.tsx`） |
| 1200×800 实机：`document.documentElement.scrollWidth === innerWidth`，消息列不溢出 | 通过（实测 1200/1200，`scrollHeight` 800） |
| 1440×900 实机 | **未取得**：`Emulation.setDeviceMetricsOverride` 在该 WebView2 实例不改变 `innerWidth`（仍 1200），改用 1200 宽探针验证气泡上限 |
| 回归：既有测试全绿；`check:frontend:static`、`check:solid`、`check:clippy` 通过 | 见「证据」 |

实机数值（探针注入真实 stylesheet/引擎，见「证据」）：

- 终端模式：行 padding `[0,8,8,8]`，`--chat-row-gap` 8px。
- 现代模式：行 padding `[0,8,20,8]`；头像 28×28、`border-radius:50%`；气泡 `display:block`、圆角 12px、窄屏 630.7px（900px 宿主）、宽屏恰好封顶 720px（1200px 宿主）；连续行头像 `visibility:hidden`、meta `display:none`；附件 chip 圆角 999px；附件按钮 28×28、圆角 8px；`.input-attach-btn` 与 `--modern-avatar-size` 均能在 CSSOM 中检索到。
- 拖放事件桥：真实 WebView 内 `plugin:event|listen`（`tauri://drag-drop`，label `main`）返回 `listenResult:10`，随后成功 unlisten。

## 测试处置

- 修改 `mountSolidWorkbench.solid.test.tsx`：空态原本断言不出现「添加附件」，现改为**必须出现**。理由：附件是输入区功能件而非装饰，首条消息即可带附件；其余快捷键提示类 chrome 仍不在空态出现（注释已写入用例）。
- 修改 `chatRowPipeline.test.ts` / `MessageRow.solid.test.tsx` / `PlainMessageList.solid.test.tsx`：新增分组与 meta 断言，既有期望值未改。
- 修改 `displayChainMemo.test.ts` / `messageListPort.test.ts` / `issue243.*`：仅补齐描述符新字段夹具，断言语义不变。
- 新增 `messageTime.test.ts`（7 例）、`attachmentPicker.test.ts`（7 例）。

## 证据

- commit：`06b84544`（实现与记录）。
- 测试：`bun run test` → `Test Files 692 passed | 1 skipped (693)`，`Tests 5433 passed | 1 skipped (5434)`，退出码 0。
- 门禁（均退出码 0）：
  - `bun run check:frontend:static`（`check:clippy` 之外的 15 段：lint / csp / canonical-types / retention / export-vocab / ipc / first-party-styles / tailwind-tokens / example-plugin / wasm / build / bundle / solid-smoke / docs / immer）；
  - `bun run check:solid` → `CSS 类名可达性审计通过（类名 1260：可达 1107 / 豁免 153，不可达 0）`、`CSS 消费审计通过（注入 105 / 消费 340 / 声明 360，死注入与悬空引用均为 0）`；
  - `bun run check:clippy` → `check-await-holding: 通过（17 文件 / 55 处）`、各 crate `added: []`。
- 实机：`bun run build` → `cargo build` → `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*"` 启动 `.exe` → `node G:/TEMP/cdp.mjs eval "$(cat G:/TEMP/probe-modern.js)"`。探针脚本在仓外 `G:/TEMP/`，不随提交入库。

## 与 spec 的偏差

- 终端模式的「小幅改良」最终落在 copy 按钮对比度与背景上，**没有**按 spec 给 `.term-row` 加 +4px 间距——`terminalLikeSpacingContract.test.ts` 冻结了 `--chat-row-gap: 8px`，加间距属于改契约而非改良。
- spec 的「正文宽度上限沿用 `readingWidth()`」：现代模式实际用 `78ch` 上限 + 气泡 `min(78%,720px)`，而非读取 `readingWidth()` 变量。
- spec 的 1440×900 实机项未达成，原因见上表。

## 未解问题

- 剪贴板图片粘贴未做：WebView2 粘贴出的是内存 `File`（无路径），ACP `attachments` 只收路径，需要先落盘到应用缓存目录。已登记 **#700**（含 `tauri-plugin-fs` 与 `AppCache` 权限的落点建议）。
- 真实 `Message.time` 只有钟点文本、没有日期，跨午夜的两条同角色消息（23:58 → 00:01）会被判成不同组；影响仅为头像重复一次，未为此引入会话日期推断。
- 无真实 agent/workspace/会话的空档案下，无法实机走通「真实消息行 + 真实附件按钮点击 + 原生拖放落点」；本轮以探针子树 + 事件桥 + 单测覆盖替代。

## 并行交集

- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/*`（`ChatView.css`、`InputBar.css`、新增 `ChatView.modern.css`）
- `src/renderers/solid-workbench/chat/MessageRow.solid.tsx`、`PlainMessageList.solid.tsx`
- `src/renderers/solid-workbench/input/InputBar.solid.tsx`
- `src/domains/chat/chatRowPipeline.ts`（新增描述符字段，下游夹具需补字段）
- `src/application/agent-workbench/agentWorkbenchCommands.ts`（新增依赖 `pickAttachments`）
