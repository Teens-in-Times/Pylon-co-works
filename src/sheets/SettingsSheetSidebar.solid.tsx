/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import type { WorkspaceViewProps } from '../plugin-runtime/workspaces/workspaceTypes.ts'
import { normalizeSettingsSheetState, type SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'
import {
  SETTINGS_DOMAINS,
  SETTINGS_DOMAIN_BY_ID,
  SETTINGS_DOMAIN_MENU_META,
  SETTINGS_SECTION_LABELS,
  HOSTED_PLUGIN_MANAGER_PAGE_ID,
  sectionZone,
  type SettingsDomainId,
  type SettingsSectionId,
} from '../components/settings/settingsDomains.ts'
import { GROUP_ORDER } from '../domains/theme/themeFieldDefs'
import { useThemeStore } from '../domains/theme/themeStore'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore.ts'
import { useSettingsChromeStore } from '../domains/appearance/settingsChromeStore.ts'
import { resetThemeForActiveInterfaceMode } from '../application/transactions/activateInterfaceMode.ts'
import { createPluginSettingsValueAdapter } from '../plugin-runtime/settings/pluginSettingsStore.ts'
import { getPluginSettingsPageRegistry, getPluginSettingsStore } from '../plugin-runtime/runtimeServices.ts'
import { pulseSettingsAnchor } from '../utils/anchorPulse.ts'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'

/**
 * Settings Sheet 左栏导航（#154 阶段 4：一二级同栏分层）。
 *
 * 上半：4 个一级域（大字号 + 字形）——旧覆盖层里域切换只存在于标题栏菜单，
 * 现在域与分区同栏；下半：当前域分区（小字号缩进，沿用分区/子组/置顶/插件页交互）；
 * 页脚：重置主题两段式确认（#116 子项 9 语义原样迁入）。
 * 几何（宽度/分割线/折叠）归布局层的 `.sidebar`，本组件只提供内容。
 * #515：实体自 React 版逐行为同构迁移；插件页列表与 Settings 主区共享注册表真值
 * （原 useSettingsContributionCatalog 的 pluginSettingsPages 切片，含 valueAdapter 包装）。
 */
export default function SettingsSheetSidebar(props: WorkspaceViewProps<SettingsSheetState>) {
  // 贡献插件设置页（registry 真值）：valueAdapter 包装语义与 React 侧 hook 逐行一致。
  const settingsPageRegistry = getPluginSettingsPageRegistry()
  const pluginSettingsStore = getPluginSettingsStore()
  const pageEntries = createRegistrySignal(settingsPageRegistry, () => settingsPageRegistry.getSnapshot().entries)
  const pluginSettingsPages = createMemo(() => pageEntries().map(entry => {
    if (!entry.value.schema || entry.value.valueAdapter) return entry
    return { ...entry, value: { ...entry.value, valueAdapter: createPluginSettingsValueAdapter({ store: pluginSettingsStore, ownerPluginId: entry.ownerPluginId, contributionId: entry.contributionId, namespace: 'plugin-page' }) } }
  }))
  // K-2：二级折叠导航展开态（session 内 UI 态；打开设置默认收起）
  const [navExpanded, setNavExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const toggleNavSection = (section: string) => {
    setNavExpanded(prev => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }
  // K-4：收藏置顶（拍板 D4-A hover 星标；上限 PINNED_LIMIT=3；A-V12 收敛 settingsChromeStore）
  const pinned = createZustandSignal(useSettingsChromeStore, s => s.pinned)
  // #116 子项 9：重置主题两段式确认（原 Settings.tsx 页脚语义整体迁入）
  const [confirmResetTheme, setConfirmResetTheme] = createSignal(false)
  const reset = () => { resetThemeForActiveInterfaceMode() }
  // 该区有自定义改动（dirty）时导航按钮带小圆点（store 真值，与字段编辑同步）
  const custom = createZustandSignal(useThemeStore, s => s.custom)

  const navigate = (partial: { domain?: SettingsDomainId; section?: SettingsSectionId; pluginPageId?: string | null; rendererCategoryId?: string | null }) => {
    useWorkspaceStore.getState().patchSheetState(props.sheet.id, normalizeSettingsSheetState({ ...props.state, ...partial }) as unknown as Record<string, unknown>)
  }
  // domain → 域配置。兜底第一个域：state 经 slot 响应式 prop 到达，sheet kind 切换的
  // 瞬间旧侧栏会先收到异 kind 的 state（无合法 domain）——map 直查得 undefined 会在
  // JSX 求值期抛 TypeError，炸掉整个更新波（实测整层切栏失效 + 应用级崩溃屏），
  // 必须在读取处收敛（#553）。
  const activeDomainConfig = () => SETTINGS_DOMAIN_BY_ID[props.state.domain] ?? SETTINGS_DOMAINS[0]!
  // section → 二级项。链A 从 GROUP_ORDER[zone] 派生；无 zone 或 <2 项返回空（不显示箭头）。
  // ★ #266 CC-09：中控台的二级项取**元件名**（`GROUP_ORDER.cc` 的 `heading`，源头是元件定义表
  //   `CC_WIDGET_GROUPS` 的行 label）—— 原先取 `block.groups`（子部件名）会把「中控本体面 /
  //   输入框本体 / 提示符 ❯ …」这类零件平铺一长串，与主区「元件 h3 → 子部件组」的层级对不上。
  //   其它 zone 的 block 没有 `heading`（仍是手写分组表），行为一字不动。
  const navGroupsFor = (section: SettingsSectionId): readonly { readonly id: string; readonly label: string }[] => {
    if (section === 'renderers') return []
    const zone = sectionZone(section)
    if (!zone) return []
    const labels = zone === 'cc'
      ? (GROUP_ORDER.cc ?? [])
        .map(block => block.heading)
        .filter((heading): heading is string => typeof heading === 'string' && heading.length > 0)
      : (GROUP_ORDER[zone] ?? []).flatMap(block => block.groups.map(group => group.title))
    return labels.length >= 2 ? labels.map(label => ({ id: label, label })) : []
  }
  const pluginNavPages = createMemo(() => props.state.domain === 'plugins'
    ? pluginSettingsPages()
      // #274：宿主「插件管理」分区在贡献存在时已直接渲染该页（Settings.tsx P53
      // 重定向），再列独立条目即同一页面双入口——托管的这条不再单列。
      .filter(entry => entry.contributionId !== HOSTED_PLUGIN_MANAGER_PAGE_ID)
    : [])

  return (
    <aside class="sidebar settings-sheet-nav">
      <nav class="settings-sheet-nav-domains" aria-label="设置域">
        <For each={SETTINGS_DOMAINS}>{domain => (
          <button
            type="button"
            class={`settings-sheet-nav-domain${props.state.domain === domain.id ? ' active' : ''}`}
            aria-current={props.state.domain === domain.id ? 'true' : undefined}
            onClick={() => navigate({ domain: domain.id, section: domain.sections[0] ?? 'global', pluginPageId: null })}
          >
            <span class="settings-sheet-nav-domain-glyph" aria-hidden="true">{SETTINGS_DOMAIN_MENU_META[domain.id].glyph}</span>
            <span class="settings-sheet-nav-domain-text">
              <strong>{domain.label}</strong>
              <small>{SETTINGS_DOMAIN_MENU_META[domain.id].description}</small>
            </span>
          </button>
        )}</For>
      </nav>

      <div class="settings-sheet-nav-sections">
        <div class="settings-nav-group settings-nav-sections">
          <Show when={pinned().length > 0}>
            <>
              <div class="settings-nav-label">常用</div>
              <For each={pinned()}>{section => (
                <button type="button" class="set-nav-btn pinned"
                  onClick={() => navigate({ section: section as SettingsSectionId, pluginPageId: null })}>
                  <span class="settings-nav-pin-star" aria-hidden="true">★</span>
                  {SETTINGS_SECTION_LABELS[section as SettingsSectionId]}
                </button>
              )}</For>
            </>
          </Show>
          <div class="settings-nav-label">{activeDomainConfig().label} 分区</div>
          <For each={activeDomainConfig().sections}>{section => {
            const zone = sectionZone(section)
            const subGroups = navGroupsFor(section)
            const expanded = () => navExpanded().has(section)
            const label = SETTINGS_SECTION_LABELS[section]
            const hasSub = subGroups.length > 0
            return (
              <div class="settings-nav-section-block">
                <div class="settings-nav-section-row">
                  <button type="button"
                    class={`set-nav-btn ${props.state.pluginPageId == null && props.state.section === section ? 'active' : ''}${zone && custom()[zone] ? ' dirty' : ''}`}
                    aria-expanded={hasSub ? expanded() : undefined}
                    onClick={() => {
                      navigate({ section, pluginPageId: null })
                      if (hasSub) toggleNavSection(section)
                    }}
                    title={zone && custom()[zone] ? '该区有未保存的自定义改动' : undefined}>
                    <Show when={hasSub}><span class="settings-nav-caret" aria-hidden="true">{expanded() ? '▾' : '▸'}</span></Show>
                    {label}
                  </button>
                  <button type="button" class={`settings-nav-pin${pinned().includes(section) ? ' pinned' : ''}`}
                    aria-label={pinned().includes(section) ? `取消置顶 ${label}` : `置顶 ${label}`}
                    aria-pressed={pinned().includes(section)}
                    onClick={e => { e.stopPropagation(); useSettingsChromeStore.getState().togglePinned(section) }}>★</button>
                </div>
                <Show when={hasSub && expanded()}>
                  <div class="settings-nav-subgroups">
                    <For each={subGroups}>{group => (
                      <button type="button"
                        class={`set-nav-btn subgroup${section === 'renderers' && props.state.rendererCategoryId === group.id ? ' active' : ''}`}
                        onClick={e => {
                          e.stopPropagation()
                          if (section === 'renderers') {
                            navigate({ rendererCategoryId: group.id })
                            return
                          }
                          navigate({ section, pluginPageId: null })
                          // 锚点滚动：主区渲染后按组标题定位（下一帧；两树同文档，querySelector 可达）
                          requestAnimationFrame(() => {
                            const target = document.querySelector(`[data-group-anchor="${CSS.escape(group.label)}"]`)
                            target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                            // O-2：高亮脉冲 1.2s（prefers-reduced-motion 时 CSS 端自动禁用动画）
                            pulseSettingsAnchor(target)
                          })
                        }}>
                        {group.label}
                      </button>
                    )}</For>
                  </div>
                </Show>
              </div>
            )
          }}</For>
          <For each={pluginNavPages()}>{entry => (
            <button type="button"
              class={`set-nav-btn plugin-page ${props.state.pluginPageId === entry.contributionId ? 'active' : ''}`}
              onClick={() => navigate({ pluginPageId: entry.contributionId })}
              title={entry.value.description}>
              <span>{entry.value.label}</span>
              <small>{entry.ownerPluginId}</small>
            </button>
          )}</For>
        </div>
      </div>

      <div class="settings-sheet-nav-footer">
        <Show when={confirmResetTheme()} fallback={
          <button type="button" class="set-nav-btn reset" onClick={() => setConfirmResetTheme(true)}>重置主题</button>
        }>
          <div class="set-confirm" role="alertdialog" aria-label="确认重置主题">
            <p class="set-confirm-text">重置主题会把当前外观（含手动改动）恢复为本界面模式的默认值，且不可撤销。</p>
            <div class="set-confirm-actions">
              <button type="button" class="ps-btn sm danger"
                onClick={() => { setConfirmResetTheme(false); reset() }}>确认重置</button>
              <button type="button" class="ps-btn sm"
                onClick={() => setConfirmResetTheme(false)}>取消</button>
            </div>
          </div>
        </Show>
      </div>
    </aside>
  )
}
