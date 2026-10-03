import { createSheetState, type SheetState } from './sheetState.ts'
import {  type SheetRecord } from '../../contracts/sheets.ts'
import { isSheetKind } from '../../plugin-runtime/workspaces/workspaceRegistry.ts'
import { resolveWorkspace } from '../../plugin-runtime/workspaces/workspaceRegistry.ts'

// W1-01：schema v1→v2（F1-A 方案 A + F2-B 布局搬家）——9 kind 清洗旧 kind；
// v2 envelope 曾加 layout 三字段（sidebarWidth/sidebarCollapsed/rightPanelCollapsed），
// #538 起布局真源收敛为 layoutRailsStore（pylon-workspace-layout-v3），信封不再读写
// layout 键：旧信封里的 layout 残留被静默忽略，其余字段照常。v1 parser 保留为迁移源，
// parse 按 version 分支，serialize 只输出 v2。
export const SHEET_SCHEMA_VERSION = 2
export const SHEET_STORAGE_KEY = 'pylon-workspace-sheets'

export interface SheetWorkspaceState {
  activeProfileId?: string
  activeSessionId?: string
}

export interface PersistedSheetState extends SheetState {
  agentStates: Record<string, SheetWorkspaceState>
}

interface SheetEnvelopeV2 {
  version: typeof SHEET_SCHEMA_VERSION
  state: PersistedSheetState
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const EMPTY_PERSISTED_SHEET_STATE: PersistedSheetState = Object.freeze({
  sheets: [],
  activeSheetId: null,
  recentlyClosed: [],
  agentStates: {},
})

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

function normalizeSheet(value: unknown): SheetRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id)
  const title = text(raw.title)
  const kind = raw.kind
  if (!id || !title || !isSheetKind(kind)) return null
  const workspace = resolveWorkspace(kind)
  if (!workspace) return null
  try {
    workspace.deserialize(raw.state)
  } catch {
    return null
  }

  const metadata = raw.metadata && typeof raw.metadata === 'object'
    ? Object.fromEntries(
        Object.entries(raw.metadata).filter(([key, item]) => typeof key === 'string' && typeof item === 'string'),
      )
    : undefined

  return {
    id,
    kind,
    title,
    ...(text(raw.agentId) ? { agentId: text(raw.agentId) } : {}),
    ...(text(raw.singletonKey) ? { singletonKey: text(raw.singletonKey) } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
    createdAt: timestamp(raw.createdAt),
    lastFocusedAt: timestamp(raw.lastFocusedAt),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(raw.state !== undefined ? { state: raw.state } : {}),
  }
}

function normalizeAgentState(value: unknown): SheetWorkspaceState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const activeProfileId = text(raw.activeProfileId)
  const activeSessionId = text(raw.activeSessionId)
  if (!activeProfileId && !activeSessionId) return {}
  return {
    ...(activeProfileId ? { activeProfileId } : {}),
    ...(activeSessionId ? { activeSessionId } : {}),
  }
}

function normalizeState(value: unknown, agentIds?: readonly string[]): PersistedSheetState {
  if (!value || typeof value !== 'object') return EMPTY_PERSISTED_SHEET_STATE
  const raw = value as Record<string, unknown>
  const allowedAgents = agentIds ? new Set(agentIds.filter(id => typeof id === 'string' && id.trim())) : null
  const rawSheets = Array.isArray(raw.sheets) ? raw.sheets : []
  const sheets = rawSheets
    .map(normalizeSheet)
    .filter((sheet): sheet is SheetRecord => Boolean(sheet))
    .filter(sheet => !allowedAgents || sheet.kind !== 'agent' || (sheet.agentId && allowedAgents.has(sheet.agentId)))
  const recentlyClosed = Array.isArray(raw.recentlyClosed)
    ? raw.recentlyClosed.map(normalizeSheet).filter((sheet): sheet is SheetRecord => Boolean(sheet))
    : []
  const base = createSheetState(sheets, text(raw.activeSheetId) || null, recentlyClosed)

  const rawAgentStates = raw.agentStates && typeof raw.agentStates === 'object' ? raw.agentStates : {}
  const agentStates: Record<string, SheetWorkspaceState> = {}
  for (const [agentId, rawAgentState] of Object.entries(rawAgentStates)) {
    if (allowedAgents && !allowedAgents.has(agentId)) continue
    const normalized = normalizeAgentState(rawAgentState)
    if (normalized) agentStates[agentId] = normalized
  }

  return { ...base, agentStates }
}

export interface SheetHydrateResult {
  state: PersistedSheetState
  /** 输入为 v1：true——调用方应立即 serialize 写回 v2 */
  migrated: boolean
}

/**
 * 解析 v2 envelope；v1 输入走迁移（normalize sheets 清洗旧 kind）。损坏/未知 version
 * 返回空状态（不抛错）。#538：旧信封的 layout 键被忽略（布局真源在 layoutRailsStore）。
 */
export function parseSheetStateV2(raw: string | null, agentIds?: readonly string[]): SheetHydrateResult {
  if (!raw) return { state: EMPTY_PERSISTED_SHEET_STATE, migrated: false }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { state: EMPTY_PERSISTED_SHEET_STATE, migrated: false }
    const envelope = parsed as Record<string, unknown>
    if (envelope.version === SHEET_SCHEMA_VERSION) {
      return {
        state: normalizeState(envelope.state, agentIds),
        migrated: false,
      }
    }
    // v1 迁移（细化路线 §4 步骤 4）：先 normalize sheets
    if (envelope.version === 1) {
      return {
        state: normalizeState(envelope.state, agentIds),
        migrated: true,
      }
    }
    return { state: EMPTY_PERSISTED_SHEET_STATE, migrated: false }
  } catch {
    return { state: EMPTY_PERSISTED_SHEET_STATE, migrated: false }
  }
}

/** 只输出 v2，不再生成 v1（细化路线 §4 步骤 6）；#538 起信封不含 layout */
export function serializeSheetStateV2(state: PersistedSheetState): string {
  const envelope: SheetEnvelopeV2 = { version: SHEET_SCHEMA_VERSION, state }
  return JSON.stringify(envelope)
}

export function persistSheetStateV2(storage: StorageLike, state: PersistedSheetState): boolean {
  try {
    storage.setItem(SHEET_STORAGE_KEY, serializeSheetStateV2(normalizeState(state)))
    return true
  } catch {
    // 存储不可用/写满：写盘失败不应让 workspace action（内核 setState 内）抛异常；
    // 返回 false 供调用方把"未保存"提升为可见状态（报告 FE-AUD-001/阶段 1A.5）
    return false
  }
}

export function loadSheetStateV2(storage: StorageLike, agentIds?: readonly string[]): SheetHydrateResult {
  let raw: string | null = null
  try { raw = storage.getItem(SHEET_STORAGE_KEY) } catch { /* 存储不可用：按空状态处理 */ }
  return parseSheetStateV2(raw, agentIds)
}

// ── v1 保留（迁移源 fixture）：旧 schema normalize/roundtrip 由 test-sheet-persistence 锁定 ──

interface SheetEnvelopeV1 {
  version: 1
  state: PersistedSheetState
}

export function serializeSheetStateV1(state: PersistedSheetState): string {
  const envelope: SheetEnvelopeV1 = { version: 1, state }
  return JSON.stringify(envelope)
}

export function parseSheetStateV1(raw: string | null, agentIds?: readonly string[]): PersistedSheetState {
  if (!raw) return EMPTY_PERSISTED_SHEET_STATE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return EMPTY_PERSISTED_SHEET_STATE
    const envelope = parsed as Record<string, unknown>
    if (envelope.version !== 1) return EMPTY_PERSISTED_SHEET_STATE
    return normalizeState(envelope.state, agentIds)
  } catch {
    return EMPTY_PERSISTED_SHEET_STATE
  }
}
