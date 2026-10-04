// @vitest-environment jsdom
// #515：迁移自 ConfigOptionField.a11y.test.tsx（React RTL → Solid 实体直连）。
// 断言改写点登记：
// 1. fireEvent.change（number/text 受控输入）→ fireEvent.input（Solid onInput
//    语义等价于 React onChange 的即时输入流；原生 change 在 Solid 下仅 blur 触发）。
// 2. React `view.rerender(...)` → 信号驱动的 props 重发（Solid 无 rerender：
//    用 createSignal 包 option，setOption 触发实体 props 更新，语义等价）。
// 3. useId（React）→ createUniqueId（Solid）：控件 id 形态断言
//    `/^config-option-model-.+/` 与唯一性契约原样保留。
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 全局 afterEach(cleanup) 已由 vitest.setup.ts 统一接通（@solidjs/testing-library）；此处显式注册为冗余保险。
afterEach(cleanup)
import ConfigOptionField from '../ConfigOptionField.solid.tsx'
import { normalizeConfigOption } from '../configOptionState.ts'

/** 由 label 正文定位 label 元素，再经 for 取关联控件（labelable 与否均适用）。 */
function controlOf(labelText: string): HTMLElement {
  const label = screen.getByText(labelText).closest('label')
  expect(label).not.toBeNull()
  const control = document.getElementById((label as HTMLLabelElement).htmlFor)
  expect(control).not.toBeNull()
  expect((control as HTMLElement).id).toBe((label as HTMLLabelElement).htmlFor)
  return control as HTMLElement
}

describe('ConfigOptionField a11y 关联（迁移自 test-config-option-field-boundary.mts 源码正则段）', () => {
  it('select 用共享可访问 Select：label/id 关联，value 与候选 label 取 choice.id/choice.label', () => {
    const onChange = vi.fn()
    const option = normalizeConfigOption({
      id: 'model',
      type: 'select',
      currentValue: 'sonnet',
      label: '执行模型',
      options: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }],
    })
    render(() => <ConfigOptionField option={option} onChange={onChange} />)

    const trigger = controlOf('执行模型') as HTMLButtonElement
    expect(trigger).toHaveAttribute('role', 'combobox')
    expect(trigger).toHaveTextContent('Sonnet')

    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeInTheDocument()
    const target = screen.getByRole('option', { name: 'Opus' })
    fireEvent.mouseDown(target)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('opus')
  })

  it('disabled 透传到控件', () => {
    const option = normalizeConfigOption({ id: 'model', type: 'select', currentValue: 'sonnet', label: '执行模型', options: [{ id: 'sonnet', name: 'Sonnet' }] })
    render(() => <ConfigOptionField option={option} disabled onChange={vi.fn()} />)
    const trigger = controlOf('执行模型') as HTMLButtonElement
    expect(trigger).toBeDisabled()
  })

  it('boolean：checkbox checked=Boolean(currentValue)，onChange 收到布尔勾选态', async () => {
    const onChange = vi.fn()
    const off = normalizeConfigOption({ id: 'enabled', type: 'boolean', currentValue: false, label: '启用' })
    const on = normalizeConfigOption({ id: 'enabled', type: 'boolean', currentValue: true, label: '启用' })
    const [option, setOption] = createSignal(off)
    render(() => <ConfigOptionField option={option()} onChange={onChange} />)
    const checkbox = controlOf('启用') as HTMLInputElement
    expect(checkbox).toHaveAttribute('type', 'checkbox')
    expect(checkbox.checked).toBe(false)

    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)

    setOption(on)
    await Promise.resolve()
    expect(checkbox.checked).toBe(true)
  })

  it('number：初始值取 String(currentValue)，非法文本不上抛，合法 0 提交为数值 0', () => {
    const onChange = vi.fn()
    const option = normalizeConfigOption({ id: 'temperature', type: 'number', currentValue: 0, label: '温度' })
    render(() => <ConfigOptionField option={option} onChange={onChange} />)
    const input = controlOf('温度') as HTMLInputElement
    expect(input).toHaveAttribute('type', 'number')
    expect(input.value).toBe('0')

    fireEvent.input(input, { target: { value: 'not-a-number' } })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.input(input, { target: { value: '0' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('number：currentValue 为空串时输入框保持空态，清空不上抛', () => {
    const onChange = vi.fn()
    const option = normalizeConfigOption({ id: 'temperature', type: 'number', currentValue: '', label: '温度' })
    render(() => <ConfigOptionField option={option} onChange={onChange} />)
    const input = controlOf('温度') as HTMLInputElement
    expect(input.value).toBe('')

    fireEvent.input(input, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('string：text input value=String(currentValue)，onChange 收到输入文本', () => {
    const onChange = vi.fn()
    const option = normalizeConfigOption({ id: 'name', type: 'string', currentValue: '', label: '名称' })
    render(() => <ConfigOptionField option={option} onChange={onChange} />)
    const input = controlOf('名称') as HTMLInputElement
    expect(input).toHaveAttribute('type', 'text')
    expect(input.value).toBe('')

    fireEvent.input(input, { target: { value: 'piper' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('piper')
  })

  it('unknown：label for 关联 code 节点，内容为 JSON.stringify(currentValue)', () => {
    const option = normalizeConfigOption({ id: 'future', type: 'future-type', currentValue: { enabled: true, limit: 3 }, label: '未知项' })
    render(() => <ConfigOptionField option={option} onChange={vi.fn()} />)
    const raw = controlOf('未知项')
    expect(raw.tagName).toBe('CODE')
    expect(raw).toHaveClass('config-option-raw')
    expect(raw).toHaveTextContent('{"enabled":true,"limit":3}')
  })

  it('五类控件各有一组 for ↔ id 关联，控件 id 互不相同', () => {
    const options = [
      normalizeConfigOption({ id: 'model', type: 'select', currentValue: 'sonnet', label: '执行模型', options: [{ id: 'sonnet', name: 'Sonnet' }] }),
      normalizeConfigOption({ id: 'enabled', type: 'boolean', currentValue: true, label: '启用' }),
      normalizeConfigOption({ id: 'temperature', type: 'number', currentValue: 1, label: '温度' }),
      normalizeConfigOption({ id: 'name', type: 'string', currentValue: '', label: '名称' }),
      normalizeConfigOption({ id: 'future', type: 'future-type', currentValue: { raw: 1 }, label: '未知项' }),
    ]
    render(() => <div>{options.map(option => <ConfigOptionField option={option} onChange={() => {}} />)}</div>)

    const htmlForSet = new Set<string>()
    for (const option of options) {
      const label = screen.getByText(option.label).closest('label') as HTMLLabelElement
      const control = document.getElementById(label.htmlFor)
      expect(control).not.toBeNull()
      expect((control as HTMLElement).id).toBe(label.htmlFor)
      htmlForSet.add(label.htmlFor)
    }
    expect(htmlForSet.size).toBe(5)
  })

  it('实例去重：重复 option id 仍产生互不相同的控件 id（config-option-<optionId>-<instanceId>）', () => {
    render(() => <div>
      <ConfigOptionField option={normalizeConfigOption({ id: 'model', type: 'boolean', currentValue: true, label: '实例 A' })} onChange={() => {}} />
      <ConfigOptionField option={normalizeConfigOption({ id: 'model', type: 'boolean', currentValue: false, label: '实例 B' })} onChange={() => {}} />
    </div>)

    const htmlForA = (screen.getByText('实例 A').closest('label') as HTMLLabelElement).htmlFor
    const htmlForB = (screen.getByText('实例 B').closest('label') as HTMLLabelElement).htmlFor
    expect(htmlForA).toMatch(/^config-option-model-.+/)
    expect(htmlForB).toMatch(/^config-option-model-.+/)
    expect(htmlForA).not.toBe(htmlForB)
    expect(document.getElementById(htmlForB)?.id).toBe(htmlForB)
  })
})
