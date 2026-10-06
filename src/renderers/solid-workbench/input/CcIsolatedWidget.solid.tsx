/** @jsxImportSource solid-js */
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { IsolatedPluginSurface } from '../../../plugin-runtime/ui/IsolatedPluginSurface.solid.tsx'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'

/**
 * CcIsolatedWidget — 中控里一个 `isolated-surface` 插件件的**宿主接线**（#266 CC-13 刀2）。
 *
 * 通道本体是现成的（`plugin-runtime/ui/IsolatedPluginSurface.solid.tsx`，多宿主在用）——
 * 本件只做中控这一处的 I/O 契约（刀2 施工单 §4）：
 * - **往下递**（`host:input`，随变化自动重发）：外观令牌 / 可用尺寸 / 会话弱状态 / 编辑态标志 /
 *   **本件属性值**（`props`，刀4 增段；前四段语义不变）；
 * - **往上收**（bridge 事件，事件名定死）：`cc:insert` 投递文本 / `cc:send` 直接发送 /
 *   `cc:open` 打开外链。任何拒绝都经 workbench 诊断口上报，**不静默**。
 *
 * ★ 「开面板」分支本刀不做（渲染层无现成通路）：载荷里出现 `panel` ⇒ 拒绝 + 诊断，
 *   将来有真需求按能力清单加法演进。
 * ★ 依赖方向：本件住渲染层；会话草稿 / 命令口 / 诊断口都从 workbench 上下文取，
 *   不把 store 传进来。
 */
export interface CcIsolatedWidgetStyle {
  bg: string
  text: string
  border: string
  fontSize: number
  radius: number
  height: number
}

export interface CcIsolatedWidgetProps {
  /** 该元件的登记 id —— 属性值（`ccPluginProps`）按它取 */
  widgetId: string
  surfaceId: string
  /** 只读语境（重放 / 预览有会话）—— `cc:send` 的拒绝条件之一 */
  readonly(): boolean
  /** 提交中（空态建会话在途）—— `cc:send` 的拒绝条件之一 */
  submitting(): boolean
}

/** `cc:insert` 的单次文本上限（超长拒绝并诊断；语义见施工单 §4.2） */
const CC_INSERT_TEXT_MAX_LENGTH = 2000

export function CcIsolatedWidget(props: CcIsolatedWidgetProps) {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  const input = () => workbench.input()
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  let element: HTMLDivElement | undefined

  /**
   * §4.1 往下递的包。`createMemo` ⇒ 任一段变化即产新对象 ⇒ 通道侧以 `host:input` 重发。
   * ★ 外观令牌取值 = 内置件同源字段（含义是「想长得像内置件时的素材」，插件不用不强制）：
   *   `bg←modelBgColor` / `text←modelTextColor` / `border←inputBorder` / `fontSize←modelFontSize`
   *   / `radius←modelRadius` / `height←modelHeight`，缺省兜底与内置件同口径。
   * ★ #266 CC-13 刀4：第五段 `props` = 该元件**当前的属性值**（用户在编辑列里调的参数；
   *   没调过 ⇒ `{}`）—— 隔离面靠它才能真正"按参数画"。前四段语义不变（**只增不改**）。
   */
  const hostInput = createMemo(() => ({
    style: {
      bg: appearance().modelBgColor,
      text: appearance().modelTextColor,
      border: appearance().inputBorder || 'transparent',
      fontSize: appearance().modelFontSize ?? 12,
      radius: appearance().modelRadius ?? 0,
      height: appearance().modelHeight ?? 28,
    },
    size: size(),
    session: {
      hasSession: Boolean(input().sessionId),
      generating: workbench.runtimeSnapshot().generating,
    },
    editing: appearance().ccEditMode === true,
    props: { ...(appearance().ccPluginProps[props.widgetId] ?? {}) },
  }))

  // §4.1 `size` = 本件容器**实测**宽高（与 `.control-center` 既有测量同款；无布局环境 ⇒ 0/0）。
  onMount(() => {
    const node = element
    if (!node) return
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight })
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(node)
    onCleanup(() => observer?.disconnect())
  })

  /** 任何拒绝都不得静默：经 workbench 诊断口上报（带事件名与原因）。 */
  const reject = (event: string, reason: string) => {
    workbench.hostPort?.diagnostics.report({
      code: 'cc-widget.surface.event-rejected',
      message: `插件元件请求被拒：${event}（${reason}）`,
      phase: 'action',
    })
  }

  const textOf = (detail: unknown): string | undefined => {
    if (!detail || typeof detail !== 'object') return undefined
    const text = (detail as { text?: unknown }).text
    return typeof text === 'string' ? text : undefined
  }

  /** §4.2 往上收：事件名定死，分诊 + 校验；拒绝一律带原因上报。 */
  const handleEvent = (event: string, detail: unknown) => {
    // 只认本件的三件契约事件。`host:input` 是**宿主自己**的下行推送（通道用同一个 bridge
    // 来回灌），不是插件请求；其余事件名（可能是同一个插件面在别的宿主用的词）一律不认
    // —— 与其它宿主的分诊同款（`Sidebar.solid.tsx` / `ContextPanelHost.solid.tsx`）。
    if (event !== 'cc:insert' && event !== 'cc:send' && event !== 'cc:open') return
    const sessionId = input().sessionId
    if (event === 'cc:insert') {
      const text = textOf(detail)
      if (!sessionId) return reject(event, '无会话')
      if (!text) return reject(event, '空文本')
      if (text.length > CC_INSERT_TEXT_MAX_LENGTH) return reject(event, `超长（上限 ${CC_INSERT_TEXT_MAX_LENGTH} 字符）`)
      // 追加进草稿（照 `InputBar` 既有写入语义）；用户仍可改。
      workbench.sessionUi.capture(sessionId).update('draft', '', current => current + text)
      return
    }
    if (event === 'cc:send') {
      const text = textOf(detail)
      if (!sessionId) return reject(event, '无会话')
      if (props.submitting()) return reject(event, '提交中')
      if (props.readonly()) return reject(event, '只读语境')
      if (!text || !text.trim()) return reject(event, '空文本')
      // 走既有命令口（自带能力校验与错误上报）；排队与否由命令口语义决定。
      void workbench.commands.send(sessionId, { text })
      return
    }
    if (event === 'cc:open') {
      const payload = detail && typeof detail === 'object' ? detail as { url?: unknown; panel?: unknown } : {}
      if (payload.panel !== undefined) return reject(event, '面板分支未开放（本刀不做）')
      const url = typeof payload.url === 'string' ? payload.url.trim() : ''
      if (!url) return reject(event, '无 URL')
      if (!/^https?:\/\//i.test(url)) return reject(event, '仅支持 http/https')
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
  }

  return (
    <div ref={node => { element = node }} class="cc-isolated-widget">
      <IsolatedPluginSurface surfaceId={props.surfaceId} input={hostInput()} onEvent={handleEvent} />
    </div>
  )
}
