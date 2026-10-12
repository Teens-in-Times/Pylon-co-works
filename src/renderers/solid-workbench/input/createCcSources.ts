/**
 * createCcSources — ControlCenter 触达的**非 context 真相源**的聚合读取口（#520 S3-P0-2）。
 *
 * ControlCenter 此前在组件体内四处直读 store：identity（profile 默认模型）、
 * cc 控件注册表（背景板 / 发送按钮在场判定）、workspace 实体 store（创建 IO）、
 * 以及宿主 input 快照（可选工作区清单）。本工厂把它们收敛成**单一入口**：
 * 组件只跟 `CcSources` 说话，测试也只需替换这一个缝。
 *
 * ★ #266 CC-13 刀2：注册轨两件（`cc-surface` / `cc-send-button`）退役后，本口**不再读**
 *   cc 控件注册表 —— 插件件的注册表订阅改在 ControlCenter 里按**活名单**消费
 *   （`domains/cc/ccWidgetRoster.ts` 合成，见 `ControlCenter.solid.tsx`）。
 *
 * ★ #266 CC-27/28 清尾：壳 popover 退役后创建工作区回归侧栏，本口的建区聚合项已删 ——
 *   workspace 实体 store 的同名成员仍被侧栏使用，是活的。
 *
 * 注意：这里只做**读取聚合**，不做派生状态；全部成员都是按调用现读的函数。
 */
import { useIdentityStore } from '../../../domains/identity/identityStore.ts'
import type { WorkbenchWorkspaceOption } from '../../../plugin-runtime/renderers/workbenchRendererFactory.ts'

/** 宿主 input 快照中与中控相关的切片（只声明读到的字段）。 */
export interface CcSourcesInputSnapshot {
  availableWorkspaces?: readonly WorkbenchWorkspaceOption[]
}

export interface CcSources {
  /** 空态可选工作区清单（宿主 input 直通；缺省为空表）。 */
  workspaces(): readonly WorkbenchWorkspaceOption[]
  /** 活跃档案声明的默认模型（模型草稿的播种兜底；runtime 活跃值由调用方优先）。 */
  activeProfileModel(): string
}

export function createCcSources(readInput: () => CcSourcesInputSnapshot): CcSources {
  return {
    workspaces: () => readInput().availableWorkspaces ?? [],
    activeProfileModel: () => {
      const identity = useIdentityStore.getState()
      return identity.profiles.find(item => item.id === identity.activeProfileId)?.model || ''
    },
  }
}
