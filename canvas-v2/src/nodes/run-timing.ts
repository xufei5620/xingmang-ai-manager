export function runElapsedMilliseconds(startedAt: string | undefined, now = Date.now()): number {
  if (!startedAt) return 0
  const parsed = Date.parse(startedAt)
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : 0
}

export function formatRunElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds} 秒`
}

/** 预览角标用：只显示实测耗时。缓存命中也要看当初花了多久，不能把角标改成「已缓存」。 */
export function generationDurationLabel(durationMs: number | undefined): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return null
  return formatRunElapsed(durationMs)
}

export function generationElapsedChipLabel(durationMs: number | undefined): string | null {
  const elapsed = generationDurationLabel(durationMs)
  return elapsed ? `耗时 ${elapsed}` : null
}
