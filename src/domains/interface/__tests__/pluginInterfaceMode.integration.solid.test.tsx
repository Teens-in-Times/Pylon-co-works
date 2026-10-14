// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 pluginInterfaceMode.integration.test.tsx，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library；render(() => <X/>) 传函数；既有 afterEach 追加显式 cleanup()。
// - 断言集不缩减（选择器激活、隔离表面挂载、host:input 广播、原子注销回退逐条保留）。
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { activateInterfaceMode, ensureInterfaceModeProfile } from '../../../application/transactions/activateInterfaceMode.ts'
import InterfaceModePicker from '../../../components/settings/InterfaceModePicker.solid.tsx'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { getInterfaceModeRegistry, getPluginUiRegistry, getPresentationProfileRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import AgentSheetView from '../../../sheets/AgentSheetView.solid.tsx'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes.ts'
import { usePresentationPreferenceStore } from '../../presentation/presentationPreferenceStore.ts'
import { useInterfaceModeStore } from '../interfaceModeStore.ts'

const registrations: AsyncDisposable[] = []
const ctx: SheetContext = {
  openSheet: () => 'x', focusSheet() {}, closeSheet() {},
  activeSession: 'session-1', selectSession() {}, openProfileEdit() {}, openSessionSettings() {},
  sidebarCollapsed: false, rightInset: 0,
  sessionSource: () => 'local:s1', sessionBySource: () => undefined,
}
const sheet: SheetRecord = {
  id: 'agent-sheet', kind: 'agent', title: 'Peri', agentId: 'peri',
  createdAt: 1, lastFocusedAt: 1, state: { sidebarMode: 'chat' },
}

describe('plugin Interface Mode integration', () => {
  beforeEach(() => {
    localStorage.clear()
    useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
    usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)
  })

  afterEach(async () => {
    cleanup()
    while (registrations.length > 0) await registrations.pop()?.dispose()
    ensureInterfaceModeProfile()
  })

  it('第三种模式进入设置选择器并挂载隔离 Agent workbench；卸载后回退默认模式', async () => {
    const owner = createPluginIdentity('example.focus', 'integration')
    registrations.push(getPluginUiRegistry().register(owner, {
      id: 'example.focus.workbench',
      reactVersion: '19',
      mount(container, bridge) {
        const title = document.createElement('strong')
        title.textContent = 'FOCUS WORKBENCH'
        const input = document.createElement('pre')
        input.dataset.testid = 'focus-input'
        container.append(title, input)
        const off = bridge.on('host:input', value => { input.textContent = JSON.stringify(value) })
        return () => { off(); container.replaceChildren() }
      },
    }))
    registrations.push(getPresentationProfileRegistry().register(owner, {
      id: 'example.presentation.focus', label: 'Focus', family: 'custom', interfaceMode: 'example.focus',
      // ★ #266 刀9：原样本含 `inputVariant: 'composer'` —— 该字段已删除，不再是合法 token
      tokens: { msgStyle: 'bubble' },
    }))
    const modeRegistration = getInterfaceModeRegistry().register(owner, {
      id: 'example.focus', label: 'Focus Mode', description: 'Plugin-owned complete workbench',
      icon: 'focus', order: 300, defaultPresentationProfileId: 'example.presentation.focus',
      quickSwitchTargetId: 'modern-gui', chromeStyle: 'icons',
      workbench: { renderKind: 'isolated-surface', surfaceId: 'example.focus.workbench' },
    })
    registrations.push(modeRegistration)

    render(() => <InterfaceModePicker />)
    const profileBefore = usePresentationPreferenceStore.getState().activeProfileId
    fireEvent.click(screen.getByRole('radio', { name: /Focus Mode/ }))
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('example.focus')
    // ★ #607 刀3a：第三方模式没有隐藏默认单（不在 MODE_DEFAULT_REFERENCES）⇒ 切换回落整份
    //   DEFAULTS，且不再挑它声明的档案 ⇒ `activeProfileId` 保持原值（取不到身份就不写）。
    //   「注册表 + 插件档案 API 保留」的口径不变（拍板：只退役宿主的私路用法）。
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe(profileBefore)

    const view = render(() => <AgentSheetView sheet={sheet} ctx={ctx} />)
    await waitFor(() => expect(screen.getByText('FOCUS WORKBENCH')).toBeTruthy())
    expect(view.container.querySelector('[data-plugin-ui-surface="example.focus.workbench"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByTestId('focus-input').textContent).toContain('"modeId":"example.focus"'))
    expect(screen.getByTestId('focus-input').textContent).toContain('"activeSessionId":"session-1"')

    view.unmount()
    // 生产插件卸载是原子注销（全部 contribution 一起）；测试须以同序模拟——
    // 若只 dispose mode 而 profile/surface 残留，validateRendererSuiteReferences 会正确拒绝
    // 激活（A17 cross-reference guard），默认模式回退被中间态卡死。
    await registrations.pop()?.dispose() // example.focus.workbench surface
    await registrations.pop()?.dispose() // example.presentation.focus profile
    await modeRegistration.dispose()
    registrations.length = 0 // afterEach 不再重复 dispose 已清理项
    expect(ensureInterfaceModeProfile()).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
  })

  it('缺少声明的 Surface 时拒绝激活，不污染当前模式', () => {
    const owner = createPluginIdentity('example.broken-mode', 'integration')
    registrations.push(getPresentationProfileRegistry().register(owner, {
      id: 'example.presentation.broken', label: 'Broken', family: 'custom', interfaceMode: 'example.broken-mode', tokens: {},
    }))
    registrations.push(getInterfaceModeRegistry().register(owner, {
      id: 'example.broken-mode', label: 'Broken', defaultPresentationProfileId: 'example.presentation.broken',
      chromeStyle: 'icons', workbench: { renderKind: 'isolated-surface', surfaceId: 'example.missing' },
    }))
    expect(activateInterfaceMode('example.broken-mode')).toBe(false)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
  })
})
