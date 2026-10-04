import { lazy, type Component } from 'solid-js'
import { tauriInvokeTransport } from '../../../infrastructure/acp/tauriTransport.ts'
import { createWorkspaceClient } from '../../../infrastructure/tauri/workspaceClient.ts'
import { normalizeWorkspaceText } from '../../../infrastructure/tauri/workspaceContracts.ts'
import { normalizeWorkspaceSearchResults } from '../../../infrastructure/tauri/workspaceSearchContracts.ts'
import { normalizeGitHistory, normalizeGitOperationResult, normalizeGitStatusWithBranch } from '../../../infrastructure/tauri/gitContracts.ts'
import type { FileWorkbenchContribution, FileActivityProps } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { WorkspaceEntry } from '../../../components/right-panel/rightPanelTypes.ts'
import { fileTabViewType } from '../../../sheets/file/fileSheetState.ts'

// #515 贡献面翻转：第一方贡献组件是 **Solid 实体**。本文件留在 React 类型图（.ts），
// 不得静态 import .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序）——按 P52 D4
// 经 glob 缝（运行期模块解析，零类型图边）加载，solid `lazy` 保留代码分割。
interface BuiltinFileWorkbenchViewsSolidModule {
  SessionsActivity: Component<FileActivityProps>
  ExplorerActivity: Component<FileActivityProps>
  SearchActivity: Component<FileActivityProps>
  ScmActivity: Component<FileActivityProps>
  ViewsActivity: Component<FileActivityProps>
}

const viewLoaders = import.meta.glob<BuiltinFileWorkbenchViewsSolidModule>('./builtinFileWorkbenchViews.solid.tsx')
const hostLoaders = import.meta.glob<{ default: Component }>('../../../sheets/file/FileViewHost.solid.tsx')

function viewsModule(): Promise<BuiltinFileWorkbenchViewsSolidModule> {
  const load = viewLoaders['./builtinFileWorkbenchViews.solid.tsx']
  if (!load) return Promise.reject(new Error('builtinFileWorkbenchViews Solid 实体未进入 Vite module graph'))
  return load()
}

const SessionsActivity = lazy(async () => ({ default: (await viewsModule()).SessionsActivity }))
const ExplorerActivity = lazy(async () => ({ default: (await viewsModule()).ExplorerActivity }))
const SearchActivity = lazy(async () => ({ default: (await viewsModule()).SearchActivity }))
const ScmActivity = lazy(async () => ({ default: (await viewsModule()).ScmActivity }))
const ViewsActivity = lazy(async () => ({ default: (await viewsModule()).ViewsActivity }))

const FileViewHost = lazy(() => {
  const load = hostLoaders['../../../sheets/file/FileViewHost.solid.tsx']
  if (!load) return Promise.reject(new Error('FileViewHost Solid 实体未进入 Vite module graph'))
  return load()
})

const client = createWorkspaceClient({ invoke: tauriInvokeTransport })

/** 0-A4：FileSheet 可读/可编辑上限——与后端 MAX_PREVIEW_BYTES（1MB）对齐。 */
export const FILE_SHEET_MAX_READ_BYTES = 1024 * 1024

export const builtinFileProvider = {
  id: 'builtin.file.workspace-provider', canHandle: () => true,
  // createWorkspaceClient 已完成 wire → WorkspaceEntry 归一化；这里不能再次按 wire
  // 形状归一化，否则 name/relativePath 已变成 label/path 后会被全部过滤为空。
  listEntries: async (target: Parameters<typeof client.listEntries>[0], path: string, _signal?: AbortSignal) => await client.listEntries(target, path) as WorkspaceEntry[],
  // 0-A4（#286）：FileSheet 读取显式抬到 1MB（后端 MAX_PREVIEW_BYTES）；>1MB 走
  // truncated 截断预览保持只读。DEFAULT_PREVIEW_BYTES（256KB）留给未指定的保守消费方。
  readText: async (target: Parameters<typeof client.readText>[0], path: string, _signal?: AbortSignal) =>
    normalizeWorkspaceText(await client.readText(target, path, FILE_SHEET_MAX_READ_BYTES)),
  writeText: async (target: Parameters<typeof client.writeText>[0], input: Parameters<typeof client.writeText>[1], _signal?: AbortSignal) => normalizeWorkspaceText(await client.writeText(target, input)),
  search: async (target: Parameters<typeof client.search>[0], query: string, _signal?: AbortSignal) => normalizeWorkspaceSearchResults(await client.search(target, query)),
}
export const builtinGitProvider = {
  id: 'builtin.git.workspace', canHandle: () => true,
  status: async (target: Parameters<typeof client.gitStatusWithBranch>[0], _signal?: AbortSignal) => normalizeGitStatusWithBranch(await client.gitStatusWithBranch(target)),
  history: async (target: Parameters<typeof client.gitHistory>[0], _options?: { limit?: number }, _signal?: AbortSignal) => normalizeGitHistory(await client.gitHistory(target)),
  diff: async (target: Parameters<typeof client.gitDiff>[0], input: { path: string; staged: boolean }, _signal?: AbortSignal) => String(await client.gitDiff(target, input.path, input.staged)),
  stage: async (target: Parameters<typeof client.gitStage>[0], paths: string[], _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitStage(target, paths)),
  unstage: async (target: Parameters<typeof client.gitUnstage>[0], paths: string[], _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitUnstage(target, paths)),
  commit: async (target: Parameters<typeof client.gitCommit>[0], message: string, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitCommit(target, message)),
  createBranch: async (target: Parameters<typeof client.gitCreateBranch>[0], name: string, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitCreateBranch(target, name)),
  switchBranch: async (target: Parameters<typeof client.gitSwitchBranch>[0], name: string, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitSwitchBranch(target, name)),
  pull: async (target: Parameters<typeof client.gitPull>[0], _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitPull(target)),
  push: async (target: Parameters<typeof client.gitPush>[0], _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitPush(target)),
  showFile: async (target: Parameters<typeof client.gitShowFile>[0], input: { rev: string; path: string }) => String(await client.gitShowFile(target, input.rev, input.path)),
  sequenceState: async (target: Parameters<typeof client.gitSequenceState>[0]) => await client.gitSequenceState(target),
  // #368：stash 三件套 / 删分支（后端未落地保护 + update-ref 比较删除）/ 结构化 log 图
  stashList: async (target: Parameters<typeof client.gitStashList>[0], _signal?: AbortSignal) => await client.gitStashList(target),
  stashPush: async (target: Parameters<typeof client.gitStashPush>[0], input?: { message?: string; includeUntracked?: boolean }, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitStashPush(target, input)),
  stashPop: async (target: Parameters<typeof client.gitStashPop>[0], index?: number, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitStashPop(target, index ?? 0)),
  deleteBranch: async (target: Parameters<typeof client.gitDeleteBranch>[0], name: string, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitDeleteBranch(target, name)),
  logGraph: async (target: Parameters<typeof client.gitLogGraph>[0], options?: { skip?: number; limit?: number; firstParent?: boolean; path?: string }, _signal?: AbortSignal) => await client.gitLogGraph(target, options),
}

export const BUILTIN_FILE_WORKBENCH_CONTRIBUTIONS: readonly FileWorkbenchContribution[] = [
  { kind: 'activity', id: 'builtin.file.sessions', label: '会话', description: '切换工作区会话', order: 10, icon: 'sessions', renderKind: 'first-party-solid', component: SessionsActivity },
  { kind: 'activity', id: 'builtin.file.explorer', label: '文件', description: '浏览工作区文件', order: 20, icon: 'files', renderKind: 'first-party-solid', component: ExplorerActivity },
  { kind: 'activity', id: 'builtin.file.search', label: '搜索', description: '搜索工作区内容', order: 30, icon: 'search', renderKind: 'first-party-solid', component: SearchActivity },
  { kind: 'activity', id: 'builtin.file.scm', label: 'SCM', description: '查看完整 Git 状态和历史', order: 40, icon: 'scm', renderKind: 'first-party-solid', component: ScmActivity },
  { kind: 'activity', id: 'builtin.file.views', label: '视图', description: '查看 Agent 最近触碰文件', order: 50, icon: 'views', renderKind: 'first-party-solid', component: ViewsActivity },
  { kind: 'file-provider', id: builtinFileProvider.id, priority: 100, fallback: true, provider: builtinFileProvider },
  { kind: 'git-provider', id: builtinGitProvider.id, priority: 100, fallback: true, provider: builtinGitProvider },
  { kind: 'renderer', id: 'builtin.file.text-renderer', priority: 100, fallback: true, canRender: input => fileTabViewType(input.tab) === 'file.text', renderKind: 'first-party-solid', component: FileViewHost, onError: () => 'fallback' },
  { kind: 'renderer', id: 'builtin.file.git-diff-renderer', priority: 100, fallback: false, canRender: input => fileTabViewType(input.tab) === 'git.diff', renderKind: 'first-party-solid', component: FileViewHost, onError: () => 'fallback' },
]
