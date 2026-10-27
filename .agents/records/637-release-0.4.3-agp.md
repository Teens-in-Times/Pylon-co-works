# Dev Record — #637 发行 0.4.3-AGP

## 元信息
- issue：#637；署名：Codex。
- 分支：release/0.4.3-AGP；基准：b118336277840873a826bb031e719fe8a1631c5a。
- 日期：2026-10-15。

## 目标与范围
用户要求“build release 版本号你自己起”，并确认“同时发布 GitHub Release”。选择 0.4.3-AGP，沿既有 pack_release.py / release.yml 流程发行。包含最新 main 的模式落位、AGPL 与文档链接修复。

## 改动清单
- pack_release.py 对九份版本文件统一落位；六个随应用发布的 crate 同步，独立版本 crate 保持其自身版本。
- package.json / bun.lock：JS API 从 2.12.3 恢复为 ~2.11.0（安装 2.11.1），plugin-fs 从 2.7.0 恢复为 ~2.5.2，与当前 Rust 2.11.6 / 2.5.2 对齐；其余依赖未升级。
- scripts/pack_release.py：强制收录仓库 LICENSE、NOTICE、LICENSES/Apache-2.0.txt。缺任一文件即失败；声明原文保持不变。
- docs/说明书/Pylon-发行包清单.md：同步许可文件清单，以及主 API / 插件 minor 对齐规则。

## 方案与证据
- 原始 Tauri build --no-bundle 的实际版本守卫退出 1：API 2.11.6 vs 2.12.3；fs 2.5.2 vs 2.7.0。修复后发行构建通过该守卫，进入正常 Rust 编译。
- 沿 #598 的既有策略对齐前端约束，保持 Rust 锁文件依赖不升级；Cargo.lock 仅六项本地版本变动。
- 使用 pack_release.py --bump 0.4.3-AGP --no-commit --build 统一落位。先执行提交前 clippy，再调用脚本的 commit_version_bump 按九文件 pathspec 提交；保留自动生成的 (#402) 信息。版本提交 27b582ea。
- 构建复用 D 盘 release 缓存，临时文件与 Bun 缓存也在 D 盘；未改变用户全局环境。
- 许可与第三方声明经过现有内容审计。ORIGIN.md 含历史本地绝对路径，按现有禁绝对路径规则不入 ZIP；NOTICE 原样保留，逐文件来源记录仍随源码仓库提供。

## 验收结果
- 冻结安装：退出 0，API 2.11.1 / fs 2.5.2。
- test:pack：45 tests 通过（约 0.3s）。
- check:solid：退出 0；177 个主题字段一致性、23 个 hook 锚点全等，架构边界通过。
- check:clippy：退出 0，基线外新增诊断 0；17 文件 / 55 处 HeldAcrossAwait 与清单一致，裸 allow 0。
- 前端静态检查：lint、CSP、三项生成契约、IPC、样式所有权、Tailwind 纯度通过；bundle / Solid smoke / 文档维护 / immer / 生产隔离后续链退出 0。
- 本地完整发行链退出 0：主程序 release 编译 6m30s，检测器后续构建 2m59s，MCP 编译 8.92s；本地 ZIP 38,884,495 字节。
- 本地全量前端测试（maxWorkers=2）：690 文件通过、1 文件跳过；5409 tests passed、1 skipped，430.61s，退出 0。所有测试均保留。
- ZIP 与 manifest 全量双向核对 296 项、SHA256 一致、data/ 为空、许可三文件与仓库逐字节一致；主程序为 x64 GUI PE（subsystem=2），ProductVersion=0.4.3-AGP。探测器 --help 与 MCP --version 均退出 0。
- 本地 ZIP SHA256：9ef9e89dba4799a6ad957fc61c6e1d2ea2ee924bb25d94588bac87a70a3fc45a。
- PR #638、正式发行工作流及远端三项资产的最终证据统一回写 #637；本记录描述发行前置与本地验收。

## 测试处置与验证限制
无新增、修改或删除测试。新许可清单通过真实 ZIP 内容审计验收。初次本地前端全量运行出现大量 0-test 文件并停滞，终止本任务该进程树后改用 maxWorkers=2 完整运行；单独 env.test.ts 复测 1/1 通过。最终较低并行度的完整运行已通过，原始运行保留为环境限制记录。初次构建输出转发器因 Windows GBK 无法打印勾号而停止，修复任务目录转发器为 UTF-8 后重跑；产品源码不涉及该问题。未进行真实 Agent 会话或 GUI 交互验收。

## 自行复审
核对九文件版本同步、Cargo.lock 只变本地版本、Bun 锁只变两项依赖及去除重复 API 锁项、许可原文完整收录。未派发子 agent。隔离克隆无他人在途改动，提交使用精确 pathspec。

## 未解问题
本地发行前置无未解阻塞。#637 负责追踪远端 CI 与正式 Release 三项资产验收，验收后回写并关闭；实际发布状态以该 issue 和 v0.4.3-AGP Release 为准。
