import {
  useCallback,
  useEffect,
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
  HelpCircle,
  KeyRound,
  MoreHorizontal,
  PlugZap,
  RefreshCw,
  Settings,
  Trash2,
  UserRound,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import {
  BrandIcon,
  Button,
  Card,
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
} from './ui'
import {
  displayDate,
  beginBusinessOperation,
  errorMessage,
  ListState,
  ResultNotice,
  useOperation,
  useResource,
  userFacingErrorMessage,
} from './business-common'
import {
  notificationOptions,
  settingsGroups,
  skinOptions,
  updateFailureLabel,
  updateLabels,
} from './registry/business'
import { tools } from './registry/tools'
import { clientConnections } from './registry/clients'
import { canUninstallTool } from './features/tools/model'
import { elevatedInstallNotice } from './features/tools/elevation-notice'
import { ToolStatusMeta, ToolStatusReason } from './features/tools/ToolStatusMeta'
import { connectionCheckView } from './features/tools/connection-check'
import { diagnosticDetailRows } from './features/app/diagnostic-details'
import { requestSettingsGroup, takeSettingsGroup } from './features/app/settings-group-intent'
import { maintenanceFailureNotice, readMaintenanceStatus } from './features/tools/maintenance-status'
import { ManualUninstallDialog, type ManualUninstallState } from './features/tools/ManualUninstall'
import { RuntimeRestartDialog } from './features/tools/RuntimeRestartDialog'
import { describeRuntimeInstallOutcome } from './features/tools/runtime-install-outcome'
import {
  anyRuntimeLogValue,
  filterRuntimeLogs,
  formatRuntimeLogEntry,
  hasRuntimeLogFilter,
  runtimeLogSourceOptions,
  runtimeLogWriteNotice,
} from './features/app/runtime-log-filter'
import type { V2Bridge, V2Page } from './types'
import type { InstallCancelResult } from '../../electron/ipc-contract'
import type {
  PlatformProxyStatus,
  PlatformSystemState,
} from '../../electron/platform/contract'
import { platformApi } from './platform-api'

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
/** installed：装好了；restart：运行环境要重启电脑才算装完；skipped：没有开始（取消、已在装或要自己下载）。 */
export type ToolInstallOutcome = 'installed' | 'restart' | 'skipped'
export type BusinessActions = {
  navigate?: (page: V2Page) => void
  openLogin?: () => void
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
   * 首页那条完整的安装：缺 Node.js / Python 先装运行环境，装完写 Key、刷新检测。
   * 「安装卸载」页以前自己直接调主进程装工具，没装 Node.js 的人只看到「未检测到
   * npm」（全面检测 Q33）；有了它就只走这一条。
   */
  installTool?: (tool: Provider | 'codexDesktop') => Promise<ToolInstallOutcome>
  /** 与 installTool 配对的取消：首页那条安装在准备运行环境时会说明为什么不能取消。 */
  cancelToolInstall?: (tool: Provider | 'codexDesktop') => Promise<InstallCancelResult>
  /**
   * 连接自检的密钥 / 分组层给出的「重新写入 Key」：复用装完工具后那条同样的重写
   * 流程（App 的 syncAfterToolInstalled），失败时把主进程的原话抛出来，页面照实显示。
   */
  onRewriteKey?: (provider: Provider) => Promise<boolean>
  /** 哪几个工具的配置确实来自当前账号——只有它们重写得动（见 rewritableKeyProviders）。 */
  rewritableKeys?: readonly Provider[]
}
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
 * 「去处理」要落在真能处理这件事的地方。落不到的（磁盘满、系统版本、运行权限、
 * 系统里的代理和环境变量、项目文件夹里的设置……）就不给按钮：结论里已经说了怎么办，
 * 以前统一兜底到「安装卸载」，用户点过去什么也找不到。
 */
export function diagnosticTarget(code: string): V2Page | null {
  // 文件夹被搬过没有能在软件里一键修的地方，下一步是导出报告找客服。
  if (code === 'FOLDER_RELOCATED') return 'feedback'
  // 这三项在「设置」的「网络」组，跳过去时由 diagnosticFix 指定落在那一组。
  if (code === 'XINGMANG_NETWORK' || code === 'PROXY_ENVIRONMENT' || code === 'CLASH_VERGE_TUN')
    return 'settings'
  // 环境变量要用户自己在系统里删，软件里没有对应的开关。
  if (code === 'PROVIDER_ENVIRONMENT_OVERRIDE') return null
  if (
    code.startsWith('PROVIDER_') ||
    code === 'CODEX_DOTENV' ||
    code === 'CLAUDE_BYPASS_PERMISSIONS' ||
    // Git 的安装指引挂在首页的「运行环境」里，「安装卸载」页没有它那一行。
    code === 'RUNTIME_GIT'
  )
    return 'home'
  if (code.startsWith('RUNTIME_') || code.startsWith('CLI_') || code === 'CODEX_DESKTOP')
    return 'maintenance'
  return null
}

export function diagnosticHasFix(code: string): boolean {
  return diagnosticTarget(code) !== null
}

/**
 * 每个工具一条结论。未配置的工具是灰的、不是红的：一个只用 Claude Code 的
 * 用户不该在这一页上看到三条失败。
 */
function ConnectionRowNotice({
  row,
  navigate,
  canRewriteKey,
  onRewriteKey,
}: {
  row: ConnectionRow
  navigate?: (page: V2Page) => void
  canRewriteKey?: boolean
  onRewriteKey?: (provider: Provider) => void
}) {
  if (!row.result) {
    return (
      <Notice
        tone="bad"
        title={`${row.name} · 没测成`}
        body={row.error ?? '自检没能完成'}
        testId={`health-connection-error-${row.id}`}
      />
    )
  }
  const view = connectionCheckView(row.result, { canRewriteKey: canRewriteKey === true && Boolean(onRewriteKey) })
  const target = view.target
  const rewritable = view.action === 'rewrite-key' ? row.provider : null
  return (
    <Notice
      tone={view.tone}
      title={`${row.name} · ${view.statusLabel}`}
      body={
        <>
          <div>{view.title}</div>
          <div>{view.body}</div>
          {view.detail && (
            <details className="v2-connection-note">
              <summary>服务的原话（联系客服时可以附上）</summary>
              {view.detail}
            </details>
          )}
        </>
      }
      actions={
        rewritable ? (
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
              onClick={() => navigate?.(target)}
              testId={`health-connection-fix-${row.id}`}
            >
              去处理
            </Button>
          )
        )
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
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.runDiagnostics(), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const [details, setDetails] = useState<Diagnostic | null>(null)
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null)
  const [connectionBusy, setConnectionBusy] = useState(false)
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
  const fix = (item: Diagnostic) => {
    const provider = item.code.replace('PROVIDER_', '').toLowerCase()
    if (item.code.startsWith('PROVIDER_') && isProvider(provider) && openConfig) {
      openConfig(provider)
      return
    }
    const target = diagnosticTarget(item.code)
    if (!target) return
    if (target === 'settings') requestSettingsGroup('network')
    navigate?.(target)
  }
  return (
    <section
      className="v2-page"
      data-page-id="health"
      data-testid="page-health"
    >
      <PageHead
        title="检查"
        lead="逐项检查当前工具和连接；没有使用的可选环境可以先不装。"
        actions={
          <Button
            variant="primary"
            icon={RefreshCw}
            loading={resource.loading}
            onClick={() => void resource.reload()}
          >
            重新检查
          </Button>
        }
      />
      <ResultNotice
        {...operation}
        onReveal={(path) => api.revealExportedFile(path)}
      />
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
        {connections?.map((row) => (
          <ConnectionRowNotice
            key={row.id}
            row={row}
            navigate={navigate}
            canRewriteKey={row.provider !== null && rewritableKeys?.includes(row.provider)}
            onRewriteKey={onRewriteKey ? (provider) => void rewriteKey(provider) : undefined}
          />
        ))}
        {!connections && (
          <p className="v2-connection-note" data-testid="health-connection-idle">
            还没有测过。点「测试连接」，会按工具分别给结论；失败时会直接说是网络、密钥、额度、分组还是模型的问题。装好的 WorkBuddy、Claude Desktop、OpenCode 也会各测一条。
          </p>
        )}
      </Card>
      {resource.data && (
        <Toolbar
          left={
            <>
              <Pill tone="ok">正常 {resource.data.counts.pass}</Pill>
              <Pill tone="warn">需留意 {resource.data.counts.warn}</Pill>
              <Pill tone="bad">
                待处理 {resource.data.counts.fail + resource.data.counts.error}
              </Pill>
            </>
          }
          right={<span>{displayDate(resource.data.generatedAt)}</span>}
        />
      )}
      <Card padding="none">
        <ListState
          page="health"
          noun="检查结果"
          loading={resource.loading}
          error={resource.error}
          count={resource.data?.items.length ?? 0}
          retry={() => void resource.reload()}
        >
          {resource.data?.items.map((item) => (
            <ListRow
              key={item.code}
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
                  {item.state !== 'pass' && diagnosticHasFix(item.code) && (
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
          ))}
        </ListState>
      </Card>
      <Toolbar
        right={
          <Button
            icon={Download}
            disabled={resource.loading}
            onClick={() =>
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
            }
          >
            导出检查报告
          </Button>
        }
      />
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

export function FeedbackPage({
  api,
  openHelp,
  navigate,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.getRuntimeLogs(500), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState(anyRuntimeLogValue)
  const [source, setSource] = useState(anyRuntimeLogValue)
  const [onlyCurrentBoot, setOnlyCurrentBoot] = useState(false)
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
      <Notice
        tone="neutral"
        title="报告会自动脱敏"
        body="不会包含账号密码与完整密钥。发送前仍请检查私有项目名称和地址。"
        actions={
          <Button size="sm" icon={HelpCircle} onClick={openHelp}>
            联系客服
          </Button>
        }
      />
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
              options={runtimeLogSourceOptions(resource.data?.sources, source)}
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
      <Card padding="none">
        <ListState
          page="feedback"
          noun="运行日志"
          loading={resource.loading}
          error={resource.error}
          count={list.length}
          filtered={hasRuntimeLogFilter(filter)}
          retry={() => void resource.reload()}
          clear={resetFilters}
        >
          {list.map((entry) => (
            <ListRow
              key={entry.id}
              icon={FileText}
              title={entry.message}
              badge={
                <Pill
                  tone={
                    entry.level === 'error'
                      ? 'bad'
                      : entry.level === 'warn'
                        ? 'warn'
                        : 'neutral'
                  }
                >
                  {runtimeLogLevelLabels[entry.level] ?? entry.level}
                </Pill>
              }
              desc={`${displayDate(entry.timestamp)} · ${entry.source}`}
              actions={
                <Button
                  size="sm"
                  icon={FileText}
                  onClick={() => setSelected(entry)}
                >
                  详情
                </Button>
              }
            />
          ))}
        </ListState>
      </Card>
      {resource.data?.truncated && <p>已限制为最近日志。</p>}
      <Toolbar
        left={
          <Button
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
        }
        right={
          <Button
            variant="danger"
            icon={Trash2}
            onClick={() => setClearOpen(true)}
          >
            清除日志
          </Button>
        }
      />
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
                  () => api.copyFeedbackReport(report.id),
                  '报告已复制',
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
                  () => api.exportFeedbackReport(report.id),
                  (result) =>
                    result
                      ? {
                          text: `反馈报告已导出：${result.outputPath}`,
                          revealPath: result.outputPath,
                        }
                      : null,
                )
              }
            >
              导出文件
            </Button>
          </>
        }
      >
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
          <dd>{selected?.source}</dd>
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
        <ResultNotice error={operation.error} />
      </Dialog>
    </section>
  )
}

export function UpdatesPage({
  api,
  navigate,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.getUpdateState(), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const [confirm, setConfirm] = useState(false)
  useEffect(() => api.onUpdateState(resource.setData), [api, resource.setData])
  const update = resource.data
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
  // A rejected package leaves the updater in the error phase, where downloadUpdate
  // alone would fail: the retry has to re-check before it has anything to fetch.
  const redownload = () =>
    void operation.execute(
      'download',
      async () => {
        const checked = await api.checkForUpdates()
        resource.setData(checked.phase === 'available' ? await api.downloadUpdate() : checked)
      },
      '',
    )
  // 失败在哪一步，重试就从哪一步接着走：检查失败重新检查，安装失败直接回到那个
  // 重启确认框（安装包已经下好并校验过，不必再下一遍）。
  const failure = updateFailureLabel(update?.failedStep)
  const retryFailedStep = () => {
    if (update?.failedStep === 'check') { check(); return }
    if (update?.failedStep === 'install') { setConfirm(true); return }
    redownload()
  }
  const action =
    update?.phase === 'available' || update?.phase === 'cancelled' ? (
      <Button variant="primary" icon={Download} onClick={download}>
        下载更新
      </Button>
    ) : update?.phase === 'downloaded' ? (
      <Button
        variant="primary"
        icon={RefreshCw}
        onClick={() => setConfirm(true)}
      >
        重启安装
      </Button>
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
      <PageHead title="更新" lead="下载和安装由你确认。" />
      <ResultNotice
        error={resource.error || operation.error}
        message={operation.message}
      />
      <div className="v2-business-update-grid">
        <Card
          title={update ? updateLabels[update.phase] : '正在读取更新状态…'}
          actions={action}
        >
          <ListRow
            icon={RefreshCw}
            title="当前版本"
            meta={update?.currentVersion ?? '暂未读到'}
          />
          <ListRow title="上次检查" meta={displayDate(update?.checkedAt)} />
          {update?.unsignedChannel && (
            <ListRow
              title="更新方式"
              meta="每次下载和安装新版本前都会先问你"
              testId="updates-channel-unsigned"
            />
          )}
          <ListRow
            title="启动时检查"
            actions={
              <Button
                size="sm"
                icon={Settings}
                onClick={() => navigate?.('settings')}
              >
                去设置
              </Button>
            }
          />
          {update?.progress && (
            <Progress
              value={update.progress.percent}
              label={`${update.progress.percent.toFixed(0)}%`}
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
                  <Button
                    size="sm"
                    icon={!update.failedStep || update.failedStep === 'download' ? Download : RefreshCw}
                    onClick={retryFailedStep}
                  >
                    {failure.retry}
                  </Button>
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
          {update?.development && <p>当前是开发运行环境。</p>}
        </Card>
        <Card title={`${update?.availableVersion ?? ''} 更新内容`}>
          <div className="v2-business-release-notes">
            {update?.releaseNotesText || '暂无更新说明。'}
          </div>
          <details>
            <summary>安装前需要知道</summary>
            <p>
              先保存工具中尚未完成的内容。关闭保护会检查未保存任务，确认后再安装。
            </p>
          </details>
        </Card>
      </div>
      <Dialog
        open={confirm}
        title="重启并安装更新？"
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
                    await api.installUpdate()
                    setConfirm(false)
                  },
                  '安装请求已提交',
                )
              }
            >
              确认重启安装
            </Button>
          </>
        }
      >
        <p>请先保存当前工作。安装完成后重新打开工具箱。</p>
        <ResultNotice error={operation.error} />
      </Dialog>
    </section>
  )
}

export function installResultMessage(result: ToolInstallOutcome | 'cancelled'): string {
  if (result === 'cancelled') return '安装已取消'
  if (result === 'restart') return '运行环境已装好，重启电脑后再点一次「安装」'
  if (result === 'skipped') return '这个工具正在安装，等它做完就好'
  return '安装完成，工具状态已更新'
}

export function MaintenancePage({
  api,
  navigate,
  onToolsChanged,
  installTool,
  cancelToolInstall,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => readMaintenanceStatus(api), [api])
  const resource = useResource(load)
  const snapshot = resource.data?.snapshot ?? null
  const capability = resource.data?.capability ?? null
  const failures = resource.data?.failures ?? []
  // 检测那一块没读到时，页面对「装没装」毫无根据，所以这些行只报未知，
  // 不把缺省值当成结论（对照本文件里 detectionFailed 的同一条理由）。
  const statusUnknown = Boolean(resource.data) && snapshot === null
  const operation = useOperation()
  const [logs, setLogs] = useState<string[]>([])
  const [remove, setRemove] = useState<Provider | 'codexDesktop' | null>(null)
  // 主进程拒绝取消时的中文原因，和检测失败共用页面顶部那条提示。
  const [cancelNotice, setCancelNotice] = useState('')
  const [cancelling, setCancelling] = useState('')
  const cancelRequested = useRef(new Set<string>())
  const [manualUninstall, setManualUninstall] = useState<ManualUninstallState | null>(null)
  const [runtimeRestart, setRuntimeRestart] = useState(false)
  useEffect(() => {
    const stopCli = api.onInstallProgress((event) =>
      setLogs((previous) => [...previous.slice(-199), event.message]),
    )
    const stopDesktop = api.onCodexDesktopInstallProgress((event) =>
      setLogs((previous) => [...previous.slice(-199), event.message]),
    )
    return () => {
      stopCli()
      stopDesktop()
    }
  }, [api])
  const install = (id: Provider | 'codexDesktop') =>
    void operation.execute(
      id,
      async () => {
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
        }
        // 先让 App 写 Key 并刷新全局检测，再读本页数据：顺序反过来这一页会先
        // 拿到一份还没配置 Key 的快照，而提示语已经说「工具状态已更新」。
        await onToolsChanged?.(id)
        await resource.reload()
        return 'installed' as const
      },
      (result) => installResultMessage(result),
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
        if (id === 'codexDesktop') await api.checkCodexDesktopUpdate()
        else await api.checkCliUpdate(id)
        await resource.reload()
      },
      '工具版本已检查',
    )
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
      <Card title="工具">
        <div className="v2-business-table-head">
          <span>工具</span>
          <span>版本与状态</span>
          <span>操作</span>
        </div>
        {tools.map((tool) => {
          const id = tool.id
          if (!isProvider(id) && id !== 'codexDesktop') return null
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
          const rescan = statusUnknown || detectionFailed
          return (
            <ListRow
              key={id}
              testId={'maintenance-tool-' + id}
              title={
                <>
                  <BrandIcon tool={id} size={32} />
                  {tool.name}
                </>
              }
              desc={
                <ToolStatusReason
                  lead={withElevationNotice(
                    tool.vendor,
                    id === 'codexDesktop' && !status?.installed && !rescan
                      ? elevatedInstallNotice('codexDesktop', capability?.platform, capability?.codexDesktop.install)
                      : null,
                  )}
                  status={status}
                  statusUnknown={statusUnknown}
                  testId={'maintenance-reason-' + id}
                />
              }
              meta={
                <ToolStatusMeta
                  version={version}
                  status={status}
                  statusUnknown={statusUnknown}
                  testId={'maintenance-state-' + id}
                />
              }
              actions={
                <>
                  <Button
                    size="sm"
                    icon={rescan || status?.installed ? RefreshCw : Download}
                    disabled={
                      statusUnknown
                        ? resource.loading
                        : (!managed && !detectionFailed) || Boolean(operation.busy)
                    }
                    onClick={() =>
                      statusUnknown
                        ? void resource.reload()
                        : detectionFailed
                          ? check(id)
                          : install(id)
                    }
                  >
                    {rescan ? '重新检测' : status?.installed ? '重新安装' : '安装'}
                  </Button>
                  {operation.busy === id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={X}
                      loading={cancelling === id}
                      onClick={() => cancelInstall(id)}
                      testId={'maintenance-cancel-' + id}
                    >
                      {cancelling === id ? '取消中' : '取消'}
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
                              onSelect: () => navigate?.('tutorial'),
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
      </Card>
      <Card title="运行环境">
        {(['node', 'python'] as const).map((id) => {
          const status = snapshot?.runtime[id]
          const managed =
            id === 'node'
              ? capability?.nodeRuntimeInstall === 'managed'
              : capability?.pythonRuntimeInstall === 'managed'
          return (
            <ListRow
              key={id}
              testId={'maintenance-runtime-' + id}
              icon={Wrench}
              title={id === 'node' ? 'Node.js' : 'Python'}
              desc={
                <ToolStatusReason
                  lead={withElevationNotice(
                    id === 'node'
                      ? '命令行工具需要的运行环境'
                      : '部分工具需要的可选运行环境',
                    id === 'node' && !status?.installed && !statusUnknown && !status?.detectionFailed
                      ? elevatedInstallNotice('node', capability?.platform, capability?.nodeRuntimeInstall)
                      : null,
                  )}
                  status={status}
                  statusUnknown={statusUnknown}
                  testId={'maintenance-runtime-reason-' + id}
                />
              }
              meta={
                <ToolStatusMeta
                  version={status?.version}
                  status={status}
                  statusUnknown={statusUnknown}
                  testId={'maintenance-runtime-state-' + id}
                />
              }
              actions={
                <Button
                  size="sm"
                  icon={Download}
                  disabled={Boolean(operation.busy)}
                  onClick={() =>
                    managed
                      ? void operation.execute(
                          id,
                          async () => {
                            const result = id === 'node'
                              ? await api.installNodeRuntime()
                              : await api.installPythonRuntime()
                            await resource.reload()
                            return describeRuntimeInstallOutcome(id, result)
                          },
                          (outcome) => {
                            // 3010：结果条照样说清楚，另外弹重启确认（第七批 5）。
                            if (outcome.restartRequired) setRuntimeRestart(true)
                            return outcome.message
                          },
                        )
                      : navigate?.('tutorial')
                  }
                >
                  {managed ? '安装' : '安装指南'}
                </Button>
              }
            />
          )
        })}
      </Card>
      <Card
        title="安装日志"
        actions={
          <Button
            size="sm"
            icon={Copy}
            disabled={!logs.length}
            onClick={() =>
              void operation.execute(
                'copy-log',
                () => navigator.clipboard.writeText(logs.join('\n')),
                '安装日志已复制',
              )
            }
          >
            复制
          </Button>
        }
      >
        <pre className="v2-business-code" role="log">
          {logs.join('\n') || '开始安装后，这里会显示进度。'}
        </pre>
      </Card>
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
                      const result =
                        remove === 'codexDesktop'
                          ? await api.uninstallCodexDesktop()
                          : await api.uninstallCli(remove)
                      if (result.outcome === 'manual-required') {
                        // The backend text promises a copyable cleanup command,
                        // so it has to reach a surface that can show one.
                        setManualUninstall({
                          name:
                            tools.find((tool) => tool.id === remove)?.name ??
                            remove,
                          reason: result.manualHelp.reason,
                          manualCommand: result.manualHelp.manualCommand,
                        })
                        setRemove(null)
                        await resource.reload()
                        // Still a failed uninstall: the page must not claim
                        // success while files are left on disk.
                        throw new Error(result.error)
                      }
                      if (result.outcome === 'delegated')
                        throw new Error(
                          '已打开卸载窗口，请完成卸载后重新检测。',
                        )
                      setRemove(null)
                      await resource.reload()
                    },
                    '工具已卸载，配置已保留',
                  )
              }}
            >
              确认卸载
            </Button>
          </>
        }
      >
        <p>卸载所选工具程序，保留账号与工具配置。需要时可重新安装。</p>
        <ResultNotice error={operation.error} />
      </Dialog>
      {manualUninstall && (
        <ManualUninstallDialog
          state={manualUninstall}
          platform={capability?.platform}
          onClose={() => setManualUninstall(null)}
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

export function createSettingsQueue(
  save: V2Bridge['saveSettings'],
  onSaved: (settings: AppSettings) => void,
) {
  let tail: Promise<unknown> = Promise.resolve()
  return (patch: SettingsUpdate) => {
    const finish = beginBusinessOperation('保存设置')
    const task = tail
      .catch(() => undefined)
      .then(() => save(patch))
      .then((value) => {
        onSaved(value)
        return value
      })
      .finally(finish)
    tail = task
    return task
  }
}

function UnsupportedControl({ label }: { label: string }) {
  return (
    <Pill tone="neutral">
      {label === '当前运行环境' ? '此版本暂不支持' : label}
    </Pill>
  )
}

/**
 * 设置页「关于」里的两个重来入口。两件事名字很像、做的事不一样：上面一行重走
 * 安装配置的四步引导，下面一行只是把首页上那几条操作提示再放一遍。
 */
export function OnboardingSettingRows({
  openGuide,
  replayTour,
}: { openGuide: () => void; replayTour?: () => void }) {
  return (
    <>
      <SettingRow
        title="新手引导"
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
          title="界面导览"
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
  onAccountChanged,
  onSettingsChanged,
  openGuide,
  replayTour,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(async () => {
    const [settings, capabilities, session] = await Promise.all([
      api.getSettings(),
      api.getWindowCapabilities(),
      api.getAccountSession(),
    ])
    return { settings, capabilities, session }
  }, [api])
  const resource = useResource(load)
  const operation = useOperation()
  const systemApi = platformApi()
  const [systemState, setSystemState] = useState<PlatformSystemState | null>(
    null,
  )
  const [systemError, setSystemError] = useState('')
  const [proxy, setProxy] = useState<PlatformProxyStatus | null>(null)
  useEffect(() => {
    if (!systemApi) return
    let active = true
    let revision = 0
    const accept = (state: PlatformSystemState) => {
      if (active) {
        setSystemState(state)
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
  }, [systemApi])
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
  const [pending, setPending] = useState(0)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState('')
  const [legal, setLegal] = useState<Awaited<
    ReturnType<V2Bridge['getLegalDocument']>
  > | null>(null)
  const [logout, setLogout] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
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
  }
  const writer = useMemo(
    () =>
      createSettingsQueue(
        (patch) => api.saveSettings(patch),
        (settings) => onSaved.current(settings),
      ),
    [api],
  )
  const update = async (patch: Omit<SettingsUpdate, 'version'>) => {
    setPending((value) => value + 1)
    setSaveError('')
    setSaved('')
    try {
      await writer({ version: 2, ...patch })
      setSaved('已保存')
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setPending((value) => value - 1)
    }
  }
  const settings = resource.data?.settings
  const row = (title: string, description: string, control: ReactNode) => (
    <SettingRow
      key={title}
      title={title}
      description={description}
      control={control}
    />
  )
  const unavailable = (title: string, description: string) =>
    row(
      title,
      description,
      <Button size="sm" icon={BookOpen} onClick={() => navigate?.('tutorial')}>
        查看使用步骤
      </Button>,
    )
  let content: ReactNode = null
  if (settings) {
    const groups: Record<typeof group, ReactNode> = {
      appearance: (
        <>
          {row(
            '主题',
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
                    '主题偏好已保存',
                  )
                else if (theme === 'light' || theme === 'dark')
                  void update({ theme })
              }}
            />,
          )}
          {row(
            '界面皮肤',
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
            '界面缩放',
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
            '高对比度',
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
                    '高对比度偏好已保存',
                  )
                }
              />
            ) : (
              <UnsupportedControl label="当前运行环境" />
            ),
          )}
          {row(
            '减少动画',
            '关闭页面过渡、滚动动画和循环装饰效果',
            <Switch
              checked={Boolean(settings.reducedMotion)}
              onChange={(reducedMotion) => void update({ reducedMotion })}
              aria-label="减少动画"
            />,
          )}
          {row(
            '语言',
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
            '开机自动启动',
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
            ) : (
              <UnsupportedControl label="当前运行环境" />
            ),
          )}
          {row(
            '点关闭按钮时',
            '按你的选择关闭窗口或缩到托盘',
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
            '启动时检查新版本',
            '只显示提醒，下载和安装由你确认',
            <Switch
              checked={settings.checkUpdatesOnStartup}
              aria-label="启动时检查新版本"
              onChange={(checkUpdatesOnStartup) =>
                void update({ checkUpdatesOnStartup })
              }
            />,
          )}
          {row(
            '启动时检查环境',
            '只检查已使用工具和当前运行环境',
            <Switch
              checked={settings.runDiagnosticsOnStartup}
              aria-label="启动时检查环境"
              onChange={(runDiagnosticsOnStartup) =>
                void update({ runDiagnosticsOnStartup })
              }
            />,
          )}
          {row(
            '命令行工具总是装最新版',
            '默认安装星芒验证过的推荐版本；打开后跟随官方最新版，可能遇到尚未验证的问题',
            <Switch
              checked={settings.alwaysInstallLatestCli === true}
              aria-label="命令行工具总是装最新版"
              onChange={(alwaysInstallLatestCli) =>
                void update({ alwaysInstallLatestCli })
              }
            />,
          )}
        </>
      ),
      tools: (
        <>
          {row(
            '默认工作文件夹',
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
                更换
              </Button>
            </div>,
          )}
          {row(
            '用哪个终端打开工具',
            '使用工具箱为当前系统准备的终端；此版本不支持更换终端',
            <Button
              size="sm"
              icon={BookOpen}
              onClick={() => navigate?.('tutorial')}
            >
              查看打开方式
            </Button>,
          )}
          {row(
            '工具装在哪里',
            '沿用你电脑上原来的安装位置，不影响别的软件',
            <Button
              size="sm"
              icon={Wrench}
              onClick={() => navigate?.('maintenance')}
            >
              查看安装状态
            </Button>,
          )}
          {row(
            '连哪台服务器',
            '新配置默认采用的星芒连接方式；现有工具可单独调整',
            <Pill>星芒 AI</Pill>,
          )}
        </>
      ),
      network: (
        <>
          {row(
            '下载来源',
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
            '网络连接',
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
                  查看路由
                </Button>
              </div>
            ) : (
              <UnsupportedControl label="当前运行环境" />
            ),
          )}
          {row(
            '网络检查',
            '更换网络设置后，可再次检查连接',
            <Button
              size="sm"
              icon={HeartPulse}
              onClick={() => navigate?.('health')}
            >
              去检查
            </Button>,
          )}
          {unavailable(
            '企业证书',
            '公司要求使用专用证书时，先向管理员确认来源',
          )}
        </>
      ),
      notifications: (
        <>
          {row(
            '桌面通知',
            '后台运行时提醒你查看结果',
            <Switch
              checked={Boolean(settings.desktopNotifications)}
              disabled={!resource.data?.capabilities.notifications}
              aria-label="桌面通知"
              onChange={(desktopNotifications) =>
                void update({ desktopNotifications })
              }
            />,
          )}
          {notificationOptions.map((option) =>
            row(
              option.label,
              option.description,
              systemApi && systemState ? (
                <Switch
                  aria-label={`${option.label}通知`}
                  checked={
                    systemState.preferences.notifications?.[option.value] ??
                    true
                  }
                  disabled={
                    !settings.desktopNotifications || Boolean(operation.busy)
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
                      '通知偏好已保存',
                    )
                  }
                />
              ) : (
                <UnsupportedControl label="此版本暂不支持" />
              ),
            ),
          )}
          {row(
            '新版本可用',
            '新版本和更新下载完成提醒随桌面通知总开关控制',
            <Pill>{settings.desktopNotifications ? '已开启' : '已关闭'}</Pill>,
          )}
          {row(
            '看看长什么样',
            '系统可能关闭或静音通知；应用内状态会继续保留',
            <Button
              size="sm"
              icon={Zap}
              disabled={
                !systemApi ||
                !settings.desktopNotifications ||
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
                  '已请求显示测试通知',
                )
              }
            >
              发一条测试通知
            </Button>,
          )}
        </>
      ),
      account: (
        <>
          {row(
            '记住密码',
            '由客户端安全存储处理',
            <Button size="sm" icon={UserRound} onClick={openLogin}>
              管理登录
            </Button>,
          )}
          {row(
            '退出登录',
            resource.data?.session.account?.username ?? '当前未登录',
            resource.data?.session.authenticated ? (
              <Button
                size="sm"
                variant="danger"
                icon={Trash2}
                onClick={() => setLogout(true)}
              >
                退出
              </Button>
            ) : (
              <Button size="sm" icon={UserRound} onClick={openLogin}>
                登录
              </Button>
            ),
          )}
        </>
      ),
      privacy: (
        <>
          {row(
            '崩溃自动上报',
            '应用出错时自动回传错误堆栈和版本、系统信息，帮助我们更快修好；不包含你的账号、密钥、文件路径和聊天内容',
            <Switch
              aria-label="崩溃自动上报"
              checked={settings.crashReporting !== false}
              onChange={(enabled) => void update({ crashReporting: enabled })}
            />,
          )}
          {row(
            '使用统计',
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
                    '偏好已保存在本机，没有上传使用记录',
                  )
                }
              />
            ) : (
              <UnsupportedControl label="未收集使用统计" />
            ),
          )}
          {row(
            '本机日志',
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
                查看报告
              </Button>
            </>,
          )}
          {row(
            '以前的设置',
            '升级后沿用你以前的设置和工具配置，不用重新设置',
            <Pill>已沿用</Pill>,
          )}
          {row(
            '工具配置备份',
            '恢复前会保留当前配置快照',
            <Button
              size="sm"
              icon={Archive}
              onClick={() => navigate?.('backups')}
            >
              查看备份
            </Button>,
          )}
        </>
      ),
      about: (
        <>
          {row(
            '星芒 AI 管理工具',
            '应用版本与更新说明',
            <Button
              size="sm"
              icon={RefreshCw}
              onClick={() => navigate?.('updates')}
            >
              查看更新
            </Button>,
          )}
          {row(
            '快捷键',
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
            '用户协议与隐私政策',
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
          {row(
            '卸载',
            '可选择卸载工具并保留配置',
            <Button
              size="sm"
              icon={Trash2}
              onClick={() => navigate?.('maintenance')}
            >
              查看安装卸载
            </Button>,
          )}
        </>
      ),
    }
    content = groups[group]
  }
  return (
    <section
      className="v2-page"
      data-page-id="settings"
      data-testid="page-settings"
    >
      <PageHead
        title="设置"
        lead="外观调整即时显示，其他设置会提示保存结果。"
      />
      <ResultNotice
        error={resource.error || saveError || systemError || operation.error}
        message={operation.message || saved}
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
          <h2>{settingsGroups.find((item) => item.value === group)?.label}</h2>
          {pending > 0 && <p role="status">正在保存更改…</p>}
          <Card padding="none">
            {content ?? <p role="status">正在读取设置…</p>}
          </Card>
        </div>
      </div>
      <Dialog
        open={logout}
        title="退出当前账号？"
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
                  '已退出登录',
                )
              }
            >
              退出登录
            </Button>
          </>
        }
      >
        <p>工具中已写入的配置继续保留。</p>
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
        <ListRow title="关闭最上层弹窗" meta="Esc" />
      </Dialog>
    </section>
  )
}

export { tutorialTopics } from './registry/tutorials'
export { TutorialPage } from './features/tutorial/TutorialPage'
