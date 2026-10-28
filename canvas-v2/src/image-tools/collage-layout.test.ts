import { describe, expect, it } from 'vitest'
import { buildCollageLayout, resolveCollageOutputSize } from './collage-layout'
import { buildImageTransformFrames, imageTransformGrid } from './geometry'
import type { ImageCollageRecipe } from './recipe'

const images = [{ width: 640, height: 480 }, { width: 480, height: 640 }, { width: 960, height: 320 }]
function recipe(extra: Partial<ImageCollageRecipe> = {}): ImageCollageRecipe {
  return { kind: 'collage', rows: 2, columns: 2, gap: 0, padding: 0, outputWidth: 800, outputHeight: 600, fit: 'contain', background: 'transparent', ...extra }
}

describe('collage layout shared pixel plan', () => {
  it('matches the observed native horizontal and vertical concatenation sizes', () => {
    expect(resolveCollageOutputSize(images, recipe({ layout: 'horizontal', autoSize: true }))).toEqual({ width: 3253, height: 640 })
    expect(resolveCollageOutputSize(images, recipe({ layout: 'vertical', autoSize: true }))).toEqual({ width: 960, height: 2320 })
    expect(buildCollageLayout(images, recipe({ layout: 'vertical', autoSize: true })).cells).toEqual([
      { x: 0, y: 0, width: 960, height: 720 }, { x: 0, y: 720, width: 960, height: 1280 }, { x: 0, y: 2000, width: 960, height: 320 },
    ])
  })
  it('includes gaps and padding before capping the full output to 4096', () => {
    const value = recipe({ layout: 'horizontal', autoSize: true, gap: 12, padding: 20 })
    expect(resolveCollageOutputSize(images, value)).toEqual({ width: 3317, height: 680 })
    const large = images.map((image) => ({ width: image.width * 4, height: image.height * 4 }))
    const plan = buildCollageLayout(large, value)
    expect(plan.width).toBe(4096)
    expect(plan.height).toBeLessThan(4096)
    expect(plan.cells).toHaveLength(3)
    expect(plan.cells.every((cell) => cell.width >= 1 && cell.height >= 1 && cell.x >= 0 && cell.y >= 0 && cell.x + cell.width <= plan.width && cell.y + cell.height <= plan.height)).toBe(true)
  })
  it('uses source aspect weights inside a fixed canvas and preserves contain or cover geometry', () => {
    const fixed = recipe({ layout: 'horizontal', gap: 10, padding: 20 })
    expect(resolveCollageOutputSize([], fixed)).toEqual({ width: 800, height: 600 })
    const plan = buildCollageLayout(images, fixed)
    expect(plan.cells[2].x + plan.cells[2].width).toBe(780)
    expect(plan.cells.map((cell) => cell.height)).toEqual([560, 560, 560])
    const contain = buildImageTransformFrames(images, fixed)[0]
    const cover = buildImageTransformFrames(images, { ...fixed, fit: 'cover' })[0]
    expect(cover.draws.map((draw) => draw.destination)).toEqual(plan.cells)
    expect(contain.draws.every((draw, index) => draw.destination.width <= plan.cells[index].width && draw.destination.height <= plan.cells[index].height)).toBe(true)
    expect(contain.draws.map((draw) => draw.sourceIndex)).toEqual([0, 1, 2])
  })
  it.each(['hero-left', 'hero-top'] as const)('gives every two or three input its own cell in %s', (layout) => {
    for (const count of [2, 3]) {
      const plan = buildCollageLayout(images.slice(0, count), recipe({ layout, gap: 12, padding: 20 }))
      expect(plan.cells).toHaveLength(count)
      expect(plan.cells.every((cell) => cell.width > 0 && cell.height > 0)).toBe(true)
      for (let i = 0; i < plan.cells.length; i++) for (let j = i + 1; j < plan.cells.length; j++) {
        const a = plan.cells[i], b = plan.cells[j]
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true)
      }
    }
    expect(() => buildCollageLayout([images[0]], recipe({ layout }))).toThrow('2–3')
    expect(() => buildCollageLayout([...images, images[0]], recipe({ layout }))).toThrow('不会自动丢弃')
  })
  it('leaves every legacy grid draw and canonical optional field unchanged', () => {
    const value = recipe({ gap: 12, padding: 20 })
    const baseline = buildImageTransformFrames(images, value)
    expect(buildCollageLayout(images, value).cells).toEqual(imageTransformGrid({ width: 800, height: 600 }, 2, 2, 12, 20))
    expect(buildImageTransformFrames(images, { ...value, layout: 'grid', autoSize: false, cornerRadius: 0, borderWidth: 0, shadow: false })).toEqual(baseline)
    expect(baseline[0]).not.toHaveProperty('watermark')
    expect(baseline[0].draws[0]).not.toHaveProperty('collageCell')
  })
  it('clips styled contain images against the complete cell and marks whole-output watermark once', () => {
    const value = recipe({ cornerRadius: 24, borderWidth: 4, borderColor: '#abcdef80', shadow: true, watermark: { text: '品牌', fontSize: 24, color: '#123456', opacity: 0.4 } })
    const frame = buildImageTransformFrames(images, value)[0]
    expect(frame.draws[0].collageCell).toEqual({ rect: { x: 0, y: 0, width: 400, height: 300 }, cornerRadius: 24, borderWidth: 4, borderColor: '#abcdef80', shadow: true })
    expect(frame.watermark).toEqual(value.watermark)
    expect(buildImageTransformFrames(images, { ...value, watermark: { ...value.watermark!, opacity: 0 } })[0]).not.toHaveProperty('watermark')
  })
  it('rejects missing dimensions and subpixel-only cells rather than dropping inputs', () => {
    expect(() => resolveCollageOutputSize([], recipe({ layout: 'horizontal', autoSize: true }))).toThrow('真实尺寸')
    expect(() => buildCollageLayout([{ width: 1, height: 16_384 }, { width: 16_384, height: 1 }], recipe({ layout: 'horizontal' }))).toThrow('有效像素')
    expect(() => buildCollageLayout(images, recipe({ layout: 'horizontal', outputWidth: 10, gap: 10 }))).toThrow('尺寸不足')
  })
})
