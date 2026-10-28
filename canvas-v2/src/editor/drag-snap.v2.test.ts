import { describe, expect, it } from 'vitest'
import { snapDragPositionChanges } from './drag-snap'
import type { SnapBox } from './snap-guides'

function box(id: string, x: number, y: number): SnapBox {
  return { id, x, y, width: 200, height: 100 }
}

const neighbour = box('neighbour', 400, 300)

function boxes(...entries: SnapBox[]) {
  const all = [neighbour, ...entries]
  return { all, candidates: all }
}

describe('snapDragPositionChanges', () => {
  it('rewrites the drag frame so the snapped coordinate is the one recorded', () => {
    // The whole defect was that the snap lived in the view: the document kept
    // the raw pointer coordinate, so the node drifted back on drag stop, on
    // undo and on reopening the project.
    const dragged = { type: 'position', id: 'moving', position: { x: 403, y: 297 }, dragging: true }
    const result = snapDragPositionChanges([dragged], boxes(box('moving', 403, 297)))
    expect(result.changes[0]).toMatchObject({ id: 'moving', position: { x: 400, y: 300 } })
    expect(result.guides.map((guide) => guide.axis).sort()).toEqual(['x', 'y'])
    // The input frame is never mutated: React Flow reuses change objects.
    expect(dragged.position).toEqual({ x: 403, y: 297 })
  })

  it('snaps the final frame too, because that is the one that ends the drag', () => {
    const result = snapDragPositionChanges(
      [{ type: 'position', id: 'moving', position: { x: 403, y: 297 }, dragging: false }],
      boxes(box('moving', 403, 297)),
    )
    expect(result.changes[0]).toMatchObject({ position: { x: 400, y: 300 } })
  })

  it('leaves the frame alone when nothing is near enough to align to', () => {
    const changes = [{ type: 'position', id: 'moving', position: { x: 40, y: 20 }, dragging: true }]
    const result = snapDragPositionChanges(changes, boxes(box('moving', 40, 20)))
    expect(result.changes[0]).toMatchObject({ position: { x: 40, y: 20 } })
    expect(result.guides).toEqual([])
  })

  it('does not shear a multi-node drag by snapping one of its members', () => {
    const changes = [
      { type: 'position', id: 'moving', position: { x: 403, y: 297 }, dragging: true },
      { type: 'position', id: 'second', position: { x: 700, y: 297 }, dragging: true },
    ]
    const result = snapDragPositionChanges(changes, boxes(box('moving', 403, 297), box('second', 700, 297)))
    expect(result.changes).toEqual(changes)
    expect(result.guides).toEqual([])
  })

  it('ignores position updates that no pointer is driving', () => {
    // Alignment commands and layout passes also arrive as position changes;
    // snapping them would fight the exact coordinates they just computed.
    const changes = [{ type: 'position', id: 'moving', position: { x: 403, y: 297 } }]
    expect(snapDragPositionChanges(changes, boxes(box('moving', 403, 297))).changes).toEqual(changes)
  })

  it('passes through selection and dimension frames untouched', () => {
    const changes = [
      { type: 'select', id: 'moving' },
      { type: 'dimensions', id: 'moving' },
    ]
    expect(snapDragPositionChanges(changes, boxes(box('moving', 403, 297))).changes).toEqual(changes)
  })

  it('measures the dragged node from the full node list, not from the snap candidates', () => {
    // A group is draggable but is never something to align to, so it appears in
    // `all` and not in `candidates`; it still has to find its own size.
    const group = box('group', 403, 297)
    const result = snapDragPositionChanges(
      [{ type: 'position', id: 'group', position: { x: 403, y: 297 }, dragging: true }],
      { all: [neighbour, group], candidates: [neighbour] },
    )
    expect(result.changes[0]).toMatchObject({ position: { x: 400, y: 300 } })
  })

  it('leaves an unknown node alone rather than guessing its size', () => {
    const changes = [{ type: 'position', id: 'ghost', position: { x: 403, y: 297 }, dragging: true }]
    expect(snapDragPositionChanges(changes, boxes()).changes).toEqual(changes)
  })
})
