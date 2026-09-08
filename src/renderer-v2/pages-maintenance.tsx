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
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  HeartPulse,
  HelpCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  UserRound,
  Wrench,
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
} from './business-common'
import {
  notificationOptions,
  settingsGroups,
  skinOptions,
  updateLabels,
} from './registry/business'
import { tools } from './registry/tools'
import { canUninstallTool } from './features/tools/model'
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
export type BusinessActions = {
  navigate?: (page: V2Page) => void
  openLogin?: () => void
  openHelp?: () => void
  onAccountChanged?: () => void
  onSettingsChanged?: (settings: AppSettings) => void
  openConfig?: (provider: Provider) => void
}
const isProvider = (id: string): id is Provider =>
  ['claude', 'codex', 'gemini', 'grok'].includes(id)

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

export function HealthPage({
  api,
  navigate,
  openConfig,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.runDiagnostics(), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const [details, setDetails] = useState<Diagnostic | null>(null)
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
                '导出操作已结束',
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
                  '导出操作已结束',
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
              title="更新没有装上"
              body={update.error.message}
              actions={
                <>
                  <Button size="sm" icon={Download} onClick={download}>
                    重新下载
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
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(
    async () => ({
      snapshot: await api.scanSystem(false),
      capability: await api.getPlatformCapabilities(),
    }),
    [api],
  )
  const resource = useResource(load)
  const operation = useOperation()
  const [logs, setLogs] = useState<string[]>([])
  const [remove, setRemove] = useState<Provider | 'codexDesktop' | null>(null)
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
        if (id === 'codexDesktop') await api.installCodexDesktop()
        else await api.installCli(id)
        await resource.reload()
      },
      '安装完成，工具状态已更新',
    )
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
        error={resource.error || operation.error}
        message={operation.message}
      />
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
              ? resource.data?.snapshot.desktopApps.codex
              : resource.data?.snapshot.clis[id]
          const version =
            status && 'appVersion' in status
              ? status.appVersion
              : status && 'version' in status
                ? status.version
                : null
          const managed =
            id === 'codexDesktop'
              ? resource.data?.capability.codexDesktop.install === 'managed'
              : resource.data?.capability.cliInstall[id] === 'managed'
          return (
            <ListRow
              key={id}
              title={
                <>
                  <BrandIcon tool={id} size={32} />
                  {tool.name}
                </>
              }
              desc={tool.vendor}
              meta={
                <>
                  {version || '未找到版本'}{' '}
                  <Pill tone={status?.installed ? 'ok' : 'neutral'}>
                    {status?.installed ? '已安装' : '未安装'}
                  </Pill>
                </>
              }
              actions={
                <>
                  <Button
                    size="sm"
                    icon={status?.installed ? RefreshCw : Download}
                    disabled={!managed || Boolean(operation.busy)}
                    onClick={() => install(id)}
                  >
                    {status?.installed ? '重新安装' : '安装'}
                  </Button>
                  <Menu
                    anchor={<MoreHorizontal size={18} />}
                    items={[
                      {
                        label: '检查更新',
                        icon: RefreshCw,
                        onSelect: () => check(id),
                      },
                      ...(status?.installed === true &&
                      canUninstallTool(status, id === 'codexDesktop' &&
                        resource.data?.capability.codexDesktop.uninstall === true) &&
                      (id !== 'codexDesktop' ||
                      resource.data?.capability.codexDesktop.uninstall)
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
          const status = resource.data?.snapshot.runtime[id]
          const managed =
            id === 'node'
              ? resource.data?.capability.nodeRuntimeInstall === 'managed'
              : resource.data?.capability.pythonRuntimeInstall === 'managed'
          return (
            <ListRow
              key={id}
              icon={Wrench}
              title={id === 'node' ? 'Node.js' : 'Python'}
              desc={
                id === 'node'
                  ? '命令行工具需要的运行环境'
                  : '部分工具需要的可选运行环境'
              }
              meta={status?.version || '尚未安装'}
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
                      if (result.outcome === 'manual-required')
                        throw new Error(result.error)
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

export function SettingsPage({
  api,
  navigate,
  openLogin,
  onAccountChanged,
  onSettingsChanged,
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
            '代理',
            proxy?.note ??
              '可查看应用窗口的系统代理路由；账号请求和工具安装使用原有链路。',
            systemApi ? (
              <div className="v2-business-control">
                <Pill>{proxy?.summary ?? '只读'}</Pill>
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
            '仅保存你的偏好。此版本没有自动上传服务；错误日志留在本机，可先预览再手动分享',
            systemApi && systemState ? (
              <Switch
                aria-label="崩溃自动上报偏好"
                checked={systemState.preferences.privacy?.crashReports ?? false}
                disabled={Boolean(operation.busy)}
                onChange={(enabled) =>
                  void operation.execute(
                    'privacy',
                    async () =>
                      setSystemState(
                        await systemApi.setPrivacyPreference(
                          'crashReports',
                          enabled,
                        ),
                      ),
                    '偏好已保存在本机，没有上传报告',
                  )
                }
              />
            ) : (
              <UnsupportedControl label="未开启自动上传" />
            ),
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
          {row(
            '新手引导',
            '重新查看使用步骤',
            <Button
              size="sm"
              icon={BookOpen}
              onClick={() => navigate?.('tutorial')}
            >
              再看一遍
            </Button>,
          )}
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

const tutorialTopics = [
  {
    id: 'start',
    title: '开始使用',
    lead: '选一个工具开始，安装和连接分开完成。',
    steps: [
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
          '只安装所选工具需要的运行环境。桌面端和聊天不需要先安装所有命令行工具。',
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
