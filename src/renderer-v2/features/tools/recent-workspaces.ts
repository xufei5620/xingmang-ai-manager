import type { MultiProviderSessionPage, ProviderId } from '../../../../electron/ipc-contract'
import { rawErrorMessage } from '../../business-common'

type SessionSummary = MultiProviderSessionPage['items'][number]

/** 首页「打开」按钮记住的一个目录。 */
export interface RecentWorkspace {
  /** 目录绝对路径，交给主进程启动时用的就是它。 */
  path: string
  /** 目录名（路径最后一段），显示给用户看。 */
  name: string
}

/** 「打开」旁边那个下拉里的一项。 */
export interface WorkspaceChoice {
  /** null = 「选择其他目录…」，走原来的目录选择器。 */
  path: string | null
  label: string
}

/** 下拉里最多放几个目录。再多用户也不会一个个看完。 */
const RECENT_LIMIT = 5

/** 主按钮上目录名最多显示几个字符，超了截断，完整路径留在 title 里。 */
const NAME_LIMIT = 10

export function workspaceName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/)
  return segments[segments.length - 1] || trimmed || path.trim()
}

/**
 * 从已有的会话记录里推出某个工具最近用过的目录。不新增任何持久化：
 * 会话记录本来就存了 cwd，首页「最近」卡已经在显示它。
 */
export function recentWorkspaces(
  sessions: readonly SessionSummary[],
  provider: ProviderId,
  limit = RECENT_LIMIT,
): RecentWorkspace[] {
  const picked = new Map<string, RecentWorkspace>()
  const ordered = sessions
    .filter((session) => session.provider === provider && session.cwd.trim() !== '')
    .slice()
    .sort((left, right) => (
      (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0)
    ))
  for (const session of ordered) {
    const path = session.cwd.trim()
    // Windows 路径大小写不敏感，同一个目录的两种写法不该各占一格；
    // 留下最近一次用过的那种写法给用户看。
    const key = path.toLocaleLowerCase()
    if (picked.has(key)) continue
    picked.set(key, { path, name: workspaceName(path) })
    if (picked.size >= limit) break
  }
  return [...picked.values()]
}

/** 下拉里的条目：最近用过的目录，最后永远留一项「选择其他目录…」。 */
export function workspaceChoices(items: readonly RecentWorkspace[]): WorkspaceChoice[] {
  return [
    ...items.map((item) => ({ path: item.path, label: item.path })),
    { path: null, label: '选择其他目录…' },
  ]
}

/** 主按钮上的文字。目录名太长时截断，鼠标停上去还能看到完整路径。 */
export function workspaceButtonLabel(name: string, limit = NAME_LIMIT): string {
  return name.length > limit ? `${name.slice(0, limit)}…` : name
}

/**
 * 记住的目录可能已经被删掉或改名。主进程在这种情况下抛的是一条固定的中文错误，
 * 认出它就退回目录选择器，而不是把一条错误丢给用户——用户点了「打开」，
 * 得到的应该是一个能继续往下走的界面。
 */
export function isMissingWorkspace(cause: unknown): boolean {
  return rawErrorMessage(cause).includes('工作目录不存在')
}
