# Dev Record — #607 刀1 界面模式落点数据准备

## 元信息

- issue：#607
- 分支：`feat/mode-landing.1`
- 提交范围：基线 `29cac928`，本轮未暂存、未提交、未推送、未开 PR。
- 日期：2026-10-12
- 执行署名：ZCode GPT-6.1 工作者
- 依据：刀1补单 v3，替代 v2 的全表 Partial 要求；本记录只声明刀1数据准备完成，待翻译独立核验。

## 目标与范围

为九份呈现档案准备独立的 chat/cc 标量出厂数据，支持三桶装配与 chat 轴查询。旧生产索引、旧50条数据、十套全局引用、两份默认值、生产模式映射、切换/重置事务和自定义持久化行为均不改变。档案及插件贡献通道不删除；不确定样式/配色覆盖策略；不伪造蓝调全套默认。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/presets/types.ts` | PresetInterfaceMode 加 tactical | 修改 |
| `src/domains/theme/presets/builtin.ts` | DEFAULT_PRESETS 阶段类型：gui/terminal必填、其他桶可缺 | 修改（仅类型） |
| `src/__tests__/effectivePresetTheme.test.ts` | 导入模式类型、辅助函数参数拓宽；函数体和全部断言原样 | 修改（仅类型） |
| `src/domains/theme/zones/zonePresetPool.ts` | chat可选轴、互斥来源身份、三桶空格装配、显式纯查询 | 修改 |
| `src/domains/theme/zones/index.ts` | 保留旧导出，追加独立数据/类型/查询 | 修改 |
| `src/domains/theme/zones/factory/profile-chat.ts` | 手写chat标量切片 | 新增 |
| `src/domains/theme/zones/factory/profile-cc.ts` | 手写cc标量切片，不带布局 | 新增 |
| `src/domains/theme/zones/factory/profileEntries.ts` | 独立桶→区域顺序拼表，不进旧索引 | 新增 |
| `src/domains/theme/zones/__tests__/modeLandingData.test.ts` | 六个数据/装配/隔离/来源守卫 | 新增 |
| `src/domains/theme/zones/__tests__/factoryZonePresets.solid.test.tsx` | 点名存删流程中追加新档案编号不混入用户数组断言，旧断言全部保留 | 修改 |
| `.agents/records/issue-607-knife1-mode-landing-data.md` | 本记录 | 新增 |

`.agents/L.md` 是开工前翻译已有改动，本轮未修改。其余旧行为测试、布局守卫均未修改。

## 方案要点

- 采用条目可选 `axis`，不用分键改变其余区的数组形状。类型限制只有 chat 可写轴；新显式查询把旧无轴条目解释为color但不改写条目。旧查询完全不接新数据。
- 来源用互斥 `{presetName}` / `{profileId}` 身份，避免把档案伪装成旧全局预设。新条目id直接用完整profile id，唯一键是mode/zone/id。
- 新数据文件为手写字面量，不读取运行时档案注册表生成值；档案仅在测试侧作为逐键对拍来源。
- 明确按interfaceMode归桶；缺省为terminal，不按family猜桶。因此paper-low-contrast与console-glass均进入terminal备料。
- 相同值不同来源不折叠，Agent三份cc切片保留各自身份。
- `tactical`装配有五格；旧生产池该桶为空，`tactical-blue`生产映射仍未登记，默认表仍无tactical项。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 来源九份，每份chat/cc逐键对拍 | 新测试6/6通过；18个复合键唯一 |
| 新数据读数 | gui chat4/cc4；terminal chat4/cc4；tactical chat1/cc1；其他区域0 |
| 样式/配色 | 新style9，旧chat color10，新color0；中控新增9；蓝调仅2条标量备料 |
| 旧50条/10id/顺序/引用与对象身份 | 原守卫保留并全量绿；旧索引和10文件逐文件零diff，换行归一后11/11与HEAD一致 |
| 原默认值/引用/映射 | builtin.ts仅一处类型替换，程序化对照PASS |
| 三个未授权报错测试 | 零diff，无非空断言、强转或跳过检查 |
| 反向验证 | 六个新用例及旧用例新增断言共7项均有AssertionError红灯；探针恢复3/3字节一致 |
| 五步门禁 | 顺序执行，全为EXIT=0；全量685文件/5373用例通过，既有1文件/1用例跳过 |

## 测试处置

- 新增 `modeLandingData.test.ts` 的六个用例，逐个反向验证。
- `effectivePresetTheme.test.ts` 仅 import type + unionOfZoneSlices 参数类型，无行为断言改动。
- `factoryZonePresets.solid.test.tsx` 仅点名的「存/删自定义条目的整条流程跑完，50 条出厂条目始终不在该数组里」追加独立新factory编号排除断言；原50条/10id与存删流程原样。该新断言另做反向验证。
- zonePresetPool / factoryZonePresetLayoutGuard / presetAssembly / firstRunThemeSeed / ccVisibilitySliceGuard全部原样。

## 证据

- `bun run lint`：`$ eslint src/`，EXIT=0。
- `bun run build:example-plugin`：`[build-example-plugin] dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建`，EXIT=0。
- `bun run build`：`✓ built in 9.16s`，EXIT=0。
- `bun run check:solid`：`ZONE_FIELDS 一致性契约通过（177 个主题字段，排除元字段：appliedPreset, custom, ccEditMode）`，EXIT=0。
- `bun run test`：`Test Files 685 passed | 1 skipped (686)`；`Tests 5373 passed | 1 skipped (5374)`，EXIT=0。
- 还原后定向5文件53测试通过；新增隔离断言补齐后再次全量门禁通过。
- 旧数据零变更、默认表值/引用/映射唯一类型差异、辅助函数唯一类型差异、探针还原均有独立机器检查。
- 完整命令、原始输出、反向红灯及逐档案待迁移清单已交付在仓外报告；不把个人报告绝对路径入库。

## 与施工单的偏差

无最终实现偏差。v2阶段遵照全表Partial造成29条单外类型错误并停工；v3改用准确的必填/可缺类型及点名辅助函数适配后消除，不修改其他三个文件。反向验证第二项首次为TypeError，后改为保留桶但吞掉蓝调条目，取得断言红灯；新增隔离断言第一次调用含空格用例名被Windows命令行拆开、全跳过，未作为成功证据，改用准确参数调用取得红灯。

## 未解问题与验证限制

- 新数据尚未接入候选和默认；蓝调配色、其他区域、完整默认留刀2。
- 九份global `inputBorderColor`均未迁移，不能放入cc。九份assets原样留在档案；Agent三份各八项kindTokens也尚未迁移。九份档案无rendererSuiteId；身份元信息与贡献通道仍保留。逐档案键和值已在回单列清。
- 样式数据含原档案色值是保真备料，不决定最终样式/配色分工或优先级。
- 本刀按单免真实界面手点与Rust/clippy；最终接线刀需真实应用验收。
- 部分check:solid子检查按git跟踪面扫描，按用户不暂存要求不会覆盖新文件；没有擅自暂存。新数据通过编译、lint、Vitest逐键检查与人工源码依赖自审；不把该门禁退出码冒充每个新文件已被所有扫描器覆盖。
- 现有测试输出有JSX工具告警、现有probe用例跳过，退出码仍0；未顺手扩大施工范围处理。

## 并行交集

共享改动为presets桶类型/默认表类型、zones条目类型与导出面及点名测试。旧生产索引与运行事务未动，其他贡献者不应误以为数据已经接入生产。
