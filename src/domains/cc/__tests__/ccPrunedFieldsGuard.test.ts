import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_FIELD_DEFS, THEME_FIELD_KEYS } from '../../theme/themeFieldDefs.ts'

/**
 * #266 CC-07（设置页「中控台」多余项清理）的**防回归守卫**。
 *
 * 为什么要有它：本次删掉的四个字段键（`sendVariant` / `inputShowPlaceholder` / `prismOnColor` /
 * `pillText`）删完之后，`lint` / `build` / `check:solid` 没有任何一层会因为"它们悄悄回来"而变红
 * （与 #238 第③件同因：`check-css-var-consumption.mts` 只抓"不带 fallback 的悬空引用"）。
 * 写法沿用先例：`ccVisibilityDeclarationGuard.test.ts`（源码级 + 对象级双判据，读文本 + 剥注释）。
 *
 * 判据四层：
 * 1. **源码级（★ 刀6 起为全 `src/`）**：剥注释后、排除 `__tests__` / `__fixtures__` 后，四个键
 *    在**整个生产源码**里零命中 —— 这一层现在自己就盖住出厂数据、`presets/`、`StatusBar.css`
 *    以及**任何**后来新增的文件（原先只扫「出厂数据 + StatusBar.css」，`migration.ts` 的残留就是这么漏过去的）；
 * 2. **出厂数据面**（专项，保留）：`src/zones/factory/**` + `src/presets/**` 零命中
 *    —— 单独留一条是为了"手改过的出厂数据被回滚"时给出更明确的报错位置；
 * 3. **字段表级**：四个键不在 `THEME_FIELD_DEFS` / `THEME_FIELD_KEYS` 里；
 * 4. **样式级**：`chat/StatusBar.css` 里既没有那两个 CSS 变量、也没有那两族悬空选择器。
 *
 * ★ 这不是教条：将来若确要复活其中任何一项（例：`sendVariant` 真接线），
 *   **改这条测试是一个显式动作** —— 改哪一条、为什么，都会进 diff。
 */
const SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** 剥掉注释：说明性注释**会提到**被删的名字（本任务就要求在注释里留口径说明），不该被误判。 */
const stripComments = (source: string) => source
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(?<!:)\/\/[^\n]*/g, '')

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css']

/** 递归收集某个目录下除 `__tests__` / `__fixtures__` 之外的生产源码。 */
function productionFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== '__fixtures__') found.push(...productionFiles(path))
      continue
    }
    if (SCANNED_EXTENSIONS.some(extension => name.endsWith(extension))) found.push(path)
  }
  return found
}

/** 注意：`relative()` 基于带尾随分隔符的 `SRC_ROOT` 切片 ⇒ 结果**不带**前导斜杠。 */
const relative = (path: string) => path.slice(SRC_ROOT.length).replaceAll('\\', '/')
const read = (path: string) => ({ path, text: stripComments(readFileSync(path, 'utf8')) })

/** ★ 刀6：主扫描面 = **全 `src/` 生产源码**。 */
const sources = productionFiles(SRC_ROOT).map(read)
/** 出厂数据面（`zones/factory/**` + `presets/**`）—— 专项保留，便于报错定位。 */
const factorySources = [
  ...productionFiles(join(SRC_ROOT, 'domains/theme/zones')),
  ...productionFiles(join(SRC_ROOT, 'domains/theme/presets')),
].map(read)

/**
 * CC-07 删掉的字段键：出现在生产源码里即回归。
 *
 * 刀 1~6（四个）：`sendVariant` / `inputShowPlaceholder` / `prismOnColor` / `pillText`
 * 刀 7~13（七个）：`cliLinePadding` / `cliContentOffsetY` / `inputMode` / `inputVariant` /
 *   `cliOverflowMode` / `footerLayout` / `inputMinHeight`
 * CC-31（一个）：`userTagText`（设置项「用户标签文字」；唯一消费者是死类名 `.term-user-tag`，
 *   单 23 删该类名后 check-css-var-consumption 暴露 `--user-tag-text` 死注入 ⇒ 字段整体退役）
 */
const PRUNED_FIELD_KEYS = [
  'sendVariant', 'inputShowPlaceholder', 'prismOnColor', 'pillText',
  'cliLinePadding', 'cliContentOffsetY', 'inputMode', 'inputVariant',
  'cliOverflowMode', 'footerLayout', 'inputMinHeight',
  'userTagText',
] as const

/**
 * 刀 7~13 里三个 number 字段的**派生 CSS 变量**（`--<kebab>`，由 `THEME_CSS_VAR_MAP` 自动产出）。
 * camelCase 键扫描抓不到 `var(--cli-content-offset-y)` 这类**悬空变量引用**，故单列一份。
 */
const PRUNED_CSS_VARIABLES = ['--cli-line-padding', '--cli-content-offset-y', '--input-min-height', '--user-tag-text'] as const

/**
 * 命中判据（两条择一命中即算回归）：
 * 1. `.<key>`（属性访问 / **属性赋值**，例如 `state.inputMode = 'cli'` —— 这是最典型的回归形状）；
 * 2. 裸 `<key>` 且**后面不是 `=`**（对象字面量键 `inputMode: 'cli'`、类型成员 `inputMode: string`、
 *    字符串键 `'inputMode'` 等）。
 *
 * 被排除的只有 **JSX DOM 属性**形式：裸标识符紧跟 `=`（`inputMode={…}` 与 `inputMode="url"`）。
 * 为什么必须排除：`src/components/ElicitationRequestCard.tsx`（`inputMode={…}`）与
 * `src/sheets/browser/BrowserToolPanel.solid.tsx`（`inputMode="url"`）用的是与主题字段**同名**的
 * HTML 输入模式属性，跟本守卫无关。
 *
 * ★ 转义必须写成 `\\b` / `\\s` / `\\.`（模板串里 `\b` 会变成退格符 U+0008、`\s` 会退化成字面 `s`）
 *   —— 这条注释是**血的教训**：首版写成单反斜杠，判据整体空转、守卫假绿，
 *   是反向验证（把键放回生产文件）才把它揪出来的。
 */
const fieldKeyPattern = (key: string) => new RegExp(`(?:\\.\\b${key}\\b|\\b${key}\\b(?!\\s*=))`)

/** A3 / A4 的两片悬空规则带走的 CSS 消费者：变量与选择器都不该再出现在 `StatusBar.css`。 */
const PRUNED_CSS_TOKENS = ['--prism-on-color', '--pill-text', '.prism-tag', '.model-menu', '.model-item'] as const

const STATUS_BAR_CSS = 'plugins/product/packages/builtin.pylon-renderers/styles/components/chat/StatusBar.css'

const statusBarCssPath = productionFiles(join(SRC_ROOT, 'plugins'))
  .find(path => relative(path) === STATUS_BAR_CSS)
const statusBarCssText = statusBarCssPath ? stripComments(readFileSync(statusBarCssPath, 'utf8')) : undefined

/** 命中格式化：`文件 → 键`（报错里能直接看出改回的是哪个文件）。 */
const hitsOf = (batch: readonly { path: string; text: string }[]) => batch.flatMap(({ path, text }) => [
  ...PRUNED_FIELD_KEYS.filter(key => fieldKeyPattern(key).test(text)).map(key => `${relative(path)} → ${key}`),
  ...PRUNED_CSS_VARIABLES.filter(variable => text.includes(variable)).map(variable => `${relative(path)} → ${variable}`),
])

describe('#266 CC-07 · 被删的中控字段不得回归', () => {
  it('扫描面非空（防"守卫自己空转"）', () => {
    expect(sources.length, '生产源码扫描面为空 ⇒ 守卫是假绿').toBeGreaterThan(300)
    expect(sources.filter(source => source.path.endsWith('.css')).length, 'CSS 扫描面为空').toBeGreaterThan(10)
    expect(factorySources.length, '出厂数据扫描面为空').toBeGreaterThan(5)
    // 正控：两条主扫描路径都真的落进了集合（路径漂了会在这里露头）
    const paths = new Set(sources.map(source => relative(source.path)))
    expect(paths.has('domains/theme/presets/builtin.ts')).toBe(true)
    expect(paths.has('domains/theme/migration.ts')).toBe(true)
    // 正控：`__tests__` / `__fixtures__` 确实被排除了（否则本文件自己的字面量就会让它常红）
    expect([...paths].some(path => path.includes('__tests__')), '测试目录没被排除').toBe(false)
    expect([...paths].some(path => path.includes('__fixtures__')), 'fixture 目录没被排除').toBe(false)
  })

  it('★ 十二个字段键 + 四个派生变量在**全 `src/` 生产源码**里零命中（任何一项回来即红）', () => {
    expect(hitsOf(sources), 'CC-07 删掉的字段又回到了生产源码；若确要用，改这条测试是显式动作').toEqual([])
  })

  it('十二个键都不在字段定义表里（换个地方重新加回定义表也红）', () => {
    for (const key of PRUNED_FIELD_KEYS) {
      expect(Object.hasOwn(THEME_FIELD_DEFS, key), `${key} 又回到了 THEME_FIELD_DEFS`).toBe(false)
      expect(THEME_FIELD_KEYS as readonly string[]).not.toContain(key)
    }
    // 正控：字段表本身仍在（否则上面的断言会因为"表整个没了"而假绿）
    expect(THEME_FIELD_KEYS.length).toBeGreaterThan(150)
    expect(THEME_FIELD_KEYS).toContain('inputShowHistoryHint')
  })

  it('出厂数据（zones/factory/** + presets/**）里这些键零命中', () => {
    expect(hitsOf(factorySources), '出厂预设数据里又出现了被删字段（手改过的地方被回滚）').toEqual([])
    // 正控：出厂数据本体仍在（防"文件被清空 ⇒ 上面恒绿"）
    expect(factorySources.some(({ path }) => relative(path) === 'domains/theme/presets/builtin.ts')).toBe(true)
    expect(factorySources.every(({ text }) => text.length > 0)).toBe(true)
  })

  it('StatusBar.css 里两片悬空规则的变量与选择器都不在了', () => {
    expect(statusBarCssText, `StatusBar.css 没被扫到（路径漂了？）：${STATUS_BAR_CSS}`).toBeDefined()
    const text = statusBarCssText!
    const hits = PRUNED_CSS_TOKENS.filter(token => text.includes(token))
    expect(hits, `StatusBar.css 里又出现了悬空规则的残留：${hits.join(', ')}`).toEqual([])
    // 正控：同一文件里**不该删的**两段仍在（防"整段被误删"）—— 基础规则 + 语义色四条中的一段。
    // ★ #266 CC-29：原来第二条正控是 StatusBar.css 里那段等宽 pill（pill-mono），
    //   而它是**死规则**（类名零命中），等于让守卫"保护"一条死规则 ⇒ 已换成真活的那段语义色选择器。
    expect(text).toContain('.cc-permission-trigger')
    expect(text).toContain('.cc-permission-trigger[data-mode="bypass"]')
  })

  it('字段表里 `用量胶囊` 名下已无字段（tokens 元件据此退出设置页与导航）', () => {
    const stillThere = THEME_FIELD_KEYS.filter(key => (THEME_FIELD_DEFS[key] as { group?: string }).group === '用量胶囊')
    expect(stillThere).toEqual([])
  })
})
