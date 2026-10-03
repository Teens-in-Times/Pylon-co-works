// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #537 回归：左栏拖拽抬起必须把宽度写进左栏字段（leftRailWidth，clamp 160/520）
 * 并同步落 `pylon-workspace-layout-v3`——此前误写右栏 `setWidth`（右 clamp 220/560），
 * 左栏窄于 220 的拖拽被右栏 clamp 抬高，右栏宽度还被意外改写。
 *
 * 观察点：手柄 pointerup → rail store 的 leftRailWidth → attachSolidPersist 同步写回
 * 的 localStorage 信封（state.leftRailWidth / version=4）。键盘步进同走该字段。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import LeftRailResizeHandle from '../LeftRailResizeHandle.solid.tsx'
import { useRightRailStore } from '../../domains/workspace/layoutRailsStore.ts'
import { resetStores } from '../../test/resetStores'

// attachSolidPersist 的同步写回键（layoutRailsStore 契约键名，版本钉死 4）。
const RAIL_PERSIST_KEY = 'pylon-workspace-layout-v3'

afterEach(cleanup)

describe('#537 左栏拖拽提交写左栏字段并落 v3 持久化', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('拖拽抬起 → setLeftRailWidth → leftRailWidth 落 pylon-workspace-layout-v3', () => {
    const start = useRightRailStore.getState().leftRailWidth
    const { container } = render(() => <LeftRailResizeHandle />)
    const handle = container.querySelector('[data-left-rail-resize]') as HTMLElement
    expect(handle).toBeTruthy()

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 400 })

    // 左栏字段 +100（未经右栏 clamp 220/560 改道）
    expect(useRightRailStore.getState().leftRailWidth).toBe(start + 100)
    // 右栏宽度不被误写
    expect(useRightRailStore.getState().width).toBe(useRightRailStore.getInitialState().width)
    // 同步落 v3 信封
    const persisted = JSON.parse(localStorage.getItem(RAIL_PERSIST_KEY)!) as { state: { leftRailWidth: number }; version: number }
    expect(persisted.state.leftRailWidth).toBe(start + 100)
    expect(persisted.version).toBe(4)
  })

  it('窄于 160 的拖拽落左栏下限（旧路径会被右栏 clamp 抬到 220）', () => {
    const start = useRightRailStore.getState().leftRailWidth
    const { container } = render(() => <LeftRailResizeHandle />)
    const handle = container.querySelector('[data-left-rail-resize]') as HTMLElement

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 - start })

    expect(useRightRailStore.getState().leftRailWidth).toBe(160)
  })

  it('键盘 Home/End 步进同写左栏字段（160/520）', () => {
    const { container } = render(() => <LeftRailResizeHandle />)
    const handle = container.querySelector('[data-left-rail-resize]') as HTMLElement

    fireEvent.keyDown(handle, { key: 'End' })
    expect(useRightRailStore.getState().leftRailWidth).toBe(520)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(useRightRailStore.getState().leftRailWidth).toBe(160)
  })
})
