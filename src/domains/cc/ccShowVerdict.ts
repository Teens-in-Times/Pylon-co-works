/**
 * ccShowVerdict — #266 刀4：**显示前校验**（"点了显示之后，装不装得下"）。
 *
 * 判据一句话：把"改完之后"的两态名单各算一遍**需求**，与背景板的**实际可用尺寸**比；
 * `needed > available` ⇒ 拒（**相等 = 正好装下 ⇒ 放行**）。
 *
 * 四个口径（都是**逻辑**，不是"看起来对不对"）：
 *
 * 1. ★ **两个方向都算**（纵向 + 横向）—— 纵向用 `resolveCcMinHeight`（按边算取最大，刀 3 的算式），
 *    横向用 `resolveCcMinWidth(resolveCcWidthGroups(...))`（刀 2.5 的算式）。两个方向各有各的
 *    "出路"文案（加高 / 拉宽），故失败时要把 `axis` 报出去。
 * 2. ★ **按两态各算一遍取 max** —— 与最小高下界**同口径**（`ccMinHeightInputOf` 交出的那两份名单：
 *    常态 = `ccHidden`（**主管表**）、空态 = **主管 ∪ 再藏**（`ccHidden ∪ ccHiddenEmpty`，去重））。
 *    理由：门会翻转（`emptyVisual()` 含"正在进场"那一段），
 *    容器必须**两个状态都装得下**；只按当前态算会漏掉另一个态。
 *    ★ 实现上直接复用 `resolveCcMinHeight` 的"逐态取大"（它内部就做这件事），横向则在这里显式逐态取大
 *    —— 两个方向因此同口径，不会一个方向取 max、另一个只看一份。
 *    ★ **一次只报一个方向**：判定顺序固定为**先纵向、后横向**（纵向不通过就不再看横向），
 *      提示话术因此永远只有一句。用户按它改完再点一次，会得到剩下的那一个（若有）。
 * 3. ★ **fail-open**：`available` 量不到（`0` / 非有限 / 元素未挂载）⇒ **该方向放行**。
 *    理由：宁可偶尔不拦，也不要因为"量不到尺寸"这种环境问题把用户的操作**静默禁止**掉
 *    （那会变成一条查不出原因的"点了没反应"）。★ 这条是**有意为之**，不是漏判。
 * 4. **纯函数**：只读入参、不写任何数据（同输入同输出）。"拒了怎么办"（出提示、不 dispatch）
 *    由调用方做 —— 本函数**绝不**自己改数据、也**不给**"自动加高 / 自动藏别的"这种建议动作。
 *
 * ★ 本函数**只管判**：拒绝时调用方连一条命令都不发（主题数据一个字节不动），提示话术里的
 *   数字全部来自这里的 `needed` / `available`（不另算一遍，防两处数字对不上）。
 */
import {
  resolveCcMinHeight,
  resolveCcMinWidth,
  resolveCcWidthGroups,
  type CcMinHeightScalars,
  type CcPluginWidgetSizing,
  type CcWidgetWidthIndex,
} from './ccHeightState.ts'

/** 参与校验的隐藏名单与数字字段（**两态**各一份名单，与最小高下界同源）。 */
export interface CcShowVerdictInput {
  /**
   * 两态各自**生效的**隐藏名单（常态 / 空态）—— 与 `ccMinHeightInputOf` 交出的那两份同形。
   * 纵向直接交给 `resolveCcMinHeight`（它逐态取大），横向在这里逐态取大。
   */
  readonly hiddenSlices: readonly (readonly string[])[]
  /** 主题的数字字段表（结构性类型 ⇒ `ThemeSettings` 可直接传；缺项按 0 计，见算式口径） */
  readonly scalars: CcMinHeightScalars
  /** 件 id → 宽度字段值（宽度算式输入；缺席 = 内容撑，按 0 计） */
  readonly widths: CcWidgetWidthIndex
  /**
   * ★ 刀5：插件件及其自报尺寸（缺省 `[]` ⇒ 与改造前逐位相同）。
   * 递**全量**件即可 —— 在场判据由算式按**每一态各自的名单**过滤（与最小高下界同一处逻辑，
   * 这样"改完之后"的那一态里插件件的在场与否才判得准）。
   */
  readonly pluginWidgets?: readonly CcPluginWidgetSizing[]
}

/** 背景板的**实际可用尺寸**（渲染侧实测：`.control-center` 的 `clientWidth` / `clientHeight`）。 */
export interface CcAvailableBox {
  readonly width: number
  readonly height: number
}

/** 校验结论：`ok:false` 时带上**哪个方向**、**要多少**、**有多少**（提示话术直接用这三个数）。 */
export type CcShowVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly axis: 'height' | 'width'; readonly needed: number; readonly available: number }

/** 量不到尺寸（0 / 非有限）⇒ 该方向放行（fail-open，见文件头口径 3）。 */
const measurable = (value: number): boolean => Number.isFinite(value) && value > 0

export function resolveCcShowVerdict(
  input: CcShowVerdictInput,
  available: CcAvailableBox,
): CcShowVerdict {
  const slices = input.hiddenSlices.length > 0 ? input.hiddenSlices : [[]]

  // 纵向：与最小高下界**同一个函数**（内含"逐态取大" + 下界 64）
  const neededHeight = resolveCcMinHeight({
    hiddenSlices: slices,
    scalars: input.scalars,
    pluginWidgets: input.pluginWidgets ?? [],
  })
  if (measurable(available.height) && neededHeight > available.height) {
    return { ok: false, axis: 'height', needed: neededHeight, available: available.height }
  }

  // 横向：逐态各算一遍取大（与纵向同口径；`resolveCcMinWidth` 只管一份名单，故这里自己取 max）
  const neededWidth = slices.reduce(
    (max, slice) => Math.max(max, resolveCcMinWidth(
      resolveCcWidthGroups(slice, input.widths, input.pluginWidgets ?? []),
    )),
    0,
  )
  if (measurable(available.width) && neededWidth > available.width) {
    return { ok: false, axis: 'width', needed: neededWidth, available: available.width }
  }

  return { ok: true }
}
