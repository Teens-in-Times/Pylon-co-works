// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { SolidMediaBlock } from '../MediaBlock.solid.tsx'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'
import type { ContentPart } from '../../../../../domains/workbench/content/contentPartSchema.ts'

/**
 * C03 RED：SolidMediaBlock 契约。
 *
 * - image：placeholder → ready/error；点击 zoom（aria-pressed）；
 * - audio/video：原生 controls、autoplay=false；
 * - 加载失败保留 metadata + retry；
 * - transcript 独立呈现；
 * - 危险 URL（javascript:）不进入 DOM src。
 */

function media(part: ContentPart, props?: Partial<Parameters<typeof SolidMediaBlock>[0]>) {
  return render(() => <SolidMediaBlock part={part} {...props} />)
}

afterEach(() => cleanup())

describe('C03 SolidMediaBlock', () => {
  it('renders remote image with lazy loading and alt text', () => {
    const result = media({ kind: 'image', source: 'https://cdn.example.com/a.png', alt: '架构图', mimeType: 'image/png' })
    expect(result.getByRole('figure', { name: '图片：架构图' })).toBeTruthy()
    const img = result.container.querySelector('img.term-media-img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('https://cdn.example.com/a.png')
    expect(img.getAttribute('alt')).toBe('架构图')
    expect(img.getAttribute('loading')).toBe('lazy')
  })

  it('toggles zoom on click with aria-pressed', async () => {
    const result = media({ kind: 'image', source: 'https://cdn.example.com/a.png', alt: '图' })
    const button = result.container.querySelector('button.term-media-image-button') as HTMLButtonElement
    expect(button.getAttribute('aria-pressed')).toBe('false')
    button.click()
    await Promise.resolve()
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('audio uses native controls without autoplay', () => {
    const result = media({ kind: 'audio', source: 'https://cdn.example.com/a.wav', mimeType: 'audio/wav' })
    const audio = result.container.querySelector('audio.term-media-element') as HTMLAudioElement
    expect(audio).not.toBeNull()
    expect(audio.hasAttribute('controls')).toBe(true)
    expect(audio.autoplay).toBe(false)
  })

  it('moves native media from loading to ready only after metadata and exposes load errors', async () => {
    const result = media({
      kind: 'audio', source: 'https://cdn.example.com/state.wav', mimeType: 'audio/wav', alt: '状态音频',
    })
    const figure = result.container.querySelector<HTMLElement>('figure.term-media')!
    const audio = result.container.querySelector<HTMLAudioElement>('audio.term-media-element')!
    expect(figure.dataset.status).toBe('loading')

    audio.dispatchEvent(new Event('loadedmetadata'))
    await Promise.resolve()
    expect(figure.dataset.status).toBe('ready')

    audio.dispatchEvent(new Event('error'))
    await Promise.resolve()
    expect(figure.dataset.status).toBe('error')
    expect(result.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('asks the native media element to load again on retry', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    try {
      const result = media({
        kind: 'audio', source: 'https://cdn.example.com/retry.wav', mimeType: 'audio/wav', alt: '重试音频',
      })
      const audio = result.container.querySelector<HTMLAudioElement>('audio.term-media-element')!
      audio.dispatchEvent(new Event('error'))
      await Promise.resolve()

      result.getByRole('button', { name: '重试' }).click()
      await Promise.resolve()

      expect(load).toHaveBeenCalledOnce()
      expect(load.mock.instances[0]).toBe(audio)
      expect(result.container.querySelector<HTMLElement>('figure.term-media')!.dataset.status).toBe('loading')
      expect(audio.getAttribute('src')).toBe('https://cdn.example.com/retry.wav')
    } finally {
      load.mockRestore()
    }
  })

  it('video uses native controls without autoplay and keeps poster', () => {
    const result = media({
      kind: 'video',
      source: 'https://cdn.example.com/v.mp4',
      poster: 'https://cdn.example.com/poster.jpg',
      mimeType: 'video/mp4',
    })
    const video = result.container.querySelector('video.term-media-element') as HTMLVideoElement
    expect(video).not.toBeNull()
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.autoplay).toBe(false)
    expect(video.getAttribute('poster')).toBe('https://cdn.example.com/poster.jpg')
  })

  it('drops an unsafe video poster without hiding the valid media source', () => {
    const result = media({
      kind: 'video',
      source: 'https://cdn.example.com/v.mp4',
      poster: 'javascript:alert(1)',
      mimeType: 'video/mp4',
      alt: '安全视频',
    })
    const video = result.container.querySelector('video.term-media-element') as HTMLVideoElement
    expect(video.getAttribute('src')).toBe('https://cdn.example.com/v.mp4')
    expect(video.hasAttribute('poster')).toBe(false)
    expect(result.container.querySelector('[poster="javascript:alert(1)"]')).toBeNull()
  })

  it('shows error state with metadata and retry when source is rejected', async () => {
    const result = media(
      { kind: 'image', source: 'javascript:alert(1)', alt: '危险图' },
      {},
    )
    // javascript: 被白名单拒绝——不得出现任何带该 src 的元素
    await Promise.resolve()
    expect(result.container.textContent).toContain('媒体无法加载')
    expect(result.container.textContent).not.toBe('')
    const dangerous = result.container.querySelector('[src="javascript:alert(1)"]')
    expect(dangerous).toBeNull()
  })

  it('keeps dimensions and mime metadata in caption on load failure', () => {
    const result = media({
      kind: 'image',
      source: 'javascript:x',
      width: 640,
      height: 480,
      mimeType: 'image/png',
    })
    expect(result.container.textContent).toContain('640×480')
    expect(result.container.textContent).toContain('image/png')
    expect(result.container.textContent).toContain('重试')
  })

  it('base64 inline renders as data URL within limit', () => {
    const result = media({
      kind: 'image', source: 'iVBORw0KGgo=', sourceKind: 'base64', mimeType: 'image/png', alt: '内联图',
    })
    const img = result.container.querySelector('img.term-media-img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('local path fails closed without adapter and explains reason', () => {
    const result = media({ kind: 'image', source: 'C:\\m\\a.png', sourceKind: 'path' })
    expect(result.container.textContent).toContain('adapter')
    expect(result.container.querySelector('.term-file-action')).not.toBeNull()
  })

  it('local path converts through injected adapter', () => {
    const seen: string[] = []
    const result = media(
      { kind: 'image', source: '/home/m/b.png', sourceKind: 'path' },
      { resolverOptions: { convertLocalPath: (path) => { seen.push(path); return `asset://x/${path}` } } },
    )
    const img = result.container.querySelector('img.term-media-img') as HTMLImageElement
    expect(seen).toEqual(['/home/m/b.png'])
    expect(img.getAttribute('src')).toBe('asset://x//home/m/b.png')
  })

  it('transcript renders as separate text block, not mixed into payload', () => {
    const result = media({
      kind: 'audio',
      source: 'https://cdn.example.com/a.wav',
      transcript: '这是转写文本',
      mimeType: 'audio/wav',
    })
    const transcript = result.container.querySelector('.term-media-transcript-body')
    expect(transcript?.textContent).toBe('这是转写文本')
    // 音频 src 不包含转写文本
    const audio = result.container.querySelector('audio') as HTMLAudioElement
    expect(audio.getAttribute('src')).not.toContain('转写')
  })

  it('non-media part renders nothing', () => {
    const result = media({ kind: 'text', text: '普通文本' })
    expect(result.container.querySelector('.term-media')).toBeNull()
  })

  it('open external action only appears for URL sources and goes through callback', async () => {
    const onOpenExternal = vi.fn()
    const result = media(
      { kind: 'image', source: 'https://cdn.example.com/a.png', alt: '' },
      { onOpenExternal },
    )
    const openButton = [...result.container.querySelectorAll('button')]
      .find(button => button.textContent === '打开外部链接') as HTMLButtonElement
    expect(openButton).toBeTruthy()
    openButton.click()
    expect(onOpenExternal).toHaveBeenCalledWith('https://cdn.example.com/a.png')

    // base64 来源没有"打开外部链接"
    const local = media({
      kind: 'image', source: 'iVBORw0KGgo=', sourceKind: 'base64', mimeType: 'image/png',
    }, { onOpenExternal })
    const localOpen = [...local.container.querySelectorAll('button')]
      .find(button => button.textContent === '打开外部链接')
    expect(localOpen).toBeUndefined()
  })

  it('consumes resolved C03 appearance and playback settings in the base Slot', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'media-settings', kind: 'content.video', revision: 1,
        payload: {
          kind: 'video', source: 'https://cdn.example.com/demo.mp4', caption: '演示视频',
          mimeType: 'video/mp4', width: 1280, height: 720, transcript: '转写正文',
        },
      }}
      appearance={{
        foreground: '#112233', mutedForeground: '#445566', background: '#f1f2f3',
        borderColor: '#778899', maxWidth: 720, maxHeight: 360, fit: 'cover', radius: 14,
        defaultExpanded: true, showCaption: false, showDownload: false, autoplay: true,
        controls: false, transcriptStyle: 'compact', showMetadata: false, reducedMotion: true,
      }}
      commands={{ execute: () => {} }}
    />)

    const figure = result.container.querySelector<HTMLElement>('figure.term-media')!
    const video = result.container.querySelector<HTMLVideoElement>('video.term-media-element')!
    expect(figure.dataset.fit).toBe('cover')
    expect(figure.dataset.transcriptStyle).toBe('compact')
    expect(figure.dataset.reducedMotion).toBe('true')
    expect(figure.style.color).toBe('rgb(17, 34, 51)')
    expect(figure.style.backgroundColor).toBe('rgb(241, 242, 243)')
    expect(figure.style.borderColor).toBe('rgb(119, 136, 153)')
    expect(figure.style.maxWidth).toBe('720px')
    expect(figure.style.borderRadius).toBe('14px')
    expect(video.style.maxHeight).toBe('360px')
    expect(video.style.objectFit).toBe('cover')
    expect(video.autoplay).toBe(true)
    expect(video.hasAttribute('controls')).toBe(false)
    expect(result.container.textContent).not.toContain('演示视频')
    expect(result.container.textContent).not.toContain('1280×720')
    expect(result.container.querySelector('[data-transcript-style="compact"]')).not.toBeNull()
    expect(result.queryByRole('button', { name: '下载' })).toBeNull()
  })

  it('routes media open and download actions through the base Slot semantic command port', () => {
    const execute = vi.fn()
    const part = {
      kind: 'image' as const,
      source: 'https://cdn.example.com/export.png',
      mimeType: 'image/png',
      alt: '导出图',
    }
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'media-actions', kind: 'content.image', revision: 1, payload: part }}
      appearance={{ showDownload: true }}
      commands={{ canExecute: type => type === 'resource.open', execute }}
    />)

    result.getByRole('button', { name: '打开外部链接' }).click()
    result.getByRole('button', { name: '下载' }).click()

    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'resource.open', payload: { uri: part.source },
    })
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: 'resource.open', payload: { ...part, disposition: 'download' },
    })
  })

  it('does not load default-collapsed media until the accessible disclosure is opened', async () => {
    const result = media(
      { kind: 'video', source: 'https://cdn.example.com/lazy.mp4', alt: '延迟视频' },
      { appearance: { defaultExpanded: false, reducedMotion: true } },
    )

    const toggle = result.getByRole('button', { name: '展开媒体：延迟视频' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(result.container.querySelector('video')).toBeNull()

    toggle.click()
    await Promise.resolve()

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(result.container.querySelector('video')).not.toBeNull()
    expect(result.container.querySelector('figure.term-media')?.getAttribute('data-reduced-motion')).toBe('true')
  })

  it('preserves the user disclosure state across unrelated appearance updates', async () => {
    const [appearance, setAppearance] = createSignal({ defaultExpanded: true, maxWidth: 480 })
    const result = render(() => <SolidMediaBlock
      part={{ kind: 'image', source: 'https://cdn.example.com/state.png', alt: '状态图片' }}
      appearance={appearance()}
    />)
    const toggle = result.getByRole('button', { name: '折叠媒体：状态图片' })
    toggle.click()
    await Promise.resolve()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    setAppearance({ defaultExpanded: true, maxWidth: 720 })
    await Promise.resolve()

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(result.container.querySelector<HTMLElement>('figure.term-media')!.style.maxWidth).toBe('720px')
  })

  it('routes a canonical local path through the production Tauri asset adapter in the base Slot', () => {
    const target = window as unknown as Record<string, unknown>
    const previous = target.__TAURI_INTERNALS__
    target.__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
    }
    try {
      const result = render(() => <BuiltinSolidContentSlot
        snapshot={{
          nodeId: 'media-path', kind: 'content.image', revision: 1,
          payload: { kind: 'image', source: 'C:\\media\\local.png', sourceKind: 'path', mimeType: 'image/png' },
        }}
        appearance={{}}
        commands={{ execute: () => {} }}
      />)

      expect(result.container.querySelector('img')?.getAttribute('src')).toBe(
        `asset://localhost/${encodeURIComponent('C:\\media\\local.png')}`,
      )
    } finally {
      if (previous === undefined) delete target.__TAURI_INTERNALS__
      else target.__TAURI_INTERNALS__ = previous
    }
  })
})
