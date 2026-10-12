/**
 * widgetDefinitions — 中控元件两级定义表（组 + 成员）单一真值。
 *
 * 表形（issue #238 刀1 立表 / 刀3 起位置改两轴）：
 * - **组**：可摆、可藏的单元 —— 表里 `draggable` 的行才进
 *   `ccLayout` / `ccHidden` 两份名单（刀7 起缩放已删，原第三份 `ccScale` 退场）。共 8 行 = 控件 7 + 容器 1（`cc-surface`）。
 * - **成员**：组里一个有名字的部件 + 它自己那组字段 —— **只做归属**，不进任何名单。
 * - ★ **位置**（刀3）：每行自己声明 `layout: { x: {锚点, 方位, 间距?}, y: {…}, order }`
 *   —— 不再有「先分槽、再在槽里排序」两段式。渲染按**落脚处**（`ccWidgetLanding` =
 *   `(y.anchor, y.side)`）自动成组，组内按 `order` 排。声明为 `floating` 的行不进文档流。
 *   ★★ **横向脱离**（#266 刀2.5）：行上可选声明 `detachX`（贴哪条边 + 距离）——
 *   **缺省 = 照旧排队**（默认排布不变），声明了才脱离横向队列、贴到背景板的那条横边、
 *   **允许与队列重叠**（见 `CcDetachX`）。下边组因此不折行（行数恒 1），最小宽按 max 取。
 * - ★ **显隐**（#266 ⑰ → 刀2 收成「盒子 + 一道门」→ **刀4 结构 C：主管表 + 空态再藏**）：
 *   这一维只有「显示 / 隐藏」两个属性，承载**只有一种：预设的两份表** ——
 *   `ccHidden`（**主管表**，两种门态都生效）/ `ccHiddenEmpty`（**空态再藏**，只在空态再加一层）。
 *   生效名单 = `门 ? (主管 ∪ 再藏) : 主管`（去重；门 = "现在是不是空态"，`resolveCcHiddenWidgetIds`）。
 *   ★ 第二份**只能加、不能抵消**第一份 ⇒ 空态**不能**"放出"常态藏着的件（不变式：空态 ⊇ 常态）。
 *   ★ 预设**没写**"再藏"（老自定义预设）⇒ 以 `DEFAULTS.ccHiddenEmpty`（出厂那 6 件）为基准
 *     —— 刀 4 删掉了"没写就抄常态表"的落值回落（`inheritCcEmptySlice`），这是**有意的口径变化**。
 *   ⇒ **行上不再有任何显隐申明**（`inActiveSession` / `conditions` / `hiddenInEmptyState` 三样已删），
 *     也**不再有语境侧硬编码名单**（原 `EMPTY_STATE_HIDDEN_WIDGET_IDS` 已搬进预设数据）。
 * - ★ **高度来源**（#266 刀3）：行上可选声明 `heightField`（该件的高从哪个主题字段来）——
 *   缺省 = **内容撑**（算式按 0 计，见 `ccHeightState.resolveCcMinHeight` 的"下界"口径）。
 *
 * 其余全部派生：`CC_WIDGET_IDS` / `STATUS_WIDGET_IDS` / 标签表 /
 * 默认布局（`ccLayoutState.ts`）/ 目录三份（`widgetCatalog.ts`）/
 * 属性表单 / 编辑工具条（`ControlCenter.solid.tsx`）。
 *
 * ★ 依赖方向（#238 头号雷）：本表**不得在运行时 import `src/themeFieldDefs.ts`** ——
 * `themeFieldDefs → ccHeightState → 本文件` 已是一条运行时链，反向即成环，而且是**静默**环
 * （模块初始化期拿不到值，症状是 undefined / NaN，不报错）。所以这里对 themeFieldDefs
 * **只有 `import type`**（类型擦除，零运行时边），字段键本身写字符串；
 * 「每个字段都合法、83 个全覆盖且无重叠」由 `__tests__/widgetDefinitionTable.test.ts` 机检。
 *
 * ★ 间距：两个轴上的「贴边间距」写在 `layout.x/y.gap`；**同落脚处内的前置间距**用行级 `gap`
 * （思考强度 / 权限各 12px，就是控件里原先硬编码的那两个常量；#238 刀3 起由控件读表）。
 *
 * ★ 中文名一律**照抄现状**（渲染出来的字逐字相同）：`cc-surface` 的现状字面量是
 * 「中控本体背景板」（骨架 §2 单元格写作「中控本体」，按其 §4 栏位字典「中文名照抄现状」
 * 取现状值）；`mode` 同理取「权限模式」而非骨架里的「权限」。
 * 新增 widget：此处加一行 + `widgetRenderers` 补 renderer + 该行的 `propertyFields` 补表单。
 */
import type { ThemeFieldKey } from '../theme/themeFieldDefs.ts'

export type CcColorPropertyKey =
  | 'inputBg' | 'inputTextColor' | 'cliLineColor'
  // ★ #266 遗留①：三组控件的底色/文字色由「白/黑枚举」改成自由选色 ⇒ 属性面板按取色输入渲染
  //   （`permissionTextColor` 留空 = 跟模式，输入框清空即可回到语义色）。
  | 'modelBgColor' | 'modelTextColor'
  | 'reasoningBgColor' | 'reasoningTextColor'
  | 'permissionBgColor' | 'permissionTextColor'
export type CcNumberPropertyKey =
  | 'inputFontSize' | 'inputHeight' | 'inputOffsetTop' | 'cliLineWidth'
  | 'modelWidth' | 'modelHeight' | 'modelRadius' | 'modelFontSize'
  | 'reasoningWidth' | 'reasoningHeight' | 'reasoningRadius' | 'reasoningFontSize'
  | 'permissionWidth' | 'permissionHeight' | 'permissionRadius' | 'permissionFontSize'
export type CcStringPropertyKey = 'inputLineHeight' | 'modelSwitchMode' | 'reasoningSwitchMode' | 'permissionSwitchMode'
export type CcEditablePropertyKey = CcColorPropertyKey | CcNumberPropertyKey | CcStringPropertyKey

export type WidgetPropertyField =
  | { kind: 'section'; title: string }
  | { kind: 'color'; key: CcColorPropertyKey; label: string }
  | { kind: 'number'; key: CcNumberPropertyKey; label: string; min: number; max: number; step?: number; suffix?: string }
  | {
      kind: 'chips'
      key: CcStringPropertyKey
      label: string
      options: { value: string; label: string }[]
    }

export type CcPropertyCommand =
  | { readonly type: 'set-cc-property'; readonly key: CcColorPropertyKey | CcStringPropertyKey; readonly value: string }
  | { readonly type: 'set-cc-property'; readonly key: CcNumberPropertyKey; readonly value: number }

/**
 * 每 widget 的属性表单（纯数据）。
 *
 * ★ #266 刀9：原先这里有两层"联动"——`WidgetPropertyDef.showIf`（按 `inputMode` 判明）与
 *   chips 选项上的 `sync`（`inputMode`↔`inputVariant` 双写）。两个字段删除后它们都失去声明方，
 *   读取点（`ControlCenter` 的属性面板过滤 / chips 点击）也一并撤掉 ⇒ 属性项一律**常态显示**，
 *   值由预设给、用户自己改（口径不变，机制不再需要承载者）。
 */
export type WidgetPropertyForm = readonly WidgetPropertyField[]

// ── 成员层（两级中的第二级）──

/**
 * 成员显隐：**只作说明，不构成显隐门**。
 *
 * ★ 2026-09-23 用户口径：「不要这个判明条件，常态显示，预设里我手动改」⇒
 * 原 `{ kind: 'field'; field; visibleWhen }`（按字段值判明）**已从类型上删除**，
 * 防后人再实现这条路。三类保留值各自只说明该子部件的性质：
 * - `always` = 常态可见（是成员行的默认）；
 * - `content` = 由内容驱动（有没有东西可显示，如菜单/队列/报错条）；
 * - `host` = 宿主注入（由外层挂载，元件表不生产它）。
 *
 * ★ 这三类**都不被任何代码读取**（渲染真值在各子部件自己的渲染分支里）；本表这一列是**文档**，
 * 不是门。要改某个子部件出不出现在界面上，改它的渲染分支 —— 别在这儿加条件。
 */
export type CcMemberVisibility =
  | { kind: 'always' }
  | { kind: 'content' }
  | { kind: 'host' }

export interface CcWidgetMember {
  id: string
  /** 中文名（★ 照抄现状口径，渲染出来的字逐字相同） */
  label: string
  /**
   * ★ #238 刀6：这里**不再有 `fields`** —— 字段归属的**唯一真值 = 每个字段自己身上的 `group`**
   * （值就是本成员的 `label`；用户口径「归属放在字段」）。
   * 派生视图见 `themeFieldDefs.ts` 的 `CC_MEMBER_FIELDS` —— 那是唯一能同时看见两边的地方；
   * 本表若自己算就得运行时 import `themeFieldDefs.ts`，正是表头写明的「头号雷」（成环、症状静默）。
   * ⇒ 加字段时只改两处：字段定义（`group` 写本成员的中文名）+ 本表（若新增子部件行）。
   */
  visibility: CcMemberVisibility
  /** 外观字段**借用**另一行（用量借模型）——显式化隐式耦合，不留暗线（规范 §5.3） */
  borrowsFrom?: string
  note?: string
}

// ── 组层 ──

/** x 轴方位（`stretch` = 两侧都贴、撑满；`center` = 贴中线） */
export type CcAxisX = 'left' | 'right' | 'center' | 'stretch'
/** y 轴方位（`stretch` = 上下都贴、撑满；`center` = 贴中线） */
export type CcAxisY = 'top' | 'bottom' | 'center' | 'stretch'

export interface CcPlacementX {
  /** 贴谁（指向表内 id，或最外的容器 `cc-surface`） */
  readonly anchor: string
  readonly side: CcAxisX
  /** 与该边之间的间距（★ 数值来源见各行的 note；缺省 = 由既有 CSS 变量提供） */
  readonly gap?: number
}

export interface CcPlacementY {
  readonly anchor: string
  readonly side: CcAxisY
  readonly gap?: number
}

/**
 * ★★ #266 刀2.5：**横向独立定位**声明（声明式脱离）—— 「贴哪条边 + 距离」。
 *
 * 判据两条，都以「行上有没有这个字段」为准，不再有第三种形态：
 * - **缺省（没有此字段）= 照旧排队** —— 该件留在所在落脚处的 flex 队列里，与同组件按
 *   `placements[].order` 依次排。**默认观感逐像素不变**（表里今天一个都不声明）。
 * - **有此字段 = 脱离队列** —— 该件从文档流里取出、单独贴到 `side` 那条横边（`gap` 缺省 0），
 *   **不再与谁排队** ⇒ **允许与队列或其它脱离件重叠**（互不挤开，也不报错）。
 *   ★ 这正是「最小宽按 max 取」而不是按 sum 取的前提（规范 §7.6）。
 *
 * ★ 只有横向：纵向仍随所在落脚处那一行（高度一行一件事，见刀 3）。
 * ★ `stretch` 不作为脱离的 `side` —— 脱离件不撑满容器（要撑满的就是留在队列里的输入栏）。
 * ★ 与 `floating` 的分工：`floating`（发送按钮）是"不进任何落脚处、不成组"，位置由它自己的
 *   CSS 与 `layout.x/y` 算；本字段是"仍在那条行上、但横向不受队列摆布"。
 * ★ 与用户数据的分工：贴哪条边由**本表声明**（`ccLayoutState.ts` 里已立的决定 ——
 *   "元件贴哪一行/哪一侧不在用户数据里"）；`ccLayout.placements` 仍只存用户手调的可变量
 *   （组内序号 + 两个方向的微调）。
 */
export type CcDetachSide = 'left' | 'right' | 'center'

export interface CcDetachX {
  /** 贴谁（指向表内 id；当前一律 `cc-surface` = 背景板本体） */
  readonly anchor: string
  readonly side: CcDetachSide
  /** 与该横边之间的距离（px；`center` 时忽略）。缺省 0 = 紧贴该边。 */
  readonly gap?: number
}

/**
 * ★★ 位置（#238 刀3）：**两轴各声明一次「贴着谁」**，取代原来的「槽位 + 行内序」两段式。
 * `order` = 同一**落脚处**（`(y.anchor, y.side)`，见 `ccWidgetLanding`）组内的次序。
 */
export interface CcWidgetLayout {
  readonly x: CcPlacementX
  readonly y: CcPlacementY
  readonly order: number
}

/**
 * `align` 简写：两轴共用同一锚点（各自再细化 `side` / `gap`）。
 * 例：发送按钮 `alignLayout('input', { x: { side: 'right' }, y: { side: 'center' }, order: 1 })`
 * —— 贴输入栏、右边 + 中线。
 */
export function alignLayout(
  anchor: string,
  spec: { x: { side: CcAxisX; gap?: number }; y: { side: CcAxisY; gap?: number }; order: number },
): CcWidgetLayout {
  return {
    x: { anchor, side: spec.x.side, ...(spec.x.gap === undefined ? {} : { gap: spec.x.gap }) },
    y: { anchor, side: spec.y.side, ...(spec.y.gap === undefined ? {} : { gap: spec.y.gap }) },
    order: spec.order,
  }
}

/**
 * ★★ 显隐口径（#266 ⑰ 立，刀2 收成「盒子 + 一道门」）：**显隐只有预设的切面；元件不自己申明。**
 *
 * 用户口径逐字：「所有东西在这一维只有显示 / 隐藏两个属性，要存状态存到预设里，不要额外申明属性」
 * 「如果要记『这里不显示』，应该是在这里注明 a 不显示，而不是 a 申明在这里不显示」
 * 「我更希望这是一个统一的筛选器…是一道门，最终效果由预设抄写和这道门共同决定，只此两层级，
 *   不根据元件做特殊处理」。
 * ⇒ 原先挂在**元件行**上的三样申明已删（`inActiveSession` = 活跃会话显/隐、
 *   `conditions` = 运行期状态检测条件表 `CC_VISIBILITY_CONDITIONS`、
 *   `hiddenInEmptyState` = 空态隐藏）；随之而来的两个派生名单
 *   （常态放行 `ALWAYS_VISIBLE_STATUS_WIDGET_IDS`、条件表本身）与刀2 之前的
 *   **语境侧空态名单**（`EMPTY_STATE_HIDDEN_WIDGET_IDS`）也已退场。
 *   想记「这里不显示」⇒ 写进预设的**切面**（`ccHidden` / `ccHiddenEmpty`）。
 * ★ 这里是**原位说明**，不是钩子：不要在这里重新长出任何"元件侧显隐申明"，
 *   也不要再长出"按元件特判的名单"（唯一例外见 `cliHintGoverned`：那是**件自述**它受哪个档管辖，
 *   由折叠逻辑统一读取，不是给某个 id 开的后门）。
 */

/**
 * ★★ 中控显隐的**两份表**（#266 刀4 · 结构 C）—— 不再叫"常态 / 空态切面"（那会让人以为两者平权）。
 *
 * 本刀只做**显隐这一维**：
 * - **主管表** = `ccHidden`（主题字段，落在 `cc` 区 → 预设可携带）：**两种门态都生效**；
 * - **空态再藏** = `ccHiddenEmpty`（同形、同区）：只在空态**再加一层**，**只能加、不能抵消**主管表。
 *
 * ★ 扩展位：位置将来同样按「主管 / 空态再藏」两份承载（本刀不做 —— 位置仍只有一份
 *   `ccLayout`，不进盒子）。届时新增 `ccLayoutEmpty` 一类字段即可，读取处仍走
 *   `resolveCcHiddenWidgetIds` 那种"主管表 +（门开时）再藏表"的形状。
 */
export type CcVisibilitySlice = readonly string[]

export interface CcWidgetGroup {
  id: string
  /** 容器 = 不可拖、不占槽、承载外观项、可作锚点；控件 = 可拖、有成员、挂在锚点上 */
  type: 'widget' | 'container'
  label: string
  category: string
  /** 渲染轨：`builtin` = 内置渲染器；`registered` = 注册轨（宿主渲染，经 ccWidgetRegistry） */
  rail: 'builtin' | 'registered'
  /** ★ 位置声明（两轴）；最外的容器 `cc-surface` 无此项（它是所有锚点的终点） */
  layout?: CcWidgetLayout
  /**
   * ★★ #266 刀2.5：**横向独立定位**声明（贴哪条边 + 距离）。**缺省 = 照旧排队**。
   * 形态与读法见 `CcDetachX`；渲染侧按它挂 `.cc-detach-x` 并内联 `left`/`right`。
   */
  detachX?: CcDetachX
  /**
   * ★ **同落脚处内的前置间距**（与同组前一个元件之间的距离，落在元件自己身上）。
   * 现状：思考强度 / 权限各 12px（原先硬编码在控件里的 `REASONING_GAP_PX` / `PERMISSION_GAP_PX`，
   * #238 刀3 起由控件读本值）。两轴上的「贴边间距」不走这里，走 `layout.x/y.gap`。
   */
  gap?: number
  /** ★ 声明为**悬浮**（不参与文档流成组；占区叠加约束对它豁免，见刀4） */
  floating?: boolean
  /**
   * ★ 刀2：本件**自述**「我的显隐受**详细档**（`cliHintMode` = 快捷提示详细档）管辖」。
   *
   * 这是**件侧的显隐申明**（⑰ 唯一允许的一种），存在的理由：详细档选「隐藏」时该件必须不显示，
   * 而这条事实属于**该件自己**（别的件没有这个档）⇒ 由件声明、折叠逻辑**只读声明**，
   * 不再在折叠逻辑里写死某个元件 id（刀2 之前的 `COMMAND_HINT_WIDGET_ID` 已删）。
   * ★ 声明只是「受管辖」；**真值仍由预设切面给**（切面里已含它 ⇒ 不重复追加，集合语义）。
   */
  cliHintGoverned?: boolean
  /**
   * ★ 刀3：本件的**高度**从哪个主题字段来（`CcNumberPropertyKey` 里的数字字段）。
   *
   * 缺省 = **内容撑**（宽度 `max-content` / 高度 `auto`，如用量胶囊与命令行提示）——
   * 算式算不出它的实际高，**按 0 计入**，于是结果对它们是**下界**
   * （与最小宽那边同一性质，见 `ccHeightState.resolveCcMinHeight`）。
   * ★ 声明在这里（而不是在算式里按 id 特判）⇒ 加件/换字段时只改表。
   */
  heightField?: CcNumberPropertyKey
  /** 是否进 `ccLayout` / `ccHidden` 两份名单 */
  draggable: boolean
  /** 属性表单（PropertyPanel 消费） */
  propertyFields?: WidgetPropertyForm
  members: readonly CcWidgetMember[]
  note?: string
}

/**
 * 行的类型：`id` / `type` / `rail` / `draggable` 保成**字面量**（供 `Extract` 派生 id 联合与名单），
 * 其余栏位走 `CcWidgetGroup` 的上下文类型检查（漏字/写错键当场报错）。
 */
type CcWidgetGroupRowOf<
  Id extends string,
  Type extends 'widget' | 'container',
  Rail extends 'builtin' | 'registered',
  Draggable extends boolean,
> = Omit<CcWidgetGroup, 'id' | 'type' | 'rail' | 'draggable'> & {
  id: Id
  type: Type
  rail: Rail
  draggable: Draggable
}

/** 行工厂：见 `CcWidgetGroupRowOf` 的说明。 */
function widgetGroup<
  Id extends string,
  Type extends 'widget' | 'container',
  Rail extends 'builtin' | 'registered',
  Draggable extends boolean,
>(row: CcWidgetGroupRowOf<Id, Type, Rail, Draggable>): CcWidgetGroupRowOf<Id, Type, Rail, Draggable> {
  return row
}

/**
 * ★★ 定义表本体：8 行 = 控件 7 + 容器 1（结构冻结件 `03-结构-定义表骨架-20260922.md` §2）。
 * 值一律照抄现状，本表落地即「行为零变化」。
 */
export const CC_WIDGET_GROUPS = [
  widgetGroup({
    id: 'cc-surface',
    type: 'container',
    label: '中控本体背景板',
    category: 'surface',
    rail: 'registered',
    draggable: false,
    members: [
      {
        id: 'surface-body',
        label: '中控本体面',
        visibility: { kind: 'always' },
      },
    ],
    note: '最外的容器：不参与排布（所有其它行的锚点终点）、不可拖不可藏（其值在设置页编辑）。★ #266 刀11：原「底部信息布局」字段已删除（`free`/`peri` 两值）—— 结构固定「独立状态行」，本行字段只剩外观项。',
  }),
  widgetGroup({
    id: 'input',
    type: 'widget',
    label: '输入栏',
    category: 'input',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'stretch' }, y: { anchor: 'cc-surface', side: 'top' }, order: 1 },
    draggable: true,
    // ★ 刀3：输入栏的高就是它的字段（多行增高由 CSS 的 `--cc-input-extra-height` 算进容器高，不在这里）
    heightField: 'inputHeight',
    propertyFields: [
      { kind: 'section', title: '输入栏设置' },
      { kind: 'color', key: 'inputBg', label: '背景色' },
      { kind: 'color', key: 'inputTextColor', label: '文字色' },
      { kind: 'number', key: 'inputFontSize', label: '字号', min: 12, max: 22, step: 1 },
      // ★ 2026-09-23 用户口径：命令行边框三项**不再按输入模式判明**，两模式常态显示
      //   （值由预设给、用户自己改）。此前三条 `showIf: t => t.inputMode === 'cli'` 已删。
      // ★ #266 刀9：「模式」chips（`inputMode` ↔ `inputVariant` 双写）随两个字段删除退场。
      { kind: 'number', key: 'cliLineWidth', label: '边框宽度', min: 1, max: 6, step: 0.1 },
      { kind: 'color', key: 'cliLineColor', label: '边框颜色' },
    ],
    members: [
      {
        id: 'textarea',
        label: '输入框本体',
        visibility: { kind: 'always' },
      },
      {
        id: 'cli-prefix',
        label: '提示符 ❯',
        // ★ 原为 `{kind:'field', field:'inputMode', visibleWhen:['cli']}`（2026-09-23 删）：
        //   真身判据在渲染分支（`InputBar.solid.tsx` 的 `inputVariant() === 'cli'`），本列不构成门。
        visibility: { kind: 'always' },
      },
      {
        id: 'cli-lines',
        label: '上下两条线',
        // ★ 同上：原 `field/inputMode` 声明已删；两条线是 cli 变体块上的 CSS 边框。
        visibility: { kind: 'always' },
      },
      { id: 'command-palette', label: '/ 命令菜单', visibility: { kind: 'content' } },
      {
        id: 'history-hint',
        label: '历史快捷提示',
        // ★ 原为 `field/inputShowHistoryHint, visibleWhen:['shown', true]`（2026-09-23 删）：
        //   真身判据在渲染分支（`InputBar.solid.tsx` 的 `inputShowHistoryHint && …`）。
        visibility: { kind: 'always' },
      },
      { id: 'prediction', label: '输入预测', visibility: { kind: 'content' } },
      { id: 'queue', label: '待发送队列', visibility: { kind: 'content' } },
      { id: 'error', label: '报错条', visibility: { kind: 'content' } },
      { id: 'empty-slot', label: '空态插槽', visibility: { kind: 'host' } },
    ],
    note: '间距不写死在表里：横向上/纵向上的实际数值由既有的两个 CSS 变量提供（`--cc-input-margin-x` = 输入栏左右间距、`--cc-input-offset-top` = 输入栏上间距，都是设置页字段），`x.side=stretch` + `y.side=top` 描述的就是它们。★ #266 刀11：原先「peri 下回文档流 / free 下绝对定位」两套差值已随该字段退场 —— 现在只有一套（独立状态行 + 绝对定位浮起）。',
  }),
  widgetGroup({
    id: 'model',
    type: 'widget',
    label: '模型',
    category: 'runtime',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 2 },
    gap: 0,
    draggable: true,
    heightField: 'modelHeight',
    propertyFields: [
      { kind: 'section', title: '模型控件' },
      {
        kind: 'chips', key: 'modelSwitchMode', label: '模型切换方式',
        options: [
          { value: 'menu', label: '弹菜单' },
          { value: 'cycle', label: '点击轮换' },
        ],
      },
      { kind: 'color', key: 'modelBgColor', label: '模型背景色' },
      { kind: 'number', key: 'modelWidth', label: '模型宽度', min: 40, max: 400, step: 1 },
      { kind: 'number', key: 'modelHeight', label: '模型高度', min: 16, max: 80, step: 1 },
      { kind: 'number', key: 'modelRadius', label: '模型圆角', min: 0, max: 40, step: 1 },
      { kind: 'number', key: 'modelFontSize', label: '模型字号', min: 8, max: 32, step: 1 },
      { kind: 'color', key: 'modelTextColor', label: '模型文字颜色' },
    ],
    members: [
      {
        id: 'trigger',
        label: '模型触发器',
        visibility: { kind: 'always' },
      },
      { id: 'menu', label: '模型菜单', visibility: { kind: 'content' } },
    ],
  }),
  widgetGroup({
    id: 'reasoning',
    type: 'widget',
    label: '思考强度',
    category: 'runtime',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 3 },
    gap: 12,
    draggable: true,
    heightField: 'reasoningHeight',
    propertyFields: [
      { kind: 'section', title: '思考强度控件' },
      { kind: 'chips', key: 'reasoningSwitchMode', label: '切换方式', options: [{ value: 'menu', label: '弹菜单' }, { value: 'cycle', label: '点击轮换' }] },
      { kind: 'color', key: 'reasoningBgColor', label: '背景色' },
      { kind: 'number', key: 'reasoningWidth', label: '宽度', min: 40, max: 400, step: 1 },
      { kind: 'number', key: 'reasoningHeight', label: '高度', min: 16, max: 80, step: 1 },
      { kind: 'number', key: 'reasoningRadius', label: '圆角', min: 0, max: 40, step: 1 },
      { kind: 'number', key: 'reasoningFontSize', label: '字号', min: 8, max: 32, step: 1 },
      { kind: 'color', key: 'reasoningTextColor', label: '文字颜色' },
    ],
    members: [
      {
        id: 'trigger',
        label: '思考强度触发器',
        visibility: { kind: 'always' },
      },
      { id: 'menu', label: '思考强度菜单', visibility: { kind: 'content' } },
    ],
    note: 'gap=12 现状由控件内的 REASONING_GAP_PX 施加（本刀只记值不消费）。',
  }),
  widgetGroup({
    id: 'mode',
    type: 'widget',
    label: '权限模式',
    category: 'runtime',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 4 },
    gap: 12,
    draggable: true,
    heightField: 'permissionHeight',
    propertyFields: [
      { kind: 'section', title: '权限控件' },
      { kind: 'chips', key: 'permissionSwitchMode', label: '切换方式', options: [{ value: 'menu', label: '弹菜单' }, { value: 'cycle', label: '点击轮换' }] },
      { kind: 'color', key: 'permissionBgColor', label: '背景色' },
      { kind: 'number', key: 'permissionWidth', label: '宽度', min: 40, max: 400, step: 1 },
      { kind: 'number', key: 'permissionHeight', label: '高度', min: 16, max: 80, step: 1 },
      { kind: 'number', key: 'permissionRadius', label: '圆角', min: 0, max: 40, step: 1 },
      { kind: 'number', key: 'permissionFontSize', label: '字号', min: 8, max: 32, step: 1 },
      { kind: 'color', key: 'permissionTextColor', label: '文字颜色' },
    ],
    members: [
      {
        id: 'trigger',
        label: '权限触发器',
        visibility: { kind: 'always' },
        note: 'permissionTextColor 留空时不写 inline color，交给 CSS [data-mode] 语义色（清空输入框即回到该档）。',
      },
      { id: 'menu', label: '权限菜单', visibility: { kind: 'content' } },
    ],
    note: 'gap=12 现状由控件内的 PERMISSION_GAP_PX 施加（本刀只记值不消费）。',
  }),
  widgetGroup({
    id: 'tokens',
    type: 'widget',
    label: '用量',
    category: 'context',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 5 },
    gap: 0,
    draggable: true,
    propertyFields: [],
    members: [
      {
        id: 'pill',
        label: '用量胶囊',
        visibility: { kind: 'always' },
        borrowsFrom: 'model',
        note: '★★ 自己没有外观字段，宽度/高度/圆角/字号/底色/文字色全部读 model 那一套 —— 显式化，不许留成暗耦合。',
      },
    ],
    note: '单件组：成员行即它自己（字段归属需要一个具名行，成员不进任何名单）。',
  }),
  widgetGroup({
    id: 'cc-command-hint',
    type: 'widget',
    label: '命令行提示',
    category: 'input',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 6 },
    gap: 0,
    draggable: true,
    // ★ #266 ⑰：这里原先挂着三条 `conditions`（有会话 + 命令行模式 + 详细档不为 hidden）——
    //   用户口径「命令行提示按模式驱动可见**我后悔了**」⇒ 一律撤掉，**标准输入模式下它也默认显示**。
    //   想让它不显示只有两条合法路径，都写在**预设的两份表**里：主管表 / 空态再藏里的**值**
    //   （`ccHidden` / `ccHiddenEmpty`），或详细档选「隐藏」（后者由 `resolveCcHiddenWidgetIds` 读本行的
    //   `cliHintGoverned` 声明折进名单，不在折叠逻辑里认元件 id）。
    cliHintGoverned: true,
    members: [
      {
        id: 'hint-line',
        label: '提示行',
        // ★ 原为 `{kind:'field', field:'inputMode', visibleWhen:['cli']}`（2026-09-23 删）、
        //   组层 `conditions`（2026-09-24 / #266 ⑰ 删）—— 判据现在只在**两份表 + 详细档声明**里
        //   （`ccHidden` / `ccHiddenEmpty` / 详细档折叠，见 `isWidgetVisible` 与 `resolveCcHiddenWidgetIds`）。
        visibility: { kind: 'always' },
      },
    ],
    note: '★ #238 刀5B：已升格为**普通行内元件**（有多宽占多宽）—— 不再是裸渲染、也不再整行特化；进编辑工具条、受占区约束、也当障碍。',
  }),
  widgetGroup({
    id: 'cc-send-button',
    type: 'widget',
    label: '发送按钮',
    category: 'action',
    rail: 'registered',
    // ★ 悬浮声明：它一直是绝对定位的悬浮件（骑在输入栏右端），不进文档流成组；
    //   占区叠加约束对它豁免（刀4）。`alignLayout('input', …)` = 贴输入栏、右边 + 中线。
    layout: alignLayout('input', { x: { side: 'right' }, y: { side: 'center' }, order: 0 }),
    floating: true,
    draggable: true,
    members: [
      {
        id: 'button',
        label: '按钮本体',
        visibility: { kind: 'always' },
      },
      {
        id: 'icon',
        label: '图标层',
        visibility: { kind: 'always' },
      },
    ],
    note: '间距由 CSS calc() 从 --cc-input-offset-top / --cc-input-margin-x 算出，不是表内 gap；外观字段在设置页编辑，属性面板只给布局四项。',
  }),
]

type CcWidgetGroupRow = (typeof CC_WIDGET_GROUPS)[number]
/** 表里全部行的 id（含容器与不可拖行） */
export type CcWidgetGroupId = CcWidgetGroupRow['id']

const GROUP_BY_ID: ReadonlyMap<string, CcWidgetGroupRow> = new Map(
  CC_WIDGET_GROUPS.map(row => [row.id as string, row] as const),
)

/** 按 id 取表里的行（测试与派生用；渲染主路径不查表） */
export function resolveCcWidgetGroup(id: string): CcWidgetGroupRow | undefined {
  return GROUP_BY_ID.get(id)
}

/**
 * ★ 落脚处（#238 刀3）：**同一 `(y.anchor, y.side)` 的元件归入同一个容器**，组内按 `order` 排。
 * 取代原来的三份槽位包装 div（`.cc-status-primary/-secondary/.cc-actions`）。
 * 返回 `undefined` = 该行不参与排布（容器 `cc-surface`，或缺 `layout` 的行）。
 */
export function ccWidgetLanding(id: string): string | undefined {
  const layout = resolveCcWidgetGroup(id)?.layout
  return layout ? `${layout.y.anchor}:${layout.y.side}` : undefined
}

/** 声明为**悬浮**的行（不进文档流成组；占区叠加约束豁免，见刀4） */
export const CC_FLOATING_WIDGET_IDS: readonly string[] = CC_WIDGET_GROUPS
  .filter(row => row.floating === true)
  .map(row => row.id as string)

/**
 * ★ **输入栏落脚处独占守卫**（#238 刀3）——原 `input` 槽「只允许输入栏」规则的替代。
 *
 * 槽位层拆掉后，「元件落在哪个容器」完全由定义表声明；拖拽只改 `offset`/`order`、
 * 改不了归属，所以老问题（「别的元件挪进输入栏 → 槽位过滤把它剔掉 → 控件凭空消失」）
 * 的**新形式**是「表被改坏 / 将来允许改锚点 ⇒ 非输入栏落在输入栏容器里被拉伸」。
 * 判据：凡声明落在输入栏落脚处、自己却不是输入栏的，**退回默认信息落脚处**
 * —— 宁可换位置，也不让它凭空消失。
 */
export function coerceInputLanding(id: string, declaredLanding: string | undefined): string | undefined {
  const inputLanding = ccWidgetLanding('input')
  if (declaredLanding !== inputLanding) return declaredLanding
  return id === 'input' ? declaredLanding : ccWidgetLanding('model')
}

/** 表自身的输入栏落脚处违规项（空 = 合规；渲染层与测试共用同一判据） */
export function ccInputLandingViolations(ids: readonly string[]): string[] {
  return ids.filter(id => coerceInputLanding(id, ccWidgetLanding(id)) !== ccWidgetLanding(id))
}

// ── 派生：名单 / 标签表 / 属性表单 ──

/** 内置轨控件 id（可落槽的内置渲染控件）。顺序 = 表序 */
export type CcWidgetId = Extract<
  CcWidgetGroupRow,
  { type: 'widget'; rail: 'builtin'; draggable: true }
>['id']

/** 注册轨里**占槽位**的控件 id（不占槽的组不许进来，如 `cc-surface`） */
export type CcRegisteredSlotId = Extract<
  CcWidgetGroupRow,
  { type: 'widget'; rail: 'registered'; draggable: true }
>['id']

/** 全部中控 widget id（含输入栏、模型、思考强度、权限、用量）。 */
export const CC_WIDGET_IDS: readonly CcWidgetId[] = CC_WIDGET_GROUPS
  .filter(row => row.type === 'widget' && row.rail === 'builtin' && row.draggable)
  .map(row => row.id) as readonly CcWidgetId[]

/** 注册轨里占槽位的控件 id（F1=A：legacy `send` 的槽位事实迁到这里）。 */
export const CC_REGISTERED_SLOT_IDS: readonly CcRegisteredSlotId[] = CC_WIDGET_GROUPS
  .filter(row => row.type === 'widget' && row.rail === 'registered' && row.draggable)
  .map(row => row.id) as readonly CcRegisteredSlotId[]

/** 状态区 widget（除 input 外全部计入中控最小高度约束）——由 id 列表派生，不平行维护 */
export const STATUS_WIDGET_IDS: readonly CcWidgetId[] = CC_WIDGET_IDS.filter(id => id !== 'input')

/** 表里每行的中文名 —— 标签表唯一出处（ControlCenter 与 widgetCatalog 共用） */
export const CC_WIDGET_LABELS: Readonly<Record<CcWidgetGroupId, string>> = Object.freeze(
  Object.fromEntries(CC_WIDGET_GROUPS.map(row => [row.id as string, row.label])) as Record<CcWidgetGroupId, string>,
)

/** 属性表单唯一出处 = 表里每行的 `propertyFields`（按 id 索引，供既有消费点与目录派生用） */
export const WIDGET_PROPERTY_FIELDS: Record<CcWidgetId, WidgetPropertyForm> = Object.fromEntries(
  CC_WIDGET_IDS.map(id => [id, resolveCcWidgetGroup(id)?.propertyFields ?? []]),
) as Record<CcWidgetId, WidgetPropertyForm>

/**
 * 跨元件的系统字段：不属于任何单个组/成员的字段。
 *
 * - `ccLayout`：位置名单本体（值为元件名，属布局状态）。
 * - ★ 显隐**两份表**（刀2 立、刀4 定结构 C）：`ccHidden`（**主管表**，两种门态都生效）/
 *   `ccHiddenEmpty`（**空态再藏**，只在空态再加一层、只能加不能抵消）。
 *   两者都是「预设的取值」，**不是**两份平权的名单 —— 合并规则（主管表 + 门开时叠加再藏表
 *   + 详细档折叠）只在 `resolveCcHiddenWidgetIds` 一处。
 * - ★ CC-13 刀4（工具开闸）：`ccPluginProps`（**插件元件的属性值**，`Record<元件 id, Record<短键, 值>>`）
 *   —— 与位置 / 显隐同级的跨元件字段（不属于任何元件行：值是**插件自定义键**，
 *   形状与读写见 `domains/cc/ccPluginProps.ts`；声明契约见 `ccWidgetRoster.ts`）。
 *   ★ 刀5 后「信息行」名下那三项（`ccStatusFontSize` / `statusBg` / `statusBgImage`）已**删除**
 *   （前两项是僵尸，第三项的字号收窄成 `cc-command-hint` 成员自己的 `ccHintFontSize`）；
 *   `footerLayout` 已由刀3 移入容器行 `cc-surface`；
 *   ★ 刀7：`ccScale`（缩放）已**整体删除**（用户口径「我预期里没有缩放这一项」）⇒ 名单由三份变两份。
 */
export const CC_SYSTEM_FIELDS = [
  'ccLayout', 'ccHidden', 'ccHiddenEmpty', 'ccPluginProps',
] as const satisfies readonly ThemeFieldKey[]

export interface WidgetVisibilityCtx {
  /** 生效的那份切面（常态或空态，由 `resolveCcHiddenWidgetIds` 选好后传进来） */
  hidden: readonly string[]
}

/**
 * ★ 受**详细档**管辖的元件 id —— 由定义表**派生**（件自己声明，见 `cliHintGoverned`），
 * 折叠逻辑只读这份派生，**不认任何写死的元件 id**（刀2 之前那处 `COMMAND_HINT_WIDGET_ID` 已删）。
 * 现状只有一条（命令行提示）；将来若有第二个件受详细档管辖，改表即可、这里不动。
 */
export const CLI_HINT_GOVERNED_WIDGET_IDS: readonly CcWidgetGroupId[] = CC_WIDGET_GROUPS
  .filter(row => row.cliHintGoverned === true)
  .map(row => row.id)

/**
 * ★★ **生效隐藏名单的组装**（#266 ⑰ 立，刀2 改成「盒子 + 一道门」，**刀4 改成「主管表 + 空态再藏」**）
 * ——「两份表」变成「一份名单」的**唯一一处**。
 *
 * 两段，按序：
 * 1. **合并**（结构 C）：门（`isEmpty` = 现在是不是空态）**关** ⇒ 只取**主管表** `ccHidden`；
 *    门**开** ⇒ 取 `ccHidden ∪ ccHiddenEmpty`（**并集 + 去重**）。
 *    ★ 第二份表**只能加、不能抵消** ⇒ 不变式 **空态 ⊇ 常态**（"藏了就是藏了"：空态不再能"放出"
 *      常态藏着的件，也就不会再出现"在空态里改的显隐，一开会话就变回去"）。
 *    ★ 读的时候**不做"缺省回落"**：两份表都是装配后的主题字段（`DEFAULTS` 给每份都铺了基准值），
 *      读侧只认"值"，不认"写没写"。
 * 2. **详细档折叠**：`cliHintMode === 'hidden'` ⇒ 把**声明受详细档管辖**的件（`cliHintGoverned`）
 *    并进名单（集合语义，已在名单里的不重复追加）。
 *
 * 值一律照抄，不吞不改。
 *
 * ★ 为什么详细档不是"把 `cliHintMode` 传进谓词"：那就等于让可见性重新依赖一个**运行期档位**，
 *   与「这一维只有显示 / 隐藏两个属性」的口径相悖；折叠成名单后，谓词只认 `hidden`。
 * ★ 纯函数：不读 store、不碰全局（同输入同输出）。渲染侧（`ControlCenter`）与全部计数调用点都调它，
 *   保证同一真值（否则会出现"计数多算/少算一个不渲染的元件"，正是 `isWidgetVisible` 注释里 C2 要防的）。
 */
export function resolveCcHiddenWidgetIds({ ccHidden, ccHiddenEmpty, isEmpty = false, cliHintMode }: {
  /** **主管表**（预设的值）：两种门态都生效 */
  ccHidden: CcVisibilitySlice
  /** **空态再藏**（预设的值）：门开时**叠加**在主管表之上；**必填**，防调用方漏传导致"空态少藏一层" */
  ccHiddenEmpty: CcVisibilitySlice
  /** 门：现在是不是空态 */
  isEmpty?: boolean
  cliHintMode?: string
}): string[] {
  const slice = isEmpty ? Array.from(new Set([...ccHidden, ...ccHiddenEmpty])) : [...ccHidden]
  if (cliHintMode !== 'hidden') return slice
  return Array.from(new Set([...slice, ...CLI_HINT_GOVERNED_WIDGET_IDS]))
}

/**
 * widget 可见性单一真值（C2）：渲染（ControlCenter.renderWidget）与高度计数
 * （resolveVisibleStatusWidgetCount）消费同一谓词，杜绝"计数多算不渲染的 widget"。
 *
 * ★ 判据（#266 ⑰ 收口）：**只剩「隐藏名单」一件事**。
 *   ★ #266 刀1：编辑态豁免已撤 —— 编辑态下被藏件与常态一样**不在场**，工具栏清单才是它唯一的入口。
 *   ★ #266 刀2/刀4：名单里的东西 = **生效的合并结果**（`门 ? 主管表 ∪ 空态再藏 : 主管表`
 *   + 详细档折叠，按件声明）——由调用方组装好传进来。元件自己不申明显隐，
 *   谓词里也**不出现任何元件特例**（旧 `id === 'input'` 那类特例已随 ⑰ 清掉）。
 */
export function isWidgetVisible(id: string, ctx: WidgetVisibilityCtx): boolean {
  return !ctx.hidden.includes(id)
}
