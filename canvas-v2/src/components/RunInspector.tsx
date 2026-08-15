import type { CanvasRunCandidate, CanvasRunRecord, CanvasRunScope } from '../host'
import { Check, History, MoreHorizontal, Music2, RefreshCw, X } from 'lucide-react'
import { AudioPreview, SafeImage, ViewportVideo, isLocalCanvasAssetUrl } from './MediaPreview'
import { mediaAssetAspectRatio } from '../library/media-assets'

interface RunInspectorProps {
  open: boolean
  records: readonly CanvasRunRecord[]
  selectedRunId: string | null
  selectedCandidateIds: Readonly<Record<string, string | undefined>>
  selectedScope: CanvasRunScope['kind']
  dirtyCount: number
  selectionCount: number
  loading: boolean
  onScopeChange(scope: CanvasRunScope['kind']): void
  onRefresh(): void
  onSelectRun(runId: string): void
  onSelectCandidate(nodeId: string, candidate: CanvasRunCandidate): void
  onAdopt(nodeId: string, candidate: CanvasRunCandidate): void
  onPreviewAsset(asset: CanvasRunCandidate['asset']): void
  onAssetMenu(assetId: string): void
  onClose(): void
}

const statusLabel: Record<string, string> = {
  running: '运行中', succeeded: '已完成', partial: '部分完成', failed: '失败',
  cancelled: '已取消', interrupted: '已中断', cached: '缓存', skipped: '跳过',
}

export function RunInspector(props: RunInspectorProps) {
  const selected = props.records.find((record) => record.runId === props.selectedRunId) ?? props.records[0]
  const nodes = selected?.nodes ?? []
  return (
    <aside className={`run-inspector${props.open ? ' is-open' : ''}`} aria-label="运行与候选">
      <header>
        <History size={15} aria-hidden="true" />
        <strong>运行与候选</strong>
        <button type="button" title="刷新历史" aria-label="刷新历史" onClick={props.onRefresh}><RefreshCw size={15} /></button>
        <button type="button" title="关闭" aria-label="关闭运行面板" onClick={props.onClose}><X size={16} /></button>
      </header>
      <div className="run-scope-control">
        <label><span>运行范围</span>
          <select value={props.selectedScope} onChange={(event) => props.onScopeChange(event.target.value as CanvasRunScope['kind'])}>
            <option value="all">全部节点</option>
            <option value="dirty">仅变更节点 ({props.dirtyCount})</option>
            <option value="selection">选中链路 ({props.selectionCount})</option>
            <option value="to-node">运行到选中节点</option>
          </select>
        </label>
      </div>
      <div className="run-inspector-scroll">
        {props.loading && <p className="run-empty" role="status" aria-live="polite">正在读取运行历史</p>}
        {!props.loading && !selected && <p className="run-empty">运行工作流后，这里会保留候选、费用和错误</p>}
        {props.records.length > 0 && (
          <label className="run-history-select">
            <span>历史记录</span>
            <select value={selected?.runId ?? ''} onChange={(event) => props.onSelectRun(event.target.value)}>
              {props.records.map((record) => (
                <option key={record.runId} value={record.runId}>
                  {new Date(record.createdAt).toLocaleString()} · {statusLabel[record.status] ?? record.status}
                </option>
              ))}
            </select>
          </label>
        )}
        {selected && (
          <section className="run-summary">
            <div><strong>{statusLabel[selected.status] ?? selected.status}</strong><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
            <span>{typeof selected.durationMs === 'number' ? `${(selected.durationMs / 1000).toFixed(1)} 秒` : '正在执行'}</span>
          </section>
        )}
        {nodes.map((node) => {
          const attempt = node.attempts.at(-1)
          const candidates = node.attempts.flatMap((entry) => entry.candidates)
          const totalQuota = node.attempts.reduce((total, entry) => total + (entry.costQuota ?? 0), 0)
          return (
            <section className="run-node-record" key={node.nodeId}>
              <div className="run-node-head"><strong>{node.kind}</strong><span>{statusLabel[node.state] ?? node.state}</span></div>
              {node.errorMessage && <p role="alert">{node.errorMessage}</p>}
              {attempt && (
                <div className="run-meta">
                  <span>{node.attempts.length} 次尝试</span>
                  <span>{attempt.cached ? '缓存命中' : `${(attempt.durationMs / 1000).toFixed(1)} 秒`}</span>
                  {totalQuota > 0 && <span>{totalQuota} quota</span>}
                </div>
              )}
              {candidates.length ? (
                <div className="candidate-grid">
                  {candidates.map((candidate) => (
                    <article key={candidate.candidateId} className={props.selectedCandidateIds[node.nodeId] === candidate.candidateId ? 'is-selected' : ''}>
                      {candidate.asset.kind === 'image'
                        ? <button type="button" className="candidate-preview" title="单击选择，双击放大" onClick={() => props.onSelectCandidate(node.nodeId, candidate)} onDoubleClick={() => props.onPreviewAsset(candidate.asset)}><SafeImage src={candidate.asset.localUrl} alt="生成候选" fallbackLabel="候选不可用" onContextMenu={(event) => { event.preventDefault(); props.onAssetMenu(candidate.asset.assetId) }} /></button>
                        : candidate.asset.kind === 'video' && isLocalCanvasAssetUrl(candidate.asset.localUrl)
                          ? <ViewportVideo className="candidate-video" src={candidate.asset.localUrl} controls title="双击放大预览" style={{ aspectRatio: mediaAssetAspectRatio(candidate.asset) }} onDoubleClick={(event) => { event.stopPropagation(); props.onPreviewAsset(candidate.asset) }} onContextMenu={(event) => { event.preventDefault(); props.onAssetMenu(candidate.asset.assetId) }} />
                          : candidate.asset.kind === 'audio' && isLocalCanvasAssetUrl(candidate.asset.localUrl)
                            ? <div className="candidate-audio" title="双击放大预览" onDoubleClick={() => props.onPreviewAsset(candidate.asset)} onContextMenu={(event) => { event.preventDefault(); props.onAssetMenu(candidate.asset.assetId) }}><Music2 size={18} aria-hidden="true" /><AudioPreview src={candidate.asset.localUrl} /></div>
                            : <div className="candidate-video media-unavailable">{candidate.asset.kind === 'audio' ? '音频候选不可用' : '视频候选不可用'}</div>}
                      <div>
                        <button type="button" onClick={() => props.onAdopt(node.nodeId, candidate)}><Check size={12} />采纳</button>
                        <button type="button" title="更多资产操作" aria-label="候选资产操作" onClick={() => props.onAssetMenu(candidate.asset.assetId)}><MoreHorizontal size={14} /></button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </aside>
  )
}
