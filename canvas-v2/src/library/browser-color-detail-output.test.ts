import { deflateSync, inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { defaultImageLayerColorDetail } from '../image-tools/layer-color-detail'
import { rasterizeLayerColorGrade } from '../image-tools/layer-color-grade-raster'
import type { ImageLayerRecipe } from '../image-tools/recipe'
import { paintBrowserImageLayerDocumentPreview, processBrowserImageTransform, sampleBrowserImageLayerPixels } from './browser-image-transform'
import { createBrowserLayerPsdExporter } from './browser-layer-psd'

interface PixelCanvas {
  width: number
  height: number
  getContext(): CanvasRenderingContext2D
  read(): Uint8ClampedArray
  toBlob(done: (blob: Blob) => void): void
}

function chunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4, 'ascii'); result.set(data, 8)
  let crc = 0xffffffff
  for (const byte of result.subarray(4, result.length - 4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

function encodePNG(width: number, height: number, pixels: Uint8ClampedArray): Blob {
  const header = Buffer.alloc(13), raw = Buffer.alloc((width * 4 + 1) * height)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  for (let row = 0; row < height; row++) raw.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1)
  return new Blob([new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]))], { type: 'image/png' })
}

async function decodePNG(blob: Blob): Promise<Uint8ClampedArray> {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20), compressed: Uint8Array[] = []
  for (let at = 8; at + 12 <= bytes.length;) { const size = view.getUint32(at); if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') compressed.push(bytes.subarray(at + 8, at + 8 + size)); at += size + 12 }
  const raw = inflateSync(Buffer.concat(compressed)), data = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row++) { expect(raw[row * (width * 4 + 1)]).toBe(0); data.set(raw.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)), row * width * 4) }
  return data
}

/** Browser primitives only: actual per-pixel draw/read/put and PNG encoding.
 * The production transform, native painter, spatial raster, sampler and PSD
 * writer all execute unchanged. This fixture deliberately supports only the
 * axis-aligned, opaque owned image used by these integration cases.
 */
function pixelCanvasFixture(width = 11, height = 37) {
  const source = { width, height, data: new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at % width < 6 ? 60 + at * 7 % 23 : 190 + at * 7 % 23, 90 + at * 11 % 31, 120 + at * 13 % 37, 255]).flat()), close: vi.fn() }
  const surfaces: PixelCanvas[] = []
  function make(): PixelCanvas {
    let pixels = new Uint8ClampedArray(), a = 1, d = 1, e = 0, f = 0
    const states: Array<{ a: number; d: number; e: number; f: number; alpha: number; blend: string }> = []
    const canvas = { width: 0, height: 0, getContext() { return context as unknown as CanvasRenderingContext2D }, read() { ensure(); return pixels }, toBlob(done: (blob: Blob) => void) { ensure(); done(encodePNG(canvas.width, canvas.height, pixels)) } }
    function ensure() { if (pixels.length !== canvas.width * canvas.height * 4) pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4) }
    const context = { canvas, globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
      save() { states.push({ a, d, e, f, alpha: context.globalAlpha, blend: context.globalCompositeOperation }) },
      restore() { const old = states.pop(); if (!old) throw new Error('unbalanced fake canvas'); ({ a, d, e, f } = old); context.globalAlpha = old.alpha; context.globalCompositeOperation = old.blend },
      translate(x: number, y: number) { e += x * a; f += y * d }, scale(x: number, y: number) { a *= x; d *= y }, rotate(radians: number) { if (radians !== 0) throw new Error('unexpected fixture rotation') },
      getTransform() { return { a, b: 0, c: 0, d, e, f } }, setTransform(aa: number, b: number, c: number, dd: number, ee: number, ff: number) { if (b || c) throw new Error('unexpected fixture shear'); a = aa; d = dd; e = ee; f = ff },
      beginPath() {}, rect() {}, clip() {},
      clearRect(x: number, y: number, w: number, h: number) { ensure(); for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < canvas.width && yy < canvas.height) pixels.fill(0, (yy * canvas.width + xx) * 4, (yy * canvas.width + xx + 1) * 4) },
      getImageData(x: number, y: number, w: number, h: number) { ensure(); const data = new Uint8ClampedArray(w * h * 4); for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) data.set(pixels.subarray(((y + yy) * canvas.width + x + xx) * 4, ((y + yy) * canvas.width + x + xx + 1) * 4), (yy * w + xx) * 4); return { width: w, height: h, data } },
      createImageData(w: number, h: number) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } },
      putImageData(image: ImageData, x: number, y: number) { ensure(); for (let yy = 0; yy < image.height; yy++) pixels.set(image.data.subarray(yy * image.width * 4, (yy + 1) * image.width * 4), ((y + yy) * canvas.width + x) * 4) },
      drawImage(image: { width: number; height: number; data?: Uint8ClampedArray; read?(): Uint8ClampedArray }, ...args: number[]) {
        ensure()
        const input = image.data ?? image.read?.(); if (!input) throw new Error('missing fake bitmap pixels')
        const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 8 ? args : [0, 0, image.width, image.height, args[0], args[1], args[2] ?? image.width, args[3] ?? image.height]
        if (context.globalAlpha !== 1 || context.globalCompositeOperation !== 'source-over') throw new Error('unexpected fixture composition')
        for (let y = 0; y < Math.round(dh * d); y++) for (let x = 0; x < Math.round(dw * a); x++) {
          const xx = Math.round(dx * a + e) + x, yy = Math.round(dy * d + f) + y
          if (xx < 0 || yy < 0 || xx >= canvas.width || yy >= canvas.height) continue
          const ix = sx + Math.min(sw - 1, Math.floor(x / (dw * a) * sw)), iy = sy + Math.min(sh - 1, Math.floor(y / (dh * d) * sh)), at = (iy * image.width + ix) * 4
          if (input[at + 3]) pixels.set(input.subarray(at, at + 4), (yy * canvas.width + xx) * 4)
        }
      },
    }
    surfaces.push(canvas); return canvas
  }
  vi.stubGlobal('document', { createElement: make }); vi.stubGlobal('createImageBitmap', vi.fn(async () => source))
  const detail = defaultImageLayerColorDetail(); detail.sharpening.amount = 75; detail.luminance.amount = 85; detail.color.amount = 90
  const grade = { ...defaultImageLayerColorGrade(), detail }, recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: width, outputHeight: height, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, colorGrade: grade }] }
  return { source, surfaces, make, recipe, blob: encodePNG(width, height, source.data) }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('native spatial detail output integration', () => {
  it('carries nonuniform native detail pixels identically through PNG, preview, sampler and PSD planes', async () => {
    const f = pixelCanvasFixture(), expected = rasterizeLayerColorGrade({ data: f.source.data, width: 11, height: 37, grade: f.recipe.layers[0].colorGrade! })
    expect(expected).not.toEqual(f.source.data)
    const [png] = await processBrowserImageTransform({ sources: [f.blob], recipe: f.recipe })
    expect(await decodePNG(png.blob)).toEqual(expected)
    const source = { image: f.source as unknown as CanvasImageSource, width: 11, height: 37 }
    const sample = await sampleBrowserImageLayerPixels({ recipe: f.recipe, sources: [source], source: 'composite' })
    expect(sample.data).toEqual(expected)
    const preview = f.make(); preview.width = 11; preview.height = 37
    await paintBrowserImageLayerDocumentPreview(preview.getContext(), { recipe: { ...f.recipe, documentFrame: { version: 1, width: 11, height: 37, offsetX: 0, offsetY: 0 } }, sources: [source] })
    expect(preview.read()).toEqual(expected)
    const result = await createBrowserLayerPsdExporter({ async decode() { return { ...source, close() {} } }, sample: sampleBrowserImageLayerPixels })({ recipe: f.recipe, sources: [f.blob] })
    const bytes = new Uint8Array(await result.blob.arrayBuffer()), view = new DataView(bytes.buffer)
    let at = 26; for (let section = 0; section < 3; section++) at += 4 + view.getUint32(at)
    expect(view.getUint16(at)).toBe(0)
    const planar = new Uint8Array(expected.length)
    for (let c = 0; c < 4; c++) for (let pixel = 0; pixel < 11 * 37; pixel++) planar[c * 11 * 37 + pixel] = expected[pixel * 4 + c]
    expect(bytes.subarray(at + 2)).toEqual(planar)
    preview.width = 0; preview.height = 0
    expect(f.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true)
  })
  it('keeps dormant native detail output identical to the original image and cancels without a PNG', async () => {
    const f = pixelCanvasFixture(); f.recipe.layers[0].colorGrade!.detail!.enabled = false
    const [png] = await processBrowserImageTransform({ sources: [f.blob], recipe: f.recipe })
    expect(await decodePNG(png.blob)).toEqual(f.source.data)
    f.recipe.layers[0].colorGrade!.detail!.enabled = true
    const controller = new AbortController(), pending = processBrowserImageTransform({ sources: [f.blob], recipe: f.recipe, signal: controller.signal })
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true)
  })
})
