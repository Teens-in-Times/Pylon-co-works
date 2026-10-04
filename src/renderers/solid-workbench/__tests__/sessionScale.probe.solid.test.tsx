// @vitest-environment jsdom
// 长会话规模探针：量「行数 → DOM 节点 / JS 堆 / 耗时」的斜率。
//
// **默认跳过**（须显式开）：`SESSION_SCALE_PROBE=1 bunx vitest run src/renderers/solid-workbench/__tests__/sessionScale.probe.solid.test.tsx`
// （`.solid.test.tsx` 后缀是硬约定：否则该文件落入 React 侧 tsconfig 编译范围，Solid 模块图被按 React JSX 语义检查而全红。）
// 它是**读数装置**不是断言门禁——行虚拟化的取舍要靠这条斜率，故留在树上可复跑（数据见
// `.agents/records/240-renderer-cluster-runtime-floor.md` 附六）。
//
// 注意两点：① 必须泵 rAF，否则 #212 的挂载窗口停在尾部 16 行，量到的是窗口而不是稳态；
// ② jsdom 的每节点成本远高于 Blink，**节点/行**这一列可跨环境用，**heapUsed 绝对值不可**。
import { cleanup, waitFor } from '@solidjs/testing-library'
import { describe, it } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench } from '../../../domains/workbench/workbenchProjector.ts'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

function installFramePump() {
  const queue: FrameRequestCallback[] = []
  const original = globalThis.requestAnimationFrame
  ;(globalThis as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = cb => {
    queue.push(cb)
    return queue.length
  }
  return {
    flush(maxFrames = 400) {
      let frames = 0
      while (queue.length > 0 && frames < maxFrames) {
        const batch = queue.splice(0)
        for (const cb of batch) cb(performance.now())
        frames += 1
      }
      return frames
    },
    restore() { (globalThis as { requestAnimationFrame: typeof original }).requestAnimationFrame = original },
  }
}

function envelope(sequence: number, role: 'user' | 'assistant', kind: 'text' | 'markdown', text: string): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId: 'preview-session',
    sequence,
    recordedAt: `2026-08-25T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    source: { provider: 'peri', sourceId: `scale-${sequence}` },
    identity: { messageId: `scale-msg-${sequence}` },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: { type: 'message.completed', role, parts: [{ kind, text }] },
  })
}

function buildSession(messages: number): WorkbenchEventEnvelope[] {
  const events: WorkbenchEventEnvelope[] = []
  let sequence = 0
  for (let index = 0; index < messages; index += 1) {
    sequence += 1
    events.push(envelope(sequence, 'user', 'text', `第 ${index + 1} 个提问：请解释一下这个模块的职责边界。`))
    sequence += 1
    events.push(envelope(sequence, 'assistant', 'markdown',
      `第 ${index + 1} 条回复。这段用于撑出真实的段落结构：\n\n`
      + `- 要点一：渲染层只做展示，折叠与投影在上游\n`
      + `- 要点二：行集合必须是当前文本的纯函数\n\n`
      + '```ts\nconst value: number = 42\n```\n'))
  }
  return events
}

// Node 运行时口：vitest 进程内可用；tsconfig.solid 不含 node 类型，这里做窄化访问。
interface NodeRuntime {
  env: Record<string, string | undefined>
  memoryUsage(): { heapUsed: number }
}
const node = (globalThis as { process?: NodeRuntime }).process

describe.skipIf(node?.env.SESSION_SCALE_PROBE !== '1')('长会话规模探针', () => {
  it('量行数 → 节点/堆/耗时', async () => {
    const rows: string[] = []
    for (const messages of [8, 40, 120, 300]) {
      const framePump = installFramePump()
      const host = document.createElement('div')
      document.body.append(host)
      hosts.push(host)
      const services = createPreviewWorkbenchServices()
      servicesList.push(services)
      mountSolidWorkbench({
        host,
        input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, rightInset: 24, reducedMotion: true },
        services,
      })
      const events = buildSession(messages)
      const started = performance.now()
      services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 1 })
      const landed = performance.now()
      framePump.flush()
      await waitFor(() => {
        const text = host.textContent ?? ''
        if (!text.includes(`第 ${messages} 条回复`)) throw new Error('waiting')
      }, { timeout: 30_000 })
      framePump.flush()
      const done = performance.now()
      const nodes = host.querySelectorAll('*').length
      const rowsMounted = host.querySelectorAll('.plain-message-list__row').length
      const termRows = host.querySelectorAll('.term-row').length
      const codeBlocks = host.querySelectorAll('.term-code-block').length
      const heapMB = +((node?.memoryUsage().heapUsed ?? 0) / 1048576).toFixed(1)
      rows.push(`messages=${String(messages).padStart(4)}  预期行=${messages * 2}  挂载行=${String(rowsMounted).padStart(4)}  .term-row=${String(termRows).padStart(4)}  代码块=${codeBlocks}  节点=${String(nodes).padStart(6)}  节点/行=${(nodes / (messages * 2)).toFixed(1)}  投递=${Math.round(landed - started)}ms  全渲染=${Math.round(done - started)}ms  heapUsed=${heapMB}MB`)
      framePump.restore()
      for (const s of servicesList.splice(0)) s.destroy()
      for (const h of hosts.splice(0)) h.remove()
      cleanup()
    }
    console.log('\n=== 长会话规模探针 ===\n' + rows.join('\n'))
  }, 300_000)
})
