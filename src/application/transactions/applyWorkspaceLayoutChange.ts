import { useRightRailStore } from '../../domains/workspace/layoutRailsStore.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'

export interface WorkspaceLayoutPatch {
  readonly sidebarWidth?: number
  readonly sidebarCollapsed?: boolean
  readonly rightPanelCollapsed?: boolean
  readonly rightRailWidth?: number
  readonly rightRailCollapsed?: boolean
}

export interface WorkspaceLayoutPorts {
  readonly rightRail: {
    getState: () => { width: number; leftRailWidth: number; leftRailCollapsed: boolean; collapsed: boolean; setWidth: (value: number) => void; setLeftRailWidth: (value: number) => void; setLeftRailCollapsed: (value: boolean) => void; setCollapsed: (value: boolean) => void }
  }
}

const defaults: WorkspaceLayoutPorts = { rightRail: useRightRailStore }

export type WorkspaceLayoutResult = { ok: true } | { ok: false, message: string }

/**
 * Single owner for workspace layout writes. #538：布局三字段双真源退役后不再存在
 * workspace↔rail 桥——sidebar* 语义全部落 rail 的左/右栏字段，注入 ports 供测试
 * 与独立投影使用。
 */
export function applyWorkspaceLayoutChange(
  patch: WorkspaceLayoutPatch,
  ports: WorkspaceLayoutPorts = defaults,
): WorkspaceLayoutResult {
  const rail = ports.rightRail.getState()
  const previous = {
    width: rail.width,
    leftRailWidth: rail.leftRailWidth,
    leftRailCollapsed: rail.leftRailCollapsed,
    collapsed: rail.collapsed,
  }
  try {
    if (patch.sidebarWidth !== undefined) rail.setLeftRailWidth(patch.sidebarWidth)
    if (patch.sidebarCollapsed !== undefined) rail.setLeftRailCollapsed(patch.sidebarCollapsed)
    if (patch.rightPanelCollapsed !== undefined) rail.setCollapsed(patch.rightPanelCollapsed)
    if (patch.rightRailWidth !== undefined) rail.setWidth(patch.rightRailWidth)
    if (patch.rightRailCollapsed !== undefined) rail.setCollapsed(patch.rightRailCollapsed)
    return { ok: true }
  } catch (error) {
    try {
      rail.setWidth(previous.width)
      rail.setLeftRailWidth(previous.leftRailWidth)
      rail.setLeftRailCollapsed(previous.leftRailCollapsed)
      rail.setCollapsed(previous.collapsed)
    } catch (rollbackError) {
      reportRuntimeError('回滚 Workspace 布局事务', rollbackError)
    }
    const detail = reportRuntimeError('更新 Workspace 布局', error)
    return { ok: false, message: detail.message }
  }
}
