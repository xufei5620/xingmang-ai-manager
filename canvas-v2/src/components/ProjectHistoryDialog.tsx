import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, GitBranch, RotateCcw, X } from 'lucide-react'
import type { CanvasHostBridge } from '../host'
import type { CanvasProjectHistoryPage, CanvasProjectRevisionDetail } from '../lib/project-history-contract'
import { parseWorkflowFile } from '../model'
import { buildProjectHistoryPreview } from '../editor/project-history-preview'
import { focusCanvasDraftReturnControl } from '../persistence/browser-draft-actions'
import '../theme/project-history.css'

export function ProjectHistoryGraph({ detail }: { detail: CanvasProjectRevisionDetail }) {
  const workflow = useMemo(() => parseWorkflowFile(detail.content), [detail.content])
  const graph = useMemo(() => workflow ? buildProjectHistoryPreview(workflow) : null, [workflow])
  if (!graph || !workflow) return <p role="alert">此版本的画布格式无法预览，请保留当前工程。</p>
  return <div className="project-history-graph">
    <svg viewBox={graph.viewBox} role="img" aria-label={`版本 ${detail.revision.projectVersion} 的真实画布结构，${workflow.nodes.length} 个节点、${workflow.edges.length} 条连线`}>
      <g className="history-preview-edges">{graph.edges.map((edge) => <path key={edge.id} d={`M${edge.x1},${edge.y1} C${(edge.x1 + edge.x2) / 2},${edge.y1} ${(edge.x1 + edge.x2) / 2},${edge.y2} ${edge.x2},${edge.y2}`} />)}</g>
      {graph.nodes.map((node) => <g key={node.id} transform={`translate(${node.x} ${node.y})`} className={node.group ? 'history-preview-node is-group' : 'history-preview-node'}>
        <title>{`${node.title} · ${node.typeTitle} · ${node.id}`}</title>
        <rect width={node.width} height={node.height} rx="12" />
        <text x="14" y="30" fontSize="16">{node.title.length > 18 ? `${node.title.slice(0, 17)}…` : node.title}</text>
        {!node.group && <text x="14" y="55" fontSize="12" className="history-preview-kind">{node.typeTitle}</text>}
      </g>)}
      {!graph.nodes.length && <text x="320" y="180" textAnchor="middle" fill="currentColor" fontSize="18">此版本为空白画布</text>}
    </svg>
    <div><GitBranch size={14} /><span>{workflow.nodes.length} 个节点 · {workflow.edges.length} 条连线</span><span>按保存时布局预览</span></div>
    {graph.truncated && <p>大型工程预览展示前 2,000 个节点及 4,000 条连线；恢复时使用完整工程。</p>}
  </div>
}

export function ProjectHistoryDialog({ shared, projectId, name, cloudVersion, bridge, busy, error, pendingRevisionId, pendingOperationId, pendingState, restoreBlocked, returnFocus, onRestore, onRetry, onRetryMissing, onReload, onClose }: {
  shared?: boolean
  projectId: string
  name: string
  cloudVersion: number
  bridge: CanvasHostBridge
  busy: boolean
  error: string | null
  pendingRevisionId?: string
  pendingOperationId?: string
  pendingState?: 'unknown' | 'missing' | 'completed' | 'changed'
  restoreBlocked?: string | null
  returnFocus?: HTMLElement | null
  onRestore(detail: CanvasProjectRevisionDetail): void
  onRetry(): void
  onRetryMissing?(): void
  onReload(): void
  onClose(): void
}) {
  const [page, setPage] = useState<CanvasProjectHistoryPage | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(pendingRevisionId ?? null)
  const [detail, setDetail] = useState<CanvasProjectRevisionDetail | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [confirmation, setConfirmation] = useState<CanvasProjectRevisionDetail | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  useEffect(() => {
    dialog.current?.focus()
    return () => { focusCanvasDraftReturnControl([returnFocus ?? null, document.querySelector<HTMLButtonElement>('.canvas-toolbar [aria-label="更多操作"]')]) }
  }, [])
  useEffect(() => {
    if (confirmation) { wasConfirming.current = true; cancelButton.current?.focus() }
    else if (wasConfirming.current) { wasConfirming.current = false; restoreButton.current?.focus() }
  }, [confirmation])
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true); setListError(null)
    void bridge.listProjectHistory!(projectId, controller.signal).then((result) => {
      if (!active) return
      setPage(result)
      setSelectedId((id) => pendingRevisionId ?? (id && result.items.some((item) => item.id === id) ? id : result.items[0]?.id ?? null))
    }).catch((cause) => { if (active) setListError(cause instanceof Error ? cause.message : '版本列表读取失败，请重试') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [bridge, projectId, refresh, pendingRevisionId])
  useEffect(() => {
    setDetail(null); setDetailError(null); setConfirmation(null)
    if (!selectedId) { setReading(false); return }
    const controller = new AbortController()
    let active = true
    setReading(true)
    void bridge.readProjectRevision!(projectId, selectedId, controller.signal).then((result) => { if (active) setDetail(result) })
      .catch((cause) => { if (active) setDetailError(cause instanceof Error ? cause.message : '此版本暂时无法读取，请刷新后核对') })
      .finally(() => { if (active) setReading(false) })
    return () => { active = false; controller.abort() }
  }, [bridge, projectId, selectedId, refresh])
  return <div className="canvas-project-dialog-backdrop">
    <div className="project-history-dialog" ref={dialog} role={confirmation ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="project-history-title" aria-describedby={confirmation ? 'project-history-confirm-description' : undefined} aria-busy={busy} tabIndex={-1} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) { if (confirmation) setConfirmation(null); else onClose() }; return }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0)
      const first = controls[0], last = controls[controls.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
    }}>
      <header><div><Clock3 size={19} /><span><strong id="project-history-title">版本历史</strong><small>{name} · 当前版本 {cloudVersion}</small></span></div><button type="button" aria-label="关闭版本历史" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <div className="project-history-body">
        <aside aria-label="已保存的工程版本">
          <div className="project-history-list-heading"><span>最近 10 个版本</span><button type="button" disabled={loading || busy || Boolean(pendingRevisionId) || Boolean(confirmation)} onClick={() => setRefresh((value) => value + 1)}>刷新</button></div>
          {loading && <p role="status">正在读取版本…</p>}
          {listError && <p className="history-error" role="alert">{listError}</p>}
          {!loading && !listError && page?.items.length === 0 && <p>还没有历史版本。保存新的画布修改后，会在这里留下版本。</p>}
          {page?.items.map((item) => <button key={item.id} type="button" className={`project-history-item${selectedId === item.id ? ' is-selected' : ''}`} aria-pressed={selectedId === item.id} disabled={busy || Boolean(pendingRevisionId) || Boolean(confirmation)} onClick={() => setSelectedId(item.id)}>
            <span><strong>版本 {item.projectVersion}</strong><small>{item.kind === 'restore-point' ? '恢复前的保存点' : '保存版本'}</small></span>
            <time dateTime={item.savedAt}>{new Date(item.savedAt).toLocaleString('zh-CN')}</time>
            <small>{item.authorName || '保存者未记录'} · {item.nodeCount ?? '—'} 个节点</small>
          </button>)}
        </aside>
        <main>
          {reading && <p role="status">正在读取此版本的画布…</p>}
          {detailError && <p className="history-error" role="alert">{detailError}</p>}
          {detail && <><div className="project-history-detail-heading"><strong>版本 {detail.revision.projectVersion}</strong><small>预览不会改变当前画布</small></div><ProjectHistoryGraph detail={detail} />
            {detail.missingAssets.length > 0 && <section className="history-error" role="alert"><strong>有 {detail.missingAssets.length} 项旧素材不可读取，暂不能恢复</strong><p>请先到素材库恢复回收站中的素材。已不存在的素材不能自动找回，当前画布会保留。</p><ul>{detail.missingAssets.slice(0, 8).map((asset) => <li key={asset.assetId}>{asset.reason === 'trash' ? '素材在回收站' : '素材已不存在'} · {asset.assetId} · 关联 {asset.nodeIds.length} 个节点</li>)}</ul>{detail.missingAssets.length > 8 && <p>另有 {detail.missingAssets.length - 8} 项。</p>}</section>}
          </>}
          {!reading && !detail && !detailError && <p className="project-history-empty">选择左侧版本，查看保存时的节点与连线。</p>}
        </main>
      </div>
      <div className="project-history-feedback" aria-live="polite">
        {error && <p className="history-error" role="alert">{error}</p>}
        {pendingRevisionId && <section><strong>{pendingState === 'changed' ? '恢复已提交，工程随后又有更新' : pendingState === 'completed' ? '原恢复已经提交，核对后可载入' : pendingState === 'missing' ? '服务器未找到原恢复操作' : '正在保留原恢复操作，自动保存已暂停'}</strong>{pendingOperationId && <p>原恢复编号：<code>{pendingOperationId}</code></p>}<p>刷新和核对只读取原结果，不会重新提交。可关闭窗口保留当前画布；需要重试时仍使用原编号、原版本和原恢复目标。</p><div>{pendingState !== 'changed' && <button type="button" disabled={busy} onClick={onRetry}>{pendingState === 'completed' ? '核对并载入已恢复版本' : '核对原恢复操作'}</button>}{pendingState === 'missing' && onRetryMissing && <button type="button" disabled={busy} onClick={onRetryMissing}>按原编号重试恢复</button>}<button type="button" disabled={busy} onClick={onReload}>{pendingState === 'changed' || pendingState === 'completed' ? '保留本地草稿并读取云端，结束核对' : '保留本地草稿并读取云端'}</button></div></section>}
        {!pendingRevisionId && restoreBlocked && <p>{restoreBlocked}</p>}
        {confirmation && !pendingRevisionId && <section className="project-history-confirm"><strong>恢复到版本 {confirmation.revision.projectVersion}？</strong><p id="project-history-confirm-description">会先保存当前修改，并自动留下恢复前的保存点，再把所选画布保存为新版本。当前撤销记录会清空；仍可从版本历史恢复回来。</p><div><button ref={cancelButton} type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消，保留当前画布</button><button type="button" className="is-primary" disabled={busy || Boolean(restoreBlocked)} onClick={() => onRestore(confirmation)}>{busy ? '正在保存并恢复…' : '保存当前并恢复此版本'}</button></div></section>}
      </div>
      <footer><small>{shared ? '共享期间记录 · 当前团队授权可访问' : '云端保存记录 · 仅当前账户可访问'}</small><div><button type="button" disabled={busy} onClick={onClose}>关闭</button><button ref={restoreButton} type="button" className="is-primary" disabled={busy || reading || !detail?.canRestore || Boolean(restoreBlocked) || Boolean(pendingRevisionId) || Boolean(confirmation)} onClick={() => detail && setConfirmation(detail)}><RotateCcw size={14} />恢复此版本</button></div></footer>
    </div>
  </div>
}
