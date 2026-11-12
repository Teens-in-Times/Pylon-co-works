// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal, Show } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDialogFocus } from '../dialogFocus'
import Select from '../Select.solid.tsx'

afterEach(cleanup)

function Dialog(props: { close(): void }) {
  let element: HTMLDivElement | undefined
  createDialogFocus(() => element, () => true, props.close)
  return <div ref={node => { element = node }} role="dialog" aria-modal="true">
    <input aria-label="名称" autofocus />
    <button disabled>不可用</button>
    <Select ariaLabel="选项" value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />
    <button onClick={props.close}>关闭</button>
    <div style={{ display: 'none' }}><button>隐藏区操作</button></div>
  </div>
}

describe('dialog focus lifecycle', () => {
  it('打开后聚焦、Tab 双向循环、关闭恢复触发按钮', async () => {
    function Harness() {
      const [open, setOpen] = createSignal(false)
      return <><button onClick={() => setOpen(true)}>打开</button><Show when={open()}><Dialog close={() => setOpen(false)} /></Show></>
    }
    render(() => <Harness />)
    const trigger = screen.getByRole('button', { name: '打开' })
    trigger.focus()
    fireEvent.click(trigger)
    const input = screen.getByRole('textbox', { name: '名称' })
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('先关闭内部下拉框，组合输入的 Escape 不关闭弹窗', async () => {
    const close = vi.fn()
    render(() => <Dialog close={close} />)
    const select = screen.getByRole('combobox')
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
    select.focus()
    fireEvent.click(select)
    fireEvent.keyDown(select, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(select, { key: 'Escape', isComposing: true })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(select, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('卸载移除键盘监听，不在其他页面残留焦点陷阱', async () => {
    const close = vi.fn()
    const view = render(() => <Dialog close={close} />)
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
    view.unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })
})
