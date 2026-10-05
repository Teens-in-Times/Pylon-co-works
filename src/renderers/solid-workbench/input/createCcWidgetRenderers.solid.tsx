/** @jsxImportSource solid-js */
import type { JSX } from 'solid-js'
import { formatUsagePercent, formatUsageTokens } from '../../../domains/theme/tokenFormat.ts'
import type { CcWidgetGroupId } from '../../../domains/cc/widgetDefinitions.ts'
import { resolveContextUsage } from '../../../domains/workbench/session/sessionSurface.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../domains/appearance/appearance.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'
import type { InputPredictionProvider } from '../../../infrastructure/prediction/inputPredictionProvider.ts'
import { SolidInputBar, type SolidInputBarProps } from './InputBar.solid.tsx'
import { SolidCcSendButton, SolidModeWidget, SolidModelWidget, SolidReasoningWidget } from './WorkbenchWidgets.solid.tsx'

/**
 * 中控元件的**渲染标识 → 渲染函数**表（#266 CC-13 刀1 · 内部收敛）。
 *
 * 本表取代原先写死在 `ControlCenter.solid.tsx` 里的 `renderBody` switch 与两处特例内联 JSX
 * （`.cc-bg` 背景板 / `<SolidCcSendButton>` 发送按钮）——**渲染体逐字搬迁**，行为零变化。
 * 键 = 定义表全部 8 行的 id（`CcWidgetGroupId`）：`Record<…>` 做**编译期全覆盖**，
 * 以后加件忘了配渲染器 = 编译报错，不再靠 switch 穷尽性。
 *
 * ★ 依赖方向：本表住渲染层（`src/renderers/solid-workbench/input/`）——「组件长什么样」是渲染层的事，
 *   `domains/cc` 保持框架无关、不 import 任何组件（见 `widgetDefinitions.ts` 表头）。
 * ★ 本刀**不动注册轨**：`cc-surface` / `cc-send-button` 的「在场门」（`ccWidgetRegistry` 快照读取，
 *   见 `createCcSources.ts` 与 `ControlCenter.solid.tsx`）原样保留 —— 它们是刀2「插件件走同一张表」的前置。
 *
 * ★ ctx 纪律（Solid 响应性靠它）：**一律传访问器（函数），不许先取值再传** ——
 *   先取值 = 把随会话 / 预设变化的量冻成常量，界面不会跟着变（本表的值全部由 ControlCenter
 *   的响应式作用域在调用时读取）。`emptyComposer` 是 memo **本体**直传（现写法 `empty={emptyComposer}`）。
 * ★ ctx **只含**「闭合在 ControlCenter 作用域上的取值」；其余依赖（格式化函数、各 Solid 子组件）
 *   直接 import，不进 ctx。
 */
export interface CcWidgetRenderContext {
  /** 外观快照（tokens 的胶囊样式 / cc-command-hint 的详细档） */
  appearance(): WorkbenchAppearanceSnapshot
  /** 运行时切片（tokens 读 `document.session.usage`） */
  runtime(): WorkbenchRuntimeSnapshot
  /** 会话判据：无会话（model / reasoning / mode 的草稿门） */
  hasNoSession(): boolean
  /** 模型草稿值（accessor 本体；草稿态才接线） */
  modelId(): string
  /** 模型草稿写入口（setter 本体） */
  setModelId(value: string): void
  /** 思考强度草稿值 */
  reasoningLevel(): string
  /** 思考强度草稿写入口 */
  setReasoningLevel(value: string): void
  /** 权限模式草稿值 */
  mode(): string
  /** 权限模式草稿写入口 */
  setMode(value: string): void
  /** 只读判据（input / cc-send-button 的禁用态） */
  readonly(): boolean
  /** 提交中（cc-send-button 的禁用态） */
  submitting(): boolean
  /** 空态 composer 配置（`SolidInputBar` 的 `empty`，memo 本体直传，不调用） */
  emptyComposer: SolidInputBarProps['empty']
  /** 宿主输入预测 provider（值直传，非信号） */
  predictionProvider?: InputPredictionProvider
  /** 发送按钮形态（未配置 / 被藏 = undefined） */
  sendButtonMode(): 'inline' | 'external' | undefined
  /** `cc-surface` 注册轨在场门（本刀保留注册轨，未退役） */
  ccSurfaceRegistered(): boolean
}

/** 渲染表：键 = 定义表全部 8 行的 id；`Record` 强制全覆盖（缺一行 = 编译报错）。 */
export type CcWidgetRendererTable = Readonly<Record<CcWidgetGroupId, () => JSX.Element | null>>

export function createCcWidgetRenderers(ctx: CcWidgetRenderContext): CcWidgetRendererTable {
  return {
    // 背景板本体（#238 刀4 起它在场以 `.cc-bg` 上的 data 属性表述；全仓零消费者）。
    'cc-surface': () => <div class="cc-bg" data-cc-widget={ctx.ccSurfaceRegistered() ? 'cc-surface' : undefined} />,
    input: () => <SolidInputBar disabled={ctx.readonly()} predictionProvider={ctx.predictionProvider} empty={ctx.emptyComposer} />,
    model: () =>
      // ★ CC-28 拆词：草稿态只认「无会话」——进场期（有会话）走实值。
      <SolidModelWidget
        draftValue={ctx.hasNoSession() ? ctx.modelId : undefined}
        onDraftChange={ctx.hasNoSession() ? ctx.setModelId : undefined}
        forceDropdown={ctx.hasNoSession()}
      />,
    reasoning: () => <SolidReasoningWidget draftValue={ctx.hasNoSession() ? ctx.reasoningLevel : undefined} onDraftChange={ctx.hasNoSession() ? ctx.setReasoningLevel : undefined} />,
    mode: () => <SolidModeWidget
      draftValue={ctx.hasNoSession() ? ctx.mode : undefined}
      onDraftChange={ctx.hasNoSession() ? ctx.setMode : undefined}
      forceDropdown={ctx.hasNoSession()}
    />,
    tokens: () => {
      // S11 用量控件：按钮型外观、不可点击（无 onClick / 无菜单 / 无 aria-haspopup）。
      // 外观沿用 model 控件的外观字段 —— 本控件不新增属性字段（S11 拍板「光秃秃」），
      // 但必须与 model/reasoning/mode 是同一族按钮，否则会退化成裸文字。
      const usage = () => resolveContextUsage(ctx.runtime().document?.session.usage)
      const limit = () => usage().limit
      const pillStyle = () => ({
        height: `${ctx.appearance().modelHeight ?? 28}px`,
        'border-radius': `${ctx.appearance().modelRadius ?? 0}px`,
        // ★ #238 刀7：原先这里还乘一个「缩放」(`ccScale.tokens`)。缩放已整体删除
        //   ⇒ 用量字号直接取基准字号（`modelFontSize`）。对没调过缩放的人（= 100）逐位相同。
        'font-size': `${ctx.appearance().modelFontSize ?? 12}px`,
        // ★ #266 遗留①：直读模型控件的颜色字段（借用关系见定义表 `borrowsFrom: 'model'`）——
        //   模型底色/文字色改成自由选色后，胶囊跟着模型走。
        background: ctx.appearance().modelBgColor,
        color: ctx.appearance().modelTextColor,
      })
      return <span class="cc-usage-pill" style={pillStyle()}>
        <span class="cc-usage-count">{usage().used !== undefined ? formatUsageTokens(usage().used!) : '—'}/{limit() && limit()! > 0 ? formatUsageTokens(limit()!) : '—'}</span>
        <span class="cc-usage-percent">{usage().percent !== undefined ? formatUsagePercent(usage().percent! / 100) : '—'}</span>
      </span>
    },
    // ★ #238 刀5B：命令行提示从「裸渲染」升格为表里的普通行内元件（本行就是它的渲染实现）。
    //   ★ #266 ⑰：运行期条件（有会话 / 命令行模式 / 详细档不为 hidden）**已全部撤销** ——
    //   判据只剩「隐藏名单」（预设的值 + 详细档折叠 + 空态名单），由 `isWidgetVisible` 统一裁决
    //   ⇒ 渲染与高度计数共用一个谓词，不可见时自然不计数。
    'cc-command-hint': () => <div class="cc-command-hint" aria-label="输入快捷键提示">
      <span class="cc-command-hint-key">/: 命令</span>
      <span class="cc-hint-secondary"><i>|</i> Shift+Enter: 换行</span>
      {ctx.appearance().cliHintMode === 'full' && <span class="cc-hint-tertiary"><i>|</i> Shift+Tab: 模式</span>}
    </div>,
    'cc-send-button': () => <SolidCcSendButton disabled={ctx.readonly() || ctx.submitting()} mode={ctx.sendButtonMode() as 'inline' | 'external'} />,
  }
}
