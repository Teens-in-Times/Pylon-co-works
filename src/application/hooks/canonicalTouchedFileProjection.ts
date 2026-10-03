/**
 * canonicalTouchedFileProjection — canonical tool_call 事实 → 触碰文件管线（0-A0 / issue #282）。
 *
 * recordTouchedFile 的生产端自 ChatController 退役（P52 D4）后断线：FileSheet 的
 * touchVersion 冲突感知（probeDisk）与 ViewsPanel（agent 最近触碰文件）一直吃空数据。
 * 本模块在 plugin event bus（所有会话共享、不随 sheet 卸载的全局扇出点）上重接生产者，
 * 与 canonicalHookProjection 同型安装（main.tsx），纪律相同：**必须挂在与会话生命周期
 * 解绑的层**，不得挂进随 sheet unmount 的组件。
 *
 * 路径提取优先级（0-A0 设计）：locations[]（协议级，绝对路径）→ diff content block
 * 的 path（agent 自带 oldText/newText，写证据最强）→ rawInput 键兜底（复用
 * extractTouchedPath：kind=edit 主判定 + 旧工具名回退）。绝对路径对会话 workdir
 * （workspaceId 绑定的 rootPath 优先）求相对，求不出 → 丢弃（防 FileSheet 永远匹配
 * 不到）。重复投递无害：touchedFiles LRU 按 path 去重；touchVersion 单调递增只会
 * 触发消费端的 300ms debounce。tool.call.failed 的失败尝试同样入列（touchVersion
 * 只表达「工具宣称触碰」，不区分是否真的写盘——消费端 probeDisk 才是磁盘真值判定）。
 */
import type { CanonicalConversationEvent } from '../../domains/events/eventSchema'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'
import { EDIT_TOOL_NAMES, extractTouchedPath, relativizePath } from '../../infrastructure/acp/touchedFiles.ts'
import { subscribePluginEvents, type PluginEventDisposable } from '../../infrastructure/events/pluginEventBusHost.ts'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function typedToolOf(event: CanonicalConversationEvent): Record<string, unknown> | undefined {
  const typed = event.typedPayload as { tool?: unknown } | undefined
  return isPlainObject(typed?.tool) ? typed.tool : undefined
}

/** 会话 workdir 解析（与 fileSheetNavigation 的 workspaceRoot 同口径）。 */
function workspaceRootForSession(session: {
  workspaceId?: string
  workdir: string
}): string | undefined {
  if (session.workspaceId) {
    const workspace = useWorkspaceEntityStore.getState().workspaces.find(item => item.id === session.workspaceId)
    if (workspace?.rootPath) return workspace.rootPath
  }
  return session.workdir || undefined
}

/**
 * 从 canonical tool 事件提取被改文件的相对路径（已按 cwd 求相对、去重）。
 * 非 edit 类事件（kind 缺失时按旧工具名回退判定）且无 diff block → 空数组。
 */
export function extractTouchedPaths(event: CanonicalConversationEvent, cwd?: string): string[] {
  if (!event.eventType.startsWith('tool.call.')) return []
  const tool = typedToolOf(event)
  const kind = nonEmpty(tool?.kind) ? tool.kind : undefined
  const title = nonEmpty(tool?.title) ? tool.title : undefined
  const raw = isPlainObject(event.rawPayload) ? event.rawPayload : {}

  // ② diff content block：agent 自带 old/new，写证据最强，不做 edit 判定前置。
  const content = Array.isArray(raw.content) ? raw.content : []
  const diffPaths: string[] = []
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== 'diff') continue
    if (!nonEmpty(block.path)) continue
    const relative = relativizePath(block.path, cwd)
    if (relative) diffPaths.push(relative)
  }

  const isEdit = kind === 'edit' || (!kind && !!title && EDIT_TOOL_NAMES.includes(title))

  // ① locations[]（协议级；只在 edit 判定成立时采信，防读类工具误记）。
  const locations: string[] = []
  if (isEdit && Array.isArray(raw.locations)) {
    for (const location of raw.locations) {
      if (!isPlainObject(location) || !nonEmpty(location.path)) continue
      const relative = relativizePath(location.path, cwd)
      if (relative) locations.push(relative)
    }
  }

  // ③ rawInput 键兜底（extractTouchedPath：{path|file_path|filePath|relativePath}）。
  const fromInput = extractTouchedPath({ kind, title, rawInput: tool?.rawInput, cwd })

  // diff block 是最强证据：命中即只采信它，不混入低置信来源。
  if (diffPaths.length > 0) return [...new Set(diffPaths)]
  return [...new Set([...locations, ...(fromInput ? [fromInput] : [])])]
}

/** bus 订阅入口：edit 类 tool_call 事实 → recordTouchedFile。 */
export function projectCanonicalEventToTouchedFiles(event: CanonicalConversationEvent): void {
  if (!event.eventType.startsWith('tool.call.')) return
  const session = useIdentityStore.getState().sessions.find(candidate => (
    candidate.agentId === event.owner.agentId
    && (candidate.source === event.owner.localSessionId || candidate.id === event.owner.localSessionId)
  ))
  if (!session) return
  const cwd = workspaceRootForSession(session)
  const paths = extractTouchedPaths(event, cwd)
  if (paths.length === 0) return
  const tool = typedToolOf(event)
  const toolKind = nonEmpty(tool?.kind) ? tool.kind : 'edit'
  const at = Date.now()
  const store = useWorkspaceStore.getState()
  for (const path of paths) {
    store.recordTouchedFile({ agentId: session.agentId, source: session.source }, { path, toolKind, at })
  }
}

let installation: PluginEventDisposable | undefined

/** 幂等安装；返回解订函数。 */
export function installCanonicalTouchedFileProjection(): () => void {
  installation ??= subscribePluginEvents(projectCanonicalEventToTouchedFiles)
  return installation
}

/** 显式卸载（与 install 返回的解订函数同一语义）；幂等安装单例允许重装。测试隔离复用本入口。 */
export function uninstallCanonicalTouchedFileProjection(): void {
  installation?.()
  installation = undefined
}
