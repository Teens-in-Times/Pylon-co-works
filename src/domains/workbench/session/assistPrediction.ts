import type { SessionUiKey, SessionUiScope } from '../sessionUiStore.ts'

/**
 * #394：**一次性预测实例**的消费标记。
 *
 * Agent 推送的预测（`peri/prediction_ready` → `assist.prediction`）是一件有身份的事实：
 * 它在文档里一直躺着，直到被接受或被拒绝。此前接受/忽略都只写草稿与诊断、**不清状态**
 * （实测点「忽略」后卡片原样），于是同一张预测会在输入框 ghost 与会话卡上反复出现。
 *
 * 消费标记记为**实例键**（见 `assistPredictionInstanceKey`），存在 per-session 的
 * `sessionUi` 里：输入框接受/拒绝写它，ghost 读它；新预测带新 eventId，
 * 自然不再命中旧标记、重新呈现。#394 修订 1 起内置工作台不再挂载预测卡。
 */
export const ASSIST_PREDICTION_CONSUMED_KEY: SessionUiKey = 'assist-prediction-consumed'

export interface AssistPredictionLike {
  readonly placeholder?: string
  readonly eventId?: string
}

/** 预测实例键：优先事件身份（`eventId`）；缺省回退文本；两者皆缺 ⇒ 无可消费对象。 */
export function assistPredictionInstanceKey(prediction: AssistPredictionLike | undefined): string | undefined {
  if (!prediction) return undefined
  if (prediction.eventId) return prediction.eventId
  const text = prediction.placeholder?.trim()
  return text ? `text:${text}` : undefined
}

/** 可被呈现的预测文本（空文本帧——Peri 用它发 title——不是预测）。 */
export function assistPredictionText(prediction: AssistPredictionLike | undefined): string | undefined {
  const text = prediction?.placeholder?.trim()
  return text ? text : undefined
}

/** 是否已被接受/拒绝消费。 */
export function isAssistPredictionConsumed(
  reader: Pick<SessionUiScope, 'get'>,
  prediction: AssistPredictionLike | undefined,
): boolean {
  const key = assistPredictionInstanceKey(prediction)
  return key !== undefined && reader.get<string>(ASSIST_PREDICTION_CONSUMED_KEY, '') === key
}

/** 接受/拒绝即消费：写标记。无实例键（不存在可消费的预测）时返回 false。 */
export function consumeAssistPrediction(
  writer: Pick<SessionUiScope, 'set'>,
  prediction: AssistPredictionLike | undefined,
): boolean {
  const key = assistPredictionInstanceKey(prediction)
  if (key === undefined) return false
  writer.set(ASSIST_PREDICTION_CONSUMED_KEY, key)
  return true
}
