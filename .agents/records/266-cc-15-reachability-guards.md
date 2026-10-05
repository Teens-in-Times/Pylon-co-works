# Dev Record — #266 CC-15 死面正向审计守卫（字段可达性 + CSS 类名可达性）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/266-cc-15-reachability-guards.md`

## 元信息

- issue：#266（CC-15 · 总账）；施工单：`E:\Acode\FILES\任务\工作台优化\待办\25-施工单-CC-15死面正向审计守卫.md`
- 分支：`fix/cc-15-reachability-guards.1`（自 `origin/main` ea47b797 新建，已 unset-upstream）
- 提交范围：**未提交**（用户当次指令「不 commit、不 push、不开 PR」；本记录落盘时全部改动在工作树在途）
- 日期：2026-10-05

## 目标与范围

把「新冒出来的死面无人抓」缺口制度化：两层**正向**死面审计进门禁链（现有守卫均为黑名单式）——

1. 主题字段级：`THEME_FIELD_KEYS` 每键必须有真实读取链（var 消费 / 生产源码点访问 / 语义源豁免 / 名单豁免），零读取即红（CC-08 select 型死字段案例的制度化）。
2. CSS 类名级：src/ 全部 .css 的选择器类名必须生产可达（TS 生成点 / 跨 CSS 引用 / 拼接家族豁免 / LEGACY 存量登记），新死类名即红（CC-31 手工扫描的守卫化）。

**不做**：不删任何存量（清理是后续单）；不做导出级扫描（用户拍板第一刀不含）；不动 `check-css-var-consumption` / `check-theme-field-consistency` 现有判据；不碰 `src-tauri/`；不引入新依赖。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/check-theme-field-reachability.mts` | 全文件：walk 扫描面（剔 `__tests__`/`__fixtures__`/`ui-demo`）→ a/b/c 三判据 → `REACHABILITY_ALLOWLIST`（1 条）→ 正控 assert + `POINT_AT_BANNED` 自检 | 新增 |
| `scripts/check-css-class-reachability.mts` | 全文件：选择器上下文类名提取（状态机 + 剥注释/url/字符串）→ TS token 整词比对 → `SPLICE_FAMILIES`（11 族，含来源文件防烂正控与第三方包正控）→ `LEGACY_UNREACHABLE`（96 条逐条理由）→ 正控 + 自检 | 新增 |
| `package.json` | `check:solid` 链：`check-css-var-consumption.mts` 之后、`check-theme-field-consistency.mts` 之前插入两个新脚本 | 修改 |

## 方案要点

- **字段判据**：a=注入 var 被 `var()` 消费（复用 `THEME_CSS_VAR_MAP` 口径）；b=生产源码点访问 `\.key\b` + 方括号 `['key']`（剥注释、两侧边界锁死防短键裸子串）；c=`semanticSource: true` 豁免（消费点 `themeCssSnapshot.resolveRoleValues` 动态遍历，静态不可见）。证据面排除 `themeFieldDefs.ts`/`themeTypes.ts`（定义不算读取）。
- **类名判据**：CSS 只从选择器上下文提类名（剥注释/`url()`/引号串，从根上消掉 `content:"."`、`.5`、字体扩展名噪音）；TS 证据 = token 全集整词比对；跨 CSS 引用 = ≥2 个 CSS 文件出现。
- **token `$` 粘连修正（施工中抓到的自坑）**：`` `search-hit${cond}` `` 曾被切成 `search-hit$` 吞掉证据（假红 17 项）。修法 = `${` 前补边界，但前一个是 `-` 的不拆（`` `term-row-${kind}` `` 的裸前缀不得放行）。翻转项抽样 6 个实读源码确认为「裸类名 + 条件后缀」活形态。
- **家族豁免防烂正控**：值域来源文件（仓相对路径直读，含跨语言 Rust 文件）必须存在且仍含模板前缀；第三方值域控包目录存在。模板改/文件删/包删 ⇒ 红。
- **裁定往返结论（2026-10-05 翻译核定）**：三块豁免全过；`is-`/`type-` 维持前缀豁免（理由补「位点存活但值域变化时须同步审 CSS 对应规则」）；跨 CSS ≥2 文件判活维持；**`ui-demo/` 剔出扫描面**（两脚本 walk 同改），UiDemo.css 2 条 LEGACY 撤销。
- **ui-demo 剔除的连带发现**：`model-menu`（ControlCenter.css:85 `:has()` 引用）唯一 token 证据原是 ui-demo 的 overlay id 字符串，剔除后现形为死类（现行模型菜单是活类 `cc-model-menu`）——按已裁定的存量框架收编 LEGACY，存量 95→96。
- 扫描面口径：`src/` 生产文件；dist/docs/examples/public 与禁区 `ui-demo/` 不在面内；src-tauri 生成点不在 .ts/.tsx 判据面，相应类名走名单带理由（`footnote-backref` ← `src-tauri/pylon-markdown/src/parser.rs:151`，只读验证）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 两脚本进 check:solid 链且全链 EXIT=0 | ✅ `check:solid` EXIT=0，两脚本汇总行见证据 |
| 现状报告三数分列 + 豁免清单逐条理由 → 裁定往返已过 | ✅ 字段 178=163 可达+15 豁免+0 可疑；类名 1288=1136+152+0（收口后终值）；裁定回带 2026-10-05 |
| 故意违反自检红输出各一条 | ✅ 两脚本 `POINT_AT_BANNED=1` 均红 + EXIT=1 |
| 全量 test 用例数 = 基线 ±0 | ✅ 5207 passed + 1 skipped（5208）；对 `origin/main` 的 diff 仅 package.json 1 行 + 2 新脚本，`src/`、`shared/` 零改动 |
| 门禁五步 EXIT=0 | ✅ lint / build:example-plugin / build / check:solid / test 全 0 |
| 开发记录已落 | ✅ 本文件 |

## 测试处置

- 既有测试：未改未删（本单不碰生产代码，与「±0」一致）。
- 新增 vitest 用例：无。两脚本是门禁脚本，反向验证按施工单 §八 以「故意违反自检」代替（`POINT_AT_BANNED=1` 死探针必红）。
- 防空转正控（脚本内置 assert）：字段侧扫描面/判据集/var 消费集下限；类名侧扫描面/类名集/token 集下限 + 家族名单健康检查。

## 证据

- commit：未提交（工作树在途；`git status --short` = `M package.json` + 2 个 `??` 脚本）
- 门禁：`lint` EXIT=0；`build:example-plugin` EXIT=0；`build` EXIT=0（✓ built in 22.91s）；`check:solid` EXIT=0（含 `字段可达性审计通过（字段 178…零读取 0）`、`CSS 类名可达性审计通过（类名 1288：可达 1136 / 豁免 152（家族 11 族 + 存量 96），不可达 0）`）；`test` EXIT=0（5207 passed | 1 skipped，Test Files 667 passed | 1 skipped）
- 自检：`POINT_AT_BANNED=1` 两脚本各报「已知死探针被判为不可达」并 EXIT=1
- 完整输出与裁定往返记录：`E:\Acode\FILES\任务\工作台优化\报告等\25-施工单-CC-15死面正向审计守卫\2026-10-05-工作者汇报.md`
- 实机复验（翻译侧待做）：本地各跑一次新脚本核对读数；临时造死字段/死类名验证真能红（跑完即撤）。

## 与 spec 的偏差

- 施工单预期「存量 97 条」随裁定演进为 **96 条**：ui-demo 剔除撤销 2 条、连带现形收编 `model-menu` 1 条（理由见方案要点；已在回单向翻译显式报告，非静默变更）。
- 裁定把「剔除 ui-demo」落到**两脚本**的 walk（裁定原文语境是类名脚本；字段脚本同规则剔除以保持禁区口径一致，字段读数不变）。

## 未解问题

- LEGACY 96 条 + 字段 `sidebarGroupSize` 的**清理是后续单**（本单只拦增量）。
- `cm-`/`is-`/`type-` 家族前缀较宽：未来这些前缀下的新死类会被家族豁免，需靠家族理由里的「值域变化须同步审 CSS」提醒 + 定期复核。

## 并行交集

- 共享文件仅 `package.json`（`check:solid` 行），其余为两个新增脚本文件，无在途冲突面。
