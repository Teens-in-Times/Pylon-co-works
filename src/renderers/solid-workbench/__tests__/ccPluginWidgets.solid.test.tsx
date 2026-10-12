// @vitest-environment jsdom
/**
 * #266 CC-13 刀2 集成：**插件件上屏**（画面开闸）。
 *
 * 锁的是施工单 §6 的头三条：
 * 1. 登记即上屏（出现在状态区**末尾**，贴 DOM：`[data-widget-id]` 顺序）；撤下 ⇒ 消失；
 *    热替换（shadow）⇒ 渲染跟随；
 * 2. 默认排最后：两个插件件按**登记先后**（后登记在更下）；
 * 3. 冲突拒绝：插件登记内置 id ⇒ 该登记被拒 + 诊断，内置件不受影响。
 * 另加两条边界：渲染标识未命中 ⇒ 显式诊断占位；无插件登记 ⇒ 状态区不产任何额外 DOM。
 *
 * 挂载手法与 `mountSolidWorkbench.solid.test.tsx` 的 `mountPreview` 同款（预览服务 + 真 hostPort），
 * 差别只在 hostPort 带一个诊断收集器 —— 拒绝与未命中都要能被观测到。
 */
import { cleanup, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort, type RendererDiagnosticContext } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { activateTestBuiltinPlugin } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { deactivatePluginInstance, type PluginInstance } from '../../../plugin-runtime/pluginInstance.ts'
import { getCcWidgetRegistry } from '../../../plugin-runtime/runtimeServices.ts'
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
  const diagnostics: RendererDiagnosticContext[] = []
  const hostPort = createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-cc-plugin',
    sessionOwnerKey: 'owner-cc-plugin',
    sessionId: 'preview-session',
    diagnostics: diagnostic => { diagnostics.push(diagnostic) },
  })
  const lifecycle = mountSolidWorkbench({
    host,
    input: { sheetId: 'sheet-cc-plugin', sessionId: 'preview-session', preview: true, rightInset: 24, reducedMotion: true },
    services,
    hostPort,
  })
  return { host, services, lifecycle, diagnostics }
}

/** 状态区（`.cc-status-row`）内的件 id 顺序 —— "排在状态区末尾"的证据面。 */
function statusWidgetIds(host: HTMLElement): (string | null)[] {
  return [...host.querySelectorAll('.cc-status-row [data-widget-id]')].map(el => el.getAttribute('data-widget-id'))
}

/** 登记一批插件件（同一插件）。撤下走 `deactivatePluginInstance` 或 `afterEach` 兜底。 */
async function registerWidgets(widgets: readonly CcWidgetContribution[], pluginId = 'test.cc-plugin'): Promise<PluginInstance> {
  const instance = await activateTestBuiltinPlugin(createPluginIdentity(pluginId, 'root'), ({ ccWidget }) => {
    for (const widget of widgets) ccWidget.registerWidget(widget)
  })
  instances.push(instance)
  return instance
}

const BUILTIN_STATUS_IDS = ['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint']

describe('#266 CC-13 刀2 · 插件件上屏', () => {
  it('无插件登记：状态区不产任何额外 DOM（内置件零回归的基线）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    expect(statusWidgetIds(dom.host)).toEqual(BUILTIN_STATUS_IDS)
    expect(dom.host.querySelector('.cc-status-row > .cc-widget[data-widget-id]')).toBeNull()
  })

  it('登记即上屏：host-renderer 件画在状态区末尾（查刀1 组件表）；撤下 ⇒ 消失', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())

    const instance = await registerWidgets([{
      id: 'test.cc-alpha',
      label: '插件件甲',
      render: { kind: 'host-renderer', rendererKey: 'tokens' },
    }])

    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="test.cc-alpha"]')).not.toBeNull())
    // ★ 出现在状态区**末尾**（DOM 顺序 = 内置五件之后；最小包装 `.cc-widget` + `data-widget-id`）
    expect(statusWidgetIds(dom.host)).toEqual([...BUILTIN_STATUS_IDS, 'test.cc-alpha'])
    const wrapper = dom.host.querySelector('[data-widget-id="test.cc-alpha"]')!
    expect(wrapper).toHaveClass('cc-widget')
    expect(wrapper.parentElement).toHaveClass('cc-status-row')
    // rendererKey 命中的证据：画出来的是刀1 表里 tokens 那一行（用量胶囊）
    expect(wrapper.querySelector('.cc-usage-pill')).not.toBeNull()
    // 本刀插件件无位置内联样式、不参与拖动
    expect((wrapper as HTMLElement).style.transform).toBe('')
    expect((wrapper as HTMLElement).style.left).toBe('')

    await deactivatePluginInstance(instance)
    instances.splice(instances.indexOf(instance), 1)
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="test.cc-alpha"]')).toBeNull())
    expect(statusWidgetIds(dom.host)).toEqual(BUILTIN_STATUS_IDS)
  })

  it('默认排最后：登记先后 = 展示顺序（后登记在更下）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await registerWidgets([
      { id: 'test.cc-first', label: '先登记', render: { kind: 'host-renderer', rendererKey: 'tokens' } },
      { id: 'test.cc-later', label: '后登记', render: { kind: 'host-renderer', rendererKey: 'cc-command-hint' } },
    ])
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="test.cc-later"]')).not.toBeNull())
    expect(statusWidgetIds(dom.host)).toEqual([...BUILTIN_STATUS_IDS, 'test.cc-first', 'test.cc-later'])
  })

  it('热替换（shadow）：同一 id 换渲染体 ⇒ 渲染跟随（不整段消失）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())

    const registry = getCcWidgetRegistry()
    const owner = createPluginIdentity('test.cc-swap', 'root')
    const original = registry.register(owner, {
      id: 'test.cc-swap-widget',
      label: '替换前',
      render: { kind: 'host-renderer', rendererKey: 'tokens' },
    })
    try {
      await waitFor(() => expect(dom.host.querySelector('[data-widget-id="test.cc-swap-widget"] .cc-usage-pill')).not.toBeNull())

      const swapped = registry.beginShadowTransaction(createPluginIdentity('test.cc-swap', 'next'), owner.key)
      swapped.register({ id: 'test.cc-swap-widget', label: '替换后', render: { kind: 'host-renderer', rendererKey: 'mode' } }, { contributionId: 'test.cc-swap-widget' })
      const disposables = swapped.commit()
      try {
        // 渲染跟随：同 id 的件换成了 mode 那一行（权限控件），旧渲染体退出
        await waitFor(() => expect(dom.host.querySelector('[data-widget-id="test.cc-swap-widget"] .solid-permission-widget')).not.toBeNull())
        expect(dom.host.querySelector('[data-widget-id="test.cc-swap-widget"] .cc-usage-pill')).toBeNull()
        expect(statusWidgetIds(dom.host)).toEqual([...BUILTIN_STATUS_IDS, 'test.cc-swap-widget'])
      } finally {
        for (const disposable of disposables) await disposable.dispose()
      }
    } finally {
      await original.dispose()
    }
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="test.cc-swap-widget"]')).toBeNull())
  })

  it('冲突拒绝：插件登记内置 id ⇒ 该登记被拒 + 诊断（贴输出），内置件不受影响', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await registerWidgets([{ id: 'input', label: '假输入栏', render: { kind: 'host-renderer', rendererKey: 'tokens' } }])

    await waitFor(() => expect(dom.diagnostics.some(item => item.code === 'cc-widget.roster.rejected')).toBe(true))
    const rejection = dom.diagnostics.find(item => item.code === 'cc-widget.roster.rejected')!
    expect(rejection.message).toContain('input')
    expect(rejection.message).toContain('test.cc-plugin')
    // 内置件不受影响：状态区名单不变，输入栏仍只有一个（在输入槽里）
    expect(statusWidgetIds(dom.host)).toEqual(BUILTIN_STATUS_IDS)
    expect(dom.host.querySelectorAll('[data-widget-id="input"]')).toHaveLength(1)
    expect(dom.host.querySelector('.cc-input-slot [data-widget-id="input"]')).not.toBeNull()
  })

  it('渲染标识未命中 ⇒ 显式诊断占位（不静默画空白）', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await registerWidgets([{ id: 'test.cc-no-renderer', label: '查不到渲染器', render: { kind: 'host-renderer', rendererKey: 'test.not-registered' } }])

    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="test.cc-no-renderer"]')).not.toBeNull())
    const placeholder = dom.host.querySelector('[data-widget-id="test.cc-no-renderer"] [role="alert"]')!
    expect(placeholder.textContent).toContain('test.not-registered')
    await waitFor(() => expect(dom.diagnostics.some(item => item.code === 'cc-widget.renderer.missing')).toBe(true))
    expect(dom.diagnostics.find(item => item.code === 'cc-widget.renderer.missing')!.message).toContain('test.not-registered')
  })
})
