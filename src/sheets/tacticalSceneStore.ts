import { attachSolidPersist, createSolidStoreKernel, resolveLocalStorage, type SolidStoreKernel } from '../infrastructure/state/solidStoreKernel'

type TacticalArtwork = 'closer' | 'falling'
interface TacticalSceneState {
  artwork: TacticalArtwork
  opacity: number
  motion: boolean
  setArtwork(artwork: TacticalArtwork): void
  setOpacity(opacity: number): void
  setMotion(motion: boolean): void
}

/** Preferences belong only to this optional interface; never write global theme settings. */
// #515 批0：zustand → Solid 内核置换；W3 起 useTacticalSceneStore 即内核本体（直连，无 shim）。
const kernel = createSolidStoreKernel<TacticalSceneState>({
  artwork: 'closer', opacity: 0.42, motion: true,
  setArtwork: artwork => kernel.setState({ artwork }),
  setOpacity: opacity => kernel.setState({ opacity: Number.isFinite(opacity) ? Math.min(0.7, Math.max(0.15, opacity)) : 0.42 }),
  setMotion: motion => kernel.setState({ motion }),
})

attachSolidPersist(kernel, {
  name: 'pylon-tactical-scene-v1',
  version: 1,
  storage: resolveLocalStorage(),
  // #520 S2：与其余 persist 面对齐——信封带版本；migrate 恒等占位（旧值合法性由
  // merge 统一兜底），后续 schema 变更在此落地版本迁移，避免版本错位整包丢弃。
  migrate: (persisted: unknown) => persisted as Partial<TacticalSceneState>,
  partialize: ({ artwork, opacity, motion }) => ({ artwork, opacity, motion }),
  merge: (saved, current) => {
    const value = saved as Partial<TacticalSceneState> | null
    return { ...current,
      artwork: (value?.artwork === 'falling' ? 'falling' : 'closer') as TacticalArtwork,
      opacity: typeof value?.opacity === 'number' && Number.isFinite(value.opacity) ? Math.min(0.7, Math.max(0.15, value.opacity)) : 0.42,
      motion: typeof value?.motion === 'boolean' ? value.motion : true,
    }
  },
})

export const useTacticalSceneStore: SolidStoreKernel<TacticalSceneState> = kernel
