/** @jsxImportSource solid-js */
import '../../../index.css'
// Tailwind v4 utilities 基线（TW 施工书 20260914 / P85）：无 preflight；
// token canary 在下方，端到端验证类扫描与 @theme inline 映射。
import '../../../styles/tailwind.css'
import { createWorkbenchEnvelope, type WorkbenchSemanticEvent } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench } from '../../../domains/workbench/workbenchProjector.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { PluginScope } from '../../../plugin-runtime/pluginScope.ts'
import { mountFirstPartyStyleAssets } from '../../../plugins/product/firstPartyStyleRuntime.ts'
import { loadBuiltinPylonRendererStyles } from '../../../plugins/product/packages/builtin.pylon-renderers/styleAssets.ts'
import { loadBuiltinPylonShellStyles } from '../../../plugins/product/packages/builtin.pylon-shell/styleAssets.ts'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'

const host = document.getElementById('root')
if (!host) throw new Error('Solid rich QA host is missing')

// This standalone harness deliberately bypasses the product plugin composition
// root. Install the exact first-party assets through the production lifecycle so
// visual QA measures the shipped renderer instead of browser-default styling.
const qaStyleScope = new PluginScope('solid-rich-qa@runtime')
mountFirstPartyStyleAssets(
  'builtin.pylon-shell',
  qaStyleScope.ownerKey,
  qaStyleScope,
  loadBuiltinPylonShellStyles().filter(asset => asset.path.endsWith('/App.css')),
)
mountFirstPartyStyleAssets(
  'builtin.pylon-renderers',
  qaStyleScope.ownerKey,
  qaStyleScope,
  loadBuiltinPylonRendererStyles(),
)
window.addEventListener('beforeunload', () => { void qaStyleScope.disposeNow() }, { once: true })

const sessionId = 'solid-rich-qa'
const event = (sequence: number, value: WorkbenchSemanticEvent, identity: { messageId?: string; toolCallId?: string } = {}) => createWorkbenchEnvelope({
  sessionId,
  sequence,
  recordedAt: `2026-08-26T00:00:${String(sequence).padStart(2, '0')}.000Z`,
  source: { provider: 'acp-visual-qa', sourceId: `rich-${sequence}` },
  identity,
  provenance: { origin: 'local-observed', trust: 'authoritative' },
  event: value,
})

const documentSnapshot = projectWorkbench([
  event(1, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '验收 ACP structured content 富渲染主链。' }] }, { messageId: 'user-rich' }),
  event(2, {
    type: 'message.delta', role: 'assistant', parts: [
      { kind: 'markdown', text: '## Structured content\n\n下列内容来自 canonical `ContentPart`，不是手写 JSON 卡面。' },
      { kind: 'location', path: '/workspace/src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx', line: 1056, column: 3 },
      { kind: 'progress', current: 3, total: 4, message: '索引 renderer kinds' },
      { kind: 'list', title: '富内容边界', items: [
        { kind: 'markdown', text: '**Markdown** 保持语义渲染' },
        { kind: 'code', text: 'const renderer = "solid"', language: 'ts' },
        { source_path: '/workspace/report.md', score: 0.98 },
      ] },
      { kind: 'key-value', entries: { provider: 'ACP', replaySafe: true, revision: 7 } },
      { kind: 'json', value: { nested: { expanded: false, streaming: true }, tags: ['typed', 'bounded'] } },
      { kind: 'tool-use', name: 'Fetch', status: 'running', input: { url: 'https://example.test/api', method: 'GET' }, requestId: 'request-42' },
      { kind: 'tool-result', name: 'Search', status: 'completed', latencyMs: 42, parts: [
        { kind: 'markdown', text: '找到 **2** 项结果' },
        { kind: 'location', path: '/workspace/src/app.ts', line: 7 },
      ] },
    ],
  }, { messageId: 'assistant-rich' }),
  event(3, { type: 'message.completed', role: 'assistant', parts: [] }, { messageId: 'assistant-rich' }),
  event(4, { type: 'tool.started', tool: {
    toolCallId: 'tool-read-rich', name: 'Read', title: '读取渲染器入口', semanticKind: 'tool.read', status: 'running',
    input: { file_path: '/workspace/src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx', start_line: 1040, end_line: 1070 },
  } }, { toolCallId: 'tool-read-rich' }),
  event(5, { type: 'tool.completed', tool: {
    toolCallId: 'tool-search-rich', name: 'Search', title: '查找 renderer kinds', semanticKind: 'tool.search', status: 'completed', durationMs: 860,
    input: { query: 'content.tool-result', path: '/workspace/src' },
    parts: [{ kind: 'search-result', query: 'content.tool-result', results: [
      { source: '/workspace/src/renderers/solid-workbench/chat/content/StructuredContent.solid.tsx', title: 'StructuredContent', snippet: 'content.tool-result' },
    ] }],
  } }, { toolCallId: 'tool-search-rich' }),
  event(6, { type: 'tool.completed', tool: {
    toolCallId: 'tool-edit-rich', name: 'EditResource', title: '更新远端文档', semanticKind: 'tool.edit', status: 'completed', durationMs: 42,
    input: { uri: 'acp-resource://workspace/document/7', replace: 'terminal presenter' },
    parts: [{ kind: 'diff', path: 'acp-resource://workspace/document/7', lines: [
      { kind: 'removed', text: 'card presenter' },
      { kind: 'added', text: 'terminal presenter' },
    ] }],
  } }, { toolCallId: 'tool-edit-rich' }),
  event(7, { type: 'tool.completed', tool: {
    toolCallId: 'tool-execute-rich', name: 'Bash', title: '运行富渲染回归', semanticKind: 'tool.execute', status: 'completed', durationMs: 1420,
    input: { command: 'npm test -- rich-content', cwd: '/workspace', env: { CI: '1' } },
    parts: [{ kind: 'terminal', command: 'npm test -- rich-content', exitCode: 0, streams: [
      { stream: 'stdout', text: '28 tests passed', ordinal: 0 },
    ] }],
  } }, { toolCallId: 'tool-execute-rich' }),
  event(8, { type: 'tool.completed', tool: {
    toolCallId: 'tool-mcp-rich', name: 'mcp__repository__search_code', title: '查询仓库索引', status: 'completed', durationMs: 318,
    capabilities: ['mcp', 'dynamic-schema'],
    input: { server_name: 'repository', arguments: { query: 'tool-kind-summary', language: 'css' } },
    rawOutput: { matches: 3, cursor: null, files: ['ChatView.css', 'ToolBody.solid.tsx'] },
  } }, { toolCallId: 'tool-mcp-rich' }),
  event(9, { type: 'tool.completed', tool: {
    toolCallId: 'tool-browser-rich', name: 'BrowserClick', title: '验收展开交互', status: 'completed', durationMs: 126,
    action: 'click', input: { url: 'http://127.0.0.1:1420/solid-rich-qa.html', selector: '.term-tool-head', tabId: 'qa-tab' },
    rawOutput: 'clicked',
  } }, { toolCallId: 'tool-browser-rich' }),
  event(10, { type: 'tool.completed', tool: {
    toolCallId: 'tool-artifact-rich', name: 'artifact_tool', title: '生成验收报告', status: 'completed', durationMs: 73,
    input: { title: 'Terminal rich QA', uri: 'artifact://reports/terminal-rich', format: 'markdown' },
    rawOutput: { status: 'saved', bytes: 2048 },
  } }, { toolCallId: 'tool-artifact-rich' }),
  event(11, { type: 'tool.completed', tool: {
    toolCallId: 'tool-unknown-rich', name: 'FutureProviderTool', title: '未知工具安全降级', status: 'completed',
    input: { mode: 'preview', nested: { enabled: true, retries: 2 } },
    rawOutput: { result: ['typed', 'bounded'], metadata: { providerRevision: 9 } },
  } }, { toolCallId: 'tool-unknown-rich' }),
  event(12, { type: 'tool.completed', tool: {
    toolCallId: 'tool-fetch-rich', name: 'WebFetch', title: '获取规范页面', semanticKind: 'tool.fetch', status: 'completed', durationMs: 211,
    input: { url: 'https://example.test/acp/rendering', method: 'GET' },
    rawOutput: '200 OK · 12.4 KiB',
  } }, { toolCallId: 'tool-fetch-rich' }),
  event(13, { type: 'tool.completed', tool: {
    toolCallId: 'tool-delegate-rich', name: 'Agent', title: '委派视觉审计', action: 'delegate', status: 'completed', durationMs: 920,
    input: { prompt: '检查 terminal-like 富渲染信息层级', subagent_type: 'reviewer', model: 'sonnet', run_in_background: true },
    rawOutput: { verdict: 'pass', notes: 2 },
  } }, { toolCallId: 'tool-delegate-rich' }),
  event(14, { type: 'tool.completed', tool: {
    toolCallId: 'tool-plan-rich', name: 'TodoWrite', title: '更新发布清单', action: 'plan', status: 'completed', durationMs: 34,
    input: { objective: '完成富渲染验收', status: 'in_progress', todos: [
      { content: '终端展开态', status: 'completed' },
      { content: '窄宽度', status: 'in_progress' },
    ] },
    rawOutput: { updated: 2 },
  } }, { toolCallId: 'tool-plan-rich' }),
  event(15, { type: 'tool.completed', tool: {
    toolCallId: 'tool-skill-rich', name: 'Skill', title: '加载诊断流程', action: 'skill', status: 'completed', durationMs: 18,
    input: { skill: 'diagnose', path: '/workspace/skills/diagnose/SKILL.md', operation: 'read' },
    rawOutput: 'skill loaded',
  } }, { toolCallId: 'tool-skill-rich' }),
]).document

// Tailwind token canary（TW 施工书 20260914 / P85）：端到端验证「类扫描 →
// @theme inline token 映射 → layer 层叠」。utility 值必须是 var(…) 引用形态；
// 对 body 注入 --surface-raised 等覆盖时 canary 应即时跟随（换肤解析域验证）。
const tailwindCanary = document.createElement('div')
tailwindCanary.className = 'tw-token-canary rounded-md bg-surface-raised p-2 text-text-dim'
tailwindCanary.dataset.twCanary = 'true'
tailwindCanary.textContent = 'Tailwind token canary'
tailwindCanary.style.position = 'fixed'
tailwindCanary.style.right = '16px'
tailwindCanary.style.bottom = '16px'
tailwindCanary.style.zIndex = '9999'
document.body.append(tailwindCanary)
window.addEventListener('beforeunload', () => { tailwindCanary.remove() }, { once: true })

const services = createPreviewWorkbenchServices()
services.appearance.setTheme({
  ...DEFAULTS,
  msgStyle: 'terminal',
  messageLayout: 'claude',
  chatFont: 'mono',
  msgFont: 'mono',
  assistantDot: true,
  assistantDotGlyph: '●',
  toolIndicator: '●',
  toolConnectorMode: 'follow',
})
services.runtime.replaceDocument(documentSnapshot, { ownerKey: 'solid-rich-qa', generation: 1, sessionId })
services.runtime.update({ generating: false, generationStart: 0, lastTokenAt: undefined, summary: null })

mountSolidWorkbench({
  host,
  input: { sheetId: 'solid-rich-qa', sessionId, sessionOwnerKey: 'solid-rich-qa', preview: true },
  services,
})
