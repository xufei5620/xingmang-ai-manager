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
  Search,
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
  Empty,
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
import { canUninstallTool } from './features/tools/model'
import { ToolStatusMeta, ToolStatusReason } from './features/tools/ToolStatusMeta'
import { connectionCheckView } from './features/tools/connection-check'
import { maintenanceFailureNotice, readMaintenanceStatus } from './features/tools/maintenance-status'
import { ManualUninstallDialog, type ManualUninstallState } from './features/tools/ManualUninstall'
import type { V2Bridge, V2Page } from './types'
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
  provider: Provider
  name: string
  result: ConnectionCheck | null
  error: string | null
}
// 展示顺序只有一套，以 registry/tools.ts 的数组次序为准（R-S11）。桌面端没有
// 自己的 CLI 配置文件，自检无从下手，所以只取 CLI。
const connectionTools = tools.filter((tool): tool is typeof tool & { id: Provider } => tool.kind === 'cli')
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

export function diagnosticTarget(code: string): V2Page {
  if (
    code.includes('PROXY') ||
    code === 'XINGMANG_NETWORK' ||
    code === 'CLASH_VERGE_TUN'
  )
    return 'settings'
  if (
    code.startsWith('PROVIDER_') ||
    code === 'CODEX_DOTENV' ||
    code === 'CLAUDE_BYPASS_PERMISSIONS'
  )
    return 'home'
  return 'maintenance'
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
        testId={`health-connection-error-${row.provider}`}
      />
    )
  }
  const view = connectionCheckView(row.result, { canRewriteKey: canRewriteKey === true && Boolean(onRewriteKey) })
  const target = view.target
  return (
    <Notice
      tone={view.tone}
      title={`${row.name} · ${view.statusLabel}`}
      body={
        <>
          <div>{view.title}</div>
          <div>{view.body}</div>
          {view.endpoint && (
            <div className="v2-connection-note">请求地址：{view.endpoint}</div>
          )}
          {view.detail && (
            <div className="v2-connection-note">服务返回：{view.detail}</div>
          )}
        </>
      }
      actions={
        view.action === 'rewrite-key' ? (
          <Button
            size="sm"
            icon={KeyRound}
            onClick={() => onRewriteKey?.(row.provider)}
            testId={`health-connection-rewrite-${row.provider}`}
          >
            重新写入 Key
          </Button>
        ) : (
          target && (
            <Button
              size="sm"
              icon={Wrench}
              onClick={() => navigate?.(target)}
              testId={`health-connection-fix-${row.provider}`}
            >
              去处理
            </Button>
          )
        )
      }
      testId={`health-connection-result-${row.provider}`}
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
    // 一个工具失败不该把另外三个的结论吞掉，所以每个工具各自收口。
    setConnections(await Promise.all(connectionTools.map(async (tool) => {
      try {
        return { provider: tool.id, name: tool.name, result: await api.checkProviderConnection(tool.id), error: null }
      } catch (error) {
        return { provider: tool.id, name: tool.name, result: null, error: errorMessage(error) }
      }
    })))
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
    if (item.code.startsWith('PROVIDER_') && isProvider(provider) && openConfig)
      openConfig(provider)
    else navigate?.(diagnosticTarget(item.code))
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
      <ResultNotice {...operation} />
      <Card
        title="连接自检"
        meta="用每个工具配置里真正写着的密钥和模型各测一次；上面的检查只证明网络通，这一条证明你现在能用。"
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
            key={row.provider}
            row={row}
            navigate={navigate}
            canRewriteKey={rewritableKeys?.includes(row.provider)}
            onRewriteKey={onRewriteKey ? (provider) => void rewriteKey(provider) : undefined}
          />
        ))}
        {!connections && (
          <p className="v2-connection-note" data-testid="health-connection-idle">
            还没有测过。点「测试连接」，会按工具分别给结论；失败时会直接说是网络、密钥、额度、分组还是模型的问题。
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
                  {item.state !== 'pass' && (
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
                  result ? `诊断报告已导出：${result.outputPath}` : null,
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
          {Object.entries(details?.details ?? {}).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value === null ? '未提供' : String(value)}</dd>
            </div>
          ))}
        </dl>
      </Drawer>
    </section>
  )
}

export function FeedbackPage({
  api,
  openHelp,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.getRuntimeLogs(500), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const [report, setReport] = useState<Awaited<
    ReturnType<V2Bridge['getFeedbackReport']>
  > | null>(null)
  const [selected, setSelected] = useState<RuntimeLog | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const list =
    resource.data?.entries.filter(
      (entry) =>
        (level === 'all' || entry.level === level) &&
        `${entry.message} ${entry.source} ${entry.event}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) ?? []
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
      <Toolbar
        left={
          <Segment
            options={[
              { value: 'all', label: '全部' },
              { value: 'error', label: '错误' },
              { value: 'warn', label: '提醒' },
              { value: 'info', label: '信息' },
            ]}
            value={level}
            onChange={setLevel}
          />
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
      <ResultNotice {...operation} />
      <Card padding="none">
        <ListState
          page="feedback"
          noun="运行日志"
          loading={resource.loading}
          error={resource.error}
          count={list.length}
          filtered={Boolean(query || level !== 'all')}
          retry={() => void resource.reload()}
          clear={() => {
            setQuery('')
            setLevel('all')
          }}
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
                  {entry.level}
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
                    result ? `诊断报告已导出：${result.outputPath}` : null,
                )
              }
            >
              导出文件
            </Button>
          </>
        }
      >
        <ResultNotice {...operation} />
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
              title="更新通道"
              meta="未签名，下载和安装都要你确认"
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

export function MaintenancePage({
  api,
  navigate,
  onToolsChanged,
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
      (result) => result === 'cancelled' ? '安装已取消' : '安装完成，工具状态已更新',
    )
  const cancelInstall = (id: Provider | 'codexDesktop') => {
    cancelRequested.current.add(id)
    setCancelling(id)
    setCancelNotice('')
    const requested = id === 'codexDesktop' ? api.cancelCodexDesktopInstall() : api.cancelCliInstall(id)
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
                  lead={tool.vendor}
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
                  lead={
                    id === 'node'
                      ? '命令行工具需要的运行环境'
                      : '部分工具需要的可选运行环境'
                  }
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
                            if (id === 'node') await api.installNodeRuntime()
                            else await api.installPythonRuntime()
                            await resource.reload()
                          },
                          '运行环境已准备',
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
              : '加深边框和次要文字',
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
            systemState?.startup.note ?? '登录电脑后自动打开工具箱',
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
            'npm 全局包装到哪',
            '继续使用已有的用户安装目录，避免影响其他工具',
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
            '仅保存匿名统计偏好。此版本不会自动收集或上传使用记录',
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
            '从旧版本迁移',
            '当前继续读取原有设置和配置，旧界面保留用于回滚',
            <Pill>共用原数据格式</Pill>,
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

export const tutorialTopics = [
  {
    id: 'start',
    title: '开始使用',
    lead: '先记住两条提醒，再选工具开始；安装和连接分开完成。',
    steps: [
      {
        title: '先记住两件事',
        detail:
          'AI 写出来的代码和给出的结论都可能出错，合并或执行之前自己再过一遍。粘贴来路不明的网页、文档或日志时留个心眼，里面可能藏着让 AI 去做别的事的指令。',
        action: '返回首页',
        page: 'home',
      },
      {
        title: '选择开始方式',
        detail:
          '在首页选择 Claude Code、Codex CLI、Codex 桌面端、Gemini CLI、Grok CLI，或先聊天。',
        action: '返回首页',
        page: 'home',
      },
      {
        title: '准备工具',
        detail:
          '只安装所选工具需要的运行环境。桌面端和聊天不需要先安装所有命令行工具。Windows 上用 Claude Code 时建议再装一个 Git：没有它，Claude Code 会退回 PowerShell，技能和插件里写的命令可能失败，第一次装官方插件市场也需要它。检查页会单独列出 Git，缺了会给下载地址。',
        action: '查看安装状态',
        page: 'maintenance',
      },
      {
        title: '连接账号',
        detail: '登录星芒账号后，为选择的工具配置可用密钥和模型。',
        action: '查看个人中心',
        page: 'account',
      },
    ],
  },
  {
    id: 'config',
    title: '工具配置与模型',
    lead: '配置页选账号，工具里开始工作。',
    steps: [
      {
        title: '打开工具配置',
        detail: '在首页工具行打开账号与模型配置。',
        action: '打开首页',
        page: 'home',
      },
      {
        title: '选择模型与文件夹',
        detail:
          '星芒连接可选择默认模型；官方账号的模型在官方工具内选择。只授予可信文件夹访问权限。',
        action: '查看工具设置',
        page: 'settings',
      },
      {
        title: '保存后打开',
        detail:
          'Codex CLI 与桌面端共用配置。工具正在运行时，先保存重要内容，再按提示重新打开。',
        action: '返回首页',
        page: 'home',
      },
    ],
  },
  {
    id: 'mcp',
    title: '外接工具',
    lead: '外接工具给 AI 接上浏览器、本机文件或别的服务，让它不只是聊天。每个工具的连接各管各的，先选工具再添加。',
    steps: [
      {
        title: '先看它能做什么',
        detail:
          '一条连接就是给 AI 多一项本事：接上「本地文件」它才能读写你指定的文件夹，接上「浏览器」它才能自己打开网页。还没添加过时列表是空的，属于正常。',
        action: '打开外接工具',
        page: 'mcp',
      },
      {
        title: '添加一条连接',
        detail:
          '页面顶部先选要给哪个工具添加，再点「添加连接」。填好连接名称，选「网络服务」就填服务地址，选「本地程序」就填要运行的程序名，参数按 JSON 字符串数组填。页面上的「星芒精选」卡里已经挑好了几项常用的，每一项都写清了它能让 AI 多做什么、会拿到什么权限，点「安装」会先让你确认一次，第一次建议从它们开始。',
        action: '打开外接工具',
        page: 'mcp',
      },
      {
        title: '确认真的接上了',
        detail:
          '添加成功后列表里会多出一行，显示名称和地址。这一行如果写着「尚未登录」，在「更多操作」里点「登录授权」，变成「已授权」才算好。最后在工具里问一句非得用上这条连接才能回答的话，看它会不会用。',
        action: '打开外接工具',
        page: 'mcp',
      },
      {
        title: '加不上怎么办',
        detail:
          '提示「请填写连接地址或本地程序。」是地址那一栏还空着。提示参数或环境变量格式不对，是那两栏没按 JSON 写：参数要写成字符串数组，环境变量要写成名称和值都是文字的对象。页面顶部出现「当前工具未提供管理能力」，多半是这个工具还没装好，去安装卸载页确认一下。',
        action: '打开安装卸载',
        page: 'maintenance',
      },
    ],
  },
  {
    id: 'skills',
    title: '技能',
    lead: '技能是把一套常用做法写下来交给 AI，遇到对得上的活它就照着做，不用你每次重复交代。',
    steps: [
      {
        title: '先看技能是什么',
        detail:
          '一个技能就是一份写明「遇到什么情况、按什么步骤做」的说明。列表里带「系统内置」的随应用一起维护，只能查看；其余的是你自己或在工具里加进去的。',
        action: '打开技能',
        page: 'skills',
      },
      {
        title: '添加自己的技能',
        detail:
          '顶部选好工具后点「导入技能」。Codex CLI 填技能文件夹在本机的位置，Gemini CLI 填技能来源，再选是「我的（全局）」还是「当前项目」。Claude Code 和 Grok CLI 这里不提供导入入口，页面上会直接说明；按这两个工具自己的方式把技能放好，回到本页重新加载就能看到。',
        action: '打开技能',
        page: 'skills',
      },
      {
        title: '确认生效',
        detail:
          '回到列表，新技能会按范围出现，右侧写着「已启用」。Gemini CLI 的技能可以在这里直接开关，其他工具这里只显示状态、开关要在工具里操作。然后在工具里说一句这个技能管的事，看它有没有照着做。',
        action: '打开技能',
        page: 'skills',
      },
      {
        title: '导入不了怎么办',
        detail:
          '提示「请填写来源。」是来源那一栏还空着。提示「当前工具未提供技能导入能力」，说明这个工具没有导入入口，可以换成 Codex CLI 或 Gemini CLI，或者在工具里自己放。顶部出现「部分信息需要确认」，是有一处没读成功，按它写的原因处理后重新加载。',
        action: '打开技能',
        page: 'skills',
      },
    ],
  },
  {
    id: 'plugins',
    title: '插件',
    lead: '插件是别人打包好的一整套能力，装一次就全有了；装之前先确认来源可信。',
    steps: [
      {
        title: '先分清它和外接工具',
        detail:
          '外接工具是给 AI 接上某一个具体服务，插件是整理好的一整包东西，可能同时带上命令、技能和连接。想一次补齐一类活，从插件找起更快。',
        action: '打开插件',
        page: 'plugins',
      },
      {
        title: '添加插件',
        detail:
          '顶部选好工具后点「添加插件」，在「来源」里填插件名称或它的仓库地址，再选添加范围。Claude Code 和 Codex CLI 还多一个「市场」标签页：Claude Code 第一次进去点「添加官方市场」，之后就能直接从清单里挑着装；Codex CLI 是先「添加市场」填市场地址，市场那一行还能更新或移除。Gemini CLI 和 Grok CLI 只有「已安装」这一份列表。',
        action: '打开插件',
        page: 'plugins',
      },
      {
        title: '确认装上了',
        detail:
          '列表里出现这一行、写着「已启用」就算装上了。Claude Code、Gemini CLI、Grok CLI 的插件可以在这里开关和更新，Codex CLI 的插件只能添加和移除。想知道它从哪来、是什么版本，点「更多操作」里的「查看详情」。',
        action: '打开插件',
        page: 'plugins',
      },
      {
        title: '装完没反应怎么办',
        detail:
          '工具正在运行时装的插件不会立刻生效，先保存手头的内容，再重新打开工具。提示「当前工具未提供市场管理接口」，是这个工具没有市场，已装的插件仍然在「已安装」里。Claude Code 的市场提示「还没有添加官方插件市场」时，点那颗按钮加一次就好，这一步需要这台电脑上装有 Git。来源拿不准就先别装，插件能做的事和工具本身一样多。',
        action: '打开插件',
        page: 'plugins',
      },
    ],
  },
  {
    id: 'safety',
    title: '备份、更新与数据',
    lead: '先留一份可用备份，再做较大的调整。',
    steps: [
      {
        title: '先备份工具配置',
        detail: '修改配置前保留一份备份，恢复前确认工具和文件范围。',
        action: '打开备份',
        page: 'backups',
      },
      {
        title: '检查主程序更新',
        detail:
          '下载完成后检查文件完整性。先保存正在进行的任务，再确认重启安装。',
        action: '打开更新',
        page: 'updates',
      },
      {
        title: '查看隐私选项',
        detail: '配置备份、项目文件、对话记录与登录凭据的范围不同。',
        action: '查看设置',
        page: 'settings',
      },
    ],
  },
  {
    id: 'trouble',
    title: '出问题怎么办',
    lead: '从检查结果进入对应修复页面，再回来验证。',
    steps: [
      {
        title: '运行检查',
        detail:
          '只对当前系统和已使用工具判断问题；没有使用的可选环境不必马上安装。',
        action: '打开检查',
        page: 'health',
      },
      {
        title: '按提示去处理',
        detail: '检查结果里的“去处理”会打开对应设置或配置。处理后再检查一次。',
        action: '查看网络设置',
        page: 'settings',
      },
      {
        title: '预览报告后联系支持',
        detail: '反馈页可搜索日志、查看详情，确认报告后再复制或下载。',
        action: '打开反馈',
        page: 'feedback',
      },
    ],
  },
] as const

export function TutorialPage({ navigate }: BusinessActions) {
  const [selected, setSelected] = useState<string>('start')
  const [query, setQuery] = useState('')
  const topics = tutorialTopics.filter((topic) =>
    `${topic.title} ${topic.lead}`.includes(query),
  )
  const current =
    tutorialTopics.find((topic) => topic.id === selected) ?? tutorialTopics[0]
  return (
    <section
      className="v2-page"
      data-page-id="tutorial"
      data-testid="page-tutorial"
    >
      <PageHead title="教程" lead="先找你要做的事，跟着步骤操作。" />
      <Toolbar
        search={
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="搜索教程"
          />
        }
      />
      <div className="v2-business-tutorial-grid">
        <nav className="v2-business-subnav">
          {topics.map((topic) => (
            <button
              key={topic.id}
              type="button"
              className={selected === topic.id ? 'is-active' : ''}
              onClick={() => setSelected(topic.id)}
            >
              {topic.title}
            </button>
          ))}
          {!topics.length && <p>没有符合条件的教程</p>}
        </nav>
        <div>
          <h2>{current.title}</h2>
          <p>{current.lead}</p>
          <ol className="v2-business-tutorial-steps">
            {current.steps.map((step, index) => (
              <li key={step.title}>
                <span>{index + 1}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.detail}</p>
                  <Button
                    size="sm"
                    icon={ExternalLink}
                    onClick={() => navigate?.(step.page)}
                  >
                    {step.action}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
