// @vitest-environment jsdom
/**
 * #266 CC-13 刀2：**隔离面（isolated-surface）插件件的中控 I/O 契约**（施工单 §4）。
 *
 * 三条锁：
 * 1. 往下递：假 surface `mount` 后收到 `host:input`，四段齐全（style / size / session / editing）；
 *    尺寸实测变化、hasSession / generating / editing 变化 ⇒ 重发；
 * 2. 往上收：三类请求各自生效 —— `cc:insert` 写草稿、`cc:send` 走命令口、`cc:open` 调 `window.open`；
 * 3. 非法请求（无会话 / 空文本 / 超长 / 非 http(s) / `panel`）⇒ 拒绝 + 诊断（不静默，
 *    且副作用一个都不发生）；非本件契约的事件名（含宿主自己的 `host:input` 回灌）不认也不报错。
 *
 * 挂载用**非预览**输入（`preview: false`）：`readonly` 判据在预览有会话时恒真，会让 `cc:send`
 * 走"只读拒绝"分支、测不到命令口；非预览挂载才是"能发"的那条路。
 */
import { cleanup, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort, type RendererDiagnosticContext } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { activateTestBuiltinPlugin } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { deactivatePluginInstance, type PluginInstance } from '../../../plugin-runtime/pluginInstance.ts'
import type { PluginUiEventBridge, PluginUiSurface } from '../../../plugin-runtime/ui/pluginUiTypes.ts'

const SESSION_ID = 'preview-session'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []
const instances: PluginInstance[] = []

afterEach(async () => {
  cleanup()
  while (instances.length > 0) await deactivatePluginInstance(instances.pop()!)
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

interface FakeSurface {
  readonly surface: PluginUiSurface
  /** 收到的 `host:input` 包（按到达序） */
  readonly inputs: unknown[]
  /** 从盒子侧发一个 bridge 事件（未挂载即抛，防"测试自己空转"） */
  emit(event: string, detail?: unknown): void
}

function createFakeSurface(surfaceId: string): FakeSurface {
  const inputs: unknown[] = []
  let bridge: PluginUiEventBridge | undefined
  return {
    inputs,
    emit(event, detail) {
      if (!bridge) throw new Error('假 surface 尚未挂载，无法发事件')
      bridge.emit(event, detail)
    },
    surface: {
      id: surfaceId,
      runtime: { framework: 'solid', version: '1.0.0' },
      mount(container, surfaceBridge) {
        bridge = surfaceBridge
        surfaceBridge.on('host:input', detail => { inputs.push(detail) })
        const node = document.createElement('div')
        node.dataset.fakeSurface = 'ready'
        container.replaceChildren(node)
        return () => { container.replaceChildren() }
      },
    },
  }
}

function mountWorkbench() {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
  const diagnostics: RendererDiagnosticContext[] = []
  const hostPort = createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-cc-isolated',
    sessionOwnerKey: 'owner-cc-isolated',
    sessionId: SESSION_ID,
    diagnostics: diagnostic => { diagnostics.push(diagnostic) },
  })
  const lifecycle = mountSolidWorkbench({
    host,
    input: { sheetId: 'sheet-cc-isolated', sessionId: SESSION_ID, rightInset: 24, reducedMotion: true },
    services,
    hostPort,
  })
  return { host, services, lifecycle, diagnostics }
}

/** 登记一个 isolated-surface 插件件（同一插件同时注册 UI 面与元件）。 */
async function installIsolatedWidget(fake: FakeSurface, widgetId: string): Promise<PluginInstance> {
  const instance = await activateTestBuiltinPlugin(createPluginIdentity('test.cc-isolated-plugin', `root-${widgetId}`), ({ ui, ccWidget }) => {
    ui.registerSurface(fake.surface)
    ccWidget.registerWidget({
      id: widgetId,
      label: '隔离插件件',
      render: { kind: 'isolated-surface', surfaceId: fake.surface.id },
    })
  })
  instances.push(instance)
  return instance
}

/** 假 surface 收到的最后一包（找不到即抛，避免空断言）。 */
function lastInput(fake: FakeSurface): {
  style: Record<string, unknown>
  size: { width: number, height: number }
  session: { hasSession: boolean, generating: boolean }
  editing: boolean
  props: Record<string, string | number>
} {
  const payload = fake.inputs.at(-1)
  if (!payload) throw new Error('假 surface 一包 host:input 都没收到')
  return payload as never
}

const rejectionMessages = (diagnostics: readonly RendererDiagnosticContext[]) =>
  diagnostics.filter(item => item.code === 'cc-widget.surface.event-rejected').map(item => item.message)

describe('#266 CC-13 刀2 · 隔离面插件件 I/O', () => {
  it('（往下递）挂载即收到 host:input 五段；尺寸 / hasSession / generating / editing 变化 ⇒ 重发', async () => {
    // ControlCenter 与隔离件都建 ResizeObserver —— 用可驱动替身，找"观察本件容器"那一个。
    const previousResizeObserver = globalThis.ResizeObserver
    class MockResizeObserver {
      static instances: MockResizeObserver[] = []
      readonly observed = new Set<Element>()
      constructor(private readonly callback: ResizeObserverCallback) { MockResizeObserver.instances.push(this) }
      observe(target: Element) { this.observed.add(target) }
      unobserve(target: Element) { this.observed.delete(target) }
      disconnect() { this.observed.clear() }
      trigger() { this.callback([], this as unknown as ResizeObserver) }
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

    try {
      const dom = mountWorkbench()
      const fake = createFakeSurface('test.cc-isolated-surface')
      await installIsolatedWidget(fake, 'test.cc-isolated-widget')

      await waitFor(() => expect(fake.inputs.length).toBeGreaterThan(0))
      const first = lastInput(fake)
      // ★ CC-13 刀4：**五段**（前四段语义不变，只增 `props`）—— 隔离面靠 props 才能"按参数画"
      expect(Object.keys(first).sort()).toEqual(['editing', 'props', 'session', 'size', 'style'])
      // style = 内置件同源字段（外观令牌）
      expect(Object.keys(first.style).sort()).toEqual(['bg', 'border', 'fontSize', 'height', 'radius', 'text'])
      expect(typeof first.style.bg).toBe('string')
      expect(typeof first.style.fontSize).toBe('number')
      // session = 弱状态；editing = 编辑态标志；size = 实测（jsdom 无布局 ⇒ 0/0）
      expect(first.session).toEqual({ hasSession: true, generating: true })
      expect(first.editing).toBe(false)
      expect(first.size).toEqual({ width: 0, height: 0 })
      // props：没调过参数 ⇒ 空表（不是 undefined / null）
      expect(first.props).toEqual({})

      // ① 尺寸实测变化 ⇒ 重发
      const container = dom.host.querySelector<HTMLElement>('.cc-isolated-widget')!
      const observer = MockResizeObserver.instances.find(candidate => candidate.observed.has(container))!
      Object.defineProperty(container, 'clientWidth', { configurable: true, value: 96 })
      Object.defineProperty(container, 'clientHeight', { configurable: true, value: 28 })
      const inputsBeforeResize = fake.inputs.length
      observer.trigger()
      await waitFor(() => expect(lastInput(fake).size).toEqual({ width: 96, height: 28 }))
      expect(fake.inputs.length).toBeGreaterThan(inputsBeforeResize)

      // ② editing 变化 ⇒ 重发
      dom.services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
      await waitFor(() => expect(lastInput(fake).editing).toBe(true))

      // ③ generating 变化 ⇒ 重发
      dom.services.runtime.update({ generating: false })
      await waitFor(() => expect(lastInput(fake).session.generating).toBe(false))

      // ④ hasSession 变化 ⇒ 重发（换到无会话）
      dom.lifecycle.update({ sheetId: 'sheet-cc-isolated', sessionId: null, rightInset: 24, reducedMotion: true })
      await waitFor(() => expect(lastInput(fake).session.hasSession).toBe(false))

      // ⑤ 参数变化 ⇒ 重发（★ 刀4：props 段随 `ccPluginProps[该元件 id]` 走）
      dom.services.appearance.dispatch({ type: 'set-cc-plugin-prop', id: 'test.cc-isolated-widget', key: 'accent', value: '#123456' })
      await waitFor(() => expect(lastInput(fake).props).toEqual({ accent: '#123456' }))
      dom.services.appearance.dispatch({ type: 'set-cc-plugin-prop', id: 'test.cc-isolated-widget', key: 'size', value: 18 })
      await waitFor(() => expect(lastInput(fake).props).toEqual({ accent: '#123456', size: 18 }))
      // 别的元件的参数不进这一包（按 id 取，不串门）
      dom.services.appearance.dispatch({ type: 'set-cc-plugin-prop', id: 'other.widget', key: 'size', value: 99 })
      await waitFor(() => expect(dom.services.appearance.getSnapshot().ccPluginProps['other.widget']).toEqual({ size: 99 }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(lastInput(fake).props).toEqual({ accent: '#123456', size: 18 })
    } finally {
      globalThis.ResizeObserver = previousResizeObserver
    }
  })

  it('（往上收）三类请求各自生效：insert 写草稿 / send 走命令口 / open 调 window.open', async () => {
    const dom = mountWorkbench()
    const fake = createFakeSurface('test.cc-isolated-surface-2')
    await installIsolatedWidget(fake, 'test.cc-isolated-widget-2')
    await waitFor(() => expect(fake.inputs.length).toBeGreaterThan(0))

    // a 投递文本：追加进草稿（用户仍可改）
    dom.services.sessionUi.set(SESSION_ID, 'draft', '已有内容')
    fake.emit('cc:insert', { text: '插件投递' })
    await waitFor(() => expect(dom.services.sessionUi.get(SESSION_ID, 'draft', '')).toBe('已有内容插件投递'))

    // b 直接发送：走既有命令口（命令口自带能力校验与错误上报）
    fake.emit('cc:send', { text: '直接发送' })
    await waitFor(() => expect(dom.services.commands.calls).toContainEqual({
      command: 'send',
      args: [SESSION_ID, { text: '直接发送' }],
    }))

    // c 打开外链：http/https 放行，走 window.open 同一条
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      fake.emit('cc:open', { url: 'https://example.com/path' })
      expect(open).toHaveBeenCalledWith('https://example.com/path', '_blank', 'noopener,noreferrer')
      // 大小写不敏感
      fake.emit('cc:open', { url: 'HTTP://example.com/upper' })
      expect(open).toHaveBeenCalledWith('HTTP://example.com/upper', '_blank', 'noopener,noreferrer')
    } finally {
      open.mockRestore()
    }
  })

  it('（拒绝）非法请求：各自被拒 + 诊断，且副作用一个都不发生', async () => {
    const dom = mountWorkbench()
    const fake = createFakeSurface('test.cc-isolated-surface-3')
    await installIsolatedWidget(fake, 'test.cc-isolated-widget-3')
    await waitFor(() => expect(fake.inputs.length).toBeGreaterThan(0))

    dom.services.sessionUi.set(SESSION_ID, 'draft', '底稿')
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const sendCallsBefore = dom.services.commands.calls.filter(call => call.command === 'send').length
    try {
      fake.emit('cc:insert', { text: '' })                                   // 空文本
      fake.emit('cc:insert', { text: 'x'.repeat(2001) })                     // 超长（上限 2000）
      fake.emit('cc:send', { text: '   ' })                                  // 空文本（trim 后为空）
      fake.emit('cc:open', { url: 'ftp://example.com' })                     // 非 http(s)
      fake.emit('cc:open', { url: '' })                                      // 无 URL
      fake.emit('cc:open', { panel: 'settings' })                            // 面板分支未开放
      // 非本件契约的事件名（含宿主自己的 `host:input` 回灌）既不是拒绝、也不报错 —— 与其它宿主的分诊同款
      fake.emit('cc:not-a-real-event', {})
      fake.emit('host:collapse', {})

      expect(rejectionMessages(dom.diagnostics)).toEqual([
        expect.stringContaining('cc:insert（空文本）'),
        expect.stringContaining('cc:insert（超长（上限 2000 字符））'),
        expect.stringContaining('cc:send（空文本）'),
        expect.stringContaining('cc:open（仅支持 http/https）'),
        expect.stringContaining('cc:open（无 URL）'),
        expect.stringContaining('cc:open（面板分支未开放（本刀不做））'),
      ])
      // 副作用一个都不发生
      expect(dom.services.sessionUi.get(SESSION_ID, 'draft', '')).toBe('底稿')
      expect(dom.services.commands.calls.filter(call => call.command === 'send')).toHaveLength(sendCallsBefore)
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })

  it('（拒绝）无会话：insert / send 都拒绝 + 诊断（open 与有无会话无关，仍放行）', async () => {
    const dom = mountWorkbench()
    const fake = createFakeSurface('test.cc-isolated-surface-4')
    await installIsolatedWidget(fake, 'test.cc-isolated-widget-4')
    await waitFor(() => expect(fake.inputs.length).toBeGreaterThan(0))

    dom.lifecycle.update({ sheetId: 'sheet-cc-isolated', sessionId: null, rightInset: 24, reducedMotion: true })
    await waitFor(() => expect(lastInput(fake).session.hasSession).toBe(false))

    fake.emit('cc:insert', { text: '没人接' })
    fake.emit('cc:send', { text: '没人接' })

    expect(rejectionMessages(dom.diagnostics)).toEqual([
      expect.stringContaining('cc:insert（无会话）'),
      expect.stringContaining('cc:send（无会话）'),
    ])
    expect(dom.services.commands.calls.filter(call => call.command === 'send')).toHaveLength(0)
  })
})
