/**
 * demoData — 浏览器模式静态演示数据（纯 builder，零 window/localStorage，node 可测）。
 *
 * 供应两个消费方：mockTauri（invoke 命令的 mock 响应）与 seed（store/localStorage 种入）。
 * 演示叙事：Peri 前端重构 / Hermes 部署检查 / GM 世界观 / 日志排障 四条会话 +
 * 归档存档 + gateway/runtime/git/workspace 数据。
 */
import type { Session } from '../domains/identity/identityStore.ts'
import type { Message } from '../domains/chat/messageTypes.ts'
import type { WorkspaceBackendEntry } from '../infrastructure/tauri/workspaceContracts.ts'
import type { RuntimeLogEntry } from '../domains/runtime/runtimeLogs.ts'
import type { GatewayStatus, GatewayRoute } from '../infrastructure/tauri/gatewayContracts.ts'
import type { GitStatusEntry, GitCommit } from '../infrastructure/tauri/gitContracts.ts'
import type { SessionResponseObject } from '../infrastructure/acp/chatContracts.ts'

const DAY = 86_400_000
const now = Date.now()

// ── agents ────────────────────────────────────────────────────────────────

export interface DemoAgent {
  id: string
  name: string
  configActivationState: 'activated'
}

export function buildDemoAgents(): DemoAgent[] {
  return [
    { id: 'peri', name: 'Peri', configActivationState: 'activated' },
    { id: 'hermes', name: 'Hermes', configActivationState: 'activated' },
    { id: 'claude', name: 'Claude Code', configActivationState: 'activated' },
    { id: 'pi', name: 'Pi', configActivationState: 'activated' },
    { id: 'gm', name: 'GM', configActivationState: 'activated' },
  ]
}

// ── sessions（4 条演示会话）───────────────────────────────────────────────

export function buildDemoSessions(): Session[] {
  return [
    {
      id: 'demo-fe', agentId: 'peri', periId: 'peri-demo-1', name: '前端重构', source: 'local:demo-fe',
      profileId: 'default', createdAt: now - 3 * DAY, lastActiveAt: now - 3_600_000,
      platform: 'qq', workdir: '/path/to/project', workspaceId: 'w-pylon', sessionPrompt: '', skills: [], hooks: [], autoName: '前端重构',
    },
    {
      id: 'demo-hermes', agentId: 'hermes', periId: 'peri-demo-2', name: 'Hermes 部署检查', source: 'local:demo-hermes',
      profileId: 'default', createdAt: now - 2 * DAY, lastActiveAt: now - 7_200_000,
      platform: 'webhook', workdir: '/path/to/ops', workspaceId: 'w-operations', sessionPrompt: '', skills: [], hooks: [], autoName: 'Hermes 部署检查',
    },
    {
      id: 'demo-serina', agentId: 'gm', periId: 'peri-demo-3', name: '世界观设定', source: 'local:demo-serina',
      profileId: 'local', createdAt: now - DAY, lastActiveAt: now - 10_800_000,
      platform: 'web', workdir: '/path/to/worldbook', workspaceId: 'w-worldbook', sessionPrompt: '', skills: [], hooks: [], autoName: '世界观设定',
    },
    {
      id: 'demo-shell', agentId: 'peri', periId: 'peri-demo-4', name: '日志排障', source: 'local:demo-shell',
      profileId: 'default', createdAt: now - 6 * 3_600_000, lastActiveAt: now - 1_800_000,
      platform: 'qq', workdir: '/path/to/project', workspaceId: 'w-pylon', sessionPrompt: '', skills: [], hooks: [], autoName: '日志排障',
    },
  ]
}

// ── 每会话独立富对话（id 以 -<seq> 结尾；tool id 以 tool- 开头供 toolIdFromMessage）──

function reasoning(text: string, seq: number, extra?: Partial<Message>): Message {
  return { id: `thought-${seq}`, role: 'reasoning', sender: 'peri', content: text, time: '11:02', thoughtStartedAt: now - 60_000, thoughtDurationMs: 4000, ...extra }
}
function toolMsg(seq: number, toolName: string, toolKind: string, toolStatus: string, toolInput: string, toolOutput: string, extra?: Partial<Message>): Message {
  return { id: `tool-${seq}`, role: 'tool', sender: 'peri', content: '', time: '11:03', toolName, toolKind, toolStatus, toolInput, toolOutput, toolOutputLines: toolOutput.split('\n').length, ...extra }
}
function assistant(text: string, seq: number, extra?: Partial<Message>): Message {
  return { id: `msg-${seq}`, role: 'assistant', sender: 'peri', content: text, time: '11:04', ...extra }
}
function userMsg(text: string, seq: number): Message {
  return { id: `user-${seq}`, role: 'user', sender: 'local:demo', content: text, time: '11:01' }
}

// diffPayloadFromObject 从块上读 oldText/newText（camel/snake 兜底）→ DiffCard payload
const DIFF_BLOCK = {
  type: 'tool_diff_content',
  title: 'AgentSheetView.tsx',
  oldText: '        <ControlCenter sessionId={ctx.activeSession} />\n',
  newText: '        {isReplay ? <ReplayContinueBar /> : <ControlCenter sessionId={ctx.activeSession} />}\n',
}

const ANSI_BUILD = '\u001b[32m✓\u001b[0m 161 modules transformed\n\u001b[33m! package.json:5:1\u001b[0m 警告：scripts.build 未排序\n\u001b[2m  dist/\u001b[0m 4.2 MiB / gzip 1.1 MiB\n\u001b[36m▲ 构建完成，耗时 2.4s\u001b[0m'

export function buildDemoMessages(sessionId: string): Message[] {
  switch (sessionId) {
    case 'demo-hermes':
      return [
        userMsg('帮我检查 Hermes 的部署状态，看看上次发布有没有异常。', 0),
        reasoning('用户要求检查部署状态。优先看服务健康接口和最近发布记录，再查 nginx 错误日志里有没有 5xx 堆积。', 1),
        toolMsg(2, 'execute', 'execute', 'completed', '{ command: "curl -s localhost:8080/healthz" }', '{ "status": "ok", "version": "2.4.1", "uptime": "36h" }'),
        toolMsg(3, 'grep', 'search', 'completed', '{ pattern: "5xx|error", path: "/var/log/nginx/access.log" }', '10.0.0.8 - - [08:42] "GET /api" 502  - 12ms\n10.0.0.8 - - [08:42] "GET /api" 502  - 11ms\n10.0.0.8 - - [08:43] "POST /api" 500  - 90ms'),
        reasoning('发现 08:42 前后出现连续 502/500，集中在 /api 前缀。怀疑是发布窗口期上游重启导致的短时不可用，需要确认时间窗口与发布记录是否重叠。', 5),
        assistant('检查结果：服务本身健康（`/healthz` ok），但 **08:42–08:43 有 3 个 5xx**，都指向 `/api`。\n\n| 指标 | 值 |\n|---|---|\n| 健康检查 | ok · v2.4.1 |\n| 5xx 计数 | 3（08:42–08:43） |\n| 根因 | 发布窗口上游重启 |\n\n建议：发布时给网关加 5s 的平滑摘流窗口，避免 502 落入访问日志。', 6),
        userMsg('好，那就加一个摘流窗口，顺便把日志级别调到 warn 以上。', 7),
      ]
    case 'demo-serina':
      return [
        userMsg('帮我把「雾霭群岛」的世界观扩充一下：需要主要势力、地理分区和一件传说物品。', 0),
        reasoning('扩写世界观要贴合已有基调：低魔、航海贸易、岛与雾。势力写成互相制衡的三方，地理分区沿航线展开，传说物品给一件与「雾」绑定、有叙事钩子的物件。', 1),
        assistant('## 雾霭群岛\n\n**基调**：低魔航海贸易，群岛常年笼罩可航行的浓雾，雾中航道由「雾灯会」维护。\n\n### 主要势力\n\n- **雾灯会**：垄断灯塔与航道勘测，表面中立，实则把持商路税。\n- **灰帆议会**：群岛南部海盗联合，奉行「抢来的船不沉」信条。\n- **晨潮教团**：信仰雾之圣女，主张雾是世界的记忆，反对一切测深与拓图。\n\n### 地理分区\n\n| 区域 | 特征 |\n|---|---|\n| 核心岛链 | 商会总部，灯塔最密 |\n| 南部碎礁 | 灰帆地盘，暗礁与走私港 |\n| 极北雾墙 | 无人可越，教团称其为「圣墙」 |\n\n### 传说物品\n\n**潮汐罗盘**：指针不指北，而指向「最近一场未结束的约定」。持有者永远知道谁在等他——也永远被同样的人追踪。', 2),
        userMsg('很棒，把晨潮教团和潮汐罗盘串一条支线任务，适合冒险者第一章。', 3),
        reasoning('支线要能当第一章钩子：教团与罗盘的冲突天然制造目标冲突，玩家借罗盘找失踪商队，教团追来夺盘，雾墙内另有真相。给一个三段式任务骨架。', 4),
        assistant('**支线：雾中归约**\n\n1. **启程**：晨潮教团悬赏找回失窃的潮汐罗盘，悬赏人称罗盘指向雾墙内失踪的商队。\n2. **追逐**：雾灯会暗中扣下冒险者船证——他们不愿教团涉足航道；灰帆议员则开出「护送费减半」条件换罗盘航线图。\n3. **真相**：雾墙内是旧纪元沉没的灯城，商队并未失踪，而是找到了「雾的记忆」并自愿留下。罗盘的约定对象是整座城市。\n\n结局奖励：罗盘升级为「约定的指南针」，可指定一人成为你的「被寻者」。', 5),
      ]
    case 'demo-shell':
      return [
        userMsg('App 启动后白屏，控制台只有一条报错。帮我查一下。', 0),
        reasoning('白屏 + 单条报错，优先怀疑渲染期崩溃而非逻辑错误。先看运行时日志里的 error 级记录和最近一次崩溃上下文。', 1),
        toolMsg(2, 'read', 'read', 'completed', '{ path: "runtime/logs/2026-08-06.log" }', '[08:31:02] INFO  app: 启动完成\n[08:31:03] ERROR app: TypeError: Cannot read properties of null (reading \'map\')\n[08:31:03] ERROR app:     at renderMessages (ChatView.tsx:118)\n[08:31:03] FATAL app: 渲染器退出，已回退空态'),
        toolMsg(3, 'execute', 'execute', 'failed', '{ command: "grep -rn \'messages?.map\' src" }', 'src/components/chat/ChatView.tsx:118:  return messages?.map(m => <Row key={m.id} />)\n退出码 1：该行实为 messages.map，无空值守卫'),
        reasoning('错误发生在 renderMessages，且崩溃点正是消息数组为空时的 map。结合「渲染器退出已回退空态」，根因应是 session 恢复缓存为空数组时直接 map。修复：入口加空数组守卫。', 5),
        assistant('根因：`ChatView.tsx:118` 对消息数组直接 `map`，会话恢复缓存为空时崩溃。\n\n```ts\n// 修复前\nreturn messages.map(m => <Row key={m.id} />)\n// 修复后\nreturn (messages ?? []).map(m => <Row key={m.id} />)\n```\n\n已同时给 `useSessionLifecycle` 的恢复路径加了空数组守卫，复现用例通过。', 6),
      ]
    default: // demo-fe 前端重构
      return [
        userMsg('把 AgentSheetView 里的回放姿态接线接完，然后跑一遍构建确认没有类型错误。', 0),
        reasoning('回放姿态（W4-02）已拍板姿态二：历史行进入 agent sheet 时只读，点击占位条转 live。需要改 AgentSheetView 的输入面门控，并把占位条组件抽出来复用。', 1),
        toolMsg(2, 'read', 'read', 'completed', '{ path: "src/sheets/AgentSheetView.tsx" }', 'import ChatView from "../domains/chat/ChatView"\nimport ControlCenter from "../components/ControlCenter"\nexport default function AgentSheetView({ ctx }) {\n  return (\n    <div className="main">\n      <ChatView sessionId={ctx.activeSession} />\n      <ControlCenter sessionId={ctx.activeSession} />\n    </div>\n  )\n}'),
        reasoning('当前主区无条件渲染 ControlCenter。方案：引入只读姿态 store，姿态激活时隐藏 ControlCenter、渲染占位条；点击占位条 clear 姿态即转 live。', 3),
        toolMsg(4, 'bash', 'execute', 'completed', '{ command: "npx tsc --noEmit" }', ANSI_BUILD),
        toolMsg(5, 'write', 'write', 'completed', '{ path: "src/sheets/AgentSheetView.tsx" }', '已写入回放姿态门控 + 占位条', {
          contentBlocks: [DIFF_BLOCK],
        }),
        reasoning('构建绿、diff 已生成。顺手确认一下改动面没有波及 ChatView 本身（方案 B 否决，只锁输入面）。', 7),
        assistant('完成。改动集中在 `AgentSheetView`：\n\n- 姿态激活时隐藏 `ControlCenter`（无 send/attach/cancel 路径），渲染「只读回放 · 点击继续」占位条\n- 点击占位条 `clear()` 姿态转 live\n- 离开该会话自动清姿态\n\n```ts\n{isReplay ? <ReplayContinueBar /> : <ControlCenter sessionId={ctx.activeSession} />}\n```\n\n`npx tsc --noEmit` 通过，回放行为回归全绿。', 8),
      ]
  }
}

// ── 平台会话（gateway_sessions，Phase 2）────────────────────────────────

export function buildPlatformSessions() {
  return [
    { agentId: 'peri', source: 'qq:user:demo-user', periId: 'peri-demo-1', title: '平台会话', model: 'deepseek-v4-flash', mode: 'auto', updatedAt: String(Date.now()), reset: 'daily', allowFrom: ['demo-user'], idleMinutes: 60 },
    { agentId: 'gm', source: 'qq:group:8080', periId: 'peri-demo-3', title: '战役群', model: 'deepseek-v4-flash', mode: null, updatedAt: String(Date.now() - 3600_000), reset: 'off', allowFrom: null, idleMinutes: null },
  ]
}

// ── history 列表（list_persisted_sessions）───────────────────────────────

export function buildSessionSummaries(): Array<{ id: string; source?: string; title?: string; periId?: string; updatedAt: number }> {
  return [
    ...buildDemoSessions().map(session => ({
      id: session.id,
      source: session.source,
      title: session.name,
      periId: session.periId,
      updatedAt: session.lastActiveAt,
    })),
    { id: 'arch-1', source: 'local:arch-gateway', title: '旧版网关迁移', periId: 'peri-arch-1', updatedAt: now - 20 * DAY },
    { id: 'arch-2', source: 'local:arch-build', title: '构建提速调研', periId: 'peri-arch-2', updatedAt: now - 32 * DAY },
  ]
}

// ── gateway（gateway_status）─────────────────────────────────────────────

export function buildGatewayStatus(): GatewayStatus {
  const routes: GatewayRoute[] = [
    { source: 'qq:user:demo-user', agentId: 'peri', allowFrom: ['demo-user'], reset: 'daily', idleMinutes: 30 },
    { source: 'qq:group:8080', agentId: 'gm', reset: 'off' },
    { source: 'qq:user:0a1b', agentId: 'hermes', sessionKey: 'ops', reset: 'idle', idleMinutes: 60 },
  ]
  return {
    adapters: ['qq', 'telegram', 'webhook'],
    routes,
    qq: { groupAllowFrom: ['only-allowed'] },
    inject: { enabled: true, scenario: 'workspace-review', sources: ['qq:user:demo-user'], persist: 'off' },
  }
}

// ── runtime 日志（list_runtime_logs）─────────────────────────────────────

export function buildRuntimeLogs(): RuntimeLogEntry[] {
  const t = now - 90_000
  const entries: Array<[number, string, string, string]> = [
    [41, 'info', 'gateway', 'QQ 适配器已连接（ws://localhost:8080/ws）'],
    [42, 'info', 'gateway', '路由表加载：3 条路由生效'],
    [43, 'warn', 'prism', 'Prism 管理端未连接，命令注入降级为只读'],
    [44, 'info', 'agents', 'Peri 会话创建成功（peri-demo-1）'],
    [45, 'error', 'gateway', 'Telegram 适配器心跳超时，3s 后重连'],
    [46, 'info', 'gateway', 'Telegram 适配器重连成功'],
    [47, 'info', 'agents', 'Hermes 会话恢复（peri-demo-2）'],
    [48, 'warn', 'runtime', 'list_runtime_logs 返回 48 条（上限 500）'],
  ]
  return entries.map(([id, level, source, message], index) => ({
    id,
    timestamp: t + index * 5000,
    level,
    source,
    message,
    fields: index === 5 ? { retries: '2', took: '40ms' } : undefined,
  }))
}

export function buildStartupDiagnostics() {
  return {
    agentConfig: { status: 'ok', message: 'agents.yaml 已加载（2 个 agent）' },
    gatewayConfig: { status: 'ok', message: 'gateway.yaml 已加载' },
    prism: { status: 'warn', message: 'Prism 管理端未连接' },
    defaultAgentId: 'peri',
    configSource: { kind: 'file', fileName: 'agents.yaml' },
  }
}

// ── git（git_status / git_history / git_diff）────────────────────────────

export function buildGitStatus(): GitStatusEntry[] {
  return [
    { path: 'src/sheets/AgentSheetView.tsx', status: 'M', staged: false },
    { path: 'src/App.tsx', status: 'M', staged: true },
    { path: 'src/demo/', status: '??', staged: false },
    { path: 'docs/施工日志.md', status: 'M', staged: false },
    { path: 'src/domains/theme/themeCssSnapshot.ts', status: 'M', staged: false },
    { path: 'src/plugins/core/renderer/builtinPresentationProfiles.ts', status: 'A', staged: true },
    { path: 'src/legacy/removed-theme.ts', status: 'D', staged: false },
    { path: 'src/components/SettingsOld.tsx → src/components/settings/LegacySettings.tsx', status: 'R', staged: true },
    { path: 'tests/visual/material-contract.spec.ts', status: '??', staged: false },
    { path: 'assets/brand/pylon-node-grid.svg', status: 'A', staged: false },
  ]
}

/** ISSUE-15 W4：git_status_with_branch demo 响应（branch + entries，GitPanel 真实分支展示）。 */
export function buildGitStatusWithBranch(): { branch: { branch: string; detached: boolean; head: string }; entries: GitStatusEntry[] } {
  return {
    branch: { branch: 'demo', detached: false, head: 'ac82de4' },
    entries: buildGitStatus(),
  }
}

export function buildGitHistory(): GitCommit[] {
  return [
    { hash: 'ac82de4', author: 'deepseek', date: Math.floor(now / 1000) - 3_600, subject: 'feat(frontend): W4-02 接入只读回放视图' },
    { hash: 'a9a2252', author: 'deepseek', date: Math.floor(now / 1000) - 86_400, subject: 'feat(frontend): W4-04 接入真实 CDP 会话与持久 profile' },
    { hash: '235acda', author: 'deepseek', date: Math.floor(now / 1000) - 172_800, subject: 'feat(frontend): W4-03 建立 browser 前端状态机与命令契约壳' },
    { hash: '9bd45ac', author: 'dev', date: Math.floor(now / 1000) - 259_200, subject: 'feat(visual): establish Pylon material and brand node tokens' },
    { hash: '715d2e9', author: 'Claude', date: Math.floor(now / 1000) - 345_600, subject: 'refactor(plugin): isolate settings page contributions' },
    { hash: '4c610ea', author: 'Peri', date: Math.floor(now / 1000) - 432_000, subject: 'fix(workspace): persist workspace tree and session ownership' },
    { hash: '11ca8b2', author: 'Pi', date: Math.floor(now / 1000) - 518_400, subject: 'test(renderer): add long markdown and tool-state fixtures' },
    { hash: 'f0937da', author: 'Hermes', date: Math.floor(now / 1000) - 604_800, subject: 'chore(runtime): harden ACP runtime candidate probing' },
  ]
}

export function buildGitDiff(): string {
  return 'diff --git a/src/sheets/AgentSheetView.tsx b/src/sheets/AgentSheetView.tsx\n' +
    'index 1a2b3c4..5d6e7f8 100644\n' +
    '--- a/src/sheets/AgentSheetView.tsx\n' +
    '+++ b/src/sheets/AgentSheetView.tsx\n' +
    '@@ -21,7 +21,7 @@ export default function AgentSheetView({ ctx }) {\n' +
    '         <ChatView sessionId={ctx.activeSession} />\n' +
    '-        <ControlCenter sessionId={ctx.activeSession} />\n' +
    '+        {isReplay ? <ReplayContinueBar /> : <ControlCenter sessionId={ctx.activeSession} />}\n' +
    '       </div>\n'
}

// ── workspace 文件树（list_workspace_entries / read_workspace_text）──────

const WORKSPACE_TREE: Record<string, WorkspaceBackendEntry[]> = {
  '': [
    { name: '.github', relativePath: '.github', kind: 'directory' },
    { name: 'apps', relativePath: 'apps', kind: 'directory' },
    { name: 'assets', relativePath: 'assets', kind: 'directory' },
    { name: 'src', relativePath: 'src', kind: 'directory' },
    { name: 'docs', relativePath: 'docs', kind: 'directory' },
    { name: 'examples', relativePath: 'examples', kind: 'directory' },
    { name: 'scripts', relativePath: 'scripts', kind: 'directory' },
    { name: 'tests', relativePath: 'tests', kind: 'directory' },
    { name: '.editorconfig', relativePath: '.editorconfig', kind: 'file' },
    { name: '.gitignore', relativePath: '.gitignore', kind: 'file' },
    { name: 'package.json', relativePath: 'package.json', kind: 'file' },
    { name: 'pnpm-lock.yaml', relativePath: 'pnpm-lock.yaml', kind: 'file' },
    { name: 'README.md', relativePath: 'README.md', kind: 'file' },
    { name: 'tsconfig.json', relativePath: 'tsconfig.json', kind: 'file' },
    { name: 'vite.config.ts', relativePath: 'vite.config.ts', kind: 'file' },
  ],
  src: [
    { name: 'App.tsx', relativePath: 'src/App.tsx', kind: 'file' },
    { name: 'application', relativePath: 'src/application', kind: 'directory' },
    { name: 'assets', relativePath: 'src/assets', kind: 'directory' },
    { name: 'demo', relativePath: 'src/demo', kind: 'directory' },
    { name: 'sheets', relativePath: 'src/sheets', kind: 'directory' },
    { name: 'components', relativePath: 'src/components', kind: 'directory' },
    { name: 'domains', relativePath: 'src/domains', kind: 'directory' },
    { name: 'infrastructure', relativePath: 'src/infrastructure', kind: 'directory' },
    { name: 'plugin-runtime', relativePath: 'src/plugin-runtime', kind: 'directory' },
    { name: 'plugins', relativePath: 'src/plugins', kind: 'directory' },
    { name: 'renderers', relativePath: 'src/renderers', kind: 'directory' },
    { name: 'workspace-sheets', relativePath: 'src/workspace-sheets', kind: 'directory' },
    { name: 'index.css', relativePath: 'src/index.css', kind: 'file' },
    { name: 'main.tsx', relativePath: 'src/main.tsx', kind: 'file' },
  ],
  '.github': [
    { name: 'workflows', relativePath: '.github/workflows', kind: 'directory' },
    { name: 'CONTRIBUTING.md', relativePath: '.github/CONTRIBUTING.md', kind: 'file' },
  ],
  '.github/workflows': [
    { name: 'ci.yml', relativePath: '.github/workflows/ci.yml', kind: 'file' },
    { name: 'release.yml', relativePath: '.github/workflows/release.yml', kind: 'file' },
  ],
  apps: [
    { name: 'desktop', relativePath: 'apps/desktop', kind: 'directory' },
    { name: 'cli', relativePath: 'apps/cli', kind: 'directory' },
  ],
  assets: [
    { name: 'brand', relativePath: 'assets/brand', kind: 'directory' },
    { name: 'presentations', relativePath: 'assets/presentations', kind: 'directory' },
  ],
  'assets/brand': [
    { name: 'pylon-mark.svg', relativePath: 'assets/brand/pylon-mark.svg', kind: 'file' },
    { name: 'pylon-node-grid.svg', relativePath: 'assets/brand/pylon-node-grid.svg', kind: 'file' },
    { name: 'brand-guidelines.md', relativePath: 'assets/brand/brand-guidelines.md', kind: 'file' },
  ],
  'src/sheets': [
    { name: 'AgentSheetView.solid.tsx', relativePath: 'src/sheets/AgentSheetView.solid.tsx', kind: 'file' },
    { name: 'OverviewSheetView.tsx', relativePath: 'src/sheets/OverviewSheetView.tsx', kind: 'file' },
    { name: 'history', relativePath: 'src/sheets/history', kind: 'directory' },
  ],
  'src/sheets/history': [
    { name: 'HistorySheetView.tsx', relativePath: 'src/sheets/history/HistorySheetView.tsx', kind: 'file' },
  ],
  'src/components': [
    { name: 'chat', relativePath: 'src/components/chat', kind: 'directory' },
    { name: 'ControlCenter.tsx', relativePath: 'src/components/ControlCenter.tsx', kind: 'file' },
  ],
  'src/demo': [
    { name: 'mockTauri.ts', relativePath: 'src/demo/mockTauri.ts', kind: 'file' },
    { name: 'demoData.ts', relativePath: 'src/demo/demoData.ts', kind: 'file' },
    { name: 'seed.ts', relativePath: 'src/demo/seed.ts', kind: 'file' },
    { name: 'visualQaData.ts', relativePath: 'src/demo/visualQaData.ts', kind: 'file' },
  ],
  'src/domains': [
    { name: 'agent', relativePath: 'src/domains/agent', kind: 'directory' },
    { name: 'presentation', relativePath: 'src/domains/presentation', kind: 'directory' },
    { name: 'theme', relativePath: 'src/domains/theme', kind: 'directory' },
    { name: 'tool', relativePath: 'src/domains/tool', kind: 'directory' },
  ],
  'src/plugins': [
    { name: 'core', relativePath: 'src/plugins/core', kind: 'directory' },
    { name: 'product', relativePath: 'src/plugins/product', kind: 'directory' },
  ],
  scripts: Array.from({ length: 18 }, (_, index) => ({ name: `visual-check-${String(index + 1).padStart(2, '0')}.mts`, relativePath: `scripts/visual-check-${String(index + 1).padStart(2, '0')}.mts`, kind: 'file' as const })),
  tests: [
    { name: 'integration', relativePath: 'tests/integration', kind: 'directory' },
    { name: 'visual', relativePath: 'tests/visual', kind: 'directory' },
  ],
  docs: [
    { name: '施工文档.md', relativePath: 'docs/施工文档.md', kind: 'file' },
    { name: '施工日志.md', relativePath: 'docs/施工日志.md', kind: 'file' },
    { name: '视觉革命验收清单.md', relativePath: 'docs/视觉革命验收清单.md', kind: 'file' },
    { name: 'Pylon-CLI-命令表.md', relativePath: 'docs/Pylon-CLI-命令表.md', kind: 'file' },
  ],
}

export function resolveWorkspaceEntries(relativePath: string): WorkspaceBackendEntry[] {
  return WORKSPACE_TREE[relativePath] ?? []
}

const FILE_TEXTS: Record<string, string> = {
  'src/sheets/AgentSheetView.solid.tsx': '/** @jsxImportSource solid-js */\nimport { createEffect, createMemo, Show } from \'solid-js\'\nimport { useReplayPostureStore } from \'../domains/chat/replayPostureStore\'\nimport { createZustandSignal } from \'../infrastructure/state/solidStoreBridge.ts\'\nimport AgentRendererSuiteWorkbench from \'./agent-workbench/AgentRendererSuiteWorkbench.solid.tsx\'\n\nexport default function AgentSheetView(props) {\n  const postureSession = createZustandSignal(useReplayPostureStore, s => s.sessionId)\n  const active = () => props.ctx.activeSession\n  // 姿态是一次性手势：会话不匹配即清，防 tab 重开误回只读。\n  createEffect(() => {\n    if (postureSession() !== null && postureSession() !== active()) useReplayPostureStore.getState().clear()\n  })\n  return (\n    <Show when={postureSession() === null || postureSession() !== active()}\n      fallback={<div class="replay-continue-bar">只读回放 · 点击继续</div>}>\n      <AgentRendererSuiteWorkbench sheet={props.sheet} ctx={props.ctx} />\n    </Show>\n  )\n}\n',
  'package.json': '{\n  "name": "prism-desktop",\n  "private": true,\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc && vite build",\n    "test:legacy": "node scripts/run-frontend-tests.mts"\n  }\n}\n',
}

export function buildWorkspaceFileText(relativePath: string): { relativePath: string; content: string; bytesRead: number; totalBytes: number; truncated: boolean; encoding: string } {
  const content = FILE_TEXTS[relativePath] ?? `// ${relativePath}\n// 演示文件：内容未在 mock 中提供。\n`
  return { relativePath, content, bytesRead: content.length, totalBytes: content.length, truncated: false, encoding: 'utf-8' }
}

export function buildWorkspaceSearchResults(query: string): Array<{ path: string; line: number; lineText: string }> {
  const q = query.toLowerCase()
  if (!q) return []
  const haystack = [
    { path: 'src/sheets/AgentSheetView.solid.tsx', line: 12, lineText: 'if (postureSession() !== null && postureSession() !== active()) useReplayPostureStore.getState().clear()' },
    { path: 'src/components/chat/replayPostureStore.ts', line: 3, lineText: 'export const useReplayPostureStore = create<ReplayPostureState>()(set => ({' },
    { path: 'docs/施工日志.md', line: 52, lineText: 'W4-02 接入只读回放视图 | 完成 | 姿态二' },
  ]
  return haystack.filter(item => item.lineText.toLowerCase().includes(q) || item.path.toLowerCase().includes(q))
}

// ── 权限请求（?demo-permission=1 opt-in，PermissionDialog 无关闭路径故不默认种）──

export function buildDemoPermissionRequest() {
  return {
    requestId: '1',
    provider: 'peri',
    agentId: 'peri',
    sessionId: 'demo-fe',
    clientGeneration: 1,
    toolCallId: 'tool-perm-1',
    title: '执行 Bash 命令',
    prompt: 'Peri 请求在 G:/work/prism-desktop 执行：pnpm install --frozen-lockfile',
    options: [
      { optionId: 'allow_once', label: '允许一次', kind: 'allow_once' },
      { optionId: 'allow_always', label: '始终允许', kind: 'allow_always' },
      { optionId: 'reject_once', label: '拒绝一次', kind: 'reject_once' },
    ],
    requestedAt: Date.now(),
  }
}

// ── 会话恢复响应（new_session / load_persisted_session）─────────────────

// 返回形状是已知的领域对象（sessionId + configOptions），故声明为真实的 wire 类型
// 而不是 `unknown`；`unknown` 只在解码完成前才是正确类型。
export function buildSessionResponse(args: Record<string, unknown>): SessionResponseObject {
  return {
    sessionId: typeof args.periId === 'string' ? args.periId : 'peri-demo-new',
    configOptions: [
      { id: 'model', label: '模型', currentValue: 'deepseek-v4-flash', options: [{ id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }, { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' }] },
      { id: 'mode', label: '权限模式', currentValue: 'auto', options: [{ id: 'bypass', label: '绕过' }, { id: 'auto', label: '自动' }, { id: 'edit', label: '编辑' }, { id: 'default', label: '默认' }] },
    ],
  }
}
