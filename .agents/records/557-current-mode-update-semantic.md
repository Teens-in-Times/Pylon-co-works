# Dev Record — #557 时间轴把官方 current_mode_update 变体渲染为「未识别」事件卡

## 元信息

- issue：Teens-in-Times/Pylon-co-works#557（bug，已认领 assignee=AlchemistCxC）
- 分支：`kumo/prometheus`（开工前同步 github/main@04ebbc2c）
- 提交范围：`11557204..d55fca92`（coord 声明 + 修复主提交）
- 日期：2026-10-05

## 目标与范围

issue 原话：「`current_mode_update` 进 canonical 词表（或静默消费不产 unknown 卡），模式切换在 UI 有所体现（至少不打未识别卡）」。

**做**：workbench 栈为官方 `CurrentModeUpdate` 变体增语义分支，产出 `session.mode-updated`；单源对应表与 parity 测试跟随；说明书补裁决记录。

**不做**：canonical 栈零改动（词表自 #315 P2/#393 已在册——issue 中「canonical 未登记」的诊断实核为过时）；投影器 `workbenchProjectorReducer.ts` 零改动（#551 在途域，`reduceSession` 已静默消费 `session.mode-updated`）；后端零改动（`reactions.rs:358` 已消费并落 durable 快照）；`cancelled` 的 canonical-only 裁决不动。

## 调查结论（issue 诊断修正）

- 卡片文本出自 `workbenchProjectorReducer.ts` 的 `event.unknown` 诊断臂（「未识别的 ${originalType} 事件」）。
- 产出链是 **workbench 栈**：`acpNormalizer.semanticEventForUpdate` switch 无 `current_mode_update` 分支 → default `createUnknownEvent`；对应表 `WORKBENCH_TYPE_FOR_WIRE.current_mode_update = ['event.unknown']` 是 #315 的显式兜底声明（非登记缺失）。
- canonical 侧 `CANONICAL_TYPE_FOR_WIRE.current_mode_update → 'session.mode-updated'` 早已在册；`config_option_update` 两栈同样在册（issue「待核」项核实为无缺口）。
- #556 开发记录中「`wireSemanticCorrespondence.ts` 标准变体表无此键」为误诊——表有键，缺的是 workbench 归一化臂。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/normalizers/acpNormalizer.ts` | `semanticEventForUpdate` 增 `current_mode_update` 臂 | 修改 |
| `src/domains/events/wireSemanticCorrespondence.ts` | `WORKBENCH_TYPE_FOR_WIRE.current_mode_update` 改键 + 文件头口径裁决翻案 | 修改 |
| `src/domains/workbench/normalizers/__tests__/acpNormalizer.test.ts` | 新增 describe「ACP current_mode_update 模式事实（#557）」三例 | 修改 |
| `src/domains/workbench/normalizers/__tests__/wireSemanticParity.test.ts` | 代表 payload 字段 `currentMode` → `currentModeId`（官方字段） | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | #315 段补 current_mode_update 翻案与 `cancelled` 现状 | 修改 |

## 方案要点

- **别名集与内核单源对齐**：`wireField(update, ['currentModeId', 'modeId', 'mode'])`，`wireField` 键归一化使 snake 变体（`current_mode_id`）自动覆盖——与 `pylon-acp/src/state.rs` current_mode_update 臂四变体全等；官方字段（ACP schema v1 `CurrentModeUpdate.currentModeId`）优先。
- **缺 id 不落 unknown**：schema 违约包按 `session_info_update` 空包先例落 `mode: undefined` 的 mode-updated；`reduceSession` 对 falsy mode 不覆盖旧值（`event.mode ? {...} : {}`），故不会擦除已知模式；raw 恒留信封可诊断。unknown 卡对真实缺陷保留，不放大到形状漂移。
- **UI 体现**：`reduceSession` 把 mode 写进 `document.session.mode`，中控区读该面——模式切换由既有消费面体现，时间轴不再出未识别卡。
- **重放同样受益**：canonical 行带 `rawPayload`，`canonicalRowToWorkbench` 用原始 update 重走同一 normalizer（#393 通路），历史回放不再产未知卡。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 官方字段 `currentModeId` → 唯一事件 `session.mode-updated{mode}`，无 `wire.unknown` 诊断 | ✅ 单测断言通过 |
| `modeId` 别名同集消费 | ✅ 单测断言通过 |
| 缺 id → `mode:undefined` 的 mode-updated，不落 `event.unknown` | ✅ 单测断言通过 |
| parity 测试产出落在对应表集合内 | ✅ 29 用例（14 kind × 2 向 + peri 扩展）绿 |
| 前端全测绿 | ✅ 667 文件 / 5210 passed + 1 skipped（既有 skip） |
| clippy 门禁无基线外新增 | ✅ `check-clippy` added=[] / `check-await-holding` 17 文件 55 处与清单一致 |
| tsc + 架构边界门禁绿 | ✅ `check:solid` 全部通过 |
| lint 绿 | ✅ eslint 无输出 |
| 说明书门禁绿 | ✅ `check:docs` 通过 |

## 测试处置

- 新增：`acpNormalizer.test.ts` current_mode_update 三例（官方字段 / modeId 别名 / 缺 id 不落 unknown）。
- 修改：`wireSemanticParity.test.ts` REPRESENTATIVE_PAYLOAD.current_mode_update 字段改官方 `currentModeId`（兼守主别名路径）。
- 删除：无。投影器侧无新测试——`reduceSession` 消费 `session.mode-updated` 是既有已覆盖行为，本次未改投影器。

## 证据

- commit：d55fca92（5 文件，+45/−5）
- 测试：`bun run test:frontend` → Test Files 667 passed / 1 skipped；Tests 5210 passed / 1 skipped，退出码 0；`bun run check:clippy` → "added: []"、await-holding 通过，退出码 0
- 手工验证：未做实机（webview2 验收）——归一化→投影链有单测全钉（normalizer 三例 + parity 双向 + 投影器既有 mode-updated 覆盖），且 #556 记录的复现路径（prometheus 发 current_mode_update）恰由该单测形状代表；如需实机复核可挂 prometheus 会话切模式观察中控区。

## 与 spec 的偏差

无（spec 见 `.agents/spec/557-current-mode-update-semantic.md`，一次性不入库）。

## 未解问题

无。

## 并行交集

- `docs/说明书/Pylon-项目架构参考.md` #315 段（无他人在途声明）。
- 共享树中 `decisions/0035`、`records/515` 的在途 hunks 属 #545，本工单未触碰、未暂存。
- L.md 条目待 PR 合入后撤。
