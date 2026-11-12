// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentArtifactResources from '../AgentArtifactResources.solid.tsx'
import AgentResourceMedia from '../AgentResourceMedia.solid.tsx'
import type { WorkspaceResource } from '../workspaceResources.ts'
import { collectWorkspaceResources } from '../workspaceResources.ts'
import { MOCK_MESSAGES } from '../../../demo/chatMockData.ts'
import { messageSnapshotToWorkbenchEnvelopes } from '../../../application/agent-workbench/messageSnapshotProjection.ts'
import { projectWorkbench } from '../../../domains/workbench/workbenchProjector.ts'

afterEach(cleanup)

describe('artifact resource inspector', () => {
  it.each(['modern-gui', 'terminal-like'])('shows actual snapshot-bridged resources in %s', mode => {
    const snapshot = MOCK_MESSAGES.find(message => message.id === 'mock-assistant-structured')!
    const document = projectWorkbench(messageSnapshotToWorkbenchEnvelopes('resource-bridge', [snapshot])).document
    const resources = collectWorkspaceResources(document)
    expect(resources.map(resource => resource.title)).toEqual(['渲染验收报告', '工作台阅读说明', '渲染参考资源'])
    render(() => <div class="app" data-interface-mode={mode}><AgentArtifactResources sessionId="resource-bridge" resources={resources} onOpenBrowser={vi.fn()} /></div>)
    fireEvent.click(screen.getByRole('button', { name: /渲染验收报告/ }))
    expect(screen.getByText(/正文与成果栏读取同一份类型化内容/)).toBeInTheDocument()
  })

  it('opens structured text beside chat and delegates web links to the browser', () => {
    const onOpenBrowser = vi.fn()
    const resource: WorkspaceResource = {
      id: 'artifact:report', title: 'Review report', kind: 'artifact', location: 'https://example.com/report', sequence: 1,
      part: { kind: 'artifact', artifactId: 'report', title: 'Review report', uri: 'https://example.com/report', parts: [{ kind: 'code', text: '<script>window.injected = true</script>', language: 'html' }] },
    }
    render(() => <AgentArtifactResources sessionId="session" resources={[resource]} onOpenBrowser={onOpenBrowser} />)
    fireEvent.click(screen.getByRole('button', { name: /Review report/ }))
    expect(screen.getByText('<script>window.injected = true</script>')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在内置浏览器打开' }))
    expect(onOpenBrowser).toHaveBeenCalledWith('https://example.com/report')
    fireEvent.click(screen.getByRole('button', { name: '返回成果列表' }))
    expect(screen.getByRole('button', { name: /Review report/ })).toBeInTheDocument()
  })

  it('previews media nested inside an artifact using the existing media resolver', () => {
    const resource: WorkspaceResource = {
      id: 'artifact:chart', title: 'Chart artifact', kind: 'artifact', sequence: 1,
      part: { kind: 'artifact', artifactId: 'chart', title: 'Chart artifact', uri: 'chart.png', parts: [{ kind: 'image', source: 'https://example.com/chart.png', alt: 'Build chart' }] },
    }
    render(() => <AgentArtifactResources sessionId="session" resources={[resource]} onOpenBrowser={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Chart artifact/ }))
    expect(screen.getByRole('img', { name: 'Build chart' })).toHaveAttribute('src', 'https://example.com/chart.png')
  })

  it('rejects executable media URLs and offers retry after a real image load error', () => {
    const invalid = render(() => <AgentResourceMedia part={{ kind: 'image', source: 'javascript:alert(1)', alt: 'Unsafe' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('协议不在白名单')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    invalid.unmount()
    render(() => <AgentResourceMedia part={{ kind: 'image', source: 'https://example.com/chart.png', alt: 'Retry chart' }} />)
    fireEvent.error(screen.getByRole('img', { name: 'Retry chart' }))
    expect(screen.getByRole('alert')).toHaveTextContent('媒体加载失败')
    fireEvent.click(screen.getByRole('button', { name: '重新加载媒体' }))
    expect(screen.getByRole('img', { name: 'Retry chart' })).toBeInTheDocument()
  })
})
