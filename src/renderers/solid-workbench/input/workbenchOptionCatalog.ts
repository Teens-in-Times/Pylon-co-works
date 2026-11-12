import type { SessionConfigOption } from '../../../domains/workbench/session/sessionSurface.ts'
import type { WorkbenchOptionEntry } from '../../../plugin-runtime/renderers/workbenchRendererFactory.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'

// WorkbenchOptionEntry 的类型正身已上移 plugin-runtime（B-2a：工厂契约面）；
// 本目录消费 DEFAULT_*_OPTIONS 常量与选择器逻辑。
export type { WorkbenchOptionEntry } from '../../../plugin-runtime/renderers/workbenchRendererFactory.ts'

export type WorkbenchOptionKind = 'model' | 'mode' | 'reasoning'

/** Fallback mode candidates for a provider that advertises none. Every id must stay acceptable to the mode write channel. */
export const DEFAULT_MODE_OPTIONS: readonly WorkbenchOptionEntry[] = Object.freeze([
  { id: 'default', label: '默认' },
  { id: 'auto', label: '全自动' },
  { id: 'accept_edits', label: '接受编辑' },
  { id: 'dont_ask', label: '不再询问' },
  { id: 'bypass', label: '绕过确认' },
])

export const DEFAULT_REASONING_OPTIONS: readonly WorkbenchOptionEntry[] = Object.freeze([
  { id: 'none', label: '关闭' },
  { id: 'minimal', label: 'minimal' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
  { id: 'ultra', label: 'ultra' },
])

const MODE_LABELS: Readonly<Record<string, string>> = {
  default: '默认权限', auto: '自动执行', accept_edit: '接受编辑', accept_edits: '接受编辑',
  dont_ask: '无需询问', edit: '编辑模式', bypass: '跳过确认', plan: '只做计划', ask: '逐项确认',
}

const REASONING_LABELS: Readonly<Record<string, string>> = {
  off: '关闭思考', none: '关闭思考', disabled: '关闭思考', minimal: '简短思考', low: '轻量思考',
  medium: '标准思考', high: '深入思考', xhigh: '深度思考', max: '最大强度', ultra: '极高强度',
  fast: '快速响应', balanced: '均衡思考', deep: '深度思考',
}

const MODEL_KEYS = new Set(['model', 'modelid', 'model_id', 'llm', 'llmmodel', 'modelname'])
const MODE_KEYS = new Set(['mode', 'modeid', 'mode_id', 'permissionmode', 'approvalmode'])

function normalizedKey(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]/g, '')
    : ''
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nestedValue(value: unknown): string | undefined {
  const direct = stringValue(value)
  if (direct) return direct
  const record = recordValue(value)
  if (!record) return undefined
  for (const key of ['value', 'valueId', 'id', 'key', 'name']) {
    const candidate = nestedValue(record[key])
    if (candidate) return candidate
  }
  return undefined
}

function choiceEntry(value: unknown): WorkbenchOptionEntry | undefined {
  const direct = stringValue(value)
  if (direct) return { id: direct, label: direct }
  const record = recordValue(value)
  if (!record) return undefined
  const id = nestedValue(record.id)
    ?? nestedValue(record.valueId)
    ?? nestedValue(record.value)
    ?? nestedValue(record.key)
    ?? nestedValue(record.name)
    ?? nestedValue(record.label)
  if (!id) return undefined
  const label = stringValue(record.label)
    ?? stringValue(record.name)
    ?? stringValue(record.title)
    ?? id
  return { id, label }
}

function choicesFromUnknown(value: unknown, depth = 0): WorkbenchOptionEntry[] {
  if (depth > 3 || value === undefined || value === null) return []
  if (Array.isArray(value)) return value.flatMap(item => {
    const entry = choiceEntry(item)
    return entry ? [entry] : []
  })
  const record = recordValue(value)
  if (!record) return []
  for (const key of ['options', 'choices', 'values', 'available', 'enum', 'items']) {
    if (record[key] !== undefined) {
      const entries = choicesFromUnknown(record[key], depth + 1)
      if (entries.length > 0) return entries
    }
  }
  // A JSON-schema enum is occasionally returned as a map keyed by value.
  const mapEntries = Object.entries(record)
    .map(([key, item]) => {
      const label = stringValue(item)
      return label ? { id: key, label } : undefined
    })
    .filter((item): item is WorkbenchOptionEntry => item !== undefined)
  return mapEntries
}

function optionIdentity(option: SessionConfigOption): string {
  const raw = option.raw ?? {}
  // Normalization assigns `unknown-option-N` when a provider omitted id/key.
  // Do not let that synthetic id hide a meaningful raw name/category.
  const candidates = [option.id, raw.id, raw.key, raw.name, raw.category, option.label]
  const candidate = candidates.find(value => {
    const text = stringValue(value)
    return Boolean(text && !/^unknown-option-\d+$/i.test(text))
  })
  return normalizedKey(candidate)
}

function optionKind(option: SessionConfigOption): WorkbenchOptionKind | undefined {
  const id = optionIdentity(option)
  const raw = option.raw ?? {}
  // Categories are semantic; model_config must not be mistaken for model.
  if (raw.category === 'model' || raw.category === 'mode') return raw.category
  if (raw.category === 'thought_level') return 'reasoning'
  if (raw.category === 'model_config') return undefined
  const label = normalizedKey(option.label)
  const rawText = Object.entries(raw)
    .filter(([key]) => ['id', 'key', 'name', 'label', 'category', 'title', 'description'].includes(key.toLowerCase()))
    .map(([, value]) => stringValue(value) ?? '')
    .join(' ')
  const combined = `${id} ${label} ${normalizedKey(rawText)}`
  if (MODEL_KEYS.has(id) || /(?:model|llm|模型)/i.test(combined)) return 'model'
  if (/(reason|think|thinking|effort|推理|思考)/i.test(combined)) return 'reasoning'
  if (MODE_KEYS.has(id) || /(?:mode|permission|approval|权限模式|模式|权限)/i.test(combined)) return 'mode'
  return undefined
}

function optionChoices(option: SessionConfigOption): WorkbenchOptionEntry[] {
  const fromSchema = choicesFromUnknown(option.schema)
  if (fromSchema.length > 0) return fromSchema
  return choicesFromUnknown(option.raw)
}

function optionCurrentValue(option: SessionConfigOption): string | undefined {
  return nestedValue(option.value)
    ?? nestedValue(option.raw?.currentValue)
    ?? nestedValue(option.raw?.current)
    ?? nestedValue(option.raw?.selected)
}

function mergeEntries(
  sources: readonly (readonly WorkbenchOptionEntry[])[],
  current?: string,
): readonly WorkbenchOptionEntry[] {
  const result: WorkbenchOptionEntry[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    for (const item of source) {
      const id = item.id.trim()
      if (!id) continue
      const key = id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(Object.freeze({ id, label: item.label.trim() || id }))
    }
  }
  if (current?.trim() && !seen.has(current.trim().toLowerCase())) {
    result.unshift(Object.freeze({ id: current.trim(), label: current.trim() }))
  }
  return Object.freeze(result)
}

function stringsToEntries(values: readonly string[], labels?: Readonly<Record<string, string>>): readonly WorkbenchOptionEntry[] {
  return values
    .map(value => value.trim())
    .filter(Boolean)
    .map(id => ({ id, label: labels?.[id] ?? id }))
}

export function resolveDocumentOptionEntries(
  options: readonly SessionConfigOption[] | undefined,
  kind: WorkbenchOptionKind,
): readonly WorkbenchOptionEntry[] {
  if (!options) return Object.freeze([])
  return options
    .filter(option => optionKind(option) === kind)
    .flatMap(option => {
      const choices = optionChoices(option)
      const current = optionCurrentValue(option)
      return choices.length > 0 ? choices : current ? [{ id: current, label: current }] : []
    })
}

function documentOptions(snapshot: WorkbenchRuntimeSnapshot, kind: WorkbenchOptionKind): readonly WorkbenchOptionEntry[] {
  return resolveDocumentOptionEntries(snapshot.document?.session.options, kind)
}

/** Read the provider-selected value from the normalized Workbench document. */
export function resolveDocumentOptionValue(
  options: readonly SessionConfigOption[] | undefined,
  kind: WorkbenchOptionKind,
): string | undefined {
  if (!options) return undefined
  const option = options.find(candidate => optionKind(candidate) === kind)
  return option ? optionCurrentValue(option) : undefined
}

function preferAdvertised(
  advertised: readonly WorkbenchOptionEntry[],
  fallback: readonly WorkbenchOptionEntry[],
): readonly WorkbenchOptionEntry[] {
  return advertised.length > 0 ? advertised : fallback
}

/**
 * A set that holds nothing but the current value is not an advertised choice
 * list. `optionIds` unshifts the current value into the snapshot list so the UI
 * can always render it, so a provider that advertises no choices looks like one
 * that advertised exactly the current one. A reasoning preference may still use
 * the fallback catalogue when a provider gives only its current value.
 */
function advertisedChoices(
  advertised: readonly WorkbenchOptionEntry[],
  current?: string,
): readonly WorkbenchOptionEntry[] {
  const key = current?.trim().toLowerCase()
  if (!key) return advertised
  return advertised.some(entry => entry.id.trim().toLowerCase() !== key) ? advertised : []
}

/**
 * Model candidates come only from advertised surfaces: the live session
 * snapshot (negotiation response) plus, for the empty-state draft binding, the
 * owning agent's advertised set (its sessionConfig buckets). When nothing is
 * advertised there is no candidate list — the hardcoded default catalogue was
 * removed because it named models the agent never declared.
 */
export function resolveModelOptionEntries(
  snapshot: WorkbenchRuntimeSnapshot,
  draft?: string,
  agentAdvertised?: readonly WorkbenchOptionEntry[],
): readonly WorkbenchOptionEntry[] {
  const advertised = mergeEntries([
    stringsToEntries(snapshot.availableModels),
    documentOptions(snapshot, 'model'),
    ...(agentAdvertised ? [agentAdvertised] : []),
  ])
  return mergeEntries([advertised], draft || snapshot.activeModel)
}

export function resolveModeOptionEntries(snapshot: WorkbenchRuntimeSnapshot, draft?: string): readonly WorkbenchOptionEntry[] {
  const advertised = mergeEntries([
    stringsToEntries(snapshot.availableModes, MODE_LABELS),
    documentOptions(snapshot, 'mode'),
  ])
  return mergeEntries([
    snapshot.sessionId ? advertised : preferAdvertised(advertised, DEFAULT_MODE_OPTIONS),
  ], draft || snapshot.activeMode)
}

export function resolveReasoningOptionEntries(snapshot: WorkbenchRuntimeSnapshot, current?: string): readonly WorkbenchOptionEntry[] {
  const advertised = documentOptions(snapshot, 'reasoning')
  // ★ 与权限 / 模型两条**保持对称**：清单里除当前值外什么都没有 ⇒ 视作"没上报"⇒ 用兜底表。
  //   当前值的比对基准必须**取文档值**（调用方通常已传，缺省时自读）：拿不到基准时
  //   `advertisedChoices` 会原样放行，守卫静默失效，且单测若喂了非空的 current 仍会绿。
  const currentValue = current ?? resolveDocumentOptionValue(snapshot.document?.session.options, 'reasoning')
  return mergeEntries([
    preferAdvertised(advertisedChoices(advertised, currentValue), DEFAULT_REASONING_OPTIONS),
  ], currentValue)
}

export function optionLabel(kind: WorkbenchOptionKind, id: string, fallback?: string): string {
  const value = id.trim()
  if (!value) return fallback ?? ''
  if (kind === 'mode') return MODE_LABELS[value.toLowerCase()] ?? fallback ?? value
  if (kind === 'reasoning') return REASONING_LABELS[value.toLowerCase()] ?? fallback ?? value
  return fallback ?? value
}

export function isReasoningOption(option: SessionConfigOption): boolean {
  return optionKind(option) === 'reasoning'
}

/**
 * #51：中控区的失败提示只展示稳定 code + 简短说明。后端 `model_not_advertised`
 * 一类错误会把整份宣告列表拼进 message（诊断有用、UI 有害）；长文本留在浮层
 * title 里，正文截断到 80 字符。
 */
export function shortControlCenterError(message: string | undefined, fallback: string): string {
  const text = (message ?? '').trim()
  if (!text) return fallback
  const code = text.split(':')[0]?.trim() ?? ''
  const known: Readonly<Record<string, string>> = {
    model_not_advertised: '模型未被该会话宣告，无法切换',
    reasoning_not_advertised: '思考等级未被该会话宣告，无法切换',
    model_switching_unavailable: '该会话没有可切换的模型面',
  }
  const brief = (code && known[code]) || text
  return brief.length > 80 ? `${brief.slice(0, 79)}…` : brief
}

/**
 * Session-start model/mode/reasoning options are rendered by the control
 * center.  Keeping them out of the chat document surface prevents the ACP
 * negotiation response from becoming a second, persistent "配置 / 保存 /
 * select" form below the conversation while preserving the normalized option
 * facts for selectors and command validation.
 */
export function isControlCenterConfigOption(option: SessionConfigOption): boolean {
  const kind = optionKind(option)
  return kind === 'model' || kind === 'mode' || kind === 'reasoning'
}
