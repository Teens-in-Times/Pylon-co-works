// @vitest-environment jsdom
/**
 * #266 CC-13 刀3 集成：**插件件的工位**（落点 / 拖动 / 编辑列 / 兜底解析）。
 *
 * 锁施工单 §6 前两条的机器可判部分：
 * 1. **默认排最后**：登记两个插件件 ⇒ 计算 order 递增（状态区内置最大 order +1 +登记序）、
 *    DOM 在状态区末尾且先后 = 登记先后；
 * 2. **进编辑列**：行名 = 插件自报 label；展开后布局三项读的是**兜底解析**（不是 `undefined.order`）；
 * 3. **拖动 ⇒ 落盘**：插件件的**首写**把计算默认一并写进数据（不是 order 0），offset 落盘并渲染出来。
 *
 * ★ "重启后仍在"的机器判据分两层：读盘往返（`normalizeCcLayout` 保住未知键，见
 * `domains/cc/__tests__/ccLayoutWidgetSpace.test.ts`）+ 实机刷新读数（报告里的运行态证据）。
 */
import { cleanup, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { activateTestBuiltinPlugin } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { deactivatePluginInstance, type PluginInstance } from '../../../plugin-runtime/pluginInstance.ts'
import type { CcWidgetContribution } from '../../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []
const instances: PluginInstance[] = []

afterEach(async () => {
  cleanup()
  while (instances.length > 0) await deactivatePluginInstance(instances.pop()!)
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

function mountWorkbench() {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
  const hostPort = createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-cc-placement',
    sessionOwnerKey: 'owner-cc-placement',
    sessionId: 'preview-session',
    diagnostics: () => {},
  })
  const lifecycle = mountSolidWorkbench({
    host,
    input: { sheetId: 'sheet-cc-placement', sessionId: 'preview-session', preview: true, rightInset: 24, reducedMotion: true },
    services,
    hostPort,
  })
  return { host, services, lifecycle }
}

async function registerWidgets(widgets: readonly CcWidgetContribution[], pluginId = 'test.cc-placement'): Promise<void> {
  instances.push(await activateTestBuiltinPlugin(createPluginIdentity(pluginId, 'root'), ({ ccWidget }) => {
    for (const widget of widgets) ccWidget.registerWidget(widget)
  }))
}

/** 状态区（`.cc-status-row`）内的件 id 顺序 —— "排在状态区末尾"的证据面。 */
function statusWidgetIds(host: HTMLElement): (string | null)[] {
  return [...host.querySelectorAll('.cc-status-row [data-widget-id]')].map(el => el.getAttribute('data-widget-id'))
}

function firePointerDown(element: Element, clientX: number, clientY: number) {
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY }))
}
function fireWindowPointer(type: 'pointermove' | 'pointerup', clientX: number, clientY: number) {
  window.dispatchEvent(new MouseEvent(type, { clientX, clientY }))
}

const BUILTIN_STATUS_IDS = ['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint']
/** 状态区内置件的最大 order = 6（命令行提示）⇒ 插件件默认从 7 起 */
const PLUGIN_DEFAULT_ORDER = 7
const ALPHA = 'test.cc-alpha'
const BETA = 'test.cc-beta'

const widget = (id: string, label: string, rendererKey = 'tokens'): CcWidgetContribution =>
  ({ id, label, render: { kind: 'host-renderer', rendererKey } })

describe('#266 CC-13 刀3 · 插件件工位', () => {
  it('默认排最后 + 计算 order 递增：DOM 先后 = 登记先后，数据里不预先写记录', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await registerWidgets([widget(ALPHA, '插件件甲'), widget(BETA, '插件件乙')])

    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${BETA}"]`)).not.toBeNull())
    expect(statusWidgetIds(dom.host)).toEqual([...BUILTIN_STATUS_IDS, ALPHA, BETA])
    // ★ 位置数据里**没有**这两条（默认由读取侧算，见 §4.1/§4.3）
    const placements = dom.services.appearance.getSnapshot().ccLayout.placements
    expect(placements[ALPHA]).toBeUndefined()
    expect(placements[BETA]).toBeUndefined()
  })

  it('编辑列出现插件件行（名字 = 插件自报 label），布局三项读兜底解析（不是 undefined.order）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await registerWidgets([widget(ALPHA, '插件件甲')])
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${ALPHA}"]`)).not.toBeNull())

    dom.services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const rowName = await waitFor(() => {
      const button = dom.host.querySelector<HTMLButtonElement>(`.cc-edit-column [aria-label="插件件甲 属性"]`)
      expect(button).toBeTruthy()
      return button!
    })
    expect(rowName.textContent).toContain('插件件甲')
    // 内置件的行仍在（名单 = 内置 ∪ 插件）
    expect(dom.host.querySelector('.cc-edit-column [aria-label="模型 属性"]')).not.toBeNull()

    rowName.click()
    const orderInput = await waitFor(() => {
      const input = dom.host.querySelector<HTMLInputElement>('.cc-edit-row.active input[aria-label="控件顺序"]')
      expect(input).toBeTruthy()
      return input!
    })
    // 兜底解析的读数：状态区末尾（内置最大 order 6 + 1），不是 NaN / 空
    expect(orderInput.value).toBe(String(PLUGIN_DEFAULT_ORDER))
    expect(orderInput.value).not.toBe('NaN')
    expect(dom.host.querySelector<HTMLInputElement>('.cc-edit-row.active input[aria-label="水平微调"]')!.value).toBe('0')
  })

  it('拖动插件件 ⇒ 首写落盘（含计算默认 order）+ 内联位移渲染出来', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await registerWidgets([widget(ALPHA, '插件件甲')])
    const wrapper = await waitFor(() => {
      const node = dom.host.querySelector<HTMLElement>(`[data-widget-id="${ALPHA}"]`)
      expect(node).toBeTruthy()
      return node!
    })
    expect(wrapper).toHaveClass('cc-plugin-widget')
    expect(wrapper.parentElement).toHaveClass('cc-status-row')
    expect(wrapper.style.transform).toBe('')

    dom.services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    await waitFor(() => expect(wrapper).toHaveClass('cc-edit'))

    // jsdom 矩形全零 ⇒ 占区守卫放行候选值（与 ControlCenter.solid.test.tsx 的拖拽用例同款）
    firePointerDown(wrapper, 10, 10)
    fireWindowPointer('pointermove', 30, 20)
    fireWindowPointer('pointerup', 30, 20)

    await waitFor(() => expect(dom.services.appearance.getSnapshot().ccLayout.placements[ALPHA]).toBeTruthy())
    // ★ 首写把**计算默认 order** 一并落盘（不是 0）—— 否则"排最后"会被一次拖动毁掉
    expect(dom.services.appearance.getSnapshot().ccLayout.placements[ALPHA]).toEqual({ order: PLUGIN_DEFAULT_ORDER, offsetX: 20, offsetY: 10 })
    await waitFor(() => expect(wrapper.style.transform).toBe('translate(20px, 10px)'))
    // 拖动不改顺序：DOM 序列稳定在末尾
    expect(statusWidgetIds(dom.host)).toEqual([...BUILTIN_STATUS_IDS, ALPHA])
  })

  it('顺序输入改写 ⇒ order 落盘（数据说了算：插件件之间按 order 排，与登记序解耦）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await registerWidgets([widget(ALPHA, '插件件甲'), widget(BETA, '插件件乙')])
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${BETA}"]`)).not.toBeNull())
    expect(statusWidgetIds(dom.host)).toEqual([...BUILTIN_STATUS_IDS, ALPHA, BETA])

    // B 的 order 改成比 A 的计算默认（7）小 ⇒ 插件件序列反转（数据说了算，与登记先后解耦）
    // ★ 本刀结构口径（点名）：插件件的包装恒在**状态组之后**，所以 order 号只决定插件件之间的先后，
    //   不会把插件件插进内置件中间（见回单「阻断与新增」的裁决项）。
    dom.services.appearance.dispatch({ type: 'update-cc-placement', id: BETA, placement: { order: 6 } })
    await waitFor(() => expect(statusWidgetIds(dom.host)).toEqual([...BUILTIN_STATUS_IDS, BETA, ALPHA]))
    expect(dom.services.appearance.getSnapshot().ccLayout.placements[BETA]).toEqual({ order: 6, offsetX: 0, offsetY: 0 })
  })
})
