// @vitest-environment jsdom
// #515：迁移自 FontContributionPicker.test.tsx（React RTL → Solid 实体直连；
// 断言集原样保留，无改写点）。
import { cleanup, render } from '@solidjs/testing-library'
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
