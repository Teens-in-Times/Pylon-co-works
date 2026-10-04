/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { PYLON_PLUGIN_CAPABILITIES } from '../../plugin-runtime/packageManifest.ts'
import {
  getPluginCapabilityGrantStore,
} from '../../plugin-runtime/management/pluginManagementWiring.ts'
import type { KernelBootstrap } from '../../kernel/kernelBootstrap.ts'

/**
 * P53 D2 · 宿主授权卡：声明了 capability 但未获用户授权的插件在此批准/拒绝。
 * 授权数据 host-owned（grant store）；批准后经 bootstrap.retryPlugin 自然激活。
 * 这是宿主职责（同意流的 UI 载体），不属于任何插件 API。
 *
 * #515：Solid 实体（原 PluginCapabilityConsentCard.tsx 为 React 薄桥）。
 */

interface PluginCapabilityConsentCardProps {
  /** 待授权声明清单：bootstrap capability-consent 失败投影。 */
  readonly pending: readonly {
    pluginId: string
    pluginVersion: string
    capabilities: readonly string[]
    message: string
  }[]
  readonly bootstrap?: Pick<KernelBootstrap, 'retryPlugin'>
}

export default function PluginCapabilityConsentCard(props: PluginCapabilityConsentCardProps) {
  const store = getPluginCapabilityGrantStore()
  const [grantsVersion, setGrantsVersion] = createSignal(0)
  onCleanup(store.subscribe(() => setGrantsVersion(n => n + 1)))
  const [busy, setBusy] = createSignal(false)
  const grantedKeys = createMemo(() => {
    void grantsVersion()
    const snapshot = store.snapshot()
    const keys = new Set<string>()
    for (const [pluginId, capabilities] of Object.entries(snapshot)) {
      for (const [capability, record] of Object.entries(capabilities)) {
        keys.add(`${pluginId}:${capability}:${record.pluginVersion}`)
      }
    }
    return keys
  })

  const decide = async (
    pluginId: string,
    pluginVersion: string,
    capability: string,
    approve: boolean,
  ) => {
    setBusy(true)
    try {
      if (approve) {
        store.grant(pluginId, capability as (typeof PYLON_PLUGIN_CAPABILITIES)[number], {
          pluginVersion,
          apiVersion: '1.2',
        })
        await props.bootstrap?.retryPlugin(pluginId)
      } else {
        store.revoke(pluginId, capability as (typeof PYLON_PLUGIN_CAPABILITIES)[number])
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={props.pending.length > 0} fallback={null}>
      <div class="set-group" data-capability-consent-card aria-label="插件能力授权">
        <div class="set-group-title">能力授权</div>
        <div class="set-hint">
          以下插件在 manifest 中声明了宿主能力（{PYLON_PLUGIN_CAPABILITIES.join('/')}），需要你批准后才能激活。
        </div>
        <For each={props.pending}>{item => {
          // 兜底值保护（review P2-4/B）：failure 缺 version/capabilities 时批准会写入
          // 永不生效的错位 grant，禁用交互而非猜默认值
          const metaComplete = item.pluginVersion !== '0.0.0' && item.capabilities.length > 0
          return <For each={item.capabilities}>{capability => {
            const granted = () => grantedKeys().has(`${item.pluginId}:${capability}:${item.pluginVersion}`)
            return (
              <div class="plugin-row">
                <span class="plugin-row-id">{item.pluginId}</span>
                <span class="plugin-type-badge type-first-party">{capability}</span>
                <span class="set-hint">{item.message}</span>
                <div class="plugin-row-actions">
                  <Show when={granted()} fallback={
                    <>
                      <button
                        type="button"
                        class="ps-btn primary sm"
                        disabled={busy() || !metaComplete}
                        aria-label={`批准 ${item.pluginId} 的 ${capability} 能力`}
                        onClick={() => { void decide(item.pluginId, item.pluginVersion, capability, true) }}
                      >
                        批准
                      </button>
                      <button
                        type="button"
                        class="ps-btn sm"
                        disabled={busy()}
                        aria-label={`拒绝 ${item.pluginId} 的 ${capability} 能力`}
                        onClick={() => { void decide(item.pluginId, item.pluginVersion, capability, false) }}
                      >
                        拒绝
                      </button>
                    </>
                  }>
                    <span class="plugin-state-badge is-active">已授权</span>
                  </Show>
                </div>
              </div>
            )
          }}</For>
        }}</For>
      </div>
    </Show>
  )
}
