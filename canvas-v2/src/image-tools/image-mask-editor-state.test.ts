import { describe, expect, it } from 'vitest'
import { commitImageMask, createImageMaskHistory, imageMaskBindingMatches, imageMaskPoint, imageMaskPointNeeded, rebindImageMask, redoImageMask, undoImageMask } from './image-mask-editor-state'
import { parseImageEditMask, rasterizeImageEditMask, readImageEditMaskPixel, type ImageEditMask } from './image-edit-mask'

const first = 'a'.repeat(43), second = 'b'.repeat(43)
function recipe(): ImageEditMask { return { version: 1, sourceAssetId: first, width: 100, height: 50, strokes: [] } }

describe('bounded mask editor history and coordinates', () => {
  it('maps pointer coordinates to actual non-square image bounds and clamps captured excursions', () => {
    const bounds = { left: 80, top: 120, width: 400, height: 100 }
    expect(imageMaskPoint({ x: 280, y: 145 }, bounds)).toEqual({ x: .5, y: .25 })
    expect(imageMaskPoint({ x: -40, y: 300 }, bounds)).toEqual({ x: 0, y: 1 })
    expect(imageMaskPoint({ x: Infinity, y: 120 }, bounds)).toBeNull()
    expect(imageMaskPoint({ x: 80, y: 120 }, { ...bounds, width: 0 })).toBeNull()
    expect(imageMaskPointNeeded({ x: .5, y: .5 }, { x: .501, y: .501 }, recipe(), .2)).toBe(false)
    expect(imageMaskPointNeeded({ x: .5, y: .5 }, { x: .6, y: .5 }, recipe(), .2)).toBe(true)
  })

  it('commits each stroke once, preserves brush and eraser ordering, and undoes clear and rebind independently', () => {
    let state = createImageMaskHistory(recipe())
    state = commitImageMask(state, { ...state.present, strokes: [{ tool: 'brush', size: .4, points: [{ x: .2, y: .5 }, { x: .8, y: .5 }] }] })
    const painted = state.present
    expect(readImageEditMaskPixel(rasterizeImageEditMask(painted), 50, 25)).toBe(true)
    state = commitImageMask(state, { ...painted, strokes: [...painted.strokes, { tool: 'erase', size: .2, points: [{ x: .5, y: .5 }] }] })
    const erased = state.present
    expect(readImageEditMaskPixel(rasterizeImageEditMask(erased), 50, 25)).toBe(false)
    expect(readImageEditMaskPixel(rasterizeImageEditMask(erased), 25, 25)).toBe(true)
    state = commitImageMask(state, { ...erased, strokes: [] })
    expect(rasterizeImageEditMask(state.present).editedPixels).toBe(0)
    state = undoImageMask(state); expect(state.present).toEqual(erased)
    state = undoImageMask(state); expect(state.present).toEqual(painted)
    state = redoImageMask(state); expect(state.present).toEqual(erased)
    const rebound = rebindImageMask(state.present, { assetId: second, width: 400, height: 200 })
    expect(rebound.strokes).toEqual(erased.strokes)
    expect(rebound.strokes).not.toBe(erased.strokes)
    state = commitImageMask(state, rebound)
    expect(state.future).toEqual([])
    expect(imageMaskBindingMatches(state.present, { assetId: first, width: 100, height: 50 })).toBe(false)
    expect(imageMaskBindingMatches(state.present, { assetId: second, width: 400, height: 200 })).toBe(true)
    expect(undoImageMask(state).present).toEqual(erased)
    expect(commitImageMask(state, structuredClone(state.present))).toBe(state)
  })

  it('bounds history and rejects invalid stroke commits without damaging the last valid mask', () => {
    let state = createImageMaskHistory(recipe())
    for (let index = 0; index < 40; index++) state = commitImageMask(state, { ...state.present, width: 101 + index })
    expect(state.past).toHaveLength(32)
    const before = structuredClone(state)
    expect(() => commitImageMask(state, { ...state.present, strokes: [{ tool: 'brush', size: .2, points: Array.from({ length: 4097 }, () => ({ x: .5, y: .5 })) }] })).toThrow('复杂')
    expect(state).toEqual(before)
    expect(() => parseImageEditMask({ ...recipe(), strokes: Array.from({ length: 129 }, () => ({ tool: 'brush', size: .2, points: [{ x: .5, y: .5 }] })) })).toThrow('128')
    expect(() => rebindImageMask(recipe(), { assetId: second, width: 4097, height: 1 })).toThrow('4096')
  })
})
