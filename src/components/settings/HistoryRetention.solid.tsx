/** @jsxImportSource solid-js */
import { createSignal, onCleanup, Show } from 'solid-js'

import Select from '../ui/Select.solid.tsx'
import {
  DEFAULT_COUNT_LIMIT,
  DEFAULT_TIME_DAYS,
  RETENTION_COUNT_LIMITS,
  RETENTION_MODE_OPTIONS,
  RETENTION_TIME_DAYS,
  readRetentionPolicy,
  retentionPolicyImpact,
  writeRetentionPolicy,
  type RetentionMode,
  type RetentionPolicy,
} from '../../domains/overview/retentionPolicy.ts'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import {
  loadRetentionPolicy,
  previewRetentionPolicy,
  pruneRetentionPolicy,
  retentionErrorCode,
  retentionErrorMessage,
  saveRetentionPolicy,
  type RetentionPolicySnapshot,
  type RetentionPreview,
} from '../../infrastructure/persistence/retentionPolicyRepository'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'


/**
 * HistoryRetention — 消息历史保留策略设置（I13-A-FE-02，D-03/D-15）。
 *
 * #515：Solid 实体（原 HistoryRetention.tsx 为 React 薄桥）。
 *
 * I13-W3：Tauri 模式保留策略真值迁移到后端权威存储（retention_policy_get/set，
 * versioned + revision 乐观并发），localStorage 不再是 Tauri 模式真值；browser
 * 模式（无后端）保持 localStorage 既有路径。
 *
 * 设置页**只写策略**，不绕过 Rust 数据层删除：
 * - 切换下拉/档位仅持久化策略，绝不触发删除；
 * - 非永久策略必须显示预计影响（D-15），并明确「保存策略不等于立即清理」；
 * - 默认永久保存；新安装/字段缺失/解析失败回退永久保存；
 * - 后端 payload 损坏回退 permanent 时显示 warning，不静默覆盖（D-15）；
 * - revision 冲突（别处已改）→ 重读最新值 + 提示，旧写不覆盖新写。
 * A1-c/B5：清理执行已切到 canonical_events（唯一会话数据源）；by_count =
 * 每 owner 保留最近 N 条 canonical 事件。本组件无删除路径之外语义变化。
 */
export default function HistoryRetention() {
  // browser 模式同步就绪（保持既有 localStorage 行为，测试/无后端环境不受影响）；
  // Tauri 模式异步加载后端权威值（loading skeleton）。
  // （Solid createSignal 无惰性初始化器——组件体只跑一次，直接在此求值即等价。）
  const [snapshot, setSnapshot] = createSignal<RetentionPolicySnapshot | null>(
    IS_TAURI
      ? null
      : { policy: readRetentionPolicy(localStorage), revision: null, source: 'local', corruptWarning: null },
  )
  const [loading, setLoading] = createSignal(IS_TAURI)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  // I13-W4：立即清理流（preview 影响 → 二次确认 → prune → 结果；stale/失败可重试）
  const [preview, setPreview] = createSignal<RetentionPreview | null>(null)
  const [previewing, setPreviewing] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  const [pruning, setPruning] = createSignal(false)
  const [cleanError, setCleanError] = createSignal<string | null>(null)
  const [cleanResult, setCleanResult] = createSignal<RetentionPreview | null>(null)
  let disposed = false
  onCleanup(() => { disposed = true })

  const reload = () => {
    setLoading(true)
    setLoadError(null)
    // 不清 saveError：冲突重读后需保留「已在别处修改」提示；下次保存时再清
    loadRetentionPolicy(localStorage)
      .then(next => {
        if (disposed) return
        setSnapshot(next)
        resolveRuntimeErrors({ key: 'settings:history-retention:load' })
      })
      .catch(error => {
        if (disposed) return
        setLoadError(retentionErrorMessage(error))
        reportRuntimeError('读取历史保留策略', error, undefined, {
          key: 'settings:history-retention:load', scope: { kind: 'app', id: 'settings-history-retention' }, source: 'settings.history-retention',
        })
      })
      .finally(() => { if (!disposed) setLoading(false) })
  }

  // A1-c/B5：Tauri 模式重接后端权威值（canonical retention 已就绪）；browser
  // 模式从 localStorage 同步初始化（见 signal 初值），无需异步加载。
  if (IS_TAURI) reload()

  const update = (next: RetentionPolicy) => {
    const current = snapshot()
    if (!current) return
    // 策略已变 → 旧 preview/清理结果失效，重置（W4 CR-001：改下拉后不得沿用旧预览统计）
    const resetCleanState = () => {
      setPreview(null)
      setConfirming(false)
      setCleanResult(null)
      setCleanError(null)
    }
    if (current.source === 'local') {
      try {
        writeRetentionPolicy(localStorage, next)
        setSnapshot({ ...current, policy: next })
        resolveRuntimeErrors({ key: 'settings:history-retention:save' })
      } catch (error) {
        setSaveError('保存失败，详情见右下角错误中心')
        reportRuntimeError('保存历史保留策略', error, undefined, {
          key: 'settings:history-retention:save', scope: { kind: 'app', id: 'settings-history-retention' }, source: 'settings.history-retention',
        })
      }
      return
    }
    setSaving(true)
    setSaveError(null)
    saveRetentionPolicy(localStorage, next, current.revision)
      .then(revision => {
        setSnapshot(value => (value ? { ...value, policy: next, revision, corruptWarning: null } : value))
        resetCleanState()
        resolveRuntimeErrors({ key: 'settings:history-retention:save' })
      })
      .catch(error => {
        if (retentionErrorCode(error) === 'retention_revision_conflict') {
          setSaveError('策略已在别处修改，已重新加载最新值')
          reload()
        } else {
          setSaveError(`保存失败：${retentionErrorMessage(error)}`)
        }
        reportRuntimeError('保存历史保留策略', error, undefined, {
          key: 'settings:history-retention:save', scope: { kind: 'app', id: 'settings-history-retention' }, source: 'settings.history-retention',
        })
      })
      .finally(() => setSaving(false))
  }

  const changeMode = (mode: RetentionMode) => {
    const next: RetentionPolicy =
      mode === 'by_time'
        ? { mode, days: DEFAULT_TIME_DAYS }
        : mode === 'by_count'
          ? { mode, count: DEFAULT_COUNT_LIMIT }
          : { mode }
    update(next)
  }

  const policy = () => snapshot()?.policy
  const impact = () => policy() ? retentionPolicyImpact(policy()!) : null

  // I13-W4：立即清理 = 独立确认操作（preview → 确认 → prune），修改下拉项不触发任何删除
  const canClean = () => snapshot()?.source === 'backend' && policy() && policy()!.mode !== 'permanent'

  const startPreview = async () => {
    const current = snapshot()
    if (!current || !policy() || policy()!.mode === 'permanent' || saving()) return
    setPreviewing(true)
    setCleanError(null)
    setCleanResult(null)
    setConfirming(false)
    setPreview(null)
    try {
      setPreview(await previewRetentionPolicy(policy()!))
      resolveRuntimeErrors({ key: 'settings:history-retention:preview' })
    } catch (error) {
      setCleanError(`预览失败：${retentionErrorMessage(error)}`)
      reportRuntimeError('预览历史清理', error, undefined, {
        key: 'settings:history-retention:preview', scope: { kind: 'app', id: 'settings-history-retention' }, source: 'settings.history-retention',
      })
    } finally {
      setPreviewing(false)
    }
  }

  const confirmPrune = async () => {
    const current = snapshot()
    if (!current || !policy()) return
    setPruning(true)
    setCleanError(null)
    try {
      const result = await pruneRetentionPolicy(policy()!, current.revision)
      setCleanResult(result)
      setPreview(null)
      setConfirming(false)
      resolveRuntimeErrors({ key: 'settings:history-retention:prune' })
    } catch (error) {
      if (retentionErrorCode(error) === 'retention_stale_preview') {
        // 预览后策略已变 → 拒绝按旧统计执行，重读最新策略要求重新预览
        setCleanError('策略已变化，请重新预览后再确认清理')
        setPreview(null)
        setConfirming(false)
        reload()
      } else {
        setCleanError(`清理失败：${retentionErrorMessage(error)}`)
        setConfirming(false)
      }
      reportRuntimeError('清理历史记录', error, undefined, {
        key: 'settings:history-retention:prune', scope: { kind: 'app', id: 'settings-history-retention' }, source: 'settings.history-retention',
      })
    } finally {
      setPruning(false)
    }
  }

  // A1-c/B5：清理执行已切到 canonical_events；Tauri 下保留策略 UI 重新开放。
  return (
    <div class="set-group">
      <h3 class="set-group-inner-title">历史保留策略</h3>
      <Show when={!loadError()} fallback={
        <>
          <div class="set-hint" role="status">{loadError()}（详情见右下角错误中心）</div>
          <div class="set-preset-row">
            <button type="button" class="ps-btn sm" onClick={reload}>重试</button>
          </div>
        </>
      }>
        <Show when={!loading() && snapshot() && policy()} fallback={<div class="set-hint">正在加载保留策略…</div>}>
          <Show when={snapshot()?.corruptWarning}><div class="set-hint set-impact" role="status">{snapshot()?.corruptWarning}</div></Show>
          <div class="set-row">
            <span class="set-row-label">保留策略</span>
            <Select ariaLabel="保留策略" className="set-select" value={policy()!.mode} disabled={saving()} onChange={value => changeMode(value as RetentionMode)} options={RETENTION_MODE_OPTIONS.map(option => ({ value: option.value, label: option.label }))} />
          </div>
          <Show when={policy()!.mode === 'by_time'}>
            <div class="set-row">
              <span class="set-row-label">保留天数</span>
              <Select ariaLabel="保留天数" className="set-select" value={String(policy()!.days ?? DEFAULT_TIME_DAYS)} disabled={saving()} onChange={value => update({ mode: 'by_time', days: Number(value) })} options={RETENTION_TIME_DAYS.map(days => ({ value: String(days), label: `${days} 天` }))} />
            </div>
          </Show>
          <Show when={policy()!.mode === 'by_count'}>
            <div class="set-row">
              <span class="set-row-label">每会话保留事件数</span>
              <Select ariaLabel="每会话保留事件数" className="set-select" value={String(policy()!.count ?? DEFAULT_COUNT_LIMIT)} disabled={saving()} onChange={value => update({ mode: 'by_count', count: Number(value) })} options={RETENTION_COUNT_LIMITS.map(count => ({ value: String(count), label: `${count} 条` }))} />
            </div>
          </Show>
          <Show when={impact()}><div class="set-hint set-impact" role="status">{impact()!.text}</div></Show>
          <Show when={saveError()}><div class="set-hint" role="status">{saveError()}</div></Show>
          <Show when={saving()}><div class="set-hint">保存中…</div></Show>
          <Show when={canClean()}>
            <div class="set-preset-row">
              <button type="button" class="ps-btn sm" disabled={previewing() || pruning() || saving()}
                onClick={() => void startPreview()}>
                {previewing() ? '预览中…' : '立即清理'}
              </button>
              <Show when={preview() && !confirming()}>
                <button type="button" class="ps-btn sm danger" disabled={pruning()}
                  onClick={() => setConfirming(true)}>
                  确认清理
                </button>
              </Show>
              <Show when={confirming()}>
                <button type="button" class="ps-btn sm danger" disabled={pruning() || saving()}
                  onClick={() => void confirmPrune()}>
                  {pruning() ? '清理中…' : '确认执行'}
                </button>
                <button type="button" class="ps-btn sm" disabled={pruning()}
                  onClick={() => setConfirming(false)}>取消</button>
              </Show>
            </div>
            <Show when={preview()}>
              <div class="set-hint set-impact" role="status">
                预览：将删除 {preview()!.totalCandidates} 条事件，影响 {preview()!.affectedSessions} 个会话
                <Show when={preview()!.oldestDeletedAt != null}>
                  （最早删除时间 {new Date(preview()!.oldestDeletedAt!).toLocaleString('zh-CN')}）
                </Show>
              </div>
            </Show>
            <Show when={cleanResult()}>
              <div class="set-hint" role="status">
                已清理 {cleanResult()!.totalCandidates} 条事件，影响 {cleanResult()!.affectedSessions} 个会话
              </div>
            </Show>
            <Show when={cleanError()}><div class="set-hint" role="status">{cleanError()}</div></Show>
          </Show>
          <div class="set-hint">立即清理是独立确认操作；修改下拉项只保存策略，不会删除任何事件。</div>
        </Show>
      </Show>
    </div>
  )
}
