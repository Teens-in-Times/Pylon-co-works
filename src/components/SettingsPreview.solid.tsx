/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { useThemeStore } from '../domains/theme/themeStore'
import { resolveSpinnerFrames, resolveSpinnerMarker } from '../domains/chat/spinnerFrames'
import { Spinner, SpinnerSummary } from './ui/Spinner.solid.tsx'
import { resolveConnectorColor, type ToolConnectorStatus } from '../domains/tool/toolPresentation'
import { resolveToolIndicatorAssetForTone } from '../domains/chat/toolIndicatorAssets'
import { toCssBackgroundImage } from '../infrastructure/skin/backgroundImage'
import { THEME_DEFAULTS, THEME_SETTING_KEYS } from '../domains/theme/themeFieldDefs'
import { loadSettingsPreviewControlCenter, type SettingsPreviewControlCenterHandle } from '../renderers/solid-workbench/settingsPreviewControlCenterLoader.ts'

export interface SettingsPreviewProps { zone: string }

const PREVIEW_TOOLS = [
  { name: 'Read', input: 'src/main.ts', status: 'ok' },
  { name: 'Bash', input: 'npm run build', status: 'err' },
  { name: 'Edit', input: 'src/main.ts', status: 'run' },
] as const

/**
 * TemplateLibrary keeps its preview theme as inherited CSS variables.  The
 * Solid control-center root also emits CC surface/geometry variables inline, so
 * project those local values into its appearance snapshot before mount;
 * this preserves the existing local-preview ownership without touching the
 * global store.  Standalone settings previews have no template ancestor and
 * therefore continue to follow the live store exclusively.
 */
function localTemplateCcTheme(host: HTMLElement): Record<string, unknown> {
  const template = host.closest<HTMLElement>('.template-preview')
  if (!template) return {}
  const readNumber = (name: string): number | undefined => {
    const value = Number.parseFloat(template.style.getPropertyValue(name))
    return Number.isFinite(value) ? value : undefined
  }
  const overrides: Record<string, unknown> = {}
  const ccHeight = readNumber('--cc-height')
  const ccMarginX = readNumber('--cc-margin-x')
  const ccMarginBottom = readNumber('--cc-margin-bottom')
  const ccRadius = readNumber('--cc-radius')
  const ccSurfaceOpacity = readNumber('--cc-surface-opacity')
  const ccBg = template.style.getPropertyValue('--cc-bg').trim()
  const ccBgImage = template.style.getPropertyValue('--cc-bg-image').trim()
  const inputOffsetTop = readNumber('--cc-input-offset-top')
  const inputHeight = readNumber('--cc-input-height')
  const inputMarginX = readNumber('--cc-input-margin-x')
  const inputSurfaceOpacity = readNumber('--cc-input-surface-opacity')
  const inputRadius = readNumber('--cc-input-radius')
  const inputBorderWidth = readNumber('--cc-input-border-width')
  const inputBorderOpacity = readNumber('--cc-input-border-opacity')
  const inputFontSize = readNumber('--cc-input-font-size')
  const inputSurfaceBg = template.style.getPropertyValue('--cc-input-surface').trim()
  const inputBorder = template.style.getPropertyValue('--cc-input-border').trim()
  const inputText = template.style.getPropertyValue('--cc-input-text').trim()
  const inputPlaceholder = template.style.getPropertyValue('--cc-input-placeholder').trim()
  if (ccHeight !== undefined) overrides.ccHeight = ccHeight
  if (ccMarginX !== undefined) overrides.ccMarginX = ccMarginX
  if (ccMarginBottom !== undefined) overrides.ccMarginBottom = ccMarginBottom
  if (ccRadius !== undefined) overrides.ccRadius = ccRadius
  if (ccSurfaceOpacity !== undefined) overrides.ccSurfaceOpacity = ccSurfaceOpacity
  if (ccBg) overrides.ccBg = ccBg
  // Background-image is a logical value (not an ordinary numeric / color var),
  // so it is projected explicitly when a template supplies the corresponding
  // local custom property. A CSS `none` value explicitly clears an
  // inherited/global image rather than leaking it into this card.
  if (ccBgImage) overrides.ccBgImage = ccBgImage === 'none' ? '' : ccBgImage
  if (inputOffsetTop !== undefined) overrides.inputOffsetTop = inputOffsetTop
  if (inputHeight !== undefined) overrides.inputHeight = inputHeight
  if (inputMarginX !== undefined) overrides.inputMarginX = inputMarginX
  if (inputSurfaceOpacity !== undefined) overrides.inputSurfaceOpacity = inputSurfaceOpacity
  if (inputRadius !== undefined) overrides.inputRadius = inputRadius
  if (inputBorderWidth !== undefined) overrides.inputBorderWidth = inputBorderWidth
  if (inputBorderOpacity !== undefined) overrides.inputBorderOpacity = inputBorderOpacity
  if (inputFontSize !== undefined) overrides.inputFontSize = inputFontSize
  if (inputSurfaceBg) overrides.inputSurfaceBg = inputSurfaceBg
  if (inputBorder) overrides.inputBorder = inputBorder
  if (inputText) overrides.inputTextColor = inputText
  if (inputPlaceholder) overrides.inputPlaceholder = inputPlaceholder
  return overrides
}

/**
 * P52 D4：中控预览挂真实 SolidControlCenter（用户拍板弃静态占位）。
 * 经 loader（import.meta.glob）加载 .solid 挂载文件；主题经 store 订阅实时
 * 同步。加载失败回退静态 cc 壳（预览不因 Solid 面异常整页崩）。
 */
function PvSolidControlCenter() {
  let hostRef: HTMLDivElement | null = null
  const [failed, setFailed] = createSignal(false)
  onMount(() => {
    const host = hostRef
    if (!host) return
    let disposed = false
    let handle: SettingsPreviewControlCenterHandle | undefined
    let unsubscribeTheme: (() => void) | undefined
    // 模板卡片局部变量优先于全局 store（保留 A 系列"模板预览读取局部中控变量"能力）
    const themeSnapshot = () => ({
      ...THEME_DEFAULTS,
      ...Object.fromEntries(THEME_SETTING_KEYS.map(key => [key, useThemeStore.getState()[key]])),
      ...localTemplateCcTheme(host),
    }) as Parameters<NonNullable<typeof handle>['setTheme']>[0]
    void loadSettingsPreviewControlCenter()
      .then(({ mountSettingsPreviewControlCenter }) => {
        if (disposed) return
        handle = mountSettingsPreviewControlCenter(host)
        handle.setTheme(themeSnapshot())
        unsubscribeTheme = useThemeStore.subscribe(() => {
          handle?.setTheme(themeSnapshot())
        })
      })
      .catch(() => { if (!disposed) setFailed(true) })
    onCleanup(() => {
      disposed = true
      unsubscribeTheme?.()
      handle?.destroy()
    })
  })
  return (
    <Show when={!failed()} fallback={
      <div class="control-center" style={{ 'pointer-events': 'none' }} aria-label="中控预览占位">
        {/* ★ #238 刀3：占位结构随真实结构一起改 —— 原来的 `.cc-status-primary` /
            `-secondary` / `.cc-actions` 三个槽位类已随槽位层删除（不只删中间那一个，
            留着的两个会成为悬空类名）。 */}
        <div class="cc-input-slot" />
        <div class="cc-status-group" />
      </div>
    }>
      <div ref={el => { hostRef = el }} aria-label="Solid 中控预览" />
    </Show>
  )
}

/** SettingsPreview — 设置页实时预览画布（#515 Solid 实体）。DOM/class 契约：
 * div.set-preview-wrap > div.set-preview-frame（padding-bottom 定比撑高）>
 * div.set-preview-clip > div.set-preview-scaled（按容器宽/设计宽 scale）+
 * .set-preview-caption 示意标注。 */
export default function SettingsPreview(props: SettingsPreviewProps) {
  // React useState 惰性初始化 → Solid 信号直接求值（组件体只跑一次，无惰性必要）。
  const [dims, setDims] = createSignal({
    w: typeof window === 'undefined' ? 1200 : window.innerWidth,
    h: typeof window === 'undefined' ? 760 : window.innerHeight - 32,
  })
  const [wrapWidth, setWrapWidth] = createSignal(typeof window === 'undefined' ? 1200 : window.innerWidth)
  let wrapRef: HTMLDivElement | null = null

  onMount(() => {
    if (typeof window === 'undefined') return
    const update = () => setDims({ w: window.innerWidth, h: window.innerHeight - 32 })
    window.addEventListener('resize', update)
    onCleanup(() => window.removeEventListener('resize', update))
  })

  onMount(() => {
    const element = wrapRef
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWrapWidth(entry.contentRect.width)
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  const scale = createMemo(() => Math.min(1, wrapWidth() / dims().w))

  return (
    <div class="set-preview-wrap" ref={el => { wrapRef = el }}>
      <div class="set-preview-frame" style={{ height: '0', 'padding-bottom': `${(dims().h / dims().w) * 100}%` }}>
        <div class="set-preview-clip">
          <div class="set-preview-scaled" style={{ width: `${dims().w}px`, height: `${dims().h}px`, transform: `scale(${scale()})` }}>
            <PreviewApp zone={props.zone} />
          </div>
        </div>
      </div>
      {/* #116 子项 8：这一栏是缩放后的示意（实测 0.22 倍，正文折算约 2.8px），
          原标签只写「实时预览」，容易被当成可读内容——明确标注为示意。 */}
      <div class="set-preview-caption">{props.zone} · 示意图（{dims().w}×{dims().h} 按 {Math.round(scale() * 100)}% 缩放，非真实尺寸）</div>
    </div>
  )
}

function PreviewApp(props: { zone: string }) {
  // 订阅粒度：按字段独立 createZustandSignal（细粒度追踪，字段间互不牵连）。
  const rightBg = createZustandSignal(useThemeStore, s => s.rightBg)
  const rightBgImage = createZustandSignal(useThemeStore, s => s.rightBgImage)
  const rightWidth = createZustandSignal(useThemeStore, s => s.rightWidth)
  const rightTransparency = createZustandSignal(useThemeStore, s => s.rightTransparency)
  const rightBlur = createZustandSignal(useThemeStore, s => s.rightBlur)
  const rawConnectorMode = createZustandSignal(useThemeStore, s => s.toolConnectorMode)
  const rawConnectorColor = createZustandSignal(useThemeStore, s => s.toolConnectorColor)
  const connectorStyle = createZustandSignal(useThemeStore, s => s.toolConnectorStyle)
  const connectorWidth = createZustandSignal(useThemeStore, s => s.toolConnectorWidth)
  const connectorOpacity = createZustandSignal(useThemeStore, s => s.toolConnectorOpacity)
  const toolOk = createZustandSignal(useThemeStore, s => s.toolOk)
  const toolRun = createZustandSignal(useThemeStore, s => s.toolRun)
  const toolErr = createZustandSignal(useThemeStore, s => s.toolErr)

  const connectorMode = () => rawConnectorMode() || 'none'
  const connectorColor = () => rawConnectorColor() || 'rgba(0,0,0,0.12)'
  const previewConnectorColor = (status: ToolConnectorStatus) => resolveConnectorColor(
    connectorMode(),
    status,
    { toolOk: toolOk(), toolRun: toolRun(), toolErr: toolErr() },
    connectorColor(),
  )
  const z = (name: string): Record<string, string> =>
    props.zone === name ? { outline: '2px solid var(--accent,#3b82f6)', 'outline-offset': '-2px' } : {}

  return (
    <div class="pv-app" style={{ 'pointer-events': 'none' }}>
      <div class="titlebar" style={{ ...z('global'), 'WebkitAppRegion': 'no-drag' } as Record<string, string>}>
        <span class="titlebar-toggle">☰</span>
        <div class="titlebar-tabs">
          <button class="tab active">Peri</button>
          <button class="tab">Prism</button>
        </div>
      </div>

      <div class="layout" style={{ flex: '1', 'min-height': '0' }}>
        <aside class="sidebar" style={z('sidebar')}>
          {/* 预览跟着左栏模型走：模块区（常驻区块）+ 会话区，不再有互斥模式页签。 */}
          <div class="sidebar-modules">
            <For each={['定时', '自动化']}>{label => (
              <section class="sidebar-block" data-collapsed="true">
                <div class="sidebar-block-head">
                  <span class="sidebar-block-toggle" aria-hidden="true"><span class="sidebar-block-title">{label}</span></span>
                </div>
              </section>
            )}</For>
            <section class="sidebar-block" data-collapsed="false" data-always-open="true">
              <div class="sidebar-block-head"><span class="sidebar-block-toggle" aria-hidden="true"><span class="sidebar-block-title">会话</span></span></div>
              <div class="sidebar-block-body">
                <label class="session-module-search">
                  <span class="session-search-icon" aria-hidden="true">⌕</span>
                  <input class="session-search-input" placeholder="搜索会话" readOnly />
                </label>
                <div class="session-list">
                  <div class="group-header" style={{ display: 'block' }}>本地</div>
                  <For each={['会话 A', '会话 B', '会话 C']}>{(n, i) => (
                    <div class={`session-item ${i() === 0 ? 'active' : ''}`}>
                      <span class="session-dot" />
                      <span class="session-name">{n}</span>
                      <span class="session-tail"><span class="session-meta">刚刚</span></span>
                    </div>
                  )}</For>
                </div>
              </div>
            </section>
          </div>
          <div class="profile-bar"><span class="profile-avatar active">R</span><span class="profile-avatar">S</span></div>
        </aside>

        <div class="main" style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0' }}>
          <div class="main-body" style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-height': '0' }}>
            <div class="chat-view" style={z('chat')}>
              <div class="term">
                <div class="term-user"><PvUser /></div>
                <For each={PREVIEW_TOOLS}>{(tl, i) => {
                  const previous = PREVIEW_TOOLS[i() - 1]
                  const connectorStatus = previous?.status
                  return (
                    <div
                      class={`pv-tool-row pv-tool-connector-style--${connectorStyle() || 'solid'}`}
                      data-has-connector={connectorStatus ? 'true' : undefined}
                      style={{
                        '--pv-connector-color': connectorStatus ? previewConnectorColor(connectorStatus) : 'transparent',
                        '--pv-connector-width': `${Math.max(1, Math.min(6, connectorWidth() || 2))}px`,
                        '--pv-connector-opacity': String(Math.max(0.1, Math.min(1, connectorOpacity() ?? 1))),
                      }}
                    >
                      <div class="term-row term-row-tool"><PvTool name={tl.name} input={tl.input} status={tl.status} /></div>
                    </div>
                  )
                }}</For>
                <PvSpinner />
                <div class="term-assistant">
                  好的，我来分析一下。<code class="term-inline-code">main()</code> 里有一处类型错误需要修正。
                  <div class="term-code-block"><div class="term-code-line"><span class="term-code-gutter">│ </span><span>const result = await fetch(url)</span></div></div>
                </div>
              </div>
            </div>
            <div style={z('cc')}><PvSolidControlCenter /></div>
          </div>
        </div>

        <aside class="right-panel pv-right-panel" style={{
          '--right-bg': rightBg(),
          '--right-bg-image': toCssBackgroundImage(rightBgImage()),
          '--right-width': `${rightWidth()}px`,
          '--right-transparency': rightTransparency(),
          '--right-blur': `${rightBlur()}px`,
          ...z('right'),
        }}>
          <div class="right-header">
            <div class="right-tabs"><button class="right-tab active">工作区</button><button class="right-tab">日志</button></div>
            <button class="right-close" aria-label="关闭右栏">✕</button>
          </div>
          <div class="right-body"><div class="panel-status"><strong>工作区预览</strong><span>右栏主题实时预览</span></div></div>
        </aside>
      </div>
    </div>
  )
}

function PvUser() {
  const rawUserName = createZustandSignal(useThemeStore, s => s.userName)
  const rawPrefix = createZustandSignal(useThemeStore, s => s.userPrefix)
  const userColor = createZustandSignal(useThemeStore, s => s.userColor)
  const userName = () => rawUserName() || 'user'
  const prefix = () => rawPrefix() || '❯'
  const cs = () => userColor() ? { color: userColor()! } : undefined
  return <><span class="term-user-prefix" style={cs()}>{prefix()}</span><span class="term-user-name" style={cs()}>{userName()}</span><span>帮我检查一下这段代码</span></>
}

function PvSpinner() {
  const preset = createZustandSignal(useThemeStore, s => s.spinnerFramePreset)
  const customFrames = createZustandSignal(useThemeStore, s => s.spinnerCustomFrames)
  const doneMarker = createZustandSignal(useThemeStore, s => s.spinnerDoneMarker)
  const cancelledMarker = createZustandSignal(useThemeStore, s => s.spinnerCancelledMarker)
  const errorMarker = createZustandSignal(useThemeStore, s => s.spinnerErrorMarker)
  const doneMode = createZustandSignal(useThemeStore, s => s.spinnerDoneMarkerMode)
  const cancelledMode = createZustandSignal(useThemeStore, s => s.spinnerCancelledMarkerMode)
  const errorMode = createZustandSignal(useThemeStore, s => s.spinnerErrorMarkerMode)
  const spinnerSize = createZustandSignal(useThemeStore, s => s.spinnerSize)
  const frames = createMemo(() => resolveSpinnerFrames(preset(), customFrames()))
  // P52 D4：React GenerationFooter 已退役——预览用同一 resolveSpinnerMarker
  // 呈现三终态标记（终态文案契约由 Solid footer 测试锁定，此处仅视觉预览）。
  // #520 K 域：spinner/summary DOM 由 ui/Spinner 统一承载（本组件只做取数与标记解析）。
  const markers = [
    { reason: 'done', mode: doneMode, marker: doneMarker, label: '生成完毕' },
    { reason: 'cancelled', mode: cancelledMode, marker: cancelledMarker, label: '已停止' },
    { reason: 'error', mode: errorMode, marker: errorMarker, label: '处理失败' },
  ]
  return <>
    <Spinner frame={frames()[0]} size={spinnerSize()}>
      <span class="spinner-meta">(<span>3s</span>)</span>
    </Spinner>
    <For each={markers}>{item => (
      <SpinnerSummary reason={item.reason} marker={resolveSpinnerMarker(frames(), item.mode(), item.marker())} size={spinnerSize()}>
        {item.label} 3s
      </SpinnerSummary>
    )}</For>
    <span class="term-preview-spinner-markers" aria-hidden="true">
      {doneMode()}:{doneMarker()} {cancelledMode()}:{cancelledMarker()} {errorMode()}:{errorMarker()}
    </span>
  </>
}

function PvTool(props: { name: string; input: string; status: ToolConnectorStatus }) {
  const toolOk = createZustandSignal(useThemeStore, s => s.toolOk)
  const toolRun = createZustandSignal(useThemeStore, s => s.toolRun)
  const toolErr = createZustandSignal(useThemeStore, s => s.toolErr)
  const toolIndicator = createZustandSignal(useThemeStore, s => s.toolIndicator)
  const toolIndicatorRun = createZustandSignal(useThemeStore, s => s.toolIndicatorRun)
  const toolIndicatorOk = createZustandSignal(useThemeStore, s => s.toolIndicatorOk)
  const toolIndicatorErr = createZustandSignal(useThemeStore, s => s.toolIndicatorErr)
  const glow = createZustandSignal(useThemeStore, s => s.toolIndicatorGlow)
  const glowColor = createZustandSignal(useThemeStore, s => s.toolIndicatorGlowColor)
  const indicatorAsset = createMemo(() => resolveToolIndicatorAssetForTone(props.status, {
    toolIndicator: toolIndicator(), toolIndicatorRun: toolIndicatorRun(), toolIndicatorOk: toolIndicatorOk(), toolIndicatorErr: toolIndicatorErr(),
  }))
  const safeGlow = () => glow() || 0
  const safeGlowColor = () => glowColor() || ''
  const statusColor = () => props.status === 'ok' ? toolOk() : props.status === 'err' ? toolErr() : toolRun()
  const glowCss = () => safeGlow() > 0 ? { 'text-shadow': `0 0 ${safeGlow()}px ${safeGlowColor() || statusColor() || 'currentColor'}` } : undefined
  return <div class="term-tool" data-status={props.status}><div class="term-tool-head"><span class={`term-tool-indicator ${props.status}`} aria-label={indicatorAsset().ariaLabel[props.status === 'ok' ? 'completed' : props.status === 'err' ? 'failed' : 'running']} role="img" style={glowCss()}>{indicatorAsset().glyph}</span><span class="term-tool-name">{props.name}</span><span class="term-tool-summary term-tool-summary-code"> ({props.input})</span><Show when={props.status === 'ok'}><span class="term-tool-suffix"> — 12 lines</span></Show></div></div>
}
