/** @jsxImportSource solid-js */
import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  Bot,
  Boxes,
  Braces,
  ChevronDown,
  ChevronFirst,
  ChevronLeft,
  ChevronLast,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Code2,
  Clock,
  Clock3,
  Database,
  Download,
  FileCode2,
  FileJson,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Globe2,
  Hash,
  History,
  House,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Send,
  Settings,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareStack,
  Upload,
  Waypoints,
  X,
  type IconNode,
} from 'lucide'

/**
 * LucideIcon — Solid 版 lucide 图标（#279 第 3 梯队）。
 *
 * 为什么不用 lucide-solid：其 solid 条件导出（dist/source 的 JSX 源码）在 vitest/jsdom
 * 下不渲染（实测 svg 为空），且默认类名是 `lucide-icon` 而非 lucide-react 的
 * `lucide lucide-{name}`。这里取 **lucide 核心包的 IconNode 数据**自绘——类名与
 * lucide-react 逐类一致（`.lucide-{kebab}` 是测试与样式的消费契约），路径数据同源。
 *
 * 图标按**具名静态导入 + 显式映射表**收敛：动态键索引会击穿 tree-shaking 把全量
 * 图标拖进产物（实测 744KB chunk）。新图标需在此登记。
 *
 * #520 D 域（S3-P2-1）：新增 `node` prop——ad-hoc 图标节点直传（lucide 核心具名导入
 * 的 IconNode，优先于映射表；`name` 仍驱动 `.lucide-{kebab}` 类名契约）。零散一次性
 * 图标可经它直传而不再登记本表；各视图的手绘 IconNode 映射表副本自此退役。
 */
const ICON_NODES: Readonly<Record<string, IconNode>> = {
  Activity,
  Archive,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  Bot,
  Boxes,
  Braces,
  ChevronDown,
  ChevronFirst,
  ChevronLeft,
  ChevronLast,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Code2,
  Clock,
  Clock3,
  Database,
  Download,
  FileCode2,
  FileJson,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Globe2,
  Hash,
  History,
  House,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Send,
  Settings,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareStack,
  Upload,
  Waypoints,
  X,
}

/** 名字 → 表内 IconNode（未登记返回 undefined；供字符串名契约的包装件保留自有回退）。 */
export function lookupIconNode(name: string): IconNode | undefined {
  return ICON_NODES[name]
}

export function LucideIcon(props: { name: string; node?: IconNode; size?: number; strokeWidth?: number; class?: string }) {
  // Invariance 豁免（显式）：props.name 挂载后不变——调用点均随 For 行重挂，name 变化即换
  // 实例；kebab/iconNode 顶层捕获（非响应式读）是有意为之，不按响应式访问器改写。
  const kebab = props.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  const iconNode: IconNode = props.node ?? ICON_NODES[props.name] ?? SquareStack

  const build = (host: SVGSVGElement) => {
    const svgNamespace = 'http://www.w3.org/2000/svg'
    host.setAttribute('xmlns', svgNamespace)
    host.setAttribute('viewBox', '0 0 24 24')
    host.setAttribute('fill', 'none')
    host.setAttribute('stroke', 'currentColor')
    host.setAttribute('stroke-width', String(props.strokeWidth ?? 2))
    host.setAttribute('stroke-linecap', 'round')
    host.setAttribute('stroke-linejoin', 'round')
    for (const [tag, attributes] of iconNode) {
      const child = document.createElementNS(svgNamespace, tag)
      for (const [name, value] of Object.entries(attributes)) {
        if (name === 'key') continue
        child.setAttribute(name, String(value))
      }
      host.appendChild(child)
    }
  }

  return (
    <svg
      ref={element => build(element)}
      class={`lucide lucide-${kebab} ${props.class ?? ''}`}
      width={props.size ?? 24}
      height={props.size ?? 24}
      aria-hidden="true"
    />
  )
}
