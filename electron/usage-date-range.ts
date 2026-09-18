/** Calendar dates are sent unchanged; the backend applies midnight in this timezone. */
export function usageCalendarDate(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  const part = (kind: string) => parts.find((entry) => entry.type === kind)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function usageDateRange(input: { startDate?: string; endDate?: string; timezone?: string }, now = new Date()) {
  if ([input.startDate, input.endDate].some((value) => value !== undefined && typeof value !== 'string')) throw new Error('请选择有效日期。')
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof timezone !== 'string' || !timezone || timezone.length > 128) throw new Error('请选择有效时区。')
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(now) } catch { throw new Error('请选择有效时区。') }
  const today = usageCalendarDate(now, timezone)
  const startDate = input.startDate || new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10)
  const endDate = input.endDate || today
  for (const date of [startDate, endDate]) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('请选择有效日期。')
  }
  if (startDate > endDate) throw new Error('开始日期不能晚于结束日期。')
  return { startDate, endDate, timezone }
}
