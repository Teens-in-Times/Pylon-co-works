// @vitest-environment jsdom
// #515：迁移自 themeFieldControlRich.test.tsx（React RTL → Solid 实体直连；
// 断言集原样保留，无改写点）。
import { cleanup, render, screen, within } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'

// 全局 afterEach(cleanup) 已由 vitest.setup.ts 统一接通（@solidjs/testing-library）；此处显式注册为冗余保险。
afterEach(cleanup)
import { ZoneGroupFields, type RenderCtx } from '../themeFieldRenderer.solid.tsx'
import { THEME_DEFAULTS } from '../../../domains/theme/themeFieldDefs'

/** T1 第一批：链A control 丰富——segmented 覆盖 + assistantDotImage 文件选择。 */

function makeCtx(overrides: Record<string, unknown> = {}): RenderCtx {
  return {
    t: { ...THEME_DEFAULTS, ...overrides } as unknown as RenderCtx['t'],
    onChange: () => {},
    search: '',
  }
}

describe('T1-B segmented control 覆盖（control=segmented 的 select 渲染按钮组）', () => {
  it('消息风格（terminal/bubble 二值）渲染可访问单选组而非下拉', () => {
    render(() => <ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    // segmented 容器以 aria-label=字段名（「消息风格」）暴露为 radiogroup
    expect(screen.getByRole('radiogroup', { name: '消息风格' })).toBeInTheDocument()
  })

  it('segmented 组内含 optionLabels 文本的选项（终端记录流/对话气泡）', () => {
    render(() => <ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    // 限定在「消息风格」组内断言——「对话气泡」同时是消息布局组的选项
    const msgStyleGroup = screen.getByRole('radiogroup', { name: '消息风格' })
    expect(within(msgStyleGroup).getByRole('radio', { name: '终端记录流' })).toBeInTheDocument()
    expect(within(msgStyleGroup).getByRole('radio', { name: '对话气泡' })).toBeInTheDocument()
  })
})

describe('T1-A assistantDotImage bgImage control', () => {
  it('头像图标字段渲染文件选择按钮', () => {
    render(() => <ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    expect(screen.getByRole('button', { name: '选择' })).toBeInTheDocument()
  })
})
