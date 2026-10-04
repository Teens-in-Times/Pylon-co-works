/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { fileTabKey, fileTabViewType, resetFileSheetTransientState, type FileTabRecord } from './fileSheetState.ts'
import FileTabView, { type FileSaveReceipt } from './FileTabView.solid.tsx'
import type { FileCodeEditorApi, KernelSummary } from './fileCodeMirrorKernel.ts'
import DiffView from './DiffView.solid.tsx'
import DispatchBar from './DispatchBar.solid.tsx'
import { SolidDiffCard } from '../../renderers/solid-workbench/chat/DiffCard.solid.tsx'
import { classifySaveError } from './workspaceWrite.ts'
import { workingDiffLines, workingDiffStats } from './workingDiff.ts'
import type { AgentContext } from '../../domains/agent/agentContext'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider, GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { legacyFileProvider, legacyGitProvider, legacyTarget } from './legacyFileProvider.ts'
import { workspaceTargetKey } from '../../domains/workspace/workspaceTarget.ts'

// 0-A4：FileSheet 可读/可编辑上限——与后端 MAX_PREVIEW_BYTES（1MB）对齐。权威定义在
// builtinFileWorkbench.ts（readText clamp 同值消费）；#515 期本实体不能 import 该文件
// （其 react lazy 面会把 React 类型图拽进 solid 编译面），故按同值落地，漂移由
// FileViewHost.save 测试的「仅预览前 1 MB」文案断言兜住。插件面常量单源化时合并。
const FILE_SHEET_MAX_READ_BYTES = 1024 * 1024

const IDLE_SUMMARY: KernelSummary = { dirty: false, selection: null, lineCount: 0, cursor: null }

/**
 * FileViewHostProps — 名字承自历史 React 契约（FileViewHost.tsx，已退役）；本实体即唯一真源。
 */
interface FileViewHostProps {
  target?: WorkspaceTarget | null
  /** @deprecated direct component compatibility. */ source?: string | null
  fileProvider?: FileProvider | null
  gitProvider?: GitProvider | null
  context?: AgentContext | null
  tab: FileTabRecord | null
  onCloseTab: (key: string) => void
  onDirtyChange?: (key: string, dirty: boolean) => void
  onSavingChange?: (key: string, saving: boolean) => void
}

/**
 * FileViewHost — 主区统一 file/diff 宿主（ISSUE-08 D-03/D-04 + I08-A-FE-02 保存；#515 Solid 实体）。
 *
 * 由 FileSheetView 传入活动 tab（版本化 tab 记录），按 viewType 渲染：
 * file → 发令栏 + 编辑工具栏 + 文件视图 + working-diff 面板 + 状态栏；
 * diff → DiffView（复用 DiffCard）；无 tab → 空态。
 * 0-A1 内核合一后本宿主**不再持有内容全文 state**：编辑事实来自内核 KernelSummary
 * （dirty = doc.eq(baselineDoc) 结构共享比较），保存/working-diff 经 apiRef 句柄按需
 * 取全文（键击路径零全文串）。基线 = 最近一次成功保存（或加载）的磁盘文本；编辑中
 * dirty → 保存带 expectedBaseline 走后端冲突检测（AC-1：外部修改不静默覆盖），
 * conflict → 覆盖保存（force）或重新加载。
 * 0-A2（ADR-0024，重审 #252）：**默认可写**——「编辑/退出编辑」按钮退役，打开即可
 * 输入；强制只读仅物理例外（truncated/binary/超限 → 内核只读档）。防误改由三层承接：
 * expectedBaseline 冲突检测（不变）/ 关闭与导航守卫（FileSheetView，不变）/ 写冲突锁
 * （0-A3）。working-diff 面板在有未保存改动时出现，diff 文本 300ms 防抖按需取。
 */
export default function FileViewHost(props: FileViewHostProps) {
  // ── 响应式字段 ──
  const target = createMemo(() => {
    const resolved = props.target
    return resolved === undefined ? legacyTarget(props.source ?? null) : resolved
  })
  const fileProvider = createMemo(() => props.fileProvider === undefined && props.source ? legacyFileProvider : props.fileProvider ?? null)
  const gitProvider = createMemo(() => props.gitProvider === undefined && props.source ? legacyGitProvider : props.gitProvider ?? null)
  const tab = createMemo(() => props.tab)
  const tabKey = createMemo(() => tab() ? fileTabKey(tab()!) : null)
  const viewIdentity = createMemo(() => `${workspaceTargetKey(target()) ?? 'unbound'}:${tab() ? fileTabKey(tab()!) : 'empty'}`)

  // ── 状态 ──
  const [truncated, setTruncated] = createSignal(false)
  const [truncTotalBytes, setTruncTotalBytes] = createSignal<number | null>(null)
  const [instruction, setInstruction] = createSignal('')
  const [summary, setSummary] = createSignal<KernelSummary>(IDLE_SUMMARY)
  // 0-A3 写冲突锁：locked = agent 写盘冷却期（内核只读）；override = 逃生口
  //（恢复编辑但锁内保存仍禁用，防半成品文件写回）。
  const [writeLocked, setWriteLocked] = createSignal(false)
  const [lockOverride, setLockOverride] = createSignal(false)
  const [workingText, setWorkingText] = createSignal<string | null>(null)
  const [baseline, setBaseline] = createSignal<string | null>(null)
  const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  const [saveError, setSaveError] = createSignal('')
  const [reloadToken, setReloadToken] = createSignal(0)
  const [saveReceipt, setSaveReceipt] = createSignal<FileSaveReceipt | null>(null)
  let saveReceiptVersion = 0
  const apiRef: { current: FileCodeEditorApi | null } = { current: null }

  const dirty = createMemo(() => summary().dirty)
  const editable = createMemo(() => !truncated() && (!writeLocked() || lockOverride()))
  const saveBlockedByLock = createMemo(() => writeLocked())
  const lineCount = createMemo(() => summary().lineCount)
  const selection = createMemo(() => summary().selection)
  const selectionLabel = createMemo(() => {
    const current = selection()
    return current
      ? current.startLine === current.endLine
        ? `L${current.startLine}`
        : `L${current.startLine}–L${current.endLine}`
      : null
  })

  // working-diff 按需计算：仅在 dirty 时，键击静默 300ms 后取一次全文串。
  // 依赖 summary（内核仅在 dirty/选区/行列真变化时发新摘要）→ 防抖天然生效。
  createEffect(() => {
    const currentSummary = summary()
    const currentBaseline = baseline()
    if (!currentSummary.dirty || currentBaseline === null) {
      setWorkingText(null)
      return
    }
    const timer = window.setTimeout(() => setWorkingText(apiRef.current?.getDoc() ?? ''), 300)
    onCleanup(() => window.clearTimeout(timer))
  })

  const workingPayload = createMemo(() => {
    const currentBaseline = baseline()
    const currentWorkingText = workingText()
    if (currentBaseline === null || currentWorkingText === null || !dirty()) return null
    return { oldText: currentBaseline, newText: currentWorkingText, lines: workingDiffLines(currentBaseline, currentWorkingText) }
  })
  const workingStats = createMemo(() => workingDiffStats(workingPayload()?.lines ?? []))

  createEffect(() => {
    const key = tabKey()
    const currentDirty = dirty()
    if (!key) return
    props.onDirtyChange?.(key, currentDirty)
    onCleanup(() => props.onDirtyChange?.(key, false))
  })

  createEffect(() => {
    const key = tabKey()
    const saving = saveState() === 'saving'
    if (!key) return
    props.onSavingChange?.(key, saving)
    onCleanup(() => props.onSavingChange?.(key, false))
  })

  // identity 变化 → 全量重置瞬态（React 版 effect deps [viewIdentity] 同语义）。
  createEffect(() => {
    viewIdentity()
    const cleared = resetFileSheetTransientState()
    setTruncated(cleared.truncated)
    setTruncTotalBytes(null)
    setInstruction(cleared.instruction)
    setSummary(IDLE_SUMMARY)
    setWorkingText(null)
    setWriteLocked(false)
    setLockOverride(false)
    setBaseline(null)
    setSaveState('idle')
    setSaveError('')
    setSaveReceipt(null)
  })

  const handleSummaryChange = (next: KernelSummary) => {
    setSummary(next)
  }

  const handleSave = async (force: boolean) => {
    const currentTarget = target()
    const currentFileProvider = fileProvider()
    const currentTab = tab()
    if (!currentTarget || !currentFileProvider?.writeText || !currentTab || fileTabViewType(currentTab) !== 'file.text' || baseline() === null) return
    if (saveBlockedByLock()) return
    if (!apiRef.current) return
    // 迟到守卫：保存发出后 identity 变化（换工作区/换 tab）→ 结果一律丢弃
    //（React 版经 render 期 ref 镜像同语义）。
    const operationIdentity = viewIdentity()
    const content = apiRef.current.getDoc()
    const contentAtStart = content
    setSaveState('saving')
    setSaveError('')
    try {
      const result = await currentFileProvider.writeText(currentTarget, {
        relativePath: currentTab.path,
        content,
        expectedBaseline: force ? null : baseline(),
        force,
      })
      if (viewIdentity() !== operationIdentity) return
      if (result) {
        const hasNewerEdits = (apiRef.current?.getDoc() ?? '') !== contentAtStart
        setBaseline(result.content)
        setSaveState(hasNewerEdits ? 'idle' : 'saved')
        setSaveReceipt({
          version: ++saveReceiptVersion,
          expectedContent: contentAtStart,
          persistedContent: result.content,
        })
        if (!hasNewerEdits) setSummary(previous => ({ ...previous, selection: null }))
      } else {
        // 响应损坏（normalize 为 null）：不卡 saving，置 error 态并可重试
        setSaveError('保存响应异常，请重试')
        setSaveState('error')
      }
    } catch (err) {
      if (viewIdentity() !== operationIdentity) return
      const detail = classifySaveError(err)
      setSaveError(detail.message)
      setSaveState(detail.code === 'conflict' ? 'conflict' : 'error')
    }
  }

  const discardAndReload = () => {
    setSaveState('idle')
    setSaveError('')
    setSelection(null)
    setReloadToken(token => token + 1)
  }

  const setSelection = (value: KernelSummary['selection']) => {
    setSummary(previous => (previous.selection === value ? previous : { ...previous, selection: value }))
  }

  const viewMode = createMemo<'empty' | 'diff' | 'edit'>(() => {
    if (!tab()) return 'empty'
    if (fileTabViewType(tab()!) === 'git.diff') return 'diff'
    return 'edit'
  })

  return (
    <Show when={viewMode()} keyed>
      {mode => {
        if (mode === 'empty') {
          return (
            <div class="file-tab-empty">
              <div class="file-empty-card">
                <div class="file-empty-mark" aria-hidden="true">{'</>'}</div>
                <strong>打开一个文件开始阅读</strong>
                <span>从左侧文件树选择文件，或切换到 SCM 查看改动。</span>
                <span class="file-empty-shortcut">选中文本后，可在下方发令栏发送给当前会话</span>
              </div>
            </div>
          )
        }
        if (mode === 'diff') {
          return (
            <DiffView
              target={target()}
              provider={gitProvider()}
              path={tab()!.path}
              staged={tab()!.staged ?? false}
              onClose={() => props.onCloseTab(fileTabKey(tab()!))}
            />
          )
        }
        return (
          <>
            <DispatchBar
              targetSource={target()?.source ?? null}
              targetSessionId={target()?.sessionId ?? null}
              context={props.context}
              filePath={tab()!.path}
              selection={selection()}
              getContent={() => apiRef.current?.getDoc() ?? ''}
              instruction={instruction()}
              onInstructionChange={setInstruction}
              onClearSelection={() => setSelection(null)}
            />
            <div class="file-edit-toolbar">
              <Show when={writeLocked() && !lockOverride()}>
                <button
                  type="button"
                  class="file-lock-override"
                  onClick={() => setLockOverride(true)}
                  title="锁定期间保存仍被禁用（防半成品文件写回）；解锁后可保存"
                >
                  仍要编辑
                </button>
              </Show>
              <button
                type="button"
                class="file-save-btn"
                onClick={() => void handleSave(false)}
                disabled={!dirty() || saveState() === 'saving' || saveBlockedByLock()}
                title={truncated() ? '内容不完整（truncated）不可编辑' : saveBlockedByLock() ? 'Agent 正在修改此文件，保存暂停' : '保存（Ctrl/⌘+S）'}
              >
                {saveState() === 'saving' ? '保存中…' : '保存'}
              </button>
              <Show when={saveState() === 'saved'}><span class="file-save-ok" role="status">已保存</span></Show>
              <Show when={saveState() === 'error'}><span class="file-save-error" role="alert">{saveError()}</span></Show>
            </div>
            <Show when={saveState() === 'conflict'}>
              <div class="file-conflict-banner" role="alert">
                <span class="file-conflict-text">磁盘文件已被外部修改，直接保存将被拒绝。</span>
                <button type="button" class="file-conflict-force" onClick={() => void handleSave(true)}>
                  覆盖保存
                </button>
                <button type="button" class="file-conflict-reload" onClick={discardAndReload}>重新加载</button>
              </div>
            </Show>
            <Show when={truncated()}>
              <div class="file-truncated-hint" role="status">
                {truncTotalBytes()
                  ? `文件约 ${(truncTotalBytes()! / 1048576).toFixed(1)} MB，仅预览前 ${FILE_SHEET_MAX_READ_BYTES / 1048576} MB（内容不完整，不可编辑）`
                  : '内容不完整（truncated）'}
              </div>
            </Show>
            <FileTabView
              target={target()}
              provider={fileProvider()}
              context={props.context}
              path={tab()!.path}
              revealLine={tab()!.line}
              writable={editable()}
              baseline={baseline() ?? undefined}
              onTruncated={(value, info) => {
                // A truncated response is intentionally read-only.  Never grant an
                // incomplete buffer an editable surface.
                setTruncated(value)
                setTruncTotalBytes(value && info ? info.totalBytes : null)
              }}
              onContentReady={content => { setBaseline(content) }}
              onExternalChange={() => {
                if (dirty()) {
                  setSaveState('conflict')
                  setSaveError('文件已被外部修改（保存前请选择覆盖或重新加载）')
                }
              }}
              onSelectionInvalidated={() => setSelection(null)}
              onSummaryChange={handleSummaryChange}
              onWriteLockChange={setWriteLocked}
              onSave={() => {
                if (dirty() && saveState() !== 'saving') void handleSave(false)
              }}
              saveAnchorToken={reloadToken()}
              saveReceipt={saveReceipt()}
              apiRef={apiRef}
            />
            <Show when={workingPayload()}>
              <div class="file-working-diff">
                <SolidDiffCard output="" payload={workingPayload()} />
              </div>
            </Show>
            <div class="file-status-bar" role="status" aria-live="polite">
              <span class="file-status-path" title={tab()!.path}>{tab()!.path}</span>
              <span>{lineCount()} 行</span>
              <Show when={summary().cursor}><span>Ln {summary().cursor!.line}, Col {summary().cursor!.col}</span></Show>
              <Show when={dirty()}><span class="file-status-dirty">+{workingStats().added} −{workingStats().removed} 未保存</span></Show>
              <span class={selectionLabel() ? 'file-status-selection active' : 'file-status-selection'}>
                {selectionLabel() ? `已选择 ${selectionLabel()}` : '拖选代码以回传会话'}
              </span>
              <Show when={writeLocked()}>
                <span class="file-status-write-lock" role="status">
                  {lockOverride() ? 'Agent 正在修改此文件（解锁后可保存）' : 'Agent 正在修改此文件，编辑已暂停'}
                </span>
              </Show>
              <span>{target()?.source || '未指向会话'}</span>
            </div>
          </>
        )
      }}
    </Show>
  )
}
