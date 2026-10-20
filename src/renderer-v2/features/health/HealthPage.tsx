// 检查页（#1070 第 11 步，从 pages-maintenance.tsx 原样搬来）：检查结果分组、「去处理」与一键修复、连接自检
// （各家命令行工具和装好的外部客户端），运行环境那几行的安装与换新版 Node.js。pages-maintenance.tsx 照旧转出
// 这里的导出名；各业务页共用的参数类型在 business-actions.ts。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen,
  Check,
  Download,
  FolderOpen,
  Globe2,
  Info,
  KeyRound,
  PlugZap,
  RefreshCw,
  Terminal,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react'
import { Button, Card, Confirm, PageHead } from '../../ui'
import {
  RelativeTime,
  errorMessage,
  ListState,
  ResultNotice,
  useOperation,
  useReloadWhenShown,
  useResource,
} from '../../business-common'
import { tools } from '../../registry/tools'
import { isActiveProviderId, type ActiveProviderId } from '../../../../electron/catalog'
import { clientConnections } from '../../registry/clients'
import { spacedName } from '../tools/model'
import { homeNodeElevationNotice } from '../tools/elevation-notice'
import { runtimeInstallButtonShown } from '../tools/runtime-install-guide'
import { gitHostPlatform } from '../../../../electron/git-runtime'
import { connectionCheckView } from '../tools/connection-check'
import { accountScope, sessionRestoring, signedInSiteId } from '../../account-context'
import { useLatestRequest } from '../../latest-request'
import { connectionRouteOptions, connectionRouteSettings } from '../../registry/connection-routes'
import { diagnosticDetailRows } from '../app/diagnostic-details'
import { diagnosticStateLabel, groupDiagnostics, type DiagnosticGroup } from '../app/diagnostic-group'
import { canClearStaleProxy, staleProxyClearMessage, staleProxyConfirmBody } from '../app/stale-proxy'
import { diagnosticFolderTarget, diagnosticFolderUnavailableMessage } from '../app/diagnostic-folder'
import { firstProblemAnchor, useRowFocus } from '../app/row-focus'
import { diagnosticsRevision, publishDiagnosticsCounts, useDiagnosticsRevision } from '../app/environment-status'
import { diagnosticFixConfirm, diagnosticFixKind, diagnosticFixLabel, diagnosticFixLabels, diagnosticFixMessage } from '../app/diagnostic-fix'
import { canReplaceNode, nodeReplaceOffered } from '../tools/node-replace'
import type { V2Bridge, V2Page } from '../../types'
import type {
  AccountSessionState,
  DiagnosticFixKind,
  PlatformCapabilities,
} from '../../../../electron/ipc-contract'
import type { BusinessActions } from '../../business-actions'
import { installGuideTopic } from '../tools/install-result'

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
   * 只有 CLI 能就地「重新写入密钥」。外部客户端的密钥是用户在配置对话框里自己
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
// 已下线的工具（Gemini）不在这几页出现：检查结果、连接自检、任务里带着它也不认。
function isProvider(id: string): id is ActiveProviderId {
  return isActiveProviderId(id)
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
  const responsesEpoch = useLatestRequest()
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
      responsesEpoch.invalidate()
      setResponsesConsent(false)
      setResponsesResult(null)
      setResponsesError(null)
    })
    return () => {
      responsesEpoch.invalidate()
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
    const requestEpoch = responsesEpoch.begin()
    try {
      const started = await api.getAccountSession()
      if (!requestEpoch()) return
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
      if (requestEpoch() && startedScope === currentScope) {
        setResponsesResult(result)
      }
    } catch (error) {
      if (requestEpoch()) setResponsesError(errorMessage(error))
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
