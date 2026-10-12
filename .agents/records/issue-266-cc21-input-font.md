# Dev Record — #266 CC-21 输入栏字体独立生效（含断环插单补记）

> 状态：**收口单（接续·四）代码与门禁完工，实机部分完成并升级一项**（全局主题写链真机不投影，详见「实机」节）。
> 前段记录：断环插单（`03-接续施工单-CC-21字体解析搬叶子模块.md`）见「落点订正」节；单二模板传递见插单段后补记。
> 模板：`.agents/templates/dev-record.md`

## 元信息

- issue：#266（CC-21；不另建、不关闭总账）
- 分支：`feat/cc-21-input-font`（独立工作树 `E:\Acode\Pylon-cc21-worktree`）
- 提交范围：未 commit（本单不授权）；基线 `00ed9aa00c0e58b76001293266ed2f1f50c18f0b`
- 日期：2026-10-11（断环插单施工日）

## 目标与范围

**断环插单**（2026-10-11）：把 `resolveFontToken` / `resolveInputFontToken` 两个纯函数从 `themeCssSnapshot.ts` 整体迁入新叶子模块 `src/domains/theme/fontTokens.ts`，使 themeCssSnapshot 退出依赖环 SCC，环门禁恢复基线态（EXIT=0，基线 10 环）。

**不做**：不动门禁脚本/基线/白名单；不清偿历史 49 文件 type 大环（另立工单）；不改函数体/解析语义/测试断言值；不复制解析逻辑；不留 re-export；不碰接续单二的模板四文件。

## 落点订正（插单核心结论）

- 原单 §2.2/§4.2 钉死的统一解析落点 `themeCssSnapshot.ts` 与依赖环门禁冲突：appearance（本在基线 49 文件 type 大环内）新增 `import { resolveInputFontToken } from '../theme/themeCssSnapshot.ts'` 把 themeCssSnapshot 拉进 SCC（49→50），门禁报新增环 + 旧条目失配。
- **用户裁定「单修、不搞特例、不绕路」**：解析函数搬叶子模块 `fontTokens.ts`（仅依赖零 import 的 `src/contracts/fonts.ts`，是叶子）；themeCssSnapshot 改为从新模块导入并继续在快照中使用；全部导入方改路径，不留 re-export。共享真值要求不变。
- 后续施工（含接续单二 §4.2 模板字体落点）的解析函数一律从 `src/domains/theme/fontTokens.ts` 取，**不再从 themeCssSnapshot 取**。

## 改动清单（插单段）

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/fontTokens.ts` | 整文件：文件头定位注释 + `resolveFontToken` / `resolveInputFontToken`（函数体原样迁入，含原注释） | 新增 |
| `src/domains/theme/themeCssSnapshot.ts` | 头注释「字体选择」表述改为引用 fontTokens；删除两函数与 `fontContributionCssVariable` 死 import；改为 `import { resolveFontToken, resolveInputFontToken } from './fontTokens.ts'` | 修改 |
| `src/domains/appearance/appearance.ts` | import 来源改 `../theme/fontTokens.ts` | 修改 |
| `src/domains/appearance/workbenchSkinContract.ts` | import 来源改 `../theme/fontTokens.ts` | 修改 |
| `src/components/settings/FontContributionPicker.solid.tsx` | import 来源改 `../../domains/theme/fontTokens.ts` | 修改 |
| `src/domains/theme/__tests__/themeCssSnapshot.test.ts` | 仅 import 来源行拆分（解析函数从 `../fontTokens.ts`，`selectThemeCssSnapshot` 仍从 `../themeCssSnapshot`）；断言零变化 | 修改 |

CC-21 在途 14 文件（原单 + 接续单二半成品）保持不动，见停工汇报「停工最终状态」。

## 方案要点

- 纯搬家：函数体、签名、注释语义一行不改；快照输出值零变化（`SNAPSHOT_IDENTICAL true` 实证）。
- `fontTokens.ts` 是叶子：仅 `import { fontContributionCssVariable } from '../../contracts/fonts.ts'`，不 import themeFieldDefs / themeStore / cc 任何东西，不进 SCC。
- 门禁脚本 `scripts/check-import-cycles.mts`、基线 `BASELINE_CYCLES`、白名单、豁免条目零改动。

## 验收标准与结果（插单 §5）

| 验收项 | 结果 |
| --- | --- |
| 1. fontTokens.ts import 仅 contracts/fonts.ts 一条 | 通过（`grep -n "^import"` 仅第 8 行一条） |
| 2. 全仓无仍指向 themeCssSnapshot 的两函数导入 | 通过（5 处 import 全部指向 fontTokens） |
| 3. 两函数定义已删 + 快照输出零 diff | 通过（定义无残留；`SNAPSHOT_IDENTICAL true`，custom-presets-baseline 零改动） |
| 4. 依赖环门禁 EXIT=0、基线 10 环 | 通过（`CYCLES_FINAL_EXIT=0`，修复前 `EXIT=1` 留证） |
| 5. 定向 6 文件 67 绿 | 通过（`Tests 67 passed (67)`，反验恢复后复跑同值） |
| 6. 移位抽检反验红 + 恢复绿 | 通过（见测试处置） |
| 7. git status 全量 = 16 文件 | 通过（原 14 + fontTokens.ts 新增 + FontContributionPicker.solid.tsx） |

## 测试处置

- 新增测试：无。
- 修改既有测试：`themeCssSnapshot.test.ts` 仅 import 来源行（不计新增、不改断言）。
- 删除测试：无。
- **移位抽检反验**（§8）：临时把 `fontTokens.ts` 的 `resolveInputFontToken` 改坏 → `themeCssSnapshot.test.ts`「missing, blank and follow selections resolve the current message font in production snapshots」变红（断言 `themeCssSnapshot.test.ts:19:57`）→ 精确恢复 → 定向 6 文件复跑 67 绿。变异共两次：先按单子示例「恒按 messageFont 解析」改坏，该变异只令「explicit input fonts…」用例红、点名用例仍绿（follow 用例期望值等价于恒按 messageFont），为满足点名用例必须红的硬要求，换为「删掉 follow-message 哨兵判断」变异，点名用例红后恢复。

## 证据

- commit：无（本单不 commit；独立树在途 16 文件）
- 测试：`bun run test <定向 6 文件>` → `Test Files 6 passed (6)` / `Tests 67 passed (67)`，EXIT=0
- 门禁：`bun scripts/check-import-cycles.mts` → EXIT=0，「基线 10 环（RUNTIME 闭合 1 环）零外逃」；生产文件 830（= 基线 829 + fontTokens.ts）
- 快照：`SNAPSHOT_IDENTICAL true`（搬迁后代码 vs 磁盘 baseline 深比较，忽略 generatedAt）
- 完整日志：`E:\Acode\FILES\任务\工作台优化\报告等\02-接续施工单-CC-21模板预览字体局部传递补齐\cycles-before-move-red.log`（修复前红）、`cycles-after-move-green.log`、`cycles-final-green.log`、`insert-core-green.log`、`insert-reverse-red2.log`（反验红）、`insert-core-green-restored.log`、`insert-snapshot-identical.mts`（比对脚本，一次性）

## 与 spec 的偏差

- 原单钉死解析落点 themeCssSnapshot.ts → 订正为 fontTokens.ts（依赖环门禁阻断，用户裁定单修，见「落点订正」）。
- 反验变异从单子示例「恒按 messageFont 解析」换成「删 follow-message 哨兵」，原因见测试处置（示例变异无法使点名用例变红）。

## 未解问题

- 历史 49 文件 type 大环仍在基线内（本单不清偿，另立工单）。
- CC-21 其余在途工作（设置接线、InputBar 测高、CSS 消费、模板传递、实机、最终五步）未完成，回到接续单二继续。
- `--cc-input-font-family` 尚无 CSS 消费（停工汇报已知中间态，属接续单二范围）。

## 并行交集

- 施工全程仅在 `E:\Acode\Pylon-cc21-worktree`（分支 `feat/cc-21-input-font`）；主仓 `E:\Acode\Pylon-co-works` 零写入。
- 本段改动文件：上表 6 个；CC-18 在途文件与接续单二模板四文件未触碰。

---

# 收口段（接续·四 · 2026-10-11）—— 原单剩余收口与清单同步

> 施工单：`04-接续施工单-CC-21原单剩余收口与清单同步.md`。用户裁定 A 路线一次交付。

## 收口段改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/themeFieldDefs.ts` | inputFont 行：删 `cssVar` 声明、加 `noCssVar: true`（翻译已定的 skinSchema 生产侧修，同 ccBg/inputFocusBorder 显式派生模式） | 修改 |
| `src/domains/cc/__tests__/ccSettingsGrouping.test.ts` | 冻结清单 +inputFont（65→66）、「按输入模式判明」计数 66 | 修改（清单同步，2 用例） |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 字段对账 69→70、input 组计数 25→26、total 69→70、`input/textarea` 归属清单 +inputFont | 修改（清单同步，3 用例） |
| `src/domains/theme/__tests__/terminalPresets.test.ts` | 「覆盖所有主题字段」对 inputFont 按默认值（follow-message）归属（预设不显式声明，读时补默认；预设数据未改） | 修改（清单同步，1 用例） |
| `src/plugins/.../chat/InputBar.css` | 三处 `--cc-input-font-family` 消费（主输入一般 / CLI / terminal-modern 特化，均保留旧链兜底）；ghost 行距与主输入同链；队列编辑框同变量 | 修改 |
| `src/renderers/solid-workbench/input/InputBar.solid.tsx` | 测高 effect 纳入 `inputFontFamily`；挂载订阅字体注册表 + `document.fonts`（loadingdone/loadingerror/ready），onCleanup 全解绑，disposed 防迟到写入 | 修改 |
| `src/components/settings/FontContributionPicker.solid.tsx` | 可选 `followOption`（label/value/previewFamily 访问器）：固定最前、不可被贡献顶替伪装、跟随示例实时、不可用项置顶顺序保持 | 修改 |
| `src/components/settings/themeFieldRenderer.solid.tsx` | inputFont 字段接线跟随项（示例 = `resolveFontToken(ctx.t.msgFont)` 实时）；其它字体字段不传，行为不变 | 修改 |
| `src/domains/theme/__tests__/inputFontContract.test.ts` | 新建守卫 7 用例：字段结构/白名单、noCssVar 显式派生登记、三处派生同值（快照/皮肤契约/模板）、契约变量目录、InputBar.css 三处消费（剥注释按规则块断言、禁裸旧链）、ghost/queue 同链 | 新增 |
| `InputBar.solid.test.tsx` / `FontContributionPicker.solid.test.tsx` / `themeFieldControlRich.solid.test.tsx` | 新增 3 + 4 + 2 条行为用例（测高响应、fonts 事件与卸载清理、跟随项接线与写回） | 修改 |

## 收口段方案要点

- skinSchema 红走生产侧修（翻译已定）：string 字段不进 `THEME_CSS_VAR_MAP`（color/number 限定是有意设计），显式派生登记用 `noCssVar`。
- 清单同步只补预期不放宽：inputFont 按实际归属（cc 区「输入框本体」/`input/textarea` 成员）进既有冻结清单。
- InputBar.css 消费保留兜底链 `var(--cc-input-font-family, var(--msg-font, ...))`，变量缺失不失效；ghost 用 `font:inherit` + 行距同链保证接续不错位。

## 收口段验收结果

- 最终五步：lint EXIT=0 → build:example-plugin EXIT=0 → build EXIT=0 → **check:solid EXIT=0**（14 子检查全绿，含变量消费检查不再报死注入）→ test 全量 5353 用例（5349 passed + 1 skipped + 3 红：InputBar.css.test.ts ×2 既有契约 + terminalDelivery ×1 偶发，见下）。
- 计数对账：文件 684 持平；用例 5353 = 5319 基线 + 原单 8 + 单二 10 + 收口 16（inputFontContract 7、InputBar 3、Picker 4、Rich 2）。零删除、零放宽。
- 依赖环 EXIT=0（边 3228，基线 10 环原样）；快照 `SNAPSHOT_IDENTICAL true`。
- 反验 12 次生产变异（M1 加回 cssVar / M2 模板派生改坏 / M3 契约目录删项 / M4 删 CLI 消费 / M5 ghost 旧链 / M6' 切断重测调用 / M7 删 fonts 监听（用例修正后红）/ M8 删卸载清理 / M9 renderer 丢跟随 / M10 picker 忽略跟随项 / M11 preview 忽略跟随项 / M12 未传也注入），16 条新用例全覆盖红。
- 定向 8 文件 112 用例恢复后全绿；skinSchema.test.ts 零改动转绿。

## 全量余红（2 条，待翻译追授权）

`src/renderers/solid-workbench/chat/__tests__/InputBar.css.test.ts` ×2（「uses the shared message font and line-height for every input variant」「keeps queued-message prose on the shared fallback rail」）为**既有行为测试**，断言 `.input-textarea` / `.queued-message-editor` 的 font-family 恒为旧消息字体链 `var(--msg-font,var(--chat-font,var(--mono)))`——与 CC-21 已定案变更（输入字体独立为 `--cc-input-font-family`）正面冲突，正是原单 §7 预案「旧用例锁已定案变更」的情形。该文件不在原单 11-20 / 单二四文件 / 收口三文件任何授权清单内，工作者未改。另 `agentWorkbenchSession.terminalDelivery.test.ts` 1 条为时间敏感偶发（elapsedMs 同毫秒为 0），单跑绿，非本单引入。

## 用例同步段（接续·五 · 2026-10-11）—— 最后余红清偿

> 施工单：`05-接续施工单-CC-21输入栏CSS契约用例同步.md`（追授权）。

- **授权来源**：接续·五，翻译核对断言原文后授权按新定案更新预期。
- **更新内容**：仅 `InputBar.css.test.ts` 两条用例——`.input-textarea` / `.queued-message-editor` 的 font-family 期望由旧链改为 `var(--cc-input-font-family,var(--msg-font,var(--chat-font,var(--mono))))`（与生产 CSS 逐字符一致）；用例名按新语义微调（「uses the independent input font chain…」「keeps queued-message prose on the independent input font rail」）；line-height 断言与两条 `not.toMatch`/`not.toContain` 防回归断言零改动；无新增无删除，不需反验。
- **结果**：该文件单跑 4 passed；最终五步逐条 EXIT=0；**全量 `Test Files 684 passed | 1 skipped (685)` / `Tests 5352 passed | 1 skipped (5353)`，EXIT=0 全绿**。
- **台账订正**：收口汇报「文件 684 持平」系笔误——inputFontContract.test.ts 为新文件，全量文件数应为 **685**（684 + 1 新文件）。用例数口径不变：5353 = 5319 基线 + 原单 8 + 单二 10 + 收口 16。
- terminalDelivery 偶发本次全量未复现，落台账不另立（翻译口径）。

## 实机补验段（接续·六 · 2026-10-11）—— 实机矩阵收口取证

> 施工单：`06-接续施工单-CC-21实机矩阵补验收口.md`。零代码改动（工作树保持 32 条目）。

### 产物自检（#596 教训落实）

- 三步重建：`bun run build` EXIT=0（源码自单五 build 后零变化，find src -newer dist 实证）→ `cargo build` EXIT=0（1m07s）→ 重启实例。
- 便携化：`src-tauri/target/debug/portable.flag` 创建，数据目录落在包内 `data/`（pylon-data-v1.sqlite3），**用户 %APPDATA% 数据全程未接触**。
- 特征值自检（起实例后页面读取）：`.app` 内联 `--cc-input-font-family` 存在；设置页 10 张模板卡全部带双搬运变量（`--pylon-template-*-selection`）且派生值逐卡跟随各自 msgFont——本轮源码特征全部命中，二进制与源码一致。

### 实机读数（现代 GUI → 经典终端两轮；切换史：terminal-classic(启动默认) → modern-gui(手动) → classic-terminal(手动·当前)）

| 矩阵项 | 结果 |
| --- | --- |
| 1. 主输入三选择器/预测/队列编辑 computed | 部分取得：`.app` 与设置预览中控内联出口、预览 textarea computed font-family 均为跟随链解析终值；**预览中控输入框 disabled 不可交互**，真实工作台主输入因无会话/工作区未进入 → 三选择器/预测/队列编辑的真实 DOM 读数**未验**（受限于空环境） |
| 2. 跟随/独立两方向切换 | **跟随方向全链真机成立**：应用 Solarized Light（msgFont=mono）→ `.app` 的 `--msg-font` 与 `--cc-input-font-family` 同步变 mono 解析；应用回 Glass Light（system）→ 同步回 system（followHolds:true）。**独立方向未验**：环境内无 inputFont≠follow-message 的模板可应用，设置页下拉写链失效（见下），受控自建模板保存入口未找到 |
| 3. 插件字体 | 真加载+出口变化 ✓（内置 system/serif/mono 即 builtin.pylon-renderers 的 registerFont 贡献，跟随往返用它们作贡献 id 且解析出口正确）；**停用回退/恢复未验**——唯一贡献插件是核心渲染器插件，停用属破坏性操作 |
| 4. 重新挂载保留 + 长草稿重排 | 跨界面模式切换（= 大面积重挂载）后主题变量与跟随值保留 ✓；长草稿重排**未验**（预览中控 disabled、无真实可交互主输入；JS 层行为已由 InputBar.solid.test 测高用例锁定） |
| 5. 宽窄窗/空态/有会话截图 | 空态+模板库截图 2 张（经典终端）；**窄窗未验**（Tauri set_size invoke 参数反序列化失败 + CDP Emulation 不可用）；**有会话未验**（不创建会话） |
| 6. 模板卡 | ✓ 两模式下均验：10 卡双搬运变量、派生逐卡跟随模板自己 msgFont（system 卡→system 栈、mono 卡→mono 栈），与全局故意不同；受控自建模板未做成（保存入口未找到，见矩阵 2 独立方向） |
| 7. 普通设置预览 | ✓ 跟随态：预览中控内联=全局解析值（modern GUI 轮） |
| 8. 自建预设保存/恢复 | **未验**（保存入口未找到；受限如实标注） |

### 实机发现（单外缺陷，取证上报，未修）

**设置页下拉的 setZoneField 写入在真机不生效**（#596 现象在本环境稳定复现，两模式一致）：选择正文渲染字体后 trigger 显示已变、但 `.app` 投影零更新 + 持久层（localStorage pylon-theme v11）值不变。**关键对照：应用模板路径全链正常**（applyGlobalPreset → store → 投影 → 输入字体跟随全部生效）→ 缺陷范围收窄到 **setZoneField 单点**（触发或 zone 判定），不是主题投影链整体。恢复操作（点回原值）同样不生效（原值本就未被动过）。翻译 #596 四组合不复现与本环境（便携 debug 包+全新数据）差异原因未查明，数据与复现步骤已留档。

### 恢复确认

- 持久层字段级原值：msgFont=system、inputFont=follow-message、presentation=terminal-classic（全部原值）✓
- 便携库全局主题停在 Glass Light 应用态（出厂预设、合法测试后状态；persist 字段即上述原值）；用户真实数据 %APPDATA% 全程未接触 ✓
- hook/探针零残留（本轮未安装任何 hook）；实例已关闭；工作树 32 条目零新增 ✓
- 截图：`reverify-shot-classic-settings.png`（经典终端设置页）、`reverify-shot-classic-templates.png`（经典终端模板库）

## 实机（2026-10-11，独立树二进制 + WebView2 CDP 9222）

- 启动：`bun run build`（dist 最新）→ `cargo build` EXIT=0（2m43s）→ `src-tauri/target/debug/pylon.exe`（内嵌最新 dist，CSSOM 自检 tauri invoke OK）。
- **已取得的实机读数**（全部来自真实窗口）：
  1. `.app` 内联 `--cc-input-font-family` 有定义且解析正确（跟随态默认 = 消息字体解析值）。
  2. 设置页 10 张官方模板卡：全部输出双私有搬运变量（`--pylon-template-input-font-selection` / `--pylon-template-message-font-selection`）；`--cc-input-font-family` 逐卡跟随模板自己的 msgFont（msgFont=system 卡 → `var(--font-system, var(--font))`，mono 卡 → `var(--font-mono-default, var(--mono))`）——单二 §2.2「模板跟随自己的消息字体」真机成立。
  3. 模板卡内真实中控（`[data-control-center="production"]`）内联出口 = 该模板的解析值（非全局值）——读回链真机成立。
  4. 普通设置预览中控内联 = 全局主题解析值。
  5. 「中控台 → 输入栏字体」控件存在：菜单首项「跟随消息字体」、示例实时读当前消息字体解析值。
  6. 截图：`报告等/02-.../final-shot-template-library.png`（模板库视图）。
- **升级（阻断剩余实机矩阵）**：设置页字段写入（msgFont 既有字段，与本单改动零交集）后**主题投影层零更新**——`CSSStyleDeclaration.setProperty` hook 证实：选择衬线后投影写入次数停在 53（零新增），`.app` 内联、主输入 computed、普通预览出口全部不动；reload 后值回退（持久层亦未落）。前后端日志零报错。themeStore 单实例（dist 内 persist 定义仅 shell chunk 一处）。该链路是既有核心行为（原单 §5.4「跟随时改消息字体⇒输入字体一起变」的实机验证依赖它），工作者不修单外问题，升级待分流。受其阻断的实机项：跟随/独立两方向全局切换读数、插件停用/恢复实机、长草稿换字体重排读数、宽窄窗/空态/有会话矩阵。已恢复项：消息字体改回系统无衬线、hook 移除、界面模式切回经典终端、实例关闭。

## 收口段与 spec 的偏差

- InputBar.css.test.ts 2 条既有契约红未处理（不在授权清单，升级追授权）。
- 实机矩阵部分受阻（既有投影链真机不投影），已取证上报。

## 收口段并行交集

- 全程独立树施工；主仓零写入（仅起过一次主仓对照实例，白屏不可用即关闭，未动其文件）。
- CC-18 已完工（用户口述），主仓实例关闭；9222 调试端口使用后即释放。
