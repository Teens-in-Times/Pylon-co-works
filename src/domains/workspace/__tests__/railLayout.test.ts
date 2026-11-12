import { describe, expect, it } from 'vitest'
import { resolveRailLayout, type RailLayoutInput } from '../railLayout.ts'

const preferences: RailLayoutInput = { viewportWidth: 1280, leftEnabled: true, rightEnabled: true, leftCollapsed: false, rightCollapsed: false, leftWidth: 250, rightWidth: 320 }

describe('responsive rail budget', () => {
  it.each([750, 667])('preserves main content and user preferences at %i CSS pixels', viewportWidth => {
    const input = { ...preferences, viewportWidth }
    const result = resolveRailLayout(input)
    expect(result.leftCollapsed).toBe(false)
    expect(result.rightCollapsed).toBe(true)
    expect(result.mainWidth).toBeGreaterThanOrEqual(360)
    expect(input).toEqual({ ...preferences, viewportWidth })
    expect(resolveRailLayout({ ...input, viewportWidth: 1280 })).toMatchObject({ leftWidth: 250, rightWidth: 320, leftCollapsed: false, rightCollapsed: false })
  })

  it('lets the requested rail replace the other in a narrow window without changing its preference', () => {
    const result = resolveRailLayout({ ...preferences, viewportWidth: 750, priority: 'right' })
    expect(result).toMatchObject({ leftCollapsed: true, rightCollapsed: false, rightWidth: 320 })
    expect(result.mainWidth).toBeGreaterThanOrEqual(360)
    expect(resolveRailLayout({ ...preferences, viewportWidth: 1280, priority: 'right' })).toMatchObject({ leftCollapsed: false, rightCollapsed: false })
  })

  it('shrinks both rails above their minimum when both can fit', () => {
    const result = resolveRailLayout({ ...preferences, viewportWidth: 900 })
    expect(result.leftWidth).toBeGreaterThanOrEqual(160)
    expect(result.rightWidth).toBeGreaterThanOrEqual(220)
    expect(result.leftWidth + result.rightWidth + result.mainWidth + 32).toBe(900)
    expect(result.mainWidth).toBeGreaterThanOrEqual(360)
  })

  it('does not reserve space for unavailable or explicitly collapsed rails', () => {
    expect(resolveRailLayout({ ...preferences, leftEnabled: false, rightCollapsed: true })).toMatchObject({ leftWidth: 0, rightWidth: 0, mainWidth: 1248 })
  })

  it('caps drag ranges using the other visible rail and rejects rails that cannot fit', () => {
    const result = resolveRailLayout(preferences)
    expect(result.leftMaxWidth + result.rightWidth + 360 + 32).toBeLessThanOrEqual(1280)
    expect(result.rightMaxWidth + result.leftWidth + 360 + 32).toBeLessThanOrEqual(1280)
    expect(resolveRailLayout({ ...preferences, viewportWidth: 500 })).toMatchObject({ leftCollapsed: true, rightCollapsed: true, canExpandLeft: false, canExpandRight: false })
  })
})
