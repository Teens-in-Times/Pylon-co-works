// @vitest-environment jsdom
// #515：React 原件（components/file/CollapsibleRegion.tsx）判重退役——唯一实体是
// renderers/solid-workbench/chat/CollapsibleRegion.solid.tsx，本测试随迁到该实体，
// 断言集与 React 版逐一对应（未缩减；Fixture 的 useState 改 createSignal）。
// #520 K 域：自空壳 components/file/__tests__/ 迁至实体旁（原目录随之撤销）。
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidCollapsibleRegion } from '../CollapsibleRegion.solid.tsx'

function Fixture() {
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <button type="button" aria-expanded={open()} aria-controls="content" onClick={() => setOpen(value => !value)}>切换</button>
      <SolidCollapsibleRegion open={open()} id="content"><p>保持挂载的正文</p></SolidCollapsibleRegion>
    </>
  )
}

afterEach(() => cleanup())

describe('CollapsibleRegion', () => {
  it('折叠时保留正文以支持退场动画，同时从可访问树隐藏', () => {
    const { container } = render(() => <Fixture />)
    const region = container.querySelector('.term-collapse')
    expect(region).toHaveAttribute('data-open', 'false')
    expect(region).toHaveAttribute('aria-hidden', 'true')
    expect(region?.textContent).toContain('保持挂载的正文')

    fireEvent.click(screen.getByRole('button', { name: '切换' }))
    expect(region).toHaveAttribute('data-open', 'true')
    expect(region).toHaveAttribute('aria-hidden', 'false')
    expect(container.querySelector('#content')).not.toBeNull()
  })
})
