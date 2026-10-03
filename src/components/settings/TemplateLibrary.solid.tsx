/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useCustomPresetStore } from '../../domains/theme/customPresetStore'
import { GLOBAL_PRESETS } from '../../domains/theme/presets/index.ts'
import { effectivePresetTheme } from '../../domains/theme/zones/index.ts'
import { THEME_DEFAULTS } from '../../domains/theme/themeFieldDefs'
import type { ThemeSettings } from '../../domains/theme/themeStore'
import { themeToCssVars } from './templateThemeVars.ts'
import { createPresetBundle, presetCoverage, type PresetApplyResult } from '../../domains/theme/presetBundle.ts'
import { normalizeCustomPresetId } from '../../domains/theme/customPresets.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import SettingsPreviewSolid from '../SettingsPreview.solid.tsx'

/**
 * TemplateLibrary — 官方/自定义模板库（W2-14，F3-C/T2）。
 *
 * #515：Solid 实体（原 TemplateLibrary.tsx 为 React 薄桥）。
 *
 * 官方预设 + 用户自定义两分区；预览 = 对 delta 计算 { ...THEME_DEFAULTS, ...delta }
 * 的内存态 cssVars 注入预览容器局部 style（预览本体是 SettingsPreview，#515 W1 起
 * solid-in-solid 直连实体——原 React 预览岛 TemplateLibraryPreviewIsland 退役，不触
 * 全局 store）；点击才应用（setGlobalPreset / applyCustomPreset）；「恢复此模板默认」
 * 重应用当前模板 delta（清手调字段）。
 */

interface TemplateLibraryProps {
  onApply: (presetName: string) => void | Promise<void>
  onRestore: (presetName: string) => void | Promise<void>
  onCustomApply?: (presetId: string) => Promise<PresetApplyResult>
}

interface TemplateView {
  id: string
  name: string
  label: string
  interfaceMode?: string
  theme: Partial<ThemeSettings>
  bundle?: import('../../domains/theme/presetBundle.ts').PresetBundleV2
}

export default function TemplateLibrary(props: TemplateLibraryProps) {
  const customPresets = createZustandSignal(useCustomPresetStore, s => s.customPresets)
  const [applyingId, setApplyingId] = createSignal<string | null>(null)
  // 组件体只跑一次，普通可变变量充当 ref（进行中模板的互斥标记）
  let applying: string | null = null
  const [applyFeedback, setApplyFeedback] = createSignal<{ kind: 'success' | 'error'; message: string } | null>(null)
  // 刀3（#223）：预设不再自带 `theme` ⇒ 走有效值视图。
  // ★ 只算**一次**、两处共用：显示用的主题与 `createPresetBundle` 落盘的主题必须同源。
  const official: TemplateView[] = GLOBAL_PRESETS.map(preset => {
    const theme = effectivePresetTheme(preset)
    return {
      id: `official:${preset.name}`,
      name: preset.name,
      label: preset.label,
      interfaceMode: preset.interfaceMode,
      theme: { ...THEME_DEFAULTS, ...theme } as Partial<ThemeSettings>,
      bundle: createPresetBundle({ id: `official:${preset.name}`, name: preset.label, now: 0, source: 'builtin', theme: theme as unknown as import('../../domains/theme/presetBundle.ts').PresetJsonValue }),
    }
  })
  // 刀5（#201）：官方模板分组跟随预设归属表（GUI / 终端 两桶）
  const officialGui = official.filter(preset => preset.interfaceMode === 'gui')
  const officialTerminal = official.filter(preset => preset.interfaceMode === 'terminal')

  const custom = createMemo<TemplateView[]>(() => customPresets().map(preset => ({
    id: `custom:${preset.id}`,
    name: preset.id,
    label: preset.name,
    theme: { ...THEME_DEFAULTS, ...preset.theme } as Partial<ThemeSettings>,
    bundle: preset.bundle,
  })))

  const applyTemplate = async (template: { id: string; name: string }) => {
    if (applying) return
    const isCustom = template.id.startsWith('custom:')
    applying = template.id
    setApplyingId(template.id)
    setApplyFeedback(null)
    try {
      if (isCustom) {
        const result = await (props.onCustomApply
          ? props.onCustomApply(normalizeCustomPresetId(template.name))
          : useCustomPresetStore.getState().applyCustomPreset(normalizeCustomPresetId(template.name)))
        if (result.status === 'applied') {
          setApplyFeedback({
            kind: 'success',
            message: result.unavailable && result.unavailable.length > 0
              ? `自定义预设已应用（不可用提供者：${result.unavailable.join('、')}）`
              : '自定义预设已应用',
          })
        } else {
          setApplyFeedback({ kind: 'error', message: `自定义预设应用失败（${result.failedProvider}）：${result.message}` })
        }
      } else {
        await props.onApply(template.name)
        setApplyFeedback({ kind: 'success', message: '预设已应用' })
      }
    } catch (error) {
      setApplyFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      applying = null
      setApplyingId(null)
    }
  }

  const renderCard = (template: TemplateView) => (
    <div class="template-card">
      <div class="template-preview" style={themeToCssVars(template.theme)}>
        {/* #515 W1：预览岛（TemplateLibraryPreviewIsland + SettingsPreview React 桥）
            退役，实体直连——zone 固定 global，挂载后无 props 流。 */}
        <SettingsPreviewSolid zone="global" />
      </div>
      <div class="template-actions">
        <button type="button" class="template-apply" disabled={applyingId() !== null} aria-busy={applyingId() === template.id || undefined} onClick={() => { void applyTemplate(template) }}>
          {applyingId() === template.id ? '应用中…' : '应用'}
        </button>
        <Show when={!template.id.startsWith('custom:')}>
          <button type="button" class="template-restore" onClick={() => void props.onRestore(template.name)}>恢复此模板默认</button>
        </Show>
      </div>
      <div class="template-label">{template.label}</div>
      <div class="template-coverage" aria-label="预设覆盖范围">
        <For each={presetCoverage(template.bundle)}>{item => <span
          class={`is-${item.state}`}
          title={item.policy ? `${item.policy === 'complete' ? '完整' : '局部'}覆盖：显式 ${item.explicit}，默认 ${item.defaulted}，不可用 ${item.unavailable}` : undefined}>
          <i aria-hidden="true" />{item.label}{item.state === 'missing'
            ? ' · 未记录'
            : item.state === 'unavailable'
              ? ` · 不可用 ${item.unavailable}`
              : item.state === 'excluded'
                ? ' · 不纳入预设'
              : item.defaulted > 0
                ? ` · ${item.explicit} 显式 / ${item.defaulted} 默认`
                : ` · ${item.explicit} 显式`}{item.policy === 'partial' ? ' · 局部' : ''}
        </span>}</For>
      </div>
    </div>
  )

  return (
    <div class="template-library">
      <Show when={applyFeedback()}>
        <div class={`template-apply-feedback is-${applyFeedback()!.kind}`} role={applyFeedback()!.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{applyFeedback()!.message}</div>
      </Show>
      <div class="template-section">
        <div class="file-section-title">官方模板 · GUI</div>
        <div class="template-grid"><For each={officialGui}>{renderCard}</For></div>
      </div>
      <div class="template-section">
        <div class="file-section-title">官方模板 · 终端</div>
        <div class="template-grid"><For each={officialTerminal}>{renderCard}</For></div>
      </div>
      <div class="template-section">
        <div class="file-section-title">自定义模板</div>
        <Show when={custom().length > 0} fallback={<p class="file-section-hint">还没有自定义模板</p>}>
          <div class="template-grid"><For each={custom()}>{renderCard}</For></div>
        </Show>
      </div>
    </div>
  )
}

