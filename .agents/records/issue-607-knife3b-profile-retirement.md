# Dev Record — #607 刀3b 档案机制退役（宿主私路）＋ 终端外观接入样式行

> 入库保留。施工单与规格文档不保留，其目标、范围、方案与验收结论在此承接。
> 施工单：`E:\Acode\FILES\预设修正\界面模式落点收敛\03-施工单-刀3b-档案退役.md`（用户 2026-10-13 拍板 A/A/A/A）

## 元信息

- issue：#607（刀3b）
- 分支：`feat/mode-landing.1`
- 提交范围：`7c507c54..<本单工作树>`（**未提交、未 push**——按单要求「不暂存 / 不 commit / 不 push / 不开 PR」）
- 日期：2026-10-13
- 规模：32 文件，+296 / −486 行（不含 `.agents/L.md` 的在途改动）

## 目标与范围

**做**：① 退役宿主的档案私路（渲染风格选择器、`presentation.*` 命令、`GlobalPreset.presentationProfileId`、`profileByMode` 记忆链、bundle 的 Presentation 段、`presentation-profile` 写来源、`applyPresentationProfile`/`activatePresentationProfile`/`applyModeProfile`）；② 把 `profile:*:chat:style` 材料接进消息流**样式行**候选（排除本桶默认档案）。

**不做**：注册表 / 插件 `registerProfile` API / `builtinPresentationProfiles.ts` / `kindTokens` / `assets` / `activeProfileId` / `data-presentation-profile` 属性与 CSS / 三张契约测试 / 消息流配色行候选 / `src-tauri/` / `docs/说明书/` 一律未动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/components/settings/PresentationProfilePicker.solid.tsx` | 整文件（选择器实体） | 删除 |
| `src/components/settings/__tests__/PresentationProfilePicker.solid.test.tsx` | 整文件 | 删除 |
| `src/plugins/core/renderer/builtinPresentationCommands.ts` | 整文件（`presentation.list/inspect/apply`） | 删除 |
| `src/application/transactions/applyPresentationProfile.ts` | 整文件 | 删除 |
| `src/components/Settings.solid.tsx` | chat 区「渲染风格」组与其 import | 修改 |
| `src/plugins/product/builtinPylonRenderers.ts` | 命令注册循环与其 import（档案注册循环保留） | 修改 |
| `src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css` | 选择器专用样式（`.presentation-profile-*` / `.presentation-settings`）与两处 `:is()` 列表项 | 修改 |
| `src/application/transactions/activateInterfaceMode.ts` | 删 `applyModeProfile`/`activatePresentationProfile`/`pruneDanglingPresentationProfiles`；`ensureInterfaceModeProfile` 改为只对齐模式 | 修改 |
| `src/domains/interface/interfaceModeStore.ts` | 删 `profileByMode`/`rememberProfile`/`forgetModeProfile`/`DEFAULT_INTERFACE_PROFILES`；持久化版本 2→3 | 修改 |
| `src/domains/theme/presets/types.ts` | 删 `GlobalPreset.presentationProfileId` | 修改 |
| `src/domains/theme/presets/builtin.ts` | 三张 Agent 卡的 3 处 `presentationProfileId` 数据 | 修改 |
| `src/domains/theme/settingProvenance.ts` | 删 `'presentation-profile'` 来源与标签 | 修改 |
| `src/domains/theme/themeStore.ts` | `sourceMarksZoneCustom` 例外分支收口为常量 | 修改 |
| `src/domains/theme/presetActions.ts` | 删 Presentation 捕获/恢复注入与 `expectedProviderIds` 项 | 修改 |
| `src/domains/theme/firstPartyPresetProviders.ts` | 删 `builtin.presentation` provider 与其 deps | 修改 |
| `src/domains/theme/presetBundle.ts` | 删 `PresentationPresetPayload`、贡献构造、覆盖统计分支与标签 | 修改 |
| `src/domains/theme/zones/zonePresetPool.ts` | 新增 `PROFILE_POOL_ENTRIES` ＋ `profileCandidatesFor`；`zonePresetsFor` 样式行并入档案条 | 修改 |
| `src/domains/theme/zones/factory/landingEntries.ts` / `src/application/transactions/applyGlobalPreset.ts` | 过期注释同步（引用已删字段） | 修改 |
| `.agents/records/issue-607-knife3b-profile-retirement.md` | 本记录 | 新增 |

## 方案要点

- **删前 grep 复核零活消费者**：`PresentationProfilePicker` / `presentation.{list,inspect,apply}` / `activatePresentationProfile` / `applyPresentationProfile` / `profileByMode` / `rememberProfile` / `forgetModeProfile` / `presentationProfileId`（预设字段）/ `builtin.presentation`（provider 语境）全部清零（见「证据」的 grep 计数）。
- **`ensureInterfaceModeProfile` 新语义**：模式可用即 `true`；不可用（插件卸载留下悬空引用）时回退 `DEFAULT_INTERFACE_MODE`——保留 A17 韧性，不再解析 / 记忆档案，不再 `pruneDanglingPresentationProfiles`。
- **`presentationProfileInterfaceMode` 保留**：它只是「读贡献的 `interfaceMode` 标签」的纯函数（不挑档案、不写档案、不记偏好），且 `terminalLikeSpacingContract.test.ts`（本单未点名的契约测试）在消费它——删它会迫使改未点名的既有测试。
- **bundle 的 Presentation 段按施工单整体删除**（含 `rendererSuiteIdByMode` 半段）：与 `04-刀3b-退役范围与授权清单` 的 C1 推荐（保留套件偏好半段）不同，**以施工单 §4-A 的明确删除清单为准**（见「与 spec 的偏差」）。
- **档案候选落在查询层而非池内**：`ZONE_PRESET_POOL` 语义保持「只装 `factory:*` 材料」不变（5 个既有池测试零改动），`zonePresetsFor` 在**样式轴**那一条候选上追加档案条（工厂条在前、档案条在后、用户自定义条仍在最后）。这样「池 = 出厂工厂材料」「候选 = 工厂 ＋ 档案 ＋ 自定义」两层语义各自可断言。
- **旧 bundle 兼容**：未知 provider 本就走 `preparePresetBundle` 的 `if (!provider) continue` 静默跳过 + `markUnavailablePresetProviders` 登记，风险点是 `expectedProviderIds` 里的 `builtin.presentation`（它会拦住旧预设载入）——已同步摘除，并新增测试锁定「不报错、不清空预设、不是 error」。
- **`sourceMarksZoneCustom`**：唯一例外来源退役 ⇒ 收口为常量 `SOURCE_MARKS_ZONE_CUSTOM = true`（其余来源语义一字未动；切换 / 重置走 `applyLandingPlan` 整份落地，本就不经该漏斗）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| §5.1 全仓 grep 零活引用 | ✅ 通过（见「证据」grep） |
| §5.2 终端样式行 8 条 / GUI 8 条 / 蓝调 1 条 | ✅ 单测锁定 + 真机实测（8 / 8 / 1） |
| §5.3 三张 Agent 卡 kind 级外观逐字段不变 | ✅ 旧树对拍 SHA256 相同（见「证据」） |
| §5.4 旧预设含 Presentation 段静默忽略；新建不再带该段 | ✅ 两个新测试 + 真机 v2→v3 迁移实测 |
| §5.5 冷启动/HMR：只对齐模式；`data-presentation-profile` 三模式照旧 | ✅ 真机三模式实测（terminal-classic / modern-gui / tactical-blue） |
| §5.6 五步门禁按序全绿 | ⚠️ **1–3、5 绿；第 4 步 `check:solid` 红**——红点只有一处且不在本单文件（见「未解问题」） |
| §5.7 真机：三模式＋终端四套外观＋三张卡＋混搭＋另存＋刷新 | ✅ 全部实测（数值见下） |

## 测试处置

**删**：`src/components/settings/__tests__/PresentationProfilePicker.solid.test.tsx`（整文件，随选择器退役）。

**改（逐个点名）**：

| 文件 | 改了什么 |
| --- | --- |
| `plugins/core/commandSet/__tests__/builtinCliCommandCoverage.test.ts` | 命令清单去 `presentation.*` 三项与其构造器 |
| `domains/interface/__tests__/interfaceMode.test.ts` | 记忆链用例改写为「store 只剩模式一项」；3a 用例去掉 `profileByMode` 预置 |
| `domains/theme/__tests__/customPresetOverwrite.test.ts` | `activatePresentationProfile` 调用删除；新增「旧段静默忽略」「新建不再带该段」两例 |
| `domains/theme/__tests__/settingProvenance.test.ts` | 删 `presentation-profile` 写来源用例 |
| `domains/theme/__tests__/presetBundle.test.ts` | 覆盖表期望值去 `builtin.presentation`；新增「旧段静默忽略」纯层用例 |
| `components/__tests__/Settings.chatPresetRows.solid.test.tsx` | 样式行同名对（工厂条＋档案条各一）计数断言 |
| `domains/theme/zones/__tests__/zonePresetPool.solid.test.tsx` | 新增「档案外观候选」三例（候选集合 / 配色行不加 / 可应用） |

**改（单外连带，施工单 §7 未逐条点名，但为本单契约变更的必然连带；已在此点名）**：

| 文件 | 连带的成因 |
| --- | --- |
| `domains/theme/__tests__/customPresetApply.test.ts` | `createPresetBundle({presentation})` 参数删除（类型报错）；`providers` 期望去 `builtin.presentation`；用例名去「and Presentation」 |
| `__tests__/defaultPresets.solid.test.tsx` | 断言「呈现方案例外」的写法失效（来源已删）⇒ 改为锁「其余来源一律置 custom」 |
| `__tests__/effectivePresetTheme.test.ts` / `__tests__/presetAssembly.test.ts` | 测试侧参考实现读 `preset.presentationProfileId`（字段已删）⇒ 自立 `AGENT_CARD_PROFILES` 本地真值 |
| `application/transactions/__tests__/applyGlobalPreset.test.ts` | 断言 `profileByMode` 表（字段已删）⇒ 改为断言字段不存在 |

**新增**：`plugins/core/renderer/__tests__/builtinPresentationProfiles.test.ts` 追加一个 describe（kindTokens 经注册表取数的冻结指纹）。该文件是既有测试文件，未改动任何既有断言。

## 证据

- **grep 零活引用**（`src/` 全仓）：
  - `PresentationProfilePicker` / `presentation.apply|list|inspect` / `activatePresentationProfile` / `applyPresentationProfile` / `profileByMode` / `rememberProfile` / `forgetModeProfile` / `presentationProfileId`（预设字段）/ `PresentationPresetPayload` / `builtin.presentation`（provider 语境）→ **0 处源码命中**（存活命中只有 `data-presentation-profile` 属性族与保留的 `builtin.presentation.*` 档案 id 字符串）。
- **五步门禁（按序，最终一轮）**：
  - `bun run lint` → EXIT=0
  - `bun run build:example-plugin` → EXIT=0
  - `bun run build` → EXIT=0（`✓ built in 8.86s`）
  - `bun run check:solid` → **EXIT=1**，且**唯一**红点：`拼接家族 is- 的值域来源文件缺失或已不含该前缀（模板改了？名单须复核）：src/components/settings/PresentationProfilePicker.solid.tsx`（`scripts/check-css-class-reachability.mts:264`）；同一次运行里 **import 环门禁通过：生产文件 852 个、边 3270 条；基线 10 环（RUNTIME 闭合 1 环）零外逃**（**环形状未变**，与方案预估的「环可能缩小」不同）。
  - `bun run test` → EXIT=0：**690 文件 passed / 1 skipped（691）；5404 用例 passed / 1 skipped**。
- **旧树对拍（kind 外观逐字段不变）**：`git archive 7c507c54` 取旧树同两文件 → 两边各跑 `BUILTIN_PRESENTATION_PROFILES` 的 `kindTokens` 规范化 JSON → `diff` **IDENTICAL**，SHA256 双方均 `c8f3b14c87817e5ac39eaee418435dac8c22877e0920e2e1f89a622186e7ac71`；另 `git diff 7c507c54 -- src/plugins/core/renderer/builtinPresentationProfiles.ts src/plugin-runtime/presentation/` 为空（档案本体与注册表逐字未动）。
- **真机（`src-tauri/target/debug/pylon.exe`，`bun run build` → `cargo build` → 重启；CDP :9222）**：
  - CSSOM 自检：`.presentation-profile-card` / `.presentation-profile-grid` / `.presentation-settings` **全不在**；`[data-presentation-profile="builtin.presentation.terminal-classic"]` 与 `.interface-mode-card` 在（证明跑的是本轮产物）。
  - 消息流样式行候选：终端 = 8（工厂 5 ＋ 现代终端 / 低对比纸张 / 玻璃控制台）；GUI = 8（Glass Light / Solarized Light / Agent 指挥台 / Agent 关系图 / 专注流程 ＋ 三个同名档案条）；蓝调 = 1（`tactical-默认`）。配色行恒 5（不加档案条）。
  - 终端四套外观数值（`getComputedStyle(.app)`）：终端经典（重置）`--message-radius:0px` / `--msg-line-height:1.55` / 等宽；现代终端 `8px` / `1.65`；低对比纸张 `4px` / `1.7` / 衬线；玻璃控制台 `18px` / `1.75` / 系统字。
  - 三模式：terminal-like → `data-presentation-profile=builtin.presentation.terminal-classic`；modern-gui → `…modern-gui`；tactical-blue → `…tactical-blue` 且 `--accent:#65dfff`。
  - 三张 Agent 卡：agent-command `#38bdf8`/`#08111f` → agent-map `#a78bfa`/`#11101d` → focus-flow `#d6a85f`/`#181713`，身份随各自档案 id 落地。
  - 混搭：工厂条（Tokyo Night：`0px`/`1.6`）→ 档案条（玻璃控制台：`18px`/`1.75`）连续应用，值以后者为准。
  - 另存：样式行「存当前」命名后成为该行唯一 active chip，只出现在样式行（配色行不出现）；刷新后仍在。
  - 持久化：`localStorage['pylon-interface-mode'] = {"state":{"interfaceMode":"terminal-like"},"version":3}`（**版本已升 3、无 `profileByMode`**）；手工回填 v2 旧数据（带 `profileByMode`）后刷新 → 迁移不报错、字段被丢弃。
  - 控制台：`error/warning/exception` 条目 0（含一次正控探针，证明通道活着）；后端日志 error 0。
- **反向验证（12 个探针，破→红→复原→复绿；最小形态见下）**：
  1. 候选不排除桶默认档案 ⇒ `zonePresetPool.solid.test.tsx:494:69`、兼 `:125:10`
  2. 未知 provider 抛错 ⇒ `presetBundle.test.ts:41:65`、`customPresetOverwrite.test.ts:98:27`
  3. 改动档案 kindTokens 材料 ⇒ `builtinPresentationProfiles.test.ts:109:61`
  4. store 保留 `profileByMode` ⇒ `interfaceMode.test.ts:103:50`、`applyGlobalPreset.test.ts:65:50`
  5. bundle 重新带 Presentation 段 ⇒ `customPresetOverwrite.test.ts:112:55`
  6. 覆盖表标签回填 ⇒ `presetBundle.test.ts:17:85`
  7. 恢复来源例外 ⇒ `defaultPresets.solid.test.tsx:307:51`
  8. 档案条漏进配色行 ⇒ `zonePresetPool.solid.test.tsx:511:106`、兼 `:523:31`
  9. 档案候选清零 ⇒ `Settings.chatPresetRows.solid.test.tsx:52:85`、兼 `zonePresetPool.solid.test.tsx:494:69`、`:523:31`
  10. 还原 provider＋段 ⇒ `customPresetApply.test.ts:89:34`
  11. 档案条值被清空 ⇒ `zonePresetPool.solid.test.tsx:528:38`
  12. 绑定表改错 ⇒ `effectivePresetTheme.test.ts:154:42`、`presetAssembly.test.ts:228:79`

  每个探针复原后均以 `sha1sum` 比对原文件一致（探针期间的备份件），随后全量 `bun run test` 复绿。

## 与 spec 的偏差

1. **`check:solid` 未绿（唯一红点）**：`scripts/check-css-class-reachability.mts` 的 `is-` 拼接家族「值域来源文件」名单仍列着被删的 `src/components/settings/PresentationProfilePicker.solid.tsx`，其正控断言「来源文件必须存在且仍含前缀」因此报红。**该脚本属施工单 §2 非目标「不动 `scripts/**`」范围**，故未自改，停工上报（修法见「未解问题」）。
2. **bundle 的 Presentation 段整段删除**（含 `rendererSuiteIdByMode`）：施工单 §4-A 的明确删除清单如此；`04-刀3b-退役范围与授权清单` 的 C1 推荐是「删 `activeProfileId` 半段、保留套件偏好半段」。两者相抵，按施工单执行。
3. **档案候选落点在查询层**（`zonePresetsFor`）而非池装配（`assembleFactoryZonePresetPool`）：施工单 §4-B 只说「候选来源增加」，未指定层次；选择查询层使池的「只装工厂材料」语义与 5 个既有池测试保持零改动。
4. **`presentationProfileInterfaceMode` 保留**（施工单未点名删除）：理由见「方案要点」。
5. **CSS 改动**：施工单 §2 非目标写「不改任何 CSS」，§4-A 又明确要求删选择器专用样式；按 §4-A 执行（只删选择器自用规则与其在两处 `:is()` 列表中的成员，`data-presentation-profile` 相关 CSS 一字未动）。
6. **单外连带测试 4 个**（`customPresetApply` / `defaultPresets.solid` / `effectivePresetTheme` / `presetAssembly` / `applyGlobalPreset`——共 5 个文件）与单外记录文件 1 个：均为契约变更的类型/断言必然连带，已在上表逐个点名。

## 未解问题

1. **`check:solid` 唯一红点（待授权）**：需从 `scripts/check-css-class-reachability.mts:120` 的 `is-` 家族 `sources` 数组里删掉 `'src/components/settings/PresentationProfilePicker.solid.tsx'` 一项（该家族仍有 `AgentSettingsSection.solid.tsx` 与 `TemplateLibrary.solid.tsx` 两个来源支撑，前缀覆盖不变）。因 §2「不动 `scripts/**`」未自改。
2. **GUI 桶样式行出现同名芯片对**：三张 Agent 卡的工厂条与档案条同名（`Agent 指挥台`/`Agent 关系图`/`专注流程` 各两条，`label` 按单要求取材料原标签）。真机实测两条同名芯片落值不同（`--msg-line-height` 1.72 vs 1.62）。命名去重或分组口径待用户定。
3. **样式行档案条不写 `activeProfileId`**：沿用区域行既有语义（`appliedPreset[chat]=材料 id`），故 `data-presentation-profile` 保持原值不变 ⇒ `InputBar.css` 针对 `terminal-modern`/`paper-low-contrast`/`console-glass` 的特化段不随之切换；且档案条的 cc/输入面 tokens 不在这条单里（只应用 chat 样式轴切片）。若要「档案外观完整复现」，需另接身份写入——单外决策。
4. 蓝调区域行标签 `tactical-默认` 命名（刀3a 遗留）。

## 并行交集

本单碰过、其他贡献者需避让的共享文件：`src/domains/theme/{presetActions,presetBundle,firstPartyPresetProviders,settingProvenance,themeStore}.ts`、`src/domains/theme/presets/**`、`src/domains/theme/zones/**`、`src/domains/interface/interfaceModeStore.ts`、`src/application/transactions/{activateInterfaceMode,applyGlobalPreset}.ts`、`src/components/Settings.solid.tsx`、`src/plugins/product/builtinPylonRenderers.ts`、`src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css`。未碰 `src-tauri/`、`docs/`、`scripts/`、`shared/`。

## 接续修正 · 名单同步

- 用户明确授权本会话执行接续1：只改 `scripts/check-css-class-reachability.mts` 的 `is-` 一行，sources删除已退役选择器，reason三处改两处；1 insertion、1 deletion，其他逻辑和名单不动。
- 反向：临时删整条is-家族后 `bun run check:solid` EXIT=1，报不可达 `is-connected / is-crashed / is-explicit / is-missing / is-ok / is-ready / is-unavailable`（反向树脚本`:300:8`）。恢复与备份字节一致，SHA256 `1683a31dde235f052ab975966fac689e44d0d286a1f09644f6690e673a51eea5`。
- 最终按序 `lint`、`build:example-plugin`、`build`、`check:solid`、`test` 全部EXIT=0。CSS类名审计1249类、可达1096、豁免153、不可达0；import环852文件、3270边、基线10环零外逃。
- 日志：仓外报告目录 `03b2-reverse-is-family.log`、`03b23-green-*.log`。翻译独立核验待交单人执行，本节不冒充翻译核验结论。

## 接续修正2 · 候选收口

### 规则与测试

- 从default/preset chat/style的styleMaterial.profileId派生排除集；默认和三张Agent卡已使用的档案不再独立出现。档案只补消息流样式轴和中控行，按桶匹配；工厂、档案、自定义顺序不变。配色行、身份写入、材料数据、CSS及环基线未改。
- 修改点名的zonePresetPool.solid与Settings.chatPresetRows测试，新增5用例（排除集合、中控候选、三套点击逐键落值），无删测试。
- 首次全量两份旧候选对拍仍要求终端cc仅工厂5条，停工上报后获增补授权：仅同步modeDefaultReferences与modeLandingData候选对拍，独立算档案集合，保留完整对象及顺序、工厂池、原材料和蓝调断言；新增终端cc三个显式id、GUI cc无档案、配色行无档案守卫，未放宽为计数或跳过。
- 最终 `bun run test`：`Test Files 690 passed | 1 skipped (691)`；`Tests 5409 passed | 1 skipped (5410)`；EXIT=0。

### 反向红与恢复

- 空排除集：GUI同名断言红 `modern-gui 无同名对: expected 6 to be 9`（zonePresetPool.solid`:491:82`），新增排除集用例亦红（`:528:49`）。
- 不接cc档案：中控5与8条完整id对拍红（`:544:49`）；增补两守卫亦同时红（modeDefaultReferences`:154:51`、modeLandingData`:137:53`）。
- cc inputRadius改坏为-1：三套点击用例分别期望8/4/16变红（zonePresetPool.solid`:565:67`）。
- 每次恢复生产文件字节与备份一致；SHA256 `a22cc42820a7ad940dea5719e22c421c2fc309ad9a55c03aaa1383e7cf467d79`；恢复后定向与最终全量绿。完整日志`03b3-reverse-*.log`。

### 真机读数与限制

- 恢复后源码 `bun run build` → `cargo build --manifest-path src-tauri/Cargo.toml` EXIT=0 → 仓外独立目录启动。真实Tauri/WebView2，invokeType=function，http://tauri.localhost/；不碰日常数据。
- DOM候选：终端样式8/配色5/中控8；GUI 5/5/5；蓝调1/1/1，各行无同名label。
- 三套cc的5键逐键落值：现代终端 inputBg `rgba(59,130,246,0.08)` / inputFocusBorder `rgba(59,130,246,0.82)` / inputRadius8 / cliHintMode full / inputBorderColor `rgba(59,130,246,0.32)`；纸张对应 `rgba(163,128,72,0.06)` / `rgba(128,102,63,0.52)` / 4 / compact / `rgba(128,102,63,0.24)`；玻璃对应 `rgba(148,163,184,0.12)` / `rgba(99,102,241,0.72)` / 16 / hidden / `rgba(148,163,184,0.30)`。
- appliedPreset.cc各记对应profile:*:cc；除了材料键和记账外全主题逐键未变（含消息流两轴和其他区）；data-presentation-profile前后恒terminal-classic。
- 工具参数包装存在selector/ref互斥冲突，首个菜单用真实鼠标CDP事件，其余用DOM button.click走正式UI处理函数；未直接写主题或身份。本轮不证明物理命中几何。
- 模式/候选应用无新增error/exception，后端error0；warning正控成功捕获。独立空数据冷启动有1条“读取最近会话失败”，错误面板明确no_active_agent/no active agent configured，非本轮候选操作错误；未改单外代码或额外配Agent，不能声称全生命周期零报错。
- 收尾回modern-gui默认，核对路径后关闭独立实例PID24468。完整候选、材料和错误证据在仓外 `03b23-webview-evidence.json`。

### 交付状态

两续单施工与验证已补齐，待翻译独立核验。此前“全量测试、真机和完工记录尚未完成”三项现由本节和最终回单覆盖。遗留为独立空数据无Agent冷启动提示；未暂存、未commit、未push、未开PR；原历史段落与施工单不改。

## 翻译独立验收与本批送审（2026-10-15）

- 署名：607-翻译。用户授权将刀1、刀2、刀3a及接续、刀3b及两续单合为本批草稿PR；本批不彻底关闭#607。刀4首启对齐、契约快照与说明书同步尚未施工，不在本次已完成结论内。
- 当前共享源码按顺序独立重跑：`bun run lint`、`build:example-plugin`、`build`、`check:solid`、`test`全部EXIT=0；`Test Files 690 passed | 1 skipped (691)`、`Tests 5409 passed | 1 skipped (5410)`。CSS1249类、可达1096、豁免153、不可达0；import环852文件/3270边/基线10环零外逃。
- 仓外临时副本独立反向：空排除集、不接中控档案、改坏inputRadius均触发目标断言红；新增五例及两份增补守卫均有红证据。恢复四文件39例全绿；名单删整条is-族，完整`check:solid`EXIT=1（七条is-*不可达），恢复完整链EXIT=0。恢复两SHA256与工作者记录一致。
- 从当前源码重新`build`、`cargo build`后启动全新独立数据实例。真实Tauri/WebView2，三桶样式/配色/中控8/5/8、5/5/5、1/1/1，九行重名0；三套中控逐一使用真实鼠标press/release，命中检测均true，15材料键误差0，材料外字段变化0，其它区记账不变，身份变化0。
- 仍保留空数据未配置Agent的启动错误`no_active_agent`；候选应用和模式操作新增error/exception0、后端error0，日志warning正控捕获。不是全生命周期零报错。
- 收尾回modern-gui默认，核对exe路径后关闭验收PID11604；验收结束共享源码与起点副本逐文件差异0，index与diff检查EXIT=0。随后本段仅更新验收/送审记录，不改产品代码。
- 本地完整命令、反向红、恢复指纹与真机读数：`E:\Acode\FILES\任务\预设修正\报告等\03b-施工单-档案退役\2026-10-15-翻译验收报告-两续单与增补.md`及同级独立核验目录。该本地报告不随PR上传。
- 送审与后续边界：档案注册表、插件registerProfile能力、kindTokens/assets、activeProfileId及身份CSS保留；区域行仅应用材料，不承诺整键外观复现。蓝调标签`tactical-默认`暂保留。
- 最终送审跟进main@81b95808，合流存档ae311d8e，只有交流板冲突，保留双方条目；相对main无后端/CI改动。在英文路径临时worktree按序重跑五步全部EXIT=0，690文件/5409用例passed、1 skipped。首次中文路径运行因既有B-04测试直接用URL.pathname读取文件而ENOENT（src/domains/theme/__tests__/B-04-visual-conformance.test.ts:6），未改单外测试；保留失败日志，移至英文路径完整复跑绿。合流前后本线产品源码字节未变，真机结论范围不扩展为合流后的后端验证。
