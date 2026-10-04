/**
 * gitContracts — Git 只读 DTO 收窄（W2-02）。
 *
 * git_status / git_history（§5.8）宽容 normalize：porcelain 码原样保留（M/A/??/R），
 * date 是 Unix 秒（前端自格式化）；损坏 DTO 跳过不崩；非 git 仓库错误（git_error）分类。
 */

export interface GitStatusEntry {
  path: string
  status: string
  staged: boolean
}

export interface GitCommit {
  hash: string
  author: string
  date: number
  subject: string
}

/** ISSUE-15 W4：git_status_with_branch 的分支信息（后端 porcelain v2 --branch header）。 */
export interface GitBranchInfo {
  branch: string | null
  detached: boolean
  head: string | null
}

/** ISSUE-15 W4：git_status_with_branch 完整响应（branch + entries）。 */
export interface GitStatusWithBranch {
  branch: GitBranchInfo
  entries: unknown[]
}

/** 受限 Git 写操作的统一回执。 */
export interface GitOperationResult {
  summary: string
  status: GitStatusWithBranch
}

/** 0-C2：git_show_file / git_diff 的文本回执宽容 normalize——后端 `Result<String, _>`，非串回退空串。 */
export function normalizeGitText(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

/** ISSUE-15 W4：宽容 normalize——entries 走 normalizeGitStatus；branch 三态派生（真实名/detached/占位）。 */
export function normalizeGitStatusWithBranch(raw: unknown): GitStatusWithBranch {
  const result = isPlainObject(raw) ? raw : {}
  const info = isPlainObject(result.branch) ? result.branch : {}
  return {
    branch: {
      branch: typeof info.branch === 'string' && info.branch ? info.branch : null,
      detached: info.detached === true,
      head: typeof info.head === 'string' && info.head ? info.head : null,
    },
    entries: Array.isArray(result.entries) ? result.entries : [],
  }
}

export function normalizeGitOperationResult(raw: unknown): GitOperationResult {
  const result = isPlainObject(raw) ? raw : {}
  const status = normalizeGitStatusWithBranch(result.status)
  return {
    summary: typeof result.summary === 'string' ? result.summary : '',
    status: { ...status, entries: normalizeGitStatus(status.entries) },
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function normalizeGitStatus(raw: unknown): GitStatusEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: GitStatusEntry[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const path = typeof item.path === 'string' && item.path.length > 0 ? item.path : undefined
    if (!path) continue
    entries.push({
      path,
      status: typeof item.status === 'string' ? item.status : '??',
      staged: item.staged === true,
    })
  }
  return entries
}

export function normalizeGitHistory(raw: unknown): GitCommit[] {
  if (!Array.isArray(raw)) return []
  const commits: GitCommit[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const hash = typeof item.hash === 'string' && item.hash.length > 0 ? item.hash : undefined
    if (!hash) continue
    commits.push({
      hash,
      author: typeof item.author === 'string' ? item.author : '',
      date: typeof item.date === 'number' && Number.isFinite(item.date) ? item.date : 0,
      subject: typeof item.subject === 'string' ? item.subject : '',
    })
  }
  return commits
}

/** git_error 分类（§4：非 git 仓库/不可用/失败/超时） */
export interface GitErrorDetail {
  kind: 'not-repo' | 'unavailable' | 'failed' | 'timeout' | 'unknown'
  message: string
}

export function classifyGitError(error: unknown): GitErrorDetail {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (/not a git|not a repository|non-git|非 ?git|not git/i.test(normalized)) return { kind: 'not-repo', message }
  if (/timeout|超时/i.test(normalized)) return { kind: 'timeout', message }
  if (/unavailable|不可用/i.test(normalized)) return { kind: 'unavailable', message }
  return { kind: 'failed', message: message && message !== '[object Object]' ? message : 'Git 操作失败' }
}

/** 0-C2：merge/rebase/cherry-pick 进行态 + 冲突文件清单（git_sequence_state 响应）。 */
export interface GitSequenceState {
  kind: 'none' | 'rebase' | 'merge' | 'cherry-pick'
  conflicts: string[]
}

const SEQUENCE_KINDS: readonly GitSequenceState['kind'][] = ['none', 'rebase', 'merge', 'cherry-pick']

export function normalizeGitSequenceState(raw: unknown): GitSequenceState {
  if (!raw || typeof raw !== 'object') return { kind: 'none', conflicts: [] }
  const item = raw as Partial<GitSequenceState>
  const known = SEQUENCE_KINDS.includes(item.kind as GitSequenceState['kind'])
  // kind 损坏回退 'none' 时一并清空 conflicts（防「无进行态却有孤儿冲突清单」混合态）
  const kind = known ? item.kind as GitSequenceState['kind'] : 'none'
  const conflicts = known && Array.isArray(item.conflicts)
    ? item.conflicts.filter((path): path is string => typeof path === 'string' && path.length > 0)
    : []
  return { kind, conflicts }
}

/** 0-C4：git 图单页（logGraph 响应；宽容解析——损坏条目跳过不崩）。 */
export interface GitCommitGraph {
  hash: string
  parents: string[]
  author: string
  date: number
  subject: string
  refs: string
}

export interface GitLogPage {
  commits: GitCommitGraph[]
  hasMore: boolean
}

export function normalizeGitLogPage(raw: unknown): GitLogPage {
  if (!raw || typeof raw !== 'object') return { commits: [], hasMore: false }
  const item = raw as Partial<GitLogPage>
  const commits = Array.isArray(item.commits)
    ? item.commits.flatMap((entry): GitCommitGraph[] => {
        if (!entry || typeof entry !== 'object') return []
        const value = entry as Partial<GitCommitGraph>
        if (typeof value.hash !== 'string' || value.hash.length === 0) return []
        const date = value.date
        return [{
          hash: value.hash,
          parents: Array.isArray(value.parents) ? value.parents.filter((p): p is string => typeof p === 'string') : [],
          author: typeof value.author === 'string' ? value.author : '',
          date: typeof date === 'number' && Number.isFinite(date) ? date : 0,
          subject: typeof value.subject === 'string' ? value.subject : '',
          refs: typeof value.refs === 'string' ? value.refs : '',
        }]
      })
    : []
  return { commits, hasMore: item.hasMore === true }
}

/** #368：stash 条目（git_stash_list 响应；宽容解析——id 空的条目跳过）。 */
export interface GitStash {
  /** stash ref 形态（`stash@{0}`）。 */
  id: string
  subject: string
}

export function normalizeGitStashList(raw: unknown): GitStash[] {
  if (!Array.isArray(raw)) return []
  const stashes: GitStash[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined
    if (!id) continue
    stashes.push({ id, subject: typeof item.subject === 'string' ? item.subject : '' })
  }
  return stashes
}

/** 0-C4：blame 行（宽容解析：缺字段的行跳过）。 */
export interface GitBlameLine {
  hash: string
  author: string
  date: number
  lineNo: number
  content: string
}

export function normalizeGitBlame(raw: unknown): GitBlameLine[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): GitBlameLine[] => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Partial<GitBlameLine>
    const { hash, content, lineNo, date } = value
    if (typeof hash !== 'string' || typeof content !== 'string' || typeof lineNo !== 'number' || !Number.isFinite(lineNo)) return []
    return [{
      hash,
      author: typeof value.author === 'string' ? value.author : '',
      date: typeof date === 'number' && Number.isFinite(date) ? date : 0,
      lineNo,
      content,
    }]
  })
}
