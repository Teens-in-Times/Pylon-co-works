// @vitest-environment jsdom

/**
 * CSS-01：P6 typography computed style 基线单元测试（CSS-02/03 已合入：heading class contract
 * 就位 + px contract fallback 消除）。
 *
 * 覆盖：聊天字号 px contract 解析（def 单一真值表 unit=px；非 px 分支 null）；
 * heading DOM/class contract（CSS-02 后 Solid renderer 输出 term-h1~term-h6）；
 * 结构性常量（HEADING_CLASS_CONTRACT_IN_PLACE=true、PX_CONTRACT_FALLBACK_SAFE=true、
 * fallback=15px）；证据登记（file:line / fallback / 完整 h1-h6 规则 + Solid renderer class contract）；
 * 工件组装；DOM computed style 采样（.term/h1-h6 相对 body 比例；缺元素 → null 防御）。
 * 只读取证，不修改任何 CSS（视觉改动属 CSS-02/03）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildTypographyBaselineArtifact,
  captureComputedStyleBaseline,
  headingDomContract,
  HEADING_SCALE_UPPER_BOUNDS,
  resolveChatFontSizeContract,
  TYPOGRAPHY_EVIDENCE,
} from '../typographyBaseline'

describe('resolveChatFontSizeContract（px contract）', () => {
  it('def 真值：chatFontSize unit=px（themeFieldDefs 单一真值表）→ cssVarValue "15px" + px 数值', () => {
    const contract = resolveChatFontSizeContract({ chatFontSize: 15 })
    expect(contract.unit).toBe('px')
    expect(contract.cssVarValue).toBe('15px')
    expect(contract.px).toBe(15)
  })

  it('非 px 单位 → px=null（非 px contract 信号；15pt fallback 风险态）', () => {
    expect(resolveChatFontSizeContract({ chatFontSize: 15 }, 'pt').px).toBeNull()
    expect(resolveChatFontSizeContract({ chatFontSize: 15 }, 'pt').cssVarValue).toBe('15pt')
  })
})

describe('headingDomContract（renderer DOM/class contract）', () => {
  it('Solid renderer：h1-h6 原生标签 + term-h1~term-h6 class contract（CSS-02 起）+ 源码证据', () => {
    const dom = headingDomContract('solid')
    expect(dom).toHaveLength(6)
    expect(dom.map(level => level.tag)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    expect(dom.map(level => level.className)).toEqual(['term-h1', 'term-h2', 'term-h3', 'term-h4', 'term-h5', 'term-h6'])
    expect(dom[0].source).toBe(TYPOGRAPHY_EVIDENCE.renderers.solid.file)
  })
})

describe('结构性常量与证据登记', () => {
  it('证据登记：.term fallback=15px / --chat-font-size（px 契约）', () => {
    expect(TYPOGRAPHY_EVIDENCE.termRule.fontSizeFallback).toBe('15px')
    expect(TYPOGRAPHY_EVIDENCE.termRule.cssVar).toBe('--chat-font-size')
  })

  it('建议比例上限（方案书 §5.15）：全 6 级正值 + 逐级上限 + 单调不增（h1 最高 h6 最低，CR-314 消化）', () => {
    const bounds = HEADING_SCALE_UPPER_BOUNDS
    const levels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const
    for (const level of levels) expect(bounds[level]).toBeGreaterThan(0)
    expect(bounds.h1).toBeLessThanOrEqual(1.30)
    expect(bounds.h2).toBeLessThanOrEqual(1.20)
    expect(bounds.h3).toBeLessThanOrEqual(1.12)
    expect(bounds.h4).toBeLessThanOrEqual(1.06)
    expect(bounds.h5).toBeLessThanOrEqual(1.0)
    expect(bounds.h6).toBeLessThanOrEqual(1.0)
    expect(bounds.h1).toBeGreaterThanOrEqual(bounds.h2)
    expect(bounds.h2).toBeGreaterThanOrEqual(bounds.h3)
    expect(bounds.h3).toBeGreaterThanOrEqual(bounds.h4)
    expect(bounds.h4).toBeGreaterThanOrEqual(bounds.h5)
    expect(bounds.h5).toBeGreaterThanOrEqual(bounds.h6)
  })
})

describe('buildTypographyBaselineArtifact（工件组装）', () => {
  it('schemaVersion/evidence/px contract/Solid renderer DOM contract/无 DOM 测量时为 null', () => {
    const artifact = buildTypographyBaselineArtifact({ phase: 'baseline', theme: { chatFontSize: 15 } })
    expect(artifact.tool).toBe('css01-typography-baseline')
    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.phase).toBe('baseline')
    expect(artifact.headingClassContractInPlace).toBe(true) // CSS-02 翻转
    expect(artifact.pxContractFallbackSafe).toBe(true) // CSS-03 翻转
    expect(artifact.fallbackTermFontPx).toBe(15)
    expect(artifact.chatFontSize).toMatchObject({ unit: 'px', cssVarValue: '15px', px: 15 })
    expect(artifact.rendererHeadingDom.solid).toHaveLength(6)
    expect(artifact.measurement).toBeNull()
  })
})

describe('captureComputedStyleBaseline（DOM 采样）', () => {
  it('.term 采样 + 缺 heading 防御：无 h1 时 headings.h1=null、ratios.h1=null', () => {
    const scope = document.createElement('div')
    scope.innerHTML = '<div class="term" style="font-size:15px;font-family:mono;line-height:1.35"></div>'
    document.body.appendChild(scope)
    try {
      const m = captureComputedStyleBaseline(scope)
      expect(m.term).not.toBeNull()
      expect(m.term!.fontSizePx).toBe(15)
      expect(m.term!.fontFamily).toBe('mono')
      expect(m.headings.h1).toBeNull()
      expect(m.ratios.h1).toBeNull()
      expect(m.termAssistant).toBeNull()
    } finally {
      scope.remove()
    }
  })

  it('heading 相对 body 比例（§5.15 建议比例对照）：h1=20px/15px、h3=16px/15px；缺 h2 → null', () => {
    const scope = document.createElement('div')
    scope.innerHTML = '<h1 style="font-size:20px">t</h1><h3 style="font-size:16px">t</h3>'
    document.body.style.fontSize = '15px'
    document.body.appendChild(scope)
    try {
      const m = captureComputedStyleBaseline(scope)
      expect(m.body?.fontSizePx).toBe(15)
      expect(m.ratios.h1).not.toBeNull()
      expect(m.ratios.h1!).toBeCloseTo(20 / 15, 5)
      expect(m.ratios.h3!).toBeCloseTo(16 / 15, 5)
      expect(m.ratios.h2).toBeNull()
    } finally {
      scope.remove()
      document.body.style.fontSize = ''
    }
  })

  it('空 scope 防御：body 有值，.term/全部 heading 为 null，不报错', () => {
    const scope = document.createElement('div')
    document.body.appendChild(scope)
    try {
      const m = captureComputedStyleBaseline(scope)
      expect(m.body).not.toBeNull()
      expect(m.term).toBeNull()
      expect(m.headings.h1).toBeNull()
      expect(m.headings.h6).toBeNull()
      expect(m.ratios.h1).toBeNull()
    } finally {
      scope.remove()
    }
  })
})
