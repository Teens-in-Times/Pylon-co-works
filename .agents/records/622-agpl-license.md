# Dev Record — #622 Adopt AGPL-3.0

## 元信息

- issue：https://github.com/Teens-in-Times/Pylon-co-works/issues/622
- 分支：`license/agpl-3.0`
- 基准提交：`408d6ecccd3abaecb0cd61a492a5c57106e1e391`
- 日期：2026-10-15
- 稳定署名：Codex / AlchemistCxC

## 目标与范围

按仓库所有者要求，将 Pylon 的整体项目许可改为 GNU AGPL version 3 only，SPDX 为 `AGPL-3.0-only`。保留 Codeg 和其他第三方软件的许可证、署名与来源记录；不修改产品代码、依赖版本或历史发行版本。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `LICENSE` | 标准 GNU AGPL version 3 全文 | 修改 |
| `README.md`、`NOTICE` | 整体许可、版权与第三方声明说明 | 修改 |
| 12 个第一方 `Cargo.toml` | package.license | 修改 |
| 根与两个示例 `package.json` | license | 修改 |
| 本记录 | 验证与交付证据 | 新增 |

## 验收标准与结果

- 根许可证与 GitHub Licenses API 返回的标准文本逐字节一致。
- 12 个 Cargo 包、3 个 npm 包的 SPDX 元数据均为 `AGPL-3.0-only`，JSON/TOML 解析成功。
- 既有 `LICENSES/` 许可文件与来源登记未修改；原 NOTICE 的非空声明逐项保留。
- `git diff --check`：退出码 0；源码文件零改动。
- 自审：移除了 README 中重复的 License 标题；未使用第三方源码声明的全局替换。

## 测试处置与本地限制

无新增或修改的行为测试。本次修改仅包含许可文本与包元数据。

- `bun run check:clippy` 已执行；首次因系统临时盘空间不足失败（Cargo 101）。清理仅涉及本次检出的构建缓存，随后以独立 D 盘临时目录与构建目录重试。
- 迁移后的 Clippy 在 `src/lib.rs` 的 Tauri `generate_context!` 宏展开处失败（Cargo 101）；完整前端构建依赖尚未就绪。该失败没有作为通过证据。
- `bun run check:frontend` 与 `bun run check:solid` 已执行，分别因本次独立检出未安装 eslint/tsc 而退出 1。
- 后续验证结果与 GitHub 必需的“门禁总闸”状态记录在关联 PR；合并遵守该必需检查，不调整 CI 或分支规则。

## 交付与并行交集

PR 完整解决 #622，合并后关闭该 issue。此独立检出只修改上表的许可和元数据文件；原始开发工作树未操作。
