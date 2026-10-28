import { describe, expect, it } from 'vitest'
import { defaultImageTransformRecipe, parseImageTransformRecipe, type ImageCropRecipe } from './recipe'
import { cropOutputRatio, cropPixelRatio, fitCropRatio, moveCrop, resizeCrop, resizeCropOutput, rotateCrop, syncCropOutput } from './crop-editor-state'

const initial = defaultImageTransformRecipe('crop') as ImageCropRecipe
const source = { width: 603, height: 401 }

describe('crop editor geometry', () => {
  it('locks a custom ratio in source pixels rather than percentages', () => {
    const recipe = fitCropRatio(initial, source, 7 / 5)
    expect(cropPixelRatio(recipe, source)).toBeCloseTo(7 / 5)
    const resized = resizeCrop(recipe, .4, .2, source, 7 / 5)
    expect(cropPixelRatio(resized, source)).toBeCloseTo(7 / 5)
    expect(parseImageTransformRecipe(resized)).toEqual(resized)
  })
  it('clamps a locked resize to the image without distorting its ratio', () => {
    const recipe = { ...initial, x: .9, y: .8, width: .05, height: .05 }
    const resized = resizeCrop(recipe, .9, .9, source, 4 / 3, 'height')
    expect(resized.x + resized.width).toBeLessThanOrEqual(1.000001)
    expect(resized.y + resized.height).toBeLessThanOrEqual(1.000001)
    expect(cropPixelRatio(resized, source)).toBeCloseTo(4 / 3)
  })
  it.each([100, 0.01])('preserves extreme locked ratio %s at minimum size', (ratio) => {
    const recipe = fitCropRatio(initial, source, ratio)
    for (const axis of ['width', 'height'] as const) {
      const resized = resizeCrop(recipe, 0, 0, source, ratio, axis)
      expect(resized.width).toBeGreaterThanOrEqual(.0001)
      expect(resized.height).toBeGreaterThanOrEqual(.0001)
      expect(cropPixelRatio(resized, source)).toBeCloseTo(ratio)
      expect(() => parseImageTransformRecipe(resized)).not.toThrow()
    }
  })
  it('rejects unrepresentable ratios without replacing the previous crop', () => {
    expect(() => fitCropRatio(initial, { width: 16384, height: 1 }, .01)).toThrow('裁剪比例')
  })
  it('snaps movement to center and edges only inside the pixel tolerance', () => {
    const recipe = { ...initial, x: .2, y: .2, width: .4, height: .4 }
    expect(moveCrop(recipe, .095, -.197, { x: .01, y: .01 })).toMatchObject({ x: .3, y: 0 })
    expect(moveCrop(recipe, .07, 0, { x: .01, y: .01 }).x).toBeCloseTo(.27)
    expect(moveCrop(recipe, 2, 2)).toMatchObject({ x: .6, y: .6 })
  })
  it('maintains output ratio while respecting maximum dimensions', () => {
    const recipe = { ...initial, outputWidth: 1600, outputHeight: 900 }
    expect(resizeCropOutput(recipe, 'width', 3200, 1600 / 900)).toMatchObject({ outputWidth: 3200, outputHeight: 1800 })
    expect(resizeCropOutput(recipe, 'height', 4096, 1600 / 900)).toMatchObject({ outputWidth: 4096, outputHeight: 2304 })
    expect(resizeCropOutput(recipe, 'width', 2000, null)).toMatchObject({ outputWidth: 2000, outputHeight: 900 })
  })
  it('keeps a stable output lock while typing width through rounded intermediate sizes', () => {
    let recipe = { ...initial, outputWidth: 1024, outputHeight: 576 }
    const lockedRatio = recipe.outputWidth / recipe.outputHeight
    for (const width of [2, 20, 204, 2048]) recipe = resizeCropOutput(recipe, 'width', width, lockedRatio)
    expect(recipe).toMatchObject({ outputWidth: 2048, outputHeight: 1152 })
    expect(parseImageTransformRecipe(recipe)).toEqual(recipe)
  })
  it('keeps the lock when typing height and when rotating a temporarily tiny output', () => {
    let recipe = { ...initial, outputWidth: 1024, outputHeight: 576 }
    let lockedRatio = recipe.outputWidth / recipe.outputHeight
    for (const height of [1, 11, 115, 1152]) recipe = resizeCropOutput(recipe, 'height', height, lockedRatio)
    expect(recipe).toMatchObject({ outputWidth: 2048, outputHeight: 1152 })
    recipe = rotateCrop(resizeCropOutput(recipe, 'width', 2, lockedRatio), true)
    lockedRatio = 1 / lockedRatio
    for (const height of [2, 20, 204, 2048]) recipe = resizeCropOutput(recipe, 'height', height, lockedRatio)
    expect(recipe).toMatchObject({ outputWidth: 1152, outputHeight: 2048 })
  })
  it('uses a newly captured ratio after unlocking or synchronizing to the crop', () => {
    let recipe = resizeCropOutput({ ...initial, outputWidth: 1024, outputHeight: 576 }, 'width', 1000, null)
    const relockedRatio = recipe.outputWidth / recipe.outputHeight
    for (const width of [2, 20, 200, 2000]) recipe = resizeCropOutput(recipe, 'width', width, relockedRatio)
    expect(recipe).toMatchObject({ outputWidth: 2000, outputHeight: 1152 })
    recipe = syncCropOutput(recipe, source)
    const synchronizedRatio = recipe.outputWidth / recipe.outputHeight
    for (const width of [1, 12, 120, 1206]) recipe = resizeCropOutput(recipe, 'width', width, synchronizedRatio)
    expect(recipe).toMatchObject({ outputWidth: 1206, outputHeight: 802 })
  })
  it('uses integer crop pixel bounds and transposes output on rotation', () => {
    const recipe = { ...initial, x: .1, y: .1, width: .4, height: .4 }
    const synced = syncCropOutput(recipe, source)
    expect(synced).toMatchObject({ outputWidth: 242, outputHeight: 161 })
    const rotated = rotateCrop(synced, true)
    expect(rotated).toMatchObject({ outputWidth: 161, outputHeight: 242, rotation: 90 })
    expect(syncCropOutput(rotated, source)).toEqual(rotated)
  })
  it('sets resolution using the cropped and rotated aspect', () => {
    expect(syncCropOutput({ ...initial, rotation: 90 }, source, 2048)).toMatchObject({ outputWidth: 1362, outputHeight: 2048 })
  })
  it.each([
    { source: { width: 960, height: 540 }, ratio: 4 / 5, width: 800, height: 1000 },
    { source, ratio: 7 / 5, width: 700, height: 500 },
  ])('preserves an exact selected ratio instead of locking rounded pixel bounds: %j', ({ source, ratio, width, height }) => {
    const fitted = fitCropRatio(initial, source, ratio)
    let synced = syncCropOutput(fitted, source, 1024, ratio)
    const lock = cropOutputRatio(fitted, ratio)
    for (const value of [1, 8, 80, width]) synced = resizeCropOutput(synced, 'width', value, lock)
    expect(synced).toMatchObject({ outputWidth: width, outputHeight: height })
    expect(lock).toBe(ratio)
    expect(parseImageTransformRecipe(synced)).toEqual(synced)
  })
  it.each([90, 270] as const)('transposes the exact ratio at %s degrees without replacing it with rounded output dimensions', (rotation) => {
    const fitted = fitCropRatio({ ...initial, rotation }, source, 7 / 5)
    const synced = syncCropOutput(fitted, source, 1024, 7 / 5)
    expect(synced).toMatchObject({ outputWidth: 731, outputHeight: 1024, rotation })
    expect(resizeCropOutput(synced, 'width', 500, cropOutputRatio(fitted, 7 / 5))).toMatchObject({ outputWidth: 500, outputHeight: 700 })
  })
  it('retains intentional fractional-pixel enclosure for free crop synchronization', () => {
    const fitted = fitCropRatio(initial, source, 7 / 5)
    const synced = syncCropOutput(fitted, source)
    expect(synced).toMatchObject({ outputWidth: 563, outputHeight: 401 })
    expect(resizeCropOutput(synced, 'width', 700, synced.outputWidth / synced.outputHeight)).toMatchObject({ outputWidth: 700, outputHeight: 499 })
  })
  it('clamps resolution dimensions while keeping the explicit ratio stable', () => {
    const fitted = fitCropRatio(initial, source, 4 / 5)
    const synced = syncCropOutput(fitted, source, 8192, 4 / 5)
    expect(synced).toMatchObject({ outputWidth: 3277, outputHeight: 4096 })
    expect(resizeCropOutput(synced, 'width', 800, cropOutputRatio(fitted, 4 / 5))).toMatchObject({ outputWidth: 800, outputHeight: 1000 })
    expect(syncCropOutput(fitted, source, 4096, .01)).toMatchObject({ outputWidth: 41, outputHeight: 4096 })
  })
  it.each([1 / 16384, 16384, NaN, Infinity, 0, -1])('rejects an unrepresentable output lock before saving preferences: %s', (ratio) => {
    expect(() => syncCropOutput(initial, source, 1024, ratio)).toThrow('输出尺寸支持范围')
  })
})
