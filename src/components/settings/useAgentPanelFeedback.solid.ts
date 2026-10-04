import { createSignal, onCleanup } from 'solid-js'
import { errorCode as wireErrorCode } from '../../infrastructure/tauri/errorPayload.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'

/**
 * createAgentPanelFeedback（原 useAgentPanelFeedback）— AgentRuntimePanel 的统一反馈
 * 原语（A-V4 拆分：此前 feedback 内联与 toast（定时自清）双通道散在组件里）。
 * 三类可见反馈：
 * - `feedback`：内联详情性提示（校验失败原因、探测失败、压缩详情），常驻至下一次覆盖；
 * - `notify`：轻量操作成功 toast，2.5s 自动消失；
 * - `configConflict`：CAS 冲突横幅（带「重新载入配置」出口）。
 *
 * #515 W1：React hook → Solid 形态（消费者 AgentRuntimePanel.solid 直连；须在响应式
 * owner 内调用）。
 */
export function createAgentPanelFeedback(options: {
  reportPanelError: (operation: string, error: unknown, agentId?: string) => ReturnType<typeof reportRuntimeError>
}) {
  const { reportPanelError } = options
  const [feedback, setFeedback] = createSignal<string | null>(null)
  const [toast, setToast] = createSignal<string | null>(null)
  const [configConflict, setConfigConflict] = createSignal(false)

  // 轻量操作提示：保存/新建/导入成功等「需要弹出」的反馈走 toast，自动消失；
  // 压缩/校验等详情性提示仍走 setFeedback 内联。
  // toast 定时器互斥：连续 notify 时先掐掉上一条的 timer，旧 timer 不得把新 toast
  // 提前清掉；残余 timer 经 onCleanup 随响应式 owner 释放（本工厂须在 owner 内调用）。
  let toastTimer: number | undefined
  const notify = (message: string) => {
    if (toastTimer !== undefined) window.clearTimeout(toastTimer)
    setToast(message)
    toastTimer = window.setTimeout(() => {
      toastTimer = undefined
      setToast(null)
    }, 2500)
  }
  onCleanup(() => {
    if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  })

  /** 配置 mutation 失败的统一呈现：CAS 冲突进横幅 + 内联保留草稿说明。 */
  const reportConfigMutationError = (operation: string, error: unknown, agentId?: string) => {
    const detail = reportPanelError(operation, error, agentId)
    if (wireErrorCode(error) === 'config_revision_conflict') {
      setConfigConflict(true)
      setFeedback('配置已被其他进程修改；你的草稿仍保留。请重新载入配置后再提交。')
      return detail
    }
    setFeedback(`${operation}失败，详情见右下角错误中心`)
    return detail
  }

  return { feedback, setFeedback, toast, notify, configConflict, setConfigConflict, reportConfigMutationError }
}
