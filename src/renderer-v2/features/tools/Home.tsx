import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, BookOpen, Check, ChevronRight, Download, FolderOpen, Info, MessageSquare, Play, Plug, Plus, RefreshCw, RotateCcw, TriangleAlert, X, Zap } from 'lucide-react'
import type { AccountBalance, AccountProfile, AccountSourceTarget, ExternalClientStatus, ExternalToolId, MultiProviderSessionPage, OfficialChatGptAccount, ProviderId, WindowsRestartResult } from '../../../../electron/ipc-contract'
import { presentExternalClients } from './external-model'
import { desktopUpdateFailedLine, externalUpdateTarget, type DesktopUpdateTool } from './desktop-update'
import { useSharedBalanceSelector, useSharedBalanceStore } from '../app/balance-context'
import { sameFlatRecord, subscribeBalanceReads } from '../app/balance-store'
import { balanceStatusText } from '../shell/balance-status'
import { BrandIcon, Button, Card, ListRow, PageHead, Pill, Progress, Skeleton, ToolCard, toastDurationMs, useToast, type MenuItem, type MenuNote } from '../../ui'
import { accountSwitchTarget, cliHooksMissing, cliHooksNeedRepair, cliHooksWereAutoRepaired, brokenConfigDetails, brokenConfigOf, codexNeedsRepair, readyOnceRepaired, subscriptionWarning, canUninstallTool, ccSwitchLeftoverFor, foreignKeyKind, configDirectoryMenuItem, externalInstallHint, greeting, isUnrecognizedInstall, needsManualInstall, officialAccountSubtitle, ownershipAwaitingAccount, presentTools, providerFor, recommendedVersionVerb, revertVersion, rollbackVersion, spacedName, toolUpdateOffer, updateButtonHint, updatesOutsideApp, type ToolboxSnapshot, type ToolId, type ToolPresentation } from './model'
import type { BalanceUsage, ToolboxPartitionFailure, ToolsApi } from './api'
import type { ToolJob } from './useToolbox'
import { accountKeyChangeInProgress, accountKeyChangePending, bootstrapOnlyFollowedRoute, type AccountBootstrapProgress, type AccountBootstrapResult } from './account-bootstrap'
import type { PageId } from '../../registry/pages'
import { macDesktopTutorialTopic, macRuntimeTutorialTopic, otherAppsAnchor } from '../../registry/business'
import { homeToolBlurbs, homeToolOrder, officialAccountNames, shortcutTools, tools as toolRegistry } from '../../registry/tools'
import { statuses } from '../../registry/status'
import { FirstRunSteps } from './FirstRun'
import { bootstrapErrorText, isAccountNotEnabledFailure, keySyncFailureText, networkBlockedNotice } from './key-sync-failure'
import { dismissFirstRun, getFirstRunStorage, readFirstRunDismissals } from './first-run-dismissal'
import { formatRecentTime, recentReplacedHint, recentResumeHint, recentSessionSubtitle } from './recent-display'
import { chooseWorkspaceLabel, conversationsMenuLabel, latestSessionIdsByWorkspace, launchWorkspaces, newWorkspaceLabel, opensUntouchedStarterWorkspace, resumeLaunchChoice, resumeNeedsRecheck, resumeStillLatest, startsInNewFolder, type CliLaunchChoice } from './recent-workspaces'
import { dollars as money, errorMessage } from '../../business-common'
import { subscriptionEndDate, type UsableSubscription } from '../../../../electron/subscription-summary'
import { isActiveProviderId, isProviderId } from '../../../../electron/catalog'
import { gitHostPlatform, gitMacInstallWaitingHint, gitMissingFirstRunHint, gitMissingHomeNotice } from '../../../../electron/git-runtime'
import { managedRuntimeNotice, runtimeButtonLabel, runtimeInstallButtonShown, runtimeInstallGuide } from './runtime-install-guide'
import { RuntimeInstallHint } from './RuntimeInstallHint'
import { elevatedInstallShortNotice, homeNodeElevationNotice } from './elevation-notice'
import { useOnlineStatus } from '../shell/useOnlineStatus'
import { toolRouteHijackShownMs, toolRouteHomeTexts, toolRouteLabel, type RelayToolRouteStatus } from './route-label'
import { balanceRunwayEmpty, buildBalanceRunway, type BalanceRunway } from '../app/balance-runway'
import { useRestartPending } from './restart-reminder'
import { RuntimeRestartDialog } from './RuntimeRestartDialog'
import { OfficialQuotaDialog } from './OfficialQuotaDialog'
import { ToolConversationsDialog } from './ToolConversationsDialog'
import { buildUninstallGuide, UninstallGuideDialog, type UninstallGuide, type UninstallGuideTool } from './UninstallGuide'
import { buildSourceMenuItems, SourceMenu, sourceChipLabels } from './SourceMenu'
import { sameWeekSpend, weekSpendHint, weekSpendLabel, type WeekSpend } from './week-spend'
import { currentWindowOs, windowOsFor } from '../app/window-os'
import { readWindowSession, writeWindowSession } from '../../window-session'

/** 正在装的这一次是更新、回到推荐版本还是退回：进度那一行开头说清楚（批 04 字表）。 */
export interface ToolInstallIntent {
  kind: 'update' | 'rollback' | 'revert'
  version: string
}

export interface HomeProps {
  api: ToolsApi
  snapshot: ToolboxSnapshot | null
  loading: boolean
  error: string
  /** 单块读失败的原因；缺省 = 三块都读到了（旧行为）。 */
  failures?: ToolboxPartitionFailure[]
  account: AccountProfile | null
  /** 开机恢复上次的登录还没结束（含联不上、等重试）：登录还在，不能叫人「登录后查看」。缺省 = 没在恢复。 */
  accountRestoring?: boolean
  /** 星芒账号工具线路的状态（xm 三线路）：服务端切换、三条线都连不上、改用了 CF。缺省 = 没有要说的。 */
  toolRouteStatus?: RelayToolRouteStatus
  /**
   * 当前账号的作用域（App 的 scope）。用量缓存按它认账号：有它时回首页先摆上一次的
   * 用量、后台再刷新；省略 = 每次都先空着等查询回来（旧行为）。
   */
  accountScope?: string
  supportsUsage?: boolean
  supportsBilling?: boolean
  /** 后台给得出按天的花费（历史账号给不出）：余额卡画近 7 天的七根柱子。缺省 = 只写合计。 */
  supportsUsageTrend?: boolean
  /** 当前账号有密钥管理：工具区最后一格改去「在其他软件中使用」。缺省 = 照旧去反馈。 */
  supportsKeys?: boolean
  balance: AccountBalance | null
  /** 当前账号能用的订阅；缺省 / null = 没有，一切按钱包说（旧行为）。 */
  subscription?: UsableSubscription | null
  /** 订阅还没读到（刚登录、读失败）：不知道有没有，钱的提醒和「余额为零」都先不说（F1）。缺省 = 读到了。 */
  subscriptionUnknown?: boolean
  jobs: Record<string, ToolJob>
  externalClients: ExternalClientStatus[]
  externalLoading: boolean
  externalError: string
  /**
   * 「最近」这份列表在 toolsApi 里缓存 60 秒。外层作废缓存时把这个数字加一，
   * 首页就重读一遍（装卸工具、换账号、主动重新检测都会走到）。打开工具只作废、不加一：
   * 那一下终端里还没聊，首页等窗口回到前面时再读。省略 = 不主动重读（旧行为）。
   */
  recentRevision?: number
  onScan(): void
  /**
   * version 省略 = 让主进程按已验证版本名单决定;点名 = 回到推荐版本(N1)。
   * intent 是这一下点的是「更新」还是「回到推荐版本」：App 据此先问一句、装完说哪一句。缺省 = 安装。
   */
  onInstall(tool: ToolId, version?: string, intent?: 'update' | 'rollback'): void
  /** 中止正在进行的安装或更新。 */
  onCancelInstall(tool: ToolId): void
  /**
   * workspace 省略 = 弹目录选择器(旧行为);点名 = 直接用记住的目录打开(N7)。
   * mode 省略 = 开新对话;'resumeLast' = 接着这个目录里最近的一条对话(#292);
   * { resumeSessionId } = Codex 接着这一条记录(见 resumeLaunchChoice)。
   */
  onLaunch(tool: ToolId, workspace?: string, mode?: CliLaunchChoice): void
  /**
   * 不选目录，替用户新建一个项目文件夹再打开；缺省 = 不给这个入口（旧行为）。
   * firstOpen：第一次点「打开」时走这条（已知40）。主进程记着的文件夹还在就用它，没有才新建，
   * 建不成说一句再弹目录选择器。
   */
  onLaunchInNewFolder?(tool: ToolId, firstOpen?: boolean): void
  onConfigure(tool: ToolId): void
  /** 配置被改动过时按当前账号重写这一个工具的 Key；缺省 = 不给这颗按钮（旧行为）。 */
  onRewriteKey?(tool: ToolId): void
  /** 配置被改动过时认下现在这份配置，以后不再提；缺省 = 不给这个菜单项（旧行为）。 */
  onKeepConfig?(tool: ToolId): void
  /**
   * 一键切换账号来源（切到当前账号 / 切回官方账号）；缺省 = 不给这个菜单项（旧行为）。
   * 备份、写入、自检、失败回滚都由主进程一次做完，这里只负责把人送过去。
   */
  onSwitchAccount?(tool: ToolId, target: AccountSourceTarget): void
  /** 提醒设置指向旧位置时改成这次的路径（先备份再改再自检）；缺省 = 不给这颗按钮（旧行为）。 */
  onRepairHooks?(tool: ToolId): void
  /** Codex 读不了 config.toml 时先备份、再按现在用的账号重新生成；缺省 = 不给这颗按钮（旧行为）。 */
  onRepairConfig?(tool: ToolId): void
  /** 在资源管理器 / 访达里打开这个工具的配置文件夹；缺省 = 不给这个菜单项（旧行为）。 */
  onOpenConfigDirectory?(tool: ToolId): void
  onConfigureExternal(tool: ExternalToolId): void
  onInstallExternal(tool: ExternalToolId): void
  /** 中止正在进行的客户端安装；缺省 = 不给这颗按钮（旧行为）。 */
  onCancelInstallExternal?(tool: ExternalToolId): void
  onLaunchExternal(tool: ExternalToolId): void
  /**
   * Claude Desktop 在当前账号和客户自己的 Claude 账号之间切换（只改它登录页那个选择，星芒那份配置留着）；
   * 缺省 = 来源牌照旧不可点（旧行为）。
   */
  onSwitchExternalSource?(tool: ExternalToolId, target: AccountSourceTarget): void
  /** 一键安装用不了时打开客户端官网下载页；缺省 = 不给这颗按钮，仍是「暂不支持」（旧行为）。 */
  onOpenExternalDownload?(url: string): void
  onCodexModels(): void
  onUninstall(tool: ToolId): void
  /** 退回更新前的版本（先确认再装）；缺省 = 不给这个菜单项（旧行为）。 */
  onRevert?(tool: ToolId, version: string): void
  onRuntime(runtime: 'node' | 'python' | 'git'): void
  onNavigate(page: PageId, section?: string): void
  onGuide(): void
  /**
   * finishedAt 是 result 落下来的时刻（Date.now()），「已给…配好密钥」那句据此到点收起；缺省 = 一直摆着（旧行为）。
   * quiet 是跟着连接线路悄悄改工具配置的那一轮（yoyo 10-8：线路的事不要太多提示）：不摆进度，出了错照常说；
   * 缺省 = 照常摆。
   */
  bootstrap?: (AccountBootstrapProgress & { scope: string; result?: AccountBootstrapResult; finishedAt?: number; error?: string; quiet?: boolean }) | null
  onBootstrapRetry?(): void
  /**
   * 「账号未开通」只有客服能开（主路卡点 F5）：横幅加「联系客服」，卡片主按钮也换成它，都打开帮助框里的客服二维码；
   * 缺省 = 不给那颗按钮、主按钮照旧「确认连接」（旧行为）。
   */
  onHelp?(): void
  /** 首页点「安装」没装上的工具和原因（App 记的，重新检测或再装一次就清掉）；缺省 = 没有。 */
  installFailures?: Partial<Record<ToolId, { reason: string }>>
  /** 卡片上的「看原因」：把那次的错误框再打开；缺省 = 不给这颗按钮。 */
  onShowInstallFailure?(tool: ToolId): void
  /** 正在装的那一次是更新、回到推荐版本还是退回；缺省 = 只写进度。 */
  installIntents?: Partial<Record<ToolId, ToolInstallIntent>>
  /**
   * Mac 上 Claude Desktop、OpenCode 那一行的「可更新到 v…」（yoyo 2026-10-27「桌面端更新改」）；缺省 = 不给这个链接（旧行为）。
   * Codex 桌面端那一行照旧走 onInstall(…, 'update')。
   */
  onUpdateDesktopApp?(tool: ExternalToolId, version: string): void
  /** Mac 上桌面端正在更新到哪一版：进度那一行开头写「更新到 v…」；缺省 = 只写进度。 */
  desktopUpdateTargets?: Partial<Record<DesktopUpdateTool, string>>
  /** Mac 上桌面端没更新成的那几个：卡片写「没更新成，旧版还在，照常能用」和「看原因」；缺省 = 没有。 */
  desktopUpdateFailures?: Partial<Record<DesktopUpdateTool, unknown>>
  onShowDesktopUpdateFailure?(tool: DesktopUpdateTool): void
  /** 「还差重启一次电脑」那条提醒的「现在重启」；缺省 = 首页不摆这条（旧行为：挂在页顶）。 */
  restart?: () => Promise<WindowsRestartResult>
  /**
   * 公告、活动挪进首页的提示区（一页最多两条）：首页把放它们的那个位置交出去，
   * 再告诉外层自己的提示占掉几条后还剩几条位置。缺省 = 不交（旧行为：公告挂在页顶）。
   */
  onNoticeSlot?(element: HTMLElement | null): void
  onNoticeRoom?(room: number): void
}

type ExternalPresentation = ReturnType<typeof presentExternalClients>[number]
type RecentSession = MultiProviderSessionPage['items'][number]

function firstRunOf(tool: ToolId) {
  return toolRegistry.find((item) => item.id === tool)?.firstRun
}

/**
 * 「试试第一条命令」给哪个工具。装好又连上之后才给：还没配 Key 时第一条命令敲下去只会报错，
 * 那不是「可以试试」。一次只给一个，关掉它下一个才轮上，免得首页被四张一样的卡片占满。
 * 「最近」里已经有这个工具的记录，说明早就用起来了，不再教第一条命令。记录还没读回来
 * （usedProviders 为 null）时谁都不给：先给了、读完记录又收走，老用户会看到这张卡一闪而过。
 */
export function pickFirstRunTool(installed: ToolPresentation[], jobs: Record<string, ToolJob>, dismissed: ToolId[], usedProviders: ReadonlySet<ProviderId> | null): ToolPresentation | undefined {
  if (!usedProviders) return undefined
  return installed.find((tool) => tool.status.installed && !jobs[tool.id] && tool.configured && !tool.error
    && !dismissed.includes(tool.id) && firstRunOf(tool.id) !== undefined && !usedProviders.has(tool.provider))
}

/**
 * 「最近」里这一家的对话给不给「继续对话」。它点下去走的是同一个「打开」，没装的那家那一行只有
 * 「先安装」，点「继续对话」只会弹「工具尚未安装，请先完成准备。」（第四十一批 A）：卸掉的工具旧记录还在，
 * 只装了 Codex 桌面端的人在桌面端里聊过的多半也记在 Codex 名下。所以按工具 id 找，不按 provider：
 * 桌面端装着不等于 Codex CLI 装着。检测结果还没回来时照旧摆着、灰着等；检测失败的不当没装（A4），
 * 点了照旧说失败的原因。
 */
export function recentResumeOffered(tools: readonly ToolPresentation[], provider: ProviderId): boolean {
  // 已下线的工具（Gemini，yoyo 2026-10-14）首页不再替它打开：它的旧记录不给「继续对话」。
  if (!isActiveProviderId(provider)) return false
  const tool = tools.find((entry) => entry.id === provider)
  return tool === undefined || tool.status.installed || tool.error !== null
}

/**
 * 「配置被改过」这一档必须自己解释一句：角标只说了发生什么，没说会怎样。
 * 用户真正要知道的是这个工具现在没在用当前账号，以及有一颗按钮能一键修回来。
 * 文案以「当前账号」为主语，不提站点。
 */
const configChangedDetail = '配置已被其他程序修改，未使用当前账号的密钥'

/** 装好了、还没连上：外接客户端和命令行工具同一句，旁边一颗「确认连接」。 */
const unconfiguredDetail = '已安装，尚未关联当前账号'

/**
 * Mac 上找到的 Codex / Grok 不是星芒装的、星芒也认不出来路（Mac 验收 R1）：以前卡上照样一颗「打开」，
 * 点了只说没打开成。现在写清楚为什么，旁边一颗「使用星芒安装」。
 */
const unrecognizedInstallDetail = '非星芒安装，无法在星芒中打开'

/**
 * CC Switch 留下的配置：客户多半不知道本软件登录后不会动它，只看到工具「装好了」
 * 却还连着以前那家。一句话说清现在连的是哪、会怎样，旁边一颗「改用当前账号」。
 * 走代理接管的那份要 CC Switch 一直开着才通，单独说。
 */
const ccSwitchDetails: Record<'proxy' | 'provider', string> = {
  proxy: '正通过 CC Switch 转发，关闭 CC Switch 后将无法使用，且未使用当前账号',
  provider: '正在使用 CC Switch 中选择的连接，未使用当前账号',
}

/**
 * Codex 老配置把当前账号写在它的内置名下：看着连好了，打开却连不上。一句话说清会
 * 怎样，旁边「立即修复」走和「改用当前账号」同一条路（先备份、再写、再自检）。
 */
const codexShadowedDetail = '配置中有一项 Codex 无法识别，打开后将无法连接'

/**
 * 本软件写进工具里的提醒设置（做完、出错时弹通知，干活时不让电脑睡）指向了旧位置：
 * 卸载后换了文件夹重装、挪了软件、换装了 Node.js 都会这样。工具照样能用，只是每一轮
 * 都多报一行错。「立即修复」只改这几行，先备份。客户不知道「提醒设置」是什么，按它干的事叫。
 */
const cliHooksStaleDetail = '「完成通知」设置指向旧位置，每次运行将多出一条报错'

/**
 * 打开软件时替客户改好的提醒设置这次运行里说过的那几家。模块里一份，窗口的 sessionStorage 里再记一份：离开首页再回来、
 * 首页重画、窗口缩在托盘久了界面被关掉再叫出来（#1411，同一个窗口重新加载）都不再弹；重开软件是新窗口，从头算，
 * 同主进程那份只在内存里的记录（autoRepairedCliHooks）。
 */
const announcedHookRepairs = new Set<ProviderId>()
const announcedHookRepairsKey = 'xingmang-v2-announced-hook-repairs'

/** 界面重新加载前记下的那几家（逗号隔开）；认不出的名字不算，读不到就当没说过。 */
export function parseAnnouncedHookRepairs(saved: string | null): ProviderId[] {
  return (saved ?? '').split(',').filter(isProviderId)
}

/**
 * 打开软件时替客户改好了提醒设置（第十八批 1b）：只在右下角说一次、到点自己收起。原来写在卡片中间那行，
 * 软件开着就一直挂着，还顶掉了线路和版本，客户以为一直有事要处理（yoyo 2026-10-25）。
 * 返回这次还没说过的那几家；Codex 命令行和桌面端共用一份配置，算一家。
 */
export function hookRepairsToAnnounce(repaired: readonly ProviderId[], announced: ReadonlySet<ProviderId>): ProviderId[] {
  return [...new Set(repaired)].filter((provider) => !announced.has(provider))
}

/** 右下角那一句：Codex 两行共用一份配置，只说「Codex」。原来的设置改之前先备份，在「设置 › 备份迁移」里。 */
export function cliHooksAutoRepairedText(providers: readonly ProviderId[]): string {
  const names = providers.map((provider) => provider === 'codex' ? 'Codex' : toolRegistry.find((tool) => tool.id === provider)?.name ?? provider)
  return `已自动修复 ${spacedName(names.join('、'))}的「完成通知」设置，原设置已备份至「设置 › 备份迁移」。`
}
/**
 * Windows 上只装 Grok 时没有运行环境，做完提醒和防睡写不上（#695 留下的）。没有运行环境时「启用」
 * 先去准备它，装好后主进程自己补；已经有了（客户自己装的）就直接补。
 */
const cliHooksMissingWithoutRuntimeDetail = '「完成与出错通知」和「运行时防止休眠」尚未启用，点击「启用」将先准备运行环境'
const cliHooksMissingDetail = '「完成与出错通知」和「运行时防止休眠」尚未启用，点击「启用」即可开启'
const cliHooksShellChangedDetail = 'Grok 命令行已变更，通知设置需同步更新，否则每次运行将多出一条报错'

/**
 * 来源没确认的两种 Key 各说一句会怎样（方案盘查 2026-09-25）。别家的站认不出也
 * 用不了，只说不是当前账号的、在这里打不开，不提对方是谁；同一个站上别的账号的
 * Key 能用，要说清用量算到哪。
 */
const foreignKeyDetails = {
  otherSite: '无法在此打开，改用当前账号后即可使用',
  otherAccount: '可以使用，但用量可能计入其他账号',
} as const

const nodeInstallerPartMissingNote = '缺少安装组件，请重新安装 Node.js'

/** 一页最多两条提示（v4）：要客户动手的错误不算在里面，照旧都摆着。 */
const homeNoticeLimit = 2

// 卡片「改用…」统一不带用户名（批 04 字表）：长邮箱会把按钮撑出卡片。
const useAccountLabel = '改用当前账号'
/** 首页 Codex CLI 卡片「…」菜单里去手机遥控那张卡的那一项（YF-6）。 */
export const remoteMenuLabel = '手机遥控'

/** npm 是随 Node.js 一起装的：Node.js 在、它却确实不在（不是没查出来）才算缺。 */
export function nodeInstallerPartMissing(runtime: ToolboxSnapshot['system']['runtime'] | undefined) {
  return Boolean(runtime?.node.installed && runtime.npm && !runtime.npm.installed && !runtime.npm.detectionFailed)
}

/**
 * 新账号的余额本来就是 0，「余额只剩 $0.00」读起来像是用光了，客户不知道要先充值才能用；
 * 客服远程装好以后，这一行往往是客户看到的第一句跟钱有关的话。
 * 算不出最近用量（新账号、看不了用量）时退回这一句，按 $5 报（v4 方案问 6）。
 * 最后一次调用把余额扣成负数时，余额那格写「-$0.03」，这句跟着说欠了多少（余额审查 F7）；
 * 以前照样说「余额是 $0」，跟那格的数对不上。欠的不到半分钱时那格是 $0.00，这句也照 $0 说。
 */
export function lowBalanceText(dollars: number) {
  const owed = money(-dollars)
  if (dollars < 0 && owed !== money(0)) return `当前账号已欠费 ${owed}，请充值后继续使用`
  return dollars <= 0 ? '当前账号余额为 $0，充值后方可使用 AI 工具。充值即时生效，无需重新设置。' : `余额仅剩 ${money(dollars)}，请及时充值。`
}

/** 「约还能用 N 天」那半句；天数算不出来时 null。 */
function runwayDaysText(days: number): string {
  if (days > 365) return '可用一年以上'
  if (days < 1) return '预计不足 1 天'
  return `预计可用 ${days} 天`
}

/**
 * 余额卡和首页提示条里的钱的那一句（v4 方案问 6）：按最近用量不够 7 天才提醒，订阅剩下的额度按
 * 扣费顺序算进去；算不出用量时退回旧规矩（钱包不到 $5、订阅快用完 / 快到期）。不用提醒时 null。
 * 订阅还没读到时也是 null：钱包 $0、靠订阅用的客户不能被叫去充值（F1）。
 */
export function homeMoneyNotice(dollars: number | null, subscription: UsableSubscription | null, runway: BalanceRunway | null, subscriptionUnknown = false): { text: string; renew: boolean } | null {
  if (dollars === null || !subscription && subscriptionUnknown) return null
  const days = runway?.days ?? null
  if (!subscription) {
    if (dollars <= 0) return { text: lowBalanceText(dollars), renew: false }
    if (days !== null) return runway?.low ? { text: `余额仅剩 ${money(dollars)}，按近期用量${runwayDaysText(days)}。用尽后工具将暂停使用`, renew: false } : null
    return dollars < 5 ? { text: lowBalanceText(dollars), renew: false } : null
  }
  const name = subscription.name ?? '订阅'
  if (days !== null && runway?.low && runway.usableUsd !== null) {
    return subscription.subscriptionOnly
      ? { text: `${name}仅剩 ${money(runway.usableUsd)}，按近期用量${runwayDaysText(days)}。用尽后工具将暂停使用`, renew: true }
      : { text: `余额与订阅额度合计仅剩 ${money(runway.usableUsd)}，按近期用量${runwayDaysText(days)}。用尽后工具将暂停使用`, renew: false }
  }
  const warning = subscriptionWarning(subscription, dollars)
  if (!warning) return null
  // 订阅快用完、用完改扣余额的那一句照 v4 写（带套餐名）；只扣订阅的、快到期的保留原话。
  if (!subscription.subscriptionOnly && !subscription.expiringSoon && subscription.remainingUsd !== null) {
    return { text: `${name}仅剩 ${money(subscription.remainingUsd)}，用尽后将从余额扣费`, renew: true }
  }
  return { text: warning, renew: true }
}

/**
 * 工具区最后一格「想用的工具不在这里？」点了去哪（Q1）：登录了、账号有密钥管理，先去密钥管理最下面
 * 「在其他软件中使用」，那里再留一句去反馈；没登录或没有密钥管理的照旧直接去反馈。
 */
export function homeToolRequest(signedIn: boolean, supportsKeys: boolean | undefined): { page: PageId; section: string; text: string } {
  return signedIn && supportsKeys === true
    ? { page: 'account', section: otherAppsAnchor, text: '查看如何在其他软件中使用' }
    : { page: 'feedback', section: 'form', text: '提交接入需求' }
}

/**
 * 钱包是 $0、也没有能用的订阅：跟上面那条 $0 提示同一个判断。订阅客户的钱包常是 0、扣的却是订阅；
 * 余额还没读到、订阅还没读到（不知道有没有，F1）、账号不能在这里充值时都不算。
 */
export function homeWalletEmpty(dollars: number | null, subscription: UsableSubscription | null, supportsBilling: boolean, subscriptionUnknown = false): boolean {
  return supportsBilling && !subscription && !subscriptionUnknown && dollars !== null && dollars <= 0
}

function cachedUsage(api: ToolsApi, scope: string | undefined): BalanceUsage | null {
  return scope === undefined ? null : api.peekBalanceUsage(scope)
}

function cachedWeekSpend(api: ToolsApi, scope: string | undefined, wanted: boolean): WeekSpend | null {
  return wanted && scope !== undefined ? api.peekWeekSpend(scope) : null
}

interface HomeBalanceCardProps {
  /** 标题那一行（「账号余额」和「用量账单」）。 */
  head: ReactNode
  /** 大字：金额或「—」。 */
  amount: ReactNode
  hasBalance: boolean
  /** 没金额时旁边那行小字在等什么：恢复登录、读余额；null = 没登录，不写。 */
  waiting: 'restoring' | 'reading' | null
  /** 刷新键点了做的事；缺省（没登录、外面没挂余额）= 不放刷新键。 */
  onRefresh?: () => void
  recharge: ReactNode
  /** 订阅、还能用几天、近 7 天花费那几行。 */
  children: ReactNode
}

/**
 * 余额卡的外框和每次刷新都会变的那几样：转圈、「最后更新于」、更新失败（R8）。它自己订阅余额，
 * 每分钟一次的刷新只重画这一小块；金额和下面那几行是首页画好交进来的，余额没变就原样留着，
 * 首页的工具卡也不跟着重画。
 */
function HomeBalanceCard({ head, amount, hasBalance, waiting, onRefresh, recharge, children }: HomeBalanceCardProps) {
  const loading = useSharedBalanceSelector((state) => state.loading)
  const updatedAt = useSharedBalanceSelector((state) => state.updatedAt)
  const failure = useSharedBalanceSelector((state) => state.error)
  const { offline } = useOnlineStatus()
  const hint = balanceStatusText({ balanceLoading: loading, balanceUpdatedAt: updatedAt, balanceError: failure, offline })
  // 大字只放数字或「—」；没数字时旁边那行小字说清是在恢复登录、在读，还是没读到，别在读的时候说「暂未读到」。
  const label = hasBalance || !waiting ? null
    : waiting === 'restoring' ? '正在恢复登录'
      : failure && !loading ? '暂未获取' : '正在读取余额'
  return <section className="v2-home-balance" data-testid="home-balance-card" title={hint}>
    {head}
    <div className="v2-home-balance-top">
      {amount}
      {label && <small data-testid="home-balance-label">{label}</small>}
      {onRefresh && <Button variant="ghost" size="xs" icon={RefreshCw} loading={loading} aria-label="刷新账号余额" title={hint} onClick={onRefresh} testId="home-balance-refresh" />}
      {recharge}
    </div>
    {failure && <p className="v2-balance-error" role="status" title={failure}>更新失败，{hasBalance ? '显示上次余额' : '请重试'}</p>}
    {children}
  </section>
}

/** 「已给 Claude Code 配好密钥，可以直接用了」：一个工具说名字，几个说个数。 */
function configuredKeysText(who: string) {
  return `已为 ${spacedName(who)}配置密钥，可直接使用`
}

/** 写密钥那一句里的「谁」：Codex CLI 和桌面端共用一份配置，算一个。 */
function keyTargetsLabel(providers: readonly ProviderId[]): string {
  const names = [...new Set(providers)].map((provider) => toolRegistry.find((tool) => tool.id === provider)?.name ?? provider)
  return names.length > 1 ? `${names.length} 个工具` : names[0] ?? '工具'
}

/**
 * 「已给…配好密钥」只是说一声做完了，照右下角提示条的读完时长摆着，到点自己收起（已知12）：
 * 以前登录后整场挂着，装完一个工具又换一遍。有没写成的、有要留意的、被网拦住的，那几句
 * 要客户动手，照旧一直摆着。返回 null = 一直摆着。
 */
export function bootstrapNoticeExpiresAt(bootstrap: HomeProps['bootstrap']): number | null {
  const result = bootstrap?.result
  if (!result || bootstrap?.finishedAt === undefined) return null
  if (!result.configured.length || result.failed.length || result.warnings.length || result.networkBlocked) return null
  const duration = toastDurationMs(configuredKeysText(keyTargetsLabel(result.configured)), 'ok')
  return duration === null ? null : bootstrap.finishedAt + duration
}

/**
 * 横幅里要客户留意的那几句。星芒画图缺 Node.js 的那句（drawingNeedsNode）跟着运行环境卡走：一个命令行工具
 * 都没装（只装了 Codex 桌面端，或者什么都没装）时 Node.js 那一行写「可选 · 未安装」「一般不用单独点」，横幅再说
 * 「还缺运行环境」就打架了，客户不知道到底装不装（yoyo 10-8，A014）。这时 Codex 桌面端里先画不了图；客户装任一
 * 命令行工具时星芒顺带准备 Node.js，装完那一轮同步就把画图接上。正在装的不算装着，免得装到一半冒出这句；
 * 没检测出来的算装着（A4），同 Node.js 那一行。
 */
export function homeBootstrapWarnings(result: AccountBootstrapResult, tools: readonly ToolPresentation[]): string[] {
  const cliInstalled = tools.some((tool) => tool.id !== 'codexDesktop' && (tool.status.installed || tool.status.detectionFailed === true))
  return result.drawingNeedsNode && cliInstalled ? [...result.warnings, result.drawingNeedsNode] : result.warnings
}

/** 进度那一行开头的「更新到 v1.2 · 」。 */
function installIntentPrefix(intent: ToolInstallIntent | undefined): string {
  if (!intent) return ''
  const verb = intent.kind === 'update' ? '更新到' : intent.kind === 'rollback' ? '回到' : '退回'
  return `${verb} v${intent.version.replace(/^v/, '')} · `
}

/** Mac 上桌面端正在更新：进度那一行开头同命令行工具的「更新到 v… · 」。 */
function desktopUpdatePrefix(target: string | undefined): string {
  return target ? installIntentPrefix({ kind: 'update', version: target }) : ''
}

function versionText(version: string | null | undefined): string {
  return version ? `v${version.replace(/^v/, '')}` : '版本暂未识别'
}

/** 一行提示（v4 的 notice）：图标、一句话、右边一颗按钮。 */
function HomeNotice({ tone, role = 'status', icon, children, action, testId, busy }: { tone?: 'warn' | 'bad' | 'ok'; role?: 'status' | 'alert'; icon?: ReactNode; children: ReactNode; action?: ReactNode; testId?: string; busy?: boolean }) {
  return <div className={`v2-home-notice${tone ? ` is-${tone}` : ''}`} role={role} data-testid={testId} data-busy={busy ? 'true' : undefined}>
    {icon}<span className="v2-home-notice-text">{children}</span>{action}
  </div>
}

function Spinner({ label }: { label?: string }) {
  return <RefreshCw size={14} className="xm-spin v2-home-spinner" aria-hidden={label ? undefined : true} aria-label={label} />
}

/** 首页「还差重启一次电脑」：Windows 装运行环境回 3010 后挂着，点「现在重启」再弹同一个框（只换了地方）。 */
function RestartNotice({ restart }: { restart: () => Promise<WindowsRestartResult> }) {
  const [open, setOpen] = useState(false)
  return <>
    <HomeNotice tone="warn" icon={<RotateCcw size={15} aria-hidden="true" />} testId="restart-reminder"
      action={<Button size="xs" variant="secondary" icon={RotateCcw} onClick={() => setOpen(true)} testId="restart-reminder-now">立即重启</Button>}>
      <strong>需要重启电脑</strong> 运行环境需重启电脑后才能完成安装，重启前安装工具可能失败。
    </HomeNotice>
    {open && <RuntimeRestartDialog onClose={() => setOpen(false)} restart={restart} />}
  </>
}

export function Home(props: HomeProps) {
  const { snapshot, account, balance, jobs, loading, error } = props
  // 首页不订阅整份余额（R8）：转圈、最后更新时间、更新失败每次刷新都变，交给余额卡自己（HomeBalanceCard）。
  const balanceStore = useSharedBalanceStore()
  const { offline } = useOnlineStatus()
  const restartPending = useRestartPending()
  const toast = useToast()
  const [recent, setRecent] = useState<MultiProviderSessionPage | null>(null)
  const [recentError, setRecentError] = useState('')
  const [recentAttempt, setRecentAttempt] = useState(0)
  // 「继续对话」点下去以后正在核对的那一条（见 resumeRecent）；null = 没在核对。
  const [resumeChecking, setResumeChecking] = useState<string | null>(null)
  // 上一次「继续对话」换成了同一文件夹更新的那条、没打开时说的那句（#1111 第 3 条）；再点「继续对话」就清掉。
  const [resumeReplaced, setResumeReplaced] = useState('')
  // 卡片「…」里「接着之前的对话…」开着的那个工具；null = 窗口没开。
  const [conversationsTool, setConversationsTool] = useState<ToolId | null>(null)
  const [usage, setUsage] = useState<BalanceUsage | null>(() => cachedUsage(props.api, props.accountScope))
  // 跟着余额重读用量时要看「这一刻卡片上摆着的」，那时首页不一定重画过，所以另记一份。
  const usageShown = useRef(usage)
  usageShown.current = usage
  const [usageError, setUsageError] = useState('')
  const trendWanted = props.supportsUsageTrend === true && props.supportsUsage !== false
  const [week, setWeek] = useState<WeekSpend | null>(() => cachedWeekSpend(props.api, props.accountScope, trendWanted))
  // 点了余额旁边的刷新：用量和近 7 天跟着重读一次（F3）。
  const [usageRefresh, setUsageRefresh] = useState(0)
  const [officialOpen, setOfficialOpen] = useState(false)
  const [official, setOfficial] = useState<OfficialChatGptAccount | null>(null)
  const [uninstallGuide, setUninstallGuide] = useState<UninstallGuide | null>(null)
  const [firstRunDismissed, setFirstRunDismissed] = useState<ToolId[]>(() => readFirstRunDismissals(getFirstRunStorage()))
  const [noticeSlot, setNoticeSlot] = useState<HTMLDivElement | null>(null)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  // 用量和近 7 天跟着余额走（F3）：一直停在首页时余额每分钟在变，这两样以前只在进首页、换账号时读，
  // 「近 7 天花费」和靠它算的「约还能用 N 天」一下午不动。余额每读到一次（updatedAt 变了）就再要一次，
  // 一分钟的缓存照旧挡着，不会每回都去问后台；点刷新时先作废缓存，见 refreshBalanceCard。
  // 只听「余额读到了」、读回来跟手上一样就不换：首页不用跟着每次刷新整页重画（R8）。
  useEffect(() => {
    let current = true
    const wanted = Boolean(account) && props.supportsUsage !== false
    function read() {
      // 先摆上一次查到的（一分钟内就是它本身，不会再发请求），查回来再换；刷新失败时
      // 手上已经有数就留着它，没有才说读不到。缓存刚作废（点了刷新）、手上已经有数时不先清空，
      // 免得卡片一闪一跳；换账号整页重挂（外层 key={scope}），留着的不会是上一个账号的。
      const cached = cachedUsage(props.api, props.accountScope)
      if (cached || !wanted) { setUsage((shown) => sameFlatRecord(shown, cached) ? shown : cached); setUsageError('') }
      // 「手上的数」= 这一刻卡片上摆着的：点刷新作废了缓存、重读又失败时，照旧留着它，不换成「暂未读到」。
      const kept = cached ?? usageShown.current
      if (wanted) void props.api.balanceUsage(props.accountScope).then((value) => { if (current) { setUsage((shown) => sameFlatRecord(shown, value) ? shown : value); setUsageError('') } }).catch(() => { if (current && !kept) setUsageError('用量暂未获取') })
    }
    read()
    const stop = balanceStore ? subscribeBalanceReads(balanceStore, read) : undefined
    return () => { current = false; stop?.() }
  }, [account?.userId, props.accountScope, props.api, props.supportsUsage, balanceStore, usageRefresh])
  useEffect(() => {
    let current = true
    const wanted = Boolean(account) && trendWanted
    function read() {
      // 七根柱子读不到就不画，合计照旧按上面那份用量写，不另报错。不先清空同上。
      const cached = cachedWeekSpend(props.api, props.accountScope, trendWanted)
      if (cached || !wanted) setWeek((shown) => sameWeekSpend(shown, cached) ? shown : cached)
      if (wanted) void props.api.weekSpend(props.accountScope).then((value) => { if (current) setWeek((shown) => sameWeekSpend(shown, value) ? shown : value) }).catch(() => undefined)
    }
    read()
    const stop = balanceStore ? subscribeBalanceReads(balanceStore, read) : undefined
    return () => { current = false; stop?.() }
  }, [account?.userId, props.accountScope, props.api, trendWanted, balanceStore, usageRefresh])
  /** 余额旁边的刷新：点了是要看现在的数，用量和近 7 天不认一分钟的缓存，跟余额一起重读（F3）。 */
  function refreshBalanceCard() {
    if (!balanceStore) return
    props.api.invalidateBalanceUsage()
    setUsageRefresh((value) => value + 1)
    void balanceStore.refresh('manual')
  }
  // 公告、活动放进首页提示区：把位置交给外层；离开首页时收回。
  const { onNoticeSlot, onNoticeRoom } = props
  useEffect(() => {
    onNoticeSlot?.(noticeSlot)
    return () => onNoticeSlot?.(null)
  }, [noticeSlot, onNoticeSlot])
  /**
   * 「最近」那三行的「打开文件夹」。只传会话 id，路径由主进程从记录里取并校验。
   * 失败（文件夹刚被删掉、盘符掉了）只提示一句，不动这份列表：过了一分钟、窗口
   * 再回到前面时它自己会重读，而这一下点击不值得让整张卡重来一遍。
   */
  async function openRecentDirectory(sessionId: string) {
    try { await props.api.openSessionDirectory(sessionId) }
    catch (cause) { if (active.current) toast.show(errorMessage(cause, '无法打开该记录所在的文件夹。'), 'warn') }
  }
  /**
   * 「继续对话」点下去先对一次「最近」（已知4）。窗口回到前面时的那次重读是异步的：从终端直接点回星芒，
   * 这一下用的还是手上的旧列表，点同一文件夹里更早那条，Claude Code、Grok CLI 接上的
   * 却是刚聊的那条。所以先真去读一份（不认一分钟的缓存，它可能是在终端里聊之前读的）：点的这条已经
   * 不是它那个文件夹最近的了，就换上新列表、这次不打开，按钮自己挪到该挂的那条上。读不到就照旧打开。
   */
  async function resumeRecent(session: RecentSession) {
    const provider = session.provider
    if (!isActiveProviderId(provider)) return
    setResumeReplaced('')
    if (resumeNeedsRecheck(session)) {
      setResumeChecking(session.id)
      props.api.invalidateRecent()
      const fresh = await props.api.recent().catch(() => null)
      // 读的这一下首页已经换掉了（换账号会整页重挂）：这一下按的不再算数。
      if (!active.current) return
      setResumeChecking(null)
      if (fresh) setRecent(fresh)
      if (fresh && !resumeStillLatest(session, fresh.items)) {
        setResumeReplaced(recentReplacedHint(session))
        return
      }
    }
    props.onLaunch(provider, session.cwd, resumeLaunchChoice(session))
  }
  useEffect(() => {
    let current = true
    setRecentError('')
    void props.api.recent().then((value) => { if (current) setRecent(value) }).catch((cause) => {
      if (current) setRecentError(errorMessage(cause, '记录加载失败'))
    })
    return () => { current = false }
  }, [props.api, recentAttempt, props.recentRevision])
  // 首页一直开着就不会重新挂载：从这里打开工具、在终端里聊完再切回来，「接着上次」和大卡上
  // 「上次 …」还是打开前读的那份。刚聊的那条不在，「继续对话」还挂在同一文件夹更早的那条上，
  // 而 Claude Code、Grok CLI 续接是按文件夹找最近一条（#292），点下去接上的是刚聊的那条。
  // 所以窗口回到前面时再读一次：一分钟内又没打开过工具，toolsApi 给的还是原来那一份，不读盘，页面也不变。
  useEffect(() => {
    function foreground() {
      if (document.visibilityState !== 'hidden') setRecentAttempt((value) => value + 1)
    }
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [])
  const tools = snapshot ? presentTools(snapshot) : []
  const installed = tools.filter((tool) => tool.status.installed || jobs[tool.id])
  // 检测失败的不当成没装：那张卡写「检测失败」、给「重新检测」，不当成没装的灰卡。
  const undetected = (tool: ToolPresentation) => !tool.status.installed && !jobs[tool.id] && Boolean(tool.error)
  const external = presentExternalClients(props.externalClients)
  // 开机先摆的是上次落盘的客户端检测结果（cachedAt），真的那轮排在首屏扫描之后才开始（已知13）。
  // 这时同正在重新检测：那几张卡的按钮先等着，「正在检测」那一句照旧挂着。
  const externalCached = external.some((tool) => Boolean(tool.status.cachedAt))
  const externalBusy = props.externalLoading || externalCached
  const undetectedExternal = (tool: ExternalPresentation) => !tool.status.installed && !jobs[tool.id] && Boolean(tool.status.detectionError)
  const installedExternal = external.filter((tool) => tool.status.installed || jobs[tool.id])
  const installedCount = installed.length + installedExternal.length
  const undetectedCount = tools.filter(undetected).length + external.filter(undetectedExternal).length
  // 第一次检测还没回来：工具区只放灰色占位。
  const firstScan = loading && !snapshot
  const dollars = balance && balance.quotaPerUnit > 0 ? balance.quota / balance.quotaPerUnit : null
  const subscription = props.subscription ?? null
  const subscriptionUnknown = props.subscriptionUnknown === true
  const usageDollars = (quota: number) => balance && balance.quotaPerUnit > 0 ? quota / balance.quotaPerUnit : null
  const weekUsd = usage ? usageDollars(usage.weekQuota) : null
  const runway = account ? buildBalanceRunway({ walletUsd: dollars, subscription, subscriptionUnknown, weekUsageUsd: weekUsd }) : null
  const moneyNotice = props.supportsBilling !== false ? homeMoneyNotice(dollars, subscription, runway, subscriptionUnknown) : null
  const walletEmpty = homeWalletEmpty(dollars, subscription, props.supportsBilling !== false, subscriptionUnknown)
  const toolRequest = homeToolRequest(Boolean(account), props.supportsKeys)
  const bootstrapResult = props.bootstrap?.result
  const bootstrapFailed = bootstrapResult?.failed ?? []
  const bootstrapWarnings = bootstrapResult ? homeBootstrapWarnings(bootstrapResult, tools) : []
  // 只是跟着连接线路换了地址的那一轮不说「已给…配好密钥」（yoyo 10-8），没写成、有要留意的照常说。
  const bootstrapNoticeWanted = Boolean(bootstrapResult && (bootstrapFailed.length || bootstrapWarnings.length
    || (bootstrapResult.configured.length && !bootstrapOnlyFollowedRoute(bootstrapResult))))
  const configFailure = props.failures?.find((failure) => failure.partition === 'config') ?? null
  // Git 是可选环境：只在探到「确实没装」时提示（探测失败按 A4 显示失败、不当没装）。
  const gitHost = gitHostPlatform(snapshot?.platform.platform ?? 'other')
  const gitStatus = snapshot?.system.runtime.git
  const gitMissing = Boolean(gitStatus && !gitStatus.installed && !gitStatus.detectionFailed)
  // macOS 上 Python 归客户自己装（platform.pythonRuntimeInstall === 'external'）：
  // 按钮点下去只是开网页，所以这里补一段中文步骤，别让人以为应用正在替他装。
  // Node.js 在 Mac 上由应用准备（第十六批 2），只在点之前说一句会发生什么。
  // 探测失败时不给这段：那时候并不知道它装没装，「没有找到」是假话（同 Git 那一行 A4）。
  const nodeMissing = Boolean(snapshot && !snapshot.system.runtime.node.installed && !snapshot.system.runtime.node.detectionFailed)
  const pythonMissing = Boolean(snapshot && !snapshot.system.runtime.python.installed && !snapshot.system.runtime.python.detectionFailed)
  const runtimeUndetected = !loading && Boolean(snapshot && (snapshot.system.runtime.node.detectionFailed || snapshot.system.runtime.python.detectionFailed))
  const nodeGuide = nodeMissing ? runtimeInstallGuide('node', snapshot?.platform.platform, snapshot?.platform.nodeRuntimeInstall) : null
  const pythonGuide = pythonMissing ? runtimeInstallGuide('python', snapshot?.platform.platform, snapshot?.platform.pythonRuntimeInstall) : null
  const nodeManagedNotice = nodeMissing ? managedRuntimeNotice('node', snapshot?.platform.platform, snapshot?.platform.nodeRuntimeInstall) : null
  // 「在用」= 装了、正在装，或这次没查出来装没装（A4，不当没装）。正在装要算上：装工具时
  // 星芒会顺带准备 Node.js，那会儿要看见的正是弹授权窗口那句。
  const inUse = (tool: ToolPresentation) => tool.status.installed || tool.status.detectionFailed === true || Boolean(jobs[tool.id])
  // 一个命令行工具都不在用（只装了 Codex 桌面端，它自带运行环境）时，Node.js 和 Python、Git 一样
  // 只是可选：那一行不挂橙点，下面的说明也不用橙字。以前这类客户每次打开首页都是一个橙点、
  // 两段橙字，像有两件事没办好（第二十七批 B，A014 截图）。
  const nodeOptional = snapshot !== null && !tools.some((tool) => tool.id !== 'codexDesktop' && inUse(tool))
  // 缺 Git 那段讲的是 Claude Code（插件市场、技能和插件里的命令），没装它的客户不用看。
  const claudeInUse = tools.some((tool) => tool.id === 'claude' && inUse(tool))
  // Windows 上 Node.js 是机器级 MSI，准备它必然弹一次 UAC。说在点之前，
  // 不是弹窗跳出来之后（Python 按当前用户装，没有这句）。
  const nodeElevationNotice = nodeMissing
    ? homeNodeElevationNotice(snapshot?.platform.platform, snapshot?.platform.nodeRuntimeInstall, nodeOptional, snapshot?.platform.processElevated)
    : null
  const runtimeHintClass = nodeOptional ? 'v2-runtime-hint is-quiet' : 'v2-runtime-hint'
  const bootstrapBusy = Boolean(props.bootstrap && !props.bootstrap.result && !props.bootstrap.error)
  // 「已给…配好密钥」那句到点收起（见 bootstrapNoticeExpiresAt）。首页每次进来都重新挂上，「现在」从挂上那一刻算，
  // 回到首页时已经过了点的就不再冒出来；挂着的时候到点叫一次重画。开着的工具等着换线路的那几条已经由上方
  // 那句总的说了，不算横幅里还要客户动手的。
  const bootstrapNoticeUntil = bootstrapNoticeExpiresAt(props.bootstrap?.result
    ? { ...props.bootstrap, result: { ...props.bootstrap.result, failed: bootstrapFailed, warnings: bootstrapWarnings } }
    : props.bootstrap)
  const [bootstrapNoticeClock, setBootstrapNoticeClock] = useState(() => Date.now())
  useEffect(() => {
    if (bootstrapNoticeUntil === null) return
    const remaining = bootstrapNoticeUntil - Date.now()
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setBootstrapNoticeClock(Math.max(Date.now(), bootstrapNoticeUntil)), remaining)
    return () => window.clearTimeout(timer)
  }, [bootstrapNoticeUntil])
  const bootstrapNoticeShown = bootstrapNoticeUntil === null || bootstrapNoticeClock < bootstrapNoticeUntil
  // 改用 CF 那句只留半小时：到点重画一次把它收起。
  const hijackUntil = props.toolRouteStatus?.hijack ? props.toolRouteStatus.hijack.id + toolRouteHijackShownMs : null
  const [routeClock, setRouteClock] = useState(() => Date.now())
  useEffect(() => {
    if (hijackUntil === null) return
    setRouteClock(Date.now())
    const remaining = hijackUntil - Date.now()
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setRouteClock(Date.now()), remaining)
    return () => window.clearTimeout(timer)
  }, [hijackUntil])
  const routeTexts = toolRouteHomeTexts(props.toolRouteStatus, routeClock)
  const launchWaitingForAccount = useCallback((provider: ProviderId): boolean => {
    const tool = tools.find((entry) => entry.provider === provider)
    if (!tool || tool.source === 'official' || tool.source === 'manual') return false
    return accountKeyChangeInProgress(props.bootstrap ?? null, provider)
  }, [props.bootstrap, tools])
  // 命令行工具和 Codex 桌面端的「打开」一次只放一个（useToolLaunch 的 launchRequest）。外接客户端的打开不算：
  // 主进程里它们和别人互不等待（I11 的登记例外），那一行只看自己那家的打开（#1085）。停在等账号那一轮的
  // 那次「打开」也不算（最长 3 分钟，0.2.22 打磨 B4）：它只占自己那张卡，别的工具照常能开。
  const launchBusy = toolRegistry.some((tool) => jobs[`launch:${tool.id}`] && !launchWaitingForAccount(providerFor(tool.id)))
  // 开机先摆的是上次的检测结果（cachedAt），真结果还在路上。这时只放开「打开」这一类：
  // 点下去配置现读、工具由主进程现找、目录现查，用不上这份旧结果。「安装」「重新配置」
  // 「确认连接」照旧等真结果；账号这一轮要换 Key 的那一家也等，免得带着旧 Key 打开。
  const cachedPhase = loading && Boolean(snapshot?.system.cachedAt)
  function launchReadyBeforeScan(tool: ToolPresentation): boolean {
    if (!cachedPhase || !tool.status.installed || tool.error || !tool.configured || configFailure) return false
    if ([tool.id, `launch:${tool.id}`, `switch:${tool.id}`, `repair-hooks:${tool.id}`, `repair-config:${tool.provider}`].some((key) => jobs[key])) return false
    return !accountKeyChangePending({ signedIn: account !== null, restoring: props.accountRestoring === true, bootstrap: props.bootstrap ?? null }, tool.provider)
  }
  // 「继续对话」点下去走的是同一个「打开」，跟着它那一行走。
  function resumeReadyBeforeScan(provider: ProviderId): boolean {
    const tool = tools.find((entry) => entry.id === provider)
    return tool !== undefined && launchReadyBeforeScan(tool)
  }
  // 「继续对话」与记录页同一条规则(#292):续接参数是 CLI 按工作目录找最近一条,
  // 不按会话 id 挑,所以按钮只能长在每个(工具 × 目录)组合最近的那条上,否则
  // 用户点第三条、接上的却是第一条。判断用的是整份最近记录(api.recent 一次取
  // 60 条),不是卡片上显示的那 3 条。
  const resumable = latestSessionIdsByWorkspace(recent?.items ?? [])
  const usedTools = new Set<ProviderId>((recent?.items ?? []).map((session) => session.provider))
  // Codex 装好了就等「最近」读完再决定，免得用过 Codex 的人先看到「第一次用 Codex？」、一眨眼又没了；读不到记录时照旧给。
  const codexInUse = tools.some((tool) => tool.provider === 'codex' && tool.status.installed) && (usedTools.has('codex') || (recent === null && !recentError))
  // 记录读不到时当作谁都没用过，照旧给卡。
  const firstRunTool = pickFirstRunTool(installed, jobs, firstRunDismissed, recent !== null || recentError ? usedTools : null)
  const firstRun = firstRunTool ? firstRunOf(firstRunTool.id) : undefined
  const os = snapshot ? windowOsFor(snapshot.platform.platform) : currentWindowOs()

  /**
   * 一张命令行工具卡要的全部判断。卡片和顶部大卡共用这一份：大卡上的「打开」就是卡片上的那颗，
   * 两边写的状态、能不能点必须一样。
   */
  function toolState(tool: ToolPresentation) {
    const installJob = jobs[tool.id]
    const launchJob = jobs[`launch:${tool.id}`]
    const switchJob = jobs[`switch:${tool.id}`]
    const repairJob = jobs[`repair-hooks:${tool.id}`] ?? jobs[`repair-config:${tool.provider}`]
    const job = launchJob ?? switchJob ?? repairJob ?? installJob
    const config = snapshot?.config.providers[tool.provider]
    // 配置那一块没读到时，连接状态是未知而不是「还没配 Key」，
    // 否则用户会以为自己的配置丢了。工具本身的安装、卸载不受影响。
    const configUnavailable = !tool.error && tool.status.installed && configFailure !== null
    // 开机先画出来的是上次的检测结果（cachedAt），装没装、配置归谁都可能已经变了，
    // 这时不下「被改过」「第三方配置」的结论，真结果回来再说。
    // 这次写 Key 时服务端说这个账号没开通它：再点「配置」也配不上，别显示成「还没配 Key」。
    const notEnabled = props.bootstrap?.result?.failed.some((entry) => entry.provider === providerFor(tool.id)
      && isAccountNotEnabledFailure(entry.message)) === true
    const ownershipPending = snapshot !== null && (Boolean(snapshot.system.cachedAt) || ownershipAwaitingAccount(snapshot.config, tool))
    const settled = Boolean(config) && !ownershipPending
    const ccSwitch = config && settled ? ccSwitchLeftoverFor(config, tool.provider, tool.source) : null
    const foreignKey = config && settled ? foreignKeyKind(config, tool.source) : null
    const shadowed = Boolean(config) && settled && codexNeedsRepair(config!, tool.provider)
    // 修完就能用的，「打开」照旧给：点下去先修再打开（App 的 launch），不让人先去配置里绕一圈。
    const repairLaunch = shadowed && readyOnceRepaired(config!, tool.provider)
    // 认不出来路的那份（R1）星芒不替它跑：「打开」和挑文件夹那几项都不给，卡上换成「使用星芒安装」。
    const unrecognized = !tool.error && isUnrecognizedInstall(tool.status)
    const openable = (tool.configured || repairLaunch) && !unrecognized
    const hooksStale = Boolean(config) && settled && cliHooksNeedRepair(config!)
    const hooksDetail = config?.cliHooksShellChanged ? cliHooksShellChangedDetail : cliHooksStaleDetail
    const hooksAutoRepaired = Boolean(config) && settled && cliHooksWereAutoRepaired(config!)
    const hooksMissing = Boolean(config) && settled && cliHooksMissing(config!)
    // 工具自己都读不了的文件，里面读出来的 Key、来源都不作数，排在那些判断前面先说。
    const broken = config && settled ? brokenConfigOf(config, tool.provider) : null
    const installFailure = !tool.status.installed && !installJob && !tool.error ? props.installFailures?.[tool.id] ?? null : null
    const updateFailure = tool.id === 'codexDesktop' && tool.status.installed && !installJob && !tool.error && props.desktopUpdateFailures?.codexDesktop !== undefined
    const status = installJob ? 'installing' as const : tool.error ? 'detectionFailed' as const : !tool.status.installed ? 'missing' as const
      : configUnavailable ? 'configUnavailable' as const
      : broken ? 'configBroken' as const
      : ccSwitch ? 'ccSwitch' as const
      : shadowed ? 'codexShadowed' as const
      : tool.source === 'changed' && !ownershipPending ? 'configChanged' as const
      : foreignKey === 'otherSite' ? 'otherSiteKey' as const : foreignKey === 'otherAccount' ? 'otherAccountKey' as const
      : tool.source === 'unknown' && !ownershipPending ? 'unknownSource' as const
      : hooksStale ? 'cliHooksStale' as const : tool.source === 'official' ? 'official' as const
        : bootstrapBusy && !tool.configured ? 'configuring' as const
        : tool.configured ? 'ready' as const : notEnabled ? 'notEnabled' as const : 'unconfigured' as const
    // 用当前账号连着的工具在余额 $0 时打开了也用不了，发第一句话就报错，而卡上还是一颗深色「打开」，
    // 跟上面「余额是 $0」那条打架（主路卡点 F4）。角标换「余额为零」、主按钮换「前往充值」，「打开」照样能点。
    // status 不改：提醒设置没写上那些「已配好」底下的判断照旧。官方账号、自己填的密钥不扣这份余额，不变。
    const zeroBalance = walletEmpty && status === 'ready' && tool.source === 'account'
    // 「打开」以前每次都要重新选一遍目录。会话记录里本来就存着用过的目录，拿它当「打开」的默认值，
    // 「…」里再给原来的选择器（N7）。这个工具还没有记录时用上次在本软件里选过的文件夹，
    // 几个命令行工具合起来只问一次；设置页刚换过项目文件夹、之后还没用过这个工具的，先进换的那个（Q1）。
    // Codex 桌面端自己管工作区，不走这条路。
    const opensWorkspace = !configUnavailable && !tool.error && tool.status.installed
      && openable && tool.id !== 'codexDesktop'
    const workspaces = opensWorkspace
      ? launchWorkspaces(recent?.items ?? [], tool.provider, snapshot?.config.rememberedWorkspace, snapshot?.config.rememberedWorkspaceChosenAt)
      : []
    const lastWorkspace = job ? null : workspaces[0] ?? null
    // 这个工具没聊过、也从没选过文件夹（已知40）：「打开」直接替他建好项目文件夹在里面打开，
    // 判法跟引导最后一步共用（startsInNewFolder）。
    const startsFresh = opensWorkspace && startsInNewFolder(recent, tool.provider, workspaces) && Boolean(props.onLaunchInNewFolder)
    // 归客户自己装的（认不出芯片的 Mac 上的 Codex 桌面端）这颗按钮只能把人带到教程：写「安装」就是骗人。
    const manualInstall = !tool.status.installed && needsManualInstall(snapshot, tool.id)
    // Codex 桌面端在 Windows 上是 Appx，装它要提权；命令行工具走 npm，不提权。
    const elevationHint = tool.id === 'codexDesktop' && !tool.status.installed
      ? elevatedInstallShortNotice('codexDesktop', snapshot?.platform.platform, snapshot?.platform.codexDesktop.install, snapshot?.platform.processElevated)
      : null
    const waitingForScan = loading && !launchReadyBeforeScan(tool)
    // 扫描结束后仍可能在写入和复核新线路，旧配置不能在这段时间被工具读走。
    const waitingForAccount = openable && launchWaitingForAccount(tool.provider)
    const primaryLabel = launchJob ? '打开中' : installJob ? '安装中' : unrecognized ? '使用星芒安装' : configUnavailable ? '重新配置'
      : bootstrapBusy && !tool.configured ? '配置中' : tool.error ? '重新检测' : !tool.status.installed ? installFailure ? '重试' : manualInstall ? '安装指南' : '安装'
      : openable ? '打开' : status === 'notEnabled' && props.onHelp ? '联系客服' : '确认连接'
    const primary = () => unrecognized ? props.onInstall(tool.id) : configUnavailable ? props.onConfigure(tool.id) : tool.error ? props.onScan() : !tool.status.installed ? props.onInstall(tool.id)
      // 账号没开通的，「确认连接」点进去是配置框，帮不上忙：换成去找客服（主路卡点 F5）。
      : !openable ? status === 'notEnabled' && props.onHelp ? props.onHelp() : props.onConfigure(tool.id)
      : startsFresh ? props.onLaunchInNewFolder?.(tool.id, true) : props.onLaunch(tool.id, lastWorkspace?.path)
    const primaryDisabled = Boolean(switchJob || repairJob) || waitingForScan || waitingForAccount || launchBusy || (bootstrapBusy && !tool.configured && !configUnavailable)
    // 文件坏了时读出来的来源不作数（见 brokenConfigOf），不说成官方账号。
    const officialLine = tool.source === 'official' && !broken && config ? officialAccountSubtitle(config, Date.now()) : null
    // Codex 用官方账号却还没用 ChatGPT 登录：写「官方账号待登录」，别让人以为已经能用。
    const officialPending = tool.provider === 'codex' && config?.codexAuthMode !== 'chatgpt' && !config?.officialAccountPlan
    // 配置里实际写的星芒线路（xm 三线路 C12）；codexDesktop 读的是 Codex 那份配置，标签跟着一起显示。
    const routeLabel = config && !broken && !ownershipPending ? toolRouteLabel(config, tool.source) : null
    const sourceLabel = sourceChipLabels[tool.source === 'official' || tool.source === 'manual' ? tool.source : 'account']
    return { installJob, launchJob, switchJob, repairJob, job, config, configUnavailable, status, zeroBalance, broken, ccSwitch, foreignKey, shadowed, unrecognized, openable,
      hooksStale, hooksDetail, hooksAutoRepaired, hooksMissing, installFailure, updateFailure, opensWorkspace, workspaces, lastWorkspace, startsFresh, manualInstall,
      elevationHint, waitingForScan, waitingForAccount, primaryLabel, primary, primaryDisabled, officialLine, officialPending, routeLabel, sourceLabel,
      ownershipPending }
  }
  type ToolState = ReturnType<typeof toolState>

  /** 装好以后卡片中间那行：「线路2 · 模型 · v版本」，官方账号写套餐和续期。 */
  function versionLine(tool: ToolPresentation, state: ToolState): { text: string; title?: string } {
    const version = versionText(tool.currentVersion)
    if (state.officialLine) {
      const head = state.officialPending && !snapshot?.config.providers[tool.provider].officialAccountPlan ? '官方账号待登录' : state.officialLine.text
      return { text: `${head} · ${version}`, title: state.officialLine.renewal }
    }
    return { text: [state.routeLabel?.text, tool.model || null, version].filter(Boolean).join(' · '), title: state.routeLabel?.hint }
  }

  function sourceMenu(tool: ToolPresentation, state: ToolState): ReactNode {
    const name = toolRegistry.find((entry) => entry.id === tool.id)?.name ?? tool.name
    const switchable = Boolean(props.onSwitchAccount) && !state.ownershipPending && !state.configUnavailable && !state.broken && !tool.error
    const config = state.config
    const items = buildSourceMenuItems({ tool: tool.id, provider: tool.provider,
      account: { checked: tool.source === 'account', disabled: !switchable && tool.source !== 'account',
        onSelect: () => { if (tool.source !== 'account') props.onSwitchAccount?.(tool.id, 'account') } },
      official: { checked: tool.source === 'official', disabled: !switchable && tool.source !== 'official',
        signedIn: config?.officialAccountEmail ? [config.officialAccountEmail, config.officialAccountPlan].filter(Boolean).join('，') : null,
        onSelect: () => { if (tool.source !== 'official') props.onSwitchAccount?.(tool.id, 'official') } },
      manual: { checked: tool.source === 'manual', onSelect: () => props.onConfigure(tool.id) },
      more: { onSelect: () => props.onConfigure(tool.id) } })
    return <SourceMenu tool={tool.id} name={name} chip={state.sourceLabel} items={items} />
  }

  /**
   * 星芒卸不了的桌面端（外接客户端、Mac 上的 Codex 桌面端）在「…」里也放「卸载…」，点了弹框说
   * 在系统里怎么删；Windows 上的 Codex 桌面端星芒自己能卸，不走这里。
   */
  function uninstallGuideItems(tool: UninstallGuideTool, name: string, path: string | null): MenuItem[] {
    const guide = buildUninstallGuide(tool, name, os, path)
    return guide ? [{ label: '卸载…', danger: true, testId: `tool-${tool}-uninstall-guide`, onSelect: () => setUninstallGuide(guide) }] : []
  }

  function managedInstall(id: ToolId): boolean {
    return (id === 'codexDesktop' ? snapshot?.platform.codexDesktop?.install : snapshot?.platform.cliInstall?.[id]) === 'managed'
  }

  function toolMenu(tool: ToolPresentation, state: ToolState): Array<MenuItem | MenuNote | 'divider'> | undefined {
    if (!tool.status.installed || state.job) return undefined
    const launchBlocked = state.waitingForScan || state.waitingForAccount || launchBusy
    const rollback = rollbackVersion(tool)
    const revert = revertVersion(tool)
    const update = toolUpdateOffer(tool)
    const blocked = tool.versionAdvice?.blockedReason ?? null
    const externalManaged = updatesOutsideApp(tool.id, tool.status)
    // 配置那一块没读到时来源是未知的，不给切换，免得在一份没读到的配置上做决定。
    // 账号还在恢复时来源同样没判定（见 ownershipAwaitingAccount），等恢复完再给。
    // Codex 读不了的文件，切换只会在合并那一步报错，出路是卡上的「立即修复」。
    const switchTarget = state.configUnavailable || state.broken || tool.error || state.ownershipPending ? null : accountSwitchTarget(tool)
    // 被拦着的那几种（配置坏了、被改过……）和余额为零，卡上只放修的那颗按钮，还能用的话「打开」挪进这里。
    const blockedOpen = state.openable && (state.zeroBalance || ['configBroken', 'configChanged', 'ccSwitch', 'otherSiteKey'].includes(state.status))
    // 这个工具聊过（记录还没读到时说不准，照旧给）才有「接着之前的对话…」。以前这里列的是最近几个文件夹的
    // 整条路径，点了是在那里开新对话，客户看着像对话记录又看不懂（yoyo 10-16）；v4 原型这里也没有那一串。
    const conversationsOffered = state.opensWorkspace && (recent === null || recent.stats.byProvider[tool.provider] > 0)
    const groups: Array<Array<MenuItem | MenuNote>> = [
      // 故意改过配置的人也要有出路，否则那颗黄牌会一直挂着。认下之后这个工具
      // 就按「自己填写的密钥」处理，下次在配置里改回当前账号时标记自动清掉。
      (state.status === 'configChanged' || state.status === 'ccSwitch') && props.onKeepConfig
        ? [{ label: '保留当前配置', testId: `tool-${tool.id}-keep-config`, onSelect: () => props.onKeepConfig?.(tool.id) }] : [],
      [
        ...(blockedOpen ? [{ label: '打开', testId: `tool-${tool.id}-open`, disabled: launchBlocked, onSelect: state.primary }] : []),
        ...(conversationsOffered ? [{ label: conversationsMenuLabel, testId: `tool-${tool.id}-conversations`, onSelect: () => setConversationsTool(tool.id) }] : []),
        // 还没有最近目录、「打开」已经替人新建项目文件夹时（已知40），这里只给「选择其他文件夹…」；
        // 记录还没读到、「打开」还是弹选择框的那一小会儿，反过来只给新建入口。
        ...(state.opensWorkspace && (state.lastWorkspace || (state.startsFresh && props.onLaunchInNewFolder))
          ? [{ label: chooseWorkspaceLabel, testId: `tool-${tool.id}-choose-workspace`, disabled: launchBlocked, onSelect: () => props.onLaunch(tool.id) }] : []),
        ...(state.opensWorkspace && props.onLaunchInNewFolder && !state.startsFresh
          ? [{ label: newWorkspaceLabel, testId: `tool-${tool.id}-new-workspace`, disabled: launchBlocked, onSelect: () => props.onLaunchInNewFolder?.(tool.id) }] : []),
      ],
      [
        { label: '配置…', testId: `tool-${tool.id}-configure`, onSelect: () => props.onConfigure(tool.id) },
        ...(switchTarget && props.onSwitchAccount ? [{ label: switchTarget === 'account' ? useAccountLabel : '切回官方账号', testId: `tool-${tool.id}-switch-${switchTarget}`, onSelect: () => props.onSwitchAccount?.(tool.id, switchTarget) }] : []),
        ...(tool.provider === 'codex' ? [{ label: '切换模型服务…', testId: tool.id === 'codex' ? 'home-codex-models' : 'home-codexDesktop-models', onSelect: props.onCodexModels }] : []),
        ...(tool.provider === 'codex' && tool.source === 'official' ? [{ label: 'ChatGPT 账号额度…', testId: `tool-${tool.id}-official-quota`, onSelect: () => { setOfficial(snapshot?.system.officialChatGpt ?? null); setOfficialOpen(true) } }] : []),
        // 手机遥控的入口（YF-6），0.2.25 起是左侧栏单独一页。遥控用的是 Codex CLI，桌面端不给。
        ...(tool.id === 'codex' ? [{ label: remoteMenuLabel, testId: 'tool-codex-remote', onSelect: () => props.onNavigate('remote') }] : []),
      ],
      [
        ...(!externalManaged && update?.newer && !blocked && update.target ? [{ label: `更新到 ${versionText(update.target)}`, testId: `tool-${tool.id}-update-menu`, onSelect: () => props.onInstall(tool.id, update.version ?? update.target ?? undefined, 'update') }] : []),
        ...(!externalManaged && rollback && !blocked && !(update?.newer && update.target === rollback) ? [{ label: `${recommendedVersionVerb(tool)}推荐版本 ${versionText(rollback)}…`, testId: `tool-${tool.id}-rollback-menu`, onSelect: () => props.onInstall(tool.id, rollback, 'rollback') }] : []),
        // 推荐版本本身在这台电脑上出问题时，「回到推荐版本」帮不上忙：他就在推荐版本上。
        // 与上一项指向同一个版本时不重复给。
        ...(revert && revert !== rollback && props.onRevert ? [{ label: `回退到更新前的 ${versionText(revert)}…`, testId: `tool-${tool.id}-revert`, onSelect: () => props.onRevert?.(tool.id, revert) }] : []),
        // 「安装卸载」页拆掉以后重装从这里点（问2）：同那一页的「重新安装」，版本由主进程按已验证名单定。
        // 别的软件管着的、星芒装不了的不给，同那一页。
        ...(!externalManaged && !tool.error && !state.unrecognized && managedInstall(tool.id) ? [{ label: '重新安装', testId: `tool-${tool.id}-reinstall`, onSelect: () => props.onInstall(tool.id) }] : []),
        // 界面上一直只把配置路径写成一行灰字，而 `.` 开头的目录在资源管理器和
        // 访达里默认都看不见，用户和客服只能手敲路径。
        ...(props.onOpenConfigDirectory ? [{
          ...configDirectoryMenuItem(tool, state.configUnavailable),
          testId: `tool-${tool.id}-open-config-directory`,
          onSelect: () => props.onOpenConfigDirectory?.(tool.id),
        }] : []),
        { label: '查看记录', testId: `tool-${tool.id}-sessions`, onSelect: () => props.onNavigate('sessions') },
      ],
      canUninstallTool(tool.status, tool.id === 'codexDesktop' && snapshot?.platform.codexDesktop.uninstall === true)
        ? [{ label: '卸载…', danger: true, testId: `tool-${tool.id}-uninstall`, onSelect: () => props.onUninstall(tool.id) }]
        : tool.id === 'codexDesktop' ? uninstallGuideItems(tool.id, tool.name, tool.status.path) : [],
    ]
    return groups.filter((group) => group.length > 0).flatMap((group, index) => index ? ['divider' as const, ...group] : group)
  }

  /**
   * 卡片中间那行下面的一行小字链接：先给修的（修好它、补上、改用当前账号），没有要修的再给
   * 「v… 有已知问题，回到 v…」或「可更新到 v…」。别的软件管着的安装只给一句说明，点不了。
   */
  function toolLink(tool: ToolPresentation, state: ToolState): ReactNode {
    if (state.job || state.unrecognized) return null
    const repairBusy = Boolean(state.repairJob)
    if (state.status === 'codexShadowed' && props.onSwitchAccount) {
      return <button type="button" className="xm-tool-card-link" title="修改前将自动备份原设置" onClick={() => props.onSwitchAccount?.(tool.id, 'account')} data-testid={`tool-${tool.id}-repair-codex`}><span>立即修复</span></button>
    }
    if (state.status === 'cliHooksStale' && props.onRepairHooks) {
      return <button type="button" className="xm-tool-card-link" title="修改前将自动备份原设置" disabled={repairBusy} onClick={() => props.onRepairHooks?.(tool.id)} data-testid={`tool-${tool.id}-repair-hooks`}><span>立即修复</span></button>
    }
    if (state.status === 'otherAccountKey' && props.onSwitchAccount) {
      return <button type="button" className="xm-tool-card-link" onClick={() => props.onSwitchAccount?.(tool.id, 'account')} data-testid={`tool-${tool.id}-use-account`}><span>{useAccountLabel}</span></button>
    }
    if (state.status === 'ready' && state.hooksMissing) {
      return <button type="button" className="xm-tool-card-link" title="修改前将自动备份原设置" onClick={() => nodeMissing ? props.onRuntime('node') : props.onRepairHooks?.(tool.id)} data-testid={`tool-${tool.id}-add-hooks`}><span>启用</span></button>
    }
    const rollback = rollbackVersion(tool)
    const update = toolUpdateOffer(tool)
    const blocked = tool.versionAdvice?.blockedReason ?? null
    // 原生/其他来源装的 CLI 不走本工具的 npm 通道，不给 npm 更新/回滚，
    // 该更新时改用一句被动提示，避免在 npm 全局目录另装一份并存。官方安装器装的
    // Claude Code 例外：照给，点了先问一句、卸掉再装（App.tsx 的 install）。
    if (updatesOutsideApp(tool.id, tool.status)) {
      const hint = externalInstallHint(tool.status.installSource)
      return hint && (tool.updateAvailable || (rollback && blocked))
        ? <span className="v2-tool-external-note" title={hint} data-testid={`tool-${tool.id}-external-managed`}>{hint}</span> : null
    }
    if (rollback && blocked) {
      return <button type="button" className="xm-tool-card-link is-warn" title={blocked} onClick={() => props.onInstall(tool.id, rollback, 'rollback')} data-testid={`tool-${tool.id}-rollback`}>
        <TriangleAlert size={12} aria-hidden="true" /><span>{`${versionText(tool.currentVersion)} 有已知问题，${recommendedVersionVerb(tool)} ${versionText(rollback)}`}</span></button>
    }
    if (update?.newer) {
      return <button type="button" className="xm-tool-card-link" title={updateButtonHint(tool)} onClick={() => props.onInstall(tool.id, update.version ?? update.target ?? undefined, 'update')} data-testid={`tool-${tool.id}-update`}>
        <RefreshCw size={12} aria-hidden="true" /><span>{update.target ? `可更新到 ${versionText(update.target)}` : '更新'}</span></button>
    }
    return null
  }

  function renderTool(tool: ToolPresentation) {
    const state = toolState(tool)
    const { installJob, job, status } = state
    const name = toolRegistry.find((entry) => entry.id === tool.id)?.name ?? tool.name
    const [statusText, statusTone] = statuses.tool[state.zeroBalance ? 'zeroBalance' : status]
    // 字包一层 span 才有省略号（components.css 的 .xm-tool-card-badge），被截时悬停看全文。
    const statusPill = <Pill tone={statusTone} dot><span title={statusText}>{statusText}</span></Pill>
    const repairBusy = Boolean(state.repairJob)
    const fixButton = status === 'configBroken' && props.onRepairConfig
      ? <Button variant="secondary" size="sm" loading={repairBusy} title="修改前将自动备份原设置" onClick={() => props.onRepairConfig?.(tool.id)} testId={`tool-${tool.id}-repair-config`}>{repairBusy ? '正在修复' : '立即修复'}</Button>
      : status === 'configChanged' && props.onRewriteKey
        // 写密钥那一轮在跑（点了这颗、或别处触发的）时转圈，不让再点。
        ? <Button variant="secondary" size="sm" loading={bootstrapBusy} disabled={bootstrapBusy} onClick={() => props.onRewriteKey?.(tool.id)} testId={`tool-${tool.id}-rewrite-key`}>{bootstrapBusy ? '正在写入' : '重新写入密钥'}</Button>
      : status === 'ccSwitch' && props.onSwitchAccount
        ? <Button variant="secondary" size="sm" onClick={() => props.onSwitchAccount?.(tool.id, 'account')} testId={`tool-${tool.id}-replace-cc-switch`}>{useAccountLabel}</Button>
      : status === 'otherSiteKey' && props.onSwitchAccount
        ? <Button variant="secondary" size="sm" onClick={() => props.onSwitchAccount?.(tool.id, 'account')} testId={`tool-${tool.id}-use-account`}>{useAccountLabel}</Button>
        : null
    // 中间那行：进行中的写进度；出了问题写原因；没装写一句介绍；装好写线路、模型和版本。
    const line = tool.status.installed ? versionLine(tool, state) : null
    const detail = state.switchJob ? null
      : installJob ? `${props.installIntents?.[tool.id] ? installIntentPrefix(props.installIntents[tool.id]) : desktopUpdatePrefix(tool.id === 'codexDesktop' ? props.desktopUpdateTargets?.codexDesktop : undefined)}${installJob.label}`
      : job?.label ?? tool.error
      ?? (state.installFailure ? `安装失败：${state.installFailure.reason.replace(/[。.\s]+$/, '')}，已还原`
        : state.updateFailure ? desktopUpdateFailedLine
        : state.unrecognized ? unrecognizedInstallDetail
        : status === 'configBroken' && state.broken ? brokenConfigDetails[state.broken]
        : status === 'configChanged' ? configChangedDetail
        : status === 'codexShadowed' ? codexShadowedDetail
        : status === 'cliHooksStale' ? state.hooksDetail
        : status === 'ccSwitch' && state.ccSwitch ? ccSwitchDetails[state.ccSwitch]
        : state.foreignKey && status !== 'ccSwitch' ? foreignKeyDetails[state.foreignKey]
        : status === 'unconfigured' ? unconfiguredDetail
        : status === 'ready' && state.hooksMissing ? nodeMissing ? cliHooksMissingWithoutRuntimeDetail : cliHooksMissingDetail
        : !tool.status.installed ? state.elevationHint ?? homeToolBlurbs[tool.id]
        : tool.id === 'codexDesktop' ? tool.versionAdvice?.blockedReason ?? null : null)
    const metaTone = state.installFailure || state.updateFailure || status === 'detectionFailed' || status === 'configBroken' ? 'bad' as const
      : state.unrecognized || ['configChanged', 'ccSwitch', 'codexShadowed', 'cliHooksStale', 'otherSiteKey', 'otherAccountKey'].includes(status) ? 'warn' as const : undefined
    const meta = detail ?? line?.text ?? ''
    // 底下左边：切换中写在做什么；正常的是来源牌；出问题的是彩色小牌；没装的是灰字「未安装」。
    const badge = state.switchJob ? <span className="v2-tool-card-busy" role="status"><Spinner />{`${state.switchJob.label}…`}</span>
      : installJob ? typeof installJob.percent === 'number' ? undefined : <span className="v2-tool-card-busy" role="status"><Spinner label={installJob.label} /></span>
      : state.installFailure && props.onShowInstallFailure ? <Button variant="ghost" size="sm" onClick={() => props.onShowInstallFailure?.(tool.id)} testId={`tool-${tool.id}-why`}>查看原因</Button>
      : state.updateFailure && props.onShowDesktopUpdateFailure ? <Button variant="ghost" size="sm" onClick={() => props.onShowDesktopUpdateFailure?.('codexDesktop')} testId={`tool-${tool.id}-why`}>查看原因</Button>
      // 认不出来路的那份（R1）跑不起来，切账号的来源牌帮不上忙，把地方让给「使用星芒安装」。
      : state.unrecognized ? null
      : status === 'missing' ? <span className="v2-tool-card-off">{statusText}</span>
      : (status === 'ready' && !state.zeroBalance) || status === 'official' ? sourceMenu(tool, state)
        : statusPill
    // 检测失败时按钮是「重新检测」，不配下载箭头（#1132）。「使用星芒安装」也不配：卡上放不下箭头加六个字。
    const primaryButton = <Button size="sm" variant={tool.status.installed ? 'primary' : 'secondary'} loading={Boolean(state.launchJob)}
      disabled={state.primaryDisabled}
      title={state.lastWorkspace ? `在 ${state.lastWorkspace.path} 打开` : undefined}
      icon={!tool.status.installed && !tool.error && !state.manualInstall && !state.installFailure ? Download : undefined}
      onClick={state.primary} testId={`tool-${tool.id}-primary`}>{state.primaryLabel}</Button>
    // 卡底下放不下两颗按钮还不挤掉角标（一张卡约 235 宽）：同被拦着的那几种，「打开」在「…」第一项。
    // 从那里点了「打开」，打开的那一会儿照旧是转圈的「打开中」。
    const rechargeButton = state.zeroBalance && !state.job
      ? <Button size="sm" variant="primary" onClick={() => props.onNavigate('account', 'recharge')} testId={`tool-${tool.id}-recharge`}>前往充值</Button> : null
    const actions = installJob ? installJob.cancellable
      ? <Button variant="ghost" size="sm" icon={X} loading={installJob.cancelling} onClick={() => props.onCancelInstall(tool.id)} testId={`tool-${tool.id}-cancel`}>{installJob.cancelling ? '正在停止' : '取消'}</Button>
      : null
      : state.switchJob ? null
        // 程序都跑不起来时修配置、充值都帮不上忙，先给装的那颗；装好以后那几样照旧出来。
        : state.unrecognized ? primaryButton
          : fixButton ?? rechargeButton ?? primaryButton
    return <ToolCard key={tool.id} tool={tool.id} off={!tool.status.installed && !installJob && !tool.error} meta={meta} metaTone={metaTone}
      metaTitle={detail ?? line?.title ?? undefined} link={toolLink(tool, state)} badge={badge} actions={actions}
      progress={typeof installJob?.percent === 'number' ? installJob.percent : undefined}
      menu={toolMenu(tool, state)} menuLabel={`${spacedName(name)}更多操作`} testId={`tool-row-${tool.id}`} />
  }

  /** Claude Desktop 卡上的来源牌：和命令行工具那块同一套字（SourceMenu.tsx），只给当前账号和 Claude 账号两项。 */
  function externalSourceMenu(tool: ExternalPresentation, official: boolean): ReactNode {
    const items = buildSourceMenuItems({ tool: tool.id, provider: 'claude',
      account: { checked: !official, disabled: externalCached && official, onSelect: () => { if (official) props.onSwitchExternalSource?.(tool.id, 'account') } },
      official: { checked: official, disabled: externalCached && !official, onSelect: () => { if (!official) props.onSwitchExternalSource?.(tool.id, 'official') } },
      more: { disabled: externalCached, onSelect: () => props.onConfigureExternal(tool.id) } })
    return <SourceMenu tool={tool.id} name={tool.name} chip={sourceChipLabels[official ? 'official' : 'account']} items={items} />
  }

  function renderExternal(tool: ExternalPresentation) {
    const installJob = jobs[tool.id], launchJob = jobs[`launch:${tool.id}`], switchJob = jobs[`switch:${tool.id}`], job = launchJob ?? switchJob ?? installJob
    const status = installJob ? 'installing' as const : tool.status.detectionError ? 'detectionFailed' as const : !tool.status.installed ? 'missing' as const
      : tool.configurationStatus
    // macOS 上没有核对得了的官方 Mac 包的（主进程 macos-desktop-app-installer.ts 那张表之外，
    // installSupported 为假）要客户自己下载。原来按钮写「暂不支持」且点不动，客户看到的是
    // 死路一条；现在带他去教程里那一章（第七批 3）。表里有的照常「安装」。
    // WorkBuddy 不走这里：星芒不装、不给下载，没装时按钮是「重新检测」（external-model.ts，yoyo 2026-11-18「下线」）。
    const manualInstall = tool.action === 'install' && tool.disabled && snapshot?.platform.isMac === true
    // Windows 上缺系统安装组件时一键安装不了，与其留一颗点不动的「暂不支持」，
    // 不如直接把人送到官网下载页（网址由主进程给，白名单逐条收录）。
    const downloadUrl = tool.action === 'install' && tool.disabled && !manualInstall && props.onOpenExternalDownload ? tool.status.officialDownloadUrl ?? null : null
    const primaryLabel = launchJob ? '打开中' : installJob ? '安装中' : tool.action === 'scan' ? '重新检测' : tool.action === 'install' ? manualInstall ? '安装指南' : downloadUrl ? '前往官网下载' : tool.disabled ? '暂不支持' : '安装' : tool.action === 'launch' ? '打开' : '确认连接'
    const primary = () => manualInstall ? props.onNavigate('tutorial', macDesktopTutorialTopic) : downloadUrl ? props.onOpenExternalDownload?.(downloadUrl) : tool.action === 'scan' ? props.onScan() : tool.action === 'install' ? props.onInstallExternal(tool.id) : tool.action === 'launch' ? props.onLaunchExternal(tool.id) : props.onConfigureExternal(tool.id)
    const unsupported = tool.disabled && !manualInstall && !downloadUrl
    // Mac 上星芒换得了、存储桶里有更新的那一版：同命令行工具，卡片下面一行「可更新到 v…」。
    const updateTarget = !job && props.onUpdateDesktopApp ? externalUpdateTarget(tool.status) : null
    const updateFailed = !job && tool.status.installed && !tool.status.detectionError && props.desktopUpdateFailures?.[tool.id] !== undefined
    // 一键装不了（去官网下载、暂不支持）时，中间那行照旧写主进程给的那句该怎么办，不换成介绍。
    const jobLabel = job && job === installJob ? `${desktopUpdatePrefix(props.desktopUpdateTargets?.[tool.id])}${job.label}` : job?.label
    const meta = jobLabel ?? (updateFailed ? desktopUpdateFailedLine : status === 'missing' ? (downloadUrl || unsupported) && tool.status.installHint ? tool.status.installHint : homeToolBlurbs[tool.id]
      // 里面已经有一份别家的配置、只是没配全（Claude Desktop 的第三方推理）时，照旧写那一句，不笼统说没连上。
      : status === 'unconfigured' && tool.status.configurationSource !== 'other' && !tool.status.configurationError && !tool.status.detectionError ? unconfiguredDetail : tool.detail)
    const metaTone = status === 'detectionFailed' || tool.status.configurationError || updateFailed ? 'bad' as const : undefined
    // 只有 Claude Desktop 有两种登录可切；WorkBuddy、OpenCode 的来源牌不可点，额度从哪扣写在悬停说明里。
    const switchable = tool.id === 'claudeDesktop' && Boolean(props.onSwitchExternalSource) && !job
      && (status === 'official' || (status === 'ready' && tool.status.configurationSource === 'xingmang'))
    const badge = installJob ? typeof installJob.percent === 'number' ? undefined : <span className="v2-tool-card-busy" role="status"><Spinner label={installJob.label} /></span>
      : updateFailed && props.onShowDesktopUpdateFailure ? <Button variant="ghost" size="sm" onClick={() => props.onShowDesktopUpdateFailure?.(tool.id)} testId={`tool-${tool.id}-why`}>查看原因</Button>
      : status === 'missing' ? <span className="v2-tool-card-off">{statuses.tool.missing[0]}</span>
      : switchable ? externalSourceMenu(tool, status === 'official')
      : status === 'ready' && tool.status.configurationSource === 'xingmang' ? <span className="v2-source-chip is-static" title="费用从当前账号余额中扣除" data-testid={`tool-${tool.id}-source`}>{sourceChipLabels.account}</span>
        : <Pill tone={statuses.tool[status][1]} dot><span title={statuses.tool[status][0]}>{statuses.tool[status][0]}</span></Pill>
    const actions = installJob?.cancellable && props.onCancelInstallExternal
      ? <Button variant="ghost" size="sm" icon={X} loading={installJob.cancelling} onClick={() => props.onCancelInstallExternal?.(tool.id)} testId={`tool-${tool.id}-cancel`}>{installJob.cancelling ? '正在停止' : '取消'}</Button>
      : installJob ? null
        : <Button size="sm" variant={tool.status.installed ? 'primary' : 'secondary'} loading={Boolean(launchJob)} disabled={externalBusy || unsupported || Boolean(switchJob)} title={unsupported ? tool.status.installHint ?? '本机不支持' : undefined}
          icon={tool.action === 'install' && !unsupported && !manualInstall ? Download : undefined} onClick={primary} testId={tool.action === 'configure' ? `home-client-${tool.id}` : `tool-${tool.id}-primary`}>{primaryLabel}</Button>
    const link = updateTarget ? <button type="button" className="xm-tool-card-link" onClick={() => props.onUpdateDesktopApp?.(tool.id, updateTarget)} data-testid={`tool-${tool.id}-update`}>
      <RefreshCw size={12} aria-hidden="true" /><span>{`可更新到 ${versionText(updateTarget)}`}</span></button> : undefined
    return <ToolCard key={tool.id} tool={tool.id} off={!tool.status.installed && !installJob && !tool.status.detectionError} meta={meta} metaTone={metaTone} metaTitle={meta}
      link={link} badge={badge} actions={actions} progress={typeof installJob?.percent === 'number' ? installJob.percent : undefined}
      menu={tool.status.installed && !job ? [
        // 配置入口只留「…」菜单这一处；主按钮已经是「确认连接」时菜单里不再重复，换成「打开」（还没连上也能先打开看看）。
        ...(tool.action === 'configure'
          ? [{ label: '打开', disabled: !tool.status.launchSupported || externalCached, testId: `tool-${tool.id}-open`, onSelect: () => props.onLaunchExternal(tool.id) }]
          : [{ label: '配置…', disabled: externalCached, testId: `home-client-${tool.id}`, onSelect: () => props.onConfigureExternal(tool.id) }]),
        ...(switchable ? [status === 'official'
          ? { label: useAccountLabel, disabled: externalCached, testId: `tool-${tool.id}-switch-account`, onSelect: () => props.onSwitchExternalSource?.(tool.id, 'account') }
          : { label: '切回官方账号', disabled: externalCached, testId: `tool-${tool.id}-switch-official`, onSelect: () => props.onSwitchExternalSource?.(tool.id, 'official') }] : []),
        ...uninstallGuideItems(tool.id, tool.name, tool.status.path).flatMap((item) => ['divider' as const, item]),
      ] : undefined} menuLabel={`${spacedName(tool.name)}更多操作`} testId={`tool-row-${tool.id}`} />
  }

  // 工具区按厂商排（v4）：命令行工具和外接客户端混在一起。Linux 上没有 Codex 桌面端、也没有外接客户端，跳过。
  const cards = homeToolOrder.flatMap((id) => {
    const cli = tools.find((tool) => tool.id === id)
    if (cli) return [renderTool(cli)]
    const client = external.find((tool) => tool.id === id)
    return client ? [renderExternal(client)] : []
  })

  // 顶部大卡：第一个装好的命令行工具（按厂商顺序）。一个都没装时放 Claude Code 的「还没装」。
  const heroTool = tools.find((tool) => tool.id !== 'codexDesktop' && tool.status.installed)
    ?? tools.find((tool) => tool.id !== 'codexDesktop' && jobs[tool.id])
    ?? tools.find((tool) => tool.id === 'claude')
  function renderHero(): ReactNode {
    if (!heroTool) return <div className="v2-home-hero-main"><Skeleton rows={2} /></div>
    const state = toolState(heroTool)
    const name = toolRegistry.find((entry) => entry.id === heroTool.id)?.name ?? heroTool.name
    if (!heroTool.status.installed && !heroTool.error) {
      return <div className="v2-home-hero-main" data-testid="home-setup">
        <BrandIcon tool={heroTool.id} size={52} variant="tile" />
        <div className="v2-home-hero-copy"><h2>{name}</h2><p>{state.installJob ? '正在安装…' : '未安装。安装后可在此一键打开'}</p>
          <div className="v2-home-hero-actions">{state.installJob
            ? typeof state.installJob.percent === 'number' ? <div className="v2-home-hero-progress"><Progress value={state.installJob.percent} /><span>{`${Math.round(state.installJob.percent)}%`}</span></div> : null
            : <Button variant="primary" icon={Download} disabled={firstScan || loading} onClick={() => props.onInstall(heroTool.id)} testId="home-hero-install">{`安装 ${name}`}</Button>}</div></div>
      </div>
    }
    const last = (recent?.items ?? []).find((session) => session.provider === heroTool.provider && !session.archived)
    const lastText = recent === null ? null : last ? `上次 ${formatRecentTime(last.updatedAt, Date.now())}` : '尚未使用'
    const official = heroTool.source === 'official' && !state.broken
    const sourceText = official ? officialAccountNames[heroTool.provider] ?? '官方账号'
      : state.zeroBalance ? statuses.tool.zeroBalance[0]
      : state.status === 'ready' ? state.sourceLabel : statuses.tool[state.status][0]
    const sub = (official ? [sourceText, lastText] : [state.routeLabel?.text, heroTool.model || null, sourceText, lastText]).filter(Boolean).join(' · ')
    const shortcut = shortcutTools(os).findIndex((entry) => entry.id === heroTool.id) + 1
    const opens = state.openable && !state.configUnavailable && !heroTool.error && !state.installJob
    return <div className="v2-home-hero-main">
      <BrandIcon tool={heroTool.id} size={52} variant="tile" />
      <div className="v2-home-hero-copy"><h2>{name}</h2><p title={state.lastWorkspace ? `在 ${state.lastWorkspace.path} 打开` : undefined}>{sub}</p>
        <div className="v2-home-hero-actions">
          {/* 余额为零时大卡地方够：「前往充值」当主按钮排第一，「打开」退成旁边的次按钮，照样能点。 */}
          {state.zeroBalance && <Button variant="primary" icon={Zap} onClick={() => props.onNavigate('account', 'recharge')} testId="home-hero-recharge">前往充值</Button>}
          {opens
            ? <Button variant={state.zeroBalance ? 'secondary' : 'primary'} icon={Play} loading={Boolean(state.launchJob)} disabled={state.primaryDisabled} title={state.lastWorkspace ? `在 ${state.lastWorkspace.path} 打开` : undefined} onClick={state.primary} testId="home-hero-open"
              kbd={shortcut > 0 ? os === 'mac' ? `⌘${shortcut}` : `Ctrl ${shortcut}` : undefined}>{`打开 ${name}`}</Button>
            : <Button variant="primary" loading={Boolean(state.job)} disabled={state.primaryDisabled} onClick={state.primary} testId="home-hero-open">{state.primaryLabel}</Button>}
          {state.opensWorkspace && <Button variant="secondary" icon={FolderOpen} disabled={state.waitingForScan || state.waitingForAccount || launchBusy} onClick={() => props.onLaunch(heroTool.id)} testId="home-hero-pick-folder">{chooseWorkspaceLabel}</Button>}
        </div></div>
    </div>
  }

  /** 卡片「…」里「接着之前的对话…」那个窗口。卡片要是不再能打开（卸了、配置坏了），里面的按钮跟着按不动。 */
  function renderConversations(): ReactNode {
    const tool = conversationsTool ? tools.find((entry) => entry.id === conversationsTool) : undefined
    if (!tool) return null
    const state = toolState(tool)
    const name = toolRegistry.find((entry) => entry.id === tool.id)?.name ?? tool.name
    const close = () => setConversationsTool(null)
    return <ToolConversationsDialog api={props.api} provider={tool.provider} toolName={name}
      resumeDisabled={!state.opensWorkspace || (loading && !launchReadyBeforeScan(tool)) || launchWaitingForAccount(tool.provider) || launchBusy}
      newDisabled={!state.opensWorkspace || state.primaryDisabled}
      onResume={(session) => { close(); props.onLaunch(tool.id, session.cwd, resumeLaunchChoice(session)) }}
      onNew={() => { close(); state.primary() }}
      onAllRecords={() => { close(); props.onNavigate('sessions') }}
      onClose={close} />
  }

  function renderRecentRow(session: RecentSession) {
    const offered = recentResumeOffered(tools, session.provider)
    const tool = tools.find((entry) => entry.id === session.provider)
    const toolName = toolRegistry.find((entry) => entry.id === session.provider)?.name ?? session.provider
    const needsInstall = !offered && isActiveProviderId(session.provider) && tool !== undefined && !tool.status.installed && !tool.error
    return <div className="v2-home-recent-row" key={session.id} data-testid={`home-recent-row-${session.id}`}>
      <BrandIcon tool={session.provider} size={18} />
      <span className="v2-recent-title" title={session.title}>{session.title}</span>
      <span className="v2-home-recent-dir" title={session.cwd || undefined}>{recentSessionSubtitle(session)}</span>
      {session.cwdExists === false ? <Pill tone="warn" testId={`home-recent-missing-${session.id}`}>文件夹已不存在</Pill> : <span className="v2-home-recent-time">{formatRecentTime(session.updatedAt, Date.now())}</span>}
      <span className="v2-home-recent-actions">
        {resumable.has(session.id) && !session.archived && offered && <Button size="xs" variant="ghost" icon={Play} loading={resumeChecking === session.id}
          disabled={(loading && !resumeReadyBeforeScan(session.provider)) || launchWaitingForAccount(session.provider) || launchBusy || resumeChecking !== null || session.cwdExists === false}
          onClick={() => void resumeRecent(session)}
          title={recentResumeHint(session)} testId={`home-recent-resume-${session.id}`}>继续对话</Button>}
        {needsInstall && tool && <Button size="xs" variant="ghost" icon={Download} disabled={Boolean(jobs[tool.id]) || loading} title={`请先安装 ${toolName}`}
          onClick={() => props.onInstall(tool.id)} testId={`home-recent-install-${session.id}`}>先安装</Button>}
        {Boolean(session.cwd) && <Button size="xs" variant="ghost" icon={FolderOpen} disabled={session.cwdExists === false}
          aria-label="打开文件夹" title={session.cwdExists === false ? '文件夹已不存在，无法打开' : `在文件管理器中打开 ${session.cwd}`}
          onClick={() => void openRecentDirectory(session.id)} testId={`home-recent-open-directory-${session.id}`} />}
      </span>
    </div>
  }

  // —— 提示区：要客户动手的错误都摆着；其余（重启、写密钥、钱、线路）一页最多两条，剩下的位置给公告和活动。
  const alerts: ReactNode[] = []
  if (props.bootstrap && !props.bootstrap.result && props.bootstrap.error) {
    alerts.push(<HomeNotice key="bootstrap-error" tone="warn" role="alert" testId="home-bootstrap-error" icon={<TriangleAlert size={15} aria-hidden="true" />}
      action={props.onBootstrapRetry && <Button size="xs" variant="secondary" onClick={props.onBootstrapRetry}>重新同步</Button>}>{bootstrapErrorText(props.bootstrap.error)}</HomeNotice>)
  }
  const bootstrapNeedsAction = Boolean(bootstrapResult && (bootstrapFailed.length || bootstrapWarnings.length || bootstrapResult.networkBlocked))
  if (bootstrapResult && bootstrapNoticeWanted && bootstrapNeedsAction) {
    const configuredText = bootstrapResult.configured.length ? `${configuredKeysText(keyTargetsLabel(bootstrapResult.configured))}。` : ''
    // 账号没开通的工具点多少次「重新同步」都一样，只剩这种失败时不给这个按钮。证书被换掉的那句叫客户点它，
    // 没写成的只是没装的工具时 failed、warnings 都是空的，按钮照样要给。
    const retryWanted = Boolean(props.onBootstrapRetry) && (bootstrapFailed.some((entry) => !isAccountNotEnabledFailure(entry.message)) || bootstrapWarnings.length > 0 || (bootstrapResult.networkBlocked && bootstrapResult.networkBlockedByCertificate))
    // 账号没开通的只有客服能开（主路卡点 F5）：那句后面给「联系客服」，开帮助框里的客服二维码；两种失败都有就两颗都给。
    const supportWanted = Boolean(props.onHelp) && bootstrapFailed.some((entry) => isAccountNotEnabledFailure(entry.message))
    alerts.push(<HomeNotice key="bootstrap-result" tone="warn" role="status" testId="home-bootstrap-result" icon={<TriangleAlert size={15} aria-hidden="true" />}
      action={retryWanted || supportWanted ? <>
        {retryWanted && <Button size="xs" variant="secondary" onClick={props.onBootstrapRetry}>重新同步</Button>}
        {supportWanted && <Button size="xs" variant="secondary" onClick={props.onHelp} testId="home-bootstrap-support">联系客服</Button>}
      </> : undefined}>
      {bootstrapResult.networkBlocked ? networkBlockedNotice(bootstrapResult) : [configuredText, bootstrapFailed.map((entry) => keySyncFailureText(entry.provider, entry.message)).join('；'), bootstrapWarnings.join('；')].filter(Boolean).join(' ')}
    </HomeNotice>)
  }
  if (error) alerts.push(<HomeNotice key="scan-error" tone="bad" role="alert" testId="home-scan-error" icon={<TriangleAlert size={15} aria-hidden="true" />} action={<Button size="xs" variant="secondary" onClick={props.onScan}>重新检测</Button>}>{error}</HomeNotice>)
  if (props.externalError) alerts.push(<HomeNotice key="external-error" tone="bad" role="alert" testId="home-external-error" icon={<TriangleAlert size={15} aria-hidden="true" />} action={<Button size="xs" variant="secondary" onClick={props.onScan}>重新检测</Button>}>无法获取客户端状态：{props.externalError}</HomeNotice>)
  if (routeTexts.outage) alerts.push(<HomeNotice key="route-outage" tone="bad" role="alert" testId="home-route-outage" icon={<TriangleAlert size={15} aria-hidden="true" />} action={<Button size="xs" variant="secondary" onClick={props.onScan}>重新检测</Button>}>{routeTexts.outage}</HomeNotice>)
  if (snapshot && configFailure) alerts.push(<HomeNotice key="config-failure" tone="bad" role="alert" testId="home-config-failure" icon={<TriangleAlert size={15} aria-hidden="true" />} action={<Button size="xs" variant="secondary" onClick={props.onScan}>重新检测</Button>}>无法读取工具配置（{configFailure.message.replace(/[。.\s]+$/, '')}）。工具列表、安装和卸载不受影响，可点击工具卡片上的「重新配置」重新写入。</HomeNotice>)

  const statusNotices: ReactNode[] = []
  if (props.restart && restartPending) statusNotices.push(<RestartNotice key="restart" restart={props.restart} />)
  if (props.bootstrap && !props.bootstrap.result && !props.bootstrap.error && !props.bootstrap.quiet) {
    // 写的是哪几家：装着、用当前账号（或还没连上）的命令行工具。Codex 两行共用一份配置，算一个。
    const targets = tools.filter((tool) => tool.status.installed && tool.source !== 'official' && tool.source !== 'manual').map((tool) => tool.provider)
    // 一个要写的工具都没有（新客户还没装，或装着的都用官方账号、自己的密钥）时，不说「正在给 工具写入密钥」（#1104 第 7 条）。
    const progressText = targets.length ? `正在为 ${spacedName(keyTargetsLabel(targets))}写入密钥` : '正在准备账号密钥'
    statusNotices.push(<HomeNotice key="bootstrap" busy testId="home-bootstrap-progress" icon={<Spinner />}>{`${progressText}（${props.bootstrap.percent}%）`}</HomeNotice>)
  }
  if (bootstrapResult && bootstrapNoticeShown && bootstrapNoticeWanted && !bootstrapNeedsAction) {
    statusNotices.push(<HomeNotice key="bootstrap-done" tone="ok" testId="home-bootstrap-done" icon={<Check size={15} aria-hidden="true" />}>{configuredKeysText(keyTargetsLabel(bootstrapResult.configured))}</HomeNotice>)
  }
  if (moneyNotice) {
    statusNotices.push(<HomeNotice key="money" tone="warn" testId={moneyNotice.renew && subscription ? 'home-subscription-warning' : 'home-low-balance'} icon={<TriangleAlert size={15} aria-hidden="true" />}
      action={<Button size="xs" variant="secondary" onClick={() => props.onNavigate('account', 'recharge')}>{moneyNotice.renew ? '前往续费' : '前往充值'}</Button>}>{moneyNotice.text}</HomeNotice>)
  }
  if (routeTexts.quiet) statusNotices.push(<HomeNotice key="route-quiet" testId="home-route-server-switching" icon={<Info size={15} aria-hidden="true" />}>{routeTexts.quiet}</HomeNotice>)
  if (routeTexts.hijack) statusNotices.push(<HomeNotice key="route-hijack" testId="home-route-hijack" icon={<Info size={15} aria-hidden="true" />}>{routeTexts.hijack}</HomeNotice>)
  const shownNotices = statusNotices.slice(0, homeNoticeLimit)
  const noticeRoom = homeNoticeLimit - shownNotices.length
  useEffect(() => { onNoticeRoom?.(noticeRoom) }, [noticeRoom, onNoticeRoom])

  // 打开软件时替客户改好的提醒设置：装着、连着当前账号的那几家说一次就收（hookRepairsToAnnounce）。
  const repairedHooks = tools.filter((tool) => {
    const state = toolState(tool)
    return state.status === 'ready' && state.hooksAutoRepaired
  }).map((tool) => tool.provider)
  const repairedHooksKey = [...new Set(repairedHooks)].sort().join(',')
  const showToast = toast.show
  useEffect(() => {
    for (const provider of parseAnnouncedHookRepairs(readWindowSession(announcedHookRepairsKey))) announcedHookRepairs.add(provider)
    const due = hookRepairsToAnnounce(repairedHooks, announcedHookRepairs)
    if (!due.length) return
    for (const provider of due) announcedHookRepairs.add(provider)
    writeWindowSession(announcedHookRepairsKey, [...announcedHookRepairs].join(','))
    showToast(cliHooksAutoRepairedText(due), 'ok')
    // repairedHooks 每次重画都是新数组，按里面是哪几家来判断要不要再看一遍。
  }, [repairedHooksKey, showToast])

  // 页头那句按状态说（v4）：在检测、没网、有要处理的、还没连上、还没装、都好了。
  const cliStates = tools.filter((tool) => tool.status.installed && !jobs[tool.id]).map((tool) => ({ tool, status: toolState(tool).status }))
  const issueNames = [...new Map(cliStates.filter((entry) => entry.status === 'configBroken' || entry.status === 'configChanged')
    .map((entry) => [entry.tool.provider, `${spacedName(entry.tool.provider === 'codex' ? 'Codex' : entry.tool.name)}${entry.status === 'configBroken' ? '的配置文件已损坏' : '的配置已被修改'}`] as const)).values()]
  // 认不出来路的那份（R1）打不开：页头不能还说「都配好了」。
  const unrecognizedNames = tools.filter((tool) => !jobs[tool.id] && !tool.error && isUnrecognizedInstall(tool.status)).map((tool) => tool.name)
  const unconnected = [...cliStates.filter((entry) => entry.status === 'unconfigured').map((entry) => entry.tool.name),
    ...installedExternal.filter((tool) => tool.status.installed && tool.configurationStatus === 'unconfigured' && !tool.status.detectionError).map((tool) => tool.name)]
  const nodeReady = Boolean(snapshot && (snapshot.system.runtime.node.installed || nodeOptional) && !nodeInstallerPartMissing(snapshot.system.runtime))
  const lead = cachedPhase ? <span data-testid="home-cached-scan">正在检测本机工具，当前显示上次结果。</span>
    : loading || props.externalLoading && !external.length ? '正在检测本机工具和运行环境…'
    : offline ? '网络未连接，已安装的工具仍可正常使用。'
    : configFailure || !snapshot ? undefined
    : issueNames.length ? `${issueNames.join('，')}，请在下方卡片中处理。`
    : unrecognizedNames.length ? `${spacedName(unrecognizedNames.join('、'))}非星芒安装，无法在星芒中打开，请点击卡片上的「使用星芒安装」。`
    : unconnected.length ? `${spacedName(unconnected.join('、'))}尚未关联当前账号。`
    // 检测失败的卡不算装着（installed 为假），不先拦下来就会落到「还没装工具」或「都配好了」，跟下面红着的卡对不上（D12）。
    : undetectedCount > 0 ? `${undetectedCount} 个工具检测失败，请点击卡片上的「重新检测」。`
    : installedCount === 0 ? '尚未安装工具，请从下方选择。'
    : nodeReady && !runtimeUndetected ? '已安装的工具均已配置，运行环境正常。' : '已安装的工具均已配置。'

  // 余额卡：金额、订阅、按最近用量还能用几天、近 7 天花费。
  const runwayLine = props.supportsUsage === false ? '请在官方网站查看消费记录。'
    : usageError || (balanceRunwayEmpty(runway) ? '余额已用尽'
      : runway?.days != null ? `按近期用量${runwayDaysText(runway.days)}`
      : runway && runway.usableUsd === null ? null
      : usage ? balance ? '最近 7 天暂无用量' : '获取余额后显示预计可用时长'
      : account ? '正在读取用量' : props.accountRestoring ? '登录恢复后自动显示用量' : '登录后查看用量')
  const subscriptionLine = subscription ? `另有${subscription.name ?? '订阅'}${subscription.remainingUsd === null ? '' : ` ${money(subscription.remainingUsd)}`}，${subscriptionEndDate(subscription.endsAt)}到期` : null
  const weekDays = week && week.scope === props.accountScope && balance && balance.quotaPerUnit > 0 ? week.days.map((day) => ({ ...day, usd: day.quota / balance.quotaPerUnit })) : null
  const weekTotal = weekDays ? weekDays.reduce((sum, day) => sum + day.usd, 0) : weekUsd
  const weekMax = weekDays ? Math.max(...weekDays.map((day) => day.usd)) : 0
  const lowMoney = Boolean(runway?.low)
  // 「试试第一条命令」那句话跟着这张卡的「打开」会落在哪个文件夹挑（D45）：要替他新建，或者
  // 要打开的是星芒建的、还空着的那个，换成让它动手做点东西的那句。
  const firstRunState = firstRunTool ? toolState(firstRunTool) : null
  const firstRunFreshFolder = firstRunState !== null
    && opensUntouchedStarterWorkspace({ createsFolder: firstRunState.startsFresh, workspace: firstRunState.workspaces[0]?.path }, snapshot?.config)

  return <section className="v2-page v2-home" data-testid="page-home">
    <PageHead title={`${greeting(new Date().getHours())}${account ? `，${account.username}` : ''}`}
      lead={lead} actions={<>
        <Button onClick={props.onGuide} testId="home-guide">新手引导</Button>
        <Button icon={RefreshCw} loading={loading || props.externalLoading} onClick={props.onScan} testId="home-rescan">{loading || props.externalLoading ? '正在检测' : '重新检测'}</Button>
      </>} />
    <div className="v2-home-notices">
      {alerts}{shownNotices}
      <div className="v2-home-notice-slot" ref={setNoticeSlot} data-testid="home-notice-slot" />
    </div>
    <div className="v2-home-top">
      <section className="v2-home-hero" data-testid="home-hero">
        {renderHero()}
        <div className="v2-home-recent" data-testid="home-recent-card">
          <div className="v2-home-recent-head"><h3>最近对话</h3><button type="button" className="v2-more-link" onClick={() => props.onNavigate('sessions')}>全部记录<ChevronRight size={13} aria-hidden="true" /></button></div>
          {resumeReplaced && recent && <div className="v2-home-recent-note" role="status" data-testid="home-recent-replaced">{resumeReplaced}</div>}
          {recentError ? <div className="v2-home-recent-empty" role="status">{recentError}<Button size="xs" variant="ghost" onClick={() => setRecentAttempt((value) => value + 1)}>重新加载</Button></div>
            : !recent ? <div className="v2-home-recent-empty" role="status">正在读取最近记录</div>
              : recent.items.length ? recent.items.slice(0, 3).map(renderRecentRow)
                : <div className="v2-home-recent-empty">暂无对话记录。使用工具对话后，最近的记录将显示在此处。</div>}
        </div>
      </section>
      <HomeBalanceCard hasBalance={Boolean(balance)} waiting={props.accountRestoring ? 'restoring' : account ? 'reading' : null} onRefresh={balanceStore && account ? refreshBalanceCard : undefined}
        head={<div className="v2-home-balance-head"><h2>账号余额</h2>{props.supportsUsage !== false && <button type="button" className="v2-more-link" onClick={() => props.onNavigate('account', 'usage')} data-testid="home-usage-link">用量账单<ChevronRight size={13} aria-hidden="true" /></button>}</div>}
        amount={<strong className={lowMoney ? 'is-warn' : undefined} data-testid="home-balance">{dollars === null ? '—' : money(dollars)}</strong>}
        recharge={props.supportsBilling !== false && <Button variant="secondary" size="sm" onClick={() => props.onNavigate('account', 'recharge')} testId="home-recharge">充值</Button>}>
        {subscriptionLine && <p className="v2-home-balance-sub" data-testid="home-subscription">{subscriptionLine}</p>}
        {runwayLine && <p className={`v2-home-balance-days${lowMoney && runway?.days != null ? ' is-warn' : ''}`} data-testid="home-balance-days">{runwayLine}</p>}
        {account && props.supportsUsage !== false && weekTotal !== null && <div className="v2-home-week" data-testid="home-week-spend">
          <div className="v2-home-week-head"><span>近 7 天花费</span><b>{money(weekTotal)}</b></div>
          {weekDays && <div className="v2-home-week-bars" role="img" aria-label={`近 7 天每天的花费，最多的一天 ${money(weekMax)}，今天到现在 ${money(weekDays[weekDays.length - 1].usd)}`}>
            {weekDays.map((day, index) => {
              const today = index === weekDays.length - 1
              const height = weekMax > 0 ? Math.round(day.usd / weekMax * 100) : 0
              return <div key={day.start} className={`v2-home-week-day${today ? ' is-today' : ''}`} title={weekSpendHint(day.start, day.usd)}>
                <div className="v2-home-week-bar"><i style={{ height: `${height}%` }}>{today && <em>{money(day.usd)}</em>}</i></div>
                <span>{weekSpendLabel(day.start, today)}</span>
              </div>
            })}
          </div>}
        </div>}
      </HomeBalanceCard>
    </div>
    <section className="v2-home-tools" data-testid="home-your-tools">
      <div className="v2-home-section-head"><h2>工具</h2><span>{[`已安装 ${installedCount} 个`, ...(undetectedCount > 0 ? [`${undetectedCount} 个检测失败`] : [])].join(' · ')}</span></div>
      {firstScan ? <div className="v2-home-tools-detecting" data-testid="home-tools-detecting"><p className="v2-loading-inline" role="status">正在检测本机已安装的工具</p><Skeleton rows={3} /></div>
        : <div className="v2-home-tool-grid" data-testid="home-tools">
          {cards}
          <button type="button" className="v2-home-tool-add" onClick={() => props.onNavigate(toolRequest.page, toolRequest.section)} data-testid="home-tools-request"><Plus size={18} aria-hidden="true" /><b>没有找到需要的工具？</b><span>{toolRequest.text}</span></button>
        </div>}
      {!firstScan && (externalCached || (props.externalLoading && !external.length)) && <div className="v2-loading-inline" role="status" data-testid="home-external-detecting">正在检测 WorkBuddy、Claude Desktop 和 OpenCode</div>}
    </section>
    {firstRunTool && firstRun && <Card title="运行第一条命令" meta={firstRunTool.name} testId="home-first-run"
      actions={<Button variant="ghost" size="xs" icon={X} aria-label="不再显示" title="不再显示" testId="home-first-run-dismiss"
        onClick={() => setFirstRunDismissed((current) => dismissFirstRun(getFirstRunStorage(), current, firstRunTool.id))} />}>
      <FirstRunSteps key={`${firstRunTool.id}:${firstRunFreshFolder}`} name={firstRunTool.name} firstRun={firstRun} testId="home-first-run-steps" freshFolder={firstRunFreshFolder}
        gitHint={firstRunTool.id === 'claude' && gitMissing ? gitMissingFirstRunHint(gitHost) : undefined} />
    </Card>}
    <div className="v2-home-wells">
      <section className="v2-home-well" data-testid="home-runtime">
        <div className="v2-home-well-head"><h2>运行环境</h2><button type="button" className="v2-more-link" onClick={() => props.onNavigate('health')} data-testid="home-runtime-health">全面检查<ChevronRight size={13} aria-hidden="true" /></button></div>
        <div className="v2-runtime-list">{(['node', 'git', 'python'] as const).map((id) => {
          const status = snapshot?.system.runtime[id]
          const optional = id !== 'node' || nodeOptional
          // 装工具用的那个组件（npm）是 Node.js 自带的，不单列一行，缺了才在 Node.js 这一行说。
          const partMissing = id === 'node' && nodeInstallerPartMissing(snapshot?.system.runtime)
          // Python 没装时这一行就是「Python（可选）」加一颗「安装」（v4），不再写「可选 · 未安装」。
          const pythonButton = id === 'python' && !loading && pythonMissing && runtimeInstallButtonShown('python', snapshot?.platform.platform, snapshot?.platform.pythonRuntimeInstall)
          const text = jobs[id] && id !== 'python' ? jobs[id].label : loading ? '检测中' : status?.detectionFailed ? '检测失败' : status?.version ?? (pythonButton || jobs.python && id === 'python' ? '' : optional ? '可选 · 未安装' : '未安装')
          // 检测中、还没检测过都是灰点：那时不知道装没装，不能先挂橙点。
          const ok = !loading && Boolean(status?.installed) && !partMissing
          const dot = loading || !status ? '' : ok ? 'is-ok' : optional ? '' : 'is-warn'
          const label = id === 'node' ? 'Node.js' : id === 'git' ? 'Git' : status?.installed ? 'Python' : 'Python（可选）'
          return <div key={id} className="v2-runtime-row" data-testid={`home-runtime-row-${id}`}>{ok ? <Check size={15} className="v2-runtime-ok" aria-hidden="true" /> : <i className={`v2-dot ${dot}`} />}<BrandIcon tool={id} size={16} variant="xs" /><strong>{label}</strong>
            {(pythonButton || (id === 'python' && jobs.python))
              ? <Button variant="secondary" size="xs" loading={Boolean(jobs.python)} onClick={() => props.onRuntime('python')} testId="home-runtime-python">{jobs.python ? '正在安装' : snapshot?.platform.pythonRuntimeInstall === 'external' ? runtimeButtonLabel('python', 'external') : '安装'}</Button>
              : <span>{partMissing && !jobs[id] && !loading ? `${text} · ${nodeInstallerPartMissingNote}` : text}</span>}
          </div>
        })}</div>
        {gitMissing && !jobs.git && claudeInUse && <p className="v2-runtime-hint" data-testid="home-runtime-git-hint">{gitMissingHomeNotice(gitHost)}</p>}
        {gitHost === 'macos' && jobs.git && <p className="v2-runtime-hint" data-testid="home-runtime-git-waiting">{gitMacInstallWaitingHint}</p>}
        {nodeElevationNotice && <p className={runtimeHintClass} data-testid="home-runtime-node-elevation">{nodeElevationNotice}</p>}
        {nodeManagedNotice && !jobs.node && <p className={runtimeHintClass} data-testid="home-runtime-node-managed">{nodeManagedNotice}</p>}
        {nodeGuide && <RuntimeInstallHint runtime="node" guide={nodeGuide} />}
        {pythonGuide && <RuntimeInstallHint runtime="python" guide={pythonGuide} />}
        {/* 确认没装才给安装按钮；检测中不给，检测失败给「重新检测」。 */}
        <div className="v2-runtime-actions">{runtimeUndetected && <Button variant="ghost" size="sm" icon={RefreshCw} onClick={props.onScan} testId="home-runtime-rescan">重新检测</Button>}
          {!loading && nodeMissing && <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onRuntime('node')} testId="home-runtime-node">{runtimeButtonLabel('node', snapshot?.platform.nodeRuntimeInstall)}</Button>}
          {((nodeGuide && !nodeGuide.noTutorial) || (pythonGuide && !pythonGuide.noTutorial)) && <Button variant="ghost" size="sm" icon={BookOpen} onClick={() => props.onNavigate('tutorial', macRuntimeTutorialTopic)} testId="home-runtime-tutorial">查看教程</Button>}
          {gitMissing && gitHost !== 'other' && <Button variant="ghost" size="sm" icon={Download} loading={Boolean(jobs.git)} disabled={Boolean(jobs.git)} onClick={() => props.onRuntime('git')} testId="home-runtime-git">安装 Git</Button>}</div>
      </section>
      {/* 整行都能点，右边的箭头只是记号。Codex 已经在用（装着、「最近」里有它的记录）就不再教它入门。 */}
      <section className="v2-home-well v2-home-try" data-testid="home-suggestions">
        <div className="v2-home-well-head"><h2>推荐功能</h2></div>
        <ListRow icon={Plug} title="为 AI 连接浏览器和文件夹" onOpen={() => props.onNavigate('mcp')} actions={<ArrowRight size={16} aria-hidden="true" />} testId="home-suggestion-mcp" />
        <ListRow icon={MessageSquare} title="无需终端，直接在星芒中对话" onOpen={() => props.onNavigate('chat')} actions={<ArrowRight size={16} aria-hidden="true" />} testId="home-suggestion-chat" />
        {!codexInUse && <ListRow icon={BookOpen} title="Codex 入门：4 步快速上手" onOpen={() => props.onNavigate('tutorial')} actions={<ArrowRight size={16} aria-hidden="true" />} testId="home-suggestion-codex" />}
      </section>
    </div>
    {uninstallGuide && <UninstallGuideDialog guide={uninstallGuide} onClose={() => setUninstallGuide(null)} />}
    {officialOpen && <OfficialQuotaDialog email={snapshot?.config.providers.codex.officialAccountEmail ?? null} initial={official} refresh={() => props.api.officialUsage()} onClose={() => setOfficialOpen(false)} />}
    {renderConversations()}
  </section>
}
