import type { Edge } from '@xyflow/react'
import type { CanvasGroupSummary } from '../host'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'

/** Selection and camera changes do not invalidate a reviewed document edit. */
export function workshopModelMappingGraphSignature(nodes: readonly CanvasNode[], edges: readonly Edge[]): string {
  return JSON.stringify({ nodes: nodes.map(canvasNodeDocumentRecord), edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle ?? '', targetHandle: edge.targetHandle ?? '' })) })
}

/** A refreshed list may change order without changing a saved source identity. */
export function workshopModelMappingSourceSignature(groups: readonly CanvasGroupSummary[]): string {
  return JSON.stringify(groups.map((group) => ({ name: group.name, description: group.description, ratio: group.ratio, revision: group.revision, connectionStatus: group.connectionStatus, purposes: group.purposes, videoProtocol: group.videoProtocol })).sort((left, right) => left.name.localeCompare(right.name)))
}

export function workshopModelMappingNodes(nodes: readonly CanvasNode[]) {
  // Runtime states are needed for eligibility, but are never written by the
  // mapping command. Applying changes starts again from live canvas nodes.
  return nodes.map((node) => ({ ...canvasNodeDocumentRecord(node), data: { ...canvasNodeDocumentRecord(node).data, status: node.data.status } }))
}
