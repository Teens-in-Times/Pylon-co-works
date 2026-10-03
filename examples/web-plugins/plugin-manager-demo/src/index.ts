/**
 * external.pylon-plugin-manager-demo — 外置管理器插件示例（P53 D4）。
 *
 * 与内嵌第 6 包 `builtin.pylon-plugin-manager` 共享同一套 framework-free
 * 面板 DOM 源（panel/pluginManagerPanel.ts 逐字复制，"同一 panel/ DOM 源"
 * 双形态要求）；差异只在装配方式：
 *   - manifest 声明 api 1.2 + capabilities: ['plugin.management']；
 *   - 设置页走 isolated-surface（surfaceId + SDK surface 协议）而非
 *     第一方薄壳——宿主第一方面是 first-party-solid（仅主构建内置），
 *     外置包用 isolated-surface / webcomponent 自带运行时；
 *   - 面板数据全部经 context.management（capability-gated；未授权时
 *     context.management 不存在，挂载授权引导）。
 */
import { createPluginLogger, definePlugin, type PluginUiSurface } from '@pylon/plugin-sdk'
import { mountPanel, type PanelManagement } from './panel'

const log = createPluginLogger('external.pylon-plugin-manager-demo')

export default definePlugin({
  async activate(context) {
    log.info('activate', context.identity.runtimeInstanceId)

    const management = context.management as PanelManagement | undefined

    // 安装目录选择由宿主对话框能力提供；外置包自身不 import tauri API。
    const panelSurface: PluginUiSurface = {
      id: 'external.pylon-plugin-manager-demo.panel',
      runtime: { framework: 'webcomponent', version: '1.0' },
      mount(container) {
        const handle = mountPanel(container, management, {
          onNotice: message => log.info(message),
        })
        return () => handle.dispose()
      },
    }
    context.ui.registerSurface(panelSurface)

    context.settings.registerPage({
      id: 'external.pylon-plugin-manager-demo.settings',
      label: '插件管理器（外置示例）',
      description: '同一 panel/ DOM 源的外置形态：安装/启停/重载/卸载与贡献面透视。',
      order: 910,
      renderKind: 'isolated-surface',
      surfaceId: panelSurface.id,
    })
  },

  async deactivate() {
    log.info('deactivated')
  },
})
