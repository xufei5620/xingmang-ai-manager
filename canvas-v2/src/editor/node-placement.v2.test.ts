import { describe, expect, it } from 'vitest'
import { findAvailableCanvasPosition } from './node-placement'

describe('findAvailableCanvasPosition', () => {
  it('uses the preferred center when it is free', () => {
    expect(findAvailableCanvasPosition([], { x: 500, y: 400 }, { width: 280, height: 220 }))
      .toEqual({ x: 360, y: 290 })
  })

  it('places repeated media nodes into separate deterministic slots', () => {
    const dimensions = { width: 280, height: 220 }
    const first = findAvailableCanvasPosition([], { x: 500, y: 400 }, dimensions)
    const second = findAvailableCanvasPosition([{ position: first, ...dimensions }], { x: 500, y: 400 }, dimensions)
    const third = findAvailableCanvasPosition([
      { position: first, ...dimensions },
      { position: second, ...dimensions },
    ], { x: 500, y: 400 }, dimensions)

    expect(second).not.toEqual(first)
    expect(third).not.toEqual(first)
    expect(third).not.toEqual(second)
  })
})
