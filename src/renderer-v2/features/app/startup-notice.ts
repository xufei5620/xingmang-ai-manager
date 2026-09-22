import type { InstalledRelease } from '../../../../electron/ipc-contract'
import type { PageId } from '../../registry/pages'
import type { Tone } from '../../ui'

/**
 * 启动时应用自己跑的后台检查。用户没有点任何东西，所以它们的坏消息不许挡路：
 * 一个模态框盖在欢迎页上，新客户第一次打开、网络还没配好时什么都点不了
 * （CI 的原生冒烟正是这样被挡住的）。用户自己点「检查更新」「运行检查」时
 * 走的是各页面自己的失败提示，不经过这里，照常报错。
 */
export type StartupCheckId = 'update' | 'diagnostics' | 'appearance' | 'vault-recovered' | 'updated'
/**
 * `vault-recovered` 与 `updated` 不是应用跑出来的检查，是主进程报上来的一次性事实，
 * 没有「失败」这一面。
 */
export type StartupCheckFailureId = Exclude<StartupCheckId, 'vault-recovered' | 'updated'>

/**
 * 有的提示要把人带到某一页，有的要直接把登录弹出来（账号页在未登录时才等价于登录），
 * 有的只是告知一件事，按钮就是「知道了」。
 */
export type StartupNoticeAction = { label: string; page: PageId } | { label: string; login: true } | { label: string; dismiss: true }

export interface StartupNotice {
  id: StartupCheckId
  /**
   * true = 检查本身没跑完（要写进运行日志）；false = 检查跑完了，只是结论
   * 需要用户有空时看一眼，那不是失败，不该记成错误。
   */
  failure: boolean
  tone: Tone
  title: string
  body: string
  /** 正文下面逐条列出的几项，短句。 */
  items?: readonly string[]
  action?: StartupNoticeAction
}

const failureTitles: Record<StartupCheckFailureId, string> = {
  update: '更新检查没有完成',
  diagnostics: '环境检查没有完成',
  appearance: '系统外观没有同步',
}

/** 后端原话留在正文里：客服排查时要的是它，不是被归类后的标题（同失败对话框）。 */
export function startupCheckFailure(id: StartupCheckFailureId, detail: string): StartupNotice {
  return {
    id,
    failure: true,
    tone: 'warn',
    title: failureTitles[id],
    body: detail,
    ...(id === 'update' ? { action: { label: '查看更新', page: 'updates' } } : {}),
  }
}

/** 0 项时返回 null：没有需要处理的东西就什么都不说。 */
export function startupDiagnosticsIssues(issues: number): StartupNotice | null {
  if (!Number.isFinite(issues) || issues < 1) return null
  return {
    id: 'diagnostics',
    failure: false,
    tone: 'warn',
    title: `环境检查发现 ${issues} 项需要处理`,
    body: '不影响继续使用，有空时到「检查」页看一下就行。',
    action: { label: '去看看', page: 'health' },
  }
}

/**
 * 本机的账号存储解密不了、被重建时说清楚为什么：用户看到的症状是「记住的账号
 * 没了」，不解释他只会以为账号被删了。备份文件名不上屏（I13），也不提站点名
 * （#148），主语是「本机」。主进程一次启动只发一条，所以这里也只会出现一次。
 */
export function vaultRecoveredNotice(): StartupNotice {
  return {
    id: 'vault-recovered',
    failure: false,
    tone: 'warn',
    title: '本机保存的登录信息已重置，请重新登录',
    body: '这台电脑上保存的登录信息已经读不出来，应用已重新建立它。之前记住的账号需要各自重新登录一次，已经写进各个工具的配置不受影响。',
    action: { label: '去登录', login: true },
  }
}

const UPDATED_NOTICE_ITEMS = 3
const UPDATED_NOTICE_ITEM_LENGTH = 36

/**
 * 一条改动在角落卡片里只留开头那句：release-notes 的写法是「做了什么：为什么/细节」，
 * 冒号或句号之前那半句就是用户要的那件事；还太长就截断，完整的在更新页。
 */
export function releaseNoteHeadline(note: string): string {
  const cut = note.search(/[：:。；;]/)
  const headline = (cut > 0 ? note.slice(0, cut) : note).trim().replace(/[，,、]+$/, '')
  return headline.length > UPDATED_NOTICE_ITEM_LENGTH ? `${headline.slice(0, UPDATED_NOTICE_ITEM_LENGTH - 1)}…` : headline
}

/**
 * 更新装完后的第一次启动：软件消失又出现，界面和之前一模一样，不说一句用户就只能
 * 再去点一次「检查更新」确认自己在不在新版上。挂在角落、不挡操作，只有一颗「知道了」，
 * 不让用户做任何选择；列最前面几项改动的开头那句，完整清单在更新页（随包带的，断网
 * 也在）。不是更新后第一次启动时返回 null。
 */
export function updatedNotice(currentVersion: string, release: InstalledRelease | null | undefined): StartupNotice | null {
  if (!release?.justUpdated || !currentVersion) return null
  const notes = release.notes ?? []
  const items = notes.slice(0, UPDATED_NOTICE_ITEMS).map(releaseNoteHeadline).filter(Boolean)
  const rest = notes.length - items.length
  const body = items.length === 0
    ? '已经在用新版本了，可以照常使用。'
    : rest > 0 ? `这一版的主要改动如下，另外 ${rest} 项在「更新」页可以看到。` : '这一版的改动：'
  return {
    id: 'updated',
    failure: false,
    tone: 'ok',
    title: `已更新到 ${currentVersion}`,
    body,
    ...(items.length > 0 ? { items } : {}),
    action: { label: '知道了', dismiss: true },
  }
}

/** 同一个检查只留最新一条，否则重试几次就堆成一叠说同一件事的提示。 */
export function withStartupNotice(current: readonly StartupNotice[], notice: StartupNotice): StartupNotice[] {
  return [...current.filter((entry) => entry.id !== notice.id), notice]
}

export function withoutStartupNotice(current: readonly StartupNotice[], id: StartupCheckId): StartupNotice[] {
  return current.filter((entry) => entry.id !== id)
}

/** 运行日志里认得出是哪一次启动检查，而不是只留一句「请求失败」。 */
export function startupCheckLogContext(id: StartupCheckId): string {
  return `renderer-v2 startup check: ${id}`
}
