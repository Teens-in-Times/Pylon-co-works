/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js'
import { fileTabKey, fileTabViewType, type FileTabRecord } from './fileSheetState.ts'

/**
 * FileTabBarProps — 名字承自历史 React 契约（FileTabBar.tsx，已退役）；本实体即唯一真源。
 */
interface FileTabBarProps {
  tabs: readonly FileTabRecord[]
  activeKey: string | null
  dirtyKeys?: ReadonlySet<string>
  savingKeys?: ReadonlySet<string>
  onSelect: (key: string) => void
  onClose: (key: string) => void
}

/**
 * FileTabBar — 版本化 tab 条（ISSUE-08 D-02/D-04；#515 Solid 实体）。
 *
 * tabs/activeKey 存 sheet metadata（`{version:2,tabs:[{path,mode,staged?}],activeKey}`，
 * 可序列化、重启恢复）。tab 单例 key = `${mode}:${path}`：同路径 file/diff 并存为
 * 两个 tab 且不互相覆盖；关闭/切换均以 key 回调 FileSheetView 的 patchSheetMetadata。
 * 原 React 原件（FileTabBar.tsx）已随批7 退役（唯一消费者 FileSheetView 直连本实体）。
 */
export default function FileTabBar(props: FileTabBarProps) {
  return (
    <Show when={props.tabs.length > 0}>
      <div class="file-tab-bar" role="tablist" aria-label="已打开文件">
        <For each={props.tabs}>{tab => {
          const key = fileTabKey(tab)
          const isDiff = fileTabViewType(tab) === 'git.diff'
          const label = isDiff ? `${tab.path}（diff）` : tab.path
          const dirty = () => props.dirtyKeys?.has(key) === true
          const saving = () => props.savingKeys?.has(key) === true
          return (
            <span
              role="tab"
              aria-selected={props.activeKey === key}
              class={`file-tab ${props.activeKey === key ? 'active' : ''} ${isDiff ? 'file-tab-diff' : ''} ${dirty() ? 'dirty' : ''} ${saving() ? 'saving' : ''}`}
              data-dirty={dirty() ? 'true' : undefined}
              data-saving={saving() ? 'true' : undefined}
              onClick={() => props.onSelect(key)}
              title={label}
            >
              <span class="file-tab-name">{tab.path.split('/').pop()}</span>
              <Show when={isDiff}><span class="file-tab-mode">{tab.staged ? 'staged' : 'unstaged'}</span></Show>
              <Show when={saving()} fallback={
                <Show when={dirty()}>
                  <span class="file-tab-state dirty" role="status" aria-label={`未保存 ${label}`}>●</span>
                </Show>
              }>
                <span class="file-tab-state saving" role="status" aria-label={`正在保存 ${label}`}>…</span>
              </Show>
              <button
                type="button"
                class="file-tab-close"
                aria-label={`关闭 ${label}`}
                disabled={saving()}
                onClick={event => { event.stopPropagation(); props.onClose(key) }}
              >
                ✕
              </button>
            </span>
          )
        }}</For>
      </div>
    </Show>
  )
}
