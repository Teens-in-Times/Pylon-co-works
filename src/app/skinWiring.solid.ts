/**
 * skinWiring — 根组件的 Skin 接线（#520 S3-P1-3：自 App.solid 组合根拆出）。
 *
 * 三件事：
 * - 全局基线：Skin Runtime 全局基线 = 当前 Theme Store（基线为派生对象，浅等去重
 *   对齐 React 期 useShallow 语义，避免主题 store 任意通知都重投影）；
 * - 根 surface：`.app` 元素的 createSkinSurface 绑定（layout options 走访问器隧道
 *   保持响应性）；
 * - documentRoot 投影：Portal 与 body::before 都在 `.app` 外，完整投影全局 Skin，
 *   避免二级菜单、新建 Sheet 与设置 Dialog 退回默认主题。
 *
 * Solid 响应式（createEffect/createMemo）→ .solid.ts。
 */
import { createEffect, createMemo, on, onCleanup } from 'solid-js'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { shallowEqual } from '../infrastructure/state/solidStoreKernel.ts'
import { useThemeStore } from '../domains/theme/themeStore'
import { createSkinSurface, type SkinSurfaceBinding } from '../infrastructure/skin/useSkinSurface.solid.ts'
import { projectSkinDocumentRoot } from '../infrastructure/skin/skinProjection'
import { getSkinRuntime, pickThemeBaseline } from '../infrastructure/skin/skinRuntimeServices'

export interface AppSkinWiringInput {
  sidebarCollapsed: () => boolean
  sidebarWidth: () => number
  sidebarEnabled: () => boolean
}

export function createAppSkinWiring(input: AppSkinWiringInput): { appSkin: SkinSurfaceBinding<HTMLDivElement> } {
  // 基线为派生对象：浅等去重（React 期 useShallow 同源语义），避免主题 store 任意
  // 通知都重投影 Skin 基线。createZustandSignal 无 equality 形态，以 equals memo 包一层。
  const rawThemeBaseline = createZustandSignal(
    useThemeStore,
    s => pickThemeBaseline(s as unknown as Record<string, unknown>),
  )
  const themeBaseline = createMemo(() => rawThemeBaseline(), undefined, { equals: shallowEqual })
  const skinRuntime = getSkinRuntime()

  // Skin Runtime 全局基线 = 当前 Theme Store；启用 Runtime 后现有主题外观不变。
  createEffect(() => { skinRuntime.setGlobalBaseline(themeBaseline()) })

  // 根 surface 投影：CSS variables / data-skin-* / scoped css 统一由 resolved skin 派生。
  const appSkin = createSkinSurface<HTMLDivElement>('app', { scope: 'global' }, {}, () => ({
    layout: {
      sidebarCollapsed: input.sidebarCollapsed(),
      sidebarWidth: input.sidebarWidth(),
      sidebarEnabled: input.sidebarEnabled(),
    },
  }))

  // Portal 与 body::before 都在 `.app` 外：完整投影全局 Skin，避免二级菜单、
  // 新建 Sheet 与设置 Dialog 退回默认主题。
  createEffect(on(appSkin.resolved, resolved => {
    onCleanup(projectSkinDocumentRoot(document.documentElement, document.body, resolved))
  }))

  return { appSkin }
}
