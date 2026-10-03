/**
 * appBootstrapTransaction — FE-AUD-005 单一 bootstrap 事务（阶段 2）的 Solid 装配。
 * （#520 S3-P1-3：自 App.solid 组合根拆出——事务本体 startApplicationBootstrap 在
 * application 侧保持纯逻辑，本模块只做依赖注入与 owner 生命周期绑定。）
 *
 * 事务链：hydrate domains → agents → 工具字典 → 冷启动状态快照 → listener 注册。
 * 重试信号（恢复按钮 +1）在组件 owner 内重跑整个事务；dispose 随 owner 卸载。
 */
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { appClients } from '../appClients.ts'
import { IS_TAURI, isBrowserMockRuntime } from '../../infrastructure/tauri/env'
import { reportRuntimeError, resolveRuntimeErrors } from '../runtimeError'
import { normalizeAgentStatus, type AgentStatusPayload } from '../../contracts/agentTypes'
import { getPermissionController } from '../../infrastructure/acp/permissionController'
import { applyAgentInstancesThroughPort, applyToolDictionaryThroughPort } from '../ports/productContributionPorts.ts'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { useHydrationStore } from './hydrationState'
import { hydrateIdentityAndWorkspace, consumeLegacyProfilePayload } from './hydrateIdentityAndWorkspace'
import { startApplicationBootstrap } from './applicationBootstrapRun'
import { startupMark, reportStartupTiming } from '../startupTiming'
import { hydrateInputPredictionSettingsFromBackend } from '../../infrastructure/persistence/inputPredictionSettingsRepository.ts'
import { hydrateCustomPresetsFromBackend } from '../../infrastructure/persistence/customPresetRepository.ts'

// Bootstrap notification identity is application-scoped and intentionally
// stable across retries/remounts. Keeping it outside the effect avoids
// allocating a new matcher while a run is in flight.
const bootstrapScope = { kind: 'app' as const, id: 'bootstrap' }
const bootstrapKey = (action: string) => `bootstrap:${action}`

// FE-AUD-008：组装期统一 client 集（app/appClients），视图层不再自造 client。
const agentClient = appClients.agent()

export function runAppBootstrapTransaction(): void {
  const [bootstrapRetry, setBootstrapRetry] = createSignal(0)
  createEffect(() => {
    // 追踪重试信号（React 期 deps [bootstrapRetry] 同口径）：恢复按钮 +1 重跑整个事务。
    bootstrapRetry()
    // #269：App chunk 已加载并进入 bootstrap 事务（打点在前一帧的 shell_mounted
    // 与本点之间即 chunk 拉取耗时）。
    startupMark('app_bootstrap_start')
    const bootstrapRun = startApplicationBootstrap({
      isTauri: IS_TAURI && !isBrowserMockRuntime(),
      // I14-W6：bootstrap 等待 identity hydration（Tauri 后端读回 / browser 本地）
      // 完成后，再恢复 workspace 与 Agent（ISSUE-14 目标行为 #5）。
      hydrateDomains: async () => {
        // #448 PR2/PR5：预测设置与自定义预设的同步缓存/独立 store 以后端为权威
        // hydrate（内部吞错不降级启动；失败时回落 localStorage，等价旧行为）。
        // 与 identity 无依赖关系——并行执行，避免 identity 失败（degraded 路径直接
        // return）连带跳过两者，把 degraded 会话的无缓存窗口拉长（审查 C-3）。
        await Promise.all([
          hydrateIdentityAndWorkspace(consumeLegacyProfilePayload()),
          hydrateInputPredictionSettingsFromBackend(),
          hydrateCustomPresetsFromBackend(),
        ])
        startupMark('hydrated')
      },
      fetchAgents: () => agentClient.listAgents(),
      applyAgents: list => {
        applyAgentInstancesThroughPort(getPluginServiceRegistry(), list)
        useIdentityStore.getState().setAgents(list)
      },
      fetchToolDictionary: () => agentClient.listToolDictionary(),
      applyToolDictionary: payload => applyToolDictionaryThroughPort(getPluginServiceRegistry(), payload),
      // 冷启动 Agent 状态快照（方案 A）：listener 注册前先查询一次初始状态，
      // 避免 titlebar 状态灯/发送能力 gate 因初始状态缺失而全灰/禁用。
      fetchAgentStatus: () => agentClient.agentStatus(),
      applyAgentStatus: payload => {
        const agent = useIdentityStore.getState().activeAgent
        const status = normalizeAgentStatus(payload as AgentStatusPayload, agent)
        useRuntimeStore.getState().setAgentStatus(status.agentId || status.agent || agent, status)
        // #98：冷挂载——agent_status 快照恢复 pending permission 卡（幂等去重）。
        getPermissionController()?.seedFromSnapshot(payload)
      },
      registerListeners: async () => {
        const unlisten = await listen<AgentStatusPayload>('pylon:agent-status', event => {
          const agent = useIdentityStore.getState().activeAgent
          const status = normalizeAgentStatus(event.payload, agent)
          useRuntimeStore.getState().setAgentStatus(status.agentId || status.agent || agent, status)
          getPermissionController()?.seedFromSnapshot(event.payload)
        })
        // P51：后端 session/load 复活失败而新建会话时广播（Pylon 重启后首次发送）。
        // 回写新 periId，使下一次发送/重启能继续复活这条新会话而不是再新建。
        const unlistenRecreated = await listen<{ source: string; periId: string }>('pylon:session-recreated', event => {
          const { source, periId } = event.payload
          const session = useIdentityStore.getState().sessions.find(item => item.source === source)
          if (session && session.periId !== periId) {
            useIdentityStore.getState().setSessionPeriId(session.id, periId)
          }
        })
        return () => { unlisten(); unlistenRecreated() }
      },
      reportError: (action, error) => reportRuntimeError(action, error, undefined, {
        key: bootstrapKey(action),
        scope: bootstrapScope,
        source: 'application.bootstrap',
        recoveryAction: {
          label: '重试启动',
          run: () => { setBootstrapRetry(value => value + 1) },
        },
      }),
      resolveError: action => resolveRuntimeErrors({ key: bootstrapKey(action), scope: bootstrapScope }),
      // #269：ready 即启动事务终点——打点并一次性上报前后端启动时间线。
      setStatus: (status, error) => {
        if (status === 'ready') {
          startupMark('ready')
          reportStartupTiming()
        }
        useHydrationStore.getState().setStatus(status, error)
      },
    })
    onCleanup(() => { bootstrapRun.dispose() })
  })
}
