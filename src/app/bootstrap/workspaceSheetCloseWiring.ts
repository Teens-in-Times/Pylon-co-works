/**
 * workspaceSheetCloseWiring — 应用装配层把 workspace 的 sheet 关闭通知端口绑定到
 * theme store（CC-23 接续单 v3：关闭工作台类（kind 'agent'）sheet ⇒ 退出中控编辑态，
 * 堵住「关 sheet 标签不清编辑标志」的跨 sheet 残留）。
 *
 * 装配时机与 identityCrossDomainWiring / workspaceActiveAgentWiring 同链（App 组合根
 * side-effect import，先于任何 UI 动作）。端口未注册 = no-op（见 workspaceSheetClosePort
 * 文件头），漏装配由本接线的端到端测试钉住。
 */
import { useThemeStore } from '../../domains/theme/themeStore.ts'
import { registerWorkspaceSheetClosePort } from '../../domains/workspace/workspaceSheetClosePort.ts'

registerWorkspaceSheetClosePort({
  onAgentSheetsClosed: () => {
    const theme = useThemeStore.getState()
    if (theme.ccEditMode) theme.setCcEditMode(false)
  },
})
