// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentBrowserResources from '../AgentBrowserResources.solid.tsx'
import { appClients } from '../../../app/appClients.ts'
import { browserEventFeed } from '../../../infrastructure/tauri/browserEventFeed.ts'
import type { BrowserSnapshot } from '../../../sheets/browser/browserSheetTypes.ts'

const ready: BrowserSnapshot = { instanceId: 1, phase: 'ready', zoomPercent: 90, activeTabId: 1, title: 'Guide', url: 'https://example.com/guide', tabs: [{ id: 1, title: 'Guide', url: 'https://example.com/guide' }] }
beforeEach(() => {
  vi.spyOn(browserEventFeed, 'subscribe').mockReturnValue({ dispose: vi.fn() })
  vi.spyOn(appClients.browser, 'status').mockResolvedValue(ready)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('browser resource inspector', () => {
  it('shows actual tabs and page text, then opens the selected native tab without owning its viewport', async () => {
    vi.spyOn(appClients.browser, 'snapshot').mockResolvedValue({ title: 'Guide', text: 'Real page contents', tabId: 1 })
    const select = vi.spyOn(appClients.browser, 'selectTab').mockResolvedValue(ready)
    const start = vi.spyOn(appClients.browser, 'start')
    const close = vi.spyOn(appClients.browser, 'close')
    const onOpen = vi.fn()
    const view = render(() => <AgentBrowserResources onOpen={onOpen} />)
    const tab = await screen.findByRole('button', { name: /^Guide/ })
    expect(tab).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: '预览当前网页文本' }))
    expect(await screen.findByText('Real page contents')).toBeInTheDocument()
    fireEvent.click(tab)
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce())
    expect(select).toHaveBeenCalledWith(1)
    view.unmount()
    expect(start).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('opens a normalized http(s) address and rejects executable URL schemes', async () => {
    const onOpen = vi.fn()
    render(() => <AgentBrowserResources onOpen={onOpen} />)
    await screen.findByText('就绪')
    const input = screen.getByRole('textbox', { name: '在内置浏览器打开网址' })
    fireEvent.input(input, { target: { value: 'example.com/docs' } })
    fireEvent.submit(input.closest('form')!)
    expect(onOpen).toHaveBeenCalledWith('https://example.com/docs')
    onOpen.mockClear()
    fireEvent.input(input, { target: { value: 'javascript://alert(1)' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByRole('alert')).toHaveTextContent('http 或 https')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps an in-flight page preview across same-page status and background-page broadcasts', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    vi.mocked(browserEventFeed.subscribe).mockImplementation((name, listener) => {
      listeners.set(name, listener as (value: unknown) => void)
      return { dispose: vi.fn() }
    })
    let resolveSnapshot!: (value: unknown) => void
    vi.spyOn(appClients.browser, 'snapshot').mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    render(() => <AgentBrowserResources onOpen={vi.fn()} />)
    await screen.findByText('就绪')
    fireEvent.click(screen.getByRole('button', { name: '预览当前网页文本' }))
    listeners.get('pylon:browser-status')!({ ...ready, visible: false, zoomPercent: 100, title: 'Updated title' })
    listeners.get('pylon:browser-page')!({ tabId: 2, active: false, url: 'https://example.com/background', title: 'Background page' })
    resolveSnapshot({ tabId: 1, title: 'Guide', text: 'Page text survives status refresh' })
    expect(await screen.findByText('Page text survives status refresh')).toBeInTheDocument()
    listeners.get('pylon:browser-status')!({ ...ready, visible: true })
    expect(screen.getByText('Page text survives status refresh')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['active tab changes', { ...ready, activeTabId: 2, url: 'https://example.com/new', tabs: [{ id: 2, url: 'https://example.com/new', title: 'New tab' }] }],
    ['same tab navigates', { ...ready, url: 'https://example.com/new' }],
    ['native instance changes', { ...ready, instanceId: 2 }],
    ['browser stops being ready', { ...ready, phase: 'starting' }],
  ] as const)('does not show a late page snapshot when %s', async (_case, next) => {
    const listeners = new Map<string, (value: unknown) => void>()
    vi.mocked(browserEventFeed.subscribe).mockImplementation((name, listener) => {
      listeners.set(name, listener as (value: unknown) => void)
      return { dispose: vi.fn() }
    })
    let resolveSnapshot!: (value: unknown) => void
    vi.spyOn(appClients.browser, 'snapshot').mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    render(() => <AgentBrowserResources onOpen={vi.fn()} />)
    await screen.findByText('就绪')
    fireEvent.click(screen.getByRole('button', { name: '预览当前网页文本' }))
    listeners.get('pylon:browser-status')!(next)
    resolveSnapshot({ tabId: 1, text: 'Old tab text' })
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新浏览器状态' })).not.toBeDisabled())
    expect(screen.queryByText('Old tab text')).not.toBeInTheDocument()
  })

  it('invalidates an in-flight preview when the active page reloads at the same URL', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    vi.mocked(browserEventFeed.subscribe).mockImplementation((name, listener) => {
      listeners.set(name, listener as (value: unknown) => void)
      return { dispose: vi.fn() }
    })
    let resolveSnapshot!: (value: unknown) => void
    vi.spyOn(appClients.browser, 'snapshot').mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    render(() => <AgentBrowserResources onOpen={vi.fn()} />)
    await screen.findByText('就绪')
    fireEvent.click(screen.getByRole('button', { name: '预览当前网页文本' }))
    listeners.get('pylon:browser-page')!({ tabId: 1, active: true, url: ready.url, title: ready.title })
    resolveSnapshot({ tabId: 1, text: 'Before reload text' })
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新浏览器状态' })).not.toBeDisabled())
    expect(screen.queryByText('Before reload text')).not.toBeInTheDocument()
  })
})
