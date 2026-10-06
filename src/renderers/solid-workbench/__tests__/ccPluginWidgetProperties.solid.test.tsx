// @vitest-environment jsdom
/**
 * #266 CC-13 刀4 集成：**插件件的属性表单真的能动 + 来源小签 + 非法声明不静默**。
 *
 * 锁施工单 §6 的 1~3 与 §4.2 / §4.3 / §4.6：
 * 1. **参数可调**：插件自报的四种字段（section / number / color / chips）在编辑列行内展开区渲染，
 *    读数 = `ccPluginProps[id]?.[key] ?? 声明缺省`（number ⇒ min / chips ⇒ 第一项 / color ⇒ ''）；
 *    改值 ⇒ 值进 `ccPluginProps`、面板读数跟随（number 取 min–max、chips 只发声明里的值）；
 * 2. **值随 store 往返**（模拟"刷新后仍在"的机器可判部分）：面板写进去的值经**读盘路径**
 *    （`alignThemeStructure`）后仍在 ⇒ 新挂载的面板读数 = 存值，不是声明缺省；
 * 3. **来源小签**：插件件行有「插件」小签、内置件行没有；
 * 4. **非法声明**：该字段丢弃（不渲染）+ 诊断 `cc-widget.property-field.rejected`，该件照常上屏。
 *
 * ★ 实机读数（localStorage 片段 + 刷新）见工作者汇报的「运行态读数」节 —— jsdom 无持久化面，
 *   这里用"读盘路径往返 + 新挂载"替代。
 */
import { cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort, type RendererDiagnosticContext } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { activateTestBuiltinPlugin } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { deactivatePluginInstance, type PluginInstance } from '../../../plugin-runtime/pluginInstance.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { alignThemeStructure } from '../../../domains/theme/migration.ts'
import { PRESET_ZONES } from '../../../domains/theme/presetReducer.ts'
import type { CcWidgetContribution } from '../../../plugin-runtime/cc-widget/ccWidgetTypes.ts'
import type { ThemeSettings } from '../../../domains/theme/themeTypes.ts'

const WIDGET = 'test.cc-props'
const ILLEGAL_WIDGET = 'test.cc-props-illegal'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []
const instances: PluginInstance[] = []

afterEach(async () => {
  cleanup()
  while (instances.length > 0) await deactivatePluginInstance(instances.pop()!)
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

function mountWorkbench(theme?: ThemeSettings) {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  if (theme) services.appearance.setTheme(structuredClone(theme))
  servicesList.push(services)
  const diagnostics: RendererDiagnosticContext[] = []
  const hostPort = createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-cc-props',
    sessionOwnerKey: 'owner-cc-props',
    sessionId: 'preview-session',
    diagnostics: diagnostic => { diagnostics.push(diagnostic) },
  })
  const lifecycle = mountSolidWorkbench({
    host,
    input: { sheetId: 'sheet-cc-props', sessionId: 'preview-session', preview: true, rightInset: 24, reducedMotion: true },
    services,
    hostPort,
  })
  return { host, services, lifecycle, diagnostics }
}

async function registerWidget(
  widget: CcWidgetContribution,
  pluginId = 'test.cc-props-plugin',
): Promise<PluginInstance> {
  const instance = await activateTestBuiltinPlugin(createPluginIdentity(pluginId, 'root'), ({ ccWidget }) => {
    ccWidget.registerWidget(widget)
  })
  instances.push(instance)
  return instance
}

/**
 * 打开某行（点行名 ⇒ 选中并展开）；行名 = 插件自报 label / 内置件的中文名。
 * ★ 查询一律**限定在本次挂载的 host 内**：`cleanup()` 只 dispose 组件、不摘 DOM
 *   ⇒ 同一用例里第二次挂载时，`document` 上还能查到上一份（已死）的节点。
 */
async function openRow(root: ParentNode, name: string): Promise<HTMLElement> {
  const button = await waitFor(() => {
    const node = root.querySelector<HTMLButtonElement>(`.cc-edit-column [aria-label="${name} 属性"]`)
    expect(node).toBeTruthy()
    return node!
  })
  fireEvent.click(button)
  return waitFor(() => {
    const row = root.querySelector<HTMLElement>('.cc-edit-row.active')
    expect(row).toBeTruthy()
    return row!
  })
}

const fieldInput = (row: HTMLElement, label: string) =>
  row.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
const chips = (row: HTMLElement, label: string) => {
  const field = [...row.querySelectorAll<HTMLElement>('.cc-prop-field')]
    .find(node => node.querySelector('label')?.textContent === label)
  if (!field) throw new Error(`没有找到 chips 字段：${label}`)
  return [...field.querySelectorAll<HTMLButtonElement>('.set-preset-chip')]
}

/** 一份配色齐全的插件属性声明（四种 kind 各一）。 */
const PROPERTY_FIELDS = [
  { kind: 'section', title: '外观' },
  { kind: 'number', key: 'size', label: '大小', min: 10, max: 60, step: 2, suffix: 'px' },
  { kind: 'color', key: 'accent', label: '强调色' },
  {
    kind: 'chips', key: 'shape', label: '形状',
    options: [{ value: 'round', label: '圆' }, { value: 'square', label: '方' }],
  },
] as const

async function mountWithPropertyWidget() {
  const dom = mountWorkbench()
  await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
  await registerWidget({
    id: WIDGET,
    label: '属性件',
    render: { kind: 'host-renderer', rendererKey: 'tokens' },
    propertyFields: PROPERTY_FIELDS as unknown as CcWidgetContribution['propertyFields'],
  })
  await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${WIDGET}"]`)).not.toBeNull())
  dom.services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
  const row = await openRow(dom.host, '属性件')
  return { dom, row }
}

describe('#266 CC-13 刀4 · 插件件属性表单', () => {
  it('四种字段渲染 + 声明缺省读数（number ⇒ min / color ⇒ 空 / chips ⇒ 第一项）+ 来源小签', async () => {
    const { dom, row } = await mountWithPropertyWidget()

    // section：分组标题在场
    expect([...row.querySelectorAll('.cc-prop-sec')].map(node => node.textContent)).toContain('外观')
    // number：读数是**声明缺省** min（不是 0 / NaN），min/max/step/suffix 全来自声明
    const size = fieldInput(row, '大小')!
    expect(size.value).toBe('10')
    expect(size.getAttribute('min')).toBe('10')
    expect(size.getAttribute('max')).toBe('60')
    expect(size.getAttribute('step')).toBe('2')
    expect(row.textContent).toContain('px')
    // color：没设过 ⇒ 空串
    expect(fieldInput(row, '强调色')!.value).toBe('')
    // chips：第一项 active
    const shape = chips(row, '形状')
    expect(shape.map(button => button.textContent)).toEqual(['圆', '方'])
    expect(shape[0]).toHaveClass('active')
    expect(shape[1]).not.toHaveClass('active')

    // 来源小签：插件件行有，内置件行没有
    const pluginRow = document.querySelector('.cc-edit-column [aria-label="属性件 属性"]')!.closest('.cc-edit-row')!
    expect(pluginRow.querySelector('.cc-edit-row-source')?.textContent).toBe('插件')
    const badged = [...document.querySelectorAll<HTMLElement>('.cc-edit-column .cc-edit-row')]
      .filter(node => node.querySelector('.cc-edit-row-source'))
      .map(node => node.querySelector('.cc-edit-row-name')?.textContent ?? '')
    expect(badged).toHaveLength(1)
    expect(badged[0]).toContain('属性件')
    // 内置件的行照旧（没有小签）
    expect(document.querySelector('.cc-edit-column [aria-label="模型 属性"]')!.closest('.cc-edit-row')!
      .querySelector('.cc-edit-row-source')).toBeNull()
    expect(dom.diagnostics.filter(item => item.code === 'cc-widget.property-field.rejected')).toEqual([])
  })

  it('写回：number 取 min–max / chips 只发声明里的值 / color 走字符串 ⇒ 值进 ccPluginProps', async () => {
    const { dom, row } = await mountWithPropertyWidget()
    const snapshot = () => dom.services.appearance.getSnapshot()

    // ① number 上越界（999）⇒ clamp 到 max
    fireEvent.input(fieldInput(row, '大小')!, { target: { value: '999' } })
    await waitFor(() => expect(snapshot().ccPluginProps[WIDGET]).toEqual({ size: 60 }))
    await waitFor(() => expect(fieldInput(row, '大小')!.value).toBe('60'))
    // ② number 下越界（1）⇒ clamp 到 min
    fireEvent.input(fieldInput(row, '大小')!, { target: { value: '1' } })
    await waitFor(() => expect(snapshot().ccPluginProps[WIDGET]).toEqual({ size: 10 }))
    // ③ 正常值原样；且**不写别的字段**（键 = 插件自定义短键）
    fireEvent.input(fieldInput(row, '大小')!, { target: { value: '42' } })
    await waitFor(() => expect(snapshot().ccPluginProps[WIDGET]).toEqual({ size: 42 }))
    // ④ chips：点第二项 ⇒ 值 + active 态跟随
    fireEvent.click(chips(row, '形状')[1])
    await waitFor(() => expect(snapshot().ccPluginProps[WIDGET]).toEqual({ size: 42, shape: 'square' }))
    expect(chips(row, '形状')[0]).not.toHaveClass('active')
    expect(chips(row, '形状')[1]).toHaveClass('active')
    // ⑤ color：字符串原样落
    fireEvent.change(fieldInput(row, '强调色')!, { target: { value: '#123456' } })
    await waitFor(() => expect(snapshot().ccPluginProps[WIDGET]).toEqual({ size: 42, shape: 'square', accent: '#123456' }))
    expect(fieldInput(row, '强调色')!.value).toBe('#123456')
    // 面板字段写不进主题 cc 区字段（插件短键不是主题字段键）
    expect(snapshot().ccProperties.modelWidth).toBe(DEFAULTS.modelWidth)
  })

  it('值随 store 往返（模拟重启）：走读盘路径后仍在 ⇒ 新挂载的读数 = 存值，不是声明缺省', async () => {
    const { dom, row } = await mountWithPropertyWidget()
    fireEvent.input(fieldInput(row, '大小')!, { target: { value: '42' } })
    fireEvent.change(fieldInput(row, '强调色')!, { target: { value: '#00ff00' } })
    await waitFor(() => expect(dom.services.appearance.getSnapshot().ccPluginProps[WIDGET]).toEqual({ size: 42, accent: '#00ff00' }))

    // 「写盘 → 重启读盘」：拿存储面（快照的深拷贝）过一遍真实读盘路径
    const persisted = {
      ...structuredClone(DEFAULTS),
      ccPluginProps: JSON.parse(JSON.stringify(dom.services.appearance.getSnapshot().ccPluginProps)),
    }
    const defaults = {
      base: DEFAULTS,
      appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])),
      custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
      ccLayout: DEFAULTS.ccLayout,
    }
    const reloaded = alignThemeStructure(persisted, defaults) as unknown as ThemeSettings
    expect(reloaded.ccPluginProps[WIDGET]).toEqual({ size: 42, accent: '#00ff00' })

    // 新挂载（= 重启后）：面板读数 = 存值
    cleanup()
    const next = mountWorkbench(reloaded)
    await waitFor(() => expect(next.host.querySelector(`[data-widget-id="${WIDGET}"]`)).not.toBeNull())
    next.services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const nextRow = await openRow(next.host, '属性件')
    expect(fieldInput(nextRow, '大小')!.value).toBe('42')
    expect(fieldInput(nextRow, '强调色')!.value).toBe('#00ff00')
    expect(chips(nextRow, '形状')[0]).toHaveClass('active')
  })

  it('非法声明：该字段丢弃（不渲染）+ 诊断（不静默）；该件照常上屏、合法字段照常可调', async () => {
    const dom = mountWorkbench()
    await waitFor(() => expect(dom.host.querySelector('[data-widget-id="model"]')).not.toBeNull())
    await registerWidget({
      id: ILLEGAL_WIDGET,
      label: '脏声明件',
      render: { kind: 'host-renderer', rendererKey: 'tokens' },
      propertyFields: [
        { kind: 'range', key: 'a', label: '未知种类' },
        { kind: 'number', key: 'b', label: '缺 max', min: 1 },
        { kind: 'chips', key: 'c', label: '缺 options' },
        { kind: 'color', key: 'd' },
        { kind: 'section', title: '   ' },
        { kind: 'number', key: 'ok', label: '正常字段', min: 0, max: 10 },
      ] as unknown as CcWidgetContribution['propertyFields'],
    })
    await waitFor(() => expect(dom.host.querySelector(`[data-widget-id="${ILLEGAL_WIDGET}"]`)).not.toBeNull())
    dom.services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const row = await openRow(dom.host, '脏声明件')

    // 合法的那一条照常渲染，非法的一条都不渲染
    expect(fieldInput(row, '正常字段')).not.toBeNull()
    for (const label of ['未知种类', '缺 max', '缺 options']) {
      expect(row.querySelector(`input[aria-label="${label}"]`), label).toBeNull()
    }
    // 诊断逐条在场（码 + 原因 + 定位到第几条）
    await waitFor(() => expect(dom.diagnostics.filter(item => item.code === 'cc-widget.property-field.rejected')).toHaveLength(5))
    const messages = dom.diagnostics
      .filter(item => item.code === 'cc-widget.property-field.rejected')
      .map(item => item.message)
    expect(messages[0]).toContain(ILLEGAL_WIDGET)
    expect(messages[0]).toContain('第 1 条')
    expect(messages[0]).toContain('kind 不在 section / number / color / chips 之内')
    expect(messages[1]).toContain('min / max')
    expect(messages[2]).toContain('options')
    expect(messages[3]).toContain('缺 label')
    expect(messages[4]).toContain('缺 title')
    // 合法字段仍可写（该件没被整件拒掉）
    fireEvent.input(fieldInput(row, '正常字段')!, { target: { value: '7' } })
    await waitFor(() => expect(dom.services.appearance.getSnapshot().ccPluginProps[ILLEGAL_WIDGET]).toEqual({ ok: 7 }))
  })
})
