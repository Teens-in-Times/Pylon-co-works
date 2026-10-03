/** @jsxImportSource solid-js */
import { Show, Suspense, type Component, type JSX } from 'solid-js'
import { IsolatedPluginSurface } from './IsolatedPluginSurface.solid.tsx'
import { PluginContributionBoundary } from './PluginContributionBoundary.solid.tsx'

/**
 * 贡献联合的**宿主无关投影**（#520 S4-P1-5）。
 *
 * 各宿主 registry 的 value（sidebar / context-panel / titlebar / settings-page /
 * file-workbench）各自声明 typed first-party 组件（#520 S4-P1-6），但形状同构：
 * `renderKind: 'first-party-solid'` 臂持 Solid `Component<P>`，`'isolated-surface'`
 * 臂持 surfaceId。宿主把各自的 value 直接传入 `contribution`，本实体按判别式分发，
 * 宿主侧不再出现 `as Component` 断言。
 */
interface FirstPartyContributionRef<P extends Record<any, any>> {
  readonly renderKind: 'first-party-solid'
  readonly component: Component<P>
}

interface IsolatedSurfaceContributionRef {
  readonly renderKind: 'isolated-surface'
  readonly surfaceId: string
}

type PluginContributionRef<P extends Record<any, any>> = FirstPartyContributionRef<P> | IsolatedSurfaceContributionRef

/**
 * PluginContributionBodyProps — 插件贡献体挂载面。
 *
 * 宿主只剩**数据投影**：first-party 的 props 工厂、isolated 的 wire 输入工厂与事件
 * 分诊、各宿主的 DOM 挂载 class；分发（isolated ? IsolatedPluginSurface :
 * Suspense+Dynamic）、surfaceId 缺失守卫、错误边界与 keyed 粒度全部收进本实体。
 */
export interface PluginContributionBodyProps<P extends Record<any, any>> {
  /** Runtime diagnostics 归因与错误占位 key（边界 fallback 上报用）。 */
  readonly contributionId: string
  /**
   * 贡献联合（宿主 registry value 直传即可）。**keyed 粒度锚点**：本实体以贡献对象
   * 身份为键——热替换/停用换实例时整个边界（含错误态）随 keyed Show 整体重建
   * （ContextPanelHost 热替换用例锁定的契约）；`null`/`undefined` 渲染为空。
   */
  readonly contribution: PluginContributionRef<P> | null | undefined
  /** first-party 组件的 props 工厂（细粒度响应穿透）。isolated 贡献可省略。 */
  readonly componentProps?: () => P
  /** isolated 挂载容器的 class（各宿主 DOM 契约不同，如 `sidebar-block-body-surface`）。 */
  readonly surfaceClass?: string
  /** isolated 表面的 `host:input` 输入工厂（推流语义由 IsolatedPluginSurface 承载）。 */
  readonly surfaceInput?: () => unknown
  /** isolated 表面事件分诊（bridge.emit 回传）。 */
  readonly onSurfaceEvent?: (event: string, detail: unknown) => void
  /**
   * Suspense fallback；缺省 `null`——现状最常见（Sidebar / AgentSheetPageHost /
   * ContextPanelHost / WorkspaceTitlebar 四宿主均为 null；PluginSettingsPageHost
   * 传自己的加载态文案）。
   */
  readonly suspenseFallback?: JSX.Element
  /**
   * 边界内渲染的前缀（如 ContextPanel / PluginSettings 的 schema 设置面：必须在
   * **同一错误边界内**、贡献体之前渲染）。
   */
  readonly prefix?: () => JSX.Element
  /**
   * 是否由本实体挂 PluginContributionBoundary。缺省 `true`；唯一例外是 FileSheetView
   * 的视图分支——它自带 FileViewRenderBoundary（renderer fallback/rethrow + 宿主换源
   * policy，见 PluginContributionBoundary 注释的互相指认），双层边界会把错误截在内层、
   * 走不了换 renderer 链，因此传 `false` 让错误直达外层 policy 边界。
   */
  readonly withBoundary?: boolean
}

/**
 * PluginContributionBody — 插件贡献体统一挂载实体（#520 S4-P1-5：7 个宿主各自手写的
 * `PluginContributionBoundary + (isolated ? IsolatedPluginSurface : Suspense+Dynamic)`
 * 分发块的收敛真源）。
 *
 * 语义即各宿主现状的并集：isolated-surface 走 IsolatedPluginSurface（surfaceId 缺失
 * 渲染空）；first-party 组件包 Suspense（fallback 可配，默认 null）经 typed 直挂；
 * 缺省套 PluginContributionBoundary（policy 见该实体）。实体名保留 "Body"：外壳
 * （标题/头部/tablist 等）仍归宿主，这里只负责贡献体的分发与边界。
 */
export function PluginContributionBody<P extends Record<any, any>>(props: PluginContributionBodyProps<P>) {
  const renderArms = (contribution: PluginContributionRef<P>) => {
    if (contribution.renderKind === 'isolated-surface') {
      if (!contribution.surfaceId) return null
      return (
        <IsolatedPluginSurface
          surfaceId={contribution.surfaceId}
          className={props.surfaceClass}
          input={props.surfaceInput?.()}
          onEvent={props.onSurfaceEvent}
        />
      )
    }
    // first-party 贡献必须提供 props 工厂；缺省视为宿主装配错误，渲染空而不是拿
    // 空 props 硬挂组件。装配错误必须在开发期可见（复查 P1：静默空白不可接受）。
    const componentProps = props.componentProps
    if (!componentProps) {
      console.warn(`[PluginContributionBody] first-party 贡献缺少 componentProps 工厂：${props.contributionId}（宿主装配错误，渲染为空）`)
      return null
    }
    const Contribution: Component<P> = contribution.component
    return (
      <Suspense fallback={props.suspenseFallback}>
        <Contribution {...componentProps()} />
      </Suspense>
    )
  }

  // keyed 粒度 = 贡献对象。**边界必须落在 keyed 分支之内**：贡献对象换新（热替换/
  // 停用换实例）时整个边界（含错误态）随之重建——ErrorBoundary 一旦渲染过 fallback，
  // 重渲 children 并不会自行复位，ContextPanelHost 热替换用例锁定的就是这条。
  // children 必须保持 JSX 表达式（getter）而不是先求值的常量：贡献组件在边界读
  // children 时才真正执行，抛错才能被边界接住（组件是急切调用的，先建 vnode 再挂边
  // 界会把错误漏在边界之外）。
  return (
    <Show when={props.contribution} keyed>
      {contribution => props.withBoundary === false ? (
        <>
          {props.prefix?.()}
          {renderArms(contribution)}
        </>
      ) : (
        <PluginContributionBoundary contributionId={props.contributionId}>
          {props.prefix?.()}
          {renderArms(contribution)}
        </PluginContributionBoundary>
      )}
    </Show>
  )
}
