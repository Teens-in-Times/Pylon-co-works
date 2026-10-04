import cliManifest from '../../shared/pylon-cli-manifest.json' with { type: 'json' }
import type { HotSwapMode } from '../plugin-runtime/shadowUpdate.ts'

// B-8c：接口面（13 个 ControlPort + DTO + wire 归一化）已拆至 pylonCliPorts；
// 此处 re-export 维持 pylonCliService 既有公开面（消费方 import 零改动）。
export * from './pylonCliPorts.ts'
import type { PylonCliInput, PylonCliServicePorts, PylonCliToolOutput } from './pylonCliPorts.ts'

export const PYLON_CLI_COMMANDS: readonly string[] = Object.freeze([...cliManifest.commands])
export const CLI_ALIASES: Readonly<Record<string, string>> = Object.freeze({ ...cliManifest.aliases })
export interface PylonOperationSnapshot {
  operationId: string
  command: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: number
  completedAt?: number
  logs: readonly string[]
  error?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** CLI 壳（pylon-cli.rs parse_value）按 JSON 类型化所有 token：纯数字
 *  positional/flag 值以 number 到达。字符串参数按 O27 标量宽松化先例无损
 *  收编（#229），壳层类型化设计不动。 */
function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function stringArg(args: Record<string, unknown>, key: string, position?: number): string {
  const direct = scalarString(args[key])
  if (direct) return direct
  const positionals = Array.isArray(args.positionals) ? args.positionals : []
  const positional = position === undefined ? undefined : positionals[position]
  const positionalString = scalarString(positional)
  if (positionalString) return positionalString
  throw new Error(`${key} 必须是非空字符串`)
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  return scalarString(args[key])
}

function positiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

function normalizeCommand(command: string): string {
  return command.trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ')
}

function commandArguments(args: Record<string, unknown>): Record<string, unknown> {
  if (args.args && typeof args.args === 'object' && !Array.isArray(args.args)) return record(args.args)
  const forwarded = { ...args }
  const remainingPositionals = Array.isArray(args.positionals) ? args.positionals.slice(1) : []
  delete forwarded.positionals
  delete forwarded.commandId
  if (remainingPositionals.length > 0) forwarded.positionals = remainingPositionals
  return forwarded
}

/** 错误文本归一（#36）：Tauri 命令 reject 的是 PylonError 序列化出的结构化
 *  对象 `{code, message}`，不是 Error 实例——裸 String(obj) 得到 "[object Object]"，
 *  真实失败原因（kind 门禁、revision 冲突等）全部丢失。优先取结构化 message，
 *  其余对象受控 JSON 序列化兜底。pylonCliBridge 的 native 回包同用此实现。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

function isHotSwapMode(value: unknown): value is HotSwapMode {
  return value === 'parallel' || value === 'exclusive' || value === 'soft-remount' || value === 'restart-required'
}

function skinTarget(args: Record<string, unknown>): Record<string, unknown> {
  if (args.target && typeof args.target === 'object' && !Array.isArray(args.target)) return record(args.target)
  const scope = optionalString(args, 'scope') ?? 'global'
  const target = optionalString(args, 'target')
  if (scope === 'global') return { scope: 'global' }
  if (scope === 'workspace') return { scope, workspaceId: optionalString(args, 'workspaceId') ?? target }
  if (scope === 'agent') return { scope, agentId: optionalString(args, 'agentId') ?? target }
  if (scope === 'session') return { scope, sessionId: optionalString(args, 'sessionId') ?? target }
  throw new Error(`非法 Skin scope：${scope}`)
}

export class PylonCliService {
  private readonly operations = new Map<string, PylonOperationSnapshot>()
  private readonly operationControllers = new Map<string, AbortController>()
  private readonly now: () => number
  private readonly createOperationId: () => string
  private operationSequence = 0

  constructor(private readonly ports: PylonCliServicePorts) {
    this.now = ports.now ?? Date.now
    this.createOperationId = ports.createOperationId
      ?? (() => `op-${this.now()}-${++this.operationSequence}`)
  }

  async execute(input: PylonCliInput, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const command = normalizeCommand(input.command)
    const args = record(input.args)
    switch (command) {
      case 'plugin list':
        return this.pluginList(args)
      case 'plugin inspect':
        return this.pluginInspect(args)
      case 'plugin enable':
        return this.mutate(command, options.signal, () => this.ports.plugins.enable(stringArg(args, 'pluginId', 0)))
      case 'plugin disable':
        return this.mutate(command, options.signal, () => this.ports.plugins.disable(stringArg(args, 'pluginId', 0)))
      case 'plugin reload':
        return this.mutate(command, options.signal, () => {
          const mode = args.mode
          if (mode !== undefined && mode !== 'auto' && !isHotSwapMode(mode)) throw new Error(`非法 reload mode：${String(mode)}`)
          return this.ports.plugins.reload(stringArg(args, 'pluginId', 0), mode === 'auto' ? undefined : mode)
        })
      case 'package list':
        return this.ports.packages.list()
      case 'package inspect':
        return this.ports.packages.inspect(stringArg(args, 'sourcePath', 0))
      case 'package install':
        return this.mutate(command, options.signal, async () => {
          const result = await this.ports.packages.installOrUpdate(stringArg(args, 'sourcePath', 0))
          if (!result.ok) throw new Error(result.message || '插件包安装/更新失败')
          return result
        })
      case 'package enable':
      case 'package disable':
        return this.mutate(command, options.signal, async () => {
          const enabled = command === 'package enable'
          const result = await this.ports.packages.setEnabled(stringArg(args, 'pluginId', 0), enabled)
          if (!result.ok) throw new Error(result.message || `插件包${enabled ? '启用' : '停用'}失败`)
          return result
        })
      case 'package reload':
        return this.mutate(command, options.signal, async () => {
          const result = await this.ports.packages.reload(stringArg(args, 'pluginId', 0))
          if (!result.ok) throw new Error(result.message || '插件包重载失败')
          return result
        })
      case 'package versions':
        return this.ports.packages.versions(stringArg(args, 'pluginId', 0))
      case 'package rollback':
        return this.mutate(command, options.signal, () => this.ports.packages.rollback(
          stringArg(args, 'pluginId', 0), optionalString(args, 'packageInstanceId'),
        ))
      case 'package uninstall':
        return this.mutate(command, options.signal, async () => {
          const result = await this.ports.packages.uninstall(stringArg(args, 'pluginId', 0), args.purgeData === true)
          if (!result.ok) throw new Error(result.message || '插件包卸载失败')
          return result
        })
      case 'hook list':
        return this.hookList(args)
      case 'hook trace':
        return this.hookTrace(args)
      case 'skin schema':
        return this.ports.commands.execute('skin.schema', {}, { signal: options.signal })
      case 'skin draft create':
        return this.mutate(command, options.signal, signal => this.ports.commands.execute('skin.draft.create', {
          ...args,
          name: optionalString(args, 'name') ?? stringArg(args, 'name', 0),
          ...(optionalString(args, 'extends') ? { baseSkinId: optionalString(args, 'extends') } : {}),
        }, { signal }))
      case 'skin draft patch':
        return this.mutate(command, options.signal, signal => this.ports.commands.execute('skin.draft.patch', {
          draftId: stringArg(args, 'draftId', 0),
          patch: record(args.patch),
        }, { signal }))
      case 'skin preview':
        return this.mutate(command, options.signal, signal => this.ports.commands.execute('skin.preview', {
          draftId: stringArg(args, 'draftId', 0),
          target: skinTarget(args),
        }, { signal }))
      case 'skin capture':
        return this.mutate(command, options.signal, async signal => {
          const result = await this.ports.commands.execute('skin.capture', {
            previewId: stringArg(args, 'previewId', 0),
            options: { format: optionalString(args, 'format'), artifactPath: optionalString(args, 'out') },
          }, { signal })
          const capture = record(result)
          if (capture.status !== 'captured') throw new Error(optionalString(capture, 'error') ?? 'Skin capture 未生成 artifact')
          return result
        })
      case 'skin commit':
        return this.mutate(command, options.signal, signal => this.ports.commands.execute('skin.commit', {
          previewId: stringArg(args, 'previewId', 0),
        }, { signal }))
      case 'skin rollback':
        return this.mutate(command, options.signal, signal => this.ports.commands.execute('skin.rollback', {
          previewId: stringArg(args, 'previewId', 0),
        }, { signal }))
      case 'process list':
        return this.processList(args)
      case 'process logs':
        return this.ports.processes.logs(
          stringArg(args, 'processId', 0),
          args.stream === 'stderr' ? 'stderr' : args.stream === 'stdout' ? 'stdout' : undefined,
          positiveInteger(args.limit, 200, 2000),
        )
      case 'process terminate':
        return this.mutate(command, options.signal, async () => {
          const processId = stringArg(args, 'processId', 0)
          await this.ports.processes.terminate(processId)
          return { processId, terminated: true }
        })
      case 'workspace list':
        return this.ports.workspaces.list()
      case 'workspace open':
        return this.mutate(command, options.signal, () => {
          const workspaceId = this.ports.workspaces.open({
            type: stringArg(args, 'type', 0),
            ...(optionalString(args, 'title') ? { title: optionalString(args, 'title') } : {}),
            ...(args.state !== undefined ? { state: args.state } : {}),
            ...(optionalString(args, 'agentId') ? { agentId: optionalString(args, 'agentId') } : {}),
            ...(optionalString(args, 'singletonKey') ? { singletonKey: optionalString(args, 'singletonKey') } : {}),
            ...(args.pinned === true ? { pinned: true } : {}),
            ...(args.metadata ? { metadata: record(args.metadata) as Record<string, string> } : {}),
          })
          if (!workspaceId) throw new Error('Workspace type 不存在或无法打开')
          return { workspaceId }
        })
      case 'workspace close':
        return this.mutate(command, options.signal, async () => {
          const workspaceId = stringArg(args, 'workspaceId', 0)
          const closed = await this.ports.workspaces.close(workspaceId)
          if (!closed) throw new Error(`Workspace 不存在或拒绝关闭：${workspaceId}`)
          return { workspaceId, closed }
        })
      case 'operation inspect':
        return this.operation(stringArg(args, 'operationId', 0))
      case 'operation logs':
        return this.operation(stringArg(args, 'operationId', 0)).logs
      case 'operation cancel':
        return this.cancelOperation(stringArg(args, 'operationId', 0))
      case 'command exec':
        return this.mutate(command, options.signal, signal => this.ports.commands.execute(
          stringArg(args, 'commandId', 0),
          commandArguments(args),
          { signal },
        ))
      case 'command list': {
        const pluginId = optionalString(args, 'pluginId') ?? optionalString(args, 'plugin')
        return this.ports.commands.list({
          ...(pluginId ? { ownerPluginIds: [pluginId] } : {}),
          ...(typeof args.executable === 'boolean' ? { executable: args.executable } : {}),
        })
      }
      case 'command inspect': {
        const commandId = stringArg(args, 'commandId', 0)
        const descriptor = this.ports.commands.describe(commandId)
        if (!descriptor) throw new Error(`命令不存在：${commandId}`)
        return descriptor
      }
      case 'registry list':
        return this.ports.registries.snapshot()
      case 'agent list':
        return this.ports.agents.list()
      case 'agent import':
        return this.mutate(command, options.signal, signal => this.ports.agents.import({
          candidateId: stringArg(args, 'candidateId', 0),
          ...(optionalString(args, 'agentId') ? { agentId: optionalString(args, 'agentId') } : {}),
        }, { signal }))
      case 'agent set default':
        return this.mutate('agent set-default', options.signal, signal => this.ports.agents.setDefault(
          stringArg(args, 'agentId', 0), { signal },
        ))
      case 'session list':
        return this.ports.sessions.list()
      case 'session inspect': {
        const sessionId = stringArg(args, 'sessionId', 0)
        return this.ports.sessions.inspect(sessionId)
      }
      case 'session messages':
        return this.mutate(command, options.signal, async signal => this.ports.sessions.messages(
          stringArg(args, 'sessionId', 0),
          {
            afterSeq: optionalString(args, 'afterSeq') ? Number(optionalString(args, 'afterSeq')) : undefined,
            limit: optionalString(args, 'limit') ? Number(optionalString(args, 'limit')) : undefined,
            signal,
          },
        ))
      case 'session create':
        return this.mutate(command, options.signal, signal => this.ports.sessions.create({
          ...(optionalString(args, 'agentId') ? { agentId: optionalString(args, 'agentId') } : {}),
          ...(optionalString(args, 'cwd') ? { cwd: optionalString(args, 'cwd') } : {}),
          ...(optionalString(args, 'workspaceId') ? { workspaceId: optionalString(args, 'workspaceId') } : {}),
          ...(optionalString(args, 'title') ? { title: optionalString(args, 'title') } : {}),
        }, { signal }))
      case 'session send':
        return this.mutate(command, options.signal, signal => this.ports.sessions.send(
          stringArg(args, 'sessionId', 0),
          optionalString(args, 'content') ?? stringArg(args, 'content', 1),
          { signal },
        ))
      case 'session close':
        return this.mutate(command, options.signal, async signal => {
          const sessionId = stringArg(args, 'sessionId', 0)
          const closed = await this.ports.sessions.close(sessionId, { signal })
          if (!closed) throw new Error(`Session 不存在或拒绝关闭：${sessionId}`)
          return { sessionId, closed }
        })
      case 'session cancel':
        return this.mutate(command, options.signal, async () => {
          const sessionId = stringArg(args, 'sessionId', 0)
          const cancelled = await this.ports.sessions.cancel(sessionId)
          if (!cancelled) throw new Error(`Session 不存在或无法取消：${sessionId}`)
          return { sessionId, cancelled }
        })
      // #463 审查项 3：get/set 均透传后端快照 {mode, persisted}——persisted=false
      // 即落盘降级（重启回退），外部可查（不再回显入参，mode 由后端确认）。
      case 'approval get':
        return this.ports.approval.get()
      case 'approval set': {
        const mode = optionalString(args, 'mode') ?? stringArg(args, 'mode', 0)
        return this.ports.approval.set(mode)
      }
      case 'interaction list':
        return this.ports.interactions.list()
      case 'interaction respond':
        return this.mutate(command, options.signal, async () => {
          const requestId = stringArg(args, 'requestId', 0)
          const positionals = Array.isArray(args.positionals) ? args.positionals : []
          const optionId = optionalString(args, 'optionId') ?? scalarString(positionals[1])
          // #230：ask-user/elicitation 类自由作答——values（questionId→label 表）
          // 或 text（单值/feedback），经 --args JSON 传入。
          const values = args.values === undefined ? undefined : record(args.values)
          if (args.values !== undefined && (typeof args.values !== 'object' || Array.isArray(args.values))) {
            throw new Error('values 必须是对象（questionId → label/label 数组）')
          }
          const text = optionalString(args, 'text')
          const items = (await this.ports.interactions.list()).items
          const found = items.find(item => item.requestId === requestId)
          if (!found) throw new Error(`挂起交互不存在（已应答/超时）：${requestId}`)
          if (optionId !== undefined && found.options.length > 0
            && !found.options.some(option => option.optionId === optionId)) {
            throw new Error(`非法 optionId：${optionId}（可用：${found.options.map(option => option.optionId).join(', ')}）`)
          }
          if (optionId === undefined && values === undefined && !text) {
            // ask-user（options 为空）的 declined 与 ask-user 之外的白名单动作
            // 都经 optionId 表达；三者皆缺则无合法应答形状。
            throw new Error('必须提供 optionId，或携带 values / text 的自由作答')
          }
          if (optionId !== undefined && found.options.length === 0 && optionId !== 'declined') {
            throw new Error(`非法 optionId：${optionId}（此类交互仅支持 declined 或 values/text 自由作答）`)
          }
          await this.ports.interactions.respond({
            provider: found.provider,
            agentId: found.agentId,
            requestId: found.requestId,
            sessionId: found.sessionId,
            toolCallId: found.toolCallId || null,
            clientGeneration: found.clientGeneration,
          }, found.kind, { optionId, text, values })
          return { requestId, optionId: optionId ?? null, responded: true }
        })
      // ── 第二批：注册表工作区 CRUD / 会话配置 / 导出 ──
      case 'workspace registry list':
        return this.ports.workspaceRegistry.list()
      case 'workspace registry create':
        return this.mutate(command, options.signal, async () => this.ports.workspaceRegistry.create({
          agentId: stringArg(args, 'agentId', 0),
          name: stringArg(args, 'name', 1),
          rootPath: stringArg(args, 'rootPath', 2),
        }))
      case 'workspace registry update':
        return this.mutate(command, options.signal, async () => this.ports.workspaceRegistry.update({
          workspaceId: stringArg(args, 'workspaceId', 0),
          name: optionalString(args, 'name'),
          rootPath: optionalString(args, 'rootPath'),
        }))
      case 'workspace registry delete':
        return this.mutate(command, options.signal, async () => this.ports.workspaceRegistry.remove(
          stringArg(args, 'workspaceId', 0),
        ))
      case 'workspace registry search': {
        const query = optionalString(args, 'query') ?? stringArg(args, 'query', 0)
        const maxResults = optionalString(args, 'maxResults') ? Number(optionalString(args, 'maxResults')) : undefined
        return this.ports.workspaceRegistry.search(query, maxResults)
      }
      case 'session config set':
        return this.mutate(command, options.signal, async () => this.ports.sessionConfig.setOption({
          agentId: stringArg(args, 'agentId', 0),
          sessionId: stringArg(args, 'sessionId', 1),
          key: stringArg(args, 'key', 2),
          value: stringArg(args, 'value', 3),
        }))
      case 'session export':
        return this.mutate(command, options.signal, async () => {
          await this.ports.sessionConfig.exportSession({
            agentId: stringArg(args, 'agentId', 0),
            periId: stringArg(args, 'periId', 1),
            format: optionalString(args, 'format') ?? 'markdown',
            outputPath: stringArg(args, 'outputPath', 2),
          })
          return { exported: true }
        })
      case 'event log':
        return this.eventLog(args)
      default:
        throw new Error(`未知 Pylon CLI 命令：${input.command}`)
    }
  }

  private pluginList(args: Record<string, unknown>) {
    const snapshot = this.ports.plugins.snapshot()
    const pluginId = optionalString(args, 'pluginId')
    return {
      revision: snapshot.revision,
      plugins: snapshot.active.filter(identity => !pluginId || identity.pluginId === pluginId),
      switches: snapshot.switches,
    }
  }

  private pluginInspect(args: Record<string, unknown>) {
    const pluginId = stringArg(args, 'pluginId', 0)
    const runtimeInstanceId = optionalString(args, 'instance') ?? optionalString(args, 'runtimeInstanceId')
    const snapshot = this.ports.plugins.snapshot()
    const instances = snapshot.active.filter(identity => (
      identity.pluginId === pluginId && (!runtimeInstanceId || identity.runtimeInstanceId === runtimeInstanceId)
    ))
    if (instances.length === 0) throw new Error(`未找到激活插件：${pluginId}`)
    return {
      pluginId,
      instances,
      switch: snapshot.switches.find(value => record(value).pluginId === pluginId) ?? null,
    }
  }

  private hookList(args: Record<string, unknown>) {
    const hookName = optionalString(args, 'name') ?? optionalString(args, 'hook')
    const pluginId = optionalString(args, 'plugin') ?? optionalString(args, 'pluginId')
    return this.ports.hooks.list().filter(entry => (
      (!hookName || entry.hookName === hookName) && (!pluginId || entry.pluginId === pluginId)
    ))
  }

  private hookTrace(args: Record<string, unknown>) {
    const hookName = optionalString(args, 'hook') ?? optionalString(args, 'name')
    const sessionId = optionalString(args, 'session') ?? optionalString(args, 'sessionId')
    const limit = positiveInteger(args.limit, 50, 200)
    return this.ports.hooks.trace()
      .filter(entry => !hookName || entry.hookName === hookName)
      .filter(entry => !sessionId || record(entry).sessionId === sessionId)
      .slice(-limit)
  }

  private async processList(args: Record<string, unknown>) {
    const processes = await this.ports.processes.list(optionalString(args, 'runtimeInstanceId'))
    const pluginId = optionalString(args, 'plugin') ?? optionalString(args, 'pluginId')
    return pluginId ? processes.filter(process => process.pluginId === pluginId) : processes
  }

  private eventLog(args: Record<string, unknown>) {
    const limit = positiveInteger(args.limit, 50, 200)
    const operations = [...this.operations.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-limit)
    const hooks = [...this.ports.hooks.trace()].slice(-limit)
    return { operations, hooks }
  }

  private async mutate<T>(
    command: string,
    outerSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => T | Promise<T>,
  ): Promise<{ operationId: string, result: T }> {
    const operationId = this.createOperationId()
    const controller = new AbortController()
    const abort = () => controller.abort(outerSignal?.reason)
    outerSignal?.addEventListener('abort', abort, { once: true })
    this.operationControllers.set(operationId, controller)
    this.operations.set(operationId, {
      operationId,
      command,
      status: 'running',
      startedAt: this.now(),
      logs: Object.freeze([`started ${command}`]),
    })
    try {
      if (outerSignal?.aborted) abort()
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
      const result = await execute(controller.signal)
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
      this.finishOperation(operationId, 'succeeded', `completed ${command}`)
      return { operationId, result }
    } catch (error) {
      const cancelled = controller.signal.aborted
      this.finishOperation(operationId, cancelled ? 'cancelled' : 'failed', errorMessage(error), errorMessage(error))
      throw error
    } finally {
      outerSignal?.removeEventListener('abort', abort)
      this.operationControllers.delete(operationId)
    }
  }

  private finishOperation(
    operationId: string,
    status: PylonOperationSnapshot['status'],
    log: string,
    error?: string,
  ): void {
    const current = this.operations.get(operationId)
    if (!current) return
    this.operations.set(operationId, Object.freeze({
      ...current,
      status,
      completedAt: this.now(),
      logs: Object.freeze([...current.logs, log]),
      ...(error ? { error } : {}),
    }))
  }

  private operation(operationId: string): PylonOperationSnapshot {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error(`Operation 不存在：${operationId}`)
    return operation
  }

  private cancelOperation(operationId: string): PylonOperationSnapshot {
    const operation = this.operation(operationId)
    this.operationControllers.get(operationId)?.abort(new DOMException('Cancelled by operation command', 'AbortError'))
    return this.operations.get(operationId) ?? operation
  }
}

export function createPylonCliTool(service: PylonCliService) {
  return {
    name: 'pylon_cli' as const,
    async execute(input: PylonCliInput, options: { signal?: AbortSignal } = {}): Promise<PylonCliToolOutput> {
      try {
        return { ok: true, result: await service.execute(input, options) }
      } catch (error) {
        return { ok: false, error: { code: 'pylon_cli_error', message: errorMessage(error) } }
      }
    },
  }
}

