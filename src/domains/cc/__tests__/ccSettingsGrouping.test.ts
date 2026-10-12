import { describe, expect, it } from 'vitest'
import { CC_WIDGET_GROUPS } from '../widgetDefinitions.ts'
import { GROUP_ORDER, THEME_FIELD_DEFS, THEME_FIELD_KEYS, CC_MEMBER_FIELDS, type ThemeFieldDef } from '../../theme/themeFieldDefs.ts'

/**
 * #238 刀6（设置页中控区改成「元件 → 子部件」分组）的**字段集合不变量**。
 *
 * 为什么它是最关键的一条：设置页是**按字段自己身上的 `group` 找组**渲染的
 * （`themeFieldRenderer.tsx` 的 `def.group === group.title`）。归属写错一个值，
 * 那个项就在设置页里**凭空消失、而且不报错** —— 单测不跑渲染就读不出来。
 * 本刀把 78 个字段的 `group` 从"历史标签"机械换成了"子部件名"，所以必须钉死：
 * **改造前后"能渲染出来的 cc 字段集合"完全相同**（只是归属变了，一个不多一个不少）。
 *
 * 判据分三层（任一层红都说明归属坏了）：
 * 1. **冻结清单**：可渲染集合 == 那份 77 项（下面是逐字冻结的清单，不靠推导）；
 * 2. **值合法**：每个可渲染字段的 `group` 必须**恰好等于某个子部件的 label**（写错字/写成旧标签即红）；
 * 3. **分组表一致**：`GROUP_ORDER.cc` 的分区标题 = 定义表里各元件的 label（顺序同表），
 *    每个有字段的子部件都出现在它所属元件的 groups 里，且**没有空组**。
 */
const defs = THEME_FIELD_DEFS as Record<string, ThemeFieldDef>

/**
 * 设置页中控区**能渲染出来的 cc 字段集合** —— 逐字冻结，排序后比对。
 *
 * ★ #238 刀8：原为刀6 落地时的 78 项；「整体风格」（`ccVariant`）整字段删除后变 **77** 项 ⇒
 * 清单同步 −1（本刀是**字段真的不存在了**，不是归属写坏 —— 这条不变量照样守得住：
 * 除它以外的任何增减都会红）。
 * ★ #266 CC-07：四个字段真的删除（`sendVariant` / `inputShowPlaceholder` / `prismOnColor` / `pillText`）
 * ⇒ **77 → 73**。连带：「用量胶囊」是 `tokens` 元件唯一的子部件，它没有可渲染项 ⇒
 * 该元件不再进 `GROUP_ORDER.cc`（设置页与左栏导航都不再出现「用量」一块）。
 * ★ #266 刀7~13：再删 7 项（`cliLinePadding` / `cliContentOffsetY` / `inputMode` / `inputVariant` /
 * `cliOverflowMode` / `footerLayout` / `inputMinHeight`）⇒ **73 → 66**。
 * ★ #266 CC-32：`inputBorderColor`（实为 `stroke.default` 角色源、全应用通用边线色）搬去 global 区
 * ⇒ **66 → 65**（字段还在，只是不再属于 cc 区；它落进 `GROUP_ORDER.global` 的新「边线」组）。
 * ★ #266 CC-21：`inputFont`（输入栏字体，跟随消息字体哨兵）进 cc 区「输入框本体」组 ⇒ **65 → 66**。
 * 注意「上下两条线」「输入框本体」「中控本体面」三个子部件**都还在** —— 它们名下还有别的字段。
 */
const RENDERABLE_CC_FIELDS_BEFORE: readonly string[] = [
  'ccBg', 'ccBgImage', 'ccHeight', 'ccHintFontSize', 'ccMarginBottom', 'ccMarginX', 'ccRadius', 'ccSurfaceOpacity',
  'cliHintMode', 'cliLineColor', 'cliLineWidth', 'cliPromptColor', 'cliTextColor',
  'inputBg', 'inputBgImage', 'inputBorder', 'inputBorderOpacity', 'inputBorderWidth', 'inputFocusBorder',
  'inputFocusRingColor', 'inputFocusRingEnabled', 'inputFont', 'inputFontSize', 'inputHeight', 'inputHighlightOpacity', 'inputLineHeight', 'inputMarginX',
  'inputOffsetTop', 'inputPlaceholder', 'inputRadius', 'inputShadowEnabled', 'inputShowHistoryHint',
  'inputSubmitButtonMode', 'inputSurfaceBg', 'inputSurfaceOpacity', 'inputTextColor',
  'modeAutoColor', 'modeEditColor',
  'modelBgColor', 'modelFontSize', 'modelHeight', 'modelRadius', 'modelSwitchMode', 'modelTextColor', 'modelWidth',
  'permissionBgColor', 'permissionFontSize', 'permissionHeight', 'permissionRadius', 'permissionSwitchMode', 'permissionTextColor', 'permissionWidth',
  'reasoningBgColor', 'reasoningFontSize', 'reasoningHeight', 'reasoningRadius', 'reasoningSwitchMode', 'reasoningTextColor', 'reasoningWidth',
  'sendButtonBorderColor', 'sendButtonColor', 'sendButtonIcon', 'sendButtonIconColor', 'sendButtonIconGenerating', 'sendButtonIconRound',
  'sendButtonRadius',
]

/** 渲染器认的"能显示出来" = 非 hidden + 自己的 group 在分组表里（同 `themeFieldRenderer.tsx` 的判据）。 */
function renderableCcFields(): string[] {
  const groupTitles = new Set((GROUP_ORDER.cc ?? []).flatMap(section => section.groups.map(group => group.title)))
  return THEME_FIELD_KEYS
    .filter(key => {
      const def = defs[key]
      return def.zone === 'cc' && !def.hidden && def.group !== undefined && groupTitles.has(def.group)
    })
    .sort()
}

/** 定义表里所有子部件的 label（= 合法归属值）。 */
const memberLabels: readonly string[] = CC_WIDGET_GROUPS.flatMap(row => row.members.map(member => member.label))

describe('#238 刀6 · 设置页中控区分组：字段集合不变量', () => {
  it('★ 可渲染的 cc 字段集合与改造前**逐条相同**（多一项/少一项都是红的）', () => {
    expect(renderableCcFields(), '中控区的项在设置页里凭空增减了 —— 归属被写坏').toEqual([...RENDERABLE_CC_FIELDS_BEFORE].sort())
  })

  it('每个非隐藏 cc 字段的 group 恰好等于某个子部件的 label（写成旧标签或错字即红）', () => {
    // 注意：这里遍历的是**全部非隐藏 cc 字段**（不是"可渲染的"）——
    // 归属写坏时那个字段会从"可渲染集合"里掉出去，若只看可渲染集合就会**漏检它自己**。
    const bad: string[] = []
    for (const key of THEME_FIELD_KEYS.filter(key => defs[key].zone === 'cc' && !defs[key].hidden)) {
      const group = defs[key].group
      if (group === undefined) bad.push(`${key} → 没有 group（非隐藏的 cc 字段必须有归属）`)
      else if (!memberLabels.includes(group)) bad.push(`${key} → group="${group}" 不是任何子部件的名字`)
    }
    expect(bad, `以下字段的归属值不是子部件名：\n${bad.join('\n')}`).toEqual([])
  })

  it('每个字段**恰好**属于一个子部件（无重复归属）', () => {
    const owners = new Map<string, string[]>()
    for (const [label, keys] of Object.entries(CC_MEMBER_FIELDS)) {
      for (const key of keys) owners.set(key, [...(owners.get(key) ?? []), label])
    }
    const dup = [...owners].filter(([, labels]) => labels.length !== 1)
    expect(dup).toEqual([])
    // 反向：每个可渲染字段都必须在这张归属表里（否则它不属于任何子部件 ⇒ 分组表里没有它）
    const missing = renderableCcFields().filter(key => !owners.has(key))
    expect(missing, `以下字段没有任何子部件认领：${missing.join(', ')}`).toEqual([])
  })

  it('GROUP_ORDER.cc 的分区 = 各元件的 label（顺序同表），组 = 该元件下有字段的子部件 label', () => {
    const expected = CC_WIDGET_GROUPS
      .map(row => ({
        heading: row.label,
        groups: row.members.filter(member => (CC_MEMBER_FIELDS[member.label] ?? []).length > 0).map(member => member.label),
      }))
      .filter(section => section.groups.length > 0)
    expect((GROUP_ORDER.cc ?? []).map(section => ({ heading: section.heading, groups: section.groups.map(group => group.title) })))
      .toEqual(expected)
  })

  it('旧的两张空标题（附件按钮 / 其他指示元素）不再出现在分组表里', () => {
    const headings = (GROUP_ORDER.cc ?? []).map(section => section.heading)
    expect(headings).not.toContain('附件按钮')
    expect(headings).not.toContain('其他指示元素')
    // 也没有任何"只有标题、没有组"的分区（那正是本刀要清的病）
    const emptySections = (GROUP_ORDER.cc ?? []).filter(section => section.groups.length === 0)
    expect(emptySections, '分组表里还有空分区（会渲染成只有标题的分类）').toEqual([])
    // 反向确认没被"空手放过"：元件行仍在 8 行，**但**「用量」已无任何可调项 ⇒ 只剩 7 个分区
    // （★ #266 CC-07：`tokens` 的两个字段删完后它的成员计数为 0，按派生规则整块退出设置页与左栏导航）
    expect(CC_WIDGET_GROUPS).toHaveLength(8)
    expect(headings).toHaveLength(CC_WIDGET_GROUPS.length - 1)
    expect(headings).toContain('发送按钮')
    expect(headings).not.toContain('用量')
  })

  it('没有可调项的子部件不进分组表（命令菜单 / 输入预测 / 待发送队列 / 报错条 / 空态插槽 / 各菜单）', () => {
    const groupTitles = (GROUP_ORDER.cc ?? []).flatMap(section => section.groups.map(group => group.title))
    for (const label of ['/ 命令菜单', '输入预测', '待发送队列', '报错条', '空态插槽', '模型菜单', '思考强度菜单', '权限菜单']) {
      expect(groupTitles, `${label} 没有可调项，不该出现在设置页分组里`).not.toContain(label)
    }
  })

  it('★ 中控区没有"按输入模式判明"的项（可渲染 66 项，与模式无关）', () => {
    // #266（2026-09-23 用户口径「不要这个判明条件，常态显示」）：设置页侧的 cc 字段本来就没有
    // showIf，这条把"没有"钉住 —— 有人给中控字段挂条件即红（上一条冻结清单也会同步红）。
    // ★ #266 刀9：原先这个用例拿 `{ inputMode }` 当 showIf 的上下文去跑两遍；`inputMode`
    //   字段已删除、cc 区也早已没有任何 showIf ⇒ 改成**直接按冻结清单**断言项数（判据更直白：
    //   可渲染集合只由「zone/group/隐藏」决定，没有任何条件可言）。
    // ★ #266 CC-21：`inputFont` 加入 ⇒ 65 → 66。
    const renderable = renderableCcFields()
    expect(renderable, '中控区可渲染项数').toHaveLength(66)
    // 反向确认：cc 区任何字段都不该有 showIf（这条才是"没有判明条件"的真正守卫）
    expect(THEME_FIELD_KEYS.filter(key => defs[key].zone === 'cc' && defs[key].showIf)).toEqual([])
  })
})
