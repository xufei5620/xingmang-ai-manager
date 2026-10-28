import { applyNodeChanges, type Node, type NodeDimensionChange } from '@xyflow/react'

export function applyNodeMeasurements<NodeType extends Node>(nodes: NodeType[], measurements: readonly NodeDimensionChange[]): NodeType[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const changes = measurements.filter((change) => {
    const node = byId.get(change.id), size = change.dimensions
    if (!node || !size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return false
    const writeWidth = change.setAttributes === true || change.setAttributes === 'width'
    const writeHeight = change.setAttributes === true || change.setAttributes === 'height'
    return node.measured?.width !== size.width || node.measured?.height !== size.height
      || (writeWidth && node.width !== size.width) || (writeHeight && node.height !== size.height)
  })
  return changes.length ? applyNodeChanges(changes, nodes) : nodes
}

export function createNodeMeasurementScheduler(options: {
  requestFrame(callback: () => void): number
  cancelFrame(handle: number): void
  apply(changes: NodeDimensionChange[]): void
}) {
  let frame: number | null = null
  const pending = new Map<string, NodeDimensionChange>()

  function clear() {
    if (frame !== null) options.cancelFrame(frame)
    frame = null
    pending.clear()
  }

  return {
    enqueue(changes: readonly NodeDimensionChange[]) {
      for (const change of changes) {
        if (change.resizing === undefined && change.dimensions) pending.set(change.id, { ...change, dimensions: { ...change.dimensions } })
      }
      if (!pending.size || frame !== null) return
      // React Flow emits this inside ResizeObserver. Publishing a controlled
      // node update in the same delivery can resize descendants again. Apply
      // only measured dimensions in the next frame; gestures stay synchronous.
      frame = options.requestFrame(() => {
        frame = null
        const latest = [...pending.values()]
        pending.clear()
        if (latest.length) options.apply(latest)
      })
    },
    discard(ids: readonly string[]) {
      for (const id of ids) pending.delete(id)
      if (!pending.size) clear()
    },
    clear,
  }
}
