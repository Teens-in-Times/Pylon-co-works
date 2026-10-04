// @vitest-environment jsdom
import { cleanup } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench, type WorkbenchDocument } from '../../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'

/**
 * P57 S2-R1d（第一步：渲染器侧门控）验收 2：
 * - 连续 100 个 display 无关（usage 数值不变）的更新不触发 Solid 显示链发表；
 * - usage 数值变化必须放行（footer tokenCount 消费点 :544 防过度静默）；
 * - document.messages 数组引用在 usage 类事件间保持不变（R1b/R1c 链，#487 起
 *   document 是唯一消息所有者）。
 *
 * 「setRuntimeSnapshot spy」的实现方式：mock 调度器工厂，包裹其 publish 回调——
 * publish 正是 mount 内调用 setRuntimeSnapshot 的唯一路径（preview 走 flush 直发）。
 */
const harness = vi.hoisted(() => ({
  publications: [] as WorkbenchRuntimeSnapshot[],
  publishSpies: [] as Array<ReturnType<typeof vi.fn>>,
}))

vi.mock('../streamingDisplayScheduler.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../streamingDisplayScheduler.ts')>()
  return {
    ...actual,
    createStreamingDisplayScheduler: (
      publish: (snapshot: WorkbenchRuntimeSnapshot) => void,
      options?: Parameters<typeof actual.createStreamingDisplayScheduler>[1],
    ) => {
      const spy = vi.fn(publish)
      harness.publishSpies.push(spy)
      return actual.createStreamingDisplayScheduler(spy, options)
    },
  }
})

afterEach(() => {
  cleanup()
  harness.publications.length = 0
  harness.publishSpies.length = 0
})

function envelope(sequence: number, event: WorkbenchEventEnvelope['event']): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId: 'preview-session', recordedAt: `2026-08-25T00:00:${String(sequence).padStart(2, '0')}.000Z`, sequence,
    source: { provider: 'peri', sourceId: `gate-${sequence}` },
    provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
  })
}

/** 构造 usage 数值恒定、仅 timeline/appliedEventIds/usage 对象引用变化的文档。 */
function withNoiseUsage(document: WorkbenchDocument, tick: number): WorkbenchDocument {
  return {
    ...document,
    appliedEventIds: [...document.appliedEventIds, `usage-noise-${tick}`],
    timeline: [...document.timeline, {
      id: `usage-noise-${tick}`, sequence: 100 + tick, eventId: `usage-noise-${tick}`, kind: 'usage' as const,
    }],
    // usage 数值保持与 preview fixture 的显示值一致（canonicalTokenCount = 12480）
    session: { ...document.session, usage: { totalTokens: 12_480 } },
  }
}

describe('mountSolidWorkbench display gate（P57 S2-R1d 第一步）', () => {
  it('连续 100 个 usage 无数值变化的更新不触发显示链发表', () => {
    const services = createPreviewWorkbenchServices()
    const host = document.createElement('div')
    document.body.append(host)
    const lifecycle = mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true },
      services,
    })
    try {
      const base = projectWorkbench([
        envelope(1, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '问题' }] }),
        envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '回答' }] }),
      ]).document
      services.runtime.replaceDocument(base, { ownerKey: 'owner-preview', generation: 1 })
      // 后续 no-op 更新走活路径（applyDocument 携带 previous，等价真实 usage 事件链）。
      const frozenBase = services.runtime.getSnapshot().document!
      const baseline = harness.publishSpies[0]!.mock.calls.length

      for (let tick = 0; tick < 100; tick += 1) {
        services.runtime.applyDocument(withNoiseUsage(frozenBase, tick), { ownerKey: 'owner-preview', generation: 1 })
      }

      expect(harness.publishSpies[0]!.mock.calls.length).toBe(baseline)
    } finally {
      lifecycle.destroy()
      host.remove()
      services.destroy()
    }
  })

  it('usage 数值变化必须放行（tokenCount/footer 消费点防过度静默）', () => {
    const services = createPreviewWorkbenchServices()
    const host = document.createElement('div')
    document.body.append(host)
    const lifecycle = mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true },
      services,
    })
    try {
      const base = projectWorkbench([
        envelope(1, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '问题' }] }),
        envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '回答' }] }),
      ]).document
      services.runtime.replaceDocument(base, { ownerKey: 'owner-preview', generation: 1 })
      harness.publishSpies[0]!.mockClear()

      // canonical usage 数值变化（canonicalTokenCount 变化 → footer tokenCount 变化）
      services.runtime.replaceDocument({
        ...base,
        session: { ...base.session, usage: { ...base.session.usage, inputTokens: 4, totalTokens: 64 } },
      }, { ownerKey: 'owner-preview', generation: 1 })
      expect(harness.publishSpies[0]).toHaveBeenCalledTimes(1)
      const publishedDocument = harness.publishSpies[0]!.mock.calls[0]![0] as WorkbenchRuntimeSnapshot
      expect(publishedDocument.document?.session.usage?.totalTokens).toBe(64)

      // runtime tokenCount 变化（generationPatch 路径）同样放行
      harness.publishSpies[0]!.mockClear()
      services.runtime.replaceDocument(base, { ownerKey: 'owner-preview', generation: 1, generationPatch: { tokenCount: 4_096 } })
      expect(harness.publishSpies[0]).toHaveBeenCalledTimes(1)
      expect((harness.publishSpies[0]!.mock.calls[0]![0] as WorkbenchRuntimeSnapshot).tokenCount).toBe(4_096)
    } finally {
      lifecycle.destroy()
      host.remove()
      services.destroy()
    }
  })

  it('usage 类事件间 document.messages 数组引用不变', () => {
    const services = createPreviewWorkbenchServices()
    const host = document.createElement('div')
    document.body.append(host)
    const lifecycle = mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true },
      services,
    })
    try {
      const base = projectWorkbench([
        envelope(1, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '问题' }] }),
      ]).document
      services.runtime.replaceDocument(base, { ownerKey: 'owner-preview', generation: 1 })
      const documentMessagesRef = services.runtime.getSnapshot().document!.messages
      const frozenBase = services.runtime.getSnapshot().document!

      for (let tick = 0; tick < 10; tick += 1) {
        services.runtime.applyDocument(withNoiseUsage(frozenBase, tick), { ownerKey: 'owner-preview', generation: 1 })
      }

      expect(services.runtime.getSnapshot().document!.messages).toBe(documentMessagesRef)
    } finally {
      lifecycle.destroy()
      host.remove()
      services.destroy()
    }
  })
})
