/**
 * workspaceActiveAgentPort — workspace 域对「当前 active Agent」的读端口
 * （#520 S2-P1-5：workspaceEntityStore 迁域后不再直连 identityStore）。
 *
 * 断裂 `workspaceEntityStore → identityStore` 的跨域运行时 import：唯一消费点是
 * workspace 创建时的 owner 归属（后端 workspace_create 需要非空 agentId）。实现由
 * 应用装配层（`app/bootstrap/workspaceActiveAgentWiring`）注册，读 identity store。
 * 未注册即抛错——不提供静默降级（空 owner 的 workspace 会被后端拒绝，装配遗漏必须
 * 显性失败而不是落库无归属数据）。
 */

export interface WorkspaceActiveAgentPort {
  /** 当前 active Agent id（零 Agent 首跑时可能为空串，调用方负责给出可见提示）。 */
  getActiveAgent(): string
}

let port: WorkspaceActiveAgentPort | null = null

export function registerWorkspaceActiveAgentPort(implementation: WorkspaceActiveAgentPort): void {
  port = implementation
}

export function workspaceActiveAgent(): WorkspaceActiveAgentPort {
  if (!port) {
    throw new Error('workspaceActiveAgentPort 未注册：应用装配层（workspaceActiveAgentWiring）须先于任何 workspace 创建动作装配')
  }
  return port
}
