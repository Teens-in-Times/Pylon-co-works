# Dev Record — #597 发行 0.4.2-SYN 与过期生成物清理

## 元信息

- issue：#597（发行）、#598（发行过程中发现并修复的依赖漂移）
- 署名：Codex
- 分支：`codex/release-0.4.2-syn`
- 基准提交：`15659279`（2026-10-11 最新 `github/main`）
- 日期：2026-10-11

## 目标与范围

用户要求同步最新 main、由 Codex 选择版本、构建并上传 Release，版本改动提交，顺手清理无意义文件。选定 `0.4.2-SYN`，接续 `0.4.1-XFN`。

发行沿既有 #402 / #232 流程；包含已合入 main 的 #593 TypeScript 6 迁移与 #266 CC-18 滚动轨道修正。预演发现 JS/Rust `plugin-fs` minor 漂移，登记 #598 并修复；不改变发行流程。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `package.json`、`src-tauri/tauri.conf.json` | 应用版本 | 修改 |
| `src-tauri/Cargo.toml` 与 pylon-acp / canonical-types / compute / markdown / session 的 `Cargo.toml` | 随应用同步的 crate 版本 | 修改 |
| `src-tauri/Cargo.lock` | 六项本地 crate 版本 | 修改 |
| `bun.lock`、`package.json`、`src-tauri/Cargo.toml` | 两端 `plugin-fs` 约束收窄到 2.5 系列，JS 锁定 2.5.2 | 修改 |
| `docs/说明书/Pylon-发行包清单.md` | Tauri 插件版本对齐的构建前检查 | 修改 |
| `.agents/L.md` | 发行施工声明与完工撤下 | 修改 |
| 本文 | 发行与清理证据 | 新增 |

## 方案要点

- 共享树有 #515 两份文档和 #593 协调声明未提交，遵守 AGENTS.md §2.1，在基于最新 `github/main` 的隔离工作树发行。共享树不暂存、不提交他人文件。
- 本地 `main` 引用以 `git fetch github main:main` 快进到最新远端；共享树原有分支与他人改动保留。
- `pack_release.py --bump 0.4.2-SYN --build` 按 pathspec 自动提交九个版本文件。版本提交：`6f769039`。
- 构建使用 `CARGO_TARGET_DIR=D:/pylon-target`，临时文件落 `D:/pylon-tmp`，避免 G 盘余量不足。
- 初次发行构建退出 1：JS `plugin-fs=2.6.0`、Rust `plugin-fs=2.5.2`，Tauri 拒绝 minor 不同。冻结安装后的 `tauri info` 重现同一错误；锁文件与安装版本一致，排除旧缓存或错误安装目录。根因是独立锁文件更新且两端均允许整个 2.x。
- #598 修复提交 `40cdc5ce`：两端 manifest 均使用 `~2.5.2`，JS 回到 2.5.2，保留原 Rust 依赖。CLI 自身的真实版本守卫与完整发行构建是回归验证入口；无需增加只复述 manifest 字面量的单测。
- 清理先核对绝对路径、Git 跟踪状态和目录链接。批量递归删除被自动审批策略拦截，改为原生 PowerShell `Move-Item -LiteralPath`，把过期生成物移到 D 盘可恢复归档。未删除源码、用户配置、agent 状态或他人文档。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 九份版本文件落位并提交 | `6f769039`，九文件，14 行新增 / 14 行删除；无其他路径 |
| `bun run test:pack` | 45 tests，2.869s，退出码 0 |
| `bun run check:solid` | 退出码 0；176 个主题字段一致性、23 个 hook 锚点全等，其余边界门禁通过 |
| 本地 `release:portable` 与 ZIP 审计 | 退出码 0；38,987,875 字节 ZIP，manifest 292 项全匹配，SHA-256 一致；空 `data/` 与必要二进制/文档/SDK 在位 |
| `bun run check:clippy` | 退出码 0，耗时 1m12s；七个 crate 基线外新增诊断均为 0；17 文件 / 55 处持锁 await 与清单一致、裸 allow 为 0 |
| PR CI 状态与原始测试结果 | PR #599 / run `38134669028` 状态 success；前端 5,324 passed / 1 skipped。但 Rust job 漏报失败，详见下方验证限制，不能据状态宣称 Rust 测试全绿 |
| main 归属 / 正式 Release | PR #599 合入 `4f22b8c1`；`v0.4.2-SYN` 指向该 main 提交；run `38135459142` success，两道守卫通过；2026-10-11 19:43:50（UTC+8）公开发布 |
| 正式三项资产复核 | ZIP 38,992,908 字节、manifest 57,558 字节、校验文件 93 字节；均 uploaded，下载后的三项 digest 与 GitHub 一致；ZIP/manifest 292 项全匹配、空 data/、GUI subsystem=2、检测器/MCP/SDK/离线文档齐全 |
| 清理生成物与空间变化 | 34,184 文件、15,848,452,135 字节（14.760 GiB 逻辑大小）移至归档；G 盘可用空间约 0.2 → 12.878 GiB |

## 测试处置

无新增、修改或删除测试。版本变更采用既有打包测试、发行构建和完整 PR CI 验证。

## 证据

- 协调声明提交：`5118ad67`。
- 版本提交：`6f769039`。
- 依赖漂移修复：`40cdc5ce`。
- 打包测试日志：`D:/pylon-tmp/release-0.4.2-syn-test-pack.log`。
- 本地构建日志：`D:/pylon-tmp/release-0.4.2-syn-build.log`。
- 修复后的本地构建日志：`D:/pylon-tmp/release-0.4.2-syn-build-retry.log`。
- clippy 日志：`D:/pylon-tmp/release-0.4.2-syn-clippy.log`。
- Solid 门禁日志：`D:/pylon-tmp/release-0.4.2-syn-solid.log`。
- 本地 ZIP SHA-256：`1ec10906389d6704fa0905e5bc65aaa57a5f9b728d9b4acbc32ed29293cd152e`。
- 主程序 PE GUI subsystem = 2；`pylon-webview2-mcp --version` 返回 `0.1.0`，`pylon-detect --help` 成功。
- PR CI：[run 38134669028](https://github.com/Teens-in-Times/Pylon-co-works/actions/runs/38134669028)，前端两分片分别 2,837 passed / 1 skipped 与 2,487 passed。
- 正式发行：[run 38135459142](https://github.com/Teens-in-Times/Pylon-co-works/actions/runs/38135459142)，tag 指向 main 合并提交 `4f22b8c1`。
- [正式 Release v0.4.2-SYN](https://github.com/Teens-in-Times/Pylon-co-works/releases/tag/v0.4.2-SYN)，Release ID `409632690`，非 draft、非 prerelease，三项资产在位。
- 正式 ZIP SHA-256：`4bbb29c8bb36472e99c3ff699f062b54b3e86c2b3cd072b4deb447e8f9a5d4bf`。
- 正式 manifest digest：`c49bbb92aea47443d4dcd57285742707a5d4a6e0b963ff1aaddfc9271863f01e`；校验文件 digest：`b6528a57302853462a7efb7cbc73c80bb5d1a9351dd27c2571ba3145b90627c6`。
- 正式三项资产保存到共享仓库 `release/`；本地预演包另存 `D:/pylon-tmp/rehearsal-0.4.2-SYN/`。二者分别构建、分别审计，不要求 ZIP 字节相同。
- 清理归档：`D:/pylon-tmp/workspace-cleanup-20261011-597/`。

归档范围：共享树根 `target/` 验证草稿、`src-tauri/target/debug/`、`tools/webview2-mcp/target/debug/`、`coverage/`、`dist-solid-smoke/`、两个 Python `__pycache__/` 与 `tsconfig.tsbuildinfo`。现有 Release、Rust release 缓存、依赖目录、用户 `agents.yaml` 与 agent 状态保留。

## 与 spec 的偏差

生成物采用可恢复归档而非永久删除，原因是自动审批拒绝批量递归删除。

额外修复 #598 的依赖漂移，这是完成原始发行任务的必要前置。

## 未解问题

发行构建、上传与三项资产复核均完成。未进行真实 Agent 会话或 GUI 交互验收；本次依赖修复的回归覆盖为完整发行编译、打包审计、前端测试与 clippy。以下既有问题独立保持开放，本次未宣称 Rust 测试全绿。

### 原始 Rust CI 日志揭示的验证限制

CI 状态为 success，但复核日志发现 `pylon-foundations` 单测 **98 passed / 2 failed**，随后集成测试构建 **E0599**；后续成功的 `cargo build` 覆盖了中间失败退出码。原始证据：[job 114456018576](https://github.com/Teens-in-Times/Pylon-co-works/actions/runs/38134669028/job/114456018576)，本地保存 `D:/pylon-tmp/release-0.4.2-syn-ci-rust.log`。

- [#602](https://github.com/Teens-in-Times/Pylon-co-works/issues/602)：默认 PowerShell 多行 cargo 步骤没有逐条退出码守卫，导致 CI 漏报；同时记录控制台差分探针 `inherited HWND=0` 的无效控制组，需要处置 runner 环境限制。
- [#601](https://github.com/Teens-in-Times/Pylon-co-works/issues/601)：`test-agent` feature 下集成测试 helper 可见，但 `AgentRuntime::install_acp` 仅 `cfg(test)` 可见，集成测试依赖 lib 编译失败。默认生产发行构建不包含该测试注入路径。
- [#603](https://github.com/Teens-in-Times/Pylon-co-works/issues/603)：目录 symlink 被错误收录到 quick-open 文件索引，`list_files_does_not_follow_symlink_directories` 失败。

上述 CI 与源码路径在 `15659279..v0.4.2-SYN` 的 diff 中均未变化，属于同步 main 时已有的问题。本次独立登记并保留追踪，未将它们计作测试通过；发行范围仍为版本落位、构建、上传与清理。

## 自行复审

逐项审阅版本落位九文件、lock 中六项本地 crate 的变化，以及 #598 的四文件修复。Rust 锁定依赖未升级；JS `plugin-fs` 与 Rust 同为 2.5.2，manifest 的 minor 约束同步；其他依赖锁项未变化。`git diff --check` 通过，隔离工作树无外来改动。未派发子 agent。

## 并行交集

仅在隔离工作树修改版本/依赖文件、发行清单与本记录。共享树追加发行范围声明；#515 两份文档及 #593 声明保留。发行清单已同步 `plugin-fs` minor 对齐要求。
