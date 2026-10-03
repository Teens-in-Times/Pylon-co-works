/** Framework-neutral C01 duration label shared by the Solid surface and the third-party react compat kind. */
export function formatThoughtDuration(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < 60_000) return `Thought for ${(clamped / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const totalSeconds = Math.round(clamped / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `Thought for ${minutes}m ${seconds}s`
}
