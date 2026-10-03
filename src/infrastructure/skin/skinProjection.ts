/**
 * skinProjection — 把 ResolvedSkin 投影到真实 DOM（阶段 5 S5-C）。
 *
 * - CSS variable 由调用方（useSkinSurface.solid）用 resolved.cssVariables 统一写入，本模块只提供可测试的投影原语；
 * - scoped CSS 安装在传入容器内（默认 App root），不注入 document.head；
 * - 返回 dispose，保证 stylesheet handle 与 inline variable 可回收、不累积。
 */
import type { ResolvedSkin } from '../../plugin-runtime/skin/skinTypes.ts'

export interface SkinDomIdentity {
  skinId: string
  scope: string
}

/** 取最高层来源作为当前生效 Skin 的 DOM 标识；无 Skin 时明确为 default */
export function resolveSkinDomIdentity(resolved: ResolvedSkin): SkinDomIdentity {
  const top = resolved.sources.at(-1)
  if (!top) return { skinId: 'default', scope: 'default' }

  if (top.kind === 'preview' && top.previewId) {
    return { skinId: `preview:${top.previewId}`, scope: top.target?.scope ?? 'global' }
  }
  if (top.kind === 'committed' && top.skinId) {
    return { skinId: top.skinId, scope: top.target?.scope ?? 'global' }
  }
  return { skinId: 'default', scope: 'default' }
}

export function installSkinStyleSheet(
  container: HTMLElement,
  css: string,
  skinId: string,
): () => void {
  const style = document.createElement('style')
  style.setAttribute('data-skin-style', skinId)
  style.textContent = css
  container.appendChild(style)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    style.remove()
  }
}

export function applySkinCssVariables(
  element: HTMLElement,
  cssVariables: Record<string, string>,
): Set<string> {
  const applied = new Set<string>()
  for (const [variable, value] of Object.entries(cssVariables)) {
    element.style.setProperty(variable, value)
    applied.add(variable)
  }
  return applied
}

export function clearSkinCssVariables(element: HTMLElement, variables: ReadonlySet<string>): void {
  for (const variable of variables) element.style.removeProperty(variable)
}

/**
 * 把全局 Skin 同步到 document 根节点。Radix/cmdk 等 Portal 挂在 `.app` 之外，
 * 若只投影 App surface，它们会退回默认配色而丢失自定义主题。
 */
export function projectSkinDocumentRoot(
  root: HTMLElement,
  body: HTMLElement,
  resolved: ResolvedSkin,
): () => void {
  const previousRootVariables = new Map<string, string>()
  const previousBodyVariables = new Map<string, string>()
  for (const [variable, value] of Object.entries(resolved.cssVariables)) {
    previousRootVariables.set(variable, root.style.getPropertyValue(variable))
    previousBodyVariables.set(variable, body.style.getPropertyValue(variable))
    root.style.setProperty(variable, value)
    body.style.setProperty(variable, value)
  }

  const previousAttributes = new Map<string, string | null>()
  for (const [attribute, value] of Object.entries(resolved.dataAttributes)) {
    previousAttributes.set(attribute, body.getAttribute(attribute))
    body.setAttribute(attribute, value)
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const [variable, previous] of previousRootVariables) {
      if (previous) root.style.setProperty(variable, previous)
      else root.style.removeProperty(variable)
    }
    for (const [variable, previous] of previousBodyVariables) {
      if (previous) body.style.setProperty(variable, previous)
      else body.style.removeProperty(variable)
    }
    for (const [attribute, previous] of previousAttributes) {
      if (previous === null) body.removeAttribute(attribute)
      else body.setAttribute(attribute, previous)
    }
  }
}

/**
 * 投影 surface + data-skin-id/scope + CSS variables + scoped css 到元素。
 * 返回 dispose：移除 style 节点与本次写入的 CSS variables。幂等。
 */
export function projectSkinSurface(
  element: HTMLElement,
  surface: string,
  resolved: ResolvedSkin,
): () => void {
  element.dataset.pylonSurface = surface

  const identity = resolveSkinDomIdentity(resolved)
  element.dataset.skinId = identity.skinId
  element.dataset.skinScope = identity.scope

  const appliedVariables = applySkinCssVariables(element, resolved.cssVariables)
  const disposeStyle = resolved.css
    ? installSkinStyleSheet(element, resolved.css, identity.skinId)
    : undefined

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeStyle?.()
    clearSkinCssVariables(element, appliedVariables)
  }
}
