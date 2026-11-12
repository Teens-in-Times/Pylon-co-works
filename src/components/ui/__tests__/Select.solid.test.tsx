// @vitest-environment jsdom
// #515：迁移自 Select.test.tsx（React RTL → Solid 实体直连；断言集原样保留，无改写点）。
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Select from '../Select.solid.tsx'

afterEach(cleanup)

const options = [
  { value: 'auto', label: '自动选择' },
  { value: 'react', label: 'React Renderer' },
  { value: 'solid', label: 'Solid Renderer', disabled: true },
  { value: 'isolated', label: '隔离 Surface' },
]

function Harness() {
  const [value, setValue] = createSignal('auto')
  return <Select id="renderer-select" ariaLabel="渲染引擎" value={value()} options={options} onChange={setValue} />
}

describe('Select', () => {
  it('缺失的持久化选项不冒充第一个值，禁用时关闭已打开的列表', () => {
    let disable!: () => void
    render(() => {
      const [disabled, setDisabled] = createSignal(false)
      disable = () => setDisabled(true)
      return <Select ariaLabel="动态选项" value="removed" options={options} disabled={disabled()} onChange={() => {}} />
    })
    const trigger = screen.getByRole('combobox', { name: '动态选项' })
    expect(trigger).toHaveTextContent('请选择')
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeTruthy()
    disable()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger).toBeDisabled()
  })

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('提供 combobox/listbox/option ARIA 并通过点击提交值', () => {
    render(() => <Harness />)
    const trigger = screen.getByRole('combobox', { name: '渲染引擎' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox', { name: '渲染引擎' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '自动选择' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.mouseDown(screen.getByRole('option', { name: 'React Renderer' }))
    expect(trigger).toHaveTextContent('React Renderer')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('支持方向键、Home/End、Enter 与 Escape，并跳过禁用项', () => {
    render(() => <Harness />)
    const trigger = screen.getByRole('combobox', { name: '渲染引擎' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger).toHaveTextContent('隔离 Surface')

    fireEvent.keyDown(trigger, { key: ' ' })
    fireEvent.keyDown(trigger, { key: 'Home' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger).toHaveTextContent('自动选择')

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('支持首字母检索与 disabled 门禁', () => {
    render(() => <Harness />)
    const trigger = screen.getByRole('combobox', { name: '渲染引擎' })
    fireEvent.keyDown(trigger, { key: 'r' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger).toHaveTextContent('React Renderer')

    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'Solid Renderer' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Solid Renderer' }))
    expect(trigger).toHaveTextContent('React Renderer')
  })
})
