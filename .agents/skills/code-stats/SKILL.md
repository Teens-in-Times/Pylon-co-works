---
name: code-stats
description: 只读统计 Pylon 的 Git 已跟踪源码规模，排除字体和二进制；提供全仓物理行/非空行、语言分布，以及有明确范围的生产/测试估算。用于统计代码量、评估改动面积、对比重构规模。单文件行数可直接用 Git 或行计数工具。
---

# Pylon 代码量统计

先回答用户所选文件集的**全仓源码总量**，再按需要解释生产、测试和工具等子集。用户明确要求直接用 Git 时，直接执行 Git 命令，不以本脚本替代其选择。

## 执行

```bash
bun scripts/code-stats.mts
bun scripts/code-stats.mts --json
bun scripts/code-stats.mts --root /path/to/repository --json
bun scripts/code-stats.mts --include-untracked --json
bunx vitest run scripts/code-stats.test.mts
```

默认用 `git ls-files -z --cached` 枚举已跟踪文件，读取其**当前工作树内容**（含已跟踪 WIP）。只在用户需要未跟踪源码时加 `--include-untracked`，该选项仍遵守 Git ignore。统计只读；不要为统计历史状态 stash 或切换用户的共享工作树，使用单独 checkout/worktree。

## 两种口径

**全仓源码**（JSON 的 `repository`）：

- 语言：TS/TSX/MTS/CTS、JS/JSX/MJS/CJS、Rust、CSS、HTML、Python、Shell、C/H、PowerShell、Batch（BAT/CMD）、Windows RC。
- 包含源码声明文件（D.TS/D.MTS/D.CTS）、生产、测试、SDK、工具、示例以及已跟踪的生成源码。不要无声排除其中任何目录；若用户要求剔除生成或第三方源码，明确列出额外过滤条件。
- 显式排除 WOFF/WOFF2/TTF/TTC/OTF/EOT 字体；二进制以 `git grep --no-textconv -I` 的结果判定，即使扩展名像源码也排除。JSON/TOML/YAML/Markdown/锁文件等不是源码。排除路径在 `repository.skipped`，工作树缺失文件单列 `missing`。
- `total` 是 LF/CRLF **物理行数**，包括注释与空行；末行无 LF 也计一行，空文件是 0 行。`nonblank` 去除纯空白行，**仍含注释**，不能称为净代码行。空源码文件计入文件数。

**运行时生产/测试子集**（JSON 的 `production`、`test`、`excluded`）：

- 沿用原有项目范围：声明文件、`src/sdk/`、`src-tauri/resources/`、`examples/`、`src-tauri/vendor/`、`scripts/`、`tools/`、markdown gen/parity、根配置不入生产/测试，单列在 `excluded`。这些文件仍进入全仓总量。
- crate 区域动态读取 Cargo workspace members；不可读时使用脚本内兜底清单。该清单是区域分组兜底，不是源码总量白名单。
- TS/JS 测试按测试目录及 TEST/SPEC 文件名识别；demo 数据不据名字推定测试。
- Rust 按 `cfg(test)` 和本仓专属 `test-agent` 门控估算内联测试，兼顾外置测试模块和 `tests/`。其他 feature/平台是未知条件，不能把其否定误当测试门控；`cfg_attr` 本身不是门控。

生产/测试拆分与 code/comment/blank 是**轻量词法估算**，不是编译器语义或实际执行测试数。复杂 JSX、Shell here-doc、PowerShell here-string/块注释、宏或特殊模块布局可能影响分类。Rust 测试属性与 TS `it()/test()` 文本匹配只作标记粗计数，不能用于宣称测试套件有多少实际用例；需要用例数时读测试 runner 输出。

## 复核与报告

- 报告文件集、排除条件、Git branch/head，优先给物理行和非空行。不要用过去某日的生产/测试比例判断当前统计正确与否。
- 独立复核：用 `git hash-object -t tree --stdin` 输入空内容取得空树哈希，再对同一源码文件集执行 `git diff --numstat -z --no-renames <空树哈希>`（不写对象），核对每文件的新增行数；未跟踪文件用 `git diff --no-index --numstat -- /dev/null <文件>`。`git grep -c '^'` 会漏末尾空行，不作为完整物理行的基准；`wc -l` 又不计无 LF 末行。不要把源码总量与未过滤的所有文本行数比较。
- 对账恒等式：`repository.total = production.total + test.total + sum(excluded[*].stat.total)`；语言汇总也应等于 repository 总量。脚本对每个源码文件断言词法器行数等于独立物理行数，出现不一致应修复或报告失败，不能继续给可信总量。
- 当前工作树仍可能被其他贡献者修改；两次运行若不一致，核查具体文件/文件集和 HEAD。HEAD 相同不能证明内容相同。

## 修改统计规则

同步修改 `scripts/code-stats.mts`、对应行为回归测试和本文件。运行定向 Vitest 与仓库源码逐文件 Git 对账，保留输出作为证据；不要只测试格式或固定历史总量。
