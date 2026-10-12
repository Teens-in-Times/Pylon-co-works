import type { Message } from '../../../domains/chat/messageTypes.ts'
import type { PlanEntry } from '../../../domains/tasks/planTypes.ts'

export interface WorkbenchMessageFixture {
  messages: readonly Message[]
  tasks: readonly PlanEntry[]
}

export interface WorkbenchInputFixture {
  draft: string
  command: string
  attachments: readonly {
    id: string
    name: string
    mimeType: string
    size: number
  }[]
  queue: readonly {
    id: number
    text: string
    editing: boolean
  }[]
}

export interface WorkbenchControlCenterFixture {
  tokenCount: number
  contextPercent: number
  model: string
  mode: string
  hidden: readonly string[]
  scale: Readonly<Record<string, number>>
}

export interface WorkbenchPetFixture {
  stages: readonly ['seed', 'sprout', 'hopper', 'guardian', 'luminary']
  moods: readonly string[]
  poses: readonly string[]
  directions: readonly ['left', 'right']
  cosmetics: readonly string[]
}

export const WORKBENCH_MESSAGE_FIXTURE: WorkbenchMessageFixture = {
  messages: [
    {
      id: 'fixture-user',
      role: 'user',
      sender: 'local:fixture',
      content: '请检查 `AgentSheet`，保留 Markdown、Tool、Diff 与任务状态。',
      time: '10:00',
    },
    {
      id: 'fixture-reasoning',
      role: 'reasoning',
      sender: 'peri',
      content: '先读取源码，再建立 renderer contract。',
      time: '10:00',
      thoughtStartedAt: 1_000,
      thoughtDurationMs: 2_400,
    },
    {
      id: 'fixture-tool-running',
      role: 'tool',
      sender: 'tool:Read',
      content: '',
      toolName: 'Read',
      toolKind: 'read',
      toolInput: 'src/sheets/AgentSheetView.tsx',
      toolStatus: 'in_progress',
      running: true,
      time: '10:00',
    },
    {
      id: 'fixture-tool-completed',
      role: 'tool',
      sender: 'tool:Bash',
      content: '',
      toolName: 'Bash',
      toolKind: 'execute',
      toolInput: 'npm run build',
      toolOutput: '\u001b[32mPASS\u001b[0m build\n0 errors',
      toolOutputLines: 2,
      toolStatus: 'completed',
      time: '10:01',
    },
    {
      id: 'fixture-tool-error',
      role: 'tool',
      sender: 'tool:Write',
      content: '',
      toolName: 'Write',
      toolKind: 'write',
      toolInput: 'src/generated/missing.ts',
      toolOutput: 'permission denied',
      toolOutputLines: 1,
      toolStatus: 'failed',
      time: '10:01',
    },
    {
      id: 'fixture-diff',
      role: 'tool',
      sender: 'tool:Edit',
      content: '',
      toolName: 'Edit',
      toolKind: 'edit',
      toolInput: 'src/sheets/AgentSheetView.tsx',
      toolOutput: '- ReactWorkbench\n+ SolidWorkbench',
      toolOutputLines: 2,
      toolStatus: 'completed',
      contentBlocks: [{
        type: 'tool_diff_content',
        title: 'AgentSheetView.tsx',
        oldText: 'ReactWorkbench\n',
        newText: 'SolidWorkbench\n',
      }],
      time: '10:01',
    },
    {
      id: 'fixture-assistant-markdown',
      role: 'assistant',
      sender: 'peri',
      content: '# 迁移结果\n\n- runtime 保持 framework-neutral\n- renderer 使用 SolidJS\n\n```ts\nexport interface RendererLifecycle { destroy(): void }\n```',
      time: '10:02',
    },
  ],
  tasks: [
    { content: '冻结皮肤 contract', status: 'completed' },
    { content: '建立 Solid smoke renderer', status: 'in_progress' },
    { content: '切换生产 AgentSheet', status: 'pending' },
  ],
}

export const WORKBENCH_INPUT_FIXTURE: WorkbenchInputFixture = {
  draft: '请继续迁移 AgentSheet',
  command: '/model deepseek-chat',
  attachments: [{
    id: 'fixture-attachment',
    name: 'agent-sheet.png',
    mimeType: 'image/png',
    size: 24_576,
  }],
  queue: [
    { id: 1, text: '先跑 focused tests', editing: false },
    { id: 2, text: '然后检查 bundle', editing: true },
  ],
}

export const WORKBENCH_CONTROL_CENTER_FIXTURE: WorkbenchControlCenterFixture = {
  tokenCount: 12_480,
  contextPercent: 62,
  model: 'deepseek-chat',
  mode: 'auto',
  hidden: ['attach'],
  scale: { tokens: 90, model: 110 },
}

export const WORKBENCH_PET_FIXTURE: WorkbenchPetFixture = {
  stages: ['seed', 'sprout', 'hopper', 'guardian', 'luminary'],
  moods: ['idle', 'sleepy', 'error', 'happy', 'focused', 'curious'],
  poses: ['idle', 'walking', 'coding', 'eating'],
  directions: ['left', 'right'],
  cosmetics: ['beret', 'pixel_cape', 'glow_band', 'phantom_cat'],
}
