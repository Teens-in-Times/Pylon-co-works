import type { RenderAppearanceSnapshot } from '../../../contracts/messageRenderer.ts'
import type { RendererActivationSnapshot } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'

type ResolveAppearance = (request: { kind: string; suiteId: string; slotId: string }) => RenderAppearanceSnapshot

/** Size the shared column from configured renderers, independent of which
 * messages happen to exist. Each surface still applies its own width cap. */
export function readingColumnMaxWidth(
  activation: RendererActivationSnapshot | undefined,
  resolve?: ResolveAppearance,
): number {
  if (!activation) return 960
  let width = 0
  for (const [kind, entry] of activation.kinds) {
    const slot = activation.slots.get(kind)?.find(candidate => candidate.value.kinds.includes(kind))
    if (!slot) continue
    const resolved = resolve?.({ kind, suiteId: activation.suite.value.id, slotId: slot.value.id })
    const tokens = entry.value.defaultTokens
    const defaultWidth = tokens && typeof tokens === 'object' && 'maxWidth' in tokens ? tokens.maxWidth : undefined
    const maxWidth = resolved?.maxWidth ?? defaultWidth
    if (typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0) width = Math.max(width, maxWidth)
  }
  // Fallback mounts have no catalog; match the built-in card width.
  return width || 960
}
