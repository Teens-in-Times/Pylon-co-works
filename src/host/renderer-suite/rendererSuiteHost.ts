import type { RendererActivationSnapshot, RendererSuiteContribution } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { WorkbenchHostPort, WorkbenchMountInput, WorkbenchRendererInstance, PreparedWorkbenchRenderer } from '../../renderers/solid-workbench/workbenchContracts.ts'
import { createRendererSuiteCommandGate } from './rendererSuiteCommandGate.ts'
import { createRendererSuiteHostState, type RendererSuiteHostState } from './rendererSuiteHostState.ts'
import { executeRendererSemanticCommand, isRenderSemanticCommand } from './rendererSemanticCommand.ts'

export interface RendererSuiteHostOptions {
  readonly container: HTMLElement
  readonly hostPort: WorkbenchHostPort
  /** A Suite receives a stable, Suite-scoped port even while another candidate is preparing. */
  readonly hostPortForActivation?: (activation: RendererActivationSnapshot) => WorkbenchHostPort
  readonly input: WorkbenchMountInput
  readonly readyTimeoutMs?: number
}

export interface RendererSuiteHostListener {
  (state: RendererSuiteHostState): void
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}

interface ActiveInstance {
  activation: RendererActivationSnapshot
  instance: WorkbenchRendererInstance
  gate: ReturnType<typeof createRendererSuiteCommandGate>
  staging: HTMLElement
  unsubscribeError: () => void
  unsubscribeAction: () => void
}

export class RendererSuiteHost {
  private state: RendererSuiteHostState = createRendererSuiteHostState()
  private active: ActiveInstance | undefined
  private requestId = 0
  private destroyed = false
  private readonly listeners = new Set<RendererSuiteHostListener>()
  private readonly pending = new Set<Promise<void>>()
  private readonly readyCancellers = new Set<() => void>()
  private currentInput: WorkbenchMountInput

  constructor(private readonly options: RendererSuiteHostOptions) {
    this.currentInput = options.input
  }

  getState(): RendererSuiteHostState { return this.state }

  subscribe(listener: RendererSuiteHostListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async mount(activation: RendererActivationSnapshot): Promise<void> {
    await this.activate(activation, false)
  }

  switchTo(activation: RendererActivationSnapshot): Promise<void> {
    const work = this.activate(activation, true)
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work))
    return work
  }

  update(input: WorkbenchMountInput): void {
    if (this.destroyed) return
    this.currentInput = input
    try { this.active?.instance.update(input) } catch (error) {
      this.options.hostPort.diagnostics.report({ code: 'renderer.suite.update.failed', message: errorMessage(error), phase: 'update', recoverability: 'fallback', suiteId: this.active?.activation.suite.value.id, documentRevision: this.options.hostPort.document.getSnapshot()?.revision })
    }
  }

  pause(): void {
    try { this.active?.instance.pause() } catch (error) {
      this.options.hostPort.diagnostics.report({ code: 'renderer.suite.pause.failed', message: errorMessage(error), phase: 'update', recoverability: 'fallback', suiteId: this.active?.activation.suite.value.id })
    }
  }
  resume(): void {
    try { this.active?.instance.resume() } catch (error) {
      this.options.hostPort.diagnostics.report({ code: 'renderer.suite.resume.failed', message: errorMessage(error), phase: 'update', recoverability: 'fallback', suiteId: this.active?.activation.suite.value.id })
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.requestId += 1
    for (const cancel of [...this.readyCancellers]) cancel()
    await Promise.allSettled([...this.pending])
    if (this.active) await this.destroyInstance(this.active)
    this.active = undefined
    this.options.container.replaceChildren()
    this.publish(createRendererSuiteHostState('destroyed'))
    this.listeners.clear()
  }

  private async activate(activation: RendererActivationSnapshot, switching: boolean): Promise<void> {
    if (this.destroyed) return
    const request = ++this.requestId
    for (const cancel of [...this.readyCancellers]) cancel()
    const old = this.active
    this.publish(createRendererSuiteHostState(switching || old ? 'switching' : 'preparing', {
      suiteId: activation.suite.value.id,
      previousSuiteId: old?.activation.suite.value.id,
      registryRevision: activation.revision,
      documentRevision: this.options.hostPort.document.getSnapshot()?.revision,
    }))
    const staging = this.options.container.ownerDocument.createElement('div')
    staging.dataset.rendererSuiteStaging = activation.suite.value.id
    staging.style.display = 'none'
    this.options.container.append(staging)
    let prepared: PreparedWorkbenchRenderer | undefined
    let instance: WorkbenchRendererInstance | undefined
    let failurePhase: 'prepare' | 'mount' = 'prepare'
    let candidateUnsubscribeError = () => {}
    let candidateUnsubscribeAction = () => {}
    let preCommitRuntimeError: unknown
    let candidateCommitted = false
    const gate = createRendererSuiteCommandGate()
    try {
      const activationHost = this.options.hostPortForActivation?.(activation) ?? this.options.hostPort
      const candidateHost = Object.freeze({ ...activationHost, commands: gate.bind(activationHost.commands) })
      prepared = await this.prepare(activation, activation.suite.value.factory, candidateHost)
      if (request !== this.requestId || this.destroyed) throw new StaleSuiteRequest()
      this.publish(createRendererSuiteHostState('mounting-candidate', { suiteId: activation.suite.value.id, previousSuiteId: old?.activation.suite.value.id, registryRevision: activation.revision, documentRevision: this.options.hostPort.document.getSnapshot()?.revision }))
      failurePhase = 'mount'
      const mountedInput = this.currentInput
      instance = await prepared.mount(staging, mountedInput, candidateHost)
      candidateUnsubscribeError = instance.on('error', error => {
        if (this.destroyed) return
        if (!candidateCommitted) {
          if (request === this.requestId) preCommitRuntimeError = error
          return
        }
        if (this.active?.instance !== instance) return
        activationHost.diagnostics.report({
          code: 'renderer.suite.runtime.failed',
          message: errorMessage(error),
          phase: 'update',
          recoverability: 'fallback',
          suiteId: activation.suite.value.id,
          registryRevision: activation.revision,
          documentRevision: activationHost.document.getSnapshot()?.revision,
        })
      })
      await this.waitReady(instance, this.options.readyTimeoutMs ?? 10_000)
      if (request !== this.requestId || this.destroyed) throw new StaleSuiteRequest()
      // Keep the continuous listener above for ready→error emitters, then probe
      // once for instances that only replay a cached fatal to post-ready subscribers.
      const unsubscribeCachedErrorProbe = instance.on('error', error => {
        if (request === this.requestId) preCommitRuntimeError = error
      })
      unsubscribeCachedErrorProbe()
      if (preCommitRuntimeError !== undefined) throw preCommitRuntimeError
      // Session/sheet/visibility may have changed while this candidate waited
      // for ready. Converge it before the atomic DOM commit.
      if (this.currentInput !== mountedInput) instance.update(this.currentInput)
      gate.activate()
      const previous = this.active
      candidateUnsubscribeAction = instance.on('request-action', action => {
        if (this.destroyed || this.active?.instance !== instance) return
        if (!isRenderSemanticCommand(action)) {
          activationHost.diagnostics.report({
            code: 'renderer_action_invalid', message: 'Renderer Suite request-action 不是 semantic command',
            phase: 'action', recoverability: 'none', suiteId: activation.suite.value.id,
          })
          return
        }
        void executeRendererSemanticCommand({ command: action, host: candidateHost, mountInput: this.currentInput })
      })
      this.options.container.replaceChildren(...Array.from(staging.childNodes))
      staging.remove()
      this.active = {
        activation, instance, gate, staging,
        unsubscribeError: candidateUnsubscribeError,
        unsubscribeAction: candidateUnsubscribeAction,
      }
      candidateCommitted = true
      candidateUnsubscribeError = () => {}
      candidateUnsubscribeAction = () => {}
      this.publish(createRendererSuiteHostState('active', { suiteId: activation.suite.value.id, previousSuiteId: previous?.activation.suite.value.id, registryRevision: activation.revision, documentRevision: this.options.hostPort.document.getSnapshot()?.revision }))
      if (previous) {
        try { previous.instance.pause() } catch (error) {
          this.options.hostPort.diagnostics.report({ code: 'renderer.suite.pause.failed', message: errorMessage(error), phase: 'switch', recoverability: 'none', suiteId: previous.activation.suite.value.id })
        }
        await this.destroyInstance(previous)
      }
    } catch (error) {
      gate.deactivate()
      candidateUnsubscribeError()
      candidateUnsubscribeAction()
      if (instance) await this.safeDestroy(instance)
      staging.remove()
      if (error instanceof StaleSuiteRequest) return
      this.publish(createRendererSuiteHostState(old ? 'active' : 'degraded', { suiteId: old?.activation.suite.value.id, previousSuiteId: activation.suite.value.id, registryRevision: activation.revision, documentRevision: this.options.hostPort.document.getSnapshot()?.revision, error }))
      this.options.hostPort.diagnostics.report({ code: 'renderer.suite.switch.failed', message: errorMessage(error), phase: failurePhase, recoverability: old ? 'none' : 'retry', suiteId: activation.suite.value.id, oldSuiteId: old?.activation.suite.value.id, newSuiteId: activation.suite.value.id, registryRevision: activation.revision, documentRevision: this.options.hostPort.document.getSnapshot()?.revision })
    }
  }

  // #520 S4-P2：Suite factory 只剩 prepare 工厂形态（rendererSuiteTypes 函数臂已塌缩），
  // 历史「函数形态未实现」throw 分支随之删除。
  private prepare(activation: RendererActivationSnapshot, factory: RendererSuiteContribution['factory'], host: WorkbenchHostPort): Promise<PreparedWorkbenchRenderer> {
    return factory.prepare({ suiteId: activation.suite.value.id, host, activation })
  }

  private waitReady(instance: WorkbenchRendererInstance, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let unsubscribe = () => {}
      let unsubscribeError = () => {}
      const timer = setTimeout(() => fail(new Error('Renderer Suite ready 超时')), Math.max(1, timeoutMs))
      const cancel = () => fail(new StaleSuiteRequest())
      const cleanup = () => { this.readyCancellers.delete(cancel); clearTimeout(timer); unsubscribe(); unsubscribeError() }
      const finish = () => { if (!settled) { settled = true; cleanup(); resolve() } }
      const fail = (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error) } }
      this.readyCancellers.add(cancel)
      unsubscribeError = instance.on('error', fail)
      if (settled) unsubscribeError()
      unsubscribe = instance.on('ready', finish)
      if (settled) unsubscribe()
    })
  }

  private async destroyInstance(active: ActiveInstance): Promise<void> {
    active.gate.deactivate()
    active.unsubscribeError()
    active.unsubscribeAction()
    try { await active.instance.destroy() } catch (error) {
      this.options.hostPort.diagnostics.report({
        code: 'renderer.suite.destroy.failed', message: errorMessage(error), phase: 'destroy', recoverability: 'none',
        suiteId: active.activation.suite.value.id, registryRevision: active.activation.revision,
        documentRevision: this.options.hostPort.document.getSnapshot()?.revision,
      })
    }
    active.staging.remove()
  }

  private async safeDestroy(instance: WorkbenchRendererInstance): Promise<void> {
    try { await instance.destroy() } catch { /* candidate never became active */ }
  }

  private publish(next: RendererSuiteHostState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener(next)
  }
}

class StaleSuiteRequest extends Error {
  constructor() { super('stale renderer suite request') }
}
