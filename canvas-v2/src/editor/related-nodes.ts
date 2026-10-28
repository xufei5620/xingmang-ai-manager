import { builtinNodeRegistry, hiddenLibraryNodeTypes } from '../domain/builtin-node-definitions'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { compatibleInsertionHandle, type PendingCanvasConnection } from '../ports'
import { canvasNodeKindAvailable, type CanvasCapabilityProfile } from '../host-capabilities'

export interface RelatedNodeOption {
  id: string
  type: string
  label: string
  pending: PendingCanvasConnection
  inputHandle: string
}

/**
 * Use the regular port validator, including cardinality and cycle rules.
 * With a host profile, nodes the host cannot run are not offered.
 */
export function relatedNodeOptions(sourceId: string, nodes: readonly Pick<EditorNodeRecord, 'id' | 'type'>[], edges: readonly EditorEdgeRecord[], capabilities?: CanvasCapabilityProfile): RelatedNodeOption[] {
  const source = nodes.find((node) => node.id === sourceId)
  const definition = source && builtinNodeRegistry.resolve(source.type)
  if (!definition) return []
  const graph = { nodeKindOf: (id: string) => nodes.find((node) => node.id === id)?.type ?? null, edges }
  return builtinNodeRegistry.list().flatMap((candidate) => {
    if (hiddenLibraryNodeTypes.has(candidate.type) || candidate.structural || (capabilities && !canvasNodeKindAvailable(candidate.type, capabilities))) return []
    const options: RelatedNodeOption[] = []
    for (const port of definition.ports) {
      if (port.direction !== 'output') continue
      const pending: PendingCanvasConnection = { nodeId: sourceId, handleId: port.id, handleType: 'source' }
      const inputHandle = compatibleInsertionHandle(candidate.type, pending, graph)
      if (!inputHandle) continue
      const batch = port.id === 'out:images'
      // A batch is an explicit choice and is only offered to multi-input
      // targets. A single-image crop must never silently receive nine slices.
      if (batch && candidate.ports.find((input) => input.id === inputHandle && input.direction === 'input')?.cardinality !== 'many') continue
      const hasImageBatch = port.kind === 'image' && definition.ports.some((entry) => entry.direction === 'output' && entry.id === 'out:images')
      const suffix = hasImageBatch ? batch ? '全部切片' : '当前切片' : ''
      options.push({ id: `${candidate.type}|${port.id}|${inputHandle}`, type: candidate.type, label: `${candidate.title}${suffix ? ` · ${suffix}` : ''}`, pending, inputHandle })
      // Keep existing first-compatible behavior for ordinary multi-media
      // nodes; this change introduces only the explicit image-batch choice.
      if (!hasImageBatch) break
    }
    return options
  })
}
