import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Archive,
  BookOpen,
  Check,
  Compass,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  HeartPulse,
  KeyRound,
  MoreHorizontal,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import {
  BrandIcon,
  Button,
  Card,
  Confirm,
  Dialog,
  Drawer,
  Input,
  ListRow,
  Menu,
  Notice,
  PageHead,
  Pill,
  Progress,
  SearchInput,
  Segment,
  Select,
  SettingRow,
  Switch,
  Table,
  Textarea,
  Toolbar,
  useToast,
} from './ui'
import {
  displayDate,
  RelativeTime,
  beginBusinessOperation,
  errorMessage,
  failureWithDetail,
  ListState,
  ResultNotice,
  resultNoticeLead,
  type OperationNotice,
  useOperation,
  useReloadWhenShown,
  useResource,
  userFacingErrorMessage,
} from './business-common'
import {
  autoUpdateSettingDescription,
  cliTutorialTopic,
  desktopInstallTutorialTopic,
  macDesktopTutorialTopic,
  macRuntimeTutorialTopic,
  notificationOptions,
  notificationSettingsItemId,
  settingsGroups,
  settingsItemLabel,
  skinOptions,
  standardAccountUpdateNotice,
  updateFailureLabel,
  updateCardTitle,
  updateDiskShortfallText,
  updateDownloadDetail,
  updateInstallActionLabel,
  updateInstallNote,
  updateNewVersion,
  updatesPageLead,
  withdrawnVersionAdvice,
} from './registry/business'
import { appReleaseDownloadUrl } from '../../electron/app-download-page'
import { tools } from './registry/tools'
import { updateDiskCleanupDetail } from './registry/tutorials'
import { clientConnections } from './registry/clients'
import { canUninstallTool, externalInstallHint, updatesOutsideApp } from './features/tools/model'
import { elevatedInstallNotice } from './features/tools/elevation-notice'
import { ToolStatusMeta, toolStatusView } from './features/tools/ToolStatusMeta'
import { installProgressLabel } from './features/tools/install-stage-text'
import type { ToolJob } from './features/tools/useToolbox'
import { connectionCheckView } from './features/tools/connection-check'
import { accountScope, sessionRestoring, signedInSiteId } from './account-context'
import { AppUninstallRow } from './features/app/AppUninstall'
import { RelayRouteSettings } from './features/app/RelayRouteSettings'
import { connectionRouteOptions, connectionRouteSettings } from './registry/connection-routes'
import { createSettingsQueue } from './features/app/settings-queue'
export { createSettingsQueue } from './features/app/settings-queue'
import { diagnosticDetailRows } from './features/app/diagnostic-details'
import { canClearStaleProxy, staleProxyClearMessage, staleProxyConfirmBody } from './features/app/stale-proxy'
import {
  canTrustCertificatesUserWide,
  certificateDiagnosticCode,
  certificateTrustConfirmBody,
  certificateTrustConfirmTitle,
  certificateTrustMessage,
} from './features/app/certificate-trust'
import { diagnosticFolderTarget, diagnosticFolderUnavailableMessage } from './features/app/diagnostic-folder'
import { takeSettingsGroup } from './features/app/settings-group-intent'
import { firstProblemAnchor, useRowFocus } from './features/app/row-focus'
import { diagnosticsRevision, publishDiagnosticsCounts, useDiagnosticsRevision } from './features/app/environment-status'
import { currentWindowOs, type WindowOs } from './features/app/window-os'
import { redownloadUpdate, retryFailedUpdateStep, subscribeUpdateInstallConfirm, takeUpdateInstallConfirm, updateNeedsManualReinstall, updateOffersDownloadPage } from './features/app/update-retry'
import { diagnosticFixConfirm, diagnosticFixKind, diagnosticFixLabel, diagnosticFixLabels, diagnosticFixMessage } from './features/app/diagnostic-fix'
import { parseImportedConversations } from './features/chat/storage'
import type { ChatTransfer } from './features/chat/transfer'
import type { Conversation } from './features/chat/state'
import { dataTransferExportMessage, dataTransferImportMessage, settingsPatchFrom } from './features/app/data-transfer'
import { rememberedLoginAction, rememberedLoginForgottenMessage, sessionOnlyLoginNotice } from './features/app/remembered-login'
import { maintenanceFailureNotice, readMaintenanceStatus } from './features/tools/maintenance-status'
import { ManualUninstallDialog, manualUninstallState, type ManualUninstallState } from './features/tools/ManualUninstall'
import { RuntimeRestartDialog } from './features/tools/RuntimeRestartDialog'
import { NodeReplaceDialog } from './features/tools/NodeReplaceDialog'
import { describeNodeReplaceOutcome, nodeReplaceOffered } from './features/tools/node-replace'
import { uninstallHandOffNotice } from './features/tools/uninstall-handoff'
import { describeRuntimeInstallOutcome } from './features/tools/runtime-install-outcome'
import {
  anyRuntimeLogValue,
  filterRuntimeLogs,
  formatRuntimeLogEntry,
  hasRuntimeLogFilter,
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
} from '../../electron/ipc-contract'
import type {
  PlatformProxyStatus,
  PlatformSystemState,
} from '../../electron/platform/contract'
import { platformApi } from './platform-api'
import type { LoginTarget } from './features/auth/api'

type AppSettings = Awaited<ReturnType<V2Bridge['getSettings']>>
type SettingsUpdate = Parameters<V2Bridge['saveSettings']>[0]
type Update = Awaited<ReturnType<V2Bridge['getUpdateState']>>
type Diagnostic = Awaited<
  ReturnType<V2Bridge['runDiagnostics']>
>['items'][number]
type RuntimeLog = Awaited<
  ReturnType<V2Bridge['getRuntimeLogs']>
>['entries'][number]
type Provider = Parameters<V2Bridge['installCli']>[0]
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
 * declined：客户在开装前的确认框里点了不装（「换成星芒装的」点取消、Codex 桌面端还开着时点「先不更新」），
 * 什么都没动，也不用说什么。
 */
export type ToolInstallOutcome = 'installed' | 'restart' | 'skipped' | 'declined'
export type BusinessActions = {
  /** 第二个参数是要落的分页、分组或那一页里的某一行；缺省 = 只跳页。 */
  navigate?: (page: V2Page, section?: string) => void
  openLogin?: (target?: LoginTarget) => void
  /** 设置「账号」里的「切换账号」：弹出侧栏小 ▾ 那个切换账号框；缺省 = 按钮点不了。 */
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
   * 装完一个工具后由 App 负责的收尾：写账号 Key + 刷新首页的检测结果。页面自己
   * 只刷新自己那一份数据，回到首页仍会看到「未安装」（R-G3）。
   */
  onToolsChanged?: (tool: Provider | 'codexDesktop') => Promise<void> | void
  /**
   * 「安装卸载」页卸掉工具、装好或换了运行环境以后叫一声，由 App 重新检测，首页跟着变；
   * 不叫的话首页还摆着卸掉的工具、还写 Node.js「未安装」。装工具不用它：走 installTool
   * （没接时走 onToolsChanged），装完还要写 Key。页面先叫它、再读本页：本页那次读接上 App
   * 刚起的那一轮检测，不另起一轮。
   * 缺省 = 只刷新本页（旧行为）。
   */
  onSystemChanged?: () => void
  /**
   * 首页那条完整的安装：缺 Node.js / Python 先装运行环境，装完写 Key、刷新检测。
   * 「安装卸载」页以前自己直接调主进程装工具，没装 Node.js 的人只看到「未检测到
   * npm」（全面检测 Q33）；有了它就只走这一条。
   */
  installTool?: (tool: Provider | 'codexDesktop') => Promise<ToolInstallOutcome>
  /** 与 installTool 配对的取消：首页那条安装在准备运行环境时会说明为什么不能取消。 */
  cancelToolInstall?: (tool: Provider | 'codexDesktop') => Promise<InstallCancelResult>
  /**
   * 首页那份正在跑的任务（按工具编号）。「安装卸载」页拿它画「安装中」、进度那句白话和百分比；
   * 在首页点的安装这一页也看得到。缺省 = 只看这一页自己发起的那次。
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
   * App 手里最新的界面缩放（'auto' 表示自动）。在设置页开着时按 Ctrl 加号，设置页那一栏
   * 要跟着变；缺省 = 不同步，只用设置页自己读到的那份（旧行为）。
   */
  uiScale?: NonNullable<AppSettingsV2Update['uiScale']>
  /** 设置页「搬到新电脑」里聊天记录那一半；没登录时没有（聊天记录按账号分开存）。 */
  chatTransfer?: ChatTransfer
  /**
   * App 手里最新的设置。「启动时检查新版本」「自动更新」在设置页、更新页（更新气泡里也有
   * 「自动更新」）各有一个开关，哪边改了另一边要跟着变；缺省 = 只用页面自己读到的那份（旧行为）。
   */
  appSettings?: AppSettings
  /**
   * 外壳告诉页面「现在显示的是你」。去过的页面换走时只藏起来、不卸载（App.tsx 的 visitedPages），
   * 再显示时页面自己重读一次（useReloadWhenShown），和点页头那颗按钮一样；缺省 = 不重读（旧行为）。
   */
  active?: boolean
}
/** 检查结果里「星芒 AI 网络」那一项的代号；设置里「网络检查」的「去检查页」直接翻到这一项。 */
const networkDiagnosticCode = 'XINGMANG_NETWORK'
function isProvider(id: string): id is Provider {
  return ['claude', 'codex', 'gemini', 'grok'].includes(id)
}

/**
 * 「这一步要管理员授权」这句要挂在安装按钮旁边、点之前看得到的位置，也就是行里
 * 那句本来就有的说明后面。文案唯一来源是 features/tools/elevation-notice.ts。
 */
export function withElevationNotice(lead: string, notice: string | null): string {
  return notice ? `${lead} · ${notice}` : lead
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
  // 「安全证书」只有「Node.js 太旧」这一种能在软件里处理：去「安装卸载」换新版。
  // 电脑自己也不认、以管理员身份打开这两种，结论里已经说了怎么办。
  if (code === 'CERTIFICATE_TRUST') return details?.verdict === 'outdatedNode' ? 'maintenance' : null
  // 文件夹被搬过没有能在软件里一键修的地方，下一步是导出报告找客服。
  if (code === 'FOLDER_RELOCATED') return 'feedback'
  // 加速文件坏了：加速页上有「重新检查」和「联系客服」。
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
  if (
    code.startsWith('PROVIDER_') ||
    // Git 的安装指引挂在首页的「运行环境」里，「安装卸载」页没有它那一行。
    code === 'RUNTIME_GIT'
  )
    return 'home'
  if (code.startsWith('RUNTIME_') || code.startsWith('CLI_') || code === 'CODEX_DESKTOP')
    return 'maintenance'
  return null
}

export function diagnosticHasFix(code: string, details?: Diagnostic['details'], accountSiteId: string | null = null): boolean {
  return diagnosticTarget(code, details, accountSiteId) !== null
}

/** 「去处理」落到那一页里的哪一行；缺省 = 只跳页。 */
export function diagnosticSection(code: string, details?: Diagnostic['details'], accountSiteId: string | null = null): string | undefined {
  return code === 'XINGMANG_NETWORK' ? networkRouteSetting(details, accountSiteId) ?? undefined : undefined
}

/** 检查结果按轻重排：待处理在前，然后需留意，正常的在最后；同一档里照原来的次序。 */
export function sortDiagnosticsBySeverity<T extends { state: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => diagnosticRank(left.state) - diagnosticRank(right.state))
}

function diagnosticRank(state: string) {
  return state === 'pass' ? 2 : state === 'warn' ? 1 : 0
}

/** 连接自检的小标：正常 / 有问题 / 没测成；未配置不是故障，照旧写「未配置」、灰色。 */
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

/**
 * 每个工具一行：工具名、状态、一句结论，右边是能就地处理的那颗按钮；原来的第二句（怎么做、
 * 测了什么、服务的原话）收进「查看详情」。未配置的工具是灰的、不是红的：一个只用 Claude Code 的
 * 用户不该在这一页上看到三条失败。
 */
function ConnectionRowItem({
  row,
  navigate,
  canRewriteKey,
  onRewriteKey,
  onDetails,
}: {
  row: ConnectionRow
  navigate?: (page: V2Page, section?: string) => void
  canRewriteKey?: boolean
  onRewriteKey?: (provider: Provider) => void
  onDetails: (row: ConnectionRow) => void
}) {
  const status = connectionRowStatus(row)
  const badge = <Pill tone={status.tone} dot>{status.label}</Pill>
  if (!row.result) {
    return (
      <ListRow
        title={row.name}
        badge={badge}
        desc={row.error ?? '自检没能完成'}
        testId={`health-connection-error-${row.id}`}
      />
    )
  }
  const view = connectionCheckView(row.result, { canRewriteKey: canRewriteKey === true && Boolean(onRewriteKey) })
  const target = view.target
  const section = view.section ?? undefined
  const rewritable = view.action === 'rewrite-key' ? row.provider : null
  return (
    <ListRow
      title={row.name}
      badge={badge}
      desc={view.title}
      actions={
        <>
          {rewritable ? (
            <Button
              size="sm"
              icon={KeyRound}
              onClick={() => onRewriteKey?.(rewritable)}
              testId={`health-connection-rewrite-${row.id}`}
            >
              重新写入 Key
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
            onClick={() => onDetails(row)}
            testId={`health-connection-details-${row.id}`}
          >
            查看详情
          </Button>
        </>
      }
      testId={`health-connection-result-${row.id}`}
    />
  )
}

export function HealthPage({
  api,
  navigate,
  openConfig,
  onRewriteKey,
  rewritableKeys,
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
  const problems = diagnostics.filter((item) => item.state !== 'pass')
  const passing = diagnostics.filter((item) => item.state === 'pass')
  // 正常的项默认收成一行；从别处点名要看的那一项正好是正常的，就先摆出来再翻过去。
  const [showPassing, setShowPassing] = useState(false)
  // 设置里「企业证书」「网络检查」点「去检查页」：检查结果出来以后翻到那一项、亮一下；
  // 开机提示「去看看」不知道是哪一项，翻到第一项问题。去过这一页再点名进来时正在重查，
  // 等新结果出来再翻，不在几个小时前那份上亮。
  useRowFocus('health', pageRef, Boolean(resource.data) && !resource.loading, (anchor) => {
    const code = anchor === firstProblemAnchor ? problems[0]?.code ?? null : anchor
    if (code && passing.some((item) => item.code === code)) setShowPassing(true)
    return code
  })
  const operation = useOperation()
  const [details, setDetails] = useState<Diagnostic | null>(null)
  const [connectionDetailsId, setConnectionDetailsId] = useState<string | null>(null)
  const [proxyClearItem, setProxyClearItem] = useState<Diagnostic | null>(null)
  const [certificateTrustOpen, setCertificateTrustOpen] = useState(false)
  const [fixing, setFixing] = useState<DiagnosticFixKind | null>(null)
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [responsesConsent, setResponsesConsent] = useState(false)
  const [responsesBusy, setResponsesBusy] = useState(false)
  const [responsesResult, setResponsesResult] = useState<Awaited<ReturnType<V2Bridge['probeCodexResponses']>> | null>(null)
  const [responsesError, setResponsesError] = useState<string | null>(null)
  const responsesInFlight = useRef(false)
  const responsesEpoch = useRef(0)
  // 这张卡只对装了 Codex 的人有意义；没读到装没装时先不显示，免得没装的人看到一个点了只会报错的按钮。
  const [codexInstalled, setCodexInstalled] = useState(false)
  const [codexProbe, setCodexProbe] = useState(0)
  useEffect(() => {
    let current = true
    api.scanSystem(false)
      .then((snapshot) => { if (current) setCodexInstalled(snapshot.clis.codex.installed === true) })
      .catch(() => { if (current) setCodexInstalled(false) })
    return () => { current = false }
  }, [api, codexProbe])
  // 从错误框「检查网络」、侧栏回到这一页，看到的该是现在的结果，不是几个小时前那份。
  // 还在查就不再起一轮：探测要起好几个子进程，那一轮本来就是刚起的。
  useReloadWhenShown(active, () => {
    if (!resource.loading) void resource.reload()
    setCodexProbe((value) => value + 1)
  })
  // 这一页开着的时候环境变了（首页那边装完了；在这一页点「去处理」改好了设置、重新写了 Key），
  // 状态栏已经退回「环境待检测」。这一页就是看检查结果的地方，跟着重查一次，两处说的才一样（已知6）。
  // 还在查就等这一轮查完再查：它开跑时环境还没改。
  const revision = useDiagnosticsRevision()
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
      await operation.execute('重新写入 Key', async () => {
        // 登录掉了的时候 App 打开的是登录框，什么都没写，这里就不该说写好了。
        const written = await onRewriteKey(provider)
        if (written) await loadConnections()
        return written
      }, (written) => written ? '已按当前账号重新写入 Key，并重新测了一次连接' : null)
    } finally {
      setConnectionBusy(false)
    }
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
  // 写好之后重新检查一遍，那一行的按钮就没了；结果那句话留在页头。
  const trustCertificatesUserWide = async () => {
    await operation.execute('让所有终端信任证书', async () => {
      const result = await api.trustCertificatesUserWide()
      setCertificateTrustOpen(false)
      void resource.reload()
      return result
    }, certificateTrustMessage)
    setCertificateTrustOpen(false)
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
  const responsesView = responsesResult ? connectionCheckView(responsesResult) : null
  const connectionDetails = connections?.find((row) => row.id === connectionDetailsId) ?? null
  const connectionDetailsView = connectionDetails?.result
    ? connectionCheckView(connectionDetails.result, {
        canRewriteKey: connectionDetails.provider !== null && rewritableKeys?.includes(connectionDetails.provider) === true && Boolean(onRewriteKey),
      })
    : null
  const exportReport = () =>
    void operation.execute(
      'export',
      () => api.exportDiagnostics(),
      (result) =>
        result
          ? {
              text: `诊断报告已导出：${result.outputPath}`,
              revealPath: result.outputPath,
            }
          : null,
    )
  const diagnosticRow = (item: Diagnostic) => (
    <ListRow
      key={item.code}
      anchor={item.code}
      icon={item.state === 'pass' ? Check : HeartPulse}
      title={item.title}
      badge={
        <Pill
          tone={
            item.state === 'pass'
              ? 'ok'
              : item.state === 'warn'
                ? 'warn'
                : 'bad'
          }
          dot
        >
          {item.state === 'pass'
            ? '正常'
            : item.state === 'warn'
              ? '需留意'
              : '待处理'}
        </Pill>
      }
      desc={item.summary}
      actions={
        <>
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
          {canTrustCertificatesUserWide(item) && (
            <Button
              size="sm"
              icon={ShieldCheck}
              onClick={() => setCertificateTrustOpen(true)}
              testId="health-trust-certificates"
            >
              让这台电脑上所有终端都信任
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
          {item.state !== 'pass' && diagnosticHasFix(item.code, item.details, accountSiteId) && (
            <Button
              size="sm"
              icon={Wrench}
              onClick={() => fix(item)}
              testId={`health-fix-${item.code}`}
            >
              去处理
            </Button>
          )}
          <Menu
            label={`${item.title} 的更多操作`}
            anchor={<MoreHorizontal size={18} />}
            items={[
              {
                label: '查看详情',
                icon: FileText,
                onSelect: () => setDetails(item),
              },
            ]}
          />
        </>
      }
      testId={`health-row-${item.code}`}
    />
  )
  return (
    <section
      ref={pageRef}
      className="v2-page"
      data-page-id="health"
      data-testid="page-health"
    >
      <PageHead
        title="检查"
        lead="逐项检查当前工具和连接；没有使用的可选环境可以先不装。"
        actions={
          <>
            <Button
              icon={Download}
              disabled={resource.loading}
              onClick={exportReport}
            >
              导出检查报告
            </Button>
            <Button
              variant="primary"
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
      {resource.data && (
        <Toolbar
          left={
            <>
              <Pill tone="bad">
                待处理 {resource.data.counts.fail + resource.data.counts.error}
              </Pill>
              <Pill tone="warn">需留意 {resource.data.counts.warn}</Pill>
              <Pill tone="ok">正常 {resource.data.counts.pass}</Pill>
            </>
          }
          right={<span>上次检查 <RelativeTime value={resource.data.generatedAt} /></span>}
        />
      )}
      <Card padding="none">
        <ListState
          page="health"
          noun="检查结果"
          emptyDescription="点右上角「重新检查」。"
          loading={resource.loading}
          error={resource.error}
          count={diagnostics.length}
          retry={() => void resource.reload()}
        >
          {problems.map(diagnosticRow)}
          {passing.length > 0 && (
            <ListRow
              icon={Check}
              title={problems.length ? `另外 ${passing.length} 项正常` : `全部 ${passing.length} 项正常`}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={showPassing}
                  onClick={() => setShowPassing((value) => !value)}
                  testId="health-passing-toggle"
                >
                  {showPassing ? '收起' : '展开'}
                </Button>
              }
              testId="health-passing"
            />
          )}
          {showPassing && passing.map(diagnosticRow)}
        </ListState>
      </Card>
      <Card
        title="连接自检"
        meta="用每个工具配置里真正写着的密钥和模型各测一次；装好的外部客户端也一起测。上面的检查只证明网络通，这一条证明你现在能用。"
        actions={
          <Button
            icon={PlugZap}
            loading={connectionBusy}
            onClick={() => void runConnectionCheck()}
            testId="health-connection-run"
          >
            测试连接
          </Button>
        }
        testId="health-connection"
      >
        {connections && sortConnectionRows(connections).map((row) => (
          <ConnectionRowItem
            key={row.id}
            row={row}
            navigate={navigate}
            canRewriteKey={row.provider !== null && rewritableKeys?.includes(row.provider)}
            onRewriteKey={onRewriteKey ? (provider) => void rewriteKey(provider) : undefined}
            onDetails={(entry) => setConnectionDetailsId(entry.id)}
          />
        ))}
        {!connections && (
          <p className="v2-connection-note" data-testid="health-connection-idle">
            还没有测过。点「测试连接」，会按工具分别给结论；失败时会直接说是网络、密钥、额度、分组还是模型的问题。装好的 WorkBuddy、Claude Desktop、OpenCode 也会各测一条。
          </p>
        )}
      </Card>
      {codexInstalled && <Card
        title="Codex 干活检查"
        meta="上面的连接自检只确认能连上。这里让 Codex 用的模型真的做一件小事：调用一个什么都不改的测试工具，再把结果读回来。会用当前账号的额度发两次请求，花费很少，但不是零；不会碰你电脑上的文件。"
        testId="health-codex-responses"
      >
        <div className="v2-health-consent">
          <Switch
            checked={responsesConsent}
            onChange={setResponsesConsent}
            label="我知道这次检查会用当前账号的一点额度"
            description="每次检查前都要重新勾选。"
            disabled={responsesBusy}
            testId="health-codex-responses-consent"
          />
          <Button
            icon={PlugZap}
            disabled={!responsesConsent || responsesBusy}
            loading={responsesBusy}
            onClick={() => void runCodexResponsesProbe()}
            testId="health-codex-responses-run"
          >
            开始检查
          </Button>
        </div>
        {responsesView && (
          <Notice
            tone={responsesView.tone}
            title={`Codex 干活检查 · ${responsesView.statusLabel}`}
            body={<><div>{responsesView.title}</div><div>{responsesView.body}</div>{responsesView.detail && <p>{responsesView.detail}</p>}</>}
            testId="health-codex-responses-result"
          />
        )}
        {responsesError && <Notice tone="bad" title="Codex 干活检查 · 没测成" body={responsesError} testId="health-codex-responses-error" />}
      </Card>}
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
      <Confirm
        open={certificateTrustOpen}
        title={certificateTrustConfirmTitle}
        body={certificateTrustConfirmBody}
        okLabel="信任"
        loading={operation.busy === '让所有终端信任证书'}
        onOk={() => void trustCertificatesUserWide()}
        onClose={() => setCertificateTrustOpen(false)}
        testId="health-trust-certificates-confirm"
      />
      <Drawer
        open={Boolean(connectionDetails)}
        title={connectionDetails ? `${connectionDetails.name} · ${connectionDetailsView?.statusLabel ?? '没测成'}` : '连接自检'}
        onClose={() => setConnectionDetailsId(null)}
        testId="health-connection-details"
      >
        {connectionDetailsView && (
          <>
            <p>{connectionDetailsView.title}</p>
            <p>{connectionDetailsView.body}</p>
            {connectionDetailsView.detail && (
              <details className="v2-connection-note">
                <summary>服务的原话（联系客服时可以附上）</summary>
                {connectionDetailsView.detail}
              </details>
            )}
          </>
        )}
      </Drawer>
      <Drawer
        open={Boolean(details)}
        title={details?.title ?? '检查详情'}
        onClose={() => setDetails(null)}
      >
        <p>{details?.summary}</p>
        <dl className="v2-business-kv">
          {diagnosticDetailRows(details?.details).map((row) => (
            <div key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </Drawer>
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
/** 反馈页一次读多少条运行日志；读满了卡头就写「最近 500 条」。 */
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

export function FeedbackPage({
  api,
  openHelp,
  navigate,
  active,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.getRuntimeLogs(runtimeLogLimit), [api])
  const resource = useResource(load)
  // 错误框「查看日志」把人带回这一页时，刚出的那个错要在「运行日志」最上面，不用再点「刷新」。
  useReloadWhenShown(active, () => void resource.reload())
  const operation = useOperation()
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState(anyRuntimeLogValue)
  const [source, setSource] = useState(anyRuntimeLogValue)
  const [onlyCurrentBoot, setOnlyCurrentBoot] = useState(false)
  // 「再显示 100 条」点到第几页；换了筛选条件就从头的 100 条重新开始，改回原来的条件也不接着上次的页数。
  const filterKey = JSON.stringify([level, source, query, onlyCurrentBoot])
  const [shown, setShown] = useState({ key: filterKey, count: runtimeLogPage })
  if (shown.key !== filterKey) setShown({ key: filterKey, count: runtimeLogPage })
  const visibleCount = shown.key === filterKey ? shown.count : runtimeLogPage
  const [report, setReport] = useState<Awaited<
    ReturnType<V2Bridge['getFeedbackReport']>
  > | null>(null)
  const [selected, setSelected] = useState<RuntimeLog | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const filter = {
    level,
    source,
    query,
    onlyCurrentBoot,
    currentProcessId: resource.data?.currentProcessId ?? -1,
    startedAt: resource.data?.startedAt ?? '',
  }
  const list = filterRuntimeLogs(resource.data?.entries ?? [], filter)
  const writeNotice = runtimeLogWriteNotice(resource.data?.writeFailure)
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
  return (
    <section
      className="v2-page"
      data-page-id="feedback"
      data-testid="page-feedback"
    >
      <PageHead
        title="反馈"
        lead="先看看报告，再把问题和发生步骤发给我们。"
        actions={
          <Button
            variant="primary"
            icon={FileText}
            onClick={preview}
            loading={operation.busy === 'preview'}
          >
            预览反馈报告
          </Button>
        }
      />
      <div className="v2-feedback-privacy" data-testid="feedback-privacy">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>报告会自动脱敏：不会包含账号密码与完整密钥。发送前仍请检查私有项目名称和地址。</span>
        <Button size="sm" variant="ghost" onClick={openHelp}>
          联系客服
        </Button>
      </div>
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
      <Toolbar
        left={
          <>
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
            <Select
              aria-label="按来源筛选"
              options={runtimeLogSourceOptions(resource.data?.entries, source)}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              testId="feedback-source"
            />
            <Switch
              checked={onlyCurrentBoot}
              onChange={setOnlyCurrentBoot}
              label="只看本次启动"
              testId="feedback-current-boot"
            />
          </>
        }
        search={
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="搜索日志"
            testId="feedback-search"
          />
        }
        right={
          <Button
            size="sm"
            icon={RefreshCw}
            onClick={() => void resource.reload()}
          >
            刷新
          </Button>
        }
      />
      <ResultNotice
        {...operation}
        onReveal={(path) => api.revealExportedFile(path)}
      />
      <Card
        title="运行日志"
        meta={
          resource.data && !resource.error
            ? resource.data.truncated ? `最近 ${runtimeLogLimit} 条` : `共 ${list.length} 条`
            : undefined
        }
        padding="none"
        actions={
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
              打开日志目录
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={Trash2}
              disabled={!resource.data?.entries.length || Boolean(resource.error)}
              onClick={() => setClearOpen(true)}
              testId="feedback-clear"
            >
              清除日志
            </Button>
          </>
        }
      >
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
          emptyDescription="软件运行时的事件会记录在这里。"
          errorDescription="点「重新加载」再试；还不行，点「打开日志目录」直接看日志文件。"
        >
          {shownLogs.map(({ entry, time }) => (
            <button
              key={entry.id}
              type="button"
              className={logRowClass}
              onClick={() => setSelected(entry)}
              data-testid={`feedback-log-${entry.id}`}
            >
              <time dateTime={entry.timestamp} title={displayDate(entry.timestamp)}>
                {time}
              </time>
              <span className={`v2-feedback-log-level is-${entry.level}`}>
                {runtimeLogLevelLabels[entry.level] ?? entry.level}
              </span>
              <span className="v2-feedback-log-message">{runtimeLogDisplayMessage(entry.message)}</span>
              <span className="v2-feedback-log-source">{runtimeLogAreaLabel(entry)}</span>
              <span className="v2-feedback-log-more">详情 ›</span>
            </button>
          ))}
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
      <Dialog
        open={Boolean(report)}
        title="脱敏反馈报告"
        width={640}
        onClose={() => setReport(null)}
        footer={
          <>
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
          </>
        }
      >
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
          aria-label="脱敏反馈报告"
          readOnly
          rows={14}
          value={report?.text ?? ''}
          testId="feedback-report-text"
        />
      </Dialog>
      <Drawer
        open={Boolean(selected)}
        title="日志详情"
        onClose={() => setSelected(null)}
        footer={
          <Button
            icon={Copy}
            loading={operation.busy === 'copy-entry'}
            onClick={() =>
              selected &&
              void operation.execute(
                'copy-entry',
                () =>
                  navigator.clipboard.writeText(
                    formatRuntimeLogEntry(selected),
                  ),
                '这一条已复制',
              )
            }
          >
            复制这一条
          </Button>
        }
      >
        <dl className="v2-business-kv">
          <dt>时间</dt>
          <dd>{displayDate(selected?.timestamp)}</dd>
          <dt>来源</dt>
          <dd>{selected && runtimeLogArea(selected)}</dd>
          <dt>事件</dt>
          <dd>{selected?.event}</dd>
          <dt>内容</dt>
          <dd>{selected?.message}</dd>
        </dl>
        <pre className="v2-business-code">
          {JSON.stringify(selected?.detail, null, 2)}
        </pre>
        <ResultNotice
          {...operation}
          onReveal={(path) => api.revealExportedFile(path)}
        />
      </Drawer>
      <Dialog
        open={clearOpen}
        title="清除运行日志？"
        onClose={() => setClearOpen(false)}
        footer={
          <>
            <Button onClick={() => setClearOpen(false)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'clear'}
              onClick={() =>
                void operation.execute(
                  'clear',
                  async () => {
                    await api.clearRuntimeLogs()
                    setClearOpen(false)
                    await resource.reload()
                  },
                  '运行日志已清除',
                )
              }
            >
              清除日志
            </Button>
          </>
        }
      >
        <p>仅清除运行日志，不会删除工具配置、账号或对话记录。</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </section>
  )
}

export function UpdatesPage({
  api,
  navigate,
  appSettings,
  onSettingsChanged,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.getUpdateState(), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const showToast = useToast().show
  const [confirm, setConfirm] = useState(false)
  const [isMac, setIsMac] = useState(false)
  const [isWindows, setIsWindows] = useState(false)
  // 星芒这次本身就带着管理员权限在跑（自带 Administrator 之类）：装更新不弹授权窗口，确认框不说会弹（已知19）。
  const [processElevated, setProcessElevated] = useState(false)
  const [ownSettings, setOwnSettings] = useState<AppSettings | null>(null)
  const [settingsReadFailed, setSettingsReadFailed] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [diskCleanupOpen, setDiskCleanupOpen] = useState(false)
  useEffect(() => api.onUpdateState(resource.setData), [api, resource.setData])
  useEffect(() => {
    let current = true
    // 读不到平台就不提示：多说一句对 Windows 客户是噪音，少说一句只是回到原来的样子。
    void api.getPlatformCapabilities()
      .then((capability) => {
        if (!current) return
        setIsMac(capability.platform === 'macos')
        setIsWindows(capability.platform === 'windows')
        setProcessElevated(capability.processElevated === true)
      })
      .catch(() => undefined)
    return () => { current = false }
  }, [api])
  useEffect(() => {
    let current = true
    // 读不到设置就按关着说：多承诺一句「会自动装」比少说一句更糟。
    void api.getSettings()
      .then((settings) => { if (current) setOwnSettings(settings) })
      .catch(() => { if (current) setSettingsReadFailed(true) })
    return () => { current = false }
  }, [api])
  // App 手里那份最新（设置页、更新气泡里改过也算）；还没有就用这一页自己读到的。
  const settings = appSettings ?? ownSettings
  const autoUpdateSetting = settings ? settings.autoUpdate !== false : false
  // 「启动时检查新版本」「自动更新」直接在这一页改，和设置「更新与关于」里那两行是同一份设置。
  async function saveSetting(patch: Omit<SettingsUpdate, 'version'>) {
    const finish = beginBusinessOperation('保存设置')
    setSettingsSaving(true)
    setSettingsError('')
    try {
      const saved = await api.saveSettings({ version: 2, ...patch })
      setOwnSettings(saved)
      onSettingsChanged?.(saved)
      showToast('已保存', 'ok')
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setSettingsSaving(false)
      finish()
    }
  }
  // 还在读：开关灰着点不了；没读到：写「暂未读到」，不装成关着的样子（同设置页）。
  function settingSwitch(label: string, checked: boolean | undefined, onChange: (value: boolean) => void, testId: string) {
    if (checked === undefined && settingsReadFailed) return <Pill tone="neutral">暂未读到</Pill>
    return (
      <Switch
        checked={checked ?? false}
        disabled={checked === undefined || settingsSaving}
        aria-label={label}
        onChange={onChange}
        testId={testId}
      />
    )
  }
  const update = resource.data
  const newVersion = updateNewVersion(update)
  const autoUpdateOn = Boolean(update?.autoUpdateSupported && autoUpdateSetting)
  // Linux 的 .deb：装这一步交给系统安装程序，软件只关掉、不会自己重开（updater.ts 的 UpdateInstallMethod）。
  const systemInstaller = update?.installMethod === 'system-installer'
  const check = () =>
    void operation.execute(
      'check',
      async () => resource.setData(await api.checkForUpdates()),
      '',
    )
  const download = () =>
    void operation.execute(
      'download',
      async () => resource.setData(await api.downloadUpdate()),
      '',
    )
  // 空间不够时不拦死：估算是估的，他清出了一点、或者就想试一次，由他决定。
  const downloadAnyway = () =>
    void operation.execute(
      'download',
      async () => resource.setData(await api.downloadUpdate({ ignoreDiskSpace: true })),
      '',
    )
  const diskShortfallText = updateDiskShortfallText(update, autoUpdateOn)
  const redownload = () =>
    void operation.execute(
      'download',
      async () => resource.setData(await redownloadUpdate(api)),
      '',
    )
  // 失败在哪一步，重试就从哪一步接着走；首页气泡走的是同一套（update-retry.ts）。
  const failure = updateFailureLabel(update?.failedStep)
  const releaseNotes = releaseNotesSection(update)
  const retryFailedStep = () => retryFailedUpdateStep(update?.failedStep, { check, redownload, confirmInstall: () => setConfirm(true) })
  const manualReinstall = updateNeedsManualReinstall(update)
  const offerDownloadPage = updateOffersDownloadPage(update)
  const openDownloadPage = () => void operation.execute('download-page', async () => { await api.openExternal(appReleaseDownloadUrl) }, '')
  // 首页气泡上点了「重新安装」：跳过来直接弹确认框。
  useEffect(() => subscribeUpdateInstallConfirm(() => {
    if (takeUpdateInstallConfirm()) setConfirm(true)
  }), [])
  const action =
    update?.phase === 'available' || update?.phase === 'cancelled' ? (
      <Button variant="primary" icon={Download} onClick={download}>
        下载更新
      </Button>
    ) : update?.phase === 'downloaded' ? (
      // 验签没通过时「重启安装」和失败卡里去掉的「重新安装」是同一条死路，下一步只在失败卡的「打开下载页」。
      manualReinstall ? null : (
        <Button
          variant="primary"
          icon={RefreshCw}
          onClick={() => setConfirm(true)}
        >
          {updateInstallActionLabel(update.installMethod)}
        </Button>
      )
    ) : (
      <Button
        variant="primary"
        icon={RefreshCw}
        loading={
          update?.phase === 'checking' ||
          update?.phase === 'downloading' ||
          Boolean(operation.busy)
        }
        disabled={update?.phase === 'disabled'}
        onClick={check}
      >
        {update?.phase === 'error' ? '重新检查' : '检查更新'}
      </Button>
    )
  return (
    <section
      className="v2-page"
      data-page-id="updates"
      data-testid="page-updates"
    >
      <PageHead title="更新" lead={updatesPageLead(autoUpdateOn, update?.installMethod, update?.installNeedsAdminPassword)} />
      <ResultNotice
        error={resource.error || settingsError || operation.error}
        detail={resource.error ? resource.detail : settingsError ? undefined : operation.detail}
        message={operation.message}
      />
      <div className="v2-business-update-grid">
        <Card
          title={update ? updateCardTitle(update) : resource.error ? '更新状态暂未读到' : '正在读取更新状态…'}
          actions={action}
        >
          <ListRow
            title="当前版本"
            meta={<span className="v2-update-version">{update?.currentVersion ?? '暂未读到'}</span>}
            testId="updates-current-version"
          />
          {newVersion && (
            <ListRow
              title="新版本"
              meta={<span className="v2-update-version">{newVersion}</span>}
              testId="updates-new-version"
            />
          )}
          <ListRow title="上次检查" meta={<RelativeTime value={update?.checkedAt} />} />
          {update?.currentVersionWithdrawn && (
            <Notice
              tone="warn"
              title="这个版本有已知问题"
              body={withdrawnVersionAdvice(update)}
              testId="updates-current-withdrawn"
            />
          )}
          {/* 账号不是管理员的 Windows 电脑：下好的新版本不自动装，就在「重启安装」旁边说清要谁来点。 */}
          {update?.phase === 'downloaded' && update.installNeedsAdminPassword && (
            <Notice
              tone="warn"
              title={standardAccountUpdateNotice.title}
              body={standardAccountUpdateNotice.body}
              testId="updates-admin-password"
            />
          )}
          {update?.unsignedChannel && !update.autoUpdateSupported && (
            <ListRow
              title="更新方式"
              meta="每次下载和安装新版本前都会先问你"
              testId="updates-channel-unsigned"
            />
          )}
          <ListRow
            title={settingsItemLabel('update-check')}
            desc="发现新版本会提醒你"
            actions={settingSwitch(
              '启动时检查新版本',
              settings?.checkUpdatesOnStartup,
              (checkUpdatesOnStartup) => void saveSetting({ checkUpdatesOnStartup }),
              'updates-check-on-startup',
            )}
          />
          {update?.autoUpdateSupported && (
            <ListRow
              title={settingsItemLabel('auto-update')}
              desc={autoUpdateSettingDescription(update.installMethod, update.installNeedsAdminPassword)}
              actions={settingSwitch(
                '自动更新',
                settings ? autoUpdateSetting : undefined,
                (autoUpdate) => void saveSetting({ autoUpdate }),
                'updates-auto-update',
              )}
            />
          )}
          {update?.progress && (
            <Progress
              value={update.progress.percent}
              label={`${update.progress.percent.toFixed(0)}%`}
            />
          )}
          {update?.progress && (
            <p className="v2-update-progress-detail" data-testid="updates-progress-detail">
              {updateDownloadDetail(update.progress)}
            </p>
          )}
          {diskShortfallText && (
            <Notice
              tone="warn"
              title="磁盘空间不够，新版本先不下载"
              body={
                <>
                  <p>{diskShortfallText}</p>
                  {diskCleanupOpen && (
                    <p data-testid="updates-disk-cleanup">{updateDiskCleanupDetail}</p>
                  )}
                </>
              }
              testId="updates-disk-shortfall"
              actions={
                <>
                  <Button
                    size="sm"
                    icon={BookOpen}
                    onClick={() => setDiskCleanupOpen((open) => !open)}
                  >
                    {diskCleanupOpen ? '收起' : '怎么清理'}
                  </Button>
                  <Button
                    size="sm"
                    icon={Download}
                    loading={operation.busy === 'download'}
                    onClick={downloadAnyway}
                  >
                    仍要下载
                  </Button>
                </>
              }
            />
          )}
          {update?.error && (
            <Notice
              tone="warn"
              title={failure.title}
              body={userFacingErrorMessage(update.error)}
              testId={`updates-failure-${update.failedStep ?? 'unknown'}`}
              actions={
                <>
                  {!manualReinstall && (
                    <Button
                      size="sm"
                      icon={!update.failedStep || update.failedStep === 'download' ? Download : RefreshCw}
                      onClick={retryFailedStep}
                    >
                      {failure.retry}
                    </Button>
                  )}
                  {offerDownloadPage && (
                    <Button size="sm" icon={ExternalLink} onClick={openDownloadPage}>
                      打开下载页
                    </Button>
                  )}
                  <Button
                    size="sm"
                    icon={FileText}
                    onClick={() => navigate?.('feedback')}
                  >
                    查看日志
                  </Button>
                </>
              }
            />
          )}
          {update?.installMethod === 'manual' && (
            <Notice
              tone="warn"
              title="这台电脑上没法自动更新"
              body="星芒在这台电脑上不是用安装包装的，没法自己更新。到下载页下载新版本的安装包，装好后打开就行。"
              testId="updates-manual-install"
              actions={
                <Button
                  size="sm"
                  icon={ExternalLink}
                  onClick={openDownloadPage}
                >
                  打开下载页
                </Button>
              }
            />
          )}
          {update?.development && <p>当前是开发运行环境。</p>}
        </Card>
        <Card title={releaseNotes.title}>
          {releaseNotes.items ? (
            <ul
              className="v2-business-release-notes v2-business-release-notes-list"
              data-testid="updates-installed-notes"
            >
              {releaseNotes.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : (
            <div className="v2-business-release-notes">{releaseNotes.text}</div>
          )}
          <div className="v2-update-install-note" data-testid="updates-install-note">
            <h3>安装前需要知道</h3>
            <p>{updateInstallNote}</p>
          </div>
        </Card>
      </div>
      <Dialog
        open={confirm}
        title={systemInstaller ? '安装新版本？' : '重启并安装更新？'}
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>稍后安装</Button>
            <Button
              variant="primary"
              icon={RefreshCw}
              loading={operation.busy === 'install'}
              onClick={() =>
                void operation.execute(
                  'install',
                  async () => {
                    // 有工具在装或排着队时主进程先问一句再重启（已知31）。
                    const result = await api.installUpdate({ askIfInstalling: true })
                    setConfirm(false)
                    return result
                  },
                  // 还有工具在装、客户在问的那一句里点了「继续安装」：这次不装，回到原来的样子（已知31）。
                  (result) => (result.postponed ? null : '安装请求已提交'),
                )
              }
            >
              {systemInstaller ? '关掉并安装' : '确认重启安装'}
            </Button>
          </>
        }
      >
        {systemInstaller
          ? <p data-testid="updates-system-installer-hint">请先保存当前工作。{systemInstallerUpdateHint}</p>
          : <p>请先保存当前工作。安装完成后重新打开工具箱。</p>}
        {isMac && <p data-testid="updates-mac-keychain-hint">{macKeychainUpdateHint}</p>}
        {isWindows && !processElevated && <p data-testid="updates-windows-consent-hint">{update?.installNeedsAdminPassword ? windowsAdminPasswordUpdateHint : windowsConsentUpdateHint}</p>}
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </section>
  )
}

// 为什么 Mac 每换一版都会问一次钥匙串密码，见 registry/tutorials.ts 的
// macKeychainTutorialDetail。重启前说一句，客户就不会慌着点「拒绝」。
// 安装包装在「所有用户」的程序目录下，Windows 会弹一次授权窗口；点了「否」就装不上。
export const windowsConsentUpdateHint = 'Windows 会弹出一个授权窗口问要不要允许更改，点「是」就好；点了「否」这次就装不上。'
// 账号不在管理员组时那个窗口要的是管理员密码，只点「是」过不去。
export const windowsAdminPasswordUpdateHint = 'Windows 会弹出一个授权窗口，要在里面输入管理员密码；点了「否」这次就装不上。'
// Linux 上星芒不提权，装这一步交给系统的安装窗口；它要开机密码，装完也不会替他重开星芒。
export const systemInstallerUpdateHint = '星芒会先关掉，再打开这台电脑的安装窗口：在里面点「安装」，输入开机密码。装好后从应用菜单重新打开星芒。'
export const macKeychainUpdateHint = '重启后 Mac 可能弹出钥匙串密码框，输入这台 Mac 的开机密码，点「始终允许」就好。'

export function installResultMessage(result: ToolInstallOutcome | 'cancelled'): string | null {
  if (result === 'declined') return null
  if (result === 'cancelled') return '安装已取消'
  if (result === 'restart') return '运行环境已装好，重启电脑后再点一次「安装」'
  if (result === 'skipped') return '这个工具正在安装，等它做完就好'
  return '安装完成，工具状态已更新'
}

/** 安装卸载页一行在装的时候，名字下面那句白话和百分比（同首页的工具行）。 */
interface RowProgress {
  label: string
  percent?: number
}

/**
 * 安装卸载页的一行。和表头同一套三栏：工具（图标单独一格，名字和厂商上下两行）、
 * 版本与状态、操作；有百分比时整行底下加一道细进度条。
 */
function MaintenanceRow({
  icon,
  name,
  desc,
  status,
  actions,
  progress,
  testId,
}: {
  icon: ReactNode
  name: string
  desc: ReactNode
  status: ReactNode
  actions?: ReactNode
  progress?: number
  testId: string
}) {
  return (
    <div className="xm-list-row v2-maintenance-row" data-testid={testId}>
      {icon}
      <div className="xm-row-main">
        <div className="xm-row-title">{name}</div>
        <div className="xm-row-desc">{desc}</div>
      </div>
      <div className="xm-row-meta">{status}</div>
      <div className="xm-row-actions">{actions}</div>
      {typeof progress === 'number' && (
        <div className="v2-maintenance-row-progress">
          <Progress value={progress} />
        </div>
      )}
    </div>
  )
}

/**
 * 首页那边这个工具正挂着的任务算不算这一行在装：卸载也挂在工具编号下，那不是安装，
 * 这一行不能标「安装中」，只说正在卸载、按钮先灰着。
 */
export function installJobRunning(job: ToolJob | undefined): boolean {
  return job !== undefined && job.kind !== 'uninstall'
}

/**
 * 首页那份任务里本页有行的几个（四个命令行工具、Codex 桌面端、Node.js、Python）。
 * Git、打开工具这些任务这一页不画，跑完也不用重读。
 */
export function maintenanceRowJobKeys(jobs: Readonly<Record<string, ToolJob>> | undefined): string[] {
  return Object.keys(jobs ?? {}).filter((key) => isProvider(key) || key === 'codexDesktop' || key === 'node' || key === 'python')
}

/**
 * 上次还在、这次没了的任务：在首页装好、更新完、卸掉（或没装上、取消了）。任务一没，
 * 这一行就回到本页上次读的检测结果，写回做之前的样子，所以要重读。
 */
export function maintenanceJobsFinished(previous: readonly string[], current: readonly string[]): boolean {
  return previous.some((key) => !current.includes(key))
}

/** 正在装的是哪个（工具或运行环境）；不是安装（检查更新、复制日志……）时为 null。 */
function installingName(busy: string): string | null {
  if (busy === 'node') return 'Node.js'
  if (busy === 'python') return 'Python'
  return tools.find((tool) => tool.id === busy)?.name ?? null
}

/**
 * 「查看安装步骤」「安装指南」落到教程哪一章。以前一律落到第一章，客户还得自己翻：
 * 桌面端在 Mac 上去「Mac 上装桌面端」、别的电脑去「Codex 桌面端怎么安装？」；四个命令行
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

export function MaintenancePage({
  api,
  navigate,
  onToolsChanged,
  onSystemChanged,
  installTool,
  cancelToolInstall,
  toolJobs,
  active,
}: { api: V2Bridge } & BusinessActions) {
  const toast = useToast()
  const load = useCallback(() => readMaintenanceStatus(api), [api])
  const resource = useResource(load)
  // 首页的任务跑完时下面那段会重读；别处的变化（比如在终端里自己装、卸了工具）这一页看不见，
  // 再显示时也重读一次（已知5）。还在读就不再起一轮：那一轮本来就是刚起的。
  useReloadWhenShown(active, () => {
    if (!resource.loading) void resource.reload()
  })
  const snapshot = resource.data?.snapshot ?? null
  const capability = resource.data?.capability ?? null
  const failures = resource.data?.failures ?? []
  // 检测那一块没读到时，页面对「装没装」毫无根据，所以这些行只报未知，
  // 不把缺省值当成结论（对照本文件里 detectionFailed 的同一条理由）。
  const statusUnknown = Boolean(resource.data) && snapshot === null
  const operation = useOperation()
  const [logs, setLogs] = useState<string[]>([])
  // 首页那份任务（toolJobs）管不到的安装——运行环境、没接 installTool 时的工具——进度从事件里自己记。
  const [progress, setProgress] = useState<Record<string, RowProgress>>({})
  // 刚才没装上的那一行。原因和页顶红框领头的是同一句；红框换了说法（又做了别的操作）就不再算。
  const [failedInstall, setFailedInstall] = useState<{ id: string; message: string } | null>(null)
  const [remove, setRemove] = useState<Provider | 'codexDesktop' | null>(null)
  // 主进程拒绝取消时的中文原因，和检测失败共用页面顶部那条提示。
  const [cancelNotice, setCancelNotice] = useState('')
  const [cancelling, setCancelling] = useState('')
  const cancelRequested = useRef(new Set<string>())
  const [manualUninstall, setManualUninstall] = useState<ManualUninstallState | null>(null)
  const [runtimeRestart, setRuntimeRestart] = useState(false)
  const [nodeReplaceOpen, setNodeReplaceOpen] = useState(false)
  const logView = useRef<HTMLPreElement>(null)
  // 日志框只有八行高：停在最底下时新的一行进来跟着往下走，往上翻着看时不打断他。
  const followLog = useRef(true)
  useEffect(() => {
    // 进度那一行只放白话（同首页），原话照旧进下面的「安装日志」。
    const note = (id: string, label: string, percent: number | null | undefined) =>
      setProgress((previous) => ({
        ...previous,
        [id]: { label, percent: typeof percent === 'number' ? percent : undefined },
      }))
    const stops = [
      api.onInstallProgress((event) => {
        setLogs((previous) => [...previous.slice(-199), event.message])
        const label = installProgressLabel(event)
        if (label !== null) note(event.provider, label, event.percent)
      }),
      api.onCodexDesktopInstallProgress((event) => {
        setLogs((previous) => [...previous.slice(-199), event.message])
        note('codexDesktop', event.message, event.percent)
      }),
      api.onNodeRuntimeInstallProgress((event) => note('node', event.message, event.percent)),
      api.onPythonRuntimeInstallProgress((event) => note('python', event.message, event.percent)),
    ]
    return () => stops.forEach((stop) => stop())
  }, [api])
  useLayoutEffect(() => {
    const view = logView.current
    if (view && followLog.current) view.scrollTop = view.scrollHeight
  }, [logs])
  // 去别的页时这一页只是藏起来：那时进来的日志滚不动，回到这页再补一次贴底。
  const hasLogs = logs.length > 0
  useEffect(() => {
    const view = logView.current
    if (!view || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followLog.current) view.scrollTop = view.scrollHeight
    })
    observer.observe(view)
    return () => observer.disconnect()
  }, [hasLogs])
  // 首页那份任务一跑完（在首页装、更新、卸载工具，或者装运行环境），这一行就回到本页上次
  // 读的结果：写回做之前的样子，又给「安装」或「卸载工具」。少了哪一行的任务就重读一次。
  // 装好、卸掉、装好运行环境时首页自己也会重新检测，本页这次读接上那一轮，不另起一轮。
  const rowJobs = useRef<string[]>([])
  useEffect(() => {
    const current = maintenanceRowJobKeys(toolJobs)
    const finished = maintenanceJobsFinished(rowJobs.current, current)
    rowJobs.current = current
    if (finished) void resource.reload()
  }, [toolJobs, resource.reload])
  function forgetProgress(id: string) {
    setProgress((previous) => {
      if (!(id in previous)) return previous
      const next = { ...previous }
      delete next[id]
      return next
    })
  }
  // 包住一次安装：开始前清掉这一行上次的进度和失败，没装上时记下是哪一行、红框里那句是什么。
  async function tracked<T>(id: string, work: () => Promise<T>): Promise<T> {
    setFailedInstall(null)
    forgetProgress(id)
    try {
      return await work()
    } catch (cause) {
      setFailedInstall({ id, message: failureWithDetail(cause).message })
      throw cause
    } finally {
      forgetProgress(id)
    }
  }
  const install = (id: Provider | 'codexDesktop') =>
    void operation.execute(
      id,
      () => tracked(id, async () => {
        cancelRequested.current.delete(id)
        setCancelNotice('')
        if (installTool) {
          try {
            const outcome = await installTool(id)
            if (outcome === 'skipped' && cancelRequested.current.has(id)) return 'cancelled' as const
            await resource.reload()
            return outcome
          } finally {
            cancelRequested.current.delete(id)
            setCancelling('')
            // 取消被拒时页顶那句只说这次安装还会跑完。跑完了（装好、没装上都算）就收起：
            // 装好照常提示「安装完成，工具状态已更新」，没装上红条换成没装上的原因。不收的话
            // 红条一直挂着，下一次别的操作清掉那条原因后它还会再冒出来。
            setCancelNotice('')
          }
        }
        try {
          if (id === 'codexDesktop') await api.installCodexDesktop()
          else await api.installCli(id)
        } catch (cause) {
          // 用户自己点的取消不是失败，不进红色提示条。
          if (!cancelRequested.current.has(id)) throw cause
          return 'cancelled' as const
        } finally {
          cancelRequested.current.delete(id)
          setCancelling('')
          setCancelNotice('')
        }
        // 先让 App 写 Key 并刷新全局检测，再读本页数据：顺序反过来这一页会先
        // 拿到一份还没配置 Key 的快照，而提示语已经说「工具状态已更新」。
        await onToolsChanged?.(id)
        await resource.reload()
        return 'installed' as const
      }),
      (result) => installResultMessage(result),
    )
  const installRuntime = (id: 'node' | 'python') =>
    void operation.execute(
      id,
      () => tracked(id, async () => {
        const result = id === 'node'
          ? await api.installNodeRuntime()
          : await api.installPythonRuntime()
        onSystemChanged?.()
        await resource.reload()
        return describeRuntimeInstallOutcome(id, result)
      }),
      (outcome) => {
        // 3010：结果条照样说清楚，另外弹重启确认（第七批 5）。
        if (outcome.restartRequired) setRuntimeRestart(true)
        return outcome.message
      },
    )
  const cancelInstall = (id: Provider | 'codexDesktop') => {
    cancelRequested.current.add(id)
    setCancelling(id)
    setCancelNotice('')
    const requested = cancelToolInstall
      ? cancelToolInstall(id)
      : id === 'codexDesktop' ? api.cancelCodexDesktopInstall() : api.cancelCliInstall(id)
    void requested.then((outcome) => {
      if (outcome.cancelled) return
      // 已经走到写入工具目录那一步：这次安装还会跑完，取消标记必须撤掉，
      // 否则真失败时会被当成取消吞掉。
      cancelRequested.current.delete(id)
      setCancelling('')
      setCancelNotice(outcome.reason ?? '这一步已经不能取消了。')
    }).catch(() => {
      cancelRequested.current.delete(id)
      setCancelling('')
      setCancelNotice('取消请求没有送达，请重试。')
    })
  }
  const check = (id: Provider | 'codexDesktop') =>
    void operation.execute(
      `check-${id}`,
      async () => {
        setFailedInstall(null)
        if (id === 'codexDesktop') await api.checkCodexDesktopUpdate()
        else await api.checkCliUpdate(id)
        await resource.reload()
      },
      '工具版本已检查',
    )
  // 别的行正在装时，这一行的按钮是灰的：鼠标停上去说清在等谁。
  const busyInstall = operation.busy ? installingName(operation.busy) : null
  const waitTitle = (id: string) =>
    busyInstall && operation.busy !== id ? `等 ${busyInstall} 装完再操作` : undefined
  const rowProgress = (id: string) => {
    const job = toolJobs?.[id]
    return {
      label: job?.label ?? progress[id]?.label,
      percent: job ? job.percent : progress[id]?.percent,
    }
  }
  const failedHere = (id: string, installed: boolean | undefined, running: boolean) =>
    failedInstall?.id === id && failedInstall.message === operation.error && !running && installed !== true
  const platform = capability?.platform
  return (
    <section
      className="v2-page"
      data-page-id="maintenance"
      data-testid="page-maintenance"
    >
      <PageHead
        title="安装卸载"
        lead="管理工具和运行环境。卸载工具默认保留你的配置。"
        actions={
          <Button
            icon={RefreshCw}
            loading={resource.loading}
            onClick={() => void resource.reload()}
          >
            重新检测
          </Button>
        }
      />
      <ResultNotice
        error={resource.error || operation.error || cancelNotice}
        detail={resource.error ? resource.detail : operation.detail}
        message={operation.message}
      />
      {failures.map((failure) => {
        const notice = maintenanceFailureNotice(failure)
        return (
          <Notice
            key={failure.partition}
            tone="bad"
            title={notice.title}
            body={
              <>
                <div>{notice.reason}</div>
                <div>{notice.hint}</div>
              </>
            }
            actions={
              <Button
                size="sm"
                icon={RefreshCw}
                loading={resource.loading}
                onClick={() => void resource.reload()}
              >
                重新检测
              </Button>
            }
            testId={'maintenance-failure-' + failure.partition}
          />
        )
      })}
      <Card title="工具" padding="none">
        <div className="v2-maintenance-table">
          <div className="v2-business-table-head">
            <span>工具</span>
            <span>版本与状态</span>
            <span>操作</span>
          </div>
          {tools.map((tool) => {
            const id = tool.id
            if (!isProvider(id) && id !== 'codexDesktop') return null
            // 和首页同一口径（presentTools）：打不开桌面端的系统（Linux）不列这一行。
            if (id === 'codexDesktop' && capability && !capability.codexDesktop.launch) return null
            const status =
              id === 'codexDesktop'
                ? snapshot?.desktopApps.codex
                : snapshot?.clis[id]
            const version =
              status && 'appVersion' in status
                ? status.appVersion
                : status && 'version' in status
                  ? status.version
                  : null
            const managed =
              id === 'codexDesktop'
                ? capability?.codexDesktop.install === 'managed'
                : capability?.cliInstall[id] === 'managed'
            // A probe that failed says nothing about what is installed, so the
            // row offers a rescan instead of an install that could land on top
            // of a working tool.
            const detectionFailed = status?.detectionFailed === true
            // 官方安装器或别的方式装的 CLI，这里的「重新安装」走的是 npm，只会在
            // 旁边再装一份和它抢着用（#481）。与首页一样不给这个按钮，改说明怎么更新。
            // 官方安装器装的 Claude Code 照首页一样放开：点了先问一句，卸掉再装。
            const externalHint = id !== 'codexDesktop' && !statusUnknown && !detectionFailed && updatesOutsideApp(id, status)
              ? externalInstallHint(status?.installSource)
              : null
            // 走首页那条安装时，这一行跟着首页的任务走（在首页点的也算）；任务要等确认框点过才开始。
            const job = toolJobs?.[id]
            const uninstalling = job?.kind === 'uninstall'
            const running = installTool && toolJobs ? installJobRunning(job) : operation.busy === id
            const ownInstall = running && operation.busy === id
            const live = running ? rowProgress(id) : null
            const failed = failedHere(id, status?.installed, running)
            const view = toolStatusView(status, statusUnknown, version, running ? 'installing' : failed ? 'failed' : null)
            const lead = withElevationNotice(
              tool.vendor,
              externalHint ?? (id === 'codexDesktop' && !status?.installed && !statusUnknown && !detectionFailed
                ? elevatedInstallNotice('codexDesktop', capability?.platform, capability?.codexDesktop.install, capability?.processElevated)
                : null),
            )
            return (
              <MaintenanceRow
                key={id}
                testId={'maintenance-tool-' + id}
                icon={<BrandIcon tool={id} size={32} variant="tile" />}
                name={tool.name}
                desc={live?.label ?? (uninstalling ? job.label : failed ? resultNoticeLead(operation.error, operation.detail) : lead)}
                status={
                  <ToolStatusMeta
                    view={view}
                    testId={'maintenance-state-' + id}
                    reasonTestId={'maintenance-reason-' + id}
                  />
                }
                progress={live?.percent}
                actions={
                  <>
                    {/* 整页没读到时各行不再各放一颗「重新检测」：页头和红框里那两颗就够了。 */}
                    {(!statusUnknown || running) && (
                      <Button
                        size="sm"
                        icon={detectionFailed || status?.installed ? RefreshCw : Download}
                        loading={running}
                        disabled={(!managed && !detectionFailed) || Boolean(externalHint) || Boolean(operation.busy) || uninstalling}
                        title={externalHint ?? waitTitle(id)}
                        testId={'maintenance-install-' + id}
                        onClick={() => detectionFailed ? check(id) : install(id)}
                      >
                        {running && typeof live?.percent === 'number'
                          ? `${Math.round(live.percent)}%`
                          : detectionFailed ? '重新检测' : status?.installed ? '重新安装' : '安装'}
                      </Button>
                    )}
                    {ownInstall && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={X}
                        loading={cancelling === id}
                        onClick={() => cancelInstall(id)}
                        testId={'maintenance-cancel-' + id}
                      >
                        {cancelling === id ? '正在停止' : '取消'}
                      </Button>
                    )}
                    <Menu
                      label={`${tool.name} 的更多操作`}
                      anchor={<MoreHorizontal size={18} />}
                      items={[
                        {
                          label: '检查更新',
                          icon: RefreshCw,
                          onSelect: () => check(id),
                        },
                        ...(status?.installed === true &&
                        canUninstallTool(status, id === 'codexDesktop' &&
                          capability?.codexDesktop.uninstall === true) &&
                        (id !== 'codexDesktop' ||
                        capability?.codexDesktop.uninstall)
                          ? [
                              {
                                label: '卸载工具',
                                icon: Trash2,
                                danger: true,
                                onSelect: () => setRemove(id),
                              },
                            ]
                          : []),
                        ...(!managed
                          ? [
                              {
                                label: '查看安装步骤',
                                icon: BookOpen,
                                onSelect: () => navigate?.('tutorial', installGuideTopic(id, platform)),
                              },
                            ]
                          : []),
                      ]}
                    />
                  </>
                }
              />
            )
          })}
        </div>
      </Card>
      <Card title="运行环境" padding="none">
        <div className="v2-maintenance-table">
          {(['node', 'python'] as const).map((id) => {
            const status = snapshot?.runtime[id]
            const managed =
              id === 'node'
                ? capability?.nodeRuntimeInstall === 'managed'
                : capability?.pythonRuntimeInstall === 'managed'
            // 装着、却认不了公司证书的 Node.js：「安装」只会回「无需重复安装」，
            // 按钮改成「换成新版」，点了先确认再换（第十八批 4）。
            const replace =
              id === 'node' &&
              nodeReplaceOffered({
                platform: capability?.platform,
                nodeRuntimeInstall: capability?.nodeRuntimeInstall,
                node: status,
              })
            const name = id === 'node' ? 'Node.js' : 'Python'
            const running = operation.busy === id || Boolean(toolJobs?.[id])
            const live = running ? rowProgress(id) : null
            const failed = failedHere(id, status?.installed, running)
            const view = toolStatusView(status, statusUnknown, status?.version, running ? 'installing' : failed ? 'failed' : null)
            const lead = withElevationNotice(
              id === 'node'
                ? managed
                  ? '命令行工具需要的运行环境；装工具时会自动准备，一般不用单独点'
                  : '命令行工具需要的运行环境'
                : '部分工具需要的可选运行环境',
              id === 'node' && !status?.installed && !statusUnknown && !status?.detectionFailed
                ? elevatedInstallNotice('node', capability?.platform, capability?.nodeRuntimeInstall, capability?.processElevated)
                : null,
            )
            // 已经装好的不再给「安装」：点了只会回一句「本来就装好了」，新手反而
            // 以为没装好、反复点（新手引导梳理 9-25 第 4 条）。要换新版的照旧给按钮。
            // 整页没读到时也不给「安装」：红框里说了读到之前装不了；「安装指南」只是打开教程，照旧。
            const action = running
              ? 'install'
              : status?.installed && !statusUnknown && !replace
                ? null
                : statusUnknown && managed ? null : replace ? 'replace' : managed ? 'install' : 'guide'
            return (
              <MaintenanceRow
                key={id}
                testId={'maintenance-runtime-' + id}
                icon={<BrandIcon tool={id} size={32} variant="tile" />}
                name={name}
                desc={live?.label ?? (failed ? resultNoticeLead(operation.error, operation.detail) : lead)}
                status={
                  <ToolStatusMeta
                    view={view}
                    testId={'maintenance-runtime-state-' + id}
                    reasonTestId={'maintenance-runtime-reason-' + id}
                  />
                }
                progress={live?.percent}
                actions={
                  action && <Button
                    size="sm"
                    icon={Download}
                    loading={running}
                    disabled={Boolean(operation.busy)}
                    title={waitTitle(id)}
                    testId={'maintenance-runtime-action-' + id}
                    onClick={() =>
                      action === 'replace'
                        ? setNodeReplaceOpen(true)
                        : action === 'install'
                        ? installRuntime(id)
                        : navigate?.('tutorial', installGuideTopic(id, platform))
                    }
                  >
                    {running && typeof live?.percent === 'number'
                      ? `${Math.round(live.percent)}%`
                      : action === 'replace' ? '换成新版' : action === 'install' ? '安装' : '安装指南'}
                  </Button>
                }
              />
            )
          })}
        </div>
      </Card>
      {/* 平时不占地方：装命令行工具或 Codex 桌面端时一有日志就出现（运行环境的安装不写日志），
          装完留着；最高八行，多了在卡里滚。 */}
      {hasLogs && (
        <Card
          title="安装日志"
          actions={
            <Button
              size="sm"
              icon={Copy}
              onClick={() =>
                void operation.execute(
                  'copy-log',
                  () => {
                    setFailedInstall(null)
                    return navigator.clipboard.writeText(logs.join('\n'))
                  },
                  '安装日志已复制',
                )
              }
            >
              复制
            </Button>
          }
        >
          <pre
            ref={logView}
            className="v2-business-code v2-maintenance-log"
            role="log"
            onScroll={(event) => {
              const view = event.currentTarget
              followLog.current = view.scrollTop + view.clientHeight >= view.scrollHeight - 4
            }}
          >
            {logs.join('\n')}
          </pre>
        </Card>
      )}
      <Dialog
        open={Boolean(remove)}
        title="卸载工具？"
        onClose={() => setRemove(null)}
        footer={
          <>
            <Button onClick={() => setRemove(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'uninstall'}
              onClick={() => {
                if (remove)
                  void operation.execute(
                    'uninstall',
                    async () => {
                      setFailedInstall(null)
                      const result =
                        remove === 'codexDesktop'
                          ? await api.uninstallCodexDesktop()
                          : await api.uninstallCli(remove)
                      if (result.outcome === 'manual-required') {
                        // The backend text promises a copyable cleanup command,
                        // so it has to reach a surface that can show one.
                        setManualUninstall(
                          manualUninstallState(
                            tools.find((tool) => tool.id === remove)?.name ??
                              remove,
                            remove,
                            result.manualHelp,
                          ),
                        )
                        setRemove(null)
                        // 程序已经卸掉了一部分，首页那份也要重查。
                        onSystemChanged?.()
                        await resource.reload()
                        // Still a failed uninstall: the page must not claim
                        // success while files are left on disk.
                        throw new Error(result.error)
                      }
                      setRemove(null)
                      onSystemChanged?.()
                      await resource.reload()
                      return uninstallHandOffNotice(result)
                    },
                    // 转交给普通窗口时还没卸完：不说「已卸载」，也不当失败，
                    // 用一条中性提示说清下一步。
                    (handedOff) => {
                      if (!handedOff) return '工具已卸载，配置已保留'
                      toast.show(handedOff, 'neutral')
                      return null
                    },
                  )
              }}
            >
              确认卸载
            </Button>
          </>
        }
      >
        <p>卸载所选工具程序，保留账号与工具配置。需要时可重新安装。</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
      {manualUninstall && (
        <ManualUninstallDialog
          state={manualUninstall}
          platform={capability?.platform}
          onClose={() => setManualUninstall(null)}
          cleanUp={(tool) => api.cleanUninstallLeftovers(tool)}
        />
      )}
      {nodeReplaceOpen && (
        <NodeReplaceDialog
          version={snapshot?.runtime.node.version}
          onClose={() => setNodeReplaceOpen(false)}
          onConfirm={() => {
            setNodeReplaceOpen(false)
            void operation.execute(
              'node',
              () => tracked('node', async () => {
                const result = await api.installNodeRuntime({ reason: 'certificate' })
                onSystemChanged?.()
                await resource.reload()
                return describeNodeReplaceOutcome(result)
              }),
              (outcome) => {
                if (outcome.restartRequired) setRuntimeRestart(true)
                return outcome.message
              },
            )
          }}
        />
      )}
      {runtimeRestart && (
        <RuntimeRestartDialog
          onClose={() => setRuntimeRestart(false)}
          restart={() => api.restartWindows()}
        />
      )}
    </section>
  )
}

/** 设置页顶上那句。原来那句后面加半句会折成两行，所以整句换短；Mac 上写 ⌘K。 */
export function settingsPageLead(os: WindowOs): string {
  return `改完自动保存。找不到某一项，按 ${os === 'mac' ? '⌘K' : 'Ctrl K'} 搜它的名字。`
}

/**
 * 设置页「更新与关于」里的两个重来入口。两件事名字很像、做的事不一样：上面一行重走
 * 安装配置的四步引导，下面一行只是把首页上那几条操作提示再放一遍。
 */
export function OnboardingSettingRows({
  openGuide,
  replayTour,
}: { openGuide: () => void; replayTour?: () => void }) {
  return (
    <>
      <SettingRow
        title={settingsItemLabel('guide')}
        anchor="guide"
        description="重新走一遍安装和配置的步骤，已经填好的账号和密钥不会被清空"
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
      {replayTour ? (
        <SettingRow
          title={settingsItemLabel('tour')}
          anchor="tour"
          description="再看一遍首页上指着按钮讲的那几条提示"
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
      ) : null}
    </>
  )
}

export function SettingsPage({
  api,
  navigate,
  openLogin,
  switchAccount,
  onAccountChanged,
  onSettingsChanged,
  openGuide,
  replayTour,
  uiScale,
  chatTransfer,
  appSettings,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(async () => {
    const [settings, capabilities, session, update] = await Promise.all([
      api.getSettings(),
      api.getWindowCapabilities(),
      api.getAccountSession(),
      // 「自动更新」显不显示、「当前版本」写哪一版：读不到就当这台电脑不支持、版本暂未读到，不挡设置页。
      api.getUpdateState().catch(() => null),
    ])
    return { settings, capabilities, session, update }
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
  // 「更新」页和更新气泡里也能改这两项，改完 App 拿到的是最新的；这一页开着时跟着变。
  const checkUpdatesOnStartup = appSettings?.checkUpdatesOnStartup
  const autoUpdate = appSettings?.autoUpdate
  useEffect(() => {
    if (checkUpdatesOnStartup === undefined) return
    setResourceData((previous) => {
      if (!previous || (previous.settings.checkUpdatesOnStartup === checkUpdatesOnStartup && previous.settings.autoUpdate === autoUpdate)) return previous
      return { ...previous, settings: { ...previous.settings, checkUpdatesOnStartup, autoUpdate } }
    })
  }, [checkUpdatesOnStartup, autoUpdate, setResourceData])
  const operation = useOperation()
  const showToast = useToast().show
  const systemApi = platformApi()
  const [systemState, setSystemState] = useState<PlatformSystemState | null>(
    null,
  )
  const [systemError, setSystemError] = useState('')
  // 「重新读取」一次就加一，系统状态那一块从头再读一遍。
  const [systemAttempt, setSystemAttempt] = useState(0)
  const [proxy, setProxy] = useState<PlatformProxyStatus | null>(null)
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
  const readProxy = () => {
    if (systemApi)
      void operation.execute(
        'proxy',
        async () => setProxy(await systemApi.getProxyStatus()),
        '',
      )
  }
  const [group, setGroup] =
    useState<(typeof settingsGroups)[number]['value']>('appearance')
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
  const [logout, setLogout] = useState(false)
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
    document.documentElement.dataset.skin = settings.uiSkin ?? 'mist'
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
  const session = resource.data?.session
  const rememberedLogin = rememberedLoginAction(session)
  // 行标题从注册表取（settingsItems），顶部搜索和这里说的是同一个名字。
  const row = (id: string, description: ReactNode, control: ReactNode) => (
    <SettingRow
      key={id}
      anchor={id}
      title={settingsItemLabel(id)}
      description={description}
      control={control}
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
  const currentVersion = resource.data?.update?.currentVersion
  let content: ReactNode = null
  if (settings) {
    const groups: Record<typeof group, ReactNode> = {
      appearance: (
        <>
          {row(
            'theme',
            '外观调整会应用到整个工具箱',
            <Segment
              label="主题"
              testId="settings-theme"
              options={[
                ...(systemApi
                  ? [
                      {
                        value: 'system',
                        label: '跟随系统',
                        disabled: !systemState,
                      },
                    ]
                  : []),
                { value: 'light', label: '亮色' },
                { value: 'dark', label: '暗色' },
              ]}
              value={systemState?.preferences.themePreference ?? settings.theme}
              onChange={(theme) => {
                if (
                  systemApi &&
                  (theme === 'system' || theme === 'light' || theme === 'dark')
                )
                  void operation.execute(
                    'platform-theme',
                    async () =>
                      setSystemState(await systemApi.setThemePreference(theme)),
                    toasted('主题偏好已保存'),
                  )
                else if (theme === 'light' || theme === 'dark')
                  void update({ theme })
              }}
            />,
          )}
          {row(
            'skin',
            '四套配色，暗色和亮色模式下都适用，选完立即生效',
            <div className="v2-skin-row" role="group" aria-label="界面皮肤">
              {skinOptions.map((skin) => (
                <button
                  type="button"
                  key={skin.value}
                  className={`v2-skin-chip${(settings.uiSkin ?? 'mist') === skin.value ? ' is-active' : ''}`}
                  aria-pressed={
                    (settings.uiSkin ?? 'mist') === skin.value
                  }
                  disabled={pending > 0}
                  onClick={() => void update({ uiSkin: skin.value })}
                  data-testid={`settings-skin-${skin.value}`}
                >
                  <span
                    style={{
                      background: `linear-gradient(135deg, ${skin.bright}, ${skin.dark})`,
                    }}
                  />
                  {skin.label}
                </button>
              ))}
            </div>,
          )}
          {row(
            'ui-scale',
            '自动适应窗口；也可以按阅读习惯调整',
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
          )}
          {row(
            'large-text',
            '把说明文字和小字放大一些，看着更轻松',
            <Switch
              checked={Boolean(settings.largeText)}
              onChange={(largeText) => void update({ largeText })}
              aria-label="大字"
              testId="settings-large-text"
            />,
          )}
          {row(
            'high-contrast',
            systemState?.appearance.systemHighContrast
              ? '系统高对比度已开启；手动偏好会单独保留'
              : '加大文字、边框和按钮的对比度，开启时皮肤配色暂停使用',
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
          )}
          {row(
            'reduced-motion',
            '关闭页面过渡、滚动动画和循环装饰效果',
            <Switch
              checked={Boolean(settings.reducedMotion)}
              onChange={(reducedMotion) => void update({ reducedMotion })}
              aria-label="减少动画"
            />,
          )}
          {row(
            'hardware-acceleration',
            resource.data?.capabilities.displayCompat === 'auto'
              ? '显卡驱动刚才接连出了几次问题，这次已临时改用兼容方式显示。界面出现黑屏、花屏、闪烁或打开就闪退时关掉它，重启软件后生效。'
              : '界面出现黑屏、花屏、闪烁或打开就闪退时关掉它，重启软件后生效。',
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
                    onClick={() =>
                      void operation.execute(
                        'relaunch',
                        () => api.relaunchApp(),
                        (started) => {
                          if (!started) showToast('已取消重开', 'neutral')
                          return null
                        },
                      )
                    }
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
          {row(
            'language',
            '当前提供简体中文；AI 的回答语言由你在对话中指定',
            <Select
              aria-label="界面语言"
              disabled
              options={[{ value: 'zh-CN', label: '简体中文' }]}
              value="zh-CN"
            />,
          )}
        </>
      ),
      startup: (
        <>
          {row(
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
          )}
          {row(
            'close-behavior',
            // Linux 的任务栏不一定有放托盘图标的地方（主进程先问过），没有就只能退出。
            isLinux && resource.data && !resource.data.capabilities.tray
              ? '这台电脑的任务栏上没有放星芒图标的地方，点关闭会直接退出软件'
              : '按你的选择关闭窗口或缩到托盘',
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
          )}
          {row(
            'startup-diagnostics',
            '只检查已使用工具和当前运行环境',
            <Switch
              checked={settings.runDiagnosticsOnStartup}
              aria-label="启动时检查环境"
              onChange={(runDiagnosticsOnStartup) =>
                void update({ runDiagnosticsOnStartup })
              }
            />,
          )}
        </>
      ),
      tools: (
        <>
          {row(
            'workspace',
            '工具打开后从这个文件夹开始；请选择你信任的项目',
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
                选择文件夹
              </Button>
            </div>,
          )}
          {row(
            'latest-cli',
            '默认安装星芒验证过的推荐版本；打开后跟随官方最新版，可能遇到尚未验证的问题',
            <Switch
              checked={settings.alwaysInstallLatestCli === true}
              aria-label="命令行工具总是装最新版"
              onChange={(alwaysInstallLatestCli) =>
                void update({ alwaysInstallLatestCli })
              }
            />,
          )}
          {row(
            'terminal',
            '使用工具箱为当前系统准备的终端；此版本不支持更换终端',
            <Button
              size="sm"
              icon={BookOpen}
              onClick={() => navigate?.('tutorial', cliTutorialTopic)}
            >
              查看打开方式
            </Button>,
          )}
          {row(
            'install-location',
            '沿用你电脑上原来的安装位置，不影响别的软件',
            <Button
              size="sm"
              icon={Wrench}
              onClick={() => navigate?.('maintenance')}
            >
              去安装卸载
            </Button>,
          )}
        </>
      ),
      network: (
        <>
          <RelayRouteSettings
            settings={settings}
            saving={pending > 0}
            restarting={Boolean(operation.busy)}
            onChange={(patch) => void update(patch)}
            onRestart={() => void operation.execute(
              'relaunch',
              () => api.relaunchApp(),
              (started) => {
                if (!started) showToast('已取消重开', 'neutral')
                return null
              },
            )}
          />
          {row(
            'mirror',
            '自动选择可用来源；下载失败时可切换后重试',
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
          )}
          {row(
            'proxy',
            proxy?.note?.replaceAll('代理路由', '连接路径').replaceAll('代理', '网络设置') ??
              '可查看应用窗口的连接路径；账号请求和工具安装使用各自的连接设置。',
            systemApi ? (
              <div className="v2-business-control">
                <Pill>{proxy?.summary?.replaceAll('使用代理路由', '通过转发连接').replaceAll('代理路由', '连接路径') ?? '只读'}</Pill>
                <Button
                  size="sm"
                  icon={RefreshCw}
                  loading={operation.busy === 'proxy'}
                  onClick={readProxy}
                >
                  看连接方式
                </Button>
              </div>
            ) : (
              <Pill tone="neutral">此版本暂不支持</Pill>
            ),
          )}
          {row(
            'network-check',
            '更换网络设置后，可再次检查连接',
            <Button
              size="sm"
              icon={HeartPulse}
              onClick={() => navigate?.('health', networkDiagnosticCode)}
              testId="settings-network-health"
            >
              去检查页
            </Button>,
          )}
          {row(
            'certificate',
            '公司电脑装了专用安全证书、装工具时报证书错误，到检查页看「安全证书」那一项',
            <Button
              size="sm"
              icon={HeartPulse}
              onClick={() => navigate?.('health', certificateDiagnosticCode)}
              testId="settings-certificate-health"
            >
              去检查页
            </Button>,
          )}
        </>
      ),
      notifications: (
        <>
          {row(
            'desktop-notifications',
            '后台运行时提醒你查看结果；新版本和更新下载好的提醒也归它管',
            <Switch
              checked={settings.desktopNotifications !== false}
              disabled={!resource.data?.capabilities.notifications}
              aria-label="桌面通知"
              onChange={(desktopNotifications) =>
                void update({ desktopNotifications })
              }
            />,
          )}
          {row(
            'test-notification',
            '系统可能关闭或静音通知；应用内状态会继续保留',
            <Button
              size="sm"
              icon={Zap}
              disabled={
                !systemApi ||
                settings.desktopNotifications === false ||
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
                  toasted('已请求显示测试通知'),
                )
              }
            >
              发一条测试通知
            </Button>,
          )}
          <div className="v2-settings-section" data-testid="settings-notification-kinds">
            <h3>提醒哪些事</h3>
            {settings.desktopNotifications === false && (
              <span>桌面通知关着，下面这些都不会提醒</span>
            )}
          </div>
          {notificationOptions.filter((option) => option.value !== 'acceleration' || accelerationAvailable).map((option) =>
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
                  disabled={
                    settings.desktopNotifications === false || Boolean(operation.busy)
                  }
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
          )}
        </>
      ),
      account: (
        <>
          {row(
            'current-account',
            session?.authenticated
              ? `${session.account?.username ? `${session.account.username}。` : ''}资料、改密码、余额、密钥和订单都在个人中心`
              : '还没登录',
            session?.authenticated ? (
              <Button
                size="sm"
                icon={UserRound}
                onClick={() => navigate?.('account')}
                testId="settings-account-center"
              >
                去个人中心
              </Button>
            ) : (
              <Button
                size="sm"
                icon={UserRound}
                onClick={() => openLogin?.()}
                testId="settings-account-login"
              >
                登录
              </Button>
            ),
          )}
          {row(
            'switch-account',
            '换成这台电脑上保存过的另一个账号，或者再添加一个',
            <Button
              size="sm"
              icon={Users}
              disabled={!switchAccount}
              onClick={() => switchAccount?.()}
              testId="settings-switch-account"
            >
              切换账号
            </Button>,
          )}
          {session?.sessionOnly
            ? row('remember-password', sessionOnlyLoginNotice, null)
            : rememberedLogin.kind === 'forget'
            ? row(
                'remember-password',
                '由客户端安全存储处理；清掉后下次登录要重新输入密码',
                <Button
                  size="sm"
                  icon={Trash2}
                  loading={operation.busy === 'forget-remembered-login'}
                  onClick={() =>
                    void operation.execute(
                      'forget-remembered-login',
                      () => api.setRememberedAccountLogin(null, rememberedLogin.siteId),
                      toasted(rememberedLoginForgottenMessage),
                    )
                  }
                >
                  清掉记住的密码
                </Button>,
              )
            : row(
                'remember-password',
                '由客户端安全存储处理',
                <Button size="sm" icon={UserRound} onClick={() => openLogin?.()}>
                  管理登录
                </Button>,
              )}
          {session?.authenticated &&
            row(
              'logout',
              session.account?.username ?? '',
              <Button
                size="sm"
                variant="danger"
                icon={Trash2}
                onClick={() => setLogout(true)}
                testId="settings-logout"
              >
                退出登录
              </Button>,
            )}
        </>
      ),
      privacy: (
        <>
          {row(
            'transfer',
            chatTransfer
              ? '把软件里的聊天记录和设置存成一个文件，在新电脑上导入。文件里没有密码和 Key，新电脑上登录一下就行'
              : '把软件里的设置存成一个文件，在新电脑上导入。登录后再导出，会连当前账号的聊天记录一起带上',
            <>
              <Button
                size="sm"
                icon={Download}
                disabled={Boolean(operation.busy)}
                onClick={startExport}
                testId="settings-transfer-export"
              >
                导出
              </Button>
              <Button
                size="sm"
                icon={FolderOpen}
                disabled={Boolean(operation.busy)}
                onClick={startImport}
                testId="settings-transfer-import"
              >
                导入
              </Button>
            </>,
          )}
          {row(
            'backups',
            '恢复前会保留当前配置快照',
            <Button
              size="sm"
              icon={Archive}
              onClick={() => navigate?.('backups')}
            >
              查看备份
            </Button>,
          )}
          {row(
            'logs',
            '打开日志目录，或预览和导出脱敏报告',
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
                打开目录
              </Button>
              <Button
                size="sm"
                icon={FileText}
                onClick={() => navigate?.('feedback')}
              >
                去反馈页
              </Button>
            </>,
          )}
          {row(
            'crash-reporting',
            '出错时自动把错误堆栈、版本和系统信息发到海外的错误收集服务，帮我们更快修好；不含账号、密钥、文件路径和聊天内容',
            <Switch
              aria-label="崩溃自动上报"
              checked={settings.crashReporting !== false}
              onChange={(enabled) => void update({ crashReporting: enabled })}
            />,
          )}
          {row(
            'usage-stats',
            '只记下你的选择；目前软件不会收集或上传任何使用记录',
            systemApi && systemState ? (
              <Switch
                aria-label="匿名使用统计偏好"
                checked={
                  systemState.preferences.privacy?.anonymousUsage ?? false
                }
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
          )}
        </>
      ),
      about: (
        <>
          {row(
            'version',
            currentVersion
              ? `v${currentVersion}。点右边看这一版改了什么、检查有没有新版本`
              : '版本暂未读到',
            <Button
              size="sm"
              icon={RefreshCw}
              onClick={() => navigate?.('updates')}
            >
              查看更新
            </Button>,
          )}
          {row(
            'update-check',
            '发现新版本会提醒你',
            <Switch
              checked={settings.checkUpdatesOnStartup}
              aria-label="启动时检查新版本"
              onChange={(checkUpdatesOnStartup) =>
                void update({ checkUpdatesOnStartup })
              }
            />,
          )}
          {resource.data?.update?.autoUpdateSupported &&
            row(
              'auto-update',
              autoUpdateSettingDescription(resource.data.update.installMethod, resource.data.update.installNeedsAdminPassword),
              <Switch
                testId="settings-auto-update"
                checked={settings.autoUpdate !== false}
                aria-label="自动更新"
                onChange={(autoUpdate) => void update({ autoUpdate })}
              />,
            )}
          {row(
            'shortcuts',
            '查看当前系统使用的快捷键',
            <Button
              size="sm"
              icon={BookOpen}
              onClick={() => setShortcuts(true)}
            >
              查看快捷键
            </Button>,
          )}
          <OnboardingSettingRows
            openGuide={openGuide ?? (() => navigate?.('tutorial'))}
            replayTour={replayTour}
          />
          {row(
            'legal',
            '查看协议和数据处理说明',
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
          )}
          <AppUninstallRow
            api={api}
            isMac={isMac}
            isLinux={isLinux}
            openMaintenance={() => navigate?.('maintenance')}
          />
        </>
      ),
    }
    content = groups[group]
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
      <PageHead title="设置" lead={settingsPageLead(currentWindowOs())} />
      <ResultNotice
        error={resource.error || saveError || systemError || operation.error}
        detail={resource.error ? resource.detail : saveError || systemError ? undefined : operation.detail}
        message={operation.revealPath ? operation.message : undefined}
        revealPath={operation.revealPath || undefined}
        onReveal={(path) => api.revealExportedFile(path)}
        retry={readFailed ? { label: '重新读取', onClick: reread } : undefined}
      />
      <div className="v2-business-settings-grid">
        <nav
          className="v2-business-subnav"
          role="tablist"
          aria-label="设置分组"
          aria-orientation="vertical"
        >
          {settingsGroups.map((item, index) => (
            <button
              key={item.value}
              id={`v2-settings-${item.value}`}
              role="tab"
              type="button"
              aria-selected={group === item.value}
              aria-controls="v2-settings-panel"
              tabIndex={group === item.value ? 0 : -1}
              className={group === item.value ? 'is-active' : ''}
              onClick={() => setGroup(item.value)}
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
                setGroup(settingsGroups[target].value)
                document
                  .getElementById(`v2-settings-${settingsGroups[target].value}`)
                  ?.focus()
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div
          role="tabpanel"
          id="v2-settings-panel"
          aria-labelledby={`v2-settings-${group}`}
        >
          {/* 「正在保存更改…」挂在组名右边，不单独占一行，存的时候页面不往下跳。 */}
          <div className="v2-settings-panel-head">
            <h2>{settingsGroups.find((item) => item.value === group)?.label}</h2>
            {pending > 0 && <span role="status">正在保存更改…</span>}
          </div>
          <Card padding="none">
            {content ?? <p role="status">{resource.error ? '设置暂时没有读到' : '正在读取设置…'}</p>}
          </Card>
        </div>
      </div>
      <Dialog
        open={logout}
        title="退出登录？"
        onClose={() => setLogout(false)}
        footer={
          <>
            <Button onClick={() => setLogout(false)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() =>
                void operation.execute(
                  'logout',
                  async () => {
                    await api.logoutAccount()
                    setLogout(false)
                    await resource.reload()
                    onAccountChanged?.()
                  },
                  toasted('已退出登录'),
                )
              }
            >
              退出登录
            </Button>
          </>
        }
      >
        <p>工具里已写入的配置继续保留。</p>
      </Dialog>
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
      >
        <ListRow title="命令面板" meta="Ctrl / Command + K" />
        <ListRow title="设置" meta="Ctrl / Command + ," />
        <ListRow title="打开工具" meta="Ctrl / Command + 1–5" />
        <ListRow title="放大 / 缩小界面" meta="Ctrl / Command + 加号 / 减号" />
        <ListRow title="界面缩放恢复为自动" meta="Ctrl / Command + 0" />
        <ListRow title="关闭最上层弹窗" meta="Esc" />
      </Dialog>
    </section>
  )
}

export { tutorialTopics } from './registry/tutorials'
export { TutorialPage } from './features/tutorial/TutorialPage'
