import type { PageId } from '../../registry/pages'
import type { Tone } from '../../ui'

/**
 * 启动时应用自己跑的后台检查。用户没有点任何东西，所以它们的坏消息不许挡路：
 * 一个模态框盖在欢迎页上，新客户第一次打开、网络还没配好时什么都点不了
 * （CI 的原生冒烟正是这样被挡住的）。用户自己点「检查更新」「运行检查」时
 * 走的是各页面自己的失败提示，不经过这里，照常报错。
 */
export type StartupCheckId = 'update' | 'diagnostics' | 'appearance'

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
  action?: { label: string; page: PageId }
}

const failureTitles: Record<StartupCheckId, string> = {
  update: '更新检查没有完成',
  diagnostics: '环境检查没有完成',
  appearance: '系统外观没有同步',
}

/** 后端原话留在正文里：客服排查时要的是它，不是被归类后的标题（同失败对话框）。 */
export function startupCheckFailure(id: StartupCheckId, detail: string): StartupNotice {
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
