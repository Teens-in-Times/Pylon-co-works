/**
 * A04 projector · 归约器与双入口（#486 项2 四分之 reducer；行为不变）。
 *
 * `reduceWorkbenchEvent`（单事件 live）与 `projectWorkbench`（批量回放）共享同一
 * `reduceSemanticEvent`；幂等判据（journal 区间覆盖 / eventId）与 interaction 脱敏在
 * 两条路径逐字一致（对照测试 workbenchProjectorArrivalConvergence 护住，勿弱化）。
 */
import { coalesceAdjacentDisplayTextParts, coalesceAdjacentReasoningParts, createUnknownContentPart, parseContentPart, type ContentPart } from './content/contentPartSchema.ts'
import { applyGoalEvents, applyPlanEvent, normalizeGoalSnapshot } from './plan/goalModel.ts'
import { applyLifecycleEvent, normalizeNormalizedError } from './lifecycle/lifecycleModel.ts'
import { reduceInteraction, redactInteractionEvent } from './interactionProjection.ts'
import { isActivityStatus } from './events/workbenchEventSchema.ts'
import type {
  ActivityEvent,
  AssistEvent,
  DiagnosticEvent,
  ExtensionEvent,
  GoalEvent,
  LifecycleEvent,
  MessageEvent,
  PlanEvent,
  SessionEvent,
  ToolEvent,
  UsageEvent,
  WorkbenchEventEnvelope,
  WorkbenchSemanticEvent,
} from './events/workbenchEventSchema.ts'
import { normalizeBudgetSnapshot, normalizeSessionCommands, normalizeSessionConfigOptions, normalizeUsageSnapshot } from './session/sessionSurface.ts'
import { addDiagnostic, narrowingEnabled, timelineEntry, updateTimeline } from './workbenchProjectorDiagnostics.ts'
import { createWorkbenchDocument, freezeDeepSnapshot, freezeJsonValue, isRecord, stringValue, SESSION_LIFECYCLE_STATUSES, TERMINAL_SESSION_STATUSES, TERMINAL_TOOL_STATUSES } from './workbenchProjectorTypes.ts'
import type {
  ProjectionResult,
  WorkbenchActivityNode,
  WorkbenchDocument,
  WorkbenchExtensionNode,
  WorkbenchMessage,
  WorkbenchProjectionDiagnostic,
  WorkbenchTimelineEntry,
} from './workbenchProjectorTypes.ts'

/** #81 L2：信封携带的 journal 覆盖跨度（形状非法视为无 coverage）。 */
function coverageSpanOf(envelope: WorkbenchEventEnvelope): readonly [number, number] | undefined {
  const span = envelope.coverage
  if (!span || !Number.isSafeInteger(span[0]) || !Number.isSafeInteger(span[1]) || span[0] < 1 || span[0] > span[1]) return undefined
  return [span[0], span[1]]
}

/**
 * 区间 [start,end] 是否被升序不重叠覆盖集完整包含。
 * 约束：coverage 信封必须"完整覆盖已应用区间或从全新文档到达"；部分重叠时整段
 * 仍会投影（内容重复拼接）——正常路径（bind 全新投影 / live 顺序到达 / 单元覆盖
 * ⊆ 已应用行）不可达，见审核 P2-1。
 */
function isSpanCovered(ranges: readonly (readonly [number, number])[], start: number, end: number): boolean {
  for (const [from, to] of ranges) {
    if (from > start) return false
    if (end <= to) return true
  }
  return false
}

/** 并入一个区间并保持升序不重叠（吸收接触/重叠区间）。 */
function mergeCoverage(ranges: readonly (readonly [number, number])[], start: number, end: number): readonly (readonly [number, number])[] {
  const merged: [number, number][] = []
  let low = start
  let high = end
  let placed = false
  for (const [from, to] of ranges) {
    if (to < low - 1) {
      merged.push([from, to])
      continue
    }
    if (from > high + 1) {
      // 整数跨度上相邻即连续（[1,3]+[4,6] → [1,6]），接触区间一律吸收
      if (!placed) {
        merged.push([low, high])
        placed = true
      }
      merged.push([from, to])
      continue
    }
    low = Math.min(low, from)
    high = Math.max(high, to)
  }
  if (!placed) merged.push([low, high])
  return merged
}

/**
 * #205：`mergeCoverage` 的就地版——批量回放路径持有区间数组的所有权，只改写被
 * 触及的窗口（`splice` 替换），把「每事件重建整数组」的 Θ(N·R) 降到均摊 Θ(1)
 * （升序跨度只需追加；吞并窗口的代价由被删区间偿付）。合并规则与 `mergeCoverage`
 * 逐字一致：升序、不重叠、相邻即吸收（`to < low-1` 前缀保留、`from <= high+1` 吸收）。
 */
function mergeCoverageInPlace(ranges: [number, number][], start: number, end: number): void {
  let first = 0
  while (first < ranges.length && ranges[first]![1] < start - 1) first++
  let low = start
  let high = end
  let last = first
  while (last < ranges.length && ranges[last]![0] <= high + 1) {
    low = Math.min(low, ranges[last]![0])
    high = Math.max(high, ranges[last]![1])
    last++
  }
  if (first === last && ranges[first]?.[0] === low && ranges[first]?.[1] === high) return
  ranges.splice(first, last - first, [low, high])
}

/**
 * #205：入参是否已按批量路径的排序判据升序（sequence 升序，同 sequence 按 eventId）。
 * 成立时调用方可直接使用入参数组，省掉一份整集合拷贝 + 排序（冷重放每帧一份）。
 */
function isAscendingBySequence(events: readonly WorkbenchEventEnvelope[]): boolean {
  for (let index = 1; index < events.length; index++) {
    const previous = events[index - 1]!
    const current = events[index]!
    if (previous.sequence > current.sequence) return false
    if (previous.sequence === current.sequence && previous.eventId.localeCompare(current.eventId) > 0) return false
  }
  return true
}

/**
 * #205：升序 sequence 索引上的「存在 ∈ (after, before) 的元素」查询（二分）。
 * 索引由批量路径按 timeline 顺序增量维护（timeline 自身按 sequence 排序）。
 */
function hasIndexedSequenceBetween(index: readonly number[], after: number, before: number): boolean {
  let low = 0
  let high = index.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (index[middle]! <= after) low = middle + 1
    else high = middle
  }
  return low < index.length && index[low]! < before
}

/**
 * #205：tool 边界查询——「是否存在 kind==='tool' 且 sequence ∈ (after, before) 的 timeline 条目」。
 *
 * 归约器原本对整条 timeline 做 `.some`，而该查询落在**最高频事件类型**（reasoning/
 * text delta）上 ⇒ Θ(N·T)。`index` 是批量路径增量维护的 tool 条目 sequence 升序数组，
 * 二分即可等价作答；无索引（单事件 live 路径）时回退原扫描，语义不变。
 */
function hasToolBetween(
  document: WorkbenchDocument,
  after: number,
  before: number,
  index?: readonly number[],
): boolean {
  if (index) return hasIndexedSequenceBetween(index, after, before)
  return timelineHasBetween(document.timeline, after, before, entry => entry.kind === 'tool')
}

/**
 * #204③：sequence 升序 timeline 上「存在 ∈ (after, before) 且满足谓词的条目」。
 * 二分定位起点后只在区间内扫描——live 流式的区间几乎恒空（相邻 sequence），
 * 每帧从整条 `.some` 的 O(N) 降到 O(log N + k)。谓词语义与原扫描逐条一致。
 */
function timelineHasBetween(
  timeline: readonly WorkbenchTimelineEntry[],
  after: number,
  before: number,
  predicate: (entry: WorkbenchTimelineEntry) => boolean,
): boolean {
  let low = 0
  let high = timeline.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (timeline[middle]!.sequence <= after) low = middle + 1
    else high = middle
  }
  for (let index = low; index < timeline.length; index += 1) {
    const entry = timeline[index]!
    if (entry.sequence >= before) return false
    if (predicate(entry)) return true
  }
  return false
}

/** 终态 session 条目的判据（`terminalSessionSequence` 的逐条口径，索引与扫描共用）。 */
function isTerminalSessionEntry(entry: WorkbenchTimelineEntry): boolean {
  if (entry.kind !== 'session' || !isRecord(entry.data)) return false
  const data = entry.data as { type?: unknown; status?: unknown }
  return data.type === 'session.completed'
    || (typeof data.status === 'string' && TERMINAL_SESSION_STATUSES.has(data.status.toLowerCase()))
}

export function reduceWorkbenchEvent(
  document: WorkbenchDocument,
  envelope: WorkbenchEventEnvelope,
): WorkbenchDocument {
  // #81 L2：journal 信封按覆盖区间幂等（单元/批量展开与逐 chunk 行粒度不同）；
  // 非 journal 信封（optimistic/session-response）保持 eventId 幂等。
  const span = coverageSpanOf(envelope)
  if (span ? isSpanCovered(document.appliedRanges, span[0], span[1]) : document.appliedEventIds.includes(envelope.eventId)) return document
  // C12：secret-bearing interaction 事件在进入任何投影面（timeline.data、interactions）前统一剥敏——
  // journal 投影的 timeline 与 document.interactions 共享同一脱敏结果
  // SAFETY: redactInteractionEvent 是保形脱敏（只替换敏感叶子值，不增删键），结果仍是同一
  // event.type 的 WorkbenchEventEnvelope；内层断言为适配其开放的 Record<string, unknown> 入参。
  const effective: WorkbenchEventEnvelope = envelope.event.type.startsWith('interaction.')
    ? { ...envelope, event: redactInteractionEvent(envelope.event as unknown as Record<string, unknown>) } as unknown as WorkbenchEventEnvelope
    : envelope
  const newEntry = timelineEntry(effective, narrowingEnabled(undefined))
  const timeline = insertBySequence(document.timeline, newEntry)
  // #551：为新的 timeline 数组增量写入终态序列号——旧值命中 timeline 级记忆（O(1)），
  // 新值只取决于「本条是否终态」。缺了这一步，读取侧缓存对新数组永远未命中（每帧仍全表扫）。
  terminalSequenceByTimeline.set(
    timeline,
    isTerminalSessionEntry(newEntry)
      ? Math.max(terminalSessionSequence(document), newEntry.sequence)
      : terminalSessionSequence(document),
  )
  let next: WorkbenchDocument = {
    ...document,
    revision: Math.max(document.revision, envelope.sequence),
    ...(span
      ? { appliedRanges: mergeCoverage(document.appliedRanges, span[0], span[1]) }
      : { appliedEventIds: [...document.appliedEventIds, envelope.eventId] }),
    timeline,
  }
  next = reduceSemanticEvent(next, effective)
  return refreshOrphans(next)
}

export function projectWorkbench(
  events: readonly WorkbenchEventEnvelope[],
  options: { readonly initialDocument?: WorkbenchDocument; readonly narrowTimelinePayload?: boolean } = {},
): ProjectionResult {
  // #205：冷重放的 journal 行本就有序（SQL ORDER BY sequence）——已升序时直接用入参，
  // 省掉一份整集合拷贝 + 一次排序；乱序输入（live 缓冲折入）仍走同一排序语义。
  const sorted = isAscendingBySequence(events)
    ? events
    : [...events].sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
  const initial = options.initialDocument ?? createWorkbenchDocument(sorted[0]?.sessionId ?? '')
  // P57 S2-R1e：批量回放入口用本地 Set 预去重，appliedEventIds 以共享可变数组按序追加、
  // 末端一次冻结——把单事件路径 `includes` + spread 的 O(n²) 降到 O(n)（R-A6）。
  // 公共形状 readonly string[] 不变；单事件 live 路径仍走 reduceWorkbenchEvent。
  const applied = new Set(initial.appliedEventIds)
  const appliedEventIds = [...initial.appliedEventIds]
  // #205：批量路径取得工作数组所有权——timeline 只在入口复制一次，之后就地追加；
  // 覆盖区间首用时复制一次，之后就地并入。两者都把「逐事件整数组复制」的
  // Θ(N²)/Θ(N·R) 降到摊销 Θ(N)。对外暴露前统一冻结（与改造前形状一致）。
  let timeline: WorkbenchTimelineEntry[] = [...initial.timeline]
  let ranges: [number, number][] | undefined
  // #205：timeline 派生索引——归约器要按 sequence 问「(a,b) 内有没有 tool 条目 /
  // 文本流边界 / 终态 session 条目」。原本逐事件整条扫描（落在最高频的 delta 上 ⇒
  // Θ(N·T)）。timeline 自身按 sequence 升序，故按位置增量延展即保持有序；
  // 归约器换掉 timeline 数组时（tool/activity/诊断等低频事件）按位置补扫。
  // #409：activities 与 timeline 同据——入口复制一次取得批内所有权（initial 可能来自
  // 外部 initialDocument），此后追加/替换就地发生在本拷贝上。
  const ownedActivities = [...initial.activities]
  const context: {
    toolSequences: number[]
    textBoundarySequences: number[]
    terminalSessionSequences: number[]
    draft: boolean
    activityIds: Map<string, number>
    activityIndexSize: number
    hasParentActivities: boolean
  } = {
    toolSequences: [],
    textBoundarySequences: [],
    terminalSessionSequences: [],
    // #234：批量路径独占本轮的中间数组（timeline 已在入口复制、中间文档一律丢弃），
    // 故允许归约器就地改尾条/数组，免掉每事件 O(T) 的整表复制。
    draft: true,
    // #409：入口建一次 id→下标索引；此后由主循环随追加增量补录。
    activityIds: new Map(ownedActivities.map((activity, index) => [activity.id, index])),
    activityIndexSize: ownedActivities.length,
    hasParentActivities: ownedActivities.some(activity => activity.parentId !== undefined),
  }
  let indexedEntries = 0
  const indexTimeline = (entries: readonly WorkbenchTimelineEntry[], from: number): void => {
    for (let index = from; index < entries.length; index++) {
      const entry = entries[index]!
      if (entry.kind === 'tool') context.toolSequences.push(entry.sequence)
      if (isTextStreamBoundary(entry)) context.textBoundarySequences.push(entry.sequence)
      if (isTerminalSessionEntry(entry)) context.terminalSessionSequences.push(entry.sequence)
    }
  }
  let orphanActivities: readonly WorkbenchActivityNode[] | undefined
  // #234：可变集合——按尾部增量补齐 id（见下方循环里的不变式说明），不再每事件整集合重建。
  let orphanIds: Set<string> | undefined
  let document: WorkbenchDocument = { ...initial, activities: ownedActivities }
  for (const envelope of sorted) {
    // #81 L2：与 reduceWorkbenchEvent 同一幂等判据（journal 信封按区间覆盖，
    // 其余按 eventId）——单事件路径与批量路径语义一致。
    const span = coverageSpanOf(envelope)
    if (span) {
      const current = ranges ?? (ranges = initial.appliedRanges.map(range => [range[0], range[1]] as [number, number]))
      if (isSpanCovered(current, span[0], span[1])) continue
      mergeCoverageInPlace(current, span[0], span[1])
    } else {
      if (applied.has(envelope.eventId)) continue
      applied.add(envelope.eventId)
      appliedEventIds.push(envelope.eventId)
    }
    // SAFETY: 同上一处——redactInteractionEvent 保形，结果仍是同一 event.type 的 WorkbenchEventEnvelope。
    const effective: WorkbenchEventEnvelope = envelope.event.type.startsWith('interaction.')
      ? { ...envelope, event: redactInteractionEvent(envelope.event as unknown as Record<string, unknown>) } as unknown as WorkbenchEventEnvelope
      : envelope
    const entry = timelineEntry(effective, narrowingEnabled(options.narrowTimelinePayload))
    const tail = timeline.at(-1)
    // 升序输入下恒走 push（入口已排序 ⇒ 不中插）；乱序兜底仍是同一插入语义。
    if (!tail || tail.sequence <= entry.sequence) timeline.push(entry)
    else timeline = insertBySequence(timeline, entry)
    let next: WorkbenchDocument = {
      ...document,
      revision: Math.max(document.revision, envelope.sequence),
      appliedEventIds,
      appliedRanges: ranges ?? initial.appliedRanges,
      timeline,
    }
    next = reduceSemanticEvent(next, effective, context)
    if (next.timeline !== timeline) {
      // 归约器换掉了 timeline 数组，两个来源，代价完全不同（#234）：
      //
      // ① **按 eventId 打补丁**（`updateTimeline`，长度不变）：tool / 诊断事件每拍都会走
      //    （`{streamBoundary:true}` / `{status,title}` / `{status,summary}`）。补丁目标是
      //    **本轮刚 push 的那一条**——它带的就是本轮 envelope 的 eventId，而它还没进索引
      //    （`indexedEntries` 只覆盖到它的前一条）。所以**前缀索引毫发无损**：三个索引读的是
      //    `kind` / `streamBoundary` / `data.*`，补丁里唯一能翻转谓词的是 tool 的
      //    `streamBoundary=false→true`，而被翻转的正是那条尚未索引的尾条。
      // ② 其它结构性替换（长度可能变）⇒ 索引确实失效，必须重建。
      //
      // 原先对两者一律 `indexedEntries = 0` 整表重扫 ⇒ 「每条 tool/诊断事件重扫一次整条
      // timeline」= Θ(N²)（实测 tool-only 24,000 事件单次折叠 24.6s，#234）。
      const replaced = next.timeline as WorkbenchTimelineEntry[]
      const patchOnTail = replaced.length === timeline.length
        && replaced.at(-1)?.eventId === envelope.eventId
      // 接管所有权：归约器给的是它自己 `.map`/展开出来的**新**数组，与 `next` 以外的引用无关，
      // 可以直接原地 push（省掉每拍一次整表复制）。冻结的数组不能接管——外部传入的
      // `initialDocument.timeline` 可能是冻结的，原地 push 会抛。
      timeline = Object.isFrozen(replaced) ? [...replaced] : replaced
      if (!patchOnTail) {
        indexedEntries = 0
        context.toolSequences = []
        context.textBoundarySequences = []
        context.terminalSessionSequences = []
      }
    }
    if (indexedEntries > timeline.length) {
      indexedEntries = 0
      context.toolSequences = []
      context.textBoundarySequences = []
      context.terminalSessionSequences = []
    }
    indexTimeline(timeline, indexedEntries)
    indexedEntries = timeline.length
    // orphan 是 (activities id 集合, parentId) 的纯函数：activities 数组同一引用 ⇒ id 未变
    // ⇒ 上轮结果仍然成立，免掉每事件重建 Set（归约器不读 orphan，故与逐事件刷新等价）。
    //
    // #234：**重建整集合本身是 Θ(N·A)**——tool 事件每拍都替换 activities 数组引用（upsert
    // 出新数组），于是每事件都 `new Set(activities.map(...))`。实测这就是 tool 密集折叠
    // 47.9% 的 CPU（CPU profile，12,000 卡 = 36,000 事件）。改为**增量补齐尾部新增的 id**：
    // 不变式 = `orphanIds` 恰是 `orphanActivities` 前 `orphanIds.size` 个元素的 id 集合，
    // 且 activities **只在尾部增长**。该不变式由两个生产者保证：
    // `upsertActivity` 新节点追加在末尾、按 id 命中时原位替换（id 与位置都不变）；
    // `refreshOrphans` 保序保长。长度回退时才退回整集合重建（防御，不是热路径）。
    // #409：upsert 就地替换/追加后数组引用可以不变，孤儿集合的门改按「引用或长度」——
    // 引用变=整集合换新（refreshOrphans 克隆），长度变=尾部追加了新 id；两者都要补录。
    if (next.activities !== orphanActivities || next.activities.length !== (orphanIds?.size ?? 0)) {
      if (orphanIds === undefined || next.activities.length < orphanIds.size) {
        orphanIds = new Set(next.activities.map(activity => activity.id))
      } else {
        for (let index = orphanIds.size; index < next.activities.length; index += 1) {
          orphanIds.add(next.activities[index]!.id)
        }
      }
      orphanActivities = next.activities
    }
    // #409：文档里不存在带 parentId 的活动时，refreshOrphans 的探测恒「无需工作」
    // 恒等返回——整跳这次 O(A) 扫描（upsert 在引入首个 parentId 时置位）。
    document = context.hasParentActivities ? refreshOrphans(next, orphanIds) : next
    // #409：activity id→下标索引随追加补录（原位替换不改序，无需动作）。
    if (document.activities.length > context.activityIndexSize) {
      for (let index = context.activityIndexSize; index < document.activities.length; index += 1) {
        context.activityIds.set(document.activities[index]!.id, index)
      }
      context.activityIndexSize = document.activities.length
    }
  }
  const finalRanges = ranges ?? initial.appliedRanges.map(range => [range[0], range[1]] as [number, number])
  return {
    document: {
      ...document,
      appliedEventIds: Object.freeze([...appliedEventIds]),
      appliedRanges: Object.freeze(finalRanges.map(range => Object.freeze([range[0], range[1]]) as readonly [number, number])),
    },
    diagnostics: document.diagnostics,
  }
}

/**
 * #205：归约器可选上下文——批量回放路径把「按 timeline 查询」的派生索引交给归约器，
 * 免掉逐事件整条扫描。缺省（单事件 live 路径）一律回退原语义。三个索引都是
 * sequence 升序数组，由 `projectWorkbench` 按 timeline 位置增量延展。
 */
interface ProjectionContext {
  /** kind==='tool' 的条目 sequence（见 `hasToolBetween`）。 */
  readonly toolSequences: readonly number[]
  /** 文本流边界条目 sequence（见 `textStreamContinues`）。 */
  readonly textBoundarySequences: readonly number[]
  /** 终态 session 条目 sequence（见 `terminalSessionSequence`）。 */
  readonly terminalSessionSequences: readonly number[]
  /**
   * #234：**批量路径的草稿所有权**。置位时归约器可以就地把改动写进传入文档的数组
   * （`timeline` / `activities` / `diagnostics`），因为这些数组由 `projectWorkbench`
   * 独占、中间文档一律丢弃。
   *
   * 为什么需要：`updateTimeline` 是 `items.map(...)`——**每事件整表复制一次**。tool 与
   * 诊断事件每拍都会打补丁（`{streamBoundary}` / `{status,title}` / `{status,summary}`），
   * 于是「每条 tool/诊断事件复制一次整条 timeline」= Θ(N²)（实测 tool-only 12,000 事件
   * 单次折叠 2.7s、24,000 事件 19s）。live 路径不传本字段，语义与形状**一字不变**。
   */
  readonly draft?: boolean
  /**
   * #409：activity id → 数组下标。activities 只尾部追加 / 原位替换（upsert），
   * 序与位置稳定 ⇒ 索引可跨事件增量维护，归约器的 `activities.find`（每 tool/
   * activity 事件 O(A)）降为 O(1)。批量路径独占；单事件路径不传（回退线性）。
   */
  readonly activityIds: Map<string, number>
  /** #409：索引已覆盖的 activities 前缀长度（追加后由主循环补录）。 */
  activityIndexSize: number
  /** #409：是否出现过带 parentId 的活动——没有时 refreshOrphans 恒等返回，可整跳。 */
  hasParentActivities: boolean
}

function reduceSemanticEvent(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, context?: ProjectionContext): WorkbenchDocument {
  const event = envelope.event
  switch (event.type) {
    case 'message.started':
    case 'message.delta':
    case 'message.completed':
      return reduceMessage(document, envelope, event, context)
    case 'reasoning.delta':
    case 'reasoning.completed':
    case 'reasoning.redacted':
      return reduceReasoning(document, envelope, event, context)
    case 'tool.started':
    case 'tool.progress':
    case 'tool.completed':
    case 'tool.failed':
      return reduceTool(document, envelope, event, context)
    case 'activity.started':
    case 'activity.progress':
    case 'activity.completed':
    case 'activity.failed':
    case 'activity.cancelled':
      return reduceActivity(document, envelope, event, context)
    case 'interaction.requested':
    case 'interaction.resolved':
    case 'interaction.expired':
      return reduceInteraction(document, envelope, event)
    case 'usage.updated':
    case 'budget.warning':
      return reduceUsage(document, envelope, event)
    case 'plan.replaced':
    case 'plan.entry-updated':
      return reducePlan(document, envelope, event)
    case 'goal.updated':
    case 'goal.cleared':
      return reduceGoal(document, envelope, event)
    case 'lifecycle.retrying':
    case 'lifecycle.compact-started':
    case 'lifecycle.compact-completed':
    case 'lifecycle.rewind-preview':
    case 'lifecycle.rewind-completed':
    case 'lifecycle.suspended':
    case 'lifecycle.recovered':
      return reduceLifecycle(document, event)
    case 'diagnostic.updated':
    case 'diagnostic.notice':
      return reduceDiagnostic(document, envelope, event)
    case 'session.started':
    case 'session.commands-updated':
    case 'session.config-updated':
    case 'session.model-updated':
    case 'session.mode-updated':
    case 'session.status-updated':
    case 'session.title-updated':
    case 'session.completed':
      return reduceSession(document, envelope, event)
    case 'assist.prediction':
    case 'assist.file-suggestions':
    case 'assist.queued-command':
      return reduceAssist(document, envelope, event)
    case 'extension.event':
      return reduceExtension(document, envelope, event)
    case 'event.unknown':
      // #405：卡片标题给变体名（可读一行），原始载荷仍留在「事件详情」里（诊断携带 event）。
      return addDiagnostic(document, envelope, 'event.unknown', `未识别的 ${event.originalType} 事件`, 'warning', event)
    default:
      // assist.* 等未接 slice 的事件：只保留 timeline 条目，不产生副作用
      return document
  }
}

/**
 * reduceMessage / reduceReasoning 成对逻辑的共享正身（#486 项2 去重；此前约 60 行在
 * 两函数中近乎逐字重复，改一处忘另一处是经典事故源）：
 * 1. 乱序收敛——journal-earlier delta 折叠入已封存段（live 文档与 sequence 序重放一致，
 *    终态本身不复活）；
 * 2. 终态栅栏——已封存回合的迟到 delta 丢弃，除非 provider 给出显式不同身份边界。
 * 两族差异全部参数化：合并函数（display/reasoning coalesce）、tool 边界（仅 reasoning
 * 检查）、delta 判据（message 看非 terminal、reasoning 看 reasoning.delta）、栅栏是否
 * 仍要求流连续（message 要求、reasoning 不要求——保持各自原判据逐字等价）。
 * 返回 undefined = 两段决策都不适用，调用方继续自己的 append/新建逻辑。
 *
 * 互钉测试：workbenchProjectorMessageReasoningParity.test.ts 钉两族在共享决策上的
 * 同构行为——绕开本助手改动任一路径会立刻红。
 */
function foldIntoSealedSegmentOrDrop(
  document: WorkbenchDocument,
  envelope: WorkbenchEventEnvelope,
  previous: WorkbenchMessage,
  params: {
    readonly deltaOnly: boolean
    /** `textStreamContinues` 的调用方现成结果（热路径二分，勿在助手里重算）。 */
    readonly continues: boolean
    readonly blockedByToolBoundary: boolean
    readonly fenceRequiresContinues: boolean
    readonly terminalIndex?: readonly number[]
    readonly content: string
    readonly parts: readonly ContentPart[]
    readonly coalesceParts: (parts: readonly ContentPart[]) => readonly ContentPart[]
  },
): WorkbenchDocument | undefined {
  if (previous.running || params.blockedByToolBoundary) return undefined
  // Out-of-order arrival convergence: a journal-earlier text delta belongs to
  // the sealed segment (its sequence precedes the terminal that sealed it).
  // Fold it in instead of dropping it so the live document matches the
  // sequence-ordered replay; the terminal state itself (running/duration) is
  // not resurrected.
  if (params.deltaOnly && params.continues
    && envelope.sequence < Math.max(previous.sequence, terminalSessionSequence(document, params.terminalIndex))) {
    const folded: WorkbenchMessage[] = [...document.messages.slice(0, -1), freezeDeepSnapshot({
      ...previous,
      content: previous.content + params.content,
      parts: params.coalesceParts([...previous.parts, ...params.parts]),
    })]
    return { ...document, messages: folded }
  }
  // A terminal segment is an absorption fence. A late delta may only start a
  // new visible segment when the provider supplies an explicit, different
  // turn identity; otherwise it belongs to the sealed turn and is ignored.
  if (!params.deltaOnly || (params.fenceRequiresContinues && !params.continues)) return undefined
  const previousTurn = previous.identity.turnId
  const incomingTurn = envelope.identity.turnId
  const previousProvider = providerIdentityKey(previous.identity)
  const incomingProvider = providerIdentityKey(envelope.identity)
  const explicitProviderBoundary = incomingProvider !== '' && previousProvider !== '' && incomingProvider !== previousProvider
  if ((!incomingTurn || !previousTurn || incomingTurn === previousTurn) && !explicitProviderBoundary) return document
  return undefined
}

/** K03 guard 共享正身：append 落在乱序位（journal-earlier delta 追在更晚文本之后）
 * 会破坏段序——出示诊断并丢弃，等下一次 canonical refresh 重排 journal。
 * reasoning 族仅在前段仍在途时适用（requiresRunning），message 族无此前提。 */
function dropOutOfOrderAppend(
  document: WorkbenchDocument,
  envelope: WorkbenchEventEnvelope,
  previous: WorkbenchMessage | undefined,
  append: boolean,
  requiresRunning: boolean,
): WorkbenchDocument | undefined {
  if (!(append && previous && (!requiresRunning || previous.running) && envelope.sequence < previous.sequence)) return undefined
  return addOutOfOrderDiagnostic(document, envelope)
}

function reduceMessage(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: MessageEvent, context?: ProjectionContext): WorkbenchDocument {
  const role = event.role === 'reasoning' ? 'assistant' : event.role === 'user' ? 'user' : 'assistant'
  if (TERMINAL_SESSION_STATUSES.has(document.session.status.toLowerCase())) {
    // A journal-earlier event arriving after the terminal one is out-of-order
    // arrival, not a journal-late event; the sequence-ordered replay would
    // still fold it, so the live path must not fence it out.
    const journalEarlierThanFence = envelope.sequence < terminalSessionSequence(document, context?.terminalSessionSequences)
    const userTurnInProgress = role === 'user' && document.messages.at(-1)?.role === 'user' && document.messages.at(-1)?.running === true
    if (role === 'user' && (event.type === 'message.started' || event.type === 'message.delta' || (event.type === 'message.completed' && userTurnInProgress))) document = { ...document, session: { ...document.session, status: 'running', stopReason: undefined } }
    else if ((role !== 'user' || event.type === 'message.completed') && !journalEarlierThanFence) return addLateEventDiagnostic(document, envelope, 'late assistant event ignored after terminal fence')
  }
  document = settleSupersededRunningMessages(document, role)
  const parts = event.parts ?? []
  const content = textFromParts(parts)
  const previous = document.messages.at(-1)
  const terminal = event.type === 'message.completed'
  // #200：recovery-import 是 session/load 的**历史导入**（journal 空时恢复整段
  // 会话）——历史不存在「在途」语义，running 标记只属于本进程观察的 live 流。
  // 无此豁免时，导入历史没有终态行（agent 重放不带 done 帧），全部消息停在
  // running 态 → 文档派生 generating=true →「仍在等待后端响应」永久卡住并阻塞
  // 发送队列（#155 T2 重建升级日的常态场景）。
  const importedHistory = envelope.provenance.origin === 'recovery-import'
  if (terminal && content.length === 0) {
    return settleTextSegment(document, envelope, role)
  }
  // ACP providers are allowed to omit message identity. Adjacent chunks of the
  // same role still belong to one stream; some providers also rotate messageId
  // for every delta. Assistant boundaries therefore come from the canonical
  // timeline's semantic text/tool/session events, not from side-channel events
  // or per-chunk identity.
  const append = Boolean(previous && previous.role === role && textStreamContinues(document, previous, envelope, context?.textBoundarySequences) && (
    role === 'assistant'
      ? true
      : providerIdentityKey(envelope.identity) !== ''
        && providerIdentityKey(envelope.identity) === providerIdentityKey(previous.identity)
        || providerIdentityKey(envelope.identity) === '' && previous.running === true
  ))
  const incomingOptimistic = envelope.provenance.origin === 'optimistic-local'
  const duplicateIndex = role === 'user'
    ? findCorrelatedUserEcho(document.messages, envelope, content, incomingOptimistic)
    : -1
  if (duplicateIndex >= 0) {
    // Prefer the Kernel-committed row regardless of whether it arrives before
    // or after the debounced optimistic append. Replacement at the optimistic
    // position also repairs journals where assistant chunks won that race.
    if (incomingOptimistic) return document
    return {
      ...document,
      messages: document.messages.map((message, index) => index === duplicateIndex ? freezeDeepSnapshot({
        ...messageIdentityFor(envelope), role: 'user', content, parts,
        identity: envelope.identity, source: envelope.source,
        sequence: envelope.sequence, running: !terminal && !importedHistory,
        time: envelope.occurredAt ?? envelope.recordedAt,
      } as WorkbenchMessage) : message),
    }
  }
  if (!terminal && previous && previous.role === role) {
    const sealedOutcome = foldIntoSealedSegmentOrDrop(document, envelope, previous, {
      deltaOnly: true,
      continues: textStreamContinues(document, previous, envelope, context?.textBoundarySequences),
      blockedByToolBoundary: false,
      fenceRequiresContinues: true,
      terminalIndex: context?.terminalSessionSequences,
      content,
      parts,
      coalesceParts: coalesceAdjacentDisplayTextParts,
    })
    if (sealedOutcome !== undefined) return sealedOutcome
  }
  // K03 guard: appending a journal-earlier delta after later text would
  // corrupt segment order. Show it missing (with a diagnostic) until the next
  // canonical refresh re-orders the journal.
  const outOfOrder = dropOutOfOrderAppend(document, envelope, previous, append, false)
  if (outOfOrder !== undefined) return outOfOrder
  const messages = append
    ? [...document.messages.slice(0, -1), freezeDeepSnapshot({ ...previous!, content: previous!.content + content, parts: coalesceAdjacentDisplayTextParts([...previous!.parts, ...parts]), identity: Object.keys(envelope.identity).length > 0 ? envelope.identity : previous!.identity, sequence: envelope.sequence, running: !terminal && !importedHistory })]
    : [...document.messages, freezeDeepSnapshot({ ...messageIdentityFor(envelope), role: role as WorkbenchMessage['role'], content, parts: coalesceAdjacentDisplayTextParts(parts), identity: envelope.identity, source: envelope.source, sequence: envelope.sequence, running: !terminal && !importedHistory, time: envelope.occurredAt ?? envelope.recordedAt, ...(incomingOptimistic ? { optimistic: true } : {}) } as WorkbenchMessage)]
  return { ...document, messages }
}

function reduceReasoning(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: WorkbenchSemanticEvent & { type: 'reasoning.delta' | 'reasoning.completed' | 'reasoning.redacted' }, context?: ProjectionContext): WorkbenchDocument {
  if (TERMINAL_SESSION_STATUSES.has(document.session.status.toLowerCase())) {
    // Journal-earlier events are out-of-order arrivals, not journal-late ones;
    // the replay would still fold them (see reduceMessage).
    if (!(envelope.sequence < terminalSessionSequence(document, context?.terminalSessionSequences))) {
      return addLateEventDiagnostic(document, envelope, 'late reasoning event ignored after terminal fence')
    }
  }
  document = settleSupersededRunningMessages(document, 'reasoning')
  const parts = event.parts ?? []
  // C01：redacted 时正文不保留原文（D06——raw 不进入 projection），只保留安全占位。
  const redacted = event.type === 'reasoning.redacted'
  const reasoningParts = redacted ? parts : coalesceAdjacentReasoningParts(parts)
  const content = redacted ? '' : textFromParts(reasoningParts)
  if (event.type === 'reasoning.completed' && content.length === 0) {
    return settleReasoningSegment(document, envelope)
  }
  const previous = document.messages.at(-1)
  // Keep replay/live/restart projection aligned with chunkMerge: provider messageId is
  // metadata, not a reliable stream boundary (some providers rotate it per delta and on
  // completion). The canonical timeline supplies boundaries. A delta after a terminal
  // reasoning event starts a new segment, while repeated/stricter terminal events still
  // target the immediately preceding segment only when their stable identity agrees. A
  // distinct redacted segment after a completed visible segment must not erase that segment.
  const incomingProviderIdentity = providerIdentityKey(envelope.identity)
  const previousProviderIdentity = previous ? providerIdentityKey(previous.identity) : ''
  const sameTerminalIdentity = incomingProviderIdentity !== '' && incomingProviderIdentity === previousProviderIdentity
  const append = previous !== undefined
    && previous.role === 'reasoning'
    && textStreamContinues(document, previous, envelope, context?.textBoundarySequences)
    && !hasToolBetween(document, previous.sequence, envelope.sequence, context?.toolSequences)
    && (previous.running || (event.type !== 'reasoning.delta' && sameTerminalIdentity))
  // C01：terminal 是吸收态——迟到 delta/重复 completion 不得复活或改写首次终态。
  // redaction 是唯一可继续收紧的迁移：即使 completed 已到，也必须清除可见正文与历史 parts。
  if (append && previous && !previous.running) {
    if (redacted && !previous.redacted) {
      const secured: WorkbenchMessage = freezeDeepSnapshot({
        ...previous,
        content: '',
        parts,
        sequence: envelope.sequence,
        redacted: true,
        ...(event.reason !== undefined ? { redactedReason: event.reason } : {}),
      })
      return { ...document, messages: [...document.messages.slice(0, -1), secured] }
    }
    return document
  }
  const hasToolBoundary = previous !== undefined && hasToolBetween(document, previous.sequence, envelope.sequence, context?.toolSequences)
  // Out-of-order arrival convergence: fold a journal-earlier delta into the
  // sealed reasoning segment instead of dropping it (see reduceMessage). The
  // terminal state—running flag, duration, sequence—stays as sealed.
  if (event.type === 'reasoning.delta' && previous && previous.role === 'reasoning') {
    const sealedOutcome = foldIntoSealedSegmentOrDrop(document, envelope, previous, {
      deltaOnly: true,
      continues: textStreamContinues(document, previous, envelope, context?.textBoundarySequences),
      blockedByToolBoundary: hasToolBoundary,
      fenceRequiresContinues: false,
      terminalIndex: context?.terminalSessionSequences,
      content,
      parts: reasoningParts,
      coalesceParts: coalesceAdjacentReasoningParts,
    })
    if (sealedOutcome !== undefined) return sealedOutcome
  }
  // K03 guard: appending a journal-earlier delta after later reasoning text
  // would corrupt order. Show it missing (with a diagnostic) until the next
  // canonical refresh re-orders the journal.
  const outOfOrder = dropOutOfOrderAppend(document, envelope, previous, append, true)
  if (outOfOrder !== undefined) return outOfOrder
  // C01：时长 = 终态 occurredAt − 首个 delta occurredAt；append 段沿用首段时间基准。
  const terminalAt = Date.parse(envelope.occurredAt ?? envelope.recordedAt)
  const startedAt = append && previous?.thoughtStartedAtMs !== undefined
    ? previous.thoughtStartedAtMs
    : Date.parse(envelope.occurredAt ?? envelope.recordedAt)
  const durationMs = event.type === 'reasoning.delta'
    ? (append ? previous?.thoughtDurationMs : undefined)
    : Number.isFinite(terminalAt) && Number.isFinite(startedAt) ? Math.max(0, terminalAt - startedAt) : undefined
  const message: WorkbenchMessage = freezeDeepSnapshot(append
    ? {
        ...previous,
        content: redacted ? content : previous.content + content,
        parts: redacted ? parts : coalesceAdjacentReasoningParts([...previous.parts, ...reasoningParts]),
        identity: Object.keys(envelope.identity).length > 0 ? envelope.identity : previous.identity,
        sequence: envelope.sequence,
        running: event.type === 'reasoning.delta' && envelope.provenance.origin !== 'recovery-import',
        ...(durationMs !== undefined ? { thoughtDurationMs: durationMs } : {}),
        ...(redacted ? { redacted: true } : {}),
        ...(event.reason !== undefined ? { redactedReason: event.reason } : {}),
      }
    : {
        ...messageIdentityFor(envelope),
        role: 'reasoning',
        content,
        parts: reasoningParts,
        identity: envelope.identity,
        source: envelope.source,
        sequence: envelope.sequence,
        running: event.type === 'reasoning.delta' && envelope.provenance.origin !== 'recovery-import',
        time: envelope.occurredAt ?? envelope.recordedAt,
        ...(durationMs !== undefined ? { thoughtDurationMs: durationMs } : { thoughtStartedAtMs: Number.isFinite(startedAt) ? startedAt : undefined }),
        ...(redacted ? { redacted: true } : {}),
        ...(event.reason !== undefined ? { redactedReason: event.reason } : {}),
      })
  return { ...document, messages: append ? [...document.messages.slice(0, -1), message] : [...document.messages, message] }
}

function reduceTool(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: ToolEvent, context?: ProjectionContext): WorkbenchDocument {
  if (TERMINAL_SESSION_STATUSES.has(document.session.status.toLowerCase())) {
    return addLateEventDiagnostic(document, envelope, 'late tool event ignored after terminal fence')
  }
  const tool = isRecord(event.tool) ? event.tool : {}
  const id = stringValue(tool.toolCallId) || envelope.identity.toolCallId || envelope.eventId
  const status = toolLifecycleStatus(event.type, stringValue(tool.status) || 'progress')
  const normalizedToolError = tool.error !== undefined ? normalizeNormalizedError(tool.error) : undefined
  // C04 DIC-C04-01/架构补全：canonical 字段自 normalized payload 收窄进 activity node，
  // renderer 经 toolInvocationSnapshot 消费，不再读 provider raw。
  // #409：O(A) find → 索引 O(1)（批量路径）；单事件路径回退线性。
  const previous = previousActivityOf(document, id, 'tool', context)
  if (!previous) {
    document = settleSupersededRunningMessages(document)
    document = { ...document, timeline: updateTimeline(document.timeline, envelope.eventId, { streamBoundary: true }, context?.draft === true) }
  }
  const node: WorkbenchActivityNode = {
    // C04/DIC：node.title 是工具身份（machine name，_meta.pylon.toolName 优先）；
    // 本地化 title 只进 snapshot.title 供显示，不作为身份。
    id, kind: 'tool', title: stringValue(tool.name) || previous?.title || (stringValue(tool.name) || undefined), status,
    ...(stringValue(tool.semanticKind) ? { semanticKind: stringValue(tool.semanticKind) } : previous?.semanticKind ? { semanticKind: previous.semanticKind } : {}),
    ...(stringValue(tool.parentToolUseId) ? { parentToolCallId: stringValue(tool.parentToolUseId) } : previous?.parentToolCallId ? { parentToolCallId: previous.parentToolCallId } : {}),
    ...(stringValue(tool.parentActivityId) ? { parentId: stringValue(tool.parentActivityId) } : previous?.parentId ? { parentId: previous.parentId } : {}),
    ...(stringValue(tool.canonicalName) ? { canonicalName: stringValue(tool.canonicalName) } : previous?.canonicalName ? { canonicalName: previous.canonicalName } : {}),
    ...(stringValue(tool.kind) ? { toolKindWire: stringValue(tool.kind) } : previous?.toolKindWire ? { toolKindWire: previous.toolKindWire } : {}),
    ...(stringValue(tool.title) ? { displayName: stringValue(tool.title) } : previous?.displayName ? { displayName: previous.displayName } : {}),
    ...(tool.input !== undefined ? { input: freezeDeepSnapshot(tool.input) } : {}),
    ...(Array.isArray(tool.locations) ? { locations: freezeDeepSnapshot(tool.locations) } : {}),
    ...(tool.progress !== undefined ? { progress: freezeDeepSnapshot(tool.progress) } : {}),
    ...(stringValue(tool.action) ? { action: stringValue(tool.action) } : {}),
    ...(Array.isArray(tool.capabilities) ? { capabilities: freezeDeepSnapshot(tool.capabilities) } : {}),
    ...(Number.isFinite(Number(tool.durationMs)) ? { durationMs: Number(tool.durationMs) } : {}),
    ...(normalizedToolError ? { error: normalizedToolError } : {}),
    ...(Array.isArray(tool.parts) ? { parts: freezeDeepSnapshot(tool.parts) } : {}),
    ...(tool.rawOutput !== undefined ? { rawOutput: freezeDeepSnapshot(tool.rawOutput) } : {}),
    ...(stringValue(tool.providerName) ? { providerName: stringValue(tool.providerName) }
      : stringValue(tool.name) ? { providerName: stringValue(tool.name) }
        : previous?.providerName ? { providerName: previous.providerName } : {}),
    ...(tool.rawInput !== undefined ? { rawInput: freezeDeepSnapshot(tool.rawInput) } : previous?.rawInput !== undefined ? { rawInput: previous.rawInput } : {}),
    orphan: false,
    // C04 终态幂等：终态一旦写入，迟到的 progress 不回退状态
    // Activity placement is a creation-time fact. Progress/completion updates
    // must not move an existing card to the bottom of the conversation.
    data: event, sequence: previous?.sequence ?? envelope.sequence,
  }
  const merged = mergeToolActivity(previous, node)
  const activities = upsertActivity(document.activities, merged ?? node, context)
  const timeline = updateTimeline(document.timeline, envelope.eventId, { status: merged?.status ?? status, title: merged?.title ?? node.title }, context?.draft === true)
  return { ...document, activities, timeline }
}

/** 工具生命周期状态机：started→running、progress 保持、终态幂等。 */
function toolLifecycleStatus(eventType: string, payloadStatus: string): string {
  if (eventType === 'tool.started') return 'running'
  if (eventType === 'tool.failed') return 'failed'
  if (eventType === 'tool.completed') return 'completed'
  if (eventType === 'tool.cancelled') return 'cancelled'
  return payloadStatus || 'progress'
}

/**
 * C04 终态幂等合并：previous 已是终态时，迟到事件只补充字段不回退状态
 * （failed 不伪装 completed，progress 不复活已结束的调用）。
 */
function mergeToolActivity(previous: WorkbenchActivityNode | undefined, next: WorkbenchActivityNode): WorkbenchActivityNode | null {
  if (!previous) return null
  const previousTerminal = TERMINAL_TOOL_STATUSES.has(previous.status)
  if (previousTerminal) {
    // 首个终态吸收所有迟到事件；仅补齐此前缺失的 identity/evidence，
    // 不允许 completed/failed 互相改写，也不让 progress 复活。
    const filled: WorkbenchActivityNode = { ...previous }
    for (const key of [
      'semanticKind', 'title', 'parentId', 'canonicalName', 'input', 'locations', 'progress',
      'action', 'capabilities', 'parentToolCallId', 'durationMs', 'error', 'parts', 'rawOutput',
      'providerName', 'rawInput', 'toolKindWire', 'displayName',
    ] as const) {
      const value = next[key]
      if (value !== undefined && filled[key] === undefined) {
        // SAFETY: key 取自 next（与 filled 同形），value 即 next[key]；此处仅绕过增量构造期的索引签名。
        (filled as unknown as Record<string, unknown>)[key] = value
      }
    }
    return filled
  }
  return next
}

function reduceActivity(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: ActivityEvent, context?: ProjectionContext): WorkbenchDocument {
  if (TERMINAL_SESSION_STATUSES.has(document.session.status.toLowerCase())) {
    return addLateEventDiagnostic(document, envelope, 'late activity event ignored after terminal fence')
  }
  const id = event.activityId || envelope.identity.taskId || envelope.eventId
  const activity = isRecord(event.activity) ? event.activity : {}
  const patch = isRecord(event.patch) ? event.patch : {}
  const result = isRecord(event.result) ? event.result : undefined
  const previous = previousActivityOf(document, id, 'activity', context)
  const status = activityLifecycleStatus(event.type, patch, previous)
  const activityKind = stringValue(activity.kind) ?? stringValue(patch.kind) ?? previous?.activityKind
  const semanticKind = stringValue(activity.semanticKind) ?? stringValue(patch.semanticKind) ?? previous?.semanticKind
    ?? (activityKind === 'process' || activityKind === 'background-task'
      // C09：子代理/委派/团队家族同样从 wire family 派生渲染语义
      || activityKind === 'subagent' || activityKind === 'delegation' || activityKind === 'team'
      // C10：后台任务与工作流家族（workflow-phase/agent 经 parentId relation 挂接）
      || activityKind === 'workflow' || activityKind === 'workflow-phase' || activityKind === 'workflow-agent'
      ? `activity.${activityKind}` : undefined)
  const sourceParts = result?.output ?? result?.parts ?? patch.output ?? patch.parts ?? activity.output ?? activity.parts
  const isC09Activity = activityKind === 'subagent' || activityKind === 'delegation' || activityKind === 'team'
  const isC10Activity = activityKind === 'background-task' || activityKind === 'workflow'
    || activityKind === 'workflow-phase' || activityKind === 'workflow-agent'
  const typedPartsFamily = activityKind === 'process' || isC10Activity || isC09Activity
  const strictParts = typedPartsFamily || semanticKind === 'activity.process'
    ? narrowActivityParts(sourceParts, id, envelope, activityKind ?? semanticKind?.replace(/^activity\./, '') ?? 'activity')
    : undefined
  const narrowedParts = strictParts ?? { parts: sourceParts === undefined ? undefined : freezeDeepSnapshot(sourceParts), diagnostics: [] }
  const parts = narrowedParts.parts ?? previous?.parts
  const output = isC09Activity || isC10Activity ? strictParts?.parts ?? previous?.output : previous?.output
  const error = event.error !== undefined
    ? normalizeNormalizedError(event.error)
    : result?.error !== undefined
      ? normalizeNormalizedError(result.error)
      : patch.error !== undefined
        ? normalizeNormalizedError(patch.error)
        : previous?.error
  const killed = typeof patch.killed === 'boolean' ? patch.killed : previous?.killed
  const timeout = typeof patch.timeout === 'boolean' ? patch.timeout : previous?.timeout
  const next: WorkbenchActivityNode = {
    id,
    kind: 'activity',
    status,
    orphan: false,
    // Keep the first observed position stable across lifecycle patches.
    sequence: previous?.sequence ?? envelope.sequence,
    ...(semanticKind ? { semanticKind } : {}),
    ...(activityKind ? { activityKind } : {}),
    ...(stringValue(activity.title) ?? stringValue(activity.name) ?? stringValue(patch.title) ?? previous?.title
      ? { title: stringValue(activity.title) ?? stringValue(activity.name) ?? stringValue(patch.title) ?? previous?.title }
      : {}),
    ...(stringValue(activity.parentId) ?? stringValue(patch.parentId) ?? previous?.parentId
      ? { parentId: stringValue(activity.parentId) ?? stringValue(patch.parentId) ?? previous?.parentId }
      : {}),
    ...(stringValue(activity.processId) ?? stringValue(patch.processId) ?? previous?.processId
      ? { processId: stringValue(activity.processId) ?? stringValue(patch.processId) ?? previous?.processId }
      : {}),
    ...(stringValue(activity.sessionId) ?? stringValue(patch.sessionId) ?? previous?.sessionId
      ? { sessionId: stringValue(activity.sessionId) ?? stringValue(patch.sessionId) ?? previous?.sessionId }
      : {}),
    ...(patch.progress !== undefined ? { progress: freezeDeepSnapshot(patch.progress) } : previous?.progress !== undefined ? { progress: previous.progress } : {}),
    ...(parts !== undefined ? { parts } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(event.result !== undefined
      ? { result: freezeDeepSnapshot(event.result) }
      : patch.result !== undefined
        ? { result: freezeDeepSnapshot(patch.result) }
        : previous?.result !== undefined ? { result: previous.result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(killed !== undefined ? { killed } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(stringValue(event.reason) ?? previous?.reason ? { reason: stringValue(event.reason) ?? previous?.reason } : {}),
    // C09：子代理/委派/团队 rich 字段——跨事件累积（当前缺失保留前值），缺失稳定降级为 undefined
    ...c09RichFields(activity, patch, result, previous),
    provenance: envelope.provenance,
  }
  const merged = mergeActivityTerminal(previous, next)
  const projected = { ...document, activities: upsertActivity(document.activities, merged ?? next, context) }
  return narrowedParts.diagnostics.length > 0
    ? { ...projected, diagnostics: [...projected.diagnostics, ...narrowedParts.diagnostics] }
    : projected
}

function reduceExtension(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: ExtensionEvent): WorkbenchDocument {
  const extension: WorkbenchExtensionNode = {
    id: envelope.eventId,
    kind: event.kind,
    payload: freezeDeepSnapshot(event.payload) as ExtensionEvent['payload'],
    fallback: event.fallback.map(part => freezeDeepSnapshot(part) as ContentPart),
    identity: { ...envelope.identity },
    source: { ...envelope.source },
    provenance: { ...envelope.provenance },
    sequence: envelope.sequence,
    time: envelope.occurredAt ?? envelope.recordedAt,
  }
  return { ...document, extensions: insertBySequence(document.extensions, extension) }
}

/** Provider-neutral activity lifecycle: progress is an update, not a state. */
function activityLifecycleStatus(
  eventType: ActivityEvent['type'],
  patch: Record<string, unknown>,
  previous: WorkbenchActivityNode | undefined,
): string {
  if (eventType === 'activity.started') return 'running'
  if (eventType === 'activity.progress') {
    const patchStatus = stringValue(patch.status)
    if (patchStatus !== undefined) return isActivityStatus(patchStatus) ? patchStatus : 'unknown'
    return previous?.status ?? 'running'
  }
  return eventType.replace('activity.', '')
}

function narrowActivityParts(
  value: unknown,
  activityId: string,
  envelope: WorkbenchEventEnvelope,
  activityFamily: string,
): { parts?: readonly ContentPart[]; diagnostics: readonly WorkbenchProjectionDiagnostic[] } {
  if (value === undefined) return { diagnostics: [] }
  const sourceParts = Array.isArray(value) ? value : [value]
  const parts: ContentPart[] = []
  const diagnostics: WorkbenchProjectionDiagnostic[] = []
  sourceParts.forEach((part, partIndex) => {
    const parsed = parseContentPart(part)
    if (parsed.ok) {
      parts.push(parsed.value)
      return
    }
    const originalType = isRecord(part) && typeof part.kind === 'string' ? part.kind : 'malformed'
    parts.push(createUnknownContentPart(originalType, part))
    diagnostics.push({
      code: `activity.${activityFamily}.part-malformed`,
      message: `${activityFamily} activity part ${partIndex} failed content schema validation`,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      level: 'warning',
      data: { activityId, partIndex, issues: parsed.issues },
    })
  })
  return { parts: coalesceAdjacentDisplayTextParts(parts), diagnostics }
}

/** C09：子代理/委派/团队 rich 字段收窄——只认 normalized activity/patch，缺失即 undefined（不猜）。 */
function c09RichFields(
  activity: Record<string, unknown>,
  patch: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  previous: WorkbenchActivityNode | undefined,
): Partial<WorkbenchActivityNode> {
  const pickString = (key: string): string | undefined =>
    stringValue(activity[key]) ?? stringValue(patch[key]) ?? stringValue(result?.[key])
    ?? previous?.[key as keyof WorkbenchActivityNode] as string | undefined
  const pickNumber = (key: string): number | undefined => {
    const value = activity[key] ?? patch[key]
    return (typeof value === 'number' && Number.isFinite(value)) ? value : undefined
  }
  const pickValue = (key: string): unknown | undefined =>
    freezeJsonValue(activity[key] ?? patch[key] ?? result?.[key])
    ?? (previous?.[key as keyof WorkbenchActivityNode] as unknown | undefined)
  const fields: Partial<Record<keyof WorkbenchActivityNode, unknown>> = {
    sourceAgentId: pickString('sourceAgentId'),
    description: pickString('description'),
    startedAt: pickString('startedAt'),
    completedAt: pickString('completedAt'),
    depth: pickNumber('depth'),
    role: pickString('role'),
    model: pickString('model'),
    provider: pickString('provider'),
    goal: pickString('goal'),
    usage: pickValue('usage'),
    metrics: pickValue('metrics'),
    capabilities: pickValue('capabilities'),
    files: pickValue('files'),
    execution: pickValue('execution'),
    tools: pickValue('tools'),
    tasks: pickValue('tasks'),
    metadata: pickValue('metadata'),
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value
  }
  // SAFETY: out 只拷贝 next 中已存在的字段，故只可能携带该节点的合法键。
  return out as unknown as Partial<WorkbenchActivityNode>
}


/** C09 活动终态幂等：与 mergeToolActivity 同构——终态后迟到事件仅补缺字段，不回退状态。 */
const ACTIVITY_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed', 'failed', 'interrupted', 'cancelled', 'timeout',
])

function mergeActivityTerminal(previous: WorkbenchActivityNode | undefined, next: WorkbenchActivityNode): WorkbenchActivityNode | null {
  if (!previous || !ACTIVITY_TERMINAL_STATUSES.has(previous.status)) return null
  const filled: Record<string, unknown> = { ...previous }
  // 终态保护即"仅补缺字段"：已存在字段（含 status 与首个终态时刻的 progress 快照）
  // 不被迟到事件覆盖——覆盖逻辑只存在于 filled[key] === undefined 分支。
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue
    if (filled[key] !== undefined) continue
    filled[key] = value
  }
  filled.orphan = next.orphan && Boolean(previous.parentId)
  // SAFETY: filled 由 previous 起、经逐字段补齐后必含该节点的全部必需字段。
  return filled as unknown as WorkbenchActivityNode
}

function reduceUsage(document: WorkbenchDocument, _envelope: WorkbenchEventEnvelope, event: UsageEvent): WorkbenchDocument {
  if (event.type === 'budget.warning') {
    const budget = normalizeBudgetSnapshot(event, document.session.usage?.budget)
    return { ...document, session: { ...document.session, usage: { ...document.session.usage, budget } } }
  }
  const normalized = normalizeUsageSnapshot(event.usage, document.session.usage)
  const next = { ...document, session: { ...document.session, usage: normalized.value } }
  return normalized.invalidFields.reduce<WorkbenchDocument>((current, field) => addDiagnostic(current, _envelope,
    'session.usage.invalid-field', `usage field ${field} is invalid; retained in raw`, 'warning', event.usage), next)
}

/** C08：plan 事件经 domain reducer 收敛进 document.plan；malformed entries 转可见诊断。 */
function reducePlan(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: PlanEvent): WorkbenchDocument {
  if (event.type === 'plan.replaced' && event.entries !== undefined && !Array.isArray(event.entries)) {
    return addDiagnostic(document, envelope, 'plan.malformed', 'plan.replaced entries is not an array; plan unchanged', 'warning', event.entries)
  }
  if (event.type === 'plan.entry-updated' && event.entry !== undefined && (typeof event.entry !== 'object' || event.entry === null || Array.isArray(event.entry))) {
    return addDiagnostic(document, envelope, 'plan.malformed', 'plan.entry-updated entry is not an object; plan unchanged', 'warning', event.entry)
  }
  const next = applyPlanEvent(document.plan, event)
  if (next === document.plan) return document
  return { ...document, plan: next }
}

function reduceGoal(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: GoalEvent): WorkbenchDocument {
  if (event.type === 'goal.updated' && event.goal !== undefined && normalizeGoalSnapshot(event.goal) === undefined) {
    return addDiagnostic(document, envelope, 'goal.malformed', 'goal.updated payload is not an object; goal unchanged', 'warning', event.goal)
  }
  const next = applyGoalEvents(document.goal, event)
  if (next === document.goal) return document
  return { ...document, goal: next }
}

function reduceSession(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: SessionEvent): WorkbenchDocument {
  const completedAt = Date.parse(envelope.occurredAt ?? envelope.recordedAt)
  const previousStatus = document.session.status
  const requestedStatus = event.type === 'session.completed' ? 'completed' : event.status
  const requestedLower = requestedStatus?.toLowerCase()
  const previousLower = previousStatus.toLowerCase()
  const terminalRegression = TERMINAL_SESSION_STATUSES.has(previousLower)
    && requestedLower !== undefined && requestedLower !== previousLower
  const nextStatus = requestedStatus && SESSION_LIFECYCLE_STATUSES.has(requestedLower ?? '')
    && !terminalRegression
    ? requestedStatus
    : previousStatus
  const settlesMessages = TERMINAL_SESSION_STATUSES.has(nextStatus.toLowerCase())
  return {
    ...document,
    ...(settlesMessages ? {
      messages: document.messages.map(message => message.running ? freezeDeepSnapshot({
        ...message,
        running: false,
        ...(message.role === 'reasoning' && message.thoughtStartedAtMs !== undefined && Number.isFinite(completedAt)
          ? { thoughtDurationMs: Math.max(0, completedAt - message.thoughtStartedAtMs) }
          : {}),
      }) : message),
      // #389：fence 的对称收敛——reduceTool 已拒绝终局后的一切迟到工具事件，
      // 非终态工具不再可能等到翻转（hermes 的 read/patch 只发 tool_call、从不发
      // tool_call_update，指示器因此永久停在「运行中」）。与消息 running 收敛同拍，
      // 按回合结局定投向：正常完成 → completed；中断类终局 → cancelled。
      activities: settleUnsettledTools(
        document.activities,
        nextStatus.toLowerCase() === 'completed' ? 'completed' : 'cancelled',
      ),
    } : {}),
    session: {
      ...document.session,
      status: nextStatus,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      ...(event.model ? { model: event.model } : {}),
      ...(event.mode ? { mode: event.mode } : {}),
      // ACP `SessionInfoUpdate.title`：Agent 明确清空（null）时必须**删掉**这个键，
      // 否则界面上的标题会一直挂着 Agent 已收回的名字。带值则覆盖。
      ...(event.type === 'session.title-updated'
        ? (event.title ? { title: event.title } : { title: undefined })
        : {}),
      ...(event.commands ? { commands: normalizeSessionCommands(event.commands) } : {}),
      // An empty list advertises nothing, so it must not wipe the surface the
      // selectors read: this line replaces the whole list rather than merging into
      // it, and every other producer already guards on length before emitting
      // (see createSessionResponseEnvelope). A local synthetic write used to slip
      // through here and drop the provider's catalogue.
      ...(event.options && event.options.length > 0 ? { options: normalizeSessionConfigOptions(event.options) } : {}),
      ...(event.usage !== undefined ? { usage: normalizeUsageSnapshot(event.usage, document.session.usage).value } : {}),
    },
  }
}

/**
 * #389：终局 fence 收敛在途工具活动。只动 kind === 'tool'——activity.*
 * （process/后台任务/子代理/工作流）有自己的生命周期事件，可合法跨回合。
 * 已终态节点不动（终态幂等）；无可收敛节点时保持原引用，避免无谓的文档替换。
 */
function settleUnsettledTools(
  activities: readonly WorkbenchActivityNode[],
  target: 'completed' | 'cancelled',
): readonly WorkbenchActivityNode[] {
  if (!activities.some(node => node.kind === 'tool' && !TERMINAL_TOOL_STATUSES.has(node.status))) return activities
  return activities.map(node => node.kind === 'tool' && !TERMINAL_TOOL_STATUSES.has(node.status)
    ? { ...node, status: target }
    : node)
}

function reduceAssist(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: AssistEvent): WorkbenchDocument {
  if (event.type === 'assist.prediction') {
    // #394：预测是**一次性实例**——带 eventId 才可被接受/拒绝消费（renderer 侧按 eventId 写
    // 消费标记，幽灵与卡片同时收敛；新预测带新 eventId 自然重现）。
    return { ...document, assist: { ...document.assist, prediction: {
      ...(event.placeholder ? { placeholder: event.placeholder } : {}),
      actions: Object.freeze([...(event.actions ?? [])]),
      eventId: envelope.eventId,
    } } }
  }
  if (event.type === 'assist.file-suggestions') {
    return { ...document, assist: { ...document.assist, files: Object.freeze([...(event.files ?? [])]) } }
  }
  return { ...document, assist: { ...document.assist, ...(event.command ? { queuedCommand: event.command } : {}) } }
}

/** C13：lifecycle 事件经 domain reducer 收敛；恢复成功不删除历史事实。 */
function reduceLifecycle(document: WorkbenchDocument, event: LifecycleEvent): WorkbenchDocument {
  const next = applyLifecycleEvent(document.lifecycle, event)
  if (next === document.lifecycle) return document
  return { ...document, lifecycle: next }
}

/**
 * C13：diagnostic 事件收敛。
 * - error 级 notice 进 systemErrors（结构化 NormalizedError），与 info/warning 分离；
 * - 全部 notice 仍进 diagnostics 时间线（历史事实不删）；
 * - turn.failed/provider.error 保持 A04 语义：收敛 running 消息并置 error 状态。
 */
function reduceDiagnostic(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: DiagnosticEvent): WorkbenchDocument {
  const level = event.level ?? 'info'
  const message = event.message ?? 'diagnostic event'
  const code = event.code ?? 'diagnostic.notice'
  const withError = level === 'error' && code !== 'turn.failed' && code !== 'provider.error'
    ? (() => {
        const normalized = normalizeNormalizedError({ userSummary: message, technicalMessage: message, code, sessionId: envelope.sessionId, eventId: envelope.eventId, recoverability: 'retry' })
        return normalized ? { ...document, systemErrors: [...document.systemErrors, normalized] } : document
      })()
    : document
  return addDiagnostic(withError, envelope, code, message, level, event)
}

// #204③：orphan 判据的 id 集合按 activities 数组引用缓存——delta 帧不改 activities，
// 引用跨帧稳定 ⇒ 单事件路径 O(1) 命中，免每帧重建 Set（与批量路径按数组同一性
// 缓存的短路同构；数组被替换（增删/更新节点）时必然 miss 并重建）。
const orphanActivityIdsMemo = new WeakMap<readonly WorkbenchActivityNode[], ReadonlySet<string>>()

function orphanActivityIdsOf(activities: readonly WorkbenchActivityNode[]): ReadonlySet<string> {
  const cached = orphanActivityIdsMemo.get(activities)
  if (cached) return cached
  const ids = new Set(activities.map(activity => activity.id))
  orphanActivityIdsMemo.set(activities, ids)
  return ids
}

function refreshOrphans(document: WorkbenchDocument, providedIds?: ReadonlySet<string>): WorkbenchDocument {
  // P57 S2-R1a：仅当某个带 parentId 的 activity 的 orphan 值实际变化时才克隆该节点；
  // 没有任何变化时恒等返回输入 document。此前每个带 parentId 的节点无条件克隆，
  // 恒产生新 activities 数组，放大了 freezeDeepSnapshot 每事件的全量深拷贝。
  // #205：调用方已知 id 集合（如批量路径按 activities 数组同一性缓存）时可免重建。
  //
  // #234：**先探测、后分配**。原实现每事件都 `activities.map(...)` 一次——即使一个 orphan
  // 都没改，也先分配一条与 activities 等长的新数组再丢掉。CPU profile 显示这条 map 占
  // tool 密集折叠 21.8% 的 CPU。探测循环只读一个字段、不分配，代价远低于分配+写入。
  const ids = providedIds ?? orphanActivityIdsOf(document.activities)
  let needsWork = false
  for (const activity of document.activities) {
    if (activity.parentId === undefined) continue
    if (activity.orphan !== !ids.has(activity.parentId)) { needsWork = true; break }
  }
  if (!needsWork) return document
  const activities = document.activities.map(activity => {
    if (!activity.parentId) return activity
    const orphan = !ids.has(activity.parentId)
    if (activity.orphan === orphan) return activity
    return freezeDeepSnapshot({ ...activity, orphan })
  })
  // 走到这里说明探测已命中至少一个 orphan 变化 ⇒ 新数组必然与输入不同，无需再记 changed。
  return { ...document, activities }
}

function insertBySequence<T extends { sequence: number }>(items: readonly T[], item: T): T[] {
  const last = items.at(-1)
  if (!last || last.sequence <= item.sequence) {
    const next = [...items, item]
    Object.freeze(item)
    return next
  }
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (items[middle]!.sequence <= item.sequence) low = middle + 1
    else high = middle
  }
  // #551：中间插入改为「一次拷贝 + splice 块移动」——原写法切两段再展开 = 3 次分配。
  // 上方的追加快路径（`[...items, item]`）已是最省形态，不动。
  const next = items.slice()
  next.splice(low, 0, item)
  Object.freeze(item)
  return next
}

function addLateEventDiagnostic(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, message: string): WorkbenchDocument {
  if (document.diagnostics.some(item => item.code === 'late-event-after-terminal')) return document
  return addDiagnostic(document, envelope, 'late-event-after-terminal', message, 'warning')
}

const terminalSequenceByTimeline = new WeakMap<readonly WorkbenchTimelineEntry[], number>()

/**
 * Sequence of the timeline entry that drove the session into a terminal
 * status. Events with a smaller sequence that arrive afterwards are
 * out-of-order arrivals of journal-earlier facts, not journal-late events;
 * the sequence-ordered replay still folds them.
 */
function terminalSessionSequence(document: WorkbenchDocument, index?: readonly number[]): number {
  // #205：批量路径把终态 session 条目 sequence 也建成升序索引，取末位即最大值。
  if (index) return index.length > 0 ? index[index.length - 1]! : Number.NEGATIVE_INFINITY
  // #551：单事件路径拿不到索引，改查 timeline 级记忆——命中即 O(1)，未命中回落扫描并写回。
  // 键取 timeline 数组引用：timeline 只在插入点被替换，`{...document}` 全程保持同一引用，
  // 而 document 本身会在 reduceSemanticEvent / refreshOrphans 里被重建多次。
  const memo = terminalSequenceByTimeline.get(document.timeline)
  if (memo !== undefined) return memo
  let latest = Number.NEGATIVE_INFINITY
  for (const entry of document.timeline) {
    if (isTerminalSessionEntry(entry)) latest = Math.max(latest, entry.sequence)
  }
  terminalSequenceByTimeline.set(document.timeline, latest)
  return latest
}

function addOutOfOrderDiagnostic(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope): WorkbenchDocument {
  if (document.diagnostics.some(item => item.code === 'out-of-order-text-dropped')) return document
  return addDiagnostic(document, envelope, 'out-of-order-text-dropped',
    'journal-earlier text delta arrived after later text; dropped until the next canonical refresh re-orders', 'warning',
    { sequence: envelope.sequence })
}

/**
 * #409：按 id 找已有 activity 节点。批量路径走 context 索引 O(1)；单事件路径（无
 * context）保留线性扫描，语义与改造前逐字一致。索引命中但 kind 不符 = 该 id 的
 * 节点存在但不是目标 kind（id 在数组内唯一）⇒ 直接不存在，不再扫描。
 */
function previousActivityOf(
  document: WorkbenchDocument,
  id: string,
  kind: 'tool' | 'activity',
  context?: ProjectionContext,
): WorkbenchActivityNode | undefined {
  const index = context?.activityIds.get(id)
  if (index !== undefined) {
    const candidate = document.activities[index]
    return candidate !== undefined && candidate.id === id && candidate.kind === kind ? candidate : undefined
  }
  return document.activities.find(node => node.id === id && node.kind === kind)
}

/**
 * #409：upsert 接批量路径 context——索引 O(1) 定位 + draft 就地写（替换与追加都不再
 * 整表复制）。原位语义与 #234 的 updateTimeline draft 同据：批内中间数组独占，就地写
 * 只动本轮独占的数组；对外形状（不可变 readonly 数组）不变，单事件路径逐字保留原实现。
 * 就地引入 parentId 时置位 context.hasParentActivities（孤儿刷新的跳过门）。
 */
function upsertActivity(items: readonly WorkbenchActivityNode[], next: WorkbenchActivityNode, context?: ProjectionContext): readonly WorkbenchActivityNode[] {
  if (context && next.parentId !== undefined) context.hasParentActivities = true
  const inPlace = context?.draft === true && !Object.isFrozen(items)
  const replaceAt = (index: number): readonly WorkbenchActivityNode[] => {
    const existing = items[index]!
    const merged: WorkbenchActivityNode = { ...existing, ...next, parentId: next.parentId ?? existing.parentId }
    if (inPlace) {
      // SAFETY: inPlace 已确认数组未冻结且批内独占；readonly 是公共形状契约，非运行时约束。
      ;(items as unknown as WorkbenchActivityNode[])[index] = merged
      return items
    }
    return items.map((item, itemIndex) => itemIndex === index ? merged : item)
  }
  const indexed = context?.activityIds.get(next.id)
  if (indexed !== undefined) {
    // 索引命中即定位置换（下标由主循环保证与 id 同步；id 冲突不存在——upsert 按 id 唯一）
    return replaceAt(indexed)
  }
  const index = items.findIndex(item => item.id === next.id)
  if (index < 0) {
    if (inPlace) {
      // SAFETY: 同上——批内独占的未冻结数组，追加就地发生。
      ;(items as unknown as WorkbenchActivityNode[]).push(next)
      return items
    }
    return [...items, next]
  }
  return replaceAt(index)
}

function textFromParts(parts: readonly ContentPart[]): string {
  return parts.map(part => 'text' in part && typeof part.text === 'string' ? part.text : part.kind === 'unknown' ? part.summary : '').join('')
}

function providerIdentityKey(identity: WorkbenchEventEnvelope['identity']): string {
  return identity.messageId || identity.turnId || identity.toolCallId || identity.taskId || identity.interactionId || ''
}

function settleSupersededRunningMessages(
  document: WorkbenchDocument,
  continuingRole?: WorkbenchMessage['role'],
): WorkbenchDocument {
  if (!document.messages.some(message => message.running && message.role !== continuingRole)) return document
  return {
    ...document,
    messages: document.messages.map(message => message.running && message.role !== continuingRole
      ? freezeDeepSnapshot({ ...message, running: false })
      : message),
  }
}

function messageIdentityFor(envelope: WorkbenchEventEnvelope): Pick<WorkbenchMessage, 'id' | 'segmentId'> {
  const segmentId = envelope.eventId
  return { id: `${envelope.sessionId}:${segmentId}`, segmentId }
}

function textStreamContinues(
  document: WorkbenchDocument,
  previous: WorkbenchMessage,
  envelope: WorkbenchEventEnvelope,
  boundaryIndex?: readonly number[],
): boolean {
  // #205：journal 里每一条 message/reasoning 条目本身就是文本流边界（见
  // `isTextStreamBoundary`），逐事件整条扫描把重放压成 Θ(N²)；批量路径改走
  // 升序边界索引 + 二分，语义等价（无索引时回退二分区间扫描，live 路径语义不变）。
  if (boundaryIndex) return !hasIndexedSequenceBetween(boundaryIndex, previous.sequence, envelope.sequence)
  return !timelineHasBetween(document.timeline, previous.sequence, envelope.sequence, isTextStreamBoundary)
}

function isTextStreamBoundary(entry: WorkbenchTimelineEntry): boolean {
  return entry.kind === 'message'
    || entry.kind === 'reasoning'
    || (entry.kind === 'tool' && entry.streamBoundary === true)
    || entry.kind === 'session'
    || entry.kind === 'interaction'
}

function settleTextSegment(
  document: WorkbenchDocument,
  envelope: WorkbenchEventEnvelope,
  role: WorkbenchMessage['role'],
): WorkbenchDocument {
  let index = findTerminalTargetIndex(document.messages, envelope.identity, role)
  // An out-of-order (journal-earlier) terminal may target a segment the
  // session fence already settled; fall back to the last role row so the
  // resequence converges with the replay.
  if (index < 0 && envelope.sequence < terminalSessionSequence(document)) {
    index = findLastMessageIndex(document.messages, message => message.role === role)
  }
  if (index < 0) return document
  const target = document.messages[index]!
  if (!target.running) return document
  return {
    ...document,
    messages: document.messages.map((message, messageIndex) => messageIndex === index
      ? freezeDeepSnapshot({ ...message, running: false, sequence: envelope.sequence })
      : message),
  }
}

function settleReasoningSegment(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope): WorkbenchDocument {
  let index = findTerminalTargetIndex(document.messages, envelope.identity, 'reasoning')
  const journalEarlierTerminal = envelope.sequence < terminalSessionSequence(document)
  if (index < 0 && journalEarlierTerminal) {
    index = findLastMessageIndex(document.messages, message => message.role === 'reasoning')
  }
  if (index < 0) return document
  const target = document.messages[index]!
  const terminalAt = Date.parse(envelope.occurredAt ?? envelope.recordedAt)
  const startedAt = target.thoughtStartedAtMs ?? Date.parse(target.time)
  const durationMs = Number.isFinite(terminalAt) && Number.isFinite(startedAt)
    ? Math.max(0, terminalAt - startedAt)
    : undefined
  // A journal-earlier terminal is the authoritative first terminal for this
  // segment in replay order: recompute the settled state it may have been
  // sealed with by an out-of-order session fence.
  if (!target.running && !journalEarlierTerminal && (target.thoughtDurationMs !== undefined || durationMs === undefined)) return document
  return {
    ...document,
    messages: document.messages.map((message, messageIndex) => messageIndex === index
      ? freezeDeepSnapshot({
          ...message,
          running: false,
          sequence: envelope.sequence,
          ...(durationMs !== undefined ? { thoughtDurationMs: durationMs } : {}),
        })
      : message),
  }
}

function findTerminalTargetIndex(
  messages: readonly WorkbenchMessage[],
  identity: WorkbenchEventEnvelope['identity'],
  role: WorkbenchMessage['role'],
): number {
  const incomingIdentity = providerIdentityKey(identity)
  if (incomingIdentity) {
    const exact = findLastMessageIndex(messages, message => message.role === role
      && providerIdentityKey(message.identity) === incomingIdentity)
    if (exact >= 0) return exact
  }
  return findLastMessageIndex(messages, message => message.role === role && message.running)
}

function findCorrelatedUserEcho(
  messages: readonly WorkbenchMessage[],
  envelope: WorkbenchEventEnvelope,
  content: string,
  incomingOptimistic: boolean,
): number {
  const requestIdentity = envelope.identity.interactionId
  if (requestIdentity) {
    const correlated = findLastMessageIndex(messages, message => message.role === 'user'
      && message.optimistic !== incomingOptimistic
      && message.identity.interactionId === requestIdentity)
    if (correlated >= 0) return correlated
    // A local optimistic row with an explicit client identity is a distinct
    // command unless that identity correlates. Falling back to adjacent text
    // here drops legitimate repeated prompts (for example two consecutive
    // "继续" sends while the first authoritative echo is loading).
    if (incomingOptimistic) return -1
  }
  const adjacentIndex = messages.length - 1
  const adjacent = messages[adjacentIndex]
  return adjacent?.role === 'user'
    && adjacent.content === content
    && adjacent.optimistic !== incomingOptimistic
    ? adjacentIndex
    : -1
}

function findLastMessageIndex(
  messages: readonly WorkbenchMessage[],
  predicate: (message: WorkbenchMessage) => boolean,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index]!)) return index
  }
  return -1
}
