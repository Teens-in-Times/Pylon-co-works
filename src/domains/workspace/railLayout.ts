/** Pure viewport budget for the shell. Effective geometry never overwrites persisted rail preferences. */
import { clampLeftRailWidth, clampRightRailWidth, LEFT_RAIL_MIN_WIDTH, LEFT_RAIL_MAX_WIDTH, RIGHT_RAIL_MIN_WIDTH, RIGHT_RAIL_MAX_WIDTH } from './layoutRailsStore.ts'

export interface RailLayoutInput {
  viewportWidth: number
  leftEnabled: boolean
  rightEnabled: boolean
  leftCollapsed: boolean
  rightCollapsed: boolean
  leftWidth: number
  rightWidth: number
  priority?: 'left' | 'right'
}

export interface RailLayout {
  leftCollapsed: boolean
  rightCollapsed: boolean
  leftWidth: number
  rightWidth: number
  leftMaxWidth: number
  rightMaxWidth: number
  canExpandLeft: boolean
  canExpandRight: boolean
  mainWidth: number
}

const MAIN_MIN_WIDTH = 360
// Covers modern-mode canvas padding, rail gaps and borders in CSS pixels.
const SHELL_SPACE = 32

export function resolveRailLayout(input: RailLayoutInput): RailLayout {
  const width = Number.isFinite(input.viewportWidth) ? Math.max(0, input.viewportWidth) : 0
  const contentWidth = Math.max(0, width - SHELL_SPACE)
  const budget = Math.max(0, contentWidth - MAIN_MIN_WIDTH)
  const leftRequested = input.leftEnabled && !input.leftCollapsed
  const rightRequested = input.rightEnabled && !input.rightCollapsed
  let leftWidth = leftRequested ? clampLeftRailWidth(input.leftWidth) : 0
  let rightWidth = rightRequested ? clampRightRailWidth(input.rightWidth) : 0

  if (leftWidth + rightWidth > budget) {
    const leftMin = leftRequested ? LEFT_RAIL_MIN_WIDTH : 0
    const rightMin = rightRequested ? RIGHT_RAIL_MIN_WIDTH : 0
    if (leftMin + rightMin <= budget) {
      // Share the remaining space in proportion to each preferred width's
      // flexible portion. Both rails retain their usable minimum.
      const extra = budget - leftMin - rightMin
      const flexible = leftWidth + rightWidth - leftMin - rightMin
      leftWidth = leftMin + Math.floor(extra * (leftWidth - leftMin) / flexible)
      rightWidth = rightMin + Math.floor(extra * (rightWidth - rightMin) / flexible)
    } else {
      const rightFirst = input.priority === 'right' && rightRequested && budget >= RIGHT_RAIL_MIN_WIDTH
      if (!rightFirst && leftRequested && budget >= LEFT_RAIL_MIN_WIDTH) {
        leftWidth = Math.min(leftWidth, budget)
        rightWidth = 0
      } else if (rightRequested && budget >= RIGHT_RAIL_MIN_WIDTH) {
        rightWidth = Math.min(rightWidth, budget)
        leftWidth = 0
      } else { leftWidth = 0; rightWidth = 0 }
    }
  }

  return {
    leftCollapsed: leftWidth === 0,
    rightCollapsed: rightWidth === 0,
    leftWidth, rightWidth,
    leftMaxWidth: Math.min(LEFT_RAIL_MAX_WIDTH, Math.max(LEFT_RAIL_MIN_WIDTH, budget - rightWidth)),
    rightMaxWidth: Math.min(RIGHT_RAIL_MAX_WIDTH, Math.max(RIGHT_RAIL_MIN_WIDTH, budget - leftWidth)),
    canExpandLeft: input.leftEnabled && budget >= LEFT_RAIL_MIN_WIDTH,
    canExpandRight: input.rightEnabled && budget >= RIGHT_RAIL_MIN_WIDTH,
    mainWidth: contentWidth - leftWidth - rightWidth,
  }
}
