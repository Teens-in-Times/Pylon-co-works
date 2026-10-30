import type { FirstPartyStyleAsset } from '../../firstPartyStyleRuntime.ts'

const styleModules = typeof document === 'undefined'
  ? {}
  : import.meta.glob<string>([
  './styles/components/chat/ChatView.css',
  './styles/components/chat/ChatView.modern.css',
  './styles/components/chat/InputBar.css',
  './styles/components/chat/StatusBar.css',
  './styles/components/ControlCenter.css',
  './styles/components/solid-workbench/WorkbenchChrome.css',
  './styles/adaptive.css',
], { query: '?inline', import: 'default', eager: true })

export function loadBuiltinPylonRendererStyles(): readonly FirstPartyStyleAsset[] {
  return Object.freeze(Object.entries(styleModules).map(([path, css]) => ({ path, css })))
}
