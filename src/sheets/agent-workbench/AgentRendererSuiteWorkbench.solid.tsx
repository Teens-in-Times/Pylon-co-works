/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import type { Session } from '../../domains/identity/identityStore.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore.ts'
import { RendererSuiteHost } from '../../host/renderer-suite/rendererSuiteHost.ts'
import { resolveRendererActivation } from '../../plugin-runtime/renderers/rendererActivationResolver.ts'
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { getPluginSettingOptionsRegistry, getPresentationProfileRegistry, getRendererRegistry, getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { resolveProductionRenderAppearance } from '../../plugin-runtime/renderers/productionRenderAppearance.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { createWorkbenchHostPort, type WorkbenchHostPort } from '../../plugin-runtime/renderers/workbenchHostPort.ts'
import type { WorkbenchMountInput } from '../../renderers/solid-workbench/workbenchContracts.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { createAgentWorkbenchSessionRuntime } from '../../application/agent-workbench/agentWorkbenchSession.ts'
import {
  agentAdvertisedModelEntries,
  agentProbeFresh,
  agentProbeInFlight,
  markProbeInFlight,
  markProbeUnavailable,
  noteAgentSelectorsSnapshot,
} from '../../application/agent-workbench/agentAdvertisedModels.ts'
import { AgentWorkbenchLifecycle } from '../../application/agent-workbench/agentWorkbenchLifecycle.ts'

import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { bindingHint, refineBindingGeneration, resolveBindingState } from '../../domains/binding/bindingState.ts'
import { sessionContext, toAgentContextKey } from '../../domains/agent/agentContext.ts'
import { resolveRendererSuiteFallback } from '../../host/renderer-suite/rendererSuiteFallbackPolicy.ts'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore.ts'
import { publishActiveWorkbenchHostPort } from '../../application/agent-workbench/activeWorkbenchHostPort.ts'
import { createAgentWorkbenchHostCommands } from '../../application/agent-workbench/agentWorkbenchCommands.ts'
import { openFileLinkFromEvent, openResourceInFileSheet } from '../file/fileSheetNavigation.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { createRegistrySignal } from '../../infrastructure/state/solidSheetSupport.solid.tsx'

/**
 * AgentRendererSuiteWorkbench — Renderer Suite 工作台宿主（#53/#358/#442 演进）。
 *
 * RendererSuiteHost 本身是命令式挂载面（prepare → mount(container) → update/pause/
 * resume/destroy），与框架无关；React 版里它「恰好」活在 effect 里。#515：Solid 实体
 * 与 React 版逐行同构——外部注册表快照经 createRegistrySignal，store 切片经
 * createZustandSignal，React refs 的「最新值」语义落为 memo/untrack 对照（见各处注释）；
 * 原版 StrictMode 延迟销毁微任务原样保留（防御性，Solid 无双挂载但销毁语义不变）。
 */

export interface WorkbenchFatalFailure {
  readonly suiteId: string
  readonly pluginId?: string
  readonly phase: string
  readonly message: string
  readonly retained?: boolean
}

export interface AgentRendererSuiteWorkbenchProps {
  sheet: SheetRecord
  ctx: SheetContext
  modeId: string
  defaultSuiteId: string
  isReplay: boolean
}

const ownerKey = (session: Session | undefined) => session
  ? toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source })
  : null

const workspaceLabel = (workdir: string | undefined) => workdir
  ?.replace(/[\\/]+$/, '')
  .split(/[\\/]/)
  .filter(Boolean)
  .pop()

const rendererRegistry = getRendererRegistry()

export default function AgentRendererSuiteWorkbench(props: AgentRendererSuiteWorkbenchProps) {
  let containerEl: HTMLDivElement | undefined
  // sessionRuntime 组件生命周期内恒定（原 useRef 惰性初始化）；commands 回调仅在构造
  // 完成后被调用，闭包引用本 const 无 TDZ 问题。#520 S3-P1：IPC 命令装配上移
  // application 层（agentWorkbenchCommands.ts），视图只注入视图域缝并消费装配产物。
  const sessionRuntime = createAgentWorkbenchSessionRuntime({
    commands: createAgentWorkbenchHostCommands({
      resolveSheetAgentId: () => props.sheet.agentId,
      selectSession: id => props.ctx.selectSession(id),
      runtime: () => sessionRuntime,
      openResourceInFileSheet,
    }),
  })
  // store 切片（原 hook 消费 → createZustandSignal；selector 语义与 useThemeStore 一致）。
  const sessions = createZustandSignal(useIdentityStore, state => state.sessions)
  const activeAgentId = createZustandSignal(useIdentityStore, state => state.activeAgent)
  const workspaces = createZustandSignal(useWorkspaceEntityStore, state => state.workspaces)
  const activeSheetId = createZustandSignal(useWorkspaceStore, state => state.workspaceSheets.activeSheetId)
  const activeProfileId = createZustandSignal(usePresentationPreferenceStore, state => state.activeProfileId)
  const rendererSuiteIdByMode = createZustandSignal(usePresentationPreferenceStore, state => state.rendererSuiteIdByMode)
  // ⚠️ solidStoreBridge 约定：selector 只读 store 切片，props 经组件侧 createMemo 并读。
  // 本组件 keep-alive 保活，modeId 随界面模式切换原地变化——selector 内直读 props.modeId
  // 会在切模式后以旧模式偏好解析套件（store 不通知则 selector 不重跑）。
  const isActiveSheet = createMemo(() => activeSheetId() === props.sheet.id)
  const selectedSuiteId = createMemo(() => rendererSuiteIdByMode()[props.modeId])
  const rendererSettings = getRendererSettingsStore()
  const presentationProfiles = getPresentationProfileRegistry()
  const rendererSettingOptions = getPluginSettingOptionsRegistry()
  const catalog = createRegistrySignal(rendererRegistry, () => rendererRegistry.snapshot())
  // Issue #53: the empty-state model dropdown needs the owning agent's
  // advertised model set (its sessionConfig buckets). Subscribe here, outside
  // the renderer subtree, and hand the result down as plain mount-input data.
  // （原 useIdentityStore.getState().activeAgent 非订阅读——这里以信号订阅，探测
  // effect 会在 activeAgent 变化时重跑；探测幂等（fresh/in-flight 守卫），超集无害。）
  const sheetAgentId = createMemo(() => props.sheet.agentId || activeAgentId())
  // runtime store 通知 → 版本重读（原 useSyncExternalStore(useRuntimeStore.subscribe, …)）。
  // #536：快照函数必须返回**跨写入变更的值**——solidStoreKernel 就地改写裸对象，
  // getState() 返回同一引用，createRegistrySignal 按引用判等会把信号钉死在首帧，
  // 下游 agentAdvertisedModels / bindingHintPayload 两个 memo 随之冻结；getVersion()
  // （每次 set 单调 +1）才是合法快照。
  const runtimeStoreVersion = createRegistrySignal(
    { subscribe: listener => useRuntimeStore.subscribe(listener) },
    () => useRuntimeStore.getVersion(),
  )
  const agentAdvertisedModels = createMemo(() => {
    void runtimeStoreVersion()
    return agentAdvertisedModelEntries(sheetAgentId())
  })
  // Issue #53：空态（无历史会话桶）的候选来自后端探测——起一次性会话读 Agent
  // 广告的 configOptions 后即弃。探测落位/失败都推进本地 tick，让 mount input
  // 重算（store 订阅本身不会因探测而 emit）。失败静默：候选退回桶并集，TTL 内
  // 不重试。（原 useEffect [sheetAgentId, probeTick]）
  const [probeTick, setProbeTick] = createSignal(0)
  createEffect(() => {
    const agentId = sheetAgentId()
    void probeTick()
    if (!agentId) return
    if (agentProbeFresh(agentId) || agentProbeInFlight(agentId)) return
    markProbeInFlight(agentId, true)
    appClients.session()
      .probeAgentSelectors({ agentId })
      .then(snapshot => {
        noteAgentSelectorsSnapshot(agentId, snapshot)
      })
      .catch(() => {
        markProbeUnavailable(agentId)
      })
      .finally(() => {
        markProbeInFlight(agentId, false)
        setProbeTick(tick => tick + 1)
      })
  })
  const session = createMemo(() => sessions().find(item => item.id === props.ctx.activeSession))
  const workspace = createMemo(() => {
    const current = session()
    return current?.workspaceId ? workspaces().find(item => item.id === current.workspaceId) : undefined
  })
  // OWNER-03/CC-30：绑定状态机在宿主侧驱动——渲染子树只收纯数据（bindingHint），
  // 不自读 runtime store。必须读 runtimeStoreVersion()：连接态/绑定代的推进不经过
  // 其他被追踪的切片，漏读则该 memo 永远停在首次快照。
  const bindingHintPayload = createMemo(() => {
    void runtimeStoreVersion()
    const sheet = props.sheet
    const currentSession = session()
    const runtimeState = useRuntimeStore.getState()
    const status = sheet.agentId ? runtimeState.agentStatuses[sheet.agentId] : undefined
    const ctxKey = currentSession ? toAgentContextKey(sessionContext(currentSession)) : undefined
    const state = resolveBindingState({
      activeSheet: { kind: sheet.kind, agentId: sheet.agentId },
      activeSessionId: props.ctx.activeSession,
      sessions: sessions(),
      activeAgent: activeAgentId(),
      ownerStatus: status ?? null,
    })
    return bindingHint(refineBindingGeneration(state, {
      establishedGeneration: ctxKey ? runtimeState.bindingGenerations[ctxKey] : undefined,
      currentGeneration: status?.generation,
      backendHealth: ctxKey ? runtimeState.sessionBindingHealth[ctxKey] : undefined,
    }))
  })
  const input = createMemo<WorkbenchMountInput>(() => Object.freeze({
    sheetId: props.sheet.id, sessionOwnerKey: ownerKey(session()), sessionId: props.ctx.activeSession,
    // #395：文档按 provider source 建键——渲染器的「这份文档是不是本会话的」判据要用它。
    sessionSource: session()?.source ?? null,
    replayReadonly: props.isReplay,
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    visibility: isActiveSheet() ? 'active' : 'background', rightInset: props.ctx.rightInset, preview: false,
    presentationProfileId: activeProfileId(),
    sessionLabel: session()?.name,
    workspaceLabel: workspace()?.name ?? workspaceLabel(session()?.workdir),
    workspacePath: workspace()?.rootPath ?? session()?.workdir,
    availableWorkspaces: workspaces().map(item => ({ id: item.id, label: item.name, path: item.rootPath, lastActiveAt: item.lastActiveAt })),
    agentAdvertisedModels: agentAdvertisedModels(),
    bindingHint: bindingHintPayload(),
  }))
  const activation = createMemo<RendererActivationSnapshot | undefined>(() => {
    try {
      return resolveRendererActivation(catalog(), {
        userSelectedSuiteId: selectedSuiteId(), modeDefaultSuiteId: props.defaultSuiteId,
        builtInSolidSuiteId: 'builtin.solid', documentSchema: 'workbench.v1', renderCatalogSchema: 1,
      })
    } catch { return undefined }
  })
  const activationKey = createMemo(() => {
    const current = activation()
    return current ? `${current.suite.ownerRuntimeInstanceId}\u0000${current.suite.value.id}\u0000${current.revision}` : undefined
  })
  const [activeSuiteId, setActiveSuiteId] = createSignal<string | undefined>(activation()?.suite.value.id)
  const [failure, setFailure] = createSignal<WorkbenchFatalFailure | null>(null)
  const [fatal, setFatal] = createSignal(false)
  // ---- 可变宿主状态（原 useRef 群；组件体只跑一次，普通变量即最新值语义）。 ----
  let host: RendererSuiteHost | null = null
  let hostPort: WorkbenchHostPort | null = null
  const hostPorts = new Map<string, WorkbenchHostPort>()
  let hostListener: (() => void) | null = null
  let activePortRelease: (() => void) | null = null
  let targetActivation: RendererActivationSnapshot | undefined = activation()
  let activeActivation: RendererActivationSnapshot | undefined = undefined
  let activeActivationKey: string | undefined = undefined
  let fallbackAttempted: string | undefined = undefined
  const fallbackChain = new Set<string>()
  let automaticRetry: { key?: string; attempts: number } = { attempts: 0 }
  let automaticRetryTimer: ReturnType<typeof setTimeout> | null = null
  let reportedRuntimeError: string | null = null
  let reportedRuntimeErrorKey: string | null = null
  let reportedSuiteErrorKey: string | null = null
  let visibilityRef = input().visibility

  createEffect(() => { void sessionRuntime.bind(session()) })
  // Recoverable bind/refresh failures are application notifications, not a
  // second banner in the chat surface. Publish one scoped entry and let the
  // central tray own its visibility and dismissal.
  // （原 useEffect [props.sheet.id, session?.id, session?.agentId, sessionRuntime, session]）
  createEffect(() => {
    const currentSession = session()
    const sheetId = props.sheet.id
    const scope = currentSession
      ? { kind: 'session' as const, id: currentSession.id }
      : { kind: 'sheet' as const, id: sheetId }
    const runtimeErrorKey = currentSession
      ? `workbench-runtime:session:${currentSession.id}`
      : `workbench-runtime:sheet:${sheetId}`
    let disposed = false
    const previousRuntimeErrorKey = reportedRuntimeErrorKey
    if (previousRuntimeErrorKey && previousRuntimeErrorKey !== runtimeErrorKey) {
      resolveRuntimeErrors({ key: previousRuntimeErrorKey, source: 'workbench.runtime' })
      reportedRuntimeErrorKey = null
      reportedRuntimeError = null
    }
    const observe = () => {
      if (disposed) return
      const current = sessionRuntime.runtime.getSnapshot()
      const failed = (current.status === 'error' || current.status === 'degraded') && Boolean(current.error)
      if (!failed) {
        reportedRuntimeError = null
        reportedRuntimeErrorKey = null
        resolveRuntimeErrors({ key: runtimeErrorKey, source: 'workbench.runtime' })
        return
      }
      const message = current.error!
      const signature = `${scope.kind}:${scope.id}:${message}`
      if (reportedRuntimeError === signature) return
      reportedRuntimeError = signature
      reportedRuntimeErrorKey = runtimeErrorKey
      reportRuntimeError('工作台运行时', new Error(message), currentSession?.agentId, {
        key: runtimeErrorKey,
        scope,
        source: 'workbench.runtime',
        recoveryAction: {
          label: '重试会话恢复',
          run: () => currentSession ? sessionRuntime.bind(currentSession) : undefined,
        },
      })
    }
    observe()
    const unsubscribe = sessionRuntime.runtime.subscribe(observe)
    onCleanup(() => {
      disposed = true
      unsubscribe()
    })
  })
  // React.StrictMode intentionally runs effect cleanup/setup once during the
  // initial dev mount. Destroying the mutable Workbench runtime in that probe
  // leaves the second (real) setup with a permanently inert runtime, which
  // presents as an empty chat even though the snapshot bridge loaded data.
  // Defer destruction by one microtask and cancel it when setup runs again;
  // genuine unmounts still destroy the runtime deterministically.
  // （Solid 无 StrictMode 双挂载，但延迟销毁语义原样保留。）
  let runtimeLifecycleToken = 0
  onMount(() => {
    const token = ++runtimeLifecycleToken
    onCleanup(() => {
      queueMicrotask(() => {
        if (runtimeLifecycleToken === token) sessionRuntime.destroy()
      })
    })
  })

  // 宿主创建/切换 effect（原 useEffect [activation, activationKey, presentationProfiles,
  // props.sheet.id, rendererSettingOptions, rendererSettings, sessionRuntime]——后四者在
  // 组件生命周期内恒定，追踪面即 activation/activationKey/sheet.id）。原效果无 cleanup；
  // inputRef.current 的旁路读改为 untrack(input)（不进依赖）。
  createEffect(() => {
    const currentActivation = activation()
    const currentActivationKey = activationKey()
    const sheetId = props.sheet.id
    const currentInput = () => untrack(input)
    const container = containerEl
    if (!container || !currentActivation) { setFailure({ suiteId: 'unknown', phase: 'resolve', message: 'Renderer Suite catalog 为空' }); return }
    if (host) {
      if (activeActivationKey !== currentActivationKey) {
        if (automaticRetryTimer) clearTimeout(automaticRetryTimer)
        automaticRetryTimer = null; automaticRetry = { attempts: 0 }
        activeActivationKey = currentActivationKey; targetActivation = currentActivation; fallbackAttempted = undefined; fallbackChain.clear()
        void host.switchTo(currentActivation)
      }
      return
    }
    const switchToFallback = (target: RendererActivationSnapshot | undefined, failedSuiteId: string) => {
      if (failedSuiteId === 'builtin.solid') return
      if (fallbackChain.has(failedSuiteId)) return
      const key = `${target?.suite.ownerRuntimeInstanceId ?? ''}\u0000${failedSuiteId}\u0000${target?.revision ?? 0}`
      fallbackAttempted = key
      fallbackChain.add(failedSuiteId)
      try {
        const builtIn = resolveRendererActivation(catalog(), { explicitSuiteId: 'builtin.solid', documentSchema: 'workbench.v1', renderCatalogSchema: 1 })
        const explicitId = target?.suite.value.fallbackSuiteId
        const explicitFallback = explicitId && !fallbackChain.has(explicitId)
          ? resolveRendererActivation(catalog(), { explicitSuiteId: explicitId, documentSchema: 'workbench.v1', renderCatalogSchema: 1 })
          : undefined
        const fallback = resolveRendererSuiteFallback({ current: target, explicitFallback, builtInSolid: builtIn })
        if (!fallback || fallbackChain.has(fallback.suite.value.id)) { setFatal(true); return }
        targetActivation = fallback
        void host?.switchTo(fallback)
      } catch { setFatal(true) }
    }
    const retryOrFallback = (target: RendererActivationSnapshot | undefined, next: WorkbenchFatalFailure) => {
      if (!target) { setFailure(next); setFatal(true); return }
      const key = `${target.suite.ownerRuntimeInstanceId}\u0000${target.suite.value.id}\u0000${target.revision}`
      if (automaticRetry.key !== key) automaticRetry = { key, attempts: 0 }
      if (automaticRetry.attempts < 2) {
        automaticRetry.attempts += 1
        const attempt = automaticRetry.attempts
        setFailure({ ...next, message: `${next.message}（自动重试 ${attempt}/2）` })
        automaticRetryTimer = setTimeout(() => {
          automaticRetryTimer = null
          if (targetActivation === target) void host?.switchTo(target)
        }, 150 * (2 ** (attempt - 1)))
        return
      }
      setFailure(next)
      if (next.suiteId === 'builtin.solid') { setFatal(true); return }
      switchToFallback(target, next.suiteId)
    }
    const hostPortForSuite = (suiteId: string) => {
      const existing = hostPorts.get(suiteId)
      if (existing) return existing
      const created = createWorkbenchHostPort({
        runtime: sessionRuntime.runtime, appearance: sessionRuntime.appearance, sessionUi: sessionRuntime.sessionUi,
        commands: sessionRuntime.commands, suiteId, sheetId,
        sessionOwnerKey: currentInput().sessionOwnerKey, sessionId: currentInput().sessionId,
        capabilities: {
          prompt: true, cancel: true, attach: false, model: true, mode: true,
          sessionCreate: suiteId === 'builtin.solid', compact: false, sessionExport: false, sessionClear: false,
          sessionConfig: true,
          toolAction: false, interactionResponse: true, resourceOpen: true, resourceReveal: true,
          clipboardWrite: true, retry: false, recovery: false,
          appearanceEdit: suiteId === 'builtin.solid',
        },
        // Suite identity is fixed for the lifetime of this port. Session binding
        // may advance, but a preparing candidate cannot retarget the old instance.
        binding: () => ({ suiteId, sheetId, sessionOwnerKey: currentInput().sessionOwnerKey, sessionId: currentInput().sessionId }),
        renderAppearance: {
          resolve: (request, hostAppearance) => {
            const profileId = usePresentationPreferenceStore.getState().activeProfileId
            const profile = presentationProfiles.resolve(profileId)?.value
            return resolveProductionRenderAppearance({
              hostAppearance,
              catalog: catalog(),
              settings: rendererSettings.getSnapshot(),
              profileKindTokens: profile?.kindTokens?.[request.kind],
              optionEntries: rendererSettingOptions.getSnapshot().entries,
              ...request,
            })
          },
          subscribe(listener) {
            const unsubscribers = [
              rendererSettings.subscribe(listener),
              presentationProfiles.subscribe(listener),
              rendererSettingOptions.subscribe(listener),
              usePresentationPreferenceStore.subscribe(listener),
            ]
            return () => unsubscribers.forEach(unsubscribe => unsubscribe())
          },
        },
        diagnostics: diagnostic => {
          if (diagnostic.recoverability !== 'retry' && diagnostic.recoverability !== 'fallback') return
          if (diagnostic.recoverability === 'retry') return
          const target = targetActivation
          const failedSuiteId = diagnostic.suiteId ?? suiteId
          const active = activeActivation
          const failedTarget = target?.suite.value.id === failedSuiteId
            ? target
            : active?.suite.value.id === failedSuiteId ? active : target
          retryOrFallback(failedTarget, {
            suiteId: failedSuiteId,
            pluginId: failedTarget?.suite.ownerPluginId,
            phase: diagnostic.phase ?? 'resolve',
            message: diagnostic.message,
          })
        },
      })
      hostPorts.set(suiteId, created)
      return created
    }
    const initialPort = hostPortForSuite(currentActivation.suite.value.id)
    hostPort = initialPort
    const createdHost = new RendererSuiteHost({
      container,
      hostPort: initialPort,
      hostPortForActivation: candidate => hostPortForSuite(candidate.suite.value.id),
      input: currentInput(),
    })
    host = createdHost; activeActivationKey = currentActivationKey; targetActivation = currentActivation
    hostListener = createdHost.subscribe(state => {
      if (state.phase === 'active' && state.error) {
        const failedTarget = targetActivation
        const retained = activeActivation
        const failedKey = failedTarget
          ? `${failedTarget.suite.ownerRuntimeInstanceId}\u0000${failedTarget.suite.value.id}\u0000${failedTarget.revision}`
          : undefined
        const recoveringFatal = Boolean(failedKey
          && automaticRetry.key === failedKey
          && automaticRetry.attempts > 0)
        if (recoveringFatal) {
          retryOrFallback(failedTarget, {
            suiteId: failedTarget?.suite.value.id ?? state.previousSuiteId ?? 'unknown',
            pluginId: failedTarget?.suite.ownerPluginId,
            phase: 'switch',
            message: state.error instanceof Error ? state.error.message : String(state.error),
          })
          return
        }
        if (retained) targetActivation = retained
        const retainedSuiteId = state.suiteId ?? retained?.suite.value.id
        const retainedPort = retainedSuiteId ? hostPorts.get(retainedSuiteId) : undefined
        if (retainedPort && hostPort !== retainedPort) {
          activePortRelease?.()
          activePortRelease = publishActiveWorkbenchHostPort(sheetId, retainedPort)
          hostPort = retainedPort
        }
        setActiveSuiteId(state.suiteId)
        setFailure({
          suiteId: failedTarget?.suite.value.id ?? state.previousSuiteId ?? 'unknown',
          pluginId: failedTarget?.suite.ownerPluginId,
          phase: 'switch',
          message: state.error instanceof Error ? state.error.message : String(state.error),
          retained: true,
        })
        return
      }
      if (state.phase === 'active') {
        activeActivation = targetActivation
        const activePort = state.suiteId ? hostPorts.get(state.suiteId) : undefined
        if (activePort && hostPort !== activePort) {
          activePortRelease?.()
          activePortRelease = publishActiveWorkbenchHostPort(sheetId, activePort)
          hostPort = activePort
        } else if (activePort && !activePortRelease) {
          activePortRelease = publishActiveWorkbenchHostPort(sheetId, activePort)
        }
        setActiveSuiteId(state.suiteId)
        setFatal(false)
        if (untrack(input).visibility === 'background') createdHost.pause()
        if (!fallbackAttempted) setFailure(null)
        return
      }
      if (state.phase !== 'degraded' && !state.error) return
      const target = targetActivation
      const suiteId = target?.suite.value.id ?? state.previousSuiteId ?? state.suiteId ?? 'unknown'
      const next = { suiteId, pluginId: target?.suite.ownerPluginId, phase: state.phase === 'degraded' ? 'mount' : 'switch', message: state.error instanceof Error ? state.error.message : String(state.error ?? 'Renderer Suite 启动失败') }
      retryOrFallback(target, next)
    })
    void createdHost.mount(currentActivation)
  })

  onMount(() => {
    onCleanup(() => {
      const currentHost = host
      if (automaticRetryTimer) clearTimeout(automaticRetryTimer)
      automaticRetryTimer = null
      host = null; hostPort = null; activeActivationKey = undefined
      activePortRelease?.(); activePortRelease = null
      hostListener?.(); hostListener = null
      if (currentHost) void currentHost.destroy()
      for (const port of hostPorts.values()) port.diagnostics.destroy?.()
      hostPorts.clear()
    })
  })
  // 挂载输入推送 + 可见性暂停/恢复（原 useEffect [input]）。
  createEffect(() => {
    const currentInput = input()
    const currentHost = host
    currentHost?.update(currentInput)
    if (visibilityRef === currentInput.visibility) return
    visibilityRef = currentInput.visibility
    if (currentInput.visibility === 'background') currentHost?.pause()
    else currentHost?.resume()
  })

  // A retained/fallback Suite is recoverable application state. Keep its
  // diagnostic in the central tray instead of rendering a second banner in
  // the chat surface; fatal fallback remains the explicit blocking UI below.
  // （原 useEffect [failure, fatal, props.sheet.id, session, …]；retrySolid 以组件级
  // 函数直接闭包捕获——Solid 组件体只跑一次，无 React 回调身份漂移问题。）
  function retrySolid() {
    const currentHost = host
    if (!currentHost) return
    try {
      const builtIn = resolveRendererActivation(catalog(), { explicitSuiteId: 'builtin.solid', documentSchema: 'workbench.v1', renderCatalogSchema: 1 })
      if (automaticRetryTimer) clearTimeout(automaticRetryTimer)
      automaticRetryTimer = null; automaticRetry = { attempts: 0 }
      targetActivation = builtIn; fallbackAttempted = undefined; fallbackChain.clear(); setFatal(false); setFailure(null)
      void currentHost.switchTo(builtIn)
    } catch (error) {
      setFailure({ suiteId: 'builtin.solid', phase: 'resolve', message: error instanceof Error ? error.message : String(error) }); setFatal(true)
    }
  }

  createEffect(() => {
    const currentSession = session()
    const sheetId = props.sheet.id
    const currentFailure = failure()
    const currentFatal = fatal()
    const scope = currentSession
      ? { kind: 'session' as const, id: currentSession.id }
      : { kind: 'sheet' as const, id: sheetId }
    const previousKey = reportedSuiteErrorKey
    if (currentFatal || !currentFailure) {
      if (previousKey) resolveRuntimeErrors({ key: previousKey })
      reportedSuiteErrorKey = null
      return
    }
    const key = `renderer-suite:${sheetId}:${currentSession?.id ?? 'none'}:${currentFailure.suiteId}:${currentFailure.phase}`
    if (previousKey && previousKey !== key) resolveRuntimeErrors({ key: previousKey })
    if (previousKey === key) return
    reportedSuiteErrorKey = key
    const message = `${currentFailure.suiteId} / ${currentFailure.phase} / ${currentFailure.message}`
    reportRuntimeError('Renderer Suite 回退', new Error(message), currentSession?.agentId, {
      key,
      scope,
      source: 'renderer-suite',
      recoveryAction: { label: '重试 Solid', run: () => retrySolid() },
    })
  })
  const openDiagnostics = () => window.dispatchEvent(new CustomEvent('pylon:open-runtime-sheet'))

  return (
    <div class="main renderer-suite-workbench" data-renderer-suite-host="true" data-suite-id={activeSuiteId() ?? activation()?.suite.value.id}
      on:click={{ handleEvent: event => { openFileLinkFromEvent(event, props.ctx.activeSession) }, capture: true }}>
      <div ref={element => { containerEl = element }} class="renderer-suite-workbench-mount" hidden={fatal()} />
      <Show when={fatal() ? failure() : null}>
        {currentFailure => (
          <section class="renderer-suite-fatal-banner" role="alert"
            aria-label="Renderer suite fatal banner" data-suite-id={currentFailure().suiteId} data-failure-phase={currentFailure().phase}>
            <strong>渲染引擎失败</strong>
            <span>{currentFailure().suiteId} · {currentFailure().phase}</span>
            <Show when={currentFailure().pluginId}><span>{currentFailure().pluginId}</span></Show>
            <span>{currentFailure().message}</span>
            <div class="renderer-suite-fatal-actions">
              <button type="button" onClick={retrySolid}>重试 Solid</button>
              <button type="button" onClick={openDiagnostics}>打开诊断</button>
            </div>
          </section>
        )}
      </Show>
      <Show when={isActiveSheet()}>
        <ActiveAgentSessionLifecycle session={session()} sessions={sessions()}
          selectSession={props.ctx.selectSession} sessionRuntime={sessionRuntime} />
      </Show>
    </div>
  )
}

function ActiveAgentSessionLifecycle(props: {
  session: Session | undefined
  sessions: readonly Session[]
  selectSession(id: string | null): void
  sessionRuntime: ReturnType<typeof createAgentWorkbenchSessionRuntime>
}) {
  let lifecycle: AgentWorkbenchLifecycle | null = null
  if (!lifecycle) {
    lifecycle = new AgentWorkbenchLifecycle()
    // Canonical replay can discover a terminal tool event after the initial
    // bind; refresh the same owner document when the load chain completes.
    // #99：账本快照一并交下去——终帧只经一次性 IPC Channel 交付，账本是不依赖
    // 一次性 event 的终态证据，refresh 用它补出 journal 读漏掉的收敛事实。
    // #442 Step1：权威 turnBoundary 随 options 进 refresh——「或」判定与
    // duration 扫描在字段可用时退役（缺失回退既有轨，见 publishFoldedDocument）。
    lifecycle.onCanonicalRefresh = (session, _canonicalRevision, turn, turnBoundary) => {
      void props.sessionRuntime.refresh(session, turn, { turnBoundary })
    }
    // #358：复活的协商目录投影成工作台文档的 `session.started`——与建会话路径同构。
    // 没有这条事实，`WorkbenchDocumentSurface` 的守卫在复活会话上必然失配，model / mode
    // 目录会以「配置 / 保存 / select」卡片常驻会话下方（且每次重启由 journal 回放重建）。
    lifecycle.onSessionLoadResponse = (session, response) => {
      props.sessionRuntime.applySessionResponse(response, session.id, { syntheticReason: 'session-load-response' })
    }
  }
  // CWD-03：reload 令牌变化 = 同会话 workdir/workspace 变更 → 重跑激活链。
  // 原版 useRuntimeStore(selector 内读 reloadKey) 的「render 时重读」语义在此拆为
  // 键 memo + 切片信号 memo（切片引用等值，与 selector 判等一致）。
  const reloadTokens = createZustandSignal(useRuntimeStore, state => state.sessionReloadTokens)
  const reloadToken = createMemo(() => {
    const current = props.session
    const key = current ? `${current.agentId}\u0000${current.source}` : undefined
    return key ? reloadTokens()[key] : undefined
  })
  createEffect(() => {
    const currentSession = props.session
    const token = reloadToken()
    if (!currentSession) return
    const reloadRef = { current: token }
    void lifecycle.activate(currentSession, {
      reloadToken: token,
      isCurrent: () => untrack(() => props.session)?.id === currentSession.id && reloadRef.current === token,
    })
  })
  // prune：移除已删除会话的 load generation 记录（原 useEffect [lifecycle, props.sessions]）。
  createEffect(() => {
    lifecycle.prune(props.sessions.map(entry => entry.source))
  })
  // Recovery failures are reported with a session scope; the application
  // ErrorCenter is the single ordinary-error presentation.
  return null
}
