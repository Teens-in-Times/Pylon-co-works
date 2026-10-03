/**
 * workspaceClient — 工作区/文件域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * list_workspace_entries / read_workspace_text / workspace_search /
 * git_status / git_history / git_diff 的 command/payload 收口 + normalize。
 */
import type { ClientTransport } from '../acp/agentClient.ts'
import { normalizeWorkspaceEntries, normalizeWorkspaceFileIndexPage, normalizeWorkspaceText } from './workspaceContracts.ts'
import { normalizeGitStatus, normalizeGitHistory, normalizeGitOperationResult, normalizeGitSequenceState, normalizeGitStatusWithBranch, normalizeGitText, type GitSequenceState } from './gitContracts.ts'
import { normalizeWorkspaceSearchResults } from './workspaceSearchContracts.ts'
import { normalizeWorkspaceShape, type Workspace } from '../../domains/workspace/workspaceEntities.ts'
import type { WorkspaceTargetWire } from '../../domains/workspace/workspaceTarget.ts'

export function createWorkspaceClient(transport: ClientTransport) {
  const normalizeWorkspaceList = (raw: unknown): Workspace[] =>
    Array.isArray(raw) ? raw.map(normalizeWorkspaceShape).filter((w): w is Workspace => w !== null) : []
  return {
    listEntries: (target: WorkspaceTargetWire, relativePath: string): Promise<unknown> =>
      transport.invoke('list_workspace_entries', { target, relativePath }).then(normalizeWorkspaceEntries),
    /** 0-C1：quick open 文件名索引（有界枚举，本地匹配）。 */
    listFiles: (target: WorkspaceTargetWire, maxEntries?: number): Promise<unknown> =>
      transport.invoke('list_workspace_files', {
        target,
        ...(maxEntries === undefined ? {} : { maxEntries }),
      }).then(normalizeWorkspaceFileIndexPage),
    readText: (target: WorkspaceTargetWire, relativePath: string, maxBytes?: number): Promise<unknown> =>
      transport.invoke('read_workspace_text', {
        target,
        relativePath,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      }).then(normalizeWorkspaceText),
    writeText: (target: WorkspaceTargetWire, input: { relativePath: string; content: string; expectedBaseline?: string | null; force?: boolean }): Promise<unknown> =>
      transport.invoke('write_workspace_text', { target, ...input }).then(normalizeWorkspaceText),
    search: (target: WorkspaceTargetWire, query: string): Promise<unknown> =>
      transport.invoke('workspace_search', { target, query }).then(normalizeWorkspaceSearchResults),
    /** 0-C2：单文件两版本全文（rev 白名单：hash/HEAD(~N)/:0-:3）。 */
    gitShowFile: (target: WorkspaceTargetWire, rev: string, path: string): Promise<string> =>
      transport.invoke('git_show_file', { target, rev, path }).then(normalizeGitText),
    /** 0-C2：merge/rebase/cherry-pick 进行态 + 冲突清单。 */
    gitSequenceState: (target: WorkspaceTargetWire): Promise<GitSequenceState> =>
      transport.invoke('git_sequence_state', { target }).then(normalizeGitSequenceState),
    gitStatus: (target: WorkspaceTargetWire): Promise<unknown> => transport.invoke('git_status', { target }).then(normalizeGitStatus),
    gitStatusWithBranch: (target: WorkspaceTargetWire): Promise<unknown> =>
      transport.invoke('git_status_with_branch', { target }).then(normalizeGitStatusWithBranch),
    gitHistory: (target: WorkspaceTargetWire): Promise<unknown> => transport.invoke('git_history', { target }).then(normalizeGitHistory),
    gitDiff: (target: WorkspaceTargetWire, path: string, staged: boolean): Promise<string> =>
      transport.invoke('git_diff', { target, path, staged }).then(normalizeGitText),
    gitStage: (target: WorkspaceTargetWire, paths: string[]): Promise<unknown> =>
      transport.invoke('git_stage', { target, paths }).then(normalizeGitOperationResult),
    gitUnstage: (target: WorkspaceTargetWire, paths: string[]): Promise<unknown> =>
      transport.invoke('git_unstage', { target, paths }).then(normalizeGitOperationResult),
    gitCommit: (target: WorkspaceTargetWire, message: string): Promise<unknown> =>
      transport.invoke('git_commit', { target, message }).then(normalizeGitOperationResult),
    gitCreateBranch: (target: WorkspaceTargetWire, name: string): Promise<unknown> =>
      transport.invoke('git_create_branch', { target, name }).then(normalizeGitOperationResult),
    gitSwitchBranch: (target: WorkspaceTargetWire, name: string): Promise<unknown> =>
      transport.invoke('git_switch_branch', { target, name }).then(normalizeGitOperationResult),
    gitPull: (target: WorkspaceTargetWire): Promise<unknown> =>
      transport.invoke('git_pull', { target }).then(normalizeGitOperationResult),
    gitPush: (target: WorkspaceTargetWire): Promise<unknown> =>
      transport.invoke('git_push', { target }).then(normalizeGitOperationResult),
    // CWD-03：Workspace 实体命令（方案 C）。get_workspace_root 的 client 包装已删除：
    // 前端零调用方，后端命令保留（IPC_EXEMPT，WebView 外消费者）。
    createWorkspace: (agentId: string, name: string, rootPath: string): Promise<Workspace> =>
      transport.invoke('workspace_create', { agentId, name, rootPath }).then(normalizeWorkspaceShape).then(workspace => {
        if (!workspace) throw new Error('workspace_create 返回无效形状')
        return workspace
      }),
    listWorkspaces: (): Promise<Workspace[]> =>
      transport.invoke('workspace_list', {}).then(normalizeWorkspaceList),
    updateWorkspace: (workspaceId: string, patch: { name?: string; rootPath?: string }): Promise<Workspace> =>
      transport.invoke('workspace_update', { workspaceId, ...patch }).then(normalizeWorkspaceShape).then(workspace => {
        if (!workspace) throw new Error('workspace_update 返回无效形状')
        return workspace
      }),
    deleteWorkspace: (workspaceId: string): Promise<void> =>
      transport.invoke('workspace_delete', { workspaceId }).then(() => undefined),
  }
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>
