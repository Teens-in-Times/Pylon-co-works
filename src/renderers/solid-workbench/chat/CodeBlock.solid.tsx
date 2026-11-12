/** @jsxImportSource solid-js */
import { Show, createEffect, createResource, createSignal, onCleanup, onMount, untrack } from 'solid-js'
import { findOversizeFoldPoint } from '../../../domains/rendererContent/textContentContracts.ts'
import { highlightCode } from '../../../domains/chat/codeHighlight.ts'
import { scheduleHighlightJob, trackCodeBlockVisibility } from './codeBlockDomLifecycle.ts'
import { createCopyFeedback } from '../../../utils/copyFeedback.ts'

export interface SolidCodeBlockProps {
  code: string
  language?: string
  /** 超过此行数折叠（默认 400）；折叠后完整文本仍可复制 */
  maxLines?: number
  onCopy?: (text: string) => void | Promise<void>
  showLanguage?: boolean
  showCopyButton?: boolean
  wrap?: 'soft' | 'none'
  palette?: string
}

/**
 * C00：content.code 的 Solid surface。
 * - 语言标签可见；未知语言回退 escaped plain text（高亮返回 null）；
 * - oversize 折叠在行边界，折叠提示明确，完整文本经 data-copy-text/onCopy 保留；
 * - copy 是显式用户动作，不自动执行。
 */
export function SolidCodeBlock(props: SolidCodeBlockProps) {
  const { copied, markCopied } = createCopyFeedback()
  const [copyError, setCopyError] = createSignal('')
  const [copying, setCopying] = createSignal(false)

  // #208：默认折叠保留（超大块不默认全渲，这是它存在的理由），但折叠不再是死路——
  // 「复制获取全部内容」是唯一出口时，长思考/长回答在界面上被静默截断，用户读不到。
  // 现在按**有界步长**增量展开：每次点击新增 ≤ 一个预算（maxLines 行量级）且仍在行边界停。
  const maxLines = () => props.maxLines ?? 400
  const foldBudget = () => maxLines() * 8
  const baseFold = () => findOversizeFoldPoint(props.code, foldBudget())
  const [extraChars, setExtraChars] = createSignal(0)
  const visibleLength = () => {
    const base = baseFold()?.visibleLength
    if (base === undefined) return props.code.length
    return Math.min(props.code.length, base + extraChars())
  }
  const visibleCode = () => props.code.slice(0, visibleLength())
  const lines = () => visibleCode().split('\n')
  const isMultiLine = () => lines().length > 1
  const remainingLines = () => Math.max(0, props.code.split('\n').length - lines().length)
  const folded = () => remainingLines() > 0
  const nextStepLines = () => Math.min(maxLines(), remainingLines())
  const showMore = () => {
    const rest = props.code.slice(visibleLength())
    const step = findOversizeFoldPoint(rest, foldBudget())
    setExtraChars(current => current + (step ? step.visibleLength : rest.length))
  }
  const collapse = () => setExtraChars(0)

  // #221：行 HTML 缓存 + 视口外降级（与 markdown 路径同一机制）。缓存键对齐
  // visibleCode 快照——#208 步进展开使代码前进时缓存失配，重取；过期在途结果丢弃。
  // 本路径 HTML 不经 sanitize（现状口径）。gated（宿主有 IntersectionObserver）时
  // 高亮改由观察器驱动：进圈才取、出圈降级、展开步进仅圈内重取；无观察器宿主
  // （测试/旧内核）保留 createResource 现状时序，行为逐字节不变。
  const gatedLifecycle = typeof IntersectionObserver !== 'undefined'
  const [lineHtmls, setLineHtmls] = createSignal<readonly string[] | null>(null)
  const [demoted, setDemoted] = createSignal(false)
  let highlightedFor: string | undefined
  let root: HTMLDivElement | undefined
  let releaseLifecycle: (() => void) | undefined
  let exited = false
  let disposed = false

  const requestHighlight = () => {
    if (!isMultiLine()) return
    const code = visibleCode()
    if (lineHtmls() !== null && highlightedFor === code) {
      setDemoted(false)
      return
    }
    highlightedFor = code
    const language = props.language || 'text'
    scheduleHighlightJob(async () => {
      const html = await highlightCode(language, code).catch(() => null)
      if (disposed || highlightedFor !== code) return
      setLineHtmls(html === null ? [] : html.split('\n'))
      if (!exited) setDemoted(false)
    })
  }

  createResource(
    () => !gatedLifecycle && isMultiLine() ? { language: props.language || 'text', code: visibleCode() } : undefined,
    input => highlightCode(input.language, input.code).catch(() => null).then(html => {
      if (disposed) return html
      setLineHtmls(html === null ? [] : html.split('\n'))
      if (!exited) setDemoted(false)
      return html
    }),
  )

  // 展开步进（visibleCode 前进）在圈内的重取；首跑只记账——首亮由观察器 onEnter 驱动，
  // 历史重放时圈外块因此根本不发起高亮（级联消失的根）。
  let lastTrackedCode: string | undefined
  createEffect(() => {
    if (!gatedLifecycle) return
    const code = visibleCode()
    const previous = lastTrackedCode
    lastTrackedCode = code
    untrack(() => {
      if (previous === undefined) return
      if (!isMultiLine() || exited) return
      if (lineHtmls() !== null && highlightedFor === code) return
      requestHighlight()
    })
  })

  onMount(() => {
    if (!gatedLifecycle || root === undefined) return
    const handle = trackCodeBlockVisibility(root, {
      onEnter: () => {
        exited = false
        requestHighlight()
      },
      onExit: () => {
        exited = true
        if (lineHtmls() !== null && (lineHtmls()?.length ?? 0) > 0) setDemoted(true)
      },
    })
    releaseLifecycle = handle?.release
  })
  onCleanup(() => {
    disposed = true
    releaseLifecycle?.()
  })

  const copy = async () => {
    if (copying()) return
    setCopying(true)
    setCopyError('')
    try {
      if (props.onCopy) await props.onCopy(props.code)
      else {
        if (!navigator.clipboard) throw new Error('剪贴板不可用')
        await navigator.clipboard.writeText(props.code)
      }
      if (!disposed) markCopied()
    } catch {
      if (!disposed) setCopyError('复制失败，请重试或选中代码复制。')
    } finally {
      if (!disposed) setCopying(false)
    }
  }

  return (
    <div ref={root} class="term-code-block" data-language={props.language ?? 'text'} data-folded={folded() ? 'true' : 'false'} data-wrap={props.wrap ?? 'soft'} data-palette={props.palette ?? 'auto'}>
      <Show when={props.showLanguage !== false || props.showCopyButton !== false}>
        <div class="term-code-head">
          <Show when={props.showLanguage !== false}><span class="term-code-lang">{props.language ?? 'text'}</span></Show>
          <Show when={props.showCopyButton !== false}><button
            type="button"
            class="term-code-copy"
            aria-label={copied() ? '已复制' : '复制代码'}
            data-copy-text={props.code}
            disabled={copying()}
            onClick={() => void copy()}
          >{copied() ? '✓' : '⎘'}</button></Show>
        </div>
      </Show>
      <Show when={copyError()}>{message => <div class="px-2 py-1 text-sm text-danger" role="status">{message()}</div>}</Show>
      <Show when={isMultiLine()} fallback={<code class="term-inline-code">{props.code}</code>}>
        <pre class="term-code-body" style={{ 'white-space': props.wrap === 'none' ? 'pre' : 'pre-wrap' }}><code>{lines().map((line, index) => (
          <span class="term-code-line">
            <span class="term-code-gutter" aria-hidden="true">│ </span>
            {/* R-B1 契约：每行内容 span 都带 term-code-text（长行软折与缩进保留挂在它上面）。
                此前回退/高亮两条分支都没带这个类——流式块自带该类，所以缺口只暴露在 code 部件路径上。 */}
            <Show
              when={demoted() ? undefined : lineHtmls()?.[index]}
              fallback={<span class="term-code-text">{line || '\u00a0'}</span>}
            >
              {html => <span class="term-code-text" innerHTML={html()} />}
            </Show>
            {'\n'}
          </span>
        ))}</code></pre>
      </Show>
      <Show when={folded()}>
        <div class="term-code-folded flex items-center flex-wrap gap-2 text-2xs" role="note">
          <span>{`已折叠 ${remainingLines()} 行`}</span>
          <button
            type="button"
            class="term-code-folded-more cursor-pointer rounded-sm px-1 text-accent hover:bg-hover-bg"
            aria-expanded={folded() ? 'false' : 'true'}
            onClick={showMore}
          >{`显示更多 ${nextStepLines()} 行`}</button>
          <Show when={extraChars() > 0}>
            <button
              type="button"
              class="term-code-folded-less cursor-pointer rounded-sm px-1 text-content-muted hover:bg-hover-bg"
              onClick={collapse}
            >收起</button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default SolidCodeBlock
