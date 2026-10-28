import type { WorkflowNodeData } from '../model'

export interface CanvasNodeRenderSnapshot {
  type?: string | null
  data: WorkflowNodeData & Record<string, unknown>
}

/** Keep geometry-only React Flow updates out of the content context. */
export function createCanvasNodeRenderSelector() {
  let previous: ReadonlyMap<string, CanvasNodeRenderSnapshot> = new Map()
  return (nodes: readonly (CanvasNodeRenderSnapshot & { id: string })[]): ReadonlyMap<string, CanvasNodeRenderSnapshot> => {
    if (previous.size === nodes.length && nodes.every((node) => {
      const entry = previous.get(node.id)
      return entry?.type === node.type && entry?.data === node.data
    })) return previous
    previous = new Map(nodes.map((node) => [node.id, { type: node.type, data: node.data }]))
    return previous
  }
}
