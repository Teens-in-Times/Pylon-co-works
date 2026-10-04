/**
 * Typed registry for DOM-level `pylon:*` CustomEvents.
 *
 * Tauri events (for example `pylon:agent-status`) use the ACP event bus and
 * are intentionally not part of this registry.  This map covers the
 * window/document bridge used by Solid and the legacy chat adapter.
 */

export interface PylonCustomEventDetailMap {
  'pylon:agent-switched': undefined
  'pylon:browser-status': unknown
  'pylon:interaction-rejected': unknown
  'pylon:load-finished': { source: string; generation?: number }
  'pylon:model-error': string
  'pylon:mode-error': string
  'pylon:new-session': { workspaceId?: string } | undefined
  'pylon:open-runtime-sheet': undefined
  'pylon:open-settings': {
    domain?: string
    section?: string
    agentId?: string
    pluginPageId?: string
  } | undefined
  'pylon:pick-workspace-folder': undefined
  'pylon:runtime-error': unknown
  'pylon:solid-input-send': undefined
  'pylon:tasks-toggle': undefined
  'pylon:workspace-folder-picked': { path: string }
}

export type PylonCustomEventName = keyof PylonCustomEventDetailMap
export type PylonCustomEventDetail<Name extends PylonCustomEventName> = PylonCustomEventDetailMap[Name]

/** Stable inventory consumed by the boundary checker and tests. */
export const PYLON_CUSTOM_EVENT_NAMES: readonly PylonCustomEventName[] = [
  'pylon:agent-switched',
  'pylon:browser-status',
  'pylon:interaction-rejected',
  'pylon:load-finished',
  'pylon:model-error',
  'pylon:mode-error',
  'pylon:new-session',
  'pylon:open-runtime-sheet',
  'pylon:open-settings',
  'pylon:pick-workspace-folder',
  'pylon:runtime-error',
  'pylon:solid-input-send',
  'pylon:tasks-toggle',
  'pylon:workspace-folder-picked',
]

const PYLON_CUSTOM_EVENT_NAME_SET = new Set<string>(PYLON_CUSTOM_EVENT_NAMES)

export function isPylonCustomEventName(value: string): value is PylonCustomEventName {
  return PYLON_CUSTOM_EVENT_NAME_SET.has(value)
}

export function createPylonCustomEvent<Name extends PylonCustomEventName>(
  name: Name,
): CustomEvent<PylonCustomEventDetail<Name>>
export function createPylonCustomEvent<Name extends PylonCustomEventName>(
  name: Name,
  detail: PylonCustomEventDetail<Name>,
): CustomEvent<PylonCustomEventDetail<Name>>
export function createPylonCustomEvent<Name extends PylonCustomEventName>(
  name: Name,
  detail?: PylonCustomEventDetail<Name>,
): CustomEvent<PylonCustomEventDetail<Name>> {
  return detail === undefined
    ? new CustomEvent(name)
    : new CustomEvent(name, { detail })
}

export function dispatchPylonEvent<Name extends PylonCustomEventName>(
  target: EventTarget,
  name: Name,
): boolean
export function dispatchPylonEvent<Name extends PylonCustomEventName>(
  target: EventTarget,
  name: Name,
  detail: PylonCustomEventDetail<Name>,
): boolean
export function dispatchPylonEvent<Name extends PylonCustomEventName>(
  target: EventTarget,
  name: Name,
  detail?: PylonCustomEventDetail<Name>,
): boolean {
  return target.dispatchEvent(createPylonCustomEvent(name, detail as PylonCustomEventDetail<Name>))
}

/** Register a typed listener and return an idempotent disposer. */
export function onPylonEvent<Name extends PylonCustomEventName>(
  target: EventTarget,
  name: Name,
  listener: (event: CustomEvent<PylonCustomEventDetail<Name>>) => void,
): () => void {
  const wrapped: EventListener = event => listener(event as CustomEvent<PylonCustomEventDetail<Name>>)
  target.addEventListener(name, wrapped)
  let active = true
  return () => {
    if (!active) return
    active = false
    target.removeEventListener(name, wrapped)
  }
}
