// @vitest-environment jsdom
/**
 * #266 CC-13 刀4（小活①）集成：**插件件的显隐真的生效**（读侧过滤）。
 *
 * 刀3 让插件件进了编辑列（行内两个开关随之出现），开关会**写** `ccHidden` / `ccHiddenEmpty`，
 * 但渲染侧没有读 ⇒ 点了看起来没反应（刀3 验收报告 §六）。本刀补读侧过滤，锁三件事：
 * 1. **主管表**：勾「隐藏」⇒ 插件件从 DOM 消失；取消 ⇒ 回来；
 * 2. **空态再藏**：常态下不动它；切到空态（无会话）才生效 —— 与内置件同一份门（`hasNoSession`）；
 * 3. **两态规则与内置件同源**：读的是 `resolveCcHiddenWidgetIds` 的合并结果（空态 ⊇ 常态）。
 */
import { cleanup, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { activateTestBuiltinPlugin } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { deactivatePluginInstance, type PluginInstance } from '../../../plugin-runtime/pluginInstance.ts'

const WIDGET = 'test.cc-visibility-alpha'

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
  const hostPort = createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-cc-visibility',
    sessionOwnerKey: 'owner-cc-visibility',
    sessionId: 'preview-session',
    diagnostics: () => {},
  })
  const lifecycle = mountSolidWorkbench({
    host,
    input: { sheetId: 'sheet-cc-visibility', sessionId, preview: true, rightInset: 24, reducedMotion: true },
    services,
    hostPort,
  })
  return { host, services, lifecycle }
}

const widgetIn = (host: HTMLElement) => host.querySelector(`[data-widget-id="${WIDGET}"]`)

async function installWidget(): Promise<PluginInstance> {
  const instance = await activateTestBuiltinPlugin(createPluginIdentity('test.cc-visibility', 'root'), ({ ccWidget }) => {
    ccWidget.registerWidget({ id: WIDGET, label: '隐显件', render: { kind: 'host-renderer', rendererKey: 'tokens' } })
  })
  instances.push(instance)
  return instance
}

describe('#266 CC-13 刀4 · 插件件的显隐读侧', () => {
  it('主管表：勾「隐藏」⇒ 插件件从 DOM 消失；取消 ⇒ 回来（内置件同款口径）', async () => {
    const dom = mountWorkbench('preview-session')
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await installWidget()
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())

    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: WIDGET, hidden: true, target: 'base' })
    await waitFor(() => expect(widgetIn(dom.host)).toBeNull())
    // 只藏它自己：内置件不受影响
    expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull()

    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: WIDGET, hidden: false, target: 'base' })
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())
  })

  it('空态再藏：**只在空态生效**（常态不动它；切到无会话才消失；回会话即回来）', async () => {
    const dom = mountWorkbench('preview-session')
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await installWidget()
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())

    // 只写「空态再藏」那一份表 ⇒ 常态下它照旧在场
    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: WIDGET, hidden: true, target: 'empty' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(widgetIn(dom.host)).not.toBeNull()

    // 切到空态（无会话）⇒ 门开，再藏生效
    dom.lifecycle.update({ sheetId: 'sheet-cc-visibility', sessionId: null, rightInset: 24, reducedMotion: true })
    await waitFor(() => expect(widgetIn(dom.host)).toBeNull())

    // 回会话 ⇒ 再藏随之失效（它与内置件读的是同一份合并名单）
    dom.lifecycle.update({ sheetId: 'sheet-cc-visibility', sessionId: 'preview-session', rightInset: 24, reducedMotion: true })
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())
  })

  it('空态里藏（主管表）在两种门态都生效；两条开关各写各的表，不互相抵消', async () => {
    const dom = mountWorkbench(null)
    await waitFor(() => expect(dom.host.querySelector('.control-center')).not.toBeNull())
    await installWidget()
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())

    // 空态下用**主管表**藏 ⇒ 空态消失
    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: WIDGET, hidden: true, target: 'base' })
    await waitFor(() => expect(widgetIn(dom.host)).toBeNull())
    // 开会话 ⇒ 主管表两种门态都生效 ⇒ 仍然不出现（不是"空态才藏"）
    dom.lifecycle.update({ sheetId: 'sheet-cc-visibility', sessionId: 'preview-session', rightInset: 24, reducedMotion: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(widgetIn(dom.host)).toBeNull()
    // 主管表放开 ⇒ 回来
    dom.services.appearance.dispatch({ type: 'set-cc-hidden', id: WIDGET, hidden: false, target: 'base' })
    await waitFor(() => expect(widgetIn(dom.host)).not.toBeNull())
  })
})
