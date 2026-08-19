import { createContext, memo, useContext, useEffect, useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { Handle, NodeToolbar, Position, useNodeConnections, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { AlertCircle, AlertTriangle, ArrowRight, BookmarkPlus, Check, CheckCircle2, Circle, Clock3, Film, FolderOpen, Image as ImageIcon, LoaderCircle, Lock, Maximize2, MoreHorizontal, Music2, Play, Upload, X } from 'lucide-react'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodeDefinition, NodePortDefinition } from '../domain/node-definition'
import type { AssetRef, NodeKind, WorkflowNodeData } from '../model'
import type { CanvasAssetSummary } from '../host'
import {
  availableImageModelPresets,
  availableVideoModelPresets,
  defaultImageQuality,
  defaultImageResolution,
  defaultImageSize,
  imageSizeLabel,
  imageModelPreset,
  imageModelPresets,
  imageQualityOptions,
  imageResolutionOptions,
  presetVideoModels,
  defaultVideoModel,
  defaultVideoSeconds,
  videoAspectRatioOptions,
  videoModeOptions,
  videoResolutionOptions,
  videoSizeOptions,
  videoModelPreset,
  videoModelPresets,
} from '../models'
import { AudioPreview, SafeImage, ViewportVideo, isLocalCanvasAssetUrl } from '../components/MediaPreview'
import { PromptEditor } from '../components/PromptEditor'
import { buildCanvasUpstreamReferences, type UpstreamMediaReference } from '../components/upstream-references'
import { mediaAssetAspectRatio } from '../library/media-assets'
import { createNodeRendererRegistry } from './node-renderer-registry'
import type { CanvasNodeLod } from './node-lod'
import { nodeResultStagingState } from '../runtime/run-projection'
import { formatRunElapsed, runElapsedMilliseconds } from './run-timing'

export function ModelSuggestions() {
  return (
    <datalist id="wf-video-models">
      {presetVideoModels.map((model) => <option key={model} value={model} />)}
    </datalist>
  )
}

interface CanvasModelAvailability {
  connected: boolean
  imageModels: readonly string[]
  videoModels: readonly string[]
}

const CanvasModelAvailabilityContext = createContext<CanvasModelAvailability>({
  connected: false,
  imageModels: [],
  videoModels: [],
})

export function CanvasModelAvailabilityProvider({
  connected,
  imageModels,
  videoModels,
  children,
}: CanvasModelAvailability & { children: ReactNode }) {
  return (
    <CanvasModelAvailabilityContext.Provider value={{ connected, imageModels, videoModels }}>
      {children}
    </CanvasModelAvailabilityContext.Provider>
  )
}

const CanvasNodeViewContext = createContext<{ lod: CanvasNodeLod }>({ lod: 'detail' })

export function CanvasNodeViewProvider({ lod, children }: { lod: CanvasNodeLod; children: ReactNode }) {
  const value = useMemo(() => ({ lod }), [lod])
  return <CanvasNodeViewContext.Provider value={value}>{children}</CanvasNodeViewContext.Provider>
}

export type CanvasNode = Node<WorkflowNodeData & Record<string, unknown>, NodeKind> & {
  definitionVersion: number
  disabled?: boolean
  unknownKind?: string
}

const CanvasUpstreamReferencesContext = createContext<ReadonlyMap<string, readonly UpstreamMediaReference[]>>(new Map())

export function CanvasUpstreamReferencesProvider({
  nodes,
  edges,
  assets,
  children,
}: {
  nodes: readonly CanvasNode[]
  edges: readonly Edge[]
  assets: readonly CanvasAssetSummary[]
  children: ReactNode
}) {
  const references = useMemo(() => buildCanvasUpstreamReferences(nodes, edges, assets), [assets, edges, nodes])
  return <CanvasUpstreamReferencesContext.Provider value={references}>{children}</CanvasUpstreamReferencesContext.Provider>
}

const statusLabel: Record<WorkflowNodeData['status'], string> = {
  idle: '待运行',
  queued: '排队中',
  running: '生成中',
  succeeded: '完成',
  failed: '失败',
}

const statusIcon = {
  idle: Circle,
  queued: Clock3,
  running: LoaderCircle,
  succeeded: CheckCircle2,
  failed: AlertCircle,
} satisfies Record<WorkflowNodeData['status'], typeof Circle>

const runStageLabel: Record<NonNullable<WorkflowNodeData['runStage']>, string> = {
  validating: '检查节点输入',
  'resolving-cache': '检查本地缓存',
  'waiting-slot': '等待执行槽位',
  submitting: '提交生成请求',
  processing: '服务端处理中',
  downloading: '下载生成结果',
  saving: '保存到工作目录',
}

interface NodeChangeHandlers {
  onPromptChange(nodeId: string, prompt: string): void
  onModelChange(nodeId: string, model: string): void
  onQualityChange(nodeId: string, quality: string): void
  onImageResolutionChange(nodeId: string, imageResolution: '1K' | '2K' | '4K'): void
  onSizeChange(nodeId: string, size: string): void
  onSecondsChange(nodeId: string, seconds: string): void
  onSettingsChange(nodeId: string, patch: Record<string, unknown>): void
  onSavePromptPreset(nodeId: string): void
  onRunToNode(nodeId: string): void
  onRunFromNode(nodeId: string): void
  onDownloadAsset(nodeId: string): void
  onShowAssetMenu(nodeId: string): void
  onResumeTask(nodeId: string): void
  onSelectCandidate(nodeId: string, candidateId: string): void
  onAdoptCandidate(nodeId: string, candidateId: string): void
  onDiscardCandidate(nodeId: string, candidateId: string): void
  onShowCandidateMenu(assetId: string): void
  onBindAsset(nodeId: string, assetId: string): void
  onPickAsset(nodeId: string): void
  onImportAssetFile(nodeId: string, file: File): void
  onPreviewAsset(asset: AssetRef): void
  onMediaMetadata(nodeId: string, assetId: string, width: number, height: number): void
}

let handlers: NodeChangeHandlers = {
  onPromptChange: () => undefined,
  onModelChange: () => undefined,
  onQualityChange: () => undefined,
  onImageResolutionChange: () => undefined,
  onSizeChange: () => undefined,
  onSecondsChange: () => undefined,
  onSettingsChange: () => undefined,
  onSavePromptPreset: () => undefined,
  onRunToNode: () => undefined,
  onRunFromNode: () => undefined,
  onDownloadAsset: () => undefined,
  onShowAssetMenu: () => undefined,
  onResumeTask: () => undefined,
  onSelectCandidate: () => undefined,
  onAdoptCandidate: () => undefined,
  onDiscardCandidate: () => undefined,
  onShowCandidateMenu: () => undefined,
  onBindAsset: () => undefined,
  onPickAsset: () => undefined,
  onImportAssetFile: () => undefined,
  onPreviewAsset: () => undefined,
  onMediaMetadata: () => undefined,
}

export function registerNodeChangeHandlers(next: NodeChangeHandlers): void {
  handlers = next
}

function textSetting(data: WorkflowNodeData, key: string, fallback = ''): string {
  const value = data.settings?.[key]
  return typeof value === 'string' ? value : fallback
}

function numberSetting(data: WorkflowNodeData, key: string, fallback: number): number {
  const value = data.settings?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanSetting(data: WorkflowNodeData, key: string, fallback: boolean): boolean {
  const value = data.settings?.[key]
  return typeof value === 'boolean' ? value : fallback
}

function mediaInputLabel(kind: NodeKind): string {
  return kind === 'video-input' ? '视频' : kind === 'audio-input' ? '音频' : '图片'
}

function MediaInputDropZone({ id, kind, asset, locked = false, disabled = false }: { id: string; kind: 'image-input' | 'video-input' | 'audio-input'; asset?: AssetRef; locked?: boolean; disabled?: boolean }) {
  const label = mediaInputLabel(kind)
  const expectedAssetKind = kind === 'video-input' ? 'video' : kind === 'audio-input' ? 'audio' : 'image'
  const hasAsset = Boolean(asset?.assetId)
  const previewUrl = asset?.kind === expectedAssetKind && isLocalCanvasAssetUrl(asset.localUrl, expectedAssetKind)
    ? asset.localUrl
    : undefined
  const acceptDrag = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('application/x-xingmang-asset-id') || event.dataTransfer.types.includes('Files')) {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      event.currentTarget.classList.add('is-drag-over')
    }
  }
  const preview = previewUrl && asset?.kind === 'image'
    ? <SafeImage
        className="wf-input-preview wf-preview wf-input-preview-image"
        src={previewUrl}
        alt={`${label}素材预览`}
        draggable={false}
        style={{ aspectRatio: mediaAssetAspectRatio(asset) }}
        title="双击放大预览"
        onLoad={(event) => asset.assetId && handlers.onMediaMetadata(id, asset.assetId, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
        onDoubleClick={(event) => { event.stopPropagation(); handlers.onPreviewAsset(asset) }}
      />
    : previewUrl && asset?.kind === 'video'
      ? <ViewportVideo
          className="wf-input-preview wf-preview wf-input-preview-video nodrag nowheel"
          src={previewUrl}
          aria-label={`${label}素材预览`}
          controls
          draggable={false}
          style={{ aspectRatio: mediaAssetAspectRatio(asset) }}
          title="双击放大预览"
          onLoadedMetadata={(event) => asset.assetId && handlers.onMediaMetadata(id, asset.assetId, event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          onDoubleClick={(event) => { event.stopPropagation(); handlers.onPreviewAsset(asset) }}
        />
      : previewUrl && asset?.kind === 'audio'
        ? <div className="wf-input-preview wf-preview wf-input-preview-audio"><AudioPreview className="nodrag" src={previewUrl} /></div>
        : hasAsset
          ? <span className="wf-input-preview media-unavailable" role="img" aria-label={`${label}素材不可用`}><Upload size={16} aria-hidden="true" /><span>素材不可用</span></span>
          : null
  return (
    <div
      className={`wf-drop-target${hasAsset ? ' has-asset' : ' nodrag'}`}
      onDragOver={acceptDrag}
      onDragLeave={(event) => event.currentTarget.classList.remove('is-drag-over')}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.classList.remove('is-drag-over')
        const assetId = event.dataTransfer.getData('application/x-xingmang-asset-id')
        if (assetId) handlers.onBindAsset(id, assetId)
        else if (event.dataTransfer.files[0]) handlers.onImportAssetFile(id, event.dataTransfer.files[0])
      }}
      onContextMenu={(event) => {
        if (!hasAsset) return
        event.preventDefault()
        handlers.onShowAssetMenu(id)
      }}
    >
      {preview}
      {!hasAsset && <Upload size={16} aria-hidden="true" />}
      {!hasAsset && <span>{`拖入${label}素材或从文件选择`}</span>}
      {!hasAsset && <button type="button" className="wf-pick-asset" onClick={() => handlers.onPickAsset(id)}>
        <FolderOpen size={13} aria-hidden="true" />从文件选择
      </button>}
      {hasAsset && previewUrl && <div className="wf-media-input-overlay">
        <strong>{label}素材</strong>
        <span>
          <button type="button" className="nodrag" title={`替换${label}素材`} aria-label={`替换${label}素材`} onClick={() => handlers.onPickAsset(id)}><FolderOpen size={13} /></button>
          <button type="button" className="nodrag" title={`放大${label}预览`} aria-label={`放大${label}预览`} onClick={() => handlers.onPreviewAsset(asset as AssetRef)}><Maximize2 size={13} /></button>
        </span>
      </div>}
      {hasAsset && (locked || disabled) && <div className="wf-media-state-badges" aria-label="节点状态">
        {locked && <span className="wf-locked"><Lock size={10} aria-hidden="true" />已锁定</span>}
        {disabled && <span className="wf-disabled">已禁用</span>}
      </div>}
      {!previewUrl && hasAsset && <small className="wf-input-preview-hint">素材引用无效，请重新选择</small>}
    </div>
  )
}

function supportsPrompt(kind: NodeKind): boolean {
  return ['text', 'prompt', 'image', 'video', 'image-generate', 'image-edit', 'video-generate'].includes(kind)
}

function supportsModel(kind: NodeKind): boolean {
  return ['image', 'video', 'image-generate', 'image-edit', 'video-generate'].includes(kind)
}

function multiInputHint(kind: NodeKind): string | null {
  if (kind === 'image-edit') return '文本、图片前置节点均可多连 · 图片编辑最多使用 4 张参考图'
  if (kind === 'video-generate' || kind === 'video') return '文本、图片、视频、音频均可多连 · MiniMax 最多使用 9 图、3 视频、3 音频'
  return null
}

function RunningElapsed({ startedAt }: { startedAt?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  const elapsed = formatRunElapsed(runElapsedMilliseconds(startedAt, now))
  return <time className="wf-run-elapsed" dateTime={startedAt} title="本次运行已用时间">已用时 {elapsed}</time>
}

function NodeRunToolbar({
  id,
  title,
  selected,
  disabled,
}: {
  id: string
  title: string
  selected: boolean
  disabled: boolean
}) {
  if (!selected) return null
  return (
    <NodeToolbar position={Position.Top} offset={8} className="wf-node-toolbar" role="toolbar" aria-label={`${title}节点操作`}>
      <button type="button" title="运行到此：执行该节点及其所需上游" disabled={disabled} onClick={() => handlers.onRunToNode(id)}>
        <Play size={13} aria-hidden="true" /><span>运行到此</span>
      </button>
      <button type="button" title="从此向后：执行该节点的下游链路及必要依赖" disabled={disabled} onClick={() => handlers.onRunFromNode(id)}>
        <ArrowRight size={13} aria-hidden="true" /><span>从此向后</span>
      </button>
    </NodeToolbar>
  )
}

function UpstreamReferencePreview({ reference }: { reference: UpstreamMediaReference }) {
  const readyAsset = reference.status === 'ready' ? reference.asset : undefined
  const preview = readyAsset?.localUrl && reference.kind === 'image'
    ? <SafeImage src={readyAsset.localUrl} alt="" fallbackLabel="等待上游图片" />
    : readyAsset?.localUrl && reference.kind === 'video'
      ? <ViewportVideo src={readyAsset.localUrl} aria-label="上游视频预览" muted preload="metadata" />
      : readyAsset?.localUrl && reference.kind === 'audio'
        ? <Music2 size={17} aria-hidden="true" />
        : <Clock3 size={16} aria-hidden="true" />
  return (
    <article className={`wf-upstream-reference is-${reference.kind} is-${reference.status}`}>
      <button
        type="button"
        className="wf-upstream-preview nodrag"
        title={readyAsset ? '预览上游素材' : '等待上游产物'}
        aria-label={readyAsset ? `预览上游素材：${reference.label}` : `等待上游产物：${reference.label}`}
        disabled={!readyAsset}
        onClick={() => readyAsset && handlers.onPreviewAsset(readyAsset)}
      >{preview}</button>
      <span>
        <strong title={reference.label}>{reference.label}</strong>
        <small>{reference.status === 'ready'
          ? reference.relationLabel
          : reference.kind === 'image' ? '等待上游产物' : '提示词引用 · 等待产物'}</small>
      </span>
      <span className={`wf-upstream-kind is-${reference.kind}`} title={reference.kind === 'image' ? '图片' : reference.kind === 'video' ? '视频' : '音频'}>
        {reference.kind === 'image' ? <ImageIcon size={12} /> : reference.kind === 'video' ? <Film size={12} /> : <Music2 size={12} />}
      </span>
    </article>
  )
}

function UpstreamReferencesPanel({ references }: { references: readonly UpstreamMediaReference[] }) {
  if (references.length === 0) return null
  return (
    <section className="wf-upstream-references nodrag" aria-label="显式连接的上游素材">
      <div className="wf-upstream-head"><span>上游素材</span><small>{references.length}</small></div>
      <div>{references.map((reference) => <UpstreamReferencePreview key={reference.edgeId} reference={reference} />)}</div>
    </section>
  )
}

function NodeSettings({ id, data, kind }: { id: string; data: WorkflowNodeData; kind: NodeKind }) {
  if (kind === 'note') {
    return (
      <textarea
        className="nodrag wf-note"
        aria-label="备注内容"
        value={textSetting(data, 'text')}
        placeholder="记录思路、参数或交付说明"
        onChange={(event) => handlers.onSettingsChange(id, { text: event.target.value })}
        rows={5}
      />
    )
  }
  if (kind === 'group') {
    return (
      <input
        className="nodrag wf-model"
        value={textSetting(data, 'title', '新建分组')}
        aria-label="分组名称"
        onChange={(event) => handlers.onSettingsChange(id, { title: event.target.value })}
      />
    )
  }
  if (kind === 'image-input' || kind === 'video-input' || kind === 'audio-input') return <MediaInputDropZone id={id} kind={kind} asset={data.result} />
  if (kind === 'frame-extract') {
    return (
      <label className="wf-inline-field nodrag">
        <span>时间点</span>
        <input
          type="number"
          aria-label="提取时间点（秒）"
          min="0"
          step="0.1"
          value={numberSetting(data, 'timestampSeconds', 0)}
          onChange={(event) => handlers.onSettingsChange(id, { timestampSeconds: Number(event.target.value) })}
        />
        <span>秒</span>
      </label>
    )
  }
  if (kind === 'router') {
    return (
      <select
        className="nodrag wf-model"
        aria-label="路由策略"
        value={textSetting(data, 'strategy', 'first-available')}
        onChange={(event) => handlers.onSettingsChange(id, { strategy: event.target.value })}
      >
        <option value="first-available">优先使用首个可用输入</option>
        <option value="all">保留全部输入</option>
      </select>
    )
  }
  if (kind === 'gallery') {
    const count = data.candidateAssetIds?.length ?? (data.result?.assetId ? 1 : 0)
    return <div className="wf-gallery-empty">{count > 0 ? `${count} 个候选，可在运行结果中采纳` : '运行生成节点后在此汇总候选'}</div>
  }
  if (kind === 'output') {
    const stagingState = nodeResultStagingState(data)
    return <p className={`wf-result-note is-${stagingState}`}>
      {stagingState === 'pending' ? '待确认结果' : stagingState === 'accepted' ? '最终产物已确认' : '连接上游后运行'}
    </p>
  }
  if (kind === 'unknown') {
    return <p className="wf-error">{data.errorMessage || '当前版本无法识别这个节点'}</p>
  }
  return null
}

function NodeShell({ id, data, kind, selected }: { id: string; data: WorkflowNodeData & Record<string, unknown>; kind: NodeKind; selected: boolean }) {
  const modelAvailability = useContext(CanvasModelAvailabilityContext)
  const { lod } = useContext(CanvasNodeViewContext)
  const upstreamReferences = useContext(CanvasUpstreamReferencesContext).get(id) ?? []
  const definition = builtinNodeRegistry.resolve(kind) ?? builtinNodeRegistry.require('unknown')
  const disabled = data.__canvasDisabled === true
  const locked = data.__canvasLocked === true
  const inputs = definition.ports.filter((port) => port.direction === 'input')
  const outputs = definition.ports.filter((port) => port.direction === 'output')
  const inputHint = multiInputHint(kind)
  const imageOperation = kind === 'image' || kind === 'image-generate' || kind === 'image-edit'
  const videoOperation = kind === 'video' || kind === 'video-generate'
  const mediaInput = kind === 'image-input' || kind === 'video-input' || kind === 'audio-input'
  const imageModels = modelAvailability.connected
    ? availableImageModelPresets(modelAvailability.imageModels)
    : [...imageModelPresets]
  const videoModels = modelAvailability.connected
    ? availableVideoModelPresets(modelAvailability.videoModels)
    : [...videoModelPresets]
  const selectedModel = data.model || (videoOperation ? defaultVideoModel : imageModelPresets[0].id)
  const selectedVideoPreset = videoModelPreset(selectedModel)
  const mediaModelAvailable = !modelAvailability.connected || (
    imageOperation
      ? imageModels.some((preset) => preset.id === selectedModel)
      : !videoOperation || videoModels.some((preset) => preset.id === selectedModel)
  )
  const canRunNode = !disabled && ['image', 'video', 'image-generate', 'image-edit', 'video-generate', 'frame-extract'].includes(kind)
  const nodeRunning = data.status === 'running' || data.status === 'queued'
  const selectedCandidate = data.candidates?.find((candidate) => candidate.candidateId === data.selectedCandidateId)
    ?? data.candidates?.find((candidate) => candidate.candidateId === data.adoptedCandidateId)
    ?? data.candidates?.[0]
  const displayedResult = selectedCandidate?.asset ?? data.result
  const StatusIcon = statusIcon[data.status]
  const summaryMode = lod === 'summary' && kind !== 'group' && !selected
  const promptSummary = kind === 'note' ? textSetting(data, 'text') : data.prompt
  const resultSummary = displayedResult?.kind === 'image'
    ? '图像结果已就绪'
    : displayedResult?.kind === 'video'
      ? '视频结果已就绪'
      : displayedResult?.kind === 'audio'
        ? '音频结果已就绪'
        : data.status === 'failed'
          ? data.errorMessage || '运行失败'
          : data.status === 'running' || data.status === 'queued'
            ? data.runStage ? runStageLabel[data.runStage] : data.status === 'running' ? '正在生成结果' : '等待执行槽位'
              : data.dirty
                ? '输入已变化，等待重新运行'
                : '尚无运行结果'

  if (mediaInput && data.result?.assetId) {
    const output = outputs[0]
    return (
      <div className={`wf-node wf-media-bound wf-media-bound-${data.result.kind}${disabled ? ' wf-is-disabled' : ''}${locked ? ' wf-is-locked' : ''}`}>
        {canRunNode && <NodeRunToolbar id={id} title={definition.title} selected={selected} disabled={nodeRunning} />}
        <MediaInputDropZone id={id} kind={kind as 'image-input' | 'video-input' | 'audio-input'} asset={data.result} locked={locked} disabled={disabled} />
        {output && <Handle
          type="source"
          id={output.id}
          position={Position.Right}
          style={{ top: '50%' }}
          className={`wf-port wf-port-${output.kind}`}
          title={output.label}
        />}
      </div>
    )
  }

  return (
    <div className={`wf-node wf-node-${kind} wf-category-${definition.category} wf-status-${data.status}${data.dirty ? ' wf-is-dirty' : ''}${data.fromCache && data.status === 'succeeded' && !data.dirty ? ' wf-is-cached' : ''}${disabled ? ' wf-is-disabled' : ''}${locked ? ' wf-is-locked' : ''}${summaryMode ? ' wf-lod-summary' : ''}`}>
      {canRunNode && (
        <NodeRunToolbar
          id={id}
          title={definition.title}
          selected={selected}
          disabled={nodeRunning || ((imageOperation || videoOperation) && !mediaModelAvailable)}
        />
      )}
      {inputs.map((port, index) => (
        <PortHandle key={port.id} nodeId={id} port={port} index={index} />
      ))}
      <header>
        {/* Both lines ellipsize, so the full text must stay reachable. */}
        <span className="wf-node-title">
          <strong title={definition.title}>{definition.title}</strong>
          <small title={definition.description}>{definition.description}</small>
        </span>
        <span className="wf-head-right">
          {supportsPrompt(kind) && data.prompt.trim() && (
            <button type="button" className="nodrag wf-icon-command" title="保存为提示词预设" aria-label="保存为提示词预设" onClick={() => handlers.onSavePromptPreset(id)}><BookmarkPlus size={14} /></button>
          )}
          {data.status === 'idle'
            ? <span className="wf-status-idle-dot" title="待运行" aria-label="待运行" />
            : <span className={`wf-status wf-status-${data.status}`}><StatusIcon size={12} aria-hidden="true" />{statusLabel[data.status]}</span>}
          {data.fromCache && data.status === 'succeeded' && !data.dirty && (
            <span className="wf-cached" title="输入未变化，本次复用了上次结果，没有产生新的付费请求">已缓存</span>
          )}
          {locked && <span className="wf-locked" title="节点位置已锁定" role="img" aria-label="位置已锁定"><Lock size={10} aria-hidden="true" /></span>}
          {disabled && <span className="wf-disabled" title="此节点不会参与运行">已禁用</span>}
          {data.dirty && <span className="wf-dirty" title="输入或采纳结果已变化，需要重新运行">待更新</span>}
        </span>
        {/* Pinned to the header's bottom border so a run costs zero height and
            the graph never reflows mid-execution. */}
        {(data.status === 'queued' || data.status === 'running') && (
          <span
            className={`wf-head-progress${data.runProgressMode === 'determinate' && typeof data.runProgress === 'number' ? ' is-determinate' : ''}`}
            style={data.runProgressMode === 'determinate' && typeof data.runProgress === 'number'
              ? { '--wf-progress': `${Math.max(0, Math.min(100, data.runProgress))}%` } as CSSProperties
              : undefined}
            aria-hidden="true"
          />
        )}
      </header>

      {summaryMode && (
        <section className="wf-node-overview" aria-label={`${definition.title}摘要`}>
          <div className="wf-node-overview-state">
            <StatusIcon size={17} aria-hidden="true" />
            <span><strong>{statusLabel[data.status]}</strong><small>{resultSummary}</small></span>
          </div>
          {supportsModel(kind) && <p title={selectedModel}><span>模型</span><strong>{selectedModel || '未设置'}</strong></p>}
          {promptSummary.trim() && <blockquote title={promptSummary}>{promptSummary}</blockquote>}
          <div className="wf-node-overview-ports">
            {inputs.map((port) => <span key={port.id} className={`is-${port.kind}`}>输入·{port.label}{port.cardinality === 'many' ? '×N' : ''}</span>)}
            {outputs.map((port) => <span key={port.id} className={`is-${port.kind}`}>输出·{port.label}</span>)}
          </div>
        </section>
      )}

      <div className="wf-node-details" aria-hidden={summaryMode || undefined}>

      {inputHint && <p className="wf-input-contract-hint" role="note">{inputHint}</p>}

      {supportsPrompt(kind) && (
        <PromptEditor
          label={`${definition.title}提示词`}
          value={data.prompt}
          placeholder={kind === 'text' || kind === 'prompt' ? '输入提示词或指令' : '补充这个节点的提示词'}
          references={upstreamReferences}
          onChange={(prompt) => handlers.onPromptChange(id, prompt)}
        />
      )}

      {(kind === 'image-edit' || kind === 'video-generate' || kind === 'video') && (
        <UpstreamReferencesPanel references={upstreamReferences} />
      )}

      {imageOperation && (() => {
        const preset = imageModelPreset(data.model || imageModelPresets[0].id)
        return (
          <>
            <select className="nodrag wf-model" aria-label="图像模型" value={selectedModel} onChange={(event) => handlers.onModelChange(id, event.target.value)}>
              {!mediaModelAvailable && <option value={selectedModel} disabled>{imageModelPreset(selectedModel).label}（当前分组不可用）</option>}
              {imageModels.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
            {!mediaModelAvailable && <p className="wf-error is-validation" role="status"><AlertTriangle size={13} aria-hidden="true" />当前分组不提供此图像模型，请重新选择</p>}
            {/* One parameter per row on a shared label/control subgrid. Three
                selects abreast left each about 93px, which truncated every
                size and quality label. */}
            <div className="wf-params nodrag">
              {preset.supportsQuality && (
                <label className="wf-inline-field">
                  <span>画质</span>
                  <select className="wf-model" value={data.quality || defaultImageQuality} aria-label="生成画质" onChange={(event) => handlers.onQualityChange(id, event.target.value)}>
                    {imageQualityOptions.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                  </select>
                </label>
              )}
              <label className="wf-inline-field">
                <span>清晰度</span>
                <select
                  className="wf-model"
                  value={preset.resolutions.includes(data.imageResolution ?? defaultImageResolution) ? (data.imageResolution ?? defaultImageResolution) : preset.resolutions[0]}
                  title={preset.resolutionNote ?? '输出清晰度'}
                  aria-label="生成清晰度"
                  onChange={(event) => handlers.onImageResolutionChange(id, event.target.value as '1K' | '2K' | '4K')}
                >
                  {imageResolutionOptions.map((entry) => (
                    <option key={entry.value} value={entry.value} disabled={!preset.resolutions.includes(entry.value)}>
                      {entry.label}{preset.resolutions.includes(entry.value) ? '' : '（当前模型不支持）'}
                    </option>
                  ))}
                </select>
              </label>
              {preset.supportsSize && (
                <label className="wf-inline-field">
                  <span>尺寸</span>
                  <select className="wf-model" value={preset.sizes.includes(data.size || '') ? data.size : (preset.sizes[0] ?? defaultImageSize)} aria-label="生成尺寸" onChange={(event) => handlers.onSizeChange(id, event.target.value)}>
                    {preset.sizes.map((size) => <option key={size} value={size}>{imageSizeLabel(size)}</option>)}
                  </select>
                </label>
              )}
            </div>
          </>
        )
      })()}

      {videoOperation && supportsModel(kind) && (
        <div className="wf-video-params nodrag">
          <select className="wf-model" aria-label="视频模型" value={selectedModel} onChange={(event) => handlers.onModelChange(id, event.target.value)}>
            {!mediaModelAvailable && <option value={selectedModel} disabled>{selectedVideoPreset.label}（当前分组不可用）</option>}
            {videoModels.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
          {!mediaModelAvailable && <p className="wf-error is-validation" role="status"><AlertTriangle size={13} aria-hidden="true" />当前分组不提供此视频模型，请重新选择</p>}
          {selectedVideoPreset.provider === 'minimax-h3' ? (
            <>
              <label className="wf-inline-field">
                <span>模式</span>
                <select
                  className="wf-model"
                  aria-label="MiniMax 生成模式"
                  value={textSetting(data, 'videoMode', 'auto')}
                  onChange={(event) => handlers.onSettingsChange(id, { videoMode: event.target.value })}
                >
                  {videoModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="wf-inline-field">
                <span>清晰度</span>
                <select
                  className="wf-model"
                  aria-label="MiniMax 视频分辨率"
                  value={textSetting(data, 'videoResolution', '720p')}
                  onChange={(event) => handlers.onSettingsChange(id, { videoResolution: event.target.value })}
                >
                  {videoResolutionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="wf-inline-field">
                <span>比例</span>
                <select
                  className="wf-model"
                  aria-label="MiniMax 视频比例"
                  value={textSetting(data, 'videoAspectRatio', '16:9')}
                  onChange={(event) => handlers.onSettingsChange(id, { videoAspectRatio: event.target.value })}
                >
                  {videoAspectRatioOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="wf-video-toggle">
                <input
                  type="checkbox"
                  checked={booleanSetting(data, 'promptOptimization', false)}
                  onChange={(event) => handlers.onSettingsChange(id, { promptOptimization: event.target.checked })}
                />
                <span>AI 优化 H3 提示词</span>
              </label>
            </>
          ) : (
            <label className="wf-inline-field">
              <span>比例</span>
              <select
                className="wf-model"
                aria-label="视频比例"
                value={selectedVideoPreset.sizes.includes(data.size || '') ? data.size : selectedVideoPreset.defaultSize}
                onChange={(event) => handlers.onSizeChange(id, event.target.value)}
              >
                {videoSizeOptions
                  .filter((size) => selectedVideoPreset.sizes.includes(size.value))
                  .map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}
              </select>
            </label>
          )}
          <label className="wf-inline-field">
            <span>时长</span>
            <select
              className="wf-model"
              aria-label="视频时长"
              value={data.seconds ?? String(defaultVideoSeconds)}
              onChange={(event) => handlers.onSecondsChange(id, event.target.value)}
            >
              {(selectedVideoPreset.provider === 'minimax-h3'
                ? Array.from(
                  { length: selectedVideoPreset.maximumSeconds - selectedVideoPreset.minimumSeconds + 1 },
                  (_, index) => selectedVideoPreset.minimumSeconds + index,
                )
                : [5, 10, 15]
              ).map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
            </select>
          </label>
        </div>
      )}

      <NodeSettings id={id} data={data} kind={kind} />

      {(data.status === 'queued' || data.status === 'running') && (
        <div className="wf-progress" role="status" aria-live="polite">
          <p>
            {data.runStage
              ? `${runStageLabel[data.runStage]}${data.runProgressMode === 'determinate' && typeof data.runProgress === 'number' ? ` · ${Math.round(data.runProgress)}%` : '…'}`
              : data.status === 'queued'
                ? '正在等待可用执行槽位…'
              : videoOperation
                ? '视频生成中，完成后会自动保存到本地 · 通常需要数分钟'
                : data.quality === 'high'
                  ? '高清图像生成中 · 预计 2-3 分钟'
                  : '图像生成中 · 预计 10 秒至 1 分钟'}
          </p>
          <RunningElapsed startedAt={data.runStartedAt} />
          {data.runHealth === 'delayed' && <small>服务端仍在线，但本次生成已明显超过同规格历史耗时。</small>}
          {videoOperation && <small>{selectedVideoPreset.provider === 'minimax-h3'
            ? '停止时会向服务端请求取消；生成中的任务可能需要短暂等待才进入已取消状态。'
            : '停止等待不等于取消已到达服务端的生成任务，可稍后从运行记录续查。'}</small>}
        </div>
      )}
      {data.status === 'failed' && data.errorMessage && kind !== 'unknown' && <p className="wf-error" role="alert"><AlertCircle size={13} aria-hidden="true" />{data.errorMessage}</p>}
      {!mediaInput && displayedResult?.localUrl && displayedResult.kind === 'image' && (
        <SafeImage
          className="wf-preview"
          src={displayedResult.localUrl}
          alt={selectedCandidate ? '生成候选预览' : '生成结果'}
          loading="lazy"
          style={{ aspectRatio: mediaAssetAspectRatio(displayedResult, data.size) }}
          title="双击放大预览"
          onLoad={(event) => displayedResult.assetId && handlers.onMediaMetadata(id, displayedResult.assetId, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          onDoubleClick={(event) => {
            event.stopPropagation()
            handlers.onPreviewAsset(displayedResult)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            if (selectedCandidate?.asset.assetId) handlers.onShowCandidateMenu(selectedCandidate.asset.assetId)
            else handlers.onShowAssetMenu(id)
          }}
        />
      )}
      {!mediaInput && displayedResult?.kind === 'video' && isLocalCanvasAssetUrl(displayedResult.localUrl) && (
        <ViewportVideo
          className="wf-preview"
          src={displayedResult.localUrl}
          aria-label="视频素材预览"
          controls
          style={{ aspectRatio: mediaAssetAspectRatio(displayedResult, data.size) }}
          title="双击放大预览"
          onLoadedMetadata={(event) => displayedResult.assetId && handlers.onMediaMetadata(id, displayedResult.assetId, event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          onDoubleClick={(event) => { event.stopPropagation(); handlers.onPreviewAsset(displayedResult) }}
        />
      )}
      {!mediaInput && displayedResult?.kind === 'audio' && displayedResult.localUrl && (
        <div className="wf-audio-preview">
          <AudioPreview src={displayedResult.localUrl} />
          <button type="button" className="wf-audio-expand nodrag" title="放大音频预览" aria-label="放大音频预览" onClick={(event) => { event.stopPropagation(); handlers.onPreviewAsset(displayedResult) }}><Maximize2 size={14} /></button>
        </div>
      )}
      {data.result?.remoteUrl && (data.result.remoteUrl.startsWith('mock://') || data.result.kind === 'video') && <p className="wf-result-note">产物：{data.result.remoteUrl.slice(0, 120)}</p>}
      {typeof data.costQuota === 'number' && data.costQuota > 0 && <p className="wf-cost">本次消耗 {data.costQuota} quota</p>}
      {data.candidates && data.candidates.length > 0 && (
        <div className="wf-candidates nodrag">
          <div className="wf-candidate-strip" aria-label="生成候选">
            {data.candidates.map((candidate, index) => (
              <button
                key={candidate.candidateId}
                type="button"
                className={candidate.candidateId === selectedCandidate?.candidateId ? 'is-selected' : ''}
                title={`预览候选 ${index + 1}`}
                aria-label={`预览候选 ${index + 1}`}
                onClick={() => handlers.onSelectCandidate(id, candidate.candidateId)}
              >
                {candidate.asset.kind === 'image' && candidate.asset.localUrl
                  ? <SafeImage src={candidate.asset.localUrl} alt="" fallbackLabel="候选不可用" />
                  : <span>{index + 1}</span>}
              </button>
            ))}
          </div>
          {selectedCandidate && (
            <div className="wf-candidate-actions">
              <button
                type="button"
                className="wf-rerun"
                disabled={selectedCandidate.candidateId === data.adoptedCandidateId}
                onClick={() => handlers.onAdoptCandidate(id, selectedCandidate.candidateId)}
              >
                <Check size={12} />{selectedCandidate.candidateId === data.adoptedCandidateId ? '已采纳' : '采纳此候选'}
              </button>
              <button
                type="button"
                className="wf-discard-candidate"
                title={selectedCandidate.candidateId === data.adoptedCandidateId ? '已采纳结果不能丢弃' : '从当前候选区丢弃，不删除素材'}
                disabled={selectedCandidate.candidateId === data.adoptedCandidateId}
                onClick={() => handlers.onDiscardCandidate(id, selectedCandidate.candidateId)}
              >
                <X size={12} />丢弃
              </button>
              <button
                type="button"
                className="wf-icon-command"
                title="候选资产操作"
                aria-label="候选资产操作"
                onClick={() => selectedCandidate.asset.assetId && handlers.onShowCandidateMenu(selectedCandidate.asset.assetId)}
              ><MoreHorizontal size={14} /></button>
            </div>
          )}
        </div>
      )}
      {(data.attemptCount || data.latestAttemptDurationMs !== undefined) && (
        <p className="wf-runtime-meta">
          {data.attemptCount ? `${data.attemptCount} 次尝试` : ''}
          {data.attemptCount && data.latestAttemptDurationMs !== undefined ? ' · ' : ''}
          {data.latestAttemptDurationMs !== undefined ? `${(data.latestAttemptDurationMs / 1000).toFixed(1)} 秒` : ''}
        </p>
      )}
      <div className="wf-actions">
        {canRunNode && (
          <button
            type="button"
            className="nodrag wf-run-node"
            aria-label={`运行${definition.title}节点`}
            title="使用已有上游结果运行此节点"
            disabled={nodeRunning || ((imageOperation || videoOperation) && !mediaModelAvailable)}
            onClick={() => handlers.onRunToNode(id)}
          >
            {nodeRunning ? <LoaderCircle size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
            {nodeRunning ? '运行中' : '运行此节点'}
          </button>
        )}
        {data.result?.assetId && <button type="button" className="nodrag wf-rerun" onClick={() => handlers.onDownloadAsset(id)}>另存</button>}
        {videoOperation && data.result?.taskId && !data.result.assetId && !data.result.remoteUrl && data.status !== 'running' && data.status !== 'queued' && (
          <button type="button" className="nodrag wf-rerun" onClick={() => handlers.onResumeTask(id)}>续查任务</button>
        )}
      </div>
      </div>
      {outputs.map((port, index) => (
        <PortHandle key={port.id} nodeId={id} port={port} index={index} />
      ))}
    </div>
  )
}

/**
 * A port encodes three independent facts: hue is the media type, shape is the
 * cardinality, and fill is whether anything is actually attached. Reading the
 * connection state needs a hook, so each port is its own component.
 */
function PortHandle({ nodeId, port, index }: { nodeId: string; port: NodePortDefinition; index: number }) {
  const input = port.direction === 'input'
  const connections = useNodeConnections({
    id: nodeId,
    handleType: input ? 'target' : 'source',
    handleId: port.id,
  })
  const many = port.cardinality === 'many'
  const suffix = many ? '（可连接多个）' : ''
  const state = connections.length > 0 ? `已连接 ${connections.length} 条` : '未连接'
  return (
    <Handle
      type={input ? 'target' : 'source'}
      id={port.id}
      position={input ? Position.Left : Position.Right}
      style={{ top: 52 + index * 26 }}
      className={`wf-port wf-port-${port.kind}${many ? ' wf-port-many' : ''}${connections.length > 0 ? ' is-connected' : ''}`}
      title={`${port.label}${suffix} · ${state}`}
      aria-label={`${port.label}${many ? '，可连接多个' : ''}，${state}`}
    />
  )
}

function createRenderer(definition: NodeDefinition) {
  const Renderer = ({ id, data, selected }: NodeProps<CanvasNode>) => <NodeShell id={id} data={data} kind={definition.type as NodeKind} selected={selected} />
  Renderer.displayName = `${definition.type}Node`
  return memo(Renderer)
}

const builtinNodeRenderers = Object.fromEntries(
  builtinNodeRegistry.list().map((definition) => [definition.type, createRenderer(definition)]),
)

const unknownRenderer = builtinNodeRenderers.unknown
if (!unknownRenderer) throw new Error('未知节点 renderer 未注册')

export const nodeTypes = createNodeRendererRegistry<CanvasNode>(
  builtinNodeRegistry,
  builtinNodeRenderers,
  unknownRenderer,
)
