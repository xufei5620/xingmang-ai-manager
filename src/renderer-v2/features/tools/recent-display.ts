import type { MultiProviderSessionPage } from '../../../../electron/ipc-contract'
import { tools } from '../../registry/tools'
import { workspaceName } from './recent-workspaces'
import { formatCalendarTime } from '../../calendar-time'

type SessionSummary = MultiProviderSessionPage['items'][number]

/**
 * 首页「最近」右边那一格的时间。以前只写「14:05」，三天前的对话看着像今天的，
 * 所以按本机日历写清是哪天（写法见 formatCalendarTime）。
 * updatedAt 是秒；now 是毫秒，方便测试注入。
 */
export function formatRecentTime(updatedAt: number | null, now: number): string {
  if (updatedAt === null || !Number.isFinite(updatedAt)) return '时间未记录'
  return formatCalendarTime(updatedAt * 1000, now) ?? '时间未记录'
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
