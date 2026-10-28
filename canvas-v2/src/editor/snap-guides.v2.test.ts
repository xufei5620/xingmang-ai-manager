import { describe, expect, it } from 'vitest'
import { resolveSnapGuides, snapThresholdPx, type SnapBox } from './snap-guides'

function box(id: string, x: number, y: number, width = 100, height = 60): SnapBox {
  return { id, x, y, width, height }
}

describe('resolveSnapGuides', () => {
  it('snaps a near-miss left edge into alignment', () => {
    const result = resolveSnapGuides(box('m', 3, 200), [box('a', 0, 0)])
    expect(result.position.x).toBe(0)
    expect(result.guides).toContainEqual({ axis: 'x', position: 0, start: 0, end: 260 })
  })

  it('leaves a node alone when nothing is within the threshold', () => {
    const result = resolveSnapGuides(box('m', 400, 400), [box('a', 0, 0)])
    expect(result.position).toEqual({ x: 400, y: 400 })
    expect(result.guides).toEqual([])
  })

  it('aligns centres, not only edges', () => {
    // Moving box centre is at x = 205; target centre is at x = 200.
    const result = resolveSnapGuides(box('m', 155, 300), [box('a', 150, 0)])
    expect(result.position.x).toBe(150)
  })

  it('snaps both axes independently in one gesture', () => {
    const result = resolveSnapGuides(box('m', 4, 3), [box('a', 0, 0, 100, 60)])
    expect(result.position).toEqual({ x: 0, y: 0 })
    expect(result.guides.map((guide) => guide.axis).sort()).toEqual(['x', 'y'])
  })

  it('keeps only the closest candidate per axis', () => {
    // Two targets both within range; the nearer one must win outright rather
    // than the node jittering between them.
    const result = resolveSnapGuides(box('m', 3, 500), [box('a', 0, 0), box('b', 5, 100)])
    expect(result.position.x).toBe(5)
    expect(result.guides.filter((guide) => guide.axis === 'x')).toHaveLength(1)
  })

  it('never snaps a node to itself', () => {
    const moving = box('m', 10, 10)
    expect(resolveSnapGuides(moving, [moving]).position).toEqual({ x: 10, y: 10 })
  })

  it('spans the guide across both boxes rather than the whole canvas', () => {
    const guide = resolveSnapGuides(box('m', 2, 400, 100, 60), [box('a', 0, 0, 100, 60)]).guides[0]
    expect(guide.start).toBe(0)
    expect(guide.end).toBe(460)
  })

  it('honours a caller supplied threshold', () => {
    expect(resolveSnapGuides(box('m', 20, 300), [box('a', 0, 0)], 4).position.x).toBe(20)
    expect(resolveSnapGuides(box('m', 20, 300), [box('a', 0, 0)], 24).position.x).toBe(0)
  })

  it('uses a threshold small enough not to fight deliberate placement', () => {
    expect(snapThresholdPx).toBeLessThanOrEqual(8)
  })
})
