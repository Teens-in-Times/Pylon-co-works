/**
 * externalHistoryRepository — 外部 CLI 历史导入的 IPC 适配层（#364 首版）。
 *
 * 后端命令 external_history_scan / external_history_import（src-tauri/src/
 * external_history/）：scan 只读磁盘不写库；import 经
 * EventService::ingest_external_history 落 canonical journal（provenance =
 * external-import/unverified）。browser 模式（无后端）不可用——导入是本机
 * 文件系统能力，无 web 兜底。
 */

import { invoke } from '@tauri-apps/api/core'

/** 扫描摘要（pylon-agent-history ExternalSessionSummary 的 wire 形状）。 */
export interface ExternalSessionSummaryWire {
  agentId: string
  externalId: string
  title: string | null
  startedAt: string
  lastActivityAt: string
  eventCount: number
  sourcePath: string
  skippedLineCount: number
}

/** 单会话导入结果（status 词表：imported / already-imported）。 */
export interface ExternalHistoryImportOutcome {
  externalId: string
  title: string | null
  status: 'imported' | 'already-imported'
  importedEventCount: number
}

export function scanExternalHistory(): Promise<ExternalSessionSummaryWire[]> {
  return invoke<ExternalSessionSummaryWire[]>('external_history_scan')
}

/**
 * 导入会话：`externalIds = null` 表示全部扫描结果；`force = true` 时对已导入
 * 会话生成分叉副本（`#N` 后缀新 journal，原快照封存不动）。
 */
export function importExternalHistory(
  externalIds: string[] | null,
  force: boolean,
): Promise<ExternalHistoryImportOutcome[]> {
  return invoke<ExternalHistoryImportOutcome[]>('external_history_import', {
    externalIds,
    force,
  })
}
