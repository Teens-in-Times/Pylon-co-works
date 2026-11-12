// @vitest-environment jsdom
import { createSignal } from 'solid-js'
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appClients } from '../../../app/appClients.ts'
import { browserEventFeed } from '../../../infrastructure/tauri/browserEventFeed.ts'
import type { SheetContext } from '../../../workspace-sheets/sheetTypes'
import { wireBrowserSheetEffects } from '../browserSheetEffects.solid.ts'
import type { BrowserSnapshot, BrowserToolId } from '../browserSheetTypes.ts'
import { flushTask as settleEvents } from '../../../test/solidTestHelpers.ts'

vi.mock('../../../app/appClients.ts', () => ({
  appClients: { browser: { status: vi.fn(), start: vi.fn(), setVisible: vi.fn(), close: vi.fn() } },
}))

const baseContext: SheetContext = {
  openSheet: vi.fn(), focusSheet: vi.fn(), closeSheet: vi.fn(), activeSession: null,
  selectSession: vi.fn(), openProfileEdit: vi.fn(), openSessionSettings: vi.fn(),
  sidebarCollapsed: false, rightInset: 0, isActive: true,
  sessionSource: () => null, sessionBySource: () => undefined,
}

const readySnapshot = (): BrowserSnapshot => ({
  instanceId: 1, phase: 'ready', url: 'https://example.com', title: 'Example',
  zoomPercent: 90, activeTabId: 1, tabs: [{ id: 1 }], visible: true,
})

function mountEffects(options: { isActive: boolean | undefined } = { isActive: true }) {
  let nativeSnapshot = readySnapshot()
  const consumers = new Map<string, (payload: unknown) => void>()
  vi.spyOn(browserEventFeed, 'subscribe').mockImplementation((event, consumer) => {
    consumers.set(event, consumer as (payload: unknown) => void)
    return { dispose: () => { consumers.delete(event) } }
  })
  const publishStatus = (patch: Partial<BrowserSnapshot> = {}) => {
    nativeSnapshot = { ...nativeSnapshot, ...patch }
    consumers.get('pylon:browser-status')?.(nativeSnapshot)
  }
  vi.mocked(appClients.browser.status).mockImplementation(async () => nativeSnapshot)
  vi.mocked(appClients.browser.close).mockResolvedValue(undefined)
  // Match the native command: setting visibility broadcasts a fresh status even
  // if its value did not change. The finite cap makes the pre-fix loop fail safely.
  let broadcastsLeft = 8
  vi.mocked(appClients.browser.setVisible).mockImplementation(async visible => {
    await Promise.resolve()
    if (broadcastsLeft-- > 0) publishStatus({ visible })
    return nativeSnapshot
  })

  const [ctx, setCtx] = createSignal<SheetContext>({ ...baseContext, isActive: options.isActive })
  const [snapshot, setSnapshot] = createSignal<BrowserSnapshot>({ ...readySnapshot(), phase: 'idle' })
  const [overlayOpen, setOverlayOpen] = createSignal(false)
  const [activeTool, setActiveTool] = createSignal<BrowserToolId | null>(null)
  const [, setPreviewRevision] = createSignal(0)
  // Real implementations read snapshot/ctx internally. Those reads must not
  // silently widen the dependencies of the lifecycle effects that call them.
  const syncBounds = vi.fn(() => { snapshot(); ctx() })
  const inspectPage = vi.fn(async () => { snapshot() })
  render(() => {
    const viewport = document.createElement('div')
    wireBrowserSheetEffects({
      browserPreview: false, browserRuntimeAvailable: true,
      ctx, snapshot, activeTool, modalOverlayOpen: overlayOpen,
      viewportRef: { current: viewport },
      applySnapshot: next => setSnapshot({ ...next }), setSnapshot, setPreviewRevision,
      syncBounds, inspectPage, recordCurrentPage: vi.fn(), setAddress: vi.fn(),
      navigateTo: vi.fn(), tabCommand: vi.fn(), notifyPageChanged: vi.fn(),
    })
    return viewport
  })
  return { setCtx, setOverlayOpen, setActiveTool, publishStatus, snapshot, syncBounds, inspectPage }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Browser lifecycle effects do not feed status events back into commands', () => {
  it('a native visibility status acknowledgement does not issue another visibility command', async () => {
    const view = mountEffects()
    await settleEvents()
    expect(view.snapshot().phase).toBe('ready')
    expect(appClients.browser.setVisible).toHaveBeenCalledExactlyOnceWith(true)
    const boundsCalls = view.syncBounds.mock.calls.length

    view.publishStatus({ title: 'New title', zoomPercent: 120, visible: true })
    await settleEvents()
    expect(view.snapshot().title).toBe('New title')
    expect(appClients.browser.setVisible).toHaveBeenCalledTimes(1)
    expect(view.syncBounds).toHaveBeenCalledTimes(boundsCalls)
  })

  it('actual active, overlay and phase changes still synchronize native visibility', async () => {
    const view = mountEffects()
    await settleEvents()
    expect(appClients.browser.setVisible).toHaveBeenLastCalledWith(true)
    view.setCtx(previous => ({ ...previous, isActive: false }))
    await settleEvents()
    expect(appClients.browser.setVisible).toHaveBeenLastCalledWith(false)
    view.setOverlayOpen(true)
    await settleEvents()
    view.setCtx(previous => ({ ...previous, isActive: true }))
    await settleEvents()
    expect(appClients.browser.setVisible).toHaveBeenLastCalledWith(false)
    view.setOverlayOpen(false)
    await settleEvents()
    expect(appClients.browser.setVisible).toHaveBeenLastCalledWith(true)

    const visibilityCalls = vi.mocked(appClients.browser.setVisible).mock.calls.length
    view.publishStatus({ phase: 'error' })
    await settleEvents()
    expect(appClients.browser.setVisible).toHaveBeenCalledTimes(visibilityCalls)
    view.publishStatus({ phase: 'ready' })
    await settleEvents()
    expect(appClients.browser.setVisible).toHaveBeenCalledTimes(visibilityCalls + 1)
    expect(appClients.browser.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('an unspecified active state stays distinct from an explicitly inactive sheet', async () => {
    const view = mountEffects({ isActive: undefined })
    await settleEvents()
    expect(appClients.browser.setVisible).not.toHaveBeenCalled()
    view.setCtx(previous => ({ ...previous, isActive: false }))
    await settleEvents()
    expect(appClients.browser.setVisible).toHaveBeenCalledExactlyOnceWith(false)
    view.setCtx(previous => ({ ...previous, isActive: undefined }))
    await settleEvents()
    expect(appClients.browser.setVisible).toHaveBeenCalledTimes(1)
  })

  it('bounds and tool snapshots react to their inputs without tracking nested snapshot reads', async () => {
    const view = mountEffects()
    await settleEvents()
    const boundsCalls = view.syncBounds.mock.calls.length
    view.setCtx(previous => ({ ...previous, rightInset: 320 }))
    await settleEvents()
    expect(view.syncBounds).toHaveBeenCalledTimes(boundsCalls)
    expect(appClients.browser.status).toHaveBeenCalledTimes(1)
    expect(appClients.browser.setVisible).toHaveBeenCalledTimes(1)

    view.setCtx(previous => ({ ...previous, sidebarCollapsed: true }))
    await settleEvents()
    expect(view.syncBounds).toHaveBeenCalledTimes(boundsCalls + 1)
    window.dispatchEvent(new Event('resize'))
    expect(view.syncBounds).toHaveBeenCalledTimes(boundsCalls + 2)
    view.setActiveTool('console')
    await settleEvents()
    expect(view.inspectPage).toHaveBeenCalledTimes(1)
    view.publishStatus({ title: 'Another title' })
    await settleEvents()
    expect(view.inspectPage).toHaveBeenCalledTimes(1)
    expect(view.syncBounds).toHaveBeenCalledTimes(boundsCalls + 2)

    view.setActiveTool('downloads')
    await settleEvents()
    expect(view.inspectPage).toHaveBeenCalledTimes(2)
    view.publishStatus({ phase: 'starting' })
    await settleEvents()
    expect(view.inspectPage).toHaveBeenCalledTimes(2)
    view.publishStatus({ phase: 'ready' })
    await settleEvents()
    expect(view.inspectPage).toHaveBeenCalledTimes(3)
  })
})
