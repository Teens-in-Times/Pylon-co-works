/** @jsxImportSource solid-js */
import { createMemo, For, Show } from 'solid-js'

import { resolveInterfaceModeSuite } from '../../application/transactions/activateInterfaceMode.ts'
import { findInterfaceModeContribution } from '../../app/interfaceModeLookup.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'
import Select from '../ui/Select.solid.tsx'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'


/** Suite-level choice UI; message renderer ids are intentionally not exposed here. */
export default function RendererSuitePicker() {
  const modeId = createZustandSignal(useInterfaceModeStore, s => s.interfaceMode)
  const selectedByMode = createZustandSignal(usePresentationPreferenceStore, s => s.rendererSuiteIdByMode)
  const rendererRegistry = getRendererRegistry()
  const snapshot = createZustandSignal(
    { getState: () => rendererRegistry.snapshot(), subscribe: listener => rendererRegistry.subscribe(() => listener(rendererRegistry.snapshot())) },
    // registry 的 subscribe 回调不传快照，selector 自取。
    () => rendererRegistry.snapshot(),
  )
  const mode = createMemo(() => findInterfaceModeContribution(modeId()))
  const suiteMode = createMemo(() => {
    const current = mode()
    return current && current.workbench.renderKind === 'renderer-suite' ? current : null
  })
  // 判别分支收窄后的 workbench 视图（访问器边界会丢失 TS 判别收窄，单独存一份）
  const suiteWorkbench = createMemo(() => {
    const workbench = suiteMode()?.workbench
    return workbench && workbench.renderKind === 'renderer-suite' ? workbench : null
  })
  const choices = createMemo(() => resolveInterfaceModeSuite(
    suiteMode()!,
    selectedByMode()[modeId()],
    snapshot().rendererSuites.map(entry => entry.value.id),
  ))
  const selectedId = createMemo(() => choices().activeSuiteId ?? choices().requestedSuiteId ?? suiteWorkbench()!.defaultSuiteId)
  const displayId = createMemo(() => {
    const current = choices()
    // 局部变量保留 TS 真值收窄（requestedSuiteId 为可选字段）
    return current.unavailable && current.requestedSuiteId ? current.requestedSuiteId : selectedId()
  })
  const selected = createMemo(() => snapshot().rendererSuites.find(entry => entry.value.id === selectedId()))
  const options = createMemo(() => {
    const list = snapshot().rendererSuites.map(entry => ({
      value: entry.value.id,
      label: `${entry.value.label} · ${entry.value.runtime.framework}/${entry.value.runtime.version}`,
      description: `${entry.value.requiredKinds.length} kinds · ${entry.value.compatibility.documentSchema}`,
    }))
    const requested = choices().requestedSuiteId
    if (requested && !list.some(option => option.value === requested)) {
      list.push({
        value: requested,
        label: `${requested} · 插件暂不可用`,
        description: '保留偏好，等待插件恢复',
      })
    }
    return list
  })

  return (
    <Show when={suiteMode()}>
      <div class="renderer-suite-picker" data-pylon-component="renderer-suite-picker">
        <div class="renderer-suite-picker-heading">
          <span><strong>Renderer Suite</strong><small>整套 Workbench；Interface Mode 仅提供默认值。</small></span>
          <Show when={choices().unavailable}><span role="status" class="renderer-suite-status">当前使用内置回退，偏好已保留</span></Show>
        </div>
        <Select
          ariaLabel="Renderer Suite"
          value={displayId()}
          options={options()}
          onChange={value => usePresentationPreferenceStore.getState().setRendererSuiteId(modeId(), value)}
        />
        <div class="renderer-suite-details" role="status">
          <Show when={selected()} fallback={<span>Suite 不可用：{choices().requestedSuiteId ?? suiteWorkbench()!.defaultSuiteId}</span>}>
            <For each={[selected()!]}>{entry => (
              <>
                <span>{entry.ownerPluginId} · {entry.value.runtime.framework}/{entry.value.runtime.version}</span>
                <span>兼容 {entry.value.compatibility.documentSchema} / catalog {entry.value.compatibility.renderCatalogSchema}</span>
                <span>覆盖 {entry.value.requiredKinds.length + (entry.value.optionalKinds?.length ?? 0)} kinds</span>
                <Show when={choices().activeSuiteId === entry.value.id}><span>active</span></Show>
              </>
            )}</For>
          </Show>
        </div>
      </div>
    </Show>
  )
}
