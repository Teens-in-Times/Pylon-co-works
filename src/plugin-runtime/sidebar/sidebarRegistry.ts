import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { AgentSidebarContribution, AgentSidebarHeaderAction } from './sidebarTypes.ts'

const TITLE_ACTIONS = ['expand', 'page'] as const

/** 宿主保留的动作 id：自动补的「打开整页」动作（Sidebar.solid 的 OPEN_PAGE_ACTION，
 * #520 S4-P2 注册期防撞）。贡献撞用会让点击分发永远走不到自定义处理器。 */
const RESERVED_HEADER_ACTION_ID = '__open_page__'

function validateHeaderActions(contribution: AgentSidebarContribution): void {
  const actions = contribution.headerActions
  if (actions === undefined) return
  if (!Array.isArray(actions)) throw new Error(`Agent sidebar headerActions 必须是数组：${contribution.id}`)
  const seen = new Set<string>()
  for (const action of actions as readonly AgentSidebarHeaderAction[]) {
    if (!action || typeof action !== 'object') throw new Error(`Agent sidebar headerActions 项非法：${contribution.id}`)
    if (!action.id || action.id !== action.id.trim()) {
      throw new Error(`Agent sidebar headerActions[].id 必须是非空且无首尾空格的字符串：${contribution.id}`)
    }
    if (action.id === RESERVED_HEADER_ACTION_ID) {
      throw new Error(`Agent sidebar headerActions id 与宿主保留动作冲突（${RESERVED_HEADER_ACTION_ID} 是自动「打开整页」动作）：${contribution.id}/${action.id}`)
    }
    if (seen.has(action.id)) throw new Error(`Agent sidebar headerActions id 重复：${contribution.id}/${action.id}`)
    seen.add(action.id)
    if (typeof action.label !== 'string' || !action.label.trim()) {
      throw new Error(`Agent sidebar headerActions[].label 不能为空：${contribution.id}/${action.id}`)
    }
  }
}

function validateContribution(contribution: AgentSidebarContribution): AgentSidebarContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) {
    throw new Error('Agent sidebar contribution id 必须是非空且无首尾空格的字符串')
  }
  if (!contribution.label.trim()) throw new Error(`Agent sidebar contribution label 不能为空：${contribution.id}`)
  if (contribution.onTitleClick !== undefined && !TITLE_ACTIONS.includes(contribution.onTitleClick)) {
    throw new Error(`Agent sidebar contribution onTitleClick 非法（只能是 expand / page）：${contribution.id}`)
  }
  if (contribution.page !== undefined) {
    if (!contribution.page || typeof contribution.page !== 'object') {
      throw new Error(`Agent sidebar contribution page 非法：${contribution.id}`)
    }
    if (typeof contribution.page.title !== 'string' || !contribution.page.title.trim()) {
      throw new Error(`Agent sidebar contribution page.title 不能为空：${contribution.id}`)
    }
  }
  // 标题点了要「进入页面」却没有页面可进 —— 注册期就拒绝，否则是一次点击后无反馈的死路。
  if (contribution.onTitleClick === 'page' && contribution.page === undefined) {
    throw new Error(`Agent sidebar contribution onTitleClick=page 但未声明 page：${contribution.id}`)
  }
  validateHeaderActions(contribution)
  if (contribution.renderKind === 'first-party-solid' && typeof contribution.component !== 'function' && typeof contribution.component !== 'object') {
    throw new Error(`Agent sidebar first-party component 非法：${contribution.id}`)
  }
  if (contribution.renderKind === 'isolated-surface' && !contribution.surfaceId.trim()) {
    throw new Error(`Agent sidebar isolated surfaceId 不能为空：${contribution.id}`)
  }
  return Object.freeze({ ...contribution })
}

export class AgentSidebarRegistry {
  private readonly registry = new ReactiveRegistryStore<AgentSidebarContribution>()

  register(identity: PluginIdentity, contribution: AgentSidebarContribution): AsyncDisposable {
    const normalized = validateContribution(contribution)
    return this.registry.register(identity, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<AgentSidebarContribution> {
    return this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  getSnapshot(): RegistrySnapshot<AgentSidebarContribution> {
    return this.registry.getSnapshot()
  }

  /** 按注册顺序（`order` 升序，同序由 Registry 的 owner/id 稳定决定）返回模块清单。 */
  list(): readonly AgentSidebarContribution[] {
    return this.registry.getSnapshot().entries.map(entry => entry.value)
  }
}
