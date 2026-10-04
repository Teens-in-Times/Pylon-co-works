/**
 * createCommandPaletteModel 单测（#520 S3-P1 拆分配套，node 环境无 DOM）。
 * 纯决策函数与 Solid 工厂各钉一层；键盘环选与 #329 分层的组件级行为
 * 由 `InputBar.solid.test.tsx` 承接（拆分前后该 32 例保持原样全绿）。
 */
import { createRoot, createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import {
  buildPaletteRows,
  createCommandPaletteModel,
  paletteSource,
  resolvePaletteKeyAction,
  sessionCommandSuggestions,
  type PaletteRow,
} from '../createCommandPaletteModel.solid.tsx'
import type { CommandSuggestion } from '../../../../domains/chat/commandRegistry.ts'
import type { SessionCommand } from '../../../../domains/workbench/session/sessionSurface.ts'

const suggestion = (cmd: string, tier?: CommandSuggestion['tier']): CommandSuggestion => ({
  cmd, args: '', info: `${cmd} 的说明`, ...(tier ? { tier } : {}),
})

const sessionCommand = (partial: Partial<SessionCommand> & Pick<SessionCommand, 'name'>): SessionCommand => ({
  id: partial.name, availability: true, ...partial,
})

describe('createCommandPaletteModel · 纯函数', () => {
  it('buildPaletteRows：命令项按可见清单建行，切换项只在「有内部被折叠或已展开」时出现', () => {
    const rows: PaletteRow[] = buildPaletteRows({ visible: [suggestion('/a')], total: 3, showAll: false })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'command', key: 'cmd:/a' })
    expect(rows[1]).toEqual({ kind: 'toggle', key: 'toggle-layer' })

    // 无内部可折、未展开 ⇒ 无切换项（面板只有命令）
    expect(buildPaletteRows({ visible: [suggestion('/a')], total: 1, showAll: false })).toHaveLength(1)
    // 已展开 ⇒ 切换项常在（收回去的入口）
    expect(buildPaletteRows({ visible: [suggestion('/a')], total: 1, showAll: true })[1]).toEqual({ kind: 'toggle', key: 'toggle-layer' })
  })

  it('sessionCommandSuggestions：过滤不可用命令，无斜杠前缀补「/」，缺省按 user 档呈现', () => {
    const rows = sessionCommandSuggestions([
      sessionCommand({ name: '/model', description: '会话模型命令' }),
      sessionCommand({ name: 'review', inputHint: ' <scope>', availability: false }),
      sessionCommand({ name: 'audit', availability: 'unavailable' }),
      sessionCommand({ name: 'compact' }),
    ])
    expect(rows.map(row => row.cmd)).toEqual(['/model', '/compact'])
    expect(rows[0]?.tier).toBe('user')
    expect(rows[0]?.args).toBe('')
  })

  it('paletteSource：会话命令在场则权威，否则兜底目录', () => {
    const session = [
      sessionCommand({ name: '/model', description: '会话模型命令' }),
      sessionCommand({ name: 'review', inputHint: ' <scope>', availability: false }),
    ]
    expect(paletteSource(session)).toEqual(sessionCommandSuggestions(session))
    expect(paletteSource([])).toEqual(paletteSource([])) // 兜底目录（registry 未注册 ⇒ 空表）
  })

  it('resolvePaletteKeyAction：无面板行时不消费', () => {
    expect(resolvePaletteKeyAction({
      key: 'Enter', shiftKey: false, composing: false, index: 0,
      rows: [], suggestions: [], draft: '/mod',
    })).toBeUndefined()
  })

  it('Enter：落在切换项上切层；落在命令项上补全并带回已输入参数（#327）', () => {
    const rows: PaletteRow[] = [
      { kind: 'command', key: 'cmd:/model', suggestion: suggestion('/model') },
      { kind: 'toggle', key: 'toggle-layer' },
    ]
    const suggestions = [suggestion('/model')]
    expect(resolvePaletteKeyAction({
      key: 'Enter', shiftKey: false, composing: false, index: 1,
      rows, suggestions, draft: '/mo',
    })).toEqual({ type: 'toggle-layer' })
    expect(resolvePaletteKeyAction({
      key: 'Enter', shiftKey: false, composing: false, index: 0,
      rows, suggestions, draft: '/模型 deepseek',
    })).toEqual({ type: 'apply', suggestion: rows[0]!.kind === 'command' ? rows[0]!.suggestion : undefined, args: 'deepseek' })
  })

  it('Enter：用户已完整敲出命令名（含被折叠的 internal）⇒ 不消费，放行给发送链（#329 审查）', () => {
    const rows: PaletteRow[] = [{ kind: 'toggle', key: 'toggle-layer' }]
    const suggestions = [suggestion('/model', 'internal')]
    expect(resolvePaletteKeyAction({
      key: 'Enter', shiftKey: false, composing: false, index: 0,
      rows, suggestions, draft: '/model deepseek-chat',
    })).toBeUndefined()
  })

  it('Shift+Enter 与 IME 组合中的 Enter 不进面板判定', () => {
    const rows: PaletteRow[] = [{ kind: 'toggle', key: 'toggle-layer' }]
    expect(resolvePaletteKeyAction({
      key: 'Enter', shiftKey: true, composing: false, index: 0, rows, suggestions: [], draft: '/x',
    })).toBeUndefined()
    expect(resolvePaletteKeyAction({
      key: 'Enter', shiftKey: false, composing: true, index: 0, rows, suggestions: [], draft: '/x',
    })).toBeUndefined()
  })

  it('Tab：命令项补全；切换项上只吞事件（consume）', () => {
    const commandRow: PaletteRow = { kind: 'command', key: 'cmd:/model', suggestion: suggestion('/model') }
    expect(resolvePaletteKeyAction({
      key: 'Tab', shiftKey: false, composing: false, index: 0, rows: [commandRow], suggestions: [], draft: '/mo',
    })).toEqual({ type: 'apply', suggestion: commandRow.kind === 'command' ? commandRow.suggestion : undefined, args: undefined })
    expect(resolvePaletteKeyAction({
      key: 'Tab', shiftKey: false, composing: false, index: 0, rows: [{ kind: 'toggle', key: 't' }], suggestions: [], draft: '/mo',
    })).toEqual({ type: 'consume' })
  })

  it('↑/↓：↓ 环绕回卷、↑ 到底停在 0', () => {
    const rows: PaletteRow[] = [
      { kind: 'command', key: 'a', suggestion: suggestion('/a') },
      { kind: 'command', key: 'b', suggestion: suggestion('/b') },
    ]
    expect(resolvePaletteKeyAction({ key: 'ArrowDown', shiftKey: false, composing: false, index: 1, rows, suggestions: [], draft: '/' }))
      .toEqual({ type: 'move', index: 0 })
    expect(resolvePaletteKeyAction({ key: 'ArrowUp', shiftKey: false, composing: false, index: 0, rows, suggestions: [], draft: '/' }))
      .toEqual({ type: 'move', index: 0 })
  })
})

describe('createCommandPaletteModel · 工厂', () => {
  it('按草稿过滤会话命令；带参数不改首词判定；非斜杠查询⇒空面板', async () => {
    createRoot(dispose => {
      const [draft, setDraft] = createSignal('')
      const [revision] = createSignal(0)
      const palette = createCommandPaletteModel({
        draft,
        sessionCommands: () => [
          sessionCommand({ name: '/model', description: '会话模型命令' }),
          sessionCommand({ name: '/review', description: '审查当前改动', inputHint: ' <scope>' }),
        ],
        commandRevision: revision,
      })
      expect(palette.rows()).toHaveLength(0) // 非斜杠草稿 ⇒ 不出面板
      setDraft('/rev')
      expect(palette.rows().map(row => row.kind === 'command' ? row.suggestion.cmd : row.key)).toEqual(['/review'])
      setDraft('/rev src')
      expect(palette.rows()).toHaveLength(1) // 过滤按首词（命令名前缀），带参数不改判定
      setDraft('普通消息')
      expect(palette.rows()).toHaveLength(0)
      dispose()
    })
  })

  it('索引越界自动归零；resetIndex 复位；dispose 幂等', async () => {
    let palette!: ReturnType<typeof createCommandPaletteModel>
    const dispose = createRoot(disposer => {
      const [draft, setDraft] = createSignal('/')
      const [revision] = createSignal(0)
      palette = createCommandPaletteModel({
        draft,
        sessionCommands: () => [sessionCommand({ name: '/model' })],
        commandRevision: revision,
      })
      setDraft('/mo')
      palette.setIndex(5) // 越界 ⇒ clamp effect 归零（effect 在微任务冲刷）
      return disposer
    })
    await Promise.resolve()
    expect(palette.activeIndex()).toBe(0)
    expect(palette.rows()).toHaveLength(1)
    palette.resetIndex()
    expect(palette.activeIndex()).toBe(0)
    expect(() => { palette.dispose(); palette.dispose() }).not.toThrow()
    dispose()
  })

  it('默认层只列 user 级；「全部」切换经 toggleLayer 可展开收回（#329 分层）', () => {
    createRoot(dispose => {
      const [draft, setDraft] = createSignal('/')
      const [revision] = createSignal(0)
      const palette = createCommandPaletteModel({
        draft,
        sessionCommands: () => [
          // 经 sessionCommandSuggestions（decorateSuggestions(user)）后命令挂 user 档 ⇒ 无内部可折；
          // 分层折叠行为用 buildPaletteRows 与组件级 InputBar 用例钉，这里锁链路通畅。
          sessionCommand({ name: '/model' }),
        ],
        commandRevision: revision,
      })
      setDraft('/')
      expect(palette.visibleSuggestions()).toHaveLength(1)
      expect(palette.showAll()).toBe(false)
      palette.toggleLayer()
      expect(palette.showAll()).toBe(true)
      expect(palette.activeIndex()).toBe(0) // 切层后索引复位
      palette.toggleLayer()
      expect(palette.showAll()).toBe(false)
      dispose()
    })
  })
})
