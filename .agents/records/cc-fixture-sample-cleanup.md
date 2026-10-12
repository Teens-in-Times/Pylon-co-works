# Dev Record — 台账单 · 夹具样本值清退（ekg / tasks 残留）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/cc-fixture-sample-cleanup.md`

## 元信息

- issue：无（台账单；来源 = 仓外 `工作台优化/待办/刀4-04b-收口遗留-待办.md` §三-5，用户 2026-10-11 拍板「现在就清」）
- 分支：`chore/cc-fixture-samples.1`（基于 `origin/main` @ `ae1153d5`，已 unset upstream）
- 提交范围：未提交（工作者纪律：不 commit，待验收方处置）
- 日期：2026-10-11

## 目标与范围

皮肤契约夹具与中控夹具的样本值里还写着 #266 刀4 名单换代时已删的两个控件 id（`ekg` / `tasks`）。本单把 3 处样本值换成现行 id（`model` / `tokens`），并用脚本重拍皮肤契约快照底片。

不做：不动迁移/清退类测试的 ekg/tasks 字符串、不动行为测试样本、不动功能代码注释与迁移名单、不改契约逻辑结构、不手改 baseline、不 bump schema 版本、不动 CSS / 字段定义 / 出厂预设。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/appearance/workbenchSkinContract.ts` | `boundaryValue` 的 `ccHidden`/`ccHiddenEmpty` max 边界样本名单；`createDirtyTheme` 的 `ccHidden` 样本值 | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbenchFixtures.ts` | `WORKBENCH_CONTROL_CENTER_FIXTURE` 的 `scale` 样本键 | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | `generatedAt` + dirty-custom `ccHidden` + boundary-max `ccHidden`/`ccHiddenEmpty` 共 6 行样本值 | 修改（仅 `--write` 再生） |
| `.agents/records/cc-fixture-sample-cleanup.md` | 本记录 | 新增 |

## 方案要点

- 三处替换目标由施工单写死：`['ekg','tasks']` → `['model','tokens']`、`ccHidden: ['ekg']` → `['model']`、`scale: { ekg: 90, … }` → `{ tokens: 90, … }`。替代 id 取自 `src/domains/cc/widgetDefinitions.ts` 现行 8 个顶层控件（`cc-surface` / `input` / `model` / `reasoning` / `mode` / `tokens` / `cc-command-hint` / `cc-send-button`）。
- 快照底片不手改，仅由 `bun scripts/check-workbench-theme-contract.mts --write` 再生；该脚本只写 `workbench-skin-baseline.json`（`custom-presets-baseline.json` 只读入，天然零变化）。
- 预期零视觉、零功能变化：两份源文件的消费者已核实全部是测试/快照脚本（`workbenchSkinContract.test.ts`、`inputFontContract.test.ts`、`check-workbench-theme-contract.mts`、`workbenchFixtures.test.ts`），无生产运行时路径。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 两份源文件 `ekg`/`'tasks'` grep | 0 命中（EXIT=1） |
| baseline `ekg` / `"tasks"` 计数 | 0 / 0（重拍前 `ekg` 为 3） |
| `git diff --stat origin/main` | 恰好 3 个改动文件（+ 本记录为新增第 4 文件） |
| baseline diff 逐行核对 | 样本行 3 组（`["ekg"]`→`["model"]`；`["ekg","tasks"]`→`["model","tokens"]` ×2）+ `generatedAt` 时间戳伴生一行（`--write` 脚本行为，:29 写死取当前时间），无任何其它键变更 |
| 相关测试单独跑 | 9 文件 / 78 用例全绿 |
| 门禁五步 | lint EXIT=0；build:example-plugin EXIT=0；build EXIT=0；check:solid EXIT=0；test 684 passed + 1 skipped（685 文件）/ 5367 passed + 1 skipped（5368 用例）EXIT=0 |

## 测试处置

无新增、无修改、无删除。全量绿同时证实了「没有任何测试直接断言这三处样本值内容」的探索结论（若有此类断言，本次替换必红）。

## 证据

- commit：未提交（见元信息）
- 测试（名称 + 退出码）：`bun run test` EXIT=0（5367 passed | 1 skipped / 5368）；相关测试 `vitest run src/domains/appearance …` EXIT=0（78/78）
- 手工验证：无（本单零视觉/零功能变化，无实机项）

## 与 spec 的偏差

无方案偏差。一处如实报备：baseline 的 `generatedAt` 随 `--write` 再生必然变化（施工单 §5-4 字面「只许样本行变更」与 §4-3「只能由 --write 再生、不手改」在该键上合取的结果即允许其伴生；与 CC-32 先例「快照仅 generatedAt」同性质），已由验收方核对。

## 未解问题

无。

## 并行交集

`src/domains/appearance/workbenchSkinContract.ts`、`src/renderers/solid-workbench/__fixtures__/workbenchFixtures.ts`、`src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`。
