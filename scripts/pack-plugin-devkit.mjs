/**
 * pack-plugin-devkit.mjs — 组装插件开发套件（正常 SDK 包 + 离线 starter）。
 *
 * 目标：拿到套件的人只需 部署-解压-阅读 README 就能开始插件开发，
 * 不需要 prism-desktop 源码仓库。
 *
 * 产物 dist-plugin-devkit/pylon-plugin-devkit/：
 * - sdk/                 @pylon/plugin-sdk 正常版本地包（runtime + testing + 类型树 + schema）
 * - starter/no-build/    纯 JS 无构建起步插件（零工具链）
 * - starter/typescript/  TS + esbuild 起步插件（含预构建 dist）
 * - docs/                开发者版/用户版说明书 + CLI 命令表 + 设置选项贡献
 * - verify.mjs           自检脚本（结构 + 导出 + 类型探针）
 *
 * 质量门（失败即退出非零）：
 * G1 SDK bundle 导出完整；G2 类型探针（严格模式消费者 tsc --noEmit 通过）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const typescriptVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).devDependencies.typescript
const kitRoot = join(repoRoot, 'dist-plugin-devkit', 'pylon-plugin-devkit')
const sdkOut = join(kitRoot, 'sdk')

rmSync(kitRoot, { recursive: true, force: true })
mkdirSync(sdkOut, { recursive: true })

// ── sdk：构建脚本是唯一真源；devkit 只消费正常版 ──
execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-plugin-sdk.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
})
cpSync(join(repoRoot, 'dist-plugin-sdk', 'normal'), sdkOut, { recursive: true })

// ── starter/no-build：零工具链 ──
const noBuild = join(kitRoot, 'starter', 'no-build')
mkdirSync(noBuild, { recursive: true })
cpSync(join(sdkOut, 'pylon-plugin-sdk.js'), join(noBuild, 'pylon-plugin-sdk.js'))
writeFileSync(join(noBuild, 'pylon-plugin.json'), JSON.stringify({
  $schema: '../../sdk/pylon-plugin-manifest.schema.json',
  schema: 1, id: 'starter.plain', name: 'Starter Plain', version: '1.0.0',
  api: '1.1', kind: 'feature',
  web: { entry: './index.js', styles: ['./styles/main.css'] },
  dependencies: {}, optionalDependencies: {}, conflicts: [],
  activation: { events: ['kernel.ready'] },
  hotSwap: { mode: 'parallel', drainTimeoutMs: 5000 },
}, null, 2))
writeFileSync(join(noBuild, 'index.js'), readFileSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'src', 'index.ts'), 'utf8')
  .replace("from '@pylon/plugin-sdk'", "from './pylon-plugin-sdk.js'"))
cpSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'styles'), join(noBuild, 'styles'), { recursive: true })

// ── starter/typescript：预构建 dist + 可改源码 ──
const tsStarter = join(kitRoot, 'starter', 'typescript')
mkdirSync(tsStarter, { recursive: true })
cpSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'src'), join(tsStarter, 'src'), { recursive: true })
cpSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'styles'), join(tsStarter, 'styles'), { recursive: true })
// 预构建 dist 对套件 SDK 现打（与 manager-demo 同一模式）——仓库内
// examples/*/dist 只是历史快照，直接拷贝会把陈旧内嵌 SDK 带进套件（#343）。
mkdirSync(join(tsStarter, 'dist'), { recursive: true })
execFileSync(process.execPath, [
  join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'src', 'index.ts'),
  '--bundle', '--format=esm', '--platform=browser',
  `--alias:@pylon/plugin-sdk=${join(sdkOut, 'pylon-plugin-sdk.js').replaceAll('\\', '/')}`,
  `--outfile=${join(tsStarter, 'dist', 'index.js').replaceAll('\\', '/')}`,
], { cwd: repoRoot, stdio: 'inherit' })
writeFileSync(join(tsStarter, 'pylon-plugin.json'), JSON.stringify({
  $schema: '../../sdk/pylon-plugin-manifest.schema.json',
  schema: 1, id: 'starter.hello', name: 'Starter Hello', version: '1.0.0',
  api: '1.1', kind: 'feature',
  web: { entry: './dist/index.js', styles: ['./styles/main.css'] },
  dependencies: {}, optionalDependencies: {}, conflicts: [],
  activation: { events: ['kernel.ready'] },
  hotSwap: { mode: 'parallel', drainTimeoutMs: 5000 },
}, null, 2))
writeFileSync(join(tsStarter, 'package.json'), JSON.stringify({
  name: 'starter-hello', private: true, type: 'module',
  scripts: {
    build: 'esbuild src/index.ts --bundle --format=esm --platform=browser --alias:@pylon/plugin-sdk=../../sdk/pylon-plugin-sdk.js --outfile=dist/index.js',
    typecheck: 'tsc -p tsconfig.json',
  },
  devDependencies: { esbuild: '^0.24.0', typescript: typescriptVersion },
}, null, 2))
writeFileSync(join(tsStarter, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    strict: true, noEmit: true, target: 'ES2021', module: 'ESNext',
    moduleResolution: 'bundler', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    skipLibCheck: true, allowImportingTsExtensions: true, isolatedModules: true,
    paths: { '@pylon/plugin-sdk': ['../../sdk/types/sdk/index.d.ts'] },
  },
  include: ['src', '../../sdk/types/sdk/index.d.ts'],
}, null, 2))

// ── starter/manager-demo：外置插件管理器示例（P53 D4 双形态）──
// 源在 examples/web-plugins/plugin-manager-demo；与内嵌第 6 包共享同一套
// framework-free 面板 DOM 源，api 1.2 + plugin.management capability，
// 设置页走 isolated-surface。打包时对套件 SDK 预构建 dist。
const managerSource = join(repoRoot, 'examples', 'web-plugins', 'plugin-manager-demo')
const managerDemo = join(kitRoot, 'starter', 'manager-demo')
mkdirSync(managerDemo, { recursive: true })
mkdirSync(join(managerDemo, 'dist'), { recursive: true })
execFileSync(process.execPath, [
  join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(managerSource, 'src', 'index.ts'),
  '--bundle', '--format=esm', '--platform=browser',
  `--alias:@pylon/plugin-sdk=${join(sdkOut, 'pylon-plugin-sdk.js').replaceAll('\\', '/')}`,
  `--outfile=${join(managerDemo, 'dist', 'index.js').replaceAll('\\', '/')}`,
], { cwd: repoRoot, stdio: 'inherit' })
cpSync(join(managerSource, 'pylon-plugin.json'), join(managerDemo, 'pylon-plugin.json'))
cpSync(join(managerSource, 'styles'), join(managerDemo, 'styles'), { recursive: true })
// review C P2-7/8：拷贝可改源码与套件内类型检查配置（build 脚本指向的 src 必须存在）
cpSync(join(managerSource, 'src'), join(managerDemo, 'src'), { recursive: true })
// 单一真源（施工书 D4"同一 panel/ DOM 源"）：仓库内 src/panel.ts import 宿主
// 内嵌包源，套件里没有宿主 src——把内嵌 panel 源随套件拷入并改写 import，
// 打包语义不变（同一份面板实现）。
const embeddedPanelDir = join(managerDemo, 'src', 'embedded')
mkdirSync(embeddedPanelDir, { recursive: true })
const embeddedPanel = join(embeddedPanelDir, 'pluginManagerPanel.ts')
cpSync(
  join(repoRoot, 'src', 'plugins', 'product', 'packages', 'builtin.pylon-plugin-manager', 'panel', 'pluginManagerPanel.ts'),
  embeddedPanel,
)
// 内嵌 panel 源对仓库内 SDK 类型的相对 import → 套件 alias（tsconfig paths 已配）
writeFileSync(embeddedPanel, readFileSync(embeddedPanel, 'utf8')
  .replaceAll('../../../../../sdk/index.ts', '@pylon/plugin-sdk'))
const demoPanelTs = join(managerDemo, 'src', 'panel.ts')
writeFileSync(demoPanelTs, readFileSync(demoPanelTs, 'utf8')
  .replaceAll('../../../../src/plugins/product/packages/builtin.pylon-plugin-manager/panel/pluginManagerPanel.ts', './embedded/pluginManagerPanel.ts'))
writeFileSync(join(managerDemo, 'package.json'), JSON.stringify({
  name: 'pylon-plugin-manager-demo', private: true, type: 'module',
  scripts: {
    build: 'esbuild src/index.ts --bundle --format=esm --platform=browser --alias:@pylon/plugin-sdk=../../sdk/pylon-plugin-sdk.js --outfile=dist/index.js',
    typecheck: 'tsc -p tsconfig.json',
  },
  devDependencies: { esbuild: '^0.24.0', typescript: typescriptVersion },
}, null, 2))
writeFileSync(join(managerDemo, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    strict: true, noEmit: true, target: 'ES2021', module: 'ESNext',
    moduleResolution: 'bundler', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    skipLibCheck: true, allowImportingTsExtensions: true, isolatedModules: true,
    paths: { '@pylon/plugin-sdk': ['../../sdk/types/sdk/index.d.ts'] },
  },
  include: ['src', '../../sdk/types/sdk/index.d.ts'],
}, null, 2))

// ── docs ──
const docsOut = join(kitRoot, 'docs')
mkdirSync(docsOut, { recursive: true })
for (const doc of [
  'docs/说明书/Pylon-插件系统说明书-开发者版.md',
  'docs/说明书/Pylon-插件系统说明书-用户版.md',
  'docs/说明书/Pylon-CLI-命令表.md',
  'docs/说明书/Pylon-发行包清单.md',
  'docs/Pylon-插件设置选项贡献.md',
]) {
  cpSync(join(repoRoot, doc), join(docsOut, doc.split('/').pop()))
}

// ── README ──
writeFileSync(join(kitRoot, 'README.md'), readFileSync(join(repoRoot, 'scripts', 'plugin-devkit-README.md'), 'utf8'))

// ── verify.mjs：自检 ──
writeFileSync(join(kitRoot, 'verify.mjs'), readFileSync(join(repoRoot, 'scripts', 'plugin-devkit-verify.mjs'), 'utf8'))

// ── 质量门 ──
const sdk = await import('file:///' + join(sdkOut, 'pylon-plugin-sdk.js').replaceAll('\\', '/'))
const gate1 = ['definePlugin', 'createSettingsSurface', 'createPluginLogger', 'VISUAL_SEMANTIC_TOKENS', 'PYLON_PLUGIN_API_SUPPORTED']
  .every(key => key in sdk)
if (!gate1) { console.error('[devkit] G1 FAIL: SDK bundle 导出不完整'); process.exit(1) }
console.log('[devkit] G1 PASS: SDK bundle 导出完整')

execTsc(['-p', join(kitRoot, 'starter', 'typescript', 'tsconfig.json')])
console.log('[devkit] G2 PASS: TS starter 对套件类型树严格编译通过')
execTsc(['-p', join(kitRoot, 'starter', 'manager-demo', 'tsconfig.json')])
console.log('[devkit] G3 PASS: manager-demo 对套件类型树严格编译通过')

console.log(`[devkit] done → ${kitRoot}`)
readdirSync(kitRoot).forEach(name => console.log('  ' + name))

// ── helpers ──
function execTsc(args) {
  execFileSync(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'), ...args], { cwd: repoRoot, stdio: 'inherit' })
}
