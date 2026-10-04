import type { Session } from '../../domains/identity/identityStore.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'

export const FILE_NAVIGATION_METADATA_KEY = 'pendingFileNavigation'

export interface FileNavigationTarget {
  path: string
  line?: number
}

interface PendingFileNavigation extends FileNavigationTarget {
  version: 1
  requestId: string
  sessionId: string
}

let navigationSequence = 0

function normalizedSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function isWindowsAbsolute(value: string): boolean {
  return /^[a-z]:\//i.test(value)
}

function isAbsolute(value: string): boolean {
  return value.startsWith('/') || isWindowsAbsolute(value)
}

function withoutLinkLocation(value: string): { path: string; line?: number } {
  const hash = /#L(\d+)(?:C\d+)?$/i.exec(value)
  if (hash?.index !== undefined) return { path: value.slice(0, hash.index), line: Number(hash[1]) }
  const suffix = /:(\d+)(?::\d+)?$/.exec(value)
  // Do not treat the drive-letter colon in C:/... as a line separator.
  if (suffix?.index !== undefined && suffix.index > 1) return { path: value.slice(0, suffix.index), line: Number(suffix[1]) }
  return { path: value }
}

function fileUriPath(value: string): string | null {
  if (!/^file:/i.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    const decoded = decodeURIComponent(url.pathname)
    return /^\/[a-z]:\//i.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return null
  }
}

function resourcePath(resource: unknown): { path: string; line?: number } | null {
  if (typeof resource === 'string') return withoutLinkLocation(resource.trim())
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return null
  const input = resource as {
    path?: unknown
    uri?: unknown
    line?: unknown
    selection?: { start?: { line?: unknown } }
    range?: { start?: { line?: unknown } }
  }
  const raw = typeof input.path === 'string' ? input.path : typeof input.uri === 'string' ? input.uri : ''
  if (!raw.trim()) return null
  const located = withoutLinkLocation(raw.trim())
  const explicitLine = input.selection?.start?.line ?? input.range?.start?.line ?? input.line
  return {
    path: located.path,
    ...(Number.isInteger(explicitLine) && Number(explicitLine) >= 0
      ? { line: Math.max(1, Number(explicitLine)) }
      : located.line ? { line: located.line } : {}),
  }
}

function relativeToRoot(path: string, root: string | undefined): string | null {
  let candidate = normalizedSlashes(path.trim())
  if (!candidate) return null
  const uriPath = fileUriPath(candidate)
  if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && uriPath === null && !isWindowsAbsolute(candidate)) return null
  if (uriPath !== null) candidate = normalizedSlashes(uriPath)
  else {
    const queryIndex = candidate.indexOf('?')
    if (queryIndex >= 0) candidate = candidate.slice(0, queryIndex)
    try { candidate = decodeURIComponent(candidate) } catch { return null }
  }

  if (!isAbsolute(candidate)) {
    const parts = candidate.replace(/^\.\//, '').split('/').filter(part => part && part !== '.')
    if (parts.length === 0 || parts.some(part => part === '..')) return null
    return parts.join('/')
  }
  if (!root) return null

  const normalizedRoot = normalizedSlashes(root.trim()).replace(/\/$/, '')
  const windows = isWindowsAbsolute(candidate) || isWindowsAbsolute(normalizedRoot)
  const comparablePath = windows ? candidate.toLowerCase() : candidate
  const comparableRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot
  if (comparablePath === comparableRoot || !comparablePath.startsWith(`${comparableRoot}/`)) return null
  return candidate.slice(normalizedRoot.length + 1)
}

function workspaceRoot(session: Session): string | undefined {
  if (session.workspaceId) {
    const workspace = useWorkspaceEntityStore.getState().workspaces.find(item => item.id === session.workspaceId)
    if (workspace?.rootPath) return workspace.rootPath
  }
  return session.workdir || undefined
}

export function resolveFileNavigationTarget(resource: unknown, root?: string): FileNavigationTarget | null {
  const extracted = resourcePath(resource)
  if (!extracted) return null
  const path = relativeToRoot(extracted.path, root)
  if (!path) return null
  return { path, ...(extracted.line ? { line: extracted.line } : {}) }
}

export function parsePendingFileNavigation(raw: string | undefined): PendingFileNavigation | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<PendingFileNavigation>
    if (value.version !== 1 || typeof value.requestId !== 'string' || !value.requestId
      || typeof value.sessionId !== 'string' || !value.sessionId || typeof value.path !== 'string' || !value.path) return null
    return {
      version: 1,
      requestId: value.requestId,
      sessionId: value.sessionId,
      path: value.path,
      ...(Number.isInteger(value.line) && (value.line ?? 0) > 0 ? { line: value.line } : {}),
    }
  } catch {
    return null
  }
}

/** Queue a navigation intent for the target FileSheet. The FileSheet remains the
 * sole owner of dirty/saving guards and decides when the intent can be applied. */
export function openResourceInFileSheet(sessionId: string, resource: unknown): boolean {
  const session = useIdentityStore.getState().sessions.find(item => item.id === sessionId)
  if (!session) return false
  const target = resolveFileNavigationTarget(resource, workspaceRoot(session))
  if (!target) return false

  const store = useWorkspaceStore.getState()
  const singletonKey = `file:session:${session.id}`
  const existing = store.workspaceSheets.sheets.find(sheet => sheet.kind === 'file' && sheet.singletonKey === singletonKey)
  const sheetId = store.openSheet({
    kind: 'file',
    title: `Files · ${session.name}`,
    singletonKey,
    metadata: { targetSessionId: session.id },
  })
  if (!sheetId) return false
  navigationSequence += 1
  const pending: PendingFileNavigation = {
    version: 1,
    requestId: `${Date.now().toString(36)}-${navigationSequence.toString(36)}`,
    sessionId: session.id,
    ...target,
  }
  useWorkspaceStore.getState().patchSheetMetadata(sheetId, {
    // A reused FileSheet may have been manually retargeted. Let its mounted host
    // switch ownership through dirty/saving guards instead of rebinding old tabs
    // to this Session from outside.
    ...(existing ? {} : { targetSessionId: session.id }),
    [FILE_NAVIGATION_METADATA_KEY]: JSON.stringify(pending),
  })
  return true
}

export function openFileLinkFromEvent(event: { target: EventTarget | null; preventDefault(): void }, sessionId: string | null): boolean {
  if (!sessionId || !(event.target instanceof Element)) return false
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
  const href = anchor?.getAttribute('href')
  if (!href || !openResourceInFileSheet(sessionId, { uri: href })) return false
  event.preventDefault()
  return true
}
