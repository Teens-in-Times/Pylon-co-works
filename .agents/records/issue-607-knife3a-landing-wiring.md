# Dev Record — #607 刀3a 统一接线（界面模式取值收敛到区域预设引用单）

> 入库保留。规格文档不保留；目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-607-knife3a-landing-wiring.md`
> 施工单：`E:\Acode\FILES\预设修正\界面模式落点收敛\03-施工单-刀3a-统一接线.md`

## 元信息

- issue：Teens-in-Times/Pylon-co-works#607（界面模式落点收敛线 · 第三刀前半）
- 分支：`feat/mode-landing.1`（基线 HEAD `1fe3088a` = 刀2 存档）
- 提交范围：未提交（工作者不 commit；`1fe3088a..工作树`）
- 日期：2026-10-13

## 目标与范围

**要达成**（施工单 §2）：出厂 10 套预设的有效值改由**落点材料**解析（值逐字段不变）；
三张 Agent 卡的档案货物并进 `preset:*` 合并材料（应用时不再现场叠档案）；
切换/重置 = 应用本大类**隐藏默认单**（同一条路径、整份换装 + 清账）；
`activeProfileId` 取自生效的消息流样式单材料；消息流区域行拆**两行**（样式/配色）且自定义条目带轴；
蓝调战术补入桶表。

**不做**：不删档案机制一行代码（`BUILTIN_PRESENTATION_PROFILES` / 注册表 / 插件 API /
`profileByMode` / `rememberProfile` / `PresentationProfilePicker` / `presentation.*` 命令 /
`GlobalPreset.presentationProfileId` 字段与数据全保留，删除留刀3b）；不改任何预设值；
不动 CSS 家族；不动 `ccLayout` 手动编辑；不动 `src-tauri/`；不改 `docs/说明书` 之外的公用文档。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/presetReducer.ts` | 引用表类型 `ZoneRefMap` 改双引用（chat `{style,color}`）、`requireZoneRefs` 同步校验、新增 `CHAT_PRESET_AXES`/`ChatPresetAxis` 真值、`assembleGlobalPresetReducer` 删 `profileTokens` 收口 | 修改 |
| `src/domains/theme/presets/types.ts` | `GlobalPreset.zoneRefs` 改指 `ZoneRefMap` | 修改 |
| `src/domains/theme/presets/builtin.ts` | 10 套预设 `zoneRefs` 换新 id（`landingRefs`）、`INTERFACE_MODE_PRESET_BUCKET` 补 `tactical-blue` | 修改 |
| `src/domains/theme/zones/factory/landingEntries.ts` | 新增 `preset:*` 合并落点家族（9 条 = 工厂 ⊕ 档案） | 修改 |
| `src/domains/theme/zones/presetReferencePlan.ts` | 引用校验复用 `requireZoneRefs`；`ModePresetRefs` 改为 `ZoneRefMap` 别名 | 修改 |
| `src/domains/theme/zones/effectivePresetTheme.ts` | 有效值视图换源：走 `presetReferencePlan` + 落点材料（消息流并两轴） | 修改 |
| `src/domains/theme/zones/modeLandingPlan.ts` | 新增 `planModeDefaultForInterfaceMode` + `ModeDefaultPlan`（界面模式 → 整份默认计划 + 样式单身份） | 修改 |
| `src/domains/theme/zones/zonePresetPool.ts` | 池来源换落点材料（含蓝调桶以默认单出候选）、`zonePresetsFor` 支持按轴、读入归一并轴/来源/蓝调 | 修改 |
| `src/domains/theme/zones/index.ts` | 门面补导出（`LANDING_PRESET_ENTRIES`/`FACTORY_POOL_ENTRIES`/`chatPresetAxes`） | 修改 |
| `src/domains/theme/themeStore.ts` | 新增薄壳 `applyLandingPlan(plan, source)`；`resetTheme` 注释说明其现役落点 | 修改 |
| `src/domains/theme/settingProvenance.ts` | 新增写来源 `interface-mode`（界面模式） | 修改 |
| `src/domains/theme/customPresetStore.ts` | `saveZonePresetEntry` 收 `axis`，消息流按轴取快照 | 修改 |
| `src/application/transactions/applyGlobalPreset.ts` | chips 换新材料解析 + 显式 `appliedName`；删档案读取（`presentationProfileId`/`profileTokens`）、身份改从材料取 | 修改 |
| `src/application/transactions/activateInterfaceMode.ts` | 切换/重置改走 `applyModeDefaultLanding`（同一条路径、整份换装、身份从材料取） | 修改 |
| `src/components/Settings.solid.tsx` | 「存当前」透传轴 | 修改 |
| `src/components/settings/ZonePresetSection.solid.tsx` | 消息流拆两行（样式单 / 配色单） | 修改 |
| `src/components/settings/settingsSectionShared.solid.tsx` | `ZonePresetRow` 收 `axis`/`title`，候选按轴取 | 修改 |
| 新增测试 ×3 | `mergedPresetLanding.test.ts`、`modeDefaultLanding.test.ts`、`Settings.chatPresetRows.solid.test.tsx` | 新增 |
| 改写测试 ×13 | 见下「测试处置」 | 修改 |

## 方案要点

1. **数据契约（施工单 §4）**：引用单指向**落点材料 id**（`factory:*` / `profile:*` / `default:*` / `preset:*`），
   消息流双引用。`preset:<名>:<区>` = 该预设 `factory` 材料 ⊕ 其绑定档案的 `profile` 材料
   （**档案值覆盖工厂值**；消息流两轴都要并——档案的 `message*Bg` 等颜色字段在配色单里），
   待迁边线 `inputBorderColor` 按默认条目同款归 cc（值取 `PROFILE_INPUT_BORDERS`）。
   绑定关系在备料文件里以本地真值表达 ⇒ **生产路径不再读 `presentationProfileId`**（字段与数据保留）。
2. **零变化证明**：应用结果逐字段等价由脚本对拍证实（10 套全部 0 差异，见证据）；有效值视图的键集变化 =
   非预设管理字段（`sidebarWidth`/`rightWidth`）移出 + 三张 Agent 卡的档案货物并入（37→56 键，逐套实测）。
3. **切换/重置同路**：`interfaceMode → modeDefaultForInterfaceMode → planModeDefault(def, LANDING_PRESET_ENTRIES)
   → themeStore.applyLandingPlan`（整份计划已含 `appliedPreset` 全 `''` / `custom` 全 `false`）；
   身份取 `resolved.chat.style.styleMaterial.profileId`。未登记模式回落整份 `DEFAULTS`。
4. **区域行**：候选 = 落点材料里 `factory:*`；`preset:*` 不进候选；消息流按 `axis` 出两行。
   蓝调桶没有工厂材料 ⇒ 以它家族里唯一的**默认单**出候选（施工单未给来源，见「与 spec 的偏差」）。
5. **两轴自定义**：`saveZonePresetEntry` 收 `axis` 并只存该轴切片；读入归一保留合法 `axis`/`source`、
   放开 `tactical`；`zonePresetsFor(..., axis)` 按轴过滤。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| §5.1 同大类切走切回 == 切走切回＋重置（值/账/结构三层，三模式各一遍） | ✅ 单测 3 例 + 真机重置取证 |
| §5.2 切换/重置后 `appliedPreset` 全 `''`/`custom` 全 `false`、无假账 chip | ✅ 单测 + 真机（`customChips=0`） |
| §5.3 混搭成立、另存后可复现、条目带轴、刷新后仍在 | ✅ 单测 + 真机（两区各记材料 id；另存条目 `axis:'style'` 37 键） |
| §5.4 三张 Agent 卡应用后主题字段与本单前逐字段相同、`activeProfileId` 相同 | ✅ 脚本对拍 0 差异 + 真机（档案货物含配色 4 键、工厂/档案冲突取档案值） |
| §5.5 无默认单的模式回落整份 DEFAULTS，不报错、不悬空 | ✅ 纯层单测 + 插件模式集成测试（注册表真实链路） |
| §5.6 蓝调区域行可见、可切换/重置/存自定义；chips 家族为空不报错 | ✅ 单测 + 真机（两行各一条「tactical-默认」；全局预设组 chips 为空） |
| §5.7 五步门禁 + 真机三模式目视 | ⚠️ lint/build:example-plugin/build/test 绿；**check:solid 红 1 处**（import 环基线，见未解问题）；真机三模式 + 重置已取证（未做「与改前并排目视」） |
| §5.8 全仓 grep 未删档案机制符号 | ✅ 六个符号命中数 35/17/8/20/9/20，三个档案文件仍在 |

## 测试处置

**施工单 §7 点名的（逐个）**

- `zones/__tests__/modeDefaultReferences.test.ts`：材料总数 105→114、工厂 chat 计数与 `preset:` 家族新断言；隐藏/来源守卫保留（桶表断言改 `tactical`）。
- `zones/__tests__/modeLandingData.test.ts`：候选口径改「材料供给」；越区闸门改为「待迁边线是唯一例外」（另用真越区键 `sidebarBg` 补回强度）。
- `zones/__tests__/presetReferencePlan.test.ts`：无需改（校验已共用 `requireZoneRefs`，语义与消息保持通过）。
- `__tests__/presetAssembly.test.ts`：引用表夹具改双引用、`assembleFromRefs` 显式传 `appliedName`（对齐生产）、B5 计数 50→60 并对 `inputBorderColor` 收窄判据、`planGlobalPreset` 去掉 lookup 参数。
- `__tests__/effectivePresetTheme.test.ts`：期望值改由「工厂原材料 ⊕ 档案 tokens」独立算出；键数基线第十次按真值重算（174/63/56）。
- `__tests__/defaultPresets.solid.test.tsx`：池条数按轴（chat 10）、GUI 默认对拍加 `filterPresetTheme`（视图不含非预设管理字段）。
- `domains/interface/__tests__/interfaceMode.test.ts`：切换改为「应用隐藏默认单，档案 token 与记忆表都不参与」；蓝调那条断言改为「整份换装含配色」。
- `application/transactions/__tests__/applyGlobalPreset.test.ts`：应用链改材料来源 + 身份链断言；新增「不再挑档案/不切模式」与「无身份不写」两例。
- `zones/__tests__/factoryZonePresets.solid.test.tsx`：B1 对拍改工厂材料（独立复算规范化）、池「活数据源」改指落点材料、每格条数与 id 按材料/轴。
- `domains/theme/__tests__/settingProvenance.test.ts`：无需改（新增来源不破坏既有断言）。

**单子未点名、被 §4 契约变更连带的（逐个，理由）**

- `zones/__tests__/zonePresetPool.solid.test.tsx`：池来源换成材料 ⇒ 条数/覆盖/蓝调空池/应用切片四例重写。
- `domains/theme/__tests__/terminalPresets.test.ts`：判据从 `THEME_SETTING_KEYS` 收窄到 `THEME_PRESET_KEYS`（`sidebarWidth`/`rightWidth` 不归预设管）。
- `__tests__/presets.test.ts`、`components/__tests__/Settings.globalPresetMenu.solid.test.tsx`：蓝调补桶 ⇒ 「不在归属表内」的断言按 §2 目标 2 反转为「有桶、chips 为空」。
- `domains/interface/__tests__/pluginInterfaceMode.integration.solid.test.tsx`：第三方模式无隐藏默认单 ⇒ 切换回落 `DEFAULTS` 且不写身份。
- 新增测试 3 个文件见「改动清单」。

## 证据

- commit：未提交（工作者不自行 commit）。
- 门禁（按序，`bun run`）：`lint` EXIT=0；`build:example-plugin` EXIT=0；`build` EXIT=0；
  `check:solid` **EXIT=1**（唯一红点：import 环基线，详见「未解问题」）；`test` EXIT=0（**691 文件 / 5400 用例**，1 skipped）。
- 零变化对拍（脚本 `bun` 直跑，改造前路径 = 旧池切片 + 档案 tokens 叠加 vs 新路径 = 材料解析）：
  `总差异键数 = 0`（10 套逐套 0 差异）。
- 有效值视图逐套实测（改造前 → 改造后）：全部 7 套 `176 → 174`（−`sidebarWidth`/`rightWidth`，glass `64 → 63`）、
  三张 Agent 卡 `37 → 56`（+19 档案货物）。
- 反向验证（7 处改坏 → 红 → 恢复哈希一致 → 复绿）：
  ① 合并方向写反 ⇒ 3 例红（含 `mergedPresetLanding.test.ts:90` 「应取档案值: expected 1.68 to deeply equal 1.62」）；
  ② 身份链不更新 ⇒ `applyGlobalPreset.test.ts:56` 红；
  ③ 重置落点写死别的模式 ⇒ `modeDefaultLanding.test.ts:58/89` 红；
  ④ 默认单不清账 ⇒ `modeDefaultLanding.test.ts:61`（`global: expected 'probe' to be ''`）红；
  ⑤ 消息流保存丢轴 ⇒ `modeDefaultLanding.test.ts:139` 红；
  ⑥ chat 不拆两行 ⇒ `Settings.chatPresetRows.solid.test.tsx:38/57` 红；
  ⑦ 候选不按轴过滤 ⇒ `Settings.chatPresetRows.solid.test.tsx:47`（Found multiple elements…"Glass Light"）红；
  ⑧ 材料丢待迁边线 ⇒ `effectivePresetTheme.test.ts:177`（`claude 键数: expected 173 to be 174`）红。
  （⑧ 的第一次尝试让备料在校验期抛错、不是断言红，按铁律弃用并改成合法改坏。）
- 手工验证（真机，开发版 `bun run tauri dev` + `--remote-debugging-port=9222`，`build` 后重启；页面 `http://127.0.0.1:1430/`）：
  - 链路自检：`typeof __TAURI_INTERNALS__.invoke === 'function'` ✅
  - 重置主题（terminal-like）：`appliedPreset` 全 `''`、`custom` 全 `false`、`activeProfileId=builtin.presentation.terminal-classic`、
    `data-presentation-profile` 同步、`msgStyle=terminal`/`messageLayout=classic`/`cliHintMode=compact`/`inputRadius=0`（= 终端经典档案货物）、
    `rightWidth=260`（DEFAULTS，非旧表 250）、`sidebarWidth=250`；**记忆表 `profileByMode['terminal-like']` 仍是旧值但未被读取** ✅
  - 切现代 GUI：`accent=#6366f1`、`msgStyle=messageLayout=bubble`、`inputRadius=20`、`cliHintMode=hidden`、身份 `modern-gui`、账清空 ✅
  - 切蓝调战术：`accent=#65dfff`、`titlebarBg=#080e19`、`sidebarBg=#0c1728`、`chatBg=#080f1e`、`rightBg=#101c30`、
    `chatTextColor=msgTextColor=#eef5ff`、`messageRadius=inputRadius=3`、`inputBg=rgba(8,19,37,0.94)`、
    `inputBorderColor=rgba(119,172,230,0.45)`、`inputFocusBorder=#63ddff`、`cliHintMode=hidden`；账清空 ✅
  - 蓝调区域行：消息流两行各 1 条候选「tactical-默认」；`全局预设` 组 chips 为空（不报错、无假账）✅
  - Agent 指挥台 chips：`appliedPreset` 全 `agent-command`、无兜底假账 chip、身份 `agent-command`、
    `messageUserBg=rgba(59,130,246,0.12)`/`messageAssistantBg`/`messageReasoningBg`/`messageBorderColor`（**档案配色货物来自材料**）、
    `inputFocusBorder=rgba(99,102,241,0.72)`（工厂裸值是 `rgba(56,189,248,0.72)` ⇒ 档案覆盖工厂在真机成立）、
    `inputBorderColor=rgba(148,163,184,0.24)`（待迁边线按档案值落 cc）✅
  - 混搭：样式行点 `Glass Light`、中控台点 `Solarized Light` ⇒ `appliedPreset.chat='factory:glass:chat:style'`、
    `appliedPreset.cc='factory:solarized:cc'`，两区值同时生效（`ccBg=#fdf6e3`、`inputFocusBorder=#268bd2`、`cliHintMode=full` 来自中控单）✅
  - 两轴另存：样式行存「我的样式单」⇒ 条目 `axis:'style'`、37 键、含 `msgLineHeight` 不含 `messageUserBg`、
    只出现在样式行、已落盘 `pylon-custom-presets`；删除该条目后该区 `appliedPreset=''`+`custom=true`（既有语义）✅
  - 控制台（整轮动作窗口）只有 1 条错误：`读取最近会话失败`（与预设无关，dev 实例无最近会话）✅
  - 收尾：删掉验收期间自建的自定义条目 + 重置主题，dev 实例停在 `modern-gui` 默认单。

## 与 spec 的偏差

1. **单子 §4.2「`color` 一律 `factory:<名>:chat:color`」与 §4.1/§2.1/§5.4 相抵** —— 档案的消息流配色货物
   （`messageUserBg`/`messageAssistantBg`/`messageReasoningBg`/`messageBorderColor`）落在 `profile:<档案id>:chat:color`，
   若三张卡的配色单仍指工厂单，这 4 个键会静默丢失、违反 §5.4「逐字段相同」。**取合并材料**（`preset:*:chat:color`），
   并在 `builtin.ts` 就地注明「待裁」。
2. **单子 §4.4 只给 `factory:*` 作候选源，蓝调桶一条工厂材料都没有** —— 按字面实现会让蓝调区域行整组不渲染，
   与 §5.6「蓝调区域行可见、可切换/重置/可存自定义」直接冲突。**实现为「没有工厂材料的桶以它的默认单为家族内容」**，
   已在 `zonePresetPool.ts` 注明「待裁」。副作用：蓝调区域行的 chip 标签是材料标签 `tactical-默认`（观感待定）。
3. **chips 应用显式传 `appliedName = 预设名`** —— 引用单换成材料 id 后若不传，全局 chip 会因认不出记名而亮兜底
   「自定义」假账。单子未写，属 §4.3/§4.6 的必要连带（既有测试与新真机都据实断言）。
4. **应用预设不再切换界面模式** —— 旧路径经 `activatePresentationProfile` 顺带把模式切到该档案的 `interfaceMode`；
   本刀删掉档案读取后该副作用随之消失（模式切换归开关/选择器）。单子未写，见「未解问题」。
5. **`resetThemeForActiveInterfaceMode` 与 `themeStore.resetTheme` 并存** —— 前者已换成统一路径；后者仍是
   **首启种子**（`firstRunThemeSeed`，刀4 对齐）与 `theme.reset` 命令的落点，本刀未动（注释已说明）。
6. **空值边界**：`THEME_FIELD_OWNERS` 把 `sidebarWidth`（workspace-layout）/`rightWidth`（right-rail）划为非预设管理字段，
   故有效值视图不再携带它们（应用值仍由 `filterPresetTheme(DEFAULTS)` 铺底给出）——这是刀2 §5.B 的既定口径，不是漏字段。

## 未解问题

1. **`check:solid` 红 1 处：import 环基线过期（需授权/裁决）**。`§4.4` 要求区域行候选取自落点材料，于是
   `zones/zonePresetPool.ts` 多了一条指向 `zones/factory/landingEntries.ts` 的运行时边；材料模块
   （`landingEntries`/`chatPresetAxes`/`presetReferencePlan`/`profileEntries`/`profile-chat`/`profile-cc`）与既有的
   **zones 聚合环**（`zones/factory` 10 件 + `zonePresetPool`）合并成一个 **18 文件**的类型环，
   而 `scripts/check-import-cycles.mts` 的 `BASELINE_CYCLES` 里那条记为 12 成员 ⇒ 报「新增 type-only 环（18 文件）」
   + 「基线条目已无对应计算环」。该基线属**公用基建**（ACh 线），按准则我未改。
   两条出路：**(a)** 把那条基线条目按 18 文件扩成员（清单见上）；**(b)** 把工厂材料的构建下沉到
   `zones/factory/index.ts` 可直达的位置以消掉这条边（工作量更大，且蓝调候选仍无合法来源）。
2. **蓝调区域行候选来源**（见偏差 2）需要与 (1) 一并裁决。
3. **chips 应用不再切模式**（见偏差 4）：若认为「模板库里点终端桶预设应切到终端模式」，需另定落点。
4. 真机验收只做了「当前状态数值取证」，**没有与改造前并排目视**；本刀未动任何 CSS 文件（`git status` 无 CSS），
   故「输入栏/折叠外观与改前一致」以「CSS 未变 + `data-presentation-profile` 仍供值」间接成立。
5. 蓝调区域行 chip 标签 `tactical-默认` 是材料原标签，观感可后续定名。

## 并行交集

- `src/domains/theme/zones/**`（池 / 材料 / 引用解析 / 有效值视图 / 默认计划）
- `src/domains/theme/presets/**`（引用单、桶表）、`presetReducer.ts`、`themeStore.ts`、`customPresetStore.ts`、`settingProvenance.ts`
- `src/application/transactions/{applyGlobalPreset,activateInterfaceMode}.ts`
- `src/components/Settings.solid.tsx`、`src/components/settings/{ZonePresetSection,settingsSectionShared}.solid.tsx`
- 未碰：`src-tauri/**`、任何 CSS、`docs/说明书/**`、`src/plugins/core/renderer/builtinPresentationProfiles.ts`（档案本体）。
  `scripts/check-import-cycles.mts` 由接续单（见下）单点改动一条基线条目。

---

## 接续修正 · 环基线登记（2026-10-13，接续单 `03a-接续单-环基线登记.md`）

- **用户裁决**：走方案 (a)「扩基线」，不以改结构消环（方案 (b) 未采纳）。
- **改动**（**仅** `scripts/check-import-cycles.mts` 一条条目）：`BASELINE_CYCLES` 的「theme/zones 聚合环（S1-P2）」
  `members` **12 → 18**（新增 `zones/chatPresetAxes.ts`、`factory/landingEntries.ts`、`factory/profile-cc.ts`、
  `factory/profile-chat.ts`、`factory/profileEntries.ts`、`zones/presetReferencePlan.ts`）；
  `note` 改写为「构成（zones/factory 11 件含 index ＋ zonePresetPool 互引；#607 刀3a 起并入落点材料构建与引用解析，
  type 闭合、无运行时风险）＋ 刀3b 退役档案后复核收紧」；`runtimeClosed` 保持 `false`。
  `git diff --stat -- scripts/check-import-cycles.mts` = **7 insertions / 1 deletion**（只此一条条目；
  判定逻辑、其它条目、阈值、输出格式零改动；零 `src/` 改动）。
- **五步门禁（按序）**：`lint` **EXIT=0** ／ `build:example-plugin` **EXIT=0** ／ `build` **EXIT=0** ／
  `check:solid` **EXIT=0** ／ `test` **EXIT=0**（**691 文件 / 5400 用例**通过、1 skipped —— 与刀3a 同数字，未回退）。
  `check:solid` 通过行原文：

  ```text
  import 环门禁通过：生产文件 855 个、边 3293 条；基线 10 环（RUNTIME 闭合 1 环）零外逃；生产禁入测试资产条款通过（例外边 1 条）
  ```

  该行同时含「基线 10 环」与「零外逃」，且输出里**不再出现**「新增 type-only 环」「基线条目已无对应计算环」。
- **脚本自检**（`assert.*` guard-the-guard，每次执行都跑，属既有自检非新增测试）：全通过 ——
  直接跑 `bun scripts/check-import-cycles.mts` 无任何断言输出、以通过行收尾。
- **反向验证（证明门禁仍会抓新环）**：备份 SHA256 `ef26c19af207068a45e8e320877990b38e42fa3e00e863fcaf95c1909e4c9837`
  → 临时**删掉**该条目 ⇒ `check:solid` **EXIT=1**，原文报「新增 type-only 环（18 文件，需 type 边闭合；级别低于
  RUNTIME 环但同样基线外）」＋ 18 成员清单 ＋「（基线 9 环）」；恢复后 `sha256sum -c` **OK**、
  `git diff --stat` 仍只剩授权改动 ⇒ `check:solid` **复绿 EXIT=0**。未用改阈值/改判定/只改文案制造假绿。
- **翻译验收追认（照录）**：
  1. 单子 §4.2「`color` 一律 `factory:<名>:chat:color`」与 §4.1/§2.1/§5.4 相抵 ⇒ **配色单材料来源以工作者取法为准**
     （`preset:*:chat:color`，否则档案的 4 个消息配色键静默丢失）；
  2. 单子 §4.4 未给蓝调区域行候选来源 ⇒ **以「没有工厂材料的桶以它的默认单为家族内容」为准**；
  3. 连带改写测试追认 5 个（`zonePresetPool.solid` / `terminalPresets` / `presets` /
     `Settings.globalPresetMenu.solid` / `pluginInterfaceMode.integration.solid`）与单外源码追认 3 个
     （`zones/index.ts` / `presetReferencePlan.ts` / `settingProvenance.ts`）。
- **两条行为变化（已如实上报用户）**：① chips 应用不再顺带切换界面模式（旧路径经 `activatePresentationProfile` 顺带切，
  本刀删档案读取后消失）；② 中控区域行会写 `inputBorderColor`（待迁边归属的既定方向）。
- **遗留**：蓝调区域行 chip 标签 `tactical-默认` 命名待用户定；刀3b 退役档案后材料集会变，届时复核并收紧本条目。
- 日志：`E:\Acode\FILES\任务\预设修正\报告等\03-施工单-刀3a-统一接线\` 下 `2026-10-13-03a2-*.log`（门禁 5 份 + 反向 2 份）。
