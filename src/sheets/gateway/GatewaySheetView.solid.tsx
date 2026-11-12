/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { formatRuntimeError, reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'
import type { AdapterCatalogItem, AdapterInstance, GatewayInstanceInput } from '../../infrastructure/tauri/gatewayClient'
import type { GatewayStatus, PlatformSession } from '../../infrastructure/tauri/gatewayContracts.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import ConfirmArmButton from '../../components/ui/ConfirmArmButton.solid.tsx'
import GatewayRouteForm from './GatewayRouteForm.solid.tsx'
import {
  EDIT_ROW,
  EMPTY,
  FIELD_LABEL,
  FIELD_ROW,
  FIELD_VALUE,
  FILTER_INPUT,
  FORM_GRID,
  FORM_FIELD,
  HEADER,
  HINT,
  INSTANCE_CARD,
  INSTANCE_CARD_ERROR,
  INSTANCE_HEAD,
  INSTANCE_LIST,
  INSTANCE_STATUS_CONNECTED,
  INSTANCE_STATUS_ERROR,
  INSTANCE_STATUS_STARTING,
  INSTANCE_STATUS_STOPPED,
  MAIN,
  MAIN_TITLE,
  ROUTE,
  ROUTE_DETAIL,
  ROUTE_DETAIL_CODE,
  ROUTE_DETAIL_FIELD,
  ROUTE_HEAD,
  ROUTE_HEAD_PATH,
  ROUTE_HEAD_TEXT,
  ROUTE_OPEN,
  ROUTE_RESET,
  ROUTES,
  SECTION,
  SECTION_HEAD,
  SECTION_HINT,
  SECTION_META,
  SECTION_TITLE,
  SIDEBAR,
  SIDEBAR_HINT,
  SIDEBAR_ITEM,
  SIDEBAR_ITEM_PATH,
  SIDEBAR_ITEM_TEXT,
  SIDEBAR_LIST,
  SUMMARY,
  SUMMARY_CHIP,
  SUMMARY_CHIP_ONLINE,
  SUMMARY_NUM,
  TEMPLATE_BTN,
  TEMPLATE_BTN_DANGER,
  TEMPLATE_BTN_PRIMARY,
} from './gatewaySheetStyles.ts'

/**
 * 网关工作面：读取状态/平台目录并编排实例操作，路由写回事务归 GatewayRouteForm。
 * 目录决定可创建的平台与凭据字段；凭据提交后清空明文草稿。
 * 可见时轮询实例快照，操作在途禁重复提交，删除由 ConfirmArmButton 二次确认。
 */

function statusLabel(status: AdapterInstance['status']): string {
  return status === 'connected' ? '已连接' : status === 'starting' ? '启动中' : status === 'error' ? '错误' : '已停止'
}

// 无字段描述平台的回退凭据框（模块级常量保持引用稳定，供 For 按引用去重）。
const FALLBACK_CREDENTIAL_FIELDS = [{ key: 'secret', label: '凭据（appId:clientSecret）', secret: true, required: true }]

export interface GatewaySheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

export default function GatewaySheetView(props: GatewaySheetViewProps) {
  const sheetScope = createMemo<{ kind: 'sheet'; id: string }>(() => ({ kind: 'sheet', id: props.sheet.id }))
  const operationKey = (action: string, suffix = '') => `gateway:${props.sheet.id}:${action}${suffix ? `:${suffix}` : ''}`
  const gatewayClient = appClients.gateway()
  const [status, setStatus] = createSignal<GatewayStatus | null>(null)
  const [sessions, setSessions] = createSignal<PlatformSession[]>([])
  const [error, setError] = createSignal('')
  const [expandedRoute, setExpandedRoute] = createSignal<number | null>(null)
  // profile 只读消费（identityStore 仅查读，不写）
  // I12-W5：实例/目录 + 操作反馈
  const [instances, setInstances] = createSignal<AdapterInstance[]>([])
  const [catalog, setCatalog] = createSignal<AdapterCatalogItem[]>([])
  const [instanceError, setInstanceError] = createSignal('')
  const [instancePending, setInstancePending] = createSignal(false)
  // P79：凭据草稿按 catalog 字段顺序存放（无字段描述的平台回退单框 = index 0）
  const [credentialDrafts, setCredentialDrafts] = createSignal<Record<string, string[]>>({})
  const [createForm, setCreateForm] = createSignal<{ platform: string; id: string; label: string }>({ platform: '', id: '', label: '' })

  // FE-AUD-004：GatewayRouteForm 保存成功后用事务回读结果刷新 status（不只挂载时读一次）
  const applySavedRoutes = (routes: GatewayStatus['routes']) => {
    setStatus({ ...(status() ?? { adapters: [], routes: [], qq: null, inject: null }), routes })
  }

  // W3-02：gateway_status 拉取（原 useEffect [gatewayClient, operationKey, sheet.id, sheetScope]
  // —— 挂载期一次性，sheet.id 变化即换 sheet 实例，落 onMount）。
  onMount(() => {
    let disposed = false
    gatewayClient.status().then(raw => {
      if (!disposed) {
        setStatus(raw as GatewayStatus)
        setError('')
        resolveRuntimeErrors({ key: operationKey('读取网关状态') })
      }
    }).catch(err => {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError('读取网关状态', err, undefined, {
          key: operationKey('读取网关状态'), scope: sheetScope(), source: 'gateway',
        })
      }
    })
    onCleanup(() => { disposed = true })
  })

  // Phase 2：平台会话（gateway_sessions 只读快照；挂载期一次性 → onMount）。
  onMount(() => {
    let disposed = false
    gatewayClient.sessions().then(raw => {
      if (!disposed) {
        setSessions(raw as PlatformSession[])
        resolveRuntimeErrors({ key: operationKey('读取平台会话') })
      }
    }).catch(err => {
      if (!disposed) reportRuntimeError('读取平台会话', err, undefined, {
        key: operationKey('读取平台会话'), scope: sheetScope(), source: 'gateway',
      })
    })
    onCleanup(() => { disposed = true })
  })

  // I12-W5：实例列表 + 平台 catalog（创建表单可用平台与凭据字段来源）
  const reloadInstances = async () => {
    try {
      setInstances(await gatewayClient.instances())
      setInstanceError('')
      resolveRuntimeErrors({ key: operationKey('读取网关实例') })
    } catch (err) {
      setInstanceError(formatRuntimeError('读取网关实例', err).message)
      reportRuntimeError('读取网关实例', err, undefined, {
        key: operationKey('读取网关实例'), scope: sheetScope(), source: 'gateway',
      })
    }
  }
  onMount(() => {
    let disposed = false
    void reloadInstances()
    gatewayClient.catalog().then(items => {
      if (!disposed) {
        setCatalog(items)
        resolveRuntimeErrors({ key: operationKey('读取平台目录') })
      }
    }).catch(err => {
      if (!disposed) reportRuntimeError('读取平台目录', err, undefined, {
        key: operationKey('读取平台目录'), scope: sheetScope(), source: 'gateway',
      })
    })
    onCleanup(() => { disposed = true })
  })

  // P79：实例状态轮询——状态翻转（starting→connected/error）无后端推送通道，
  // 挂载期间低频轮询让「已连接/错误」自动可见（此前必须重开 sheet 才能看到）。
  onMount(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || instancePending()) return
      void reloadInstances()
    }, INSTANCE_REFRESH_MS)
    onCleanup(() => window.clearInterval(timer))
  })

  const runInstanceAction = async (operation: string, action: () => Promise<unknown>) => {
    if (instancePending()) return false
    setInstancePending(true)
    try {
      await action()
      // The mutation itself succeeded; retire its prior notification before
      // the follow-up snapshot read. A snapshot failure is tracked separately
      // under "读取网关实例" and must not make a successful mutation look
      // permanently failed.
      resolveRuntimeErrors({ key: operationKey(operation) })
      await reloadInstances()
      return true
    } catch (err) {
      setInstanceError(formatRuntimeError(operation, err).message)
      reportRuntimeError(operation, err, undefined, {
        key: operationKey(operation), scope: sheetScope(), source: 'gateway',
      })
      return false
    } finally {
      setInstancePending(false)
    }
  }

  const createInstance = async () => {
    const form = createForm()
    if (!form.platform || !form.id.trim()) return
    const input: GatewayInstanceInput = {
      platform: form.platform,
      id: form.id.trim(),
      label: form.label.trim() || form.id.trim(),
      enabled: true,
      autoStart: false,
    }
    if (await runInstanceAction('创建网关实例', () => gatewayClient.createInstance(input))) {
      setCreateForm({ platform: form.platform, id: '', label: '' })
    }
  }

  const credentialFieldsFor = (platform: string) => {
    return catalog().find(item => item.platform === platform)?.credentialFields ?? []
  }

  const setCredentialDraft = (id: string, index: number, value: string) => {
    setCredentialDrafts(prev => {
      const current = prev[id] ?? []
      const next = [...current]
      next[index] = value
      return { ...prev, [id]: next }
    })
  }

  const submitCredentials = async (instance: AdapterInstance) => {
    const drafts = credentialDrafts()[instance.id] ?? []
    const secret = drafts.join(':')
    if (!secret) return
    await runInstanceAction('保存网关凭据', () => gatewayClient.setInstanceCredentials(instance.id, secret))
    // I12-W5：凭据提交后清空前端 secret state（明文不残留）
    setCredentialDrafts(prev => ({ ...prev, [instance.id]: [] }))
  }

  // P82：页头状态摘要（在线实例 / 路由 / 适配器）
  const availablePlatforms = createMemo(() => catalog().filter(item => item.availability === 'builtIn'))
  const connectedCount = createMemo(() => instances().filter(instance => instance.status === 'connected').length)

  // 样式绞杀（P93 批 3）：原 GatewaySheet.css 的 utility 化，常量单一来源见
  // gatewaySheetStyles.ts（#520 K 域随表单拆分收拢）。gateway-* 类名保留为
  // gateway/styles/adaptive.css（modern-gui 覆写 + status-pulse 动画）锚点。
  const SHEET = 'gateway-sheet flex-1 flex min-w-0 bg-surface-raised text-text font-[family-name:var(--font)]'
  const INSTANCE_REFRESH_MS = 3000

  return (
    <div class={SHEET}>
      <aside class={SIDEBAR}>
        <div class={SECTION_TITLE}>适配器</div>
        <Show when={(status()?.adapters.length ?? 0) > 0} fallback={<p class={SIDEBAR_HINT}>无适配器</p>}>
          <ul class={SIDEBAR_LIST}>
            <For each={status()!.adapters}>{adapter => (
              <li class={SIDEBAR_ITEM}><span class={SIDEBAR_ITEM_PATH}>{adapter}</span></li>
            )}</For>
          </ul>
        </Show>
        <div class={SECTION_TITLE}>平台会话</div>
        <Show when={sessions().length > 0} fallback={<p class={SIDEBAR_HINT}>无平台会话</p>}>
          <ul class={SIDEBAR_LIST}>
            <For each={sessions()}>{session => (
              <li class={SIDEBAR_ITEM}>
                <span class={SIDEBAR_ITEM_PATH}>{session.source}</span>
                <span class={SIDEBAR_ITEM_TEXT}>→ {session.agentId} · {session.reset}</span>
              </li>
            )}</For>
          </ul>
        </Show>
      </aside>
      <main class={MAIN}>
        <Show when={error()}><p class={HINT} role="status">网关状态读取失败，详情见右下角错误中心</p></Show>
        <header class={HEADER}>
          <div>
            <h2 class={MAIN_TITLE}>平台概览</h2><p class="m-0 mt-2 text-[13px] leading-relaxed text-text-dim">连接消息平台，让 Agent 在你常用的会话中工作。</p>
          </div>
          <div class={SUMMARY} aria-label="网关状态摘要">
            <span class={SUMMARY_CHIP}><span class={SUMMARY_NUM}>{instances().length}</span> 实例</span>
            <span class={SUMMARY_CHIP_ONLINE}><span class={`${SUMMARY_NUM} text-success`}>{connectedCount()}</span> 在线</span>
            <span class={SUMMARY_CHIP}><span class={SUMMARY_NUM}>{status()?.routes.length ?? 0}</span> 路由</span>
            <span class={SUMMARY_CHIP}><span class={SUMMARY_NUM}>{status()?.adapters.length ?? 0}</span> 适配器</span>
          </div>
        </header>

        <section class={SECTION}>
          <div class={SECTION_HEAD}>
            <h3 class={SECTION_TITLE}>路由</h3>
            <span class={SECTION_META}>{status()?.routes.length ?? 0} 条 · 点击展开详情</span>
          </div>
          <Show when={Boolean(status()) && status()!.routes.length === 0} fallback={
            <div class={ROUTES}>
              <For each={status()?.routes ?? []}>{(route, index) => (
                <div class={expandedRoute() === index() ? ROUTE_OPEN : ROUTE}>
                  <button type="button" class={ROUTE_HEAD} aria-expanded={expandedRoute() === index()} onClick={() => setExpandedRoute(expandedRoute() === index() ? null : index())}>
                    <span class={ROUTE_HEAD_PATH}>{route.source}</span>
                    <span class={ROUTE_HEAD_TEXT}>→ {route.agentId}</span>
                    <span class={ROUTE_RESET}>{route.reset}</span>
                  </button>
                  <Show when={expandedRoute() === index()}>
                    <div class={ROUTE_DETAIL}>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>instanceId</code> = {route.instanceId || '—（未绑定实例）'}</div>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>profileId</code> = {route.profileId || '—'}</div>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>sessionKey</code> = {route.sessionKey || '—'}</div>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>allowFrom</code> = {(route.allowFrom || []).join(', ') || '—'}</div>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>idleMinutes</code> = {route.idleMinutes ?? '—'}</div>
                    </div>
                  </Show>
                </div>
              )}</For>
            </div>
          }>
            <p class={EMPTY}>还没有路由——在下方「新增路由」把平台会话（如 qq 群）绑定到 agent</p>
          </Show>
        </section>

        {/* #520 K 域：「新增路由」表单簇拆至 GatewayRouteForm（字段信号、保存事务与
                writeStatus 反馈内聚在表单；宿主只注入 client/实例目录/sheet 作用域）。 */}
        <GatewayRouteForm
          gatewayClient={gatewayClient}
          instances={instances()}
          sheetId={props.sheet.id}
          onSaved={applySavedRoutes}
        />

        {/* I12-W5：实例管理（真实实例/状态/错误/操作；未实现平台不可用） */}
        <section class={SECTION} aria-busy={instancePending()}>
          <div class={SECTION_HEAD}>
            <h3 class={SECTION_TITLE}>实例</h3>
            <span class={SECTION_META}>状态每 {INSTANCE_REFRESH_MS / 1000} 秒自动刷新</span>
          </div>
          <p class={SECTION_HINT}>为每个消息平台创建独立实例，配置凭据后即可启动。</p>
          <Show when={instanceError()}><p class={HINT} role="status">{instanceError()}</p></Show>
          <Show when={instances().length === 0} fallback={
            <ul class={INSTANCE_LIST}>
              <For each={instances()}>{instance => {
                // For 的 item 映射每项只跑一次（untrack）——随 catalog 变化的值必须收进
                // 访问器，让 JSX 模板内的 getter 逐处追踪（原 React 每渲染重算的等价）。
                const fields = () => credentialFieldsFor(instance.platform)
                const drafts = () => credentialDrafts()[instance.id] ?? []
                const readyToSave = () => fields().length > 0
                  ? fields().every((field, index) => !field.required || (drafts()[index] ?? '').length > 0)
                  : (drafts()[0] ?? '').length > 0
                const statusCls = instance.status === 'connected' ? INSTANCE_STATUS_CONNECTED
                  : instance.status === 'error' ? INSTANCE_STATUS_ERROR
                  : instance.status === 'starting' ? INSTANCE_STATUS_STARTING
                  : INSTANCE_STATUS_STOPPED
                return (
                  <li class={instance.status === 'error' ? INSTANCE_CARD_ERROR : INSTANCE_CARD}>
                    <div class={INSTANCE_HEAD}>
                      <span class="search-result-path">{instance.label || instance.id}</span>
                      <span class={statusCls}>{statusLabel(instance.status)}</span>
                      <span class="search-result-text">· {instance.platform}</span>
                      <span class="search-result-text">凭据：{instance.credentialStatus === 'configured' ? '已配置' : instance.credentialStatus === 'invalid' ? '损坏' : '未配置'}</span>
                    </div>
                    <Show when={instance.lastError}><p class="file-section-hint" role="status">上次运行错误：{instance.lastError}</p></Show>
                    <div class={EDIT_ROW}>
                      <button type="button" class={TEMPLATE_BTN_PRIMARY} disabled={instancePending() || instance.status === 'starting' || instance.status === 'connected'} onClick={() => void runInstanceAction('启动网关实例', () => gatewayClient.startInstance(instance.id))}>启动</button>
                      <button type="button" class={TEMPLATE_BTN} disabled={instancePending() || instance.status === 'stopped' || instance.status === 'starting'} onClick={() => void runInstanceAction('停止网关实例', () => gatewayClient.stopInstance(instance.id))}>停止</button>
                      <button type="button" class={TEMPLATE_BTN} disabled={instancePending() || instance.status === 'starting'} onClick={() => void runInstanceAction('重启网关实例', () => gatewayClient.restartInstance(instance.id))}>重启</button>
                      {/* P79：删除二段确认（误点保护，3s 自动回弹）——#520 K 域起由
                          ui/ConfirmArmButton 统一承载；armed 态换危险配色。 */}
                      <ConfirmArmButton
                        label="删除"
                        confirmLabel="确认删除"
                        class={TEMPLATE_BTN}
                        confirmClass={TEMPLATE_BTN_DANGER}
                        disabled={instancePending() || instance.status !== 'stopped'}
                        ariaLabel={`删除 ${instance.id}`}
                        confirmAriaLabel={`确认删除 ${instance.id}`}
                        onConfirm={() => void runInstanceAction('删除网关实例', () => gatewayClient.removeInstance(instance.id))}
                      />
                    </div>
                    {/* P79：凭据字段按 catalog credentialFields 渲染（secret → 密码框）；
                        提交按字段顺序 join ':'；无字段描述的平台回退单框。 */}
                    <div class={FORM_GRID}>
                      <For each={(fields().length > 0 ? fields() : FALLBACK_CREDENTIAL_FIELDS)}>{(field, index) => (
                        <label class={FORM_FIELD}>{field.label}{field.required ? '' : '（可选）'}<input
                          class={FILTER_INPUT}
                          type={field.secret ? 'password' : 'text'}
                          placeholder={`${field.label}${field.required ? '' : '（可选）'}`}
                          value={drafts()[index()] ?? ''}
                          onInput={e => setCredentialDraft(instance.id, index(), e.currentTarget.value)}
                          aria-label={`${instance.id} ${field.label}`}
                          autocomplete="off"
                          disabled={instancePending()}
                        /></label>
                      )}</For>
                      <button type="button" class={`${TEMPLATE_BTN} self-end justify-self-start`} disabled={instancePending() || !readyToSave()} onClick={() => void submitCredentials(instance)}>保存凭据</button>
                    </div>
                  </li>
                )
              }}</For>
            </ul>
          }>
            <p class={EMPTY}>还没有实例——在下方「新建实例」创建，配置凭据后启动</p>
          </Show>
          <div class={`${SECTION_HEAD} gateway-section-head-sub`}>
            <h3 class={SECTION_TITLE}>新建实例</h3>
          </div>
          <p class={SECTION_HINT}>仅显示已实现平台；创建后配置凭据并启动。未实现平台（如微信）不可创建。</p>
          <Show when={availablePlatforms().length === 0} fallback={
            <fieldset class={`${FORM_GRID} p-0 border-0`} disabled={instancePending()}>
              <label class={FORM_FIELD}>平台<select class={FILTER_INPUT} aria-label="平台" value={createForm().platform} onChange={e => setCreateForm(prev => ({ ...prev, platform: e.currentTarget.value }))}>
                <option value="">选择平台</option>
                <For each={availablePlatforms()}>{item => <option value={item.platform}>{item.label}</option>}</For>
              </select></label>
              <label class={FORM_FIELD}>实例标识<input class={FILTER_INPUT} placeholder="如 qq-work" value={createForm().id} onInput={e => setCreateForm(prev => ({ ...prev, id: e.currentTarget.value }))} aria-label="实例 id" /></label>
              <label class={FORM_FIELD}>显示名称（可选）<input class={FILTER_INPUT} placeholder="如 工作群助手" value={createForm().label} onInput={e => setCreateForm(prev => ({ ...prev, label: e.currentTarget.value }))} aria-label="实例标签" /></label>
              <button type="button" class={`${TEMPLATE_BTN} self-end justify-self-start`} disabled={instancePending() || !createForm().platform || !createForm().id.trim()} onClick={() => void createInstance()}>{instancePending() ? '处理中…' : '创建'}</button>
            </fieldset>
          }>
            <p class="file-section-hint">无可用平台（未实现平台不可用）</p>
          </Show>
        </section>

        {/* I12 W9：未绑定消息策略只读展示（明示风险——reject 模式未绑定消息不进入 agent） */}
        <Show when={status()?.unboundPolicy}>
          <section class={SECTION}>
            <div class={SECTION_HEAD}>
              <h3 class={SECTION_TITLE}>未绑定消息策略</h3>
            </div>
            <div class={FIELD_ROW}>
              <span class={FIELD_LABEL}>策略</span>
              <span class={FIELD_VALUE}>{status()!.unboundPolicy === 'reject' ? '严格模式（reject）：未绑定路由的消息将被拒绝，不会回退到 active agent' : '宽松模式（active-agent）：未绑定路由的消息回退到 active agent'}</span>
            </div>
          </section>
        </Show>
        <Show when={status()?.inject}>
          <section class={SECTION}>
            <div class={SECTION_HEAD}>
              <h3 class={SECTION_TITLE}>知识注入</h3>
              <span class={SECTION_META}>归 Prism 管理 · 只读</span>
            </div>
            <div class={FIELD_ROW}>
              <span class={FIELD_LABEL}>注入开关</span>
              <span class={FIELD_VALUE}>{status()!.inject!.enabled == null ? '—' : status()!.inject!.enabled ? '开启' : '关闭'}</span>
            </div>
            <div class={FIELD_ROW}>
              <span class={FIELD_LABEL}>注入场景</span>
              <span class={FIELD_VALUE}>{status()!.inject!.scenario || '跟随 Prism active.scenario'}</span>
            </div>
            <div class={FIELD_ROW}>
              <span class={FIELD_LABEL}>完成持久化</span>
              <span class={FIELD_VALUE}>{status()!.inject!.persist === 'prism' ? '写入 Prism（persist）' : status()!.inject!.persist || '—'}</span>
            </div>
          </section>
        </Show>
      </main>
    </div>
  )
}
