import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, Copy, FolderOpen, HardDrive, Music2, Pencil, Plus, TriangleAlert, X } from 'lucide-react'
import type { CanvasStoredProjectSummary } from '../host'
import { SafeImage, ViewportVideo } from './MediaPreview'

type ProjectAction = 'rename' | 'duplicate' | 'archive'

interface ProjectCenterProps {
  projects: readonly CanvasStoredProjectSummary[]
  loading: boolean
  error: string | null
  onCreate(name: string): Promise<boolean>
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

function workspaceCopy(project: CanvasStoredProjectSummary): { label: string; detail: string; className: string } {
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

export function ProjectCenter({ projects, loading, error, onCreate, onOpen, onRename, onDuplicate, onSetArchived, onDraftChange }: ProjectCenterProps) {
  const [view, setView] = useState<'recent' | 'archived'>('recent')
  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
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
  const visibleProjects = view === 'recent' ? activeProjects : archivedProjects

  const beginCreate = () => {
    if (loading || createSaving || actionSaving) return
    setAction(null)
    setCreating(true)
    setCreateName('')
    setCreateError(null)
  }

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (createSaving) return
    const nextName = createName.trim()
    if (!nextName) {
      setCreateError('请先输入项目名称')
      return
    }
    setCreateSaving(true)
    setCreateError(null)
    try {
      const created = await onCreate(nextName)
      if (created) {
        setCreating(false)
        setCreateName('')
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
        <span><strong>星芒画布项目</strong><small>每个项目使用独立工作文件夹，节点、布局和生成素材会自动保存</small></span>
        <button type="button" className="canvas-project-create" disabled={loading || createSaving} onClick={beginCreate}>
          <Plus size={15} />新建项目
        </button>
      </section>
      <section className="canvas-project-center-tabs" aria-label="项目视图">
        <button type="button" className={view === 'recent' ? 'is-active' : ''} onClick={() => setView('recent')}>最近项目 <span>{activeProjects.length}</span></button>
        <button type="button" className={view === 'archived' ? 'is-active' : ''} onClick={() => setView('archived')}>已归档 <span>{archivedProjects.length}</span></button>
      </section>
      <section className="canvas-project-list" aria-label={view === 'recent' ? '最近画布项目' : '已归档画布项目'}>
        {error && <p className="canvas-project-error" role="alert">{error}</p>}
        {loading && <p className="canvas-project-empty">正在读取项目…</p>}
        {!loading && visibleProjects.length === 0 && (
          <div className="canvas-project-empty">
            {view === 'recent' ? <FolderOpen size={30} /> : <Archive size={30} />}
            <strong>{view === 'recent' ? '还没有画布项目' : '没有已归档项目'}</strong>
            <span>{view === 'recent' ? '点击右上角「新建项目」，输入名称后再选择工作文件夹。' : '归档项目会保留工作流与本地素材，可随时恢复。'}</span>
          </div>
        )}
        {visibleProjects.map((project) => {
          const workspace = workspaceCopy(project)
          const cannotOpen = Boolean(project.archivedAt) || project.workspaceStatus === 'missing'
          return (
            <article key={project.id} className={`canvas-project-card${project.archivedAt ? ' is-archived' : ''}${project.workspaceStatus === 'missing' ? ' is-missing' : ''}`}>
              <button type="button" className="canvas-project-open" disabled={cannotOpen || loading} onClick={() => onOpen(project.id)} aria-label={`打开项目：${project.name}`}>
                <span className="canvas-project-preview"><ProjectPreview project={project} /></span>
                <span className="canvas-project-content">
                  <span className="canvas-project-title"><strong title={project.name}>{project.name}</strong>{project.archivedAt && <em>已归档</em>}</span>
                  <span className="canvas-project-metrics"><small>{project.nodeCount} 个节点</small><small>{project.assetCount} 个已采纳素材</small></span>
                  <span className={`canvas-project-workspace ${workspace.className}`}>
                    {project.workspaceStatus === 'missing' ? <TriangleAlert size={12} /> : <HardDrive size={12} />}
                    <span><strong>{workspace.label}</strong><small title={workspace.detail}>{workspace.detail}</small></span>
                  </span>
                  <small className="canvas-project-time">最近打开 {new Date(project.lastOpenedAt || project.updatedAt).toLocaleString()}</small>
                </span>
              </button>
              <span className="canvas-project-actions" aria-label={`${project.name} 项目操作`}>
                <button type="button" title="重命名项目" aria-label={`重命名项目：${project.name}`} disabled={loading} onClick={() => beginAction(project, 'rename')}><Pencil size={14} /></button>
                {!project.archivedAt && <button type="button" title={project.workspaceStatus === 'ready' ? '复制项目' : '工作目录不可用，无法复制'} aria-label={`复制项目：${project.name}`} disabled={loading || project.workspaceStatus !== 'ready'} onClick={() => beginAction(project, 'duplicate')}><Copy size={14} /></button>}
                {project.archivedAt
                  ? <button type="button" title="恢复项目" aria-label={`恢复项目：${project.name}`} disabled={loading} onClick={() => { void onSetArchived(project.id, false).catch(() => undefined) }}><ArchiveRestore size={14} /></button>
                  : <button type="button" title="归档项目" aria-label={`归档项目：${project.name}`} disabled={loading} onClick={() => beginAction(project, 'archive')}><Archive size={14} /></button>}
              </span>
            </article>
          )
        })}
      </section>
      {creating && (
        <div className="canvas-project-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !createSaving) setCreating(false)
        }}>
          <form className="canvas-project-dialog" role="dialog" aria-modal="true" aria-label="新建项目" onSubmit={(event) => void submitCreate(event)}>
            <header>
              <span>
                <Plus size={16} />
                <strong>新建项目</strong>
              </span>
              <button type="button" title="关闭" aria-label="关闭新建项目" disabled={createSaving} onClick={() => setCreating(false)}><X size={16} /></button>
            </header>
            <label><span>项目名称</span><input autoFocus value={createName} maxLength={128} aria-label="项目名称" onChange={(event) => setCreateName(event.target.value)} /></label>
            {createError && <p className="canvas-project-dialog-error" role="alert">{createError}</p>}
            <footer>
              <button type="button" disabled={createSaving} onClick={() => setCreating(false)}>取消</button>
              <button type="submit" className="is-primary" disabled={createSaving || !createName.trim()}>
                {createSaving ? '处理中…' : '选择文件夹并创建'}
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
              ? <p>归档「{action.project.name}」后将不再出现在最近项目中，工作流和本地素材不会删除。</p>
              : <label><span>项目名称</span><input autoFocus value={actionName} maxLength={128} onChange={(event) => setActionName(event.target.value)} /></label>}
            {action.kind === 'duplicate' && <small>下一步选择一个新的空工作文件夹，项目节点、布局和素材会一并复制。</small>}
            {actionError && <p className="canvas-project-dialog-error" role="alert">{actionError}</p>}
            <footer>
              <button type="button" disabled={actionSaving} onClick={() => setAction(null)}>取消</button>
              <button type="submit" className={action.kind === 'archive' ? 'is-warning' : 'is-primary'} disabled={actionSaving || (action.kind !== 'archive' && !actionName.trim())}>
                {actionSaving ? '处理中…' : action.kind === 'rename' ? '保存名称' : action.kind === 'duplicate' ? '选择文件夹并复制' : '确认归档'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </main>
  )
}
