# Dev Record — #364 导入各 Agent CLI 的原生历史会话（首版 Claude Code tracer）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#364（enhancement）
- 分支：`kumo/364-agent-history`（基于 `github/main` @ 7b521680）
- 提交范围：`7b521680..HEAD`
- 日期：2026-10-05

## 目标与范围

把 Claude Code 的原生会话历史（`~/.claude/projects/**.jsonl`）解析进 canonical
journal，成为一等公民：可检索（既有 `evt_search` 链）、事件可读（既有 compact
读投影）。三点用户裁决（2026-10-05）：profile 保留字 = `external-import`；首版
范围 = 最小闭环；再导入 = 封存快照 + 显式 force 分叉。

**不做什么**：FTS5（issue 可分离子项，另立卡）；第二家 CLI（Codex，用于验证
契约漏水，另立卡）；resume 续聊；导入预览勾选 UI；live 重解析源文件（Codeg
式，issue 明确反对）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-agent-history/**`（Cargo.toml / src/lib.rs / src/claude_code.rs / tests/golden.rs / tests/fixtures/五场景 / tests/expected/五快照） | 新 crate：IR + trait + Claude Code 解析器 + golden 基线 | 新增 |
| `src-tauri/pylon-session/src/event_repo/provenance.rs` | 六组合整数编码（+5 = external-import/unverified）双向 | 修改 |
| `src-tauri/pylon-session/src/event_repo/row.rs` | `KernelEventInput.recovery_import: bool` → `import_origin: EventImportOrigin` 三值枚举；新增 `occurred_at: Option<String>`；新增 `ExternalHistoryImportResult` | 修改 |
| `src-tauri/pylon-session/src/event_repo/normalize.rs` | provenance 三分支产出；`parse_canonical_event` origin 词表 + external-import；occurred_at 缺省回退 received_at | 修改 |
| `src-tauri/pylon-session/src/event_repo/repo.rs` | `has_external_import(agent_id, remote_id)` 幂等探针（owner_key 前缀 LIKE + `#488` 转义纪律） | 修改 |
| `src-tauri/pylon-session/src/event_repo/service.rs` | `ingest_external_history(owner, remote_id, force, events)`（幂等跳过 / force 分叉跳探针 / RevisionConflict 视为幂等） | 修改 |
| `src-tauri/pylon-session/src/event_repo/{draft,draft_bench,fold_tests,tests}.rs` | KernelEventInput 构造点机械替换（`import_origin`/`occurred_at`）；tests.rs 追加 `external_history_import` 测试组（5 条） | 修改 |
| `src-tauri/pylon-session/src/event_repo/mod.rs` | 导出 `ExternalHistoryImportResult` | 修改 |
| `src-tauri/pylon-session/src/msg_repo/mod.rs` | canonical_events DDL 编码注释五组合 → 六组合 | 修改 |
| `src-tauri/pylon-canonical-types/src/lib.rs` | `EXTERNAL_IMPORT_PROFILE_ID` 保留字常量（单源） | 修改 |
| `src-tauri/Cargo.toml` | workspace members + 主 crate 依赖 pylon-agent-history | 修改 |
| `src-tauri/src/external_history/mod.rs` | 新宿主模块：home 定位 → scan/import 两命令；force 分叉 `#2..#99` 找空 journal | 新增 |
| `src-tauri/src/lib.rs` / `src-tauri/src/commands.rs` | 模块声明一行；命令注册两行 | 修改 |
| `src/domains/events/eventSchema.ts` | provenance origin 词表 + external-import | 修改 |
| `src/domains/workbench/events/workbenchEventSchema.ts` | `ProvenanceOrigin` 类型 + 校验词表 + provider/importId 必填扩展到 external-import | 修改 |
| `src/infrastructure/persistence/externalHistoryRepository.ts` | 新：scan/import 两命令的 typed IPC 适配 | 新增 |
| `src/components/settings/ExternalHistoryImport.solid.tsx` | 新：设置页「外部历史导入」卡片（扫描 → 展示 → 全量导入 + force 复选） | 新增 |
| `src/components/Settings.solid.tsx` | history section 挂载导入卡片 | 修改 |
| `.github/workflows/ci.yml` / `scripts/check-clippy.mjs` | crate 门禁清单 + pylon-agent-history | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` / `Pylon-模块维护地图.md` | provenance 六组合表述；新 crate 维护行 | 修改 |

## 方案要点

1. **分层**：`pylon-agent-history`（零 tauri、零 rusqlite，serde only）只产
   IR——事件载荷是 `session/update` 线形状 JSON，下游与 live/replay 走同一
   `normalize_kernel_event` 管道（判别符→canonical 类型映射单源
   `pylon-canonical-types` 不分叉，前端投影零改动）。落库由宿主命令经
   `EventService::ingest_external_history`（append_events 链）完成。
2. **owner 映射**：`profile_id="external-import"`（保留字常量放
   `pylon-canonical-types`，与 provenance origin 同名同义；journal 要求三元组
   非空而「平台自动会话 profile=None」先例是 None⇒不入库，不适用）。
   `local_session_id="claude-code:<uuid>"`，`remote_session_id=<uuid>`。
3. **幂等键 = (agent_id, remote_session_id)**：`has_external_import` 探针
   （v15 收窄后 agent_id 不落库，按 owner_key JSON 数组前缀 LIKE 匹配，`[`/`"`
   在 LIKE 中是普通字符，`%`/`_` 按 #488 纪律转义；冷路径全表扫可接受）。
   force 分叉 = 宿主生成 `#N` 后缀新 local_session_id（新 owner_key ⇒ 空
   journal），service `force=true` 跳探针；原快照封存不动。
4. **usage 去重（#364：不去重 2.4× 虚增）**：同一 `message.id` 的流式快照行
   延迟到终态行（带 stop_reason 即最后一行）才产出 content 事件；usage 按 id
   只留终值、仅在 done 事件带出一次；snake_case usage 转译为前端消费的
   camelCase 词表（inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens）。
5. **/clear 滚动链**：按行内 sessionId 变化切段，一段 = 一个导入会话；
   summary 行是文件级元数据（记 pending title、不开段）。
6. **容错**：sidechain/meta（行根与 message 内两种落位都查）/system/坏行跳过
   并计数进 `skipped_line_count`（unknown 不静默）。
7. **golden 基线**（issue 必需项）：5 场景（基础对话 / 工具往返 / usage 去重 /
   清屏滚动 / 噪声跳过）夹具 → 期望快照，CI 拦 CLI 磁盘格式漂移；基线不得为
   跑绿而改。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| pylon-agent-history 单测 + golden（4 + 5） | ✅ 全绿 |
| pylon-session：external-import 编解码往返 / 词表接受+拒绝 authoritative / 幂等 0 写入 / force 分叉新 owner 落库（5 条新测试） | ✅ 全绿 |
| `cargo test --workspace --lib` | ✅ 1693 passed / 0 failed |
| `bun run check:clippy`（相对基线零新增） | ✅ 通过（await-holding 对账 55 处一致） |
| `bun run lint` / `bun run check:ipc` | ✅ 通过（234 命令双向一致） |
| `bun run test`（vitest） | ✅ 5219 passed / 1 skipped |
| 说明书两处同步 | ✅ 架构参考 + 模块维护地图 |

## 测试处置

- 新增：pylon-agent-history 4 单测 + 5 golden；pylon-session
  `external_history_import` 组 5 条（provenance 落库与时间戳、幂等、force
  分叉、词表接受/拒绝、编码往返）。
- 修改：`KernelEventInput` 字段更名波及的既有测试构造点（draft.rs /
  draft_bench.rs / fold_tests.rs / tests.rs / service.rs 内联）——机械替换，
  行为断言未动。
- 删除：无。

## 证据

- 分支 `kumo/364-agent-history`（提交见 PR）。
- `cargo test --workspace --lib` → 1693 passed / 0 failed（exit 0；注：不带
  `--features test-agent` 直接跑会因 fake-agent bin 缺失出现 acp 域环境性失败，
  先 `cargo build -p pylon-fake-agent --features test-agent` 即绿——与 CI 前置
  步骤一致，非本次改动引入）。
- `bun run check:clippy` → exit 0；`bun run test` → 5219 passed。
- 手工验证：golden 夹具即解析行为快照（含 usage 去重与滚动链分段断言）；
  实机 webview2 验收未做（见「未解问题」）。

## 与 spec 的偏差

- spec 写「discover 扫描根目录」为轻扫——实现为全量解析取摘要（`read` 再解析
  一次）：两方法共享同一逐行解析核，API 无状态；导入是冷路径，双读换简单。
- spec 映射表未提「同 message.id 流式快照行的文本去重」——实现补充了延迟到
  终态行产出的模型（否则同消息多行会重复发文本事件，issue 的 usage 虚增同源
  问题在文本面上同样存在）。
- `pylon-session` 的 `ingest_external_history` 增加 `force: bool` 参数（spec
  初稿曾写「force 由调用方处理、本层无需感知」——幂等探针按 remote_id 拦截
  会误杀分叉，force 必须显式跳探针）。

## 未解问题

- 实机 webview2 验收（真机导入 `~/.claude/projects` 真实样本 + evt_search
  命中）未执行——本环境无 GUI 会话；golden 夹具已锁解析行为，落库链由
  pylon-session 测试覆盖。合并前如需实机复验，按
  `.agents/skills/webview2-acceptance/` 流程走。
- FTS / Codex 第二家 / resume 续聊 / 导入预览 UI：另立卡（issue #364 可分离
  子项）。

## 并行交集

碰过的共享文件（供其他贡献者避让）：`src-tauri/Cargo.toml`（members 一行 +
主 crate 依赖一行，#548/#549 曾声明不碰此文件——本次为新增 crate 必要改动，
两行追加无文本交叠）、`src-tauri/src/lib.rs`（模块声明一行）、
`src-tauri/src/commands.rs`（两行命令注册，与 #368 git 行块无交叠）、
`src/domains/workbench/events/workbenchEventSchema.ts`（provenance 词表三处）、
`src/components/Settings.solid.tsx`（history section 挂载）、
`.github/workflows/ci.yml` 与 `scripts/check-clippy.mjs`（crate 清单追加）。
