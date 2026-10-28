import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LayerEditor, layerEditorPickerColor, parseLayerEditorColorDraft } from './LayerEditor'
import { LayerCanvasSelectionOverlay, LayerRecipePreview, layerPreviewTransform, type LayerToolImage } from './layerpreview'
import { defaultEditorImageLayer } from './layer-editor-state'
import type { ImageLayer, ImageLayerRecipe } from './recipe'
import { defaultImageLayerColorGrade } from './layer-color-grade'
import { parseColorLutCube } from './layer-color-lut'
import { colorLutSourceKey, type ColorLutSelection } from './layer-color-lut-selection'

function recipe(layer: ImageLayer): ImageLayerRecipe { return { kind: 'layer', explicitLayers: true, outputWidth: 100, outputHeight: 100, background: 'transparent', layers: [layer] } }
function shape(stroke = 'transparent', shape: 'rectangle' | 'ellipse' = 'rectangle'): ImageLayer { return { ...defaultEditorImageLayer(0), content: { kind: 'shape', shape, fill: '#ff0000', stroke, strokeWidth: 64 } } }
function preview(layer: ImageLayer) { return renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: recipe(layer), images: [] })) }

describe('layer pixel preview', () => {
  it('hides unprepared custom LUT layers immediately and offers an explicit loading failure retry', () => {
    const lut: ColorLutSelection = { version: 1, enabled: true, strength: 100, source: { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: 'Owned inverse', domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }, value = recipe({ ...shape(), colorGrade: { ...defaultImageLayerColorGrade(), lut } })
    const loading = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: value, images: [] }))
    expect(loading).toContain('正在加载 LUT 预览'); expect(loading).toContain('aria-busy="true"')
    expect(loading).not.toContain('fill="#ff0000"'); expect(loading).not.toContain('<canvas')
    const failed = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: value, images: [], lutState: { busy: false, error: '本项目无权读取调色表', retry: vi.fn() } }))
    expect(failed).toContain('本项目无权读取调色表'); expect(failed).toContain('重新加载 LUT')
    expect(failed).not.toContain('fill="#ff0000"'); expect(failed).not.toContain('<canvas')
  })

  it('renders an active LUT raster from parent-managed resources without discarding additional owned tables', () => {
    const table = parseColorLutCube('TITLE "Owned inverse"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0'), lut: ColorLutSelection = { version: 1, enabled: true, strength: 100, source: { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: table.name, domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }, tables = new Map([[colorLutSourceKey(lut.source), table], ['unneeded-table', table]])
    const html = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: recipe({ ...shape(), colorGrade: { ...defaultImageLayerColorGrade(), lut } }), images: [], lutState: { tables, busy: false, error: '', retry() {} } }))
    expect(html).toContain('aria-label="输出坐标描边与绘画预览"')
    expect(html).not.toContain('正在加载 LUT 预览'); expect(html).not.toContain('重新加载 LUT')
    expect(tables.size).toBe(2)
  })

  it('fills the entire shape when a nonzero stroke width has a transparent color', () => {
    expect(preview(shape())).toContain('<rect width="100" height="100" fill="#ff0000"></rect>')
    expect(preview(shape())).not.toContain('stroke-width="64"')
    expect(preview(shape('transparent', 'ellipse'))).toContain('rx="50" ry="50" fill="#ff0000"')
  })

  it('draws full fill and inset stroke separately for rectangles and ellipses', () => {
    const rectangle = preview(shape('#000000'))
    expect(rectangle).toContain('<rect width="100" height="100" fill="#ff0000"></rect>')
    expect(rectangle).toContain('<rect x="32" y="32" width="36" height="36" fill="none" stroke="#000000" stroke-width="64"></rect>')
    const ellipse = preview(shape('#000000', 'ellipse'))
    expect(ellipse).toContain('rx="50" ry="50" fill="#ff0000"')
    expect(ellipse).toContain('rx="18" ry="18" fill="none" stroke="#000000" stroke-width="64"')
  })

  it('uses output-pixel alphabetic baselines and all explicit newline conventions without wrapping', () => {
    const layer: ImageLayer = { ...defaultEditorImageLayer(0), content: { kind: 'text', text: 'one\rtwo\r\nthree\nfour', color: '#ffffff', fontSize: 10, fontFamily: 'serif', fontWeight: 700, align: 'right' } }
    const html = preview(layer)
    expect(html).toContain('dominant-baseline="alphabetic"')
    expect(html).toContain('<tspan x="100" y="10">one</tspan>')
    expect(html).toContain('<tspan x="100" y="22">two</tspan>')
    expect(html).toContain('<tspan x="100" y="34">three</tspan>')
    expect(html).toContain('<tspan x="100" y="46">four</tspan>')
    expect(html).not.toContain('textLength=')
    expect(html).toContain('clip-path="url(')
  })

  it('uses the shared bounded canvas painter for typography instead of an independent SVG text layout', () => {
    const layer: ImageLayer = { ...defaultEditorImageLayer(0), content: { kind: 'text', text: '星芒创作\nXINGMANG STUDIO', color: '#ffffff', fontSize: 30, fontFamily: 'sans-serif', fontWeight: 400, align: 'left', typography: { version: 1, lineHeight: 1.9, letterSpacing: 15, fontWeight: 700, warp: { style: 'wave', bend: 50 } } } }
    const html = preview(layer)
    expect(html).toContain('aria-label="文字排版与变形预览"')
    expect(html).not.toContain('<tspan')
    expect(html).not.toContain('<text')
    expect(preview({ ...layer, visible: false })).not.toContain('<canvas')
    const large: ImageLayerRecipe = { ...recipe(layer), outputWidth: 4096, outputHeight: 4096, layers: Array.from({ length: 4 }, () => layer) }
    const aggregate = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: large, images: [] }))
    expect(aggregate.match(/<canvas/g)).toHaveLength(4)
    expect(aggregate).not.toContain('<canvas width="4096"')
  })

  it('preserves the output-axis flip then rotation ordering used by Canvas2D', () => {
    const layer = { ...shape(), x: 0.1, y: 0.2, width: 0.4, height: 0.6, flipX: true, flipY: false, rotation: 30 }
    expect(layerPreviewTransform(layer, recipe(layer))).toBe('translate(30 50) scale(-1 1) rotate(30) translate(-20 -30)')
  })

  it('applies adjustments in the same brightness contrast saturation blur grayscale order', () => {
    const html = preview({ ...shape(), opacity: 0.5, blend: 'multiply', adjustments: { brightness: 1.5, contrast: 0.8, saturation: 1.2, blur: 4, grayscale: 0.3 } })
    expect(html.indexOf('slope="1.5"')).toBeLessThan(html.indexOf('slope="0.8"'))
    expect(html.indexOf('slope="0.8"')).toBeLessThan(html.indexOf('values="1.2"'))
    expect(html.indexOf('values="1.2"')).toBeLessThan(html.indexOf('stdDeviation="4"'))
    expect(html.indexOf('stdDeviation="4"')).toBeLessThan(html.indexOf('values="0.7"'))
    expect(html).toContain('opacity="0.5" style="mix-blend-mode:multiply"')
  })

  it('does not render implicit input layers for an explicitly empty canvas', () => {
    const image: LayerToolImage = { key: 'one', label: '来源', asset: { kind: 'image', localUrl: `xingmang-asset://image/${'A'.repeat(43)}` }, dimensions: { width: 100, height: 100 }, dimensionsReady: true, onLoad() {} }
    const html = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: { ...recipe(shape()), layers: [] }, images: [image] }))
    expect(html).not.toContain('data-layer-index=')
    const invalid = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: recipe(defaultEditorImageLayer(0)), images: [{ ...image, asset: { kind: 'image', localUrl: 'https://untrusted.invalid/private.png' } }] }))
    expect(invalid).not.toContain('https://untrusted.invalid')
    expect(invalid).toContain('素材不可用')
  })

  it('renders bounded raster surfaces only for visible painted or masked layers', () => {
    const paint: ImageLayer = { ...defaultEditorImageLayer(0), content: { kind: 'paint' } }
    expect(preview(paint)).toContain('aria-label="绘画与蒙版预览"')
    expect(preview({ ...paint, visible: false })).not.toContain('<canvas')
    const mask = { kind: 'rectangle' as const, transform: [0.5, 0, 0, 0.5, 0.1, 0.2] as [number, number, number, number, number, number], inverted: false }
    expect(preview({ ...shape(), mask })).toContain('<foreignObject')
  })

  it('counts ordinary cropped bitmap layers in the aggregate raster preview budget', () => {
    const layer = { ...defaultEditorImageLayer(0), width: 2, height: 2 }
    const value: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 2048, outputHeight: 2048, documentFrame: { version: 1, width: 4096, height: 4096, offsetX: 1024, offsetY: 1024 }, background: 'transparent', layers: Array.from({ length: 20 }, () => layer) }
    const image: LayerToolImage = { key: 'source', label: '来源', asset: { kind: 'image', localUrl: `xingmang-asset://image/${'A'.repeat(43)}` }, dimensions: { width: 4096, height: 4096 }, dimensionsReady: true, onLoad() {} }
    const html = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: value, images: [image] }))
    const sizes = Array.from(html.matchAll(/<canvas[^>]*width="(\d+)" height="(\d+)"/g), (match) => [Number(match[1]), Number(match[2])])
    expect(sizes).toHaveLength(20)
    expect(sizes.reduce((sum, [width, height]) => sum + width * height * 4, 0)).toBeLessThanOrEqual(2_097_152)
    expect(html).not.toContain('<canvas width="1024"')
  })

  it('does not request sources that are hidden or unused by content-only layers', () => {
    const image: LayerToolImage = { key: 'hidden', label: '隐藏来源', asset: { kind: 'image', localUrl: `xingmang-asset://image/${'A'.repeat(43)}` }, dimensions: { width: 100, height: 100 }, dimensionsReady: true, onLoad() {} }
    for (const layer of [{ ...defaultEditorImageLayer(0), visible: false }, shape()]) {
      const html = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: recipe(layer), images: [image] }))
      expect(html).not.toContain('<img')
    }
  })

  it('keeps native output dimensions and uniform viewport scaling without stretching the stage', () => {
    const html = renderToStaticMarkup(createElement(LayerEditor, { initial: { ...recipe(shape()), outputWidth: 800, outputHeight: 600 }, images: [], onApply() {}, onClose() {} }))
    expect(html).toContain('--layer-output-ratio:1.3333333333333333')
    expect(html).not.toContain('48dvh')
    const css = readFileSync(new URL('./layer-editor.css', import.meta.url), 'utf8')
    expect(html).toMatch(/class="layer-editor-viewport-frame" style="width:800px;height:600px;transform:translate\([^;]+\) scale\([0-9.]+\)/)
    expect(html).toContain('aria-label="图层视图缩放"')
    expect(css).toMatch(/\.layer-editor-viewport-frame \{[^}]*transform-origin: 0 0/)
    expect(css).toMatch(/\.layer-editor-viewport-frame > \.layer-editor-stage \{[^}]*width: 100%; height: 100%; max-width: none/)
    expect(css).not.toContain('25dvh')
  })

  it('renders a usable content-only workspace and never applies changes during render', () => {
    const onApply = vi.fn(), onClose = vi.fn()
    const html = renderToStaticMarkup(createElement(LayerEditor, { initial: recipe(shape()), images: [], onApply, onClose }))
    expect(html).toContain('aria-label="新建图层"')
    for (const label of ['画笔（B）', '擦除当前图层（E）', '选框工具', '吸管取色（I）', '填充工具（G）']) expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain('aria-label="图层画布，支持移动缩放、画笔擦除、局部模糊锐化、快速前景选择、魔棒色彩选区、连通填色、描边渐变、钢笔与吸管，方向键微调，Shift等比"')
    expect(html).toContain('应用图层')
    expect(html).toContain('取消')
    expect(html).toContain('aria-label="形状填充 HEX"')
    expect(html).toContain('aria-label="形状填充色板"')
    expect(html).toContain('aria-label="画布背景 HEX"')
    expect(onApply).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders native raster selection geometry on a bounded noninteractive overlay', () => {
    const html = renderToStaticMarkup(createElement(LayerCanvasSelectionOverlay, { output: { width: 4096, height: 4096 }, selection: { kind: 'raster', inverted: false, raster: { width: 4096, height: 4096, runs: [0, 4096] } } }))
    expect(html).toContain('<foreignObject width="4096" height="4096" pointer-events="none">')
    expect(html).toContain('<canvas width="1024" height="1024"')
    expect(html).toContain('绿色区域被选中')
  })

  it('keeps outline kernels in output axes and applies opacity and blend exactly once', () => {
    const layer: ImageLayer = { ...shape(), rotation: 45, flipX: true, width: 0.5, opacity: 0.4, blend: 'multiply', adjustments: { brightness: 1.1, contrast: 1, saturation: 1, grayscale: 0, blur: 2 }, edits: { version: 1, operations: [{ mode: 'outline', color: '#000000', opacity: 1, width: 5, position: 'outside', space: { width: 50, height: 100 }, selection: { kind: 'rectangle', inverted: false, transform: [1, 0, 0, 1, 0, 0] } }] } }
    const html = preview(layer)
    expect(html).toContain('<g data-layer-index="0" opacity="0.4" style="mix-blend-mode:multiply"><foreignObject x="0" y="0" width="100" height="100" pointer-events="none">')
    expect(html).toContain('输出坐标描边与绘画预览')
    expect(html).toContain(`<rect data-layer-hit-area="true" transform="${layerPreviewTransform(layer, recipe(layer))}" width="50" height="100" fill="transparent" pointer-events="all">`)
    expect(html).not.toContain('<g transform=')
    expect(html).not.toContain('<g filter=')
    expect(html.match(/opacity="0.4"/g)).toHaveLength(1)
  })

  it('limits outlined transparent paint-layer hits to their transformed bounds above underlying layers', () => {
    const top: ImageLayer = { ...defaultEditorImageLayer(0), content: { kind: 'paint' }, x: 0.2, y: 0.3, width: 0.2, height: 0.1, rotation: 30, flipY: true, edits: { version: 1, operations: [{ mode: 'outline', color: '#ffffff', opacity: 1, width: 2, position: 'inside', space: { width: 20, height: 10 }, selection: { kind: 'rectangle', inverted: false, transform: [1, 0, 0, 1, 0, 0] } }] } }
    const value = { ...recipe(top), layers: [shape(), top] }
    const html = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: value, images: [] }))
    expect(html).toContain('data-layer-index="0" transform=')
    expect(html).toContain('<g data-layer-index="1" opacity="1" style="mix-blend-mode:normal"><foreignObject x="0" y="0" width="100" height="100" pointer-events="none">')
    expect(html).toContain(`<rect data-layer-hit-area="true" transform="${layerPreviewTransform(top, value)}" width="20" height="10" fill="transparent" pointer-events="all"></rect></g>`)
    expect(html.match(/data-layer-hit-area="true"/g)).toHaveLength(1)
  })
})

describe('layer editor brand color drafts', () => {
  it('accepts complete RGB and RGBA colors and normalizes case and surrounding whitespace', () => {
    expect(parseLayerEditorColorDraft(' #AB12EF ')).toBe('#ab12ef')
    expect(parseLayerEditorColorDraft('#AA33FF80')).toBe('#aa33ff80')
    expect(parseLayerEditorColorDraft('#00000000')).toBe('#00000000')
  })

  it.each(['', '#', '#fff', '#12345', '#1234567', '#123456789', '#gg3344', 'rgb(1,2,3)', 'url(https://example.com)', 'red'])('does not commit incomplete or unsupported color %s', (value) => {
    expect(parseLayerEditorColorDraft(value)).toBeNull()
  })

  it('accepts explicit transparent only for backgrounds and shape colors', () => {
    expect(parseLayerEditorColorDraft(' transparent ', true)).toBe('transparent')
    expect(parseLayerEditorColorDraft('transparent')).toBeNull()
  })

  it('preserves the existing alpha when RGB is changed with the native picker', () => {
    expect(layerEditorPickerColor('#123ABC', '#ffffff80')).toBe('#123abc80')
    expect(layerEditorPickerColor('#123ABC', '#ffffff')).toBe('#123abc')
    expect(layerEditorPickerColor('#123ABC', 'transparent')).toBe('#123abc')
    expect(layerEditorPickerColor('#123', '#ffffff80')).toBeNull()
  })
})


describe('grouped layer preview', () => {
  it('uses leaf paint order with inherited visibility without introducing isolated group blending', () => {
    const flat = { ...recipe(shape()), layers: [shape(), { ...shape(), blend: 'multiply' as const }] }
    const grouped: ImageLayerRecipe = { ...flat, layerGroups: { version: 1, layerIds: ['a', 'b'], groups: [{ id: 'g', name: 'Group', children: ['a', 'b'], visible: false, locked: true }] } }
    const before = structuredClone(grouped)
    const hidden = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: grouped, images: [] }))
    expect(hidden).not.toContain('data-layer-index=')
    expect(hidden).not.toContain('fill="#ff0000"')
    grouped.layerGroups!.groups[0].visible = true
    const shown = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe: grouped, images: [] }))
    expect(shown.match(/data-layer-index=/g)).toHaveLength(2)
    expect(shown).toContain('mix-blend-mode:multiply')
    expect(grouped.layers).toEqual(before.layers)
  })
})
