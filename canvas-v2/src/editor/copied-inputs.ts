import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'

/** A copied result is historical when one of its inputs was left behind. */
export function markCopiedInputsChanged(
  nodes: EditorNodeRecord[],
  originalEdges: readonly EditorEdgeRecord[],
  copiedIds: ReadonlySet<string>,
): void {
  const changed = new Set(originalEdges
    .filter((edge) => copiedIds.has(edge.target) && !copiedIds.has(edge.source))
    .map((edge) => edge.target))
  const outgoing = new Map<string, string[]>()
  for (const edge of originalEdges) {
    if (copiedIds.has(edge.source) && copiedIds.has(edge.target)) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
    }
  }
  const queue = [...changed]
  for (let index = 0; index < queue.length; index += 1) {
    for (const target of outgoing.get(queue[index]) ?? []) {
      if (changed.has(target)) continue
      changed.add(target)
      queue.push(target)
    }
  }
  for (const node of nodes) if (changed.has(node.id)) node.data.dirty = true
}
