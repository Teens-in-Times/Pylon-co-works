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

  it('preserves a reading column while both rails are open and restores the preferred widths on resize', () => {
    expect(resolveRailLayout({ ...preferences, viewportWidth: 880 })).toMatchObject({
      leftCollapsed:false, rightCollapsed:false, leftWidth:160, rightWidth:220, mainWidth:468,
    })
    const medium = resolveRailLayout({ ...preferences, viewportWidth: 960 })
    expect(medium.leftWidth).toBeGreaterThan(160)
    expect(medium.rightWidth).toBeGreaterThan(220)
    expect(medium.mainWidth).toBeGreaterThanOrEqual(480)
    expect(resolveRailLayout(preferences)).toMatchObject({ leftWidth:250, rightWidth:320 })
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
