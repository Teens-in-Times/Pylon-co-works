/**
 * createInputPredictionController — InputBar 的三源预测仲裁 + 调度接线（#520 S3-P1 拆出）。
 *
 * 三源（优先级自上而下，行为逐字对齐拆分前的 `prediction` memo）：
 * 1. **history** —— 会话历史里以当前草稿为前缀的最近一条（`findHistoryCompletion`）；
 * 2. **native** —— Agent 推送的一次性预测（#394，按实例键消费）；
 * 3. **llm** —— 宿主 provider 的低频预测（`createPredictionScheduler` 接线：去抖/取消/冷却）。
 *
 * 附带 #395 文档判据：文档按 provider source 建键，source 不匹配时它的历史与
 * 原生预测都不参与。纯 ts（无 JSX），Solid 工厂形态与 `createCommandPaletteModel` 同款。
 */
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { assistPredictionInstanceKey, assistPredictionText } from '../../../domains/workbench/session/assistPrediction.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'
import { findHistoryCompletion, mergeHistory, type PredictionCandidate } from '../../../infrastructure/prediction/inputPredictionState.ts'
import { createPredictionScheduler, type InputPredictionProvider, type PredictionScheduler } from '../../../infrastructure/prediction/inputPredictionProvider.ts'
import { cachedInputPredictionSettings } from '../../../domains/inputPrediction/inputPredictionSettingsCache.ts'

/** 拒绝键：history 源按「草稿+文本」建键（同前缀不同历史条目互不误伤）。 */
export function historyDismissKey(draft: string, text: string): string {
  return `history:${draft}:${text}`
}
/** 拒绝键：llm 源按文本建键。 */
export function llmDismissKey(text: string): string {
  return `llm:${text}`
}

export interface InputPredictionPorts {
  /** 身份域会话 id（null = 空态）。 */
  sessionId(): string | null
  /** runtime 快照（generating / generation / document）。 */
  runtime(): WorkbenchRuntimeSnapshot
  /** #395：宿主提供的 provider source（null = 不收紧文档判据）。 */
  sessionSource(): string | null
  draft(): string
  /** 会话本地输入历史（sessionUi `input-history`）。 */
  history(): readonly string[]
  /** 附件非空时仲裁退场。 */
  hasAttachments(): boolean
  /** 命令面板开着时仲裁退场（预测与补全面板互斥）。 */
  hasActiveSuggestions(): boolean
  /** #394：已消费的原生预测实例键（per-session，sessionUi 承载）。 */
  consumed(): string
  /** 消费原生预测实例（接受/拒绝都写）。 */
  consume(key: string): void
  /** 宿主 provider（缺省 = 只有 history / native 两源）。 */
  provider?: InputPredictionProvider
}

export interface InputPredictionController {
  /** 当前应呈现的 ghost 候选（三源仲裁结果；null = 无）。 */
  prediction(): PredictionCandidate | null
  /** 输入变化后清除拒绝标记（ghost 重新参与仲裁）。 */
  clearDismissed(): void
  /** 拒绝一个候选（源判定拒绝键）。 */
  dismiss(candidate: PredictionCandidate, draft: string): void
  dispose(): void
}

export function createInputPredictionController(ports: InputPredictionPorts): InputPredictionController {
  const [dismissedPrediction, setDismissedPrediction] = createSignal<string | null>(null)
  const [providerPrediction, setProviderPrediction] = createSignal<string | null>(null)
  const predictionScheduler: PredictionScheduler | null = ports.provider
    ? createPredictionScheduler(ports.provider)
    : null

  /** #395：文档按 **provider source** 建键（`WorkbenchDocument.sessionId` 即 source），而
   *  `sessionId()` 是身份域的 `Session.id`——判「这份文档是不是本会话的」必须用 source 比。
   *  此前两者混比导致判据恒假。宿主未提供 source 时不收紧。 */
  const sessionDocument = createMemo(() => {
    const document = ports.runtime().document
    if (!document) return undefined
    const source = ports.sessionSource()
    return source === null || document.sessionId === source ? document : undefined
  })
  const durableHistory = createMemo(() => {
    const document = sessionDocument()
    if (!document) return [] as readonly string[]
    return document.messages
      .filter(message => message.role === 'user')
      .map(message => message.content)
      .filter((value): value is string => typeof value === 'string')
  })
  const durableMessages = createMemo(() => {
    const document = sessionDocument()
    if (!document) return [] as readonly { role: 'user' | 'assistant'; content: string }[]
    return document.messages
      .filter(message => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
      .map(message => ({ role: message.role as 'user' | 'assistant', content: message.content as string }))
  })
  /** #394：Agent 推送的原生预测（一次性实例）。空文本帧不算预测——Peri 用 `prediction_ready`
   *  的 `set_title` 动作发会话标题，此前那类帧被渲成一张无字空卡。已消费的实例不再呈现。 */
  const nativePrediction = createMemo(() => {
    const prediction = sessionDocument()?.assist.prediction
    const text = assistPredictionText(prediction)
    if (!text) return null
    const key = assistPredictionInstanceKey(prediction)
    if (!key || key === ports.consumed()) return null
    return { key, text }
  })
  const prediction = createMemo<PredictionCandidate | null>(() => {
    const value = ports.draft()
    if (ports.hasActiveSuggestions() || ports.runtime().generating || ports.hasAttachments()) return null
    const historyCompletion = findHistoryCompletion(value, mergeHistory(durableHistory(), ports.history()))
    if (historyCompletion) {
      const key = historyDismissKey(value, historyCompletion)
      return dismissedPrediction() === key ? null : { text: historyCompletion, source: 'history' }
    }
    // 原生源优先（#394）：空草稿给全文；已输入部分是它的前缀时续显剩余（与代码补全同形）。
    // 分歧分支这里只返回 null——消费是副作用，交给下面的 effect，memo 保持纯净。
    const native = nativePrediction()
    if (native) {
      if (!native.text.startsWith(value)) return null
      return native.text.length > value.length
        ? { text: native.text, source: 'native', instanceKey: native.key }
        : null
    }
    if (value) return null
    const predictionMode = cachedInputPredictionSettings().mode
    if (predictionMode === 'off' || predictionMode === 'standalone') return null
    const valueFromProvider = providerPrediction()
    if (!valueFromProvider) return null
    const key = llmDismissKey(valueFromProvider)
    return dismissedPrediction() === key ? null : { text: valueFromProvider, source: 'llm' }
  })
  // #394：输入分歧即拒绝（代码补全语义）——草稿不再以原生预测为前缀就消费掉它，
  // 于是它不会在草稿被删回前缀时复活。写 sessionUi 是副作用，必须放 effect。
  createEffect(() => {
    const native = nativePrediction()
    if (!native) return
    const value = ports.draft()
    if (!value || native.text.startsWith(value)) return
    ports.consume(native.key)
  })
  createEffect(() => {
    const scheduler = predictionScheduler
    const id = ports.sessionId()
    const value = ports.draft()
    const generating = ports.runtime().generating
    const hasCommands = ports.hasActiveSuggestions()
    const hasAttachments = ports.hasAttachments()
    // #394：原生预测在场时不再发本地请求（原生优先；`standalone` 模式表「强制本地」，故排除）。
    const nativeActive = nativePrediction() !== null && cachedInputPredictionSettings().mode !== 'standalone'
    if (!scheduler || !id || value || generating || hasCommands || hasAttachments || nativeActive) {
      scheduler?.cancel()
      setProviderPrediction(null)
      return
    }
    const generation = ports.runtime().generation
    const historyValues = mergeHistory(durableHistory(), ports.history())
    const messages = durableMessages()
    setProviderPrediction(null)
    scheduler.schedule({ sessionId: id, generation, draft: value, history: historyValues, messages }, result => {
      if (ports.sessionId() !== id || ports.runtime().generation !== generation || ports.draft() !== '') return
      const normalized = result?.trim()
      setProviderPrediction(normalized || null)
    })
  })
  const dispose = () => predictionScheduler?.dispose()
  onCleanup(dispose)

  return {
    prediction,
    clearDismissed: () => setDismissedPrediction(null),
    dismiss: (candidate, draft) => {
      setDismissedPrediction(candidate.source === 'history' ? historyDismissKey(draft, candidate.text) : llmDismissKey(candidate.text))
    },
    dispose,
  }
}
