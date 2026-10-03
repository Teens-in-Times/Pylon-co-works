import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// ---------------------------------------------------------------------------
// 规则一（存量）：视图层禁止直连产品实现 plugins/product/builtinPylon*。
// ---------------------------------------------------------------------------
const forbiddenImport = /(?:from\s+|import\s*\(\s*)['"][^'"]*plugins\/product\/builtinPylon[^'"]*['"]/g

export function findForbiddenProductImplementationImports(source: string): string[] {
  return source.match(forbiddenImport) ?? []
}

// ---------------------------------------------------------------------------
// 规则二（#485 划线，方案 C）：plugins/core 定性为「经插件机制交付的首方实现」。
// core 的插件贡献面（贡献声明数据、注册入口）视图层必须走注册表消费；内部 API 面
// （契约常量、贡献产物读取端）按下方白名单符号级豁免，who/why 逐条登记，新增豁免
// = 显式评审动作。清单即文档：划线明细以本表为唯一真源，维护地图引用之。
// ---------------------------------------------------------------------------

/** 通用 import/export-from 语句抓取（各分支自带模块说明符捕获组）。 */
const importStatementRe = new RegExp(
  /import\s+(?:type\s+)?(?:(\*\s+as\s+[\w$]+)|([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/.source
  + /|import\s+(?:type\s+)?(?:\*\s+as\s+([\w$]+)|([\w$]+))\s*from\s*['"]([^'"]+)['"]/.source
  + /|import\s*\(\s*['"]([^'"]+)['"]\s*\)/.source
  + /|import\s*['"]([^'"]+)['"]/.source
  + /|export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/.source
  + /|export\s+\*\s+from\s*['"]([^'"]+)['"]/.source
  + /|export\s+\*\s+as\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/.source
  + /|import\s+(?:type\s+)?[\w$]+\s*,\s*\*\s+as\s+[\w$]+\s*from\s*['"]([^'"]+)['"]/.source,
  'g',
)

export interface CoreImportHit {
  /** 语句文本（违规报告用）。 */
  readonly text: string
  /** 模块说明符原样（含引号内内容）。 */
  readonly spec: string
  /** 导入的符号；`*` 表示命名空间/默认/动态/副作用/re-export-all 这类无法按符号豁免的形态。 */
  readonly symbols: readonly string[]
}

/** 分支组位：A 命名导入 ns/def/named/spec；B 单导入 ns/def/spec；C 动态 spec；D 副作用 spec；E re-export named/spec；F re-export-all spec；G re-export-ns spec；H 默认+命名空间混合 spec。 */
export function findImportStatements(source: string): CoreImportHit[] {
  const hits: CoreImportHit[] = []
  for (const match of source.matchAll(importStatementRe)) {
    const [, nsA, defA, namedA, specA, nsB, defB, specB, specC, specD, namedE, specE, specF, specG, specH] = match
    const spec = specA ?? specB ?? specC ?? specD ?? specE ?? specF ?? specG ?? specH
    if (!spec) continue
    const symbols: string[] = []
    const named = namedA ?? namedE
    if (nsA || nsB || defA || defB || specC || specD || specF || specG || specH) symbols.push('*')
    if (named) {
      for (const piece of named.split(',')) {
        const name = piece.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (name) symbols.push(name)
      }
    }
    if (symbols.length > 0) hits.push({ text: match[0], spec, symbols })
  }
  return hits
}

export function findCoreImports(source: string): CoreImportHit[] {
  return findImportStatements(source).filter(hit => hit.spec.includes('plugins/core/'))
}

/**
 * core 内部 API 面白名单：文件（仓库相对路径，'/' 分隔）→ 符号 → 理由（who/why）。
 * 测试文件（__tests__/、*.test.*）不在扫描范围——测试本就直连被测实现。
 * 白名单带陈旧检测（#520 H 域）：指向不存在文件的条目、或文件已不再 import 该符号的
 * 条目一律报错——清偿/搬迁后必须同步删条或随迁，防止死豁免占位（#489 先例）。
 */
export const CORE_INTERNAL_API_ALLOWLIST: Record<string, Record<string, string>> = {
  'src/sheets/interfaceModeScenes.solid.tsx': {
    // A-V9 宿主场景注册表：core 贡献声明（sceneSurface.surfaceId）与本表登记必须同源，防漂移；无注册表等价物。
    BUILTIN_TACTICAL_SCENE_SURFACE_ID: '[kumo/#485] 宿主场景挂点契约常量',
  },
  // #520 H 域随迁：三条自 src/sheets/agent-workbench/* 迁入 application 层（#486 项1
  // 搬迁落地），语义不变（贡献产物读取端：输入即注册表快照 session.creationSnapshot，
  // 按贡献 ID 匹配系产品特定语义）；收进注册表面后本三条移除。
  'src/application/agent-workbench/agentWorkbenchCommands.ts': {
    collectProfilePersona: '[kumo/#485] 贡献产物读取端（快照查询）；#520 随迁自 src/sheets/agent-workbench，收进注册表面后移除',
  },
  'src/application/agent-workbench/agentWorkbenchLifecycle.ts': {
    collectProfilePersona: '[kumo/#485] 贡献产物读取端（快照查询）；#520 随迁自 src/sheets/agent-workbench，收进注册表面后移除',
  },
  'src/application/agent-workbench/agentWorkbenchSessionCreation.ts': {
    collectProfilePersona: '[kumo/#485] 贡献产物读取端（快照查询）；#520 随迁自 src/sheets/agent-workbench，收进注册表面后移除',
  },
  // #520 H 域随迁：扫描面扩容（+application）实录的既有直连。
  'src/application/transactions/requestNewSession.ts': {
    runSessionPreflight: '[kumo/#520] application 事务直读 core 会话预检（扫描面扩容随迁）；收进注册表面待清偿',
  },
  // 原 src/sheets/file/FileViewHost.tsx 条目经陈旧检测确认双重死条目删除：
  // 文件已改名 FileViewHost.solid.tsx 且不再 import 该符号（本地重写 1 MiB 同源常量，
  // 与 core/builtinFileWorkbench.ts 的常量静默分裂——审查 S1-P2 点名，待收敛回单源）。
}

export function findCorePluginFaceViolations(source: string, allowSymbols: ReadonlySet<string>): string[] {
  return findCoreImports(source)
    .filter(hit => hit.symbols.includes('*') || hit.symbols.some(symbol => !allowSymbols.has(symbol)))
    .map(hit => hit.text)
}

// ---------------------------------------------------------------------------
// 规则三（#520 H 域，审查 S1-P1「plugins/core 反向焊死视图组件」）：core 不得反向
// import 视图层（components/sheets/workspace-sheets/renderers）。#485 只划了
// 视图→core 正方向，core 反向把视图组件焊进插件贡献面，同样阻断视图层重构。
// 存量边（实扫 10 边）进豁免表「先豁免后清偿」（core 文件 → 模块说明符 → 理由，
// 与 CORE_INTERNAL_API_ALLOWLIST 同形；说明符路径改写后旧键由陈旧检测报红强制随迁）；
// 视图→core 正方向见规则二，plugins 非 core 源侧的视图层禁令见 check-layer-boundaries.mts。
// ---------------------------------------------------------------------------

/** 视图层目录的模块说明符命中：相对说明符去掉 ./.. 前缀后的首段必须是视图目录（深层段不误伤，如 plugin-runtime/renderers）。 */
export function isViewLayerSpecifier(specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const first = specifier.split('/').find(seg => seg !== '.' && seg !== '..')
  return first !== undefined && ['components', 'sheets', 'workspace-sheets', 'renderers'].includes(first)
}

/** core 文件里命中视图层目录的 import 语句（含 re-export 等效直连）。 */
export function findViewLayerImports(source: string): CoreImportHit[] {
  return findImportStatements(source).filter(hit => isViewLayerSpecifier(hit.spec))
}

/**
 * 视图层反向豁免表：core 文件 → 模块说明符 → 理由（who/why）。带陈旧检测：
 * 对应 import 消失（改道/搬迁）后必须删条。
 */
export const CORE_VIEW_LAYER_EDGE_EXEMPT: Record<string, Record<string, string>> = {
  // —— builtinFileWorkbench 群：file workbench 贡献直接焊住 sheets/file 视图实现
  //   （审查 S1-P1 点名 5 边；改经贡献注册表消费待清偿）
  'src/plugins/core/file/builtinFileWorkbench.ts': {
    '../../../components/right-panel/rightPanelTypes.ts': '[kumo/#520] 右栏条目类型直读（type 边）；契约上移待清偿',
    '../../../sheets/file/fileSheetState.ts': '[kumo/#520] file 工作台直读 sheet 状态模块；注册表化待清偿',
  },
  'src/plugins/core/file/builtinFileWorkbenchViews.solid.tsx': {
    '../../../components/LucideIcon.solid.tsx': '[kumo/#520] 贡献视图直用宿主图标件；图标注入待清偿',
    '../../../sheets/file/FileTree.solid.tsx': '[kumo/#520] 贡献视图直焊 FileTree 实现；注册表化待清偿',
    '../../../sheets/file/WorkspaceSearchPanel.solid.tsx': '[kumo/#520] 贡献视图直焊 WorkspaceSearchPanel 实现；注册表化待清偿',
    '../../../sheets/file/GitPanel.solid.tsx': '[kumo/#520] 贡献视图直焊 GitPanel 实现；注册表化待清偿',
    '../../../sheets/file/ViewsPanel.solid.tsx': '[kumo/#520] 贡献视图直焊 ViewsPanel 实现；注册表化待清偿',
  },
  // —— solid 渲染器声明直连渲染套件加载缝
  'src/plugins/core/renderer/solidRenderer.ts': {
    '../../../renderers/solid-workbench/loadSolidMessageRenderer.ts': '[kumo/#520] solid 渲染器声明直连渲染套件加载缝；经注册表消费待清偿',
  },
  // —— workspace 插件声明直连 workspace-sheets 状态模块
  'src/plugins/core/sheet/builtinWorkspacePlugins.ts': {
    '../../../workspace-sheets/agentWorkspaceState.ts': '[kumo/#520] workspace 插件直读 agent sheet 状态模块；状态端口化待清偿',
    '../../../workspace-sheets/settingsSheetState.ts': '[kumo/#520] workspace 插件直读 settings sheet 状态模块；状态端口化待清偿',
  },
}

export function findCoreViewLayerViolations(
  source: string,
  exemptSpecifiers: ReadonlySet<string>,
): string[] {
  return findViewLayerImports(source)
    .filter(hit => !exemptSpecifiers.has(hit.spec))
    .map(hit => hit.text)
}

// ---------------------------------------------------------------------------
// Guard the guard：已知违规 fixture 必须被拒，白名单 fixture 必须放行。
// ---------------------------------------------------------------------------

// 规则一：违规 fixture 必须被拒。
assert.equal(
  findForbiddenProductImplementationImports("import { apply } from '../plugins/product/builtinPylonTools'").length,
  1,
)

const lineOutside = "import { BUILTIN_INTERFACE_MODES } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'"
const lineAllowlisted = "import { BUILTIN_TACTICAL_SCENE_SURFACE_ID } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'"

// 规则二：线外符号（贡献清单）必须被拒。
assert.equal(findCorePluginFaceViolations(lineOutside, new Set(['BUILTIN_TACTICAL_SCENE_SURFACE_ID'])).length, 1)
// 规则二：白名单符号放行。
assert.deepEqual(findCorePluginFaceViolations(lineAllowlisted, new Set(['BUILTIN_TACTICAL_SCENE_SURFACE_ID'])), [])
// 规则二：多行具名列表混入白名单外符号必须被拒。
assert.equal(
  findCorePluginFaceViolations(
    "import {\n  BUILTIN_TACTICAL_SCENE_SURFACE_ID,\n  BUILTIN_INTERFACE_MODES,\n} from './plugins/core/interfaceMode/builtinInterfaceModes.ts'",
    new Set(['BUILTIN_TACTICAL_SCENE_SURFACE_ID']),
  ).length,
  1,
)
// 规则二：re-export 等效直连，同样被拒。
assert.equal(
  findCorePluginFaceViolations(
    "export { collectProfilePersona } from '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
    new Set<string>(),
  ).length,
  1,
)
// 规则二：命名空间/默认/动态/副作用导入无法按符号豁免，即使白名单含 '*' 也违规。
for (const fixture of [
  "import * as coreModes from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'",
  "import builtinSessionCreation from '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
  "import('../plugins/core/sessionCreation/builtinSessionCreation.ts')",
  "import '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
  "export * from '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
  "export * as coreBundle from '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
  "import builtinDefault, * as coreNs from '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
]) {
  assert.equal(findCorePluginFaceViolations(fixture, new Set(['*'])).length, 1, fixture)
}
// 规则二：非 core 的 import 不受管辖。
assert.deepEqual(findCoreImports("import { something } from '../domains/interface/interfaceModeStore.ts'"), [])
// 规则三：core 反向 import 视图层目录必须被拒；core 内部/域层 import 不受管辖；豁免说明符放行。
assert.equal(
  findCoreViewLayerViolations("import FileTree from '../../sheets/file/FileTree.solid.tsx'", new Set()).length,
  1,
)
assert.deepEqual(
  findCoreViewLayerViolations("import FileTree from '../../sheets/file/FileTree.solid.tsx'", new Set(['../../sheets/file/FileTree.solid.tsx'])),
  [],
)
assert.deepEqual(
  findCoreViewLayerViolations("import { x } from '../sessionCreation/builtinSessionCreation.ts'", new Set()),
  [],
)
assert.equal(
  findCoreViewLayerViolations("export { A } from '../../workspace-sheets/agentWorkspaceState.ts'", new Set()).length,
  1,
)
// 规则三：视图层目录段必须整段匹配（深层同名段不误伤，如 plugin-runtime/renderers、sheets2）。
assert.deepEqual(findCoreViewLayerViolations("import { x } from './renderer/foo.ts'", new Set()), [])
assert.deepEqual(findCoreViewLayerViolations("import { x } from '../sheets2/foo.ts'", new Set()), [])
assert.deepEqual(findCoreViewLayerViolations("import { x } from '../../../plugin-runtime/renderers/rendererTypes.ts'", new Set()), [])
// 陈旧检测辅助：指向不存在文件的条目必须报错。
assert.equal(staleAllowlistFileEntries(['src/nope/missing.ts']).length, 1)
assert.equal(staleAllowlistFileEntries(['src/sheets/interfaceModeScenes.solid.tsx']).length, 0)

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).flatMap(name => sourceFiles(join(path, name)))
    .filter(file => /\.[cm]?[jt]sx?$/.test(file))
    // 测试文件不在管辖内：测试本就直连被测实现（含 plugins/core）。
    .filter(file => !file.includes('__tests__') && !/\.test\.[cm]?[jt]sx?$/.test(file))
}

function allowSymbolsFor(file: string): Set<string> {
  return new Set(Object.keys(CORE_INTERNAL_API_ALLOWLIST[file] ?? {}))
}

/** 陈旧检测（#520 H 域）：白名单文件不存在 → 死条目。 */
export function staleAllowlistFileEntries(files: readonly string[]): string[] {
  const stale: string[] = []
  for (const file of files) {
    try { if (statSync(join(repoRoot, file)).isFile()) continue } catch { /* missing */ }
    stale.push(file)
  }
  return stale
}

/** 陈旧检测（#520 H 域）：白名单文件已不再 import 该符号 → 死条目。 */
function staleAllowlistSymbolEntries(): string[] {
  const stale: string[] = []
  for (const [file, symbols] of Object.entries(CORE_INTERNAL_API_ALLOWLIST)) {
    let source: string
    try { source = readFileSync(join(repoRoot, file), 'utf8') } catch { continue /* 文件缺失另有报错 */ }
    const imported = new Set(findCoreImports(source).flatMap(hit => hit.symbols))
    for (const symbol of Object.keys(symbols)) {
      if (!imported.has(symbol)) stale.push(`${file} 符号 ${symbol}（文件已无对应 core import）`)
    }
  }
  return stale
}

const violations = [
  join(repoRoot, 'src', 'App.solid.tsx'),
  ...sourceFiles(join(repoRoot, 'src', 'components')),
  ...sourceFiles(join(repoRoot, 'src', 'sheets')),
  // #520 H 域：application 层纳入扫描面（审查 S1-P0-1：application 直连 core 会话创建）。
  ...sourceFiles(join(repoRoot, 'src', 'application')),
].flatMap(file => {
  const relFile = relative(repoRoot, file).replaceAll('\\', '/')
  const source = readFileSync(file, 'utf8')
  const productHits = findForbiddenProductImplementationImports(source)
    .map(match => `[product] ${relFile}: ${match}`)
  const coreHits = findCorePluginFaceViolations(source, allowSymbolsFor(relFile))
    .map(match => `[core 插件面] ${relFile}: ${match}（内部 API 面白名单见本脚本 CORE_INTERNAL_API_ALLOWLIST；合理直连请登记符号并附理由）`)
  return [...productHits, ...coreHits]
})

// 规则三扫描面：src/plugins/core/** 生产文件反向 import 视图层（存量边进豁免表）。
const coreFiles = sourceFiles(join(repoRoot, 'src', 'plugins', 'core'))
const usedViewExemptions = new Set<string>()
const coreViewHits = coreFiles.flatMap(file => {
  const relFile = relative(repoRoot, file).replaceAll('\\', '/')
  const source = readFileSync(file, 'utf8')
  const exemptSpecs = new Set(Object.keys(CORE_VIEW_LAYER_EDGE_EXEMPT[relFile] ?? {}))
  for (const hit of findViewLayerImports(source)) {
    if (exemptSpecs.has(hit.spec)) usedViewExemptions.add(`${relFile} -> ${hit.spec}`)
  }
  return findCoreViewLayerViolations(source, exemptSpecs)
    .map(match => `[core 反向视图层] ${relFile}: ${match}（豁免表见本脚本 CORE_VIEW_LAYER_EDGE_EXEMPT；存量边请登记并附清偿方向）`)
})

// 陈旧检测：规则二白名单（文件存在性 + 符号仍在用）与规则三豁免表（对应 import 仍在）。
const viewExemptKeys = Object.entries(CORE_VIEW_LAYER_EDGE_EXEMPT)
  .flatMap(([file, specs]) => Object.keys(specs).map(spec => `${file} -> ${spec}`))
const staleEntries = [
  ...staleAllowlistFileEntries(Object.keys(CORE_INTERNAL_API_ALLOWLIST)),
  ...staleAllowlistSymbolEntries(),
  ...viewExemptKeys.filter(key => !usedViewExemptions.has(key))
    .map(key => `${key}（豁免已无对应违规边，改道/搬迁后请删条）`),
]

const allProblems = [...violations, ...coreViewHits, ...staleEntries.map(entry => `[陈旧豁免] ${entry}`)]

assert.deepEqual(
  allProblems,
  [],
  `视图层/application 必须经注册表/贡献端口消费产品与 core，core 不得反向焊死视图层，豁免表不得有死条目：\n${allProblems.join('\n')}`,
)

console.log(`product contribution boundary passed（App/components/sheets/application；core 划线白名单 ${Object.values(CORE_INTERNAL_API_ALLOWLIST).reduce((n, r) => n + Object.keys(r).length, 0)} 条符号豁免；core 反向视图层豁免 ${usedViewExemptions.size}/${viewExemptKeys.length} 条边豁免，均无陈旧条目）`)
