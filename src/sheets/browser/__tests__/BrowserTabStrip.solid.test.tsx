// @vitest-environment jsdom
import { createSignal } from 'solid-js'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserTabStrip } from '../BrowserTabStrip.solid.tsx'
import type { BrowserTabSnapshot } from '../browserSheetTypes'

afterEach(cleanup)

it('keeps selection reactive and supports wraparound keyboard navigation', () => {
  const tabs = [{ id: 1, title: 'First', url: 'https://one.example' }, { id: 2, title: 'Second', url: 'https://two.example' }] as BrowserTabSnapshot[]
  const [active, setActive] = createSignal<number | null>(1)
  const command = vi.fn((kind: string, id?: number) => { if (kind === 'select') setActive(id!) })
  render(() => <BrowserTabStrip tabs={tabs} activeTabId={active()} onTabCommand={command} />)
  const first = screen.getByRole('tab', { name: 'First' })
  const second = screen.getByRole('tab', { name: 'Second' })
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowRight' })
  expect(second).toHaveFocus()
  expect(second).toHaveAttribute('aria-selected', 'true')
  expect(first).toHaveAttribute('aria-selected', 'false')
  expect(first.tabIndex).toBe(-1)
  fireEvent.keyDown(second, { key: 'ArrowRight' })
  expect(first).toHaveFocus()
  expect(first).toHaveAttribute('aria-selected', 'true')
})
