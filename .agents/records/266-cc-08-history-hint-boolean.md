# Dev Record — #266 CC-08 历史快捷提示开关布尔化（三头归一）

## 元信息

- issue：#266（CC-08）
- 分支：`fix/cc-08-history-hint-boolean.1`（base = origin/main `b089c026`，已 `--unset-upstream`）
- 提交范围：未 commit（用户未指示，工作者不 commit）
- 日期：2026-10-04

## 目标与范围

把「显示历史快捷提示」（`inputShowHistoryHint`）设置项的字段定义从 `shown/hidden` 枚举归一为真布尔，与存储类型 / 读盘归一化 / 渲染读法三头对齐——设置页控件变正常开关、**开关关得掉**；老数据存过的 `'hidden'` 读盘纠偏为关。同族另一坏字段 `inputShowPlaceholder` 已随 CC-07 删除，本件只剩这一条。

不做：不动 `appearance.ts` 读法（`!== false`，布尔输入下行为等价）；不动 `InputBar.solid.tsx` 消费点；不动通用归一化跳过名单其余三键（`inputFocusRingEnabled` / `inputShadowEnabled` / `toolIndicator` 各有豁免理由）；不动出厂数据 6 处 `true` 与 `themeTypes.ts` 类型（已是布尔）；不碰 `src-tauri/`；不做顺手优化；不删测试。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/themeFieldDefs.ts` | `THEME_FIELD_DEFS.inputShowHistoryHint` 定义行：`S(...)+optionLabels` → `B(...)`；`normalizeThemeState` 跳过名单注释块删该字段行、continue 行删该键 | 修改 |
| `src/domains/theme/migration.ts` | `normalizeThemeValues`：兼容行改写为 `!== false && !== 'hidden'`，并**上移到 `normalizeThemeState` 通用 pass 之前** | 修改 |
| `src/domains/theme/__tests__/migration.test.ts` | 新增用例「inputShowHistoryHint 布尔化：老枚举值读盘纠偏」（4 断言）；import 增 `alignThemeStructure` | 修改 |
| `src/domains/theme/__tests__/themeFieldCopy.test.ts` | 「关键枚举」清单移除 `inputShowHistoryHint` + 补注（字段仍在，只是归布尔） | 修改 |
| `src/plugin-runtime/skin/__tests__/skinValidation.test.ts` | `'shown'` 断言「应过」→「应拒 invalid-type」；用例标题与两行注释同步 | 修改 |
| `.agents/records/266-cc-08-history-hint-boolean.md` | 本记录 | 新增 |

## 方案要点

- 三头不一致中唯一的「枚举头」是字段定义（`S(...)`），其余三处（类型/存储、读盘归一化、渲染读法）全是布尔 ⇒ 归布尔是改动最小的自洽解（用户 2026-10-04 拍板，卡顶 09-23「暂缓」解除）。
- **上移坑（本单最容易踩）**：类型改 boolean 后该键不再被通用归一化跳过；通用 pass 的 boolean case 会把非布尔（`'hidden'`）先兜成 default `true`，兼容行若留在通用 pass 之后拿到的已是 `true`，纠偏失效。故兼容行必须先于 `Object.assign(state, normalizeThemeState(state))` 执行——先落定为真布尔，通用 pass 原样放行。
- `'shown'` 经 `!== false && !== 'hidden'` 归 `true`，无需单独处理。
- 皮肤 schema 该字段从「布尔或枚举皆收」收紧为「仅布尔」（仓内无第三方皮肤，不垫兼容）。
- 渲染端零改动：`themeFieldRenderer.solid.tsx` 的 `case 'boolean'` 分支现成。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `git diff --numstat` 只含 5 文件 + 记录 1 新增 | ✓（5 文件，见证据报告） |
| `grep inputShowHistoryHint` themeFieldDefs.ts ⇒ 仅定义行 1 命中且为 `...B('cc',` | ✓（286 行） |
| 兼容行位于 `normalizeThemeState` 调用之前 | ✓（sed -n 段落回带于证据报告） |
| 新用例绿（4 断言）；themeFieldCopy / skinValidation 修改后绿 | ✓（4 文件 31 tests） |
| 反向验证红已贴（最小形态） | ✓（`migration.test.ts:134`） |
| 门禁五步 EXIT=0 | ✓ 全五步 |
| 全量用例数 = 开工基线 +1 | ✓ 5198 → 5199（5197 passed + 1 skipped + 1 todo） |
| 契约快照 `--write` 后 diff | 见下方「契约快照连带」——不止 generatedAt，已按单指令 `git restore` |
| 开发记录落 `.agents/records/` | ✓（本文件） |
| 实机验收（设置页控件开关形态 / 关掉后历史快捷提示行消失 / 重启保持） | 翻译复验事项，非工作者范围 |

### 契约快照连带（超出单子「仅 generatedAt」预期的部分，原样回带）

`--write` 后 fixture 另有两处值变更（已 `git restore` 还原，**未入库**）：

```diff
-  "generatedAt": "2026-10-03T12:03:42.482Z",
+  "generatedAt": "2026-10-04T10:35:12.046Z",
-        "inputShowHistoryHint": "shown",
+        "inputShowHistoryHint": false,
-        "inputShowHistoryHint": "hidden",
+        "inputShowHistoryHint": true,
```

机理（非异常）：`workbenchSkinContract.ts` 的 `boundaryValue`——边界夹具对 select 取首/尾选项（min=`'shown'`、max=`'hidden'`），对 boolean 取 false/true。新契约下 min/max 自然变为 `false`/`true`，两处变更是契约变更的直接连带、语义自洽。但该 fixture 不在本单「改动文件」清单内，工作者不越界——已还原，待翻译/用户决定是否随本单补入库（下次任何人跑 `--write` 都会再现这两处变更）。

## 测试处置

- `migration.test.ts`：**新增** 1 条用例（4 断言：`'hidden'`→false、`'shown'`→true、false 保持、true 保持）；import 增加 `alignThemeStructure`。
- `themeFieldCopy.test.ts`：**改** `expectedOptions` 移除 `inputShowHistoryHint`（契约变更：字段不再是枚举）+ 补注。
- `skinValidation.test.ts`：**改** 「select 非法选项报错；select+boolean default 的历史字段接受 boolean 或枚举」→「select 非法选项报错；已布尔化的历史字段拒绝枚举值」（`'shown'` 断言「应过」→「应拒 invalid-type」+ 注释同步）。
- 单子「候选关注」四文件：`themeSchemaV8Backfill.test.ts` 实跑绿；`ccSettingsGrouping.test.ts` / `widgetDefinitionTable.test.ts` / `ccPrunedFieldsGuard.test.ts` grep 无该字段命中，全量绿。
- 其余测试不改不删。
- **开工基线自带 1 红（与本单无关）**：`agentWorkbenchSession.terminalDelivery.test.ts:82`（`elapsedMs` expected 0 to be greater than 0，node-shared），单独复跑 14 条全绿 ⇒ 时序 flaky。全量复跑时该文件也绿。

## 证据

- commit：未 commit（用户未指示）
- 测试：门禁五步命令与输出、反向验证红/绿全文 ⇒ `E:\Acode\FILES\任务\工作台优化\报告等\21-施工单-CC-08历史快捷提示开关布尔化\2026-10-04-工作者汇报.md`
- 反向验证（最小形态）：用例 `inputShowHistoryHint 布尔化：老枚举值读盘纠偏 > hidden → false；shown → true；布尔值原样保留`，删 `&& state.inputShowHistoryHint !== 'hidden'` ⇒ `AssertionError: expected true to be false // Object.is equality` @ `src/domains/theme/__tests__/migration.test.ts:134:100` ⇒ 改回复绿（8 passed）。
- 手工验证：实机验收待翻译复验。

## 与 spec 的偏差

本单即规范（无独立 spec）。无偏差。契约快照连带见上（单子预期「仅 generatedAt」，实际多两处边界夹具值变更，已回带并还原）。

## 未解问题

- 开工基线 flaky 一条（`agentWorkbenchSession.terminalDelivery.test.ts:82`），建议分流进问题台账。
- 契约快照 fixture 两处边界值变更未入库（越界不做），待决定随哪笔改动入库。

## 并行交集

- `src/domains/theme/themeFieldDefs.ts`（`THEME_FIELD_DEFS` / `normalizeThemeState`）与 `src/domains/theme/migration.ts`（`normalizeThemeValues`）：theme 域公共文件，并行施工者若改同函数请避让。
