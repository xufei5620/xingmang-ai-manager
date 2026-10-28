import { Download, FilePlus2, Film, Maximize2 } from 'lucide-react'
import type { AssetRef, WorkflowCandidateRef, WorkflowNodeData } from '../model'
import { ViewportVideo, isLocalCanvasAssetUrl } from '../components/MediaPreview'
import './video-candidate-panel.css'

export interface VideoCandidatePanelProps {
  candidates: readonly WorkflowCandidateRef[]
  selectedCandidateId?: string
  progress?: WorkflowNodeData['videoBatchProgress']
  status: WorkflowNodeData['status']
  disabledReason?: string
  onSelect(candidateId: string): void
  onPreview(asset: AssetRef): void
  onDownload?(): void
  onPlace?(candidateId: string): void
}

export function videoCandidateProgressLabel(progress: VideoCandidatePanelProps['progress'], saved: number, status: WorkflowNodeData['status']): string {
  if (progress && Number.isInteger(progress.total) && progress.total >= 1 && progress.total <= 4
    && Number.isInteger(progress.completed) && progress.completed >= 0 && progress.completed <= progress.total
    && Number.isInteger(progress.submitted) && progress.submitted >= progress.completed && progress.submitted <= progress.total) {
    return `已完成 ${progress.completed}/${progress.total} · 已提交 ${progress.submitted}`
  }
  return saved ? `已保存 ${saved} 个视频` : status === 'running' || status === 'queued' ? '正在准备视频任务' : '暂无已保存的视频'
}

export function VideoCandidatePanel(props: VideoCandidatePanelProps) {
  const candidates = props.candidates.filter((candidate) => candidate.asset.kind === 'video')
  const selected = candidates.find((candidate) => candidate.candidateId === props.selectedCandidateId)
  const progressLabel = videoCandidateProgressLabel(props.progress, candidates.length, props.status)
  const running = props.status === 'running' || props.status === 'queued'
  const disabledReason = props.disabledReason ?? (running ? '生成期间可预览已保存视频，完成后再切换产物' : undefined)
  const detail = props.status === 'failed' ? '已完成的视频会保留；未完成任务可在运行记录中核对。'
    : running ? '视频任务逐条执行；已完成的视频可以预览。'
      : '点击切换节点产物；下游会标记为待重新运行，不提交生成任务。'
  return <section className="video-candidate-panel nodrag nowheel" aria-label="视频生成候选" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    {candidates.length > 0 && <div className="video-candidate-strip">
      {candidates.map((candidate, index) => <button type="button" key={candidate.candidateId} className={`video-candidate-tile${candidate.candidateId === selected?.candidateId ? ' is-selected' : ''}`} aria-label={`${disabledReason ? '预览' : '采用'}视频候选 ${index + 1}`} aria-pressed={candidate.candidateId === selected?.candidateId} title={disabledReason ? `${disabledReason}；点击预览候选 ${index + 1}` : `候选 ${index + 1}：点击采用，双击放大预览`} onClick={() => { if (disabledReason) props.onPreview(candidate.asset); else props.onSelect(candidate.candidateId) }} onDoubleClick={(event) => { event.stopPropagation(); props.onPreview(candidate.asset) }}>
        {isLocalCanvasAssetUrl(candidate.asset.localUrl, 'video') ? <ViewportVideo src={candidate.asset.localUrl} muted playsInline aria-hidden="true" tabIndex={-1} /> : <Film size={17} aria-hidden="true" />}
        <span>{index + 1}</span>
      </button>)}
    </div>}
    <div className="video-candidate-footer">
      <small role="status" title={`${progressLabel}。${detail}`}>{progressLabel}</small>
      {selected && <div className="video-candidate-actions" role="toolbar" aria-label="当前视频候选操作">
        <button type="button" aria-label="预览当前视频候选" title="放大预览当前视频" onClick={() => props.onPreview(selected.asset)}><Maximize2 size={12} aria-hidden="true" /></button>
        {props.onDownload && <button type="button" aria-label="下载当前视频候选" title="下载已采用的视频" onClick={props.onDownload}><Download size={12} aria-hidden="true" /></button>}
        {props.onPlace && <button type="button" aria-label="另存当前视频为节点" title={disabledReason ?? '另存为独立视频节点，固定当前视频，不重新生成'} disabled={Boolean(disabledReason)} onClick={() => { if (!disabledReason) props.onPlace?.(selected.candidateId) }}><FilePlus2 size={12} aria-hidden="true" /></button>}
      </div>}
    </div>
  </section>
}
