/**
 * gateway 共享样式词汇（P93 样式绞杀批 3 的 utility 常量单一来源）。
 *
 * #520 K 域：GatewaySheetView 拆出 GatewayRouteForm 后，类名常量收拢到此——
 * 避免同源常量静默分裂（审查 S1-P2「本地重写常量」教训）。gateway-* 类名保留为
 * gateway/styles/adaptive.css（modern-gui 覆写 + status-pulse 动画）锚点；
 * runtime-filter-input / template-apply 保留为底座消费与 adaptive 锚点；
 * file-main 与 search-result 前缀的共享词汇从 DOM 退役，基线值并入 utility。
 */

/** 页头（gateway-header） */
export const HEADER = 'gateway-header flex items-end justify-between gap-4 flex-wrap mb-5'
export const KICKER = 'font-mono text-[11px] font-[650] tracking-[.12em] text-accent'
export const MAIN_TITLE = 'mt-1 text-text text-[24px] font-bold tracking-[-.025em]'
export const SUMMARY = 'gateway-summary flex flex-wrap gap-2'
export const SUMMARY_CHIP = 'gateway-summary-chip inline-flex items-center gap-1 min-h-[26px] px-3 border border-border text-text-dim bg-bg-input font-[family-name:var(--mono)] text-[11px]'
export const SUMMARY_CHIP_ONLINE = 'gateway-summary-chip gateway-summary-chip-online inline-flex items-center gap-1 min-h-[26px] px-3 border border-success-edge text-text-dim bg-bg-input font-[family-name:var(--mono)] text-[11px]'
export const SUMMARY_NUM = 'text-text font-bold'

/** 左列（#154：左列几何归布局层的 .sidebar，见 SearchSheetView 同处说明；本组只管内容样式） */
export const SIDEBAR = 'sidebar gateway-sidebar flex flex-col py-6 px-3 bg-[color-mix(in_srgb,var(--bg-panel)_72%,transparent)]'
export const SIDEBAR_LIST = 'grid gap-1 m-0 p-0 list-none'
export const SIDEBAR_ITEM = 'flex items-center min-h-[var(--ui-control-compact)] px-3 border border-transparent rounded-none text-text-dim text-[12px] transition-[background-color,border-color,color] duration-[120ms] before:content-[""] before:inline-block before:w-1.5 before:h-1.5 before:mr-2 before:rounded-none before:bg-[var(--tool-ok)] before:shadow-[0_0_0_3px_var(--success-soft)] hover:border-border hover:bg-bg-hover hover:text-text'
export const SIDEBAR_ITEM_PATH = 'min-w-0 flex-1 overflow-hidden text-ellipsis text-accent font-[family-name:var(--mono)]'
export const SIDEBAR_ITEM_TEXT = 'text-text-dim max-w-[40%] overflow-hidden text-ellipsis whitespace-nowrap'
export const SIDEBAR_HINT = 'file-section-hint m-0 p-3 border border-dashed border-border rounded-none'

/** 主区与分区卡片 */
export const MAIN = 'gateway-main flex-1 min-w-0 py-6 px-[clamp(var(--ui-space-5),4vw,var(--ui-space-7))] overflow-y-auto'
export const SECTION = 'gateway-section m-0 mb-5 p-4 border border-border rounded-none bg-bg-panel'
export const SECTION_HEAD = 'gateway-section-head flex items-baseline justify-between gap-3 flex-wrap m-0 mb-2'
export const SECTION_META = 'gateway-section-meta text-text-dim font-[family-name:var(--mono)] text-[11px]'
export const SECTION_TITLE = 'flex items-center gap-2 m-0 text-text text-[13px] font-[650] tracking-[.02em] before:content-[""] before:inline-block before:w-[3px] before:h-[14px] before:shrink-0 before:rounded-none before:bg-accent before:opacity-80 not-first:mt-6'
export const SECTION_HINT = 'gateway-section-hint m-0 mb-3 text-text-dim text-[12px]'
export const EMPTY = 'gateway-empty m-0 py-4 px-3 border border-dashed border-border text-text-dim text-[12px]'

/** 提示/错误 */
export const HINT = 'file-section-hint text-[12px] text-text-dim'
export const TREE_ERROR = 'file-tree-error mb-4'

/** 路由表 */
export const ROUTES = 'gateway-routes flex flex-col gap-2'
export const ROUTE = 'gateway-route overflow-hidden border border-border rounded-none bg-bg-input transition-[border-color,background-color] duration-[120ms] hover:border-border-focus'
export const ROUTE_OPEN = 'gateway-route overflow-hidden border border-border-focus rounded-none bg-bg-input transition-[border-color,background-color] duration-[120ms]'
export const ROUTE_HEAD = 'gateway-route-head flex gap-3 items-center w-full min-h-[var(--ui-control-standard)] px-3 py-2 text-left text-text bg-transparent border-0 cursor-pointer font-[family-name:var(--font)] text-[12px] hover:bg-bg-hover aria-expanded:bg-bg-active aria-expanded:shadow-[inset_3px_0_0_var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
export const ROUTE_HEAD_PATH = 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-text font-[family-name:var(--mono)]'
export const ROUTE_HEAD_TEXT = 'shrink-0 text-text-dim whitespace-nowrap'
export const ROUTE_RESET = 'gateway-route-reset ml-auto text-text-dim font-[family-name:var(--mono)] text-[11px] whitespace-nowrap'
export const ROUTE_DETAIL = 'gateway-route-detail grid gap-1 p-3 border-t border-border bg-bg-panel text-[11px] text-text-dim [overflow-wrap:anywhere]'
export const ROUTE_DETAIL_FIELD = 'runtime-log-field flex gap-2 items-baseline min-h-[22px]'
export const ROUTE_DETAIL_CODE = 'runtime-log-field-code font-mono text-accent'

/** 表单行与按钮（宿主实例卡/新建实例与 GatewayRouteForm 共用） */
export const EDIT_ROW = 'gateway-edit-row flex gap-2 items-center mt-3'
export const FILTER_INPUT = 'runtime-filter-input flex-1 min-w-0'
export const TEMPLATE_BTN = 'template-apply min-w-[64px] h-[var(--ui-control-standard)] px-4 border border-border rounded-none text-text bg-bg-input cursor-pointer font-[family-name:var(--font)] text-[12px] transition-[background-color,border-color,color] duration-[120ms] enabled:hover:border-border-focus enabled:hover:bg-bg-hover disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
export const TEMPLATE_BTN_PRIMARY = 'template-apply gateway-btn-primary min-w-[64px] h-[var(--ui-control-standard)] px-4 cursor-pointer font-[family-name:var(--font)] text-[12px] font-[650] border border-accent-edge text-accent bg-accent-soft transition-[background-color,border-color,color] duration-[120ms] enabled:hover:border-accent-edge enabled:hover:bg-accent-soft-strong enabled:hover:text-accent disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
export const TEMPLATE_BTN_DANGER = 'template-apply gateway-btn-danger min-w-[64px] h-[var(--ui-control-standard)] px-4 cursor-pointer font-[family-name:var(--font)] text-[12px] font-[650] border border-danger-edge text-danger bg-danger-soft transition-[background-color,border-color,color] duration-[120ms] enabled:hover:bg-danger-soft-strong disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

/** 只读字段行（未绑定消息策略/知识注入分区） */
export const FIELD_ROW = 'gateway-field grid grid-cols-[88px_1fr] gap-3 items-baseline min-h-[24px] text-[12px] border-b border-dashed border-[color-mix(in_srgb,var(--border)_60%,transparent)] last:border-b-0'
export const FIELD_LABEL = 'gateway-field-label text-text-dim'
export const FIELD_VALUE = 'gateway-field-value text-text wrap-anywhere'

/** 实例卡 */
export const INSTANCE_LIST = 'gateway-instance-list block m-0 p-0 list-none'
export const INSTANCE_CARD = 'gateway-instance-card flex flex-col gap-2 p-3 mb-3 border border-border rounded-none bg-bg-input'
export const INSTANCE_CARD_ERROR = 'gateway-instance-card gateway-instance-card-error flex flex-col gap-2 p-3 mb-3 border border-danger-edge rounded-none bg-bg-input'
export const INSTANCE_HEAD = 'gateway-instance-head flex items-center gap-2 flex-wrap'
export const INSTANCE_STATUS_CONNECTED = 'gateway-instance-status gateway-instance-status-connected inline-flex items-center gap-[5px] text-[0.85em] px-2 py-[1px] rounded-full bg-success-soft text-success'
export const INSTANCE_STATUS_ERROR = 'gateway-instance-status gateway-instance-status-error inline-flex items-center gap-[5px] text-[0.85em] px-2 py-[1px] rounded-full bg-danger-soft text-danger'
export const INSTANCE_STATUS_STARTING = 'gateway-instance-status gateway-instance-status-starting gateway-status-pulse inline-flex items-center gap-[5px] text-[0.85em] px-2 py-[1px] rounded-full bg-warning-soft text-warning'
export const INSTANCE_STATUS_STOPPED = 'gateway-instance-status gateway-instance-status-stopped inline-flex items-center gap-[5px] text-[0.85em] px-2 py-[1px] rounded-full bg-[var(--bg-muted,#f0f0f0)] text-[var(--text-dim,#666)]'
