// CSS 消费审计回归门禁（2026-08-04；P91 A4 收编正名，原 scripts/test-css-var-consumption.mts）：
// 主题系统不变量 = "Settings 每个字段都有真实渲染效果"。字段注入的 CSS var 必须被 var()
// 消费；CSS 消费的 var 必须已注入/声明，否则必须带 fallback（悬空引用会静默回退）。
// 防再犯：新增字段若注入 var 却无人消费，或组件引用悬空 var，本检查即红。
//
// 注入集 = THEME_CSS_VAR_MAP（defs 中 color/number 且非 noCssVar 的字段，cssVar 显式或
// kebab 派生）+ themeCssSnapshot 注入 var。
import { THEME_CSS_VAR_MAP, THEME_SETTING_KEYS } from '../src/domains/theme/themeFieldDefs.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../src', import.meta.url))
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const cssFiles: string[] = []
const tsxFiles: string[] = []
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== '__fixtures__') walk(p)
      continue
    }
    if (name.includes('.test.') || name.includes('.spec.')) continue
    if (name.endsWith('.css')) cssFiles.push(p)
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) tsxFiles.push(p)
  }
}
walk(ROOT)
const cssAll = cssFiles.map(read).join('\n')
const tsxAll = tsxFiles.map(read).join('\n')
// ── 注入集：直接 import THEME_CSS_VAR_MAP 单一真值（消灭正则镜像第二实现）──
const injected = new Set<string>(Object.keys(THEME_CSS_VAR_MAP))
const injectedFields = new Set<string>(Object.values(THEME_CSS_VAR_MAP))
// S5：显式派生 var 从 themeCssSnapshot 注入（App 不再手写 cssVars 对象键）
const app = read(join(ROOT, 'App.solid.tsx'))
// #520 S3-P1-3：Skin 接线自 App.solid 组合根拆出，断言目标随迁
const skinWiring = read(join(ROOT, 'app/skinWiring.solid.ts'))
const snapshot = read(join(ROOT, 'domains/theme/themeCssSnapshot.ts'))
for (const m of snapshot.matchAll(/'((?:--[a-z0-9-]+))':/g)) injected.add(m[1])

// ── F：Skin 基线订阅集 = THEME_SETTING_KEYS 全量白名单（缺订阅 = var 不注入 →
//    主题值落 fallback；基线必须覆盖全部注入字段）──
const skinServices = read(join(ROOT, 'infrastructure/skin/skinRuntimeServices.ts'))
assert.equal(app.includes('createAppSkinWiring('), true, 'App 组合根必须实际调用 createAppSkinWiring（拆分后防断线，复查 P1）')
assert.equal(skinWiring.includes('pickThemeBaseline'), true, 'Skin 接线（app/skinWiring）必须经 pickThemeBaseline 读 Theme Store')
assert.equal(skinWiring.includes('createSkinSurface<HTMLDivElement>('), true, 'Skin 接线必须经 createSkinSurface 投影 CSS 变量（#515：useSkinSurface.solid 实体形态）')
assert.equal(skinServices.includes('for (const key of THEME_SETTING_KEYS)'), true, 'Skin 基线必须遍历 THEME_SETTING_KEYS')
const subscribed = new Set<string>(THEME_SETTING_KEYS)
const missingSub = [...injectedFields].filter(f => !subscribed.has(f)).sort()
assert.deepEqual(missingSub, [], `缺订阅（var 不注入，主题值落 fallback）：\n${missingSub.join('\n')}`)
const deadSub = [...subscribed].filter(f => !THEME_SETTING_KEYS.includes(f as never)).sort()
assert.deepEqual(deadSub, [], `基线订阅越出 THEME_SETTING_KEYS 白名单：\n${deadSub.join('\n')}`)

// ── 消费集 / 声明集 ──
const consumed = new Set<string>()
const consumedWithFallback = new Set<string>()
for (const f of cssFiles) {
  const s = read(f)
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*(?=[,)])/g)) consumed.add(m[1])
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*,/g)) consumedWithFallback.add(m[1])
}
for (const f of tsxFiles) {
  const s = read(f)
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*(?=[,)])/g)) consumed.add(m[1])
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*,/g)) consumedWithFallback.add(m[1])
}
const declared = new Set<string>()
for (const m of cssAll.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) declared.add(m[1])
for (const f of tsxFiles) {
  const s = read(f)
  // style 对象键 '--x': … / ['--x' as never]: …；setProperty('--x', …) 单独捕获
  for (const m of s.matchAll(/['"](--[a-zA-Z0-9-]+)['"]\s*(?:as never\s*\]\s*)?:/g)) declared.add(m[1])
  for (const m of s.matchAll(/setProperty\(['"](--[a-zA-Z0-9-]+)/g)) declared.add(m[1])
}

// ── A：注入必消费（死注入 = 字段无渲染效果）──
// W2-04：FileSheet 编辑器 8 字段已被 FileSheet.css 消费（待消费清单移除）
const deadInjected = [...injected].filter(v => !consumed.has(v)).sort()
assert.deepEqual(deadInjected, [], `以下注入 var 从未被 var() 消费（字段改了没效果）：\n${deadInjected.join('\n')}`)

// ── B：悬空引用必须有 fallback（否则静默回退到 initial）──
const dangling = [...consumed]
  .filter(v => !injected.has(v) && !declared.has(v) && !consumedWithFallback.has(v))
  .sort()
assert.deepEqual(dangling, [], `以下 var 既未注入/声明也无 fallback（悬空引用）：\n${dangling.join('\n')}`)

console.log(`CSS 消费审计通过（注入 ${injected.size} / 消费 ${consumed.size} / 声明 ${declared.size}，死注入与悬空引用均为 0）`)
