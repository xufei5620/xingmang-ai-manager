import type { Connection } from '@xyflow/react'
import { builtinNodeRegistry } from './domain/builtin-node-definitions'
import type { PortKind } from './model'

// 端口语义类型系统 —— React Flow 的 Handle 只有 source/target 方向,
// image/text/video 的类型匹配是应用层职责(库不提供,横评已核实)。
// 约定:handle id = `in:<kind>` / `out:<kind>`,连线时解出两端类型比对。

export function inputHandleId(kind: PortKind): string {
  return `in:${kind}`
}

export function outputHandleId(kind: PortKind): string {
  return `out:${kind}`
}

export function handleKind(handleId: string | null | undefined): PortKind | null {
  if (!handleId) return null
  const [, name] = handleId.split(':')
  // Multi-input ports are named in the plural (in:images, in:videos, in:audios)
  // and carry the same media kind as their singular counterparts.
  const kind = name === 'images' || name === 'videos' || name === 'audios' ? name.slice(0, -1) : name
  return kind === 'text' || kind === 'image' || kind === 'video' || kind === 'audio' ? kind : null
}

export interface ConnectionGraphView {
  /** Compatibility name: the value is a registry node type, including legacy aliases. */
  nodeKindOf(nodeId: string): string | null
  /** 现有边表,用于成环检测(source→target 邻接)。 */
  edges: readonly { source: string; target: string; targetHandle?: string | null }[]
}

export interface PendingCanvasConnection {
  nodeId: string
  handleId: string
  handleType: 'source' | 'target'
}

const insertionCandidateId = '__xingmang_pending_node__'

/**
 * Resolve the compatible handle on a node inserted at the loose end of a
 * connection. The regular graph validator remains the single source of truth.
 */
export function compatibleInsertionHandle(
  candidateNodeType: string,
  pending: PendingCanvasConnection,
  graph: ConnectionGraphView,
): string | null {
  const pendingNodeType = graph.nodeKindOf(pending.nodeId)
  if (!pendingNodeType) return null
  const pendingDirection = pending.handleType === 'source' ? 'output' : 'input'
  const pendingPort = builtinNodeRegistry.port(pendingNodeType, pending.handleId, pendingDirection)
  const candidate = builtinNodeRegistry.resolve(candidateNodeType)
  if (!pendingPort || !candidate || candidate.type === 'unknown') return null
  const candidateDirection = pending.handleType === 'source' ? 'input' : 'output'
  const prospectiveGraph: ConnectionGraphView = {
    edges: graph.edges,
    nodeKindOf: (nodeId) => nodeId === insertionCandidateId ? candidateNodeType : graph.nodeKindOf(nodeId),
  }
  for (const port of candidate.ports) {
    if (port.direction !== candidateDirection || port.kind !== pendingPort.kind) continue
    const connection = connectionForInsertedNode(pending, insertionCandidateId, port.id)
    if (isValidWorkflowConnection(connection, prospectiveGraph)) return port.id
  }
  return null
}

export function connectionForInsertedNode(
  pending: PendingCanvasConnection,
  insertedNodeId: string,
  insertedHandleId: string,
): Connection {
  return pending.handleType === 'source'
    ? {
        source: pending.nodeId,
        sourceHandle: pending.handleId,
        target: insertedNodeId,
        targetHandle: insertedHandleId,
      }
    : {
        source: insertedNodeId,
        sourceHandle: insertedHandleId,
        target: pending.nodeId,
        targetHandle: pending.handleId,
      }
}

function reaches(edges: readonly { source: string; target: string }[], from: string, to: string): boolean {
  const queue = [from]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (current === to) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of edges) {
      if (edge.source === current) queue.push(edge.target)
    }
  }
  return false
}

/**
 * 连线校验:类型匹配(image 输出只能进 image 输入)+ 端口方向 + 禁止成环。
 * 挂在 ReactFlow 组件的全局 isValidConnection 上。
 */
export function isValidWorkflowConnection(connection: Connection, graph: ConnectionGraphView): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false
  const sourceNodeType = graph.nodeKindOf(connection.source)
  const targetNodeType = graph.nodeKindOf(connection.target)
  if (!sourceNodeType || !targetNodeType || !connection.sourceHandle || !connection.targetHandle) return false
  const sourcePort = builtinNodeRegistry.port(sourceNodeType, connection.sourceHandle, 'output')
  const targetPort = builtinNodeRegistry.port(targetNodeType, connection.targetHandle, 'input')
  if (!sourcePort || !targetPort || sourcePort.kind !== targetPort.kind) return false
  if (targetPort.cardinality === 'one' && graph.edges.some((edge) => (
    edge.target === connection.target
    && edge.targetHandle === connection.targetHandle
  ))) return false
  // target 已能到达 source 时,再连 source→target 会成环。
  if (reaches(graph.edges, connection.target, connection.source)) return false
  return true
}
