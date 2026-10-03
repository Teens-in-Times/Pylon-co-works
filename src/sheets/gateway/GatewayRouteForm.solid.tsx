/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'
import type { AdapterInstance, GatewayClient } from '../../infrastructure/tauri/gatewayClient'
import {
  migrateLegacyRouteBindings,
  saveGatewayRouteTransaction,
  type GatewayRouteShape,
} from '../../application/transactions/saveGatewayRouteTransaction'
import { GATEWAY_ROUTE_RESETS, type GatewayRouteReset, type GatewayStatus, type GatewayWriteStatus } from '../../infrastructure/tauri/gatewayContracts.ts'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { EDIT_ROW, FILTER_INPUT, HINT, SECTION, SECTION_HEAD, SECTION_HINT, SECTION_TITLE, TEMPLATE_BTN_PRIMARY, TREE_ERROR } from './gatewaySheetStyles.ts'

/**
 * GatewayRouteForm — 「新增路由」表单（#520 K 域自 GatewaySheetView 拆出）：
 * source/agentId/instance/profile/session/reset/idleMinutes/allowFrom 八字段 +
 * formError，及保存事务（saveGatewayRouteTransaction：合并既有 routes → 保存 →
 * reload → read-back 一致才 ok）。writeStatus（saving/blocked/lock-poisoned/error/ok）
 * 是本表单的保存反馈态，随表单一并内聚。
 *
 * 宿主只注入 gatewayClient（CAS revision 凭证随消费方会话，不另建）、实例目录
 * （宿主 3s 轮询刷新，表单只读消费）与 sheet 作用域 id；保存成功经 onSaved
 * 把事务回读的 routes 交还宿主刷新 status（FE-AUD-004）。
 */

export interface GatewayRouteFormProps {
  /** gateway IPC 客户端（宿主持有；凭证状态不跨面板共享） */
  gatewayClient: GatewayClient
  /** 实例目录（宿主轮询刷新；enabled 实例用于自动预选与严格校验） */
  instances: readonly AdapterInstance[]
  /** 错误中心作用域：key 前缀 `gateway:<sheetId>:<action>` + sheet scope */
  sheetId: string
  /** 保存成功：携带事务回读的 routes，宿主负责刷新 status 快照 */
  onSaved: (routes: GatewayStatus['routes']) => void
}

export default function GatewayRouteForm(props: GatewayRouteFormProps) {
  const sheetScope = createMemo<{ kind: 'sheet'; id: string }>(() => ({ kind: 'sheet', id: props.sheetId }))
  const operationKey = (action: string) => `gateway:${props.sheetId}:${action}`
  const [editSource, setEditSource] = createSignal('')
  const [editAgentId, setEditAgentId] = createSignal('')
  // I12 W6（LR2-WI02）：新 route 表单——instance/profile/session 必填，其余可选
  const [editInstanceId, setEditInstanceId] = createSignal('')
  const [editProfileId, setEditProfileId] = createSignal('')
  const [editSessionKey, setEditSessionKey] = createSignal('')
  const [editReset, setEditReset] = createSignal<GatewayRouteReset>('idle')
  const [editIdleMinutes, setEditIdleMinutes] = createSignal('')
  const [editAllowFrom, setEditAllowFrom] = createSignal('')
  const [formError, setFormError] = createSignal('')
  const [writeStatus, setWriteStatus] = createSignal<GatewayWriteStatus>({ kind: 'idle' })
  // profile 只读消费（identityStore 仅查读，不写）
  const profiles = createZustandSignal(useIdentityStore, state => state.profiles)

  // W3-02 + FE-AUD-004：保存 = saveGatewayRouteTransaction（合并既有 routes → 保存 →
  // reload → read-back 一致才 ok）；锁中毒/回读 mismatch 明确展示
  // I12 W6（LR2-WI02）：新 route 必须绑定 instance/profile/session；既有 legacy route
  // 在保存时经 migrateLegacyRouteBindings 自动补绑定（平台唯一 enabled instance 时）
  const saveRoute = async () => {
    const route: GatewayRouteShape = {
      source: editSource().trim(),
      agentId: editAgentId().trim(),
      ...(editInstanceId() ? { instanceId: editInstanceId() } : {}),
      ...(editProfileId() ? { profileId: editProfileId() } : {}),
      ...(editSessionKey().trim() ? { sessionKey: editSessionKey().trim() } : {}),
      reset: editReset(),
      ...(editIdleMinutes().trim() !== '' ? { idleMinutes: Number(editIdleMinutes()) } : {}),
      ...(editAllowFrom().trim() ? { allowFrom: editAllowFrom().split(',').map(part => part.trim()).filter(Boolean) } : {}),
    }
    // 严格校验：新 route 必须绑定存在的 instance + 有效 profile/session（I12 W6）
    if (!route.instanceId) {
      setFormError('请选择实例：该 source 平台无可绑定实例（唯一 enabled instance 时自动选择）')
      return
    }
    if (!route.profileId) {
      setFormError('请选择 profile')
      return
    }
    if (!route.sessionKey) {
      setFormError('请输入 session')
      return
    }
    setFormError('')
    setWriteStatus({ kind: 'saving' })
    const enabledInstances = props.instances.filter(instance => instance.enabled)
    const readMigrated = async (): Promise<GatewayRouteShape[]> => {
      // SAFETY: 负载已经 normalizeGatewayStatus 收敛，但 gatewayClient 刻意只声明
      // Promise<unknown>——typed 消费发生在调用点（legacy 门禁 "raw as GatewayStatus" 亦断言此处）。
      // routes 的契约元素 GatewayRoute 与事务入参 GatewayRouteShape 字段同源，差别只在
      // reset 的必选/可选；该断言把契约快照交给事务侧校验（migrateLegacyRouteBindings +
      // upsertGatewayRoute 的 validateGatewayRoute），不引入未经验证的运行时形状。
      const existing = (await props.gatewayClient.status() as GatewayStatus).routes as unknown as GatewayRouteShape[]
      return migrateLegacyRouteBindings(existing, enabledInstances)
    }
    const result = await saveGatewayRouteTransaction(
      route,
      {
        readRoutes: readMigrated,
        saveRoutes: payload => props.gatewayClient.updateAgentsConfig(payload),
        reload: () => props.gatewayClient.reload(),
        readBackRoutes: readMigrated,
        reportError: (action, cause) => reportRuntimeError(action, cause, undefined, {
          key: operationKey(action), scope: sheetScope(), source: 'gateway',
        }),
      },
    )
    if (!result.ok) {
      // 命令缺失（旧版二进制）→ blocked；锁中毒/回读 mismatch 明确展示
      if (result.kind === 'blocked') setWriteStatus({ kind: 'blocked' })
      else if (result.kind === 'mismatch') {
        setWriteStatus({ kind: 'lock-poisoned' })
        reportRuntimeError('保存网关配置', new Error(result.message), undefined, {
          key: operationKey('保存网关配置'), scope: sheetScope(), source: 'gateway',
        })
      }
      else setWriteStatus({ kind: 'error', message: result.message })
      return
    }
    // FE-AUD-004：保存成功后用事务回读结果刷新 UI（status 不只挂载时读一次）
    props.onSaved(result.value as GatewayStatus['routes'])
    setWriteStatus({ kind: 'ok' })
    for (const action of ['读取网关路由', '保存网关配置', '重载网关', '回读网关状态']) {
      resolveRuntimeErrors({ key: operationKey(action) })
    }
  }

  // I12 W6：source 变化时，若平台恰好一个 enabled instance 则自动预选实例（可手动改）
  const onSourceChange = (value: string) => {
    setEditSource(value)
    const bound = migrateLegacyRouteBindings(
      [{ source: value.trim(), agentId: editAgentId().trim() }],
      props.instances.filter(instance => instance.enabled),
    )
    setEditInstanceId(bound[0]?.instanceId ?? '')
  }

  return (
    <section class={SECTION}>
      <div class={SECTION_HEAD}>
        <h3 class={SECTION_TITLE}>新增路由</h3>
      </div>
      <p class={SECTION_HINT}>把平台会话（source）绑定到 agent：实例 / profile / session 为必填，其余可选</p>
      <div class={EDIT_ROW}>
        <input class={FILTER_INPUT} placeholder="source（如 qq:group:123）" value={editSource()} onInput={e => onSourceChange(e.currentTarget.value)} aria-label="路由 source" />
        <input class={FILTER_INPUT} placeholder="agentId（如 peri）" value={editAgentId()} onInput={e => setEditAgentId(e.currentTarget.value)} aria-label="路由 agentId" />
      </div>
      <div class={EDIT_ROW}>
        <select class={FILTER_INPUT} aria-label="路由 instance" value={editInstanceId()} onChange={e => setEditInstanceId(e.currentTarget.value)}>
          <option value="">选择实例</option>
          <For each={props.instances}>{instance => (
            <option value={instance.id}>{instance.label || instance.id}（{instance.platform}）{instance.enabled ? '' : '· 未启用'}</option>
          )}</For>
        </select>
        <select class={FILTER_INPUT} aria-label="路由 profile" value={editProfileId()} onChange={e => setEditProfileId(e.currentTarget.value)}>
          <option value="">选择 profile</option>
          <For each={profiles()}>{profile => (
            <option value={profile.id}>{profile.name || profile.id}</option>
          )}</For>
        </select>
        <input class={FILTER_INPUT} placeholder="session（如 战役1）" value={editSessionKey()} onInput={e => setEditSessionKey(e.currentTarget.value)} aria-label="路由 session" />
      </div>
      <div class={EDIT_ROW}>
        <select class={FILTER_INPUT} aria-label="路由 reset" value={editReset()} onChange={e => setEditReset(e.currentTarget.value as GatewayRouteReset)}>
          <For each={GATEWAY_ROUTE_RESETS}>{reset => (
            <option value={reset}>{reset}</option>
          )}</For>
        </select>
        <input class={FILTER_INPUT} placeholder="idleMinutes（可选）" type="number" min="0" value={editIdleMinutes()} onInput={e => setEditIdleMinutes(e.currentTarget.value)} aria-label="路由 idleMinutes" />
        <input class={FILTER_INPUT} placeholder="allowFrom（逗号分隔，可选）" value={editAllowFrom()} onInput={e => setEditAllowFrom(e.currentTarget.value)} aria-label="路由 allowFrom" />
        <button type="button" class={TEMPLATE_BTN_PRIMARY} onClick={() => void saveRoute()}>保存</button>
      </div>
      <Show when={formError()}><div class={TREE_ERROR} role="alert">{formError()}</div></Show>
      <Show when={writeStatus().kind === 'blocked'}><p class={HINT} role="status">后端命令不可用：update_agents_config（请检查应用版本）</p></Show>
      <Show when={writeStatus().kind === 'lock-poisoned'}><p class="file-section-hint gateway-error-reference" role="status">网关配置回读不一致，详情见右下角错误中心</p></Show>
      <Show when={writeStatus().kind === 'error'}><p class="file-section-hint gateway-error-reference" role="status">网关配置保存失败，详情见右下角错误中心</p></Show>
      <Show when={writeStatus().kind === 'ok'}><p class={HINT} role="status">已保存并重载</p></Show>
    </section>
  )
}
