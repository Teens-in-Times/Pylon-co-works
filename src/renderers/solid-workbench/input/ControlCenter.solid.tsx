/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { CC_WIDGET_IDS, WIDGET_PROPERTY_FIELDS, isWidgetVisible, CC_WIDGET_LABELS, ccWidgetLanding, coerceInputLanding, resolveCcHiddenWidgetIds, resolveCcWidgetGroup, type CcPropertyCommand, type CcWidgetId, type WidgetPropertyField } from '../../../domains/cc/widgetDefinitions.ts'
import { setCcHiddenState, type CcLayoutWidgetId, type CcVisibilityTarget, type CcWidgetPlacement } from '../../../domains/cc/ccLayoutState.ts'
import { ccMinHeightInputOf, resolveCcMinHeight, resolveCcMinWidth, resolveCcWidthGroups, type CcWidgetWidthIndex } from '../../../domains/cc/ccHeightState.ts'
import { resolveCcShowVerdict, type CcShowVerdict, type CcShowVerdictInput } from '../../../domains/cc/ccShowVerdict.ts'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import { createSessionUiSignal } from '../adapters/sessionUiSignal.solid.tsx'
import { createCcWidgetRenderers } from './createCcWidgetRenderers.solid.tsx'
import { resolveModeOptionEntries } from './workbenchOptionCatalog.ts'
import type { WorkbenchAttachment } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { toCssBackgroundImage } from '../../../infrastructure/skin/backgroundImage.ts'
import { errorMessage } from '../../../infrastructure/tauri/errorPayload.ts'
import { createCcWorkspaceSelection } from './createCcWorkspaceSelection.solid.tsx'
import { createCcSources } from './createCcSources.ts'
import { CC_EDIT_TOOLBAR_IDS, createCcDragController } from './createCcDragController.ts'
import { resolveCcWidgetRoster, type CcWidgetRosterEntry } from '../../../domains/cc/ccWidgetRoster.ts'
import { getCcWidgetRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createRegistrySignal } from '../../../infrastructure/state/solidSheetSupport.solid.tsx'
import { CcIsolatedWidget } from './CcIsolatedWidget.solid.tsx'

/**
 * ★★ #238 刀3：**槽位层已拆** —— 不再有「先分槽、再在槽里排序」两段式。
 * 位置由定义表每行的 `layout` 声明，渲染按**落脚处**（`ccWidgetLanding` = `(y.anchor, y.side)`）自动成组。
 *
 * 两个落脚处**从表里取**（不写死字符串）：输入栏那一处与信息控件那一处。
 * ⚠ 容器结构不能随意改：`.cc-input-slot` 这个类名被两处 JS 用来量宽度
 * （本文件 `onMount` 算 `--cc-input-text-inset-x`、`InputBar.solid.tsx` 取父容器），
 * 改了会让输入框文字内缩**静默变成 0**。
 */
const INPUT_LANDING = ccWidgetLanding('input')
const INFO_LANDING = ccWidgetLanding('model')

export function SolidControlCenter() {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  // ccSurfaceOpacity is stored as a 0–1 ratio. Keep accepting legacy
  // snapshots that carried the old 0–100 value so previews/renderers do not
  // briefly emit values such as 7200% while an older theme is being loaded.
  const surfaceOpacityPercent = () => {
    const value = appearance().ccSurfaceOpacity
    return value > 1 ? value : value * 100
  }
  const inputSurfaceOpacityPercent = () => {
    const value = appearance().inputSurfaceOpacity
    return value > 1 ? value : value * 100
  }
  const inputBorderOpacityPercent = () => {
    const value = appearance().inputBorderOpacity
    return value > 1 ? value : value * 100
  }
  const inputHighlightOpacityPercent = () => {
    const value = appearance().inputHighlightOpacity
    return value > 1 ? value : value * 100
  }
  const runtime = () => workbench.runtimeSnapshot()
  const input = () => workbench.input()
  const [selectorPending] = createSessionUiSignal(workbench.sessionUi, () => input().sessionId, 'selector-pending', '')
  const [selected, setSelected] = createSignal<CcLayoutWidgetId>()
  const [modelId, setModelId] = createSignal('')
  const [reasoningLevel, setReasoningLevel] = createSignal('medium')
  const [mode, setMode] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)
  const [submitError, setSubmitError] = createSignal('')
  const [sessionEntering, setSessionEntering] = createSignal(false)
  /**
   * ★★ #266 刀4：**显示前校验**的两件状态。
   * - `availableBox`：背景板**实测**尺寸（`.control-center` 的 clientWidth / clientHeight，
   *   由 `ResizeObserver` 回写）。`0` = 量不到 ⇒ 校验 fail-open（放行，见 `ccShowVerdict` 文件头口径 3）。
   * - `showWarning`：被拒时**常驻**的提示；下一个动作即清（成功的显隐写入 / 切换选中元件 /
   *   尺寸变化后重判通过 / 退出编辑）。
   */
  const [availableBox, setAvailableBox] = createSignal({ width: 0, height: 0 })
  const [showWarning, setShowWarning] = createSignal<Extract<CcShowVerdict, { ok: false }>>()
  let previousSessionId: string | null = input().sessionId
  let sessionEnteringTimer: ReturnType<typeof setTimeout> | undefined
  let controlCenterElement: HTMLDivElement | undefined

  // ── 真相源聚合（#520 S3：组件单一 store 读取入口）────────────────────────────
  const sources = createCcSources(input)
  const modeOptions = () => resolveModeOptionEntries(runtime(), mode()).map(item => item.id)
  // 播种优先级（原样保留）：会话活跃模型 > 活跃档案声明。
  const profileModel = () => runtime().activeModel || sources.activeProfileModel()
  // ★ CC-28 拆词：「空态」混过的两件事就此分开——
  //   `hasNoSession` = 会话真值（没有会话）；进场中沿用 `sessionEntering()` 信号（会话建好那一刻起 360ms）。
  //   名单门与草稿态只认 `hasNoSession`（进场期有会话 ⇒ 元件在场、走实值，2026-10-04 拍板）；
  //   `emptyVisual` 保留为两者的组合，只服务**视觉挂载**（`is-empty` 类 / 状态行门户），条件一概不变。
  const hasNoSession = () => !input().sessionId
  const emptyVisual = () => hasNoSession() || sessionEntering()

  // ── 空态工作区**绑定模型**（#266 CC-27+28：选择器 UI 壳已删；预选 + 侧栏 new-session
  //    意图仍由模型承载，见 createCcWorkspaceSelection.solid.tsx）──────────────────
  const workspaceSelection = createCcWorkspaceSelection({
    workspaces: sources.workspaces,
    onError: setSubmitError,
  })
  const workspaceId = workspaceSelection.value

  // ── 编辑态拖拽 / 高度拖把 / Escape（见 createCcDragController.ts）────────────
  const drag = createCcDragController({
    isEditMode: () => appearance().ccEditMode === true,
    placementOf: id => appearance().ccLayout.placements[id],
    currentHeight: () => appearance().ccHeight,
    select: setSelected,
    isSelected: selected,
    submitPlacement: (id, placement) => workbench.appearance.dispatch({ type: 'update-cc-placement', id, placement }),
    submitHeight: height => workbench.appearance.dispatch({ type: 'set-cc-height', height }),
    exitEditMode: () => workbench.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: false }),
    getRoot: () => controlCenterElement,
  })
  onCleanup(() => drag.dispose())

  const sendButtonMode = () => {
    // 04b：空态隐藏发送按钮 —— 与其余控件共用 hiddenWidgetIds() 这一个入口。
    // ★ CC-02：可见性由 isWidgetVisible 承担（与渲染处同一判据）。
    // ★ #266 刀1：编辑态豁免已撤 ⇒ 被藏件在编辑态下同样不渲染。
    if (!isWidgetVisible('cc-send-button', visibilityContext())) return undefined
    return appearance().inputSubmitButtonMode === 'external' ? 'external' : appearance().inputSubmitButtonMode === 'inline' ? 'inline' : undefined
  }
  createEffect(() => {
    if (modelId() || !profileModel()) return
    setModelId(profileModel())
  })
  createEffect(() => {
    if (mode() || !runtime().activeMode) return
    setMode(runtime().activeMode || modeOptions()[0] || 'default')
  })
  createEffect(() => {
    const current = input().sessionId
    if (!previousSessionId && current) {
      setSessionEntering(true)
      if (sessionEnteringTimer) clearTimeout(sessionEnteringTimer)
      sessionEnteringTimer = setTimeout(() => {
        sessionEnteringTimer = undefined
        setSessionEntering(false)
      }, 360)
    }
    previousSessionId = current
  })
  onCleanup(() => {
    if (sessionEnteringTimer) clearTimeout(sessionEnteringTimer)
  })
  createEffect(() => {
    if (appearance().ccEditMode) return
    setSelected(undefined)
    drag.cancelActiveDrag()
  })
  const readonly = () => input().replayReadonly === true || (input().preview === true && Boolean(input().sessionId))
  // ★ #266 刀4（结构 C）：「一份**主管表** + 一份**空态再藏**」——
  //   生效名单 = `门 ? (主管 ∪ 再藏) : 主管`（并集去重）⇒ 空态**只能多藏**，不能"放出"常态藏着的件
  //   （旧版两份表平权、由门二选一读 ⇒ 在空态里改的显隐一开会话就变回去；本刀消除这一条）。
  //   组装只有这一处（计数侧调同一个函数 ⇒ 渲染与计数同源）；不再有任何语境侧硬编码名单。
  const hiddenWidgetIdsFor = (isEmpty: boolean) => resolveCcHiddenWidgetIds({
    ccHidden: appearance().ccHidden,
    ccHiddenEmpty: appearance().ccHiddenEmpty,
    isEmpty,
    cliHintMode: appearance().cliHintMode,
  })
  /** 眼下生效的那一份（门 = `hasNoSession()`：★ CC-28 拆词——进场那 360ms **有会话**，名单不再生效
   *  ⇒ 元件在场，2026-10-04 拍板）—— 画布在场判据与 chip 的 `＋/●` 用它。 */
  const hiddenWidgetIds = () => hiddenWidgetIdsFor(hasNoSession())
  // ★ #266 ⑰：谓词的上下文只剩「隐藏名单（生效的那份切面）」——元件的行上不再有显隐申明，
  //   也不再按运行期条件（有没有会话 / 输入模式 / 详细档）判明。
  //   ★ #266 刀1：编辑态豁免已撤 ⇒ 上下文里不再有编辑态这一项。
  const visibilityContext = () => ({ hidden: hiddenWidgetIds() })
  // The registered cc-send-button owns the send block (F1=A)：槽位/显隐/缩放统一记在
  // `cc-send-button` 这个 id 上，legacy `send` 已随刀4 迁走。
  const visibleIds = createMemo(() => CC_WIDGET_IDS.filter(id => isWidgetVisible(id, visibilityContext())))

  // ── ★★ #266 CC-13 刀2：插件件上屏（活名单 = 内置 ∪ 已登记）───────────────────────────
  //   注册表快照 → 活名单（纯函数合成，见 `domains/cc/ccWidgetRoster.ts`）→ 只取**插件件**进
  //   本刀新增的渲染段（内置件仍走既有渲染循环与两处特例，一个字节不动）。
  //   ★ 订阅用 `createRegistrySignal`（外部 store → 信号）：登记 / 撤下 / 热替换 ⇒ 名单重算 ⇒ 渲染跟随。
  const ccWidgetRegistry = getCcWidgetRegistry()
  const ccRegistrySnapshot = createRegistrySignal(ccWidgetRegistry, () => ccWidgetRegistry.getSnapshot())
  const ccRoster = createMemo(() => resolveCcWidgetRoster(ccRegistrySnapshot().entries))
  const ccPluginWidgets = createMemo(() => ccRoster().entries.filter(entry => entry.source === 'plugin'))
  /** 活名单的拒绝与「渲染标识未命中」都不许静默 —— 经 workbench 诊断口上报（带原因）。 */
  const reportCcWidgetDiagnostic = (code: string, message: string, phase: 'resolve' | 'update') => {
    workbench.hostPort?.diagnostics.report({ code, message, phase })
  }
  createEffect(() => {
    for (const rejection of ccRoster().rejected) {
      reportCcWidgetDiagnostic('cc-widget.roster.rejected', rejection.reason === 'id-collision'
        ? `插件元件 id 与内置件冲突，登记被拒：${rejection.id}（插件 ${rejection.ownerPluginId}）`
        : `插件元件缺渲染声明，登记被拒：${rejection.id}（插件 ${rejection.ownerPluginId}）`, 'update')
    }
  })
  // ★ #266 刀3：最小高 = **按边算取最大**（算式见 ccHeightState.resolveCcMinHeight）——
  //   输入栏那一组（贴上边）与下边组（贴下边）各算"组高 + 到边距离"，两组取 **max**（不是 sum：
  //   输入栏是绝对定位、不占流），再与下界 64 取大。挂成 `--cc-min-height` 交给 CSS 消费。
  //   ★ 在场集合 = **两态各算一遍取 max**（`ccMinHeightInputOf(appearance())` 交出常态 + 空态两份
  //     切面，`resolveCcMinHeight` 逐态取大 ⇒ 下界由要求更高的那一份决定）：与落值侧 / 设置页同一口径
  //     —— 同一个值算两处，口径必须一致，否则会出现"存进去的值低于渲染出来的下界"。
  const minHeight = () => resolveCcMinHeight(ccMinHeightInputOf(appearance()))
  // ★ #266 刀2.5：宽度算式的输入 —— 件 id → 宽度字段值。只有三个触发器有宽度字段；
  //   用量胶囊 / 命令行提示是**内容撑**（`width:max-content`）⇒ 索引里缺席（算式按 0 计 = 下界）。
  const widthIndexOf = (): CcWidgetWidthIndex => ({
    model: appearance().modelWidth,
    reasoning: appearance().reasoningWidth,
    mode: appearance().permissionWidth,
  })
  // ★★ #266 刀2.5：**最小宽**（约束值）—— 与最小高同构：`max over 各组 ( 组宽 + 到所贴横边的距离 )`。
  //   本刀**只暴露、不强制**（不横向滚动、不撑宽，见规范 §7.6 形态决定 2）⇒ 没有任何 CSS 规则
  //   消费它，消费者留给刀 4 的"显示前校验"。挂成变量是为了让这个值可读、可验收。
  const minWidth = () => resolveCcMinWidth(resolveCcWidthGroups(hiddenWidgetIds(), widthIndexOf()))

  // ── ★★ #266 刀4：显示前校验（点"显示"前先判"显示之后装不装得下"） ─────────────────────
  /**
   * 校验输入 = **两态名单**（常态 / 空态）+ 数字字段 + 件宽索引。
   * ★ 名单由调用方给**"改完之后"**的那两份（`nextBase` / `nextExtra`）—— 判的必须是"点了之后"的态。
   * ★ 两态与最小高下界**同口径**（`ccMinHeightInputOf` 交出的那两份：常态 = 主管表 `ccHidden`、
   *   空态 = **主管 ∪ 再藏**）—— 本函数按 `isEmpty` 两态各取一次 `resolveCcHiddenWidgetIds`，
   *   与 `ccMinHeightInputOf` 的并集拼装逐字同源（退改 D1 之后两处才真的同口径）；
   *   纵向/横向都按它们各算一遍取大（实现见 `ccShowVerdict`）。
   */
  const showVerdictInputOf = (ccHidden: readonly string[], ccHiddenEmpty: readonly string[]): CcShowVerdictInput => ({
    hiddenSlices: [false, true].map(isEmpty => resolveCcHiddenWidgetIds({
      ccHidden, ccHiddenEmpty, isEmpty, cliHintMode: appearance().cliHintMode,
    })),
    scalars: appearance(),
    widths: widthIndexOf(),
  })
  /**
   * 校验用的**实测尺寸**（点下去的那一刻现读，不用信号里的旧值 —— 拖动高度时 `ResizeObserver`
   * 可能还没回调）。`0` ⇒ 校验 fail-open。
   */
  const measuredBox = () => ({
    width: controlCenterElement?.clientWidth ?? 0,
    height: controlCenterElement?.clientHeight ?? 0,
  })
  /**
   * ★★ #266 刀4：显隐开关的**唯一入口**（工具栏两个开关都走它）。
   *
   * 写"显示"方向前先过校验：`!ok` ⇒ **一条命令都不发**（主题数据一个字节不动），把结论挂成常驻提示。
   * ★ "藏"方向不校验：藏只会让在场集合变小 ⇒ 需求单调不增，不存在"藏了反而装不下"。
   * ★ 任何一次**成功**的写入都清掉上一次的提示（提示"常驻到下一个动作"）。
   */
  const requestHiddenChange = (id: CcLayoutWidgetId, hidden: boolean, target: CcVisibilityTarget) => {
    const current = appearance()
    // ★ 快照里的两份表是 `readonly`（`Object.freeze` 过）⇒ 写助手要的是可变形，故展开一份副本。
    const nextBase = target === 'base' ? setCcHiddenState([...current.ccHidden], id, hidden) : current.ccHidden
    const nextExtra = target === 'empty' ? setCcHiddenState([...current.ccHiddenEmpty], id, hidden) : current.ccHiddenEmpty
    if (!hidden) {
      const verdict = resolveCcShowVerdict(showVerdictInputOf(nextBase, nextExtra), measuredBox())
      if (!verdict.ok) {
        setShowWarning(verdict)
        return
      }
    }
    setShowWarning(undefined)
    workbench.appearance.dispatch({ type: 'set-cc-hidden', id, hidden, target })
  }
  // 提示常驻的清除之一：**切换选中元件**（点 chip / 关属性面板 / 退出编辑都改 `selected`）
  createEffect(() => {
    selected()
    setShowWarning(undefined)
  })
  // 提示常驻的清除之二：**尺寸变化后重判通过**（手动加高 / 拉宽够装了 ⇒ 提示自行退场，不必再点一次）
  // ★ 只在"量到了尺寸、且真的够装"时清 —— 量不到（0 / 未挂载）**不清**：
  //   "量不到"是环境问题，不该把用户刚看到的提示凭空抹掉（与 verdict 的 fail-open 是两件事：
  //   那边决定"放不放行"，这边只决定"提示还挂不挂着"）。
  createEffect(() => {
    const warning = showWarning()
    if (!warning) return
    const box = availableBox()
    const available = warning.axis === 'height' ? box.height : box.width
    if (Number.isFinite(available) && available > 0 && warning.needed <= available) setShowWarning(undefined)
  })
  /**
   * ★★ #266 刀2.5：**声明式脱离**的定位（横向）。
   *
   * 返回 `undefined` = 该行**没声明** `detachX` ⇒ 照旧排队（默认排布因此逐像素不变）。
   * 声明了才返回定位：距离 = 到**背景板横边**的距离（`.cc-body` 是最近的定位祖先，
   * 它的盒子就是背景板本体）；`position/bottom` 由 CSS 的 `.cc-widget.cc-detach-x` 给。
   */
  const detachStyle = (id: CcWidgetId): JSX.CSSProperties | undefined => {
    const detach = resolveCcWidgetGroup(id)?.detachX
    if (!detach) return undefined
    const gap = `${detach.gap ?? 0}px`
    if (detach.side === 'left') return { left: gap, right: 'auto' }
    if (detach.side === 'right') return { right: gap, left: 'auto' }
    return { left: '0', right: '0', 'margin-inline': 'auto' }
  }
  // ★ 按**落脚处**成组（#238 刀3）：同一 `(y.anchor, y.side)` 的元件归入同一个容器，组内按 order 排。
  //   进组前过一遍**输入栏落脚处独占守卫**（原「input 槽只准放输入栏」的替代）：
  //   非输入栏若被错标到输入栏容器，退回信息落脚处 —— 宁可换位置，不凭空消失。
  const landingOf = (id: CcWidgetId) => coerceInputLanding(id, ccWidgetLanding(id))
  const idsForLanding = (landing: string | undefined) => visibleIds()
    .filter(id => landingOf(id) === landing)
    .sort((left, right) => appearance().ccLayout.placements[left].order - appearance().ccLayout.placements[right].order)

  const createEmptySession = async (text: string, attachments: readonly WorkbenchAttachment[]) => {
    // 旧模型在这里按「左栏是否处于工作页签」拦截未选工作区的提交（`请先选择工作区`）。
    // 左栏已不再分互斥视图：不选工作区即创建一个无 cwd 会话，是合法意图，故守卫删除。
    if (submitting()) return false
    setSubmitting(true); setSubmitError('')
    try {
      const created = await workbench.commands.createSession({
        ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
        ...(modelId().trim() ? { model: modelId().trim() } : {}),
        reasoningLevel: reasoningLevel(),
        mode: mode() || modeOptions()[0] || 'default',
        initialPrompt: { text, attachments },
      })
      if (!created.sessionId) throw new Error('会话创建未返回有效标识')
      if (created.initialPromptOutcome) {
        const restoreInitialPrompt = (error: string) => {
          const ui = workbench.sessionUi.capture(created.sessionId)
          // A user may already have started the next message while the first
          // prompt was running. Only restore the failed prompt into an empty
          // composer; never overwrite newer input.
          ui.update('draft', '', current => current.trim() ? current : text)
          ui.update<readonly WorkbenchAttachment[]>('attachments', [], current => current.length > 0 ? current : attachments)
          ui.set('input-error', error)
        }
        void created.initialPromptOutcome.then(result => {
          if (result.status === 'rejected') restoreInitialPrompt(result.error || '首条请求发送失败')
        }, error => restoreInitialPrompt(errorMessage(error, '首条请求发送失败')))
      }
      return true
    } catch (error) {
      setSubmitError(errorMessage(error, '会话创建失败')); return false
    } finally { setSubmitting(false) }
  }
  const emptyComposer = createMemo(() => !input().sessionId ? {
    onSubmit: createEmptySession,
    submitting,
    after: <Show when={submitError()}>{message => <div class="solid-agent-empty-error" role="alert">{message()}</div>}</Show>,
  } : undefined)

  /**
   * ★★ #266 CC-13 刀1：渲染体搬进渲染层组件表（`createCcWidgetRenderers.solid.tsx`）——
   * 原先写死在这儿的 `renderBody` switch 退场；本组件只留「建表一次 + 按 id 取用」。
   * 表键 = 定义表全部 8 行的 id（`Record<CcWidgetGroupId, …>` 做**编译期全覆盖**）；
   * 两处特例（`.cc-bg` 背景板 / 发送按钮）的渲染体同样从表里取。
   * ★ 传进去的一律是**访问器**（不是取值）：Solid 响应性靠调用时机（见该文件的 ctx 纪律）。
   * ★ CC-13 刀2：`.cc-bg` 的 `data-cc-widget` 已常量化、发送按钮的在场门已撤（注册轨两件退役）。
   */
  const renderers = createCcWidgetRenderers({
    appearance,
    runtime,
    hasNoSession,
    modelId,
    setModelId,
    reasoningLevel,
    setReasoningLevel,
    mode,
    setMode,
    readonly,
    submitting,
    emptyComposer,
    predictionProvider: workbench.predictionProvider,
    sendButtonMode,
  })

  /** 刀1 渲染表的键查询（插件件的 `host-renderer` 走它；未命中 ⇒ 显式诊断占位，不静默）。 */
  const lookupHostRenderer = (rendererKey: string) =>
    (renderers as Record<string, (() => JSX.Element | null) | undefined>)[rendererKey]

  createEffect(() => {
    for (const entry of ccPluginWidgets()) {
      if (entry.render.kind === 'host-renderer' && !lookupHostRenderer(entry.render.rendererKey)) {
        reportCcWidgetDiagnostic('cc-widget.renderer.missing', `插件元件 ${entry.id} 的渲染标识未命中组件表：${entry.render.rendererKey}`, 'resolve')
      }
    }
  })

  const isDetached = (id: CcWidgetId) => resolveCcWidgetGroup(id)?.detachX !== undefined
  const renderWidget = (id: CcWidgetId) => {
    const placement = () => appearance().ccLayout.placements[id]
    const body = renderers[id]()
    if (body === null) return null
    return <div
      // ★ #266 刀2.5：声明了 `detachX` 的件挂 `cc-detach-x`（脱离队列，见 CSS）；未声明不挂。
      class={`cc-widget${id === 'input' ? '' : ' cc-natural'}${appearance().ccEditMode ? ' cc-edit' : ''}${selected() === id ? ' cc-selected' : ''}${isDetached(id) ? ' cc-detach-x' : ''}`}
      data-widget-id={id}
      data-widget-anchor={resolveCcWidgetGroup(id)?.layout?.y.anchor}
      style={{ ...detachStyle(id), ...placementStyle(placement()) }}
      onPointerDown={event => drag.beginWidgetDrag(event, id)}
    >{body}</div>
  }

  /**
   * ★★ #266 CC-13 刀2：插件件的渲染体（判别式分诊 —— `render` 是唯一入口）。
   * - `host-renderer`：查刀1 组件表（键 = `rendererKey`）；**未命中 ⇒ 显式诊断占位**（上面那条
   *   effect 同步上报），不静默画空白。
   * - `isolated-surface`：挂 `CcIsolatedWidget`（宿主接线 + §4 I/O 契约）。
   * ★ 本刀插件件**无位置内联样式、不参与拖动**（位置/拖动是刀 3 的事）。
   */
  const renderPluginWidget = (entry: CcWidgetRosterEntry): JSX.Element | null => {
    if (entry.render.kind === 'isolated-surface') {
      return <CcIsolatedWidget surfaceId={entry.render.surfaceId} readonly={readonly} submitting={submitting} />
    }
    const body = lookupHostRenderer(entry.render.rendererKey)
    return body
      ? body()
      : <div class="cc-widget-error" role="alert">{`未命中渲染器：${entry.render.rendererKey}`}</div>
  }

  const setProperty = (command: CcPropertyCommand) => workbench.appearance.dispatch(command)
  // 注册轨控件（`cc-send-button`）没有 WIDGET_PROPERTY_FIELDS 条目 —— 属性面板只给
  // 布局四项，它的外观字段在设置页编辑。
  // ★ #266 刀9：原先这里还有一层 `showIf` 过滤（按 `inputMode` 判明）；该字段已删除、
  //   全表也早已没有任何声明方 ⇒ 属性项一律常态显示。
  const propertyFields = (id: CcLayoutWidgetId) => {
    if (!(id in WIDGET_PROPERTY_FIELDS)) return []
    return WIDGET_PROPERTY_FIELDS[id as CcWidgetId]
  }
  const renderPropertyField = (field: WidgetPropertyField, index: number): JSX.Element | null => {
    if (field.kind === 'section') return <div class="cc-prop-sec" data-field-index={index}>{field.title}</div>
    const value = () => appearance().ccProperties[field.key]
    if (field.kind === 'color') return <div class="cc-prop-field"><label>{field.label}</label><input type="text" class="set-color-input" aria-label={field.label} value={String(value())} onChange={event => setProperty({ type: 'set-cc-property', key: field.key, value: event.currentTarget.value })} /></div>
    if (field.kind === 'number') return <div class="cc-prop-field"><label>{field.label}</label><input type="number" class="set-num" aria-label={field.label} value={Number(value())} min={field.min} max={field.max} step={field.step ?? 1} onInput={event => {
      const next = event.currentTarget.valueAsNumber
      if (Number.isFinite(next)) setProperty({ type: 'set-cc-property', key: field.key, value: Math.max(field.min, Math.min(field.max, next)) })
    }} />{field.suffix && <span>{field.suffix}</span>}</div>
    if (field.kind === 'chips') return <div class="cc-prop-field"><label>{field.label}</label><div class="set-preset-row"><For each={field.options}>{option => (
      <button type="button" class={`set-preset-chip${value() === option.value ? ' active' : ''}`} onClick={() => {
        // ★ #266 刀9：原先点 chips 还会连带写 `option.sync`（inputMode↔inputVariant 双写）；
        //   两个字段删除后该机制没有声明方 ⇒ 只写本字段。
        setProperty({ type: 'set-cc-property', key: field.key, value: option.value })
      }}>{option.label}</button>
    )}</For></div></div>
    return null
  }

  /**
   * 信息控件容器（#238 刀3）：**一个落脚处一个容器**，不再是三个槽位包装 div。组内按 `order` 排。
   *
   * ★ #238 刀5B：**分隔点整族删除**（用户口径「分割点可以不要」）—— 这里不再插入 `·`；
   *   配套删掉的还有 `.cc-widget-separator` 样式、ControlCenter.css 里两条旧 `::before`
   *   回落规则、以及 WorkbenchChrome.css 里专门压住它们的那处 `content:none !important`。
   */
  const statusGroup = () => <div class="cc-status-group" data-cc-landing={INFO_LANDING}>
    <For each={idsForLanding(INFO_LANDING)}>{id => renderWidget(id)}</For>
  </div>

  // Keep empty-state/edit-mode controls available for session setup and layout
  // editing; hide the legacy status widgets from the active conversation view.
  const showStatusSlots = () => emptyVisual() || appearance().ccEditMode
  // ★ #266 ⑰：状态行门户（`passesStatusGate`）已删 —— 它对 `visibleIds()` 里的每个 id **恒真**
  //   （输入栏走 `id === 'input'` 那一支，状态控件走常态放行名单那一支，而那份名单本来就等于全体
  //   状态控件）⇒ 作为过滤器从来不起作用。状态行内容改判"**该落脚处有没有可见件**"。
  //   ★ `showStatusSlots()` 保留：它是**语境侧**门户（口径合法），留住它才能让空态那个空容器的
  //   行为完全不变（空态无可见件也照旧渲染容器）。
  const statusRowContent = () => showStatusSlots() || idsForLanding(INFO_LANDING).length > 0

  onMount(() => {
    const slot = controlCenterElement?.querySelector<HTMLElement>('.cc-input-slot')
    if (!slot) return
    const update = () => {
      const width = slot.getBoundingClientRect().width || slot.clientWidth
      if (width > 0) controlCenterElement?.style.setProperty('--cc-input-text-inset-x', `${width * 0.05}px`)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(slot)
    onCleanup(() => observer?.disconnect())
  })
  /**
   * ★ #266 刀4：背景板**实测**尺寸 —— 显示前校验的 `available`（`.control-center` 的
   * clientWidth / clientHeight，含多行输入增高与状态行增高）。复用上一条同款机制
   * （同一个 `controlCenterElement` + 同一个 `ResizeObserver` API），**不新造测量层**。
   * ★ 实测不到（元素未挂载 / 测试环境无布局）⇒ 两个 0 ⇒ 校验 fail-open（见 `ccShowVerdict` 口径 3）。
   */
  onMount(() => {
    const element = controlCenterElement
    if (!element) return
    const update = () => setAvailableBox({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(element)
    onCleanup(() => observer?.disconnect())
  })

  // ★★ #266 刀5：根节点改成 **fragment** —— 编辑左列必须渲染在槽位**外面**。
  //   为什么：空态那条 `.is-empty { transform: translateY(-50%) }` 会给 `position:fixed` 的后代
  //   **建立包含块**（CSS Transforms 规范）⇒ 列会相对"中控那一条带"定位并被压扁（实测见开发记录）。
  //   槽位自身的几何、类名、`data-*`、内联变量**一个字节不动**（只是不再是根）。
  return <>
  <div
    ref={node => { controlCenterElement = node }}
    // ★ #266 刀9：`cli-mode` 常量类（原先由 `inputMode === 'cli'` 决定；输入已固定命令行）。
    class={`solid-workbench-control-center-slot control-center cli-mode${appearance().ccEditMode ? ' cc-editing' : ''}${emptyVisual() ? ' is-empty' : ''}${sessionEntering() ? ' is-session-entering' : ''}${submitting() ? ' is-session-creating' : ''}`}
    data-control-center="production"
    data-creation-state={sessionEntering() ? 'entering' : submitting() ? 'creating' : undefined}
    role={!input().sessionId ? 'region' : undefined}
    aria-label={!input().sessionId ? 'Agent 工作台空态' : undefined}
    aria-busy={!input().sessionId ? submitting() : undefined}
    style={{
      '--cc-height': `${appearance().ccHeight}px`,
      '--cc-min-height': `${minHeight()}px`,
      // ★ #266 刀2.5：最小宽（约束值）—— 与 `--cc-min-height` 同族，但**本刀不消费它**：
      //   不横向滚动、不撑宽（规范 §7.6 形态决定 2）。挂在这里是为了让值可读、可验收。
      '--cc-min-width': `${minWidth()}px`,
      '--cc-margin-x': `${appearance().ccMarginX}px`,
      '--cc-margin-bottom': `${appearance().ccMarginBottom}px`,
      '--cc-radius': `${appearance().ccRadius}px`,
      '--cc-surface-opacity': `${surfaceOpacityPercent()}%`,
      '--cc-surface': appearance().ccBg || 'transparent',
      '--cc-surface-image': toCssBackgroundImage(appearance().ccBgImage),
      '--cc-input-offset-top': `${appearance().inputOffsetTop}px`,
      '--cc-input-height': `${appearance().inputHeight}px`,
      '--cc-input-margin-x': `${appearance().inputMarginX}px`,
      '--cc-input-surface': appearance().inputSurfaceBg || 'transparent',
      '--cc-input-surface-opacity': `${inputSurfaceOpacityPercent()}%`,
      '--cc-input-focus-ring-enabled': appearance().inputFocusRingEnabled ? '1' : '0',
      '--cc-input-focus-ring-color': appearance().inputFocusRingColor || 'var(--accent)',
      '--cc-input-highlight-opacity': `${inputHighlightOpacityPercent()}%`,
      '--cc-input-shadow-enabled': appearance().inputShadowEnabled ? '1' : '0',
      '--cc-input-shadow': appearance().inputShadowEnabled
        ? '0 0 30px rgba(15,23,42,.22)'
        : 'none',
      // 光环独立于阴影（A6-1-FIX 1.3）：光环开启时只产出光环投影；关闭时不产出该变量，
      // CSS 侧 hover/focus-within 回退到常态投影（阴影关闭即无变化）。常态阴影开关只控制 --cc-input-shadow。
      '--cc-input-focus-ring-shadow': appearance().inputFocusRingEnabled
        ? '0 0 24px color-mix(in srgb, var(--cc-input-focus-ring-color, var(--input-focus-ring-color, var(--accent))) 55%, transparent)'
        : undefined,
      '--cc-input-radius': `${appearance().inputRadius}px`,
      '--cc-input-border': appearance().inputBorder || 'transparent',
      '--cc-input-border-width': `${appearance().inputBorderWidth}px`,
      '--cc-input-border-opacity': `${inputBorderOpacityPercent()}%`,
      '--cc-input-font-size': `${appearance().inputFontSize}px`,
      '--cc-input-line-height': appearance().inputLineHeight,
      '--cc-input-text': appearance().inputTextColor,
      '--cc-input-placeholder': appearance().inputPlaceholder,
      '--cc-send-size': `calc(var(--cc-input-height) * ${sendButtonMode() === 'inline' ? '0.8' : '1'})`,
      // ★ #238 刀3：发送按钮「右侧偏移」的来源改成定义表（`layout.x.gap`；
      //   现在是 0，所以像素与改造前完全一致）。剩下的 `calc()` 是"贴输入栏哪一侧"
      //   的**档位**（inline/external）与运行期尺寸（输入栏高/按钮大小），不是可声明的常量。
      '--cc-send-anchor-gap': `${resolveCcWidgetGroup('cc-send-button')?.layout?.x.gap ?? 0}px`,
      '--cc-send-color': appearance().sendButtonColor,
      '--cc-send-radius': `${Number(appearance().sendButtonRadius || '0.5') * 100}%`,
      // ★ #266 遗留②：边框色 / 图标色改自由选色 ⇒ 直读字段值，不再把枚举翻成颜色。
      '--cc-send-border-color': appearance().sendButtonBorderColor,
      '--cc-send-icon-color': appearance().sendButtonIconColor,
      '--cc-input-text-right-inset': sendButtonMode() === 'inline'
        ? 'calc(var(--cc-input-height) * 0.9 + var(--cc-input-text-inset-x, 5%))'
        : 'var(--cc-input-text-inset-x, 5%)',
    }}
  >
    <Show when={appearance().ccEditMode}><div
      class="cc-edit-hdr"
      role="separator"
      aria-label="调整中控高度"
      aria-orientation="horizontal"
      aria-valuemin={minHeight()}
      aria-valuemax="400"
      aria-valuenow={appearance().ccHeight}
      tabIndex="0"
      onPointerDown={drag.beginHeightDrag}
      onKeyDown={event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        workbench.appearance.dispatch({ type: 'set-cc-height', height: appearance().ccHeight + (event.key === 'ArrowUp' ? 4 : -4) })
      }}
    ><div class="cc-edit-hdr-bar" /><span class="cc-edit-hdr-label">{appearance().ccHeight}px</span></div></Show>
    {renderers['cc-surface']()}
    <Show when={sendButtonMode()}>{renderers['cc-send-button']()}</Show>
    <div class="cc-input-shadow-clip" aria-hidden="true" />
    <div class="cc-body">
      <Show when={selectorPending()}><span role="status" aria-live="polite">{selectorPending()}</span></Show>
      {/* ★ #266 刀11：`footerLayout` 字段删除 ⇒ 只保留「独立状态行」这一种结构
          （原 peri 分支的 `.cc-footer-peri` 包装 div 与相关 CSS 一并退场）。
          元件位置不新增任何机制：仍由定义表的 layout 声明 + 区域预设记的值决定。 */}
      <div class="cc-input-slot"><For each={idsForLanding(INPUT_LANDING)}>{renderWidget}</For></div>
      {/* ★★ #266 CC-13 刀2：插件件默认**排最后** —— 追加在状态区末尾（本刀不写位置、不参与拖动；
          位置与拖动是刀 3 的事）。无插件登记时这一段不产任何 DOM（内置件零回归的前提）。 */}
      <div class="cc-status-row">
        <Show when={statusRowContent()}>{statusGroup()}</Show>
        <For each={ccPluginWidgets()}>{entry => <div class="cc-widget" data-widget-id={entry.id}>{renderPluginWidget(entry)}</div>}</For>
      </div>
    </div>
  </div>
  {/* ★★ #266 刀5：编辑清单 = **左侧一列**（一列到底 · 行内展开），替换刀4 的底部横栏 + 独立属性面板。
      显示条件 = **编辑态**（与空态无关）⇒ 空态下进编辑器同样在（见 WorkbenchChrome.css 的两条空态规则）。
      语义：这是一份**列表/面板**，**不是** `role="toolbar"`（刀4 的提示留在它内部、不落在工具栏语义里）。 */}
  <Show when={appearance().ccEditMode}>
    <div class="cc-edit-column" role="group" aria-label="中控元件">
      <div class="cc-edit-column-header">中控元件</div>
      <div class="cc-edit-column-list">
        <For each={CC_EDIT_TOOLBAR_IDS}>{id => {
          // ① 行首的 `＋/●` + `dim`：按**当前生效名单**（门决定）——「你眼下看到的样子」
          const hidden = () => hiddenWidgetIds().includes(id)
          // ② 两个开关各读**自己那一份表**（不要用合并后的名单判某个开关的态，
          //    否则"我在哪个状态改的"这种隐性依赖会从后门回来）
          const baseHidden = () => appearance().ccHidden.includes(id)
          const extraHidden = () => appearance().ccHiddenEmpty.includes(id)
          return <div class={`cc-edit-row${selected() === id ? ' active' : ''}${hidden() ? ' dim' : ''}`}>
            <div class="cc-edit-row-main">
              <button type="button" class="cc-edit-row-name" aria-label={`${CC_WIDGET_LABELS[id]} 属性`} onClick={() => setSelected(selected() === id ? undefined : id)}>{hidden() ? '＋' : '●'} {CC_WIDGET_LABELS[id]}</button>
              {/* 开关①「隐藏 / 显示」= **主管表**（两种状态都生效） */}
              <button type="button" class="cc-chip-toggle" aria-label={`${baseHidden() ? '显示' : '隐藏'} ${CC_WIDGET_LABELS[id]}`} onClick={() => requestHiddenChange(id, !baseHidden(), 'base')}>{baseHidden() ? '显示' : '隐藏'}</button>
              {/* 开关②「空态里再藏 / 空态放出」= **再藏表**（只在空态再加一层；只能加不能抵消） */}
              <button type="button" class="cc-chip-toggle extra" aria-label={`${extraHidden() ? '空态放出' : '空态里再藏'} ${CC_WIDGET_LABELS[id]}`} onClick={() => requestHiddenChange(id, !extraHidden(), 'empty')}>{extraHidden() ? '空态放出' : '空态里再藏'}</button>
            </div>
            {/* 行内展开区：**同一时刻只有一行** —— 展开态就是 `selected` 那一份真值
                （点行 ⇒ 选中并展开；点另一行 ⇒ 换过去；再点同一行 ⇒ 收起）。
                `role="dialog"` + 名字沿用改造前的属性面板，不新增无障碍契约。 */}
            <Show when={selected() === id}>
              <div class="cc-edit-row-props" role="dialog" aria-label={`${CC_WIDGET_LABELS[id]} 属性`}>
                <div class="cc-prop-sec">布局</div>
                <div class="cc-prop-field"><label>顺序</label><input type="number" class="set-num" aria-label="控件顺序" min="0" max="99" step="1" value={appearance().ccLayout.placements[id].order} onInput={event => {
                  const value = event.currentTarget.valueAsNumber
                  if (Number.isFinite(value)) drag.updatePlacement(id, { order: value })
                }} /></div>
                <div class="cc-prop-field"><label>水平微调</label><input type="number" class="set-num" aria-label="水平微调" min="-48" max="48" step="1" value={appearance().ccLayout.placements[id].offsetX} onInput={event => {
                  const value = event.currentTarget.valueAsNumber
                  if (Number.isFinite(value)) drag.updatePlacement(id, { offsetX: value })
                }} /><span>px</span></div>
                <div class="cc-prop-field"><label>垂直微调</label><input type="number" class="set-num" aria-label="垂直微调" min="-16" max="16" step="1" value={appearance().ccLayout.placements[id].offsetY} onInput={event => {
                  const value = event.currentTarget.valueAsNumber
                  if (Number.isFinite(value)) drag.updatePlacement(id, { offsetY: value })
                }} /><span>px</span></div>
                <For each={propertyFields(id)}>{(field, index) => renderPropertyField(field, index())}</For>
              </div>
            </Show>
          </div>
        }}</For>
      </div>
      {/* ★ #266 刀4：显隐被拒时的提示（常驻到下一个动作），列内、列底按钮之上。
          `role="alert"` 让它被读屏播报；数字全部来自 verdict。 */}
      <Show when={showWarning()}>{warning => (
        <div class="cc-edit-warning" role="alert">
          {`还差 ${warning().needed - warning().available}px：需要 ${warning().needed}px，当前 ${warning().available}px —— ${warning().axis === 'height' ? '先加高，或先藏别的' : '先把窗口拉宽，或先藏别的'}`}
        </div>
      )}</Show>
      {/* ★ #266 刀5：**唯一**的退出入口 —— 改造前有**两处**（属性面板 footer 的「退出自定义」
          与这枚「退出编辑」），本刀收敛到一处。 */}
      <div class="cc-edit-column-footer">
        <button type="button" class="cc-edit-column-btn" aria-label="重置控件位置" onClick={() => workbench.appearance.dispatch({ type: 'reset-cc-layout' })}>↺ 重置位置</button>
        <button type="button" class="cc-edit-column-btn danger" aria-label="退出中控编辑" onClick={() => {
          setSelected(undefined)
          workbench.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: false })
        }}>退出编辑</button>
      </div>
    </div>
  </Show>
  </>
}

function placementStyle(placement: CcWidgetPlacement): JSX.CSSProperties {
  return placement.offsetX === 0 && placement.offsetY === 0
    ? {}
    : { transform: `translate(${placement.offsetX}px, ${placement.offsetY}px)` }
}
