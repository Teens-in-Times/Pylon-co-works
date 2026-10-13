# Dev Record — #607 刀2：双引用与完整默认落点准备

## 元信息

- issue：#607（本刀不关闭；生产接线与档案退役尚未实施）
- 分支：`feat/mode-landing.1`
- 基线：`5ee2cc34`；本刀未暂存、未提交、未推送、未开 PR。
- 日期：2026-10-12
- 规格：刀2正式 v2；旧默认非预设载荷先经过 `filterPresetTheme`，`rightWidth` 保留完整 `DEFAULTS` 的 260。02a 接续单仅修测试与记录（解除 Git 跟踪状态依赖），数据/实现未改。

## 目标与范围

新增内部 chat 两轴、独立区域材料、引用校验解析与三个完整默认纯计划。生产候选、全局应用、切换、重置、旧索引、字段归属与持久化全部保持旧行为。无 UI/CSS/后端改动，不宣称默认上线。

## 改动清单

| 新文件 | 职责 |
| --- | --- |
| `src/domains/theme/zones/chatPresetAxes.ts` | 按字段类型分类并克隆分轴值 |
| `src/domains/theme/zones/presetReferencePlan.ts` | 新引用类型、材料所有权与轴校验、严格复合键解析 |
| `src/domains/theme/zones/factory/landingEntries.ts` | 模块级来源克隆、拆轴、默认材料构建与深冻结 |
| `src/domains/theme/presets/modeDefaultReferences.ts` | 三隐藏引用成员与显式模式查询 |
| `src/domains/theme/zones/modeLandingPlan.ts` | 纯默认计划、旧边线归属适配、单区轴取值 |
| `src/domains/theme/zones/__tests__/chatPresetAxes.test.ts` | 分类、拒绝非法键、19份拆合与顺序守卫 |
| `src/domains/theme/zones/__tests__/presetReferencePlan.test.ts` | 六引用、隔离、非法引用、所有权与旧装配合法性 |
| `src/domains/theme/zones/__tests__/modeDefaultReferences.test.ts` | 完整基准、数据计数冻结、纯计划、来源/显式输入池调用前后不变守卫（02a 起不读 git） |
| `.agents/records/issue-607-knife2-preset-references.md` | 本记录 |

## 方案要点

1. chat 的 color 字段归配色，其余 chat 参数归样式；未知键和非 chat 键拒绝，不以 UI 分组判定。
2. 独立新集合保留旧 factory 的来源身份；原 chat 拆两条，其他区域复制时过滤非预设管理字段。只有 `inputBorderColor` 使用精确待迁 cc 合同；旧 global 原材料此键移至新 cc 材料，不通用放宽越区校验。
3. 九份 profile chat 拆两轴；样式条目用 `styleMaterial.profileId` 关联尚未迁移的 assets/kindTokens。配色不携带该身份。profile cc 单条补边线，旧18条原样保留。
4. 默认构建仅在模块求值时临时组合固定来源并拆为六条区域材料；不导出或保留第二张整份默认 theme 表。默认定义只有 name/label/mode/refs/hidden。
5. 解析以 `(mode, zone, axis, id)` 查显式传入集合，拒绝重复复合键、缺失、错误桶/区/轴；材料同时按 zone、预设白名单校验。返回克隆的五区切片、两 chat 身份与值。
6. 完整计划先合并 chat 双轴为一个切片，再把待迁边线适配回旧 global 位置，交既有纯装配校验与 reducer。完整 DEFAULTS 补非预设管理/meta 值；不传 profileTokens，不读现场记忆。

## 验收标准与结果

| 项目 | 实测 |
| --- | --- |
| chat 全集 | 40 color + 37 style = 77；交集 0 |
| 旧chat与profilechat拆合 | 10+9=19份逐键相等，应用顺序一致 |
| 独立材料 | factory chat 20、其他 factory 40、profile chat 18、profile cc 9、默认 18；合计105，唯一复合键105 |
| 三默认 | 每个五区六引用；完整180键、预设管理175键 |
| 非预设字段 | rightWidth=260、sidebarWidth=250；区域条目不含这两键或 meta |
| 旧默认过滤 | GUI/终端各排除 rightWidth（owner=right-rail）；旧表250不变 |
| 边线 | 新材料唯一属cc；旧定义仍global；适配后逐切片通过旧所有权校验，合并值不变 |
| 隔离 | 材料深冻结、来源对象不共享；解析/计划结果可独立修改，不污染下一次调用 |
| 旧生产 | 旧50/刀1 18、候选、蓝调未登记默认、chips仍旧；30个已跟踪相关文件与5ee2cc34字节相同（仓外脚本核查证据，不是 Vitest 断言）；git已跟踪diff空 |
| 生产接入 | 旧生产模块对新模块引用为0；没有store/偏好/写状态能力 |

## 蓝调值来源

以下仅对应主题变量原值，不代表最终像素色；都来自 `builtin.pylon-shell/styles/App.css` 的 tactical-blue scoped 变量块。

| CSS变量 | 字段 | 值 |
| --- | --- | --- |
| `--accent` | accent | #65dfff |
| `--titlebar-bg` | titlebarBg | #080e19 |
| `--titlebar-text` | titlebarTextColor | #f4f8ff |
| `--sidebar-bg` | sidebarBg | #0c1728 |
| `--sidebar-text-color` | sidebarTextColor | #c2d0e3 |
| `--chat-bg` | chatBg | #080f1e |
| `--chat-text-color` | chatTextColor | #eef5ff |
| `--msg-text` | msgTextColor | #eef5ff |
| `--right-bg` | rightBg | #101c30 |

边线固定值来自旧 `builtinPresentationProfiles` 的各 profile.tokens.inputBorderColor，测试九份逐个对拍。

## 测试处置

既有测试零修改零删除。新增三文件11项用例：

- chatPresetAxes：全集40色37样式互斥，隐藏字段及非色视觉参数按字段类型分类；未知和非chat键拒绝，不静默丢弃；19份原料拆合保真且同值身份不折叠，两轴应用顺序完全相同。
- presetReferencePlan：五区六引用严格校验，缺轴空值多余区域与轴拒绝；三隐藏成员按同桶同区同轴解析为五切片，返回值与来源隔离；缺失错桶错区错轴重复键及非法定义拒绝，无外部修改；新材料越区越轴非预设字段拒绝，边线只归cc且旧漏斗逐键合法。
- modeDefaultReferences：三默认逐字段保真覆盖完整DEFAULTS，非预设宽度260且结构归一清账；材料数量唯一且深冻结隔离，九边线与样式非标量来源逐份正确；计划不读现场或记忆，返回结构可独立修改且缺完整默认拒绝；新隐藏默认不泄漏旧候选chips，旧50旧18与来源/输入池调用前后不变（02a 起为纯内存断言，不读 git 跟踪状态与历史存档）。

每个新用例分别改坏授权新实现，11/11出现 AssertionError（无 TypeError/类型失败代替）；每次先备份，恢复SHA256一致11/11。突变依次为：全归style、未知键放行、样式切片丢失、引用校验旁路、双轴身份对调、重复键放行、所有权校验旁路、宽度错成250、取消冻结、模式查询丢GUI、隐藏标记false。探针全部恢复后顺序重跑五步。

## 证据

最终命令及真实输出：

```text
$ bun run lint
EXIT=0
$ bun run build:example-plugin
[build-example-plugin] dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建
EXIT=0
$ bun run build
✓ built in 10.88s
EXIT=0
$ bun run check:solid
Solid Workbench 边界检查通过；扫描 182 个源码文件
ZONE_FIELDS 一致性契约通过（177 个主题字段，排除元字段：appliedPreset, custom, ccEditMode）
EXIT=0
$ bun run test
Test Files 688 passed | 1 skipped (689)
Tests 5384 passed | 1 skipped (5385)
EXIT=0
```

定向命令：`bun run test src/domains/theme/zones/__tests__/chatPresetAxes.test.ts src/domains/theme/zones/__tests__/presetReferencePlan.test.ts src/domains/theme/zones/__tests__/modeDefaultReferences.test.ts`：3文件11项通过。比刀1增加3文件11项（685→688，5373→5384），跳过数不变。

开工：`git status --short --branch` 干净；`git -c http.sslBackend=schannel fetch origin` 后 `git rev-list --count HEAD..origin/main`=5，新增上游改动无本单文件交集，保留明确授权的5ee2cc34基线；只读 `gh issue view 607 --repo Teens-in-Times/Pylon-co-works --json number,title,comments`。未合并主干、未写远端。

自审命令：`git status --short --branch`、`git diff --name-only`、`git diff --cached --name-only`、`git diff --check`；已跟踪与暂存diff均空。新5模块无运行时store/写入口；旧生产import新模块0处。

## 与规格的偏差及过程红灯

无范围/方案偏差。首次定向测试的布局字段误写widgets产生TypeError，改为真实placements后定向11/11绿；首次build发现非法输入测试的多余theme字面量类型错误、只读数组复制返回类型错误，修于授权新文件后build EXIT=0。过程红不计作反向红，最终门禁已在恢复后重跑。

静态门禁部分扫描只覆盖Git已跟踪文件；本刀文件未暂存，相关扫描不能证明新模块全覆盖。类型检查、eslint src/、直接路径运行的测试覆盖新文件；另以脚本检查新模块写入口与旧生产引用。成品拼装有既有Solid JSX transform警告，全量测试有故意失败场景的stderr；最终退出码均0。

## 02a 接续修正（解除 Git 跟踪状态依赖）

刀2 v2 最后用例曾用 `git ls-files` + `git show 5ee2cc34:<path>` 做旧路径逐字对拍。该断言依赖工作树跟踪状态：新 factory 文件提交后进入扫描列表，而刀1 存档没有它（`fatal: path 'src/domains/theme/zones/factory/landingEntries.ts' exists on disk, but not in '5ee2cc34'`，EXIT=128），浅克隆 CI 也未必有该对象。02a 按接续单只动测试与记录：

- 最后用例更名「新隐藏默认不泄漏旧候选chips，旧50旧18与来源/输入池调用前后不变」；删除 `node:child_process` / `node:fs` 导入与 git 扫描、固定存档对拍块，其余 3 用例未动。三份新测试文件对 git 子进程的引用为 0。
- 保留原隐藏默认/旧候选/旧50与旧18 行为守卫，另补两层行为断言：①克隆 `FACTORY_ZONE_PRESET_ENTRIES`(50)、`FACTORY_PROFILE_ZONE_PRESET_ENTRIES`(18)、`DEFAULT_PRESETS.gui/terminal`、`INTERFACE_MODE_PRESET_BUCKET` 及可变 `structuredClone(LANDING_PRESET_ENTRIES)` 输入池作为调用前快照；②三模式 `planModeDefault` / `resolveModePreset` 显式消费该池（与模块来源同输入结果一致），调用后输入池与四类来源都逐对象等于快照。该断言只证来源/入参未被修改，不冒充仓库全部旧路径无 diff。
- 旧路径 30 文件逐字对照、tracked/staged diff、生产引用新模块仍由仓外脚本核查（`02a-boundary-check.py`），不是 Vitest 能证明的性质。

反向验证（新增断言；探针授权仅 `presetReferencePlan.ts`）：`resolveModePreset` 内临时插入
`if (!Object.isFrozen(pool)) Reflect.set(pool[0], 'label', '探针污染')`——只写显式传入的可变克隆池，冻结原生产来源跳过、不产生 TypeError，也不改 expect 造假红。真实红：

```text
新隐藏默认不泄漏旧候选chips，旧50旧18与来源/输入池调用前后不变
AssertionError: expected [ Array(105) ] to deeply equal [ Array(105) ]
src/domains/theme/zones/__tests__/modeDefaultReferences.test.ts:140:18
expect(pool).toEqual(poolSnapshot)
```

同次 1 failed / 3 passed：红只落新增断言。探针前与恢复后 SHA256 均为 `b53c1cf4142dca73e047af792846c165ea88ac71d8c799c37a7f2b34e4c9c96c`，与备份逐字节相同。用例数量仍 11（三文件 3+4+4）：本次是**同条用例内新增断言**，不是新增独立用例；v2 的 11 项反向红仍是原 11 条断言各自的证据，新增断言另做了本次第 12 项探针。

恢复后按序重跑五步（日志 `02a-证据/02a-gate-*.log`）：

```text
lint EXIT=0
build:example-plugin EXIT=0
build ✓ built in 10.52s EXIT=0
check:solid EXIT=0
test 688 passed | 1 skipped (689)；5384 passed | 1 skipped (5385) EXIT=0
```

验证限制：Vitest 证明的是「当前内存来源与显式输入池在调用前后不变」，仓外脚本证明的是「当前工作树 30 个旧路径与 5ee2cc34 逐字节相同、tracked/staged diff 空、生产引用新模块 0」；两者都不等于源码永久零变化——提交后应在提交对象上复跑仓外对照。三份新测试文件在剥掉 git 的 PATH 下运行仍 3 文件 11 项全绿（`02a-gitless-path-run.log`），佐证测试不再外调 git。

## 未解问题 / 后置接线清单

- 刀3接入新引用与生产候选、蓝调模式桶、全局应用/切换/重置/两轴记账保存删除；删除旧合同与inputBorderColor阶段适配，真正迁移字段归属/旧数据/消费者。
- assets/kindTokens只保留样式来源身份，未接入消费者；三Agent完整体验尚不能由本刀标量计划替代。原档案及插件能力保留，删除前专项核查。
- 蓝调直接CSS（标题栏#06152bd9、侧栏#071831ed、app#061333、场景/菜单/装饰）、surface/public border、退役--cc-bg别名未搬未改，不能猜成主题字段。
- 刀4首启、契约快照与说明书同步；本刀生产无变化，不改说明书/旧快照。
- 本刀按单免Rust/clippy、免真机；刀3真实接线必须真机验收，不能继承该豁免。
- 待翻译独立核验，不关闭#607。

## 并行交集

仅上述九个新文件，旧源码/数据/测试、公用板与说明书无修改；没有暂存或提交他人改动。
