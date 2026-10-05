# Dev Record — #569 respond_interaction 接缝批：kind 静默容错契约化 + 构造臂归位 private_ext

## 元信息

- issue：[#569](https://github.com/Teens-in-Times/Pylon-co-works/issues/569)（#436 裁决立项）
- 分支：`kumo/569-interaction-seam`（基于 `github/main` @ `7b521680`；独立 worktree `../prism-desktop-569`，依 §2.1 避让共享树 #364/#545 在途）
- 提交范围：`7b521680..<head>`
- 日期：2026-10-05

## 目标与范围

落地 #436 三项裁决中的两项（同批施工）：① `kind` 契约明文化——静默容错定位为诊断元数据，不参与路由、后端不复核（显式错误码已否决）；② 私有桥应答构造臂从 `permission.rs` 归位 `protocol_adapter/private_ext.rs`（与其 `parse_*`/`build_*` 同归属），行为逐字保留。

**不做什么**：不碰 `approve_tool_call`（#568 定向化另批）；不做 kind 显式校验；不改 GUI/CLI 发送侧；wire 格式、命令签名、队列快照面零变化；既有测试零修改。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/protocol_adapter/private_ext.rs` | 新增 `build_interaction_response`（原 permission.rs match 三臂逐字搬移；错误文案逐字节保留）；tests 模块新增 4 个单测 | 修改（新增函数+测试） |
| `src-tauri/src/permission.rs` | `respond_interaction` 私有臂替换为单点调用；doc comment 补 #436 kind 契约段 | 修改 |
| `src-tauri/src/protocol_adapter/mod.rs` | `respond_request_permission` 的 kind 字面校验处补一行定位注释 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | #423 审批线段末句「另裁」表述收口（构造臂已归位 + kind 契约 + #568 指针） | 修改 |
| `.agents/L.md` | 施工范围声明（已在合并后撤条） | 修改 |

## 方案要点

1. **签名走原语不走登记结构**：`build_interaction_response(bridge, params, question_specs: Option<&[QuestionSpec]>, answer: &InteractionAnswerInput)`——private_ext 保持「closed parser/builder boundary」（收原语出 Value），不反向依赖 `private_interaction::PendingPrivateInteraction`；`InteractionAnswerInput` 沿用 permission 层 wire 类型，与 `protocol_adapter/mod.rs` trait 既有依赖方向一致。
2. **行为逐字保留**：三臂逻辑与错误文案（"private question request lost validated specs" / "elicitation action unsupported: {other}"）逐字节搬移；内部 `let answer` 遮蔽更名为 `question_answer`（纯更名）。permission 臂的 `kind != "approval"` 历史校验原样保留并在注释中定位（GUI 恒发 'approval'、CLI 投影 kind 恰为 'approval'，实际不构成门槛）。
3. **kind 契约三落点**：`respond_interaction` doc comment、`respond_request_permission` 校验处行注、说明书审批线段——三处同口径（#436 裁决原文）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 既有行为测试全绿且未被修改 | ✅ `cargo test --workspace --lib` 全绿（0 修改既有测试） |
| 门禁绿（clippy 基线外零新增） | ✅ `node scripts/check-clippy.mjs` + `check-await-holding.mjs` 零新增诊断 |
| 结构目标：构造臂离开 permission.rs、kind 契约双落点可查 | ✅ permission.rs 私有臂为单点调用；注释 + 说明书同口径 |
| 未新增白名单豁免 | ✅ 零豁免改动 |
| fmt | ✅ `cargo fmt --all --check` 干净 |

前端零 diff（`check:frontend` 不在本批运行，PR CI 兜底）。

## 测试处置

既有测试：零修改、零删除。新增（`private_ext.rs` tests，均为 #569 形状钉）：`build_interaction_response_routes_question_answers`、`build_interaction_response_question_declined_and_lost_specs`、`build_interaction_response_exit_plan_defaults_and_overrides`、`build_interaction_response_elicitation_actions_and_whitelist`。

## 证据

- commit：见分支 `kumo/569-interaction-seam`（代码 + docs + record 各自 pathspec 提交）
- 测试：`cargo test --workspace --lib` 全绿（附 PR 描述计数）；clippy 零新增诊断（基线比对脚本退出码 0）
- 手工验证：不适用（纯接缝搬家，无行为面；实机验收按 skill 判据跳过）

## 与 spec 的偏差

无（spec：`.agents/spec/569-interaction-seam.md`，一次性不入库）。

## 未解问题

- 无新缺口。#568（approve_tool_call 定向化）另行施工；其落地后说明书该段需再同步一次（已留 #568 指针）。

## 并行交集

- 共享 checkout 零触碰（独立 worktree 施工）；`docs/说明书/Pylon-项目架构参考.md` 第 209 行段落为本批唯一说明书改动（#482/#483 历史声明域，其 PR 已合并、条目陈旧）。
- `permission.rs` 在 #548/#549 历史声明域内，但其工作已并入 main（ADR-0037 注释在案）；本批只动 `respond_interaction` 私有臂与 doc comment，与其无逻辑交叠。
