# #753 工作页导航、历史裁剪与测试重构

署名 Codex，2026-11-26。分支 `kumo/prometheus`，基准 `6bd9549c`，关联 #753、#611。

## 目标与范围

本轮从工作页启动、搜索结果阅读与导航、历史数据保留三个日常入口着手。前端、后端、测试三组分别施工，集成阶段复查跨模块行为、全量门禁和便携桌面实例。沿用工作台的 Solid、第一方插件样式及 SQLite 所有权约定。

## 产品与架构改动

| 文件域 | 变更 |
| --- | --- |
| `workspace-sheets/SheetLauncher.solid.tsx`、shell 包 `App.css` | 启动器共用一份有序分组和选项。过滤、指针、方向键和 Enter 使用同一可用状态。可选项滚入视区，输入与底部提示保留在列表外；关闭回到入口，迟到的 Agent 连接不再从已关闭的弹层触发导航。工具与管理入口继续支持原注册关键词。 |
| `domains/search`、`domains/chat/messageSearchIndex.ts`、`sheets/search`、workspace 包 `adaptive.css` | 内置快照与桌面投影共用命中片段提取，桌面端从消息原文截取，大小写折叠产生的长度差映射回原文；会话内检索继续使用小写缓存。列表按可用空间编排，可读但失去目标会话的结果标记不可用。 |
| `pylon-session/src/msg_repo/{mod,retention}.rs` | 保留策略版本、候选计数、预览和删除归入同一个 SQL 模块。按条数裁剪仅对超额 owner 执行删除，使用已有复合主键查最后一个应删序号；同一事务覆盖版本检查、计数与全部删除。原导出路径、序号间隙、时间裁剪的草稿回收均保留。 |
| `src-tauri/src/lib.rs` | #611 的 `windows_created` 落在 setup 建窗成功与恢复工作区之间。 |
| `vitest.config.ts` | 每个测试文件只读一次来确定所属项目。五个内联项目继承根 Solid 插件，环境与隔离策略仍按原分组选择。 |

## 性能证据

在仓库根运行 `python .agents/records/753-evidence/retention_bench.py --base 6bd9549c --rounds 5`。脚本从两版源码提取 SQL，用相同 schema 和 4 个 owner 的 5,250 行稀疏序号数据测量内存 SQLite 写事务。每轮独立检查所有保留的 owner 和序号，预期删除 2,000 行、留下 3,250 行。

| SQLite 3.53.1，5 轮 | 旧版 | 本轮 |
| --- | ---: | ---: |
| 事务中位耗时 | 1,133.85 ms | 2.55 ms |
| 每 1,000 条虚机指令的回调数，每轮相同 | 30,482 | 66 |

上述时间包括版本读取、候选计数、删除与提交，适用于这份内存数据集。真实磁盘、数据量与分布会影响绝对耗时。

## 测试处置

- `sheetLauncherRegistry.solid.test.tsx` 改用选项、当前选择与操作结果验证筛选、禁用项、键盘和指针，`sheetLauncherAgentSwitch.solid.test.tsx` 增加关闭后连接迟到的用例。
- `SearchSheetView.solid.test.tsx` 用长消息的尾部命中与会话移除替换重复导航用例。原导航断言继续由 `searchNavigation.integration.solid.test.tsx` 走真实 owner-aware 事务。`SearchSheetView.requests.solid.test.tsx` 核验重试和不可用状态，`searchService.test.ts`、`snapshotSearch.test.ts` 通过各自入口验证原文大小写、Unicode 边界及命中片段。
- `agentWorkbenchCommands.test.ts` 显式控制发送 Promise，首发进行中和完成后的状态都可观察。`fixtures.test.ts` 用虚拟时钟检验延迟到期与挂起；`migration.test.ts` 对历史数据的实际迁移结果作断言。三个文件乱序种子 7536、7537、7538 各 32/32。把迁移后的 `send` 位置替换为默认值，9 个迁移用例中仅对应断言失败，还原后 9/9。
- `src-tauri/src/acp/tests.rs` 对初始化参数、权限单向应答、provider 能力与环境传递使用受控的 Rust fake-agent。初始化响应或匹配的 trace 行提供完成信号，替代固定 150/200 ms 等待；未指定 Hermes 路径时断言继承调用环境的值。
- `msg_repo/tests.rs` 将仅检查剩余条数的保留用例改成逐 owner 检查完整序号集合、预览计数、时间逆序及幂等；另用临时 trigger 在第二个删除失败时检查所有 owner 回滚。`pylon-session --lib` 共 227 项通过。
- 首轮全量报告三处超时。`interfaceModeScenes.solid.test.tsx` 等待真实装饰模块导入后读取 `aria-hidden`；`FileSheetView.integration.solid.test.tsx` 中切换工作区和读取规范化文件列表的两个用例，先等待首次懒加载的会话区与文件树完成，再操作 UI 并核对 IPC。`FileSheetView` 定向 15/15。
- Vitest 五个项目逐文件对比分配结果相同。702 个源文件的分类读取从 3,510 次降到 702 次。Node 独立/共享组分别为 19/430，jsdom mock/共享组为 6/53，Solid DOM 组为 194。

## 实机与门禁

便携测试实例使用 WebView2、独立数据目录和本地 Rust fake Agent。旧版在两种界面及 1200×800、800×600 两种窗口下均可复现：向上环选最后一项后列表滚动仍为 0，活动行在视区外。筛选无结果时仍留有一个空 Agent 选项。原生搜索把用户输入的 `Search753EndMarker` 显示为 `search753endmarker`。旧构建的启动相位顺序为 `windows_created` 190 ms、`setup_enter` 203 ms、`data_dirs_resolved` 221 ms。

- `bun run check:frontend` 退出 0。701 个文件、5,522 项通过，1 项既有跳过。类型、架构、样式归属、体积、文档、IPC 与 223 个 JS 产物的生产隔离检查均通过。
- `cargo test -p pylon --lib acp::tests:: -- --test-threads=4` 通过 63/63；改写的 9 个子进程用例另以同一二进制并行跑 5 轮，45/45 通过。给真实 TacticalScene 动态加载加 1,600 ms 延迟，原测试 1 红，修订后 4/4；常规五轮 20/20。
- 最终原生程序 SHA-256 为 `1801df492a5aaf7005834ca22e7ba2324851d960965cf066854157f1f8e1cb79`。二进制中核对了本次构建的启动器、搜索和 shell 资源名。新实例的相位次序为 `setup_enter=620`、`data_dirs_resolved=786`、`windows_created=3879`、`persistence_ready=4037`、`setup_complete=4079` ms。

| WebView2 实测 | 终端 1200×800 | 终端 800×600 | 现代 1200×800 | 现代 800×600 |
| --- | ---: | ---: | ---: | ---: |
| 启动器行高，旧版均为 52 px | 43.58 px | 43.58 px | 48 px | 48 px |
| ↑ 环选到末项后的列表滚动 | 219 px | 347 px | 272 px | 400 px |
| 搜索结果可用宽度 | 878 px | 502 px | 838 px | 470 px |
| 搜索结果排版列数 | 2 | 1 | 1 | 1 |

四组的启动器末项均在可视区内，Esc 均还焦入口，零匹配时均为 0 个 option、1 个 status。窗口和搜索结果行横向溢出均为 0 px。真实用户消息在四组都保留并高亮 `Search753EndMarker`，点击命中能打开相应会话。另一次原生搜索命中 2 条，WebView2 网络记录 10 条、失败 0 条，RuntimeLogHub 没有 error 条目。

[现代模式启动器](753-evidence/launcher-modern.png) · [终端模式键盘环选](753-evidence/launcher-terminal.png) · [可复跑的裁剪对照](753-evidence/retention_bench.py)

- `bun run check:rust` 退出 0。fake-agent 11 项、workspace 库 1,737 项通过，4 项既有忽略。主程序构建成功，ACP shadow 录制两轮、8 个场景及背压检查通过，`cargo fmt --all --check` 通过。
- `bun run check:clippy` 退出 0。首轮发现 ACP 测试有一个无用导入，移除后 7 个 crate 均为零新增诊断，持锁清单 17 个文件 / 55 处全匹配。

## 提交与范围调整

启动器 `d032c535`，搜索 `b884d127`，会话存储与基准 `a4373516`，前后端测试与分类 `14954b79`，建窗相位 `21660f76`。说明书同步到工作台、保留策略和启动时序三处。全量测试暴露的两个懒加载测试文件和实机发现的搜索大小写问题已纳入本轮。

实机使用本地测试 Agent；外部供应商及其在线服务在该记录的验证范围之外。公开 `RetentionPolicy::parse` 的非法值回退契约及用例继续保留。#707 的后端写序锁提案仍在原议题等待裁决。
