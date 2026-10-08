/**
 * workspaceSheetClosePort — workspace 域对「工作台类 sheet 被关闭」的通知端口
 * （CC-23 接续单 v3：关闭动作触发清位，断裂 workspaceStore → themeStore 的跨域
 * 运行时 import——直调会让 `{hydrateIdentityAndWorkspace, themeStore, workspaceStore}`
 * 成 import 环，被 check:solid 门禁拒绝）。
 *
 * 与 workspaceActiveAgentPort（「未注册即抛错」）**有意不同**：这是通知类端口——
 * 漏装配的后果是「关 sheet 残留编辑态」的行为回归，而不是数据损坏；抛错会炸掉所有
 * 不装配接线的既有关 sheet 测试。装配由 App 组合根（`app/bootstrap/workspaceSheetCloseWiring`）
 * 保证，漏装配由该接线的端到端测试钉住。
 */

export interface WorkspaceSheetClosePort {
  /** 被关集合中含非 pinned 的工作台类（kind `'agent'`）sheet 时调用一次。 */
  onAgentSheetsClosed(): void
}

let port: WorkspaceSheetClosePort | null = null

export function registerWorkspaceSheetClosePort(implementation: WorkspaceSheetClosePort): void {
  port = implementation
}

/** 未注册 = no-op（通知类端口的静默降级，见文件头；装配由组合根保证）。 */
export function notifyAgentSheetsClosed(): void {
  port?.onAgentSheetsClosed()
}
