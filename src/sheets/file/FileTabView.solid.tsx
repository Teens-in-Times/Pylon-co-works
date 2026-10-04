/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js'
import { Show } from 'solid-js/web'
import { normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts.ts'
import type { AgentContext } from '../../domains/agent/agentContext'
import { useWorkspaceStore, touchedFileVersionKey } from '../../domains/workspace/workspaceStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { legacyFileProvider, legacyTarget } from './legacyFileProvider.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import FileCodeEditor from './FileCodeEditor.solid.tsx'
import type { FileCodeEditorApi, KernelSummary } from './fileCodeMirrorKernel.ts'

export interface FileSaveReceipt {
  version: number
  expectedContent: string
  persistedContent: string
}

/**
 * FileTabViewProps — 名字承自历史 React 契约（FileTabView.tsx，已退役）；本实体即唯一真源。
 */
export interface FileTabViewProps {
  target?: WorkspaceTarget | null
  /** @deprecated direct component compatibility. */ source?: string | null
  provider?: FileProvider | null
  path: string
  revealLine?: number
  context?: AgentContext | null
  /** 0-A2 默认可写：仅物理例外（truncated）传 false → 内核只读档。 */
  writable?: boolean
  /** 磁盘锚点（宿主持有；保存回执/重载后推进），透传内核计算 dirty。 */
  baseline?: string
  /** 0-A4：truncated 时携带体积信息（>1MB 降级提示条）。 */
  onTruncated: (truncated: boolean, info?: { totalBytes: number }) => void
  onContentReady?: (content: string) => void
  onExternalChange?: () => void
  onSelectionInvalidated?: () => void
  onSummaryChange?: (summary: KernelSummary) => void
  /** 0-A3 写冲突锁：agent 写盘冷却期置 true，静默后置 false。 */
  onWriteLockChange?: (locked: boolean) => void
  onSave?: () => void
  saveAnchorToken?: number
  saveReceipt?: FileSaveReceipt | null
  apiRef?: { current: FileCodeEditorApi | null }
}

/**
 * FileTabView — 文件视图数据编排（0-A1/A2/A3 语义的 Solid 实体；#515 起收编为
 * Solid 实体直连 props，React 桥面已随 React 面退役删除）。
 *
 * 渲染恒为 CodeMirror 常驻单内核（FileCodeEditor.solid → fileCodeMirrorKernel 共享工厂）：
 * 0-A2 默认可写，只读仅物理例外（writable=false）；旧「手工 DOM 投影 +
 * highlightCode/sanitizeHtml + markdown 只读预览分支」退役，MarkdownPreview 实体亦随
 * #520 R2 死件清退（markdown 渲染态切换归阶段一 1-A1，裁决：md 默认源码态）。本组件
 * 只负责：readText 装载（source guard 防串）、
 * touchVersion 感知（编辑中走 probeDisk 不静默覆盖，无编辑安全刷新并落变更行
 * decoration）、0-A3 写冲突锁簿记、saveReceipt 锚点推进、truncated 上报。内容全文
 * 不过框架 state——宿主经 apiRef 句柄取全文。
 *
 * props 经桥面 store 进入（引用等值去重 ≡ React deps 数组）；事件回调在调用点经
 * untrack 现场取新（恒为最新闭包）。
 */
export default function FileTabView(props: FileTabViewProps) {
  // ── 响应式字段 ──
  const explicitTarget = createMemo(() => props.target)
  const source = createMemo(() => props.source)
  const explicitProvider = createMemo(() => props.provider)
  const path = createMemo(() => props.path)
  const revealLine = createMemo(() => props.revealLine)
  const context = createMemo(() => props.context)
  const writable = createMemo(() => props.writable !== false)
  const saveAnchorToken = createMemo(() => props.saveAnchorToken)
  const saveReceipt = createMemo(() => props.saveReceipt ?? null)

  const target = createMemo(() => {
    const resolved = explicitTarget()
    return resolved === undefined ? legacyTarget(source() ?? null) : resolved
  })
  const provider = createMemo(() => explicitProvider() === undefined && source() ? legacyFileProvider : explicitProvider() ?? null)
  const targetKey = createMemo(() => workspaceTargetKey(target()))
  const errorKey = createMemo(() => `file-tab:${targetKey() ?? 'none'}:${path()}`)

  // ── 状态 ──
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  // 首次装载成功的快照 = 内核 initialContent；此后外部刷新走 api.replaceDoc 不重挂。
  const [loadedText, setLoadedText] = createSignal<string | null>(null)
  const [remountNonce, setRemountNonce] = createSignal(0)

  // ── 非响应式锚点/守卫（与 React 版 ref 同语义）──
  let requestContext: SourceRequestContext = { source: null, generation: 0 }
  let loadedRef: string | null = null
  let diskRef: string | null = null
  let saveAnchorRef = 0
  let saveReceiptRef = 0
  // 0-A3 写冲突锁簿记：冷却窗口内的 touchVersion 时间戳 + 解锁定时器
  let touchTimes: number[] = []
  let unlockTimer: number | null = null
  // W2-09：版本戳订阅——agent 工具改动该文件时递增，触发 300ms debounce 重拉。
  // ⚠️ solidStoreBridge 约定（事故原始形态的清偿）：selector 只读 store 切片；
  // target/path/context 是组件响应式状态，按 ViewsPanel 范本在组件侧 createMemo
  // 并读——否则切文件后版本值持旧，直到下一次 store 通知。
  const touchVersions = createZustandSignal(useWorkspaceStore, s => s.touchVersions)
  const touchVersion = createMemo(() => {
    const versions = touchVersions()
    const currentTarget = target()
    const currentPath = path()
    const currentContext = context()
    return (currentTarget && currentPath && currentContext)
      ? versions[touchedFileVersionKey(currentContext, currentPath)]
      : undefined
  })

  const fetchText = (requestTarget: WorkspaceTarget, requestPath: string): Promise<{ text: string; truncated: boolean; totalBytes: number } | null> =>
    (provider() ? provider()!.readText(requestTarget, requestPath) : Promise.resolve(null)).then(raw => {
      const text = normalizeWorkspaceText(raw)
      return text ? { text: text.content, truncated: text.truncated, totalBytes: text.totalBytes } : null
    })

  const loadContent = (showChanged: boolean) => {
    const currentTarget = untrack(target)
    const currentTargetKey = targetKey()
    const currentProvider = untrack(provider)
    const requestPath = path()
    if (!currentTarget || !currentTargetKey || !currentProvider || !requestPath) return
    setLoading(true)
    setError('')
    requestContext = { source: currentTargetKey, generation: requestContext.generation + 1 }
    const token = beginSourceRequest(requestContext, currentTargetKey)
    const isFirstLoad = loadedRef === null
    fetchText(currentTarget, requestPath).then(loaded => {
      if (!isCurrentSourceRequest(requestContext, token) || requestPath !== path()) return
      if (!loaded) {
        setLoading(false)
        setError('文件读取响应异常，请重试')
        reportRuntimeError('读取文件', new Error('文件读取响应异常，请重试'), undefined, {
          key: errorKey(),
          scope: { kind: 'sheet', id: `file-tab:${currentTargetKey ?? 'none'}` },
          source: 'file.tab',
        })
        return
      }
      setLoading(false)
      const currentApi = untrack(() => props.apiRef)?.current
      if (isFirstLoad || !currentApi) {
        // 首载，或内核不在挂载位（上次 error 卸载后恢复）：回退首载路径让内核以
        // 新磁盘快照重挂——否则 stale initialContent + 新 baseline 会产生伪 dirty，
        // Ctrl+S 会以匹配的 expectedBaseline 把旧内容静默写回（AC-1 旁路）。
        loadedRef = loaded.text
        setLoadedText(loaded.text)
        if (!isFirstLoad) setRemountNonce(n => n + 1)
      } else {
        currentApi.replaceDoc(loaded.text, { baseline: loaded.text, markChanged: showChanged })
        if (showChanged) untrack(() => props.onSelectionInvalidated)?.()
      }
      diskRef = loaded.text
      untrack(() => props.onTruncated)(loaded.truncated, { totalBytes: loaded.totalBytes })
      untrack(() => props.onContentReady)?.(loaded.text)
      resolveRuntimeErrors({ key: errorKey() })
    }).catch(err => {
      if (isCurrentSourceRequest(requestContext, token) && requestPath === path()) {
        setLoading(false)
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError('读取文件', err, undefined, {
          key: errorKey(),
          scope: { kind: 'sheet', id: `file-tab:${currentTargetKey ?? 'none'}` },
          source: 'file.tab',
        })
      }
    })
  }

  // I08-A-FE-02：编辑中探测磁盘——用户编辑与磁盘一致 → 安全刷新；不一致 → 上报冲突
  const probeDisk = () => {
    const currentTarget = untrack(target)
    const currentTargetKey = targetKey()
    const currentProvider = untrack(provider)
    const requestPath = path()
    if (!currentTarget || !currentTargetKey || !currentProvider || !requestPath) return
    const currentApi = untrack(() => props.apiRef)?.current
    if (!currentApi) return
    requestContext = { source: currentTargetKey, generation: requestContext.generation + 1 }
    const token = beginSourceRequest(requestContext, currentTargetKey)
    const editorNow = currentApi.getDoc()
    fetchText(currentTarget, requestPath).then(loaded => {
      if (!loaded || !isCurrentSourceRequest(requestContext, token) || requestPath !== path()) return
      if (loaded.text === editorNow) return
      // 磁盘内容与上次锚点一致 → 无外部修改：保留未保存编辑，不误报冲突
      if (loaded.text === diskRef) return
      if (diskRef === editorNow) {
        // 无用户编辑：刷新显示到磁盘（不产生冲突）
        currentApi.replaceDoc(loaded.text, { baseline: loaded.text })
        diskRef = loaded.text
        untrack(() => props.onTruncated)(loaded.truncated, { totalBytes: loaded.totalBytes })
        untrack(() => props.onContentReady)?.(loaded.text)
      } else {
        // 用户有未保存编辑：不覆盖，上报外部修改冲突
        untrack(() => props.onExternalChange)?.()
      }
    }).catch((error: unknown) => {
      // 探测失败（文件被删/IO 错）若静默，外部修改检测整条链路无感失效——上报错误中心。
      reportRuntimeError('探测外部文件变更失败', error, undefined, {
        key: 'file:probe-disk',
        source: 'file.external-change',
      })
    })
  }

  // 0-A3 写冲突锁：冷却窗口内 >=2 次 touchVersion 递增 → 置锁；静默满冷却 → 解锁并
  // probeDisk 确认磁盘稳定。每次新 touch 顺延解锁定时器。
  createEffect(() => {
    const currentTouch = touchVersion()
    if (currentTouch === undefined || !untrack(target) || !path()) return
    const now = Date.now()
    touchTimes = touchTimes.filter(t => now - t < WRITE_LOCK_COOLDOWN_MS)
    touchTimes.push(now)
    const locked = touchTimes.length >= 2
    untrack(() => props.onWriteLockChange)?.(locked)
    if (locked) {
      if (unlockTimer !== null) window.clearTimeout(unlockTimer)
      unlockTimer = window.setTimeout(() => {
        unlockTimer = null
        touchTimes = []
        untrack(() => props.onWriteLockChange)?.(false)
        probeDisk()
      }, WRITE_LOCK_COOLDOWN_MS)
    }
    onCleanup(() => {
      if (unlockTimer !== null) window.clearTimeout(unlockTimer)
    })
  })

  // 目标/文件变化 → 全量重置 + 读取（React 版 [targetKey, path, provider] effect）
  createEffect(() => {
    const currentTargetKey = targetKey()
    const currentPath = path()
    requestContext = advanceSourceContext(requestContext, currentTargetKey)
    loadedRef = null
    setLoadedText(null)
    setError('')
    setLoading(false)
    diskRef = null
    touchTimes = []
    if (unlockTimer !== null) {
      window.clearTimeout(unlockTimer)
      unlockTimer = null
    }
    if (!untrack(target) || !currentPath) return
    loadContent(false)
    onCleanup(() => {
      requestContext = advanceSourceContext(requestContext, null)
    })
  })

  // W2-09：版本戳变化 → 300ms debounce；可写或有未保存编辑走探测（不静默覆盖），
  // 否则安全重拉。内核不在挂载位（错误态卸载期间磁盘变化）→ 自愈 = 完整重载。
  createEffect(() => {
    const currentTouch = touchVersion()
    if (currentTouch === undefined || !untrack(target) || !path()) return
    const timer = window.setTimeout(() => {
      const currentApi = untrack(() => props.apiRef)?.current
      if (!currentApi) {
        loadedRef = null
        setLoadedText(null)
        loadContent(false)
        return
      }
      if (writable() || currentApi.getDoc() !== diskRef) probeDisk()
      else loadContent(true)
    }, 300)
    onCleanup(() => window.clearTimeout(timer))
  })

  // I08-A-FE-02：保存成功/覆盖/重新加载后磁盘锚点推进 → 重拉对齐
  createEffect(() => {
    const token = saveAnchorToken()
    if (token === undefined || token === saveAnchorRef || !untrack(target) || !path()) return
    saveAnchorRef = token
    loadContent(false)
  })

  // 保存回执：推进磁盘锚点；保存期间键入的更新编辑保留。
  createEffect(() => {
    const receipt = saveReceipt()
    if (!receipt || receipt.version === saveReceiptRef) return
    saveReceiptRef = receipt.version
    const currentApi = untrack(() => props.apiRef)?.current
    const hasNewerEdits = (currentApi?.getDoc() ?? '') !== receipt.expectedContent
    diskRef = receipt.persistedContent
    currentApi?.clearChangedMarks()
    if (!hasNewerEdits) currentApi?.advanceBaseline(receipt.persistedContent)
  })

  const editorKey = createMemo(() => `${targetKey() ?? 'unknown'}:${path()}:${remountNonce()}`)

  // 渲染模式：单一 keyed Show 分派（Solid JSX 赋值会急切实例子树——keyed 保证
  // 子树只在模式命中时创建）。loading 只在首载（内核未挂载）时展示；后续外部刷新
  // 保持内核挂载——卸载会销毁文档与 api 句柄，replaceDoc 无从落地。
  const viewMode = createMemo(() => {
    if (!target() || !provider()) return 'no-provider'
    if (error()) return 'error'
    if (loading() && loadedText() === null) return 'loading'
    if (loadedText() === null) return 'pending'
    return 'ready'
  })

  return (
    <Show when={viewMode()} keyed>
      {mode => {
        if (mode === 'no-provider') return <div class="file-tab-view file-tab-empty">未安装可用的文件 provider</div>
        if (mode === 'error') return <div class="file-tab-view file-tab-error" role="status">文件读取失败，详情见右下角错误中心</div>
        if (mode === 'loading') return <div class="file-tab-view file-tab-loading" role="status">正在读取文件…</div>
        if (mode === 'pending') return null
        void mode
        return (
            <Show when={editorKey()} keyed>
              {_editorKey => {
                // baseline 取挂载时刻快照（untrack）：内核基线此后只经 replaceDoc
                // （外部刷新）与 advanceBaseline（保存回执）推进——若保留 loadedText
                // 响应性，宿主 reset 卸载窗口内会触发 setBaseline→emitSummary 复活
                // 陈旧 summary（React 版子先父后 effect 序无此窗口）。
                return (
                <div class="file-tab-view file-tab-edit" data-path={path()}>
                  <FileCodeEditor
                    path={path()}
                    initialContent={loadedText() ?? ''}
                    baseline={untrack(() => props.baseline ?? loadedText() ?? '')}
                    writable={writable()}
                    revealLine={revealLine()}
                    onSummaryChange={summary => untrack(() => props.onSummaryChange)?.(summary)}
                    onWriteLockChange={locked => untrack(() => props.onWriteLockChange)?.(locked)}
                    onSave={() => untrack(() => props.onSave)?.()}
                    apiRef={untrack(() => props.apiRef)}
                  />
                </div>
                )
              }}
            </Show>
        )
      }}
    </Show>
  )
}

/** 0-A3 写冲突锁：冷却窗口（ms）内 touchVersion >=2 次递增 = agent 正在写盘。 */
export const WRITE_LOCK_COOLDOWN_MS = 3000
