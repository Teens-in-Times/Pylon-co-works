/**
 * 预览 fake facade：设置页渲染器预览（RendererSettingsPreview / settingsPreviewControlCenter）
 * 与 Solid workbench 测试共用的假 workbench 服务装配。#520 结构收敛批自
 * `__fixtures__/` 迁入 `preview/`——本文件被生产代码 import，不是测试资产。
 */
import { WORKBENCH_MESSAGE_FIXTURE } from '../__fixtures__/workbenchFixtures.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { createStaticWorkbenchAppearanceStore } from '../../../domains/appearance/workbenchAppearanceStore.ts'
import { createSessionUiStore } from '../../../domains/workbench/sessionUiStore.ts'
import { createFakeWorkbenchCommandFacade } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createPreviewWorkbenchRuntime } from '../../../domains/workbench/workbenchRuntime.ts'
import { createWorkbenchDocument, type WorkbenchActivityNode, type WorkbenchDocument, type WorkbenchMessage } from '../../../domains/workbench/workbenchProjector.ts'
import { normalizePlanEntries } from '../../../domains/workbench/plan/goalModel.ts'
import type { SolidWorkbenchServices } from '../workbenchContracts.ts'

export interface PreviewWorkbenchServices extends SolidWorkbenchServices {
  runtime: ReturnType<typeof createPreviewWorkbenchRuntime>
  appearance: ReturnType<typeof createStaticWorkbenchAppearanceStore>
  sessionUi: ReturnType<typeof createSessionUiStore>
  commands: ReturnType<typeof createFakeWorkbenchCommandFacade>
  destroy(): void
}

/**
 * #487：预览 fixture 与生产同构喂 `WorkbenchDocument`（原 `update({messages})`
 * legacy 通道已退役）。fixture 的文本行（user/reasoning/assistant）映射为
 * document 消息；tool 行映射为 activities 轴（canonical 语义下工具的家）；
 * 任务清单经 `normalizePlanEntries` 进 plan（同原 documentFromLegacy 口径）。
 */
function previewWorkbenchDocument(): WorkbenchDocument {
  const base = createWorkbenchDocument('preview-session')
  const messages: WorkbenchMessage[] = []
  const activities: WorkbenchActivityNode[] = []
  for (const [index, message] of WORKBENCH_MESSAGE_FIXTURE.messages.entries()) {
    if (message.role === 'tool') {
      activities.push({
        id: message.id,
        kind: 'tool',
        title: message.toolName,
        semanticKind: message.toolKind,
        status: message.toolStatus === 'in_progress' ? 'running' : message.toolStatus === 'failed' ? 'failed' : 'completed',
        orphan: false,
        sequence: index + 1,
      })
      continue
    }
    messages.push({
      id: message.id,
      segmentId: message.id,
      role: message.role === 'user' ? 'user' : message.role === 'reasoning' ? 'reasoning' : 'assistant',
      content: message.content,
      parts: [],
      identity: {},
      source: { provider: message.sender, sourceId: message.sender },
      sequence: index + 1,
      running: message.running === true,
      time: message.time,
      ...(message.role === 'reasoning' && message.thoughtDurationMs !== undefined
        ? { thoughtDurationMs: message.thoughtDurationMs }
        : {}),
    })
  }
  return {
    ...base,
    messages,
    activities,
    plan: { ...base.plan, entries: normalizePlanEntries(WORKBENCH_MESSAGE_FIXTURE.tasks) },
    session: { ...base.session, status: 'ready', model: 'deepseek-v4-flash', mode: 'auto' },
  }
}

export function createPreviewWorkbenchServices(): PreviewWorkbenchServices {
  const runtime = createPreviewWorkbenchRuntime({
    sessionId: 'preview-session',
    status: 'ready',
    generating: true,
    generationPhase: { kind: 'responding' },
    generationStart: 1_000,
    lastTokenAt: 2_000,
    tokenCount: 12_480,
    summary: null,
    tasks: [...WORKBENCH_MESSAGE_FIXTURE.tasks],
    thinkingStart: 1_200,
    availableModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    activeModel: 'deepseek-v4-flash',
    // Keep the preview fixture aligned with Hermes' permission-mode ids.  The
    // renderer may still provide labels/aliases for legacy ids, but fixtures
    // should exercise the wire values we actually send over ACP.
    availableModes: ['default', 'accept_edits', 'auto', 'bypass'],
    activeMode: 'auto',
    canAttach: true,
    promptImage: false,
    error: null,
    document: previewWorkbenchDocument(),
  })
  const appearance = createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS))
  const sessionUi = createSessionUiStore()
  const commands = createFakeWorkbenchCommandFacade()
  let destroyed = false

  return {
    runtime,
    appearance,
    sessionUi,
    commands,
    destroy() {
      if (destroyed) return
      destroyed = true
      runtime.destroy()
      appearance.destroy()
      sessionUi.destroy()
    },
  }
}
