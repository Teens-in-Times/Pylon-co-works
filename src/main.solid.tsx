/** @jsxImportSource solid-js */
import { render } from 'solid-js/web'
import KernelRoot from './kernel/KernelRoot.solid.tsx'
import { bindSkinPersistence, restoreSkinFromStorage } from './infrastructure/skin/skinRuntimeServices'
import { installPylonCliBridge } from './cli/pylonCliBridge'
import { installPylonHookBridge } from './infrastructure/hooks/hookBridgeDispatcher'
import { installCanonicalHookProjection } from './application/hooks/canonicalHookProjection'
import { installCanonicalTouchedFileProjection } from './application/hooks/canonicalTouchedFileProjection'
import './index.css'
// Tailwind v4 utilities 基线（TW 施工书 20260914）：无 preflight，@theme inline
// 只读消费 index.css token；必须在 index.css 之后引入。
import './styles/tailwind.css'
import { startupMark } from './app/startupTiming'
import { applyFirstRunThemeSeed } from './app/bootstrap/firstRunThemeSeed'
// #488 批⑦：前端诊断日志统一出口——先于各桥安装，桥内诊断即可进 runtime log。
import { installTauriFrontendLogSink } from './infrastructure/tauri/frontendLogSink'

installTauriFrontendLogSink()

// #269：前端最早可插桩点（模块求值起点）——import 求值成本不计入，
// 与 performance.timeOrigin 的差值即脚本求值前开销。
startupMark('main_module_eval')
// CC-14 首启主题种子：此刻主题域 persist 已随模块求值**同步** rehydrate 完成，
// 而 KernelRoot 尚未挂载——App 挂载期的 ensureInterfaceModeProfile 等效果一跑就
// 会经 persist writeBack 落盘 pylon-theme（实测：种子挂 bootstrap hydrateDomains
// 尾部时已被抢先，判定失效）。所以种子必须在这里、render 之前判定；第二次启动
// pylon-theme 已存在 ⇒ no-op。
applyFirstRunThemeSeed()
// DEV-only 控制台钩子表（浏览器 mock 后端 + OBS-04~07 / CSS-01 取证钩子）：生产构建
// `import.meta.env.DEV` 恒 false，整个 if 块连同动态 import 被 tree-shake，零暴露；
// 各钩子内部再按 IS_TAURI 守卫，浏览器 mock 模式 no-op。安装顺序即表序（mock 后端
// 必须最先——后续钩子的 IS_TAURI 判定依赖 env.ts 在其静态 import 阶段冻结的结果）。
// 用法与各自取证语义见各 devTrigger 文件头文档。
const DEV_TRIGGER_INSTALLERS = [
  { id: 'mock-tauri', load: () => import('./demo/mockTauri').then(module => module.installMockTauri()) },
  { id: 'obs04-three-source-export', load: () => import('./devtools/obs/threeSourceExportTrigger').then(module => module.installObs04DevTrigger()) },
  { id: 'obs05-cold-start-snapshot', load: () => import('./devtools/obs/coldStartTrigger').then(module => module.installObs05DevTrigger()) },
  { id: 'obs06-delete-forensics', load: () => import('./devtools/obs/deleteForensicsTrigger').then(module => module.installObs06DevTrigger()) },
  { id: 'obs07-stderr-samples', load: () => import('./devtools/obs/stderrSamplesTrigger').then(module => module.installObs07DevTrigger()) },
  { id: 'css01-typography-baseline', load: () => import('./devtools/obs/typographyBaselineTrigger').then(module => module.installCss01DevTrigger()) },
] as const

if (import.meta.env.DEV) {
  for (const installer of DEV_TRIGGER_INSTALLERS) {
    void installer.load().catch(error => console.warn(`dev trigger ${installer.id} 安装失败`, error))
  }
}

// S5-F：先恢复 pylon-skins（committed skins/bindings/drafts），再挂载 UI。
// 恢复失败只告警，不阻断启动；现有 Theme Store 外观保持不变。
const skinRestoreError = restoreSkinFromStorage()
if (skinRestoreError) console.warn('pylon-skins 恢复失败', skinRestoreError)
bindSkinPersistence()
void installPylonCliBridge().catch(error => console.error('Pylon CLI bridge failed to start', error))
// P55-D1：kernel hook 桥 dispatcher（Rust 锚点 → 插件 handler 应答回路）。
void installPylonHookBridge().catch(error => console.error('Pylon hook bridge failed to start', error))
// API 1.3：canonical 事实 → turn.*/tool.* 观察锚点投影（durable-before-publish 订阅）。
installCanonicalHookProjection()
// 0-A0（#282）：canonical tool_call 事实 → 触碰文件管线（recordTouchedFile 生产端重接）。
installCanonicalTouchedFileProjection()

// #515：React 挂载点退役——Solid 单根直挂（无 StrictMode 等价物；开发期双跑
// 假设已随 React 退役，行为口径见 issue #515 批7 记录）。
void render(() => <KernelRoot />, document.getElementById('root')!)
