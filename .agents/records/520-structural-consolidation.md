# Dev Record — #520 结构收敛批（前端结构审查落地）

> 入库保留。一次性审查清单（`.agents/spec/520-structural-audit-20261004.md`，不入库）的目标、范围与验收结论在此承接。

## 元信息

- issue：#520（后续结构批，只评论不重开）；行为缺陷拆出 #536/#537/#538（本批关闭）
- 分支：`kumo/prometheus`
- 提交范围：`6afe4bc4..HEAD`（10 施工簇 A-K + 复查修复批，见 git log）
- 日期：2026-10-04

## 目标与范围

四路只读结构审查（分层依赖/状态架构/体积热点/插件契约）的全部可落地收敛项，按 10 个互斥文件域并行施工；完工后四路只读复查，P0/P1 清偿后收口。

**不做什么**：theme↔cc 10 文件大环的实际拆解（check-import-cycles 已基线登记，拆解留后续批）；#535 游标层聚合 gap（行为修复，独立 issue）；`useRightRailStore` 更名（登记为自觉债务）；pet 通道死岛删除（#483 既有决策保留）。

## 施工簇 → 审查发现对照（S-ID 映射）

| S-ID（spec 一次性文档） | 落点 |
| --- | --- |
| S1-P0-1 | H 簇：contribution-boundary 扫描面加 application + allowlist 陈旧检测 + core↛视图层反向规则 |
| S1-P0-2 | G 簇：identity 端口化拆环（runtime-only 图 identity 零 SCC） |
| S1-P0-3 | H 簇基线登记（theme↔cc 拆解留后续） |
| S1 门禁缺口 1-5 | H 簇：check-import-cycles.mts 新建（基线 10 环）、layer +4 规则（豁免 97 边）、runtime-boundaries 纳管 event、生产禁入测试资产条款 |
| S2-P0-1/2/3 | #536/#538/#537（B/A 簇修复） |
| S2-P1-1/2 | G 簇：sessionUi 双注册表归一 + 清空链入端口 |
| S2-P1-3/5 | I/G 簇：approvalMode 收进 store 侧；workspaceEntityStore 迁域 |
| S2-P2 | I/F 簇：clearSessionRuntime 别名删、switchAgent 装配去重、selectOwnSessions 抽取（两处变体合理未收） |
| S3-P0-1/2/3 | B/C/D 簇：agentWorkbenchSession 拆三模块、ControlCenter/InputBar 拆分（含直接挂载测试）、BrowserSheetView 拆分 |
| S3-P1-1~6 | C/D/I/B/F/J 簇对应拆分 |
| S3-P2 | D/K 簇：图标表归一（LucideIcon IconNode）、ConfirmArmButton、Spinner/EmptyState、ToolBodySubProps、MarkdownContent 链路注释 |
| S4-P0-1 | F 簇：FileSheetView 改为消费注册 component（反向选择，理由见 F 簇报告） |
| S4-P0-2 | G 簇（testing bootstrap 迁出）+ H 簇（门禁负向规则） |
| S4-P0-3 | E 簇：settings schema 正身上移 contracts（fonts B-5 范式），环断 |
| S4-P1-4~8 | F/E 簇：createAgentSidebarSharedProps、PluginContributionBody 七宿主、typed component、kindChain 归一、SDK 补 Suite/Slot、双轨正名 |
| S4-P2 | E/K 簇：函数臂塌缩、interface-mode 'host' 臂保留待 API 主轴、registryHub/WorkspaceDescriptor 删除、sidebar action-id 注册期防撞 |

## 方案要点

- 10 簇按互斥文件域并行；跨域编译必要波及（测试 fixture 一行改、import 随迁）在簇报告显式声明。
- 复查引入两处契约精化：#538 升级缝（v3 键缺席时 legacy 播种一次并物化，persist 与检测同源存储）；配置备份纳入 `pylon-workspace-layout-v3`。
- 门禁基线以当前树实扫为准（identity 端口化清偿后 SCC 由草案 ~15 并为 10）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bunx tsc -b` + `tsc -p tsconfig.solid.json` | 0 错 |
| `bun run check:solid` 全链（含三个新/改门禁） | 绿 |
| `bun run lint` | 绿 |
| `bun run test` 全量 | **663 文件 / 5192 passed，0 failed**（1 skip 探针、1 todo #535） |
| `bun run check:docs` | 绿 |

## 测试处置

新增约 100 例：ControlCenter 直挂 9、drag controller 19、palette 12、prediction 10、PluginContributionBody 8、drag 行为 3、runtimeEventClient 4、#536 回归、#537 落盘 3、switchAgentRunner 3、approvalModePersistence 6、#538 升级缝 2 案例、SDK parity 用例等。重写：sheetPersistenceV2.compat（信封无 layout 新契约）。删除：pet 三件测试、css01 旧位测试（随文件迁移/退役）。

## 未解问题

1. theme↔cc 大环拆解（基线登记，待专项批）；2. 键盘步进逐次落盘粒度（改动前即如此）；3. keep-alive 第三方会话 sessionUi 条目回收依赖 destroy（缺口先于本批）；4. `aria-hidden` 经 LucideIcon 恒输出（可访问性方向更好，属未登记契约变更）；5. settingsSectionShared/SettingsSheetSidebar 两处 alertdialog 删除确认未纳入 ConfirmArmButton（超出三处范围）；6. pet 通道死岛（#483 决策）；7. 新代码注释以 `#520 S*-P*` 引用一次性 spec 文档——映射以本表为准。

## 并行交集

- F 簇因共享树事故（src/ 一度被还原到 HEAD）自行 pathspec 提交 78884ee4 保护现场，违反「不 commit」纪律但有正当理由，主会话已核并接受。
- 复查抓到 G 簇漏 add 三件（HEAD 断链），已补提交——后续多簇并行批次收尾必须以 `git status --untracked-files=all` 全量对账。
