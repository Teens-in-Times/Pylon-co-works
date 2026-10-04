import { resolveFrameIndex, type SpinnerMotionKind } from './spinnerMotion.ts'

/**
 * spinnerMachine — CC 对齐的 spinner 纯状态机（零框架依赖，可单测）。
 *
 * 分层：activity（活动状态，阈值驱动）→ frame（帧索引，时间驱动）→
 * glimmer（光扫窗口，CC ±1 字符）→ verb（动词源，事件/配置驱动）。
 * 所有派生为纯函数：输入（时间/事件/配置）→ 输出（当前状态）。
 * 主题字段（帧预设/动词集/颜色/间隔/自定义帧与动词）全部保留为输入。
 */

export type SpinnerActivity = 'active' | 'waiting' | 'stalled'

/** 给远端 ACP/provider 留出正常首包与工具调度时间，避免短暂抖动过早显示为迟滞。 */
export const ACTIVITY_THRESHOLDS = { waitingMs: 3000, stalledMs: 10000 } as const

/** stalled 渐变红斜坡：超过 stalledMs 后 3s 内从 0 渐进到 1（P1-08 强度递增） */
export const STALL_RAMP_MS = 3000

export function resolveActivity(idleMs: number): SpinnerActivity {
  if (idleMs > ACTIVITY_THRESHOLDS.stalledMs) return 'stalled'
  if (idleMs > ACTIVITY_THRESHOLDS.waitingMs) return 'waiting'
  return 'active'
}

/** stalled 颜色插值强度：stalledMs 前 0，之后按斜坡线性递增，封顶 1（P1-08） */
export function resolveStallProgress(idleMs: number): number {
  const over = idleMs - ACTIVITY_THRESHOLDS.stalledMs
  if (over <= 0) return 0
  return Math.min(1, over / STALL_RAMP_MS)
}

export interface FrameState {
  index: number
  char: string
}

export function resolveFrame(
  frames: readonly string[],
  elapsedMs: number,
  intervalMs: number,
  motion: SpinnerMotionKind,
  direction?: 'forward' | 'reverse' | 'alternate',
): FrameState {
  const safe = frames.length > 0 ? frames : ['·']
  const index = resolveFrameIndex({ frameCount: safe.length, elapsedMs, intervalMs, motion, direction })
  return { index, char: safe[index] }
}

/**
 * CC 光扫：±1 字符窗口——glimmerIndex-1 到 +1 三字符同时变亮，
 * 中间 core（最亮）、两侧 edge（次亮），其余不变。速度按 cycleMs/（长度+20）。
 */
export interface GlimmerState {
  glimmerIndex: number
  speedMs: number
}

export function resolveGlimmer(text: string, elapsedMs: number, cycleMs: number): GlimmerState {
  const graphemes = [...text]
  const speedMs = Math.max(80, Math.floor(cycleMs / Math.max(1, graphemes.length + 20)))
  const cycleLength = graphemes.length + 20
  const cyclePosition = Math.floor((elapsedMs % cycleMs) / speedMs)
  const glimmerIndex = (cyclePosition % cycleLength) - 10
  return { glimmerIndex, speedMs }
}

/** 字符光扫强度：0 普通 / 1 edge（±1 窗口两侧）/ 2 core（窗口中心） */
export function glimmerIntensity(index: number, glimmerIndex: number): 0 | 1 | 2 {
  const distance = Math.abs(index - glimmerIndex)
  if (distance <= 0) return 2
  if (distance <= 1) return 1
  return 0
}
