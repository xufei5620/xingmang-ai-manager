import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react'
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
import { SimpleMode } from './SimpleMode'
import { isValidWorkflowConnection } from './ports'
import { defaultImageModel, defaultImageQuality, defaultImageSize } from './models'
import { ModelSuggestions, nodeTypes, registerNodeChangeHandlers, type CanvasNode } from './nodes/WorkflowNodes'
import type { CanvasAssetPage, CanvasAssetQuery, CanvasGeneratedAsset, CanvasGroupSummary, CanvasPromptPreset, CanvasRunRecord, CanvasRunScope } from './host'
import { AssetTray } from './components/AssetTray'
import { MediaLightbox } from './components/MediaPreview'
import { autoLayoutCanvasNodes } from './editor/auto-layout'
import { resolveCanvasShortcut } from './editor/shortcuts'
import { builtinCanvasTemplates } from './templates/builtin-templates'
import { instantiateTemplate, placeTemplateInstance } from './templates/instantiate-template'
import { builtinNodeRegistry } from './domain/builtin-node-definitions'
import { NodeLibrary } from './components/NodeLibrary'
import {
  buildCanvasClipboardPayload,
  pasteCanvasClipboard,
  type CanvasClipboardPayload,
} from './editor/clipboard'
import { groupCanvasNodes, ungroupCanvasNode } from './editor/grouping'
import { RunInspector } from './components/RunInspector'
import { parseXingCanvasProject, serializeXingCanvasProject } from './persistence/project-package'
import {
  adoptNodeCandidate,
  markNodeAndDescendantsDirty,
  projectRunRecordToNodes,
  selectNodeCandidate,
} from './runtime/run-projection'
import { Redo2, Undo2 } from 'lucide-react'

// 画布装配层:@xyflow/react 的 Node/Edge 与领域模型互相映射,引擎与
// 持久化只见领域模型。M0 执行走 mock 执行器(不出网);M1 把 executors
// 换成 relay 真实现(engine/relay.ts),本文件的编排逻辑不变。

let nodeSequence = 0

function nextNodeId(): string {
  nodeSequence += 1
  return `n${Date.now().toString(36)}-${nodeSequence}`
}

export function toCanvasNode(node: WorkflowNode): CanvasNode {
  const displayKind = node.disabled && node.unknownKind ? 'unknown' : node.kind
  const dimensions = builtinNodeRegistry.resolve(displayKind)?.dimensions
  const width = node.width ?? dimensions?.width
  const height = node.height ?? dimensions?.height
  return {
    id: node.id,
    type: displayKind,
    definitionVersion: node.definitionVersion ?? 1,
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    position: node.position,
    data: { ...node.data, __canvasDisabled: node.disabled === true },
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
      status: node.data.status,
      result: node.data.result,
      errorMessage: node.data.errorMessage,
      costQuota: node.data.costQuota,
      settings: node.data.settings,
      candidateAssetIds: node.data.candidateAssetIds,
    },
  }
}

export function toCanvasRunGraph(nodes: readonly CanvasNode[], edges: readonly Edge[], group: string) {
  const runnableNodes = nodes.filter(isCanvasRunNode)
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
        group,
        quality: node.data.quality,
        size: node.data.size,
        adoptedAssetId: node.data.result?.assetId,
      },
    })),
    edges: edges
      .filter((edge) => runnableIds.has(edge.source) && runnableIds.has(edge.target))
      .map(toWorkflowEdge),
  }
}

function isCanvasRunNode(node: CanvasNode): boolean {
  return node.type !== 'unknown' && !node.unknownKind
}

const rerunTextSourceKinds = new Set(['text', 'prompt'])
const rerunImageSourceKinds = new Set(['image', 'image-input', 'image-generate', 'image-edit', 'gallery'])

export function workflowNodeData(type: string, config: Record<string, unknown> = {}): WorkflowNodeData {
  const defaults = builtinNodeRegistry.require(type).defaultData
  const values = { ...structuredClone(defaults), ...structuredClone(config) }
  const prompt = typeof values.prompt === 'string' ? values.prompt : ''
  const model = typeof values.model === 'string' ? values.model : ''
  const quality = typeof values.quality === 'string' ? values.quality : undefined
  const size = typeof values.size === 'string' ? values.size : undefined
  const assetId = typeof values.assetId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(values.assetId)
    ? values.assetId
    : undefined
  const assetKind = type === 'video-input' ? 'video' : 'image'
  const result = assetId && (type === 'image-input' || type === 'video-input')
    ? { kind: assetKind, assetId, localUrl: `xingmang-asset://${assetKind}/${assetId}` } as const
    : undefined
  const settings = Object.fromEntries(Object.entries(values).filter(([key]) => !['prompt', 'model', 'quality', 'size', 'status', 'result', 'assetId'].includes(key)))
  return {
    prompt,
    model,
    status: result ? 'succeeded' : 'idle',
    ...(quality ? { quality } : {}),
    ...(size ? { size } : {}),
    ...(result ? { result } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  }
}

function imageOperationDefaults(type: string): Record<string, unknown> {
  return ['image', 'image-generate', 'image-edit'].includes(type)
    ? { model: defaultImageModel, quality: defaultImageQuality, size: defaultImageSize }
    : {}
}

function generatedAssetRef(asset: CanvasGeneratedAsset): AssetRef {
  return {
    kind: 'image',
    assetId: asset.assetId,
    localUrl: asset.localUrl,
    mimeType: asset.mimeType,
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
  }
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

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [running, setRunning] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  // 双模式(M2):简单模式=固定表单的单节点工作流,默认给小白;画布模式
  // 给要自己编排管线的用户。两种模式共享同一套 executors。
  const [viewMode, setViewMode] = useState<'simple' | 'canvas'>('canvas')
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const [groups, setGroups] = useState<CanvasGroupSummary[]>([])
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [assetTrayOpen, setAssetTrayOpen] = useState(false)
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [assetPage, setAssetPage] = useState<CanvasAssetPage>({ items: [], offset: 0, limit: 24, total: 0, hasMore: false })
  const [userPromptPresets, setUserPromptPresets] = useState<CanvasPromptPreset[]>([])
  const [assetQuery, setAssetQuery] = useState<Required<Pick<CanvasAssetQuery, 'offset' | 'limit' | 'mediaType'>> & Pick<CanvasAssetQuery, 'search'>>({
    offset: 0, limit: 24, mediaType: 'all', search: '',
  })
  const [runInspectorOpen, setRunInspectorOpen] = useState(false)
  const [runsLoading, setRunsLoading] = useState(false)
  const [runRecords, setRunRecords] = useState<CanvasRunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runScopeKind, setRunScopeKind] = useState<CanvasRunScope['kind']>('all')
  const [dirtyNodeIds, setDirtyNodeIds] = useState<Set<string>>(() => new Set())
  const [previewAsset, setPreviewAsset] = useState<AssetRef | null>(null)
  const [history, setHistory] = useState<Array<{ nodes: CanvasNode[]; edges: Edge[] }>>([])
  const [future, setFuture] = useState<Array<{ nodes: CanvasNode[]; edges: Edge[] }>>([])
  const abortRef = useRef<AbortController | null>(null)
  const activeRunRef = useRef<{ runId: string; graphRevision: string; scope?: CanvasRunScope } | null>(null)
  const clipboardRef = useRef<CanvasClipboardPayload | null>(null)
  const reactFlowRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null)

  const fitCanvas = useCallback(() => {
    window.requestAnimationFrame(() => {
      void reactFlowRef.current?.fitView({ padding: 0.16, maxZoom: 1 })
    })
  }, [])

  useEffect(() => {
    let active = true
    void hostBridge().listGroups()
      .then(async (groups) => {
        if (!active || groups.length === 0) return
        setGroups(groups)
        const group = groups.find((entry) => entry.name === '生图分组')?.name
          ?? groups.find((entry) => entry.name === 'openai')?.name
          ?? groups[0].name
        const prepared = await hostBridge().prepareGroup(group)
        if (!active) return
        setSelectedGroup(group)
        setAvailableModels(prepared.models)
        if (prepared.storageWarning) setBanner(prepared.storageWarning)
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [])

  const selectGroup = useCallback(async (group: string) => {
    setBanner('正在准备分组 API Key…')
    try {
      const prepared = await hostBridge().prepareGroup(group)
      setSelectedGroup(group)
      setAvailableModels(prepared.models)
      setBanner(prepared.keyCreated
        ? `已自动创建「${group}」分组 API Key`
        : `已切换到「${group}」`)
      if (prepared.storageWarning) setBanner(`分组已可用；${prepared.storageWarning}`)
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [])

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
    setNodes((current) => markNodeAndDescendantsDirty(current, edges, nodeId, patch))
    setDirtyNodeIds((current) => new Set([...current, ...dirty]))
  }, [edges, setNodes])

  const remember = useCallback(() => {
    setHistory((entries) => [...entries.slice(-49), { nodes: structuredClone(nodes), edges: structuredClone(edges) }])
    setFuture([])
  }, [nodes, edges])

  const undo = useCallback(() => {
    const previous = history.at(-1)
    if (!previous) return
    setFuture((entries) => [{ nodes: structuredClone(nodes), edges: structuredClone(edges) }, ...entries].slice(0, 50))
    setNodes(previous.nodes)
    setEdges(previous.edges)
    setHistory((entries) => entries.slice(0, -1))
  }, [history, nodes, edges, setNodes, setEdges])

  const redo = useCallback(() => {
    const next = future[0]
    if (!next) return
    setHistory((entries) => [...entries.slice(-49), { nodes: structuredClone(nodes), edges: structuredClone(edges) }])
    setNodes(next.nodes)
    setEdges(next.edges)
    setFuture((entries) => entries.slice(1))
  }, [future, nodes, edges, setNodes, setEdges])

  const buildExecutors = useCallback(() => (
    selectedGroup
      ? createHostExecutors({ group: selectedGroup, host: hostBridge() })
      : createMockExecutors()
  ), [selectedGroup])

  // 单节点重跑:输入不重新执行上游,直接取画布状态里上游节点的既有产物
  // (文本节点的输出=它的提示词;图像节点的输出=它上次成功的 result)。
  const rerunNode = useCallback(async (nodeId: string) => {
    if (running) return
    const target = nodes.find((entry) => entry.id === nodeId)
    if (!target) return
    if (target.disabled || target.type === 'unknown') {
      setBanner('该节点已禁用，不能单独运行')
      return
    }
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
    }
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    patchNodeData(nodeId, { status: 'running', errorMessage: undefined })
    try {
      const executors = buildExecutors()
      const result = await executors[target.type as NodeKind](toWorkflowNode(target), inputs, controller.signal)
      patchNodeData(nodeId, { status: 'succeeded', result: result.output.asset, costQuota: result.costQuota })
    } catch (error) {
      patchNodeData(nodeId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }, [running, nodes, edges, patchNodeData, buildExecutors])

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
      setAssetPage(await hostBridge().listAssets(query))
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    } finally {
      setAssetsLoading(false)
    }
  }, [assetQuery])

  useEffect(() => {
    if (!window.xingmangCanvasHost) return
    void hostBridge().listAssets({ offset: 0, limit: 24, mediaType: 'all' }).then(setAssetPage).catch(() => undefined)
    void hostBridge().listPromptPresets().then(setUserPromptPresets).catch(() => undefined)
  }, [])

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

  const changeAssetQuery = useCallback((query: CanvasAssetQuery) => {
    const next = {
      offset: query.offset ?? 0,
      limit: query.limit ?? 24,
      mediaType: query.mediaType ?? 'all',
      search: query.search ?? '',
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

  const showAssetTray = useCallback(() => {
    setAssetTrayOpen(true)
    void refreshAssets()
  }, [refreshAssets])

  useEffect(() => hostBridge().onRunEvent((event) => {
    const active = activeRunRef.current
    if (!active || event.runId !== active.runId || event.graphRevision !== active.graphRevision) return
    if (event.type === 'node-state' && event.nodeId && event.state) {
      const state = event.state === 'cached' ? 'succeeded'
        : event.state === 'skipped' || event.state === 'cancelled' || event.state === 'interrupted'
          ? 'failed'
          : event.state === 'cancelling' ? 'running'
            : event.state as CanvasNode['data']['status']
      patchNodeData(event.nodeId, {
        status: state,
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        ...(typeof event.costQuota === 'number' ? { costQuota: event.costQuota } : {}),
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
    if (!taskId) return
    setBanner(`视频任务 ${taskId} 的安全续查通道将在后续版本启用`)
  }, [running, nodes])

  const selectCandidate = useCallback((nodeId: string, candidate: string | WorkflowCandidateRef) => {
    setNodes((current) => selectNodeCandidate(current, nodeId, candidate))
  }, [setNodes])

  const adoptCandidate = useCallback((nodeId: string, candidate: string | WorkflowCandidateRef) => {
    remember()
    const candidateId = typeof candidate === 'string' ? candidate : candidate.candidateId
    setNodes((current) => adoptNodeCandidate(
      typeof candidate === 'string' ? current : selectNodeCandidate(current, nodeId, candidate),
      edges,
      nodeId,
      candidateId,
    ))
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
  }, [edges, remember, setNodes])

  const bindAssetToNode = useCallback((nodeId: string, asset: CanvasGeneratedAsset) => {
    remember()
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
    setNodes((current) => current.map((node) => {
      if (node.id === nodeId && node.type === 'image-input') {
        return { ...node, data: { ...node.data, result: generatedAssetRef(asset), status: 'succeeded', dirty: false, errorMessage: undefined } }
      }
      return descendants.has(node.id) ? { ...node, data: { ...node.data, dirty: true } } : node
    }))
    setDirtyNodeIds((current) => new Set([...current].filter((id) => id !== nodeId).concat([...descendants])))
    setBanner('图片素材已就绪；下游节点等待重新运行')
  }, [edges, remember, setNodes])

  const createAssetNode = useCallback((asset: CanvasGeneratedAsset, position?: XYPosition) => {
    remember()
    const definition = builtinNodeRegistry.require('image-input')
    setNodes((current) => [...current, toCanvasNode({
      id: nextNodeId(), kind: 'image-input', definitionVersion: definition.version,
      position: position ?? { x: 140 + Math.random() * 180, y: 120 + Math.random() * 160 },
      width: definition.dimensions.width,
      height: definition.dimensions.height,
      data: { prompt: '', model: '', status: 'succeeded', result: generatedAssetRef(asset) },
    })])
    setBanner('图片已导入到画布')
  }, [remember, setNodes])

  const pickAssetForNode = useCallback(async (nodeId: string) => {
    try {
      const asset = await hostBridge().pickAsset()
      if (!asset) return
      bindAssetToNode(nodeId, asset)
      void refreshAssets({ ...assetQuery, offset: 0 })
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [bindAssetToNode, refreshAssets, assetQuery])

  const importAssetForNode = useCallback(async (nodeId: string, file: File) => {
    try {
      const asset = await hostBridge().importAssetFile(file)
      bindAssetToNode(nodeId, asset)
      void refreshAssets({ ...assetQuery, offset: 0 })
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [bindAssetToNode, refreshAssets, assetQuery])

  const importAssetToCanvas = useCallback(async (file: File, position: XYPosition) => {
    try {
      const asset = await hostBridge().importAssetFile(file)
      createAssetNode(asset, position)
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
      const position = bounds && reactFlowRef.current
        ? reactFlowRef.current.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
        : undefined
      createAssetNode(asset, position)
      void refreshAssets({ ...assetQuery, offset: 0 })
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [createAssetNode, refreshAssets, assetQuery])

  useEffect(() => {
    registerNodeChangeHandlers({
      onPromptChange: (nodeId, prompt) => markDirtyFrom(nodeId, { prompt }),
      onModelChange: (nodeId, model) => markDirtyFrom(nodeId, { model }),
      onQualityChange: (nodeId, quality) => markDirtyFrom(nodeId, { quality }),
      onSizeChange: (nodeId, size) => markDirtyFrom(nodeId, { size }),
      onSettingsChange: (nodeId, patch) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        markDirtyFrom(nodeId, { settings: { ...node?.data.settings, ...patch } })
      },
      onSavePromptPreset: (nodeId) => void savePromptPreset(nodeId),
      onRerun: (nodeId) => void rerunNode(nodeId),
      onDownloadAsset: (nodeId) => void downloadNodeAsset(nodeId),
      onShowAssetMenu: (nodeId) => void showNodeAssetMenu(nodeId),
      onResumeTask: (nodeId) => void resumeTask(nodeId),
      onSelectCandidate: selectCandidate,
      onAdoptCandidate: adoptCandidate,
      onShowCandidateMenu: (assetId) => void hostBridge().showAssetMenu(assetId),
      onBindAsset: (nodeId, assetId) => {
        const asset = assetPage.items.find((entry) => entry.assetId === assetId)
        if (asset) bindAssetToNode(nodeId, asset)
      },
      onPickAsset: (nodeId) => void pickAssetForNode(nodeId),
      onImportAssetFile: (nodeId, file) => void importAssetForNode(nodeId, file),
      onPreviewAsset: setPreviewAsset,
    })
  }, [nodes, markDirtyFrom, savePromptPreset, rerunNode, downloadNodeAsset, showNodeAssetMenu, resumeTask, selectCandidate, adoptCandidate, assetPage.items, bindAssetToNode, pickAssetForNode, importAssetForNode])

  const addNode = (type: string, position?: XYPosition, config: Record<string, unknown> = {}) => {
    const kind = type as NodeKind
    const definition = builtinNodeRegistry.resolve(type)
    if (!definition || kind === 'unknown') return
    remember()
    const node: WorkflowNode = {
      id: nextNodeId(),
      kind,
      definitionVersion: definition.version,
      position: position ?? { x: 120 + Math.random() * 240, y: 120 + Math.random() * 160 },
      width: definition.dimensions.width,
      height: definition.dimensions.height,
      data: workflowNodeData(type, { ...imageOperationDefaults(type), ...config }),
    }
    setNodes((current) => [...current, toCanvasNode(node)])
  }

  const onConnect = useCallback((connection: Connection) => {
    remember()
    setEdges((current) => addEdge(connection, current))
  }, [remember, setEdges])

  const onCanvasNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    if (changes.some((change) => change.type === 'remove')) remember()
    onNodesChange(changes)
  }, [onNodesChange, remember])

  const autoLayout = useCallback(() => {
    if (nodes.length === 0) return
    remember()
    const laidOut = autoLayoutCanvasNodes(
      nodes.map((node) => ({
        id: node.id, type: node.type ?? 'unknown', definitionVersion: node.definitionVersion,
        position: node.position, data: node.data, width: node.measured?.width, height: node.measured?.height,
        ...(node.disabled ? { disabled: true } : {}),
        ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
      })),
      edges.map(toWorkflowEdge),
    )
    const positions = new Map(laidOut.map((node) => [node.id, node.position]))
    setNodes((current) => current.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })))
  }, [nodes, edges, remember, setNodes])

  const loadTemplate = useCallback((templateId: string) => {
    const template = builtinCanvasTemplates.find((entry) => entry.id === templateId)
    if (!template) return
    remember()
    try {
      const instance = placeTemplateInstance(instantiateTemplate(template, {
        availableNodeTypes: new Set(builtinNodeRegistry.list().map((definition) => definition.type)),
        createId: nextNodeId,
        draft: true,
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
          data: workflowNodeData(node.type, { ...imageOperationDefaults(node.type), ...node.config }),
        })
      })
      setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...insertedNodes.map((node) => ({ ...node, selected: true }))])
      setEdges((current) => [...current.map((edge) => ({ ...edge, selected: false })), ...instance.edges.map((edge) => ({ ...edge, selected: true }))])
      setBanner(`已插入模板「${template.name}」`)
      fitCanvas()
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [remember, nodes, setNodes, setEdges, fitCanvas])

  const addAssetNode = useCallback((assetId: string, position?: { x: number; y: number }) => {
    const asset = assetPage.items.find((entry) => entry.assetId === assetId)
    if (!asset) return
    createAssetNode(asset, position)
  }, [assetPage.items, createAssetNode])

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
    remember()
    const pasted = pasteCanvasClipboard(clipboard, {
      offset: { x: 32, y: 32 },
      createNodeId: () => nextNodeId(),
      createEdgeId: () => nextNodeId(),
    })
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...pasted.nodes.map((node) => toCanvasNode({
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
      })),
    ])
    setEdges((current) => [...current.map((edge) => ({ ...edge, selected: false })), ...pasted.edges])
  }, [remember, setNodes, setEdges])

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
    }))
    const grouped = groupCanvasNodes(editorNodes, selected, { groupId: nextNodeId(), title: '创作分组' })
    if (!grouped) return
    remember()
    setNodes(grouped.map((node) => toCanvasNode({
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
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    })))
  }, [nodes, remember, setNodes])

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
    })), group.id)
    if (!ungrouped) return
    remember()
    setNodes(ungrouped.map((node) => toCanvasNode({
      id: node.id,
      kind: node.type as NodeKind,
      definitionVersion: node.definitionVersion,
      position: node.position,
      data: node.data as unknown as WorkflowNode['data'],
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    })))
  }, [nodes, remember, setNodes])

  const isValidConnection = useCallback((connection: Connection | Edge) => (
    isValidWorkflowConnection(connection as Connection, {
      nodeKindOf: (nodeId) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        return (node?.type as NodeKind | undefined) ?? null
      },
      edges,
    })
  ), [nodes, edges])

  const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id)

  const currentRunScope = useCallback((): CanvasRunScope => {
    const runnableIds = new Set(nodes.filter(isCanvasRunNode).map((node) => node.id))
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
    if (nodeIds.length !== 1) throw new Error('“运行到节点”需要且只能选择一个可运行节点')
    return { kind: 'to-node', nodeId: nodeIds[0] }
  }, [runScopeKind, nodes, dirtyNodeIds, selectedNodeIds])

  const run = async () => {
    if (running) return
    setRunning(true)
    setBanner(null)
    if (selectedGroup && window.xingmangCanvasHost) {
      try {
        const graph = toCanvasRunGraph(nodes, edges, selectedGroup)
        const scope = currentRunScope()
        const started = await hostBridge().startRun({ graph, scope })
        activeRunRef.current = { ...started, scope }
        setRunInspectorOpen(true)
        setBanner('工作流已交由安全运行服务')
        // 缓存命中的工作流可能在 startRun IPC 返回前已发出终态事件。
        // 立即读取持久记录可补回该事件，避免运行按钮永久停在“取消”。
        void refreshRuns(started.runId)
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
    ...createEmptyWorkflow('画布工作流'),
    nodes: nodes.map(toWorkflowNode),
    edges: edges.map(toWorkflowEdge),
  })

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
      remember()
      setNodes(workflow.nodes.map(toCanvasNode))
      setEdges(workflow.edges.map((edge) => ({ ...edge })))
      void refreshAssets()
      setBanner(`已导入项目和 ${result.importedAssetCount} 个本地素材${result.warnings.length ? `；${result.warnings.join('；')}` : ''}`)
      fitCanvas()
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }

  const load = async () => {
    const picked = await hostBridge().pickFile()
    if (!picked) return
    const project = parseXingCanvasProject(picked.content)
    const workflow = project?.workflow ?? parseWorkflowFile(picked.content)
    if (!workflow) {
      setBanner('无法读取该文件:不是有效的星芒工作流')
      return
    }
    remember()
    setNodes(workflow.nodes.map(toCanvasNode))
    setEdges(workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
    })))
    setBanner(project?.warnings.length
      ? `已打开「${workflow.name}」；${project.warnings.join('；')}`
      : `已打开「${workflow.name}」`)
    fitCanvas()
  }

  // 「展开到画布」:把简单模式的一次输入物化成节点链,替换当前画布内容
  // (简单模式是入口形态,此时画布通常为空;后续可加"合并而非替换"选项)。
  const expandToCanvas = (workflow: WorkflowFile) => {
    remember()
    setNodes(workflow.nodes.map(toCanvasNode))
    setEdges(workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
    })))
    setViewMode('canvas')
    setBanner('已从简单模式展开为工作流,可继续编排')
    fitCanvas()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = resolveCanvasShortcut(event)
      if (!shortcut) return
      if (shortcut === 'undo') { event.preventDefault(); undo() }
      else if (shortcut === 'redo') { event.preventDefault(); redo() }
      else if (shortcut === 'save') { event.preventDefault(); void save() }
      else if (shortcut === 'open') { event.preventDefault(); void load() }
      else if (shortcut === 'run') { event.preventDefault(); void run() }
      else if (shortcut === 'layout') { event.preventDefault(); autoLayout() }
      else if (shortcut === 'copy') { event.preventDefault(); copySelection() }
      else if (shortcut === 'paste') { event.preventDefault(); pasteSelection() }
      else if (shortcut === 'duplicate') { event.preventDefault(); copySelection(); pasteSelection() }
      else if (shortcut === 'group') { event.preventDefault(); groupSelection() }
      else if (shortcut === 'ungroup') { event.preventDefault(); ungroupSelection() }
      else if (shortcut === 'select-all') {
        event.preventDefault()
        setNodes((current) => current.map((node) => ({ ...node, selected: true })))
      } else if (shortcut === 'delete') {
        const selected = new Set(nodes.filter((node) => node.selected).map((node) => node.id))
        if (!selected.size) return
        event.preventDefault()
        remember()
        setNodes((current) => current.filter((node) => !selected.has(node.id)))
        setEdges((current) => current.filter((edge) => !selected.has(edge.source) && !selected.has(edge.target)))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, save, load, run, autoLayout, copySelection, pasteSelection, groupSelection, ungroupSelection, nodes, remember, setNodes, setEdges])

  if (viewMode === 'simple') {
    return (
      <div className="canvas-app">
        <header className="canvas-toolbar">
          <strong>星芒 AI 生成</strong>
          <div className="canvas-toolbar-group">
            <button type="button" onClick={() => setViewMode('canvas')}>画布模式</button>
          </div>
          {groups.length > 0 && (
            <select
              className="canvas-group-select"
              value={selectedGroup ?? ''}
              aria-label="生成分组"
              onChange={(event) => void selectGroup(event.target.value)}
            >
              {groups.map((group) => <option key={group.name} value={group.name}>{group.name} · {group.ratio}x</option>)}
            </select>
          )}
          <span className="canvas-mode">{selectedGroup ? `已连接 ${selectedGroup}` : '演示模式'}</span>
        </header>
        <SimpleMode
          executors={buildExecutors()}
          connected={selectedGroup !== null}
          onExpandToCanvas={expandToCanvas}
        />
        <ModelSuggestions />
      </div>
    )
  }

  return (
    <div className="canvas-app">
      <header className="canvas-toolbar">
        <strong>星芒无限画布</strong>
        <div className="canvas-toolbar-group">
          <button type="button" onClick={() => setViewMode('simple')}>简单模式</button>
        </div>
        <div className="canvas-toolbar-group">
          <button type="button" onClick={() => addNode('prompt')}>+ 提示词</button>
          <button type="button" onClick={() => addNode('image-generate')}>+ 生图</button>
          <button type="button" onClick={() => addNode('video-generate')}>+ 视频</button>
        </div>
        <div className="canvas-toolbar-group">
          <button type="button" className="canvas-icon-command" title="撤销" aria-label="撤销" onClick={undo} disabled={!history.length}><Undo2 size={15} /></button>
          <button type="button" className="canvas-icon-command" title="重做" aria-label="重做" onClick={redo} disabled={!future.length}><Redo2 size={15} /></button>
          <button type="button" onClick={autoLayout} disabled={!nodes.length}>自动布局</button>
          <button type="button" title="将选中节点收进分组" onClick={groupSelection}>分组</button>
          <button type="button" onClick={() => loadTemplate(builtinCanvasTemplates[0].id)}>快速模板</button>
          <button type="button" onClick={showAssetTray}>资产</button>
          <button type="button" onClick={() => { setRunInspectorOpen(true); void refreshRuns() }}>运行历史</button>
          <button type="button" onClick={() => void load()}>打开</button>
          <button type="button" onClick={() => void save()}>保存</button>
          <button type="button" onClick={() => void importProject()}>导入项目</button>
          <button type="button" onClick={() => void exportProject()}>导出项目</button>
          {running
            ? <button type="button" className="canvas-run" onClick={cancel}>取消</button>
            : <button type="button" className="canvas-run" onClick={() => void run()} disabled={nodes.length === 0}>运行工作流</button>}
        </div>
        {groups.length > 0 && (
          <select
            className="canvas-group-select"
            value={selectedGroup ?? ''}
            aria-label="生成分组"
            onChange={(event) => void selectGroup(event.target.value)}
          >
            {groups.map((group) => <option key={group.name} value={group.name}>{group.name} · {group.ratio}x</option>)}
          </select>
        )}
        <span className="canvas-mode">{selectedGroup ? `已连接 ${selectedGroup}` : '演示模式'}</span>
        {banner && <span className="canvas-banner" role="status" aria-live="polite">{banner}</span>}
      </header>
      <div className="canvas-workspace">
      <NodeLibrary
        onAdd={addNode}
        onAddPrompt={(prompt) => addNode('prompt', undefined, { prompt })}
        onAddAsset={addAssetNode}
        onDeletePromptPreset={(id) => void deletePromptPreset(id)}
        onLoadTemplate={loadTemplate}
        onOpenAssets={showAssetTray}
        onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
        assets={assetPage}
        userPromptPresets={userPromptPresets}
      />
      <div className="canvas-flow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onCanvasNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          fitView
          proOptions={{ hideAttribution: false }}
          onInit={(instance) => { reactFlowRef.current = instance }}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1, 2]}
          panOnScroll
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
          onDrop={(event) => {
            event.preventDefault()
            const position = reactFlowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
            if (!position) return
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
          <Background />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
      </div>
      {assetTrayOpen && (
        <AssetTray
          page={assetPage}
          query={assetQuery}
          loading={assetsLoading}
          onQueryChange={changeAssetQuery}
          onRefresh={() => void refreshAssets()}
          onImport={() => void pickAssetToCanvas()}
          onAdd={addAssetNode}
          onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
          onClose={() => setAssetTrayOpen(false)}
        />
      )}
      <RunInspector
        open={runInspectorOpen}
        records={runRecords}
        selectedRunId={selectedRunId}
        selectedCandidateIds={Object.fromEntries(nodes.map((node) => [node.id, node.data.selectedCandidateId]))}
        selectedScope={runScopeKind}
        dirtyCount={dirtyNodeIds.size}
        selectionCount={selectedNodeIds.length}
        loading={runsLoading}
        onScopeChange={setRunScopeKind}
        onRefresh={() => void refreshRuns()}
        onSelectRun={setSelectedRunId}
        onSelectCandidate={selectCandidate}
        onAdopt={adoptCandidate}
        onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
        onClose={() => setRunInspectorOpen(false)}
      />
      </div>
      <ModelSuggestions />
      <MediaLightbox
        asset={previewAsset}
        onClose={() => setPreviewAsset(null)}
        onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
      />
    </div>
  )
}
