/** @jsxImportSource solid-js */
import { createEffect, createSignal, createUniqueId, onCleanup } from 'solid-js'
import { WorkbenchSelector } from './WorkbenchSelector.solid.tsx'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import { resolveCcWidgetGroup } from '../../../domains/cc/widgetDefinitions.ts'
import {
  isReasoningOption,
  resolveModeOptionEntries,
  resolveModelOptionEntries,
  resolveReasoningOptionEntries,
  resolveDocumentOptionValue,
  shortControlCenterError,
} from './workbenchOptionCatalog.ts'

/**
 * 同落脚处内的前置间距（#238 刀3）：值从**定义表**读，不再硬编码在控件里。
 * ★ 仍加在**同一个元素**上（inline `margin-left`）—— 不改成外层盒子统一 `gap`，
 * 否则换行规则跟着变、像素不可能一致（施工单 §2.4）。
 */
function previousWidgetGapPx(id: string): number {
  return resolveCcWidgetGroup(id)?.gap ?? 0
}

// #51：切换失败的正文只放稳定短文案（稳定 code 映射，未知文本截 80 字符），
// 完整后端原文留在浮层 title 里供悬停查看——error 信号存全文，截短在渲染侧做。
const MODEL_SWITCH_FAIL = '模型切换失败'
const MODE_SWITCH_FAIL = '权限模式切换失败'
const REASONING_SWITCH_FAIL = '思考等级切换失败'

function nextValue(values: readonly string[], current: string): string {
  if (values.length === 0) return current
  const index = values.indexOf(current)
  return values[(index + 1 + values.length) % values.length] ?? values[0] ?? current
}

export function SolidModelWidget(props: { draftValue?: () => string; onDraftChange?: (value: string) => void; forceDropdown?: boolean } = {}) {
  const workbench = useSolidWorkbench(); const runtime = () => workbench.runtimeSnapshot(); const appearance = () => workbench.appearanceSnapshot()
  const [open,setOpen]=createSignal(false); const [error,setError]=createSignal(''); const [pending,setPending]=createSignal(false)
  let requestGeneration = 0
  onCleanup(() => { requestGeneration += 1 })
  let trigger: HTMLButtonElement|undefined; const menuId=`cc-model-menu-${createUniqueId()}`
  // 会话切换时关闭菜单（2026-09-14）：控件常态显示后，若残留 open 状态会带着
  // 上一次会话的菜单进入新会话。与 SolidModeWidget 的会话切换处理保持一致。
  let previousSessionId = workbench.input().sessionId
  const entries=()=>resolveModelOptionEntries(runtime(),props.draftValue?.(),props.draftValue?workbench.input().agentAdvertisedModels:undefined); const models=()=>entries().map(x=>x.id)
  const model=()=>props.draftValue?.()||runtime().activeModel||entries()[0]?.id||''; const mode=()=>props.forceDropdown?'menu':(appearance().modelSwitchMode??'menu')
  // #51：「不可切换」≠「切换失败」——无草稿绑定的真实会话里，候选为空意味着
  // 该 agent 没有宣告任何模型面（restart 后未恢复/agent 不支持），控件置禁用并
  // 说明原因，而不是让用户反复点出一串长报错。草稿态（空态选型）不受限。
  const unsurfaced=()=>!props.onDraftChange&&entries().length===0
  const width=()=>appearance().modelWidth??120, height=()=>appearance().modelHeight??28, radius=()=>appearance().modelRadius??0, fontSize=()=>appearance().modelFontSize??12
  const bg=()=>appearance().modelBgColor, fg=()=>appearance().modelTextColor; const close=(focus=false)=>{setOpen(false);if(focus)queueMicrotask(()=>trigger?.focus())}
  const choose = async (target: string) => {
    if (pending()) return
    if (props.onDraftChange) { props.onDraftChange(target); close(true); return }
    const sessionId = workbench.input().sessionId
    if (!sessionId || target === model()) { close(true); return }
    const generation = ++requestGeneration
    setPending(true)
    setError('')
    try {
      const result = await workbench.commands.setModel(sessionId, target)
      if (generation === requestGeneration && !result.ok) setError(result.error || MODEL_SWITCH_FAIL)
    } catch (cause) {
      if (generation === requestGeneration) setError(cause instanceof Error ? cause.message : MODEL_SWITCH_FAIL)
    } finally {
      if (generation === requestGeneration) { setPending(false); close(true) }
    }
  }
  createEffect(() => {
    const sessionId = workbench.input().sessionId
    if (sessionId !== previousSessionId) {
      requestGeneration += 1
      setPending(false)
      setError('')
      close()
    }
    previousSessionId = sessionId
  })
  const triggerStyle=()=>({width:`${width()}px`,height:`${height()}px`,'border-radius':`${radius()}px`,'font-size':`${fontSize()}px`,'--cc-widget-background':bg(),'--cc-widget-color':fg()})
  return <WorkbenchSelector kind="model" id={menuId} label="模型" value={model()} entries={entries()}
    open={open()} pending={pending()} errorDetail={error()} cycle={mode()==='cycle'} style={triggerStyle()}
    disabled={unsurfaced()} error={error() ? shortControlCenterError(error(), MODEL_SWITCH_FAIL) : undefined}
    onTrigger={element => { trigger = element }} onOpen={setOpen} onClose={close}
    onChoose={value => void choose(value)} onCycle={() => { void choose(nextValue(models(),model())) }} />
}

/** Permission labels are readable; commands retain the provider's raw id.
 * Empty color leaves semantic mode styling in charge. Custom color values stay
 * available to classic/tactical and the editor; modern uses a continuous toolbar. */
export function SolidModeWidget(props: {
  draftValue?: () => string
  onDraftChange?: (value: string) => void
  forceDropdown?: boolean
} = {}) {
  const workbench = useSolidWorkbench(); const runtime = () => workbench.runtimeSnapshot(); const appearance = () => workbench.appearanceSnapshot()
  const [open,setOpen]=createSignal(false); const [error,setError]=createSignal(''); const [pending,setPending]=createSignal(false)
  let requestGeneration = 0
  onCleanup(() => { requestGeneration += 1 })
  let trigger: HTMLButtonElement|undefined; let previousSessionId = workbench.input().sessionId
  const menuId=`cc-mode-menu-${createUniqueId()}`
  const entries=()=>resolveModeOptionEntries(runtime(), props.draftValue?.())
  const mode=()=>props.draftValue?.()||runtime().activeMode||entries()[0]?.id||'default'
  const switchMode=()=>props.forceDropdown?'menu':(appearance().permissionSwitchMode??'menu')
  const close=(focus=false)=>{setOpen(false);if(focus)queueMicrotask(()=>trigger?.focus())}
  const choose = async (target: string) => {
    if (pending()) return
    if (props.onDraftChange) { props.onDraftChange(target); close(true); return }
    const sessionId = workbench.input().sessionId
    if (!sessionId || target === mode()) { close(true); return }
    const generation = ++requestGeneration
    setPending(true)
    setError('')
    try {
      const result = await workbench.commands.setMode(sessionId, target)
      if (generation === requestGeneration && !result.ok) setError(result.error || MODE_SWITCH_FAIL)
    } catch (cause) {
      if (generation === requestGeneration) setError(cause instanceof Error ? cause.message : MODE_SWITCH_FAIL)
    } finally {
      if (generation === requestGeneration) { setPending(false); close(true) }
    }
  }
  createEffect(() => {
    const sessionId = workbench.input().sessionId
    if (sessionId !== previousSessionId) {
      requestGeneration += 1
      setPending(false)
      setError('')
      close()
    }
    previousSessionId = sessionId
  })
  const cycle=()=>{void choose(nextValue(entries().map(e=>e.id), mode()))}
  const width=()=>appearance().permissionWidth??120, height=()=>appearance().permissionHeight??28, radius=()=>appearance().permissionRadius??0, fontSize=()=>appearance().permissionFontSize??12
  const bg=()=>appearance().permissionBgColor
  // No explicit value means CSS can supply the mode's semantic color.
  const color=()=>appearance().permissionTextColor||undefined
  const triggerStyle=()=>({width:`${width()}px`,height:`${height()}px`,'border-radius':`${radius()}px`,'font-size':`${fontSize()}px`,'--cc-widget-background':bg(),'--cc-widget-color':color()})
  return <WorkbenchSelector kind="mode" id={menuId} label="权限模式" value={mode()} entries={entries()}
    open={open()} pending={pending()} errorDetail={error()} cycle={switchMode()==='cycle'} style={triggerStyle()} rootStyle={{'margin-left':`${previousWidgetGapPx('mode')}px`}}
     error={error() ? shortControlCenterError(error(), MODE_SWITCH_FAIL) : undefined}
    onTrigger={element => { trigger = element }} onOpen={setOpen} onClose={close}
    onChoose={value => void choose(value)} onCycle={() => { cycle() }} />
}

/** Session-create reasoning preference. It uses the same compact control language
 * as the mode widget and remains available in the normal control center. */
export function SolidReasoningWidget(props: { draftValue?: () => string; onDraftChange?: (value: string) => void } = {}) {
  const workbench = useSolidWorkbench(); const runtime = () => workbench.runtimeSnapshot(); const appearance = () => workbench.appearanceSnapshot()
  const [open,setOpen]=createSignal(false); const [error,setError]=createSignal(''); const [pending,setPending]=createSignal(false)
  let requestGeneration = 0
  onCleanup(() => { requestGeneration += 1 })
  let trigger: HTMLButtonElement|undefined; let previousSessionId = workbench.input().sessionId
  const menuId=`cc-reasoning-menu-${createUniqueId()}`
  const entries=()=>resolveReasoningOptionEntries(runtime(), resolveDocumentOptionValue(runtime().document?.session.options, 'reasoning'))
  const current=()=>resolveDocumentOptionValue(runtime().document?.session.options, 'reasoning') || props.draftValue?.() || entries()[0]?.id || ''
  const choose = async (value: string) => {
    if (pending()) return
    if (props.onDraftChange) { props.onDraftChange(value); close(true); return }
    const sessionId = workbench.input().sessionId
    if (!sessionId || value === current()) { close(true); return }
    const option = runtime().document?.session.options?.find(isReasoningOption)
    const previous = current()
    const generation = ++requestGeneration
    setPending(true)
    setError('')
    try {
      const result = await workbench.commands.setConfigOption(sessionId, option?.id || 'reasoning_effort', value, {
        expectedValue: previous,
        ...(option?.version == null ? {} : { expectedVersion: option.version }),
      })
      if (generation === requestGeneration && !result.ok) setError(result.error || REASONING_SWITCH_FAIL)
    } catch (cause) {
      if (generation === requestGeneration) setError(cause instanceof Error ? cause.message : REASONING_SWITCH_FAIL)
    } finally {
      if (generation === requestGeneration) { setPending(false); close(true) }
    }
  }
  createEffect(() => {
    const sessionId = workbench.input().sessionId
    if (sessionId !== previousSessionId) {
      requestGeneration += 1
      setPending(false)
      setError('')
      close()
    }
    previousSessionId = sessionId
  })
  const mode=()=>appearance().reasoningSwitchMode??'menu'
  const cycle=()=>{const ids=entries().map(e=>e.id);const i=ids.indexOf(current());void choose(ids[(i+1+ids.length)%ids.length]||current())}
  const width=()=>appearance().reasoningWidth??120, height=()=>appearance().reasoningHeight??28, radius=()=>appearance().reasoningRadius??0, fontSize=()=>appearance().reasoningFontSize??12
  const bg=()=>appearance().reasoningBgColor, fg=()=>appearance().reasoningTextColor; const close=(focus=false)=>{setOpen(false);if(focus)queueMicrotask(()=>trigger?.focus())}
  const triggerStyle=()=>({width:`${width()}px`,height:`${height()}px`,'border-radius':`${radius()}px`,'font-size':`${fontSize()}px`,'--cc-widget-background':bg(),'--cc-widget-color':fg()})
  return <WorkbenchSelector kind="reasoning" id={menuId} label="思考强度" value={current()} entries={entries()}
    open={open()} pending={pending()} errorDetail={error()} cycle={mode()==='cycle'} style={triggerStyle()} rootStyle={{'margin-left':`${previousWidgetGapPx('reasoning')}px`}}
     error={error() ? shortControlCenterError(error(), REASONING_SWITCH_FAIL) : undefined}
    onTrigger={element => { trigger = element }} onOpen={setOpen} onClose={close}
    onChoose={value => void choose(value)} onCycle={() => { cycle() }} />
}

/** Send/cancel keeps the same workbench command boundary in every visual mode. */
export function SolidCcSendButton(props: { disabled?: boolean; mode: 'inline' | 'external' }) {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const send = () => window.dispatchEvent(new CustomEvent('pylon:solid-input-send'))
  const cancel = async () => {
    const sessionId = workbench.input().sessionId
    if (!sessionId) return
    const ui = workbench.sessionUi.capture(sessionId)
    try {
      const result = await workbench.commands.cancel(sessionId)
      if (result.status === 'rejected') ui.set('input-error', result.error || '停止失败，请重试')
    } catch (cause) {
      ui.set('input-error', cause instanceof Error ? cause.message : '停止失败，请重试')
    }
  }
  const icon = () => runtime().generating ? appearance().sendButtonIconGenerating : appearance().sendButtonIcon
  const round = () => appearance().sendButtonIconRound === 'on'
  const iconClass = () => {
    const value = icon()
    const solid = value === 'triangle' || value === 'square'
    return `cc-send-icon ${solid ? 'cc-send-icon--solid' : 'cc-send-icon--stroke'}${round() && !solid ? ' cc-send-icon--round' : ''}${value === 'triangle' ? ' cc-send-icon--lg' : ''}${value === 'double-arrow' ? ' cc-send-icon--double' : ''}`
  }
  const path = () => {
    const value = icon()
    if (value === 'arrow') return 'M12 20 V4.5 M5.3 11.2 L12 4.5 L18.7 11.2'
    if (value === 'double-arrow') return 'M6.5 11 L12 6.5 L17.5 11 M6.5 17.5 L12 13 L17.5 17.5'
    if (value === 'cross') return 'M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5'
    if (value === 'triangle') return round() ? 'M10.94 9.31 A1.5 1.5 0 0 1 13.06 9.31 L16.94 13.19 A1.5 1.5 0 0 1 15.88 15.75 L8.12 15.75 A1.5 1.5 0 0 1 7.06 13.19 Z' : 'M12 8.25 L19.5 15.75 H4.5 Z'
    return round() ? 'M7.5 6 H16.5 A1.5 1.5 0 0 1 18 7.5 V16.5 A1.5 1.5 0 0 1 16.5 18 H7.5 A1.5 1.5 0 0 1 6 16.5 V7.5 A1.5 1.5 0 0 1 7.5 6 Z' : 'M6 6 H18 V18 H6 Z'
  }
  return <button
    type="button"
    class="cc-send-button"
    // ★ #238 刀4：把元件 id 写到节点上 —— 它声明为**悬浮件**（`floating`），
    //   「占区不叠加」的豁免判据与几何测量都按这个 id 找它（之前节点上没有 id，
    //   豁免逻辑测不到、也就是测不实）。纯属性，不影响样式与布局。
    data-widget-id="cc-send-button"
    data-mode={props.mode}
    disabled={props.disabled}
    title={runtime().generating ? '停止生成' : '发送'}
    aria-label={runtime().generating ? '停止生成' : '发送消息'}
    onClick={() => runtime().generating ? cancel() : send()}
  ><svg viewBox="0 0 24 24" class={iconClass()} aria-hidden="true"><path d={path()} /></svg></button>
}



