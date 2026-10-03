import { createSolidStoreKernel, type SolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'
import { createSheetState, sheetReducer } from './sheetState.ts'
import {
  loadSheetStateV2,
  persistSheetStateV2,
  type PersistedSheetState,
  type SheetWorkspaceState,
} from './sheetPersistence.ts'
import { pushTouchedFile, type TouchedFile } from '../../infrastructure/acp/touchedFiles.ts'
import type { SheetInput, SheetId } from '../../contracts/sheets.ts'
import type { AgentContext, AgentContextKey } from '../agent/agentContext.ts'
import { toAgentContextKey } from '../agent/agentContext.ts'
import { readLegacyLayoutSnapshot } from '../../infrastructure/persistence/legacyKeyMigration.ts'
import { railPersistLayoutMaterialized, useRightRailStore } from './layoutRailsStore.ts'
import { normalizeFilePath } from '../file/fileRelations.ts'
import { resolveWorkspace } from '../../plugin-runtime/workspaces/workspaceRegistry.ts'

/** I01-W3：touchedFiles 刷新版本戳 key——context key + normalized path 二元（禁止冒号 split）。 */
export function touchedFileVersionKey(context: AgentContext, path: string): string {
  return JSON.stringify([toAgentContextKey(context), normalizeFilePath(path)])
}

/**
 * workspaceStore — Workspace Sheet 状态域。
 *
 * 承载：workspaceSheets / sheetAgentStates，持久化于 `pylon-workspace-sheets`（schema v2）。
 * 布局三字段（sidebarWidth/sidebarCollapsed/rightPanelCollapsed）曾在此镜像双写并随信封
 * 持久化（W1-01 F2-B 从主题迁出），#538 起退役：壳层布局真源收敛为 layoutRailsStore
 * （`pylon-workspace-layout-v3`），信封不再承载 layout。
 */

interface WorkspaceStoreState {
  workspaceSheets: ReturnType<typeof createSheetState>
  sheetAgentStates: Record<string, SheetWorkspaceState>
  /** FE-AUD-001：最近一次工作区写盘失败的可见状态（null = 无失败） */
  lastPersistError: string | null
  hydrateWorkspaceSheets: (agentIds?: readonly string[]) => void
  openSheet: (sheet: SheetInput) => SheetId | null
  focusSheet: (id: SheetId) => void
  toggleSheetPin: (id: SheetId) => void
  closeSheet: (id: SheetId) => void
  closeOtherSheets: (id: SheetId) => void
  closeRightSheets: (id: SheetId) => void
  reopenSheet: () => SheetId | null
  setSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void
  /** W2-04：原子合并 sheet metadata（openTabs/activeFile 等）并持久化 */
  patchSheetMetadata: (id: SheetId, partial: Record<string, string>) => void
  /** Workspace definition state 经 codec 合并后持久化。 */
  patchSheetState: (id: SheetId, partial: Record<string, unknown>) => void
  /** W2-09 + I01-W3：工具改动文件（会话级 50 LRU，不持久化）+ 刷新版本戳；
   *  按 AgentContextKey（agentId+source）隔离——双 Agent 同名 source 文件状态不共享 */
  touchedFiles: Record<AgentContextKey, TouchedFile[]>
  touchVersions: Record<string, number>
  recordTouchedFile: (context: AgentContext, file: Omit<TouchedFile, 'source'>) => void
  /** FE-AUD-005：agents 到达后仅 prune 无效 agent sheet（不重复全量 hydrate） */
  pruneAgentSheets: (agentIds: readonly string[]) => void
  patchSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void
  patchSheetAgentStates: (agentStates: Record<string, SheetWorkspaceState>) => void
}

/** FE-AUD-001：唯一 Workspace 持久化快照构造（action 禁止自拼 envelope） */
function buildWorkspaceSnapshot(state: WorkspaceStoreState): PersistedSheetState {
  return { ...state.workspaceSheets, agentStates: state.sheetAgentStates }
}

/**
 * FE-AUD-001：原子工作区提交——先构造完整 next state，再持久化 next state，
 * 最后返回 store patch；写盘失败不阻断内存操作，但把"未保存"提升为可见状态。
 */
function commitWorkspaceMutation(state: WorkspaceStoreState, patch: Partial<WorkspaceStoreState>): Partial<WorkspaceStoreState> {
  const next = { ...state, ...patch }

  const ok = persistSheetStateV2(localStorage, buildWorkspaceSnapshot(next))
  if (!ok) return { ...patch, lastPersistError: '工作区状态未能保存到本地存储' }
  // 写盘恢复成功：清掉旧错误提示
  return state.lastPersistError ? { ...patch, lastPersistError: null } : patch
}

// #515 批0：zustand → Solid 内核置换（对外签名不变；hook shim 已随 R4 收口拆除）。
const workspaceKernel = createSolidStoreKernel<WorkspaceStoreState>({
  workspaceSheets: createSheetState(),
  sheetAgentStates: {},
  touchedFiles: {},
  touchVersions: {},
  lastPersistError: null,
  hydrateWorkspaceSheets: (agentIds) => workspaceKernel.setState(() => {
    const result = loadSheetStateV2(localStorage, agentIds)
    // #538：hydrate 不再回灌 layoutRailsStore——布局真源只在 rail 自己的持久化面
    // （pylon-workspace-layout-v3 + 模块加载期的一次性 legacy 快照读），workspace
    // 快照里旧信封的 layout 键已被解析层忽略，回灌只会踩掉 rail 上的新值。
    // 例外（复查 R1-P1-2）：跨版本升级用户（上次运行早于 v3 键存在、迁移标记却已在）
    // 的 legacy 快照只被模块加载期消费过一次且未落 v3 键——此处检测 v3 缺席则重播种
    // 一次并经 writeBack 物化，否则第二次启动布局回落默认。v3 键在场时绝不触碰 rail。
    try {
      if (!railPersistLayoutMaterialized()) {
        const legacy = readLegacyLayoutSnapshot(localStorage, { ignoreMarker: true })
        if (legacy.leftWidth !== undefined || legacy.leftCollapsed !== undefined || legacy.rightWidth !== undefined || legacy.rightCollapsed !== undefined) {
          useRightRailStore.getState().hydrateLegacyLayout(legacy)
        }
      }
    } catch {
      // 布局播种失败不阻塞工作区 hydrate
    }
    // 迁移写回失败不能让 hydrate 抛错；内存仍返回迁移后的 v2 状态
    try {
      if (result.migrated) persistSheetStateV2(localStorage, result.state)
    } catch {
      // 可忽略：写回失败只是延迟持久化——内存已是迁移后 v2 状态（下方立即返回），
      // 后续任意 commitWorkspaceMutation 会重新写盘，失败时经 lastPersistError 可见；
      // persistSheetStateV2 自身已把存储异常收敛为 false 返回，此 catch 仅兜底
      // 其余意外异常，避免内核 setState（hydrate）中途抛错。
    }
    return {
      workspaceSheets: result.state,
      sheetAgentStates: result.state.agentStates,
    }
  }),
  openSheet: (sheet) => {
    const state = workspaceKernel.getState()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'open', sheet, now: Date.now() })
    workspaceKernel.setState(commitWorkspaceMutation(state, { workspaceSheets }))
    return workspaceSheets.activeSheetId
  },
  focusSheet: (id) => workspaceKernel.setState(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'focus', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  toggleSheetPin: (id) => workspaceKernel.setState(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'togglePin', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  closeSheet: (id) => workspaceKernel.setState(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'close', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  closeOtherSheets: (id) => workspaceKernel.setState(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeOthers', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  closeRightSheets: (id) => workspaceKernel.setState(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeRight', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  reopenSheet: () => {
    const state = workspaceKernel.getState()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'reopen', now: Date.now() })
    workspaceKernel.setState(commitWorkspaceMutation(state, { workspaceSheets }))
    return workspaceSheets.activeSheetId
  },
  recordTouchedFile: (context, file) => workspaceKernel.setState(state => {
    const contextKey = toAgentContextKey(context)
    const versionKey = touchedFileVersionKey(context, file.path)
    const touchedFiles = { ...state.touchedFiles, [contextKey]: pushTouchedFile(state.touchedFiles[contextKey] ?? [], { ...file, source: context.source }) }
    const touchVersions = { ...state.touchVersions, [versionKey]: (state.touchVersions[versionKey] ?? 0) + 1 }
    return { touchedFiles, touchVersions }
  }),
  patchSheetMetadata: (id, partial) => workspaceKernel.setState(state => {
    const sheets = state.workspaceSheets.sheets.map(sheet => sheet.id === id
      ? { ...sheet, metadata: { ...sheet.metadata, ...partial }, lastFocusedAt: Date.now() }
      : sheet)
    const workspaceSheets = { ...state.workspaceSheets, sheets }
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  patchSheetState: (id, partial) => workspaceKernel.setState(state => {
    const sheets = state.workspaceSheets.sheets.map(sheet => {
      if (sheet.id !== id) return sheet
      const definition = resolveWorkspace(sheet.kind)
      if (!definition) return sheet
      const current = definition.deserialize(sheet.state)
      const merged = { ...(current && typeof current === 'object' ? current : {}), ...partial }
      return { ...sheet, state: definition.serialize(merged), lastFocusedAt: Date.now() }
    })
    const workspaceSheets = { ...state.workspaceSheets, sheets }
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  setSheetAgentState: (agentId, partial) => workspaceKernel.setState(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    return commitWorkspaceMutation(state, { sheetAgentStates })
  }),
  pruneAgentSheets: (agentIds) => workspaceKernel.setState(state => {
    const allowed = new Set(agentIds)
    const sheets = state.workspaceSheets.sheets.filter(sheet =>
      sheet.kind !== 'agent' || (sheet.agentId !== undefined && allowed.has(sheet.agentId)))
    // createSheetState 收尾：activeSheetId 指向被删 sheet 时回退到保留的最后一个
    const workspaceSheets = createSheetState(sheets, state.workspaceSheets.activeSheetId, state.workspaceSheets.recentlyClosed)
    const sheetAgentStates = Object.fromEntries(
      Object.entries(state.sheetAgentStates).filter(([agentId]) => allowed.has(agentId)))
    return commitWorkspaceMutation(state, { workspaceSheets, sheetAgentStates })
  }),
  patchSheetAgentState: (agentId, partial) => workspaceKernel.setState(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    return commitWorkspaceMutation(state, { sheetAgentStates })
  }),
  patchSheetAgentStates: (agentStates) => workspaceKernel.setState(state => commitWorkspaceMutation(state, { sheetAgentStates: agentStates })),
})

export const useWorkspaceStore: SolidStoreKernel<WorkspaceStoreState> = workspaceKernel
