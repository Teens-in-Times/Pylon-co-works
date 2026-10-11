# Dev Record — #600 code-stats 文件集与统计准确性修复

## 元信息

- issue：[#600](https://github.com/Teens-in-Times/Pylon-co-works/issues/600)
- 署名：Codex
- 分支：codex/code-stats-accuracy
- 基准：15659279（github/main）；施工声明：9f81ccd9；实现提交：95446dd9
- 日期：2026-10-11

## 目标与范围

用户要求修复「很不准确」的代码量 skill，前序统计要求使用 Git、排除字体与二进制。修订统计脚本、行为测试、skill 和模块维护地图；产品运行时、UI、Rust 源码均无变更。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| scripts/code-stats.mts | Git 文件集、全仓统计、行分类、Rust cfg、报表与 JSON | 修改 |
| scripts/code-stats.test.mts | 原 20 用例保留；追加 Git 临时仓与词法行为回归 | 修改 |
| .agents/skills/code-stats/SKILL.md | 文件集、双统计口径、独立 Git 对账、估算限制 | 修改 |
| docs/说明书/Pylon-模块维护地图.md | 构建与工具条目的统计职责 | 修改 |
| .agents/L.md | 独立工作树施工声明 | 修改 |
| 本记录 | 目标、结果与证据 | 新增 |

## 方案要点

- 默认仅 Git 已跟踪的当前内容；--include-untracked 才扩面且遵守 ignore，--root 可只读复核其他 checkout。
- 首屏增加全仓源码物理行/非空行：SDK、工具、示例、测试与声明均包含。生产/测试作为另一子集，沿用旧目录排除规则，声明文件新增独立账目。
- 语言补齐 BAT/CMD/RC。字体显式排除；Git grep -I 判定二进制，纯换行文本和空源码不误排。字体、二进制、非源码与工作树缺失路径都在 JSON 台账。
- 修复单引号字符串的终止条件、块注释关闭行误算空行、无换行空白尾行、Python 多行字符串关闭/未闭合 WIP；Rust 多行属性从首行归测试并正确标代码行。
- cfg 改为三值求值：仅 test/test-agent 在生产不成立；未知平台/普通 feature 及其否定均保守留生产，不按名字包含 test 就排除。
- 区域报表的合计列确实包含生产+测试，占比基于生产代码行。测试标记匹配明确为粗计数，复杂 JSX/宏/Shell/PowerShell 分类公开为词法估算。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 定向行为测试 | 29 passed (29)，exit 0 |
| Git 逐文件独立对账 | 共享树 1,942 个源码文件，0 个差异 |
| 分层总量闭合 | 197,804 + 151,021 + 28,217 = 377,042；差额 0 |
| 字体与二进制排除 | 3 个字体、11 个二进制；伪装为 .ts 的二进制有测试 |
| skill 格式 | quick_validate.py → Skill is valid!，exit 0 |
| 脚本 ESLint | 两个改动脚本，exit 0 |
| check:solid | exit 0；182 个 Workbench 文件，841 个生产文件，15 条分层规则零越界 |
| check:frontend | 全链 exit 0（lint、契约、Vitest 全量、生产/Smoke 构建、bundle、docs/maintenance、产物隔离） |
| check:clippy | 前端构建后重跑 exit 0；7 个 crate 的 added=[]，锁卫 17 文件/55 处对账，裸 allow 0 |

## 测试处置

- 修改既有测试「非代码扩展名与声明文件不计入」：非源码仍不入，声明改为 declarations 单列，属于本次全仓口径变更。
- 其余原有断言保留；新增 9 个行为用例，覆盖尾行/CRLF/BOM、单引号与注释、Rust 多行属性、未知 cfg 条件、Windows 源码、Python 多行 WIP，以及 Git tracked/untracked/ignored/二进制/删除文件/Unicode 路径。
- 未用固定历史总量作自动断言；临时 Git 仓由测试生成并只删除其已验证的临时路径。

## 证据与限制

- 复核对象：共享工作树 kumo/364-agent-history@3c4dc6c1 的当前源码，修复同步前读取，含已跟踪 WIP。
- 修正前序人工报数：git grep -c '^' 漏了 37 个文件的末尾空行，377,005 应为 **377,042 物理行**；非空行 350,454 不变。复现：activityGrouping.ts 的 grep 给 70，Git diff --no-index /dev/null 给 71。
- 独立基准：git hash-object -t tree --stdin（空输入，无 -w）得到空树，再 git diff --numstat -z --no-renames 对当前树；1,942 文件逐一与原始 LF 行计数及词法器长度比对，mismatches=[]。
- 工作树状态与 main 的文件集不同，不能拿共享树总量硬匹配隔离树总量；修改统计脚本本身也会改变下次总量。
- 生产/测试和 code/comment 拆分仍是估算，不能证明编译条件、宏展开、复杂 Shell/JSX 语义，测试标记数不能替代 runner 实际用例数。
- self review：核对全仓清单、排除台账、逐文件完备性、分层恒等式、默认/显式未跟踪扫描、JSON 与人读报表一致性。未派子 agent。
- Clippy 初次失败原因：新 checkout 缺少 ../dist，Tauri generate_context proc macro 拒绝编译。check:frontend 生成真实产物后重跑原命令通过；未弱化门禁或改产品源码。Rust 产物隔离在 D:/pylon-code-stats-600-target。
- 无 Rust 代码变更，未另跑 check:rust；此次工具无 UI/IPC 交互，未做 WebView2 实机验收。

## 与 spec 的偏差

原计划以 Git grep '^' 独立对账，实测其遗漏末尾空行，改为 Git diff numstat，并同步修订 spec 与 skill；未更改既有生产目录范围。

## 并行交集

使用隔离工作树完成提交；共享树 #515 暂存文档和 L.md 中其他声明均不 stage、不 commit。脚本、测试与 skill 同步回共享树便于下次直接运行；共享树模块地图仅替换本次工具条目，保留该分支其他表述。

## issue 与 PR

[PR #604](https://github.com/Teens-in-Times/Pylon-co-works/pull/604) 已开，Closes #600 在合并后关闭；[完工评论](https://github.com/Teens-in-Times/Pylon-co-works/issues/600#issuecomment-6108682621) 已回写上述证据。#231/#259 为历史背景，已关闭，不另行更改状态。

## PR 冲突修复复验（2026-10-11）

- GitHub 的 PR 状态为 mergeable=false / dirty；当时 head 无 Actions 或 check-runs。冲突来自 main #597 发行声明与 #600 声明都追加到 .agents/L.md 尾部。
- 保留 #593、#597、#600 三条声明；合入 main 4f22b8c1，合并提交 8e73eb21。发行版本与依赖按 main 保留，统计脚本、测试、skill 均无新增变更。
- 合并后的定向 Vitest：1 file passed，29 tests passed，exit 0；check:docs（文档链接 4 项及 maintenance，unmapped=[]）exit 0；两个统计脚本 ESLint exit 0。
- 合并后的 check:clippy 重跑 exit 0；7 个 crate added=[]；锁卫 17 文件 / 55 处，裸 allow 0。前一轮检查因会话中断而未取得退出状态，不作为通过证据。
- git diff --cached --check 通过；未解决冲突路径为 0。只在本任务隔离树完成合并，共享树他人暂存内容未改动。
- 本轮只处理声明冲突并接入 main 的发行更新；前序完整 check:frontend 证据保留，未重新跑全量前端链。推送后由 PR CI 验证合并后的完整链。
