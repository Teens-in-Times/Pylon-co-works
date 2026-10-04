// @vitest-environment jsdom
import { afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import RendererSettingField from '../RendererSettingField.solid.tsx'
import { validateRendererSettingsSchema, resolvePresentation,
  type RenderSettingField } from '../../../plugin-runtime/renderers/rendererSettingsTypes.ts'

// 全局 afterEach(cleanup) 已由 vitest.setup.ts 统一接通（@solidjs/testing-library）；此处显式注册为冗余保险。
afterEach(cleanup)

/**
 * S 系列边界探针（施工书 06 补遗）：非法/错位声明与极值输入的真实行为锁定。
 * 断言的是「当前契约」——若未来收紧校验，本文件随契约同步迁移。
 * #515：随实体迁移为 Solid 直连测试。断言改写点登记：
 * render(() => JSX) 函数形态；fireEvent.change → fireEvent.input（数值输入，见
 * RendererSettingField.solid.test.tsx 文件头）。其余断言集逐条原样保留。
 */

describe('B1.1 未知 type 的解析与渲染', () => {
  it('resolvePresentation 对未知 type 返回 undefined（不抛错）', () => {
    const field = { key: 'x', label: 'X', type: 'alien' } as unknown as RenderSettingField
    expect(resolvePresentation(field)).toBeUndefined()
  })
})

describe('B1.2/B1.3 type×presentation 错位', () => {
  it('number 字段声明 segmented：渲染回退 number 输入（switch 内层不匹配走默认形态）', () => {
    const field = { key: 'n', label: '数字', type: 'number', presentation: 'segmented', min: 0, max: 9 } as unknown as RenderSettingField
    const received: unknown[] = []
    render(() => <RendererSettingField field={field} value={1} onChange={v => received.push(v)} />)
    // 错位声明不产生 segmented 按钮组，也不崩溃
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByLabelText('数字')).toBeTruthy()
  })

  it('text 字段声明 slider：渲染 textarea/input 而非滑块', () => {
    const field = { key: 't', label: '文本', type: 'text', presentation: 'slider' } as unknown as RenderSettingField
    render(() => <RendererSettingField field={field} value="s" onChange={() => {}} />)
    const input = screen.getByLabelText('文本')
    expect(['INPUT', 'TEXTAREA']).toContain(input.tagName)
    expect(input.getAttribute('type')).not.toBe('range')
  })
})

describe('B1.5 listbox 空 options', () => {
  it('options 为空时 size 不为 0（下限 1），渲染不崩溃', () => {
    const field = { key: 'm', label: '多选', type: 'multi-choice', presentation: 'listbox', options: [] } as unknown as RenderSettingField
    render(() => <RendererSettingField field={field} value={[]} onChange={() => {}} />)
    const select = screen.getByLabelText('多选')
    expect(Number(select.getAttribute('size'))).toBeGreaterThanOrEqual(1)
  })
})

describe('B1.6 number 全缺省', () => {
  it('无 min/max/default 时渲染不崩溃且载荷为 number', () => {
    const received: unknown[] = []
    const field = { key: 'n', label: '自由数', type: 'number' } as unknown as RenderSettingField
    render(() => <RendererSettingField field={field} value={undefined} onChange={v => received.push(v)} />)
    // K-3：slider+input 的 range 半边为 radix Slider 手写等价；数值半边仍是原生 number input
    fireEvent.input(screen.getByLabelText('自由数数值'), { target: { value: '3' } })
    expect(received.at(-1)).toBe(3)
    expect(Number.isNaN(received.at(-1) as number)).toBe(false)
  })
})

describe('B1.8 color 非规范值', () => {
  it('rgba 值显示回退 #000000 但原始值不被覆写（未操作时不 onChange）', () => {
    const received: unknown[] = []
    const field = { key: 'c', label: '颜色X', type: 'color', presentation: 'palette+picker', default: undefined } as unknown as RenderSettingField
    render(() => <RendererSettingField field={field} value={'rgba(255,0,0,0.5)' as never}
      onChange={v => received.push(v)} />)
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
    expect(received).toHaveLength(0)
  })
})


describe('B1.7 min>max 运行时直构造', () => {
  it('validate 拒绝 min>max 的 schema（契约层防线确认）', () => {
    const schema = {
      schemaVersion: 1,
      groups: [{ id: 'g', label: 'G', fields: [
        { key: 'bad', label: '坏', type: 'number', presentation: 'slider+input', min: 9, max: 1 },
      ] }],
    }
    expect(() => validateRendererSettingsSchema(schema as never)).toThrow(/min 大于 max/)
  })
})
