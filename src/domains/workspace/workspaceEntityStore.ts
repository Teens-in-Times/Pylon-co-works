/**
 * CWD-03：Workspace 实体 store（方案 C 前端权威缓存）。
 *
 * 权威源 = 后端注册表（workspace_* 命令，Tauri 模式）；浏览器/离线模式读写
 * localStorage 镜像（pylon-workspaces envelope）。hydrate 在启动 bootstrap 调用，
 * 与 identityStore.hydrateSessions 同序（workspace 先于会话绑定解析）。
 *
 * #520 S2-P1-5：自 infrastructure/persistence 迁入 workspace 域（前端权威缓存是域
 * 内状态，不是传输层）；对 identity 的唯一依赖（创建 workspace 时的 owner 归属）
 * 经 workspaceActiveAgentPort 注入（app/bootstrap/workspaceActiveAgentWiring 装配），
 * 不再直连 identityStore。
 */
import { createSolidStoreKernel, type SolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI, isBrowserMockRuntime } from '../../infrastructure/tauri/env'
import { workspaceActiveAgent } from './workspaceActiveAgentPort.ts'
import {
  isAbsolutePath,
  newLocalWorkspaceId,
  normalizeWorkspaceShape,
  parseWorkspaces,
  serializeWorkspaces,
  WORKSPACE_STORAGE_KEY,
  type Workspace,
} from './workspaceEntities'

const hasBackend = () => IS_TAURI && !isBrowserMockRuntime()

const readMirror = (): Workspace[] => {
  try {
    return parseWorkspaces(localStorage.getItem(WORKSPACE_STORAGE_KEY))
  } catch {
    return []
  }
}

const writeMirror = (workspaces: Workspace[]) => {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspaces(workspaces))
  } catch {
    // 镜像写盘失败不抛：后端仍为权威源，下次 hydrate 自愈
  }
}

interface WorkspaceEntityStore {
  workspaces: Workspace[]
  hydrated: boolean
  hydrate: () => Promise<void>
  byId: (id: string) => Workspace | undefined
  createWorkspace: (name: string, rootPath: string) => Promise<Workspace>
  updateWorkspace: (id: string, patch: { name?: string; rootPath?: string; skills?: string[]; mcpServerIds?: string[]; hookPluginIds?: string[] }) => Promise<Workspace>
  deleteWorkspace: (id: string) => Promise<void>
}

// #515 批0：zustand → Solid 内核置换（对外签名不变；hook shim 已随 R4 收口拆除）。
const workspaceEntityKernel: SolidStoreKernel<WorkspaceEntityStore> = createSolidStoreKernel<WorkspaceEntityStore>({
  workspaces: [],
  hydrated: false,

  byId: id => workspaceEntityKernel.getState().workspaces.find(workspace => workspace.id === id),

  hydrate: async () => {
    if (workspaceEntityKernel.getState().hydrated) return
    if (hasBackend()) {
      try {
        let raw = await invoke('workspace_list')
        let workspaces = Array.isArray(raw)
          ? raw.map(normalizeWorkspaceShape).filter((w): w is Workspace => w !== null)
          : []
        // 旧版本只有 localStorage 镜像。新后端首次为空时做一次保 ID 导入，
        // 不能调用 create（会换 id，导致 Session.workspaceId 绑定断裂）。
        if (workspaces.length === 0) {
          const mirror = readMirror()
          if (mirror.length > 0) {
            raw = await invoke('workspace_restore', { workspaces: mirror })
            workspaces = Array.isArray(raw)
              ? raw.map(normalizeWorkspaceShape).filter((w): w is Workspace => w !== null)
              : mirror
          }
        }
        writeMirror(workspaces)
        workspaceEntityKernel.setState({ workspaces, hydrated: true })
        return
      } catch {
        // 后端不可用：回退镜像
      }
    }
    workspaceEntityKernel.setState({ workspaces: readMirror(), hydrated: true })
  },

  createWorkspace: async (name, rootPath) => {
    if (!isAbsolutePath(rootPath)) {
      throw new Error('工作目录必须是绝对路径')
    }
    let created: Workspace
    if (hasBackend()) {
      // #326：零 Agent 首跑时 activeAgent 是空串。空 owner 的 workspace 落库后没有归属，
      // 故直接拒绝并让调用方给出「先配置 Agent」的可见提示，而不是发一个空串过去。
      const agentId = workspaceActiveAgent().getActiveAgent()
      if (!agentId) throw new Error('还没有可用的 Agent：请先在 设置 → Agent 中配置一个')
      const raw = await invoke('workspace_create', { agentId, name, rootPath })
      const normalized = normalizeWorkspaceShape(raw)
      if (!normalized) throw new Error('workspace_create 返回无效形状')
      created = normalized
    } else {
      created = {
        id: newLocalWorkspaceId(workspaceEntityKernel.getState().workspaces),
        agentId: '',
        name,
        rootPath,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        skills: [],
        mcpServerIds: [],
        hookPluginIds: [],
      }
    }
    const workspaces = [...workspaceEntityKernel.getState().workspaces, created]
    writeMirror(workspaces)
    workspaceEntityKernel.setState({ workspaces })
    return created
  },

  updateWorkspace: async (id, patch) => {
    if (patch.rootPath !== undefined && !isAbsolutePath(patch.rootPath)) {
      throw new Error('工作目录必须是绝对路径')
    }
    let updated: Workspace
    if (hasBackend()) {
      const raw = await invoke('workspace_update', { workspaceId: id, ...patch })
      const normalized = normalizeWorkspaceShape(raw)
      if (!normalized) throw new Error('workspace_update 返回无效形状')
      updated = normalized
    } else {
      const current = workspaceEntityKernel.getState().byId(id)
      if (!current) throw new Error(`workspace not found: ${id}`)
      updated = {
        ...current,
        name: patch.name ?? current.name,
        rootPath: patch.rootPath ?? current.rootPath,
        skills: patch.skills ?? current.skills,
        mcpServerIds: patch.mcpServerIds ?? current.mcpServerIds,
        hookPluginIds: patch.hookPluginIds ?? current.hookPluginIds,
        lastActiveAt: Date.now(),
      }
    }
    const workspaces = workspaceEntityKernel.getState().workspaces.map(w => w.id === id ? updated : w)
    writeMirror(workspaces)
    workspaceEntityKernel.setState({ workspaces })
    return updated
  },

  deleteWorkspace: async id => {
    if (hasBackend()) {
      await invoke('workspace_delete', { workspaceId: id })
    }
    const workspaces = workspaceEntityKernel.getState().workspaces.filter(w => w.id !== id)
    writeMirror(workspaces)
    workspaceEntityKernel.setState({ workspaces })
  },
})

export const useWorkspaceEntityStore: SolidStoreKernel<WorkspaceEntityStore> = workspaceEntityKernel
