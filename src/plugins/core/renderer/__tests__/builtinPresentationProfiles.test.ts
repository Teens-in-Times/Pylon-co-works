import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESENTATION_PROFILES } from '../builtinPresentationProfiles.ts'
import { validatePresentationProfile } from '../../../../plugin-runtime/presentation/presentationProfileRegistry.ts'
import { createPluginIdentity } from '../../../../plugin-runtime/pluginIdentity.ts'
import { getPresentationProfileRegistry } from '../../../../plugin-runtime/runtimeServices.ts'

// ★ #266 刀9~11：快照里原先还含 `inputMode` / `inputVariant` / `footerLayout` 三个 token ——
//   字段删除后这三项不再出现在 profile 定义里，快照同步（冻结的仍是「其余逐字不变」）。
const TERMINAL_CLASSIC_SNAPSHOT = {
  id: 'builtin.presentation.terminal-classic',
  label: '终端经典',
  description: '紧凑命令记录流、可读正文、CLI 输入和克制的工具状态。',
  family: 'terminal',
  order: 100,
  tokens: {
    msgStyle: 'terminal', messageLayout: 'classic', chatFont: 'mono', msgFont: 'system',
    msgLineHeight: 1.55, inputBg: 'rgba(0,0,0,0.02)',
    inputBorderColor: '', inputFocusBorder: 'rgba(0,0,0,0.22)', inputRadius: 0,
    assistantDot: false, toolIndicator: '●', toolIndicatorRun: 'circle', toolIndicatorOk: 'circle', toolIndicatorErr: 'circle', toolIndicatorGlow: 0,
    toolConnectorMode: 'none', spinnerFramePreset: 'ascii-line', spinnerVerbSet: 'engineering',
    cliHintMode: 'compact',
  },
  assets: { promptGlyph: '❯', runningGlyph: '●', completedGlyph: '●', failedGlyph: '●' },
}

// ★ #266 刀9~11：`inputMode` / `inputVariant` / `footerLayout` 三字段删除 ⇒ 从两份必需 token
//   清单里摘除（presentation profile 不再覆盖形态类字段，形态由固定实现决定）。
const COMPLETE_SURFACE_TOKENS = [
  'msgStyle', 'messageLayout', 'messageUserBg', 'messageAssistantBg', 'messageReasoningBg',
  'messageBorderColor', 'messageRadius', 'inputBg',
  'inputBorderColor', 'inputFocusBorder', 'inputRadius',
] as const

const COMPLETE_CC_INPUT_TOKENS = [
  'inputBg', 'inputBorderColor', 'inputFocusBorder',
  'inputRadius', 'cliHintMode',
] as const

describe('built-in terminal-like presentation profiles', () => {
  it('所有内置预设均可通过生产 PresentationProfileRegistry 校验', () => {
    for (const profile of BUILTIN_PRESENTATION_PROFILES) {
      expect(() => validatePresentationProfile(profile), profile.id).not.toThrow()
    }
  })

  it('冻结 terminal-classic 的完整定义，防止其他 Profile 施工改变经典终端', () => {
    expect(BUILTIN_PRESENTATION_PROFILES.find(profile => profile.id === 'builtin.presentation.terminal-classic')).toEqual(TERMINAL_CLASSIC_SNAPSHOT)
  })

  it('现代工作台是 modern-gui 的独立 Profile，不伪装成第五个终端风格', () => {
    expect(BUILTIN_PRESENTATION_PROFILES.find(profile => profile.id === 'builtin.presentation.modern-gui')).toMatchObject({
      family: 'gui',
      interfaceMode: 'modern-gui',
      tokens: { inputRadius: 20 },
    })
  })

  it.each([
    'builtin.presentation.terminal-modern',
    'builtin.presentation.paper-low-contrast',
    'builtin.presentation.console-glass',
  ])('%s 显式覆盖输入面与消息面的完整 token', profileId => {
    const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === profileId)
    expect(profile).toBeDefined()
    for (const token of COMPLETE_SURFACE_TOKENS) expect(profile?.tokens).toHaveProperty(token)
  })

it.each([
    ['builtin.presentation.agent-command', 'content.plan', { density: 'compact', defaultExpanded: true }],
    ['builtin.presentation.agent-map', 'activity.subagent', { viewMode: 'tree', identityMarker: 'avatar' }],
    ['builtin.presentation.focus-flow', 'activity.workflow', { workflowLayout: 'list', collapseCompleted: true }],
  ])('%s 提供可由 Solid renderer 消费的执行视图预设', (profileId, kind, expected) => {
    const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === profileId)
    expect(profile).toBeDefined()
    expect(profile?.kindTokens?.[kind]).toMatchObject(expected)
  })

  it.each(BUILTIN_PRESENTATION_PROFILES.map(profile => profile.id))('%s 显式覆盖中控与输入的必需 token', profileId => {
    const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === profileId)
    expect(profile).toBeDefined()
    for (const token of COMPLETE_CC_INPUT_TOKENS) expect(profile?.tokens).toHaveProperty(token)
  })
})

// ── #607 刀3b 新增：档案私路退役后，三张 Agent 卡的 kind 级外观仍按
//    「材料身份 → 注册表 → kindTokens」取数（本刀**零迁移**）。
//    指纹 = 键排序后的 JSON 串 ⇒ 材料或注册表任一环节变了都会红。 ──
const AGENT_CARD_KIND_TOKENS_FINGERPRINT: Readonly<Record<string, string>> = {
  'builtin.presentation.agent-command': '{"activity.background-task":{"density":"compact","workflowLayout":"lanes","workflowConnector":true,"collapseCompleted":false,"indent":14},"activity.delegation":{"density":"compact","viewMode":"cards","identityMarker":"glyph","showIdentity":true,"showAggregate":true,"defaultExpandedDepth":1,"cardWidth":1200,"indent":0},"activity.subagent":{"density":"compact","viewMode":"cards","identityMarker":"avatar","showIdentity":true,"showAggregate":true,"defaultExpandedDepth":1,"cardWidth":1200,"indent":0},"activity.team":{"density":"compact","viewMode":"cards","identityMarker":"avatar","showIdentity":true,"showAggregate":true,"defaultExpandedDepth":1,"cardWidth":1200,"indent":0},"activity.workflow":{"density":"compact","workflowLayout":"lanes","workflowConnector":true,"collapseCompleted":false,"indent":14},"activity.workflow-agent":{"density":"compact","workflowLayout":"lanes","workflowConnector":true,"collapseCompleted":false,"indent":14},"activity.workflow-phase":{"density":"compact","workflowLayout":"lanes","workflowConnector":true,"collapseCompleted":false,"indent":14},"content.plan":{"density":"compact","defaultExpanded":true,"collapseCompleted":false,"nodeGlyph":"status","connectorStyle":"solid","indent":18}}',
  'builtin.presentation.agent-map': '{"activity.background-task":{"density":"comfortable","workflowLayout":"timeline","workflowConnector":true,"collapseCompleted":true,"indent":24},"activity.delegation":{"density":"comfortable","viewMode":"tree","identityMarker":"glyph","treeLineStyle":"dashed","showIdentity":true,"showAggregate":true,"defaultExpandedDepth":2,"indent":28},"activity.subagent":{"density":"comfortable","viewMode":"tree","identityMarker":"avatar","treeLineStyle":"solid","showIdentity":true,"showAggregate":true,"defaultExpandedDepth":2,"indent":28},"activity.team":{"density":"comfortable","viewMode":"tree","identityMarker":"avatar","treeLineStyle":"solid","showIdentity":true,"showAggregate":true,"defaultExpandedDepth":2,"indent":28},"activity.workflow":{"density":"comfortable","workflowLayout":"timeline","workflowConnector":true,"collapseCompleted":true,"indent":24},"activity.workflow-agent":{"density":"comfortable","workflowLayout":"timeline","workflowConnector":true,"collapseCompleted":true,"indent":24},"activity.workflow-phase":{"density":"comfortable","workflowLayout":"timeline","workflowConnector":true,"collapseCompleted":true,"indent":24},"content.plan":{"density":"comfortable","defaultExpanded":true,"collapseCompleted":true,"nodeGlyph":"dot","connectorStyle":"dashed","indent":24}}',
  'builtin.presentation.focus-flow': '{"activity.background-task":{"density":"compact","workflowLayout":"list","workflowConnector":false,"collapseCompleted":true,"animateProgress":false,"indent":0},"activity.delegation":{"density":"compact","viewMode":"cards","identityMarker":"none","showIdentity":false,"showAggregate":false,"defaultExpandedDepth":0,"cardWidth":980,"indent":0},"activity.subagent":{"density":"compact","viewMode":"cards","identityMarker":"none","showIdentity":false,"showAggregate":false,"defaultExpandedDepth":0,"cardWidth":980,"indent":0},"activity.team":{"density":"compact","viewMode":"cards","identityMarker":"none","showIdentity":false,"showAggregate":false,"defaultExpandedDepth":0,"cardWidth":980,"indent":0},"activity.workflow":{"density":"compact","workflowLayout":"list","workflowConnector":false,"collapseCompleted":true,"animateProgress":false,"indent":0},"activity.workflow-agent":{"density":"compact","workflowLayout":"list","workflowConnector":false,"collapseCompleted":true,"animateProgress":false,"indent":0},"activity.workflow-phase":{"density":"compact","workflowLayout":"list","workflowConnector":false,"collapseCompleted":true,"animateProgress":false,"indent":0},"content.plan":{"density":"compact","defaultExpanded":false,"collapseCompleted":true,"nodeGlyph":"none","connectorStyle":"none","showPriority":false,"indent":12}}',
}

function kindTokensFingerprint(profileId: string): string | undefined {
  const kindTokens = getPresentationProfileRegistry().resolve(profileId)?.value.kindTokens
  if (!kindTokens) return undefined
  const canonical = Object.fromEntries(Object.entries(kindTokens).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return JSON.stringify(canonical)
}

describe('#607 刀3b · kindTokens 取数不变', () => {
  it('注册内置档案后，按材料身份取回的 kindTokens 与冻结指纹逐键相同', async () => {
    const owner = createPluginIdentity('test.builtin-profiles.kind-tokens', 'one')
    const registry = getPresentationProfileRegistry()
    const registrations = BUILTIN_PRESENTATION_PROFILES.map(profile => registry.register(owner, profile))
    try {
      expect(BUILTIN_PRESENTATION_PROFILES.filter(profile => profile.kindTokens)).toHaveLength(3)
      for (const [profileId, fingerprint] of Object.entries(AGENT_CARD_KIND_TOKENS_FINGERPRINT)) {
        expect(kindTokensFingerprint(profileId), profileId).toBe(fingerprint)
      }
    } finally {
      for (const registration of registrations) await registration.dispose()
    }
  })
})
