/** @jsxImportSource solid-js */
import { For, Show, createMemo, type JSX } from 'solid-js'
import type { RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import { createUnknownContentPart, type ContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import type { ToolInvocationSnapshot } from '../../../../domains/workbench/workbenchProjector.ts'
import { ToolObjectInspector } from './ToolObjectInspector.solid.tsx'
import { classifyResourceTarget, resourceRange, type RenderResourceTarget } from './resourceTarget.ts'
import { isTerminalToolVisualState, normalizeToolStatus } from '../../../../domains/tool/status.ts'
import { isRecord } from '../../../../utils/wireGuards.ts'
import { ToolBodySubProps } from './toolBodyTypes.ts'

export function ToolBody(props: ToolBodySubProps & {
  snapshot: ToolInvocationSnapshot
  renderKind: string
  parts: readonly ContentPart[]
  inputParts?: readonly ContentPart[]
  renderPart: (part: ContentPart, index: number, source: 'input' | 'output') => JSX.Element
}) {
  const kind = () => effectiveKind(props.renderKind, props.snapshot)
  // #389：终态工具不再渲染活态进度（投影按设计在终态保留首份 progress 快照，
  // 若继续渲染会让已完成卡片滞留「进行中」标题与陈旧进度条）。
  const toolSettled = () => isTerminalToolVisualState(normalizeToolStatus(props.snapshot.status))
  const input = () => isRecord(props.snapshot.input) ? props.snapshot.input : undefined
  const rawFallback = createMemo(() => props.parts.length === 0 && props.snapshot.result?.rawOutput !== undefined
    ? { value: safeDisplayValue(props.snapshot.result.rawOutput) }
    : undefined)

  return <div class="tool-rich-body" data-tool-body-kind={kind()}>
    <Show when={kind() === 'tool.read'}>
      <ReadSummary input={input()} snapshot={props.snapshot} commands={props.commands} />
    </Show>
    <Show when={kind() === 'tool.edit'}>
      <EditSummary input={input()} parts={props.parts} commands={props.commands} />
    </Show>
    <Show when={kind() === 'tool.execute'}>
      <ExecuteSummary input={input()} commands={props.commands} />
    </Show>
    <Show when={kind() === 'tool.search' || kind() === 'tool.fetch'}>
      <SearchFetchSummary kind={kind()} input={input()} commands={props.commands} />
    </Show>
    <Show when={kind() === 'tool.delegate'}>
      <DelegateSummary input={input()} />
    </Show>
    <Show when={kind() === 'tool.plan'}>
      <PlanSummary input={input()} />
    </Show>
    <Show when={kind() === 'tool.skill'}>
      <SkillSummary input={input()} commands={props.commands} />
    </Show>
    <Show when={kind() === 'tool.mcp'}>
      <McpSummary input={input()} snapshot={props.snapshot} commands={props.commands} />
    </Show>
    <Show when={kind() === 'tool.browser'}>
      <BrowserSummary input={input()} action={props.snapshot.action} commands={props.commands} />
    </Show>
    <Show when={kind() === 'tool.artifact'}>
      <ArtifactSummary input={input()} commands={props.commands} />
    </Show>

    <Show when={props.snapshot.input !== undefined}>
      <InputSection
        value={props.snapshot.input}
        parts={props.inputParts}
        kind={kind()}
        commands={props.commands}
        renderPart={props.renderPart}
      />
    </Show>

    <Show when={props.snapshot.progress !== undefined && !toolSettled()}>
      <ProgressSection value={props.snapshot.progress} commands={props.commands} />
    </Show>

    <Show when={props.snapshot.locations !== undefined}>
      <LocationsSection value={props.snapshot.locations} commands={props.commands} />
    </Show>

    <Show when={props.parts.length > 0}>
      <section class="solid-tool-parts tool-rich-section" aria-label="工具输出">
        <SectionHeading label="输出" count={props.parts.length} />
        <div class="tool-rich-output">
          <For each={props.parts}>{(part, index) => props.renderPart(part, index(), 'output')}</For>
        </div>
      </section>
    </Show>

    <Show when={rawFallback()}>
      {fallback => <section class="tool-rich-section tool-output-fallback" aria-label="工具输出">
        <SectionHeading label="输出" />
        <Show when={typeof fallback().value === 'string'} fallback={<ToolObjectInspector value={fallback().value} commands={props.commands} />}>
          <pre class="tool-plain-output">{String(fallback().value)}</pre>
        </Show>
      </section>}
    </Show>
  </div>
}

function InputSection(props: ToolBodySubProps & {
  value: unknown
  parts?: readonly ContentPart[]
  kind: string
  renderPart: (part: ContentPart, index: number, source: 'input' | 'output') => JSX.Element
}) {
  const hiddenKeys = () => showcasedInputKeys(props.kind)
  const remaining = () => omitRecordKeys(props.value, hiddenKeys())
  const hasSummary = () => hiddenKeys().length > 0 && isRecord(props.value)
  const label = () => hasSummary() ? '更多参数' : '输入'

  return <Show when={props.parts && props.parts.length > 0} fallback={
    <Show when={!isEmptyRecord(remaining())}>
      <section class="solid-tool-field tool-rich-section tool-input-section">
        <Show when={hasSummary()} fallback={<SectionHeading label={label()} />}>
          <details class="tool-secondary-details">
            <summary>{label()}</summary>
            <ToolObjectInspector value={remaining()} commands={props.commands} />
          </details>
        </Show>
        <Show when={!hasSummary()}>
          <ToolObjectInspector value={remaining()} commands={props.commands} />
        </Show>
      </section>
    </Show>
  }>
    <section class="solid-tool-field tool-rich-section tool-input-section">
      <SectionHeading label="输入" />
      <div data-tool-input-parts>
        <For each={props.parts}>{(part, index) => props.renderPart(part, index(), 'input')}</For>
      </div>
    </section>
  </Show>
}

function ReadSummary(props: ToolBodySubProps & { input?: Record<string, unknown>; snapshot: ToolInvocationSnapshot }) {
  const inputTarget = () => firstStringEntry(props.input, PATH_KEYS)
  const path = () => inputTarget()?.value ?? firstLocationPath(props.snapshot.locations)
  const target = () => inputTarget()
    ? classifyResourceTarget(inputTarget()!.value, inputTarget()!.key)
    : firstLocationTarget(props.snapshot.locations)
  const range = () => rangeLabel(props.input)
  const chips = () => compact([
    range(),
    labelledValue('编码', firstString(props.input, ['encoding', 'charset'])),
    labelledValue('行数', firstFinite(props.input, ['limit', 'line_count', 'lineCount'])),
  ])
  return <Show when={path() || chips().length > 0}>
    <section class="tool-kind-summary tool-read-summary" aria-label="读取目标">
      <div class="tool-kind-icon" aria-hidden="true">R</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">读取文件</span>
        <Show when={path()}>{value => <ResourceButton value={value()} target={target()!} commands={props.commands} />}</Show>
        <ChipList values={chips()} />
      </div>
      <Show when={target() && can(props.commands, 'resource.open')}>
        <button class="tool-kind-action" type="button" onClick={() => target() && openTarget(props.commands, target()!)}>在 FileSheet 打开</button>
      </Show>
    </section>
  </Show>
}

function EditSummary(props: ToolBodySubProps & { input?: Record<string, unknown>; parts: readonly ContentPart[] }) {
  const resources = () => uniqueResourceEntries(compact([
    firstStringEntry(props.input, PATH_KEYS),
    ...props.parts.flatMap(part => part.kind === 'diff'
      ? compact([
          stringEntry(part, 'path'),
          stringEntry(part, 'oldPath'),
        ])
      : []),
  ]))
  const stats = () => diffStats(props.parts)
  return <Show when={resources().length > 0 || stats().changedFiles > 0}>
    <section class="tool-kind-summary tool-edit-summary" aria-label="编辑摘要">
      <div class="tool-kind-icon" aria-hidden="true">Δ</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">{resources().length > 1 ? `${resources().length} 个资源` : '资源变更'}</span>
        <For each={resources()}>{resource => <ResourceButton value={resource.value}
          target={classifyResourceTarget(resource.value, resource.key)} commands={props.commands} />}</For>
        <div class="tool-stat-row">
          <Show when={stats().additions > 0}><span class="tool-stat-add">+{stats().additions}</span></Show>
          <Show when={stats().deletions > 0}><span class="tool-stat-delete">−{stats().deletions}</span></Show>
          <Show when={stats().truncated}><span class="tool-chip">预览已截断</span></Show>
        </div>
      </div>
    </section>
  </Show>
}

function ExecuteSummary(props: ToolBodySubProps & { input?: Record<string, unknown> }) {
  const command = () => firstString(props.input, ['command', 'cmd', 'script'])
  const cwd = () => firstString(props.input, ['cwd', 'working_directory', 'workingDirectory', 'directory'])
  const env = () => props.input && isRecord(props.input.env) ? Object.keys(props.input.env).length : 0
  return <Show when={command() || cwd() || env() > 0}>
    <section class="tool-kind-summary tool-execute-summary" aria-label="执行命令">
      <div class="tool-kind-icon" aria-hidden="true">›_</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">终端命令</span>
        <Show when={command()}>{value => <div class="tool-command-line">
          <code>{value()}</code>
          <Show when={can(props.commands, 'clipboard.write')}>
            <button class="tool-inline-action" type="button" onClick={() => copy(props.commands, value())}>复制</button>
          </Show>
        </div>}</Show>
        <ChipList values={compact([cwd() ? `cwd · ${cwd()}` : undefined, env() > 0 ? `${env()} 个环境变量` : undefined])} />
      </div>
    </section>
  </Show>
}

function SearchFetchSummary(props: ToolBodySubProps & { kind: string; input?: Record<string, unknown> }) {
  const isFetch = () => props.kind === 'tool.fetch'
  const query = () => isFetch()
    ? firstString(props.input, ['url', 'uri', 'href'])
    : firstString(props.input, ['query', 'pattern', 'regex', 'search_term', 'searchTerm'])
  const scope = () => firstString(props.input, ['path', 'scope', 'directory', 'root', 'glob', 'include'])
  const method = () => firstString(props.input, ['method'])
  return <Show when={query() || scope() || method()}>
    <section class="tool-kind-summary tool-search-summary" aria-label={isFetch() ? '获取资源' : '搜索条件'}>
      <div class="tool-kind-icon" aria-hidden="true">{isFetch() ? '↗' : '⌕'}</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">{isFetch() ? '获取资源' : '搜索'}</span>
        <Show when={query()}>{value => isFetch()
          ? <ResourceButton value={value()} kind="uri" commands={props.commands} />
          : <span class="tool-query">{value()}</span>}</Show>
        <ChipList values={compact([method(), scope() ? `范围 · ${scope()}` : undefined])} />
      </div>
    </section>
  </Show>
}

function DelegateSummary(props: { input?: Record<string, unknown> }) {
  const goal = () => firstString(props.input, ['prompt', 'task', 'goal', 'objective', 'description', 'message'])
  const agent = () => firstString(props.input, ['agent', 'agent_name', 'agentName', 'agent_type', 'agentType', 'subagent_type', 'subagentType', 'role'])
  const model = () => firstString(props.input, ['model', 'model_id', 'modelId'])
  const background = () => firstBoolean(props.input, ['run_in_background', 'runInBackground', 'background', 'is_background'])
  return <Show when={goal() || agent() || model() || background() !== undefined}>
    <section class="tool-kind-summary tool-delegate-summary" aria-label="代理委派">
      <div class="tool-kind-icon" aria-hidden="true">⇢</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">代理委派</span>
        <Show when={goal()}>{value => <span class="tool-summary-copy">{value()}</span>}</Show>
        <ChipList values={compact([agent() ? `代理 · ${agent()}` : undefined, model() ? `模型 · ${model()}` : undefined, background() === true ? '后台运行' : background() === false ? '前台运行' : undefined])} />
      </div>
    </section>
  </Show>
}

function PlanSummary(props: { input?: Record<string, unknown> }) {
  const objective = () => firstString(props.input, ['objective', 'goal', 'content', 'description', 'title'])
  const status = () => firstString(props.input, ['status', 'state'])
  const items = () => firstArray(props.input, ['todos', 'tasks', 'items', 'entries', 'plan'])
  return <Show when={objective() || status() || items()}>
    <section class="tool-kind-summary tool-plan-summary" aria-label="计划与任务">
      <div class="tool-kind-icon" aria-hidden="true">☷</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">计划与任务</span>
        <Show when={objective()}>{value => <span class="tool-summary-copy">{value()}</span>}</Show>
        <ChipList values={compact([status(), items() ? `${items()!.length} 项` : undefined])} />
      </div>
    </section>
  </Show>
}

function SkillSummary(props: ToolBodySubProps & { input?: Record<string, unknown> }) {
  const name = () => firstString(props.input, ['skill', 'skill_name', 'skillName', 'name', 'query'])
  const path = () => firstString(props.input, ['path', 'skill_path', 'skillPath', 'file'])
  const operation = () => firstString(props.input, ['operation', 'action', 'command'])
  return <Show when={name() || path() || operation()}>
    <section class="tool-kind-summary tool-skill-summary" aria-label="Skill 调用">
      <div class="tool-kind-icon" aria-hidden="true">S</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">Skill</span>
        <Show when={name()}>{value => <span class="tool-summary-copy">{value()}</span>}</Show>
        <Show when={path()}>{value => <ResourceButton value={value()} kind="path" commands={props.commands} />}</Show>
        <ChipList values={compact([operation()])} />
      </div>
    </section>
  </Show>
}

function McpSummary(props: ToolBodySubProps & { input?: Record<string, unknown>; snapshot: ToolInvocationSnapshot }) {
  const identity = () => `${props.snapshot.canonicalName ?? ''} ${props.snapshot.name ?? ''}`
  const inferred = () => /^mcp__([^_]+)__(.+)$/i.exec((props.snapshot.canonicalName ?? props.snapshot.name ?? '').trim())
  const server = () => firstString(props.input, ['server', 'server_name', 'serverName']) ?? inferred()?.[1]
  const operation = () => firstString(props.input, ['tool', 'tool_name', 'toolName', 'operation', 'method']) ?? inferred()?.[2] ?? identity().trim()
  const resource = () => firstString(props.input, ['uri', 'url', 'resource', 'resource_uri', 'resourceUri'])
  return <Show when={server() || operation() || resource()}>
    <section class="tool-kind-summary tool-mcp-summary" aria-label="MCP 调用">
      <div class="tool-kind-icon" aria-hidden="true">M</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">MCP{server() ? ` · ${server()}` : ''}</span>
        <Show when={operation()}>{value => <span class="tool-summary-copy">{value()}</span>}</Show>
        <Show when={resource()}>{value => <ResourceButton value={value()} kind="uri" commands={props.commands} />}</Show>
      </div>
    </section>
  </Show>
}

function BrowserSummary(props: ToolBodySubProps & { input?: Record<string, unknown>; action?: string }) {
  const url = () => firstString(props.input, ['url', 'uri', 'href'])
  const target = () => firstString(props.input, ['selector', 'ref', 'element', 'target', 'label', 'text'])
  const operation = () => props.action || firstString(props.input, ['action', 'operation', 'method'])
  const tab = () => firstString(props.input, ['tab_id', 'tabId', 'page_id', 'pageId'])
  return <Show when={url() || target() || operation() || tab()}>
    <section class="tool-kind-summary tool-browser-summary" aria-label="浏览器操作">
      <div class="tool-kind-icon" aria-hidden="true">◇</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">浏览器操作</span>
        <Show when={url()}>{value => <ResourceButton value={value()} kind="uri" commands={props.commands} />}</Show>
        <Show when={target()}>{value => <span class="tool-summary-copy">{value()}</span>}</Show>
        <ChipList values={compact([operation(), tab() ? `标签 · ${tab()}` : undefined])} />
      </div>
    </section>
  </Show>
}

function ArtifactSummary(props: ToolBodySubProps & { input?: Record<string, unknown> }) {
  const title = () => firstString(props.input, ['title', 'name', 'artifact_name', 'artifactName'])
  const resource = () => firstStringEntry(props.input, PATH_KEYS)
  const path = () => resource()?.value
  const type = () => firstString(props.input, ['type', 'artifact_type', 'artifactType', 'format', 'mimeType'])
  return <Show when={title() || path() || type()}>
    <section class="tool-kind-summary tool-artifact-summary" aria-label="产物操作">
      <div class="tool-kind-icon" aria-hidden="true">A</div>
      <div class="tool-kind-primary">
        <span class="tool-kind-eyebrow">Artifact</span>
        <Show when={title()}>{value => <span class="tool-summary-copy">{value()}</span>}</Show>
        <Show when={resource()}>{value => <ResourceButton value={value().value}
          target={classifyResourceTarget(value().value, value().key)} commands={props.commands} />}</Show>
        <ChipList values={compact([type()])} />
      </div>
    </section>
  </Show>
}

function ProgressSection(props: ToolBodySubProps & { value: unknown }) {
  const record = () => isRecord(props.value) ? props.value : undefined
  const completed = () => firstFinite(record(), ['completed', 'current', 'done', 'value'])
  const total = () => firstFinite(record(), ['total', 'maximum', 'max'])
  const percent = () => completed() !== undefined && total() !== undefined && total()! > 0
    ? Math.max(0, Math.min(100, completed()! / total()! * 100))
    : undefined
  const message = () => firstString(record(), ['message', 'label', 'status', 'detail'])
  return <section class="tool-rich-section tool-progress-section" aria-label="工具进度">
    <div class="tool-progress-heading">
      <span>{message() ?? '进行中'}</span>
      <Show when={percent() !== undefined}><span>{Math.round(percent()!)}%</span></Show>
    </div>
    <Show when={percent() !== undefined}>
      <div class="tool-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(percent()!)}>
        <span style={{ width: `${percent()}%` }} />
      </div>
    </Show>
    <Show when={!record() || (!message() && percent() === undefined)}>
      <ToolObjectInspector value={props.value} commands={props.commands} />
    </Show>
  </section>
}

function LocationsSection(props: ToolBodySubProps & { value: unknown }) {
  const locations = () => collectLocations(props.value)
  return <section class="solid-tool-locations tool-rich-section" aria-label="相关位置">
    <SectionHeading label="位置" count={locations().length || undefined} />
    <Show when={locations().length > 0} fallback={<ToolObjectInspector value={props.value} commands={props.commands} />}>
      <div class="tool-location-list">
        <For each={locations()}>{location => <button class="tool-location" type="button"
          disabled={!can(props.commands, 'resource.open')}
          onClick={() => openTarget(props.commands, location.target)}>
          <span>{location.label}</span>
          <Show when={location.range}><small>{location.range}</small></Show>
        </button>}</For>
      </div>
    </Show>
  </section>
}

function SectionHeading(props: { label: string; count?: number }) {
  return <div class="tool-section-heading">
    <span class="term-tool-label">{props.label}</span>
    <Show when={props.count !== undefined}><span class="tool-section-count">{props.count}</span></Show>
  </div>
}

function ChipList(props: { values: readonly string[] }) {
  return <Show when={props.values.length > 0}><div class="tool-chip-list">
    <For each={props.values}>{value => <span class="tool-chip">{value}</span>}</For>
  </div></Show>
}

function ResourceButton(props: ToolBodySubProps & { value: string; kind?: 'path' | 'uri'; target?: RenderResourceTarget }) {
  return <button class="tool-resource-primary" type="button" title={props.value}
    disabled={!can(props.commands, 'resource.open')}
    onClick={() => openTarget(props.commands, props.target ?? classifyResourceTarget(props.value, props.kind))}>
    {props.value}
  </button>
}

function effectiveKind(renderKind: string, snapshot: ToolInvocationSnapshot): string {
  const action = snapshot.action?.trim().toLowerCase()
  const capabilities = Array.isArray(snapshot.capabilities)
    ? snapshot.capabilities.filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase())
    : []
  const identity = `${snapshot.canonicalName ?? ''} ${snapshot.name ?? ''} ${snapshot.title ?? ''}`.toLowerCase()
  if (action === 'delegate' || /\b(agent|subagent|delegate|delegation|team)\b/.test(identity)) return 'tool.delegate'
  if (action === 'plan' || /\b(todo|plan|task|goal)\b/.test(identity)) return 'tool.plan'
  if (action === 'skill' || /\bskill\b/.test(identity)) return 'tool.skill'
  if (capabilities.includes('mcp') || /(?:^|\s)mcp__|\breadmcpresource\b|\bmcp resource\b/.test(identity)) return 'tool.mcp'
  if (['navigate', 'click', 'type', 'snapshot'].includes(action ?? '') || /\b(browser|chrome|playwright|computer.?use)\b/.test(identity)) return 'tool.browser'
  if (/(?:^|[\s_.-])artifact(?:$|[\s_.-])/.test(identity)) return 'tool.artifact'
  const semantic = snapshot.semanticKind
  if (semantic && ['tool.read', 'tool.edit', 'tool.execute', 'tool.search', 'tool.fetch'].includes(semantic)) return semantic
  if (['tool.read', 'tool.edit', 'tool.execute', 'tool.search', 'tool.fetch'].includes(renderKind)) return renderKind
  const semanticIdentity = `${identity} ${action ?? ''}`
  if (/\b(read|read_file|view|cat)\b/.test(semanticIdentity)) return 'tool.read'
  if (/\b(edit|write|patch|replace)\b/.test(semanticIdentity)) return 'tool.edit'
  if (/\b(bash|shell|powershell|execute|exec|terminal|command)\b/.test(semanticIdentity)) return 'tool.execute'
  if (/\b(fetch|webfetch|download|http)\b/.test(semanticIdentity)) return 'tool.fetch'
  if (/\b(search|grep|glob|find|websearch)\b/.test(semanticIdentity)) return 'tool.search'
  return renderKind
}

function showcasedInputKeys(kind: string): readonly string[] {
  if (kind === 'tool.read') return [...PATH_KEYS, 'encoding', 'charset', 'limit', 'line_count', 'lineCount', 'line', 'start_line', 'startLine', 'end_line', 'endLine', 'offset']
  if (kind === 'tool.edit') return [...PATH_KEYS]
  if (kind === 'tool.execute') return ['command', 'cmd', 'script', 'cwd', 'working_directory', 'workingDirectory', 'directory', 'env']
  if (kind === 'tool.search') return ['query', 'pattern', 'regex', 'search_term', 'searchTerm', 'path', 'scope', 'directory', 'root', 'glob', 'include']
  if (kind === 'tool.fetch') return ['url', 'uri', 'href', 'method', 'path', 'scope']
  if (kind === 'tool.delegate') return ['prompt', 'task', 'goal', 'objective', 'description', 'message', 'agent', 'agent_name', 'agentName', 'agent_type', 'agentType', 'subagent_type', 'subagentType', 'role', 'model', 'model_id', 'modelId', 'run_in_background', 'runInBackground', 'background', 'is_background']
  if (kind === 'tool.plan') return ['objective', 'goal', 'content', 'description', 'title', 'status', 'state']
  if (kind === 'tool.skill') return ['skill', 'skill_name', 'skillName', 'name', 'query', 'path', 'skill_path', 'skillPath', 'file', 'operation', 'action', 'command']
  if (kind === 'tool.mcp') return ['server', 'server_name', 'serverName', 'tool', 'tool_name', 'toolName', 'operation', 'method', 'uri', 'url', 'resource', 'resource_uri', 'resourceUri']
  if (kind === 'tool.browser') return ['url', 'uri', 'href', 'selector', 'ref', 'element', 'target', 'label', 'action', 'operation', 'method', 'tab_id', 'tabId', 'page_id', 'pageId']
  if (kind === 'tool.artifact') return ['title', 'name', 'artifact_name', 'artifactName', ...PATH_KEYS, 'type', 'artifact_type', 'artifactType', 'format', 'mimeType']
  return []
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target_path', 'targetPath', 'uri'] as const

function rangeLabel(input: Record<string, unknown> | undefined): string | undefined {
  const start = firstFinite(input, ['line', 'start_line', 'startLine', 'offset'])
  const end = firstFinite(input, ['end_line', 'endLine'])
  if (start === undefined) return undefined
  return end !== undefined ? `行 ${start}–${end}` : `从第 ${start} 行`
}

function diffStats(parts: readonly ContentPart[]): { additions: number; deletions: number; changedFiles: number; truncated: boolean } {
  let additions = 0
  let deletions = 0
  let changedFiles = 0
  let truncated = false
  for (const part of parts) {
    if (part.kind !== 'diff') continue
    changedFiles += 1
    // SAFETY: 已由 part.kind !== 'diff' 收窄到 diff part；读取其附加字段需开放索引视图。
    const record = part as unknown as Record<string, unknown>
    const lines = Array.isArray(record.lines) ? record.lines : []
    additions += finiteValue(record.additions) ?? lines.filter(line => isRecord(line) && line.kind === 'added').length
    deletions += finiteValue(record.deletions) ?? lines.filter(line => isRecord(line) && line.kind === 'removed').length
    truncated ||= record.truncated === true
  }
  return { additions, deletions, changedFiles, truncated }
}

function collectLocations(value: unknown): readonly { label: string; range?: string; target: RenderResourceTarget }[] {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [{ label: item, target: pathOrUriTarget(item) }]
    if (!isRecord(item)) return []
    const resource = firstStringEntry(item, ['path', 'file', 'uri', 'url', 'source'])
    if (!resource) return []
    const line = firstFinite(item, ['line', 'startLine', 'start_line'])
    const column = firstFinite(item, ['column', 'character'])
    const endLine = firstFinite(item, ['endLine', 'end_line'])
    const range = line === undefined ? undefined : endLine === undefined ? `L${line}` : `L${line}–${endLine}`
    const target = classifyResourceTarget(resource.value, resource.key, resourceRange(line, column))
    return [{ label: resource.value, ...(range ? { range } : {}), target }]
  })
}

function firstLocationPath(value: unknown): string | undefined {
  return collectLocations(value)[0]?.label
}

function firstLocationTarget(value: unknown): RenderResourceTarget | undefined {
  return collectLocations(value)[0]?.target
}

function pathOrUriTarget(value: string): { path: string } | { uri: string } {
  return classifyResourceTarget(value)
}

function omitRecordKeys(value: unknown, keys: readonly string[]): unknown {
  if (!isRecord(value) || keys.length === 0) return value
  const omitted = new Set(keys)
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)))
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function firstStringEntry(record: Record<string, unknown> | undefined, keys: readonly string[]): { key: string; value: string } | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return { key, value }
  }
  return undefined
}

function firstFinite(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = finiteValue(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function firstBoolean(record: Record<string, unknown> | undefined, keys: readonly string[]): boolean | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function firstArray(record: Record<string, unknown> | undefined, keys: readonly string[]): readonly unknown[] | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return undefined
}

function finiteValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
}

function stringEntry(value: unknown, key: string): { key: string; value: string } | undefined {
  const field = stringField(value, key)
  return field?.trim() ? { key, value: field } : undefined
}

function labelledValue(label: string, value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : `${label} · ${value}`
}

function compact<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined)
}

function uniqueResourceEntries(values: readonly { key: string; value: string }[]): { key: string; value: string }[] {
  const seen = new Set<string>()
  return values.filter(entry => {
    const target = classifyResourceTarget(entry.value, entry.key)
    const identity = 'uri' in target ? `uri:${target.uri}` : `path:${target.path}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function safeDisplayValue(value: unknown): unknown {
  return createUnknownContentPart('tool.output', value, { maxRawBytes: 32 * 1024 }).raw
}

function can(commands: RenderCommandPort | undefined, type: string): boolean {
  return commands?.canExecute?.(type) === true
}

function openTarget(commands: RenderCommandPort | undefined, target: unknown): void {
  if (!can(commands, 'resource.open')) return
  void commands?.execute({ type: 'resource.open', payload: target })
}

function copy(commands: RenderCommandPort | undefined, text: string): void {
  if (!can(commands, 'clipboard.write')) return
  void commands?.execute({ type: 'clipboard.write', payload: { text } })
}
