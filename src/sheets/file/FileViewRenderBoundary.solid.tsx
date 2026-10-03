/** @jsxImportSource solid-js */
import type { JSX } from 'solid-js'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.solid.tsx'

/**
 * FileViewRenderBoundaryProps — 名字承自历史 React 契约（FileViewRenderBoundary.tsx，已退役）；本实体即唯一真源。
 */
interface FileViewRenderBoundaryProps {
  rendererId: string
  onError: (error: unknown) => 'fallback' | 'rethrow'
  onFallback: (rendererId: string) => void
  children?: JSX.Element
}

/**
 * FileViewRenderBoundary — 把坏掉的 renderer 局限在其 tab 内，让宿主选择下一 renderer。
 *
 * #520 S4-P2-11：本实体曾是独立手写的第二套错误边界（onError 裁决 fallback/rethrow +
 * rendererId 变化清错误态 + 专用占位 DOM），与 plugin-runtime 的
 * PluginContributionBoundary 语义分叉。现在这些差异全部是
 * PluginContributionBoundary 的 policy 参数（`onError`/`onFallback`/`fallback`/
 * `resetKey`），本实体退化为按 renderer 语义配置的实例；唯一保留的域内约定是
 * `onFallback(rendererId)` 携带 renderer id（宿主据此把坏 renderer 挪出候选集）。
 *
 * 语义与 React 版逐项同构：错误 → onError 裁决；fallback → onFallback(rendererId) 并
 * 展示切换提示（fallback 路径同时按共享边界纪律进 Runtime diagnostics，key 去重、
 * visibility diagnostic——这是相对旧实现的一处显式增强：坏 renderer 不再只对宿主可见，
 * 也进诊断面）；rethrow → 向上重抛（不上报，由更外层裁决）。rendererId 变化（宿主已
 * 换 renderer）→ 清错误态重渲染子树。
 */
export default function FileViewRenderBoundary(props: FileViewRenderBoundaryProps) {
  return (
    <PluginContributionBoundary
      contributionId={props.rendererId}
      resetKey={props.rendererId}
      onError={props.onError}
      onFallback={() => props.onFallback(props.rendererId)}
      fallback={() => <div class="file-tab-empty">正在切换到备用文件视图…</div>}
    >
      {props.children}
    </PluginContributionBoundary>
  )
}
