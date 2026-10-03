/** @jsxImportSource solid-js */
/**
 * settingsPreviewControlCenter — 设置页中控预览的 Solid 挂载点（P52 D4）。
 *
 * 由 settingsPreviewControlCenterLoader 经 import.meta.glob 加载（宿主
 * 不直接 import 本文件，保持加载缝类型隔离）。数据来自 preview fixture
 * 服务（与 RendererSettingsPreview 同源）；主题由宿主经 setTheme 同步。
 */
import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { SolidWorkbenchContext } from './SolidWorkbenchContext.solid.tsx'
import { SolidControlCenter } from './input/ControlCenter.solid.tsx'
import { createPreviewWorkbenchServices } from './preview/previewWorkbenchServices.ts'

export function mountSettingsPreviewControlCenter(host: HTMLElement) {
  const services = createPreviewWorkbenchServices()
  // 预览必须对 setTheme 实时响应：把 appearance store 桥接成 Solid signal，
  // 否则 appearanceSnapshot 是普通函数，Solid 追踪不到 store 变化（mount 后主题不刷新）。
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const unsubscribeAppearance = services.appearance.subscribe(() => {
    setAppearanceSnapshot(services.appearance.getSnapshot())
  })
  const input = () => ({
    sheetId: 'settings-preview',
    sessionId: 'preview-session',
    preview: true,
    visibility: 'active' as const,
    reducedMotion: true,
    availableWorkspaces: [],
  })
  const dispose = render(() => (
    <SolidWorkbenchContext.Provider value={{
      input,
      runtime: services.runtime,
      runtimeSnapshot: () => services.runtime.getSnapshot(),
      appearance: services.appearance,
      appearanceSnapshot,
      sessionUi: services.sessionUi,
      commands: services.commands,
      paused: () => false,
    }}>
      <SolidControlCenter />
    </SolidWorkbenchContext.Provider>
  ), host)
  return {
    setTheme: (theme: Record<string, unknown>) => { services.appearance.setTheme(theme as never) },
    destroy() {
      unsubscribeAppearance()
      dispose()
      services.destroy()
      host.replaceChildren()
    },
  }
}
