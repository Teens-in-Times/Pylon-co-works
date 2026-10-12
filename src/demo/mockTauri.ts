/**
 * mockTauri — 浏览器模式 Tauri transport 适配器。
 *
 * 机制：@tauri-apps/api 的 invoke/transformCallback/listen 全部经
 * window.__TAURI_INTERNALS__（invoke）/__TAURI_EVENT_PLUGIN_INTERNALS__（unlisten）。
 * 浏览器无真实后端 → 安装假 globals → 现有全部 invoke 调用点零改动拿到 mock 数据。
 *
 * 浏览器相关命令使用内存态标签模型，并让 Browser Sheet 以真实 iframe 加载页面；
 * 这不是桌面 WebView 的替身，UI 会明确标记 preview；开发代理可在同源
 * iframe 中转发有限的页面观察/交互，无法代理的页面仍会返回 preview_only。
 *
 * 安装时序（关键）：env.ts 的 IS_TAURI 是模块级 const（探测 __TAURI_INTERNALS__ 存在性），
 * 首次求值即冻结——必须在 main.tsx body（静态 import 全部求值后）安装，绝不能在 env.ts
 * 之前求值的模块 module-scope 安装。
 */
import {
  buildDemoAgents, buildGatewayStatus, buildGitDiff, buildGitHistory, buildGitStatus, buildGitStatusWithBranch,
  buildPlatformSessions, buildRuntimeLogs, buildSessionResponse, buildSessionSummaries, buildStartupDiagnostics,
  buildWorkspaceFileText, buildWorkspaceSearchResults, resolveWorkspaceEntries,
} from './demoData.ts'
import { buildVisualQaPluginPackages, buildVisualQaWorkspaces } from './visualQaData.ts'
import type { InstalledPluginPackage } from '../infrastructure/plugins/pluginPackageClient.ts'
import type { Workspace } from '../domains/workspace/workspaceEntities.ts'

// 浏览器 mock 有状态网关 routes：gateway 保存后 read-back 一致（浏览器可验 FE-AUD-004 安全写回）
let mockGatewayRoutes = buildGatewayStatus().routes
// CWD-03：Workspace 实体 mock（浏览器演示：内存态 create/list/update/delete）
let mockWorkspaces: Workspace[] = buildVisualQaWorkspaces()
let mockWorkspaceSeq = mockWorkspaces.length + 1
let mockPluginPackages: InstalledPluginPackage[] = buildVisualQaPluginPackages()
let mockGitEntries = buildGitStatus()
let mockGitBranch = 'demo'
let mockGitHistory = buildGitHistory()
let mockAgentConfigRevision = 1
// Browser preview keeps the same active-agent/status seam as the native
// runtime so switching an Agent does not manufacture a diagnostic just because
// the mock transport lacks the cold-start status snapshot.
let mockActiveAgentId = 'peri'

const MOCK_AGENT_STATUSES: Record<string, Record<string, unknown>> = {
  peri: {
    agentId: 'peri', agent: 'peri', status: 'connected', transport: 'acp',
    cwd: '/path/to/project', generation: 12,
    capabilities: { loadSession: true, promptCapabilities: { image: true, audio: true } },
  },
  hermes: {
    agentId: 'hermes', agent: 'hermes', status: 'error', transport: 'acp',
    cwd: '/path/to/ops', generation: 4, error: '健康检查失败：HTTP 503',
  },
  claude: {
    agentId: 'claude', agent: 'claude', status: 'reconnecting', transport: 'acp',
    cwd: '/path/to/agent-runtime', generation: 8, error: '连接已重置，正在重新协商能力',
  },
  pi: {
    agentId: 'pi', agent: 'pi', status: 'connecting', transport: 'acp',
    cwd: '/path/to/agent-runtime', generation: 2,
  },
  gm: {
    agentId: 'gm', agent: 'gm', status: 'disconnected', transport: 'web',
    cwd: '/path/to/worldbook', generation: 6, error: '远端暂未上线',
  },
}

function mockAgentStatus(): Record<string, unknown> {
  return { ...(MOCK_AGENT_STATUSES[mockActiveAgentId] ?? MOCK_AGENT_STATUSES.peri) }
}

interface MockBrowserTab {
  id: number
  url: string
  title: string | null
  history: string[]
  historyIndex: number
}

interface MockBrowserSnapshot {
  instanceId: number
  phase: 'idle' | 'starting' | 'ready' | 'error'
  url: string | null
  title: string | null
  error: string | null
  zoomPercent: number
  activeTabId: number | null
  tabs: Array<{ id: number; url: string; title: string | null }>
  visible: boolean
  runtime: 'iframe-preview'
}

let mockBrowserTabs: MockBrowserTab[] = []
let mockBrowserActiveTabId: number | null = null
let mockBrowserNextTabId = 0
let mockBrowserZoomPercent = 90
let mockBrowserVisible = true

function browserUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('url 必须是非空字符串')
  const value = raw.trim()
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`URL 非法：${value}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && value !== 'about:blank') {
    throw new Error('仅允许 http/https（about:blank 仅用于新标签）')
  }
  return value
}

function browserTitle(url: string): string | null {
  if (url === 'about:blank') return null
  try {
    const host = new URL(url).hostname
    if (host === 'example.com') return 'Example Domain'
    if (host === 'developer.mozilla.org') return 'MDN Web Docs'
    if (host === 'tauri.app') return 'Tauri'
    return host
  } catch { return null }
}

function mockBrowserSnapshot(): MockBrowserSnapshot {
  const active = mockBrowserActiveTabId === null
    ? undefined
    : mockBrowserTabs.find(tab => tab.id === mockBrowserActiveTabId)
  return {
    instanceId: active?.id ?? 0,
    phase: active ? 'ready' : 'idle',
    url: active?.url ?? null,
    title: active?.title ?? null,
    error: null,
    zoomPercent: mockBrowserZoomPercent,
    activeTabId: active?.id ?? null,
    tabs: mockBrowserTabs.map(tab => ({ id: tab.id, url: tab.url, title: tab.title })),
    visible: mockBrowserVisible,
    runtime: 'iframe-preview',
  }
}

/**
 * 浏览器预览没有 Tauri event plugin；把同一份状态投影成 DOM 事件，
 * 让 Browser Sheet 与 Agent 命令共享一条可观察的状态流。Node/测试环境
 * 没有 window 时保持纯内存命令语义，不产生副作用。
 */
function emitMockBrowserStatus(): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return
  window.dispatchEvent(new CustomEvent('pylon:browser-status', { detail: mockBrowserSnapshot() }))
}

function createMockBrowserTab(rawUrl = 'about:blank'): MockBrowserTab {
  const url = browserUrl(rawUrl)
  const tab: MockBrowserTab = {
    id: ++mockBrowserNextTabId,
    url,
    title: browserTitle(url),
    history: [url],
    historyIndex: 0,
  }
  mockBrowserTabs = [...mockBrowserTabs, tab]
  mockBrowserActiveTabId = tab.id
  return tab
}

function activeMockBrowserTab(): MockBrowserTab {
  const tab = mockBrowserTabs.find(value => value.id === mockBrowserActiveTabId)
  if (!tab) throw new Error('浏览器未启动')
  return tab
}

function mockBrowserStart(): MockBrowserSnapshot {
  if (mockBrowserTabs.length === 0) createMockBrowserTab('https://example.com')
  return mockBrowserSnapshot()
}

function mockBrowserNavigate(rawUrl: unknown): MockBrowserSnapshot {
  const tab = activeMockBrowserTab()
  const url = browserUrl(rawUrl)
  tab.history = [...tab.history.slice(0, tab.historyIndex + 1), url]
  tab.historyIndex = tab.history.length - 1
  tab.url = url
  tab.title = browserTitle(url)
  return mockBrowserSnapshot()
}

function mockBrowserMoveHistory(delta: -1 | 1): MockBrowserSnapshot {
  const tab = activeMockBrowserTab()
  const next = Math.min(tab.history.length - 1, Math.max(0, tab.historyIndex + delta))
  tab.historyIndex = next
  tab.url = tab.history[next]
  tab.title = browserTitle(tab.url)
  return mockBrowserSnapshot()
}

function previewFrameDocument(): Document | null {
  if (typeof document === 'undefined') return null
  const frame = document.querySelector<HTMLIFrameElement>('.browser-preview-frame')
  if (!frame) return null
  try { return frame.contentDocument }
  catch { return null }
}

function previewElementLabel(element: Element): string {
  return (element.textContent || element.getAttribute('aria-label') || (element as HTMLInputElement).value || '')
    .trim()
    .slice(0, 240)
}

function previewSameDocument(rawHref: string, destination: URL, current: URL): boolean {
  return rawHref.startsWith('#') || (
    destination.origin === current.origin
    && destination.pathname === current.pathname
    && destination.search === current.search
    && Boolean(destination.hash)
  )
}

function mockBrowserClick(selector: unknown, text: unknown): Record<string, unknown> {
  const tab = activeMockBrowserTab()
  const frameDocument = previewFrameDocument()
  if (!frameDocument) return { ok: false, code: 'preview_only', message: '开发预览页面尚未加载或不允许 DOM 访问。' }
  const needle = typeof text === 'string' ? text.trim().toLowerCase() : ''
  let element: Element | null = null
  if (typeof selector === 'string' && selector.trim()) {
    try { element = frameDocument.querySelector(selector) }
    catch { return { ok: false, code: 'invalid_selector' } }
  }
  if (!element && needle) {
    const candidates = Array.from(frameDocument.querySelectorAll('a,button,[role="button"],input,textarea,[contenteditable="true"]'))
    element = candidates.find(value => previewElementLabel(value).toLowerCase().includes(needle)) ?? null
  }
  if (!element) return { ok: false, code: 'element_not_found' }

  element.scrollIntoView({ block: 'center', inline: 'nearest' })
  if (element.matches('a[href]')) {
    const anchor = element as HTMLAnchorElement
    let destination: URL
    try { destination = new URL(anchor.href, tab.url) }
    catch { return { ok: false, code: 'invalid_link' } }
    const current = new URL(tab.url)
    const rawHref = (anchor.getAttribute('href') || '').trim()
    if (!previewSameDocument(rawHref, destination, current) && /^https?:$/i.test(destination.protocol) && !anchor.hasAttribute('download')) {
      if ((anchor.getAttribute('target') || '').toLowerCase() === '_self') {
        const browser = mockBrowserNavigate(destination.href)
        return { ok: true, tag: 'a', text: previewElementLabel(anchor), href: destination.href, navigated: true, browser }
      }
      const opened = createMockBrowserTab(destination.href)
      return { ok: true, tag: 'a', text: previewElementLabel(anchor), href: destination.href, openedTab: true, browser: mockBrowserSnapshot(), opened: opened.id }
    }
  }
  ;(element as HTMLElement).click()
  return { ok: true, tag: element.tagName.toLowerCase(), text: previewElementLabel(element), openedTab: false }
}

function mockBrowserType(text: unknown, selector: unknown): Record<string, unknown> {
  if (typeof text !== 'string' || !text) return { ok: false, code: 'text_empty' }
  const frameDocument = previewFrameDocument()
  if (!frameDocument) return { ok: false, code: 'preview_only', message: '开发预览页面尚未加载或不允许 DOM 访问。' }
  let element: Element | null = null
  if (typeof selector === 'string' && selector.trim()) {
    try { element = frameDocument.querySelector(selector) }
    catch { return { ok: false, code: 'invalid_selector' } }
  }
  element ??= frameDocument.activeElement
  const editable = element as HTMLElement | null
  if (!element || (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !editable?.isContentEditable)) {
    return { ok: false, code: 'input_not_found' }
  }
  if (editable?.isContentEditable) element.textContent = text
  else {
    const input = element as HTMLInputElement | HTMLTextAreaElement
    input.value = text
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

function mockBrowserPress(key: unknown): Record<string, unknown> {
  if (typeof key !== 'string' || !key.trim()) return { ok: false, code: 'key_empty' }
  const frameDocument = previewFrameDocument()
  if (!frameDocument) return { ok: false, code: 'preview_only', message: '开发预览页面尚未加载或不允许 DOM 访问。' }
  const target = frameDocument.activeElement || frameDocument.body
  if (!target) return { ok: false, code: 'document_not_ready' }
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  return { ok: true, key }
}

function mockBrowserScroll(deltaX: unknown, deltaY: unknown): Record<string, unknown> {
  const frame = typeof document === 'undefined' ? null : document.querySelector<HTMLIFrameElement>('.browser-preview-frame')
  const window = frame?.contentWindow
  if (!window) return { ok: false, code: 'preview_only', message: '开发预览页面尚未加载或不允许 DOM 访问。' }
  const x = typeof deltaX === 'number' && Number.isFinite(deltaX) ? Math.trunc(deltaX) : 0
  const y = typeof deltaY === 'number' && Number.isFinite(deltaY) ? Math.trunc(deltaY) : 600
  window.scrollBy(x, y)
  return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY }
}

function mockBrowserPageSnapshot(): Record<string, unknown> {
  const tab = activeMockBrowserTab()
  const frameDocument = previewFrameDocument()
  if (frameDocument) {
    const current = frameDocument.defaultView?.location.href || tab.url
    const links = Array.from(frameDocument.querySelectorAll<HTMLAnchorElement>('a[href]')).slice(0, 100).map((element, index) => ({
      index,
      text: previewElementLabel(element),
      href: element.href,
      target: element.getAttribute('target') || null,
      download: element.hasAttribute('download'),
      downloadName: element.getAttribute('download') || null,
    }))
    return {
      runtime: 'iframe-preview', tabId: tab.id, url: current,
      title: frameDocument.title || tab.title, text: (frameDocument.body?.innerText || '').slice(0, 20000),
      links,
    }
  }
  const links = tab.url === 'https://example.com'
    ? [{ text: 'More information...', href: 'https://iana.org/domains/example', target: '_blank', download: false, downloadName: null }]
    : []
  return {
    runtime: 'iframe-preview',
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    text: tab.url === 'https://example.com' ? 'Example Domain\nThis domain is for use in illustrative examples in documents.' : '',
    links,
    note: '开发预览中的 iframe；跨域页面在代理不可用时仅提供状态预览。',
  }
}

function mockBrowserDownload(rawUrl: unknown, rawFilename: unknown): Record<string, unknown> {
  const url = browserUrl(rawUrl)
  if (url === 'about:blank') throw new Error('下载仅允许 http/https URL')
  const filename = typeof rawFilename === 'string' && rawFilename.trim()
    ? rawFilename.trim().replace(/[\\/\0]/g, '')
    : (new URL(url).pathname.split('/').filter(Boolean).at(-1) || 'download')
  // Preview cannot guarantee cross-origin bytes, but it can faithfully exercise the
  // explicit download gesture and expose the same result shape as the native host.
  if (typeof document !== 'undefined') {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    anchor.click()
  }
  return { ok: true, url, filename, status: 'started', runtime: 'iframe-preview' }
}

function mockGitOperation(summary: string) {
  return {
    summary,
    status: { branch: { branch: mockGitBranch, detached: false, head: 'ac82de4' }, entries: mockGitEntries },
  }
}

/** 纯命令路由（node 可测，无 window）。 */
export async function mockInvokeCommand(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case 'list_agents': return buildDemoAgents()
    case 'agent_status': return mockAgentStatus()
    case 'agent_config_snapshot': return {
      revision: `demo-config-${mockAgentConfigRevision}`,
      agents: buildDemoAgents(),
      diagnostics: [],
    }
    case 'list_workspace_entries':
      return resolveWorkspaceEntries(typeof args.relativePath === 'string' ? args.relativePath : '')
    case 'read_workspace_text':
      return buildWorkspaceFileText(typeof args.relativePath === 'string' ? args.relativePath : '')
    case 'git_status': return mockGitEntries
    case 'git_status_with_branch': return { ...buildGitStatusWithBranch(), branch: { branch: mockGitBranch, detached: false, head: 'ac82de4' }, entries: mockGitEntries }
    case 'git_history': return mockGitHistory
    case 'git_diff': return buildGitDiff()
    case 'git_stage': {
      const paths = Array.isArray(args.paths) ? new Set(args.paths.filter((path): path is string => typeof path === 'string')) : new Set<string>()
      mockGitEntries = mockGitEntries.map(entry => paths.has(entry.path) ? { ...entry, staged: true } : entry)
      return mockGitOperation('已暂存所选文件（演示）')
    }
    case 'git_unstage': {
      const paths = Array.isArray(args.paths) ? new Set(args.paths.filter((path): path is string => typeof path === 'string')) : new Set<string>()
      mockGitEntries = mockGitEntries.map(entry => paths.has(entry.path) ? { ...entry, staged: false } : entry)
      return mockGitOperation('已取消暂存所选文件（演示）')
    }
    case 'git_commit': {
      const message = typeof args.message === 'string' ? args.message.trim() : ''
      mockGitEntries = mockGitEntries.filter(entry => !entry.staged)
      mockGitHistory = [{ hash: 'd3a0c01', author: 'Demo User', date: Math.floor(Date.now() / 1000), subject: message || '演示提交' }, ...mockGitHistory]
      return mockGitOperation('提交成功（演示）')
    }
    case 'git_create_branch':
    case 'git_switch_branch':
      mockGitBranch = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : mockGitBranch
      return mockGitOperation(cmd === 'git_create_branch' ? '已创建并切换分支（演示）' : '已切换分支（演示）')
    case 'git_pull': return mockGitOperation('已经是最新版本（演示）')
    case 'git_push': return mockGitOperation('推送完成（演示）')
    case 'detect_agent_runtimes': return {
      candidates: [{
        candidateId: 'mock-high:C:/Tools/peri.exe', detectorId: 'builtin.detector.peri', provider: 'peri',
        suggestedAgentId: 'peri-local', name: 'Peri Local', executable: 'C:/Tools/peri.exe', args: ['acp'],
        evidence: [{ kind: 'path', detail: 'C:/Tools/peri.exe' }, { kind: 'version', detail: 'peri 1.8.0' }],
        identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [],
      },
      {
        candidateId: 'mock-medium:C:/Tools/hermes.exe', detectorId: 'builtin.detector.hermes', provider: 'hermes',
        suggestedAgentId: 'hermes-local', name: 'Hermes Local', executable: 'C:/Tools/hermes.exe', args: ['acp'],
        evidence: [{ kind: 'path', detail: 'C:/Tools/hermes.exe' }], identityConfidence: 'medium', protocolAvailability: 'not_tested',
        warnings: ['未能读取版本；导入前必须完成 ACP initialize 验证'],
      }],
      diagnostics: [],
      elapsedMs: 12,
      truncated: false,
    }
    case 'test_agent_candidate': {
      const agentId = typeof args.agentId === 'string' ? args.agentId : 'candidate'
      if (agentId.startsWith('peri')) return {
        ok: false, agentId, durationMs: 418,
        error: { code: 'agent_initialize_failed', message: 'ACP connection closed', action: 'open-runtime-log', stage: 'initialize', exitCode: 7, stderr: 'Provider profile was not selected' },
      }
      return { ok: true, agentId, durationMs: 126, error: null }
    }
    case 'gateway_status': return { ...buildGatewayStatus(), routes: mockGatewayRoutes }
    case 'gateway_sessions': return buildPlatformSessions()
    case 'update_agents_config': {
      const expected = `demo-config-${mockAgentConfigRevision}`
      if (args.expectedRevision !== expected) {
        throw { code: 'config_revision_conflict', message: `期望 ${String(args.expectedRevision)}，实际 ${expected}` }
      }
      // G4 验收：gateway 保存有状态——更新 mock routes，read-back 一致（浏览器可验安全写回）
      const routes = (args.config as { gateway?: { routes?: unknown[] } } | undefined)?.gateway?.routes
      if (Array.isArray(routes)) mockGatewayRoutes = routes as never[]
      mockAgentConfigRevision += 1
      return { applied: true, revision: `demo-config-${mockAgentConfigRevision}` }
    }
    case 'reload_gateway': return null
    // Browser Sheet：有状态 preview transport。页面本身由 BrowserSheet 的 iframe 加载，
    // 这里只负责让地址、标签、缩放和 Agent 命令在开发模式下保持一致。
    case 'browser_status': return mockBrowserSnapshot()
    case 'browser_start': {
      const snapshot = mockBrowserStart()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_new_tab': {
      createMockBrowserTab()
      const snapshot = mockBrowserSnapshot()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_open_tab': {
      createMockBrowserTab(browserUrl(args.url))
      const snapshot = mockBrowserSnapshot()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_select_tab': {
      const tabId = typeof args.tabId === 'number' ? args.tabId : Number(args.tabId)
      if (!Number.isInteger(tabId) || !mockBrowserTabs.some(tab => tab.id === tabId)) throw new Error(`浏览器标签不存在：${String(args.tabId)}`)
      mockBrowserActiveTabId = tabId
      const snapshot = mockBrowserSnapshot()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_close_tab': {
      const tabId = typeof args.tabId === 'number' ? args.tabId : Number(args.tabId)
      const index = mockBrowserTabs.findIndex(tab => tab.id === tabId)
      if (index < 0) throw new Error(`浏览器标签不存在：${String(args.tabId)}`)
      const wasActive = mockBrowserActiveTabId === tabId
      mockBrowserTabs = mockBrowserTabs.filter(tab => tab.id !== tabId)
      if (wasActive) mockBrowserActiveTabId = mockBrowserTabs[Math.min(index, mockBrowserTabs.length - 1)]?.id ?? null
      const snapshot = mockBrowserSnapshot()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_navigate': {
      const snapshot = mockBrowserNavigate(args.url)
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_back': {
      const snapshot = mockBrowserMoveHistory(-1)
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_forward': {
      const snapshot = mockBrowserMoveHistory(1)
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_reload': {
      const snapshot = mockBrowserSnapshot()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_set_zoom': {
      const zoom = typeof args.zoomPercent === 'number' ? args.zoomPercent : Number(args.zoomPercent)
      if (!Number.isInteger(zoom) || zoom < 50 || zoom > 200) throw new Error('浏览器缩放必须在 50%–200% 之间')
      mockBrowserZoomPercent = zoom
      const snapshot = mockBrowserSnapshot()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_set_bounds': return null
    case 'browser_set_visible': {
      mockBrowserVisible = args.visible !== false
      const snapshot = mockBrowserSnapshot()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'browser_snapshot': return mockBrowserPageSnapshot()
    case 'browser_download': return mockBrowserDownload(args.url, args.filename)
    case 'browser_click': {
      const result = mockBrowserClick(args.selector, args.text)
      emitMockBrowserStatus()
      return result
    }
    case 'browser_type': return mockBrowserType(args.text, args.selector)
    case 'browser_press': return mockBrowserPress(args.key)
    case 'browser_scroll': return mockBrowserScroll(args.deltaX, args.deltaY)
    case 'browser_close': {
      mockBrowserTabs = []
      mockBrowserActiveTabId = null
      mockBrowserVisible = true
      const snapshot = mockBrowserSnapshot()
      emitMockBrowserStatus()
      return snapshot
    }
    case 'list_persisted_sessions': return buildSessionSummaries()
    case 'startup_diagnostics': return buildStartupDiagnostics()
    case 'list_runtime_logs': return buildRuntimeLogs()
    case 'workspace_search': return buildWorkspaceSearchResults(typeof args.query === 'string' ? args.query : '')
    case 'workspace_create': {
      const workspace = {
        id: `w${mockWorkspaceSeq++}`,
        agentId: typeof args.agentId === 'string' ? args.agentId : '',
        name: typeof args.name === 'string' ? args.name : '默认工作区',
        rootPath: typeof args.rootPath === 'string' ? args.rootPath : 'G:\\mock\\workspace',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        skills: [],
        mcpServerIds: [],
        hookPluginIds: [],
      }
      mockWorkspaces = [...mockWorkspaces, workspace]
      return workspace
    }
    case 'workspace_list': return mockWorkspaces
    case 'workspace_update': {
      const workspace = mockWorkspaces.find(w => w.id === args.workspaceId)
      if (!workspace) return Promise.reject(new Error(`workspace not found: ${args.workspaceId}`))
      const updated = {
        ...workspace,
        name: typeof args.name === 'string' ? args.name : workspace.name,
        rootPath: typeof args.rootPath === 'string' ? args.rootPath : workspace.rootPath,
        skills: Array.isArray(args.skills) ? args.skills.filter((value): value is string => typeof value === 'string') : workspace.skills,
        mcpServerIds: Array.isArray(args.mcpServerIds) ? args.mcpServerIds.filter((value): value is string => typeof value === 'string') : workspace.mcpServerIds,
        hookPluginIds: Array.isArray(args.hookPluginIds) ? args.hookPluginIds.filter((value): value is string => typeof value === 'string') : workspace.hookPluginIds,
        lastActiveAt: Date.now(),
      }
      mockWorkspaces = mockWorkspaces.map(w => w.id === updated.id ? updated : w)
      return updated
    }
    case 'workspace_delete': {
      mockWorkspaces = mockWorkspaces.filter(w => w.id !== args.workspaceId)
      return null
    }
    case 'plugin_package_list': return mockPluginPackages
    case 'plugin_package_versions':
      return mockPluginPackages
        .filter(item => item.package.pluginId === args.pluginId)
        .map(item => item.package)
    case 'plugin_package_set_enabled': {
      mockPluginPackages = mockPluginPackages.map(item => item.package.pluginId === args.pluginId
        ? { ...item, enabled: args.enabled === true }
        : item)
      return null
    }
    case 'plugin_package_uninstall': {
      mockPluginPackages = mockPluginPackages.filter(item => item.package.pluginId !== args.pluginId)
      return null
    }
    // P53 D6：zip/URL 安装源浏览器反馈环 mock（descriptor 由期望 id 合成，
    // 真实 zip 校验/下载在 Tauri 侧；mock 只走通前端链路）
    case 'plugin_package_inspect_zip':
    case 'plugin_package_inspect_url':
    case 'plugin_install_from_zip':
    case 'plugin_install_from_url': {
      const expectedId = typeof args.expectedId === 'string' && args.expectedId.trim()
        ? args.expectedId.trim()
        : 'demo.zip-source'
      const descriptor = {
        pluginId: expectedId,
        version: '1.0.0',
        packageInstanceId: `${expectedId}@1.0.0-mock`,
        manifest: {
          schema: 1 as const, id: expectedId, name: `Mock ${expectedId}`, version: '1.0.0',
          api: '1.0' as const, kind: 'feature' as const, web: { entry: './index.js' },
        },
        files: [{ path: 'index.js', size: 1, mime: 'text/javascript' }],
        totalBytes: 1,
        active: true,
      }
      if (String(cmd).startsWith('plugin_package_inspect')) return descriptor
      mockPluginPackages = [
        ...mockPluginPackages.filter(item => item.package.pluginId !== expectedId),
        { package: descriptor, enabled: true },
      ]
      return { operationId: `mock-${Date.now()}`, package: descriptor }
    }
    case 'new_session':
    case 'load_persisted_session':
      return buildSessionResponse(args)
    case 'send_message': return { ok: true, mock: true }
    case 'restart_agent_runtime': return {
      agentId: typeof args.agentId === 'string' ? args.agentId : 'peri',
      configActivationState: 'activated',
    }
    case 'switch_agent': {
      const requested = typeof args.name === 'string' ? args.name.trim() : ''
      const matched = buildDemoAgents().find(agent => agent.id === requested || agent.name === requested)
      if (matched) mockActiveAgentId = matched.id
      return null
    }
    case 'reconnect_agent':
    case 'reload_agents':
    case 'set_mode':
    case 'set_config_option':
    case 'close_session':
    case 'cancel_prompt':
    case 'export_session':
    case 'clear_runtime_logs':
      return null
    // #463 审查项 3：approval wire 契约 = {mode, persisted} 快照（demo 恒健康）
    case 'set_approval_mode':
      return {
        mode: typeof args.mode === 'string' ? args.mode : 'default',
        persisted: true,
      }
    case 'get_approval_mode':
      return { mode: 'default', persisted: true }
    case 'plugin:event|listen': return 1
    case 'plugin:event|unlisten': return null
    case 'plugin:dialog|save':
      return typeof args.defaultPath === 'string'
        ? `G:\\mock\\exports\\${args.defaultPath}`
        : 'G:\\mock\\exports\\session-export.md'
    default:
      return Promise.reject(new Error(`Command not found: ${cmd}`))
  }
}

/** 安装假 Tauri globals（真 Tauri 环境或已安装时 no-op）。 */
export function installMockTauri(): void {
  if (typeof window === 'undefined') return
  const target = window as unknown as Record<string, unknown>
  if (target.__TAURI_INTERNALS__) return
  target.__PYLON_BROWSER_MOCK__ = true
  let callbackId = 0
  target.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => mockInvokeCommand(cmd, args ?? {}),
    transformCallback: (_callback: unknown, _once?: boolean) => ++callbackId,
    unregisterCallback: () => {},
    convertFileSrc: (filePath: string) => filePath,
  }
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
    unregisterCallback: () => {},
  }
}
