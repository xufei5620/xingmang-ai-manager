import type { Edge } from '@xyflow/react'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodePortDefinition } from '../domain/node-definition'
import type { AssetRef, WorkflowNodeData } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'

export interface CanvasInspectorPort extends NodePortDefinition {
  connectionCount: number
}

export interface CanvasInspectorNode {
  id: string
  kind: string
  title: string
  description: string
  status: WorkflowNodeData['status']
  prompt: string
  model: string
  quality?: string
  size?: string
  seconds?: string
  group?: string
  settings: Record<string, unknown>
  previewAsset?: AssetRef
  candidateCount: number
  attemptCount: number
  latestAttemptDurationMs?: number
  costQuota?: number
  errorMessage?: string
  dirty: boolean
  disabled: boolean
  locked: boolean
  executable: boolean
  ports: CanvasInspectorPort[]
}

function selectedPreviewAsset(node: CanvasNode): AssetRef | undefined {
  const candidate = node.data.candidates?.find((entry) => entry.candidateId === node.data.selectedCandidateId)
    ?? node.data.candidates?.find((entry) => entry.candidateId === node.data.adoptedCandidateId)
    ?? node.data.candidates?.[0]
  return candidate?.asset ?? node.data.result
}

export function projectCanvasInspectorNodes(
  nodes: readonly CanvasNode[],
  edges: readonly Edge[],
): CanvasInspectorNode[] {
  const selected = nodes.filter((node) => node.selected)
  if (selected.length === 0) return []
  const connectionCounts = new Map<string, number>()
  for (const edge of edges) {
    const sourceKey = `${edge.source}:output:${edge.sourceHandle ?? ''}`
    const targetKey = `${edge.target}:input:${edge.targetHandle ?? ''}`
    connectionCounts.set(sourceKey, (connectionCounts.get(sourceKey) ?? 0) + 1)
    connectionCounts.set(targetKey, (connectionCounts.get(targetKey) ?? 0) + 1)
  }
  return selected.map((node) => {
    const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown') ?? builtinNodeRegistry.require('unknown')
    return {
      id: node.id,
      kind: node.type ?? 'unknown',
      title: definition.title,
      description: definition.description,
      status: node.data.status,
      prompt: node.data.prompt,
      model: node.data.model,
      ...(node.data.quality ? { quality: node.data.quality } : {}),
      ...(node.data.size ? { size: node.data.size } : {}),
      ...(node.data.seconds ? { seconds: node.data.seconds } : {}),
      ...(typeof node.data.group === 'string' && node.data.group ? { group: node.data.group } : {}),
      settings: { ...(node.data.settings ?? {}) },
      ...(selectedPreviewAsset(node) ? { previewAsset: selectedPreviewAsset(node) } : {}),
      candidateCount: node.data.candidates?.length ?? 0,
      attemptCount: node.data.attemptCount ?? 0,
      ...(node.data.latestAttemptDurationMs !== undefined ? { latestAttemptDurationMs: node.data.latestAttemptDurationMs } : {}),
      ...(node.data.costQuota !== undefined ? { costQuota: node.data.costQuota } : {}),
      ...(node.data.errorMessage ? { errorMessage: node.data.errorMessage } : {}),
      dirty: Boolean(node.data.dirty),
      disabled: Boolean(node.disabled),
      locked: node.draggable === false,
      executable: definition.executable,
      ports: definition.ports.map((port) => ({
        ...port,
        connectionCount: connectionCounts.get(`${node.id}:${port.direction}:${port.id}`) ?? 0,
      })),
    }
  })
}
