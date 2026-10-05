/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal, onCleanup, onMount, untrack, type JSX } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import type {
  MeasurementInvalidationReason,
  MessageListAnchor,
  MessageListItem,
  MessageListPort,
} from '../../../domains/workbench/messageListPort.ts'
import { selectMessageViewportState } from '../../../domains/workbench/messageViewportState.ts'
import { createFrameTask } from '../frameTask.ts'
import { createRowHeightTable } from './rowHeightTable.ts'
import { estimateRowHeight } from './rowHeightEstimate.ts'
import { createEntryMotion } from '../entryMotion.solid.tsx'

/** #212 S4：小于该像素的差量视为无变化（避免亚像素抖动的写入循环）。 */
const ANCHOR_EPSILON_PX = 1
/** #409：container 宽度差量小于该值不触发 D5 全量失效（亚像素回差不影响换行）。 */
const CONTAINER_WIDTH_EPSILON_PX = 0.5
/** Bulk history hydration and session replacement must never animate as live arrivals. */
const MAX_ANIMATED_APPEND_ROWS = 4

export interface PlainMessageListProps {
  initialItems?: readonly MessageListItem[]
  renderItem: (item: MessageListItem) => JSX.Element
  onPortReady?: (port: MessageListPort) => void
  onContentResize?: () => void
  /**
   * #212 S4：滚动视口（补偿的写入目标）。不传即不做锚点补偿（原生锚定行为）。
   */
  scrollViewport?: () => HTMLElement | undefined
  /**
   * #212 S4：滚动姿态。`'follow'` = 贴底跟随（由上层把它钉在底部，本组件不补偿）；
   * `'pin'` = 用户自己控制位置——上方内容的高度变化必须补偿，否则用户正在读的行会被挤走。
   */
  scrollPosture?: () => 'follow' | 'pin'
  /**
   * #213：包装层 `data-streaming` 的判据。缺省回落 `message.running`（legacy 夹具不变），
   * 生产接权威活性。
   *
   * 为什么单列一个 prop：正文行自己的 `data-streaming` 走 `MessageRow` 的 `live()`，
   * 但 CSS 里还有一条只看**包装层**属性的旁路（`.plain-message-list__row[data-streaming]`
   * 的 sweep 动画与脉冲竖条）。只改内层会让"重放出的无终态行"永久播放生成动画——
   * 正是 #213 要消灭的症状。
   */
  rowLive?: (item: MessageListItem) => boolean
  /** Production gates arrival motion to an active turn; fixtures may omit it. */
  animateEntry?: () => boolean
  /**
   * #243：行虚拟化的启用口径。缺省 `'auto'` = 超过双阈值（行数 + 字符，D3）才启用；
   * `'on'`/`'off'` 供测试与运维强制。祖先带 `data-row-virtualization="off"` 时一律停用
   * （杀停开关，沿用 #221 `data-highlight-lifecycle="off"` 先例）。
   */
  virtualization?: 'auto' | 'on' | 'off'
}

/**
 * #212 S3b：渐进挂载窗口。
 *
 * 整发把**文本**一次给全（不再逐字铺开），但 DOM 按窗口分批出现——首帧的解析量因此从
 * "整屏行数"降到"窗口行数"（markdown 解析实测约 4.5ms/千字符，冷开长会话时整屏新行会在
 * 同一帧里全部首次解析）。窗口锚在**尾部**向上扩：贴底姿态下用户先看到最新内容、历史从
 * 上方长出来，视口不 churn——这正是别家共识「历史只渐进挂载行数，不渐进显示文本」。
 *
 * #243：该窗口只服务**短会话**（低于虚拟化阈值，行为逐字节不变）；长会话改走视口窗口
 * + 占位符（D1），「尾部只增」的窗口语义在长会话上退役——对应三条 #212 用例的改写。
 */
const MOUNT_WINDOW_INITIAL = 16
const MOUNT_WINDOW_STEP = 32

/**
 * #243 D1/D3：虚拟化启用阈值（行数 + 字符双门槛，取「与」——行多但内容轻的会话
 * 不值得付虚拟化的复杂度，内容重而行少的会话归 #208 折叠/惰性渲染管）。
 * 默认值由 #240 附六 jsdom 读数推得（600 行合成会话 = 6058 节点 / 堆 251MB），
 * **切片 0 真机标定后修正**。
 */
const ROW_VIRTUALIZE_MIN_ROWS = 300
const ROW_VIRTUALIZE_MIN_CHARS = 100_000
/** 视口上下各多物化的行数（D2 回卷的「增量」即由此步进）。 */
const ROW_VIRTUALIZE_OVERSCAN = 8

export function PlainMessageList(props: PlainMessageListProps) {
  const [items, setItems] = createSignal<readonly MessageListItem[]>(props.initialItems ?? [])
  const [rows, setRows] = createSignal<readonly StableMessageListRow[]>(
    (props.initialItems ?? []).map(item => createStableMessageListRow(item)),
  )
  // Keep the initial history quiet. Rows created by a later projection are
  // marked once so CSS can animate the actual send/append boundary without
  // replaying the whole transcript on mount.
  const seenKeys = new Set((props.initialItems ?? []).map(item => item.key))
  const rowElements = new Map<string, HTMLElement>()
  let container: HTMLDivElement | undefined // Solid ref 会在 mount 时赋值
  let bottomAnchor: HTMLDivElement | undefined // Solid ref 会在 mount 时赋值
  let destroyed = false
  let resizeObserver: ResizeObserver | undefined
  /** 消息列表父容器（生产为共同阅读列）的观察器：leading 活动区高度变化不改列表自身
   * 高度 ⇒ container 的 RO 不触发，scrollMargin 会过期（审查 P1-2）。只做廉价的
   * margin 重测与 spacer 刷新，不走测量失效。 */
  let contentObserver: ResizeObserver | undefined
  const measurements = createFrameTask((reason: MeasurementInvalidationReason) => port.invalidateMeasurements(reason))

  // ── #243 行虚拟化（视口窗口 + 行高表 + 占位符） ─────────────
  // 尺寸真值分两层：**实测层**归引擎（TanStack 按 key 的 itemSizeCache，卸载不丢——
  // D7 改口径①「尺寸缓存不随卸载丢弃 ⇒ 回滚布局不跳」的机制载体，由 measureElement
  // 登记的 ResizeObserver 回填）；**估算层**归我方行高表（内容推导，D5）。两层只在
  // 引擎缓存未命中处经 estimateSize 相接，不是双真值。
  const heightTable = createRowHeightTable()
  const [geometryRevision, bumpGeometry] = createSignal(0)
  let scrollMarginPx = 0
  let lastMaterializedKeys = new Set<string>()
  /** 引擎几何同步（scrollMargin 重测 + 占位符高度失效），按帧批处理。 */
  const geometrySync = createFrameTask(() => {
    measureScrollMargin()
    bumpGeometry(value => value + 1)
  })
  const measureScrollMargin = () => {
    const viewport = props.scrollViewport?.()
    if (!viewport || !container) { scrollMarginPx = 0; return }
    // D.3.1：列表在滚动容器内容流里的上方偏移（上方还有 leading 活动区等），实测不写死
    scrollMarginPx = container.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
  }
  // 字符总量随 setItems 一次算好（virtualActive 高频调用，不每次全列表求和）。
  // 字符数按 key 缓存：P57 S2-R3 引用相等门要求未变化行的 descriptor getter 零读取，
  // 所以只在「行内容真正变化/新行首次出现」时读一次 descriptor。
  const charsByKey = new Map<string, number>()
  const charsOf = (item: MessageListItem): number => {
    const cached = charsByKey.get(item.key)
    if (cached !== undefined) return cached
    const length = item.descriptor.renderMessage.message.content?.length ?? 0
    charsByKey.set(item.key, length)
    return length
  }
  const totalCharsOfItems = (props.initialItems ?? []).reduce((sum, item) => sum + charsOf(item), 0)
  const killSwitched = () =>
    container !== undefined && container.closest('[data-row-virtualization="off"]') != null
  // 响应式口径：count/virtualActive 在引擎的 createComputed 里被读取，必须 track 信号，
  // 否则 setItems 后引擎永不重算（长会话永远 0 物化）。字符总量用 signal 承载；
  // 杀停开关在 mount 时才能查到祖先属性（setup 期 container 未挂），故也走 signal。
  const [charsTotal, setCharsTotal] = createSignal(totalCharsOfItems)
  const [ancestorKill, setAncestorKill] = createSignal(false)
  const virtualActive = () => {
    if (destroyed) return false
    if (props.virtualization === 'off' || ancestorKill()) return false
    if (props.virtualization === 'on') return true
    return rows().length >= ROW_VIRTUALIZE_MIN_ROWS && charsTotal() >= ROW_VIRTUALIZE_MIN_CHARS
  }
  const virtualizer = createVirtualizer({
    // 引擎只在虚拟化激活时承重；短会话 count=0，取窗恒空
    get count() { return virtualActive() ? rows().length : 0 },
    getScrollElement: () => props.scrollViewport?.() ?? null,
    get estimateSize() {
      return (index: number) => heightTable.sizeAt(index) ?? estimateRowHeight(untrack(rows)[index]!.item)
    },
    get getItemKey() {
      return (index: number) => untrack(rows)[index]!.key
    },
    get overscan() { return ROW_VIRTUALIZE_OVERSCAN },
    get scrollMargin() { return scrollMarginPx },
  })
  // B3 修正策略 = TanStack 内建判据 + 姿态门控：follow 姿态由上层钉底，修正无意义；
  // 仅「整体位于视口起点之上」的行（首测用 start <，重测用 end <=，`<=` 边界语义）
  // 且非上滚途中才补偿，避免流式行底部长高把视口往下拖（#1218 同款）。
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if ((props.scrollPosture?.() ?? 'follow') === 'follow') return false
    const offset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments
    const isFirstMeasure = !instance.itemSizeCache.has(item.key)
    return isFirstMeasure
      ? item.start < offset
      : item.start + item.size <= offset && instance.scrollDirection !== 'backward'
  }
  /**
   * 渲染切片（引擎取窗内的行；D2 回卷 = 上滚时取窗自动向上步进）。窗外的行**不驻留
   * DOM**，其几何由容器 spacer（见 JSX 内联 padding）承载，两种修正机制殊途同归：
   * 实测修正经引擎 RO→resizeItem→store→totalSize 传播，估算修正落在本组件行高表、
   * 于引擎下次重算（滚动/行数变化）时并入——无论哪条路，高度都来自同一张行高表，
   * 物化/卸载不改变布局总高，视口内已锚定行不因窗外高度变化位移（spec 240 B2）。
   *
   * wrapper 按 row key 缓存且在 index 不变时复用 ⇒ 滚动与 setItems 都不会重建
   * 窗内既有行的单元格（DOM 身份契约，P57 S2-R3）。
   */
  interface RenderedCell {
    readonly row: StableMessageListRow
    readonly index: number
  }
  const cellByKey = new Map<string, RenderedCell>()
  const rendered = createMemo<readonly RenderedCell[]>(() => {
    geometryRevision()
    if (!virtualActive()) return []
    const all = untrack(rows)
    const cells: RenderedCell[] = []
    for (const virtualItem of virtualizer.getVirtualItems()) {
      const row = all[virtualItem.index]
      if (!row) continue
      const existing = cellByKey.get(row.key)
      if (existing && existing.index === virtualItem.index) { cells.push(existing); continue }
      const cell: RenderedCell = { row, index: virtualItem.index }
      cellByKey.set(row.key, cell)
      cells.push(cell)
    }
    lastMaterializedKeys = new Set(cells.map(cell => cell.row.key))
    return cells
  })
  /** 列表内联 padding：首行之前（含窗外历史）与末行之后（含尾外未来内容）的空档。 */
  const spacerTop = (): number => {
    geometryRevision()
    if (!virtualActive()) return 0
    const items = virtualizer.getVirtualItems()
    if (items.length === 0) return 0
    return Math.max(0, items[0]!.start - scrollMarginPx)
  }
  const spacerBottom = (): number => {
    geometryRevision()
    if (!virtualActive()) return 0
    const items = virtualizer.getVirtualItems()
    if (items.length === 0) return virtualizer.getTotalSize()
    return Math.max(0, virtualizer.getTotalSize() - (items[items.length - 1]!.end - scrollMarginPx))
  }

  // ── #212 S3b 渐进挂载窗口（短会话路径；长会话由上面的视口窗口接管） ──
  // `mounted` = 从尾部算起渲染的行数（单调不减：窗内已经建好的行不重挂，避免每次追加都
  // 让整窗行重建）。整批换代（会话切换）时重置为初始值再逐帧扩。
  const [mounted, setMounted] = createSignal((props.initialItems ?? []).length)
  let mountFrame: number | undefined
  let mountExpansionTarget = 0
  const stopMountExpansion = () => {
    if (mountFrame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(mountFrame)
    mountFrame = undefined
  }
  /**
   * 逐帧扩窗（**只调度，不立即推进**——初始窗口由调用方同步建立）。
   * `total` 必须显式传入：调用点可能早于 `setRows`，读 `rows()` 会拿到旧长度。
   */
  const scheduleMountExpansion = (total: number) => {
    // 目标存进**可变变量**而不是 rAF 闭包：换代（冷开 A 的扩窗还没跑完就切到更长的 B）
    // 时必须用最新总长，否则挂起的帧会按旧会话的行数收敛，新会话头部行永远不挂载。
    mountExpansionTarget = total
    if (destroyed || mountFrame !== undefined) return
    if (untrack(mounted) >= total) return
    if (typeof requestAnimationFrame !== 'function') { setMounted(total); return }
    mountFrame = requestAnimationFrame(() => {
      mountFrame = undefined
      const target = mountExpansionTarget
      setMounted(Math.min(target, untrack(mounted) + MOUNT_WINDOW_STEP))
      scheduleMountExpansion(target)
    })
  }
  /** 行集合变化后决定窗口：整体换代重置、尾部追加不动、整批增长逐帧扩。 */
  const reconcileMountWindow = (nextItems: readonly MessageListItem[]): void => {
    const total = nextItems.length
    // 用户自己控制位置时不挂窗口——少挂几行会让他的视口对着错误的行。
    if (props.scrollPosture?.() === 'pin') { stopMountExpansion(); setMounted(total); return }
    const current = untrack(mounted)
    const renderedRows = untrack(rows)
    const firstRenderedKey = renderedRows[Math.max(0, renderedRows.length - current)]?.key
    const freshSet = firstRenderedKey !== undefined && !nextItems.some(item => item.key === firstRenderedKey)
    if (freshSet || current === 0) {
      // 整体换代（冷开/切换会话）：只先挂尾部 INITIAL 行，其余逐帧扩。
      // 此时缩小窗口是安全的——整行集都被换掉，没有哪一行的身份值得保。
      setMounted(Math.min(total, MOUNT_WINDOW_INITIAL))
      scheduleMountExpansion(total)
      return
    }
    // 同一会话内的行集变化：窗口**只增不减**（收缩会把正在显示的行卸掉再挂回）。
    // 渐进只服务"整体换代的首屏"，增量增长交给跟随/锚点（它们才有几何信息）。
    setMounted(Math.max(current, Math.min(total, MOUNT_WINDOW_INITIAL)))
    if (total > untrack(mounted)) scheduleMountExpansion(total)
  }

  /**
   * 渲染窗口（**短会话路径**）：从尾部算起 `count` 行（全部挂载时返回原数组，不复制）。
   *
   * `count` 取 `max(mounted, min(len, INITIAL))`——**窗口不小于初始窗口**。这不是节省，
   * 而是身份正确性：窗口更新与行集替换是两次信号写，Solid 每次都渲染，中间那次会拿
   * "旧行集 + 新窗口"算一次可见集；若窗口能在行集缩小前先缩，正在显示的行会被卸掉再挂回，
   * DOM 身份就断了（`For` 会重建节点）。
   */
  const visibleRows = (): readonly StableMessageListRow[] => {
    const all = rows()
    const count = Math.max(mounted(), Math.min(all.length, MOUNT_WINDOW_INITIAL))
    if (count >= all.length) return all
    return all.slice(all.length - count)
  }

  /** 引擎取窗随滚动事件/帧重算——scrollTo 写入后等 1~2 帧再查物化结果。 */
  const nextFrame = () => new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else queueMicrotask(() => resolve())
  })

  const port: MessageListPort = {
    setItems(nextItems) {
      if (destroyed || nextItems === untrack(items)) return
      const previousRows = untrack(rows)
      const appendCount = nextItems.length - previousRows.length
      const isSmallAppend = appendCount > 0 && appendCount <= MAX_ANIMATED_APPEND_ROWS
        && previousRows.every((row, index) => nextItems[index]?.key === row.key)
      const animateAppend = isSmallAppend && (props.animateEntry?.() ?? true)
      // Streaming updates usually keep every key in place. Build a lookup only
      // when reconciliation encounters an insertion, removal or reorder.
      let previousRowsByKey: Map<string, StableMessageListRow> | undefined
      let changed = false
      const contentChanged: Array<{ key: string; item: MessageListItem }> = []
      const nextRows = nextItems.map((item, index) => {
        const existing = previousRows[index]?.key === item.key ? previousRows[index]
          : (previousRowsByKey ??= new Map(previousRows.map(row => [row.key, row]))).get(item.key)
        if (!existing) {
          changed = true
          const entering = animateAppend && !seenKeys.has(item.key)
          seenKeys.add(item.key)
          return createStableMessageListRow(item, entering)
        }
        // 顺序/裁剪也是结构变化；同 key 且同序才允许沿用既有行。
        if (index >= previousRows.length || previousRows[index].key !== item.key) changed = true
        // P57 S2-R3：引用相等门——当前 item 与行已应用的 item 全等时跳过 signal 写入，
        // 零成本通过（上层 items memo 的 per-key 复用保证未变化行引用稳定）。
        if (!existing.isCurrent(item)) {
          existing.update(item)
          changed = true
          contentChanged.push({ key: existing.key, item })
        }
        return existing
      })
      if (!changed && nextItems.length === previousRows.length) return
      // 整体换代（冷开/切换会话）：清理上一会话的退役条目（chars/cell wrapper/行高表
      // 退役实测），防跨会话只增不减（审查 P2-3）。引擎 itemSizeCache 一并清空——
      // 新会话的行尚未实测，量随用随建。
      const previousKeys = new Set(previousRows.map(row => row.key))
      if (previousRows.length > 0 && !nextItems.some(item => previousKeys.has(item.key))) {
        charsByKey.clear()
        cellByKey.clear()
        heightTable.reset()
        if (virtualActive()) virtualizer.measure()
      }
      // 内容变化的行使字符缓存失效，重新计入总量（未变化行走缓存，零 descriptor 读取）
      for (const { key } of contentChanged) charsByKey.delete(key)
      setCharsTotal(nextItems.reduce((sum, item) => sum + charsOf(item), 0))
      setItems(nextItems)
      // 先定窗口再换行集：反过来会让一次渲染用旧窗口渲染新列表，把首行卸掉又挂回来（DOM 身份断）。
      reconcileMountWindow(nextItems)
      setRows(nextRows)
      if (virtualActive()) {
        // 估算层随行集与内容更新；实测层归引擎（key 化缓存跨换代保留）
        const itemByKey = new Map(nextItems.map(item => [item.key, item]))
        heightTable.setKeys(nextRows.map(row => row.key), key => estimateRowHeight(itemByKey.get(key)!))
        for (const { key, item } of contentChanged) {
          heightTable.refreshAfterContentChange(key, estimateRowHeight(item), lastMaterializedKeys.has(key))
        }
        geometrySync.schedule()
      }
      measurements.schedule('items-changed')
    },
    async scrollTo(anchor) {
      if (destroyed) return false
      await Promise.resolve()
      let node = rowElements.get(anchor.messageId)
      if (!node && virtualActive()) {
        // #243：目标在占位区（搜索结果跳转）——只物化目标附近，不再全开。
        // scrollToIndex 自带动态尺寸收敛循环（scheduleScrollReconcile），估算误差会
        // 被逐帧修正到目标行真实可见。
        const index = untrack(rows).findIndex(row => row.item.descriptor.renderMessage.message.id === anchor.messageId)
        if (index >= 0) {
          virtualizer.scrollToIndex(index, { align: anchor.align === 'nearest' ? 'auto' : anchor.align })
          for (let attempt = 0; attempt < 3 && !node; attempt += 1) {
            await nextFrame()
            node = rowElements.get(anchor.messageId)
          }
        }
      }
      // #212 S3b（短会话路径）：目标还在窗口外——立即全开再等一次刷新。
      if (!node && !virtualActive()) {
        stopMountExpansion()
        setMounted(untrack(rows).length)
        await Promise.resolve()
        node = rowElements.get(anchor.messageId)
      }
      if (!node) return false
      node.scrollIntoView(resolveMessageScrollIntoViewOptions(anchor))
      return true
    },
    scrollToBottom(behavior) {
      if (destroyed) return
      bottomAnchor?.scrollIntoView({ behavior, block: 'end' })
    },
    getViewportState() {
      if (!container || destroyed) {
        return selectMessageViewportState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, rows: [] })
      }
      const containerRect = container.getBoundingClientRect()
      return selectMessageViewportState({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        rows: items().flatMap(item => {
          const node = rowElements.get(item.descriptor.renderMessage.message.id)
          if (!node) return []
          const rect = node.getBoundingClientRect()
          const top = rect.top - containerRect.top + container.scrollTop
          return [{
            messageId: item.descriptor.renderMessage.message.id,
            top,
            bottom: top + rect.height,
          }]
        }),
      })
    },
    invalidateMeasurements(reason: MeasurementInvalidationReason) {
      if (!container || destroyed) return
      container.dataset.measurementRevision = String(Number(container.dataset.measurementRevision || 0) + 1)
      container.dataset.measurementReason = reason
      // D5 失效策略：字体/主题/容器变化 ⇒ 实测全部作废——引擎 measure() 清缓存后由
      // 挂载行的观察器重测、占位符回落重估（items-changed 是增量口径，不作废；
      // 'manual' 沿用 #212 旧语义：只翻 revision，无失效消费方）。
      if (reason === 'theme-changed' || reason === 'font-changed' || reason === 'container-resized') {
        if (virtualActive()) {
          const itemByKey = new Map(untrack(items).map(item => [item.key, item]))
          heightTable.invalidateAll(key => {
            const item = itemByKey.get(key)
            return item ? estimateRowHeight(item) : (heightTable.sizeOf(key) ?? 0)
          })
          virtualizer.measure()
          geometrySync.schedule()
        }
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      measurements.dispose()
      geometrySync.dispose()
      heightTable.reset()
      stopMountExpansion()
      resizeObserver?.disconnect()
      resizeObserver = undefined
      contentObserver?.disconnect()
      contentObserver = undefined
      rowElements.clear()
      setItems([])
      setRows([])
      container?.replaceChildren()
    },
  }

  onMount(() => {
    setAncestorKill(killSwitched())
    if (typeof ResizeObserver !== 'undefined' && container) {
      // #409：失效按 entry.target 分流。container 自身也被观察，而行高和=容器高，
      // 行增高必然级联出 container 条目——但**高度**级联不影响换行，不该作废任何实测
      // （D5 的「容器变化」本意是影响换行的几何，即宽度）。此前行/容器两条 entry 都落
      // container-resized，虚拟化长会话流式期间每发布清一次引擎实测缓存再全体重测。
      let containerWidth: number | undefined
      resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.target !== container) continue
          const width = entry.contentRect.width
          if (containerWidth !== undefined && Math.abs(width - containerWidth) >= CONTAINER_WIDTH_EPSILON_PX) {
            port.invalidateMeasurements('container-resized')
          }
          containerWidth = width
        }
        syncAnchorCompensation()
        geometrySync.schedule()
        props.onContentResize?.()
      })
      resizeObserver.observe(container)
      for (const node of rowElements.values()) resizeObserver.observe(node)
      const contentHost = container.parentElement
      if (contentHost) {
        contentObserver = new ResizeObserver(() => geometrySync.schedule())
        contentObserver.observe(contentHost)
      }
    }
    measureScrollMargin()
    props.onPortReady?.(port)
  })

  // ── #212 S4 自管锚点 ────────────────────────────────────────
  // 上层已显式关闭原生锚定（`overflow-anchor: none`，见 ChatView.css），因此用户自己控制
  // 位置时（`'pin'`），视口上方任何高度变化都必须由我们补回：
  // 记下视口顶部那一行的**文档空间偏移**，变化后把 scrollTop 调整同样的差量。
  // 贴底跟随（`'follow'`）时不做补偿——那一姿态下"内容长了就跟到底"才是意图。
  //
  // #243：占位符是带真实高度的 DOM 盒，窗外行的高度变化同样会平移锚行 ⇒ 该机制对
  // 虚拟化路径**原样成立**（spec 240 B2「占位符保持几何」），无需第二套修正。
  let anchor: { messageId: string; top: number } | undefined

  /**
   * 相对**滚动视口**内容原点的行顶。基准必须是真正的滚动容器（App 传进来的
   * `scrollViewport`，生产里是 `.chat-view`）——`container`（`.plain-message-list`）
   * 自己不滚动，用它做基准时 `scrollTop` 恒为 0、且容器与行会一起被上方内容平移，
   * 差量恒为 0 ⇒ 补偿变成死代码（而本组件同时关掉了原生锚定，等于完全没有锚定）。
   */
  const rowTop = (messageId: string): number | undefined => {
    const node = rowElements.get(messageId)
    const viewport = props.scrollViewport?.()
    if (!node || !viewport) return undefined
    const rect = node.getBoundingClientRect()
    return rect.top - viewport.getBoundingClientRect().top + viewport.scrollTop
  }

  const captureAnchor = () => {
    const viewport = props.scrollViewport?.()
    if (!viewport) { anchor = undefined; return }
    const scrollTop = viewport.scrollTop
    const viewportRect = viewport.getBoundingClientRect()
    let best: { messageId: string; top: number } | undefined
    for (const [messageId, node] of rowElements) {
      const rect = node.getBoundingClientRect()
      const top = rect.top - viewportRect.top + scrollTop
      const bottom = top + rect.height
      // 视口下方、且离视口顶部最近的那一行 = 用户正在读的锚。
      if (bottom <= scrollTop) continue
      if (best === undefined || top < best.top) best = { messageId, top }
    }
    anchor = best
  }

  const syncAnchorCompensation = () => {
    const viewport = props.scrollViewport?.()
    const posture = props.scrollPosture?.() ?? 'follow'
    if (posture === 'follow' || viewport === undefined) {
      anchor = undefined
      return
    }
    if (anchor === undefined) { captureAnchor(); return }
    const top = rowTop(anchor.messageId)
    if (top === undefined) { anchor = undefined; return }
    const delta = top - anchor.top
    if (Math.abs(delta) < ANCHOR_EPSILON_PX) return
    viewport.scrollTop = Math.max(0, viewport.scrollTop + delta)
    anchor = { messageId: anchor.messageId, top }
  }

  onCleanup(() => port.destroy())

  const bindRow = (item: MessageListItem, node: HTMLElement, index?: number) => {
    const messageId = item.descriptor.renderMessage.message.id
    rowElements.set(messageId, node)
    if (index !== undefined && virtualActive() && node.offsetHeight > 0) {
      // 引擎测量管线：登记元素后由其 ResizeObserver 实测回填（key 化缓存，卸载不丢）。
      // indexFromElement 按 data-index 定位，必须随行集变化保持最新。
      // offsetHeight=0（未布局/不可见）不送测：零尺寸会毒化缓存（jsdom 恒为 0）。
      node.dataset.index = String(index)
      virtualizer.measureElement(node)
    }
    resizeObserver?.observe(node)
    onCleanup(() => {
      resizeObserver?.unobserve(node)
      if (rowElements.get(messageId) === node) rowElements.delete(messageId)
      // 引擎的 elementsCache 持有登记过的行节点；断开节点不再触发 RO，引擎自带的
      // isConnected 清扫不可达 ⇒ 不主动清扫则访问过的历史 DOM 全部常驻堆
      // （审查 P1-1）。measureElement(null) 是引擎提供的官方批量清扫入口。
      if (index !== undefined && virtualActive()) {
        (virtualizer.measureElement as unknown as (node: Element | null) => void)(null)
      }
    })
  }

  return (
    <div
      ref={container}
      class="plain-message-list"
      data-message-list="plain"
      data-measurement-revision="0"
      data-row-virtualization={virtualActive() ? 'on' : undefined}
      style={virtualActive() ? { 'padding-top': `${spacerTop()}px`, 'padding-bottom': `${spacerBottom()}px` } : undefined}
    >
      <Show when={virtualActive()} fallback={<>
        <For each={visibleRows()}>{(row, _index) => {
          const item = row.item
          return (
            <div
              ref={(node: HTMLDivElement) => { bindRow(item, node) }}
              class="plain-message-list__row"
              data-message-id={item.descriptor.renderMessage.message.id}
              data-message-key={row.key}
              data-entry={row.entering() ? 'new' : undefined}
              data-message-role={item.descriptor.renderMessage.message.role}
              data-streaming={(props.rowLive?.(item) ?? item.descriptor.renderMessage.message.running === true) ? 'true' : undefined}
            >
              {props.renderItem(item)}
            </div>
          )
        }}</For>
        <div ref={bottomAnchor} class="plain-message-list__bottom" aria-hidden="true" />
      </>}>
        <For each={rendered()}>{cell => {
          const item = cell.row.item
          return (
            <div
              ref={(node: HTMLDivElement) => { bindRow(item, node, cell.index) }}
              class="plain-message-list__row"
              data-message-id={item.descriptor.renderMessage.message.id}
              data-message-key={cell.row.key}
              data-index={cell.index}
              data-entry={cell.row.entering() ? 'new' : undefined}
              data-message-role={item.descriptor.renderMessage.message.role}
              data-streaming={(props.rowLive?.(item) ?? item.descriptor.renderMessage.message.running === true) ? 'true' : undefined}
            >
              {props.renderItem(item)}
            </div>
          )
        }}</For>
        <div ref={bottomAnchor} class="plain-message-list__bottom" aria-hidden="true" />
      </Show>
    </div>
  )
}

interface StableMessageListRow {
  readonly key: string
  readonly item: MessageListItem
  entering(): boolean
  update(item: MessageListItem): void
  /** P57 S2-R3：当前已应用的 item 引用，供引用相等门跳过冗余 update。 */
  isCurrent(item: MessageListItem): boolean
}

function createStableMessageListRow(initialItem: MessageListItem, entering = false): StableMessageListRow {
  const [current, setCurrent] = createSignal(initialItem)
  const entry = createEntryMotion(entering)
  let appliedItem = initialItem
  const item: MessageListItem = {
    get key() { return current().key },
    get descriptor() { return current().descriptor },
    get estimatedHeight() { return current().estimatedHeight },
  }
  return {
    key: initialItem.key,
    item,
    entering: entry,
    update(next) {
      appliedItem = next
      setCurrent(next)
    },
    isCurrent: next => appliedItem === next,
  }
}

export function resolveMessageScrollIntoViewOptions(anchor: MessageListAnchor): ScrollIntoViewOptions {
  return { block: anchor.align }
}
