import { describe, expect, it } from 'vitest'
import { getSkinSchema } from '../skinSchema.ts'
import { SKIN_CSS_MAX_LENGTH, validateSkinDraft } from '../skinValidation.ts'
import type { SkinDraft } from '../skinTypes.ts'

const schema = getSkinSchema()

function makeDraft(overrides: Partial<SkinDraft> = {}): SkinDraft {
  return {
    draftId: 'draft-test',
    name: '测试皮肤',
    tokens: {},
    variants: {},
    assets: {},
    revision: 1,
    status: 'editing',
    ...overrides,
  }
}

describe('Skin Draft 校验（S5-B）', () => {
  it('未知 token 产生 structured error', () => {
    const result = validateSkinDraft(makeDraft({ tokens: { 'not-a-field': '#fff' } }), schema)

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      path: 'tokens.not-a-field',
      code: 'unknown-token',
    }))
  })

  it('number 类型错误与越界分别报错', () => {
    const badType = validateSkinDraft(makeDraft({ tokens: { transparency: '0.5' } }), schema)
    expect(badType.issues).toContainEqual(expect.objectContaining({ path: 'tokens.transparency', code: 'invalid-type' }))

    const tooLow = validateSkinDraft(makeDraft({ tokens: { transparency: -1 } }), schema)
    expect(tooLow.issues).toContainEqual(expect.objectContaining({ path: 'tokens.transparency', code: 'number-out-of-range' }))

    const tooHigh = validateSkinDraft(makeDraft({ tokens: { transparency: 2 } }), schema)
    expect(tooHigh.issues).toContainEqual(expect.objectContaining({ path: 'tokens.transparency', code: 'number-out-of-range' }))
  })

  it('select 非法选项报错；已布尔化的历史字段拒绝枚举值', () => {
    const invalid = validateSkinDraft(makeDraft({ tokens: { uiScheme: 'blue' } }), schema)
    expect(invalid.issues).toContainEqual(expect.objectContaining({ path: 'tokens.uiScheme', code: 'invalid-option' }))

    // inputShowHistoryHint 已由 select+boolean default 归一为纯 boolean（★ #266 CC-08）
    // ★ #266 CC-07：原样本 `inputShowPlaceholder` 已删除 ⇒ 同族 `inputShowHistoryHint` 顶上，
    //   锁的是「字段仍收 boolean」与「老枚举值不再被接受」这两件事。
    const asBoolean = validateSkinDraft(makeDraft({ tokens: { inputShowHistoryHint: true } }), schema)
    expect(asBoolean.valid).toBe(true)

    const asOption = validateSkinDraft(makeDraft({ tokens: { inputShowHistoryHint: 'shown' } }), schema)
    expect(asOption.issues).toContainEqual(expect.objectContaining({ path: 'tokens.inputShowHistoryHint', code: 'invalid-type' }))
  })

  it('boolean/text/color 类型错误结构化返回', () => {
    const badBool = validateSkinDraft(makeDraft({ tokens: { showSidebar: 'yes' } }), schema)
    expect(badBool.issues).toContainEqual(expect.objectContaining({ path: 'tokens.showSidebar', code: 'invalid-type' }))

    const badText = validateSkinDraft(makeDraft({ tokens: { userName: 42 } }), schema)
    expect(badText.issues).toContainEqual(expect.objectContaining({ path: 'tokens.userName', code: 'invalid-type' }))

    const badColor = validateSkinDraft(makeDraft({ tokens: { accent: 42 } }), schema)
    expect(badColor.issues).toContainEqual(expect.objectContaining({ path: 'tokens.accent', code: 'invalid-type' }))
  })

  it('variants 组件与取值按 schema.componentVariants 白名单', () => {
    const unknownComponent = validateSkinDraft(makeDraft({ variants: { ghost: 'cli' } }), schema)
    expect(unknownComponent.issues).toContainEqual(expect.objectContaining({ path: 'variants.ghost', code: 'unknown-token' }))

    const badVariant = validateSkinDraft(makeDraft({ variants: { 'input-bar': 'ghost' } }), schema)
    expect(badVariant.issues).toContainEqual(expect.objectContaining({ path: 'variants.input-bar', code: 'invalid-option' }))

    const valid = validateSkinDraft(makeDraft({ variants: { 'input-bar': 'cli', 'tool-call': 'running' } }), schema)
    expect(valid.valid).toBe(true)
  })

  it('css 拒绝根选择器、资源加载和过长度，接受 scoped css', () => {
    const scoped = validateSkinDraft(makeDraft({ css: '[data-pylon-component="message"] { color: red; }' }), schema)
    expect(scoped.valid).toBe(true)

    for (const css of [
      'html { color: red; }',
      'body { color: red; }',
      ':root { --x: 1; }',
      '* { box-sizing: border-box; }',
      '@import url("x.css");',
      'a { background: url(x.png); }',
      'a { width: expression(1); }',
      'a { color: red; }</style>',
    ]) {
      const result = validateSkinDraft(makeDraft({ css }), schema)
      expect(result.valid, css).toBe(false)
    }

    const tooLong = validateSkinDraft(makeDraft({ css: `[data-pylon-component="message"] { color: red; }`.padEnd(SKIN_CSS_MAX_LENGTH + 1, ' ') }), schema)
    expect(tooLong.issues).toContainEqual(expect.objectContaining({ code: 'css-too-long' }))
  })

  it('assets 只接受含字符串 id 的对象', () => {
    const invalid = validateSkinDraft(makeDraft({ assets: { bg: { id: 1 } as never } }), schema)
    expect(invalid.issues).toContainEqual(expect.objectContaining({ path: 'assets.bg', code: 'invalid-type' }))

    const valid = validateSkinDraft(makeDraft({ assets: { bg: { id: 'asset-1' } } }), schema)
    expect(valid.valid).toBe(true)
  })
})
