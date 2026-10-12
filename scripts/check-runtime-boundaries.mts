/**
 * B-04 runtime boundary guardrail.
 *
 * Existing direct Tauri/store imports are deliberately a report-only legacy
 * inventory.  A new path must be added to an explicit allowlist (and therefore
 * reviewed) before the checker can pass.  CustomEvent names are stricter: a
 * pylon DOM event must be present in the typed registry.
 *
 * #520 H 域纳管事件面：`@tauri-apps/api/event` 的 listen/emit 直连按
 * DIRECT_INVOKE_ALLOWLIST 同款模式管辖（存量登记仅报告，新增须显式评审）。
 * 视图层经 infrastructure/tauri/runtimeEventClient 传输层订阅（#520 S1-P1 收口，
 * RuntimeSheetView/BrowserSheetView 直订边已清零，视图直订即违规、无遗留清单）；
 * src/plugins/core/** 作为插件贡献面禁入 Tauri 事件 API（净规则，无豁免）。
 *
 * 检查集合 = git 跟踪的 src 源码。工作区里未跟踪的在制品（个人草稿/实验目录）不属于
 * 仓库，跳过并汇总提示：否则本地草稿会把门禁顶红，仓库里又会留下指向不存在文件的
 * 白名单死条目。非 git 环境（导出源码包等）自动退回全量扫描，行为同旧版。
 */
import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceExtensions = new Set(['.ts', '.tsx', '.mts'])
// #193：src/test-utils/ 是测试共享支撑（mock 形状工厂等），仅被测试代码 import，
// 不属生产边界扫描面——其文件天然含 '@tauri-apps/api/core' 字符串（mock 目标），
// 不排除会误报 direct invoke。
const productionFile = (path: string): boolean =>
  !path.includes('/__tests__/')
  && !path.includes('/test/')
  && !path.includes('/test-utils/')
  && !path.endsWith('.test.ts')
  && !path.endsWith('.test.tsx')
  && !path.endsWith('.test.mts')

/** Existing production paths; additions require an explicit review entry. */
export const DIRECT_INVOKE_ALLOWLIST = new Set([
  'src/App.tsx',
  'src/infrastructure/events/rollupTrim.ts',
  'src/application/transactions/openOwnedSessionTransaction.ts',
  'src/cli/pylonCliBridge.ts',
  'src/cli/pylonCliDomainPorts.ts',
  'src/domains/chat/sessionMode.ts',
  'src/domains/chat/sessionModel.ts',
  'src/domains/chat/streamingSend.ts',
            'src/components/settings/CwdSettingsPanel.tsx',
    // #154 区块栈线把会话删除/导出接线自 Sidebar.tsx 迁入该 hook（removeSessionTransaction
  // 端口 + createSessionClient 直发，形态不变）——条目随代码迁移，Sidebar.tsx 已无直发。
  'src/components/sidebar/useSidebarContributionProps.ts',
  'src/infrastructure/events/canonicalEventRepository.ts',
  'src/infrastructure/acp/chatClient.ts',
  // issue #82 浏览器 Agent 会话注入：sessionCreation preflight handler 须自行
  // IPC（说明书 §6.4.3 的文档化形态），查询 Rust 档位后决定是否产出 mcpServers。
  'src/plugins/core/browser/builtinBrowserAgentSessionAccess.ts',
  // 内核 hook 桥：与 pylonCliBridge 同形态的基础设施 IPC 桥（Rust 锚点缝 ↔ HookRuntime），
  // 非产品 domain client；P55 D1（3bc8ef13）引入时漏登记，2026-09-10 经架构师裁定按先例登记。
  'src/infrastructure/hooks/hookBridgeDispatcher.ts',
  // #269 启动相位上报：观测旁路的叶子模块（ready 时一次性 fire-and-forget，失败
  // 静默），与 hookBridgeDispatcher 同形态的基础设施级 IPC 缝，不构成产品 domain
  // client 依赖方向。
  'src/app/startupTiming.ts',
  // #488 批⑦ 前端诊断日志出口：fire-and-forget 推后端 push_frontend_log（失败
  // 静默降级回 console），与 hookBridgeDispatcher 同形态的基础设施级诊断 IPC 缝，
  // 不构成产品 domain client 依赖方向。
  'src/infrastructure/tauri/frontendLogSink.ts',
    'src/infrastructure/skin/skinHostPorts.ts',
  'src/devtools/obs/threeSourceExportTrigger.ts', // obs04 收敛迁名（结构全修批）,
  'src/plugin-runtime/pluginCompositionRoot.ts',
  'src/plugin-runtime/process/processRuntimeServices.ts',
  'src/plugins/core/browser/builtinBrowserCommands.ts',
  'src/plugins/core/commandSet/builtinCommandExecutors.ts',
  'src/plugins/core/file/builtinFileWorkbench.ts',
  // #351 根目录归类：三件随代码迁移自 src 根（原条目路径见 git 历史），直发面不变。
  'src/infrastructure/persistence/retentionPolicyRepository.ts',
  // #364 外部历史导入：persistence repository 直发两命令（external_history_scan/
  // import），与 retentionPolicyRepository 同目录同形态的基础设施 IPC 缝。
  'src/infrastructure/persistence/externalHistoryRepository.ts',
  'src/infrastructure/persistence/userDataRepository.ts',
  'src/domains/workspace/workspaceEntityStore.ts',    // #177 选择器空态探测：一次性 session client 读 Agent 广告的 configOptions 后即弃，
  // 与 agentWorkbenchSessionCreation.ts 同形态（UI 侧装配 session client 直发）。
  'src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx',
        'src/sheets/file/legacyFileProvider.ts',
      'src/sheets/OverviewSheetView.tsx',
    'src/workspace-sheets/activateAgentSheet.ts',
  // #317 内联 invoke 适配器收口：共享 transport（26 文件的内联适配器替换为同一
  // 引用，收窄而非扩大直发面）——与 hookBridgeDispatcher 同形态的基础设施级
  // IPC 缝，按先例登记。
  'src/infrastructure/acp/tauriTransport.ts',
])

/**
 * #520 H 域：`@tauri-apps/api/event` 直连（listen/emit）存量清单，仅报告。
 * 视图层须经 infrastructure/tauri/runtimeEventClient 传输层订阅（直订即违规）；
 * src/plugins/core/** 禁入（见 runRuntimeBoundaryCheck 净规则），不在本清单效力范围。
 * 新增条目 = 显式评审动作；改道/收口后须删条。
 */
export const TAURI_EVENT_ALLOWLIST = new Set([
  // 组合根与 bootstrap 装配（App 启动接线、装配事务监听）
  'src/App.solid.tsx',
  'src/app/bootstrap/appBootstrapTransaction.solid.ts',
  // CLI 桥（Rust 锚点缝 ↔ CLI 运行时，与 hookBridgeDispatcher 同形态）
  'src/cli/pylonCliBridge.ts',
  // 事件传输层本体（canonical event feed 的 Tauri 订阅端）
  'src/infrastructure/events/canonicalEventFeed.ts',
  // 内核 hook 桥（同 DIRECT_INVOKE_ALLOWLIST 登记理由：基础设施级 IPC 缝）
  'src/infrastructure/hooks/hookBridgeDispatcher.ts',
  // #520 S1-P1 事件订阅收口正身：全仓唯一合法直连点，视图一律经此订阅
  'src/infrastructure/tauri/runtimeEventClient.ts',
  // 插件进程运行时服务（process 生命周期事件订阅）
  'src/plugin-runtime/process/processRuntimeServices.ts',
])

/** Solid/plugin legacy imports; these are the next migration inventory. */
export const GLOBAL_STORE_ALLOWLIST = new Set([  'src/plugins/core/browser/builtinBrowserCommands.ts',
  'src/plugins/core/commandSet/builtinCommandExecutors.ts',
  'src/plugins/core/file/builtinFileCommands.ts',
  'src/plugins/core/renderer/builtinPresentationCommands.ts',
  'src/plugins/core/sessionCreation/sessionPreflight.ts',
  'src/plugins/core/sessionState/runtimeStoreSessionState.ts',
  'src/plugins/core/sheet/builtinWorkspaceCommands.ts',
  'src/plugins/core/shell/builtinShellCommands.ts',
  'src/plugins/product/builtinPylonAgentAdapters.ts',
  'src/renderers/solid-workbench/input/ControlCenter.solid.tsx',
  // #520 C 域拆分随迁：直连 store 读取自 ControlCenter 迁入 createCcSources（清偿方向：注入）
  'src/renderers/solid-workbench/input/createCcSources.ts',
])

/**
 * 宪法 §3.2.5：Solid 渲染器子树不得直发 `pylon:*` window CustomEvent，UI 动作
 * 一律走 semantic command（宿主侧持有 typed DOM bridge）。遗留输入桥站点保持
 * 报告制清单；新增渲染器直发即违规。
 */
export const RENDERER_CUSTOM_EVENT_ALLOWLIST = new Set([
  'src/renderers/solid-workbench/input/ControlCenter.solid.tsx',
  'src/renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx',
  // #520 C 域拆分随迁：workspace 选择器直发自 ControlCenter 迁入（清偿方向：semantic command）
  'src/renderers/solid-workbench/input/CcWorkspacePicker.solid.tsx',
])

/**
 * git 跟踪的文件清单（仓库根为基准、正斜杠，与 displayPath 同形）。
 * 不是 git 仓库时返回 null，调用方退回全量扫描。
 */
function trackedSourcePaths(): Set<string> | null {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', 'src'], {
      cwd: projectRoot,
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8')
    return new Set(output.split('\0').filter(Boolean))
  } catch {
    return null
  }
}

async function walk(directory: string): Promise<string[]> {
  let entries
  try { entries = await readdir(directory) } catch { return [] }
  const output: string[] = []
  for (const name of entries) {
    const path = resolve(directory, name)
    const info = await stat(path)
    if (info.isDirectory()) output.push(...await walk(path))
    else output.push(path)
  }
  return output
}

function displayPath(path: string): string {
  return relative(projectRoot, path).replaceAll('\\', '/')
}

function hasDirectInvoke(source: string): boolean {
  if (!source.includes('@tauri-apps/api/core')) return false
  // Match both static `{ invoke }` imports and dynamic import() wrappers used
  // by browser/portable fallbacks.  Type-only Channel imports do not match.
  return /\b(?:import|export)\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*['"]@tauri-apps\/api\/core['"]/.test(source)
    || (/\bimport\s*\(\s*['"]@tauri-apps\/api\/core['"]\s*\)/.test(source) && /\binvoke\b/.test(source))
}

/** `@tauri-apps/api/event` 的 listen/emit 值导入（含 `listen as x` 改名与动态 import 包装）。 */
export function hasDirectEventAccess(source: string): { listen: boolean; emit: boolean } {
  if (!source.includes('@tauri-apps/api/event')) return { listen: false, emit: false }
  const staticImport = (fn: 'listen' | 'emit'): boolean =>
    new RegExp(`\\b(?:import|export)\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*['"]@tauri-apps/api/event['"]`).test(source)
  const dynamicImport = (fn: 'listen' | 'emit'): boolean =>
    /\bimport\s*\(\s*['"]@tauri-apps\/api\/event['"]\s*\)/.test(source) && new RegExp(`\\b${fn}\\b`).test(source)
  return { listen: staticImport('listen') || dynamicImport('listen'), emit: staticImport('emit') || dynamicImport('emit') }
}

function hasGlobalStoreImport(path: string, source: string): boolean {
  if (!path.startsWith('src/plugins/') && !path.startsWith('src/renderers/solid-workbench/')) return false
  for (const line of source.split('\n')) {
    const specifier = line.match(/\bfrom\s*['"]([^'"]+)['"]/)?.[1]
    if (!specifier) continue
    const basename = specifier.split('/').at(-1)?.replace(/\.tsx?$/, '')
    if (basename && ['store', 'identityStore', 'runtimeStore', 'workspaceStore', 'workspaceEntityStore'].includes(basename)) return true
  }
  return false
}

function customEventNames(source: string): string[] {
  const names: string[] = []
  const patterns = [
    /\bnew\s+CustomEvent(?:<[^>]*>)?\s*\(\s*['"](pylon:[^'"]+)['"]/g,
    /\.(?:add|remove)EventListener\s*\(\s*['"](pylon:[^'"]+)['"]/g,
  ]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) names.push(match[1])
  return names
}

/** Construction sites only — the renderer rule targets dispatch ownership, not typed listeners. */
function constructedCustomEventNames(source: string): string[] {
  return [...source.matchAll(/\bnew\s+CustomEvent(?:<[^>]*>)?\s*\(\s*['"](pylon:[^'"]+)['"]/g)].map(match => match[1])
}

async function registryNames(): Promise<Set<string>> {
  const path = resolve(projectRoot, 'src/domains/events/pylonCustomEvents.ts')
  const source = await readFile(path, 'utf8')
  return new Set([...source.matchAll(/['"](pylon:[^'"]+)['"]/g)].map(match => match[1]))
}

export async function runRuntimeBoundaryCheck(): Promise<{ violations: string[]; reports: string[]; skipped: string[] }> {
  const violations: string[] = []
  const reports: string[] = []
  const skipped: string[] = []
  const tracked = trackedSourcePaths()
  const registry = await registryNames()
  for (const file of await walk(resolve(projectRoot, 'src'))) {
    if (!sourceExtensions.has(extname(file))) continue
    const path = displayPath(file)
    if (!productionFile(`/${path}`)) continue
    if (tracked && !tracked.has(path)) {
      skipped.push(path)
      continue
    }
    const source = await readFile(file, 'utf8')

    if (hasDirectInvoke(source)) {
      if (DIRECT_INVOKE_ALLOWLIST.has(path)) reports.push(`${path}: direct invoke（legacy allowlist，仅报告）`)
      else violations.push(`${path}: direct invoke 未登记 allowlist`)
    }
    // #520 H 域：@tauri-apps/api/event 纳管。core 禁入（净规则）；视图/域须经
    // runtimeEventClient 传输层；其余存量直连按 TAURI_EVENT_ALLOWLIST 仅报告。
    const eventAccess = hasDirectEventAccess(source)
    if (eventAccess.listen || eventAccess.emit) {
      if (path.startsWith('src/plugins/core/')) {
        violations.push(`${path}: plugins/core 直连 @tauri-apps/api/event（${[eventAccess.listen ? 'listen' : '', eventAccess.emit ? 'emit' : ''].filter(Boolean).join('/')}）——插件贡献面禁入 Tauri 事件 API，须走插件 API 或传输层`)
      } else if (TAURI_EVENT_ALLOWLIST.has(path)) {
        reports.push(`${path}: direct tauri event listen/emit（legacy allowlist，仅报告）`)
      } else {
        violations.push(`${path}: direct tauri event listen/emit 未登记 allowlist（视图/域层须经 infrastructure/tauri/runtimeEventClient 订阅；基础设施缝按 TAURI_EVENT_ALLOWLIST 先例登记）`)
      }
    }
    if (hasGlobalStoreImport(path, source)) {
      if (GLOBAL_STORE_ALLOWLIST.has(path)) reports.push(`${path}: global store import（legacy allowlist，仅报告）`)
      else violations.push(`${path}: global store import 未登记 allowlist`)
    }
    for (const name of customEventNames(source)) {
      if (!registry.has(name)) violations.push(`${path}: CustomEvent ${name} 未登记 typed registry`)
    }
    if (path.startsWith('src/renderers/') && constructedCustomEventNames(source).length > 0) {
      if (RENDERER_CUSTOM_EVENT_ALLOWLIST.has(path)) reports.push(`${path}: renderer 直发 pylon CustomEvent（legacy allowlist，仅报告）`)
      else violations.push(`${path}: renderer 直发 pylon CustomEvent，须改走 semantic command（宪法 §3.2.5）`)
    }
  }
  return { violations, reports, skipped }
}

const result = await runRuntimeBoundaryCheck()
for (const report of result.reports) console.warn(`边界遗留：${report}`)
if (result.skipped.length > 0) {
  const preview = result.skipped.slice(0, 3).join('、')
  console.log(`未跟踪文件跳过 ${result.skipped.length} 个（不在 git 中，不计入门禁）：${preview}${result.skipped.length > 3 ? ' 等' : ''}`)
}
if (result.violations.length > 0) {
  console.error(`运行时边界门禁失败：\n${result.violations.map(item => `- ${item}`).join('\n')}`)
  process.exit(1)
}
console.log(`运行时边界门禁通过：${result.reports.length} 条遗留白名单仅报告（invoke/store/tauri event）；无新增 invoke/store/tauri event/CustomEvent 越界`)

// guard the guard：@tauri-apps/api/event 检测口径（#520 H 域）。
import assert from 'node:assert/strict'
{
  assert.deepEqual(hasDirectEventAccess("import { listen } from '@tauri-apps/api/event'"), { listen: true, emit: false })
  assert.deepEqual(hasDirectEventAccess("import { listen as tauriListen } from '@tauri-apps/api/event'"), { listen: true, emit: false })
  assert.deepEqual(hasDirectEventAccess("import { emit } from '@tauri-apps/api/event'"), { listen: false, emit: true })
  // 动态 import 包装（browser/portable 降级形态）同样命中。
  assert.deepEqual(hasDirectEventAccess("const { listen } = await import('@tauri-apps/api/event')"), { listen: true, emit: false })
  // 类型-only / 注释内字符串不命中。
  assert.deepEqual(hasDirectEventAccess("import type { Event } from '@tauri-apps/api/event'"), { listen: false, emit: false })
  assert.deepEqual(hasDirectEventAccess("import { invoke } from '@tauri-apps/api/core'"), { listen: false, emit: false })
}
