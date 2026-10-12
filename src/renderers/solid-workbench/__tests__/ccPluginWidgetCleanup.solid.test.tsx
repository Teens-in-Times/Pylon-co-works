// @vitest-environment jsdom
/**
 * #266 CC-13 刀3 集成：**卸载即清 / 热替换不误清**（施工单 §4.4）。
 * ★ 刀4 泛化：命令 `clear-cc-placement` → **`clear-cc-widget-data`**（一次清三样：
 *   位置 / 插件属性 `ccPluginProps` / 两份显隐表里的该 id）；本文件的断言随之更新，
 *   并补一例"三样都清"的运行态读数（刀4 施工单 §7-4 的点名项之外，本文件是**命令改名**的直接受害者）。
 *
 * 口径（用户 2026-10-05 定）：插件**撤下那一刻**把它的用户数据删掉（重装 = 新加入、排最后）。
 * ★ 为什么不是"读盘顺手丢"：读盘发生在插件登记**之前** ⇒ 读盘丢会在每次重启误删插件数据。
 * ★ 热替换（shadow）不误清：撤下与重登记可能同帧发生 ⇒ 清理延迟一个微任务后复查。
 */
import { cleanup, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { activateTestBuiltinPlugin } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { deactivatePluginInstance, type PluginInstance } from '../../../plugin-runtime/pluginInstance.ts'
import { getCcWidgetRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import type { CcWidgetContribution } from '../../../plugin-runtime/cc-widget/ccWidgetTypes.ts'
import type { AppearanceCommand } from '../../../domains/appearance/appearance.ts'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []
const instances: PluginInstance[] = []
const handles: AsyncDisposable[] = []

afterEach(async () => {
  cleanup()
  while (handles.length > 0) await handles.pop()!.dispose()
  while (instances.length > 0) await deactivatePluginInstance(instances.pop()!)
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

const CLEANUP_ID = 'test.cc-cleanup-alpha'
const widget = (id: string, label: string, rendererKey = 'tokens'): CcWidgetContribution =>
  ({ id, label, render: { kind: 'host-renderer', rendererKey } })

/** 挂工作台 + 记下所有派发到外观 store 的命令（清位命令的证据面）。 */
function mountWorkbench() {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
  const commands: AppearanceCommand[] = []
  const originalDispatch = services.appearance.dispatch.bind(services.appearance)
  services.appearance.dispatch = command => {
    commands.push(command)
    originalDispatch(command)
  }
  const hostPort = createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-cc-cleanup',
    sessionOwnerKey: 'owner-cc-cleanup',
    sessionId: 'preview-session',
    diagnostics: () => {},
  })
  const lifecycle = mountSolidWorkbench({
    host,
    input: { sheetId: 'sheet-cc-cleanup', sessionId: 'preview-session', preview: true, rightInset: 24, reducedMotion: true },
    services,
    hostPort,
  })
  return { host, services, lifecycle, commands }
}

const clearCommands = (commands: readonly AppearanceCommand[]) =>
  commands.filter(command => command.type === 'clear-cc-widget-data')

describe('#266 CC-13 刀3/刀4 · 卸载即清 / 热替换不误清', () => {
  it('装 → 拖（落盘）→ 撤下：位置记录消失 + 派发 clear-cc-widget-data；重装 ⇒ 排最后（新加入）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    const instance = await activateTestBuiltinPlugin(createPluginIdentity('test.cc-cleanup', 'root'), ({ ccWidget }) => {
      ccWidget.registerWidget(widget(CLEANUP_ID, '待撤下'))
    })
    instances.push(instance)
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).not.toBeNull())

    // 用户动过（这里直接派发等价命令：与拖动走同一条 update-cc-placement）
    dom.services.appearance.dispatch({ type: 'update-cc-placement', id: CLEANUP_ID, placement: { order: 9, offsetX: 4 } })
    expect(dom.services.appearance.getSnapshot().ccLayout.placements[CLEANUP_ID]).toEqual({ order: 9, offsetX: 4, offsetY: 0 })

    await deactivatePluginInstance(instance)
    instances.splice(instances.indexOf(instance), 1)
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).toBeNull())

    // 撤下那一刻：数据里那条消失，且**明确派发过**清位命令（不是"读盘顺手丢"）
    await waitFor(() => expect(dom.services.appearance.getSnapshot().ccLayout.placements[CLEANUP_ID]).toBeUndefined())
    expect(clearCommands(dom.commands)).toEqual([{ type: 'clear-cc-widget-data', id: CLEANUP_ID }])

    // 重装 = 新加入：回来时排在最后（不回原位，数据里也不再有记录，直到用户再动一次）
    await activateTestBuiltinPlugin(createPluginIdentity('test.cc-cleanup', 'root-again'), ({ ccWidget }) => {
      ccWidget.registerWidget(widget(CLEANUP_ID, '重装回来'))
    }).then(next => instances.push(next))
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).not.toBeNull())
    expect(dom.services.appearance.getSnapshot().ccLayout.placements[CLEANUP_ID]).toBeUndefined()
    const ids = [...dom.host.querySelectorAll('.cc-status-row [data-widget-id]')].map(el => el.getAttribute('data-widget-id'))
    expect(ids[ids.length - 1]).toBe(CLEANUP_ID)
  })

  it('同帧撤下 + 重登记（同一 id）⇒ 微任务复查放行：不派发 clear、位置读数不变', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    const registry = getCcWidgetRegistry()
    const owner = createPluginIdentity('test.cc-cleanup-same-frame', 'root')
    const handle = registry.register(owner, widget(CLEANUP_ID, '同帧件'))
    handles.push(handle)
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).not.toBeNull())
    dom.services.appearance.dispatch({ type: 'update-cc-placement', id: CLEANUP_ID, placement: { order: 9, offsetX: 3 } })

    // 撤下与重新登记都发生在**同一个同步块**里（微任务之前）—— 正是 shadow 的时序形状
    handle.dispose()
    handles.push(registry.register(createPluginIdentity('test.cc-cleanup-same-frame', 'next'), widget(CLEANUP_ID, '同帧件')))

    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).not.toBeNull())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(dom.services.appearance.getSnapshot().ccLayout.placements[CLEANUP_ID]).toEqual({ order: 9, offsetX: 3, offsetY: 0 })
    expect(clearCommands(dom.commands)).toEqual([])
  })

  it('热替换（shadow transaction）：同 id 换渲染体 ⇒ 位置读数不变、不派发 clear', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    const registry = getCcWidgetRegistry()
    const owner = createPluginIdentity('test.cc-cleanup-swap', 'root')
    const original = registry.register(owner, widget(CLEANUP_ID, '替换前'))
    handles.push(original)
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"] .cc-usage-pill`)).not.toBeNull())
    dom.services.appearance.dispatch({ type: 'update-cc-placement', id: CLEANUP_ID, placement: { order: 9, offsetX: 3 } })

    const swapped = registry.beginShadowTransaction(createPluginIdentity('test.cc-cleanup-swap', 'next'), owner.key)
    swapped.register(widget(CLEANUP_ID, '替换后', 'mode'), { contributionId: CLEANUP_ID })
    const disposables = swapped.commit()
    try {
      await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"] .solid-permission-widget`)).not.toBeNull())
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(dom.services.appearance.getSnapshot().ccLayout.placements[CLEANUP_ID]).toEqual({ order: 9, offsetX: 3, offsetY: 0 })
      expect(clearCommands(dom.commands)).toEqual([])
    } finally {
      for (const disposable of disposables) await disposable.dispose()
    }
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).toBeNull())
    // 真撤下（disposables 全部释放）之后才该清
    await waitFor(() => expect(clearCommands(dom.commands)).toEqual([{ type: 'clear-cc-widget-data', id: CLEANUP_ID }]))
  })

  // ★ 刀4（小活①的连带 · 泛化后新增）：撤下时**三样一起清** —— 位置 / 参数 / 两份显隐记录。
  it('撤下清三样：位置 / ccPluginProps / 两份显隐表里的 id 同时消失（只派发一次）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    const instance = await activateTestBuiltinPlugin(createPluginIdentity('test.cc-cleanup-triple', 'root'), ({ ccWidget }) => {
      ccWidget.registerWidget(widget(CLEANUP_ID, '三样都动过'))
    })
    instances.push(instance)
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).not.toBeNull())

    // 用户动过三样：位置（拖动/顺序）、参数（编辑列属性面板）、两份显隐开关
    dom.services.appearance.dispatch({ type: 'update-cc-placement', id: CLEANUP_ID, placement: { order: 9, offsetX: 4 } })
    dom.services.appearance.dispatch({ type: 'set-cc-plugin-prop', id: CLEANUP_ID, key: 'size', value: 18 })
    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: CLEANUP_ID, hidden: true, target: 'base' })
    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: CLEANUP_ID, hidden: true, target: 'empty' })
    const before = dom.services.appearance.getSnapshot()
    expect(before.ccLayout.placements[CLEANUP_ID]).toEqual({ order: 9, offsetX: 4, offsetY: 0 })
    expect(before.ccPluginProps[CLEANUP_ID]).toEqual({ size: 18 })
    expect(before.ccHidden).toContain(CLEANUP_ID)
    expect(before.ccHiddenEmpty).toContain(CLEANUP_ID)

    await deactivatePluginInstance(instance)
    instances.splice(instances.indexOf(instance), 1)

    await waitFor(() => {
      const after = dom.services.appearance.getSnapshot()
      expect(after.ccLayout.placements[CLEANUP_ID]).toBeUndefined()
      expect(after.ccPluginProps[CLEANUP_ID]).toBeUndefined()
      expect(after.ccHidden).not.toContain(CLEANUP_ID)
      expect(after.ccHiddenEmpty).not.toContain(CLEANUP_ID)
    })
    // 三样一次清完（不是三次各派发一条）
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(clearCommands(dom.commands)).toEqual([{ type: 'clear-cc-widget-data', id: CLEANUP_ID }])
    // 内置件的记录与两份显隐表整体不受影响
    expect(dom.services.appearance.getSnapshot().ccLayout.placements.model).toBeTruthy()
  })

  it('幂等：位置记录本来就不存在 ⇒ 撤下不派发 clear（先查再清）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    const instance = await activateTestBuiltinPlugin(createPluginIdentity('test.cc-cleanup-idle', 'root'), ({ ccWidget }) => {
      ccWidget.registerWidget(widget(CLEANUP_ID, '没动过的件'))
    })
    instances.push(instance)
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).not.toBeNull())

    await deactivatePluginInstance(instance)
    instances.splice(instances.indexOf(instance), 1)
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${CLEANUP_ID}"]`)).toBeNull())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(clearCommands(dom.commands)).toEqual([])
  })
})
