// P91 A4 收编：组件接线与入口边界的静态守卫合并检查
// （原 scripts/test-context-panel-selector.mts / test-context-panel.mts /
//   test-kernel-application-entry.mts 三脚本并入；对应行为已由
//   ContextPanelHost.solid.test、contextPanelRegistry.test、kernel/__tests__ 锁定，
//   本检查只锁接线结构与 selector 稳定性）
// #515 批7：被检对象随前端全量 Solid 化改指 `.solid.tsx` 实体；selector 稳定性守卫的
// 语义从「zustand v5 死循环防线」平移为「solidStoreBridge selector ⚠️ 约定」（selector
// 只读 store、派生留组件体 createMemo）——React 期的 useSyncExternalStore 快照判等
// 不复存在，但「selector 返回不稳定引用」仍会造成 solid 信号无谓重算，契约意图不变。

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

// ── 1. 右栏 selector 稳定引用（solidStoreBridge selector ⚠️ 约定：只读 store，派生留组件体）──

for (const path of ['src/components/right-panel/AgentContextPanel.solid.tsx', 'src/components/right-panel/FileContextPanel.solid.tsx']) {
  const source = read(path)
  // 整个 record 经稳定 selector 选取（store 通知间引用稳定），派生必须在组件体 memo。
  assert.match(source, /createZustandSignal\(useWorkspaceStore, s => s\.touchedFiles\)/, `${path} 必须选整个 touchedFiles record（稳定引用）`)
  assert.equal(
    /createZustandSignal\([^)]*touchedFiles\[source\] \?\? \[\]/.test(source),
    false,
    `${path} selector 不得含 \`?? []\`（新引用无谓重算）`,
  )
  assert.equal(
    /createZustandSignal\([^)]*touchedFiles\[source\][^)]*\]/.test(source),
    false,
    `${path} 不得在 selector 内做数组派生`,
  )
  if (path.includes('AgentContextPanel')) {
    assert.match(source, /touchedFilesRecord\(\)\[toAgentContextKey\(touchedContext\)\]/, `${path} 派生必须留组件体（I01-W3 context key）`)
  } else {
    // FileContextPanel（FE-AUD-022 反查）：activeFile 稳定 selector + sourcesForPath 组件体派生
    assert.match(source, /sourcesForPath\(touchedFilesRecord\(\), activeFile\(\)!\)/, `${path} 反查必须在组件体（sourcesForPath）`)
  }
}

// ── 2. 右栏贡献 Host/Registry 接线 ──

const host = read('src/components/right-panel/ContextPanelHost.solid.tsx')
const slot = read('src/components/right-panel/RightRailHost.solid.tsx')
const productWorkspace = read('src/plugins/product/builtinPylonWorkspace.ts')
const activation = read('src/plugin-runtime/pluginActivationContext.ts')
const shadow = read('src/plugin-runtime/shadowUpdate.ts')

assert.match(slot, /createZustandSignal\(useRightRailStore, state => state\.collapsed\)/, '全局右栏宿主必须读统一折叠状态')
assert.match(slot, /entries\(\)\.length > 0/, '无贡献时不得挂载')
assert.match(slot, /right-rail-host\$\{collapsed/, '折叠状态必须由右栏外壳承担，以支持宽度/透明度动画')
assert.match(slot, /data-collapsed=\{collapsed\(\) \? 'true' : 'false'\}/, '右栏外壳必须暴露折叠状态')
assert.match(slot, /<ContextPanelHost sheet=\{props\.sheet \?\? VIRTUAL_SHEET\} ctx=\{props\.ctx\} activePanelId=\{effectivePanelId\(\)\} \/>/, '宿主必须挂统一贡献 Host')
assert.match(host, /role="tablist"/, '多贡献必须以可访问标签切换')
// #520 S4-P1-5：分发块（错误边界 + isolated/first-party 分支 + Suspense）收进
// PluginContributionBody；宿主只保留数据投影与受控事件分诊。
const contributionBody = read('src/plugin-runtime/ui/PluginContributionBody.solid.tsx')
assert.match(host, /PluginContributionBody/, '右栏贡献分发必须走统一 PluginContributionBody')
assert.match(contributionBody, /PluginContributionBoundary/, '每个右栏贡献必须有独立错误边界')
assert.match(contributionBody, /renderKind === 'isolated-surface'/, '外置 UI 必须走隔离 surface')
assert.match(host, /event === 'host:collapse'/, '隔离 surface 只能通过受控事件请求宿主动作')
assert.match(productWorkspace, /workspaceKind: 'agent'/, 'Agent 右栏必须注册贡献')
assert.match(productWorkspace, /workspaceKind: 'file'/, 'File 右栏必须注册贡献')
assert.match(activation, /contextPanel: createPluginContextPanelApi/, '激活上下文必须暴露右栏贡献 API')
assert.match(shadow, /contextPanel: registries\.contextPanelRegistry\.beginShadowTransaction/, '右栏贡献必须参与 shadow hot-swap')

const agentPanel = read('src/components/right-panel/AgentContextPanel.solid.tsx')
assert.match(agentPanel, /createSessionUiSignal\(sessionUiStore, sessionId/, 'Agent 搜索必须复用统一 sessionUi 注册表（#520 S2-P1-1 双注册表归一）')
assert.match(agentPanel, /createHostDocument\(hostPort\)/, '消息快照必须经当前 Workbench Host Port')
assert.match(agentPanel, /createZustandSignal\(useWorkspaceStore, s => s\.touchedFiles\)/, 'Agent 关联必须读 touchedFiles')
assert.match(agentPanel, /touchedFilesRecord\(\)\[toAgentContextKey\(touchedContext\)\]/, 'Agent 关联必须使用 context key')
assert.match(agentPanel, /import MessageSearchBar from '\.\/MessageSearchBar\.solid\.tsx'/, 'Agent 搜索必须复用 MessageSearchBar 实体')
const filePanel = read('src/components/right-panel/FileContextPanel.solid.tsx')
assert.match(filePanel, /createZustandSignal\(useWorkspaceStore, s => s\.touchedFiles\)/, 'File 右栏必须反查 touchedFiles')

// ── 3. Kernel 入口边界（Solid 根永久由 KernelRoot 持有）──

const main = read('src/main.solid.tsx')
const kernelRoot = read('src/kernel/KernelRoot.solid.tsx')
const runtime = read('src/application/applicationRuntime.ts')
const bootstrap = read('src/kernel/kernelBootstrap.ts')
const shellPlugin = read('src/plugins/product/builtinPylonShell.ts')

assert.match(main, /import KernelRoot from '\.\/kernel\/KernelRoot\.solid\.tsx'/, 'main 必须导入 KernelRoot 实体')
assert.match(main, /render\(\(\) => <KernelRoot \/>, document\.getElementById\('root'\)!?\)?/, 'Solid 根必须挂载 KernelRoot')
assert.doesNotMatch(main, /<App \/>/, 'main 不得直接挂载 App')
assert.match(kernelRoot, /BUILTIN_PYLON_APPLICATION_ID = BUILTIN_PYLON_SHELL_ID/, '内置 Pylon Application 必须由 shell plugin 标识')
assert.match(shellPlugin, /lazy\(\(\) => import\('\.\.\/\.\.\/App\.solid\.tsx'\)\)/, 'App 必须由 shell plugin 延迟加载')
assert.match(shellPlugin, /application\.register\(\{ id: BUILTIN_PYLON_SHELL_ID, component: PylonApplication \}\)/, 'App 必须经 plugin-owned Application API 注册')
assert.match(kernelRoot, /bootstrap\(\)\.startNormal\(\)/, '启动时必须进入 Kernel bootstrap')
assert.match(bootstrap, /mountApplication\(BUILTIN_PYLON_SHELL_ID\)/, 'bootstrap 激活内置 shell 后必须挂载 Pylon Application')
assert.match(kernelRoot, /<ErrorBoundary/, 'Kernel 必须永久持有 ErrorBoundary')
assert.match(runtime, /getSnapshot:/, 'ApplicationRuntime 必须提供 snapshot')
assert.match(runtime, /subscribe:/, 'ApplicationRuntime 必须提供响应式 subscribe')

console.log('context panel 接线与 kernel 入口边界守卫通过')
