/**
 * Agent-scoped advertised model set for the empty-state control center.
 *
 * ACP advertises model choices per session (session/new response,
 * config_option_update). The runtime store keeps those facts in
 * sessionConfig buckets keyed by [agentId, source] (P56/D3.3), so the union of
 * the buckets belonging to one agent is the closest available "该 agent 可用的
 * 模型集合" before a session exists. modelChoices (id/label) is the label
 * truth source; plain `models` ids are the fallback projection.
 *
 * Lives outside src/renderers/**: the renderer subtree must not import the
 * runtime store (check-runtime-boundaries), so the suite host subscribes and
 * hands the renderer plain frozen entries via WorkbenchMountInput.
 */
import { useRuntimeStore, type SessionConfig } from '../../domains/runtime/runtimeStore.ts'
import { extractModelConfig, type ConfigOption } from '../../infrastructure/acp/chatContracts.ts'
import type { WorkbenchOptionEntry } from '../../plugin-runtime/renderers/workbenchRendererFactory.ts'

function bucketAgentId(key: string): string | undefined {
  try {
    const parsed = JSON.parse(key)
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined
  } catch {
    return undefined
  }
}

function entriesFromConfig(config: SessionConfig | undefined): readonly WorkbenchOptionEntry[] {
  if (!config) return []
  const choices = config.modelChoices?.length ? config.modelChoices : undefined
  const ids = choices ? choices.map(choice => choice.id) : config.models
  const result: WorkbenchOptionEntry[] = []
  const seen = new Set<string>()
  for (const id of ids ?? []) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue
    seen.add(trimmed.toLowerCase())
    const label = choices?.find(choice => choice.id === trimmed)?.label
    result.push(Object.freeze({ id: trimmed, label: label?.trim() || trimmed }))
  }
  return result
}

function computeEntries(config: Record<string, SessionConfig>, agentId: string): readonly WorkbenchOptionEntry[] {
  // #53：探测结果（后端一次性会话读到的广告面）压在历史桶并集之上——同 id 时
  // 探测 label 胜出，因为它是当次建立响应的权威形状，而桶可能来自旧响应。
  const merged = new Map<string, WorkbenchOptionEntry>()
  for (const [key, value] of Object.entries(config)) {
    if (bucketAgentId(key) !== agentId) continue
    for (const entry of entriesFromConfig(value)) {
      if (!merged.has(entry.id.toLowerCase())) merged.set(entry.id.toLowerCase(), entry)
    }
  }
  for (const entry of probedEntries(agentId)) {
    merged.set(entry.id.toLowerCase(), entry)
  }
  return Object.freeze([...merged.values()])
}

// —— #53 探测缓存（模块级，内存即弃；探测失败静默，不影响桶并集兜底）——

const PROBE_TTL_MS = 5 * 60_000
const probedByAgent = new Map<string, { entries: readonly WorkbenchOptionEntry[]; at: number }>()
/** 空探测结果也占位：TTL 内不再重复请求一个「无可配置项」的 agent。 */
const probedAtByAgent = new Map<string, number>()
const probesInFlight = new Set<string>()
/** 探测结果落位/过期都会改变合并输出——版本号使 WeakMap 缓存行失效。 */
let probeVersion = 0

function probedEntries(agentId: string): readonly WorkbenchOptionEntry[] {
  const cached = probedByAgent.get(agentId)
  if (!cached) return []
  if (Date.now() - cached.at > PROBE_TTL_MS) return []
  return cached.entries
}

/** 探测结果注入（由持有 transport 的宿主在探测成功后调用；entries 需已去重冻结）。 */
export function setAgentProbedModels(agentId: string, entries: readonly WorkbenchOptionEntry[]): void {
  probedByAgent.set(agentId, Object.freeze({ entries, at: Date.now() }))
  probedAtByAgent.set(agentId, Date.now())
  probeVersion += 1
}

/** TTL 内已探测过（含空结果）则不再重复请求。 */
export function agentProbeFresh(agentId: string): boolean {
  const at = probedAtByAgent.get(agentId)
  return at !== undefined && Date.now() - at <= PROBE_TTL_MS
}

export function agentProbeInFlight(agentId: string): boolean {
  return probesInFlight.has(agentId)
}

export function markProbeInFlight(agentId: string, inFlight: boolean): void {
  if (inFlight) probesInFlight.add(agentId)
  else probesInFlight.delete(agentId)
}

/** 探测失败也占位（不产生候选）：TTL 内不重试，空态继续用桶并集兜底。 */
export function markProbeUnavailable(agentId: string): void {
  probedAtByAgent.set(agentId, Date.now())
}

/** 测试隔离：清空探测缓存与版本号（生产路径不调用）。 */
export function resetAgentProbeForTests(): void {
  probedByAgent.clear()
  probedAtByAgent.clear()
  probesInFlight.clear()
  probeVersion += 1
}

/**
 * 探测快照 → 候选条目：configOptions 的 model option choices 带 label（权威形状）；
 * 无标准 option 时退探测摘要的 modelChoices machine id。由持有 transport 的宿主
 * 在探测成功后调用。
 */
export function noteAgentSelectorsSnapshot(agentId: string, snapshot: { configOptions?: readonly unknown[]; modelChoices?: readonly string[] }): void {
  const configOptions = Array.isArray(snapshot.configOptions)
    ? snapshot.configOptions as unknown as ConfigOption[]
    : []
  const choices = extractModelConfig(configOptions).modelChoices ?? []
  const entries: WorkbenchOptionEntry[] = []
  const seen = new Set<string>()
  for (const choice of choices) {
    const id = typeof choice.id === 'string' ? choice.id.trim() : ''
    if (!id || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    entries.push(Object.freeze({ id, label: choice.label?.trim() || id }))
  }
  for (const raw of snapshot.modelChoices ?? []) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    entries.push(Object.freeze({ id, label: id }))
  }
  setAgentProbedModels(agentId, Object.freeze(entries))
}

// Several Agent Sheets read the same store concurrently. A single last-agent
// cache makes their snapshot reads evict each other and re-fire the Solid
// signal subscribers (which compare by reference) in a loop.
// Weak keys release old immutable config snapshots when the store replaces them.
// Cached entries are versioned with the probe counter: a probe landing must
// invalidate the merge even when the store snapshot object is unchanged.
const entriesByConfig = new WeakMap<Record<string, SessionConfig>, Map<string, { entries: readonly WorkbenchOptionEntry[]; version: number }>>()

/**
 * Returns the agent's advertised entries with a cached identity so Solid
 * signal subscribers can compare by reference: the same
 * sessionConfig object, agent id, and probe version always yield the same
 * frozen array.
 */
export function agentAdvertisedModelEntries(agentId: string): readonly WorkbenchOptionEntry[] {
  const sessionConfig = useRuntimeStore.getState().sessionConfig
  let entriesByAgent = entriesByConfig.get(sessionConfig)
  if (!entriesByAgent) {
    entriesByAgent = new Map()
    entriesByConfig.set(sessionConfig, entriesByAgent)
  }
  const cached = entriesByAgent.get(agentId)
  if (cached && cached.version === probeVersion) return cached.entries
  const entries = computeEntries(sessionConfig, agentId)
  entriesByAgent.set(agentId, { entries, version: probeVersion })
  return entries
}
