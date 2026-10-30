import { describe, expect, it } from 'vitest'
import {
  FIRST_PARTY_STYLE_OWNERSHIP,
  listFirstPartyStylesByOwner,
} from '../firstPartyStyleOwnership.ts'

const expectedCssPaths = [
  'src/index.css',
  // J 施工书 20260914：pluginManagerPanel.css 已绞杀进 utilities 层，不再登记。
  // #491 绞杀恢复批：SkinPreviewBar.css 同批绞杀，不再登记。
  'src/plugins/product/packages/builtin.pylon-renderers/styles/adaptive.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css',
  // #699：现代模式行/中控样式层（plugin-scope，随渲染器插件回收）。
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.modern.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/StatusBar.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/App.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/SettingsCommon.css',
  'src/plugins/product/packages/builtin.pylon-gateway/styles/adaptive.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/adaptive.css',
  // 解耦评估批 2（issue #83）：FileSheet.css 的跨 sheet 共享词汇剥出为独立基座。
  'src/plugins/product/packages/builtin.pylon-workspace/styles/SheetVocabulary.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/components/right-panel/ContextPanel.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css',
  // 绞杀 P93 批 4：sheets/RuntimeSheetView.css 与 sheets/browser/BrowserSheet.css
  // 已绞杀进 utilities 层，不再登记。
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css',
  'src/renderers/solid-workbench/smoke/solidWorkbenchSmoke.css',
  // TW 施工书 20260914（P85）：Tailwind v4 utilities 基线，kernel-static。
  'src/styles/tailwind.css',
] as const

describe('first-party CSS ownership inventory', () => {
  it('为当前全部生产/Smoke CSS 建立且只建立一个 owner', () => {
    const paths = FIRST_PARTY_STYLE_OWNERSHIP.map(item => item.path)
    expect([...paths].sort()).toEqual([...expectedCssPaths].sort())
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('每个 CSS 记录至少一个唯一 importer', () => {
    for (const item of FIRST_PARTY_STYLE_OWNERSHIP) {
      expect(item.importers.length, item.path).toBeGreaterThan(0)
      expect(new Set(item.importers).size, item.path).toBe(item.importers.length)
      expect(item.importers.every(path => path.startsWith('src/')), item.path).toBe(true)
    }
  })

  it('Kernel 只持有跨 Application 基线，产品样式归属第一方插件', () => {
    expect(listFirstPartyStylesByOwner('kernel').map(item => item.path)).toEqual([
      'src/index.css',
      // TW 施工书 20260914（P85）：Tailwind utilities 基线为 kernel 级静态基线。
      'src/styles/tailwind.css',
      // -SkinPreviewBar.css（#491 绞杀恢复批：整文件绞杀进 utilities 层）。
    ])
    expect(listFirstPartyStylesByOwner('builtin.pylon-shell')).toHaveLength(4) // -PermissionDialog/-SessionOwnerRecoveryDialog/-ProfileEditor（已绞杀，P93）
    expect(listFirstPartyStylesByOwner('builtin.pylon-workspace')).toHaveLength(6) // -HistorySheet/-BrowserSheet/-RuntimeSheet（已绞杀，P93 批 2/4）；-PrismSheet.css（演示出树，#484）；+SheetVocabulary.css（共享词汇基座，issue #83）
    expect(listFirstPartyStylesByOwner('builtin.pylon-renderers')).toHaveLength(7) // -MessageSearchBar（已绞杀，J/绞杀流水线 20260914）；-PetCompanion.css（#483 宠物链删除）；+WorkbenchChrome.css（Solid 壳层过渡态）；+ChatView.modern.css（#699 现代模式样式层）
    expect(listFirstPartyStylesByOwner('builtin.pylon-gateway')).toHaveLength(1) // P77：gateway 样式随包迁移
  })

  it('产品 CSS 全部进入 PluginScope（或 adaptive 残量），Smoke 不进入生产 owner', () => {
    const productStyles = FIRST_PARTY_STYLE_OWNERSHIP.filter(item => item.owner.startsWith('builtin.'))
    // 样式绞杀地基（P92）：adaptive 是产品包合法生命周期（每包至多一个自适应残量）。
    // 解耦评估批 2（issue #83）：共享词汇基线独立为 SheetVocabulary.css，lifecycle=shared；
    // FileSheet.css 回落 plugin-scope。
    expect(productStyles.every(item => ['plugin-scope', 'adaptive', 'shared'].includes(item.lifecycle))).toBe(true)
    expect(productStyles.every(item => item.path.includes('/packages/'))).toBe(true)
    expect(listFirstPartyStylesByOwner('solid-smoke')).toEqual([
      expect.objectContaining({
        path: 'src/renderers/solid-workbench/smoke/solidWorkbenchSmoke.css',
        lifecycle: 'smoke-only',
      }),
    ])
  })
})
