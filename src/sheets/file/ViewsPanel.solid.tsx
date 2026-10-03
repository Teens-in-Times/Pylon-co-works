/** @jsxImportSource solid-js */
import { createMemo, For, Show } from 'solid-js'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import type { AgentContext } from '../../domains/agent/agentContext'
import { toAgentContextKey } from '../../domains/agent/agentContext'
import { FileTypeIconSolid } from './fileIcons.solid.tsx'

/**
 * ViewsPanelProps — 名字承自历史 React 契约（ViewsPanel.tsx，已退役）；本实体即唯一真源。
 */
interface ViewsPanelProps {
  source: string | null
  context?: AgentContext | null
  onOpenFile: (path: string) => void
}

/** 触碰时间格式化（HH:MM；可测）。真源自 React 桥（ViewsPanel.tsx）下沉至此。 */
export function formatTouchTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * ViewsPanel — FileSheet 的 Agent 文件活动工作面（ISSUE-08 D-04；#515 Solid 实体）。
 * 只消费 workspaceStore.touchedFiles[source]，不维护任何 Git 状态（SCM 独占 Git，见 GitPanel）。
 * 点击触碰文件 → onOpenFile(path) 进入统一文件 tab 的普通视图（不创建 diff 主视图）。
 */
export default function ViewsPanel(props: ViewsPanelProps) {
  // selector 只读 store 切片；source/context 是 props 响应式状态，按 solidStoreBridge
  // ⚠️ 约定在组件侧用 createMemo 并读（selector 不得读组件局部响应式状态）。
  const touchedFilesRecord = createZustandSignal(useWorkspaceStore, s => s.touchedFiles)
  // I01-W3：touchedFiles 按 AgentContextKey（agentId+source）隔离读取
  const touchedFiles = createMemo(() => {
    const record = touchedFilesRecord()
    return (props.source && props.context ? record[toAgentContextKey(props.context)] ?? [] : [])
  })

  return (
    <div class="file-section-panel file-views-panel">
      <section class="file-view-section">
        <div class="file-panel-heading"><span>AGENT CHANGES</span><span class="file-panel-count">{touchedFiles().length}</span></div>
        <Show when={!props.source}><p class="file-section-hint">选择会话后查看 Agent 改动</p></Show>
        <Show when={props.source && touchedFiles().length === 0}>
          <p class="file-section-hint file-section-muted">Agent 尚未修改文件</p>
        </Show>
        <Show when={touchedFiles().length > 0}>
          <ul class="file-view-list">
            <For each={touchedFiles().slice().reverse()}>{file => (
              <li>
                <button type="button" class="file-view-row" onClick={() => props.onOpenFile(file.path)} title={`打开 ${file.path}`}>
                  <FileTypeIconSolid path={file.path} size={14} />
                  <span class="file-view-path">{file.path}</span>
                  <small>{file.toolKind}</small>
                  <span class="file-view-time">{formatTouchTime(file.at)}</span>
                </button>
              </li>
            )}</For>
          </ul>
        </Show>
      </section>
    </div>
  )
}
