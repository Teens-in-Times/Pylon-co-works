import '@testing-library/jest-dom/vitest'
import { expect } from 'vitest'

// #220：计算核在测试宿主里必须**同步**可用（切分、揭示引擎、投影折叠的调用点全是
// 同步上下文），所以在任何测试文件求值前预初始化 wasm。node:* 只出现在 scripts/
// 侧（tsconfig 的 include 不含它），产品源码里不出现——那是这次重构要消除的耦合。
import { preloadComputeWasm } from './scripts/wasmPreload.ts'

preloadComputeWasm()

// 组件测试（jsdom）所需的最小浏览器 API 垫片
import { afterAll, afterEach, vi } from 'vitest'
// cleanup 的真身在框架 wrapper（@testing-library/react 已随 #520 W4 退役）——
// Solid 面取 @solidjs/testing-library 的同名导出（对 node 分组是零挂载 no-op）。
import { cleanup } from '@solidjs/testing-library'

afterEach(() => {
  cleanup()
})

// 阶段 0（报告 §2.3.9）：测试结束断言无未处理 Promise rejection。
// 每个测试文件（setup 每文件执行）注册收集器，afterAll 断言。
const unhandledRejections: unknown[] = []
const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason) }
process.on('unhandledRejection', onUnhandledRejection)

// #228 批次F（2026-09-22）：console.error 分层从「全局容忍」收窄为「白名单容忍」。
// 全量盘点（bunx vitest run）：75 次 console.error，全部出自下列 36 个文件，分三类：
//   A 错误路径契约——产品把失败写入 console.error 正是用例断言的可见上报链路
//     （错误中心、渲染边界、事务回滚、网关写回、Agent 切换/探测失败等）；
//   B node 环境噪音——canonical feed 兜底监听注册在无 Tauri 宿主的环境里失败
//     （「注册 canonical feed user 兜底监听失败 …」）。根因是产品侧注册无环境
//     守卫——守卫已两步收口（#542 前 createCanonicalEventFeed 按 `typeof window`
//     跳过 node 组；#542 起收窄为 IS_TAURI 探测单点，jsdom 组一并静默跳过），
//     B 类条目已全部移出；
//   C Renderer Suite fatal 回退链——「Renderer Suite 回退失败 …（自动重试 N/M）」
//     是回退机制的过程日志，用例正是断言该回退行为。
// 白名单外文件出现任何 console.error 一律 fail（fail 消息带首条原文，便于定性）。
// 回收计划：A/C 类在产品改走诊断通道上报后移出；**名单清零后删除整个白
// 名单机制**，afterAll 对 console.error 无条件 throw（即原「阶段 8 硬断言」，
// 届时本注释一并删除）。（B 类回收已由 #542 守卫收窄兑现。）
const EXPECTED_CONSOLE_ERROR_FILES: readonly string[] = [
  // B 类（canonical feed 兜底监听注册噪音）已随 #542 守卫收窄到 IS_TAURI 全部
  // 摘除：jsdom 组两条（#376-b agentWorkbenchSession.pagedLoad、#515
  // agentSuiteKeepAlive.integration.solid）实测 0 次 console.error 后移出。
  // C 类：Renderer Suite fatal 回退链过程日志
  // #515：两文件随实体直连改名 .solid.test.tsx（同一错误路径契约，白名单跟随）。
  'src/application/agent-workbench/__tests__/AgentRendererSuiteWorkbench.fatal.solid.test.tsx',
  'src/sheets/__tests__/AgentSheetView.rendererMode.solid.test.tsx',
  // #515：上项的 Solid 实体直连测试（同族错误路径契约）。
  'src/sheets/__tests__/AgentSheetView.solid.test.tsx',
  // A 类：错误路径契约
  'src/domains/identity/__tests__/identityStore.hydration.test.ts',
  // #542 前曾兼作 B 类条目；现仅剩「消费 Kernel committed 事件失败」的刻意
  // 错误路径契约（acceptFrame catch → reportRuntimeError）。
  'src/__tests__/replay/canonicalEventFeed.test.ts',
  'src/application/transactions/__tests__/applyWorkspaceLayoutChange.test.ts',
  // #445：搜索错误路径（searchHits/单行拉取拒绝）刻意触发 reportRuntimeError 的
  // console.error——A 类错误路径契约。
  'src/domains/search/__tests__/searchService.test.ts',
  // #515 二轮：messageRenderBoundary.test.tsx 已随 #279 chat 死代码清理退役，条目删除。
  // #515 W1：AgentRuntimePanel 实体已迁 .solid.tsx，测试随之改名（同一错误路径契约，白名单跟随）。
  'src/components/settings/__tests__/AgentRuntimePanel.default.solid.test.tsx',
  // #422：凭证门禁错误路径（config_verification_required / 连接测试失败）刻意触发
  // reportRuntimeError 的 console.error——与上面 AgentRuntimePanel 同族的预期契约。
  // #515：两文件实体已迁 .solid.tsx，测试随之改名（同一错误路径契约，白名单跟随）。
  'src/components/settings/__tests__/AgentConfigEditor.solid.test.tsx',
  'src/components/settings/__tests__/GatewayRiskPanel.solid.test.tsx',
  // #515：实体已迁 PluginManager.solid.tsx，测试随之改名（同一错误路径契约，白名单跟随）。
  'src/components/settings/__tests__/PluginManager.solid.test.tsx',
  // #515：实体已迁 ErrorCenter.solid.tsx，测试随之改名（错误路径契约，白名单跟随）。
  'src/components/__tests__/ErrorCenter.solid.test.tsx',
  // #515：settings sheet harness 收尾——消费测试随实体迁移改名 .solid.test.tsx，
  // 插件启动失败/授权等待的错误路径契约不变（白名单跟随改名）。
  'src/components/__tests__/Settings.pluginManagerDefaultPage.solid.test.tsx',
  // #515：实体已迁 SheetErrorBoundary.solid.tsx，测试随之改名（错误路径契约，白名单跟随）。
  'src/components/__tests__/SheetErrorBoundary.solid.test.tsx',
  'src/domains/theme/__tests__/customPresetApply.test.ts',
  'src/infrastructure/acp/__tests__/interactionRejectionController.test.ts',
  'src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx',
  'src/plugin-runtime/renderers/__tests__/workbenchHostPort.errorCenter.test.ts',
  'src/plugin-runtime/renderers/__tests__/workbenchHostPort.test.ts',
  // #515：两文件随实体迁移改名 .solid.test.tsx（批 1-D2a 漏跟，同一错误路径契约，白名单跟随）。
  'src/sheets/file/__tests__/FileTabView.readonly.solid.test.tsx',
  'src/sheets/file/__tests__/gitPanelAcceptance.solid.test.tsx',
  // #515：gateway 两测试随实体迁移改名 .solid.test.tsx（同一错误路径契约，白名单跟随）。
  'src/sheets/gateway/__tests__/gatewayRouteSave.integration.solid.test.tsx',
  'src/sheets/gateway/__tests__/gatewaySheetView.ui.solid.test.tsx',
  'src/sheets/__tests__/OverviewSheetView.visual.solid.test.tsx',
  // #515：titlebar React 薄桥退役，矩阵测试随实体迁移改名 .solid.test.tsx——
  // 避让域 AgentRuntimePanel 的探测失败（"探测本机 Agent失败"）是预期错误路径契约，白名单跟随。
  'src/workspace-sheets/__tests__/agentStatusConsumerMatrix.solid.test.tsx',
  // #515：实体已迁 SheetLauncher.solid.tsx，测试随之改名（Agent 激活事务契约，白名单跟随）。
  'src/workspace-sheets/__tests__/sheetLauncherAgentSwitch.solid.test.tsx',
  // #498：原 React 桥的 sheetTabStripAgentSwitch.test.tsx 随 #484 删除；Solid 实体测试承接
  // 同族 A 类错误路径契约（switch 失败 / 对账失败经 reportRuntimeError 的 console.error）。
  'src/workspace-sheets/__tests__/sheetTabStripAgentSwitch.solid.test.tsx',
  'src/workspace-sheets/__tests__/workspaceStore.integration.test.ts',
]

const consoleErrors: unknown[][] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  consoleErrors.push(args)
  originalConsoleError(...args)
}

function currentTestFile(): string {
  // expect.getState().testPath 是正式入口；__vitest_worker__.filepath 是同值的
  // worker 全局，作兜底（两者都归一化为 '/' 分隔再与白名单做 endsWith 匹配）。
  const state = expect.getState() as { testPath?: string }
  const raw = state.testPath ?? (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath ?? ''
  return raw.replaceAll('\\', '/')
}

afterAll(() => {
  console.error = originalConsoleError
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.resetModules()
  process.removeListener('unhandledRejection', onUnhandledRejection)
  if (consoleErrors.length > 0) {
    const file = currentTestFile()
    const whitelisted = EXPECTED_CONSOLE_ERROR_FILES.some(entry => file.endsWith(entry))
    if (whitelisted) {
      console.log(`[setup] ${file}: ${consoleErrors.length} 次 console.error（白名单内，仅记录）`)
    } else {
      const first = JSON.stringify(consoleErrors[0])
      throw new Error(
        `${file} 出现 ${consoleErrors.length} 次白名单外的 console.error（#228 批次F 起硬断言）。`
        + `先修产品侧错误；确属预期的错误路径契约时，把本文件登记进 vitest.setup.ts 的 EXPECTED_CONSOLE_ERROR_FILES 并注明分类。首条：${first}`,
      )
    }
  }
  if (unhandledRejections.length > 0) {
    console.error(`[setup] 检测到 ${unhandledRejections.length} 个未处理的 Promise rejection`)
    throw new Error(`存在 ${unhandledRejections.length} 个未处理的 Promise rejection`)
  }
})

// Node 26 的全局 localStorage 是实验性 getter：未传 --localstorage-file 时访问即触发
// ExperimentalWarning 并返回 undefined（且会遮蔽 jsdom 的）。无条件用内存垫片覆盖该
// descriptor（configurable: true），消除 warning 并让 Solid 内核 store 的 persist 复刻
// （语义对齐 zustand persist，见 infrastructure/state/solidStoreKernel 的
// attachSolidPersist）可用（仅测试环境）。
const memory = new Map<string, string>()
const storage: Storage = {
  getItem: key => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key, value) => { memory.set(key, String(value)) },
  removeItem: key => { memory.delete(key) },
  clear: () => memory.clear(),
  key: index => [...memory.keys()][index] ?? null,
  get length() { return memory.size },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
if (typeof window !== 'undefined' && Object.getOwnPropertyDescriptor(window, 'localStorage')?.value === undefined) {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
}

// matchMedia：垫片的在役消费者是首方 Solid 组件——TacticalScene.solid.tsx 与
// AgentRendererSuiteWorkbench.solid.tsx 直读 window.matchMedia('(prefers-reduced-motion)')
// （motion 垫片的 reduced-motion 面）；jsdom 未实现该方法，补最小桩。
if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// CodeMirror 6 会测量 Range 几何；jsdom 只实现 Range 数据模型，不提供布局 API。
// 组件测试不验证像素坐标，返回空矩形即可排除测试环境噪音。
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects === 'undefined') {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as DOMRectList
}
if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect === 'undefined') {
  Range.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
    toJSON: () => ({}),
  })
}
// K-3（施工书 09）：jsdom 未实现 ResizeObserver。原 Radix Slider / use-size 时代已随
// #520 React 退役过去；现在的在役消费者是首方 Solid 组件（ErrorCenter.solid.tsx、
// SettingsPreview.solid.tsx、createChatScrollController.solid.tsx 等）。
// 测试环境垫片：立即回调 size 0 即可满足布局观察协议。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverShim {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverShim as unknown as typeof ResizeObserver
}
// #329：命令面板在展开「全部」后可能超出面板高度，键盘选中的行需要 `scrollIntoView`
// 把它带进视口；jsdom 未实现该方法（调用会抛 TypeError），故在测试环境补空实现。
if (typeof window !== 'undefined' && typeof window.Element.prototype.scrollIntoView !== 'function') {
  window.Element.prototype.scrollIntoView = function scrollIntoView() {}
}
