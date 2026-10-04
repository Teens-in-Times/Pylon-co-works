import type { RenderNodeSnapshot, RenderSurface } from '../../contracts/messageRenderer.ts'
import type { RegistryEntry } from '../registry/types.ts'
import type { RendererSettingsPlacement, RendererSettingsSchema } from './rendererSettingsTypes.ts'
import type { RenderKindDefinition } from './rendererTypes.ts'
import type { WorkbenchRendererFactory as PreparedWorkbenchRendererFactory } from './workbenchRendererFactory.ts'

export type RendererSuiteId = string

/**
 * A factory owns a complete Workbench implementation; it never receives raw stores.
 *
 * #520 S4-P2 收窄：历史上的「裸函数 factory」臂自 Suite Host（A13）起从未被实现
 * （host 对函数形态直接 throw），且无任何生产/测试消费者——函数臂与配套的
 * `WorkbenchRendererFactoryInput` 已删除，Suite factory 只剩 prepare 工厂对象一种形态。
 */
export type WorkbenchRendererFactory = PreparedWorkbenchRendererFactory

export interface RendererSuiteContribution {
  readonly id: RendererSuiteId
  readonly label: string
  readonly description?: string
  readonly apiVersion: 1
  readonly runtime: {
    readonly framework: 'solid'
    readonly version: string
  }
  readonly compatibility: {
    readonly documentSchema: string
    readonly renderCatalogSchema: number
  }
  readonly requiredKinds: readonly string[]
  readonly optionalKinds?: readonly string[]
  readonly fallbackSuiteId?: RendererSuiteId
  readonly settings?: RendererSettingsSchema
  readonly settingsPlacement?: RendererSettingsPlacement
  readonly factory: WorkbenchRendererFactory
}

export interface RendererSlotContribution {
  readonly id: string
  readonly label?: string
  readonly description?: string
  readonly targetSuites: readonly (RendererSuiteId | '*')[]
  readonly kinds: readonly string[]
  readonly priority: number
  readonly fallback: boolean
  readonly settings?: RendererSettingsSchema
  readonly settingsPlacement?: RendererSettingsPlacement
  canRender(input: RenderNodeSnapshot): boolean
  createSurface(input: RenderNodeSnapshot): RenderSurface
}

export interface RendererDiagnostic {
  readonly code: string
  readonly message: string
  readonly severity?: 'info' | 'warning' | 'error'
  readonly suiteId?: string
  readonly slotId?: string
  readonly kind?: string
}

export interface RendererActivationSnapshot {
  readonly revision: number
  readonly suite: RegistryEntry<RendererSuiteContribution>
  readonly kinds: ReadonlyMap<string, RegistryEntry<RenderKindDefinition>>
  readonly slots: ReadonlyMap<string, readonly RegistryEntry<RendererSlotContribution>[]>
  readonly diagnostics: readonly RendererDiagnostic[]
}
