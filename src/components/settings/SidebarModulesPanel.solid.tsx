/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import {
  applyModulePrefs,
  sidebarModulePrefsStore,
} from '../../domains/appearance/sidebarModulePrefs.ts'


/**
 * 侧栏模块显隐（设置 → 侧栏）。
 *
 * #515：Solid 实体（原 SidebarModulesPanel.tsx 为 React 薄桥）。
 *
 * 顺序与显隐是**跨 Sheet 的界面偏好**，与具体某个 Sheet 的折叠状态无关，因此读写
 * `sidebarModulePrefs`（独立 localStorage key），不碰 sheet state。
 *
 * `alwaysOpen` 的模块（会话）列出但开关禁用：左栏没有会话列表就失去了主体。
 */
export default function SidebarModulesPanel() {
  const registry = getAgentSidebarRegistry()
  // 框架无关外部 store → 信号（对齐 useSyncExternalStore 订阅语义）
  const [prefsVersion, setPrefsVersion] = createSignal(0)
  onCleanup(sidebarModulePrefsStore.subscribe(() => setPrefsVersion(n => n + 1)))
  const prefs = createMemo(() => {
    void prefsVersion()
    return sidebarModulePrefsStore.getSnapshot()
  })
  const registrySnapshot = createMemo(() => {
    void prefsVersion()
    return registry.getSnapshot()
  })

  const all = createMemo(() => registrySnapshot().entries.map(entry => entry.value))
  const visibleIds = createMemo(() => new Set(applyModulePrefs(all(), prefs()).map(contribution => contribution.id)))
  const hidden = createMemo(() => new Set(prefs().hidden))

  const setHidden = (id: string, nextHidden: boolean) => {
    const next = nextHidden
      ? [...hidden(), id]
      : [...hidden()].filter(candidate => candidate !== id)
    sidebarModulePrefsStore.setPrefs({ order: prefs().order, hidden: next })
  }

  return (
    <Show when={all().length > 0} fallback={<p class="set-hint">当前没有已注册的左栏模块。</p>}>
      <div class="sidebar-modules-panel" role="group" aria-label="侧栏模块显隐">
        <For each={all()}>{contribution => {
          const alwaysOpen = contribution.alwaysOpen === true
          const shown = () => alwaysOpen || visibleIds().has(contribution.id)
          return (
            <label class="sidebar-modules-row">
              <input
                type="checkbox"
                checked={shown()}
                disabled={alwaysOpen}
                aria-label={`显示模块 ${contribution.label}`}
                onChange={event => setHidden(contribution.id, !event.currentTarget.checked)}
              />
              <span class="sidebar-modules-name">{contribution.label}</span>
              <Show when={alwaysOpen}><span class="sidebar-modules-note">常开</span></Show>
              <Show when={contribution.page}><span class="sidebar-modules-note">可展开为页面</span></Show>
            </label>
          )
        }}</For>
        <p class="set-hint">次序在左栏里直接拖拽模块标题左侧的手柄调整。</p>
      </div>
    </Show>
  )
}
