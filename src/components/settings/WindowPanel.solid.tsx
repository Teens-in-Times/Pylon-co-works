/** @jsxImportSource solid-js */
import { createSignal, onCleanup, Show, type JSX } from 'solid-js'

import { IS_TAURI } from '../../infrastructure/tauri/env'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { clearWindowSize } from '../../infrastructure/persistence/windowSizePersistence'
import { Row } from './themeFieldRenderer.solid.tsx'


function WindowSizeRow() {
  const [size, setSize] = createSignal('—')
  if (IS_TAURI) {
    let cancelled = false
    getCurrentWindow().outerSize().then(({ width, height }) => {
      if (!cancelled) setSize(`${width}×${height}`)
    }).catch(() => {})
    onCleanup(() => { cancelled = true })
  }
  const reset = () => {
    getCurrentWindow().setSize(new PhysicalSize(1200, 800)).catch(() => {})
    clearWindowSize(localStorage)
  }
  return (
    <Group title="窗口">
      <Row label="当前尺寸"><span class="set-val" style={{ width: 'auto' }}>{size()} px</span></Row>
      <div class="set-hint">拖动窗口边框后自动记忆尺寸，下次启动恢复</div>
      <div class="set-preset-row">
        <button type="button" class="ps-btn sm" onClick={reset}>重置为默认 1200×800</button>
      </div>
    </Group>
  )
}

export default WindowSizeRow

function Group(props: { title: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(true)
  return (
    <div class="set-group">
      <button type="button" class="set-group-title" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="set-group-arrow">{open() ? '▾' : '▸'}</span>
        {props.title}
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  )
}
