# Dev Record — #568 approve_tool_call 定向化——按 agentId 收敛应答目标

## 元信息

- issue：[#568](https://github.com/Teens-in-Times/Pylon-co-works/issues/568)（裁决口 #436 三项之一，仓库主 2026-10-05 批复：定向化）
- 分支：`kumo/568-approve-directed`（独立 worktree `prism-desktop-568` 施工，避让共享树 #364（PR #572）/ #545 在途域）
- 基准提交：`258b5795`（github/main，含 #569 接缝批、#548/#549 锁面退役、#567）
- 日期：2026-10-05

## 目标与范围

`approve_tool_call` 从「跨 runtime 遍历、首个成功者胜」收敛为「按 agentId 定向应答」：新增必填 `agentId` 参数直达目标 runtime，目标不存在显式报错；同 id 请求挂在其他 runtime 时不再有误写首个的理论面。连带处置前端死绑定（`chatClient.ts` `approveToolCall`，全仓零消费）与 `mockTauri.ts` demo stub，不留新旧两形态。

**不做**：不碰 `commands.rs`/`lib.rs`（generate_handler 注册行为名字面，签名变化零影响）；不做 agentId 可选形态与遍历兜底（无生产消费者，无兼容负担）；不碰 `respond_interaction` 既有路径（#569 已收口）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/permission.rs` | `approve_tool_call` 命令体（遍历→定向）+ tests 三个命令级测试 | 修改 |
| `src/infrastructure/acp/chatClient.ts` | `approveToolCall` 绑定删除 + 头注释命令清单同步 | 删除（死绑定） |
| `src/demo/mockTauri.ts` | `case 'approve_tool_call':` stub 行 | 删除 |
| `src/infrastructure/acp/permissionController.ts` | 头注释过期表述修正（实际应答走 interactionTransport→`respond_interaction`，非 `approve_tool_call` invoke） | 注释修正 |
| `docs/说明书/Pylon-项目架构参考.md` | 审批线段尾句：「定向化另行施工（#568）」→ 定向语义记述 | 修改 |

## 方案要点

- **参数形态（最小契约）**：`agent_id: String` 必填（Tauri camelCase 映射前端 `agentId`），与 `respond_interaction` 的 `state.runtimes.get(&identity.agent_id)` 同一寻址语义；未注册报 `Protocol("agent runtime not found: {id}")`，可区分于「请求不存在」。
- **身份不符不误写**：两层保证——定向查找天然不触达其他 runtime；`resolve_pending` 锁内复核（C4 client_generation + 选项契约 + 失败 restore）原样兜底。
- **命令体保持薄壳**：寻址逻辑 3 行，未另设可测内核函数——测试经 `tauri::test::mock_builder()` + `app.manage(state)` 直接以 `app.state::<AppState>()` 调命令函数（`interaction_list` 既有测试同型）。
- ACP-01 wire 兼容不变：request_id 仍接受 number/string（untagged）+ `canonical_pending_key` 双向回退；`resolve_permission`/`resolve_pending` 应答链零改动。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 定向应答成功（live responder） | ✅ `approve_tool_call_directed_answers_pending_on_target_runtime`：fake ACP agent（permission-proactive id=7）注册 responder 后，命令定向 a1 应答 Ok、pending 清空 |
| 目标 runtime 不存在显式报错 | ✅ `approve_tool_call_unknown_agent_errors_explicitly`：Err 含 `agent runtime not found: nope` |
| 身份不符不误写 | ✅ `approve_tool_call_wrong_target_errors_and_preserves_pending`：同 id 挂 a1、对 a2 应答 Err（permission request not found），a1 pending 原样保留 |
| `bun run check:all`（含 clippy 基线比对） | ✅ 全绿（见证据） |
| 说明书待办表述清除 | ✅ 审批线段改为定向语义记述（含「生产应答路径仍以 respond_interaction 为单一入口」的现状边界） |
| 消费面收敛（无新旧两形态） | ✅ grep `approve_tool_call`/`approveToolCall` 仅剩：后端命令定义+注册行、注释（语义仍准确）、coldStart 脱敏样本（任意命令名，非契约消费）、auto_reconnect 注释（resolve_permission 直调即等价路径） |

## 测试处置

- 新增：`permission::tests` 三个命令级测试（上述验收 1-3）。
- 修改/删除既有行为测试：**无**（`auto_reconnect` resolve_permission 直调路径不受影响；coldStart 测试的 `approve_tool_call` 字符串仅为 IPC 脱敏样本）。

## 证据

- 测试：`cargo test -p pylon --lib approve_tool_call` → `3 passed; 0 failed; 982 filtered out`，EXIT=0。
- 门禁（check:all 分段执行，均附退出码）：
  - `check:frontend` ✅（lint/csp/canonical-types/retention/export-sanitize/ipc/styles/tokens/example-plugin/wasm/vitest 全量/构建/bundle/solid-smoke/docs/immer 全链绿）。
  - `check:rust`：`cargo build -p pylon-fake-agent --features test-agent` + 其测试 ✅；`cargo test --workspace --lib -- --skip managed_probe_cleanup_kills_descendant_processes` → 9 目标全绿 EXIT=0（pylon-core 138 passed + 1 filtered；foundations 100；markdown 22；session 217；主 crate 含本批 3 测）；`cargo build` EXIT=0；`check:acp-shadow` EXIT=0；`cargo fmt --all --check` EXIT=0。
  - `check:clippy` ✅ EXIT=0：`added/removed/reduced` 全空（基线外零新增诊断）；check-await-holding「17 文件 / 55 处 HeldAcrossAwait 全部与清单一致；裸 allow 0 处」。
  - `check:solid` ✅ EXIT=0（tsc + 13 项边界/契约守卫全绿）。
- **AV 环境干扰（与本批无关，如实记录）**：`pylon-core` 真实进程夹具 `managed_probe_cleanup_kills_descendant_processes`（隐藏窗口 PowerShell 拉起 ping.exe 写 pid 文件）在本机被杀毒软件行为检测稳定拦截（仓库主 2026-10-06 确认系其杀软所致），30s 就绪窗口超时；手动分步复现单项操作正常、组合管线被拦。本批未触碰 pylon-core；该夹具为台账在案的环境敏感测试（#106/#382/#423 各有一次 flake 记录）。CI runner 无此拦截，以 PR CI 该命令全绿为权威结论。
- 本地构建注意项：全新 worktree 需先 `bun run build`（或置 `dist/` 占位）——`tauri::generate_context!` 编译期要求 `frontendDist ../dist` 存在（CI #220 同款前置）；live responder 测试需先 `cargo build -p pylon-fake-agent --features test-agent`。

## 与 spec 的偏差

无实质偏差。spec 预设「可能需要可测内核函数」，实际命令体足够薄，直接以 mock app 调命令函数，未引入内核函数（spec 已按此收敛记录）。

## 未解问题

无。#436 三项裁决至此全部落地：定向化（本批 #568）、kind 静默容错契约化 + 构造臂归位（#569/PR #571）。

## 并行交集

`src-tauri/src/permission.rs`（#548/#549 声明域——其 PR 已并入 main 基线，无交叠在途）；`docs/说明书/Pylon-项目架构参考.md` 审批线段（#569 已同步该段，本批为尾句续写）；其余为前端孤立行删改。共享树在途文件（decisions/0035、records/515、#364 域）未触碰。
