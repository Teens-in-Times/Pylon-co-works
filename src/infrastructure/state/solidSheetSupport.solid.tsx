/** @jsxImportSource solid-js */
import { createMemo, createSignal, onCleanup } from 'solid-js'
import { createZustandSignal } from './solidStoreBridge.ts'
import { DEFAULT_INTERFACE_MODE, useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { getInterfaceModeRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { findInterfaceModeContribution } from '../../app/interfaceModeLookup.ts'
import type { InterfaceModeContribution } from '../../plugin-runtime/interface-mode/interfaceModeTypes.ts'

/**
 * #515 sheet 视图 Solid 化的共享支撑件（仅 Solid 实体消费；React 类型图不触碰本文件）。
 *
 * - createRegistrySignal：useSyncExternalStore 语义的外部 store → Solid 信号；
 * - createActiveInterfaceModeContribution：useActiveInterfaceModeContribution 的 Solid
 *   等价（registry 真值 + 内置表回退，回退序与 React hook 逐项一致）。
 *
 * （#520 W4：ReactIslandHost / mountReactIsland / ReactIslandHandle React 岛原语已随
 * React 面清零退役，本文件不再依赖 react / react-dom。）
 */

/**
 * 外部 store（subscribe/getSnapshot 快照语义）→ Solid 信号（快照引用等值）。
 *
 * ⚠️ #536：getSnapshot 必须返回**跨写入变更的值**（如内核 `getVersion()` 的通知计数）。
 * 对 solidStoreKernel 系 store 传 `getState()` 会因引用恒定（就地改写同一裸对象）而
 * 按引用判等失败，信号冻结在首帧、下游 memo 永不重算。
 */
export function createRegistrySignal<T>(
  store: { subscribe(listener: () => void): () => void },
  getSnapshot: () => T,
): () => T {
  const [value, setValue] = createSignal<T>(getSnapshot())
  // updater 形态：T 可能是任意值（含函数），走 (prev) => next 重载避开 Solid setter
  // 对「函数值」的排除分支。
  onCleanup(store.subscribe(() => setValue(() => getSnapshot())))
  return value
}

/** useActiveInterfaceModeContribution 的 Solid 等价（语义与 React hook 同源，A-V9）。 */
export function createActiveInterfaceModeContribution(): () => InterfaceModeContribution {
  const interfaceMode = createZustandSignal(useInterfaceModeStore, state => state.interfaceMode)
  const registry = getInterfaceModeRegistry()
  const snapshot = createRegistrySignal(registry, () => registry.getSnapshot())
  return createMemo(() =>
    snapshot().entries.find(entry => entry.value.id === interfaceMode())?.value
    ?? findInterfaceModeContribution(interfaceMode())
    ?? findInterfaceModeContribution(DEFAULT_INTERFACE_MODE)!)
}
