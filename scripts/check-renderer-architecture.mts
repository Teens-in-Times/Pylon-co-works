/**
 * A17 架构门禁：Renderer Suite / Host Port / 单一投影的持续约束。
 *
 * 规则来源：施工卡 A17「架构门禁与清理」步骤 1–3 + DIC-A17-01。
 * - R1 Solid/Suite 禁 import React、Zustand controller、provider adapter、canonical repository、Tauri client
 *   包依赖约束覆盖测试，路径约束仅针对生产消费者。
 * - R2 projector（src/domains/workbench）禁 import renderer/plugin/settings 层
 * - R3 renderer 不解析 raw tool name：solid-workbench/host 禁 import normalizers/raw 字典源
 * - R4 production 只能经 Suite Host 进入 Solid：非 Suite 路径禁止 mount SolidWorkbenchApp
 * Catalog fallback 与 provider coverage 由实际定义的行为测试验证，不解析源码片段。
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
      '@testing-library/react', '@tauri-apps',
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

// Catalog fallback paths and provider coverage are exercised against actual definitions
// by rendererContent and workbench/coverage behavior tests. Source substring/line-window
// checks duplicated those tests and could pass merely because a nearby entry had the field.

// ── 结果 ──────────────────────────────────────────────────────────────────

if (violations.length > 0) {
  console.error(`A17 渲染器架构门禁失败：\n${violations.map(item => `- ${item}`).join('\n')}`)
  process.exit(1)
}
console.log('A17 渲染器架构门禁通过：R1–R4 import rules 合规；catalog/coverage 由行为测试验证')
