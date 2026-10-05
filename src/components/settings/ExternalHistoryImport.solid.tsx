/** @jsxImportSource solid-js */
import { createSignal, For, Show } from 'solid-js'

import { IS_TAURI } from '../../infrastructure/tauri/env'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import {
  importExternalHistory,
  scanExternalHistory,
  type ExternalSessionSummaryWire,
} from '../../infrastructure/persistence/externalHistoryRepository'

/**
 * ExternalHistoryImport — 外部 CLI 历史导入设置卡片（#364 首版：Claude Code）。
 *
 * 最小闭环：扫描 `~/.claude/projects` → 展示发现 → 全量导入（可勾选 force 分叉）。
 * 导入后检索/阅读走既有 evt_search 链（落库即一等公民），本卡片不自带历史视图。
 * 封存快照纪律（issue #364 裁决）：导入后不 live 重解析源文件；再导入默认幂等
 * 跳过，force 显式产生分叉副本。
 */
export default function ExternalHistoryImport() {
  const [scanning, setScanning] = createSignal(false)
  const [summaries, setSummaries] = createSignal<ExternalSessionSummaryWire[] | null>(null)
  const [importing, setImporting] = createSignal(false)
  const [force, setForce] = createSignal(false)
  const [errorText, setErrorText] = createSignal<string | null>(null)
  const [importedCount, setImportedCount] = createSignal<number | null>(null)
  const [skippedCount, setSkippedCount] = createSignal<number | null>(null)

  const scan = async () => {
    setScanning(true)
    setErrorText(null)
    setSummaries(null)
    setImportedCount(null)
    setSkippedCount(null)
    try {
      setSummaries(await scanExternalHistory())
    } catch (error) {
      setErrorText(`扫描失败：${error instanceof Error ? error.message : String(error)}`)
      reportRuntimeError('扫描外部历史', error, undefined, {
        key: 'settings:external-history:scan',
        scope: { kind: 'app', id: 'settings-external-history' },
        source: 'settings.external-history',
      })
    } finally {
      setScanning(false)
    }
  }

  const importAll = async () => {
    const current = summaries()
    if (!current || current.length === 0) return
    setImporting(true)
    setErrorText(null)
    setImportedCount(null)
    setSkippedCount(null)
    try {
      const outcomes = await importExternalHistory(null, force())
      setImportedCount(outcomes.filter(outcome => outcome.status === 'imported').length)
      setSkippedCount(outcomes.filter(outcome => outcome.status === 'already-imported').length)
    } catch (error) {
      setErrorText(`导入失败：${error instanceof Error ? error.message : String(error)}`)
      reportRuntimeError('导入外部历史', error, undefined, {
        key: 'settings:external-history:import',
        scope: { kind: 'app', id: 'settings-external-history' },
        source: 'settings.external-history',
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div class="set-group">
      <h3 class="set-group-inner-title">外部历史导入</h3>
      <Show when={IS_TAURI} fallback={<div class="set-hint">外部历史导入需要桌面版（读取本机 CLI 会话文件）。</div>}>
        <div class="set-row">
          <span class="set-row-label">来源</span>
          <span class="set-hint">Claude Code（~/.claude/projects）</span>
        </div>
        <div class="set-preset-row">
          <button type="button" class="ps-btn sm" disabled={scanning() || importing()} onClick={() => void scan()}>
            {scanning() ? '扫描中…' : '扫描 Claude Code 历史'}
          </button>
          <Show when={summaries() && summaries()!.length > 0}>
            <button type="button" class="ps-btn sm" disabled={scanning() || importing()} onClick={() => void importAll()}>
              {importing() ? '导入中…' : `导入全部（${summaries()!.length} 个会话）`}
            </button>
            <label class="set-hint">
              <input
                type="checkbox"
                checked={force()}
                disabled={importing()}
                onChange={event => setForce(event.currentTarget.checked)}
              />
              已导入的会话生成新副本（force 分叉）
            </label>
          </Show>
        </div>
        <Show when={summaries()}>
          <Show when={summaries()!.length > 0} fallback={<div class="set-hint">未发现 Claude Code 历史会话。</div>}>
            <ul class="set-hint" role="list">
              <For each={summaries()!.slice(0, 20)}>
                {summary => (
                  <li>
                    {summary.title ?? summary.externalId}
                    （{new Date(summary.startedAt).toLocaleString('zh-CN')}，{summary.eventCount} 条事件）
                  </li>
                )}
              </For>
              <Show when={summaries()!.length > 20}>
                <li>…共 {summaries()!.length} 个会话</li>
              </Show>
            </ul>
          </Show>
        </Show>
        <Show when={importedCount() != null}>
          <div class="set-hint" role="status">
            已导入 {importedCount()} 个会话{skippedCount()! > 0 ? `，跳过已导入 ${skippedCount()} 个` : ''}。导入的会话可经全局搜索检索。
          </div>
        </Show>
        <Show when={errorText()}><div class="set-hint" role="status">{errorText()}</div></Show>
        <div class="set-hint">导入是封存快照：完成后不会跟踪源文件变化；再次导入默认跳过已导入会话。</div>
      </Show>
    </div>
  )
}
