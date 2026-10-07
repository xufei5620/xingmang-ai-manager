import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, BookOpen, ChevronDown, Download, FolderOpen, History, KeyRound, MessageSquare, Plug, RefreshCw, RotateCcw, X, Zap } from 'lucide-react'
import type { AccountBalance, AccountProfile, AccountSourceTarget, ExternalClientStatus, ExternalToolId, MultiProviderSessionPage, OfficialChatGptAccount, ProviderId, RunningToolsReport } from '../../../../electron/ipc-contract'
import { describeRunningTools, offersCodexDesktopRestart } from '../../../../electron/running-tools'
import { presentExternalClients } from './external-model'
import { useSharedAccountBalance } from '../app/balance-context'
import { balanceStatusText } from '../shell/balance-status'
import { BrandIcon, Button, Card, Dialog, Empty, ListRow, Menu, PageHead, Pill, Progress, Skeleton, ToolRow, toastDurationMs, useToast } from '../../ui'
import { accountSwitchTarget, balanceTier, cliHooksMissing, cliHooksNeedRepair, cliHooksWereAutoRepaired, brokenConfigDetails, brokenConfigOf, codexNeedsRepair, readyOnceRepaired, subscriptionWarning, canUninstallTool, ccSwitchLeftoverFor, foreignKeyKind, switchAccountLabel, configDirectoryMenuItem, externalInstallHint, greeting, needsManualInstall, officialAccountSubtitle, ownershipAwaitingAccount, presentTools, providerFor, recommendedVersionVerb, revertVersion, rollbackVersion, toolUpdateOffer, updateButtonHint, updatesOutsideApp, versionSubtitle, type ToolboxSnapshot, type ToolId, type ToolPresentation } from './model'
import type { BalanceUsage, ToolboxPartitionFailure, ToolsApi } from './api'
import type { ToolJob } from './useToolbox'
import { accountKeyChangeInProgress, accountKeyChangePending, type AccountBootstrapProgress, type AccountBootstrapResult } from './account-bootstrap'
import type { PageId } from '../../registry/pages'
import { macDesktopTutorialTopic, macRuntimeTutorialTopic } from '../../registry/business'
import { tools as toolRegistry } from '../../registry/tools'
import { FirstRunSteps } from './FirstRun'
import { isAccountNotEnabledFailure, keySyncFailureReason, keySyncFailureText } from './key-sync-failure'
import { dismissFirstRun, getFirstRunStorage, readFirstRunDismissals } from './first-run-dismissal'
import { formatRecentTime, recentResumeHint, recentSessionSubtitle } from './recent-display'
import { chooseWorkspaceLabel, latestSessionIdsByWorkspace, launchWorkspaces, newWorkspaceLabel, resumeLaunchChoice, resumeNeedsRecheck, resumeStillLatest, workspaceButtonLabel, workspaceChoices, type CliLaunchChoice } from './recent-workspaces'
import { errorMessage } from '../../business-common'
import { subscriptionSummaryText, type UsableSubscription } from '../../../../electron/subscription-summary'
import { isNetworkFailureText } from './online-resync'
import { gitHostPlatform, gitMacInstallWaitingHint, gitMissingFirstRunHint, gitMissingHomeNotice } from '../../../../electron/git-runtime'
import { managedRuntimeNotice, runtimeButtonLabel, runtimeInstallButtonShown, runtimeInstallGuide } from './runtime-install-guide'
import { RuntimeInstallHint } from './RuntimeInstallHint'
import { elevatedInstallShortNotice, homeNodeElevationNotice } from './elevation-notice'
import { useOnlineStatus } from '../shell/useOnlineStatus'
import { readLocalPreference, writeLocalPreference } from '../app/preferences'

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
  /**
   * 当前账号的作用域（App 的 scope）。用量缓存按它认账号：有它时回首页先摆上一次的
   * 用量、后台再刷新；省略 = 每次都先空着等查询回来（旧行为）。
   */
  accountScope?: string
  supportsUsage?: boolean
  supportsBilling?: boolean
  balance: AccountBalance | null
  /** 当前账号能用的订阅；缺省 / null = 没有，一切按钱包说（旧行为）。 */
  subscription?: UsableSubscription | null
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
  /** version 省略 = 让主进程按已验证版本名单决定;点名 = 回到推荐版本(N1)。 */
  onInstall(tool: ToolId, version?: string): void
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
   * finishedAt 是 result 落下来的时刻（Date.now()），「已完成…」那句据此到点收起；缺省 = 一直摆着（旧行为）。
   * routeRestart 是最近一次跟着换线路改了配置时还开着的工具（account-bootstrap.ts 的 nextRouteRestart），
   * 不跟着 result 走：后面几轮同步进行中 result 是空的，那句「要重开」也得留着。缺省 = 没有要重开的。
   */
  bootstrap?: (AccountBootstrapProgress & { scope: string; result?: AccountBootstrapResult; finishedAt?: number; error?: string; routeRestart?: RunningToolsReport }) | null
  onBootstrapRetry?(): void
  /**
   * 「自动」退回了默认线路，还有另外三个客户端开着、停在直连上（account-bootstrap.ts 的 relayFallbackActive
   * 加上它们的 routePending）：上方说一句总的。缺省 = 不提示（旧行为）。四个命令行工具开着也照样跟着换，
   * 不在此列，见下面 routeRestart 那句。
   */
  relayFallback?: boolean
  /** 跟着换了连接线路、还开着的工具，替客户重开 Codex 桌面端（只有能重开时才给）；缺省 = 不给这颗按钮。 */
  onRestartCodexDesktop?(): void
  /** 「要重开」那句客户点了「知道了」；缺省 = 不给这颗按钮，那句一直摆到下次换线路。 */
  onDismissRouteRestart?(): void
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
 * 「最近」里这一家的对话给不给「接着聊」。它点下去走的是同一个「打开」，没装的那家那一行只有
 * 「安装」，点了只会弹「工具尚未安装，请先完成准备。」（第四十一批 A）：卸掉的工具旧记录还在，
 * 只装了 Codex 桌面端的人在桌面端里聊过的多半也记在 Codex 名下。所以按工具 id 找，不按 provider：
 * 桌面端装着不等于 Codex CLI 装着。检测结果还没回来时照旧摆着、灰着等；检测失败的不当没装（A4），
 * 点了照旧说失败的原因。
 */
export function recentResumeOffered(tools: readonly ToolPresentation[], provider: ProviderId): boolean {
  const tool = tools.find((entry) => entry.id === provider)
  return tool === undefined || tool.status.installed || tool.error !== null
}

/**
 * 断网启动时这条横幅原来会先说一句「账号 Key 已同步」，再跟上一串网络失败原文，
 * 自相矛盾且没交代下一步。网络类失败改说这一句：已装好的工具照常能用，网络回来
 * 之后客户端自己会补写，用户什么都不用做。「重新同步」按钮保留，想立刻试的照点。
 */
const offlineBootstrapNotice = '当前网络不可用，已装好的工具照常能用；联网后会自动补写 Key。'

/** 直连适配方案第六节第 4 条的原话（yoyo 10-6 回「改」）。 */
const relayFallbackNotice = '直连这会儿连不上，星芒已改走默认线路；工具要完全退出后点「重新检测」才会跟着换'

/**
 * 连接线路换了，工具配置开着也照样跟着改好（#941）；开着的进程还拿着原来的地址，要重开才走新线路。
 * 只对开着的、看不出开没开的说（running-tools.ts 的说法），都关着就不说。
 */
export function routeRestartNotice(report: RunningToolsReport | undefined): string {
  const restart = report ? describeRunningTools(report, 'route') : ''
  return restart ? `连接线路换了，工具配置已经跟着改好。${restart}` : ''
}

/**
 * 「配置被改过」这一档必须自己解释一句：角标只说了发生什么，没说会怎样。
 * 用户真正要知道的是这个工具现在可能连不上，以及有一颗按钮能一键修回来。
 * 文案以「当前账号」为主语，不提站点。
 */
const configChangedDetail = '配置在软件之外被改动过，当前账号的 Key 可能已经不在里面了'

/**
 * CC Switch 留下的配置：客户多半不知道本软件登录后不会动它，只看到工具「装好了」
 * 却还连着以前那家。一句话说清现在连的是哪、会怎样，旁边一颗「改用当前账号」。
 * 走代理接管的那份要 CC Switch 一直开着才通，单独说。
 */
const ccSwitchDetails: Record<'proxy' | 'provider', string> = {
  proxy: '还在经 CC Switch 转发，CC Switch 一关就用不了，也没有用当前账号',
  provider: '还在用 CC Switch 里选的连接，没有用当前账号',
}

/**
 * 来源没确认的两种 Key 各说一句会怎样（方案盘查 2026-09-25）。别家的站认不出也
 * 用不了，只说不是当前账号的、在这里打不开，不提对方是谁；同一个站上别的账号的
 * Key 能用，要说清用量算到哪。
 */
/**
 * Codex 老配置把当前账号写在它的内置名下：看着连好了，打开却连不上。一句话说清会
 * 怎样，旁边「修好它」走和「改用当前账号」同一条路（先备份、再写、再自检）。
 */
const codexShadowedDetail = '这份配置里有一处 Codex 认不出，打开会连不上'

/**
 * 本软件写进工具里的提醒设置（做完、出错时弹通知，干活时不让电脑睡）指向了旧位置：
 * 卸载后换了文件夹重装、挪了软件、换装了 Node.js 都会这样。工具照样能用，只是每一轮
 * 都多报一行错。「修好它」只改这几行，先备份。
 */
const cliHooksStaleDetail = '工具里的提醒设置指向了旧位置，每次都会多报一行错'
/** 打开软件时已经替用户改好了：只说一句，原来的设置在「备份」里。 */
const cliHooksAutoRepairedDetail = '提醒设置指向了旧位置，打开软件时已经自动改好，原来的设置在「备份」里'
/**
 * Windows 上只装 Grok 时没有运行环境，做完提醒和防睡写不上（#695 留下的）。没有运行环境时「补上」
 * 先去准备它，装好后主进程自己补；已经有了（客户自己装的）就直接补。
 */
const cliHooksMissingWithoutRuntimeDetail = '做完、出错时的提醒和干活时不让电脑睡着这两项还没开，点「补上」准备好运行环境就有'
const cliHooksMissingDetail = '做完、出错时的提醒和干活时不让电脑睡着这两项还没开，点「补上」就有'
const cliHooksShellChangedDetail = 'Grok 换了命令行，星芒写的提醒设置要跟着改一下，不然每次都会多报一行错'

const foreignKeyDetails = {
  otherSite: '在这里打不开，改用你的账号就能用',
  otherAccount: '能用，但用量可能算到别的账号上',
} as const

const nodeInstallerPartMissingNote = '少了装工具用的组件，重装一次 Node.js 就好'

// 「配置」只在「…」里（同一行不放两个配置入口），所以鼠标停上去要说出来。
const toolMenuLabel = '配置和更多操作'

// 「还可以装」收起来以后记在本机：切到别的页再回来、下次打开都照旧收着。
const availablePreference = 'xingmang-v2-home-available'

/** npm 是随 Node.js 一起装的：Node.js 在、它却确实不在（不是没查出来）才算缺。 */
export function nodeInstallerPartMissing(runtime: ToolboxSnapshot['system']['runtime'] | undefined) {
  return Boolean(runtime?.node.installed && runtime.npm && !runtime.npm.installed && !runtime.npm.detectionFailed)
}

/**
 * 新账号的余额本来就是 0，「余额只剩 $0.00」读起来像是用光了，客户不知道要先充值才能用；
 * 客服远程装好以后，这一行往往是客户看到的第一句跟钱有关的话。
 */
export function lowBalanceText(dollars: number) {
  return dollars <= 0 ? '当前账号余额是 $0，充值后 AI 工具才能用。付完马上生效，不用重新设置。' : `余额只剩 $${dollars.toFixed(2)}，充值后可继续使用。`
}

function cachedUsage(api: ToolsApi, scope: string | undefined): BalanceUsage | null {
  return scope === undefined ? null : api.peekBalanceUsage(scope)
}

function bootstrapErrorText(error: string) {
  return isNetworkFailureText(error) ? offlineBootstrapNotice : `账号 Key 初始化没有完成：${keySyncFailureReason(error)}`
}

function configuredKeysText(count: number) {
  return `已完成 ${count} 组工具的 Key 配置。`
}

/**
 * 「已完成 N 组工具的 Key 配置。」只是说一声做完了，照右下角提示条的读完时长摆着，到点自己收起（已知12）：
 * 以前登录后整场挂着，装完一个工具又换成「已完成 1 组…」。有没写成的、有要留意的、被网拦住的，那几句
 * 要客户动手，照旧一直摆着。返回 null = 一直摆着。
 */
export function bootstrapNoticeExpiresAt(bootstrap: HomeProps['bootstrap']): number | null {
  const result = bootstrap?.result
  if (!result || bootstrap?.finishedAt === undefined) return null
  if (!result.configured.length || result.failed.length || result.warnings.length || result.networkBlocked) return null
  const duration = toastDurationMs(configuredKeysText(result.configured.length), 'ok')
  return duration === null ? null : bootstrap.finishedAt + duration
}

export function Home(props: HomeProps) {
  const { snapshot, account, balance, jobs, loading, error } = props
  const { store: balanceStore, snapshot: balanceState } = useSharedAccountBalance()
  const { offline } = useOnlineStatus()
  const balanceHint = balanceStatusText({ balanceLoading: balanceState.loading, balanceUpdatedAt: balanceState.updatedAt, balanceError: balanceState.error, offline })
  // 大字只放数字或「—」；没数字时旁边那行小字说清是在恢复登录、在读，还是没读到，别在读的时候说「暂未读到」。
  const balanceLabel = balance || (!account && !props.accountRestoring) ? '可用余额 · 美元'
    : props.accountRestoring ? '正在恢复登录'
      : balanceState.error && !balanceState.loading ? '暂时没有读到' : '正在读取余额'
  const toast = useToast()
  const [recent, setRecent] = useState<MultiProviderSessionPage | null>(null)
  const [recentError, setRecentError] = useState('')
  const [recentAttempt, setRecentAttempt] = useState(0)
  // 「接着聊」点下去以后正在核对的那一条（见 resumeRecent）；null = 没在核对。
  const [resumeChecking, setResumeChecking] = useState<string | null>(null)
  const [usage, setUsage] = useState<BalanceUsage | null>(() => cachedUsage(props.api, props.accountScope))
  const [usageError, setUsageError] = useState('')
  const [officialOpen, setOfficialOpen] = useState(false)
  const [official, setOfficial] = useState<OfficialChatGptAccount | null>(null)
  const [officialBusy, setOfficialBusy] = useState(false)
  const [officialError, setOfficialError] = useState('')
  const officialLock = useRef(false)
  const [firstRunDismissed, setFirstRunDismissed] = useState<ToolId[]>(() => readFirstRunDismissals(getFirstRunStorage()))
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let current = true
    // 先摆上一次查到的（一分钟内就是它本身，不会再发请求），查回来再换；刷新失败时
    // 手上已经有数就留着它，没有才说读不到。
    const cached = cachedUsage(props.api, props.accountScope)
    setUsage(cached); setUsageError('')
    if (account && props.supportsUsage !== false) void props.api.balanceUsage(props.accountScope).then((value) => { if (current) setUsage(value) }).catch(() => { if (current && !cached) setUsageError('用量暂未读到') })
    return () => { current = false }
  }, [account?.userId, props.accountScope, props.api, props.supportsUsage])
  /**
   * 「最近」那三行的「打开文件夹」。只传会话 id，路径由主进程从记录里取并校验。
   * 失败（文件夹刚被删掉、盘符掉了）只提示一句，不动这份列表：过了一分钟、窗口
   * 再回到前面时它自己会重读，而这一下点击不值得让整张卡重来一遍。
   */
  async function openRecentDirectory(sessionId: string) {
    try { await props.api.openSessionDirectory(sessionId) }
    catch (cause) { if (active.current) toast.show(errorMessage(cause, '这条记录的文件夹没有打开。'), 'warn') }
  }
  /**
   * 「接着聊」点下去先对一次「最近」（已知4）。窗口回到前面时的那次重读是异步的：从终端直接点回星芒，
   * 这一下用的还是手上的旧列表，点同一文件夹里更早那条，Claude Code、Gemini CLI、Grok CLI 接上的
   * 却是刚聊的那条。所以先真去读一份（不认一分钟的缓存，它可能是在终端里聊之前读的）：点的这条已经
   * 不是它那个文件夹最近的了，就换上新列表、这次不打开，按钮自己挪到该挂的那条上。读不到就照旧打开。
   */
  async function resumeRecent(session: RecentSession) {
    if (resumeNeedsRecheck(session)) {
      setResumeChecking(session.id)
      props.api.invalidateRecent()
      const fresh = await props.api.recent().catch(() => null)
      // 读的这一下首页已经换掉了（换账号会整页重挂）：这一下按的不再算数。
      if (!active.current) return
      setResumeChecking(null)
      if (fresh) setRecent(fresh)
      if (fresh && !resumeStillLatest(session, fresh.items)) return
    }
    props.onLaunch(session.provider, session.cwd, resumeLaunchChoice(session))
  }
  async function refreshOfficial() {
    if (officialLock.current) return
    officialLock.current = true; setOfficialBusy(true); setOfficialError('')
    try { const value = await props.api.officialUsage(); if (active.current) setOfficial(value) }
    catch (cause) { if (active.current) setOfficialError(errorMessage(cause, '官方额度暂时没有读到')) }
    finally { officialLock.current = false; if (active.current) setOfficialBusy(false) }
  }
  useEffect(() => {
    let current = true
    setRecentError('')
    void props.api.recent().then((value) => { if (current) setRecent(value) }).catch((cause) => {
      if (current) setRecentError(errorMessage(cause, '记录暂时没有读到'))
    })
    return () => { current = false }
  }, [props.api, recentAttempt, props.recentRevision])
  // 首页一直开着就不会重新挂载：从这里打开工具、在终端里聊完再切回来，「最近」和工具那一行
  // 「打开 xx」还是打开前读的那份。刚聊的那条不在，「接着聊」还挂在同一文件夹更早的那条上，
  // 而 Claude Code、Gemini CLI、Grok CLI 续接是按文件夹找最近一条（#292），点下去接上的是刚聊的那条。
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
  // 检测失败的不当成没装：留在「你的工具」里，那一行写「检测失败」、给「重新检测」，不挪进「还可以装」。
  const undetected = (tool: ToolPresentation) => !tool.status.installed && !jobs[tool.id] && Boolean(tool.error)
  const yourTools = tools.filter((tool) => tool.status.installed || jobs[tool.id] || undetected(tool))
  const available = tools.filter((tool) => !tool.status.installed && !jobs[tool.id] && !undetected(tool))
  const external = presentExternalClients(props.externalClients)
  // 开机先摆的是上次落盘的客户端检测结果（cachedAt），真的那轮排在首屏扫描之后才开始（已知13）。
  // 这时同正在重新检测：那几行的按钮先等着，「正在检测」那一句照旧挂着。
  const externalCached = external.some((tool) => Boolean(tool.status.cachedAt))
  const externalBusy = props.externalLoading || externalCached
  const undetectedExternal = (tool: ExternalPresentation) => !tool.status.installed && !jobs[tool.id] && Boolean(tool.status.detectionError)
  const installedExternal = external.filter((tool) => tool.status.installed || jobs[tool.id])
  const yourExternal = external.filter((tool) => tool.status.installed || jobs[tool.id] || undetectedExternal(tool))
  const availableExternal = external.filter((tool) => !tool.status.installed && !jobs[tool.id] && !undetectedExternal(tool))
  const installedCount = installed.length + installedExternal.length
  const undetectedCount = yourTools.length - installed.length + yourExternal.length - installedExternal.length
  const availableCount = available.length + availableExternal.length
  // 第一次检测还没回来：只放「你的工具」的灰色占位，不先画「还可以装」。
  const firstScan = loading && !snapshot
  const dollars = balance && balance.quotaPerUnit > 0 ? balance.quota / balance.quotaPerUnit : null
  const subscription = props.subscription ?? null
  // 有订阅时请求先扣订阅，钱包是 0 也照常能用，余额卡不再标红。
  const tier = dollars === null || subscription ? 'neutral' : balanceTier(dollars)
  const subscriptionNotice = subscription ? subscriptionWarning(subscription, dollars) : null
  const bootstrapResult = props.bootstrap?.result
  const bootstrapFailed = bootstrapResult?.failed ?? []
  const routeRestart = routeRestartNotice(props.bootstrap?.routeRestart)
  const subscriptionLine = subscription ? `订阅：${subscription.name ? `${subscription.name} · ` : ''}${subscriptionSummaryText(subscription, (usd) => `$${usd.toFixed(2)}`)}` : null
  const monthUsed = usage && balance && balance.quotaPerUnit > 0 ? usage.monthQuota / balance.quotaPerUnit : null
  const remainingDays = usage && balance && usage.weekQuota > 0 ? Math.max(0, Math.floor(balance.quota / (usage.weekQuota / 7))) : null
  const configFailure = props.failures?.find((failure) => failure.partition === 'config') ?? null
  const ready = installed.some((tool) => tool.configured && !tool.error) || installedExternal.some((tool) => tool.ready && !tool.status.detectionError)
  const connectedCount = installed.filter((tool) => tool.configured).length + installedExternal.filter((tool) => tool.status.configured && tool.status.configurationSource === 'xingmang').length
  const updatableCount = installed.filter((tool) => tool.updateAvailable).length
  // 「N 个已连接」原来挂在余额卡右上角，放错了卡；配置没读到时不知道连没连，不写这一段。
  const yourToolsMeta = [
    `${installedCount} 个已装`,
    ...(connectedCount > 0 && !configFailure ? [`${connectedCount} 个已连接`] : []),
    ...(undetectedCount > 0 ? [`${undetectedCount} 个没检测出来`] : []),
    ...(updatableCount > 0 ? [`${updatableCount} 个有更新`] : []),
  ].join(' · ')
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
  // 「已完成…」那句到点收起（见 bootstrapNoticeExpiresAt）。首页每次进来都重新挂上，「现在」从挂上那一刻算，
  // 回到首页时已经过了点的就不再冒出来；挂着的时候到点叫一次重画。开着的工具等着换线路的那几条已经由上方
  // 那句总的说了，不算横幅里还要客户动手的。
  const bootstrapNoticeUntil = bootstrapNoticeExpiresAt(props.bootstrap?.result
    ? { ...props.bootstrap, result: { ...props.bootstrap.result, failed: bootstrapFailed } }
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
  const launchBusy = Object.keys(jobs).some((key) => key.startsWith('launch:'))
  function launchWaitingForAccount(provider: ProviderId): boolean {
    const tool = tools.find((entry) => entry.provider === provider)
    if (!tool || tool.source === 'official' || tool.source === 'manual') return false
    return accountKeyChangeInProgress(props.bootstrap ?? null, provider)
  }
  // 开机先摆的是上次的检测结果（cachedAt），真结果还在路上。这时只放开「打开」这一类：
  // 点下去配置现读、工具由主进程现找、目录现查，用不上这份旧结果。「安装」「重新配置」
  // 「连接账号」照旧等真结果；账号这一轮要换 Key 的那一家也等，免得带着旧 Key 打开。
  const cachedPhase = loading && Boolean(snapshot?.system.cachedAt)
  function launchReadyBeforeScan(tool: ToolPresentation): boolean {
    if (!cachedPhase || !tool.status.installed || tool.error || !tool.configured || configFailure) return false
    if ([tool.id, `launch:${tool.id}`, `switch:${tool.id}`, `repair-hooks:${tool.id}`, `repair-config:${tool.provider}`].some((key) => jobs[key])) return false
    return !accountKeyChangePending({ signedIn: account !== null, restoring: props.accountRestoring === true, bootstrap: props.bootstrap ?? null }, tool.provider)
  }
  // 「接着聊」点下去走的是同一个「打开」，跟着它那一行走。
  function resumeReadyBeforeScan(provider: ToolId): boolean {
    const tool = tools.find((entry) => entry.id === provider)
    return tool !== undefined && launchReadyBeforeScan(tool)
  }
  // 「接着聊」与记录页同一条规则(#292):续接参数是 CLI 按工作目录找最近一条,
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
  const renderTool = useCallback((tool: ToolPresentation) => {
    const installJob = jobs[tool.id]
    const launchJob = jobs[`launch:${tool.id}`]
    const switchJob = jobs[`switch:${tool.id}`]
    const repairJob = jobs[`repair-hooks:${tool.id}`] ?? jobs[`repair-config:${tool.provider}`]
    const job = launchJob ?? switchJob ?? repairJob ?? installJob
    // 配置那一块没读到时，连接状态是未知而不是「还没配 Key」，
    // 否则用户会以为自己的配置丢了。工具本身的安装、卸载不受影响。
    const configUnavailable = !tool.error && tool.status.installed
      && props.failures?.some((failure) => failure.partition === 'config') === true
    // 开机先画出来的是上次的检测结果（cachedAt），装没装、配置归谁都可能已经变了，
    // 这时不下「被改过」「第三方配置」的结论，真结果回来再说。
    // 这次写 Key 时服务端说这个账号没开通它：再点「配置」也配不上，别显示成「还没配 Key」。
    const notEnabled = props.bootstrap?.result?.failed.some((entry) => entry.provider === providerFor(tool.id)
      && isAccountNotEnabledFailure(entry.message)) === true
    const ownershipPending = snapshot !== null && (Boolean(snapshot.system.cachedAt) || ownershipAwaitingAccount(snapshot.config, tool))
    const ccSwitch = snapshot && !ownershipPending ? ccSwitchLeftoverFor(snapshot.config.providers[tool.provider], tool.provider, tool.source) : null
    const foreignKey = snapshot && !ownershipPending ? foreignKeyKind(snapshot.config.providers[tool.provider], tool.source) : null
    const shadowed = snapshot !== null && !ownershipPending && codexNeedsRepair(snapshot.config.providers[tool.provider], tool.provider)
    // 修完就能用的，「打开」照旧给：点下去先修再打开（App 的 launch），不让人先去配置里绕一圈。
    const repairLaunch = shadowed && snapshot !== null && readyOnceRepaired(snapshot.config.providers[tool.provider], tool.provider)
    const openable = tool.configured || repairLaunch
    const hooksStale = snapshot !== null && !ownershipPending && cliHooksNeedRepair(snapshot.config.providers[tool.provider])
    const hooksDetail = snapshot?.config.providers[tool.provider].cliHooksShellChanged ? cliHooksShellChangedDetail : cliHooksStaleDetail
    const hooksAutoRepaired = snapshot !== null && !ownershipPending && cliHooksWereAutoRepaired(snapshot.config.providers[tool.provider])
    const hooksMissing = snapshot !== null && !ownershipPending && cliHooksMissing(snapshot.config.providers[tool.provider])
    // 工具自己都读不了的文件，里面读出来的 Key、来源都不作数，排在那些判断前面先说。
    const broken = snapshot !== null && !ownershipPending ? brokenConfigOf(snapshot.config.providers[tool.provider], tool.provider) : null
    const status = installJob ? 'installing' : tool.error ? 'detectionFailed' : !tool.status.installed ? 'missing'
      : configUnavailable ? 'configUnavailable'
      : broken ? 'configBroken'
      : ccSwitch ? 'ccSwitch'
      : shadowed ? 'codexShadowed'
      : tool.source === 'changed' && !ownershipPending ? 'configChanged'
      : foreignKey === 'otherSite' ? 'otherSiteKey' : foreignKey === 'otherAccount' ? 'otherAccountKey'
      : tool.source === 'unknown' && !ownershipPending ? 'unknownSource'
      : hooksStale ? 'cliHooksStale' : tool.source === 'official' ? 'official'
        : bootstrapBusy && !tool.configured ? 'configuring'
        : tool.configured ? 'ready' : notEnabled ? 'notEnabled' : 'unconfigured'
    // 「打开」以前每次都要重新选一遍目录。会话记录里本来就存着用过的目录，
    // 拿它当主按钮的默认值，旁边的下拉再给最近几个和原来的选择器（N7）。
    // 这个工具还没有记录时用上次在本软件里选过的文件夹，四个工具只问一次。
    // Codex 桌面端自己管工作区，不走这条路。
    const opensWorkspace = !configUnavailable && !tool.error && tool.status.installed
      && openable && tool.id !== 'codexDesktop'
    const workspaces = opensWorkspace ? launchWorkspaces(recent?.items ?? [], tool.provider, snapshot?.config.rememberedWorkspace) : []
    // 正在跑的那一行按钮写的是「打开中」「安装中」，这时不给下拉，但外面那层还在，
    // 按钮列的宽度就不会跟着一起跳。
    const lastWorkspace = job ? null : workspaces[0] ?? null
    // 这个工具没聊过、也从没选过文件夹（已知40）：「打开」不弹选择框，直接替他建好
    // 「文档\XingmangProjects\my-project」在里面打开，新手不会再选到桌面被拦。记录还没读到时
    // 说不准聊没聊过，照旧弹选择框。聊没聊过看整份记录里它有几条（stats），不只看首页取的那
    // 60 条：用得少的工具挤不进最近 60 条，不等于没用过。
    const startsFresh = opensWorkspace && workspaces.length === 0 && recent !== null
      && recent.stats.byProvider[tool.provider] === 0 && Boolean(props.onLaunchInNewFolder)
    // 归客户自己装的（认不出芯片的 Mac 上的 Codex 桌面端）这颗按钮只能把人带到教程：写「安装」就是骗人。
    const manualInstall = !tool.status.installed && needsManualInstall(snapshot, tool.id)
    // Codex 桌面端在 Windows 上是 Appx，装它要提权；四个 CLI 走 npm，不提权。
    const elevationHint = tool.id === 'codexDesktop' && !tool.status.installed
      ? elevatedInstallShortNotice('codexDesktop', snapshot?.platform.platform, snapshot?.platform.codexDesktop.install, snapshot?.platform.processElevated)
      : null
    const primaryLabel = launchJob ? '打开中' : switchJob ? '切换中' : repairJob ? '修复中' : installJob ? '安装中' : configUnavailable ? '重新配置'
      : bootstrapBusy && !tool.configured ? '配置中' : tool.error ? '重新检测' : !tool.status.installed ? manualInstall ? '安装指南' : '安装'
      : openable ? lastWorkspace ? `打开 ${workspaceButtonLabel(lastWorkspace.name)}` : '打开' : '连接账号'
    const primary = () => configUnavailable ? props.onConfigure(tool.id) : tool.error ? props.onScan() : !tool.status.installed ? props.onInstall(tool.id)
      : !openable ? props.onConfigure(tool.id)
      : startsFresh ? props.onLaunchInNewFolder?.(tool.id, true) : props.onLaunch(tool.id, lastWorkspace?.path)
    const rollback = job ? null : rollbackVersion(tool)
    const revert = job ? null : revertVersion(tool)
    const update = job ? null : toolUpdateOffer(tool)
    // 配置那一块没读到时来源是未知的，不给切换，免得在一份没读到的配置上做决定。
    // 账号还在恢复时来源同样没判定（见 ownershipAwaitingAccount），等恢复完再给。
    // Codex 读不了的文件，切换只会在合并那一步报错，出路是行上的「修好它」。
    const switchTarget = configUnavailable || broken || tool.error || ownershipPending ? null : accountSwitchTarget(tool)
    const blocked = tool.versionAdvice?.blockedReason ?? null
    // 桌面端没有推荐版本可换，已知打不开的那一版只能靠这行小字说清楚（第十九批 7）。
    const desktopKnownIssue = tool.id === 'codexDesktop' ? blocked : null
    // 原生/其他来源装的 CLI 不走本工具的 npm 通道，不给 npm 更新/回滚按钮，
    // 该更新时改用一句被动提示，避免在 npm 全局目录另装一份并存。官方安装器装的
    // Claude Code 例外：按钮照给，点了先问一句、卸掉再装（App.tsx 的 install）。
    const externalManaged = updatesOutsideApp(tool.id, tool.status)
    const externalHint = externalManaged ? externalInstallHint(tool.status.installSource) : null
    // 推荐版本比已装的新时这是一次「更新」，图标和文案都不能写成回退。
    const rollbackVerb = recommendedVersionVerb(tool)
    const rollbackIcon = tool.versionAdvice?.recommendedIsNewer ? Download : RotateCcw
    const waitingForScan = loading && !launchReadyBeforeScan(tool)
    // 扫描结束后仍可能在写入和复核新线路，旧配置不能在这段时间被工具读走。
    const waitingForAccount = openable && launchWaitingForAccount(tool.provider)
    // 文件坏了时读出来的来源不作数（见 brokenConfigOf），不说成官方账号。
    const officialLine = tool.source === 'official' && !broken && snapshot ? officialAccountSubtitle(snapshot.config.providers[tool.provider], Date.now()) : null
    const primaryButton = <Button size="sm" variant={tool.status.installed ? 'primary' : 'secondary'} loading={Boolean(job)}
      disabled={waitingForScan || waitingForAccount || launchBusy || bootstrapBusy && !tool.configured && !configUnavailable}
      title={lastWorkspace ? `在 ${lastWorkspace.path} 打开` : undefined}
      icon={lastWorkspace ? undefined : tool.status.installed && !bootstrapBusy ? ArrowUpRight : undefined}
      onClick={primary} testId={`tool-${tool.id}-primary`}>{primaryLabel}</Button>
    return <ToolRow key={tool.id} tool={tool.id} status={status}
      detail={job?.label ?? tool.error ?? (status === 'configBroken' && broken ? brokenConfigDetails[broken] : status === 'configChanged' ? configChangedDetail : status === 'codexShadowed' ? codexShadowedDetail : status === 'cliHooksStale' ? hooksDetail : status === 'ccSwitch' && ccSwitch ? ccSwitchDetails[ccSwitch] : foreignKey && status !== 'ccSwitch' ? foreignKeyDetails[foreignKey] : status === 'ready' && hooksMissing ? nodeMissing ? cliHooksMissingWithoutRuntimeDetail : cliHooksMissingDetail : status === 'ready' && hooksAutoRepaired ? cliHooksAutoRepairedDetail : elevationHint ?? desktopKnownIssue ?? undefined)}
      version={tool.status.installed ? versionSubtitle(tool) ?? '版本暂未识别' : undefined}
      model={tool.status.installed ? officialLine ? officialLine.text : tool.model || undefined : undefined}
      modelHint={tool.status.installed ? officialLine?.renewal : undefined}
      progress={job?.percent}
      extraAction={installJob?.cancellable
        ? <Button variant="ghost" size="sm" icon={X} loading={installJob.cancelling} onClick={() => props.onCancelInstall(tool.id)} testId={`tool-${tool.id}-cancel`}>{installJob.cancelling ? '正在停止' : '取消'}</Button>
        : status === 'configBroken' && props.onRepairConfig
          ? <Button variant="ghost" size="sm" icon={KeyRound} title="改之前会先备份原来的设置" onClick={() => props.onRepairConfig?.(tool.id)} testId={`tool-${tool.id}-repair-config`}>修好它</Button>
        : status === 'ccSwitch' && props.onSwitchAccount
          ? <Button variant="ghost" size="sm" icon={KeyRound} onClick={() => props.onSwitchAccount?.(tool.id, 'account')} testId={`tool-${tool.id}-replace-cc-switch`}>{switchAccountLabel(account?.username)}</Button>
        : status === 'codexShadowed' && props.onSwitchAccount
          ? <Button variant="ghost" size="sm" icon={KeyRound} title="改之前会先备份原来的设置" onClick={() => props.onSwitchAccount?.(tool.id, 'account')} testId={`tool-${tool.id}-repair-codex`}>修好它</Button>
        : status === 'cliHooksStale' && props.onRepairHooks
          ? <Button variant="ghost" size="sm" icon={KeyRound} title="改之前会先备份原来的设置" onClick={() => props.onRepairHooks?.(tool.id)} testId={`tool-${tool.id}-repair-hooks`}>修好它</Button>
        : (status === 'otherSiteKey' || status === 'otherAccountKey') && props.onSwitchAccount
          ? <Button variant="ghost" size="sm" icon={KeyRound} onClick={() => props.onSwitchAccount?.(tool.id, 'account')} testId={`tool-${tool.id}-use-account`}>{switchAccountLabel(account?.username)}</Button>
        : status === 'configChanged' && props.onRewriteKey
          ? <Button variant="ghost" size="sm" icon={KeyRound} onClick={() => props.onRewriteKey?.(tool.id)} testId={`tool-${tool.id}-rewrite-key`}>重新写入 Key</Button>
        : status === 'ready' && hooksMissing
          ? <Button variant="ghost" size="sm" icon={Download} title="改之前会先备份原来的设置" onClick={() => nodeMissing ? props.onRuntime('node') : props.onRepairHooks?.(tool.id)} testId={`tool-${tool.id}-add-hooks`}>补上</Button>
        : externalManaged
          ? externalHint && (tool.updateAvailable || (rollback && blocked))
            ? <span className="v2-tool-external-note" title={externalHint} data-testid={`tool-${tool.id}-external-managed`}>{externalHint}</span>
            : undefined
          : rollback && blocked
            ? <Button variant="ghost" size="sm" icon={rollbackIcon} title={blocked} onClick={() => props.onInstall(tool.id, rollback)} testId={`tool-${tool.id}-rollback`}>{`${rollbackVerb}推荐版本`}</Button>
            : update?.newer ? <Button variant="ghost" size="sm" icon={Download} title={updateButtonHint(tool)} onClick={() => props.onInstall(tool.id, update.version ?? update.target ?? undefined)}>更新</Button> : undefined}
      primaryAction={workspaces.length ? <span className="v2-tool-launch" data-testid={`tool-${tool.id}-launch`}>
        {primaryButton}
        {lastWorkspace && <Menu label="换一个目录" testId={`tool-${tool.id}-workspaces`}
          anchor={<Button size="sm" variant="primary" icon={ChevronDown} disabled={waitingForScan || waitingForAccount || launchBusy} aria-label="换一个目录" />}
          items={workspaceChoices(workspaces).filter((choice) => !choice.create || props.onLaunchInNewFolder).map((choice) => ({
            label: choice.label,
            disabled: waitingForScan || waitingForAccount || launchBusy,
            testId: choice.create ? `tool-${tool.id}-new-workspace` : choice.path === null ? `tool-${tool.id}-choose-workspace` : undefined,
            onSelect: () => choice.create ? props.onLaunchInNewFolder?.(tool.id) : props.onLaunch(tool.id, choice.path ?? undefined),
          }))} />}
      </span> : primaryButton}
      menu={tool.status.installed && !job ? [
        // 还没有最近目录时「打开」旁边没有下拉。「打开」已经替人新建了，想用自己的文件夹从这里选
        // （已知40）；记录还没读到、「打开」还是弹选择框的那一小会儿，这里照旧给新建入口。
        ...(opensWorkspace && !lastWorkspace && props.onLaunchInNewFolder ? [startsFresh ? {
          label: chooseWorkspaceLabel,
          testId: `tool-${tool.id}-choose-workspace`,
          disabled: waitingForScan || waitingForAccount || launchBusy,
          onSelect: () => props.onLaunch(tool.id),
        } : {
          label: newWorkspaceLabel,
          testId: `tool-${tool.id}-new-workspace`,
          disabled: waitingForScan || waitingForAccount || launchBusy,
          onSelect: () => props.onLaunchInNewFolder?.(tool.id),
        }] : []),
        { label: '配置', onSelect: () => props.onConfigure(tool.id) },
        // 故意改过配置的人也要有出路，否则那颗黄角标会一直挂着。认下之后这个工具
        // 就按「自己填写的密钥」处理，下次在配置里改回星芒账号时标记自动清掉。
        ...((status === 'configChanged' || status === 'ccSwitch') && props.onKeepConfig ? [{ label: '就用现在这份', testId: `tool-${tool.id}-keep-config`, onSelect: () => props.onKeepConfig?.(tool.id) }] : []),
        ...(switchTarget && props.onSwitchAccount ? [{ label: switchTarget === 'account' ? switchAccountLabel(account?.username) : '切回官方账号', testId: `tool-${tool.id}-switch-${switchTarget}`, onSelect: () => props.onSwitchAccount?.(tool.id, switchTarget) }] : []),
        // 界面上一直只把配置路径写成一行灰字，而 `.` 开头的目录在资源管理器和
        // 访达里默认都看不见，用户和客服只能手敲路径。
        ...(props.onOpenConfigDirectory ? [{
          ...configDirectoryMenuItem(tool, configUnavailable),
          testId: `tool-${tool.id}-open-config-directory`,
          onSelect: () => props.onOpenConfigDirectory?.(tool.id),
        }] : []),
        ...(rollback && !blocked ? [{ label: `${rollbackVerb}推荐版本 ${rollback}`, testId: `tool-${tool.id}-rollback-menu`, onSelect: () => props.onInstall(tool.id, rollback) }] : []),
        // 推荐版本本身在这台电脑上出问题时，「回到推荐版本」帮不上忙：他就在推荐版本上。
        // 与上一项指向同一个版本时不重复给。
        ...(revert && revert !== rollback && props.onRevert ? [{ label: `退回更新前的版本 ${revert}`, testId: `tool-${tool.id}-revert`, onSelect: () => props.onRevert?.(tool.id, revert) }] : []),
        ...(tool.provider === 'codex' ? [{ label: '换用别家模型', testId: tool.id === 'codex' ? 'home-codex-models' : 'home-codexDesktop-models', onSelect: props.onCodexModels }] : []),
        { label: '查看记录', onSelect: () => props.onNavigate('sessions') },
        ...(tool.provider === 'codex' && tool.source === 'official' ? [{ label: '官方账户额度', onSelect: () => { setOfficial(snapshot?.system.officialChatGpt ?? null); setOfficialOpen(true) } }] : []),
        ...(canUninstallTool(
          tool.status,
          tool.id === 'codexDesktop' && snapshot?.platform.codexDesktop.uninstall === true,
        )
          ? [{ label: '卸载', danger: true, onSelect: () => props.onUninstall(tool.id) }]
          : []),
      ] : undefined} menuLabel={toolMenuLabel} testId={`tool-row-${tool.id}`} />
  }, [bootstrapBusy, jobs, launchBusy, launchReadyBeforeScan, launchWaitingForAccount, loading, props, recent])
  const renderExternal = (tool: ExternalPresentation) => {
    const installJob = jobs[tool.id], launchJob = jobs[`launch:${tool.id}`], job = launchJob ?? installJob
    const status = installJob ? 'installing' : tool.status.detectionError ? 'detectionFailed' : !tool.status.installed ? 'missing'
      : tool.configurationStatus
    // macOS 上没有核对得了的官方 Mac 包的（主进程 macos-desktop-app-installer.ts 那张表之外，
    // installSupported 为假）要客户自己下载。原来按钮写「暂不支持」且点不动，客户看到的是
    // 死路一条；现在带他去教程里那一章（第七批 3）。表里有的照常「安装」。
    // Windows arm64 上 WorkBuddy 同样装不了，但那是没有对应架构的包，教程救不了，
    // 仍旧保持「暂不支持」。
    const manualInstall = tool.action === 'install' && tool.disabled && snapshot?.platform.isMac === true
    // Windows 上缺系统安装组件时一键安装不了，与其留一颗点不动的「暂不支持」，
    // 不如直接把人送到官网下载页（网址由主进程给，白名单逐条收录）。
    const downloadUrl = tool.action === 'install' && tool.disabled && !manualInstall && props.onOpenExternalDownload ? tool.status.officialDownloadUrl ?? null : null
    const primaryLabel = launchJob ? '打开中' : installJob ? '安装中' : tool.action === 'scan' ? '重新检测' : tool.action === 'install' ? manualInstall ? '安装指南' : downloadUrl ? '去官网下载' : tool.disabled ? '暂不支持' : '安装' : tool.action === 'launch' ? '打开' : '配置'
    const primary = () => manualInstall ? props.onNavigate('tutorial', macDesktopTutorialTopic) : downloadUrl ? props.onOpenExternalDownload?.(downloadUrl) : tool.action === 'scan' ? props.onScan() : tool.action === 'install' ? props.onInstallExternal(tool.id) : tool.action === 'launch' ? props.onLaunchExternal(tool.id) : props.onConfigureExternal(tool.id)
    return <ToolRow key={tool.id} tool={tool.id} status={status} detail={job?.label ?? tool.detail} progress={installJob?.percent}
      extraAction={installJob?.cancellable && props.onCancelInstallExternal
        ? <Button variant="ghost" size="sm" icon={X} loading={installJob.cancelling} onClick={() => props.onCancelInstallExternal?.(tool.id)} testId={`tool-${tool.id}-cancel`}>{installJob.cancelling ? '正在停止' : '取消'}</Button>
        : undefined}
      primaryAction={<Button size="sm" variant={tool.status.installed ? 'primary' : 'secondary'} loading={Boolean(job)} disabled={externalBusy || launchBusy || (tool.disabled && !manualInstall && !downloadUrl)} title={tool.disabled && !manualInstall && !downloadUrl ? tool.status.installHint ?? '当前平台暂不支持此操作' : undefined}
        icon={tool.action === 'launch' || downloadUrl ? ArrowUpRight : undefined} onClick={primary} testId={tool.action === 'configure' ? `home-client-${tool.id}` : `tool-${tool.id}-primary`}>{primaryLabel}</Button>}
      menu={tool.status.installed && !job ? [
        // 配置入口只留「…」菜单这一处：行左边不再放独立的「配置」按钮，否则同一行会出现两个配置入口，
        // 而四个 CLI 行从来只有菜单入口，用户看到的是同类工具行给法不一致。主按钮已经是这个动作时菜单里不再重复。
        ...(tool.action === 'configure' ? [] : [{ label: '配置', disabled: externalCached, testId: `home-client-${tool.id}`, onSelect: () => props.onConfigureExternal(tool.id) }]),
        ...(tool.action === 'launch' ? [] : [{ label: '打开', disabled: !tool.status.launchSupported || launchBusy || externalCached, onSelect: () => props.onLaunchExternal(tool.id) }]),
      ] : undefined} menuLabel={toolMenuLabel} testId={`tool-row-${tool.id}`} />
  }
  return <section className="v2-page v2-home" data-testid="page-home">
    <PageHead title={`${greeting(new Date().getHours())}${account ? `，${account.username}` : ''}`}
      lead="选择工具开始任务，或打开聊天描述你的问题。" actions={<>
        <Button onClick={props.onGuide} testId="home-guide">新手引导</Button>
        <Button icon={RefreshCw} loading={loading || props.externalLoading} onClick={props.onScan} testId="home-rescan">重新检测</Button>
      </>} />
    {props.bootstrap && !props.bootstrap.result && <div className="v2-bootstrap-notice" role={props.bootstrap.error ? 'alert' : 'status'} data-busy={props.bootstrap.error ? undefined : 'true'}>
      <span className={`v2-dot ${props.bootstrap.error ? 'is-warn' : ''}`} />
      <span>{props.bootstrap.error ? bootstrapErrorText(props.bootstrap.error) : `${props.bootstrap.label}（${props.bootstrap.percent}%）`}</span>
      {props.bootstrap.error && props.onBootstrapRetry && <Button size="xs" onClick={props.onBootstrapRetry}>重新同步</Button>}
    </div>}
    {props.relayFallback && <div role="status" className="v2-callout is-warn" data-testid="home-relay-fallback"><span>{relayFallbackNotice}</span></div>}
    {routeRestart && <div role="status" className="v2-callout is-warn" data-testid="home-route-restart"><span>{routeRestart}</span>
      {props.onRestartCodexDesktop && offersCodexDesktopRestart(props.bootstrap?.routeRestart) && <Button size="xs" loading={Boolean(jobs['launch:codexDesktop'])} disabled={launchBusy}
        onClick={props.onRestartCodexDesktop} testId="home-route-restart-codex-desktop">帮我重开 Codex 桌面端</Button>}
      {props.onDismissRouteRestart && <Button size="xs" variant="ghost" onClick={props.onDismissRouteRestart} testId="home-route-restart-dismiss">知道了</Button>}
    </div>}
    {bootstrapResult && bootstrapNoticeShown && (bootstrapResult.configured.length || bootstrapFailed.length || bootstrapResult.warnings.length) > 0 && <div className={`v2-bootstrap-notice ${bootstrapFailed.length || bootstrapResult.warnings.length ? 'is-warn' : ''}`} role="status">
      <span className={`v2-dot ${bootstrapFailed.length || bootstrapResult.warnings.length ? 'is-warn' : 'is-ok'}`} /><span>{bootstrapResult.networkBlocked ? offlineBootstrapNotice : `${bootstrapResult.configured.length ? configuredKeysText(bootstrapResult.configured.length) : '账号 Key 已同步。'}${bootstrapFailed.length ? ` ${bootstrapFailed.map((entry) => keySyncFailureText(entry.provider, entry.message)).join('；')}` : ''}${bootstrapResult.warnings.length ? ` ${bootstrapResult.warnings.join('；')}` : ''}`}</span>
      {/* 账号没开通的工具点多少次「重新同步」都一样，只剩这种失败时不给这个按钮。 */}
      {(bootstrapFailed.some((entry) => !isAccountNotEnabledFailure(entry.message)) || bootstrapResult.warnings.length > 0) && props.onBootstrapRetry && <Button size="xs" onClick={props.onBootstrapRetry}>重新同步</Button>}
    </div>}
    {error && <div role="alert" className="v2-callout is-bad"><span>{error}</span><Button size="xs" onClick={props.onScan}>重新检测</Button></div>}
    {props.externalError && <div role="alert" className="v2-callout is-bad"><span>客户端状态暂未读到：{props.externalError}</span><Button size="xs" onClick={props.onScan}>重新检测</Button></div>}
    {snapshot && configFailure && <div role="alert" className="v2-callout is-bad" data-testid="home-config-failure"><span>工具配置暂未读到（{configFailure.message.replace(/[。.\s]+$/, '')}）。工具列表、安装和卸载照常可用；点工具行的「重新配置」可以重新写入。</span><Button size="xs" onClick={props.onScan}>重新检测</Button></div>}
    {props.supportsBilling !== false && dollars !== null && dollars < 5 && !subscription && <div role="status" className="v2-callout is-bad" data-testid="home-low-balance"><Zap size={18} /><span>{lowBalanceText(dollars)}</span><Button size="sm" variant="balance" onClick={() => props.onNavigate('account', 'recharge')}>马上充值</Button></div>}
    {props.supportsBilling !== false && subscriptionNotice && <div role="status" className="v2-callout is-bad" data-testid="home-subscription-warning"><Zap size={18} /><span>{subscriptionNotice}</span><Button size="sm" variant="balance" onClick={() => props.onNavigate('account', 'recharge')}>去续费</Button></div>}
    {loading && snapshot?.system.cachedAt && <div className="v2-loading-inline" role="status" data-testid="home-cached-scan">正在检查本机工具，先显示上次的结果。</div>}
    <div className="v2-home-grid">
      <div className="v2-home-main">
        {!ready && !loading && !configFailure && <Card title="开始使用" meta="第 1 步，共 4 步" padding="none" testId="home-setup">
          <div className="v2-setup-focus"><span className="v2-step-number">1</span><div><h3>选择一种开始方式</h3><p>选一个工具先开始，之后随时可以再装别的。</p></div><Button variant="primary" onClick={props.onGuide}>开始准备</Button></div>
          <ol className="v2-setup-steps">{['选开始方式', '准备工具', '确认连接', '开始使用'].map((label, i) => <li key={label}><span>{i + 1}</span>{label}</li>)}</ol>
        </Card>}
        {firstScan ? <Card title="你的工具" testId="home-tools-detecting"><p className="v2-loading-inline" role="status">正在检测这台电脑上装了哪些工具</p><Skeleton rows={3} /></Card>
          : yourTools.length + yourExternal.length > 0 && <Card title="你的工具" meta={<span title={yourToolsMeta}>{yourToolsMeta}</span>} padding="none" testId="home-your-tools">{yourTools.map(renderTool)}{yourExternal.map(renderExternal)}</Card>}
        {firstRunTool && firstRun && <Card title="试试第一条命令" meta={firstRunTool.name} testId="home-first-run"
          actions={<Button variant="ghost" size="xs" icon={X} aria-label="不再显示这条提示" title="不再显示这条提示" testId="home-first-run-dismiss"
            onClick={() => setFirstRunDismissed((current) => dismissFirstRun(getFirstRunStorage(), current, firstRunTool.id))} />}>
          <FirstRunSteps key={firstRunTool.id} name={firstRunTool.name} firstRun={firstRun} testId="home-first-run-steps"
            gitHint={firstRunTool.id === 'claude' && gitMissing ? gitMissingFirstRunHint(gitHost) : undefined} />
        </Card>}
        <Card title="最近" meta="从上次停下的地方继续" padding="none" testId="home-recent-card" actions={<Button variant="ghost" size="xs" onClick={() => props.onNavigate('sessions')}>全部记录</Button>}>
          {recentError ? <Empty icon={History} title="记录暂时没有读到" description={recentError} action={<Button onClick={() => setRecentAttempt((value) => value + 1)}>重新加载</Button>} />
            : !recent ? <div className="v2-loading-inline" role="status">正在读取最近记录</div>
              : recent.items.length ? recent.items.slice(0, 3).map((session) => <ListRow key={session.id} leading={<BrandIcon tool={session.provider} size={18} />}
                testId={`home-recent-row-${session.id}`} title={<span className="v2-recent-title" title={session.title}>{session.title}</span>}
                desc={<span title={session.cwd || undefined}>{recentSessionSubtitle(session)}</span>} meta={formatRecentTime(session.updatedAt, Date.now())}
                badge={session.cwdExists === false ? <Pill tone="warn" testId={`home-recent-missing-${session.id}`}>文件夹已不存在</Pill> : undefined}
                actions={<>
                  {resumable.has(session.id) && !session.archived && recentResumeOffered(tools, session.provider) && <Button size="xs" loading={resumeChecking === session.id}
                    disabled={(loading && !resumeReadyBeforeScan(session.provider)) || launchWaitingForAccount(session.provider) || launchBusy || resumeChecking !== null || session.cwdExists === false}
                    onClick={() => void resumeRecent(session)}
                    title={recentResumeHint(session)} testId={`home-recent-resume-${session.id}`}>接着聊</Button>}
                  {Boolean(session.cwd) && <Button size="xs" variant="ghost" icon={FolderOpen} disabled={session.cwdExists === false}
                    aria-label="打开文件夹" title={session.cwdExists === false ? '这个文件夹已经不在了，打不开' : `在文件管理器里打开 ${session.cwd}`}
                    onClick={() => void openRecentDirectory(session.id)} testId={`home-recent-open-directory-${session.id}`} />}
                  <Button size="xs" variant="ghost" onClick={() => props.onNavigate('sessions')}>查看</Button>
                </>} />)
                : <Empty icon={History} title="还没有对话记录" description="打开工具聊过之后，这里会出现最近的会话。" />}
        </Card>
        {/* 「还可以装」排在最下面：老用户天天看的是上面三张，新用户要装的东西在「开始使用」里也能找到。 */}
        {!firstScan && availableCount > 0 && <Card title="还可以装" meta={`${availableCount} 个`} collapsible defaultOpen={readLocalPreference(availablePreference) !== 'collapsed'}
          onOpenChange={(open) => { writeLocalPreference(availablePreference, open ? 'expanded' : 'collapsed') }} padding="none" testId="home-available">{available.map(renderTool)}{availableExternal.map(renderExternal)}</Card>}
        {!firstScan && (externalCached || (props.externalLoading && !external.length)) && <div className="v2-loading-inline" role="status" data-testid="home-external-detecting">正在检测 WorkBuddy、Claude Desktop 和 OpenCode</div>}
      </div>
      <aside className="v2-home-aside">
        <Card title="运行环境" padding="none" meta={snapshot ? new Date(snapshot.system.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '等待检查'}>
          <div className="v2-runtime-list">{(['node', 'python', 'git'] as const).map((id) => {
            const status = snapshot?.system.runtime[id]
            const optional = id !== 'node' || nodeOptional
            // 装工具用的那个组件（npm）是 Node.js 自带的，不单列一行，缺了才在 Node.js 这一行说。
            const partMissing = id === 'node' && nodeInstallerPartMissing(snapshot?.system.runtime)
            const text = jobs[id]?.label ?? (loading ? '检测中' : status?.detectionFailed ? '检测失败' : status?.version ?? (optional ? '可选 · 未装' : '未安装'))
            // 检测中、还没检测过都是灰点：那时不知道装没装，不能先挂橙点。
            const dot = loading || !status ? '' : status.installed && !partMissing ? 'is-ok' : optional ? '' : 'is-warn'
            return <div key={id} className="v2-runtime-row" data-testid={`home-runtime-row-${id}`}><i className={`v2-dot ${dot}`} /><BrandIcon tool={id} size={16} variant="xs" /><strong>{id === 'node' ? 'Node.js' : id === 'python' ? 'Python' : 'Git'}</strong>
              <span>{partMissing && !jobs[id] && !loading ? `${text} · ${nodeInstallerPartMissingNote}` : text}</span>
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
            {!loading && pythonMissing && runtimeInstallButtonShown('python', snapshot?.platform.platform, snapshot?.platform.pythonRuntimeInstall) && <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onRuntime('python')} testId="home-runtime-python">{runtimeButtonLabel('python', snapshot?.platform.pythonRuntimeInstall)}</Button>}
            {((nodeGuide && !nodeGuide.noTutorial) || (pythonGuide && !pythonGuide.noTutorial)) && <Button variant="ghost" size="sm" icon={BookOpen} onClick={() => props.onNavigate('tutorial', macRuntimeTutorialTopic)} testId="home-runtime-tutorial">看教程</Button>}
            {gitMissing && gitHost !== 'other' && <Button variant="ghost" size="sm" icon={Download} loading={Boolean(jobs.git)} disabled={Boolean(jobs.git)} onClick={() => props.onRuntime('git')} testId="home-runtime-git">安装 Git</Button>}</div>
        </Card>
        <Card title="账户余额" padding="none">
          <div className={`v2-balance-body tone-${tier}`}><div title={balanceHint}><strong data-testid="home-balance">{dollars === null ? '—' : `$${dollars.toFixed(2)}`}</strong><small data-testid="home-balance-label">{balanceLabel}</small>{balanceStore && account && <Button variant="ghost" size="xs" icon={RefreshCw} loading={balanceState.loading} aria-label="刷新账户余额" title={balanceHint} onClick={() => void balanceStore.refresh('manual')} testId="home-balance-refresh" />}</div>
            {balanceState.error && <p className="v2-balance-error" role="status" title={balanceState.error}>更新失败，{balance ? '显示上次余额' : '请重试'}</p>}
            <div className="v2-balance-usage">{monthUsed !== null && dollars !== null && <Progress tone={tier === 'neutral' ? 'neutral' : tier} value={monthUsed + dollars > 0 ? monthUsed / (monthUsed + dollars) * 100 : 0} label={`本月已用 $${monthUsed.toFixed(2)}`} />}
              <p>{subscriptionLine ? <span data-testid="home-subscription">{subscriptionLine}</span> : props.supportsUsage === false ? '请在官方网站查看消费记录。' : usageError || (remainingDays !== null ? `按最近 7 天用量约还能用 ${remainingDays} 天${remainingDays < 7 ? '，建议提前充值' : ''}。` : usage ? balance ? '最近 7 天暂无用量' : '读到余额后显示还能用多久' : account ? '正在读取用量' : props.accountRestoring ? '登录恢复后自动显示用量' : '登录后查看用量')}</p></div>
            <div className="v2-balance-actions">{props.supportsBilling !== false && <Button variant="balance" size="sm" icon={Zap} onClick={() => props.onNavigate('account', 'recharge')}>充值</Button>}{props.supportsUsage !== false && <Button variant="ghost" size="sm" onClick={() => props.onNavigate('account', 'dashboard')}>用量看板</Button>}</div>
          </div>
        </Card>
        {/* 整行都能点，右边的箭头只是记号。Codex 已经在用（装着、「最近」里有它的记录）就不再教它入门。 */}
        <Card title="可以试试" padding="none" testId="home-suggestions"><ListRow icon={Plug} title="给 AI 连上浏览器和数据库" onOpen={() => props.onNavigate('mcp')} actions={<ArrowRight size={16} aria-hidden="true" />} testId="home-suggestion-mcp" />
          <ListRow icon={MessageSquare} title="不开终端，直接在这里聊" onOpen={() => props.onNavigate('chat')} actions={<ArrowRight size={16} aria-hidden="true" />} testId="home-suggestion-chat" />
          {!codexInUse && <ListRow icon={BookOpen} title="第一次用 Codex？跟着 4 步开始" onOpen={() => props.onNavigate('tutorial')} actions={<ArrowRight size={16} aria-hidden="true" />} testId="home-suggestion-codex" />}</Card>
      </aside>
    </div>
    {officialOpen && <Dialog open title="ChatGPT 官方账户额度" width={480} onClose={() => setOfficialOpen(false)} busy={officialBusy}
      footer={<><Button onClick={() => setOfficialOpen(false)} disabled={officialBusy}>关闭</Button><Button icon={RefreshCw} loading={officialBusy} onClick={() => void refreshOfficial()}>刷新额度</Button></>}>
      {officialError && <p className="v2-callout is-bad" role="alert">{officialError}</p>}
      {official ? <><p>{official.planLabel ?? '官方账户'}{official.renewsAt ? ` · ${new Date(official.renewsAt).toLocaleDateString('zh-CN')} 续订` : ''}</p>
        {official.windows.map((window) => <div className="v2-config-field" key={window.id}><Progress value={window.remainingPercent} label={`${window.label} · 剩余 ${window.remainingPercent}%`} />{window.resetAt && <small>{new Date(window.resetAt).toLocaleString('zh-CN')} 重置</small>}</div>)}
        {official.resetCredits !== null && <p>剩余额度 {official.resetCredits}</p>}<p>更新于 {new Date(official.checkedAt).toLocaleString('zh-CN')}</p></> : <p>官方额度暂未读取，刷新后查看。</p>}
    </Dialog>}
  </section>
}
