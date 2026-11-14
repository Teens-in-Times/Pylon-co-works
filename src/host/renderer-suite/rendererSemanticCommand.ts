import type { RenderSemanticCommand } from '../../contracts/messageRenderer.ts'
import type { WorkbenchCapabilityReader, WorkbenchHostPort, WorkbenchMountInput } from '../../renderers/solid-workbench/workbenchContracts.ts'
import { dispatchPylonEvent } from '../../domains/events/pylonCustomEvents.ts'
import { consumeAssistPrediction } from '../../domains/workbench/session/assistPrediction.ts'

export function isRenderSemanticCommand(value: unknown): value is RenderSemanticCommand {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).type === 'string')
}

export function canExecuteRendererSemanticCommand(commandType: string, capabilities: WorkbenchCapabilityReader): boolean {
  switch (commandType) {
    case 'clipboard.write': return capabilities.has('clipboardWrite')
    case 'interaction.respond': return capabilities.has('interactionResponse')
    case 'tool.action':
    case 'activity.cancel':
    case 'activity.retry': return capabilities.has('toolAction')
    case 'resource.open': return capabilities.has('resourceOpen')
    case 'resource.reveal': return capabilities.has('resourceReveal')
    case 'message.retry': return capabilities.has('retry')
    case 'session.recover': return capabilities.has('recovery')
    case 'session.config.update': return capabilities.has('sessionConfig')
    // Host-level navigation; the DOM bridge is host-owned, not a renderer capability.
    case 'diagnostics.open':
    case 'diagnostics.dismiss':
    case 'assist.accept':
    case 'assist.reject': return true
    default: return false
  }
}

export async function executeRendererSemanticCommand(input: {
  readonly command: RenderSemanticCommand
  readonly host: WorkbenchHostPort
  readonly mountInput: WorkbenchMountInput
  readonly slotId?: string
  readonly kind?: string
}): Promise<void> {
  const { command, host, mountInput } = input
  const sessionId = mountInput.sessionId
  const payload = command.payload
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined
  const reject = (code: string, message: string) => host.diagnostics.report({
    code, message, phase: 'action', recoverability: 'none',
    slotId: input.slotId, kind: input.kind, actionType: command.type,
  })

  // `diagnostics.open` is a host-owned UI navigation and needs no active
  // session (an unbound empty-state system error card can offer it).  Renderers
  // must not construct `pylon:*` window CustomEvents themselves; the typed DOM
  // bridge stays behind this host seam (B-04 / 宪法 §3.2.5).
  if (command.type === 'diagnostics.open') {
    if (typeof window !== 'undefined') dispatchPylonEvent(window, 'pylon:open-runtime-sheet')
    else reject('renderer_action_unavailable', 'diagnostics.open 需要 DOM 宿主')
    return
  }

  if (!sessionId) { reject('renderer_action_context_missing', 'Renderer action 缺少活动 Session'); return }

  if (command.type === 'diagnostics.dismiss') {
    const eventId = command.targetId
    const document = host.document.getSnapshot()
    if (eventId && document?.sessionId === (mountInput.sessionSource ?? sessionId) && (
      document.systemErrors.some(error => error.eventId === eventId) ||
      document.diagnostics.some(diagnostic => diagnostic.eventId === eventId && diagnostic.level === 'error')
    )) {
      host.sessionUi.update<readonly string[]>('dismissed-diagnostic-events', [], ids =>
        ids.includes(eventId) ? ids : [...ids, eventId])
    }
    return
  }

  if (command.type === 'assist.accept') {
    const text = record?.text
    if (typeof text !== 'string' || !text.trim()) { reject('renderer_action_invalid', 'assist.accept 缺少 text'); return }
    host.sessionUi.set('draft', text)
    // #394：接受＝消费该预测实例——否则同一张预测横在会话流里不走（此前「点了不清」）。
    consumeAssistPrediction(host.sessionUi, host.document.getSnapshot()?.assist.prediction)
    host.diagnostics.report({
      code: 'assist.accepted', message: '输入建议已接受到当前 Session 草稿', phase: 'action', recoverability: 'none',
      slotId: input.slotId, kind: input.kind, actionType: command.type,
    })
    return
  }
  if (command.type === 'assist.reject') {
    // #394：忽略＝消费该预测实例（此前只留一条诊断，卡片原样留存）。
    consumeAssistPrediction(host.sessionUi, host.document.getSnapshot()?.assist.prediction)
    host.diagnostics.report({
      code: 'assist.rejected', message: '输入建议已忽略', phase: 'action', recoverability: 'none',
      slotId: input.slotId, kind: input.kind, actionType: command.type,
    })
    return
  }

  let result: { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  switch (command.type) {
    case 'clipboard.write': {
      const text = typeof payload === 'string' ? payload : record?.text
      if (typeof text !== 'string') { reject('renderer_action_invalid', 'clipboard.write 缺少 text'); return }
      result = await host.commands.copy(sessionId, text)
      break
    }
    case 'interaction.respond': {
      if (!command.targetId) { reject('renderer_action_invalid', 'interaction.respond 缺少 targetId'); return }
      const expectedRevision = typeof record?.expectedRevision === 'number' ? record.expectedRevision : undefined
      const response = record && expectedRevision !== undefined
        ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'expectedRevision'))
        : payload
      result = expectedRevision === undefined
        ? await host.commands.respondInteraction(sessionId, command.targetId, response)
        : await host.commands.respondInteraction(sessionId, command.targetId, response, { expectedRevision })
      break
    }
    case 'tool.action': {
      const action = record?.action
      if (!command.targetId || typeof action !== 'string') { reject('renderer_action_invalid', 'tool.action 缺少 targetId/action'); return }
      result = await host.commands.toolAction(sessionId, command.targetId, action, record?.payload)
      break
    }
    case 'resource.open':
      result = await host.commands.openResource(sessionId, payload)
      break
    case 'resource.reveal':
      result = await host.commands.revealResource(sessionId, payload)
      break
    case 'activity.cancel': {
      if (!command.targetId) { reject('renderer_action_invalid', 'activity.cancel 缺少 targetId'); return }
      result = await host.commands.toolAction(sessionId, command.targetId, 'cancel', payload)
      break
    }
    case 'activity.retry': {
      if (!command.targetId) { reject('renderer_action_invalid', 'activity.retry 缺少 targetId'); return }
      result = await host.commands.toolAction(sessionId, command.targetId, 'retry', payload)
      break
    }
    case 'session.recover':
      result = await host.commands.recover(sessionId, typeof record?.strategy === 'string' ? record.strategy : undefined)
      break
    case 'session.config.update': {
      if (!command.targetId || !record || !('value' in record)) { reject('renderer_action_invalid', 'session.config.update 缺少 targetId/value'); return }
      const expectedVersion = typeof record.expectedVersion === 'number' ? record.expectedVersion : undefined
      const options = {
        ...('expectedValue' in record ? { expectedValue: record.expectedValue } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      }
      result = await host.commands.setConfigOption(sessionId, command.targetId, record.value,
        Object.keys(options).length > 0 ? options : undefined)
      break
    }
    default:
      reject('renderer_action_unknown', `未知 Renderer semantic action：${command.type}`)
      return
  }
  if (!result.ok) {
    reject(result.error.code, result.error.message)
    // Interaction surfaces use rejection to keep their local answer editable
    // and to show an actionable retry state. Other renderer actions retain the
    // historical diagnostic-only behavior.
    if (command.type === 'interaction.respond' || command.type === 'session.config.update') {
      throw new Error(result.error.message)
    }
  }
}
