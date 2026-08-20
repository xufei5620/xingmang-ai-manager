import { resolveSnapGuides, snapThresholdPx, type SnapBox, type SnapGuide } from './snap-guides'

/**
 * Applies alignment snapping to the drag frame itself.
 *
 * Snapping used to be painted on top of the drag: the guides were computed in
 * `onNodeDrag` and written straight to the view with `setNodes`, while the
 * position change that React Flow had already reported carried the raw pointer
 * coordinate into the document. The guides flashed, the node appeared to click
 * into place, and then the drag ended on the unsnapped coordinate -- which is
 * also the one that went into history, autosave and the saved project. Rewriting
 * the change here makes the snapped coordinate the only coordinate: the view,
 * the undo entry and the file all agree because they all come from it.
 */

export interface DragPositionChange {
  type: string
  id?: string
  position?: { x: number; y: number }
  dragging?: boolean
}

export interface DragSnapResult<T> {
  changes: T[]
  guides: SnapGuide[]
}

function draggedChange<T extends DragPositionChange>(changes: readonly T[]): T | null {
  // Only a lone node snaps. In a multi-node drag the group has no single edge to
  // align, and nudging one member would silently shear the arrangement the user
  // already built.
  const dragged = changes.filter((change) => (
    change.type === 'position' && change.position !== undefined && change.dragging !== undefined
  ))
  return dragged.length === 1 ? dragged[0] as T : null
}

export function snapDragPositionChanges<T extends DragPositionChange>(
  changes: readonly T[],
  boxes: {
    /** Every node, so the dragged one can be measured. */
    all: readonly SnapBox[]
    /** The nodes it may align to; groups are excluded by the caller. */
    candidates: readonly SnapBox[]
  },
  threshold = snapThresholdPx,
): DragSnapResult<T> {
  const unchanged = { changes: [...changes], guides: [] as SnapGuide[] }
  const dragged = draggedChange(changes)
  if (!dragged) return unchanged
  const box = boxes.all.find((entry) => entry.id === dragged.id)
  if (!box) return unchanged
  const moving = { ...box, x: dragged.position!.x, y: dragged.position!.y }
  const result = resolveSnapGuides(moving, boxes.candidates.filter((entry) => entry.id !== moving.id), threshold)
  if (result.guides.length === 0) return unchanged
  return {
    changes: changes.map((change) => (change === dragged ? { ...change, position: result.position } : change)),
    guides: result.guides,
  }
}
