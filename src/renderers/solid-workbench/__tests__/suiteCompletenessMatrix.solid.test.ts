import { describe, expect, it } from 'vitest'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../domains/rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../../../domains/rendererContent/executionRenderKindCatalog.ts'
import { BUILTIN_INTERACTION_RENDER_KINDS } from '../../../domains/rendererContent/interactionRenderKindCatalog.ts'
import { BUILTIN_SESSION_RENDER_KINDS } from '../../../domains/rendererContent/sessionRenderKindCatalog.ts'
import { createBuiltinSolidRendererSuite, createBuiltinSolidContentSlot } from '../builtinSolidRendererSuite.ts'

/**
 * A17 步骤3：suite completeness matrix。
 * active Suite 必须声明 compatibility、required kinds、optional kinds（fallback/settings 由 catalog
 * definition 携带）；每个 kind 必须有 semantic definition 和最终 unknown 路径（fallbackKind 链）。
 */

// message.* kinds 由 App 消息主链直接消费（非 content Slot 面）；与 Suite optionalKinds 同口径过滤
const ALL_BUILTIN_KINDS = [
  ...BUILTIN_TEXT_RENDER_KINDS
    .filter(kind => !kind.id.startsWith('message.'))
    .map(kind => ({ id: kind.id, fallbackKind: 'fallbackKind' in kind ? (kind as { fallbackKind?: string }).fallbackKind : undefined })),
  ...BUILTIN_EXECUTION_RENDER_KINDS.map(kind => ({ id: kind.id, fallbackKind: (kind as { fallbackKind?: string }).fallbackKind })),
  ...BUILTIN_INTERACTION_RENDER_KINDS.map(kind => ({ id: kind.id, fallbackKind: kind.fallbackKind })),
  ...BUILTIN_SESSION_RENDER_KINDS.map(kind => ({ id: kind.id, fallbackKind: kind.fallbackKind })),
]

describe('A17 suite completeness matrix', () => {
  const suite = createBuiltinSolidRendererSuite()
  const slot = createBuiltinSolidContentSlot()

  it('active Suite 声明 compatibility / requiredKinds / optionalKinds / factory 四要素', () => {
    expect(suite.compatibility).toEqual({ documentSchema: 'workbench.v1', renderCatalogSchema: 1 })
    expect(suite.requiredKinds!.length).toBeGreaterThan(0)
    expect(suite.optionalKinds!.length).toBeGreaterThan(0)
    // factory 已塌缩为 PreparedWorkbenchRendererFactory 对象形态（函数臂随 #520 结构收敛删除）
    const factory = suite.factory as { prepare?: unknown }
    expect(typeof factory.prepare).toBe('function')
  })

  it('base Slot 覆盖全部内置 kind 且可渲染', () => {
    const slotKinds = new Set(slot.kinds)
    for (const { id } of ALL_BUILTIN_KINDS) {
      expect(slotKinds.has(id), `base Slot 缺 kind ${id}`).toBe(true)
    }
    expect(slot.fallback).toBe(true)
  })

  it('publishes every C11 interaction kind through the replaceable base Slot', () => {
    expect(BUILTIN_INTERACTION_RENDER_KINDS.map(kind => kind.id)).toEqual(expect.arrayContaining([
      'interaction.approval', 'interaction.questions', 'interaction.confirm', 'interaction.permission',
    ]))
    expect(createBuiltinSolidContentSlot().kinds).toEqual(expect.arrayContaining(
      BUILTIN_INTERACTION_RENDER_KINDS.map(kind => kind.id),
    ))
  })

  it('publishes every C12 interaction kind through the replaceable base Slot', () => {
    expect(BUILTIN_INTERACTION_RENDER_KINDS.map(kind => kind.id)).toEqual(expect.arrayContaining([
      'interaction.oauth', 'interaction.secret', 'interaction.sudo',
    ]))
    expect(createBuiltinSolidContentSlot().kinds).toEqual(expect.arrayContaining([
      'interaction.oauth', 'interaction.secret', 'interaction.sudo',
    ]))
  })

  it('publishes every C14 session and assist kind through the replaceable base Slot', () => {
    const ids = BUILTIN_SESSION_RENDER_KINDS.map(kind => kind.id)
    expect(ids).toEqual([
      'session.usage', 'session.budget', 'session.config', 'session.commands',
      'assist.prediction', 'assist.file-suggestions',
    ])
    expect(createBuiltinSolidRendererSuite().optionalKinds).toEqual(expect.arrayContaining(ids))
    expect(createBuiltinSolidContentSlot().kinds).toEqual(expect.arrayContaining(ids))
  })

  it('每个 kind 的 fallback 链最终可达 content.unknown', () => {
    const byId = new Map(ALL_BUILTIN_KINDS.map(k => [k.id, k]))
    for (const { id, fallbackKind } of ALL_BUILTIN_KINDS) {
      if (!fallbackKind) continue // content.unknown 自身无 fallback
      const visited = new Set([id])
      let current: string | undefined = fallbackKind
      while (current && !visited.has(current)) {
        visited.add(current)
        if (current === 'content.unknown') break
        current = byId.get(current)?.fallbackKind
      }
      expect(
        current === 'content.unknown' || current === undefined,
        `kind ${id} 的 fallback 链未达 content.unknown（停在 ${current}）`,
      ).toBe(true)
    }
  })

  it('requiredKinds 与 textRenderKindCatalog 完全一致（单一真值，无平行清单）', () => {
    expect([...suite.requiredKinds!].sort()).toEqual(
      [...BUILTIN_TEXT_RENDER_KINDS.map(kind => kind.id)].sort(),
    )
  })
})
