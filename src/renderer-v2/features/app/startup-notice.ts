import { codexPayloadRestartHintTitle, describeToolRouteRestartHint, offersToolRouteDesktopRestart, toolRouteRestartHintTitle, type CodexPayloadNotice, type CodexPayloadNoticeKind, type ToolRouteRestartHint } from '../../../../electron/running-tools'
import type { AppSettingsV2, InstalledRelease, PlatformCapabilities, ProviderId, SettingsSaveIssue, UnexpectedExitNotice, WindowCapabilities } from '../../../../electron/ipc-contract'
import type { PageId } from '../../registry/pages'
import { tools } from '../../registry/tools'
import type { Tone } from '../../ui'
import type { SupportFailure } from './SupportIdentity'
import { firstProblemAnchor } from './row-focus'

/**
 * 启动时应用自己跑的后台检查。用户没有点任何东西，所以它们的坏消息不许挡路：
 * 一个模态框盖在欢迎页上，新客户第一次打开、网络还没配好时什么都点不了
 * （CI 的原生冒烟正是这样被挡住的）。用户自己点「检查更新」「运行检查」时
 * 走的是各页面自己的失败提示，不经过这里，照常报错。
 */
export type StartupCheckId = 'update' | 'diagnostics' | 'appearance' | 'vault-recovered' | 'updated' | 'settings-save' | 'display-compat' | 'display-relaunch' | 'crash-reporting' | 'usage-stats' | 'unexpected-exit' | 'template-filled' | 'claude-desktop-repaired' | 'route-restart' | 'codex-payload'
/**
 * `vault-recovered`、`updated`、`settings-save`、两条显示方式的提示与错误报告告知不是应用
 * 跑出来的检查，是一次性要告诉用户的事，没有「失败」这一面。
 */
export type StartupCheckFailureId = Exclude<StartupCheckId, 'vault-recovered' | 'updated' | 'settings-save' | 'display-compat' | 'display-relaunch' | 'crash-reporting' | 'usage-stats' | 'unexpected-exit' | 'template-filled' | 'claude-desktop-repaired' | 'route-restart' | 'codex-payload'>

/**
 * 有的提示要把人带到某一页，有的要直接把登录弹出来（账号页在未登录时才等价于登录），
 * 有的只是告知一件事，按钮就是「知道了」。
 */
/** page 的 section：落到那一页里的哪一组或哪一行，同外壳的 navigate；缺省 = 只跳页。 */
export type StartupNoticeAction = { label: string; page: PageId; section?: string } | { label: string; login: true } | { label: string; dismiss: true }
  | { label: string; displayCompat: 'keep' | 'restore' } | { label: string; relaunch: true }
  | { label: string; crashReporting: 'keep' | 'off' } | { label: string; usageStats: 'keep' | 'off' } | { label: string; supportFailure: SupportFailure }
  | { label: string; restartCodexDesktop: true }

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
  /** 要用户二选一时的另一颗按钮。有它就不再放关闭叉：关掉等于没选。 */
  secondaryAction?: StartupNoticeAction
  /**
   * true = 新手引导或首页导览开着时先不出，都关了再出（见 startupNoticesShown）。给「登录进来说一次」
   * 这类不急着要客户动手的告知卡用；缺省 = 照旧马上出。
   */
  waitsForOnboarding?: boolean
}

const failureTitles: Record<StartupCheckFailureId, string> = {
  update: '更新检查未完成',
  diagnostics: '环境检查未完成',
  appearance: '系统外观同步失败',
}

/** 后端原话留在正文里：客服排查时要的是它，不是被归类后的标题（同失败对话框）。 */
export function startupCheckFailure(id: StartupCheckFailureId, detail: string): StartupNotice {
  return {
    id,
    failure: true,
    tone: 'warn',
    title: failureTitles[id],
    body: detail,
    ...(id === 'update' ? { action: { label: '查看更新', page: 'settings', section: 'version' } } : {}),
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

/** 检查页「待处理」的项数；状态栏最左那项和开机那条提示都按这个数。 */
export function diagnosticsIssueCount(counts: StartupDiagnosticsCounts): number {
  return countOf(counts.fail) + countOf(counts.error)
}

/**
 * 只有「待处理」（fail / error）才值得在开机时说一句。「需留意」（warn）里多半是
 * 用不到的东西没装：另外几家 CLI、Codex 桌面端、Python、Git。把它们数进去，只用
 * 一家工具的客户每次开机都会看到「N 项需要处理」，点进去发现没事，久了就不看了，
 * 真有待处理的时候反而被当成噪音。所以只有 warn 时不说话（检查页照旧标黄），
 * 和待处理一起出现时只在正文里轻带一句。
 */
export function startupDiagnosticsIssues(counts: StartupDiagnosticsCounts): StartupNotice | null {
  const issues = diagnosticsIssueCount(counts)
  if (issues < 1) return null
  const warnings = countOf(counts.warn)
  return {
    id: 'diagnostics',
    failure: false,
    tone: 'warn',
    title: `环境检查发现 ${issues} 项需要处理`,
    body: warnings
      ? `不影响使用，建议前往「检查」页查看。另有 ${warnings} 项建议关注。`
      : '不影响使用，建议前往「检查」页查看。',
    // 检查页把有问题的排在最前；从这里点进去再翻到第一项问题，免得落在上次看到的位置。
    action: { label: '立即查看', page: 'health', section: firstProblemAnchor },
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
    body: '本机保存的登录信息无法读取，已重新创建。之前保存的账号需重新登录，已写入各工具的配置不受影响。',
    action: { label: '前往登录', login: true },
  }
}

const UPDATED_NOTICE_ITEMS = 3
const UPDATED_NOTICE_ITEM_LENGTH = 36

/**
 * 一条改动在角落卡片里只留开头那句：release-notes 的写法是「做了什么：为什么/细节」，
 * 冒号或句号之前那半句就是用户要的那件事；还太长就截断，完整的在「设置 › 版本更新」里。
 */
export function releaseNoteHeadline(note: string): string {
  const cut = note.search(/[：:。；;]/)
  const headline = (cut > 0 ? note.slice(0, cut) : note).trim().replace(/[，,、]+$/, '')
  return headline.length > UPDATED_NOTICE_ITEM_LENGTH ? `${headline.slice(0, UPDATED_NOTICE_ITEM_LENGTH - 1)}…` : headline
}

/**
 * 更新装完后的第一次启动：软件消失又出现，界面和之前一模一样，不说一句用户就只能
 * 再去点一次「检查更新」确认自己在不在新版上。挂在角落、不挡操作，不让用户做任何选择；
 * 只列最前面几项改动的开头那句，不再加一句引导语（字越少卡片越矮，越不挡首页）。没列全时
 * 旁边多一颗「看全部改动」去「设置 › 版本更新」（随包带的，断网也在）。不是更新后第一次启动时返回 null。
 */
export function updatedNotice(currentVersion: string, release: InstalledRelease | null | undefined): StartupNotice | null {
  if (!release?.justUpdated || !currentVersion) return null
  const notes = release.notes ?? []
  const items = notes.slice(0, UPDATED_NOTICE_ITEMS).map(releaseNoteHeadline).filter(Boolean)
  const rest = notes.length - items.length
  return {
    id: 'updated',
    failure: false,
    tone: 'ok',
    title: `已更新到 ${currentVersion}`,
    body: items.length === 0 ? '已更新至新版本。' : '',
    ...(items.length > 0 ? { items } : {}),
    action: { label: '知道了', dismiss: true },
    ...(items.length > 0 && rest > 0 ? { secondaryAction: { label: '查看全部改动', page: 'settings', section: 'version' } } : {}),
  }
}

/**
 * 启动时设置没写进去，但软件照常打开了（以前这种情况直接打不开）。只说用户能做的
 * 那件事；「磁盘」「杀毒软件」是用户听得懂的词，文件名、错误原文不上屏，原文在运行日志里。
 */
export function settingsSaveNotice(issue: SettingsSaveIssue | null | undefined): StartupNotice | null {
  if (!issue) return null
  // 盘符是字母，前后跟汉字隔一个空格（「请清理 C 盘」）；句首那处去掉前导空格。没有盘符写「磁盘」，不加空格。
  const drive = issue.drive && /^[A-Z]$/.test(issue.drive) ? ` ${issue.drive} 盘` : '磁盘'
  const body = issue.kind === 'disk-full'
    ? `${drive.trimStart()}空间即将不足，部分设置可能无法保存。请清理${drive}（如清空回收站、删除不需要的大文件）后重新打开软件。`
    : issue.kind === 'blocked'
      ? '设置文件被其他程序（通常为杀毒软件）拦截，部分设置可能无法保存。请将星芒AI管理工具加入杀毒软件信任名单后重新打开软件。'
      : '本次启动时设置保存失败，部分设置可能需重新选择。重新打开软件通常可以解决。'
  return {
    id: 'settings-save',
    failure: false,
    tone: 'warn',
    title: '部分设置可能无法保存',
    body,
    action: { label: '知道了', dismiss: true },
  }
}

/**
 * 显卡接连崩溃后这次自动换成了兼容方式显示。不说一句，用户只会觉得界面变慢了；
 * 也不替他定死，让他选以后一直这样还是改回去。只用「显卡」「显示」这种说法。
 */
export function displayCompatNotice(capabilities: Pick<WindowCapabilities, 'displayCompat'> | null | undefined): StartupNotice | null {
  if (capabilities?.displayCompat !== 'auto') return null
  return {
    id: 'display-compat',
    failure: false,
    tone: 'warn',
    title: '已改用兼容方式显示界面',
    body: '检测到显卡驱动不稳定，已多次出现异常。星芒已切换为兼容显示模式，部分动画可能变慢。请选择今后的显示方式：',
    action: { label: '一直用兼容方式', displayCompat: 'keep' },
    secondaryAction: { label: '恢复原来的方式', displayCompat: 'restore' },
  }
}

/** 显示方式要重开软件才生效：给一颗现成的「现在重开」，不让用户自己去找退出。 */
export function displayRelaunchNotice(): StartupNotice {
  return {
    id: 'display-relaunch',
    failure: false,
    tone: 'neutral',
    title: '重开软件后生效',
    body: '显示方式已修改，重新打开星芒后生效。',
    action: { label: '现在重开', relaunch: true },
    secondaryAction: { label: '稍后', dismiss: true },
  }
}

/**
 * 出错或卡住时（卡住是 #1971 起）会自动把错误报告发到海外，这件事以前只写在设置页的一行开关旁边，没人主动
 * 说过。登录进来后说一次：缺省照旧开着（告知不等于改缺省），给一颗「不想发送」当场
 * 关掉。不写服务名，用户要知道的是「发去海外、能关」。已经关掉的人不用再告诉他。
 */
export function crashReportingNotice(settings: Pick<AppSettingsV2, 'crashReporting' | 'crashReportingNoticeShown'> | null | undefined, authenticated: boolean): StartupNotice | null {
  if (!authenticated || !settings || settings.crashReportingNoticeShown === true || settings.crashReporting === false) return null
  return {
    id: 'crash-reporting',
    failure: false,
    tone: 'neutral',
    title: '软件出错或无响应时将发送错误报告',
    body: '软件出错或无响应时，将自动向海外错误收集服务发送错误报告，以便尽快修复问题。报告不包含账号、密钥、文件路径和聊天内容。可随时在「设置 › 隐私数据」中关闭。',
    action: { label: '知道了', crashReporting: 'keep' },
    secondaryAction: { label: '不想发送', crashReporting: 'off' },
    waitsForOnboarding: true,
  }
}

/**
 * 匿名使用统计（主进程 usage-stats.ts）缺省开着，登录进来后说一次，给一颗「不想发送」当场关掉，
 * 和崩溃上报那张同一个做法。错误报告那张还没说过时先出那张，这张等它说过以后（useStartupChecks
 * 另管「这次打开已经出过那张就等下次」）。enabled 是设置里那个开关现在的值，读不到（null）就不说：
 * 说了也没法当场关。
 */
export function usageStatsNotice(
  settings: Pick<AppSettingsV2, 'crashReporting' | 'crashReportingNoticeShown' | 'usageStatsNoticeShown'> | null | undefined,
  authenticated: boolean,
  enabled: boolean | null,
): StartupNotice | null {
  if (!authenticated || !settings || settings.usageStatsNoticeShown === true || enabled !== true) return null
  if (crashReportingNotice(settings, authenticated)) return null
  return {
    id: 'usage-stats',
    failure: false,
    tone: 'neutral',
    title: '软件将发送匿名使用数据',
    body: '每天最多发送一次，用于发现易出错的环节。仅发送版本、操作系统、已安装的工具及安装更新是否成功，不发送账号、密钥、文件和聊天内容，也无法识别具体设备。可在「设置 › 隐私数据」中关闭。',
    action: { label: '知道了', usageStats: 'keep' },
    secondaryAction: { label: '不想发送', usageStats: 'off' },
    waitsForOnboarding: true,
  }
}

function clockTime(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * 上次星芒自己意外退出了（主进程没接住的异常）。以前是一个英文报错框，现在自动重开一次，
 * 这里说一句发生了什么，并给「复制给客服」：客户答不上「出了什么错」，复制的内容里有。
 * 10 分钟内第二次时没有自动重开，换一种说法，复制的内容带上这几次。
 */
export function unexpectedExitNotice(capabilities: Pick<WindowCapabilities, 'unexpectedExit'> | null | undefined): StartupNotice | null {
  const notice: UnexpectedExitNotice | undefined = capabilities?.unexpectedExit
  const exits = notice?.exits.filter((exit) => Number.isFinite(exit.at) && exit.at > 0) ?? []
  if (!notice || exits.length === 0) return null
  const latest = new Date(exits[exits.length - 1].at)
  const supportFailure: SupportFailure = {
    at: latest,
    action: '星芒自己意外退出',
    message: notice.relaunched ? '已自动重新打开' : '10 分钟内再次退出，未自动重新打开',
    detail: exits.map((exit) => `${clockTime(new Date(exit.at))} ${exit.error}`).join('；'),
  }
  return {
    id: 'unexpected-exit',
    failure: false,
    tone: 'warn',
    title: notice.relaunched ? '星芒意外退出' : '星芒再次意外退出',
    body: notice.relaunched
      ? '星芒意外退出，已自动重新打开。错误信息已记录，请点击「复制给客服」并发送给客服。'
      : '星芒再次意外退出，未自动重新打开。请点击「复制给客服」，将相关信息发送给客服。',
    action: { label: '复制给客服', supportFailure },
    secondaryAction: { label: '知道了', dismiss: true },
  }
}

/**
 * 开机时给老配置补齐了新版设置（主进程 fillToolTemplateDefaults）。客户什么都没点，工具
 * 设置却变了，得说一句是什么、不影响什么、原来的在哪；只说一次，一颗「知道了」。没补任何
 * 工具时返回 null。
 */
export function toolTemplateFilledNotice(filled: readonly ProviderId[]): StartupNotice | null {
  // Codex 的这份设置命令行和桌面端共用，只说「Codex」。
  const names = tools.filter((tool) => tool.id !== 'codexDesktop' && filled.includes(tool.id))
    .map((tool) => tool.id === 'codex' ? 'Codex' : tool.name)
  if (names.length === 0) return null
  return {
    id: 'template-filled',
    failure: false,
    tone: 'ok',
    title: '工具设置已更新至最新',
    body: `已按新版本补全 ${names.join('、')} 的部分设置，运行更流畅。账号、密钥、对话及自定义设置均未改动，修改前的设置可在「设置 › 备份迁移」中恢复。`,
    action: { label: '知道了', dismiss: true },
  }
}

/**
 * 开机时把 0.2.12 写坏的 Claude Desktop 设置改回了客户选的那一个型号（主进程
 * claude-desktop-model-repair.ts）。客户什么都没点，得说一句改了什么、没动什么；正开着的
 * Claude Desktop 还拿着旧设置，要完全退出再打开才用上新的，和「保存配置」后的说法一样。
 * 看不出它开没开（Windows 上那要起进程查），所以按「开着的话」说。只说一次，一颗「知道了」。
 */
export function claudeDesktopRepairedNotice(
  capabilities: Pick<WindowCapabilities, 'claudeDesktopRepaired'> | null | undefined,
  platform: PlatformCapabilities['platform'] | null | undefined,
): StartupNotice | null {
  if (capabilities?.claudeDesktopRepaired !== true) return null
  const quit = platform === 'macos'
    ? '关闭窗口不等于退出，请按 ⌘Q'
    : platform === 'windows' ? '关闭窗口不等于退出，请同时退出屏幕右下角托盘中的 Claude 图标' : '关闭窗口不等于退出'
  return {
    id: 'claude-desktop-repaired',
    failure: false,
    tone: 'ok',
    title: 'Claude Desktop 设置已修复',
    body: `旧版本保存的设置可能导致 Claude Desktop 发送消息后无回复，现已恢复为您选择的模型，其他设置未改动。如 Claude Desktop 正在运行，请完全退出后重新打开（${quit}）。`,
    action: { label: '知道了', dismiss: true },
  }
}

/**
 * 连接线路因为连不上换了，开着的工具要重开才走新线路（xm 三线路 C10，主进程 followToolRoutes 定的
 * 要说哪几样、24 小时一次；历史账号是整份写入跟过去以后 noteRouteFollowRestart 定的，#1061 第 2 条）。一样一句；Codex 桌面端在 Windows 上开着时给现成的「帮我重开」，别的
 * 只能客户自己重开，关掉叉就行。Codex 有个对话在线路 1 上太大、换到线路 2 的（codex-payload-limit.ts）只换标题，
 * 下面照样是 Codex 那几句。
 */
export function toolRouteRestartNotice(hint: ToolRouteRestartHint): StartupNotice | null {
  const items = describeToolRouteRestartHint(hint)
  if (!items.length) return null
  return {
    id: 'route-restart',
    failure: false,
    tone: 'neutral',
    title: hint.cause === 'payload-too-large' ? codexPayloadRestartHintTitle : toolRouteRestartHintTitle,
    body: '',
    items,
    ...(offersToolRouteDesktopRestart(hint) ? { action: { label: '帮我重开', restartCodexDesktop: true as const } } : {}),
  }
}

const codexPayloadNewConversation = '请新建对话继续。截图和大文件会使对话体积快速增大；此时压缩对话同样无效，因为压缩也需上传完整对话。'
const codexPayloadReasons: Partial<Record<CodexPayloadNoticeKind, string>> = {
  locked: '设置中已选择仅使用线路1，因此未自动切换线路。',
  unreachable: '线路2 当前同样无法连接，未能自动切换。',
}

/**
 * Codex 有个对话太大、发不出去，又没换成线路（主进程 codex-payload-limit.ts）：要客户新开对话，说清为什么连压缩也
 * 不行、为什么没换线路。线路 1 上快到上限时提前说一次。都只是告知，一颗「知道了」。
 */
export function codexPayloadNotice(notice: CodexPayloadNotice): StartupNotice {
  const action = { label: '知道了', dismiss: true as const }
  if (notice.kind === 'nearing') {
    return {
      id: 'codex-payload',
      failure: false,
      tone: 'neutral',
      title: 'Codex 中有对话即将达到线路1 的上限',
      body: '对话超过 100MB 后将无法通过线路1 发送。建议完成当前任务后新建对话；截图和大文件会使体积快速增大。',
      action,
    }
  }
  if (notice.kind === 'too-large') {
    return {
      id: 'codex-payload',
      failure: false,
      tone: 'warn',
      title: 'Codex 对话体积过大，无法发送',
      body: `该对话已超过线路2 的上限，继续发送将失败。${codexPayloadNewConversation}`,
      action,
    }
  }
  return {
    id: 'codex-payload',
    failure: false,
    tone: 'warn',
    title: 'Codex 对话体积过大，无法通过线路1 发送',
    body: `该对话已超过 100MB，无法通过线路1 发送，继续发送将失败。${codexPayloadNewConversation}${codexPayloadReasons[notice.kind] ?? ''}`,
    action,
  }
}

/**
 * 第一次登录时新手引导、首页导览本身就占着一屏，告知卡再挤上来，客户不知道先看哪个，错误报告
 * 那张还正好盖住工具卡的按钮（主路卡点 F11）。标了 waitsForOnboarding 的先不摊出来，卡片仍留在
 * 那一摞里，引导和导览都关了再出。错误报告、使用统计这两张登录后说一次的告知卡标了它，以后再加
 * 同类的标上就跟着等。没标的照旧马上出：出了事要客户知道的不该被引导压着。
 */
export function startupNoticesShown(notices: readonly StartupNotice[], onboarding: boolean): readonly StartupNotice[] {
  return onboarding ? notices.filter((notice) => notice.waitsForOnboarding !== true) : notices
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
