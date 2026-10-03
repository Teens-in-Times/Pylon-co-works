/**
 * ISSUE-13 W2（T13-2）Settings 布局迁移行为测试（#154 阶段 4 改写为 sheet 模型）：
 * - 一级域导航随设置迁入 sheet 体系回到左栏（SettingsSheetSidebar 一二级同栏分层）
 * - 切换 domain → 分区列表跟随 domain config 变化
 * - 选择分区 → 内容渲染正确（复用既有块组件）
 * - 深链入口收敛到 openOrFocusSettingsSheet（事件契约在 App 层接线，别名归一口不变）
 */
// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 settingsDomainNav.test.tsx，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library；显式 afterEach(cleanup)。
// - 点击导航/展开折叠后的 DOM 断言包 waitFor（solid 的 DOM 更新是微任务异步）；
//   sheet 状态与左栏初始结构断言（同步渲染/同步 store 写）保持同步。断言集不缩减。
import { cleanup, fireEvent, screen, waitFor, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../test/fakeInvoke'
import { mountSettingsSheet } from '../test/settingsSheetHarness.solid'
import { openOrFocusSettingsSheet } from '../sheets/settingsSheetNavigation'
import { useIdentityStore } from '../domains/identity/identityStore'
import { resetStores } from '../test/resetStores'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve undefined——Settings 渲染期的后台 invoke 不影响导航断言 */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

let fakeInvoke: TolerantFakeInvoke

describe('ISSUE-13 W2 当前域内 section 导航', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    fakeInvoke = new TolerantFakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    Element.prototype.scrollIntoView = vi.fn()
    useIdentityStore.setState({
      agents: [{ id: 'peri', name: 'Peri' }],
      activeAgent: 'peri',
    })
  })

  afterEach(async () => {
    cleanup()
  })

  // 一二级导航在 sheet 左栏（.settings-sheet-nav）；主区渲染当前分区内容。
  const nav = () => within(document.querySelector('.settings-sheet-nav') as HTMLElement)
  const navButton = (name: string) => nav().getByRole('button', { name })

  it('一二级同栏：左栏上半天是 4 个一级域，tier（快速/进阶/专家）无残留', () => {
    mountSettingsSheet()
    for (const domain of ['外观', '工作区', 'Agent 与连接', '插件']) {
      expect(nav().getByRole('button', { name: new RegExp(domain) })).toBeInTheDocument()
    }
    expect(nav().queryByRole('button', { name: '快速' })).toBeNull()
    expect(nav().queryByRole('button', { name: '进阶' })).toBeNull()
    expect(nav().queryByRole('button', { name: '专家' })).toBeNull()
  })

  it('默认显示外观域分区（模板库/全局/侧栏/消息流/中控台/右栏）——K-2 重命名', () => {
    mountSettingsSheet()
    for (const section of ['模板库', '全局', '侧栏', '消息流', '中控台', '右栏']) {
      expect(navButton(section)).toBeInTheDocument()
    }
  })

  it('切到工作区 → 分区为窗口/历史保留/配置备份；选窗口渲染窗口尺寸块', async () => {
    mountSettingsSheet({ domain: 'workspace' })
    // #483：宠物分区随宠物链删除退役。
    for (const section of ['窗口', '历史保留', '配置备份']) {
      expect(navButton(section)).toBeInTheDocument()
    }
    expect(nav().queryByRole('button', { name: '宠物' })).toBeNull()
    expect(nav().queryByRole('button', { name: '模板库' })).toBeNull()
    fireEvent.click(navButton('窗口'))
    await waitFor(() => expect(screen.getByText('当前尺寸')).toBeInTheDocument())
  })

  it('showPet 无任何设置入口（#483 宠物链删除后的防复活钉）', () => {
    const view = mountSettingsSheet()
    expect(screen.queryByText('桌面宠物')).toBeNull()
    view.unmount()
    mountSettingsSheet({ domain: 'workspace' })
    expect(nav().queryByRole('button', { name: '宠物' })).toBeNull()
    expect(screen.queryByRole('button', { name: /宠物显示中|宠物已隐藏/ })).toBeNull()
  })

  it('切到 Agent 与连接 → 分区为 Agent/会话/Gateway；选 Agent 渲染当前 Agent 区', async () => {
    mountSettingsSheet({ domain: 'agents-connections' })
    for (const section of ['Agent', '会话', 'Gateway']) {
      expect(navButton(section)).toBeInTheDocument()
    }
    fireEvent.click(navButton('Agent'))
    // Agent 分区主区经 AgentSettingsSection（Solid 直连）挂载，渲染提交异步
    await waitFor(() => expect(screen.getByText('当前 Agent')).toBeInTheDocument())
  })

  it('深链意图切换域后分区列表恢复（domain 可往返；已开 sheet 走 patch+聚焦）', async () => {
    mountSettingsSheet({ domain: 'workspace' })
    openOrFocusSettingsSheet({ domain: 'appearance' })
    await waitFor(() => expect(nav().getByRole('button', { name: '模板库' })).toBeInTheDocument())
    for (const section of ['模板库', '全局', '侧栏', '消息流', '中控台', '右栏']) {
      expect(navButton(section)).toBeInTheDocument()
    }
  })
})

describe('K-2 左栏二级折叠导航（施工书 09）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    fakeInvoke = new TolerantFakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('有 ≥2 组的 section 显示折叠箭头，点击展开二级项', async () => {
    mountSettingsSheet()
    const navEl = document.querySelector('.settings-sheet-nav') as HTMLElement
    const w = within(navEl)
    // 消息流（chat zone，12 组）应有展开控件
    const chatBtns = w.getAllByRole('button', { name: /消息流/ })
    const chatBtn = chatBtns.find(b => b.getAttribute('aria-expanded') !== null) ?? chatBtns[0]
    expect(chatBtn.getAttribute('aria-expanded')).not.toBeNull()
    // 默认收起：二级项不可见
    expect(w.queryByRole('button', { name: '语法高亮' })).toBeNull()
    fireEvent.click(chatBtn)
    // 展开后二级项可见（组锚点）
    await waitFor(() => expect(w.getByRole('button', { name: '背景' })).toBeInTheDocument())
    expect(w.getByRole('button', { name: '语法高亮' })).toBeInTheDocument()
  })

  it('页面自有 section（无 zone/组）不显示折叠箭头', () => {
    mountSettingsSheet()
    const navEl = document.querySelector('.settings-sheet-nav') as HTMLElement
    // 模板库是外观 domain 的 page-owned section（无 zone → 无二级）
    const tpl = within(navEl).getByRole('button', { name: '模板库' })
    expect(tpl.getAttribute('aria-expanded')).toBeNull()
  })
})

describe('K-4 边界修复：pinned 跳转与 domain 同步', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    fakeInvoke = new TolerantFakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  })

  it('F1 常用区点击其他 domain 的 section 时，domain 跟随切换', async () => {
    mountSettingsSheet()
    const navEl = document.querySelector('.settings-sheet-nav') as HTMLElement
    const w = within(navEl)
    // 在外观域置顶「消息流」
    const chatRow = w.getByRole('button', { name: '消息流' })
    fireEvent.click(within(chatRow.parentElement as HTMLElement).getByRole('button', { name: '置顶 消息流' }))
    // 深链入口发域切换意图（App 层同一入口；事件名与 detail 形状契约不变）
    openOrFocusSettingsSheet({ domain: 'workspace' })
    await waitFor(() => expect(w.getByRole('button', { name: '窗口' })).toBeInTheDocument())
    // 常用区出现置顶项（★ 为 aria-hidden 装饰，accessible name 即「消息流」）——点它
    const pinnedBtn = w.getAllByRole('button', { name: '消息流' }).find(button => button.classList.contains('pinned'))!
    expect(pinnedBtn.closest('.settings-nav-section-block')).toBeNull()
    fireEvent.click(pinnedBtn)
    // 断言：domain 回到外观（分区列表含「全局」）且内容区是消息流的 Owner 头
    // （#116 子项 4d：Owner 头改显示可读名，原始 owner id 落在 data-owner 上）
    await waitFor(() => expect(w.getByRole('button', { name: '全局' })).toBeInTheDocument())
    const ownerBadge = await waitFor(() => {
      const badge = screen.getByTestId('settings-owner-badge')
      expect(badge.textContent).toContain('消息流组件')
      return badge
    })
    expect(ownerBadge.getAttribute('data-owner')).toBe('message-stream')
  })
})

describe('P6 Slice A 设置入口兼容', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    fakeInvoke = new TolerantFakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  })

  it('消费旧 renderer/suite 深链别名时落到现行渲染器分区', async () => {
    mountSettingsSheet()
    openOrFocusSettingsSheet({ domain: 'renderer', section: 'suite' })
    const navEl = document.querySelector('.settings-sheet-nav') as HTMLElement
    await waitFor(() => {
      expect(within(navEl).getByRole('button', { name: '渲染器' })).toHaveClass('active')
      expect(screen.getByText('Renderer fixture')).toBeInTheDocument()
    })
  })
})
