# Dev Record — #266 CC-31 中控/输入栏片死类名清理（18 条三查后删净）+ userTagText 字段退役 + blink 孤儿清理

> 覆盖两张施工单：**单 23**（`23-施工单-CC-31中控片死类名清理.md`，18/19 条死类名删除）与**单 24**（`24-接续单-CC-31userTagText字段退役与blink孤儿清理.md`，死设置项退役 + 孤儿 keyframes 清理），合并落一份。单 23 删除暴露的死注入由接续单收口。

## 元信息

- issue：[#266](https://github.com/Teens-in-Times/Pylon-co-works/issues/266)（CC-31 + CC-31 接续）
- 分支：`fix/cc-31-dead-css-sweep.1`（自 `origin/main @ ac139cd8` 新建，已 `--unset-upstream`）
- 提交范围：**未提交**（用户当次未说推；两单改动叠加在同一工作树，待收线统一 commit/PR）
- 日期：2026-10-05

## 目标与范围

- **单 23**：卡 `待办\中控台CSS生效性审计-待查.md` §8.2 登记的 19 个「生产代码零命中」类名，逐条三查（a 生产源码 / b 拼接值域 / c 测试文档）后删净；预期零视觉变化。
- **单 24**：单 23 删除 `.term-user-tag` 后门禁暴露 `--user-tag-text` 死注入 ⇒ 用户拍板 (b) 字段退役（CC-07 删 11 字段先例）；同单清掉失去唯一消费者的 `@keyframes blink`。
- **不做**：不外扩扫描面；不动 `userTagBg`（3 处活消费者）；不写显式数据迁移（partialize 白名单自然修剪）；不新增测试用例（复用 ccPrunedFieldsGuard 既有断言结构）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `builtin.pylon-renderers/styles/components/ControlCenter.css` | 删 `.cc-edit-overlay`、`.modern-replay-continue` 整条 | 修改（单 23） |
| `…/components/chat/ChatView.css` | 删 8 类名规则（`agent-empty-description` / `term-user-tag` ×3 处 / `term-row-error-detail` / `term-reasoning-elapsed` / `term-cursor` ×2 处 / `term-streaming` / `spinner-stall-probe` / `solid-agent-empty-optimistic` 族 4 条）；`:is()` 摘 `term-diff-head`（3 处）、`term-reasoning-elapsed`、`term-row-error-detail`、`term-user-tag`；删孤儿 `@keyframes blink` | 修改（单 23 + 24） |
| `…/components/solid-workbench/WorkbenchChrome.css` | `:is()` 摘 `solid-control-center`、`tool-call-card`、`permission-card`（活成员 `.control-center` / `.term-tool` / `.interaction-card` 未动）；删 `.solid-workbench-assist` 整条、`.solid-workbench-usage` 分组成员 | 修改（单 23） |
| `src/domains/theme/themeFieldDefs.ts` | 删 `userTagText` 字段行 | 修改（单 24） |
| `src/domains/theme/themeTypes.ts` | 删 `ThemeSettings` 的 `userTagText: string` 类型位 | 修改（单 24） |
| `src/domains/theme/presets/builtin.ts`、`zones/factory/gui-chat.ts`、`zones/factory/terminal-chat.ts` | 出厂预设 `userTagText` 键值对 ×11 行删（`userTagBg` 一字未动） | 修改（单 24） |
| `src/domains/cc/__tests__/ccPrunedFieldsGuard.test.ts` | `PRUNED_FIELD_KEYS` 加 `userTagText`、`PRUNED_CSS_VARIABLES` 加 `--user-tag-text`；名单注释补 CC-31 条目；两处用例标题计数十一→十二、三→四 | 修改（单 24） |
| `src/__tests__/effectivePresetTheme.test.ts` | `BASELINE_FIELD_COUNTS` 第八次按真值重算：10 套各 -1（`176→175` ×6、`64→63` glass、`37→36` ×3）；注释补重算记录 | 修改（单 24） |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 脚本重拍：`themeSettingCount 176→175`、`cssVariableCount 88→87`、28 行 `userTagText`/`--user-tag-text` 删；`generatedAt` 已还原 | 修改（单 24 连带） |

## 方案要点

- **三查方法学**（单 23）：判死活一律 `/usr/bin/grep`（本机默认 ugrep `--include` 语义不同）；拼接家族必须对照值域来源而非只搜字面量。
- **#17 `term-tool-connector-style--dashed` 保留（三查 b 不通过）**：卡 §8.2 的「高置信死」只对照了主题字段链（`themeTypes.ts:33` = solid|dotted|pulse），漏了**渲染器设置链**——`toolRenderKindCatalog.ts` 的 tool.generic「连接线样式」options 含 `dashed`（默认 solid）→ `AgentRendererSuiteWorkbench.solid.tsx` 生产接线 `resolveProductionRenderAppearance` → `toolConnectorProjection.ts` 的 `resolveSolidToolConnectorAppearance` 用 `resolved.connectorStyle` 覆写 → `ToolConnector.solid.tsx` 拼类名。用户选「虚线」即拼出 ⇒ 生产可达，不删。该条是相对卡登记的**偏差**，守卫/卡侧后续由翻译处置。
- **`userTagText` 退役因果**（单 24）：字段无显式 `cssVar` ⇒ 缺省派生注入 `--user-tag-text`；唯一 CSS 消费者是死类名 `.term-user-tag` ⇒ 删除前设置项已无渲染效果，删除后 `check-css-var-consumption` 红暴露。用户拍板整体退役（a 加 noCssVar 留死设置项 / c 回退死类名均被否）。老数据：CC-07 先例，partialize 白名单下次写盘自然修剪，无显式迁移。
- **新守卫断言的防假绿设计**：沿 CC-07 模式，键进 `PRUNED_FIELD_KEYS` 后由「全 src 生产源码零命中 + 不在字段定义表 + 出厂数据零命中」三层既有断言自动覆盖（扫描面排除 `__tests__`/`__fixtures__`，守卫自身字面量不触发）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 单 23：`git diff --numstat` 只含 CSS + 记录 | ✓（3 CSS；记录入库后另计） |
| 单 23：19 条三查对照表落报告 | ✓（仓外 `报告等\23-…\2026-10-05-工作者汇报.md` + 原始 grep 输出） |
| 单 23：删除后复扫 18 类名 CSS 侧全 0 | ✓（逐类 `grep -c` 求和 = 0；#17 保留恰 1 处） |
| 单 24：`grep "userTagText\|user-tag-text" src/` 生产面 0 | ✓（仅剩守卫测试名单字面量与 fixture，均为设计内） |
| 单 24：`grep blink ChatView.css` = 0 | ✓ |
| 门禁五步 | ✓ lint / build:example-plugin / build / **check:solid 复绿**（`CSS 消费审计通过（注入 104 / 消费 336 / 声明 356，死注入与悬空引用均为 0）`，`ZONE_FIELDS … 175 个主题字段`）/ test EXIT=0 |
| 全量用例数 | `Test Files 667 passed \| 1 skipped (668)`；`Tests 5207 passed \| 1 skipped (5208)`，与单 23 前基线 ±0（无新增用例） |
| 契约快照 | `--write` 后真变化：字段 176→175、CSS 变量 88→87、28 行出厂值删；`generatedAt` 已单行还原 |
| 反向验证（§八） | ✓ 红：临时把 `userTagText` 加回 `THEME_FIELD_DEFS` ⇒ 守卫 2 断言红（`CC-07 删掉的字段又回到了生产源码…expected [ Array(1) ] to deeply equal []`；`userTagText 又回到了 THEME_FIELD_DEFS: expected true to be false`，`ccPrunedFieldsGuard.test.ts:128/:133`）⇒ 改回 ⇒ `6 passed (6)` 复绿 |
| 开发记录落库 | ✓（本文件） |
| 实机（翻译复验事项） | 未做：CSSOM 复核 + 设置页「用户标签」组只剩「背景」项 + 消息流抽查 |

## 测试处置

- `src/domains/cc/__tests__/ccPrunedFieldsGuard.test.ts`：**按单子点名修改**——退役名单 + 派生变量 + 注释/标题计数；未新增测试文件或用例。
- `src/__tests__/effectivePresetTheme.test.ts`：**按契约变更点名修正**——`BASELINE_FIELD_COUNTS` 第八次真值重算（红：`claude 键数: expected 175 to be 176`，`effectivePresetTheme.test.ts:141`）；重算用一次性脚本逐套实测后更新，脚本即删。
- 其余既有测试零改动；无新增测试。

## 证据

- commit：未提交（分支 `fix/cc-31-dead-css-sweep.1`，工作树叠加两单改动；收线时一并提交）
- 测试：门禁五步 EXIT 全 0（明细见「验收标准与结果」）；全量 `5207 passed | 1 skipped (5208)`
- 手工验证：实机 CSSOM/界面抽查留待翻译复验（单子 §五 明确非工作者事项）

## 与 spec 的偏差

- 本批无独立 spec（单子即规范）。相对**卡 §8.2 登记**有一处偏差：#17 `term-tool-connector-style--dashed` 未删（卡判「高置信死」，工作者三查 b 证伪——渲染器设置链可拼出该类名），保留并升级，翻译需回写卡与守卫口径。
- 单 24 必读文件提及「themeFieldDefs.ts 的 CC-07 退役字段注释先例」，实际该文件内无此注释（守卫测试才是先例载体）；不影响施工。

## 未解问题

- `term-tool-connector-style--dashed`：设置项「虚线」当前可产出该类名但 **CSS 有对应规则**（保留），行为自洽；若产品层要收掉「虚线」选项另立单。
- `effectivePresetTheme.test.ts` 首轮全量曾报 2 failed（仅 1 个为确定性红并已修），另一个未复现、重跑全绿——疑似渲染器线已知 flake，未定罪。
- ChatView.css「── streaming cursor ──」分区注释在 blink 删除后已空置（其下无任何规则），保留未动，待后续顺手清理。

## 并行交集

- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/`（chat/ChatView.css、ControlCenter.css、solid-workbench/WorkbenchChrome.css）
- `src/domains/theme/`（themeFieldDefs.ts、themeTypes.ts、presets/builtin.ts、zones/factory/gui-chat.ts、zones/factory/terminal-chat.ts）
- `src/domains/cc/__tests__/ccPrunedFieldsGuard.test.ts`、`src/__tests__/effectivePresetTheme.test.ts`
- `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`
