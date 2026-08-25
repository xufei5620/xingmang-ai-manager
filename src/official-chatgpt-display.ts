export function formatOfficialDateTime(value: string | null | undefined, now: Date = new Date()): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hour}:${minute} · ${formatOfficialRelative(date, now)}`
}

export function formatOfficialResetLabel(value: string | null | undefined, now: Date = new Date()): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return formatOfficialRelative(date, now)
}

export function shortOfficialWindowLabel(label: string): string {
  const trimmed = label.trim()
  const spark = /spark/i.test(trimmed)
  if (/5\s*小时/.test(trimmed)) return spark ? 'Spark · 5小时' : '5 小时'
  if (/周/.test(trimmed)) return spark ? 'Spark · 周' : '周限额'
  if (spark) return 'Spark'
  return trimmed.replace(/限额$/, '').trim() || trimmed
}

export function formatOfficialRelative(date: Date, now: Date = new Date()): string {
  const deltaMs = date.getTime() - now.getTime()
  const absMs = Math.abs(deltaMs)
  if (absMs < 90_000) return deltaMs >= 0 ? '即将重置' : '刚刚'
  const minutes = Math.round(absMs / 60_000)
  if (minutes < 60) return deltaMs >= 0 ? `${minutes}分钟后` : `${minutes}分钟前`
  const hours = Math.round(absMs / 3_600_000)
  if (hours < 24) return deltaMs >= 0 ? `${hours}小时后` : `${hours}小时前`
  const days = Math.round(absMs / 86_400_000)
  return deltaMs >= 0 ? `${days}天后` : `${days}天前`
}
