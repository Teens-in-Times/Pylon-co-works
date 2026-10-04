// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #520 S4-P1-5：PluginContributionBody 的实体级测试——7 宿主分发块收敛后的真源，
// 断言锁定它的分发/keyed/边界契约（宿主测试各自锁定 DOM 外壳，此处锁定 body 本身）。
import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal, lazy, type Component } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginContributionBody } from '../PluginContributionBody.solid.tsx'
import { PluginContributionBoundary } from '../PluginContributionBoundary.solid.tsx'
import { deactivatePluginInstance, type PluginInstance } from '../../pluginInstance.ts'
import { activateTestBuiltinPlugin } from '../../testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import type { PluginUiSurface } from '../pluginUiTypes.ts'

const instances: PluginInstance[] = []

afterEach(async () => {
  cleanup()
  while (instances.length > 0) await deactivatePluginInstance(instances.pop()!)
})

describe('PluginContributionBody — first-party 分发', () => {
  it('直挂注册组件并透传 props 工厂（细粒度响应：props 变化到达组件）', async () => {
    const [label, setLabel] = createSignal('初版')
    render(() => (
      <PluginContributionBody
        contributionId="body.first"
        contribution={{ renderKind: 'first-party-solid', component: (props: { label: string }) => <div data-testid="fp">{props.label}</div> }}
        componentProps={() => ({ label: label() })}
      />
    ))
    expect(screen.getByTestId('fp')).toHaveTextContent('初版')
    setLabel('改版')
    await waitFor(() => expect(screen.getByTestId('fp')).toHaveTextContent('改版'))
  })

  it('first-party 组件缺 props 工厂（宿主装配错误）→ 渲染空而不是硬挂组件', () => {
    render(() => (
      <PluginContributionBody
        contributionId="body.noprops"
        contribution={{ renderKind: 'first-party-solid', component: () => <div>不该出现</div> }}
      />
    ))
    expect(screen.queryByText('不该出现')).toBeNull()
  })

  it('崩溃 → 存量占位契约（role=alert + 文案）；贡献对象换新 → 边界整体重置', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const [broken, setBroken] = createSignal(true)
    render(() => (
      <PluginContributionBody
        contributionId="body.hotswap"
        contribution={broken()
          ? { renderKind: 'first-party-solid' as const, component: () => { throw new Error('broken') } }
          : { renderKind: 'first-party-solid' as const, component: () => <div>热替换后的健康实现</div> }}
        componentProps={() => ({})}
      />
    ))
    expect(await screen.findByRole('alert')).toHaveTextContent('此插件面板暂时不可用')

    // keyed 粒度 = 贡献对象：热替换（registry 换实例 → value 新对象）时边界（含错误态）重建。
    setBroken(false)
    await screen.findByText('热替换后的健康实现')
  })

  it('contributionId 变化随贡献对象一起生效（diagnostics 归因键跟随当前贡献）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const [contributionId, setId] = createSignal('body.before')
    render(() => (
      <PluginContributionBody
        contributionId={contributionId()}
        contribution={{ renderKind: 'first-party-solid', component: () => <div>稳定内容</div> }}
        componentProps={() => ({})}
      />
    ))
    await screen.findByText('稳定内容')
    // 换 id（未换贡献对象）不重建渲染——id 只进边界归因。
    setId('body.after')
    await screen.findByText('稳定内容')
  })
})

describe('PluginContributionBody — isolated-surface 分发', () => {
  it('surfaceId 缺失渲染空；已注册表面挂载并把 bridge 事件分诊给宿主', async () => {
    const received: Array<{ event: string; detail: unknown }> = []
    const probeMount: PluginUiSurface['mount'] = (container, bridge) => {
      const node = document.createElement('div')
      node.textContent = 'isolated 内容'
      node.dataset.surfaceReady = 'true'
      container.replaceChildren(node)
      bridge.emit('host:probe', { ok: 1 })
      return () => container.replaceChildren()
    }
    instances.push(await activateTestBuiltinPlugin(createPluginIdentity('test.body.surface', 'run-1'), ({ ui }) => {
      ui.registerSurface({
        id: 'test.body.surface.surface',
        runtime: { framework: 'solid', version: '1.9' },
        mount: probeMount,
      })
    }))

    render(() => (
      <>
        <PluginContributionBody
          contributionId="body.isolated.missing"
          contribution={{ renderKind: 'isolated-surface', surfaceId: '' }}
          onSurfaceEvent={(event, detail) => received.push({ event, detail })}
        />
        <PluginContributionBody
          contributionId="body.isolated.ok"
          contribution={{ renderKind: 'isolated-surface', surfaceId: 'test.body.surface.surface' }}
          surfaceClass="probe-surface-class"
          onSurfaceEvent={(event, detail) => received.push({ event, detail })}
        />
      </>
    ))

    // surfaceId 缺失 → 不挂任何表面容器（不是抛错）。
    expect(document.querySelector('[data-plugin-ui-surface=""]')).toBeNull()

    const surface = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-plugin-ui-surface="test.body.surface.surface"]')
      if (!node) throw new Error('surface not mounted')
      return node
    })
    expect(surface).toHaveClass('probe-surface-class')
    await screen.findByText('isolated 内容')
    // bridge.emit → 宿主分诊回调（onSurfaceEvent）。
    await waitFor(() => expect(received).toContainEqual({ event: 'host:probe', detail: { ok: 1 } }))
  })
})

describe('PluginContributionBody — prefix 与边界开关', () => {
  it('prefix 在边界内、贡献体之前渲染（schema 设置面同位语义）', () => {
    render(() => (
      <PluginContributionBody
        contributionId="body.prefix"
        contribution={{ renderKind: 'first-party-solid', component: () => <div>贡献体</div> }}
        componentProps={() => ({})}
        prefix={() => <div data-testid="prefix">设置面</div>}
      />
    ))
    const container = document.body
    const prefix = container.querySelector('[data-testid="prefix"]')!
    const body = screen.getByText('贡献体')
    expect(prefix.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('withBoundary=false：错误穿透 body、由外层 policy 边界裁决（FileView 换源链语义）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fallbacks: string[] = []
    render(() => (
      <PluginContributionBoundary
        contributionId="body.outer"
        onError={() => 'fallback'}
        onFallback={() => fallbacks.push('outer')}
        fallback={() => <div data-testid="outer-fallback">外层占位</div>}
      >
        <PluginContributionBody
          contributionId="body.inner"
          withBoundary={false}
          contribution={{ renderKind: 'first-party-solid', component: () => { throw new Error('renderer crash') } }}
          componentProps={() => ({})}
        />
      </PluginContributionBoundary>
    ))
    await screen.findByTestId('outer-fallback')
    // onFallback 归外层——body 未截走错误。
    expect(fallbacks).toEqual(['outer'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('suspenseFallback：lazy 组件未就绪时显示自定义加载态，就绪后换正文（默认 fallback 为 null）', async () => {
    let resolveImport: (value: { default: Component<{ ok: string }> }) => void = () => {}
    const Pending = lazy(() => new Promise<{ default: Component<{ ok: string }> }>(resolve => { resolveImport = resolve }))
    render(() => (
      <PluginContributionBody
        contributionId="body.suspense"
        contribution={{ renderKind: 'first-party-solid', component: Pending }}
        componentProps={() => ({ ok: '已就绪' })}
        suspenseFallback={<div data-testid="loading">加载中…</div>}
      />
    ))
    expect(await screen.findByTestId('loading')).toBeInTheDocument()
    resolveImport({ default: props => <div>{props.ok}</div> })
    await screen.findByText('已就绪')
    expect(screen.queryByTestId('loading')).toBeNull()
  })
})
