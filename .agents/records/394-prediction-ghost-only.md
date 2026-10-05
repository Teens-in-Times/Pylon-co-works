# Dev Record — #394 预测仅在输入框呈现

## 元信息

- issue：[#394](https://github.com/Teens-in-Times/Pylon-co-works/issues/394)，本轮为呈现政策修订，issue 继续保留。
- PR：#564 已于本轮开发期间合并；预测呈现改动通过后续 PR 交付，复用已有分支。
- 分支：`codex/563-journal-malformed`；基线 `9860005c`，协调声明 `a485c104`；代码、文档和本记录在同一后续提交。
- 日期／署名：2026-10-05 / Codex。

## 目标与范围

用户确认原生预测已出现在输入框灰字中，聊天区仍显示「输入预测」卡；明确选择「只显示输入框灰字」，并补充「不保留接受和忽略卡片按钮，但保留行为，比如tab接受」。本轮取消内置工作台的重复卡片及其按钮，沿用输入框接受、拒绝与按实例消费的行为。既有 actions 契约、fork provider 供给等 #394 未完项不纳入本轮。

## 改动清单

| 文件 | 职责区段 | 性质 |
| --- | --- | --- |
| `WorkbenchDocumentSurface.solid.tsx` | 移除预测卡门控，仅为排队命令挂载辅助 slot；payload 不携带 prediction | 修改 |
| `SessionSurfaceCard.solid.tsx` | 排队命令使用独立可访问名称，不进入预测接受键位 | 修改 |
| `mountSolidWorkbench.solid.test.tsx` / `SessionSurfaceCard.solid.test.tsx` | 整工作台与排队命令交互回归 | 修改 |
| `InputBar.solid.tsx` / `session/assistPrediction.ts` | 清理旧卡片同步消费的注释，行为代码不变 | 修改 |
| `coverage/periCoverage.ts` | 覆盖锚点改为输入框呈现 | 修改 |
| ADR-0033 / `docs/说明书/Pylon-项目架构参考.md` | 登记用户新裁决，保留旧决策历史 | 修改 |

## 方案要点

- 输入框继续读取 `document.assist.prediction`，优先级、eventId 消费标记与持久化事实不变。
- 保留 Tab／右箭头接受、空草稿 Enter 接受并发送、Esc／空草稿退格／输入分歧拒绝的既有输入行为。
- 排队命令与文件建议继续展示。排队命令沿用 `assist.prediction` slot 的兼容出口，但只有 `{ files: [], queuedCommand }`，因此不能显示预测文本及接受／忽略按钮。
- 第三方 Suite 主动调用旧预测 slot 的能力保留；本轮变更的是内置工作台默认呈现。

## 验收标准与结果

| 验收项 | 已验证结果 |
| --- | --- |
| 定向行为回归 | mount / card / InputBar 3 files、144 tests passed，exit 0 |
| 完整前端门禁 | `bun run check:frontend` exit 0；667 files、5219 tests passed、原有 1 skipped；生产构建、bundle、文档及隔离检查通过 |
| Solid 类型与边界门禁 | `bun run check:solid` exit 0，包括渲染器 TS 检查、插件 API 与 23 个 hook 锚点全等检查 |
| Clippy 独立门禁 | `bun run check:clippy` exit 0；6 个受管 crate 均 `added: []`；await-holding 17 文件 / 55 处、裸 allow 0 |
| 原生构建 | 前端构建后 `cargo build --manifest-path src-tauri/Cargo.toml --bin pylon` exit 0，dev 构建 2m26s |
| 实机灰字 | WebView2 154.0.4258.53，1200×800、DPR 1；ghost 1 个、6 字、1129.203125×36 CSS px，输入 enabled；预测卡 0、预测按钮 0 |
| 实机 Tab | CDP `webview_key` pressed true；草稿长度 6、逐字等于预测；消费键 `native-1`，ghost 0 |
| 实机 Esc | 新实例 ghost 1；Escape pressed true 后草稿长度 0、消费键 `native-2`、ghost 0 |
| 实机混合排队命令 | ghost 1；排队命令卡 1、含 `/compact`、不含预测文本、按钮 0；预测卡／按钮仍 0 |
| 实机链路与增量日志 | `invoke` 为 function、1+1=2；Tauri host available、hostErrors 0；日志 IPC 返回 5 条数组；交互期间新增 error / exception 0 |
| 自行复审 | 检查消费键、独立事件身份与第三方 slot 兼容；`git diff --check` exit 0 |

## 测试处置

- canonical 总览用例与旧预测卡门控用例改为断言预测卡不存在；排队命令可访问名称由「输入预测」改为「排队命令」。这是用户明确变更的呈现契约。
- 新增整工作台 Tab／Esc 按实例消费及预测与排队命令共存用例，新增 queued-only 卡不响应空预测接受行为用例，共 2 项。
- 键盘用例使用 `preview: false`：设置预览本来禁用输入，不能用它断言可编辑键位。排队事件独立生成 eventId，避免复用预测 eventId 被投影去重。
- 原有 InputBar 接受／拒绝与消费用例保留并通过。

## 证据与复现

- 测试／门禁命令：`bun run test src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx src/renderers/solid-workbench/chat/content/__tests__/SessionSurfaceCard.solid.test.tsx src/renderers/solid-workbench/input/__tests__/InputBar.solid.test.tsx`、`bun run check:frontend`、`bun run check:solid`、`bun run check:clippy`，均 exit 0。
- 实机按 webview2-acceptance 流程，编译当前源码后将 exe / WebView2Loader 放入一次性目录。数据库落在该 exe 下的 `data/`，并显式设置 `WEBVIEW2_USER_DATA_FOLDER` 为该目录下 `browser-profile`；通过进程命令行核对实际 `--user-data-dir`。调试端口 9239。验收结束已按 exe 路径核对并关闭该 Pylon 进程。
- 通过 `pylon-webview2-mcp` stdio 的 `webview_evaluate` 加载当前产物的正式 Suite prepare（先等待 WASM 就绪）、预览服务工厂和正式工作台挂载模块；给服务注入 prediction / queuedCommand 文档，再用 `webview_key` 派发真实 Tab / Escape。截图只作辅助，结论以上表数值为准。
- 一次性脚本、原始捕获和完整输出位于忽略目录 `.agents/spec/`，不提交用户 journal 内容。

## 与 spec 的偏差及未解问题

- 功能范围与 spec 一致。实机使用隔离服务注入预测文档，未启动真实 Peri 或发送网络请求；证明编译产物中的呈现及真实键盘消费，不能据此宣称真实 Agent IPC 全链已经验收。
- 无配置的新实例启动已有 1 条默认会话获取 error；交互取增量 `since_seq: 1` 后 error / exception 为 0。该启动环境问题不计入预测渲染通过结论。
- #394 保持 open：actions 消费契约、已暂缓的 fork provider 等剩余范围继续在原 issue 跟踪。已安装发行程序尚未被本轮替换。

## 并行交集

复用独立 managed worktree，与共享树 #545 两个在途文档隔离。共享说明书与 ADR 的改动只在本分支。#564 已合并，恢复其原说明并为本轮开后续 PR；合并最新 `github/main` 后生产代码无额外变化，原测试证据仍覆盖当前代码。L.md 的本轮在途声明保留，已合并的 #563 声明撤下。
