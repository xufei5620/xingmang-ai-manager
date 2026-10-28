import type { VideoProtocol } from '../lib/video-request-protocol'
import { CommerceTaskControls, inspectCommerceTaskControls } from '../components/CommerceTaskControls'
import { InteriorTaskControls } from '../components/InteriorTaskControls'
import { ExteriorTaskControls } from '../components/ExteriorTaskControls'
import { StoryboardTaskControls } from '../components/StoryboardTaskControls'
import type { TileInputSelection } from '../image-tools/tile-input'
import { inspectVideoReferences } from '../video-tools/video-reference-model'
import { VideoParameterFields } from '../video-tools/VideoParameterFields'
import { VideoCandidatePanel } from '../video-tools/VideoCandidatePanel'
import type { VideoCandidateCount } from '../runtime/video-candidate-count'
import { VideoReferencePanel } from '../video-tools/VideoReferencePanel'
import { inspectVideoNodeParameters, type VideoParameterPatch } from '../video-tools/video-node-parameters'
import type { VideoReferenceOrder } from '../video-tools/video-reference-order'
import { inspectNodeTextOutput, type TextOutputSelection } from '../editor/output-text-nodes'
import { textImageInputModelSupported } from '../runtime/text-image-input'
import { textWebSearchModelSupported } from '../runtime/text-web-search'
import { SafeMarkdownPreview } from '../text-tools/SafeMarkdownPreview'
import { nodeSupportsRunActions } from '../components/node-run-actions'
import { imageMaskConfigurationError } from '../image-tools/image-mask-workflow'
import { imageCandidateCounts, imageCandidateCountNotice, parseImageCandidateCount, type ImageCandidateCount } from '../runtime/image-candidate-count'
import type { PromptReference } from '../library/prompt-references'
import { ComposerPanel } from './ComposerPanel'
import { ImageToolControls } from '../image-tools/ImageToolControls'
import type { LayerPsdApplyInput } from '../image-tools/layer-psd-apply'
import { isImageTransformNodeKind } from '../image-tools/recipe'
import type { OutputImageSelection } from '../editor/output-image-nodes'
import { resolveCanvasAssetDisplayUrl } from '../asset-display-url'
import { createContext, memo, useContext, useEffect, useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { Handle, NodeResizer, NodeToolbar, Position, useConnection, useNodeConnections, type Connection, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '../theme/editor-nodes.css'
import { Copy, FilePlus2, Pencil, Brush, Clapperboard, GitBranch, Globe, Layers3, ScanLine, StickyNote, Box, AlertCircle, AlertTriangle, ArrowRight, ArrowUp, BookmarkPlus, CheckCircle2, Circle, Clock3, Download, Film, FolderOpen, Image as ImageIcon, LoaderCircle, Lock, Maximize2, MoreHorizontal, Music2, Play, RefreshCw, Trash2, Type, Upload, X } from 'lucide-react'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodeDefinition, NodePortDefinition } from '../domain/node-definition'
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
  videoAspectRatioOptions,
  videoModeOptions,
  videoResolutionOptions,
  videoSizeOptions,
  videoModelPreset,
} from '../models'
import { AudioPreview, SafeImage, ViewportVideo, isLocalCanvasAssetUrl } from '../components/MediaPreview'
import { PromptEditor } from '../components/PromptEditor'
import { PhotographyControls } from '../components/PhotographyControls'
import { promptMentionMime } from '../components/prompt-mentions'
import { createCanvasUpstreamReferenceSelector, upstreamReferenceRemovalLabel, type UpstreamMediaReference } from '../components/upstream-references'
import { clipDurationForMediaChip, finiteMediaDurationSeconds, mediaAssetAspectRatio, mediaAssetDurationSeconds, mediaAssetSizeLabel, mediaClipDurationChipLabel, mediaHoverTitle, requestedSizeLabel } from '../library/media-assets'
import { createNodeRendererRegistry } from './node-renderer-registry'
import { composerFieldLabel, composerPromptPlaceholder, composerToolbarFields } from './generation-composer'
import { isMediaResultKind, mediaBoundChipKind, mediaBoundChipLabel, usesMediaBoundLayout } from './media-bound'
import { isMediaSourceKind, portSlotOffsetY } from './port-geometry'
import type { CanvasNodeLod } from './node-lod'
import { nodeResultStagingState } from '../runtime/run-projection'
import { currentNodeCandidates } from '../runtime/current-batch-candidates'
import { createCanvasNodeRenderSelector, type CanvasNodeRenderSnapshot } from './node-render-snapshot'
import { formatRunElapsed, generationElapsedChipLabel, runElapsedMilliseconds } from './run-timing'
import { inspectImageResolutionSelection } from '../runtime/image-resolution-selection'
import { resolveCanvasNodeModelAvailability, type CanvasNodeModelAvailability } from '../library/node-model-availability'
import { NodeModelSourceSelect } from '../components/NodeModelSourceSelect'
import { parseImageReferenceOrder, resolveImageReferenceSlots } from '../commerce/image-reference-order'
import { RouterStrategyControls } from './RouterStrategyControls'
import { canvasNodeKindAvailable, type CanvasCapabilityProfile } from '../host-capabilities'
import { hostCandidateCountChoices, hostFeatureControlShown } from '../components/host-feature-controls'
import { hostNoteTextEditAccepted, hostNoteTextProblem } from '../persistence/host-project-fields'

export interface ComposerReferenceChip {
  key: string
  reference?: UpstreamMediaReference
  inputIndex?: number
}

/** Change display order only; prompt mentions retain their original edge identity. */
export function composerReferenceChips(settings: Record<string, unknown> | undefined, references: readonly UpstreamMediaReference[]): ComposerReferenceChip[] {
  if (settings?.storyboardTask === undefined) return references.map((reference, inputIndex) => ({ key: reference.referenceId ?? reference.mention, reference, inputIndex }))
  try {
    const order = parseImageReferenceOrder(settings.imageReferenceOrder)
    const assigned = new Set<UpstreamMediaReference>()
    const configured = resolveImageReferenceSlots(references, order).map(({ slot, reference }, inputIndex): ComposerReferenceChip => {
      const exact = reference?.kind === 'image' && 'edgeId' in slot && reference.edgeId === slot.edgeId && (reference.outputIndex ?? 0) === slot.outputIndex ? reference : undefined
      if (exact) assigned.add(exact)
      return { key: `storyboard-slot:${inputIndex}`, reference: exact, inputIndex }
    })
    return [...configured, ...references.filter((reference) => !assigned.has(reference)).map((reference) => ({ key: `unassigned:${reference.referenceId ?? reference.mention}`, reference }))]
  } catch {
    // Invalid metadata is reported by the task controls. Do not invent an
    // input number from edge insertion order while it is unresolved.
    return references.map((reference) => ({ key: reference.referenceId ?? reference.mention, reference }))
  }
}

export function ModelSuggestions() {
  return (
    <datalist id="wf-video-models">
      {presetVideoModels.map((model) => <option key={model} value={model} />)}
    </datalist>
  )
}

interface CanvasModelAvailability extends CanvasNodeModelAvailability {}

const CanvasModelAvailabilityContext = createContext<CanvasModelAvailability>({
  connected: false,
  imageModels: [],
  videoModels: [],
  textModels: [],
})

export function CanvasModelAvailabilityProvider({
  connected,
  videoProtocol,
  imageModels,
  videoModels,
  textModels,
  imageModel,
  videoModel,
  textModel,
  sourceCatalog,
  sourceGroups,
  children,
}: CanvasModelAvailability & { children: ReactNode }) {
  const value = useMemo(() => ({ connected, videoProtocol, imageModels, videoModels, textModels, imageModel, videoModel, textModel, sourceCatalog, sourceGroups }), [connected, videoProtocol, imageModels, videoModels, textModels, imageModel, videoModel, textModel, sourceCatalog, sourceGroups])
  return (
    <CanvasModelAvailabilityContext.Provider value={value}>
      {children}
    </CanvasModelAvailabilityContext.Provider>
  )
}

// capabilities: the host's profile. Omitted, every node kind is shown as runnable.
const CanvasNodeViewContext = createContext<{ lod: CanvasNodeLod; editorScope: string; readOnly?: boolean; canRun?: boolean; outputPendingNodeIds?: ReadonlySet<string>; composerFollowNode?: boolean; composerCollapsed?: boolean; onComposerCollapsedChange?(value: boolean): void; capabilities?: CanvasCapabilityProfile }>({ lod: 'detail', editorScope: '' })

export function CanvasNodeViewProvider({ lod, editorScope = '', readOnly, canRun, outputPendingNodeIds, composerFollowNode, composerCollapsed, onComposerCollapsedChange, capabilities, children }: { lod: CanvasNodeLod; editorScope?: string; readOnly?: boolean; canRun?: boolean; outputPendingNodeIds?: ReadonlySet<string>; composerFollowNode?: boolean; composerCollapsed?: boolean; onComposerCollapsedChange?(value: boolean): void; capabilities?: CanvasCapabilityProfile; children: ReactNode }) {
  const value = useMemo(() => ({ lod, editorScope, readOnly, canRun, outputPendingNodeIds, composerFollowNode, composerCollapsed, onComposerCollapsedChange, capabilities }), [lod, editorScope, readOnly, canRun, outputPendingNodeIds, composerFollowNode, composerCollapsed, onComposerCollapsedChange, capabilities])
  return <CanvasNodeViewContext.Provider value={value}>{children}</CanvasNodeViewContext.Provider>
}

export type CanvasNode = Node<WorkflowNodeData & Record<string, unknown>, NodeKind> & {
  definitionVersion: number
  disabled?: boolean
  unknownKind?: string
}

const CanvasUpstreamReferencesContext = createContext<ReadonlyMap<string, readonly UpstreamMediaReference[]>>(new Map())
const CanvasAssetCatalogContext = createContext<readonly CanvasAssetSummary[]>([])
const CanvasNodeRenderContext = createContext<ReadonlyMap<string, CanvasNodeRenderSnapshot> | null>(null)

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
  const selectReferences = useMemo(createCanvasUpstreamReferenceSelector, [])
  const selectNodeContent = useMemo(createCanvasNodeRenderSelector, [])
  const references = useMemo(() => selectReferences(nodes, edges, assets), [assets, edges, nodes, selectReferences])
  const nodeContent = useMemo(() => selectNodeContent(nodes), [nodes, selectNodeContent])
  return <CanvasNodeRenderContext.Provider value={nodeContent}><CanvasAssetCatalogContext.Provider value={assets}><CanvasUpstreamReferencesContext.Provider value={references}>{children}</CanvasUpstreamReferencesContext.Provider></CanvasAssetCatalogContext.Provider></CanvasNodeRenderContext.Provider>
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
  onSourceChange?(nodeId: string, group: string | undefined): void
  onSelectNode?(nodeId: string): void
  onEditCommerceTask?(nodeId: string, editorScope: string): void
  onCompareCommerceCandidates?(nodeId: string, editorScope: string): void
  onEditStoryboardTask?(nodeId: string, editorScope: string): void
  onCompareStoryboardCandidates?(nodeId: string, editorScope: string): void
  onEditExteriorTask?(nodeId: string, editorScope: string): void
  onCompareExteriorCandidates?(nodeId: string, editorScope: string): void
  onEditInteriorTask?(nodeId: string, editorScope: string): void
  onCompareInteriorCandidates?(nodeId: string, editorScope: string): void
  onPromptChange(nodeId: string, prompt: string, promptReferences?: PromptReference[], editorScope?: string): void
  onPromptInsert(nodeId: string, prompt: string, promptReferences?: PromptReference[], editorScope?: string): void
  onPromptCommit(nodeId: string, prompt: string, promptReferences?: PromptReference[], editorScope?: string): void
  onModelChange(nodeId: string, model: string): void
  onVideoParametersChange?(nodeId: string, patch: VideoParameterPatch): void
  onVideoParametersReset?(nodeId: string): void
  onVideoReferenceRemove?(nodeId: string, edgeId: string): void
  onVideoReferenceOrderChange?(nodeId: string, order: VideoReferenceOrder): void
  onTextWebSearchChange?(nodeId: string, enabled: boolean): void
  onSelectVideoFrame?(nodeId: string): void
  onQualityChange(nodeId: string, quality: string): void
  onImageResolutionChange(nodeId: string, imageResolution: '1K' | '2K' | '4K'): void
  onImageCandidateCountChange(nodeId: string, imageCandidateCount: ImageCandidateCount): void
  onVideoCandidateCountChange?(nodeId: string, videoCandidateCount: VideoCandidateCount): void
  onPlaceVideoCandidate?(nodeId: string, candidateId: string): void
  onSizeChange(nodeId: string, size: string): void
  onSecondsChange(nodeId: string, seconds: string): void
  onSettingsChange(nodeId: string, patch: Record<string, unknown>): void
  onTileSettingsChange?(nodeId: string, patch: Record<string, unknown>, editorScope: string, expectedInputScope: string): void
  onDownloadTileSource?(nodeId: string, selection: TileInputSelection, editorScope: string, expectedInputScope: string): Promise<void>
  onAnnotateImage?(nodeId: string): void
  onEditImageMask?(nodeId: string, from: 'input' | 'output'): void
  onLayerPsdApply?(nodeId: string, input: LayerPsdApplyInput, editorScope: string): void
  onTextAction?(nodeId: string, selection: TextOutputSelection, action: 'open' | 'copy' | 'download' | 'place' | 'preset'): void
  onSavePromptPreset(nodeId: string): void
  onRunToNode(nodeId: string): void
  onPlaceOutput?(nodeId: string, selection: OutputImageSelection): void
  onProcessAndPlaceOutput?(nodeId: string): void
  onRunFromNode(nodeId: string): void
  onDeleteNode(nodeId: string): void
  onDownloadAsset(nodeId: string): void
  onShowAssetMenu(nodeId: string): void
  onResumeTask(nodeId: string): void
  /** 切换候选就是切换产物；旧模型里的采纳/丢弃两步已取消。 */
  onSelectCandidate(nodeId: string, candidateId: string): void
  onShowCandidateMenu(assetId: string): void
  onBindAsset(nodeId: string, assetId: string): void
  onPickAsset(nodeId: string): void
  onImportAssetFile(nodeId: string, file: File): void
  onPreviewAsset(asset: AssetRef): void
  onDisconnectIncoming(edgeId: string): void
  onMediaMetadata(nodeId: string, assetId: string, width: number, height: number, durationSeconds?: number): void
  onDramaAction(nodeId: string, action: 'compile-sheet' | 'place-image' | 'compile-shot' | 'toggle-lock'): void
  /**
   * Whether a port would accept the connection currently being dragged. Lives
   * here rather than in the port component because only App holds the graph.
   */
  isPortCompatible(connection: Connection): boolean
}

let handlers: NodeChangeHandlers = {
  onPromptChange: () => undefined,
  onPromptInsert: () => undefined,
  onPromptCommit: () => undefined,
  onModelChange: () => undefined,
  onQualityChange: () => undefined,
  onImageResolutionChange: () => undefined,
  onImageCandidateCountChange: () => undefined,
  onSizeChange: () => undefined,
  onSecondsChange: () => undefined,
  onSettingsChange: () => undefined,
  onSavePromptPreset: () => undefined,
  onRunToNode: () => undefined,
  onRunFromNode: () => undefined,
  onDeleteNode: () => undefined,
  onDownloadAsset: () => undefined,
  onShowAssetMenu: () => undefined,
  onResumeTask: () => undefined,
  onSelectCandidate: () => undefined,
  onShowCandidateMenu: () => undefined,
  onBindAsset: () => undefined,
  onPickAsset: () => undefined,
  onImportAssetFile: () => undefined,
  onPreviewAsset: () => undefined,
  onDisconnectIncoming: () => undefined,
  onMediaMetadata: () => undefined,
  onDramaAction: () => undefined,
  isPortCompatible: () => true,
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

const mediaKindIcon = {
  image: ImageIcon,
  video: Film,
  audio: Music2,
} satisfies Record<AssetRef['kind'], typeof ImageIcon>

function reportPreviewMetadata(nodeId: string, assetId: string | undefined, media: HTMLImageElement | HTMLVideoElement): void {
  if (!assetId) return
  if (media instanceof HTMLVideoElement) {
    handlers.onMediaMetadata(nodeId, assetId, media.videoWidth, media.videoHeight, finiteMediaDurationSeconds(media.duration))
    return
  }
  handlers.onMediaMetadata(nodeId, assetId, media.naturalWidth, media.naturalHeight)
}

function MediaBoundPreview({
  id,
  kind,
  customTitle,
  asset,
  requestedSize,
  durationMs,
  runningStartedAt,
  requestedSeconds,
  replaceable,
  locked = false,
  disabled = false,
  status = 'idle',
  skippedReason,
}: {
  id: string
  kind: string
  customTitle?: string
  asset?: AssetRef
  requestedSize?: string
  durationMs?: number
  runningStartedAt?: string
  requestedSeconds?: string
  replaceable: boolean
  locked?: boolean
  disabled?: boolean
  status?: WorkflowNodeData['status']
  skippedReason?: string
}) {
  const label = customTitle?.trim() || (isMediaSourceKind(kind) ? mediaInputLabel(kind as NodeKind) : mediaBoundChipLabel(kind))
  const expectedAssetKind = isMediaSourceKind(kind)
    ? (kind === 'video-input' ? 'video' : kind === 'audio-input' ? 'audio' : 'image')
    : mediaBoundChipKind(kind)
  const hasAsset = Boolean(asset?.assetId)
  const pending = isMediaResultKind(kind) && !hasAsset
  const previewUrl = asset?.kind === expectedAssetKind && isLocalCanvasAssetUrl(asset.localUrl, expectedAssetKind)
    ? asset.localUrl
    : undefined
  const KindIcon = mediaKindIcon[expectedAssetKind]
  const sizeLabel = mediaAssetSizeLabel(asset) ?? requestedSizeLabel(requestedSize)
  const clipLabel = (expectedAssetKind === 'video' || expectedAssetKind === 'audio')
    ? mediaClipDurationChipLabel(clipDurationForMediaChip(mediaAssetDurationSeconds(asset), requestedSeconds, hasAsset))
    : null
  const elapsedLabel = isMediaResultKind(kind) ? generationElapsedChipLabel(durationMs) : null
  const previewTitle = mediaHoverTitle([sizeLabel, pending ? undefined : '双击放大预览'])
  const acceptDrag = (event: DragEvent<HTMLDivElement>) => {
    if (!replaceable) return
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
        title={previewTitle}
        onLoad={(event) => reportPreviewMetadata(id, asset.assetId, event.currentTarget)}
        onDoubleClick={(event) => { event.stopPropagation(); handlers.onPreviewAsset(asset) }}
      />
    : previewUrl && asset?.kind === 'video'
      ? <ViewportVideo
          className="wf-input-preview wf-preview wf-input-preview-video"
          src={previewUrl}
          aria-label={`${label}素材预览`}
          canvasPlayback
          draggable={false}
          style={{ aspectRatio: mediaAssetAspectRatio(asset) }}
          title={previewTitle}
          onLoadedMetadata={(event) => reportPreviewMetadata(id, asset.assetId, event.currentTarget)}
          onDoubleClick={(event) => { event.stopPropagation(); handlers.onPreviewAsset(asset) }}
        />
      : previewUrl && asset?.kind === 'audio'
        ? <div className="wf-input-preview wf-preview wf-input-preview-audio"><AudioPreview className="nodrag" src={previewUrl} /></div>
        : hasAsset
          ? <span className="wf-input-preview media-unavailable" role="img" aria-label={`${label}素材不可用`}><Upload size={16} aria-hidden="true" /><span>素材不可用</span></span>
          : pending
            ? <span className="wf-media-pending" role="status"><KindIcon size={28} aria-hidden="true" /><strong>{skippedReason ? '已跳过' : status === 'failed' ? '生成未完成' : status === 'running' || status === 'queued' ? '正在准备作品' : '画面从这里开始'}</strong><small>{skippedReason || (status === 'failed' ? '检查失败原因后重试' : status === 'running' || status === 'queued' ? '完成后会在这里显示' : '选中节点，编辑提示词和模型')}</small></span>
            : null
  return (
    <div
      className={`wf-drop-target${hasAsset ? ' has-asset' : pending ? ' is-pending' : ' nodrag'}`}
      onDragOver={acceptDrag}
      onDragLeave={(event) => event.currentTarget.classList.remove('is-drag-over')}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.classList.remove('is-drag-over')
        if (!replaceable) return
        const assetId = event.dataTransfer.getData('application/x-xingmang-asset-id')
        if (assetId) handlers.onBindAsset(id, assetId)
        else if (event.dataTransfer.files[0]) handlers.onImportAssetFile(id, event.dataTransfer.files[0])
      }}
      onContextMenu={(event) => {
        const preview = event.target instanceof Element ? event.target.closest('.wf-preview') : null
        // The preview owns asset actions; the type chip and node frame keep
        // the node menu, including copying an unselected media node.
        if (!hasAsset || !preview || !event.currentTarget.contains(preview)) return
        event.preventDefault()
        event.stopPropagation()
        handlers.onShowAssetMenu(id)
      }}
    >
      {preview}
      {replaceable && !hasAsset && <Upload size={16} aria-hidden="true" />}
      {replaceable && !hasAsset && <span>{`拖入${label}素材或从文件选择`}</span>}
      {replaceable && !hasAsset && <button type="button" className="wf-pick-asset" title={`${expectedAssetKind === 'video' ? 'MP4 视频' : expectedAssetKind === 'audio' ? 'MP3、WAV 音频' : 'PNG、JPEG、WebP 图片'} · 单个素材最多 32 MB`} onClick={() => handlers.onPickAsset(id)}>
        <FolderOpen size={13} aria-hidden="true" />从文件选择
      </button>}
      {/* A bound media node has no header, so the type chip is the only place
          the kind can be read at a glance. The hue is the port hue, so the chip
          and the wire leaving the node say the same thing. Keep the type chip
          at every zoom: hiding it with the summary LOD made a still-readable
          picture look unlabeled. Pixel size stays hover-only. */}
      {(pending || (hasAsset && previewUrl)) && (
        <div className="wf-media-chips">
          <span className={`wf-media-kind is-${expectedAssetKind}`}><KindIcon size={12} aria-hidden="true" />{label}</span>
          {sizeLabel && <span className="wf-media-size">{sizeLabel}</span>}
        </div>
      )}
      {hasAsset && (locked || disabled) && <div className="wf-media-state-badges" aria-label="节点状态">
        {locked && <span className="wf-locked"><Lock size={10} aria-hidden="true" />已锁定</span>}
        {disabled && <span className="wf-disabled">{skippedReason ? `已跳过：${skippedReason}` : '已禁用'}</span>}
      </div>}
      {(runningStartedAt || elapsedLabel || clipLabel) && (
        <div className="wf-media-readouts" aria-label="生成耗时与素材时长">
          {isMediaResultKind(kind) && runningStartedAt
            ? <MediaDurationChip live startedAt={runningStartedAt} kind="elapsed" />
            : elapsedLabel
              ? <MediaDurationChip label={elapsedLabel} kind="elapsed" />
              : null}
          {clipLabel ? <MediaDurationChip label={clipLabel} kind="clip" /> : null}
        </div>
      )}
      {!previewUrl && hasAsset && <small className="wf-input-preview-hint">素材引用无效，请重新选择</small>}
    </div>
  )
}

function supportsPrompt(kind: NodeKind): boolean {
  return ['text', 'prompt', 'text-generate', 'image', 'video', 'image-generate', 'image-edit', 'video-generate', 'drama-script'].includes(kind)
}

function supportsModel(kind: NodeKind): boolean {
  return ['text-generate', 'image', 'video', 'image-generate', 'image-edit', 'video-generate'].includes(kind)
}

function multiInputHint(kind: NodeKind): string | null {
  if (kind === 'text-generate') return '可接文本与最多 4 张图片，和本节点指令一起发送；图片需要已确认支持视觉输入的文字模型，未知模型请换模或移除图片。生成结果通过文本端口传给下游'
  if (kind === 'image-edit' || kind === 'image-generate' || kind === 'image') {
    return '文本、图片前置节点均可多连 · 接上参考图后自动走图像编辑，最多 4 张'
  }
  if (kind === 'video-generate' || kind === 'video') return '文本、图片、音频均可多连 · MiniMax 最多使用 9 图、3 音频，合计 12 个素材'
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

function MediaDurationChip({
  label,
  live = false,
  startedAt,
  kind,
}: {
  label?: string
  live?: boolean
  startedAt?: string
  kind: 'elapsed' | 'clip'
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [live, startedAt])
  const text = live ? `耗时 ${formatRunElapsed(runElapsedMilliseconds(startedAt, now))}` : label
  if (!text) return null
  return (
    <time
      className={`wf-media-duration is-${kind}`}
      dateTime={startedAt}
      title={kind === 'elapsed' ? (live ? '本次生成已用时间' : '上次生成耗时') : '素材播放时长'}
    >{text}</time>
  )
}

/**
 * The bar that floats under a bound media node while it is selected. The node
 * itself shows nothing but the picture, so every command lives here rather than
 * as chrome the user has to look at all day.
 *
 * The two run commands are conditional on purpose. A media source node has no
 * input ports and its asset was imported rather than generated, so "run" and
 * "regenerate" have nothing to act on there; they appear for any media kind
 * that can actually execute. Icon-only with Chinese titles keeps the bar
 * narrower than the node it hangs from.
 */
function TextNodeActions({ id, kind, data, selection }: { id: string; kind: string; data: WorkflowNodeData; selection: TextOutputSelection }) {
  const { capabilities } = useContext(CanvasNodeViewContext)
  const output = inspectNodeTextOutput(kind, data, selection, hostFeatureControlShown(capabilities, 'fileDownload'))
  const result = selection === 'result'
  const resultLabel = kind === 'output' ? '文字结果' : '生成结果'
  return <div className="wf-text-actions nodrag nowheel" role="toolbar" aria-label={result ? `${resultLabel}操作` : '文本编辑操作'}>
    <button type="button" disabled={result && !output.available} onClick={() => handlers.onTextAction?.(id, selection, 'open')} title={result ? '预览、复制或复用完整结果' : '全文编辑、Markdown 预览与分屏'}><Maximize2 size={13} />{result ? '展开结果' : '编辑全文'}</button>
    <button type="button" disabled={!output.canCopy} aria-label={result ? `复制${resultLabel}` : '复制文本正文'} title={output.reason || '复制完整正文到剪贴板'} onClick={() => handlers.onTextAction?.(id, selection, 'copy')}><Copy size={13} /><span>复制</span></button>
    {hostFeatureControlShown(capabilities, 'fileDownload') && <button type="button" disabled={!output.canCopy} aria-label={result ? `下载${resultLabel} TXT` : '下载文本 TXT'} title="下载完整 UTF-8 文本" onClick={() => handlers.onTextAction?.(id, selection, 'download')}><Download size={13} /><span>TXT</span></button>}
    {result && <button type="button" disabled={!output.canPlace} title={output.canPlace ? '保留原结果，创建可编辑的独立文本节点' : output.reason} onClick={() => handlers.onTextAction?.(id, selection, 'place')}><FilePlus2 size={13} />另存文本</button>}
    {result && <button type="button" disabled={!output.canSavePreset} title={output.presetReason || '把结果正文保存到创意工坊'} onClick={() => handlers.onTextAction?.(id, selection, 'preset')}><BookmarkPlus size={13} />存为提示词</button>}
  </div>
}

function TextResultContent({ id, kind, data }: { id: string; kind: string; data: WorkflowNodeData }) {
  const { capabilities } = useContext(CanvasNodeViewContext)
  const downloadable = hostFeatureControlShown(capabilities, 'fileDownload')
  const output = inspectNodeTextOutput(kind, data, 'result', downloadable)
  const label = kind === 'output' ? '输出文字结果' : '文字生成结果'
  return <div className="nodrag nowheel">
    <div className="wf-text-output"><span>{output.stale ? `${output.label}（输入已变化）` : output.label}<small>{data.outputText?.length ?? 0} / 32000 字</small></span>{data.outputText && /\]\(https?:\/\//.test(data.outputText) ? <div className="wf-search-result nodrag nowheel" role="region" aria-label={label} tabIndex={0}><SafeMarkdownPreview value={data.outputText} downloadable={downloadable} /></div> : <textarea aria-label={label} readOnly onDoubleClick={() => { if (output.available) handlers.onTextAction?.(id, 'result', 'open') }} value={data.outputText ?? ''} placeholder="实际运行成功后，文字结果会显示在这里。" />}</div>
    <TextNodeActions id={id} kind={kind} data={data} selection="result" />
  </div>
}

function ProcessedOutputDownload({ id, data }: { id: string; data: WorkflowNodeData }) {
  if (!data.result?.assetId) return null
  return <button type="button" className="wf-output-save" aria-label="另存处理成品" title={data.dirty ? '保存上次成品；不会按新参数重新处理' : '将已保存成品另存到本机，不重新处理'} onClick={() => handlers.onDownloadAsset(id)}><Download size={13} aria-hidden="true" />{data.dirty ? '另存上次成品' : '另存成品'}</button>
}

function MediaNodeToolbar({
  id,
  label,
  asset,
  canRun,
  running,
  locked,
  selected,
}: {
  id: string
  label: string
  asset: AssetRef
  canRun: boolean
  running: boolean
  locked: boolean
  selected: boolean
}) {
  const view = useContext(CanvasNodeViewContext)
  if (!selected) return null
  return (
    <NodeToolbar position={Position.Bottom} offset={8} className="wf-node-toolbar wf-media-toolbar" role="toolbar" aria-label={`${label}素材操作`}>
      {canRun && (
        <button type="button" title="运行此节点：执行该节点及其所需上游" aria-label="运行此节点" disabled={running} onClick={() => handlers.onRunToNode(id)}>
          <Play size={14} aria-hidden="true" />
        </button>
      )}
      {canRun && (
        <button type="button" title="重新生成：重跑该节点并刷新下游" aria-label="重新生成" disabled={running} onClick={() => handlers.onRunToNode(id)}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      )}
      <button type="button" title="重新执行此节点、下游链路及必要依赖；固定成品请先另存为图片节点" aria-label="从此向后运行" disabled={running || view.canRun === false} onClick={() => handlers.onRunFromNode(id)}>
        <ArrowRight size={14} aria-hidden="true" />
      </button>
      {asset.kind === 'image' && handlers.onAnnotateImage && <button type="button" title="画线、写字与添加说明标签" aria-label="标注图片" disabled={running || locked} onClick={() => handlers.onAnnotateImage?.(id)}><Pencil size={14} aria-hidden="true" /></button>}
      {asset.kind === 'image' && hostFeatureControlShown(view.capabilities, 'imageEditMask') && <button type="button" title="涂抹区域，创建局部修改节点" aria-label="局部修改" disabled={running || locked} onClick={() => handlers.onEditImageMask?.(id, 'output')}><Brush size={14} aria-hidden="true" /></button>}
      <button type="button" title={`放大${label}预览`} aria-label={`放大${label}预览`} onClick={() => handlers.onPreviewAsset(asset)}>
        <Maximize2 size={14} aria-hidden="true" />
      </button>
      <button type="button" title="另存到本机" aria-label="另存素材" onClick={() => handlers.onDownloadAsset(id)}>
        <Download size={14} aria-hidden="true" />
      </button>
      {/* The reveal command lives in the main process asset menu together with
          copy and save-as; this opens that menu rather than adding a channel. */}
      <button type="button" title="打开素材操作菜单" aria-label="打开素材操作菜单" onClick={() => handlers.onShowAssetMenu(id)}>
        <FolderOpen size={14} aria-hidden="true" />
      </button>
      <button type="button" title={locked ? '节点已锁定，无法替换素材' : `替换${label}素材`} aria-label={`替换${label}素材`} disabled={locked} onClick={() => handlers.onPickAsset(id)}>
        <Upload size={14} aria-hidden="true" />
      </button>
      <button type="button" className="is-danger" title="从画布删除该节点" aria-label="删除节点" onClick={() => handlers.onDeleteNode(id)}>
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </NodeToolbar>
  )
}

function GenerationInfoPanel({
  id,
  kind,
  data,
  title,
  selected,
  canRun,
  running,
  locked,
  modelAvailable,
  selectedModel,
  imageModels,
  videoModels,
  references,
}: {
  id: string
  kind: NodeKind
  data: WorkflowNodeData
  title: string
  selected: boolean
  canRun: boolean
  running: boolean
  locked: boolean
  modelAvailable: boolean
  selectedModel: string
  imageModels: readonly { id: string; label: string }[]
  videoModels: readonly { id: string; label: string }[]
  references: readonly UpstreamMediaReference[]
}) {
  const incoming = useNodeConnections({ id, handleType: 'target' })
  const view = useContext(CanvasNodeViewContext)
  const sourceDefaults = useContext(CanvasModelAvailabilityContext)
  const sourceAvailability = resolveCanvasNodeModelAvailability(kind, data, sourceDefaults)
  const { videoProtocol } = sourceAvailability
  if (!selected) return null
  const fields = composerToolbarFields(kind, selectedModel)
  const imageCountChoices = hostCandidateCountChoices(imageCandidateCounts, data.imageCandidateCount ?? 1, view.capabilities?.imageCandidates.maximum)
  const imagePreset = imageModelPreset(selectedModel, view.capabilities)
  const imageResolution = inspectImageResolutionSelection({ model: selectedModel, size: data.size, imageResolution: data.imageResolution }, view.capabilities)
  const imageSize = data.size ?? imagePreset.sizes[0] ?? defaultImageSize
  const commerce = inspectCommerceTaskControls(data.settings, references, selectedModel, data.quality)
  const commerceDerivedSize = commerce.task?.kind === 'material-b'
  const commerceCandidates = currentNodeCandidates(id, kind, data).filter((entry) => entry.asset.kind === 'image')
  const imageSizeSupport = imageResolution.choices.find((choice) => choice.value === '1K')
  const videoPreset = videoModelPreset(selectedModel)
  const isVideo = kind === 'video' || kind === 'video-generate'
  const videoError = isVideo ? [...inspectVideoNodeParameters(data, selectedModel, videoProtocol, references.filter((item) => item.kind === 'image').length).errors, ...inspectVideoReferences({ model: selectedModel, videoProtocol, videoMode: typeof data.settings?.videoMode === 'string' ? data.settings.videoMode : undefined, references, order: data.settings?.videoReferenceOrder as VideoReferenceOrder | undefined }).blockingIssues].join('；') : ''
  const hasImageRefs = references.some((reference) => reference.kind === 'image')
  const composerImageModels = hasImageRefs
    ? imageModels.filter((entry) => imageModelPreset(entry.id).supportsEdits)
    : imageModels
  const editBlocked = !kind.startsWith('video') && hasImageRefs && !imagePreset.supportsEdits
  const maskError = imageMaskConfigurationError(data.settings?.imageEditMask, kind, selectedModel, references.filter((reference) => reference.kind === 'image').map((reference) => ({ ...reference.asset, batch: reference.batch })))
  const submit = () => {
    if (canRun && !running && modelAvailable && !editBlocked && !maskError && !videoError) handlers.onRunToNode(id)
  }
  const textChips = incoming.filter((connection) => (connection.sourceHandle ?? '').startsWith('out:text'))
  const referenceChips = composerReferenceChips(data.settings, references)
  const hasChips = referenceChips.length > 0 || textChips.length > 0
  return (
    <ComposerPanel key={`${view.editorScope}:${id}`} id={id} title={title} follow={view.composerFollowNode === true} collapsed={view.composerCollapsed === true} onCollapsedChange={view.onComposerCollapsedChange}>
      {!modelAvailable && <p className="wf-composer-notice" role="status"><AlertTriangle size={14} aria-hidden="true" />请先在顶部「生成配置」选择可用来源和模型</p>}
      {editBlocked && <p className="wf-composer-notice" role="status"><AlertTriangle size={14} aria-hidden="true" />当前模型不支持参考图，请选择支持编辑的模型</p>}
      {kind === 'image-edit' && hostFeatureControlShown(view.capabilities, 'imageEditMask', data.settings?.imageEditMask !== undefined) && <div className="wf-mask-controls">{hostFeatureControlShown(view.capabilities, 'imageEditMask') && <button type="button" disabled={running || locked} onClick={() => handlers.onEditImageMask?.(id, 'input')}><Brush size={14} />{data.settings?.imageEditMask ? '编辑蒙版' : '添加局部修改蒙版'}</button>}{data.settings?.imageEditMask !== undefined && <button type="button" disabled={running || locked} onClick={() => handlers.onSettingsChange(id, { imageEditMask: undefined })}>移除蒙版</button>}<small>{maskError ?? (data.settings?.imageEditMask ? '涂抹区域待重绘 · 原图保留' : '可选：涂抹需要修改的区域')}</small></div>}
      <CommerceTaskControls settings={data.settings} references={references} model={selectedModel} quality={data.quality} disabled={running || locked || !canRun || view.readOnly} candidateCount={commerceCandidates.length} onEdit={handlers.onEditCommerceTask ? () => handlers.onEditCommerceTask?.(id, view.editorScope) : undefined} onCompare={handlers.onCompareCommerceCandidates ? () => handlers.onCompareCommerceCandidates?.(id, view.editorScope) : undefined} />
      <InteriorTaskControls settings={data.settings} references={references} prompt={data.prompt} disabled={running || locked || !canRun || view.readOnly} candidateCount={commerceCandidates.length} onEdit={handlers.onEditInteriorTask ? () => handlers.onEditInteriorTask?.(id, view.editorScope) : undefined} onCompare={handlers.onCompareInteriorCandidates ? () => handlers.onCompareInteriorCandidates?.(id, view.editorScope) : undefined} />
      <ExteriorTaskControls settings={data.settings} references={references} prompt={data.prompt} disabled={running || locked || !canRun || view.readOnly} requestCandidateCount={data.imageCandidateCount ?? 1} candidateCount={commerceCandidates.length} onEdit={handlers.onEditExteriorTask ? () => handlers.onEditExteriorTask?.(id, view.editorScope) : undefined} onCompare={handlers.onCompareExteriorCandidates ? () => handlers.onCompareExteriorCandidates?.(id, view.editorScope) : undefined} />
      <StoryboardTaskControls settings={data.settings} references={references} prompt={data.prompt} disabled={running || locked || !canRun || view.readOnly} requestCandidateCount={data.imageCandidateCount ?? 1} candidateCount={commerceCandidates.length} onEdit={handlers.onEditStoryboardTask ? () => handlers.onEditStoryboardTask?.(id, view.editorScope) : undefined} onCompare={handlers.onCompareStoryboardCandidates ? () => handlers.onCompareStoryboardCandidates?.(id, view.editorScope) : undefined} />
      <div className="wf-composer-prompt">
        {isVideo && <VideoReferencePanel reorderUnavailableReason={hostFeatureControlShown(view.capabilities, 'referenceOrder') ? undefined : '当前客户端不支持调整素材顺序'} videoProtocol={videoProtocol} model={selectedModel} videoMode={typeof data.settings?.videoMode === 'string' ? data.settings.videoMode : undefined} references={references} order={data.settings?.videoReferenceOrder as VideoReferenceOrder | undefined} disabled={running || locked} disabledReason={locked ? '节点已锁定' : running ? '生成期间暂不能调整素材' : undefined} onOrderChange={(order) => handlers.onVideoReferenceOrderChange?.(id, order)} onPreview={(reference) => { if (reference.asset) handlers.onPreviewAsset(reference.asset) }} onRemove={(edgeId) => handlers.onVideoReferenceRemove?.(id, edgeId)} />}
        {!isVideo && hasChips && (
          <div className="wf-composer-reference-list">
          <p className="wf-composer-reference-summary">参考图片 {references.filter((reference) => reference.kind === 'image').length} 项{data.settings?.storyboardTask ? ' · 按已保存输入顺序；未分配图片不会自动加入请求' : data.settings?.commerceTask || data.settings?.exteriorTask ? ' · 原图与参考图按已保存角色绑定' : kind.startsWith('video') ? '' : ' · 同一素材只传一张，最多 4 张'}{references.some((reference) => reference.batch) ? ' · 整组输入的移除按钮会断开整组' : ''}</p>
          <div className="wf-composer-chips">
            {referenceChips.map(({ key, reference, inputIndex }) => reference ? (
              <span
                key={key}
                className={`wf-composer-chip is-${reference.kind}`}
                data-reference-edge-id={reference.edgeId}
                data-reference-output-index={reference.outputIndex ?? 0}
                draggable
                title={`拖到提示词中插入${reference.label}`}
                onDragStart={(event) => {
                  if (event.target instanceof Element && event.target.closest('button')) {
                    event.preventDefault()
                    return
                  }
                  event.dataTransfer.setData(promptMentionMime, reference.mention)
                  event.dataTransfer.setData('text/plain', reference.mention)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
              >
                {reference.asset?.kind === 'image' && reference.asset.localUrl
                  ? <SafeImage src={reference.asset.localUrl} alt="" draggable={false} />
                  : reference.kind === 'image'
                    ? <ImageIcon size={20} aria-hidden="true" />
                    : reference.kind === 'video'
                      ? <Film size={20} aria-hidden="true" />
                      : <Music2 size={20} aria-hidden="true" />}
                <span className="wf-composer-reference-index" aria-label={inputIndex === undefined ? '尚未分配输入顺序' : `输入顺序 ${inputIndex + 1}`}>{inputIndex === undefined ? '?' : inputIndex + 1}</span>
                <button type="button" title={upstreamReferenceRemovalLabel(reference)} aria-label={upstreamReferenceRemovalLabel(reference)} onClick={() => handlers.onDisconnectIncoming(reference.edgeId)}>
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ) : <span key={key} className="wf-composer-chip is-image is-missing" title={`输入 ${inputIndex! + 1} 图片未绑定，请重新配置故事板`} aria-label={`输入 ${inputIndex! + 1} 图片未绑定`}><ImageIcon size={20} aria-hidden="true" /><span className="wf-composer-reference-index" aria-label={`输入顺序 ${inputIndex! + 1}`}>{inputIndex! + 1}</span></span>)}
            {textChips.map((connection) => (
              <span key={connection.edgeId} className="wf-composer-chip is-text">
                <Type size={20} aria-hidden="true" />
                <button type="button" title="移除文本输入" aria-label="移除文本输入" onClick={() => handlers.onDisconnectIncoming(connection.edgeId)}>
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div></div>
        )}
        {sourceDefaults.connected && handlers.onSourceChange && <NodeModelSourceSelect kind={kind} group={data.group} sources={sourceDefaults.sourceGroups ?? []} disabled={running || locked || ('__canvasDisabled' in data && data.__canvasDisabled === true) || view.readOnly} onChange={(group) => handlers.onSourceChange?.(id, group)} />}
        {data.group !== undefined && <p className="wf-hint" title={data.group}>固定来源：{sourceAvailability.sourceLabel || data.group || '空值（待配置）'}</p>}
        {sourceAvailability.sourceError && <p className="wf-error is-validation" role="status">{sourceAvailability.sourceError}</p>}
        <PromptEditor
          label={`${title}提示词`}
          value={data.prompt}
          promptReferences={data.promptReferences}
          placeholder={composerPromptPlaceholder(kind)}
          references={references}
          rows={4}
          onChange={(prompt, promptReferences) => handlers.onPromptChange(id, prompt, promptReferences, view.editorScope)}
          onInsert={(prompt, promptReferences) => handlers.onPromptInsert(id, prompt, promptReferences, view.editorScope)}
          onCommit={(prompt, promptReferences) => handlers.onPromptCommit(id, prompt, promptReferences, view.editorScope)}
          onSubmit={submit}
        />
      </div>
      {!commerceDerivedSize && selectedModel && fields.includes('imageResolution') && imageResolution.message && <p className="wf-error is-validation" role="status"><AlertTriangle size={13} aria-hidden="true" />{imageResolution.message}</p>}
      {fields.includes('imageCandidateCount') && imageCountChoices.length > 1 && <p className="wf-result-note">{imageCandidateCountNotice(data.imageCandidateCount ?? 1)}</p>}
      {isVideo && <VideoParameterFields imageCount={references.filter((item) => item.kind === 'image').length} videoProtocol={videoProtocol} model={selectedModel} data={data} disabled={running || locked || !canRun} compact onChange={(patch) => handlers.onVideoParametersChange?.(id, patch)} onReset={() => handlers.onVideoParametersReset?.(id)} onCandidateCountChange={(count) => handlers.onVideoCandidateCountChange?.(id, count)} candidateCountMaximum={view.capabilities?.videoCandidates.maximum} generateAudioShown={hostFeatureControlShown(view.capabilities, 'generateAudio', data.settings?.generateAudio !== undefined)} />}
      <div className="wf-composer-footer">
        <div className="wf-composer-toolbar">
        {fields.includes('model') && (
          <label className="wf-composer-field">
            <select
              className="wf-composer-select"
              aria-label={kind.startsWith('video') ? '视频模型' : '图像模型'}
              disabled={running || locked}
              title={composerFieldLabel('model')}
              value={selectedModel}
              onChange={(event) => handlers.onModelChange(id, event.target.value)}
            >
              {(!modelAvailable || editBlocked) && <option value={selectedModel} disabled>{(kind.startsWith('video') ? videoPreset : imagePreset).label}{editBlocked ? '（不支持参考图编辑）' : '（当前分组不可用）'}</option>}
              {(kind.startsWith('video') ? videoModels : composerImageModels).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </select>
          </label>
        )}

        {fields.includes('imageResolution') && (
          <label className="wf-composer-field">
            <select
              className="wf-composer-select"
              aria-label="生成清晰度"
              disabled={commerceDerivedSize || !selectedModel}
              title={composerFieldLabel('imageResolution')}
              value={imageResolution.value}
              onChange={(event) => handlers.onImageResolutionChange(id, event.target.value as '1K' | '2K' | '4K')}
            >
              {!selectedModel ? <option value={imageResolution.value}>{imageResolution.value}</option> : imageResolution.choices.map((entry) => (
                <option key={entry.value} value={entry.value} disabled={!entry.supported} title={entry.reason ?? entry.effectiveSize}>
                  {imageResolution.providerSized && entry.value === '1K' ? '由服务决定' : entry.value}{entry.supported ? '' : '（当前组合不支持）'}
                </option>
              ))}
            </select>
          </label>
        )}
        {fields.includes('size') && !kind.startsWith('video') && (
          <label className="wf-composer-field">
            <select className="wf-composer-select" aria-label="生成尺寸" disabled={commerceDerivedSize || !selectedModel} title={composerFieldLabel('size', kind)} value={imageSize} onChange={(event) => handlers.onSizeChange(id, event.target.value)}>
              {!imagePreset.sizes.includes(imageSize) && <option value={imageSize} disabled={!imageSizeSupport?.supported} title={imageSizeSupport?.reason ?? '保留已保存的尺寸'}>{imageSizeLabel(imageSize)}{imageSizeSupport?.supported ? '（已保存尺寸）' : '（已保存，当前不支持）'}</option>}
              {imagePreset.sizes.map((size) => <option key={size} value={size}>{imageSizeLabel(size)}</option>)}
            </select>
          </label>
        )}
        {fields.includes('imageCandidateCount') && imageCountChoices.length > 1 && (
          <label className="wf-composer-field">
            <select className="wf-composer-select" aria-label="生成数量" title={imageCandidateCountNotice(data.imageCandidateCount ?? 1)} value={data.imageCandidateCount ?? 1} disabled={running} onChange={(event) => handlers.onImageCandidateCountChange(id, parseImageCandidateCount(Number(event.target.value), kind)!)}>
              {imageCountChoices.map((count) => <option key={count} value={count}>×{count}</option>)}
            </select>
          </label>
        )}

        </div>
        {!isVideo && <details className="wf-composer-more">
          <summary>更多参数</summary>
          <div className="wf-composer-more-fields">
        {fields.includes('quality') && (
          <label className="wf-composer-field">
            <select className="wf-composer-select" aria-label="生成画质" title={composerFieldLabel('quality')} value={data.quality || defaultImageQuality} onChange={(event) => handlers.onQualityChange(id, event.target.value)}>
              {imageQualityOptions.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
          </label>
        )}
          </div>
      {!kind.startsWith('video') && <PhotographyControls key={id} prompt={data.prompt} disabled={running} onApply={(prompt) => handlers.onPromptCommit(id, prompt, undefined, view.editorScope)} />}
        </details>}
        <div className="wf-composer-actions">
          <button type="button" className="wf-composer-icon" title="保存为提示词预设" aria-label="保存为提示词预设" onClick={() => handlers.onSavePromptPreset(id)}>
            <BookmarkPlus size={15} aria-hidden="true" />
          </button>
          {data.result && (
            <>
              {data.result.kind === 'image' && handlers.onAnnotateImage && <button type="button" className="wf-composer-icon" title="标注当前候选图片" aria-label="标注图片" disabled={running || locked} onClick={() => handlers.onAnnotateImage?.(id)}><Pencil size={15} aria-hidden="true" /></button>}
              {data.result.kind === 'image' && hostFeatureControlShown(view.capabilities, 'imageEditMask') && <button type="button" className="wf-composer-icon" title="以当前图片另建局部修改节点" aria-label="局部修改" disabled={running || locked} onClick={() => handlers.onEditImageMask?.(id, 'output')}><Brush size={15} aria-hidden="true" /></button>}
              <button type="button" className="wf-composer-icon" title="放大预览" aria-label="放大预览" onClick={() => handlers.onPreviewAsset(data.result!)}>
                <Maximize2 size={15} aria-hidden="true" />
              </button>
              <button type="button" className="wf-composer-icon" title="另存到本机" aria-label="另存素材" onClick={() => handlers.onDownloadAsset(id)}>
                <Download size={15} aria-hidden="true" />
              </button>
            </>
          )}
          <button
            type="button"
            className="wf-composer-send"
            title={
              videoError || maskError || (editBlocked
                ? '当前模型不支持参考图编辑，请换用支持编辑的图像模型'
                : running ? '正在生成' : '重新生成此节点，已完成的上游直接复用。Ctrl+Enter 也可提交')
            }
            aria-label={running ? '正在生成' : data.result ? '重新生成' : '开始生成'}
            disabled={!canRun || running || !modelAvailable || locked || editBlocked || !!maskError || !!videoError}
            onClick={submit}
          >
            {running ? <LoaderCircle size={16} aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}<span>{running ? '生成中' : data.result ? '重新生成' : '开始生成'}</span>
          </button>
        </div>
      </div>
    </ComposerPanel>
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
      <div>{references.map((reference) => <UpstreamReferencePreview key={reference.referenceId ?? reference.mention} reference={reference} />)}</div>
    </section>
  )
}

function NodeSettings({ id, data, kind, readOnly }: { id: string; data: WorkflowNodeData & Record<string, unknown>; kind: NodeKind; readOnly?: boolean }) {
  const { capabilities } = useContext(CanvasNodeViewContext)
  const [refusedNoteEdit, setRefusedNoteEdit] = useState<string>()
  if (kind === 'note') {
    const text = textSetting(data, 'text')
    const problem = capabilities ? hostNoteTextProblem(text, capabilities.project) : undefined
    const notice = problem ? `${problem}，这条便签现在存不进去，改好以后才会保存` : refusedNoteEdit ? `${refusedNoteEdit}，这次输入没有放进去` : undefined
    return (
      <>
        <textarea
          className="nodrag wf-note"
          aria-label="备注内容"
          aria-invalid={problem ? true : undefined}
          value={text}
          placeholder="记录思路、参数或交付说明"
          onChange={(event) => {
            const next = event.target.value
            if (capabilities && !hostNoteTextEditAccepted(text, next, capabilities.project)) { setRefusedNoteEdit(hostNoteTextProblem(next, capabilities.project)); return }
            setRefusedNoteEdit(undefined)
            handlers.onSettingsChange(id, { text: next })
          }}
          rows={5}
        />
        {notice && <p className="wf-error is-validation" role="status"><AlertTriangle size={13} aria-hidden="true" />{notice}</p>}
      </>
    )
  }
  if (kind === 'group') {
    return (
      <div className="wf-group-controls">
        <input
          className="nodrag wf-model"
          value={textSetting(data, 'title', '新建分组')}
          aria-label="分组名称"
          maxLength={160}
          onChange={(event) => handlers.onSettingsChange(id, { title: event.target.value })}
        />
        <button type="button" className="nodrag wf-group-select" aria-label="选择整个分组" onClick={() => handlers.onSelectNode?.(id)}><Layers3 size={14} />选择整组</button>
      </div>
    )
  }
  if (kind === 'image-input' || kind === 'video-input' || kind === 'audio-input') {
    return <MediaBoundPreview id={id} kind={kind} customTitle={textSetting(data, 'title')} asset={data.result} replaceable />
  }
  if (kind === 'frame-extract') {
    return (
      <div className="wf-frame-settings nodrag nowheel"><label className="wf-inline-field">
        <span>时间点</span>
        <input
          type="number"
          aria-label="提取时间点（秒）"
          min="0"
          max="86400"
          step="0.001"
          disabled={data.__canvasDisabled === true || data.__canvasLocked === true || data.status === 'running' || data.status === 'queued'}
          value={numberSetting(data, 'timestampSeconds', 0)}
          onChange={(event) => handlers.onSettingsChange(id, { timestampSeconds: Number(event.target.value) })}
        />
        <span>秒</span>
      </label>{handlers.onSelectVideoFrame && <><button type="button" className="wf-run-node" disabled={data.__canvasDisabled === true || data.__canvasLocked === true || data.status === 'running' || data.status === 'queued'} onClick={() => handlers.onSelectVideoFrame?.(id)}><Film size={14} aria-hidden="true" />选择视频帧</button><p className="wf-result-note">先连接视频，在预览中定位时间点；应用后运行即可保存图片。</p></>}</div>
    )
  }
  if (kind === 'router') {
    // A legacy router already does what a host without strategies does; only a saved strategy needs showing there.
    if (!hostFeatureControlShown(capabilities, 'routerStrategy', Object.hasOwn(data.settings ?? {}, 'routerStrategy'))) return null
    return <RouterStrategyControls settings={data.settings} disabled={readOnly || data.__canvasDisabled === true || data.__canvasLocked === true || data.status === 'running' || data.status === 'queued'} onChange={(patch) => handlers.onSettingsChange(id, patch)} />
  }
  if (kind === 'gallery') {
    const count = data.candidateAssetIds?.length ?? (data.result?.assetId ? 1 : 0)
    const running = data.status === 'queued' || data.status === 'running'
    return <div className="wf-gallery-empty wf-gallery-status nowheel" role="status" aria-live="polite">
      {running ? <>
        <span>{data.status === 'queued' ? '等待上游完成，随后汇总候选…' : '正在汇总上游候选…'}</span>
        <RunningElapsed startedAt={data.runStartedAt} />
      </> : <span>{count > 0 ? `${count} 个候选，点击下方缩略图切换产物` : '运行生成节点后在此汇总候选'}</span>}
    </div>
  }
  if (kind === 'output') {
    const stagingState = nodeResultStagingState(data)
    return <>{typeof data.outputText === 'string' && data.outputText.length > 0 && <TextResultContent id={id} kind={kind} data={data} />}<p className={`wf-result-note is-${stagingState}`}>
      {stagingState === 'accepted' ? '最终产物已就绪' : '连接上游后运行'}
    </p></>
  }
  if (kind === 'unknown') {
    return <p className="wf-error">{data.errorMessage || '当前版本无法识别这个节点'}</p>
  }
  if (kind === 'drama-bible') {
    return (
      <div className="wf-drama-fields nodrag">
        <input className="wf-model" aria-label="风格" value={textSetting(data, 'stylePrompt', data.prompt || '3D漫剧写实厚涂风。')} onChange={(event) => handlers.onSettingsChange(id, { stylePrompt: event.target.value })} />
        <input className="wf-model" aria-label="世界观" placeholder="一句话世界观" value={textSetting(data, 'worldTone')} onChange={(event) => handlers.onSettingsChange(id, { worldTone: event.target.value })} />
        <p className="wf-result-note">把文字口连到分镜。改这里会影响后面每条分镜的画风。</p>
      </div>
    )
  }
  if (kind === 'drama-parse') {
    return <p className="wf-result-note">左边先接「剧本」。点「运行此节点」后弹出四表，确认才会铺角色和分镜，不会自动出图。</p>
  }
  if (kind === 'drama-character' || kind === 'drama-scene' || kind === 'drama-prop') {
    const locked = data.settings?.locked === true
    const preview = data.result?.localUrl
    return (
      <div className="wf-drama-asset nodrag">
        {preview ? <img className="wf-drama-thumb" src={resolveCanvasAssetDisplayUrl(preview)} alt="" /> : <div className="wf-drama-thumb is-empty">待定妆</div>}
        <input className="wf-model" aria-label="名称" value={textSetting(data, 'name')} onChange={(event) => handlers.onSettingsChange(id, { name: event.target.value })} />
        <textarea className="wf-note" aria-label="外貌或形态" rows={3} value={textSetting(data, 'appearance')} placeholder={kind === 'drama-scene' ? '环境与色调' : kind === 'drama-prop' ? '形态命门' : '脸发服一句'} onChange={(event) => handlers.onSettingsChange(id, { appearance: event.target.value })} />
        <label className="wf-video-toggle">
          <input type="checkbox" checked={locked} onChange={() => handlers.onDramaAction(id, 'toggle-lock')} />
          <span>{locked ? '已封板' : '未封板'}</span>
        </label>
        <div className="wf-drama-actions">
          <button type="button" onClick={() => handlers.onDramaAction(id, 'compile-sheet')}>生成定妆提示词</button>
          <button type="button" onClick={() => handlers.onDramaAction(id, 'place-image')}>在右侧添加出图</button>
        </div>
        <p className="wf-result-note">{preview ? (locked ? '已封板，下游分镜可以出图。' : '把定妆图拖回这张卡，再勾选封板。') : '1. 写外貌 2. 生成提示词 3. 添加出图并运行 4. 把图拖回来 5. 封板'}</p>
      </div>
    )
  }
  if (kind === 'drama-shot') {
    const gate = textSetting(data, 'gate', 'blocked')
    return (
      <div className="wf-drama-shot nodrag">
        <p className={`wf-drama-gate is-${gate}`}>{gate === 'blocked' ? '未封板' : gate === 'stale' ? '需重编译' : '可出图'}</p>
        <input className="wf-model" aria-label="镜号" value={textSetting(data, 'shotId')} onChange={(event) => handlers.onSettingsChange(id, { shotId: event.target.value })} />
        <input className="wf-model" aria-label="景别" value={textSetting(data, 'framing')} placeholder="景别" onChange={(event) => handlers.onSettingsChange(id, { framing: event.target.value })} />
        <textarea className="wf-note" aria-label="动作" rows={3} value={textSetting(data, 'action')} placeholder="只写谁在哪做什么，外貌写在角色资产上" onChange={(event) => handlers.onSettingsChange(id, { action: event.target.value })} />
        <button type="button" onClick={() => handlers.onDramaAction(id, 'compile-shot')}>生成分镜提示词</button>
        <p className="wf-result-note">{gate === 'blocked' ? '先把圣经和角色/场景连进来，资产勾选封板后才会变绿。' : '提示词生成后，再在右侧添加图像生成节点并运行。'}</p>
      </div>
    )
  }
  return null
}

function nodeKindIcon(kind: NodeKind) {
  if (kind === 'text' || kind === 'prompt' || kind === 'text-generate') return Type
  if (kind === 'note') return StickyNote
  if (kind === 'group' || kind === 'gallery') return Layers3
  if (kind === 'router') return GitBranch
  if (kind === 'frame-extract') return ScanLine
  if (kind.startsWith('drama-')) return Clapperboard
  if (kind.startsWith('image')) return ImageIcon
  if (kind.startsWith('video')) return Film
  if (kind === 'audio-input') return Music2
  return Box
}

function NodeShell({ id, data: flowData, kind, selected }: { id: string; data: WorkflowNodeData & Record<string, unknown>; kind: NodeKind; selected: boolean }) {
  const defaultModelAvailability = useContext(CanvasModelAvailabilityContext)
  const assetCatalog = useContext(CanvasAssetCatalogContext)
  const { lod, editorScope, readOnly, canRun, outputPendingNodeIds, capabilities } = useContext(CanvasNodeViewContext)
  const upstreamReferences = useContext(CanvasUpstreamReferencesContext).get(id) ?? []
  const nodeContent = useContext(CanvasNodeRenderContext)
  const current = nodeContent?.get(id)
  // React Flow copies controlled nodes into its store in a passive effect.
  // Its synchronous ResizeObserver store notification can flush that effect
  // during delivery, adding a just-completed candidate strip after measurement.
  // Render content and upstream inputs from the same parent commit instead;
  // Flow remains responsible for geometry, selection and ports.
  if (nodeContent && (!current || current.type !== kind)) return null
  const data = current?.data ?? flowData
  const modelAvailability = resolveCanvasNodeModelAvailability(kind, data, defaultModelAvailability)
  const definition = builtinNodeRegistry.resolve(kind) ?? builtinNodeRegistry.require('unknown')
  const displayTitle = textSetting(data, 'title').trim() || definition.title
  const disabled = data.__canvasDisabled === true
  // The run projection retains its legacy status union. Only the precise
  // no-attempt disabled reason identifies a skip; other failures stay visible.
  const disabledSkipped = disabled && data.status === 'failed' && data.errorMessage === '节点已禁用' && data.attemptCount === 0
  const presentedStatus = disabledSkipped ? 'idle' : data.status
  const presentedStatusLabel = disabledSkipped ? '已跳过' : statusLabel[data.status]
  const locked = data.__canvasLocked === true
  const inputs = definition.ports.filter((port) => port.direction === 'input')
  const outputs = definition.ports.filter((port) => port.direction === 'output')
  const portRows = Math.max(inputs.length, outputs.length)
  const inputHint = multiInputHint(kind)
  const imageOperation = kind === 'image' || kind === 'image-generate' || kind === 'image-edit'
  const videoOperation = kind === 'video' || kind === 'video-generate'
  const textOperation = kind === 'text-generate'
  const mediaInput = isMediaSourceKind(kind)
  const processedOutput = isImageTransformNodeKind(kind) || kind === 'frame-extract'
  const imageModels = modelAvailability.connected
    ? availableImageModelPresets(modelAvailability.imageModels, true)
    : [...imageModelPresets]
  const videoModels = modelAvailability.connected
    ? availableVideoModelPresets(modelAvailability.videoModels, true, capabilities)
    : availableVideoModelPresets(presetVideoModels, false, capabilities)
  const selectedModel = data.model || (data.group !== undefined ? '' : textOperation ? modelAvailability.textModel ?? '' : videoOperation ? modelAvailability.videoModel ?? (modelAvailability.connected ? videoModels[0]?.id ?? '' : defaultVideoModel) : modelAvailability.imageModel ?? (modelAvailability.connected ? imageModels[0]?.id ?? '' : imageModelPresets[0].id))
  const commerce = inspectCommerceTaskControls(data.settings, upstreamReferences, selectedModel, data.quality)
  const commerceDerivedSize = commerce.task?.kind === 'material-b'
  const requestedSize = commerceDerivedSize ? commerce.derivedSize : imageOperation ? inspectImageResolutionSelection({ model: selectedModel, size: data.size, imageResolution: data.imageResolution }, capabilities).effectiveSize : videoOperation && modelAvailability.videoProtocol === 'ark-seedance' ? undefined : data.size
  const selectedVideoPreset = videoModelPreset(selectedModel)
  const mediaModelAvailable = !modelAvailability.sourceError && (!modelAvailability.connected || (
    imageOperation
      ? imageModels.some((preset) => preset.id === selectedModel)
      : textOperation ? modelAvailability.textModels.includes(selectedModel) : !videoOperation || videoModels.some((preset) => preset.id === selectedModel)
  ))
  const hostUnsupported = capabilities !== undefined && !canvasNodeKindAvailable(kind, capabilities)
  const canRunNode = canRun !== false && !disabled && !hostUnsupported && nodeSupportsRunActions(kind)
  const imageCountChoices = hostCandidateCountChoices(imageCandidateCounts, data.imageCandidateCount ?? 1, capabilities?.imageCandidates.maximum)
  const nodeRunning = data.status === 'running' || data.status === 'queued'
  const outputPending = outputPendingNodeIds?.has(id) === true
  const candidates = currentNodeCandidates(id, kind, data, assetCatalog)
  const selectedCandidate = candidates.find((candidate) => candidate.asset.assetId === data.result?.assetId)
    ?? candidates.find((candidate) => candidate.candidateId === data.selectedCandidateId)
    ?? candidates.find((candidate) => candidate.candidateId === data.adoptedCandidateId)
    ?? candidates[0]
  const displayedResult = selectedCandidate?.asset ?? data.result
  const StatusIcon = statusIcon[presentedStatus]
  const KindIcon = nodeKindIcon(kind)
  const summaryMode = lod === 'summary' && kind !== 'group' && !selected
  const promptSummary = kind === 'note' ? textSetting(data, 'text') : data.prompt
  const resultSummary = disabledSkipped ? `${data.errorMessage}，本次未执行${data.outputText || displayedResult ? '，保留已有结果' : ''}` : (textOperation || kind === 'output') && data.outputText ? `${textOperation ? '已生成' : '已有'} ${data.outputText.length} 字${data.dirty ? '，输入已变化' : ''}` : displayedResult?.kind === 'image'
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

  if (readOnly) {
    const visibleAsset = displayedResult ?? data.asset
    return <div className={`wf-node wf-editor-node wf-node-${kind} wf-readonly-node`}>
      <header><strong>{displayTitle}</strong><span>只读</span></header>
      {data.prompt && <textarea className="nodrag nowheel" aria-label={`${displayTitle}正文`} readOnly value={data.prompt} />}
      {kind === 'note' && <p className="nodrag nowheel">{textSetting(data, 'text')}</p>}
      {data.outputText && <div className="nodrag nowheel"><SafeMarkdownPreview value={data.outputText} downloadable={hostFeatureControlShown(capabilities, 'fileDownload')} /><button type="button" onClick={() => handlers.onTextAction?.(id, 'result', 'open')}>阅读全文</button></div>}
      {processedOutput && data.result?.assetId && <div className="wf-output-placement nodrag" aria-label="处理成品操作"><ProcessedOutputDownload id={id} data={data} /></div>}
      {visibleAsset && <MediaBoundPreview id={id} kind={kind} asset={visibleAsset} replaceable={false} locked status={data.status} skippedReason={disabledSkipped ? data.errorMessage : undefined} />}
      {visibleAsset && <div className="wf-readonly-actions nodrag"><button type="button" onClick={() => handlers.onPreviewAsset(visibleAsset)}>预览素材</button>{!(processedOutput && data.result?.assetId) && <button type="button" onClick={() => visibleAsset.assetId && handlers.onShowCandidateMenu(visibleAsset.assetId)}>下载素材</button>}</div>}
      {candidates.length > 1 && <div className="wf-candidate-strip nodrag nowheel">{candidates.map((candidate, index) => <button key={candidate.candidateId} type="button" onClick={() => handlers.onPreviewAsset(candidate.asset)}>预览候选 {index + 1}</button>)}</div>}
      {data.settings && <details className="nodrag nowheel"><summary>查看参数</summary><pre>{JSON.stringify(data.settings, null, 2)}</pre></details>}
      {inputs.map((port, index) => <PortHandle key={port.id} nodeId={id} port={port} index={index} />)}
      {outputs.map((port, index) => <PortHandle key={port.id} nodeId={id} port={port} index={index} />)}
    </div>
  }

  if (usesMediaBoundLayout(kind, displayedResult?.assetId)) {
    const output = outputs[0]
    const mediaKind = displayedResult?.kind ?? mediaBoundChipKind(kind)
    return (
      <div className={`wf-node wf-editor-node wf-media-bound wf-media-bound-${mediaKind}${imageOperation && candidates.length ? ' has-image-candidates' : ''}${videoOperation && (candidates.length || data.videoBatchProgress) ? ' has-video-candidates' : ''}${disabled ? ' wf-is-disabled' : ''}${locked ? ' wf-is-locked' : ''}`}>
        {/* Media is the whole point of these nodes, so let the user scale the
            preview. Aspect is locked because the asset's is fixed, and the
            control only appears while selected to keep the canvas calm. */}
        {!locked && (
          <NodeResizer
            isVisible={selected}
            keepAspectRatio={mediaKind !== 'audio'}
            minWidth={160}
            minHeight={mediaKind === 'audio' ? 88 : 120}
            maxWidth={720}
            maxHeight={720}
            lineClassName="wf-resize-line"
            handleClassName="wf-resize-handle"
          />
        )}
        {isMediaSourceKind(kind) && displayedResult ? (
          <MediaNodeToolbar
            id={id}
            label={mediaInputLabel(kind)}
            asset={displayedResult}
            canRun={canRunNode}
            running={nodeRunning}
            locked={locked}
            selected={selected}
          />
        ) : !isMediaSourceKind(kind) ? (
          <GenerationInfoPanel
            id={id}
            kind={kind}
            data={data}
            title={displayTitle}
            selected={selected}
            canRun={canRunNode}
            running={nodeRunning}
            locked={locked}
            modelAvailable={mediaModelAvailable}
            selectedModel={selectedModel}
            imageModels={imageModels}
            videoModels={videoModels}
            references={upstreamReferences}
          />
        ) : null}
        <MediaBoundPreview
          customTitle={textSetting(data, 'title')}
          id={id}
          kind={kind}
          asset={displayedResult}
          requestedSize={requestedSize}
          requestedSeconds={data.seconds}
          durationMs={data.latestAttemptDurationMs}
          runningStartedAt={nodeRunning ? data.runStartedAt : undefined}
          replaceable={mediaInput && !locked && !disabled}
          locked={locked}
          disabled={disabled}
          status={data.status}
          skippedReason={disabledSkipped ? data.errorMessage : undefined}
        />
        {imageOperation && candidates.length > 0 && <div className="wf-media-candidates wf-candidate-strip nodrag nowheel" aria-label="生成候选">
          {candidates.map((candidate, index) => <button key={candidate.candidateId} type="button" className={candidate.candidateId === selectedCandidate?.candidateId ? 'is-selected' : ''} title={`预览候选 ${index + 1}`} aria-label={`预览候选 ${index + 1}`} aria-pressed={candidate.candidateId === selectedCandidate?.candidateId} onClick={() => handlers.onSelectCandidate(id, candidate.candidateId)} onDoubleClick={(event) => { event.stopPropagation(); handlers.onPreviewAsset(candidate.asset) }}>
            {candidate.asset.kind === 'image' && candidate.asset.localUrl ? <SafeImage src={candidate.asset.localUrl} alt="" fallbackLabel="候选不可用" /> : <span>{index + 1}</span>}
          </button>)}
        </div>}
        {videoOperation && (candidates.length > 0 || data.videoBatchProgress) && <VideoCandidatePanel candidates={candidates} selectedCandidateId={selectedCandidate?.candidateId} progress={data.videoBatchProgress} status={data.status} disabledReason={locked ? '节点已锁定，可预览已保存的视频' : disabled ? '节点已禁用，可预览已保存的视频' : nodeRunning ? '生成期间可预览已保存视频，完成后再切换产物' : outputPending ? '正在另存视频，请稍候' : undefined} onSelect={(candidateId) => handlers.onSelectCandidate(id, candidateId)} onPreview={handlers.onPreviewAsset} onDownload={selectedCandidate?.asset.assetId === data.result?.assetId ? () => handlers.onDownloadAsset(id) : undefined} onPlace={(candidateId) => handlers.onPlaceVideoCandidate?.(id, candidateId)} />}
        {data.status === 'failed' && !disabledSkipped && <div className="wf-media-failure nodrag nowheel" role="alert"><AlertCircle size={14} aria-hidden="true" /><span><strong>生成失败</strong><span>{data.errorMessage || '本次生成未完成，请重试'}</span></span></div>}
        {nodeRunning && (
          <div className="wf-media-state-badges" aria-label="正在生成">
            <span className="wf-status wf-status-running"><LoaderCircle size={10} aria-hidden="true" />{statusLabel[data.status]}</span>
          </div>
        )}
        {inputs.map((port, index) => (
          <PortHandle key={port.id} nodeId={id} port={port} index={index} />
        ))}
        {output && <PortHandle nodeId={id} port={output} index={0} centered />}
      </div>
    )
  }

  return (
    <div
      className={`wf-node wf-editor-node wf-node-${kind} wf-category-${definition.category} wf-status-${presentedStatus}${data.dirty ? ' wf-is-dirty' : ''}${data.fromCache && data.status === 'succeeded' && !data.dirty ? ' wf-is-cached' : ''}${disabled ? ' wf-is-disabled' : ''}${locked ? ' wf-is-locked' : ''}${summaryMode ? ' wf-lod-summary' : ''}`}
      // Content determines ordinary node height, but absolute-positioned ports
      // also need room. Keep the last port above the clipped bottom edge.
      style={kind !== 'group' && portRows > 0 ? { minHeight: portSlotOffsetY(portRows - 1) + 12 } : undefined}
    >
      {inputs.map((port, index) => (
        <PortHandle key={port.id} nodeId={id} port={port} index={index} />
      ))}
      <header>
        <span className="wf-node-kind" aria-hidden="true"><KindIcon size={16} /></span>
        {/* Both lines ellipsize, so the full text must stay reachable. */}
        <span className="wf-node-title">
          <strong title={displayTitle}>{displayTitle}</strong>
          <small title={definition.description}>{definition.description}</small>
        </span>
        <span className="wf-head-right">
          {supportsPrompt(kind) && data.prompt.trim() && (
            <button type="button" className="nodrag wf-icon-command" title="保存为提示词预设" aria-label="保存为提示词预设" onClick={() => handlers.onSavePromptPreset(id)}><BookmarkPlus size={14} /></button>
          )}
          {data.status === 'idle'
            ? <span className="wf-status-idle-dot" title="待运行" aria-label="待运行" />
            : <span className={`wf-status wf-status-${presentedStatus}`}><StatusIcon size={12} aria-hidden="true" />{presentedStatusLabel}</span>}
          {data.fromCache && data.status === 'succeeded' && !data.dirty && (
            <span className="wf-cached" title="输入未变化，本次复用了上次结果，没有产生新的付费请求">已缓存</span>
          )}
          {locked && <span className="wf-locked" title="节点位置已锁定" role="img" aria-label="位置已锁定"><Lock size={10} aria-hidden="true" /></span>}
          {disabled && <span className="wf-disabled" title="此节点不会参与运行">已禁用</span>}
          {hostUnsupported && <span className="wf-disabled wf-host-unsupported" title="当前客户端不能运行这个节点">当前客户端不支持</span>}
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
        <section className="wf-node-overview" aria-label={`${displayTitle}摘要`}>
          <div className="wf-node-overview-state">
            <StatusIcon size={17} aria-hidden="true" />
            <span><strong>{presentedStatusLabel}</strong><small>{resultSummary}</small></span>
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

      {inputHint && <p className="wf-input-contract-hint" role="note" title={inputHint}><ArrowRight size={12} aria-hidden="true" />{textOperation ? '连接上游文本，或直接写下指令' : '连接上游素材作为参考'}</p>}

      {['text', 'prompt', 'text-generate'].includes(kind) && <TextNodeActions id={id} kind={kind} data={data} selection="input" />}

      {supportsPrompt(kind) && (
        <PromptEditor
          label={`${displayTitle}提示词`}
          value={data.prompt}
          promptReferences={data.promptReferences}
          placeholder={kind === 'drama-script' ? '在这里粘贴整场剧本，然后运行右侧的「剧本解析」' : kind === 'text' || kind === 'prompt' ? '输入提示词或指令' : '补充这个节点的提示词'}
          references={upstreamReferences}
          onChange={(prompt, promptReferences) => handlers.onPromptChange(id, prompt, promptReferences, editorScope)}
          onInsert={(prompt, promptReferences) => handlers.onPromptInsert(id, prompt, promptReferences, editorScope)}
          onCommit={(prompt, promptReferences) => handlers.onPromptCommit(id, prompt, promptReferences, editorScope)}
        />
      )}

      {(imageOperation || videoOperation || textOperation) && defaultModelAvailability.connected && handlers.onSourceChange && <NodeModelSourceSelect kind={kind} group={data.group} sources={defaultModelAvailability.sourceGroups ?? []} disabled={nodeRunning || disabled || locked || readOnly} onChange={(group) => handlers.onSourceChange?.(id, group)} />}
      {(imageOperation || videoOperation || textOperation) && data.group !== undefined && <p className="wf-hint" title={data.group}>固定来源：{modelAvailability.sourceLabel || data.group || '空值（待配置）'}</p>}
      {modelAvailability.sourceError && <p className="wf-error is-validation" role="status">{modelAvailability.sourceError}</p>}
      {textOperation && <div className="wf-text-generation nodrag nowheel">
        <label><span>文字模型</span><select className="wf-model" aria-label="文字生成模型" value={selectedModel} disabled={nodeRunning || disabled || modelAvailability.textModels.length === 0} onChange={(event) => handlers.onModelChange(id, event.target.value)}>
          {!selectedModel && <option value="" disabled>请选择文字模型</option>}
          {selectedModel && !mediaModelAvailable && <option value={selectedModel} disabled>{selectedModel}（当前来源不可用）</option>}
          {modelAvailability.textModels.map((model) => <option key={model} value={model}>{model}</option>)}
        </select></label>
        {!mediaModelAvailable && <p className="wf-error is-validation" role="status"><AlertTriangle size={13} />请先在生成配置选择文字来源与模型</p>}
        {kind === 'text-generate' && !textImageInputModelSupported(selectedModel) && <small className="wf-hint">当前模型尚未确认支持图片理解；连接图片时请换用已支持的视觉文字模型，或移除图片连接。</small>}
        {kind === 'text-generate' && hostFeatureControlShown(capabilities, 'textWebSearch', data.textWebSearch === true) && <div className="wf-text-search"><button type="button" className={data.textWebSearch ? 'is-active' : ''} aria-label="联网搜索" aria-pressed={data.textWebSearch === true} disabled={nodeRunning || disabled || locked || (!data.textWebSearch && (!mediaModelAvailable || !textWebSearchModelSupported(selectedModel)))} onClick={() => handlers.onTextWebSearchChange?.(id, !data.textWebSearch)}><Globe size={14} aria-hidden="true" />联网搜索<span>{data.textWebSearch ? '已开启' : '未开启'}</span></button><small>{!textWebSearchModelSupported(selectedModel) ? data.textWebSearch ? '当前模型不支持联网搜索，请换模型或关闭开关后运行。' : '当前模型尚未接通联网搜索。' : data.textWebSearch ? '每次请求最多搜索一次，可能额外计费；来源需支持搜索接口。' : '开启后查询网页，并在结果中展示来源链接。'}</small></div>}
        <TextResultContent id={id} kind={kind} data={data} />
        <p className="wf-result-note">生成结果可从右侧文本端口传给下一步；另存文本后可独立修改。</p>
      </div>}

      {(kind === 'image-edit' || kind === 'image-generate' || kind === 'image' || kind === 'video-generate' || kind === 'video') && (
        <UpstreamReferencesPanel references={upstreamReferences} />
      )}

      {imageOperation && <CommerceTaskControls settings={data.settings} references={upstreamReferences} model={selectedModel} quality={data.quality} disabled={nodeRunning || locked || disabled || canRun === false} candidateCount={candidates.filter((entry) => entry.asset.kind === 'image').length} onEdit={handlers.onEditCommerceTask ? () => handlers.onEditCommerceTask?.(id, editorScope) : undefined} onCompare={handlers.onCompareCommerceCandidates ? () => handlers.onCompareCommerceCandidates?.(id, editorScope) : undefined} />}
      {imageOperation && <InteriorTaskControls settings={data.settings} references={upstreamReferences} prompt={data.prompt} disabled={nodeRunning || locked || disabled || canRun === false} candidateCount={candidates.filter((entry) => entry.asset.kind === 'image').length} onEdit={handlers.onEditInteriorTask ? () => handlers.onEditInteriorTask?.(id, editorScope) : undefined} onCompare={handlers.onCompareInteriorCandidates ? () => handlers.onCompareInteriorCandidates?.(id, editorScope) : undefined} />}
      {imageOperation && <ExteriorTaskControls settings={data.settings} references={upstreamReferences} prompt={data.prompt} disabled={nodeRunning || locked || disabled || canRun === false} requestCandidateCount={data.imageCandidateCount ?? 1} candidateCount={candidates.filter((entry) => entry.asset.kind === 'image').length} onEdit={handlers.onEditExteriorTask ? () => handlers.onEditExteriorTask?.(id, editorScope) : undefined} onCompare={handlers.onCompareExteriorCandidates ? () => handlers.onCompareExteriorCandidates?.(id, editorScope) : undefined} />}
      {imageOperation && <StoryboardTaskControls settings={data.settings} references={upstreamReferences} prompt={data.prompt} disabled={nodeRunning || locked || disabled || canRun === false} requestCandidateCount={data.imageCandidateCount ?? 1} candidateCount={candidates.filter((entry) => entry.asset.kind === 'image').length} onEdit={handlers.onEditStoryboardTask ? () => handlers.onEditStoryboardTask?.(id, editorScope) : undefined} onCompare={handlers.onCompareStoryboardCandidates ? () => handlers.onCompareStoryboardCandidates?.(id, editorScope) : undefined} />}
      {imageOperation && (() => {
        const preset = imageModelPreset(selectedModel || imageModelPresets[0].id, capabilities)
        const resolution = inspectImageResolutionSelection({ model: selectedModel, size: data.size, imageResolution: data.imageResolution }, capabilities)
        const selectedSize = data.size ?? preset.sizes[0] ?? defaultImageSize
        const sizeSupport = resolution.choices.find((choice) => choice.value === '1K')
        return (
          <>
            {selectedModel && !imageModelPresets.some((entry) => entry.id === selectedModel) && <p className="wf-error is-validation" role="note"><AlertTriangle size={13} />自定义图像模型的尺寸、画质和编辑兼容性尚未检测，请核对服务能力。</p>}
            <select className="nodrag wf-model" aria-label="图像模型" value={selectedModel} onChange={(event) => handlers.onModelChange(id, event.target.value)}>
              {!mediaModelAvailable && <option value={selectedModel} disabled>{selectedModel ? `${imageModelPreset(selectedModel).label}（当前分组不可用）` : '请先配置图像来源与模型'}</option>}
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
                  value={resolution.value}
                  title={preset.resolutionNote ?? '输出清晰度'}
                  aria-label="生成清晰度"
                  disabled={commerceDerivedSize || !selectedModel}
                  onChange={(event) => handlers.onImageResolutionChange(id, event.target.value as '1K' | '2K' | '4K')}
                >
                  {!selectedModel ? <option value={resolution.value}>{resolution.value}</option> : resolution.choices.map((entry) => (
                    <option key={entry.value} value={entry.value} disabled={!entry.supported} title={entry.reason ?? entry.effectiveSize}>
                      {resolution.providerSized && entry.value === '1K' ? '由服务决定' : entry.value}{entry.supported ? '' : '（当前组合不支持）'}
                    </option>
                  ))}
                </select>
              </label>
              {imageCountChoices.length > 1 && <label className="wf-inline-field">
                <span>生成数量</span>
                <select className="wf-model" aria-label="生成数量" title={imageCandidateCountNotice(data.imageCandidateCount ?? 1)} value={data.imageCandidateCount ?? 1} disabled={nodeRunning} onChange={(event) => handlers.onImageCandidateCountChange(id, parseImageCandidateCount(Number(event.target.value), kind)!)}>
                  {imageCountChoices.map((count) => <option key={count} value={count}>×{count}</option>)}
                </select>
              </label>}
              {preset.supportsSize && (
                <label className="wf-inline-field">
                  <span>尺寸</span>
                  <select className="wf-model" value={selectedSize} aria-label="生成尺寸" disabled={commerceDerivedSize || !selectedModel} onChange={(event) => handlers.onSizeChange(id, event.target.value)}>
                    {!preset.sizes.includes(selectedSize) && <option value={selectedSize} disabled={!sizeSupport?.supported} title={sizeSupport?.reason ?? '保留已保存的尺寸'}>{imageSizeLabel(selectedSize)}{sizeSupport?.supported ? '（已保存尺寸）' : '（已保存，当前不支持）'}</option>}
                    {preset.sizes.map((size) => <option key={size} value={size}>{imageSizeLabel(size)}</option>)}
                  </select>
                </label>
              )}
            </div>
            {imageCountChoices.length > 1 && <p className="wf-result-note">{imageCandidateCountNotice(data.imageCandidateCount ?? 1)}</p>}
            {!commerceDerivedSize && selectedModel && resolution.message && <p className="wf-error is-validation" role="status"><AlertTriangle size={13} aria-hidden="true" />{resolution.message}</p>}
          </>
        )
      })()}

      {videoOperation && supportsModel(kind) && (
        <div className="wf-video-params nodrag">
          <select className="wf-model" aria-label="视频模型" disabled={disabled || locked || nodeRunning} value={selectedModel} onChange={(event) => handlers.onModelChange(id, event.target.value)}>
            {!mediaModelAvailable && <option value={selectedModel} disabled>{selectedModel ? `${selectedVideoPreset.label}（当前分组不可用）` : '请先配置视频来源与模型'}</option>}
            {videoModels.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
          {!mediaModelAvailable && <p className="wf-error is-validation" role="status"><AlertTriangle size={13} aria-hidden="true" />当前分组不提供此视频模型，请重新选择</p>}
          <VideoParameterFields imageCount={upstreamReferences.filter((item) => item.kind === 'image').length} videoProtocol={modelAvailability.videoProtocol} model={selectedModel} data={data} disabled={disabled || locked || nodeRunning} onChange={(patch) => handlers.onVideoParametersChange?.(id, patch)} onReset={() => handlers.onVideoParametersReset?.(id)} />
        </div>
      )}

      {processedOutput && <div className="wf-output-placement nodrag" aria-label="处理成品操作">
          <ProcessedOutputDownload id={id} data={data} />
          {['image-collage', 'image-layer', 'image-crop', 'image-tile'].includes(kind) && <button type="button" className="wf-run-node" disabled={disabled || nodeRunning || outputPending} onClick={() => handlers.onProcessAndPlaceOutput?.(id)} title="处理当前已应用参数，成功后创建独立图片；原工具保留"><ImageIcon size={13} aria-hidden="true" />{outputPending ? '正在放置成品…' : '处理并放到画布'}</button>}
          {data.result?.kind === 'image' && data.result.assetId && <button type="button" disabled={disabled || outputPending} onClick={() => handlers.onPlaceOutput?.(id, 'current')} title="复用已保存成品，不重新处理或生成">{kind === 'image-grid-split' ? data.dirty ? '放置上次当前切片' : '放置当前切片' : data.dirty ? '放置上次成品' : '成品放到画布'}</button>}
          {kind === 'image-grid-split' && Boolean(data.candidateAssetIds?.length) && <button type="button" disabled={disabled || outputPending} onClick={() => handlers.onPlaceOutput?.(id, 'all')} title="按切片顺序放置为独立图片，一次撤销全部">{data.dirty ? '放置上次全部切片' : '放置全部切片'}（{data.candidateAssetIds?.length}）</button>}
          {outputPending && <small role="status">正在核对处理结果与图片内容</small>}
        </div>}

      {(isImageTransformNodeKind(kind) || kind === 'image-compare' || kind === 'image-panorama') && <ImageToolControls key={editorScope} kind={kind} data={data} references={upstreamReferences} disabled={disabled || locked || nodeRunning} onChange={(patch) => handlers.onSettingsChange(id, patch)} onTileChange={handlers.onTileSettingsChange ? (patch, scope) => handlers.onTileSettingsChange!(id, patch, editorScope, scope) : undefined} onDownloadTileSource={handlers.onDownloadTileSource ? (selection, scope) => handlers.onDownloadTileSource!(id, selection, editorScope, scope) : undefined} allowPageDownload={hostFeatureControlShown(capabilities, 'fileDownload')} onApplyWithImports={(input) => { if (!handlers.onLayerPsdApply) throw new Error('当前画布暂不支持 PSD 图层接入'); handlers.onLayerPsdApply(id, input, editorScope) }} />}
      <NodeSettings id={id} data={data} kind={kind} readOnly={readOnly} />

      {!['gallery', 'prompt', 'output'].includes(kind) && (data.status === 'queued' || data.status === 'running') && (
        <div className="wf-progress" role="status" aria-live="polite">
          <p>
            {data.runStage
              ? `${runStageLabel[data.runStage]}${data.runProgressMode === 'determinate' && typeof data.runProgress === 'number' ? ` · ${Math.round(data.runProgress)}%` : '…'}`
              : data.status === 'queued'
                ? '正在等待可用执行槽位…'
              : isImageTransformNodeKind(kind)
                ? '正在处理图片并保存素材…'
              : textOperation
                ? '文字生成中，完成后会显示在下方'
              : videoOperation
                ? '视频生成中，完成后会自动保存到本地 · 通常需要数分钟'
                : data.quality === 'high'
                  ? '高清图像生成中 · 预计 2-3 分钟'
                  : '图像生成中 · 预计 10 秒至 1 分钟'}
          </p>
          <RunningElapsed startedAt={data.runStartedAt} />
          {data.runHealth === 'delayed' && <small>服务端仍在线，但本次生成已明显超过同规格历史耗时。</small>}
          {videoOperation && <small>停止等待不等于取消已到达服务端的生成任务，可稍后从运行记录续查。</small>}
        </div>
      )}
      {data.status === 'failed' && data.errorMessage && kind !== 'unknown' && <p className={disabledSkipped ? 'wf-result-note' : 'wf-error'} role={disabledSkipped ? 'status' : 'alert'}><StatusIcon size={13} aria-hidden="true" />{data.errorMessage}</p>}
      {!mediaInput && !isImageTransformNodeKind(kind) && kind !== 'image-compare' && kind !== 'image-panorama' && displayedResult?.localUrl && displayedResult.kind === 'image' && (
        <SafeImage
          className="wf-preview"
          src={displayedResult.localUrl}
          alt={selectedCandidate ? '生成候选预览' : '生成结果'}
          loading="lazy"
          style={{ aspectRatio: mediaAssetAspectRatio(displayedResult, data.size) }}
          title={mediaHoverTitle([mediaAssetSizeLabel(displayedResult), '双击放大预览'])}
          onLoad={(event) => reportPreviewMetadata(id, displayedResult.assetId, event.currentTarget)}
          onDoubleClick={(event) => {
            event.stopPropagation()
            handlers.onPreviewAsset(displayedResult)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
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
          canvasPlayback
          style={{ aspectRatio: mediaAssetAspectRatio(displayedResult, data.size) }}
          title={mediaHoverTitle([mediaAssetSizeLabel(displayedResult), '双击放大预览'])}
          onLoadedMetadata={(event) => reportPreviewMetadata(id, displayedResult.assetId, event.currentTarget)}
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
      {candidates.length > 0 && (
        <div className="wf-candidates nodrag">
          <div className="wf-candidate-strip" aria-label="生成候选">
            {candidates.map((candidate, index) => (
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
              {/* 采纳与丢弃已取消（2026-08-20 产品决策）：最新候选自动就是产物，
                  切换候选即切换产物，重跑入口在运行按钮与操作条上。 */}
              <small>{candidates.length > 1 ? '点击候选即切换产物' : '本次产物'}</small>
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
            className={`nodrag wf-run-node${nodeRunning ? ' is-running' : ''}`}
            aria-label={`运行${displayTitle}节点`}
            title="运行此节点及所需上游，已完成的上游直接复用"
            disabled={nodeRunning || ((imageOperation || videoOperation || textOperation) && !mediaModelAvailable)}
            onClick={() => handlers.onRunToNode(id)}
          >
            {nodeRunning ? <LoaderCircle size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
            {nodeRunning ? '运行中' : '运行此节点'}
          </button>
        )}
        {!processedOutput && data.result?.assetId && <button type="button" className="nodrag wf-rerun" onClick={() => handlers.onDownloadAsset(id)}>另存</button>}
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
function PortHandle({ nodeId, port, index, centered = false }: { nodeId: string; port: NodePortDefinition; index: number; centered?: boolean }) {
  const input = port.direction === 'input'
  const connections = useNodeConnections({
    id: nodeId,
    handleType: input ? 'target' : 'source',
    handleId: port.id,
  })
  const connection = useConnection()
  const many = port.cardinality === 'many'
  const suffix = many ? '（可连接多个）' : ''
  const state = connections.length > 0 ? `已连接 ${connections.length} 条` : '未连接'

  // While a wire is being dragged, say up front which ports would accept it.
  // Without this the user finds out only by releasing and watching it fail.
  let guidance = ''
  if (connection.inProgress && connection.fromHandle && connection.fromNode) {
    const source = connection.fromHandle.type === 'source'
    const origin = connection.fromNode.id === nodeId && connection.fromHandle.id === port.id
    if (origin) guidance = ' is-connect-origin'
    else if (source === input) {
      guidance = handlers.isPortCompatible({
        source: source ? connection.fromNode.id : nodeId,
        sourceHandle: source ? connection.fromHandle.id ?? null : port.id,
        target: source ? nodeId : connection.fromNode.id,
        targetHandle: source ? port.id : connection.fromHandle.id ?? null,
      }) ? ' is-connect-target' : ' is-connect-blocked'
    } else guidance = ' is-connect-blocked'
  }

  return (
    <Handle
      type={input ? 'target' : 'source'}
      id={port.id}
      position={input ? Position.Left : Position.Right}
      style={{ top: centered ? '50%' : portSlotOffsetY(index) }}
      className={`wf-port wf-port-${port.kind}${many ? ' wf-port-many' : ''}${connections.length > 0 ? ' is-connected' : ''}${guidance}`}
      title={`${input ? '输入' : '输出'} · ${port.label}${suffix} · ${state}`}
      aria-label={`${input ? '输入' : '输出'}${port.label}${many ? '，可连接多个' : ''}，${state}`}
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
