/**
 * createCcSources — ControlCenter 触达的**非 context 真相源**的聚合读取口（#520 S3-P0-2）。
 *
 * ControlCenter 此前在组件体内四处直读 store：identity（profile 默认模型）、
 * cc 控件注册表（背景板 / 发送按钮在场判定）、workspace 实体 store（创建 IO）、
 * 以及宿主 input 快照（可选工作区清单）。本工厂把它们收敛成**单一入口**：
 * 组件只跟 `CcSources` 说话，测试也只需替换这一个缝。
 *
 * 注意：这里只做**读取聚合**，不做派生状态；全部成员都是按调用现读的函数
 * （注册表快照在渲染时读，保持既有 HMR-safe 口径，见 widgetDefinitions 注释）。
 */
import { useIdentityStore } from '../../../domains/identity/identityStore.ts'
import { useWorkspaceEntityStore } from '../../../domains/workspace/workspaceEntityStore.ts'
import { getCcWidgetRegistry } from '../../../plugin-runtime/runtimeServices.ts'
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
  /** `cc-surface` 注册轨是否在场（背景板改由注册通道表示）。 */
  ccSurfaceRegistered(): boolean
  /** `cc-send-button` 注册轨是否在场（发送块归属 F1=A）。 */
  ccSendButtonRegistered(): boolean
  /** 新建工作区 IO（workspace 实体 store 的创建入口）。 */
  createWorkspace(name: string, rootPath: string): Promise<{ id: string }>
}

export function createCcSources(readInput: () => CcSourcesInputSnapshot): CcSources {
  return {
    workspaces: () => readInput().availableWorkspaces ?? [],
    activeProfileModel: () => {
      const identity = useIdentityStore.getState()
      return identity.profiles.find(item => item.id === identity.activeProfileId)?.model || ''
    },
    ccSurfaceRegistered: () => getCcWidgetRegistry().getSnapshot().entries.some(
      entry => entry.value.id === 'cc-surface',
    ),
    ccSendButtonRegistered: () => getCcWidgetRegistry().getSnapshot().entries.some(
      entry => entry.value.id === 'cc-send-button',
    ),
    createWorkspace: (name, rootPath) => useWorkspaceEntityStore.getState().createWorkspace(name, rootPath),
  }
}
