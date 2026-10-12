# Dev Record — #566 聊天统一左边界

## 元信息

- issue：[#566](https://github.com/Teens-in-Times/Pylon-co-works/issues/566)；修订已关闭 #412 的逐块居中行为。
- 署名：Codex；日期：2026-10-05。
- 分支：`codex/563-journal-malformed`；范围：`7b521680..HEAD`，复用附属 worktree。
- 用户裁决：“正文和各类卡片左边界统一，整体仍居中”。

## 目标与范围

修复左栏折叠时聊天正文与消息/活动卡左边界分叉。正文、顶层活动、会话卡、计划卡共用居中阅读列，保留固定标记轨、各块限宽、用户前缀/气泡右对齐与嵌套活动缩进。不改变侧栏状态、中控区、输入行为或持久化契约。

## 改动清单

| 文件 | 职责块 | 性质 |
| --- | --- | --- |
| `WorkbenchContent.solid.tsx` | 共同阅读列；计划卡纳入该列；连接线层仍由 `.term` 定位 | 修改 |
| `chat/readingColumnWidth.ts` | 从已激活 kind/Slot 的配置计算稳定列宽 | 新增 |
| `ChatView.css` | 逐块自动居中改为列内起点对齐；移除右侧标记补偿；复制按钮层级 | 修改 |
| `chat/PlainMessageList.solid.tsx` | 更新父容器观察器注释，不改滚动逻辑 | 修改 |
| `mountSolidWorkbench.solid.test.tsx`、`readingColumnWidth.solid.test.tsx` | 正式挂载、配置通知、消息集合独立性、宽度解析 | 修改 / 新增 |
| `docs/说明书/Pylon-项目架构参考.md` | 更新聊天阅读列与侧栏折叠语义 | 修改 |

## 方案要点

1. 原因：760px 正文与 960px 卡片各自 `margin-inline:auto`。WebView2 基线中，聊天可用宽度 960→1200px 时，正文与工具卡的起点差从 68→100px，正文与工具标题差从 49.25→81.25px。
2. 将居中职责集中到共同容器，列内块从同一左边界排布；文字仍左对齐。固定 18.75px 标记轨后的正文/工具标题起点一致。
3. 列宽取激活目录中具有有效 Slot 的 kind 的有效 `maxWidth` 最大值；使用优先 Slot 的已解析配置，其次目录默认值，无有效值回退 960px。不依赖消息集合，不新增偏好；各块继续应用自己的上限。
4. `.term` 保留背景、滚动观察和连接线坐标根。列宽变化由现有行 ResizeObserver / 连接线观察链处理，不新增逐事件全 DOM 扫描。
5. 删除右侧标记补偿后，窄布局复制按钮进入正文覆盖范围。实测按钮中心被 Slot 容器遮挡；只提高按钮层级即恢复命中，生产样式据此补 `z-index:2`。

## 验收标准与结果

| 验收项 | 证据 |
| --- | --- |
| 定向测试 | 3 文件、138 项通过，退出码 0 |
| 完整前端门禁 | `bun run check:frontend`：668 文件通过、1 文件跳过；5223 项通过、1 项跳过，退出码 0；最终复制按钮样式落位后重跑同一门禁 |
| Solid 类型 / 边界 | `bun run check:solid` 退出码 0；新增文件按 pathspec 登记后再跑；CSS 悬空引用与死注入 0 |
| clippy 独立门禁 | `bun run check:clippy` 退出码 0；逐 crate `added:[]`；await-holding 清单 17 文件 / 55 处、裸 allow 0 |
| 桌面构建 | 当前源码前端 build → `cargo build --manifest-path src-tauri/Cargo.toml -p pylon` → 隔离重启；退出码 0 |
| 原始折叠复现 | 1200px 视图、240px 侧栏展开/折叠：列 x=272/120，宽 896/960；左右留白 32/32、120/120px |
| 窄布局 | 700px 视图、240px 侧栏展开/折叠：列宽 396/636；左右留白均 32px；正文宽 377.25/617.25px |
| 反复切换 + 标记开关 | 2 视图宽 × 2 标记态 × 4 折叠态 = 16 组；居中差、行起点差、正文/工具标题差、顶层卡起点差均 0px；聊天横向溢出 0px |
| 气泡 | 用户气泡 right=1080、列 right=1080；气泡宽 569.875 < 列宽 960px |
| 活动树 | 5 张额外卡：workflow/subagent 顶层偏移 0px、depth=1 偏移 24px；process 顶层偏移 0px |
| 复制按钮 | 页面正文滚入视口后，按钮中心命中按钮，未被 Slot 容器覆盖 |
| 新产物 / 桥接 | CSSOM 核对 `.solid-content-kind` 的零自动边距；`typeof window.__TAURI_INTERNALS__.invoke === 'function'` |

## 测试处置

新增 4 项：共同容器覆盖消息/活动/计划、列宽与优先 Slot 配置、无效宽度/无 Slot 的 kind 排除、Host Port 配置通知与消息集合独立性。首个挂载回归在修复前因共同列缺失而失败；修复后通过。既有 CSS / 挂载测试未删减或改契约断言。

## 证据与复现

- 本记录随实现提交；PR / issue 评论附具体提交号与验证结果。
- 定向：`bunx vitest run src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx src/renderers/solid-workbench/__tests__/readingColumnWidth.solid.test.tsx src/renderers/solid-workbench/chat/__tests__/ChatView.css.test.ts`。
- 实机：使用 `tools/webview2-mcp` 连接隔离的 Tauri/WebView2（端口 9239），正式编译的 builtin Solid Suite 与 Slots（75 kind / 71 Slot）挂载设置预览的 canonical fixture；真实 Enter 切换侧栏占宽，`getBoundingClientRect()` 测量。对比共同列左右留白、消息行/顶层卡起点、标记轨后正文/工具标题起点。
- 可用宽度由隔离验收壳的侧栏占宽控制；后续矩阵用 1200/700px 壳宽和 240/0px 侧栏宽。不覆盖实际 Sidebar 偏好持久化或真实 Peri IPC；这轮验收针对正式渲染器布局。
- 控制台以启动基线之后的 `since_seq` 读增量；隔离空库启动已有一次“读取最近会话失败”，布局验收无新增 error/exception。

## 与 spec 的偏差

增加复制按钮层级修复：移除对称标记补偿后暴露的命中回退，由 WebView2 反馈环证实。

## 未解问题

本次对齐目标无遗留。#412 保持关闭并已评论关联 #566；新反馈使用 #566 跟踪，由本 PR 合并后关闭。#563/#394 不在本 PR 的 issue 关闭范围。

## 并行交集

只触碰上述渲染器文件、说明书与 `.agents/L.md` 自己的声明。共享主树的 #545 文档改动未暂存/提交；#410 左栏/中控样式未修改。自审完成，未派发未获授权的子 agent。
