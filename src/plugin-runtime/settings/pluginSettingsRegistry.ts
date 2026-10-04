import { ValidatedContributionRegistry } from '../registry/validatedContributionRegistry.ts'
import type { PluginSettingsPageContribution } from './pluginSettingsTypes.ts'
import { normalizeSettingsSchema } from '../../contracts/rendererSettingsSchema.ts'

export function validatePluginSettingsPage(page: PluginSettingsPageContribution): PluginSettingsPageContribution {
  if (!page.id || page.id !== page.id.trim()) throw new Error('Plugin settings page id 非法')
  if (!page.label?.trim()) throw new Error(`Plugin settings page label 不能为空：${page.id}`)
  if (page.renderKind === 'first-party-solid' && typeof page.component !== 'function' && typeof page.component !== 'object') {
    throw new Error(`Plugin settings page component 非法：${page.id}`)
  }
  if (page.renderKind === 'isolated-surface' && !page.surfaceId?.trim()) {
    throw new Error(`Plugin settings page surfaceId 不能为空：${page.id}`)
  }
  return Object.freeze({ ...page, ...(page.schema ? { schema: normalizeSettingsSchema(page.schema) } : {}) })
}

function validateAdapterIdentity(ownerPluginId: string, contributionId: string, adapter: PluginSettingsPageContribution['valueAdapter']): void {
  if (!adapter) return
  if (adapter.namespace !== 'plugin-page') throw new Error(`Plugin settings page adapter namespace 不匹配：${contributionId}`)
  if (adapter.ownerPluginId !== undefined && adapter.ownerPluginId !== ownerPluginId) throw new Error(`Plugin settings page adapter ownerPluginId 不匹配：${contributionId}`)
  if (adapter.contributionId !== undefined && adapter.contributionId !== contributionId) throw new Error(`Plugin settings page adapter contributionId 不匹配：${contributionId}`)
}

export class PluginSettingsPageRegistry extends ValidatedContributionRegistry<PluginSettingsPageContribution> {
  constructor() {
    super((contribution, owner) => {
      const normalized = validatePluginSettingsPage(contribution)
      validateAdapterIdentity(owner.pluginId, normalized.id, normalized.valueAdapter)
      return normalized
    })
  }
}
