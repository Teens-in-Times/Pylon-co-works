# Dev Record — #735 聊天错误提示关闭与卡片打磨

## 元信息

- Issue #735，关联 #699
- 分支 `feat/chat-modern-ui`，基准 `84a174c1`
- 日期 2026-11-14
- 署名 Codex

## 目标与范围

用户反馈两种模式的卡片都需要打磨，错误弹出后无法清除。本次覆盖文件引用、文档、外部资源、成果和聊天错误提示。

## 改动清单

| 文件域 | 职责 | 性质 |
| --- | --- | --- |
| `InputBar.solid.tsx`、`ControlCenter.solid.tsx`、`InputBar.css` | 输入、首次创建和会话恢复失败共用可关闭浮层 | 修改 |
| `WorkbenchDocumentSurface.solid.tsx`、`LifecycleCard.solid.tsx`、`BuiltinSolidContentSlot.solid.tsx` | 错误卡右上角隐藏入口，按事件过滤工作台呈现 | 修改 |
| `rendererSemanticCommand.ts`、`sessionUiStore.ts` | 校验当前会话文档与事件身份，记录运行期间的会话 UI 隐藏状态 | 修改 |
| `FileReference.solid.tsx`、`ChatView.css`、`WorkbenchChrome.css` | 现代模式轻底，终端模式紧凑分隔行，统一预览与操作视觉 | 修改 |
| 《Pylon-项目架构参考》 | 同步两种模式的卡片呈现与关闭语义 | 修改 |

## 方案要点

- 关闭输入错误后可继续编辑原草稿。下次同样的发送失败重新通知，绑定恢复状态改变后也可提示下一次失败。
- 会话错误隐藏按文档事件 ID，原有诊断数据继续可读。宿主按实际事件来源校验，兼容预览中来源缺省的挂载。当前隐藏记录随进程生命周期结束。
- 文件预览保留 Markdown 或纯文本语义，操作仍由原有资源能力控制。文件卡显式外观颜色继续生效。

## 测试处置

- `InputBar.solid.test.tsx` 扩充发送失败用例，覆盖关闭后草稿、焦点与再次失败。
- `mountSolidWorkbench.solid.test.tsx` 将绑定恢复 CSS 类断言换成行为断言，并验证默认 Slot 与回退都可隐藏错误。重挂后同一错误仍隐藏，新事件可显示。用不同的本地会话 ID 与事件来源复现原生差异。
- `LifecycleCard.solid.test.tsx` 同步关闭按钮的可访问名称。
- `FileReference.solid.test.tsx` 同步背景、边框传入样式的变量。
- `ChatView.css.test.ts` 收窄旧正则，只读取完整的同名选择器规则。原断言会跨过同一行的结束花括号，误将后续规则当作推理区样式。

## 并行交集

工作树中预先存在未跟踪的 `.peri/`。提交使用相应路径。

## 验收结果与证据

| 验收项 | 结果 |
| --- | --- |
| `bun run check:frontend` | 701 个测试文件通过，5,519 个用例通过，既有 1 个文件和 1 个用例跳过。生产产物隔离扫描 223 个 JS assets。 |
| `bun run check:clippy` | 7 个 crate 基线外诊断 0，持锁审计 17 个文件、55 处，裸 allow 0。 |
| `bun run build` 后 `cargo build --manifest-path src-tauri/Cargo.toml --locked --bin pylon` | 两步退出 0，最终原生重建 1m59s。 |
| Windows WebView2，1200×800 | 隔离目录以本地测试 ACP Agent 返回文本、内嵌 Markdown 资源、长 URI 和错误。两模式的关闭按钮均为 28×28，命中实际按钮。输入错误关闭前后，中控 y 与高度分别保持终端 689/96、现代 647/130，草稿与焦点保留。文档、资源及视口横向溢出 0。 |
| 会话错误在原生窗口隐藏 | 终端模式隐藏后切现代模式，旧诊断数为 0。发起第二次请求出现新诊断，按钮可再次隐藏。注入的 Provider 失败仍由日志记录。 |
| 富内容浏览器对照，1440×900 | 文档、资源、成果卡分别实测横向溢出 0。成果卡采用演示会话验证。 |

复验脚本与输出在本地 `target/qa-735/`，原生证据 `native-error-evidence.json` 及 `*-native-error.png`，浏览器对照 `*-demo-bottom.png`。全量日志在 `target/735-check-frontend.log` 与 `target/735-check-clippy.log`。
