import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEditorLayerMergePlan, commitEditorLayerMerge } from '../image-tools/layer-editor-merge'
import { createLayerEditorState, defaultEditorImageLayer, selectEditorLayer } from '../image-tools/layer-editor-state'
import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { type ImageLayerRecipe } from '../image-tools/recipe'
import { sampleBrowserImageLayerPixels, type BrowserImageLayerPixelsInput } from './browser-image-transform'
import { encodeImportedPsdLayerPng } from './browser-layer-psd-import'
import { createBrowserEditorLayerMerger, renderBrowserEditorLayerMerge, type EditorLayerMergeSource } from './browser-layer-merge'

interface TestBitmap { width: number; height: number; data: Uint8ClampedArray }
function bitmap(width: number, height: number, rgba: number[]): TestBitmap { return { width, height, data: new Uint8ClampedArray(Array.from({ length: width * height }, () => rgba).flat()) } }
function source(image: TestBitmap): EditorLayerMergeSource { return { image: image as unknown as CanvasImageSource, width: image.width, height: image.height } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
async function encode(pixels: { width: number; height: number; data: Uint8ClampedArray }, signal: AbortSignal): Promise<Blob> { return encodeImportedPsdLayerPng({ ...pixels, data: new Uint8ClampedArray(pixels.data), name: 'Owned merge fixture', left: 0, top: 0, opacity: 1, blend: 'source-over', visible: true }, signal) }
async function decode(blob: Blob): Promise<TestBitmap> {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20), compressed: Uint8Array[] = []
  for (let at = 8; at + 12 <= bytes.length;) { const size = view.getUint32(at); if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') compressed.push(bytes.subarray(at + 8, at + 8 + size)); at += size + 12 }
  const raw = inflateSync(Buffer.concat(compressed)), data = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row++) { expect(raw[row * (width * 4 + 1)]).toBe(0); data.set(raw.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)), row * width * 4) }
  return { width, height, data }
}
function fixture(cropped = false) {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, background: 'transparent', outputWidth: 4, outputHeight: 2, layers: [
    { ...defaultEditorImageLayer(0) },
    { ...defaultEditorImageLayer(1), width: .5, opacity: .5 },
    { ...defaultEditorImageLayer(2), x: .25, width: .5, opacity: .5 },
    { ...defaultEditorImageLayer(3), x: .75, width: .25 },
  ] }
  if (cropped) {
    recipe.outputWidth = 2; recipe.outputHeight = 1
    recipe.documentFrame = { version: 1, width: 4, height: 2, offsetX: 1, offsetY: 1 }
    recipe.layers = recipe.layers.map((layer) => ({ ...layer, x: (layer.x * 4 - 1) / 2, y: -1, width: layer.width * 2, height: 2 }))
  }
  const images = [bitmap(4, 2, [0, 255, 0, 255]), bitmap(2, 2, [255, 0, 0, 255]), bitmap(2, 2, [0, 0, 255, 255]), bitmap(1, 2, [255, 255, 255, 255])]
  const state = selectEditorLayer(selectEditorLayer(createLayerEditorState(recipe, 4), 'layer-2'), 'layer-3', { range: true })
  return { state, plan: buildEditorLayerMergePlan(state.present), sources: new Map(images.map((image, index) => [index, source(image)])) }
}

/** Only browser primitives are replaced. Production geometry, native ordered
 * painter, crop replay, merger, RGBA PNG encoder and strict PNG inspection run
 * unchanged. This fixture intentionally tests axis-aligned image composition. */
function installPixelCanvas() {
  const surfaces: Array<{ width: number; height: number }> = []
  vi.stubGlobal('document', { createElement() {
    let data = new Uint8ClampedArray(), a = 1, d = 1, e = 0, f = 0
    const saved: Array<{ a: number; d: number; e: number; f: number; alpha: number; blend: string }> = []
    const canvas = { width: 0, height: 0, getContext() { return context } }
    function ensure() { if (data.length !== canvas.width * canvas.height * 4) data = new Uint8ClampedArray(canvas.width * canvas.height * 4) }
    const context = { canvas, globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      save() { saved.push({ a, d, e, f, alpha: context.globalAlpha, blend: context.globalCompositeOperation }) },
      restore() { const value = saved.pop()!; ({ a, d, e, f } = value); context.globalAlpha = value.alpha; context.globalCompositeOperation = value.blend },
      translate(x: number, y: number) { e += a * x; f += d * y }, scale(x: number, y: number) { a *= x; d *= y }, rotate(value: number) { if (value) throw new Error('fixture only supports axis-aligned images') },
      drawImage(image: TestBitmap, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
        ensure(); expect(context.globalCompositeOperation).toBe('source-over')
        for (let yy = 0; yy < Math.round(dh * d); yy++) for (let xx = 0; xx < Math.round(dw * a); xx++) {
          const x = Math.round(dx * a + e) + xx, y = Math.round(dy * d + f) + yy
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue
          const input = ((sy + Math.floor(yy / (dh * d) * sh)) * image.width + sx + Math.floor(xx / (dw * a) * sw)) * 4, at = (y * canvas.width + x) * 4
          const alpha = image.data[input + 3] / 255 * context.globalAlpha, previous = data[at + 3] / 255, total = alpha + previous * (1 - alpha)
          if (!total) continue
          for (let channel = 0; channel < 3; channel++) data[at + channel] = (image.data[input + channel] * alpha + data[at + channel] * previous * (1 - alpha)) / total
          data[at + 3] = total * 255
        }
      },
      getImageData(x: number, y: number, width: number, height: number) {
        ensure(); const pixels = new Uint8ClampedArray(width * height * 4)
        for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) pixels.set(data.subarray(((y + yy) * canvas.width + x + xx) * 4, ((y + yy) * canvas.width + x + xx + 1) * 4), (yy * width + xx) * 4)
        return { width, height, data: pixels }
      },
    }
    surfaces.push(canvas); return canvas
  } })
  return surfaces
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('bounded editor layer raster merge', () => {
  it.each([false, true])('keeps ordered transparent native pixels and crop-retained dimensions (cropped=%s)', async (cropped) => {
    const surfaces = installPixelCanvas(), f = fixture(cropped)
    const output = await renderBrowserEditorLayerMerge(f.plan, { sources: f.sources }), merged = await decode(output.blob)
    expect([output.width, output.height]).toEqual([4, 2])
    expect([...merged.data.slice(0, 16)]).toEqual([255, 0, 0, 128, 85, 0, 170, 192, 0, 0, 255, 128, 0, 0, 0, 0])
    expect(merged.data.slice(0, 16)).toEqual(merged.data.slice(16, 32))
    const before = await sampleBrowserImageLayerPixels({ recipe: f.state.present.recipe, sources: [...f.sources.values()], source: 'composite' })
    const next = commitEditorLayerMerge(f.state, f.plan, 4), after = await sampleBrowserImageLayerPixels({ recipe: next.present.recipe, sources: [...f.sources.values(), source(merged)], source: 'composite' })
    // A PNG intermediate adds one 8-bit alpha quantization; document geometry
    // and unselected backdrop remain the same within that single-byte bound.
    for (let at = 0; at < before.data.length; at++) expect(Math.abs(before.data[at] - after.data[at])).toBeLessThanOrEqual(1)
    expect(surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true)
  })
  it('retains exact low-alpha and transparent RGB through the production raw encoder', async () => {
    const f = fixture(), data = new Uint8ClampedArray(Array.from({ length: 8 }, (_, index) => [17 + index, 61, 199, index % 2 ? 1 : 0]).flat())
    const sample = vi.fn(async (_input: BrowserImageLayerPixelsInput) => ({ width: 4, height: 2, data })), render = createBrowserEditorLayerMerger({ sample, encode })
    const output = await render(f.plan, { sources: f.sources })
    expect((await decode(output.blob)).data).toEqual(data)
    expect(sample.mock.calls[0][0]).toMatchObject({ recipe: { background: 'transparent', layers: [{ sourceIndex: 0, opacity: .5 }, { sourceIndex: 1, opacity: .5 }] }, source: 'composite' })
  })
  it('keeps layer masks, ordered effects and grades intact for the existing native painter', async () => {
    const f = fixture(), layer = f.state.present.recipe.layers[1]
    layer.mask = { kind: 'ellipse', transform: [1, 0, 0, 1, 0, 0], inverted: false }
    layer.adjustments = { brightness: .8, contrast: 1.2, saturation: .75, blur: 2, grayscale: .3 }
    layer.colorGrade = { ...defaultImageLayerColorGrade(), exposure: .5 }
    layer.edits = { version: 1, operations: [{ mode: 'fill', color: '#112233', opacity: .4 }] }
    const plan = buildEditorLayerMergePlan(f.state.present)
    const sample = vi.fn(async (_input: BrowserImageLayerPixelsInput) => ({ width: 4, height: 2, data: new Uint8ClampedArray(32) }))
    await createBrowserEditorLayerMerger({ sample, encode })(plan, { sources: f.sources })
    expect(sample.mock.calls[0][0].recipe.layers[0]).toMatchObject({ mask: layer.mask, adjustments: layer.adjustments, colorGrade: layer.colorGrade, edits: layer.edits })
  })
  it.each(['empty-source', 'oversize-source', 'bad-pixels', 'bad-png', 'wrong-png-size'] as const)('refuses %s before any model commit', async (failure) => {
    const f = fixture(), sample = vi.fn(async () => ({ width: 4, height: 2, data: new Uint8ClampedArray(failure === 'bad-pixels' ? 4 : 32) }))
    if (failure === 'empty-source') f.sources.delete(1)
    if (failure === 'oversize-source') f.sources.set(1, { ...f.sources.get(1)!, width: 16384, height: 16384 })
    const render = createBrowserEditorLayerMerger({ sample, async encode(pixels, signal) { return failure === 'bad-png' ? new Blob(['bad'], { type: 'image/png' }) : encode(failure === 'wrong-png-size' ? { width: 1, height: 1, data: new Uint8ClampedArray(4) } : pixels, signal) } })
    await expect(render(f.plan, { sources: f.sources })).rejects.toThrow()
    expect(f.state.past).toHaveLength(0)
    expect(f.state.present.recipe.layers).toHaveLength(4)
    if (failure === 'empty-source' || failure === 'oversize-source') expect(sample).not.toHaveBeenCalled()
  })
  it.each(['already-cancelled', 'sampling', 'encoding', 'timeout'] as const)('does not produce a late result after %s', async (stage) => {
    const f = fixture(), controller = new AbortController(), pending = deferred<{ width: number; height: number; data: Uint8ClampedArray }>(), encoding = deferred<Blob>()
    const encodeSpy = vi.fn(async () => encoding.promise), sample = vi.fn(async () => pending.promise)
    if (stage === 'already-cancelled') controller.abort()
    if (stage === 'timeout') vi.useFakeTimers()
    const result = createBrowserEditorLayerMerger({ sample, encode: encodeSpy })(f.plan, { sources: f.sources, signal: controller.signal })
    const rejected = expect(result).rejects.toThrow(stage === 'timeout' ? '超时' : '取消')
    if (stage === 'encoding') {
      pending.resolve({ width: 4, height: 2, data: new Uint8ClampedArray(32) })
      for (let step = 0; step < 8 && !encodeSpy.mock.calls.length; step++) await Promise.resolve()
      expect(encodeSpy).toHaveBeenCalledOnce()
    }
    if (stage === 'timeout') await vi.advanceTimersByTimeAsync(45001); else controller.abort()
    await rejected
    pending.resolve({ width: 4, height: 2, data: new Uint8ClampedArray(32) }); encoding.resolve(new Blob())
    if (stage === 'already-cancelled') expect(sample).not.toHaveBeenCalled()
    if (stage === 'sampling' || stage === 'timeout') expect(encodeSpy).not.toHaveBeenCalled()
    expect(f.state.past).toHaveLength(0)
  })
})
