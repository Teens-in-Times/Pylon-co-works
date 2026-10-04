/**
 * C00：text/ansi 内容契约（纯 domain，Solid surface 与第三方 react 兼容 kind 共用）。
 *
 * ANSI 解析采用 SGR 白名单策略（参考 claude-code-sourcemap ink/termio/sgr.ts 的
 * 语义化解析思路）：只保留颜色/加粗/斜体/下划线等表现语义；OSC（含 OSC 8 超链接、
 * OSC 0 标题）、CSI 非样式序列与 C0 控制字符（除 \n \t）一律剥离——原始文本可读、
 * 注入载荷不可达。
 */

export interface AnsiSpan {
  readonly text: string
  readonly fg?: string
  readonly bg?: string
  readonly fgCss?: string
  readonly bgCss?: string
  readonly bold?: true
  readonly dim?: true
  readonly italic?: true
  readonly underline?: true
}

const NAMED_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
type NamedColor = (typeof NAMED_COLORS)[number]

const BRIGHT_OFFSET = 8

function namedColor(code: number): NamedColor | undefined {
  return NAMED_COLORS[code - 30]
}

/** 256 色 → css hex（标准 xterm 调色板前 16 + 6×6×6 立方 + 灰阶） */
export function ansi256ToCss(index: number): string {
  if (index < 16) {
    const bright = index >= BRIGHT_OFFSET
    const base = bright ? index - BRIGHT_OFFSET : index
    const names: readonly string[] = ['00', '5f', '87', 'af', 'd7', 'ff']
    const value = bright ? names[base] ?? 'ff' : names[base] ?? '00'
    // 前 16 色用近似 xterm 值
    const palette = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff']
    void value
    return palette[index]!
  }
  if (index < 232) {
    const cube = index - 16
    const step = (v: number): number => v === 0 ? 0 : 55 + v * 40
    const r = Math.floor(cube / 36)
    const g = Math.floor((cube % 36) / 6)
    const b = cube % 6
    return `#${hex2(step(r))}${hex2(step(g))}${hex2(step(b))}`
  }
  const gray = 8 + (index - 232) * 10
  return `#${hex2(gray)}${hex2(gray)}${hex2(gray)}`
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0')
}

interface AnsiStyleState {
  fg?: AnsiSpan['fg']
  bg?: AnsiSpan['bg']
  fgCss?: string
  bgCss?: string
  bold?: true
  dim?: true
  italic?: true
  underline?: true
}

function styleToSpan(state: AnsiStyleState, text: string): AnsiSpan {
  return {
    text,
    ...(state.fg !== undefined ? { fg: state.fg } : {}),
    ...(state.bg !== undefined ? { bg: state.bg } : {}),
    ...(state.fgCss !== undefined ? { fgCss: state.fgCss } : {}),
    ...(state.bgCss !== undefined ? { bgCss: state.bgCss } : {}),
    ...(state.bold !== undefined ? { bold: state.bold } : {}),
    ...(state.dim !== undefined ? { dim: state.dim } : {}),
    ...(state.italic !== undefined ? { italic: state.italic } : {}),
    ...(state.underline !== undefined ? { underline: state.underline } : {}),
  }
}

function spansEqual(left: AnsiSpan, right: AnsiSpan): boolean {
  return left.fg === right.fg && left.bg === right.bg && left.fgCss === right.fgCss
    && left.bgCss === right.bgCss && left.bold === right.bold && left.dim === right.dim
    && left.italic === right.italic && left.underline === right.underline
}

/**
 * ANSI → 结构化 span。白名单外的一切转义序列被剥离；显示文本完整保留。
 */
export function stripAnsiControlSequences(input: string): readonly AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let buffer = ''
  const state: AnsiStyleState = {}
  let index = 0
  const flush = () => {
    if (buffer.length === 0) return
    const nextSpan = styleToSpan(state, buffer)
    const previous = spans.at(-1)
    // 相邻且样式完全一致的 span 合并（OSC/控制剥离不应产生视觉断点）
    if (previous && spansEqual(previous, nextSpan)) {
      spans[spans.length - 1] = { ...previous, text: previous.text + nextSpan.text }
    } else {
      spans.push(nextSpan)
    }
    buffer = ''
  }
  while (index < input.length) {
    const char = input[index]
    if (char !== '\u001b') {
      // C0 控制：保留 \n \t，其余剥离
      if (char === '\n' || char === '\t' || char! >= ' ') {
        buffer += char
      } else if (input.charCodeAt(index) < 32 || input.charCodeAt(index) === 127) {
        // drop control char
      } else {
        buffer += char
      }
      index += 1
      continue
    }
    const next = input[index + 1]
    if (next === '[') {
      flush()
      // CSI 序列：读取到终止字节（@-~）
      let cursor = index + 2
      while (cursor < input.length) {
        const code = input.charCodeAt(cursor)
        if (code >= 64 && code <= 126) break
        cursor += 1
      }
      const params = input.slice(index + 2, cursor)
      const finalByte = input[cursor] ?? ''
      if (finalByte === 'm') applySgr(params, state)
      index = cursor + 1
      continue
    }
    if (next === ']') {
      flush()
      // OSC 序列：BEL 或 ST 终止。整个 payload（标题/超链接目标）不进入渲染。
      let cursor = index + 2
      while (cursor < input.length) {
        if (input[cursor] === '\u0007') { cursor += 1; break }
        if (input[cursor] === '\u001b' && input[cursor + 1] === '\\') { cursor += 2; break }
        cursor += 1
      }
      index = cursor
      continue
    }
    // 其他 ESC 序列（ESC x / ESC P 等）：剥两字节保守处理
    flush()
    index += next === undefined ? 1 : 2
  }
  flush()
  return spans.length > 0 ? spans : [{ text: '' }]
}

function applySgr(paramsStr: string, state: AnsiStyleState): void {
  if (!paramsStr) return
  const parts = paramsStr.split(';')
  let position = 0
  while (position < parts.length) {
    const code = Number(parts[position]) || 0
    switch (true) {
      case code === 0:
        delete state.fg
        delete state.bg
        delete state.fgCss
        delete state.bgCss
        delete state.bold
        delete state.dim
        delete state.italic
        delete state.underline
        break
      case code === 1: state.bold = true; break
      case code === 2: state.dim = true; break
      case code === 3: state.italic = true; break
      case code === 4: state.underline = true; break
      case code === 22: delete state.bold; delete state.dim; break
      case code === 23: delete state.italic; break
      case code === 24: delete state.underline; break
      case code >= 30 && code <= 37:
        state.fg = namedColor(code)!
        delete state.fgCss
        break
      case code === 39: delete state.fg; delete state.fgCss; break
      case code >= 40 && code <= 47:
        state.bg = namedColor(code - 10)!
        delete state.bgCss
        break
      case code === 49: delete state.bg; delete state.bgCss; break
      case code >= 90 && code <= 97:
        state.fg = namedColor(code - 60)!
        delete state.fgCss
        break
      case code >= 100 && code <= 107:
        state.bg = namedColor(code - 70)!
        delete state.bgCss
        break
      case code === 38 || code === 48: {
        // 扩展色：38;5;N 或 38;2;R;G;B（冒号子参数已按分号归一化处理）
        const mode = Number(parts[position + 1])
        if (mode === 5) {
          const colorIndex = Number(parts[position + 2])
          const css = Number.isInteger(colorIndex) ? ansi256ToCss(colorIndex) : undefined
          if (css) {
            if (code === 38) { state.fgCss = css; delete state.fg } else { state.bgCss = css; delete state.bg }
          }
          position += 2
        } else if (mode === 2) {
          const r = Number(parts[position + 2])
          const g = Number(parts[position + 3])
          const b = Number(parts[position + 4])
          if ([r, g, b].every(value => Number.isInteger(value))) {
            const css = `#${hex2(r)}${hex2(g)}${hex2(b)}`
            if (code === 38) { state.fgCss = css; delete state.fg } else { state.bgCss = css; delete state.bg }
          }
          position += 4
        }
        break
      }
      default:
        break
    }
    position += 1
  }
}

const CLASS_SAFE_COLOR = /^[a-z]+$/
const CLASS_SAFE_CSS = /^#[0-9a-f]{3,6}$/

/** span → 安全 class 名集合（着色只经 class，不经 inline style） */
function classNamesForSpan(span: AnsiSpan): readonly string[] {
  const classes: string[] = []
  const fgName = span.fg ?? (span.fgCss && CLASS_SAFE_CSS.test(span.fgCss) ? undefined : undefined)
  if (fgName && CLASS_SAFE_COLOR.test(fgName)) classes.push(`term-ansi-fg-${fgName}`)
  else if (span.fgCss && CLASS_SAFE_CSS.test(span.fgCss)) classes.push(`term-ansi-fgc-${span.fgCss.slice(1)}`)
  const bgName = span.bg
  if (bgName && CLASS_SAFE_COLOR.test(bgName)) classes.push(`term-ansi-bg-${bgName}`)
  else if (span.bgCss && CLASS_SAFE_CSS.test(span.bgCss)) classes.push(`term-ansi-bgc-${span.bgCss.slice(1)}`)
  if (span.bold) classes.push('term-ansi-bold')
  if (span.dim) classes.push('term-ansi-dim')
  if (span.italic) classes.push('term-ansi-italic')
  if (span.underline) classes.push('term-ansi-underline')
  return classes
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * ANSI → 已转义、仅 class 着色的安全 HTML。供 innerHTML 渲染路径使用；
 * 输入中的 HTML 元素一律转义为可见文本（<script> 永远不可执行）。
 */
export function sanitizeAnsiForDisplay(input: string): string {
  return stripAnsiControlSequences(input).map(span => {
    const escaped = escapeHtml(span.text)
    const classes = classNamesForSpan(span)
    return classes.length > 0 ? `<span class="${classes.join(' ')}">${escaped}</span>` : escaped
  }).join('')
}

// —— oversize 折叠 ——

export interface OversizeFold {
  /** 可见前缀长度（行边界对齐）；超出部分折叠但完整文本仍可用于搜索/复制 */
  readonly visibleLength: number
}

/**
 * 找折叠点：不超过 maxChars 且落在最后一个换行上；无换行时硬截断。
 * 返回 null 表示无需折叠。
 */
export function findOversizeFoldPoint(text: string, maxChars: number): OversizeFold | null {
  if (text.length <= maxChars) return null
  const slice = text.slice(0, maxChars)
  const lastNewline = slice.lastIndexOf('\n')
  const visibleLength = lastNewline > maxChars / 2 ? lastNewline + 1 : maxChars
  return { visibleLength }
}

// —— 流式 fence 稳定性 ——

/** 文本中所有代码围栏均已闭合（无围栏视为闭合）。流式渲染判断是否可以稳定提交 AST。 */
export function isClosedCodeFence(text: string): boolean {
  let inFence = false
  let fenceChar = ''
  for (const line of text.split('\n')) {
    const trimmedStart = line.trimStart()
    if (!inFence) {
      if (trimmedStart.startsWith('```')) { inFence = true; fenceChar = '`' }
      else if (trimmedStart.startsWith('~~~')) { inFence = true; fenceChar = '~' }
      continue
    }
    if (fenceChar && trimmedStart.startsWith(fenceChar.repeat(3))) inFence = false
  }
  return !inFence
}
