# Dev Record — 563 新会话发送误报 canonical.journal.malformed

## 元信息
- issue：[#563](https://github.com/Teens-in-Times/Pylon-co-works/issues/563)
- 分支：`codex/563-journal-malformed`，隔离 worktree `journal-malformed`
- 基准：`eb94ae47`（开工 fetch 后的 `github/main`）
- 实现与测试提交：`80ea8a5f`（协调声明：`26e9c57c`）
- 日期：2026-10-05
- 署名：Codex

## 目标与范围
用户反馈最新构建中，新开的会话发送消息即出现「canonical journal 有 1 条事件无法迁移」，详情 `malformedCount:1`。本次修复 Workbench 对合法静默事件的误判，不改数据库、持久化格式或 #405 的展示策略。

## 改动清单
| 文件 | 职责区段 | 性质 |
| --- | --- | --- |
| `src/application/agent-workbench/agentWorkbenchProjection.ts` | 行读取成功/失败契约、turn.unit 段展开、诊断文案 | 修改 |
| `src/application/agent-workbench/agentWorkbenchReplay.ts` | 冷读/分页收集与 refresh 的 malformed 统计 | 修改 |
| `src/application/agent-workbench/agentWorkbenchSession.ts` | live 行读取与 malformed 统计 | 修改 |
| `src/application/agent-workbench/__tests__/agentWorkbenchSession.test.ts` | 3 个静默变体的 live/refresh/冷读/分页用例；混合损坏行用例；fixture 明确 canonical 返回类型 | 修改 |
| `src/__tests__/replay/agentWorkbenchSession.batch.test.ts` | 3 个静默变体的 turn.unit 与逐行等价用例 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §8.3 行读取与诊断语义 | 修改 |
| `.agents/L.md` | 隔离施工声明 | 修改 |

## 原因与方案
Peri 的 `goal_snapshot` / `turn_committed` / `state_snapshot` 是已知簿记事件。#405 的既定策略返回 `events:[]`，避免在聊天时间轴生成原始 JSON 卡；canonical journal 仍保存 raw。旧宿主 live、冷读、refresh 均把空事件数组当成解析失败，因此新会话也会报迁移错误。

初始回归在空 journal bind 后发布一条静默事件，3/3 产生用户同款 `degraded` / `canonical journal 有 1 条事件无法迁移`。三个可证伪假设是合法空投影误计数、canonical schema 校验失败、turn.unit 嵌入段展开误判。首个假设获得直接证据；本地最新 Peri 会话的 compact 单元中确有一条 `goal_snapshot`，只读提取该段后，校验输出 `schemaProblems:[]`。

`readWorkbenchRow` 返回判别结果 `{ok:true,envelopes}` / `{ok:false}`，不再用数组长度表达读取成败。成功空投影不会计数或修改 live snapshot；失败继续 degraded。turn.unit 的成功空段直接返回，不进入坏段回退路径。真正失败的文案改为「无法解析」，诊断 code 和 malformedCount 字段保持不变。

## 验收标准与结果
| 验收项 | 结果与证据 |
| --- | --- |
| 新会话 live 收到静默事件不误报 | 3 种变体均保持与收到前相同的 runtime snapshot |
| refresh、冷读、分页冷读同判 | 3 种变体全部无 malformed 诊断、error 为 null，用户正文保留 |
| turn.unit 静默段与逐行存储同判 | 3 种变体均保留用户/助手正文，无诊断卡 |
| 真正损坏行继续诊断 | 静默行 + eventId 非法行只报 count=1；再收静默行不增长，再收非法行增至 2；原畸形 schema 用例仍通过 |
| 真实数据读取分类 | 只读提取本地最新 Peri journal 的 goal_snapshot 段并重放：`{"schemaProblems":[],"ok":true,"projectedEventCount":0}`，exit 0 |

## 测试处置与证据
- 新增 7 个行为用例（运行时 4 个、单元段 3 个）；未删除或改变既有行为期望。
- 相关 Vitest：3 files / 63 tests passed，exit 0（包含 Peri normalizer 既有静默策略测试）。
- 全量 Vitest：667 files passed / 1 skipped，5217 tests passed / 1 skipped。`check:frontend` 随后在新分页 fixture 的类型推断处报 TS2322，已将原 helper 返回类型明确为 `CanonicalConversationEvent`；重新通过定向测试与完整 `check:frontend:static`（包含 tsc/build/包预算/docs 等），exit 0。未改动运行时行为以通过测试。
- `check:solid`：exit 0（类型与全部 Solid/领域边界门禁）。
- 新开发记录落地后补跑 `check:docs`：exit 0，文档链接检查 4 项通过，维护审计通过。
- `bun run check:clippy`：exit 0；6 个受管 crate 的 `added:[]`（基线外新增诊断为 0）。`check-await-holding` 通过，17 文件 / 55 处 HeldAcrossAwait，裸 allow 0 处。初跑受新 worktree 缺少 `dist` 阻断（Tauri generate_context 的 frontendDist 前置），前端生产构建成功后重跑通过；Rust 源码零改动。
- 自行复审：diff 与调用点核验，无残留旧行读取数组长度判定；`git diff --check` exit 0。未派发子 agent。
- 未运行修复后二进制的真实 Agent 发送验收。此次改动为纯行读取结果分类与文案，不涉及 IPC、时序、布局或持久化写入；运行时行为测试与真实 journal 段重放覆盖错误判定 seam。已安装发行程序未替换。

## 与 spec 的偏差
无产品范围偏差。新增 fixture 返回类型用于通过分页读契约的 TypeScript 检查。Clippy 与前端 build 的先后前置在隔离检出中暴露，按实际前置补齐。

## 未解问题
无本次已知逻辑遗留。PR 合并后的新构建与真实 Agent 运行验收由后续构建流程完成。

## 并行交集
共享工作树 `.agents/decisions/0035-*`、`.agents/records/515-*` 为他人在途，本次未 stage/commit。代码、说明书、记录均在独立 worktree；施工声明合并后可撤。
