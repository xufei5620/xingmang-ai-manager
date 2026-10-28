import type { CanvasRunCandidate, CanvasRunRecord, CanvasRunScope } from '../host'
import { hostBridge } from '../host'
import { Check, Download, History, MoreHorizontal, Plus, Music2, RefreshCw, X } from 'lucide-react'
import { AudioPreview, SafeImage, ViewportVideo, isLocalCanvasAssetUrl } from './MediaPreview'
import { mediaAssetAspectRatio } from '../library/media-assets'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { AssetRef } from '../model'
import { sameCanvasMediaAsset } from '../library/media-result'
import { useEffect, useMemo, useRef, useState } from 'react'
import { canContinueCanvasRun, canvasRunContinueMessage, canvasRunWaitingEventLabel, canvasRunWaitingKind, canvasRunWaitingLabel } from '../runtime/run-waiting'
import { canvasVideoTaskTargetForAttempt, type CanvasVideoTaskActions } from '../lib/canvas-video-task-target'
import type { CanvasKernelSlots } from '../slots'
import { latestVideoBatchAttempts } from '../runtime/video-candidate-batch'
import { latestPaidAttemptDurationMs } from '../runtime/run-projection'
import { assetBatchDragIds, assetBatchDragMime, assetBatchSelectionError, maximumAssetBatchCount, orderedAssetBatchIds } from './asset-batch-selection'
import { assetSelectionForActivation, assetSelectionSelectAll, emptyAssetSelection } from './asset-selection'
import { runCandidateBatchItems } from './run-candidate-selection'
import { useAssetBatchActions, useScopedAssetSelection } from './use-asset-batch-actions'
import './asset-batch-actions.css'

interface RunInspectorProps {
  /** 网页外壳的插槽（#3）；不传时不显示原视频任务核对。 */
  VideoTaskRecovery?: CanvasKernelSlots['VideoTaskRecovery']
  open: boolean
  records: readonly CanvasRunRecord[]
  selectedRunId: string | null
  /** 已保存的素材身份在重开后仍然可靠，候选编号只是临时运行视图。 */
  resultAssets: Readonly<Record<string, AssetRef | undefined>>
  selectedScope: CanvasRunScope['kind']
  dirtyCount: number
  selectionCount: number
  loading: boolean
  error?: string | null
  onScopeChange(scope: CanvasRunScope['kind']): void
  onRefresh(): void
  onSelectRun(runId: string): void
  onUseCandidate(nodeId: string, candidate: CanvasRunCandidate): void
  onAddMany?(assetIds: readonly string[]): Promise<void>
  onDownloadMany?(assetIds: readonly string[]): Promise<void>
  batchScope?: string
  onPreviewAsset(asset: CanvasRunCandidate['asset']): void
  onAssetMenu(assetId: string): void
  onOpenAssets?(): void
  onOpenAgent?(): void
  onOpenCollection?(): void
  onLocateNode(nodeId: string): void
  onRetryNode?(nodeId: string, scope: 'to-node' | 'from-node'): void
  onResumeRun?(runId: string): Promise<boolean>
  onClose(): void
  embedded?: boolean
}

const statusLabel: Record<string, string> = {
  running: '运行中', succeeded: '已完成', partial: '部分完成', failed: '失败',
  cancelled: '已取消', interrupted: '已中断', cached: '缓存', skipped: '跳过',
  queued: '排队中', cancelling: '正在取消',
}

const stageLabel: Record<string, string> = {
  validating: '检查节点输入',
  'resolving-cache': '检查本地缓存',
  'waiting-slot': '等待执行槽位',
  submitting: '提交生成请求',
  processing: '服务端处理中',
  downloading: '下载生成结果',
  saving: '保存到工作目录',
}

function eventLabel(event: CanvasRunRecord['events'][number]): string {
  if (event.type === 'run-terminal') return `运行${statusLabel[event.status] ?? event.status}`
  if (event.type === 'run-waiting') return canvasRunWaitingEventLabel(event)
  if (event.type === 'node-stage') return `${event.nodeId}：${stageLabel[event.stage] ?? event.stage}`
  return `${event.nodeId}：${statusLabel[event.state] ?? event.state}`
}

export function RunInspector(props: RunInspectorProps) {
  const { VideoTaskRecovery } = props
  const bridge = typeof window === 'undefined' ? undefined : hostBridge()
  const videoTaskActions = useMemo<CanvasVideoTaskActions | undefined>(() => bridge?.inspectVideoTask && bridge.checkVideoTask && bridge.saveVideoTask ? {
    inspect: (target) => bridge.inspectVideoTask!(target),
    check: (target, version) => bridge.checkVideoTask!(target, version),
    save: (target, version) => bridge.saveVideoTask!(target, version),
  } : undefined, [bridge])
  const selected = props.records.find((record) => record.runId === props.selectedRunId) ?? props.records[0]
  const nodes = selected?.nodes ?? []
  const batchItems = useMemo(() => runCandidateBatchItems(selected), [selected])
  const batchVisibleIds = useMemo(() => batchItems.map((item) => item.assetId), [batchItems])
  const availableBatchItems = batchItems.filter((item) => !item.unavailableReason)
  const availableBatchIds = availableBatchItems.map((item) => item.assetId)
  const selectionScope = JSON.stringify([props.batchScope ?? '', selected?.runId ?? ''])
  const { selection, setSelection } = useScopedAssetSelection(selectionScope, batchVisibleIds)
  const batchActions = useAssetBatchActions(selectionScope)
  const selectedBatchIds = orderedAssetBatchIds(batchItems, selection.ids)
  const batchError = assetBatchSelectionError(batchItems, selectedBatchIds)
  const batchEnabled = !!(props.onAddMany || props.onDownloadMany)
  function selectAllCandidates() {
    if (batchActions.busy || props.loading) return
    if (availableBatchIds.length > maximumAssetBatchCount) { batchActions.reportError(`本次运行有 ${availableBatchIds.length} 项可用素材，一次最多选择 ${maximumAssetBatchCount} 项，请逐项选择`); return }
    setSelection(assetSelectionSelectAll(availableBatchIds))
  }
  function runBatch(kind: 'add' | 'download') {
    if (props.loading || batchActions.busy) return
    if (batchError) { batchActions.reportError(batchError); return }
    void batchActions.run(kind, selectedBatchIds, kind === 'add' ? props.onAddMany : props.onDownloadMany)
  }
  const [resumeBusy, setResumeBusy] = useState(false)
  const [resumeFeedback, setResumeFeedback] = useState<string | null>(null)
  const resumeBusyRef = useRef(false)
  const mounted = useRef(true)
  const selectedRef = useRef(selected?.runId)
  selectedRef.current = selected?.runId
  const resumeEpoch = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; resumeEpoch.current += 1 } }, [])
  useEffect(() => { resumeEpoch.current += 1; setResumeFeedback(null) }, [selected?.runId])
  async function continueRun() {
    if (!selected || !props.onResumeRun || !canContinueCanvasRun(selected) || resumeBusyRef.current) return
    const runId = selected.runId
    const epoch = resumeEpoch.current
    resumeBusyRef.current = true
    setResumeBusy(true)
    setResumeFeedback(null)
    try {
      const started = await props.onResumeRun(runId)
      if (!mounted.current || selectedRef.current !== runId || resumeEpoch.current !== epoch) return
      setResumeFeedback(canvasRunContinueMessage(started === true))
      props.onRefresh()
    } catch {
      if (mounted.current && selectedRef.current === runId && resumeEpoch.current === epoch) setResumeFeedback('继续结果未确认，请先刷新运行历史核对；不会自动新建任务或重新提交生成。')
    } finally {
      resumeBusyRef.current = false
      if (mounted.current) setResumeBusy(false)
    }
  }
  return (
    <aside className={`run-inspector${props.open ? ' is-open' : ''}${props.embedded ? ' is-embedded' : ''}`} aria-label="运行与候选">
      {!props.embedded && <header>
        <History size={15} aria-hidden="true" />
        <strong>运行与候选</strong>
        <button type="button" title="刷新历史" aria-label="刷新历史" disabled={props.loading} onClick={props.onRefresh}><RefreshCw size={15} /></button>
        <button type="button" title="关闭" aria-label="关闭运行面板" onClick={props.onClose}><X size={16} /></button>
      </header>}
      <div className="run-scope-control">
        <label><span>运行范围</span>
          <select value={props.selectedScope} onChange={(event) => props.onScopeChange(event.target.value as CanvasRunScope['kind'])}>
            <option value="all">全部节点</option>
            <option value="dirty">仅变更节点 ({props.dirtyCount})</option>
            <option value="selection">选中链路 ({props.selectionCount})</option>
            <option value="to-node">运行到选中节点</option>
            <option value="from-node">从选中节点向后运行</option>
          </select>
        </label>
        {props.embedded && <div className="run-history-tools">
          <button type="button" aria-label="刷新历史" disabled={props.loading} onClick={props.onRefresh}><RefreshCw size={13} />{props.loading ? '读取中…' : '刷新历史'}</button>
        </div>}
      </div>
      {props.onOpenCollection && <div className="run-history-tools"><button type="button" onClick={props.onOpenCollection}><History size={14} />跨运行结果收集</button></div>}
      <div className="run-inspector-scroll" onKeyDown={(event) => {
        if (!batchEnabled || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || (event.target instanceof HTMLElement && event.target.closest('textarea, input:not([type="checkbox"]), select, [contenteditable="true"]'))) return
        if (event.key === 'Escape' && selection.ids.size) { event.preventDefault(); event.stopPropagation(); if (!batchActions.busy) setSelection(emptyAssetSelection) }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); selectAllCandidates() }
      }}>
        {props.error && <p className="run-recovery-hint" role="alert">运行历史读取失败：{props.error}。可点击「刷新历史」重试。</p>}
        {props.loading && <p className="run-empty" role="status" aria-live="polite">正在读取运行历史</p>}
        {!props.loading && !props.error && !selected && <p className="run-empty">运行工作流后，这里会保留候选、耗时和错误</p>}
        {props.records.length > 0 && (
          <label className="run-history-select">
            <span>历史记录</span>
            <select value={selected?.runId ?? ''} onChange={(event) => props.onSelectRun(event.target.value)}>
              {props.records.map((record) => (
                <option key={record.runId} value={record.runId}>
                  {new Date(record.createdAt).toLocaleString()} · {record.purpose === 'agent-plan' ? 'Agent 规划 · ' : ''}{statusLabel[record.status] ?? record.status}
                </option>
              ))}
            </select>
          </label>
        )}
        {selected && (
          <section className="run-summary">
            <div><strong>{statusLabel[selected.status] ?? selected.status}</strong><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
            <span>{typeof selected.durationMs === 'number' ? `${(selected.durationMs / 1000).toFixed(1)} 秒` : selected.status === 'running' ? '正在执行' : '耗时未记录'}</span>
          </section>
        )}
        {selected && batchEnabled && <section className="asset-batch-toolbar run-candidate-batch" aria-label="历史素材批量复用">
          <div className="asset-batch-selection"><strong>本次运行素材</strong><span>已选 {selectedBatchIds.length} / {availableBatchItems.length} 项</span><button type="button" disabled={!!batchActions.busy || props.loading || !availableBatchIds.length || availableBatchIds.length > maximumAssetBatchCount} title={availableBatchIds.length > maximumAssetBatchCount ? `超过 ${maximumAssetBatchCount} 项，请逐项选择` : '仅选择本次运行已保存的可用素材，相同素材只选一次'} onClick={selectAllCandidates}>全选可用素材</button><button type="button" disabled={!!batchActions.busy || !selectedBatchIds.length} onClick={() => setSelection(emptyAssetSelection)}>取消选择</button></div>
          <div className="asset-batch-buttons">{props.onAddMany && <button type="button" disabled={!!batchActions.busy || props.loading || !!batchError} title={batchError || '创建独立素材节点，不改变各节点当前采用的候选'} onClick={() => runBatch('add')}><Plus size={13} />{batchActions.busy === 'add' ? '正在加入…' : '加入画布'}</button>}{props.onDownloadMany && <button type="button" disabled={!!batchActions.busy || props.loading || !!batchError} title={batchError || '打包下载所选原文件'} onClick={() => runBatch('download')}><Download size={13} />{batchActions.busy === 'download' ? '正在打包…' : '打包下载'}</button>}</div>
          <small>按节点与候选顺序，最多 {maximumAssetBatchCount} 项；选择不会替换当前产物{props.onAddMany ? '，可整体拖入画布。' : '，当前仅可打包下载。'}</small>
          {batchItems.length > availableBatchItems.length && <small>{batchItems.length - availableBatchItems.length} 项未保存或不可用，不能批量加入或下载。</small>}
          {!!selectedBatchIds.length && batchError && <p role="status">{batchError}</p>}
          {batchActions.error && <p role="alert">{batchActions.error}</p>}{batchActions.notice && <p role="status">{batchActions.notice}</p>}
        </section>}
        {selected?.mayStillComplete && (
          <p className="run-recovery-hint" role="alert">上游结果待核对，请勿直接重新生成。已停止本地等待，但付费请求可能仍在处理；可先刷新运行历史、检查服务端记录或联系模型来源核对。</p>
        )}
        {selected?.purpose === 'agent-plan' && <div className="run-recovery-hint"><p>这是 Canvas Agent 的文字规划记录。提案确认、继续和停止在原 Agent 会话中处理。</p>{props.onOpenAgent && <button type="button" onClick={props.onOpenAgent}>打开 Canvas Agent</button>}</div>}
        {selected && canvasRunWaitingKind(selected) && <div className="run-recovery-hint" role="status">
          <strong>{canvasRunWaitingLabel(selected)}</strong>
          <p>{canvasRunWaitingKind(selected) === 'video' ? '视频请求已提交，继续只核对原任务并执行它剩余的链路。' : '媒体素材需要在所属画布的浏览器中处理与保存，请保持画布打开；继续沿用这次运行。'}</p>
          <button type="button" disabled={resumeBusy || !props.onResumeRun || !canContinueCanvasRun(selected)} title={!props.onResumeRun ? '当前宿主尚未提供继续原任务能力' : !canContinueCanvasRun(selected) ? '任务已请求停止，不能继续' : '继续原任务，不新建运行'} onClick={() => void continueRun()}>{resumeBusy ? '正在核对原任务…' : '继续原任务'}</button>
        </div>}
        {resumeFeedback && <p className="run-recovery-hint" role="status">{resumeFeedback}</p>}
        {selected && !selected.mayStillComplete && (selected.status === 'cancelled' || selected.status === 'interrupted') && (
          <p className="run-recovery-hint">已停止本地等待；服务端生成任务可能仍在继续。对不确定的付费提交不要立即重复运行，可先续查或打开对应节点。</p>
        )}
        {selected && selected.events.length > 0 && (
          <section className="run-timeline" aria-label="运行时间线">
            <header><strong>运行时间线</strong><span>{selected.events.length} 个事件</span></header>
            <ol>
              {selected.events.slice(-24).map((event) => (
                <li key={`${event.sequence}-${event.type}`}>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                  {'nodeId' in event && selected.purpose !== 'agent-plan'
                    ? <button type="button" title="定位到画布节点" onClick={() => props.onLocateNode(event.nodeId)}>{eventLabel(event)}</button>
                    : <span>{eventLabel(event)}</span>}
                </li>
              ))}
            </ol>
          </section>
        )}
        {nodes.map((node) => {
          const attempt = node.attempts.at(-1)
          const batch = attempt?.imageBatch
          const videoBatch = attempt?.videoBatch
          const videoAttempts = videoBatch ? latestVideoBatchAttempts(node.attempts) : []
          const durationMs = videoBatch ? latestPaidAttemptDurationMs(node) ?? 0 : attempt?.durationMs ?? 0
          const outputText = [...node.attempts].reverse().find((entry) => entry.outputText)?.outputText
          const candidates = node.attempts.flatMap((entry) => entry.candidates)
          const totalQuota = node.attempts.reduce((total, entry) => total + (entry.costQuota ?? 0), 0)
          return (
            <section className="run-node-record" key={node.nodeId}>
              <div className="run-node-head">
                {selected.purpose === 'agent-plan' ? <strong>Agent 文字规划</strong> : <button type="button" title={`定位到画布节点：${node.nodeId}`} onClick={() => props.onLocateNode(node.nodeId)}>{builtinNodeRegistry.resolve(node.kind)?.title ?? '未识别节点'}</button>}
                <span>{['running', 'cancelling', 'queued'].includes(node.state) && node.latestStage
                  ? stageLabel[node.latestStage]
                  : statusLabel[node.state] ?? node.state}</span>
              </div>
              {node.errorMessage && <><p role="alert">{node.errorMessage}</p><small className="run-error-action">{videoBatch ? `已保存视频保留。${selected.mayStillComplete ? '先核对原任务是否已完成或扣费。' : ''}重新生成会提交整组最多 ${videoBatch.count} 个独立付费视频任务；核对或保存原任务不会重新提交。` : batch ? `已有图片保留。${selected.mayStillComplete ? '先核对上游是否已完成或扣费。' : ''}再次生成会重新提交整组最多 ${batch.count} 次付费请求，不会只补缺失图片。` : selected.mayStillComplete ? '先核对上游是否已完成或扣费，再决定是否重新提交。' : '可先检查分组、模型和素材归属；重试仍会经过运行预检和付费确认。'}</small>{props.onRetryNode && selected.purpose !== 'agent-plan' && !selected.mayStillComplete && node.state === 'failed' && selected.status !== 'running' && <div className="run-error-action"><button type="button" onClick={() => props.onRetryNode?.(node.nodeId, 'to-node')}>{videoBatch ? `重新生成整组（${videoBatch.count} 个视频任务）` : batch ? `重新生成整组（${batch.count} 次）` : '重试到此节点'}</button>{!batch && !videoBatch && <button type="button" onClick={() => props.onRetryNode?.(node.nodeId, 'from-node')}>从此向后重试</button>}</div>}</>}
              {attempt && (
                <div className="run-meta">
                  <span>{node.attempts.length} 次尝试</span>
                  {batch && <span>本组已完成 {node.attempts.filter((entry) => entry.imageBatch?.batchId === batch.batchId && ['succeeded', 'cached'].includes(entry.state)).length}/{batch.count} 次请求</span>}
                  {videoBatch && <span>本组视频任务：已完成 {videoAttempts.filter((entry) => ['succeeded', 'cached'].includes(entry.state)).length}/{videoBatch.count} · 已提交 {videoAttempts.filter((entry) => Boolean(entry.videoTaskId)).length}</span>}
                  <span>{attempt.cached ? '缓存命中' : `${(durationMs / 1000).toFixed(1)} 秒`}</span>
                  {totalQuota > 0 && <span>{totalQuota} quota</span>}
                </div>
              )}
              {outputText && <div className="run-text-result"><label>本次文字结果<textarea readOnly value={outputText.slice(0, 32_000)} aria-label="运行记录文字结果" /></label><small>输入已变化时，结果仅在此保留，不自动替换当前画布。</small></div>}
              {node.attempts.map((entry) => {
                const target = canvasVideoTaskTargetForAttempt(selected.runId, node.nodeId, entry, node.state)
                return target && VideoTaskRecovery ? <VideoTaskRecovery key={entry.attemptId} target={target} actions={videoTaskActions} onOpenAssets={props.onOpenAssets} currentAssetId={props.resultAssets[node.nodeId]?.kind === 'video' ? props.resultAssets[node.nodeId]?.assetId : undefined} onUseAsset={(asset) => {
                  if (!asset.lineage) return
                  props.onUseCandidate(node.nodeId, { candidateId: asset.lineage.candidateId, attemptId: entry.attemptId, createdAt: asset.createdAt,
                    asset: { kind: 'video', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, width: asset.width, height: asset.height, durationSeconds: asset.durationSeconds, taskId: asset.taskId } })
                }} /> : null
              })}
              {candidates.length ? (
                <div className="candidate-grid">
                  {candidates.map((candidate) => {
                    const batchItem = batchItems.find((item) => item.assetId === candidate.asset.assetId)
                    const firstOccurrence = batchItem?.nodeId === node.nodeId && batchItem.candidateId === candidate.candidateId && batchItem.attemptId === candidate.attemptId
                    const selectedCandidate = selection.ids.has(candidate.asset.assetId)
                    return (
                    <article
                      key={candidate.candidateId}
                      className={`${sameCanvasMediaAsset(props.resultAssets[node.nodeId], candidate.asset) ? 'is-adopted' : ''}${selectedCandidate ? ' is-batch-selected' : ''}`}
                      draggable={!!props.onAddMany && !!batchItem && !batchItem.unavailableReason && !batchActions.busy}
                      onDragStart={(event) => {
                        try {
                          if (batchActions.busy || !props.onAddMany) { event.preventDefault(); return }
                          const ids = assetBatchDragIds(batchItems, selection, candidate.asset.assetId)
                          event.dataTransfer.setData(assetBatchDragMime, JSON.stringify(ids))
                          if (ids.length === 1) event.dataTransfer.setData('application/x-xingmang-asset-id', ids[0])
                          event.dataTransfer.effectAllowed = 'copy'
                        } catch (cause) { event.preventDefault(); batchActions.reportError(cause instanceof Error ? cause.message : '无法拖入所选候选，请重新选择') }
                      }}
                    >
                      {batchEnabled && firstOccurrence && <label className="asset-batch-checkbox run-candidate-select" title={batchItem?.unavailableReason || '只选择素材，不改变当前产物'}><input type="checkbox" aria-label={`选择历史素材：${batchItem?.label}`} checked={selectedCandidate} disabled={!!batchActions.busy || props.loading || !!batchItem?.unavailableReason} onChange={() => setSelection((value) => assetSelectionForActivation(value, candidate.asset.assetId, availableBatchIds, { toggle: true }))} /><span>选择素材</span></label>}
                      {batchEnabled && !firstOccurrence && <small className="run-candidate-duplicate">同一素材已在上方列出，批量操作只处理一次</small>}
                      {candidate.asset.kind === 'image'
                        ? <button type="button" className="candidate-preview" title="单击设为产物，双击放大" onClick={() => props.onUseCandidate(node.nodeId, candidate)} onDoubleClick={() => props.onPreviewAsset(candidate.asset)}><SafeImage src={candidate.asset.localUrl} alt="生成候选" fallbackLabel="候选不可用" onContextMenu={(event) => { event.preventDefault(); props.onAssetMenu(candidate.asset.assetId) }} /></button>
                        : candidate.asset.kind === 'video' && isLocalCanvasAssetUrl(candidate.asset.localUrl)
                          ? <ViewportVideo className="candidate-video" src={candidate.asset.localUrl} controls title="双击放大预览" style={{ aspectRatio: mediaAssetAspectRatio(candidate.asset) }} onDoubleClick={(event) => { event.stopPropagation(); props.onPreviewAsset(candidate.asset) }} onContextMenu={(event) => { event.preventDefault(); props.onAssetMenu(candidate.asset.assetId) }} />
                          : candidate.asset.kind === 'audio' && isLocalCanvasAssetUrl(candidate.asset.localUrl)
                            ? <div className="candidate-audio" title="双击放大预览" onDoubleClick={() => props.onPreviewAsset(candidate.asset)} onContextMenu={(event) => { event.preventDefault(); props.onAssetMenu(candidate.asset.assetId) }}><Music2 size={18} aria-hidden="true" /><AudioPreview src={candidate.asset.localUrl} /></div>
                            : <div className="candidate-video media-unavailable">{candidate.asset.kind === 'audio' ? '音频候选不可用' : '视频候选不可用'}</div>}
                      <div>
                        {/* 历史里的每个候选都能重新成为产物：这正是「最新候选
                            自动覆盖」可以接受的前提——旧图一直在这里。 */}
                        <button
                          type="button"
                          title={sameCanvasMediaAsset(props.resultAssets[node.nodeId], candidate.asset) ? '这就是该节点当前的产物' : '设为该节点产物，下游会标记为待重新运行'}
                          disabled={sameCanvasMediaAsset(props.resultAssets[node.nodeId], candidate.asset)}
                          onClick={() => props.onUseCandidate(node.nodeId, candidate)}
                        ><Check size={12} />{sameCanvasMediaAsset(props.resultAssets[node.nodeId], candidate.asset) ? '当前产物' : '设为产物'}</button>
                        <button type="button" className="candidate-more" title="更多资产操作" aria-label="候选资产操作" onClick={() => props.onAssetMenu(candidate.asset.assetId)}><MoreHorizontal size={14} /></button>
                      </div>
                    </article>
                  )})}
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </aside>
  )
}
