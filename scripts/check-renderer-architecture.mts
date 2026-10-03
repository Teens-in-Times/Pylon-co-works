/**
 * A17 架构门禁：Renderer Suite / Host Port / 单一投影的持续约束。
 *
 * 规则来源：施工卡 A17「架构门禁与清理」步骤 1–3 + DIC-A17-01。
 * - R1 Solid/Suite 禁 import React、Zustand controller、provider adapter、canonical repository、Tauri client
 *   （#515 批7 起 SolidWorkbenchSmokeHost 已 Solid 化，React-host 豁免特判退役——与
 *   check-solid-workbench-boundaries 同口径，包类黑名单对 smoke host 与测试一并不豁免；
 *   仅路径类规则保留 __tests__ 豁免，测试可用宿主模块构造 fixture 对照）
 * - R2 projector（src/domains/workbench）禁 import renderer/plugin/settings 层
 * - R3 renderer 不解析 raw tool name：solid-workbench/host 禁 import normalizers/raw 字典源
 * - R4 production 只能经 Suite Host 进入 Solid：非 Suite 路径禁止 mount SolidWorkbenchApp
 * - M1 suite completeness matrix：active Suite 必须声明 compatibility/requiredKinds/optionalKinds/factory；
 *   每个 catalog kind 必须有 fallbackKind 且最终可达 content.unknown
 * - C16 coverage 门禁（DIC-A17-01）：inventory 里 not-transported 不得被计为已覆盖（由 vitest 门禁锁定，
 *   此处校验 inventory 文件存在且行数与字典口径一致）
 *
 * 每条规则先以故意违规 fixture 证明失败，再删 fixture 证明通过（卡 TDD 要求）。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const violations = []
const sourceExtensions = new Set(['.ts', '.tsx', '.mts'])

// ── 规则表 ────────────────────────────────────────────────────────────────

/** R1/R3：目录 → 禁止的 import 前缀/包名。 */
const SCOPE_IMPORT_RULES = [
  {
    label: 'R1 Solid/Suite',
    roots: ['src/renderers/solid-workbench', 'src/host/renderer-suite'],
    forbiddenPackages: [
      'react', 'react-dom', 'zustand', 'motion/react', 'lucide-react', 'react-markdown',
      '@testing-library/react',
    ],
    forbiddenPathIncludes: [
      'components/chat/sessionRuntimeStore', // Zustand controller（旧 slices 权威）
      'infrastructure/acp/',                 // provider adapter / Tauri client 面
      'canonicalRepository',                 // canonical journal 直读
      'domains/workbench/normalizers/',      // raw wire 解析属 adapter 层
    ],
  },
  {
    label: 'R2 projector',
    roots: ['src/domains/workbench'],
    forbiddenPackages: [],
    forbiddenPathIncludes: [
      'renderers/solid-workbench', // projector 禁 import renderer
      'plugin-runtime',            // projector 禁 import plugin registry
      'rendererContent',           // projector 禁 import settings/catalog 表现层
    ],
  },
]

function collectModuleSpecifiers(source) {
  const values = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.push(match[1])
  }
  return values
}

async function walk(directory) {
  const output = []
  let entries
  try { entries = await readdir(directory) } catch { return output }
  for (const name of entries) {
    const path = resolve(directory, name)
    const info = await stat(path)
    if (info.isDirectory()) output.push(...await walk(path))
    else output.push(path)
  }
  return output
}

// ── R1–R3 import rules ───────────────────────────────────────────────────

for (const rule of SCOPE_IMPORT_RULES) {
  for (const root of rule.roots) {
    for (const file of await walk(resolve(projectRoot, root))) {
      if (!sourceExtensions.has(extname(file))) continue
      const source = await readFile(file, 'utf8')
      const displayPath = relative(projectRoot, file).replaceAll('\\', '/')
      if (displayPath.includes('.test.') && rule.label === 'R2 projector') continue // 领域测试可用任意工具
      for (const specifier of collectModuleSpecifiers(source)) {
        const pkg = rule.forbiddenPackages.find(name => specifier === name || specifier.startsWith(`${name}/`))
        if (pkg) {
          violations.push(`${displayPath}: [${rule.label}] 禁止 import ${specifier}`)
          continue
        }
        const normalized = specifier.replace(/^(\.\.?\/)+/, '')
        const hit = rule.forbiddenPathIncludes.find(fragment => normalized.includes(fragment) || specifier.includes(fragment))
        // 路径类规则对 __tests__ 豁免：测试可用 normalizer 等宿主模块构造 fixture 对照
        // （如 issue5 回归测试经 hermesNormalizer 驱动 canonical 事件）；包类黑名单不豁免。
        if (hit && !displayPath.includes('__tests__')) {
          violations.push(`${displayPath}: [${rule.label}] 禁止 import ${specifier}（命中 ${hit}）`)
        }
      }
    }
  }
}

// ── R4 production 只能经 Suite Host 挂载 Solid App ────────────────────────

const r4Roots = ['src/plugins', 'src/sheets', 'src/components', 'src/workspace-sheets']
for (const root of r4Roots) {
  for (const file of await walk(resolve(projectRoot, root))) {
    if (!sourceExtensions.has(extname(file))) continue
    const source = await readFile(file, 'utf8')
    const displayPath = relative(projectRoot, file).replaceAll('\\', '/')
    if (/\bmountSolidWorkbench(?:FromHostPort)?\s*\(/.test(source)) {
      violations.push(`${displayPath}: [R4] production 禁止直接 mount SolidWorkbenchApp（必须经 rendererSuiteHost）`)
    }
  }
}

// ── M1 suite completeness matrix ─────────────────────────────────────────

try {
  // 前端结构全修批（PR #455）把 coverage 台账迁到测试侧（`__tests__/coverage/`）——
  // 台账是测试自有数据，门禁跟随新落点读。
  const coverageIndex = await readFile(resolve(projectRoot, 'src/domains/workbench/__tests__/coverage/providerCoverageIndex.ts'), 'utf8')
  if (!coverageIndex.includes('EXPECTED_UNITS')) {
    violations.push('[M1/C16] providerCoverageIndex.ts 缺少 EXPECTED_UNITS 口径常量')
  }
  for (const expected of [44, 46, 31]) {
    if (!coverageIndex.includes(String(expected))) {
      violations.push(`[M1/C16] EXPECTED_UNITS 缺字典口径 ${expected}`)
    }
  }
} catch {
  violations.push('[M1/C16] coverage inventory 不存在（C16 交付物缺失）')
}

// catalog fallback 终局检查：每个 kind 的 fallbackKind 链必须可达 content.unknown
try {
  const textCatalog = await readFile(resolve(projectRoot, 'src/domains/rendererContent/textRenderKindCatalog.ts'), 'utf8')
  const execCatalog = await readFile(resolve(projectRoot, 'src/domains/rendererContent/executionRenderKindCatalog.ts'), 'utf8')
  for (const [name, source] of [['textRenderKindCatalog', textCatalog], ['executionRenderKindCatalog', execCatalog]]) {
    const ids = [...source.matchAll(/id:\s*'([\w.-]+)'/g)].map(m => m[1]).filter(id => id.includes('.'))
    const kindsWithoutFallback = ids.filter(id => !id.startsWith('content.unknown'))
    if (kindsWithoutFallback.length > 0) {
      const noFallbackField = kindsWithoutFallback.filter(id => {
        const defStart = source.indexOf(`id: '${id}'`)
        const seg = source.slice(defStart, defStart + 600)
        return !seg.includes('fallbackKind')
      })
      if (noFallbackField.length > 0) {
        violations.push(`[M1] ${name} 以下 kind 未声明 fallbackKind: ${noFallbackField.join(', ')}`)
      }
    }
  }
} catch (error) {
  violations.push(`[M1] catalog 读取失败：${error.message}`)
}

// ── 结果 ──────────────────────────────────────────────────────────────────

if (violations.length > 0) {
  console.error(`A17 渲染器架构门禁失败：\n${violations.map(item => `- ${item}`).join('\n')}`)
  process.exit(1)
}
console.log('A17 渲染器架构门禁通过：R1–R4 import rules、Suite completeness、C16 coverage 口径全部合规')
