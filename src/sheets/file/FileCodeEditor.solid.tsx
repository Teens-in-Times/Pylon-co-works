/** @jsxImportSource solid-js */
import { onCleanup, onMount, createEffect } from 'solid-js'
import type { DispatchSelection } from '../../domains/file/dispatchMessage.ts'
import { createFileCodeMirrorKernel, type FileCodeEditorApi, type FileCodeMirrorKernel, type KernelSummary } from './fileCodeMirrorKernel.ts'

/**
 * FileCodeEditorProps — 名字承自历史 React 契约（FileCodeEditor.tsx，已退役）；本实体
 * 即唯一真源。命名差异是刻意的历史契约：原 React 壳面叫 `editable`（桥内映射为
 * `writable`），Solid 面（FileTabView.solid 消费）自 #279 起叫 `writable`。
 */
interface FileCodeEditorProps {
  path: string
  initialContent: string
  baseline: string
  writable?: boolean
  revealLine?: number
  onSummaryChange?: (summary: KernelSummary) => void
  onWriteLockChange?: (locked: boolean) => void
  onSave?: () => void
  apiRef?: { current: FileCodeEditorApi | null }
}

/**
 * FileCodeEditor — Solid 适配器（薄壳，#279 第 2 梯队 + 0-A1 内核合一合并后；#515 起兼作
 * React 桥的实体）。
 *
 * 内核实体在 fileCodeMirrorKernel.ts（框架无关工厂，与 React 桥共享同一行为事实——
 * 双渲染器同构纪律 + 0-A1 单内核：editable compartment 两档、changedLines decoration、
 * doc.eq 脏检查、KernelSummary）。本壳只做 Solid 生命周期桥接：onMount 创建内核，
 * props 后续变化经内核可变方法下传。宿主以「每文档一实例」挂载（FileTabView 的
 * keyed Show 按 targetKey:path 重建）。
 */
export default function FileCodeEditor(props: FileCodeEditorProps) {
  let hostElement: HTMLDivElement | undefined
  let kernel: FileCodeMirrorKernel | null = null

  onMount(() => {
    const parent = hostElement
    if (!parent) return
    const mounted = createFileCodeMirrorKernel(parent, {
      path: props.path,
      initialContent: props.initialContent,
      baseline: props.baseline,
      editable: props.writable !== false,
      callbacks: {
        onSummaryChange: summary => props.onSummaryChange?.(summary),
        onSave: () => props.onSave?.(),
      },
    })
    kernel = mounted
    if (props.apiRef) props.apiRef.current = mounted.api

    onCleanup(() => {
      kernel = null
      if (props.apiRef) props.apiRef.current = null
      // Solid 的 Show 分支卸载顺序是「先摘 DOM 后跑清理」——destroy 时宿主已脱离
      // 文档，CM 内部的样式读取在 jsdom 下会抛错（真实浏览器无此行为）导致半途而废，
      // 挂起的 measure RAF 随后在分离树上再抛（uncaught，vitest 判运行失败）。
      // 同步尝试 + 微任务补刀：微任务先于渲染帧，补刀会取消挂起的 RAF。
      const destroyOnce = () => {
        try {
          mounted.destroy()
        } catch {
          /* 分离态 jsdom 样式读取异常 */
        }
      }
      destroyOnce()
      queueMicrotask(destroyOnce)
    })
  })

  // 磁盘锚点推进（保存回执）：内核内 O(结构) 重算 dirty 并发摘要。
  createEffect(() => {
    const value = props.baseline
    if (value === undefined) return
    kernel?.setBaseline(value)
  })

  // writable 翻转：readonly compartment reconfigure（创建时已按初值装配）。
  createEffect(() => {
    const writable = props.writable !== false
    kernel?.setEditable(writable)
  })

  createEffect(() => {
    kernel?.reveal(props.revealLine)
  })

  return (
    <div
      ref={element => { hostElement = element }}
      class="file-code-editor"
      data-file-code-layout="shared"
      data-path={props.path}
    />
  )
}

export type { FileCodeEditorApi, KernelSummary, DispatchSelection }
