// 字段可达性审计（CC-15 正向死面守卫 · 2026-10-05 · issue #266）：
// 主题系统不变量的第二层 —— "Settings 每个字段都有真实读取链"。check-css-var-consumption
// 管"注入的 var 必须被消费"（color/number 直投面）；select/boolean/text 等不注入 var 的
// 字段死了（CC-08 案例：设置页能改、改了无任何效果），变量审计天然看不见 —— 本脚本把
// 判据推到字段全集，逐键判。check-theme-field-consistency 管接线三方对齐（ZONE_FIELDS ×
// ThemeSettings × owners），不管效果可达 —— 三者判据不重叠。
//
// 判据：THEME_FIELD_KEYS 每键必须在生产源码存在至少一条真实读取链：
//   a. CSS var 消费 —— 字段的注入 var（THEME_CSS_VAR_MAP 反查）被 var() 消费；
//   b. 生产源码点访问 —— `appearance().<key>` / `theme.<key>` 点访问，或 `obj['<key>']`
//      方括号字符串访问。剥注释后匹配；短键防裸子串：`\.<key>(?![\w$-])` 两侧边界锁死
//      （`mode` 不得命中 `model` / `.accent-line` / `data-mode`）；
//   c. 语义源豁免 —— defs 带 semanticSource: true 的字段视为被角色系统消费。消费点是
//      themeCssSnapshot.resolveRoleValues 的动态遍历（Object.entries + state[key]），
//      静态扫描天然不可见，故按标记豁免；先例 inputBorderColor = stroke.default 角色源。
//   a/b 都看不到、又确属活的字段 → REACHABILITY_ALLOWLIST 登记（键 → 理由必填，照
//   check-runtime-boundaries 的 TAURI_EVENT_ALLOWLIST 先例：新增条目 = 显式评审动作）。
//
// 证据面排除：themeFieldDefs.ts（defs 键名）与 themeTypes.ts（ThemeSettings 接口键）——
// 这两处"出现"是定义本身、不是读取，算证据会让守卫全绿空转。其余生产源码剥注释后全量
// 参与（__tests__ / __fixtures__ / *.test.* / *.spec.* 不入扫描面）。扫描面 = git 追踪面
// （git ls-files 圈定，禁区目录 ui-demo / layout-sketch 与本机 git 外文件一律不入面，
// 根除「本地绿 CI 红」；见 walk 区注释）。
//
// 防空转正控：扫描面下限 + 判据集下限（ASSERT 区）——扫描面为空 = 守卫假绿。
// 故意违反自检：`POINT_AT_BANNED=1 bun scripts/check-theme-field-reachability.mts`
// 向判据集注入已知死探针 zzSelfCheckDeadProbe，脚本必须报红退出 1；正常跑不受影响。
import { THEME_CSS_VAR_MAP, THEME_FIELD_DEFS, THEME_FIELD_KEYS } from '../src/domains/theme/themeFieldDefs.ts'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../src', import.meta.url))
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
/** 剥注释：说明性注释会提到字段名，不该算证据（先例 ccDeadDataGuard 同款）。 */
const stripComments = (source: string) => source
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(?<!:)\/\/[^\n]*/g, '')

// ── 扫描面 = git 追踪面（check-runtime-boundaries 先例）──
// 本机 git 外文件（.git/info/exclude、未跟踪在制品）不入面：否则「本地绿 CI 红」不可复现——
// input-area 案例：唯一生成点在禁区 layout-sketch（本机 exclude 件，不在 git），本地读到它
// 判可达、CI checkout 无此文件判不可达。非 git 环境（导出源码包等）退回全量扫描，行为同先例。
const tracked = (() => {
  try {
    return new Set(execFileSync('git', ['ls-files', '-z', '--', 'src'], { cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean))
  } catch { return null }
})()
const skippedGitless: string[] = []

const cssFiles: string[] = []
const tsFiles: string[] = []
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      // 禁区（非生产渲染面，CC-15 裁定剔出扫描面）：ui-demo = 旧 React 演示；layout-sketch = 布局草稿
      if (name !== '__tests__' && name !== '__fixtures__' && name !== 'ui-demo' && name !== 'layout-sketch') walk(p)
      continue
    }
    if (name.includes('.test.') || name.includes('.spec.')) continue
    if (name.endsWith('.css') || name.endsWith('.tsx') || name.endsWith('.ts')) {
      if (tracked && !tracked.has(relative(PROJECT_ROOT, p).replaceAll('\\', '/'))) { skippedGitless.push(p); continue }
    }
    if (name.endsWith('.css')) cssFiles.push(p)
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) tsFiles.push(p)
  }
}
walk(ROOT)
console.log(`扫描面 = git 追踪面（git ls-files 圈定；git 外文件跳过 ${skippedGitless.length} 个，不判门禁）`)

// ── a 判据：注入 var 消费集（口径复用 check-css-var-consumption：var() 抓取 + themeCssSnapshot 注入）──
const consumed = new Set<string>()
for (const f of [...cssFiles, ...tsFiles]) {
  const s = read(f)
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*(?=[,)])/g)) consumed.add(m[1])
}
const fieldToVar = new Map<string, string>(Object.entries(THEME_CSS_VAR_MAP).map(([v, f]) => [f, v]))

// ── b 判据：生产源码点访问证据面（排除定义真值两文件）──
const EVIDENCE_EXCLUDED = ['domains/theme/themeFieldDefs.ts', 'domains/theme/themeTypes.ts']
const evidenceText = tsFiles
  .filter(f => !EVIDENCE_EXCLUDED.some(suffix => f.replaceAll('\\', '/').endsWith(suffix)))
  .map(f => stripComments(read(f)))
  .join('\n')

function hasPropertyRead(key: string): boolean {
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 点访问：`.key` 后不得再接字母数字下划线$/连字符（排除 `.model`、`.accent-line`）。
  if (new RegExp(`\\.${escaped}(?![\\w$-])`).test(evidenceText)) return true
  // 方括号字符串访问：obj['key'] —— 持久化键/枚举驱动的读取形态。
  if (new RegExp(`\\[\\s*(['"])${escaped}\\1\\s*\\]`).test(evidenceText)) return true
  return false
}

// ── 豁免名单：{ 键 → 理由 }。理由必填；新增条目 = 显式评审动作（裁定往返后落）。
// ★ 名单状态：CC-15 §0-3 裁定往返已过（2026-10-05 翻译核定）。
const REACHABILITY_ALLOWLIST: Record<string, string> = {
  // W2-10 侧栏平铺后无分组（defs 注释明言「字段保留兼容预设，不再注入 cssVar」）：
  // hidden 不在设置页渲染、noCssVar 不注入，生产源码仅剩预设工厂写默认值 —— 无读取链的存量保留项，清理走后续单。
  sidebarGroupSize: '侧栏分组标题字号：W2-10 起侧栏无分组渲染面，字段仅为兼容旧预设保留（存量，CC-15 只拦增量）',
}

// ── 正控：扫描面 / 判据集下限（防"守卫自己空转"的假绿）──
assert.ok(cssFiles.length > 10, `CSS 扫描面异常（${cssFiles.length} ≤ 10）`)
assert.ok(tsFiles.length > 400, `TS 扫描面异常（${tsFiles.length} ≤ 400）`)
assert.ok(THEME_FIELD_KEYS.length > 80, `字段判据集异常（${THEME_FIELD_KEYS.length} ≤ 80）`)
assert.ok(Object.keys(THEME_CSS_VAR_MAP).length > 40, `注入映射异常（${Object.keys(THEME_CSS_VAR_MAP).length} ≤ 40）`)
assert.ok(consumed.size > 50, `var 消费集异常（${consumed.size} ≤ 50）`)

// ── 逐键判 ──
const judgedKeys = [...THEME_FIELD_KEYS]
if (process.env.POINT_AT_BANNED === '1') judgedKeys.push('zzSelfCheckDeadProbe')

const reachable: string[] = []
const exempted: string[] = []
const unreachable: string[] = []
for (const key of judgedKeys) {
  if (key === 'zzSelfCheckDeadProbe') { unreachable.push(key); continue }
  const def = THEME_FIELD_DEFS[key as keyof typeof THEME_FIELD_DEFS] as { semanticSource?: boolean }
  if (def.semanticSource === true) { exempted.push(key); continue }
  if (fieldToVar.has(key) && consumed.has(fieldToVar.get(key)!)) { reachable.push(key); continue }
  if (hasPropertyRead(key)) { reachable.push(key); continue }
  if (key in REACHABILITY_ALLOWLIST) { exempted.push(key); continue }
  unreachable.push(key)
}
unreachable.sort()

if (process.env.POINT_AT_BANNED === '1') {
  if (unreachable.includes('zzSelfCheckDeadProbe')) {
    console.error(`[自检] 已知死探针 zzSelfCheckDeadProbe 被判为不可达 —— 扫描器工作正常，本条输出即"故意违反"红样例`)
    process.exit(1)
  }
  console.error(`[自检失败] 死探针意外可达 —— 扫描器失灵（判据被绕过），守卫不可信`)
  process.exit(1)
}

// a/b/c 之外的键必须逐个登记 REACHABILITY_ALLOWLIST（理由必填）后才能绿 —— 新死字段进门即红。
assert.deepEqual(unreachable, [], `以下主题字段在生产源码无任何真实读取链（var 消费 / 点访问 / 方括号访问均无；语义源与名单豁免除外）：\n${unreachable.join('\n')}`)
console.log(`字段可达性审计通过（字段 ${judgedKeys.length}：var 消费 ${reachable.filter(k => fieldToVar.has(k) && consumed.has(fieldToVar.get(k)!)).length} / 点访问 ${reachable.length - reachable.filter(k => fieldToVar.has(k) && consumed.has(fieldToVar.get(k)!)).length} / 语义源+名单豁免 ${exempted.length}，零读取 0）`)
