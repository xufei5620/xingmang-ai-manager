import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  FileWarning,
  FolderKanban,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  Search,
  X,
  Zap,
} from 'lucide-react'
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DialogBackdrop } from '../components/Dialog'
import { ProviderTabs, managementProviderIds, managementProviderLabels } from '../components/ProviderTabs'
import { errorMessage } from '../error-message'
import type {
  MultiProviderSessionDetail,
  MultiProviderSessionExportResult,
  MultiProviderSessionListQuery,
  MultiProviderSessionPage,
  MultiProviderSessionProvider,
  MultiProviderSessionSummary,
  SessionMutationResult,
} from '../types'

export interface SessionsPageApi {
  listProviderSessions: (query: MultiProviderSessionListQuery) => Promise<MultiProviderSessionPage>
  getProviderSessionDetail: (sessionId: string) => Promise<MultiProviderSessionDetail>
  exportProviderSession: (sessionId: string) => Promise<MultiProviderSessionExportResult | null>
  archiveSession: (sessionId: string) => Promise<SessionMutationResult>
  restoreSession: (sessionId: string) => Promise<SessionMutationResult>
}

export interface SessionsPageProps {
  api: SessionsPageApi
  notify?: (toast: { type: 'success' | 'error'; message: string }) => void
}

const PAGE_SIZE = 15

function formatDate(timestamp: number | null): string {
  if (!timestamp) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value)
}

function roleLabel(role: string, provider: MultiProviderSessionProvider): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return managementProviderLabels[provider]
  if (role === 'developer') return '开发者'
  if (role === 'system') return '系统'
  return '其他'
}

export function SessionsPage({ api, notify }: SessionsPageProps) {
  const [provider, setProvider] = useState<MultiProviderSessionProvider>('codex')
  const [result, setResult] = useState<MultiProviderSessionPage | null>(null)
  const [overview, setOverview] = useState<MultiProviderSessionPage | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busySessionId, setBusySessionId] = useState('')
  const [detail, setDetail] = useState<MultiProviderSessionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pendingArchive, setPendingArchive] = useState<MultiProviderSessionSummary | null>(null)
  const loadRequestRef = useRef(0)
  const overviewRequestRef = useRef(0)
  const detailRequestRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setError('')
    try {
      const next = await api.listProviderSessions({ provider, search, page, pageSize: PAGE_SIZE })
      if (requestId === loadRequestRef.current) setResult(next)
    } catch (loadError) {
      if (requestId === loadRequestRef.current) setError(errorMessage(loadError))
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }, [api, page, provider, search])

  useEffect(() => {
    void load()
    return () => { loadRequestRef.current += 1 }
  }, [load])

  const loadOverview = useCallback(async () => {
    const requestId = ++overviewRequestRef.current
    try {
      const next = await api.listProviderSessions({ provider: 'all', search, page: 1, pageSize: 1 })
      if (requestId === overviewRequestRef.current) setOverview(next)
    } catch {
      if (requestId === overviewRequestRef.current) setOverview(null)
    }
  }, [api, search])

  useEffect(() => {
    void loadOverview()
    return () => { overviewRequestRef.current += 1 }
  }, [loadOverview])

  const selectProvider = (next: MultiProviderSessionProvider) => {
    if (next === provider) return
    loadRequestRef.current += 1
    detailRequestRef.current += 1
    setProvider(next)
    setPage(1)
    setResult(null)
    setDetail(null)
    setDetailLoading(false)
  }

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextSearch = searchInput.trim()
    if (nextSearch === search && page === 1) {
      void load()
      void loadOverview()
      return
    }
    loadRequestRef.current += 1
    overviewRequestRef.current += 1
    setSearch(nextSearch)
    setPage(1)
    if (nextSearch === search) void loadOverview()
  }

  const openDetail = async (sessionId: string) => {
    const requestId = ++detailRequestRef.current
    setDetailLoading(true)
    setError('')
    try {
      const next = await api.getProviderSessionDetail(sessionId)
      if (requestId === detailRequestRef.current) setDetail(next)
    } catch (detailError) {
      if (requestId !== detailRequestRef.current) return
      const message = errorMessage(detailError)
      setError(message)
      notify?.({ type: 'error', message })
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false)
    }
  }

  const exportSession = async (sessionId: string) => {
    setBusySessionId(sessionId)
    try {
      const exported = await api.exportProviderSession(sessionId)
      if (exported) {
        const incomplete = exported.truncated ? '；源记录不完整，已在文件中标记' : ''
        notify?.({ type: 'success', message: `已导出 ${exported.messages} 条消息：${exported.outputPath}${incomplete}` })
      }
    } catch (exportError) {
      notify?.({ type: 'error', message: errorMessage(exportError) })
    } finally {
      setBusySessionId('')
    }
  }

  const performArchiveStateChange = async (session: MultiProviderSessionSummary) => {
    const action = session.archived ? '恢复' : '归档'
    setBusySessionId(session.id)
    try {
      if (session.archived) await api.restoreSession(session.nativeId)
      else await api.archiveSession(session.nativeId)
      notify?.({ type: 'success', message: `会话已${action}` })
      setDetail(null)
      await load()
    } catch (mutationError) {
      notify?.({ type: 'error', message: errorMessage(mutationError) })
    } finally {
      setBusySessionId('')
      setPendingArchive(null)
    }
  }

  const changeArchiveState = async (session: MultiProviderSessionSummary) => {
    const sessionCapability = (result?.capabilities ?? overview?.capabilities)?.[session.provider]
    const operationAvailable = session.archived
      ? sessionCapability?.operations.restore
      : sessionCapability?.operations.archive
    if (session.provider !== 'codex' || session.readonly || !session.detailAvailable || !operationAvailable) {
      notify?.({ type: 'error', message: sessionCapability?.reason || '该会话仅支持只读访问' })
      return
    }
    if (!session.archived) {
      setPendingArchive(session)
      return
    }
    await performArchiveStateChange(session)
  }

  const stats = useMemo(() => overview?.stats ?? result?.stats ?? {
    total: 0,
    byProvider: { codex: 0, claude: 0, gemini: 0, grok: 0 },
  }, [overview, result])
  const capabilities = useMemo(() => {
    if (!overview) return result?.capabilities
    if (!result) return overview.capabilities
    return {
      ...overview.capabilities,
      [provider]: result.capabilities[provider],
    }
  }, [overview, provider, result])
  const capability = capabilities?.[provider]
  const unavailableProviders = useMemo(() => new Set(
    managementProviderIds.filter((id) => capabilities && (!capabilities[id].available || !capabilities[id].readable)),
  ), [capabilities])
  const detailCapability = detail ? capabilities?.[detail.session.provider] : undefined
  const actionBusy = Boolean(busySessionId)
  const refresh = () => {
    void load()
    void loadOverview()
  }

  return (
    <div className="page workspace-page sessions-page" data-page-id="sessions">
      <header className="page-header workspace-page-header sessions-page-header">
        <div>
          <div className="eyebrow">AI SESSIONS</div>
          <h1>会话管理</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="会话工具栏">
          <ProviderTabs value={provider} onChange={selectProvider} disabled={loading} unavailable={unavailableProviders} label="选择会话来源" />
          <button className="icon-button" type="button" title="刷新会话" aria-label="刷新会话" onClick={refresh} disabled={loading}>
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      <section className="session-stats" aria-label="会话统计">
        <div className="session-stat"><MessageSquareText size={17} /><span><strong>{compactNumber(stats.total)}</strong><small>全部会话</small></span></div>
        <div className="session-stat"><Clock3 size={17} /><span><strong>{compactNumber(stats.byProvider.codex)}</strong><small>Codex</small></span></div>
        <div className="session-stat"><Archive size={17} /><span><strong>{compactNumber(stats.byProvider.claude)}</strong><small>Claude</small></span></div>
        <div className="session-stat"><FolderKanban size={17} /><span><strong>{compactNumber(stats.byProvider.gemini)}</strong><small>Gemini</small></span></div>
        <div className="session-stat"><Zap size={17} /><span><strong>{compactNumber(stats.byProvider.grok)}</strong><small>Grok</small></span></div>
      </section>

      <section className="sessions-toolbar" aria-label="会话筛选">
        <form className="sessions-search" role="search" onSubmit={submitSearch}>
          <Search size={16} aria-hidden="true" />
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索标题、目录、模型或会话 ID"
            aria-label="搜索会话"
          />
          <button className="secondary-button" type="submit">搜索</button>
        </form>
        <div className="management-counts">
          <span><i className={`status-dot ${capability?.available && capability.readable ? 'configured' : ''}`} /> {managementProviderLabels[provider]}</span>
          <span>{!capability ? '检测中' : capability.readonly ? '只读访问' : '支持会话维护'}</span>
        </div>
      </section>

      {capability && (capability.readonly || !capability.available) && (
        <div className="session-schema-warning" role="status">
          <FileWarning size={16} />
          <span>{capability.reason}</span>
        </div>
      )}

      {error && (
        <div className="session-error" role="alert">
          <FileWarning size={18} />
          <div><strong>会话数据读取失败</strong><span>{error}</span></div>
          <button className="secondary-button" type="button" onClick={() => void load()}>重试</button>
        </div>
      )}

      {loading && !result ? (
        <section className="workspace-empty sessions-loading" aria-live="polite">
          <div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div>
          <h2>正在读取 {managementProviderLabels[provider]} 会话</h2>
          <p>{provider === 'codex' ? '从本机 SQLite 索引加载' : '从本机会话文件只读加载'}</p>
        </section>
      ) : result && result.items.length > 0 ? (
        <section className={loading ? 'sessions-list is-loading' : 'sessions-list'} aria-label={`${managementProviderLabels[provider]} 会话列表`} aria-busy={loading}>
          <div className="sessions-table-head" aria-hidden="true">
            <span>会话</span><span>模型</span><span>更新时间</span><span>操作</span>
          </div>
          {result.items.map((session) => {
            const busy = busySessionId === session.id
            const sessionCapability = result.capabilities[session.provider]
            const canView = session.detailAvailable && sessionCapability.operations.detail
            const canExport = session.detailAvailable && sessionCapability.operations.exportMarkdown
            const canMutate = session.provider === 'codex'
              && !session.readonly
              && session.detailAvailable
              && (session.archived ? sessionCapability.operations.restore : sessionCapability.operations.archive)
            return (
              <article className="session-row" key={session.id}>
                <div className="session-main">
                  <div className="session-title-line">
                    <span className={session.archived ? 'session-state-dot archived' : 'session-state-dot'} />
                    <strong title={session.title}>{session.title}</strong>
                    {session.archived && <span className="session-archive-label">已归档</span>}
                  </div>
                  <code title={session.cwd || session.nativeId}>{session.cwd || session.nativeId}</code>
                </div>
                <div className="session-model">
                  <strong>{session.model || '未记录模型'}</strong>
                  <small>{managementProviderLabels[session.provider]} · {session.messageCount === null ? '消息数未知' : `${compactNumber(session.messageCount)} 条消息`}</small>
                </div>
                <time className="session-time" dateTime={session.updatedAt ? new Date(session.updatedAt).toISOString() : undefined}>
                  {formatDate(session.updatedAt)}
                </time>
                <div className="session-actions">
                  <button className="icon-button compact" type="button" title="查看详情" aria-label={`查看 ${session.title}`} disabled={actionBusy || !canView} onClick={() => void openDetail(session.id)}>
                    <Eye size={16} />
                  </button>
                  <button className="icon-button compact" type="button" title="导出 Markdown" aria-label={`导出 ${session.title}`} disabled={actionBusy || !canExport} onClick={() => void exportSession(session.id)}>
                    {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                  </button>
                  {canMutate ? (
                    <button
                      className="secondary-button compact session-archive-button"
                      type="button"
                      disabled={actionBusy}
                      onClick={() => void changeArchiveState(session)}
                      title={session.archived ? '恢复会话' : '归档会话'}
                    >
                      {session.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                      {session.archived ? '恢复' : '归档'}
                    </button>
                  ) : (
                    <button className="secondary-button compact session-archive-button" type="button" disabled title={sessionCapability.reason}>
                      <LockKeyhole size={15} />只读
                    </button>
                  )}
                </div>
              </article>
            )
          })}
          <footer className="sessions-pagination">
            <span>共 {result.total} 个会话</span>
            <div>
              <button className="icon-button compact" type="button" title="上一页" disabled={result.page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                <ChevronLeft size={17} />
              </button>
              <span>{result.page} / {Math.max(result.pages, 1)}</span>
              <button className="icon-button compact" type="button" title="下一页" disabled={result.page >= result.pages || loading} onClick={() => setPage((value) => value + 1)}>
                <ChevronRight size={17} />
              </button>
            </div>
          </footer>
        </section>
      ) : result && !error ? (
        <section className="workspace-empty sessions-empty">
          <div className="workspace-empty-icon"><Inbox size={24} /></div>
          <h2>{capability && (!capability.available || !capability.readable) ? `无法读取 ${managementProviderLabels[provider]} 会话` : '没有匹配的会话'}</h2>
          <p>{capability && (!capability.available || !capability.readable) ? capability.reason : '调整搜索词后重试'}</p>
        </section>
      ) : null}

      {detailLoading && (
        <div className="session-detail-loading" role="status"><LoaderCircle size={18} className="spin" />正在读取会话详情</div>
      )}

      {detail && (
        <DialogBackdrop className="config-modal-backdrop session-detail-backdrop" onDismiss={() => setDetail(null)}>
          <section className="config-dialog session-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="session-detail-title">
            <header className="session-detail-header">
              <div>
                <div className="eyebrow">SESSION DETAIL</div>
                <h2 id="session-detail-title">{detail.session.title}</h2>
                <code>{detail.session.nativeId}</code>
              </div>
              <button className="icon-button" type="button" title="关闭" aria-label="关闭会话详情" onClick={() => setDetail(null)}><X size={18} /></button>
            </header>
            <div className="session-detail-meta">
              <span>{detail.messageStats.total} 条消息</span>
              <span>{managementProviderLabels[detail.session.provider]}</span>
              <span>{formatDate(detail.session.updatedAt)}</span>
              {detail.messageStats.invalidLines > 0 && <span>{detail.messageStats.invalidLines} 条损坏记录已跳过</span>}
            </div>
            <div className="session-message-list">
              {detail.sourceTruncated ? (
                <div className="session-transcript-note">源会话超过安全读取上限，此处仅显示已读取的部分内容。</div>
              ) : detail.messageStats.invalidLines > 0 ? (
                <div className="session-transcript-note">源记录中的损坏内容已跳过；会话较长时仅显示最新 {detail.messages.length} 条消息。</div>
              ) : detail.messagesTruncated ? (
                <div className="session-transcript-note">会话较长或含超长内容，此处显示最新 {detail.messages.length} 条消息。</div>
              ) : null}
              {detail.messages.length === 0 && <div className="session-transcript-note">该会话尚无可显示的对话消息。</div>}
              {detail.messages.map((message, index) => (
                <article className={`session-message role-${message.role}`} key={`${message.timestamp ?? 'message'}-${index}`}>
                  <header><strong>{roleLabel(message.role, detail.session.provider)}</strong>{message.timestamp && <time>{formatDate(Date.parse(message.timestamp))}</time>}</header>
                  <pre>{message.text}</pre>
                </article>
              ))}
            </div>
            <footer className="session-detail-actions">
              <button className="secondary-button" type="button" disabled={actionBusy || !detailCapability?.operations.exportMarkdown} onClick={() => void exportSession(detail.session.id)}>
                {busySessionId === detail.session.id ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}导出 Markdown
              </button>
              {detail.session.provider === 'codex'
                && !detail.session.readonly
                && detail.session.detailAvailable
                && (detail.session.archived ? detailCapability?.operations.restore : detailCapability?.operations.archive) ? (
                  <button className="secondary-button" type="button" disabled={actionBusy} onClick={() => void changeArchiveState(detail.session)}>
                    {detail.session.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                    {detail.session.archived ? '恢复会话' : '归档会话'}
                  </button>
                ) : (
                  <button className="secondary-button" type="button" disabled title={detailCapability?.reason}>
                    <LockKeyhole size={16} />只读会话
                  </button>
                )}
            </footer>
          </section>
        </DialogBackdrop>
      )}

      {pendingArchive && (
        <DialogBackdrop
          className="config-modal-backdrop extension-backdrop"
          onDismiss={actionBusy ? () => undefined : () => setPendingArchive(null)}
        >
          <section className="extension-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-session-title">
            <span className="extension-confirm-icon danger"><Archive size={20} /></span>
            <h2 id="archive-session-title">归档“{pendingArchive.title}”？</h2>
            <p>操作前会自动备份本机会话数据库，之后仍可在已归档会话中恢复。</p>
            <div className="extension-dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setPendingArchive(null)} disabled={actionBusy}>取消</button>
              <button className="danger-button" type="button" onClick={() => void performArchiveStateChange(pendingArchive)} disabled={actionBusy}>
                {actionBusy ? <LoaderCircle size={16} className="spin" /> : <Archive size={16} />} 确认归档
              </button>
            </div>
          </section>
        </DialogBackdrop>
      )}
    </div>
  )
}
