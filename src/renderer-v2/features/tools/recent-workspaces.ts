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
  /** null = 「选择其他目录…」，走原来的目录选择器；带 create 时是「新建项目文件夹」。 */
  path: string | null
  label: string
  /** 不选目录，由主进程在「文档」下替用户建一个空的项目文件夹再打开。 */
  create?: true
}

/** 首页与引导里「新建项目文件夹」入口的统一文案。 */
export const newWorkspaceLabel = '新建项目文件夹并打开'

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

/**
 * 下拉里的条目：最近用过的目录，最后永远留「选择其他目录…」和「新建项目文件夹」。
 * 后者给不知道该选哪个文件夹的新手，一步到位，不用再起名、再选。
 */
export function workspaceChoices(items: readonly RecentWorkspace[]): WorkspaceChoice[] {
  return [
    ...items.map((item) => ({ path: item.path, label: item.path })),
    { path: null, label: '选择其他目录…' },
    { path: null, label: newWorkspaceLabel, create: true },
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

/**
 * 「接着上次对话」用的续接参数（claude --continue 一类）是 CLI 自己按工作目录
 * 找最近一条,不按会话 id 挑。所以这颗按钮只能长在每个(工具 × 目录)组合里最近
 * 的那一条记录上,否则用户点第三条、接上的却是第一条。
 *
 * 会话列表是全局按时间倒序排的(provider-sessions.ts 的 list),所以在一份按这个
 * 顺序给出的记录里,某个组合第一次出现的那条就是它最近的一条。传进来的记录不全
 * 时(分页、条数超过一次能取的上限),没被覆盖到的组合一个按钮都不给——宁可少给,
 * 也不能给一颗点下去接到别处的按钮。
 *
 * 归档的记录不算(#497):CLI 续接时只在还没归档的会话里找最近一条(codex resume
 * --last 就是这样),归档项本身也不给按钮。让它占着「最近」的位置,同目录里较旧、
 * 其实能接上的那条就一颗按钮都没有了。
 */
export function latestSessionIdsByWorkspace(
  sessions: readonly SessionSummary[],
): Set<string> {
  const seen = new Set<string>()
  const latest = new Set<string>()
  for (const session of sessions) {
    if (session.archived) continue
    const path = session.cwd.trim()
    if (path === '') continue
    // 与 recentWorkspaces 同一条理由:Windows 路径大小写不敏感。
    const key = `${session.provider}\u0000${path.toLocaleLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    latest.add(session.id)
  }
  return latest
}
