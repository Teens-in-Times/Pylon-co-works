import { describe, expect, it } from 'vitest'
import { createWorkbenchDocument, type WorkbenchDocument } from '../../../domains/workbench/workbenchProjector.ts'
import { collectWorkspaceResources, resourcePreviewText, resourceWebUrl } from '../workspaceResources.ts'

describe('canonical workspace resources', () => {
  it('collects assistant and tool resources, keeps the latest artifact version, and excludes user attachments/raw payloads', () => {
    const document = {
      ...createWorkbenchDocument('session'),
      messages: [
        { role: 'user', sequence: 1, parts: [{ kind: 'document', path: 'private-input.md', text: 'input' }] },
        { role: 'assistant', sequence: 2, parts: [{ kind: 'artifact', artifactId: 'report', title: 'Report', uri: 'report.md', version: 1 }] },
        { role: 'assistant', sequence: 4, parts: [{ kind: 'artifact', artifactId: 'report', title: 'Report v2', uri: 'report.md', version: 2 }] },
      ],
      activities: [
        { sequence: 3, parts: [{ kind: 'document', title: 'Results', path: 'results.csv', text: 'a,b' }], rawOutput: { kind: 'artifact', artifactId: 'fake', title: 'Ignored', uri: 'ignored' } },
        { sequence: 5, output: [{ kind: 'image', source: 'https://example.com/output.png', alt: 'Chart' }, { kind: 'artifact', title: 'Malformed' }] },
      ],
    } as unknown as WorkbenchDocument
    expect(collectWorkspaceResources(document).map(resource => resource.title)).toEqual(['Chart', 'Report v2', 'Results'])
  })

  it('preserves text as text and only permits http(s) browser navigation', () => {
    const document = {
      ...createWorkbenchDocument('session'),
      messages: [{ role: 'assistant', sequence: 1, parts: [{ kind: 'artifact', artifactId: 'html', title: 'Preview', uri: 'javascript:alert(1)', parts: [{ kind: 'code', text: '<script>window.bad = true</script>', language: 'html' }] }] }],
    } as unknown as WorkbenchDocument
    const resource = collectWorkspaceResources(document)[0]
    expect(resourcePreviewText(resource.part)).toBe('<script>window.bad = true</script>')
    expect(resourceWebUrl(resource)).toBeNull()
    expect(resourceWebUrl({ ...resource, location: 'https://example.com/demo' })).toBe('https://example.com/demo')
  })
})
