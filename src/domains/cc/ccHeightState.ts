import {
  CC_FLOATING_WIDGET_IDS,
  CC_WIDGET_GROUPS,
  ccWidgetLanding,
  coerceInputLanding,
  isWidgetVisible,
  STATUS_WIDGET_IDS,
  type CcNumberPropertyKey,
} from './widgetDefinitions.ts'

/**
 * 快捷提示详细档（`cliHintMode`）—— 唯一还活着的「形态」类字段。
 * ★ #266 刀9/刀10/刀11：`CcInputMode` / `CcFooterLayout` / `CcOverflowMode` 三个类型已随
 *   对应字段删除（输入固定命令行、底部信息固定独立状态行、多行输入固定「随内容增高 + 3 倍封顶」）。
 */
export type CcHintMode = 'hidden' | 'compact' | 'full' | string

export const INPUT_LINE_HEIGHTS = ['0.5', '1', '1.5'] as const
export type InputLineHeight = (typeof INPUT_LINE_HEIGHTS)[number]

export function clampInputTypography<T extends { inputFontSize: number; inputLineHeight: string; inputHeight: number }>(theme: T, changedKey?: string): T {
  let inputFontSize = Math.round(Number(theme.inputFontSize))
  let inputLineHeight = INPUT_LINE_HEIGHTS.includes(theme.inputLineHeight as InputLineHeight)
    ? theme.inputLineHeight as InputLineHeight : '1'
  const effectiveHeight = Math.max(0, theme.inputHeight * 0.8)
  const fits = (size: number, line: InputLineHeight) => size * (1 + Number(line)) < effectiveHeight

  if (changedKey === 'inputHeight') {
    // Height edits never alter typography. Raise the height only as far as
    // needed for strict `occupied < 0.8 * height` validity.
    const occupiedHeight = inputFontSize * (1 + Number(inputLineHeight))
    const minInputHeight = Math.floor(occupiedHeight * 1.25) + 1
    return {
      ...theme,
      inputFontSize,
      inputLineHeight,
      inputHeight: Math.max(theme.inputHeight, minInputHeight),
    }
  }

  if (changedKey === 'inputFontSize') {
    // When the font size changes, preserve the selected line height and only
    // reduce the font size until the current typography fits.
    while (inputFontSize > 12 && !fits(inputFontSize, inputLineHeight)) inputFontSize -= 1
  } else if (changedKey === 'inputLineHeight') {
    // When the line height changes, lower it first (1.5 -> 1 -> 0.5), then
    // reduce the font size if even the smallest line height still overflows.
    while (!fits(inputFontSize, inputLineHeight)) {
      const idx = INPUT_LINE_HEIGHTS.indexOf(inputLineHeight)
      if (idx > 0) inputLineHeight = INPUT_LINE_HEIGHTS[idx - 1]
      else if (inputFontSize > 12) inputFontSize -= 1
      else break
    }
  } else {
    // For other changes, preserve a fitting typography and apply the same
    // line-height-before-font-size fallback when needed.
    while (!fits(inputFontSize, inputLineHeight)) {
      const idx = INPUT_LINE_HEIGHTS.indexOf(inputLineHeight)
      if (idx > 0) inputLineHeight = INPUT_LINE_HEIGHTS[idx - 1]
      else if (inputFontSize > 12) inputFontSize -= 1
      else break
    }
  }
  return {
    ...theme,
    inputFontSize,
    inputLineHeight,
    inputHeight: Math.max(theme.inputHeight, inputFontSize * (1 + Number(inputLineHeight))),
  }
}

export function resolveVisibleStatusWidgetCount({
  hiddenIds,
}: {
  /** 隐藏名单（**组装好的**：生效的那份切面 + 详细档折叠，见 `resolveCcHiddenWidgetIds`） */
  hiddenIds: readonly string[]
}): number {
  // C2：与渲染共用一个可见性谓词。★ #266 ⑰ 后可见性**只由隐藏名单决定** ——
  //   元件的行上不再有任何显隐申明，也不再有运行期条件 ⇒ 谓词的上下文只剩 `hidden`。
  //   名单的组装**只有一处**（`resolveCcHiddenWidgetIds`：门选一份切面 + 详细档折叠），渲染侧与这里同源，
  //   否则会出现"计数多算一个不渲染的元件"（正是 C2 要防的）。
  return STATUS_WIDGET_IDS.filter(id => isWidgetVisible(id, { hidden: hiddenIds })).length
}

const BASE_MIN_HEIGHT = 64

/**
 * 一行的**行高兜底**（CSS 给的下限）：`.cc-status-row` 的 `min-height`。
 *
 * 真值出处：`src/index.css:66` 的 `--ui-control-compact: 28px`，被
 * `…/ControlCenter.css:322` 的 `.cc-status-row { min-height: var(--ui-control-compact) }` 消费
 * （同文件 `:118` 那条 `min-height:18px` 被它覆盖；两处都 ≥18 ⇒ 规范 §7.2 的"≥18px"仍成立）。
 * ★ 输入栏那一格另有一条 `min-height:32px`（`.control-center.cli-mode .cc-input-slot`）——
 *   本算式**不逐格追 CSS 兜底**（那是渲染真值），两处统一取 28 ⇒ 结果对输入栏那一组是**下界**。
 */
const ROW_MIN_HEIGHT = 28

/**
 * 所贴竖边 → 该组「到那条边的距离」从哪个字段取。
 * 今天只有上（输入栏 / `inputOffsetTop`）与下（下边组 / `ccMarginBottom`）两处；
 * 其它方位（`center` / `stretch`）取不到值 ⇒ 按 0（现状没有这样的组）。
 */
const VERTICAL_EDGE_FIELD: Readonly<Record<string, CcMinHeightScalarKey | undefined>> = {
  top: 'inputOffsetTop',
  bottom: 'ccMarginBottom',
}

/**
 * ★★ CC-13 刀5 接续：**每个落脚处在定义表里声明的「到所贴边的距离」**（静态派生，**与"谁在场"无关**）。
 *
 * - 竖向 = **字段名**（值仍要到主题数字表里取）：按该落脚处的 `layout.y.side` 查 `VERTICAL_EDGE_FIELD`；
 * - 横向 = **字面值**：该落脚处各行 `layout.x.gap` 的最大值（今天全行缺省 ⇒ 0）。
 *
 * ★ 为什么要有这张表：边距是**落脚处**的属性，不是"在场那几件"的属性。插件件把某个落脚处的内置件
 *   全挤走（例如空态默认：内置状态件全藏在 `ccHiddenEmpty`、只剩插件件）时，该落脚处仍贴同一条边
 *   ⇒ 新建组 / 队列的 `edgeGap` 必须取这里的声明值，而不是 0（否则下界少算一个边距，
 *   实机读数 120 而正确值 135）。修正前的写法是"从在场行里取"，于是"谁在场"决定了边距 —— 已改。
 *
 * ★ 等价性（内置读数逐位不变）：落脚处键本身就是 `y.anchor:y.side` ⇒ 同一落脚处的行**同 side**
 *   （竖向取到同一个字段）且 `layout.x.gap` 的声明相同 ⇒ 本表取到的值与"在内置行里取 max"逐位相等；
 *   仅当该落脚处**无任何内置件在场**时两者才分道（正是本接续要修的那一处）。
 */
const LANDING_EDGE_FIELDS: Readonly<Record<string, { verticalField?: CcMinHeightScalarKey; horizontalGap: number }>> =
  (() => {
    const fields: Record<string, { verticalField?: CcMinHeightScalarKey; horizontalGap: number }> = {}
    for (const row of CC_WIDGET_GROUPS) {
      if (row.type !== 'widget' || !row.draggable || !row.layout) continue
      const landing = ccWidgetLanding(row.id) ?? row.id
      fields[landing] = {
        verticalField: VERTICAL_EDGE_FIELD[row.layout.y.side],
        horizontalGap: Math.max(fields[landing]?.horizontalGap ?? 0, row.layout.x.gap ?? 0),
      }
    }
    return fields
  })()

/** 该落脚处声明的竖向边距（px）：字段值取不到 / 非有限 ⇒ 0（"缺项按 0"的既有纪律）。 */
function declaredVerticalEdgeGap(landing: string, scalars: CcMinHeightScalars): number {
  const field = LANDING_EDGE_FIELDS[landing]?.verticalField
  const value = field ? scalars[field] : undefined
  return Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0)
}

/** 该落脚处声明的横向边距（px）：无声明 ⇒ 0（今天全行缺省 ⇒ 恒 0）。 */
function declaredHorizontalEdgeGap(landing: string): number {
  return Math.max(0, LANDING_EDGE_FIELDS[landing]?.horizontalGap ?? 0)
}

/** 竖向上参与「最小高」竞争的一个**组**（与最小宽那套同构，取法相反：高度取 max、宽度取 sum）。 */
export interface CcMinHeightGroup {
  /** 组的标识（诊断/读数用）：`landing:<落脚处>`（落脚处 = `y.anchor:y.side`） */
  readonly id: string
  /** 该组的**高**（px）—— 组内件**并排** ⇒ 各件高之**最大**（都算不出高时取行高兜底） */
  readonly height: number
  /** 该组到所贴竖边的距离（px）：上边组 = `inputOffsetTop`、下边组 = `ccMarginBottom` */
  readonly edgeGap: number
}

/**
 * 算式用到的数字字段集：
 * - **件高字段** = 各可拖行声明的 `heightField`（键型 `CcNumberPropertyKey`）；
 * - **贴边距离** = 上边 `inputOffsetTop`（本身就是输入栏的属性字段）+ 下边 `ccMarginBottom`
 *   （它是**容器**外观字段，不在 `CcNumberPropertyKey` 里 ⇒ 单列进来）。
 * ★ 只列这两个距离，是因为"所贴竖边 → 字段"目前只有上/下两处（`VERTICAL_EDGE_FIELD`）。
 */
export type CcMinHeightScalarKey = CcNumberPropertyKey | 'ccMarginBottom'

/** 竖向算式的输入里那一份"主题数字字段表"（结构性类型 ⇒ 主题本体可直接传）。 */
export type CcMinHeightScalars = Partial<Record<CcMinHeightScalarKey, number>>

/**
 * ★★ #266 CC-13 刀5：参与「最小高 / 最小宽 / 显示前校验」算式的**插件件**。
 *
 * - 两维都可选（px）：报了 ⇒ 计入；**不报 / 非有限 / ≤0 ⇒ 该维按 0 计**（= 内置「内容撑」件同待遇，
 *   结果是**下界**）。定形与校验在 `ccWidgetRoster.resolvePluginWidgetSizing`（非法 ⇒ 忽略该维度 + 诊断）。
 * - 插件件一律按「落点 = **状态区**（`ccWidgetLanding('model')`，与渲染同源）、可拖、不悬浮、
 *   无 `detachX`、无 `gap`」参与：高并入状态组**取 max**、宽并入状态队列**求和不带间距**
 *   （声明式口径：不去实测渲染尺寸，避免渲染 ↔ 算式回环）。
 * - **在场判据** = `isWidgetVisible(id, { hidden })` —— 由算式按**切面**逐条过滤（与渲染同一谓词），
 *   所以隐藏的插件件不计数；调用方递进来的应当是**全量**插件件（不要先自己筛一遍，
 *   否则两态/改后态各算一遍时会把"换个态就看不见的件"算进去）。
 */
export interface CcPluginWidgetSizing {
  readonly id: string
  readonly width?: number
  readonly height?: number
}

/**
 * 插件件的落脚处 = **状态区**（与渲染、`ccWidgetRoster.STATUS_LANDING` 同源派生）。
 * 状态区那一行的行高/宽本来就由此落脚处成组（`model` / `reasoning` / `mode` / `tokens` / `cc-command-hint`）。
 */
const PLUGIN_WIDGET_LANDING = ccWidgetLanding('model') ?? 'model'

/**
 * 该维的**声明值**（px）：只有**有限且 > 0** 的数才算报过；其余（缺省 / 非数 / ≤0 / 非有限）
 * 一律 `undefined` ⇒ 调用方按 0 计（下界）。定形处已拦过一遍，这里是算式的**自身防线**。
 */
function declaredDimension(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 最小高算式的输入。
 *
 * - `hiddenSlices` = **两态各自生效的隐藏名单**（常态 `ccHidden` / 空态 `ccHiddenEmpty`）；算式对每一态各算一遍、
 *   取 **max**（理由见 `resolveCcMinHeight` 的"两态取 max"）；
 * - `scalars` = 主题的数字字段表（**结构性类型** ⇒ `ThemeSettings` / `Partial<ThemeSettings>`
 *   可直接传）。算式只按定义表的 `heightField` 声明取用，**缺项按 0 计**（= 内容撑 ⇒ 结果是下界）。
 * - ★ 刀5：`pluginWidgets` = 插件件及其自报尺寸（缺省 `[]` ⇒ 与改造前**逐位相同**）；
 *   在场判据按每一态各自的名单在算式内过滤（见 `CcPluginWidgetSizing`）。
 */
export interface CcMinHeightInput {
  readonly hiddenSlices: readonly (readonly string[])[]
  readonly scalars: CcMinHeightScalars
  readonly pluginWidgets?: readonly CcPluginWidgetSizing[]
}

/**
 * 主题形态 → 算式输入（**唯一一处拼装**，免得各调用面各拼一份）。
 *
 * 泛型 + 结构性约束：`ThemeSettings` / `Partial<ThemeSettings>` / `ThemePresetState` 都可直接传。
 *
 * ★ #266 刀4（结构 C）的两态：常态 = `ccHidden`（**主管表**）、空态 = **主管 ∪ 再藏**
 *   （`ccHidden ∪ ccHiddenEmpty`，去重）—— 与取值侧（`resolveCcHiddenWidgetIds`）**同源同义**：
 *   空态的第二份表**只能加、不能抵消**，所以并集才是空态真正的生效名单。
 *   ★ 稀疏输入（`Partial<ThemeSettings>`、老数据、夹具）里 `ccHiddenEmpty` 缺省 ⇒ 视作空 ⇒
 *     空态 = 主管（`?? []`），**不再**是旧口径的"回落常态切面"那一套说法。
 * `scalars` 的取值口径仍由算式把关（按定义表的 `heightField` 声明取、非数字按 0）。
 *
 * ★★ 退改 D1（2026-09-29，翻译验收后）：第二份切片**必须**是并集，否则下界与校验口径不一致。
 *   探针实测（主管表藏掉 `input`、输入栏高 120）：并集口径下界 = **64**，旧口径 = **130**（偏高 66px）
 *   —— 用户可见后果是「藏了输入栏容器降不下来」。出厂数据"再藏 ⊇ 主管"掩盖了它，
 *   只有主管表藏了"再藏表里没有的件"（`input` 恰是其一）时才暴露。
 * ★ 刀5：`pluginWidgets` 由调用方（渲染层）递进 —— 它不属主题，故不进泛型约束；缺省 `[]` ⇒ 逐位不变。
 */
export function ccMinHeightInputOf<T extends {
  readonly ccHidden?: readonly string[]
  readonly ccHiddenEmpty?: readonly string[]
}>(theme: T, pluginWidgets: readonly CcPluginWidgetSizing[] = []): CcMinHeightInput {
  const normal = theme.ccHidden ?? []
  const emptyState = Array.from(new Set([...normal, ...(theme.ccHiddenEmpty ?? [])]))
  return {
    hiddenSlices: [normal, emptyState],
    scalars: theme as unknown as CcMinHeightScalars,
    pluginWidgets,
  }
}

/**
 * ★★ 中控区**最小高**（#266 刀3 · 精确版）：
 *
 * ```text
 * min_height = max( BASE_MIN_HEIGHT,
 *                   max( 算式(常态切面在场集合), 算式(空态切面在场集合) ) )
 *
 * 其中 算式(某态在场集合) = max over 该态各组 ( 该组高 + 该组到所贴竖边的距离 )
 *   上边组 = inputOffsetTop + 输入栏组高；下边组 = ccMarginBottom + 下边组高
 * ```
 *
 * 四条口径（都是**逻辑**，不是"看起来对不对"）：
 * 1. **两组取 max，不是 sum** —— 输入栏是 `position:absolute`（浮起、**不占流**）
 *    ⇒ 两块可"上下错开占同一段垂直空间"（`ControlCenter.css:89-96`）。这与横向"允许重叠"是同一条
 *    空间口径，两个方向都取 max（规范 §7.6）。
 * 2. **行数恒为 1** —— #266 刀2.5 已去掉下边组的折行 ⇒ 组高 = 该行在场件的**最大高**，
 *    **不需要**任何"折行档 / 件数阈值"（旧实现那套"在场件数 > 4 再加一行"的估算整体退场）。
 * 3. ★ **两种门态取 max**（用户 2026-09-28 定）—— 为什么不是"只按一份名单算"：两份名单本来就不同
 *    （刀4 结构 C 下：常态 = 主管表、空态 = 主管 ∪ 再藏），**各算一遍取 max** 是"两种门态都成立"的
 *    直接写法；只算一份就会漏掉另一份 ⇒ 显示时可能超界。
 *    ★ 这仍然是**同一批运算**跑两遍（同一算式、同一批声明），只是喂进两份名单 —— 仍是"预设值 + 一道门"
 *    两层，**没有引入新概念、新字段、新阈值**：两份名单本来就是切面的产物，门本来就是"现在是不是空态"。
 *    ★ 口径订正（退改 D1）：旧说法"空态切面是自由的、可以比常态在场更多"在 C 下**不再成立** ——
 *      再藏只能加、不能抵消 ⇒ **空态在场 ⊆ 常态在场**（`ccMinHeightInputOf` 已按并集拼装）。
 *      取 max 这条规则不变（两份名单仍可能不同），但绑定项实际落在**常态**那一份上。
 * 4. **`BASE_MIN_HEIGHT` 是下界（乘底）** —— 两态都算不出大值时它就是结果；它不是替代品。
 *
 * ★ 本刀**取代**了刀 9~11 的"形态收敛 ⇒ 常量 64"：那是把估算换成常量，本刀把估算升级成
 *   **按件字段 + 趟数可算的算式**（输入清单见规范 §七：主件都有 Height 字段）。
 * ★ 出厂 10 套预设两态切面**同值**（常态藏 `cc-send-button`、空态藏那 6 件；空态是常态的超集）
 *   ⇒ 判据换口径后**观感不产生新变化**（实机读数：默认口径仍 64、出厂数据仍 85）。
 * ★ 纯函数：只读入参（同输入同输出）。渲染侧把它挂成 `--cc-min-height`
 *   （`.control-center { min-height: var(--cc-min-height) }` 是真正的消费者），落值侧用它当 clamp 下界。
 */
export function resolveCcMinHeight(input: CcMinHeightInput): number {
  const slices = input.hiddenSlices.length > 0 ? input.hiddenSlices : [[]]
  return slices.reduce(
    (max, hiddenIds) => Math.max(max, sliceHeightRequirement(hiddenIds, input.scalars, input.pluginWidgets ?? [])),
    BASE_MIN_HEIGHT,
  )
}

/** 单态的"按边算"需求（`max over 该态各组 ( 组高 + 到边距离 )`；**不含** `BASE_MIN_HEIGHT`）。 */
function sliceHeightRequirement(
  hiddenIds: readonly string[],
  scalars: CcMinHeightScalars,
  pluginWidgets: readonly CcPluginWidgetSizing[],
): number {
  return resolveCcHeightGroups(hiddenIds, scalars, pluginWidgets)
    .reduce((max, group) => Math.max(max, group.height + group.edgeGap), 0)
}

/**
 * 从「**某一态**的隐藏名单 + 主题数字字段」派生竖向上参与竞争的组（= `resolveCcMinHeight` 的单态输入）。
 *
 * 签名与最小宽那边的 `resolveCcWidthGroups(hiddenIds, widths)` 同形（同一族、同一种读法）。
 *
 * 口径（全部从定义表读，不另立第二份规则）：
 * - **组 = 竖向落脚处**（`y.anchor:y.side`，与渲染成组同源）；组高 = 组内**在场**件高的**最大**，
 *   件高取自该行声明的 `heightField`（缺省 / 缺值 ⇒ 0）；组内件都算不出高时取行高兜底 `ROW_MIN_HEIGHT`；
 * - **悬浮件**（发送按钮）不占流 ⇒ 不参与（它骑在输入栏上，高度跟 `--cc-send-size` 走）；
 * - **不在场的件不计入**（"谁在场" = 谓词，与渲染同源 ⇒ 与"计数多算一个不渲染的件"是同一道防线）；
 * - 组级 `edgeGap` 按所贴竖边取字段（上 = `inputOffsetTop`、下 = `ccMarginBottom`）；
 * - ★ 刀5：**插件件**并入状态区组（`PLUGIN_WIDGET_LANDING`）**取 max**（并排语义）——
 *   只有"报了 height"的件才建组/抬值（不报按 0 计 ⇒ 不许凭空建出一个 28 的行兜底组）；
 *   组已存在时不动它的 `edgeGap`，由插件件**新建**该组时按该落脚处**在定义表里声明的边距**给初值
 *   （★ 刀5 接续：边距属**落脚处**、不属"在场的那几件" ⇒ 插件件独占总也照算 `ccMarginBottom`）。
 */
export function resolveCcHeightGroups(
  hiddenIds: readonly string[],
  scalars: CcMinHeightScalars,
  pluginWidgets: readonly CcPluginWidgetSizing[] = [],
): CcMinHeightGroup[] {
  const groups = new Map<string, { height: number; edgeGap: number }>()
  for (const row of CC_WIDGET_GROUPS) {
    if (row.type !== 'widget' || !row.draggable || !row.layout) continue
    if (CC_FLOATING_WIDGET_IDS.includes(row.id)) continue
    if (!isWidgetVisible(row.id, { hidden: hiddenIds })) continue
    const landing = coerceInputLanding(row.id, ccWidgetLanding(row.id)) ?? row.id
    const group = groups.get(landing) ?? { height: 0, edgeGap: declaredVerticalEdgeGap(landing, scalars) }
    const declared = row.heightField ? scalars[row.heightField] : undefined
    // 件并排 ⇒ 组高取**最大**（不是求和；宽度那边同组的件也是并排，但算的是宽之和）
    group.height = Math.max(group.height, typeof declared === 'number' && Number.isFinite(declared) ? declared : 0)
    const edgeField = VERTICAL_EDGE_FIELD[row.layout.y.side]
    const edgeValue = edgeField ? scalars[edgeField] : undefined
    group.edgeGap = Math.max(group.edgeGap, typeof edgeValue === 'number' && Number.isFinite(edgeValue) ? edgeValue : 0)
    groups.set(landing, group)
  }
  for (const widget of pluginWidgets) {
    if (!isWidgetVisible(widget.id, { hidden: hiddenIds })) continue
    const declared = declaredDimension(widget.height)
    if (declared === undefined) continue
    const group = groups.get(PLUGIN_WIDGET_LANDING)
      ?? { height: 0, edgeGap: declaredVerticalEdgeGap(PLUGIN_WIDGET_LANDING, scalars) }
    group.height = Math.max(group.height, declared)
    groups.set(PLUGIN_WIDGET_LANDING, group)
  }
  return [...groups].map(([landing, group]) => ({
    id: `landing:${landing}`,
    height: Math.max(ROW_MIN_HEIGHT, group.height),
    edgeGap: group.edgeGap,
  }))
}

/**
 * 高度 clamp：区间 `[最小高（算式）, 400]`；非有限值回落到**最小高**（既有语义，未变）。
 * ★ 下界来自 `resolveCcMinHeight`（算式），不再是常量 —— 这是刀 3 的落点之一。
 */
export function clampCcHeight(height: number, input: CcMinHeightInput): number {
  const min = resolveCcMinHeight(input)
  const safeHeight = Number.isFinite(height) ? height : min
  return Math.max(min, Math.min(400, safeHeight))
}

// ── ★★ #266 刀2.5：横向 —— 最小宽（与上面那套**同构**，本文件因此两个方向都管） ──────────

/**
 * 横向上参与「最小宽」竞争的一个**组**。
 *
 * 「组」与最小高那边**同源**（一个横向落脚处 = `ccWidgetLanding`），但**取法不同**：
 * 同组的件是**并排**的 ⇒ 组宽 = 各件宽之**和**（高度那边是同一行里的件取**最大**）。
 */
export interface CcMinWidthGroup {
  /** 组的标识（诊断/读数用）：队列组 = `queue:<落脚处>`，脱离件 = 元件 id */
  readonly id: string
  /** 该组在横向上需要的宽度（px） */
  readonly width: number
  /** 该组到所贴横边的距离（px）—— `layout.x.gap` / `detachX.gap`，缺省 0 */
  readonly edgeGap: number
}

/**
 * 中控区**最小宽度** = `max over 各组 ( 该组宽 + 该组到所贴横边的距离 )`。
 *
 * ★ 与最小高 `max over 各组 ( 该组高 + 该组到所贴竖边的距离 )` **同构**（规范 §7.6）——
 *   两个方向都取 **max** 而非 sum，前提正是**横向允许重叠**（声明式脱离，见 `CcDetachX`）。
 * ★ 本刀（2.5）只把它**算出来并暴露**（渲染侧挂 `--cc-min-width`），**不强制**：
 *   窗口窄于它时不引入横向滚动、也不撑宽；真正的消费者是刀 4 的"显示前校验"。
 * ★ 纯函数：不入参之外不读任何东西（同输入同输出）。
 */
export function resolveCcMinWidth(groups: readonly CcMinWidthGroup[]): number {
  return groups.reduce((max, group) => Math.max(max, group.width + group.edgeGap), 0)
}

/**
 * 件 id → 它的**宽度字段值**（px）。
 * **缺席** = 该件是**内容撑**（`width:max-content`：用量胶囊 / 命令行提示）⇒ 算式算不出宽，
 * 按 0 计入 —— 于是结果对它们是**下界**（与 §7.2「行高有可算的下界」同一性质）。
 */
export type CcWidgetWidthIndex = Readonly<Record<string, number | undefined>>

/**
 * 从「隐藏名单 + 各件宽」派生横向上参与竞争的组（= `resolveCcMinWidth` 的输入）。
 *
 * 口径（全部从定义表读，不另立第二份规则）：
 * - **组 = 横向落脚处**；组宽 = 组内**在场**件宽之和 **+ 各件自己的"同落脚处内前置间距"**
 *   （行级 `gap`，见 `widgetDefinitions.ts` 表头）；
 * - **声明了 `detachX` 的件不排队** ⇒ 它**自成一"组"**（宽 = 自己，`edgeGap` = 到所贴边的距离），
 *   而**不**计入队列之和 —— 这正是"允许重叠"在算式里的体现：两者取 max，**不是相加**；
 * - **悬浮件**（发送按钮）不进任何落脚处 ⇒ 不参与（宽度由 `--cc-send-size` 自算）；
 * - 不在场的件不计入（"谁在场"由谓词定，与渲染同源）；
 * - ★ 刀5：**插件件**并入状态区队列（`queue:<状态区>`）**求宽之和**（件并排）——
 *   只有"报了 width"的件才建队列/加值（不报按 0 计）；插件件没有行级 `gap` 声明 ⇒ **件间**间距按 **0**；
 *   队列由插件件**新建**时，队列级 `edgeGap` 按该落脚处**在定义表里声明的横向边距**给初值
 *   （★ 刀5 接续：与竖向同一口径；今天全行缺省 `layout.x.gap` ⇒ 读数为 0，与修正前逐位相同）。
 *
 * ★ 组级 `edgeGap` 取组内**最大**声明（今天全部缺省 = 0）；`layout.x.gap` 是"贴边间距"，
 *   现状没有一行声明它 —— 所以本算式目前给出的是**声明口径的下界**：
 *   渲染侧的内缩（`.cc-body` 的横内边距、行内内边距）与行内 flex 间距不在声明里，不计入。
 */
export function resolveCcWidthGroups(
  hiddenIds: readonly string[],
  widths: CcWidgetWidthIndex,
  pluginWidgets: readonly CcPluginWidgetSizing[] = [],
): CcMinWidthGroup[] {
  const queues = new Map<string, { width: number; edgeGap: number }>()
  const detached: CcMinWidthGroup[] = []
  for (const row of CC_WIDGET_GROUPS) {
    if (row.type !== 'widget' || !row.draggable || !row.layout) continue
    if (CC_FLOATING_WIDGET_IDS.includes(row.id)) continue
    if (!isWidgetVisible(row.id, { hidden: hiddenIds })) continue
    if (row.detachX) {
      detached.push({ id: row.id, width: widths[row.id] ?? 0, edgeGap: row.detachX.gap ?? 0 })
      continue
    }
    const landing = coerceInputLanding(row.id, ccWidgetLanding(row.id)) ?? row.id
    const queue = queues.get(landing) ?? { width: 0, edgeGap: declaredHorizontalEdgeGap(landing) }
    queue.width += (widths[row.id] ?? 0) + (row.gap ?? 0)
    queue.edgeGap = Math.max(queue.edgeGap, row.layout.x.gap ?? 0)
    queues.set(landing, queue)
  }
  for (const widget of pluginWidgets) {
    if (!isWidgetVisible(widget.id, { hidden: hiddenIds })) continue
    const declared = declaredDimension(widget.width)
    if (declared === undefined) continue
    const queue = queues.get(PLUGIN_WIDGET_LANDING)
      ?? { width: 0, edgeGap: declaredHorizontalEdgeGap(PLUGIN_WIDGET_LANDING) }
    queue.width += declared
    queues.set(PLUGIN_WIDGET_LANDING, queue)
  }
  return [
    ...[...queues].map(([landing, queue]) => ({ id: `queue:${landing}`, ...queue })),
    ...detached,
  ]
}
