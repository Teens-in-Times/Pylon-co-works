// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachmentFromPath,
  attachmentNameForPath,
  attachmentsFromPaths,
  mediaTypeForPath,
  subscribeAttachmentDrop,
} from '../attachmentPicker.ts'

describe('#699 附件选择端口', () => {
  afterEach(() => {
    vi.doUnmock('@tauri-apps/plugin-dialog')
    vi.resetModules()
  })

  it('扩展名 → MIME（大小写不敏感），未知扩展名不猜类型', () => {
    expect(mediaTypeForPath('/a/B.PNG')).toBe('image/png')
    expect(mediaTypeForPath('C:\\tmp\\n.md')).toBe('text/markdown')
    expect(mediaTypeForPath('archive.tar')).toBeUndefined()
    expect(mediaTypeForPath('noext')).toBeUndefined()
    expect(mediaTypeForPath('')).toBeUndefined()
  })

  it('展示名切 Windows 与 POSIX 两种分隔符，纯目录/空白回退原串', () => {
    expect(attachmentNameForPath('C:\\Users\\me\\shot.png')).toBe('shot.png')
    expect(attachmentNameForPath('/repo/notes.md')).toBe('notes.md')
    expect(attachmentNameForPath('  trimmed.txt  ')).toBe('trimmed.txt')
  })

  it('单路径产出的附件带 name 与 mediaType', () => {
    expect(attachmentFromPath(' /repo/diagram.svg ')).toEqual({
      id: '/repo/diagram.svg',
      path: '/repo/diagram.svg',
      name: 'diagram.svg',
      mediaType: 'image/svg+xml',
    })
  })

  it('批量归一化：去空白、按 id 去重并保留首次出现顺序', () => {
    expect(attachmentsFromPaths(['/a.png', ' /a.png ', '  ', '/b', '/a.png']).map(item => item.id))
      .toEqual(['/a.png', '/b'])
  })

  it('对话框取消或 Tauri 不可用时返回空数组（不抛）', async () => {
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))
    vi.resetModules()
    const picker = await import('../attachmentPicker.ts')
    await expect(picker.pickAttachments()).resolves.toEqual([])
  })

  it('Tauri 不可用时拖放订阅是空操作，退订不抛', () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    const handler = vi.fn()
    const off = subscribeAttachmentDrop(handler)
    expect(handler).not.toHaveBeenCalled()
    expect(() => off()).not.toThrow()
  })

  it('对话框返回单个字符串时也归一化为数组', async () => {
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => '/repo/one.png') }))
    vi.resetModules()
    const picker = await import('../attachmentPicker.ts')
    await expect(picker.pickAttachments()).resolves.toMatchObject([{ id: '/repo/one.png', name: 'one.png' }])
  })
})
