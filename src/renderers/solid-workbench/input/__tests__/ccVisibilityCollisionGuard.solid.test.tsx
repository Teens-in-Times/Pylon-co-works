// @vitest-environment jsdom
/**
 * ★ CC-27 报警守卫（测试层，不进生产代码）：**可见名单 ⊆ 量得到盒子**。
 *
 * 生产障碍集 = 编辑态拖拽的 DOM 实测（`createCcDragController.measureWidgetBox`：
 * `[data-widget-id]` 查节点 + `getBoundingClientRect`），量不到的**静默退出障碍集**
 * （`.filter(rect => rect !== undefined)`）——「名单说可见却量不到」的缺口从此无人报。
 * 本守卫把缺口变成响亮的测试红：常态 / 空态各验一次「两层名单过滤后的可见集全部量得到」；
 * 再注入一条 `display:none` 模拟 CSS 暗道（`WorkbenchChrome.css:419` 那条写死藏显的替身）
 * ⇒ 守卫必须抓到（差集含该元件）。
 *
 * 取件方式与生产量法**同源**：同一个**活名单派生**的可拖件 id 序
 * （`resolveCcDraggableWidgetIds` —— 刀3 起取代编译期常量 `CC_EDIT_TOOLBAR_IDS`）、同一条
 * `[data-widget-id]` 选择器、同一份两层名单组装（`resolveCcHiddenWidgetIds`）。
 * ★ jsdom 无布局（getBoundingClientRect 恒零矩形，见 `createCcDragController.test.ts`）⇒
 *   「量得到」的测试判据 = 节点存在且非 `display:none`；真实几何由实机验收覆盖（施工单 §五 实机项）。
 * ★ #266 CC-13 刀3：补**插件件正控** —— 登记的插件件同样要进障碍集、同样要量得到
 *   （障碍集口径跟随派生名单，见 `createCcDragController.CcDragPorts.draggableIds`）。
 */
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { createSignal, onCleanup } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../../../../domains/theme/themeDefaults.ts'
import { CC_FLOATING_WIDGET_IDS, resolveCcHiddenWidgetIds } from '../../../../domains/cc/widgetDefinitions.ts'
import { resolveCcDraggableWidgetIds, resolveCcWidgetRoster } from '../../../../domains/cc/ccWidgetRoster.ts'
import { createPreviewWorkbenchServices } from '../../preview/previewWorkbenchServices.ts'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from '../../SolidWorkbenchContext.solid.tsx'
import { SolidControlCenter } from '../ControlCenter.solid.tsx'
import { getCcWidgetRegistry } from '../../../../plugin-runtime/runtimeServices.ts'
import { activateTestBuiltinPlugin } from '../../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../../../plugin-runtime/pluginIdentity.ts'
import { deactivatePluginInstance, type PluginInstance } from '../../../../plugin-runtime/pluginInstance.ts'
import type { ThemeSettings } from '../../../../domains/theme/themeTypes.ts'

const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []
const instances: PluginInstance[] = []

afterEach(async () => {
  cleanup()
  while (instances.length > 0) await deactivatePluginInstance(instances.pop()!)
  for (const services of servicesList.splice(0)) services.destroy()
})

/** 与 ControlCenter.solid.test.tsx 同款 mount 手法（直接挂载 + 预览服务）。 */
function renderControlCenter(sessionId: string | null) {
  const services = createPreviewWorkbenchServices()
  services.runtime.update({ generating: false })
  services.appearance.setTheme(structuredClone(DEFAULTS))
  servicesList.push(services)
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const input = () => ({ sheetId: 'sheet-guard', sessionId, preview: sessionId !== null })
  const context: SolidWorkbenchContextValue = {
    input,
    runtime: services.runtime,
    runtimeSnapshot,
    appearance: services.appearance,
    appearanceSnapshot,
    sessionUi: services.sessionUi,
    commands: services.commands,
    paused: () => false,
  }
  render(() => {
    const unsubscribeRuntime = services.runtime.subscribe(() => setRuntimeSnapshot(services.runtime.getSnapshot()))
    const unsubscribeAppearance = services.appearance.subscribe(() => setAppearanceSnapshot(services.appearance.getSnapshot()))
    onCleanup(() => {
      unsubscribeRuntime()
      unsubscribeAppearance()
    })
    return (
      <SolidWorkbenchContext.Provider value={context}>
        <SolidControlCenter />
      </SolidWorkbenchContext.Provider>
    )
  })
  return { services }
}

/** 名单侧同源：与 ControlCenter 的 `hiddenWidgetIdsFor` 调同一个组装函数。 */
function hiddenIdsOf(services: ReturnType<typeof createPreviewWorkbenchServices>, isEmpty: boolean): string[] {
  const snapshot = services.appearance.getSnapshot()
  return resolveCcHiddenWidgetIds({
    ccHidden: snapshot.ccHidden,
    ccHiddenEmpty: snapshot.ccHiddenEmpty,
    isEmpty,
    cliHintMode: snapshot.cliHintMode,
  })
}

/** 障碍集同源：与 ControlCenter 的 `ccDraggableIds` 调同一个派生（活名单 → 可拖件 id 序）。 */
function draggableIdsOf(): string[] {
  return resolveCcDraggableWidgetIds(resolveCcWidgetRoster(getCcWidgetRegistry().getSnapshot().entries))
}

/** 登记一个测试插件件（host-renderer，渲染体借用内置 tokens 那一行）。 */
async function registerPluginWidget(id: string): Promise<void> {
  instances.push(await activateTestBuiltinPlugin(createPluginIdentity('test.cc-guard', 'root'), ({ ccWidget }) => {
    ccWidget.registerWidget({ id, label: '守卫星', render: { kind: 'host-renderer', rendererKey: 'tokens' } })
  }))
}

/**
 * 守卫本体（测试层复刻 `measureWidgetBox` 的取件 + 「量不到」判定）：
 * 差集 = 可见集（全集 − 名单 − 悬浮件）里节点缺席或被 `display:none` 藏掉的元件。
 * 返回 [] = 守卫绿；非空 = 守卫红（名单可见却量不到，正是要响亮报警的缺口）。
 */
function unmeasurableIds(root: ParentNode, hiddenIds: readonly string[]): string[] {
  return draggableIdsOf()
    .filter(id => !hiddenIds.includes(id) && !CC_FLOATING_WIDGET_IDS.includes(id))
    .filter(id => {
      const el = root.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)
      if (!el) return true
      return el.style.display === 'none' || getComputedStyle(el).display === 'none'
    })
}

describe('CC-27 障碍集报警守卫：可见名单 ⊆ 量得到盒子', () => {
  it('常态：可见集全部量得到（无差集）', () => {
    const { services } = renderControlCenter('session-a')
    const root = document.querySelector<HTMLElement>('.control-center')!
    expect(unmeasurableIds(root, hiddenIdsOf(services, false))).toEqual([])
  })

  it('空态：可见集全部量得到（无差集）', () => {
    const { services } = renderControlCenter(null)
    const root = document.querySelector<HTMLElement>('.control-center')!
    expect(unmeasurableIds(root, hiddenIdsOf(services, true))).toEqual([])
  })

  it('暗道场景：名单放出 tokens 后注入 display:none ⇒ 守卫必须红（抓到 tokens）', async () => {
    const { services } = renderControlCenter(null)
    // 复刻被删暗道的现场：用户把 tokens 从「空态再藏」放出 ⇒ 名单说它可见；
    const theme = structuredClone(DEFAULTS) as ThemeSettings
    theme.ccHiddenEmpty = theme.ccHiddenEmpty.filter(id => id !== 'tokens')
    services.appearance.setTheme(theme)
    // CSS 暗道（display:none 写死）仍把它藏掉 —— 模拟注入：
    await waitFor(() => {
      const tokens = document.querySelector<HTMLElement>('[data-widget-id="tokens"]')
      expect(tokens).toBeTruthy()
      tokens!.style.display = 'none'
    })
    const root = document.querySelector<HTMLElement>('.control-center')!
    // 守卫必须红：差集非空、且指名 tokens —— 而不是静默丢出障碍集。
    expect(unmeasurableIds(root, hiddenIdsOf(services, true))).toContain('tokens')
  })

  // ★ #266 CC-13 刀3：**插件件正控** —— 障碍集口径跟随派生名单之后，插件件同样受守卫覆盖。
  it('插件件正控：登记的插件件进障碍集，且量得到（无差集）', async () => {
    const { services } = renderControlCenter('session-a')
    await registerPluginWidget('test.cc-guard-alpha')
    await waitFor(() => expect(document.querySelector('[data-widget-id="test.cc-guard-alpha"]')).toBeTruthy())

    const root = document.querySelector<HTMLElement>('.control-center')!
    // ① 进障碍集：派生的可拖件序里出现它（与生产拖拽守卫同一份名单）
    expect(draggableIdsOf()).toContain('test.cc-guard-alpha')
    // ② 量得到：节点在场、可见 ⇒ 守卫无差集
    expect(unmeasurableIds(root, hiddenIdsOf(services, false))).toEqual([])
  })

  it('插件件暗道：给它注入 display:none ⇒ 守卫必须红（抓到该插件件）', async () => {
    const { services } = renderControlCenter('session-a')
    await registerPluginWidget('test.cc-guard-beta')
    await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-widget-id="test.cc-guard-beta"]')
      expect(node).toBeTruthy()
      node!.style.display = 'none'
    })
    const root = document.querySelector<HTMLElement>('.control-center')!
    expect(unmeasurableIds(root, hiddenIdsOf(services, false))).toContain('test.cc-guard-beta')
  })
})
