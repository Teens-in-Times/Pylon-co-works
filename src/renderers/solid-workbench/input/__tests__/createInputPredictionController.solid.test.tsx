/**
 * createInputPredictionController 单测（#520 S3-P1 拆分配套，node 环境无 DOM）。
 *
 * 三源仲裁（history / native / llm）、#394 消费语义、#395 source 判据、
 * scheduler 接线（去抖/取消/原生优先）各钉一层；键盘接受/拒绝链路与
 * ghost 渲染由 `InputBar.solid.test.tsx` 承接（拆分前后 32 例原样全绿）。
 */
import { createRoot, createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInputPredictionController, historyDismissKey, llmDismissKey, type InputPredictionPorts } from '../createInputPredictionController.solid.tsx'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench } from '../../../../domains/workbench/workbenchProjector.ts'
import { createPreviewWorkbenchRuntime } from '../../../../domains/workbench/workbenchRuntime.ts'
import { createWorkbenchDocument } from '../../../../domains/workbench/workbenchProjector.ts'
import type { InputPredictionProvider } from '../../../../infrastructure/prediction/inputPredictionProvider.ts'

/** 文档按 provider source 建键——与真实宿主一致（`binding.source`）。 */
function predictionDocument(source: string, event: WorkbenchEventEnvelope['event']) {
  return projectWorkbench([createWorkbenchEnvelope({
    sessionId: source, recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
    source: { provider: 'peri', sourceId: 'wire-native' },
    provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
  })]).document
}

function makeRuntime(sessionId = 'session-a') {
  const runtime = createPreviewWorkbenchRuntime({
    sessionId,
    status: 'ready',
    generating: false,
    generationStart: 0,
    tokenCount: 0,
    summary: null,
    tasks: [],
    availableModels: [],
    activeModel: '',
    availableModes: [],
    activeMode: 'default',
    canAttach: false,
    promptImage: false,
    error: null,
    document: createWorkbenchDocument(sessionId),
  })
  return runtime
}

/** 与组件同构的桥接：store 快照 → signal（Solid 追踪面）。 */
function mountController(overrides: Partial<InputPredictionPorts> = {}, runtime = makeRuntime()) {
  let disposeRoot = () => {}
  let controller!: ReturnType<typeof createInputPredictionController>
  const consumed: string[] = []
  const [consumedKey, setConsumedKey] = createSignal('')
  const [draft, setDraft] = createSignal('')
  const [history] = createSignal<readonly string[]>([])
  const [hasAttachments] = createSignal(false)
  const [hasSuggestions] = createSignal(false)
  const [source, setSource] = createSignal<string | null>(null)
  createRoot(dispose => {
    disposeRoot = dispose
    const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(runtime.getSnapshot())
    const unsubscribe = runtime.subscribe(() => setRuntimeSnapshot(runtime.getSnapshot()))
    controller = createInputPredictionController({
      sessionId: () => runtime.getSnapshot().sessionId,
      runtime: runtimeSnapshot,
      sessionSource: source,
      draft,
      history,
      hasAttachments,
      hasActiveSuggestions: hasSuggestions,
      consumed: consumedKey,
      consume: key => { consumed.push(key); setConsumedKey(key) },
      provider: undefined,
      ...overrides,
    })
    // 桥接订阅随根清理
    void unsubscribe
  })
  return {
    controller, runtime, consumed, setSource,
    setConsumed: setConsumedKey,
    setDraft,
    dispose: () => { disposeRoot(); runtime.destroy() },
  }
}

afterEach(() => { vi.useRealTimers() })

describe('createInputPredictionController · history 源', () => {
  it('会话历史以草稿为前缀 ⇒ ghost（source=history），拒绝后收敛、清除后复活', () => {
    const harness = mountController({}, makeRuntime())
    harness.runtime.replaceDocument(
      predictionDocument('session-a', { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '继续做' }] }),
      { ownerKey: 'owner-a' },
    )
    harness.setDraft('继续')
    expect(harness.controller.prediction()).toEqual({ text: '继续做', source: 'history' })

    harness.controller.dismiss(harness.controller.prediction()!, '继续')
    expect(harness.controller.prediction()).toBeNull()
    expect(historyDismissKey('继续', '继续做')).toBe('history:继续:继续做')

    harness.controller.clearDismissed()
    expect(harness.controller.prediction()).toEqual({ text: '继续做', source: 'history' })
    harness.dispose()
  })

  it('空草稿不走 history 源（没有前缀可言）', () => {
    const harness = mountController({}, makeRuntime())
    harness.runtime.replaceDocument(
      predictionDocument('session-a', { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '继续做' }] }),
      { ownerKey: 'owner-a' },
    )
    expect(harness.controller.prediction()).toBeNull()
    harness.dispose()
  })
})

describe('createInputPredictionController · native 源（#394）', () => {
  it('文档预测进 ghost（source=native + 实例键）；已消费实例不再呈现', () => {
    const harness = mountController({}, makeRuntime())
    const document = predictionDocument('session-a', { type: 'assist.prediction', placeholder: '先帮我看看这个仓库的结构', actions: [] })
    harness.runtime.replaceDocument(document, { ownerKey: 'owner-a' })
    const eventId = document.assist.prediction?.eventId
    expect(eventId).toBeTruthy()

    const prediction = harness.controller.prediction()
    expect(prediction).toEqual({ text: '先帮我看看这个仓库的结构', source: 'native', instanceKey: eventId })

    harness.setConsumed(eventId!) // 组件键位侧的接受/拒绝即消费
    expect(harness.controller.prediction()).toBeNull()
    harness.dispose()
  })

  it('输入分歧即拒绝：草稿不再是原生预测前缀 ⇒ 消费该实例', () => {
    const harness = mountController({}, makeRuntime())
    const document = predictionDocument('session-a', { type: 'assist.prediction', placeholder: '先帮我看看这个仓库的结构', actions: [] })
    harness.runtime.replaceDocument(document, { ownerKey: 'owner-a' })
    harness.setDraft('帮我') // 与 '先帮我…' 分歧
    return Promise.resolve().then(() => {
      expect(harness.consumed).toEqual([document.assist.prediction?.eventId])
      harness.dispose()
    })
  })

  it('#395：宿主 source 不匹配时文档不参与（原生预测与文档历史都不出）', async () => {
    const runtime = makeRuntime()
    const harness = mountController({ sessionSource: () => 'local:other-session' }, runtime)
    runtime.replaceDocument(
      predictionDocument('session-a', { type: 'assist.prediction', placeholder: '先帮我看看这个仓库的结构', actions: [] }),
      { ownerKey: 'owner-a' },
    )
    harness.setDraft('继续')
    await Promise.resolve()
    expect(harness.controller.prediction()).toBeNull()
    harness.dispose()
  })
})

describe('createInputPredictionController · llm 源 + 调度接线', () => {
  it('空草稿低频请求 provider，结果经去抖落地（source=llm），拒绝按 llm 键收敛', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider: InputPredictionProvider = { predict: vi.fn(async () => '模型建议继续') }
    const harness = mountController({ provider })
    await vi.advanceTimersByTimeAsync(500)

    expect(provider.predict).toHaveBeenCalledTimes(1)
    expect(harness.controller.prediction()).toEqual({ text: '模型建议继续', source: 'llm' })

    harness.controller.dismiss(harness.controller.prediction()!, '')
    expect(llmDismissKey('模型建议继续')).toBe('llm:模型建议继续')
    expect(harness.controller.prediction()).toBeNull()
    harness.dispose()
  })

  it('草稿非空 / 面板开着 / 生成中 / 有附件 ⇒ 不请求 provider', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider: InputPredictionProvider = { predict: vi.fn(async () => '不该出现') }

    const draftCase = mountController({ provider })
    draftCase.setDraft('有草稿')
    const panelCase = mountController({ provider, hasActiveSuggestions: () => true })
    const generatingCase = mountController({ provider })
    generatingCase.runtime.update({ generating: true })
    const attachmentsCase = mountController({ provider, hasAttachments: () => true })

    await vi.advanceTimersByTimeAsync(600)
    for (const scenario of [draftCase, panelCase, generatingCase, attachmentsCase]) {
      expect(provider.predict).not.toHaveBeenCalled()
      expect(scenario.controller.prediction()).toBeNull()
      scenario.dispose()
    }
  })

  it('原生预测在场时不发本地请求（原生优先，#394）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider: InputPredictionProvider = { predict: vi.fn(async () => '本地模型建议') }
    const harness = mountController({ provider })
    harness.runtime.replaceDocument(
      predictionDocument('session-a', { type: 'assist.prediction', placeholder: '先帮我看看这个仓库的结构', actions: [] }),
      { ownerKey: 'owner-a' },
    )
    await vi.advanceTimersByTimeAsync(600)

    expect(provider.predict).not.toHaveBeenCalled()
    expect(harness.controller.prediction()?.source).toBe('native')
    harness.dispose()
  })

  it('生成中取消在途调度：在途结果被丢弃，且 15s 冷却内不重发', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let resolveLater: ((value: string | null) => void) | undefined
    const provider: InputPredictionProvider = { predict: vi.fn(() => new Promise<string | null>(resolve => { resolveLater = resolve })) }
    const harness = mountController({ provider })
    await vi.advanceTimersByTimeAsync(500)
    expect(provider.predict).toHaveBeenCalledTimes(1) // 请求在途（provider 未返回）

    harness.runtime.update({ generating: true }) // 调度被 cancel（序列号作废 + abort）
    resolveLater?.('迟到的建议')
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.controller.prediction()).toBeNull()

    harness.runtime.update({ generating: false }) // 生成结束后重挂调度 ⇒ 15s 冷却内不发新请求
    await vi.advanceTimersByTimeAsync(800)
    expect(provider.predict).toHaveBeenCalledTimes(1)
    expect(harness.controller.prediction()).toBeNull()
    harness.dispose()
  })

  it('dispose 后 provider 不再被请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider: InputPredictionProvider = { predict: vi.fn(async () => '不该出现') }
    const harness = mountController({ provider })
    await vi.advanceTimersByTimeAsync(500)
    const callsAfterFirst = vi.mocked(provider.predict).mock.calls.length
    harness.dispose()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.mocked(provider.predict).mock.calls.length).toBe(callsAfterFirst)
  })
})
