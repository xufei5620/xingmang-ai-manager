import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, BookOpen, Download, FolderOpen, History, MessageSquare, Plug, RefreshCw, Zap } from 'lucide-react'
import type { AccountBalance, AccountProfile, MultiProviderSessionPage, OfficialChatGptAccount } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Card, Dialog, Empty, ListRow, PageHead, Pill, Progress, ToolRow } from '../../ui'
import { balanceTier, canUninstallTool, greeting, presentTools, type ToolboxSnapshot, type ToolId, type ToolPresentation } from './model'
import type { ToolsApi } from './api'
import type { ToolJob } from './useToolbox'
import type { AccountBootstrapProgress, AccountBootstrapResult } from './account-bootstrap'
import type { PageId } from '../../registry/pages'

export interface HomeProps {
  api: ToolsApi
  snapshot: ToolboxSnapshot | null
  loading: boolean
  error: string
  account: AccountProfile | null
  balance: AccountBalance | null
  jobs: Record<string, ToolJob>
  onScan(): void
  onInstall(tool: ToolId): void
  onLaunch(tool: ToolId): void
  onConfigure(tool: ToolId): void
  onUninstall(tool: ToolId): void
  onRuntime(runtime: 'node' | 'python'): void
  onNavigate(page: PageId, section?: string): void
  onGuide(): void
  bootstrap?: (AccountBootstrapProgress & { scope: string; result?: AccountBootstrapResult; error?: string }) | null
  onBootstrapRetry?(): void
}

export function Home(props: HomeProps) {
  const { snapshot, account, balance, jobs, loading, error } = props
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
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let current = true
    setUsage(null); setUsageError('')
    if (account) void props.api.balanceUsage().then((value) => { if (current) setUsage(value) }).catch(() => { if (current) setUsageError('用量暂未读到') })
    return () => { current = false }
  }, [account?.userId, props.api])
  async function refreshOfficial() {
    if (officialLock.current) return
    officialLock.current = true; setOfficialBusy(true); setOfficialError('')
    try { const value = await props.api.officialUsage(); if (active.current) setOfficial(value) }
    catch (cause) { if (active.current) setOfficialError(cause instanceof Error ? cause.message : '官方额度暂时没有读到') }
    finally { officialLock.current = false; if (active.current) setOfficialBusy(false) }
  }
  useEffect(() => {
    let current = true
    setRecentError('')
    void props.api.recent().then((value) => { if (current) setRecent(value) }).catch((cause) => {
      if (current) setRecentError(cause instanceof Error ? cause.message : '记录暂时没有读到')
    })
    return () => { current = false }
  }, [props.api, recentAttempt])
  const tools = snapshot ? presentTools(snapshot) : []
  const installed = tools.filter((tool) => tool.status.installed || jobs[tool.id])
  const available = tools.filter((tool) => !tool.status.installed && !jobs[tool.id])
  const dollars = balance && balance.quotaPerUnit > 0 ? balance.quota / balance.quotaPerUnit : null
  const tier = dollars === null ? 'neutral' : balanceTier(dollars)
  const monthUsed = usage && balance && balance.quotaPerUnit > 0 ? usage.monthQuota / balance.quotaPerUnit : null
  const remainingDays = usage && balance && usage.weekQuota > 0 ? Math.max(0, Math.floor(balance.quota / (usage.weekQuota / 7))) : null
  const ready = installed.some((tool) => tool.configured && !tool.error)
  const bootstrapBusy = Boolean(props.bootstrap && !props.bootstrap.result && !props.bootstrap.error)
  const launchBusy = Object.keys(jobs).some((key) => key.startsWith('launch:'))
  const renderTool = useCallback((tool: ToolPresentation) => {
    const installJob = jobs[tool.id]
    const launchJob = jobs[`launch:${tool.id}`]
    const job = launchJob ?? installJob
    const status = installJob ? 'installing' : tool.error ? 'detectionFailed' : !tool.status.installed ? 'missing'
      : tool.source === 'unknown' ? 'unknownSource' : tool.source === 'official' ? 'official'
        : bootstrapBusy && !tool.configured ? 'configuring'
        : tool.configured ? 'ready' : 'unconfigured'
    const primaryLabel = launchJob ? '打开中' : installJob ? '安装中' : bootstrapBusy && !tool.configured ? '配置中' : tool.error ? '重新检测' : !tool.status.installed ? '安装'
      : tool.configured ? '打开' : '连接账号'
    const primary = () => tool.error ? props.onScan() : !tool.status.installed ? props.onInstall(tool.id)
      : tool.configured ? props.onLaunch(tool.id) : props.onConfigure(tool.id)
    return <ToolRow key={tool.id} tool={tool.id} status={status}
      version={tool.status.installed ? tool.currentVersion ?? '版本暂未识别' : undefined}
      model={tool.status.installed ? tool.source === 'official' ? '官方账号' : tool.model || undefined : undefined}
      progress={job?.percent}
      extraAction={tool.updateAvailable && !job ? <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onInstall(tool.id)}>更新</Button> : undefined}
      primaryAction={<Button size="sm" variant={tool.status.installed ? 'primary' : 'secondary'} loading={Boolean(job)}
        disabled={loading || launchBusy || bootstrapBusy && !tool.configured} icon={tool.status.installed && !bootstrapBusy ? ArrowUpRight : undefined} onClick={primary} testId={`tool-${tool.id}-primary`}>{primaryLabel}</Button>}
      menu={tool.status.installed && !job ? [
        { label: '配置', onSelect: () => props.onConfigure(tool.id) },
        { label: '查看记录', onSelect: () => props.onNavigate('sessions') },
        ...(tool.provider === 'codex' && tool.source === 'official' ? [{ label: '官方账户额度', onSelect: () => { setOfficial(snapshot?.system.officialChatGpt ?? null); setOfficialOpen(true) } }] : []),
        ...(canUninstallTool(
          tool.status,
          tool.id === 'codexDesktop' && snapshot?.platform.codexDesktop.uninstall === true,
        )
          ? [{ label: '卸载', danger: true, onSelect: () => props.onUninstall(tool.id) }]
          : []),
      ] : undefined} testId={`tool-row-${tool.id}`} />
  }, [bootstrapBusy, jobs, launchBusy, loading, props])
  return <section className="v2-page v2-home" data-testid="page-home">
    <PageHead title={`${greeting(new Date().getHours())}${account ? `，${account.username}` : ''}`}
      lead="选择工具开始任务，或打开聊天描述你的问题。" actions={<>
        <Button onClick={props.onGuide} testId="home-guide">新手引导</Button>
        <Button icon={RefreshCw} loading={loading} onClick={props.onScan} testId="home-rescan">重新检测</Button>
      </>} />
    {props.bootstrap && !props.bootstrap.result && <div className="v2-bootstrap-notice" role={props.bootstrap.error ? 'alert' : 'status'} data-busy={props.bootstrap.error ? undefined : 'true'}>
      <span className={`v2-dot ${props.bootstrap.error ? 'is-warn' : ''}`} />
      <span>{props.bootstrap.error ? `账号 Key 初始化没有完成：${props.bootstrap.error}` : `${props.bootstrap.label}（${props.bootstrap.percent}%）`}</span>
      {props.bootstrap.error && props.onBootstrapRetry && <Button size="xs" onClick={props.onBootstrapRetry}>重新同步</Button>}
    </div>}
    {props.bootstrap?.result && (props.bootstrap.result.configured.length || props.bootstrap.result.failed.length || props.bootstrap.result.warnings.length) > 0 && <div className={`v2-bootstrap-notice ${props.bootstrap.result.failed.length || props.bootstrap.result.warnings.length ? 'is-warn' : ''}`} role="status">
      <span className={`v2-dot ${props.bootstrap.result.failed.length || props.bootstrap.result.warnings.length ? 'is-warn' : 'is-ok'}`} /><span>{props.bootstrap.result.configured.length ? `已完成 ${props.bootstrap.result.configured.length} 组工具的 Key 配置。` : '账号 Key 已同步。'}{props.bootstrap.result.failed.length ? ` ${props.bootstrap.result.failed.map((entry) => entry.message).join('；')}` : ''}{props.bootstrap.result.warnings.length ? ` ${props.bootstrap.result.warnings.join('；')}` : ''}</span>
      {(props.bootstrap.result.failed.length > 0 || props.bootstrap.result.warnings.length > 0) && props.onBootstrapRetry && <Button size="xs" onClick={props.onBootstrapRetry}>重新同步</Button>}
    </div>}
    {error && <div role="alert" className="v2-callout is-bad"><span>{error}</span><Button size="xs" onClick={props.onScan}>重新检测</Button></div>}
    {dollars !== null && dollars < 5 && <div role="status" className="v2-callout is-bad"><Zap size={18} /><span>余额只剩 ${dollars.toFixed(2)}，充值后可继续使用。</span><Button size="sm" variant="balance" onClick={() => props.onNavigate('account', 'recharge')}>马上充值</Button></div>}
    <div className="v2-home-grid">
      <div className="v2-home-main">
        {!ready && !loading && <Card title="开始使用" meta="第 1 步，共 4 步" padding="none" testId="home-setup">
          <div className="v2-setup-focus"><span className="v2-step-number">1</span><div><h3>选择一种开始方式</h3><p>选一个工具先开始，之后随时可以再装别的。</p></div><Button variant="primary" onClick={props.onGuide}>开始准备</Button></div>
          <ol className="v2-setup-steps">{['选开始方式', '准备工具', '确认连接', '开始使用'].map((label, i) => <li key={label}><span>{i + 1}</span>{label}</li>)}</ol>
        </Card>}
        {loading && !snapshot ? <Card title="你的工具"><Progress value={0} label="正在检测本机工具" /></Card> : <>
          {installed.length > 0 && <Card title="你的工具" meta={`${installed.length} 个已装${installed.some((tool) => tool.updateAvailable) ? ` · ${installed.filter((tool) => tool.updateAvailable).length} 个有更新` : ''}`} padding="none">{installed.map(renderTool)}</Card>}
          {available.length > 0 && <Card title="还可以装" meta={`${available.length} 个`} collapsible padding="none">{available.map(renderTool)}</Card>}
        </>}
        <Card title="最近" meta="从上次停下的地方继续" padding="none" actions={<Button variant="ghost" size="xs" onClick={() => props.onNavigate('sessions')}>全部记录</Button>}>
          {recentError ? <Empty icon={History} title="记录暂时没有读到" description={recentError} action={<Button onClick={() => setRecentAttempt((value) => value + 1)}>重新加载</Button>} />
            : !recent ? <div className="v2-loading-inline" role="status">正在读取最近记录</div>
              : recent.items.length ? recent.items.slice(0, 3).map((session) => <ListRow key={session.id} icon={History}
                title={session.title} desc={session.cwd ?? undefined} meta={session.updatedAt === null ? '时间未记录' : new Date(session.updatedAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                actions={<Button size="xs" variant="ghost" onClick={() => props.onNavigate('sessions')}>查看</Button>} />)
                : <Empty icon={History} title="还没有对话记录" description="打开工具聊过之后，这里会出现最近的会话。" />}
        </Card>
      </div>
      <aside className="v2-home-aside">
        <Card title="运行环境" padding="none" meta={snapshot ? new Date(snapshot.system.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '等待检查'}>
          <div className="v2-runtime-list">{(['node', 'npm', 'python'] as const).map((id) => {
            const status = snapshot?.system.runtime[id]
            return <div key={id} className="v2-runtime-row"><i className={`v2-dot ${status?.installed ? 'is-ok' : id === 'python' ? '' : 'is-warn'}`} /><BrandIcon tool={id} size={16} variant="xs" /><strong>{id === 'node' ? 'Node.js' : id === 'python' ? 'Python' : 'npm'}</strong>
              <span>{jobs[id]?.label ?? (loading ? '检测中' : status?.detectionFailed ? '检测失败' : status?.version ?? (id === 'python' ? '可选 · 未装' : '未安装'))}</span>
            </div>
          })}</div>
          <div className="v2-runtime-actions">{!snapshot?.system.runtime.node.installed && <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onRuntime('node')}>准备 Node.js</Button>}
            {!snapshot?.system.runtime.python.installed && <Button variant="ghost" size="sm" icon={Download} onClick={() => props.onRuntime('python')}>装 Python（可选环境）</Button>}</div>
        </Card>
        <Card title="账户余额" padding="none" actions={<Pill tone={ready ? 'ok' : 'neutral'}>{ready ? `${installed.filter((tool) => tool.configured).length} 个工具已连接` : '等待连接'}</Pill>}>
          <div className={`v2-balance-body tone-${tier}`}><div><strong>{dollars === null ? '暂未读到' : `$${dollars.toFixed(2)}`}</strong><small>可用余额 · 美元</small></div>
            <div className="v2-balance-usage">{monthUsed !== null && dollars !== null && <Progress tone={tier === 'neutral' ? 'neutral' : tier} value={monthUsed + dollars > 0 ? monthUsed / (monthUsed + dollars) * 100 : 0} label={`本月已用 $${monthUsed.toFixed(2)}`} />}
              <p>{usageError || (remainingDays !== null ? `按最近 7 天用量约还能用 ${remainingDays} 天${remainingDays < 7 ? '，建议提前充值' : ''}。` : usage ? '最近 7 天暂无用量' : account ? '正在读取用量' : '登录后查看用量')}</p></div>
            <div className="v2-balance-actions"><Button variant="balance" size="sm" icon={Zap} onClick={() => props.onNavigate('account', 'recharge')}>充值</Button><Button variant="ghost" size="sm" onClick={() => props.onNavigate('account', 'dashboard')}>用量看板</Button></div>
          </div>
        </Card>
        <Card title="可以试试" padding="none" testId="home-suggestions"><ListRow icon={Plug} title="给 AI 连上浏览器和数据库" actions={<Button variant="ghost" size="xs" icon={ArrowRight} aria-label="查看外接工具" title="查看外接工具" onClick={() => props.onNavigate('mcp')} />} />
          <ListRow icon={MessageSquare} title="不开终端，直接在这里聊" actions={<Button variant="ghost" size="xs" icon={ArrowRight} aria-label="打开聊天" title="打开聊天" onClick={() => props.onNavigate('chat')} />} />
          <ListRow icon={BookOpen} title="5 分钟教程：第一次用 Claude Code" actions={<Button variant="ghost" size="xs" icon={ArrowRight} aria-label="查看教程" title="查看教程" onClick={() => props.onNavigate('tutorial')} />} /></Card>
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
