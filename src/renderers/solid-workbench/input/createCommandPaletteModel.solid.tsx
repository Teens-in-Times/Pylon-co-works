/**
 * createCommandPaletteModel — InputBar 命令面板的模型层（#520 S3-P1 自 InputBar.solid.tsx 拆出）。
 *
 * 职责：候选解析（会话上报命令 > 兜底目录）→ 过滤 → #329 分层（默认只列 user 级）
 * → 面板行（命令项 + 「全部/常用」切换项）→ 环选索引与键位判定。
 *
 * 纯 ts（无 JSX）；纯决策函数（`buildPaletteRows` / `resolvePaletteKeyAction`）
 * 与 Solid 工厂同文件，单测两种都能钉。组件只消费模型并负责 DOM（scrollIntoView、
 * 草稿写入、textarea 焦点）。
 */
import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js'
import {
  filterCommandSuggestions,
  parseSlashCommand,
  resolveFallbackCommands,
  selectUserTier,
  decorateSuggestions,
  type CommandSuggestion,
} from '../../../domains/chat/commandRegistry.ts'
import type { SessionCommand } from '../../../domains/workbench/session/sessionSurface.ts'

/** 命令面板的一行：命令项，或「全部/常用」分层切换项（切换项进环选，键盘可达）。 */
export type PaletteRow =
  | { kind: 'command'; key: string; suggestion: CommandSuggestion }
  | { kind: 'toggle'; key: string }

/** 会话上报命令 → 建议项。宿主注册表里的元数据（检索词 + 可见性档）按命令名并回：
 *  只靠上报字段，中文界面下 `/新` 搜不到英文命令名（#327）、分层也落不了地（#329）。
 *  agent 主动宣告的命令默认按 user 级呈现——那是它要用户用的命令。 */
export function sessionCommandSuggestions(commands: readonly SessionCommand[]): readonly CommandSuggestion[] {
  return decorateSuggestions(commands
    .filter(command => command.availability !== false && command.availability !== 'unavailable')
    .map(command => ({
      cmd: command.name.startsWith('/') ? command.name : `/${command.name}`,
      args: command.inputHint ?? '',
      info: command.description ?? command.capability ?? '会话命令',
    })), 'user')
}

/** 候选源：会话上报命令在场则权威，否则兜底目录。 */
export function paletteSource(sessionCommands: readonly SessionCommand[]): readonly CommandSuggestion[] {
  return sessionCommands.length > 0 ? sessionCommandSuggestions(sessionCommands) : resolveFallbackCommands()
}

/** 面板行 = 当前分层可见的命令项 +（有内部命令被折叠或已展开时的）「全部/常用」切换项。 */
export function buildPaletteRows(input: {
  visible: readonly CommandSuggestion[]
  /** 全量（未分层）命中数——「含内部 N 条」按实际隐藏量算，不按命中量算（#329 审查 P2）。 */
  total: number
  showAll: boolean
}): PaletteRow[] {
  const rows: PaletteRow[] = input.visible.map(suggestion => ({ kind: 'command', key: `cmd:${suggestion.cmd}`, suggestion }))
  const hiddenInternalCount = input.total - input.visible.length
  if (hiddenInternalCount > 0 || input.showAll) rows.push({ kind: 'toggle', key: 'toggle-layer' })
  return rows
}

/** 键盘对面板行的处置（undefined = 面板不消费，事件继续走预测/历史/发送链）。 */
export type PaletteKeyAction =
  | { type: 'apply'; suggestion: CommandSuggestion; args?: string }
  | { type: 'toggle-layer' }
  | { type: 'move'; index: number }
  | { type: 'consume' }

/**
 * 环选键位判定（纯函数）。行为逐字对齐拆分前的 onKeyDown 面板段：
 * - Enter：落在切换项上则切层；落在命令项上且**不是**「用户已完整敲出该命令名」则补全。
 *   用户完整敲出（含被折叠的 internal 命令）时 Enter 放行给发送链（#329 审查）。
 * - Tab：命令项补全；切换项上只吞事件。
 * - ↑/↓：环选（↓ 环绕回卷、↑ 到底停在 0）。
 */
export function resolvePaletteKeyAction(input: {
  key: string
  shiftKey: boolean
  composing: boolean
  index: number
  rows: readonly PaletteRow[]
  /** 全量（未分层）建议——Enter 的「完整敲出」判据按全量查。 */
  suggestions: readonly CommandSuggestion[]
  draft: string
}): PaletteKeyAction | undefined {
  const { key, shiftKey, composing, index, rows, suggestions, draft } = input
  if (rows.length === 0) return undefined
  if (key === 'Enter' && !shiftKey && !composing) {
    const row = rows[index]
    const parsed = parseSlashCommand(draft)
    const exact = parsed
      ? suggestions.find(item => item.cmd.toLowerCase() === parsed.name.toLowerCase())
      : undefined
    if (row?.kind === 'toggle' && !exact) return { type: 'toggle-layer' }
    if (row?.kind === 'command' && !exact && parsed?.name.toLowerCase() !== row.suggestion.cmd.toLowerCase()) {
      // 中文名（`/模型 deepseek`）永远走补全路径，必须把已输入参数带过去（#327）。
      return { type: 'apply', suggestion: row.suggestion, args: parsed?.args }
    }
    return undefined
  }
  if (key === 'Tab') {
    const row = rows[index]
    return row?.kind === 'command' ? { type: 'apply', suggestion: row.suggestion } : { type: 'consume' }
  }
  if (key === 'ArrowDown') return { type: 'move', index: (index + 1) % rows.length }
  if (key === 'ArrowUp') return { type: 'move', index: Math.max(index - 1, 0) }
  return undefined
}

export interface CommandPaletteModel {
  /** 全量（未分层）过滤命中——Enter 的「完整敲出」判据用它。 */
  suggestions(): readonly CommandSuggestion[]
  /** 当前分层可见的建议（发送链的 `shouldRunSlashCommand` 判据用它）。 */
  visibleSuggestions(): readonly CommandSuggestion[]
  /** 面板行（命令项 + 切换项）。 */
  rows(): readonly PaletteRow[]
  /** 当前环选索引。 */
  activeIndex(): number
  setIndex(value: number): void
  /** 面板收起后的索引复位（输入变化 / 发送成功 / 补全后）。 */
  resetIndex(): void
  /** 当前是否展开「全部」。 */
  showAll(): boolean
  /** 「全部」里比默认层多出来的条数。 */
  hiddenInternalCount(): number
  /** 「全部/常用」切换。 */
  toggleLayer(): void
  /** 模型内挂的 effect 随 owner 清理；测试外一般无需手调。 */
  dispose(): void
}

export function createCommandPaletteModel(inputs: {
  draft: Accessor<string>
  /** 会话上报命令（runtime 文档切片）。 */
  sessionCommands: Accessor<readonly SessionCommand[]>
  /** 宿主命令注册表修订号（订阅变更时自增，触发重过滤）。 */
  commandRevision: Accessor<number>
}): CommandPaletteModel {
  const [commandIndex, setCommandIndex] = createSignal(0)
  const [showAllCommands, setShowAllCommands] = createSignal(false)

  const suggestions = createMemo(() => {
    inputs.commandRevision()
    const source = paletteSource(inputs.sessionCommands())
    return filterCommandSuggestions(inputs.draft(), source)
  })
  const userSuggestions = createMemo(() => selectUserTier(suggestions()))
  /** #329 分层：默认只列 user 级；内部/开发者命令折叠在「全部」里。
   *  **不做「user 层没命中就放行全量」的例外**——那个条件太宽（敲 `/s` 就会漏出 11 条
   *  skin 命令，正是本 issue 要治的「内部命令淹没日常命令」）。用户要找内部命令时，
   *  面板底部的切换项就在环选里，一格键的距离。 */
  const suggestionList = createMemo(() => showAllCommands() ? suggestions() : userSuggestions())
  const hiddenInternalCount = createMemo(() => suggestions().length - suggestionList().length)
  const paletteRows = createMemo<PaletteRow[]>(() => buildPaletteRows({
    visible: suggestionList(),
    total: suggestions().length,
    showAll: showAllCommands(),
  }))
  const toggleCommandLayer = () => {
    setShowAllCommands(current => !current)
    setCommandIndex(0)
  }
  // 展开状态跟着这一次 `/` 输入走：草稿不再是斜杠命令就收回（否则展开会粘到整个应用
  // 会话，「只看常用命令」的控件也随面板一起消失，用户再也收不回来）。
  createEffect(() => {
    if (!inputs.draft().trimStart().startsWith('/')) setShowAllCommands(false)
  })
  // 列表长度会随查询/分层切换变化：索引越界会让「回车」落到面板外（被当成普通消息发出）。
  createEffect(() => {
    if (commandIndex() >= paletteRows().length) setCommandIndex(0)
  })

  return {
    suggestions,
    visibleSuggestions: suggestionList,
    rows: paletteRows,
    activeIndex: commandIndex,
    setIndex: setCommandIndex,
    resetIndex: () => setCommandIndex(0),
    showAll: showAllCommands,
    hiddenInternalCount,
    toggleLayer: toggleCommandLayer,
    dispose: () => { /* effect 挂 owner；留缝与接口对称。 */ },
  }
}
