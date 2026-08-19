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
