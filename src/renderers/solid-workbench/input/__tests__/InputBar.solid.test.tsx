// @vitest-environment jsdom
import { createSignal, onCleanup } from 'solid-js'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../../domains/theme/themeDefaults.ts'
import { createPreviewWorkbenchServices } from '../../preview/previewWorkbenchServices.ts'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from '../../SolidWorkbenchContext.solid.tsx'
import { SolidInputBar } from '../InputBar.solid.tsx'
import { getCommandRegistry } from '../../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../../plugin-runtime/pluginIdentity.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench } from '../../../../domains/workbench/workbenchProjector.ts'
import type { InputPredictionProvider } from '../../../../infrastructure/prediction/inputPredictionProvider.ts'

const modelCommand = getCommandRegistry().register(
  createPluginIdentity('test.solid-input', 'solid-input-test'),
  // `tier: 'user'`：它是日常命令，不声明即 internal（#329 默认档），默认层就看不到它。
  { id: 'solid-test-model', name: 'model', tier: 'user', description: '切换模型', inputHint: ' <name>', priority: -100 },
)

const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
})
afterAll(() => { void modelCommand.dispose() })

/**
 * ★ #266 刀9：原第二参 `inputVariant: 'cli' | 'composer'`（用来摆两种输入形态）已删除 ——
 * 输入形态固定命令行，`inputVariant` / `inputMode` 两个字段不存在了。
 * 参数位保留为「摆位/其它可选项」的占位（调用点里原本传 'composer' 的地方传 undefined）。
 */
function renderInput(
  sessionId = 'session-a',
  _legacyVariant?: 'cli' | 'composer',
  predictionProvider?: InputPredictionProvider,
  inInputSlot = false,
  /** #395：宿主提供的 provider source——文档判据的比对基准（缺省 null = 不收紧）。 */
  sessionSource: string | null = null,
) {
  const services = createPreviewWorkbenchServices()
  services.runtime.update({ sessionId, generating: false })
  const theme = structuredClone(DEFAULTS)
  services.appearance.setTheme(theme)
  servicesList.push(services)
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const [activeSessionId, setActiveSessionId] = createSignal(sessionId)
  const input = () => ({ sheetId: 'sheet-a', sessionId: activeSessionId(), preview: true, sessionSource })
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
        {inInputSlot
          ? <div class="control-center" style="--cc-height:150px"><div class="cc-input-slot" style="--cc-input-height:40px;--cc-input-offset-top:10px"><SolidInputBar predictionProvider={predictionProvider} /></div></div>
          : <SolidInputBar predictionProvider={predictionProvider} />}
      </SolidWorkbenchContext.Provider>
    )
  })
  return {
    services,
    textarea: screen.getByRole('textbox') as HTMLTextAreaElement,
    switchSession(nextSessionId: string) {
      setActiveSessionId(nextSessionId)
      services.runtime.update({ sessionId: nextSessionId })
    },
    slot: inInputSlot ? document.querySelector<HTMLElement>('.cc-input-slot') : undefined,
    controlCenter: inInputSlot ? document.querySelector<HTMLElement>('.control-center') : undefined,
  }
}

describe('SolidInputBar', () => {
  it('temporarily expands upward to three times the static input height without writing to appearance', async () => {
    const { services, textarea, slot, controlCenter } = renderInput('session-a', 'composer', undefined, true)
    expect(slot).toBeTruthy()
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 100 })

    fireEvent.input(textarea, { target: { value: '第一行\n第二行' } })
    await waitFor(() => expect(slot?.style.height).toBe('100px'))
    expect(controlCenter?.style.getPropertyValue('--cc-input-extra-height')).toBe('60px')
    expect(services.appearance.getSnapshot().inputHeight).toBe(40)

    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 500 })
    fireEvent.input(textarea, { target: { value: '更多内容' } })
    await waitFor(() => expect(slot?.style.height).toBe('120px'))
    expect(controlCenter?.style.getPropertyValue('--cc-input-extra-height')).toBe('80px')
    expect(textarea.style.overflowY).toBe('auto')
    expect(services.appearance.getSnapshot().inputHeight).toBe(40)

    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 40 })
    fireEvent.input(textarea, { target: { value: '保留一行' } })
    await waitFor(() => expect(slot?.style.height).toBe('40px'))
    expect(controlCenter?.style.getPropertyValue('--cc-input-extra-height')).toBe('')
  })

  it('Enter 发送，Shift+Enter 与 IME composition 不发送', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '正常消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(services.commands.calls).toHaveLength(0)

    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(services.commands.calls).toHaveLength(0)
    fireEvent.compositionEnd(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    expect(services.commands.calls[0]?.args).toEqual(['session-a', { text: '正常消息', attachments: [] }])
    expect(textarea.value).toBe('')
  })

  it('发送未完成时切换会话，不会清空新会话草稿或串写历史', async () => {
    let resolveSend: ((value: { status: 'sent'; messageId: string }) => void) | undefined
    const { services, textarea, switchSession } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'sent'; messageId: string }>(resolve => { resolveSend = resolve })))

    fireEvent.input(textarea, { target: { value: 'A 会话消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))

    switchSession('session-b')
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: 'B 会话草稿' } })
    resolveSend?.({ status: 'sent', messageId: 'message-a' })

    await waitFor(() => expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['A 会话消息']))
    expect(textarea.value).toBe('B 会话草稿')
    expect(services.sessionUi.get('session-b', 'draft', '')).toBe('B 会话草稿')
    expect(services.sessionUi.get('session-b', 'input-history', [])).toEqual([])
  })

  it('发送等待期间输入的下一条草稿不会被旧请求成功回调清空', async () => {
    let resolveSend: ((value: { status: 'sent'; messageId: string }) => void) | undefined
    const { services, textarea } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'sent'; messageId: string }>(resolve => { resolveSend = resolve })))

    fireEvent.input(textarea, { target: { value: '第一条' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    fireEvent.input(textarea, { target: { value: '发送期间写下的下一条' } })
    resolveSend?.({ status: 'sent', messageId: 'message-a' })

    await waitFor(() => expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['第一条']))
    expect(textarea.value).toBe('发送期间写下的下一条')
  })

  it('提交开始时立即清空输入框，发送失败且期间没有新输入时恢复原草稿', async () => {
    let resolveSend: ((value: { status: 'rejected'; error: string }) => void) | undefined
    const { services, textarea } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'rejected'; error: string }>(resolve => { resolveSend = resolve })))

    fireEvent.input(textarea, { target: { value: '立即离开输入框' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    expect(textarea.value).toBe('')

    resolveSend?.({ status: 'rejected', error: '网络暂时不可用' })
    await waitFor(() => expect(textarea.value).toBe('立即离开输入框'))
    expect(screen.getByRole('alert')).toHaveTextContent('网络暂时不可用')
  })

  it('发送失败时不以旧消息覆盖等待期间输入的新草稿', async () => {
    let resolveSend: ((value: { status: 'rejected'; error: string }) => void) | undefined
    const { services, textarea } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'rejected'; error: string }>(resolve => { resolveSend = resolve })))

    fireEvent.input(textarea, { target: { value: '失败的消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '发送期间的新草稿' } })
    resolveSend?.({ status: 'rejected', error: '发送失败' })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('发送失败'))
    expect(textarea.value).toBe('发送期间的新草稿')
  })

  it('发送失败提示只显示在发起会话', async () => {
    let resolveSend: ((value: { status: 'rejected'; error: string }) => void) | undefined
    const sendPromise = new Promise<{ status: 'rejected'; error: string }>(resolve => { resolveSend = resolve })
    const { services, textarea, switchSession } = renderInput()
    services.commands.setHandler('send', vi.fn(() => sendPromise))

    fireEvent.input(textarea, { target: { value: 'A 会话消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    switchSession('session-b')
    resolveSend?.({ status: 'rejected', error: 'A send failed' })
    await sendPromise
    await Promise.resolve()

    expect(screen.queryByRole('alert')).toBeNull()
    switchSession('session-a')
    expect(await screen.findByRole('alert')).toHaveTextContent('A send failed')
  })

  it('生成结束后自动发送队首，并等待下一轮结束后再发下一条', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '第一条待发' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.input(textarea, { target: { value: '第二条待发' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(await screen.findByText('第一条待发')).toBeTruthy()
    expect(screen.getByText('第二条待发')).toBeTruthy()
    expect(services.commands.calls).toHaveLength(0)

    services.runtime.update({ generating: false })
    await waitFor(() => expect(services.commands.calls).toHaveLength(1))
    expect(services.commands.calls[0]).toEqual({
      command: 'send', args: ['session-a', { text: '第一条待发', attachments: [] }],
    })
    // send 调用先于 sendQueued 的出队写（await sendText 之后才 filter）——
    // 队列 chip 的收敛晚于 calls 增长一个微任务，等它落地再断言。
    await waitFor(() => expect(screen.queryByText('第一条待发')).toBeNull())
    expect(screen.getByText('第二条待发')).toBeTruthy()

    services.runtime.update({ generating: true })
    services.runtime.update({ generating: false })
    await waitFor(() => expect(services.commands.calls).toHaveLength(2))
    expect(services.commands.calls[1]).toEqual({
      command: 'send', args: ['session-a', { text: '第二条待发', attachments: [] }],
    })
    await waitFor(() => expect(screen.queryByText('第二条待发')).toBeNull())
  })

  it('待发消息发送未完成时禁用队列按钮，避免重复提交', async () => {
    let resolveSend: ((value: { status: 'sent'; messageId: string }) => void) | undefined
    const { services, textarea } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'sent'; messageId: string }>(resolve => { resolveSend = resolve })))
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '只能发送一次' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    services.runtime.update({ generating: false })

    await waitFor(() => expect(services.commands.calls).toHaveLength(1))
    const sendQueuedButton = screen.getByRole('button', { name: '发送待发送消息' })
    expect(sendQueuedButton).toBeDisabled()
    fireEvent.click(sendQueuedButton)
    expect(services.commands.calls).toHaveLength(1)

    resolveSend?.({ status: 'sent', messageId: 'queued-message' })
    await waitFor(() => expect(screen.queryByText('只能发送一次')).toBeNull())
  })

  it('待发消息进入编辑态后聚焦编辑框，并明确提供完成操作', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '需要修改的消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    fireEvent.click(await screen.findByRole('button', { name: '编辑待发送消息' }))

    await waitFor(() => expect(screen.getByRole('textbox', { name: '编辑待发送消息' })).toHaveFocus())
    expect(screen.getByRole('button', { name: '完成编辑待发送消息' })).toBeTruthy()
  })

  it('待发消息编辑时按 Esc 保留修改并把焦点返回编辑按钮', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '原始待发消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: '编辑待发送消息' }))
    const editor = screen.getByRole('textbox', { name: '编辑待发送消息' })
    fireEvent.input(editor, { target: { value: '修改后的待发消息' } })
    expect(screen.getByRole('textbox', { name: '编辑待发送消息' })).toBe(editor)

    fireEvent.keyDown(screen.getByRole('textbox', { name: '编辑待发送消息' }), { key: 'Escape' })

    expect(await screen.findByText('修改后的待发消息')).toBeTruthy()
    const edit = screen.getByRole('button', { name: '编辑待发送消息' })
    await waitFor(() => expect(edit).toHaveFocus())
  })

  it('队首编辑期间暂停自动续发，完成后发送最新文本', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '尚未修改' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: '编辑待发送消息' }))
    fireEvent.input(screen.getByRole('textbox', { name: '编辑待发送消息' }), { target: { value: '最终待发内容' } })

    services.runtime.update({ generating: false })
    await Promise.resolve()
    expect(services.commands.calls).toHaveLength(0)
    expect(screen.getByRole('button', { name: '发送待发送消息' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '完成编辑待发送消息' }))
    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'send', args: ['session-a', { text: '最终待发内容', attachments: [] }],
    }))
  })

  it('生成在后台结束后，返回原会话会继续发送其队列', async () => {
    const { services, textarea, switchSession } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: 'A 后台待发' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    switchSession('session-b')
    services.runtime.update({ generating: false })
    expect(services.commands.calls).toHaveLength(0)
    switchSession('session-a')

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'send', args: ['session-a', { text: 'A 后台待发', attachments: [] }],
    }))
  })

  it('Slash command 走 facade，不作为普通 send', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '/model deepseek-chat' } })
    expect(screen.getByRole('listbox', { name: '命令建议' })).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('setModel'))
    expect(services.commands.calls[0]?.args).toEqual(['session-a', 'deepseek-chat'])
    expect(services.commands.calls.some(call => call.command === 'send')).toBe(false)
  })

  it('Tab 确认当前命令建议并把参数提示带入草稿', () => {
    const { textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '/mod' } })

    fireEvent.keyDown(textarea, { key: 'Tab' })

    expect(textarea.value).toBe('/model <name> ')
    expect(screen.getByRole('listbox', { name: '命令建议' })).toBeTruthy()
  })

  it('Enter 补全尚未输入完整的命令名，不误发为普通消息', () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '/mo' } })

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(textarea.value).toBe('/model <name> ')
    expect(services.commands.calls).toHaveLength(0)
  })

  // #329：默认菜单只列 user 级；内部/开发者命令折叠在「全部」里（切换项进环选，键盘可达）。
  it('命令菜单默认只列 user 级，「全部」展开后可及内部命令', () => {
    const identity = createPluginIdentity('test.solid-input', 'solid-input-test')
    const userCommand = getCommandRegistry().register(identity, {
      id: 'solid-test-user-command', name: 'zz-user-command', tier: 'user', description: '用户级命令', priority: -300,
    })
    const internalCommand = getCommandRegistry().register(identity, {
      id: 'solid-test-internal-command', name: 'zz-internal-command', description: '内部命令', priority: -300,
    })
    try {
      const { services, textarea } = renderInput()
      fireEvent.input(textarea, { target: { value: '/zz-' } })

      // 默认层：只看得到 user 级
      expect(screen.getByRole('option', { name: /zz-user-command/ })).toBeTruthy()
      expect(screen.queryByRole('option', { name: /zz-internal-command/ })).toBeNull()

      // 切换项在环选里（user 命中 1 条 → 它是第 2 行）：键盘 ArrowDown + Enter 即可展开，
      // 且不得被当成普通消息发出去
      const toggle = screen.getByRole('option', { name: /显示全部命令/ })
      expect(toggle).toHaveClass('cmd-toggle')
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(screen.getByRole('option', { name: /zz-internal-command/ })).toBeTruthy()
      expect(screen.getByRole('option', { name: /zz-user-command/ })).toBeTruthy()
      expect(services.commands.calls).toHaveLength(0)

      // 「只看常用命令」收回去：内部命令重新折叠
      fireEvent.click(screen.getByRole('option', { name: /只看常用命令/ }))
      expect(screen.queryByRole('option', { name: /zz-internal-command/ })).toBeNull()
    } finally {
      void userCommand.dispose()
      void internalCommand.dispose()
    }
  })

  // #329 审查 P1：曾有一条「user 层无命中就放行全量」的例外，条件是「user 层为空」而不是
  // 「用户在敲内部命令」——敲 `/b`/`/s` 这类普通前缀就会漏出几十条内部命令，正是本 issue
  // 要治的病。现在默认层严格只列 user 级，内部命令一律经「全部」显式展开。
  it('普通前缀不会漏出内部命令（默认层严格只列 user 级）', () => {
    const identity = createPluginIdentity('test.solid-input', 'solid-input-test')
    const internalOnly = getCommandRegistry().register(identity, {
      id: 'solid-test-zb-command', name: 'zb-internal-only', description: '内部命令', priority: -300,
    })
    try {
      const { textarea } = renderInput()
      fireEvent.input(textarea, { target: { value: '/zb' } })

      expect(screen.queryByRole('option', { name: /zb-internal-only/ })).toBeNull()
      // 命中全被折叠时，切换项仍给出「还有多少条」并可达
      expect(screen.getByRole('option', { name: /显示全部命令，含内部 1 条/ })).toBeTruthy()
    } finally {
      void internalOnly.dispose()
    }
  })

  it('实时消费 canonical session commands，且同名插件命令不覆盖会话权威', async () => {
    const { services, textarea } = renderInput()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'session-a', recordedAt: '2026-08-24T00:00:00.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'commands-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'session.commands-updated', commands: [
        { id: 'model', name: '/model', description: '会话模型命令', inputHint: ' <session-model>', availability: true },
        { id: 'review', name: '/review', description: '审查当前改动', inputHint: ' <scope>', availability: true },
      ] },
    })]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-a', generation: 1 })

    fireEvent.input(textarea, { target: { value: '/model' } })
    expect(await screen.findByText('会话模型命令')).toBeTruthy()
    expect(screen.queryByText('切换模型')).toBeNull()

    fireEvent.input(textarea, { target: { value: '/review' } })
    expect(await screen.findByText('审查当前改动')).toBeTruthy()
    expect(screen.getByText('/review <scope>')).toBeTruthy()
    fireEvent.input(textarea, { target: { value: '/review src' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'send', args: ['session-a', { text: '/review src', attachments: [] }],
    }))

    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'session-a', recordedAt: '2026-08-24T00:00:01.000Z', sequence: 2,
      source: { provider: 'peri', sourceId: 'commands-2' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'session.commands-updated', commands: [
        { id: 'audit', name: '/audit', description: '全量审计', availability: true },
      ] },
    })]).document, { ownerKey: 'owner-a', generation: 2 })
    fireEvent.input(textarea, { target: { value: '/audit' } })
    expect(await screen.findByText('全量审计')).toBeTruthy()
  })

  it('Esc/Ctrl+C 在生成时取消，失败结果展示可见错误', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    services.commands.setHandler('cancel', vi.fn(async () => ({ status: 'rejected' as const, error: 'cancel denied' })))

    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(await screen.findByRole('alert')).toHaveTextContent('cancel denied')
    expect(services.commands.calls[0]?.command).toBe('cancel')

    services.commands.reset()
    fireEvent.keyDown(textarea, { key: 'c', ctrlKey: true })
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('cancel'))
  })

  it('历史记录按 SessionUiStore 保存并可用方向键恢复', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '第一条' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    // 草稿清空发生在 send 之前，历史落库在 send 完成之后（recordHistory 在
    // await commands.send 的续体里）——等历史真正入库再按方向键。
    await waitFor(() => expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['第一条']))
    fireEvent.input(textarea, { target: { value: '当前草稿' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    expect(textarea.value).toBe('第一条')
    expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['第一条'])
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('当前草稿')
  })

  it('多行草稿中非首末行的方向键保留给原生光标移动', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '历史消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '第一行\n第二行\n第三行' } })
    textarea.setSelectionRange(7, 7)

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true)
    expect(textarea.value).toBe('第一行\n第二行\n第三行')
    expect(fireEvent.keyDown(textarea, { key: 'ArrowDown' })).toBe(true)
    expect(textarea.value).toBe('第一行\n第二行\n第三行')
    expect(services.sessionUi.get('session-a', 'input-history-index', -1)).toBe(-1)
  })

  it('没有历史记录时不拦截方向键', () => {
    const { textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '当前草稿' } })

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true)
    expect(fireEvent.keyDown(textarea, { key: 'ArrowDown' })).toBe(true)
    expect(textarea.value).toBe('当前草稿')
  })

  it('历史消息提供 ghost text，Tab 接受但不新增 input-history', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '继续做' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '继续' } })

    expect(await screen.findByText('做')).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('继续做')
    expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['继续做'])
  })

  it('ghost text 可用右箭头接受，Esc 忽略且编辑后重新计算', async () => {
    const { textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '继续做' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '继续' } })
    expect(await screen.findByText('做')).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByText('做')).toBeNull()
    fireEvent.input(textarea, { target: { value: '继续' } })
    expect(await screen.findByText('做')).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'ArrowRight' })
    expect(textarea.value).toBe('继续做')
  })

  it('可选 provider 在空草稿时低频请求并显示模型 ghost text', async () => {
    const provider: InputPredictionProvider = { predict: vi.fn(async () => '模型建议继续') }
    const { textarea } = renderInput('session-a', 'composer', provider)
    expect(await screen.findByText('模型建议继续', {}, { timeout: 1_500 })).toBeTruthy()
    expect(provider.predict).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('模型建议继续')
  })
})

// ── #394/#395：Agent 原生预测接进既有预测系统（ghost）────────────────────

/** 文档按 provider source 建键——与真实宿主一致（`binding.source`）。 */
function predictionDocument(source: string, event: WorkbenchEventEnvelope['event']) {
  return projectWorkbench([createWorkbenchEnvelope({
    sessionId: source, recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
    source: { provider: 'peri', sourceId: 'wire-native' },
    provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
  })]).document
}

describe('Agent 原生预测（#394）', () => {
  const SOURCE = 'local:session-a'

  it('随文档进入 ghost（源标注 native），Tab 接受并消费该实例', async () => {
    const { services, textarea } = renderInput('session-a', undefined, undefined, false, SOURCE)
    const projected = predictionDocument(SOURCE, { type: 'assist.prediction', placeholder: '先帮我看看这个仓库的结构', actions: [] })
    const eventId = projected.assist.prediction?.eventId
    expect(eventId).toBeTruthy()
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-a' })

    const ghost = await screen.findByText('先帮我看看这个仓库的结构')
    expect(ghost.closest('.input-ghost-suggestion')?.getAttribute('data-prediction-source')).toBe('native')

    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('先帮我看看这个仓库的结构')
    // 接受＝消费该实例：ghost 与会话卡共用这个标记，两侧同时收敛。
    expect(services.sessionUi.get('session-a', 'assist-prediction-consumed', '')).toBe(eventId)
  })

  it('草稿是预测前缀时续显剩余；输入分歧即拒绝（消费）', async () => {
    const { services, textarea } = renderInput('session-a', undefined, undefined, false, SOURCE)
    const projected = predictionDocument(SOURCE, { type: 'assist.prediction', placeholder: '先帮我看看这个仓库的结构', actions: [] })
    const eventId = projected.assist.prediction?.eventId
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-a' })
    await screen.findByText('先帮我看看这个仓库的结构')

    fireEvent.input(textarea, { target: { value: '先帮我' } })
    expect(await screen.findByText('看看这个仓库的结构')).toBeTruthy()

    fireEvent.input(textarea, { target: { value: '帮我' } })
    await waitFor(() => expect(services.sessionUi.get('session-a', 'assist-prediction-consumed', '')).toBe(eventId))
    expect(screen.queryByText('看看这个仓库的结构')).toBeNull()
  })

  it('空草稿上按退格即拒绝', async () => {
    const { services, textarea } = renderInput('session-a', undefined, undefined, false, SOURCE)
    const projected = predictionDocument(SOURCE, { type: 'assist.prediction', placeholder: '继续审计这个仓库', actions: [] })
    const eventId = projected.assist.prediction?.eventId
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-a' })
    await screen.findByText('继续审计这个仓库')

    fireEvent.keyDown(textarea, { key: 'Backspace' })
    expect(services.sessionUi.get('session-a', 'assist-prediction-consumed', '')).toBe(eventId)
  })

  it('原生预测在场时不发起本地 provider 请求（原生优先）', async () => {
    const provider: InputPredictionProvider = { predict: vi.fn(async () => '本地模型建议') }
    const { services } = renderInput('session-a', undefined, provider, false, SOURCE)
    services.runtime.replaceDocument(
      predictionDocument(SOURCE, { type: 'assist.prediction', placeholder: '先帮我看看这个仓库的结构', actions: [] }),
      { ownerKey: 'owner-a' },
    )
    await screen.findByText('先帮我看看这个仓库的结构')

    // 越过 scheduler 的 400ms 去抖窗口：原生在场时请求根本不该排上。
    // fake timers 只劫持 setTimeout/clearTimeout（scheduler 的去抖就是 setTimeout）：
    // advance 600ms 会真实触发任何被错误排上的去抖，负断言仍跨过了完整时间窗。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await vi.advanceTimersByTimeAsync(600)
      expect(provider.predict).not.toHaveBeenCalled()
      expect(screen.queryByText('本地模型建议')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('#395：文档 source 不匹配时不用它（原生预测与文档历史都不参与）', async () => {
    const { services, textarea } = renderInput('session-a', undefined, undefined, false, 'local:other-session')
    services.runtime.replaceDocument(
      predictionDocument(SOURCE, { type: 'assist.prediction', placeholder: '先帮我看看这个仓库的结构', actions: [] }),
      { ownerKey: 'owner-a' },
    )
    fireEvent.input(textarea, { target: { value: '继续' } })
    // fake timers 推进 50ms（到期定时器与微任务链全部跑完）再负断言：source 不匹配时
    // 文档历史 ghost 不参与，任何定时器驱动的迟到落地都逃不过这个窗口。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await vi.advanceTimersByTimeAsync(50)
      expect(screen.queryByText('先帮我看看这个仓库的结构')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('#395：source 匹配时文档历史参与 ghost 补全', async () => {
    const { services, textarea } = renderInput('session-a', undefined, undefined, false, SOURCE)
    services.runtime.replaceDocument(
      predictionDocument(SOURCE, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '继续做' }] }),
      { ownerKey: 'owner-a' },
    )
    fireEvent.input(textarea, { target: { value: '继续' } })
    expect(await screen.findByText('做')).toBeTruthy()
  })
})
