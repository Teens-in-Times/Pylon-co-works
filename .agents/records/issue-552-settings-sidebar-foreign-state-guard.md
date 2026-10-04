# Dev Record — #552 设置侧栏对异 kind sheet state 无守卫（切走瞬间抛 TypeError 炸更新波）

## 元信息

- issue：[#552](https://github.com/Teens-in-Times/Pylon-co-works/issues/552)
- 分支：`kumo/prometheus`
- 提交范围：单提交（守卫 + 2 个回归测试文件）
- 日期：2026-10-05

## 目标与范围

用户报「进设置界面后侧栏还是 agent sheet 的侧栏」。本批做三件事：

1. 实机定位该观感与一处应用级崩溃的同根因；
2. 修复 `SettingsSheetSidebar` 对异 kind state 的无守卫读取；
3. 落回归钉（组件级 + SheetLayout 级）。

**不做什么**：不改 `SheetSidebarSlot` 的响应式 prop 结构（#520 keyed Show 语义保持）；不动 #520 已修的「切 kind 组件滞留」主体（用户构建 0.3.6-FIN 早于 1f086bc4，属旧构建缺口）。

## 排查结论（用户报修的主体）

- 用户实机（`F:\A-I\Platform\Pylon\pylon.exe` 0.3.6-FIN，10-03 13:10 构建）**早于** #520 的修复提交 1f086bc4（10-03 15:28）。该构建上「进设置侧栏滞留为 agent 侧栏」可稳定复现（webview2 MCP 实测：tab=设置、`.layout > aside` 仍 `agent-sidebar`、`.settings-sheet-nav` 不存在）。
- 当前源码在 SheetSidebarSlot/SheetHost 均已按组件身份 keyed Show 重挂（#520），组件级与 SheetLayout 级测试均绿；实机（vite dev + 浏览器 mock，当前源码）双向切换矩阵全绿（见证据）。
- **本批新发现的残余缺口**：settings → agent 切换的更新波中，旧设置侧栏的响应式读取吃到 agent 形状 state → `SETTINGS_DOMAIN_BY_ID[undefined]` → `.sections`/`.label` TypeError → 炸整条更新波（实机抓到崩溃堆栈，落 SettingsSheetSidebar chunk）→ 旧侧栏滞留乃至应用崩溃屏。这是与 #520 正交的第二层缺陷，即 #552。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/sheets/SettingsSheetSidebar.solid.tsx` | `activeDomainConfig()`：`SETTINGS_DOMAIN_BY_ID[domain] ?? SETTINGS_DOMAINS[0]` + 缘由注释 | 修改 |
| `src/sheets/__tests__/SettingsSheetSidebar.foreignState.solid.test.tsx` | 异 kind state 容错 2 用例（响应式切片 + 直接脏挂载） | 新增 |
| `src/workspace-sheets/__tests__/sheetLayoutSidebarKindSwitch.solid.test.tsx` | SheetLayout 级 agent↔settings 互切回归钉（宿主链路 + keep-alive 同场） | 新增 |

## 方案要点

- 守卫落在**读取处**而非 codec：`settingsSheetState.ts` 的 normalize 本就保证合法 domain，非法值只能来自 slot 响应式 prop 的异 kind 瞬态（或脏持久化）——两种来源都该在消费点兜底，回落第一域与 `normalizeSettingsIntent` 的精神一致。
- 未改 `SheetSidebarSlot`：state prop 对同 kind 更新必须保持响应（设置侧栏的激活分区/插件页高亮依赖它），按挂载时 kind 钉死 state 会把同 kind 导航更新一起钉死；守卫后异 kind 瞬态最多渲染一帧回落域，随 keyed Show 重挂消失。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 目标测试（6 文件 33 用例） | ✅ 全绿（foreignState / sheetLayoutSidebarKindSwitch / sheetSidebarSlot.switch / SheetInternalSidebars / settingsSheetState / settingsSheetNavigation） |
| foreignState 用例反向验证 | ✅ 撤守卫 2 用例红（精确复现实机两条崩溃消息），恢复后绿 |
| `bun run build`（tsc -b + vite build） | ✅ |
| 实机矩阵（当前源码，vite dev + 浏览器 mock + 真实鼠标事件） | ✅ 冷启动 agent 激活侧栏正确；agent→设置 `.settings-sheet-nav` 互斥切换；设置→agent ×3 无崩溃；多轮往返无滞留 |

## 测试处置

- 新增 `SettingsSheetSidebar.foreignState.solid.test.tsx`（#552 回归钉，2 用例）。
- 新增 `sheetLayoutSidebarKindSwitch.solid.test.tsx`（补 #520 回归钉的宿主链路盲区：原 `sheetSidebarSlot.switch` 只测 Slot 单体，SheetLayout 的非键控 Show 包裹 + keep-alive 同场未覆盖）。
- 未修改/删除既有测试。

## 证据

- 实机崩溃堆栈（修复前，0.3.6-FIN）：
  `Prism Desktop crashed: TypeError: Cannot read properties of undefined (reading 'sections') at get each (SettingsSheetSidebar.solid-*.js)` 及 `(reading 'label')` 同源第二条。
- 反向验证（守卫撤除后单测输出）：`TypeError: Cannot read properties of undefined (reading 'sections')` / `(reading 'label')`，与实机两条一致。
- 实机矩阵（修复后，DOM 类锚点断言）：
  `{toAgent: {aside: "sidebar agent-sidebar", tab: "Peri\\Default"}, toSettings: {aside: "sidebar settings-sheet-nav", tab: "设置"}, toAgent2: {aside: "sidebar agent-sidebar", ...}, crashed: false}`；冷启动→进设置→溢出菜单切走同款。
- 用户构建与修复的时间线证据：`pylon.exe` FileVersion `0.3.6-FIN`、LastWriteTime `2026-10-03 13:10:10` < 1f086bc4 提交时间 `2026-10-03 15:28:12`。

## 遗留与备注

- 用户侧升级到含 1f086bc4 + 本批的构建后两项症状（滞留 / 崩溃屏）一并消失；0.3.6-FIN 无前端热修通道，只能整包更新。
- 共享工作树备注：排查期间 `src-tauri/` 有他人在途 ACP 重构（#548/#549），Rust 侧 `cargo build` 暂不可用，本批为纯前端改动不受影响；G 盘一度 100% 满（target/debug 31G）导致一轮 vitest ENOSPC，清理前请勿并发全量构建。
