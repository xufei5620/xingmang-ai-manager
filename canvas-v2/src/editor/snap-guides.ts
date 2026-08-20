export interface SnapBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface SnapGuide {
  axis: 'x' | 'y'
  /** Canvas coordinate of the guide line. */
  position: number
  /** Extent along the other axis, so the line only spans the nodes involved. */
  start: number
  end: number
}

export interface SnapResult {
  position: { x: number; y: number }
  guides: SnapGuide[]
}

export const snapThresholdPx = 6

function edgesOf(box: SnapBox, axis: 'x' | 'y'): number[] {
  return axis === 'x'
    ? [box.x, box.x + box.width / 2, box.x + box.width]
    : [box.y, box.y + box.height / 2, box.y + box.height]
}

/**
 * Nudge a dragged node so its edges or centre line up with a nearby node, and
 * report the lines to draw. Pure so the geometry can be tested without a DOM.
 *
 * Only the single closest candidate per axis wins, otherwise a node dropped
 * between two others jitters between two equally valid snaps.
 */
export function resolveSnapGuides(
  moving: SnapBox,
  others: readonly SnapBox[],
  threshold = snapThresholdPx,
): SnapResult {
  const result: SnapResult = { position: { x: moving.x, y: moving.y }, guides: [] }

  for (const axis of ['x', 'y'] as const) {
    const movingEdges = edgesOf(moving, axis)
    let best: { delta: number; position: number; other: SnapBox } | null = null

    for (const other of others) {
      if (other.id === moving.id) continue
      for (const candidate of edgesOf(other, axis)) {
        for (const edge of movingEdges) {
          const delta = candidate - edge
          if (Math.abs(delta) > threshold) continue
          if (best && Math.abs(delta) >= Math.abs(best.delta)) continue
          best = { delta, position: candidate, other }
        }
      }
    }

    if (!best) continue
    if (axis === 'x') result.position.x += best.delta
    else result.position.y += best.delta

    // Span the guide across both boxes so it reads as a relationship between
    // them rather than an infinite line across the canvas.
    const snapped = axis === 'x'
      ? { ...moving, x: result.position.x }
      : { ...moving, y: result.position.y }
    const crossStart = axis === 'x'
      ? Math.min(snapped.y, best.other.y)
      : Math.min(snapped.x, best.other.x)
    const crossEnd = axis === 'x'
      ? Math.max(snapped.y + snapped.height, best.other.y + best.other.height)
      : Math.max(snapped.x + snapped.width, best.other.x + best.other.width)
    result.guides.push({ axis, position: best.position, start: crossStart, end: crossEnd })
  }

  return result
}
