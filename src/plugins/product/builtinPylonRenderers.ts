import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import { createCoreSolidRendererPluginDefinition } from '../core/renderer/solidRenderer.ts'
import { createBuiltinRendererContentPluginDefinitions } from '../core/renderer/builtinRenderContent.ts'
import { createBuiltinToolRendererPluginDefinition } from '../core/renderer/builtinToolRenderers.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../domains/rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../domains/rendererContent/toolRenderKindCatalog.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../../domains/rendererContent/executionRenderKindCatalog.ts'
import { BUILTIN_INTERACTION_RENDER_KINDS } from '../../domains/rendererContent/interactionRenderKindCatalog.ts'
import { BUILTIN_SESSION_RENDER_KINDS } from '../../domains/rendererContent/sessionRenderKindCatalog.ts'
import { BUILTIN_PYLON_RENDERERS_ID } from './productPluginIds.ts'
import { mountFirstPartyStyleAssets } from './firstPartyStyleRuntime.ts'
import { loadBuiltinPylonRendererStyles } from './packages/builtin.pylon-renderers/styleAssets.ts'
import { BUILTIN_PRESENTATION_PROFILES } from '../core/renderer/builtinPresentationProfiles.ts'
import { createBuiltinPresentationCommandDefinitions } from '../core/renderer/builtinPresentationCommands.ts'
import { BUILTIN_INTERFACE_MODES } from '../core/interfaceMode/builtinInterfaceModes.ts'
import { DEFAULT_SHELL_RECIPE } from '../../plugin-runtime/shell-recipe/shellRecipeTypes.ts'
import { createBuiltinSolidContentSlot, createBuiltinSolidRendererSuite } from '../../renderers/solid-workbench/builtinSolidRendererSuite.ts'

const rendererDefinitions = Object.freeze([
  createCoreSolidRendererPluginDefinition(),
  ...createBuiltinRendererContentPluginDefinitions(),
  createBuiltinToolRendererPluginDefinition(),
])

export function createBuiltinPylonRenderersPlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_RENDERERS_ID,
    kind: 'renderer',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: context => {
      mountFirstPartyStyleAssets(BUILTIN_PYLON_RENDERERS_ID, context.identity.key, context.scope, loadBuiltinPylonRendererStyles())
      // C00：六个文本族 kind 先于 renderer 实现注册（kind 是内容契约，Slot 后挂）。
      // 经 shadow transaction 原子提交，message.user/assistant 的 fallback 链不出现中间态。
      // One owner-scoped shadow batch: a second batch from the same runtime
      // would correctly replace the first and accidentally drop text kinds.
      context.renderer.registerRenderKinds([
        ...BUILTIN_TEXT_RENDER_KINDS,
        ...BUILTIN_TOOL_RENDER_KINDS,
        ...BUILTIN_EXECUTION_RENDER_KINDS,
        ...BUILTIN_INTERACTION_RENDER_KINDS,
        ...BUILTIN_SESSION_RENDER_KINDS,
      ])
      for (const definition of rendererDefinitions) {
        const result = definition.activate(context)
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          throw new Error(`内置 renderer 必须同步激活：${definition.id}`)
        }
      }
      // Suite reference validation sees both canonical text kinds and legacy
      // content.plan before the production Suite snapshot is published.
      context.renderer.registerSuite(createBuiltinSolidRendererSuite())
      context.renderer.registerSlot(createBuiltinSolidContentSlot())
      for (const profile of BUILTIN_PRESENTATION_PROFILES) context.presentation.registerProfile(profile)
      context.shellRecipes.registerRecipe(DEFAULT_SHELL_RECIPE)
      for (const mode of BUILTIN_INTERFACE_MODES) context.interfaceModes.registerMode(mode)
      context.fonts.registerFont({
        id: 'system',
        label: '系统无衬线',
        description: 'Segoe UI / 苹方 / 微软雅黑，适合导航与设置。',
        // #129 子项 2：内置栈只留 index.css 一份真值，贡献 family 引用同一 token——
        // 此前两份字符串已实际漂移过一次（serif 侧缺 'SimSun'），预览与真实渲染
        // 在 Windows 上落到不同的 CJK 衬线字形。
        family: 'var(--font-system)',
        roles: ['interface', 'content'],
        order: 10,
        sample: '清晰、自然、适合长时间工作',
      })
      context.fonts.registerFont({
        id: 'serif',
        label: '低对比阅读衬线',
        description: '适合长篇 Markdown 与审阅。',
        family: 'var(--font-serif-default)',
        roles: ['interface', 'content'],
        order: 20,
        sample: '让长篇内容更接近纸张阅读',
      })
      context.fonts.registerFont({
        id: 'mono',
        label: 'Consolas（VS Code 默认）',
        description: 'Windows VS Code 默认代码字体，用于代码、路径、终端与 Agent 记录流。',
        family: 'var(--font-mono-default)',
        roles: ['interface', 'content', 'code'],
        order: 30,
        sample: 'const pylon = await connect()'
      })
      for (const command of createBuiltinPresentationCommandDefinitions()) {
        context.commands.register(command, { contributionId: `${BUILTIN_PYLON_RENDERERS_ID}.${command.id}`, layer: 'feature', priority: command.priority })
      }
    },
  }
}
