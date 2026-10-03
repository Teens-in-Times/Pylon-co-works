/** @jsxImportSource solid-js */
import { Dynamic } from 'solid-js/web'
import { For, Index, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, untrack, type JSX } from 'solid-js'
import { highlightCode } from '../../../domains/chat/codeHighlight.ts'
import { sanitizeHtml } from '../../../domains/chat/htmlSanitizer.ts'
import { isPlainTextContent } from '../../../domains/chat/markdownFastPath.ts'
import { scheduleHighlightJob, trackCodeBlockVisibility } from './codeBlockDomLifecycle.ts'
import {
  getMarkdownRenderModel,
  peekMarkdownRenderModel,
  type MarkdownElement,
  type MarkdownRenderNode,
} from './markdownRenderModel.ts'
import { MathRender } from './mathRender.solid.tsx'
import { splitOpenCodeFenceTail, splitStreamingMarkdownBlockEnds } from '../../../infrastructure/compute/streamingCompute.ts'
import { noteStreamingRowSet } from './streamingRowCounters.ts'

/**
 * settleMotion / typing 五跳透传链（#520 K 域集中登记——各跳签名就地保留，此处只画地图）：
 *
 *   MarkdownContent（:28 props.settleMotion/typewriter/streaming）
 *     → StreamingMarkdownBlocks（:121 owns `typing` 信号；settleMotion 驱动行尾块
 *       pulseSettle 结算动画）逐行下发 streaming/settleMotion/typing（:193-195）
 *       → StreamingMarkdownBlock（:240 块级分发；行 settling/typing 透传）
 *         → MarkdownSegment（:303 typing 光标条件解析；settling→data-md-settle）
 *           → MarkdownNode（:352 typingTail 光标挂叶尾 text/math；settling→pre/
 *             blockquote/table/ul-ol-h1-6 的 data-md-settle，:446 Dynamic 处）
 *             → MarkdownChildren（typingTail 只挂在最后一个内容子节点上继续下传）。
 *
 * 语义：`typing` = 流式增长尾的光标可见性（仅尾块尾节点亮）；`settleMotion` =
 * 行/块从增长态转稳定态的一次性结算动效（Reasoning/只读视图可整体关闭）。
 */

export interface MarkdownContentProps {
  text: string
  streaming?: boolean
  inline?: boolean
  /** Reasoning uses its own activity treatment; the typing tip belongs to assistant prose. */
  typewriter?: boolean
  /** Reasoning and read-only uses may opt out of assistant block completion motion. */
  settleMotion?: boolean
}

export function MarkdownContent(props: MarkdownContentProps) {
  // Bug4 流式主瓶颈：streaming 时每次 token 都对整段文本重解析/重高亮 → O(n²)。
  // 流式中把文本切成 "已完成块 stable + 增长尾块 unstable"（参考 claude-code StreamingMarkdown），
  // stable 由 content-keyed LRU 缓存复用（不重解析），unstable 是短尾只解析这一小段。
  // 非 streaming（已提交消息）保持整段一次解析，行为不变。
  //
  // C00 修复：不得用 <Show keyed> 包 split() 结果——每个 chunk 都是新对象引用，
  // keyed 会把整棵子树（含 stable 段）逐 chunk 重建。改为细粒度 accessor：
  // MarkdownSegment 只在自身 text 变化时重新解析/渲染，stable 恒定时 DOM 身份不变。
  // A Slot that started streaming remains on the incremental path when the
  // terminal update arrives. This promotes its last tail row instead of
  // replacing the complete Markdown subtree.
  const incremental = props.streaming === true

  return (
    <Show when={incremental} fallback={<MarkdownSegment text={props.text} inline={props.inline} />}>
      <StreamingMarkdownBlocks text={() => props.text} streaming={() => props.streaming === true}
        typewriter={props.typewriter !== false} settleMotion={props.settleMotion !== false} inline={props.inline} />
    </Show>
  )
}

interface StreamingBlockRow {
  readonly id: number
  /** P57 S3-A11：该行是否仍是增长尾块（尾块解析绕 LRU 缓存，稳定后恢复缓存）。
   *  #150 稳定性：必须是**信号**——行被提升为稳定行时要触发解析源变化（见 `MarkdownSegment`），
   *  否则已提交内容会沿用增量模型、失去「提升即全量」的自愈。 */
  tail(): boolean
  setTail(value: boolean): void
  readonly text: string
  update(text: string): void
  settling(): boolean
  pulseSettle(): void
  dispose(): void
}

/** 由当前文本推导出的一行（顺序即渲染顺序）。 */
interface RowSpec {
  readonly text: string
  readonly tail: boolean
}

interface DerivedRows {
  readonly specs: readonly RowSpec[]
  /** specs 前 stableSpecs 项来自已提交块（文本只增不变），其余至多一项是增长尾块。 */
  readonly stableSpecs: number
  /** 当前文本的段落数（稳定块 + 尾块）——行集合的上界，只读诊断用。 */
  readonly paragraphs: number
}

/**
 * 把「可见文本」推导为行描述序列——**纯函数**：同一文本 + 同一 final 恒得到同一序列。
 *
 * 为什么必须纯：发布链不保证单调（插值后的裁剪前缀、双列表短暂分叉、终态重发、resume）。
 * 只要行集合里留着独立于文本的累积历史，输入一旦回退或换挡就会留下「当前文本里并不存在
 * 的行边界」，把同一段干净文本切成每几个字一行的碎片（issue #55：实测 117 个块、其中 44 个
 * 不足 6 字，而文本只有 55 个段落；重启后同一条消息恢复正常）。
 *
 * 切分语义仍单一由 `splitStreamingMarkdownBlocks` 负责：空行切块、容器行不越界、未闭合
 * 围栏不劈开——本次不触碰它。
 *
 * 行文本不变式：每一行的文本都不以结构性空白开头或结尾（见
 * `trimRowStructuralWhitespace`），且不为空——分隔空行是行与行之间的结构，不是行内容。
 */
function deriveRowSpecs(visible: string, final: boolean): DerivedRows {
  // 热路径只取块边界偏移（ends 出口）：块内容由这里从 visible 切出——整组 stable
  // 块字符串每拍从 wasm 重分配/编组是 O(全文) 的过界流量（#220 边界收口）。
  const ends = splitStreamingMarkdownBlockEnds(visible)
  const specs: RowSpec[] = []
  let start = 0
  for (const end of ends) {
    // The splitter includes the blank-line delimiter in each stable block so the
    // accumulated prefix stays lossless.  That delimiter is structural, though—not
    // content that should become an extra `pre-wrap` line inside the row.  The shared
    // `.term-p + .term-p` cadence represents the separator; strip it from the visible
    // stable text to keep streaming geometry identical to the completed Markdown path.
    const text = trimRowStructuralWhitespace(visible.slice(start, end))
    if (text.length > 0) specs.push({ text, tail: false })
    start = end
  }
  const stableSpecs = specs.length
  const unstable = visible.slice(start)
  if (unstable.length > 0) {
    // Consecutive blank lines are collapsed by the splitter rather than becoming empty
    // renderer rows, so a tail that is still only structural whitespace contributes
    // nothing.  Its delimiter is stripped unconditionally: the old condition（只在它前面
    // 确实提交过块时才裁）会把前导空行留在行文本里，渲染成 `'\n\n快'` 一类的行。
    const text = trimRowStructuralWhitespace(unstable)
    if (text.length > 0) specs.push({ text, tail: !final })
  }
  return { specs, stableSpecs, paragraphs: ends.length + (unstable.length > 0 ? 1 : 0) }
}

function StreamingMarkdownBlocks(props: { text: () => string; streaming: () => boolean; typewriter: boolean; settleMotion: boolean; inline?: boolean }) {
  let nextId = 1
  // 行集合 = 当前文本的函数。这里刻意不保留任何独立于文本的累积状态：旧实现里的
  // committedText / hiddenLeading / stableRows 累积 + reset() 正是漂移的来源。
  let rendered: StreamingBlockRow[] = []
  let lastText = ''
  // stable 行文本只增不变（切分不变量：边界只前进），按位缓存修剪后的最终行文本，
  // 后继发布省掉对全部已完成块的 slice+trim 重复分配；尾行永远重算，回退/换挡清空。
  let cachedStableTexts: readonly string[] = []
  const [rows, setRows] = createSignal<readonly StreamingBlockRow[]>([])
  const lastRowId = createMemo(() => rows().at(-1)?.id)
  const [typing, setTyping] = createSignal(false)
  let clearTyping: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (clearTyping !== undefined) clearTimeout(clearTyping)
    for (const row of rendered) row.dispose()
  })

  const reconcile = (text: string, final: boolean) => {
    // 非后继输入（回退/换挡/重放）只作为只读计数，不再需要特殊分支：推导只看当前文本。
    const extendsPrevious = text.startsWith(lastText)
    const reset = !extendsPrevious
    // Reuse the prefix comparison already needed for row reconciliation.
    // A replacement is not a character reveal; a terminal catch-up still is.
    const grew = props.typewriter && extendsPrevious && text.length > lastText.length
    if (clearTyping !== undefined) clearTimeout(clearTyping)
    clearTyping = undefined
    setTyping(grew)
    if (grew) clearTyping = setTimeout(() => {
      clearTyping = undefined
      setTyping(false)
    }, 420)
    lastText = text
    if (reset) cachedStableTexts = []
    // Providers may open an assistant stream with blank lines (for example right after a
    // reasoning phase). CommonMark drops them once the parser runs, but the plain fast
    // path renders each as an empty pre-wrap line, pushing the first generated characters
    // below the assistant indicator.
    const derived = deriveRowSpecs(trimLeadingBlankLines(text), final)
    const resolvedSpecs = derived.specs.map((spec, index) => cachedStableTexts[index] ?? spec.text)
    cachedStableTexts = resolvedSpecs.slice(0, derived.stableSpecs)
    // S0 只读计数：rows / textParagraphs > 1 说明行集合里出现了文本之外的边界（issue #55 判据）。
    noteStreamingRowSet({ rows: derived.specs.length, paragraphs: derived.paragraphs, reset })
    const nextRows: StreamingBlockRow[] = []
    for (let index = 0; index < resolvedSpecs.length; index += 1) {
      const specText = resolvedSpecs[index]!
      const candidate = rendered[index]
      if (candidate === undefined) {
        nextRows.push(createStreamingBlockRow(nextId++, specText, derived.specs[index]!.tail))
        continue
      }
      // 位置对账：文本未变就不碰 signal（不多余重解析），变了就地更新——保持 DOM 身份是
      // 尾块逐拍增长不闪烁、稳定块（含代码块）不重挂载的前提。
      const wasTail = candidate.tail()
      if (candidate.text !== specText) candidate.update(specText)
      candidate.setTail(derived.specs[index]!.tail)
      if (props.settleMotion && !reset && wasTail && !derived.specs[index]!.tail) candidate.pulseSettle()
      nextRows.push(candidate)
    }
    for (const removed of rendered.slice(nextRows.length)) removed.dispose()
    rendered = nextRows
    setRows(nextRows)
  }

  createEffect(() => {
    const text = props.text()
    const final = !props.streaming()
    untrack(() => reconcile(text, final))
  })

  return <For each={rows()}>{row => <StreamingMarkdownBlock
    row={row}
    streaming={props.streaming}
    settleMotion={props.settleMotion}
    typing={props.typewriter ? () => typing() && lastRowId() === row.id : undefined}
    inline={props.inline}
  />}</For>
}

/** Strip fully blank leading lines; the first content line keeps its indentation. */
function trimLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[^\S\r\n]*\r?\n)+/, '')
}

/**
 * 行文本不变式：行的文本不以结构性空白（整行空白）开头或结尾。
 *
 * 分隔空行属于「行与行之间」的结构（由 `.term-p + .term-p` 的节奏承担），不属于行内容：
 * 留着它 `pre-wrap` 会多画一行，也会让流式几何与终态解析出的 Markdown 漂移。只裁整行空白，
 * **不裁末行内容里的空格与缩进**（例如代码缩进）。
 *
 * 支持 CRLF，使可见结果与 provider 的换行形式无关。
 */
function trimRowStructuralWhitespace(text: string): string {
  return text.replace(/(?:\r?\n[\t ]*)+$/u, '').replace(/^(?:\r?\n[\t ]*)+/u, '')
}

function createStreamingBlockRow(id: number, initialText: string, tail: boolean): StreamingBlockRow {
  const [text, setText] = createSignal(initialText)
  const [isTail, setIsTail] = createSignal(tail)
  const [settling, setSettling] = createSignal(false)
  let settledOnce = false
  let clearSettle: ReturnType<typeof setTimeout> | undefined
  return {
    id, tail: isTail, setTail: setIsTail, get text() { return text() }, update: setText,
    settling,
    pulseSettle: () => {
      if (settledOnce) return
      settledOnce = true
      setSettling(true)
      clearSettle = setTimeout(() => {
        clearSettle = undefined
        setSettling(false)
      }, 620)
    },
    dispose: () => { if (clearSettle !== undefined) clearTimeout(clearSettle) },
  }
}

function StreamingMarkdownBlock(props: { row: StreamingBlockRow; streaming: () => boolean; settleMotion: boolean; typing?: () => boolean; inline?: boolean }) {
  const text = () => props.row.text
  const openCodeTail = createMemo(() => props.streaming() ? splitOpenCodeFenceTail(text()) : null)
  let wasOpenCodeTail = openCodeTail() !== null
  createEffect(() => {
    const open = openCodeTail() !== null
    if (props.settleMotion && wasOpenCodeTail && !open && props.streaming()) props.row.pulseSettle()
    wasOpenCodeTail = open
  })
  // P57 S3-A11：增长尾块的中间态解析绕 LRU 缓存（同前缀同长度的文本永不再命中，
  // 只会挤掉 stable 块的缓存条目）；行晋升为 stable 后恢复缓存。
  const cacheModel = () => !props.row.tail()
  return <Show
    when={openCodeTail() !== null}
    fallback={<MarkdownSegment text={text} inline={props.inline} cache={cacheModel} typing={props.typing}
      settling={props.row.settling} />}
  >
    <Show when={openCodeTail()?.prefix}>
      {prefix => <MarkdownSegment text={prefix()} inline={props.inline} cache={cacheModel} />}
    </Show>
    <StreamingCodeBlock
      code={() => openCodeTail()?.code ?? ''}
      language={() => openCodeTail()?.language}
      typing={props.typing}
    />
  </Show>
}

/**
 * 流式尾块（未闭合围栏）的正文。
 *
 * **刻意不折叠**（用户 2026-09-20 裁决：流式期要能看着它继续长）。它是**过渡态**——
 * 回合结束后走 markdown 解析路径，由 #208 的头部折叠接管；因此"不限量"的窗口只覆盖
 * 生成期。真机实测 372 行 / 1.18 万字符的块在流式期 0 条 long task，常见规模下代价可忽略；
 * 若将来出现极端长块导致 DOM 膨胀，再引入高上限兜底（而不是直接改为折叠）。
 */
function StreamingCodeBlock(props: { language: () => string | undefined; code: () => string; typing?: () => boolean }) {
  const lines = () => props.code().split(String.fromCharCode(10))
  return (
    <div
      class="term-code-block"
      data-streaming-code="true"
      data-language={props.language()}
    >
      <Index each={lines()}>{(line, index) => (
        <div class="term-code-line">
          <span class="term-code-gutter">│ </span>
          <span class="term-code-text">{line() || String.fromCharCode(160)}
            {props.typing && <Show when={props.typing() && index === lines().length - 1}><TypingCursor /></Show>}
          </span>
        </div>
      )}</Index>
    </div>
  )
}

/**
 * 把一段文本解析为 markdown 渲染。streaming 稳定前缀复用 LRU 缓存，不重解析。
 *
 * P57 S3-R8（R-B8）：解析 pending 期间渲染 `model.latest`（上一次已解析模型），
 * 不再回落到原始文本——流式尾块旧模型是同文本前缀，短暂滞后无感，而原始
 * `**`/`` ` `` 标记不再泄漏到 DOM。仅首次解析（从未 resolve）渲染骨架。
 */
function MarkdownSegment(props: { text: string | (() => string); inline?: boolean; cache?: () => boolean; typing?: () => boolean; settling?: () => boolean }) {
  const text = () => typeof props.text === 'function' ? props.text() : props.text
  const typing = () => props.typing?.() === true
  const canType = props.typing !== undefined
  const shouldParse = () => !isPlainTextContent(text())
  const useCache = () => props.cache?.() ?? true
  // #212：命中**已结算**的缓存模型时同步渲染，完全不经骨架——历史行不再有一次
  // 「1em 骨架 → 真高」的高度跳变。只在走缓存的调用点有效（增长尾块恒走解析/graft）。
  const settled = () => useCache() ? peekMarkdownRenderModel(text()) : undefined
  const [model] = createResource(
    // #150 稳定性：解析源带上 `cache` 标志 ⇒ 尾块被提升为稳定行（cache false→true）时**换源重解析**，
    // 于是「已提交内容一定来自整段重解析」——增量拼接只可能影响正在长的那一行，即便某个没预料的
    // 形状上拼错了，也会在块完成那一刻被真实解析覆盖（自愈）。代价是每块多一次整段重解析（一次）。
    () => shouldParse() ? { text: text(), cache: useCache() } : undefined,
    source => getMarkdownRenderModel(source.text, {
      cache: source.cache,
      // #148：只有增长尾块（不走缓存的路径）才传「最新即胜」判据——跳过返回空模型，落进 LRU
      // 会毒化同文本的其他行。判据与 Solid 丢弃结果的 `pr === p` 条件同义：解析源是
      // `shouldParse() ? text() : undefined`，源一变它就发起新 fetch 并改写 pr，旧请求的结果
      // 必被丢弃（token 级切片、终态重发、resume 这类一 tick 内多次发布的中间态即在此被挡下）。
      isCurrent: source.cache ? undefined : () => shouldParse() && text() === source.text,
    }),
  )

  const root = () => settled() ?? model.latest

  return (
    <Show when={shouldParse()} fallback={props.inline
      ? <span class="term-p term-plain-text">{text()}{canType && <Show when={typing()}><TypingCursor /></Show>}</span>
      : <p class="term-p term-plain-text">{text()}{canType && <Show when={typing()}><TypingCursor /></Show>}</p>}>
      <Show when={root()} fallback={<div class="term-md-skeleton" aria-busy="true" />}>
        {resolved => {
          const lastIndex = canType ? createMemo(() => lastContentIndex(resolved().children)) : () => -1
          return <For each={resolved().children}>{(node, index) => {
            const lastAtMount = canType && index() === lastIndex()
            return <MarkdownNode node={node} settling={props.settling} typingTail={lastAtMount
              ? () => typing() && index() === lastIndex()
              : undefined} />
          }}</For>
        }}
      </Show>
    </Show>
  )
}

function TypingCursor() {
  return <span class="term-typewriter-cursor" aria-hidden="true" />
}

function MarkdownNode(props: { node: MarkdownRenderNode; typingTail?: () => boolean; settling?: () => boolean }): JSX.Element {
  if (props.node.type === 'text') return props.typingTail
    ? <>{props.node.value}<Show when={props.typingTail()}><TypingCursor /></Show></>
    : props.node.value
  if (props.node.type === 'root') {
    return <MarkdownChildren children={props.node.children} typingTail={props.typingTail} />
  }

  const node = props.node
  if (node.tagName === 'pre') {
    const code = extractCodeBlock(node)
    if (code) return <CodeBlock language={code.language} code={code.code} settling={props.settling} />
  }
  if (node.tagName === 'code') {
    return <code class="term-inline-code"><MarkdownChildren children={node.children} typingTail={props.typingTail} /></code>
  }
  if (node.tagName === 'a') {
    const href = safeHref(node.properties.href)
    // #267：脚注锚点需要 id（文末回链指回首引用锚）。
    const anchorId = typeof node.properties.id === 'string' ? node.properties.id : undefined
    // 纯锚点（#开头）原地跳转，不开新标签（脚注引用/回链的跳转语义）。
    const isHashOnly = href?.startsWith('#') === true
    return href
      ? <a
          href={href}
          id={anchorId}
          target={isHashOnly ? undefined : '_blank'}
          rel={isHashOnly ? undefined : 'noopener noreferrer'}
          class="term-link"
        ><MarkdownChildren children={node.children} typingTail={props.typingTail} /></a>
      : <span><MarkdownChildren children={node.children} typingTail={props.typingTail} /></span>
  }
  if (node.tagName === 'img') {
    const src = safeImageSource(node.properties.src)
    const alt = typeof node.properties.alt === 'string' ? node.properties.alt : ''
    return src
      ? <img class="term-markdown-image" src={src} alt={alt} loading="lazy" />
      : <span class="term-markdown-image-alt">{alt}</span>
  }
  if (node.tagName === 'blockquote') {
    return <blockquote class="term-blockquote" data-md-settle={props.settling?.() ? 'true' : undefined}><MarkdownChildren children={node.children} typingTail={props.typingTail} /></blockquote>
  }
  if (node.tagName === 'table') {
    return <div class="term-table-wrap" data-md-settle={props.settling?.() ? 'true' : undefined}><table class="term-table"><MarkdownChildren children={node.children} typingTail={props.typingTail} /></table></div>
  }
  // #267：数学公式（span.math-inline / div.math-display，解析侧 remark-math 形状）
  // → Temml 渲染 MathML；失败回落 latex 原文（见 mathRender.tsx）。
  if (node.tagName === 'span' || node.tagName === 'div') {
    const classNames = normalizeClassNames(node.properties.className)
    if (classNames.includes('math')) {
      const latex = collectText(node)
      return <><MathRender latex={latex} display={classNames.includes('math-display')} />
        <Show when={props.typingTail?.()}><TypingCursor /></Show></>
    }
  }
  // #267：GFM 脚注——引用上标与文末脚注节（解析侧 remark-gfm/rehype 形状）。
  if (node.tagName === 'sup') {
    const label = typeof node.properties.ariaLabel === 'string' ? node.properties.ariaLabel : undefined
    return <sup class="term-footnote-ref" aria-label={label}><MarkdownChildren children={node.children} typingTail={props.typingTail} /></sup>
  }
  if (node.tagName === 'section') {
    const classNames = normalizeClassNames(node.properties.className)
    if (classNames.includes('footnotes')) {
      return <section class="term-footnotes footnotes"><MarkdownChildren children={node.children} typingTail={props.typingTail} /></section>
    }
  }

  const tagName = allowedTagName(node.tagName)
  // CSS-02：Markdown heading 显式 class contract（§5.15 step 3）——h1-h6 输出 term-h1~term-h6，
  // 配合 ChatView.css 限定 .term-assistant 内的层级规则（Solid renderer 唯一 contract）。
  const headingClass = tagName.match(/^h[1-6]$/) ? `term-${tagName}` : undefined
  // Keep the block contract shared with the legacy React renderer.  The
  // global stylesheet intentionally resets native element margins, so relying
  // on the browser's bare `<p>`/`<li>` defaults makes a completed stream look
  // materially tighter than its plain-text streaming counterpart.
  const blockClass = tagName === 'p'
    ? 'term-p'
    : tagName === 'li'
      ? 'term-li'
      : headingClass
  // #267：脚注条目的 `id`（user-content-fn-N）是回链锚点目标，通用路径透传。
  const nodeId = typeof node.properties.id === 'string' ? node.properties.id : undefined
  // #272：GFM 表格列对齐——解析层把 :---:/---: 落成 th/td 的 align 属性，
  // 此处透传到 DOM（配合 ChatView.css 的 [align] 属性选择器生效）。
  const cellAlign = (tagName === 'th' || tagName === 'td') && typeof node.properties.align === 'string'
    ? node.properties.align
    : undefined
  const settleBlock = tagName === 'ul' || tagName === 'ol' || /^h[1-6]$/.test(tagName)
  return <Dynamic component={tagName} class={blockClass} id={nodeId} align={cellAlign}
    data-md-settle={settleBlock && props.settling?.() ? 'true' : undefined}>
    <MarkdownChildren children={node.children} typingTail={props.typingTail} />
  </Dynamic>
}

function MarkdownChildren(props: { children: readonly MarkdownRenderNode[]; typingTail?: () => boolean }) {
  const lastIndex = props.typingTail ? createMemo(() => lastContentIndex(props.children)) : () => -1
  return <For each={props.children}>{(node, index) => {
    const lastAtMount = props.typingTail !== undefined && index() === lastIndex()
    return <MarkdownNode node={node} typingTail={lastAtMount
      ? () => props.typingTail?.() === true && index() === lastIndex()
      : undefined} />
  }}</For>
}

/** Parsed containers often end with a formatting newline after their last visible child. */
function lastContentIndex(children: readonly MarkdownRenderNode[]): number {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const node = children[index]!
    if (node.type !== 'text' || node.value.trim().length > 0) return index
  }
  return -1
}

function CodeBlock(props: { language?: string; code: string; settling?: () => boolean }) {
  const lines = () => props.code.split('\n')
  // #221：行 HTML 缓存 + 视口外降级。lineHtmls 持有 sanitize 后的每行高亮串（与旧
  // 路径同口径，逐字节一致）；降级只清 `.term-code-text` 的 span 树换成纯文本行，
  // `.term-code-line > .term-code-gutter + .term-code-text` 骨架与行高两侧恒定。
  // 无 IntersectionObserver 的宿主（测试/旧内核）走 onMount 即高亮的现状时序。
  const [lineHtmls, setLineHtmls] = createSignal<readonly string[] | null>(null)
  const [demoted, setDemoted] = createSignal(false)
  let root: HTMLDivElement | undefined
  let releaseLifecycle: (() => void) | undefined
  let exited = false
  let disposed = false

  const requestHighlight = () => {
    if (lineHtmls() !== null) {
      setDemoted(false)
      return
    }
    const language = props.language || 'text'
    const code = props.code
    scheduleHighlightJob(async () => {
      const html = await highlightCode(language, code).catch(() => null)
      if (disposed) return
      setLineHtmls(html === null ? [] : html.split('\n').map(line => sanitizeHtml(line || '&nbsp;')))
      // 在途期间块已出圈：结果入缓存但不解除降级，重进视口时走缓存恢复。
      if (!exited) setDemoted(false)
    })
  }

  onMount(() => {
    if (typeof IntersectionObserver === 'undefined' || root === undefined) {
      requestHighlight()
      return
    }
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

  return (
    <div class="term-code-block" data-md-settle={props.settling?.() ? 'true' : undefined} ref={root}>
        <For each={lines()}>{(line, index) => (
          <div class="term-code-line">
            <span class="term-code-gutter">│ </span>
            <Show
              when={demoted() ? undefined : lineHtmls()?.[index()]}
              fallback={<span class="term-code-text">{line || '\u00a0'}</span>}
            >
              {html => <span class="term-code-text" innerHTML={html()} />}
            </Show>
          </div>
        )}</For>
    </div>
  )
}

function extractCodeBlock(node: MarkdownElement): { language?: string; code: string } | null {
  const codeNode = node.children.find(child => child.type === 'element' && child.tagName === 'code')
  if (!codeNode || codeNode.type !== 'element') return null
  const classNames = normalizeClassNames(codeNode.properties.className)
  const languageClass = classNames.find(className => className.startsWith('language-'))
  return {
    language: languageClass?.slice('language-'.length),
    code: collectText(codeNode).replace(/\n$/, ''),
  }
}

function collectText(node: MarkdownRenderNode): string {
  if (node.type === 'text') return node.value
  return node.children.map(collectText).join('')
}

function normalizeClassNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
}

function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const href = value.trim()
  if (!href) return null
  if (/^(?:https?:|mailto:)/i.test(href)) return href
  if (/^(?:\/|\.\/|\.\.\/|#)/.test(href)) return href
  // A scheme-less Markdown href is a workspace-relative resource. The
  // AgentSheet host decides whether it is contained by the active workspace
  // before preventing browser navigation and opening FileSheet.
  if (!/^[a-z][a-z\d+.-]*:/i.test(href) && ![...href].some(char => char.charCodeAt(0) <= 0x20)) return href
  return null
}

function safeImageSource(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const source = value.trim()
  if (/^https?:/i.test(source)) return source
  if (/^data:image\/(?:png|gif|jpe?g|webp|avif);base64,/i.test(source)) return source
  if (/^(?:\/|\.\/|\.\.\/)/.test(source)) return source
  return null
}

function allowedTagName(tagName: string): keyof JSX.IntrinsicElements {
  const allowed = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'strong', 'em', 'del', 'hr', 'br',
    'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span',
  ])
  return (allowed.has(tagName) ? tagName : 'span') as keyof JSX.IntrinsicElements
}
