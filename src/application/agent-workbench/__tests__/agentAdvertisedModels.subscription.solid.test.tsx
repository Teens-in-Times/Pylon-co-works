/** @jsxImportSource solid-js */
// @vitest-environment jsdom
/**
 * #515：React useSyncExternalStore 探针 → solid 信号探针（createResource 形态的订阅语义
 * 等价：多次订阅 + 配置更新不互相踩踏、无渲染环）。断言集逐字保留。
 */
import { render } from '@solidjs/testing-library'
import { createMemo } from 'solid-js'
import { afterEach, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore.ts'
import { agentAdvertisedModelEntries } from '../agentAdvertisedModels.ts'
import { createZustandSignal } from '../../../infrastructure/state/solidStoreBridge.ts'
import { createRegistrySignal } from '../../../infrastructure/state/solidSheetSupport.solid.tsx'

afterEach(() => { useRuntimeStore.setState({ sessionConfig: {} }) })

it('supports simultaneous Agent Sheet subscriptions and config updates without a render loop', () => {
  useRuntimeStore.setState({ sessionConfig: {} })
  function AgentModels(props: { agentId: string }) {
    // 订阅语义与 React 版 useSyncExternalStore 对齐：memo 必须对 store 有响应式依赖，
    // 否则纯函数计算永不失效（React 版靠 hook 订阅，solid 版显式读 sessionConfig 切片）。
    const sessionConfig = createZustandSignal(useRuntimeStore, s => s.sessionConfig)
    const entries = createMemo(() => {
      void sessionConfig()
      return agentAdvertisedModelEntries(props.agentId)
    })
    return <output aria-label={props.agentId}>{entries().map(entry => entry.id).join(',')}</output>
  }
  const view = render(() => <><AgentModels agentId="agent-a" /><AgentModels agentId="agent-b" /></>)
  useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-a', source: 'a' }, { models: ['model-a'] })
  useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-b', source: 'b' }, { models: ['model-b'] })
  expect(view.getByLabelText('agent-a')).toHaveTextContent('model-a')
  expect(view.getByLabelText('agent-b')).toHaveTextContent('model-b')
  useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-a', source: 'a' }, { models: ['new-a'] })
  expect(view.getByLabelText('agent-a')).toHaveTextContent('new-a')
  expect(view.getByLabelText('agent-b')).toHaveTextContent('model-b')
})

// #536 回归：AgentRendererSuiteWorkbench 的实际订阅形态——createRegistrySignal 包
// useRuntimeStore，memo 以其值为失效源读 agentAdvertisedModelEntries。快照函数必须是
// getVersion()：内核 getState() 返回同一裸对象，按引用判等会让 memo 冻结在首帧，
// sessionConfig 桶更新后模型候选不传播（缺陷即此处）。
it('#536: sessionConfig 桶更新后 agentAdvertisedModels memo 重算', () => {
  useRuntimeStore.setState({ sessionConfig: {} })
  let memoReads = 0
  function AgentModels(props: { agentId: string }) {
    // 与 AgentRendererSuiteWorkbench 逐字同构的订阅形态（#536 修后）。
    const runtimeStoreVersion = createRegistrySignal(
      { subscribe: listener => useRuntimeStore.subscribe(listener) },
      () => useRuntimeStore.getVersion(),
    )
    const agentAdvertisedModels = createMemo(() => {
      void runtimeStoreVersion()
      memoReads += 1
      return agentAdvertisedModelEntries(props.agentId)
    })
    return <output aria-label={props.agentId}>{agentAdvertisedModels().map(entry => entry.id).join(',')}</output>
  }
  const view = render(() => <AgentModels agentId="agent-536" />)
  expect(view.getByLabelText('agent-536')).toHaveTextContent('')
  expect(memoReads).toBe(1)
  useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-536', source: 'a' }, { models: ['bucket-model'] })
  expect(view.getByLabelText('agent-536')).toHaveTextContent('bucket-model')
  expect(memoReads).toBeGreaterThan(1)
})
