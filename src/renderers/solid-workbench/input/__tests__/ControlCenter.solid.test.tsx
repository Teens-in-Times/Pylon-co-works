// @vitest-environment jsdom
/**
 * #520 S3-C：SolidControlCenter **直接挂载**测试 —— 此前只有经
 * settingsPreviewControlCenter 预览包装的间接覆盖（该路只锁 DOM 形状，
 * 不锁交互）。先锁行为，再做 C 域拆分（createCcDragController / createCcSources），
 * 拆分在本文件保护下进行。
 *
 * 覆盖：基本渲染（空态/会话态）、空态创建会话提交路径（成功/失败）、
 * 编辑态拖拽提交路径（阈值内/越阈值）、Escape 键盘路径；
 * 空态工作区绑定模型（预选 / 侧栏意图）由 mountSolidWorkbench.solid.test.tsx 锁。
 */
import { createSignal, onCleanup } from 'solid-js'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../../../../domains/theme/themeDefaults.ts'
import { createPreviewWorkbenchServices } from '../../preview/previewWorkbenchServices.ts'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from '../../SolidWorkbenchContext.solid.tsx'
import { SolidControlCenter } from '../ControlCenter.solid.tsx'

const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
})

/** ControlCenter 与 InputBar 不同：空态（sessionId null）是它的一等公民路径。 */
function renderControlCenter(sessionId: string | null) {
  const services = createPreviewWorkbenchServices()
  services.runtime.update({ generating: false })
  services.appearance.setTheme(structuredClone(DEFAULTS))
  servicesList.push(services)
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const input = () => ({ sheetId: 'sheet-c', sessionId, preview: sessionId !== null })
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

/** jsdom 无 PointerEvent；Solid 的 onPointerDown 走委托，冒泡 MouseEvent 即可命中。 */
function firePointerDown(element: Element, clientX: number, clientY: number) {
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY }))
}
function fireWindowPointer(type: 'pointermove' | 'pointerup', clientX: number, clientY: number) {
  window.dispatchEvent(new MouseEvent(type, { clientX, clientY }))
}

describe('SolidControlCenter（直接挂载）', () => {
  it('空态基本渲染：region 语义、is-empty 标记、输入域进 DOM', () => {
    renderControlCenter(null)
    const root = document.querySelector<HTMLElement>('.control-center')
    expect(root).toBeTruthy()
    expect(root).toHaveClass('is-empty')
    expect(root?.getAttribute('role')).toBe('region')
    expect(root?.getAttribute('aria-label')).toBe('Agent 工作台空态')
    expect(root?.getAttribute('data-control-center')).toBe('production')
    expect(root?.querySelector('[data-widget-id="input"] textarea')).toBeTruthy()
  })

  it('会话态基本渲染：信息落脚处控件按定义表排序，输入栏在槽内', () => {
    renderControlCenter('session-a')
    const root = document.querySelector<HTMLElement>('.control-center')
    expect(root).toBeTruthy()
    expect(root?.classList.contains('is-empty')).toBe(false)
    expect(root?.getAttribute('role')).toBeNull()
    const statusIds = [...document.querySelectorAll('.cc-status-group [data-widget-id]')]
      .map(el => el.getAttribute('data-widget-id'))
    expect(statusIds).toEqual(['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint'])
    expect(document.querySelector('.cc-input-slot [data-widget-id="input"]')).toBeTruthy()
  })

  it('空态 Enter 走 createSession IPC，失败时错误可见', async () => {
    const { services } = renderControlCenter(null)
    services.commands.setHandler('createSession', async () => {
      throw new Error('创建失败：工作区重名')
    })
    const textarea = screen.getByRole('textbox', { name: '消息输入' }) as HTMLTextAreaElement
    fireEvent.input(textarea, { target: { value: '空态首条' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('createSession'))
    expect(services.commands.calls[0]?.args[0]).toEqual({
      // 空态草稿的 model 由 runtime.activeModel 播种（fixture = deepseek-v4-flash）；
      // workspaceId 为空 ⇒ 不携带该键。
      model: 'deepseek-v4-flash',
      reasoningLevel: 'medium',
      mode: 'auto',
      initialPrompt: { text: '空态首条', attachments: [] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('创建失败：工作区重名')
  })

  it('空态会话创建成功：不落错误，提交期间 aria-busy 复位', async () => {
    const { services } = renderControlCenter(null)
    const textarea = screen.getByRole('textbox', { name: '消息输入' }) as HTMLTextAreaElement
    fireEvent.input(textarea, { target: { value: '空态首条' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('createSession'))
    await waitFor(() => expect(document.querySelector('.control-center')?.getAttribute('aria-busy')).toBe('false'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('编辑态拖拽：阈值内松开只选中；越阈值提交带占区守卫的 placement', async () => {
    const { services } = renderControlCenter('session-a')
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const widget = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-widget-id="model"]')
      expect(node).toBeTruthy()
      return node!
    })

    // 阈值内（1.41px < 3px）：只选中，不写任何 placement
    firePointerDown(widget, 10, 10)
    await waitFor(() => expect(widget).toHaveClass('cc-selected'))
    fireWindowPointer('pointermove', 11, 11)
    fireWindowPointer('pointerup', 11, 11)
    expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(0)
    expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetY).toBe(0)

    // 越阈值：位移走 updatePlacement（jsdom 矩形全零 ⇒ 守卫放行候选值）
    firePointerDown(widget, 10, 10)
    fireWindowPointer('pointermove', 30, 20)
    fireWindowPointer('pointerup', 30, 20)
    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(20))
    expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetY).toBe(10)
  })

  it('Escape 键盘路径：先清选中，再退编辑模式', async () => {
    const { services } = renderControlCenter('session-a')
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
    await waitFor(() => expect(document.querySelector('.cc-edit-row.active')).toBeTruthy())

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await waitFor(() => expect(document.querySelector('.cc-edit-row.active')).toBeNull())
    expect(services.appearance.getSnapshot().ccEditMode).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccEditMode).toBe(false))
    expect(document.querySelector('.cc-edit-column')).toBeNull()
  })
})

