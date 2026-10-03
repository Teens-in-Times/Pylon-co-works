/**
 * 配置导出/导入：把应用配置整体备份为 JSON，可在本机迁移或分享。
 *
 * 覆盖的持久化 key：主题（pylon-theme）、工作区 sheets（pylon-workspace-sheets）、
 * 窗口尺寸（pylon-window-size）、会话（pylon-sessions）、Profile（pylon-profiles，
 * FE-AUD-002）。
 * 其他 key（pylon-msgs-* 等运行态；宠物链 pylon-pet-v3 已随 #520 K 域退役）不导出。
 * I14-W8：Tauri 模式导出聚合后端 versioned user store 的 profiles/sessions envelope
 * （权威源）；导入预检对 profiles/sessions 值做结构校验（损坏拒绝、legacy 形状兼容）。
 */
import { PROFILE_STORAGE_KEY } from '../domains/identity/profilePersistence'
import { SESSION_STORAGE_KEY } from '../domains/identity/sessionPersistence'
import { RETENTION_STORAGE_KEY } from '../domains/overview/retentionPolicy.ts'
import { isRetentionPolicyValid, type RetentionPolicy } from '../domains/overview/retentionPolicy.ts'

export const CONFIG_ENVELOPE_APP = 'pylon'
export const CONFIG_ENVELOPE_VERSION = 1

// I13-W6：保留策略纳入通用配置导出/导入（T13-7：导入先 validate；损坏拒绝）。
// Gateway secret 天然不导出（凭据在 CredentialStore 文件，不在配置 keys）。
export const CONFIG_STORAGE_KEYS = [
  'pylon-theme',
  'pylon-workspace-sheets',
  'pylon-window-size',
  'pylon-sessions',
  'pylon-profiles',
  RETENTION_STORAGE_KEY,
] as const

export interface ConfigEnvelope {
  app: typeof CONFIG_ENVELOPE_APP
  version: number
  exportedAt: string
  data: Record<string, string>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function buildExportPayload(storage: StorageLike): string {
  const data: Record<string, string> = {}
  for (const key of CONFIG_STORAGE_KEYS) {
    const raw = storage.getItem(key)
    if (raw !== null) data[key] = raw
  }
  const envelope: ConfigEnvelope = {
    app: CONFIG_ENVELOPE_APP,
    version: CONFIG_ENVELOPE_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
  return JSON.stringify(envelope, null, 2)
}

/** I14-W8：导出后端用户数据源（返回 envelope payload 对象或 null）。 */
export interface ExportBackend {
  loadProfiles: () => Promise<Record<string, unknown> | null | undefined>
  loadSessions: () => Promise<Record<string, unknown> | null | undefined>
  /** I13-W6：Tauri 模式保留策略后端权威 payload（retention_policy_get）；browser 缺省。 */
  loadRetention?: () => Promise<{ payload: string } | null>
}

/**
 * I14-W8：导出（Tauri 模式聚合后端用户数据）——后端 versioned store 为权威源，
 * profiles/sessions envelope payload 覆盖 localStorage 值（导入后经 W6 hydrateFromLocal
 * 写穿回后端）。Gateway secret 天然不导出（凭据在 CredentialStore 文件，不在配置 keys）。
 * 纯前端 + 复用既有 user_data_load；browser 模式无 backend → 与原 buildExportPayload 等价。
 */
export async function buildExportPayloadAsync(
  storage: StorageLike,
  backend?: ExportBackend,
): Promise<string> {
  const data: Record<string, string> = {}
  for (const key of CONFIG_STORAGE_KEYS) {
    const raw = storage.getItem(key)
    if (raw !== null) data[key] = raw
  }
  if (backend) {
    const profiles = await backend.loadProfiles()
    if (profiles) data[PROFILE_STORAGE_KEY] = JSON.stringify(profiles)
    const sessions = await backend.loadSessions()
    if (sessions) data[SESSION_STORAGE_KEY] = JSON.stringify(sessions)
    const retention = await backend.loadRetention?.()
    if (retention) data[RETENTION_STORAGE_KEY] = retention.payload
  }
  const envelope: ConfigEnvelope = {
    app: CONFIG_ENVELOPE_APP,
    version: CONFIG_ENVELOPE_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
  return JSON.stringify(envelope, null, 2)
}

export type ImportResult = { ok: true; keys: string[] } | { ok: false; error: string }

/** 全量预检（报告 1B.7）：parse envelope + key 白名单 + 值校验，收集 data 但不写盘 */
export type ImportPreflight = { ok: true; data: Record<string, string>; keys: string[] } | { ok: false; error: string }

const MAX_IMPORT_BYTES = 512 * 1024

/**
 * I14-W8：profiles/sessions envelope 值结构校验——损坏（非数组/缺 id）拒绝；
 * legacy 形状（v1 无 agentId 会话、裸数组）兼容（只要 id 字段齐全）。
 * 与解析宽容不同：预检必须能识别损坏（避免坏数据写盘/写后端后靠 normalize 静默兜底）。
 */
function validateEnvelopeArray(raw: string, arrayKey: 'profiles' | 'sessions'): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  const array = (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)[arrayKey]))
    ? (parsed as Record<string, unknown>)[arrayKey] as unknown[]
    : Array.isArray(parsed) ? parsed : null
  if (!array) return false
  return array.every(item =>
    !!item && typeof item === 'object'
    && typeof (item as Record<string, unknown>).id === 'string'
    && ((item as Record<string, unknown>).id as string).length > 0,
  )
}

export function preflightImportPayload(json: string): ImportPreflight {
  if (json.length > MAX_IMPORT_BYTES) return { ok: false, error: '配置文件过大（>512KB）' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: '不是有效的 JSON' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: '配置格式无效' }
  const envelope = parsed as Partial<ConfigEnvelope>
  if (envelope.app !== CONFIG_ENVELOPE_APP || envelope.version !== CONFIG_ENVELOPE_VERSION) {
    return { ok: false, error: '不是 Pylon 配置文件，或版本不受支持' }
  }
  const data = envelope.data
  if (!data || typeof data !== 'object') return { ok: false, error: '配置内容缺失' }
  // key 白名单：只接受 CONFIG_STORAGE_KEYS（导出对等集合），
  // 防恶意/损坏文件注入任意 localStorage key（如 pylon-msgs-* 运行态）
  const allowed = new Set<string>(CONFIG_STORAGE_KEYS)
  const collected: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    if (allowed.has(key) && typeof value === 'string') collected[key] = value
  }
  const keys = Object.keys(collected)
  if (keys.length === 0) return { ok: false, error: '没有可导入的配置项' }
  // I14-W8：profiles/sessions 值结构校验（损坏拒绝；legacy 形状兼容）
  if (collected[PROFILE_STORAGE_KEY] !== undefined && !validateEnvelopeArray(collected[PROFILE_STORAGE_KEY], 'profiles')) {
    return { ok: false, error: '配置中的 Profile 数据损坏' }
  }
  if (collected[SESSION_STORAGE_KEY] !== undefined && !validateEnvelopeArray(collected[SESSION_STORAGE_KEY], 'sessions')) {
    return { ok: false, error: '配置中的 Session 数据损坏' }
  }
  // I13-W6：保留策略先 validate（T13-7，D-15）——损坏/越档拒绝导入，不静默回退永久落盘
  if (collected[RETENTION_STORAGE_KEY] !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(collected[RETENTION_STORAGE_KEY])
    } catch {
      return { ok: false, error: '配置中的保留策略损坏' }
    }
    // CR-002：字面 "null" 等非对象值不得走 isRetentionPolicyValid（会读 null.mode）
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: '配置中的保留策略损坏' }
    }
    const partial = parsed as Partial<RetentionPolicy>
    const policy: RetentionPolicy = { mode: partial.mode, days: partial.days, count: partial.count } as RetentionPolicy
    if (!isRetentionPolicyValid(policy)) {
      return { ok: false, error: '配置中的保留策略越档或缺失档位' }
    }
  }
  return { ok: true, data: collected, keys }
}

/** 旧语义入口（保留兼容）：逐 key 写，单个失败跳过——F17 事务用 preflight + 全量写 + 回滚 */
export function applyImportPayload(storage: StorageLike, json: string): ImportResult {
  const preflight = preflightImportPayload(json)
  if (!preflight.ok) return { ok: false, error: preflight.error }
  for (const [key, value] of Object.entries(preflight.data)) {
    try {
      storage.setItem(key, value)
    } catch {
      // 单个 key 写入失败不阻断其余
    }
  }
  return { ok: true, keys: preflight.keys }
}

export function configFileName(): string {
  const today = new Date().toISOString().slice(0, 10)
  return `pylon-config-${today}.json`
}
