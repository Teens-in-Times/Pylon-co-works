/** Read-only resource projection from canonical display parts. No raw payload, IO or store access. */
import { parseContentPart, type ContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import type { WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'

export interface WorkspaceResource {
  id: string
  title: string
  kind: 'artifact' | 'document' | 'resource' | 'image' | 'audio' | 'video'
  location?: string
  summary?: string
  part: ContentPart
  sequence: number
}

function resourceFromPart(part: ContentPart, sequence: number): WorkspaceResource | null {
  switch (part.kind) {
    case 'artifact':
      return { id: `artifact:${part.artifactId}`, title: part.title, kind: part.kind, location: part.uri, summary: part.summary, part, sequence }
    case 'document':
    case 'resource': {
      const location = part.kind === 'document' ? part.path ?? part.uri : part.uri
      const title = part.title || location?.replace(/\\/g, '/').split('/').at(-1) || '文档'
      return { id: `${part.kind}:${location ?? title}`, title, kind: part.kind, location, part, sequence }
    }
    case 'image':
    case 'audio':
    case 'video':
      return { id: `${part.kind}:${part.source}`, title: part.caption || part.alt || ({ image: '图片', audio: '音频', video: '视频' }[part.kind]), kind: part.kind, part, sequence }
    default:
      return null
  }
}

export function collectWorkspaceResources(document: WorkbenchDocument | undefined): readonly WorkspaceResource[] {
  if (!document) return []
  const resources = new Map<string, WorkspaceResource>()
  const collect = (parts: unknown, sequence: number) => {
    if (!Array.isArray(parts)) return
    for (const value of parts) {
      if (!value || typeof value !== 'object' || !['artifact', 'document', 'resource', 'image', 'audio', 'video'].includes(value.kind)) continue
      const parsed = parseContentPart(value)
      if (!parsed.ok) continue
      const resource = resourceFromPart(parsed.value, sequence)
      if (resource && (!resources.has(resource.id) || resources.get(resource.id)!.sequence <= sequence)) resources.set(resource.id, resource)
    }
  }
  for (const message of document.messages) {
    if (message.role === 'assistant') collect(message.parts, message.sequence)
  }
  for (const activity of document.activities) {
    collect(activity.parts, activity.sequence)
    collect(activity.output, activity.sequence)
  }
  return [...resources.values()].sort((left, right) => right.sequence - left.sequence)
}

export function resourcePreviewText(part: ContentPart, depth = 0): string {
  if (depth > 4) return ''
  if (part.kind === 'artifact') return (part.parts ?? []).map(child => resourcePreviewText(child, depth + 1)).filter(Boolean).join('\n\n')
  if ('text' in part && typeof part.text === 'string') return part.text
  return ''
}

export function resourcePreviewMedia(part: ContentPart, depth = 0): readonly ContentPart[] {
  if (depth > 4) return []
  if (part.kind === 'artifact') return (part.parts ?? []).flatMap(child => resourcePreviewMedia(child, depth + 1))
  return part.kind === 'image' || part.kind === 'audio' || part.kind === 'video' ? [part] : []
}

export function resourceWebUrl(resource: WorkspaceResource): string | null {
  if (!resource.location) return null
  try {
    const url = new URL(resource.location)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch { return null }
}
