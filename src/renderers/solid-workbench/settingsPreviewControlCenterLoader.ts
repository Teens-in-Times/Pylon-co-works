/**
 * settingsPreviewControlCenterLoader — 设置页中控预览的 Solid 加载缝
 * （P52 D4，与 loadSolidWorkbenchSmoke 同构：React tsconfig 不触碰 .solid 文件
 * 的类型图，模块接口在此声明）。
 */
export interface SettingsPreviewControlCenterHandle {
  /** 宿主在主题 store 变更时调用（theme 为浅合并快照）。 */
  setTheme(theme: Record<string, unknown>): void
  destroy(): void
}

interface SettingsPreviewControlCenterModule {
  mountSettingsPreviewControlCenter(host: HTMLElement): SettingsPreviewControlCenterHandle
}

const modules = import.meta.glob<SettingsPreviewControlCenterModule>(
  './settingsPreviewControlCenter.solid.tsx',
)

export async function loadSettingsPreviewControlCenter(): Promise<SettingsPreviewControlCenterModule> {
  const load = modules['./settingsPreviewControlCenter.solid.tsx']
  if (!load) throw new Error('Solid 中控预览未进入 Vite module graph')
  return load()
}
