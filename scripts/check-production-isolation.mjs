import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const assetsDir = resolve(projectRoot, 'dist/assets')
const files = await readdir(assetsDir)
const javascript = files.filter(name => name.endsWith('.js'))
const combined = (await Promise.all(javascript.map(name => readFile(resolve(assetsDir, name), 'utf8')))).join('\n')
const errors = []

// Browser/demo seeding is development-only.  The App guard is intentionally
// compile-time (`import.meta.env.DEV`) so the production graph has no adapter
// chunk or seed entry point, even though the browser mock remains available in
// dev builds.
if (files.some(name => /^browserDemoBootstrap-/.test(name)) || combined.includes('runBrowserDemoSeed')) {
  errors.push('生产产物包含 browser demo seed adapter')
}
// mockTauri（src/demo/）是开发脚手架：main.solid.tsx 以 DEV 门 + 动态 import 挂载（#515 批7 入口改名），生产图里
// 不应出现该模块或其 chunk。探针用 mockTauri 独有字面量（minify 后字符串保留）——
// 注意不能用 __PYLON_BROWSER_MOCK__（生产 env.ts 的 isBrowserMockRuntime 会读同名
// 属性）或 iframe-preview（BrowserSheetView 也在用）。
if (files.some(name => /mocktauri/i.test(name))) {
  errors.push('生产 assets 出现独立 mockTauri chunk')
}
if (combined.includes('开发预览页面尚未加载') || combined.includes('mock-high:C:/Tools/peri.exe')) {
  errors.push('生产产物包含 mockTauri 浏览器假 transport')
}

if (errors.length > 0) {
  console.error(`生产产物隔离检查失败：\n${errors.map(error => `- ${error}`).join('\n')}`)
  process.exit(1)
}

console.log(`生产产物隔离检查通过；扫描 ${javascript.length} 个 JS assets，未包含 demo seed / mockTauri`)
