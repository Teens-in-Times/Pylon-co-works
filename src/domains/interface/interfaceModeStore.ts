import { attachSolidPersist, createSolidStoreKernel, resolveLocalStorage, type SolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'

export type InterfaceMode = string

export const DEFAULT_INTERFACE_MODE: InterfaceMode = 'modern-gui'

interface InterfaceModeState {
  interfaceMode: InterfaceMode
  setInterfaceMode(mode: InterfaceMode): void
}

function validMode(value: unknown): value is InterfaceMode {
  return typeof value === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)
}

// #515 批0：zustand → Solid 内核置换；W3 起 useInterfaceModeStore 即内核本体（直连，无 shim）。
// ★ #607 刀3b：`profileByMode` 记忆链退役（档案私路）——本 store 只剩界面模式一项。
const kernel = createSolidStoreKernel<InterfaceModeState>({
  interfaceMode: DEFAULT_INTERFACE_MODE,
  setInterfaceMode: mode => kernel.setState({ interfaceMode: validMode(mode) ? mode : DEFAULT_INTERFACE_MODE }),
})

// 版本 2 → 3：磁盘上的 `profileByMode` 不再读入、写回也不再带（读旧数据不报错）。
attachSolidPersist(kernel, {
  name: 'pylon-interface-mode',
  version: 3,
  storage: resolveLocalStorage(),
  migrate: persisted => {
    const state = persisted as Partial<InterfaceModeState>
    return { interfaceMode: validMode(state.interfaceMode) ? state.interfaceMode : DEFAULT_INTERFACE_MODE }
  },
  partialize: state => ({ interfaceMode: state.interfaceMode }),
})

export const useInterfaceModeStore: SolidStoreKernel<InterfaceModeState> = kernel
