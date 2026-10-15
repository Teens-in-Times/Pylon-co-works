# Dev Record — #635 Fix the module-map skill link

## 元信息

- issue：https://github.com/Teens-in-Times/Pylon-co-works/issues/635
- 关联 PR：https://github.com/Teens-in-Times/Pylon-co-works/pull/634
- 分支：`fix/pr634-ci`
- 基准提交：`4c2d284e5fea2c665188ff1410540709783ce839`
- 日期：2026-10-15
- 稳定署名：Codex / AlchemistCxC

## 目标与范围

修复 PR #634 所用 main 提交上的 Deploy Docs 失败。仅修正模块维护地图的一处链接，并保留本记录；源码、依赖、站点收录范围和 CI 规则不变。原 PR #634 是 main 到工作分支的同步 PR，本修复经独立 PR 更新 main。

## 原因与方案

两次 CI 均在 `bun run docs:build` 报告 `.agents/skills/code-stats/SKILL` 死链。本地安装冻结依赖后重现相同错误，退出 1（2.89 秒）。目标文件已经 Git 跟踪，GitHub Contents API 也确认存在；它位于 docs/ 站点之外，不能作为文档站页面解析。

将 `docs/说明书/Pylon-模块维护地图.md` 的这个相对链接改为其 GitHub blob URL。该 URL 在仓库源码和生成站点中均有效；保留 VitePress 死链检查与 ADR-0026 的站点收录边界。

## 验收与证据

| 检查 | 结果 |
| --- | --- |
| 基准 `bun run docs:build` | 退出 1，指定 skill 死链 |
| 修复后 `bun run docs:build` | 退出 0，4.68 秒 |
| `PYLON_DOCS_OFFLINE=1 bun run docs:build` | 退出 0，3.89 秒 |
| 两种 `dev/module-map.html` 产物 | 含准确 GitHub URL，不含原 skill 相对链接 |
| `bun scripts/check-doc-links.mjs` | 退出 0，4 项通过 |
| `git diff --check` | 退出 0 |
| 自审 | 只改一个 href；目标文件已核实；未添加死链豁免 |

完整 Clippy 命令已在独立 D 盘临时/构建目录执行；本地应用构建的 dist/WASM 前置条件未由本次文档修复生成，实际退出结果及云端完整 CI 证据记录在关联修复 PR，不把未完成的本地运行计为通过。

## 测试处置

复用真实 VitePress 构建作为回归信号，未新增镜像 Markdown 解析实现的单元测试。现有测试与门禁保持原样。

## 后续核实

修复 PR 合并前遵守必需门禁；合入 main 后核实 Deploy Docs 的 build/deploy 与 PR #634 最新 head 的检查，并回写 issue。修改站点外文件引用时应使用可访问的源码 URL，并运行真实文档构建。
