/**
 * #376/#375 的 memory 域：**逻辑载荷 → 文档驻留**的比值判据（纯函数口径）。
 *
 * 这里量的是「折完之后文档还留着多少」——不是耗时。判据全用比值（驻留 / Σ逻辑载荷），
 * 换机器、换语料都还能比；绝对 MB 由实机探针（`proc-tree.ps1` + CDP）给，见 README。
 *
 * 两条 case：
 * - `cold-load-residency`：整份 compact 读（2203 行 / Σ载荷 ≈61.5 MB）折完后的文档驻留；
 * - `beat-sensitivity`：同一终值内容下，拍数 5 → 40 的驻留增长（累计式回传的放大量纲）。
 *
 * #449 起补 text/thinking 族（`text` 节）——旧语料只有 user chunk + tool 族，text 族的
 * 驻留形态从未被量过：`text-thinking-residency`（增量 chunk 生成产段折完的驻留/Σ载荷）、
 * text 拍数敏感性（chunk 5 → 40）、粒度对照（batch 行 vs 逐 delta 行——生产稳态走 sink
 * 折叠，折叠前必须过 `mergeAdjacentDeltaChunks`，本套件此前直折 rows 不过 sink 正是缺口）。
 *
 * 装载路径走**生产出口**：`readWorkbenchRow`（canonical 行 → 信封，含 turn.unit/batch
 * 展开——`agentWorkbenchReplay.collectRowsInto` 逐行同款）+ `projectWorkbench`（信封 → 文档）。
 * 行与信封在折完之后即可回收——这正是 #376-b 分页装载要让位给 GC 的部分，
 * 故本域只从**文档**取根，不把行数组算进驻留。
 */
import { readWorkbenchRow } from '../../../src/application/agent-workbench/agentWorkbenchProjection.ts'
import { createAgentWorkbenchSessionRuntime } from '../../../src/application/agent-workbench/agentWorkbenchSession.ts'
import { mergeAdjacentDeltaChunks } from '../../../src/infrastructure/events/canonicalEventBatch.ts'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent, setTimelinePayloadNarrowing } from '../../../src/domains/workbench/workbenchProjector.ts'
import type { Session } from '../../../src/domains/identity/identityTypes.ts'
import { createWorkbenchEnvelope } from '../../../src/domains/workbench/events/workbenchEventSchema.ts'
import { measureRetainedBytes, type RetainedBytesReport } from '../retainedHeap.ts'
import { buildMemoryCorpus, buildMetadataSnapshotEnvelopes, type MemoryCorpusOptions } from '../fixtures/memoryCorpus.ts'

export interface MemoryCaseResult {
  readonly name: string
  readonly logicalPayloadBytes: number
  readonly retained: RetainedBytesReport
  /** 判据：驻留 / Σ逻辑载荷 */
  readonly ratio: number
  readonly threshold: number
  readonly pass: boolean
  readonly note: string
}

export interface MetadataSnapshotCase {
  readonly rows: number
  readonly singleBytes: number
  readonly retainedBytes: number
  /** 判据：同类快照在文档里的驻留 / 单份大小（#375-d 要求 ≤ 2×）。 */
  readonly ratio: number
  readonly threshold: number
  readonly pass: boolean
}

export interface MemorySuiteResult {
  readonly cases: readonly MemoryCaseResult[]
  readonly metadataSnapshot: MetadataSnapshotCase
  /**
   * 拍数敏感性：**同一终值内容**下拍数 5 → 40 的**绝对**驻留增长。这里必须用绝对字节，
   * 不能用「驻留/Σ载荷」——Σ载荷本身就随拍数变（累计式回传下 5 拍的 Σ 是 40 拍的一半），
   * 用比值会把要量的效应约掉。
   */
  readonly beatSensitivity: {
    readonly lowBeats: number
    readonly highBeats: number
    readonly lowBytes: number
    readonly highBytes: number
    readonly growth: number
    readonly threshold: number
    readonly pass: boolean
  }
  /** #449：text/thinking 族的驻留形态（旧语料盲区）。 */
  readonly text: TextFamilySection
  /**
   * #567：**会话口径**——实例化真实会话宿主（`createAgentWorkbenchSessionRuntime`），
   * 经注入的分页读走生产冷装载缝，量「runtime 快照（文档 + 生成态）+ 乐观 pending 模型」
   * 的驻留。#380 删除 fold.log 后，会话口径不再有 ≈Σ载荷 的第二份持有；本节把这件事
   * 从「结构性事实」变成探针读数。
   */
  readonly session: SessionScopeSection
}

export interface TextFamilySection {
  /** 增量 chunk 生成产段（thinking 538k + text 8k，零工具拍）折完的驻留/Σ载荷。 */
  readonly residency: MemoryCaseResult
  /** chunk 5 → 40（同一终值文本）的绝对驻留增长——batch 折叠下应天然低拍敏。 */
  readonly beat: {
    readonly lowChunks: number
    readonly highChunks: number
    readonly lowBytes: number
    readonly highBytes: number
    readonly growth: number
    readonly threshold: number
    readonly pass: boolean
  }
  /** 粒度对照（信息读数，不设阈值）：同一份文本族行，batch 折叠 vs 逐 delta 直折。 */
  readonly granularity: {
    readonly chars: number
    readonly batchRows: number
    readonly perDeltaRows: number
    readonly batchBytes: number
    readonly perDeltaBytes: number
    readonly amplification: number
  }
}

export interface SessionScopeSection {
  /** 会话宿主冷装载后的驻留 / Σ逻辑载荷（#375 会话口径阈值 1.2×）。 */
  readonly residency: MemoryCaseResult
  /** 会话口径的拍数敏感性（同终值 5 → 40 拍，绝对驻留增长，阈值 1.5×）。 */
  readonly beat: {
    readonly lowBeats: number
    readonly highBeats: number
    readonly lowBytes: number
    readonly highBytes: number
    readonly growth: number
    readonly threshold: number
    readonly pass: boolean
  }
  /**
   * 乐观 pending 模型：echo 闭包态不可静态可达，用**真实信封工厂**按 `echo.project`
   * 的同一构造形状造条目计量。`entries` 是声明的工作量假设（并发在途发送数），
   * 不是探针测得的事实——如实分开。
   */
  readonly pending: {
    readonly entries: number
    readonly contentChars: number
    readonly bytesPerEntry: number
    readonly bytes: number
  }
}

/**
 * 把一整份 compact 读折成文档（与前端 `listJournalPages` 的逐页折同序同果）。
 *
 * `granularity: 'batch'`（缺省）先过 `mergeAdjacentDeltaChunks`——**生产稳态**下 delta 行
 * 在落盘前就已折成 batch 行（≤48KiB/2000 chunk，折叠规则单源在 Rust fold.rs；这里的
 * `mergeAdjacentDeltaChunks` 是测试期参考合并器，无生产调用方，用它复现同一 batch 形状），
 * 读侧见到的就是折叠后形状；此前
 * 本套件直折 rows 不过 sink，per-chunk 行永不折 batch，正是 #449 指出的语料缺口。
 * `'per-delta'` 保留逐 delta 行，量「最坏形状」（播种/旧日志/折叠关闭）的驻留差。
 */
function foldToDocument(
  corpus: ReturnType<typeof buildMemoryCorpus>,
  options: { readonly granularity?: 'batch' | 'per-delta', readonly pageSize?: number } = {},
) {
  const granularity = options.granularity ?? 'batch'
  const pageSize = options.pageSize ?? 256
  const source = granularity === 'batch' ? mergeAdjacentDeltaChunks(corpus.rows) : corpus.rows
  let document = createWorkbenchDocument(corpus.owner.localSessionId)
  const rows = source as readonly unknown[]
  for (let start = 0; start < rows.length; start += pageSize) {
    // 行 → 信封走 `readWorkbenchRow`（#567 勘误：原导入的 `toWorkbenchEnvelopes` 已在
    // #520 会话运行时拆分中删除，scripts 不在类型门禁内，此断导入让探针红了数日）。
    // 这正是 bind/refresh 的 `collectRowsInto` 逐行同款读缝（含 turn.unit/batch 展开）。
    const envelopes = rows.slice(start, start + pageSize).flatMap(row => {
      const read = readWorkbenchRow(row)
      return read.ok ? Array.from(read.envelopes) : []
    })
    document = projectWorkbench(envelopes, { initialDocument: document }).document
    // 页内行与信封在这里失去引用（页级回收）——与分页装载的实际形状一致。
  }
  return { document, foldedRows: source.length }
}

function residencyCase(
  name: string,
  options: MemoryCorpusOptions,
  threshold: number,
  note: string,
  fold: { readonly granularity?: 'batch' | 'per-delta' } = {},
): { readonly result: MemoryCaseResult } {
  const corpus = buildMemoryCorpus(options)
  const { document } = foldToDocument(corpus, fold)
  // 根 = 文档本身（+ 它挂着的全部切片）；行数组**不**入根。
  const retained = measureRetainedBytes([document])
  const ratio = corpus.logicalPayloadBytes === 0 ? 0 : retained.bytes / corpus.logicalPayloadBytes
  return {
    result: {
      name,
      logicalPayloadBytes: corpus.logicalPayloadBytes,
      retained,
      ratio,
      threshold,
      pass: ratio <= threshold,
      note,
    },
  }
}

// ── #567：会话口径（真实会话宿主）────────────────────────────────────────────
//
// 文档口径的根是纯函数折出的文档；会话口径的根是**真实会话运行时**（组合根工厂）
// 冷装载后的 runtime 快照。2026-09 评审轮的会话总量 ≈1.4× 来自 fold.log——#380 把它
// 整份删除后，「会话侧只剩文档 + 有界项」一直是结构性事实（源码守卫 + 回滚用例）；
// 本节把这件事变成探针读数：若有人往会话宿主里再加一份常驻载荷持有，比值会直接显形。
//
// 口径边界（如实声明，防误读）：
// 1. 根 = `runtime.getSnapshot()`（文档 + 生成态/status 字段）。宿主的其余闭包态
//    （TurnClock/draft id 集合/binding 计数/sessionUi 注册表）要么是纯标量、要么冷装载后
//    为空，且静态可达图摸不到闭包——它们是**有界项**，不是被测项。
// 2. 乐观 pending 同为闭包态（echo 的 `pendingOptimisticBySource`），用真实信封工厂按
//    `echo.project` 的同一构造形状建模，并发数是声明的工作量假设（见 `SESSION_PENDING_*`）。
// 3. `PERF_MEMORY_LEGACY` 对本节**无效**：bind 按生产口径自行置位 timeline 收窄
//    （`agentWorkbenchSession.ts` bind → 杀停开关读 DOM 属性，bun 下恒不生效）。因此本节
//    必须排在**文档用例之后**构建——否则那次全局置位会把 legacy 档的文档侧读数冲回默认。

/** 声明的工作量假设：并发在途发送（乐观 pending）条数。 */
const SESSION_PENDING_ENTRIES = 4
/** 声明的工作量假设：每条 pending 的正文长度（长 prompt 的保守量级）。 */
const SESSION_PENDING_CONTENT_CHARS = 2_048

function fakeMemorySession(source: string): Session {
  return {
    id: `sess-${source}`,
    agentId: 'peri',
    name: 'perf',
    source,
    profileId: 'perf',
    createdAt: 0,
    lastActiveAt: 0,
    platform: 'perf-bench',
    workdir: '.',
    sessionPrompt: '',
    skills: [],
    hooks: [],
    autoName: '',
  }
}

/** 经真实会话宿主的分页冷装载缝折完整份语料，量 runtime 快照的驻留。 */
async function coldLoadThroughSession(corpus: ReturnType<typeof buildMemoryCorpus>): Promise<RetainedBytesReport> {
  const host = createAgentWorkbenchSessionRuntime({
    listJournalPages: async (_ownerKey, onPage) => {
      const pageSize = 256
      for (let start = 0; start < corpus.rows.length; start += pageSize) {
        const end = Math.min(start + pageSize, corpus.rows.length)
        await onPage(corpus.rows.slice(start, end), end >= corpus.rows.length)
      }
    },
    loadDrafts: async () => [],
    subscribe: () => () => {},
    listenTerminalFallback: () => () => {},
  })
  try {
    await host.bind(fakeMemorySession(corpus.owner.localSessionId))
    const snapshot = host.runtime.getSnapshot()
    if (snapshot.status !== 'ready') {
      throw new Error(`会话宿主冷装载未就绪：status=${snapshot.status} error=${snapshot.error ?? ''}`)
    }
    return measureRetainedBytes([snapshot])
  } finally {
    host.destroy()
  }
}

/**
 * 乐观 pending 的单条驻留（模型项）：构造形状逐字段对齐 `echo.project`
 * （`agentWorkbenchOptimisticEnvelopes` 的 entry + 信封），信封走**真实工厂**。
 */
function pendingEntryBytes(): number {
  const content = 'x'.repeat(SESSION_PENDING_CONTENT_CHARS)
  const envelope = createWorkbenchEnvelope({
    eventId: 'optimistic:local:mem:pending-model',
    sessionId: 'local:mem',
    sequence: 1,
    recordedAt: new Date(0).toISOString(),
    source: { provider: 'local-user', sourceId: 'pending-model' },
    identity: { interactionId: 'pending-model' },
    provenance: { origin: 'optimistic-local', trust: 'unverified' },
    event: { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: content }] },
  })
  return measureRetainedBytes([
    { clientMessageId: 'pending-model', content, priorCanonicalMatches: 0, envelope },
  ]).bytes
}

export async function buildMemorySuite(options: { readonly legacy?: boolean } = {}): Promise<MemorySuiteResult> {
  // 对照档：关掉 #375-a 的 timeline 收窄，用**同一把尺子**量改动前的驻留（逃生口即对照开关）。
  if (options.legacy) setTimelinePayloadNarrowing(false)
  try {
    return await buildMemorySuiteInner()
  } finally {
    if (options.legacy) setTimelinePayloadNarrowing(true)
  }
}

async function buildMemorySuiteInner(): Promise<MemorySuiteResult> {
  const cold = residencyCase(
    'cold-load-residency',
    {},
    1.2,
    '整份 compact 读（一个完整回合 / 100 次工具调用 × 20 拍累计回传）折完后的驻留 / Σ逻辑载荷',
  )
  const low = residencyCase('beat-sensitivity-low', { calls: 8, beats: 5 }, Number.POSITIVE_INFINITY, '终值相同、拍数 5')
  const high = residencyCase('beat-sensitivity-high', { calls: 8, beats: 40 }, Number.POSITIVE_INFINITY, '终值相同、拍数 40')
  // #375-d 判据：500 回合 × 2 份**同内容**目录快照（真机单份 16 132 B / 13–14 KB），折完后
  // 文档里这类快照的**快照字节**必须 ≈ 单份（而不是 O(行数)）。量的对象是事件本身——
  // `timeline[].data` 与 `fold.log` 信封的 `event` 都指向它，唯一对象记账下就是这一份。
  // 计时行外壳（每条目一个 timeline entry）不在此判据内：事件条数是真实事实，不该"去重"。
  const metadata = buildMetadataSnapshotEnvelopes(500)
  const metadataDocument = metadata.envelopes.reduce(reduceWorkbenchEvent, createWorkbenchDocument('metadata'))
  const metadataRetained = measureRetainedBytes([
    ...metadata.envelopes.map(envelope => envelope.event),
    metadataDocument.timeline.map(entry => entry.data),
  ]).bytes
  // 单份大小用**同一把尺子**量（估算口径），不能拿 JSON 长度比——两者差 ~2.8×（对象头/属性槽
  // 的固定开销在短字符串上占比很大），拿 JSON 长度当分母会把 1.0× 的完美结果读成 3.1×。
  const singleBytes = measureRetainedBytes([metadata.envelopes[0]!.event]).bytes
  const metadataRatio = singleBytes === 0 ? 0 : metadataRetained / singleBytes
  const lowBytes = low.result.retained.bytes
  const highBytes = high.result.retained.bytes
  const growth = lowBytes === 0 ? 1 : highBytes / lowBytes
  // ── #449：text/thinking 族（旧语料盲区）────────────────────────────────
  // 思考量取实测会话档（538,695 字符 thinking，见 issue-205 记录）；零工具拍，
  // 让比值只反映文本族自身的「载荷 → 驻留」形态。
  //
  // 判据挂起（信息读数，#449 实测基线 3.119×）：1.2× 是 tool 族的口径（收窄+共享后载荷
  // 唯一承载面成立）。文本族的驻留 ≈ 3S 是结构性的——S(messages.content) + S(messages.parts
  // 合并串) + S(timeline.data.parts)，前两项是 WorkbenchMessage 双字段**固有**；即使把 text 族
  // 纳入 timeline 收窄（⧖ M2，需裁决）也只降到 ≈2×，仍过不了 1.2×。阈值该定多少、要不要动
  // 消息形状，是 M2 裁决包的一部分——在裁决落地前这里不设阈值，只出读数。
  const textResidency = residencyCase(
    'text-thinking-residency',
    { calls: 0, thinkingBlocks: 17, thinkingChars: 538_000, textChars: 8_000, deltaChars: 24 },
    Number.POSITIVE_INFINITY,
    '增量 chunk 生成产段（thinking 538k + text 8k，零工具拍）batch 折叠后的驻留 / Σ逻辑载荷；判据待 M2 裁决（基线 3.119×，tool 族口径的 1.2× 对文本族不成立——WorkbenchMessage content/parts 双字段固有 2×）',
  )
  const textLow = residencyCase(
    'text-beat-low',
    { calls: 0, thinkingBlocks: 5, thinkingChars: 538_000, textChars: 0 },
    Number.POSITIVE_INFINITY,
    '同一终值 thinking、chunk 数 5',
  )
  const textHigh = residencyCase(
    'text-beat-high',
    { calls: 0, thinkingBlocks: 40, thinkingChars: 538_000, textChars: 0 },
    Number.POSITIVE_INFINITY,
    '同一终值 thinking、chunk 数 40',
  )
  const textLowBytes = textLow.result.retained.bytes
  const textHighBytes = textHigh.result.retained.bytes
  const textGrowth = textLowBytes === 0 ? 1 : textHighBytes / textLowBytes
  // 粒度对照（信息读数）：同一份 50k 文本，batch 行 vs 逐 delta 行——量化「不过 sink 折叠」
  // 的最坏形状。总量取 50k 而非 538k：逐 delta 直折是 O(行数²) 的投影成本，538k/24 ≈ 22k 行
  // 会让对照 case 的构造成本淹没读数本身；形状结论在 50k 上已成立。
  const granularityCorpus = buildMemoryCorpus({ calls: 0, textChars: 50_000, deltaChars: 24 })
  const batchFold = foldToDocument(granularityCorpus, { granularity: 'batch' })
  const perDeltaFold = foldToDocument(granularityCorpus, { granularity: 'per-delta' })
  const batchBytes = measureRetainedBytes([batchFold.document]).bytes
  const perDeltaBytes = measureRetainedBytes([perDeltaFold.document]).bytes
  // ── #567：会话口径（真实会话宿主）────────────────────────────────────
  // 放在所有文档用例**之后**：bind 会按生产口径全局重置 timeline 收窄开关（见
  // `coldLoadThroughSession` 上方的口径边界 3），先跑会把文档侧读数冲掉。
  const sessionColdCorpus = buildMemoryCorpus({})
  const sessionColdRetained = await coldLoadThroughSession(sessionColdCorpus)
  const perPending = pendingEntryBytes()
  const sessionPendingBytes = perPending * SESSION_PENDING_ENTRIES
  // 在途发送期间文档还会多折一条乐观行（≈content 大小）——pending 模型把它保守计入。
  const sessionRetainedBytes = sessionColdRetained.bytes + sessionPendingBytes
  const sessionRatio = sessionRetainedBytes / sessionColdCorpus.logicalPayloadBytes
  const sessionLowCorpus = buildMemoryCorpus({ calls: 8, beats: 5 })
  const sessionHighCorpus = buildMemoryCorpus({ calls: 8, beats: 40 })
  const sessionLowBytes = (await coldLoadThroughSession(sessionLowCorpus)).bytes
  const sessionHighBytes = (await coldLoadThroughSession(sessionHighCorpus)).bytes
  const sessionGrowth = sessionLowBytes === 0 ? 1 : sessionHighBytes / sessionLowBytes
  return {
    cases: [cold.result, low.result, high.result, textResidency.result, textLow.result, textHigh.result],
    metadataSnapshot: {
      rows: metadata.envelopes.length,
      singleBytes,
      retainedBytes: metadataRetained,
      ratio: metadataRatio,
      threshold: 2,
      pass: metadataRatio <= 2,
    },
    beatSensitivity: {
      lowBeats: 5,
      highBeats: 40,
      lowBytes,
      highBytes,
      growth,
      threshold: 1.5,
      pass: growth <= 1.5,
    },
    text: {
      residency: textResidency.result,
      beat: {
        lowChunks: 5,
        highChunks: 40,
        lowBytes: textLowBytes,
        highBytes: textHighBytes,
        growth: textGrowth,
        threshold: 1.5,
        pass: textGrowth <= 1.5,
      },
      granularity: {
        chars: granularityCorpus.logicalPayloadBytes,
        batchRows: batchFold.foldedRows,
        perDeltaRows: perDeltaFold.foldedRows,
        batchBytes,
        perDeltaBytes,
        amplification: batchBytes === 0 ? 1 : perDeltaBytes / batchBytes,
      },
    },
    session: {
      residency: {
        name: 'session-cold-load-residency',
        logicalPayloadBytes: sessionColdCorpus.logicalPayloadBytes,
        retained: sessionColdRetained,
        ratio: sessionRatio,
        threshold: 1.2,
        pass: sessionRatio <= 1.2,
        note: '会话宿主（真实 runtime，分页冷装载缝）快照驻留 + 乐观 pending 模型（4 条 × 2 KiB，声明假设）后的驻留 / Σ逻辑载荷；闭包态（时钟/draft id/sessionUi）为有界项，不在静态可达图内',
      },
      // 拍数敏感性取**纯冷装载**口径（不含 pending 常数项）——给两侧同加常数会把
      // 要量的效应稀释掉。
      beat: {
        lowBeats: 5,
        highBeats: 40,
        lowBytes: sessionLowBytes,
        highBytes: sessionHighBytes,
        growth: sessionGrowth,
        threshold: 1.5,
        pass: sessionGrowth <= 1.5,
      },
      pending: {
        entries: SESSION_PENDING_ENTRIES,
        contentChars: SESSION_PENDING_CONTENT_CHARS,
        bytesPerEntry: perPending,
        bytes: sessionPendingBytes,
      },
    },
  }
}
