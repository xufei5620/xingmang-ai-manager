import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, Cloud, Copy, FolderOpen, HardDrive, Music2, Pencil, Plus, TriangleAlert, X } from 'lucide-react'
import type { CanvasProjectPage, CanvasStoredProjectSummary } from '../host'
import { canvasProjectPageRange, canvasProjectStorageCopy, type CanvasProjectListQuery } from '../project-pagination'
import { SafeImage, ViewportVideo } from './MediaPreview'
import type { BlankProjectCreationState } from '../lib/blank-project-creation-model'

type ProjectAction = 'rename' | 'duplicate' | 'archive'

interface ProjectCenterProps {
  projects: readonly CanvasStoredProjectSummary[]
  page?: CanvasProjectPage | null
  query?: CanvasProjectListQuery
  storageMode?: 'local' | 'cloud'
  onQueryChange?(query: CanvasProjectListQuery): void
  onQueryPending?(): void
  loading: boolean
  error: string | null
  onRefresh?(): void
  onCreate(name: string): Promise<boolean>
  blankCreation?: BlankProjectCreationState
  blankCreationReady?: boolean
  blankDraftName?: string
  blankDraftError?: string | null
  onBlankDraftNameChange?(name: string): void
  onContinueBlankCreate?(): Promise<void>
  onFinishBlankCreate?(): Promise<void>
  onOpen(projectId: string): void
  onRename(projectId: string, name: string): Promise<boolean>
  onDuplicate(projectId: string, name: string): Promise<boolean>
  onSetArchived(projectId: string, archived: boolean): Promise<boolean>
  onDraftChange?(dirty: boolean): void
}

function recentTimestamp(project: CanvasStoredProjectSummary): number {
  const value = Date.parse(project.lastOpenedAt || project.updatedAt)
  return Number.isFinite(value) ? value : 0
}

function workspaceCopy(project: CanvasStoredProjectSummary, storageMode: 'local' | 'cloud'): { label: string; detail: string; className: string } {
  if (storageMode === 'cloud') return { label: '云端保存', detail: '工作流与素材属于当前账户', className: 'is-ready' }
  if (project.workspaceStatus === 'ready') return { label: '工作目录就绪', detail: project.workspaceName ?? '已选择', className: 'is-ready' }
  if (project.workspaceStatus === 'missing') return { label: '工作目录缺失', detail: '恢复原文件夹后可重新打开', className: 'is-missing' }
  return { label: '旧项目', detail: '素材使用默认存储位置', className: 'is-legacy' }
}

function ProjectPreview({ project }: { project: CanvasStoredProjectSummary }) {
  const preview = project.previewAsset
  if (!preview) return <span className="canvas-project-preview-empty"><FolderOpen size={24} /><small>暂无已采纳素材</small></span>
  if (preview.kind === 'image') return <SafeImage src={preview.localUrl} alt={`${project.name} 项目预览`} loading="lazy" />
  if (preview.kind === 'video') return <ViewportVideo src={preview.localUrl} aria-label={`${project.name} 项目预览`} muted playsInline />
  return <span className="canvas-project-preview-empty"><Music2 size={24} /><small>音频项目</small></span>
}

export function ProjectCenter({ projects, page, query, storageMode = 'local', onQueryChange, onQueryPending, loading, error, onRefresh, onCreate, blankCreation, blankCreationReady = true, blankDraftName, blankDraftError, onBlankDraftNameChange, onContinueBlankCreate, onFinishBlankCreate, onOpen, onRename, onDuplicate, onSetArchived, onDraftChange }: ProjectCenterProps) {
  const [view, setView] = useState<'recent' | 'archived'>('recent')
  const paged = Boolean(query && onQueryChange)
  const [search, setSearch] = useState(query?.q ?? '')
  const searchPendingRef = useRef(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const copy = canvasProjectStorageCopy(storageMode)
  const [creating, setCreating] = useState(false)
  const [localCreateName, setLocalCreateName] = useState('')
  const createName = blankDraftName ?? localCreateName
  const setCreateName = (name: string) => { if (blankDraftName === undefined) setLocalCreateName(name); else onBlankDraftNameChange?.(name) }
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSaving, setCreateSaving] = useState(false)
  const [action, setAction] = useState<{ project: CanvasStoredProjectSummary; kind: ProjectAction } | null>(null)
  const [actionName, setActionName] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSaving, setActionSaving] = useState(false)
  const hasDraft = (creating && createName.trim().length > 0) || action !== null
  useEffect(() => { onDraftChange?.(hasDraft); return () => onDraftChange?.(false) }, [hasDraft, onDraftChange])
  const activeProjects = useMemo(() => projects.filter((project) => !project.archivedAt).sort((left, right) => recentTimestamp(right) - recentTimestamp(left)), [projects])
  const archivedProjects = useMemo(() => projects.filter((project) => project.archivedAt).sort((left, right) => Date.parse(right.archivedAt!) - Date.parse(left.archivedAt!)), [projects])
  const currentView = paged ? query!.view === 'archived' ? 'archived' : 'recent' : view
  const visibleProjects = paged ? loading || error ? [] : projects : view === 'recent' ? activeProjects : archivedProjects
  const actionBusy = createSaving || actionSaving || restoringId !== null || Boolean(blankCreation?.busy)

  useEffect(() => {
    if (!searchPendingRef.current) setSearch(query?.q ?? '')
  }, [query?.q])

  useEffect(() => {
    if (!paged || !query || !onQueryChange || !searchPendingRef.current) return
    const timer = window.setTimeout(() => {
      searchPendingRef.current = false
      onQueryChange({ ...query, q: search || undefined, offset: 0 })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [paged, query, search, onQueryChange])

  const changeView = (nextView: 'recent' | 'archived') => {
    if (actionBusy) return
    if (paged && query && onQueryChange) {
      searchPendingRef.current = false
      onQueryChange({ ...query, q: search || undefined, view: nextView === 'archived' ? 'archived' : 'active', offset: 0 })
    } else setView(nextView)
  }

  const restoreProject = async (projectId: string) => {
    if (loading || actionBusy) return
    setRestoringId(projectId)
    try { await onSetArchived(projectId, false) } catch { /* App exposes the confirmed failure and retry path. */ }
    finally { setRestoringId(null) }
  }

  const beginCreate = () => {
    if (loading || actionBusy) return
    setAction(null)
    setCreating(true)
    if (!blankCreation) setCreateName('')
    setCreateError(null)
  }

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (actionBusy || !blankCreationReady) return
    const nextName = createName.trim()
    if (!nextName && !blankCreation?.pending) {
      setCreateError('请先输入项目名称')
      return
    }
    setCreateSaving(true)
    setCreateError(null)
    try {
      const created = await onCreate(nextName)
      if (created) {
        setCreating(false)
        if (!blankCreation) setCreateName('')
      }
    } catch (createFailure) {
      setCreateError(createFailure instanceof Error ? createFailure.message : String(createFailure))
    } finally {
      setCreateSaving(false)
    }
  }

  const beginAction = (project: CanvasStoredProjectSummary, kind: ProjectAction) => {
    setCreating(false)
    setAction({ project, kind })
    setActionName(kind === 'duplicate' ? `${project.name} 副本` : project.name)
    setActionError(null)
  }

  const submitAction = async (event: FormEvent) => {
    event.preventDefault()
    if (!action || actionSaving) return
    const nextName = actionName.trim()
    if (action.kind !== 'archive' && !nextName) {
      setActionError('项目名称不能为空')
      return
    }
    setActionSaving(true)
    setActionError(null)
    try {
      const completed = action.kind === 'rename'
        ? await onRename(action.project.id, nextName)
        : action.kind === 'duplicate'
          ? await onDuplicate(action.project.id, nextName)
          : await onSetArchived(action.project.id, true)
      if (completed) setAction(null)
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : String(actionFailure))
    } finally {
      setActionSaving(false)
    }
  }

  return (
    <main className="canvas-project-center">
      <section className="canvas-project-center-head">
        <span><strong>星芒画布项目</strong><small>{copy.introduction}</small></span>
        <button type="button" className="canvas-project-create" disabled={loading || createSaving} onClick={beginCreate}>
          <Plus size={15} />新建项目
        </button>
      </section>
      {blankCreation?.pending && !creating && <section className="canvas-project-error" role="status">
        <p style={{ overflowWrap: 'anywhere' }}>原新建画布待核对：{blankCreation.pending.summary.name}</p>
        <button type="button" disabled={loading || actionBusy} onClick={beginCreate}>核对原新建项目</button>
      </section>}
      {blankCreation?.error && !creating && <p className="canvas-project-error" role="alert">{blankCreation.error}</p>}
      <section className="canvas-project-center-tabs" aria-label="项目视图">
        <button type="button" disabled={actionBusy} className={currentView === 'recent' ? 'is-active' : ''} onClick={() => changeView('recent')}>{paged ? '当前项目' : '最近项目'} <span>{paged ? page?.counts.active ?? '—' : activeProjects.length}</span></button>
        <button type="button" disabled={actionBusy} className={currentView === 'archived' ? 'is-active' : ''} onClick={() => changeView('archived')}>已归档 <span>{paged ? page?.counts.archived ?? '—' : archivedProjects.length}</span></button>
      </section>
      {paged && query && onQueryChange && <section className="canvas-project-query" aria-label="工程查询">
        <label><span>搜索项目</span><input type="search" value={search} maxLength={256} disabled={actionBusy} placeholder="按项目名称搜索" onChange={(event) => {
          searchPendingRef.current = true
          setSearch(event.target.value)
          onQueryPending?.()
        }} /></label>
        <label><span>排序</span><select value={query.sort} disabled={actionBusy} onChange={(event) => {
          searchPendingRef.current = false
          onQueryChange({ ...query, q: search || undefined, sort: event.target.value as CanvasProjectListQuery['sort'], offset: 0 })
        }}><option value="updated-desc">最近修改</option><option value="created-desc">最近创建</option><option value="name-asc">名称顺序</option></select></label>
      </section>}
      <section className="canvas-project-list" aria-label={currentView === 'recent' ? '当前画布项目' : '已归档画布项目'}>
        {error && <div className="canvas-project-error" role="alert">
          <p>{error}</p>
          {onRefresh && <button type="button" disabled={loading} onClick={onRefresh}>重新读取项目</button>}
        </div>}
        {loading && <p className="canvas-project-empty">正在读取项目…</p>}
        {!loading && !error && visibleProjects.length === 0 && (
          <div className="canvas-project-empty">
            {currentView === 'recent' ? <FolderOpen size={30} /> : <Archive size={30} />}
            <strong>{paged && query?.q ? '没有匹配的项目' : currentView === 'recent' ? '还没有画布项目' : '没有已归档项目'}</strong>
            <span>{paged && query?.q ? '请调整搜索词或切换项目视图。' : currentView === 'recent' ? storageMode === 'cloud' ? '点击右上角「新建项目」，输入名称后创建云端项目。' : '点击右上角「新建项目」，输入名称后再选择工作文件夹。' : copy.archiveHint}</span>
          </div>
        )}
        {visibleProjects.map((project) => {
          const workspace = workspaceCopy(project, storageMode)
          const cannotOpen = Boolean(project.archivedAt) || project.workspaceStatus === 'missing'
          return (
            <article key={project.id} className={`canvas-project-card${project.archivedAt ? ' is-archived' : ''}${project.workspaceStatus === 'missing' ? ' is-missing' : ''}`}>
              <button type="button" className="canvas-project-open" disabled={cannotOpen || loading} onClick={() => onOpen(project.id)} aria-label={`打开项目：${project.name}`}>
                <span className="canvas-project-preview"><ProjectPreview project={project} /></span>
                <span className="canvas-project-content">
                  <span className="canvas-project-title"><strong title={project.name}>{project.name}</strong>{project.archivedAt && <em>已归档</em>}</span>
                  <span className="canvas-project-metrics"><small>{project.nodeCount ?? '—'} 个节点</small><small>{project.assetCount ?? '—'} 个已采纳素材</small></span>
                  {project.summaryStatus === 'unavailable' && <small>项目摘要待核对</small>}
                  <span className={`canvas-project-workspace ${workspace.className}`}>
                    {storageMode === 'cloud' ? <Cloud size={12} /> : project.workspaceStatus === 'missing' ? <TriangleAlert size={12} /> : <HardDrive size={12} />}
                    <span><strong>{workspace.label}</strong><small title={workspace.detail}>{workspace.detail}</small></span>
                  </span>
                  <small className="canvas-project-time">最近打开 {new Date(project.lastOpenedAt || project.updatedAt).toLocaleString()}</small>
                </span>
              </button>
              <span className="canvas-project-actions" aria-label={`${project.name} 项目操作`}>
                <button type="button" title="重命名项目" aria-label={`重命名项目：${project.name}`} disabled={loading} onClick={() => beginAction(project, 'rename')}><Pencil size={14} /></button>
                {!project.archivedAt && <button type="button" title={project.workspaceStatus === 'ready' ? '复制项目' : '工作目录不可用，无法复制'} aria-label={`复制项目：${project.name}`} disabled={loading || project.workspaceStatus !== 'ready'} onClick={() => beginAction(project, 'duplicate')}><Copy size={14} /></button>}
                {project.archivedAt
                  ? <button type="button" title="恢复项目" aria-label={`恢复项目：${project.name}`} disabled={loading || actionBusy} onClick={() => { void restoreProject(project.id) }}><ArchiveRestore size={14} /></button>
                  : <button type="button" title="归档项目" aria-label={`归档项目：${project.name}`} disabled={loading} onClick={() => beginAction(project, 'archive')}><Archive size={14} /></button>}
              </span>
            </article>
          )
        })}
      </section>
      {paged && query && onQueryChange && <footer className="canvas-project-pagination" aria-label="工程分页">
        <span role="status">{loading ? '正在读取项目…' : error ? '项目列表暂不可读取' : page ? canvasProjectPageRange(page) : '项目总数待读取'}</span>
        <button type="button" disabled={loading || actionBusy || Boolean(error) || query.offset === 0} onClick={() => onQueryChange({ ...query, offset: Math.max(0, query.offset - query.limit) })}>上一页</button>
        <button type="button" disabled={loading || actionBusy || Boolean(error) || !page || page.offset + page.items.length >= page.total} onClick={() => onQueryChange({ ...query, offset: query.offset + query.limit })}>下一页</button>
      </footer>}
      {creating && (
        <div className="canvas-project-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !actionBusy) setCreating(false)
        }}>
          <form className="canvas-project-dialog" role="dialog" aria-modal="true" aria-label="新建项目" onSubmit={(event) => void submitCreate(event)}>
            <header>
              <span>
                <Plus size={16} />
                <strong>新建项目</strong>
              </span>
              <button type="button" title="关闭" aria-label="关闭新建项目" disabled={actionBusy} onClick={() => setCreating(false)}><X size={16} /></button>
            </header>
            <label><span>{blankCreation?.pending ? '下一次的新项目名称' : '项目名称'}</span><input autoFocus value={createName} maxLength={256} aria-label="项目名称" onChange={(event) => setCreateName(event.target.value)} /></label>
            {blankCreation?.pending && <section className="canvas-project-create-recovery" aria-label="原新建画布恢复">
              <strong>{blankCreation.phase === 'confirmed' ? '原画布已经创建' : blankCreation.phase === 'missing' ? '暂未找到原画布' : '原画布创建结果尚未确认'}</strong>
              <p>原名称：{blankCreation.pending.summary.name}</p>
              <p>{blankCreation.phase === 'confirmed' ? '打开入口只指向原画布；新名称仍作为下一次的草稿保留。' : '核对只读取原结果；继续创建始终使用原名称和原操作编号。'}</p>
              {blankCreation.phase === 'missing' && <button type="button" disabled={actionBusy} onClick={() => void onContinueBlankCreate?.()}>按原请求继续创建</button>}
              {blankCreation.phase === 'confirmed' && <button type="button" disabled={actionBusy} onClick={() => void onFinishBlankCreate?.()}>原画布已确认，保留名称草稿开始下一次新建</button>}
              {blankCreation.confirmedProject?.archivedAt && <p>原画布位于归档，请关闭窗口并在归档列表恢复。</p>}
            </section>}
            {blankCreation?.error && <p className="canvas-project-dialog-error" role="alert">{blankCreation.error}</p>}
            {blankDraftError && <p className="canvas-project-dialog-error" role="alert">{blankDraftError}</p>}
            {createError && <p className="canvas-project-dialog-error" role="alert">{createError}</p>}
            <footer>
              <button type="button" disabled={actionBusy} onClick={() => setCreating(false)}>取消</button>
              <button type="submit" className="is-primary" disabled={actionBusy || !blankCreationReady || (!blankCreation?.pending && (!createName.trim() || Boolean(blankDraftError))) || Boolean(blankCreation?.confirmedProject?.archivedAt)}>
                {actionBusy ? '处理中…' : blankCreation?.pending ? blankCreation.phase === 'confirmed' ? '打开原项目' : '核对原项目' : copy.create}
              </button>
            </footer>
          </form>
        </div>
      )}
      {action && (
        <div className="canvas-project-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !actionSaving) setAction(null)
        }}>
          <form className="canvas-project-dialog" role="dialog" aria-modal="true" aria-label={action.kind === 'rename' ? '重命名项目' : action.kind === 'duplicate' ? '复制项目' : '归档项目'} onSubmit={(event) => void submitAction(event)}>
            <header>
              <span>
                {action.kind === 'rename' ? <Pencil size={16} /> : action.kind === 'duplicate' ? <Copy size={16} /> : <Archive size={16} />}
                <strong>{action.kind === 'rename' ? '重命名项目' : action.kind === 'duplicate' ? '复制项目' : '归档项目'}</strong>
              </span>
              <button type="button" title="关闭" aria-label="关闭项目操作" disabled={actionSaving} onClick={() => setAction(null)}><X size={16} /></button>
            </header>
            {action.kind === 'archive'
              ? <p>归档「{action.project.name}」后将不再出现在当前项目中。{copy.archiveHint}</p>
              : <label><span>项目名称</span><input autoFocus value={actionName} maxLength={128} onChange={(event) => setActionName(event.target.value)} /></label>}
            {action.kind === 'duplicate' && <small>{copy.duplicateHint}</small>}
            {actionError && <p className="canvas-project-dialog-error" role="alert">{actionError}</p>}
            <footer>
              <button type="button" disabled={actionSaving} onClick={() => setAction(null)}>取消</button>
              <button type="submit" className={action.kind === 'archive' ? 'is-warning' : 'is-primary'} disabled={actionSaving || (action.kind !== 'archive' && !actionName.trim())}>
                {actionSaving ? '处理中…' : action.kind === 'rename' ? '保存名称' : action.kind === 'duplicate' ? copy.duplicate : '确认归档'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </main>
  )
}
