/** @jsxImportSource solid-js */
import { FileCode2, RefreshCw } from 'lucide'
import { LucideIcon, lookupIconNode } from '../../components/LucideIcon.solid.tsx'

/**
 * fileIcons — FileSheet 域图标外观（#515 全量 Solid 化；#520 S3-P2-1 表归一）。
 *
 * 渲染统一经共享 `LucideIcon`（components/LucideIcon.solid.tsx）：本文件原有的人
 * IconNode 映射表与 buildSvg 自绘已退役，其登记项并入共享表。这里只保留两件
 * FileSheet 的字符串名契约包装与扩展名→图标/类型业务映射：
 * - WorkbenchIcon：域内字符串名调用面（FileSheetView/FileTree/GitPanel/...），
 *   未登记名回退 RefreshCw（原表同款）；
 * - FileTypeIconSolid：extension → 图标/type 投影（EXTENSION_ICON 即唯一真源，
 *   #515 期原 `FileTypeIcon.tsx` 已删除）。
 *
 * 类名与尺寸透传逐项不变（`.lucide lucide-{kebab}` + `file-type-icon type-*`）。
 */

/** lucide 图标的 Solid 包装（FileSheet 字符串名契约）。 */
export function WorkbenchIcon(props: { name: string; size?: number; strokeWidth?: number; class?: string }) {
  return (
    <LucideIcon
      node={lookupIconNode(props.name) ?? RefreshCw}
      name={props.name}
      size={props.size}
      strokeWidth={props.strokeWidth}
      class={props.class}
    />
  )
}

const EXTENSION_ICON: Readonly<Record<string, { icon: string; type: string }>> = {
  ts: { icon: 'Braces', type: 'ts' },
  tsx: { icon: 'Braces', type: 'ts' },
  js: { icon: 'Braces', type: 'js' },
  jsx: { icon: 'Braces', type: 'js' },
  mjs: { icon: 'Braces', type: 'js' },
  cjs: { icon: 'Braces', type: 'js' },
  rs: { icon: 'Hash', type: 'rust' },
  c: { icon: 'Hash', type: 'c' },
  h: { icon: 'Hash', type: 'c' },
  cpp: { icon: 'Hash', type: 'c' },
  hpp: { icon: 'Hash', type: 'c' },
  cc: { icon: 'Hash', type: 'c' },
  json: { icon: 'FileJson', type: 'json' },
  jsonc: { icon: 'FileJson', type: 'json' },
  css: { icon: 'Palette', type: 'style' },
  scss: { icon: 'Palette', type: 'style' },
  less: { icon: 'Palette', type: 'style' },
  md: { icon: 'FileText', type: 'text' },
  mdx: { icon: 'FileText', type: 'text' },
  txt: { icon: 'FileText', type: 'text' },
}

/** FileTypeIcon 的 Solid 实体（extension → 图标/type 与 FileTypeIcon.tsx 同表；带 aria-hidden）。 */
export function FileTypeIconSolid(props: { path: string; size?: number }) {
  const extension = props.path.split('.').pop()?.toLowerCase() ?? ''
  const mapped = EXTENSION_ICON[extension] ?? { icon: 'FileCode2', type: 'code' }

  return (
    <LucideIcon
      node={lookupIconNode(mapped.icon) ?? FileCode2}
      name={mapped.icon}
      size={props.size ?? 14}
      class={`file-type-icon type-${mapped.type}`}
    />
  )
}
