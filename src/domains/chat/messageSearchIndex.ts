import type { Message } from './messageTypes.ts'
import { resolveToolRenderer } from '../tool/toolPresentation.ts'

const searchTextCache = new WeakMap<Message, string>()

function stringifySearchValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

export function searchValuesMatchQuery(values: readonly unknown[], query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  return values
    .map(stringifySearchValue)
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase()
    .includes(normalizedQuery)
}

/** Original spelling for search excerpts; tool renderers contribute searchable fields here. */
export function getMessageSearchSource(message: Message): string {
  const toolText = message.role === 'tool'
    ? resolveToolRenderer(message.toolName || '').getSearchText?.(message.toolOutput) || ''
    : ''
  const semanticParts = 'semanticParts' in message
    ? stringifySearchValue((message as Message & { semanticParts?: unknown }).semanticParts)
    : ''
  return [
    // #253：不索引 message.sender——投影层的 sender 可能是内部键（local:{id}）或
    // 角色标签，进搜索文本会让「local:」全命中、内部标识泄进片段。
    message.content,
    message.toolName,
    message.toolInput,
    toolText,
    stringifySearchValue(message.toolOutput),
    semanticParts,
  ]
    .filter(Boolean)
    .join('\n')
}

export function getMessageSearchText(message: Message): string {
  const cached = searchTextCache.get(message)
  if (cached !== undefined) return cached
  const text = getMessageSearchSource(message).toLocaleLowerCase()
  searchTextCache.set(message, text)
  return text
}

export function messageMatchesQuery(message: Message, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  return getMessageSearchText(message).includes(normalizedQuery)
}
