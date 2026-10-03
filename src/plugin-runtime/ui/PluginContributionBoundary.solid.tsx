/** @jsxImportSource solid-js */
import type { JSX } from 'solid-js'
import { createEffect, ErrorBoundary, on } from 'solid-js'
import { reportRuntimeError } from '../../app/runtimeError.ts'

/**
 * 错误裁决 policy（#520 S4-P2-11）。
 *
 * - `'fallback'`：边界内消化——上报 Runtime diagnostics（key 去重、visibility
 *   diagnostic）并渲染占位；这是插件贡献面的默认语义。
 * - `'rethrow'`：原样向上重抛，**不**在本边界重复上报——由更外层的裁决方处理
 *   （如 FileSheetView 的 renderer 换源链）。
 */
export type ContributionErrorPolicy = (error: unknown) => 'fallback' | 'rethrow'

/**
 * PluginContributionBoundary — 插件贡献渲染边界（#515 贡献面翻转：Solid 实体，原 React
 * class 组件 PluginContributionBoundary.tsx 同语义移植后删除）。
 *
 * 边界的本地占位是用户可见上下文；崩溃照旧进 Runtime diagnostics（key 去重，不另发
 * 全局 tray error）。占位 DOM（class/role/文案）是存量契约，宿主测试按它断言。
 *
 * #520 S4-P2-11 policy 化：此前本边界与 `sheets/file/FileViewRenderBoundary.solid.tsx`
 * 各持一套错误语义（本边界恒 fallback + diagnostics 上报；后者 onError 裁决
 * fallback/rethrow + 宿主换 renderer、不上报）。现在差异语义全部收进本边界的可选
 * policy 钩子（`onError`/`onFallback`/`fallback`/`resetKey`），FileViewRenderBoundary
 * 退化为一份按 renderer 语义配置的本边界实例——两处差异只剩「占位 DOM 与上报策略
 * 由谁配置」，不再存在两套边界实现。
 */
export function PluginContributionBoundary(props: {
  contributionId: string
  children: JSX.Element
  /** 错误裁决；缺省恒 `'fallback'`（存量语义）。 */
  onError?: ContributionErrorPolicy
  /** 裁决为 `'fallback'` 后回调（如 FileView 渲染面据此触发宿主换 renderer）。 */
  onFallback?: () => void
  /** fallback 占位；缺省为存量契约占位 DOM。 */
  fallback?: (error: unknown) => JSX.Element
  /**
   * 变化即重置错误态、重渲染子树（React componentDidUpdate 同语义）。FileView 渲染面
   * 传 rendererId：宿主已换 renderer → 清错误态重挂；缺省不重置。
   */
  resetKey?: unknown
}) {
  let resetBoundary: (() => void) | null = null

  createEffect(on(() => props.resetKey, () => {
    resetBoundary?.()
    resetBoundary = null
  }))

  return (
    <ErrorBoundary fallback={(error, reset) => {
      resetBoundary = reset
      if (props.onError?.(error) === 'rethrow') throw error
      reportRuntimeError(`渲染插件贡献 ${props.contributionId}`, error instanceof Error ? error : new Error(String(error)), undefined, {
        key: `plugin-contribution:${props.contributionId}`,
        visibility: 'diagnostic',
        scope: { kind: 'operation', id: `plugin-contribution:${props.contributionId}` },
        source: 'plugin.contribution-boundary',
      })
      props.onFallback?.()
      return props.fallback
        ? props.fallback(error)
        : <div class="context-panel-placeholder" role="alert">此插件面板暂时不可用</div>
    }}>
      {props.children}
    </ErrorBoundary>
  )
}
