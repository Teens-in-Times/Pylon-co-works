# Dev Record — #542 CI 分片确定性红：canonical feed 兜底监听注册守卫漏判 jsdom

## 元信息

- issue：#542（PR #541 CI vitest 分片 1 确定性红）
- 分支：`kumo/prometheus`
- 提交范围：`b089c026..<head>`
- 日期：2026-10-04

## 目标与范围

兜底监听注册在非 Tauri 环境（含 jsdom 测试环境）静默跳过，不产生 `console.error`；CI 不因测试文件调度位置漂移而间歇/确定性红。**不做**：不给背锅文件加白名单（背锅者随调度漂移，治标）；不动看门狗记账机制；不动 Rust 侧。连带完成 L.md L3 条目后半（vitest.setup B 类白名单条目摘除）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/infrastructure/events/canonicalEventFeed.ts` | `createCanonicalEventFeed` 两条广播兜底注册守卫：`typeof window !== 'undefined'` → `IS_TAURI`，注释同步（说明 #542 链条与同文件既有守卫同形） | 修改 |
| `src/infrastructure/events/__tests__/canonicalEventFeed.tauriGuard.test.ts` | jsdom-mock 组回归测试：mock listen 为 spy，断言裸 jsdom 下创建 feed 不触达注册面、无 console.error | 新增 |
| `src/__tests__/replay/canonicalEventFeed.test.ts` | `vi.hoisted` 在模块求值前注入 `window.__TAURI_INTERNALS__`，两个兜底注册契约测试的前提修正为「Tauri 宿主在场」 | 修改 |
| `vitest.setup.ts` | B 类白名单两条摘除（`agentWorkbenchSession.pagedLoad.test.ts`、`agentSuiteKeepAlive.integration.solid.test.tsx`）；B 类定义/回收计划/C 类括注等过期注释同步 | 修改 |

## 方案要点

- 守卫取 `IS_TAURI`（env.ts H1 探测单点）而非 issue 建议的裸 `'__TAURI_INTERNALS__' in window`：jsdom 下两者等价（皆 false），但与本文件 `subscribeWindowTerminalFrames`/`subscribeTurnSettled` 既有守卫同形，遵守「探测收敛单点」决策。
- 既有两个兜底注册契约测试跑在 jsdom 环境，守卫修复后不再注册 → 红下。用 `vi.hoisted`（先于所有 import 求值）注入 Tauri 宿主标记，让 `IS_TAURI`（模块级 const）求值为真——契约本身不变，只是补回其前提。
- 回归测试 mock `listen` 为 spy 而非 reject：直接断言守卫效果（不触达注册面），不依赖真实 listen 的失败链路；并钉住「jsdom 有 window、无 `__TAURI_INTERNALS__`」前提防测试空转。
- 白名单摘除以实测为准：两条 B 类条目对应文件单跑 0 次 console.error 后才移出；`canonicalEventFeed.test.ts` 剩 1 次属刻意错误路径契约（acceptFrame catch → reportRuntimeError），条目保留、注释改注 A 类实质。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 回归测试绿 + 反向验证（还原旧守卫 → 红） | ✅ 新守卫 1/1 绿；旧守卫下红（listen 被调 ×2） |
| issue 背锅文件单跑 | ✅ `sheetLayoutSidebarCollapsedReactive.solid.test.tsx` 3/3 绿 |
| 全量 vitest | ✅ 664 文件 / 5198 passed + 1 skipped（两轮，含白名单摘除后复跑） |
| `tsc -b` | ✅ exit 0 |
| `check:frontend:static` | ✅ 通过（产物隔离检查 221 assets 无 mock 泄漏） |
| `check:clippy` | ✅ 基线外新增 0（`added: []`） |

## 测试处置

- 新增：`canonicalEventFeed.tauriGuard.test.ts`（1 用例）。
- 修改前提：`canonicalEventFeed.test.ts` 的「pylon:user 广播兜底走同一 acceptFrame 入口」「#310：pylon:update 广播兜底…」两用例——jsdom 裸环境不再注册是**修复后的正确行为**，用例改为在注入宿主标记后验证注册契约。契约不变。

## 证据

- 测试：`npx vitest run` → `Test Files 664 passed | 1 skipped (665)`，`Tests 5198 passed | 1 skipped (5199)`，退出码 0；反向验证一轮红（旧守卫）。
- 门禁：`tsc -b` exit 0；`check:frontend:static` 通过；`check:clippy` `added: []`。

## 与 spec 的偏差

无（spec 即本次实际执行方案）。

## 未解问题

无。CI 分片若再红，看门狗消息会带首条 console.error 原文，可据此定性。

## 并行交集

- `vitest.setup.ts`：L.md 今日条目 L3（本会话）与 L1/L2 并行批共享该文件时需注意——本次只动 `EXPECTED_CONSOLE_ERROR_FILES` 数组与 B 类/C 类注释块（约 44-62 行域），未触及其它 setup 逻辑。
- 工作树中有他人在途改动 `src/__tests__/replay/crossLayerComposition.test.ts`（#535，ADR-0016 跨度判据），本次未触碰、不带入提交；全量跑时该文件为对方改后版本且绿。
