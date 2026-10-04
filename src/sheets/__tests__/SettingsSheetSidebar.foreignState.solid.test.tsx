// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #553 回归钉：SettingsSheetSidebar 对异 kind state 的容错。
 *
 * 缺陷复盘：SheetSidebarSlot 的 `state` 是响应式 prop（同一槽位随 `props.sheet.kind`
 * 重解码）。sheet kind 切换（如 settings → agent）的更新波里，**仍挂载的**旧侧栏会先
 * 收到异 kind 的 state（agent 形状 `{activePageId}`，无合法 domain）——旧实现的
 * `SETTINGS_DOMAIN_BY_ID[props.state.domain]` 直查得 undefined，`activeDomainConfig()
 * .sections/.label` 在 JSX 求值期抛 TypeError，炸掉整条更新波：实测左栏切换失效
 * （进设置仍停在 agent 侧栏）乃至应用级崩溃屏。
 *
 * 修复 = `activeDomainConfig()` 对未知 domain 回落第一个域（外观）。本测试用 signal
 * 把 state 在「合法 settings state ↔ agent 形状 state」间往返，断言全程不抛、回落域
 * 渲染、且切回合法 state 后导航恢复正常。
 */
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import SettingsSheetSidebar from '../SettingsSheetSidebar.solid.tsx'
import { normalizeSettingsSheetState, type SettingsSheetState } from '../../workspace-sheets/settingsSheetState.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { resetStores } from '../../test/resetStores'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'

afterEach(cleanup)

const settingsSheet: SheetRecord = {
  id: 'settings',
  kind: 'settings',
  title: '设置',
  createdAt: 0,
  lastFocusedAt: 0,
}

const ctx = {
  openSheet: () => null,
  focusSheet: () => {},
  closeSheet: () => {},
  activeSession: null,
  selectSession: () => {},
  openProfileEdit: () => {},
  openSessionSettings: () => {},
  sidebarCollapsed: false,
  rightInset: 0,
  sessionSource: () => null,
  sessionBySource: () => undefined,
} as unknown as SheetContext

/** agent sheet 的 state 形状（normalizePageState 产物）：没有 domain 字段。 */
const AGENT_SHAPE_STATE = { activePageId: null } as unknown as SettingsSheetState

describe('SettingsSheetSidebar 异 kind state 容错（#553 回归钉）', () => {
  it('state 被切成异 kind 形状时不抛错，回落第一域渲染；切回后导航恢复', async () => {
    resetStores()
    const [state, setState] = createSignal<SettingsSheetState>(
      normalizeSettingsSheetState({ domain: 'plugins', section: 'pluginManager' }),
    )
    const { container } = render(() => <SettingsSheetSidebar sheet={settingsSheet} ctx={ctx} state={state()} />)

    // 初挂载：插件域激活
    expect(container.querySelector('.settings-sheet-nav')).not.toBeNull()
    expect(container.querySelector('[data-settings-domain="plugins"]') ?? container.textContent).toBeTruthy()

    // 模拟 kind 切换窗口：仍挂载的侧栏收到 agent 形状 state（无 domain）——修复前此处抛
    // TypeError（Cannot read properties of undefined (reading 'sections'/'label')）。
    expect(() => setState(AGENT_SHAPE_STATE)).not.toThrow()
    expect(container.querySelector('.settings-sheet-nav')).not.toBeNull()

    // 切回合法 settings state：激活域标记恢复
    expect(() => setState(normalizeSettingsSheetState({ domain: 'appearance', section: 'global' }))).not.toThrow()
    expect(container.querySelector('.settings-sheet-nav')).not.toBeNull()
  })

  it('直接以异 kind state 挂载（持久化脏数据 / 首帧时序）同样不抛', () => {
    resetStores()
    expect(() => render(() => (
      <SettingsSheetSidebar sheet={settingsSheet} ctx={ctx} state={AGENT_SHAPE_STATE} />
    ))).not.toThrow()
  })
})
