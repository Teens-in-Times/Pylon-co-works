import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Solid 工作台壳层 CSS 契约（过渡态：中控区输入栏生产接线，位置正常）。
 *
 * 断言对象是 WorkbenchChrome.css 的文本规则——与 radiusContract 同款文件读取模式。
 * 每条规则对应一个已证实的裸类（见 references/solid-chrome-gap-audit.md 的 22 类清单），
 * 本过渡态只覆盖布局骨架必需的 8 个类；其余留待 P2-P4。
 */
const css = (relativePath: string) => {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
  return readFileSync(pathname, 'utf8')
}

const chromeCss = css('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css')

describe('Solid 工作台壳层样式契约', () => {
  it('suite 挂载壳补齐 main-body 等价几何（flex 列 + min-height:0 + overflow:hidden + right-inset 变量）', () => {
    const block = extractBlock(chromeCss, '.renderer-suite-workbench')
    expect(block, 'renderer-suite-workbench 缺 flex column').toContain('flex-direction:column')
    expect(block, 'renderer-suite-workbench 缺 min-height:0').toContain('min-height:0')
    expect(block, 'renderer-suite-workbench 缺 overflow:hidden').toContain('overflow:hidden')
    expect(block, 'renderer-suite-workbench 未消费 --right-panel-inset 联动变量').toContain('--right-panel-inset')
    // mount 层必须撑满宿主
    const mount = extractBlock(chromeCss, '.renderer-suite-workbench-mount')
    expect(mount, 'mount 层未撑满（缺 display:flex 与 flex:1）').toContain('flex')
  })

  it('solid-agent-workbench 是两列 grid 且左内容列与消息流可伸缩', () => {
    const block = extractBlock(chromeCss, '.solid-agent-workbench')
    expect(block).toContain('display:grid')
    expect(block).toContain('grid-template-columns:minmax(0,1fr)var(--scroll-action-rail-width)')
    expect(block).toContain('grid-template-rows:minmax(0,1fr)')
    expect(block).toContain('flex:1')
    expect(block).toContain('min-width:0')
    expect(block).toContain('min-height:0')
    expect(block).toContain('padding-right:var(--right-panel-inset,0px)')
    const column = extractBlock(chromeCss, '.solid-workbench-content-column')
    for (const declaration of ['grid-column:1', 'grid-row:1', 'position:relative', 'display:flex', 'flex-direction:column', 'min-width:0', 'min-height:0']) {
      expect(column).toContain(declaration)
    }
    expect(extractBlock(chromeCss, '.solid-workbench-chat-shell')).toContain('flex:11auto')
  })

  it('生产中控槽位复用 control-center 几何：底部停靠且不参与消息流伸缩', () => {
    const cc = extractBlock(chromeCss, '.solid-workbench-control-center-slot')
    expect(cc, '中控槽缺 margin-top:auto 底部停靠').toContain('margin-top:auto')
    expect(cc, '中控槽缺 flex-shrink:0（会被消息流挤压）').toContain('flex-shrink:0')
  })

  it('裸 surface 区块间距受控（activity 行不得偏离消息指示列）', () => {
    // #483：pet 占位（.solid-workbench-pet-slot）随宠物链删除退役，此处只钉 timeline/activities。
    const timeline = extractBlock(chromeCss, '.solid-workbench-timeline')
    expect(timeline, 'timeline 裸区块缺最小间距').toMatch(/margin|padding/)
    const activities = extractBlock(chromeCss, '.solid-workbench-activities')
    expect(activities).toMatch(/margin|padding/)
    expect(activities, 'activity 列表嵌入消息流后不得增加水平外边距，否则工具指示器会偏离助手圆点').toContain('margin:8px00')
    expect(chromeCss).not.toContain('solid-workbench-pet-slot')
  })

  it('回放只读遮罩有可见形态（position+层级），空态居中', () => {
    const replay = extractBlock(chromeCss, '.solid-workbench-replay-overlay')
    expect(replay).toContain('position:absolute')
    expect(replay).toMatch(/z-index/)
    const empty = extractBlock(chromeCss, '.solid-workbench-empty-space')
    expect(empty).toContain('flex:1')
  })

  it('C14 session surfaces consume layout/density/warning tokens and retain keyboard focus visibility', () => {
    const surface = extractBlock(chromeCss, '.solid-session-surface')
    expect(surface).toContain('display:grid')
    expect(surface).toContain('border:')
    const warning = extractBlock(chromeCss, ".solid-session-budget[data-warning='true'][data-palette='semantic']")
    expect(warning).toMatch(/--warning|--danger|--accent/)
    const inline = extractBlock(chromeCss, ".solid-session-config[data-layout='inline'] .solid-session-config-option")
    expect(inline).toContain('grid-template-columns')
    const compact = extractBlock(chromeCss, ".solid-session-commands[data-density='compact'] .solid-session-command")
    expect(compact).toMatch(/padding|gap/)
    const focus = extractBlock(chromeCss, '.solid-session-assist:focus-visible')
    expect(focus).toContain('outline')
  })
})

/** 从 CSS 文本提取指定选择器的声明块（取首次出现），并压缩空白便于断言。 */
function extractBlock(source: string, selector: string): string {
  // 精确匹配：选择器后必须紧跟空白或 '{'，避免前缀误命中（如 -mount 前缀撞 .renderer-suite-workbench）
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s*\\{)`)
  const match = pattern.exec(source)
  if (!match) throw new Error(`CSS 中找不到选择器 ${selector}`)
  const open = source.indexOf('{', match.index)
  const close = source.indexOf('}', open)
  return source.slice(open + 1, close).replaceAll(/\s+/g, '')
}

const controlCenterCss = css('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css')

describe('#238 刀5B · 分隔点整族已删 + 命令行提示不再是整行元件（CSS 侧守卫）', () => {
  it('分隔点那族在两张样式表里都没有残留（"删一半"会被这条抓到）', () => {
    for (const [name, source] of [['ControlCenter.css', controlCenterCss], ['WorkbenchChrome.css', chromeCss]] as const) {
      expect(source, `${name} 仍有 .cc-widget-separator`).not.toContain('cc-widget-separator')
      expect(source, `${name} 仍有 element + element 的 ::before 分隔规则`).not.toContain('.cc-widget + .cc-widget::before')
      expect(source, `${name} 仍有压住 ::before 的 content:none 收口`).not.toContain('content: none !important')
    }
  })

  it('`.cc-command-hint` 没有整行特化：不占整行、不自己排到行尾、不做位移', () => {
    // 断言前先剥掉注释 —— 块里的注释**会提到**被删掉的那些属性（说明"删了哪些"），不该被误判
    const block = extractBlock(controlCenterCss, '.cc-command-hint').replaceAll(/\/\*[\s\S]*?\*\//g, '')
    for (const banned of ['order:', 'flex-basis:', 'width:100%', 'text-align:', 'transform:']) {
      expect(block, `.cc-command-hint 仍带整行特化 ${banned}`).not.toContain(banned)
    }
    // 该留的还在（有多宽占多宽 + 自己的字号）
    expect(block).toContain('font-size:calc(var(--cc-hint-font-size,16px)*0.86)')
    expect(block).toContain('white-space:nowrap')
  })
})

/** 某选择器的**全部**声明块（同名规则在本文件里出现两次时，两处都要看），并剥注释。 */
function allDeclarations(source: string, selector: string): string {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s*\\{)`, 'g')
  const blocks: string[] = []
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf('{', match.index)
    const close = source.indexOf('}', open)
    blocks.push(source.slice(open + 1, close))
  }
  if (blocks.length === 0) throw new Error(`CSS 中找不到选择器 ${selector}`)
  // 块里的注释**会提到**被改掉的属性（说明"原来是什么"），不该被误判
  return blocks.join('\n').replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\s+/g, '')
}

/**
 * ★★ #266 刀2.5 · 下边组**不折行** + 脱离件定位（CSS 侧守卫）。
 *
 * 为什么要有它：本刀第一条逻辑就是「**不折行 ⇒ 下行组行数恒为 1**」，而刀 3 的
 * 「最小高按边算取最大」正是建立在"行数恒 1"之上。折行若被改回来，`lint` / `tsc` /
 * `check:solid` / 其它测试**没有一层看得见**（没有任何断言盯这两条属性）⇒ 在这里钉住。
 * 做法与上面 `.cc-command-hint` 那条同款（读 CSS 文本 + 剥注释）。
 * ★ 这不是教条：将来真要恢复折行，**改这条测试是一个显式动作**。
 */
describe('#266 刀2.5 · 下边组不折行 + 脱离件定位（CSS 侧守卫）', () => {
  it('承载下边组的两条规则都不再折行（`.cc-status-row` / `.cc-status-group`）', () => {
    for (const selector of ['.cc-status-row', '.cc-status-group']) {
      const block = allDeclarations(controlCenterCss, selector)
      expect(block, `${selector} 又折行了（行数会变 2 ⇒ 刀3 的高度算式失效）`).not.toContain('flex-wrap:wrap')
      expect(block, `${selector} 缺 flex-wrap:nowrap`).toContain('flex-wrap:nowrap')
    }
    // 正控：编辑左列里同样折行的两处 `flex-wrap:wrap` 与下边组无关，本刀**保留**它们
    // （不顺手改别的）。★ #266 刀5：原正控指向的 `.cc-edit-toolbar` 已随「底部横栏 → 左侧一列」
    // 删除 ⇒ 改指新列的同款容器，**口径不变**：证明上面那两条断言不是"全文件都没有 wrap"的空断言。
    expect(allDeclarations(controlCenterCss, '.cc-edit-row-main')).toContain('flex-wrap:wrap')
    expect(allDeclarations(controlCenterCss, '.cc-edit-column-footer')).toContain('flex-wrap:wrap')
  })

  it('脱离件的定位规则在：绝对定位 + 纵向基准变量（允许重叠的前提）', () => {
    const block = allDeclarations(controlCenterCss, '.cc-widget.cc-detach-x')
    expect(block).toContain('position:absolute')
    expect(block).toContain('bottom:var(--cc-status-line-inset,3px)')
    // 纵向基准 = `.cc-body` 的下内边距 ⇒ 声明在 cli-mode 那条规则上
    expect(allDeclarations(controlCenterCss, '.control-center.cli-mode')).toContain('--cc-status-line-inset:3px')
  })
})

const statusBarCss = css('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/chat/StatusBar.css')

/**
 * 2026-09-23 · 权限 `[data-mode]` 语义色的**特异度守卫**。
 *
 * 为什么要有它：这四条颜色规则曾经**从未生效**（权限文字一直是灰的），而
 * lint / build / check:solid / 测试**全绿** —— 原因是特异度同分（都是 (0,2,0)），
 * 而 WorkbenchChrome.css 里那条通用 `color: var(--text-dim)` 更靠后加载。修法是给四条
 * 补上槽位作用域前缀（升到 (0,3,0)）。这类"算式型"失效没有任何一层能抓到，故在此钉住。
 * ★ 与 `ccDeadDataGuard` 同款意义：将来若真要改回去，**改这条就是一次显式动作**。
 */
describe('2026-09-23 · 权限语义色四条必须带槽位作用域前缀（否则被通用规则压掉）', () => {
  const MODES = ['bypass', 'auto', 'edit', 'default'] as const

  it('四条规则的选择器都带槽位前缀，语义色变量仍在，且没用 !important 抢', () => {
    // 出现次数恰好 4：多一条（例如无前缀的旧形态被加回来）或少了都会红
    expect((statusBarCss.match(/\.cc-permission-trigger\[data-mode=/g) ?? []).length).toBe(4)
    for (const mode of MODES) {
      const selector = `.solid-workbench-control-center-slot .cc-permission-trigger[data-mode="${mode}"]`
      expect(statusBarCss, `${mode} 档缺少带槽位前缀的语义色规则`).toContain(selector)
      const block = extractBlock(statusBarCss, selector)
      expect(block, `${mode} 档不再是语义色变量`).toMatch(/color:var\(--/)
      expect(block, `${mode} 档用了 !important（本仓禁区）`).not.toContain('!important')
    }
    // 压住过它的那条通用规则仍在（前提可见：它若被删，本守卫的算式前提就变了）
    const generic = extractBlock(chromeCss, '.solid-workbench-control-center-slot :is(.cc-model-trigger, .cc-permission-trigger, .cc-reasoning-trigger, .cc-usage-pill)')
    expect(generic).toContain('color:var(--text-dim)')
  })
})

/**
 * ★★ #266 刀5 · 空态**不得**隐藏编辑左列（CSS 侧守卫）。
 *
 * 为什么要有它：刀5 把「底部横栏 + 独立属性面板」换成**左侧一列**，并要求"空态下进编辑器也能用"
 * ⇒ 改造前那两条空态隐藏（`.is-empty … .cc-edit-toolbar` / `.cc-prop-panel`）已删。
 * 这条守卫钉的是「**空态只隐藏背景板与高度手柄**」这件事：它**没有任何一行能跑到**（jsdom 不加载
 * 样式表，`checkVisibility` 拿不到真相），若没有它，"哪天有人把编辑 UI 的空态隐藏加回来"在
 * lint / tsc / check:solid / 其它测试**四层都看不见**。
 * ★ 将来真要改回去，**改这条测试就是一个显式动作**（口径同上面那条 `.cc-command-hint`）。
 */
describe('#266 刀5 · 空态只隐藏背景板与高度手柄，不隐藏编辑左列（CSS 侧守卫）', () => {
  it('空态作用域下带 `display:none` 的选择器一律不点名编辑 UI', () => {
    const hidden = emptyStateHiddenSelectors(chromeCss)
    // 前提可见：这两条隐藏**仍在**（否则下面的"没点名编辑 UI"会变成空断言）
    expect(hidden).toContain('.solid-workbench-control-center-slot.is-empty .cc-bg')
    expect(hidden).toContain('.solid-workbench-control-center-slot.is-empty .cc-edit-hdr')
    for (const selector of hidden) {
      expect(selector, `空态不得隐藏编辑 UI：${selector}`)
        .not.toMatch(/cc-edit-column|cc-edit-row|cc-edit-warning|cc-edit-toolbar|cc-prop-panel/)
    }
  })
})

/**
 * ★★ #266 CC-18 接续 · 空态与有会话**只认一个右侧原点**（CSS 侧守卫）。
 *
 * 为什么要有它：空态外框曾用 `margin:0` 把共享的 `margin-left/right` 整组清掉、又用 `width:100%`
 * 撑满容器 ⇒ 它的右缘落点**不是**「滚动条左缘」（有会话时才是），等于悄悄立了第二套横向原点。
 * 这类"覆盖式失效"没有任何一层能看见：lint / tsc / check:solid / 其它测试都不验真实布局，
 * jsdom 不加载样式表，`getComputedStyle` 拿不到真相（前件就是靠实机读数才发现）。
 * 判据：空态只清**纵向**边距，横向一律继承 `ControlCenter.css` 的共享算式
 * （边距仅 ccMarginX，原点来自左内容列）；空态不得另设右距或轨宽副本。
 * ★ 将来真要改回去，**改这条测试就是一个显式动作**（口径同上面 `.cc-command-hint` 那条）。
 */
describe('#266 CC-18 接续 · 空态与有会话统一右侧原点（CSS 侧守卫）', () => {
  const EMPTY_SLOT = '.solid-workbench-control-center-slot.is-empty'

  it('空态只清纵向边距：外框宽由共享横向边距推出，不再强制全宽、不再自设横向原点', () => {
    // 该选择器的**全部**声明块（不只第一块），且先剥注释——注释会提到被删掉的属性
    const block = allDeclarations(chromeCss.replaceAll(/\/\*[\s\S]*?\*\//g, ''), EMPTY_SLOT)
    expect(allDeclarations(chromeCss, '.solid-workbench-content-column')).toContain('position:relative')
    expect(block, '空态外框不再是绝对定位').toContain('position:absolute')
    expect(block, '空态外框不再靠两侧定位推出宽度').toContain('inset-inline:0')
    expect(block, '空态外框又被强制全宽了（宽度应交由共享横向边距推出）').toContain('width:auto')
    expect(block, '空态外框不再只清纵向边距').toContain('margin-block:0')
    // 禁：横向边距覆盖（含 margin 简写）/ 强制全宽 / 第二套原点（复制轨宽或再叠一层）
    for (const banned of ['margin:', 'margin-inline:', 'margin-inline-start:', 'margin-inline-end:', 'margin-left:', 'margin-right:', 'width:100%', '--scroll-action-rail-width']) {
      expect(block, `${EMPTY_SLOT} 又在自设横向原点（${banned}）`).not.toContain(banned)
    }
    expect(block).not.toMatch(/(?:^|;)(?:left|right|inset|inset-inline-start|inset-inline-end):/)
    expect([...block.matchAll(/(?:^|;)inset-inline:([^;]+)/g)].map(match => match[1])).toEqual(['0'])
    expect([...block.matchAll(/(?:^|;)width:([^;]+)/g)].map(match => match[1])).toEqual(['auto'])
  })

  it('轨宽只在共同两列布局消费，中控 margin 仅 M；空态内容轨道与纵向规则保留', () => {
    const shared = allDeclarations(controlCenterCss, '.control-center')
    expect(shared).toContain('margin-inline:var(--cc-margin-x,20px)')
    expect(controlCenterCss).not.toContain('--scroll-action-rail-width')
    const root = allDeclarations(chromeCss, '.solid-agent-workbench')
    expect(root).toContain('grid-template-columns:minmax(0,1fr)var(--scroll-action-rail-width)')
    const rail = allDeclarations(chromeCss, '.solid-workbench-scroll-rail')
    for (const declaration of ['grid-column:2', 'grid-row:1', 'position:relative', 'align-self:stretch', 'min-height:0', '--scroll-action-end-size:16px']) {
      expect(rail).toContain(declaration)
    }
    expect(rail).not.toMatch(/(?:^|;)inset:/)
    expect(allDeclarations(chromeCss, '.solid-workbench-chat-shell')).not.toContain('--scroll-action')
    expect(allDeclarations(chromeCss, '.solid-workbench-creation-overlay-host')).toContain('inset:0;')
    expect(chromeCss.replaceAll(/\/\*[\s\S]*?\*\//g, '')).not.toContain('--creation-overlay-right-inset')

    // 轨宽整张表只有 `:root` 两处**声明**（宽窗 12 / 窄屏 14）——空态不得再抄一份
    const stripped = chromeCss.replaceAll(/\/\*[\s\S]*?\*\//g, '')
    expect([...stripped.matchAll(/--scroll-action-rail-width:([^;}]+)/g)].map(m => m[1].replaceAll(/\s+/g, '')))
      .toEqual(['12px', '14px'])
    expect(stripped).toMatch(/:root\s*\{\s*--scroll-action-rail-width:\s*12px/)
    expect(stripped).toMatch(/:root\s*\{\s*--scroll-action-rail-width:\s*14px/)
    // 空态作用域下**没有任何**规则再消费轨宽（"第二套右距 / 原点"的结构性排除）
    expect(
      [...stripped.matchAll(/([^{}]*\.is-empty[^{}]*)\{([^{}]*)\}/g)]
        .filter(match => match[2].includes('--scroll-action-rail-width'))
        .map(match => match[1].trim()),
    ).toEqual([])

    // 空态保留项：纵向居中 + 内容上限 720 / 32 留白 + 内容居中（都按**新外框**可用宽度求值）
    const slot = allDeclarations(chromeCss, EMPTY_SLOT)
    expect(slot).toContain('top:50%')
    expect(slot).toContain('transform:translateY(-50%)')
    expect(slot).toContain('--cc-empty-content-width:min(720px,calc(100%-32px))')
    const body = allDeclarations(chromeCss, `${EMPTY_SLOT} .cc-body`)
    expect(body).toContain('width:var(--cc-empty-content-width)')
    expect(body).toContain('max-width:calc(100%-24px)')
    expect(body).toContain('margin-inline:auto')
  })
})

/** 空态作用域里带 `display:none` 的选择器（逐条拆开；先剥注释 —— 注释会提到被删的类名）。 */
function emptyStateHiddenSelectors(source: string): string[] {
  const stripped = source.replaceAll(/\/\*[\s\S]*?\*\//g, '')
  const selectors: string[] = []
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectorText, body] = match
    if (!selectorText.includes('.is-empty')) continue
    if (!/display:\s*none/.test(body)) continue
    selectors.push(...selectorText.split(',').map(part => part.trim()))
  }
  return selectors
}
