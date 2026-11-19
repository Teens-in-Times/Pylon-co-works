// @vitest-environment jsdom
// #515：迁移自 TemplateLibrary.globalPresets.test.tsx（React RTL → Solid 实体直连）。
// 断言改写点登记：SettingsPreview 经 vi.mock 打桩（#515 W1 起实体直连，mock 路径随
// .solid 实体；工厂产 Solid 元素）；断言集原样保留。
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStores } from '../../../test/resetStores.ts'
import TemplateLibrary from '../TemplateLibrary.solid.tsx'
import { useThemeStore } from '../../../domains/theme/themeStore.ts'
import { useCustomPresetStore } from '../../../domains/theme/customPresetStore.ts'

vi.mock('../../SettingsPreview.solid.tsx', () => ({
  default: () => <div data-testid="settings-preview" />,
}))

afterEach(() => cleanup())

describe('TemplateLibrary global presets', () => {
  beforeEach(() => resetStores())

  it('点击自定义模板按 canonical id 应用主题，而不是展示名称', async () => {
    useCustomPresetStore.setState({ customPresets: [{
      id: 'custom-42', name: '我的同名模板', theme: { chatFontSize: 19 }, createdAt: 1, updatedAt: 1,
    }] })
    render(() => <TemplateLibrary onApply={vi.fn()} onRestore={vi.fn()} />)
    const card = screen.getByRole('article', { name: '我的同名模板' })
    fireEvent.click(within(card).getByRole('button', { name: '应用' }))
    await expect(screen.findByRole('status')).resolves.toHaveTextContent('自定义预设已应用')
    expect(useThemeStore.getState().chatFontSize).toBe(19)
    expect(card).toHaveAttribute('aria-current', 'true')
    expect(useThemeStore.getState().appliedPreset.global).toBe('custom-42')
  })

  it('把旧版 bare id 归一化后再交给应用 transaction', async () => {
    useCustomPresetStore.setState({ customPresets: [{
      id: 'legacy-42', name: '旧版模板', theme: { chatFontSize: 18 }, createdAt: 1, updatedAt: 1,
    }] })
    const onCustomApply = vi.fn(async () => ({
      status: 'applied' as const, id: 'custom-legacy-42', providers: ['builtin.theme'], revision: 1,
    }))
    render(() => <TemplateLibrary onApply={vi.fn()} onRestore={vi.fn()} onCustomApply={onCustomApply} />)
    const card = screen.getByRole('article', { name: '旧版模板' })
    fireEvent.click(within(card).getByRole('button', { name: '应用' }))
    await expect(screen.findByRole('status')).resolves.toHaveTextContent('自定义预设已应用')
    expect(onCustomApply).toHaveBeenCalledWith('custom-legacy-42')
  })

  it('把 provider 失败结果显示为可操作的错误，而不是静默成功', async () => {
    useCustomPresetStore.setState({ customPresets: [{
      id: 'custom-failed', name: '失败模板', theme: { chatFontSize: 19 }, createdAt: 1, updatedAt: 1,
    }] })
    const onCustomApply = vi.fn(async () => ({
      status: 'failed' as const, id: 'custom-failed', failedProvider: 'builtin.renderer-settings',
      message: 'renderer unavailable', rolledBack: true, revision: 3,
    }))
    render(() => <TemplateLibrary onApply={vi.fn()} onRestore={vi.fn()} onCustomApply={onCustomApply} />)
    const card = screen.getByRole('article', { name: '失败模板' })
    fireEvent.click(within(card).getByRole('button', { name: '应用' }))

    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('builtin.renderer-settings')
    expect(onCustomApply).toHaveBeenCalledWith('custom-failed')
  })

  it('在官方全局预设中展示并可应用三套 Agent 工作流预设', () => {
    const onApply = vi.fn()
    render(() => <TemplateLibrary onApply={onApply} onRestore={vi.fn()} />)

    for (const label of ['Agent 指挥台', 'Agent 关系图', '专注流程']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }

    const commandCard = screen.getByRole('article', { name: 'Agent 指挥台' })
    fireEvent.click(within(commandCard).getByRole('button', { name: '应用' }))
    expect(onApply).toHaveBeenCalledWith('agent-command')
  })

  it('恢复期间锁定其他模板，失败时显示原因并重新开放应用', async () => {
    let rejectRestore!: (reason: Error) => void
    const onRestore = vi.fn(() => new Promise<void>((_, reject) => { rejectRestore = reject }))
    render(() => <TemplateLibrary onApply={vi.fn()} onRestore={onRestore} />)
    const selected = screen.getByRole('article', { name: 'Agent 指挥台' })
    const other = screen.getByRole('article', { name: '专注流程' })

    fireEvent.click(within(selected).getByRole('button', { name: '恢复此模板默认' }))
    expect(onRestore).toHaveBeenCalledWith('agent-command')
    expect(within(other).getByRole('button', { name: '应用' })).toBeDisabled()
    expect(within(other).getByRole('button', { name: '恢复此模板默认' })).toBeDisabled()
    rejectRestore(new Error('恢复失败'))

    expect(await screen.findByRole('alert')).toHaveTextContent('恢复失败')
    expect(within(other).getByRole('button', { name: '应用' })).toBeEnabled()
  })
})
