# Dev Record — #545 前端 await 滥用清理（固定休眠 / try 外 return await / await 同步 DOM 方法）

## 元信息

- issue：#545（refactor，本记录随 PR 关闭）
- 分支：`kumo/prometheus`
- 提交范围：`github/main` 合并点（68c57f32）起的一批 pathspec 提交
- 日期：2026-10-04

## 目标与范围

AST 全量审计（`src` 约 1300 个 TS/TSX，脚本 `.agents/spec/await-audit.mjs`）发现的三类 await 误用归零：①固定真实休眠当同步原语；②try 外 `return await`；③await 同步函数（原生 `.click()` 与 `fireEvent.*`）。**不做什么**：不动生产行为契约；不动已论证豁免项（承重睡、#515 有界重试 `waitFor().catch`、`await findByRole(...).click()`、循环内本质串行 await、try 内 `return await`）；不启用 `@typescript-eslint/return-await` / `no-floating-promises` 等 type-checked 规则（存量面未审计，留下作决策）；不碰 Rust 侧（已有 `check-await-holding.mjs`）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/cli/pylonCliDomainPorts.ts` | approval/workspace/sessionConfig 五个 port 的 `return await invoke` ×8 | 修改（去多余 await） |
| `src/cli/pylonCliService.ts` | `approval get/set` 两 case | 修改（去多余 await） |
| `src/domains/appearance/__tests__/settingsChromeStore.test.ts` | `importFreshStore` 动态导入 | 修改（去多余 await） |
| `src/infrastructure/persistence/__tests__/inputPredictionSettingsRepository.tauri.test.ts` | 「影子赢重发在飞期间的用户保存入链串行」用例 | 修改（30ms 休眠 → vi.waitFor 终态条件） |
| `src/infrastructure/persistence/__tests__/customPresetRepository.tauri.test.ts` | 「重发在飞期间的用户变更经桥入链」用例 | 修改（同上） |
| `src/renderers/solid-workbench/chat/__tests__/issue148.parseLatestWins.solid.test.tsx` | 帧节奏用例循环 | 修改（5ms 休眠 → `flushTask()`，判据只需 tick 分离） |
| 其余 15 个 chat/sheets 测试文件 | 40 处装饰性 `await .click()` / `await fireEvent.*` 剥除 | 修改 |

类 3 文件清单：MediaBlock、InteractionCard、TerminalBlock、SubagentCard、WorkflowCard、SearchResults、FileReference、LifecycleSystemContent、DiffDiagnosticContent、PlanGoalContent、TextBlocks、ToolDiffTask、ReasoningStates、MessageRow、GenerationFooter（均在 `src/renderers/solid-workbench/chat/` 下）。

## 方案要点

1. **审计口径**：初判「约 10 处」系 grep 形态漏数（带 `!`、下标、类型断言的 `.click()` 与 `await fireEvent.*` 未覆盖）；按最终模式 `await .*\.click()|await fireEvent\.` 扩扫后实为 **40 处/15 文件**。合法形态 `await findByRole(...)).click()`（await 绑定异步查询）排除，`AgentSheetView.rendererMode` 2 处保留。
2. **类 1 的真终态**：`fakeInvoke.calls` 在**派发时**记录，`setDelay(10)` 对链上每条保存生效——「链长≥2 + 标志已清」在 save#1 完成与 save#2 完成之间存在**瞬态真窗**，`vi.waitFor` 会提前返回，把链尾完成回调泄漏进下一用例（实测清掉了下一用例刚置位的未同步标志）。终态条件定为三合一：链长≥2 **且派发数==完成数**（handler 在延迟窗结束后才执行，可观测完成）**且标志已清**。
3. **类 3 的安全性依据**：涉事组件的 click handler 均同步调用被断言对象（`void props.commands?.execute(...)`、Solid 信号写同步落盘），`await` 是意外的微任务冲刷；既有显式冲刷点（`await Promise.resolve()`、`waitFor`）全部保留。以 `(`/`[` 开头的语句补防御分号（ASI 会把它解析成对上一行返回值的调用/索引）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 受影响 22 个测试文件 | 245/245 绿 |
| 全量 `bun run test` | 5199 passed + 1 skipped（probe），664 文件绿 |
| `bun run lint` | 零输出 |
| `tsc -b` | 退出码 0 |
| AST 复扫 | 类 2 归零、类 3 归零（仅剩 2 处合法 `findByRole` 形态）、类 1 仅剩豁免承重睡 |
| 白名单豁免 | 未新增 |

## 测试处置

无删除、无断言强度变化。时序原语替换：2 处固定休眠 → `vi.waitFor`（终态加强为「派发数==完成数」）；1 处 5ms×N 休眠 → `flushTask()`；40 处装饰性 await 剥除；4 处补防御分号。

## 证据

- 测试：`bun run test` 退出码 0（5199 passed / 1 skipped）；受影响子集 245/245；`tsc -b` 退出码 0；`bun run lint` 零输出。
- 复扫：`.agents/spec/await-audit.mjs` 输出 `return await plain (0)`；sleep 模式仅剩 `agentWorkbenchSession.emptyStateFirstPrompt.test.ts:88`（豁免）。

## 与 spec 的偏差

类 3 由「约 10 处」修正为 40 处（grep 形态漏数，issue 评论区已说明）；persistence 两处 waitFor 条件比 spec 初稿（仅链长）多出「完成数」与「标志」两道判据——实测暴露瞬态真窗后补强。

## 未解问题

- `@typescript-eslint/return-await` / `no-floating-promises`（type-checked）是否启用——存量面未审计，留下作决策（见 issue「不做什么」）。

## 并行交集

- `src/domains/appearance/__tests__/settingsChromeStore.test.ts` 与 #520 收口批 L2 域交叠（仅 1 处两字符改动：`return await import` → `return import`）。
- `.agents/L.md`（在途声明，已随批提交）、`.agents/records/545-*.md`（本记录）；未触碰 #520 批在途的 `decisions/0035`、`records/515` 文件。
