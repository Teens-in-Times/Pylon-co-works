/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { createRegistrySignal } from '../../infrastructure/state/solidSheetSupport.solid.tsx'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { createFileSheetState, fileSheetReducer, fileTabKey, fileTabViewType, parseFileTabs, serializeFileTabs, type FileTabRecord } from './fileSheetState.ts'
import FileSheetSidebarSolid from './FileSheetSidebar.solid.tsx'
import FileTabBarSolid from './FileTabBar.solid.tsx'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import { workspaceTargetFromSession, workspaceTargetKey } from '../../domains/workspace/workspaceTarget.ts'
import { getFileWorkbenchRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { listFileActivities, resolveFileProvider, resolveFileViewRenderer, resolveGitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchResolver.ts'
import type { FileActivityProps, FileViewRendererProps } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { PluginContributionBody } from '../../plugin-runtime/ui/PluginContributionBody.solid.tsx'
import FileViewRenderBoundarySolid from './FileViewRenderBoundary.solid.tsx'
import { registerWorkspaceLiveCloseGuard } from '../../workspace-sheets/workspaceLiveCloseGuards.ts'
import { FILE_NAVIGATION_METADATA_KEY, parsePendingFileNavigation } from './fileSheetNavigation.ts'

/**
 * FileSheetViewProps — 名字承自历史 React 契约（FileSheetView.tsx，已退役）；本实体即唯一真源。
 */
interface FileSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/**
 * FileSheetView — FileSheet 主视图（W2-03/04，D-08 VS Code 风格改造；ISSUE-08 D-02/D-04；
 * #515 Solid 实体）。
 *
 * singletonKey = file:{初始 source}（同工作区复用）；内部 targetSource 本地态。
 * metadata 承载 openTabs（版本化 tab 记录 `{version:2,tabs:[{path,mode,staged?}],activeKey}`，
 * v1 openTabs:string[] 在 parseFileTabs 内迁移为 file-mode tabs、损坏 normalize 为空）
 * 与 activeFile（右栏 FileContextPanel 反查关联会话）。
 * 布局（D-08）：左栏=活动栏 + 分区内容（文件树/SCM/搜索/视图，随分区切换）；
 * 主区=恒定 tab 条 + FileViewHost 统一渲染（文件视图 / SCM diff / 空态）。
 * SCM 点击变更 → openDiffTab（diff-mode tab，同路径 file/diff 不互相覆盖）。
 *
 * #520 S4-P0-1 现状声明（原「不猜」注释的收敛结论）：activity 内容**消费注册契约的
 * `component` 字段**——经 PluginContributionBody（边界 + Suspense + Dynamic）直挂
 * 注册表里的 Solid 组件；视图 renderer 分支同理（选中 renderer 的注册组件即渲染
 * 目标，FileViewRenderBoundary 携带 fallback/rethrow policy 框住换源链）。也就是说
 * first-party-solid 的 file 贡献**注册即渲染**：宿主不持 builtin id 白名单，第三方
 * 注册同样生效——这是产品未决面的现状落地（契约已有该臂，宿主不再无视它）。
 * React 版的 Suspense lazy 缝随 lazy 注册退役后由 body 的 Suspense 承接（builtin
 * activity/view 组件经 glob 缝 lazy 加载，首帧可能短暂空白）。
 */
export default function FileSheetView(props: FileSheetViewProps) {
  const sessions = createZustandSignal(useIdentityStore, s => s.sessions)
  // 内核 store 动作引用稳定（create 期定义）；测试 resetStores 只回滚 state。
  const patchSheetMetadata = useWorkspaceStore.getState().patchSheetMetadata

  // ── 持久化 target 解析（metadata 是当前权威；sheet.state 仅 legacy 回退）──
  const persistedSessionId = createMemo<string | null>(() => {
    const sheet = props.sheet
    const metadataHasTarget = Object.prototype.hasOwnProperty.call(sheet.metadata ?? {}, 'targetSessionId')
    const metadataTarget = metadataHasTarget
      ? (sheet.metadata?.targetSessionId || null)
      : undefined
    const stateHasTarget = typeof sheet.state === 'object' && sheet.state !== null && 'targetSessionId' in sheet.state
    const legacyStateTarget = stateHasTarget
      ? (typeof (sheet.state as { targetSessionId?: unknown }).targetSessionId === 'string'
          ? (sheet.state as { targetSessionId: string }).targetSessionId || null
          : null)
      : undefined
    const singletonSessionId = sheet.singletonKey?.match(/^file:session:(.+)$/)?.[1]
    const legacySource = sheet.singletonKey?.match(/^file:(?!session:)(.+)$/)?.[1]
    return metadataHasTarget
      ? metadataTarget ?? null
      : stateHasTarget
        ? legacyStateTarget ?? null
        : singletonSessionId
          ?? (legacySource ? props.ctx.sessionBySource(legacySource)?.id : undefined)
          ?? props.ctx.activeSession
          ?? null
  })

  // ── 分区/目标本地态（React useReducer → signal + reducer）──
  const [sheetState, setSheetState] = createSignal(createFileSheetState(persistedSessionId()))
  createEffect(() => {
    if (sheetState().targetSessionId !== persistedSessionId()) {
      setSheetState(previous => fileSheetReducer(previous, { type: 'set-target-session', sessionId: persistedSessionId() }))
    }
  })

  const targetSession = createMemo(() => sessions().find(session => session.id === sheetState().targetSessionId))
  const target = createMemo(() => workspaceTargetFromSession(targetSession()))
  const targetSessionIdOfTarget = createMemo(() => target()?.sessionId)

  // ── workbench registry（进程单例；快照引用等值触发）──
  const fileWorkbenchRegistry = getFileWorkbenchRegistry()
  const workbenchSnapshot = createRegistrySignal(fileWorkbenchRegistry, () => fileWorkbenchRegistry.getSnapshot())
  const activities = createMemo(() => {
    workbenchSnapshot()
    return listFileActivities(target())
  })
  const selectedActivity = createMemo(() => activities().find(activity => activity.id === sheetState().activeSection) ?? activities()[0] ?? null)
  const fileProvider = createMemo(() => {
    workbenchSnapshot()
    return resolveFileProvider(target())
  })
  const gitProvider = createMemo(() => {
    workbenchSnapshot()
    return resolveGitProvider(target())
  })
  // I09-A-FE-02（D-01/D-08）：折叠唯一来源 ctx.sidebarCollapsed（titlebar 统一控制）
  const sidebarCollapsed = () => props.ctx.sidebarCollapsed

  // ── 版本化 tab（metadata 权威；损坏 → 空；v1 → file-mode tabs）──
  const tabsState = createMemo(() => parseFileTabs(props.sheet.metadata?.openTabs))
  const activeTabKey = createMemo(() => tabsState().activeKey)
  const activeTab = createMemo<FileTabRecord | null>(() => {
    const state = tabsState()
    if (state.activeKey) {
      const active = state.tabs.find(tab => fileTabKey(tab) === state.activeKey)
      if (active) return active
    }
    return state.tabs[state.tabs.length - 1] ?? null
  })

  const [dirtyTabKeys, setDirtyTabKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [savingTabKeys, setSavingTabKeys] = createSignal<ReadonlySet<string>>(new Set())
  const onDirtyChange = (key: string, dirty: boolean) => {
    setDirtyTabKeys(current => {
      const hasKey = current.has(key)
      if (hasKey === dirty) return current
      const next = new Set(current)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const onSavingChange = (key: string, saving: boolean) => {
    setSavingTabKeys(current => {
      const hasKey = current.has(key)
      if (hasKey === saving) return current
      const next = new Set(current)
      if (saving) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const discardDirty = (key: string) => setDirtyTabKeys(current => {
    if (!current.has(key)) return current
    const next = new Set(current)
    next.delete(key)
    return next
  })
  const canLeaveActiveTab = (nextKey: string | null) => {
    const currentKey = activeTab() ? fileTabKey(activeTab()!) : null
    if (!currentKey || currentKey === nextKey) return true
    if (savingTabKeys().has(currentKey)) return false
    if (!dirtyTabKeys().has(currentKey)) return true
    if (!window.confirm('当前文件有未保存修改。放弃修改并继续吗？')) return false
    discardDirty(currentKey)
    return true
  }
  createEffect(() => {
    if (dirtyTabKeys().size === 0 && savingTabKeys().size === 0) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    onCleanup(() => window.removeEventListener('beforeunload', warnBeforeUnload))
  })
  createEffect(() => {
    const unregister = registerWorkspaceLiveCloseGuard(props.sheet.id, () => {
      if (savingTabKeys().size > 0) return false
      if (dirtyTabKeys().size === 0) return true
      return window.confirm('此 File Sheet 有未保存修改。放弃修改并关闭吗？')
    })
    onCleanup(unregister)
  })

  const [failedRendererIds, setFailedRendererIds] = createSignal<ReadonlySet<string>>(new Set())
  let handledNavigation: string | null = null
  createEffect(() => {
    void targetSessionIdOfTarget()
    void activeTabKey()
    setFailedRendererIds(new Set<string>())
  })
  const viewRenderer = createMemo(() => resolveFileViewRenderer(target(), activeTab(), failedRendererIds()))

  const readCurrentTabs = () => {
    const currentSheet = useWorkspaceStore.getState().workspaceSheets.sheets.find(item => item.id === props.sheet.id)
    return parseFileTabs(currentSheet?.metadata?.openTabs)
  }

  const persistTabs = (tabs: FileTabRecord[], activeKey: string | null, targetSessionId = sheetState().targetSessionId) => {
    const activeFile = tabs.find(tab => fileTabKey(tab) === activeKey)?.path
    const fallback = tabs.length > 0 ? tabs[tabs.length - 1].path : ''
    patchSheetMetadata(props.sheet.id, {
      openTabs: serializeFileTabs({ version: 3, tabs, activeKey }),
      activeFile: activeFile ?? fallback,
      targetSessionId: targetSessionId ?? '',
    })
  }

  const openFileTab = (path: string, line?: number) => {
    const nextKey = fileTabKey({ path, viewType: 'file.text' })
    if (!canLeaveActiveTab(nextKey)) return
    const current = readCurrentTabs()
    const index = current.tabs.findIndex(tab => fileTabViewType(tab) === 'file.text' && tab.path === path)
    const revealLine = Number.isInteger(line) && (line ?? 0) > 0 ? line : undefined
    const next = index >= 0
      ? current.tabs.map((tab, tabIndex) => tabIndex === index && revealLine !== undefined ? { ...tab, line: revealLine } : tab)
      : [...current.tabs, { path, viewType: 'file.text', ...(revealLine === undefined ? {} : { line: revealLine }) }]
    persistTabs(next, nextKey)
  }

  // Cross-Sheet navigation is queued in metadata, but only this mounted FileSheet
  // may apply it. This preserves the same dirty/saving guard as Explorer/search
  // navigation and avoids an AgentSheet mutating editor tabs behind the host.
  createEffect(() => {
    const sheetId = props.sheet.id
    const raw = props.sheet.metadata?.[FILE_NAVIGATION_METADATA_KEY]
    if (!raw) {
      handledNavigation = null
      return
    }
    const pending = parsePendingFileNavigation(raw)
    if (!pending) {
      patchSheetMetadata(sheetId, { [FILE_NAVIGATION_METADATA_KEY]: '' })
      return
    }
    if (handledNavigation === pending.requestId) return

    // A session-scoped FileSheet can be manually retargeted. Returning to its
    // owning AgentSheet must clear the old workspace tabs before changing target,
    // otherwise an identical relative path could be read/written in the wrong root.
    if (pending.sessionId !== sheetState().targetSessionId) {
      if (savingTabKeys().size > 0) return
      if (dirtyTabKeys().size > 0 && !window.confirm('当前工作区有未保存修改。放弃修改并打开链接文件吗？')) {
        handledNavigation = pending.requestId
        patchSheetMetadata(sheetId, { [FILE_NAVIGATION_METADATA_KEY]: '' })
        return
      }
      setDirtyTabKeys(new Set<string>())
      patchSheetMetadata(sheetId, {
        openTabs: serializeFileTabs({ version: 3, tabs: [], activeKey: null }),
        activeFile: '',
        targetSessionId: pending.sessionId,
        // Keep the intent for the next render. The target-sync effect advances
        // local ownership first; only then may the target file tab mount.
        [FILE_NAVIGATION_METADATA_KEY]: raw,
      })
      return
    }

    const nextTab: FileTabRecord = {
      path: pending.path,
      viewType: 'file.text',
      ...(pending.line === undefined ? {} : { line: pending.line }),
    }
    const nextKey = fileTabKey(nextTab)
    const currentKey = activeTab() ? fileTabKey(activeTab()!) : null
    // Saving is transient and cannot be cancelled safely. Keep the intent queued;
    // this effect retries as soon as the saving key set changes.
    if (currentKey && currentKey !== nextKey && savingTabKeys().has(currentKey)) return
    handledNavigation = pending.requestId
    if (currentKey && currentKey !== nextKey && dirtyTabKeys().has(currentKey)) {
      if (!window.confirm('当前文件有未保存修改。放弃修改并打开链接文件吗？')) {
        patchSheetMetadata(sheetId, { [FILE_NAVIGATION_METADATA_KEY]: '' })
        return
      }
      setDirtyTabKeys(current => {
        const next = new Set(current)
        next.delete(currentKey)
        return next
      })
    }

    const current = readCurrentTabs()
    const existingIndex = current.tabs.findIndex(tab => fileTabViewType(tab) === 'file.text' && tab.path === pending.path)
    const tabs = existingIndex >= 0
      ? current.tabs.map((tab, index) => index === existingIndex ? { ...tab, ...(pending.line === undefined ? {} : { line: pending.line }) } : tab)
      : [...current.tabs, nextTab]
    patchSheetMetadata(sheetId, {
      openTabs: serializeFileTabs({ version: 3, tabs, activeKey: nextKey }),
      activeFile: pending.path,
      targetSessionId: sheetState().targetSessionId ?? '',
      [FILE_NAVIGATION_METADATA_KEY]: '',
    })
  })

  const openDiffTab = (path: string, staged: boolean) => {
    const nextKey = fileTabKey({ path, viewType: 'git.diff' })
    if (!canLeaveActiveTab(nextKey)) return
    const current = readCurrentTabs()
    const index = current.tabs.findIndex(tab => fileTabViewType(tab) === 'git.diff' && tab.path === path)
    const next = index >= 0
      ? current.tabs.map((tab, i) => (i === index ? { ...tab, staged } : tab))
      : [...current.tabs, { path, viewType: 'git.diff', staged }]
    persistTabs(next, nextKey)
  }

  const selectTab = (key: string) => {
    if (!canLeaveActiveTab(key)) return
    const current = readCurrentTabs()
    if (!current.tabs.some(tab => fileTabKey(tab) === key)) return
    persistTabs(current.tabs, key)
  }

  const closeTab = (key: string) => {
    if (savingTabKeys().has(key)) return
    if (dirtyTabKeys().has(key)) {
      if (!window.confirm('当前文件有未保存修改。放弃修改并关闭吗？')) return
      discardDirty(key)
    }
    const current = readCurrentTabs()
    const remaining = current.tabs.filter(tab => fileTabKey(tab) !== key)
    const activeKey = current.activeKey === key
      ? (remaining.length > 0 ? fileTabKey(remaining[remaining.length - 1]) : null)
      : current.activeKey
    persistTabs(remaining, activeKey)
  }

  const selectSection = (section: string) => setSheetState(previous => fileSheetReducer(previous, { type: 'set-section', section }))
  const selectSource = (sessionId: string | null) => {
    if (sessionId === sheetState().targetSessionId) return
    if (savingTabKeys().size > 0) return
    if (dirtyTabKeys().size > 0 && !window.confirm('当前工作区有未保存修改。放弃修改并切换工作区吗？')) return
    setDirtyTabKeys(new Set<string>())
    setSheetState(previous => fileSheetReducer(previous, { type: 'set-target-session', sessionId }))
    // A path is meaningful only inside its owning workspace. Rebinding old tabs to a
    // new target can read or write an unrelated same-named file, so target switches
    // atomically clear the old workspace's tab set.
    persistTabs([], null, sessionId)
    // 从“会话”分区选择目标的用户意图是浏览该工作区；选择完成后直接进入 Explorer，
    // 否则 FileTree 不会挂载，也就永远不会发起根目录读取。
    if (sessionId) setSheetState(previous => fileSheetReducer(previous, { type: 'set-section', section: 'builtin.file.explorer' }))
  }

  // Context is derived only from the selected persisted Session owner; never from active runtime state.
  const sheetContext = createMemo(() => target() ? { agentId: target()!.agentId, source: target()!.source } : null)

  const isolatedActivityInput = createMemo(() => ({
    target: target(),
    targetSessionId: sheetState().targetSessionId,
    sessions: sessions(),
    context: sheetContext(),
    activeFile: activeTab()?.path ?? null,
  }))

  const onActivityEvent = (event: string, detail: unknown) => {
    if (event === 'select-target') selectSource(typeof detail === 'string' ? detail : null)
    else if (event === 'open-file' && typeof detail === 'string') openFileTab(detail)
    else if (event === 'open-file' && detail && typeof detail === 'object' && 'path' in detail) {
      const input = detail as { path: unknown; line?: unknown }
      if (typeof input.path === 'string') openFileTab(input.path, typeof input.line === 'number' ? input.line : undefined)
    }
    else if (event === 'open-diff' && detail && typeof detail === 'object' && 'path' in detail) {
      const input = detail as { path: unknown; staged?: unknown }
      if (typeof input.path === 'string') openDiffTab(input.path, input.staged === true)
    }
  }

  // first-party-solid activity 的 props 工厂（FileActivityProps 全量投影；注册组件
  // 是同一批域内实体的直传薄壳，DOM/类名与原宿主直绘逐项一致）。
  const activityProps = (): FileActivityProps => ({
    target: target(),
    targetSessionId: sheetState().targetSessionId,
    sessions: sessions(),
    context: sheetContext(),
    activeFile: activeTab()?.path ?? null,
    fileProvider: fileProvider(),
    gitProvider: gitProvider(),
    onSelectTarget: selectSource,
    onOpenFile: openFileTab,
    onOpenDiff: openDiffTab,
  })

  const ActivityContent = () => (
    <Show when={selectedActivity()} keyed fallback={
      <div class="file-section-panel"><p class="file-section-hint">没有可用的 File Workbench activity</p></div>
    }>
      {activity => (
        // #520 S4-P0-1：分发块收敛 + 消费注册契约的 component 字段（原 builtin id
        // 硬编码 switch 退役——见本文件头注的现状声明）。
        <PluginContributionBody
          contributionId={activity.id}
          contribution={activity}
          surfaceClass="file-section-panel"
          surfaceInput={isolatedActivityInput}
          onSurfaceEvent={onActivityEvent}
          componentProps={activityProps}
        />
      )}
    </Show>
  )

  const viewInstanceKey = createMemo(() => `${workspaceTargetKey(target()) ?? 'unbound'}:${activeTab() ? fileTabKey(activeTab()!) : 'empty'}`)

  // first-party-solid renderer 的 props 工厂（FileViewRendererProps 全量投影）。
  const viewRendererProps = (currentTab: FileTabRecord): FileViewRendererProps => ({
    target: target(),
    context: sheetContext(),
    tab: currentTab,
    fileProvider: fileProvider(),
    gitProvider: gitProvider(),
    onCloseTab: closeTab,
    onDirtyChange: onDirtyChange,
    onSavingChange: onSavingChange,
  })

  const ViewContent = () => {
    return (
    <Show
      when={activeTab() && viewRenderer()}
      fallback={
        <div class="file-tab-empty"><div class="file-empty-card"><strong>{activeTab() ? '没有可用的文件视图 renderer' : '打开一个文件开始阅读'}</strong></div></div>
      }
    >
      <FileViewRenderBoundarySolid
        rendererId={viewRenderer()!.id}
        onError={viewRenderer()!.onError ?? (() => 'fallback')}
        onFallback={rendererId => setFailedRendererIds(current => new Set([...current, rendererId]))}
      >
        <Show when={viewInstanceKey()} keyed>
          {_key => {
            const renderer = viewRenderer()!
            const currentTab = activeTab()!
            // #520 S4-P0-1：视图 renderer 分支同样消费注册契约的 component 字段
            // （选中的 renderer 即渲染目标）。withBoundary=false：错误必须直达外层
            // FileViewRenderBoundary 的 fallback/rethrow policy——双层边界会把 renderer
            // 错误截在内层、走不了宿主换 renderer 链。
            return (
              <PluginContributionBody
                contributionId={renderer.id}
                contribution={renderer}
                withBoundary={false}
                surfaceClass="file-view-isolated"
                surfaceInput={() => ({ target: target(), context: sheetContext(), tab: currentTab })}
                onSurfaceEvent={(event, detail) => {
                  if (event === 'close-tab' && typeof detail === 'string') closeTab(detail)
                  else if (event === 'dirty-state' && typeof detail === 'boolean') onDirtyChange(fileTabKey(currentTab), detail)
                  else if (event === 'saving-state' && typeof detail === 'boolean') onSavingChange(fileTabKey(currentTab), detail)
                }}
                componentProps={() => viewRendererProps(currentTab)}
              />
            )
          }}
        </Show>
      </FileViewRenderBoundarySolid>
    </Show>
    )
  }

  return (
    <div class="file-sheet">
      <FileSheetSidebarSolid
        activeSection={sheetState().activeSection}
        activities={activities()}
        collapsed={sidebarCollapsed()}
        onSelectSection={selectSection}
      >
        {ActivityContent()}
      </FileSheetSidebarSolid>
      <main class="file-editor">
        <FileTabBarSolid tabs={tabsState().tabs} activeKey={tabsState().activeKey} dirtyKeys={dirtyTabKeys()} savingKeys={savingTabKeys()} onSelect={selectTab} onClose={closeTab} />
        {ViewContent()}
      </main>
    </div>
  )
}
