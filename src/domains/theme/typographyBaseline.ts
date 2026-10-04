/**
 * CSS-01：P6 Markdown typography computed style 基线（方案书任务表 CSS-01，§5.15 step 1-2）。
 *
 * 目的：以实际主题 preset 与 Solid renderer 的最终 DOM/class 为准，登记当前
 * typography 基线（P6 已证实四事实），为 CSS-02（heading class/renderer contract）与
 * CSS-03（px 最小修复）提供验收基准。只读取证，不修改任何 CSS（视觉改动属 CSS-02/03）。
 *
 * P6 已证实基线事实（CSS-01 取证 → CSS-02 修复）：
 *   - `.term` fallback 用 `15pt`（ChatView.css:8 `font-size:var(--chat-font-size,15pt)`）；
 *     聊天字号 px contract 由 chatFontSize def（themeFieldDefs.ts:109 unit=px）注入
 *     `--chat-font-size=NNpx`，15pt 仅在变量缺失时成为 effective value。
 *   - h1-h6 原无完整 renderer class contract：`.term-h2/.term-h3`（ChatView.css:198-199）
 *     原无任何 renderer 输出该 class——规则永不命中（P6 已证实）。
 *   - Solid renderer 原直接输出原生 h1-h6（MarkdownContent.solid.tsx:65-66 Dynamic）。
 *   - 旧 React renderer 已删除；当前唯一内建 renderer 为 Solid。
 *   CSS-02 后：Solid renderer 输出 `term-h1~term-h6`，ChatView.css 以
 *   `.term-assistant .term-h{n}` 限定层级规则（§5.15 step 3/5），contract 就位。
 *   CSS-03 后：ChatView.css:8 fallback `15pt`→`15px`——15pt=20px 风险消除，
 *   PX_CONTRACT_FALLBACK_SAFE 翻转为 true。
 *
 * 纪律（方案书 §2 阶段 M0 同模式）：只读取证；不修改业务语义；隔离生产路径（仅 DEV 钩子
 * 挂载，生产 tree-shake）；脱敏复用 OBS-04 sanitizeExportValue + OBS-05 narrowPathValues。
 * 结构性常量（HEADING_CLASS_CONTRACT_IN_PLACE / PX_CONTRACT_FALLBACK_SAFE）为 CSS-02/03
 * 的翻红基线——修好对应卡后翻转为 true。
 */

import { THEME_FIELD_DEFS } from './themeFieldDefs.ts'

/** 结构性常量：P6 typography 关键证据（与 OBS-06/07 结构性常量同模式，代码级登记）。 */
export const TYPOGRAPHY_EVIDENCE = {
  termRule: {
    file: 'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css:8',
    fontSizeFallback: '15px',
    cssVar: '--chat-font-size',
    rule: '.term { ... font-size:var(--chat-font-size,15px); ... }',
    note: 'CSS-03 后：聊天字号统一 px contract——chatFontSize def（themeFieldDefs.ts:109 unit=px）注入 '
      + '--chat-font-size=NNpx，fallback 亦为 15px（原 15pt=20px 风险消除），变量缺失时保持 px 语义。',
  },
  headingCss: {
    file: 'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css:198-206',
    rules: ['.term-h1', '.term-h2', '.term-h3', '.term-h4', '.term-h5', '.term-h6'],
    note: 'CSS-02 后：.term-assistant 内完整 h1-h6 层级规则（§5.15 建议比例；h2=1.1em/h3=1em 600 '
      + '沿用既有设计），Solid renderer 输出 term-h1~term-h6——规则命中。',
  },
  renderers: {
    solid: {
      file: 'src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx:65-69',
      headingDom: 'h1-h6 输出 class term-h1~term-h6',
      note: 'allowedTagName 后按 /^h[1-6]$/ 派生 headingClass=term-{tag} 附于 Dynamic。',
    },
  },
} as const

/** 结构性常量：h1-h6 显式 class/renderer contract 是否就位（CSS-02 已实现 → true；CSS-01 基线为 false）。 */
export const HEADING_CLASS_CONTRACT_IN_PLACE = true
/** 结构性常量：聊天字号是否已消除 15pt fallback 风险（CSS-03 已实现 → true；ChatView.css:8 fallback 现为 15px）。 */
export const PX_CONTRACT_FALLBACK_SAFE = true

/** h1-h6 建议比例上限（方案书 §5.15：以正文 computed font-size 为基准，具体数值以现有设计为准）。 */
export const HEADING_SCALE_UPPER_BOUNDS = {
  h1: 1.30,
  h2: 1.20,
  h3: 1.12,
  h4: 1.06,
  h5: 1.0,
  h6: 1.0,
} as const

/** 历史记录：CSS-03 前 `.term` fallback 为 `15pt`（=20px，1pt=4/3px）；CSS-03 已改为直接 `15px`，
 * pt→px 换算辅助移除——聊天字号唯一来源为 px contract（--chat-font-size=NNpx）。 */

// ============================================================================
// 聊天字号 px contract（themeFieldDefs 单一真值表）
// ============================================================================

export interface ChatFontSizeContract {
  /** def 声明的单位（themeFieldDefs chatFontSize unit=px——CSS-03 基线）。 */
  unit: string | undefined
  /** 注入 `--chat-font-size` 的值（如 "15px"；非 px 单位时原样）。 */
  cssVarValue: string
  /** 数值（仅 unit=px 时为 number；非 px → null——非 px contract 信号）。 */
  px: number | null
}

/** CSS-01：聊天字号 px contract 解析——从 THEME_FIELD_DEFS.chatFontSize def 派生。
 * unit 缺省取 def 真值（本卡验收 def.unit==='px'）；传参 unit 仅用于测试非 px 分支。 */
export function resolveChatFontSizeContract(
  theme: { chatFontSize: number },
  unit?: string,
): ChatFontSizeContract {
  const resolvedUnit = unit ?? THEME_FIELD_DEFS.chatFontSize.unit
  const px = resolvedUnit === 'px' ? theme.chatFontSize : null
  return { unit: resolvedUnit, cssVarValue: `${theme.chatFontSize}${resolvedUnit ?? ''}`, px }
}

// ============================================================================
// heading 渲染 DOM/class contract（renderer 源码为真值）
// ============================================================================

export type TypographyRenderer = 'solid'

export interface HeadingLevelDom {
  level: 1 | 2 | 3 | 4 | 5 | 6
  /** renderer 实际输出的 DOM 标签（恒 `h{n}`）。 */
  tag: string
  /** renderer 实际输出的 className（CSS-02 起两 renderer 均输出 `term-h{n}`——contract 就位）。 */
  className: string
  /** renderer 源码证据（file:line）——DOM 输出形态的可追溯来源（TYPOGRAPHY_EVIDENCE）。 */
  source: string
}

/** CSS-02：heading 渲染 DOM/class contract——以 Solid renderer 源码为真值登记输出形态。
 * `MarkdownContent.solid.tsx` 派生 `term-h1~term-h6`，配合 ChatView.css 限定
 * `.term-assistant` 内的层级规则；HEADING_CLASS_CONTRACT_IN_PLACE 已翻转为 true。 */
export function headingDomContract(renderer: TypographyRenderer): HeadingLevelDom[] {
  const levels = [1, 2, 3, 4, 5, 6] as const
  const source = TYPOGRAPHY_EVIDENCE.renderers[renderer].file
  return levels.map(level => ({ level, tag: `h${level}`, className: `term-h${level}`, source }))
}

// ============================================================================
// DOM computed style 测量（DEV 实跑 + jsdom 可测）
// ============================================================================

export interface ComputedStyleSample {
  selector: string
  className: string | null
  fontFamily: string | null
  fontSize: string | null
  fontSizePx: number | null
  fontWeight: string | null
  lineHeight: string | null
}

export interface TypographyBaselineMeasurement {
  body: ComputedStyleSample | null
  term: ComputedStyleSample | null
  termAssistant: ComputedStyleSample | null
  headings: Record<'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', ComputedStyleSample | null>
  /** 各 heading computed font-size / body font-size（§5.15 建议比例对照；分母缺失→null）。 */
  ratios: Record<'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', number | null>
}

const HEADING_KEYS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

function sampleComputed(selector: string, el: Element | null): ComputedStyleSample | null {
  if (!el) return null
  const cs = window.getComputedStyle(el)
  const fontSize = cs.getPropertyValue('font-size')
  return {
    selector,
    className: el.getAttribute('class'),
    fontFamily: cs.getPropertyValue('font-family'),
    fontSize,
    fontSizePx: Number.isFinite(parseFloat(fontSize)) ? parseFloat(fontSize) : null,
    fontWeight: cs.getPropertyValue('font-weight'),
    lineHeight: cs.getPropertyValue('line-height'),
  }
}

function ratioToBody(sample: ComputedStyleSample | null, bodyPx: number | null): number | null {
  if (!sample || sample.fontSizePx === null || bodyPx === null || bodyPx === 0) return null
  return sample.fontSizePx / bodyPx
}

/** CSS-01：computed style 基线采样——读取 body/.term/.term-assistant/h1-h6 的
 * computed style 并计算相对 body 比例。缺元素 → null（防御，不报错）。 */
export function captureComputedStyleBaseline(scope: ParentNode = document): TypographyBaselineMeasurement {
  const body = sampleComputed('body', document.body)
  const bodyPx = body?.fontSizePx ?? null
  const term = sampleComputed('.term', scope.querySelector('.term'))
  const termAssistant = sampleComputed('.term-assistant', scope.querySelector('.term-assistant'))
  const headings = {} as TypographyBaselineMeasurement['headings']
  const ratios = {} as TypographyBaselineMeasurement['ratios']
  for (const key of HEADING_KEYS) {
    headings[key] = sampleComputed(key, scope.querySelector(key))
    ratios[key] = ratioToBody(headings[key], bodyPx)
  }
  return { body, term, termAssistant, headings, ratios }
}

// ============================================================================
// 基线工件组装
// ============================================================================

export interface TypographyBaselineArtifact {
  tool: 'css01-typography-baseline'
  schemaVersion: 1
  capturedAt: number
  phase: string
  evidence: typeof TYPOGRAPHY_EVIDENCE
  headingClassContractInPlace: boolean
  pxContractFallbackSafe: boolean
  headingScaleUpperBounds: typeof HEADING_SCALE_UPPER_BOUNDS
  /** 聊天字号 fallback 的 px 值（CSS-03 后 ChatView.css:8 fallback=15px——直接 px，无需 pt 换算）。 */
  fallbackTermFontPx: number
  chatFontSize: ChatFontSizeContract
  rendererHeadingDom: Record<TypographyRenderer, HeadingLevelDom[]>
  /** DEV 实跑时携带 DOM 测量；纯组装（测试/离线）为 null。 */
  measurement: TypographyBaselineMeasurement | null
}

/** CSS-01：编排——preset px contract + renderer DOM/class contract + （可选）DOM 测量 → 工件。 */
export function buildTypographyBaselineArtifact(input: {
  phase: string
  theme: { chatFontSize: number }
  measurement?: TypographyBaselineMeasurement | null
}): TypographyBaselineArtifact {
  return {
    tool: 'css01-typography-baseline',
    schemaVersion: 1,
    capturedAt: Date.now(),
    phase: input.phase,
    evidence: TYPOGRAPHY_EVIDENCE,
    headingClassContractInPlace: HEADING_CLASS_CONTRACT_IN_PLACE,
    pxContractFallbackSafe: PX_CONTRACT_FALLBACK_SAFE,
    headingScaleUpperBounds: HEADING_SCALE_UPPER_BOUNDS,
    fallbackTermFontPx: 15,
    chatFontSize: resolveChatFontSizeContract(input.theme),
    rendererHeadingDom: { solid: headingDomContract('solid') },
    measurement: input.measurement ?? null,
  }
}
