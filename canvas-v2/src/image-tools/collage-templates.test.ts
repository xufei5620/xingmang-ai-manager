import { createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CollageLayoutControls } from './CollageStyleControls'
import { buildCollageLayout } from './collage-layout'
import { imageCollageTemplates, type ImageCollageTemplateLayout } from './collage-templates'
import { ImageGridPreview } from './ImageGridPreview'
import { buildImageTransformFrames } from './geometry'
import { defaultImageTransformRecipe, imageCollageCapacity, imageCollageInputCountError, imageCollageUsesAutoSize, parseImageTransformRecipe, type ImageCollageRecipe } from './recipe'

const images = [{ width: 640, height: 480 }, { width: 480, height: 640 }, { width: 960, height: 320 }]
function recipe(layout: ImageCollageTemplateLayout, extra: Partial<ImageCollageRecipe> = {}): ImageCollageRecipe {
  return { kind: 'collage', rows: 2, columns: 2, gap: 0, padding: 0, outputWidth: 800, outputHeight: 600, fit: 'cover', background: '#ffffff', layout, ...extra }
}

// These cells are independent measurements of the visible reference proportions.
const observed: Array<[ImageCollageTemplateLayout, number[][]]> = [
  ['template-balanced', [[0, 0, 400, 600], [400, 0, 400, 600]]],
  ['template-stacked', [[0, 0, 800, 300], [0, 300, 800, 300]]],
  ['template-sidebar', [[0, 0, 520, 600], [520, 0, 280, 600]]],
  ['template-banner', [[0, 0, 800, 300], [0, 300, 400, 300], [400, 300, 400, 300]]],
  ['template-feature', [[0, 0, 480, 600], [480, 0, 320, 300], [480, 300, 320, 300]]],
  ['template-l', [[0, 0, 400, 600], [400, 0, 400, 300], [400, 300, 400, 300]]],
]

function buttonProps(node: ReactNode): Array<Record<string, unknown>> {
  if (Array.isArray(node)) return node.flatMap(buttonProps)
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  return [...(node.type === 'button' ? [node.props] : []), ...buttonProps(node.props.children)]
}

describe('fixed collage templates', () => {
  it.each(observed)('matches the observed %s cells and preserves source order in the actual output', (layout, rectangles) => {
    const sources = images.slice(0, rectangles.length), value = recipe(layout)
    const expected = rectangles.map(([x, y, width, height]) => ({ x, y, width, height }))
    expect(buildCollageLayout(sources, value)).toEqual({ width: 800, height: 600, cells: expected })
    const frame = buildImageTransformFrames(sources, value)[0]
    expect(frame.draws.map((command) => command.destination)).toEqual(expected)
    expect(frame.draws.map((command) => command.sourceIndex)).toEqual(sources.map((_, index) => index))
    expect(buildCollageLayout([...sources].reverse(), value).cells).toEqual(expected)
  })

  it('distributes odd pixels after padding and gaps without overlaps or lost outer pixels', () => {
    const expected = {
      'template-balanced': [[11, 11, 486, 679], [504, 11, 486, 679]],
      'template-stacked': [[11, 11, 979, 336], [11, 354, 979, 336]],
      'template-sidebar': [[11, 11, 631, 679], [649, 11, 341, 679]],
      'template-banner': [[11, 11, 979, 336], [11, 354, 486, 336], [504, 354, 486, 336]],
      'template-feature': [[11, 11, 583, 679], [601, 11, 389, 336], [601, 354, 389, 336]],
      'template-l': [[11, 11, 486, 679], [504, 11, 486, 336], [504, 354, 486, 336]],
    }
    for (const template of imageCollageTemplates) {
      const plan = buildCollageLayout(images.slice(0, template.inputCount), recipe(template.layout, { outputWidth: 1001, outputHeight: 701, padding: 11, gap: 7 }))
      expect(plan.cells.map(({ x, y, width, height }) => [x, y, width, height])).toEqual(expected[template.layout])
      expect(Math.max(...plan.cells.map((cell) => cell.x + cell.width))).toBe(990)
      expect(Math.max(...plan.cells.map((cell) => cell.y + cell.height))).toBe(690)
      for (const [index, cell] of plan.cells.entries()) for (const other of plan.cells.slice(index + 1)) expect(cell.x + cell.width <= other.x || other.x + other.width <= cell.x || cell.y + cell.height <= other.y || other.y + other.height <= cell.y).toBe(true)
    }
  })

  it.each(imageCollageTemplates)('strictly preserves every input in $title across exact and unknown batches', (template) => {
    const value = recipe(template.layout)
    expect(imageCollageCapacity(value)).toBe(template.inputCount)
    for (const count of [0, 1, 2, 3, 4, 20]) {
      const exactError = imageCollageInputCountError(value, count)
      expect(exactError === null).toBe(count === template.inputCount)
      if (exactError) expect(exactError).toContain(`恰好 ${template.inputCount} 张`)
      expect(imageCollageInputCountError(value, count, false) === null).toBe(count <= template.inputCount)
      if (count !== template.inputCount) expect(() => buildCollageLayout(Array.from({ length: count }, () => images[0]), value)).toThrow('不会自动丢弃图片')
    }
  })

  it('rejects cells consumed by padding, gaps or too few pixels before drawing', () => {
    for (const template of imageCollageTemplates) {
      const sources = images.slice(0, template.inputCount)
      for (const extra of [{ outputWidth: 1, outputHeight: 1 }, { outputWidth: 11, outputHeight: 11, gap: 11 }, { outputWidth: 20, outputHeight: 20, padding: 10 }]) expect(() => buildImageTransformFrames(sources, recipe(template.layout, extra))).toThrow()
    }
  })

  it('roundtrips only registered templates without changing legacy recipe bytes or hero proportions', () => {
    for (const template of imageCollageTemplates) {
      const value = recipe(template.layout, { autoSize: false })
      expect(parseImageTransformRecipe(value)).toEqual(value)
      expect(parseImageTransformRecipe(JSON.parse(JSON.stringify(value)))).toEqual(value)
      expect(imageCollageUsesAutoSize(value)).toBe(false)
      expect(() => parseImageTransformRecipe({ ...value, autoSize: true })).toThrow('自动尺寸仅适用于')
    }
    for (const layout of ['template-any', 'template-feature ', { template: 'template-l' }]) expect(() => parseImageTransformRecipe({ ...recipe('template-l'), layout })).toThrow('拼图布局无效')
    expect(JSON.stringify(parseImageTransformRecipe(defaultImageTransformRecipe('collage')))).toBe('{"kind":"collage","rows":2,"columns":2,"gap":16,"outputWidth":1024,"outputHeight":1024,"fit":"cover","background":"#ffffff","padding":16}')
    expect(buildCollageLayout(images, { ...recipe('template-l'), layout: 'hero-left' }).cells).toEqual([{ x: 0, y: 0, width: 533, height: 600 }, { x: 533, y: 0, width: 267, height: 300 }, { x: 533, y: 300, width: 267, height: 300 }])
    expect(buildCollageLayout(images, { ...recipe('template-l'), layout: 'hero-top' }).cells).toEqual([{ x: 0, y: 0, width: 800, height: 400 }, { x: 0, y: 400, width: 400, height: 200 }, { x: 400, y: 400, width: 400, height: 200 }])
  })

  it.each(imageCollageTemplates)('shares $title preview cells with styled and unstyled pixel output', (template) => {
    const sources = images.slice(0, template.inputCount).map((dimensions, index) => ({ dimensions, label: `Image ${index}`, asset: { kind: 'image' as const, localUrl: `xingmang-asset://image/${'a'.repeat(42)}${index}` }, onLoad() {} }))
    for (const styled of [false, true]) {
      const value = recipe(template.layout, { gap: 7, padding: 11, ...(styled ? { cornerRadius: 16, borderWidth: 2, shadow: true } : {}) })
      const frame = buildImageTransformFrames(sources.map((source) => source.dimensions), value)[0]
      const markup = renderToStaticMarkup(createElement(ImageGridPreview, { recipe: value, images: sources }))
      for (const command of frame.draws) { const cell = command.collageCell?.rect ?? command.destination; expect(markup).toContain(`data-pixel-rect="${cell.x},${cell.y},${cell.width},${cell.height}"`) }
      if (styled) expect(markup).toContain('拼图样式像素预览')
      else expect(markup).toContain('alt="Image 0"')
    }
  })

  it('shows six numbered cards, disables incompatible counts and applies a fixed layout without resetting styles', () => {
    const onChange = vi.fn(), value = recipe('template-banner', { cornerRadius: 18 })
    const view = CollageLayoutControls({ recipe: value, inputCount: 3, onChange })
    const choices = buttonProps(view).filter((props) => props.className === 'collage-template-card')
    expect(choices).toHaveLength(6)
    for (const [index, props] of choices.entries()) {
      const template = imageCollageTemplates[index]
      expect(props.disabled).toBe(template.inputCount !== 3)
      expect(props['aria-label']).toBe(`${template.title} · 需要 ${template.inputCount} 张图片`)
    }
    const selected = choices.find((props) => props['aria-pressed'])!
    const selectTemplate = selected.onClick as () => void
    selectTemplate()
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ layout: 'template-banner', autoSize: false })
    const markup = renderToStaticMarkup(view)
    expect(markup).toContain('data-template-cell=')
    expect(markup).toContain('所有输入都会保留')
    for (const label of ['网格', '横向拼接', '纵向拼接', '主图在左', '主图在上']) expect(markup).toContain(label)
    const invalid = renderToStaticMarkup(createElement(ImageGridPreview, { recipe: recipe('template-balanced'), images: images.map((dimensions) => ({ dimensions, label: '', asset: { kind: 'image' as const }, onLoad() {} })) }))
    expect(invalid).toContain('role="alert"')
    expect(invalid).toContain('恰好 2 张')
  })
})
