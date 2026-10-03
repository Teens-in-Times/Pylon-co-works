/**
 * C03：media source 解析契约（纯 domain，Solid surface 与第三方 react 兼容 kind 共用）。
 *
 * 卡面规则：
 * - URL 经协议白名单（https/http + media-mime data:/blob:）；javascript: 等一律拒绝；
 * - 本地文件必须经注入的 host asset adapter（Tauri convertFileSrc），渲染层不做字符串猜测互转；
 * - inline base64 在限额内解析为 data: URL，超限/非法拒绝；
 * - 解析结果只含可安全交给 <img>/<audio>/<video> src 的字符串，secret header 永不进入。
 */

import { MAX_INLINE_MEDIA_SOURCE_BYTES } from '../workbench/content/mediaContentValidation.ts'

/** Backward-compatible renderer export; canonical ownership lives in the content seam. */
export const MAX_INLINE_BASE64_BYTES = MAX_INLINE_MEDIA_SOURCE_BYTES

const REMOTE_URL_SCHEMES = /^https?:\/\//i
const DATA_URL = /^data:([^;,]+);base64,(.*)$/i
const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/

export interface MediaSourceInput {
  /** 远程 URL（https/http 才放行）。 */
  url?: string
  /** 受控本地路径——只能经 host asset adapter 转换。 */
  localPath?: string
  /** 内联 base64（不含 data: 前缀），配合 mime 使用。 */
  base64?: string
  mime?: string
}

export interface MediaSourceResolverOptions {
  /**
   * host asset adapter（生产环境为 Tauri convertFileSrc）。
   * 缺省时本地路径解析失败关闭（fail closed）。
   */
  convertLocalPath?: (path: string) => string
}

export type MediaSourceResult =
  | { readonly ok: true; readonly source: string; readonly sourceKind: 'url' | 'local-path' | 'base64' | 'blob' }
  | { readonly ok: false; readonly reason: string }

/** URL 协议白名单判定（供组件层对任意来源字符串做快速复核）。 */
export function isAllowedMediaUrl(value: string): boolean {
  const trimmed = value.trim()
  if (REMOTE_URL_SCHEMES.test(trimmed)) return true
  if (/^data:/i.test(trimmed)) {
    const match = DATA_URL.exec(trimmed)
    const mime = match?.[1]?.toLowerCase() ?? ''
    const payload = match?.[2] ?? ''
    return /^(?:image|audio|video)\//.test(mime)
      && payload.length <= MAX_INLINE_BASE64_BYTES
      && isLikelyBase64(payload)
  }
  if (/^blob:/i.test(trimmed)) return true
  return false
}

export function isAllowedMediaPosterUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!isAllowedMediaUrl(trimmed)) return false
  return !/^data:/i.test(trimmed) || /^data:image\//i.test(trimmed)
}

function isLikelyBase64(value: string): boolean {
  return value.length > 0 && BASE64_ALPHABET.test(value) && value.length % 4 === 0
}

export function resolveMediaSource(
  input: MediaSourceInput,
  options: MediaSourceResolverOptions = {},
): MediaSourceResult {
  // 优先级：显式 url > localPath > base64。同一 part 只应携带一种来源；
  // 多来源并存时按此顺序取第一个可用项，其余忽略。
  const url = input.url?.trim()
  if (url) {
    if (!isAllowedMediaUrl(url)) {
      return { ok: false, reason: `协议不在白名单：${url.slice(0, 32)}` }
    }
    return {
      ok: true,
      source: url,
      sourceKind: /^blob:/i.test(url) ? 'blob' : /^data:/i.test(url) ? 'base64' : 'url',
    }
  }

  const localPath = input.localPath?.trim()
  if (localPath) {
    const convert = options.convertLocalPath
    if (!convert) {
      return { ok: false, reason: '本地路径需要 host asset adapter（未接入）' }
    }
    try {
      return { ok: true, source: convert(localPath), sourceKind: 'local-path' }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  const base64 = input.base64
  if (base64 !== undefined) {
    if (byteLength(base64) > MAX_INLINE_BASE64_BYTES) {
      return { ok: false, reason: `内联数据超过限额（${Math.round(MAX_INLINE_BASE64_BYTES / 1024 / 1024)} MiB）` }
    }
    if (!isLikelyBase64(base64)) {
      return { ok: false, reason: '非法 base64 载荷' }
    }
    const mime = input.mime?.trim() || sniffMimeFromBase64(base64)
    if (!mime || !/^(?:image|audio|video)\//i.test(mime)) {
      return { ok: false, reason: `不支持的媒体 mime：${mime || '未知'}` }
    }
    return { ok: true, source: `data:${mime};base64,${base64}`, sourceKind: 'base64' }
  }

  return { ok: false, reason: '无可用的媒体来源字段' }
}

function byteLength(value: string): number {
  // base64 是 ASCII 子集，length 即字节数；避免对超大串做 TextEncoder 分配
  return value.length
}

/** 极简 magic-number 嗅探——仅在 wire 未声明 mime 时兜底；识别不出则拒绝。 */
function sniffMimeFromBase64(base64: string): string | undefined {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  if (base64.startsWith('UklGR')) return 'audio/wav'
  if (base64.startsWith('AAAA') || base64.startsWith('AAAAG')) return 'video/mp4'
  return undefined
}
