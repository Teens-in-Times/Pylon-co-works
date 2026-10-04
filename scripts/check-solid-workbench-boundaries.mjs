import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const solidRoot = resolve(projectRoot, 'src/renderers/solid-workbench')
// P52 D5 结构门禁：过渡态退役后，生产 Solid/Workbench 路径禁止引用已删除的
// legacy controller 模块与 transient 流字段（canonical running 行是唯一流式显示）。
const retiredModules = [
  'chatEventController',
  'useChatRuntimeSnapshot',
  'useSessionLifecycle',
  'horizontalSubscription',
  'sessionRuntimeStore',
]
const retiredFieldPattern = /\bstreaming(?:Text|Thinking|Identity)\b/
const retiredFieldRoots = [
  resolve(projectRoot, 'src/renderers/solid-workbench'),
  // #486 项1：会话运行时归位 application，retired 守卫根随文件迁移；sheets 路径留守视图件。
  resolve(projectRoot, 'src/application/agent-workbench'),
  resolve(projectRoot, 'src/sheets/agent-workbench'),
  resolve(projectRoot, 'src/domains/workbench'),
]
const forbiddenPackages = [
  'react',
  'react-dom',
  'motion/react',
  'lucide-react',
  'react-markdown',
  '@testing-library/react',
]
const forbiddenPrefixes = ['@tauri-apps/']
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])
const violations = []

for (const file of await walk(solidRoot)) {
  if (!sourceExtensions.has(extname(file))) continue
  const source = await readFile(file, 'utf8')
  const displayPath = relative(projectRoot, file).replaceAll('\\', '/')
  const imports = collectModuleSpecifiers(source)

  const retiredModule = retiredModules.find(name => specifierNamesModule(imports, name))
  if (retiredModule) violations.push(`${displayPath}: 禁止引用已退役的 legacy 模块 ${retiredModule}（P52 过渡态已删除）`)

  if (retiredFieldRoots.some(root => file.startsWith(root)) && retiredFieldPattern.test(source)) {
    violations.push(`${displayPath}: transient 流字段（streamingText/streamingThinking/streamingIdentity）已随 P52 D5 删除，canonical running 行是唯一流式显示`)
  }

  for (const specifier of imports) {
    const forbiddenPackage = forbiddenPackages.find(name => specifier === name || specifier.startsWith(`${name}/`))
    const forbiddenPrefix = forbiddenPrefixes.find(prefix => specifier.startsWith(prefix))
    if (forbiddenPackage || forbiddenPrefix) {
      violations.push(`${displayPath}: 禁止 import ${specifier}`)
    }
  }

  if (displayPath.endsWith('.solid.tsx') || displayPath.endsWith('.solid.test.tsx')) continue
  if (looksLikeSolidJsx(source)) {
    violations.push(`${displayPath}: Solid JSX 必须使用 .solid.tsx 或 .solid.test.tsx 扩展名`)
  }
}

if (violations.length > 0) {
  console.error(`Solid Workbench 边界检查失败：\n${violations.map(item => `- ${item}`).join('\n')}`)
  process.exit(1)
}

console.log(`Solid Workbench 边界检查通过；扫描 ${await countSourceFiles(solidRoot)} 个源码文件`)

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

/** The import points at `.../name.ts(x)` (or extension-less) for a retired module. */
function specifierNamesModule(imports, name) {
  return imports.some(specifier => {
    const base = specifier.replace(/\.(ts|tsx|mts|js|mjs|jsx)$/, '')
    return base === `./${name}` || base === `../${name}` || base.endsWith(`/${name}`)
  })
}

function looksLikeSolidJsx(source) {
  return /\bclass=(["'{])/.test(source)
    || /\b(?:For|Show|Switch|Match|Index|Dynamic)\s*[<(]/.test(source)
    || /from\s+['"]solid-js(?:\/web)?['"]/.test(source)
}

async function walk(directory) {
  const output = []
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name)
    const info = await stat(path)
    if (info.isDirectory()) output.push(...await walk(path))
    else output.push(path)
  }
  return output
}

async function countSourceFiles(directory) {
  return (await walk(directory)).filter(file => sourceExtensions.has(extname(file))).length
}
