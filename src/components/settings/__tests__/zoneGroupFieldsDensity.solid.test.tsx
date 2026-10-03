// @vitest-environment jsdom
// #515：迁移自 zoneGroupFieldsDensity.test.tsx（React RTL → Solid 实体直连；
// 断言集原样保留，无改写点）。
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 全局 afterEach(cleanup) 已由 vitest.setup.ts 统一接通（@solidjs/testing-library）；此处显式注册为冗余保险。
afterEach(cleanup)
import { ZoneGroupFields, type RenderCtx } from '../themeFieldRenderer.solid.tsx'

/** K-4：密度档过滤接线（施工书 09 §K-4，拍板 D5-A 无 tier 归标准）。 */

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(vi.fn())
})

const ctxBase = {
  t: {},
  search: '',
} as unknown as RenderCtx

describe('ZoneGroupFields density', () => {
  // P91 C2 恒真修复：原断言 `queryAllByRole('generic').length >= 0` 恒真，
  // 「basic 档只渲染 tier basic 字段」契约实际裸奔——改为 basic 显/进阶隐。
  it('basic 档：tier basic 字段可见，无 tier 字段隐藏', () => {
    render(() => <ZoneGroupFields zone="chat" ctx={ctxBase} density="basic" />)
    // tier basic 的 chat 字段（chatFontSize / chatTextColor）标签可见
    expect(screen.getByText('字号')).toBeInTheDocument()
    expect(screen.getByText('文字')).toBeInTheDocument()
    // 无 tier 的 chat 字段（chatBg「消息流背景色」）在 basic 档不可见
    expect(screen.queryByText('消息流背景色')).toBeNull()
  })

  it('standard 档（默认）：无 tier 字段可见', () => {
    render(() => <ZoneGroupFields zone="chat" ctx={ctxBase} />)
    expect(screen.getByText('消息流背景色')).toBeInTheDocument()
  })
})
