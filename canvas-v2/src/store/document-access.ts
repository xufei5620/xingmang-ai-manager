import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import type { CanvasCommand } from './canvas-command'

/** Hydration is trusted host input; viewing and measuring never edit document content. */
export function canvasCommandAllowed(command: CanvasCommand, canEdit: boolean): boolean {
  return canEdit || command.type === 'set-viewport' || command.type === 'replace-document' && command.resetHistory === true
}

export function retainReadonlyNodes(previous: CanvasNode[], proposed: CanvasNode[]): CanvasNode[] {
  const next = new Map(proposed.map((node) => [node.id, node]))
  return previous.map((node) => {
    const update = next.get(node.id)
    if (!update || update.selected === node.selected && update.measured === node.measured) return node
    return { ...node, selected: update.selected, measured: update.measured }
  })
}

export function retainReadonlyEdges(previous: Edge[], proposed: Edge[]): Edge[] {
  const next = new Map(proposed.map((edge) => [edge.id, edge]))
  return previous.map((edge) => {
    const update = next.get(edge.id)
    return !update || update.selected === edge.selected ? edge : { ...edge, selected: update.selected }
  })
}
