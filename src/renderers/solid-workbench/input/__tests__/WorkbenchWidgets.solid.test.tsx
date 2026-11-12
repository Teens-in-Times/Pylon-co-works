// @vitest-environment jsdom
import { createSignal, onCleanup, type JSX } from 'solid-js'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../../domains/theme/themeDefaults.ts'
import { createWorkbenchDocument } from '../../../../domains/workbench/workbenchProjector.ts'
import { normalizeSessionConfigOptions } from '../../../../domains/workbench/session/sessionSurface.ts'
import { createPreviewWorkbenchServices } from '../../preview/previewWorkbenchServices.ts'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from '../../SolidWorkbenchContext.solid.tsx'
import type { SolidWorkbenchInput } from '../../workbenchContracts.ts'
import { SolidCcSendButton, SolidModeWidget, SolidModelWidget, SolidReasoningWidget } from '../WorkbenchWidgets.solid.tsx'

const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
})

function renderWidget(view: () => JSX.Element, themePatch: Partial<typeof DEFAULTS> = {}, inputPatch: Partial<SolidWorkbenchInput> = {}) {
  const services = createPreviewWorkbenchServices()
  services.runtime.update({ generating: false })
  const theme = structuredClone(DEFAULTS)
  services.appearance.setTheme({ ...theme, ...themePatch })
  servicesList.push(services)
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const context: SolidWorkbenchContextValue = {
    input: () => ({ sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, ...inputPatch }),
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
    });
    return <SolidWorkbenchContext.Provider value={context}>{view()}</SolidWorkbenchContext.Provider>
  })
  return services
}

describe('Solid Workbench widgets', () => {
  it('shows an understandable unavailable-model state without exposing an internal sentinel', () => {
    const services = renderWidget(() => <SolidModelWidget />)
    services.runtime.replaceDocument(createWorkbenchDocument('preview-session'))
    services.runtime.update({ availableModels: [], activeModel: '' })
    const trigger = screen.getByRole('button', { name: '未提供模型' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('title', '该 Agent 未提供模型选项')
    expect(services.commands.calls).toHaveLength(0)
  })

  it('switching model variants closes stale menus and preserves the dropdown interaction', async () => {
    const services = renderWidget(() => <SolidModelWidget />, { modelSwitchMode: 'menu' })
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-flash/ }))
    expect(screen.getAllByRole('listbox')).toHaveLength(1)
    services.appearance.setTheme({ ...structuredClone(DEFAULTS), modelSwitchMode: 'cycle' })
    expect(screen.queryByRole('listbox')).toBeNull()
    services.appearance.setTheme({ ...structuredClone(DEFAULTS), modelSwitchMode: 'cycle' })
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    await waitFor(() => expect(services.commands.calls).toHaveLength(1))
    // calls 记录先于 setModel 续体收敛；pending 未落时触发钮显示切换状态，
    // 先等它回到模型名（fake setModel 不改 activeModel，收敛后仍是 flash）。
    await waitFor(() => expect(screen.getByRole('button', { name: 'deepseek-v4-flash' })).toBeTruthy())
    services.appearance.setTheme({ ...structuredClone(DEFAULTS), modelSwitchMode: 'menu' })
    const trigger = screen.getByRole('button', { name: /deepseek-v4-flash/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('listbox')).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('live reasoning sends the advertised config id and renders only confirmed values', async () => {
    const services = renderWidget(() => <SolidReasoningWidget />, { reasoningSwitchMode: 'menu' })
    const publish = (value: string) => {
      const document = createWorkbenchDocument('preview-session')
      services.runtime.replaceDocument({ ...document, session: { ...document.session,
        options: normalizeSessionConfigOptions([{ id: 'reasoning_effort', type: 'select',
          currentValue: value, category: 'thought_level', options: [{ value: 'low' }, { value: 'high' }], version: 7 }]),
      } })
    }
    publish('low')
    services.commands.setHandler('setConfigOption', async () => { publish('high'); return { ok: true } })
    fireEvent.click(screen.getByRole('button', { name: '轻量思考' }))
    expect(screen.queryByRole('option', { name: '极高强度' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: '深入思考' }))
    await waitFor(() => expect(services.commands.calls[0]?.args).toEqual([
      'preview-session', 'reasoning_effort', 'high', { expectedValue: 'low', expectedVersion: 7 },
    ]))
    // 同上：calls 记录 ≠ setConfigOption 续体已跑完；等 pending 落下、触发钮显示 'high'。
    await waitFor(() => expect(screen.getByRole('button', { name: '深入思考' })).toBeTruthy())
    services.commands.setHandler('setConfigOption', async () => ({ ok: false, error: 'reasoning denied' }))
    fireEvent.click(screen.getByRole('button', { name: '深入思考' }))
    fireEvent.click(screen.getByRole('option', { name: '轻量思考' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('reasoning denied')
    expect(screen.getByRole('button', { name: '深入思考' })).toBeTruthy()
    services.runtime.replaceDocument(createWorkbenchDocument('preview-session'))
    expect(screen.queryByRole('button', { name: '深入思考' })).toBeNull()
  })

  // 写入用的键必须来自 catalog 的 kind 解析，不能写死：provider 给这一项起的 id 不
  // 一定是 reasoning_effort（peri 用的是 thinking_effort），写死会让 setConfigOption
  // 的守卫在发请求之前就拒掉，且报一个与真实原因无关的 config_option_not_found。
  it('reasoning writes the id the catalogue resolved, not a hardcoded one', async () => {
    const services = renderWidget(() => <SolidReasoningWidget />, { reasoningSwitchMode: 'menu' })
    const document = createWorkbenchDocument('preview-session')
    services.runtime.replaceDocument({ ...document, session: { ...document.session,
      options: normalizeSessionConfigOptions([{ id: 'thinking_effort', name: 'Thinking Effort', type: 'select',
        currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }]),
    } })
    services.commands.setHandler('setConfigOption', async () => ({ ok: true }))
    fireEvent.click(screen.getByRole('button', { name: '标准思考' }))
    fireEvent.click(screen.getByRole('option', { name: '深入思考' }))
    await waitFor(() => expect(services.commands.calls[0]?.args).toEqual([
      'preview-session', 'thinking_effort', 'high', { expectedValue: 'medium' },
    ]))
    services.destroy()
  })

  it('Model dropdown 枚举 runtime models，并经 facade 切换', async () => {
    const services = renderWidget(() => <SolidModelWidget />, { modelSwitchMode: 'menu' })
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-flash/ }))
    expect(screen.getByRole('listbox', { name: '模型列表' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-v4-pro' }))

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('setModel'))
    expect(services.commands.calls[0]?.args).toEqual(['preview-session', 'deepseek-v4-pro'])
  })

  it.each(['modern-gui', 'terminal-like'])('%s 选择器键盘聚焦当前项、方向/首尾导航、Escape 回焦', async mode => {
    renderWidget(() => <div class="app" data-interface-mode={mode}><SolidModelWidget /></div>)
    const trigger = screen.getByRole('button', { name: 'deepseek-v4-flash' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const current = screen.getByRole('option', { name: 'deepseek-v4-flash' })
    const next = screen.getByRole('option', { name: 'deepseek-v4-pro' })
    await waitFor(() => expect(current).toHaveFocus())
    fireEvent.keyDown(current, { key: 'ArrowDown' })
    expect(next).toHaveFocus()
    fireEvent.keyDown(next, { key: 'Home' })
    expect(current).toHaveFocus()
    fireEvent.keyDown(current, { key: 'End' })
    expect(next).toHaveFocus()
    fireEvent.keyDown(next, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('空态即使 preset 是 minimal/badge 也强制提供模型与思考等级下拉', async () => {
    const services = renderWidget(
      () => <SolidModelWidget
        forceDropdown
        draftValue={() => 'deepseek-v4-flash'}
        onDraftChange={() => {}}
      />,
      { modelSwitchMode: 'cycle' },
    )
    const trigger = screen.getByRole('button', { name: /deepseek-v4-flash/ })
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'deepseek-v4-pro' })).toBeTruthy()
    services.destroy()
  })

  it('空态 draft 候选 = 所属 agent 宣告集合，不回落硬编码兜底（issue #53）', async () => {
    const services = renderWidget(
      () => <SolidModelWidget
        forceDropdown
        draftValue={() => 'kimi-k2'}
        onDraftChange={() => {}}
      />,
      { modelSwitchMode: 'menu' },
      { sessionId: null, agentAdvertisedModels: [{ id: 'kimi-k2', label: 'Kimi K2' }, { id: 'glm-5', label: 'GLM · 5' }] },
    )
    services.runtime.update({ availableModels: [], activeModel: '' })
    const trigger = await screen.findByRole('button', { name: 'Kimi K2' })
    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'Kimi K2' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'GLM · 5' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'deepseek-v4-flash' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'deepseek-v4-pro' })).toBeNull()
    services.destroy()
  })

  it('空态无任何宣告数据时仅保留当前草稿值，不伪造候选（issue #53 A4）', async () => {
    const services = renderWidget(
      () => <SolidModelWidget
        forceDropdown
        draftValue={() => 'my-default-model'}
        onDraftChange={() => {}}
      />,
      { modelSwitchMode: 'menu' },
      { sessionId: null, agentAdvertisedModels: [] },
    )
    services.runtime.update({ availableModels: [], activeModel: '' })
    fireEvent.click(await screen.findByRole('button', { name: /my-default-model/ }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: 'my-default-model' })).toHaveAttribute('aria-selected', 'true')
    services.destroy()
  })

  it('选择当前模型只收起菜单并还焦点，不发送重复切换', async () => {
    const change = vi.fn()
    const services = renderWidget(
      () => <SolidModelWidget
        forceDropdown
        draftValue={() => 'my-default-model'}
        onDraftChange={change}
      />,
      { modelSwitchMode: 'menu' },
      { sessionId: null, agentAdvertisedModels: [] },
    )
    services.runtime.update({ availableModels: [], activeModel: '' })
    const trigger = await screen.findByRole('button', { name: /my-default-model/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'my-default-model' }))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(change).not.toHaveBeenCalled()
    expect(services.commands.calls).toHaveLength(0)
    services.destroy()
  })

  it('有会话时不并入 agent 宣告集合，协商快照保持权威（issue #53 A2）', async () => {
    renderWidget(
      () => <SolidModelWidget />,
      { modelSwitchMode: 'menu' },
      { agentAdvertisedModels: [{ id: 'kimi-k2', label: 'Kimi K2' }] },
    )
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-flash/ }))
    expect(screen.getByRole('option', { name: 'deepseek-v4-pro' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Kimi K2' })).toBeNull()
  })

  it('模型/模式弹层支持 Escape 与外部点击关闭，并把焦点还给触发器', async () => {
    renderWidget(() => <div>
      <SolidModelWidget forceDropdown draftValue={() => 'deepseek-v4-flash'} onDraftChange={() => {}} />
      <SolidModeWidget forceDropdown draftValue={() => 'auto'} onDraftChange={() => {}} />
    </div>);

    const modelTrigger = screen.getByRole('button', { name: /deepseek-v4-flash/ })
    fireEvent.click(modelTrigger)
    const modelMenu = screen.getByRole('listbox', { name: '模型列表' })
    expect(modelMenu).toHaveAttribute('data-popover', 'control-center')
    fireEvent.keyDown(modelMenu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox', { name: '模型列表' })).toBeNull())
    expect(modelTrigger).toHaveFocus()

    fireEvent.click(modelTrigger)
    expect(screen.getByRole('listbox', { name: '模型列表' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByRole('listbox', { name: '模型列表' })).toBeNull())

    const modeTrigger = screen.getByRole('button', { name: '自动执行' })
    fireEvent.click(modeTrigger)
    const modeMenu = screen.getByRole('listbox', { name: '权限模式选项' })
    expect(modeMenu).toHaveAttribute('data-popover', 'control-center')
    fireEvent.keyDown(modeMenu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox', { name: '权限模式选项' })).toBeNull())
    expect(modeTrigger).toHaveFocus()
  })


  it('reasoning widget renders menu, filters current value, and cycles', async () => {
    const services = renderWidget(() => <SolidReasoningWidget />, { reasoningSwitchMode: 'menu' })
    const trigger = screen.getByRole('button', { name: '关闭思考' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('listbox', { name: '思考强度选项' })
    expect(menu).toBeTruthy()
    expect(screen.getByRole('option', { name: '关闭思考' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
    services.appearance.setTheme({ ...structuredClone(DEFAULTS), reasoningSwitchMode: 'cycle' })
    fireEvent.click(trigger)
    await waitFor(() => expect(services.commands.calls.length).toBeGreaterThan(0))
  })
  it('切换中按钮显示进度且不重复发命令', async () => {
    const services = renderWidget(() => <SolidReasoningWidget />, { reasoningSwitchMode: 'menu' })
    const publish = (value: string) => {
      const document = createWorkbenchDocument('preview-session')
      services.runtime.replaceDocument({ ...document, session: { ...document.session,
        options: normalizeSessionConfigOptions([{ id: 'reasoning_effort', type: 'select',
          currentValue: value, category: 'thought_level', options: [{ value: 'low' }, { value: 'high' }], version: 7 }]),
      } })
    }
    publish('low')
    let release: (result: { ok: boolean }) => void = () => {}
    services.commands.setHandler('setConfigOption', () => new Promise(resolve => { release = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '轻量思考' }))
    fireEvent.click(screen.getByRole('option', { name: '深入思考' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '切换中…' })).toBeTruthy())
    fireEvent.click(screen.getByRole('option', { name: '深入思考' }))
    expect(services.commands.calls).toHaveLength(1)
    release({ ok: true })
    await waitFor(() => expect(screen.getByRole('button', { name: '轻量思考' })).toBeTruthy())
  })

  it('空会话草稿态走 onDraftChange 且不发命令', () => {
    const drafts: string[] = []
    const services = renderWidget(
      () => <SolidReasoningWidget draftValue={() => 'low'} onDraftChange={value => drafts.push(value)} />,
      { reasoningSwitchMode: 'menu' },
      { sessionId: '' },
    )
    fireEvent.click(screen.getByRole('button', { name: '轻量思考' }))
    fireEvent.click(screen.getByRole('option', { name: '深入思考' }))
    expect(drafts).toEqual(['high'])
    expect(services.commands.calls).toHaveLength(0)
  })

  it('Model cycle 模式循环切换', async () => {
    const minimal = renderWidget(() => <SolidModelWidget />, { modelSwitchMode: 'cycle' })
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    await waitFor(() => expect(minimal.commands.calls[0]?.args).toEqual(['preview-session', 'deepseek-v4-pro']))
    cleanup()
    minimal.destroy()

    renderWidget(() => <SolidModelWidget />, { modelSwitchMode: 'cycle' })
    expect(screen.getByRole('button', { name: 'deepseek-v4-flash' })).toBeTruthy()
  })

  it('权限控件显示可读名称，点击仍提交原始 mode', async () => {
    const services = renderWidget(() => <SolidModeWidget />, { permissionSwitchMode: 'cycle' })
    const button = screen.getByRole('button', { name: '自动执行' })
    expect(button.className).toContain('cc-permission-trigger')
    expect(button.getAttribute('data-mode')).toBe('auto')
    expect(button.textContent).toBe('自动执行')
    // 定位定案：排在思考强度右边，中间留 12px（PERMISSION_GAP_PX）
    expect((button.closest('.solid-permission-widget') as HTMLElement).style.marginLeft).toBe('12px')
    fireEvent.click(button)

    await waitFor(() => expect(services.commands.calls[0]?.args).toEqual(['preview-session', 'bypass']))
  })

  it('权限控件：菜单显示可读标签及当前选择', async () => {
    renderWidget(() => <SolidModeWidget />, { permissionSwitchMode: 'menu' })
    fireEvent.click(screen.getByRole('button', { name: '自动执行' }))
    expect(screen.getByRole('listbox', { name: '权限模式选项' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '跳过确认' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '自动执行' })).toHaveAttribute('aria-selected', 'true')
  })

  it('权限控件保留自定义色供皮肤消费，留空仍由语义色接手', () => {
    renderWidget(() => <SolidModeWidget />, { permissionTextColor: '' })
    expect(screen.getByRole('button', { name: '自动执行' }).style.getPropertyValue('--cc-widget-color')).toBe('')
    cleanup()
    renderWidget(() => <SolidModeWidget />, { permissionTextColor: '#ffffff' })
    expect(screen.getByRole('button', { name: '自动执行' }).style.getPropertyValue('--cc-widget-color')).toBe('#ffffff')
  })

  it('空态 mode 下拉显示可读标签且提交原始值', async () => {
    const services = renderWidget(() => <SolidModeWidget
      forceDropdown
      draftValue={() => 'auto'}
      onDraftChange={value => services.runtime.update({ activeMode: value })}
    />)
    const trigger = screen.getByRole('button', { name: '自动执行' })
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox', { name: '权限模式选项' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '跳过确认' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '自动执行' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('option', { name: '跳过确认' }))
    await waitFor(() => expect(services.runtime.getSnapshot().activeMode).toBe('bypass'))
  })

  it('Model/Mode facade 失败显示可见错误', async () => {
    const services = renderWidget(() => <><SolidModelWidget /><SolidModeWidget /></>, {
      modelSwitchMode: 'cycle',
      permissionSwitchMode: 'cycle',
    })
    services.commands.setHandler('setModel', vi.fn(async () => ({ ok: false, error: 'model denied' })))
    services.commands.setHandler('setMode', vi.fn(async () => ({ ok: false, error: 'mode denied' })))

    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    fireEvent.click(screen.getByRole('button', { name: '自动执行' }))
    expect(await screen.findByText('model denied')).toBeTruthy()
    expect(await screen.findByText('mode denied')).toBeTruthy()
  })

  // #51：正文只放稳定短文案（稳定 code 映射/截 80 字符），完整后端原文留在浮层
  // title 供悬停查看。审查曾发现实现里 title 挂的是截短后的同一串，此用例钉住分工。
  it('切换失败时正文截短、title 保留完整后端原文', async () => {
    const services = renderWidget(() => <SolidModelWidget />, { modelSwitchMode: 'cycle' })
    const full = 'model_not_advertised: requested model "missing-model" is not in the agent-advertised choices [alpha-model, beta-model, gamma-model]'
    services.commands.setHandler('setModel', async () => ({ ok: false, error: full }))
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('模型未被该会话宣告，无法切换')
    expect(alert.getAttribute('title')).toBe(full)

    const raw = 'x'.repeat(200)
    services.commands.setHandler('setModel', async () => ({ ok: false, error: raw }))
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    const truncated = await screen.findByRole('alert')
    expect(truncated.textContent!.length).toBe(80)
    expect(truncated.getAttribute('title')).toBe(raw)
  })

  it('注册发送底层块复用发送/停止语义且支持禁用', async () => {
    const sendEvent = vi.fn()
    window.addEventListener('pylon:solid-input-send', sendEvent)
    const services = renderWidget(() => <SolidCcSendButton mode="inline" />)
    const button = screen.getByRole('button', { name: '发送消息' })
    fireEvent.click(button)
    expect(sendEvent).toHaveBeenCalledTimes(1)

    services.runtime.update({ generating: true })
    await waitFor(() => expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('cancel'))

    cleanup()
    const disabledServices = renderWidget(() => <SolidCcSendButton mode="external" disabled />)
    expect(screen.getByRole('button')).toBeDisabled()
    disabledServices.destroy()
    window.removeEventListener('pylon:solid-input-send', sendEvent)
  })
})


describe('#728 control request lifecycle', () => {
  it('reports a thrown model command as a recoverable error', async () => {
    const services = renderWidget(() => <SolidModelWidget />, { modelSwitchMode: 'menu' })
    services.commands.setHandler('setModel', async () => { throw new Error('model unavailable') })
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-v4-pro' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('model unavailable')
    expect(screen.getByRole('button', { name: 'deepseek-v4-flash' })).toBeEnabled()
  })

  it('does not close a new session menu or expose an earlier request error after switching away and back', async () => {
    const [sessionId, setSessionId] = createSignal('session-a')
    const services = renderWidget(() => <SolidModelWidget />, { modelSwitchMode: 'menu' }, { get sessionId() { return sessionId() } })
    let resolve!: (value: { ok: boolean; error: string }) => void
    services.commands.setHandler('setModel', () => new Promise(done => { resolve = done }))
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-v4-pro' }))
    setSessionId('session-b')
    setSessionId('session-a')
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    resolve({ ok: false, error: 'stale error' })
    await Promise.resolve()
    expect(screen.getByRole('listbox', { name: '模型列表' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a stop failure in the initiating session input state', async () => {
    const services = renderWidget(() => <SolidCcSendButton mode="inline" />)
    services.runtime.update({ generating: true })
    services.commands.setHandler('cancel', async () => { throw new Error('stop unavailable') })
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    await waitFor(() => expect(services.sessionUi.get('preview-session', 'input-error', '')).toBe('stop unavailable'))
  })
})
