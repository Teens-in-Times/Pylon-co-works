import type { WorkbenchAttachment } from '../../domains/workbench/workbenchCommandFacade.ts'

/**
 * 附件选择端口。ACP 的 `attachments` 是本地路径数组，所以这里只产出路径与展示元数据；
 * 真正的读取发生在 Agent 侧。浏览器预览没有原生对话框，调用方拿到空数组即可。
 */

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip',
}

const EXTENSION = /\.([a-z0-9]+)$/i

/** 扩展名 → MIME；未知扩展名返回 undefined（不猜类型）。 */
export function mediaTypeForPath(path: string): string | undefined {
  const match = EXTENSION.exec(path.trim())
  return match ? MEDIA_TYPES[match[1]!.toLowerCase()] : undefined
}

/** 路径 → 展示名（Windows 与 POSIX 分隔符都切）。 */
export function attachmentNameForPath(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name || path
}

export function attachmentFromPath(path: string): WorkbenchAttachment {
  const trimmed = path.trim()
  const attachment: WorkbenchAttachment = { id: trimmed, path: trimmed, name: attachmentNameForPath(trimmed) }
  const mediaType = mediaTypeForPath(trimmed)
  return mediaType ? { ...attachment, mediaType } : attachment
}

/** 归一化一批路径：去空白、按 id 去重（保留首次出现顺序）。 */
export function attachmentsFromPaths(paths: readonly string[]): WorkbenchAttachment[] {
  const seen = new Set<string>()
  const out: WorkbenchAttachment[] = []
  for (const path of paths) {
    if (!path.trim() || seen.has(path.trim())) continue
    seen.add(path.trim())
    out.push(attachmentFromPath(path))
  }
  return out
}

export interface AttachmentDropPoint {
  readonly x: number
  readonly y: number
}

/**
 * 订阅窗口级文件拖放。落点判定留给调用方（它才知道哪个矩形算输入区），
 * 这里只负责把 Tauri 的物理像素坐标原样交出去。
 * 返回退订函数；Tauri 端口不可用（浏览器预览/单测）时是空操作。
 */
export function subscribeAttachmentDrop(
  handler: (paths: readonly string[], point: AttachmentDropPoint) => void,
): () => void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return () => {}
  let disposed = false
  let unlisten: (() => void) | undefined
  void (async () => {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      const off = await getCurrentWebview().onDragDropEvent(event => {
        const payload = event.payload as {
          type: string
          paths?: readonly string[]
          position?: AttachmentDropPoint
        }
        if (payload.type !== 'drop' || !payload.paths?.length) return
        handler(payload.paths, payload.position ?? { x: 0, y: 0 })
      })
      if (disposed) off()
      else unlisten = off
    } catch {
      // 拖放端口不可用：附件仍可通过按钮选择
    }
  })()
  return () => {
    disposed = true
    unlisten?.()
  }
}

/**
 * 打开系统文件对话框。Tauri 不可用（浏览器预览/单测）或用户取消时返回空数组。
 * 失败不抛：附件是增强能力，不能阻断输入。
 */
export async function pickAttachments(): Promise<readonly WorkbenchAttachment[]> {
  if (typeof window === 'undefined') return []
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selection = await open({ multiple: true, directory: false, title: '添加附件' })
    if (!selection) return []
    return attachmentsFromPaths(Array.isArray(selection) ? selection : [selection])
  } catch {
    return []
  }
}
