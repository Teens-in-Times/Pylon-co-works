// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { resolveSkinLayers } from '../../../plugin-runtime/skin/skinResolver.ts'
import type { ResolvedSkin } from '../../../plugin-runtime/skin/skinTypes.ts'
import {
  applySkinCssVariables,
  clearSkinCssVariables,
  installSkinStyleSheet,
  projectSkinDocumentRoot,
  projectSkinSurface,
  resolveSkinDomIdentity,
} from '../skinProjection.ts'

function resolvedWith(css?: string): ResolvedSkin {
  return resolveSkinLayers([
    { kind: 'default', tokens: {} },
    {
      kind: 'committed',
      target: { scope: 'global' },
      skinId: 'skin-test',
      tokens: { accent: '#123456' },
      ...(css ? { css } : {}),
    },
  ])
}

describe('Skin DOM 投影（S5-C）', () => {
  it('resolveSkinDomIdentity：无 Skin 为 default，committed 与 preview 取最高层', () => {
    expect(resolveSkinDomIdentity(resolvedWith()).skinId).toBe('skin-test')
    expect(resolveSkinDomIdentity(resolvedWith()).scope).toBe('global')

    const defaultResolved = resolveSkinLayers([{ kind: 'default', tokens: {} }])
    expect(resolveSkinDomIdentity(defaultResolved)).toEqual({ skinId: 'default', scope: 'default' })

    const previewResolved = resolveSkinLayers([
      { kind: 'default', tokens: {} },
      { kind: 'preview', target: { scope: 'agent', agentId: 'a1' }, previewId: 'preview-1', tokens: { accent: '#333' } },
    ])
    expect(resolveSkinDomIdentity(previewResolved)).toEqual({ skinId: 'preview:preview-1', scope: 'agent' })
  })

  it('applySkinCssVariables 写入并返回 key 集合；clear 移除', () => {
    const element = document.createElement('div')
    const keys = applySkinCssVariables(element, { '--accent': '#123456', '--t': '0.8' })

    expect(element.style.getPropertyValue('--accent')).toBe('#123456')
    expect(element.style.getPropertyValue('--t')).toBe('0.8')
    expect(keys).toEqual(new Set(['--accent', '--t']))

    clearSkinCssVariables(element, keys)
    expect(element.style.getPropertyValue('--accent')).toBe('')
  })

  it('installSkinStyleSheet 在容器内创建 style，dispose 后移除且幂等', () => {
    const container = document.createElement('div')
    const dispose = installSkinStyleSheet(container, '[data-pylon-component="message"] { color: red; }', 'skin-test')

    const style = container.querySelector('style[data-skin-style="skin-test"]')
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('data-pylon-component')

    dispose()
    dispose()
    expect(container.querySelector('style[data-skin-style="skin-test"]')).toBeNull()
  })

  it('projectSkinSurface 投影 surface/skin-id/scope/css vars/scoped css，dispose 恢复', () => {
    const element = document.createElement('div')
    const dispose = projectSkinSurface(element, 'workspace', resolvedWith('[data-pylon-component="message"] { color: red; }'))

    expect(element.dataset.pylonSurface).toBe('workspace')
    expect(element.dataset.skinId).toBe('skin-test')
    expect(element.dataset.skinScope).toBe('global')
    expect(element.style.getPropertyValue('--accent')).toBe('#123456')
    expect(element.querySelector('style[data-skin-style="skin-test"]')).not.toBeNull()

    dispose()
    dispose()
    expect(element.style.getPropertyValue('--accent')).toBe('')
    expect(element.querySelector('style[data-skin-style="skin-test"]')).toBeNull()
  })

  it('projectSkinDocumentRoot 让 Portal 继承完整主题变量与 data attributes', () => {
    const root = document.createElement('html')
    const body = document.createElement('body')
    root.style.setProperty('--accent', '#old')
    body.setAttribute('data-ui-scheme', 'light')
    const resolved = resolvedWith()

    const dispose = projectSkinDocumentRoot(root, body, resolved)

    expect(root.style.getPropertyValue('--accent')).toBe('#123456')
    expect(body.style.getPropertyValue('--accent')).toBe('#123456')
    expect(root.style.getPropertyValue('--global-bg-color')).not.toBe('')
    expect(root.getAttribute('data-ui-scheme')).toBe(resolved.dataAttributes['data-ui-scheme'])
    expect(body.getAttribute('data-ui-scheme')).toBe(resolved.dataAttributes['data-ui-scheme'])

    dispose()
    expect(root.style.getPropertyValue('--accent')).toBe('#old')
    expect(root).not.toHaveAttribute('data-ui-scheme')
    expect(body.style.getPropertyValue('--accent')).toBe('')
    expect(body.getAttribute('data-ui-scheme')).toBe('light')
  })
})
