/**
 * settingProvenance — 主题字段写入溯源账本（D-trace）。
 *
 * 动机：主题字段存在 8 类写入方（用户编辑/zone 预设/全局预设/自定义预设/
 * 界面模式切换/界面模式重置/字段级恢复默认/持久化迁移），此前全部汇入同一
 * setZoneField 漏斗且互不可区分——"这个字段为什么是这个值"
 * 无法回答（自定义预设排查时的核心盲区）。
 *
 * 设计约束：
 * - 纯内存环形缓冲（不上 store、不持久化）：溯源是调试元数据，不是设置项
 *   （与 settingsChromeState 同一设计纪律：chrome/调试态不进 schema）。
 * - 记录在写入漏斗（store actions）处完成，reducer 保持纯函数。
 * - DEV 下暴露 window.__pylonSettingProvenance 供控制台追问。
 */

export type SettingWriteSource =
  | 'user-edit'
  | 'field-reset'
  | 'zone-preset'
  | 'global-preset'
  | 'custom-preset'
  | 'theme-reset'
  | 'zone-reset'
  /** ★ #607 刀3a：切换界面模式（= 应用本大类隐藏默认单，整份换装）。 */
  | 'interface-mode'

export interface SettingWriteRecord {
  readonly key: string
  readonly zone: string
  readonly source: SettingWriteSource
  readonly at: number
}

const RING_CAPACITY = 256
const ring: SettingWriteRecord[] = []
const lastWriterByKey = new Map<string, SettingWriteRecord>()

/** 记录一次批量写入（一次 action 可能写多个字段）。at 由调用方注入以便测试。 */
export function recordSettingWrites(
  source: SettingWriteSource,
  zone: string,
  keys: readonly string[],
  at = Date.now(),
): void {
  if (keys.length === 0) return
  for (const key of keys) {
    const record: SettingWriteRecord = { key, zone, source, at }
    ring.push(record)
    lastWriterByKey.set(key, record)
  }
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)
}

/** 某字段最近一次写入的贡献者；从未被记录过返回 undefined。 */
export function lastSettingWriter(key: string): SettingWriteRecord | undefined {
  return lastWriterByKey.get(key)
}

/** 最近写入流水（新→旧），最多 limit 条。 */
export function recentSettingWrites(limit = 20): readonly SettingWriteRecord[] {
  const out: SettingWriteRecord[] = []
  for (let index = ring.length - 1; index >= 0 && out.length < limit; index -= 1) {
    out.push(ring[index])
  }
  return out
}

/** 测试/重放水复位。 */
export function resetSettingProvenance(): void {
  ring.length = 0
  lastWriterByKey.clear()
}

/** 溯源来源的展示文案（FieldRow title / 控制台输出共用）。 */
export const SETTING_WRITE_SOURCE_LABELS: Readonly<Record<SettingWriteSource, string>> = {
  'user-edit': '手动编辑',
  'field-reset': '恢复默认',
  'zone-preset': '局部预设',
  'global-preset': '全局预设',
  'custom-preset': '自定义预设',
  'interface-mode': '界面模式',
  'theme-reset': '整体重置',
  'zone-reset': '分区重置',
}

declare global {
  interface Window {
    __pylonSettingProvenance?: {
      last: typeof lastSettingWriter
      recent: typeof recentSettingWrites
    }
  }
}

// 非宿主构建环境（如插件 tsc 程序）可能没有 import.meta.env —— 缺省按非 DEV 处理
const IS_DEV = typeof import.meta !== 'undefined'
  && Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
if (typeof window !== 'undefined' && IS_DEV) {
  window.__pylonSettingProvenance = { last: lastSettingWriter, recent: recentSettingWrites }
}
