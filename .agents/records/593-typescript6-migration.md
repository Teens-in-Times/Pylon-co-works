# Dev Record — #593 TypeScript 6.0.3 迁移

## 元信息

- issue：[#593](https://github.com/Teens-in-Times/Pylon-co-works/issues/593)
- 分支：`codex/typescript6-migration`
- 提交范围：`16c2ae14..codex/typescript6-migration`（最新 main 为基准）
- 日期：2026-10-09
- 稳定署名：Codex
- 工作树：`C:/Users/AlchemistCxC/.codex/worktrees/typescript6-migration/prism-desktop`

## 目标与范围

用户在了解 TS7 升级失败与 TS6 兼容性后要求「开始迁移吧」。将 TypeScript 5.9.3 迁移到 6.0.3，保持现有 ESLint、编译器 API 消费、SDK 与示例插件可用。只调整工具链、编译配置及文档；不升 TS7，不改 ES2022 运行时目标、产品行为或测试断言。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `package.json`、`bun.lock` | TypeScript 改为 `~6.0.3`；锁文件只更新对应声明与包条目 | 修改 |
| `tsconfig.json` | 删除 baseUrl、paths 改为相对目标、显式 node/Vite types；删除过期 React 排除说明 | 修改 |
| `examples/web-plugins/{hello-starter,plugin-manager-demo}/tsconfig.json` | 删除 baseUrl；rootDir 显式覆盖仓内 SDK | 修改 |
| `scripts/build-plugin-sdk.mjs` | 独立 CLI 声明构建显式 --ignoreConfig | 修改 |
| `scripts/pack-plugin-devkit.mjs` | starter 消费同源 TS 版本、清除生成配置的 baseUrl、补 TS starter typecheck 与正确 SDK build alias | 修改 |
| `scripts/plugin-devkit-README.md` | TypeScript 安装与类型检查步骤同步 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md`、`Pylon-插件系统说明书-开发者版.md` | 编译工具链与 SDK 配置事实同步 | 修改 |
| `.agents/L.md` | 隔离施工声明（协调提交 463ebf52） | 修改 |
| 本文件 | 目标、证据与限制承接一次性 spec | 新增 |

## 方案要点

1. 使用 `~6.0.3` 限制到 typescript-eslint@8.68.0 支持的 6.0.x；其 peer 范围为 `>=4.8.4 <6.1.0`，不引入双编译器或新增依赖。
2. 初次安装 TS6 后，根配置、继承它的 Solid 配置与示例配置都报 `TS5101: Option 'baseUrl' is deprecated`。迁移路径配置后通过，不使用 ignoreDeprecations 或 types 通配符；strict/noUnused 等检查保持原强度。
3. SDK 独立声明发射报 `TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline`，导致缺少两份入口声明。`--ignoreConfig` 恢复该脚本一直采用的「显式 entry + CLI 编译选项」语义，不影响项目 tsc -p/-b 检查。
4. 两个发行 starter 的 TypeScript 版本从根 package.json 读取，清除生成 tsconfig 中的 baseUrl；普通 TS starter 新增可直接执行的 typecheck 命令。
5. 用户选择自行复核，未派发子 agent。复核覆盖根/Solid/两个仓内例子、SDK CLI/API、生成套件配置与 starter 实际工作目录；发现并修正普通 TS starter 既存 SDK alias 少一层的问题（../sdk → ../../sdk）。

## 验收标准与结果

| 验收项 | 结果与证据 |
| --- | --- |
| 编译器与冻结安装 | `tsc --version` = Version 6.0.3；`bun install --frozen-lockfile` exit 0，490 installs / 592 packages，no changes |
| 根 / Solid / 两个仓内示例类型检查 | 四个 `tsc -p ... --pretty false` 均 exit 0 |
| lint 与 JS 编译器 API 消费 | `bun run lint` exit 0；第一方 CSS ownership 守卫通过，20 files |
| `bun run check:frontend` | exit 0；683 文件通过 / 1 跳过，5318 测试通过 / 1 跳过；Vitest 143.27s；生产 Vite 2847 模块 / 9.74s；Solid smoke、bundle、文档/维护检查均通过 |
| `bun run check:solid` | exit 0；841 生产文件分层检查通过，829 文件 / 3223 边 import 检查通过；CSS 消费 104/336/356，死注入/悬空引用 0；锚点 23 个与手册全等 |
| `bun run check:clippy` | exit 0；7 crate 全部 added=[]，pylon 1 个历史诊断仍在基线内；cargo 完成 3m18s；await-holding 17 文件 / 55 处，全量对账，裸 allow 0 |
| SDK / 套件 | `bun scripts/pack-plugin-devkit.mjs` exit 0，SDK 两份入口声明存在，离线 bundle 21443 B，G1/G2/G3 全 PASS；套件 verify 30 项 ALL PASS |
| 两个生成 starter 实际使用 | 分别从 starter/typescript 与 starter/manager-demo 执行 `bun run typecheck`、`bun run build` 均 exit 0 |
| 脚本语法与 diff | 两个修改 .mjs 的 `node --check`、`git diff --check` 通过 |

## 测试处置

未修改、删除或新增产品行为测试；使用现有全量测试、真实 CLI/SDK 构建与生成套件消费者验证。5318 个通过测试包含依赖 ESLint 的命名契约测试，覆盖此前 TS7 PR 的工具链阻塞。

## 证据

- 调查中的 TS7 PR：[#582](https://github.com/Teens-in-Times/Pylon-co-works/pull/582)，本任务保留其开放状态。
- 本地原始输出位于隔离工作树的忽略目录：`target/593-check-frontend.log`、`593-check-solid.log`、`593-check-clippy.log`、`593-devkit-final.log`、`593-devkit-verify.log`；上表承接可持久追溯的计数与结论。
- clippy 构建使用独立 `CARGO_TARGET_DIR=D:/pylon-ts6-593-target`，不占用共享工作树的 Rust 产物目录。
- 本记录与实现同一提交；最终 SHA、PR 与验证结论回写 issue 评论。

## 与 spec 的偏差

- 类型检查未暴露需要修改生产/测试源文件的 TS6 兼容错误，全部调整落在配置和工具链。
- 增补修正生成 TS starter 既存 SDK build alias：打包器 G2 类型检查通过，但用户执行 build 会报 Could not resolve ../sdk/pylon-plugin-sdk.js；修正后两个 starter 的实际 typecheck/build 均通过。
- 未增加 ADR：本轮落实用户已确认的编译器版本迁移，没有更改架构、所有权、插件 API 或持久化契约。

## 未解问题与验证限制

- 未运行 WebView2 实机验收或完整 Rust 运行测试；本轮为编译工具链/配置变更，生产源文件不变。Rust all-targets 的编译/lint 已由 clippy 完成，远端完整 CI 在 PR 创建后执行。
- Vite 输出 jsxImportSource/preserve 组合相关 warning，构建 exit 0；本轮不修改 JSX 渲染链路。
- TS7 PR #582 仍开放，作为后续原生编译器迁移的独立工作；不由本 PR 合入或关闭。

## 并行交集

共享工作树仍在 `kumo/364-agent-history`，其中 #515 的两份未提交文档原样保留；仅追加本任务 L.md 声明且依 AGENTS §2.1 未暂存或提交该共享树。全部实现、安装、构建与提交都在独立工作树执行。
