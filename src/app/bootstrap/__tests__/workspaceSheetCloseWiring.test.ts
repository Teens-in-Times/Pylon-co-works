/**
 * CC-23 接续单 v3 · 接线端到端：import 接线模块（App 组合根同一装配）⇒ 关闭工作台类
 * sheet ⇒ ccEditMode 复位 false；关设置类 sheet ⇒ 编辑态不受影响。
 *
 * 钉住装配链闭合：端口「未注册 = no-op」的静默降级靠这条测试兜底（漏装配 = 此处红）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { resetStores } from '../../../test/resetStores.ts'
import type { SheetRecord } from '../../../contracts/sheets.ts'
import { useThemeStore } from '../../../domains/theme/themeStore.ts'
import { createSheetState } from '../../../domains/workspace/sheetState.ts'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore.ts'
// 装配（side-effect register）：与 App 组合根 import 的同一模块。
import '../workspaceSheetCloseWiring.ts'

beforeEach(() => {
  resetStores()
})

function sheet(id: string, kind: string): SheetRecord {
  return { id, kind, title: id, createdAt: 1, lastFocusedAt: 1 }
}

function seedSheets(sheets: SheetRecord[], activeSheetId: string | null = sheets[0]?.id ?? null): void {
  useWorkspaceStore.setState({ workspaceSheets: createSheetState(sheets, activeSheetId) })
}

describe('CC-23 v3 · workspaceSheetCloseWiring 端到端（装配链闭合）', () => {
  it('关 agent sheet ⇒ ccEditMode 复位 false', () => {
    seedSheets([sheet('s-agent', 'agent'), sheet('s-settings', 'settings')])
    useThemeStore.getState().setCcEditMode(true)
    expect(useThemeStore.getState().ccEditMode).toBe(true)

    useWorkspaceStore.getState().closeSheet('s-agent')

    expect(useThemeStore.getState().ccEditMode).toBe(false)
  })

  it('关 settings sheet ⇒ ccEditMode 保持 true（进编辑器路径安全）', () => {
    seedSheets([sheet('s-agent', 'agent'), sheet('s-settings', 'settings')], 's-settings')
    useThemeStore.getState().setCcEditMode(true)

    useWorkspaceStore.getState().closeSheet('s-settings')

    expect(useThemeStore.getState().ccEditMode).toBe(true)
  })
})
