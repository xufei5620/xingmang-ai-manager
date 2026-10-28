import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultImageLayerTypography, imageLayerTextWarpStyles } from '../image-tools/layer-text-layout'
import type { ImageLayerTextContent } from '../image-tools/recipe'
import { paintImageLayerLocal, paintImageLayerLocalAsync } from './image-layer-painter'

function content(): ImageLayerTextContent { return { kind: 'text', text: '中文 👨‍👩‍👧‍👦 e\u0301 office\r\n第二行', fontSize: 20, fontFamily: 'sans-serif', fontWeight: 400, color: '#abcdef', align: 'center', typography: { ...defaultImageLayerTypography(), lineHeight: 1.9, letterSpacing: 15, fontWeight: 700 } } }
function fixture() {
  const canvases: ReturnType<typeof surface>[] = []
  function surface() {
    const text: Array<{ value: string; x: number; y: number; font: string; spacing: string }> = [], draws: unknown[][] = [], uploads: Array<{ x: number; y: number; data: Uint8ClampedArray }> = [], stack: number[] = []
    const canvas = { width: 100, height: 100, getContext() { return context } }
    const context = {
      canvas, font: '', letterSpacing: '0px', textBaseline: '', textAlign: '', fillStyle: '',
      save() { stack.push(1) }, restore() { if (!stack.pop()) throw new Error('unbalanced') }, beginPath() {}, rect() {}, clip() {}, translate() {}, setTransform() {},
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      fillText(value: string, x: number, y: number) { text.push({ value, x, y, font: context.font, spacing: context.letterSpacing }) },
      getImageData(_x: number, _y: number, width: number, height: number) { const data = new Uint8ClampedArray(width * height * 4); for (let i = 0; i < data.length; i += 4) data.set([90, 110, 170, 255], i); return { width, height, data } },
      createImageData(width: number, height: number) { return { width, height, data: new Uint8ClampedArray(width * height * 4) } },
      putImageData(image: ImageData, x: number, y: number) { uploads.push({ x, y, data: image.data }) },
      drawImage(...args: unknown[]) { draws.push(args) },
    }
    return { canvas, context, text, draws, uploads, stack }
  }
  vi.stubGlobal('document', { createElement: vi.fn(() => { const item = surface(); canvases.push(item); return item.canvas }) })
  const target = surface()
  return { target, canvases, context: target.context as unknown as CanvasRenderingContext2D }
}
afterEach(() => vi.unstubAllGlobals())

describe('shared typography painter', () => {
  it('shapes intact multilingual lines with native spacing, weight and exact baselines', () => {
    const f = fixture()
    paintImageLayerLocal(f.context, { layer: { content: content() }, width: 100, height: 100 })
    expect(f.target.text).toEqual([
      { value: '中文 👨‍👩‍👧‍👦 e\u0301 office', x: 0, y: -30, font: '700 20px sans-serif', spacing: '15px' },
      { value: '第二行', x: 0, y: 8, font: '700 20px sans-serif', spacing: '15px' },
    ])
    expect(f.canvases).toHaveLength(0)
    expect(f.target.stack).toEqual([])
  })
  it.each(imageLayerTextWarpStyles)('rasterizes $id once and composites the complete result without tile seams', ({ id }) => {
    const f = fixture(), text = { ...content(), typography: { ...content().typography!, warp: { style: id, bend: 50 } } }
    paintImageLayerLocal(f.context, { layer: { content: text }, width: 100, height: 100 })
    expect(f.canvases).toHaveLength(2)
    expect(f.canvases[0].text.map(({ value }) => value)).toEqual(['中文 👨‍👩‍👧‍👦 e\u0301 office', '第二行'])
    expect(f.canvases[1].uploads.map(({ y }) => y)).toEqual([0, 32, 64, 96])
    expect(f.target.draws).toHaveLength(1)
    expect(f.target.draws[0].slice(1)).toEqual([0, 0, 100, 100, -50, -50, 100, 100])
    expect(f.canvases.every(({ canvas }) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(f.target.stack).toEqual([])
  })
  it('takes the unwarped path at zero bend without a new raster budget', () => {
    const f = fixture(), text = { ...content(), typography: { ...content().typography!, warp: { style: 'arc' as const, bend: 0 } } }
    paintImageLayerLocal(f.context, { layer: { content: text }, width: 5000, height: 100 })
    expect(f.target.text).toHaveLength(2)
    expect(f.canvases).toHaveLength(0)
  })
  it('refuses nonzero spacing on unsupported browsers without splitting shaping runs', () => {
    const f = fixture()
    Reflect.deleteProperty(f.target.context, 'letterSpacing')
    expect(() => paintImageLayerLocal(f.context, { layer: { content: content() }, width: 100, height: 100 })).toThrow('不支持文字字距')
    expect(f.target.text).toHaveLength(0)
    paintImageLayerLocal(f.context, { layer: { content: { ...content(), typography: { ...defaultImageLayerTypography() } } }, width: 100, height: 100 })
    expect(f.target.text).toHaveLength(2)
  })
  it('refuses unprepared local fonts before drawing instead of silently falling back', () => {
    const f = fixture(), text = { ...content(), typography: { ...content().typography!, fontFamily: 'Unknown Private Font', fontSource: 'local' as const } }
    expect(() => paintImageLayerLocal(f.context, { layer: { content: text }, width: 100, height: 100 })).toThrow()
    expect(f.target.text).toHaveLength(0)
    expect(f.target.draws).toHaveLength(0)
  })
  it('yields and cancels unfinished pixel work without compositing a partial result', async () => {
    const f = fixture(), controller = new AbortController(), text = { ...content(), typography: { ...content().typography!, warp: { style: 'twist' as const, bend: 50 } } }
    const pending = paintImageLayerLocalAsync(f.context, { layer: { content: text }, width: 128, height: 512, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.target.draws).toHaveLength(0)
    expect(f.canvases.every(({ canvas }) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(f.target.stack).toEqual([])
  })
  it('rejects excessive warped layer surfaces without allocating or changing target pixels', () => {
    const f = fixture(), text = { ...content(), typography: { ...content().typography!, warp: { style: 'arc' as const, bend: 50 } } }
    expect(() => paintImageLayerLocal(f.context, { layer: { content: text }, width: 4096, height: 4096 })).toThrow('最多支持')
    expect(f.canvases).toHaveLength(0)
    expect(f.target.draws).toHaveLength(0)
    expect(f.target.stack).toEqual([])
  })
})
