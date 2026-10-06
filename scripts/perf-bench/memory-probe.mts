/**
 * #376/#375 memory 域入口：一条命令出数 + 按判据给退出码（可进 CI 门禁）。
 *
 *   bun run perf-bench:memory
 *
 * 读数口径与阈值见 `scripts/perf-bench/README.md` 的「memory 域」一节。本入口**只**跑
 * memory 域（毫秒级基准在 `scripts/perf-bench.mts`），因为它量的不是耗时而是比值。
 */
import { buildMemorySuite } from './suites/memorySuite.ts'

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function main(): void {
  void run()
}

async function run(): Promise<void> {
  const started = performance.now()
  const legacy = process.env.PERF_MEMORY_LEGACY === '1'
  if (legacy) console.log('[对照档] PERF_MEMORY_LEGACY=1：关掉 #375-a 的 timeline 收窄，用同一把尺子量改动前')
  const suite = await buildMemorySuite({ legacy })
  const lines: string[] = []
  lines.push('')
  lines.push('perf-bench · memory 域（#376 / #375）——比值判据，纯函数口径的 retained-heap 记账')
  lines.push('')
  lines.push('| case | Σ逻辑载荷 | 文档驻留(估) | 驻留/Σ载荷 | 阈值 | 判 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const item of suite.cases) {
    const verdict = item.threshold === Number.POSITIVE_INFINITY ? '—' : item.pass ? 'PASS' : 'FAIL'
    const threshold = item.threshold === Number.POSITIVE_INFINITY ? '—' : `${item.threshold}×`
    lines.push(
      `| ${item.name} | ${mib(item.logicalPayloadBytes)} | ${mib(item.retained.bytes)} `
      + `| ${item.ratio.toFixed(3)}× | ${threshold} | ${verdict} |`,
    )
  }
  const snapshots = suite.metadataSnapshot
  lines.push('')
  lines.push(
    `同内容元数据快照（#375-d）：${snapshots.rows} 行 / 单份 ${(snapshots.singleBytes / 1024).toFixed(1)} KB → `
    + `文档驻留 ${(snapshots.retainedBytes / 1024).toFixed(1)} KB = 单份 × ${snapshots.ratio.toFixed(2)}`
    + `（阈值 ≤ ${snapshots.threshold}×）→ ${snapshots.pass ? 'PASS' : 'FAIL'}`,
  )
  const beats = suite.beatSensitivity
  lines.push('')
  lines.push(
    `拍数敏感性（同一终值内容，绝对驻留）：${beats.lowBeats} 拍 ${mib(beats.lowBytes)} → `
    + `${beats.highBeats} 拍 ${mib(beats.highBytes)}，增长 ${beats.growth.toFixed(2)}×`
    + `（阈值 ≤ ${beats.threshold}×）→ ${beats.pass ? 'PASS' : 'FAIL'}`,
  )
  const text = suite.text
  lines.push('')
  lines.push(
    `text/thinking 驻留（#449）：${mib(text.residency.logicalPayloadBytes)} 载荷 → `
    + `${mib(text.residency.retained.bytes)}，比值 ${text.residency.ratio.toFixed(3)}×`
    + `（判据挂起，待 M2 裁决）→ ${text.residency.pass ? '读数' : 'FAIL'}`,
  )
  lines.push(
    `text 拍数敏感性（同一终值 thinking，chunk 5 → 40）：${mib(text.beat.lowBytes)} → `
    + `${mib(text.beat.highBytes)}，增长 ${text.beat.growth.toFixed(2)}×`
    + `（阈值 ≤ ${text.beat.threshold}×）→ ${text.beat.pass ? 'PASS' : 'FAIL'}`,
  )
  lines.push(
    `text 粒度对照（信息读数，50k 文本）：batch ${text.granularity.batchRows} 行 ${mib(text.granularity.batchBytes)}`
    + ` vs 逐 delta ${text.granularity.perDeltaRows} 行 ${mib(text.granularity.perDeltaBytes)}`
    + `，放大 ${text.granularity.amplification.toFixed(2)}×`,
  )
  const session = suite.session
  lines.push('')
  lines.push(
    `会话口径（#567，真实会话宿主 + 分页冷装载缝）：快照 ${mib(session.residency.retained.bytes)}`
    + ` + pending 模型 ${session.pending.entries} 条 × ${(session.pending.bytesPerEntry / 1024).toFixed(1)} KB`
    + ` = ${mib(session.residency.retained.bytes + session.pending.bytes)} → 驻留/Σ载荷 ${session.residency.ratio.toFixed(3)}×`
    + `（阈值 ≤ ${session.residency.threshold}×）→ ${session.residency.pass ? 'PASS' : 'FAIL'}`,
  )
  lines.push(
    `会话拍数敏感性（同终值 ${session.beat.lowBeats} → ${session.beat.highBeats} 拍，纯冷装载口径）：`
    + `${mib(session.beat.lowBytes)} → ${mib(session.beat.highBytes)}，增长 ${session.beat.growth.toFixed(2)}×`
    + `（阈值 ≤ ${session.beat.threshold}×）→ ${session.beat.pass ? 'PASS' : 'FAIL'}`,
  )
  lines.push(
    '    口径边界：根=runtime 快照（文档+生成态）；时钟/draft id/sessionUi 等闭包态为有界项不在可达图内；'
    + 'pending 为真实信封形状 × 声明并发数；PERF_MEMORY_LEGACY 对会话节无效（bind 按生产口径置收窄）。',
  )
  lines.push('')
  lines.push('注：驻留是**估算**（唯一对象去重后按字符串/对象头记账），只用于比值；')
  lines.push('    绝对进程峰值见 README「memory 域」的实机探针（proc-tree.ps1 + CDP）。')
  lines.push('')
  for (const line of lines) console.log(line)

  const failed = suite.cases.filter(item => !item.pass).length + (beats.pass ? 0 : 1)
    + (snapshots.pass ? 0 : 1) + (text.residency.pass ? 0 : 1) + (text.beat.pass ? 0 : 1)
    + (session.residency.pass ? 0 : 1) + (session.beat.pass ? 0 : 1)
  if (failed > 0) {
    console.error(`memory 域判据未过：${failed} 项`)
    process.exitCode = 1
    return
  }
  console.log(`memory 域判据全过（${(performance.now() - started).toFixed(0)}ms）`)
}

main()
