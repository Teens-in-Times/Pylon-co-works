/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { IS_TAURI } from '../../infrastructure/tauri/env'
import { appClients } from '../../app/appClients.ts'
import type { AdapterInstance } from '../../infrastructure/tauri/gatewayClient'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'

// FE-AUD-008：typed client 收口 gateway 域 command literal
const gatewayClient = appClients.gateway()


const credentialLabel = (status: AdapterInstance['credentialStatus']): string =>
  status === 'configured' ? '已配置' : status === 'invalid' ? '损坏' : '未配置'

const statusLabel = (status: AdapterInstance['status']): string =>
  status === 'connected' ? '已连接' : status === 'starting' ? '启动中' : status === 'error' ? '错误' : '已停止'

/** Tauri invoke 拒绝值为 { code, message } 对象（非 Error）——提取 message 展示（CR-001）。 */
function errorMessage(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) {
    const message = (cause as { message: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(cause)
}

/**
 * GatewayRiskPanel — Settings「Agent 与连接 › Gateway」风险 consumer（ISSUE-13 W5）。
 *
 * #515：Solid 实体（原 GatewayRiskPanel.tsx 为 React 薄桥）。
 *
 * 只消费 ISSUE-12 的真实 capability（gatewayClient catalog/instances + credentialStatus），
 * 准确提示备份/凭据边界，**不伪装备份加密**：
 * - 凭据加密存储（版本化加密 envelope + 系统主密钥），日志/导出/UI 永不回显 secret；
 * - Gateway 凭据不进入通用设置导出（secret 不在 CONFIG_STORAGE_KEYS）；
 * - 安全备份能力尚未提供——不生成含凭据的备份，请勿假定已存在加密备份。
 */
export default function GatewayRiskPanel() {
  const [instances, setInstances] = createSignal<AdapterInstance[] | null>(null)
  const [loading, setLoading] = createSignal(IS_TAURI)
  const [error, setError] = createSignal<string | null>(null)
  let disposed = false
  onCleanup(() => { disposed = true })

  const reload = () => {
    if (!IS_TAURI) {
      setInstances([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    gatewayClient
      .instances()
      .then(list => {
        if (disposed) return
        setInstances(list)
        resolveRuntimeErrors({ key: 'settings:gateway-risk:instances' })
      })
      .catch(cause => {
        if (disposed) return
        setError(`读取 Gateway 实例失败：${errorMessage(cause)}`)
        reportRuntimeError('读取 Gateway 实例', cause, undefined, {
          key: 'settings:gateway-risk:instances',
          scope: { kind: 'app', id: 'settings-gateway' },
          source: 'settings.gateway-risk',
        })
      })
      .finally(() => { if (!disposed) setLoading(false) })
  }

  // 原 useEffect([]) 挂载即拉取；Solid 组件体只跑一次，直接在此发起。
  if (IS_TAURI) reload()

  const configuredCount = createMemo(() => instances()?.filter(i => i.credentialStatus === 'configured').length ?? 0)
  const invalidCount = createMemo(() => instances()?.filter(i => i.credentialStatus === 'invalid').length ?? 0)
  const missingCount = createMemo(() => instances()?.filter(i => i.credentialStatus === 'missing').length ?? 0)

  return (
    <div class="set-group">
      <h3 class="set-group-inner-title">Gateway 连接与备份</h3>
      <Show when={IS_TAURI} fallback={<div class="set-hint">Gateway 管理需要 Tauri 后端。</div>}>
        <Show when={!error()} fallback={
          <>
            <div class="set-hint" role="status">{error()}（详情见右下角错误中心）</div>
            <div class="set-preset-row">
              <button type="button" class="ps-btn sm" onClick={reload}>重试</button>
            </div>
          </>
        }>
          <Show when={loading() || instances() === null} fallback={
            <>
              <Show when={(instances()?.length ?? 0) === 0} fallback={
                <div class="set-preset-row">
                  <span class="set-hint">
                    实例 {instances()!.length} 个：已配置凭据 {configuredCount()}、
                    未配置 {missingCount()}
                    <Show when={invalidCount() > 0}>、损坏 {invalidCount()}</Show>
                  </span>
                </div>
              }>
                <div class="set-hint">尚未创建 Gateway 实例。</div>
              </Show>
              <For each={instances() ?? []}>{instance => (
                <div class="set-row">
                  <span class="set-row-label">{instance.platform}</span>
                  <span class="set-hint" style={{ margin: 0 }}>
                    {instance.label} · {statusLabel(instance.status)}
                    <Show when={instance.lastError}> · {instance.lastError}</Show>
                    {' · '}凭据：{credentialLabel(instance.credentialStatus)}
                  </span>
                </div>
              )}</For>
              <Show when={missingCount() > 0}>
                <div class="set-hint set-impact">有实例未配置凭据，无法连接。</div>
              </Show>
              <div class="set-hint">
                Gateway 凭据以加密 envelope 存储（系统主密钥保护），日志、界面与导出永不回显 secret。
              </div>
              <div class="set-hint set-impact">
                安全备份能力尚未提供：Gateway 凭据不进入通用设置导出，当前不会生成包含凭据的备份，
                请勿假定已存在加密备份。
              </div>
            </>
          }>
            <div class="set-hint">正在加载 Gateway 实例…</div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
