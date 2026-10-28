import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImageGridPreview, gridPreviewCellStyle } from './ImageGridPreview'
import { collagePreviewSize, collagePreviewSourceKey } from './CollageStyledPreview'
import { buildImageTransformFrames, imageTransformGrid } from './geometry'

describe('image grid pixel preview', () => {
  it('uses the same native auto layout and contains a bounded shared-painter canvas for styled output', () => {
    const images = [{ width: 640, height: 480 }, { width: 480, height: 640 }, { width: 960, height: 320 }].map((dimensions, index) => ({ dimensions, asset: { kind: 'image' as const, localUrl: `xingmang-asset://image/${'a'.repeat(42)}${index}` }, label: `Image ${index}`, onLoad() {} }))
    const recipe = { kind: 'collage' as const, rows: 1, columns: 1, gap: 0, padding: 0, outputWidth: 100, outputHeight: 100, background: 'transparent', fit: 'contain' as const, layout: 'horizontal' as const, autoSize: true, cornerRadius: 16, shadow: true }
    const markup = renderToStaticMarkup(createElement(ImageGridPreview, { recipe, images }))
    const frame = buildImageTransformFrames(images.map((image) => image.dimensions), recipe)[0]
    for (const command of frame.draws) {
      const cell = command.collageCell!.rect
      expect(markup).toContain(`data-pixel-rect="${cell.x},${cell.y},${cell.width},${cell.height}"`)
    }
    expect(markup).toContain('拼图样式像素预览')
    expect(markup).toContain('image-collage-source-loaders')
    expect(collagePreviewSize({ width: 4096, height: 4096 })).toEqual({ width: 1024, height: 1024 })
    expect(collagePreviewSize({ width: 320, height: 240 })).toEqual({ width: 320, height: 240 })
    expect(collagePreviewSourceKey(images[0])).not.toBe(collagePreviewSourceKey({ ...images[0], dimensions: { width: 480, height: 640 } }))
  })
  it('leaves a translucent styled background to the canvas instead of compositing it twice', () => {
    const recipe = { kind: 'collage' as const, rows: 1, columns: 1, gap: 0, padding: 20, outputWidth: 200, outputHeight: 200, background: '#ff000080', fit: 'contain' as const }
    const plain = renderToStaticMarkup(createElement(ImageGridPreview, { recipe, images: [] }))
    const styled = renderToStaticMarkup(createElement(ImageGridPreview, { recipe: { ...recipe, cornerRadius: 16 }, images: [] }))
    expect(plain).toContain('background:#ff000080')
    expect(styled).not.toContain('background:#ff000080')
    expect(styled).toContain('image-tool-checker')
    expect(styled).toContain('拼图样式像素预览')
  })
  it('keeps padding and gaps relative to the full output rather than a CSS grid content box', () => {
    const cells = imageTransformGrid({ width: 1000, height: 500 }, 2, 2, 50, 100)
    expect(cells).toEqual([{ x: 100, y: 100, width: 375, height: 125 }, { x: 525, y: 100, width: 375, height: 125 }, { x: 100, y: 275, width: 375, height: 125 }, { x: 525, y: 275, width: 375, height: 125 }])
    expect(gridPreviewCellStyle(cells[1], { width: 1000, height: 500 })).toMatchObject({ left: '52.5%', top: '20%', width: '37.5%', height: '25%' })
    const markup = renderToStaticMarkup(createElement(ImageGridPreview, { recipe: { kind: 'collage', rows: 2, columns: 2, gap: 50, padding: 100, outputWidth: 1000, outputHeight: 500, background: '#123456', fit: 'contain' }, images: [] }))
    expect(markup).toContain('data-pixel-rect="525,100,375,125"')
    expect(markup).not.toContain('column-gap')
  })
  it('shows the same remainder boundaries and invalid gap error as the exported slice plan', () => {
    const recipe = { kind: 'grid-split', rows: 2, columns: 3, gap: 7, padding: 11 } as const
    const image = { label: 'Source', asset: { kind: 'image', localUrl: 'xingmang-asset://image/test' } as const, dimensions: { width: 603, height: 401 }, onLoad() {} }
    const frames = buildImageTransformFrames([image.dimensions], recipe)
    const markup = renderToStaticMarkup(createElement(ImageGridPreview, { recipe, images: [image] }))
    for (const frame of frames) { const cell = frame.draws[0].source; expect(markup).toContain(`data-pixel-rect="${cell.x},${cell.y},${cell.width},${cell.height}"`) }
    const invalid = renderToStaticMarkup(createElement(ImageGridPreview, { recipe: { ...recipe, padding: 512 }, images: [image] }))
    expect(invalid).toContain('role="alert"')
    expect(invalid).toContain('图片尺寸不足')
  })
})
