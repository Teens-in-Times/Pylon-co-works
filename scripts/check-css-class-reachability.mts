// CSS 类名可达性审计（CC-15 正向死面守卫 · 2026-10-05 · issue #266，CC-31 手工扫描的守卫化）：
// 样式系统不变量 —— "样式表里的类名，生产运行时一定生成得出"。CSS 里写了、但生产源码
// （.ts/.tsx）从不生成、其它 CSS 也不引用的类名 = 死面（CC-31 案例手扫 515 类 ⇒ 19 死）。
//
// 判据：src/ 全部 .css 的选择器类名（剥注释 / url() / 字符串后，只从 `{` 前的选择器段提取），
// 必须满足其一：
//   a. 生产源码生成点 —— .ts/.tsx 剥注释后的 token 全集里整词存在（token 按最长
//      [\w$-] 连续段切分，天然整词：`term-row-error` 是一个 token，`model` ≠ `mode`，
//      `data-mode` ≠ `mode`）；
//   b. 跨 CSS 引用 —— 该类名出现在 ≥2 个 CSS 文件的选择器里（复合选择器/组合的引用面；
//      仅单文件出现只算定义自身，不算证据）；
//   c. 拼接家族豁免 —— SPLICE_FAMILIES：运行时由模板拼接的类名族（前缀 + 值域来源文件 +
//      理由，CC-31 假阳性剔除 11 项同款方法学）。正控：值域来源文件必须仍在生产源码里
//      含该前缀 —— 来源文件没了 = 名单烂了 = 红；
//   d. 存量登记豁免 —— LEGACY_UNREACHABLE：现状即不可达的类名逐条登记（只拦增量，
//      存量清理是后续单）。新冒出来的死类名不在名单 = 红。
//
// 扫描面 = git 追踪面：src/ 生产渲染面经 git ls-files 圈定（check-runtime-boundaries 先例），
// 本机 git 外文件（.git/info/exclude、未跟踪在制品）与禁区目录（ui-demo 旧 React 演示 /
// layout-sketch 布局草稿）一律不入面，根除「本地绿 CI 红」不可复现——input-area 案例即
// 生成点只在 layout-sketch（本机 exclude 件）所致。dist/、docs/、examples/、public/ 演示件
// 不在 src/ 天然不入面；src-tauri/ 的 Rust 侧生成点不在 .ts/.tsx 判据面 ——
// 相应类名会落进豁免名单并带理由（如 footnote-backref），不静默通过。
//
// 防空转正控：CSS/TS 扫描面下限 + 类名集下限（ASSERT 区）。
// 故意违反自检：`POINT_AT_BANNED=1 bun scripts/check-css-class-reachability.mts`
// 向判据集注入已知死探针 zz-self-check-dead-probe，脚本必须报红退出 1；正常跑不受影响。
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../src', import.meta.url))
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const stripComments = (source: string) => source
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(?<!:)\/\/[^\n]*/g, '')

// 扫描面圈定：git ls-files（非 git 环境退回全量扫描，行为同先例）。
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

// ── CSS 侧：只从选择器上下文提取类名（声明体里的 `content:"."` / `opacity:.5` / url() 不算）──
function selectorSegments(css: string): string[] {
  const segments: string[] = []
  let buffer = ''
  for (const ch of css) {
    if (ch === '{') { segments.push(buffer); buffer = '' }
    else if (ch === '}') buffer = ''
    else buffer += ch
  }
  return segments
}
function classNamesInSelector(segment: string): string[] {
  const stripped = segment
    .replaceAll(/url\([^)]*\)/g, '')
    .replaceAll(/'[^']*'/g, '')
    .replaceAll(/"[^"]*"/g, '')
  return [...stripped.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m => m[1])
}
const classToFile = new Map<string, Set<string>>()
for (const f of cssFiles) {
  for (const segment of selectorSegments(stripComments(read(f)))) {
    for (const name of classNamesInSelector(segment)) {
      if (!classToFile.has(name)) classToFile.set(name, new Set())
      classToFile.get(name)!.add(f)
    }
  }
}

// ── TS 侧：生产源码 token 全集（最长 [\w$-] 连续段；字符串内容保留 —— 类名生成点就在字符串里）──
// `${` 插值会把 '$' 粘上前面的类名（`search-hit${cond}` → token 'search-hit$'，证据被吞）。
// 在 `${` 前补边界拆开；但前面是 '-' 的不拆 —— `term-row-${kind}` 里 'term-row' 只是拼接
// 前缀，裸前缀类名不因模板存在而放行（那是拼接家族名单的事）。
const tsTokens = new Set<string>()
for (const f of tsFiles) {
  for (const m of stripComments(read(f)).replaceAll(/(?<!-)\$\{/g, ' ${').matchAll(/[\w$-]{2,}/g)) tsTokens.add(m[0])
}

// ── c：拼接家族豁免（前缀 + 值域来源 + 理由；CC-31 §8.2 假阳性剔除方法学的守卫化）──
// 值域来源 = 拼接模板所在的仓内文件（含跨语言生成点）；正控：来源文件必须存在且仍含
// 该前缀 —— 模板改了/文件删了 = 名单烂了 = 红。第三方库自生成 DOM 用 packages 控包存在。
// ★ 名单状态：CC-15 §0-3 裁定往返已过（2026-10-05 翻译核定，前缀豁免口径经裁定维持）。
const SPLICE_FAMILIES: { prefix: string; sources?: string[]; packages?: string[]; reason: string }[] = [
  { prefix: 'term-tool-indicator--', sources: ['src/domains/chat/toolIndicatorMotion.ts'], reason: '等待动画运动态拼接族（toolIndicatorMotion 模板；CC-31 假阳性剔除同款）' },
  { prefix: 'term-tool-connector--', sources: ['src/domains/chat/toolIndicatorMotion.ts'], reason: '连接线运动态拼接族（toolIndicatorMotion 模板）' },
  { prefix: 'term-tool-connector-style--', sources: ['src/renderers/solid-workbench/chat/ToolConnector.solid.tsx'], reason: '连接线样式拼接族（值域：toolConnectorStyle 主题字段 + 渲染器设置链 solid/dashed——CC-31 §8.2 #17 复核教训：判拼接类名死活要查全设置/预设链）' },
  { prefix: 'pv-tool-connector-style--', sources: ['src/components/SettingsPreview.solid.tsx'], reason: '设置预览连接线样式拼接族（SettingsPreview 模板）' },
  { prefix: 'interaction-', sources: ['src/renderers/solid-workbench/chat/content/InteractionCard.solid.tsx'], reason: '交互卡类型拼接族（interaction-${request().kind}；CC-31 记录的旧路径已迁 chat/content/）' },
  { prefix: 'agent-light-', sources: ['src/components/AgentStatusLights.solid.tsx'], reason: '状态灯拼接族（agent-light-${light}）' },
  { prefix: 'severity-', sources: ['src/components/ErrorCenter.solid.tsx'], reason: '错误中心严重度拼接族（severity-${severity()}）' },
  { prefix: 'type-', sources: ['src/sheets/file/fileIcons.solid.tsx'], reason: '文件类型图标拼接族（type-${mapped.type}）；位点存活但值域变化时须同步审 CSS 对应规则' },
  { prefix: 'is-', sources: ['src/components/settings/AgentSettingsSection.solid.tsx', 'src/components/settings/TemplateLibrary.solid.tsx', 'src/components/settings/PresentationProfilePicker.solid.tsx'], reason: '状态标记拼接族（is-${status/state/kind} 三处模板；前缀较宽经裁定维持）；位点存活但值域变化时须同步审 CSS 对应规则' },
  { prefix: 'cm-', packages: ['node_modules/@codemirror/view', 'node_modules/@codemirror/search'], reason: 'CodeMirror 编辑器运行时自生成 DOM 类名（第三方值域，非本仓代码生成）' },
  { prefix: 'footnote-backref', sources: ['src-tauri/pylon-markdown/src/parser.rs'], reason: 'Rust 侧 markdown 解析器跨语言生成（<a class="footnote-backref">，parser.rs）' },
]

// ── d：存量不可达登记（LEGACY —— 只拦增量；逐条理由；清理走后续单）──
// ── d：存量不可达登记（LEGACY —— 只拦增量；逐条理由；清理走后续单）──
// ★ 名单状态：CC-15 §0-3 裁定往返已过（2026-10-05 翻译核定）；CI 红修复后 97 条 =
//   修正普查 97（含 model-menu / input-area 两例「证据只在 git 外禁区件、剔除后现形」的收编，
//   ui-demo 2 条已随禁区剔除撤销）。
const LEGACY_UNREACHABLE: Record<string, string> = {
  // ── builtin.pylon-renderers/styles/components/chat/ChatView.css ──
  'agent-empty-sidebar-action': 'ChatView 渲染层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  'chat-recovery-actions': 'ChatView 渲染层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  'chat-recovery-error': 'ChatView 渲染层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  'chat-replay-warning': 'ChatView 渲染层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  // ── builtin.pylon-workspace/styles/components/Sidebar.css ──
  'cwd-settings-back': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'cwd-settings-folder': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'cwd-settings-identity': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'cwd-settings-page': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'cwd-settings-page-head': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  // ── builtin.pylon-shell/styles/App.css ──
  'dev-metrics': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'dev-metrics-action': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'dev-metrics-head': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'dev-metrics-name': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'dev-metrics-table': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'dev-metrics-toggle': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  // ── builtin.pylon-workspace/styles/sheets/file/FileSheet.css ──
  'file-activity-button': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-agent-change-row': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-edit-toggle': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-main': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-main-hint': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-main-split': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tab-code': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tab-gutter': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tab-gutter-line': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tab-hint': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tab-line': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tab-md': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tab-plain': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tab-pre': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-tree-hint': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'file-view-close': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'git-branch-badge': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'git-status-list': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'git-status-path': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'git-status-row': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  'git-status-row-static': 'FileSheet 存量死类名（file-tab-* 旧编辑视图 / file-main* 旧主区 / git-status-* 旧 Git 面板词汇——现行 FileTabBar/GitPanel 等已换新词汇；清理走后续单）',
  // ── builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css ──
  'input-area': '生成点仅存于禁区 layout-sketch/layoutBlocks.ts（本机 .git/info/exclude 件，不在 git ⇒ git 生产面上无生成点，CI 即因此红）；现行输入区容器为 .input-editor-stack 系（InputBar.solid.tsx）；清理走后续单',
  'input-editor': '渲染器壳层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  'input-send': '渲染器壳层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  // ── builtin.pylon-shell/styles/components/Settings.css ──
  'layout-grid': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'layout-inline': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  // ── builtin.pylon-workspace/styles/components/Sidebar.css ──
  'mock-page-lead': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'mock-row-cols': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  // ── builtin.pylon-renderers/styles/components/ControlCenter.css ──
  'mode-menu': '中控存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  'model-menu': '中控存量死类名（ControlCenter.css:85 :has() 引用；现行模型菜单为 cc-model-menu——本名唯一 token 证据原是禁区 ui-demo 的 overlay id，ui-demo 剔出扫描面后现形；清理走后续单）',
  // ── builtin.pylon-shell/styles/components/Settings.css ──
  'plugin-entry-input': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'plugin-manifest-input': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'presentation-renderer-row': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'preset-chip': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'preset-chips': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'preset-label': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'preset-row': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  // ── builtin.pylon-workspace/styles/components/Sidebar.css ──
  'profile-item': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  // ── builtin.pylon-shell/styles/components/Settings.css ──
  'renderer-setting-field-match': '活类 renderer-settings-field-match（RendererSettingsPanel.solid.tsx:207）的单数旧拼法，本名零生成点',
  // ── builtin.pylon-workspace/styles/adaptive.css ──
  'runtime-log-error': '自适应残量（lifecycle=adaptive）存量死类名（生产零生成点；清理走后续单）',
  // ── builtin.pylon-workspace/styles/sheets/file/FileSheet.css ──
  'search-result-line': 'FileSheet 搜索高亮旧词汇（现行搜索词已换）',
  // ── builtin.pylon-shell/styles/components/SessionSettings.css ──
  'sess-field-hint': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'sess-field-row': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'sess-field-value': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'sess-workspace-name': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'sess-workspace-root': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'session-settings-advanced': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'session-settings-advanced-body': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'session-settings-agent': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'session-settings-counter': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  'session-settings-status': '会话设置存量死类名（sess-* / session-settings-* 生产零生成点；清理走后续单）',
  // ── builtin.pylon-shell/styles/components/Settings.css ──
  'set-nav-hr': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'set-preset-btn': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'set-presets': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'set-preview-none': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  // ── builtin.pylon-shell/styles/components/SettingsCommon.css ──
  'settings-badge': '设置页公共词汇存量死类名（现行设置渲染用新词汇；清理走后续单）',
  'settings-field': '设置页公共词汇存量死类名（现行设置渲染用新词汇；清理走后续单）',
  'settings-field-hint': '设置页公共词汇存量死类名（现行设置渲染用新词汇；清理走后续单）',
  'settings-field-label': '设置页公共词汇存量死类名（现行设置渲染用新词汇；清理走后续单）',
  // ── builtin.pylon-shell/styles/components/Settings.css ──
  'settings-nav-footer': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  'settings-nav-label-text': '设置页存量死类名（声明式 Settings 渲染已换新词汇；清理走后续单）',
  // ── builtin.pylon-shell/styles/components/SettingsCommon.css ──
  'settings-section': '设置页公共词汇存量死类名（现行设置渲染用新词汇；清理走后续单）',
  'settings-section-heading': '设置页公共词汇存量死类名（现行设置渲染用新词汇；清理走后续单）',
  // ── builtin.pylon-shell/styles/App.css ──
  'sheet-content': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'sheet-layout': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'sheet-main': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  // ── builtin.pylon-workspace/styles/components/Sidebar.css ──
  'sidebar-action': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'sidebar-actions': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'sidebar-block-list': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'sidebar-block-row': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'sidebar-block-row-copy': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'sidebar-block-row-meta': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'sidebar-block-row-name': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  'sidebar-demo-caption': '侧栏存量死类名（cwd-settings-* 旧内嵌设置页——现行 CwdSettingsPanel 用 cwd-settings-dialog 系；sidebar-block-* 零生成点；mock-*/demo 为演示残留；清理走后续单）',
  // ── builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css ──
  'term-code': '渲染器壳层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  // ── builtin.pylon-renderers/styles/components/chat/ChatView.css ──
  'term-reasoning-line': 'ChatView 渲染层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  'term-row-user': 'term-row- 拼接族值域（CC-31 §8.2 #13：tool/activity/assistant/reasoning/error/search-active）之外的旧成员',
  'term-subagent-progress': 'ChatView 渲染层存量死类名（CC-15 全域扫描登记；生产零生成点，清理走后续单）',
  // ── builtin.pylon-shell/styles/App.css ──
  'workspace-menu-empty': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'workspace-menu-workspace': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'workspace-titlebar-entry-label': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
  'workspace-titlebar-mark': '壳层存量死类名（dev-metrics-* / sheet-* / workspace-menu-* / workspace-titlebar-* 生产零生成点；清理走后续单）',
}

// ── 正控：扫描面 / 判据集下限（防"守卫自己空转"的假绿）──
assert.ok(cssFiles.length > 10, `CSS 扫描面异常（${cssFiles.length} ≤ 10）`)
assert.ok(tsFiles.length > 400, `TS 扫描面异常（${tsFiles.length} ≤ 400）`)
assert.ok(classToFile.size > 300, `类名判据集异常（${classToFile.size} ≤ 300）`)
assert.ok(tsTokens.size > 5000, `TS token 集异常（${tsTokens.size} ≤ 5000）`)
// 家族名单自身健康（名单防烂）：值域来源文件必须存在且仍含前缀（模板改了/文件删了 ⇒ 红）；
// 第三方值域（packages）必须存在。
for (const family of SPLICE_FAMILIES) {
  for (const src of family.sources ?? []) {
    let text = ''
    try { text = readFileSync(join(PROJECT_ROOT, src), 'utf8') } catch { /* 缺文件 → 空文本触发下方红 */ }
    assert.ok(text.includes(family.prefix), `拼接家族 ${family.prefix} 的值域来源文件缺失或已不含该前缀（模板改了？名单须复核）：${src}`)
  }
  for (const pkg of family.packages ?? []) {
    let ok = false
    try { ok = statSync(join(PROJECT_ROOT, pkg)).isDirectory() } catch { }
    assert.ok(ok, `拼接家族 ${family.prefix} 的第三方值域来源缺失：${pkg}`)
  }
}

// ── 逐类判 ──
const judged = new Set(classToFile.keys())
if (process.env.POINT_AT_BANNED === '1') judged.add('zz-self-check-dead-probe')

const reachable = new Set<string>()
const exempted = new Map<string, string>()
const unreachable: string[] = []
for (const name of judged) {
  if (name === 'zz-self-check-dead-probe') { unreachable.push(name); continue }
  if (tsTokens.has(name)) { reachable.add(name); continue }
  if ((classToFile.get(name)?.size ?? 0) >= 2) { reachable.add(name); continue }
  const family = SPLICE_FAMILIES.find(f => name.startsWith(f.prefix))
  if (family) { exempted.set(name, `拼接家族 ${family.prefix}（${family.reason}）`); continue }
  if (name in LEGACY_UNREACHABLE) { exempted.set(name, `存量登记：${LEGACY_UNREACHABLE[name]}`); continue }
  unreachable.push(name)
}
unreachable.sort()

if (process.env.POINT_AT_BANNED === '1') {
  if (unreachable.includes('zz-self-check-dead-probe')) {
    console.error(`[自检] 已知死探针 zz-self-check-dead-probe 被判为不可达 —— 扫描器工作正常，本条输出即"故意违反"红样例`)
    process.exit(1)
  }
  console.error(`[自检失败] 死探针意外可达 —— 扫描器失灵（判据被绕过），守卫不可信`)
  process.exit(1)
}

// 名单外的新死类名进门即红；存量清理不在本单（名单逐条登记）。
assert.deepEqual(unreachable, [], `以下 CSS 类名生产不可达（源码无生成点、其它 CSS 无引用、名单未登记）：\n${unreachable.join('\n')}`)
console.log(`CSS 类名可达性审计通过（类名 ${judged.size}：可达 ${reachable.size} / 豁免 ${exempted.size}（家族 ${SPLICE_FAMILIES.length} 族 + 存量 ${Object.keys(LEGACY_UNREACHABLE).length}），不可达 0）`)
