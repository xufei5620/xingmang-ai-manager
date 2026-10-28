import { describe, expect, it } from 'vitest'
import { findAvailableCanvasPosition, type CanvasPlacementNode } from './node-placement'
import { maximumMediaAssetNodeEdge, mediaAssetNodeDimensions, unresolvedMediaPlacementDimensions } from '../library/media-assets'

function intersects(position: { x: number; y: number }, size: { width: number; height: number }, obstacle: CanvasPlacementNode, gap = 28): boolean {
  return position.x < obstacle.position.x + (obstacle.measured?.width ?? obstacle.width ?? 280) + gap
    && position.x + size.width + gap > obstacle.position.x
    && position.y < obstacle.position.y + (obstacle.measured?.height ?? obstacle.height ?? 220) + gap
    && position.y + size.height + gap > obstacle.position.y
}

describe('default canvas node placement', () => {
  it('centres an empty graph and keeps a free preferred position unchanged', () => {
    const size = { width: 480, height: 160 }
    expect(findAvailableCanvasPosition([], { x: 800, y: 400 }, size)).toEqual({ x: 560, y: 320 })
    expect(findAvailableCanvasPosition([{ position: { x: -2000, y: -2000 } }], { x: 800, y: 400 }, size)).toEqual({ x: 560, y: 320 })
  })

  it('places repeated mixed-aspect imports without changing any earlier rectangle', () => {
    const nodes: CanvasPlacementNode[] = [{ id: 'wide', position: { x: 100, y: 100 }, width: 1000, height: 600 }]
    const first = structuredClone(nodes[0])
    for (const size of [{ width: 480, height: 80 }, { width: 96, height: 480 }, { width: 360, height: 104 }, { width: 280, height: 280 }, { width: 320, height: 180 }]) {
      const before = structuredClone(nodes)
      const position = findAvailableCanvasPosition(nodes, { x: 600, y: 400 }, size)
      expect(nodes.every((node) => !intersects(position, size, node))).toBe(true)
      expect(nodes).toEqual(before)
      nodes.push({ position, ...size })
    }
    expect(nodes[0]).toEqual(first)
  })

  it('uses measured dimensions and falls back from invalid measurements to persisted sizes', () => {
    const wide: CanvasPlacementNode = { position: { x: -1000, y: -1000 }, width: 10, height: 10, measured: { width: 2000, height: 2000 } }
    const size = { width: 280, height: 280 }
    expect(intersects(findAvailableCanvasPosition([wide], { x: 0, y: 0 }, size), size, wide)).toBe(false)
    const persisted = { ...wide, width: 2000, height: 2000, measured: { width: Number.NaN, height: 0 } }
    expect(intersects(findAvailableCanvasPosition([persisted], { x: 0, y: 0 }, size), size, { ...persisted, measured: undefined })).toBe(false)
  })

  it('resolves nested child rectangles in world space even outside an undersized group', () => {
    const nodes: CanvasPlacementNode[] = [
      { id: 'outer', type: 'group', position: { x: 1000, y: -1000 }, width: 100, height: 100 },
      { id: 'inner', type: 'group', parentId: 'outer', position: { x: 600, y: 700 }, width: 100, height: 100 },
      { id: 'child', parentId: 'inner', position: { x: 400, y: 500 }, width: 800, height: 600 },
    ]
    const size = { width: 200, height: 200 }
    const result = findAvailableCanvasPosition(nodes, { x: 2400, y: 500 }, size)
    expect(intersects(result, size, { position: { x: 2000, y: 200 }, width: 800, height: 600 })).toBe(false)
    // The child's local coordinate is not a phantom obstacle at the origin.
    expect(findAvailableCanvasPosition(nodes, { x: 500, y: 600 }, size)).toEqual({ x: 400, y: 500 })
  })

  it('treats group frames and locked nodes as fixed obstacles', () => {
    const group = { id: 'locked-group', type: 'group', position: { x: -500, y: -500 }, width: 1000, height: 1000, locked: true }
    const frozen = Object.freeze({ ...group, position: Object.freeze(group.position) })
    const size = { width: 280, height: 220 }
    const result = findAvailableCanvasPosition(Object.freeze([frozen]), { x: 0, y: 0 }, size)
    expect(intersects(result, size, group)).toBe(false)
    expect(frozen).toEqual(group)
  })

  it('escapes beyond a huge obstacle after every bounded search ring is occupied', () => {
    const obstacle = { position: { x: -100000, y: -100000 }, width: 200000, height: 200000 }
    const size = { width: 280, height: 220 }
    const result = findAvailableCanvasPosition([obstacle], { x: 0, y: 0 }, size)
    expect(result).toEqual({ x: -140, y: 100028 })
    expect(intersects(result, size, obstacle)).toBe(false)
  })

  it.each([
    [{ id: 'a', parentId: 'b', position: { x: 0, y: 0 } }, { id: 'b', parentId: 'a', position: { x: 0, y: 0 } }],
    [{ id: 'a', parentId: 'missing', position: { x: 0, y: 0 } }],
    [{ id: 'a', position: { x: 0, y: 0 } }, { id: 'a', position: { x: 0, y: 0 } }],
    [{ position: { x: Number.NaN, y: 0 } }],
  ].map((nodes) => ({ nodes })))('rejects invalid ancestry or positions without an unbounded search', ({ nodes }) => {
    expect(() => findAvailableCanvasPosition(nodes, { x: 0, y: 0 }, { width: 280, height: 220 })).toThrow()
  })

  it.each([{ width: 0, height: 100 }, { width: Number.POSITIVE_INFINITY, height: 100 }, { width: 100, height: -5 }])('rejects invalid insertion dimensions %j', (size) => {
    expect(() => findAvailableCanvasPosition([], { x: 0, y: 0 }, size)).toThrow('尺寸无效')
  })

  it('rejects overflowing rectangle bounds instead of returning a nonfinite placement', () => {
    const large = Number.MAX_VALUE
    expect(() => findAvailableCanvasPosition([], { x: large, y: 0 }, { width: large, height: 100 })).toThrow('超出范围')
    expect(() => findAvailableCanvasPosition([{ position: { x: large, y: 0 }, width: large, height: 100 }], { x: 0, y: 0 }, { width: 100, height: 100 })).toThrow('节点范围无效')
    expect(() => findAvailableCanvasPosition([{ id: 'a', position: { x: large, y: 0 } }, { id: 'b', parentId: 'a', position: { x: large, y: 0 } }], { x: 0, y: 0 }, { width: 100, height: 100 })).toThrow('分组坐标超出范围')
  })

  it('bounds every possible native aspect ratio within the unknown image and video placement reservation', () => {
    for (const kind of ['image', 'video'] as const) {
      const reservation = unresolvedMediaPlacementDimensions({ kind })
      expect(reservation).toEqual({ width: maximumMediaAssetNodeEdge, height: maximumMediaAssetNodeEdge })
      for (const [width, height] of [[640, 480], [480, 640], [512, 512], [16384, 1], [1, 16384], [320, 1920], [1, 1]]) {
        const displayed = mediaAssetNodeDimensions({ kind, width, height })
        expect(displayed.width).toBeLessThanOrEqual(reservation!.width)
        expect(displayed.height).toBeLessThanOrEqual(reservation!.height)
        expect(unresolvedMediaPlacementDimensions({ kind, width, height })).toBeNull()
      }
      expect(unresolvedMediaPlacementDimensions({ kind, width: 640 })).toEqual(reservation)
      expect(unresolvedMediaPlacementDimensions({ kind, width: Number.NaN, height: 480 })).toEqual(reservation)
    }
    expect(unresolvedMediaPlacementDimensions({ kind: 'audio' })).toBeNull()
  })

  it('reserves unknown media within nested groups in current world coordinates without shrinking a larger measured node', () => {
    const nodes: CanvasPlacementNode[] = [
      { id: 'parent', type: 'group', position: { x: 1000, y: 1000 }, width: 100, height: 100 },
      { id: 'unknown', type: 'image-input', parentId: 'parent', position: { x: 800, y: 800 }, width: 280, height: 280, measured: { width: 280, height: 280 }, data: { result: { kind: 'image', assetId: 'a' } } },
    ]
    const size = { width: 100, height: 100 }, center = { x: 2158, y: 1900 }
    const placement = findAvailableCanvasPosition(nodes, center, size)
    expect(intersects(placement, size, { position: { x: 1800, y: 1800 }, width: 480, height: 480 })).toBe(false)
    const larger = { ...nodes[1], parentId: undefined, position: { x: 0, y: 0 }, measured: { width: 800, height: 650 } }
    expect(intersects(findAvailableCanvasPosition([larger], { x: 650, y: 600 }, size), size, larger)).toBe(false)
    const known = { ...nodes[1], parentId: undefined, position: { x: 0, y: 0 }, width: 100, height: 100, measured: { width: 100, height: 100 }, data: { result: { kind: 'image' as const, assetId: 'a', width: 640, height: 480 } } }
    expect(findAvailableCanvasPosition([known], { x: 178, y: 50 }, size)).toEqual({ x: 128, y: 0 })
  })
})
