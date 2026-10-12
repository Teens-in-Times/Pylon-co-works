# Dev Record — #266 CC-23 拆分件：中控区背景面恢复（cli-mode 透明规则清退）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-266-cc23-cc-surface-restore.md`

## 元信息

- issue：[#266](https://github.com/Teens-in-Times/Pylon-co-works/issues/266)（CC-23 拆分件；总账回写合并后做）
- 分支：`feat/cc-23-cc-surface.1`（基于 `origin/main @ 950d3bd5`）
- 提交范围：`950d3bd5..<head>`（L.md 在途条目 `19841381` + 本单代码提交待开 PR）
- 日期：2026-10-07
- 施工单：仓外 `E:\Acode\FILES\任务\工作台优化\CC-23-中控区背景面恢复\01-施工单-中控区背景面恢复（cli-mode透明规则清退）.md`

## 目标与范围

**目标**：删掉 ControlCenter.css 里 cli-mode 对 `.cc-bg` 的强制透明，让「中控本体面」整组设置（背景色 `ccBg` / 背景图 `ccBgImage` / 透明度 `ccSurfaceOpacity` / 圆角 `ccRadius` / 边距 `ccMarginX/ccMarginBottom`）的视觉效果恢复由设置驱动。

**不做**：不动预设值与字段默认值（裸默认 `#808080` 灰面板、终端默认 20% 白玻璃现形是**预期结果**，值审议是下一件）；不动其它 cli-mode 规则；不动设置 UI；不动 `src-tauri/`；不新增测试。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css` | CLI mode 段：删除 `.control-center.cli-mode .cc-bg { background:transparent; }` 整行（原 213 行） | 删除（1 行） |

## 方案要点

- 根因：`.control-center.cli-mode .cc-bg { background:transparent; }` 是建仓快照时代遗留，而中控恒带 `cli-mode` 类 ⇒ 该规则恒生效，把 `.cc-bg` 主规则的 `background:color-mix(in srgb,var(--cc-surface) var(--cc-surface-opacity),transparent)` 压成透明——设置值其实都在生效（变量注入、几何都对），只是面不画就看不见。
- 修法按用户拍板：**只删这一行**，不加替代规则。用户定案原话：「真要透明有透明度设置项，不用这个，这又算单独预设」。
- 契约快照验证：`bun scripts/check-workbench-theme-contract.mts --write` 后 diff 仅 `generatedAt`（删规则不改变量/字段面），验证后已还原该 fixture，未入库。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（lint / build:example-plugin / build / check:solid / test） | 全绿：`EXIT=0` ×4；test **681 文件 / 5311 用例 passed**（1 skipped），与单子基线 ±0 |
| 既有测试零改动预期（workbenchChromeCss 钉的 cli-mode 块内 inset 与 is-empty 隐藏） | 绿，零改动 |
| 契约快照 diff | 仅 `generatedAt`，无其它变化 |
| 实机 a 背景色活 | `#ff0000` → computed `color(srgb 0 0 0)` → `color(srgb 1 0 0)`，目视红色面板可见（截图）；已改回 `#000000` |
| 实机 b 透明度活 | 0 → `color(srgb 0 0 0 / 0)`（面消失）；0.2 → `/ 0.2`（color-mix 半透生效）；1 → 全显；滑条停在原值 1 |
| 实机 c 圆角/边距现形 | `ccRadius` 25 → computed `border-radius:25px`（目视圆角）；`ccMarginX` 15→40→15 → margin-inline `15px/15px → 40px/40px → 15px/15px` 双侧跟随 |
| 实机 d 背景图活（可选） | 设 `file:///…/src-tauri/icons/icon.png` → computed `background-image:url(…)` 生效；清空恢复 `none` |
| 实机 e 预设现形对照 | 当前态为「自定义」（`--cc-surface:#000000` 黑面板，记录）；点 ccBg「恢复默认」→ `#808080` → computed `color(srgb 0.502 0.502 0.502)` 灰面板现形（后改回黑）；终端默认 = `src/domains/theme/presets/builtin.ts:187` `ccBg:"rgba(255,255,255,0.20)"`，20% 白玻璃机制由 b 项 0.2-alpha 数值证明 |
| 实机 f 编辑模式不回归 | 进入布局编辑器 → `.control-center` 带 `cc-editing`、`.cc-bg` computed `opacity:0.5`；「退出编辑」后回 `1` |

## 测试处置

- 新增：无（一行 CSS 删除；实机验收担纲，单子 §7 明示）。
- 既有：零改动、零删除。

## 证据

- L.md 在途条目提交：`19841381`（`chore(cc): #266 CC-23 开工 L.md 在途声明（中控区背景面恢复）`）。
- 门禁：`bun run lint` / `build:example-plugin` / `build` / `check:solid` 均 `EXIT=0`；`bun run test` 结尾行 `Test Files 681 passed | 1 skipped (682) / Tests 5311 passed | 1 skipped (5312)`，`EXIT=0`。
- 实机：本仓 `src-tauri/target/debug/pylon.exe` 重新构建（前端 `bun run build` → `cargo build` → 重启，三步齐全；CSSOM 核对被删规则已不在任何样式表中、color-mix 主规则在计算值里实际生效）。读数与复现命令详见仓外报告 `2026-10-07-工作者汇报.md`。
- 未 commit、未 push、未开 PR（等翻译核验 / 用户指示）。

## 与 spec 的偏差

- 无方案偏差。一处执行口径说明：契约快照 `--write` 产生的 `generatedAt` 变更按「改动文件边界」在验证后还原，未提交——快照的通过性证据在报告里。
- 实机验收中为恢复用户界面状态，经历了一次「进入布局编辑器 → 非正规退出」的往返（详见「未解问题」第 1 条），最终以编辑列「退出编辑」按钮正规退出并核验全部还原。

## 未解问题

1. **布局编辑器退出路径疑似状态缺口（单子外发现，未自修）**：在布局编辑器 sheet 内以匹配「退出/关闭」语义的按钮离开后，工作台 `.cc-editing` 类残留（`cc-bg` opacity 0.5 挂着），须再经编辑列「退出编辑」按钮才能退净；且进入布局编辑器时原有 sheet tab 被关闭、需手动重开。是否为缺陷、属哪张单管，待分流。
   - **后续（2026-10-07，接续单 v3）**：第一条已修复——关闭工作台类 sheet（kind `'agent'`）经「端口 + 接线」清 `ccEditMode`（见下方 v3 节）；第二条「进编辑器关设置页 tab」按用户未表态维持现状。
2. 预设/默认值审议（裸默认灰面板、终端默认 20% 白玻璃现形后的取舍）= 用户明说的下一件，本单不处理。

## CC-23 接续单 v2/v3 节（2026-10-07）

### 缺陷与两轮方案冲突结论

- 缺陷：编辑态下直接关 sheet 标签 × ⇒ `ccEditMode` 全局标志残留 ⇒ 重开任何会话，新挂载的中控直接带 `.cc-editing`（背景 opacity 0.5）。清位出口原只有「退出编辑」按钮与 Escape 两段式；关 sheet 出口没人清。
- **v1（作废）**：宿主卸载清理（`onCleanup` + 清位）。实机实锤冲突——布局编辑器不是独立 sheet，是工作台中控凭全局标志显示的编辑态；「进入布局编辑器」= 置位 + 关设置页，**依赖标志跨宿主卸载存活**（keep-alive 恢复必经一次卸载重挂）⇒ 卸载清理必伤进路径（编辑态进不去；实机 14 连读数全 false 对照旧态在场）。
- **v2（作废）**：workspaceStore 关闭动作族直调 `useThemeStore.setCcEditMode(false)`。行为正确（单测 5 条 + 反向验证全过），但 `check:solid` import 环门禁红——`workspaceStore → themeStore` runtime 边使 `{hydrateIdentityAndWorkspace, themeStore, workspaceStore}` 成 runtime 环（环门禁豁免基线只收 type-only 环）。
- **v3（定稿）**：按仓内既有「端口 + 接线」形制（`workspaceActiveAgentPort` / `workspaceActiveAgentWiring` 母本）解耦——
  - 新端口 `src/domains/workspace/workspaceSheetClosePort.ts`：`notifyAgentSheetsClosed()`，**未注册 = no-op**（与 activeAgentPort「未注册即抛错」有意不同：通知类端口，漏装配后果是行为回归而非数据损坏，且抛错会炸掉所有不装配接线的既有关 sheet 测试；装配由组合根保证，漏装配由接线端到端测试钉住）。
  - `workspaceStore.ts` 三关闭动作壳（closeSheet / closeOtherSheets / closeRightSheets）在「被关集合含非 pinned 的 kind==='agent'」时调端口；**不再 import themeStore**（v2 直调删除）。
  - 新接线 `src/app/bootstrap/workspaceSheetCloseWiring.ts`：注册端口 → 读 `theme.ccEditMode` ⇒ `setCcEditMode(false)`；装配 = `App.solid.tsx` 组合根 side-effect import（与 identityCrossDomainWiring / workspaceControllerWiring 同链，:27）。
  - kind 字面量定案：工作台类 = `'agent'`（会话现场 tab；FileContextPanel.solid.tsx:49、useAgentCandidateProvisioning.solid.ts:197、workspaceStore.ts:186 先例），设置类 = `'settings'`（settingsSheetNavigation.ts 的 SETTINGS_SHEET_KIND）。pinned 不过滤=不关（与 sheetState.closeIds 一致）。

### v3 验收与实机读数

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | 全绿 EXIT=0；**check:solid 绿（环已消）**；test **683 文件 / 5318 用例 passed**（= 01 单后基线 5311 + 车净增 7；含域侧 5 条改写 + 接线端到端 2 条） |
| 反向验证（域侧，kind 判别取反） | 6/7 红：`workspaceStoreCcEditExit.test.ts:42:33 / :52:37 / :62:33 / :70:37`、`workspaceSheetCloseWiring.test.ts:37:49 / :46:49`（pinned 用例对 kind 取反不敏感——其钉 pinned 过滤）；改回复绿 7 passed |
| 反向验证（接线缺失：删 register 调用） | 接线侧「关 agent sheet ⇒ ccEditMode 复位 false」红（`workspaceSheetCloseWiring.test.ts:37:49`，AssertionError: expected true to be false）；域侧仍绿（spy 自注册）——证明「漏装配由接线端到端测试钉住」；改回复绿 |
| 实机 §5-b 进路径安全 | 进入布局编辑器后 t=100ms 起 `.cc-editing=true`、`.cc-bg` opacity 0.5，8 连读数稳定（对照 v1 冲突态 14 连全 false） |
| 实机 §5-a 核心修复 | 编辑态下真实点击关会话标签 ×（→ 主页）→ 重开 `session-mu81i40f` → 中控 `.cc-editing` 不在、`.cc-bg` opacity = **1**（零残留） |
| 实机 §5-c 既有出口 | 编辑列「退出编辑」→ editing=false、opacity=1；Escape 两段式：第一击清选中（`cc-selected` 1→0，编辑态保留）、第二击退出（editing=false、opacity=1） |

### 与 spec 的偏差

- v3 按定案形制落齐，无方案偏差。两处现场说明：①域侧测试引入 `productPluginTestBootstrap`（`isSheetKind` 要求 kind 已在 workspaceRegistry 注册，否则 `createSheetState` 过滤一切——v2 轮踩过，v3 已注释说明）；②实机验收结束时 Pylon 保持运行（含 01+v3 全部修复），交还用户使用。


## 并行交集

- `.agents/L.md`（在途条目已单独提交；合并后撤条目）。
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css`（本单唯一代码改动）。
