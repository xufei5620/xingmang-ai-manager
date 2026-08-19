import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodePositionChange,
} from '@xyflow/react'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import type { CanvasCommand } from './canvas-command'
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
  'adoptedCandidateId', 'dirty', 'attemptCount', 'latestAttemptDurationMs',
  'runStartedAt', 'runStage', 'runProgress', 'runProgressMode', 'runHealth', 'fromCache',
])

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
    data: Object.fromEntries(Object.entries(node.data).filter(([key]) => key !== '__canvasDisabled' && !runtimeDataKeys.has(key))),
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

function sameResult(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return left === right
  const leftResult = left as { assetId?: unknown; taskId?: unknown }
  const rightResult = right as { assetId?: unknown; taskId?: unknown }
  return leftResult.assetId === rightResult.assetId && leftResult.taskId === rightResult.taskId
}

export function canvasNodeRuntimePatch(node: CanvasNode, documentNode: EditorNodeRecord): Record<string, unknown> {
  const preserveExecutionState = sameResult(node.data.result, documentNode.data.result)
  return Object.fromEntries(Object.entries(node.data).filter(([key]) => (
    runtimeDataKeys.has(key)
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
  viewport: CanvasViewport
  mediaGroups: CanvasMediaGroups
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  setViewport(viewport: CanvasViewport): void
  execute(command: CanvasCommand): void
  undo(): void
  redo(): void
  onNodesChange(changes: NodeChange<CanvasNode>[]): void
  onEdgesChange(changes: EdgeChange<Edge>[]): void
  canUndo: boolean
  canRedo: boolean
}

export function useCanvasDocument(
  toCanvasNode: (node: EditorNodeRecord) => CanvasNode,
): CanvasDocumentController {
  const initial = createCanvasHistory(createCanvasDocument('画布工作流'))
  const historyRef = useRef<CanvasHistoryState>(initial)
  const dragTransactionRef = useRef<DragTransaction | null>(null)
  const dragSequenceRef = useRef(0)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges

  const renderDocument = useCallback((document: CanvasDocumentState, previousNodes: CanvasNode[], previousEdges: Edge[]) => {
    const previousNodeById = new Map(previousNodes.map((node) => [node.id, node]))
    const previousEdgeById = new Map(previousEdges.map((edge) => [edge.id, edge]))
    setNodes(document.nodes.map((node) => {
      const canvas = toCanvasNode(node)
      const previous = previousNodeById.get(node.id)
      if (!previous) return canvas
      return {
        ...canvas,
        selected: previous.selected,
        ...(previous.measured ? { measured: previous.measured } : {}),
        data: { ...canvas.data, ...canvasNodeRuntimePatch(previous, node) },
      }
    }))
    setEdges(document.edges.map((edge) => ({ ...edge, selected: previousEdgeById.get(edge.id)?.selected })))
  }, [toCanvasNode])

  const updateHistory = useCallback((next: CanvasHistoryState, previousNodes: CanvasNode[], previousEdges: Edge[]) => {
    historyRef.current = next
    renderDocument(next.present, previousNodes, previousEdges)
    setHistoryVersion((version) => version + 1)
  }, [renderDocument])

  const execute = useCallback((command: CanvasCommand) => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const seeded = {
      ...historyRef.current,
      present: documentFromCanvas(historyRef.current.present, currentNodes, currentEdges),
    }
    updateHistory(applyCanvasCommand(seeded, command), currentNodes, currentEdges)
  }, [updateHistory])

  const undo = useCallback(() => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const seeded = { ...historyRef.current, present: documentFromCanvas(historyRef.current.present, currentNodes, currentEdges) }
    updateHistory(undoCanvasHistory(seeded), currentNodes, currentEdges)
  }, [updateHistory])

  const redo = useCallback(() => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const seeded = { ...historyRef.current, present: documentFromCanvas(historyRef.current.present, currentNodes, currentEdges) }
    updateHistory(redoCanvasHistory(seeded), currentNodes, currentEdges)
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
    const transient = changes.filter((change) => change.type !== 'position')
    if (transient.length > 0) setNodes((current) => applyNodeChanges(transient, current))
  }, [execute])

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
    if (removed.length > 0) execute({ type: 'disconnect', edgeIds: removed })
    const transient = changes.filter((change) => change.type !== 'remove')
    if (transient.length > 0) setEdges((current) => applyEdgeChanges(transient, current))
  }, [execute])

  const setViewport = useCallback((viewport: CanvasViewport) => {
    const next = updateCanvasHistoryViewport(historyRef.current, viewport)
    if (next === historyRef.current) return
    historyRef.current = next
    setHistoryVersion((version) => version + 1)
  }, [])

  void historyVersion
  return {
    nodes,
    edges,
    viewport: historyRef.current.present.viewport,
    mediaGroups: { ...(historyRef.current.present.mediaGroups ?? {}) },
    setNodes,
    setEdges,
    setViewport,
    execute,
    undo,
    redo,
    onNodesChange,
    onEdgesChange,
    canUndo: historyRef.current.past.length > 0,
    canRedo: historyRef.current.future.length > 0,
  }
}
