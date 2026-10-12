/**
 * build-plugin-sdk.mjs — 从同一 SDK 源码构建两套发行形态：
 *
 * - 正常版：dist-plugin-sdk/normal/（runtime + testing + declaration tree + package exports）
 * - 离线版：src-tauri/resources/sdk/（单文件 runtime ESM + manifest schema）
 *
 * 离线版可在无 Node、无源码的发行包中直接被纯 JS 插件相对 import；
 * 正常版供 TypeScript/Node 构建工具消费。两者共用 runtime source，避免契约漂移。
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const normalOut = join(repoRoot, 'dist-plugin-sdk', 'normal')
const offlineOut = join(repoRoot, 'src-tauri', 'resources', 'sdk')
const manifestSchema = join(repoRoot, 'shared', 'pylon-plugin-manifest.schema.json')
const sdkEntry = join(repoRoot, 'src', 'sdk', 'index.ts')
const testingEntry = join(repoRoot, 'src', 'sdk', 'testing.ts')

rmSync(normalOut, { recursive: true, force: true })
mkdirSync(normalOut, { recursive: true })

// ── 正常版：runtime + testing ──
await buildBundle(sdkEntry, join(normalOut, 'pylon-plugin-sdk.js'))
await buildBundle(testingEntry, join(normalOut, 'testing.js'))
cpSync(manifestSchema, join(normalOut, 'pylon-plugin-manifest.schema.json'))

// ── 正常版：完整声明树（两个 entry，避免 ./testing.types 指向空洞）──
const typesOut = join(normalOut, 'types')
try {
  execTsc([
    // 显式 entry 与下方 CLI 选项构成独立声明构建；TS6 要求忽略 cwd 的 tsconfig。
    '--ignoreConfig',
    'src/sdk/index.ts',
    'src/sdk/testing.ts',
    '--declaration', '--emitDeclarationOnly', '--allowImportingTsExtensions',
    '--target', 'ES2021', '--lib', 'ES2022,DOM,DOM.Iterable',
    '--module', 'ESNext', '--moduleResolution', 'bundler', '--skipLibCheck',
    '--noCheck',
    '--rootDir', 'src',
    '--outDir', typesOut,
  ])
} catch {
  // 并行工作树可能让宿主诊断非零，但只要两个 SDK entry 的声明已发射，
  // 正常版仍可完成打包；缺声明由硬校验阻断。
}
const indexDts = join(typesOut, 'sdk', 'index.d.ts')
const testingDts = join(typesOut, 'sdk', 'testing.d.ts')
if (!statExists(indexDts) || !statExists(testingDts)) {
  console.error('[build-plugin-sdk] 类型树发射失败：缺少 sdk/index.d.ts 或 sdk/testing.d.ts')
  process.exit(1)
}
rewriteTsSpecifiers(typesOut)
writeFileSync(join(normalOut, 'package.json'), JSON.stringify({
  name: '@pylon/plugin-sdk',
  version: '1.2.0',
  type: 'module',
  main: './pylon-plugin-sdk.js',
  types: './types/sdk/index.d.ts',
  exports: {
    '.': { types: './types/sdk/index.d.ts', default: './pylon-plugin-sdk.js' },
    './testing': { types: './types/sdk/testing.d.ts', default: './testing.js' },
  },
  sideEffects: false,
}, null, 2))

// ── 离线版：只打包 runtime entry，保持 64 KiB 依赖闭包守卫 ──
rmSync(offlineOut, { recursive: true, force: true })
mkdirSync(offlineOut, { recursive: true })
const offlineBundle = join(offlineOut, 'pylon-plugin-sdk.js')
await buildBundle(sdkEntry, offlineBundle)
cpSync(manifestSchema, join(offlineOut, 'pylon-plugin-manifest.schema.json'))
const offlineSize = statSync(offlineBundle).size
if (offlineSize > 64 * 1024) {
  console.error(`[build-plugin-sdk] 离线 bundle ${offlineSize} 字节超过 64KB 上限——检查 src/sdk 是否引入宿主运行时依赖`)
  process.exit(1)
}

console.log(`[build-plugin-sdk] normal: ${normalOut}`)
console.log(`[build-plugin-sdk] offline: ${offlineOut} (${offlineSize}B)`)

async function buildBundle(entryPoint, outfile) {
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2021',
    legalComments: 'inline',
    outfile,
    logLevel: 'info',
  })
}

function execTsc(args) {
  execFileSync(process.execPath, [
    join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    ...args,
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function rewriteTsSpecifiers(root) {
  for (const entry of walk(root)) {
    if (!entry.endsWith('.d.ts')) continue
    const content = readFileSync(entry, 'utf8')
    writeFileSync(entry, content.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2'), 'utf8')
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else yield p
  }
}

function statExists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
