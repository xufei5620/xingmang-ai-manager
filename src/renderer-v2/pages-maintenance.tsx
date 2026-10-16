import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Globe2,
  HeartPulse,
  Info,
  KeyRound,
  PlugZap,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Terminal,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import {
  Button,
  Card,
  Chips,
  Confirm,
  Dialog,
  Input,
  ListRow,
  Notice,
  PageHead,
  Pill,
  SearchInput,
  Segment,
  SettingRow,
  Switch,
  Tabs,
  Textarea,
  useToast,
} from './ui'
import {
  displayDate,
  RelativeTime,
  errorMessage,
  ListState,
  ResultNotice,
  type OperationNotice,
  useOperation,
  useReloadWhenShown,
  useResource,
} from './business-common'
import {
  autoUpdateSettingDescription,
  cliTutorialTopic,
  desktopInstallTutorialTopic,
  macDesktopTutorialTopic,
  macRuntimeTutorialTopic,
  buildSettingsBlocks,
  notificationOptions,
  notificationSettingsItemId,
  searchSettingsItems,
  settingsGroupIcons,
  settingsGroups,
  settingsItemLabel,
  settingsItems,
  type SettingsGroupId,
  type SettingsItem,
  type SettingsSectionId,
  feedbackTabs,
  type FeedbackTabValue,
} from './registry/business'
import { shortcutTools, tools } from './registry/tools'
import { isActiveProviderId, type ActiveProviderId } from '../../electron/catalog'
import { clientConnections } from './registry/clients'
import { spacedName } from './features/tools/model'
import { homeNodeElevationNotice } from './features/tools/elevation-notice'
import { runtimeInstallButtonShown } from './features/tools/runtime-install-guide'
import { gitHostPlatform } from '../../electron/git-runtime'
import { redactSecretPatterns } from '../../electron/redaction-patterns'
import type { ToolJob } from './features/tools/useToolbox'
import { connectionCheckView } from './features/tools/connection-check'
import { accountScope, sessionRestoring, signedInSiteId } from './account-context'
import { AppUninstallRow } from './features/app/AppUninstall'
import { BackupCard } from './features/settings/BackupCard'
import { VersionCard } from './features/settings/VersionCard'
import { RelayRouteRestartNotice, RelayRouteRow } from './features/app/RelayRouteSettings'
import { ThemeCards, type ThemeCardValue } from './features/app/ThemeCards'
import { connectionRouteOptions, connectionRouteSettings } from './registry/connection-routes'
import { createSettingsQueue } from './features/app/settings-queue'
export { createSettingsQueue } from './features/app/settings-queue'
import { diagnosticDetailRows } from './features/app/diagnostic-details'
import { diagnosticStateLabel, groupDiagnostics, type DiagnosticGroup } from './features/app/diagnostic-group'
import { SupportIdentity } from './features/app/SupportIdentity'
import { canClearStaleProxy, staleProxyClearMessage, staleProxyConfirmBody } from './features/app/stale-proxy'
import { certificateDiagnosticCode } from './features/app/certificate-trust'
import { diagnosticFolderTarget, diagnosticFolderUnavailableMessage } from './features/app/diagnostic-folder'
import { takeSettingsGroup } from './features/app/settings-group-intent'
import { firstProblemAnchor, useRowFocus } from './features/app/row-focus'
import { diagnosticsRevision, publishDiagnosticsCounts, useDiagnosticsRevision } from './features/app/environment-status'
import { currentWindowOs, type WindowOs } from './features/app/window-os'
import { diagnosticFixConfirm, diagnosticFixKind, diagnosticFixLabel, diagnosticFixLabels, diagnosticFixMessage } from './features/app/diagnostic-fix'
import { parseImportedConversations } from './features/chat/storage'
import type { ChatTransfer } from './features/chat/transfer'
import type { Conversation } from './features/chat/state'
import { dataTransferExportMessage, dataTransferImportMessage, settingsPatchFrom } from './features/app/data-transfer'
import { canReplaceNode, nodeReplaceOffered } from './features/tools/node-replace'
import {
  anyRuntimeLogValue,
  filterRuntimeLogs,
  formatRuntimeLogEntry,
  hasRuntimeLogFilter,
  installRuntimeLogArea,
  isCurrentBootEntry,
  runtimeLogArea,
  runtimeLogAreaLabel,
  runtimeLogDisplayMessage,
  runtimeLogSourceOptions,
  runtimeLogTimeText,
  runtimeLogWriteNotice,
} from './features/app/runtime-log-filter'
import { releaseNotesSection } from './features/app/release-notes'
import type { V2Bridge, V2Page } from './types'
import type {
  AccountSessionState,
  AppSettingsV2Update,
  DataTransferImportPreview,
  DiagnosticFixKind,
  FeedbackReportCopyResult,
  FeedbackReportExportResult,
  InstallCancelResult,
  PlatformCapabilities,
  RuntimeLogSnapshot,
} from '../../electron/ipc-contract'
import type { PlatformSystemState } from '../../electron/platform/contract'
import { platformApi } from './platform-api'
import type { LoginTarget } from './features/auth/api'

type AppSettings = Awaited<ReturnType<V2Bridge['getSettings']>>
type SettingsUpdate = Parameters<V2Bridge['saveSettings']>[0]
type Update = Awaited<ReturnType<V2Bridge['getUpdateState']>>
type Diagnostic = Awaited<
  ReturnType<V2Bridge['runDiagnostics']>
>['items'][number]
// 已下线的 CLI（Gemini，yoyo 2026-10-14）不在这里：本页不再替它安装、检查或写 Key。
type Provider = ActiveProviderId
type ConnectionCheck = Awaited<ReturnType<V2Bridge['checkProviderConnection']>>
interface ConnectionRow {
  /** React key 与 testId 后缀：CLI 是 provider，外部客户端是它自己的 id。 */
  id: string
  name: string
  /**
   * 只有 CLI 能就地「重新写入 Key」。外部客户端的密钥是用户在配置对话框里自己
   * 选的，本软件不替他重签，所以这一列对客户端是 null（见 docs/EXTERNAL-CLIENT-CONFIG.md）。
   */
  provider: Provider | null
  result: ConnectionCheck | ExternalClientCheck | null
  error: string | null
}
type ExternalClientCheck = Awaited<ReturnType<V2Bridge['checkExternalClientConnection']>>
// 展示顺序只有一套，以 registry/tools.ts 的数组次序为准（R-S11）。Codex 桌面端
// 没有自己的配置文件，自检无从下手，所以这里只取 CLI；三个外部客户端各有自己的
// 配置文件，跟在 CLI 后面（registry/clients.ts 的次序）。
const connectionTools = tools.filter((tool): tool is typeof tool & { id: Provider } => tool.kind === 'cli')
/**
 * installed：装好了；restart：运行环境要重启电脑才算装完；skipped：没有开始（取消、已在装或要自己下载）；
 * declined：客户在「换成星芒装的」确认框里点了取消，什么都没动，也不用说什么。
 */
export type ToolInstallOutcome = 'installed' | 'restart' | 'skipped' | 'declined'
/** 「找客服」卡上的几样：二维码按当前账号换，身份行和最近一次出错由 App 算好（同帮助与客服弹窗）。 */
export interface FeedbackSupport {
  qr?: string
  /** 二维码没生成出来时那一句；缺省 = 没出错。 */
  qrFallback?: string | null
  identity: string
  lastFailure?: string
  open: () => void
  copyIdentity: () => void
}
/** sequence 每次加一：已经在那个页签上、再点一次「查看日志」也照样清掉筛选、选好来源。 */
export interface FeedbackRequest {
  sequence: number
  tab: FeedbackTabValue
  /** 装工具没装上时的「查看日志」：来源先选好「安装与更新」。 */
  installLog?: true
}
export type BusinessActions = {
  /** 第二个参数是要落的分页、分组或那一页里的某一行；缺省 = 只跳页。 */
  navigate?: (page: V2Page, section?: string) => void
  openLogin?: (target?: LoginTarget) => void
  /** 个人中心「当前登录」里的「切换账号」：弹出切换账号框；缺省 = 按钮点不了。 */
  switchAccount?: () => void
  openHelp?: () => void
  onAccountChanged?: () => void
  onSettingsChanged?: (settings: AppSettings) => void
  openConfig?: (provider: Provider) => void
  /** 设置页的「新手引导」：真的重开四步引导，而不是跳去静态教程页（A8）。 */
  openGuide?: () => void
  /** 设置页的「重看界面导览」：回到首页重播首页上那几条操作提示（A8）。 */
  replayTour?: () => void
  /**
   * 页面里装好了运行环境（精选、外接工具页的「自动安装 Python」）以后叫一声，由 App 重新检测，首页跟着变；
   * 不叫的话首页还写 Python「未安装」。装工具不用它：走 installTool，装完还要写 Key。页面先叫它、再读本页：
   * 本页那次读接上 App 刚起的那一轮检测，不另起一轮。
   * 缺省 = 只刷新本页（旧行为）。
   */
  onSystemChanged?: () => void
  /**
   * 首页那条完整的安装：缺 Node.js / Python 先装运行环境，装完写 Key、刷新检测。
   * 以前「安装卸载」页自己直接调主进程装工具，没装 Node.js 的人只看到「未检测到
   * npm」（全面检测 Q33）；有了它就只走这一条。
   */
  installTool?: (tool: Provider | 'codexDesktop') => Promise<ToolInstallOutcome>
  /** 与 installTool 配对的取消：首页那条安装在准备运行环境时会说明为什么不能取消。 */
  cancelToolInstall?: (tool: Provider | 'codexDesktop') => Promise<InstallCancelResult>
  /**
   * 首页那份正在跑的任务（按工具编号）。扩展页拿它画「安装中」，检查页拿它让运行环境那几行的按钮转圈；
   * 在首页点的安装这几页也看得到。缺省 = 只看这一页自己发起的那次。
   */
  toolJobs?: Readonly<Record<string, ToolJob>>
  /**
   * 连接自检的密钥 / 分组层给出的「重新写入 Key」：复用装完工具后那条同样的重写
   * 流程（App 的 syncAfterToolInstalled），失败时把主进程的原话抛出来，页面照实显示。
   */
  onRewriteKey?: (provider: Provider) => Promise<boolean>
  /** 哪几个工具的配置确实来自当前账号——只有它们重写得动（见 rewritableKeyProviders）。 */
  rewritableKeys?: readonly Provider[]
  /**
   * 检查页 Node.js、Python、Git 那几行的「安装」（第 10 批从「安装卸载」页挪过来）：走首页运行环境卡那一条，
   * 装完要重启电脑时弹重启框、检测跟着重跑。缺省 = 那几行不给「安装」，「安装指南」照旧。
   */
  onInstallRuntime?: (runtime: 'node' | 'python' | 'git') => void
  /** 检查页「换成新版」「换成新版 Node.js」：先弹确认框再换（同错误框里那一颗）。缺省 = 不给这颗按钮。 */
  onReplaceNode?: () => void
  /** 反馈与客服页右边那张「找客服」卡，跟帮助与客服弹窗是同一份。缺省 = 没有这张卡。 */
  support?: FeedbackSupport
  /** 外面点名要落的反馈与客服页签（「查看日志」「运行日志」）。缺省 = 留言反馈。 */
  feedbackRequest?: FeedbackRequest
  /** 「先试试这些」里给不给「看我的订单」：历史账号没有订单。缺省 = 给。 */
  ordersVisible?: boolean
  /**
   * App 手里最新的界面缩放（'auto' 表示自动）。在设置页开着时按 Ctrl 加号，设置页那一栏
   * 要跟着变；缺省 = 不同步，只用设置页自己读到的那份（旧行为）。
   */
  uiScale?: NonNullable<AppSettingsV2Update['uiScale']>
  /** 设置页「搬到新电脑」里聊天记录那一半；没登录时没有（聊天记录按账号分开存）。 */
  chatTransfer?: ChatTransfer
  /**
   * App 手里最新的设置。「启动时检查新版本」「自动更新」在设置页、版本更新卡（更新气泡里也有
   * 「自动更新」）各有一个开关，哪边改了另一边要跟着变；缺省 = 只用页面自己读到的那份（旧行为）。
   */
  appSettings?: AppSettings
  /** 有新版本（发现了、在下或下好了）：设置左栏「版本更新」后面带个点。缺省 = 不带。 */
  updateAvailable?: boolean
  /** 游戏加速开着：设置左栏「网络加速」后面带个绿点。缺省 = 不带。 */
  accelerating?: boolean
  /**
   * 设置 › 网络加速最上面那张游戏加速卡，由 App 画：连接挂在 App 上（托盘、到期提醒、Codex 桌面端
   * 自动连接都连着它）。参数是这张卡此刻在不在眼前，不在时剩余时长不跟着每秒走。缺省 = 没有这张卡。
   */
  accelerationCard?: (shown: boolean) => ReactNode
  /** 设置现在摆着哪一组（搜索时 null）：App 据此判断人是不是就在「版本更新」，不再弹同一件事的更新气泡。 */
  onSettingsGroupChange?: (group: SettingsGroupId | null) => void
  /**
   * 外壳告诉页面「现在显示的是你」。去过的页面换走时只藏起来、不卸载（App.tsx 的 visitedPages），
   * 再显示时页面自己重读一次（useReloadWhenShown），和点页头那颗按钮一样；缺省 = 不重读（旧行为）。
   */
  active?: boolean
}
/** 检查结果里「星芒 AI 网络」那一项的代号；设置里「网络检查」的「去检查页」直接翻到这一项。 */
const networkDiagnosticCode = 'XINGMANG_NETWORK'
/** 主进程说的「代理路由」是技术词，界面上换成「连接路径」「通过转发连接」，不出现「代理」。 */
function proxySummaryText(summary: string): string {
  return summary.replaceAll('使用代理路由', '通过转发连接').replaceAll('代理路由', '连接路径')
}
// 已下线的工具（Gemini）不在这几页出现：检查结果、连接自检、任务里带着它也不认。
function isProvider(id: string): id is ActiveProviderId {
  return isActiveProviderId(id)
}

/**
 * 快捷键弹窗里的键（v4 字表批09）：按这台电脑只写一种，Mac 写 ⌘，别的写 Ctrl。打开工具那一行
 * 按这台电脑上看得到的个数写（和 App 里快捷键本身读同一张表，registry/tools.ts 的 shortcutTools）。
 */
export function launchShortcutMeta(os: WindowOs): string {
  return `${os === 'mac' ? '⌘' : 'Ctrl'} 1–${shortcutTools(os).length}`
}
export function shortcutRows(os: WindowOs): Array<{ keys: string; label: string }> {
  const mod = os === 'mac' ? '⌘' : 'Ctrl'
  return [
    { keys: `${mod} K`, label: '搜索或跳转' },
    { keys: `${mod} ,`, label: '打开设置' },
    { keys: launchShortcutMeta(os), label: '打开工具' },
    { keys: `${mod} + / ${mod} -`, label: '放大 / 缩小界面' },
    { keys: `${mod} 0`, label: '恢复自动缩放' },
    { keys: 'Esc', label: '关闭弹窗或菜单' },
  ]
}

/**
 * 「星芒 AI 网络」连不上的几种原因里，换一条线路有可能救回来的：解析不出地址、连接被切断、
 * 一直等不到回话，当地网络切断某一条线路时就是这几种样子。没网、代理软件、证书、上网认证、
 * 服务维护，换线路救不了。
 */
const reroutableNetworkReasons: readonly string[] = ['dns', 'refused', 'timeout']

/**
 * 「星芒 AI 网络」的「去处理」翻到「设置 → 网络」里哪一行线路（第四十三批 B）。三样都对上才给：
 * 查的就是登着的这个账号的站（访客不给；开机恢复历史账号时查的是默认那个站，也不给）、
 * 原因换线路有可能救回来、这个站能选线路（选项不止一个）。
 */
function networkRouteSetting(details: Diagnostic['details'], accountSiteId: string | null): string | null {
  const reason = details?.reason
  if (!accountSiteId || details?.siteId !== accountSiteId) return null
  if (typeof reason !== 'string' || !reroutableNetworkReasons.includes(reason)) return null
  if (connectionRouteOptions(accountSiteId).length < 2) return null
  return connectionRouteSettings.find((route) => route.siteId === accountSiteId)?.id ?? null
}

/**
 * 「去处理」要落在真能处理这件事的地方。落不到的（磁盘满、系统版本、运行权限、
 * 系统里的代理和环境变量、项目文件夹里的设置……）就不给按钮：结论里已经说了怎么办，
 * 以前统一兜底到「安装卸载」，用户点过去什么也找不到。
 * accountSiteId 是登着的那个账号所在的站（signedInSiteId），只有「星芒 AI 网络」用得上；缺省 = 访客。
 */
export function diagnosticTarget(code: string, details?: Diagnostic['details'], accountSiteId: string | null = null): V2Page | null {
  // 「安全证书」只有「Node.js 太旧」这一种能在软件里处理，检查页那一行直接给「换成新版 Node.js」，
  // 不再跳走（第 10 批拆掉了「安装卸载」页）。收到的证书谁都不认、以管理员身份打开这两种，结论里已经说了怎么办。
  if (code === 'CERTIFICATE_TRUST') return null
  // 文件夹被搬过没有能在软件里一键修的地方，下一步是导出报告找客服。
  if (code === 'FOLDER_RELOCATED') return 'feedback'
  // 加速文件坏了：设置里的游戏加速卡上有「重新检查」和「联系客服」。
  if (code === 'ACCELERATION_BUNDLE') return 'acceleration'
  // 网络和代理软件这两项以前跳「设置 → 网络」，那一组里没有能处理它们的东西，
  // 「去检查」又跳回这一页，等于绕一圈（新手引导梳理 9-25 第 2 条），就拿掉了。
  // #872 以后那一组最上面就是「星芒账号线路」：换一条线路有可能救回来的那几种连不上，
  // 「去处理」直接翻到那一行。别的情况和代理软件那一项，结论里已经写了该怎么做。
  if (code === 'XINGMANG_NETWORK') return networkRouteSetting(details, accountSiteId) ? 'settings' : null
  if (code === 'CLASH_VERGE_TUN') return null
  // 电脑里的代理设置在设置页没有能处理它的东西；能清的那种在行里直接给「清掉这条旧设置」。
  if (code === 'PROXY_ENVIRONMENT') return null
  // 能删的（Windows 上当前账号那一份）在行里直接给「删掉这几项设置」。
  if (code === 'PROVIDER_ENVIRONMENT_OVERRIDE') return null
  // Codex 的额外设置在行里直接给「挪开这份设置」；Claude 跑命令前问不问是用户自己的
  // 选择，结论里说清楚就够了。两项以前都跳首页，首页上没有能处理它们的地方。
  if (code === 'CODEX_DOTENV' || code === 'CLAUDE_BYPASS_PERMISSIONS') return null
  // Node.js、Python、Git 那几行在检查页里直接给「安装」「换成新版」「安装指南」（第 10 批，按问 2）。
  if (code === 'RUNTIME_NODE' || code === 'RUNTIME_PYTHON' || code === 'RUNTIME_GIT') return null
  // 命令行工具、Codex 桌面端和它们的连接设置在首页工具卡片上装、修（卡片「…」里有「重新安装」）；
  // npm 跟着 Node.js 一起装，首页的运行环境卡管它。
  if (code.startsWith('PROVIDER_') || code.startsWith('RUNTIME_') || code.startsWith('CLI_') || code === 'CODEX_DESKTOP')
    return 'home'
  return null
}

export function diagnosticHasFix(code: string, details?: Diagnostic['details'], accountSiteId: string | null = null): boolean {
  return diagnosticTarget(code, details, accountSiteId) !== null
}

/** 「去处理」落到那一页里的哪一行（「反馈与客服」是哪个页签）；缺省 = 只跳页。 */
export function diagnosticSection(code: string, details?: Diagnostic['details'], accountSiteId: string | null = null): string | undefined {
  if (code === 'FOLDER_RELOCATED') return 'form'
  return code === 'XINGMANG_NETWORK' ? networkRouteSetting(details, accountSiteId) ?? undefined : undefined
}

/** 检查结果按轻重排：待处理在前，然后需留意，正常的在最后；同一档里照原来的次序。 */
export function sortDiagnosticsBySeverity<T extends { state: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => diagnosticRank(left.state) - diagnosticRank(right.state))
}

function diagnosticRank(state: string) {
  return state === 'pass' ? 2 : state === 'warn' ? 1 : 0
}

/** 连接自检的结论：正常 / 有问题 / 没测成；未配置不是故障，照旧写「未配置」、灰色。行首图标按它画，读屏念这几个字。 */
export function connectionRowStatus(row: Pick<ConnectionRow, 'result'>): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  if (!row.result) return { label: '没测成', tone: 'bad' }
  const view = connectionCheckView(row.result)
  if (view.tone === 'ok') return { label: '正常', tone: 'ok' }
  if (view.tone === 'neutral') return { label: view.statusLabel, tone: 'neutral' }
  return { label: '有问题', tone: view.tone }
}

/** 连接自检一行一个工具，有问题的排前：有问题、没测成、未配置、正常；同一档里照注册表的次序。 */
export function sortConnectionRows<T extends Pick<ConnectionRow, 'result'>>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => connectionRank(left) - connectionRank(right))
}

function connectionRank(row: Pick<ConnectionRow, 'result'>) {
  const { label, tone } = connectionRowStatus(row)
  return label === '没测成' ? 1 : tone === 'ok' ? 3 : tone === 'neutral' ? 2 : 0
}

type StateTone = 'ok' | 'warn' | 'bad' | 'neutral'
const stateIcons: Record<StateTone, typeof Check> = { ok: Check, warn: TriangleAlert, bad: X, neutral: Info }

/** 行首那个状态图标（v4 第 10 批代替原来的小标）：读屏照旧念「正常」「需留意」「待处理」这几个字。 */
function StateIcon({ tone, label }: { tone: StateTone; label: string }) {
  const Icon = stateIcons[tone]
  return (
    <span className={`v2-health-state is-${tone}`} role="img" aria-label={label}>
      <Icon size={14} strokeWidth={2.4} aria-hidden="true" />
    </span>
  )
}

function diagnosticTone(item: Diagnostic, group: DiagnosticGroup): StateTone {
  if (group === 'optional') return 'neutral'
  return item.state === 'pass' ? 'ok' : item.state === 'warn' ? 'warn' : 'bad'
}

/**
 * 连接自检每个工具一行：行首图标、「{工具}：{结论}」，右边是能就地处理的那颗按钮；原来的第二句（怎么做、
 * 测了什么、服务的原话）点「详情」在这一行下面展开。未配置的工具是灰的、不是红的：一个只用 Claude Code 的
 * 用户不该在这一页上看到三条失败。
 */
function ConnectionRowItem({
  row,
  navigate,
  canRewriteKey,
  onRewriteKey,
  open,
  onToggle,
}: {
  row: ConnectionRow
  navigate?: (page: V2Page, section?: string) => void
  canRewriteKey?: boolean
  onRewriteKey?: (provider: Provider) => void
  open: boolean
  onToggle: (row: ConnectionRow) => void
}) {
  const status = connectionRowStatus(row)
  const icon = <StateIcon tone={status.tone} label={status.label} />
  if (!row.result) {
    return (
      <div className="v2-health-line is-bad" data-testid={`health-connection-error-${row.id}`}>
        {icon}
        <span className="v2-health-line-text">{row.name}：{row.error ?? '自检没能完成'}</span>
      </div>
    )
  }
  const view = connectionCheckView(row.result, { canRewriteKey: canRewriteKey === true && Boolean(onRewriteKey) })
  const target = view.target
  const section = view.section ?? undefined
  const rewritable = view.action === 'rewrite-key' ? row.provider : null
  const detailsId = `health-connection-details-panel-${row.id}`
  return (
    <div className={`v2-health-line is-${status.tone}`} data-testid={`health-connection-result-${row.id}`}>
      {icon}
      <div className="v2-health-line-main">
        <span className="v2-health-line-text">{row.name}：{view.title}</span>
        {open && (
          <div className="v2-health-more" id={detailsId} data-testid="health-connection-details">
            <p>{view.body}</p>
            {view.detail && (
              <details className="v2-connection-note">
                <summary>服务的原话（联系客服时可以附上）</summary>
                {view.detail}
              </details>
            )}
          </div>
        )}
      </div>
      <div className="v2-health-line-actions">
        {rewritable ? (
          <Button
            size="sm"
            icon={KeyRound}
            onClick={() => onRewriteKey?.(rewritable)}
            testId={`health-connection-rewrite-${row.id}`}
          >
            重新写入密钥
          </Button>
        ) : (
          target && (
            <Button
              size="sm"
              icon={Wrench}
              onClick={() => navigate?.(target, section)}
              testId={`health-connection-fix-${row.id}`}
            >
              去处理
            </Button>
          )
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          onClick={() => onToggle(row)}
          testId={`health-connection-details-${row.id}`}
        >
          {open ? '收起' : '详情'}
        </Button>
      </div>
    </div>
  )
}

/** 检查页运行环境那几行能点的那一颗（第 10 批从「安装卸载」页挪过来，同首页运行环境卡那一条安装）。 */
interface RuntimeAction {
  label: string
  testId: string
  /** 正在装的那一项：按钮转圈、点不动。 */
  job?: string
  run: () => void
}

type MachineState = { snapshot: Awaited<ReturnType<V2Bridge['scanSystem']>> | null; capability: PlatformCapabilities | null }

export function HealthPage({
  api,
  navigate,
  openConfig,
  onRewriteKey,
  rewritableKeys,
  onInstallRuntime,
  onReplaceNode,
  toolJobs,
  active,
  accountSession,
}: {
  api: V2Bridge
  /** 外壳手上的登录状态：「星芒 AI 网络」给不给「去处理」看它（networkRouteSetting）；缺省 = 按访客算，不给（旧行为）。 */
  accountSession?: AccountSessionState
} & BusinessActions) {
  // 每跑完一次就交给状态栏，处理完一项回到别的页，最左那项跟着变。开跑时记下环境改过几次：
  // 跑到一半首页那边装完、改完了，这一轮的数就不交给状态栏（已知6）。
  const checkedRevision = useRef(diagnosticsRevision())
  const load = useCallback(() => {
    const started = diagnosticsRevision()
    checkedRevision.current = started
    return api.runDiagnostics().then((report) => {
      publishDiagnosticsCounts(report.counts, started)
      return report
    })
  }, [api])
  const resource = useResource(load)
  const pageRef = useRef<HTMLElement>(null)
  const accountSiteId = accountSession ? signedInSiteId(accountSession) : null
  const diagnostics = sortDiagnosticsBySeverity(resource.data?.items ?? [])
  const groups = groupDiagnostics(diagnostics)
  // 「正常」那一组默认收着：能点的几项（比如 Node.js 的「换成新版」）照旧一行一行摆出来，其余并成一块只写名字。
  // 从别处点名要看的那一项正好收在里面，就先摆出来再翻过去。
  const [showPassing, setShowPassing] = useState(false)
  // 设置里「企业证书」「网络检查」点「去检查页」：检查结果出来以后翻到那一项、亮一下；
  // 开机提示「去看看」不知道是哪一项，翻到第一项问题。去过这一页再点名进来时正在重查，
  // 等新结果出来再翻，不在几个小时前那份上亮。
  useRowFocus('health', pageRef, Boolean(resource.data) && !resource.loading, (anchor) => {
    const code = anchor === firstProblemAnchor ? (groups.problem[0] ?? groups.optional[0])?.code ?? null : anchor
    if (code && groups.ok.some((item) => item.code === code && !rowActionable(item))) setShowPassing(true)
    return code
  })
  const operation = useOperation()
  // 「详情」就地展开（v4 第 10 批，代替原来的抽屉），一次只开一行。
  const [openCode, setOpenCode] = useState<string | null>(null)
  const [connectionDetailsId, setConnectionDetailsId] = useState<string | null>(null)
  const [proxyClearItem, setProxyClearItem] = useState<Diagnostic | null>(null)
  const [fixing, setFixing] = useState<DiagnosticFixKind | null>(null)
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [responsesConsent, setResponsesConsent] = useState(false)
  const [responsesBusy, setResponsesBusy] = useState(false)
  const [responsesResult, setResponsesResult] = useState<Awaited<ReturnType<V2Bridge['probeCodexResponses']>> | null>(null)
  const [responsesError, setResponsesError] = useState<string | null>(null)
  const responsesInFlight = useRef(false)
  const responsesEpoch = useRef(0)
  // 装没装、这台电脑能装什么：「Codex 干活检查」只对装了 Codex 的人有意义，运行环境那几行的按钮写「安装」还是
  // 「安装指南」、给不给「换成新版」也看它。没读到时先不显示那张卡、不给那几颗按钮，免得点了只会报错。
  const [machine, setMachine] = useState<MachineState>({ snapshot: null, capability: null })
  const [machineProbe, setMachineProbe] = useState(0)
  // 这一页开着的时候环境变了（首页那边装完了；在这一页点「去处理」改好了设置、重新写了 Key、装好了运行环境），
  // 状态栏已经退回「环境待检测」。这一页就是看检查结果的地方，跟着重查一次，两处说的才一样（已知6）。
  // 还在查就等这一轮查完再查：它开跑时环境还没改。
  const revision = useDiagnosticsRevision()
  useEffect(() => {
    let current = true
    void Promise.allSettled([api.scanSystem(false), api.getPlatformCapabilities()]).then(([system, platform]) => {
      if (!current) return
      setMachine({
        snapshot: system.status === 'fulfilled' ? system.value : null,
        capability: platform.status === 'fulfilled' ? platform.value : null,
      })
    })
    return () => { current = false }
  }, [api, machineProbe, revision])
  const codexInstalled = machine.snapshot?.clis.codex.installed === true
  // 从错误框「检查网络」、侧栏回到这一页，看到的该是现在的结果，不是几个小时前那份。
  // 还在查就不再起一轮：探测要起好几个子进程，那一轮本来就是刚起的。
  useReloadWhenShown(active, () => {
    if (!resource.loading) void resource.reload()
    setMachineProbe((value) => value + 1)
  })
  useEffect(() => {
    if (active === false || resource.loading || checkedRevision.current === revision) return
    void resource.reload()
  }, [active, resource.loading, resource.reload, revision])
  useEffect(() => {
    const unsubscribe = api.onAccountSessionChanged(() => {
      responsesEpoch.current += 1
      setResponsesConsent(false)
      setResponsesResult(null)
      setResponsesError(null)
    })
    return () => {
      responsesEpoch.current += 1
      unsubscribe()
    }
  }, [api])
  const loadConnections = async () => {
    // 一个工具失败不该把别人的结论吞掉，所以每一条各自收口。
    const [cliRows, clientRows] = await Promise.all([
      Promise.all(connectionTools.map(async (tool): Promise<ConnectionRow> => {
        try {
          return { id: tool.id, provider: tool.id, name: tool.name, result: await api.checkProviderConnection(tool.id), error: null }
        } catch (error) {
          return { id: tool.id, provider: tool.id, name: tool.name, result: null, error: errorMessage(error) }
        }
      })),
      // 本机客户端盘点平时会复用几分钟；用户在这里亲手点「测试连接」时先强制重新
      // 盘点一次，刚装上的客户端才会出现在结果里。盘点失败不拦着自检，各条照常报错。
      api.scanExternalClients(true).catch(() => undefined).then(() => Promise.all(clientConnections.map(async (client): Promise<ConnectionRow | null> => {
        try {
          const result = await api.checkExternalClientConnection(client.id)
          // 没装这个客户端的用户不该在这一页上多看三行：那不是结论，是噪音。
          // 装了但没配的仍然列出来，显示成中性的「未配置」。
          return result.installed ? { id: client.id, provider: null, name: client.name, result, error: null } : null
        } catch (error) {
          return { id: client.id, provider: null, name: client.name, result: null, error: errorMessage(error) }
        }
      }))),
    ])
    setConnections([...cliRows, ...clientRows.filter((row): row is ConnectionRow => row !== null)])
  }
  // Claude Code 的自检要花账上的几个 token，所以整组只在用户点按钮时跑一次，
  // 不跟着 diagnostics:run 走；其余三个工具走只读的模型清单，不产生花费。
  const runConnectionCheck = async () => {
    setConnectionBusy(true)
    try {
      await loadConnections()
    } finally {
      setConnectionBusy(false)
    }
  }
  const runCodexResponsesProbe = async () => {
    if (!responsesConsent || responsesInFlight.current) return
    responsesInFlight.current = true
    setResponsesBusy(true)
    setResponsesConsent(false)
    setResponsesResult(null)
    setResponsesError(null)
    const requestEpoch = ++responsesEpoch.current
    try {
      const started = await api.getAccountSession()
      if (requestEpoch !== responsesEpoch.current) return
      // 开机恢复账号的那几秒里，界面已按「正在恢复的账号」显示，主进程却还当成未登录；
      // 这时发出去一定被判成「账号变了」，所以先请用户等恢复完。
      if (sessionRestoring(started)) {
        setResponsesError('账号还在登录中，请等几秒再检查')
        return
      }
      // 与主进程的计费作用域同一算法：只认已登录的账号，否则是访客。
      const startedScope = accountScope(started)
      const result = await api.probeCodexResponses(true, startedScope)
      const currentScope = accountScope(await api.getAccountSession())
      if (requestEpoch === responsesEpoch.current && startedScope === currentScope) {
        setResponsesResult(result)
      }
    } catch (error) {
      if (requestEpoch === responsesEpoch.current) setResponsesError(errorMessage(error))
    } finally {
      responsesInFlight.current = false
      setResponsesBusy(false)
    }
  }
  // 重写成功才重测：失败时结果条还停在刚才那条结论上，页头的横幅同时说出主进程
  // 的原话，用户看到的是「没写成，因为……」，而不是一条被刷掉的旧结论。
  const rewriteKey = async (provider: Provider) => {
    if (!onRewriteKey) return
    setConnectionBusy(true)
    try {
      await operation.execute('重新写入密钥', async () => {
        // 登录掉了的时候 App 打开的是登录框，什么都没写，这里就不该说写好了。
        const written = await onRewriteKey(provider)
        if (written) await loadConnections()
        return written
      }, (written) => written ? '已按当前账号重新写入密钥，并重新测了一次连接' : null)
    } finally {
      setConnectionBusy(false)
    }
  }
  // 检查结果里「{工具} 连接设置」那一行的「重新写入密钥」：写完重新检查，那一行立刻变成新结论；
  // 说法同首页工具卡片上那一颗。
  const rewriteDiagnosticKey = (provider: Provider) => {
    if (!onRewriteKey) return
    void operation.execute('重新写入密钥', async () => {
      const written = await onRewriteKey(provider)
      if (written) void resource.reload()
      return written
    }, (written) => written ? `已重新写入 ${spacedName(tools.find((tool) => tool.id === provider)?.name ?? '工具')}的密钥，改动前的配置已备份` : null)
  }
  // 清掉之后重新检查一遍，那一行立刻变成新的结论；结果那句话留在页头。
  const clearStaleProxy = async () => {
    await operation.execute('清掉旧的代理设置', async () => {
      const result = await api.clearStaleProxySettings()
      setProxyClearItem(null)
      void resource.reload()
      return result
    }, staleProxyClearMessage)
    setProxyClearItem(null)
  }
  // 挪开 Codex 的额外设置 / 删掉盖过当前账号的设置：做完重新检查，那一行立刻变成新结论。
  const runFix = async (kind: DiagnosticFixKind) => {
    await operation.execute(diagnosticFixLabels[kind], async () => {
      const result = await api.fixDiagnostic(kind)
      setFixing(null)
      void resource.reload()
      return result
    }, diagnosticFixMessage)
    setFixing(null)
  }
  // 「文档」不让写时那一行给的「打开文件夹」：打开了就不必再说什么。
  const openDiagnosticFolder = (item: Diagnostic) => {
    const target = diagnosticFolderTarget(item)
    if (!target) return
    void operation.execute('打开文件夹', async () => {
      if (!(await api.openDiagnosticFolder(target))) throw new Error(diagnosticFolderUnavailableMessage)
    }, () => null)
  }
  const fix = (item: Diagnostic) => {
    const provider = item.code.replace('PROVIDER_', '').toLowerCase()
    if (item.code.startsWith('PROVIDER_') && isProvider(provider) && openConfig) {
      openConfig(provider)
      return
    }
    const target = diagnosticTarget(item.code, item.details, accountSiteId)
    if (!target) return
    navigate?.(target, diagnosticSection(item.code, item.details, accountSiteId))
  }
  const platform = machine.capability?.platform
  // Node.js、Python、Git 那几行和「安全证书」（Node.js 太旧）那一行的按钮。整页没读到这台电脑能装什么时不给：
  // 读到之前装不了，「安装指南」也不知道该翻到哪一章。
  function runtimeAction(item: Diagnostic): RuntimeAction | null {
    const capability = machine.capability
    if (!capability) return null
    const missing = item.details?.installed === false
    if (item.code === 'CERTIFICATE_TRUST') {
      return item.details?.verdict === 'outdatedNode' && onReplaceNode && canReplaceNode(capability)
        ? { label: '换成新版 Node.js', testId: `health-fix-${item.code}`, job: 'node', run: onReplaceNode }
        : null
    }
    if (item.code === 'RUNTIME_NODE') {
      if (missing) {
        if (capability.nodeRuntimeInstall === 'managed') return onInstallRuntime ? { label: '安装 Node.js', testId: 'maintenance-runtime-action-node', job: 'node', run: () => onInstallRuntime('node') } : null
        return { label: '安装指南', testId: 'maintenance-runtime-action-node', run: () => navigate?.('tutorial', installGuideTopic('node', platform)) }
      }
      // 装着、却认不了公司证书的 Node.js：「安装」只会回「无需重复安装」，给「换成新版」，点了先确认再换（第十八批 4）。
      return onReplaceNode && nodeReplaceOffered({ platform, nodeRuntimeInstall: capability.nodeRuntimeInstall, node: machine.snapshot?.runtime.node })
        ? { label: '换成新版', testId: 'maintenance-runtime-action-node', job: 'node', run: onReplaceNode }
        : null
    }
    if (item.code === 'RUNTIME_PYTHON' && missing) {
      if (capability.pythonRuntimeInstall === 'managed') return onInstallRuntime ? { label: '安装 Python', testId: 'maintenance-runtime-action-python', job: 'python', run: () => onInstallRuntime('python') } : null
      // Linux 上 python.org 只给源码包，装法写在结论里，不给按钮（同首页运行环境卡）。
      return runtimeInstallButtonShown('python', platform, capability.pythonRuntimeInstall)
        ? { label: '安装指南', testId: 'maintenance-runtime-action-python', run: () => navigate?.('tutorial', installGuideTopic('python', platform)) }
        : null
    }
    // Windows 由星芒代装，Mac 弹苹果自己的安装窗口；别的系统结论里写了那一条命令（同首页运行环境卡）。
    if (item.code === 'RUNTIME_GIT' && missing && onInstallRuntime && gitHostPlatform(platform ?? 'other') !== 'other') {
      return { label: '安装 Git', testId: 'maintenance-runtime-action-git', job: 'git', run: () => onInstallRuntime('git') }
    }
    return null
  }
  // 点之前就看得见的那句：Windows 上准备 Node.js 要弹一次管理员授权（同首页运行环境卡那一句）。
  function runtimeNotice(item: Diagnostic): string | null {
    const capability = machine.capability
    if (item.code !== 'RUNTIME_NODE' || item.details?.installed !== false || !capability) return null
    return homeNodeElevationNotice(capability.platform, capability.nodeRuntimeInstall, false, capability.processElevated)
  }
  function rewritableProvider(item: Diagnostic): Provider | null {
    const provider = item.code.replace('PROVIDER_', '').toLowerCase()
    if (item.state === 'pass' || !item.code.startsWith('PROVIDER_') || !isProvider(provider) || !onRewriteKey) return null
    return rewritableKeys?.includes(provider) ? provider : null
  }
  function rowActionable(item: Diagnostic): boolean {
    return canClearStaleProxy(item) || Boolean(diagnosticFixKind(item)) || Boolean(diagnosticFolderTarget(item)) || runtimeAction(item) !== null
  }
  const responsesView = responsesResult ? connectionCheckView(responsesResult) : null
  const exportReport = () =>
    void operation.execute(
      'export',
      () => api.exportDiagnostics(),
      (result) =>
        result
          ? {
              text: `检查报告已导出：${result.outputPath}`,
              revealPath: result.outputPath,
            }
          : null,
    )
  const diagnosticRow = (item: Diagnostic, group: DiagnosticGroup) => {
    const detailRows = diagnosticDetailRows(item.details)
    const open = openCode === item.code && detailRows.length > 0
    const runtime = runtimeAction(item)
    const notice = runtimeNotice(item)
    const rewritable = rewritableProvider(item)
    const detailsId = `health-details-panel-${item.code}`
    return (
      <div key={item.code} className="xm-list-row v2-health-row" data-anchor={item.code} data-testid={`health-row-${item.code}`}>
        <StateIcon tone={diagnosticTone(item, group)} label={diagnosticStateLabel(item.state)} />
        <div className="xm-row-main">
          <div className="xm-row-title">{item.title}</div>
          <div className="xm-row-desc">{item.summary}</div>
          {notice && <p className="v2-health-note" data-testid="health-runtime-node-elevation">{notice}</p>}
          {open && (
            <dl className="v2-health-more" id={detailsId} data-testid={`health-details-${item.code}`}>
              {detailRows.map((row) => (
                <div key={row.key}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="xm-row-actions">
          {canClearStaleProxy(item) && (
            <Button
              size="sm"
              icon={Trash2}
              onClick={() => setProxyClearItem(item)}
              testId="health-clear-stale-proxy"
            >
              清掉这条旧设置
            </Button>
          )}
          {diagnosticFixKind(item) && (
            <Button
              size="sm"
              icon={Wrench}
              onClick={() => setFixing(diagnosticFixKind(item))}
              testId={`health-fix-inline-${item.code}`}
            >
              {diagnosticFixLabel(item)}
            </Button>
          )}
          {diagnosticFolderTarget(item) && (
            <Button
              size="sm"
              icon={FolderOpen}
              onClick={() => openDiagnosticFolder(item)}
              testId={`health-open-folder-${item.code}`}
            >
              打开文件夹
            </Button>
          )}
          {runtime && (
            <Button
              size="sm"
              icon={runtime.label === '安装指南' ? BookOpen : Download}
              loading={Boolean(runtime.job && toolJobs?.[runtime.job])}
              onClick={runtime.run}
              testId={runtime.testId}
            >
              {runtime.label}
            </Button>
          )}
          {rewritable ? (
            <Button
              size="sm"
              icon={KeyRound}
              loading={operation.busy === '重新写入密钥'}
              onClick={() => rewriteDiagnosticKey(rewritable)}
              testId={`health-rewrite-${item.code}`}
            >
              重新写入密钥
            </Button>
          ) : (
            item.state !== 'pass' && diagnosticHasFix(item.code, item.details, accountSiteId) && (
              <Button
                size="sm"
                icon={Wrench}
                onClick={() => fix(item)}
                testId={`health-fix-${item.code}`}
              >
                去处理
              </Button>
            )
          )}
          {detailRows.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={open ? detailsId : undefined}
              onClick={() => setOpenCode(open ? null : item.code)}
              testId={`health-details-toggle-${item.code}`}
            >
              {open ? '收起' : '详情'}
            </Button>
          )}
        </div>
      </div>
    )
  }
  const groupHead = (group: DiagnosticGroup, title: string, count: number, toggle?: ReactNode) => (
    <div className="v2-health-group-head">
      <h2>{title}<span className="v2-health-count">{count}</span></h2>
      {toggle}
    </div>
  )
  const groupList = (group: DiagnosticGroup, items: readonly Diagnostic[]) =>
    items.length > 0 && <Card padding="none">{items.map((item) => diagnosticRow(item, group))}</Card>
  const passingRows = showPassing ? groups.ok : groups.ok.filter(rowActionable)
  const passingNames = showPassing ? [] : groups.ok.filter((item) => !rowActionable(item))
  const problemCount = groups.problem.length
  const report = resource.data
  const results = (
    <>
      {report && (
        <div className={problemCount ? 'v2-health-summary' : 'v2-health-summary is-focus'} data-testid="health-summary">
          <span className="v2-health-summary-tile" aria-hidden="true">
            {problemCount ? <TriangleAlert size={18} /> : <Check size={18} />}
          </span>
          <div>
            <strong>{problemCount ? `检查完成：${problemCount} 项需要处理` : '检查完成：全部正常'}</strong>
            <p><RelativeTime value={report.generatedAt} />检查，共 {diagnostics.length} 项</p>
          </div>
        </div>
      )}
      {problemCount > 0 && (
        <section className="v2-health-group" data-testid="health-group-problem">
          {groupHead('problem', '需要处理', problemCount)}
          {groupList('problem', groups.problem)}
        </section>
      )}
      {groups.optional.length > 0 && (
        <section className="v2-health-group" data-testid="health-group-optional">
          {groupHead('optional', '可选', groups.optional.length)}
          {groupList('optional', groups.optional)}
        </section>
      )}
      {groups.ok.length > 0 && (
        <section className="v2-health-group" data-testid="health-group-ok">
          {groupHead('ok', '正常', groups.ok.length, (
            <button
              type="button"
              className="v2-health-toggle"
              aria-expanded={showPassing}
              onClick={() => setShowPassing((value) => !value)}
              data-testid="health-passing-toggle"
            >
              {showPassing ? '收起' : '展开'}
            </button>
          ))}
          {groupList('ok', passingRows)}
          {passingNames.length > 0 && (
            <div className="v2-health-ok-sum" data-testid="health-passing">
              {passingNames.map((item) => (
                <span key={item.code}><Check size={13} strokeWidth={2.6} aria-hidden="true" />{item.title}</span>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  )
  const resultState = (children: ReactNode) => (
    <ListState
      page="health"
      noun="检查结果"
      loadingTitle="正在检查…"
      loadingDescription={null}
      emptyTitle="还没有做过完整检查"
      emptyDescription="点右上角「重新检查」。"
      loading={resource.loading}
      error={resource.error}
      count={diagnostics.length}
      retry={() => void resource.reload()}
    >
      {children}
    </ListState>
  )
  const connectionsTested = connections !== null
  return (
    <section
      ref={pageRef}
      className="v2-page v2-health"
      data-page-id="health"
      data-testid="page-health"
    >
      <PageHead
        title="检查"
        actions={
          <>
            <Button
              size="sm"
              icon={Download}
              disabled={resource.loading}
              onClick={exportReport}
            >
              导出检查报告
            </Button>
            <Button
              size="sm"
              icon={RefreshCw}
              loading={resource.loading}
              onClick={() => void resource.reload()}
            >
              重新检查
            </Button>
          </>
        }
      />
      <ResultNotice
        {...operation}
        onReveal={(path) => api.revealExportedFile(path)}
      />
      {diagnostics.length ? resultState(results) : <Card padding="none">{resultState(null)}</Card>}
      <section className="v2-health-group" aria-labelledby="health-connection-title">
        <div className="v2-health-group-head"><h2 id="health-connection-title">连接自检</h2></div>
        <div className="xm-card xm-card-none" data-testid="health-connection">
          <div className="xm-list-row v2-health-row">
            <span className="v2-health-tile" aria-hidden="true"><Globe2 size={15} /></span>
            <div className="xm-row-main">
              <div className="xm-row-title">测试连接</div>
              <div className="xm-row-desc">确认每个工具都能连上、账号有效；装好的外部客户端也一起测</div>
              {connections && (
                <div className="v2-health-lines">
                  {sortConnectionRows(connections).map((row) => (
                    <ConnectionRowItem
                      key={row.id}
                      row={row}
                      navigate={navigate}
                      canRewriteKey={row.provider !== null && rewritableKeys?.includes(row.provider)}
                      onRewriteKey={onRewriteKey ? (provider) => void rewriteKey(provider) : undefined}
                      open={connectionDetailsId === row.id}
                      onToggle={(entry) => setConnectionDetailsId((current) => current === entry.id ? null : entry.id)}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="xm-row-actions">
              <Button
                size="sm"
                icon={PlugZap}
                loading={connectionBusy}
                onClick={() => void runConnectionCheck()}
                testId="health-connection-run"
              >
                {connectionsTested ? '再测一次' : '测试连接'}
              </Button>
            </div>
          </div>
          {codexInstalled && (
            <div className="xm-list-row v2-health-row" data-testid="health-codex-responses">
              <span className="v2-health-tile" aria-hidden="true"><Terminal size={15} /></span>
              <div className="xm-row-main">
                <div className="xm-row-title">Codex 干活检查</div>
                <div className="xm-row-desc">让 Codex 真的做一件小事，确认它能正常干活，不会改你的文件</div>
                <label className="v2-health-consent" data-testid="health-codex-responses-consent">
                  <input
                    type="checkbox"
                    checked={responsesConsent}
                    disabled={responsesBusy}
                    onChange={(event) => setResponsesConsent(event.target.checked)}
                  />
                  <span>我知道这会用掉当前账号的一点额度</span>
                </label>
                {responsesView && (
                  <div className="v2-health-lines" data-testid="health-codex-responses-result">
                    <div className={`v2-health-line is-${responsesView.tone}`}>
                      <StateIcon tone={responsesView.tone} label={responsesView.statusLabel} />
                      <div className="v2-health-line-main">
                        <span className="v2-health-line-text">{responsesView.tone === 'ok' ? 'Codex 能正常干活' : responsesView.title}</span>
                        {responsesView.tone !== 'ok' && <p className="v2-health-note">{responsesView.body}</p>}
                        {responsesView.detail && <p className="v2-health-note">{responsesView.detail}</p>}
                      </div>
                    </div>
                  </div>
                )}
                {responsesError && (
                  <div className="v2-health-lines" data-testid="health-codex-responses-error">
                    <div className="v2-health-line is-bad">
                      <StateIcon tone="bad" label="没测成" />
                      <span className="v2-health-line-text">Codex 没测成：{responsesError}</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="xm-row-actions">
                <Button
                  size="sm"
                  icon={PlugZap}
                  disabled={!responsesConsent || responsesBusy}
                  loading={responsesBusy}
                  onClick={() => void runCodexResponsesProbe()}
                  testId="health-codex-responses-run"
                >
                  开始检查
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
      <Confirm
        open={Boolean(fixing)}
        title={fixing ? diagnosticFixConfirm[fixing].title : ''}
        body={fixing ? diagnosticFixConfirm[fixing].body : ''}
        okLabel={fixing ? diagnosticFixConfirm[fixing].ok : ''}
        loading={Boolean(fixing) && operation.busy === (fixing ? diagnosticFixLabels[fixing] : '')}
        onOk={() => { if (fixing) void runFix(fixing) }}
        onClose={() => setFixing(null)}
        testId="health-fix-confirm"
      />
      <Confirm
        open={Boolean(proxyClearItem)}
        title="清掉这条旧的代理设置？"
        body={staleProxyConfirmBody(proxyClearItem?.details)}
        okLabel="清掉"
        loading={operation.busy === '清掉旧的代理设置'}
        onOk={() => void clearStaleProxy()}
        onClose={() => setProxyClearItem(null)}
        testId="health-clear-stale-proxy-confirm"
      />
    </section>
  )
}

/** 与上面筛选条的说法一致；英文级别名只进导出的报告。 */
const runtimeLogLevelLabels: Readonly<Record<string, string>> = {
  error: '错误',
  warn: '提醒',
  info: '信息',
  debug: '调试',
}
/** 反馈页一次读多少条运行日志。 */
const runtimeLogLimit = 500
/** 日志列表先铺这么多条，最后一行「再显示 100 条」。 */
const runtimeLogPage = 100

// 预览过了 30 分钟，主进程会按最新日志重生成再复制/导出；提示要让客户知道拿到的是新的那份。
export function feedbackCopyNotice(result: FeedbackReportCopyResult) {
  return result.regenerated
    ? '报告已更新到最新日志并复制，发给客服就行'
    : '报告已复制'
}

export function feedbackExportNotice(
  result: FeedbackReportExportResult | null,
): OperationNotice | null {
  if (!result) return null
  return {
    text: result.regenerated
      ? `报告已更新到最新日志并导出：${result.outputPath}`
      : `反馈报告已导出：${result.outputPath}`,
    revealPath: result.outputPath,
  }
}

/** 留言的类型，复制给客服时写在第一行。 */
const feedbackTypes = [
  { value: 'bug', label: '遇到问题' },
  { value: 'idea', label: '功能建议' },
  { value: 'other', label: '其他' },
]

/**
 * 「复制给客服」复制出去的那一段（v4 第 10 批按问 5：不往服务器提交，客户自己发给客服）：类型、客户写的、
 * 联系方式、身份行、最近一次出错；勾了「附带诊断报告」再接上整份反馈报告（主进程已经脱敏）。
 * 客户自己写的那几行再过一遍打码表（I13）：描述里偶尔会贴上 sk-… 或 Bearer …。
 */
export function buildFeedbackMessage(input: {
  type: string
  description: string
  contact: string
  identity?: string
  lastFailure?: string
  report?: string
}): string {
  const lines = [`留言反馈 · ${input.type}`, input.description.trim()]
  const contact = input.contact.trim()
  if (contact) lines.push(`联系方式：${contact}`)
  if (input.identity) lines.push(input.identity)
  if (input.lastFailure) lines.push(input.lastFailure)
  const head = redactSecretPatterns(lines.join('\n'))
  return input.report ? `${head}\n\n${input.report}` : head
}

/** 运行日志页签上那个红色角标：这次打开软件以后记下的错误条数（以前打开时留下的旧错误不算）。 */
export function feedbackErrorCount(snapshot: Pick<RuntimeLogSnapshot, 'entries' | 'currentProcessId' | 'startedAt'> | null | undefined): number {
  if (!snapshot) return 0
  return snapshot.entries.filter((entry) => entry.level === 'error' && isCurrentBootEntry(entry, snapshot)).length
}

export function FeedbackPage({
  api,
  navigate,
  support,
  feedbackRequest,
  ordersVisible,
  active,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.getRuntimeLogs(runtimeLogLimit), [api])
  const resource = useResource(load)
  // 错误框「查看日志」把人带回这一页时，刚出的那个错要在「运行日志」最上面，不用再点「刷新」。
  useReloadWhenShown(active, () => void resource.reload())
  const operation = useOperation()
  const [tab, setTab] = useState<FeedbackTabValue>(feedbackRequest?.tab ?? 'form')
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState(anyRuntimeLogValue)
  const [source, setSource] = useState(feedbackRequest?.installLog ? installRuntimeLogArea : anyRuntimeLogValue)
  const [onlyCurrentBoot, setOnlyCurrentBoot] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  // 刚点过「清除」：列表空着时说「日志已清空」，不说「还没有运行日志」。下一次读到日志就不再算。
  const [cleared, setCleared] = useState(false)
  const [type, setType] = useState(feedbackTypes[0].value)
  const [description, setDescription] = useState('')
  const [descriptionError, setDescriptionError] = useState('')
  const [contact, setContact] = useState('')
  const [attachReport, setAttachReport] = useState(true)
  // 写了字还没复制出去：关窗口时提醒一句（App 认 data-unsaved）。复制过以后再改才又算。
  const [copied, setCopied] = useState(false)
  const formRef = useRef<HTMLElement>(null)
  // 外面点名要看「运行日志」（错误框「查看日志」、顶部搜索、帮助弹窗）：页面早就挂着，只是藏着，换到那个页签；
  // 装工具没装上时来源先选好「安装与更新」。别的筛选条件清掉，免得刚出的那一条被筛走。
  const handledRequest = useRef(feedbackRequest?.sequence)
  useEffect(() => {
    if (!feedbackRequest || handledRequest.current === feedbackRequest.sequence) return
    handledRequest.current = feedbackRequest.sequence
    setTab(feedbackRequest.tab)
    if (feedbackRequest.tab !== 'log') return
    setQuery('')
    setLevel(anyRuntimeLogValue)
    setOnlyCurrentBoot(false)
    setSource(feedbackRequest.installLog ? installRuntimeLogArea : anyRuntimeLogValue)
  }, [feedbackRequest])
  // 「再显示 100 条」点到第几页；换了筛选条件就从头的 100 条重新开始，改回原来的条件也不接着上次的页数。
  const filterKey = JSON.stringify([level, source, query, onlyCurrentBoot])
  const [shown, setShown] = useState({ key: filterKey, count: runtimeLogPage })
  if (shown.key !== filterKey) setShown({ key: filterKey, count: runtimeLogPage })
  const visibleCount = shown.key === filterKey ? shown.count : runtimeLogPage
  const [report, setReport] = useState<Awaited<
    ReturnType<V2Bridge['getFeedbackReport']>
  > | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const entries = resource.data?.entries ?? []
  if (cleared && entries.length) setCleared(false)
  const filter = {
    level,
    source,
    query,
    onlyCurrentBoot,
    currentProcessId: resource.data?.currentProcessId ?? -1,
    startedAt: resource.data?.startedAt ?? '',
  }
  const list = filterRuntimeLogs(entries, filter)
  const writeNotice = runtimeLogWriteNotice(resource.data?.writeFailure)
  const errorCount = feedbackErrorCount(resource.data)
  const now = Date.now()
  const shownLogs = list.slice(0, visibleCount).map((entry) => ({ entry, time: runtimeLogTimeText(entry.timestamp, now) }))
  // 去年的条目时间带年份，比平常长一截：有一条带年份，各行的时间那一格一起放宽，才对得齐。
  const logRowClass = shownLogs.some(({ time }) => time.includes('年')) ? 'v2-feedback-log has-year' : 'v2-feedback-log'
  const resetFilters = () => {
    setQuery('')
    setLevel(anyRuntimeLogValue)
    setSource(anyRuntimeLogValue)
    setOnlyCurrentBoot(false)
  }
  const preview = () =>
    void operation.execute(
      'preview',
      async () => setReport(await api.getFeedbackReport()),
      '',
    )
  const typeLabel = feedbackTypes.find((entry) => entry.value === type)?.label ?? feedbackTypes[0].label
  const copyToSupport = () => {
    if (!description.trim()) {
      setDescriptionError('请先描述一下发生了什么')
      formRef.current?.querySelector('textarea')?.focus()
      return
    }
    void operation.execute('send', async () => {
      // 每次复制都现取一份报告：几分钟前预览的那份里没有刚才那次出错。
      const attached = attachReport ? (await api.getFeedbackReport()).text : undefined
      await navigator.clipboard.writeText(buildFeedbackMessage({
        type: typeLabel,
        description,
        contact,
        identity: support?.identity,
        lastFailure: support?.lastFailure,
        report: attached,
      }))
      setCopied(true)
      support?.open()
    }, '已复制，发给客服就行')
  }
  const tries = [
    { id: 'health', title: '工具装不上，或者打开就闪退', action: '先跑一遍检查', go: () => navigate?.('health') },
    ...(ordersVisible === false ? [] : [{ id: 'orders', title: '付了款，余额没变', action: '看我的订单', go: () => navigate?.('account', 'orders') }]),
    { id: 'tutorial', title: '不知道从哪里开始用', action: '看教程', go: () => navigate?.('tutorial') },
    { id: 'mcp', title: '想把 AI 连上浏览器或文件夹', action: '去外接工具', go: () => navigate?.('mcp') },
  ]
  const form = (
    <div className="v2-fb-grid">
      <section
        ref={formRef}
        className="v2-acct-card v2-fb-form"
        aria-label="留言反馈"
        data-testid="feedback-form"
        data-unsaved={description.trim() && !copied ? 'true' : undefined}
      >
        <div className="v2-fb-field">
          <span id="feedback-type-label">类型</span>
          <Segment options={feedbackTypes} value={type} onChange={setType} label="类型" testId="feedback-type" />
        </div>
        <Textarea
          label="描述一下发生了什么"
          rows={5}
          value={description}
          placeholder="比如：点「打开」后终端闪一下就关了"
          error={descriptionError || undefined}
          onChange={(event) => {
            setDescription(event.target.value)
            setCopied(false)
            if (descriptionError && event.target.value.trim()) setDescriptionError('')
          }}
          testId="feedback-description"
        />
        <Input
          label="联系方式（可选）"
          value={contact}
          placeholder="微信号或邮箱，方便我们回复你"
          onChange={(event) => {
            setContact(event.target.value)
            setCopied(false)
          }}
          testId="feedback-contact"
        />
        <div className="v2-fb-attach">
          <div className="v2-fb-attach-text">
            <strong id="feedback-attach-label">附带诊断报告</strong>
            <p>已自动隐去密钥和个人路径<button type="button" className="v2-fb-link" onClick={preview} data-testid="feedback-attach-preview">预览报告</button></p>
          </div>
          <Switch checked={attachReport} onChange={setAttachReport} aria-label="附带诊断报告" testId="feedback-attach" />
        </div>
        <div className="v2-fb-submit">
          <Button
            variant="primary"
            icon={Copy}
            loading={operation.busy === 'send'}
            onClick={copyToSupport}
            testId="feedback-send"
          >
            复制给客服
          </Button>
        </div>
      </section>
      <div className="v2-fb-side">
        {support && (
          <section className="v2-acct-card is-focus v2-fb-support" data-testid="feedback-support-card">
            <h2>找客服</h2>
            <div className="v2-fb-support-qr">
              {support.qr && <img src={support.qr} alt="微信客服二维码" />}
              <div>
                <strong>微信扫码添加客服</strong>
                <p>装不上、付了没到账，都可以问。</p>
                {support.qrFallback && <p role="alert" data-testid="feedback-support-qr-fallback">{support.qrFallback}</p>}
                <button type="button" className="v2-fb-link" onClick={support.open} data-testid="feedback-support-open">在浏览器打开</button>
              </div>
            </div>
            <SupportIdentity line={support.identity} lastFailure={support.lastFailure} onCopy={support.copyIdentity} testIdPrefix="feedback-support" />
            <button
              type="button"
              className="v2-fb-link"
              onClick={preview}
              disabled={operation.busy === 'preview'}
              data-testid="feedback-preview"
            >
              预览反馈报告
            </button>
          </section>
        )}
        <section className="v2-acct-well v2-fb-try" data-testid="feedback-try">
          <h2>先试试这些</h2>
          {tries.map((entry) => (
            <button key={entry.id} type="button" className="v2-fb-try-item" onClick={entry.go} data-testid={`feedback-try-${entry.id}`}>
              <span>
                <span>{entry.title}</span>
                <small>{entry.action}</small>
              </span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          ))}
        </section>
      </div>
    </div>
  )
  const log = (
    <div className="v2-fb-log">
      {writeNotice ? (
        <Notice
          tone="warn"
          title={writeNotice.title}
          body={writeNotice.body}
          testId="feedback-log-write-failed"
          actions={
            navigate ? (
              <Button size="sm" icon={HeartPulse} onClick={() => navigate('health')}>
                去检查页
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <div className="v2-fb-log-tools">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="搜索日志"
          testId="feedback-search"
        />
        <Segment
          options={[
            { value: anyRuntimeLogValue, label: '全部' },
            { value: 'error', label: '错误' },
            { value: 'warn', label: '提醒' },
            { value: 'info', label: '信息' },
          ]}
          value={level}
          onChange={setLevel}
        />
        <Switch
          checked={onlyCurrentBoot}
          onChange={setOnlyCurrentBoot}
          label="只看本次启动"
          testId="feedback-current-boot"
        />
        <span className="v2-fb-log-gap" />
        <Button
          size="sm"
          variant="ghost"
          icon={RefreshCw}
          aria-label="刷新"
          title="刷新"
          loading={resource.loading && Boolean(resource.data)}
          onClick={() => void resource.reload()}
          testId="feedback-refresh"
        />
        <Button
          size="sm"
          icon={FolderOpen}
          onClick={() =>
            void operation.execute(
              'directory',
              () => api.openRuntimeLogDirectory(),
              '',
            )
          }
        >
          打开日志文件夹
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!entries.length || Boolean(resource.error)}
          onClick={() => setClearOpen(true)}
          testId="feedback-clear"
        >
          清除日志
        </Button>
      </div>
      <Chips
        label="按来源筛选"
        options={runtimeLogSourceOptions(resource.data?.entries, source)}
        value={source}
        onChange={setSource}
        testId="feedback-source"
      />
      <Card padding="none" testId="feedback-log-list">
        <ListState
          page="feedback"
          noun="运行日志"
          loading={resource.loading}
          error={resource.error}
          count={list.length}
          query={query}
          filtered={hasRuntimeLogFilter(filter)}
          retry={() => void resource.reload()}
          clear={resetFilters}
          emptyTitle={cleared ? '日志已清空' : undefined}
          emptyDescription={cleared ? '之后的操作会重新记录在这里。' : '软件运行时的事件会记录在这里。'}
          filteredTitle="没有符合条件的日志"
          filteredDescription="换个筛选条件，或者关掉「只看本次启动」。"
          errorDescription="点「重新加载」再试；还不行，点「打开日志文件夹」直接看日志文件。"
        >
          {shownLogs.map(({ entry, time }) => {
            const open = openId === entry.id
            const detailId = `feedback-log-detail-${entry.id}`
            return (
              <div key={entry.id} className={open ? 'v2-feedback-log-entry is-open' : 'v2-feedback-log-entry'}>
                <button
                  type="button"
                  className={logRowClass}
                  aria-expanded={open}
                  aria-controls={open ? detailId : undefined}
                  onClick={() => setOpenId(open ? null : entry.id)}
                  data-testid={`feedback-log-${entry.id}`}
                >
                  <time dateTime={entry.timestamp} title={displayDate(entry.timestamp)}>
                    {time}
                  </time>
                  <span className={`v2-feedback-log-level is-${entry.level}`}>
                    <Pill tone={entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : 'neutral'}>
                      {runtimeLogLevelLabels[entry.level] ?? entry.level}
                    </Pill>
                  </span>
                  <span className="v2-feedback-log-source">{runtimeLogAreaLabel(entry)}</span>
                  <span className="v2-feedback-log-message">{runtimeLogDisplayMessage(entry.message)}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                {open && (
                  <div className="v2-feedback-log-detail" id={detailId} data-testid="feedback-log-detail">
                    <dl className="v2-business-kv">
                      <dt>时间</dt>
                      <dd>{displayDate(entry.timestamp)}</dd>
                      <dt>来源</dt>
                      <dd>{runtimeLogArea(entry)}</dd>
                      <dt>事件</dt>
                      <dd>{entry.event}</dd>
                      <dt>内容</dt>
                      <dd>{entry.message}</dd>
                    </dl>
                    {entry.detail !== undefined && entry.detail !== null && (
                      <pre className="v2-business-code">{JSON.stringify(entry.detail, null, 2)}</pre>
                    )}
                    <div className="v2-feedback-log-detail-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Copy}
                        loading={operation.busy === 'copy-entry'}
                        onClick={() =>
                          void operation.execute(
                            'copy-entry',
                            () => navigator.clipboard.writeText(formatRuntimeLogEntry(entry)),
                            '已复制这一条日志',
                          )
                        }
                        testId="feedback-log-copy"
                      >
                        复制这一条
                      </Button>
                      <span>已隐去密钥</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {list.length > visibleCount && (
            <button
              type="button"
              className="v2-feedback-log-next"
              onClick={() => setShown({ key: filterKey, count: visibleCount + runtimeLogPage })}
              data-testid="feedback-log-next"
            >
              再显示 {runtimeLogPage} 条
            </button>
          )}
        </ListState>
      </Card>
      <p className="v2-fb-foot">日志只保存在这台电脑上。</p>
    </div>
  )
  return (
    <section
      className="v2-page v2-fb"
      data-page-id="feedback"
      data-testid="page-feedback"
    >
      <PageHead title="反馈与客服" />
      <Tabs
        label="反馈与客服"
        items={feedbackTabs.map((entry) => ({
          value: entry.value,
          label: entry.label,
          panelId: `feedback-panel-${entry.value}`,
          meta: entry.value === 'log' && errorCount > 0
            ? <span className="v2-fb-tab-count" data-testid="feedback-error-count">{errorCount}</span>
            : undefined,
        }))}
        value={tab}
        onChange={(value) => setTab(value === 'log' ? 'log' : 'form')}
        testId="feedback-tabs"
      />
      <ResultNotice
        {...operation}
        onReveal={(path) => api.revealExportedFile(path)}
      />
      {/* 两个页签都挂着、只藏不卸：留言写到一半去翻日志，回来字还在，关窗口时也照样提醒没复制出去。 */}
      <div id="feedback-panel-form" role="tabpanel" aria-label="留言反馈" hidden={tab !== 'form'} data-testid="feedback-panel-form">{form}</div>
      <div id="feedback-panel-log" role="tabpanel" aria-label="运行日志" hidden={tab !== 'log'} data-testid="feedback-panel-log">{log}</div>
      <Dialog
        open={Boolean(report)}
        title="预览反馈报告"
        width={640}
        onClose={() => setReport(null)}
        footer={
          <>
            <Button
              icon={Download}
              loading={operation.busy === 'export'}
              onClick={() =>
                report &&
                void operation.execute(
                  'export',
                  async () => {
                    const result = await api.exportFeedbackReport(report.id)
                    if (result?.regenerated) setReport(result.regenerated)
                    return result
                  },
                  feedbackExportNotice,
                )
              }
            >
              导出文件
            </Button>
            <Button
              icon={Copy}
              loading={operation.busy === 'copy'}
              onClick={() =>
                report &&
                void operation.execute(
                  'copy',
                  async () => {
                    const result = await api.copyFeedbackReport(report.id)
                    if (result.regenerated) setReport(result.regenerated)
                    return result
                  },
                  feedbackCopyNotice,
                )
              }
            >
              复制报告
            </Button>
            <Button onClick={() => setReport(null)}>关闭</Button>
          </>
        }
      >
        <p className="v2-fb-privacy" data-testid="feedback-privacy">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>密钥、密码和用户名都已隐去。发送前再看一眼有没有私有项目名称和地址。</span>
        </p>
        {report?.selfChecked === false && navigate && (
          <Notice
            tone="accent"
            icon={HeartPulse}
            title="报告里还没有检查结果"
            body="点「去检查」，等检查页查完再回来复制或导出，客服能少问你几句。"
            actions={
              <Button
                size="sm"
                icon={HeartPulse}
                onClick={() => {
                  setReport(null)
                  navigate('health')
                }}
                testId="feedback-report-go-check"
              >
                去检查
              </Button>
            }
            testId="feedback-report-unchecked"
          />
        )}
        <ResultNotice
          {...operation}
          onReveal={(path) => api.revealExportedFile(path)}
        />
        <Textarea
          aria-label="预览反馈报告"
          readOnly
          rows={14}
          value={report?.text ?? ''}
          testId="feedback-report-text"
        />
      </Dialog>
      <Confirm
        open={clearOpen}
        title="清除全部运行日志？"
        body={
          <>
            <p>清除后找不回来。要发反馈的话，建议先保留日志。</p>
            <p>仅清除运行日志，不会删除工具配置、账号或对话记录。</p>
            <ResultNotice error={operation.error} detail={operation.detail} />
          </>
        }
        okLabel="清除"
        danger
        loading={operation.busy === 'clear'}
        onOk={() =>
          void operation.execute(
            'clear',
            async () => {
              await api.clearRuntimeLogs()
              setClearOpen(false)
              setOpenId(null)
              await resource.reload()
              // 读回来以后才记：先记的话，重读之前那一帧列表里还是旧日志，马上又被当成「读到了新日志」清掉。
              setCleared(true)
            },
            '日志已清除',
          )
        }
        onClose={() => setClearOpen(false)}
        testId="feedback-clear-confirm"
      />
    </section>
  )
}

export function installResultMessage(result: ToolInstallOutcome | 'cancelled'): string | null {
  if (result === 'declined') return null
  if (result === 'cancelled') return '安装已取消'
  if (result === 'restart') return '运行环境已装好，重启电脑后再点一次「安装」'
  if (result === 'skipped') return '这个工具正在安装，等它做完就好'
  return '安装完成，工具状态已更新'
}

/**
 * 首页那边这个工具正挂着的任务算不算这一行在装：卸载也挂在工具编号下，那不是安装，
 * 这一行不能标「安装中」，只说正在卸载、按钮先灰着。
 */
export function installJobRunning(job: ToolJob | undefined): boolean {
  return job !== undefined && job.kind !== 'uninstall'
}

/**
 * 「查看安装步骤」「安装指南」落到教程哪一章。以前一律落到第一章，客户还得自己翻：
 * 桌面端在 Mac 上去「Mac 上装桌面端」、别的电脑去「Codex 桌面端怎么安装？」；命令行
 * 工具去「进阶：安装与使用命令行工具」；运行环境在 Mac 上去「Mac 上准备 Node.js 和 Python」，
 * 别的电脑也去命令行工具那一章。
 */
export function installGuideTopic(
  id: Provider | 'codexDesktop' | 'node' | 'python',
  platform: PlatformCapabilities['platform'] | undefined,
): string {
  const mac = platform === 'macos'
  if (id === 'codexDesktop') return mac ? macDesktopTutorialTopic : desktopInstallTutorialTopic
  if (id === 'node' || id === 'python') return mac ? macRuntimeTutorialTopic : cliTutorialTopic
  return cliTutorialTopic
}

/** 设置页顶上那句。找设置用左栏的「搜索设置」，这里不再教按 Ctrl K。 */
export const settingsPageLead = '改动会立即保存。'

/**
 * 设置页「版本更新」里的两个重来入口。两件事名字很像、做的事不一样：「新手引导」重走
 * 安装配置的四步引导，「界面导览」只是把首页上那几条操作提示再放一遍。
 */
export function OnboardingGuideRow({ openGuide }: { openGuide: () => void }) {
  return (
    <SettingRow
      title={settingsItemLabel('guide')}
      anchor="guide"
      description={null}
      control={
        <Button
          size="sm"
          icon={BookOpen}
          onClick={openGuide}
          testId="settings-start-guide"
        >
          再看一遍
        </Button>
      }
    />
  )
}

export function OnboardingTourRow({ replayTour }: { replayTour: () => void }) {
  return (
    <SettingRow
      title={settingsItemLabel('tour')}
      anchor="tour"
      description={null}
      control={
        <Button
          size="sm"
          icon={Compass}
          onClick={replayTour}
          testId="settings-replay-tour"
        >
          重看导览
        </Button>
      }
    />
  )
}

export function SettingsPage({
  api,
  navigate,
  onSettingsChanged,
  openGuide,
  replayTour,
  uiScale,
  chatTransfer,
  appSettings,
  updateAvailable,
  accelerating,
  active,
  accelerationCard,
  onSettingsGroupChange,
  onBackupRestored,
  installedProviders,
}: { api: V2Bridge } & BusinessActions & Pick<Parameters<typeof BackupCard>[0], 'installedProviders'> & {
  /** 备份卡恢复成功后回调，用来让首页重读配置。 */
  onBackupRestored?: Parameters<typeof BackupCard>[0]['onRestored']
}) {
  const load = useCallback(async () => {
    const [settings, capabilities, update] = await Promise.all([
      api.getSettings(),
      api.getWindowCapabilities(),
      // 「自动更新」显不显示、「当前版本」写哪一版：读不到就当这台电脑不支持、版本暂未读到，不挡设置页。
      api.getUpdateState().catch(() => null),
    ])
    return { settings, capabilities, update }
  }, [api])
  const resource = useResource(load)
  const setResourceData = resource.setData
  useEffect(() => {
    if (uiScale === undefined) return
    const persisted = uiScale === 'auto' ? undefined : uiScale
    setResourceData((previous) => {
      if (!previous || previous.settings.uiScale === persisted) return previous
      const { uiScale: _stale, ...rest } = previous.settings
      return { ...previous, settings: persisted === undefined ? rest : { ...rest, uiScale: persisted } }
    })
  }, [uiScale, setResourceData])
  // 更新气泡里也能改「自动下载更新」，改完 App 拿到的是最新的；这一页开着时跟着变。
  const checkUpdatesOnStartup = appSettings?.checkUpdatesOnStartup
  const autoUpdate = appSettings?.autoUpdate
  useEffect(() => {
    if (checkUpdatesOnStartup === undefined) return
    setResourceData((previous) => {
      if (!previous || (previous.settings.checkUpdatesOnStartup === checkUpdatesOnStartup && previous.settings.autoUpdate === autoUpdate)) return previous
      return { ...previous, settings: { ...previous.settings, checkUpdatesOnStartup, autoUpdate } }
    })
  }, [checkUpdatesOnStartup, autoUpdate, setResourceData])
  // 「要输入管理员密码才能装」这句现在只在「自动下载更新」那一行说（原来更新页顶上那段跟着推送变），
  // 这一页开着时也跟着主进程推来的更新状态走，别停在打开时读到的那一份。
  useEffect(() => api.onUpdateState((update) => {
    setResourceData((previous) => (previous ? { ...previous, update } : previous))
  }), [api, setResourceData])
  const operation = useOperation()
  const showToast = useToast().show
  const systemApi = platformApi()
  const [systemState, setSystemState] = useState<PlatformSystemState | null>(
    null,
  )
  const [systemError, setSystemError] = useState('')
  // 「重新读取」一次就加一，系统状态那一块从头再读一遍。
  const [systemAttempt, setSystemAttempt] = useState(0)
  const [isMac, setIsMac] = useState(false)
  const [isLinux, setIsLinux] = useState(false)
  const [accelerationAvailable, setAccelerationAvailable] = useState(true)
  useEffect(() => {
    let current = true
    // 读不到平台就照旧显示工具的安装卸载，不出「卸载星芒」。
    void api.getPlatformCapabilities()
      .then((capability) => {
        if (!current) return
        setIsMac(capability.platform === 'macos')
        setIsLinux(capability.platform === 'linux')
        setAccelerationAvailable(capability.acceleration !== false)
      })
      .catch(() => undefined)
    return () => { current = false }
  }, [api])
  useEffect(() => {
    if (!systemApi) return
    let active = true
    let revision = 0
    const accept = (state: PlatformSystemState) => {
      if (active) {
        setSystemState(state)
        setSystemError('')
        document.documentElement.dataset.contrast = state.appearance
          .highContrast
          ? 'high'
          : 'normal'
        document.documentElement.classList.toggle(
          'hc',
          state.appearance.highContrast,
        )
      }
    }
    const unsubscribe = systemApi.onStateChanged((state) => {
      revision++
      accept(state)
    })
    void systemApi
      .getState()
      .then((state) => {
        if (revision === 0) accept(state)
      })
      .catch((error) => {
        if (active) setSystemError(errorMessage(error))
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [systemApi, systemAttempt])
  // 做成了的结果改成会自己消失的小提示，页面不再往下跳；没做成的照旧在页顶出红条。
  const toasted = (text: string) => () => {
    showToast(text, 'ok')
    return null
  }
  // 「连接方式」点「查看」：查到的那一句用小提示说，不在这一行里多占一行字。
  const readProxy = () => {
    if (systemApi)
      void operation.execute(
        'proxy',
        () => systemApi.getProxyStatus(),
        (status) => `当前：${proxySummaryText(status.summary)}`,
      )
  }
  const [group, setGroup] = useState<SettingsGroupId>('appearance')
  // 左栏「搜索设置」里输的字；有字时右边换成搜到的那几行，可以直接在那儿改。
  const [search, setSearch] = useState('')
  // 从检查页「去处理」跳进来时直接落在要去的那一组。放在副作用里取，严格模式下
  // 初始化函数会跑两遍，第二遍会把已经取走的那一组读成空的。
  useEffect(() => {
    const requested = takeSettingsGroup()
    if (requested) setGroup(requested)
  }, [])
  const pageRef = useRef<HTMLElement>(null)
  // 顶部搜索搜到某一项：打开那一组以后翻到那一行、亮一下。
  useRowFocus('settings', pageRef, Boolean(resource.data))
  const [pending, setPending] = useState(0)
  const pendingRef = useRef(0)
  pendingRef.current = pending
  // 关闭询问框里勾了「记住我的选择」是主进程直接写的设置。窗口缩到托盘再点开时，
  // 这一页可能还开着旧的「每次询问」，想改回来点它也没反应，所以回到窗口时重读这一项。
  useEffect(() => {
    function refreshCloseBehavior() {
      if (document.visibilityState !== 'visible') return
      void api
        .getSettings()
        .then((latest) => {
          if (pendingRef.current > 0) return
          resource.setData((previous) =>
            previous &&
            previous.settings.closeBehavior !== latest.closeBehavior
              ? {
                  ...previous,
                  settings: {
                    ...previous.settings,
                    closeBehavior: latest.closeBehavior,
                  },
                }
              : previous,
          )
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', refreshCloseBehavior)
    document.addEventListener('visibilitychange', refreshCloseBehavior)
    return () => {
      window.removeEventListener('focus', refreshCloseBehavior)
      document.removeEventListener('visibilitychange', refreshCloseBehavior)
    }
  }, [api, resource.setData])
  const [saveError, setSaveError] = useState('')
  const [legal, setLegal] = useState<Awaited<
    ReturnType<V2Bridge['getLegalDocument']>
  > | null>(null)
  const [shortcuts, setShortcuts] = useState(false)
  // 显示方式要重开软件才生效：改完就在这一行下面给「现在重开」「稍后」。
  const [displayRelaunch, setDisplayRelaunch] = useState(false)
  const onSaved = useRef((settings: AppSettings) => {
    resource.setData((previous) =>
      previous ? { ...previous, settings } : previous,
    )
    onSettingsChanged?.(settings)
  })
  onSaved.current = (settings) => {
    resource.setData((previous) =>
      previous ? { ...previous, settings } : previous,
    )
    onSettingsChanged?.(settings)
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.reducedMotion = String(
      Boolean(settings.reducedMotion),
    )
    document.documentElement.dataset.largeText = String(
      Boolean(settings.largeText),
    )
  }
  const writer = useMemo(
    () =>
      createSettingsQueue(
        (patch) => api.saveSettings(patch),
        (settings) => onSaved.current(settings),
      ),
    [api],
  )
  // quiet：导入时设置只是其中一半，存好了由导入那句一起说，不另弹「已保存」。
  const update = async (patch: Omit<SettingsUpdate, 'version'>, options?: { quiet?: boolean }) => {
    setPending((value) => value + 1)
    setSaveError('')
    try {
      await writer({ version: 2, ...patch })
      if (!options?.quiet) showToast('已保存', 'ok')
      return true
    } catch (error) {
      setSaveError(errorMessage(error))
      return false
    } finally {
      setPending((value) => value - 1)
    }
  }
  // 「搬到新电脑」导入：先整份校验，再在这台电脑上改过的设置要被换掉时问一句。
  const [importAsk, setImportAsk] = useState<{
    preview: DataTransferImportPreview
    conversations: Conversation[]
  } | null>(null)
  // 对话先导入：它更可能出错，出错时设置还没动。
  const applyImport = async (
    preview: DataTransferImportPreview,
    conversations: Conversation[],
    overwrite: boolean,
  ) => {
    const added = chatTransfer
      ? await chatTransfer.importConversations(conversations)
      : 0
    const patch = overwrite
      ? settingsPatchFrom(preview.settings, preview.conflictingSettings)
      : settingsPatchFrom(preview.settings)
    if (patch && !(await update(patch, { quiet: true }))) {
      throw new Error(
        added
          ? `导入了 ${added} 个对话，设置没有保存成功，可以再点一次「导入」`
          : '设置没有保存成功，可以再点一次「导入」',
      )
    }
    return dataTransferImportMessage({
      fileConversations: conversations.length,
      added,
      signedIn: Boolean(chatTransfer),
      settingsChanged: Boolean(patch),
    })
  }
  const importDone = (message: string | null) => {
    if (message) showToast(message, 'ok')
    return null
  }
  const startImport = () =>
    void operation.execute(
      'transfer-import',
      async () => {
        const preview = await api.importAppData()
        if (!preview) return null
        const conversations = parseImportedConversations(preview.conversations)
        if (preview.conflictLabels.length) {
          setImportAsk({ preview, conversations })
          return null
        }
        return applyImport(preview, conversations, false)
      },
      importDone,
    )
  const finishImport = (overwrite: boolean) => {
    const ask = importAsk
    setImportAsk(null)
    if (!ask) return
    void operation.execute(
      'transfer-import',
      () => applyImport(ask.preview, ask.conversations, overwrite),
      importDone,
    )
  }
  // 导出的结果带「打开所在位置」，要给人点，照旧留在页顶。
  const startExport = () =>
    void operation.execute(
      'transfer-export',
      async () =>
        api.exportAppData({
          conversations: chatTransfer
            ? await chatTransfer.exportConversations()
            : [],
        }),
      (result) =>
        result
          ? {
              text: dataTransferExportMessage(result),
              revealPath: result.outputPath,
            }
          : null,
    )
  const settings = resource.data?.settings
  // 行标题从注册表取（settingsItems），顶部搜索、页内搜索和这里说的是同一个名字。
  const row = (
    id: string,
    description: ReactNode,
    control: ReactNode,
    extra?: { badge?: ReactNode; wide?: boolean; testId?: string },
  ) => (
    <SettingRow
      key={id}
      anchor={id}
      title={settingsItemLabel(id)}
      description={description}
      control={control}
      badge={extra?.badge}
      wide={extra?.wide}
      testId={extra?.testId}
    />
  )
  // 要先读一次系统状态的那几项：读的那一下照常画开关、灰着点不了，不写字；没读到写
  // 「暂未读到」，页顶红条给「重新读取」；只有这台电脑真的没有这一项，才写「此版本暂不支持」。
  const systemPending = (label: string) =>
    !systemApi ? (
      <Pill tone="neutral">此版本暂不支持</Pill>
    ) : systemError ? (
      <Pill tone="neutral">暂未读到</Pill>
    ) : (
      <Switch
        checked={false}
        disabled
        aria-label={label}
        onChange={() => undefined}
      />
    )
  const relaunch = () =>
    void operation.execute(
      'relaunch',
      () => api.relaunchApp(),
      (started) => {
        if (!started) showToast('已取消重开', 'neutral')
        return null
      },
    )
  // 恢复默认外观：主题回到跟随系统、关掉高对比度，缩放、大字、减少动画回到装好时的样子。
  // 显卡加速不算外观，改了要重开软件，这里不动它。
  const restoreAppearance = () =>
    void operation.execute(
      'restore-appearance',
      async () => {
        if (systemApi) {
          setSystemState(await systemApi.setThemePreference('system'))
          setSystemState(await systemApi.setHighContrast(false))
        }
        return update(
          {
            uiScale: 'auto',
            largeText: false,
            reducedMotion: false,
            ...(systemApi ? {} : { theme: 'light' as const }),
          },
          { quiet: true },
        )
      },
      (saved) => (saved ? '已恢复默认外观' : null),
    )
  // 每一行按 settingsItems 的 id 放在这里，分组页和页内搜索取的是同一份；这台电脑没有的行不放。
  // 三张卡（批09，原来是三个独立页面）各读各的，不等设置读回来：设置读不到时更新、备份、加速照样有地方点，
  // 托盘、通知、错误框跳过来也不会落空。
  const views: Partial<Record<string, ReactNode>> = {
    // 原来的游戏加速页；没有加速的电脑（Linux）没有这张卡。
    acceleration: accelerationAvailable && accelerationCard ? accelerationCard(active !== false) : undefined,
    // 原来的备份页：切到这一组时新挂上、读一次；设置页从别的页回来时再读一次。
    backups: (
      <BackupCard
        key="backups"
        api={api}
        active={active}
        navigate={navigate}
        onRestored={onBackupRestored}
        installedProviders={installedProviders}
      />
    ),
    // 原来的更新页。两个开关不在卡上再摆一份，就是下面那两行。
    version: (
      <VersionCard
        key="version"
        api={api}
        navigate={navigate}
        autoUpdate={(settings ?? appSettings)?.autoUpdate !== false}
      />
    ),
  }
  if (settings) {
    const themeOptions: Array<{ value: ThemeCardValue; disabled?: boolean }> = [
      { value: 'light' },
      { value: 'dark' },
    ]
    if (systemApi) themeOptions.unshift({ value: 'system', disabled: !systemState })
    const notificationsOff = settings.desktopNotifications === false
    Object.assign(views, {
      theme: row(
        'theme',
        null,
        <ThemeCards
          testId="settings-theme"
          options={themeOptions}
          value={systemState?.preferences.themePreference ?? settings.theme}
          onChange={(theme) => {
            if (systemApi)
              void operation.execute(
                'platform-theme',
                async () =>
                  setSystemState(await systemApi.setThemePreference(theme)),
                toasted('主题偏好已保存'),
              )
            else if (theme !== 'system') void update({ theme })
          }}
        />,
        { wide: true },
      ),
      'ui-scale': row(
        'ui-scale',
        null,
        <Segment
          options={[
            { value: 'auto', label: '自动' },
            { value: '90', label: '90%' },
            { value: '100', label: '100%' },
            { value: '110', label: '110%' },
          ]}
          value={settings.uiScale ?? 'auto'}
          onChange={(uiScale) => {
            if (
              uiScale === 'auto' ||
              uiScale === '90' ||
              uiScale === '100' ||
              uiScale === '110'
            )
              void update({ uiScale })
          }}
        />,
      ),
      'large-text': row(
        'large-text',
        '把说明文字和小字放大一号',
        <Switch
          checked={Boolean(settings.largeText)}
          onChange={(largeText) => void update({ largeText })}
          aria-label="大字"
          testId="settings-large-text"
        />,
      ),
      language: row(
        'language',
        null,
        <span className="v2-settings-value">简体中文</span>,
      ),
      'high-contrast': row(
        'high-contrast',
        systemState?.appearance.systemHighContrast
          ? '系统高对比度已开启；手动偏好会单独保留'
          : null,
        systemApi && systemState ? (
          <Switch
            aria-label="高对比度"
            checked={systemState.preferences.highContrast}
            disabled={Boolean(operation.busy)}
            onChange={(enabled) =>
              void operation.execute(
                'contrast',
                async () =>
                  setSystemState(await systemApi.setHighContrast(enabled)),
                toasted('高对比度偏好已保存'),
              )
            }
          />
        ) : (
          systemPending('高对比度')
        ),
      ),
      'reduced-motion': row(
        'reduced-motion',
        null,
        <Switch
          checked={Boolean(settings.reducedMotion)}
          onChange={(reducedMotion) => void update({ reducedMotion })}
          aria-label="减少动画"
        />,
      ),
      'hardware-acceleration': (
        <Fragment key="hardware-acceleration">
          {row(
            'hardware-acceleration',
            resource.data?.capabilities.displayCompat === 'auto'
              ? '显卡驱动刚才接连出了几次问题，这次已临时改用兼容方式显示。界面出现黑屏、花屏、闪烁或打开就闪退时，关掉它'
              : '界面出现黑屏、花屏、闪烁或打开就闪退时，关掉它',
            <Switch
              checked={settings.hardwareAcceleration !== false}
              onChange={(hardwareAcceleration) =>
                void update({ hardwareAcceleration }).then((saved) => {
                  if (saved) setDisplayRelaunch(true)
                })
              }
              aria-label="用显卡加速显示"
              testId="settings-hardware-acceleration"
            />,
            { badge: '重启后生效' },
          )}
          {displayRelaunch && (
            <Notice
              tone="neutral"
              title="显示方式已改好"
              body="重启软件后生效。"
              testId="settings-display-relaunch"
              actions={
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    testId="settings-display-relaunch-now"
                    disabled={Boolean(operation.busy)}
                    onClick={relaunch}
                  >
                    现在重开
                  </Button>
                  <Button
                    size="sm"
                    testId="settings-display-relaunch-later"
                    onClick={() => setDisplayRelaunch(false)}
                  >
                    稍后
                  </Button>
                </>
              }
            />
          )}
        </Fragment>
      ),
      'restore-appearance': row(
        'restore-appearance',
        null,
        <Button
          size="sm"
          variant="ghost"
          icon={RotateCcw}
          disabled={Boolean(operation.busy)}
          loading={operation.busy === 'restore-appearance'}
          onClick={restoreAppearance}
          testId="settings-restore-appearance"
        >
          恢复默认
        </Button>,
      ),
      'launch-at-login': row(
        'launch-at-login',
        systemState?.startup.note ?? '开机后在托盘里待命，不弹窗口',
        systemApi && systemState?.startup.supported ? (
          <Switch
            aria-label="开机自动启动"
            checked={systemState.startup.requested}
            disabled={Boolean(operation.busy)}
            onChange={(enabled) =>
              void operation.execute(
                'startup',
                async () =>
                  setSystemState(await systemApi.setStartup(enabled)),
                '',
              )
            }
          />
        ) : systemState ? (
          <Pill tone="neutral">此版本暂不支持</Pill>
        ) : (
          systemPending('开机自动启动')
        ),
      ),
      'close-behavior': row(
        'close-behavior',
        // Linux 的任务栏不一定有放托盘图标的地方（主进程先问过），没有就只能退出。
        // 没有游戏加速的电脑（Linux）不说加速。
        isLinux && resource.data && !resource.data.capabilities.tray
          ? '这台电脑的任务栏上没有放星芒图标的地方，点关闭会直接退出软件'
          : accelerationAvailable
            ? '缩到托盘后，加速和正在进行的安装会继续在后台运行'
            : '缩到托盘后，正在进行的安装会继续在后台运行',
        <Segment
          options={[
            { value: 'ask', label: '每次询问' },
            {
              value: 'tray',
              label: '缩到托盘',
              disabled: !resource.data?.capabilities.tray,
            },
            { value: 'quit', label: '直接退出' },
          ]}
          value={settings.closeBehavior ?? 'ask'}
          onChange={(closeBehavior) => {
            if (
              closeBehavior === 'ask' ||
              closeBehavior === 'tray' ||
              closeBehavior === 'quit'
            )
              void update({ closeBehavior })
          }}
        />,
      ),
      'startup-diagnostics': row(
        'startup-diagnostics',
        null,
        <Switch
          checked={settings.runDiagnosticsOnStartup}
          aria-label="启动时检查环境"
          onChange={(runDiagnosticsOnStartup) =>
            void update({ runDiagnosticsOnStartup })
          }
        />,
      ),
      workspace: row(
        'workspace',
        '工具会读写里面的文件，请选你信任的文件夹',
        <div className="v2-business-control">
          <span className="v2-business-path">{settings.workspace}</span>
          <Button
            size="sm"
            icon={FolderOpen}
            onClick={() =>
              void operation.execute(
                'workspace',
                async () => {
                  const workspace = await api.chooseWorkspace()
                  if (workspace) await update({ workspace })
                },
                '',
              )
            }
          >
            更换
          </Button>
        </div>,
      ),
      'latest-cli': row(
        'latest-cli',
        '默认装星芒验证过的推荐版本；打开后跟随官方最新版，可能遇到还没验证过的问题',
        <Switch
          checked={settings.alwaysInstallLatestCli === true}
          aria-label="命令行工具总是装最新版"
          onChange={(alwaysInstallLatestCli) =>
            void update({ alwaysInstallLatestCli })
          }
        />,
      ),
      'install-location': row(
        'install-location',
        null,
        <span className="v2-settings-value">跟随系统</span>,
      ),
      // 不写死 Windows Terminal：没装它的 Windows 会退回别的窗口。
      terminal: row(
        'terminal',
        null,
        <span className="v2-settings-value">{isMac ? '终端' : '系统默认'}</span>,
      ),
      ...Object.fromEntries(
        connectionRouteSettings.map((route) => [
          route.id,
          <RelayRouteRow
            key={route.id}
            route={route}
            settings={settings}
            disabled={pending > 0 || Boolean(operation.busy)}
            onChange={(patch) => void update(patch)}
          />,
        ]),
      ),
      'tool-route-restart-hints': row(
        'tool-route-restart-hints',
        '连接线路因为连不上换了以后，开着的工具要重开才会走新线路。关掉以后只在首页标「需重开生效」。',
        <Switch
          checked={settings.toolRouteRestartHints !== false}
          aria-label="换线路后提醒我重开工具"
          testId="settings-tool-route-restart-hints"
          onChange={(toolRouteRestartHints) =>
            void update({ toolRouteRestartHints })
          }
        />,
      ),
      mirror: row(
        'mirror',
        '下载失败时可以换一个再试',
        <Segment
          options={[
            { value: 'auto', label: '自动判断' },
            { value: 'mirror-first', label: '国内镜像' },
            { value: 'official-first', label: '官方源' },
          ]}
          value={settings.mirrorPolicy ?? 'auto'}
          onChange={(mirrorPolicy) => {
            if (
              mirrorPolicy === 'auto' ||
              mirrorPolicy === 'mirror-first' ||
              mirrorPolicy === 'official-first'
            )
              void update({ mirrorPolicy })
          }}
        />,
      ),
      proxy: row(
        'proxy',
        null,
        systemApi ? (
          <Button
            size="sm"
            icon={RefreshCw}
            loading={operation.busy === 'proxy'}
            onClick={readProxy}
          >
            查看
          </Button>
        ) : (
          <Pill tone="neutral">此版本暂不支持</Pill>
        ),
      ),
      'network-check': row(
        'network-check',
        null,
        <Button
          size="sm"
          icon={HeartPulse}
          onClick={() => navigate?.('health', networkDiagnosticCode)}
          testId="settings-network-health"
        >
          去检查
        </Button>,
      ),
      certificate: row(
        'certificate',
        '公司网络要求装证书才能上网、装工具报证书错误时，到检查页看「安全证书」那一项',
        <Button
          size="sm"
          icon={HeartPulse}
          onClick={() => navigate?.('health', certificateDiagnosticCode)}
          testId="settings-certificate-health"
        >
          去检查
        </Button>,
      ),
      // 「发测试通知」并进了桌面通知这一行：总开关关着时发不出去，按钮跟着灰。
      'desktop-notifications': row(
        'desktop-notifications',
        '新版本下载好的提醒也归它管',
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={Zap}
            disabled={
              !systemApi ||
              notificationsOff ||
              !resource.data?.capabilities.notifications
            }
            loading={operation.busy === 'test-notification'}
            onClick={() =>
              systemApi &&
              void operation.execute(
                'test-notification',
                async () => {
                  const result = await systemApi.testNotification()
                  if (result === 'disabled')
                    throw new Error('请先开启桌面通知。')
                  if (result === 'unsupported')
                    throw new Error('这台电脑当前无法显示系统通知。')
                },
                toasted('已发送一条测试通知'),
              )
            }
          >
            发测试通知
          </Button>
          <Switch
            checked={!notificationsOff}
            disabled={!resource.data?.capabilities.notifications}
            aria-label="桌面通知"
            onChange={(desktopNotifications) =>
              void update({ desktopNotifications })
            }
          />
        </>,
      ),
      ...Object.fromEntries(
        notificationOptions
          .filter((option) => option.value !== 'acceleration' || accelerationAvailable)
          .map((option) => [
            notificationSettingsItemId(option.value),
            row(
              notificationSettingsItemId(option.value),
              option.description,
              systemApi && systemState ? (
                <Switch
                  aria-label={`${option.label}通知`}
                  checked={
                    systemState.preferences.notifications?.[option.value] ??
                    true
                  }
                  disabled={notificationsOff || Boolean(operation.busy)}
                  onChange={(enabled) =>
                    void operation.execute(
                      'notification-preference',
                      async () =>
                        setSystemState(
                          await systemApi.setNotificationPreference(
                            option.value,
                            enabled,
                          ),
                        ),
                      toasted('通知偏好已保存'),
                    )
                  }
                />
              ) : (
                systemPending(`${option.label}通知`)
              ),
            ),
          ]),
      ),
      // 没登录时聊天记录带不走（按账号分开存），标题只说「导出设置」。
      transfer: (
        <SettingRow
          key="transfer"
          anchor="transfer"
          title={chatTransfer ? settingsItemLabel('transfer') : '导出设置'}
          description={chatTransfer ? '文件里没有密码和密钥，在新电脑上登录一下就行' : '登录后再导出，会连聊天记录一起带上'}
          control={
            <Button
              size="sm"
              icon={Download}
              disabled={Boolean(operation.busy)}
              onClick={startExport}
              testId="settings-transfer-export"
            >
              导出
            </Button>
          }
        />
      ),
      'transfer-import': row(
        'transfer-import',
        null,
        <Button
          size="sm"
          icon={FolderOpen}
          disabled={Boolean(operation.busy)}
          onClick={startImport}
          testId="settings-transfer-import"
        >
          导入
        </Button>,
      ),
      'crash-reporting': row(
        'crash-reporting',
        '出错时把错误信息、版本和系统信息发到海外的错误收集服务；不含账号、密钥、文件路径和对话内容',
        <Switch
          aria-label="崩溃自动上报"
          checked={settings.crashReporting !== false}
          onChange={(enabled) => void update({ crashReporting: enabled })}
        />,
      ),
      'usage-stats': row(
        'usage-stats',
        '只记下你的选择；目前软件不会收集或上传使用记录',
        systemApi && systemState ? (
          <Switch
            aria-label="匿名使用统计偏好"
            checked={systemState.preferences.privacy?.anonymousUsage ?? false}
            disabled={Boolean(operation.busy)}
            onChange={(enabled) =>
              void operation.execute(
                'privacy',
                async () =>
                  setSystemState(
                    await systemApi.setPrivacyPreference(
                      'anonymousUsage',
                      enabled,
                    ),
                  ),
                toasted('偏好已保存在本机，没有上传使用记录'),
              )
            }
          />
        ) : (
          systemPending('匿名使用统计偏好')
        ),
      ),
      logs: row(
        'logs',
        null,
        <>
          <Button
            size="sm"
            icon={FolderOpen}
            onClick={() =>
              void operation.execute(
                'directory',
                () => api.openRuntimeLogDirectory(),
                '',
              )
            }
          >
            打开日志文件夹
          </Button>
          <Button
            size="sm"
            icon={FileText}
            onClick={() => navigate?.('feedback', 'log')}
          >
            去反馈
          </Button>
        </>,
      ),
      legal: row(
        'legal',
        null,
        <>
          <Button
            size="sm"
            onClick={() =>
              void operation.execute(
                'legal',
                async () =>
                  setLegal(await api.getLegalDocument('user-agreement')),
                '',
              )
            }
          >
            用户协议
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void operation.execute(
                'legal',
                async () =>
                  setLegal(await api.getLegalDocument('privacy-policy')),
                '',
              )
            }
          >
            隐私政策
          </Button>
        </>,
      ),
      'update-check': row(
        'update-check',
        null,
        <Switch
          checked={settings.checkUpdatesOnStartup}
          aria-label="启动时检查新版本"
          onChange={(checkUpdatesOnStartup) =>
            void update({ checkUpdatesOnStartup })
          }
        />,
        { testId: 'updates-check-on-startup' },
      ),
      'auto-update': resource.data?.update?.autoUpdateSupported
        ? row(
            'auto-update',
            autoUpdateSettingDescription(resource.data.update.installMethod, resource.data.update.installNeedsAdminPassword),
            <Switch
              testId="settings-auto-update"
              checked={settings.autoUpdate !== false}
              aria-label="自动下载更新"
              onChange={(autoUpdate) => void update({ autoUpdate })}
            />,
            { testId: 'updates-auto-update' },
          )
        : undefined,
      shortcuts: row(
        'shortcuts',
        null,
        <Button
          size="sm"
          icon={BookOpen}
          onClick={() => setShortcuts(true)}
        >
          查看
        </Button>,
      ),
      guide: (
        <OnboardingGuideRow
          key="guide"
          openGuide={openGuide ?? (() => navigate?.('tutorial'))}
        />
      ),
      tour: replayTour ? <OnboardingTourRow key="tour" replayTour={replayTour} /> : undefined,
      [isMac ? 'uninstall-app' : 'uninstall']: (
        <AppUninstallRow
          key="uninstall"
          api={api}
          isMac={isMac}
          isLinux={isLinux}
        />
      ),
    })
  }
  const shown = (item: SettingsItem) => views[item.id] !== undefined
  const searching = search.trim().length > 0
  // App 要知道人是不是就在「版本更新」：在的话更新气泡不再说版本卡上写着的同一件事。
  useEffect(() => { onSettingsGroupChange?.(searching ? null : group) }, [group, searching, onSettingsGroupChange])
  // 整张卡的那几项（游戏加速、工具配置备份、版本卡）单独摆，外面包一层带 data-anchor 的，顶部搜索翻得过去。
  const cardSlot = (item: SettingsItem) => (
    <div key={item.id} className="v2-settings-card-slot" data-anchor={item.id}>{views[item.id]}</div>
  )
  const hits = settings && searching ? searchSettingsItems(search).filter(shown) : []
  // 小标题右边的那句、卡片上面的那条：桌面通知关着时提醒项都不会响；线路存好了要重开才用上。
  const sectionNotes: Partial<Record<SettingsSectionId, ReactNode>> = {
    reminders: settings?.desktopNotifications === false ? '桌面通知关着，下面这些都不会提醒' : undefined,
  }
  const sectionLeads: Partial<Record<SettingsSectionId, ReactNode>> = settings
    ? {
        routes: (
          <RelayRouteRestartNotice
            settings={settings}
            disabled={pending > 0 || Boolean(operation.busy)}
            onRestart={relaunch}
          />
        ),
      }
    : {}
  function openGroup(value: SettingsGroupId) {
    setSearch('')
    setGroup(value)
  }
  let content: ReactNode = (
    <Card padding="none">
      <p role="status">{resource.error ? '设置暂时没有读到' : '正在读取设置…'}</p>
    </Card>
  )
  if (settings && searching) {
    // 搜出来的行就地能改，小标题那一句和卡片上面那条也得跟着：线路改完要在这儿就能「现在重开」，
    // 桌面通知关着时提醒项为什么是灰的也要说。同一个小标题下搜出好几行时只在第一行上面放一次。
    const shownSections = new Set<SettingsSectionId>()
    const groupLink = (item: SettingsItem) => (
      <button type="button" className="v2-link-button" onClick={() => openGroup(item.group)}>
        {settingsGroups.find((entry) => entry.value === item.group)?.label}
      </button>
    )
    const hit = (item: SettingsItem) => {
      const section = item.section && !shownSections.has(item.section) ? item.section : undefined
      if (section) shownSections.add(section)
      const note = section ? sectionNotes[section] : undefined
      const lead = section ? sectionLeads[section] : undefined
      return (
        <Fragment key={item.id}>
          <div className="v2-settings-hit">
            {groupLink(item)}
            {note && <span>{note}</span>}
          </div>
          {lead && <div className="v2-settings-hit-lead">{lead}</div>}
          {views[item.id]}
        </Fragment>
      )
    }
    // 挨着的几行照旧装进同一张卡；整张卡的那一项自己摆，组名写在卡上面。
    const segments: SettingsItem[][] = []
    for (const item of hits) {
      const last = segments[segments.length - 1]
      if (last && !item.card && !last[0].card) last.push(item)
      else segments.push([item])
    }
    content = hits.length ? (
      <div className="v2-settings-results" data-testid="settings-search-results">
        {segments.map((segment) =>
          segment[0].card ? (
            <section key={segment[0].id} className="v2-settings-block">
              <div className="v2-settings-section">{groupLink(segment[0])}</div>
              {cardSlot(segment[0])}
            </section>
          ) : (
            <Card key={segment[0].id} padding="none">{segment.map(hit)}</Card>
          ),
        )}
      </div>
    ) : (
      <div className="v2-settings-empty" data-testid="settings-search-empty">
        <h3>没有找到相关设置</h3>
        <p>换个说法试试，比如「托盘」「镜像」「快捷键」。</p>
      </div>
    )
  } else if (settings || resource.error) {
    // 设置没读到时只摆这一组里的那张卡（如果有），上面照旧写「设置暂时没有读到」、给「重新读取」。
    const blocks = buildSettingsBlocks(group, settingsItems.filter((item) => shown(item) && (Boolean(settings) || item.card === true)))
    const groupContent = blocks.map((block, index) => (
      <section key={block.section?.value ?? `rows-${index}`} className="v2-settings-block">
        {block.section && (
          <div
            className="v2-settings-section"
            data-testid={block.section.value === 'reminders' ? 'settings-notification-kinds' : undefined}
          >
            <h3>{block.section.label}</h3>
            {sectionNotes[block.section.value] && <span>{sectionNotes[block.section.value]}</span>}
          </div>
        )}
        {block.section && sectionLeads[block.section.value]}
        {block.items[0].card ? cardSlot(block.items[0]) : <Card padding="none">{block.items.map((item) => views[item.id])}</Card>}
      </section>
    ))
    content = settings ? groupContent : <>{content}{groupContent}</>
  }
  // 读不到的是设置本身或系统状态时，红条右边给「重新读取」；保存失败不给，那是另一回事。
  const readFailed = Boolean(resource.error) || (!saveError && Boolean(systemError))
  function reread() {
    if (resource.error) void resource.reload()
    if (systemError) {
      setSystemError('')
      setSystemAttempt((value) => value + 1)
    }
  }
  return (
    <section
      ref={pageRef}
      className="v2-page"
      data-page-id="settings"
      data-testid="page-settings"
    >
      <PageHead title="设置" lead={settingsPageLead} />
      <ResultNotice
        error={resource.error || saveError || systemError || operation.error}
        detail={resource.error ? resource.detail : saveError || systemError ? undefined : operation.detail}
        message={operation.revealPath ? operation.message : undefined}
        revealPath={operation.revealPath || undefined}
        onReveal={(path) => api.revealExportedFile(path)}
        retry={readFailed ? { label: '重新读取', onClick: reread } : undefined}
      />
      <div className="v2-business-settings-grid">
        <div className="v2-settings-side">
          <SearchInput
            value={search}
            onChange={setSearch}
            label="搜索设置"
            placeholder="搜索设置"
            testId="settings-search"
          />
          <nav
            className="v2-business-subnav"
            role="tablist"
            aria-label="设置分组"
            aria-orientation="vertical"
          >
            {settingsGroups.map((item, index) => {
              const Icon = settingsGroupIcons[item.value]
              const selected = !searching && group === item.value
              // 左栏的点：版本更新有新版本、网络加速正在加速。提示挂在整个组名上，鼠标停哪儿都看得到。
              const dot = item.value === 'about' && updateAvailable
                ? '有新版本'
                : item.value === 'network' && accelerating
                  ? '加速中'
                  : ''
              return (
                <button
                  key={item.value}
                  id={`v2-settings-${item.value}`}
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  aria-controls="v2-settings-panel"
                  tabIndex={group === item.value ? 0 : -1}
                  className={selected ? 'is-active' : ''}
                  title={dot || undefined}
                  onClick={() => openGroup(item.value)}
                  onKeyDown={(event) => {
                    let target = index
                    if (event.key === 'ArrowDown')
                      target = (index + 1) % settingsGroups.length
                    else if (event.key === 'ArrowUp')
                      target =
                        (index + settingsGroups.length - 1) % settingsGroups.length
                    else if (event.key === 'Home') target = 0
                    else if (event.key === 'End') target = settingsGroups.length - 1
                    else return
                    event.preventDefault()
                    openGroup(settingsGroups[target].value)
                    document
                      .getElementById(`v2-settings-${settingsGroups[target].value}`)
                      ?.focus()
                  }}
                >
                  <Icon size={15} aria-hidden="true" />
                  <span>{item.label}</span>
                  {dot && <i className={item.value === 'network' ? 'v2-settings-nav-dot is-ok' : 'v2-settings-nav-dot'} aria-hidden="true" />}
                </button>
              )
            })}
          </nav>
        </div>
        <div
          role={searching ? undefined : 'tabpanel'}
          id="v2-settings-panel"
          aria-labelledby={searching ? undefined : `v2-settings-${group}`}
          className="v2-settings-panel"
        >
          {/* 「正在保存更改…」挂在组名右边，不单独占一行，存的时候页面不往下跳。 */}
          <div className="v2-settings-panel-head">
            <h2>{searching ? `搜索「${search.trim()}」` : settingsGroups.find((item) => item.value === group)?.label}</h2>
            {pending > 0 && <span role="status">正在保存更改…</span>}
          </div>
          {settings && searching && <p className="v2-settings-panel-lead">找到 {hits.length} 项，可以直接在这里修改</p>}
          {content}
        </div>
      </div>
      <Dialog
        open={Boolean(importAsk)}
        title="要换成文件里的设置吗？"
        onClose={() => setImportAsk(null)}
        footer={
          <>
            <Button onClick={() => setImportAsk(null)}>取消导入</Button>
            <Button
              onClick={() => finishImport(false)}
              testId="settings-transfer-keep"
            >
              保留这台电脑的
            </Button>
            <Button
              variant="primary"
              onClick={() => finishImport(true)}
              testId="settings-transfer-overwrite"
            >
              换成文件里的
            </Button>
          </>
        }
      >
        <p>
          这台电脑上你已经改过这几项，和文件里的不一样：
          {importAsk?.preview.conflictLabels.join('、')}。
        </p>
        <p>其他设置和聊天记录照常导入，不受这个选择影响。</p>
      </Dialog>
      <Dialog
        open={Boolean(legal)}
        title={legal?.kind === 'privacy-policy' ? '隐私政策' : '用户协议'}
        width={640}
        onClose={() => setLegal(null)}
      >
        <pre className="v2-business-legal">{legal?.markdown}</pre>
      </Dialog>
      <Dialog
        open={shortcuts}
        title="快捷键"
        onClose={() => setShortcuts(false)}
        testId="settings-shortcuts-dialog"
        footer={<Button variant="primary" onClick={() => setShortcuts(false)}>知道了</Button>}
      >
        {shortcutRows(currentWindowOs()).map((entry) => (
          <ListRow key={entry.label} title={entry.label} meta={<kbd className="v2-shortcut-keys">{entry.keys}</kbd>} />
        ))}
      </Dialog>
    </section>
  )
}

export { tutorialTopics } from './registry/tutorials'
export { TutorialPage } from './features/tutorial/TutorialPage'
