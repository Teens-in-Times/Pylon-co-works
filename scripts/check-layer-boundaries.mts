/**
 * 分层边界门禁（结构审查 B-1/B-2/B-3 的机器化收尾 + #489 分层规则补全）。
 *
 * 仓库此前只有 renderer 专项架构检查（check-renderer-architecture）与 runtime 边界
 * （check-runtime-boundaries，管 invoke/store/CustomEvent）；本脚本补上「目录分层」
 * 这一维：视图层（components/sheets/workspace-sheets/renderers）与三层非视图代码
 * （domains / plugin-runtime / infrastructure）以及 contracts 之间的 import 禁令。
 *
 * #489 起纳入（2026-10-01 维护者批准的三条规则，见 issue #489；审计证据 §3.3/§3.6 在
 * 不入库的 2026-10-01 结构审查工作文档）：
 * 1. infrastructure 不得 import domains 的运行时值（`import type` type-only 边豁免）；
 * 2. kernel 只能被 app 挂载：domains 与视图层不得 import src/kernel/**；kernel 自身对
 *    app/application/plugin-runtime/infrastructure 的既有引用按 bootstrap 装配语义豁免；
 * 3. host/app/cli/application 纳管：domains 不得依赖四者（批准的最低限度）；按现状
 *    依赖图核准，cli/application/app 亦不得 import 视图层（存量各留豁免）。
 *
 * 存量违规一律「豁免表 + 理由」起步（先立规后清债），不允许借立规一次性大改道。
 * 每条豁免必须带理由注释（who/why），新增豁免 = 显式评审动作；豁免表带陈旧检测——
 * 条目对应的违规边消失后（改道/搬迁）必须同步删条，防止死豁免长期占位。
 *
 * #520 结构收敛批 H 域纳入（2026-10-03，审查 §1「门禁缺口」条款 2，先豁免后清偿）：
 * 4. infrastructure → plugin-runtime（存量 20 边全豁免）；
 * 5. domains → plugin-runtime 运行时值边（type-only 豁免；存量 17 边）；
 * 6. infrastructure → app（存量 7 边；plugin-runtime → app/runtimeError 仍按下行清单不设防）；
 * 7. plugins → 视图层（core 除外；存量 1 边）——src/plugins/core/** 的反向边
 *    （core 焊死视图组件）由 check-product-contribution-boundary.mts 按符号级划线
 *    体系管辖（#485 同源），不在此重复登记。
 *
 * 负向验证：新增本文件时曾以临时违规 fixture 验证能红，后删除；#489 三条规则同法复验。
 *
 * 刻意不管清单（本脚本明示不设防的方向，出现漂移先在此表态再考虑立规）：
 * - src/sdk/、src/utils/、src/devtools/、src/demo/、src/test-utils/ 与 src/test/、
 *   src/wasm/、src/assets|styles|css01 作为「源侧」不受管辖（SDK/演示/测试/产物层；
 *   src/plugins/ 源侧已随 #520 条款 7 部分纳管）。
 * - 根入口 src/main.solid.tsx、src/App.solid.tsx 是组合根，不设独立规则（#515 批7 改名）。
 * - 视图层 → src/app/**（视图消费 app 客户端/错误中心，现存约 77 边）、视图层 → src/host/**
 *   （renderer-suite 渲染套件消费面；SolidMount 挂载桥已随 #520 终局批删除，
 *   solidStoreBridge 已迁 infrastructure/state 作在役读取原语——视图层 → infrastructure 同不设防）、
 *   host → domains（renderer-suite 读域事件/预测语义）、
 *   plugin-runtime → src/app/runtimeError（错误上报口；infrastructure → app 已随 #520 纳管，
 *   plugin-runtime 侧仍不设防）。
 * - kernel → 视图层（KernelRoot.tsx 引 ErrorBoundary/SkinPreviewBar，2 边）与
 *   kernel → plugins（productPluginIds 常量，2 边）：#489 批准条文未含，暂不设防。
 * - plugin-runtime → kernel（pluginManagementWiring.ts 的 KernelBootstrap type-only 1 边）：
 *   不在批准的「domains + 视图层」条文内。
 * - 同层互引（domains→domains、kernel→kernel 等）不设防。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

function gitTrackedSrcFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files', 'src'], { cwd: projectRoot, encoding: 'utf8' })
    return out.split('\n').map(s => s.trim()).filter(Boolean)
      .filter(p => /\.(?:ts|tsx|mts)$/.test(p))
      .filter(p => !p.includes('__tests__/') && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'))
      .map(p => resolve(projectRoot, p))
      // ls-files 按 index 列文件：工作树已删（未提交的删除）会 ENOENT，跳过。
      .filter(p => { try { return statSync(p).isFile() } catch { return false } })
  } catch {
    // 非 git 环境退回全量扫描
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (/\.(?:ts|tsx|mts)$/.test(e.name)) files.push(p)
      }
    }
    // 同步退路：够用即可（门禁在 git 环境运行）
    const walkSync = (dir: string): void => {
      for (const e of readdirSyncShim(dir)) {
        const p = resolve(dir, e)
        if (statSyncShim(p).isDirectory()) walkSync(p)
        else if (/\.(?:ts|tsx|mts)$/.test(e.name)) files.push(p)
      }
    }
    walkSync(resolve(projectRoot, 'src'))
    void walk
    return files.filter(p => !p.includes('__tests__') && !/\.test\.[tj]sx?$/.test(p))
  }
}
import { readdirSync, statSync } from 'node:fs'
function readdirSyncShim(dir: string): string[] { return readdirSync(dir) }
function statSyncShim(p: string): import('node:fs').Stats { return statSync(p) }

/** 分层规则：scope（目录前缀）→ 禁止解析落入的路径前缀。豁免 = 白名单 + 理由。 */
interface LayerRule {
  label: string
  scopeRoots: string[]
  /** scope 内再剔除的前缀（如 plugins/core 反向划线由 check-product-contribution-boundary 管辖）。 */
  scopeExcludes?: string[]
  forbiddenPathIncludes: string[]
  allowlist: Record<string, string> // 文件级豁免：file（相对路径, '/' 分隔）→ 理由（豁免该文件全部违规边）
  allowEdges?: Record<string, string> // 边级豁免：`${file} -> ${target}` → 理由
  typeOnlyExempt?: boolean // import type / export type / 全 inline type 的边不设防（#489 规则 1）
}

const VIEW_DIRS = ['src/components/', 'src/sheets/', 'src/workspace-sheets/', 'src/renderers/']

const RULES: LayerRule[] = [
  {
    label: 'domains → 视图层',
    scopeRoots: ['src/domains/'],
    forbiddenPathIncludes: VIEW_DIRS,
    // 结构全修批搬迁后 chat 三件已无视图层 import，原文件级豁免经 #489 陈旧检测确认死条目移除。
    allowlist: {},
  },
  {
    label: 'plugin-runtime → 视图层',
    scopeRoots: ['src/plugin-runtime/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {
    },
  },
  {
    label: 'infrastructure → 视图层',
    scopeRoots: ['src/infrastructure/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {},
  },
  {
    label: 'contracts → 实现',
    scopeRoots: ['src/contracts/'],
    forbiddenPathIncludes: ['src/components/', 'src/sheets/', 'src/workspace-sheets/', 'src/renderers/', 'src/plugin-runtime/', 'src/infrastructure/'],
    // contracts/sheets.ts 对 domains/identity Session 的引用是 type-only 边，且 domains 不在本条
    // 禁令集合内——原两条 allowlist 条目经 #489 陈旧检测确认永不触发，移除（纪律文本见上头注）。
    allowlist: {},
  },
  {
    // #489 规则 1：传输/仓储等基础设施不得反向消费领域的运行时值；type-only 边按批准条文豁免。
    // 存量运行时值依赖（审计 §3.3 实录的 superset，以本门禁的分类为准）全部边级豁免，清偿时逐条删。
    label: 'infrastructure → domains（运行时值）',
    scopeRoots: ['src/infrastructure/'],
    forbiddenPathIncludes: ['src/domains/'],
    typeOnlyExempt: true,
    allowlist: {},
    allowEdges: {
      // —— acp 传输层消费领域归一/探测语义（审计 §3.3 实录；transport 注入改道待清偿，
      //    范本 domains/workbench/workbenchCommandFacade.ts:265 / domains/export/threeSourceExport.ts:226）
      'src/infrastructure/acp/agentClient.ts -> src/domains/agent/agentDetector.ts': 'acp 传输层消费 agent 探测语义（改道待清偿）',
      'src/infrastructure/acp/agentClient.ts -> src/domains/agent/candidateValidation.ts': 'acp 传输层消费候选校验语义（改道待清偿）',
      'src/infrastructure/acp/permissionController.ts -> src/domains/permission/permissionState.ts': 'acp 审批控制器消费审批状态语义（改道待清偿）',
      'src/infrastructure/acp/permissionController.ts -> src/domains/activity/interaction.ts': 'acp 审批控制器消费 interaction 归一（审计 §3.3 点名；改道待清偿）',
      'src/infrastructure/acp/sessionClient.ts -> src/domains/overview/persistedSessions.ts': 'acp 会话客户端消费持久会话契约（改道待清偿）',
      // —— canonical 事件仓储/游标/feed 消费事件 schema 与行构造（schema 单源在 domains/events；下沉待清偿）
      'src/infrastructure/events/canonicalEventCursor.ts -> src/domains/events/eventSchema.ts': '事件游标消费事件 schema（下沉待清偿）',
      'src/infrastructure/events/canonicalEventCursor.ts -> src/domains/events/canonicalEventRow.ts': '事件游标消费行构造（下沉待清偿）',
      'src/infrastructure/events/canonicalEventFeed.ts -> src/domains/events/eventSchema.ts': '事件 feed 消费事件 schema（下沉待清偿）',
      'src/infrastructure/events/canonicalEventRepository.ts -> src/domains/events/canonicalEventRow.ts': '事件仓储消费行构造（下沉待清偿）',
      // —— 仓储实现消费域侧持久化契约/store（#448 写穿链落位形态；端口化待清偿）
      'src/infrastructure/persistence/customPresetRepository.ts -> src/domains/theme/customPresetStore.ts': '预设仓储消费主题预设 store 语义（端口化待清偿）',
      'src/infrastructure/persistence/inputPredictionSettingsRepository.ts -> src/domains/inputPrediction/inputPredictionSettingsCache.ts': '预测设置仓储消费域缓存（#463 写穿链落位形态）',
      'src/infrastructure/persistence/inputPredictionSettingsRepository.ts -> src/domains/inputPrediction/inputPredictionSettings.ts': '预测设置仓储消费域设置语义（端口化待清偿）',
      'src/infrastructure/persistence/retentionPolicyRepository.ts -> src/domains/overview/retentionPolicy.ts': '保留策略仓储消费域策略语义（端口化待清偿）',
      // identityBackendSync/workspaceEntityStore 的条目已随 #520 G 域端口化/迁域清偿删除
      // （identityBackendSync 改经 identityBackendSyncPort 装配注入契约；workspaceEntityStore
      // 迁 domains/workspace 并经 workspaceActiveAgentPort 注入 activeAgent）。
      // —— 其余散点
      'src/infrastructure/state/solidSheetSupport.solid.tsx -> src/domains/interface/interfaceModeStore.ts': 'Solid 界面模式回退读 interfaceModeStore（#520 R3 自 sheets 迁入的既有依赖，非新引；回退表单源在 domains/interface）',
      'src/infrastructure/hooks/hookBridgeDispatcher.ts -> src/domains/identity/identityStore.ts': 'hook 调度桥读 identity store 运行时实例（结构全修批前既有形态）',
      'src/infrastructure/prediction/predictionStandalone.ts -> src/domains/inputPrediction/inputPredictionSettingsCache.ts': '预测降级实现消费预测设置缓存（端口化待清偿）',
      'src/infrastructure/skin/skinRuntimeServices.ts -> src/domains/theme/themeDefaults.ts': '皮肤运行时读主题出厂表（数据单源在 theme 域）',
      'src/infrastructure/skin/skinRuntimeServices.ts -> src/domains/theme/themeFieldDefs.ts': '皮肤运行时读主题字段表（数据单源在 theme 域）',
      'src/infrastructure/tauri/workspaceClient.ts -> src/domains/workspace/workspaceEntities.ts': 'workspace IPC 客户端消费实体契约（值混于类型面，拆分待清偿）',
    },
  },
  {
    // #520 H 域条款 7：plugins → 视图层。src/plugins/core/** 的反向边（core 焊死视图
    // 组件，审查 S1-P1 点名 10 边）由 check-product-contribution-boundary.mts 按 #485
    // 划线体系管辖，此处 scope 剔除以免双重登记；本条管 core 以外的插件源侧。
    label: 'plugins → 视图层（core 除外）',
    scopeRoots: ['src/plugins/'],
    scopeExcludes: ['src/plugins/core/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {},
    allowEdges: {
      'src/plugins/product/builtinPylonRenderers.ts -> src/renderers/solid-workbench/builtinSolidRendererSuite.ts': '产品渲染器声明直连 solid 渲染套件入口（#520 H 实扫 1 边；改经注册表消费待清偿）',
    },
  },
  {
    // #520 H 域条款 6：infrastructure → app（审查 S1-P1「7 条运行时边无规则管辖」）。
    // 6 条经 app/runtimeError 上报错误（错误口下沉待清偿）+ solidSheetSupport 读界面模式回退表。
    label: 'infrastructure → app',
    scopeRoots: ['src/infrastructure/'],
    forbiddenPathIncludes: ['src/app/'],
    allowlist: {},
    allowEdges: {
      'src/infrastructure/acp/interactionRejectionController.ts -> src/app/runtimeError.ts': '错误上报口现居 app（错误口下沉待清偿）',
      'src/infrastructure/acp/permissionController.ts -> src/app/runtimeError.ts': '错误上报口现居 app（错误口下沉待清偿）',
      'src/infrastructure/events/canonicalEventFeed.ts -> src/app/runtimeError.ts': '错误上报口现居 app（错误口下沉待清偿）',
      'src/infrastructure/persistence/customPresetRepository.ts -> src/app/runtimeError.ts': '错误上报口现居 app（错误口下沉待清偿）',
      'src/infrastructure/persistence/identityBackendSync.ts -> src/app/runtimeError.ts': '错误上报口现居 app（错误口下沉待清偿）',
      'src/infrastructure/persistence/inputPredictionSettingsRepository.ts -> src/app/runtimeError.ts': '错误上报口现居 app（错误口下沉待清偿）',
      'src/infrastructure/state/solidSheetSupport.solid.tsx -> src/app/interfaceModeLookup.ts': '界面模式回退表现居 app（#520 R3 随 solidSheetSupport 迁入形态；下沉待清偿）',
    },
  },
  {
    // #520 H 域条款 5：domains → plugin-runtime 运行时值边（审查 S1-P1 实录 19 条，
    // identity 域端口化清偿后实存 17）。type-only 边按 #489 规则 1 同款条文豁免。
    label: 'domains → plugin-runtime（运行时值）',
    scopeRoots: ['src/domains/'],
    forbiddenPathIncludes: ['src/plugin-runtime/'],
    typeOnlyExempt: true,
    allowlist: {},
    allowEdges: {
      // —— 服务定位器直连（runtimeServices；端口注入改道待清偿，范本
      //    domains/workbench/workbenchCommandFacade.ts:265 注入式）
      'src/domains/events/messageProjection.ts -> src/plugin-runtime/runtimeServices.ts': '事件投影经服务定位器读渲染注册面（端口注入待清偿）',
      'src/domains/export/threeSourceExport.ts -> src/plugin-runtime/runtimeServices.ts': 'three 导出经服务定位器读渲染注册面（端口注入待清偿）',
      'src/domains/identity/identitySessionActions.ts -> src/plugin-runtime/runtimeServices.ts': 'identity 会话动作经服务定位器读会话创建面（#520 G 域端口化残留；装配上移待清偿）',
      'src/domains/rendererContent/rendererContentRegistry.ts -> src/plugin-runtime/runtimeServices.ts': '渲染内容注册表经服务定位器读渲染注册面（端口注入待清偿）',
      'src/domains/rendererContent/textRenderKindCatalog.ts -> src/plugin-runtime/runtimeServices.ts': '文本渲染种类目录经服务定位器读渲染注册面（端口注入待清偿）',
      'src/domains/rendererContent/textRenderKindCatalog.ts -> src/plugin-runtime/pluginIdentity.ts': '文本渲染种类目录读插件身份常量（常量下沉待清偿）',
      'src/domains/search/searchService.ts -> src/plugin-runtime/runtimeServices.ts': '搜索服务经服务定位器读渲染注册面（端口注入待清偿）',
      'src/domains/session/sessionStateSync.ts -> src/plugin-runtime/runtimeServices.ts': '会话状态同步经服务定位器读注册面（端口注入待清偿）',
      'src/domains/theme/presetActions.ts -> src/plugin-runtime/runtimeServices.ts': '主题预设动作经服务定位器读皮肤注册面（端口注入待清偿）',
      'src/domains/tool/toolPresentation.ts -> src/plugin-runtime/runtimeServices.ts': '工具演示面经服务定位器读渲染注册面（端口注入待清偿）',
      // —— 会话创建快照编译（#520 G 域 identity 端口化落位形态：域侧直读 plugin-runtime 实现）
      'src/domains/identity/identitySessionActions.ts -> src/plugin-runtime/session-creation/compileSessionCreationSnapshot.ts': 'identity 端口化残留：直读会话创建快照编译（装配上移 app 待清偿）',
      'src/domains/identity/sessionPersistence.ts -> src/plugin-runtime/session-creation/compileSessionCreationSnapshot.ts': 'identity 端口化残留：直读会话创建快照编译（装配上移 app 待清偿）',
      'src/domains/identity/identityPluginDataPort.ts -> src/plugin-runtime/sessionData/sessionDataPort.ts': 'identity 插件数据端口直读 plugin-runtime 端口实现（#520 G 域落位形态；TODO 装配上移待清偿）',
      // —— workspace 注册表直连（sheet 三件套 + store；端口注入待清偿）
      'src/domains/workspace/sheetPersistence.ts -> src/plugin-runtime/workspaces/workspaceRegistry.ts': 'sheet 持久化直读 workspace 注册表（端口注入待清偿）',
      'src/domains/workspace/sheetRegistry.ts -> src/plugin-runtime/workspaces/workspaceRegistry.ts': 'sheet 注册表互读 workspace 注册表（端口注入待清偿）',
      'src/domains/workspace/sheetState.ts -> src/plugin-runtime/workspaces/workspaceRegistry.ts': 'sheet 状态直读 workspace 注册表（端口注入待清偿）',
      'src/domains/workspace/workspaceStore.ts -> src/plugin-runtime/workspaces/workspaceRegistry.ts': 'workspace store 直读 workspace 注册表（端口注入待清偿）',
    },
  },
  {
    // #520 H 域条款 4：infrastructure → plugin-runtime（审查 S1-P1 实录「反向 21 边」，
    // 去重后 20 边：pluginEventBusHost/fonts/hooks/skin 群 + solidSheetSupport）。
    label: 'infrastructure → plugin-runtime',
    scopeRoots: ['src/infrastructure/'],
    forbiddenPathIncludes: ['src/plugin-runtime/'],
    allowlist: {},
    allowEdges: {
      // —— 插件事件总线（事件总线的插件侧挂接；端口化待清偿）
      'src/infrastructure/events/pluginEventBusHost.ts -> src/plugin-runtime/pluginIdentity.ts': '插件事件总线读插件身份标识（端口化待清偿）',
      'src/infrastructure/events/pluginEventBusHost.ts -> src/plugin-runtime/runtimeServices.ts': '插件事件总线经服务定位器取注册面（端口化待清偿）',
      // —— 字体投影
      'src/infrastructure/fonts/fontProjection.ts -> src/plugin-runtime/registry/types.ts': '字体投影读贡献注册类型面（type 边；注册面收敛待清偿）',
      'src/infrastructure/fonts/fontProjection.ts -> src/plugin-runtime/fonts/fontContributionRegistry.ts': '字体投影直读字体贡献注册表（端口化待清偿）',
      // —— hook 桥
      'src/infrastructure/hooks/hookBridgeDispatcher.ts -> src/plugin-runtime/runtimeServices.ts': 'hook 桥经服务定位器取 hook 注册面（端口化待清偿）',
      'src/infrastructure/hooks/hookBridgeDispatcher.ts -> src/plugin-runtime/hooks/hookTypes.ts': 'hook 桥读 hook 贡献契约类型（契约下沉待清偿）',
      // —— 插件包客户端
      'src/infrastructure/plugins/pluginPackageClient.ts -> src/plugin-runtime/packageManifest.ts': '插件包客户端读包清单类型（type 边；管理域收敛待清偿）',
      // —— skin 群（skin 子域契约/校验/运行时被 infra 直读；skin 管理域收敛待清偿）
      'src/infrastructure/skin/skinHostPorts.ts -> src/plugin-runtime/skin/skinCommandApi.ts': '皮肤宿主端口读 skin 命令 API 类型（type 边）',
      'src/infrastructure/skin/skinHostPorts.ts -> src/plugin-runtime/skin/skinTypes.ts': '皮肤宿主端口读 skin 契约类型（type 边）',
      'src/infrastructure/skin/skinHostPorts.ts -> src/plugin-runtime/skin/skinRuntime.ts': '皮肤宿主端口读 skin 运行时类型（type 边）',
      'src/infrastructure/skin/skinPersistence.ts -> src/plugin-runtime/skin/skinValidation.ts': '皮肤持久化直连 skin 校验（下沉待清偿）',
      'src/infrastructure/skin/skinPersistence.ts -> src/plugin-runtime/skin/skinRuntime.ts': '皮肤持久化直连 skin 运行时（端口化待清偿）',
      'src/infrastructure/skin/skinPersistence.ts -> src/plugin-runtime/skin/skinTypes.ts': '皮肤持久化读 skin 契约类型（type 边）',
      'src/infrastructure/skin/skinProjection.ts -> src/plugin-runtime/skin/skinTypes.ts': '皮肤投影读 skin 契约类型（type 边）',
      'src/infrastructure/skin/skinRuntimeServices.ts -> src/plugin-runtime/skin/skinRuntime.ts': '皮肤运行时服务直连 skin 运行时实现（端口化待清偿）',
      'src/infrastructure/skin/useSkinSurface.solid.ts -> src/plugin-runtime/skin/skinRuntime.ts': '皮肤表面 hook 读 skin 运行时类型（type 边）',
      'src/infrastructure/skin/useSkinSurface.solid.ts -> src/plugin-runtime/skin/skinTypes.ts': '皮肤表面 hook 读 skin 契约类型（type 边）',
      'src/infrastructure/skin/useSkinSurface.solid.ts -> src/plugin-runtime/skin/skinResolver.ts': '皮肤表面 hook 读 skin 解析器类型（type 边）',
      // —— solidSheetSupport（UI 件住 infra、三层向上 import，审查 S1-P1 点名；搬迁待清偿）
      'src/infrastructure/state/solidSheetSupport.solid.tsx -> src/plugin-runtime/runtimeServices.ts': 'Solid sheet 支撑件经服务定位器读注册面（UI 件住 infra，#520 R3 迁入形态；搬迁待清偿）',
      'src/infrastructure/state/solidSheetSupport.solid.tsx -> src/plugin-runtime/interface-mode/interfaceModeTypes.ts': 'Solid sheet 支撑件读界面模式类型（type 边）',
    },
  },
  {
    // #489 规则 2 前半：kernel 只能被 app 挂载——domains 与视图层不得 import kernel。
    label: '视图层/domains → kernel',
    scopeRoots: ['src/domains/', ...VIEW_DIRS],
    forbiddenPathIncludes: ['src/kernel/'],
    allowlist: {},
    allowEdges: {
      'src/components/settings/PluginManager.solid.tsx -> src/kernel/kernelBootstrapServices.ts': '插件管理面板读 kernel 装配服务（重启/管理入口）',
      'src/components/settings/PluginManager.solid.tsx -> src/kernel/kernelBootstrap.ts': '插件管理面板读 kernelBootstrap 类型',
      'src/components/settings/PluginCapabilityConsentCard.solid.tsx -> src/kernel/kernelBootstrap.ts': '插件能力同意卡读 kernelBootstrap 类型（批3 契约翻转随迁）',
    },
  },
  {
    // #489 规则 2 后半：kernel 自身的出向引用按 bootstrap 装配语义逐条豁免（先立规后清债）。
    label: 'kernel → app/application/plugin-runtime/infrastructure/domains',
    scopeRoots: ['src/kernel/'],
    forbiddenPathIncludes: ['src/app/', 'src/application/', 'src/plugin-runtime/', 'src/infrastructure/', 'src/domains/'],
    allowlist: {},
    allowEdges: {
      // bootstrap 装配语义（引导期错误口与启动打点）
      'src/kernel/kernelBootstrap.ts -> src/app/runtimeError.ts': 'bootstrap 装配语义（引导期错误口）',
      'src/kernel/kernelBootstrap.ts -> src/app/startupTiming.ts': 'bootstrap 装配语义（启动相位打点）',
      'src/kernel/KernelRoot.solid.tsx -> src/app/startupTiming.ts': 'bootstrap 装配语义（启动相位打点）',
      // bootstrap 装配语义（挂载 application 运行时/事务端口/验收控制）
      'src/kernel/ApplicationMount.solid.tsx -> src/application/applicationRuntime.ts': 'bootstrap 装配语义（挂载 application 运行时）',
      'src/kernel/KernelRoot.solid.tsx -> src/application/acceptanceControls.ts': 'bootstrap 装配语义（验收控制装配；#520 R3 兼容门面退役后直连）',
      'src/kernel/kernelBootstrap.ts -> src/application/applicationMountPort.ts': 'bootstrap 装配语义（application 挂载端口类型）',
      'src/kernel/kernelBootstrapServices.ts -> src/application/applicationRuntimeServices.ts': 'bootstrap 装配语义（application 服务组装）',
      'src/kernel/kernelBootstrapServices.ts -> src/application/applicationMountPort.ts': 'bootstrap 装配语义（application 挂载端口类型）',
      'src/kernel/KernelRoot.solid.tsx -> src/application/applicationRuntimeServices.ts': 'bootstrap 装配语义（application 服务组装）',
      'src/kernel/KernelRoot.solid.tsx -> src/application/applicationRuntime.ts': 'bootstrap 装配语义（application 运行时类型）',
      // bootstrap 装配语义（插件宿主组装与渲染诊断注册）
      'src/kernel/kernelBootstrapServices.ts -> src/plugin-runtime/pluginCompositionRoot.ts': 'bootstrap 装配语义（插件宿主组装）',
      'src/kernel/kernelBootstrapServices.ts -> src/plugin-runtime/management/pluginManagementWiring.ts': 'bootstrap 装配语义（插件管理接线）',
      'src/kernel/KernelRoot.solid.tsx -> src/plugin-runtime/renderers/rendererDiagnosticsRegistry.ts': 'bootstrap 装配语义（渲染诊断注册）',
      // bootstrap 装配语义（环境探测）
      'src/kernel/kernelBootstrapServices.ts -> src/infrastructure/tauri/env.ts': 'bootstrap 装配语义（环境探测）',
    },
  },
  {
    // #489 规则 3（批准的最低限度）：host/app/cli/application 四层不得被 domains 依赖。
    label: 'domains → host/app/cli/application',
    scopeRoots: ['src/domains/'],
    forbiddenPathIncludes: ['src/host/', 'src/app/', 'src/cli/', 'src/application/'],
    allowlist: {},
    allowEdges: {
      // 命令解析器现居 application 层（#520 R3 自 host 迁入）；域侧直连仍待端口化清偿
      'src/domains/chat/commandRegistry.ts -> src/application/commandSetResolver.ts': '命令解析器现居 application 层（#520 R3 自 host 迁入）；域侧直连待端口化清偿',
      'src/domains/chat/sessionRuntime.ts -> src/application/commandSetResolver.ts': '命令解析器现居 application 层（#520 R3 自 host 迁入）；域侧直连待端口化清偿',
      // 域内动作经 app/runtimeError 上报错误（错误口现居 app；下沉待清偿）
      'src/domains/identity/identityProfileActions.ts -> src/app/runtimeError.ts': '域内动作经 app/runtimeError 上报错误（错误口下沉待清偿）',
      'src/domains/identity/identitySessionActions.ts -> src/app/runtimeError.ts': '域内动作经 app/runtimeError 上报错误（错误口下沉待清偿）',
      'src/domains/search/searchService.ts -> src/app/runtimeError.ts': '域内动作经 app/runtimeError 上报错误（错误口下沉待清偿）',
      'src/domains/theme/customPresetStore.ts -> src/app/runtimeError.ts': '域内动作经 app/runtimeError 上报错误（错误口下沉待清偿）',
      'src/domains/theme/presetActions.ts -> src/app/runtimeError.ts': '域内动作经 app/runtimeError 上报错误（错误口下沉待清偿）',
      'src/domains/theme/themeStore.ts -> src/app/runtimeError.ts': '域内动作经 app/runtimeError 上报错误（错误口下沉待清偿）',
      // identity 跨域端口现居 app/ports（#351 bootstrap 端口形态；迁移待清偿）
      'src/domains/identity/identityProfileActions.ts -> src/app/ports/identityCrossDomainPort.ts': 'identity 跨域端口现居 app/ports（#351 形态；迁移待清偿）',
      'src/domains/identity/identitySessionActions.ts -> src/app/ports/identityCrossDomainPort.ts': 'identity 跨域端口现居 app/ports（#351 形态；迁移待清偿）',
      'src/domains/identity/identityStore.ts -> src/app/ports/identityCrossDomainPort.ts': 'identity 跨域端口现居 app/ports（#351 形态；迁移待清偿）',
      'src/domains/identity/identityStoreShape.ts -> src/app/ports/identityCrossDomainPort.ts': 'identity 跨域端口现居 app/ports（#351 形态；迁移待清偿）',
      // 事务/装配件现居 app/bootstrap（事务层下沉待清偿）
      // #520 G 域：identitySessionActions -> app/bootstrap/resolveUnresolvedSessionTransaction
      // 条目已清偿（会话恢复事务装配移回 identitySessionRecoveryWiring，域侧经端口触发）。
      'src/domains/theme/themeStore.ts -> src/app/bootstrap/hydrateIdentityAndWorkspace.ts': '主题 store 消费 hydrate 装配件（装配现居 app/bootstrap）',
    },
  },
  {
    // #489 规则 3 扩展（按现状依赖图核准）：cli 为非视图层，不得 import 视图层（与既有
    // 「非视图层 → 视图层」规则族同构；存量 2 边为 workspaceController 控制器居于视图目录）。
    label: 'cli → 视图层',
    scopeRoots: ['src/cli/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {},
    allowEdges: {
      'src/cli/pylonCliRuntime.ts -> src/workspace-sheets/workspaceController.ts': 'CLI 开合工作区复用 workspaceController（控制器逻辑现居视图目录）',
      'src/cli/pylonCliPorts.ts -> src/workspace-sheets/sheetTypes.ts': 'CLI 端口消费 SheetRecord 类型（类型现居视图目录）',
    },
  },
  {
    // #489 规则 3 扩展：application 层不得 import 视图层（现状零违规，净禁令）。
    label: 'application → 视图层',
    scopeRoots: ['src/application/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {},
    allowEdges: {},
  },
  {
    // #489 规则 3 扩展：app 层不得 import 视图层（存量 1 边为 bootstrap wiring 触达
    // workspaceController——控制器逻辑现居视图目录）。
    label: 'app → 视图层',
    scopeRoots: ['src/app/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {},
    allowEdges: {
      'src/app/bootstrap/workspaceControllerWiring.ts -> src/workspace-sheets/workspaceController.ts': '装配 wiring 触达 workspaceController（控制器逻辑现居视图目录）',
    },
  },
]

function resolvesUnder(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(fromFile, '..', spec)
  const candidates = [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch { /* try next */ }
  }
  return null
}

/**
 * 判定一条 import 是否 type-only（整条边可被打包器擦除）：语句级 `import type` /
 * `export type`，或花括号内全部为 inline `type` 修饰符。找不到语句头时按运行时值
 * 处理（从严）。
 */
function isTypeOnlyImport(text: string, matchStart: number, matchEnd: number): boolean {
  const windowStart = Math.max(0, matchStart - 1200)
  const win = text.slice(windowStart, matchEnd)
  let stmt = -1
  for (const kw of ['\nimport', '\nexport', ';import', ';export']) {
    const i = win.lastIndexOf(kw)
    if (i > stmt) stmt = i
  }
  // 窗口已到文件头仍找不到语句关键词：匹配落在文件第一条语句内（其前无换行）。
  if (stmt < 0 && windowStart > 0) return false
  const head = win.slice(stmt + 1).trimStart()
  if (/^(?:import|export)\s+type\b/.test(head)) return true
  // head 以模块说明符的收尾引号结束（matchEnd = 说明符闭引号），故 from 后要吃掉说明符再锚串尾。
  // 注意 ([^}]*) 是捕获组 1（取花括号内 item 用），引号处不能用 \1 反向引用（会回引花括号内容）。
  const brace = /^(?:import|export)\s*\{([^}]*)\}\s*from\s*(?:'(?:\.[^']*)'|"(?:\.[^"]*)")\s*$/.exec(head)
  if (brace) {
    const items = brace[1]!.split(',').map(s => s.trim()).filter(Boolean)
    if (items.length > 0 && items.every(i => /^type\s/.test(i))) return true
  }
  return false
}

const files = gitTrackedSrcFiles()
const violations: string[] = []
const usedExemptions = new Set<string>()
const exemptionKeys = new Set<string>()
for (const rule of RULES) {
  for (const key of Object.keys(rule.allowlist)) exemptionKeys.add(`${rule.label}\u0000file:${key}`)
  for (const key of Object.keys(rule.allowEdges ?? {})) exemptionKeys.add(`${rule.label}\u0000edge:${key}`)
}

for (const file of files) {
  const relFile = relative(projectRoot, file).replaceAll('\\', '/')
  for (const rule of RULES) {
    if (!rule.scopeRoots.some(root => relFile.startsWith(root))) continue
    if (rule.scopeExcludes?.some(root => relFile.startsWith(root))) continue
    const text = await readFile(file, 'utf8')
    const specs = [...text.matchAll(/(?:from\s*|import\s*\(?\s*)(['"])(\.[^'"]+)\1/g)].map(m => ({ spec: m[2]!, start: m.index ?? 0, end: (m.index ?? 0) + m[0]!.length }))
    for (const { spec, start, end } of specs) {
      const target = resolvesUnder(file, spec)
      if (!target) continue
      const relTarget = relative(projectRoot, target).replaceAll('\\', '/')
      const hit = rule.forbiddenPathIncludes.find(prefix => relTarget.startsWith(prefix))
      if (!hit) continue
      if (rule.typeOnlyExempt && isTypeOnlyImport(text, start, end)) continue
      const edgeKey = `${relFile} -> ${relTarget}`
      if (rule.allowEdges?.[edgeKey] !== undefined) {
        usedExemptions.add(`${rule.label}\u0000edge:${edgeKey}`)
        continue
      }
      if (rule.allowlist[relFile] !== undefined) {
        usedExemptions.add(`${rule.label}\u0000file:${relFile}`)
        continue
      }
      violations.push(`[${rule.label}] ${edgeKey}（命中 ${hit}；如属合理边界请在 check-layer-boundaries.mts 的 allowEdges/allowlist 登记豁免并附理由）`)
    }
  }
}

// 豁免表陈旧检测：违规边消失后（改道/搬迁）必须同步删条，防止死豁免长期占位。
const unconsumed = [...exemptionKeys].filter(key => !usedExemptions.has(key))

if (violations.length > 0) {
  console.error(`分层边界门禁失败：${violations.length} 处越界`)
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
if (unconsumed.length > 0) {
  console.error(`分层边界门禁失败：${unconsumed.length} 条豁免已无对应违规边（改道/搬迁后请同步删条，防止死豁免占位）`)
  for (const s of unconsumed) console.error('  ' + s.replaceAll('\u0000', ' '))
  process.exit(1)
}
const fileLevel = RULES.reduce((n, r) => n + Object.keys(r.allowlist).length, 0)
const edgeLevel = RULES.reduce((n, r) => n + Object.keys(r.allowEdges ?? {}).length, 0)
console.log(`分层边界门禁通过：${files.length} 个生产文件，${RULES.length} 条规则零越界（文件级豁免 ${fileLevel} 条、边级豁免 ${edgeLevel} 条，均有理由登记且无陈旧条目）`)
