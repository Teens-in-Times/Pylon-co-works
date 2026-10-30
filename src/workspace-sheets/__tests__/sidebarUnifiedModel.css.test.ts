import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(p, 'utf8')
const appCss = read('src/plugins/product/packages/builtin.pylon-shell/styles/App.css')
const sidebarCss = read('src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css')
const overviewCss = read('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css')
const fileCss = read('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css')

/**
 * 取选择器列表中**恰好包含**该选择器的规则体。
 *
 * 先剥掉注释再切规则：选择器文本前面常紧跟注释，用 `[^{}]+` 直接吃选择器会把
 * 注释一起带进来而漏匹配；逗号列表（`A, B { … }`）也要按成员比对。
 */
function ruleBodies(css: string, selector: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  const re = /([^{}]+)\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(withoutComments)) !== null) {
    const selectors = match[1].split(',').map(s => s.trim())
    if (selectors.includes(selector)) out.push(match[2])
  }
  return out
}

/** 跨包扫描：任何文件里出现的规则文本（用于「退休 token 不得复活」的全文断言）。 */
const FIRST_PARTY_CSS = [
  appCss,
  sidebarCss,
  overviewCss,
  fileCss,
  read('src/plugins/product/packages/builtin.pylon-workspace/styles/SheetVocabulary.css'),
  read('src/plugins/product/packages/builtin.pylon-workspace/styles/adaptive.css'),
  read('src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css'),
  read('src/plugins/product/packages/builtin.pylon-shell/styles/components/SettingsCommon.css'),
  read('src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css'),
]

const RETIRED_WIDTH_TOKENS = [
  '--sheet-sidebar-width',
  '--workspace-sidebar-track-width',
  '--workspace-sidebar-collapsed-width',
  '--titlebar-sidebar-width',
]

// #154：左列曾经有「三套独立宽度 + 两套独立边框」，那是浏览器/Gateway 分割线
// 错位的结构性成因。这组断言把收敛后的模型静态钉住：宽度只有一个真值、分割线
// 只有一个所有者、折叠是布局层状态而不是各 Sheet 的私事。
describe('#154 左列统一模型 CSS 契约', () => {
  it('宽度只有 --sheet-sidebar-track-width 一个真值，且由 .sidebar 消费', () => {
    const body = ruleBodies(sidebarCss, '.sidebar')[0]
    expect(body, '缺少 .sidebar 规则').toBeTruthy()
    expect(body).toContain('--sheet-sidebar-track-width')
    for (const prop of ['width', 'min-width', 'max-width']) {
      expect(body, `.sidebar 的 ${prop} 必须取自唯一宽度真值`).toMatch(new RegExp(`${prop}:var\\(--sheet-sidebar-track-width`))
    }
  })

  it('四套旧宽度 token 在第一方 CSS 中彻底退役（复活 = 又出现第二条宽度来源）', () => {
    for (const css of FIRST_PARTY_CSS) {
      for (const token of RETIRED_WIDTH_TOKENS) {
        // 允许出现在 #154 的说明性注释里，但不允许出现在任何声明中。
        const inDeclaration = new RegExp(`${token}\\s*,?\\s*[0-9]`).test(css) || new RegExp(`:\\s*[^;\\n]*${token}`).test(css)
        expect(inDeclaration, `${token} 仍被声明消费`).toBe(false)
      }
    }
  })

  it('竖直分割线只有一个所有者：布局层的 .layout[data-sidebar="expanded"]::before', () => {
    expect(appCss).toMatch(/\.layout\[data-sidebar="expanded"\]::before\s*\{[^}]*background:var\(--border\)/)
    // 镜像（侧栏在右）时整条线换边，仍只有这一条。
    expect(appCss).toMatch(/\.app\[data-shell-sidebar-side="right"\] \.layout\[data-sidebar="expanded"\]::before\s*\{[^}]*right:calc\(/)
    // 折叠时整条线不画——这消灭了「标题栏留下 42px 悬空分割线」。
    expect(appCss).toMatch(/\.layout\[data-sidebar="collapsed"\] \.left-rail-resize-handle\s*\{\s*display:none/)
  })

  it('各 Sheet 的左栏 CSS 不再自画竖边框', () => {
    for (const selector of ['.overview-sidebar', '.file-sidebar']) {
      for (const body of ruleBodies(overviewCss + fileCss, selector)) {
        expect(body, `${selector} 不得自带竖边框`).not.toMatch(/border-right/)
      }
    }
  })

  it('折叠可见性是布局层状态，且会继承到所有后代（挡得住键盘焦点）', () => {
    const collapsedRules = ruleBodies(sidebarCss, '.layout[data-sidebar="collapsed"] .sidebar')
    const allCollapsed = collapsedRules.join('\n')
    expect(collapsedRules.length, '缺少折叠态规则').toBeGreaterThan(0)
    expect(allCollapsed).toContain('visibility:hidden')
    // 各 Sheet 左栏自带内边距（gateway/search/history 的 px-3 等）；
    // box-sizing:border-box 下即使 width:0，盒子也不会小于 padding 之和——实测
    // Gateway 折叠后残留 24px。折叠态必须把内边距一并归零，「折叠 = 0 宽」才成立。
    expect(allCollapsed, '折叠态未归零内边距 → 会残留 padding 宽度').toMatch(/padding:\s*0/)
    // visibility 会被后代的 `visibility:visible` 覆盖（本案元凶是已删除的 `.sidebar > *`），
    // 只写外壳会留下「看不见但可聚焦」的控件——实测 File 的 activity 按钮仍可 focus。
    const descendantGuard = ruleBodies(sidebarCss, '.layout[data-sidebar="collapsed"] .sidebar *')[0]
    expect(descendantGuard, '缺少后代可见性兜底规则').toBeTruthy()
    expect(descendantGuard).toContain('visibility:hidden')
    // 元凶本身不得复活。
    expect(sidebarCss, '.sidebar > * 的 visibility:visible 会覆盖继承，使折叠态控件仍可聚焦').not.toMatch(/\.sidebar > \* \{[^}]*visibility:visible/)
  })

  it('左列不显示自身滚动条（否则 4px gutter 紧贴分割线，看起来像线带了阴影）', () => {
    const body = ruleBodies(sidebarCss, '.sidebar')[0]
    expect(body).toContain('scrollbar-width:none')
    // webkit 侧的对应规则（与 .sheet-tab-strip 同一做法）。
    expect(sidebarCss).toMatch(/\.sidebar::-webkit-scrollbar\s*\{\s*display:\s*none/)
  })

  it('拖拽手柄按同一 token 定位，折叠时隐藏', () => {
    const body = ruleBodies(appCss, '.left-rail-resize-handle')[0]
    expect(body, '缺少 .left-rail-resize-handle 规则').toBeTruthy()
    expect(body).toContain('--sheet-sidebar-track-width')
    expect(body).toContain('col-resize')
    // 拖拽期间关过渡，否则每个 pointermove 的过渡互相打断会拖出尾迹。
    expect(appCss).toMatch(/\.layout\.is-resizing[^{]*\{[^}]*transition:none/)
  })

  it('折叠时标题栏左格留住按钮宽度（按钮位置前后不变，且不挤动右侧两簇）', () => {
    // 第 1 列 = max(轨道宽, 折叠按钮宽)：折叠态左格收窄到按钮宽度而不是 0，
    // 因此按钮停在最左、折叠前后 x 不变。
    expect(appCss).toMatch(/grid-template-columns:max\(var\(--sheet-sidebar-track-width,0px\),var\(--titlebar-rail-toggle-width\)\) minmax\(0,1fr\) auto/)
    expect(appCss).toMatch(/--titlebar-rail-toggle-width:\s*42px/)
    // 关键：左格不能用 display:none。标题栏是三列 grid，移除左格会让「右侧栏/界面/设置」
    // 与窗口控制这两个兄弟自动前移一列（实测菜单从 957/997/1037 → 4/44/84、
    // 窗口按钮 1086/1124/1162 → 133/171/209），即用户报的「折叠后菜单乱跳」。
    const collapsedCell = ruleBodies(appCss, '.workspace-titlebar:not(.sidebar-expanded) .workspace-titlebar-sidebar')[0]
    expect(collapsedCell, '缺少折叠态左格规则').toBeTruthy()
    expect(collapsedCell, '折叠态左格不得 display:none（会挤动右侧菜单与窗口控制）').not.toMatch(/display:\s*none/)
    expect(collapsedCell, '折叠态左格不得把宽度归零（按钮会失去位置）').not.toMatch(/(^|;)\s*(width|max-width)\s*:\s*0/)
  })

  it('折叠态只隐藏三灯，不隐藏按钮', () => {
    const collapsedBrand = ruleBodies(appCss, '.workspace-titlebar:not(.sidebar-expanded) .workspace-titlebar-brand')[0]
    expect(collapsedBrand, '缺少折叠态三灯规则').toBeTruthy()
    expect(collapsedBrand).toMatch(/display:\s*none/)
  })
})

// 现代模式的卡片装饰（描边/圆角/底色/投影）声明在 #154 折叠归零规则之后，同特异性
// 下后者胜，若不显式复位，0 宽轨道仍会占 2px 描边宽度；`.layout` 的 flex gap 也会为
// 折叠轨道留一份空档。这组断言把「折叠 = 真正 0 占位」钉住。
describe('现代模式轨道折叠几何契约', () => {
  const modernCollapsedSidebar = () => ruleBodies(
    sidebarCss,
    '.app[data-interface-mode="modern-gui"] .layout[data-sidebar="collapsed"] > .sidebar',
  )[0]

  it('折叠的左栏复位卡片装饰并吃掉 flex gap', () => {
    const body = modernCollapsedSidebar()
    expect(body, '缺少现代模式折叠左栏规则').toBeTruthy()
    expect(body).toMatch(/border:\s*0/)
    expect(body).toMatch(/box-shadow:\s*none/)
    expect(body).toMatch(/background:\s*transparent/)
    expect(body).toContain('margin-inline-end:calc(-1 * var(--rail-gap')
  })

  it('侧栏在右时镜像负外边距（负值必须落在朝主区的一侧）', () => {
    const mirror = ruleBodies(
      sidebarCss,
      '.app[data-interface-mode="modern-gui"][data-shell-sidebar-side="right"] .layout[data-sidebar="collapsed"] > .sidebar',
    )[0]
    expect(mirror, '缺少侧栏在右的折叠镜像规则').toBeTruthy()
    expect(mirror).toContain('margin-inline-start:calc(-1 * var(--rail-gap')
    expect(mirror).toContain('margin-inline-end:0')
  })

  it('现代模式不再画 #154 贯穿线（卡片边框已是分栏边界）', () => {
    // 贯穿线按轨道宽定位，卡片有 8px 布局内边距 ⇒ 线会落在卡片内部（实测 left:249 / 卡片右缘 258）。
    expect(sidebarCss).toMatch(/\.app\[data-interface-mode="modern-gui"\] \.layout\[data-sidebar="expanded"\]::before\s*\{\s*display:none/)
  })

  it('折叠的右栏同样吃掉 flex gap（默认与侧栏在右两种形态）', () => {
    const body = ruleBodies(appCss, '.app[data-interface-mode="modern-gui"] .layout > .right-rail-host.is-collapsed')[0]
    expect(body, '缺少现代模式折叠右栏规则').toBeTruthy()
    // 与左栏归零共用 `--rail-gap`：span gap 若被改，折叠补偿跟着变，不会留第二份真值。
    expect(body).toContain('margin-inline-start:calc(-1 * var(--rail-gap')
    const mirror = ruleBodies(
      appCss,
      '.app[data-interface-mode="modern-gui"][data-shell-sidebar-side="right"] .layout > .right-rail-host.is-collapsed',
    )[0]
    expect(mirror, '缺少侧栏在右的折叠右栏镜像规则').toBeTruthy()
    expect(mirror).toContain('margin-inline-end:calc(-1 * var(--rail-gap')
  })
})
