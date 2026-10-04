/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, lazy, on, onCleanup, onMount, Show, Suspense } from 'solid-js'
import SheetLayout from './workspace-sheets/SheetLayout.solid.tsx'
import WorkspaceTitlebar from './workspace-sheets/WorkspaceTitlebar.solid.tsx'
import { flushIdentityBackend, useIdentityStore } from './domains/identity/identityStore'
import { logError } from './contracts/frontendLogSink'
import { useRuntimeStore } from './domains/runtime/runtimeStore'
import { useWorkspaceStore } from './domains/workspace/workspaceStore'
import { IS_TAURI, isBrowserMockRuntime } from './infrastructure/tauri/env'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { tauriInvokeTransport } from './infrastructure/acp/tauriTransport.ts'
import { appClients } from './app/appClients.ts'
import { reportRuntimeError, resolveRuntimeErrors } from './app/runtimeError'
import { sheetHasLeftColumn } from './workspace-sheets/sheetSidebarState.ts'
import {
  closeOtherWorkspaces,
  closeRightWorkspaces,
  closeWorkspace,
} from './workspace-sheets/workspaceController.ts'
import { listen } from '@tauri-apps/api/event'
import { runRollupTrimBeforeClose } from './infrastructure/events/rollupTrim.ts'
import { createPermissionController, registerPermissionController } from './infrastructure/acp/permissionController'
import { createInteractionRejectionController } from './infrastructure/acp/interactionRejectionController.ts'
import './app/bootstrap/identityCrossDomainWiring'
import './app/bootstrap/workspaceControllerWiring'
import { runAppBootstrapTransaction } from './app/bootstrap/appBootstrapTransaction.solid'
import { useHydrationStore } from './app/bootstrap/hydrationState'
import { useModalOverlayStore } from './app/modalOverlayStore'
import { setupWindowLifecycle } from './app/windowLifecycle.solid'
import { createAppSkinWiring } from './app/skinWiring.solid'
import PermissionDialog from './components/PermissionDialog.solid.tsx'
import ErrorCenter from './components/ErrorCenter.solid.tsx'
import SessionOwnerRecoveryDialog from './components/SessionOwnerRecoveryDialog.solid.tsx'
import {
  getContextPanelRegistry,
  getFontContributionRegistry,
  getInterfaceModeRegistry,
  getShellRecipeRegistry,
} from './plugin-runtime/runtimeServices.ts'
import { projectFontContributions } from './infrastructure/fonts/fontProjection.ts'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from './plugin-runtime/workspaces/workspaceRegistry.ts'
import { activateInterfaceMode, ensureInterfaceModeProfile, interfaceModeQuickTarget, resolveShellRecipe } from './application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from './domains/interface/interfaceModeStore.ts'
import { selectContextPanels } from './plugin-runtime/context-panel/contextPanelSelection.ts'
import { usePresentationPreferenceStore } from './domains/presentation/presentationPreferenceStore.ts'
import { IsolatedPluginSurface } from './plugin-runtime/ui/IsolatedPluginSurface.solid.tsx'
import { createActiveInterfaceModeContribution } from './infrastructure/state/solidSheetSupport.solid.tsx'
import { InterfaceModeSceneHost } from './sheets/interfaceModeScenes.solid.tsx'
import { drainPersistentStateBeforeClose } from './app/lifecycle/drainPersistentStateBeforeClose.ts'
import { useRightRailStore } from './domains/workspace/layoutRailsStore.ts'
import { readPersistedApprovalMode } from './domains/permission/approvalMode.ts'
import { restoreApprovalModeFromBackendAuthority } from './domains/permission/approvalModeRestore.ts'
import { openOrFocusSettingsSheet } from './sheets/settingsSheetNavigation.ts'
import { useThemeStore } from './domains/theme/themeStore'
import { createZustandSignal } from './infrastructure/state/solidStoreBridge.ts'
import { createRegistrySignal } from './infrastructure/state/solidSheetSupport.solid.tsx'
import type { InterfaceModeContribution } from './plugin-runtime/interface-mode/interfaceModeTypes.ts'
import type { SettingsDomainId } from './components/settings/settingsDomains.ts'

// 非首屏 Dialog/Sheet 懒加载：ProfileEditor/SessionSettings 与 Prism Sheet 按需分包
// #154 阶段 4：Settings 不再是覆盖层 Dialog——迁入 sheet 体系（settingsSheetNavigation）。
const ProfileEditor = lazy(() => import('./components/ProfileEditor.solid.tsx'))
const SessionSettings = lazy(() => import('./components/SessionSettings.solid.tsx'))
const SheetLauncher = lazy(() => import('./workspace-sheets/SheetLauncher.solid.tsx'))

// Runtime registries are process singletons.  信号化订阅在组件体一次性建立，
// owner 卸载自动回收（原 React 稳定适配器语义的 Solid 对应形态）。
const contextPanelRegistry = getContextPanelRegistry()
const fontContributionRegistry = getFontContributionRegistry()
const interfaceModeRegistry = getInterfaceModeRegistry()
const shellRecipeRegistry = getShellRecipeRegistry()

const approvalModeScope = { kind: 'app' as const, id: 'approval-mode' }
const approvalModeKey = (action: string) => `app:approval-mode:${action}`

function LazyDialogFallback() {
  return (
    <div class="sheet-empty-host">
      <div class="sheet-empty-kicker">LOADING</div>
      <p>加载模块…</p>
    </div>
  )
}

// 窗口控制句柄：非 Tauri 环境（浏览器预览）降级为无操作 stub。模块级单例，避免每 render 重建。
const appWindowSingleton = (() => { try { return getCurrentWindow() } catch { return { minimize() {}, isFullscreen() { return Promise.resolve(false) }, setFullscreen(_v: boolean) { return Promise.resolve() }, destroy() {} } } })()

// 非 Tauri（浏览器预览）时 @tauri-apps/api 的 listen/invoke 会 reject，统一守卫

// App.solid 是纯组合根（#520 S3-P1-3）：bootstrap 事务在 app/bootstrap/appBootstrapTransaction、
// 窗口生命周期在 app/windowLifecycle、Skin 接线在 app/skinWiring；本文件只剩装配调用、
// 全局事件监听与 JSX 布局。
export default function App() {
  const interfaceMode = createZustandSignal(useInterfaceModeStore, state => state.interfaceMode)
  const hydrationStatus = createZustandSignal(useHydrationStore, state => state.status)
  const presentationProfileId = createZustandSignal(usePresentationPreferenceStore, state => state.activeProfileId)
  // registry 快照信号（值只作失效信号与 entries 读取，原 useSyncExternalStore 同源语义）
  const workspaceRegistryTick = createRegistrySignal({ subscribe: subscribeWorkspaceRegistry }, getWorkspaceRegistrySnapshot)
  const contextPanelSnapshot = createRegistrySignal(contextPanelRegistry, () => contextPanelRegistry.getSnapshot())
  const fontSnapshot = createRegistrySignal(fontContributionRegistry, () => fontContributionRegistry.getSnapshot())
  createEffect(() => { projectFontContributions(document.documentElement, fontSnapshot().entries) })
  const interfaceModeSnapshot = createRegistrySignal(interfaceModeRegistry, () => interfaceModeRegistry.getSnapshot())
  const interfaceModeContribution = createActiveInterfaceModeContribution() as () => InterfaceModeContribution
  const quickInterfaceMode = createMemo(() => interfaceModeQuickTarget(interfaceMode()))
  // Shell Recipe（ADR-0003）：激活期已硬校验引用；此处订阅仅保证插件热换后
  // 数据属性跟随 registry 快照更新。解析兜底 classic，瞬态不崩壳。
  const shellRecipeTick = createRegistrySignal(shellRecipeRegistry, () => shellRecipeRegistry.getSnapshot())
  const shellRecipe = createMemo(() => { workspaceRegistryTick(); shellRecipeTick(); return resolveShellRecipe(interfaceModeContribution()) })
  createEffect(() => {
    const mode = interfaceMode()
    document.documentElement.dataset.interfaceMode = mode
    document.body.dataset.interfaceMode = mode
    onCleanup(() => {
      delete document.documentElement.dataset.interfaceMode
      delete document.body.dataset.interfaceMode
    })
  })
  createEffect(() => { void interfaceMode(); void interfaceModeSnapshot(); ensureInterfaceModeProfile() })
  const [activeSession, setActiveSession] = createSignal<string | null>(null)
  // W2-12：右栏折叠随 sheet 声明挂载（layoutRailsStore.rightCollapsed），旧 RightPanel 退役
  const [showProfileEdit, setShowProfileEdit] = createSignal(false)
  const [sessionSettingsId, setSessionSettingsId] = createSignal<string | null>(null)
  const [showSheetLauncher, setShowSheetLauncher] = createSignal(false)
  // W1-03（F2-B）：左栏折叠/宽度真值源是 domains/workspace/layoutRailsStore（预设不覆盖布局），App 只读
  const sidebarWidth = createZustandSignal(useRightRailStore, s => s.leftRailWidth)
  const workspaceSheets = createZustandSignal(useWorkspaceStore, s => s.workspaceSheets)
  // active Sheet 的左栏模式同时决定折叠按钮能力与 TitleBar 左侧轨道宽度。
  const activeSheet = createMemo(() => workspaceSheets().sheets.find(sheet => sheet.id === workspaceSheets().activeSheetId))
  const sidebarCollapsed = createZustandSignal(useRightRailStore, s => s.leftRailCollapsed)
  const showSidebar = createZustandSignal(useThemeStore, s => s.showSidebar !== false)
  // #154：左列是否存在以「注册表真的提供 sidebar 组件」为准，而不是只看 sidebarMode。
  // 后者会让「声明 'sheet' 但把左栏画在自己内容区里」的 Sheet 也空占一条标题栏轨道，
  // 那条轨道自画的边框由此与左列自己的边框错开（浏览器 Sheet 实测错开 84px）。
  // 主题级 showSidebar 一并计入，否则标题栏会为被主题隐藏的左栏保留轨道。
  const sidebarEnabled = createMemo(() => !!sheetHasLeftColumn(activeSheet()) && showSidebar() !== false)
  const rightPanelEnabled = createMemo(() => {
    const sheet = activeSheet()
    if (!sheet) return false
    return selectContextPanels(contextPanelSnapshot().entries, {
      workspaceKind: sheet.kind,
      sheetId: sheet.id,
      activeSessionId: activeSession(),
    }).length > 0
  })
  const agents = createZustandSignal(useIdentityStore, s => s.agents)
  // #326：空串 = 没有 Agent（零 Agent 首跑）。不再回落硬编码 'peri'——那会凭空造出一个
  // 不存在的 Agent（sheet 聚焦、权限切片、会话归属都按它算）。
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  let prevActiveAgent = activeAgent()

  onMount(() => {
    const clearActiveSession = () => setActiveSession(null)
    window.addEventListener('pylon:agent-switched', clearActiveSession)
    onCleanup(() => window.removeEventListener('pylon:agent-switched', clearActiveSession))
  })

  // 施工文档 §5.3：ErrorCenter/Overview 的恢复按钮经窗口事件打开现有 Settings /
  // Runtime Sheet，不新建导航 store。
  // #154 阶段 4：open-settings 落点从覆盖层改为设置 sheet（幂等：已开则 patch 导航态并聚焦）。
  onMount(() => {
    const openSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ domain?: string; section?: string; agentId?: string }>).detail ?? {}
      openOrFocusSettingsSheet(detail)
    }
    const openRuntime = () => useWorkspaceStore.getState().openSheet({ kind: 'runtime', title: 'Runtime' })
    window.addEventListener('pylon:open-settings', openSettings)
    window.addEventListener('pylon:open-runtime-sheet', openRuntime)
    onCleanup(() => {
      window.removeEventListener('pylon:open-settings', openSettings)
      window.removeEventListener('pylon:open-runtime-sheet', openRuntime)
    })
  })

  // FE-AUD-005：单一 bootstrap 事务——hydrate domains → agents → prune → listener（装配拆至 app/bootstrap）
  runAppBootstrapTransaction()

  // 全局审批模式：后端为持久化权威（#448 PR3/PR4——#321 决议「收敛到后端权威」）。
  // 决策逻辑在 domains/permission/approvalModeRestore（可测事务）：后端持久层在场
  // → 应用权威值；后端从未存过 → localStorage 首次种子（set 自带写穿）；后端不可用
  // → 降级显示本地值。旧「本地有值即推送」分支移除——CLI 桥等不经 webview 的 set
  // 重启后被前端旧值静默覆盖的漂移路径由此消除。本地 key 已收口为 runtimeStore 侧的
  // seed + 镜像（#520 S2-P1，browser 模式亦可恢复），此处不再手工维护镜像。
  onMount(() => {
    if (!IS_TAURI || isBrowserMockRuntime()) return
    let disposed = false
    void restoreApprovalModeFromBackendAuthority({
      loadPersisted: () => appClients.runtime.loadApprovalModePersisted(),
      seedToBackend: mode => appClients.runtime.setApprovalMode(mode),
      readLocal: () => readPersistedApprovalMode(),
      apply: mode => {
        if (disposed) return
        useRuntimeStore.getState().setApprovalMode(mode)
        resolveRuntimeErrors({ key: approvalModeKey('恢复权限模式'), scope: approvalModeScope })
      },
      applyLocalFallback: mode => {
        if (!disposed) useRuntimeStore.getState().setApprovalMode(mode)
      },
      reportError: (action, error) => {
        if (!disposed) reportRuntimeError(action, error, undefined, {
          key: approvalModeKey(action),
          scope: approvalModeScope,
          source: 'permission.approval-mode',
        })
      },
    })
    onCleanup(() => { disposed = true })
  })

  // 仅在 activeAgent 切换时聚焦该 agent 的 sheet；普通 sheet 导航（打开 Prism/工具 sheet、
  // 点击其他 tab）不受影响。用前后值对比避免 workspaceSheets 每次新引用触发重复聚焦。
  createEffect(() => {
    const agent = activeAgent()
    void workspaceSheets()
    if (prevActiveAgent === agent) return
    prevActiveAgent = agent
    const agentSheet = useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.kind === 'agent' && sheet.agentId === agent)
    if (agentSheet) useWorkspaceStore.getState().focusSheet(agentSheet.id)
  })

  // 权限请求 controller：只挂生命周期（listen → store 纯 reducer；approve invoke），不内嵌业务分支
  onMount(() => {
    if (!IS_TAURI) return
    const controller = createPermissionController({
      dispatch: action => useRuntimeStore.getState().setPermission(action),
      getState: () => useRuntimeStore.getState().permission,
      // P1-1：controller 只作用在当前 agent 的权限切片
      getCurrentAgentId: () => useIdentityStore.getState().activeAgent,
      listen: (event, handler) => listen(event, handler),
      invoke: tauriInvokeTransport,
    })
    registerPermissionController(controller)
    onCleanup(() => {
      registerPermissionController(null)
      void controller.dispose()
    })
  })

  // Unsupported/malformed ACP interactions have their own transport and notice;
  // they must not be inserted into the permission reducer as actionable requests.
  onMount(() => {
    if (!IS_TAURI) return
    const controller = createInteractionRejectionController({
      listen: (event, handler) => listen(event, handler),
    })
    onCleanup(() => { void controller.dispose() })
  })

  // 窗口生命周期（尺寸记忆 + 关窗 drain）接线，拆至 app/windowLifecycle（#520 S3-P1-3）
  const drainBeforeClose = async () => {
    // #439：canonical 自写轨退役（kernel 严格单写者，前端 pending 恒空），
    // 关窗 drain 只剩 identity 写穿一条链。
    await drainPersistentStateBeforeClose({ flushIdentity: flushIdentityBackend })
    // #81 L3：前端 pending 已清空（kernel 单写者）→ 安全窗口内运行裁剪迁移
    // （可暂停/续跑；超时不阻塞关窗；trim_rolledup 策略关闭时后端只报告）。
    await runRollupTrimBeforeClose()
  }
  setupWindowLifecycle(drainBeforeClose)

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setShowSheetLauncher(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  // 浏览器模式静态演示全景（用户直派，非施工项）：每次启动补 agents/状态灯（非持久化），
  // 仅首次种会话/sheets。声明在所有现有 effect 之后（SheetLayout 子 effect 先跑）；
  // 幂等=seedDemo 内部（sessions 空才种会话）+ seeded 标记（对应 React 期 StrictMode 双跑）。
  let demoSeeded = false
  createEffect(() => {
    const status = hydrationStatus()
    // Keep the browser/demo adapter out of production bundles.  Tauri
    // production must not merely skip the seed at runtime; the dynamic
    // import itself is development/mock-only.
    if (!import.meta.env.DEV) return
    if (IS_TAURI && !isBrowserMockRuntime()) return
    if (status !== 'ready') return
    if (demoSeeded) return
    const demoParams = new URLSearchParams(window.location.search)
    void import('./app/bootstrap/browserDemoBootstrap.ts').then(({ runBrowserDemoSeed }) => {
      if (demoSeeded) return
      runBrowserDemoSeed(setActiveSession, {
        withPermission: demoParams.get('demo-permission') === '1',
        scenario: demoParams.get('demo-scenario') === 'standard' ? 'standard' : 'visual',
        reset: demoParams.get('demo-reset') === '1',
      })
      demoSeeded = true
      resolveRuntimeErrors({ key: 'app:browser-demo-bootstrap' })
    }).catch(error => {
      if (!demoSeeded) reportRuntimeError('加载浏览器演示数据', error, undefined, {
        key: 'app:browser-demo-bootstrap',
        scope: { kind: 'app', id: 'browser-demo' },
        source: 'app.browser-demo',
      })
    })
  })

  // Skin 接线（全局基线 + 根 surface + documentRoot 投影）拆至 app/skinWiring（#520 S3-P1-3）
  const { appSkin } = createAppSkinWiring({ sidebarCollapsed, sidebarWidth, sidebarEnabled })

  const appWindow = appWindowSingleton
  const closeWindowWithFlush = async () => {
    try {
      await drainBeforeClose()
    } catch (error) {
      reportRuntimeError('关闭前持久化失败，窗口已保持打开', error, undefined, {
        key: 'app:close-persistence', scope: { kind: 'app', id: 'lifecycle' }, source: 'app.lifecycle',
      })
      return
    }
    await appWindow.destroy()
  }
  const profilesOpen = createMemo(() => showProfileEdit())
  // #309：原生子视图（浏览器 WebView2 子窗口）在原生层位于 DOM 之上，覆盖层盖不住它。
  // 模态覆盖层打开期间让原生子视图暂时隐藏（页面继续运行），否则覆盖层上的按钮被
  // 原生页面吃掉点击；关闭后由消费方恢复可见。（原 useModalOverlayVeil 的 Solid 内联形态）
  createVeil('sheet-launcher', showSheetLauncher)
  createVeil('profile-editor', profilesOpen)
  createVeil('session-settings', () => sessionSettingsId() !== null)

  function createVeil(key: string, open: () => boolean) {
    createEffect(on(open, isOpen => {
      useModalOverlayStore.getState().setOverlayOpen(key, isOpen)
      onCleanup(() => useModalOverlayStore.getState().setOverlayOpen(key, false))
    }, { defer: true }))
  }

  return (
    <div class="app" ref={appSkin.ref} {...appSkin.resolved().dataAttributes} data-interface-mode={interfaceMode()} data-presentation-profile={presentationProfileId()} data-shell-sidebar-side={shellRecipe().sidebarSide} data-shell-context-side={shellRecipe().contextPanelSide}>
      {/* 装饰场景按 InterfaceModeContribution.sceneSurface 声明位挂载（A-V9 完全体）：
          宿主场景注册表解析 surfaceId，插件贡献的模式声明同一 id 即获得等价装饰层。 */}
      <Show when={interfaceModeContribution().sceneSurface}>
        {scene => <InterfaceModeSceneHost surfaceId={scene().surfaceId} />}
      </Show>
      <WorkspaceTitlebar latest={() => ({
        sheets: workspaceSheets().sheets,
        activeSheetId: workspaceSheets().activeSheetId,
        activeAgent: activeAgent(),
        activeSheetKind: activeSheet()?.kind,
        activeSessionId: activeSession(),
        sidebarCollapsed: sidebarCollapsed(),
        sidebarEnabled: sidebarEnabled(),
        rightPanelEnabled: rightPanelEnabled(),
        onToggleSidebar: () => useRightRailStore.getState().setLeftRailCollapsed(!sidebarCollapsed()),
        onFocusSheet: (id: string) => useWorkspaceStore.getState().focusSheet(id),
        onCloseSheet: (id: string) => { void closeWorkspace(id) },
        menuActions: {
          onTogglePin: (id: string) => useWorkspaceStore.getState().toggleSheetPin(id),
          onClose: (id: string) => { void closeWorkspace(id) },
          onCloseOthers: (id: string) => { void closeOtherWorkspaces(id) },
          onCloseRight: (id: string) => { void closeRightWorkspaces(id) },
          onReopen: () => useWorkspaceStore.getState().reopenSheet(),
        },
        onOpenSheet: () => setShowSheetLauncher(true),
        onToggleRightPanel: () => useRightRailStore.getState().setCollapsed(!useRightRailStore.getState().collapsed),
        // 齿轮菜单的设置域项是唯一设置入口：幂等开/聚焦（ADR-0013）；关闭走页签（#195）。
        onOpenSettingsDomain: (domain: SettingsDomainId) => { openOrFocusSettingsSheet({ domain }) },
        interfaceMode: interfaceMode(),
        chromeStyle: interfaceModeContribution().chromeStyle,
        quickSwitchLabel: quickInterfaceMode()?.label,
        onToggleInterfaceMode: quickInterfaceMode() ? () => activateInterfaceMode(quickInterfaceMode()!.id) : undefined,
        onMinimize: () => appWindow.minimize(),
        onToggleFullscreen: () => appWindow.isFullscreen().then(fullscreen => appWindow.setFullscreen(!fullscreen)).catch(error => logError('全屏切换失败', error)),
        onCloseWindow: () => void closeWindowWithFlush(),
      })} />
      <Show when={interfaceModeContribution().shellSurface?.placement === 'before-workspace' ? interfaceModeContribution().shellSurface : undefined}>
        {surface => (
          <IsolatedPluginSurface
            surfaceId={surface().surfaceId}
            className="interface-mode-shell-surface interface-mode-shell-before-workspace"
            input={{ modeId: interfaceModeContribution().id, activeSheetId: workspaceSheets().activeSheetId, activeAgent: activeAgent() }}
          />
        )}
      </Show>
      <Suspense fallback={null}>
        <Show when={showSheetLauncher()}>
          <SheetLauncher latest={() => ({
            open: showSheetLauncher(),
            agents: agents(),
            sheets: workspaceSheets().sheets,
            onOpenChange: (open: boolean) => setShowSheetLauncher(open),
            onFocusSheet: (id: string) => useWorkspaceStore.getState().focusSheet(id),
            onOpenSheet: (kind: string, title: string, agentId?: string) => useWorkspaceStore.getState().openSheet({ kind, title, agentId }),
            onOpenSettings: () => openOrFocusSettingsSheet(),
            onOpenProfiles: () => setShowProfileEdit(true),
          })} />
        </Show>
      </Suspense>

      <ErrorCenter />
      <SessionOwnerRecoveryDialog />

      {/* W1-03：布局段下移 SheetLayout（侧栏壳/主区/右栏壳 + profile 投影 effects） */}
      <SheetLayout
        activeSession={activeSession()}
        onSelectSession={setActiveSession}
        onProfileEdit={() => setShowProfileEdit(true)}
        onSessionSettings={setSessionSettingsId}
      />
      <Show when={interfaceModeContribution().shellSurface?.placement === 'overlay' ? interfaceModeContribution().shellSurface : undefined}>
        {surface => (
          <IsolatedPluginSurface
            surfaceId={surface().surfaceId}
            className="interface-mode-shell-surface interface-mode-shell-overlay"
            input={{ modeId: interfaceModeContribution().id, activeSheetId: workspaceSheets().activeSheetId, activeAgent: activeAgent() }}
          />
        )}
      </Show>
      <Suspense fallback={<LazyDialogFallback />}>
        {/* #154 阶段 4：设置覆盖层挂载点退役——设置以 settings sheet 常驻 sheet 体系。 */}
        <Show when={profilesOpen()}>
          <ProfileEditor onClose={() => setShowProfileEdit(false)} />
        </Show>
        <Show when={sessionSettingsId()}>
          {id => (
            <SessionSettings sessionId={id()} open={!!id()} onClose={() => setSessionSettingsId(null)} onDeleted={() => setActiveSession(null)} />
          )}
        </Show>
      </Suspense>
      {/* 权限请求弹窗：store 驱动（无 active 请求返回 null），App 单例挂载不随 sheet 卸载 */}
      <PermissionDialog />
    </div>
  )
}
