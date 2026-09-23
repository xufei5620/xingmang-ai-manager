import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, BookOpen, ChevronDown, Download, FolderOpen, History, KeyRound, MessageSquare, Plug, RefreshCw, RotateCcw, X, Zap } from 'lucide-react'
import type { AccountBalance, AccountProfile, AccountSourceTarget, CliLaunchMode, ExternalClientStatus, ExternalToolId, MultiProviderSessionPage, OfficialChatGptAccount } from '../../../../electron/ipc-contract'
import { presentExternalClients } from './external-model'
import { useSharedAccountBalance } from '../app/balance-context'
import { balanceStatusText } from '../shell/balance-status'
import { BrandIcon, Button, Card, Dialog, Empty, ListRow, Menu, PageHead, Pill, Progress, ToolRow, useToast } from '../../ui'
import { accountSwitchTarget, balanceTier, canUninstallTool, configDirectoryMenuItem, externalInstallHint, greeting, isExternallyManagedInstall, needsManualInstall, ownershipAwaitingAccount, presentTools, recommendedVersionVerb, rollbackVersion, versionSubtitle, type ToolboxSnapshot, type ToolId, type ToolPresentation } from './model'
import type { ToolboxPartitionFailure, ToolsApi } from './api'
import type { ToolJob } from './useToolbox'
import type { AccountBootstrapProgress, AccountBootstrapResult } from './account-bootstrap'
import type { PageId } from '../../registry/pages'
import { macDesktopTutorialTopic, macRuntimeTutorialTopic } from '../../registry/business'
import { tools as toolRegistry } from '../../registry/tools'
import { FirstRunSteps } from './FirstRun'
import { keySyncFailureReason, keySyncFailureText } from './key-sync-failure'
import { dismissFirstRun, getFirstRunStorage, readFirstRunDismissals } from './first-run-dismissal'
import { latestSessionIdsByWorkspace, newWorkspaceLabel, recentWorkspaces, workspaceButtonLabel, workspaceChoices } from './recent-workspaces'
import { errorMessage } from '../../business-common'
import { isNetworkFailureText } from './online-resync'
import { gitHostPlatform, gitMissingFirstRunHint, gitMissingNotice } from '../../../../electron/git-runtime'
import { runtimeButtonLabel, runtimeInstallGuide } from './runtime-install-guide'
import { RuntimeInstallHint } from './RuntimeInstallHint'
import { elevatedInstallNotice, elevatedInstallShortNotice } from './elevation-notice'

export interface HomeProps {
  api: ToolsApi
  snapshot: ToolboxSnapshot | null
  loading: boolean
  error: string
  /** 单块读失败的原因；缺省 = 三块都读到了（旧行为）。 */
  failures?: ToolboxPartitionFailure[]
  account: AccountProfile | null
  supportsUsage?: boolean
  supportsBilling?: boolean
  balance: AccountBalance | null
  jobs: Record<string, ToolJob>
  externalClients: ExternalClientStatus[]
  externalLoading: boolean
  externalError: string
  /**
   * 「最近」这份列表在 toolsApi 里缓存 60 秒。外层作废缓存时把这个数字加一，
   * 首页就重读一遍（装卸工具、打开工具、换账号、主动重新检测都会走到）。
   * 省略 = 不主动重读（旧行为）。
   */
  recentRevision?: number
  onScan(): void
  /** version 省略 = 让主进程按已验证版本名单决定;点名 = 回到推荐版本(N1)。 */
  onInstall(tool: ToolId, version?: string): void
  /** 中止正在进行的安装或更新。 */
  onCancelInstall(tool: ToolId): void
  /**
   * workspace 省略 = 弹目录选择器(旧行为);点名 = 直接用记住的目录打开(N7)。
   * mode 省略 = 开新对话;'resumeLast' = 接着这个目录里最近的一条对话(#292)。
   */
  onLaunch(tool: ToolId, workspace?: string, mode?: CliLaunchMode): void
  /** 不选目录，替用户新建一个项目文件夹再打开；缺省 = 不给这个入口（旧行为）。 */
  onLaunchInNewFolder?(tool: ToolId): void
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
  /** 在资源管理器 / 访达里打开这个工具的配置文件夹；缺省 = 不给这个菜单项（旧行为）。 */
  onOpenConfigDirectory?(tool: ToolId): void
  onConfigureExternal(tool: ExternalToolId): void
  onInstallExternal(tool: ExternalToolId): void
  onLaunchExternal(tool: ExternalToolId): void
  onCodexModels(): void
  onUninstall(tool: ToolId): void
  onRuntime(runtime: 'node' | 'python' | 'git'): void
  onNavigate(page: PageId, section?: string): void
  onGuide(): void
  bootstrap?: (AccountBootstrapProgress & { scope: string; result?: AccountBootstrapResult; error?: string }) | null
  onBootstrapRetry?(): void
}

function firstRunOf(tool: ToolId) {
  return toolRegistry.find((item) => item.id === tool)?.firstRun
}

/**
 * 断网启动时这条横幅原来会先说一句「账号 Key 已同步」，再跟上一串网络失败原文，
 * 自相矛盾且没交代下一步。网络类失败改说这一句：已装好的工具照常能用，网络回来
 * 之后客户端自己会补写，用户什么都不用做。「重新同步」按钮保留，想立刻试的照点。
 */
const offlineBootstrapNotice = '当前网络不可用，已装好的工具照常能用；联网后会自动补写 Key。'

/**
 * 「配置被改过」这一档必须自己解释一句：角标只说了发生什么，没说会怎样。
 * 用户真正要知道的是这个工具现在可能连不上，以及有一颗按钮能一键修回来。
 * 文案以「当前账号」为主语，不提站点。
 */
const configChangedDetail = '配置在软件之外被改动过，当前账号的 Key 可能已经不在里面了'

const accountSwitchLabels: Record<AccountSourceTarget, string> = {
  account: '切到当前账号',
  official: '切回官方账号',
}

function bootstrapErrorText(error: string) {
  return isNetworkFailureText(error) ? offlineBootstrapNotice : `账号 Key 初始化没有完成：${keySyncFailureReason(error)}`
}

export function Home(props: HomeProps) {
  const { snapshot, account, balance, jobs, loading, error } = props
  const { store: balanceStore, snapshot: balanceState } = useSharedAccountBalance()
  const balanceHint = balanceStatusText({ balanceLoading: balanceState.loading, balanceUpdatedAt: balanceState.updatedAt, balanceError: balanceState.error })
  const toast = useToast()
  const [recent, setRecent] = useState<MultiProviderSessionPage | null>(null)
  const [recentError, setRecentError] = useState('')
  const [recentAttempt, setRecentAttempt] = useState(0)
  const [usage, setUsage] = useState<Awaited<ReturnType<ToolsApi['balanceUsage']>> | null>(null)
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
    setUsage(null); setUsageError('')
    if (account && props.supportsUsage !== false) void props.api.balanceUsage().then((value) => { if (current) setUsage(value) }).catch(() => { if (current) setUsageError('用量暂未读到') })
    return () => { current = false }
  }, [account?.userId, props.api, props.supportsUsage])
  /**
   * 「最近」那三行的「打开文件夹」。只传会话 id，路径由主进程从记录里取并校验。
   * 失败（文件夹刚被删掉、盘符掉了）只提示一句，不动这份列表：它 60 秒后自己
   * 会重读，而这一下点击不值得让整张卡重来一遍。
   */
  async function openRecentDirectory(sessionId: string) {
    try { await props.api.openSessionDirectory(sessionId) }
    catch (cause) { if (active.current) toast.show(errorMessage(cause, '这条记录的文件夹没有打开。'), 'warn') }
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
  const tools = snapshot ? presentTools(snapshot) : []
  const installed = tools.filter((tool) => tool.status.installed || jobs[tool.id])
  const available = tools.filter((tool) => !tool.status.installed && !jobs[tool.id])
  const external = presentExternalClients(props.externalClients)
  const installedExternal = external.filter((tool) => tool.status.installed || jobs[tool.id])
  const availableExternal = external.filter((tool) => !tool.status.installed && !jobs[tool.id])
  const installedCount = installed.length + installedExternal.length
  const availableCount = available.length + availableExternal.length
  const dollars = balance && balance.quotaPerUnit > 0 ? balance.quota / balance.quotaPerUnit : null
  const tier = dollars === null ? 'neutral' : balanceTier(dollars)
  const monthUsed = usage && balance && balance.quotaPerUnit > 0 ? usage.monthQuota / balance.quotaPerUnit : null
  const remainingDays = usage && balance && usage.weekQuota > 0 ? Math.max(0, Math.floor(balance.quota / (usage.weekQuota / 7))) : null
  const configFailure = props.failures?.find((failure) => failure.partition === 'config') ?? null
  const ready = installed.some((tool) => tool.configured && !tool.error) || installedExternal.some((tool) => tool.ready && !tool.status.detectionError)
  const connectedCount = installed.filter((tool) => tool.configured).length + installedExternal.filter((tool) => tool.status.configured && tool.status.configurationSource === 'xingmang').length
  // Git 是可选环境：只在探到「确实没装」时提示（探测失败按 A4 显示失败、不当没装）。
  const gitHost = gitHostPlatform(snapshot?.platform.platform ?? 'other')
  const gitStatus = snapshot?.system.runtime.git
  const gitMissing = Boolean(gitStatus && !gitStatus.installed && !gitStatus.detectionFailed)
  // macOS 上 Node / Python 归客户自己装（platform.nodeRuntimeInstall === 'external'）：
  // 按钮点下去只是开网页，所以这里补一段中文步骤，别让人以为应用正在替他装。
  // 探测失败时不给这段：那时候并不知道它装没装，「没有找到」是假话（同 Git 那一行 A4）。
  const nodeMissing = Boolean(snapshot && !snapshot.system.runtime.node.installed && !snapshot.system.runtime.node.detectionFailed)
  const pythonMissing = Boolean(snapshot && !snapshot.system.runtime.python.installed && !snapshot.system.runtime.python.detectionFailed)
  const nodeGuide = nodeMissing ? runtimeInstallGuide('node', snapshot?.platform.platform, snapshot?.platform.nodeRuntimeInstall) : null
  const pythonGuide = pythonMissing ? runtimeInstallGuide('python', snapshot?.platform.platform, snapshot?.platform.pythonRuntimeInstall) : null
  // Windows 上 Node.js 是机器级 MSI，点「准备 Node.js」必然弹一次 UAC。说在点之前，
  // 不是弹窗跳出来之后（Python 按当前用户装，没有这句）。
  const nodeElevationNotice = nodeMissing
    ? elevatedInstallNotice('node', snapshot?.platform.platform, snapshot?.platform.nodeRuntimeInstall)
    : null
  const bootstrapBusy = Boolean(props.bootstrap && !props.bootstrap.result && !props.bootstrap.error)
  const launchBusy = Object.keys(jobs).some((key) => key.startsWith('launch:'))
  // 「接着聊」与记录页同一条规则(#292):续接参数是 CLI 按工作目录找最近一条,
  // 不按会话 id 挑,所以按钮只能长在每个(工具 × 目录)组合最近的那条上,否则
  // 用户点第三条、接上的却是第一条。判断用的是整份最近记录(api.recent 一次取
  // 60 条),不是卡片上显示的那 3 条。
  const resumable = latestSessionIdsByWorkspace(recent?.items ?? [])
  // 装好又连上之后才给这张卡：还没配 Key 时第一条命令敲下去只会报错，那不是「可以试试」。
  // 一次只显示一个工具，关掉它下一个才轮上，免得首页被四张一样的卡片占满。
  const firstRunTool = installed.find((tool) => tool.status.installed && !jobs[tool.id] && tool.configured && !tool.error
    && !firstRunDismissed.includes(tool.id) && firstRunOf(tool.id) !== undefined)
  const firstRun = firstRunTool ? firstRunOf(firstRunTool.id) : undefined
  const renderTool = useCallback((tool: ToolPresentation) => {
    const installJob = jobs[tool.id]
    const launchJob = jobs[`launch:${tool.id}`]
    const switchJob = jobs[`switch:${tool.id}`]
    const job = launchJob ?? switchJob ?? installJob
    // 配置那一块没读到时，连接状态是未知而不是「还没配 Key」，
    // 否则用户会以为自己的配置丢了。工具本身的安装、卸载不受影响。
    const configUnavailable = !tool.error && tool.status.installed
      && props.failures?.some((failure) => failure.partition === 'config') === true
    // 开机先画出来的是上次的检测结果（cachedAt），装没装、配置归谁都可能已经变了，
    // 这时不下「被改过」「第三方配置」的结论，真结果回来再说。
    const ownershipPending = snapshot !== null && (Boolean(snapshot.system.cachedAt) || ownershipAwaitingAccount(snapshot.config, tool))
    const status = installJob ? 'installing' : tool.error ? 'detectionFailed' : !tool.status.installed ? 'missing'
      : configUnavailable ? 'configUnavailable'
      : tool.source === 'changed' && !ownershipPending ? 'configChanged'
      : tool.source === 'unknown' && !ownershipPending ? 'unknownSource' : tool.source === 'official' ? 'official'
        : bootstrapBusy && !tool.configured ? 'configuring'
        : tool.configured ? 'ready' : 'unconfigured'
    // 「打开」以前每次都要重新选一遍目录。会话记录里本来就存着用过的目录，
    // 拿它当主按钮的默认值，旁边的下拉再给最近几个和原来的选择器（N7）。
    // Codex 桌面端自己管工作区，不走这条路。
    const opensWorkspace = !configUnavailable && !tool.error && tool.status.installed
      && tool.configured && tool.id !== 'codexDesktop'
    const workspaces = opensWorkspace ? recentWorkspaces(recent?.items ?? [], tool.provider) : []
    // 正在跑的那一行按钮写的是「打开中」「安装中」，这时不给下拉，但外面那层还在，
    // 按钮列的宽度就不会跟着一起跳。
    const lastWorkspace = job ? null : workspaces[0] ?? null
    // macOS 上 Codex 桌面端归客户自己装，这颗按钮只能把人带到教程：写「安装」就是骗人。
    const manualInstall = !tool.status.installed && needsManualInstall(snapshot, tool.id)
    // Codex 桌面端在 Windows 上是 Appx，装它要提权；四个 CLI 走 npm，不提权。
    const elevationHint = tool.id === 'codexDesktop' && !tool.status.installed
      ? elevatedInstallShortNotice('codexDesktop', snapshot?.platform.platform, snapshot?.platform.codexDesktop.install)
      : null
    const primaryLabel = launchJob ? '打开中' : switchJob ? '切换中' : installJob ? '安装中' : configUnavailable ? '重新配置'
      : bootstrapBusy && !tool.configured ? '配置中' : tool.error ? '重新检测' : !tool.status.installed ? manualInstall ? '安装指南' : '安装'
      : tool.configured ? lastWorkspace ? `打开 ${workspaceButtonLabel(lastWorkspace.name)}` : '打开' : '连接账号'
    const primary = () => configUnavailable ? props.onConfigure(tool.id) : tool.error ? props.onScan() : !tool.status.installed ? props.onInstall(tool.id)
      : tool.configured ? props.onLaunch(tool.id, lastWorkspace?.path) : props.onConfigure(tool.id)
    const rollback = job ? null : rollbackVersion(tool)
    // 配置那一块没读到时来源是未知的，不给切换，免得在一份没读到的配置上做决定。
    // 账号还在恢复时来源同样没判定（见 ownershipAwaitingAccount），等恢复完再给。
    const switchTarget = configUnavailable || tool.error || ownershipPending ? null : accountSwitchTarget(tool)
    const blocked = tool.versionAdvice?.blockedReason ?? null
    // 原生/其他来源装的 CLI 不走本工具的 npm 通道，不给 npm 更新/回滚按钮，
    // 该更新时改用一句被动提示，避免在 npm 全局目录另装一份并存。
    const externalManaged = isExternallyManagedInstall(tool.status)
    const externalHint = externalManaged ? externalInstallHint(tool.status.installSource) : null
    // 推荐版本比已装的新时这是一次「更新」，图标和文案都不能写成回退。
    const rollbackVerb = recommendedVersionVerb(tool)
    const rollbackIcon = tool.versionAdvice?.recommendedIsNewer ? Download : RotateCcw
    const primaryButton = <Button size="sm" variant={tool.status.installed ? 'primary' : 'secondary'} loading={Boolean(job)}
      disabled={loading || launchBusy || bootstrapBusy && !tool.configured && !configUnavailable}
      title={lastWorkspace ? `在 ${lastWorkspace.path} 打开` : undefined}
      icon={lastWorkspace ? undefined : tool.status.installed && !bootstrapBusy ? ArrowUpRight : undefined}
      onClick={primary} testId={`tool-${tool.id}-primary`}>{primaryLabel}</Button>
    return <ToolRow key={tool.id} tool={tool.id} status={status}
      detail={job?.label ?? tool.error ?? (status === 'configChanged' ? configChangedDetail : elevationHint ?? undefined)}
      version={tool.status.installed ? versionSubtitle(tool) ?? '版本暂未识别' : undefined}
      model={tool.status.installed ? tool.source === 'official' ? '官方账号' : tool.model || undefined : undefined}
      progress={job?.percent}
      extraAction={installJob?.cancellable
        ? <Button variant="ghost" size="sm" icon={X} loading={installJob.cancelling} onClick={() => props.onCancelInstall(tool.id)} testId={`tool-${tool.id}-cancel`}>{installJob.cancelling ? '取消中' : '取消'}</Button>
        : status === 'configChanged' && props.onRewriteKey
          ? <Button variant="ghost" size="sm" icon={KeyRound} onClick={() => props.onRewriteKey?.(tool.id)} testId={`tool-${tool.id}-rewrite-key`}>重新写入 Key</Button>
        : externalManaged
          ? externalHint && (tool.updateAvailable || (rollback && blocked))
            ? <span className="v2-tool-external-note" title={externalHint} data-testid={`tool-${tool.id}-external-managed`}>{externalHint}</span>
            : undefined
          : rollback && blocked
            ? <Button variant="ghost" size="sm" icon={rollbackIcon} title={blocked} onClick={() => props.onInstall(tool.id, rollback)} testId={`tool-${tool.id}-rollback`}>{`${rollbackVerb}推荐版本`}</Button>
            : tool.updateAvailable && !job ? <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onInstall(tool.id)}>更新</Button> : undefined}
      primaryAction={workspaces.length ? <span className="v2-tool-launch" data-testid={`tool-${tool.id}-launch`}>
        {primaryButton}
        {lastWorkspace && <Menu label="换一个目录" testId={`tool-${tool.id}-workspaces`}
          anchor={<Button size="sm" variant="primary" icon={ChevronDown} disabled={loading || launchBusy} aria-label="换一个目录" />}
          items={workspaceChoices(workspaces).filter((choice) => !choice.create || props.onLaunchInNewFolder).map((choice) => ({
            label: choice.label,
            testId: choice.create ? `tool-${tool.id}-new-workspace` : choice.path === null ? `tool-${tool.id}-choose-workspace` : undefined,
            onSelect: () => choice.create ? props.onLaunchInNewFolder?.(tool.id) : props.onLaunch(tool.id, choice.path ?? undefined),
          }))} />}
      </span> : primaryButton}
      menu={tool.status.installed && !job ? [
        // 还没有最近目录时「打开」旁边没有下拉，新建入口放进这个菜单，新手照样找得到。
        ...(opensWorkspace && !lastWorkspace && props.onLaunchInNewFolder ? [{
          label: newWorkspaceLabel,
          testId: `tool-${tool.id}-new-workspace`,
          disabled: loading || launchBusy,
          onSelect: () => props.onLaunchInNewFolder?.(tool.id),
        }] : []),
        { label: '配置', onSelect: () => props.onConfigure(tool.id) },
        // 故意改过配置的人也要有出路，否则那颗黄角标会一直挂着。认下之后这个工具
        // 就按「自己填写的密钥」处理，下次在配置里改回星芒账号时标记自动清掉。
        ...(status === 'configChanged' && props.onKeepConfig ? [{ label: '就用现在这份', testId: `tool-${tool.id}-keep-config`, onSelect: () => props.onKeepConfig?.(tool.id) }] : []),
        ...(switchTarget && props.onSwitchAccount ? [{ label: accountSwitchLabels[switchTarget], testId: `tool-${tool.id}-switch-${switchTarget}`, onSelect: () => props.onSwitchAccount?.(tool.id, switchTarget) }] : []),
        // 界面上一直只把配置路径写成一行灰字，而 `.` 开头的目录在资源管理器和
        // 访达里默认都看不见，用户和客服只能手敲路径。
        ...(props.onOpenConfigDirectory ? [{
          ...configDirectoryMenuItem(tool, configUnavailable),
          testId: `tool-${tool.id}-open-config-directory`,
          onSelect: () => props.onOpenConfigDirectory?.(tool.id),
        }] : []),
        ...(rollback && !blocked ? [{ label: `${rollbackVerb}推荐版本 ${rollback}`, testId: `tool-${tool.id}-rollback-menu`, onSelect: () => props.onInstall(tool.id, rollback) }] : []),
        ...(tool.provider === 'codex' ? [{ label: '换用别家模型', testId: tool.id === 'codex' ? 'home-codex-models' : 'home-codexDesktop-models', onSelect: props.onCodexModels }] : []),
        { label: '查看记录', onSelect: () => props.onNavigate('sessions') },
        ...(tool.provider === 'codex' && tool.source === 'official' ? [{ label: '官方账户额度', onSelect: () => { setOfficial(snapshot?.system.officialChatGpt ?? null); setOfficialOpen(true) } }] : []),
        ...(canUninstallTool(
          tool.status,
          tool.id === 'codexDesktop' && snapshot?.platform.codexDesktop.uninstall === true,
        )
          ? [{ label: '卸载', danger: true, onSelect: () => props.onUninstall(tool.id) }]
          : []),
      ] : undefined} testId={`tool-row-${tool.id}`} />
  }, [bootstrapBusy, jobs, launchBusy, loading, props, recent])
  const renderExternal = (tool: ReturnType<typeof presentExternalClients>[number]) => {
    const installJob = jobs[tool.id], launchJob = jobs[`launch:${tool.id}`], job = launchJob ?? installJob
    const status = installJob ? 'installing' : tool.status.detectionError ? 'detectionFailed' : !tool.status.installed ? 'missing'
      : tool.configurationStatus
    // macOS 上这三个官方都只给自己下载的安装包（installSupported 为假）。原来按钮写
    // 「暂不支持」且点不动，客户看到的是死路一条；现在带他去教程里那一章（第七批 3）。
    // Windows arm64 上 WorkBuddy 同样装不了，但那是没有对应架构的包，教程救不了，
    // 仍旧保持「暂不支持」。
    const manualInstall = tool.action === 'install' && tool.disabled && snapshot?.platform.isMac === true
    const primaryLabel = launchJob ? '打开中' : installJob ? '安装中' : tool.action === 'scan' ? '重新检测' : tool.action === 'install' ? manualInstall ? '安装指南' : tool.disabled ? '暂不支持' : '安装' : tool.action === 'launch' ? '打开' : '配置'
    const primary = () => manualInstall ? props.onNavigate('tutorial', macDesktopTutorialTopic) : tool.action === 'scan' ? props.onScan() : tool.action === 'install' ? props.onInstallExternal(tool.id) : tool.action === 'launch' ? props.onLaunchExternal(tool.id) : props.onConfigureExternal(tool.id)
    return <ToolRow key={tool.id} tool={tool.id} status={status} detail={job?.label ?? tool.detail} progress={installJob?.percent}
      primaryAction={<Button size="sm" variant={tool.status.installed ? 'primary' : 'secondary'} loading={Boolean(job)} disabled={props.externalLoading || launchBusy || (tool.disabled && !manualInstall)} title={tool.disabled && !manualInstall ? tool.status.installHint ?? '当前平台暂不支持此操作' : undefined}
        icon={tool.action === 'launch' ? ArrowUpRight : undefined} onClick={primary} testId={tool.action === 'configure' ? `home-client-${tool.id}` : `tool-${tool.id}-primary`}>{primaryLabel}</Button>}
      menu={tool.status.installed && !job ? [
        // 配置入口只留「…」菜单这一处：行左边不再放独立的「配置」按钮，否则同一行会出现两个配置入口，
        // 而四个 CLI 行从来只有菜单入口，用户看到的是同类工具行给法不一致。主按钮已经是这个动作时菜单里不再重复。
        ...(tool.action === 'configure' ? [] : [{ label: '配置', testId: `home-client-${tool.id}`, onSelect: () => props.onConfigureExternal(tool.id) }]),
        ...(tool.action === 'launch' ? [] : [{ label: '打开', disabled: !tool.status.launchSupported || launchBusy, onSelect: () => props.onLaunchExternal(tool.id) }]),
      ] : undefined} testId={`tool-row-${tool.id}`} />
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
    {props.bootstrap?.result && (props.bootstrap.result.configured.length || props.bootstrap.result.failed.length || props.bootstrap.result.warnings.length) > 0 && <div className={`v2-bootstrap-notice ${props.bootstrap.result.failed.length || props.bootstrap.result.warnings.length ? 'is-warn' : ''}`} role="status">
      <span className={`v2-dot ${props.bootstrap.result.failed.length || props.bootstrap.result.warnings.length ? 'is-warn' : 'is-ok'}`} /><span>{props.bootstrap.result.networkBlocked ? offlineBootstrapNotice : `${props.bootstrap.result.configured.length ? `已完成 ${props.bootstrap.result.configured.length} 组工具的 Key 配置。` : '账号 Key 已同步。'}${props.bootstrap.result.failed.length ? ` ${props.bootstrap.result.failed.map((entry) => keySyncFailureText(entry.provider, entry.message)).join('；')}` : ''}${props.bootstrap.result.warnings.length ? ` ${props.bootstrap.result.warnings.join('；')}` : ''}`}</span>
      {(props.bootstrap.result.failed.length > 0 || props.bootstrap.result.warnings.length > 0) && props.onBootstrapRetry && <Button size="xs" onClick={props.onBootstrapRetry}>重新同步</Button>}
    </div>}
    {error && <div role="alert" className="v2-callout is-bad"><span>{error}</span><Button size="xs" onClick={props.onScan}>重新检测</Button></div>}
    {props.externalError && <div role="alert" className="v2-callout is-bad"><span>客户端状态暂未读到：{props.externalError}</span><Button size="xs" onClick={props.onScan}>重新检测</Button></div>}
    {snapshot && configFailure && <div role="alert" className="v2-callout is-bad" data-testid="home-config-failure"><span>工具配置暂未读到：{configFailure.message}工具列表、安装和卸载照常可用；点工具行的“重新配置”可以重新写入。</span><Button size="xs" onClick={props.onScan}>重新检测</Button></div>}
    {props.supportsBilling !== false && dollars !== null && dollars < 5 && <div role="status" className="v2-callout is-bad"><Zap size={18} /><span>余额只剩 ${dollars.toFixed(2)}，充值后可继续使用。</span><Button size="sm" variant="balance" onClick={() => props.onNavigate('account', 'recharge')}>马上充值</Button></div>}
    {loading && snapshot?.system.cachedAt && <div className="v2-loading-inline" role="status" data-testid="home-cached-scan">正在检查本机工具，先显示上次的结果。</div>}
    <div className="v2-home-grid">
      <div className="v2-home-main">
        {!ready && !loading && !configFailure && <Card title="开始使用" meta="第 1 步，共 4 步" padding="none" testId="home-setup">
          <div className="v2-setup-focus"><span className="v2-step-number">1</span><div><h3>选择一种开始方式</h3><p>选一个工具先开始，之后随时可以再装别的。</p></div><Button variant="primary" onClick={props.onGuide}>开始准备</Button></div>
          <ol className="v2-setup-steps">{['选开始方式', '准备工具', '确认连接', '开始使用'].map((label, i) => <li key={label}><span>{i + 1}</span>{label}</li>)}</ol>
        </Card>}
        {loading && !snapshot ? <Card title="你的工具"><Progress value={0} label="正在检测本机工具" /></Card> : <>
          {installedCount > 0 && <Card title="你的工具" meta={`${installedCount} 个已装${installed.some((tool) => tool.updateAvailable) ? ` · ${installed.filter((tool) => tool.updateAvailable).length} 个有更新` : ''}`} padding="none">{installed.map(renderTool)}{installedExternal.map(renderExternal)}</Card>}
          {availableCount > 0 && <Card title="还可以装" meta={`${availableCount} 个`} collapsible padding="none">{available.map(renderTool)}{availableExternal.map(renderExternal)}</Card>}
          {props.externalLoading && !external.length && <div className="v2-loading-inline" role="status">正在检测 WorkBuddy、Claude Desktop 和 OpenCode</div>}
        </>}
        {firstRunTool && firstRun && <Card title="试试第一条命令" meta={firstRunTool.name} testId="home-first-run"
          actions={<Button variant="ghost" size="xs" icon={X} aria-label="不再显示这条提示" title="不再显示这条提示" testId="home-first-run-dismiss"
            onClick={() => setFirstRunDismissed((current) => dismissFirstRun(getFirstRunStorage(), current, firstRunTool.id))} />}>
          <FirstRunSteps key={firstRunTool.id} name={firstRunTool.name} firstRun={firstRun} testId="home-first-run-steps"
            gitHint={firstRunTool.id === 'claude' && gitMissing ? gitMissingFirstRunHint(gitHost) : undefined} />
        </Card>}
        <Card title="最近" meta="从上次停下的地方继续" padding="none" testId="home-recent-card" actions={<Button variant="ghost" size="xs" onClick={() => props.onNavigate('sessions')}>全部记录</Button>}>
          {recentError ? <Empty icon={History} title="记录暂时没有读到" description={recentError} action={<Button onClick={() => setRecentAttempt((value) => value + 1)}>重新加载</Button>} />
            : !recent ? <div className="v2-loading-inline" role="status">正在读取最近记录</div>
              : recent.items.length ? recent.items.slice(0, 3).map((session) => <ListRow key={session.id} icon={History}
                title={session.title} desc={session.cwd ?? undefined} meta={session.updatedAt === null ? '时间未记录' : new Date(session.updatedAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                badge={session.cwdExists === false ? <Pill tone="warn" testId={`home-recent-missing-${session.id}`}>文件夹已不存在</Pill> : undefined}
                actions={<>
                  {resumable.has(session.id) && !session.archived && <Button size="xs" disabled={loading || launchBusy || session.cwdExists === false}
                    onClick={() => props.onLaunch(session.provider, session.cwd, 'resumeLast')}
                    title={session.cwdExists === false ? '这个文件夹已经不在了，接不上上次的对话' : `接着 ${session.cwd} 里最近的一条对话`} testId={`home-recent-resume-${session.id}`}>接着聊</Button>}
                  {Boolean(session.cwd) && <Button size="xs" variant="ghost" icon={FolderOpen} disabled={session.cwdExists === false}
                    aria-label="打开文件夹" title={session.cwdExists === false ? '这个文件夹已经不在了，打不开' : `在文件管理器里打开 ${session.cwd}`}
                    onClick={() => void openRecentDirectory(session.id)} testId={`home-recent-open-directory-${session.id}`} />}
                  <Button size="xs" variant="ghost" onClick={() => props.onNavigate('sessions')}>查看</Button>
                </>} />)
                : <Empty icon={History} title="还没有对话记录" description="打开工具聊过之后，这里会出现最近的会话。" />}
        </Card>
      </div>
      <aside className="v2-home-aside">
        <Card title="运行环境" padding="none" meta={snapshot ? new Date(snapshot.system.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '等待检查'}>
          <div className="v2-runtime-list">{(['node', 'npm', 'python', 'git'] as const).map((id) => {
            const status = snapshot?.system.runtime[id]
            const optional = id === 'python' || id === 'git'
            return <div key={id} className="v2-runtime-row"><i className={`v2-dot ${status?.installed ? 'is-ok' : optional ? '' : 'is-warn'}`} /><BrandIcon tool={id} size={16} variant="xs" /><strong>{id === 'node' ? 'Node.js' : id === 'python' ? 'Python' : id === 'git' ? 'Git' : 'npm'}</strong>
              <span>{jobs[id]?.label ?? (loading ? '检测中' : status?.detectionFailed ? '检测失败' : status?.version ?? (optional ? '可选 · 未装' : '未安装'))}</span>
            </div>
          })}</div>
          {gitMissing && <p className="v2-runtime-hint" data-testid="home-runtime-git-hint">{gitMissingNotice(gitHost)}</p>}
          {nodeElevationNotice && <p className="v2-runtime-hint" data-testid="home-runtime-node-elevation">{nodeElevationNotice}</p>}
          {nodeGuide && <RuntimeInstallHint runtime="node" guide={nodeGuide} />}
          {pythonGuide && <RuntimeInstallHint runtime="python" guide={pythonGuide} />}
          <div className="v2-runtime-actions">{!snapshot?.system.runtime.node.installed && <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onRuntime('node')} testId="home-runtime-node">{runtimeButtonLabel('node', snapshot?.platform.nodeRuntimeInstall)}</Button>}
            {!snapshot?.system.runtime.python.installed && <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onRuntime('python')} testId="home-runtime-python">{runtimeButtonLabel('python', snapshot?.platform.pythonRuntimeInstall)}</Button>}
            {(nodeGuide || pythonGuide) && <Button variant="ghost" size="sm" icon={BookOpen} onClick={() => props.onNavigate('tutorial', macRuntimeTutorialTopic)} testId="home-runtime-tutorial">看教程</Button>}
            {gitMissing && gitHost === 'windows' && <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onRuntime('git')} testId="home-runtime-git">下载 Git</Button>}</div>
        </Card>
        <Card title="账户余额" padding="none" actions={<Pill tone={connectedCount ? 'ok' : 'neutral'}>{connectedCount ? `${connectedCount} 个工具已连接` : '等待连接'}</Pill>}>
          <div className={`v2-balance-body tone-${tier}`}><div title={balanceHint}><strong data-testid="home-balance">{dollars === null ? '暂未读到' : `$${dollars.toFixed(2)}`}</strong><small>可用余额 · 美元</small>{balanceStore && account && <Button variant="ghost" size="xs" icon={RefreshCw} loading={balanceState.loading} aria-label="刷新账户余额" title={balanceHint} onClick={() => void balanceStore.refresh('manual')} testId="home-balance-refresh" />}</div>
            {balanceState.error && <p className="v2-balance-error" role="status" title={balanceState.error}>更新失败，{balance ? '显示上次余额' : '请重试'}</p>}
            <div className="v2-balance-usage">{monthUsed !== null && dollars !== null && <Progress tone={tier === 'neutral' ? 'neutral' : tier} value={monthUsed + dollars > 0 ? monthUsed / (monthUsed + dollars) * 100 : 0} label={`本月已用 $${monthUsed.toFixed(2)}`} />}
              <p>{props.supportsUsage === false ? '请在官方网站查看消费记录。' : usageError || (remainingDays !== null ? `按最近 7 天用量约还能用 ${remainingDays} 天${remainingDays < 7 ? '，建议提前充值' : ''}。` : usage ? '最近 7 天暂无用量' : account ? '正在读取用量' : '登录后查看用量')}</p></div>
            <div className="v2-balance-actions">{props.supportsBilling !== false && <Button variant="balance" size="sm" icon={Zap} onClick={() => props.onNavigate('account', 'recharge')}>充值</Button>}{props.supportsUsage !== false && <Button variant="ghost" size="sm" onClick={() => props.onNavigate('account', 'dashboard')}>用量看板</Button>}</div>
          </div>
        </Card>
        <Card title="可以试试" padding="none" testId="home-suggestions"><ListRow icon={Plug} title="给 AI 连上浏览器和数据库" actions={<Button variant="ghost" size="xs" icon={ArrowRight} aria-label="查看外接工具" title="查看外接工具" onClick={() => props.onNavigate('mcp')} />} />
          <ListRow icon={MessageSquare} title="不开终端，直接在这里聊" actions={<Button variant="ghost" size="xs" icon={ArrowRight} aria-label="打开聊天" title="打开聊天" onClick={() => props.onNavigate('chat')} />} />
          <ListRow icon={BookOpen} title="第一次用 Codex？跟着 4 步开始" actions={<Button variant="ghost" size="xs" icon={ArrowRight} aria-label="查看教程" title="查看教程" onClick={() => props.onNavigate('tutorial')} />} /></Card>
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
