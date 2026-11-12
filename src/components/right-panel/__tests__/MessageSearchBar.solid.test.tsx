// @vitest-environment jsdom
// #515：MessageSearchBar 测试的 Solid 版（断言集与 React 版逐一对应，未缩减）。
// 改写点登记：
// - `@testing-library/react` → `@solidjs/testing-library`（render 传函数）；
// - 受控输入的 `fireEvent.change` → `fireEvent.input`（Solid 的受控 input 走 onInput）。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import MessageSearchBar from '../MessageSearchBar.solid.tsx'

afterEach(cleanup)

function setup() {
  const onQueryChange = vi.fn()
  const onPrevious = vi.fn()
  const onNext = vi.fn()
  const onClose = vi.fn()
  render(() => (
    <MessageSearchBar
      query="检查"
      matchIndex={0}
      matchCount={3}
      onQueryChange={onQueryChange}
      onPrevious={onPrevious}
      onNext={onNext}
      onClose={onClose}
    />
  ))
  return { onQueryChange, onPrevious, onNext, onClose }
}

describe('MessageSearchBar', () => {
  test('渲染查询词与计数', () => {
    setup()
    expect(screen.getByDisplayValue('检查')).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
  })

  test('输入触发 onQueryChange', () => {
    const { onQueryChange } = setup()
    const input = screen.getByDisplayValue('检查')
    fireEvent.input(input, { target: { value: '新词' } })
    expect(onQueryChange).toHaveBeenCalledWith('新词')
  })

  test('Enter 下一个 / Shift+Enter 上一个 / Esc 关闭', () => {
    const { onNext, onPrevious, onClose } = setup()
    const input = screen.getByDisplayValue('检查')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNext).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onPrevious).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('无结果时显示"无结果"且按钮禁用', () => {
    setup()
    // 有结果基线：导航按钮可用
    expect(screen.getByRole('button', { name: '上一个搜索结果' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '下一个搜索结果' })).toBeEnabled()
    render(() => (
      <MessageSearchBar
        query="无匹配词"
        matchIndex={0}
        matchCount={0}
        onQueryChange={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
      />
    ))
    expect(screen.getByText('无结果')).toBeTruthy()
    // 行为断言：matchCount=0 → 上一个/下一个按钮真实禁用（disabled={matchCount === 0}）
    const prevButtons = screen.getAllByRole('button', { name: '上一个搜索结果' })
    const nextButtons = screen.getAllByRole('button', { name: '下一个搜索结果' })
    expect(prevButtons).toHaveLength(2)
    expect(nextButtons).toHaveLength(2)
    expect(prevButtons[1]).toBeDisabled()
    expect(nextButtons[1]).toBeDisabled()
  })
})


test('composition keys do not navigate or close search', () => {
  const { onNext, onClose } = setup()
  const input = screen.getByRole('textbox', { name: '搜索消息' })
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(onNext).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onNext).toHaveBeenCalledOnce()
})

test('no-match keyboard navigation behaves like disabled navigation buttons', () => {
  const onNext = vi.fn()
  const onPrevious = vi.fn()
  render(() => <MessageSearchBar query="missing" matchIndex={0} matchCount={0} onQueryChange={vi.fn()} onNext={onNext} onPrevious={onPrevious} onClose={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: '搜索消息' })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(onNext).not.toHaveBeenCalled()
  expect(onPrevious).not.toHaveBeenCalled()
})
