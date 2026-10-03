/**
 * ISSUE-13 W1（T13-1）settingsDomains 测试：
 * - 完整性：现有全部设置块唯一归属 domain/section（新增块必须同步登记）
 * - 唯一性：section 全局唯一，无跨 domain 重复归属
 * - 搜索路径：domain › section 路径唯一且格式正确
 * - 字段归属派生：SECTION_ZONES（zone → section）覆盖 Settings 渲染的全部主题 zone
 */
import { describe, expect, it } from 'vitest'
import {
  SECTION_ZONES,
  SETTINGS_DOMAIN_BY_ID,
  SETTINGS_DOMAINS,
  SETTINGS_SECTION_LABELS,
  domainOfSection,
  sectionZone,
  type SettingsSectionId,
  SECTION_OWNERS,
  PAGE_OWNED_SECTIONS,
  isPageOwnedSection,
  normalizeSettingsIntent,
  buildSettingsSearchIndex,
} from '../settingsDomains'
import { ZONES } from '../../../domains/theme/themeFieldDefs'

/** 当前 Settings 的全部设置块（Settings.tsx 各分区枚举；新增块必须在此登记） */
const EXPECTED_BLOCKS: readonly SettingsSectionId[] = [
  // 外观
  'templates', 'global', 'sidebar', 'chat', 'renderers', 'cc', 'right',
  // 工作区
  'window', 'history', 'backup',
  // Agent 与连接
  'agent', 'session', 'gateway', 'prediction',
  // 插件
  'pluginManager', 'hookDiagnostics',
]

const allSections = (): SettingsSectionId[] =>
  SETTINGS_DOMAINS.flatMap(domain => domain.sections)

describe('ISSUE-13 W1 domain config 完整性', () => {
  it('domain 形状：外观/工作区/Agent 与连接/插件，与参考方案一致', () => {
    expect(SETTINGS_DOMAINS.map(d => d.id)).toEqual(['appearance', 'workspace', 'agents-connections', 'plugins'])
    expect(SETTINGS_DOMAINS.map(d => d.label)).toEqual(['外观', '工作区', 'Agent 与连接', '插件'])
    expect(SETTINGS_DOMAINS.map(d => d.sections)).toEqual([
      ['templates', 'global', 'sidebar', 'chat', 'renderers', 'cc', 'right'],
      ['window', 'history', 'backup'],
      ['agent', 'session', 'gateway', 'prediction'],
      ['pluginManager', 'hookDiagnostics'],
    ])
  })

  it('全部设置块都登记且每块恰好归属一次（无遗漏、无重复）', () => {
    const sections = allSections()
    expect([...new Set(sections)]).toHaveLength(EXPECTED_BLOCKS.length)
    expect(new Set(sections)).toEqual(new Set(EXPECTED_BLOCKS))
    // 每个期望块至少出现一次且不重复
    for (const block of EXPECTED_BLOCKS) {
      const hits = sections.filter(s => s === block).length
      expect(hits).toBe(1)
    }
  })

  it('每个 section 都有非空中文标签', () => {
    for (const section of allSections()) {
      expect(SETTINGS_SECTION_LABELS[section].trim().length).toBeGreaterThan(0)
    }
  })

  it('section 唯一归属：domainOfSection 判定正确', () => {
    expect(domainOfSection('global')).toBe('appearance')
    expect(domainOfSection('chat')).toBe('appearance')
    expect(domainOfSection('window')).toBe('workspace')
    expect(domainOfSection('history')).toBe('workspace')
    expect(domainOfSection('agent')).toBe('agents-connections')
    expect(domainOfSection('gateway')).toBe('agents-connections')
    expect(domainOfSection('prediction')).toBe('agents-connections')
    expect(domainOfSection('pluginManager')).toBe('plugins')
  })

  it('config 完整性守卫：未登记的 section 抛错（防止静默缺失）', () => {
    expect(() => domainOfSection('nope' as SettingsSectionId)).toThrow(/未归属/)
  })
})

describe('ISSUE-13 W1 搜索路径', () => {
  it('SETTINGS_DOMAIN_BY_ID 与 SETTINGS_DOMAINS 一致', () => {
    for (const domain of SETTINGS_DOMAINS) {
      expect(SETTINGS_DOMAIN_BY_ID[domain.id]).toBe(domain)
    }
  })
})

describe('P6 Slice A 设置意图归一化', () => {
  it('旧 renderer/suite 深链落到外观 › 渲染器', () => {
    expect(normalizeSettingsIntent({ domain: 'renderer', section: 'suite' })).toEqual({
      domain: 'appearance', section: 'renderers',
    })
  })

  it('旧 section 别名映射到 canonical section，并以 section 归属校正 domain', () => {
    expect(normalizeSettingsIntent({ domain: 'workspace', section: 'conversation' })).toEqual({
      domain: 'appearance', section: 'chat',
    })
    expect(normalizeSettingsIntent({ domain: 'wrong', section: 'gateway' })).toEqual({
      domain: 'agents-connections', section: 'gateway',
    })
  })

  it('插件贡献页保留 page id，同时使用插件管理作为宿主 section', () => {
    expect(normalizeSettingsIntent({ domain: 'plugins', section: 'plugin.example.settings', agentId: 'peri' })).toEqual({
      domain: 'plugins', section: 'pluginManager', pluginPageId: 'plugin.example.settings', agentId: 'peri',
    })
  })

  it('顶层域入口不带 section 时落到该域首个分区', () => {
    expect(normalizeSettingsIntent({ domain: 'workspace' })).toEqual({
      domain: 'workspace', section: 'window',
    })
    expect(normalizeSettingsIntent({ domain: 'agents-connections' })).toEqual({
      domain: 'agents-connections', section: 'agent',
    })
    expect(normalizeSettingsIntent({ domain: 'plugins' })).toEqual({
      domain: 'plugins', section: 'pluginManager',
    })
  })

  it('未知入口回退到全局设置，不进入空白页', () => {
    expect(normalizeSettingsIntent({ domain: 'missing', section: 'missing' })).toEqual({
      domain: 'appearance', section: 'global',
    })
  })
})

describe('P6 Slice C 贡献注册表搜索投影', () => {
  it('插件设置页进入全局速搜，并保留可恢复的 page id', () => {
    const item = buildSettingsSearchIndex(undefined, [{
      contributionId: 'plugin.example.settings',
      value: { label: '示例插件设置', description: '说明' },
    }]).find(candidate => candidate.pluginPageId === 'plugin.example.settings')
    expect(item).toMatchObject({
      path: '插件 › 插件管理',
      label: '示例插件设置',
      section: 'pluginManager',
      kind: 'plugin-page',
      pluginPageId: 'plugin.example.settings',
    })
  })

  it('右栏插件可贡献设置入口并归入外观 › 右栏', () => {
    const item = buildSettingsSearchIndex(undefined, undefined, [{
      contributionId: 'plugin.context.files',
      value: { label: '文件面板', settings: { id: 'files-settings', label: '文件面板设置', section: 'right' } },
    }]).find(candidate => candidate.contextPanelId === 'plugin.context.files')
    expect(item).toMatchObject({
      path: '外观 › 右栏',
      label: '文件面板设置',
      section: 'right',
      kind: 'context-panel',
      contextPanelId: 'plugin.context.files',
    })
    const linked = buildSettingsSearchIndex(undefined, undefined, [{
      contributionId: 'plugin.context.files',
      value: { label: '文件面板', settings: { id: 'files-settings', label: '文件面板设置', pageId: 'plugin.context.files.settings' } },
    }]).find(candidate => candidate.pluginPageId === 'plugin.context.files.settings')
    expect(linked?.kind).toBe('plugin-page')
  })
})

describe('ISSUE-13 W1 字段归属派生', () => {
  it('Settings 渲染的主题 zone（global/sidebar/chat/cc/right）都经 SECTION_ZONES 归属 section', () => {
    const themed = ZONES.filter(zone => zone !== 'layout')
    for (const zone of themed) {
      const section = (Object.keys(SECTION_ZONES) as SettingsSectionId[])
        .find(s => SECTION_ZONES[s] === zone)
      expect(section, `zone ${zone} 应归属某 section`).toBeDefined()
    }
  })

  it('SECTION_ZONES 的键都是合法 section、值都是合法 zone', () => {
    const validSections = new Set(allSections())
    for (const [section, zone] of Object.entries(SECTION_ZONES)) {
      expect(validSections.has(section as SettingsSectionId)).toBe(true)
      expect(ZONES).toContain(zone)
    }
  })

  it('sectionZone 对主题 section 返回 zone，非主题返回 undefined', () => {
    expect(sectionZone('cc')).toBe('cc')
    expect(sectionZone('sidebar')).toBe('sidebar')
    expect(sectionZone('templates')).toBeUndefined()
    expect(sectionZone('window')).toBeUndefined()
    expect(sectionZone('gateway')).toBeUndefined()
  })
})

describe('S5 Owner 正式化（施工书 06 §S5）', () => {
  it('SECTION_OWNERS 主题 section 映射到组件 owner', () => {
    expect(SECTION_OWNERS.global).toBe('app-shell')
    expect(SECTION_OWNERS.sidebar).toBe('sidebar')
    expect(SECTION_OWNERS.chat).toBe('message-stream')
    expect(SECTION_OWNERS.cc).toBe('control-center')
    expect(SECTION_OWNERS.right).toBe('context-panel')
    expect(SECTION_OWNERS.renderers).toBe('renderer-catalog')
  })
  it('PAGE_OWNED_SECTIONS 四项且 isPageOwnedSection 判定正确', () => {
    expect(PAGE_OWNED_SECTIONS).toEqual(['templates', 'window', 'history', 'backup'])
    expect(isPageOwnedSection('templates')).toBe(true)
    expect(isPageOwnedSection('chat')).toBe(false)
  })
})

describe('B3.1 Owner 表与页面自有表零交集（边界探针）', () => {
  it('SECTION_OWNERS 与 PAGE_OWNED_SECTIONS 无交集', () => {
    const owners = Object.keys(SECTION_OWNERS)
    for (const s of PAGE_OWNED_SECTIONS) {
      expect(owners, s + ' 不能同时属于 owner 与 page-owned').not.toContain(s)
    }
  })
})
