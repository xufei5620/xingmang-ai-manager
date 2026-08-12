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
  const [, kind] = handleId.split(':')
  return kind === 'text' || kind === 'image' || kind === 'video' ? kind : null
}

export interface ConnectionGraphView {
  /** Compatibility name: the value is a registry node type, including legacy aliases. */
  nodeKindOf(nodeId: string): string | null
  /** 现有边表,用于成环检测(source→target 邻接)。 */
  edges: readonly { source: string; target: string; targetHandle?: string | null }[]
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
