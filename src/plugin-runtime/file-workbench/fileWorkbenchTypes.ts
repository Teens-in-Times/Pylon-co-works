import type { AgentContext } from '../../domains/agent/agentContext.ts'
import type { Component } from 'solid-js'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'
import type { WorkspaceEntry, WorkspaceTextPreview } from './fileViewContracts.ts'
import type { WorkspaceSearchResult } from '../../infrastructure/tauri/workspaceSearchContracts.ts'
import type { GitCommit, GitOperationResult, GitStatusWithBranch } from '../../infrastructure/tauri/gitContracts.ts'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileTabRecord } from './fileViewContracts.ts'
import type { LanguageSupport } from '@codemirror/language'

export interface FileProvider {
  id: string
  canHandle(target: WorkspaceTarget): boolean
  listEntries(target: WorkspaceTarget, relativePath: string, signal?: AbortSignal): Promise<WorkspaceEntry[]>
  readText(target: WorkspaceTarget, relativePath: string, signal?: AbortSignal): Promise<WorkspaceTextPreview | null>
  writeText?(target: WorkspaceTarget, input: { relativePath: string; content: string; expectedBaseline?: string | null; force?: boolean }, signal?: AbortSignal): Promise<WorkspaceTextPreview | null>
  search?(target: WorkspaceTarget, query: string, signal?: AbortSignal): Promise<WorkspaceSearchResult[]>
  // ── 0-C4 文件树写操作与 quick open 索引（全 optional；UI 能力探测）──
  createFile?(target: WorkspaceTarget, input: { parentDir: string; name: string; content?: string }, signal?: AbortSignal): Promise<WorkspaceTextPreview | null>
  createDir?(target: WorkspaceTarget, input: { parentDir: string; name: string }, signal?: AbortSignal): Promise<WorkspaceEntry | null>
  rename?(target: WorkspaceTarget, input: { oldPath: string; newName: string }, signal?: AbortSignal): Promise<WorkspaceEntry | null>
  delete?(target: WorkspaceTarget, input: { path: string; force?: boolean }, signal?: AbortSignal): Promise<boolean | null>
  /** quick open 文件名索引（有界枚举）。 */
  listFiles?(target: WorkspaceTarget, maxEntries?: number, signal?: AbortSignal): Promise<{ entries: string[]; truncated: boolean } | null>
}

export interface FileLanguageProvider {
  id: string
  priority: number
  canHandle(path: string): boolean
  load(path: string, signal?: AbortSignal): Promise<LanguageSupport | null>
}

// 0-C4：结构化 log/blame 数据类型单源于 gitContracts（防双份声明漂移）。
import type { GitBlameLine, GitCommitGraph, GitLogPage, GitSequenceState } from '../../infrastructure/tauri/gitContracts.ts'

export type { GitBlameLine, GitCommitGraph, GitLogPage }

/** 0-C4：stash 条目（stashList 响应）。 */
export interface GitStash {
  id: string
  subject: string
}

export interface GitProvider {
  id: string
  canHandle(target: WorkspaceTarget): boolean | Promise<boolean>
  status(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitStatusWithBranch>
  history(target: WorkspaceTarget, options?: { limit?: number }, signal?: AbortSignal): Promise<GitCommit[]>
  diff(target: WorkspaceTarget, input: { path: string; staged: boolean }, signal?: AbortSignal): Promise<string>
  // ── 0-C4 起的可选能力面（全部 optional = 能力探测；第三方不实现时 UI 隐藏入口）──
  /** 结构化 log 分页（git 图）。 */
  logGraph?(target: WorkspaceTarget, options?: { skip?: number; limit?: number; firstParent?: boolean; path?: string }, signal?: AbortSignal): Promise<GitLogPage>
  /** 单文件两版本全文；rev 含 ":0:"~":3:" stage 语法（后端白名单内）。 */
  showFile?(target: WorkspaceTarget, input: { rev: string; path: string }, signal?: AbortSignal): Promise<string>
  blame?(target: WorkspaceTarget, path: string, signal?: AbortSignal): Promise<GitBlameLine[]>
  /** merge/rebase/cherry-pick 进行态 + 冲突清单。 */
  sequenceState?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitSequenceState>
  stashList?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitStash[]>
  stashPush?(target: WorkspaceTarget, input?: { message?: string; includeUntracked?: boolean }, signal?: AbortSignal): Promise<GitOperationResult>
  stashPop?(target: WorkspaceTarget, index?: number, signal?: AbortSignal): Promise<GitOperationResult>
  stashDrop?(target: WorkspaceTarget, index?: number, signal?: AbortSignal): Promise<GitOperationResult>
  /** L1-L3 危险分级确认由 UI 层负责；后端仍各自校验。 */
  reset?(target: WorkspaceTarget, input: { mode: 'soft' | 'mixed' | 'hard'; toRev: string }, signal?: AbortSignal): Promise<GitOperationResult>
  revert?(target: WorkspaceTarget, hashes: string[], signal?: AbortSignal): Promise<GitOperationResult>
  /** 以独立可选方法并存一个版本期（不覆写 createBranch/switchBranch）。 */
  checkout?(target: WorkspaceTarget, input: { name: string; create?: boolean }, signal?: AbortSignal): Promise<GitOperationResult>
  cherryPick?(target: WorkspaceTarget, hash: string, signal?: AbortSignal): Promise<GitOperationResult>
  abortCherryPick?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitOperationResult>
  merge?(target: WorkspaceTarget, name: string, signal?: AbortSignal): Promise<GitOperationResult>
  rebase?(target: WorkspaceTarget, onto: string, signal?: AbortSignal): Promise<GitOperationResult>
  rebaseContinue?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitOperationResult>
  rebaseAbort?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitOperationResult>
  stage?(target: WorkspaceTarget, paths: string[], signal?: AbortSignal): Promise<GitOperationResult>
  unstage?(target: WorkspaceTarget, paths: string[], signal?: AbortSignal): Promise<GitOperationResult>
  commit?(target: WorkspaceTarget, message: string, signal?: AbortSignal): Promise<GitOperationResult>
  createBranch?(target: WorkspaceTarget, name: string, signal?: AbortSignal): Promise<GitOperationResult>
  switchBranch?(target: WorkspaceTarget, name: string, signal?: AbortSignal): Promise<GitOperationResult>
  /** #368：删本地分支；后端带「未落地工作」保护（已并入 HEAD 或树相等才可删，探针失败保守拒）。 */
  deleteBranch?(target: WorkspaceTarget, name: string, signal?: AbortSignal): Promise<GitOperationResult>
  pull?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitOperationResult>
  push?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitOperationResult>
}

export interface FileActivityProps {
  target: WorkspaceTarget | null
  targetSessionId: string | null
  sessions: readonly WorkspaceSession[]
  context: AgentContext | null
  activeFile: string | null
  fileProvider: FileProvider | null
  gitProvider: GitProvider | null
  onSelectTarget: (sessionId: string | null) => void
  onOpenFile: (path: string, line?: number) => void
  onOpenDiff: (path: string, staged: boolean) => void
}

interface FileActivityBase {
  kind: 'activity'
  id: string
  label: string
  description: string
  order: number
  icon: 'sessions' | 'files' | 'search' | 'scm' | 'views'
  when?: (target: WorkspaceTarget | null) => boolean
}

export type FileActivityContribution = FileActivityBase & (
  // #520 S4-P1-6/S4-P0-1：typed component（对齐 contextPanelTypes 范式）。FileSheetView
  // 自 #520 起经 PluginContributionBody 消费本字段（<Dynamic> 直挂注册组件）——第三方
  // first-party-solid activity 注册即渲染，不再被宿主按 builtin id 白名单无视。
  | { renderKind: 'first-party-solid'; component: Component<FileActivityProps> }
  | { renderKind: 'isolated-surface'; surfaceId: string }
)

interface FileViewRendererBase {
  kind: 'renderer'
  id: string
  priority: number
  fallback: boolean
  canRender(input: { target: WorkspaceTarget; tab: FileTabRecord }): boolean
  onError?: (error: unknown) => 'fallback' | 'rethrow'
}

/**
 * file 视图 renderer（first-party-solid 臂）的 props 面。
 *
 * 与 FileSheetView 内置渲染实体 FileViewHost 的 props 同构（该实体不得被
 * plugins/core 静态 import，故在此声明共享契约；结构性一致由 builtin 注册处
 * 传入 FileViewHost 实例编译期校验）。
 */
export interface FileViewRendererProps {
  target?: WorkspaceTarget | null
  fileProvider?: FileProvider | null
  gitProvider?: GitProvider | null
  context?: AgentContext | null
  tab: FileTabRecord | null
  onCloseTab: (key: string) => void
  onDirtyChange?: (key: string, dirty: boolean) => void
  onSavingChange?: (key: string, saving: boolean) => void
}

export type FileViewRendererDefinition = FileViewRendererBase & (
  // #520 S4-P1-6/S4-P0-1：同 activity——FileSheetView 的视图分支经 PluginContributionBody
  // 消费本字段，选中的 renderer 注册组件即渲染目标。
  | { renderKind: 'first-party-solid'; component: Component<FileViewRendererProps> }
  | { renderKind: 'isolated-surface'; surfaceId: string }
)

export type FileWorkbenchContribution =
  | FileActivityContribution
  | ({ kind: 'file-provider'; provider: FileProvider; id: string; priority: number; fallback: boolean })
  | ({ kind: 'language-provider'; provider: FileLanguageProvider; id: string; priority: number; fallback: boolean })
  | ({ kind: 'git-provider'; provider: GitProvider; id: string; priority: number; fallback: boolean })
  | FileViewRendererDefinition
