import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Clock3, Film, LoaderCircle, Pause, Play, Plus, RefreshCw, SkipBack, SkipForward, X } from 'lucide-react'
import type { CanvasVideoAssetSummary } from '../host'
import { extractBrowserVideoFrame, type BrowserFrameResult } from '../library/browser-frame'
import { frameEditorComposing, frameEditorLastTimestamp, frameEditorMetadata, frameEditorSeconds, frameEditorSelectionMatches, frameEditorTimecode, moveFrameEditorTimestamp, parseFrameEditorTimestamp, validateFrameEditorBlob, type FrameEditorMetadata, type FrameEditorSelection } from './frame-editor-state'
import { evenlySpacedFrameSequence, validateFrameSequenceTimestamps } from './frame-sequence'
import './video-frame-editor.css'

export interface VideoFrameEditorProps {
  asset: CanvasVideoAssetSummary
  initialTimestampSeconds: number
  loadVideo(assetId: string, signal: AbortSignal): Promise<Blob>
  onApply(timestampSeconds: number, signal: AbortSignal): Promise<void>
  onApplySequence?(timestamps: number[], metadata: FrameEditorMetadata, signal: AbortSignal): Promise<void>
  onClose(): void
  title?: string
}
interface Source { assetId: string; blob: Blob; url: string }
interface Preview extends FrameEditorSelection { url: string; result: BrowserFrameResult }

export function VideoFrameEditor({ asset, initialTimestampSeconds, loadVideo, onApply, onApplySequence, onClose, title }: VideoFrameEditorProps) {
  const [source, setSource] = useState<Source | null>(null), sourceRef = useRef<Source | null>(null)
  const [metadata, setMetadata] = useState<FrameEditorMetadata | null>(null), metadataRef = useRef<FrameEditorMetadata | null>(null)
  const [timestamp, setTimestamp] = useState(String(initialTimestampSeconds)), timestampRef = useRef(String(initialTimestampSeconds))
  const [preview, setPreview] = useState<Preview | null>(null), previewRef = useRef<Preview | null>(null)
  const [loading, setLoading] = useState(true), [decoding, setDecoding] = useState(false), [saving, setSaving] = useState(false), [playing, setPlaying] = useState(false), playingRef = useRef(false)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [timestamps, setTimestamps] = useState<number[]>([]), timestampsRef = useRef<number[]>([])
  const [sampleCount, setSampleCount] = useState('4'), [sampleStart, setSampleStart] = useState('0'), [sampleEnd, setSampleEnd] = useState('')
  const [queueNotice, setQueueNotice] = useState(''), sequenceMode = Boolean(onApplySequence)
  const draftSource = useRef<{ assetId: string; sequenceMode: boolean } | null>(null), sequenceInitialized = useRef(false)
  const video = useRef<HTMLVideoElement>(null), panel = useRef<HTMLElement>(null), alive = useRef(true), sourceId = useRef(asset.assetId)
  const readController = useRef<AbortController | null>(null), decodeController = useRef<AbortController | null>(null), applyController = useRef<AbortController | null>(null)
  const decodeTimer = useRef<ReturnType<typeof setTimeout> | null>(null), metadataTimer = useRef<ReturnType<typeof setTimeout> | null>(null), sequence = useRef(0), composing = useRef(false)
  const callbacks = useRef({ loadVideo, onApply, onApplySequence, onClose }); callbacks.current = { loadVideo, onApply, onApplySequence, onClose }; sourceId.current = asset.assetId
  const parsed = parseFrameEditorTimestamp(timestamp, metadata)
  const selected: FrameEditorSelection | null = parsed.value !== null ? { sourceAssetId: asset.assetId, timestampSeconds: parsed.value } : null
  const confirmed = frameEditorSelectionMatches(preview, selected) && !playing && !decoding && !loading && !error
  let queueError = '', sampleError = '', sampleValues: number[] = []
  if (sequenceMode && metadata) {
    try { validateFrameSequenceTimestamps(timestamps, metadata.duration) } catch (cause) { queueError = cause instanceof Error ? cause.message : '请检查分镜时间点' }
    try {
      const start = parseFrameEditorTimestamp(sampleStart, metadata), end = parseFrameEditorTimestamp(sampleEnd, metadata)
      if (start.value === null) throw new Error(`起始时间：${start.error}`)
      if (end.value === null) throw new Error(`结束时间：${end.error}`)
      if (!/^\d+$/.test(sampleCount.trim())) throw new Error('请输入 2 到 16 之间的整数帧数')
      sampleValues = evenlySpacedFrameSequence(Number(sampleCount), start.value, end.value, metadata.duration)
    } catch (cause) { sampleError = cause instanceof Error ? cause.message : '请检查等距取样范围' }
  }
  const canApply = sequenceMode ? Boolean(metadata && source?.assetId === asset.assetId && !loading && !queueError) : confirmed

  function replaceTimestamps(values: number[], notice = '') {
    timestampsRef.current = values; setTimestamps(values); setQueueNotice(notice)
  }
  function addCurrentFrame() {
    if (!alive.current || applyController.current || !confirmed || !previewRef.current || !metadataRef.current || timestampsRef.current.length >= 16) return
    const seconds = parseFrameEditorTimestamp(timestampRef.current, metadataRef.current).value
    if (seconds === null || !frameEditorSelectionMatches(previewRef.current, { sourceAssetId: sourceId.current, timestampSeconds: seconds })) return
    if (timestampsRef.current.includes(seconds)) { setQueueNotice('这个时间点已在分镜列表中'); return }
    replaceTimestamps([...timestampsRef.current, seconds].sort((left, right) => left - right), `已加入 ${frameEditorTimecode(seconds)}，按时间先后排列`)
  }
  function removeTimestamp(seconds: number) {
    if (!alive.current || applyController.current) return
    replaceTimestamps(timestampsRef.current.filter((value) => value !== seconds), `已移除 ${frameEditorTimecode(seconds)}`)
  }
  function sampleFrames() {
    if (!alive.current || applyController.current || !metadataRef.current || !sampleValues.length) return
    replaceTimestamps(validateFrameSequenceTimestamps(sampleValues, metadataRef.current.duration), `已填入 ${sampleValues.length} 个等距时间点`)
  }

  function clearPreview() {
    const previous = previewRef.current; previewRef.current = null; setPreview(null)
    if (previous) URL.revokeObjectURL(previous.url)
  }
  function stopDecode() {
    sequence.current++
    if (decodeTimer.current !== null) clearTimeout(decodeTimer.current)
    decodeTimer.current = null; decodeController.current?.abort(); decodeController.current = null; setDecoding(false)
  }
  function pause() { playingRef.current = false; setPlaying(false); video.current?.pause() }
  function stop() {
    readController.current?.abort(); decodeController.current?.abort(); applyController.current?.abort()
    if (decodeTimer.current !== null) clearTimeout(decodeTimer.current)
    if (metadataTimer.current !== null) clearTimeout(metadataTimer.current)
    sequence.current++; pause()
  }
  function close() { alive.current = false; stop(); callbacks.current.onClose() }
  function fail(cause: unknown, fallback = '视频画面无法读取，请重新定位或重试') { setError(cause instanceof Error ? cause.message : fallback) }
  function requestPreview(seconds: number, delay = 180) {
    stopDecode(); clearPreview()
    const current = sourceRef.current, dimensions = metadataRef.current
    if (!current || !dimensions || current.assetId !== sourceId.current || seconds < 0 || seconds >= dimensions.duration) return
    const ticket = sequence.current, controller = new AbortController(); decodeController.current = controller; setDecoding(true)
    decodeTimer.current = setTimeout(() => {
      decodeTimer.current = null
      void extractBrowserVideoFrame(current.blob, { timestampSeconds: seconds, signal: controller.signal, timeoutMs: 20_000, maxEdge: 4096 }).then((result) => {
        if (!alive.current || controller.signal.aborted || ticket !== sequence.current || sourceId.current !== current.assetId || parseFrameEditorTimestamp(timestampRef.current, metadataRef.current).value !== seconds) return
        const url = URL.createObjectURL(result.blob), next: Preview = { sourceAssetId: current.assetId, timestampSeconds: seconds, url, result }
        previewRef.current = next; setPreview(next); setError('')
      }, (cause) => { if (alive.current && !controller.signal.aborted && ticket === sequence.current && sourceId.current === current.assetId) fail(cause) })
        .finally(() => { if (alive.current && ticket === sequence.current && decodeController.current === controller) { decodeController.current = null; setDecoding(false) } })
    }, delay)
  }
  function choose(raw: string) {
    if (applyController.current) return
    pause(); timestampRef.current = raw; setTimestamp(raw); setError(''); stopDecode(); clearPreview()
    const next = parseFrameEditorTimestamp(raw, metadataRef.current)
    if (next.value === null || composing.current) return
    try { if (video.current) video.current.currentTime = next.value; requestPreview(next.value) }
    catch { setError('浏览器无法定位此时间点，请重试或重新选择视频') }
  }
  function step(delta: number) {
    if (!metadataRef.current) return
    const current = parseFrameEditorTimestamp(timestampRef.current, metadataRef.current).value ?? 0
    choose(frameEditorSeconds(moveFrameEditorTimestamp(current, delta, metadataRef.current)))
  }
  function currentPosition() {
    if (!metadataRef.current || !video.current) return
    choose(frameEditorSeconds(Math.min(video.current.currentTime, frameEditorLastTimestamp(metadataRef.current.duration))))
  }
  async function togglePlayback() {
    if (applyController.current || !metadataRef.current || !video.current) return
    if (playingRef.current) { currentPosition(); return }
    setError(''); stopDecode(); clearPreview(); playingRef.current = true; setPlaying(true)
    const current = video.current, activeId = sourceId.current
    try { await current.play() }
    catch (cause) { if (alive.current && sourceId.current === activeId) { pause(); fail(cause, '视频无法播放，请拖动时间轴选择画面') } }
  }
  function loaded(element: HTMLVideoElement) {
    if (!alive.current || element !== video.current || sourceRef.current?.assetId !== sourceId.current || readController.current?.signal.aborted) return
    if (metadataTimer.current !== null) clearTimeout(metadataTimer.current)
    metadataTimer.current = null
    try {
      const next = frameEditorMetadata(element.duration, element.videoWidth, element.videoHeight)
      metadataRef.current = next; setMetadata(next); setLoading(false); setError('')
      if (callbacks.current.onApplySequence && !sequenceInitialized.current) {
        sequenceInitialized.current = true
        const last = frameEditorLastTimestamp(next.duration)
        setSampleEnd(frameEditorSeconds(last))
        try { replaceTimestamps(evenlySpacedFrameSequence(4, 0, last, next.duration), '已准备 4 个等距时间点，可预览或调整') }
        catch (cause) { setQueueNotice(cause instanceof Error ? cause.message : '视频过短，请手动选择不同时间点') }
      }
      const current = parseFrameEditorTimestamp(timestampRef.current, next)
      if (current.value !== null) { element.currentTime = current.value; requestPreview(current.value, 0) }
    } catch (cause) { setLoading(false); fail(cause) }
  }
  function videoError(element: HTMLVideoElement) {
    if (!alive.current || element !== video.current || sourceRef.current?.assetId !== sourceId.current) return
    if (metadataTimer.current !== null) clearTimeout(metadataTimer.current)
    metadataTimer.current = null; readController.current?.abort(); metadataRef.current = null; setMetadata(null)
    pause(); stopDecode(); clearPreview(); setLoading(false); setError('视频无法解码，请确认素材为可播放的 MP4 文件')
  }
  async function apply() {
    if (callbacks.current.onApplySequence) {
      if (!alive.current || applyController.current || composing.current || !metadataRef.current || sourceRef.current?.assetId !== sourceId.current) return
      const activeId = sourceId.current, dimensions = { ...metadataRef.current }
      let values: number[]
      try { values = validateFrameSequenceTimestamps(timestampsRef.current, dimensions.duration) }
      catch (cause) { fail(cause, '请检查分镜时间点'); return }
      pause(); stopDecode()
      const controller = new AbortController(); applyController.current = controller; setSaving(true); setError('')
      try {
        await callbacks.current.onApplySequence(values, dimensions, controller.signal)
        if (alive.current && !controller.signal.aborted && sourceId.current === activeId && applyController.current === controller) callbacks.current.onClose()
      } catch (cause) { if (alive.current && !controller.signal.aborted && sourceId.current === activeId) fail(cause, '分镜节点未创建，请重试') }
      finally { if (applyController.current === controller) { applyController.current = null; if (alive.current) setSaving(false) } }
      return
    }
    if (applyController.current || composing.current || playingRef.current || decodeController.current) return
    const seconds = parseFrameEditorTimestamp(timestampRef.current, metadataRef.current).value
    const activeId = sourceId.current, current = seconds === null ? null : { sourceAssetId: activeId, timestampSeconds: seconds }
    if (!current || !frameEditorSelectionMatches(previewRef.current, current)) return
    const controller = new AbortController(); applyController.current = controller; setSaving(true); setError('')
    try {
      await callbacks.current.onApply(current.timestampSeconds, controller.signal)
      if (alive.current && !controller.signal.aborted && sourceId.current === activeId && applyController.current === controller) callbacks.current.onClose()
    } catch (cause) { if (alive.current && !controller.signal.aborted && sourceId.current === activeId) fail(cause, '时间点未保存，请重试') }
    finally { if (applyController.current === controller) { applyController.current = null; if (alive.current) setSaving(false) } }
  }
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    return () => { alive.current = false; stop(); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController(), id = asset.assetId
    // Retrying the same owned video must not discard the user's selected
    // timepoints. Changed metadata is revalidated without clamping the draft.
    const keepSequenceDraft = sequenceMode && draftSource.current?.assetId === id && draftSource.current.sequenceMode === sequenceMode
    draftSource.current = { assetId: id, sequenceMode }
    readController.current = controller; sourceRef.current = null; metadataRef.current = null; applyController.current = null
    setSource(null); setMetadata(null); setLoading(true); setError(''); setSaving(false); stopDecode(); clearPreview(); pause()
    if (!keepSequenceDraft) {
      sequenceInitialized.current = false
      replaceTimestamps([]); setSampleCount('4'); setSampleStart('0'); setSampleEnd('')
      timestampRef.current = String(initialTimestampSeconds); setTimestamp(timestampRef.current)
    }
    let url: string | null = null
    metadataTimer.current = setTimeout(() => {
      if (alive.current && sourceId.current === id && !controller.signal.aborted) { controller.abort(); setLoading(false); setError('读取视频超时，请重试；节点时间点没有改变') }
    }, 20_000)
    void Promise.resolve().then(() => {
      if (!alive.current || controller.signal.aborted || sourceId.current !== id) return null
      return callbacks.current.loadVideo(id, controller.signal)
    }).then((blob) => {
      if (!alive.current || controller.signal.aborted || sourceId.current !== id) return
      if (!blob) return
      validateFrameEditorBlob(blob); url = URL.createObjectURL(blob)
      const next = { assetId: id, blob, url }; sourceRef.current = next; setSource(next)
    }).catch((cause) => {
      if (alive.current && !controller.signal.aborted && sourceId.current === id) { if (metadataTimer.current !== null) clearTimeout(metadataTimer.current); metadataTimer.current = null; setLoading(false); fail(cause, '视频素材无法读取，请恢复或重新选择素材') }
    })
    return () => {
      controller.abort(); decodeController.current?.abort(); applyController.current?.abort(); sequence.current++
      if (metadataTimer.current !== null) clearTimeout(metadataTimer.current)
      if (decodeTimer.current !== null) clearTimeout(decodeTimer.current)
      if (url) URL.revokeObjectURL(url)
      if (previewRef.current) { URL.revokeObjectURL(previewRef.current.url); previewRef.current = null }
      if (video.current) { video.current.pause(); video.current.removeAttribute('src'); video.current.load() }
    }
  }, [asset.assetId, retry, sequenceMode])
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation()
    if (composing.current || frameEditorComposing(event.nativeEvent)) return
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    const editing = event.target instanceof HTMLElement && !!event.target.closest('input,textarea,select,[contenteditable=true]')
    if (event.key === 'Tab') {
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length)
      if (controls.length && event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel.current)) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (controls.length && !event.shiftKey && (document.activeElement === controls.at(-1) || document.activeElement === panel.current)) { event.preventDefault(); controls[0]?.focus() }
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void apply(); return }
    if (event.metaKey || event.ctrlKey || event.altKey || editing || event.target instanceof HTMLElement && !!event.target.closest('button')) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step((event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : .1)) }
    if (event.key === ' ') { event.preventDefault(); void togglePlayback() }
  }
  return createPortal(<div className="frame-editor-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <section className={`frame-editor${sequenceMode ? ' frame-editor-sequence' : ''}`} role="dialog" aria-modal="true" aria-label={sequenceMode ? '视频分镜编辑器' : '视频选帧编辑器'} tabIndex={-1} ref={panel} onKeyDown={keyDown}>
      <header className="frame-editor-header"><div><span><Film size={17} />{sequenceMode ? '视频分镜' : '视频抽帧'}</span><h2>{title ?? (sequenceMode ? '创建视频分镜' : '选择视频画面')}</h2><p title={asset.displayName || asset.fileName}>{asset.displayName || asset.fileName}</p></div><button type="button" aria-label={sequenceMode ? '关闭视频分镜编辑器' : '关闭视频选帧编辑器'} onClick={close}><X size={20} /></button></header>
      <p className="frame-editor-intro">{sequenceMode ? '按时间先后准备 2–16 个分镜，点击时间点预览。创建后会添加抽帧节点和有序拼图，运行链路后保存图片；这里仅准备节点，不调用模型。' : '播放或拖动时间轴选择画面，核对右侧静帧后应用时间点。应用不会运行模型或保存图片。'}</p>
      <div className="frame-editor-workspace">
        <div className="frame-editor-source"><div className="frame-editor-pane-title">原视频<span>{metadata ? `${metadata.width} × ${metadata.height}` : '读取原始尺寸'}</span></div><div className="frame-editor-video-stage" tabIndex={0} aria-label="视频定位预览">
          {source?.assetId === asset.assetId && <video key={source.url} ref={video} src={source.url} muted playsInline preload="auto" aria-label="选帧原视频" onLoadedMetadata={(event) => loaded(event.currentTarget)} onError={(event) => videoError(event.currentTarget)} onPause={(event) => { if (playingRef.current) { playingRef.current = false; setPlaying(false); if (metadataRef.current) choose(frameEditorSeconds(Math.min(event.currentTarget.currentTime, frameEditorLastTimestamp(metadataRef.current.duration)))) } }} onTimeUpdate={(event) => { if (!playingRef.current || !metadataRef.current) return; const raw = frameEditorSeconds(Math.min(event.currentTarget.currentTime, frameEditorLastTimestamp(metadataRef.current.duration))); timestampRef.current = raw; setTimestamp(raw) }} onEnded={currentPosition} />}
          {loading && <div className="frame-editor-placeholder" role="status"><LoaderCircle size={22} className="is-spinning" /><span>正在读取视频…</span></div>}
          {!source && !loading && <div className="frame-editor-placeholder"><Film size={30} /><span>视频暂不可用</span></div>}
        </div><div className="frame-editor-playback"><button type="button" aria-label={playing ? '暂停并选择当前画面' : '播放视频'} disabled={!metadata || loading || saving} onClick={() => void togglePlayback()}>{playing ? <Pause size={17} /> : <Play size={17} />}{playing ? '暂停选帧' : '播放'}</button><span>{frameEditorTimecode(parsed.value ?? 0)} <small>/ {frameEditorTimecode(metadata?.duration ?? 0)}</small></span></div></div>
        <div className="frame-editor-result"><div className="frame-editor-pane-title">待提取画面<span>{confirmed ? '已核对' : playing ? '暂停后核对' : '定位后核对'}</span></div><div className="frame-editor-image-stage">
          {preview && frameEditorSelectionMatches(preview, selected) ? <img src={preview.url} alt={`待提取画面 ${frameEditorTimecode(preview.timestampSeconds)}`} /> : <div className="frame-editor-placeholder" role="status">{decoding ? <LoaderCircle size={24} className="is-spinning" /> : <Clock3 size={28} />}<span>{decoding ? '正在核对这一帧…' : playing ? '暂停播放，选择需要的画面' : '选择有效时间点后显示静帧'}</span></div>}
        </div><p className="frame-editor-frame-detail">{preview && frameEditorSelectionMatches(preview, selected) ? preview.result.decodedTimestampSeconds !== undefined ? `请求 ${frameEditorTimecode(preview.timestampSeconds)} · 解码画面 ${frameEditorTimecode(preview.result.decodedTimestampSeconds)}` : `请求 ${frameEditorTimecode(preview.timestampSeconds)} · 浏览器未提供帧时码` : '按秒定位；视频编码可能影响实际帧时间。'}</p></div>
      </div>
      <div className="frame-editor-timeline"><label htmlFor="frame-editor-range">时间轴<span>{metadata ? `${frameEditorSeconds(metadata.duration)} 秒` : '等待视频信息'}</span></label><input id="frame-editor-range" type="range" aria-label="抽帧时间轴" min="0" max={metadata ? frameEditorLastTimestamp(metadata.duration) : 0} step="0.001" value={parsed.value ?? 0} disabled={!metadata || loading || saving} onChange={(event) => choose(event.target.value)} />
        <div className="frame-editor-time-controls"><button type="button" aria-label="向前 0.1 秒" disabled={!metadata || saving} onClick={() => step(-.1)}><SkipBack size={15} /><span>−0.1 秒</span></button><label>精确时间<input type="text" inputMode="decimal" aria-label="精确抽帧时间（秒）" value={timestamp} disabled={!metadata || saving} onCompositionStart={() => { composing.current = true; stopDecode(); clearPreview() }} onCompositionEnd={(event) => { composing.current = false; choose(event.currentTarget.value) }} onChange={(event) => choose(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !composing.current && !frameEditorComposing(event.nativeEvent)) { event.preventDefault(); choose(event.currentTarget.value) } }} /><span>秒</span></label><button type="button" aria-label="向后 0.1 秒" disabled={!metadata || saving} onClick={() => step(.1)}><span>+0.1 秒</span><SkipForward size={15} /></button></div>
      </div>
      {sequenceMode && <div className="frame-sequence-panel" aria-label="分镜时间点设置">
        <div className="frame-sequence-heading"><div><h3>分镜时间点 <span>{timestamps.length}/16</span></h3><p>按时间先后排列 · 点击时间点预览</p></div><button type="button" disabled={!confirmed || saving || timestamps.length >= 16 || parsed.value !== null && timestamps.includes(parsed.value)} onClick={addCurrentFrame}><Plus size={15} />加入当前画面</button></div>
        <ol className="frame-sequence-list" aria-label="已选分镜时间点">{timestamps.map((seconds, index) => <li key={seconds}>
          <button type="button" className={parsed.value === seconds ? 'is-selected' : ''} aria-pressed={parsed.value === seconds} aria-label={`预览第 ${index + 1} 帧，${frameEditorSeconds(seconds)} 秒`} disabled={saving} onClick={() => choose(String(seconds))}><span>{String(index + 1).padStart(2, '0')}</span><time>{frameEditorTimecode(seconds)}</time></button>
          <button type="button" className="frame-sequence-remove" aria-label={`移除第 ${index + 1} 帧，${frameEditorSeconds(seconds)} 秒`} disabled={saving} onClick={() => removeTimestamp(seconds)}><X size={13} /></button>
        </li>)}</ol>
        {!timestamps.length && <p className="frame-sequence-empty">读取视频后可等距取样，也可预览画面后逐个加入。</p>}
        <fieldset className="frame-sequence-sampling" disabled={!metadata || loading || saving}><legend>等距取样 <span>填入时替换当前列表</span></legend>
          <label>帧数<input type="text" inputMode="numeric" aria-label="等距取样帧数" value={sampleCount} onChange={(event) => setSampleCount(event.target.value)} /></label>
          <label>从（秒）<input type="text" inputMode="decimal" aria-label="等距取样起始时间（秒）" value={sampleStart} onChange={(event) => setSampleStart(event.target.value)} /></label>
          <label>到（秒）<input type="text" inputMode="decimal" aria-label="等距取样结束时间（秒）" value={sampleEnd} onChange={(event) => setSampleEnd(event.target.value)} /></label>
          <button type="button" disabled={!metadata || saving || !!sampleError || !sampleValues.length} onClick={sampleFrames}>等距填入</button>
        </fieldset>
        <p className="frame-sequence-notice" role={queueError || sampleError ? 'alert' : 'status'}>{queueError || sampleError || queueNotice || '每个时间点都会创建一个可独立调整的抽帧节点。'}</p>
      </div>}
      <div className="frame-editor-feedback" role={error || metadata && parsed.error ? 'alert' : 'status'}>{error || (metadata ? parsed.error : '') || (saving ? sequenceMode ? '正在创建分镜节点…' : '正在应用时间点…' : sequenceMode ? confirmed ? '当前画面已核对，可加入列表；其余时间点将在运行时逐一提取。' : '播放和预览不会改变分镜列表。' : confirmed ? '画面已核对，可以应用；原视频会保留。' : '定位和预览不会修改节点。')}{error && <button type="button" disabled={saving} onClick={() => { if (sourceRef.current && metadataRef.current) choose(timestampRef.current); else setRetry((value) => value + 1) }}><RefreshCw size={14} />重试</button>}</div>
      <footer className="frame-editor-footer"><span>方向键微调 0.1 秒 · Shift + 方向键 1 秒</span><div><button type="button" onClick={close}>取消</button><button type="button" className="is-primary" disabled={!canApply || saving} onClick={() => void apply()}>{saving ? <LoaderCircle size={16} className="is-spinning" /> : <Check size={16} />}{saving ? sequenceMode ? '创建中…' : '应用中…' : sequenceMode ? `创建 ${timestamps.length} 帧分镜` : '应用时间点'}</button></div></footer>
    </section>
  </div>, document.body)
}
