import { supportsImageCandidateCount } from '../runtime/image-candidate-count'
import { canvasCommandAllowed, retainReadonlyEdges, retainReadonlyNodes } from './document-access'
import { supportsVideoCandidateCount } from '../runtime/video-candidate-count'
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeDimensionChange,
  type NodePositionChange,
} from '@xyflow/react'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import type { CanvasCommand } from './canvas-command'
import { applyNodeMeasurements, createNodeMeasurementScheduler } from './node-measurement-scheduler'
import { createInsertionViewportHistory, type InsertionViewportAction, type InsertionViewportToken } from './insertion-viewport-history'
import {
  createCanvasDocument,
  type CanvasDocumentState,
  type CanvasMediaGroups,
  type CanvasViewport,
} from './canvas-state'
import {
  applyCanvasCommand,
  createCanvasHistory,
  redoCanvasHistory,
  undoCanvasHistory,
  type CanvasHistoryState,
} from './history'

const runtimeDataKeys = new Set([
  'status', 'errorMessage', 'costQuota', 'candidateAssetIds', 'candidates', 'selectedCandidateId',
  'adoptedCandidateId', 'attemptCount', 'latestAttemptDurationMs',
  'runStartedAt', 'runStage', 'runProgress', 'runProgressMode', 'runHealth', 'fromCache',
  'videoBatchProgress',
])

function isRuntimeDataKey(node: CanvasNode, key: string): boolean {
  // Persist output order for galleries, split tiles and generated candidates: an undone
  // deletion has no live node whose runtime could recover the other assets.
  return runtimeDataKeys.has(key) && !(key === 'candidateAssetIds' && (node.type === 'gallery' || node.type === 'image-grid-split' || supportsImageCandidateCount(node.type ?? '') || supportsVideoCandidateCount(node.type ?? '')))
}

interface DragTransaction {
  key: string
  signature: string
}

export function resolveDragTransaction(
  changes: readonly NodeChange<CanvasNode>[],
  current: DragTransaction | null,
  sequence: number,
): { mergeKey?: string; active: DragTransaction | null; sequence: number } {
  const positionChanges = changes.filter((change): change is NodePositionChange => (
    change.type === 'position' && change.position !== undefined
  ))
  if (positionChanges.length === 0) return { active: current, sequence }
  const signature = positionChanges.map((change) => change.id).sort().join(',')
  const dragging = positionChanges.some((change) => change.dragging === true)
  const finished = positionChanges.some((change) => change.dragging === false)
  if (dragging) {
    const active = current?.signature === signature
      ? current
      : { key: `drag:${sequence + 1}:${signature}`, signature }
    return {
      mergeKey: active.key,
      active: finished ? null : active,
      sequence: active === current ? sequence : sequence + 1,
    }
  }
  if (finished && current?.signature === signature) {
    return { mergeKey: current.key, active: null, sequence }
  }
  return { active: current, sequence }
}

export function canvasNodeDocumentRecord(node: CanvasNode): EditorNodeRecord {
  return {
    id: node.id,
    type: node.type ?? 'unknown',
    definitionVersion: node.definitionVersion,
    position: { ...node.position },
    data: Object.fromEntries(Object.entries(node.data).filter(([key]) => key !== '__canvasDisabled' && !isRuntimeDataKey(node, key))),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    ...(node.draggable === false ? { locked: true } : {}),
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
  }
}

function persistentEdge(edge: Edge): EditorEdgeRecord {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? '',
    target: edge.target,
    targetHandle: edge.targetHandle ?? '',
  }
}

function documentFromCanvas(base: CanvasDocumentState, nodes: CanvasNode[], edges: Edge[]): CanvasDocumentState {
  return { ...base, nodes: nodes.map(canvasNodeDocumentRecord), edges: edges.map(persistentEdge) }
}

function shallowValuesEqual(left: object, right: object): boolean {
  const leftValues = left as Record<string, unknown>
  const rightValues = right as Record<string, unknown>
  return Object.keys(leftValues).every((key) => Object.is(leftValues[key], rightValues[key]))
    && Object.keys(rightValues).every((key) => Object.is(leftValues[key], rightValues[key]))
}

function reuseCanvasNodeReferences(next: CanvasNode, previous: CanvasNode): CanvasNode {
  // React Flow memoizes each node by its props. A move must not invalidate the
  // prompt editors, media elements and model controls on every other node.
  if (shallowValuesEqual(next.data, previous.data)) next.data = previous.data
  if (shallowValuesEqual(next.position, previous.position)) next.position = previous.position
  if (next.style && previous.style && shallowValuesEqual(next.style, previous.style)) next.style = previous.style
  return shallowValuesEqual(next, previous) ? previous : next
}

function sameResult(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return left === right
  const leftResult = left as { assetId?: unknown; taskId?: unknown }
  const rightResult = right as { assetId?: unknown; taskId?: unknown }
  return leftResult.assetId === rightResult.assetId && leftResult.taskId === rightResult.taskId
}

export function canvasNodeRuntimePatch(node: CanvasNode, documentNode: EditorNodeRecord): Record<string, unknown> {
  const preserveExecutionState = sameResult(node.data.result, documentNode.data.result)
  return Object.fromEntries(Object.entries(node.data).filter(([key]) => (
    isRuntimeDataKey(node, key)
      && (preserveExecutionState || !['status', 'errorMessage', 'costQuota'].includes(key))
  )))
}

export function updateCanvasHistoryViewport(
  history: CanvasHistoryState,
  viewport: CanvasViewport,
): CanvasHistoryState {
  const current = history.present.viewport
  if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) return history
  return applyCanvasCommand(history, { type: 'set-viewport', viewport })
}

export interface CanvasDocumentController {
  nodes: CanvasNode[]
  edges: Edge[]
  getGraphSnapshot(): { nodes: CanvasNode[]; edges: Edge[] }
  viewport: CanvasViewport
  mediaGroups: CanvasMediaGroups
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  setViewport(viewport: CanvasViewport): void
  applyRemoteDocument(document: CanvasDocumentState): void
  execute(command: CanvasCommand, options?: { insertionViewport: CanvasViewport }): InsertionViewportToken | null
  undo(): InsertionViewportAction | null
  redo(): InsertionViewportAction | null
  isInsertionViewportCurrent(token: InsertionViewportToken): boolean
  cancelInsertionViewportNavigation(): void
  onNodesChange(changes: NodeChange<CanvasNode>[]): void
  onEdgesChange(changes: EdgeChange<Edge>[]): void
  canUndo: boolean
  canRedo: boolean
}

export function useCanvasDocument(
  toCanvasNode: (node: EditorNodeRecord) => CanvasNode,
  options?: { canEdit(): boolean; onMutation?(): void },
): CanvasDocumentController {
  const accessRef = useRef(options)
  accessRef.current = options
  const initial = createCanvasHistory(createCanvasDocument('画布工作流'))
  const historyRef = useRef<CanvasHistoryState>(initial)
  const insertionViewportsRef = useRef(createInsertionViewportHistory())
  const dragTransactionRef = useRef<DragTransaction | null>(null)
  const dragSequenceRef = useRef(0)
  const resizeTransactionRef = useRef<DragTransaction | null>(null)
  const resizeSequenceRef = useRef(0)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [nodes, publishNodes] = useState<CanvasNode[]>([])
  const [edges, publishEdges] = useState<Edge[]>([])
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const measurementsRef = useRef<ReturnType<typeof createNodeMeasurementScheduler> | null>(null)

  // Upload completions and consecutive commands can arrive before React has
  // committed its batched render. Publish the live graph to refs first so an
  // old callback cannot rebuild the document from an earlier rendered graph.
  const publishDocumentNodes = useCallback((update: SetStateAction<CanvasNode[]>) => {
    const next = typeof update === 'function' ? update(nodesRef.current) : update
    nodesRef.current = next
    publishNodes(next)
  }, [])
  const setNodes = useCallback((update: SetStateAction<CanvasNode[]>) => {
    publishDocumentNodes((previous) => {
      const next = typeof update === 'function' ? update(previous) : update
      return accessRef.current?.canEdit() === false ? retainReadonlyNodes(previous, next) : next
    })
  }, [publishDocumentNodes])

  if (!measurementsRef.current) measurementsRef.current = createNodeMeasurementScheduler({
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    apply: (changes) => setNodes((current) => applyNodeMeasurements(current, changes)),
  })
  useEffect(() => () => measurementsRef.current?.clear(), [])

  const publishDocumentEdges = useCallback((update: SetStateAction<Edge[]>) => {
    const next = typeof update === 'function' ? update(edgesRef.current) : update
    edgesRef.current = next
    publishEdges(next)
  }, [])
  const setEdges = useCallback((update: SetStateAction<Edge[]>) => {
    publishDocumentEdges((previous) => {
      const next = typeof update === 'function' ? update(previous) : update
      return accessRef.current?.canEdit() === false ? retainReadonlyEdges(previous, next) : next
    })
  }, [publishDocumentEdges])

  const getGraphSnapshot = useCallback(() => ({ nodes: nodesRef.current, edges: edgesRef.current }), [])

  const renderDocument = useCallback((document: CanvasDocumentState, previousNodes: CanvasNode[], previousEdges: Edge[]) => {
    const previousNodeById = new Map(previousNodes.map((node) => [node.id, node]))
    const previousEdgeById = new Map(previousEdges.map((edge) => [edge.id, edge]))
    const renderedNodes = document.nodes.map((node) => {
      const canvas = toCanvasNode(node)
      const previous = previousNodeById.get(node.id)
      if (!previous) return canvas
      return reuseCanvasNodeReferences({
        ...canvas,
        selected: previous.selected,
        ...(previous.measured ? { measured: previous.measured } : {}),
        data: { ...canvas.data, ...canvasNodeRuntimePatch(previous, node) },
      }, previous)
    })
    const renderedEdges = document.edges.map((edge) => {
      const previous = previousEdgeById.get(edge.id)
      const next = { ...edge, selected: previous?.selected }
      return previous && shallowValuesEqual(next, previous) ? previous : next
    })
    publishDocumentNodes(renderedNodes.length === previousNodes.length && renderedNodes.every((node, index) => node === previousNodes[index]) ? previousNodes : renderedNodes)
    publishDocumentEdges(renderedEdges.length === previousEdges.length && renderedEdges.every((edge, index) => edge === previousEdges[index]) ? previousEdges : renderedEdges)
  }, [toCanvasNode, publishDocumentNodes, publishDocumentEdges])

  const updateHistory = useCallback((next: CanvasHistoryState, previousNodes: CanvasNode[], previousEdges: Edge[]) => {
    historyRef.current = next
    renderDocument(next.present, previousNodes, previousEdges)
    setHistoryVersion((version) => version + 1)
  }, [renderDocument])

  const applyRemoteDocument = useCallback((document: CanvasDocumentState) => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const incomingIds = new Set(document.nodes.map((node) => node.id))
    measurementsRef.current?.discard(currentNodes.filter((node) => !incomingIds.has(node.id)).map((node) => node.id))
    dragTransactionRef.current = null
    resizeTransactionRef.current = null
    insertionViewportsRef.current.reset()
    // A remote graph invalidates prior execution approval, but cannot become a
    // local undo snapshot or take ownership of this browser's navigation.
    accessRef.current?.onMutation?.()
    updateHistory(createCanvasHistory({
      ...document,
      viewport: { ...historyRef.current.present.viewport },
    }), currentNodes, currentEdges)
  }, [updateHistory])

  const execute = useCallback((command: CanvasCommand, options?: { insertionViewport: CanvasViewport }): InsertionViewportToken | null => {
    if (!canvasCommandAllowed(command, accessRef.current?.canEdit() !== false)) return null
    if (options && command.type !== 'add-nodes') throw new Error('自动聚焦只能关联本次新增节点')
    if (command.type === 'replace-document' && command.resetHistory) {
      measurementsRef.current?.clear()
      dragTransactionRef.current = null
      resizeTransactionRef.current = null
      // Reused node IDs belong to a different project; neither selection nor
      // in-flight execution patches may leak across this document boundary.
      accessRef.current?.onMutation?.()
      insertionViewportsRef.current.reset()
      updateHistory(createCanvasHistory(command.document), [], [])
      return null
    }
    if (command.type === 'delete-elements') measurementsRef.current?.discard(command.nodeIds ?? [])
    if (command.type === 'resize-nodes') measurementsRef.current?.discard(Object.keys(command.dimensions))
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const seeded = {
      ...historyRef.current,
      present: documentFromCanvas(historyRef.current.present, currentNodes, currentEdges),
    }
    const next = applyCanvasCommand(seeded, command)
    const token = next !== seeded && command.type !== 'set-viewport'
      ? insertionViewportsRef.current.record(next.past !== seeded.past, next.past.length, options && command.type === 'add-nodes' ? { viewport: options.insertionViewport, nodeIds: command.nodes.map((node) => node.id) } : undefined)
      : null
    if (next !== seeded && command.type !== 'set-viewport' && command.type !== 'rename-document') accessRef.current?.onMutation?.()
    updateHistory(next, currentNodes, currentEdges)
    return token
  }, [updateHistory])

  const undo = useCallback(() => {
    if (accessRef.current?.canEdit() === false) return null
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const seeded = { ...historyRef.current, present: documentFromCanvas(historyRef.current.present, currentNodes, currentEdges) }
    let next = undoCanvasHistory(seeded)
    const navigation = next === seeded ? null : insertionViewportsRef.current.undo()
    if (navigation?.kind === 'restore') next = updateCanvasHistoryViewport(next, navigation.viewport)
    if (next !== seeded) accessRef.current?.onMutation?.()
    updateHistory(next, currentNodes, currentEdges)
    return navigation
  }, [updateHistory])

  const redo = useCallback(() => {
    if (accessRef.current?.canEdit() === false) return null
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const seeded = { ...historyRef.current, present: documentFromCanvas(historyRef.current.present, currentNodes, currentEdges) }
    const next = redoCanvasHistory(seeded)
    const navigation = next === seeded ? null : insertionViewportsRef.current.redo()
    if (next !== seeded) accessRef.current?.onMutation?.()
    updateHistory(next, currentNodes, currentEdges)
    return navigation
  }, [updateHistory])

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
    const positions = Object.fromEntries(changes.flatMap((change) => (
      change.type === 'position' && change.position ? [[change.id, change.position] as const] : []
    )))
    if (removed.length > 0) {
      execute({ type: 'delete-elements', nodeIds: removed })
      return
    }
    if (Object.keys(positions).length > 0) {
      const transaction = resolveDragTransaction(changes, dragTransactionRef.current, dragSequenceRef.current)
      dragTransactionRef.current = transaction.active
      dragSequenceRef.current = transaction.sequence
      const mergeKey = transaction.mergeKey
      execute({ type: 'move-nodes', positions, ...(mergeKey ? { mergeKey } : {}) })
    }
    // React Flow reports resizing as a stream of dimension changes with
    // resizing: true, then one final frame. Treating them as transient would
    // apply the size to the view but never to the document, so the node would
    // snap back on the next undo, redo or project reload.
    const resizes = Object.fromEntries(changes.flatMap((change) => (
      change.type === 'dimensions' && change.resizing !== undefined && change.dimensions
        ? [[change.id, { width: change.dimensions.width, height: change.dimensions.height }] as const]
        : []
    )))
    if (Object.keys(resizes).length > 0) {
      const signature = Object.keys(resizes).sort().join(',')
      const stillResizing = changes.some((change) => change.type === 'dimensions' && change.resizing === true)
      if (resizeTransactionRef.current?.signature !== signature) {
        resizeSequenceRef.current += 1
        resizeTransactionRef.current = { key: `resize:${resizeSequenceRef.current}:${signature}`, signature }
      }
      const mergeKey = resizeTransactionRef.current.key
      if (!stillResizing) resizeTransactionRef.current = null
      execute({ type: 'resize-nodes', dimensions: resizes, mergeKey })
    }
    const transient = changes.filter((change) => (
      change.type !== 'position'
      && change.type !== 'dimensions'
    ))
    if (transient.length > 0) setNodes((current) => applyNodeChanges(transient, current))
    measurementsRef.current?.enqueue(changes.filter((change): change is NodeDimensionChange => change.type === 'dimensions' && change.resizing === undefined))
  }, [execute, setNodes])

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
    if (removed.length > 0) execute({ type: 'disconnect', edgeIds: removed })
    const transient = changes.filter((change) => change.type !== 'remove')
    if (transient.length > 0) setEdges((current) => applyEdgeChanges(transient, current))
  }, [execute, setEdges])

  const setViewport = useCallback((viewport: CanvasViewport) => {
    const next = updateCanvasHistoryViewport(historyRef.current, viewport)
    if (next === historyRef.current) return
    historyRef.current = next
    setHistoryVersion((version) => version + 1)
  }, [])
  const isInsertionViewportCurrent = useCallback((token: InsertionViewportToken) => insertionViewportsRef.current.current(token), [])
  const cancelInsertionViewportNavigation = useCallback(() => insertionViewportsRef.current.userNavigation(), [])

  const storedMediaGroups = historyRef.current.present.mediaGroups
  const mediaGroups = useMemo(() => ({ ...storedMediaGroups }), [storedMediaGroups])

  void historyVersion
  return {
    nodes,
    edges,
    getGraphSnapshot,
    viewport: historyRef.current.present.viewport,
    mediaGroups,
    setNodes,
    setEdges,
    setViewport,
    applyRemoteDocument,
    execute,
    undo,
    redo,
    isInsertionViewportCurrent,
    cancelInsertionViewportNavigation,
    onNodesChange,
    onEdgesChange,
    canUndo: options?.canEdit() !== false && historyRef.current.past.length > 0,
    canRedo: options?.canEdit() !== false && historyRef.current.future.length > 0,
  }
}
