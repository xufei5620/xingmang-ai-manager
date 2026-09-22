import type { PageId } from '../../registry/pages'
import type { Tone } from '../../ui'

/**
 * 启动时应用自己跑的后台检查。用户没有点任何东西，所以它们的坏消息不许挡路：
 * 一个模态框盖在欢迎页上，新客户第一次打开、网络还没配好时什么都点不了
 * （CI 的原生冒烟正是这样被挡住的）。用户自己点「检查更新」「运行检查」时
 * 走的是各页面自己的失败提示，不经过这里，照常报错。
 */
export type StartupCheckId = 'update' | 'diagnostics' | 'appearance' | 'vault-recovered'
/** `vault-recovered` 不是应用跑出来的检查，是主进程报上来的一次性事实，没有「失败」这一面。 */
export type StartupCheckFailureId = Exclude<StartupCheckId, 'vault-recovered'>

/** 有的提示要把人带到某一页，有的要直接把登录弹出来（账号页在未登录时才等价于登录）。 */
export type StartupNoticeAction = { label: string; page: PageId } | { label: string; login: true }

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

/** 启动检查只看这三档；`pass` 不用数。 */
export interface StartupDiagnosticsCounts {
  warn: number
  fail: number
  error: number
}

function countOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 只有「待处理」（fail / error）才值得在开机时说一句。「需留意」（warn）里多半是
 * 用不到的东西没装：另外几家 CLI、Codex 桌面端、Python、Git。把它们数进去，只用
 * 一家工具的客户每次开机都会看到「N 项需要处理」，点进去发现没事，久了就不看了，
 * 真有待处理的时候反而被当成噪音。所以只有 warn 时不说话（检查页照旧标黄），
 * 和待处理一起出现时只在正文里轻带一句。
 */
export function startupDiagnosticsIssues(counts: StartupDiagnosticsCounts): StartupNotice | null {
  const issues = countOf(counts.fail) + countOf(counts.error)
  if (issues < 1) return null
  const warnings = countOf(counts.warn)
  return {
    id: 'diagnostics',
    failure: false,
    tone: 'warn',
    title: `环境检查发现 ${issues} 项需要处理`,
    body: warnings
      ? `不影响继续使用，有空时到「检查」页看一下就行。另有 ${warnings} 项可留意。`
      : '不影响继续使用，有空时到「检查」页看一下就行。',
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
