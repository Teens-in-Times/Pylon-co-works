// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSolidWorkbench, mountSolidWorkbenchFromHostPort } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent } from '../../../domains/workbench/workbenchProjector.ts'
import { createSessionResponseEnvelope } from '../../../application/agent-workbench/sessionResponseProjection.ts'
import { createWorkbenchHostPort } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import type { WorkbenchCapabilitySnapshot } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { RendererSuiteHost } from '../../../host/renderer-suite/rendererSuiteHost.ts'
import type { RenderNodeSnapshot, RenderSurface } from '../../../contracts/messageRenderer.ts'
import type { RendererActivationSnapshot, RendererSlotContribution, RendererSuiteContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../domains/rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../../../domains/rendererContent/executionRenderKindCatalog.ts'
import { BUILTIN_INTERACTION_RENDER_KINDS } from '../../../domains/rendererContent/interactionRenderKindCatalog.ts'
import { createBuiltinSolidContentSlot } from '../builtinSolidRendererSuite.ts'
import { resolveCcWidgetGroup, type CcDetachX } from '../../../domains/cc/widgetDefinitions.ts'
import { parseTranslateOffset } from '../input/ccPlacementCollision.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import type { WorkbenchSessionCreationStore } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createAgentWorkbenchCommandFacade } from '../../../application/agent-workbench/agentWorkbenchCommands.ts'
import type { Session } from '../../../domains/identity/identityStore.ts'
import { FLUSH_BUDGET } from '../../../test/solidTestHelpers.ts'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

/** #487：预览面与生产同构——以 canonical running 行模拟流式输出
 *  （原 `update({messages})` legacy 通道已随快照字段退役）。 */
function streamInto(
  services: ReturnType<typeof createPreviewWorkbenchServices>,
  id: string,
  content: string,
  generationPatch?: Record<string, unknown>,
): void {
  const base = services.runtime.getSnapshot().document!
  services.runtime.applyDocument({
    ...base,
    messages: [{
      id, segmentId: id, role: 'assistant', content, parts: [], identity: {},
      source: { provider: 'peri', sourceId: 'peri' }, sequence: 1,
      running: true, time: '2026-08-26T10:00:00.000Z',
    }],
  }, generationPatch === undefined ? {} : { generationPatch: generationPatch as never })
}


function mountPreview(capabilities?: WorkbenchCapabilitySnapshot, options: { reducedMotion?: boolean; preview?: boolean } = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
  const hostPort = capabilities ? createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-a',
    sessionOwnerKey: 'owner-preview',
    sessionId: 'preview-session',
    capabilities,
  }) : undefined
  const lifecycle = mountSolidWorkbench({
    host,
    input: {
      sheetId: 'sheet-a',
      sessionId: 'preview-session',
      preview: options.preview ?? true,
      rightInset: 24,
      reducedMotion: options.reducedMotion ?? true,
    },
    services,
    hostPort,
  })
  return { host, services, lifecycle }
}

/**
 * P57 S1.0 测试基建：可变滚动模型。scrollTop/scrollHeight/clientHeight 以
 * getter/setter 透出同一份可变状态，测试可在「写入落地」与「反馈 scroll 事件
 * 派发」之间操纵几何（表达真实浏览器的同帧竞态）。
 */
interface ScrollModel {
  top: number
  height: number
  clientHeight: number
}

function createScrollModel(viewport: HTMLElement, initial: Partial<ScrollModel> = {}): ScrollModel {
  const model: ScrollModel = {
    top: initial.top ?? 0,
    height: initial.height ?? 1_000,
    clientHeight: initial.clientHeight ?? 300,
  }
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => model.top,
    set: (value: number) => { model.top = value },
  })
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => model.height })
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => model.clientHeight })
  return model
}

/** P57 S1.0 帧泵：requestAnimationFrame 回调可编程 flush（沿用既有 mock 模式）。 */
interface FramePump {
  enqueue(callback: () => void): void
  flush(): void
  pending(): number
  clear(): void
  dispose(): void
}

function createFramePump(): FramePump {
  const previousRaf = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  let nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => { frames.delete(id) }) as typeof cancelAnimationFrame
  return {
    enqueue(callback) { frames.set(++nextFrame, callback as FrameRequestCallback) },
    flush() {
      const pendingCallbacks = [...frames.values()]
      frames.clear()
      for (const callback of pendingCallbacks) callback(performance.now())
    },
    pending: () => frames.size,
    clear() { frames.clear() },
    dispose() {
      frames.clear()
      globalThis.requestAnimationFrame = previousRaf
      globalThis.cancelAnimationFrame = previousCancel
    },
  }
}

/**
 * P57 S1.0：scrollTo 落地 sink——instant/auto 写入立即落 top，并把反馈 scroll 事件
 * 排入帧泵（与真实浏览器「写入 → 派发 scroll」同序，且可与几何操纵交错）。
 */
function installInstantScrollToSink(viewport: HTMLElement, model: ScrollModel, pump: FramePump) {
  const scrollTo = vi.fn((options?: ScrollToOptions) => {
    if (options?.top === undefined) return
    model.top = options.top
    pump.enqueue(() => viewport.dispatchEvent(new Event('scroll')))
  })
  Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo })
  return scrollTo
}

/**
 * P57 S1.0：可编程分帧动画 scrollTo（reducedMotion:false 变体专用）——smooth 写入
 * 用固定帧数线性逼近 endpoint，每帧落一次 top 并派发 scroll 事件。
 */
function installAnimatedScrollTo(viewport: HTMLElement, model: ScrollModel, pump: FramePump, frames = 3) {
  let animationRevision = 0
  const scrollTo = vi.fn((options?: ScrollToOptions) => {
    if (options?.top === undefined) return
    const revision = ++animationRevision
    if (options.behavior !== 'smooth') {
      model.top = options.top
      pump.enqueue(() => viewport.dispatchEvent(new Event('scroll')))
      return
    }
    const from = model.top
    const to = options.top
    let step = 0
    const advance = () => {
      if (revision !== animationRevision) return
      step += 1
      model.top = from + (to - from) * (step / frames)
      viewport.dispatchEvent(new Event('scroll'))
      if (step < frames) pump.enqueue(advance)
    }
    pump.enqueue(advance)
  })
  Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo })
  return scrollTo
}

describe('mountSolidWorkbench', () => {
  it('marks a live tool arrival once while later status projections reuse its card', async () => {
    const { host, services } = mountPreview(undefined, { reducedMotion: false })
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-25T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'acp', sourceId: `motion-${sequence}` }, identity: { toolCallId: 'motion-tool' },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const started = envelope(1, { type: 'tool.started', tool: { name: 'Read', title: '读取文件' } })
    const completed = envelope(2, { type: 'tool.completed', tool: { status: 'completed', parts: [{ kind: 'text', text: '读取结果' }] } })
    services.runtime.replaceDocument(createWorkbenchDocument('preview-session'), {
      ownerKey: 'owner-preview', generation: 1, preserveGeneration: true, generationPatch: { generating: true },
    })
    services.runtime.replaceDocument(projectWorkbench([started]).document, {
      ownerKey: 'owner-preview', generation: 1, preserveGeneration: true, generationPatch: { generating: true },
    })
    const slot = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-activity-id="motion-tool"]')
      expect(value).toHaveAttribute('data-entry', 'new')
      return value!
    })
    services.runtime.replaceDocument(projectWorkbench([started, completed]).document, {
      ownerKey: 'owner-preview', generation: 1, preserveGeneration: true, generationPatch: { generating: true },
    })
    await waitFor(() => expect(host.querySelector('[data-activity-id="motion-tool"]')).toBe(slot))
    await waitFor(() => expect(slot).toHaveAttribute('data-result-receipt', 'new'))
    await waitFor(() => expect(slot).not.toHaveAttribute('data-result-receipt'), { timeout: 1_000 })
    await waitFor(() => expect(slot).not.toHaveAttribute('data-entry'), { timeout: 1_000 })
    expect(host.querySelectorAll('[data-activity-id="motion-tool"]')).toHaveLength(1)
  })

  it.each([
    { reducedMotion: false, generating: false },
    { reducedMotion: true, generating: true },
  ])('keeps a restored or reduced-motion tool static (%j)', async ({ reducedMotion, generating }) => {
    const { host, services } = mountPreview(undefined, { reducedMotion })
    const started = createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-25T00:00:01.000Z', sequence: 1,
      source: { provider: 'acp', sourceId: 'static-tool' }, identity: { toolCallId: 'static-tool' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.started', tool: { name: 'Read', title: '读取文件' } },
    })
    const options = {
      ownerKey: 'owner-preview', generation: 1, preserveGeneration: true,
      generationPatch: { generating },
    }
    services.runtime.replaceDocument(createWorkbenchDocument('preview-session'), options)
    services.runtime.replaceDocument(projectWorkbench([started]).document, options)
    const slot = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-activity-id="static-tool"]')
      expect(value).not.toBeNull()
      return value!
    })
    expect(slot).not.toHaveAttribute('data-entry')
    const completed = createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-25T00:00:02.000Z', sequence: 2,
      source: { provider: 'acp', sourceId: 'static-tool-result' }, identity: { toolCallId: 'static-tool' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.completed', tool: { status: 'completed', parts: [{ kind: 'text', text: '已完成' }] } },
    })
    services.runtime.replaceDocument(projectWorkbench([started, completed]).document, options)
    await waitFor(() => expect(host.querySelector('[data-activity-id="static-tool"]')).toBe(slot))
    expect(slot).not.toHaveAttribute('data-result-receipt')
  })

  it('按 canonical sequence 把工具活动插入用户消息与助手回复之间', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event'], identity: WorkbenchEventEnvelope['identity'] = {}) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-25T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'acp', sourceId: `timeline-${sequence}` }, identity,
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const startedEvents = [
      envelope(1, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '读取文件' }] }, { messageId: 'user-1' }),
      envelope(2, { type: 'tool.started', tool: { name: 'Read', title: '读取文件' } }, { toolCallId: 'tool-between' }),
      envelope(4, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '读取完成' }] }, { messageId: 'assistant-1' }),
      envelope(5, { type: 'message.completed', role: 'assistant', parts: [] }, { messageId: 'assistant-1' }),
    ]
    // A late terminal event arrives after the assistant row. It updates the
    // existing card in place and must not move it below that reply.
    const completion = envelope(6, { type: 'tool.completed', tool: { status: 'completed', parts: [{ kind: 'text', text: '文件内容' }] } }, { toolCallId: 'tool-between' })
    const started = projectWorkbench(startedEvents).document
    const userId = started.messages.find(message => message.role === 'user')!.id
    const assistantId = started.messages.find(message => message.role === 'assistant')!.id

    services.runtime.replaceDocument(started, { ownerKey: 'owner-preview', generation: 1 })

    const user = await waitFor(() => host.querySelector<HTMLElement>(`[data-message-id="${userId}"]`)!)
    const tool = host.querySelector<HTMLElement>('[data-activity-id="tool-between"]')!
    const assistant = host.querySelector<HTMLElement>(`[data-message-id="${assistantId}"]`)!
    expect(tool).not.toBeNull()
    expect(assistant).not.toBeNull()
    expect(user.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tool.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(host.querySelectorAll('[data-activity-id="tool-between"]')).toHaveLength(1)

    services.runtime.replaceDocument(projectWorkbench([...startedEvents, completion]).document, {
      ownerKey: 'owner-preview', generation: 1,
    })
    await waitFor(() => expect(screen.getByRole('status', { name: '工具：读取文件，已完成' })).toBeInTheDocument())
    expect(host.querySelector('[data-activity-id="tool-between"]')).toBe(tool)
    expect(tool.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(host.querySelectorAll('[data-activity-id="tool-between"]')).toHaveLength(1)
  })

  it('工具聚合行复用普通工具卡结构，并跟随组内最后一次调用的状态色', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event'], toolCallId: string) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-25T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `group-${sequence}` }, identity: { toolCallId },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const document = projectWorkbench([
      envelope(1, { type: 'tool.started', tool: { name: 'Read', title: '读取文件' } }, 'group-tool-1'),
      envelope(2, { type: 'tool.completed', tool: { name: 'Read', title: '读取文件', status: 'completed' } }, 'group-tool-1'),
      envelope(3, { type: 'tool.started', tool: { name: 'Read', title: '读取文件' } }, 'group-tool-2'),
      envelope(4, { type: 'tool.failed', tool: { name: 'Read', title: '读取文件', status: 'failed' } }, 'group-tool-2'),
    ]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    const group = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('.solid-workbench-activity-group')
      expect(value).not.toBeNull()
      return value!
    })
    expect(group).toHaveClass('term-tool')
    expect(group).toHaveAttribute('data-count', '2')
    expect(group).toHaveAttribute('data-status', 'err')
    expect(group).toHaveAttribute('data-last-tool-status', 'failed')
    expect(group.querySelector('.term-tool-head')).not.toBeNull()
    expect(group.querySelector('.term-tool-indicator')).toHaveClass('err')
    expect(group.querySelector('.term-tool-name')).toHaveTextContent('读取文件')
    expect(group.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(group.querySelector<HTMLButtonElement>('.term-tool-head')!)
    expect(group.querySelectorAll('.solid-workbench-activity-slot')).toHaveLength(2)
  })

  it('助手正文与圆点处于同一布局行（assistantDot 开启时）', async () => {
    const { host, services } = mountPreview()
    const theme = structuredClone(DEFAULTS)
    theme.assistantDot = true
    services.appearance.setTheme(theme)
    const assistant = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('.term-assistant.has-dot')
      expect(value).not.toBeNull()
      return value!
    })

    // ★ #266 CC-29：原来这里还断言工作台根节点注入了 `--input-font-size`（让输入字号继承聊天字号）。
    //   那条注入被中控无条件内联的 `--cc-input-font-size` 恒挡住 ⇒ 逻辑上够不着，已随本单删除，
    //   断言一并移出（用例名同步收窄）。
    expect(assistant.querySelector(':scope > .term-assistant-dot, :scope > .term-assistant-dot-img')).not.toBeNull()
    expect(assistant.querySelector(':scope > .term-assistant-body')).not.toBeNull()
  })

  it('消费会话搜索状态，高亮并定位当前匹配消息', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const { host, services } = mountPreview()

    services.sessionUi.set('preview-session', 'search-query', 'runtime 保持')
    services.sessionUi.set('preview-session', 'search-index', -7)

    await waitFor(() => expect(
      host.querySelector('[data-message-id="fixture-assistant-markdown"] .term-row-search-active'),
    ).not.toBeNull())
    expect(services.sessionUi.get('preview-session', 'search-index', -1)).toBe(0)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  // P57 §6 点名改写（例外 1）：用户离开底部的入口从纯位置判别（fireEvent.scroll）
  // 改为输入模态判别（wheel 上滚）；契约意图不变——用户离底后不抢滚动、▼ 一键恢复、
  // 恢复后继续自动跟随。
  it('用户离开底部后不抢滚动，并可一键恢复自动跟随', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const pump = createFramePump()
    try {
      const { host, services } = mountPreview()
      const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
      const model = createScrollModel(viewport, { top: 700 })
      const scrollTo = installInstantScrollToSink(viewport, model, pump)

      // 用户输入模态：wheel 上滚 → 取消跟随；随后的真实滚动落在离底位置。
      fireEvent.wheel(viewport, { deltaY: -100 })
      model.top = 100
      fireEvent.scroll(viewport)
      expect(await screen.findByRole('button', { name: '回到底部' })).toBeInTheDocument()
      scrollIntoView.mockClear()

      streamInto(services, 'm-scroll', '用户上滚后的新输出')
      await Promise.resolve()
      pump.flush()
      expect(scrollIntoView).not.toHaveBeenCalled()
      expect(scrollTo).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: '回到底部' }))
      expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'auto' })
      // The rail action remains available as an explicit endpoint control after
      // follow mode is restored; subsequent output should auto-follow again.
      expect(screen.getByRole('button', { name: '回到底部' })).toBeInTheDocument()

      scrollIntoView.mockClear()
      scrollTo.mockClear()
      streamInto(services, 'm-scroll', '恢复跟随后继续输出')
      await Promise.resolve()
      pump.flush()
      expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'auto' })
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      pump.dispose()
    }
  })

  // P57 §6 点名改写（例外 1）：「异步高度 sticky 续跟」补入写迹前提——auto 写入落地
  // 后、反馈 scroll 事件派发前，同帧高度增长 >48px。旧位置判别会把这次竞态误判为
  // 用户离底并关掉跟随；写迹判别保持 sticky 续跟（P57 验收 ①）。
  it('auto 写入落地后同帧高度增长不再把 sticky 误判为离底', async () => {
    const previousResizeObserver = globalThis.ResizeObserver
    class MockResizeObserver {
      static instances: MockResizeObserver[] = []
      readonly observed = new Set<Element>()
      constructor(private readonly callback: ResizeObserverCallback) { MockResizeObserver.instances.push(this) }
      observe(element: Element) { this.observed.add(element) }
      unobserve(element: Element) { this.observed.delete(element) }
      disconnect() { this.observed.clear() }
      trigger() { this.callback([], this as unknown as ResizeObserver) }
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    const pump = createFramePump()
    try {
      const { host, services } = mountPreview()
      const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
      const model = createScrollModel(viewport, { top: 700 })
      const scrollTo = installInstantScrollToSink(viewport, model, pump)
      await Promise.resolve()
      pump.flush()
      scrollTo.mockClear()

      const contentObserver = MockResizeObserver.instances.find(observer => observer.observed.has(host.querySelector('.term')!))
      expect(contentObserver).toBeTruthy()
      // 异步高度变化：follow 写入排队 → 帧内落地（写迹记录 top=800）。
      model.height = 1_100
      contentObserver!.trigger()
      pump.flush()
      expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'auto' })
      expect(model.top).toBe(800)
      scrollTo.mockClear()

      // 写入落地与反馈 scroll 事件之间，内容又长高 >48px——真实浏览器的同帧竞态。
      model.height = 1_300
      pump.flush()
      // 反馈事件按写迹判为 programmatic-feedback：跟随保持，不出现「抢滚动失效」。
      streamInto(services, 'm-scroll', 'sticky 续跟的新输出')
      await Promise.resolve()
      pump.flush()
      expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'auto' })
      services.runtime.destroy()
    } finally {
      pump.dispose()
      globalThis.ResizeObserver = previousResizeObserver
    }
  })

  it.each([0.25, 1, 2, 20, 47])('上滚 %s px 后，底部容差和迟到反馈不能重新开启跟随（#74）', async (distance) => {
    const pump = createFramePump()
    try {
      const { host, services } = mountPreview()
      const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
      const model = createScrollModel(viewport, { top: 700 })
      const scrollTo = installInstantScrollToSink(viewport, model, pump)
      await Promise.resolve()
      pump.flush()
      pump.flush()
      scrollTo.mockClear()

      fireEvent.wheel(viewport, { deltaY: -distance })
      // A pending programmatic feedback event can precede the wheel's default movement.
      fireEvent.scroll(viewport)
      model.top -= distance
      fireEvent.scroll(viewport)
      services.runtime.update({ status: 'ready' })
      await Promise.resolve()
      pump.flush()
      expect(model.top).toBe(700 - distance)
      expect(scrollTo).not.toHaveBeenCalled()

      // Growing content must not reclaim the viewport either.
      model.height += 100
      services.runtime.update({ status: 'idle' })
      await Promise.resolve()
      pump.flush()
      expect(model.top).toBe(700 - distance)
      expect(scrollTo).not.toHaveBeenCalled()

      // Natural downward scrolling all the way to the endpoint resumes following.
      fireEvent.wheel(viewport, { deltaY: 200 })
      model.top = 800
      fireEvent.scroll(viewport)
      model.height += 100
      services.runtime.update({ status: 'ready' })
      await Promise.resolve()
      pump.flush()
      expect(model.top).toBe(900)
    } finally {
      pump.dispose()
    }
  })

  it.each(['wheel', 'touch', 'keyboard'] as const)('%s 打断 smooth 后冻结动画、解除锁，并允许自然回底（#74）', async (inputKind) => {
    const pump = createFramePump()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    try {
      const { host, services } = mountPreview(undefined, { reducedMotion: false })
      const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
      const model = createScrollModel(viewport, { top: 100 })
      const scrollTo = installAnimatedScrollTo(viewport, model, pump)
      fireEvent.click(screen.getByRole('button', { name: '回到底部' }))
      pump.flush()
      const interruptedTop = model.top
      expect(interruptedTop).toBeGreaterThan(100)
      expect(interruptedTop).toBeLessThan(700)
      if (inputKind === 'wheel') fireEvent.wheel(viewport, { deltaY: -2 })
      else if (inputKind === 'keyboard') fireEvent.keyDown(viewport, { key: 'ArrowUp' })
      else {
        fireEvent.touchStart(viewport, { touches: [{ clientY: 100 }] })
        fireEvent.touchMove(viewport, { touches: [{ clientY: 110 }] })
      }
      expect(scrollTo).toHaveBeenLastCalledWith({ top: interruptedTop, behavior: 'instant' })
      model.top -= 2
      fireEvent.scroll(viewport)
      services.runtime.update({ status: 'idle' })
      await Promise.resolve()
      pump.flush()
      pump.flush()
      expect(model.top).toBe(interruptedTop - 2)

      // Clock remains inside the original smooth lock. User intent releases it.
      model.top = 699.4
      fireEvent.scroll(viewport)
      model.height += 100
      services.runtime.update({ status: 'ready' })
      await Promise.resolve()
      pump.flush()
      expect(model.top).toBe(800)
    } finally {
      clock.mockRestore()
      pump.dispose()
    }
  })

  // P57 验收③（S1.3）：reducedMotion:false 变体下，▼ 的 smooth 动画分帧期间
  // revision effect 不写 instant 打断动画；到达 endpoint（且锁过期，取晚者）后
  // sticky 跟随恢复。
  it('smooth 跟随动画期间 revision effect 不写 instant，到达 endpoint 后跟随恢复', async () => {
    const previousResizeObserver = globalThis.ResizeObserver
    class MockResizeObserver {
      static instances: MockResizeObserver[] = []
      readonly observed = new Set<Element>()
      constructor(private readonly callback: ResizeObserverCallback) { MockResizeObserver.instances.push(this) }
      observe(element: Element) { this.observed.add(element) }
      unobserve(element: Element) { this.observed.delete(element) }
      disconnect() { this.observed.clear() }
      trigger() { this.callback([], this as unknown as ResizeObserver) }
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    const pump = createFramePump()
    try {
      const { host, services } = mountPreview(undefined, { reducedMotion: false })
      const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
      const model = createScrollModel(viewport, { top: 100 })
      const scrollTo = installAnimatedScrollTo(viewport, model, pump)

      // 用户上滚离底（输入模态取消），▼ 触发 smooth 回底动画（3 帧线性逼近 700）。
      fireEvent.wheel(viewport, { deltaY: -100 })
      model.top = 100
      fireEvent.scroll(viewport)
      await Promise.resolve()
      fireEvent.click(screen.getByRole('button', { name: '回到底部' }))
      expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'smooth' })
      scrollTo.mockClear()

      // 动画分帧期间流式内容推进：revision effect 排队的 applyFollow 被守卫吞掉。
      pump.flush()
      streamInto(services, 'm-scroll', '动画期间的新输出')
      await Promise.resolve()
      pump.flush()
      pump.flush()
      pump.flush()
      expect(model.top).toBe(700)
      expect(scrollTo).not.toHaveBeenCalled()

      // 到达判定（连续 2 帧距 endpoint <0.5px）与锁过期取晚者；解除后 sticky 恢复。
      let resumeTick = 0
      await waitFor(async () => {
        pump.flush()
        resumeTick += 1
        streamInto(services, 'm-scroll', `到达后的输出 ${resumeTick}`)
        await Promise.resolve()
        pump.flush()
        expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'auto' })
      }, { timeout: 3_000, interval: 50 })
      services.runtime.destroy()
    } finally {
      pump.dispose()
      globalThis.ResizeObserver = previousResizeObserver
    }
  })

  // P57 验收 2（S2-R3）：文本 chunk 只重建受影响行，其余行 DOM 身份稳定。
  // （相邻同角色 assistant delta 会被 projector 合并，故第三行用 reasoning——
  //   同样验证「未受影响行引用/身份稳定」。）
  it('文本 chunk 只重建受影响行，其余行 DOM 身份不变', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event'], identity: WorkbenchEventEnvelope['identity'] = {}) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-25T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `reuse-${sequence}` }, identity,
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const base = projectWorkbench([
      envelope(1, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '问题' }] }, { messageId: 'u1' }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '回答A' }] }, { messageId: 'a1' }),
      envelope(3, { type: 'reasoning.delta', parts: [{ kind: 'text', text: '思考中' }] }, { messageId: 'r1' }),
    ]).document
    services.runtime.replaceDocument(base, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(host.querySelectorAll('.plain-message-list__row')).toHaveLength(3))

    const userId = base.messages.find(message => message.role === 'user')!.id
    const aId = base.messages.find(message => message.content === '回答A')!.id
    const rId = base.messages.find(message => message.content === '思考中')!.id
    const userRow = host.querySelector<HTMLElement>(`[data-message-id="${userId}"]`)!
    const rowA = host.querySelector<HTMLElement>(`[data-message-id="${aId}"]`)!
    const rowR = host.querySelector<HTMLElement>(`[data-message-id="${rId}"]`)!

    const chunked = reduceWorkbenchEvent(base, envelope(4, { type: 'reasoning.delta', parts: [{ kind: 'text', text: ' 思考' }] }, { messageId: 'r1' }))
    services.runtime.replaceDocument(chunked, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(rowR).toHaveTextContent('思考中 思考'))
    expect(host.querySelector(`[data-message-id="${userId}"]`)).toBe(userRow)
    expect(host.querySelector(`[data-message-id="${aId}"]`)).toBe(rowA)
    expect(host.querySelector(`[data-message-id="${rId}"]`)).toBe(rowR)
  })

  // P57 验收 2（S2-R5 方案 A）：payload/appearance 全等不调 surface.update；
  // payload 引用变化才调用。revision 变化本身不触发 update（零契约变化）。
  it('Slot surface 的 update 在 payload/appearance 全等时被浅比较门跳过', async () => {
    const updateSpy = vi.fn()
    const surface: RenderSurface = {
      rendererId: 'test.gate',
      kind: 'solid',
      mount: container => {
        const node = document.createElement('div')
        node.className = 'test-gate-surface'
        container.append(node)
        return { mounted: true }
      },
      update: updateSpy,
      destroy: () => {},
      on: () => () => {},
    }
    const slot: RendererSlotContribution = {
      id: 'test.gate.slot',
      targetSuites: ['*'],
      kinds: ['message.assistant'],
      priority: 1,
      fallback: false,
      canRender: () => true,
      createSurface: () => surface,
    }
    const slotEntry = {
      ownerPluginId: 'test.gate', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: 1, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'test.gate', ownerRuntimeInstanceId: 'runtime',
        contributionId: suite.id, layer: 'feature', priority: 1, value: suite,
      } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(),
      slots: new Map([['message.assistant', [slotEntry]]]),
      diagnostics: [],
    }
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true },
      services,
      activation,
    })

    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event'], identity: WorkbenchEventEnvelope['identity'] = {}) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-25T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `gate-${sequence}` }, identity,
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const base = projectWorkbench([
      envelope(1, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '问题' }] }, { messageId: 'u1' }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '回答' }] }, { messageId: 'a1' }),
    ]).document
    services.runtime.replaceDocument(base, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.test-gate-surface')).not.toBeNull())
    // mount 后首个 effect 重跑会做一次幂等 update（首次门通过）；清零后按门语义断言。
    await Promise.resolve()
    await Promise.resolve()
    updateSpy.mockClear()
    expect(updateSpy).not.toHaveBeenCalled()

    // 追加 interaction（显示相关但完全不触碰 assistant 消息的负载）：显示链照常
    // 发表，assistant payload 引用经包装复用保持稳定 → update 被门跳过。
    //（注意：追加 user/reasoning 行会合法 settle 运行中的 assistant，payload 真实变化。）
    const frozenBase = services.runtime.getSnapshot().document!
    const withInteraction = reduceWorkbenchEvent(frozenBase, envelope(3, { type: 'interaction.requested', interactionId: 'ask-1', request: { question: '继续?' } }, { interactionId: 'ask-1' }))
    services.runtime.applyDocument(withInteraction, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(host.querySelector('[aria-label="交互"]')).not.toBeNull())
    expect(updateSpy).not.toHaveBeenCalled()

    // reasoning 行 settle 运行中的 assistant（running 翻转）→ payload 引用变化 →
    // update 必须调用。
    const withReasoning = reduceWorkbenchEvent(withInteraction, envelope(4, { type: 'reasoning.delta', parts: [{ kind: 'text', text: '思考' }] }, { messageId: 'r1' }))
    services.runtime.applyDocument(withReasoning, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(updateSpy).toHaveBeenCalled())
    // a1 的 payload（running 翻转）必须真实到达 surface；fixture 行的合法更新不干扰断言。
    const assistantRowNodeId = base.messages.find(message => message.content === '回答')!.id
    expect(updateSpy.mock.calls.some(([, node]) => (node as { nodeId: string }).nodeId === assistantRowNodeId)).toBe(true)

    // appearance 变化（稳定化键不同）→ update 调用。
    updateSpy.mockClear()
    const theme = structuredClone(DEFAULTS)
    theme.userName = '改名用户'
    services.appearance.setTheme(theme)
    await waitFor(() => expect(updateSpy).toHaveBeenCalled())
  })

  // P57 §6 点名改写（例外 1）：「同帧合并 + 离底取消排队写入」中取消路径从纯位置
  // 判别改为输入模态判别（wheel 上滚作废排队写入）；同帧合并契约不变。
  it('同一帧 outer follow 合并多次 ResizeObserver 通知，且用户输入取消排队写入', async () => {
    const previousResizeObserver = globalThis.ResizeObserver
    class MockResizeObserver {
      static instances: MockResizeObserver[] = []
      readonly observed = new Set<Element>()
      constructor(private readonly callback: ResizeObserverCallback) { MockResizeObserver.instances.push(this) }
      observe(element: Element) { this.observed.add(element) }
      unobserve(element: Element) { this.observed.delete(element) }
      disconnect() { this.observed.clear() }
      trigger() { this.callback([], this as unknown as ResizeObserver) }
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    const pump = createFramePump()
    try {
      const { host, services } = mountPreview()
      const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
      const model = createScrollModel(viewport, { top: 700 })
      const scrollTo = installInstantScrollToSink(viewport, model, pump)
      await Promise.resolve()
      pump.flush()
      scrollTo.mockClear()

      const contentObserver = MockResizeObserver.instances.find(observer => observer.observed.has(host.querySelector('.term')!))
      expect(contentObserver).toBeTruthy()
      model.height = 1_100
      // Drop mount/connector work; the assertions below measure only this
      // content observer's same-frame follow request.
      pump.clear()
      contentObserver!.trigger()
      contentObserver!.trigger()
      contentObserver!.trigger()
      expect(scrollTo).not.toHaveBeenCalled()
      expect(pump.pending()).toBe(1)
      pump.flush()
      expect(scrollTo).toHaveBeenCalledTimes(1)
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 800, behavior: 'auto' })

      // A user scroll (wheel 上滚) invalidates the queued action before its
      // frame runs（输入模态取消，滚动反馈不再需要位置判别兜底）。
      model.top = 100
      model.height = 1_200
      contentObserver!.trigger()
      fireEvent.wheel(viewport, { deltaY: -100 })
      pump.flush()
      expect(scrollTo).toHaveBeenCalledTimes(1)
      services.runtime.destroy()
    } finally {
      pump.dispose()
      globalThis.ResizeObserver = previousResizeObserver
    }
  })

  it('右栏与 Solid 对 canonical semantic parts 使用同一搜索文本口径', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const { host, services } = mountPreview()
    const current = services.runtime.getSnapshot().document!
    const target = current.messages.find(message => message.id === 'fixture-assistant-markdown')!
    services.runtime.replaceDocument({
      ...current,
      messages: [{ ...target, content: '', parts: [{ kind: 'text', text: 'canonical semantic needle' }] }],
    }, { ownerKey: 'owner-preview', generation: 1 })

    services.sessionUi.set('preview-session', 'search-query', 'semantic needle')

    await waitFor(() => expect(
      host.querySelector('[data-message-id="fixture-assistant-markdown"] .term-row-search-active'),
    ).not.toBeNull())
  })

  it('把同一助手消息的流式文本 parts 渲染为一个连续 Markdown 块', async () => {
    const { host, services } = mountPreview()
    const chunk = (sequence: number, text: string) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence,
      recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `assistant-chunk-${sequence}` },
      identity: { messageId: `rotated-chunk-${sequence}` },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text }] },
    })
    const projected = projectWorkbench([
      chunk(1, '这是'), chunk(2, '完整的'), chunk(3, '助手'), chunk(4, '回复。'),
    ]).document
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    const body = await waitFor(() => {
      const element = host.querySelector(`[data-message-id="${projected.messages[0]!.id}"] .term-assistant-body`)
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(body).toHaveTextContent('这是完整的助手回复。')
    expect(body.querySelectorAll('p')).toHaveLength(1)
  })

  it('同一 provider message id 跨工具形成独立且重放稳定的助手 DOM 行', async () => {
    const { host, services } = mountPreview()
    const make = (sequence: number, event: WorkbenchEventEnvelope['event'], identity: WorkbenchEventEnvelope['identity']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence,
      recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `segment-${sequence}` }, identity,
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const projected = projectWorkbench([
      make(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '工具前回复' }] }, { messageId: 'shared-provider-id' }),
      make(2, { type: 'tool.started', tool: { name: 'Read', title: '读取' } }, { toolCallId: 'tool-between-segments' }),
      make(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '工具后回复' }] }, { messageId: 'shared-provider-id' }),
    ]).document

    expect(new Set(projected.messages.map(message => message.id)).size).toBe(2)
    for (let iteration = 0; iteration < 20; iteration += 1) {
      services.runtime.replaceDocument(structuredClone(projected), { ownerKey: 'owner-preview', generation: iteration + 1 })
    }

    await waitFor(() => expect(host.querySelectorAll('.plain-message-list__row')).toHaveLength(2))
    const rows = [...host.querySelectorAll<HTMLElement>('.plain-message-list__row')]
    expect(rows.map(row => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('工具前回复'),
      expect.stringContaining('工具后回复'),
    ]))
    expect(host.querySelectorAll('[data-activity-id="tool-between-segments"]')).toHaveLength(1)
  })

  it('canonical assistant chunk updates reuse one content Slot and propagate streaming state', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    let destroys = 0
    const mountedNodeIds: string[] = []
    const updates: Array<{ text: string; streaming?: boolean }> = []
    let canonicalNodeId: string | undefined
    const slot: RendererSlotContribution = {
      id: 'test.streaming-markdown', targetSuites: ['builtin.solid'], kinds: ['content.markdown'],
      priority: 10, fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'test.streaming-markdown', kind: 'solid',
        mount(container, snapshot) {
          const payload = snapshot.payload as { text?: string }
          if (!canonicalNodeId && payload.text?.startsWith('# 标题')) canonicalNodeId = snapshot.nodeId
          const target = snapshot.nodeId === canonicalNodeId
          if (target) mountedNodeIds.push(snapshot.nodeId)
          const node = document.createElement('p')
          container.append(node)
          const apply = (value: typeof snapshot) => {
            const payload = value.payload as { text?: string }
            node.textContent = payload.text ?? ''
            if (target) updates.push({ text: payload.text ?? '', streaming: (value as typeof value & { streaming?: boolean }).streaming })
          }
          apply(snapshot)
          return { node, apply, target }
        },
        update(handle, snapshot) { (handle as { apply(value: typeof snapshot): void }).apply(snapshot) },
        destroy(handle) {
          if ((handle as { target: boolean }).target) destroys += 1
          ;(handle as { node: HTMLElement }).node.remove()
        },
        on: () => () => {},
      }),
    }
    const entry = {
      ownerPluginId: 'test.streaming-markdown', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id,
      layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite },
      kinds: new Map(), slots: new Map([['content.markdown', [entry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })

    const events: WorkbenchEventEnvelope[] = []
    const chunk = (sequence: number, text: string, type: 'message.delta' | 'message.completed' = 'message.delta') => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: `2026-08-25T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      source: { provider: 'peri', sourceId: `canonical-stream-${sequence}` }, identity: { messageId: `canonical-stream-${sequence}` },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type, role: 'assistant', parts: [{ kind: 'markdown', text }] },
    })
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      events.push(chunk(sequence, sequence === 1 ? '# 标题\n\n' : `片段${sequence} `))
      services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: sequence })
    }

    await waitFor(() => expect(updates.at(-1)?.text).toContain('片段20'))
    expect(updates.at(-1)?.streaming).toBe(true)

    events.push(chunk(21, '', 'message.completed'))
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 21 })
    await waitFor(() => expect(updates.at(-1)?.streaming).toBeUndefined())

    expect(mountedNodeIds).toEqual([canonicalNodeId])
    expect(destroys).toBe(0)
    const canonicalMessageId = projectWorkbench(events).document.messages[0]!.id
    expect(host.querySelectorAll(`[data-message-id="${canonicalMessageId}"]`)).toHaveLength(1)
  })

  it('诊断：诗歌流式旁路切到 canonical 后保留段落结构', async () => {
    const { host, services } = mountPreview()
    const poem = '**星河**\n\n春风拂过山岗\n月光落在窗\n\n我把远方写进诗行\n让星河在梦里流淌'
    services.runtime.replaceDocument(createWorkbenchDocument('preview-session'), {
      ownerKey: 'owner-preview', generation: 1, sessionId: 'preview-session',
    })
    streamInto(services, 'm-poem', poem)
    const streamingBody = await waitFor(() => {
      const body = host.querySelector('.term-row-assistant .term-assistant-body')
      expect(body).not.toBeNull()
      return body as HTMLElement
    })
    const streamingMarkup = streamingBody.innerHTML

    const events = [
      createWorkbenchEnvelope({
        sessionId: 'preview-session', sequence: 1,
        recordedAt: '2026-08-25T00:00:01.000Z',
        source: { provider: 'peri', sourceId: 'poem-delta' },
        identity: { messageId: 'poem-message' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'markdown', text: poem }] },
      }),
      createWorkbenchEnvelope({
        sessionId: 'preview-session', sequence: 2,
        recordedAt: '2026-08-25T00:00:02.000Z',
        source: { provider: 'peri', sourceId: 'poem-complete' },
        identity: { messageId: 'poem-message' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'message.completed', role: 'assistant', parts: [] },
      }),
    ]
    const finalDocument = projectWorkbench(events).document
    services.runtime.replaceDocument(finalDocument, {
      ownerKey: 'owner-preview', generation: 2, sessionId: 'preview-session',
    })
    services.runtime.update({ generating: false })

    const finalBody = await waitFor(() => {
      const body = host.querySelector(`[data-message-id="${finalDocument.messages[0]!.id}"] .term-assistant-body`)
      expect(body).not.toBeNull()
      return body as HTMLElement
    })
    await waitFor(() => expect(finalBody.querySelector('strong')).not.toBeNull())
    // Keep this seam explicit: the final renderer must expose all three blocks
    // and preserve the soft line break inside each verse.
    expect(streamingMarkup).toContain('春风拂过山岗')
    expect(finalBody.textContent).toContain('春风拂过山岗\n月光落在窗')
    expect(finalBody.querySelectorAll('p')).toHaveLength(3)
  })

  it('canonical 思考行唯一渲染（P52 D5 后无 transient 第二来源）', async () => {
    const { host, services } = mountPreview()
    const reasoning = createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'thinking-stream' },
      identity: { turnId: 'thinking-turn' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'reasoning.delta', parts: [{ kind: 'text', text: '同一段思考' }] },
    })
    const document = projectWorkbench([reasoning]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })
    services.runtime.update({ generating: true })

    await waitFor(() => expect(host.querySelectorAll('.term-row-reasoning')).toHaveLength(1))
    expect(host.querySelectorAll('.term-reasoning')).toHaveLength(1)
  })

  it('canonical 终态思考行唯一渲染（transient 已死，无第二行来源）', async () => {
    const { host, services } = mountPreview()
    const reasoning = createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'thinking-terminal' },
      identity: { turnId: 'thinking-terminal-turn' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'reasoning.completed', parts: [{ kind: 'text', text: '终态思考' }] },
    })
    services.runtime.replaceDocument(projectWorkbench([reasoning]).document, { ownerKey: 'owner-preview', generation: 1 })
    services.runtime.update({ generating: false })

    await waitFor(() => expect(host.querySelectorAll('.term-row-reasoning')).toHaveLength(1))
    expect(host.querySelectorAll('.term-reasoning')).toHaveLength(1)
  })

  it('legacy 工具行接管消息列表时仍保留 canonical/legacy 思考流可见性', async () => {
    const { host, services } = mountPreview()
    const reasoning = createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'thinking-with-tool' },
      identity: { turnId: 'thinking-with-tool-turn' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'reasoning.delta', parts: [{ kind: 'text', text: '工具旁的思考' }] },
    })
    const canonical = projectWorkbench([reasoning]).document
    // #487：legacy tool 行通道已退役——canonical 思考行是唯一渲染来源（P52 D5）。
    services.runtime.applyDocument(canonical, { generationPatch: { generating: true } })

    await waitFor(() => expect(host.querySelectorAll('.term-row-reasoning')).toHaveLength(1))
    expect(host).toHaveTextContent('工具旁的思考')
  })

  it('canonical reasoning updates keep one expanded Slot live until completion', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite },
      kinds: new Map(), slots: new Map([['content.reasoning', [slotEntry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })

    const envelope = (sequence: number, text: string, type: 'reasoning.delta' | 'reasoning.completed' = 'reasoning.delta') => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `reasoning-${sequence}` }, identity: { messageId: 'reasoning-stream' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type, parts: text ? [{ kind: 'markdown', text }] : [] },
    })
    const events = [envelope(1, '1. 我应该先检查')]
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 1 })

    const canonicalMessageId = projectWorkbench(events).document.messages[0]!.id
    const button = await waitFor(() => {
      const node = host.querySelector<HTMLButtonElement>(`[data-message-id="${canonicalMessageId}"] .term-reasoning-head`)
      expect(node).not.toBeNull()
      return node!
    })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    const reasoning = host.querySelector('.term-reasoning')
    expect(reasoning).not.toBeNull()

    events.push(envelope(2, '，然后继续验证。'))
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 2 })
    await waitFor(() => expect(reasoning).toHaveTextContent('我应该先检查，然后继续验证。'))
    expect(reasoning?.querySelector('ol > li')).toHaveTextContent('我应该先检查，然后继续验证。')
    expect(host.querySelector('.term-reasoning')).toBe(reasoning)
    expect(button).toHaveAttribute('aria-expanded', 'true')

    events.push(envelope(3, '', 'reasoning.completed'))
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 3 })
    await waitFor(() => expect(reasoning).toHaveAttribute('data-state', 'complete'))
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(host.querySelector('.term-reasoning')).toBe(reasoning)
  })

  it('反复替换同一会话文档时不累积助手回复 DOM', async () => {
    const { host, services } = mountPreview()
    const chunk = (sequence: number, text: string) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence,
      recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `repeat-chunk-${sequence}` },
      identity: { messageId: `repeat-chunk-${sequence}` },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text }] },
    })
    const document = projectWorkbench([chunk(1, '不会'), chunk(2, '重复')]).document
    const messageId = document.messages[0]!.id

    for (let iteration = 0; iteration < 100; iteration += 1) {
      services.runtime.replaceDocument(structuredClone(document), { ownerKey: 'owner-preview', generation: iteration + 1 })
    }

    await waitFor(() => expect(host.querySelectorAll(`[data-message-id="${messageId}"]`)).toHaveLength(1))
    const rows = host.querySelectorAll(`[data-message-id="${messageId}"]`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('不会重复')
    expect(rows[0]!.querySelectorAll('.term-assistant-body p')).toHaveLength(1)
  })

  it('切换会话时即使 message id 相同也只保留当前会话的一行', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite },
      kinds: new Map(), slots: new Map([['content.markdown', [slotEntry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    const lifecycle = mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true }, services, activation,
    })
    const documentFor = (sessionId: string, text: string) => projectWorkbench([
      createWorkbenchEnvelope({
        sessionId, sequence: 1,
        recordedAt: `2026-08-25T00:00:0${sessionId === 'session-a' ? '1' : '2'}.000Z`,
        source: { provider: 'peri', sourceId: `${sessionId}-tool` },
        identity: { toolCallId: 'same-tool-id' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'tool.started', tool: { name: `Read ${text}` } },
      }),
      createWorkbenchEnvelope({
        sessionId, sequence: 2,
        recordedAt: `2026-08-25T00:00:0${sessionId === 'session-a' ? '1' : '2'}.500Z`,
        source: { provider: 'peri', sourceId: `${sessionId}-source` },
        identity: { messageId: 'same-message-id' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'markdown', text }] },
      }),
    ]).document

    const sessionADocument = documentFor('session-a', '会话 A')
    const sessionBDocument = documentFor('session-b', '会话 B')
    const sessionAMessageId = sessionADocument.messages[0]!.id
    services.runtime.replaceDocument(sessionADocument, {
      ownerKey: 'owner-a', generation: 1, sessionId: 'session-a',
    })
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'session-a', preview: true })
    const firstRow = await waitFor(() => {
      const row = host.querySelector(`[data-message-id="${sessionAMessageId}"]`)
      expect(row?.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).toHaveTextContent('会话 A')
      if (!row) throw new Error('session A production Slot row not mounted')
      return row
    })
    const firstSlot = firstRow.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')
    const firstTool = host.querySelector('[data-activity-id="same-tool-id"]')
    expect(firstTool).not.toBeNull()

    for (let iteration = 0; iteration < 100; iteration += 1) {
      services.runtime.replaceDocument(sessionBDocument, {
        ownerKey: 'owner-b', generation: iteration + 1, sessionId: 'session-b',
      })
      lifecycle.update({ sheetId: 'sheet-a', sessionId: 'session-b', preview: true })
      services.runtime.replaceDocument(sessionADocument, {
        ownerKey: 'owner-a', generation: iteration + 2, sessionId: 'session-a',
      })
      lifecycle.update({ sheetId: 'sheet-a', sessionId: 'session-a', preview: true })
    }

    await waitFor(() => expect(host.querySelector(`[data-message-id="${sessionAMessageId}"]`)).toHaveTextContent('会话 A'))
    expect(host.querySelectorAll(`[data-message-id="${sessionAMessageId}"]`)).toHaveLength(1)
    expect(host.querySelectorAll('[data-renderer-slot-id="builtin.solid.content.base"]')).toHaveLength(1)
    expect(host.querySelector(`[data-message-id="${sessionAMessageId}"]`)).not.toBe(firstRow)
    expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBe(firstSlot)
    expect(host.querySelectorAll('[data-activity-id="same-tool-id"]')).toHaveLength(1)
    expect(host.querySelector('[data-activity-id="same-tool-id"]')).not.toBe(firstTool)
    expect(host).not.toHaveTextContent('会话 B')
  })

  it('合并流式文本时保留非文本 semantic part 的渲染边界', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'mixed-content' },
      identity: { messageId: 'mixed-content' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [
        { kind: 'text', text: '前半' },
        { kind: 'text', text: '正文' },
        { kind: 'code', text: 'const answer = 42', language: 'ts' },
        { kind: 'markdown', text: '后半' },
        { kind: 'text', text: '正文' },
      ] },
    })]).document
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    const body = await waitFor(() => {
      const element = host.querySelector(`[data-message-id="${projected.messages[0]!.id}"] .term-assistant-body`)
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(body.querySelectorAll('p')).toHaveLength(2)
    expect(body.querySelector('.term-code-block')).not.toBeNull()
    expect(body.textContent).toContain('前半正文')
    expect(body.textContent).toContain('后半正文')
  })

  it('挂载完整 fixture shell，复用 Message/Tool/Task/Generation renderer', async () => {
    const { host } = mountPreview()

    expect(screen.getByLabelText('Solid Agent Workbench')).toBeInTheDocument()
    expect(host.querySelector('[data-renderer="solid"]')?.getAttribute('data-preview')).toBe('true')
    // 预算依据：等待对象是 fixture shell 动态 import + 首帧渲染（ms 级）；2s 覆盖
    // 满载并发抖动，原 5s 是 P91 期粗放放宽（#175 已消除满载 paging 根因）。
    expect(await screen.findByRole('heading', { name: '迁移结果' }, FLUSH_BUDGET)).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(host.querySelector('.task-tree')).toBeInTheDocument()
    expect(host.querySelector('.term-spinner')).toBeInTheDocument()
    expect(host.querySelector('.control-center')?.getAttribute('data-control-center')).toBe('production')
    // #483：pet 占位（.pet-companion）随宠物链删除退役，不再挂载。
    expect(host.querySelector('.pet-companion')).toBeNull()
    await waitFor(() => expect(host.querySelectorAll('.plain-message-list__row').length).toBeGreaterThan(0))
  })

  it('中控状态行仅保留常态控件（模型）与命令提示，其余旧控件关闭', async () => {
    const { host } = mountPreview()
    const row = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('.cc-status-row')
      expect(value).not.toBeNull()
      return value!
    })
    // 2026-09-15：模型/思考强度/权限/用量四控件常态显示；其余旧状态控件在活跃会话里仍然收起。
    // ★ #238 刀5B：命令行提示升格为普通元件后也在这一行（活跃会话 + cli 模式 ⇒ 三条条件满足）。
    expect([...row.querySelectorAll('[data-widget-id]')]
      .map(el => el.getAttribute('data-widget-id'))).toEqual(['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint'])
    // ★ #238 刀5B：**分隔点整族删除** ⇒ 一个都不许有（用户口径「分割点可以不要」）。
    //   判据用"组里除了元件节点没有别的东西"，比找文本 `·` 稳（元件自己的文案不受影响）。
    const group = row.querySelector('.cc-status-group')!
    expect(row.querySelector('.cc-widget-separator')).toBeNull()
    expect(group.querySelectorAll('.cc-widget').length).toBe(group.childElementCount)
  })

  /**
   * ★★ #266 刀2.5：**声明式脱离**（横向独立定位）。
   *
   * 声明位在定义表上（静态真值，`widgetDefinitions.ts` 每行的 `detachX`）⇒ 这里临时声明、
   * `finally` 收回，测的正是验收项 3/4：「未声明 = 排队」「声明 = 脱离 + 独立贴边」「两件声明到
   * 同一处 ⇒ 都脱离、互不挤开（允许重叠）」。
   * ★ 几何（真的叠上去了没）在 jsdom 里量不出来 —— 那是**实机读数**的事；这里锁的是
   *   类名、内联定位来源与"DOM 结构不因脱离而变"。
   */
  it('★ 刀2.5 声明式脱离：未声明 = 排队；声明 = 脱离队列、按声明贴边、可叠', async () => {
    // ── ① 默认（表里一个都不声明）⇒ 无脱离类；最小宽已暴露（约束值，本刀不消费）──
    const { host } = mountPreview()
    await waitFor(() => expect(host.querySelector('.cc-status-group [data-widget-id="tokens"]')).toBeInTheDocument())
    expect(host.querySelectorAll('.cc-widget.cc-detach-x')).toHaveLength(0)
    expect(host.querySelector<HTMLElement>('.control-center')!.style.getPropertyValue('--cc-min-width')).toBe('384px')

    // ── ② 声明 tokens 与 mode 贴到同一处（背景板右边内 12px）──
    const tokensRow = resolveCcWidgetGroup('tokens') as { detachX?: CcDetachX }
    const modeRow = resolveCcWidgetGroup('mode') as { detachX?: CcDetachX }
    tokensRow.detachX = { anchor: 'cc-surface', side: 'right', gap: 12 }
    modeRow.detachX = { anchor: 'cc-surface', side: 'right', gap: 12 }
    try {
      const second = mountPreview()
      await waitFor(() => expect(second.host.querySelector('.cc-status-group [data-widget-id="tokens"]')).toBeInTheDocument())
      // 只有声明过的两件脱离；其余三件照旧排队（DOM 结构不因脱离而变，脱离只是定位层面的事）
      expect([...second.host.querySelectorAll('.cc-widget.cc-detach-x')]
        .map(el => el.getAttribute('data-widget-id')).sort()).toEqual(['mode', 'tokens'])
      expect([...second.host.querySelectorAll('.cc-status-group [data-widget-id]')]
        .map(el => el.getAttribute('data-widget-id'))).toEqual(['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint'])
      // 两件读到的是**同一条声明** ⇒ 定位值逐项相同（同一处叠着，互不挤开）
      for (const id of ['mode', 'tokens']) {
        const element = second.host.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
        expect([element.style.left, element.style.right], id).toEqual(['auto', '12px'])
      }
      // 队列少两件 ⇒ 最小宽 120 + 132 + 0 = 252；两个脱离组各 12 / 132 ⇒ max 仍是 252
      expect(second.host.querySelector<HTMLElement>('.control-center')!.style.getPropertyValue('--cc-min-width')).toBe('252px')
    } finally {
      delete tokensRow.detachX
      delete modeRow.detachX
    }

    // ── ③ 撤回声明 ⇒ 回到队列（"未声明 = 照旧排队"）──
    const third = mountPreview()
    await waitFor(() => expect(third.host.querySelector('.cc-status-group [data-widget-id="tokens"]')).toBeInTheDocument())
    expect(third.host.querySelectorAll('.cc-widget.cc-detach-x')).toHaveLength(0)
    expect(third.host.querySelector<HTMLElement>('.control-center')!.style.getPropertyValue('--cc-min-width')).toBe('384px')
  })

  it('update 不重挂 root，并切换 replay/Session 输入', async () => {
    const { host, lifecycle } = mountPreview()
    const root = host.firstElementChild

    lifecycle.update({
      sheetId: 'sheet-a',
      sessionId: 'preview-session',
      preview: true,
      replayReadonly: true,
      rightInset: 80,
    })

    await waitFor(() => expect(screen.getByText('历史回放 · 只读')).toBeInTheDocument())
    expect(host.firstElementChild).toBe(root)
    expect(host.querySelector('.control-center')).toBeNull()
    expect(host.firstElementChild?.getAttribute('style')).toContain('--right-panel-inset: 80px')

    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
    })
    const emptyState = await screen.findByRole('region', { name: 'Agent 工作台空态' })
    expect(emptyState).toHaveAttribute('data-control-center', 'production')
    expect(screen.getByRole('img', { name: 'Pylon Agent' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '新会话工作区' })).toBeNull()
    expect(screen.getByRole('textbox', { name: '消息输入' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '开始新会话' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加附件' })).toBeNull()
    expect(screen.queryByLabelText('输入快捷键提示')).toBeNull()
    expect(host.querySelector('.control-center')).toBe(emptyState)
    expect(host.querySelectorAll('.input-textarea')).toHaveLength(1)
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, replayReadonly: false })
    await waitFor(() => expect(host.querySelector('.solid-workbench-chat-shell')).toBeInTheDocument())
    expect(host.querySelector('.control-center')).toBe(emptyState)
    expect(host.firstElementChild).toBe(root)
  })

  it('空态只有一个工作区时自动选中，并随首条请求创建会话', async () => {
    const { services, lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })

    // 04b：空态工作区选择器已隐藏（SHOW_EMPTY_WORKSPACE_CONTROL=false）；
    // 预选逻辑仍生效 —— 由下面的 createSession 实参断言锁住。
    await screen.findByRole('region', { name: 'Agent 工作台空态' })
    const prompt = screen.getByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '检查当前项目' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'createSession',
      args: [{ workspaceId: 'workspace-a', initialPrompt: { text: '检查当前项目', attachments: [] }, mode: 'auto', model: 'deepseek-v4-flash', reasoningLevel: 'medium' }],
    }))
  })

  it('空态有多个工作区时按 host 提供的最近活跃时间预选', async () => {
    const { services, lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [
        { id: 'workspace-old', label: '旧项目', path: 'G:/old', lastActiveAt: 10 },
        { id: 'workspace-recent', label: '最近项目', path: 'G:/recent', lastActiveAt: 30 },
      ],
    })

    // 04b：选择器隐藏后，预选结果改由 createSession 实参断言
    //（空态回车建会话依赖这条预选逻辑，必须继续被锁住）。
    await screen.findByRole('region', { name: 'Agent 工作台空态' })
    const prompt = screen.getByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '走预选的工作区' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'createSession',
      args: [expect.objectContaining({ workspaceId: 'workspace-recent' })],
    }))

    // 合并 main（#177 侧）：工作区列表换成未知项时，预选必须清空——
    // 不选工作区即创建无 cwd 会话是合法意图。04b：选择器已隐藏，
    // 断言改由 createSession 实参表达（不能再用 combobox value）。
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [
        { id: 'workspace-unknown-a', label: '未知 A', path: 'G:/unknown-a' },
        { id: 'workspace-unknown-b', label: '未知 B', path: 'G:/unknown-b' },
      ],
    })
    // 第一段 createSession 的调用记录先于其完成（invoke 入口同步 push，await handler
    // 还在微任务队列里）。此处必须等 submitting 收敛（textarea 重新可用）再喂第二段，
    // 否则 keydown 落在禁用的 textarea 上被浏览器语义吞掉——这正是本用例曾踩的竞态。
    await waitFor(() => expect((prompt as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.input(prompt, { target: { value: '未知工作区不预选' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })
    await waitFor(() => {
      const last = services.commands.calls[services.commands.calls.length - 1]
      expect(last.command).toBe('createSession')
      expect(last.args[0]).not.toHaveProperty('workspaceId')
    })
  })

  it('Sidebar 创建会话事件先到达时缓存 workspaceId，不被空态初始化覆盖', async () => {
    const { services, lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: 'preview-session', preview: true,
      availableWorkspaces: [
        { id: 'workspace-old', label: '旧项目', path: 'G:/old', lastActiveAt: 100 },
        { id: 'workspace-target', label: '目标项目', path: 'G:/target', lastActiveAt: 1 },
      ],
    })
    // Sidebar dispatches before clearing the selected session.
    window.dispatchEvent(new CustomEvent('pylon:new-session', { detail: { workspaceId: 'workspace-target' } }))
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [
        { id: 'workspace-old', label: '旧项目', path: 'G:/old', lastActiveAt: 100 },
        { id: 'workspace-target', label: '目标项目', path: 'G:/target', lastActiveAt: 1 },
      ],
    })
    // 04b：选择器隐藏后，缓存的 workspaceId 改由 createSession 实参断言
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '用缓存的工作区' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })
    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'createSession',
      args: [expect.objectContaining({ workspaceId: 'workspace-target' })],
    }))
  })

  it('04b 空态极简：只剩输入栏，工作区选择器与 5 个控件都不渲染', async () => {
    const { host, lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })
    const emptyState = await screen.findByRole('region', { name: 'Agent 工作台空态' })

    // 甲：选择器隐藏（实现保留，置 SHOW_EMPTY_WORKSPACE_CONTROL=true 即恢复）
    expect(screen.queryByRole('combobox', { name: '新会话工作区' })).toBeNull()
    // 乙：空态只留输入栏；发送按钮（注册轨）与四个状态控件都不渲染
    expect([...emptyState.querySelectorAll('[data-widget-id]')].map(el => el.getAttribute('data-widget-id'))).toEqual(['input'])
    expect(emptyState.querySelector('.cc-send-button')).toBeNull()
    expect(screen.getByRole('textbox', { name: '消息输入' })).toBeInTheDocument()
    // 戊：状态行三个槽位无任何控件（容器折叠的前提；实机高度实测见报告）
    expect(emptyState.querySelectorAll('.cc-status-secondary > *, .cc-status-primary > *, .cc-actions > *')).toHaveLength(0)
    expect(host.querySelector('.cc-widget-separator')).toBeNull()
  })

  it('04b 空态：回车仍建会话（选择器隐藏不影响提交路径）', async () => {
    const { services, lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '直接开新会话' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'createSession',
      args: [expect.objectContaining({
        workspaceId: 'workspace-a',
        initialPrompt: { text: '直接开新会话', attachments: [] },
      })],
    }))
  })

  it('04b 空态 + 编辑模式：状态控件**不再豁免**（仍不在场），选择器仍不显示', async () => {
    const { services, lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })
    const emptyState = await screen.findByRole('region', { name: 'Agent 工作台空态' })
    expect([...emptyState.querySelectorAll('[data-widget-id]')].map(el => el.getAttribute('data-widget-id'))).toEqual(['input'])

    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    // 正控：编辑左列已出现 —— 否则下面那句"仍然只有 input"会因为"根本没进编辑态"而假绿
    await screen.findByRole('group', { name: '中控元件' })
    // ★ 刀1 反转自 CC-02「4 个状态控件豁免可见」：编辑态不再豁免
    //   ⇒ 空态名单里的件仍**不在场**（清单才是它们唯一的入口）
    expect([...emptyState.querySelectorAll('[data-widget-id]')].map(el => el.getAttribute('data-widget-id'))).toEqual(['input'])
    // 甲：编辑态也不显示选择器
    expect(screen.queryByRole('combobox', { name: '新会话工作区' })).toBeNull()
  })

  it('04b 丙-2（随 main #177 订正）：空态零工作区时点发送 ⇒ 直接创建无 cwd 会话，不再拦截', async () => {
    const { services, lifecycle } = mountPreview()
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true, availableWorkspaces: [] })
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '没有工作区可用' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    // main（e05bc80c / #177）已删除「请先选择工作区」守卫：不选工作区即创建无 cwd 会话是合法意图。
    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'createSession',
      args: [expect.objectContaining({ initialPrompt: { text: '没有工作区可用', attachments: [] } })],
    }))
    const last = services.commands.calls[services.commands.calls.length - 1]
    expect(last.args[0]).not.toHaveProperty('workspaceId')
  })

  it('空态创建后标记进入过渡态', async () => {
    const { host, lifecycle } = mountPreview()
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true })
    await screen.findByRole('region', { name: 'Agent 工作台空态' })
    // ★ #266 CC-29：原来这里还断言空态不挂载 composer 的快捷键提示段。该段在生产代码里
    //   零渲染（已随本单删掉其悬空 CSS）⇒ 断言恒真、失去靶子，已移出；用例名同步收窄。
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'preview-session', preview: true })
    await waitFor(() => expect(host.querySelector('.control-center')?.className).toContain('is-session-entering'))
  })

  it('空态创建期间冻结事务输入并暴露忙碌状态', async () => {
    let finishCreation: ((value: { sessionId: string }) => void) | undefined
    const { services, lifecycle } = mountPreview()
    services.commands.setHandler('createSession', vi.fn(() => new Promise<{ sessionId: string }>(resolve => { finishCreation = resolve })))
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '执行耗时任务' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    const emptyState = screen.getByRole('region', { name: 'Agent 工作台空态' })
    expect(emptyState).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('combobox', { name: '新会话工作区' })).toBeNull()
    expect(prompt).toBeDisabled()

    finishCreation?.({ sessionId: 'created-session' })
    await waitFor(() => expect(emptyState).toHaveAttribute('aria-busy', 'false'))
  })

  it('空态发送后在 ACP 尚未返回时把创建过渡层放在聊天 viewport 中', async () => {
    let finishCreation: ((value: { sessionId: string }) => void) | undefined
    const { host, services, lifecycle } = mountPreview()
    services.commands.setHandler('createSession', vi.fn(() => new Promise<{ sessionId: string }>(resolve => { finishCreation = resolve })))
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true })
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '立即进入过渡' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    await waitFor(() => {
      const center = host.querySelector('.control-center')
      expect(center).toHaveAttribute('data-creation-state', 'creating')
      const progress = host.querySelector('[data-creation-progress]')
      expect(progress).not.toBeNull()
      expect(progress?.closest('[data-creation-overlay-host]')).not.toBeNull()
      expect(progress?.closest('.control-center')).toBeNull()
      expect(host.querySelector('.solid-workbench-empty-chat-viewport')).not.toBeNull()
    })
    finishCreation?.({ sessionId: 'created-session' })
    await waitFor(() => expect(host.querySelector('[data-creation-progress]')).toBeNull())
  })

  it('创建失败分支保留已选会话并停止创建进度', async () => {
    const { host, services, lifecycle } = mountPreview()
    const creation = services.commands.sessionCreation as WorkbenchSessionCreationStore
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'created-session', preview: true })
    const attempt = creation.begin()
    creation.markSessionSelected(attempt, 'created-session')
    creation.markFailed(attempt, '首条请求失败', 'created-session')

    await waitFor(() => {
      expect(host.querySelector('.solid-workbench-chat-shell[data-chat-viewport="session"]')).not.toBeNull()
      expect(host.querySelector('.solid-agent-workbench')).toHaveAttribute('data-creation-state', 'creation-failed')
    })
    expect(host.querySelector('[data-creation-progress]')).toBeNull()
    expect(host.querySelector('.solid-workbench-chat-shell')?.getAttribute('data-chat-viewport')).toBe('session')
  })

  it('首条 prompt 异步失败时保留可重试草稿并把焦点交回输入栏', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const createdSession: Session = {
      id: 'created-session', source: 'local:created-session', agentId: 'peri', profileId: 'profile-a', name: 'Created',
      createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }
    const lifecycleRef: { current?: ReturnType<typeof mountSolidWorkbench> } = {}
    services.commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === createdSession.id ? createdSession : undefined,
      createSession: vi.fn(async () => ({ sessionId: createdSession.id })),
      sendMessage: vi.fn(async () => { throw new Error('provider rejected first prompt') }),
      optimisticUser: () => {}, rejectOptimisticUser: () => {}, optimisticDocument: () => {}, rejectOptimisticDocument: () => {},
      selectSession: id => { if (id) lifecycleRef.current?.update({ sheetId: 'sheet-a', sessionId: id, preview: true, reducedMotion: true }) },
    }) as typeof services.commands
    const lifecycle = mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: null, preview: true, reducedMotion: true },
      services,
    })
    lifecycleRef.current = lifecycle
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '保留并重试这条消息' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    await waitFor(() => {
      expect(host.querySelector('.input-error')).toHaveTextContent('provider rejected first prompt')
      expect(services.sessionUi.get('created-session', 'draft', '')).toBe('保留并重试这条消息')
      expect(prompt).toHaveValue('保留并重试这条消息')
      expect(prompt).toHaveFocus()
    })
  })

  it('宿主传入 bindingHint 时渲染绑定状态浮层（中性态无 --error）', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    // CC-30：bindingHint 经 normalizeWorkbenchMountInput 透传——元素出现即证明字段没被静默丢弃。
    mountSolidWorkbench({
      host,
      input: {
        sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, reducedMotion: true,
        bindingHint: { text: '正在恢复会话绑定…等待 Agent peri 连接', error: false },
      },
      services,
    })

    const hint = await waitFor(() => {
      const element = host.querySelector<HTMLElement>('.input-binding-status')
      expect(element).not.toBeNull()
      return element!
    })
    expect(hint).toHaveTextContent('正在恢复会话绑定…等待 Agent peri 连接')
    expect(hint).toHaveAttribute('role', 'status')
    expect(hint.className).toBe('input-binding-status')
  })

  it('restore_error 提示带 --error 变体', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    mountSolidWorkbench({
      host,
      input: {
        sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, reducedMotion: true,
        bindingHint: { text: '会话绑定恢复失败：激活会话在 identity 中不存在，无法恢复绑定', error: true },
      },
      services,
    })

    const hint = await waitFor(() => {
      const element = host.querySelector<HTMLElement>('.input-binding-status--error')
      expect(element).not.toBeNull()
      return element!
    })
    expect(hint).toHaveTextContent('会话绑定恢复失败')
    expect(hint.className).toBe('input-binding-status input-binding-status--error')
  })

  it('宿主不提供 bindingHint 时不渲染绑定状态浮层（legacy 夹具零影响）', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, reducedMotion: true },
      services,
    })

    await waitFor(() => expect(host.querySelector('.input-textarea')).toBeInTheDocument())
    expect(host.querySelector('.input-binding-status')).toBeNull()
  })

  it('空态品牌使用聊天 viewport 几何容器且不改写现有 Pylon 向量路径', async () => {
    const { host, lifecycle } = mountPreview()
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true, rightInset: 96 })
    const viewport = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('.solid-workbench-empty-chat-viewport')
      expect(value).not.toBeNull()
      return value!
    })
    const brand = host.querySelector<HTMLElement>('.solid-workbench-empty-brand')!
    const mark = brand.querySelector<SVGSVGElement>('.pylon-mark')!
    expect(viewport.closest('[data-chat-viewport="empty"]')).toBeInTheDocument()
    expect(brand).toHaveClass('agent-empty-state')
    expect(mark).toHaveAttribute('viewBox', '0 0 64 64')
    expect(mark.querySelector('.pylon-mark-frame')).toHaveAttribute('d', 'M32 7 53 19v26L32 57 11 45V19Z')
    expect(mark.querySelector('.pylon-mark-links')).toHaveAttribute('d', 'm30 24.679-8 13.857m20 0-8-13.857M24 42h16')
  })

  it('创建后不把模型/模式协商选项渲染成会话区配置卡，且弹层不会残留', async () => {
    const { host, services, lifecycle } = mountPreview()
    // 04b：本用例的意图与空态无关（弹层不残留 + 不出配置卡），改为有会话夹具，
    // 因为空态下模型控件已随「空态只留输入栏」隐藏。
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'preview-session', preview: true })
    const modelTrigger = await screen.findByRole('button', { name: /deepseek-v4-flash/ })
    fireEvent.click(modelTrigger)
    expect(screen.getByRole('listbox', { name: '模型列表' })).toBeInTheDocument()

    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'created-session', preview: true })
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      eventId: 'session-response-test', sessionId: 'created-session', sequence: 1,
      recordedAt: '2026-09-01T00:00:00.000Z', source: { provider: 'acp', sourceId: 'response' },
      identity: { runId: 'response' }, provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'session.started', status: 'ready', model: 'deepseek-v4-flash', mode: 'auto', options: [
        { id: 'model', label: '模型', valueType: 'select', value: 'deepseek-v4-flash', editable: true, schema: { options: [{ id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }] } },
        { id: 'mode', label: '模式', valueType: 'select', value: 'auto', editable: true, schema: { options: [{ id: 'auto', label: '全自动' }] } },
      ] },
    })]).document, { ownerKey: 'owner-preview', generation: 1, sessionId: 'created-session' })

    await waitFor(() => expect(host.querySelector('.solid-workbench-chat-shell')).not.toBeNull())
    expect(screen.queryByRole('listbox', { name: '模型列表' })).toBeNull()
    expect(host.querySelector('.solid-workbench-config')).toBeNull()
  })

  // #358：复活会话的时间线里只有回放出来的 `session.config-updated`（journal 不会存建会话那条
  // `session.started`）。load 响应被投影成协商事实后，守卫必须认账——model / mode 不再落到
  // 会话下方那份配置卡（这正是用户报的「怎么也消不掉」）。
  it('#358：复活文档补上 load 响应的协商事实后，会话配置卡消失', async () => {
    const { host, services, lifecycle } = mountPreview()
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'revived-session', preview: true })
    const catalogue = [
      { id: 'model', label: 'model', valueType: 'select', value: 'fable', editable: true, schema: { options: [{ id: 'fable', label: 'fable' }] } },
      { id: 'mode', label: 'mode', valueType: 'select', value: 'default', editable: true, schema: { options: [{ id: 'default', label: 'default' }] } },
    ]
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event']): WorkbenchEventEnvelope => createWorkbenchEnvelope({
      eventId: `revived-${sequence}`, sessionId: 'revived-session', sequence,
      recordedAt: `2026-09-26T00:00:0${sequence}.000Z`, source: { provider: 'hermes', sourceId: `revived-${sequence}` },
      identity: { runId: `revived-${sequence}` },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const replayed = envelope(1, { type: 'session.config-updated', options: catalogue })
    const replayedDocument = projectWorkbench([replayed]).document
    services.runtime.replaceDocument(replayedDocument, { ownerKey: 'owner-preview', generation: 1, sessionId: 'revived-session' })
    await waitFor(() => expect(host.querySelector('.solid-workbench-config')?.getAttribute('data-config-count')).toBe('2'))

    const negotiation = createSessionResponseEnvelope('revived-session', 'hermes', { sessionId: 'remote-1', configOptions: catalogue }, 2, 'session.started', 'session-load-response')
    services.runtime.replaceDocument(projectWorkbench([replayed, negotiation]).document, { ownerKey: 'owner-preview', generation: 1, sessionId: 'revived-session' })

    await waitFor(() => expect(host.querySelector('.solid-workbench-config')).toBeNull())
  })

  it('空态创建失败后保留草稿，并把焦点交还输入框', async () => {
    const { services, lifecycle } = mountPreview()
    services.commands.setHandler('createSession', vi.fn(async () => { throw new Error('Agent 暂时不可用') }))
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true,
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '保留这份任务描述' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    expect(await screen.findByRole('alert')).toHaveTextContent('Agent 暂时不可用')
    expect(screen.queryByRole('status', { name: '正在创建会话' })).toBeNull()
    expect(prompt).toHaveValue('保留这份任务描述')
    expect(prompt).toBeEnabled()
    // 焦点交还挂在 sendText 失败续体的 queueMicrotask 上，晚于 submitError 落 DOM——
    // findByRole('alert') 解析时它可能尚未执行，必须等它到位再断言。
    await waitFor(() => expect(prompt).toHaveFocus())
  })

  it('pause 冻结 runtime 推送（外观保持实时），resume 一次收敛最新快照', async () => {
    const { host, services, lifecycle } = mountPreview()
    lifecycle.pause()
    streamInto(services, 'm-paused', '暂停期间的新文本', { tokenCount: 99 })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(host.querySelector('[data-paused="true"]')).toBeInTheDocument()
    expect(screen.queryByText('暂停期间的新文本')).toBeNull()

    lifecycle.resume()
    await waitFor(() => expect(screen.getByText('暂停期间的新文本')).toBeInTheDocument())
    expect(host.querySelector('[data-paused="false"]')).toBeInTheDocument()
  })

  it('pause 期间外观变更即时生效（后台 DOM 不滞后）', async () => {
    const { host, services, lifecycle } = mountPreview()
    lifecycle.pause()

    // 正控：编辑左列此刻还没进编辑态 ⇒ 不在场（否则下面会因为"根本没进编辑态"而假绿）
    expect(screen.queryByRole('group', { name: '中控元件' })).toBeNull()

    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    // 暂停中也即时出现 = 外观订阅不吃暂停门（后台 DOM 不滞后到 resume）
    await screen.findByRole('group', { name: '中控元件' })
    expect(host.querySelector('[data-paused="true"]')).toBeInTheDocument()
  })

  it('preview 不暴露真实停止按钮，destroy 幂等并清空 DOM', () => {
    const { host, lifecycle } = mountPreview()
    expect(screen.queryByTitle('停止生成 (Esc / Ctrl+C)')).toBeNull()

    lifecycle.destroy()
    lifecycle.destroy()
    expect(host.childElementCount).toBe(0)
  })

  it('间距来源 = 定义表 gap（思考强度 / 权限的 margin-left；#238 刀3 收编）', async () => {
    const { host } = mountPreview()
    await waitFor(() => expect(host.querySelector('.solid-reasoning-widget')).toBeInTheDocument())
    const gapOf = (id: string) => resolveCcWidgetGroup(id)?.gap ?? 0
    // 值本身非 0（否则断言空洞）：表里思考强度 / 权限各 12px
    expect(gapOf('reasoning')).toBe(12)
    expect(gapOf('mode')).toBe(12)
    // 控件读的**就是**表里的值（改成 0 这条会红）
    expect(getComputedStyle(host.querySelector('.solid-reasoning-widget')!).marginLeft).toBe(`${gapOf('reasoning')}px`)
    expect(getComputedStyle(host.querySelector('.solid-permission-widget')!).marginLeft).toBe(`${gapOf('mode')}px`)
  })

  it('生产中控消费提交模式、隐藏项与排布权威（落脚处内按序号排）', async () => {
    const { host, services, lifecycle } = mountPreview()
    const theme = structuredClone(DEFAULTS)
    theme.inputSubmitButtonMode = 'inline'
    services.appearance.setTheme(theme)

    await waitFor(() => expect(host.querySelector('.input-textarea')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
    expect(host.querySelector('.cc-send-icon, .cc-send-square, .cc-send-minimal')).toBeNull()
    expect(host.querySelector('.input-btn.send, .input-btn.stop')).toBeNull()

    theme.inputSubmitButtonMode = 'external'
    // ★ #238 刀3（写法同步）：槽位层退场 ⇒「把元件放到哪个槽」不再是用户可改的东西
    //（位置由定义表 `layout` 声明）。保留原用例的**权威**含义：序号仍由 placements 决定，
    // 且渲染按序号排序 —— 把 model 的序号设成 9，它就该排到信息组最后。
    theme.ccLayout.placements.model = { order: 9, offsetX: 0, offsetY: 0 }
    services.appearance.setTheme(theme)

    await waitFor(() => expect(host.querySelector('.input-textarea')).toBeInTheDocument())
    // 刀4：legacy `send` 已从名单删除（0 残留守卫）
    expect(host.querySelector('[data-widget-id="send"]')).toBeNull()
    // 2026-09-14：模型控件常态显示；序号 9 ⇒ 排在信息组最后
    const groupIds = [...host.querySelectorAll('.cc-status-group [data-widget-id]')]
      .map(el => el.getAttribute('data-widget-id'))
    expect(groupIds[groupIds.length - 1]).toBe('model')
    expect(groupIds).toContain('reasoning')
    // 输入栏落在**另一个**落脚处容器里（不再与信息控件同容器）
    expect(host.querySelector('.cc-input-slot [data-widget-id="input"]')).toBeInTheDocument()
    expect(host.querySelector('.cc-status-group [data-widget-id="input"]')).toBeNull()

    lifecycle.update({
      sheetId: 'sheet-a', sessionId: 'preview-session', preview: true,
      presentationProfileId: 'builtin.presentation.terminal-classic',
    })
    await waitFor(() => expect(host.querySelector('[data-widget-id="session"]')).toBeNull())
    expect(host.querySelector('[data-widget-id="workspace"]')).toBeNull()
    expect(host.querySelector('[data-widget-id="activity"]')).toBeNull()
  })

  it('外置按钮模式下隐藏发送不会误吞掉输入栏按钮', async () => {
    const { host, services } = mountPreview()
    const theme = structuredClone(DEFAULTS)
    theme.inputSubmitButtonMode = 'external'
    theme.ccHidden = ['cc-send-button']
    services.appearance.setTheme(theme)

    await waitFor(() => expect(host.querySelector('.input-textarea')).toBeInTheDocument())
    // 刀4：隐藏项记在注册轨 id 上；legacy `send` 已不存在（0 残留守卫）
    expect(host.querySelector('[data-widget-id="send"]')).toBeNull()
    expect(host.querySelector('.cc-send-icon, .cc-send-square, .cc-send-minimal')).toBeNull()
    expect(host.querySelector('.input-btn.send, .input-btn.stop')).toBeNull()

    services.appearance.setTheme(theme)
    await waitFor(() => expect(host.querySelector('.input-textarea')).toBeInTheDocument())
    expect(host.querySelector('.input-btn.send, .input-btn.stop')).toBeNull()
  })


/**
 * #238 刀4：jsdom 的 getBoundingClientRect 恒为零 ⇒ 几何规则在单测里"永远不撞"。
 * 这个夹具按 `data-widget-id` 造一份确定布局，并**叠加元素当前的 translate 偏移**
 * （与真实 DOM 一致：偏移由 inline transform 承载），让"占区不叠加"可被判定。
 */
function installFakeLayout(boxes: Record<string, { left: number; top: number; width: number; height: number }>) {
  const original = Element.prototype.getBoundingClientRect
  const calls = { count: 0 }
  Element.prototype.getBoundingClientRect = function (this: Element) {
    calls.count += 1
    const id = this.getAttribute('data-widget-id') ?? ''
    const box = boxes[id]
    const offset = id ? parseTranslateOffset((this as HTMLElement).style.transform) : { offsetX: 0, offsetY: 0 }
    const left = (box ? box.left : 0) + (box ? offset.offsetX : 0)
    const top = (box ? box.top : 0) + (box ? offset.offsetY : 0)
    const width = box ? box.width : 0
    const height = box ? box.height : 0
    return {
      x: left, y: top, width, height, left, top, right: left + width, bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect
  }
  return { calls, restore: () => { Element.prototype.getBoundingClientRect = original } }
}

/** 两个矩形的交集面积（验收用数值证据：挡住的判据是 0） */
function overlapArea(a: DOMRect, b: DOMRect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return Math.max(0, width) * Math.max(0, height)
}


  // ── #238 刀4 占区不叠加（编辑态碰撞约束）─────────────────────────────
  // 真实布局里 model/thinking 之类的邻居相距只有 33px，而微调范围是 ±48/±16
  // ⇒ 撞是常态；下面用固定布局把"挡 / 滑 / 旁路 / 豁免 / 常态"五件事钉住。

  it('#238 刀4 · 拖拽：撞上邻居就停在**上一次被接受的位置**（不是弹回原点），且交集为 0', async () => {
    const fake = installFakeLayout({
      model: { left: 100, top: 200, width: 100, height: 28 },
      reasoning: { left: 233, top: 200, width: 100, height: 28 }, // 与 model 相隔 33px（照真实布局）
    })
    try {
      const { host, services } = mountPreview()
      services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
      const model = await waitFor(() => {
        const value = host.querySelector<HTMLElement>('[data-widget-id="model"]')
        expect(value).not.toBeNull()
        return value!
      })
      fireEvent.pointerDown(model, { clientX: 0, clientY: 0, pointerId: 1 })
      // 先右移 20（120..220 与 233..333 不撞）⇒ 应当被接受
      fireEvent.pointerMove(window, { clientX: 20, clientY: 0, pointerId: 1 })
      await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(20))
      // 再想右移 48（148..248 与 233..333 相交）⇒ 必须被挡
      fireEvent.pointerMove(window, { clientX: 48, clientY: 0, pointerId: 1 })
      fireEvent.pointerUp(window, { pointerId: 1 })
      const placement = services.appearance.getSnapshot().ccLayout.placements.model
      expect(placement.offsetX, '被挡：保持上一次被接受的位置（不是 0）').toBe(20)
      const dragged = host.querySelector<HTMLElement>('[data-widget-id="model"]')!.getBoundingClientRect()
      const neighbour = host.querySelector<HTMLElement>('[data-widget-id="reasoning"]')!.getBoundingClientRect()
      expect(overlapArea(dragged, neighbour), '两者交集面积必须为 0').toBe(0)
    } finally { fake.restore() }
  })

  it('#238 刀4 · 拖拽：推不动就贴着它滑（能水平走，不是整块卡死）', async () => {
    const fake = installFakeLayout({
      model: { left: 100, top: 200, width: 100, height: 28 },
      input: { left: 0, top: 100, width: 900, height: 60 }, // 上方的输入栏：往上顶就会相交
    })
    try {
      const { services } = mountPreview()
      services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
      await waitFor(() => expect(services.appearance.getSnapshot().ccEditMode).toBe(true))
      fireEvent.pointerDown(document.querySelector<HTMLElement>('[data-widget-id="model"]')!, { clientX: 0, clientY: 0, pointerId: 1 })
      // 斜着往右上：全量 (40,-50) 会顶进输入栏 ⇒ 只保留水平分量
      fireEvent.pointerMove(window, { clientX: 40, clientY: -50, pointerId: 1 })
      fireEvent.pointerUp(window, { pointerId: 1 })
      const placement = services.appearance.getSnapshot().ccLayout.placements.model
      expect(placement.offsetX, '水平方向应当滑走').toBe(40)
      expect(placement.offsetY, '垂直分量被输入栏挡住').toBe(0)
    } finally { fake.restore() }
  })

  it('#238 刀4 ★ 面板旁路：在属性面板里把「水平微调」输成会重叠的值 ⇒ 同样被挡', async () => {
    const fake = installFakeLayout({
      model: { left: 100, top: 200, width: 100, height: 28 },
      reasoning: { left: 233, top: 200, width: 100, height: 28 },
    })
    try {
      const { services } = mountPreview()
      services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
      fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
      // 会撞的值：挡在 0（保持原值）
      fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '48' } })
      await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(0))
      // 不撞的值仍然进得去（证明不是"面板整个失灵"）
      fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '20' } })
      await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(20))
    } finally { fake.restore() }
  })

  it('#238 刀4 · 占区相交的非悬浮件被挡（与悬浮豁免互为对照）', async () => {
    // 说明：**预览环境里发送按钮不渲染**（cc 元件注册表为空 ⇒ `ccSendButtonRegistered()` 为假），
    // 所以"悬浮件放行"这一半没法在这里端到端测 —— 它由 `shouldBypassCollisionConstraint` 的
    // 纯函数单测（`ccPlacementCollision.test.ts`）与实机数值证据承担。
    // 这里钉住对照面：同一布局下，非悬浮件（model 与输入栏相交）的微调会被挡住。
    const fake = installFakeLayout({
      input: { left: 0, top: 100, width: 900, height: 60 },
      model: { left: 0, top: 150, width: 100, height: 28 },
    })
    try {
      const { services } = mountPreview()
      services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
      fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
      fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '48' } })
      await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(0))
    } finally { fake.restore() }
  })

  it('#238 刀4 · 常态零影响：非编辑态一次几何都不测', async () => {
    const fake = installFakeLayout({
      model: { left: 100, top: 200, width: 100, height: 28 },
      reasoning: { left: 233, top: 200, width: 100, height: 28 },
    })
    try {
      const { host, services } = mountPreview()
      await waitFor(() => expect(host.querySelector('[data-widget-id="model"]')).not.toBeNull())
      const before = fake.calls.count
      // 常态下点一下元件本体：既不应进入拖拽，也不应触发任何测量
      fireEvent.pointerDown(host.querySelector<HTMLElement>('[data-widget-id="model"]')!, { clientX: 0, clientY: 0, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 40, clientY: 40, pointerId: 1 })
      fireEvent.pointerUp(window, { pointerId: 1 })
      expect(fake.calls.count, '非编辑态不得跑几何').toBe(before)
      expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 0, offsetY: 0 })
    } finally { fake.restore() }
  })

  it('中控编辑模式可选择并拖动 widget，布局写回 appearance 权威', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    const model = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-widget-id="model"]')
      expect(value).not.toBeNull()
      return value!
    })
    fireEvent.pointerDown(model, { clientX: 10, clientY: 20, pointerId: 1 })

    expect(screen.getByRole('dialog', { name: '模型 属性' })).toBeInTheDocument()
    fireEvent.pointerMove(window, { clientX: 34, clientY: 12, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })

    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 24, offsetY: -8 }))
  })

  it('控件拖拽只响应发起拖拽的 pointer', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const model = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-widget-id="model"]')
      expect(value).not.toBeNull()
      return value!
    })

    fireEvent.pointerDown(model, { clientX: 10, clientY: 20, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40, pointerId: 2 })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 0, offsetY: 0 })

    fireEvent.pointerMove(window, { clientX: 34, clientY: 12, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 24, offsetY: -8 })
  })

  it('中控编辑左列可隐藏、恢复、重置并退出', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(await screen.findByRole('group', { name: '中控元件' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '隐藏 模型' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccHidden).toContain('model'))
    // ★ 刀1：编辑态下被藏件**不在场**（旧行为是「在场 + 淡显」）
    expect(host.querySelector('[data-widget-id="model"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '显示 模型' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccHidden).not.toContain('model'))
    await waitFor(() => expect(host.querySelector('[data-widget-id="model"]')).not.toBeNull())

    services.appearance.dispatch({ type: 'update-cc-placement', id: 'model', placement: { offsetX: 20 } })
    fireEvent.click(screen.getByRole('button', { name: '重置控件位置' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(0))

    fireEvent.click(screen.getByRole('button', { name: '退出中控编辑' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccEditMode).toBe(false))
    expect(screen.queryByRole('group', { name: '中控元件' })).toBeNull()
  })

  it('属性面板可编辑顺序、偏移和 schema 外观字段', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))

    // ★ #238 刀3：槽位下拉整块删除（位置改由定义表声明，不再让用户选"放哪个槽"）
    expect(screen.queryByLabelText('控件槽位')).toBeNull()
    // ★ #238 刀7：面板里的「缩放」输入框整块删除（用户口径「我预期里没有缩放这一项」）
    expect(screen.queryByLabelText('控件缩放')).toBeNull()
    fireEvent.input(screen.getByLabelText('控件顺序'), { target: { value: '7' } })
    fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: '点击轮换' }))

    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ order: 7, offsetX: 12 }))
    expect(services.appearance.getSnapshot().modelSwitchMode).toBe('cycle')
    expect(host.querySelector('[data-widget-id="model"] .cc-model-trigger')).toBeInTheDocument()
  })

  it('属性面板数字输入清空时保留上次有效值', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'update-cc-placement', id: 'model', placement: { order: 7, offsetX: 12 } })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))

    fireEvent.input(screen.getByLabelText('控件顺序'), { target: { value: '' } })
    fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '' } })

    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ order: 7, offsetX: 12 })
  })

  it('#266 · 输入栏属性面板：字段恒定（形态固定后不再有"按输入模式判明/切换"的项）', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '输入栏 属性' }))
    // ★ 刀5：属性项改为**行内展开区**（`.cc-edit-row-props`），选择器随结构换；断言口径不变。
    const panel = () => document.querySelector<HTMLElement>('.cc-edit-row-props')!
    // 输入栏自己的可编辑项（展开区顶部那三个「布局」项不算在内）
    const editableLabels = () => [...panel().querySelectorAll('.cc-prop-field')]
      .map(el => el.querySelector('label')?.textContent ?? '')
      .filter(label => !['顺序', '水平微调', '垂直微调'].includes(label))
    const chipTexts = () => [...panel().querySelectorAll('button')].map(button => button.textContent ?? '')
    // ★ #266 刀7/刀9/刀13：原 8 项里的「模式」（chips，写 inputMode↔inputVariant 双写）、
    //   「最小高度」（inputMinHeight）、「内边距」（cliLinePadding）三项随字段删除
    //   ⇒ 只剩 5 项；形态固定命令行 ⇒ 面板里**没有**「模式 / 标准输入 / 命令行」这组切换。
    const FIVE = ['背景色', '文字色', '字号', '边框宽度', '边框颜色']
    expect(editableLabels()).toEqual(FIVE)
    expect(chipTexts()).not.toContain('模式')
    expect(chipTexts()).not.toContain('标准输入')
    expect(chipTexts()).not.toContain('命令行')

    // 面板字段本身照旧响应式（原用例的靶子保留）
    const lineColor = screen.getByLabelText('边框颜色')
    fireEvent.change(lineColor, { target: { value: '#123456' } })
    await waitFor(() => expect(services.appearance.getSnapshot().ccProperties.cliLineColor).toBe('#123456'))
  })

  it('生产 HostPort 挂载路径可将属性面板修改写回 appearance 权威', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services,
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-preview', sessionId: 'preview-session',
      capabilities: { appearanceEdit: true },
    })
    const lifecycle = mountSolidWorkbenchFromHostPort({
      host,
      input: {
        sheetId: 'sheet-a', sessionOwnerKey: 'owner-preview', sessionId: 'preview-session', sessionSource: null,
        replayReadonly: false, reducedMotion: true,
        visibility: 'active', rightInset: 0, preview: true,
      },
      hostPort,
    })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
    fireEvent.click(screen.getByRole('button', { name: '点击轮换' }))

    await waitFor(() => expect(services.appearance.getSnapshot().modelSwitchMode).toBe('cycle'))
    lifecycle.destroy()
  })

  it('编辑器可拖动整体高度，destroy 会清理窗口级拖拽监听', async () => {
    const { services, lifecycle } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const initial = services.appearance.getSnapshot().ccHeight
    const handle = await screen.findByRole('separator', { name: '调整中控高度' })

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(window, { clientY: 80, pointerId: 2 })
    await waitFor(() => expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20))

    lifecycle.destroy()
    fireEvent.pointerMove(window, { clientY: 40, pointerId: 2 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20)
  })

  it('高度拖拽只响应发起拖拽的 pointer', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const initial = services.appearance.getSnapshot().ccHeight
    const handle = await screen.findByRole('separator', { name: '调整中控高度' })

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientY: 40, pointerId: 2 })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial)

    fireEvent.pointerMove(window, { clientY: 80, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20)
  })

  it('Escape 先关闭属性面板，再退出中控编辑模式', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
    expect(screen.getByRole('dialog', { name: '模型 属性' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '模型 属性' })).toBeNull()
    expect(services.appearance.getSnapshot().ccEditMode).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(services.appearance.getSnapshot().ccEditMode).toBe(false))
  })

  it('exposes ready lifecycle event and removes listeners on destroy', () => {
    const { lifecycle } = mountPreview()
    const ready = vi.fn()
    const unsubscribe = lifecycle.on('ready', ready)
    expect(ready).toHaveBeenCalledWith({ suiteId: 'builtin.solid' })
    unsubscribe()
    lifecycle.destroy()
  })

  it('Solid component render fatal is emitted through renderer lifecycle for Host fallback', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const snapshot = services.runtime.getSnapshot()
    services.runtime.getSnapshot = () => new Proxy(snapshot, {
      get(target, property, receiver) {
        if (property === 'document') throw new Error('solid component exploded')
        return Reflect.get(target, property, receiver)
      },
    })

    const lifecycle = mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services,
    })
    const error = vi.fn()
    lifecycle.on('error', error)

    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'solid component exploded' })))
  })

  it('Suite Host catches an initial Solid component fatal even when lifecycle subscription follows mount', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const healthy = services.runtime.getSnapshot()
    services.runtime.getSnapshot = () => new Proxy(healthy, {
      get(target, property, receiver) {
        if (property === 'document') throw new Error('initial solid component exploded')
        return Reflect.get(target, property, receiver)
      },
    })
    const diagnostics: unknown[] = []
    const base = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
    })
    const hostPort = {
      ...base,
      document: {
        getSnapshot: () => healthy.document,
        subscribe: () => () => {},
        getSlice: <T,>() => undefined as T,
        subscribeSlice: () => () => {},
      },
      diagnostics: { report: (value: unknown) => diagnostics.push(value), getRecent: () => [], subscribe: () => () => {} },
    }
    const suite: RendererSuiteContribution = {
      id: 'builtin.solid', label: 'Builtin Solid', apiVersion: 1,
      runtime: { framework: 'solid', version: '1' },
      compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
      requiredKinds: ['content.unknown'],
      factory: {
        async prepare() {
          return { mount(container, input) { return mountSolidWorkbench({ host: container, input, services }) } }
        },
      },
    }
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(), slots: new Map(), diagnostics: [],
    }
    const suiteHost = new RendererSuiteHost({
      container: host, hostPort: hostPort as never,
      input: {
        sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 'preview-session', sessionSource: null,
        replayReadonly: false, reducedMotion: false, visibility: 'active', rightInset: 0, preview: false,
      },
    })

    await suiteHost.mount(activation)

    expect(suiteHost.getState().phase).toBe('degraded')
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'renderer.suite.switch.failed', phase: 'mount', recoverability: 'retry',
      message: 'initial solid component exploded',
    }))
    await suiteHost.destroy()
  })

  it('通过 Suite Host 注入的 HostPort 由宿主管理，renderer destroy 不销毁共享 diagnostics', () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
    })
    const destroyDiagnostics = vi.spyOn(hostPort.diagnostics, 'destroy')
    const lifecycle = mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, hostPort,
    })

    lifecycle.destroy()

    expect(destroyDiagnostics).not.toHaveBeenCalled()
  })

  it('document apply 驱动消息、活动与 diagnostics，并暂不展示 ChatView usage surface', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event']): WorkbenchEventEnvelope => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-21T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `solid-${sequence}` }, provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const workbenchDocument = projectWorkbench([
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'canonical answer' }] }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'Read', status: 'running' } }),
      envelope(3, { type: 'usage.updated', usage: { inputTokens: 8 } }),
      envelope(4, { type: 'diagnostic.notice', level: 'warning', code: 'demo.warning', message: 'canonical warning' }),
      envelope(5, { type: 'budget.warning', used: 90, limit: 100, remaining: 10, exhausted: false }),
      envelope(6, { type: 'session.config-updated', options: [{ id: 'model', label: 'Model', value: 'gpt-5', version: 1 }] }),
      envelope(7, { type: 'session.commands-updated', commands: [{ id: 'review', name: '/review', description: '审查改动' }] }),
      envelope(8, { type: 'assist.prediction', placeholder: '继续审计', actions: [] }),
      envelope(9, { type: 'assist.file-suggestions', files: ['src/a.ts'] }),
    ]).document
    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(screen.getByText('canonical answer')).toBeInTheDocument())
    expect(host.querySelector('[data-activity-count="1"]')).toBeInTheDocument()
    expect(host.querySelector('[data-has-usage="true"]')).toBeNull()
    expect(screen.queryByLabelText('会话用量')).toBeNull()
    expect(screen.queryByLabelText('会话预算')).toBeNull()
    expect(screen.getByLabelText('编辑 Model')).toHaveValue('gpt-5')
    expect(screen.getByLabelText('会话命令')).toHaveTextContent('/review')
    expect(screen.queryByLabelText('输入预测')).toBeNull()
    expect(screen.getByLabelText('文件建议')).toHaveTextContent('src/a.ts')
    expect(host.textContent).not.toContain('↓ 8 tokens')
    // S11：用量控件常态显示为按钮型胶囊，但旧的 usage surface（会话用量标签 / ↓ N tokens）仍未回归；
    // 且它是只读显示 —— 不得渲染成可点击控件。
    expect(host.querySelector('[data-widget-id="tokens"] .cc-usage-pill')).toBeInTheDocument()
    expect(host.querySelector('[data-widget-id="tokens"] button')).toBeNull()
    // ★ #238 刀7：「缩放」已删 ⇒ 用量字号**直接等于基准字号**，不再有乘数。
    //   这里断言内联字号逐字等于快照里的 `modelFontSize` —— 一旦有人把乘数加回来
    //   （如 `calc(12px * 90 / 100)`），字符串不再是纯 `${n}px`，本条即红。
    const usagePill = host.querySelector<HTMLElement>('[data-widget-id="tokens"] .cc-usage-pill')
    expect(usagePill?.style.fontSize).toBe(`${services.appearance.getSnapshot().modelFontSize}px`)
    expect(usagePill?.style.fontSize).not.toContain('calc(')
    expect(screen.getByText('canonical warning')).toBeInTheDocument()
  })

  // #394（2026-10-05 修订）：预测仅在输入框呈现，排队命令仍独立显示。
  it('#394：预测卡不再挂载，空文本与已消费实例同判，排队命令保留', async () => {
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event']): WorkbenchEventEnvelope => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-21T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `solid-${sequence}` }, provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })

    // ① 空文本帧：事实在文档里（下面先断言它在），但不该渲卡。
    const textless = mountPreview()
    const textlessProjection = projectWorkbench([
      envelope(1, { type: 'assist.prediction', placeholder: '', actions: [{ kind: 'set_title', title: '与 Riccati 打招呼' }] }),
    ]).document
    textless.services.runtime.replaceDocument(textlessProjection, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(textless.services.runtime.getSnapshot().document?.assist.prediction).toBeDefined())
    expect(textless.host.querySelector('[data-content-kind="assist.prediction"]')).toBeNull()

    // ② 有文本的预测仅在输入框呈现；消费后也不挂载聊天卡。
    const consumed = mountPreview()
    const projected = projectWorkbench([
      envelope(1, { type: 'assist.prediction', placeholder: '继续审计', actions: [] }),
    ]).document
    const eventId = projected.assist.prediction?.eventId
    expect(eventId).toBeTruthy()
    consumed.services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(consumed.host.querySelector('.input-ghost-suggestion')).toHaveTextContent('继续审计'))
    expect(consumed.host.querySelector('[data-content-kind="assist.prediction"]')).toBeNull()
    expect(consumed.host.querySelector('[aria-label="接受输入建议"]')).toBeNull()
    expect(consumed.host.querySelector('[aria-label="忽略输入建议"]')).toBeNull()

    consumed.services.sessionUi.set('preview-session', 'assist-prediction-consumed', eventId!)
    await waitFor(() => expect(consumed.host.querySelector('[data-content-kind="assist.prediction"]')).toBeNull())

    // ③ `queuedCommand` 是另一件事实：没有预测时卡片仍要为它出现（门控不得把它一并吞掉）。
    const queued = mountPreview()
    queued.services.runtime.replaceDocument(projectWorkbench([
      envelope(1, { type: 'assist.queued-command', command: '/compact' }),
    ]).document, { ownerKey: 'owner-preview', generation: 1 })
    expect(await screen.findByLabelText('排队命令')).toHaveTextContent('排队命令：/compact')
  })

  it('#394：灰字 Tab 接受、Esc 忽略继续消费原生预测，混合排队命令不带预测按钮', async () => {
    // 预览模式故意禁用输入；验证键位须使用正常工作台模式。
    const { host, services } = mountPreview(undefined, { preview: false })
    const prediction = (sequence: number) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: '2026-10-05T12:00:00.000Z',
      source: { provider: 'peri', sourceId: `prediction-${sequence}` },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'assist.prediction', placeholder: '继续审计', actions: [] },
    })
    const projected = projectWorkbench([prediction(1)]).document
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(host.querySelector('.input-ghost-suggestion')).toHaveTextContent('继续审计'))
    expect(host.querySelector('[aria-label="输入预测"]')).toBeNull()
    expect(host.querySelector('[aria-label="接受输入建议"]')).toBeNull()
    expect(host.querySelector('[aria-label="忽略输入建议"]')).toBeNull()
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="消息输入"]')!
    fireEvent.keyDown(textarea, { key: 'Tab' })
    await waitFor(() => expect(textarea).toHaveValue('继续审计'))
    expect(services.sessionUi.get('preview-session', 'assist-prediction-consumed', '')).toBe(projected.assist.prediction?.eventId)
    await waitFor(() => expect(host.querySelector('.input-ghost-suggestion')).toBeNull())

    fireEvent.input(textarea, { target: { value: '' } })
    const next = projectWorkbench([prediction(2)]).document
    services.runtime.replaceDocument(next, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(host.querySelector('.input-ghost-suggestion')).toHaveTextContent('继续审计'))
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(textarea).toHaveValue('')
    expect(services.sessionUi.get('preview-session', 'assist-prediction-consumed', '')).toBe(next.assist.prediction?.eventId)
    await waitFor(() => expect(host.querySelector('.input-ghost-suggestion')).toBeNull())

    services.runtime.replaceDocument(projectWorkbench([
      prediction(3), createWorkbenchEnvelope({
        sessionId: 'preview-session', sequence: 4, recordedAt: '2026-10-05T12:00:00.000Z',
        source: { provider: 'peri', sourceId: 'queue-4' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'assist.queued-command', command: '/compact' },
      }),
    ]).document, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(host.querySelector('[aria-label="排队命令"]')).toHaveTextContent('/compact'))
    const card = host.querySelector('[aria-label="排队命令"]')!
    expect(card).not.toHaveTextContent('继续审计')
    expect(card.querySelector('button')).toBeNull()
  })

  it('同一 error 事实只渲染一个可见错误 surface', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1, recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'error-1' }, identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'diagnostic.notice', level: 'error', code: 'transport.timeout', message: '连接超时' },
    })]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1))
    expect(host.querySelector('.system-error-card')).toHaveTextContent('连接超时')
    expect(host.querySelector('.system-notice-card')).toBeNull()
  })

  it('C04 canonical unknown tool uses the typed tool.generic base Slot and updates without remount', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntries = BUILTIN_TOOL_RENDER_KINDS.map(kind => [kind.id, {
      ownerPluginId: 'core.renderer.tool-kinds', ownerRuntimeInstanceId: 'runtime',
      contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
    } as RegistryEntry<(typeof BUILTIN_TOOL_RENDER_KINDS)[number]>] as const)
    const specializedToolKind = {
      ...BUILTIN_TOOL_RENDER_KINDS[0]!, id: 'tool.unregistered', fallbackKind: 'tool.generic',
      fixture: { id: 'fixture-specialized', name: 'SpecializedTool', status: 'running', semanticKind: 'tool.unregistered' },
    }
    const specializedToolEntry = {
      ownerPluginId: 'core.renderer.semantic-kinds', ownerRuntimeInstanceId: 'runtime',
      contributionId: specializedToolKind.id, layer: 'feature', priority: specializedToolKind.priority,
      value: specializedToolKind,
    } as RegistryEntry<typeof specializedToolKind>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: suite.id, layer: 'feature', priority: 1, value: suite,
      } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([...kindEntries, ['tool.unregistered', specializedToolEntry]]),
      slots: new Map(BUILTIN_TOOL_RENDER_KINDS.map(kind => [kind.id, [slotEntry]])),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session' },
      services,
      activation,
    })
    const started = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'tool-start' }, identity: { toolCallId: 'tool-c04' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'tool.started',
        tool: {
          name: 'ProviderRead', canonicalName: 'read_file', title: '读取文件',
          semanticKind: 'tool.unregistered', status: 'running', input: { path: '/normalized.txt' },
        },
      },
    })]).document

    services.runtime.replaceDocument(started, { ownerKey: 'owner-preview', generation: 1 })

    const card = await screen.findByRole('status', { name: '工具：读取文件，运行中' })
    expect(card).toHaveAttribute('data-content-kind', 'tool.generic')
    expect(card).toHaveTextContent('ProviderRead')
    expect(card.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'false')
    expect(card).not.toHaveTextContent('/normalized.txt')
    fireEvent.click(card.querySelector<HTMLButtonElement>('.term-tool-head')!)
    expect(card).toHaveTextContent('/normalized.txt')
    expect(host.querySelector('.solid-workbench-activity')).toBeNull()
    expect(card.closest('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()

    const completed = reduceWorkbenchEvent(started, createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:02.000Z', sequence: 2,
      source: { provider: 'peri', sourceId: 'tool-complete' }, identity: { toolCallId: 'tool-c04' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.completed', tool: { status: 'completed', parts: [{ kind: 'text', text: 'file body' }], durationMs: 1200 } },
    }))
    services.runtime.replaceDocument(completed, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(card).toHaveAccessibleName('工具：读取文件，已完成'))
    expect(screen.getByRole('status', { name: '工具：读取文件，已完成' })).toBe(card)
    expect(card).toHaveTextContent('file body')
    expect(card).toHaveTextContent('1.2s')
    const cardHead = card.querySelector<HTMLButtonElement>('.term-tool-head')!
    fireEvent.click(cardHead)
    expect(cardHead).toHaveAttribute('aria-expanded', 'false')

    const nested = reduceWorkbenchEvent(completed, createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:03.000Z', sequence: 3,
      source: { provider: 'peri', sourceId: 'tool-child' }, identity: { toolCallId: 'tool-c04-child' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'tool.started',
        tool: { name: 'ChildTool', title: '子工具', semanticKind: 'tool.unregistered', parentToolUseId: 'tool-c04' },
      },
    }))
    services.runtime.replaceDocument(nested, { ownerKey: 'owner-preview', generation: 1 })

    const connector = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-from-message-id="tool-c04"][data-to-message-id="tool-c04-child"]')
      expect(value).not.toBeNull()
      return value!
    })
    expect(connector).toHaveClass('term-tool-connector')

    const replacement = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:04.000Z', sequence: 4,
      source: { provider: 'peri', sourceId: 'tool-replacement' }, identity: { toolCallId: 'tool-replacement' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.started', tool: { name: 'Replacement', title: '替换工具', semanticKind: 'tool.unregistered' } },
    })]).document
    services.runtime.replaceDocument(replacement, { ownerKey: 'owner-preview', generation: 2 })

    const replacementCard = await screen.findByRole('status', { name: '工具：替换工具，运行中' })
    expect(replacementCard).not.toBe(card)
    expect(replacementCard.querySelector('.term-tool-head')).toHaveAttribute('aria-controls', 'solid-tool-snapshot-tool-replacement')
    expect(replacementCard.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'false')
    expect(replacementCard.querySelector('#solid-tool-snapshot-tool-replacement')).toBeNull()
    expect(host.querySelector('[data-from-message-id="tool-c04"]')).toBeNull()
  })

  it('canonical media part reaches the committed Solid media renderer in production', async () => {
    const { services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'hermes', sourceId: 'media-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant',
        parts: [{ kind: 'image', source: 'https://cdn.example.com/architecture.png', alt: '架构图' }],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('img', { name: '架构图' })).toHaveAttribute(
      'src', 'https://cdn.example.com/architecture.png',
    )
  })

  it('C06 canonical diff and LSP parts reach their production base Slot kinds', async () => {
    const { host, services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-23T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'c06-content' }, identity: { messageId: 'c06-content' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant', parts: [
          { kind: 'diff', path: '/src/production.ts', lines: [{ kind: 'added', text: 'export const ready = true' }] },
          { kind: 'diagnostic-lsp', severity: 'error', code: 'TS1005', message: 'semicolon expected', path: '/src/production.ts' },
        ],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('region', { name: 'Diff：/src/production.ts' })).toBeInTheDocument()
    expect(await screen.findByRole('alert', { name: 'LSP error：semicolon expected' })).toBeInTheDocument()
    expect(host.querySelector('[data-content-kind="content.diff"] [data-renderer-slot-id="builtin.solid.content.base"]')
      ?? host.querySelector('[data-content-kind="content.diff"]')).not.toBeNull()
    expect(host.querySelector('[data-content-kind="diagnostic.lsp"]')).not.toBeNull()
  })

  it('C07 canonical terminal and log parts remain readable through the production fallback', async () => {
    const { host, services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-23T00:00:02.000Z', sequence: 1,
      source: { provider: 'hermes', sourceId: 'c07-content' }, identity: { messageId: 'c07-content' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant', parts: [
          { kind: 'terminal', command: 'npm test', streams: [{ stream: 'stderr', text: 'failed', ordinal: 0 }], exitCode: 1 },
          { kind: 'log', source: 'runner', entries: [{ level: 'info', text: 'cleanup complete' }] },
        ],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-terminal-card')).toHaveTextContent('failed'))
    expect(host.querySelector('.term-log-card')).toHaveTextContent('cleanup complete')
    expect(host.textContent).not.toContain('Unsupported content kind')
  })

  it('C15 canonical content and negotiated extension events reach production Slots and missing-plugin fallback', async () => {
    const { host, services } = mountPreview()
    const make = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-24T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `c15-${sequence}` }, identity: { messageId: sequence === 1 ? 'c15-message' : undefined },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const document = projectWorkbench([
      make(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'artifact', artifactId: 'artifact-1', title: 'Production report', uri: 'artifact://report', parts: [{ kind: 'text', text: 'preview body' }] }] }),
      make(2, { type: 'extension.event', kind: 'system.hook', payload: { phase: 'turn.completed', owner: { pluginId: 'plugin.audit', handlerId: 'after' }, status: 'continued', durationMs: 11 }, fallback: [] }),
      make(3, { type: 'extension.event', kind: 'plugin.removed/result', payload: { status: 'done' }, fallback: [{ kind: 'unknown', originalType: 'plugin.removed/result', summary: 'renderer unavailable', raw: { status: 'done' }, truncated: false }] }),
    ]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('article', { name: '工件：Production report' })).toHaveTextContent('preview body')
    expect(await screen.findByRole('status', { name: 'Hook：turn.completed' })).toHaveTextContent('11 ms')
    const missingPlugin = await screen.findByRole('note', { name: '扩展事件：plugin.removed/result' })
    expect(missingPlugin).toHaveTextContent('renderer unavailable')
    expect(missingPlugin).toHaveTextContent('peri · c15-3')
    expect(missingPlugin).toHaveTextContent('local-observed · authoritative')
    expect(host.querySelector('[data-extension-kind="plugin.removed/result"]')).not.toBeNull()
  })

  it('同一 semantic WorkbenchDocument 在内置 Solid 与插件 Slot 间保持 parity', async () => {
    const builtinHost = document.createElement('div')
    const pluginHost = document.createElement('div')
    document.body.append(builtinHost, pluginHost)
    hosts.push(builtinHost, pluginHost)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services,
      suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-parity', sessionId: 'parity-session',
    })

    const make = (sequence: number, event: WorkbenchEventEnvelope['event'], identity: WorkbenchEventEnvelope['identity'] = {}) => createWorkbenchEnvelope({
      sessionId: 'parity-session', sequence,
      recordedAt: `2026-09-10T00:00:0${sequence}.000Z`,
      source: { provider: 'acp', sourceId: `renderer-parity-${sequence}` }, identity,
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      // Raw ACP evidence may carry replay hints, but it is not a renderer input.
      raw: { _meta: { periReplay: true }, wireSequence: sequence },
      event,
    })
    const projected = projectWorkbench([
      make(1, { type: 'message.completed', role: 'assistant', parts: [{ kind: 'markdown', text: 'assistant parity' }] }, { messageId: 'parity-message' }),
      make(2, { type: 'tool.started', tool: { toolCallId: 'parity-tool', name: 'Read parity', title: '读取 parity', input: { path: '/parity.txt' } } }, { toolCallId: 'parity-tool' }),
      make(3, { type: 'plan.replaced', entries: [{ id: 'parity-plan', content: 'plan parity', status: 'in_progress' }] }),
      make(4, { type: 'interaction.requested', interactionId: 'parity-interaction', request: {
        surface: 'interaction', kind: 'approval', state: 'waiting',
        identity: { provider: 'acp', agentId: 'agent', requestId: 'parity-request', sessionId: 'parity-session', toolCallId: null, clientGeneration: 1 },
        questions: [{ id: 'approval', question: 'Approve parity?', options: [], allowMultiple: false, allowFreeform: false }],
      } }, { interactionId: 'parity-interaction' }),
      make(5, { type: 'extension.event', kind: 'plugin.parity/card', payload: { label: 'extension parity', status: 'ready' }, fallback: [{ kind: 'text', text: 'extension fallback' }] }),
      make(6, { type: 'session.commands-updated', commands: [{ id: 'compact', name: '/compact', description: 'Compact parity' }] }),
      make(7, { type: 'diagnostic.notice', level: 'warning', code: 'parity.notice', message: 'diagnostic parity' }),
    ]).document
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-parity', generation: 1, sessionId: 'parity-session' })
    const documentSnapshot = hostPort.document.getSnapshot()!
    const renderRevision = services.runtime.getSnapshot().revision

    // The host exposes one immutable document; both renderer instances read it.
    expect(documentSnapshot).toMatchObject({ sessionId: 'parity-session', revision: 7 })
    expect(renderRevision).toBe(hostPort.generation.getSnapshot().revision)
    expect(documentSnapshot.timeline.map(entry => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(documentSnapshot.messages).toHaveLength(1)
    expect(documentSnapshot.activities).toMatchObject([{ id: 'parity-tool', title: 'Read parity', status: 'running' }])
    expect(documentSnapshot.plan.entries).toMatchObject([{ id: 'parity-plan', content: 'plan parity', status: 'in_progress' }])
    expect(documentSnapshot.interactions).toMatchObject([{ id: 'parity-interaction', status: 'requested' }])
    expect(documentSnapshot.extensions).toMatchObject([{ kind: 'plugin.parity/card', payload: { label: 'extension parity' } }])
    expect(documentSnapshot.session.commands).toMatchObject([{ id: 'compact', name: '/compact' }])
    expect(documentSnapshot.diagnostics).toMatchObject([{ code: 'parity.notice', level: 'warning', message: 'diagnostic parity' }])

    // Mount the built-in renderer without an activation override: its fallback
    // surfaces prove the same document remains user-visible without plugins.
    mountSolidWorkbench({
      host: builtinHost,
      input: { sheetId: 'sheet-a', sessionId: 'parity-session', preview: true },
      services, hostPort,
    })

    const captured: RenderNodeSnapshot[] = []
    const slotKinds = [
      'content.markdown', 'tool.generic', 'content.plan', 'interaction.approval',
      'plugin.parity/card', 'session.commands', 'system.notice',
    ] as const
    const paritySlot: RendererSlotContribution = {
      id: 'test.renderer-parity', targetSuites: ['builtin.solid'], kinds: slotKinds,
      priority: 20_000, fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'test.renderer-parity', kind: 'solid',
        mount(container, snapshot) {
          captured.push(snapshot)
          const node = document.createElement('div')
          node.dataset.parityKind = snapshot.kind
          container.append(node)
          return node
        },
        update() {},
        destroy(handle) { (handle as HTMLElement).remove() },
        on: () => () => {},
      }),
    }
    const entry = {
      ownerPluginId: 'test.renderer-parity', ownerRuntimeInstanceId: 'runtime',
      contributionId: paritySlot.id, layer: 'feature', priority: paritySlot.priority, value: paritySlot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: suite.id, layer: 'feature', priority: 1, value: suite,
      } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(),
      slots: new Map(slotKinds.map(kind => [kind, [entry]])),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host: pluginHost,
      input: { sheetId: 'sheet-a', sessionId: 'parity-session', preview: true },
      services, hostPort, activation,
    })

    await waitFor(() => expect(builtinHost).toHaveTextContent('assistant parity'))
    expect(builtinHost).toHaveTextContent('Read parity')
    expect(builtinHost).toHaveTextContent('plan parity')
    expect(builtinHost).toHaveTextContent('Approve parity?')
    expect(builtinHost).toHaveTextContent('/compact')
    expect(builtinHost).toHaveTextContent('diagnostic parity')
    expect(builtinHost).toHaveTextContent('extension fallback')

    await waitFor(() => expect(captured).toHaveLength(slotKinds.length))
    const byKind = new Map(captured.map(snapshot => [snapshot.kind, snapshot]))
    expect([...byKind.keys()]).toEqual(expect.arrayContaining([...slotKinds]))
    expect(byKind.size).toBe(slotKinds.length)
    const message = documentSnapshot.messages[0]!
    const activity = documentSnapshot.activities[0]!
    const interaction = documentSnapshot.interactions[0]!
    const extension = documentSnapshot.extensions[0]!
    const diagnostic = documentSnapshot.diagnostics[0]!
    expect(byKind.get('content.markdown')).toMatchObject({
      nodeId: `${message.id}:part:0`, revision: renderRevision,
      payload: message.parts[0],
    })
    expect(byKind.get('tool.generic')).toMatchObject({
      nodeId: `${documentSnapshot.sessionId}:${activity.id}`, revision: renderRevision,
      payload: expect.objectContaining({ id: activity.id, title: activity.displayName, name: activity.providerName, input: activity.input }),
    })
    expect(byKind.get('content.plan')).toMatchObject({
      nodeId: `${documentSnapshot.sessionId}:plan`, revision: renderRevision,
      payload: { entries: documentSnapshot.plan.entries, goal: documentSnapshot.goal.current },
    })
    expect(byKind.get('interaction.approval')).toMatchObject({
      nodeId: `${documentSnapshot.sessionId}:interaction:${interaction.id}`, revision: renderRevision,
      payload: interaction,
    })
    expect(byKind.get('plugin.parity/card')).toMatchObject({
      nodeId: `${documentSnapshot.sessionId}:extension:${extension.id}`, revision: renderRevision,
      payload: extension.payload,
    })
    expect(byKind.get('session.commands')).toMatchObject({
      nodeId: `${documentSnapshot.sessionId}:session:commands`, revision: renderRevision,
      payload: { commands: documentSnapshot.session.commands },
    })
    expect(byKind.get('system.notice')).toMatchObject({
      nodeId: `${documentSnapshot.sessionId}:notice:${diagnostic.eventId}`, revision: renderRevision,
      payload: diagnostic,
    })
    expect(JSON.stringify(captured)).not.toContain('periReplay')
    expect(JSON.stringify(captured)).not.toContain('wireSequence')
  })

  it('coalesces adjacent streamed text in a missing-plugin extension fallback', async () => {
    const { host, services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-24T00:00:04.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'extension-streamed-fallback' }, identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'extension.event', kind: 'plugin.removed/streamed', payload: { status: 'done' },
        fallback: [{ kind: 'text', text: '连续' }, { kind: 'markdown', text: '降级内容' }],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    const fallback = await screen.findByRole('note', { name: '扩展事件：plugin.removed/streamed' })
    expect(fallback).toHaveTextContent('连续降级内容')
    expect(fallback.querySelectorAll('p')).toHaveLength(1)
    expect(host.querySelectorAll('[data-extension-kind="plugin.removed/streamed"]')).toHaveLength(1)
  })

  it('C10 workflow remains readable through the built-in no-Slot fallback', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-24T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'workflow-fallback' }, identity: { taskId: 'workflow-fallback' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'activity.started', activityId: 'workflow-fallback',
        activity: { kind: 'workflow', title: 'fallback workflow' },
      },
    })]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-workflow-card')).toHaveTextContent('fallback workflow'))
    expect(host.querySelector('.term-subagent-card')).toBeNull()
  })

  it('C07 activity.process renders identity, output, status, and synthetic provenance outside messages', async () => {
    const { host, services } = mountPreview()
    const createActivity = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-23T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `process-${sequence}` }, identity: { taskId: 'process-1' },
      provenance: sequence === 1
        ? { origin: 'local-observed', trust: 'authoritative' }
        : { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed', synthetic: { reason: 'observed exit' } },
      event,
    })
    const workbenchDocument = projectWorkbench([
      createActivity(1, {
        type: 'activity.started', activityId: 'process-1',
        activity: { kind: 'process', title: 'background tests', processId: 'pid-7', sessionId: 'shell-2' },
      }),
      createActivity(2, {
        type: 'activity.completed', activityId: 'process-1',
        result: { parts: [{ kind: 'terminal', streams: [{ stream: 'stdout', text: 'all passed', ordinal: 0 }], exitCode: 0 }] },
      }),
    ]).document

    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-process-activity')).toHaveTextContent('background tests'))
    const process = host.querySelector('.term-process-activity')!
    expect(process).toHaveTextContent('pid-7')
    expect(process).toHaveTextContent('shell-2')
    expect(process).toHaveTextContent('completed')
    expect(process).toHaveTextContent('all passed')
    expect(process).toHaveTextContent('合成生命周期：observed exit')
    expect([...host.querySelectorAll('[data-message-role]')].map(node => node.textContent).join('')).not.toContain('all passed')
  })

  it('C07 terminal/log/process kinds mount through the production base Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const kinds = [
      ...BUILTIN_TEXT_RENDER_KINDS.filter(kind => kind.id === 'content.terminal' || kind.id === 'content.log'),
      ...BUILTIN_EXECUTION_RENDER_KINDS,
    ]
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: 'builtin.solid', layer: 'feature', priority: 1, value: { id: 'builtin.solid' } as RendererSuiteContribution,
      },
      kinds: new Map(kinds.map(kind => [kind.id, {
        ownerPluginId: 'core.renderer.execution', ownerRuntimeInstanceId: 'runtime',
        contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
      }])),
      slots: new Map(kinds.map(kind => [kind.id, [slotEntry]])),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation,
    })
    const make = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: `2026-08-23T00:01:0${sequence}.000Z`,
      source: { provider: 'hermes', sourceId: `c07-slot-${sequence}` },
      identity: event.type.startsWith('message.') ? { messageId: 'message-slot' } : { taskId: 'process-slot' },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const workbenchDocument = projectWorkbench([
      make(1, { type: 'message.delta', role: 'assistant', parts: [
        { kind: 'terminal', streams: [{ stream: 'stdout', text: 'slot terminal' }] },
        { kind: 'log', entries: [{ level: 'info', text: 'slot log' }] },
      ] }),
      make(2, { type: 'activity.started', activityId: 'process-slot', activity: {
        kind: 'process', semanticKind: 'activity.process', title: 'slot process', processId: 'pid-slot',
      } }),
    ]).document
    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-terminal-card')).toHaveTextContent('slot terminal'))
    expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-log-card')).toHaveTextContent('slot log')
    expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-process-activity')).toHaveTextContent('slot process')
  })

  it('canonical reasoning terminal metadata reaches the production content Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const kindEntries = BUILTIN_TEXT_RENDER_KINDS
      .filter(kind => kind.id === 'content.reasoning' || kind.id === 'content.redacted-reasoning')
      .map(kind => [kind.id, {
        ownerPluginId: 'core.renderer.text-kinds', ownerRuntimeInstanceId: 'runtime',
        contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
      } as RegistryEntry<(typeof BUILTIN_TEXT_RENDER_KINDS)[number]>] as const)
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: suite.id, layer: 'feature', priority: 1, value: suite,
      } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(kindEntries),
      slots: new Map([
        ['content.reasoning', [slotEntry]],
        ['content.redacted-reasoning', [slotEntry]],
      ]),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session' },
      services,
      activation,
    })
    const envelope = (
      sequence: number,
      event: WorkbenchEventEnvelope['event'],
      messageId: string,
      occurredAt: string,
    ) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: occurredAt, occurredAt,
      source: { provider: 'claude', sourceId: `reasoning-${sequence}` },
      identity: { messageId },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const projected = projectWorkbench([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'reasoning', text: 'visible thought' }] }, 'thought-visible', '2026-08-21T00:00:01.000Z'),
      envelope(2, { type: 'reasoning.completed', parts: [] }, 'thought-visible', '2026-08-21T00:00:03.400Z'),
      envelope(3, { type: 'reasoning.redacted', parts: [{ kind: 'redacted-reasoning', reason: 'provider_policy' }], reason: 'provider_policy' }, 'thought-redacted', '2026-08-21T00:00:04.000Z'),
    ]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('button', { name: /Thought for 2\.4s/ })).toBeInTheDocument()
    expect(await screen.findByText('provider_policy')).toBeInTheDocument()
    expect(host.querySelector('[data-content-kind="content.reasoning"]')).not.toBeNull()
    expect(host.querySelector('[data-content-kind="content.redacted-reasoning"]')).not.toBeNull()
  })

  it('keeps C02 documents visible through the built-in no-Slot fallback', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-22T00:00:01.000Z', occurredAt: '2026-08-22T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'document-fallback' }, identity: { messageId: 'document-fallback' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant',
        parts: [{ kind: 'document', title: 'fallback-spec.md', text: 'fallback document body', mimeType: 'text/markdown' }],
      },
    })]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('fallback-spec.md')).toBeInTheDocument()
    expect(await screen.findByText('fallback document body')).toBeInTheDocument()
    expect(host.querySelector('[data-part-kind="document"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Unsupported content kind: document')
  })

  it('interaction 只提交 normalized optionId，不自造 provider approval payload', async () => {
    const { services } = mountPreview({ interactionResponse: true })
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'interaction-1' }, identity: { interactionId: 'interaction-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'interaction-1',
        request: {
          surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'request-1', sessionId: 'preview-session', clientGeneration: 3 },
          questions: [{ id: 'approval', question: 'Allow edit?', allowMultiple: false, allowFreeform: false,
            options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'reject_once', label: 'Reject' }] }],
        },
      },
    })]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })
    const allowButton = await screen.findByRole('button', { name: 'Allow once' })
    expect(allowButton.closest('.interaction-card')).not.toBeNull()

    fireEvent.click(allowButton)

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      // A09 补全：按钮随响应携带 expectedRevision（document.sequence）供 transport 层 stale 防护
      command: 'respondInteraction', args: ['preview-session', 'interaction-1', { optionId: 'allow_once' }, { expectedRevision: 1 }],
    }))
  })

  it('interaction command failure keeps the answer editable and reports the rejection', async () => {
    const { services } = mountPreview({ interactionResponse: true })
    services.commands.setHandler('respondInteraction', async () => ({ ok: false, error: 'policy denied' }))
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 2,
      source: { provider: 'peri', sourceId: 'interaction-failure' }, identity: { interactionId: 'interaction-failure' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'interaction-failure',
        request: {
          surface: 'interaction', kind: 'ask-question', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'request-failure', sessionId: 'preview-session', clientGeneration: 3 },
          questions: [{ id: 'reason', question: '为什么继续？', allowMultiple: false, allowFreeform: true, options: [] }],
        },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    const input = await screen.findByPlaceholderText('输入回答后回车') as HTMLInputElement
    fireEvent.input(input, { target: { value: '仍需完成验证' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByRole('alert')).toHaveTextContent('policy denied')
    expect(input).toHaveValue('仍需完成验证')
  })

  it('routes canonical interactions through a Suite-local replaceable Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const kind = BUILTIN_INTERACTION_RENDER_KINDS.find(item => item.id === 'interaction.approval')!
    const slot: RendererSlotContribution = {
      id: 'plugin.interaction.approval', targetSuites: ['builtin.solid'], kinds: [kind.id], priority: 20_000,
      fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'plugin.interaction.approval', kind: 'solid',
        mount(container) {
          const node = document.createElement('div')
          node.textContent = 'Plugin approval surface'
          container.append(node)
          return node
        },
        update() {}, destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntry = { ownerPluginId: 'core.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: kind.id,
      layer: 'feature', priority: kind.priority, value: kind } as RegistryEntry<typeof kind>
    const slotEntry = { ownerPluginId: 'plugin.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id,
      layer: 'feature', priority: slot.priority, value: slot } as RegistryEntry<RendererSlotContribution>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id,
        layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([[kind.id, kindEntry]]), slots: new Map([[kind.id, [slotEntry]]]), diagnostics: [],
    }
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'replaceable-interaction' }, identity: { interactionId: 'replaceable-interaction' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'replaceable-interaction',
        request: { surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'replaceable', sessionId: 'preview-session', clientGeneration: 1 },
          questions: [{ id: 'approval', question: 'Replace me?', allowMultiple: false, allowFreeform: false, options: [] }] },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('Plugin approval surface')).toBeInTheDocument()
    expect(host.querySelector('.interaction-card')).toBeNull()
  })

  it('gives a C12 plugin replacement only the redacted canonical interaction snapshot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const kind = BUILTIN_INTERACTION_RENDER_KINDS.find(item => item.id === 'interaction.secret')!
    let pluginSnapshot = ''
    const slot: RendererSlotContribution = {
      id: 'plugin.interaction.secret', targetSuites: ['builtin.solid'], kinds: [kind.id], priority: 20_000,
      fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'plugin.interaction.secret', kind: 'solid',
        mount(container, snapshot) {
          pluginSnapshot = JSON.stringify(snapshot)
          const node = document.createElement('div')
          node.textContent = 'Plugin secret surface'
          container.append(node)
          return node
        },
        update(_handle, snapshot) { pluginSnapshot = JSON.stringify(snapshot) },
        destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntry = { ownerPluginId: 'core.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: kind.id,
      layer: 'feature', priority: kind.priority, value: kind } as RegistryEntry<typeof kind>
    const slotEntry = { ownerPluginId: 'plugin.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id,
      layer: 'feature', priority: slot.priority, value: slot } as RegistryEntry<RendererSlotContribution>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id,
        layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([[kind.id, kindEntry]]), slots: new Map([[kind.id, [slotEntry]]]), diagnostics: [],
    }
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })
    const credential = 'c12-plugin-secret'
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'replaceable-secret' }, identity: { interactionId: 'replaceable-secret' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'replaceable-secret',
        request: { surface: 'interaction', kind: 'secret', state: 'waiting', value: credential,
          identity: { provider: 'peri', agentId: 'peri', requestId: 'secret-1', sessionId: 'preview-session', toolCallId: null, clientGeneration: 1 },
          questions: [{ id: 'secret', question: 'Credential', allowMultiple: false, allowFreeform: true, options: [] }] },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('Plugin secret surface')).toBeInTheDocument()
    expect(pluginSnapshot).not.toContain(credential)
    expect(pluginSnapshot).toContain('valueRedacted')
  })

  it('Slot semantic action 穿过 Host command capability gate，不被 lifecycle 静默丢弃', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
      capabilities: { clipboardWrite: true },
    })
    const slot: RendererSlotContribution = {
      id: 'test.semantic-action', targetSuites: ['builtin.solid'], kinds: ['message.assistant'],
      priority: 1, fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'test.semantic-action', kind: 'solid',
        mount(container, _snapshot, _appearance, commands) {
          const button = document.createElement('button')
          button.textContent = 'copy through semantic port'
          button.addEventListener('click', () => { void commands.execute({ type: 'clipboard.write', payload: { text: 'semantic copy' } }) })
          container.append(button)
          return button
        },
        update() {}, destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const entry = { ownerPluginId: 'test.semantic-action', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id, layer: 'feature', priority: 1, value: slot } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: 'builtin.solid', layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(), slots: new Map([['message.assistant', [entry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, hostPort, activation,
    })

    // The preview fixture carries multiple assistant rows, so the custom Slot
    // mounts one button per row; any of them routes through the same port.
    const semanticButtons = await screen.findAllByRole('button', { name: 'copy through semantic port' })
    fireEvent.click(semanticButtons[0]!)

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'copy', args: ['preview-session', 'semantic copy'],
    }))
  })

  it('展开的聚合工具组成员 Slot 在流式修订间保持挂载身份（不重挂载风暴）', async () => {
    let mounts = 0
    let updates = 0
    const slot: RendererSlotContribution = {
      id: 'test.group-member-identity', targetSuites: ['builtin.solid'], kinds: ['tool.generic'],
      priority: 1, fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'test.group-member-identity', kind: 'solid',
        mount(container) {
          mounts += 1
          const node = document.createElement('div')
          node.className = 'group-member-probe'
          container.append(node)
          return node
        },
        update() { updates += 1 },
        destroy(handle) { (handle as HTMLElement).remove() },
        on: () => () => {},
      }),
    }
    const entry = { ownerPluginId: 'test.group-member-identity', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id, layer: 'feature' as const, priority: 1, value: slot } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: 'builtin.solid', layer: 'feature' as const, priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(), slots: new Map([['tool.generic', [entry]]]), diagnostics: [],
    } as RendererActivationSnapshot

    const toolEnvelope = (sequence: number, toolCallId: string, status: string) => createWorkbenchEnvelope({
      eventId: `group-tool-${toolCallId}-${sequence}`,
      sessionId: 'preview-session',
      sequence,
      recordedAt: '2026-09-05T00:00:00.000Z',
      source: { provider: 'acp', sourceId: `group-tool-${toolCallId}-${sequence}` },
      identity: { toolCallId },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.started', tool: { toolCallId, name: 'Read', status } },
    })
    const buildDocument = () => projectWorkbench([
      toolEnvelope(1, 'group-tool-1', 'running'),
      toolEnvelope(2, 'group-tool-2', 'running'),
    ]).document

    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
    })
    services.runtime.replaceDocument(buildDocument(), { ownerKey: 'owner-a', generation: 1, sessionId: 'preview-session' })
    mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, hostPort, activation,
    })

    const groupHead = await screen.findByRole('button', { name: /2 次调用/ })
    fireEvent.click(groupHead)
    await waitFor(() => expect(host.querySelectorAll('.group-member-probe')).toHaveLength(2))
    expect(mounts).toBe(2)

    // 模拟流式 tick：document 每次携带全新 activity 引用（同 id、状态演进）。
    for (let tick = 0; tick < 3; tick += 1) {
      services.runtime.applyDocument(buildDocument(), { ownerKey: 'owner-a', generation: 1, preserveGeneration: true })
    }
    await waitFor(() => expect(updates).toBeGreaterThan(0))
    // P91 C2：50ms 真实等待 → 更新计数连续两拍稳定（等效静止窗口，不依赖墙钟）。
    let lastSeen = -1
    await vi.waitFor(() => {
      const current = updates
      if (lastSeen >= 0) expect(current).toBe(lastSeen)
      lastSeen = current
    }, FLUSH_BUDGET)
    expect(mounts).toBe(2)
    expect(host.querySelectorAll('.group-member-probe')).toHaveLength(2)
  })
})
