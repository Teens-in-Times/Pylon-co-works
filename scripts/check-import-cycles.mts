/**
 * 文件级 import 环门禁（#520 结构审查 S1「门禁缺口」条款 3）。
 *
 * 解析 src/ 生产文件的相对 import（含 @pylon/plugin-sdk 别名），区分 RUNTIME 边与
 * type-only 边（整条可被擦除的 `import type` / 全 inline type 语句），分别跑 Tarjan
 * SCC：基线登记现有全部环（成员文件 + 是否含 RUNTIME 闭合边标注），基线外新环即红。
 *
 * 判定口径（对基线条目的子集匹配，非严格相等）：
 * - 计算出的 RUNTIME 环必须是某条 runtimeClosed=true 基线条目的子集——环变小是清偿
 *   进度，放行；环变大、跨条目合并、全新成环一律红。
 * - 计算出的 RUNTIME 环若只被 runtimeClosed=false 的条目包含 = type-only 环上新增了
 *   RUNTIME 闭合边（升级），红。
 * - 计算出的 type-only 环（需 type 边才能闭合顶层回路的 SCC）必须是任一基线条目的
 *   子集，否则红（[type-only] 标注，低于 RUNTIME 环级别）。
 * - 基线条目若已无任何计算 SCC 是其子集（整环清偿），按豁免表陈旧检测同款纪律报红，
 *   提示删条——防止死基线占位。
 *
 * 扫描面：src/ 全部 .ts/.tsx/.mts 工作树现存文件（含未跟踪的在途成品，删除态文件
 * 自然跳过）。剔除测试资产：__tests__/、__fixtures__/、*.test.*、src/test/、
 * src/test-utils/，以及 solid-workbench/smoke/（vite 独立 smoke 构建的挂载 harness，
 * 无生产消费方，见 check-production-excludes-solid-smoke 的反向隔离门禁）。
 * src/demo/ 保留在图内：经 app/bootstrap/browserDemoBootstrap 静态入生产图，DEV 门
 * 只是运行时开关。
 *
 * 同脚本附带条款（#520 门禁缺口 5）：生产路径不得 import 测试资产目录
 * （__tests__//__fixtures__）与 *.test.* 文件；例外边在 TEST_ASSET_EDGE_EXEMPT
 * 登记（who/why + 清偿方向）。#520 迁址先例：预览 fake facade
 * previewWorkbenchServices.ts 已自 __fixtures__/ 迁 preview/（生产可 import 的
 * 正身），旧路径留兼容 shim 仅供测试过渡。
 *
 * 负向验证：脚本内 assert 段以合成图验证 Tarjan/判定口径（新环红 / 子集放行 /
 * 升级红 / 陈旧基线红），见文件尾「guard the guard」。
 */
import { readdir, readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 测试资产判定（与扫描面剔除、生产禁入条款共用一套口径）。 */
function isTestAsset(rel: string): boolean {
  return rel.includes('/__tests__/') || rel.includes('/__fixtures__/') || rel.startsWith('src/test/')
    || rel.startsWith('src/test-utils/')
    || rel.startsWith('src/renderers/solid-workbench/smoke/')
    || /\.test\.[cm]?[jt]sx?$/.test(rel)
}

// ---------------------------------------------------------------------------
// 基线：当前树实扫（#520 H 域，2026-10-03；identity 域端口化清偿后实测 10 环，
// 较审查草案 ~15 已收敛）。成员列表按字典序。新增环 = 红并要求裁决；清偿后条目
// 须删（陈旧检测）。
// ---------------------------------------------------------------------------
interface BaselineCycle {
  /** 成员文件（仓库相对路径，'/' 分隔，字典序）。 */
  members: readonly string[]
  /** true = 存在仅凭 RUNTIME 边即闭合的子环（高危）；false = 需 type-only 边闭合（低级别）。 */
  runtimeClosed: boolean
  note: string
}

const BASELINE_CYCLES: readonly BaselineCycle[] = [
  {
    runtimeClosed: false,
    note: '跨域 type 边互锁大环：identity 群（#520 G 域端口化后仅剩 type 闭合）+ theme/cc 群（S1-P0-3：ccLayoutState 域间边、appearance 拉 theme+cc）+ workspace/plugin-runtime 注册表 type 面。清偿方向：逐条删 type 边（contracts/sheets.ts 域 store 形状、widgetDefinitions→themeFieldDefs 注释防环条目等），环自然碎裂。',
    members: [
      'src/app/bootstrap/hydrateIdentityAndWorkspace.ts',
      'src/contracts/sheets.ts',
      'src/domains/appearance/appearance.ts',
      'src/domains/cc/ccHeightState.ts',
      'src/domains/cc/ccLayoutState.ts',
      'src/domains/cc/widgetDefinitions.ts',
      'src/domains/chat/spinnerFrames.ts',
      'src/domains/identity/identityPersistence.ts',
      'src/domains/identity/identityPluginDataPort.ts',
      'src/domains/identity/identityProfileActions.ts',
      'src/domains/identity/identitySessionActions.ts',
      'src/domains/identity/identityStore.ts',
      'src/domains/identity/identityStoreShape.ts',
      'src/domains/identity/identityTypes.ts',
      'src/domains/identity/sessionPersistence.ts',
      'src/domains/rendererContent/rendererContentRegistry.ts',
      'src/domains/theme/customPresets.ts',
      'src/domains/theme/migration.ts',
      'src/domains/theme/presetBundle.ts',
      'src/domains/theme/presetReducer.ts',
      'src/domains/theme/presets/builtin.ts',
      'src/domains/theme/presets/index.ts',
      'src/domains/theme/presets/types.ts',
      'src/domains/theme/themeDefaults.ts',
      'src/domains/theme/themeFieldDefs.ts',
      'src/domains/theme/themeStore.ts',
      'src/domains/theme/themeTypes.ts',
      'src/domains/workbench/generationFooterContracts.ts',
      'src/domains/workbench/workbenchRuntime.ts',
      'src/domains/workspace/sheetPersistence.ts',
      'src/domains/workspace/sheetRegistry.ts',
      'src/domains/workspace/sheetState.ts',
      'src/domains/workspace/workspaceStore.ts',
      'src/plugin-runtime/context-panel/contextPanelRegistry.ts',
      'src/plugin-runtime/context-panel/contextPanelTypes.ts',
      'src/plugin-runtime/pluginHostServices.ts',
      'src/plugin-runtime/presentation/presentationProfileRegistry.ts',
      'src/plugin-runtime/renderers/pluginRendererApi.ts',
      'src/plugin-runtime/renderers/rendererActivationResolver.ts',
      'src/plugin-runtime/renderers/rendererDiagnostics.ts',
      'src/plugin-runtime/renderers/rendererRegistry.ts',
      'src/plugin-runtime/renderers/rendererSuiteTypes.ts',
      'src/plugin-runtime/renderers/rendererSuiteValidation.ts',
      'src/plugin-runtime/renderers/workbenchHostPort.ts',
      'src/plugin-runtime/renderers/workbenchRendererFactory.ts',
      'src/plugin-runtime/runtimeServices.ts',
      'src/plugin-runtime/settings/pluginSettingOptionsRegistry.ts',
      'src/plugin-runtime/workspaces/workspaceRegistry.ts',
      'src/plugin-runtime/workspaces/workspaceTypes.ts',
    ],
  },
  {
    runtimeClosed: false,
    note: 'theme/zones 聚合环（S1-P2）：zones/factory 10 件 + zonePresetPool 互引，type 闭合。',
    members: [
      'src/domains/theme/zones/factory/gui-cc.ts',
      'src/domains/theme/zones/factory/gui-chat.ts',
      'src/domains/theme/zones/factory/gui-global.ts',
      'src/domains/theme/zones/factory/gui-right.ts',
      'src/domains/theme/zones/factory/gui-sidebar.ts',
      'src/domains/theme/zones/factory/index.ts',
      'src/domains/theme/zones/factory/terminal-cc.ts',
      'src/domains/theme/zones/factory/terminal-chat.ts',
      'src/domains/theme/zones/factory/terminal-global.ts',
      'src/domains/theme/zones/factory/terminal-right.ts',
      'src/domains/theme/zones/factory/terminal-sidebar.ts',
      'src/domains/theme/zones/zonePresetPool.ts',
    ],
  },
  {
    runtimeClosed: false,
    note: 'plugin-runtime 管理面 ↔ infrastructure/pluginPackageClient type 互锁（pluginRuntime/pluginInstance/activationContext/packageManifest/shadowUpdate）。',
    members: [
      'src/infrastructure/plugins/pluginPackageClient.ts',
      'src/plugin-runtime/management/pluginManagementTypes.ts',
      'src/plugin-runtime/packageManifest.ts',
      'src/plugin-runtime/pluginActivationContext.ts',
      'src/plugin-runtime/pluginInstance.ts',
      'src/plugin-runtime/pluginRuntime.ts',
      'src/plugin-runtime/shadowUpdate.ts',
    ],
  },
  {
    runtimeClosed: false,
    note: 'workbench normalizers 群：normalizerSupport 与各 provider normalizer 互引，type 闭合。',
    members: [
      'src/domains/workbench/normalizers/acpNormalizer.ts',
      'src/domains/workbench/normalizers/agentEventNormalizer.ts',
      'src/domains/workbench/normalizers/claudeCodeNormalizer.ts',
      'src/domains/workbench/normalizers/extensionNormalizer.ts',
      'src/domains/workbench/normalizers/hermesNormalizer.ts',
      'src/domains/workbench/normalizers/normalizerSupport.ts',
      'src/domains/workbench/normalizers/periNormalizer.ts',
    ],
  },
  {
    runtimeClosed: false,
    note: 'tool↔toolResolution 群（S1-P1）：toolRegistry/toolPresentation 与 agentContracts/agentCatalog，type 闭合。',
    members: [
      'src/domains/agent/agentCatalog.ts',
      'src/domains/agent/agentContracts.ts',
      'src/domains/tool/toolPresentation.ts',
      'src/domains/tool/toolRegistry.ts',
      'src/domains/tool/toolResolution.ts',
    ],
  },
  {
    runtimeClosed: false,
    note: 'app errorCenter 三角：errorCenter ↔ errorCodeExplanations ↔ runtimeError，type 闭合。',
    members: [
      'src/app/errorCenter.ts',
      'src/app/errorCodeExplanations.ts',
      'src/app/runtimeError.ts',
    ],
  },
  {
    runtimeClosed: true,
    note: '全仓唯一 RUNTIME 闭合环：inputPredictionSettings ↔ SettingsCache ↔ infrastructure/prediction/predictionStandalone（layer-boundaries 既有豁免边构成）。清偿方向：predictionStandalone 端口化（范本 workbenchCommandFacade 注入式）。',
    members: [
      'src/domains/inputPrediction/inputPredictionSettings.ts',
      'src/domains/inputPrediction/inputPredictionSettingsCache.ts',
      'src/infrastructure/prediction/predictionStandalone.ts',
    ],
  },
  {
    runtimeClosed: false,
    note: 'chat↔runtime 对（审查 SCC-9）：chat/sessionRuntime ↔ runtime/runtimeStore，type 闭合。',
    members: [
      'src/domains/chat/sessionRuntime.ts',
      'src/domains/runtime/runtimeStore.ts',
    ],
  },
  {
    runtimeClosed: false,
    note: 'workspace-sheets/sheetKinds ↔ sheetTypes，纯 type 环。',
    members: [
      'src/workspace-sheets/sheetKinds.ts',
      'src/workspace-sheets/sheetTypes.ts',
    ],
  },
  {
    runtimeClosed: false,
    note: 'theme/customPresetStore ↔ presetActions，type 闭合（runtime 侧单向）。',
    members: [
      'src/domains/theme/customPresetStore.ts',
      'src/domains/theme/presetActions.ts',
    ],
  },
]

// ---------------------------------------------------------------------------
// 生产禁入测试资产条款：例外边（who/why + 清偿方向）。新增豁免 = 显式评审动作。
// ---------------------------------------------------------------------------
export const TEST_ASSET_EDGE_EXEMPT: Record<string, string> = {
  // #520 迁址遗留：WORKBENCH_MESSAGE_FIXTURE 数据单源仍住 __fixtures__（该目录仅剩
  // 此一个生产消费边）。fixture 数据文件随预览资产归位一并迁移后删除本条。
  'src/renderers/solid-workbench/preview/previewWorkbenchServices.ts -> src/renderers/solid-workbench/__fixtures__/workbenchFixtures.ts':
    '[kumo/#520] fixture 数据单源待随迁，唯一生产消费边',
}

// ---------------------------------------------------------------------------
// 图构建
// ---------------------------------------------------------------------------
export interface CycleEdge { to: string; runtime: boolean }

/** 复用 check-layer-boundaries 的 type-only 判定口径（语句级 import/export type 或全 inline type）。 */
export function isTypeOnlyImport(text: string, matchStart: number, matchEnd: number): boolean {
  const windowStart = Math.max(0, matchStart - 1200)
  const win = text.slice(windowStart, matchEnd)
  let stmt = -1
  for (const kw of ['\nimport', '\nexport', ';import', ';export']) {
    const i = win.lastIndexOf(kw)
    if (i > stmt) stmt = i
  }
  if (stmt < 0 && windowStart > 0) return false
  const head = win.slice(stmt + 1).trimStart()
  if (/^(?:import|export)\s+type\b/.test(head)) return true
  const brace = /^(?:import|export)\s*\{([^}]*)\}\s*from\s*(?:'(?:\.[^']*)'|"(?:\.[^"]*)")\s*$/.exec(head)
  if (brace) {
    const items = brace[1]!.split(',').map(s => s.trim()).filter(Boolean)
    if (items.length > 0 && items.every(i => /^type\s/.test(i))) return true
  }
  return false
}

const SPECIFIER_RE = /(?:from\s*|import\s*\(?\s*)(['"])(\.[^'"]+|@pylon\/plugin-sdk(?:\/testing)?)\1/g

export function extractEdges(
  sourceText: string,
  resolveTarget: (spec: string) => string | null,
): CycleEdge[] {
  const edges: CycleEdge[] = []
  for (const m of sourceText.matchAll(SPECIFIER_RE)) {
    const target = resolveTarget(m[2]!)
    if (!target) continue
    const runtime = !isTypeOnlyImport(sourceText, m.index ?? 0, (m.index ?? 0) + m[0]!.length)
    const existing = edges.find(e => e.to === target)
    if (existing) { if (runtime) existing.runtime = true; continue }
    edges.push({ to: target, runtime })
  }
  return edges
}

/** Tarjan SCC（递归版；节点数百级，栈深足够）。 */
export function tarjanSccs(nodes: readonly string[], edgesOf: (v: string) => Iterable<CycleEdge>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let counter = 0
  const strongconnect = (v: string): void => {
    index.set(v, counter); low.set(v, counter); counter++
    stack.push(v); onStack.add(v)
    for (const e of edgesOf(v)) {
      const w = e.to
      if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = []
      for (;;) {
        const w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
        if (w === v) break
      }
      sccs.push(comp)
    }
  }
  for (const v of nodes) if (!index.has(v)) strongconnect(v)
  return sccs
}

// ---------------------------------------------------------------------------
// 环判定（纯函数，guard-the-guard 断言覆盖）
// ---------------------------------------------------------------------------
export interface CycleAudit {
  errors: string[]
  /** 已被某个计算 SCC 消费的基线条目下标（陈旧检测用）。 */
  consumed: Set<number>
  /** 清偿进度提示（非致命）。 */
  progress: string[]
}

function containingEntry(members: readonly string[], baseline: readonly BaselineCycle[]): number {
  return baseline.findIndex(entry => {
    if (entry.members.length < members.length) return false
    const entrySet = new Set(entry.members)
    return members.every(m => entrySet.has(m))
  })
}

export function auditCycles(
  runtimeSccs: readonly (readonly string[])[],
  allSccs: readonly (readonly string[])[],
  baseline: readonly BaselineCycle[],
): CycleAudit {
  const errors: string[] = []
  const consumed = new Set<number>()
  const progress: string[] = []
  const runtimeSccKeys = new Set(runtimeSccs.filter(c => c.length > 1).map(c => [...c].sort().join('\u0000')))

  // RUNTIME 环：必须被 runtimeClosed=true 条目包含；被 false 条目包含 = 升级，红。
  for (const comp of runtimeSccs) {
    if (comp.length < 2) continue
    const sorted = [...comp].sort()
    const hit = containingEntry(sorted, baseline)
    if (hit < 0) {
      errors.push(`新增 RUNTIME 闭合环（${sorted.length} 文件）：\n    ${sorted.join('\n    ')}`)
      continue
    }
    if (!baseline[hit]!.runtimeClosed) {
      errors.push(`升级：type-only 基线环（${baseline[hit]!.note}）上出现仅凭 RUNTIME 边即闭合的子环：\n    ${sorted.join('\n    ')}`)
    }
    consumed.add(hit)
  }

  // type-only 环：需 type 边闭合顶层回路的 SCC（与 RUNTIME 环成员集不同），必须被任一条目包含。
  for (const comp of allSccs) {
    if (comp.length < 2) continue
    const sorted = [...comp].sort()
    if (runtimeSccKeys.has(sorted.join('\u0000'))) continue
    const hit = containingEntry(sorted, baseline)
    if (hit < 0) {
      errors.push(`新增 type-only 环（${sorted.length} 文件，需 type 边闭合；级别低于 RUNTIME 环但同样基线外）：\n    ${sorted.join('\n    ')}`)
      continue
    }
    consumed.add(hit)
  }

  // 陈旧基线：整环清偿后必须删条。
  for (let i = 0; i < baseline.length; i++) {
    if (consumed.has(i)) continue
    errors.push(`基线条目已无对应计算环（整环清偿后请删条）：${baseline[i]!.members[0]} 等 ${baseline[i]!.members.length} 文件 —— ${baseline[i]!.note}`)
  }

  // 进度提示：子集小于基线（环在变小）。
  for (const comp of allSccs) {
    if (comp.length < 2) continue
    const hit = containingEntry([...comp].sort(), baseline)
    if (hit >= 0 && baseline[hit]!.members.length > comp.length) {
      progress.push(`基线环清偿中：${comp.length}/${baseline[hit]!.members.length} 成员仍在环内（${baseline[hit]!.members[0]} …）`)
    }
  }
  return { errors, consumed, progress }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function walk(dir: string): Promise<string[]> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const e of entries) {
    const p = resolve(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else out.push(p)
  }
  return out
}

const walked = await walk(resolve(projectRoot, 'src'))
const allRelFiles: string[] = []
const productionFiles: string[] = []
for (const abs of walked) {
  if (!['.ts', '.tsx', '.mts'].includes(extname(abs))) continue
  try { if (!statSync(abs).isFile()) continue } catch { continue }
  const rel = relative(projectRoot, abs).replaceAll('\\', '/')
  allRelFiles.push(rel)
  if (!isTestAsset(rel)) productionFiles.push(rel)
}
const fullSet = new Set(allRelFiles)
const productionSet = new Set(productionFiles)

function resolveTarget(fromAbs: string, spec: string): string | null {
  let candidates: string[]
  if (spec === '@pylon/plugin-sdk') candidates = ['src/sdk/index.ts']
  else if (spec === '@pylon/plugin-sdk/testing') candidates = ['src/sdk/testing.ts']
  else if (spec.startsWith('.')) {
    const base = resolve(fromAbs, '..', spec)
    candidates = [base, base + '.ts', base + '.tsx', base + '.mts', base + '/index.ts', base + '/index.tsx']
    if (spec.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts')
    if (spec.endsWith('.mjs')) candidates.push(base.slice(0, -4) + '.mts')
  } else return null
  for (const c of candidates) {
    const rel = relative(projectRoot, c).replaceAll('\\', '/')
    if (fullSet.has(rel)) return rel
  }
  return null
}

const graph = new Map<string, CycleEdge[]>()
for (const rel of productionFiles) graph.set(rel, [])
const testAssetHits: string[] = []
for (const rel of productionFiles) {
  const abs = resolve(projectRoot, rel)
  const text = await readFile(abs, 'utf8')
  const edges = extractEdges(text, spec => resolveTarget(abs, spec))
  graph.set(rel, edges)
  for (const e of edges) {
    if (!isTestAsset(e.to)) continue
    const key = `${rel} -> ${e.to}`
    if (TEST_ASSET_EDGE_EXEMPT[key] !== undefined) continue
    testAssetHits.push(`${key}（生产路径禁入测试资产：__tests__//__fixtures__//*.test.*；如属迁移过渡请在 check-import-cycles.mts 的 TEST_ASSET_EDGE_EXEMPT 登记并附清偿方向）`)
  }
}

const edgesOf = (v: string): CycleEdge[] => graph.get(v) ?? []
const runtimeEdgesOf = (v: string): CycleEdge[] => [...edgesOf(v)].filter(e => e.runtime)
const runtimeSccs = tarjanSccs(productionFiles, runtimeEdgesOf)
const allSccs = tarjanSccs(productionFiles, edgesOf)
const audit = auditCycles(runtimeSccs, allSccs, BASELINE_CYCLES)

for (const p of audit.progress) console.log(`进度：${p}`)
const exemptKeys = Object.keys(TEST_ASSET_EDGE_EXEMPT)

if (testAssetHits.length > 0) {
  console.error(`生产禁入测试资产条款失败：${testAssetHits.length} 处`)
  for (const h of testAssetHits) console.error('  ' + h)
}
if (audit.errors.length > 0) {
  console.error(`import 环门禁失败：${audit.errors.length} 处（基线 ${BASELINE_CYCLES.length} 环，生产文件 ${productionFiles.length} 个）`)
  for (const e of audit.errors) console.error('  ' + e)
}
// 复查 P1：例外边强制陈旧检测——豁免条目对应的违规边消失后必须删除条目（对齐 layer 门禁纪律）。
const consumedExemptions = new Set<string>()
for (const key of Object.keys(TEST_ASSET_EDGE_EXEMPT)) {
  if (!testAssetHits.some(hit => hit.startsWith(key))) consumedExemptions.add(key)
}
const staleExemptions = exemptKeys.filter(k => !consumedExemptions.has(k) && !testAssetHits.length)
if (testAssetHits.length > 0 || audit.errors.length > 0 || staleExemptions.length > 0) {
  if (staleExemptions.length > 0) {
    console.error(`测试资产例外边陈旧 ${staleExemptions.length} 条（对应违规边已消失，删除条目）：`)
    for (const k of staleExemptions) console.error('  ' + k)
  }
  process.exit(1)
}
console.log(`import 环门禁通过：生产文件 ${productionFiles.length} 个、边 ${[...graph.values()].reduce((n, es) => n + es.length, 0)} 条；基线 ${BASELINE_CYCLES.length} 环（RUNTIME 闭合 ${BASELINE_CYCLES.filter(b => b.runtimeClosed).length} 环）零外逃；生产禁入测试资产条款通过（例外边 ${exemptKeys.length} 条）`)

// ---------------------------------------------------------------------------
// guard the guard：合成图断言（不触真实仓库文件）。
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict'
{
  const base = (members: string[], runtimeClosed: boolean): BaselineCycle => ({ members: [...members].sort(), runtimeClosed, note: 'fixture' })
  const hasErr = (r: CycleAudit, prefix: string): boolean => r.errors.some(e => e.startsWith(prefix))
  // 新 RUNTIME 环（基线外）必须红（无关基线条目的陈旧检测另计，不算数）。
  assert.ok(hasErr(auditCycles([['a.ts', 'b.ts']], [['a.ts', 'b.ts']], [base(['x.ts', 'y.ts'], true)]), '新增 RUNTIME 闭合环'))
  // 基线环的子集（清偿进度）放行。
  assert.deepEqual(auditCycles([['a.ts', 'b.ts']], [['a.ts', 'b.ts']], [base(['a.ts', 'b.ts', 'c.ts'], true)]).errors, [])
  // type-only 基线环上新增 RUNTIME 闭合子环 = 升级，红。
  assert.ok(hasErr(auditCycles([['a.ts', 'b.ts']], [['a.ts', 'b.ts']], [base(['a.ts', 'b.ts'], false)]), '升级：'))
  // 新 type-only 环（基线外）必须红。
  assert.ok(hasErr(auditCycles([['a.ts']], [['a.ts', 'b.ts']], [base(['x.ts', 'y.ts'], false)]), '新增 type-only 环'))
  // 整环清偿后基线条目必须删（陈旧检测红）。
  assert.ok(hasErr(auditCycles([['a.ts']], [['a.ts']], [base(['p.ts', 'q.ts'], false)]), '基线条目已无对应计算环'))
  // 基线两条目被新边合并成一条计算环 = 跨条目成环，红。
  assert.ok(hasErr(auditCycles([['a.ts', 'b.ts']], [['a.ts', 'b.ts']], [base(['a.ts', 'c.ts'], true), base(['b.ts', 'd.ts'], true)]), '新增 RUNTIME 闭合环'))
  // Tarjan 基本形：三方互引成一个 SCC，单向链不成环。
  assert.deepEqual(tarjanSccs(['a', 'b', 'c'], v => v === 'a' ? [{ to: 'b', runtime: true }] : v === 'b' ? [{ to: 'c', runtime: true }] : [{ to: 'a', runtime: true }]).filter(c => c.length > 1).length, 1)
  assert.deepEqual(tarjanSccs(['a', 'b'], v => v === 'a' ? [{ to: 'b', runtime: true }] : []).filter(c => c.length > 1).length, 0)
  // type-only 判定：语句级 import type / 全 inline type 为 true；值导入与动态 import 为 false。
  assert.equal(isTypeOnlyImport("import type { A } from './a.ts'", 20, 34), true)
  assert.equal(isTypeOnlyImport("import { type A, type B } from './a.ts'", 32, 40), true)
  assert.equal(isTypeOnlyImport("import { type A, B } from './a.ts'", 27, 34), false)
  assert.equal(isTypeOnlyImport("const m = await import('./a.ts')", 24, 32), false)
  // 生产禁入测试资产的例外边键位形态。
  assert.ok(exemptKeys.every(k => k.includes(' -> ') && k.startsWith('src/')))
}
