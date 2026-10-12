import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css',
  'utf8',
)
const chromeCss = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css',
  'utf8',
)

describe('reasoning row geometry contract', () => {
  it('keeps the collapsed and expanded reasoning header on the same vertical rail', () => {
    const collapsedBlock = css.match(
      /\.app\[data-interface-mode="terminal-like"\] \.term-row-reasoning:has\(\.term-collapse\[data-open="false"\]\) \.term-reasoning\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? ''

    expect(collapsedBlock).toContain('padding-block: var(--ui-space-1)')
    expect(collapsedBlock).not.toContain('padding-block:0')
  })

  it('keeps an animated reasoning collapse region at the message width', () => {
    const region = css.match(/\.term-collapse,\s*\n\.term-collapse-content\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(region).toContain('width:100%')
    expect(region).toContain('min-width:0')

    const body = css.match(/\.term-reasoning-body\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(body).toContain('box-sizing:border-box')
    expect(body).toContain('width:100%')
    expect(body).toContain('max-width:100%')
    expect(body).toContain('min-width:0')
  })

  it('keeps reasoning and conversation prose on the message font while inline code opts into mono coloring', () => {
    expect(css).toMatch(/\.term-row-user, \.term-row-assistant\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-row-reasoning\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-inline-code\s*\{[^}]*font-family:var\(--mono\);[^}]*color:var\(--chat-code-color,#b47814\);/s)
  })

  it('keeps the assistant marker and body in one non-wrapping flex row', () => {
    const markerBlock = css.match(/\.term-assistant\.has-dot\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(markerBlock).toContain('flex-wrap:nowrap')
    expect(markerBlock).toContain('width:100%')
    expect(css).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body\s*\{[^}]*flex:1 1 auto;[^}]*min-width:0;/s)
  })

  it('does not apply a negative horizontal transform to the streaming indicator row', () => {
    expect(css).not.toContain('transform: translateX(-4px)')
  })

  it('keeps tool prose on the message font while code/path surfaces opt into mono', () => {
    expect(css).toMatch(/\.term-tool-body\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-tool-summary-code\s*\{\s*font-family:var\(--mono\);/s)
    expect(css).toMatch(/\.term-tool-body :is\([^)]*\.term-code-block[^)]*\)\s*\{\s*font-family:var\(--mono\);/s)

    const messageRailRule = css.lastIndexOf('.term-tool-head,\n.term-tool-name')
    const codeSummaryRule = css.lastIndexOf('.term-tool-summary-code {')
    expect(messageRailRule).toBeGreaterThan(-1)
    expect(codeSummaryRule).toBeGreaterThan(messageRailRule)
  })

  it('keeps tool headers and indicators on the message font when no token is supplied', () => {
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] :is\([\s\S]*?\.term-tool-head\s*\)\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-tool-head,\s*\.term-tool-name,[\s\S]*?\.term-spinner-row \.spinner-activity\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-assistant\.has-dot > \.term-assistant-dot,[\s\S]*?\.term-tool-head > \.term-tool-indicator\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)

    const terminalAssistantMarker = css.match(
      /\.app\[data-interface-mode="terminal-like"\] :is\(\s*\.term-assistant\.has-dot > \.term-assistant-dot\s*\)\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? ''
    const terminalToolIndicator = css.match(
      /\.app\[data-interface-mode="terminal-like"\] \.term-tool-head > \.term-tool-indicator\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? ''
    expect(terminalAssistantMarker).toContain('font-family: var(--msg-font,var(--chat-font,var(--mono)))')
    expect(terminalAssistantMarker).toContain('font-size: var(--msg-font-size,var(--chat-font-size,var(--font-size-lg)))')
    expect(terminalAssistantMarker).toContain('line-height: var(--msg-line-height,var(--chat-line-height,1.35))')
    expect(terminalToolIndicator).toContain('font-family: var(--msg-font, var(--chat-font, var(--mono)))')
    expect(terminalToolIndicator).toContain('font-size: var(--msg-font-size, var(--chat-font-size, var(--font-size-lg)))')
    expect(terminalToolIndicator).toContain('line-height: var(--msg-line-height, var(--chat-line-height, 1.35))')
  })

  it('uses the shared marker gutter for the streaming frame without a visual offset', () => {
    expect(css).toMatch(/\.term-spinner-row \.spinner-frame\s*\{[^}]*flex:0 0 var\(--dot-col-width,var\(--agent-marker-col,1\.6em\)\);[^}]*text-align:left;/s)
    expect(css).toMatch(/\.term-spinner-row\s*\{[^}]*margin-left:0;[^}]*transform:none;/s)
  })

  it('anchors empty-state brand and creation progress to the chat viewport', () => {
    expect(chromeCss).toMatch(/\.solid-workbench-empty-space\s*\{[^}]*align-items: flex-start;[^}]*min-height: 100%;/s)
    expect(chromeCss).toMatch(/\.solid-workbench-empty-brand\s*\{[^}]*position: absolute;[^}]*top: clamp\(10%, 8vh, 18%\);[^}]*display: flex;[^}]*justify-content: center;/s)
    expect(chromeCss).not.toMatch(/\.solid-workbench-empty-brand\s*\{[^}]*min-height: 100%;/s)
    const declarations = chromeCss.replaceAll(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).toMatch(/\.solid-workbench-creation-overlay-host\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0\s*;[^}]*place-items:\s*center;/s)
    expect(declarations).not.toContain('--creation-overlay-right-inset')
    expect(chromeCss).toMatch(/\.solid-workbench-creation-overlay-host\[data-reduced-motion='true'\][^}]*\.solid-workbench-creation-progress-bar\s*\{[^}]*animation: none;/s)
  })

  it('centers the complete Solid logo lockup as one visible unit', () => {
    const lockup = chromeCss.match(/\.solid-workbench-empty-brand \.agent-empty-lockup\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(lockup).toContain('display: inline-flex')
    expect(lockup).toContain('width: max-content')
    expect(lockup).toContain('max-width: 100%')
    expect(chromeCss).toMatch(/\.solid-workbench-empty-brand \.agent-empty-brand\s*\{[^}]*flex: 0 0 48px;/s)
    expect(chromeCss).toMatch(/\.solid-workbench-empty-brand \.agent-empty-wordmark\s*\{[^}]*max-width: calc\(100% - 48px - var\(--ui-space-2\)\);/s)
  })

  it('keeps the React empty surface full-width so its logo centers in the same viewport', () => {
    expect(css).toMatch(/\.chat-empty\s*\{[^}]*min-height:100%;[^}]*width:100%;/s)
    expect(css).toMatch(/\.chat-empty\.agent-empty-state\s*\{[^}]*position:relative;/s)
  })

  // P57 S3-R1（R-B1）：代码块内容 span 统一「保留缩进 + 长行软折」。
  it('P57 S3-R1：.term-code-block .term-code-text 的 pre-wrap+anywhere 规则存在', () => {
    const block = css.match(/\.term-code-block \.term-code-text\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(block).toContain('white-space: pre-wrap')
    expect(block).toContain('overflow-wrap: anywhere')
    expect(block).toContain('min-width: 0')
    expect(block).toContain('flex: 1 1 auto')
  })

  // P57 S3-R5（R-B5）：user 正文双路径同 white-space 契约——元素+类双写选择器
  // 用于捕获第三方 Suite 渲染的裸 <p>。
  it('P57 S3-R5：.term-user p 与 .term-user .term-p 同为 pre-wrap', () => {
    expect(css).toMatch(/\.term-user p,\s*\n\.term-user \.term-p\s*\{\s*white-space: pre-wrap;\s*\}/)
  })

  // P57 S3-R8（R-B8/A11）：首次解析骨架的最小高度契约（配合零高度阶跃目标）。
  it('P57 S3-R8：.term-md-skeleton 解析骨架 min-height:1em 规则存在', () => {
    expect(css).toMatch(/\.term-md-skeleton\s*\{[^}]*min-height:\s*1em;/)
  })

  // #370：markdown 列表的符号**只由原生 marker 承担**（UL 走 UA 的 disc/circle/square 分级，
  // OL 走序号）。::before 不再画列表符号——否则与 marker 叠加成双点，且把首行文字顶到续行
  // 右侧 17px（实机实测：li 盒 313 / 首行文字 330 / 续行 313）。
  it('#370：markdown 列表只用原生 marker，::before 不画符号', () => {
    expect(css).toMatch(/ul:has\(> \.term-li\) > \.term-li::before,\s*\nol:has\(> \.term-li\) > \.term-li::before\s*\{\s*content:none;\s*\}/)
    // 配色契约保留（一级 accent，二三级 dim）；字形交给 UA 分级，不再由 CSS 写死
    expect(css).toMatch(/\.term-assistant ul > \.term-li::marker\s*\{\s*color:var\(--accent\);\s*\}/)
    expect(css).toMatch(/\.term-assistant ul ul > \.term-li::marker,\s*\n\.term-assistant ul ul ul > \.term-li::marker\s*\{\s*color:var\(--text-dim\);\s*\}/)
    // 老机构彻底退出：全文件不再有 `::before` 画列表符号（`content:none` 不算）
    expect(css).not.toMatch(/\.term-li::before\s*\{[^}]*content:\s*['"]/)
  })
})

// 真浏览器实测（Chrome headless 1280px，直接加载本文件；探针与数据见台账 P85）：
// `data-msg-style="bubble"`（行 shrink-to-fit）+ `data-message-layout="classic"`
// （正文零 basis）+ assistantDot 三者同开时，正文被压成 row=44px / body=0px /
// 91 行（同一段落其余组合均 3 行）——这正是「输出少数几个字符就换行」的碎裂。
describe('assistant body width contract', () => {
  it('keeps the content column width-bearing in every row style', () => {
    const rules = css.match(/\.term-assistant\.has-dot > \.term-assistant-body\s*\{([^}]*)\}/g) ?? []
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.join('\n')).toContain('flex:1 1 auto')
    expect(rules.join('\n')).toContain('width:auto')
    expect(rules.join('\n')).toContain('max-width:100%')
    expect(css).not.toMatch(/\.app\[data-message-layout="classic"\][^{]*\.term-assistant\.has-dot > \.term-assistant-body\s*\{[^}]*width:0;/)
  })
})

// 下沉自 scripts/test-markdown-list-line-height.mts（P91 A2）：列表行高与缩进契约，
// 原为全文 includes 文案断言，改选择器限域（防 token 撞车误绿）。
describe('markdown 列表行高与缩进契约', () => {
  it('assistant 行基础块用 token 内边距且 white-space:normal（非 pre-wrap）', () => {
    const base = css.match(/(\.term-assistant \{[^}]*\})/)?.[1] ?? ''
    expect(base).toContain('padding:var(--ui-space-1) 0')
    expect(base).toContain('white-space:normal')
    expect(base).not.toContain('white-space:pre-wrap')
  })

  it('列表元素行高走 msg-line-height 变量链', () => {
    const listRule = css.match(
      /(\.term-row-assistant \.term-assistant ol,\s*\n\.term-row-assistant \.term-assistant ul,\s*\n\.term-row-assistant \.term-assistant li \{[^}]*\})/,
    )?.[1] ?? ''
    expect(listRule).toContain('line-height:var(--msg-line-height,var(--chat-line-height,1.35))')
  })

  it('ReactMarkdown 列表缩进：ol 2em / ul 1.5em，零外边距（间距由行高承担）', () => {
    const ol = css.match(/(\.term-assistant ol \{[^}]*\})/g)?.map(rule => rule) ?? []
    const ul = css.match(/(\.term-assistant ul \{[^}]*\})/)?.[1] ?? ''
    const li = css.match(/(\.term-assistant li \{ margin:[^}]*\})/g) ?? []
    // claude 布局在 224 行附近有自己的 em 外边距覆盖；基础规则（ReactMarkdown 缩进块）
    // 必须是零边距 + 缩进，不得被误改。
    expect(ol).toContain('.term-assistant ol { padding-left:2em; margin:0; }')
    expect(ol).not.toContain('.term-assistant ol { padding-left:2em; margin:4px 0; }')
    expect(ul).toContain('.term-assistant ul { padding-left:1.5em; margin:0; }')
    expect(li).toContain('.term-assistant li { margin:0; }')
    expect(li).not.toContain('.term-assistant li { margin:2px 0; }')
  })
})

// 下沉自 scripts/test-message-style.mts（P91 A2）：消息变量消费与布局属性钩子。
describe('消息变量消费与布局钩子', () => {
  it('消息渲染消费 msg 三变量（font/text/line-height）', () => {
    expect(css).toContain('var(--msg-font')
    expect(css).toContain('var(--msg-text')
    expect(css).toContain('var(--msg-line-height')
  })

  it('气泡/claude 布局属性钩子在场', () => {
    expect(css).toContain('[data-msg-style="bubble"]')
    expect(css).toContain('[data-message-layout="claude"] .term-tool')
    expect(css).not.toContain('padding:0 0 0 2ch')
  })

  it('claude 布局：用户消息 8px 纵向内边距，块级元素左内边距归零', () => {
    expect(css).toMatch(/\.app\[data-message-layout="claude"\] \.term-user \{[^}]*padding:8px 0;/)
    expect(css).toMatch(/\.app\[data-message-layout="claude"\] \.term-assistant,[^{]*\.term-reasoning,[^{]*\.term-tool \{[^}]*padding-left:0;/)
  })

  it('用户消息固定前缀列布局；spinner 行与消息左轨道对齐', () => {
    expect(css).toMatch(/\.term-user \{ display:flex; align-items:baseline;/)
    expect(css).toMatch(/\.term-spinner-row \{[^}]*padding: var\(--ui-space-1\) 0;/)
  })
})

// 下沉自 scripts/test-tool-connector.mts（P91 A2）：连接线层叠定位与状态着色。
describe('工具连接线 CSS 契约', () => {
  it('层叠次序：term 定位包含块，线在 body 之上，head 覆盖线', () => {
    expect(css).toMatch(/\.term \{[^}]*position:relative;/)
    expect(css).toMatch(/\.term-tool-connector \{[^}]*position:absolute;[^}]*z-index:1;/)
    expect(css).toMatch(/\.term-tool-head \{ position:relative; z-index:2;/)
    expect(css).not.toContain('term-tool::before')
    expect(css).not.toContain('--conn-gap')
  })

  it('工具名随状态着色（ok/err/run 三态变量链）', () => {
    expect(css).toContain('.term-tool[data-status="ok"] .term-tool-name { color:var(--tool-ok,#1e9646); }')
    expect(css).toContain('.term-tool[data-status="err"] .term-tool-name { color:var(--tool-err,#be2828); }')
    expect(css).toContain('.term-tool[data-status="run"] .term-tool-name { color:var(--tool-run,#3b82f6); }')
  })
})

// 下沉自 scripts/test-tool-connector-motion.mts（P91 A2）：连接线动画样式契约。
describe('工具连接线动画 CSS 契约', () => {
  it('dotted 与 pulse 样式族在场', () => {
    expect(css).toMatch(/\.term-tool-connector-style--dotted/)
    expect(css).toMatch(/\.term-tool-connector-style--pulse/)
  })

  it('状态动画：pulse 呼吸 / settle 收敛 / flash 闪烁 / static 静止', () => {
    expect(css).toContain('.term-tool-connector--pulse { animation:tool-connector-pulse 1.8s ease-in-out infinite; }')
    expect(css).toContain('.term-tool-connector--settle { animation:tool-connector-settle 360ms ease-out 1 both; }')
    expect(css).toContain('.term-tool-connector--flash { animation:tool-connector-flash 320ms ease-out 1 both; }')
    expect(css).toContain('.term-tool-connector--static { animation:none; }')
  })

  it('failed 连接线同步指示物模糊；减动效时 breathe/flash 归零', () => {
    expect(css).toContain('.term-tool-connector[data-connector-mode="follow"][data-tool-state="failed"] { filter:blur(0.65px); }')
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)[^@]*\.term-tool-connector--breathe,[^@]*\.term-tool-connector--flash \{ animation:none; filter:none; \}/)
  })
})

// 下沉自 scripts/test-style-guards.mts（P91 A2 拆分）：ChatView 基础样式守卫。
describe('ChatView 基础样式守卫', () => {
  it('消息渲染失败行必须有错误样式', () => {
    expect(css).toMatch(/\.term-row-error\s*\{/)
  })

  it('用户代码块保持等宽字体', () => {
    expect(css).toContain('.term-user code { font-family:var(--mono); font-size:inherit; }')
  })
})

// #272：表格列对齐——GFM 分隔符经模型 align 属性 + 此处属性选择器生效，
// 特异性高于 text-align:left 基线规则（同文件更后 + 属性选择器）。
describe('#272 表格列对齐契约', () => {
  it('align 属性选择器规则存在（center/right；left 为无属性缺省）', () => {
    expect(css).toContain(".term-assistant .term-table th[align='center'],")
    expect(css).toContain(".term-assistant .term-table td[align='center'] { text-align:center; }")
    expect(css).toContain(".term-assistant .term-table th[align='right'],")
    expect(css).toContain(".term-assistant .term-table td[align='right'] { text-align:right; }")
  })
})
