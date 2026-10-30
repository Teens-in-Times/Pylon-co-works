export const FIRST_PARTY_STYLE_OWNERS = [
  'kernel',
  'builtin.pylon-shell',
  'builtin.pylon-workspace',
  'builtin.pylon-renderers',
  'builtin.pylon-plugin-manager',
  'builtin.pylon-gateway',
  'solid-smoke',
] as const

export type FirstPartyStyleOwner = typeof FIRST_PARTY_STYLE_OWNERS[number]

export const FIRST_PARTY_STYLE_LIFECYCLES = [
  'kernel-static',
  'plugin-scope',
  // 样式绞杀地基 20260914：每包至多一个自适应残量样式（mode/媒体查询/
  // 动效/:has() 专用），?inline 随插件生命周期回收，其余样式一律 utilities。
  'adaptive',
  // 解耦评估批 1（P93）：跨 sheet 共享词汇基线（file-main-*/search-result-*/
  // file-section-* 等，消费方矩阵见解耦评估报告），作为底座豁免保留。
  'shared',
  'smoke-only',
] as const

export type FirstPartyStyleLifecycle = typeof FIRST_PARTY_STYLE_LIFECYCLES[number]

export interface FirstPartyStyleOwnershipEntry {
  readonly path: string
  readonly owner: FirstPartyStyleOwner
  readonly lifecycle: FirstPartyStyleLifecycle
  readonly importers: readonly string[]
  readonly note?: string
}

const entry = (
  path: string,
  owner: FirstPartyStyleOwner,
  lifecycle: FirstPartyStyleLifecycle,
  importers: readonly string[],
  note?: string,
): FirstPartyStyleOwnershipEntry => Object.freeze({
  path,
  owner,
  lifecycle,
  importers: Object.freeze([...importers]),
  ...(note ? { note } : {}),
})

const SHELL_STYLE_ASSETS = 'src/plugins/product/packages/builtin.pylon-shell/styleAssets.ts'
const WORKSPACE_STYLE_ASSETS = 'src/plugins/product/packages/builtin.pylon-workspace/styleAssets.ts'
const RENDERER_STYLE_ASSETS = 'src/plugins/product/packages/builtin.pylon-renderers/styleAssets.ts'
const GATEWAY_STYLE_ASSETS = 'src/plugins/product/packages/builtin.pylon-gateway/styleAssets.ts'

/**
 * 第一方 CSS 的唯一 ownership 真值。
 *
 * Kernel 继续由入口静态持有 Recovery 所需基线；产品 CSS 已迁入对应第一方包，
 * 只由 styleAssets `?inline` 读取，并在插件激活时交给 PluginScope 挂载和回收。
 */
export const FIRST_PARTY_STYLE_OWNERSHIP: readonly FirstPartyStyleOwnershipEntry[] = Object.freeze([
  entry(
    'src/index.css',
    'kernel',
    'kernel-static',
    ['src/main.solid.tsx', 'src/renderers/solid-workbench/smoke/mountSolidRichQa.solid.tsx'],
    'React Root、基础 token、跨 Application scheme、Recovery 与 Rich QA 基线',
  ),
  entry(
    'src/styles/tailwind.css',
    'kernel',
    'kernel-static',
    ['src/main.solid.tsx', 'src/renderers/solid-workbench/smoke/mountSolidRichQa.solid.tsx'],
    'Tailwind v4 utilities 基线：@theme inline 只读消费 index.css token；无 preflight（TW 施工书 20260914）',
  ),
  // #491 绞杀恢复批：SkinPreviewBar.css 已整文件绞杀进 utilities 层，不再登记。

  entry('src/plugins/product/packages/builtin.pylon-shell/styles/App.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/SettingsCommon.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),

  entry('src/plugins/product/packages/builtin.pylon-gateway/styles/adaptive.css', 'builtin.pylon-gateway', 'adaptive', [GATEWAY_STYLE_ASSETS], 'gateway 包自适应残量：modern-gui 覆写 + status-pulse 动画（绞杀 P93 批 3）'),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/adaptive.css', 'builtin.pylon-workspace', 'adaptive', [WORKSPACE_STYLE_ASSETS], 'workspace 包自适应残量：history/search/browser/runtime 的 mode 覆写与变量残量（绞杀 P93 批 2/4）'),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/components/right-panel/ContextPanel.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/SheetVocabulary.css', 'builtin.pylon-workspace', 'shared', [WORKSPACE_STYLE_ASSETS], '解耦评估批 2（issue #83）：file-main-*/file-section-title/hint/search-result-list/row/path/text、file-tree-error 跨 sheet 共享词汇基线，自 FileSheet.css 剥出并压平（消费方 BrowserSheet/SearchSheet/GatewaySheet/ContextPanel/TemplateLibrary 及 file 域内部）'),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS], 'file 域内部样式：tree/tab/CodeMirror/git/dispatch；共享词汇已剥至 SheetVocabulary.css（issue #83）'),

  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.modern.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS], '#699：modern-gui 模式的消息层覆写（分组间距/气泡/工具卡/附件 chip），全部选择器限定 data-interface-mode'),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/adaptive.css', 'builtin.pylon-renderers', 'adaptive', [RENDERER_STYLE_ASSETS], '渲染包自适应残量：reduced-motion 通用后代规则（绞杀地基 20260914）'),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/StatusBar.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS], 'Solid 工作台壳层：suite 挂载几何 + 生产中控槽位'),

  // 第 6 包（P53 D2）的 framework-free 面板样式已由 J 施工书 20260914 绞杀进
  // utilities 层：owner 保留在名单里，但名下暂无 CSS 文件。


  entry('src/renderers/solid-workbench/smoke/solidWorkbenchSmoke.css', 'solid-smoke', 'smoke-only', [
    'src/renderers/solid-workbench/smoke/browserSmoke.solid.tsx',
    'src/renderers/solid-workbench/smoke/mountSolidWorkbenchSmoke.solid.tsx',
  ]),
])

export function listFirstPartyStylesByOwner(owner: FirstPartyStyleOwner): readonly FirstPartyStyleOwnershipEntry[] {
  return FIRST_PARTY_STYLE_OWNERSHIP.filter(item => item.owner === owner)
}
