import type { RuntimeLogSnapshot } from '../../../../electron/ipc-contract'

export type RuntimeLogEntry = RuntimeLogSnapshot['entries'][number]

export interface RuntimeLogBoot {
  currentProcessId: number
  startedAt: string
}

export interface RuntimeLogFilter extends RuntimeLogBoot {
  level: string
  source: string
  query: string
  onlyCurrentBoot: boolean
}

export const anyRuntimeLogValue = 'all'

// 条目 id 是 `${ISO 时间}:${pid}:${序号}`，而 ISO 时间自己就带冒号，
// 所以只能从尾部倒着取两段，不能 split(':') 按下标取。
const entryOrigin = /:(\d+):(\d+)$/

export function readEntryProcessId(id: string): number | null {
  const matched = entryOrigin.exec(id)
  if (!matched) return null
  const parsed = Number(matched[1])
  return Number.isInteger(parsed) ? parsed : null
}

export function isCurrentBootEntry(entry: RuntimeLogEntry, boot: RuntimeLogBoot): boolean {
  if (readEntryProcessId(entry.id) !== boot.currentProcessId) return false
  // 操作系统会复用 pid：上一次运行留在磁盘上的条目可能正好撞上同一个号，
  // 再比一次时间才能把它们排除掉。时间读不出来时宁可少显示，也不要把
  // 上一次运行的条目混进「本次启动」。
  const startedAt = Date.parse(boot.startedAt)
  if (!Number.isFinite(startedAt)) return true
  const timestamp = Date.parse(entry.timestamp)
  return Number.isFinite(timestamp) && timestamp >= startedAt
}

export function filterRuntimeLogs(
  entries: readonly RuntimeLogEntry[],
  filter: RuntimeLogFilter,
): RuntimeLogEntry[] {
  const query = filter.query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (filter.level !== anyRuntimeLogValue && entry.level !== filter.level) return false
    if (filter.source !== anyRuntimeLogValue && entry.source !== filter.source) return false
    if (filter.onlyCurrentBoot && !isCurrentBootEntry(entry, filter)) return false
    if (!query) return true
    return `${entry.message} ${entry.source} ${entry.event}`.toLowerCase().includes(query)
  })
}

export function hasRuntimeLogFilter(filter: RuntimeLogFilter): boolean {
  return filter.level !== anyRuntimeLogValue
    || filter.source !== anyRuntimeLogValue
    || filter.onlyCurrentBoot
    || filter.query.trim() !== ''
}

export function runtimeLogSourceOptions(
  sources: readonly string[] | undefined,
  selected: string,
): Array<{ value: string; label: string }> {
  const listed = [...new Set(sources ?? [])]
  // 选中的来源可能已经被日志轮转挤掉，下拉里没有它时 select 会跳回第一项，
  // 用户看到的筛选结果和下拉显示的就对不上了。
  if (selected !== anyRuntimeLogValue && !listed.includes(selected)) listed.push(selected)
  return [
    { value: anyRuntimeLogValue, label: '全部来源' },
    ...listed.map((source) => ({ value: source, label: source })),
  ]
}

// 与主进程 captureFeedbackReport 的单行格式一致：客服收到的整份报告和用户
// 单独复制的一条长得一样，比对时不用换个格式重读。
export function formatRuntimeLogEntry(entry: RuntimeLogEntry): string {
  const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : ''
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}/${entry.event}] ${entry.message}${detail}`
}

export interface RuntimeLogWriteNotice {
  title: string
  body: string
}

/**
 * 日志写不进文件时反馈页顶上那一句。以前这件事完全静默：日志页是空的，导出的
 * 报告也是空的，用户和客服都不知道为什么。没失败时返回 null，页面不出这条。
 */
export function runtimeLogWriteNotice(
  failure: RuntimeLogSnapshot['writeFailure'] | undefined,
): RuntimeLogWriteNotice | null {
  if (!failure || failure.lostEntries <= 0) return null
  return {
    title: '日志没能保存下来',
    body: `这次打开软件后有 ${failure.lostEntries} 条日志没写进日志文件（${failure.reason}）。`
      + '它们暂时留在软件里，下面照样能看，导出反馈报告时也会带上，但关掉软件就没了。'
      + '可以去「检查」页看看是不是有文件夹被搬到了别的位置。',
  }
}
