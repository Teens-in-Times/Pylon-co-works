import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.modern.css',
  'utf8',
)

/** 取规则体（选择器组按成员精确比对；先剥注释，避免注释文本挡住选择器）。 */
function ruleBody(selector: string): string | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(withoutComments)) !== null) {
    const selectors = match[1].split(',').map(s => s.trim())
    if (selectors.includes(selector)) return match[2]
  }
  return undefined
}

// 中控原先铺满主区；侧栏折叠后主区可达 1500px+，输入条会与消息列脱开成一条横带。
// 契约：现代模式中控与阅读列同宽（同一 CSS 变量真值），窄窗再按 `.term` 的内边距收窄。
describe('现代模式输入区宽度契约', () => {
  const selector = '.app[data-interface-mode="modern-gui"] .solid-workbench-content-column > .control-center'

  it('中控按阅读列宽收窄并居中', () => {
    const body = ruleBody(selector)
    expect(body, '缺少现代模式中控宽度规则').toBeTruthy()
    expect(body).toContain('max-width: min(var(--reading-column-max-width, 960px)')
    expect(body).toContain('margin-inline: auto')
    // 兜底留出与基础 .control-center 同源的横向留白。
    expect(body).toContain('var(--cc-margin-x, 20px)')
  })

  it('窄窗（.term 收内边距）同步镜像，输入条不得比消息列更宽', () => {
    const mobile = css.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(mobile).toContain(selector)
    expect(mobile).toContain('var(--ui-space-4)')
  })
})
