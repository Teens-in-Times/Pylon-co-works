/**
 * CC-23 接续单 v3：关闭动作族的端口通知——关闭「会话现场类」（工作台类，kind
 * `'agent'`）sheet 时经 `workspaceSheetClosePort` 通知接线端（清中控编辑态）；
 * 关闭设置等其它类 sheet 不通知（「进入布局编辑器」= 置位 + 仅关设置页，必须不被误伤）。
 *
 * 域侧只钉「通知与否」（是否处于编辑态由接线端判定，见 App 组合根
 * `app/bootstrap/workspaceSheetCloseWiring`；端到端断言在接线测试文件）。
 * 通知判定与 sheetState.closeIds 的 pinned 过滤一致：pinned 的 sheet 不算被关。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
// isSheetKind 要求 kind 已在 workspaceRegistry 注册 ⇒ 测试需完整第一方产品插件
// （'agent' / 'settings' descriptor 随 bootstrap 就位），否则 createSheetState 过滤一切。
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { resetStores } from '../../../test/resetStores.ts'
import type { SheetRecord } from '../../../contracts/sheets.ts'
import { createSheetState } from '../sheetState.ts'
import { registerWorkspaceSheetClosePort } from '../workspaceSheetClosePort.ts'
import { useWorkspaceStore } from '../workspaceStore.ts'

const onAgentSheetsClosed = vi.fn()

beforeEach(() => {
  resetStores()
  onAgentSheetsClosed.mockClear()
  registerWorkspaceSheetClosePort({ onAgentSheetsClosed })
})

function sheet(id: string, kind: string, pinned = false): SheetRecord {
  return { id, kind, title: id, createdAt: 1, lastFocusedAt: 1, ...(pinned ? { pinned: true } : {}) }
}

function seedSheets(sheets: SheetRecord[], activeSheetId: string | null = sheets[0]?.id ?? null): void {
  useWorkspaceStore.setState({ workspaceSheets: createSheetState(sheets, activeSheetId) })
}

describe('CC-23 v3 · 关闭工作台类 sheet 的通知端口', () => {
  it('closeSheet(agent) ⇒ 端口被通知 1 次', () => {
    seedSheets([sheet('s-agent', 'agent'), sheet('s-settings', 'settings')])

    useWorkspaceStore.getState().closeSheet('s-agent')

    expect(onAgentSheetsClosed).toHaveBeenCalledTimes(1)
    // 通知不连带关其它 sheet：设置页仍开着
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.map(s => s.id)).toEqual(['s-settings'])
  })

  it('closeSheet(settings) ⇒ 端口不被通知（进编辑器路径安全）', () => {
    seedSheets([sheet('s-agent', 'agent'), sheet('s-settings', 'settings')], 's-settings')

    useWorkspaceStore.getState().closeSheet('s-settings')

    expect(onAgentSheetsClosed).not.toHaveBeenCalled()
  })

  it('closeOtherSheets 保留者之外含 agent sheet ⇒ 通知；closeRightSheets 同族', () => {
    seedSheets([sheet('s-a1', 'agent'), sheet('s-settings', 'settings'), sheet('s-a2', 'agent')], 's-a1')
    useWorkspaceStore.getState().closeOtherSheets('s-a1')
    expect(onAgentSheetsClosed).toHaveBeenCalledTimes(1)

    seedSheets([sheet('s-agent', 'agent'), sheet('s-settings', 'settings'), sheet('s-a2', 'agent')], 's-settings')
    useWorkspaceStore.getState().closeRightSheets('s-settings')
    expect(onAgentSheetsClosed).toHaveBeenCalledTimes(2)
  })

  it('closeRightSheets 仅关非 agent sheet ⇒ 不通知', () => {
    seedSheets([sheet('s-agent', 'agent'), sheet('s-settings', 'settings')], 's-agent')

    useWorkspaceStore.getState().closeRightSheets('s-agent')

    expect(onAgentSheetsClosed).not.toHaveBeenCalled()
  })

  it('被关的是 pinned 的 agent sheet（closeIds 不移除）⇒ 不通知', () => {
    seedSheets([sheet('s-agent', 'agent', true), sheet('s-settings', 'settings')])

    useWorkspaceStore.getState().closeSheet('s-agent')

    expect(onAgentSheetsClosed).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.some(s => s.id === 's-agent')).toBe(true)
  })
})
