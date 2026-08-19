import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
  type XYPosition,
} from '@xyflow/react'
import { flushSync } from 'react-dom'
import '@xyflow/react/dist/style.css'
import {
  createEmptyWorkflow,
  parseWorkflowFile,
  serializeWorkflow,
  type NodeKind,
  type WorkflowEdge,
  type WorkflowFile,
  type WorkflowCandidateRef,
  type AssetRef,
  type WorkflowNode,
  type WorkflowNodeData,
} from './model'
import { createMockExecutors, runWorkflow, type NodeInputs } from './engine/engine'
import { createHostExecutors } from './engine/executors'
import { hostBridge } from './host'
import { canvasAriaLabelConfig } from './aria-labels'
import { CanvasEdgeHandlersProvider, defaultEdgeOptions, edgeTypes } from './edges/WorkflowEdge'
import { CanvasContextMenu, type CanvasContextMenuState } from './components/CanvasContextMenu'
import type { CanvasContextAction } from './editor/context-menu'
import { canvasMinimapNodeColor } from './nodes/minimap-node-color'
import {
  compatibleInsertionHandle,
  connectionForInsertedNode,
  isValidWorkflowConnection,
  type PendingCanvasConnection,
} from './ports'
import {
  availableImageModelPresets,
  availableVideoModelPresets,
  defaultImageResolution,
  imageModelPreset,
} from './models'
import { CanvasModelAvailabilityProvider, CanvasNodeViewProvider, CanvasUpstreamReferencesProvider, ModelSuggestions, nodeTypes, registerNodeChangeHandlers, type CanvasNode } from './nodes/WorkflowNodes'
import { canvasNodeLodForZoom, type CanvasNodeLod } from './nodes/node-lod'
import type { CanvasAssetPage, CanvasAssetQuery, CanvasAssetSummary, CanvasGeneratedAsset, CanvasGeneratedVideoAsset, CanvasGroupSummary, CanvasPromptPreset, CanvasRunGraph, CanvasRunRecord, CanvasRunScope, CanvasStoredProjectSummary } from './host'
import { AssetTray } from './components/AssetTray'
import { MediaLightbox } from './components/MediaPreview'
import { autoLayoutCanvasNodes } from './editor/auto-layout'
import { resolveCanvasShortcut } from './editor/shortcuts'
import { duplicateCanvasNodesForAltDrag } from './editor/alt-drag'
import { builtinCanvasTemplates } from './templates/builtin-templates'
import { instantiateTemplate, placeTemplateInstance } from './templates/instantiate-template'
import { builtinNodeRegistry } from './domain/builtin-node-definitions'
import { operationDefaultsForTemplateNode } from './domain/workflow-node-config'
import { NodeLibrary } from './components/NodeLibrary'
import { CanvasInspector, type CanvasInspectorNode, type CanvasInspectorTab } from './components/CanvasInspector'
import { projectCanvasInspectorNodes } from './components/canvas-inspector-model'
import { RunPreflight } from './components/RunPreflight'
import { SelectionToolbar } from './components/SelectionToolbar'
import {
  buildCanvasClipboardPayload,
  pasteCanvasClipboard,
  type CanvasClipboardPayload,
} from './editor/clipboard'
import { groupCanvasNodes, ungroupCanvasNode } from './editor/grouping'
import { RunInspector } from './components/RunInspector'
import { ProjectCenter } from './components/ProjectCenter'
import { parseXingCanvasProject, serializeXingCanvasProject } from './persistence/project-package'
import {
  adoptNodeCandidate,
  discardNodeCandidate,
  markNodeAndDescendantsDirty,
  projectRunRecordToNodes,
  selectNodeCandidate,
} from './runtime/run-projection'
import { ChevronDown, Crosshair, FolderOpen, Focus, History, Image as ImageIcon, LayoutGrid, Map as MapIcon, MoreHorizontal, PanelRight, Play, Plus, Redo2, SlidersHorizontal, Sparkles, Undo2, Video, X } from 'lucide-react'
import { canvasNodeDocumentRecord, useCanvasDocument } from './store/use-canvas-document'
import type { CanvasDocumentState, CanvasMediaGroups } from './store/canvas-state'
import type { EditorNodeRecord } from './domain/node-definition'
import { assetInputNodeKind, mediaAssetNodeDimensions, mediaResultNodeDimensions } from './library/media-assets'
import { QuickInsert, type QuickInsertCommand } from './components/QuickInsert'
import { TemplateCatalog } from './components/TemplateCatalog'
import { findAvailableCanvasPosition } from './editor/node-placement'
import { applyCanvasTheme, subscribeCanvasTheme, type CanvasTheme } from './theme/canvas-theme'
import {
  buildCanvasRunPreflight,
  canvasMediaConfigurationErrors,
  sameCanvasRunGraphSnapshot,
  selectCanvasRunNodeIds,
  type CanvasRunPreflight,
} from './runtime/run-preflight'
import { mergeCanvasRunEvent } from './runtime/run-events'
import {
  defaultCanvasUiPreferences,
  readCanvasUiPreferences,
  writeCanvasUiPreferences,
  type CanvasRightPanel,
  type CanvasUiPreferences,
} from './persistence/canvas-ui-preferences'

// 画布装配层:@xyflow/react 的 Node/Edge 与领域模型互相映射,引擎与
// 持久化只见领域模型。M0 执行走 mock 执行器(不出网);M1 把 executors
// 换成 relay 真实现(engine/relay.ts),本文件的编排逻辑不变。

let nodeSequence = 0

function nextNodeId(): string {
  nodeSequence += 1
  return `n${Date.now().toString(36)}-${nodeSequence}`
}

function connectionEventPoint(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event
  return point ? { x: point.clientX, y: point.clientY } : null
}

export function toCanvasNode(node: WorkflowNode): CanvasNode {
  const displayKind = node.disabled && node.unknownKind ? 'unknown' : node.kind
  const dimensions = builtinNodeRegistry.resolve(displayKind)?.dimensions
  const mediaDimensions = ['image-input', 'video-input', 'audio-input'].includes(displayKind) && node.data.result?.assetId
    ? mediaAssetNodeDimensions(node.data.result)
    : null
  const width = mediaDimensions?.width ?? node.width ?? dimensions?.width
  const resultDimensions = !mediaDimensions && node.data.result?.assetId && width && dimensions
    ? mediaResultNodeDimensions(displayKind, node.data.result, width, node.height ?? dimensions.height, node.data.size)
    : null
  const height = mediaDimensions?.height ?? resultDimensions?.height ?? node.height ?? dimensions?.height
  return {
    id: node.id,
    type: displayKind,
    definitionVersion: node.definitionVersion ?? 1,
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    position: node.position,
    data: { ...node.data, __canvasDisabled: node.disabled === true, __canvasLocked: node.locked === true },
    ...(node.parentId ? { parentId: node.parentId, extent: 'parent' as const } : {}),
    ...(width ? { width, style: { width } } : {}),
    ...(height ? { height, style: { ...(width ? { width } : {}), height } } : {}),
    ...(node.locked ? { draggable: false, selectable: true } : {}),
  }
}

export function toWorkflowNode(node: CanvasNode): WorkflowNode {
  return {
    id: node.id,
    kind: node.type as NodeKind,
    definitionVersion: node.definitionVersion,
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    ...(node.draggable === false ? { locked: true } : {}),
    position: node.position,
    data: {
      prompt: node.data.prompt,
      model: node.data.model,
      quality: node.data.quality,
      size: node.data.size,
      imageResolution: node.data.imageResolution,
      seconds: node.data.seconds,
      status: node.data.status,
      result: node.data.result,
      errorMessage: node.data.errorMessage,
      costQuota: node.data.costQuota,
      settings: node.data.settings,
      candidateAssetIds: node.data.candidateAssetIds,
    },
  }
}

export function toCanvasRunGraph(
  nodes: readonly CanvasNode[],
  edges: readonly Edge[],
  groups: { image: string; video: string },
): CanvasRunGraph {
  const runnableNodes = nodes.filter(isCanvasGraphNode)
  const runnableIds = new Set(runnableNodes.map((node) => node.id))
  return {
    nodes: runnableNodes.map((node) => ({
      id: node.id,
      kind: node.type ?? 'text',
      definitionVersion: node.definitionVersion,
      ...(node.disabled ? { disabled: true } : {}),
      data: {
        prompt: node.data.prompt,
        model: node.data.model,
        ...(['image', 'image-generate', 'image-edit'].includes(node.type ?? '') ? { group: groups.image } : {}),
        ...(['video', 'video-generate'].includes(node.type ?? '') ? { group: groups.video } : {}),
        quality: node.data.quality,
        size: node.data.size,
        imageResolution: node.data.imageResolution,
        seconds: node.data.seconds,
        adoptedAssetId: node.data.result?.assetId,
        videoMode: typeof node.data.settings?.videoMode === 'string'
          ? node.data.settings.videoMode as CanvasRunGraph['nodes'][number]['data']['videoMode']
          : undefined,
        videoResolution: typeof node.data.settings?.videoResolution === 'string'
          ? node.data.settings.videoResolution as CanvasRunGraph['nodes'][number]['data']['videoResolution']
          : undefined,
        videoAspectRatio: typeof node.data.settings?.videoAspectRatio === 'string'
          ? node.data.settings.videoAspectRatio as CanvasRunGraph['nodes'][number]['data']['videoAspectRatio']
          : undefined,
        promptOptimization: typeof node.data.settings?.promptOptimization === 'boolean'
          ? node.data.settings.promptOptimization
          : undefined,
      },
    })),
    edges: edges
      .filter((edge) => runnableIds.has(edge.source) && runnableIds.has(edge.target))
      .map(toWorkflowEdge),
  }
}

export { canvasMediaConfigurationErrors, selectCanvasRunNodeIds }

export function isCanvasGraphNode(node: CanvasNode): boolean {
  const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown')
  return Boolean(definition?.executable) && node.type !== 'unknown' && !node.unknownKind
}

export function isCanvasRunnableTarget(node: CanvasNode): boolean {
  return isCanvasGraphNode(node) && !node.disabled
}

const rerunTextSourceKinds = new Set(['text', 'prompt'])
const rerunImageSourceKinds = new Set(['image', 'image-input', 'image-generate', 'image-edit', 'gallery'])
const rerunVideoSourceKinds = new Set(['video', 'video-input', 'video-generate', 'gallery'])
const rerunAudioSourceKinds = new Set(['audio-input', 'gallery'])

export function workflowNodeData(type: string, config: Record<string, unknown> = {}): WorkflowNodeData {
  const defaults = builtinNodeRegistry.require(type).defaultData
  const values = { ...structuredClone(defaults), ...structuredClone(config) }
  if ('durationSeconds' in config && !('seconds' in config)) delete values.seconds
  const prompt = typeof values.prompt === 'string' ? values.prompt : ''
  const model = typeof values.model === 'string' ? values.model : ''
  const quality = typeof values.quality === 'string' ? values.quality : undefined
  const size = typeof values.size === 'string' ? values.size : undefined
  const imageResolution = values.imageResolution === '1K' || values.imageResolution === '2K' || values.imageResolution === '4K'
    ? values.imageResolution
    : undefined
  const seconds = typeof values.seconds === 'string' && /^(?:[1-9]|1[0-5])$/.test(values.seconds) ? values.seconds : undefined
  const assetId = typeof values.assetId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(values.assetId)
    ? values.assetId
    : undefined
  const assetKind = type === 'video-input' ? 'video' : type === 'audio-input' ? 'audio' : 'image'
  const result = assetId && (type === 'image-input' || type === 'video-input' || type === 'audio-input')
    ? { kind: assetKind, assetId, localUrl: `xingmang-asset://${assetKind}/${assetId}` } as const
    : undefined
  const settings = Object.fromEntries(Object.entries(values).filter(([key]) => !['prompt', 'model', 'quality', 'size', 'imageResolution', 'seconds', 'status', 'result', 'assetId'].includes(key)))
  return {
    prompt,
    model,
    status: result ? 'succeeded' : 'idle',
    ...(quality ? { quality } : {}),
    ...(size ? { size } : {}),
    ...(imageResolution ? { imageResolution } : {}),
    ...(seconds ? { seconds } : {}),
    ...(result ? { result } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  }
}

function imageOperationDefaults(
  type: string,
  imageModels: readonly string[] = [],
  videoModels: readonly string[] = [],
): Record<string, unknown> {
  return operationDefaultsForTemplateNode(type, imageModels, videoModels).config
}

function editorNodeToCanvasNode(node: EditorNodeRecord): CanvasNode {
  const raw = node.data
  const result = raw.result as AssetRef | undefined
  const data: WorkflowNodeData = {
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    status: result?.assetId ? 'succeeded' : 'idle',
    ...(typeof raw.quality === 'string' ? { quality: raw.quality } : {}),
    ...(typeof raw.size === 'string' ? { size: raw.size } : {}),
    ...(typeof raw.seconds === 'string' ? { seconds: raw.seconds } : {}),
    ...(result ? { result } : {}),
    ...(raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
      ? { settings: raw.settings as Record<string, unknown> }
      : {}),
    ...(Array.isArray(raw.candidateAssetIds)
      ? { candidateAssetIds: raw.candidateAssetIds.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  }
  return toCanvasNode({
    id: node.id,
    kind: node.type as NodeKind,
    definitionVersion: node.definitionVersion,
    position: node.position,
    data,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    ...(node.locked ? { locked: true } : {}),
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
  })
}

function workflowDocument(workflow: WorkflowFile): CanvasDocumentState {
  return {
    name: workflow.name,
    mediaGroups: { ...(workflow.mediaGroups ?? {}) },
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      definitionVersion: node.definitionVersion ?? 1,
      position: { ...node.position },
      data: structuredClone(node.data) as unknown as Record<string, unknown>,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(node.locked ? { locked: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    })),
    edges: workflow.edges.map((edge) => ({ ...edge })),
    viewport: workflow.viewport ?? { x: 0, y: 0, zoom: 1 },
    revision: 0,
  }
}

function mediaAssetRef(asset: CanvasAssetSummary): AssetRef {
  return {
    kind: asset.mediaType,
    assetId: asset.assetId,
    localUrl: asset.localUrl,
    mimeType: asset.mimeType,
    ...('width' in asset && asset.width ? { width: asset.width } : {}),
    ...('height' in asset && asset.height ? { height: asset.height } : {}),
    ...('taskId' in asset && asset.taskId ? { taskId: asset.taskId } : {}),
  }
}

function generatedAssetRef(asset: CanvasGeneratedAsset): AssetRef {
  return mediaAssetRef({
    ...asset,
    createdAt: '',
    mediaType: 'image',
    thumbnailUrl: asset.localUrl,
    displayName: asset.fileName,
  })
}

function generatedVideoAssetRef(asset: CanvasGeneratedVideoAsset): AssetRef {
  return {
    kind: 'video',
    assetId: asset.assetId,
    localUrl: asset.localUrl,
    mimeType: asset.mimeType,
    taskId: asset.taskId,
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
  }
}

function generatedImageSummary(asset: CanvasGeneratedAsset): CanvasAssetSummary {
  return {
    ...asset,
    createdAt: new Date().toISOString(),
    mediaType: 'image',
    thumbnailUrl: asset.localUrl,
    displayName: asset.fileName,
  }
}

function importedAssetSummary(asset: CanvasGeneratedAsset | CanvasAssetSummary): CanvasAssetSummary {
  return 'mediaType' in asset ? asset : generatedImageSummary(asset)
}

function toWorkflowEdge(edge: Edge): WorkflowEdge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? '',
    target: edge.target,
    targetHandle: edge.targetHandle ?? '',
  }
}

function MediaConfiguration({
  open,
  groups,
  imageGroup,
  videoGroup,
  imageModels,
  videoModels,
  preparing,
  onToggle,
  onClose,
  onSelect,
}: {
  open: boolean
  groups: readonly CanvasGroupSummary[]
  imageGroup: string | null
  videoGroup: string | null
  imageModels: readonly string[]
  videoModels: readonly string[]
  preparing: 'image' | 'video' | 'all' | null
  onToggle(): void
  onClose(): void
  onSelect(kind: 'image' | 'video', group: string): void
}) {
  const imagePresets = availableImageModelPresets(imageModels)
  const videoPresets = availableVideoModelPresets(videoModels)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => {
    if (!open) return
    const focusFrame = window.requestAnimationFrame(() => panelRef.current
      ?.querySelector<HTMLElement>('select:not(:disabled), button:not(:disabled)')
      ?.focus())
    const closeAndRestore = () => {
      onCloseRef.current()
      triggerRef.current?.focus()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAndRestore()
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) onCloseRef.current()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open])

  const closeAndRestoreFocus = () => {
    onClose()
    triggerRef.current?.focus()
  }
  return (
    <div ref={rootRef} className="canvas-media-config">
      <button
        ref={triggerRef}
        type="button"
        className="canvas-config-command"
        aria-label="生成配置"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="canvas-media-config-panel"
        title="分别设置生图与视频生成分组"
        onClick={onToggle}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>生成配置</span>
      </button>
      {open && (
        <section ref={panelRef} id="canvas-media-config-panel" className="canvas-media-config-panel" role="dialog" aria-label="画布生成配置">
          <header>
            <span><strong>生成配置</strong><small>按能力选择分组</small></span>
            <button type="button" className="canvas-icon-command" aria-label="关闭生成配置" title="关闭" onClick={closeAndRestoreFocus}><X size={14} /></button>
          </header>
          <label className="canvas-media-config-field">
            <span className="canvas-media-config-label"><ImageIcon size={15} aria-hidden="true" /><span><strong>生图分组</strong><small>{preparing === 'image' || preparing === 'all' ? '正在准备 API Key…' : `${imagePresets.length} 个可用模型`}</small></span></span>
            <select autoFocus aria-label="生图分组" value={imageGroup ?? ''} disabled={preparing !== null} onChange={(event) => onSelect('image', event.target.value)}>
              {groups.map((group) => <option key={group.name} value={group.name}>{group.name} · {group.ratio}x</option>)}
            </select>
            <small className={imagePresets.length ? 'canvas-media-config-models' : 'canvas-media-config-models is-empty'}>
              {imagePresets.length ? imagePresets.map((model) => model.label).join(' · ') : '该分组当前没有可用图像模型'}
            </small>
          </label>
          <label className="canvas-media-config-field">
            <span className="canvas-media-config-label"><Video size={15} aria-hidden="true" /><span><strong>视频分组</strong><small>{preparing === 'video' || preparing === 'all' ? '正在准备 API Key…' : `${videoPresets.length} 个可用模型`}</small></span></span>
            <select aria-label="视频分组" value={videoGroup ?? ''} disabled={preparing !== null} onChange={(event) => onSelect('video', event.target.value)}>
              {groups.map((group) => <option key={group.name} value={group.name}>{group.name} · {group.ratio}x</option>)}
            </select>
            <small className={videoPresets.length ? 'canvas-media-config-models' : 'canvas-media-config-models is-empty'}>
              {videoPresets.length ? videoPresets.map((model) => model.label).join(' · ') : '该分组当前没有可用视频模型'}
            </small>
          </label>
        </section>
      )}
    </div>
  )
}

type MediaPreparationKind = 'image' | 'video' | 'all'

interface PreparedMediaConfiguration {
  mediaGroups: CanvasMediaGroups
  imageModels: string[]
  videoModels: string[]
  keyCreatedGroups: string[]
  warnings: string[]
}

function mediaGroupsSignature(mediaGroups: CanvasMediaGroups): string {
  return `${mediaGroups.image ?? ''}\u0000${mediaGroups.video ?? ''}`
}

function preferredMediaGroups(availableGroups: readonly CanvasGroupSummary[]): CanvasMediaGroups {
  if (availableGroups.length === 0) return {}
  const image = availableGroups.find((entry) => entry.name === '生图分组')?.name
    ?? availableGroups.find((entry) => entry.name === 'openai')?.name
    ?? availableGroups[0].name
  const video = availableGroups.find((entry) => entry.name.toLowerCase() === 'grok')?.name
    ?? availableGroups.find((entry) => entry.name.toLowerCase().includes('grok'))?.name
    ?? image
  return { image, video }
}

export function App({ initialTheme = 'dark' }: { initialTheme?: CanvasTheme }) {
  const documentController = useCanvasDocument(editorNodeToCanvasNode)
  const {
    nodes,
    edges,
    viewport,
    mediaGroups,
    setNodes,
    setViewport: setDocumentViewport,
    execute,
    undo,
    redo,
    onNodesChange,
    onEdgesChange,
    canUndo,
    canRedo,
  } = documentController
  const [running, setRunning] = useState(false)
  const [theme, setTheme] = useState<CanvasTheme>(initialTheme)
  const [projects, setProjects] = useState<CanvasStoredProjectSummary[]>([])
  const [projectLoading, setProjectLoading] = useState(Boolean(window.xingmangCanvasHost))
  const [activeProject, setActiveProject] = useState<CanvasStoredProjectSummary | null>(null)
  const [uiPreferences, setUiPreferences] = useState<CanvasUiPreferences>(() => ({ ...defaultCanvasUiPreferences }))
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const autoSaveRevisionRef = useRef(0)
  const projectHydrationRef = useRef(false)
  const projectSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const [banner, setBanner] = useState<string | null>(null)
  const [groups, setGroups] = useState<CanvasGroupSummary[]>([])
  const [imageModels, setImageModels] = useState<string[]>([])
  const [videoModels, setVideoModels] = useState<string[]>([])
  const [mediaConfigOpen, setMediaConfigOpen] = useState(false)
  const [preparingMedia, setPreparingMedia] = useState<MediaPreparationKind | null>(null)
  const [assetTrayOpen, setAssetTrayOpen] = useState(false)
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [assetPage, setAssetPage] = useState<CanvasAssetPage>({ items: [], offset: 0, limit: 24, total: 0, hasMore: false })
  const [assetCatalog, setAssetCatalog] = useState<CanvasAssetSummary[]>([])
  const [userPromptPresets, setUserPromptPresets] = useState<CanvasPromptPreset[]>([])
  const [assetQuery, setAssetQuery] = useState<Required<Pick<CanvasAssetQuery, 'offset' | 'limit' | 'mediaType' | 'view' | 'source' | 'sort'>> & Pick<CanvasAssetQuery, 'search' | 'tag'>>({
    offset: 0, limit: 24, mediaType: 'all', search: '', view: 'all', source: 'all', sort: 'created-desc', tag: '',
  })
  const [inspectorTab, setInspectorTab] = useState<CanvasInspectorTab>('node')
  const [nodeInspectorOpen, setNodeInspectorOpen] = useState(false)
  const [runPreflight, setRunPreflight] = useState<CanvasRunPreflight | null>(null)
  const [pendingCanvasRun, setPendingCanvasRun] = useState<{ graph: CanvasRunGraph; scope: CanvasRunScope } | null>(null)
  const [runInspectorOpen, setRunInspectorOpen] = useState(false)
  const [resumingTaskIds, setResumingTaskIds] = useState<Set<string>>(() => new Set())
  const [runsLoading, setRunsLoading] = useState(false)
  const [runRecords, setRunRecords] = useState<CanvasRunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runScopeKind, setRunScopeKind] = useState<CanvasRunScope['kind']>('all')
  const [dirtyNodeIds, setDirtyNodeIds] = useState<Set<string>>(() => new Set())
  const [previewAsset, setPreviewAsset] = useState<AssetRef | null>(null)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [runMenuOpen, setRunMenuOpen] = useState(false)
  const [minimapOpen, setMinimapOpen] = useState(uiPreferences.minimapOpen)
  const [focusMode, setFocusMode] = useState(uiPreferences.focusMode)
  const [nodeLod, setNodeLod] = useState<CanvasNodeLod>(() => canvasNodeLodForZoom(viewport.zoom))
  const [quickInsert, setQuickInsert] = useState<{
    anchor: { x: number; y: number }
    flowPosition: XYPosition
    connection?: PendingCanvasConnection
    edgeId?: string
    compatibleHandles?: Readonly<Record<string, string>>
  } | null>(null)
  const [templateCatalog, setTemplateCatalog] = useState<{ initialTemplateId?: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const resumingTaskIdsRef = useRef<Set<string>>(new Set())
  const activeRunRef = useRef<{ runId: string; graphRevision: string; scope?: CanvasRunScope } | null>(null)
  const clipboardRef = useRef<CanvasClipboardPayload | null>(null)
  const reactFlow = useReactFlow<CanvasNode, Edge>()
  const overviewViewportRef = useRef<Viewport | null>(null)
  const altDragSessionRef = useRef<{
    nodeIds: string[]
    originalPositions: ReadonlyMap<string, XYPosition>
    preserveInputConnections: boolean
  } | null>(null)
  const moreActionsRef = useRef<HTMLDivElement>(null)
  const runMenuRef = useRef<HTMLDivElement>(null)
  const quickInsertTriggerRef = useRef<HTMLButtonElement>(null)
  const connectionStartRef = useRef<PendingCanvasConnection | null>(null)
  const moreActionsTriggerRef = useRef<HTMLButtonElement>(null)
  const runMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const selectedNodeSignatureRef = useRef('')
  const groupsRef = useRef<CanvasGroupSummary[]>([])
  const mediaPreparationRevisionRef = useRef(0)
  const appliedMediaSignatureRef = useRef(mediaGroupsSignature({}))
  const imageGroup = mediaGroups.image ?? null
  const videoGroup = mediaGroups.video ?? null

  useEffect(() => {
    if (!window.xingmangCanvasHost) return
    setProjectLoading(true)
    void hostBridge().listProjects().then(setProjects).catch((error) => setBanner(error instanceof Error ? error.message : String(error))).finally(() => setProjectLoading(false))
  }, [])

  useEffect(() => subscribeCanvasTheme(window.xingmangCanvasHost, (nextTheme) => {
    applyCanvasTheme(nextTheme)
    setTheme(nextTheme)
  }), [])

  const applyProjectUiPreferences = useCallback((next: CanvasUiPreferences) => {
    setUiPreferences(next)
    setMinimapOpen(next.minimapOpen)
    setFocusMode(next.focusMode)
    setInspectorTab(next.rightPanel ?? 'node')
    setAssetTrayOpen(next.rightPanel === 'assets')
    setRunInspectorOpen(next.rightPanel === 'runs')
  }, [])

  useEffect(() => {
    if (!activeProject || !projectHydrationRef.current) return
    setUiPreferences((current) => {
      const rightPanel: CanvasRightPanel = assetTrayOpen ? 'assets' : runInspectorOpen ? 'runs' : null
      if (current.rightPanel === rightPanel && current.minimapOpen === minimapOpen && current.focusMode === focusMode) return current
      return { ...current, rightPanel, minimapOpen, focusMode }
    })
  }, [activeProject, assetTrayOpen, focusMode, minimapOpen, runInspectorOpen])

  useEffect(() => {
    if (!activeProject || !projectHydrationRef.current) return
    writeCanvasUiPreferences(activeProject.id, uiPreferences)
  }, [activeProject, uiPreferences])

  const fitCanvas = useCallback(() => {
    window.requestAnimationFrame(() => {
      // Keep the overview complete for large graphs; focus mode raises the
      // floor slightly and is the readable path for editing a subset.
      void reactFlow.fitView({ padding: focusMode ? 0.2 : 0.14, minZoom: focusMode ? 0.26 : 0.2, maxZoom: 1, duration: 180 })
    })
  }, [focusMode, reactFlow])

  const toggleCanvasOverview = useCallback(() => {
    if (nodes.length === 0) return
    const restore = overviewViewportRef.current
    if (restore) {
      overviewViewportRef.current = null
      void reactFlow.setViewport(restore, { duration: 180 })
      setDocumentViewport(restore)
      return
    }
    overviewViewportRef.current = reactFlow.getViewport()
    void reactFlow.fitView({ padding: 0.14, minZoom: 0.15, maxZoom: 1, duration: 180 })
  }, [nodes.length, reactFlow, setDocumentViewport])

  const fitSelection = useCallback(() => {
    const selected = nodes.filter((node) => node.selected)
    if (selected.length === 0) {
      setBanner('请先选择要聚焦的节点')
      return
    }
    window.requestAnimationFrame(() => {
      void reactFlow.fitView({ nodes: selected, padding: 0.24, minZoom: 0.35, maxZoom: 1.18, duration: 180 })
    })
  }, [nodes, reactFlow])

  const restoreCanvasViewport = useCallback((nextViewport: Viewport) => {
    overviewViewportRef.current = null
    window.requestAnimationFrame(() => {
      void reactFlow.setViewport(nextViewport, { duration: 0 })
    })
  }, [reactFlow])

  useEffect(() => {
    if (nodes.length === 0) overviewViewportRef.current = null
  }, [nodes.length])

  const openStoredProject = useCallback(async (projectId: string) => {
    setProjectLoading(true)
    try {
      const opened = await hostBridge().openProject(projectId)
      const workflow = parseWorkflowFile(opened.content)
      if (!workflow) throw new Error('项目内容无法读取')
      const nextDocument = workflowDocument(workflow)
      projectHydrationRef.current = true
      execute({ type: 'replace-document', document: nextDocument })
      setActiveProject(opened.project)
      setProjects((current) => [opened.project, ...current.filter((project) => project.id !== opened.project.id)])
      setBanner(null)
      applyProjectUiPreferences(readCanvasUiPreferences(opened.project.id))
      setAutoSaveState('saved')
      restoreCanvasViewport(nextDocument.viewport)
    } catch (error) { setBanner(error instanceof Error ? error.message : String(error)) }
    finally { setProjectLoading(false) }
  }, [applyProjectUiPreferences, execute, restoreCanvasViewport])

  const createStoredProject = useCallback(async (name: string) => {
    setProjectLoading(true)
    try {
      const created = await hostBridge().createProject(name)
      if (!created) return false
      setProjects((current) => [created.project, ...current.filter((project) => project.id !== created.project.id)])
      await openStoredProject(created.project.id)
      return true
    } catch (error) { setBanner(error instanceof Error ? error.message : String(error)); return false }
    finally { setProjectLoading(false) }
  }, [openStoredProject])

  const renameStoredProject = useCallback(async (projectId: string, name: string) => {
    setProjectLoading(true)
    try {
      const renamed = await hostBridge().renameProject(projectId, name)
      setProjects((current) => current.map((project) => project.id === renamed.id ? renamed : project))
      setActiveProject((current) => current?.id === renamed.id ? renamed : current)
      setBanner(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setBanner(message)
      throw error instanceof Error ? error : new Error(message)
    }
    finally { setProjectLoading(false) }
  }, [])

  const duplicateStoredProject = useCallback(async (projectId: string, name: string) => {
    setProjectLoading(true)
    try {
      const duplicated = await hostBridge().duplicateProject(projectId, name)
      if (!duplicated) return false
      setProjects((current) => [duplicated.project, ...current.filter((project) => project.id !== duplicated.project.id)])
      setBanner(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setBanner(message)
      throw error instanceof Error ? error : new Error(message)
    }
    finally { setProjectLoading(false) }
  }, [])

  const setStoredProjectArchived = useCallback(async (projectId: string, archived: boolean) => {
    setProjectLoading(true)
    try {
      const updated = await hostBridge().setProjectArchived(projectId, archived)
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project))
      if (archived) setActiveProject((current) => current?.id === projectId ? null : current)
      setBanner(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setBanner(message)
      throw error instanceof Error ? error : new Error(message)
    }
    finally { setProjectLoading(false) }
  }, [])

  const prepareMediaConfiguration = useCallback(async (
    targetOrResolver: CanvasMediaGroups | ((availableGroups: readonly CanvasGroupSummary[]) => CanvasMediaGroups),
    preparationKind: MediaPreparationKind,
  ): Promise<PreparedMediaConfiguration | null> => {
    const requestRevision = mediaPreparationRevisionRef.current + 1
    mediaPreparationRevisionRef.current = requestRevision
    setPreparingMedia(preparationKind)
    try {
      const availableGroups = groupsRef.current.length > 0
        ? groupsRef.current
        : await hostBridge().listGroups()
      if (requestRevision !== mediaPreparationRevisionRef.current) return null
      groupsRef.current = [...availableGroups]
      setGroups([...availableGroups])
      const target = typeof targetOrResolver === 'function'
        ? targetOrResolver(availableGroups)
        : targetOrResolver
      const requestedGroups = [...new Set([target.image, target.video].filter((group): group is string => Boolean(group)))]
      for (const group of requestedGroups) {
        if (!availableGroups.some((entry) => entry.name === group)) throw new Error(`分组「${group}」已不存在，请重新选择`)
      }
      const preparedByGroup = new Map<string, Awaited<ReturnType<ReturnType<typeof hostBridge>['prepareGroup']>>>()
      await Promise.all(requestedGroups.map(async (group) => {
        preparedByGroup.set(group, await hostBridge().prepareGroup(group))
      }))
      if (requestRevision !== mediaPreparationRevisionRef.current) return null
      const preparedImage = target.image ? preparedByGroup.get(target.image) : undefined
      const preparedVideo = target.video ? preparedByGroup.get(target.video) : undefined
      return {
        mediaGroups: { ...(target.image ? { image: target.image } : {}), ...(target.video ? { video: target.video } : {}) },
        imageModels: [...(preparedImage?.models ?? [])],
        videoModels: [...(preparedVideo?.models ?? [])],
        keyCreatedGroups: requestedGroups.filter((group) => preparedByGroup.get(group)?.keyCreated),
        warnings: [...new Set(requestedGroups
          .map((group) => preparedByGroup.get(group)?.storageWarning)
          .filter((warning): warning is string => Boolean(warning)))],
      }
    } finally {
      if (requestRevision === mediaPreparationRevisionRef.current) setPreparingMedia(null)
    }
  }, [])

  const applyPreparedMediaConfiguration = useCallback((prepared: PreparedMediaConfiguration) => {
    setImageModels(prepared.imageModels)
    setVideoModels(prepared.videoModels)
    appliedMediaSignatureRef.current = mediaGroupsSignature(prepared.mediaGroups)
  }, [])

  useEffect(() => {
    if (!window.xingmangCanvasHost || !activeProject || imageGroup || videoGroup) return
    void prepareMediaConfiguration(preferredMediaGroups, 'all').then((prepared) => {
      if (!prepared || (!prepared.mediaGroups.image && !prepared.mediaGroups.video)) return
      applyPreparedMediaConfiguration(prepared)
      execute({ type: 'set-media-groups', mediaGroups: prepared.mediaGroups })
      if (prepared.warnings.length > 0) setBanner(prepared.warnings.join('；'))
    }).catch((error) => setBanner(error instanceof Error ? error.message : String(error)))
    return () => { mediaPreparationRevisionRef.current += 1 }
  }, [activeProject, applyPreparedMediaConfiguration, execute, imageGroup, prepareMediaConfiguration, videoGroup])

  useEffect(() => {
    if (!window.xingmangCanvasHost) return
    const target = { ...(imageGroup ? { image: imageGroup } : {}), ...(videoGroup ? { video: videoGroup } : {}) }
    const signature = mediaGroupsSignature(target)
    if (signature === appliedMediaSignatureRef.current) return
    void prepareMediaConfiguration(target, 'all').then((prepared) => {
      if (!prepared) return
      applyPreparedMediaConfiguration(prepared)
      if (prepared.warnings.length > 0) setBanner(prepared.warnings.join('；'))
    }).catch((error) => {
      setImageModels([])
      setVideoModels([])
      setBanner(error instanceof Error ? error.message : String(error))
    })
  }, [applyPreparedMediaConfiguration, imageGroup, prepareMediaConfiguration, videoGroup])

  const selectMediaGroup = useCallback(async (kind: 'image' | 'video', group: string) => {
    if (!group) return
    const otherKind = kind === 'image' ? 'video' : 'image'
    const previousOtherGroup = mediaGroups[otherKind]
    setBanner(`正在准备${kind === 'image' ? '生图' : '视频'}分组 API Key…`)
    try {
      const prepared = await prepareMediaConfiguration((availableGroups) => ({
        [kind]: group,
        ...(previousOtherGroup && availableGroups.some((entry) => entry.name === previousOtherGroup)
          ? { [otherKind]: previousOtherGroup }
          : {}),
      }), kind)
      if (!prepared) return
      applyPreparedMediaConfiguration(prepared)
      execute({ type: 'set-media-groups', mediaGroups: prepared.mediaGroups })
      const created = prepared.keyCreatedGroups.includes(group)
      const clearedInvalidGroup = previousOtherGroup && !prepared.mediaGroups[otherKind]
      setBanner(clearedInvalidGroup
        ? `已切换到「${group}」；原${otherKind === 'image' ? '生图' : '视频'}分组已失效并清除`
        : created
        ? `已自动创建「${group}」分组 API Key`
        : `${kind === 'image' ? '生图' : '视频'}已切换到「${group}」`)
      if (prepared.warnings.length > 0) setBanner(`分组已可用；${prepared.warnings.join('；')}`)
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [applyPreparedMediaConfiguration, execute, mediaGroups, prepareMediaConfiguration])

  const patchNodeData = useCallback((nodeId: string, patch: Partial<CanvasNode['data']>) => {
    setNodes((current) => current.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
    )))
  }, [setNodes])

  const markDirtyFrom = useCallback((nodeId: string, patch: Partial<WorkflowNodeData> = {}) => {
    const dirty = new Set<string>([nodeId])
    const queue = [nodeId]
    while (queue.length > 0) {
      const source = queue.shift() as string
      for (const edge of edges) {
        if (edge.source !== source || dirty.has(edge.target)) continue
        dirty.add(edge.target)
        queue.push(edge.target)
      }
    }
    const updated = markNodeAndDescendantsDirty(nodes, edges, nodeId, patch)
    execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord), mergeKey: `data:${nodeId}` })
    setNodes(updated)
    setDirtyNodeIds((current) => new Set([...current, ...dirty]))
  }, [nodes, edges, execute, setNodes])

  const setNodeFlags = useCallback((nodeIds: string[], flag: 'locked' | 'disabled', value: boolean) => {
    if (nodeIds.length === 0) return
    execute(flag === 'locked'
      ? { type: 'set-node-flags', nodeIds, locked: value }
      : { type: 'set-node-flags', nodeIds, disabled: value })
    const count = nodeIds.length
    setBanner(flag === 'locked'
      ? value ? `已锁定${count > 1 ? ` ${count} 个` : ''}节点位置` : `已解锁${count > 1 ? ` ${count} 个` : ''}节点位置`
      : value ? `已禁用${count > 1 ? ` ${count} 个` : ''}节点` : `已启用${count > 1 ? ` ${count} 个` : ''}节点`)
  }, [execute])

  const setInspectorNodeFlag = useCallback((nodeId: string, flag: 'locked' | 'disabled', value: boolean) => {
    setNodeFlags([nodeId], flag, value)
  }, [setNodeFlags])

  const buildExecutors = useCallback(() => (
    window.xingmangCanvasHost
      ? createHostExecutors({ imageGroup: imageGroup ?? '', videoGroup: videoGroup ?? '', host: hostBridge() })
      : createMockExecutors()
  ), [imageGroup, videoGroup])

  const requestNodeScopeRun = useCallback((nodeId: string, kind: 'to-node' | 'from-node'): boolean => {
    if (running) return false
    if (preparingMedia) {
      setBanner('生成配置正在准备，请稍候再运行节点')
      return false
    }
    if (resumingTaskIdsRef.current.size > 0) {
      setBanner('请等待视频任务续查完成后再运行节点')
      return false
    }
    const target = nodes.find((entry) => entry.id === nodeId)
    if (!target) return false
    if (target.disabled || target.type === 'unknown') {
      setBanner('该节点已禁用，不能单独运行')
      return false
    }
    if (!window.xingmangCanvasHost) {
      if (kind === 'from-node') setBanner('从此向后运行仅在桌面开发界面中可用')
      return false
    }
    try {
      const graph = toCanvasRunGraph(nodes, edges, { image: imageGroup ?? '', video: videoGroup ?? '' })
      const scope: CanvasRunScope = { kind, nodeId }
      const preflight = buildCanvasRunPreflight({
        graph,
        scope,
        imageGroup: imageGroup ?? undefined,
        videoGroup: videoGroup ?? undefined,
        imageModels,
        videoModels,
      })
      setRunPreflight(preflight)
      if (!preflight.canStart) {
        setBanner(preflight.warnings.filter((entry) => entry.includes('：')).join('；') || '当前节点无法执行')
        return false
      }
      setPendingCanvasRun({ graph, scope })
      setBanner(kind === 'from-node' ? '请确认从此向后的运行范围和额度风险' : '请确认运行到此的范围和额度风险')
      return true
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
      return false
    }
  }, [running, preparingMedia, nodes, edges, imageGroup, videoGroup, imageModels, videoModels])

  // 浏览器预览保留轻量单节点执行；桌面端始终经主进程预检和运行服务。
  const rerunNode = useCallback(async (nodeId: string) => {
    if (window.xingmangCanvasHost) {
      requestNodeScopeRun(nodeId, 'to-node')
      return
    }
    if (running || preparingMedia || resumingTaskIdsRef.current.size > 0) return
    const target = nodes.find((entry) => entry.id === nodeId)
    if (!target || target.disabled || target.type === 'unknown') return
    const inputs: NodeInputs = {}
    for (const edge of edges) {
      if (edge.target !== nodeId) continue
      const source = nodes.find((entry) => entry.id === edge.source)
      if (!source) continue
      if (rerunTextSourceKinds.has(source.type ?? '')) {
        inputs.text = inputs.text === undefined ? source.data.prompt : `${inputs.text}\n${source.data.prompt}`
      }
      if (rerunImageSourceKinds.has(source.type ?? '') && source.data.result?.kind === 'image') {
        inputs.image ??= source.data.result
        inputs.images = [...(inputs.images ?? []), source.data.result]
      }
      if (rerunVideoSourceKinds.has(source.type ?? '') && source.data.result?.kind === 'video') {
        inputs.video ??= source.data.result
        inputs.videos = [...(inputs.videos ?? []), source.data.result]
      }
      if (rerunAudioSourceKinds.has(source.type ?? '') && source.data.result?.kind === 'audio') {
        inputs.audio ??= source.data.result
        inputs.audios = [...(inputs.audios ?? []), source.data.result]
      }
    }
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    const runStartedAt = new Date().toISOString()
    patchNodeData(nodeId, { status: 'running', errorMessage: undefined, runStartedAt })
    try {
      const executors = buildExecutors()
      const result = await executors[target.type as NodeKind](toWorkflowNode(target), inputs, controller.signal)
      patchNodeData(nodeId, {
        status: 'succeeded',
        result: result.output.asset,
        costQuota: result.costQuota,
        latestAttemptDurationMs: Date.now() - Date.parse(runStartedAt),
        runStartedAt: undefined,
      })
    } catch (error) {
      patchNodeData(nodeId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        latestAttemptDurationMs: Date.now() - Date.parse(runStartedAt),
        runStartedAt: undefined,
      })
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }, [running, preparingMedia, nodes, edges, patchNodeData, buildExecutors, requestNodeScopeRun])

  const runFromNode = useCallback((nodeId: string) => {
    requestNodeScopeRun(nodeId, 'from-node')
  }, [requestNodeScopeRun])

  const downloadNodeAsset = useCallback(async (nodeId: string) => {
    const node = nodes.find((entry) => entry.id === nodeId)
    const asset = node?.data.result
    if (!asset?.assetId) return
    const saved = await hostBridge().saveAsset(asset.assetId)
    if (saved.saved) setBanner('产物已保存')
  }, [nodes])

  const showNodeAssetMenu = useCallback(async (nodeId: string) => {
    const assetId = nodes.find((entry) => entry.id === nodeId)?.data.result?.assetId
    if (assetId) await hostBridge().showAssetMenu(assetId)
  }, [nodes])

  const refreshAssets = useCallback(async (query: CanvasAssetQuery = assetQuery) => {
    setAssetsLoading(true)
    try {
      const page = await hostBridge().listAssets(query)
      setAssetPage(page)
      setAssetCatalog((current) => {
        const merged = new Map(current.map((asset) => [asset.assetId, asset]))
        for (const asset of page.items) merged.set(asset.assetId, asset)
        return [...merged.values()]
      })
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    } finally {
      setAssetsLoading(false)
    }
  }, [assetQuery])

  const renameCanvasAsset = useCallback(async (assetId: string, displayName: string) => {
    const renamed = await hostBridge().renameAsset({ assetId, displayName })
    setAssetPage((current) => ({
      ...current,
      items: current.items.map((asset) => asset.assetId === renamed.assetId
        ? { ...asset, displayName: renamed.displayName }
        : asset),
    }))
    setAssetCatalog((current) => current.map((asset) => asset.assetId === renamed.assetId
      ? { ...asset, displayName: renamed.displayName }
      : asset))
    setBanner('素材名称已更新')
    void refreshAssets()
  }, [refreshAssets])

  const updateCanvasAssetMetadata = useCallback(async (assetId: string, input: { favorite?: boolean; tags?: string[] }) => {
    const updated = await hostBridge().updateAssetMetadata({ assetId, ...input })
    const apply = <T extends CanvasAssetSummary>(asset: T): T => (asset.assetId === updated.assetId
      ? { ...asset, favorite: updated.favorite, tags: [...updated.tags], ...(updated.lastUsedAt ? { lastUsedAt: updated.lastUsedAt } : {}) }
      : asset) as T
    setAssetPage((current) => ({ ...current, items: current.items.map(apply) }))
    setAssetCatalog((current) => current.map(apply))
    setBanner(input.favorite === true ? '已收藏素材' : input.favorite === false ? '已取消收藏' : '素材标签已更新')
    void refreshAssets()
  }, [refreshAssets])

  const markCanvasAssetUsed = useCallback(async (assetId: string) => {
    try {
      const updated = await hostBridge().markAssetUsed(assetId)
      const apply = <T extends CanvasAssetSummary>(asset: T): T => (asset.assetId === updated.assetId ? { ...asset, lastUsedAt: updated.lastUsedAt } : asset) as T
      setAssetPage((current) => ({ ...current, items: current.items.map(apply) }))
      setAssetCatalog((current) => current.map(apply))
    } catch {
      // Usage ranking is auxiliary; a metadata write must not block canvas editing.
    }
  }, [])

  useEffect(() => {
    if (!window.xingmangCanvasHost) {
      void hostBridge().listAssets({ offset: 0, limit: 24, mediaType: 'all' }).then((page) => {
        setAssetPage(page)
        setAssetCatalog(page.items)
      }).catch(() => undefined)
    }
    void hostBridge().listPromptPresets().then(setUserPromptPresets).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!window.xingmangCanvasHost) return
    let active = true
    const query = { offset: 0, limit: 24, mediaType: 'all' as const, search: '', view: 'all' as const, source: 'all' as const, sort: 'created-desc' as const, tag: '' }
    setAssetQuery(query)
    setAssetPage({ items: [], offset: 0, limit: 24, total: 0, hasMore: false })
    setAssetCatalog([])
    if (!activeProject) return () => { active = false }
    setAssetsLoading(true)
    void hostBridge().listAssets(query).then((page) => {
      if (!active) return
      setAssetPage(page)
      setAssetCatalog(page.items)
    }).catch((error) => {
      if (active) setBanner(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (active) setAssetsLoading(false)
    })
    return () => { active = false }
  }, [activeProject?.id])

  const savePromptPreset = useCallback(async (nodeId: string) => {
    const prompt = nodes.find((node) => node.id === nodeId)?.data.prompt.trim()
    if (!prompt) return
    const firstLine = prompt.split(/\r?\n/, 1)[0].trim()
    try {
      const preset = await hostBridge().createPromptPreset({
        name: firstLine.slice(0, 60) || '未命名提示词',
        prompt,
      })
      setUserPromptPresets((current) => [preset, ...current.filter((entry) => entry.id !== preset.id)])
      setBanner('已保存到「创作库 / 提示词」')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [nodes])

  const deletePromptPreset = useCallback(async (id: string) => {
    try {
      if (await hostBridge().deletePromptPreset(id)) {
        setUserPromptPresets((current) => current.filter((entry) => entry.id !== id))
        setBanner('提示词预设已删除')
      }
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const updatePromptPreset = useCallback(async (id: string, patch: { name: string; prompt: string }) => {
    try {
      const updated = await hostBridge().updatePromptPreset({ id, ...patch })
      setUserPromptPresets((current) => [updated, ...current.filter((entry) => entry.id !== updated.id)])
      setBanner('提示词预设已更新')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const changeAssetQuery = useCallback((query: CanvasAssetQuery) => {
    const next = {
      offset: query.offset ?? 0,
      limit: query.limit ?? 24,
      mediaType: query.mediaType ?? 'all',
      search: query.search ?? '',
      view: query.view ?? 'all',
      tag: query.tag ?? '',
      source: query.source ?? 'all',
      sort: query.sort ?? (query.view === 'recent' ? 'used-desc' : 'created-desc'),
    }
    setAssetQuery(next)
    void refreshAssets(next)
  }, [refreshAssets])

  const refreshRuns = useCallback(async (projectRunId?: string) => {
    if (!window.xingmangCanvasHost) return
    setRunsLoading(true)
    try {
      const records = await hostBridge().listRuns()
      setRunRecords(records)
      if (projectRunId) {
        const completed = records.find((record) => record.runId === projectRunId)
        if (completed) {
          setSelectedRunId(completed.runId)
          setNodes((current) => projectRunRecordToNodes(current, completed))
          setDirtyNodeIds((current) => {
            const next = new Set(current)
            for (const record of completed.nodes) {
              if (record.state === 'succeeded' || record.state === 'cached') next.delete(record.nodeId)
              else next.add(record.nodeId)
            }
            return next
          })
          if (completed.status !== 'running') {
            setRunning(false)
            if (activeRunRef.current?.runId === completed.runId) activeRunRef.current = null
          }
        }
      } else if (!selectedRunId && records[0]) {
        setSelectedRunId(records[0].runId)
      }
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    } finally {
      setRunsLoading(false)
    }
  }, [selectedRunId, setNodes])

  const openInspectorTab = useCallback((tab: CanvasInspectorTab) => {
    if (focusMode && tab !== 'node') setFocusMode(false)
    setInspectorTab(tab)
    if (tab === 'assets') {
      setRunInspectorOpen(false)
      setAssetTrayOpen(true)
      void refreshAssets()
    } else if (tab === 'runs') {
      setAssetTrayOpen(false)
      setRunInspectorOpen(true)
      void refreshRuns()
    } else {
      setAssetTrayOpen(false)
      setRunInspectorOpen(false)
      setNodeInspectorOpen(true)
    }
  }, [focusMode, refreshAssets, refreshRuns])

  const closeInspector = useCallback(() => {
    if (inspectorTab === 'assets') setAssetTrayOpen(false)
    else if (inspectorTab === 'runs') setRunInspectorOpen(false)
    else setNodeInspectorOpen(false)
  }, [inspectorTab])

  const locateNode = useCallback((nodeId: string) => {
    const target = nodes.find((node) => node.id === nodeId)
    if (!target) {
      setBanner('节点已不在当前画布中')
      return
    }
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })))
    setInspectorTab('node')
    setAssetTrayOpen(false)
    setRunInspectorOpen(false)
    setNodeInspectorOpen(true)
    window.requestAnimationFrame(() => {
      void reactFlow.fitView({ nodes: [target], padding: 0.55, minZoom: 0.65, maxZoom: 1.15, duration: 220 })
    })
  }, [nodes, reactFlow, setNodes])

  const showAssetTray = useCallback(() => {
    openInspectorTab('assets')
  }, [openInspectorTab])

  const toggleAssetTray = useCallback(() => {
    if (inspectorTab === 'assets' && assetTrayOpen) closeInspector()
    else showAssetTray()
  }, [assetTrayOpen, closeInspector, inspectorTab, showAssetTray])

  const toggleRunInspector = useCallback(() => {
    if (inspectorTab === 'runs' && runInspectorOpen) closeInspector()
    else openInspectorTab('runs')
  }, [closeInspector, inspectorTab, openInspectorTab, runInspectorOpen])

  useEffect(() => hostBridge().onRunEvent((event) => {
    const active = activeRunRef.current
    if (!active || event.runId !== active.runId || event.graphRevision !== active.graphRevision) return
    setRunRecords((current) => mergeCanvasRunEvent(current, event))
    if (event.type === 'node-stage') {
      patchNodeData(event.nodeId, {
        runStage: event.stage,
        runProgress: event.progress,
        runProgressMode: event.progressMode,
        runHealth: event.health,
        status: event.stage === 'validating' || event.stage === 'resolving-cache' || event.stage === 'waiting-slot'
          ? 'queued'
          : 'running',
      })
    }
    if (event.type === 'node-state' && event.nodeId && event.state) {
      const state = event.state === 'cached' ? 'succeeded'
        : event.state === 'skipped' || event.state === 'cancelled' || event.state === 'interrupted'
          ? 'failed'
          : event.state === 'cancelling' ? 'running'
            : event.state as CanvasNode['data']['status']
      patchNodeData(event.nodeId, {
        status: state,
        // A cache hit collapses to 'succeeded' for run semantics, but the user
        // still needs to know nothing was paid for or regenerated.
        ...(['succeeded', 'cached'].includes(event.state) ? { fromCache: event.state === 'cached' } : {}),
        ...((event.state === 'queued' || event.state === 'running') ? { runStartedAt: event.at } : {}),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        ...(typeof event.costQuota === 'number' ? { costQuota: event.costQuota } : {}),
        ...(['succeeded', 'failed', 'skipped', 'cancelled', 'cached', 'interrupted'].includes(event.state) ? {
          runStartedAt: undefined, runStage: undefined, runProgress: undefined, runProgressMode: undefined, runHealth: undefined,
        } : {}),
      })
    }
    if (event.type === 'run-terminal') {
      setRunning(false)
      setBanner(`运行结束：${event.status ?? '已完成'}`)
      activeRunRef.current = null
      void refreshAssets({ ...assetQuery, offset: 0 })
      void refreshRuns(event.runId)
    }
  }), [patchNodeData, refreshAssets, refreshRuns, assetQuery])

  // 断线恢复:视频节点凭已落盘的 taskId 继续轮询(应用重启/中途关窗后
  // 打开工作流文件即可续查,不重新扣费提交任务)。
  const resumeTask = useCallback(async (nodeId: string) => {
    if (running) return
    const node = nodes.find((entry) => entry.id === nodeId)
    const taskId = node?.data.result?.taskId
    if (!taskId || resumingTaskIdsRef.current.has(taskId)) return
    resumingTaskIdsRef.current.add(taskId)
    setResumingTaskIds(new Set(resumingTaskIdsRef.current))
    setNodes((current) => current.map((entry) => (
      entry.id === nodeId && entry.data.result?.taskId === taskId
        ? { ...entry, data: { ...entry.data, status: 'running', errorMessage: undefined } }
        : entry
    )))
    setBanner(`正在安全续查视频任务 ${taskId}`)
    try {
      const asset = await hostBridge().resumeVideoTask(taskId)
      setNodes((current) => current.map((entry) => (
        entry.id === nodeId && entry.data.result?.taskId === taskId
          ? { ...entry, data: { ...entry.data, status: 'succeeded', result: generatedVideoAssetRef(asset), errorMessage: undefined } }
          : entry
      )))
      setBanner('视频续查完成，产物已保存到本地素材库')
      void refreshAssets({ ...assetQuery, offset: 0 })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      setNodes((current) => current.map((entry) => (
        entry.id === nodeId && entry.data.result?.taskId === taskId
          ? { ...entry, data: { ...entry.data, status: 'failed', errorMessage } }
          : entry
      )))
      setBanner(errorMessage)
    } finally {
      resumingTaskIdsRef.current.delete(taskId)
      setResumingTaskIds(new Set(resumingTaskIdsRef.current))
    }
  }, [running, nodes, setNodes, refreshAssets, assetQuery])

  const selectCandidate = useCallback((nodeId: string, candidate: string | WorkflowCandidateRef) => {
    setNodes((current) => selectNodeCandidate(current, nodeId, candidate))
  }, [setNodes])

  const adoptCandidate = useCallback((nodeId: string, candidate: string | WorkflowCandidateRef) => {
    const candidateId = typeof candidate === 'string' ? candidate : candidate.candidateId
    const stagedNodes = typeof candidate === 'string' ? nodes : selectNodeCandidate(nodes, nodeId, candidate)
    const owner = stagedNodes.find((node) => node.id === nodeId)
    const target = owner?.data.candidates?.find((entry) => entry.candidateId === candidateId)
    if (!owner || !target) {
      setBanner('候选已不在当前运行记录中')
      return
    }
    if (owner.data.adoptedCandidateId === candidateId && owner.data.result?.assetId === target.asset.assetId) {
      setBanner('该候选已经采纳')
      return
    }
    const updated = adoptNodeCandidate(
      stagedNodes,
      edges,
      nodeId,
      candidateId,
    )
    execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
    setNodes(updated)
    const descendants = new Set<string>()
    const queue = [nodeId]
    while (queue.length > 0) {
      const source = queue.shift() as string
      for (const edge of edges) {
        if (edge.source !== source || descendants.has(edge.target)) continue
        descendants.add(edge.target)
        queue.push(edge.target)
      }
    }
    setDirtyNodeIds((current) => new Set([...current].filter((id) => id !== nodeId).concat([...descendants])))
    setBanner('已采纳候选；下游节点等待重新运行')
  }, [nodes, edges, execute, setNodes])

  const discardCandidate = useCallback((nodeId: string, candidateId: string) => {
    const owner = nodes.find((node) => node.id === nodeId)
    if (!owner?.data.candidates?.some((candidate) => candidate.candidateId === candidateId)) {
      setBanner('该候选不在当前暂存区')
      return
    }
    if (owner.data.adoptedCandidateId === candidateId) {
      setBanner('已采纳结果不能丢弃，可先采纳其他候选')
      return
    }
    setNodes((current) => discardNodeCandidate(current, nodeId, candidateId))
    setBanner('候选已丢弃；已确认结果和下游状态保持不变')
  }, [nodes, setNodes])

  const bindAssetToNode = useCallback((nodeId: string, asset: CanvasAssetSummary) => {
    const target = nodes.find((node) => node.id === nodeId)
    const expectedMediaType = target?.type === 'audio-input' ? 'audio' : target?.type === 'video-input' ? 'video' : 'image'
    if (!target || asset.mediaType !== expectedMediaType) {
      setBanner(`该节点只接受${expectedMediaType === 'audio' ? '音频' : expectedMediaType === 'video' ? '视频' : '图片'}素材`)
      return
    }
    const descendants = new Set<string>()
    const queue = [nodeId]
    while (queue.length > 0) {
      const source = queue.shift() as string
      for (const edge of edges) {
        if (edge.source !== source || descendants.has(edge.target)) continue
        descendants.add(edge.target)
        queue.push(edge.target)
      }
    }
    const updated: CanvasNode[] = nodes.map((node): CanvasNode => {
      if (node.id === nodeId) {
        const dimensions = mediaAssetNodeDimensions(asset)
        return {
          ...node,
          width: dimensions.width,
          height: dimensions.height,
          style: { width: dimensions.width, height: dimensions.height },
          data: { ...node.data, result: mediaAssetRef(asset), status: 'succeeded', dirty: false, errorMessage: undefined },
        }
      }
      return descendants.has(node.id) ? { ...node, data: { ...node.data, dirty: true } } : node
    })
    execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
    setNodes(updated)
    setDirtyNodeIds((current) => new Set([...current].filter((id) => id !== nodeId).concat([...descendants])))
    setBanner(`${asset.mediaType === 'audio' ? '音频' : asset.mediaType === 'video' ? '视频' : '图片'}素材已就绪；下游节点等待重新运行`)
  }, [nodes, edges, execute, setNodes])

  const createAssetNode = useCallback((asset: CanvasAssetSummary, position?: XYPosition) => {
    const kind = assetInputNodeKind(asset)
    const definition = builtinNodeRegistry.require(kind)
    const dimensions = mediaAssetNodeDimensions(asset)
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    const preferredCenter = bounds
      ? reactFlow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 420, y: 300 }
    const resolvedPosition = position ?? findAvailableCanvasPosition(nodes, preferredCenter, dimensions)
    const canvasNode = toCanvasNode({
      id: nextNodeId(), kind, definitionVersion: definition.version,
      position: resolvedPosition,
      width: dimensions.width,
      height: dimensions.height,
      data: { prompt: '', model: '', status: 'succeeded', result: mediaAssetRef(asset) },
    })
    execute({ type: 'add-nodes', nodes: [canvasNodeDocumentRecord(canvasNode)] })
    if (!position) {
      window.requestAnimationFrame(() => {
        void reactFlow.setCenter(
          resolvedPosition.x + dimensions.width / 2,
          resolvedPosition.y + dimensions.height / 2,
          { zoom: Math.min(viewport.zoom, 1), duration: 180 },
        )
      })
    }
    setBanner(asset.mediaType === 'video' ? '视频已添加到画布' : asset.mediaType === 'audio' ? '音频已添加到画布' : '图片已导入到画布')
  }, [execute, nodes, reactFlow, viewport.zoom])

  const pickAssetForNode = useCallback(async (nodeId: string) => {
    try {
      const asset = await hostBridge().pickAsset()
      if (!asset) return
      bindAssetToNode(nodeId, importedAssetSummary(asset))
      void refreshAssets({ ...assetQuery, offset: 0 })
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [bindAssetToNode, refreshAssets, assetQuery])

  const pickAssetForTemplate = useCallback(async (): Promise<CanvasAssetSummary | null> => {
    try {
      const asset = await hostBridge().pickAsset()
      if (!asset) return null
      const summary = importedAssetSummary(asset)
      if (summary.mediaType !== 'image') {
        setBanner('行业模板当前只支持图片素材作为参考输入')
        return null
      }
      void refreshAssets({ ...assetQuery, offset: 0 })
      return summary
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [refreshAssets, assetQuery])

  const importAssetForNode = useCallback(async (nodeId: string, file: File) => {
    try {
      const asset = await hostBridge().importAssetFile(file)
      bindAssetToNode(nodeId, importedAssetSummary(asset))
      void refreshAssets({ ...assetQuery, offset: 0 })
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [bindAssetToNode, refreshAssets, assetQuery])

  const importAssetToCanvas = useCallback(async (file: File, position: XYPosition) => {
    try {
      const asset = await hostBridge().importAssetFile(file)
      createAssetNode(importedAssetSummary(asset), position)
      void refreshAssets({ ...assetQuery, offset: 0 })
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [createAssetNode, refreshAssets, assetQuery])

  const pickAssetToCanvas = useCallback(async () => {
    try {
      const asset = await hostBridge().pickAsset()
      if (!asset) return
      const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
      const position = bounds
        ? reactFlow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
        : undefined
      createAssetNode(importedAssetSummary(asset), position)
      void refreshAssets({ ...assetQuery, offset: 0 })
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [createAssetNode, reactFlow, refreshAssets, assetQuery])

  useEffect(() => {
    registerNodeChangeHandlers({
      onPromptChange: (nodeId, prompt) => markDirtyFrom(nodeId, { prompt }),
      onModelChange: (nodeId, model) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        const imageOperation = ['image', 'image-generate', 'image-edit'].includes(node?.type ?? '')
        const preset = imageOperation ? imageModelPreset(model) : null
        const currentResolution = node?.data.imageResolution ?? defaultImageResolution
        markDirtyFrom(nodeId, {
          model,
          ...(preset && !preset.resolutions.includes(currentResolution)
            ? { imageResolution: preset.resolutions[0] ?? defaultImageResolution }
            : {}),
        })
      },
      onQualityChange: (nodeId, quality) => markDirtyFrom(nodeId, { quality }),
      onImageResolutionChange: (nodeId, imageResolution) => markDirtyFrom(nodeId, { imageResolution }),
      onSizeChange: (nodeId, size) => markDirtyFrom(nodeId, { size }),
      onSecondsChange: (nodeId, seconds) => markDirtyFrom(nodeId, { seconds }),
      onSettingsChange: (nodeId, patch) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        markDirtyFrom(nodeId, { settings: { ...node?.data.settings, ...patch } })
      },
      onSavePromptPreset: (nodeId) => void savePromptPreset(nodeId),
      onRunToNode: (nodeId) => void rerunNode(nodeId),
      onRunFromNode: runFromNode,
      onDownloadAsset: (nodeId) => void downloadNodeAsset(nodeId),
      onShowAssetMenu: (nodeId) => void showNodeAssetMenu(nodeId),
      onResumeTask: (nodeId) => void resumeTask(nodeId),
      onSelectCandidate: selectCandidate,
      onAdoptCandidate: adoptCandidate,
      onDiscardCandidate: discardCandidate,
      onShowCandidateMenu: (assetId) => void hostBridge().showAssetMenu(assetId),
      onBindAsset: (nodeId, assetId) => {
        const asset = assetPage.items.find((entry) => entry.assetId === assetId)
        if (asset) bindAssetToNode(nodeId, asset)
      },
      onPickAsset: (nodeId) => void pickAssetForNode(nodeId),
      onImportAssetFile: (nodeId, file) => void importAssetForNode(nodeId, file),
      onPreviewAsset: setPreviewAsset,
      onMediaMetadata: (nodeId, assetId, width, height) => {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return
        const target = nodes.find((node) => node.id === nodeId)
        if (target?.data.result?.assetId !== assetId || !['image', 'video'].includes(target.data.result.kind)) return
        const result = { ...target.data.result, width, height }
        const resizeNode = ['image-input', 'video-input'].includes(target.type ?? '')
        const dimensions = resizeNode
          ? mediaAssetNodeDimensions(result)
          : mediaResultNodeDimensions(target.type ?? '', result, target.width ?? 304, target.height ?? 360, target.data.size)
        if (target.data.result.width === width && target.data.result.height === height
          && (!dimensions || (target.width === dimensions.width && target.height === dimensions.height))) return
        const updated = nodes.map((node) => node.id === nodeId
          ? {
              ...node,
              ...(dimensions ? {
                width: dimensions.width,
                height: dimensions.height,
                style: { ...node.style, width: dimensions.width, height: dimensions.height },
              } : {}),
              data: { ...node.data, result },
            }
          : node)
        // Metadata is discovered by the media element after import. Persist it
        // so reopening the project does not fall back to a generic 16:9 frame.
        execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord), mergeKey: `media-metadata:${nodeId}` })
        setNodes(updated)
      },
    })
  }, [nodes, execute, markDirtyFrom, savePromptPreset, rerunNode, runFromNode, downloadNodeAsset, showNodeAssetMenu, resumeTask, selectCandidate, adoptCandidate, discardCandidate, assetPage.items, bindAssetToNode, pickAssetForNode, importAssetForNode])

  const createNode = (type: string, position?: XYPosition, config: Record<string, unknown> = {}): CanvasNode | null => {
    const kind = type as NodeKind
    const definition = builtinNodeRegistry.resolve(type)
    if (!definition || kind === 'unknown') return null
    const node: WorkflowNode = {
      id: nextNodeId(),
      kind,
      definitionVersion: definition.version,
      position: position ?? { x: 120 + Math.random() * 240, y: 120 + Math.random() * 160 },
      width: definition.dimensions.width,
      height: definition.dimensions.height,
      data: workflowNodeData(type, { ...imageOperationDefaults(type, imageModels, videoModels), ...config }),
    }
    return toCanvasNode(node)
  }

  const addNode = (type: string, position?: XYPosition, config: Record<string, unknown> = {}) => {
    const node = createNode(type, position, config)
    if (!node) return
    execute({ type: 'add-nodes', nodes: [canvasNodeDocumentRecord(node)] })
  }

  const addConnectedNode = (
    type: string,
    position: XYPosition | undefined,
    pending: PendingCanvasConnection,
    insertedHandleId: string,
  ) => {
    const node = createNode(type, position)
    if (!node) return
    const connection = connectionForInsertedNode(pending, node.id, insertedHandleId)
    const prospectiveTypes = new Map<string, string>(nodes.map((entry) => [entry.id, entry.type ?? 'unknown']))
    prospectiveTypes.set(node.id, type as NodeKind)
    if (!isValidWorkflowConnection(connection, {
      nodeKindOf: (nodeId) => prospectiveTypes.get(nodeId) ?? null,
      edges,
    })) {
      setBanner('当前端口已无法连接，请重新拖动连线')
      return
    }
    execute({
      type: 'add-nodes',
      nodes: [canvasNodeDocumentRecord(node)],
      edges: [{
        id: nextNodeId(),
        source: connection.source,
        sourceHandle: connection.sourceHandle ?? '',
        target: connection.target,
        targetHandle: connection.targetHandle ?? '',
      }],
    })
    setBanner(`已创建并连接「${builtinNodeRegistry.require(type).title}」`)
  }

  const insertNodeOnEdge = (
    type: string,
    position: XYPosition | undefined,
    edgeId: string,
    handles: string,
  ) => {
    const [inputHandle, outputHandle] = handles.split('|')
    if (!inputHandle || !outputHandle) return
    const original = edges.find((edge) => edge.id === edgeId)
    const node = createNode(type, position)
    if (!original || !node) return
    const before = {
      id: nextNodeId(),
      source: original.source,
      sourceHandle: original.sourceHandle ?? '',
      target: node.id,
      targetHandle: inputHandle,
    }
    const after = {
      id: nextNodeId(),
      source: node.id,
      sourceHandle: outputHandle,
      target: original.target,
      targetHandle: original.targetHandle ?? '',
    }
    const prospectiveTypes = new Map(nodes.map((entry) => [entry.id, entry.type ?? 'unknown']))
    prospectiveTypes.set(node.id, type as NodeKind)
    const remainingEdges = edges.filter((edge) => edge.id !== edgeId)
    if (!isValidWorkflowConnection(before, { nodeKindOf: (nodeId) => prospectiveTypes.get(nodeId) ?? null, edges: remainingEdges })
      || !isValidWorkflowConnection(after, { nodeKindOf: (nodeId) => prospectiveTypes.get(nodeId) ?? null, edges: [...remainingEdges, before] })) {
      setBanner('该节点无法插入当前连线')
      return
    }
    execute({ type: 'insert-node-on-edge', node: canvasNodeDocumentRecord(node), edgeId, before, after })
    setBanner(`已在连线上插入「${builtinNodeRegistry.require(type).title}」`)
  }

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    execute({
      type: 'connect',
      edge: {
        id: nextNodeId(),
        source: connection.source,
        sourceHandle: connection.sourceHandle ?? '',
        target: connection.target,
        targetHandle: connection.targetHandle ?? '',
      },
    })
  }, [execute])

  const onCanvasNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    if (altDragSessionRef.current && changes.some((change) => change.type === 'position')) {
      // Preview the copied gesture without recording movement for the originals.
      // The final frame is committed as one add-nodes history entry on drag stop.
      setNodes((current) => applyNodeChanges(changes, current))
      return
    }
    onNodesChange(changes)
  }, [onNodesChange, setNodes])

  const onCanvasNodeDragStart = useCallback((event: MouseEvent | TouchEvent, node: CanvasNode, draggedNodes: CanvasNode[]) => {
    if (!('altKey' in event) || !event.altKey) return
    const sources = draggedNodes.length > 0 ? draggedNodes : [node]
    altDragSessionRef.current = {
      nodeIds: sources.map((entry) => entry.id),
      originalPositions: new Map(sources.map((entry) => [entry.id, { ...entry.position }])),
      preserveInputConnections: event.shiftKey,
    }
  }, [])

  const onCanvasNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: CanvasNode, draggedNodes: CanvasNode[]) => {
    const session = altDragSessionRef.current
    if (!session) return
    altDragSessionRef.current = null

    // useReactFlow returns an empty array before the flow mounts, so an
    // emptiness check replaces the old null-instance fallback.
    const storeNodes = reactFlow.getNodes()
    const liveNodes = storeNodes.length > 0 ? storeNodes : (draggedNodes.length > 0 ? draggedNodes : [node])
    const liveById = new Map(liveNodes.map((entry) => [entry.id, entry]))
    const sourceRecords = nodes.map((entry) => {
      const live = liveById.get(entry.id)
      return canvasNodeDocumentRecord(live ?? entry)
    })
    const duplicated = duplicateCanvasNodesForAltDrag(sourceRecords, edges.map(toWorkflowEdge), {
      nodeIds: session.nodeIds,
      preserveInputConnections: session.preserveInputConnections,
      createNodeId: () => nextNodeId(),
      createEdgeId: () => nextNodeId(),
    })
    if (duplicated.nodes.length === 0) return

    // React Flow has already previewed movement on the original ids. Restore
    // them synchronously before the document command seeds its undo snapshot.
    flushSync(() => {
      setNodes((current) => current.map((entry) => {
        const original = session.originalPositions.get(entry.id)
        return original ? { ...entry, position: { ...original } } : entry
      }))
    })
    execute({ type: 'add-nodes', nodes: duplicated.nodes, edges: duplicated.edges })
    const duplicateIds = new Set(duplicated.nodes.map((entry) => entry.id))
    window.requestAnimationFrame(() => {
      setNodes((current) => current.map((entry) => ({ ...entry, selected: duplicateIds.has(entry.id) })))
    })
    setBanner(session.preserveInputConnections
      ? `已复制 ${duplicated.nodes.length} 个节点并保留输入连接`
      : `已复制 ${duplicated.nodes.length} 个节点`)
  }, [edges, execute, nodes, reactFlow, setNodes])

  const autoLayout = useCallback(() => {
    if (nodes.length === 0) return
    const laidOut = autoLayoutCanvasNodes(
      nodes.map((node) => ({
        id: node.id, type: node.type ?? 'unknown', definitionVersion: node.definitionVersion,
        position: node.position, data: node.data, width: node.measured?.width, height: node.measured?.height,
        ...(node.draggable === false ? { locked: true } : {}),
        ...(node.disabled ? { disabled: true } : {}),
        ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
      })),
      edges.map(toWorkflowEdge),
    )
    const positions = new Map(laidOut.map((node) => [node.id, node.position]))
    execute({ type: 'move-nodes', positions: Object.fromEntries(positions) })
  }, [nodes, edges, execute])

  const insertTemplate = useCallback((templateId: string, values?: Readonly<Record<string, unknown>>, draft = true) => {
    const template = builtinCanvasTemplates.find((entry) => entry.id === templateId)
    if (!template) return
    try {
      const instance = placeTemplateInstance(instantiateTemplate(template, {
        ...(values ? { values } : {}),
        availableNodeTypes: new Set(builtinNodeRegistry.list().map((definition) => definition.type)),
        createId: nextNodeId,
        draft,
      }), nodes.map((node) => ({ position: node.position, height: node.measured?.height ?? node.height })))
      const insertedNodes = instance.nodes.map((node) => {
        const definition = builtinNodeRegistry.require(node.type)
        return toCanvasNode({
          id: node.id,
          kind: node.type as NodeKind,
          definitionVersion: node.definitionVersion,
          position: node.position,
          width: definition.dimensions.width,
          height: definition.dimensions.height,
          data: workflowNodeData(node.type, operationDefaultsForTemplateNode(node.type, imageModels, videoModels, node.config).config),
        })
      })
      execute({
        type: 'add-nodes',
        nodes: insertedNodes.map(canvasNodeDocumentRecord),
        edges: instance.edges.map((edge) => ({ ...edge })),
      })
      setBanner(`已插入模板「${template.name}」`)
      setTemplateCatalog(null)
      fitCanvas()
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [nodes, execute, fitCanvas, imageModels, videoModels])

  const openTemplateCatalog = useCallback((templateId?: string) => {
    setQuickInsert(null)
    setTemplateCatalog(templateId ? { initialTemplateId: templateId } : {})
  }, [])

  const addAssetNode = useCallback((assetId: string, position?: { x: number; y: number }) => {
    const asset = assetPage.items.find((entry) => entry.assetId === assetId)
    if (!asset) return
    createAssetNode(asset, position)
    void markCanvasAssetUsed(assetId)
  }, [assetPage.items, createAssetNode, markCanvasAssetUsed])

  const copySelection = useCallback(() => {
    const selected = new Set(nodes.filter((node) => node.selected).map((node) => node.id))
    if (selected.size === 0) return
    clipboardRef.current = buildCanvasClipboardPayload(
      nodes.map((node) => ({
        id: node.id,
        type: node.type ?? 'unknown',
        definitionVersion: node.definitionVersion,
        position: { ...node.position },
        data: structuredClone(node.data),
        ...(node.disabled ? { disabled: true } : {}),
        ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.measured?.width ? { width: node.measured.width } : {}),
        ...(node.measured?.height ? { height: node.measured.height } : {}),
        ...(node.draggable === false ? { locked: true } : {}),
      })),
      edges.map(toWorkflowEdge),
      selected,
    )
    setBanner(`已复制 ${selected.size} 个节点`)
  }, [nodes, edges])

  const pasteSelection = useCallback(() => {
    const clipboard = clipboardRef.current
    if (!clipboard || clipboard.nodes.length === 0) return
    const pasted = pasteCanvasClipboard(clipboard, {
      offset: { x: 32, y: 32 },
      createNodeId: () => nextNodeId(),
      createEdgeId: () => nextNodeId(),
    })
    const pastedNodes = pasted.nodes.map((node) => toCanvasNode({
        id: node.id,
        kind: node.type as NodeKind,
        definitionVersion: node.definitionVersion,
        position: node.position,
        data: node.data as unknown as WorkflowNode['data'],
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.width ? { width: node.width } : {}),
        ...(node.height ? { height: node.height } : {}),
        ...(node.locked ? { locked: true } : {}),
        ...(node.disabled ? { disabled: true } : {}),
        ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
      }))
    execute({ type: 'add-nodes', nodes: pastedNodes.map(canvasNodeDocumentRecord), edges: pasted.edges })
  }, [execute])

  const groupSelection = useCallback(() => {
    const selected = new Set(nodes.filter((node) => node.selected && node.type !== 'group').map((node) => node.id))
    const editorNodes = nodes.map((node) => ({
      id: node.id,
      type: node.type ?? 'unknown',
      definitionVersion: node.definitionVersion,
      position: { ...node.position },
      data: structuredClone(node.data),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.measured?.width ? { width: node.measured.width } : {}),
      ...(node.measured?.height ? { height: node.measured.height } : {}),
      ...(node.draggable === false ? { locked: true } : {}),
    }))
    const grouped = groupCanvasNodes(editorNodes, selected, { groupId: nextNodeId(), title: '创作分组' })
    if (!grouped) return
    const updated = grouped.map((node) => toCanvasNode({
      id: node.id,
      kind: node.type as NodeKind,
      definitionVersion: node.definitionVersion,
      position: node.position,
      data: node.type === 'group'
        ? workflowNodeData('group', node.data)
        : node.data as unknown as WorkflowNode['data'],
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(node.locked ? { locked: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    }))
    execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
  }, [nodes, execute])

  const ungroupSelection = useCallback(() => {
    const group = nodes.find((node) => node.selected && node.type === 'group')
    if (!group) return
    const ungrouped = ungroupCanvasNode(nodes.map((node) => ({
      id: node.id,
      type: node.type ?? 'unknown',
      definitionVersion: node.definitionVersion,
      position: { ...node.position },
      data: structuredClone(node.data),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.measured?.width ? { width: node.measured.width } : {}),
      ...(node.measured?.height ? { height: node.measured.height } : {}),
      ...(node.draggable === false ? { locked: true } : {}),
    })), group.id)
    if (!ungrouped) return
    const updated = ungrouped.map((node) => toCanvasNode({
      id: node.id,
      kind: node.type as NodeKind,
      definitionVersion: node.definitionVersion,
      position: node.position,
      data: node.data as unknown as WorkflowNode['data'],
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(node.locked ? { locked: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    }))
    execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
  }, [nodes, execute])

  const openContextMenuFor = useCallback((event: { clientX: number; clientY: number; preventDefault(): void }, node: CanvasNode) => {
    event.preventDefault()
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    if (!bounds) return
    // Right-clicking an unselected node acts on that node alone; right-clicking
    // inside an existing selection acts on the whole selection. This is the
    // file-manager convention and users rely on it for batch actions.
    const selected = nodes.filter((entry) => entry.selected)
    const scope = selected.some((entry) => entry.id === node.id) && selected.length > 1 ? selected : [node]
    const disableEligible = scope.filter((entry) => entry.type !== 'unknown')
    setQuickInsert(null)
    setContextMenu({
      nodeId: node.id,
      x: Math.max(8, Math.min(bounds.width - 190, event.clientX - bounds.left)),
      y: Math.max(8, Math.min(bounds.height - 260, event.clientY - bounds.top)),
      target: scope.length > 1 ? 'selection' : 'node',
      selectionCount: scope.length,
      executable: builtinNodeRegistry.resolve(node.type ?? 'unknown')?.executable === true,
      running: node.data.status === 'running' || node.data.status === 'queued',
      hasGroup: scope.some((entry) => entry.type === 'group'),
      allLocked: scope.every((entry) => entry.draggable === false),
      allDisabled: disableEligible.length > 0 && disableEligible.every((entry) => entry.disabled === true),
      canDisable: disableEligible.length > 0,
    })
  }, [nodes])

  const deleteSelection = useCallback(() => {
    const nodeIds = nodes.filter((node) => node.selected).map((node) => node.id)
    if (nodeIds.length === 0) return
    execute({ type: 'delete-elements', nodeIds })
    setBanner(`已删除 ${nodeIds.length} 个节点`)
  }, [execute, nodes])

  const isValidConnection = useCallback((connection: Connection | Edge) => (
    isValidWorkflowConnection(connection as Connection, {
      nodeKindOf: (nodeId) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        return (node?.type as NodeKind | undefined) ?? null
      },
      edges,
    })
  ), [nodes, edges])

  // Retargeting an existing connection. Without it, moving where a wire lands
  // means delete plus redraw, which is two undo steps for one intention.
  const onReconnect = useCallback((edge: Edge, connection: Connection) => {
    if (!connection.source || !connection.target) return
    // Validate against the graph *without* this edge. Leaving it in makes a
    // single-capacity target reject the very wire that already occupies it.
    const valid = isValidWorkflowConnection(connection, {
      nodeKindOf: (nodeId) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        return (node?.type as NodeKind | undefined) ?? null
      },
      edges: edges.filter((entry) => entry.id !== edge.id),
    })
    if (!valid) {
      setBanner('该端口不接受这条连线')
      return
    }
    execute({
      type: 'reconnect-edge',
      edgeId: edge.id,
      edge: {
        id: edge.id,
        source: connection.source,
        sourceHandle: connection.sourceHandle ?? '',
        target: connection.target,
        targetHandle: connection.targetHandle ?? '',
      },
    })
  }, [edges, execute, nodes])

  const openQuickInsertAt = useCallback((client: { x: number; y: number }, connection?: PendingCanvasConnection) => {
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    if (!bounds) return
    let compatibleHandles: Record<string, string> | undefined
    if (connection) {
      const graph = {
        nodeKindOf: (nodeId: string) => nodes.find((entry) => entry.id === nodeId)?.type ?? null,
        edges,
      }
      compatibleHandles = Object.fromEntries(builtinNodeRegistry.list().flatMap((definition) => {
        const handleId = compatibleInsertionHandle(definition.type, connection, graph)
        return handleId ? [[definition.type, handleId]] : []
      }))
      if (Object.keys(compatibleHandles).length === 0) {
        setBanner('没有可连接到该端口的节点')
        return
      }
    }
    setRunMenuOpen(false)
    setMoreActionsOpen(false)
    setMediaConfigOpen(false)
    setQuickInsert({
      anchor: {
        x: Math.max(12, Math.min(bounds.width - 372, client.x - bounds.left - 180)),
        y: Math.max(12, Math.min(bounds.height - 430, client.y - bounds.top - 70)),
      },
      flowPosition: reactFlow.screenToFlowPosition(client),
      ...(connection ? { connection, compatibleHandles } : {}),
    })
  }, [edges, nodes, reactFlow])

  const openEdgeQuickInsertAt = useCallback((client: { x: number; y: number }, edge: Edge) => {
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    if (!bounds) return
    const remainingEdges = edges.filter((entry) => entry.id !== edge.id)
    const graph = {
      nodeKindOf: (nodeId: string) => nodes.find((entry) => entry.id === nodeId)?.type ?? null,
      edges: remainingEdges,
    }
    const sourceConnection: PendingCanvasConnection = { nodeId: edge.source, handleId: edge.sourceHandle ?? '', handleType: 'source' }
    const targetConnection: PendingCanvasConnection = { nodeId: edge.target, handleId: edge.targetHandle ?? '', handleType: 'target' }
    const compatibleHandles = Object.fromEntries(builtinNodeRegistry.list().flatMap((definition) => {
      const inputHandle = compatibleInsertionHandle(definition.type, sourceConnection, graph)
      const outputHandle = compatibleInsertionHandle(definition.type, targetConnection, graph)
      return inputHandle && outputHandle ? [[definition.type, `${inputHandle}|${outputHandle}`]] : []
    }))
    if (Object.keys(compatibleHandles).length === 0) {
      setBanner('没有可插入当前连线的节点')
      return
    }
    setRunMenuOpen(false)
    setMoreActionsOpen(false)
    setMediaConfigOpen(false)
    setQuickInsert({
      anchor: {
        x: Math.max(12, Math.min(bounds.width - 372, client.x - bounds.left - 180)),
        y: Math.max(12, Math.min(bounds.height - 430, client.y - bounds.top - 70)),
      },
      flowPosition: reactFlow.screenToFlowPosition(client),
      edgeId: edge.id,
      compatibleHandles,
    })
  }, [edges, nodes, reactFlow])

  const runContextAction = useCallback((action: CanvasContextAction, nodeId: string) => {
    const scopeIds = contextMenu && contextMenu.selectionCount > 1
      ? nodes.filter((node) => node.selected).map((node) => node.id)
      : [nodeId]
    const disableEligible = nodes
      .filter((node) => scopeIds.includes(node.id) && node.type !== 'unknown')
      .map((node) => node.id)
    if (action === 'run') { void rerunNode(nodeId); return }
    if (action === 'locate') { locateNode(nodeId); return }
    if (action === 'copy') { copySelection(); return }
    if (action === 'duplicate') { copySelection(); pasteSelection(); return }
    if (action === 'group') { groupSelection(); return }
    if (action === 'ungroup') { ungroupSelection(); return }
    if (action === 'lock' || action === 'unlock') { setNodeFlags(scopeIds, 'locked', action === 'lock'); return }
    if (action === 'disable' || action === 'enable') { setNodeFlags(disableEligible, 'disabled', action === 'disable'); return }
    if (action === 'delete') {
      execute({ type: 'delete-elements', nodeIds: scopeIds })
      setBanner(`已删除 ${scopeIds.length} 个节点`)
    }
  }, [contextMenu, copySelection, execute, groupSelection, locateNode, nodes, pasteSelection, rerunNode, setNodeFlags, ungroupSelection])

  // Handed to the custom edge through context rather than through edge data, so
  // the callbacks are not serialized into the document on every render.
  const edgeHandlers = useMemo(() => ({
    onDisconnect: (edgeId: string) => execute({ type: 'disconnect', edgeIds: [edgeId] }),
    onInsertNode: (edgeId: string, client: { x: number; y: number }) => {
      const edge = edges.find((entry) => entry.id === edgeId)
      if (edge) openEdgeQuickInsertAt(client, edge)
    },
  }), [edges, execute, openEdgeQuickInsertAt])

  const onConnectStart = useCallback((_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    connectionStartRef.current = params.nodeId && params.handleId && (params.handleType === 'source' || params.handleType === 'target')
      ? { nodeId: params.nodeId, handleId: params.handleId, handleType: params.handleType }
      : null
  }, [])

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const pending = connectionStartRef.current
    connectionStartRef.current = null
    if (!pending || state.isValid === true) return
    const point = connectionEventPoint(event)
    if (!point) return
    // A node can re-measure while a connection preview is active (for example
    // when upstream references expand). Accept the nearest compatible target
    // handle within a small radius before falling back to the quick insert
    // palette, so a valid drop is not lost on a moving handle.
    const expectedType = pending.handleType === 'source' ? 'target' : 'source'
    let nearest: { distance: number; connection: Connection } | null = null
    for (const element of document.querySelectorAll<HTMLElement>('.react-flow__handle')) {
      if (element.dataset.nodeid === pending.nodeId || !element.classList.contains(`react-flow__handle-${expectedType}`)) continue
      const rect = element.getBoundingClientRect()
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      const distance = Math.hypot(center.x - point.x, center.y - point.y)
      if (distance > 80) continue
      const nodeId = element.dataset.nodeid
      const handleId = element.dataset.handleid
      if (!nodeId || !handleId) continue
      const candidate: Connection = pending.handleType === 'source'
        ? { source: pending.nodeId, sourceHandle: pending.handleId, target: nodeId, targetHandle: handleId }
        : { source: nodeId, sourceHandle: handleId, target: pending.nodeId, targetHandle: pending.handleId }
      if (!isValidConnection(candidate)) continue
      if (!nearest || distance < nearest.distance) nearest = { distance, connection: candidate }
    }
    if (nearest) {
      onConnect(nearest.connection)
      return
    }
    openQuickInsertAt(point, pending)
  }, [isValidConnection, onConnect, openQuickInsertAt])

  const selectedNodes = nodes.filter((node) => node.selected)
  const selectedNodeIds = selectedNodes.map((node) => node.id)
  const allSelectedLocked = selectedNodes.length > 0 && selectedNodes.every((node) => node.draggable === false)
  const selectedDisableEligibleNodes = selectedNodes.filter(isCanvasGraphNode)
  const selectedDisableEligibleIds = selectedDisableEligibleNodes.map((node) => node.id)
  const allSelectedDisabled = selectedDisableEligibleNodes.length > 0 && selectedDisableEligibleNodes.every((node) => node.disabled)
  const selectedNodeSignature = [...selectedNodeIds].sort().join('\0')
  const selectedRunnableCount = nodes.filter((node) => node.selected && isCanvasRunnableTarget(node)).length
  useEffect(() => {
    const previous = selectedNodeSignatureRef.current
    selectedNodeSignatureRef.current = selectedNodeSignature
    if (!selectedNodeSignature || selectedNodeSignature === previous) return
    if (assetTrayOpen || runInspectorOpen) return
    setInspectorTab('node')
    setNodeInspectorOpen(true)
  }, [assetTrayOpen, runInspectorOpen, selectedNodeSignature])
  const runScopeLabel = runScopeKind === 'all'
    ? '运行全部'
    : runScopeKind === 'dirty'
      ? `运行变更${dirtyNodeIds.size ? ` (${dirtyNodeIds.size})` : ''}`
      : runScopeKind === 'selection'
        ? `运行选中${selectedRunnableCount ? ` (${selectedRunnableCount})` : ''}`
        : runScopeKind === 'from-node'
          ? '从此向后'
          : '运行到此'
  const runScopeOptions: ReadonlyArray<{
    kind: CanvasRunScope['kind']
    label: string
    description: string
    disabled: boolean
  }> = [
    { kind: 'all', label: '运行全部', description: '执行当前工作流中的全部可运行节点', disabled: nodes.length === 0 },
    { kind: 'dirty', label: `仅运行变更 (${dirtyNodeIds.size})`, description: '重新执行输入或结果发生变化的链路', disabled: dirtyNodeIds.size === 0 },
    { kind: 'selection', label: `运行选中链路 (${selectedRunnableCount})`, description: '执行选中节点及其上游依赖', disabled: selectedRunnableCount === 0 },
    { kind: 'to-node', label: '运行到选中节点', description: '需要且只能选择一个可运行节点', disabled: selectedRunnableCount !== 1 },
    { kind: 'from-node', label: '从选中节点向后运行', description: '执行下游链路并补齐必要依赖', disabled: selectedRunnableCount !== 1 },
  ]
  const activeRunOption = runScopeOptions.find((option) => option.kind === runScopeKind) ?? runScopeOptions[0]

  const currentRunScope = useCallback((): CanvasRunScope => {
    const runnableIds = new Set(nodes.filter(isCanvasRunnableTarget).map((node) => node.id))
    if (runScopeKind === 'all') return { kind: 'all' }
    if (runScopeKind === 'dirty') {
      const nodeIds = nodes.map((node) => node.id).filter((id) => runnableIds.has(id) && dirtyNodeIds.has(id))
      if (nodeIds.length === 0) throw new Error('当前没有需要重新运行的节点')
      return { kind: 'dirty', nodeIds }
    }
    if (runScopeKind === 'selection') {
      const nodeIds = selectedNodeIds.filter((id) => runnableIds.has(id))
      if (nodeIds.length === 0) throw new Error('请先选择可运行的节点')
      return { kind: 'selection', nodeIds }
    }
    const nodeIds = selectedNodeIds.filter((id) => runnableIds.has(id))
    if (nodeIds.length !== 1) throw new Error('该运行范围需要且只能选择一个可运行节点')
    return { kind: runScopeKind === 'from-node' ? 'from-node' : 'to-node', nodeId: nodeIds[0] }
  }, [runScopeKind, nodes, dirtyNodeIds, selectedNodeIds])

  const confirmCanvasRun = useCallback(async () => {
    const pending = pendingCanvasRun
    if (!pending || running) return
    try {
      const currentGraph = toCanvasRunGraph(nodes, edges, { image: imageGroup ?? '', video: videoGroup ?? '' })
      const currentPreflight = buildCanvasRunPreflight({
        graph: currentGraph,
        scope: pending.scope,
        imageGroup: imageGroup ?? undefined,
        videoGroup: videoGroup ?? undefined,
        imageModels,
        videoModels,
      })
      if (!sameCanvasRunGraphSnapshot(pending.graph, currentGraph)) {
        setRunPreflight(currentPreflight)
        setPendingCanvasRun(currentPreflight.canStart ? { graph: currentGraph, scope: pending.scope } : null)
        setBanner(currentPreflight.canStart
          ? '工作流在确认期间发生变化，请核对新的运行范围后再次确认'
          : '工作流在确认期间发生变化，请先修复新的阻塞项')
        return
      }
      if (!currentPreflight.canStart) {
        setRunPreflight(currentPreflight)
        setPendingCanvasRun(null)
        setBanner('当前运行范围出现新的阻塞项，请先修复后重新运行')
        return
      }
      setRunPreflight(null)
      setPendingCanvasRun(null)
      setRunning(true)
      const started = await hostBridge().startRun({ graph: currentGraph, scope: pending.scope })
      activeRunRef.current = { ...started, scope: pending.scope }
      openInspectorTab('runs')
      setBanner('工作流已交由安全运行服务')
      // 缓存命中的工作流可能在 startRun IPC 返回前已发出终态事件。
      // 立即读取持久记录可补回该事件，避免运行按钮永久停在“取消”。
      void refreshRuns(started.runId)
    } catch (error) {
      setRunning(false)
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [edges, imageGroup, imageModels, nodes, openInspectorTab, pendingCanvasRun, refreshRuns, running, videoGroup, videoModels])

  const run = async () => {
    if (running) return
    if (preparingMedia) {
      setBanner('生成配置正在准备，请稍候再运行工作流')
      return
    }
    if (resumingTaskIdsRef.current.size > 0) {
      setBanner('请等待视频任务续查完成后再运行工作流')
      return
    }
    setRunning(true)
    setBanner(null)
    if (window.xingmangCanvasHost) {
      try {
        const graph = toCanvasRunGraph(nodes, edges, { image: imageGroup ?? '', video: videoGroup ?? '' })
        const scope = currentRunScope()
        const preflight = buildCanvasRunPreflight({
          graph,
          scope,
          imageGroup: imageGroup ?? undefined,
          videoGroup: videoGroup ?? undefined,
          imageModels,
          videoModels,
        })
        setRunPreflight(preflight)
        if (!preflight.canStart) {
          setRunning(false)
          setBanner(preflight.warnings.filter((entry) => entry.includes('：')).join('；') || '当前运行范围无法执行')
          return
        }
        setPendingCanvasRun({ graph, scope })
        setRunning(false)
        setBanner('请确认运行范围和本次额度风险')
        return
      } catch (error) {
        setRunning(false)
        setBanner(error instanceof Error ? error.message : String(error))
        return
      }
    }
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const outcome = await runWorkflow(
        nodes.map(toWorkflowNode),
        edges.map(toWorkflowEdge),
        buildExecutors(),
        { onNodeUpdate: patchNodeData },
        controller.signal,
      )
      setBanner(`运行结束:成功 ${outcome.succeeded.length} / 失败 ${outcome.failed.length} / 跳过 ${outcome.skipped.length}`)
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }

  const cancel = () => {
    const active = activeRunRef.current
    if (active) void hostBridge().cancelRun(active.runId)
    else abortRef.current?.abort()
  }

  const workflowSnapshot = (): WorkflowFile => ({
    ...createEmptyWorkflow(activeProject?.name ?? '画布工作流'),
    mediaGroups: { ...mediaGroups },
    nodes: nodes.map(toWorkflowNode),
    edges: edges.map(toWorkflowEdge),
    viewport: { ...viewport },
  })

  const queueProjectSave = useCallback((project: CanvasStoredProjectSummary, content: string, revision: number) => {
    const operation = projectSaveChainRef.current.then(async () => {
      const saved = await hostBridge().saveProject(project.id, content)
      if (autoSaveRevisionRef.current !== revision) return
      setActiveProject(saved)
      setProjects((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)])
      setAutoSaveState('saved')
    })
    projectSaveChainRef.current = operation.catch(() => undefined)
    return operation
  }, [])

  const returnToProjectCenter = useCallback(async () => {
    if (!activeProject) return
    const revision = autoSaveRevisionRef.current + 1
    autoSaveRevisionRef.current = revision
    setAutoSaveState('saving')
    try {
      await queueProjectSave(activeProject, serializeWorkflow(workflowSnapshot()), revision)
      setActiveProject(null)
      projectHydrationRef.current = false
      applyProjectUiPreferences({ ...defaultCanvasUiPreferences })
    } catch (error) {
      setAutoSaveState('failed')
      setBanner(error instanceof Error ? `自动保存失败：${error.message}` : `自动保存失败：${String(error)}`)
    }
  }, [activeProject, applyProjectUiPreferences, nodes, edges, viewport, mediaGroups, queueProjectSave])

  const prepareWorkflowDocument = async (workflow: WorkflowFile): Promise<{
    document: CanvasDocumentState
    warnings: string[]
  } | null> => {
    setBanner('正在准备项目生成配置…')
    const prepared = await prepareMediaConfiguration((availableGroups) => {
      const preferred = preferredMediaGroups(availableGroups)
      return {
        image: workflow.mediaGroups?.image ?? imageGroup ?? preferred.image,
        video: workflow.mediaGroups?.video ?? videoGroup ?? preferred.video,
      }
    }, 'all')
    if (!prepared) return null
    applyPreparedMediaConfiguration(prepared)
    const normalizedWorkflow = { ...workflow, mediaGroups: prepared.mediaGroups }
    return { document: workflowDocument(normalizedWorkflow), warnings: prepared.warnings }
  }

  const save = async () => {
    const workflow = workflowSnapshot()
    const result = await hostBridge().saveFile('xingmang-project.xingcanvas', serializeXingCanvasProject(workflow, {
      licenses: [{ name: 'React Flow', license: 'MIT' }],
    }))
    if (result) setBanner('工作流已保存')
  }

  const exportProject = async () => {
    const workflow = workflowSnapshot()
    try {
      const result = window.xingmangCanvasHost
        ? await hostBridge().exportProject('xingmang-project.xingcanvas', serializeWorkflow(workflow))
        : await hostBridge().saveFile('xingmang-project.xingcanvas', serializeXingCanvasProject(workflow, { licenses: [{ name: 'React Flow', license: 'MIT' }] }))
      if (result) setBanner('项目和本地素材已导出')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }

  const importProject = async () => {
    try {
      const preview = await hostBridge().previewProject()
      if (!preview) return
      const accepted = window.confirm(
        `导入「${preview.workflowName}」？\n${preview.nodeCount} 个节点，${preview.edgeCount} 条连线，${preview.assetCount} 个本地素材${preview.warnings.length ? `\n\n${preview.warnings.join('\n')}` : ''}`,
      )
      if (!accepted) return
      const result = await hostBridge().importProject(preview.previewId)
      const workflow = parseWorkflowFile(result.content)
      if (!workflow) throw new Error('导入项目中的工作流无法读取')
      const prepared = await prepareWorkflowDocument(workflow)
      if (!prepared) return
      execute({ type: 'replace-document', document: prepared.document })
      restoreCanvasViewport(prepared.document.viewport)
      void refreshAssets()
      const warnings = [...result.warnings, ...prepared.warnings]
      setBanner(`已导入项目和 ${result.importedAssetCount} 个本地素材${warnings.length ? `；${warnings.join('；')}` : ''}`)
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }

  const load = async () => {
    try {
      const picked = await hostBridge().pickFile()
      if (!picked) return
      const project = parseXingCanvasProject(picked.content)
      const workflow = project?.workflow ?? parseWorkflowFile(picked.content)
      if (!workflow) throw new Error('无法读取该文件：不是有效的星芒工作流')
      const prepared = await prepareWorkflowDocument(workflow)
      if (!prepared) return
      execute({ type: 'replace-document', document: prepared.document })
      restoreCanvasViewport(prepared.document.viewport)
      const warnings = [...(project?.warnings ?? []), ...prepared.warnings]
      setBanner(warnings.length
        ? `已打开「${workflow.name}」；${warnings.join('；')}`
        : `已打开「${workflow.name}」`)
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (runPreflight) return
      const shortcut = resolveCanvasShortcut(event)
      if (!shortcut) return
      if (shortcut === 'undo') { event.preventDefault(); undo() }
      else if (shortcut === 'redo') { event.preventDefault(); redo() }
      else if (shortcut === 'save') { event.preventDefault(); void save() }
      else if (shortcut === 'open') { event.preventDefault(); void load() }
      else if (shortcut === 'run') { event.preventDefault(); void run() }
      else if (shortcut === 'layout') { event.preventDefault(); autoLayout() }
      else if (shortcut === 'toggle-assets') { event.preventDefault(); toggleAssetTray() }
      else if (shortcut === 'toggle-overview') { event.preventDefault(); toggleCanvasOverview() }
      else if (shortcut === 'quick-insert') {
        event.preventDefault()
        if (quickInsert) {
          setQuickInsert(null)
          return
        }
        const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
        if (!bounds) return
        setMediaConfigOpen(false)
        setMoreActionsOpen(false)
        setRunMenuOpen(false)
        const client = { x: bounds.left + bounds.width / 2, y: bounds.top + Math.min(bounds.height * 0.38, 320) }
        setQuickInsert({
          anchor: { x: Math.max(12, Math.min(bounds.width - 372, client.x - bounds.left - 180)), y: Math.max(12, Math.min(bounds.height - 430, client.y - bounds.top - 70)) },
          flowPosition: reactFlow.screenToFlowPosition(client),
        })
      }
      else if (shortcut === 'copy') { event.preventDefault(); copySelection() }
      else if (shortcut === 'paste') { event.preventDefault(); pasteSelection() }
      else if (shortcut === 'duplicate') { event.preventDefault(); copySelection(); pasteSelection() }
      else if (shortcut === 'group') { event.preventDefault(); groupSelection() }
      else if (shortcut === 'ungroup') { event.preventDefault(); ungroupSelection() }
      else if (shortcut === 'select-all') {
        event.preventDefault()
        setNodes((current) => current.map((node) => ({ ...node, selected: true })))
      } else if (shortcut === 'delete') {
        const selectedNodes = nodes.filter((node) => node.selected).map((node) => node.id)
        const selectedEdges = edges.filter((edge) => edge.selected).map((edge) => edge.id)
        if (!selectedNodes.length && !selectedEdges.length) return
        event.preventDefault()
        execute({ type: 'delete-elements', nodeIds: selectedNodes, edgeIds: selectedEdges })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, save, load, run, autoLayout, toggleAssetTray, toggleCanvasOverview, copySelection, pasteSelection, groupSelection, ungroupSelection, nodes, edges, execute, setNodes, quickInsert, reactFlow, runPreflight])

  const serverBacked = Boolean(window.xingmangCanvasHost)
  const mediaConnectionLabel = preparingMedia
    ? '正在准备生成配置…'
    : `图片 · ${imageGroup ?? '未配置'} / 视频 · ${videoGroup ?? '未配置'}`
  const toggleMediaConfiguration = () => {
    setMoreActionsOpen(false)
    setRunMenuOpen(false)
    setQuickInsert(null)
    setMediaConfigOpen((open) => !open)
  }

  useEffect(() => {
    if (!moreActionsOpen && !runMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (moreActionsOpen && !moreActionsRef.current?.contains(event.target)) setMoreActionsOpen(false)
      if (runMenuOpen && !runMenuRef.current?.contains(event.target)) setRunMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (runMenuOpen) {
          setRunMenuOpen(false)
          runMenuTriggerRef.current?.focus()
        }
        if (moreActionsOpen) {
          setMoreActionsOpen(false)
          moreActionsTriggerRef.current?.focus()
        }
        return
      }
      if (!runMenuOpen || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = [...(runMenuRef.current?.querySelectorAll<HTMLButtonElement>('.canvas-run-menu button:not(:disabled)') ?? [])]
      if (items.length === 0) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length
      items[next]?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [moreActionsOpen, runMenuOpen])

  useEffect(() => {
    if (!runMenuOpen) return
    const frame = window.requestAnimationFrame(() => {
      runMenuRef.current?.querySelector<HTMLButtonElement>('.canvas-run-menu button[aria-checked="true"]:not(:disabled), .canvas-run-menu button:not(:disabled)')?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [runMenuOpen])

  useEffect(() => {
    if (!window.xingmangCanvasHost || !activeProject) return
    if (projectHydrationRef.current) {
      projectHydrationRef.current = false
      return
    }
    const revision = autoSaveRevisionRef.current + 1
    autoSaveRevisionRef.current = revision
    setAutoSaveState('saving')
    const timeout = window.setTimeout(() => {
      const content = serializeWorkflow(workflowSnapshot())
      void queueProjectSave(activeProject, content, revision).catch((error) => {
        if (autoSaveRevisionRef.current !== revision) return
        setAutoSaveState('failed')
        setBanner(error instanceof Error ? `自动保存失败：${error.message}` : `自动保存失败：${String(error)}`)
      })
    }, 800)
    return () => window.clearTimeout(timeout)
  }, [activeProject?.id, nodes, edges, viewport, mediaGroups, queueProjectSave])

  useEffect(() => {
    if (!window.xingmangCanvasHost || !activeProject) return
    const flush = () => {
      const revision = autoSaveRevisionRef.current + 1
      autoSaveRevisionRef.current = revision
      void queueProjectSave(activeProject, serializeWorkflow(workflowSnapshot()), revision).catch(() => undefined)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [activeProject, nodes, edges, viewport, mediaGroups, queueProjectSave])

  const selectedInspectorNodes: CanvasInspectorNode[] = useMemo(
    () => projectCanvasInspectorNodes(nodes, edges),
    [edges, nodes],
  )

  if (window.xingmangCanvasHost && !activeProject) {
    return (
      <ProjectCenter
        projects={projects}
        loading={projectLoading}
        error={banner}
        onCreate={createStoredProject}
        onOpen={(id) => void openStoredProject(id)}
        onRename={renameStoredProject}
        onDuplicate={duplicateStoredProject}
        onSetArchived={setStoredProjectArchived}
      />
    )
  }

  return (
    <div className="canvas-app">
      <header className="canvas-toolbar canvas-toolbar-editor">
        <div className="canvas-brand">
          <button type="button" className="canvas-project-back" title="保存并返回项目中心" onClick={() => void returnToProjectCenter()}><FolderOpen size={15} /></button>
          <strong>{activeProject?.name ?? '星芒无限画布'}</strong>
        </div>
        <div className="canvas-toolbar-group canvas-toolbar-center">
          <button type="button" className="canvas-icon-command" title="撤销" aria-label="撤销" onClick={undo} disabled={!canUndo}><Undo2 size={15} /></button>
          <button type="button" className="canvas-icon-command" title="重做" aria-label="重做" onClick={redo} disabled={!canRedo}><Redo2 size={15} /></button>
          <button type="button" className="canvas-icon-command" title="自动布局" aria-label="自动布局" onClick={autoLayout} disabled={!nodes.length}><LayoutGrid size={15} /></button>
          <button type="button" className="canvas-icon-command" title="适配全部内容" aria-label="适配全部内容" onClick={fitCanvas} disabled={!nodes.length}><Crosshair size={15} /></button>
        </div>
        <div className="canvas-toolbar-group canvas-toolbar-actions">
          <button
            ref={quickInsertTriggerRef}
            type="button"
            className="canvas-icon-command canvas-quick-command"
            title="快速创建 (Ctrl+K)"
            aria-label="快速创建"
            aria-haspopup="dialog"
            aria-expanded={quickInsert !== null}
            data-quick-insert-trigger="true"
            onClick={() => {
              if (quickInsert) {
                setQuickInsert(null)
                return
              }
              const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
              if (!bounds) return
              setMediaConfigOpen(false)
              setRunMenuOpen(false)
              setMoreActionsOpen(false)
              const client = { x: bounds.left + bounds.width / 2, y: bounds.top + Math.min(bounds.height * 0.38, 320) }
              setQuickInsert({ anchor: { x: Math.max(12, bounds.width / 2 - 180), y: Math.max(12, Math.min(bounds.height - 430, client.y - bounds.top - 70)) }, flowPosition: reactFlow.screenToFlowPosition(client) })
            }}
          ><Plus size={16} /></button>
          <button
            type="button"
            className={`canvas-icon-command canvas-history-command${inspectorTab === 'runs' && runInspectorOpen ? ' is-active' : ''}`}
            title="运行历史"
            aria-label="运行历史"
            aria-pressed={inspectorTab === 'runs' && runInspectorOpen}
            onClick={toggleRunInspector}
          ><History size={15} /></button>
          {/* Distinct icon from the bottom-right "focus selection" control: this
              one hides the side panels, it does not move the viewport. */}
          <button
            type="button"
            className={`canvas-icon-command${focusMode ? ' is-active' : ''}`}
            title={focusMode ? '显示侧边面板' : '隐藏侧边面板,专注画布'}
            aria-label={focusMode ? '显示侧边面板' : '隐藏侧边面板'}
            aria-pressed={focusMode}
            onClick={() => setFocusMode((current) => !current)}
          ><PanelRight size={15} /></button>
          <MediaConfiguration
            open={mediaConfigOpen}
            groups={groups}
            imageGroup={imageGroup}
            videoGroup={videoGroup}
            imageModels={imageModels}
            videoModels={videoModels}
            preparing={preparingMedia}
            onToggle={toggleMediaConfiguration}
            onClose={() => setMediaConfigOpen(false)}
            onSelect={(kind, group) => void selectMediaGroup(kind, group)}
          />
          <div ref={moreActionsRef} className="canvas-more-actions">
            <button ref={moreActionsTriggerRef} type="button" className="canvas-icon-command" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded={moreActionsOpen} onClick={() => { setMediaConfigOpen(false); setRunMenuOpen(false); setQuickInsert(null); setMoreActionsOpen((open) => !open) }}><MoreHorizontal size={16} /></button>
            {moreActionsOpen && (
              <div className="canvas-more-menu">
                <button type="button" onClick={() => { setMoreActionsOpen(false); groupSelection() }}>将选中节点分组</button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); openTemplateCatalog() }}><Sparkles size={14} />打开行业模板库</button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); showAssetTray() }}><ImageIcon size={14} />打开素材库</button>
                {/* Overflow fallback: the toolbar toggle is hidden below 1320px,
                    so narrow windows would otherwise lose every entry point. */}
                <button type="button" onClick={() => { setMoreActionsOpen(false); openInspectorTab('runs') }}><History size={14} />打开运行历史</button>
                <span className="canvas-more-divider" />
                <button type="button" onClick={() => { setMoreActionsOpen(false); void load() }}>打开工作流</button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); void save() }}>保存工作流</button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); void importProject() }}>导入项目包</button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); void exportProject() }}>导出项目包</button>
              </div>
            )}
          </div>
          {running
            ? <button type="button" className="canvas-run" onClick={cancel}>取消</button>
            : <div ref={runMenuRef} className="canvas-run-split">
                <button type="button" className="canvas-run canvas-run-main" onClick={() => void run()} disabled={preparingMedia !== null || nodes.length === 0 || resumingTaskIds.size > 0 || activeRunOption.disabled}><Play size={14} aria-hidden="true" />{runScopeLabel}</button>
                <button ref={runMenuTriggerRef} type="button" className="canvas-run canvas-run-menu-toggle" title="选择运行范围" aria-label="选择运行范围" aria-haspopup="menu" aria-expanded={runMenuOpen} onClick={() => { setMoreActionsOpen(false); setMediaConfigOpen(false); setQuickInsert(null); setRunMenuOpen((open) => !open) }}><ChevronDown size={14} /></button>
                {runMenuOpen && <div className="canvas-run-menu" role="menu" aria-label="运行范围">
                  {runScopeOptions.map((option) => (
                    <button key={option.kind} type="button" role="menuitemradio" aria-checked={runScopeKind === option.kind} disabled={option.disabled} onClick={() => { setRunScopeKind(option.kind); setRunMenuOpen(false); runMenuTriggerRef.current?.focus() }}>
                      <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    </button>
                  ))}
                </div>}
              </div>}
        </div>
      </header>
      <div className={`canvas-workspace${focusMode ? ' is-focused' : ''}`}>
      <NodeLibrary
        collapsed={uiPreferences.libraryCollapsed}
        onCollapsedChange={(collapsed) => setUiPreferences((current) => ({ ...current, libraryCollapsed: collapsed }))}
        onAdd={addNode}
        onAddPrompt={(prompt) => addNode('prompt', undefined, { prompt })}
        onAddAsset={addAssetNode}
        onDeletePromptPreset={(id) => void deletePromptPreset(id)}
        onUpdatePromptPreset={updatePromptPreset}
        onLoadTemplate={(templateId) => openTemplateCatalog(templateId)}
        onOpenAssets={showAssetTray}
        onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
        assets={assetPage}
        userPromptPresets={userPromptPresets}
      />
      <div
        className={`canvas-flow${!focusMode && (assetTrayOpen || runInspectorOpen) ? ' has-right-panel' : ''}`}
        onDoubleClick={(event) => {
          if (!(event.target instanceof Element) || !event.target.classList.contains('react-flow__pane')) return
          const bounds = event.currentTarget.getBoundingClientRect()
          setQuickInsert({
            anchor: {
              x: Math.max(12, Math.min(bounds.width - 372, event.clientX - bounds.left)),
              y: Math.max(12, Math.min(bounds.height - 430, event.clientY - bounds.top)),
            },
            flowPosition: reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          })
        }}
      >
        <CanvasModelAvailabilityProvider connected={serverBacked} imageModels={imageModels} videoModels={videoModels}>
        <CanvasNodeViewProvider lod={nodeLod}>
        <CanvasUpstreamReferencesProvider nodes={nodes} edges={edges} assets={assetCatalog}>
        <CanvasEdgeHandlersProvider handlers={edgeHandlers}>
        <ReactFlow
          colorMode={theme}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onNodesChange={onCanvasNodesChange}
          onNodeDragStart={onCanvasNodeDragStart}
          onNodeDragStop={onCanvasNodeDragStop}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          edgesReconnectable
          onReconnect={onReconnect}
          reconnectRadius={14}
          deleteKeyCode={null}
          fitView
          minZoom={0.15}
          fitViewOptions={{ padding: 0.14, minZoom: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: false }}
          ariaLabelConfig={canvasAriaLabelConfig}
          onMove={(_, nextViewport) => setNodeLod((current) => canvasNodeLodForZoom(nextViewport.zoom, current))}
          onMoveEnd={(_, nextViewport) => setDocumentViewport(nextViewport)}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1, 2]}
          panOnScroll
          // Double-click is reclaimed for quick insert / rename. Leaving the
          // default on made every one of those gestures also zoom the canvas.
          zoomOnDoubleClick={false}
          // A selected node must never paint under an unselected neighbour.
          elevateNodesOnSelect
          elevateEdgesOnSelect
          // Nodes host textareas and selects: without a threshold a 2px twitch
          // while clicking one starts a node drag instead.
          nodeDragThreshold={3}
          onNodeContextMenu={(event, node) => openContextMenuFor(event, node)}
          onSelectionContextMenu={(event, selected) => { if (selected[0]) openContextMenuFor(event, selected[0]) }}
          onPaneClick={() => { setQuickInsert(null); setContextMenu(null); setRunMenuOpen(false); setMoreActionsOpen(false) }}
          onPaneContextMenu={(event) => {
            event.preventDefault()
            openQuickInsertAt({ x: event.clientX, y: event.clientY })
          }}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault()
            openEdgeQuickInsertAt({ x: event.clientX, y: event.clientY }, edge)
          }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
          onDrop={(event) => {
            event.preventDefault()
            const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
            const nodeType = event.dataTransfer.getData('application/x-xingmang-node')
            if (nodeType) {
              addNode(nodeType, position)
              return
            }
            const assetId = event.dataTransfer.getData('application/x-xingmang-asset-id')
            if (assetId) {
              addAssetNode(assetId, position)
              return
            }
            const file = event.dataTransfer.files[0]
            if (file) void importAssetToCanvas(file, position)
          }}
        >
          {/* Two layers: a fine minor grid plus a coarser major one, so that
              alignment and snapping have something to read against. */}
          <Background id="canvas-grid-minor" variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Background id="canvas-grid-major" variant={BackgroundVariant.Lines} gap={96} lineWidth={1} />
          {minimapOpen && <MiniMap pannable zoomable nodeColor={canvasMinimapNodeColor} nodeStrokeWidth={3} />}
          <Controls />
        </ReactFlow>
        </CanvasEdgeHandlersProvider>
        {contextMenu && (
          <CanvasContextMenu
            state={contextMenu}
            onAction={runContextAction}
            onClose={() => setContextMenu(null)}
          />
        )}
        </CanvasUpstreamReferencesProvider>
        </CanvasNodeViewProvider>
        </CanvasModelAvailabilityProvider>
        <SelectionToolbar
          count={selectedNodeIds.length}
          canGroup={selectedNodeIds.length > 1}
          canUngroup={nodes.some((node) => node.selected && node.type === 'group')}
          allLocked={allSelectedLocked}
          canToggleDisabled={selectedDisableEligibleIds.length > 0}
          allDisabled={allSelectedDisabled}
          onCopy={copySelection}
          onDuplicate={() => { copySelection(); pasteSelection() }}
          onGroup={groupSelection}
          onUngroup={ungroupSelection}
          onToggleLocked={() => setNodeFlags(selectedNodeIds, 'locked', !allSelectedLocked)}
          onToggleDisabled={() => setNodeFlags(selectedDisableEligibleIds, 'disabled', !allSelectedDisabled)}
          onFocus={fitSelection}
          onDelete={deleteSelection}
        />
        {nodes.length === 0 && !quickInsert && <div className="canvas-empty-state">
          <button type="button" className="is-primary" onClick={() => openTemplateCatalog()}><Sparkles size={16} />从模板开始</button>
          <button type="button" onClick={() => addNode('image-generate', { x: 120, y: 120 })}><Plus size={16} />新建生成节点</button>
          <button type="button" onClick={() => void load()}>打开项目</button>
        </div>}
        <QuickInsert
          open={quickInsert !== null}
          anchor={quickInsert?.anchor ?? { x: 12, y: 12 }}
          hasNodes={nodes.length > 0}
          hasSelection={selectedNodeIds.length > 0}
          canvasNodes={nodes}
          allowedNodeTypes={quickInsert?.compatibleHandles ? Object.keys(quickInsert.compatibleHandles) : undefined}
          onAddNode={(type) => {
            const connection = quickInsert?.connection
            const handleId = quickInsert?.compatibleHandles?.[type]
            if (quickInsert?.edgeId && handleId) insertNodeOnEdge(type, quickInsert.flowPosition, quickInsert.edgeId, handleId)
            else if (connection && handleId) addConnectedNode(type, quickInsert?.flowPosition, connection, handleId)
            else addNode(type, quickInsert?.flowPosition)
          }}
          onLoadTemplate={(templateId) => openTemplateCatalog(templateId)}
          onCommand={(command: QuickInsertCommand) => {
            if (command === 'fit-all') fitCanvas()
            else if (command === 'fit-selection') fitSelection()
            else showAssetTray()
          }}
          onLocateNode={locateNode}
          onClose={() => setQuickInsert(null)}
        />
        {banner && <div className="canvas-toast" role="status" aria-live="polite"><span>{banner}</span><button type="button" aria-label="关闭提示" onClick={() => setBanner(null)}><X size={13} /></button></div>}
        <TemplateCatalog
          open={templateCatalog !== null}
          templates={builtinCanvasTemplates}
          assets={assetPage}
          imageModels={imageModels}
          videoModels={videoModels}
          initialTemplateId={templateCatalog?.initialTemplateId}
          onClose={() => setTemplateCatalog(null)}
          onPickAsset={pickAssetForTemplate}
          onInsert={insertTemplate}
        />
        <div className="canvas-statusbar" aria-label="画布状态">
          <span>{selectedNodeIds.length ? `已选 ${selectedNodeIds.length}` : `${nodes.length} 个节点`}</span>
          {dirtyNodeIds.size > 0 && <span>{dirtyNodeIds.size} 个待更新</span>}
          <span>{Math.round(viewport.zoom * 100)}%</span>
          <span className="canvas-status-media">{mediaConnectionLabel}</span>
          {activeProject && <span className={`canvas-autosave is-${autoSaveState}`}>{autoSaveState === 'saving' ? '保存中…' : autoSaveState === 'failed' ? '保存失败' : '已自动保存'}</span>}
        </div>
        {/* Canvas-local navigation only. "Fit all" lives in the toolbar with the
            other commands; duplicating it here made two controls with one job. */}
        <div className="canvas-navigation-tools" aria-label="画布导航">
          <button type="button" title="聚焦选中节点" aria-label="聚焦选中节点" onClick={fitSelection} disabled={!selectedNodeIds.length}><Focus size={15} /></button>
          <button type="button" title={minimapOpen ? '隐藏缩略图' : '显示缩略图'} aria-label={minimapOpen ? '隐藏缩略图' : '显示缩略图'} aria-pressed={minimapOpen} onClick={() => setMinimapOpen((open) => !open)}><MapIcon size={15} /></button>
        </div>
      </div>
      {!focusMode && (
        (inspectorTab === 'node' && nodeInspectorOpen && selectedInspectorNodes.length > 0)
        || (inspectorTab === 'assets' && assetTrayOpen)
        || (inspectorTab === 'runs' && runInspectorOpen)
      ) && (
        <CanvasInspector
          tab={inspectorTab}
          nodes={selectedInspectorNodes}
          imageModels={imageModels}
          videoModels={videoModels}
          onTabChange={openInspectorTab}
          onClose={closeInspector}
          onLocate={locateNode}
          onRun={(nodeId) => void rerunNode(nodeId)}
          onToggleLocked={(nodeId, locked) => setInspectorNodeFlag(nodeId, 'locked', locked)}
          onToggleDisabled={(nodeId, disabled) => setInspectorNodeFlag(nodeId, 'disabled', disabled)}
          onPreview={(node) => node.previewAsset && setPreviewAsset({ ...node.previewAsset })}
        >
          {inspectorTab === 'assets' && (
            <AssetTray
              embedded
              page={assetPage}
              query={assetQuery}
              loading={assetsLoading}
              onQueryChange={changeAssetQuery}
              onRefresh={() => void refreshAssets()}
              onImport={() => void pickAssetToCanvas()}
              onAdd={addAssetNode}
              onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
              onLocateSourceNode={locateNode}
              onRename={renameCanvasAsset}
              onUpdateMetadata={updateCanvasAssetMetadata}
              onMarkUsed={markCanvasAssetUsed}
              onInspectReferences={(assetId) => hostBridge().inspectAssetReferences(assetId, serializeWorkflow(workflowSnapshot()))}
              onClose={closeInspector}
            />
          )}
          {inspectorTab === 'runs' && (
            <RunInspector
              embedded
              open
              records={runRecords}
              selectedRunId={selectedRunId}
              selectedCandidateIds={Object.fromEntries(nodes.map((node) => [node.id, node.data.selectedCandidateId]))}
              adoptedCandidateIds={Object.fromEntries(nodes.map((node) => [node.id, node.data.adoptedCandidateId]))}
              stagedCandidateIds={Object.fromEntries(nodes.map((node) => [node.id, node.data.candidates?.map((candidate) => candidate.candidateId)]))}
              selectedScope={runScopeKind}
              dirtyCount={dirtyNodeIds.size}
              selectionCount={selectedNodeIds.length}
              loading={runsLoading}
              onScopeChange={setRunScopeKind}
              onRefresh={() => void refreshRuns()}
              onSelectRun={setSelectedRunId}
              onSelectCandidate={selectCandidate}
              onAdopt={adoptCandidate}
              onDiscard={discardCandidate}
              onPreviewAsset={(asset) => setPreviewAsset({ ...asset })}
              onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
              onLocateNode={locateNode}
              onRetryNode={(nodeId, scope) => { requestNodeScopeRun(nodeId, scope) }}
              onClose={closeInspector}
            />
          )}
        </CanvasInspector>
      )}
      </div>
      <ModelSuggestions />
      <MediaLightbox
        asset={previewAsset}
        onClose={() => setPreviewAsset(null)}
        onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
      />
      {runPreflight && (
        <RunPreflight
          preflight={runPreflight}
          onCancel={() => { setRunPreflight(null); setPendingCanvasRun(null) }}
          onConfigure={() => {
            setRunPreflight(null)
            setPendingCanvasRun(null)
            setMediaConfigOpen(true)
          }}
          onConfirm={() => void confirmCanvasRun()}
        />
      )}
    </div>
  )
}
