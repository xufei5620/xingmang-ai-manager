import type { RuntimeLogSnapshot } from '../../../../electron/ipc-contract'
import { networkFailureMessages } from '../../../../electron/network-failure'

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

// 日志的 source / event 是给客服和开发看的（ipc、maintenance、account:balance…），
// 反馈页上要换成侧栏里那些用户认得的叫法。认不出来的归「其他」，列表上不显示。
export const otherRuntimeLogArea = '其他'

const runtimeLogAreaOrder = [
  '账号', '充值', '安装卸载', '外接工具', '插件', '技能', '工具设置', '加速', 'AI 对话', '画布',
  '记录', '备份', '检查', '更新', '设置', '反馈', '界面', '软件', '安全', otherRuntimeLogArea,
]

const sourceAreas: Record<string, string> = {
  account: '账号',
  payment: '充值',
  maintenance: '安装卸载',
  config: '工具设置',
  extensions: '插件',
  chat: 'AI 对话',
  'ai-chat': 'AI 对话',
  canvas: '画布',
  sessions: '记录',
  system: '检查',
  updater: '更新',
  renderer: '界面',
  main: '软件',
  window: '软件',
  security: '安全',
}

// source 为 ipc 的条目来自统一的 IPC 失败日志，event 是通道名（account:balance），
// 只能按通道前缀认出是哪一块。
const channelAreas: Record<string, string> = {
  acceleration: '加速',
  account: '账号',
  backups: '备份',
  canvas: '画布',
  chat: 'AI 对话',
  models: 'AI 对话',
  cli: '安装卸载',
  desktop: '安装卸载',
  runtime: '安装卸载',
  setup: '安装卸载',
  config: '工具设置',
  workspace: '工具设置',
  'external-clients': '外接工具',
  mcp: '外接工具',
  extensions: '插件',
  marketplaces: '插件',
  plugins: '插件',
  skills: '技能',
  sessions: '记录',
  'provider-sessions': '记录',
  system: '检查',
  update: '更新',
  settings: '设置',
  diagnostics: '反馈',
  exports: '反馈',
  'runtime-logs': '反馈',
  window: '软件',
  startup: '软件',
}

export function runtimeLogArea(entry: Pick<RuntimeLogEntry, 'source' | 'event'>): string {
  if (entry.event.startsWith('acceleration.')) return '加速'
  if (entry.source === 'ipc') {
    const prefix = entry.event.split(':', 1)[0]
    return Object.hasOwn(channelAreas, prefix) ? channelAreas[prefix] : otherRuntimeLogArea
  }
  return Object.hasOwn(sourceAreas, entry.source) ? sourceAreas[entry.source] : otherRuntimeLogArea
}

/** 列表行上显示的来源；认不出来的返回 null，行上就不写。 */
export function runtimeLogAreaLabel(entry: Pick<RuntimeLogEntry, 'source' | 'event'>): string | null {
  const area = runtimeLogArea(entry)
  return area === otherRuntimeLogArea ? null : area
}

/**
 * 网络类失败的文案是「一句大白话（排查用的现场）」，比如
 * 「连接账号服务超时，请检查网络后再试。（账号余额查询请求超时）」。括号里那半句
 * 跟前面说的是同一件事，列表上去掉，原文仍在「详情」里。
 */
export function runtimeLogDisplayMessage(message: string): string {
  for (const friendly of Object.values(networkFailureMessages)) {
    const at = message.indexOf(`${friendly}（`)
    if (at < 0) continue
    const end = at + friendly.length
    if (message.endsWith('）')) return message.slice(0, end)
  }
  return message
}

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
    if (filter.source !== anyRuntimeLogValue && runtimeLogArea(entry) !== filter.source) return false
    if (filter.onlyCurrentBoot && !isCurrentBootEntry(entry, filter)) return false
    if (!query) return true
    return `${entry.message} ${runtimeLogArea(entry)} ${entry.source} ${entry.event}`.toLowerCase().includes(query)
  })
}

export function hasRuntimeLogFilter(filter: RuntimeLogFilter): boolean {
  return filter.level !== anyRuntimeLogValue
    || filter.source !== anyRuntimeLogValue
    || filter.onlyCurrentBoot
    || filter.query.trim() !== ''
}

export function runtimeLogSourceOptions(
  entries: readonly RuntimeLogEntry[] | undefined,
  selected: string,
): Array<{ value: string; label: string }> {
  const listed = new Set((entries ?? []).map(runtimeLogArea))
  // 选中的来源可能已经被日志轮转挤掉，下拉里没有它时 select 会跳回第一项，
  // 用户看到的筛选结果和下拉显示的就对不上了。
  if (selected !== anyRuntimeLogValue) listed.add(selected)
  const ordered = runtimeLogAreaOrder.filter((area) => listed.has(area))
  const unordered = [...listed].filter((area) => !runtimeLogAreaOrder.includes(area))
  return [
    { value: anyRuntimeLogValue, label: '全部来源' },
    ...[...ordered, ...unordered].map((area) => ({ value: area, label: area })),
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
