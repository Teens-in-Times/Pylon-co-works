/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'

import { applyPresentationProfile } from '../../application/transactions/applyPresentationProfile.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getPresentationProfileRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { useThemeStore } from '../../domains/theme/themeStore.ts'
import { presentationProfileInterfaceMode } from '../../application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'


/** #515：PresentationProfilePicker 的 Solid 实体（原 .tsx 为 React 薄桥）。 */
export default function PresentationProfilePicker() {
  const profileRegistry = getPresentationProfileRegistry()
  const registrySnapshot = createZustandSignal(
    { getState: () => profileRegistry.getSnapshot(), subscribe: listener => profileRegistry.subscribe(() => listener(profileRegistry.getSnapshot())) },
    // registry 的 subscribe 回调不传快照，selector 自取。
    () => profileRegistry.getSnapshot(),
  )
  const profiles = createMemo(() => registrySnapshot().entries)
  const activeProfileId = createZustandSignal(usePresentationPreferenceStore, s => s.activeProfileId)
  const interfaceMode = createZustandSignal(useInterfaceModeStore, s => s.interfaceMode)
  const [feedback, setFeedback] = createSignal<{ kind: 'success' | 'error'; message: string } | null>(null)
  const familyLabels: Record<string, string> = { terminal: '终端', reading: '阅读', hybrid: '混合', gui: 'GUI', custom: '插件' }

  const activate = (id: string) => {
    const profile = profileRegistry.resolve(id)?.value
    if (!profile) {
      setFeedback({ kind: 'error', message: `呈现风格不存在：${id}` })
      return
    }
    const result = applyPresentationProfile(profile, {
      setZoneField: (zone, patch, source) => useThemeStore.getState().setZoneField(zone, patch, source),
      setActiveProfileId: next => {
        usePresentationPreferenceStore.getState().setActiveProfileId(next)
        useInterfaceModeStore.getState().rememberProfile(interfaceMode(), next)
      },
    })
    setFeedback(result.status === 'applied'
      ? { kind: 'success', message: '呈现风格已应用' }
      : { kind: 'error', message: `呈现风格应用失败（${result.failedProvider}）：${result.message}` })
  }

  return (
    <div class="presentation-settings" data-pylon-component="presentation-profile-picker">
      <Show when={feedback()}>
        <div class={`presentation-profile-feedback is-${feedback()!.kind}`} role={feedback()!.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{feedback()!.message}</div>
      </Show>
      <div class="presentation-profile-grid" aria-label="渲染风格">
        <For each={profiles().filter(entry => presentationProfileInterfaceMode(entry.value) === interfaceMode())}>{entry => {
          const profile = entry.value
          const active = () => profile.id === activeProfileId()
          return (
            <button
              type="button"
              class={`presentation-profile-card${active() ? ' active' : ''}`}
              onClick={() => activate(profile.id)}
              aria-pressed={active()}
            >
              <span class="presentation-profile-asset" aria-hidden="true">
                {profile.assets?.assistantGlyph || profile.assets?.promptGlyph || '◆'}
              </span>
              <span class="presentation-profile-copy">
                <strong>{profile.label}</strong>
                <small>{profile.description || profile.family}</small>
              </span>
              <span class="presentation-profile-family">{familyLabels[profile.family] ?? profile.family}</span>
            </button>
          )
        }}</For>
      </div>
    </div>
  )
}
