# Dev Record — #368 git 客户端补齐：stash / 删分支（未落地保护）/ log --graph

## 元信息

- issue：[#368](https://github.com/Teens-in-Times/Pylon-co-works/issues/368)（enhancement(git)）
- 分支：`kumo/prometheus`
- 提交范围：`1852a8fa..本次`（基于合并 github/main #553/#554 之后）
- 日期：2026-10-05

## 目标与范围

issue 原话：「补 `git_stash_push/pop/list`、`git_delete_branch`、`git_log --graph`，全部走既有 `run_git_with_timeout` 同一 runner——参数数组、固定 cwd、路径 containment、输出截断、C locale、`GIT_TERMINAL_PROMPT=0` 这些纪律**不动**」；「删分支必须带「未落地工作」保护……删除本身用 `update-ref -d <ref> <expected_tip>` 做成**比较并删除**」。

**不做**：`stashDrop` 槽位（issue 未列；能力探测下 UI 自动隐藏，留作后续）；三栏冲突编辑器（issue 明示首版只做数据面+手工编辑，数据面 0-C2 已就位）；worktree 并行任务板（仓库主已裁决不做）；reset/revert/cherryPick 等其余契约槽位。

**现状修正**（相对 issue 落笔时）：`gitCapabilities.ts` 派生层已在 #520 W2 作为零消费死代码删除；现契约是 `fileWorkbenchTypes.ts` 的 `GitProvider` 可选方法面（#290 已扩出 `stashList/Push/Pop/Drop`、`logGraph` 槽位，缺 `deleteBranch`）；UI 侧无任何现成入口，本批一并新建。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-foundations/src/git.rs` | runner 重构（`GitProbe` exit-code 探针出口）+ `git_stash_list/push/pop`、`git_delete_branch`（`local_branch_tip`/`git_is_ancestor`/`git_trees_equal` 保护链）、`git_log_graph` + DTO + 7 个新测试 | 修改 |
| `src-tauri/src/workspaces/cmds.rs` | 五个新 `#[tauri::command]`（stash 系/delete_branch/log_graph，参数 camelCase 映射） | 修改 |
| `src-tauri/src/commands.rs` | `generate_handler` 注册 5 行 | 修改 |
| `src/infrastructure/tauri/gitContracts.ts` | `GitStash` + `normalizeGitStashList`（宽容解析，id 空跳过） | 修改 |
| `src/infrastructure/tauri/workspaceClient.ts` | `gitStashList/Push/Pop`、`gitDeleteBranch`、`gitLogGraph` 五方法（payload 收口 + normalize） | 修改 |
| `src/plugin-runtime/file-workbench/fileWorkbenchTypes.ts` | `GitProvider.deleteBranch?` 可选方法（#290 槽位补齐） | 修改 |
| `src/plugins/core/file/builtinFileWorkbench.ts` | builtinGitProvider 实现 stashList/stashPush/stashPop/deleteBranch/logGraph | 修改 |
| `src/sheets/file/GitPanel.solid.tsx` | 命令栏「贮藏」、STASHES 区（pop 入口）、分支编辑器「删除分支」、COMMITS 段 logGraph 分页（refs 徽标 + merge 指示 + 加载更多）+ `loadGraphPage/loadHistory/refreshStashes` 加载器 | 修改 |
| `src/components/LucideIcon.solid.tsx` | 登记 `GitMerge` 图标（import + ICON_NODES 两处） | 修改 |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css` | `.git-history-head` 5 列网格；新增 `.git-branch-delete`/`.git-stash-*`/`.git-history-ref(s)`/`.git-history-more` | 修改 |
| `src/infrastructure/tauri/__tests__/tauriClients.test.ts` | 新命令收口测试（payload + 宽容 normalize） | 修改 |
| `src/sheets/file/__tests__/gitPanelMutations.solid.test.tsx` | 新增 4 用例（stash 回环 / logGraph 徽标+续页 / 删分支 / 能力缺失降级） | 修改 |
| `src/sheets/file/__tests__/FileSheetView.integration.solid.test.tsx` | beforeEach invoke mock 补 `git_stash_list`/`git_log_graph` 两行（新 SCM 面契约） | 修改 |

## 方案要点

- **runner 探针出口**：`merge-base --is-ancestor` / `diff --quiet` 以退出码 0/1 编码布尔答案，原 `run_git_with_timeout` 的折叠语义会丢答案。抽出 `run_git_probe_with_timeout`（同 runner 纪律：参数数组、C locale、`GIT_TERMINAL_PROMPT=0`、超时 kill、有界 drain），折叠语义保留在原包装层，错误文案逐字不变。
- **exit 1 采信纪律**（Windows git 实测陷阱）：非仓库目录 `git diff --quiet a b` 以**退出码 1** 退出（stderr "error: Could not access 'a'"）——1 在这里不是「树不等」的答案。真实「树不等」是静默退出 1（`--quiet` 压掉输出），故 **exit 1 必须搭配空 stderr 才采信**，否则按探针失败保守处理（`--is-ancestor` 同一纪律）。
- **删分支保护链**（Codeg `work_task/git.rs` 同源）：validate_branch_name → 拒当前分支（status 比对）→ `local_branch_tip`（for-each-ref 全限定名精确匹配，区分「不存在」与「探针失败」，`<name>/sub` 不冒名）→ base=HEAD oid → `--is-ancestor`（0=已并删）→ 否则 `diff --quiet` 树相等（squash 落地形态，commit message 不参与判定）→ **任何探针失败一律按「有未落地工作」拒删** → `update-ref -d refs/heads/<name> <tip>` 比较与删除单操作完成（探针与删除间 ref 被并发移动时 git 拒绝执行）。
- **log 图数据面**：不传 `--graph`（图字符破坏 NUL 分隔解析，lane 属前端表现层）；`--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D` 结构化 parents/refs；显式 `--decorate=short`（runner stdout 是管道，`log.decorate=auto` 非 TTY 不输出 decorations——没有它 refs 恒空）；多取 1 条定 hasMore；limit 上限 MAX_HISTORY；`--first-parent` 只约束遍历，`%P` 数据面忠实完整双亲。
- **UI 加载语义**：图日志是增强面而非门面——logGraph 首页失败**回退 history()**（历史也失败才进面板错误态），续页失败保留已加载页可重试；贮藏清单失败不打断主面板，且非仓库场景不追加错误中心噪音（面板已呈现 not-repo 视图）。全部入口能力探测，第三方 provider 不实现即隐藏（issue 所述降级路径）。
- 提交/创建分支/切换分支等既有变更动作在 logGraph 能力下刷新走图分页归零（`runMutation` 分流）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test --workspace --lib`（含 foundations git 36 项） | ✅ 全绿（pylon 974 / foundations 100 / 其余 crate 全绿，汇总 9 个 test result ok） |
| `bun run check:clippy`（基线外零新增） | ✅ 通过（修掉 1 处 `clippy::int_plus_one` 新增诊断后基线对账 added=[]）；check-await-holding 通过（17 文件/55 处清单一致） |
| `cargo fmt --check` | ✅ CLEAN |
| `tsc -b`（React 工程）+ `tsc -p tsconfig.solid.json` | ✅ 双工程 0 错 |
| `bun run check:solid`（11 项边界门禁链） | ✅ 通过 |
| 全量 vitest | ✅ 5207 passed / 1 skipped（668 文件） |
| 新增测试 | Rust 7 个（stash 回环/守卫、删分支四态、squash 落地、探针失败、log 图分页/装饰/过滤）；前端 5 个（tauriClients 1 + gitPanel 4） |

**验收限制**：未做 webview2 实机运行验收（判断依据：后端语义由真实 git 仓集成测试覆盖、UI 结构由 FileSheetView 全链 solid-dom 测试覆盖、视觉面走既有 CSS 模式风险低；如需真机复验可后续单独跑 `webview2-acceptance` skill）。

## 测试处置

- 新增：见上表。
- 修改既有：`FileSheetView.integration.solid.test.tsx` beforeEach mock 补 2 个新命令契约（builtin provider 现带 stash/logGraph 能力，SCM 挂载即探测——不加会以 `unexpected invoke` 拒绝并触发 #228 console.error 硬门禁）。
- 无删除。

## 证据

- commit：见 PR（本文件同批 pathspec 提交）。
- 测试：`cargo test --workspace --lib` → 9×`test result: ok`（0 failed）；`bunx vitest run` → `Tests 5207 passed | 1 skipped`；`bun run check:clippy` → added=[] + check-await-holding 通过；`tsc -b` / `tsc -p tsconfig.solid.json` → 0 错。
- 手工验证：删除分支保护四态由真实临时仓库集成测试覆盖（`delete_branch_refuses_current_unlanded_and_missing`、`delete_branch_allows_merged_and_squash_landed`）；stash 回环 `stash_push_pop_list_roundtrip` 覆盖 `-u`/pop 恢复/清栈。

## 与 spec 的偏差

- spec「测试处置」预告的「history date 改数值」**未做**：现 `GitCommit.date`（Rust String → 前端 normalize 期望 number）确实导致 history 回退路径日期恒显示「—」，属既有缺陷；本批新的 graph 路径 date 已按 i64 数值正确序列化。history 路径修复涉及 wire 类型变更，留给独立小 issue 更合适。
- 新增 spec 未写的：`分支` 命令栏按钮条件纳入 `deleteBranch`（仅有删能力的 provider 也得有入口——测试抓出的能力探测缺口）；图回退/续页保留语义；not-repo 场景贮藏清单不追加错误噪音。

## 未解问题

- `GitCommit.date` wire 类型（String→number）修复，见上。
- `stashDrop` 契约槽位实现（后端 `git stash drop` + UI 删除单条贮藏按钮）。
- 删分支入口现为「分支编辑器按草稿名删除」；若后续要做本地分支列表化 UI，需先登记 provider `list_branches` 能力位。

## 并行交集

- 共享树在途未碰：`.agents/decisions/0035-*`、`.agents/records/515-*`（#545 域）、`src/plugins/**` 样式（#410 域）、`src/domains/workbench/**`（#551 域）。
- 本批触碰的共享面：`commands.rs`（generate_handler 追加 5 行）、`LucideIcon.solid.tsx`（+1 图标）、`FileSheet.css`（git 区追加 + 1 行网格列数）——提交均按 pathspec，不连带他人在途。
- 施工环境注意：G 盘曾 100% 满（rustc "no space on device"），已按 #228 纪律切换 `CARGO_TARGET_DIR=D:/pylon-target` 热缓存，并清掉 G 盘旧 `src-tauri/target`（24G）释放空间。
