/**
 * OWNER-05：P3 路由回归矩阵（方案书 §1.4 P3 / LRP M2 卡点：双 Agent/断线/重连）。
 *
 * 冷启动目标路径（§5.9）：Sheet 恢复 → resolve owner → agent status → load/create binding →
 * Binding Ready → enable InputBar。本矩阵在真实 stores + 真实 send_message payload 构造层
 * 上走通整条链路的域内不变量（不用 UI 渲染，避免"仅凭 UI 颜色判定已连接"）：
 *
 *   R1 冷启动绑定就绪：send_message payload 显式携带 Session.agentId（owner 路由）
 *   R2 双 Agent 同名 source：发送路由按 Session owner，绝不取 activeAgent；binding
 *      generation 按 AgentContextKey 隔离不串线
 *
 * #520 死代码二批：binding 派生断言（原 R3 断线锁定 / R4 重连 stale / R5 重建解锁 /
 * R6 restoring）随 domains/binding/bindingState.ts 退役一并删除——该派生层已无生产
 * 消费；generation 记录与按 key 隔离的不变量由 R2 在 runtimeStore 层继续守护。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import '../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { toAgentContextKey } from '../domains/agent/agentContext'
import { createSheetState } from '../domains/workspace/sheetState'
import { buildSendMessagePayload } from '../domains/chat/sessionRuntime'
import { resetStores } from '../test/resetStores'
import type { AgentStatus } from '../contracts/agentTypes'
import type { Session } from '../domains/identity/identityStore'

function session(id: string, agentId: string, source: string, periId?: string): Session {
  return {
    id, agentId, name: `s-${id}`, source, profileId: 'profile-a',
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '', ...(periId ? { periId } : {}),
  }
}

function status(agentId: string, s: AgentStatus['status'], generation: number): AgentStatus {
  return { agent: agentId, agentId, status: s, generation, lastConnectedAt: Date.now() }
}

function seedAgentSheet(agentId: string): void {
  const sheetId = `sheet-${agentId}`
  useWorkspaceStore.setState({
    workspaceSheets: createSheetState([
      { id: sheetId, kind: 'agent', agentId, title: agentId, createdAt: 1, lastFocusedAt: 1 },
    ], sheetId, []),
  })
}

describe('OWNER-05 P3 路由回归矩阵', () => {
  beforeEach(() => {
    resetStores()
  })

  it('R1 冷启动：Sheet 恢复 + owner 状态/generation 记录后，send_message payload 显式携带 Session.agentId', () => {
    const s = session('s1', 'hermes', 'local:h1', 'peri-1')
    seedAgentSheet('hermes')
    useIdentityStore.setState({ sessions: [s], activeAgent: 'hermes' })
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 5))
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'hermes', source: s.source }, 5)

    // §1.4 P3：点击发送 → 检查 send_message payload → owner 路由（绝不取 activeAgent）
    expect(buildSendMessagePayload({ session: s, content: 'hi', persona: 'p', attachments: [] }))
      .toMatchObject({ agentId: 'hermes', source: 'local:h1' })
  })

  it('R2 双 Agent 同名 source：发送路由按 Session owner（≠ activeAgent），binding generation 按 AgentContextKey 隔离', () => {
    const active = session('s-a', 'peri', 'local:同名', 'peri-a')
    const other = session('s-b', 'hermes', 'local:同名', 'peri-b')
    seedAgentSheet('peri') // 激活 sheet 归 peri，activeAgent=peri
    useIdentityStore.setState({ sessions: [active, other], activeAgent: 'peri' })
    useRuntimeStore.getState().setAgentStatus('peri', status('peri', 'connected', 3))
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 7))
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source: 'local:同名' }, 3)
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'hermes', source: 'local:同名' }, 7)

    // 同名 source，两个 Agent 各自路由：payload.agentId = Session owner，绝不串线
    expect(buildSendMessagePayload({ session: other, content: 'hi', persona: 'p', attachments: [] }))
      .toMatchObject({ agentId: 'hermes', source: 'local:同名' })
    expect(buildSendMessagePayload({ session: active, content: 'hi', persona: 'p', attachments: [] }))
      .toMatchObject({ agentId: 'peri', source: 'local:同名' })
    // binding generation 快照按 AgentContextKey 隔离，不互相覆盖
    const rt = useRuntimeStore.getState()
    expect(rt.bindingGenerations[toAgentContextKey({ agentId: 'peri', source: 'local:同名' })]).toBe(3)
    expect(rt.bindingGenerations[toAgentContextKey({ agentId: 'hermes', source: 'local:同名' })]).toBe(7)
    // 清理只动自己的 key：删 hermes 会话的 runtime 不影响 peri 的记录
    useRuntimeStore.getState().clearSessionSource({ agentId: 'hermes', source: 'local:同名' })
    const after = useRuntimeStore.getState()
    expect(after.bindingGenerations[toAgentContextKey({ agentId: 'peri', source: 'local:同名' })]).toBe(3)
    expect(after.bindingGenerations[toAgentContextKey({ agentId: 'hermes', source: 'local:同名' })]).toBeUndefined()
  })
})
