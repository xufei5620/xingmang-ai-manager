import type { MultiProviderSessionPage } from '../../../../electron/ipc-contract'
import { tools } from '../../registry/tools'
import { workspaceName } from './recent-workspaces'

type SessionSummary = MultiProviderSessionPage['items'][number]

function pad(value: number): string { return String(value).padStart(2, '0') }

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 首页「最近」右边那一格的时间。以前只写「14:05」，三天前的对话看着像今天的，
 * 所以按本机日历写清是哪天：今天、昨天、今年的几月几日、往年带上年份。
 * updatedAt 是秒；now 是毫秒，方便测试注入。
 */
export function formatRecentTime(updatedAt: number | null, now: number): string {
  if (updatedAt === null || !Number.isFinite(updatedAt)) return '时间未记录'
  const date = new Date(updatedAt * 1000)
  if (!Number.isFinite(date.getTime())) return '时间未记录'
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

/** 这条记录是哪个工具的，用的是工具行上同一个名字。 */
export function recentToolName(provider: SessionSummary['provider']): string {
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}

/** 「Codex CLI · my-project」。完整路径太长，窄窗口里文件夹名反而被截掉，放进小提示。 */
export function recentSessionSubtitle(session: Pick<SessionSummary, 'provider' | 'cwd'>): string {
  const name = recentToolName(session.provider)
  const folder = session.cwd ? workspaceName(session.cwd) : ''
  return folder ? `${name} · ${folder}` : name
}

/** 「接着聊」的小提示：写明会用哪个工具打开，免得点下去开的不是想的那个。 */
export function recentResumeHint(session: Pick<SessionSummary, 'provider' | 'cwd' | 'cwdExists'>): string {
  if (session.cwdExists === false) return '这个文件夹已经不在了，接不上上次的对话'
  const folder = session.cwd ? workspaceName(session.cwd) : '这个文件夹'
  return `用 ${recentToolName(session.provider)} 接着 ${folder} 里最近的一条对话`
}
