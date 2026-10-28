import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Download, History, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { CanvasRunCandidate, CanvasRunRecord, CanvasRunSummaryPage, CanvasRunSummaryQuery } from '../host'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { SafeImage, ViewportVideo, AudioPreview } from './MediaPreview'
import { runCollectionItems, runCollectionReferenceKey, type RunCollectionItem, type RunCollectionReference, type RunCollectionVerified } from './run-result-collection'
import { runCollectionRuntimeKey, useRunCollectionVerification, useRunResultCollection, type RunCollectionAccess } from './use-run-result-collection'
import './run-result-collection.css'

export interface RunResultCollectionDialogProps extends RunCollectionAccess {
  initialRunId?: string
  onListHistory(query: Omit<CanvasRunSummaryQuery, 'projectId'>, signal: AbortSignal): Promise<CanvasRunSummaryPage>
  onPreviewAsset(asset: CanvasRunCandidate['asset']): void
  onClose(): void
}
const statusLabels: Record<string, string> = { running: '运行中', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
function when(value?: string): string { if (!value) return '时间待核对'; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : '时间待核对' }
function nodeLabel(item?: RunCollectionItem): string { return item ? builtinNodeRegistry.resolve(item.nodeKind)?.title ?? item.nodeKind : '待核对原候选' }
function previewAsset(entry: RunCollectionVerified): CanvasRunCandidate['asset'] | undefined {
  const asset = entry.asset
  if (!asset || entry.error) return
  return { kind: asset.mediaType, assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, ...('width' in asset ? { width: asset.width, height: asset.height } : {}), ...('durationSeconds' in asset ? { durationSeconds: asset.durationSeconds } : {}) }
}
export function RunCollectionMedia({ entry, onPreview, onError }: { entry?: RunCollectionVerified; onPreview(asset: CanvasRunCandidate['asset']): void; onError(): void }) {
  const asset = entry && previewAsset(entry)
  if (!asset) return <div className="run-collection-media is-empty" role="status">{entry?.error ?? '正在核对原运行与素材…'}</div>
  return <div className="run-collection-media">{asset.kind === 'image' ? <button type="button" aria-label="预览收集图片" onClick={() => onPreview(asset)}><SafeImage src={asset.localUrl} alt={entry?.asset?.displayName || entry?.asset?.fileName || '运行候选图片'} loading="lazy" onError={onError} /></button> : asset.kind === 'video' ? <ViewportVideo src={asset.localUrl} controls muted preload="metadata" onError={onError} /> : <AudioPreview src={asset.localUrl} preload="metadata" onError={onError} />}{asset.kind !== 'image' && <button type="button" className="run-collection-full-preview" onClick={() => onPreview(asset)}>打开完整预览</button>}</div>
}
function Source({ reference, item, onOpen }: { reference: RunCollectionReference; item?: RunCollectionItem; onOpen(): void }) {
  return <details className="run-collection-source"><summary>{nodeLabel(item)} · 候选 {item?.ordinal ?? '待核对'} · 查看确切来源</summary><dl><dt>运行</dt><dd>{reference.runId}</dd><dt>节点</dt><dd>{reference.nodeId}</dd><dt>尝试</dt><dd>{reference.attemptId}</dd><dt>候选</dt><dd>{reference.candidateId}</dd></dl><button type="button" onClick={onOpen}><History size={12} />返回原运行</button></details>
}

export function RunResultCollectionDialog(props: RunResultCollectionDialogProps) {
  const key = runCollectionRuntimeKey(props), latest = useRef({ key, props }); latest.current = { key, props }
  const collection = useRunResultCollection(props)
  const dialog = useRef<HTMLElement>(null)
  const [query, setQuery] = useState(''), [cursor, setCursor] = useState<string | null>(null), [back, setBack] = useState<(string | null)[]>([]), [revision, setRevision] = useState(0)
  const [history, setHistory] = useState<{ key: string; page?: CanvasRunSummaryPage; error?: string; loading: boolean }>({ key, loading: true })
  const [selected, setSelected] = useState({ key, runId: props.initialRunId ?? '' })
  const [detail, setDetail] = useState<{ key: string; runId: string; record?: CanvasRunRecord; error?: string; loading: boolean }>({ key, runId: '', loading: false })
  const [detailRevision, setDetailRevision] = useState(0), [media, setMedia] = useState<'all' | 'image' | 'video' | 'audio'>('all'), [pageIndex, setPageIndex] = useState(0)
  const [feedback, setFeedback] = useState({ key, value: '' }), [failedPreviews, setFailedPreviews] = useState<{ key: string; ids: Set<string> }>({ key, ids: new Set() })
  const runId = selected.key === key ? selected.runId : props.initialRunId ?? ''
  const requestKey = JSON.stringify([key, query, cursor, revision])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { setQuery(''); setCursor(null); setBack([]); setSelected({ key, runId: props.initialRunId ?? '' }); setMedia('all'); setPageIndex(0); setFeedback({ key, value: '' }); setFailedPreviews({ key, ids: new Set() }) }, [key])
  useEffect(() => {
    const controller = new AbortController()
    setHistory({ key: requestKey, loading: true })
    const timer = setTimeout(() => { void latest.current.props.onListHistory({ q: query.trim(), ...(cursor ? { cursor } : {}), limit: 25 }, controller.signal).then((page) => {
      if (controller.signal.aborted || latest.current.key !== key) return
      if (page.items.some((item) => item.projectId !== props.scope.projectId) || page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) throw new Error('历史分页身份或游标无法核对，请刷新列表')
      setHistory({ key: requestKey, page, loading: false })
      setSelected((value) => value.key === key && value.runId ? value : { key, runId: props.initialRunId || page.items[0]?.runId || '' })
    }).catch((cause) => { if (!controller.signal.aborted && latest.current.key === key) setHistory({ key: requestKey, error: cause instanceof Error ? cause.message : '历史列表读取失败', loading: false }) }) }, query ? 300 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [requestKey])
  useEffect(() => {
    const controller = new AbortController()
    setDetail({ key, runId, loading: Boolean(runId) })
    if (runId) void props.onReadRun(runId, controller.signal).then((record) => {
      if (controller.signal.aborted || latest.current.key !== key) return
      if (record.runId !== runId) throw new Error('原运行身份无法核对')
      runCollectionItems(record, props.scope.projectId)
      setDetail({ key, runId, record, loading: false })
    }).catch((cause) => { if (!controller.signal.aborted && latest.current.key === key) setDetail({ key, runId, error: cause instanceof Error ? cause.message : '运行详情未能读取', loading: false }) })
    return () => controller.abort()
  }, [key, runId, detailRevision])
  const visibleDetail = detail.key === key && detail.runId === runId ? detail : undefined
  const record = visibleDetail?.record
  const items = record ? runCollectionItems(record, props.scope.projectId) : []
  const filtered = items.filter((item) => media === 'all' || item.candidate.asset.kind === media)
  const visible = filtered.slice(pageIndex * 24, (pageIndex + 1) * 24)
  const refs = [...new Map(visible.filter((item) => !item.error).map((item) => [item.reference.assetId, item.reference])).values()]
  const previewKey = JSON.stringify([key, props.scope.projectId, runId, detailRevision, pageIndex, media])
  const previews = useRunCollectionVerification(refs, previewKey, { onReadRun: async (id) => { if (!record || id !== record.runId) throw new Error('运行范围已变化'); return record }, onReadAsset: props.onReadAsset })
  const previewByAsset = new Map(previews.entries.map((entry) => [entry.reference.assetId, entry]))
  const basketByKey = new Map(collection.verification.entries.map((entry) => [runCollectionReferenceKey(entry.reference), entry]))
  const collectedIds = new Set(collection.references.map((reference) => reference.assetId)), busy = Boolean(collection.action.phase) || collection.saving || Boolean(collection.conflict)
  const unavailableCount = collection.references.filter((reference) => basketByKey.get(runCollectionReferenceKey(reference))?.error || failedPreviews.key === key && failedPreviews.ids.has(reference.assetId)).length
  const basketUnchecked = collection.verification.loading || collection.verification.entries.length !== collection.references.length
  const page = history.key === requestKey ? history.page : undefined, loading = history.key !== requestKey || history.loading
  function selectRun(id: string) { setSelected({ key, runId: id }); setPageIndex(0); setMedia('all'); setFeedback({ key, value: '' }) }
  function reportPreviewFailure(assetId: string) { if (latest.current.key !== key) return; setFailedPreviews((current) => ({ key, ids: new Set([...(current.key === key ? current.ids : []), assetId]) })) }
  function close() { collection.cancelCheck(); props.onClose() }
  function collectAll() {
    if (busy || !record) return
    if (items.some((item) => item.error)) { setFeedback({ key, value: '本次运行含未保存或身份不完整的候选，未整批加入；请逐项选择可用结果。' }); return }
    collection.add(items.map((item) => item.reference))
  }
  function retry() { setFailedPreviews({ key, ids: new Set() }); previews.refresh(); collection.verification.refresh(); setDetailRevision((value) => value + 1) }
  if (typeof document === 'undefined') return null
  return createPortal(<div className="run-collection-backdrop" onPointerDown={(event) => event.stopPropagation()}><section ref={dialog} tabIndex={-1} className="run-collection-dialog" role="dialog" aria-modal="true" aria-label="跨运行结果收集" onKeyDown={(event) => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter((item) => {
      if (!item.getClientRects().length) return false
      for (let ancestor = item.parentElement; ancestor && ancestor !== event.currentTarget; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open') && ancestor.querySelector('summary') !== item) return false
      }
      return true
    })
    if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === dialog.current)) { event.preventDefault(); controls.at(-1)?.focus() }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
  }}>
    <header className="run-collection-header"><div><strong>跨运行结果收集</strong><p>当前本人项目 · 收集图片、视频和音频 · 不改变原候选，不运行模型</p></div><button type="button" aria-label="关闭结果收集" onClick={close}><X size={20} /></button></header>
    <div className="run-collection-layout"><section className="run-collection-browser" aria-label="浏览项目运行历史">
      <div className="run-collection-search"><label><Search size={15} /><input aria-label="搜索运行编号或工程名称" value={query} maxLength={120} placeholder="搜索运行编号或工程名称" onChange={(event) => { setQuery(event.target.value); setCursor(null); setBack([]) }} /></label><button type="button" aria-label="刷新历史列表" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} /></button></div>
      <div className="run-collection-history" aria-label="运行历史分页">{loading ? <p role="status">正在读取运行摘要…</p> : history.error ? <p role="alert">{history.error}</p> : page?.items.length ? <><label>选择运行<select aria-label="选择收集来源运行" value={page.items.some((item) => item.runId === runId) ? runId : ''} onChange={(event) => selectRun(event.target.value)}><option value="" disabled>当前来源不在这一页</option>{page.items.map((item) => <option key={item.runId} value={item.runId}>{when(item.createdAt)} · {statusLabels[item.status] ?? item.status} · {item.runId.slice(-8)}</option>)}</select></label><div><button type="button" aria-label="上一页运行历史" disabled={!back.length} onClick={() => { setCursor(back.at(-1) ?? null); setBack(back.slice(0, -1)) }}><ChevronLeft size={14} />上一页</button><span>第 {back.length + 1} 页 · {page.items.length} 条</span><button type="button" aria-label="下一页运行历史" disabled={!page.hasMore} onClick={() => { setBack([...back, cursor]); setCursor(page.nextCursor) }}>下一页<ChevronRight size={14} /></button></div></> : <p>当前查询没有运行记录</p>}</div>
      <div className="run-collection-toolbar"><select aria-label="筛选候选媒体类型" value={media} onChange={(event) => { setMedia(event.target.value as typeof media); setPageIndex(0) }}><option value="all">全部媒体</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select><button type="button" disabled={busy || !items.length} title="将本次全部候选来源加入收集篮，再核对原文件；超过50项会整批拒绝" onClick={collectAll}><Plus size={14} />收集本次全部候选</button><button type="button" onClick={retry} disabled={busy}>重新核对素材</button></div>
      {feedback.key === key && feedback.value && <p className="run-collection-alert" role="alert">{feedback.value}</p>}
      <div className="run-collection-candidates">{visibleDetail?.loading ? <p role="status">正在按需读取原运行候选…</p> : visibleDetail?.error ? <p className="run-collection-alert" role="alert">{visibleDetail.error}<button type="button" onClick={retry}>重试原运行</button></p> : !runId ? <p>选择一条运行查看候选</p> : !filtered.length ? <p>这次运行没有{media === 'all' ? '媒体' : media === 'image' ? '图片' : media === 'video' ? '视频' : '音频'}候选</p> : visible.map((item) => {
        const entry = previewByAsset.get(item.reference.assetId), failed = failedPreviews.key === key && failedPreviews.ids.has(item.reference.assetId), error = item.error || entry?.error || (failed ? '预览文件读取失败，请重新核对或移除' : undefined)
        return <article key={runCollectionReferenceKey(item.reference)}><RunCollectionMedia key={`${item.reference.assetId}:${detailRevision}`} entry={item.error ? { reference: item.reference, error: item.error } : entry} onPreview={props.onPreviewAsset} onError={() => reportPreviewFailure(item.reference.assetId)} /><div className="run-collection-card-body"><strong>{nodeLabel(item)} · 候选 {item.ordinal}</strong><small>{when(item.createdAt)} · {item.candidate.asset.kind === 'image' ? '图片' : item.candidate.asset.kind === 'video' ? '视频' : '音频'}</small><Source reference={item.reference} item={item} onOpen={() => selectRun(item.reference.runId)} />{error && <p role="alert">{error}</p>}<button type="button" disabled={busy || collection.corrupt || Boolean(error) || !entry?.asset || collectedIds.has(item.reference.assetId)} onClick={() => collection.add([item.reference])}>{collectedIds.has(item.reference.assetId) ? <Check size={14} /> : <Plus size={14} />}{collectedIds.has(item.reference.assetId) ? '已在收集篮' : '加入收集篮'}</button></div></article>
      })}</div>
      {filtered.length > 24 && <footer className="run-collection-candidate-pages"><button type="button" disabled={pageIndex === 0} onClick={() => setPageIndex((value) => value - 1)}>上一页候选</button><span>{pageIndex * 24 + 1}–{Math.min((pageIndex + 1) * 24, filtered.length)} / {filtered.length}</span><button type="button" disabled={(pageIndex + 1) * 24 >= filtered.length} onClick={() => setPageIndex((value) => value + 1)}>下一页候选</button></footer>}
    </section><section className="run-collection-basket" aria-label="有序结果收集篮"><header><div><strong>收集篮 {collection.references.length} / 50</strong><small>按加入顺序 · 跨运行去重，保留首次来源</small></div><button type="button" disabled={busy || !collection.references.length && !collection.corrupt} onClick={collection.clear}><Trash2 size={14} />{collection.corrupt ? collection.temporary ? '在本页重新收集' : '明确清空损坏存档' : '清空'}</button></header>
      {collection.storageError && <p className="run-collection-alert" role="alert">{collection.storageError}{!collection.temporary && <button type="button" disabled={busy} onClick={collection.reload}>{collection.corrupt ? '重试读取存档' : '重试保存收集篮'}</button>}</p>}
      {collection.saving && <p role="status">正在保存收集篮…</p>}
      {collection.conflict && <div className="run-collection-alert" role="alert"><strong>其他页面已更新收集篮</strong><p>{collection.conflict.corrupt ? '最新收集篮暂时无法读取。' : `最新收集篮 ${collection.conflict.latestCount} 项。`}本页的{collection.conflict.changes || '修改'}尚未保存，未覆盖其他页面。</p>{collection.conflict.clearsLatest && <p>重试清空会移除最新收集篮中的全部项目。</p>}{collection.conflict.corrupt && <p>最新存档无法读取；采用最新状态后可明确处理损坏存档。</p>}<button type="button" disabled={collection.saving || Boolean(collection.action.phase)} onClick={collection.adoptLatest}>采用最新收集篮</button><button type="button" disabled={collection.saving || Boolean(collection.action.phase) || collection.conflict.corrupt || collection.temporary} onClick={collection.retryChanges}>{collection.conflict.clearsLatest ? '确认按最新内容重试清空' : '按最新内容重试本页修改'}</button></div>}
      <ol>{!collection.references.length && <li className="run-collection-empty">{collection.temporary ? '当前为临时收集篮，关闭或刷新会丢失本页修改。' : '从不同运行加入结果，关闭或刷新后仍可继续。'}执行前会重新核对每个原候选与本人素材。</li>}{collection.references.map((reference, index) => {
        const entry = basketByKey.get(runCollectionReferenceKey(reference)), failed = failedPreviews.key === key && failedPreviews.ids.has(reference.assetId)
        return <li key={reference.assetId}><div className="run-collection-basket-title"><b>{index + 1}</b><strong>{entry?.asset?.displayName || entry?.asset?.fileName || '原素材待核对'}</strong><button type="button" aria-label={`移除收集素材 ${index + 1}`} disabled={busy} onClick={() => collection.remove(reference.assetId)}><X size={14} /></button></div><RunCollectionMedia key={`${reference.assetId}:${detailRevision}`} entry={entry} onPreview={props.onPreviewAsset} onError={() => reportPreviewFailure(reference.assetId)} /><Source reference={reference} item={entry?.item} onOpen={() => selectRun(reference.runId)} />{(entry?.error || failed) && <p className="run-collection-alert" role="alert">{entry?.error || '预览文件读取失败，请重新核对'}</p>}<div className="run-collection-order"><button type="button" aria-label={`前移收集素材 ${index + 1}`} disabled={busy || index === 0} onClick={() => collection.move(reference.assetId, -1)}><ArrowUp size={13} />前移</button><button type="button" aria-label={`后移收集素材 ${index + 1}`} disabled={busy || index === collection.references.length - 1} onClick={() => collection.move(reference.assetId, 1)}><ArrowDown size={13} />后移</button></div></li>
      })}</ol>
      <footer>{Boolean(unavailableCount) && <p className="run-collection-alert" role="alert">{unavailableCount} 项素材暂不可用，请重新核对或移除后再整批提交。<button type="button" disabled={busy} onClick={retry}>重新核对收集篮</button></p>}{basketUnchecked && collection.references.length > 0 && <p role="status">正在核对收集篮来源与素材…</p>}{collection.action.error && <p className="run-collection-alert" role="alert">{collection.action.error}</p>}{collection.action.notice && <p role="status">{collection.action.notice}</p>}{collection.action.phase?.startsWith('checking') && <p role="status">正在重新核对整篮原运行与素材…<button type="button" onClick={collection.cancelCheck}>停止只读核对</button></p>}{collection.action.phase?.startsWith('accepted') && <p role="status">宿主已接受操作，请等待结果；关闭不会取消。</p>}<div>{props.onAddMany && <button type="button" className="is-primary" disabled={busy || basketUnchecked || Boolean(unavailableCount) || !collection.references.length || collection.corrupt} onClick={() => void collection.run('add')}><Plus size={15} />按顺序加入画布</button>}{props.onDownloadMany && <button type="button" disabled={busy || basketUnchecked || Boolean(unavailableCount) || !collection.references.length || collection.corrupt} onClick={() => void collection.run('download')}><Download size={15} />打包下载</button>}</div><small>{collection.temporary ? '当前修改仅临时保留在本页，关闭或刷新会丢失。' : '仅此浏览器按账号与工程保存；多页冲突需确认，不是云同步。'}</small><small>{props.onAddMany ? '加入创建独立节点，可一次撤销；原运行和当前采用的候选保持原样。' : '当前为只读浏览，可收集并下载本人可用结果。'}</small></footer>
    </section></div>
  </section></div>, document.body)
}
