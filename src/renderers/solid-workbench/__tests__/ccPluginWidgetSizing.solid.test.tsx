// @vitest-environment jsdom
/**
 * #266 CC-13 刀5 集成：**插件件进「最小高 / 最小宽 / 显示前校验」算式**（真读数）。
 *
 * 刀4 letf 的已知限制（勾"显示"时的空间校验不算插件件）在本刀收口，本文件锁施工单 §6 的 1~4：
 * 1. **报了就计**：`sizing.height = 120` ⇒ `--cc-min-height` 由 64 抬到 **135**
 *    （状态区行高取 max = 120，加该组到边距离 `ccMarginBottom` 15）；
 *    `sizing.width = 200` ⇒ `--cc-min-width` 由 384 抬到 **584**（队列求和、间距 0）；
 * 2. **隐藏 ⇒ 不计**（与渲染同一谓词）；取消 ⇒ 回升；
 * 3. **不报 = 下界**：读数与"不登记该插件件"逐位相同（64 / 384），而该件照常在场；
 * 4. **显示前校验**：报了 sizing 的插件件在"装不下"的夹具下**勾"显示"被拦**（一条命令都不发），
 *    空间够则放行；提示里的数字与算式同源。
 * 5. **非法 sizing**：只丢该维 + 诊断 `cc-widget.sizing.rejected`，该件照常上屏。
 *
 * ★ jsdom 无布局（`clientWidth/Height` 恒 0 ⇒ 校验 fail-open）——本文件用
 *   `Object.defineProperty(element, 'clientHeight', …)` **给这一个元素**造出实测尺寸，
 *   不改原型、不影响别的用例；真机读数（Tauri）见工作者汇报的「实机读数」节。
 */
import { cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort, type RendererDiagnosticContext } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { activateTestBuiltinPlugin } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { deactivatePluginInstance, type PluginInstance } from '../../../plugin-runtime/pluginInstance.ts'
import type { CcWidgetContribution, CcWidgetSizing } from '../../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

const WIDGET = 'test.cc-sizing-alpha'
const ILLEGAL_WIDGET = 'test.cc-sizing-illegal'
/** 状态区那一行的五个内置件（独占态夹具：全藏它们，状态组就只剩插件件）。 */
const STATUS_BUILTINS = ['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint']

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []
const instances: PluginInstance[] = []

afterEach(async () => {
  cleanup()
  while (instances.length > 0) await deactivatePluginInstance(instances.pop()!)
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

function mountWorkbench(sessionId: string | null) {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
  const diagnostics: RendererDiagnosticContext[] = []
  const hostPort = createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-cc-sizing',
    sessionOwnerKey: 'owner-cc-sizing',
    sessionId: 'preview-session',
    diagnostics: diagnostic => { diagnostics.push(diagnostic) },
  })
  const lifecycle = mountSolidWorkbench({
    host,
    input: { sheetId: 'sheet-cc-sizing', sessionId, preview: true, rightInset: 24, reducedMotion: true },
    services,
    hostPort,
  })
  const controlCenter = () => host.querySelector<HTMLElement>('.control-center')!
  /** 挂成变量的两个读数（`--cc-min-height` / `--cc-min-width`，渲染侧唯一消费者是 CSS）。 */
  const vars = () => ({
    minHeight: controlCenter().style.getPropertyValue('--cc-min-height'),
    minWidth: controlCenter().style.getPropertyValue('--cc-min-width'),
  })
  return { host, services, lifecycle, diagnostics, controlCenter, vars }
}

const widgetIn = (host: HTMLElement, id = WIDGET) => host.querySelector(`[data-widget-id="${id}"]`)

async function registerWidget(widget: CcWidgetContribution): Promise<PluginInstance> {
  const instance = await activateTestBuiltinPlugin(createPluginIdentity('test.cc-sizing', 'root'), ({ ccWidget }) => {
    ccWidget.registerWidget(widget)
  })
  instances.push(instance)
  return instance
}

const sizedWidget = (sizing?: CcWidgetSizing): CcWidgetContribution => ({
  id: WIDGET,
  label: '尺寸件',
  render: { kind: 'host-renderer', rendererKey: 'tokens' },
  ...(sizing ? { sizing } : {}),
})

/** 挂载 + 等内置件上屏（默认口径读数：最小高 64（下界兜底）、最小宽 384（三触发器队列））。 */
async function mountReady() {
  const dom = mountWorkbench('preview-session')
  await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
  expect(dom.vars()).toEqual({ minHeight: '64px', minWidth: '384px' })
  return dom
}

describe('#266 CC-13 刀5 · 插件件进最小高 / 宽算式', () => {
  it('★ 报了就计：报 height ⇒ 64 抬到 135；报 width ⇒ 384 抬到 584；隐藏 ⇒ 回落；取消 ⇒ 回升', async () => {
    const dom = await mountReady()
    await registerWidget(sizedWidget({ width: 200, height: 120 }))
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())
    await waitFor(() => expect(dom.vars()).toEqual({ minHeight: '135px', minWidth: '584px' }))

    // 隐藏 ⇒ 与渲染同一谓词 ⇒ 不计数（两处读数一起回落）
    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: WIDGET, hidden: true, target: 'base' })
    await waitFor(() => expect(widgetIn(dom.host)).toBeNull())
    await waitFor(() => expect(dom.vars()).toEqual({ minHeight: '64px', minWidth: '384px' }))

    // 取消隐藏 ⇒ 回升
    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: WIDGET, hidden: false, target: 'base' })
    await waitFor(() => expect(dom.vars()).toEqual({ minHeight: '135px', minWidth: '584px' }))
  })

  it('★ 不报尺寸 ⇒ 与"不登记该插件件"**逐位相同**（下界）：仍是 64 / 384，而该件照常在场', async () => {
    const dom = await mountReady()
    await registerWidget({ id: WIDGET, label: '没报尺寸', render: { kind: 'host-renderer', rendererKey: 'tokens' } })
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())
    // 让它有一帧以上的时间把（若有的）错误计数写出来，再断言"没有变化"
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(widgetIn(dom.host)).not.toBeNull()
    expect(dom.vars()).toEqual({ minHeight: '64px', minWidth: '384px' })
  })

  it('★ 插件件**独占状态组**（内置状态件全藏）⇒ 边距照算：`--cc-min-height` 仍是 135px（空态默认就是这个组合）', async () => {
    const dom = await mountReady()
    await registerWidget(sizedWidget({ width: 200, height: 120 }))
    await waitFor(() => expect(dom.vars()).toEqual({ minHeight: '135px', minWidth: '584px' }))

    // 内置状态件全藏 ⇒ 状态组只剩插件件（= 组由它新建）；空态默认（`ccHiddenEmpty`）就是这个组合
    for (const id of STATUS_BUILTINS) {
      dom.services.appearance.dispatch({ type: 'set-cc-hidden', id, hidden: true, target: 'base' })
    }
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).toBeNull())
    await new Promise(resolve => setTimeout(resolve, 0))
    // 独占态：状态组高 120 + 该落脚处声明的 `ccMarginBottom` 15 = 135（修正前会掉到 120）
    // 宽度侧随在场件走 ⇒ 200（`layout.x.gap` 全行缺省 ⇒ 边距仍是 0，与修正前逐位相同）
    expect(dom.vars()).toEqual({ minHeight: '135px', minWidth: '200px' })

    // 恢复内置件 ⇒ 两处读数逐位回到修正前的那一组
    for (const id of STATUS_BUILTINS) {
      dom.services.appearance.dispatch({ type: 'set-cc-hidden', id, hidden: false, target: 'base' })
    }
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await waitFor(() => expect(dom.vars()).toEqual({ minHeight: '135px', minWidth: '584px' }))
  })

  it('★ 内置件全藏、**无插件件** ⇒ 读数与修正前相同（仍是 64px 基线；不凭空造边距）', async () => {
    const dom = await mountReady()
    for (const id of STATUS_BUILTINS) {
      dom.services.appearance.dispatch({ type: 'set-cc-hidden', id, hidden: true, target: 'base' })
    }
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).toBeNull())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(dom.vars()).toEqual({ minHeight: '64px', minWidth: '0px' })
  })

  it('★ 显示前校验：报了 sizing ⇒ 装不下（可用 100 < 需要 135）时被拦、一条命令都不发；够装则放行', async () => {
    const dom = await mountReady()
    await registerWidget(sizedWidget({ height: 120 }))
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())
    dom.services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: WIDGET, hidden: true, target: 'base' })
    await waitFor(() => expect(widgetIn(dom.host)).toBeNull())

    // 夹具：把这一件元素量成"高 100、宽 2000"（宽够、高不够 ⇒ 只该报纵向）
    const element = dom.controlCenter()
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: 2000 })

    const showButton = () => dom.host.querySelector<HTMLButtonElement>(`.cc-edit-column button[aria-label="显示 尺寸件"]`)
    await waitFor(() => expect(showButton()).not.toBeNull())
    fireEvent.click(showButton()!)
    await waitFor(() => expect(dom.host.querySelector('.cc-edit-warning')).not.toBeNull())
    expect(dom.host.querySelector('.cc-edit-warning')!.textContent)
      .toBe('还差 35px：需要 135px，当前 100px —— 先加高，或先藏别的')
    // 被拒 = 主题数据一个字节不动（插件件仍在隐藏名单里、仍不上屏）
    expect(widgetIn(dom.host)).toBeNull()
    expect(dom.services.appearance.getSnapshot().ccHidden).toContain(WIDGET)

    // 空间够（200 ≥ 135）⇒ 放行：真的显示出来，提示退场
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 200 })
    fireEvent.click(showButton()!)
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())
    expect(dom.host.querySelector('.cc-edit-warning')).toBeNull()
    expect(dom.services.appearance.getSnapshot().ccHidden).not.toContain(WIDGET)
  })

  it('★ 非法 sizing：坏的那维不进算式 + 诊断 `cc-widget.sizing.rejected`，该件照常上屏', async () => {
    const dom = await mountReady()
    await registerWidget({
      id: ILLEGAL_WIDGET,
      label: '坏的二维',
      render: { kind: 'host-renderer', rendererKey: 'tokens' },
      sizing: { width: 200, height: -5 },
    })
    await registerWidget({
      id: WIDGET,
      label: '整条不是对象',
      render: { kind: 'host-renderer', rendererKey: 'tokens' },
      sizing: '200' as unknown as CcWidgetSizing,
    })
    // 不丢件：两件都在场
    await waitFor(() => expect(widgetIn(dom.host, ILLEGAL_WIDGET)).not.toBeNull())
    expect(widgetIn(dom.host)).not.toBeNull()
    // 合法的宽度维照收（584），坏掉的高度维按 0 计（仍是下界 64）
    await waitFor(() => expect(dom.vars()).toEqual({ minHeight: '64px', minWidth: '584px' }))
    // 两条诊断各自点名：坏维度 / 整条不是对象
    // ★ 去重后断言：诊断 effect 随**名单**重跑（登记第二件时会把第一件的拒绝再报一遍，既有写法如此），
    //   这里锁的是"哪几条**不同**的拒绝进过诊断口"，不是"一共报了几次"。
    const sizedMessages = () => [...new Set(dom.diagnostics
      .filter(item => item.code === 'cc-widget.sizing.rejected')
      .map(item => item.message))]
    await waitFor(() => expect(sizedMessages()).toEqual([
      `插件元件 ${ILLEGAL_WIDGET} 的尺寸声明被忽略（height：尺寸不是有限的正数（px））`,
      `插件元件 ${WIDGET} 的尺寸声明被忽略（整条声明：sizing 不是对象（两维都不参与））`,
    ]))
  })
})
