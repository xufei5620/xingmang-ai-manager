import { afterEach, describe, expect, it, vi } from 'vitest'
import { paintBrowserImageLayerFullPreview, sampleBrowserImageLayerPixels } from './browser-image-transform'
import { buildLayerDocumentReplayRecipe } from '../image-tools/layer-document-geometry'
import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import type { ImageLayerRecipe } from '../image-tools/recipe'

interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }
interface Bitmap { width: number; height: number; pixels: Uint8ClampedArray }
interface CopyEvidence { before: Uint8ClampedArray; after: Uint8ClampedArray; width: number; height: number }

/** A small software Canvas model, not a browser emulator. It implements real
 * RGBA copy/source-over, integer rectangles, affine nearest sampling and pixel
 * get/put. Tests use an integer identity presentation, so no browser interpolation
 * or premultiplication-quantization equivalence is claimed by this model. */
function pixelCanvasFixture() {
  const canvases: Array<Bitmap & { getContext(): CanvasRenderingContext2D }> = [], copies: CopyEvidence[] = []
  function make() {
    let width = 0, height = 0, pixels = new Uint8ClampedArray(), matrix: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, clip = [-Infinity, -Infinity, Infinity, Infinity], path = [...clip]
    const states: Array<{ matrix: Matrix; clip: number[]; alpha: number; blend: string; filter: string }> = []
    const canvas = { get width() { return width }, set width(value: number) { width = value; pixels = new Uint8ClampedArray(width * height * 4) }, get height() { return height }, set height(value: number) { height = value; pixels = new Uint8ClampedArray(width * height * 4) }, get pixels() { return pixels }, getContext() { return context as unknown as CanvasRenderingContext2D } }
    function blend(index: number, rgba: number[]): void {
      const alpha = rgba[3] * context.globalAlpha / 255, oldAlpha = pixels[index + 3] / 255
      if (context.globalCompositeOperation === 'copy') { pixels.set(rgba, index); return }
      if (context.globalCompositeOperation === 'destination-in' || context.globalCompositeOperation === 'destination-out') {
        pixels[index + 3] *= context.globalCompositeOperation === 'destination-in' ? alpha : 1 - alpha
        if (!pixels[index + 3]) pixels.fill(0, index, index + 3)
        return
      }
      const combined = alpha + oldAlpha * (1 - alpha)
      for (let c = 0; c < 3; c++) pixels[index + c] = combined ? (rgba[c] * alpha + pixels[index + c] * oldAlpha * (1 - alpha)) / combined : 0
      pixels[index + 3] = combined * 255
    }
    function transformedRect(x: number, y: number, w: number, h: number): number[] {
      const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [matrix.a * px + matrix.c * py + matrix.e, matrix.b * px + matrix.d * py + matrix.f])
      return [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])), Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))]
    }
    const context = { canvas, globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', imageSmoothingEnabled: true, imageSmoothingQuality: 'high', fillStyle: '#ffffff',
      save() { states.push({ matrix: { ...matrix }, clip: [...clip], alpha: context.globalAlpha, blend: context.globalCompositeOperation, filter: context.filter }) },
      restore() { const saved = states.pop(); if (!saved) throw new Error('Unbalanced software Canvas state'); matrix = saved.matrix; clip = saved.clip; context.globalAlpha = saved.alpha; context.globalCompositeOperation = saved.blend; context.filter = saved.filter },
      setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { matrix = { a, b, c, d, e, f } },
      getTransform() { return { ...matrix } },
      transform(a: number, b: number, c: number, d: number, e: number, f: number) { const m = matrix; matrix = { a: m.a * a + m.c * b, b: m.b * a + m.d * b, c: m.a * c + m.c * d, d: m.b * c + m.d * d, e: m.a * e + m.c * f + m.e, f: m.b * e + m.d * f + m.f } },
      translate(x: number, y: number) { context.transform(1, 0, 0, 1, x, y) }, scale(x: number, y: number) { context.transform(x, 0, 0, y, 0, 0) }, rotate(radians: number) { context.transform(Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0) },
      beginPath() { path = [-Infinity, -Infinity, Infinity, Infinity] }, rect(x: number, y: number, w: number, h: number) { path = transformedRect(x, y, w, h) }, closePath() {},
      clip() { clip = [Math.max(clip[0], path[0]), Math.max(clip[1], path[1]), Math.min(clip[2], path[2]), Math.min(clip[3], path[3])] },
      fill() { for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x + .5 >= Math.max(clip[0], path[0]) && x + .5 < Math.min(clip[2], path[2]) && y + .5 >= Math.max(clip[1], path[1]) && y + .5 < Math.min(clip[3], path[3])) blend((y * width + x) * 4, [255, 255, 255, 255]) },
      clearRect(x: number, y: number, w: number, h: number) { for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) pixels.fill(0, (yy * width + xx) * 4, (yy * width + xx + 1) * 4) },
      getImageData(x: number, y: number, w: number, h: number) { const data = new Uint8ClampedArray(w * h * 4); for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (x + xx >= 0 && x + xx < width && y + yy >= 0 && y + yy < height) data.set(pixels.subarray(((y + yy) * width + x + xx) * 4, ((y + yy) * width + x + xx + 1) * 4), (yy * w + xx) * 4); return { data, width: w, height: h } },
      createImageData(w: number, h: number) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } },
      putImageData(image: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number) { for (let yy = 0; yy < image.height; yy++) for (let xx = 0; xx < image.width; xx++) if (x + xx >= 0 && x + xx < width && y + yy >= 0 && y + yy < height) pixels.set(image.data.subarray((yy * image.width + xx) * 4, (yy * image.width + xx + 1) * 4), ((y + yy) * width + x + xx) * 4) },
      drawImage(source: Bitmap, ...args: number[]) {
        const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 8 ? args : args.length === 4 ? [0, 0, source.width, source.height, ...args] : [0, 0, source.width, source.height, args[0], args[1], source.width, source.height]
        const determinant = matrix.a * matrix.d - matrix.b * matrix.c, before = context.globalCompositeOperation === 'copy' ? pixels.slice() : null, brightness = Number(/brightness\(([\d.]+)\)/.exec(context.filter)?.[1] ?? 1)
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (x + .5 < clip[0] || x + .5 >= clip[2] || y + .5 < clip[1] || y + .5 >= clip[3]) continue
          const tx = x + .5 - matrix.e, ty = y + .5 - matrix.f, lx = (matrix.d * tx - matrix.c * ty) / determinant, ly = (-matrix.b * tx + matrix.a * ty) / determinant
          if (lx < dx || lx >= dx + dw || ly < dy || ly >= dy + dh) continue
          const u = Math.floor(sx + (lx - dx) * sw / dw), v = Math.floor(sy + (ly - dy) * sh / dh)
          const rgba = u >= 0 && v >= 0 && u < source.width && v < source.height ? [...source.pixels.subarray((v * source.width + u) * 4, (v * source.width + u + 1) * 4)] : [0, 0, 0, 0]
          for (let c = 0; c < 3; c++) rgba[c] *= brightness
          blend((y * width + x) * 4, rgba)
        }
        if (before) copies.push({ before, after: pixels.slice(), width, height })
      },
    }
    canvases.push(canvas); return canvas
  }
  vi.stubGlobal('document', { createElement: make })
  return { make, canvases, copies }
}

afterEach(() => vi.unstubAllGlobals())

describe('full presentation software Canvas pixel semantics', () => {
  it.each(['legacy', 'neutral', 'whole'] as const)('keeps the actual canonical finite domain for %s and replaces transparent alpha instead of doubling it', async (kind) => {
    const fixture = pixelCanvasFixture(), width = 200, height = 160, pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([x * 17 % 256, y * 29 % 256, (x + y) * 11 % 256, x > 130 ? 0 : (x + y) % 3 ? 128 : 255], (y * width + x) * 4)
    const source: Bitmap = { width, height, pixels }, grade = defaultImageLayerColorGrade(); grade.exposure = .25
    const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 40, outputHeight: 30, documentFrame: { version: 1, width: 100, height: 80, offsetX: 20, offsetY: 30 }, explicitLayers: true, background: 'transparent', layers: [{ sourceIndex: 0, x: -.5, y: -1, width: 5, height: 160 / 30, rotation: 0, visible: true, opacity: .3, blend: 'multiply', colorGrade: grade, mask: { kind: 'rectangle', transform: [.75, 0, 0, 1, 0, 0], inverted: false }, adjustments: { brightness: 1.1, contrast: 1, saturation: 1, blur: 0, grayscale: 0 }, edits: { version: 1, operations: [{ mode: 'liquify', version: 1, space: { width, height }, strokes: [{ tool: 'push', radius: 30, strength: .8, points: [[5000, 2500], [4000, 2500]] }] }, ...(kind === 'legacy' ? [] : [{ mode: 'whole-filter' as const, version: 1 as const, filter: { type: 'gaussian' as const, parameters: { radius: kind === 'neutral' ? 0 : 1 } }, space: { width, height } }])] } }] }
    const isolated = { ...recipe, layers: recipe.layers.map((layer) => ({ ...layer, opacity: 1, blend: 'source-over' as const })) }
    const expected = await sampleBrowserImageLayerPixels({ recipe: buildLayerDocumentReplayRecipe(isolated), sources: [{ image: source as unknown as CanvasImageSource, width, height }], source: 'composite' })
    const before = JSON.stringify(recipe), target = fixture.make(); target.width = width; target.height = height
    await paintBrowserImageLayerFullPreview(target.getContext(), { recipe, layerIndex: 0, source: { image: source as unknown as CanvasImageSource, width, height } })
    for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) expect([...target.pixels.subarray((y * width + x) * 4, (y * width + x + 1) * 4)]).toEqual([...expected.data.subarray((y * 100 + x) * 4, (y * 100 + x + 1) * 4)])
    expect(fixture.copies).toHaveLength(1)
    if (kind !== 'whole') expect(fixture.copies[0].before).not.toEqual(fixture.copies[0].after)
    expect(target.pixels.some((value, index) => index % 4 === 3 && value > 0 && value < 255)).toBe(true)
    expect(JSON.stringify(recipe)).toBe(before)
    expect(fixture.canvases.filter((canvas) => canvas !== target).every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })
})
