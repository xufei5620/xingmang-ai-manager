import { createContext, memo, useContext, useMemo, type DragEvent, type ReactNode } from 'react'
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { AlertCircle, BookmarkPlus, Check, CheckCircle2, Circle, Clock3, Film, FolderOpen, Image as ImageIcon, LoaderCircle, Maximize2, MoreHorizontal, Music2, Play, Upload } from 'lucide-react'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodeDefinition } from '../domain/node-definition'
import type { AssetRef, NodeKind, WorkflowNodeData } from '../model'
import type { CanvasAssetSummary } from '../host'
import {
  availableImageModelPresets,
  availableVideoModelPresets,
  defaultImageQuality,
  defaultImageSize,
  imageSizeLabel,
  imageModelPreset,
  imageModelPresets,
  imageQualityOptions,
  presetVideoModels,
  defaultVideoModel,
  defaultVideoSeconds,
  videoSizeOptions,
  videoModelPreset,
  videoModelPresets,
} from '../models'
import { AudioPreview, SafeImage, ViewportVideo, isLocalCanvasAssetUrl } from '../components/MediaPreview'
import { PromptEditor } from '../components/PromptEditor'
import { buildCanvasUpstreamReferences, type UpstreamMediaReference } from '../components/upstream-references'
import { mediaAssetAspectRatio } from '../library/media-assets'
import { createNodeRendererRegistry } from './node-renderer-registry'

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

interface NodeChangeHandlers {
  onPromptChange(nodeId: string, prompt: string): void
  onModelChange(nodeId: string, model: string): void
  onQualityChange(nodeId: string, quality: string): void
  onSizeChange(nodeId: string, size: string): void
  onSecondsChange(nodeId: string, seconds: string): void
  onSettingsChange(nodeId: string, patch: Record<string, unknown>): void
  onSavePromptPreset(nodeId: string): void
  onRerun(nodeId: string): void
  onDownloadAsset(nodeId: string): void
  onShowAssetMenu(nodeId: string): void
  onResumeTask(nodeId: string): void
  onSelectCandidate(nodeId: string, candidateId: string): void
  onAdoptCandidate(nodeId: string, candidateId: string): void
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
  onSizeChange: () => undefined,
  onSecondsChange: () => undefined,
  onSettingsChange: () => undefined,
  onSavePromptPreset: () => undefined,
  onRerun: () => undefined,
  onDownloadAsset: () => undefined,
  onShowAssetMenu: () => undefined,
  onResumeTask: () => undefined,
  onSelectCandidate: () => undefined,
  onAdoptCandidate: () => undefined,
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

function mediaInputLabel(kind: NodeKind): string {
  return kind === 'video-input' ? '视频' : kind === 'audio-input' ? '音频' : '图片'
}

function MediaInputDropZone({ id, kind, asset }: { id: string; kind: 'image-input' | 'video-input' | 'audio-input'; asset?: AssetRef }) {
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
  if (kind === 'video-generate' || kind === 'video') return '文本、图片、音频前置节点均可多连 · 视频接口使用第一张就绪参考图，音频保留为工作流依赖'
  return null
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
    return <p className="wf-result-note">{data.result?.assetId ? '最终产物已确认' : '连接并采纳上游结果后完成交付'}</p>
  }
  if (kind === 'unknown') {
    return <p className="wf-error">{data.errorMessage || '当前版本无法识别这个节点'}</p>
  }
  return null
}

function NodeShell({ id, data, kind }: { id: string; data: WorkflowNodeData & Record<string, unknown>; kind: NodeKind }) {
  const modelAvailability = useContext(CanvasModelAvailabilityContext)
  const upstreamReferences = useContext(CanvasUpstreamReferencesContext).get(id) ?? []
  const definition = builtinNodeRegistry.resolve(kind) ?? builtinNodeRegistry.require('unknown')
  const disabled = data.__canvasDisabled === true
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

  if (mediaInput && data.result?.assetId) {
    const output = outputs[0]
    return (
      <div className={`wf-node wf-media-bound wf-media-bound-${data.result.kind}`}>
        <MediaInputDropZone id={id} kind={kind as 'image-input' | 'video-input' | 'audio-input'} asset={data.result} />
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
    <div className={`wf-node wf-node-${kind} wf-category-${definition.category} wf-status-${data.status}${data.dirty ? ' wf-is-dirty' : ''}${disabled ? ' wf-is-disabled' : ''}`}>
      {inputs.map((port, index) => (
        <Handle
          key={port.id}
          type="target"
          id={port.id}
          position={Position.Left}
          style={{ top: 52 + index * 26 }}
          className={`wf-port wf-port-${port.kind}`}
          title={`${port.label}${port.cardinality === 'many' ? '（可连接多个）' : ''}`}
          aria-label={`${port.label}${port.cardinality === 'many' ? '，可连接多个' : ''}`}
        />
      ))}
      <header>
        <span className="wf-node-title">
          <strong>{definition.title}</strong>
          <small>{definition.description}</small>
        </span>
        <span className="wf-head-right">
          {supportsPrompt(kind) && data.prompt.trim() && (
            <button type="button" className="nodrag wf-icon-command" title="保存为提示词预设" aria-label="保存为提示词预设" onClick={() => handlers.onSavePromptPreset(id)}><BookmarkPlus size={14} /></button>
          )}
          {data.status === 'idle'
            ? <span className="wf-status-idle-dot" title="待运行" aria-label="待运行" />
            : <span className={`wf-status wf-status-${data.status}`}><StatusIcon size={12} aria-hidden="true" />{statusLabel[data.status]}</span>}
          {disabled && <span className="wf-disabled" title="此节点不会参与运行">已禁用</span>}
          {data.dirty && <span className="wf-dirty" title="输入或采纳结果已变化，需要重新运行">待更新</span>}
        </span>
      </header>

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
            {!mediaModelAvailable && <p className="wf-error">当前分组不提供此图像模型，请重新选择</p>}
            <div className="wf-params nodrag">
              {preset.supportsQuality && (
                <select className="wf-model" value={data.quality || defaultImageQuality} title="画质" aria-label="生成画质" onChange={(event) => handlers.onQualityChange(id, event.target.value)}>
                  {imageQualityOptions.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                </select>
              )}
              {preset.supportsSize && (
                <select className="wf-model" value={preset.sizes.includes(data.size || '') ? data.size : (preset.sizes[0] ?? defaultImageSize)} title="尺寸" aria-label="生成尺寸" onChange={(event) => handlers.onSizeChange(id, event.target.value)}>
                  {preset.sizes.map((size) => <option key={size} value={size}>{imageSizeLabel(size)}</option>)}
                </select>
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
          {!mediaModelAvailable && <p className="wf-error">当前分组不提供此视频模型，请重新选择</p>}
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
          <label className="wf-inline-field">
            <span>时长</span>
            <select
              className="wf-model"
              aria-label="视频时长"
              value={data.seconds ?? String(defaultVideoSeconds)}
              onChange={(event) => handlers.onSecondsChange(id, event.target.value)}
            >
              {[5, 10, 15].filter((seconds) => seconds <= selectedVideoPreset.maximumSeconds).map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
            </select>
          </label>
        </div>
      )}

      <NodeSettings id={id} data={data} kind={kind} />

      {(data.status === 'queued' || data.status === 'running') && (
        <div className="wf-progress" role="status" aria-live="polite">
          <span className="wf-progress-bar" />
          <p>
            {data.status === 'queued'
              ? '正在等待可用执行槽位…'
              : videoOperation
                ? '视频生成中，完成后会自动保存到本地 · 通常需要数分钟'
                : data.quality === 'high'
                  ? '高清图像生成中 · 预计 2-3 分钟'
                  : '图像生成中 · 预计 10 秒至 1 分钟'}
          </p>
          {videoOperation && <small>停止等待不等于取消已到达服务端的生成任务，可稍后从运行记录续查。</small>}
        </div>
      )}
      {data.status === 'failed' && data.errorMessage && kind !== 'unknown' && <p className="wf-error" role="alert">{data.errorMessage}</p>}
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
            onClick={() => handlers.onRerun(id)}
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
      {outputs.map((port, index) => (
        <Handle
          key={port.id}
          type="source"
          id={port.id}
          position={Position.Right}
          style={{ top: 52 + index * 26 }}
          className={`wf-port wf-port-${port.kind}`}
          title={port.label}
        />
      ))}
    </div>
  )
}

function createRenderer(definition: NodeDefinition) {
  const Renderer = ({ id, data }: NodeProps<CanvasNode>) => <NodeShell id={id} data={data} kind={definition.type as NodeKind} />
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
