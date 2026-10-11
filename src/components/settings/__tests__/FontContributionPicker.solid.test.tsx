// @vitest-environment jsdom
// #515：迁移自 FontContributionPicker.test.tsx（React RTL → Solid 实体直连；
// 断言集原样保留，无改写点）。
import { createSignal } from 'solid-js'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'

// 全局 afterEach(cleanup) 已由 vitest.setup.ts 统一接通（@solidjs/testing-library）；此处显式注册为冗余保险。
afterEach(cleanup)
import FontContributionPicker from '../FontContributionPicker.solid.tsx'

describe('FontContributionPicker role-safe preview', () => {
  it('previews the code fallback when the selected contribution is unavailable', () => {
    const result = render(() => <FontContributionPicker
      value="vendor.missing-code"
      role="code"
      ariaLabel="代码与路径字体"
      settingTarget="theme.codeFont"
      onChange={() => {}}
    />)

    // #129 子项 3：断言收紧为生产真值全链（resolveFontToken 的 code 回退）——
    // 旧断言 `var(--mono)` 与生产真值就差着一层 fallback。
    expect(result.container.querySelector<HTMLElement>('.font-contribution-sample')?.style.fontFamily)
      .toBe('var(--font-mono-default, var(--mono))')
  })

  it('previews the interface fallback when the selected contribution is unavailable', () => {
    const result = render(() => <FontContributionPicker
      value="vendor.missing-ui"
      role="interface"
      ariaLabel="界面字体"
      settingTarget="theme.globalFont"
      onChange={() => {}}
    />)

    // #129 子项 3：`inherit` 取的是当前页面字体（用户所选界面字体），而生产侧
    // resolveFontToken 对不可用贡献回退 `var(--font-system, var(--font))`——预览
    // 与真实渲染不一致（上次只修了 code 角色的同型问题）。现取生产同一函数。
    expect(result.container.querySelector<HTMLElement>('.font-contribution-sample')?.style.fontFamily)
      .toBe('var(--font-system, var(--font))')
  })

  it('previews the content-role fallback like the interface role (same resolver)', () => {
    const result = render(() => <FontContributionPicker
      value="vendor.missing-content"
      role="content"
      ariaLabel="正文渲染字体"
      settingTarget="theme.msgFont"
      onChange={() => {}}
    />)

    expect(result.container.querySelector<HTMLElement>('.font-contribution-sample')?.style.fontFamily)
      .toBe('var(--font-system, var(--font))')
  })
})

// CC-21：可选「跟随」首项（仅 inputFont 传入）——哨兵不当不可用贡献、不当字体 id，
// 示例实时随消息字体；未传跟随项的其它字体菜单行为不变。
describe('CC-21 可选跟随项', () => {
  const follow = { label: '跟随消息字体', value: 'follow-message', previewFamily: () => 'var(--font-serif-default, var(--serif))' }

  it('跟随态：菜单首项为跟随项、无「已不可用」伪项，示例取 previewFamily 而非回退链', () => {
    const result = render(() => <FontContributionPicker
      value="follow-message" role="content" ariaLabel="输入栏字体" settingTarget="theme.inputFont"
      followOption={follow} onChange={() => {}}
    />)
    const trigger = screen.getByRole('combobox', { name: '输入栏字体' })
    expect(trigger.textContent).toContain('跟随消息字体')
    expect(trigger.textContent).not.toContain('已不可用')
    expect(result.container.querySelector<HTMLElement>('.font-contribution-sample')?.style.fontFamily)
      .toBe('var(--font-serif-default, var(--serif))')
  })

  it('跟随示例实时随消息字体（previewFamily 为访问器，外部信号变化即刷新）', async () => {
    const [msgFamily, setMsgFamily] = createSignal('var(--font-mono-default, var(--mono))')
    const result = render(() => <FontContributionPicker
      value="follow-message" role="content" ariaLabel="输入栏字体" settingTarget="theme.inputFont"
      followOption={{ label: '跟随消息字体', value: 'follow-message', previewFamily: msgFamily }} onChange={() => {}}
    />)
    expect(result.container.querySelector<HTMLElement>('.font-contribution-sample')?.style.fontFamily)
      .toBe('var(--font-mono-default, var(--mono))')
    setMsgFamily('var(--font-serif-default, var(--serif))')
    await waitFor(() => expect(result.container.querySelector<HTMLElement>('.font-contribution-sample')?.style.fontFamily)
      .toBe('var(--font-serif-default, var(--serif))'))
  })

  it('插件字体已不可用：跟随项固定最前、选中 id 原样置顶展示，不自动改跟随', () => {
    render(() => <FontContributionPicker
      value="vendor.missing" role="content" ariaLabel="输入栏字体" settingTarget="theme.inputFont"
      followOption={follow} onChange={() => {}}
    />)
    fireEvent.click(screen.getByRole('combobox', { name: '输入栏字体' }))
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options[0].textContent).toContain('跟随消息字体')
    expect(options[1].textContent).toContain('vendor.missing（已不可用）')
  })

  it('未传跟随项的其它字体菜单不变：不可用项照旧置顶，菜单无跟随项', () => {
    render(() => <FontContributionPicker
      value="vendor.missing" role="content" ariaLabel="正文渲染字体" settingTarget="theme.msgFont"
      onChange={() => {}}
    />)
    fireEvent.click(screen.getByRole('combobox', { name: '正文渲染字体' }))
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options[0].textContent).toContain('vendor.missing（已不可用）')
    expect(options.some(option => option.textContent.includes('跟随消息字体'))).toBe(false)
  })
})
