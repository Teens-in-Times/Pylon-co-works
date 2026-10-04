/** @jsxImportSource solid-js */
import { createMemo, For } from 'solid-js'

import type { IconNode } from 'lucide'
import { Layers3, PanelsTopLeft, Terminal } from 'lucide'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import { activateInterfaceMode, interfaceModeIsUsable } from '../../application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { getInterfaceModeRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'

/** #515：InterfaceModePicker 的 Solid 实体（原 .tsx 为 React 薄桥）。
 *  #520 S3-P2-1：本地 LucideSvg 自绘退役，模式 glyph 经共享 LucideIcon 的 node prop
 *  直传（contribution 数据驱动的 ad-hoc 图标，不进共享登记表）。 */
export default function InterfaceModePicker() {
  const activeMode = createZustandSignal(useInterfaceModeStore, s => s.interfaceMode)
  const registry = getInterfaceModeRegistry()
  const snapshot = createZustandSignal(
    { getState: () => registry.getSnapshot(), subscribe: listener => registry.subscribe(() => listener(registry.getSnapshot())) },
    // registry 的 subscribe 回调不传快照，selector 自取（内核 subscribe 门面不回传 state）。
    () => registry.getSnapshot(),
  )
  const modes = createMemo(() => snapshot().entries)
  const iconFor = (icon?: string): { node: IconNode; name: string } =>
    icon === 'panels' ? { node: PanelsTopLeft, name: 'PanelsTopLeft' }
      : icon === 'terminal' ? { node: Terminal, name: 'Terminal' }
        : { node: Layers3, name: 'Layers3' }

  return (
    <div class="interface-mode-grid" role="radiogroup" aria-label="界面模式">
      <For each={modes()}>{entry => {
        const { id, label, description, icon } = entry.value
        const usable = interfaceModeIsUsable(entry.value)
        const glyph = iconFor(icon)
        return (
          <button type="button" role="radio" aria-checked={activeMode() === id}
            disabled={!usable}
            data-interface-mode-owner={entry.ownerPluginId}
            class={`interface-mode-card${activeMode() === id ? ' active' : ''}`}
            onClick={() => activateInterfaceMode(id)}>
            <span class="interface-mode-icon" aria-hidden="true"><LucideIcon node={glyph.node} name={glyph.name} size={20} /></span>
            <span><strong>{label}</strong><small>{usable ? description : `${description ?? ''} · 依赖的 Surface 未激活`}</small></span>
          </button>
        )
      }}</For>
    </div>
  )
}
