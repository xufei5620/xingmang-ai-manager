function pad(value: number): string { return String(value).padStart(2, '0') }

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 列表里的时间按本机日历写：「刚刚」「今天 14:20」「昨天 09:12」「9月28日」，往年带上
 * 年份。原是首页「最近」的写法，记录、备份、上次检测和上次检查都照它；带年带秒
 * 的完整时间放进鼠标提示和详情。读不出日期返回 null，由调用方写它自己的那句。
 */
export function formatCalendarTime(milliseconds: number, now: number): string | null {
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime())) return null
  const elapsed = now - date.getTime()
  if (elapsed >= 0 && elapsed < 60_000) return '刚刚'
  const today = new Date(now)
  // 按日历天数差算，不按 24 小时：昨晚 23 点到今早 1 点也算「昨天」。
  // 用 round 吸收夏令时那一天多出或少掉的一小时。
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days <= 0) return `今天 ${clock}`
  if (days === 1) return `昨天 ${clock}`
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}
