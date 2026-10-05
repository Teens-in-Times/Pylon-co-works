import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #238 第③件（中控死数据清理）的**防回归守卫**。
 *
 * 为什么要有它：第③件的反向验证实测过 —— 把删掉的死数据**全部放回去**，
 * `lint` / `build` / `check:solid` / 相关测试**全绿，没有任何一层能抓到**
 * （`check-css-var-consumption.mts` 只抓"**不带 fallback** 的悬空引用"）。
 * 本文件补上这一层。写法仿先例 `workbenchChromeCss.solid.test.ts` 的 CSS 侧守卫（刀5B 建）。
 *
 * 守卫对象 = 第③件删掉的四项（原第 5 项「两个内建贡献上的 propertyFields」随 CC-13 刀2
 * 内置两件退役一并退场 —— 贡献本体已删，该结构断言无处可断）：
 * 1. `BUILTIN_CC_WIDGET_DEFINITIONS`（旧目录视图）
 * 2. `mergeCcWidgetCatalog`（目录合并视图，`src/components/cc/widgetCatalogView.ts` 已整删）
 * 3. `.modern-command-dock` 一族 CSS
 * 4. `.status-bar`（`chat/StatusBar.css` 里那一块）
 *
 * ★ **这不是教条**：若将来确要用其中任何一项（例：`mergeCcWidgetCatalog` 的合并逻辑随
 * 插件通道打通而复活），**改这条测试就是一个显式动作** —— 改哪一条、为什么改，都会进 diff。
 * 这正是它存在的意义：把"死数据悄悄回来"变成"有人主动决定它回来"。
 *
 * 判据是**读生产源码文本**（跳过 `__tests__` / `__fixtures__`：测试里的说明性文字会提到这些名字），
 * 不另写一份正则模拟。
 */
const SRC_ROOT = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css']

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

/** 剥掉注释：说明性注释**会提到**被删的名字，不该被误判（先例同款做法）。 */
const stripComments = (source: string) => source
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(?<!:)\/\/[^\n]*/g, '')

const relative = (path: string) => path.slice(SRC_ROOT.length).replaceAll('\\', '/')
const sources = productionFiles(SRC_ROOT).map(path => ({ path, text: stripComments(readFileSync(path, 'utf8')) }))

/** 第③件删掉的死数据：出现在生产源码里即回归。 */
const BANNED_TOKENS = [
  { token: 'BUILTIN_CC_WIDGET_DEFINITIONS', what: '旧目录视图（生产零消费者）' },
  { token: 'mergeCcWidgetCatalog', what: '目录合并视图（文件已整删）' },
  { token: 'modern-command-dock', what: '一族无渲染方的 CSS（ControlCenter.css / InputBar.css）' },
  { token: '--status-bg', what: 'statusBg / statusBgImage 留下的 CSS 变量引用' },
  // ★ #238 刀8：「整体风格」整套删除（字段 / 类名 / 三段变体 CSS / 皮肤属性 data-cc-variant / 预览读取）。
  //   三个 token 分别对应：字段与快照名、渲染类名前缀、CSS 小节标题。
  { token: 'ccVariant', what: '「整体风格」字段（刀8 整套删除）' },
  { token: 'cc-variant-', what: '变体类名前缀（CSS 与 class 模板，刀8 整族删除）' },
  { token: 'ccVariant styles', what: 'CSS 里的变体小节（刀8 整段删除）' },
] as const

describe('#238 第③件 · 死数据不得回归', () => {
  it('扫描面非空（防"守卫自己空转"）', () => {
    expect(sources.length, '生产源码扫描面为空 ⇒ 守卫是假绿').toBeGreaterThan(300)
    expect(sources.filter(source => source.path.endsWith('.css')).length, 'CSS 扫描面为空').toBeGreaterThan(10)
  })

  it('四项被删的死数据在生产源码里零命中（任何一项回来即红）', () => {
    const hits = sources.flatMap(({ path, text }) =>
      BANNED_TOKENS
        .filter(({ token }) => text.includes(token))
        .map(({ token, what }) => `${relative(path)} → ${token}（${what}）`),
    )
    expect(hits, '第③件删掉的死数据又回到了生产源码；若确要用，改这条测试是显式动作').toEqual([])
  })

  it('`.status-bar` 选择器零命中（用精确边界，避开 `.file-status-bar` 这类无关类）', () => {
    // `\.status-bar(?![\w-])`：前一个字符必须是 `.`（`.file-status-bar` 里 status-bar 前面是 `-`，不命中），
    // 后面不得再接 `-` 或字母数字（排除 `.status-bar-x` 这种新类）。
    const selector = /\.status-bar(?![\w-])/
    const hits = sources
      .filter(({ path }) => path.endsWith('.css'))
      .filter(({ text }) => selector.test(text))
      .map(({ path }) => relative(path))
    expect(hits, '`.status-bar` 那一块（该类无渲染方）又回到了样式表').toEqual([])
  })
})
