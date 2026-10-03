/**
 * windowLifecycle — Tauri 窗口生命周期接线（#520 S3-P1-3：自 App.solid 组合根拆出）。
 *
 * 两段 Tauri window listener：
 * - 窗口尺寸记忆：启动恢复上次尺寸，resize 防抖 400ms 持久化（纯前端 localStorage，
 *   键见 windowSizePersistence；不依赖后端）；
 * - 关窗 drain：onCloseRequested 先跑持久化 drain（identity 写穿 + rollup 裁剪），
 *   失败保持窗口打开并上报——drain 本体由组合根注入（App 还要服务标题栏菜单的
 *   主动关窗路径，两路共用同一 drain）。
 *
 * 非 Tauri（浏览器预览）整体 no-op。 Solid 响应式（onMount/onCleanup）→ .solid.ts。
 */
import { onCleanup, onMount } from 'solid-js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { logWarn, logError } from '../contracts/frontendLogSink'
import { IS_TAURI } from '../infrastructure/tauri/env'
import { loadWindowSize, persistWindowSize } from '../infrastructure/persistence/windowSizePersistence'
import { reportRuntimeError } from './runtimeError'

export function setupWindowLifecycle(drainBeforeClose: () => Promise<void>): void {
  // 窗口尺寸记忆：启动恢复上次尺寸，resize 防抖持久化（纯前端，不依赖后端）
  onMount(() => {
    if (!IS_TAURI) return
    const win = getCurrentWindow()
    const saved = loadWindowSize(localStorage)
    if (saved) win.setSize(new PhysicalSize(saved.width, saved.height)).catch(error => logWarn('恢复上次窗口尺寸失败', error))
    let timer: number | null = null
    let disposed = false
    const unlisten = win.onResized(({ payload }) => {
      if (disposed) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        persistWindowSize(localStorage, { width: payload.width, height: payload.height })
      }, 400)
    })
    onCleanup(() => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      unlisten.then(stop => stop())
    })
  })

  onMount(() => {
    if (!IS_TAURI) return
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    void win.onCloseRequested(async event => {
      event.preventDefault()
      try {
        await drainBeforeClose()
      } catch (error) {
        reportRuntimeError('关闭前持久化失败，窗口已保持打开', error, undefined, {
          key: 'app:close-persistence', scope: { kind: 'app', id: 'lifecycle' }, source: 'app.lifecycle',
        })
        return
      }
      await win.destroy()
    }).then(fn => { unlisten = fn }).catch(error => logError('注册窗口关闭 flush 失败', error))
    onCleanup(() => { unlisten?.() })
  })
}
